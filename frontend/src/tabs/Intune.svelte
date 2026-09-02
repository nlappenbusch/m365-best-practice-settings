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
  // Diese Policies werden bei "Alle auswaehlen" bewusst NICHT mitgenommen —
  // wer sie ausrollt, soll das einzeln und mit Absicht tun.
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

  // Drittanbieter-AV: Bei unseren Kunden laeuft grundsaetzlich Bitdefender.
  // Die Defender-Antivirus-Policies der Baseline (AV Configuration, Security
  // Experience, die drei Update-Ringe) kollidieren damit oder laufen ins Leere,
  // sobald Defender in den passiven Modus faellt. Sie werden deshalb behandelt
  // wie eine veraltete Version: markiert und bei "Alle auswaehlen" bewusst NICHT
  // mitgenommen. Wer sie fuer einen Defender-Kunden braucht, hakt sie einzeln an.
  // Absichtlich eng gefasst: Firewall, ASR und SmartScreen sind eigene
  // Entscheidungen und bleiben in der Sammelauswahl drin.
  const THIRD_PARTY_AV = /defender antivirus/i
  function avConflict(name) {
    return THIRD_PARTY_AV.test(String(name || '')) ? 'Defender-Antivirus-Policy — bei uns läuft Bitdefender' : null
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

  // ---------- Intune-Backup & -Restore (TenuVault-Idee) ----------
  let bkOpen = $state(false)
  let bkList = $state(null)          // { backups, categories }
  let bkLoading = $state(false)
  let bkError = $state(null)
  let bkJob = $state(null)
  let bkJobId = $state(null)
  let bkBusy = $state(false)
  let bkTimer = null
  let bkRestoreOpen = $state(null)   // backupId des geoeffneten Restore-Pickers
  let bkItems = $state(null)         // { items: { cat: [names] } }
  let bkChecked = $state({})         // 'cat:index' -> bool
  const bkCatLabel = $derived(new Map((bkList?.categories || []).map(c => [c.key, c.label])))

  async function toggleBackup() {
    bkOpen = !bkOpen
    if (bkOpen && !bkList) await loadBackups()
  }
  async function loadBackups() {
    bkLoading = true
    bkError = null
    try { bkList = await apiGet(`/api/tenants/${encodeURIComponent($activeTenant.id)}/intunebackup`) }
    catch (e) { bkError = e.message }
    bkLoading = false
  }
  async function startBackup() {
    bkBusy = true
    bkJob = null
    try {
      const r = await apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/intunebackup`, {})
      bkJobId = r.jobId
      pollBackupJob()
    } catch (e) { alert('Start fehlgeschlagen: ' + e.message); bkBusy = false }
  }
  function pollBackupJob() {
    bkTimer = setTimeout(async () => {
      let j
      try { j = await apiGet(`/api/appjobs/${encodeURIComponent(bkJobId)}`) }
      catch (e) { bkBusy = false; return }
      bkJob = j
      if (j.status === 'running') { pollBackupJob(); return }
      bkBusy = false
      loadBackups()
    }, 1000)
  }
  async function openRestore(backupId) {
    if (bkRestoreOpen === backupId) { bkRestoreOpen = null; return }
    bkRestoreOpen = backupId
    bkItems = null
    bkChecked = {}
    try { bkItems = await apiGet(`/api/tenants/${encodeURIComponent($activeTenant.id)}/intunebackup/${encodeURIComponent(backupId)}`) }
    catch (e) { bkError = e.message; bkRestoreOpen = null }
  }
  const bkSelCount = $derived(Object.values(bkChecked).filter(Boolean).length)
  async function startRestore() {
    const items = []
    for (const [k, v] of Object.entries(bkChecked)) {
      if (!v) continue
      const [category, idx] = k.split('::')
      items.push({ category, index: Number(idx) })
    }
    if (!items.length) { alert('Nichts ausgewählt.'); return }
    if (!confirm(`${items.length} Objekt(e) wiederherstellen?\n\nEs werden ausschliesslich NEUE Objekte mit dem Präfix „[Restored]" und OHNE Zuweisungen angelegt — bestehende Konfiguration wird nie verändert.`)) return
    bkBusy = true
    bkJob = null
    try {
      const r = await apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/intunebackup/${encodeURIComponent(bkRestoreOpen)}/restore`, { items })
      bkJobId = r.jobId
      bkRestoreOpen = null
      pollBackupJob()
    } catch (e) { alert('Start fehlgeschlagen: ' + e.message); bkBusy = false }
  }
  function downloadBackup(backupId) {
    window.open(`/api/tenants/${encodeURIComponent($activeTenant.id)}/intunebackup/${encodeURIComponent(backupId)}/download`, '_blank')
  }

  // Drift-Vergleich (TenuVault-Idee): zwei Snapshots auf Namensebene vergleichen
  let cmpA = $state('')
  let cmpB = $state('')
  let cmpResult = $state(null)
  let cmpBusy = $state(false)
  async function runCompare() {
    if (!cmpA || !cmpB || cmpA === cmpB) { alert('Zwei verschiedene Snapshots wählen.'); return }
    cmpBusy = true
    cmpResult = null
    try {
      cmpResult = await apiGet(`/api/tenants/${encodeURIComponent($activeTenant.id)}/intunebackup/${encodeURIComponent(cmpA)}/compare/${encodeURIComponent(cmpB)}`)
    } catch (e) { alert('❌ ' + e.message) }
    cmpBusy = false
  }

  // ---------- Assignment-Check (read-only Zuweisungs-Audit) ----------
  let checkOpen = $state(false)
  let checkLoading = $state(false)
  let checkError = $state(null)
  let checkData = $state(null)       // { summary, results }
  let checkOnlyIssues = $state(true)

  // Befundarten: Farbe statt Emoji. "broadAll" ist neutral -- eine breite
  // Zuweisung ist eine bewusste Entscheidung, kein Fehler.
  const ISSUE_META = {
    unassigned:   { label: 'Ohne Zuweisung', tone: 'warn', hint: 'Policy/App ist niemandem zugewiesen — wirkt nirgends.' },
    emptyGroup:   { label: 'Leere Gruppe', tone: 'warn', hint: 'Zuweisung zeigt auf eine Gruppe mit 0 Mitgliedern.' },
    missingGroup: { label: 'Gruppe fehlt', tone: 'crit', hint: 'Zugewiesene Gruppe existiert nicht mehr (gelöscht).' },
    broadAll:     { label: 'Alle Benutzer/Geräte', tone: 'info', hint: 'Breite Zuweisung — bewusst prüfen, kein Fehler per se.' }
  }

  $effect(() => {
    const id = $activeTenant?.id ?? null
    if (id !== lastTenantId) {
      lastTenantId = id
      data = null
      loadError = null
      assignResult = null
      checked = {}
      devSettings = null
      devError = null
      devNotice = null
      m365 = null
      form = null
      m365Result = null
      m365Error = null
      if (id) { load(); loadDevSettings(); loadM365() }
    }
  })

  // ---------- Entra-Geraeteeinstellungen: LAPS ----------
  // Der Schalter aus Entra ID > Geraete > Geraeteeinstellungen. Ohne ihn sichert
  // Windows LAPS das lokale Administratorkennwort nicht nach Entra — die
  // Intune-Policy allein reicht nicht.
  let devSettings = $state(null)
  let devLoading = $state(false)
  let devBusy = $state(false)
  let devError = $state(null)
  let devNotice = $state(null)

  async function loadDevSettings() {
    if (!$activeTenant) return
    devLoading = true
    devError = null
    try {
      const r = await apiGet(`/api/tenants/${encodeURIComponent($activeTenant.id)}/entra/devicesettings`)
      devSettings = r.settings
    } catch (e) {
      devError = e.message
    }
    devLoading = false
  }

  async function toggleLaps() {
    if (!devSettings) return
    const want = !devSettings.lapsEnabled
    const s = devSettings
    const mfa = s.multiFactorAuthConfiguration === 'required' ? 'erforderlich' : 'nicht erforderlich'
    if (!confirm(`${want ? 'LAPS im Tenant EINSCHALTEN?' : 'LAPS im Tenant AUSSCHALTEN?'}

Tenant: ${$activeTenant.name}
Entra ID > Geräte > Geräteeinstellungen, Schalter „Lokale Administratorkennwortlösung (LAPS)".

Microsoft kann diese Seite nur komplett schreiben. Alle übrigen Werte gehen unverändert zurück:
Gerätekontingent ${s.userDeviceQuota}, MFA ${mfa}, Beitritt erlaubt für ${s.joinAllowed}.${want ? '' : `

Aus heisst: bereits gesicherte Kennwörter bleiben in Entra, neue werden nicht mehr hinterlegt.`}`)) return
    devBusy = true
    devError = null
    devNotice = null
    try {
      const r = await apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/entra/devicesettings/laps`, { enabled: want })
      devNotice = r.changed
        ? (want ? '✅ LAPS ist jetzt aktiviert.' : 'LAPS ist jetzt deaktiviert.')
        : 'Stand war schon so — nichts geschrieben.'
      await loadDevSettings()
    } catch (e) {
      devError = e.message
    }
    devBusy = false
  }

  // ---------- Microsoft 365 Apps (Office) ----------
  // Legt die Office-Suite als Intune-App an und weist sie ueber eine
  // App-Zielgruppe den dynamischen Geraetegruppen zu — derselbe Weg wie bei
  // den Agent-Apps, damit die Zuordnung an einer Stelle nachvollziehbar bleibt.
  let m365 = $state(null)
  let m365Loading = $state(false)
  let m365Busy = $state(false)
  let m365Error = $state(null)
  let m365Result = $state(null)
  let m365FormOpen = $state(false)
  let form = $state(null)

  async function loadM365() {
    if (!$activeTenant) return
    m365Loading = true
    m365Error = null
    try {
      m365 = await apiGet(`/api/tenants/${encodeURIComponent($activeTenant.id)}/m365apps`)
      if (!form) resetForm()
    } catch (e) {
      m365Error = e.message
    }
    m365Loading = false
  }

  function resetForm() {
    const d = m365?.defaults
    if (!d) return
    form = { ...d, apps: [...d.apps], locales: d.locales.join(', '), targetVersion: '', groupTags: [] }
  }

  function toggleIn(list, value) {
    return list.includes(value) ? list.filter(x => x !== value) : [...list, value]
  }

  const m365Payload = $derived(form ? {
    ...form,
    locales: String(form.locales || '').split(/[,;\s]+/).filter(Boolean)
  } : null)

  async function deployM365() {
    if (!form) return
    const p = m365Payload
    const groupNames = (m365.groups || []).filter(g => form.groupTags.includes(g.groupTag)).map(g => g.groupName)
    if (!groupNames.length) { alert('Mindestens eine Zielgruppe auswählen.'); return }
    const appLabels = (m365.catalog || []).filter(a => form.apps.includes(a.key)).map(a => a.label)
    const kanal = (m365.channels.find(c => c.value === form.updateChannel) || {}).label
    if (!confirm(`Microsoft 365 Apps in ${$activeTenant.name} anlegen?

App-Suite: ${form.displayName}
Installiert wird: ${appLabels.join(', ') || '—'}
${form.architecture} · ${kanal}
Sprachen: ${p.locales.join(', ')}
Andere Office-Versionen entfernen: ${form.removeOtherVersions ? 'ja' : 'nein'}
Gemeinsam genutzter PC: ${form.sharedComputerActivation ? 'ja' : 'nein'}

Zuweisung (${form.intent === 'available' ? 'verfügbar' : 'erforderlich'}) an:
${groupNames.map(n => '• ' + n).join('\n')}

Die App hängt an einer App-Zielgruppe, die dynamischen Gruppen werden dort Mitglied.`)) return
    m365Busy = true
    m365Error = null
    m365Result = null
    try {
      const r = await apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/m365apps/deploy`, p)
      m365Result = r
      m365FormOpen = false
      await loadM365()
    } catch (e) {
      m365Error = e.message
    }
    m365Busy = false
  }

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
    for (const p of data.policies) if (!alreadyInSelected(p) && !outdatedInfo(p) && !avConflict(p.name) && !breakRiskFor(p.name)) next[p.id] = true
    checked = next
  }
  function selectNone() { checked = {} }
  function selectTypeAll(type) {
    const next = { ...checked }
    for (const p of data.policies) if (p.type === type && !alreadyInSelected(p) && !outdatedInfo(p) && !avConflict(p.name) && !breakRiskFor(p.name)) next[p.id] = true
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
    const avHits = selectedPolicies.filter(p => avConflict(p.name))
    if (avHits.length) {
      const avLines = avHits.map(p => `• ${p.name}`).join('\n')
      if (!confirm(`🛡️ ${avHits.length} ausgewählte Policy/Policies konfigurieren Microsoft Defender Antivirus:\n\n${avLines}\n\nBei Bitdefender-Kunden gehört das normalerweise NICHT ausgerollt — Defender läuft dort passiv, die Policy greift nicht oder stört.\n\nTrotzdem der Gruppe "${gname}" zuweisen?`)) return
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

  // ---------- Bulk-Loeschung (Andrew-Taylor-Cleanup-Skript-Portierung) ----------
  let bdOpen = $state(false)
  let bdLoading = $state(false)
  let bdError = $state(null)
  let bdObjects = $state([])   // [{id, name, description, type, riskier}]
  let bdFetchErrors = $state([]) // [{type, error}] -- einzelne Typen, die nicht geladen werden konnten
  let bdChecked = $state({})   // id -> bool
  let bdBusy = $state(false)
  let bdResults = $state(null) // [{id, type, name, ok, error}] nach dem Loeschen
  let bdLogOpen = $state(false)
  let bdLog = $state([])

  async function toggleBulkDelete() {
    bdOpen = !bdOpen
    if (bdOpen && !bdObjects.length) await loadBulkDeleteObjects()
  }
  async function loadBulkDeleteObjects() {
    bdLoading = true
    bdError = null
    bdResults = null
    try {
      const r = await apiGet(`/api/tenants/${encodeURIComponent($activeTenant.id)}/intune-bulk-delete/objects`)
      bdObjects = r.objects || []
      bdFetchErrors = r.errors || []
      bdChecked = {}
    } catch (e) {
      bdError = e.message
    }
    bdLoading = false
  }
  const bdByType = $derived(
    Object.values(
      bdObjects.reduce((acc, o) => {
        (acc[o.type] = acc[o.type] || { type: o.type, riskier: o.riskier, items: [] }).items.push(o)
        return acc
      }, {})
    )
  )
  const bdSelectedIds = $derived(Object.keys(bdChecked).filter(id => bdChecked[id]))
  const bdSelectedObjects = $derived(bdObjects.filter(o => bdChecked[o.id]))
  function bdToggleTypeAll(type, val) {
    const next = { ...bdChecked }
    bdObjects.filter(o => o.type === type).forEach(o => (next[o.id] = val))
    bdChecked = next
  }
  function bdClearSelection() { bdChecked = {} }

  async function runBulkDelete() {
    const sel = bdSelectedObjects
    if (!sel.length) return
    const breakdown = bdByType
      .map(g => ({ type: g.type, count: g.items.filter(o => bdChecked[o.id]).length }))
      .filter(g => g.count > 0)
      .map(g => `  • ${g.count}x ${g.type}`)
      .join('\n')
    if (!confirm(`⚠️ ${sel.length} Objekt(e) UNWIDERRUFLICH löschen?\n\n${breakdown}\n\nZuweisungen werden mit gelöscht (Graph entfernt sie automatisch beim Löschen des Objekts). Das kann NICHT rückgängig gemacht werden.`)) return
    if (sel.some(o => o.riskier)) {
      const typed = prompt(`Darunter sind ${sel.filter(o => o.riskier).length} AAD-Gruppe(n) — das kann Lizenzen/Berechtigungen/Policy-Scopes für viele Nutzer gleichzeitig kappen.\n\nZum Bestätigen "LÖSCHEN" eintippen:`)
      if (typed !== 'LÖSCHEN') return
    }
    bdBusy = true
    bdResults = null
    try {
      const r = await apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/intune-bulk-delete`, {
        items: sel.map(o => ({ id: o.id, type: o.type, name: o.name }))
      })
      bdResults = r.results || []
      bdClearSelection()
      await loadBulkDeleteObjects()
    } catch (e) {
      bdError = e.message
    }
    bdBusy = false
  }

  async function toggleBulkDeleteLog() {
    bdLogOpen = !bdLogOpen
    if (bdLogOpen) {
      try {
        const r = await apiGet(`/api/tenants/${encodeURIComponent($activeTenant.id)}/intune-bulk-delete/log?limit=100`)
        bdLog = r.log || []
      } catch (e) { /* egal */ }
    }
  }

  onDestroy(() => { if (importTimer) clearTimeout(importTimer); if (bkTimer) clearTimeout(bkTimer) })
</script>

<TenantContext>
  <div class="settings-group">
    <h4>Entra-Geräteeinstellungen
      <button class="btn btn-secondary" style="margin-left:auto; padding:0.15rem 0.55rem; font-size:0.75rem; font-weight:500;"
              onclick={loadDevSettings} disabled={devLoading || devBusy} title="Ist-Stand neu lesen">↻</button>
    </h4>

    {#if devLoading && !devSettings}
      <div class="ld-step running"><span class="ld-spinner"></span> Lese Geräteeinstellungen…</div>
    {:else if devError}
      <div class="alert alert-warning">❌ {devError}
        {#if /Policy.ReadWrite.DeviceConfiguration/i.test(devError)}
          <br /><small>Diese Berechtigung ist neu — im Tab „Tenants" einmal 🔧 Reparieren ausführen.</small>
        {/if}
      </div>
    {:else if devSettings}
      {#if devNotice}<div class="ld-banner ok">{devNotice}</div>{/if}

      <div class="ld-banner {devSettings.lapsEnabled ? 'ok' : 'warn'}"
           style="display:flex; gap:1rem; align-items:center; justify-content:space-between; flex-wrap:wrap;">
        <div style="flex:1 1 22rem;">
          <b>Lokale Administratorkennwörter (LAPS): {devSettings.lapsEnabled ? 'werden in Entra hinterlegt' : 'werden nicht hinterlegt'}</b>
          <div><small>
            {#if devSettings.lapsEnabled}
              Jedes Gerät bekommt ein eigenes, zufälliges Administratorkennwort, das Entra für dich aufbewahrt.
              Nachschauen: Entra ID → Geräte → das Gerät → „Lokale Administratorkennwörter".
            {:else}
              Entra nimmt keine Kennwörter entgegen. Eine LAPS-Policy in Intune läuft damit ins Leere — ohne Fehlermeldung,
              und im Notfall gibt es kein Kennwort zum Nachschlagen.
            {/if}
          </small></div>
        </div>
        <button class="btn {devSettings.lapsEnabled ? 'btn-secondary' : 'btn-primary'}" onclick={toggleLaps} disabled={devBusy}>
          {devBusy ? '…' : (devSettings.lapsEnabled ? 'Ausschalten' : 'Einschalten')}
        </button>
      </div>

      <p class="ld-section-hint">
        {#if devSettings.lapsEnabled}
          ✓ Voraussetzung erfüllt. Erzeugt und rotiert werden die Kennwörter von der <b>LAPS-Policy in Intune</b> —
          ohne die passiert trotz Schalter nichts.
        {:else}
          Der Schalter sitzt in <b>Entra ID → Geräte → Geräteeinstellungen</b>. Er ist nur die Erlaubnis; die eigentliche
          Konfiguration macht danach die <b>LAPS-Policy in Intune</b>.
        {/if}
      </p>

      <details class="ld-step">
        <summary><small>Was beim Umschalten sonst noch mitgeschrieben wird</small></summary>
        <p class="ld-section-hint" style="margin-top:0.4rem;">Microsoft kann diese Seite nur als Ganzes speichern. Das Tool liest
          deshalb zuerst den Ist-Stand und schickt diese Werte <b>unverändert</b> zurück:</p>
        <table class="gt-table" style="margin-top:0.3rem;">
          <tbody>
            <tr><td>Geräte je Benutzer (Kontingent)</td><td><b>{devSettings.userDeviceQuota}</b></td></tr>
            <tr><td>MFA beim Registrieren eines Geräts</td><td><b>{devSettings.multiFactorAuthConfiguration === 'required' ? 'erforderlich' : 'nicht erforderlich'}</b></td></tr>
            <tr><td>Entra-Beitritt erlaubt für</td><td><b>{devSettings.joinAllowed}</b></td></tr>
            <tr><td>Geräteregistrierung erlaubt für</td><td><b>{devSettings.registerAllowed}</b></td></tr>
            <tr><td>Lokale Admins auf neuen Geräten</td><td><b>Globale Administratoren: {devSettings.localAdminsGlobalAdmins ? 'ja' : 'nein'}</b> · registrierender Benutzer: <b>{devSettings.localAdminsRegisteringUsers}</b></td></tr>
          </tbody>
        </table>
      </details>
    {/if}
  </div>

  <div class="settings-group">
    <h4>Microsoft 365 Apps <small>(Office)</small>
      <button class="btn btn-secondary" style="margin-left:auto; padding:0.15rem 0.55rem; font-size:0.75rem; font-weight:500;"
              onclick={loadM365} disabled={m365Loading || m365Busy} title="Neu laden">↻</button>
    </h4>
    <p class="ld-section-hint">Legt die Office-Suite als Intune-App an (Portal: Apps → Windows → Microsoft 365 Apps) und weist sie
      über eine App-Zielgruppe deinen dynamischen Gerätegruppen zu — derselbe Weg wie bei den Agent-Apps.</p>

    {#if m365Loading && !m365}
      <div class="ld-step running"><span class="ld-spinner"></span> Lese vorhandene App-Suiten…</div>
    {:else if m365Error && !m365}
      <div class="alert alert-warning">❌ {m365Error}</div>
    {:else if m365}
      {#if m365Result}
        <div class="ld-banner ok"><b>{m365Result.appName} angelegt.</b>
          Zielgruppe <code>{m365Result.appGroup}</code>{m365Result.appGroupCreated ? ' (neu erstellt)' : ''},
          zugewiesen als <b>{m365Result.intent === 'available' ? 'verfügbar' : 'erforderlich'}</b> an:
          {m365Result.groups.join(', ')}.
        </div>
      {/if}
      {#if m365Error}<div class="alert alert-warning">❌ {m365Error}</div>{/if}

      {#if m365.suites.length}
        <div class="gt-table-wrap">
          <table class="gt-table">
            <thead><tr><th>App-Suite</th><th>Ausstattung</th><th>Zugewiesen an</th></tr></thead>
            <tbody>
              {#each m365.suites as s (s.id)}
                <tr>
                  <td><strong>{s.displayName}</strong><br /><small style="color:var(--text-dim);">{s.includedApps.join(', ') || '—'}</small></td>
                  <td><small>{s.architecture} · {s.updateChannelLabel}<br />
                    {s.locales.join(', ')}{s.targetVersion ? ' · feste Version ' + s.targetVersion : ''}
                    {#if s.sharedComputerActivation}<br /><span class="tbadge warn">gemeinsam genutzter PC</span>{/if}</small></td>
                  <td><small>{s.assignments.length
                    ? s.assignments.map(a => a.groupName + ' (' + (a.intent === 'available' ? 'verfügbar' : a.intent) + ')').join(', ')
                    : '— nicht zugewiesen'}</small></td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else}
        <div class="ld-step pending"><span class="ld-ico">○</span> Noch keine Microsoft-365-Apps-Suite in diesem Tenant.</div>
      {/if}

      <div style="display:flex; gap:0.5rem; flex-wrap:wrap; margin-top:0.6rem;">
        <button class="btn {m365FormOpen ? 'btn-secondary' : 'btn-primary'}"
                onclick={() => { m365FormOpen = !m365FormOpen; if (m365FormOpen) { resetForm(); m365Result = null } }}>
          {m365FormOpen ? '✕ Schliessen' : '➕ Office ausrollen'}
        </button>
      </div>

      {#if m365FormOpen && form}
        <div class="obj-sub" style="border-bottom:none;">
          <div class="ld-oib-target">
            <label for="m365name"><strong>Name der App-Suite:</strong></label>
            <input id="m365name" type="text" bind:value={form.displayName} style="min-width:16rem;" />
            <select bind:value={form.productId}>
              {#each m365.products as p (p.value)}<option value={p.value}>{p.label}</option>{/each}
            </select>
          </div>
          <p class="ld-section-hint">{(m365.products.find(p => p.value === form.productId) || {}).hint}</p>

          <div class="ld-phase complete">
            <div class="ld-phase-title">🧩 Diese Apps werden installiert</div>
            {#each m365.catalog as a (a.key)}
              <label class="ld-oib-row">
                <input type="checkbox" checked={form.apps.includes(a.key)}
                       onchange={() => (form.apps = toggleIn(form.apps, a.key))} />
                <span class="ld-oib-name">{a.label}</span>
                {#if a.hint}<small class="ld-oib-assigned">{a.hint}</small>{/if}
              </label>
            {/each}
            <p class="ld-section-hint">Nicht angehakt heisst: wird nicht installiert. InfoPath, SharePoint Designer und der
              alte OneDrive-for-Business-Client sind fest ausgeschlossen — abgekündigt.</p>
          </div>

          <div class="ld-oib-target" style="flex-wrap:wrap;">
            <label>Architektur
              <select bind:value={form.architecture}><option value="x64">64 Bit</option><option value="x86">32 Bit</option></select>
            </label>
            <label>Updatekanal
              <select bind:value={form.updateChannel}>
                {#each m365.channels as c (c.value)}<option value={c.value}>{c.label}</option>{/each}
              </select>
            </label>
            <label>Standarddateiformat
              <select bind:value={form.fileFormat}>
                {#each m365.fileFormats as f (f.value)}<option value={f.value}>{f.label}</option>{/each}
              </select>
            </label>
          </div>
          <p class="ld-section-hint">{(m365.channels.find(c => c.value === form.updateChannel) || {}).hint}</p>

          <div class="ld-oib-target" style="flex-wrap:wrap;">
            <label>Sprachen <input type="text" bind:value={form.locales} style="min-width:12rem;" placeholder="de-de, en-us" /></label>
            <label>Feste Version <input type="text" bind:value={form.targetVersion} style="min-width:11rem;" placeholder="leer = immer neueste" /></label>
          </div>

          <label class="ld-oib-row"><input type="checkbox" bind:checked={form.removeOtherVersions} />
            <span class="ld-oib-name">Andere Office-Versionen entfernen</span>
            <small class="ld-oib-assigned">Räumt alte MSI-Installationen weg — sonst stehen zwei Office nebeneinander.</small></label>
          <label class="ld-oib-row"><input type="checkbox" bind:checked={form.sharedComputerActivation} />
            <span class="ld-oib-name">Aktivierung für gemeinsam genutzte Computer</span>
            <small class="ld-oib-assigned">Nur für Terminalserver/VDI mit wechselnden Anmeldungen.</small></label>
          <label class="ld-oib-row"><input type="checkbox" bind:checked={form.installBingSearch} />
            <span class="ld-oib-name">Hintergrunddienst „Microsoft Search in Bing" installieren</span>
            <small class="ld-oib-assigned">Setzt Bing als Suchmaschine in Chrome — normalerweise nicht gewollt.</small></label>
          <label class="ld-oib-row"><input type="checkbox" bind:checked={form.includeVisio} />
            <span class="ld-oib-name">Visio mitinstallieren</span>
            <small class="ld-oib-assigned">Nur mit eigener Visio-Lizenz — sonst landet es im Testmodus.</small></label>
          <label class="ld-oib-row"><input type="checkbox" bind:checked={form.includeProject} />
            <span class="ld-oib-name">Project mitinstallieren</span>
            <small class="ld-oib-assigned">Nur mit eigener Project-Lizenz.</small></label>

          <div class="ld-phase complete" style="margin-top:0.6rem;">
            <div class="ld-phase-title">🎯 Zielgruppen (dynamische Gerätegruppen)</div>
            {#if !m365.groups.length}
              <div class="ld-banner warn">Keine dynamischen Gerätegruppen gefunden — zuerst im Tab GroupTags anlegen.</div>
            {:else}
              {#each m365.groups as g (g.groupId)}
                <label class="ld-oib-row">
                  <input type="checkbox" checked={form.groupTags.includes(g.groupTag)}
                         onchange={() => (form.groupTags = toggleIn(form.groupTags, g.groupTag))} />
                  <span class="ld-oib-name">{g.groupName}</span>
                  <small class="ld-oib-assigned">GroupTag {g.groupTag}</small>
                </label>
              {/each}
            {/if}
            <div class="ld-oib-target">
              <label>Zuweisungsart
                <select bind:value={form.intent}>
                  <option value="required">erforderlich (wird installiert)</option>
                  <option value="available">verfügbar (Nutzer holt es im Firmenportal)</option>
                </select>
              </label>
            </div>
          </div>

          <div class="ld-confirm-actions">
            <button class="btn btn-primary" onclick={deployM365} disabled={m365Busy}>
              {m365Busy ? 'Lege an…' : 'Anlegen & zuweisen'}
            </button>
          </div>
        </div>
      {/if}
    {/if}
  </div>

  <div class="settings-group">
    <h4>Intune-Baseline <small>(OpenIntuneBaseline)</small></h4>
    <p class="ld-section-hint">„Win - OIB"-Policies anzeigen und dynamischen Security-Gruppen zuweisen — oder die Baseline zuerst direkt aus dem OpenIntuneBaseline-Repo importieren.</p>
    <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
      <button class="btn btn-secondary" onclick={load} disabled={loading}>{loading ? '…' : '🔄 Neu laden'}</button>
      <button class="btn btn-primary" onclick={toggleImport} disabled={importBusy}>
        {importOpen ? '✕ Import schließen' : '⬇️ Baseline importieren'}
      </button>
      <button class="btn btn-secondary" onclick={toggleCheck} disabled={checkLoading}>
        {checkOpen ? '✕ Check schließen' : '🔍 Assignment-Check'}
      </button>
      <button class="btn btn-secondary" onclick={toggleBulkDelete} disabled={bdLoading}>
        {bdOpen ? '✕ Aufräumen schließen' : '🗑️ Aufräumen (Bulk-Löschung)'}
      </button>
      <button class="btn btn-secondary" onclick={toggleBackup} disabled={bkBusy}>
        {bkOpen ? '✕ Backup schließen' : '💾 Backup & Restore'}
      </button>
    </div>
  </div>

  {#if bkOpen}
    <div class="ld-job" style="margin-bottom:1.5rem;">
      <div class="ld-job-head"><strong>Intune-Backup &amp; -Restore: {$activeTenant.name}</strong>
        {#if bkList}<span class="ld-job-meta">{bkList.backups.length} Snapshot{bkList.backups.length === 1 ? '' : 's'}</span>{/if}</div>
      <p class="ld-section-hint">Sichert Settings Catalog (inkl. Einstellungen), Compliance, Device Configurations, Plattform-Skripte (inkl. Inhalt) und Update-Profile als Snapshot. Restore legt ausschliesslich <b>neue</b> Objekte mit „[Restored]"-Präfix und ohne Zuweisungen an — bestehende Konfiguration wird nie verändert. Admin Templates (ADMX) sind bewusst nicht enthalten.</p>

      <div class="ld-oib-toolbar">
        <button class="btn btn-primary" onclick={startBackup} disabled={bkBusy}>{bkBusy ? 'Läuft…' : '📸 Backup jetzt erstellen'}</button>
        <button class="btn btn-secondary" style="padding:0.25rem 0.7rem; font-size:0.8rem;" onclick={loadBackups} disabled={bkLoading}></button>
      </div>

      {#if bkJob}
        {#if bkJob.status === 'failed'}
          <div class="ld-banner fail">{bkJob.error}</div>
        {:else if bkJob.status === 'done' && bkJob.results?.backupId}
          <div class="ld-banner ok">Backup erstellt — {bkJob.results.counts?.total ?? '?'} Objekte gesichert.</div>
        {:else if bkJob.status === 'done' && bkJob.results?.details}
          <div class="ld-banner {bkJob.results.failed ? 'warn' : 'ok'}">
            {bkJob.results.failed ? '⚠️' : '✅'} Restore fertig — {bkJob.results.created} angelegt{bkJob.results.failed ? `, ${bkJob.results.failed} fehlgeschlagen` : ''}. Wiederhergestellte Objekte sind unzugewiesen und heissen „[Restored] …".
          </div>
          {#each bkJob.results.details.filter(d => d.status === 'failed') as d}
            <div class="ld-step fail"><span class="ld-ico">❌</span> {d.name} <small>({d.error})</small></div>
          {/each}
        {/if}
        {#each bkJob.steps as s}
          {#if s.state === 'running'}
            <div class="ld-step running"><span class="ld-spinner"></span> {s.name}</div>
          {:else if s.state === 'done'}
            <div class="ld-step ok"><span class="ld-ico">✅</span> {s.name}</div>
          {/if}
        {/each}
      {/if}

      {#if bkLoading}
        <div class="ld-step running"><span class="ld-spinner"></span> Lade Snapshots…</div>
      {:else if bkError}
        <div class="ld-banner fail">{bkError}</div>
      {:else if bkList}
        {#if !bkList.backups.length}
          <div class="ld-step pending"><span class="ld-ico">○</span> Noch keine Snapshots — oben das erste Backup erstellen.</div>
        {/if}
        {#if bkList.backups.length >= 2}
          <div class="ld-oib-target">
            <strong>Drift-Vergleich:</strong>
            <select bind:value={cmpA}><option value="">— älterer Snapshot —</option>{#each bkList.backups as b2 (b2.backupId)}<option value={b2.backupId}>{new Date(b2.createdAt).toLocaleString('de-CH')}</option>{/each}</select>
            <select bind:value={cmpB}><option value="">— neuerer Snapshot —</option>{#each bkList.backups as b2 (b2.backupId)}<option value={b2.backupId}>{new Date(b2.createdAt).toLocaleString('de-CH')}</option>{/each}</select>
            <button class="btn btn-secondary" onclick={runCompare} disabled={cmpBusy || !cmpA || !cmpB}>{cmpBusy ? '…' : 'Vergleichen'}</button>
          </div>
        {/if}
        {#if cmpResult}
          <div class="ld-phase complete">
            <div class="ld-phase-title">🔍 Drift zwischen den Snapshots</div>
            {#each cmpResult.diff.filter(d => d.added.length || d.removed.length) as d}
              <div class="ld-step"><strong>{d.label}</strong> <small>({d.same} unverändert)</small></div>
              {#each d.added as n}<div class="ld-step ok"><span class="ld-ico">➕</span> {n}</div>{/each}
              {#each d.removed as n}<div class="ld-step fail"><span class="ld-ico">➖</span> {n}</div>{/each}
            {/each}
            {#if !cmpResult.diff.some(d => d.added.length || d.removed.length)}
              <div class="ld-banner ok">Kein Drift — beide Snapshots enthalten dieselben Objekte (auf Namensebene).</div>
            {/if}
          </div>
        {/if}
        {#each bkList.backups as b (b.backupId)}
          <div class="ld-phase complete">
            <div class="ld-phase-title">📸 {new Date(b.createdAt).toLocaleString('de-CH')} <small style="font-weight:400; color:var(--text-dim);">· {b.counts.total} Objekte</small></div>
            <div class="ld-step"><small>{(bkList.categories || []).map(c => `${c.label}: ${b.counts[c.key] ?? 0}`).join(' · ')}</small></div>
            <div class="ld-oib-target" style="margin-top:0;">
              <button class="btn btn-secondary" onclick={() => downloadBackup(b.backupId)}>⬇️ JSON herunterladen</button>
              <button class="btn btn-secondary" onclick={() => openRestore(b.backupId)}>{bkRestoreOpen === b.backupId ? '✕ Restore schließen' : '♻️ Restore öffnen'}</button>
            </div>
            {#if bkRestoreOpen === b.backupId}
              {#if !bkItems}
                <div class="ld-step running"><span class="ld-spinner"></span> Lade Snapshot-Inhalt…</div>
              {:else}
                {#each Object.entries(bkItems.items) as [cat, names]}
                  {#if names.length}
                    <div class="ld-phase complete" style="margin-left:0.5rem;">
                      <div class="ld-phase-title">📁 {bkCatLabel.get(cat) || cat} ({names.length})</div>
                      {#each names as n, i}
                        <label class="ld-oib-row">
                          <input type="checkbox" checked={!!bkChecked[cat + '::' + i]}
                                 onchange={(e) => (bkChecked = { ...bkChecked, [cat + '::' + i]: e.target.checked })} />
                          <span class="ld-oib-name">{n}</span>
                        </label>
                      {/each}
                    </div>
                  {/if}
                {/each}
                <div class="ld-confirm-actions">
                  <button class="btn btn-primary" onclick={startRestore} disabled={bkBusy || bkSelCount === 0}>{bkSelCount} Objekt(e) wiederherstellen (als „[Restored]“, unzugewiesen)
                  </button>
                </div>
              {/if}
            {/if}
          </div>
        {/each}
      {/if}
    </div>
  {/if}

  {#if checkOpen}
    <div class="ld-job" style="margin-bottom:1.5rem;">
      <div class="ld-job-head"><strong>Assignment-Check: {$activeTenant.name}</strong>
        {#if checkData}<span class="ld-job-meta">{checkData.summary.total} Objekte geprüft</span>{/if}</div>
      <p class="ld-section-hint">Read-only-Audit aller Intune-Policies und -Apps: findet Objekte ohne Zuweisung, Zuweisungen auf leere oder gelöschte Gruppen und breite „Alle Benutzer/Geräte"-Zuweisungen.</p>

      {#if checkLoading}
        <div class="ld-step running"><span class="ld-spinner"></span> Lese alle Policies, Apps und Zuweisungen aus dem Tenant… (kann bei vielen Objekten etwas dauern)</div>
      {:else if checkError}
        <div class="ld-banner fail">{checkError}</div>
      {:else if checkData}
        <div class="rep-metrics" style="margin-bottom:0.7rem;">
          <div class="rep-metric {checkData.summary.unassigned ? 'warn' : ''}">
            <div class="rep-metric-value">{checkData.summary.unassigned}</div>
            <div class="rep-metric-label">ohne Zuweisung</div>
            <div class="rep-metric-detail">wirken nirgends</div>
          </div>
          <div class="rep-metric {checkData.summary.emptyGroup ? 'warn' : ''}">
            <div class="rep-metric-value">{checkData.summary.emptyGroup}</div>
            <div class="rep-metric-label">auf leere Gruppen</div>
          </div>
          <div class="rep-metric {checkData.summary.missingGroup ? 'crit' : ''}">
            <div class="rep-metric-value">{checkData.summary.missingGroup}</div>
            <div class="rep-metric-label">auf gelöschte Gruppen</div>
          </div>
          <div class="rep-metric">
            <div class="rep-metric-value">{checkData.summary.broadAll}</div>
            <div class="rep-metric-label">auf Alle Benutzer/Geräte</div>
            <div class="rep-metric-detail">bewusst prüfen</div>
          </div>
        </div>
        <div class="ld-oib-toolbar">
          <label style="display:flex; align-items:center; gap:0.4rem; font-size:0.82rem; cursor:pointer;">
            <input type="checkbox" bind:checked={checkOnlyIssues} /> Nur Auffälligkeiten zeigen
          </label>
          <button class="btn btn-secondary" style="padding:0.25rem 0.7rem; font-size:0.8rem;" onclick={runCheck}>Neu prüfen</button>
        </div>
        {#if !checkVisible.length}
          <div class="ld-banner ok">{checkOnlyIssues ? 'Keine Auffälligkeiten — alle Zuweisungen sehen sauber aus.' : 'Keine Objekte gefunden.'}</div>
        {/if}
        {#if checkVisible.length}
          <div class="gt-table-wrap">
            <table class="gt-table">
              <thead><tr><th>Objekt</th><th>Typ</th><th>Befund</th><th>Zugewiesen an</th></tr></thead>
              <tbody>
                {#each checkVisible as r}
                  <tr class:ac-issue={r.issues.some(i => ISSUE_META[i]?.tone !== 'info')}>
                    <td>{r.name}</td>
                    <td><small>{r.type}</small></td>
                    <td>
                      {#each r.issues as iss}
                        <span class="tbadge {ISSUE_META[iss]?.tone === 'crit' ? 'crit' : ISSUE_META[iss]?.tone === 'warn' ? 'warn' : ''}"
                              title={ISSUE_META[iss]?.hint}>{ISSUE_META[iss]?.label}</span>
                      {/each}
                      {#if !r.issues.length}<span class="tbadge ok">ok</span>{/if}
                    </td>
                    <td><small>
                      {#if r.assignments.length}
                        {r.assignments.map(a => (a.exclude ? 'ausgeschlossen: ' : '') + a.label + (a.memberCount !== null && a.kind === 'group' ? ` (${a.memberCount})` : '')).join(', ')}
                      {:else}
                        <em>keine</em>
                      {/if}
                    </small></td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      {/if}
    </div>
  {/if}

  {#if importOpen}
    <div class="ld-job" style="margin-bottom:1.5rem;">
      <div class="ld-job-head"><strong>OpenIntuneBaseline importieren{baseline?.oibVersion ? ` (v${baseline.oibVersion})` : ''}</strong>
        {#if baseline}<span class="ld-job-meta">{importSelectedCount}/{baseline.policies.length} ausgewählt</span>{/if}</div>
      <p class="ld-section-hint">Lädt die Windows-Baseline direkt aus <a href="https://github.com/SkipToTheEndpoint/OpenIntuneBaseline" target="_blank" rel="noopener">SkipToTheEndpoint/OpenIntuneBaseline</a> und legt die Policies OHNE Zuweisung im Tenant an. Bereits vorhandene Policies (gleicher Name) werden übersprungen — nie überschrieben. Zuweisen danach wie gewohnt unten.</p>

      {#if baselineLoading}
        <div class="ld-step running"><span class="ld-spinner"></span> Lade Baseline-Index von GitHub…</div>
      {:else if baselineError}
        <div class="ld-banner fail">{baselineError}</div>
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
          <div class="ld-banner fail">{importJob.error}</div>
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
      <div class="ld-banner fail">{loadError}</div>
      <div class="ld-step"><small>💡 Braucht die Graph-Permissions (DeviceManagementConfiguration, Group.Read) — ggf. im Tab „🏢 Tenants" einmal 🔧 Reparieren ausführen.</small></div>
    </div>
  {:else if data}
    {#if !data.policies?.length}
      <div class="ld-job"><div class="ld-banner warn">Keine "Win - OIB"-Policies im Tenant gefunden — zuerst die OIB-Baseline importieren.</div></div>
    {:else if !data.groups?.length}
      <div class="ld-job"><div class="ld-banner warn">Keine dynamischen Security Groups gefunden — zuerst die Gerätegruppen anlegen (Tab GroupTags).</div></div>
    {:else}
      <div class="ld-job">
        <div class="ld-job-head"><strong>OIB-Policies: {$activeTenant.name}</strong>
          <span class="ld-job-meta">{data.policies.length} Policies · {data.groups.length} dynamische Gruppen</span></div>

        {#if data.intentsError}
          <div class="ld-banner warn">Endpoint-Security-Policies (intents) konnten nicht geladen werden: {data.intentsError}
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
        <p class="ld-section-hint">„Alle auswählen“ lässt drei Sorten bewusst aus: veraltete Versionen,
          ⚠ Break-Risiko und 🛡 Defender-Antivirus (wir fahren Bitdefender). Die sind einzeln anhakbar —
          nur eben nicht versehentlich.</p>

        {#each byType as grp (grp.type)}
          <div class="ld-phase complete">
            <div class="ld-phase-title">🧩 {grp.type} ({grp.items.length})
              <button class="btn btn-secondary" style="padding:0.1rem 0.5rem; font-size:0.75rem;" onclick={() => selectTypeAll(grp.type)}>alle</button>
            </div>
            {#each grp.items as p (p.id)}
              {@const already = alreadyInSelected(p)}
              {@const risk = breakRiskFor(p.name)}
              {@const outdated = outdatedInfo(p)}
              {@const avHit = avConflict(p.name)}
              <label class="ld-oib-row" class:already class:breakrisk={!!risk || !!avHit} class:outdated={!!outdated}>
                <input type="checkbox" checked={!!checked[p.id]} disabled={already}
                       onchange={(e) => (checked = { ...checked, [p.id]: e.target.checked })} />
                <span class="ld-oib-name">{p.name}</span>
                {#if outdated}
                  <span class="ld-oib-outdated-tag" title="Neuere Version verfügbar: v{outdated.latest} — wird bei „Alle auswählen“ bewusst NICHT mit ausgewählt, Haken muss hier explizit gesetzt werden.">🆕 Neuere Version verfügbar (v{outdated.latest})</span>
                {/if}
                {#if avHit}
                  <span class="ld-oib-risk" title="{avHit} — wird bei „Alle auswählen“ bewusst NICHT mit ausgewählt, Haken muss hier explizit gesetzt werden.">🛡 Defender-AV — Bitdefender prüfen</span>
                {/if}
                {#if risk}
                  <span class="ld-oib-risk" title="Break-Risiko: {risk} — wird bei „Alle auswählen“ bewusst NICHT mit ausgewählt, Haken muss hier explizit gesetzt werden.">⚠ Break-Risiko</span>
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
          <div class="ld-banner fail">{assignResult.error}</div>
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

  {#if bdOpen}
    <div class="ld-job" style="margin-top:1.5rem">
      <div class="ld-job-head">
        <strong>Aufräumen: {$activeTenant.name}</strong>
        <span class="ld-job-meta">{bdObjects.length} Objekte gefunden</span>
        <button class="btn btn-secondary" style="padding:0.2rem 0.6rem; font-size:0.78rem;" onclick={loadBulkDeleteObjects} disabled={bdLoading}>Neu laden</button>
        <button class="btn btn-secondary" style="padding:0.2rem 0.6rem; font-size:0.78rem;" onclick={toggleBulkDeleteLog}>{bdLogOpen ? '✕ Log schließen' : '📜 Log'}</button>
      </div>
      <p class="ld-section-hint">⚠️ Löscht Objekte UNWIDERRUFLICH aus dem Tenant (inkl. Zuweisungen). Erst prüfen, dann auswählen, dann löschen — es gibt kein Undo.</p>

      {#if bdFetchErrors.length}
        <div class="ld-banner warn">Diese Typen konnten nicht geladen werden (Rest ist trotzdem nutzbar): {bdFetchErrors.map(e => e.type).join(', ')}</div>
      {/if}

      {#if bdLogOpen}
        <div class="ld-phase complete" style="margin-bottom:0.75rem;">
          {#if bdLog.length === 0}
            <p class="ld-section-hint">Noch keine Einträge.</p>
          {:else}
            {#each bdLog as entry (entry.id)}
              <div class="ld-step {entry.result?.startsWith('ok') ? 'ok' : 'fail'}">
                <span class="ld-ico">{entry.result?.startsWith('ok') ? '✅' : '❌'}</span> {entry.type} „{entry.name}" <small>({new Date(entry.at).toLocaleString('de-CH')}{entry.result?.startsWith('ok') ? '' : ' — ' + entry.result})</small>
              </div>
            {/each}
          {/if}
        </div>
      {/if}

      {#if bdLoading}
        <div class="ld-step running"><span class="ld-spinner"></span> Lade Objekte…</div>
      {:else if bdError}
        <div class="ld-banner fail">{bdError}</div>
      {:else if bdObjects.length === 0}
        <p class="ld-section-hint">Keine löschbaren Objekte gefunden.</p>
      {:else}
        <div class="ld-oib-toolbar">
          <span>{bdSelectedIds.length} ausgewählt</span>
          <button class="btn btn-secondary" style="padding:0.25rem 0.7rem; font-size:0.8rem;" onclick={bdClearSelection}>Auswahl leeren</button>
        </div>

        {#each bdByType as grp (grp.type)}
          <div class="ld-phase complete">
            <div class="ld-phase-title">{grp.riskier ? '⚠️ ' : ''}{grp.type} ({grp.items.length})
              <button class="btn btn-secondary" style="padding:0.1rem 0.5rem; font-size:0.75rem;" onclick={() => bdToggleTypeAll(grp.type, true)}>alle</button>
              <button class="btn btn-secondary" style="padding:0.1rem 0.5rem; font-size:0.75rem;" onclick={() => bdToggleTypeAll(grp.type, false)}>keine</button>
            </div>
            {#each grp.items as o (o.id)}
              <label class="ld-oib-row" class:breakrisk={o.riskier}>
                <input type="checkbox" checked={!!bdChecked[o.id]}
                       onchange={(e) => (bdChecked = { ...bdChecked, [o.id]: e.target.checked })} />
                <span class="ld-oib-name">{o.name}</span>
                {#if o.description}<small class="ld-oib-assigned">{o.description}</small>{/if}
              </label>
            {/each}
          </div>
        {/each}

        <div class="ld-confirm-actions">
          <button class="btn btn-primary" onclick={runBulkDelete} disabled={bdBusy || bdSelectedIds.length === 0}>
            {bdBusy ? 'Lösche…' : `🗑️ ${bdSelectedIds.length} ausgewählte Objekt(e) löschen`}
          </button>
        </div>

        {#if bdResults}
          {@const okCount = bdResults.filter(x => x.ok).length}
          {@const failCount = bdResults.filter(x => !x.ok).length}
          <div class="ld-banner {failCount ? 'warn' : 'ok'}">
            {failCount ? `⚠️ ${failCount} Fehler — Details unten. ` : '✅ '}{okCount} Objekt(e) gelöscht.
          </div>
          {#each bdResults as x}
            <div class="ld-step {x.ok ? 'ok' : 'fail'}">
              <span class="ld-ico">{x.ok ? '✅' : '❌'}</span> {x.type} „{x.name}"{x.error ? ` — ${x.error}` : ''}
            </div>
          {/each}
        {/if}
      {/if}
    </div>
  {/if}
</TenantContext>
