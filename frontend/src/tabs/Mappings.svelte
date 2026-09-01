<script>
  import { onDestroy } from 'svelte'
  import { apiGet, apiPost } from '../lib/api.js'
  import { activeTenant } from '../lib/tenantStore.js'
  import TenantContext from '../lib/TenantContext.svelte'
  import { loadNaming } from '../lib/naming.js'

  // Alle vier Bereiche folgen demselben gefuehrten Ablauf:
  //   1 Profil benennen -> 2 Inhalte definieren -> 3 Gruppen zuweisen ->
  //   4 Vorschau pruefen & deployen.
  // Pro Bereich ist immer nur der aktive Schritt ausgeklappt; erledigte
  // Schritte zeigen eine Kurzfassung und sind per Klick wieder erreichbar.
  // Der Deploy-Knopf existiert ausschliesslich in Schritt 4 — dort wird bei
  // den Skript-Bereichen das ECHTE generierte PowerShell-Skript angezeigt
  // (gleiche Validierung wie der Deploy, aber ohne Tenant-Schreibzugriff).

  // Spiegelt sanitizeProfileName() im Backend: zeigt schon im Formular den
  // Namen, der wirklich in Intune landet (Umlaute/Sonderzeichen fallen raus).
  const intuneSafe = (s) => String(s || '').trim().replace(/[^A-Za-z0-9 ._-]/g, '').slice(0, 40)
  const UNC_RE = /^\\\\[^\\]+\\.+/

  // ---------- Gemeinsames: Tenant, Gruppen, Namenskonvention ----------
  let groups = $state([])
  let lastTenantId = null

  // Die Objektnamen kommen aus der eingestellten Konvention (Tab
  // Namenskonvention) — hier nur zur Anzeige. Solange sie nicht geladen ist,
  // greift der Bestandsname als Rückfall, damit nie ein leeres Feld dasteht.
  let nm = $state(null)
  function nmName(kind, vars, fallback) {
    const v = nm ? nm.name(kind, vars) : ''
    return v || fallback
  }

  function selNames(sel) {
    return Object.keys(sel).filter(k => sel[k]).map(id => groups.find(g => g.id === id)?.displayName || id)
  }
  function groupNames(ids) {
    return (ids || []).map(gid => groups.find(g => g.id === gid)?.displayName || gid)
  }
  // Volle SharePoint-URLs machen die Uebersicht unruhig — nur der Pfad (/sites/xyz).
  function sitePath(url) {
    try { return new URL(url).pathname || url } catch { return url }
  }

  // ---------- Laufwerk-Mappings (Port: nicolonsky/IntuneDriveMapping) ----------
  let loading = $state(false)
  let loadError = $state(null)
  let profiles = $state(null)

  let editorOpen = $state(false)
  let dmStep = $state(1)
  let profileName = $state('Standard')
  let mappings = $state([{ driveLetter: 'H', path: '', label: '', groupFilter: '' }])
  let searchRoot = $state('')
  let removeStaleDrives = $state(false)
  let selGroups = $state({})   // groupId -> bool
  let saving = $state(false)
  let saveMsg = $state(null)   // { ok, text }
  let dmPreview = $state(null) // { loading } | { script } | { error }

  const LETTERS = 'DEFGHIJKLMNOPQRSTUVWXYZ'.split('')

  $effect(() => {
    const id = $activeTenant?.id ?? null
    if (id !== lastTenantId) {
      lastTenantId = id
      // ALLE Bereiche zuruecksetzen — sonst zeigen Drucker/SharePoint/Registry
      // nach einem Tenant-Wechsel weiter die Daten des alten Tenants.
      profiles = null; loadError = null; saveMsg = null; editorOpen = false
      pmData = null; pmError = null; pmJob = null; pmEditorOpen = false
      spProfiles = null; spError = null; spSaveMsg = null; spEditorOpen = false; spSites = []
      rpProfiles = null; rpError = null; rpSaveMsg = null; rpEditorOpen = false
      if (id) { load(); loadGroups() }
    }
  })

  async function load() {
    if (!$activeTenant) return
    loading = true
    loadError = null
    try { profiles = (await apiGet(`/api/tenants/${encodeURIComponent($activeTenant.id)}/drivemappings`)).profiles }
    catch (e) { loadError = e.message }
    loading = false
  }
  async function loadGroups() {
    try { groups = (await apiGet(`/api/tenants/${encodeURIComponent($activeTenant.id)}/groups`)).groups || [] }
    catch (e) { /* Auswahl bleibt leer */ }
    try { nm = await loadNaming($activeTenant.id) }
    catch (e) { /* Rückfall auf die Bestandsnamen */ }
  }

  function newProfile() {
    editorOpen = true
    dmStep = 1
    profileName = 'Standard'
    mappings = [{ driveLetter: 'H', path: '', label: '', groupFilter: '' }]
    searchRoot = ''
    removeStaleDrives = false
    selGroups = {}
    saveMsg = null
    dmPreview = null
  }
  function editProfile(p) {
    editorOpen = true
    dmStep = 2
    profileName = p.profileName
    mappings = (p.config?.mappings || []).map(m => ({ ...m }))
    if (!mappings.length) mappings = [{ driveLetter: 'H', path: '', label: '', groupFilter: '' }]
    searchRoot = p.config?.searchRoot || ''
    removeStaleDrives = !!p.config?.removeStaleDrives
    const sel = {}
    for (const gid of (p.groupIds || [])) sel[gid] = true
    selGroups = sel
    saveMsg = null
    dmPreview = null
  }
  function addRow() { mappings = [...mappings, { driveLetter: '', path: '', label: '', groupFilter: '' }] }
  function removeRow(i) { mappings = mappings.filter((_, j) => j !== i) }

  const dmContentOk = $derived(mappings.some(m => m.driveLetter && m.path.trim()))
  const dmName = $derived(intuneSafe(profileName))
  const dmTarget = $derived(dmName ? nmName('scriptDrive', { name: dmName }, `WIN - DriveMapping - ${dmName}`) : '')

  function dmJump(n) {
    if (n > 1 && !dmName) return
    if (n === 4) dmLoadPreview()
    dmStep = n
  }
  async function dmLoadPreview() {
    dmPreview = { loading: true }
    try {
      const r = await apiPost('/api/drivemappings/generate', { mappings, searchRoot, removeStaleDrives })
      dmPreview = { script: r.script }
    } catch (e) { dmPreview = { error: e.message } }
  }
  function downloadScript() {
    if (!dmPreview?.script) return
    const blob = new Blob([dmPreview.script], { type: 'text/plain' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'DriveMapping.ps1'
    a.click()
    URL.revokeObjectURL(a.href)
  }

  // Generator-UX des Originals: bestehendes Skript einlesen (Konfig-Roundtrip)
  let importOpen = $state(false)
  let importText = $state('')
  let importError = $state(null)

  async function importScript() {
    importError = null
    try {
      const r = await apiPost('/api/drivemappings/parse', { script: importText })
      mappings = r.config.mappings.length ? r.config.mappings : mappings
      searchRoot = r.config.searchRoot || ''
      removeStaleDrives = !!r.config.removeStaleDrives
      importOpen = false
      importText = ''
    } catch (e) { importError = e.message }
  }

  async function save() {
    const groupIds = Object.keys(selGroups).filter(g => selGroups[g])
    if (!confirm(
      `Profil „${dmName}" deployen?\n\n` +
      `Es wird ein PowerShell-Plattformskript „${dmTarget}" in Intune angelegt/aktualisiert ` +
      `und ${groupIds.length ? groupIds.length + ' Gruppe(n) zugewiesen' : 'OHNE Zuweisung angelegt'}. ` +
      `Das Skript läuft als SYSTEM und registriert einen Logon-Task, der die Laufwerke pro Benutzer verbindet.`
    )) return
    saving = true
    saveMsg = null
    try {
      const r = await apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/drivemappings`, {
        profileName, mappings, searchRoot, removeStaleDrives, groupIds
      })
      saveMsg = { ok: true, text: `✅ „${r.displayName}" ${r.updated ? 'aktualisiert' : 'angelegt'}${groupIds.length ? ` und ${groupIds.length} Gruppe(n) zugewiesen` : ''}.` }
      editorOpen = false
      await load()
    } catch (e) {
      saveMsg = { ok: false, text: '❌ ' + e.message }
    }
    saving = false
  }

  // ---------- Drucker-Mappings (Weatherlights Intune Printer Mapping) ----------
  let pmLoading = $state(false)
  let pmError = $state(null)
  let pmData = $state(null)          // { profiles, autostartPfn, maxPrinters }
  let pmEditorOpen = $state(false)
  let pmStep = $state(1)
  let pmName = $state('Buero')
  let pmScope = $state('user')
  let pmPrinters = $state([{ path: '', operation: 'Add', setDefault: false }])
  let pmSelGroups = $state({})
  let pmDeployApp = $state(true)
  let pmJob = $state(null)
  let pmJobId = $state(null)
  let pmBusy = $state(false)
  let pmTimer = null
  let pmPfnCopied = $state(false)

  async function pmLoad() {
    if (!$activeTenant) return
    pmLoading = true
    pmError = null
    try { pmData = await apiGet(`/api/tenants/${encodeURIComponent($activeTenant.id)}/printermappings`) }
    catch (e) { pmError = e.message }
    pmLoading = false
  }
  $effect(() => {
    // gleiche Tenant-Wechsel-Logik wie oben: lastTenantId wird dort gepflegt,
    // hier nur nachziehen, wenn der Laufwerks-Teil bereits neu geladen hat.
    if (profiles !== null && pmData === null && !pmLoading && $activeTenant) pmLoad()
  })

  function pmNew() {
    pmEditorOpen = true
    pmStep = 1
    pmName = 'Buero'
    pmScope = 'user'
    pmPrinters = [{ path: '', operation: 'Add', setDefault: false }]
    pmSelGroups = {}
    pmDeployApp = true
  }
  function pmEdit(p) {
    pmEditorOpen = true
    pmStep = 2
    pmName = p.profileName
    pmScope = p.scope || 'user'
    pmPrinters = (p.printers || []).map(x => ({ ...x }))
    if (!pmPrinters.length) pmPrinters = [{ path: '', operation: 'Add', setDefault: false }]
    const sel = {}
    for (const gid of (p.groupIds || [])) sel[gid] = true
    pmSelGroups = sel
    pmDeployApp = false
  }
  function pmAddRow() {
    if (pmPrinters.length >= (pmData?.maxPrinters || 15)) return
    pmPrinters = [...pmPrinters, { path: '', operation: 'Add', setDefault: false }]
  }
  function pmRemoveRow(i) { pmPrinters = pmPrinters.filter((_, j) => j !== i) }

  const pmContentOk = $derived(pmPrinters.some(p => p.path.trim()))
  const pmSafeName = $derived(intuneSafe(pmName))
  const pmTarget = $derived(pmSafeName ? nmName('scriptPrinter', { name: pmSafeName }, `WIN - PrinterMapping - ${pmSafeName}`) : '')
  const pmInvalidPaths = $derived(pmPrinters.filter(p => p.path.trim() && !UNC_RE.test(p.path.trim())).length)

  function pmJump(n) {
    if (n > 1 && !pmSafeName) return
    pmStep = n
  }

  async function pmSave() {
    const groupIds = Object.keys(pmSelGroups).filter(g => pmSelGroups[g])
    if (!confirm(
      `Drucker-Profil „${pmSafeName}" ausrollen?\n\n` +
      `Es wird die ADMX-Vorlage (einmalig) importiert, das Konfigurationsprofil „${pmTarget}" angelegt/aktualisiert (${pmPrinters.length} Drucker, ${pmScope === 'machine' ? 'Geräte' : 'Benutzer'}-Kontext), ` +
      `${groupIds.length ? groupIds.length + ' Gruppe(n) zugewiesen' : 'OHNE Zuweisung angelegt'}${pmDeployApp ? ' und die Store-App als Required mit deployt' : ''}.`
    )) return
    pmBusy = true
    pmJob = null
    try {
      const r = await apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/printermappings`, {
        profileName: pmName, scope: pmScope, printers: pmPrinters, groupIds, deployApp: pmDeployApp
      })
      pmJobId = r.jobId
      pmEditorOpen = false
      pmPoll()
    } catch (e) { alert('Start fehlgeschlagen: ' + e.message); pmBusy = false }
  }
  function pmPoll() {
    pmTimer = setTimeout(async () => {
      let j
      try { j = await apiGet(`/api/appjobs/${encodeURIComponent(pmJobId)}`) }
      catch (e) { pmBusy = false; return }
      pmJob = j
      if (j.status === 'running') { pmPoll(); return }
      pmBusy = false
      pmLoad()
    }, 1000)
  }
  function pmCopyPfn() {
    if (pmData?.autostartPfn) navigator.clipboard.writeText(pmData.autostartPfn).then(() => (pmPfnCopied = true))
  }

  onDestroy(() => { if (pmTimer) clearTimeout(pmTimer) })

  // ---------- SharePoint-Sync-Mappings (OneDrive "Configure team site libraries to sync automatically") ----------
  let spLoading = $state(false)
  let spError = $state(null)
  let spProfiles = $state(null)
  let spSites = $state([])
  let spSitesLoading = $state(false)
  let spSitesError = $state(null)
  let spEditorOpen = $state(false)
  let spStep = $state(1)
  let spProfileName = $state('Standard')
  let spMappings = $state([])   // [{libraryName, tenantId, siteId, webId, listId, webUrl}]
  let spSiteFilter = $state('')
  let spSelSites = $state({})   // siteId -> bool, Mehrfachauswahl
  let spResolving = $state(false)
  let spResolveError = $state(null)
  let spSelGroups = $state({})
  let spSaving = $state(false)
  let spSaveMsg = $state(null)
  let spPreview = $state(null)

  async function spLoad() {
    if (!$activeTenant) return
    spLoading = true
    spError = null
    try { spProfiles = (await apiGet(`/api/tenants/${encodeURIComponent($activeTenant.id)}/sharepointmappings`)).profiles }
    catch (e) { spError = e.message }
    spLoading = false
  }
  $effect(() => {
    if (profiles !== null && spProfiles === null && !spLoading && $activeTenant) spLoad()
  })
  async function spLoadSites() {
    if (spSites.length || spSitesLoading) return
    spSitesLoading = true
    spSitesError = null
    try { spSites = (await apiGet(`/api/tenants/${encodeURIComponent($activeTenant.id)}/sharepointsites`)).sites || [] }
    catch (e) { spSitesError = e.message }
    spSitesLoading = false
  }
  function spNew() {
    spEditorOpen = true
    spStep = 1
    spProfileName = 'Standard'
    spMappings = []
    spSelSites = {}
    spSiteFilter = ''
    spSelGroups = {}
    spSaveMsg = null
    spPreview = null
    spResolveError = null
    spLoadSites()
  }
  function spEdit(p) {
    spEditorOpen = true
    spStep = 2
    spProfileName = p.profileName
    spMappings = (p.config?.mappings || []).map(m => ({ ...m }))
    spSelSites = {}
    spSiteFilter = ''
    const sel = {}
    for (const gid of (p.groupIds || [])) sel[gid] = true
    spSelGroups = sel
    spSaveMsg = null
    spPreview = null
    spResolveError = null
    spLoadSites()
  }
  const spAlreadyAddedIds = $derived(new Set(spMappings.map(m => m.siteId)))
  const spFilteredSites = $derived(
    spSites.filter(s => !spSiteFilter.trim() || s.displayName.toLowerCase().includes(spSiteFilter.trim().toLowerCase()))
  )
  const spSelSiteCount = $derived(Object.values(spSelSites).filter(Boolean).length)
  const spSafeName = $derived(intuneSafe(spProfileName))
  const spTarget = $derived(spSafeName ? nmName('scriptSharePoint', { name: spSafeName }, `WIN - SharePointSync - ${spSafeName}`) : '')
  function spToggleAllFiltered(val) {
    const next = { ...spSelSites }
    for (const s of spFilteredSites) next[s.id] = val
    spSelSites = next
  }

  function spJump(n) {
    if (n > 1 && !spSafeName) return
    if (n === 4) spLoadPreview()
    spStep = n
  }
  async function spLoadPreview() {
    spPreview = { loading: true }
    try {
      const r = await apiPost('/api/sharepointmappings/generate', { mappings: spMappings })
      spPreview = { script: r.script }
    } catch (e) { spPreview = { error: e.message } }
  }

  // Loest alle ausgewaehlten Sites parallel auf -- eine einzelne Site ohne
  // Dokumentbibliothek (z.B. Communication-Sites) darf die anderen nicht
  // blockieren, daher Promise.allSettled statt eines einzelnen Requests.
  // Eine Site kann MEHRERE Bibliotheken haben ("Documents", "General", ...) --
  // alle werden als eigene Zeile vorgeschlagen statt eine zu erraten,
  // ueberzaehlige einfach per Zeile entfernen.
  async function spResolveAndAddSelected() {
    const ids = Object.keys(spSelSites).filter(id => spSelSites[id])
    if (!ids.length) return
    spResolving = true
    spResolveError = null
    const results = await Promise.allSettled(ids.map(async id => {
      const r = await apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/sharepointsites/resolve`, { siteId: id })
      const site = spSites.find(s => s.id === id)
      const libs = r.libraries || []
      return libs.map(lib => ({
        ...lib,
        libraryName: libs.length > 1 ? `${site?.displayName || 'Site'} - ${lib.libraryName}` : (site?.displayName || lib.libraryName)
      }))
    }))
    const ok = results.filter(r => r.status === 'fulfilled').flatMap(r => r.value)
    const failed = results.filter(r => r.status === 'rejected')
    if (ok.length) spMappings = [...spMappings, ...ok]
    spResolveError = failed.length
      ? `${failed.length} von ${ids.length} Site(s) konnten nicht hinzugefügt werden: ${failed.map(f => f.reason.message).join('; ')}`
      : null
    spSelSites = {}
    spResolving = false
  }
  function spRemoveRow(i) { spMappings = spMappings.filter((_, j) => j !== i) }

  async function spSave() {
    const groupIds = Object.keys(spSelGroups).filter(g => spSelGroups[g])
    if (!confirm(
      `Profil „${spSafeName}" deployen?\n\n` +
      `Es wird ein PowerShell-Plattformskript „${spTarget}" in Intune angelegt/aktualisiert ` +
      `und ${groupIds.length ? groupIds.length + ' Gruppe(n) zugewiesen' : 'OHNE Zuweisung angelegt'}. ` +
      `Das Skript läuft im Benutzerkontext und schreibt die Bibliotheken direkt in HKCU — OneDrive übernimmt sie beim nächsten Anmelden (Fenster bis zu 8h, siehe Microsoft-Doku). Voraussetzung: OneDrive Files On-Demand ist im Tenant aktiv.`
    )) return
    spSaving = true
    spSaveMsg = null
    try {
      const r = await apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/sharepointmappings`, {
        profileName: spProfileName, mappings: spMappings, groupIds
      })
      spSaveMsg = { ok: true, text: `✅ „${r.displayName}" ${r.updated ? 'aktualisiert' : 'angelegt'}${groupIds.length ? ` und ${groupIds.length} Gruppe(n) zugewiesen` : ''}.` }
      spEditorOpen = false
      await spLoad()
    } catch (e) {
      spSaveMsg = { ok: false, text: '❌ ' + e.message }
    }
    spSaving = false
  }

  // ---------- Registry-Richtlinien (HKLM) -- generisch, inkl. Vorlage EU-DMA-SSO-Prompt ----------
  let rpLoading = $state(false)
  let rpError = $state(null)
  let rpProfiles = $state(null)
  let rpPresets = $state([])
  let rpEditorOpen = $state(false)
  let rpStep = $state(1)
  let rpProfileName = $state('Standard')
  let rpEntries = $state([])   // [{path, name, type, value}]
  let rpSelGroups = $state({})
  let rpSaving = $state(false)
  let rpSaveMsg = $state(null)
  let rpPreview = $state(null)

  async function rpLoad() {
    if (!$activeTenant) return
    rpLoading = true
    rpError = null
    try { rpProfiles = (await apiGet(`/api/tenants/${encodeURIComponent($activeTenant.id)}/registrypolicy`)).profiles }
    catch (e) { rpError = e.message }
    rpLoading = false
  }
  $effect(() => {
    if (profiles !== null && rpProfiles === null && !rpLoading && $activeTenant) rpLoad()
  })
  $effect(() => {
    if (!rpPresets.length) {
      apiGet('/api/registrypolicy/presets').then(r => { rpPresets = r.presets || [] }).catch(() => {})
    }
  })
  function rpNew() {
    rpEditorOpen = true
    rpStep = 1
    rpProfileName = 'Standard'
    rpEntries = []
    rpSelGroups = {}
    rpSaveMsg = null
    rpPreview = null
  }
  function rpEdit(p) {
    rpEditorOpen = true
    rpStep = 2
    rpProfileName = p.profileName
    rpEntries = (p.config?.entries || []).map(e => ({ ...e }))
    const sel = {}
    for (const gid of (p.groupIds || [])) sel[gid] = true
    rpSelGroups = sel
    rpSaveMsg = null
    rpPreview = null
  }
  function rpApplyPreset(preset) {
    // Kurzer, Intune-tauglicher Profilname statt des langen Anzeige-Labels.
    if (!rpEntries.length && (rpProfileName === 'Standard' || !rpProfileName.trim())) rpProfileName = preset.key
    rpEntries = [...rpEntries, ...preset.entries.map(e => ({ ...e }))]
  }
  function rpAddRow() { rpEntries = [...rpEntries, { path: '', name: '', type: 'DWORD', value: '' }] }
  function rpRemoveRow(i) { rpEntries = rpEntries.filter((_, j) => j !== i) }

  const rpSafeName = $derived(intuneSafe(rpProfileName))
  const rpTarget = $derived(rpSafeName ? nmName('scriptRegistry', { name: rpSafeName }, `WIN - RegistryPolicy - ${rpSafeName}`) : '')
  const rpContentOk = $derived(rpEntries.length > 0)

  function rpJump(n) {
    if (n > 1 && !rpSafeName) return
    if (n === 4) rpLoadPreview()
    rpStep = n
  }
  async function rpLoadPreview() {
    rpPreview = { loading: true }
    try {
      const r = await apiPost('/api/registrypolicy/generate', { entries: rpEntries })
      rpPreview = { script: r.script }
    } catch (e) { rpPreview = { error: e.message } }
  }

  async function rpSave() {
    const groupIds = Object.keys(rpSelGroups).filter(g => rpSelGroups[g])
    if (!confirm(
      `Profil „${rpSafeName}" deployen?\n\n` +
      `Es wird ein PowerShell-Plattformskript „${rpTarget}" in Intune angelegt/aktualisiert ` +
      `und ${groupIds.length ? groupIds.length + ' Gruppe(n) zugewiesen' : 'OHNE Zuweisung angelegt'}. ` +
      `Das Skript läuft im Systemkontext (SYSTEM) und schreibt die Werte direkt unter HKLM auf dem Gerät.`
    )) return
    rpSaving = true
    rpSaveMsg = null
    try {
      const r = await apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/registrypolicy`, {
        profileName: rpProfileName, entries: rpEntries, groupIds
      })
      rpSaveMsg = { ok: true, text: `✅ „${r.displayName}" ${r.updated ? 'aktualisiert' : 'angelegt'}${groupIds.length ? ` und ${groupIds.length} Gruppe(n) zugewiesen` : ''}.` }
      rpEditorOpen = false
      await rpLoad()
    } catch (e) {
      rpSaveMsg = { ok: false, text: '❌ ' + e.message }
    }
    rpSaving = false
  }

  // ---------- Untertabs ----------
  // Vier Bereiche gleichzeitig sind eine Bildschirmlaenge Rauschen, in der man
  // den gesuchten Punkt nicht findet. Nur einer ist sichtbar; die Zahl am
  // Reiter zeigt, wie viele Profile dort schon deployt sind.
  let subTab = $state('drives')   // drives | printers | sharepoint | registry
</script>

<!-- Schritt-Kopf: nummeriert, erledigte Schritte zeigen die Kurzfassung und
     sind per Klick wieder erreichbar. Nur der aktive Schritt ist ausgeklappt. -->
{#snippet wizHead(n, title, current, jump, summary)}
  <button type="button" class="wiz-head" onclick={() => jump(n)}>
    <span class="step-n">{n}</span>
    <span class="wizard-step-title">{title}</span>
    {#if current !== n && summary}<small class="wiz-summary">{summary}</small>{/if}
  </button>
{/snippet}

{#snippet assignBadge(gnames)}
  <span class="step-state {gnames.length ? 'done' : 'open'}">{gnames.length ? `${gnames.length} Gruppe${gnames.length === 1 ? '' : 'n'}` : 'nicht zugewiesen'}</span>
{/snippet}

{#snippet groupPicker(sel, toggle)}
  {#if !groups.length}
    <div class="ld-step pending"><small>Keine Gruppen geladen — Profil wird ohne Zuweisung angelegt.</small></div>
  {/if}
  {#each groups as g (g.id)}
    <label class="ld-oib-row">
      <input type="checkbox" checked={!!sel[g.id]} onchange={(e) => toggle(g.id, e.target.checked)} />
      <span class="ld-oib-name">{g.displayName}</span>
    </label>
  {/each}
{/snippet}

{#snippet scriptPreview(preview)}
  {#if preview?.loading}
    <div class="ld-step running"><span class="ld-spinner"></span> Erzeuge Skript-Vorschau…</div>
  {:else if preview?.error}
    <div class="ld-banner fail">Konfiguration unvollständig: {preview.error}</div>
  {:else if preview?.script}
    <details class="map-info">
      <summary>Generiertes PowerShell-Skript ansehen ({preview.script.split('\n').length} Zeilen) — genau das wird deployt</summary>
      <pre class="wiz-script">{preview.script}</pre>
    </details>
  {/if}
{/snippet}

<TenantContext>
  <div class="dl-subtabs">
    <button type="button" class="dl-subtab" class:active={subTab === 'drives'} onclick={() => (subTab = 'drives')}>💾 Netzlaufwerke</button>
    <button type="button" class="dl-subtab" class:active={subTab === 'printers'} onclick={() => (subTab = 'printers')}>🖨️ Drucker</button>
    <button type="button" class="dl-subtab" class:active={subTab === 'sharepoint'} onclick={() => (subTab = 'sharepoint')}>☁️ SharePoint-Sync</button>
    <button type="button" class="dl-subtab" class:active={subTab === 'registry'} onclick={() => (subTab = 'registry')}>🔑 Registry</button>
  </div>

  <!-- ======================= Netzlaufwerke ======================= -->
  <div class="map-panel" class:tab-hidden={subTab !== 'drives'}>

  {#if saveMsg}
    <div class="ld-banner {saveMsg.ok ? 'ok' : 'fail'}" style="margin-bottom:1rem;">{saveMsg.text}</div>
  {/if}

  {#if !editorOpen}
    <div class="settings-group">
      <h4>Netzlaufwerk-Mappings <small>(Intune Drive Mapping Generator)</small></h4>
      <p class="ld-section-hint">Hier definierst du, welche Netzlaufwerke (<code>H:</code>, <code>S:</code>, …) auf den Intune-Geräten automatisch verbunden werden. Daraus entsteht ein PowerShell-Plattformskript, das du Gerätegruppen zuweist.</p>
      <p class="ld-section-hint"><small>💡 Ablauf: <span class="step-n">1</span> Profil benennen → <span class="step-n">2</span> Laufwerke definieren → <span class="step-n">3</span> Gruppen zuweisen → <span class="step-n">4</span> Vorschau prüfen &amp; deployen.</small></p>
      <details class="map-info"><summary>Wie funktioniert das technisch?</summary>
        <p class="ld-section-hint">Erzeugt aus deiner Laufwerk-Liste ein PowerShell-Plattformskript (Vorlage: <a href="https://github.com/nicolonsky/IntuneDriveMapping" target="_blank" rel="noopener">nicolonsky/IntuneDriveMapping</a>) und weist es dynamischen Gerätegruppen zu — ohne App-Abhängigkeit. Optionaler Gruppenfilter je Laufwerk nutzt On-Prem-AD-Gruppen (hybrid). Bearbeiten liest die Konfiguration direkt aus dem deployten Skript zurück.</p></details>
      <div style="display:flex; gap:0.5rem; flex-wrap:wrap; margin-top:0.5rem;">
        <button class="btn btn-primary" onclick={newProfile}>➕ Neues Profil</button>
        <button class="btn btn-secondary" onclick={load} disabled={loading}>{loading ? '…' : '🔄 Neu laden'}</button>
      </div>
    </div>

    {#if loading && !profiles}
      <div class="ld-job"><div class="ld-step running"><span class="ld-spinner"></span> Lade Profile aus dem Tenant…</div></div>
    {:else if loadError}
      <div class="ld-job">
        <div class="ld-banner fail">{loadError}</div>
        {#if /DeviceManagementScripts|not authorized/i.test(loadError)}
          <div class="ld-step"><small>💡 Braucht die Graph-Permission <code>DeviceManagementScripts.ReadWrite.All</code> — im Tab „🏢 Tenants" einmal 🔧 Reparieren ausführen (danach ein paar Minuten Consent-Replikation abwarten).</small></div>
        {/if}
      </div>
    {:else if profiles}
      <div class="settings-group">
        <h4>Deployte Profile <small>({profiles.length})</small></h4>
        {#if !profiles.length}
          <p class="ld-section-hint">Noch keine Profile — oben eines anlegen.</p>
        {/if}
        {#each profiles as p (p.id)}
          {@const gnames = groupNames(p.groupIds)}
          <div class="step-card">
            <h4>💾 {p.profileName} {@render assignBadge(gnames)}</h4>
            <p class="mp-meta">
              {p.config ? `${p.config.mappings.length} Laufwerk${p.config.mappings.length === 1 ? '' : 'e'}` : '⚠️ Konfiguration nicht parsebar (manuell verändertes Skript?) — Bearbeiten überschreibt es'}{p.config?.removeStaleDrives ? ' · trennt nicht konfigurierte Laufwerke' : ''}{p.config?.searchRoot ? ` · AD: ${p.config.searchRoot}` : ''}{gnames.length ? ` · ${gnames.join(', ')}` : ''}
            </p>
            {#if p.config?.mappings.length}
              <details class="mp-details">
                <summary>Laufwerke anzeigen</summary>
                <div class="gt-table-wrap" style="margin-top:0.5rem;">
                  <table class="gt-table">
                    <thead><tr><th style="width:80px;">Laufwerk</th><th>Pfad</th><th>Anzeigename</th><th>AD-Filter</th></tr></thead>
                    <tbody>
                      {#each p.config.mappings as m}
                        <tr><td><code>{m.driveLetter}:</code></td><td><code>{m.path}</code></td><td>{m.label || '–'}</td><td>{m.groupFilter || '–'}</td></tr>
                      {/each}
                    </tbody>
                  </table>
                </div>
              </details>
            {/if}
            <div class="mp-actions">
              <button class="btn btn-secondary" onclick={() => editProfile(p)}>✏️ Bearbeiten / neu zuweisen</button>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  {:else}
    <div class="ld-job" style="margin-bottom:1.5rem;">
      <div class="ld-job-head"><strong>🗺️ Netzlaufwerk-Profil</strong>
        <button class="btn btn-secondary" style="padding:0.2rem 0.6rem; font-size:0.78rem;" onclick={() => (editorOpen = false)}>✕ Abbrechen</button></div>

      <div class="wizard-step" class:on={dmStep === 1}>
        {@render wizHead(1, 'Profil benennen', dmStep, dmJump, dmName ? `„${dmName}"` : null)}
        {#if dmStep === 1}
          <div class="wiz-body">
            <div class="input-group" style="max-width:320px;">
              <label for="dmName">Profilname</label>
              <input id="dmName" type="text" bind:value={profileName} placeholder="Standard" />
              <small>Skriptname in Intune: <code>{dmTarget || '…'}</code>{profileName.trim() && dmName !== profileName.trim() ? ' — Umlaute/Sonderzeichen werden entfernt' : ''}</small>
            </div>
            <div class="ld-confirm-actions">
              <button class="btn btn-primary" disabled={!dmName} onclick={() => dmJump(2)}>Weiter</button>
            </div>
          </div>
        {/if}
      </div>

      <div class="wizard-step" class:on={dmStep === 2}>
        {@render wizHead(2, 'Laufwerke definieren', dmStep, dmJump, dmContentOk ? `${mappings.filter(m => m.driveLetter && m.path.trim()).length} Laufwerk(e)` : null)}
        {#if dmStep === 2}
          <div class="wiz-body">
            <div style="overflow-x:auto;">
              <table class="map-table">
                <thead><tr><th style="width:90px;">Laufwerk</th><th>UNC-Pfad</th><th>Anzeigename</th><th>AD-Gruppenfilter (kommagetrennt)</th><th style="width:44px;"></th></tr></thead>
                <tbody>
                  {#each mappings as m, i}
                    <tr>
                      <td>
                        <select bind:value={m.driveLetter}>
                          <option value="">–</option>
                          {#each LETTERS as l}<option value={l}>{l}:</option>{/each}
                        </select>
                      </td>
                      <td><input type="text" bind:value={m.path} placeholder="\\server\share" /></td>
                      <td><input type="text" bind:value={m.label} placeholder="optional" /></td>
                      <td><input type="text" bind:value={m.groupFilter} placeholder="optional, nur hybrid" /></td>
                      <td><button class="btn btn-secondary map-remove" onclick={() => removeRow(i)} disabled={mappings.length <= 1} title="Zeile entfernen">✕</button></td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
            <div class="ld-oib-toolbar">
              <button class="btn btn-secondary" style="padding:0.25rem 0.7rem; font-size:0.8rem;" onclick={addRow}>+ Laufwerk</button>
              <button class="btn btn-secondary" style="padding:0.25rem 0.7rem; font-size:0.8rem;" onclick={() => (importOpen = !importOpen)}>{importOpen ? '✕ Import schließen' : '📥 Bestehendes Skript einlesen'}</button>
            </div>
            {#if importOpen}
              <div class="input-group" style="margin-bottom:0.75rem;">
                <label for="dmImport">Vorhandenes DriveMapping-Skript hier einfügen (aus Intune oder dem Original-Generator) — die Konfiguration wird herausgelesen und füllt die Tabelle:</label>
                <textarea id="dmImport" rows="5" bind:value={importText} placeholder="Inhalt der DriveMapping.ps1 einfügen…" style="font-family:var(--font-mono); font-size:0.78rem;"></textarea>
                <div><button class="btn btn-primary" onclick={importScript} disabled={!importText.trim()}>Einlesen</button></div>
                {#if importError}<div class="ld-banner fail">{importError}</div>{/if}
              </div>
            {/if}
            <div class="check-row">
              <input id="dmStale" type="checkbox" bind:checked={removeStaleDrives} />
              <div>
                <label class="cr-title" for="dmStale">Nicht (mehr) konfigurierte Netzlaufwerke automatisch trennen</label>
                <div class="cr-desc">Entfernt beim Anmelden alle gemappten Laufwerke, die nicht in dieser Liste stehen.</div>
              </div>
            </div>
            <div class="input-group" style="max-width:360px; margin-top:0.4rem;">
              <label for="dmSearchRoot">AD-Domäne überschreiben (optional)</label>
              <input id="dmSearchRoot" type="text" bind:value={searchRoot} placeholder="z.B. ad.firma.ch" />
              <small>Nur nötig, wenn der Gruppenfilter genutzt wird und die Domäne nicht per DHCP verteilt ist.</small>
            </div>
            <div class="ld-confirm-actions">
              <button class="btn btn-primary" disabled={!dmContentOk} onclick={() => dmJump(3)}>Weiter</button>
            </div>
          </div>
        {/if}
      </div>

      <div class="wizard-step" class:on={dmStep === 3}>
        {@render wizHead(3, 'Gruppen zuweisen', dmStep, dmJump, dmStep > 3 || selNames(selGroups).length ? `${selNames(selGroups).length} Gruppe(n)` : null)}
        {#if dmStep === 3}
          <div class="wiz-body">
            {@render groupPicker(selGroups, (id, v) => (selGroups = { ...selGroups, [id]: v }))}
            <div class="ld-confirm-actions">
              <button class="btn btn-primary" onclick={() => dmJump(4)}>Weiter zur Vorschau</button>
            </div>
          </div>
        {/if}
      </div>

      <div class="wizard-step" class:on={dmStep === 4}>
        {@render wizHead(4, 'Prüfen & deployen', dmStep, dmJump, null)}
        {#if dmStep === 4}
          <div class="wiz-body">
            <div class="gt-table-wrap" style="margin-bottom:0.6rem;">
              <table class="gt-table"><tbody>
                <tr><td style="width:160px;">Intune-Objekt</td><td><code>{dmTarget}</code> (PowerShell-Plattformskript)</td></tr>
                <tr><td>Ausführung</td><td>Als SYSTEM; registriert einen Logon-Task, der die Laufwerke pro Benutzer verbindet</td></tr>
                <tr><td>Inhalt</td><td>{mappings.filter(m => m.driveLetter && m.path.trim()).map(m => `${m.driveLetter}: → ${m.path}`).join(' · ')}{removeStaleDrives ? ' · trennt nicht konfigurierte Laufwerke' : ''}{searchRoot ? ` · AD-Domäne: ${searchRoot}` : ''}</td></tr>
                <tr><td>Zuweisung</td><td>{selNames(selGroups).length ? selNames(selGroups).join(', ') : '⚠️ keine — Profil wird ohne Zuweisung angelegt'}</td></tr>
              </tbody></table>
            </div>
            {@render scriptPreview(dmPreview)}
            <div class="ld-confirm-actions">
              <button class="btn btn-primary" onclick={save} disabled={saving || dmPreview?.loading || !!dmPreview?.error}>
                {saving ? 'Deploye…' : '🚀 Profil deployen'}
              </button>
              <button class="btn btn-secondary" onclick={downloadScript} disabled={!dmPreview?.script}>💾 Skript herunterladen (ohne Deploy)</button>
            </div>
          </div>
        {/if}
      </div>
    </div>
  {/if}

  </div>

  <!-- ======================= Drucker ======================= -->
  <div class="map-panel" class:tab-hidden={subTab !== 'printers'}>

  {#if pmJob}
    <div class="ld-job" style="margin-bottom:1rem;">
      {#if pmJob.status === 'failed'}
        <div class="ld-banner fail">{pmJob.error}</div>
        {#if pmJob.hint}<div class="ld-step"><small>💡 {pmJob.hint}</small></div>{/if}
      {:else if pmJob.status === 'done'}
        <div class="ld-banner ok">„{pmJob.results?.displayName}" {pmJob.results?.updated ? 'aktualisiert' : 'ausgerollt'}{pmJob.results?.app ? ` · Store-App ${pmJob.results.app.created ? 'angelegt' : 'war vorhanden'} und zugewiesen` : ''}.</div>
        <div class="ld-banner warn"><b>Ein manueller Schritt bleibt</b> (einmal pro Tenant): Die App startet erst automatisch, wenn sie in einer Geräterestriktions-Richtlinie als erlaubte Autostart-App eingetragen ist —
          <code>{pmData?.autostartPfn}</code>
          <button class="btn btn-secondary" style="padding:0.15rem 0.5rem; font-size:0.78rem;" onclick={pmCopyPfn}>{pmPfnCopied ? '✓ Kopiert' : '📋 Kopieren'}</button>
        </div>
      {/if}
      {#each pmJob.steps as s}
        {#if s.state === 'running'}
          <div class="ld-step running"><span class="ld-spinner"></span> {s.name}</div>
        {:else if s.state === 'done'}
          <div class="ld-step ok"><span class="ld-ico">✅</span> {s.name}</div>
        {/if}
      {/each}
    </div>
  {/if}

  {#if !pmEditorOpen}
    <div class="settings-group">
      <h4>Drucker-Mappings <small>(Weatherlights Intune Printer Mapping)</small></h4>
      <p class="ld-section-hint">Hier definierst du, welche On-Prem-Netzwerkdrucker auf den Intune-Geräten automatisch verbunden werden — per ADMX-Richtlinie plus Store-App, ganz ohne eigenes Skript.</p>
      <p class="ld-section-hint"><small>💡 Ablauf: <span class="step-n">1</span> Profil benennen → <span class="step-n">2</span> Drucker definieren → <span class="step-n">3</span> Gruppen zuweisen → <span class="step-n">4</span> Prüfen &amp; ausrollen.</small></p>
      <details class="map-info"><summary>Wie funktioniert das technisch?</summary>
        <p class="ld-section-hint">Verbindet On-Prem-Netzwerkdrucker per <a href="https://github.com/Weatherlights/Intune-Printer-Mapping-Tool/wiki" target="_blank" rel="noopener">Intune-Printer-Mapping-Tool</a>: die ADMX-Vorlage wird automatisch importiert, das Konfigurationsprofil (inkl. Pflicht-Schalter) angelegt und die Store-App auf Wunsch gleich mit deployt. Voraussetzungen laut Wiki: Seamless SSO/Cloud Kerberos Trust, Druckertreiber auf den Geräten, Druckberechtigungen.</p></details>
      <div style="display:flex; gap:0.5rem; flex-wrap:wrap; margin-top:0.5rem;">
        <button class="btn btn-primary" onclick={pmNew}>➕ Neues Drucker-Profil</button>
        <button class="btn btn-secondary" onclick={pmLoad} disabled={pmLoading}>{pmLoading ? '…' : '🔄 Neu laden'}</button>
      </div>
    </div>

    {#if pmLoading && !pmData}
      <div class="ld-job"><div class="ld-step running"><span class="ld-spinner"></span> Lade Drucker-Profile…</div></div>
    {:else if pmError}
      <div class="ld-job"><div class="ld-banner fail">{pmError}</div></div>
    {:else if pmData}
      <div class="settings-group">
        <h4>Deployte Drucker-Profile <small>({pmData.profiles.length})</small></h4>
        {#if !pmData.profiles.length}
          <p class="ld-section-hint">Noch keine Drucker-Profile — oben eines anlegen.</p>
        {/if}
        {#each pmData.profiles as p (p.id)}
          {@const gnames = groupNames(p.groupIds)}
          <div class="step-card">
            <h4>🖨️ {p.profileName} {@render assignBadge(gnames)}</h4>
            <p class="mp-meta">
              {p.printers.length} Drucker · {p.scope === 'machine' ? 'Geräte-Kontext' : 'Benutzer-Kontext'}{p.enabled ? '' : ' · ⚠️ Enable-Schalter fehlt!'}{gnames.length ? ` · ${gnames.join(', ')}` : ''}
            </p>
            {#if p.printers.length}
              <details class="mp-details">
                <summary>Drucker anzeigen</summary>
                <div class="gt-table-wrap" style="margin-top:0.5rem;">
                  <table class="gt-table">
                    <thead><tr><th>Druckerpfad</th><th style="width:120px;">Aktion</th><th style="width:100px;">Standard</th></tr></thead>
                    <tbody>
                      {#each p.printers as pr}
                        <tr><td><code>{pr.path}</code></td><td>{pr.operation === 'Delete' ? '🗑️ entfernen' : 'verbinden'}</td><td>{pr.setDefault ? '⭐ ja' : '–'}</td></tr>
                      {/each}
                    </tbody>
                  </table>
                </div>
              </details>
            {/if}
            <div class="mp-actions">
              <button class="btn btn-secondary" onclick={() => pmEdit(p)}>✏️ Bearbeiten / neu zuweisen</button>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  {:else}
    <div class="ld-job" style="margin-bottom:1.5rem;">
      <div class="ld-job-head"><strong>🖨️ Drucker-Profil</strong>
        <button class="btn btn-secondary" style="padding:0.2rem 0.6rem; font-size:0.78rem;" onclick={() => (pmEditorOpen = false)}>✕ Abbrechen</button></div>

      <div class="wizard-step" class:on={pmStep === 1}>
        {@render wizHead(1, 'Profil benennen', pmStep, pmJump, pmSafeName ? `„${pmSafeName}" · ${pmScope === 'machine' ? 'Geräte' : 'Benutzer'}-Kontext` : null)}
        {#if pmStep === 1}
          <div class="wiz-body">
            <div class="ld-oib-target">
              <div class="input-group" style="max-width:280px;">
                <label for="pmName">Profilname</label>
                <input id="pmName" type="text" bind:value={pmName} placeholder="Buero EG" />
                <small>Profil in Intune: <code>{pmTarget || '…'}</code>{pmName.trim() && pmSafeName !== pmName.trim() ? ' — Umlaute/Sonderzeichen werden entfernt' : ''}</small>
              </div>
              <div class="input-group" style="max-width:220px;">
                <label for="pmScope">Kontext</label>
                <select id="pmScope" bind:value={pmScope}>
                  <option value="user">Benutzer (empfohlen)</option>
                  <option value="machine">Gerät (alle Benutzer)</option>
                </select>
              </div>
            </div>
            <div class="ld-confirm-actions">
              <button class="btn btn-primary" disabled={!pmSafeName} onclick={() => pmJump(2)}>Weiter</button>
            </div>
          </div>
        {/if}
      </div>

      <div class="wizard-step" class:on={pmStep === 2}>
        {@render wizHead(2, 'Drucker definieren', pmStep, pmJump, pmContentOk ? `${pmPrinters.filter(p => p.path.trim()).length} Drucker` : null)}
        {#if pmStep === 2}
          <div class="wiz-body">
            <div style="overflow-x:auto;">
              <table class="map-table">
                <thead><tr><th>Druckerpfad (UNC)</th><th style="width:140px;">Aktion</th><th style="width:120px;">Standard</th><th style="width:44px;"></th></tr></thead>
                <tbody>
                  {#each pmPrinters as p, i}
                    <tr>
                      <td><input type="text" bind:value={p.path} placeholder="\\printserver\Drucker" /></td>
                      <td>
                        <select bind:value={p.operation}>
                          <option value="Add">Verbinden</option>
                          <option value="Delete">Entfernen</option>
                        </select>
                      </td>
                      <td style="text-align:center;"><input type="checkbox" bind:checked={p.setDefault} title="Als Standarddrucker setzen" /></td>
                      <td><button class="btn btn-secondary map-remove" onclick={() => pmRemoveRow(i)} disabled={pmPrinters.length <= 1} title="Zeile entfernen">✕</button></td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
            <div class="ld-oib-toolbar">
              <button class="btn btn-secondary" style="padding:0.25rem 0.7rem; font-size:0.8rem;" onclick={pmAddRow} disabled={pmPrinters.length >= (pmData?.maxPrinters || 15)}>+ Drucker ({pmPrinters.length}/{pmData?.maxPrinters || 15})</button>
            </div>
            <div class="check-row">
              <input id="pmDeployApp" type="checkbox" bind:checked={pmDeployApp} />
              <div>
                <label class="cr-title" for="pmDeployApp">Store-App „Intune Printer Mapping" automatisch mit deployen</label>
                <div class="cr-desc">Als Required-App an dieselben Gruppen — ohne die App mappt die Richtlinie nichts.</div>
              </div>
            </div>
            <div class="ld-confirm-actions">
              <button class="btn btn-primary" disabled={!pmContentOk} onclick={() => pmJump(3)}>Weiter</button>
            </div>
          </div>
        {/if}
      </div>

      <div class="wizard-step" class:on={pmStep === 3}>
        {@render wizHead(3, 'Gruppen zuweisen', pmStep, pmJump, pmStep > 3 || selNames(pmSelGroups).length ? `${selNames(pmSelGroups).length} Gruppe(n)` : null)}
        {#if pmStep === 3}
          <div class="wiz-body">
            {@render groupPicker(pmSelGroups, (id, v) => (pmSelGroups = { ...pmSelGroups, [id]: v }))}
            <div class="ld-confirm-actions">
              <button class="btn btn-primary" onclick={() => pmJump(4)}>Weiter zur Vorschau</button>
            </div>
          </div>
        {/if}
      </div>

      <div class="wizard-step" class:on={pmStep === 4}>
        {@render wizHead(4, 'Prüfen & ausrollen', pmStep, pmJump, null)}
        {#if pmStep === 4}
          <div class="wiz-body">
            <div class="gt-table-wrap" style="margin-bottom:0.6rem;">
              <table class="gt-table"><tbody>
                <tr><td style="width:160px;">Intune-Objekt</td><td><code>{pmTarget}</code> (Imported-ADMX-Konfigurationsprofil; die ADMX-Vorlage wird bei Bedarf einmalig importiert)</td></tr>
                <tr><td>Kontext</td><td>{pmScope === 'machine' ? 'Gerät (alle Benutzer)' : 'Benutzer'}</td></tr>
                <tr><td>Inhalt</td><td>{pmPrinters.filter(p => p.path.trim()).map(p => `${p.operation === 'Delete' ? '🗑️' : '🖨️'} ${p.path}${p.setDefault ? ' (Standard)' : ''}`).join(' · ')}</td></tr>
                <tr><td>Store-App</td><td>{pmDeployApp ? 'Wird als Required-App an dieselben Gruppen mit deployt' : 'Wird NICHT mit deployt (muss auf den Geräten vorhanden sein)'}</td></tr>
                <tr><td>Zuweisung</td><td>{selNames(pmSelGroups).length ? selNames(pmSelGroups).join(', ') : '⚠️ keine — Profil wird ohne Zuweisung angelegt'}</td></tr>
              </tbody></table>
            </div>
            {#if pmInvalidPaths}
              <div class="ld-banner fail">{pmInvalidPaths} Druckerpfad(e) sind keine UNC-Pfade (<code>\\printserver\Drucker</code>) — in Schritt 2 korrigieren.</div>
            {/if}
            <div class="ld-step"><small>⚠️ Danach bleibt ein manueller Schritt (einmal pro Tenant): die App-PFN <code>{pmData?.autostartPfn}</code> als erlaubte Autostart-App in einer Geräterestriktions-Richtlinie eintragen. Treiber + Druckberechtigungen sind Voraussetzung.</small></div>
            <div class="ld-confirm-actions">
              <button class="btn btn-primary" onclick={pmSave} disabled={pmBusy || !!pmInvalidPaths || !pmContentOk}>
                {pmBusy ? 'Rolle aus…' : '🚀 Drucker-Profil ausrollen'}
              </button>
            </div>
          </div>
        {/if}
      </div>
    </div>
  {/if}

  </div>

  <!-- ======================= SharePoint-Sync ======================= -->
  <div class="map-panel" class:tab-hidden={subTab !== 'sharepoint'}>

  {#if spSaveMsg}
    <div class="ld-banner {spSaveMsg.ok ? 'ok' : 'fail'}" style="margin-bottom:1rem;">{spSaveMsg.text}</div>
  {/if}

  {#if !spEditorOpen}
    <div class="settings-group">
      <h4>SharePoint-Sync-Mappings <small>(OneDrive „Configure team site libraries to sync automatically")</small></h4>
      <p class="ld-section-hint">Hier wählst du SharePoint-Bibliotheken aus, die OneDrive auf den Geräten automatisch synchronisiert — ohne dass Nutzer die Site je besuchen müssen.</p>
      <p class="ld-section-hint"><small>💡 Ablauf: <span class="step-n">1</span> Profil benennen → <span class="step-n">2</span> Bibliotheken wählen → <span class="step-n">3</span> Gruppen zuweisen → <span class="step-n">4</span> Vorschau prüfen &amp; deployen.</small></p>
      <details class="map-info"><summary>Wie funktioniert das technisch?</summary>
        <p class="ld-section-hint">Erzeugt ein PowerShell-Plattformskript (Benutzerkontext), das die gewählten Bibliotheken als OneDrive-Richtlinie „Configure team site libraries to sync automatically" nach <code>HKCU</code> schreibt. OneDrive übernimmt sie beim nächsten Anmelden (Fenster bis zu 8h). Voraussetzung: OneDrive Files On-Demand ist im Tenant aktiv.</p></details>
      <div style="display:flex; gap:0.5rem; flex-wrap:wrap; margin-top:0.5rem;">
        <button class="btn btn-primary" onclick={spNew}>➕ Neues Sync-Profil</button>
        <button class="btn btn-secondary" onclick={spLoad} disabled={spLoading}>{spLoading ? '…' : '🔄 Neu laden'}</button>
      </div>
    </div>

    {#if spLoading && !spProfiles}
      <div class="ld-job"><div class="ld-step running"><span class="ld-spinner"></span> Lade Sync-Profile…</div></div>
    {:else if spError}
      <div class="ld-job"><div class="ld-banner fail">{spError}</div></div>
    {:else if spProfiles}
      <div class="settings-group">
        <h4>Deployte Sync-Profile <small>({spProfiles.length})</small></h4>
        {#if !spProfiles.length}
          <p class="ld-section-hint">Noch keine Sync-Profile — oben eines anlegen.</p>
        {/if}
        {#each spProfiles as p (p.id)}
          {@const gnames = groupNames(p.groupIds)}
          {@const libs = p.config?.mappings || []}
          <div class="step-card">
            <h4>☁️ {p.profileName} {@render assignBadge(gnames)}</h4>
            <p class="mp-meta">
              {libs.length ? `${libs.length} Bibliothek${libs.length === 1 ? '' : 'en'}` : '⚠️ Konfiguration nicht parsebar — Bearbeiten überschreibt sie'}{gnames.length ? ` · ${gnames.join(', ')}` : ''}
            </p>
            {#if libs.length}
              <details class="mp-details">
                <summary>Bibliotheken anzeigen</summary>
                <div class="gt-table-wrap" style="margin-top:0.5rem;">
                  <table class="gt-table">
                    <thead><tr><th>Bezeichnung</th><th>Site</th></tr></thead>
                    <tbody>
                      {#each libs as m}
                        <tr><td>📁 {m.libraryName}</td><td><a href={m.webUrl} target="_blank" rel="noopener" title={m.webUrl}>{sitePath(m.webUrl)}</a></td></tr>
                      {/each}
                    </tbody>
                  </table>
                </div>
              </details>
            {/if}
            <div class="mp-actions">
              <button class="btn btn-secondary" onclick={() => spEdit(p)}>✏️ Bearbeiten / neu zuweisen</button>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  {:else}
    <div class="ld-job" style="margin-bottom:1.5rem;">
      <div class="ld-job-head"><strong>☁️ SharePoint-Sync-Profil</strong>
        <button class="btn btn-secondary" style="padding:0.2rem 0.6rem; font-size:0.78rem;" onclick={() => (spEditorOpen = false)}>✕ Abbrechen</button></div>

      <div class="wizard-step" class:on={spStep === 1}>
        {@render wizHead(1, 'Profil benennen', spStep, spJump, spSafeName ? `„${spSafeName}"` : null)}
        {#if spStep === 1}
          <div class="wiz-body">
            <div class="input-group" style="max-width:280px;">
              <label for="spName">Profilname</label>
              <input id="spName" type="text" bind:value={spProfileName} placeholder="Standard" />
              <small>Skriptname in Intune: <code>{spTarget || '…'}</code>{spProfileName.trim() && spSafeName !== spProfileName.trim() ? ' — Umlaute/Sonderzeichen werden entfernt' : ''}</small>
            </div>
            <div class="ld-confirm-actions">
              <button class="btn btn-primary" disabled={!spSafeName} onclick={() => spJump(2)}>Weiter</button>
            </div>
          </div>
        {/if}
      </div>

      <div class="wizard-step" class:on={spStep === 2}>
        {@render wizHead(2, 'Bibliotheken wählen', spStep, spJump, spMappings.length ? `${spMappings.length} Bibliothek(en)` : null)}
        {#if spStep === 2}
          <div class="wiz-body">
            <div class="input-group" style="max-width:420px;">
              <label for="spSiteFilter">SharePoint-Sites hinzufügen (Mehrfachauswahl möglich)</label>
              <input id="spSiteFilter" type="text" bind:value={spSiteFilter} placeholder={spSitesLoading ? 'Lade Sites…' : 'Filtern nach Name…'} disabled={spSitesLoading} />
            </div>

            {#if spSitesError}
              <div class="ld-banner fail" style="margin-top:0.5rem;">Sites konnten nicht geladen werden: {spSitesError}<br /><small>Falls „Reparieren" seit dem letzten Update dieser Funktion nicht ausgeführt wurde: im Tab „Tenants" einmal „🔧 Reparieren" ausführen (neue Berechtigung Sites.Read.All).</small></div>
            {:else if !spSitesLoading}
              <div class="ld-oib-toolbar" style="margin-top:0.5rem;">
                <span>{spSelSiteCount} ausgewählt · {spFilteredSites.length} sichtbar</span>
                <button class="btn btn-secondary" style="padding:0.25rem 0.7rem; font-size:0.8rem;" onclick={() => spToggleAllFiltered(true)}>Alle (sichtbar)</button>
                <button class="btn btn-secondary" style="padding:0.25rem 0.7rem; font-size:0.8rem;" onclick={() => spToggleAllFiltered(false)}>Keine</button>
              </div>
              <div class="ld-phase complete" style="max-height:260px; overflow-y:auto;">
                {#each spFilteredSites as s (s.id)}
                  {@const already = spAlreadyAddedIds.has(s.id)}
                  <label class="ld-oib-row" class:already>
                    <input type="checkbox" checked={!!spSelSites[s.id]} disabled={already}
                           onchange={(e) => (spSelSites = { ...spSelSites, [s.id]: e.target.checked })} />
                    <span class="ld-oib-name">{s.displayName}</span>
                    <small class="ld-oib-assigned">{already ? '✓ bereits hinzugefügt' : s.webUrl}</small>
                  </label>
                {/each}
                {#if !spFilteredSites.length}<p class="ld-section-hint">Keine Sites gefunden.</p>{/if}
              </div>
              <div class="ld-oib-target" style="margin-top:0.5rem;">
                <button class="btn btn-secondary" onclick={spResolveAndAddSelected} disabled={!spSelSiteCount || spResolving}>
                  {spResolving ? 'Löse auf…' : `+ ${spSelSiteCount} ausgewählte hinzufügen`}
                </button>
              </div>
            {/if}
            {#if spResolveError}<div class="ld-banner fail" style="margin-top:0.5rem;">{spResolveError}</div>{/if}

            {#if spMappings.length}
              <div style="overflow-x:auto; margin-top:0.75rem;">
                <table class="map-table">
                  <thead><tr><th>Bezeichnung</th><th>Site</th><th style="width:44px;"></th></tr></thead>
                  <tbody>
                    {#each spMappings as m, i}
                      <tr>
                        <td><input type="text" bind:value={m.libraryName} placeholder="Marketing-Dokumente" /></td>
                        <td><small>{m.webUrl}</small></td>
                        <td><button class="btn btn-secondary map-remove" onclick={() => spRemoveRow(i)} title="Zeile entfernen">✕</button></td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            {:else}
              <p class="ld-section-hint" style="margin-top:0.75rem;">Noch keine Bibliothek hinzugefügt — oben eine Site wählen.</p>
            {/if}
            <div class="ld-confirm-actions">
              <button class="btn btn-primary" disabled={!spMappings.length} onclick={() => spJump(3)}>Weiter</button>
            </div>
          </div>
        {/if}
      </div>

      <div class="wizard-step" class:on={spStep === 3}>
        {@render wizHead(3, 'Gruppen zuweisen', spStep, spJump, spStep > 3 || selNames(spSelGroups).length ? `${selNames(spSelGroups).length} Gruppe(n)` : null)}
        {#if spStep === 3}
          <div class="wiz-body">
            {@render groupPicker(spSelGroups, (id, v) => (spSelGroups = { ...spSelGroups, [id]: v }))}
            <div class="ld-confirm-actions">
              <button class="btn btn-primary" onclick={() => spJump(4)}>Weiter zur Vorschau</button>
            </div>
          </div>
        {/if}
      </div>

      <div class="wizard-step" class:on={spStep === 4}>
        {@render wizHead(4, 'Prüfen & deployen', spStep, spJump, null)}
        {#if spStep === 4}
          <div class="wiz-body">
            <div class="gt-table-wrap" style="margin-bottom:0.6rem;">
              <table class="gt-table"><tbody>
                <tr><td style="width:160px;">Intune-Objekt</td><td><code>{spTarget}</code> (PowerShell-Plattformskript)</td></tr>
                <tr><td>Ausführung</td><td>Im Benutzerkontext; schreibt die Bibliotheken nach <code>HKCU</code>, OneDrive übernimmt sie beim nächsten Anmelden (bis zu 8h)</td></tr>
                <tr><td>Inhalt</td><td>{spMappings.map(m => m.libraryName).join(' · ')}</td></tr>
                <tr><td>Zuweisung</td><td>{selNames(spSelGroups).length ? selNames(spSelGroups).join(', ') : '⚠️ keine — Profil wird ohne Zuweisung angelegt'}</td></tr>
              </tbody></table>
            </div>
            {@render scriptPreview(spPreview)}
            <div class="ld-confirm-actions">
              <button class="btn btn-primary" onclick={spSave} disabled={spSaving || !spMappings.length || spPreview?.loading || !!spPreview?.error}>
                {spSaving ? 'Rolle aus…' : '🚀 Sync-Profil ausrollen'}
              </button>
            </div>
          </div>
        {/if}
      </div>
    </div>
  {/if}

  </div>

  <!-- ======================= Registry ======================= -->
  <div class="map-panel" class:tab-hidden={subTab !== 'registry'}>

  {#if rpSaveMsg}
    <div class="ld-banner {rpSaveMsg.ok ? 'ok' : 'fail'}" style="margin-bottom:1rem;">{rpSaveMsg.text}</div>
  {/if}

  {#if !rpEditorOpen}
    <div class="settings-group">
      <h4>Registry-Richtlinien <small>(HKLM, generisch + Vorlagen)</small></h4>
      <p class="ld-section-hint">Hier setzt du einzelne Registry-Werte auf den Geräten — für Richtlinien, die (noch) nicht im Settings Catalog auftauchen, oder simple Ein-Wert-Schalter.</p>
      <p class="ld-section-hint"><small>💡 Ablauf: <span class="step-n">1</span> Profil benennen → <span class="step-n">2</span> Werte definieren (oder Vorlage übernehmen) → <span class="step-n">3</span> Gruppen zuweisen → <span class="step-n">4</span> Vorschau prüfen &amp; deployen.</small></p>
      <details class="map-info"><summary>Wie funktioniert das technisch?</summary>
        <p class="ld-section-hint">Erzeugt ein PowerShell-Plattformskript, das im Systemkontext (SYSTEM) direkt unter <code>HKLM</code> schreibt — gleicher Mechanismus wie die anderen Mapping-Bereiche, nur ohne ADMX/Settings-Catalog-Abhängigkeit.</p></details>

      <div class="alert alert-info">
        <strong>ℹ️ Neu: EU-DMA-SSO-Prompt automatisch akzeptieren.</strong> Mit dem Sicherheitsupdate vom Juli 2026 (<a href="https://support.microsoft.com/en-us/servicing/os/windows-11/2026/07/july-14-2026-kb5101650-os-builds-26200-8875-and-26100-8875" target="_blank" rel="noopener">KB5101650</a>, Windows&nbsp;11 24H2/25H2) zeigt Windows in der EU/EWR nach der Windows-Anmeldung erstmalig pro App eine SSO-Rückfrage („Weiter anmelden?"), bevor die Windows-Anmeldedaten auch für andere Microsoft-Apps/-Dienste verwendet werden dürfen — eine Folge des EU Digital Markets Act. Für verwaltete Geräte mit Entra-ID-Konto lässt sich diese Abfrage per Registry-Richtlinie automatisch bestätigen: <code>HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\AAD</code> → <code>AutoAcceptSsoPermission</code> (DWORD) = <code>1</code>. Gilt <b>nicht</b> für private Microsoft-Konten (MSA) oder unverwaltete Geräte — dort bleibt der Prompt bestehen. Vorlage im Konfigurator per Klick übernehmbar.
      </div>

      <div style="display:flex; gap:0.5rem; flex-wrap:wrap; margin-top:0.75rem;">
        <button class="btn btn-primary" onclick={rpNew}>➕ Neues Profil</button>
        <button class="btn btn-secondary" onclick={rpLoad} disabled={rpLoading}>{rpLoading ? '…' : '🔄 Neu laden'}</button>
      </div>
    </div>

    {#if rpLoading && !rpProfiles}
      <div class="ld-job"><div class="ld-step running"><span class="ld-spinner"></span> Lade Registry-Profile…</div></div>
    {:else if rpError}
      <div class="ld-job"><div class="ld-banner fail">{rpError}</div></div>
    {:else if rpProfiles}
      <div class="settings-group">
        <h4>Deployte Registry-Profile <small>({rpProfiles.length})</small></h4>
        {#if !rpProfiles.length}
          <p class="ld-section-hint">Noch keine Registry-Profile — oben eines anlegen.</p>
        {/if}
        {#each rpProfiles as p (p.id)}
          {@const gnames = groupNames(p.groupIds)}
          {@const entries = p.config?.entries || []}
          <div class="step-card">
            <h4>🔑 {p.profileName} {@render assignBadge(gnames)}</h4>
            <p class="mp-meta">
              {entries.length ? `${entries.length} Registry-Wert${entries.length === 1 ? '' : 'e'}` : '⚠️ Konfiguration nicht parsebar — Bearbeiten überschreibt sie'}{gnames.length ? ` · ${gnames.join(', ')}` : ''}
            </p>
            {#if entries.length}
              <details class="mp-details">
                <summary>Werte anzeigen</summary>
                <div class="gt-table-wrap" style="margin-top:0.5rem;">
                  <table class="gt-table">
                    <thead><tr><th>Pfad (HKLM:\)</th><th>Name</th><th style="width:90px;">Typ</th><th style="width:120px;">Wert</th></tr></thead>
                    <tbody>
                      {#each entries as e}
                        <tr><td><code>{e.path}</code></td><td>{e.name}</td><td>{e.type}</td><td><code>{e.value}</code></td></tr>
                      {/each}
                    </tbody>
                  </table>
                </div>
              </details>
            {/if}
            <div class="mp-actions">
              <button class="btn btn-secondary" onclick={() => rpEdit(p)}>✏️ Bearbeiten / neu zuweisen</button>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  {:else}
    <div class="ld-job" style="margin-bottom:1.5rem;">
      <div class="ld-job-head"><strong>🖥️ Registry-Profil</strong>
        <button class="btn btn-secondary" style="padding:0.2rem 0.6rem; font-size:0.78rem;" onclick={() => (rpEditorOpen = false)}>✕ Abbrechen</button></div>

      <div class="wizard-step" class:on={rpStep === 1}>
        {@render wizHead(1, 'Profil benennen', rpStep, rpJump, rpSafeName ? `„${rpSafeName}"` : null)}
        {#if rpStep === 1}
          <div class="wiz-body">
            <div class="input-group" style="max-width:320px;">
              <label for="rpName">Profilname</label>
              <input id="rpName" type="text" bind:value={rpProfileName} placeholder="Standard" />
              <small>Skriptname in Intune: <code>{rpTarget || '…'}</code>{rpProfileName.trim() && rpSafeName !== rpProfileName.trim() ? ' — Umlaute/Sonderzeichen werden entfernt' : ''}</small>
            </div>
            <div class="ld-confirm-actions">
              <button class="btn btn-primary" disabled={!rpSafeName} onclick={() => rpJump(2)}>Weiter</button>
            </div>
          </div>
        {/if}
      </div>

      <div class="wizard-step" class:on={rpStep === 2}>
        {@render wizHead(2, 'Registry-Werte definieren', rpStep, rpJump, rpContentOk ? `${rpEntries.length} Wert(e)` : null)}
        {#if rpStep === 2}
          <div class="wiz-body">
            {#if rpPresets.length}
              <div style="display:flex; gap:0.5rem; flex-wrap:wrap; margin-bottom:0.75rem;">
                {#each rpPresets as preset (preset.key)}
                  <button class="btn btn-secondary" title={preset.description} onclick={() => rpApplyPreset(preset)}>📋 Vorlage: {preset.label}</button>
                {/each}
              </div>
            {/if}

            {#if rpEntries.length}
              <div style="overflow-x:auto;">
                <table class="map-table">
                  <thead><tr><th>Pfad (unter HKLM:\)</th><th>Name</th><th style="width:100px;">Typ</th><th>Wert</th><th style="width:44px;"></th></tr></thead>
                  <tbody>
                    {#each rpEntries as e, i}
                      <tr>
                        <td><input type="text" bind:value={e.path} placeholder="SOFTWARE\Policies\Microsoft\Windows\AAD" /></td>
                        <td><input type="text" bind:value={e.name} placeholder="AutoAcceptSsoPermission" /></td>
                        <td>
                          <select bind:value={e.type}>
                            <option value="DWORD">DWORD</option>
                            <option value="QWORD">QWORD</option>
                            <option value="String">String</option>
                          </select>
                        </td>
                        <td><input type="text" bind:value={e.value} placeholder="1" /></td>
                        <td><button class="btn btn-secondary map-remove" onclick={() => rpRemoveRow(i)} title="Zeile entfernen">✕</button></td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            {:else}
              <p class="ld-section-hint">Noch kein Registry-Wert hinzugefügt — Vorlage übernehmen oder manuell anlegen.</p>
            {/if}
            <button class="btn btn-secondary" style="margin-top:0.5rem;" onclick={rpAddRow}>+ Zeile hinzufügen</button>
            <div class="ld-confirm-actions">
              <button class="btn btn-primary" disabled={!rpContentOk} onclick={() => rpJump(3)}>Weiter</button>
            </div>
          </div>
        {/if}
      </div>

      <div class="wizard-step" class:on={rpStep === 3}>
        {@render wizHead(3, 'Gruppen zuweisen', rpStep, rpJump, rpStep > 3 || selNames(rpSelGroups).length ? `${selNames(rpSelGroups).length} Gruppe(n)` : null)}
        {#if rpStep === 3}
          <div class="wiz-body">
            {@render groupPicker(rpSelGroups, (id, v) => (rpSelGroups = { ...rpSelGroups, [id]: v }))}
            <div class="ld-confirm-actions">
              <button class="btn btn-primary" onclick={() => rpJump(4)}>Weiter zur Vorschau</button>
            </div>
          </div>
        {/if}
      </div>

      <div class="wizard-step" class:on={rpStep === 4}>
        {@render wizHead(4, 'Prüfen & deployen', rpStep, rpJump, null)}
        {#if rpStep === 4}
          <div class="wiz-body">
            <div class="gt-table-wrap" style="margin-bottom:0.6rem;">
              <table class="gt-table"><tbody>
                <tr><td style="width:160px;">Intune-Objekt</td><td><code>{rpTarget}</code> (PowerShell-Plattformskript)</td></tr>
                <tr><td>Ausführung</td><td>Als SYSTEM; schreibt direkt unter <code>HKLM</code> auf dem Gerät</td></tr>
                <tr><td>Inhalt</td><td>{rpEntries.map(e => `${e.name} = ${e.value} (${e.type})`).join(' · ')}</td></tr>
                <tr><td>Zuweisung</td><td>{selNames(rpSelGroups).length ? selNames(rpSelGroups).join(', ') : '⚠️ keine — Profil wird ohne Zuweisung angelegt'}</td></tr>
              </tbody></table>
            </div>
            {@render scriptPreview(rpPreview)}
            <div class="ld-confirm-actions">
              <button class="btn btn-primary" onclick={rpSave} disabled={rpSaving || !rpEntries.length || rpPreview?.loading || !!rpPreview?.error}>
                {rpSaving ? 'Rolle aus…' : '🚀 Registry-Profil ausrollen'}
              </button>
            </div>
          </div>
        {/if}
      </div>
    </div>
  {/if}

  </div>
</TenantContext>

<style>
  /* Glue fuer den Schritt-Wizard: die Grundklassen (wizard-step, step-n,
     wizard-step-title) kommen aus app.css, hier nur Aktiv/Inaktiv-Zustand. */
  .wizard-step { display: block; opacity: 0.65; }
  .wizard-step.on { opacity: 1; }
  .wiz-head {
    display: flex; align-items: center; gap: 0.55rem; width: 100%;
    background: none; border: 0; padding: 0; font: inherit;
    color: var(--text); cursor: pointer; text-align: left;
  }
  .wizard-step.on .wiz-head { cursor: default; }
  .wizard-step.on .wiz-head .wizard-step-title { color: var(--accent); }
  .wiz-summary { color: var(--text-dim); }
  /* Profil-Karten in den Uebersichten (step-card kommt aus app.css) */
  .mp-meta { font-size: 0.8rem; color: var(--text-dim); margin: -0.2rem 0 0.35rem; line-height: 1.45; }
  .mp-details > summary { cursor: pointer; font-size: 0.8rem; color: var(--accent); }
  .mp-details > summary:hover { color: var(--accent-strong); }
  .mp-actions { margin-top: 0.6rem; }
  .mp-actions .btn { padding: 0.3rem 0.7rem; font-size: 0.8rem; }
  .wiz-body { margin-top: 0.6rem; padding-left: 2rem; }
  .wiz-script {
    max-height: 320px; overflow: auto; margin-top: 0.5rem;
    padding: 0.6rem 0.75rem; border: 1px solid var(--rule); border-radius: var(--radius-sm);
    background: var(--bg-inset); font-family: var(--font-mono); font-size: 0.74rem; line-height: 1.45;
    white-space: pre;
  }
  @media (max-width: 700px) { .wiz-body { padding-left: 0; } }
</style>
