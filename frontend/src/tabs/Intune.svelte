<script>
  import { onDestroy } from 'svelte'
  import { apiGet, apiPost } from '../lib/api.js'
  import { activeTenant } from '../lib/tenantStore.js'
  import TenantContext from '../lib/TenantContext.svelte'

  const oibIcon = { assigned: '✅', skipped: '⏭️', failed: '❌' }
  const oibText = { assigned: 'zugewiesen', skipped: 'war bereits zugewiesen', failed: 'Fehler' }

  // Bekannte Break-Risiken aus der OIB-Doku: koennen bestehenden Zugriff
  // brechen, wenn ungetestet scharf ausgerollt. Matching auf den vollen
  // Policy-Namen ("Win - OIB - <Typ> - ..."), damit es Prefix-unabhaengig bleibt.
  const BREAK_RISK = [
    { match: /disable ntlm/i, risk: 'RDP per IP, Legacy-Apps/-Dienste mit NTLM' },
    { match: /local security policies/i, risk: 'Alte NAS/Drucker/SMBv1, LAN-Manager-/SMB-Signing-Auth' },
    { match: /device guard.*credential guard|credential guard.*hvci/i, risk: 'NTLMv1-SSO, RDP/VPN/802.1x mit Passwort-SSO, gespeicherte RDP-Creds, inkompatible Treiber' },
    { match: /remote desktop services and rpc/i, risk: 'RDP, Legacy-RPC-Apps' }
  ]
  function breakRiskFor(name) {
    const hit = BREAK_RISK.find(b => b.match.test(name || ''))
    return hit ? hit.risk : null
  }

  // Policy-Namen enden oft auf "... - v3.7" / "... - v3.8" (OIB-Versionsschema).
  // Fuer uns ist immer nur die neueste Version je Basisname relevant — aeltere
  // werden markiert und NIE automatisch mit ausgewaehlt.
  function parseVersioned(name) {
    const m = /^(.*)\s-\s[vV](\d+(?:\.\d+)*)$/.exec(String(name || '').trim())
    return m ? { base: m[1], version: m[2] } : null
  }
  function compareVersions(a, b) {
    const pa = a.split('.').map(Number), pb = b.split('.').map(Number)
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0)
      if (d) return d
    }
    return 0
  }

  let loading = $state(false)
  let loadError = $state(null)
  let data = $state(null)          // { groups, policies, intentsError }
  let selectedGroupId = $state('')
  let checked = $state({})         // policyId -> bool
  let assigning = $state(false)
  let assignResult = $state(null)  // { error } | { results, gname }
  let lastTenantId = null

  // ---------- Baseline-Import (OpenIntuneBaseline -> Tenant) ----------
  let importOpen = $state(false)
  let baseline = $state(null)        // { oibVersion, policies: [{folder, fileName, name}] }
  let baselineLoading = $state(false)
  let baselineError = $state(null)
  let importChecked = $state({})     // fileName -> bool
  let importJob = $state(null)
  let importJobId = $state(null)
  let importBusy = $state(false)
  let importTimer = null

  // ---------- Assignment-Check (read-only Zuweisungs-Audit) ----------
  let checkOpen = $state(false)
  let checkLoading = $state(false)
  let checkError = $state(null)
  let checkData = $state(null)       // { summary, results }
  let checkOnlyIssues = $state(true)

  const ISSUE_META = {
    unassigned: { label: 'Ohne Zuweisung', icon: '🚫', hint: 'Policy/App ist niemandem zugewiesen — wirkt nirgends.' },
    emptyGroup: { label: 'Leere Gruppe', icon: '🕳️', hint: 'Zuweisung zeigt auf eine Gruppe mit 0 Mitgliedern.' },
    missingGroup: { label: 'Gruppe fehlt', icon: '❓', hint: 'Zugewiesene Gruppe existiert nicht mehr (gelöscht).' },
    broadAll: { label: 'Alle Benutzer/Geräte', icon: '🌐', hint: 'Breite Zuweisung — bewusst prüfen, kein Fehler per se.' }
  }

  $effect(() => {
    const id = $activeTenant?.id ?? null
    if (id !== lastTenantId) {
      lastTenantId = id
      data = null
      loadError = null
      assignResult = null
      checked = {}
      if (id) load()
    }
  })

  async function load() {
    if (!$activeTenant) return
    loading = true
    loadError = null
    try {
      const d = await apiGet(`/api/tenants/${encodeURIComponent($activeTenant.id)}/oib`)
      data = d
      selectedGroupId = (d.groups || [])[0]?.id || ''
      checked = {}
      assignResult = null
    } catch (e) {
      loadError = e.message
    }
    loading = false
  }

  const byType = $derived.by(() => {
    if (!data?.policies) return []
    const list = []
    for (const p of data.policies) {
      let grp = list.find(g => g.type === p.type)
      if (!grp) { grp = { type: p.type, items: [] }; list.push(grp) }
      grp.items.push(p)
    }
    return list
  })

  function alreadyInSelected(p) {
    return (p.assignments || []).some(a => a.groupId === selectedGroupId)
  }

  const latestVersionByBase = $derived.by(() => {
    const map = new Map()
    for (const p of (data?.policies || [])) {
      const v = parseVersioned(p.name)
      if (!v) continue
      const cur = map.get(v.base)
      if (!cur || compareVersions(v.version, cur) > 0) map.set(v.base, v.version)
    }
    return map
  })
  function outdatedInfo(p) {
    const v = parseVersioned(p.name)
    if (!v) return null
    const latest = latestVersionByBase.get(v.base)
    if (!latest || compareVersions(v.version, latest) >= 0) return null
    return { latest }
  }

  function selectAll() {
    const next = {}
    for (const p of data.policies) if (!alreadyInSelected(p) && !outdatedInfo(p)) next[p.id] = true
    checked = next
  }
  function selectNone() { checked = {} }
  function selectTypeAll(type) {
    const next = { ...checked }
    for (const p of data.policies) if (p.type === type && !alreadyInSelected(p) && !outdatedInfo(p)) next[p.id] = true
    checked = next
  }

  const existingNames = $derived(new Set((data?.policies || []).map(p => p.name)))
  const importByFolder = $derived.by(() => {
    if (!baseline?.policies) return []
    const list = []
    for (const p of baseline.policies) {
      let grp = list.find(g => g.folder === p.folder)
      if (!grp) { grp = { folder: p.folder, items: [] }; list.push(grp) }
      grp.items.push(p)
    }
    return list
  })
  const importSelectedCount = $derived(Object.values(importChecked).filter(Boolean).length)

  async function toggleImport() {
    importOpen = !importOpen
    if (importOpen && !baseline) await loadBaseline()
  }
  async function loadBaseline() {
    baselineLoading = true
    baselineError = null
    try {
      const r = await apiGet('/api/oib/baseline')
      baseline = { oibVersion: r.oibVersion, policies: r.policies || [] }
      // Vorauswahl: alles, was noch nicht im Tenant existiert
      const next = {}
      for (const p of baseline.policies) if (!existingNames.has(p.name)) next[p.fileName] = true
      importChecked = next
    } catch (e) {
      baselineError = e.message
    }
    baselineLoading = false
  }
  function importSelectAll(val) {
    const next = {}
    for (const p of (baseline?.policies || [])) if (val && !existingNames.has(p.name)) next[p.fileName] = true
    importChecked = next
  }

  async function startImport() {
    const files = (baseline?.policies || []).filter(p => importChecked[p.fileName]).map(p => ({ folder: p.folder, fileName: p.fileName }))
    if (!files.length) { alert('Keine Policies ausgewählt.'); return }
    if (!confirm(`${files.length} Baseline-Policies in "${$activeTenant.name}" importieren?\n\nBereits vorhandene Policies (gleicher Name) werden übersprungen, nie überschrieben. Die Policies werden OHNE Zuweisung angelegt — das Zuweisen passiert danach wie gewohnt unten im Tab.`)) return
    importBusy = true
    importJob = null
    try {
      const r = await apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/oib/import`, { files })
      importJobId = r.jobId
      pollImportJob()
    } catch (e) {
      alert('Start fehlgeschlagen: ' + e.message)
      importBusy = false
    }
  }
  function pollImportJob() {
    importTimer = setTimeout(async () => {
      let j
      try { j = await apiGet(`/api/appjobs/${encodeURIComponent(importJobId)}`) }
      catch (e) { importBusy = false; return }
      importJob = j
      if (j.status === 'running') { pollImportJob(); return }
      importBusy = false
      load() // Overview neu laden — importierte Policies erscheinen in der Zuweisungsliste
    }, 1000)
  }

  async function assign() {
    const selectedPolicies = data.policies.filter(p => checked[p.id])
    if (!selectedPolicies.length) { alert('Keine Policies ausgewählt.'); return }
    const selected = selectedPolicies.map(p => ({ id: p.id, apiType: p.apiType }))
    const gname = data.groups.find(g => g.id === selectedGroupId)?.displayName || selectedGroupId

    const risky = selectedPolicies.map(p => ({ p, risk: breakRiskFor(p.name) })).filter(x => x.risk)
    if (risky.length) {
      const lines = risky.map(x => `• ${x.p.name}\n  → kann brechen: ${x.risk}`).join('\n\n')
      if (!confirm(`⚠️ ${risky.length} ausgewählte Policy/Policies gelten als Break-Risiko — vor scharfem Rollout testen:\n\n${lines}\n\nTrotzdem der Gruppe "${gname}" zuweisen?`)) return
    }
    if (!confirm(`${selected.length} Policy/Policies der Gruppe "${gname}" zuweisen?\n\nBestehende Assignments bleiben erhalten (Merge).`)) return
    assigning = true
    assignResult = null
    try {
      const r = await apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/oib/assign`, { groupId: selectedGroupId, policies: selected })
      const nameById = new Map(data.policies.map(p => [p.id, p.name]))
      const results = (r.results || []).map(x => ({ ...x, name: nameById.get(x.id) || x.id }))
      for (const x of results) {
        if (x.status !== 'failed') {
          const p = data.policies.find(pp => pp.id === x.id)
          if (p && !(p.assignments || []).some(a => a.groupId === selectedGroupId)) {
            p.assignments = [...(p.assignments || []), { groupId: selectedGroupId, label: gname }]
          }
        }
      }
      data = { ...data }
      assignResult = { results, gname }
      checked = {}
    } catch (e) {
      assignResult = { error: e.message }
    }
    assigning = false
  }

  async function toggleCheck() {
    checkOpen = !checkOpen
    if (checkOpen && !checkData) await runCheck()
  }
  async function runCheck() {
    checkLoading = true
    checkError = null
    try {
      const r = await apiGet(`/api/tenants/${encodeURIComponent($activeTenant.id)}/assignmentcheck`)
      checkData = { summary: r.summary, results: r.results || [] }
    } catch (e) {
      checkError = e.message
    }
    checkLoading = false
  }
  const checkVisible = $derived((checkData?.results || []).filter(r => !checkOnlyIssues || r.issues.length))

  onDestroy(() => { if (importTimer) clearTimeout(importTimer) })
</script>

<TenantContext>
  <div class="settings-group">
    <h4>💻 Intune-Baseline <small>(OpenIntuneBaseline)</small></h4>
    <p class="ld-section-hint">„Win - OIB"-Policies anzeigen und dynamischen Security-Gruppen zuweisen — oder die Baseline zuerst direkt aus dem OpenIntuneBaseline-Repo importieren.</p>
    <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
      <button class="btn btn-secondary" onclick={load} disabled={loading}>{loading ? '…' : '🔄 Neu laden'}</button>
      <button class="btn btn-primary" onclick={toggleImport} disabled={importBusy}>
        {importOpen ? '✕ Import schließen' : '⬇️ Baseline importieren'}
      </button>
      <button class="btn btn-secondary" onclick={toggleCheck} disabled={checkLoading}>
        {checkOpen ? '✕ Check schließen' : '🔍 Assignment-Check'}
      </button>
    </div>
  </div>

  {#if checkOpen}
    <div class="ld-job" style="margin-bottom:1.5rem;">
      <div class="ld-job-head"><strong>🔍 Assignment-Check: {$activeTenant.name}</strong>
        {#if checkData}<span class="ld-job-meta">{checkData.summary.total} Objekte geprüft</span>{/if}</div>
      <p class="ld-section-hint">Read-only-Audit aller Intune-Policies und -Apps: findet Objekte ohne Zuweisung, Zuweisungen auf leere oder gelöschte Gruppen und breite „Alle Benutzer/Geräte"-Zuweisungen.</p>

      {#if checkLoading}
        <div class="ld-step running"><span class="ld-spinner"></span> Lese alle Policies, Apps und Zuweisungen aus dem Tenant… (kann bei vielen Objekten etwas dauern)</div>
      {:else if checkError}
        <div class="ld-banner fail">❌ {checkError}</div>
      {:else if checkData}
        <div class="ld-setup-list" style="margin-bottom:0.6rem;">
          <span class="ld-badge {checkData.summary.unassigned ? 'warn' : 'ok'}">{ISSUE_META.unassigned.icon} {checkData.summary.unassigned} ohne Zuweisung</span>
          <span class="ld-badge {checkData.summary.emptyGroup ? 'warn' : 'ok'}">{ISSUE_META.emptyGroup.icon} {checkData.summary.emptyGroup} auf leere Gruppen</span>
          <span class="ld-badge {checkData.summary.missingGroup ? 'warn' : 'ok'}">{ISSUE_META.missingGroup.icon} {checkData.summary.missingGroup} auf gelöschte Gruppen</span>
          <span class="ld-badge ok">{ISSUE_META.broadAll.icon} {checkData.summary.broadAll} auf Alle Benutzer/Geräte</span>
        </div>
        <div class="ld-oib-toolbar">
          <label style="display:flex; align-items:center; gap:0.4rem; font-size:0.82rem; cursor:pointer;">
            <input type="checkbox" bind:checked={checkOnlyIssues} /> Nur Auffälligkeiten zeigen
          </label>
          <button class="btn btn-secondary" style="padding:0.25rem 0.7rem; font-size:0.8rem;" onclick={runCheck}>🔄 Neu prüfen</button>
        </div>
        {#if !checkVisible.length}
          <div class="ld-banner ok">✅ {checkOnlyIssues ? 'Keine Auffälligkeiten — alle Zuweisungen sehen sauber aus.' : 'Keine Objekte gefunden.'}</div>
        {/if}
        {#each checkVisible as r}
          <div class="ld-phase {r.issues.length ? '' : 'complete'}" class:active={r.issues.length > 0}>
            <div class="ld-phase-title">{r.name} <small style="font-weight:400; color:var(--text-dim);">· {r.type}</small></div>
            {#if r.issues.length}
              <div class="ld-step"><small>
                {#each r.issues as iss, i}{i > 0 ? ' · ' : ''}<span title={ISSUE_META[iss]?.hint}>{ISSUE_META[iss]?.icon} {ISSUE_META[iss]?.label}</span>{/each}
              </small></div>
            {/if}
            <div class="ld-step"><small>
              {#if r.assignments.length}
                → {r.assignments.map(a => (a.exclude ? '⛔ ' : '') + a.label + (a.memberCount !== null && a.kind === 'group' ? ` (${a.memberCount})` : '')).join(', ')}
              {:else}
                → keine Zuweisung
              {/if}
            </small></div>
          </div>
        {/each}
      {/if}
    </div>
  {/if}

  {#if importOpen}
    <div class="ld-job" style="margin-bottom:1.5rem;">
      <div class="ld-job-head"><strong>⬇️ OpenIntuneBaseline importieren{baseline?.oibVersion ? ` (v${baseline.oibVersion})` : ''}</strong>
        {#if baseline}<span class="ld-job-meta">{importSelectedCount}/{baseline.policies.length} ausgewählt</span>{/if}</div>
      <p class="ld-section-hint">Lädt die Windows-Baseline direkt aus <a href="https://github.com/SkipToTheEndpoint/OpenIntuneBaseline" target="_blank" rel="noopener">SkipToTheEndpoint/OpenIntuneBaseline</a> und legt die Policies OHNE Zuweisung im Tenant an. Bereits vorhandene Policies (gleicher Name) werden übersprungen — nie überschrieben. Zuweisen danach wie gewohnt unten.</p>

      {#if baselineLoading}
        <div class="ld-step running"><span class="ld-spinner"></span> Lade Baseline-Index von GitHub…</div>
      {:else if baselineError}
        <div class="ld-banner fail">❌ {baselineError}</div>
      {:else if baseline}
        <div class="ld-oib-toolbar">
          <button class="btn btn-secondary" style="padding:0.25rem 0.7rem; font-size:0.8rem;" onclick={() => importSelectAll(true)}>Alle neuen</button>
          <button class="btn btn-secondary" style="padding:0.25rem 0.7rem; font-size:0.8rem;" onclick={() => importSelectAll(false)}>Keine</button>
        </div>
        {#each importByFolder as grp (grp.folder)}
          <div class="ld-phase complete">
            <div class="ld-phase-title">📁 {grp.folder} ({grp.items.length})</div>
            {#each grp.items as p (p.fileName)}
              {@const already = existingNames.has(p.name)}
              <label class="ld-oib-row" class:already>
                <input type="checkbox" checked={!!importChecked[p.fileName]} disabled={already}
                       onchange={(e) => (importChecked = { ...importChecked, [p.fileName]: e.target.checked })} />
                <span class="ld-oib-name">{p.name}</span>
                {#if already}<small class="ld-oib-assigned">✓ bereits im Tenant</small>{/if}
              </label>
            {/each}
          </div>
        {/each}
        <div class="ld-confirm-actions">
          <button class="btn btn-primary" onclick={startImport} disabled={importBusy || importSelectedCount === 0}>
            {importBusy ? 'Importiere…' : `⬇️ ${importSelectedCount} Policies importieren`}
          </button>
        </div>
      {/if}

      {#if importJob}
        {#if importJob.status === 'failed'}
          <div class="ld-banner fail">❌ {importJob.error}</div>
          {#if importJob.hint}<div class="ld-step"><small>💡 {importJob.hint}</small></div>{/if}
        {:else if importJob.status === 'done'}
          <div class="ld-banner {importJob.results?.failed ? 'warn' : 'ok'}">
            {importJob.results?.failed ? '⚠️' : '✅'} Import fertig — {importJob.results?.created ?? 0} angelegt, {importJob.results?.skipped ?? 0} übersprungen{importJob.results?.failed ? `, ${importJob.results.failed} fehlgeschlagen` : ''}.
          </div>
          {#each (importJob.results?.details || []).filter(d => d.status === 'failed') as d}
            <div class="ld-step fail"><span class="ld-ico">❌</span> {d.name} <small>({d.error})</small></div>
          {/each}
        {/if}
        {#each importJob.steps as s}
          {#if s.state === 'running'}
            <div class="ld-step running"><span class="ld-spinner"></span> {s.name}</div>
          {:else if s.state === 'done'}
            <div class="ld-step ok"><span class="ld-ico">✅</span> {s.name}</div>
          {/if}
        {/each}
      {/if}
    </div>
  {/if}

  {#if loading}
    <div class="ld-job"><div class="ld-step running"><span class="ld-spinner"></span> Lade Policies und dynamische Gruppen aus dem Tenant…</div></div>
  {:else if loadError}
    <div class="ld-job">
      <div class="ld-banner fail">❌ {loadError}</div>
      <div class="ld-step"><small>💡 Braucht die Graph-Permissions (DeviceManagementConfiguration, Group.Read) — ggf. im Tab „🏢 Tenants" einmal 🔧 Reparieren ausführen.</small></div>
    </div>
  {:else if data}
    {#if !data.policies?.length}
      <div class="ld-job"><div class="ld-banner warn">⚠️ Keine "Win - OIB"-Policies im Tenant gefunden — zuerst die OIB-Baseline importieren.</div></div>
    {:else if !data.groups?.length}
      <div class="ld-job"><div class="ld-banner warn">⚠️ Keine dynamischen Security Groups gefunden — zuerst die Gerätegruppen (AAD-DEV-*) anlegen.</div></div>
    {:else}
      <div class="ld-job">
        <div class="ld-job-head"><strong>🧩 OIB-Policies: {$activeTenant.name}</strong>
          <span class="ld-job-meta">{data.policies.length} Policies · {data.groups.length} dynamische Gruppen</span></div>

        {#if data.intentsError}
          <div class="ld-banner warn">⚠️ Endpoint-Security-Policies (intents) konnten nicht geladen werden: {data.intentsError}
            <br /><small>Settings-Catalog-Policies sind trotzdem verfügbar. Falls gerade erst 🔧 repariert wurde: ein paar Minuten Consent-Replikation abwarten und erneut laden.</small></div>
        {/if}

        <div class="ld-oib-target">
          <label for="oibGroup"><strong>Zielgruppe (dynamische Security Group):</strong></label>
          <select id="oibGroup" bind:value={selectedGroupId}>
            {#each data.groups as g (g.id)}<option value={g.id} title={g.membershipRule}>{g.displayName}</option>{/each}
          </select>
        </div>
        <div class="ld-oib-toolbar">
          <button class="btn btn-secondary" style="padding:0.25rem 0.7rem; font-size:0.8rem;" onclick={selectAll}>Alle auswählen</button>
          <button class="btn btn-secondary" style="padding:0.25rem 0.7rem; font-size:0.8rem;" onclick={selectNone}>Keine</button>
        </div>

        {#each byType as grp (grp.type)}
          <div class="ld-phase complete">
            <div class="ld-phase-title">🧩 {grp.type} ({grp.items.length})
              <button class="btn btn-secondary" style="padding:0.1rem 0.5rem; font-size:0.75rem;" onclick={() => selectTypeAll(grp.type)}>alle</button>
            </div>
            {#each grp.items as p (p.id)}
              {@const already = alreadyInSelected(p)}
              {@const risk = breakRiskFor(p.name)}
              {@const outdated = outdatedInfo(p)}
              <label class="ld-oib-row" class:already class:breakrisk={!!risk} class:outdated={!!outdated}>
                <input type="checkbox" checked={!!checked[p.id]} disabled={already}
                       onchange={(e) => (checked = { ...checked, [p.id]: e.target.checked })} />
                <span class="ld-oib-name">{p.name}</span>
                {#if outdated}
                  <span class="ld-oib-outdated-tag" title="Neuere Version verfügbar: v{outdated.latest} — wird bei „Alle auswählen“ bewusst NICHT mit ausgewählt, Haken muss hier explizit gesetzt werden.">🆕 Neuere Version verfügbar (v{outdated.latest})</span>
                {/if}
                {#if risk}
                  <span class="ld-oib-risk" title="Break-Risiko: {risk}">⚠ Break-Risiko</span>
                {/if}
                <small class="ld-oib-assigned">
                  {already ? '✓ bereits dieser Gruppe zugewiesen · ' : ''}{(p.assignments || []).length ? '→ ' + p.assignments.map(a => a.label).join(', ') : '→ nicht zugewiesen'}
                </small>
              </label>
            {/each}
          </div>
        {/each}

        <div class="ld-confirm-actions">
          <button class="btn btn-primary" onclick={assign} disabled={assigning}>{assigning ? 'Weise zu…' : 'Auswahl der Zielgruppe zuweisen'}</button>
        </div>

        {#if assigning}
          <div class="ld-step running"><span class="ld-spinner"></span> Zuweisung läuft…</div>
        {:else if assignResult?.error}
          <div class="ld-banner fail">❌ {assignResult.error}</div>
        {:else if assignResult?.results}
          {@const okCount = assignResult.results.filter(x => x.status === 'assigned').length}
          {@const failCount = assignResult.results.filter(x => x.status === 'failed').length}
          <div class="ld-banner {failCount ? 'warn' : 'ok'}">
            {failCount ? `⚠️ ${failCount} Fehler — Details unten. ` : '✅ '}{okCount} Policy/Policies der Gruppe „{assignResult.gname}" zugewiesen.
          </div>
          {#each assignResult.results as x}
            <div class="ld-step {x.status === 'failed' ? 'fail' : 'ok'}">
              <span class="ld-ico">{oibIcon[x.status]}</span> {x.name} <small>({oibText[x.status]}{x.error ? ' — ' + x.error : ''})</small>
            </div>
          {/each}
        {/if}
      </div>
    {/if}
  {/if}
</TenantContext>
