<script>
  // Nachweise — Belege für Prüfungen und Dokumentationen, rein lesend erhoben.
  //
  // Jede Erhebung läuft als Job und landet mit Zeitstempel und Ersteller im
  // Archiv des Tenants. Das ist zugleich die Sicherung: Microsoft löscht
  // Entra-Protokolle nach 30 Tagen, das Unified Audit Log nach 180 — was hier
  // erhoben ist, bleibt.
  import { apiGet, apiPost, apiDelete, fileDownload, errText } from '../lib/api.js'
  import { activeTenant } from '../lib/tenantStore.js'
  import { session } from '../lib/session.js'
  import { activeTab } from '../lib/tabStore.js'
  import TenantContext from '../lib/TenantContext.svelte'

  const SUBS = [
    ['protokolle', 'Protokolle'], ['konten', 'Konten'], ['empfaenger', 'Benachrichtigungen'],
    ['apps', 'Enterprise-Apps'], ['status', 'Service-Status'], ['archiv', 'Archiv']
  ]
  const KIND_LABEL = { changelog: 'Änderungsprotokoll', ual: 'Audit-Log-Auszug', accounts: 'Konten & Register', dossier: 'Konto-Steckbrief', recipients: 'Empfänger', app: 'Enterprise-App', health: 'Service-Status' }

  let sub = $state('protokolle')
  let archive = $state([])
  let results = $state({})          // kind -> vollständiger Archiveintrag (zuletzt angezeigt)
  let job = $state(null)
  let error = $state(null)
  let notice = $state(null)
  const busy = $derived(!!job && job.status === 'running')
  const tid = () => encodeURIComponent($activeTenant.id)

  let loadedFor = null
  $effect(() => {
    const t = $activeTenant
    if ($activeTab !== 'nachweise') return
    if (!$session.loggedIn || !t) return
    if (loadedFor === t.id) return
    loadedFor = t.id
    results = {}; archive = []; job = null; error = null; notice = null; appList = null; register = []; queries = []
    loadArchive(true); loadRegister(); loadQueries()
  })

  async function loadArchive(openLatest) {
    try {
      archive = (await apiGet(`/api/tenants/${tid()}/evidence/archive`)).entries || []
      if (openLatest) for (const k of Object.keys(KIND_LABEL)) {
        const e = archive.find(x => x.kind === k)
        if (e && k !== 'dossier' && k !== 'ual') openEntry(e.id, false)
      }
    } catch (e) { error = errText(e) }
  }
  async function openEntry(id, switchTab = true) {
    try {
      const r = await apiGet(`/api/tenants/${tid()}/evidence/archive/${encodeURIComponent(id)}`)
      results = { ...results, [r.entry.kind]: r.entry }
      if (switchTab) sub = { changelog: 'protokolle', ual: 'protokolle', accounts: 'konten', dossier: 'konten', recipients: 'empfaenger', app: 'apps', health: 'status' }[r.entry.kind] || sub
    } catch (e) { error = errText(e) }
  }
  function pdf(id) { fileDownload(`/api/tenants/${tid()}/evidence/archive/${encodeURIComponent(id)}/report.pdf`) }
  function csv(id) { fileDownload(`/api/tenants/${tid()}/evidence/archive/${encodeURIComponent(id)}/export.csv`) }
  async function removeEntry(e) {
    if (!confirm(`Nachweis „${e.title}" vom ${fmt(e.createdAt)} aus dem Archiv löschen?\n\nNur im Werkzeug — am Tenant ändert sich nichts. Ist der Zeitraum bei Microsoft schon abgelaufen, lässt er sich nicht neu erheben.`)) return
    try { await apiDelete(`/api/tenants/${tid()}/evidence/archive/${encodeURIComponent(e.id)}`); await loadArchive(false) } catch (err) { error = errText(err) }
  }

  function poll(jobId) {
    setTimeout(async () => {
      let j
      try { j = await apiGet(`/api/appjobs/${encodeURIComponent(jobId)}`) }
      catch (e) { job = { ...(job || {}), status: 'failed', error: errText(e) }; return }
      job = { ...(job || {}), ...j }
      if (j.status === 'running') { poll(jobId); return }
      if (j.status === 'failed') { error = j.error + (j.hint ? ' — ' + j.hint : ''); return }
      if (j.hint) notice = j.hint
      await loadArchive(false)
      if (j.result && j.result.archiveId) await openEntry(j.result.archiveId, false)
      loadQueries()
    }, 1200)
  }
  async function start(path, body) {
    error = null; notice = null
    try {
      const r = await apiPost(`/api/tenants/${tid()}/evidence/${path}`, body || {})
      job = { id: r.jobId, status: 'running', phase: 'Start' }
      poll(r.jobId)
    } catch (e) { error = errText(e) }
  }

  function fmt(iso) {
    if (!iso) return '—'
    return new Date(iso).toLocaleString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  }
  function fmtD(iso) { return iso ? new Date(iso).toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—' }
  const today = () => new Date().toISOString().slice(0, 10)
  const daysAgo = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10)

  // ================================================================ Protokolle
  let clFrom = $state(daysAgo(1))
  let clTo = $state(today())
  let clIntune = $state(true)
  let clEntra = $state(true)
  let clSignIns = $state(false)
  let clNonInter = $state(false)
  let clActor = $state('')
  let clText = $state('')
  let clUser = $state('')
  let clLimit = $state(200)
  const clRetention = $derived.by(() => {
    if (!clFrom) return null
    const gone = new Date(new Date(clFrom + 'T00:00:00').getTime() + 30 * 864e5)
    return { gone, already: gone < new Date() }
  })
  function runChangelog() {
    const sources = [clIntune && 'intune', clEntra && 'entra', clSignIns && 'signins'].filter(Boolean)
    if (!sources.length) { error = 'Mindestens eine Quelle wählen.'; return }
    start('changelog', { from: clFrom, to: clTo, sources, actor: clActor, text: clText, user: clUser, nonInteractive: clNonInter })
  }

  // ---- Unified Audit Log
  let queries = $state([])
  let uFrom = $state(daysAgo(30))
  let uTo = $state(today())
  let uKeyword = $state('')
  let uOps = $state('')
  let uUsers = $state('')
  let uName = $state('')
  async function loadQueries() {
    try { queries = (await apiGet(`/api/tenants/${tid()}/evidence/ual`)).queries || [] } catch (e) { queries = [] }
  }
  async function startUal(extra) {
    error = null; notice = null
    const body = extra || { from: uFrom, to: uTo, keyword: uKeyword, operations: uOps, users: uUsers, name: uName || 'Audit-Log-Suche' }
    try {
      await apiPost(`/api/tenants/${tid()}/evidence/ual`, body)
      notice = 'Suche bei Microsoft angelegt. Das dauert meist einige Minuten — mit «Stand prüfen» nachsehen, das Ergebnis wird dann automatisch archiviert.'
      await loadQueries()
    } catch (e) { error = errText(e) }
  }
  async function refreshQuery(q) {
    error = null
    try {
      const r = await apiPost(`/api/tenants/${tid()}/evidence/ual/${encodeURIComponent(q.id)}/refresh`)
      if (r.jobId) { job = { id: r.jobId, status: 'running', phase: 'Einträge holen' }; poll(r.jobId) }
      await loadQueries()
      if (r.query.archiveId) openEntry(r.query.archiveId)
    } catch (e) { error = errText(e) }
  }
  const UAL_STATUS = { notStarted: 'wartet', running: 'läuft', succeeded: 'fertig', failed: 'fehlgeschlagen', cancelled: 'abgebrochen' }

  // ================================================================ Konten
  let register = $state([])
  let kinds = $state({})
  let regForm = $state(null)
  let dossierUpn = $state('')
  async function loadRegister() {
    try { const r = await apiGet(`/api/tenants/${tid()}/evidence/register`); register = r.entries || []; kinds = r.kinds || {} } catch (e) { register = [] }
  }
  function newEntry(upn, kind) {
    regForm = { upn: upn || '', kind: kind || 'test', purpose: '', owner: '', ticket: '', validFrom: today(), validUntil: '', notes: '' }
  }
  async function saveEntry() {
    error = null
    try {
      const r = await apiPost(`/api/tenants/${tid()}/evidence/register`, regForm)
      register = r.entries || []
      notice = `${r.entry.upn} im Register gespeichert.`
      regForm = null
    } catch (e) { error = errText(e) }
  }
  async function removeReg(e) {
    if (!confirm(`${e.upn} aus dem Register nehmen?\n\nNur der Registereintrag — das Konto im Tenant bleibt unverändert.`)) return
    try { register = (await apiDelete(`/api/tenants/${tid()}/evidence/register/${encodeURIComponent(e.id)}`)).entries || [] } catch (err) { error = errText(err) }
  }
  const TONE = { ok: 'ok', warn: 'warn', crit: 'crit' }

  // ================================================================ Empfänger
  let watch = $state('administrator@, support@, compliance@')

  // ================================================================ Enterprise-Apps
  let appList = $state(null)
  let appFilter = $state('')
  let appBusy = $state(false)
  async function loadApps() {
    appBusy = true; error = null
    try { appList = await apiGet(`/api/tenants/${tid()}/evidence/apps`) } catch (e) { error = errText(e) }
    appBusy = false
  }
  const appsShown = $derived((appList?.apps || []).filter(a => !appFilter.trim() || (a.name + ' ' + a.publisher).toLowerCase().includes(appFilter.trim().toLowerCase())))
  function appUal(a) {
    startUal({
      from: daysAgo(179), to: today(), keyword: a.appId, appId: a.appId,
      name: `App-Nachweis ${a.name} (Unified Audit Log)`
    })
  }

  // ================================================================ Service-Status
  let hDays = $state(7)
  let hService = $state('')

  const cur = kind => results[kind] || null
</script>

<TenantContext>
  <div class="nw">
    <p class="ld-section-hint">
      Belege für Prüfungen und Dokumentationen — rein lesend erhoben, mit Zeitstempel und Ersteller archiviert.
      Das Archiv ist zugleich die Sicherung: Microsoft löscht Entra-Protokolle nach 30 Tagen, das Unified Audit Log nach 180.
    </p>

    <div class="dl-subtabs">
      {#each SUBS as [k, l]}
        <button type="button" class="dl-subtab" class:active={sub === k} onclick={() => (sub = k)}>{l}</button>
      {/each}
    </div>

    {#if error}<div class="alert alert-warning">❌ {error}</div>{/if}
    {#if notice}<div class="ld-banner ok">{notice}</div>{/if}
    {#if job && job.status === 'running'}
      <div class="ld-job nw-job"><span class="ld-spinner"></span><div><strong>Erhebung läuft</strong><div class="ld-job-meta">{job.phase || '…'}</div></div></div>
    {/if}

    <!-- ================================================================ PROTOKOLLE -->
    {#if sub === 'protokolle'}
      <div class="settings-group">
        <h4>Änderungsprotokoll</h4>
        <p class="ld-section-hint" style="margin-top:0">Wer hat wann was verändert — Intune und Entra ID, optional mit Anmeldungen. Tage in Schweizer Zeit.</p>
        <div class="nw-form">
          <label>von <input type="date" bind:value={clFrom} /></label>
          <label>bis <input type="date" bind:value={clTo} /></label>
          <label class="nw-check"><input type="checkbox" bind:checked={clIntune} /> Intune</label>
          <label class="nw-check"><input type="checkbox" bind:checked={clEntra} /> Entra ID</label>
          <label class="nw-check"><input type="checkbox" bind:checked={clSignIns} /> Anmeldungen</label>
          {#if clSignIns}<label class="nw-check"><input type="checkbox" bind:checked={clNonInter} /> auch nicht interaktive</label>{/if}
        </div>
        <div class="nw-form">
          <label>Akteur enthält <input type="text" bind:value={clActor} placeholder="z. B. Patch My PC, nils@" /></label>
          <label>Vorgang/Objekt enthält <input type="text" bind:value={clText} placeholder="z. B. Chrome, Role" /></label>
          {#if clSignIns}<label>Konto beginnt mit <input type="text" bind:value={clUser} placeholder="z. B. nils.testuser" /></label>{/if}
          <button class="btn btn-primary" disabled={busy} onclick={runChangelog}>Erheben und sichern</button>
        </div>
        {#if clRetention && clEntra}
          <div class="nw-hint" class:warn={clRetention.already}>
            {#if clRetention.already}
              Entra hat Einträge vom {fmtD(clFrom)} bereits gelöscht (30 Tage) — für diesen Tag bleibt nur das Unified Audit Log (unten, bis 180 Tage).
            {:else}
              Entra-Einträge vom {fmtD(clFrom)} löscht Microsoft um den {fmtD(clRetention.gone)} — jetzt erheben heisst: gesichert.
            {/if}
          </div>
        {/if}

        {#if cur('changelog')}
          {@const e = cur('changelog')}
          {@const d = e.data}
          <div class="nw-result">
            <div class="nw-result-head">
              <div><strong>{e.title}</strong><div class="nw-dim nw-small">erhoben {fmt(e.createdAt)} · {e.createdBy}</div></div>
              <div class="nw-actions"><button class="btn btn-secondary" onclick={() => pdf(e.id)}>PDF</button><button class="btn btn-secondary" onclick={() => csv(e.id)}>CSV</button></div>
            </div>
            <div class="nw-chips">
              <span class="tbadge">{d.summary.intune} Intune</span><span class="tbadge">{d.summary.entra} Entra</span>
              {#if d.summary.signIns !== null}<span class="tbadge">{d.summary.signIns} Anmeldungen</span>{/if}
              {#each d.summary.byActor.slice(0, 6) as a}<span class="gt-tag">{a.key} · {a.n}</span>{/each}
            </div>
            {#each d.gaps as g}<div class="nw-line warn">{g}</div>{/each}
            {#if d.events.length}
              <div class="gt-table-wrap">
                <table class="gt-table">
                  <thead><tr><th>Zeit</th><th>Quelle</th><th>Akteur</th><th>Vorgang</th><th>Objekt und Änderung</th></tr></thead>
                  <tbody>
                    {#each d.events.slice(0, clLimit) as ev}
                      <tr>
                        <td class="nw-small">{fmt(ev.at)}</td>
                        <td class="nw-small">{ev.source}</td>
                        <td class="nw-small"><strong>{ev.actor}</strong>{#if ev.actorType}<div class="nw-dim">{ev.actorType}</div>{/if}</td>
                        <td class="nw-small">{ev.activity}{#if ev.result && !/^success/i.test(ev.result)}<div class="nw-dim">{ev.result}</div>{/if}</td>
                        <td class="nw-small">
                          {#each ev.targets as t}
                            <div>{t.name}{t.type ? ` [${t.type}]` : ''}</div>
                            {#each t.changes.slice(0, 5) as c}<div class="nw-dim nw-change">{c.name}: {c.old || '—'} › {c.new || '—'}</div>{/each}
                          {/each}
                        </td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
              {#if d.events.length > clLimit}<button class="nw-link" onclick={() => (clLimit += 500)}>weitere anzeigen ({d.events.length - clLimit} offen)</button>{/if}
            {:else}
              <p class="ld-section-hint">Keine passenden Ereignisse im Zeitraum.</p>
            {/if}
            {#if d.signIns && d.signIns.length}
              <h5 class="nw-h5">Anmeldungen ({d.signIns.length})</h5>
              <div class="gt-table-wrap">
                <table class="gt-table">
                  <thead><tr><th>Zeit</th><th>Konto</th><th>App</th><th>Gerät / Ort</th><th>Ergebnis</th></tr></thead>
                  <tbody>
                    {#each d.signIns.slice(0, 200) as s}
                      <tr><td class="nw-small">{fmt(s.at)}</td><td class="nw-small">{s.user}</td><td class="nw-small">{s.app}{s.nonInteractive ? ' (nicht interaktiv)' : ''}</td>
                        <td class="nw-small">{[s.device, s.location, s.ip].filter(Boolean).join(' · ')}</td><td class="nw-small">{s.result}{s.ca ? ' · CA ' + s.ca : ''}</td></tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            {/if}
          </div>
        {/if}
      </div>

      <div class="settings-group">
        <h4>Unified Audit Log (bis 180 Tage)</h4>
        <p class="ld-section-hint" style="margin-top:0">
          Alles, was Exchange, SharePoint, Teams und Entra protokollieren — auch über 30 Tage hinaus. Microsoft sucht asynchron;
          die Suche läuft bei Microsoft weiter, «Stand prüfen» holt das Ergebnis und archiviert es. Braucht AuditLogsQuery.Read.All (einmal Reparieren).
        </p>
        <div class="nw-form">
          <label>von <input type="date" bind:value={uFrom} /></label>
          <label>bis <input type="date" bind:value={uTo} /></label>
          <label>Stichwort <input type="text" bind:value={uKeyword} placeholder="z. B. App-Id, Betreff" /></label>
          <label>Vorgänge <input type="text" bind:value={uOps} placeholder="z. B. HardDelete, Add user." /></label>
          <label>Konten <input type="text" bind:value={uUsers} placeholder="UPN, mehrere mit Komma" /></label>
          <label>Name <input type="text" bind:value={uName} placeholder="wofür die Suche ist" /></label>
          <button class="btn btn-primary" onclick={() => startUal()}>Suche starten</button>
        </div>
        {#if queries.length}
          <div class="gt-table-wrap">
            <table class="gt-table">
              <thead><tr><th>Suche</th><th>Zeitraum</th><th>Angelegt</th><th>Stand</th><th></th></tr></thead>
              <tbody>
                {#each queries as q (q.id)}
                  <tr>
                    <td><strong>{q.name}</strong>{#if q.keyword}<div class="nw-dim nw-small">Stichwort: {q.keyword}</div>{/if}</td>
                    <td class="nw-small">{fmtD(q.from)} – {fmtD(q.to)}</td>
                    <td class="nw-small">{fmt(q.createdAt)}</td>
                    <td><span class="tbadge" class:ok={q.archiveId} class:warn={!q.archiveId && q.status !== 'failed'} class:crit={q.status === 'failed'}>{q.archiveId ? 'archiviert' : UAL_STATUS[q.status] || q.status}</span></td>
                    <td>
                      {#if q.archiveId}
                        <button class="btn btn-secondary nw-sm" onclick={() => openEntry(q.archiveId)}>anzeigen</button>
                      {:else}
                        <button class="btn btn-secondary nw-sm" disabled={busy} onclick={() => refreshQuery(q)}>Stand prüfen</button>
                      {/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
        {#if cur('ual')}
          {@const e = cur('ual')}
          {@const d = e.data}
          <div class="nw-result">
            <div class="nw-result-head">
              <div><strong>{e.title}</strong><div class="nw-dim nw-small">archiviert {fmt(e.createdAt)}</div></div>
              <div class="nw-actions"><button class="btn btn-secondary" onclick={() => pdf(e.id)}>PDF</button><button class="btn btn-secondary" onclick={() => csv(e.id)}>CSV</button></div>
            </div>
            <div class="nw-chips">
              <span class="tbadge">{d.summary.records} Einträge</span>
              <span class="tbadge warn">{d.summary.changing} ändernd</span>
              <span class="tbadge" class:crit={d.summary.deleting} class:ok={!d.summary.deleting}>{d.summary.deleting} löschend</span>
              <span class="tbadge" class:crit={d.summary.moving} class:ok={!d.summary.moving}>{d.summary.moving || 0} verschiebend</span>
              {#if d.otherAppRecords}<span class="nw-dim nw-small">{d.otherAppRecords} Treffer anderer Apps ausgeblendet</span>{/if}
            </div>
            <div class="gt-table-wrap">
              <table class="gt-table">
                <thead><tr><th>Vorgang</th><th>Anzahl</th><th>Art</th><th>Konten</th></tr></thead>
                <tbody>
                  {#each d.operations as o}
                    <tr class:ac-issue={o.deleting || o.moving}>
                      <td><strong>{o.operation}</strong></td><td>{o.n}</td>
                      <td><span class="tbadge" class:crit={o.deleting || o.moving} class:warn={!o.deleting && !o.moving && o.changing}>{o.deleting ? 'löschend' : o.moving ? 'verschiebend' : o.changing ? 'ändernd' : 'lesend'}</span></td>
                      <td class="nw-small">{o.users.slice(0, 6).join(', ')}{o.users.length > 6 ? ' …' : ''}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          </div>
        {/if}
      </div>
    {/if}

    <!-- ================================================================ KONTEN -->
    {#if sub === 'konten'}
      <div class="settings-group">
        <div class="nw-result-head">
          <div>
            <h4 style="margin:0">Privilegierte Konten und Ausnahme-Register</h4>
            <p class="ld-section-hint" style="margin:0.2rem 0 0">Rollen dauerhaft, per PIM aktiviert, berechtigt oder über Gruppen — mit MFA und letzter Anmeldung. Das Register wird dabei gegen den Tenant geprüft.</p>
          </div>
          <button class="btn btn-primary" disabled={busy} onclick={() => start('accounts')}>Erheben und sichern</button>
        </div>
        {#if cur('accounts')}
          {@const e = cur('accounts')}
          {@const p = e.data.privileged}
          {@const r = e.data.register}
          <div class="nw-result">
            <div class="nw-result-head">
              <div class="nw-dim nw-small">erhoben {fmt(e.createdAt)} · {e.createdBy}</div>
              <div class="nw-actions"><button class="btn btn-secondary" onclick={() => pdf(e.id)}>PDF</button><button class="btn btn-secondary" onclick={() => csv(e.id)}>CSV</button></div>
            </div>
            <div class="rep-metrics">
              <div class="rep-metric"><div class="rep-metric-value">{p.summary.accounts}</div><div class="rep-metric-label">Konten mit Rolle</div></div>
              <div class="rep-metric" class:warn={p.summary.globalAdmins > 4}><div class="rep-metric-value">{p.summary.globalAdmins}</div><div class="rep-metric-label">Globale Admins</div></div>
              <div class="rep-metric" class:crit={p.summary.withoutMfa}><div class="rep-metric-value">{p.summary.withoutMfa}</div><div class="rep-metric-label">privilegiert ohne MFA</div></div>
              <div class="rep-metric"><div class="rep-metric-value">{p.summary.createdLast30}</div><div class="rep-metric-label">neu in 30 Tagen</div></div>
              <div class="rep-metric" class:crit={r.summary.critical}><div class="rep-metric-value">{r.summary.critical}</div><div class="rep-metric-label">Register kritisch</div></div>
            </div>
            {#each e.data.gaps || [] as g}<div class="nw-line warn">{g}</div>{/each}
            <div class="gt-table-wrap">
              <table class="gt-table">
                <thead><tr><th>Konto</th><th>Rollen</th><th>Angelegt</th><th>Letzte Anmeldung</th><th>MFA</th></tr></thead>
                <tbody>
                  {#each p.accounts as a (a.upn)}
                    <tr class:ac-issue={a.privileged && a.mfaRegistered === false}>
                      <td><strong>{a.name}</strong><div class="nw-dim nw-small">{a.upn}{a.enabled === false ? ' · deaktiviert' : ''}</div></td>
                      <td class="nw-small">{#each a.roles as ro}<div>{ro.name} <span class="nw-dim">— {ro.how}{ro.end ? ', bis ' + fmtD(ro.end) : ''}</span></div>{/each}</td>
                      <td class="nw-small">{fmtD(a.created)}</td>
                      <td class="nw-small">{a.signInKnown ? fmt(a.lastSignIn) : '—'}</td>
                      <td class="nw-small">{#if a.mfaRegistered === null}—{:else if a.mfaRegistered}{(a.methods || []).join(', ') || 'registriert'}{:else}<span class="tbadge crit">keine Methode</span>{/if}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
            {#if p.apps.length}<p class="nw-small nw-dim">Anwendungen mit Admin-Rollen: {p.apps.map(a => `${a.name} (${a.roles.map(x => x.name).join(', ')})`).join(' · ')}</p>{/if}
            {#if r.suggestions.length}
              <h5 class="nw-h5">Sonderkonten ohne Registereintrag ({r.suggestions.length})</h5>
              <div class="nw-sugg">
                {#each r.suggestions.slice(0, 60) as s}
                  <div class="nw-sugg-row">
                    <span><strong>{s.upn}</strong> <span class="nw-dim nw-small">{s.reasons.join('; ')}</span></span>
                    <button class="nw-link" onclick={() => newEntry(s.upn, /Globaler|Administrator/.test(s.reasons.join(' ')) ? 'admin' : 'test')}>ins Register</button>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      </div>

      <div class="settings-group">
        <div class="nw-result-head">
          <div>
            <h4 style="margin:0">Ausnahme-Register ({register.length})</h4>
            <p class="ld-section-hint" style="margin:0.2rem 0 0">Zweck, Verantwortung und Ablaufdatum von Test-, Admin-, Dienst- und Notfallkonten — das speichert Entra ID nicht. Nur im Werkzeug, am Tenant ändert sich nichts. Entscheide und Kommentare zu Richtlinien, Gruppen, Sites und Änderungen stehen im selben Register und werden im Bereich <button class="nw-link" onclick={() => activeTab.set('istzustand')}>Ist-Zustand (Doku)</button> gepflegt.</p>
          </div>
          <button class="btn btn-secondary" onclick={() => newEntry()}>+ Eintrag</button>
        </div>
        {#if regForm}
          <div class="nw-regform">
            <label>UPN <input type="text" bind:value={regForm.upn} placeholder="nils.testuser@kunde.ch" /></label>
            <label>Art <select bind:value={regForm.kind}>{#each Object.entries(kinds) as [k, l]}<option value={k}>{l}</option>{/each}</select></label>
            <label class="nw-wide">Zweck <input type="text" bind:value={regForm.purpose} placeholder="wozu das Konto existiert" /></label>
            <label>Verantwortlich <input type="text" bind:value={regForm.owner} /></label>
            <label>Ticket <input type="text" bind:value={regForm.ticket} placeholder="RE-…" /></label>
            <label>gültig ab <input type="date" bind:value={regForm.validFrom} /></label>
            <label>gültig bis <input type="date" bind:value={regForm.validUntil} /></label>
            <label class="nw-wide">Notizen <input type="text" bind:value={regForm.notes} /></label>
            <div class="nw-actions"><button class="btn btn-primary" onclick={saveEntry}>Speichern</button><button class="btn btn-secondary" onclick={() => (regForm = null)}>Abbrechen</button></div>
          </div>
        {/if}
        {#if register.length}
          {@const checked = cur('accounts') ? cur('accounts').data.register.entries : []}
          <div class="gt-table-wrap">
            <table class="gt-table">
              <thead><tr><th>Konto</th><th>Art / Zweck</th><th>Verantwortlich</th><th>Gültig bis</th><th>Stand</th><th></th></tr></thead>
              <tbody>
                {#each register as r (r.id)}
                  {@const c = checked.find(x => x.id === r.id)}
                  <tr class:ac-issue={c && c.tone === 'crit'}>
                    <td><strong>{r.upn}</strong>{#if r.ticket}<div class="nw-dim nw-small">{r.ticket}</div>{/if}</td>
                    <td class="nw-small">{r.kindLabel}: {r.purpose}</td>
                    <td class="nw-small">{r.owner || '—'}</td>
                    <td class="nw-small">{r.validUntil ? fmtD(r.validUntil + 'T12:00:00') : '—'}</td>
                    <td>{#if c}<span class="tbadge {TONE[c.tone]}">{c.state}</span>{:else}<span class="nw-dim nw-small">noch nicht geprüft</span>{/if}</td>
                    <td class="nw-row-actions">
                      <button class="nw-link" onclick={() => (regForm = { ...r })}>bearbeiten</button>
                      <button class="nw-link" onclick={() => { dossierUpn = r.upn; start('dossier', { upn: r.upn }) }}>Steckbrief</button>
                      <button class="nw-link nw-danger" onclick={() => removeReg(r)}>entfernen</button>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </div>

      <div class="settings-group">
        <h4>Konto-Steckbrief</h4>
        <p class="ld-section-hint" style="margin-top:0">Alles zu einem Konto: seit wann, von wem angelegt, Rollen, Gruppen, Lizenzen, Anmeldemethoden, letzte Anmeldungen, Protokoll — und der Registereintrag.</p>
        <div class="nw-form">
          <label>UPN <input type="text" bind:value={dossierUpn} placeholder="nils.testuser@kunde.ch" /></label>
          <button class="btn btn-primary" disabled={busy || !dossierUpn.trim()} onclick={() => start('dossier', { upn: dossierUpn.trim() })}>Steckbrief erheben</button>
        </div>
        {#if cur('dossier')}
          {@const e = cur('dossier')}
          {@const d = e.data}
          <div class="nw-result">
            <div class="nw-result-head">
              <div><strong>{d.user.name}</strong> <span class="nw-dim">{d.user.upn}</span><div class="nw-dim nw-small">erhoben {fmt(e.createdAt)}</div></div>
              <div class="nw-actions"><button class="btn btn-secondary" onclick={() => pdf(e.id)}>PDF</button><button class="btn btn-secondary" onclick={() => csv(e.id)}>CSV</button></div>
            </div>
            <div class="nw-kv"><span>Status</span><span>{d.user.enabled ? 'aktiv' : 'deaktiviert'} · {d.user.userType}{d.user.synced ? ' · aus dem AD' : ''}</span></div>
            <div class="nw-kv"><span>Angelegt</span><span>{fmt(d.user.created)}{d.user.createdAgeDays !== null ? ` (vor ${d.user.createdAgeDays} Tagen)` : ''}</span></div>
            <div class="nw-kv"><span>Angelegt von</span><span>{d.createdBy || d.createdByNote}</span></div>
            <div class="nw-kv"><span>Letzte Anmeldung</span><span>{d.user.signInKnown ? fmt(d.user.lastSignIn) : 'nicht lesbar'}</span></div>
            <div class="nw-kv"><span>Zweck / Ablauf</span><span>{#if d.register}{d.register.kindLabel}: {d.register.purpose} · {d.register.validUntil ? 'bis ' + fmtD(d.register.validUntil + 'T12:00:00') : 'ohne Ablaufdatum'} · {d.register.owner || 'ohne Verantwortliche'}{:else}<span class="tbadge warn">nicht im Register</span> <button class="nw-link" onclick={() => newEntry(d.user.upn)}>erfassen</button>{/if}</span></div>
            <div class="nw-kv"><span>Rollen</span><span>{d.roles.map(r => `${r.name} (${r.how})`).join(' · ') || 'keine'}</span></div>
            <div class="nw-kv"><span>Anmeldemethoden</span><span>{d.methods.map(m => m.type).join(', ') || 'keine'}</span></div>
            <div class="nw-kv"><span>Lizenzen</span><span>{d.licenses.join(', ') || 'keine'}</span></div>
            <div class="nw-kv"><span>Gruppen</span><span>{d.groups.map(g => g.name).join(', ') || 'keine'}</span></div>
            {#each d.gaps as g}<div class="nw-line warn">{g}</div>{/each}
          </div>
        {/if}
      </div>
    {/if}

    <!-- ================================================================ EMPFÄNGER -->
    {#if sub === 'empfaenger'}
      <div class="settings-group">
        <h4>Benachrichtigungsempfänger</h4>
        <p class="ld-section-hint" style="margin-top:0">
          Welche Meldungen an welche Adresse gehen: Tenant-Kontakte, Exchange (Spam, Malware, Meldepostfach, Transportregeln)
          und Security & Compliance (Warnungsrichtlinien, DLP). Beobachtete Adressen werden eigens ausgewiesen.
        </p>
        <div class="nw-form">
          <label class="nw-wide">Beobachten <input type="text" bind:value={watch} placeholder="administrator@, support@, compliance@" /></label>
          <button class="btn btn-primary" disabled={busy} onclick={() => start('recipients', { watch })}>Erheben und sichern</button>
        </div>
        {#if cur('recipients')}
          {@const e = cur('recipients')}
          {@const d = e.data}
          <div class="nw-result">
            <div class="nw-result-head">
              <div class="nw-dim nw-small">erhoben {fmt(e.createdAt)} · {e.createdBy}</div>
              <div class="nw-actions"><button class="btn btn-secondary" onclick={() => pdf(e.id)}>PDF</button><button class="btn btn-secondary" onclick={() => csv(e.id)}>CSV</button></div>
            </div>
            {#each d.gaps as g}<div class="nw-line warn">{g}</div>{/each}
            {#each d.watch as w}
              <div class="nw-watch">
                <strong>{w.watch}</strong>
                {#if w.hits.length}
                  <span class="tbadge warn">{w.hits.reduce((n, h) => n + h.entries.length, 0)} Meldungswege</span>
                  {#each w.hits as h}
                    <div class="nw-small"><strong>{h.address}</strong>: {h.entries.map(x => `${x.area} › ${x.object}: ${x.trigger}${x.enabled ? '' : ' (aus)'}`).join(' · ')}</div>
                  {/each}
                {:else}
                  <span class="tbadge ok">nirgends eingetragen</span>
                {/if}
              </div>
            {/each}
            <h5 class="nw-h5">Alle Adressen ({d.addresses.length})</h5>
            <div class="gt-table-wrap">
              <table class="gt-table">
                <thead><tr><th>Adresse</th><th>Meldungen</th></tr></thead>
                <tbody>
                  {#each d.addresses as a}
                    <tr><td><strong>{a.address}</strong></td><td class="nw-small">{#each a.entries as x}<div>{x.area} › {x.object}: {x.trigger}{x.enabled ? '' : ' (aus)'}</div>{/each}</td></tr>
                  {/each}
                </tbody>
              </table>
            </div>
            <h5 class="nw-h5">Von Hand prüfen (nicht per Schnittstelle lesbar)</h5>
            <ul class="nw-list">{#each d.manual as m}<li><strong>{m.area}:</strong> {m.what}</li>{/each}</ul>
          </div>
        {/if}
      </div>
    {/if}

    <!-- ================================================================ ENTERPRISE-APPS -->
    {#if sub === 'apps'}
      <div class="settings-group">
        <div class="nw-result-head">
          <div>
            <h4 style="margin:0">Enterprise-Apps (Drittanbieter)</h4>
            <p class="ld-section-hint" style="margin:0.2rem 0 0">KI-Anwendungen zuerst. Rechte, Zustimmungen, Zuweisung und Nutzung — und über das Unified Audit Log, was die App getan hat.</p>
          </div>
          <button class="btn btn-secondary" disabled={appBusy} onclick={loadApps}>{appBusy ? 'Lade…' : appList ? '↻ Neu laden' : 'Apps laden'}</button>
        </div>
        {#if appList}
          <input class="nw-search" type="search" placeholder="App oder Herausgeber suchen…" bind:value={appFilter} />
          <div class="gt-table-wrap">
            <table class="gt-table">
              <thead><tr><th>App</th><th>Delegierte Rechte</th><th>Zustimmung</th><th></th></tr></thead>
              <tbody>
                {#each appsShown as a (a.id)}
                  <tr class:ac-issue={a.ai && a.risky.length}>
                    <td>
                      <strong>{a.name}</strong> {#if a.ai}<span class="tbadge warn">KI</span>{/if}
                      <div class="nw-dim nw-small">{a.publisher}{a.verifiedName ? ' · verifiziert' : ''} · seit {fmtD(a.created)}{a.assignmentRequired ? '' : ' · alle Konten dürfen'}</div>
                    </td>
                    <td class="nw-small">{#each a.scopes as s}<span class:nw-risky={a.risky.includes(s)}>{s}</span>{' '}{/each}</td>
                    <td class="nw-small">{a.adminConsent ? 'Administrator (alle)' : ''}{a.userConsents ? `${a.adminConsent ? ' · ' : ''}${a.userConsents} Benutzer` : ''}{!a.adminConsent && !a.userConsents ? '—' : ''}</td>
                    <td class="nw-row-actions">
                      <button class="btn btn-secondary nw-sm" disabled={busy} onclick={() => start('app', { spId: a.id, name: a.name, days: 30 })}>Nachweis</button>
                      <button class="nw-link" onclick={() => appUal(a)}>Audit Log 180 Tage</button>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
        {#if cur('app')}
          {@const e = cur('app')}
          {@const d = e.data}
          <div class="nw-result">
            <div class="nw-result-head">
              <div><strong>{d.app.name}</strong> <span class="nw-dim">{d.app.publisher}{d.app.verified ? ' · verifiziert: ' + d.app.verified : ''}</span><div class="nw-dim nw-small">erhoben {fmt(e.createdAt)}</div></div>
              <div class="nw-actions"><button class="btn btn-secondary" onclick={() => pdf(e.id)}>PDF</button><button class="btn btn-secondary" onclick={() => csv(e.id)}>CSV</button></div>
            </div>
            <div class="nw-kv"><span>Im Tenant seit</span><span>{fmt(d.app.created)} · {d.app.assignmentRequired ? 'nur zugewiesene Konten' : 'alle Konten dürfen'}</span></div>
            <div class="nw-kv"><span>Delegierte Rechte</span><span>{#each d.delegated as g}<div>{g.resource}: {#each g.scopes as s}<span class:nw-risky={g.risky.includes(s)}>{s}</span>{' '}{/each}<span class="nw-dim">— {g.consent}: {g.who}</span></div>{:else}keine{/each}</span></div>
            <div class="nw-kv"><span>Anwendungsrechte</span><span>{d.application.map(x => `${x.resource}: ${x.permission}`).join(' · ') || 'keine'}</span></div>
            <div class="nw-kv"><span>Zugewiesen</span><span>{d.assigned.map(x => x.name).join(', ') || '—'}</span></div>
            <div class="nw-kv"><span>Nutzung {d.signIns.days} Tage</span><span>{d.signIns.users.map(u => `${u.user} (${u.interactive + u.nonInteractive})`).join(', ') || 'keine Anmeldung'}</span></div>
            <div class="nw-kv"><span>Entra-Protokoll</span><span>{#each d.audit.slice(0, 8) as x}<div>{fmt(x.at)} · {x.activity} · {x.by}</div>{:else}—{/each}</span></div>
            <div class="nw-line">{d.vendorNote}</div>
            {#each d.gaps as g}<div class="nw-line warn">{g}</div>{/each}
          </div>
        {/if}
      </div>
    {/if}

    <!-- ================================================================ SERVICE-STATUS -->
    {#if sub === 'status'}
      <div class="settings-group">
        <h4>Service-Status (Microsoft 365)</h4>
        <p class="ld-section-hint" style="margin-top:0">Störungen und Hinweise aus dem Microsoft-365-Service-Health. Power Platform (Dataverse) meldet zusätzlich im eigenen Admin Center.</p>
        <div class="nw-form">
          <label>Zeitraum <select bind:value={hDays}><option value={1}>1 Tag</option><option value={7}>7 Tage</option><option value={30}>30 Tage</option><option value={90}>90 Tage</option></select></label>
          <label>Dienst/Text <input type="text" bind:value={hService} placeholder="z. B. Dataverse, Exchange" /></label>
          <button class="btn btn-primary" disabled={busy} onclick={() => start('health', { days: hDays, service: hService })}>Erheben und sichern</button>
        </div>
        {#if cur('health')}
          {@const e = cur('health')}
          {@const d = e.data}
          <div class="nw-result">
            <div class="nw-result-head">
              <div class="nw-dim nw-small">erhoben {fmt(e.createdAt)}</div>
              <div class="nw-actions"><button class="btn btn-secondary" onclick={() => pdf(e.id)}>PDF</button><button class="btn btn-secondary" onclick={() => csv(e.id)}>CSV</button></div>
            </div>
            {#each d.gaps as g}<div class="nw-line warn">{g}</div>{/each}
            {#if d.overview.some(o => o.status !== 'serviceOperational')}
              <div class="nw-chips">{#each d.overview.filter(o => o.status !== 'serviceOperational') as o}<span class="tbadge warn">{o.service}: {o.status}</span>{/each}</div>
            {/if}
            {#each d.issues as i (i.id)}
              <details class="nw-issue">
                <summary><span class="tbadge" class:ok={i.resolved} class:warn={!i.resolved}>{i.resolved ? 'behoben' : 'offen'}</span> <strong>{i.id}</strong> · {i.title} <span class="nw-dim nw-small">{i.service} · {fmt(i.start)}{i.end ? ' – ' + fmt(i.end) : ''}</span></summary>
                <div class="nw-small">{i.impact}</div>
                {#if i.latest}<pre class="nw-post">{i.latest}</pre>{/if}
              </details>
            {:else}
              <p class="ld-section-hint">Keine Störungen oder Hinweise im Zeitraum.</p>
            {/each}
            <p class="nw-dim nw-small">{d.note}</p>
          </div>
        {/if}
      </div>
    {/if}

    <!-- ================================================================ ARCHIV -->
    {#if sub === 'archiv'}
      <div class="settings-group">
        <h4>Archiv ({archive.length})</h4>
        <p class="ld-section-hint" style="margin-top:0">Jede Erhebung mit Zeitstempel und Ersteller. Löschen wirkt nur im Werkzeug.</p>
        {#if archive.length}
          <div class="gt-table-wrap">
            <table class="gt-table">
              <thead><tr><th>Erhoben</th><th>Art</th><th>Titel</th><th>Durch</th><th></th></tr></thead>
              <tbody>
                {#each archive as e (e.id)}
                  <tr>
                    <td class="nw-small">{fmt(e.createdAt)}</td>
                    <td class="nw-small">{KIND_LABEL[e.kind] || e.kind}</td>
                    <td><strong>{e.title}</strong></td>
                    <td class="nw-small">{e.createdBy}</td>
                    <td class="nw-row-actions">
                      <button class="nw-link" onclick={() => openEntry(e.id)}>anzeigen</button>
                      <button class="nw-link" onclick={() => pdf(e.id)}>PDF</button>
                      <button class="nw-link" onclick={() => csv(e.id)}>CSV</button>
                      <button class="nw-link nw-danger" onclick={() => removeEntry(e)}>löschen</button>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {:else}
          <p class="ld-section-hint">Noch nichts erhoben.</p>
        {/if}
      </div>
    {/if}
  </div>
</TenantContext>

<style>
  .nw { display: flex; flex-direction: column; gap: 0.75rem; }
  .nw-job { display: flex; gap: 0.75rem; align-items: center; }
  .nw-form { display: flex; gap: 0.6rem; flex-wrap: wrap; align-items: flex-end; margin: 0.4rem 0; }
  .nw-form label, .nw-regform label { display: flex; flex-direction: column; gap: 0.15rem; font-size: 0.78rem; color: var(--text-dim); }
  .nw-form input[type=text], .nw-form input[type=date], .nw-form select,
  .nw-regform input, .nw-regform select { font-size: 0.85rem; padding: 0.3rem 0.45rem; border: 1px solid var(--rule); border-radius: var(--radius-sm); background: transparent; color: var(--text); min-width: 9rem; }
  .nw-form .nw-check { flex-direction: row; align-items: center; gap: 0.3rem; padding-bottom: 0.35rem; }
  .nw-wide { flex: 1; min-width: 16rem; }
  .nw-wide input { width: 100%; }
  .nw-hint { font-size: 0.8rem; padding: 0.35rem 0.6rem; border-left: 3px solid var(--info, var(--accent)); background: var(--accent-wash); }
  .nw-hint.warn { border-left-color: var(--warn); background: var(--warn-wash); }
  .nw-result { border: 1px solid var(--rule); border-radius: var(--radius-sm); padding: 0.75rem 0.85rem; margin-top: 0.75rem; display: flex; flex-direction: column; gap: 0.5rem; }
  .nw-result-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; flex-wrap: wrap; }
  .nw-actions { display: flex; gap: 0.4rem; }
  .nw-chips { display: flex; gap: 0.35rem; flex-wrap: wrap; align-items: center; }
  .nw-line { font-size: 0.82rem; padding-left: 0.6rem; border-left: 3px solid var(--rule); }
  .nw-line.warn { border-left-color: var(--warn); }
  .nw-dim { color: var(--text-dim); }
  .nw-small { font-size: 0.78rem; }
  .nw-change { padding-left: 0.6rem; }
  .nw-h5 { margin: 0.6rem 0 0.2rem; font-size: 0.9rem; }
  .nw-link { background: none; border: 0; cursor: pointer; padding: 0; font: inherit; font-size: 0.8rem; text-decoration: underline; color: var(--accent); }
  .nw-danger { color: var(--crit); }
  .nw-sm { padding: 0.2rem 0.6rem; font-size: 0.78rem; }
  .nw-row-actions { display: flex; gap: 0.6rem; align-items: center; flex-wrap: wrap; }
  .nw-kv { display: grid; grid-template-columns: 10rem 1fr; gap: 0.75rem; font-size: 0.85rem; }
  .nw-kv > span:first-child { color: var(--text-dim); font-weight: 600; }
  .nw-regform { display: flex; flex-wrap: wrap; gap: 0.6rem; align-items: flex-end; border: 1px dashed var(--rule); border-radius: var(--radius-sm); padding: 0.6rem 0.75rem; margin: 0.5rem 0; }
  .nw-sugg { display: flex; flex-direction: column; gap: 0.2rem; }
  .nw-sugg-row { display: flex; justify-content: space-between; gap: 1rem; font-size: 0.85rem; border-bottom: 1px solid var(--rule); padding: 0.15rem 0; }
  .nw-watch { display: flex; flex-direction: column; gap: 0.2rem; padding: 0.4rem 0.6rem; border: 1px solid var(--rule); border-radius: var(--radius-sm); }
  .nw-list { margin: 0; padding-left: 1.2rem; font-size: 0.84rem; }
  .nw-search { min-width: 260px; padding: 0.35rem 0.6rem; font-size: 0.85rem; border: 1px solid var(--rule); border-radius: var(--radius-sm); background: transparent; color: inherit; margin: 0.5rem 0; }
  .nw-risky { color: var(--crit); font-weight: 700; }
  .nw-issue { border: 1px solid var(--rule); border-radius: var(--radius-sm); padding: 0.4rem 0.6rem; }
  .nw-issue summary { cursor: pointer; font-size: 0.86rem; }
  .nw-post { white-space: pre-wrap; font-family: inherit; font-size: 0.8rem; background: var(--accent-wash); padding: 0.5rem; border-radius: var(--radius-sm); margin: 0.4rem 0 0; }
  @media (max-width: 720px) { .nw-kv { grid-template-columns: 1fr; gap: 0.1rem; } }
</style>
