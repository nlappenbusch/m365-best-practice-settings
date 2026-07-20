<script>
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

  let loading = $state(false)
  let loadError = $state(null)
  let data = $state(null)          // { groups, policies, intentsError }
  let selectedGroupId = $state('')
  let checked = $state({})         // policyId -> bool
  let assigning = $state(false)
  let assignResult = $state(null)  // { error } | { results, gname }
  let lastTenantId = null

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

  function selectAll() {
    const next = {}
    for (const p of data.policies) if (!alreadyInSelected(p)) next[p.id] = true
    checked = next
  }
  function selectNone() { checked = {} }
  function selectTypeAll(type) {
    const next = { ...checked }
    for (const p of data.policies) if (p.type === type && !alreadyInSelected(p)) next[p.id] = true
    checked = next
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
</script>

<TenantContext>
  <div class="settings-group">
    <h4>💻 Intune-Baseline <small>(OpenIntuneBaseline)</small></h4>
    <p class="ld-section-hint">„Win - OIB"-Policies anzeigen und dynamischen Security-Gruppen zuweisen.</p>
    <button class="btn btn-secondary" onclick={load} disabled={loading}>{loading ? '…' : '🔄 Neu laden'}</button>
  </div>

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
              <label class="ld-oib-row" class:already class:breakrisk={!!risk}>
                <input type="checkbox" checked={!!checked[p.id]} disabled={already}
                       onchange={(e) => (checked = { ...checked, [p.id]: e.target.checked })} />
                <span class="ld-oib-name">{p.name}</span>
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
