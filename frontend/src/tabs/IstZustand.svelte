<script>
  // Ist-Zustand Microsoft 365 — das Kunden-PDF «Konfiguration und Ist-Zustand»
  // (Vorlage: SGVP, 18.09.2026), vollständig aus dem Werkzeug:
  //  1. Erheben: rein lesend, als Job, auch im Prüfmandat — Konten, CA, Intune,
  //     E-Mail, Anwendungen, SharePoint, optional die Änderungen eines Zeitraums.
  //  2. Register «Entscheide und Kommentare»: was Entra und Intune nicht speichern —
  //     warum eine Richtlinie so steht, bewusste Entscheide, Begründungen je
  //     Änderung. Dasselbe Register wie das Ausnahme-Register in «Nachweise».
  //  3. Kapitel 9 (Abweichungen) prüfen und einzelne Hinweise abwählen.
  //  4. Kopfdaten eintragen, PDF erzeugen.
  import { apiGet, apiPost, apiDelete, fileDownload, errText } from '../lib/api.js'
  import { activeTenant } from '../lib/tenantStore.js'
  import { session } from '../lib/session.js'
  import { activeTab } from '../lib/tabStore.js'
  import TenantContext from '../lib/TenantContext.svelte'

  let data = $state(null)
  let settings = $state({})
  let register = $state([])
  let objectTypes = $state({})
  let loading = $state(false)
  let error = $state(null)
  let notice = $state(null)
  let job = $state(null)
  let sub = $state('erhebung')
  const busy = $derived(!!job && job.status === 'running')
  const tid = () => encodeURIComponent($activeTenant.id)

  // Erhebungs-Optionen
  // Tage in Ortszeit (nicht UTC): kurz nach Mitternacht wäre sonst noch «gestern».
  const pad2 = n => String(n).padStart(2, '0')
  const localDay = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
  const today = () => localDay(new Date())
  const daysAgo = n => localDay(new Date(Date.now() - n * 864e5))
  let withChanges = $state(true)
  let chFrom = $state(daysAgo(7))
  let chTo = $state(today())
  let spPeriod = $state('D30')

  let loadedFor = null
  $effect(() => {
    const t = $activeTenant
    if ($activeTab !== 'istzustand') return
    if (!$session.loggedIn || !t) return
    if (loadedFor === t.id) return
    loadedFor = t.id
    data = null; job = null; error = null; notice = null; regForm = null
    load()
  })

  async function load() {
    loading = true
    try {
      const r = await apiGet(`/api/tenants/${tid()}/istzustand`)
      data = r.data || null
      settings = { kapitel9: 'haupt', entwurf: true, fassung: '1.0', empfaengerLabel: 'Empfänger', ...(r.settings || {}) }
      if (!settings.kunde) settings.kunde = (data && data.orgName) || $activeTenant.name
      register = r.register || []
      objectTypes = r.objectTypes || {}
      if (data?.params?.changes) { chFrom = data.params.changes.from; chTo = data.params.changes.to }
    } catch (e) { error = errText(e) }
    loading = false
  }

  function poll(jobId, done) {
    setTimeout(async () => {
      let j
      try { j = await apiGet(`/api/appjobs/${encodeURIComponent(jobId)}`) }
      catch (e) { job = { ...(job || {}), status: 'failed', error: errText(e) }; return }
      job = { ...(job || {}), ...j }
      if (j.status === 'running') { poll(jobId, done); return }
      if (done) await done(j)
    }, 1500)
  }

  async function run() {
    error = null; notice = null
    try {
      const body = { spPeriod, ...(withChanges ? { changesFrom: chFrom, changesTo: chTo } : {}) }
      const r = await apiPost(`/api/tenants/${tid()}/istzustand/run`, body)
      job = { id: r.jobId, status: 'running', phase: 'Start' }
      poll(r.jobId, async (j) => {
        await load()
        if (j.status === 'failed') error = j.error || 'Erhebung fehlgeschlagen.'
        else notice = j.hint || 'Erhoben.'
      })
    } catch (e) { error = errText(e) }
  }

  async function saveSettings(silent) {
    try {
      const r = await apiPost(`/api/tenants/${tid()}/istzustand/settings`, settings)
      settings = { ...settings, ...r.settings }
      if (!silent) notice = 'Kopfdaten gespeichert.'
      return true
    } catch (e) { error = errText(e); return false }
  }
  async function pdf() {
    error = null
    if (await saveSettings(true)) fileDownload(`/api/tenants/${tid()}/istzustand/report.pdf`)
  }
  function rawJson() { fileDownload(`/api/tenants/${tid()}/istzustand/export.json`) }

  // ---------------------------------------------------------------- Kapitel 9
  const skip = $derived(new Set(settings.skipHints || []))
  async function toggleHint(id) {
    const s = new Set(settings.skipHints || [])
    if (s.has(id)) s.delete(id); else s.add(id)
    settings = { ...settings, skipHints: [...s] }
    await saveSettings(true)
  }

  // ---------------------------------------------------------------- Register
  let regForm = $state(null)
  let regFilter = $state('')
  const regShown = $derived(register.filter(e => !regFilter || e.objectType === regFilter))
  const objList = $derived(regForm && data?.objects ? (data.objects[regForm.objectType] || []) : [])
  function newReg(type, obj, text) {
    regForm = { objectType: type || 'ca', objectId: obj?.id || '', objectName: obj?.name || '', text: text || '', decision: false, author: '', date: today(), ref: '' }
  }
  function pickObject(id) {
    const o = objList.find(x => x.id === id)
    regForm = { ...regForm, objectId: o ? o.id : '', objectName: o ? o.name : regForm.objectName }
  }
  async function saveReg() {
    error = null
    try {
      const r = await apiPost(`/api/tenants/${tid()}/evidence/register`, regForm)
      register = r.objects || []
      notice = `Eintrag zu «${r.entry.objectName}» gespeichert.`
      regForm = null
      await load()
    } catch (e) { error = errText(e) }
  }
  async function removeReg(e) {
    if (!confirm(`Eintrag zu «${e.objectName}» aus dem Register nehmen?\n\nNur im Werkzeug — am Tenant ändert sich nichts.`)) return
    try { register = (await apiDelete(`/api/tenants/${tid()}/evidence/register/${encodeURIComponent(e.id)}`)).objects || []; await load() } catch (err) { error = errText(err) }
  }

  // ---------------------------------------------------------------- Änderungen: Begründung je Zeile
  let editRow = $state(null)   // { id, objekt, text, entryId }
  function beginRow(r) {
    const own = register.find(e => e.objectType === 'aenderung' && e.objectId === r.id)
    editRow = { id: r.id, objekt: `${r.objekt} (${fmt(r.at)})`, text: own ? own.text : (r.begruendungFrom === 'objekt' ? r.begruendung : ''), entryId: own ? own.id : null }
  }
  async function saveRow() {
    error = null
    try {
      const body = { objectType: 'aenderung', objectId: editRow.id, objectName: editRow.objekt, text: editRow.text, date: today() }
      if (editRow.entryId) body.id = editRow.entryId
      if (!String(editRow.text || '').trim() && editRow.entryId) { await apiDelete(`/api/tenants/${tid()}/evidence/register/${encodeURIComponent(editRow.entryId)}`) }
      else await apiPost(`/api/tenants/${tid()}/evidence/register`, body)
      editRow = null
      await load()
    } catch (e) { error = errText(e) }
  }
  let editGroup = $state(null) // { key, title, text, entryId }
  function beginGroup(g) {
    const own = register.find(e => e.objectType === 'kapitel' && e.objectId === g.key)
    editGroup = { key: g.key, title: g.title, text: own ? own.text : '', entryId: own ? own.id : null }
  }
  async function saveGroup() {
    try {
      if (!String(editGroup.text || '').trim()) { if (editGroup.entryId) await apiDelete(`/api/tenants/${tid()}/evidence/register/${encodeURIComponent(editGroup.entryId)}`) }
      else await apiPost(`/api/tenants/${tid()}/evidence/register`, { ...(editGroup.entryId ? { id: editGroup.entryId } : {}), objectType: 'kapitel', objectId: editGroup.key, objectName: 'Änderungen: ' + editGroup.title, text: editGroup.text, date: today() })
      editGroup = null
      await load()
    } catch (e) { error = errText(e) }
  }

  // ---------------------------------------------------------------- Format
  function fmt(iso) {
    if (!iso) return '—'
    return new Date(iso).toLocaleString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  }
  function fmtD(s) {
    if (!s) return '—'
    const d = new Date(String(s).length === 10 ? s + 'T12:00:00' : s)
    return isNaN(d) ? '—' : d.toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric' })
  }
  const SUBS = [['erhebung', 'Erhebung'], ['register', 'Entscheide und Kommentare'], ['hinweise', 'Abweichungen (Kap. 9)'], ['aenderungen', 'Änderungen'], ['export', 'Kopfdaten und PDF']]
</script>

<TenantContext>
  <div class="iz">
    <p class="ld-section-hint">
      Das Kunden-PDF «Microsoft 365 — Konfiguration und Ist-Zustand»: Konten, Rollen, Lizenzen und Gäste, Anmeldung und bedingter Zugriff,
      Geräte und Intune, E-Mail, Anwendungen und Freigaben, SharePoint, OneDrive und Teams, dazu Abweichungen, Änderungen und Freigabe.
      Erhoben wird rein lesend (auch im Prüfmandat). Was Microsoft nicht speichert — warum etwas so eingestellt ist — kommt aus dem Register
      «Entscheide und Kommentare».
    </p>

    <div class="iz-bar">
      <div class="iz-stamp">
        {#if data}Datenstand {fmt(data.generatedAt)}{data.createdBy ? ` · ${data.createdBy}` : ''} · {data.durationSec} s{:else if loading}Lade…{:else}Noch nicht erhoben.{/if}
      </div>
      <button class="btn btn-primary" disabled={!data || busy} onclick={pdf}>PDF erzeugen</button>
    </div>

    <div class="topic-chips iz-subs">
      {#each SUBS as [k, l]}
        <button class="topic-chip" class:active={sub === k} onclick={() => (sub = k)}>{l}
          {#if k === 'register' && register.length}<span class="iz-n">{register.length}</span>{/if}
          {#if k === 'hinweise' && data?.hints}<span class="iz-n">{data.hints.length - [...skip].filter(id => data.hints.some(h => h.id === id)).length}</span>{/if}
          {#if k === 'aenderungen' && data?.changes}<span class="iz-n">{data.changes.reduce((a, g) => a + g.rows.length, 0)}</span>{/if}
        </button>
      {/each}
    </div>

    {#if error}<div class="alert alert-warning">❌ {error}</div>{/if}
    {#if notice}<div class="ld-banner ok">{notice}</div>{/if}
    {#if job && job.status === 'running'}
      <div class="ld-job iz-job"><span class="ld-spinner"></span><div><strong>Erhebung läuft</strong><div class="ld-job-meta">{job.phase || '…'}</div></div></div>
    {/if}

    <!-- ============================================================ Erhebung -->
    {#if sub === 'erhebung'}
      <div class="settings-group">
        <h4 style="margin:0 0 0.4rem">Erheben</h4>
        <div class="iz-row">
          <label class="iz-opt"><input type="checkbox" bind:checked={withChanges} disabled={busy} /> Änderungen erheben (Kapitel Änderungen)</label>
          {#if withChanges}
            <label class="iz-opt">von <input type="date" bind:value={chFrom} disabled={busy} /></label>
            <label class="iz-opt">bis <input type="date" bind:value={chTo} disabled={busy} /></label>
          {/if}
          <label class="iz-opt" title="Zeitraum des Microsoft-365-Nutzungsberichts für SharePoint und OneDrive">SharePoint-Bericht
            <select bind:value={spPeriod} disabled={busy}><option value="D7">7 Tage</option><option value="D30">30 Tage</option><option value="D90">90 Tage</option></select>
          </label>
          <button class="btn btn-secondary" disabled={busy} onclick={run}>{data ? '↻ Neu erheben' : 'Erheben'}</button>
        </div>
        <p class="iz-dim iz-small">Änderungen: höchstens 92 Tage; Entra ID hält Protokolle 30 Tage, Intune ein Jahr. Die Erhebung dauert je nach Tenant einige Minuten.</p>
      </div>

      {#if data}
        <div class="settings-group">
          <h4 style="margin:0 0 0.4rem">Kapitel</h4>
          <div class="gt-table-wrap">
            <table class="gt-table">
              <thead><tr><th>Kapitel</th><th>Erhoben</th><th class="num">Register</th><th class="num">Lücken</th><th>Von Hand</th></tr></thead>
              <tbody>
                {#each data.status as c (c.key)}
                  <tr>
                    <td>{c.title}</td>
                    <td>{#if c.auto}<span class="tbadge ok">automatisch</span>{:else}<span class="tbadge warn">nicht erhoben</span>{/if}</td>
                    <td class="num">{c.register || '—'}</td>
                    <td class="num">{#if c.gaps}<span class="tbadge warn">{c.gaps}</span>{:else}—{/if}</td>
                    <td class="iz-small iz-dim">{c.needs || '—'}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          <p class="iz-small iz-dim">
            {data.counts.members ?? '—'} Konten, {data.counts.guests ?? '—'} Gäste, {data.counts.ca ?? '—'} CA-Richtlinien, {data.counts.devices ?? '—'} Geräte,
            {data.counts.policies ?? '—'} Intune-Richtlinien, {data.counts.sites ?? '—'} Sites{data.counts.changes !== null ? `, ${data.counts.changes} Protokolleinträge` : ''}.
            Rohdaten: <button class="iz-link" onclick={rawJson}>JSON ({Math.round(data.size / 1024)} KB)</button> · SHA-256 <code class="iz-hash">{data.hash.slice(0, 16)}…</code>
          </p>
        </div>
        {#if data.gaps?.length}
          <div class="alert alert-warning">
            <strong>Nicht vollständig erhoben ({data.gaps.length}):</strong> Diese Teile stehen im PDF in Kapitel 1 und fehlen in den Tabellen.
            <ul class="iz-gaps">{#each data.gaps as g}<li>{g}</li>{/each}</ul>
          </div>
        {/if}
      {/if}
    {/if}

    <!-- ============================================================ Register -->
    {#if sub === 'register'}
      <div class="settings-group">
        <div class="iz-head">
          <div>
            <h4 style="margin:0">Entscheide und Kommentare ({register.length})</h4>
            <p class="ld-section-hint" style="margin:0.2rem 0 0">Der Text erscheint im PDF unter dem Objekt; «bewusster Entscheid» zusätzlich in Kapitel 9. Texte zu Kapiteln stehen am Anfang des Kapitels. Konten pflegt das Ausnahme-Register im Bereich <button class="iz-link" onclick={() => activeTab.set('nachweise')}>Nachweise › Konten</button>.</p>
          </div>
          <button class="btn btn-secondary" onclick={() => newReg()}>+ Eintrag</button>
        </div>
        {#if regForm}
          <div class="iz-form">
            <label>Art
              <select bind:value={regForm.objectType} onchange={() => (regForm = { ...regForm, objectId: '', objectName: '' })}>
                {#each Object.entries(objectTypes) as [k, t]}<option value={k}>{t.label}</option>{/each}
              </select>
            </label>
            <label class="iz-wide">Objekt
              {#if objList.length}
                <select value={regForm.objectId} onchange={(e) => pickObject(e.currentTarget.value)}>
                  <option value="">— auswählen oder unten frei eingeben —</option>
                  {#each objList as o (o.id)}<option value={o.id}>{o.name}{o.detail ? ` · ${o.detail}` : ''}</option>{/each}
                </select>
              {/if}
              <input type="text" bind:value={regForm.objectName} placeholder={regForm.objectType === 'allgemein' ? 'Stichwort, z. B. MacBooks' : 'Name des Objekts'} />
            </label>
            <label class="iz-full">Text <textarea rows="3" bind:value={regForm.text} placeholder="Warum ist es so eingestellt? Was ist der Entscheid, wer hat ihn getroffen?"></textarea></label>
            <label class="iz-opt"><input type="checkbox" bind:checked={regForm.decision} /> bewusster Entscheid (auch in Kapitel 9)</label>
            {#if regForm.objectType === 'allgemein' || regForm.decision}<label>Kapitelverweis <input type="text" bind:value={regForm.ref} placeholder="z. B. 5.5" /></label>{/if}
            <label>Autor <input type="text" bind:value={regForm.author} placeholder="leer = angemeldeter Benutzer" /></label>
            <label>Datum <input type="date" bind:value={regForm.date} /></label>
            <div class="iz-actions"><button class="btn btn-primary" onclick={saveReg}>Speichern</button><button class="btn btn-secondary" onclick={() => (regForm = null)}>Abbrechen</button></div>
          </div>
        {/if}
        <div class="iz-row">
          <label class="iz-opt">Art <select bind:value={regFilter}><option value="">alle</option>{#each Object.entries(objectTypes) as [k, t]}<option value={k}>{t.label}</option>{/each}</select></label>
        </div>
        {#if regShown.length}
          <div class="gt-table-wrap">
            <table class="gt-table">
              <thead><tr><th>Objekt</th><th>Text</th><th>Autor / Datum</th><th></th></tr></thead>
              <tbody>
                {#each regShown as e (e.id)}
                  <tr>
                    <td><div class="iz-dim iz-small">{objectTypes[e.objectType]?.label || e.objectType}</div><strong>{e.objectName}</strong>{#if e.decision}{' '}<span class="tbadge warn">Entscheid</span>{/if}</td>
                    <td class="iz-small">{e.text}</td>
                    <td class="iz-small iz-dim">{e.author || e.createdBy || '—'}<br />{fmtD(e.date)}</td>
                    <td class="iz-actions-cell">
                      <button class="iz-link" onclick={() => (regForm = { ...e })}>bearbeiten</button>
                      <button class="iz-link iz-danger" onclick={() => removeReg(e)}>entfernen</button>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {:else}
          <p class="iz-dim iz-small">Keine Einträge{regFilter ? ' dieser Art' : ''}.</p>
        {/if}
      </div>
    {/if}

    <!-- ============================================================ Hinweise -->
    {#if sub === 'hinweise'}
      <div class="settings-group">
        <h4 style="margin:0 0 0.3rem">Abweichungen und Hinweise (Kapitel 9)</h4>
        <p class="ld-section-hint" style="margin:0 0 0.5rem">Regelbasiert aus der Erhebung, dazu bewusste Entscheide aus dem Register. Abgewählte Hinweise fehlen im PDF. Wo Kapitel 9 steht (Hauptteil, Anhang, weglassen), steht unter «Kopfdaten und PDF».</p>
        {#if !data}<p class="iz-dim">Noch nicht erhoben.</p>
        {:else if !data.hints.length}<p class="iz-dim">Keine Hinweise.</p>
        {:else}
          <div class="gt-table-wrap">
            <table class="gt-table">
              <thead><tr><th style="width:2.2rem">im PDF</th><th>Feststellung</th><th>Quelle</th></tr></thead>
              <tbody>
                {#each data.hints as h (h.id)}
                  <tr class:iz-off={skip.has(h.id)}>
                    <td><input type="checkbox" checked={!skip.has(h.id)} onchange={() => toggleHint(h.id)} aria-label="Hinweis im PDF" /></td>
                    <td class="iz-small">{h.text}</td>
                    <td class="iz-small iz-dim">{h.source === 'register' ? 'Register' : 'Regel'}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </div>
    {/if}

    <!-- ============================================================ Änderungen -->
    {#if sub === 'aenderungen'}
      <div class="settings-group">
        <h4 style="margin:0 0 0.3rem">Änderungen{#if data?.params?.changes}{' '}vom {fmtD(data.params.changes.from)} bis {fmtD(data.params.changes.to)}{/if}</h4>
        <p class="ld-section-hint" style="margin:0 0 0.5rem">Aus den Protokollen von Entra ID und Intune; Anmeldungen und automatische Änderungen durch Microsoft-Dienste sind ausgeblendet. Die Begründung kommt aus dem Register — je Änderung oder, wenn keine erfasst ist, aus dem Kommentar zum Objekt.</p>
        <div class="iz-row">
          <label class="iz-opt">nur Akteur enthält <input type="text" bind:value={settings.aendAkteur} placeholder="z. B. administrator@ oder igeeks" onchange={async () => { await saveSettings(true); await load() }} /></label>
          <label class="iz-opt"><input type="checkbox" bind:checked={settings.aendAlle} onchange={async () => { await saveSettings(true); await load() }} /> auch Änderungen durch Microsoft-Dienste</label>
        </div>
        {#if !data?.changes}
          <p class="iz-dim">Kein Zeitraum erhoben — unter «Erhebung» mit «Änderungen erheben» neu erheben.</p>
        {:else if !data.changes.length}
          <p class="iz-dim">Im Zeitraum keine Änderungen.</p>
        {:else}
          {#each data.changes as g (g.key)}
            <div class="iz-group">
              <div class="iz-head">
                <div><strong>{g.title}</strong> <span class="iz-dim iz-small">· {g.actors.map(a => `${a.actor} (${a.n})`).join(', ')}</span></div>
                <button class="iz-link" onclick={() => beginGroup(g)}>{g.intro ? 'Text zur Gruppe bearbeiten' : '+ Text zur Gruppe'}</button>
              </div>
              {#if g.intro && editGroup?.key !== g.key}<p class="iz-small">{g.intro}</p>{/if}
              {#if editGroup?.key === g.key}
                <div class="iz-form"><label class="iz-full">Text zur Gruppe (z. B. Ziel, Rückfallweg) <textarea rows="3" bind:value={editGroup.text}></textarea></label>
                  <div class="iz-actions"><button class="btn btn-primary" onclick={saveGroup}>Speichern</button><button class="btn btn-secondary" onclick={() => (editGroup = null)}>Abbrechen</button></div></div>
              {/if}
              <div class="gt-table-wrap">
                <table class="gt-table">
                  <thead><tr><th>Objekt</th><th>vorher</th><th>nachher</th><th>Begründung</th></tr></thead>
                  <tbody>
                    {#each g.rows as r, i (r.id || i)}
                      <tr>
                        <td class="iz-small"><strong>{r.objekt}</strong><div class="iz-dim">{fmt(r.at)} · {r.activity}</div></td>
                        <td class="iz-small">{r.vorher}</td>
                        <td class="iz-small">{r.nachher}</td>
                        <td class="iz-small">
                          {#if editRow?.id === r.id && r.id}
                            <textarea rows="3" bind:value={editRow.text}></textarea>
                            <div class="iz-actions"><button class="btn btn-primary btn-sm" onclick={saveRow}>Speichern</button><button class="btn btn-secondary btn-sm" onclick={() => (editRow = null)}>Abbrechen</button></div>
                          {:else}
                            {#if r.begruendung}<span class:iz-dim={r.begruendungFrom === 'objekt'}>{r.begruendung}</span>{#if r.begruendungFrom === 'objekt'}<div class="iz-dim">(Kommentar zum Objekt)</div>{/if}{:else}<span class="iz-dim">—</span>{/if}
                            {#if r.id}<div><button class="iz-link" onclick={() => beginRow(r)}>{r.begruendungFrom === 'aenderung' ? 'bearbeiten' : 'Begründung erfassen'}</button></div>{/if}
                          {/if}
                        </td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            </div>
          {/each}
        {/if}
      </div>
    {/if}

    <!-- ============================================================ Export -->
    {#if sub === 'export'}
      <div class="settings-group">
        <h4 style="margin:0 0 0.4rem">Kopfdaten</h4>
        <div class="iz-form">
          <label class="iz-wide">Kunde <input type="text" bind:value={settings.kunde} /></label>
          <label class="iz-wide">Untertitel <input type="text" bind:value={settings.untertitel} placeholder="z. B. Offerte OF260818 · Projekt 468" /></label>
          <label class="iz-full">Dokument <input type="text" bind:value={settings.dokument} placeholder="Dokumentation des konfigurierten Zustands von Microsoft 365, Intune und Exchange Online" /></label>
          <label>Fassung <input type="text" bind:value={settings.fassung} placeholder="1.0" /></label>
          <label class="iz-opt"><input type="checkbox" bind:checked={settings.entwurf} /> Entwurf</label>
          <label>ersetzt <input type="text" bind:value={settings.ersetzt} placeholder="z. B. 1.1 und 1.0" /></label>
          <label class="iz-wide">Erstellt von <input type="text" bind:value={settings.erstelltVon} placeholder="Name, Funktion, igeeks AG" /></label>
          <label>Anrede
            <select bind:value={settings.empfaengerLabel}><option>Empfänger</option><option>Empfängerin</option><option>Empfänger:in</option></select>
          </label>
          <label>Empfänger <input type="text" bind:value={settings.empfaenger} placeholder="Vorname Name" /></label>
          <label>Funktion <input type="text" bind:value={settings.empfaengerFunktion} placeholder="z. B. COO" /></label>
          <label class="iz-full">Verwendung <input type="text" bind:value={settings.verwendung} placeholder="optional, z. B. Prüfungsdossier" /></label>
          <label class="iz-full">Nicht Gegenstand der Auslesung (je Zeile ein Punkt) <textarea rows="2" bind:value={settings.nichtGegenstand}></textarea></label>
          <label class="iz-full">Weitere Anlagen (je Zeile «B | Inhalt»; Anlage A sind die Rohdaten) <textarea rows="2" bind:value={settings.anlagen}></textarea></label>
          <label>Abweichungen (Kapitel 9)
            <select bind:value={settings.kapitel9}><option value="haupt">im Hauptteil</option><option value="anhang">als Anhang</option><option value="weg">weglassen</option></select>
          </label>
          <div class="iz-actions">
            <button class="btn btn-secondary" onclick={() => saveSettings(false)}>Speichern</button>
            <button class="btn btn-primary" disabled={!data || busy} onclick={pdf}>PDF erzeugen</button>
          </div>
        </div>
        <p class="iz-small iz-dim">Die Kopfdaten bleiben pro Tenant gespeichert. Kapitel 10 (Änderungen) erscheint, wenn ein Zeitraum erhoben wurde; der Freigabeblock nennt «Erstellt von» und den Empfänger.</p>
      </div>
    {/if}
  </div>
</TenantContext>

<style>
  .iz { display: flex; flex-direction: column; gap: 0.8rem; }
  .iz-bar, .iz-row, .iz-head { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
  .iz-head { justify-content: space-between; align-items: flex-start; }
  .iz-stamp { font-size: 0.84rem; color: var(--text-dim); margin-right: auto; }
  .iz-subs { display: flex; flex-wrap: wrap; gap: 0.35rem; }
  .iz-n { display: inline-block; margin-left: 0.3rem; font-size: 0.72rem; font-weight: 700; color: var(--text-dim); }
  .iz-opt { display: inline-flex; align-items: center; gap: 0.35rem; font-size: 0.82rem; color: var(--text-dim); }
  .iz-opt select, .iz-opt input[type="date"], .iz-opt input[type="text"] { padding: 0.2rem 0.3rem; font-size: 0.82rem; }
  .iz-job { display: flex; gap: 0.75rem; align-items: center; }
  .iz-dim { color: var(--text-dim); }
  .iz-small { font-size: 0.8rem; }
  .iz-link { background: none; border: 0; cursor: pointer; padding: 0; font: inherit; font-size: 0.8rem; text-decoration: underline; color: var(--accent); }
  .iz-danger { color: var(--crit); }
  .iz-hash { font-size: 0.75rem; }
  .iz-gaps { margin: 0.4rem 0 0; padding-left: 1.1rem; font-size: 0.8rem; }
  .iz-form { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0.5rem 0.8rem; align-items: end; margin: 0.5rem 0 0.8rem; }
  .iz-form label { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.78rem; color: var(--text-dim); }
  .iz-form label.iz-opt { flex-direction: row; align-items: center; }
  .iz-form input[type="text"], .iz-form select, .iz-form textarea, .iz-form input[type="date"] { font: inherit; font-size: 0.85rem; padding: 0.3rem 0.4rem; }
  .iz-wide { grid-column: span 2; }
  .iz-full { grid-column: 1 / -1; }
  .iz-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
  .iz-form .iz-actions { grid-column: 1 / -1; }
  .iz-actions-cell { white-space: nowrap; }
  .iz-actions-cell .iz-link { margin-right: 0.6rem; }
  .iz-group { border-top: 1px solid var(--rule); padding-top: 0.6rem; margin-top: 0.6rem; }
  .iz-off td { opacity: 0.45; }
  td textarea { width: 100%; font: inherit; font-size: 0.8rem; }
  @media (max-width: 900px) { .iz-form { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
