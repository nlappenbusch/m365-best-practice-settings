<script>
  import { onDestroy } from 'svelte'
  import { apiGet, apiPost } from '../lib/api.js'
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

  async function loadTiers() {
    tiersError = null
    try {
      const r = await apiGet('/api/conditionalaccess/tiers')
      tiers = r.tiers
    } catch (e) {
      tiersError = e.message
    }
  }
  loadTiers()

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

  async function deployTier(tierKey) {
    const meta = tiers[tierKey]
    if (!confirm(
      `Tier "${meta.label}" ausrollen (${meta.policyCount} Policies)?\n\n` +
      `Alle Policies werden ausschliesslich im Report-only-Zustand angelegt — ` +
      `NICHTS wird dadurch scharf geschaltet. Vier Schutzgruppen (Break-Glass, ` +
      `Sync-Konten, 2× Ausnahmen) werden dabei angelegt, falls noch nicht vorhanden.`
    )) return
    deploying = true
    job = null
    try {
      const r = await apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/conditionalaccess/deploy`, { tier: tierKey })
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

  onDestroy(() => { if (jobTimer) clearTimeout(jobTimer) })

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
            <button class="btn btn-primary" style="width:100%;" onclick={() => deployTier(key)} disabled={deploying}>
              {deploying ? '…' : '🚀 Ausrollen (Report-only)'}
            </button>
          </div>
        </div>
      {/each}
    </div>
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
      {/each}
    </div>
  {/if}

  {#if policies.length}
    <div class="ld-job">
      <div class="ld-job-head"><strong>📋 Ausgerollte Policies</strong>
        <span class="ld-job-meta">{policies.length} Policies</span></div>
      {#each policies as p (p.id)}
        {@const st = STATE_META[p.state] || { label: p.state, cls: '' }}
        <div class="ld-phase complete">
          <div class="ld-phase-title">{p.displayName}</div>
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
