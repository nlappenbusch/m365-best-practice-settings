<script>
  import { onDestroy } from 'svelte'
  import { apiGet, apiPost } from '../lib/api.js'
  import { session } from '../lib/session.js'
  import { activeTenant } from '../lib/tenantStore.js'
  import TenantContext from '../lib/TenantContext.svelte'

  // Die drei Lizenz-Tiers zuerst, danach alles Weitere in der Reihenfolge der
  // API — so erscheinen zusätzliche Zusammenstellungen automatisch, ohne dass
  // hier eine Liste nachgezogen werden muss.
  const BASE_TIER_ORDER = ['bareMinimum', 'aadp1', 'aadp1p2']
  const STATE_META = {
    enabledForReportingButNotEnforced: { label: '🟡 Report-only', cls: 'warn' },
    enabled: { label: '🟢 Aktiv', cls: 'ok' },
    disabled: { label: '⚪ Deaktiviert', cls: '' }
  }

  let tiers = $state(null)
  let tiersError = $state(null)
  const tierOrder = $derived(
    tiers
      ? [...BASE_TIER_ORDER.filter(k => tiers[k]), ...Object.keys(tiers).filter(k => !BASE_TIER_ORDER.includes(k))]
      : []
  )
  let previewOpen = $state({}) // tierKey -> bool
  let previewSelected = $state({}) // tierKey -> { index: bool }
  // Ring-Konzept (AlexFilipin): Ring-Name ersetzt <RING> im Policy-Namen;
  // "ring-getargetet" scoped "Alle Benutzer"-Policies auf AAD-CA-RING-<RING>.
  let ringChoice = $state({})   // tierKey -> 'PILOT'|'UAT'|'BROAD'|'CUSTOM'
  let ringCustom = $state({})   // tierKey -> freier Ring-Name
  let ringTargeted = $state({}) // tierKey -> bool

  function ringFor(tierKey) {
    const c = ringChoice[tierKey] || 'PILOT'
    const r = c === 'CUSTOM' ? String(ringCustom[tierKey] || '').trim().toUpperCase() : c
    return /^[A-Z0-9]{2,12}$/.test(r) ? r : null
  }
  function onRingChange(tierKey, value) {
    ringChoice = { ...ringChoice, [tierKey]: value }
    // Sinnvolle Vorbelegung: Test-Ringe getargetet, der breite Ring auf alle.
    if (value === 'BROAD') ringTargeted = { ...ringTargeted, [tierKey]: false }
    else if (value !== 'CUSTOM') ringTargeted = { ...ringTargeted, [tierKey]: true }
  }

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
    if (opening && !ringChoice[tierKey]) {
      ringChoice = { ...ringChoice, [tierKey]: 'PILOT' }
      ringTargeted = { ...ringTargeted, [tierKey]: true }
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
    const ring = ringFor(tierKey)
    if (!ring) { alert('Ungültiger Ring-Name (2–12 Zeichen, A-Z/0-9).'); return }
    const targeted = !!ringTargeted[tierKey]
    if (!confirm(
      `Tier "${meta.label}" als Ring "${ring}" ausrollen (${indices.length} von ${meta.policyCount} Policies)?\n\n` +
      (targeted
        ? `🎯 Ring-getargetet: Policies, die sonst "Alle Benutzer" treffen würden, gelten nur für Mitglieder der Gruppe AAD-CA-RING-${ring} (wird leer angelegt — danach Mitglieder pflegen!).\n\n`
        : `🌐 Nicht ring-getargetet: Policies mit "Alle Benutzer"-Ziel gelten für ALLE Benutzer (abzüglich Schutzgruppen-Ausnahmen).\n\n`) +
      `Alle Policies werden ausschliesslich im Report-only-Zustand angelegt — ` +
      `NICHTS wird dadurch scharf geschaltet. Vier Schutzgruppen (Break-Glass, ` +
      `Sync-Konten, 2× Ausnahmen) werden dabei angelegt, falls noch nicht vorhanden.`
    )) return
    deploying = true
    job = null
    previewOpen = { ...previewOpen, [tierKey]: false }
    try {
      const r = await apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/conditionalaccess/deploy`, { tier: tierKey, indices, ring, ringTargeted: targeted })
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
    // Groesstes Risiko im ganzen Tool: eine scharfgeschaltete Policy kann ohne
    // gefuelltes Notfallzugriffskonto den einzigen Weg zurueck in den Tenant
    // blockieren. Deshalb HIER nochmal explizit warnen (nicht nur die passive
    // Banner oben, die man beim schnellen Klicken uebersehen kann).
    if (breakGlassEmpty && !confirm(
      `🚨 AAD-CA-BreakGlass ist LEER!\n\n` +
      `Wenn diese Policy dich (oder einen Kollegen) versehentlich aussperrt, gibt es aktuell KEIN ` +
      `Notfallzugriffskonto, um wieder reinzukommen — die Aussperrung waere u.U. nur ueber Microsoft-Support behebbar.\n\n` +
      `Trotzdem OHNE Notfallzugriffskonto fortfahren?`
    )) return
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

  // Kleine Pause zwischen den sequentiellen Requests -- Graphs Rate-Limit fuer
  // Conditional-Access-Policy-Schreibvorgaenge (State/Scope/Delete) ist deutlich
  // strenger als bei den meisten anderen Ressourcen; ohne Pause laeuft man bei
  // "Alle Policies loeschen"/Batch-Aktionen leicht in ein 429 ("Too many
  // requests"). Server-seitig faengt graph.js ein einzelnes 429 zwar mit
  // Retry-After ab, aber das hier vermeidet den Retry im Regelfall gleich ganz.
  async function batchRun(label, fn) {
    const ids = selectedIds
    if (!ids.length) return
    batchBusy = true
    batchProgress = { done: 0, total: ids.length }
    for (const id of ids) {
      try { await fn(id) } catch (e) { /* einzelne Fehler nicht abbrechen -- am Ende neu laden zeigt den Ist-Stand */ }
      batchProgress = { done: batchProgress.done + 1, total: ids.length }
      if (batchProgress.done < ids.length) await new Promise(res => setTimeout(res, 400))
    }
    batchBusy = false
    batchProgress = null
    clearSelection()
    await loadPolicies()
  }

  async function batchActivate() {
    if (breakGlassEmpty && !confirm(
      `🚨 AAD-CA-BreakGlass ist LEER!\n\n` +
      `Wenn eine dieser Policies dich (oder einen Kollegen) versehentlich aussperrt, gibt es aktuell KEIN ` +
      `Notfallzugriffskonto, um wieder reinzukommen.\n\nTrotzdem OHNE Notfallzugriffskonto fortfahren?`
    )) return
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

  // Loeschen ist unumkehrbar -- anders als Aktivieren/Deaktivieren/Scope kann
  // hier auch eine AKTIVE oder eine Fremd-Policy (nicht vom Tool verwaltet)
  // getroffen werden. Das entfernt eine tatsaechlich wirksame Zugriffsregel,
  // nicht nur eine Report-only-Testpolicy -- deshalb dieselbe verschaerfte
  // Tipp-Bestaetigung wie beim Intune-Bulk-Delete fuer AAD-Gruppen.
  function policyDeleteConfirm(list) {
    const names = list.map(p => `  • ${p.displayName}`).join('\n')
    if (!confirm(`⚠️ ${list.length} Policy(s) UNWIDERRUFLICH löschen?\n\n${names}\n\nDas kann NICHT rückgängig gemacht werden.`)) return false
    const risky = list.filter(p => !p.managed || p.state === 'enabled')
    if (risky.length) {
      const typed = prompt(
        `Darunter sind ${risky.length} Policy(s), die entweder AKTIV geschaltet oder NICHT vom Tool verwaltet ` +
        `sind (Fremd-Policy) — das Löschen entfernt eine tatsächlich wirksame Zugriffsregel.\n\n` +
        `Zum Bestätigen "LÖSCHEN" eintippen:`
      )
      if (typed !== 'LÖSCHEN') return false
    }
    return true
  }

  async function deleteOne(p) {
    if (!policyDeleteConfirm([p])) return
    actionBusy = { ...actionBusy, [p.id]: true }
    try {
      await apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/conditionalaccess/policies/${encodeURIComponent(p.id)}/delete`, {})
      await loadPolicies()
    } catch (e) {
      alert('Fehler: ' + e.message)
    }
    actionBusy = { ...actionBusy, [p.id]: false }
  }

  async function batchDelete() {
    const sel = policies.filter(p => selectedPolicies[p.id])
    if (!sel.length) return
    if (!policyDeleteConfirm(sel)) return
    await batchRun('delete', id => apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/conditionalaccess/policies/${encodeURIComponent(id)}/delete`, {}))
  }

  function deleteAllPolicies() {
    if (!policies.length) return
    const upd = {}
    for (const p of policies) upd[p.id] = true
    selectedPolicies = upd
    batchDelete()
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

  // ---------- Aufbereitung der Policy-Liste ----------
  // 30 bis 53 Policies als flache Kartenliste sind nicht lesbar. Die Namen der
  // Vorlage folgen dem Schema "<Nr> - [PILOT -] <Kategorie> - <Rest>", daraus
  // entsteht die Gruppierung. Was nicht passt (fremde Policies), landet in
  // einer eigenen Gruppe statt stillschweigend durchzurutschen.
  const NAME_RE = /^\s*(\d+)\s*-\s*(?:PILOT\s*-\s*)?([^-]+?)\s*-\s*(.*)$/

  function splitName(name) {
    const m = NAME_RE.exec(String(name || ''))
    if (!m) return { number: null, category: 'Weitere Policies', rest: String(name || '') }
    return { number: m[1], category: m[2].trim(), rest: m[3].trim() }
  }

  let caFilter = $state('')
  let caStateFilter = $state('all')   // all | enabled | reportOnly | disabled
  let openCats = $state({})
  let expandedRow = $state({})

  const filteredPolicies = $derived(
    policies.filter(p => {
      if (caStateFilter === 'enabled' && p.state !== 'enabled') return false
      if (caStateFilter === 'reportOnly' && p.state !== 'enabledForReportingButNotEnforced') return false
      if (caStateFilter === 'disabled' && p.state !== 'disabled') return false
      const f = caFilter.trim().toLowerCase()
      if (!f) return true
      return (p.displayName + ' ' + (p.scope || '')).toLowerCase().includes(f)
    })
  )

  const categories = $derived.by(() => {
    const map = new Map()
    for (const p of filteredPolicies) {
      const parts = splitName(p.displayName)
      const key = p.managed ? parts.category : 'Nicht vom Tool angelegt'
      if (!map.has(key)) map.set(key, [])
      map.get(key).push({ ...p, _parts: parts })
    }
    return [...map.entries()]
      .map(([name, items]) => ({
        name,
        items: items.sort((a, b) => String(a._parts.number || '').localeCompare(String(b._parts.number || ''))),
        active: items.filter(i => i.state === 'enabled').length
      }))
      .sort((a, b) => {
        if (a.name === 'Nicht vom Tool angelegt') return 1
        if (b.name === 'Nicht vom Tool angelegt') return -1
        return String(a.items[0]?._parts.number || '').localeCompare(String(b.items[0]?._parts.number || ''))
      })
  })

  function toggleCat(name) { openCats[name] = !openCats[name] }
  function selectCategory(cat, on) {
    const next = { ...selectedPolicies }
    for (const p of cat.items) next[p.id] = on
    selectedPolicies = next
  }

  const managedCount = $derived(policies.filter(p => p.managed).length)
  const foreignCount = $derived(policies.length - managedCount)
  const activeCount = $derived(policies.filter(p => p.state === 'enabled').length)
</script>

<TenantContext>
  <div class="settings-group">
    <h4>Conditional Access</h4>
    <p class="ld-section-hint">Rollt eine der drei Best-Practice-Vorlagen aus <a href="https://github.com/AlexFilipin/ConditionalAccess" target="_blank">AlexFilipin/ConditionalAccess</a> aus.</p>
    <div class="alert alert-warning">
      ⚠️ <strong>Sicherheitshinweis:</strong> Jede Policy wird ausschliesslich im <b>Report-only-Zustand</b> angelegt — nichts
      wird automatisch scharf geschaltet. Aktivieren ist immer ein separater, bestätigter Schritt weiter unten.
      Ein falsch aktiviertes Conditional-Access-Regelwerk kann im schlimmsten Fall den gesamten Tenant aussperren.
    </div>
    <p class="ld-section-hint" style="margin-top:0.6rem;"><b>Ablauf:</b> <span class="step-n">1</span> Vorlage auswählen &amp; ausrollen (immer Report-only) → <span class="step-n">2</span> Schutzgruppen befüllen (v.&nbsp;a. Break-Glass!) → <span class="step-n">3</span> einzelne Policies gezielt scharf schalten, deren Scope einschränken oder aufräumen.</p>
  </div>

  {#if tiersError}
    <div class="ld-banner fail">{tiersError}</div>
  {:else if !tiers}
    <div class="ld-step running"><span class="ld-spinner"></span> Lade Tiers…</div>
  {:else}
    <h4 style="margin-bottom:0.5rem;"><span class="step-n">1</span> Vorlage auswählen &amp; ausrollen</h4>
    <div class="settings-grid" style="margin-bottom:1.5rem;">
      {#each tierOrder as key}
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

    {#each tierOrder as key}
      {@const t = tiers[key]}
      {#if previewOpen[key]}
        <div class="ld-job" style="margin-bottom:1.5rem;">
          <div class="ld-job-head"><strong>Vorschau: {t.label}</strong>
            <span class="ld-job-meta">{previewSelectedCount(key)}/{(t.policyNames || []).length} ausgewählt</span></div>
          <p class="ld-section-hint">Alle Policies werden trotzdem nur im Report-only-Zustand angelegt — die Auswahl hier bestimmt nur, WELCHE der Vorlagen-Policies überhaupt angelegt werden.</p>

          <div class="ld-oib-target">
            <label for="ring-{key}"><strong>Rollout-Ring:</strong></label>
            <select id="ring-{key}" value={ringChoice[key] || 'PILOT'} onchange={(e) => onRingChange(key, e.target.value)}>
              <option value="PILOT">PILOT — Testgruppe</option>
              <option value="UAT">UAT — erweiterter Test</option>
              <option value="BROAD">BROAD — alle Benutzer</option>
              <option value="CUSTOM">Eigener Ring-Name…</option>
            </select>
            {#if ringChoice[key] === 'CUSTOM'}
              <input type="text" placeholder="z.B. RING1" style="max-width:140px; text-transform:uppercase;"
                     value={ringCustom[key] || ''} oninput={(e) => (ringCustom = { ...ringCustom, [key]: e.target.value })} />
            {/if}
            <label style="display:flex; align-items:center; gap:0.35rem; cursor:pointer; font-size:0.84rem;">
              <input type="checkbox" checked={!!ringTargeted[key]}
                     onchange={(e) => (ringTargeted = { ...ringTargeted, [key]: e.target.checked })} />
              🎯 nur auf Ring-Gruppe <code>AAD-CA-RING-{ringFor(key) || '…'}</code> statt „Alle Benutzer"
            </label>
          </div>
          <p class="ld-section-hint">Der Ring-Name ersetzt <code>&lt;RING&gt;</code> im Policy-Namen — dasselbe Set kann so mehrfach nebeneinander existieren (z.B. erst PILOT ring-getargetet testen, später BROAD für alle ausrollen).</p>

          <div class="ld-oib-toolbar">
            <button class="btn btn-secondary" style="padding:0.25rem 0.7rem; font-size:0.8rem;" onclick={() => previewSelectAll(key, true)}>Alle</button>
            <button class="btn btn-secondary" style="padding:0.25rem 0.7rem; font-size:0.8rem;" onclick={() => previewSelectAll(key, false)}>Keine</button>
          </div>
          {#each (t.policyNames || []) as name, i}
            <label class="ld-oib-row">
              <input type="checkbox" checked={!!previewSelected[key]?.[i]}
                     onchange={(e) => setPreviewChecked(key, i, e.target.checked)} />
              <span class="ld-oib-name">{name.replace(/<RING>/g, ringFor(key) || '<RING>')}</span>
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
        <div class="ld-banner fail">{job.error}</div>
        {#if job.hint}<div class="ld-step"><small>💡 {job.hint}</small></div>{/if}
      {:else if job.status === 'done'}
        <div class="ld-banner ok">Fertig — {job.results?.created ?? 0} angelegt, {job.results?.updated ?? 0} aktualisiert{job.results?.failed ? `, ${job.results.failed} fehlgeschlagen` : ''}{job.results?.ring ? ` (Ring ${job.results.ring})` : ''}.
        </div>
        {#if job.results?.ringGroup}
          <div class="ld-banner warn">Ring-getargetet ausgerollt: Die Policies gelten nur für Mitglieder von <code>{job.results.ringGroup}</code> — unten bei den Schutzgruppen jetzt die Ring-Mitglieder pflegen, sonst wirkt der Ring auf niemanden.</div>
        {/if}
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
    <div class="ld-banner fail">{policiesError}</div>
  {:else if supportGroups.length}
    <div class="step-card" style="margin-bottom:1.25rem;">
      <h4><span class="step-n">2</span> Schutzgruppen befüllen
        <span class="step-state {breakGlassEmpty ? 'open' : 'done'}">{breakGlassEmpty ? 'Break-Glass leer' : '✓ Break-Glass gefüllt'}</span></h4>
      {#if breakGlassEmpty}
        <div class="ld-banner warn"><b>AAD-CA-BreakGlass ist leer!</b> Trage mindestens ein Notfallzugriffskonto ein, bevor Policies aktiviert werden — sonst kann eine strengere Regel den einzigen Weg zurück in den Tenant blockieren.</div>
      {/if}
      {#each supportGroups as g}
        {@const critical = g.memberCount === 0 && g.key === 'breakGlass'}
        <div class="obj-row">
          <code>{g.name}</code>
          <span class="tbadge {critical ? 'warn' : 'ok'}">{g.memberCount} Mitglied{g.memberCount === 1 ? '' : 'er'}</span>
          <span class="obj-actions">
            <button class="btn btn-secondary" onclick={() => toggleMemberSearch(g.key)}>{memberSearchOpen[g.key] ? 'Schliessen' : '+ Mitglied'}</button>
            {#if g.key === 'breakGlass'}
              <button class="btn btn-secondary" onclick={toggleBgForm}>{bgFormOpen ? 'Schliessen' : 'Notfallzugriff anlegen'}</button>
            {/if}
          </span>
        </div>
        {#if memberSearchOpen[g.key]}
          <div class="obj-sub">
            <div style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap">
              <input type="text" placeholder="Name oder E-Mail suchen (min. 2 Zeichen)…"
                     value={memberQuery[g.key] || ''} oninput={(e) => onMemberQueryInput(g.key, e.target.value)} style="min-width:280px;" />
              {#if memberSearchBusy[g.key]}<span class="ld-spinner"></span>{/if}
            </div>
            {#if (memberResults[g.key] || []).length}
              {#each memberResults[g.key] as u (u.id)}
                <div class="obj-row" style="border-bottom:none; padding:0.3rem 0;">
                  <span>{u.displayName} <small style="color:var(--text-dim);">({u.userPrincipalName})</small></span>
                  <span class="obj-actions"><button class="btn btn-secondary" onclick={() => addMember(g.key, u)} disabled={memberAddBusy[u.id]}>+ hinzufügen</button></span>
                </div>
              {/each}
            {:else if (memberQuery[g.key] || '').trim().length >= 2 && !memberSearchBusy[g.key]}
              <small class="ld-section-hint">Keine Treffer.</small>
            {/if}
          </div>
        {/if}
        {#if g.key === 'breakGlass' && bgFormOpen}
          <div class="obj-sub">
            <div style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap">
              <input type="text" placeholder="z.B. breakglass1" bind:value={bgUsername} style="max-width:200px;" />
              <span><small>@{$activeTenant.organization || $activeTenant.tenantId}</small></span>
              <button class="btn btn-primary" onclick={createBreakGlass} disabled={bgBusy || !bgUsername.trim()}>{bgBusy ? '…' : 'Anlegen + Passwort generieren'}</button>
            </div>
            {#if bgError}<div class="ld-banner fail" style="margin-top:0.4rem">{bgError}</div>{/if}
          </div>
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
        <button class="btn btn-secondary" onclick={copyBgPassword}>Kopieren</button>
      </div>
      <button class="btn btn-primary" onclick={ackBgResult}>Ich habe das Passwort sicher gespeichert</button>
    </div>
  {/if}

  {#if policies.length}
    <h4 style="margin-bottom:0.5rem;"><span class="step-n">3</span> Policies verwalten</h4>
    <div class="ld-job">
      <div class="ld-job-head"><strong>Alle Conditional-Access-Policies dieses Tenants</strong>
        <span class="ld-job-meta">{policies.length} gesamt · {managedCount} vom Tool · {foreignCount} fremd · {activeCount} aktiv</span></div>
      {#if foreignCount}
        <p class="ld-section-hint">🌐 <b>Fremd</b> = nicht vom Tool angelegt (z.&nbsp;B. manuell im Portal oder von einem anderen Werkzeug) — wird beim Deploy/Aktivieren nie automatisch angefasst, kann hier aber wie jede andere Policy verwaltet oder gelöscht werden.</p>
      {/if}
      <div class="ld-step" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem;">
        <label><input type="checkbox" checked={allSelected} onchange={toggleAll} /> Alle auswählen</label>
        <button class="btn btn-secondary" style="padding:0.25rem 0.7rem; font-size:0.8rem;" onclick={deleteAllPolicies} disabled={batchBusy}>Alle {policies.length} Policies löschen</button>
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
          <button class="btn btn-primary" onclick={batchActivate} disabled={batchBusy}
                  title={breakGlassEmpty ? 'Achtung: AAD-CA-BreakGlass ist leer — kein Notfallzugriff vorhanden!' : ''}>
            {breakGlassEmpty ? '🚨' : '🔓'} Auswahl aktivieren
          </button>
          <button class="btn btn-secondary" onclick={batchDelete} disabled={batchBusy}>Auswahl löschen</button>
          <button class="btn btn-secondary" onclick={clearSelection} disabled={batchBusy}>Auswahl aufheben</button>
        </div>
        {#if batchProgress}
          <div class="ld-step running"><span class="ld-spinner"></span> {batchProgress.done}/{batchProgress.total} verarbeitet…</div>
        {/if}
      {/if}
      <!-- Filter: bei 30 bis 53 Policies der schnellste Weg zur gesuchten -->
      <div class="ca-filterbar">
        <input type="text" bind:value={caFilter} placeholder="Name oder Scope filtern…" />
        <select bind:value={caStateFilter}>
          <option value="all">Alle Zustände</option>
          <option value="enabled">Nur aktive</option>
          <option value="reportOnly">Nur Report-only</option>
          <option value="disabled">Nur deaktivierte</option>
        </select>
        <span class="ld-section-hint" style="margin:0">{filteredPolicies.length} von {policies.length}</span>
      </div>

      {#each categories as cat (cat.name)}
        <div class="ca-cat">
          <button class="ca-cat-head" onclick={() => toggleCat(cat.name)}>
            <span class="ca-cat-chevron">{openCats[cat.name] === false ? '▸' : '▾'}</span>
            <strong>{cat.name}</strong>
            <span class="ca-cat-meta">{cat.items.length} Policies{cat.active ? ` · ${cat.active} aktiv` : ''}</span>
          </button>

          {#if openCats[cat.name] !== false}
            <div class="ca-cat-actions">
              <button class="linklike" onclick={() => selectCategory(cat, true)}>alle wählen</button>
              <button class="linklike" onclick={() => selectCategory(cat, false)}>Auswahl aufheben</button>
            </div>
            <table class="ca-table">
              <tbody>
                {#each cat.items as p (p.id)}
                  {@const st = STATE_META[p.state] || { label: p.state, cls: '' }}
                  <tr class:ca-active={p.state === 'enabled'}>
                    <td class="ca-c-check">
                      <input type="checkbox" checked={!!selectedPolicies[p.id]}
                             onchange={(e) => (selectedPolicies = { ...selectedPolicies, [p.id]: e.target.checked })} />
                    </td>
                    <td class="ca-c-num">{p._parts.number || ''}</td>
                    <td class="ca-c-name">
                      <button class="ca-name" onclick={() => (expandedRow[p.id] = !expandedRow[p.id])} title="Details und Scope ändern">
                        {p._parts.rest || p.displayName}
                      </button>
                      {#if !p.managed}<span class="tbadge warn">fremd</span>{/if}
                      {#if expandedRow[p.id]}
                        <div class="ca-details">
                          <div class="ca-full">{p.displayName}</div>
                          <div class="ld-oib-target" style="margin-top:0.4rem">
                            <select bind:value={pilotChoice[p.id]}>
                              <option value="">— Alle (kein Pilot) —</option>
                              {#each groups as g (g.id)}<option value={g.id}>{g.displayName}</option>{/each}
                            </select>
                            <button class="btn btn-secondary" onclick={() => applyScope(p)} disabled={actionBusy[p.id]}>Scope anwenden</button>
                          </div>
                        </div>
                      {/if}
                    </td>
                    <td class="ca-c-scope"><small>{p.scope}</small></td>
                    <td class="ca-c-state"><span class="tbadge {st.cls}">{st.label}</span></td>
                    <td class="ca-c-act">
                      {#if p.state === 'enabled'}
                        <button class="ca-btn" onclick={() => deactivate(p)} disabled={actionBusy[p.id]}
                                title="Auf Report-only zurücknehmen">⏸</button>
                      {:else}
                        <button class="ca-btn ca-btn-go" onclick={() => activate(p)} disabled={actionBusy[p.id]}
                                title={breakGlassEmpty ? 'Achtung: AAD-CA-BreakGlass ist leer — kein Notfallzugriff!' : 'Scharf schalten'}>
                          {breakGlassEmpty ? '🚨' : '▶'}
                        </button>
                      {/if}
                      <button class="ca-btn ca-btn-del" onclick={() => deleteOne(p)} disabled={actionBusy[p.id]}
                              title="Unwiderruflich löschen">✕</button>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</TenantContext>
