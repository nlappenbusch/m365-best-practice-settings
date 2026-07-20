<script>
  import { onDestroy } from 'svelte'
  import { apiGet, apiPost } from '../lib/api.js'
  import { session } from '../lib/session.js'
  import { activeTenant } from '../lib/tenantStore.js'
  import TenantContext from '../lib/TenantContext.svelte'

  const TIER_ORDER = ['bareMinimum', 'aadp1', 'aadp1p2']
  const STATE_META = {
    enabledForReportingButNotEnforced: { label: '🟡 Report-only', cls: 'warn' },
    enabled: { label: '🟢 Aktiv', cls: 'ok' },
    disabled: { label: '⚪ Deaktiviert', cls: '' }
  }

  let tiers = $state(null)
  let tiersError = $state(null)
  let previewOpen = $state({}) // tierKey -> bool
  let previewSelected = $state({}) // tierKey -> { index: bool }

  let policiesLoading = $state(false)
  let policiesError = $state(null)
  let supportGroups = $state([])
  let policies = $state([])

  let groups = $state([])
  let pilotChoice = $state({}) // policyId -> groupId

  let deploying = $state(false)
  let jobId = $state(null)
  let job = $state(null)
  let jobTimer = null
  let actionBusy = $state({}) // policyId -> bool
  let lastTenantId = null

  // Batch-Auswahl fuer die Policy-Liste
  let selectedPolicies = $state({}) // policyId -> bool
  let batchScopeChoice = $state('')
  let batchBusy = $state(false)
  let batchProgress = $state(null) // { done, total } waehrend eines Batch-Laufs

  // Schutzgruppen-Assignment-Assistent: bestehenden Nutzer suchen + hinzufuegen
  let memberSearchOpen = $state({}) // groupKey -> bool
  let memberQuery = $state({}) // groupKey -> string
  let memberResults = $state({}) // groupKey -> array
  let memberSearchBusy = $state({}) // groupKey -> bool
  let memberAddBusy = $state({}) // userId -> bool
  let memberSearchTimer = null

  // Break-Glass: dediziertes Notfallzugriffskonto anlegen
  let bgFormOpen = $state(false)
  let bgUsername = $state('')
  let bgBusy = $state(false)
  let bgError = $state(null)
  let bgResult = $state(null) // { userPrincipalName, password } -- nur einmalig sichtbar
  let bgAcked = $state(false)

  let tiersLoaded = false
  async function loadTiers() {
    tiersError = null
    try {
      const r = await apiGet('/api/conditionalaccess/tiers')
      tiers = r.tiers
      tiersLoaded = true
    } catch (e) {
      tiersError = e.message
    }
  }

  // Alle Tabs sind von Anfang an gemountet (siehe App.svelte) — beim ersten
  // Render ist die Session evtl. noch nicht bestaetigt. Reaktiv statt einmalig
  // beim Erzeugen der Komponente laden, sonst bleibt ein "Nicht angemeldet"
  // aus dem allerersten Versuch dauerhaft stehen, auch nachdem man sich
  // angemeldet hat.
  $effect(() => {
    if ($session.ready && $session.online && $session.loggedIn && !tiersLoaded) {
      loadTiers()
    }
    if (!($session.loggedIn && $session.online)) tiersLoaded = false
  })

  $effect(() => {
    const id = $activeTenant?.id ?? null
    if (id !== lastTenantId) {
      lastTenantId = id
      policies = []; supportGroups = []; policiesError = null
      job = null; jobId = null; deploying = false
      if (jobTimer) { clearTimeout(jobTimer); jobTimer = null }
      if (id) { loadPolicies(); loadGroups() }
    }
  })

  async function loadPolicies() {
    if (!$activeTenant) return
    policiesLoading = true
    policiesError = null
    try {
      const r = await apiGet(`/api/tenants/${encodeURIComponent($activeTenant.id)}/conditionalaccess/policies`)
      supportGroups = r.supportGroups || []
      policies = r.policies || []
    } catch (e) {
      policiesError = e.message
    }
    policiesLoading = false
  }

  async function loadGroups() {
    try {
      const r = await apiGet(`/api/tenants/${encodeURIComponent($activeTenant.id)}/groups`)
      groups = r.groups || []
    } catch (e) { /* egal, Pilot-Auswahl bleibt dann leer */ }
  }

  // Vorschau/Feinjustierung: vor dem Deploy erst die enthaltenen Policy-Namen
  // zeigen und einzelne abwaehlen koennen, statt blind alles auszurollen.
  function togglePreview(tierKey) {
    const opening = !previewOpen[tierKey]
    previewOpen = { ...previewOpen, [tierKey]: opening }
    if (opening && !previewSelected[tierKey]) {
      const names = tiers[tierKey].policyNames || []
      const all = {}
      names.forEach((_, i) => (all[i] = true))
      previewSelected = { ...previewSelected, [tierKey]: all }
    }
  }
  function previewSelectAll(tierKey, val) {
    const names = tiers[tierKey].policyNames || []
    const next = {}
    names.forEach((_, i) => (next[i] = val))
    previewSelected = { ...previewSelected, [tierKey]: next }
  }
  function setPreviewChecked(tierKey, i, val) {
    previewSelected = { ...previewSelected, [tierKey]: { ...(previewSelected[tierKey] || {}), [i]: val } }
  }
  function previewSelectedCount(tierKey) {
    const sel = previewSelected[tierKey] || {}
    return Object.values(sel).filter(Boolean).length
  }

  async function deployTier(tierKey) {
    const meta = tiers[tierKey]
    const sel = previewSelected[tierKey] || {}
    const indices = Object.keys(sel).filter(i => sel[i]).map(Number)
    if (!indices.length) { alert('Keine Policies ausgewählt.'); return }
    if (!confirm(
      `Tier "${meta.label}" ausrollen (${indices.length} von ${meta.policyCount} Policies ausgewählt)?\n\n` +
      `Alle Policies werden ausschliesslich im Report-only-Zustand angelegt — ` +
      `NICHTS wird dadurch scharf geschaltet. Vier Schutzgruppen (Break-Glass, ` +
      `Sync-Konten, 2× Ausnahmen) werden dabei angelegt, falls noch nicht vorhanden.`
    )) return
    deploying = true
    job = null
    previewOpen = { ...previewOpen, [tierKey]: false }
    try {
      const r = await apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/conditionalaccess/deploy`, { tier: tierKey, indices })
      jobId = r.jobId
      pollJob()
    } catch (e) {
      alert('Start fehlgeschlagen: ' + e.message)
      deploying = false
    }
  }

  function pollJob() {
    jobTimer = setTimeout(async () => {
      let j
      try { j = await apiGet(`/api/appjobs/${encodeURIComponent(jobId)}`) }
      catch (e) { deploying = false; return }
      job = j
      if (j.status === 'running') { pollJob(); return }
      deploying = false
      loadPolicies()
    }, 1000)
  }

  async function activate(p) {
    if (!confirm(
      `⚠️ Policy „${p.displayName}" SCHARF SCHALTEN?\n\n` +
      `Ab jetzt wird die Regel tatsächlich durchgesetzt (nicht mehr nur protokolliert). ` +
      `Scope aktuell: ${p.scope}.\n\nWirklich aktivieren?`
    )) return
    actionBusy = { ...actionBusy, [p.id]: true }
    try {
      await apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/conditionalaccess/policies/${encodeURIComponent(p.id)}/state`, { state: 'enabled' })
      await loadPolicies()
    } catch (e) {
      alert('Fehler: ' + e.message)
    }
    actionBusy = { ...actionBusy, [p.id]: false }
  }

  async function deactivate(p) {
    if (!confirm(`Policy „${p.displayName}" zurück auf Report-only setzen (nicht mehr durchgesetzt)?`)) return
    actionBusy = { ...actionBusy, [p.id]: true }
    try {
      await apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/conditionalaccess/policies/${encodeURIComponent(p.id)}/state`, { state: 'enabledForReportingButNotEnforced' })
      await loadPolicies()
    } catch (e) {
      alert('Fehler: ' + e.message)
    }
    actionBusy = { ...actionBusy, [p.id]: false }
  }

  async function applyScope(p) {
    const groupId = pilotChoice[p.id] || null
    const gname = groupId ? (groups.find(g => g.id === groupId)?.displayName || groupId) : 'Alle'
    if (!confirm(`Scope von „${p.displayName}" auf „${gname}" setzen?`)) return
    actionBusy = { ...actionBusy, [p.id]: true }
    try {
      await apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/conditionalaccess/policies/${encodeURIComponent(p.id)}/scope`, { pilotGroupId: groupId })
      await loadPolicies()
    } catch (e) {
      alert('Fehler: ' + e.message)
    }
    actionBusy = { ...actionBusy, [p.id]: false }
  }

  const selectedIds = $derived(Object.keys(selectedPolicies).filter(id => selectedPolicies[id]))
  const allSelected = $derived(policies.length > 0 && policies.every(p => selectedPolicies[p.id]))

  function toggleAll() {
    const next = !allSelected
    const upd = { ...selectedPolicies }
    for (const p of policies) upd[p.id] = next
    selectedPolicies = upd
  }
  function clearSelection() { selectedPolicies = {} }

  async function batchRun(label, fn) {
    const ids = selectedIds
    if (!ids.length) return
    batchBusy = true
    batchProgress = { done: 0, total: ids.length }
    for (const id of ids) {
      try { await fn(id) } catch (e) { /* einzelne Fehler nicht abbrechen -- am Ende neu laden zeigt den Ist-Stand */ }
      batchProgress = { done: batchProgress.done + 1, total: ids.length }
    }
    batchBusy = false
    batchProgress = null
    clearSelection()
    await loadPolicies()
  }

  async function batchActivate() {
    if (!confirm(`⚠️ ${selectedIds.length} ausgewählte Policies SCHARF SCHALTEN?\n\nAb jetzt werden diese Regeln tatsächlich durchgesetzt (nicht mehr nur protokolliert). Wirklich aktivieren?`)) return
    await batchRun('activate', id => apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/conditionalaccess/policies/${encodeURIComponent(id)}/state`, { state: 'enabled' }))
  }
  async function batchDeactivate() {
    if (!confirm(`${selectedIds.length} ausgewählte Policies zurück auf Report-only setzen?`)) return
    await batchRun('deactivate', id => apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/conditionalaccess/policies/${encodeURIComponent(id)}/state`, { state: 'enabledForReportingButNotEnforced' }))
  }
  async function batchSetScope() {
    const groupId = batchScopeChoice || null
    const gname = groupId ? (groups.find(g => g.id === groupId)?.displayName || groupId) : 'Alle'
    if (!confirm(`Scope von ${selectedIds.length} ausgewählten Policies auf „${gname}" setzen?`)) return
    await batchRun('scope', id => apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/conditionalaccess/policies/${encodeURIComponent(id)}/scope`, { pilotGroupId: groupId }))
  }

  function toggleMemberSearch(key) {
    memberSearchOpen = { ...memberSearchOpen, [key]: !memberSearchOpen[key] }
    if (!memberSearchOpen[key]) { memberQuery = { ...memberQuery, [key]: '' }; memberResults = { ...memberResults, [key]: [] } }
  }
  function onMemberQueryInput(key, value) {
    memberQuery = { ...memberQuery, [key]: value }
    if (memberSearchTimer) clearTimeout(memberSearchTimer)
    memberSearchTimer = setTimeout(() => searchMembers(key), 350)
  }
  async function searchMembers(key) {
    const q = (memberQuery[key] || '').trim()
    if (q.length < 2) { memberResults = { ...memberResults, [key]: [] }; return }
    memberSearchBusy = { ...memberSearchBusy, [key]: true }
    try {
      const r = await apiGet(`/api/tenants/${encodeURIComponent($activeTenant.id)}/conditionalaccess/users?q=${encodeURIComponent(q)}`)
      memberResults = { ...memberResults, [key]: r.users || [] }
    } catch (e) { memberResults = { ...memberResults, [key]: [] } }
    memberSearchBusy = { ...memberSearchBusy, [key]: false }
  }
  async function addMember(key, user) {
    memberAddBusy = { ...memberAddBusy, [user.id]: true }
    try {
      await apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/conditionalaccess/supportgroups/${encodeURIComponent(key)}/members`, { userId: user.id })
      toggleMemberSearch(key)
      await loadPolicies()
    } catch (e) {
      alert('Fehler: ' + e.message)
    }
    memberAddBusy = { ...memberAddBusy, [user.id]: false }
  }

  // Namenskonvention (siehe Wissen -> Namenskonventionen): breakglass-<NN>,
  // durchnummeriert. Naechste freie Nummer per Live-Suche ermitteln, damit
  // das Feld beim Oeffnen schon sinnvoll vorbelegt ist statt leer zu sein.
  async function suggestBreakGlassUsername() {
    try {
      const r = await apiGet(`/api/tenants/${encodeURIComponent($activeTenant.id)}/conditionalaccess/users?q=breakglass`)
      const nums = (r.users || [])
        .map(u => /^breakglass-(\d+)@/i.exec(u.userPrincipalName || ''))
        .filter(Boolean)
        .map(m => parseInt(m[1], 10))
      const next = nums.length ? Math.max(...nums) + 1 : 1
      return 'breakglass-' + String(next).padStart(2, '0')
    } catch (e) {
      return 'breakglass-01'
    }
  }
  async function toggleBgForm() {
    const opening = !bgFormOpen
    bgFormOpen = opening
    bgError = null
    bgUsername = opening ? await suggestBreakGlassUsername() : ''
  }
  async function createBreakGlass() {
    const local = bgUsername.trim()
    if (!local) return
    bgBusy = true; bgError = null
    try {
      const r = await apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/conditionalaccess/breakglass/create`, { username: local })
      bgResult = { userPrincipalName: r.userPrincipalName, password: r.password }
      bgAcked = false
      bgFormOpen = false
      await loadPolicies()
    } catch (e) {
      bgError = e.message
    }
    bgBusy = false
  }
  function copyBgPassword() { if (bgResult) navigator.clipboard.writeText(bgResult.password) }
  function ackBgResult() { bgResult = null; bgAcked = false }

  onDestroy(() => { if (jobTimer) clearTimeout(jobTimer); if (memberSearchTimer) clearTimeout(memberSearchTimer) })

  const breakGlassEmpty = $derived(supportGroups.find(g => g.key === 'breakGlass' && g.memberCount === 0))
</script>

<TenantContext>
  <div class="settings-group">
    <h4>🔐 Conditional Access</h4>
    <p class="ld-section-hint">Rollt eine der drei Best-Practice-Vorlagen aus <a href="https://github.com/AlexFilipin/ConditionalAccess" target="_blank">AlexFilipin/ConditionalAccess</a> aus.</p>
    <div class="alert alert-warning">
      ⚠️ <strong>Sicherheitshinweis:</strong> Jede Policy wird ausschliesslich im <b>Report-only-Zustand</b> angelegt — nichts
      wird automatisch scharf geschaltet. Aktivieren ist immer ein separater, bestätigter Schritt weiter unten.
      Ein falsch aktiviertes Conditional-Access-Regelwerk kann im schlimmsten Fall den gesamten Tenant aussperren.
    </div>
  </div>

  {#if tiersError}
    <div class="ld-banner fail">❌ {tiersError}</div>
  {:else if !tiers}
    <div class="ld-step running"><span class="ld-spinner"></span> Lade Tiers…</div>
  {:else}
    <div class="settings-grid" style="margin-bottom:1.5rem;">
      {#each TIER_ORDER as key}
        {@const t = tiers[key]}
        <div class="policy-card" style="margin-bottom:0;">
          <div class="policy-details active" style="display:block; padding:1rem 1.1rem;">
            <h4 style="margin-bottom:0.3rem;">{t.label}</h4>
            <p style="font-size:0.85rem; color:var(--text-dim); margin-bottom:0.5rem;">{t.description}</p>
            <p style="font-size:0.78rem; color:var(--text-faint); margin-bottom:0.7rem;">📄 {t.policyCount} Policies · {t.license}</p>
            <button class="btn btn-primary" style="width:100%;" onclick={() => togglePreview(key)} disabled={deploying}>
              {previewOpen[key] ? '✕ Vorschau schließen' : '👁 Vorschau & Ausrollen'}
            </button>
          </div>
        </div>
      {/each}
    </div>

    {#each TIER_ORDER as key}
      {@const t = tiers[key]}
      {#if previewOpen[key]}
        <div class="ld-job" style="margin-bottom:1.5rem;">
          <div class="ld-job-head"><strong>👁 Vorschau: {t.label}</strong>
            <span class="ld-job-meta">{previewSelectedCount(key)}/{(t.policyNames || []).length} ausgewählt</span></div>
          <p class="ld-section-hint">Alle Policies werden trotzdem nur im Report-only-Zustand angelegt — die Auswahl hier bestimmt nur, WELCHE der Vorlagen-Policies überhaupt angelegt werden.</p>
          <div class="ld-oib-toolbar">
            <button class="btn btn-secondary" style="padding:0.25rem 0.7rem; font-size:0.8rem;" onclick={() => previewSelectAll(key, true)}>Alle</button>
            <button class="btn btn-secondary" style="padding:0.25rem 0.7rem; font-size:0.8rem;" onclick={() => previewSelectAll(key, false)}>Keine</button>
          </div>
          {#each (t.policyNames || []) as name, i}
            <label class="ld-oib-row">
              <input type="checkbox" checked={!!previewSelected[key]?.[i]}
                     onchange={(e) => setPreviewChecked(key, i, e.target.checked)} />
              <span class="ld-oib-name">{name}</span>
            </label>
          {/each}
          <div class="ld-confirm-actions">
            <button class="btn btn-primary" onclick={() => deployTier(key)} disabled={deploying || previewSelectedCount(key) === 0}>
              {deploying ? '…' : `🚀 ${previewSelectedCount(key)} Policies ausrollen (Report-only)`}
            </button>
          </div>
        </div>
      {/if}
    {/each}
  {/if}

  {#if job}
    <div class="ld-job" style="margin-bottom:1.5rem;">
      <div class="ld-job-head"><strong>{job.status === 'running' ? '⏳' : ''} Conditional-Access-Deployment: {$activeTenant.name}</strong></div>
      {#if job.status === 'failed'}
        <div class="ld-banner fail">❌ {job.error}</div>
        {#if job.hint}<div class="ld-step"><small>💡 {job.hint}</small></div>{/if}
      {:else if job.status === 'done'}
        <div class="ld-banner ok">
          ✅ Fertig — {job.results?.created ?? 0} angelegt, {job.results?.updated ?? 0} aktualisiert{job.results?.failed ? `, ${job.results.failed} fehlgeschlagen` : ''}.
        </div>
      {/if}
      {#each job.steps as s}
        {#if s.state === 'running'}
          <div class="ld-step running"><span class="ld-spinner"></span> {s.name}</div>
        {:else if s.state === 'done'}
          <div class="ld-step ok"><span class="ld-ico">✅</span> {s.name}</div>
        {:else}
          <div class="ld-step pending"><span class="ld-ico">○</span> {s.name}</div>
        {/if}
      {/each}
    </div>
  {/if}

  {#if policiesLoading}
    <div class="ld-job"><div class="ld-step running"><span class="ld-spinner"></span> Lade Policies und Schutzgruppen…</div></div>
  {:else if policiesError}
    <div class="ld-banner fail">❌ {policiesError}</div>
  {:else if supportGroups.length}
    <div class="ld-job" style="margin-bottom:1.25rem;">
      <div class="ld-job-head"><strong>🛡 Schutzgruppen</strong></div>
      {#if breakGlassEmpty}
        <div class="ld-banner warn">⚠️ <b>AAD-CA-BreakGlass ist leer!</b> Trage mindestens ein Notfallzugriffskonto ein, bevor Policies aktiviert werden — sonst kann eine strengere Regel den einzigen Weg zurück in den Tenant blockieren.</div>
      {/if}
      {#each supportGroups as g}
        <div class="ld-step {g.memberCount === 0 && g.key === 'breakGlass' ? 'retry' : 'ok'}">
          <span class="ld-ico">{g.memberCount === 0 && g.key === 'breakGlass' ? '⚠️' : '✅'}</span>
          <code>{g.name}</code> <small>({g.memberCount} Mitglied{g.memberCount === 1 ? '' : 'er'})</small>
        </div>
        <div class="ld-oib-target" style="margin-top:0; margin-bottom:0.4rem;">
          <button class="btn btn-secondary" onclick={() => toggleMemberSearch(g.key)}>{memberSearchOpen[g.key] ? '✕ Schließen' : '+ Mitglied hinzufügen'}</button>
          {#if g.key === 'breakGlass'}
            <button class="btn btn-secondary" onclick={toggleBgForm}>{bgFormOpen ? '✕ Schließen' : '➕ Notfallzugriff anlegen'}</button>
          {/if}
        </div>
        {#if memberSearchOpen[g.key]}
          <div class="ld-oib-target">
            <input type="text" placeholder="Name oder E-Mail suchen (min. 2 Zeichen)…"
                   value={memberQuery[g.key] || ''} oninput={(e) => onMemberQueryInput(g.key, e.target.value)} style="min-width:280px;" />
            {#if memberSearchBusy[g.key]}<span class="ld-spinner"></span>{/if}
          </div>
          {#if (memberResults[g.key] || []).length}
            {#each memberResults[g.key] as u (u.id)}
              <div class="ld-oib-target" style="margin-top:0;">
                <span>👤 {u.displayName} <small style="color:var(--text-dim);">({u.userPrincipalName})</small></span>
                <button class="btn btn-secondary" onclick={() => addMember(g.key, u)} disabled={memberAddBusy[u.id]}>+ hinzufügen</button>
              </div>
            {/each}
          {:else if (memberQuery[g.key] || '').trim().length >= 2 && !memberSearchBusy[g.key]}
            <div class="ld-step pending"><small>Keine Treffer.</small></div>
          {/if}
        {/if}
        {#if g.key === 'breakGlass' && bgFormOpen}
          <div class="ld-oib-target">
            <input type="text" placeholder="z.B. breakglass1" bind:value={bgUsername} style="max-width:200px;" />
            <span><small>@{$activeTenant.organization || $activeTenant.tenantId}</small></span>
            <button class="btn btn-primary" onclick={createBreakGlass} disabled={bgBusy || !bgUsername.trim()}>{bgBusy ? '…' : 'Anlegen + Passwort generieren'}</button>
          </div>
          {#if bgError}<div class="ld-banner fail">❌ {bgError}</div>{/if}
        {/if}
      {/each}
    </div>
  {/if}

  {#if bgResult}
    <div class="ld-banner ok" style="display:flex; flex-direction:column; align-items:flex-start; gap:0.5rem;">
      <div>✅ Break-Glass-Konto <b>{bgResult.userPrincipalName}</b> angelegt und der Schutzgruppe zugewiesen.</div>
      <div>⚠️ <b>Dieses Passwort wird nur JETZT angezeigt</b> — Microsoft speichert es nicht im Klartext, ein späteres Auslesen ist nicht möglich. Jetzt sicher speichern (Passwort-Manager)!</div>
      <div style="display:flex; gap:0.6rem; align-items:center;">
        <code style="font-size:1rem; padding:0.3rem 0.6rem; border-radius:4px; background:var(--rule);">{bgResult.password}</code>
        <button class="btn btn-secondary" onclick={copyBgPassword}>📋 Kopieren</button>
      </div>
      <button class="btn btn-primary" onclick={ackBgResult}>Ich habe das Passwort sicher gespeichert</button>
    </div>
  {/if}

  {#if policies.length}
    <div class="ld-job">
      <div class="ld-job-head"><strong>📋 Ausgerollte Policies</strong>
        <span class="ld-job-meta">{policies.length} Policies</span></div>
      <div class="ld-step">
        <label><input type="checkbox" checked={allSelected} onchange={toggleAll} /> Alle auswählen</label>
      </div>
      {#if selectedIds.length}
        <div class="ld-oib-target">
          <b>{selectedIds.length} ausgewählt:</b>
          <select bind:value={batchScopeChoice}>
            <option value="">— Alle (kein Pilot) —</option>
            {#each groups as g (g.id)}<option value={g.id}>{g.displayName}</option>{/each}
          </select>
          <button class="btn btn-secondary" onclick={batchSetScope} disabled={batchBusy}>Scope für Auswahl setzen</button>
          <button class="btn btn-secondary" onclick={batchDeactivate} disabled={batchBusy}>⏸ Auswahl auf Report-only</button>
          <button class="btn btn-primary" onclick={batchActivate} disabled={batchBusy}>🔓 Auswahl aktivieren</button>
          <button class="btn btn-secondary" onclick={clearSelection} disabled={batchBusy}>Auswahl aufheben</button>
        </div>
        {#if batchProgress}
          <div class="ld-step running"><span class="ld-spinner"></span> {batchProgress.done}/{batchProgress.total} verarbeitet…</div>
        {/if}
      {/if}
      {#each policies as p (p.id)}
        {@const st = STATE_META[p.state] || { label: p.state, cls: '' }}
        <div class="ld-phase complete">
          <div class="ld-phase-title">
            <input type="checkbox" checked={!!selectedPolicies[p.id]}
                   onchange={(e) => (selectedPolicies = { ...selectedPolicies, [p.id]: e.target.checked })} />
            {p.displayName}
          </div>
          <div class="ld-step"><small>Scope: {p.scope} · <span class="tbadge {st.cls}">{st.label}</span></small></div>
          <div class="ld-oib-target">
            <select bind:value={pilotChoice[p.id]}>
              <option value="">— Alle (kein Pilot) —</option>
              {#each groups as g (g.id)}<option value={g.id}>{g.displayName}</option>{/each}
            </select>
            <button class="btn btn-secondary" onclick={() => applyScope(p)} disabled={actionBusy[p.id]}>Scope anwenden</button>
            {#if p.state === 'enabled'}
              <button class="btn btn-secondary" onclick={() => deactivate(p)} disabled={actionBusy[p.id]}>⏸ Auf Report-only zurück</button>
            {:else}
              <button class="btn btn-primary" onclick={() => activate(p)} disabled={actionBusy[p.id]}>🔓 Aktivieren</button>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</TenantContext>
