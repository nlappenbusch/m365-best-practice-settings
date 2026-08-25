<script>
  import { onDestroy } from 'svelte'
  import { apiGet, apiPost } from '../lib/api.js'
  import { activeTenant } from '../lib/tenantStore.js'
  import TenantContext from '../lib/TenantContext.svelte'

  // ---------- Laufwerk-Mappings (Port: nicolonsky/IntuneDriveMapping) ----------
  let loading = $state(false)
  let loadError = $state(null)
  let profiles = $state(null)
  let groups = $state([])
  let lastTenantId = null

  // Konfigurator-Zustand
  let editorOpen = $state(false)
  let profileName = $state('Standard')
  let mappings = $state([{ driveLetter: 'H', path: '', label: '', groupFilter: '' }])
  let searchRoot = $state('')
  let removeStaleDrives = $state(false)
  let selGroups = $state({})   // groupId -> bool
  let saving = $state(false)
  let saveMsg = $state(null)   // { ok, text }

  const LETTERS = 'DEFGHIJKLMNOPQRSTUVWXYZ'.split('')

  $effect(() => {
    const id = $activeTenant?.id ?? null
    if (id !== lastTenantId) {
      lastTenantId = id
      profiles = null; loadError = null; saveMsg = null; editorOpen = false
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
  }

  function newProfile() {
    editorOpen = true
    profileName = 'Standard'
    mappings = [{ driveLetter: 'H', path: '', label: '', groupFilter: '' }]
    searchRoot = ''
    removeStaleDrives = false
    selGroups = {}
    saveMsg = null
  }
  function editProfile(p) {
    editorOpen = true
    profileName = p.profileName
    mappings = (p.config?.mappings || []).map(m => ({ ...m }))
    if (!mappings.length) mappings = [{ driveLetter: 'H', path: '', label: '', groupFilter: '' }]
    searchRoot = p.config?.searchRoot || ''
    removeStaleDrives = !!p.config?.removeStaleDrives
    const sel = {}
    for (const gid of (p.groupIds || [])) sel[gid] = true
    selGroups = sel
    saveMsg = null
  }
  function addRow() { mappings = [...mappings, { driveLetter: '', path: '', label: '', groupFilter: '' }] }
  function removeRow(i) { mappings = mappings.filter((_, j) => j !== i) }

  // Generator-UX des Originals: Skript ohne Deploy herunterladen + einlesen
  let importOpen = $state(false)
  let importText = $state('')
  let importError = $state(null)

  async function downloadScript() {
    try {
      const r = await apiPost('/api/drivemappings/generate', { mappings, searchRoot, removeStaleDrives })
      const blob = new Blob([r.script], { type: 'text/plain' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = 'DriveMapping.ps1'
      a.click()
      URL.revokeObjectURL(a.href)
    } catch (e) { alert('❌ ' + e.message) }
  }
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

  const selGroupCount = $derived(Object.values(selGroups).filter(Boolean).length)

  // ---------- Drucker-Mappings (Weatherlights Intune Printer Mapping) ----------
  let pmLoading = $state(false)
  let pmError = $state(null)
  let pmData = $state(null)          // { profiles, autostartPfn, maxPrinters }
  let pmEditorOpen = $state(false)
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
    pmName = 'Buero'
    pmScope = 'user'
    pmPrinters = [{ path: '', operation: 'Add', setDefault: false }]
    pmSelGroups = {}
    pmDeployApp = true
  }
  function pmEdit(p) {
    pmEditorOpen = true
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
  const pmSelCount = $derived(Object.values(pmSelGroups).filter(Boolean).length)

  async function pmSave() {
    const groupIds = Object.keys(pmSelGroups).filter(g => pmSelGroups[g])
    if (!confirm(
      `Drucker-Profil „${pmName}" ausrollen?\n\n` +
      `Es wird die ADMX-Vorlage (einmalig) importiert, das Konfigurationsprofil „WIN - PrinterMapping - ${pmName}" angelegt/aktualisiert (${pmPrinters.length} Drucker, ${pmScope === 'machine' ? 'Geräte' : 'Benutzer'}-Kontext), ` +
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

  async function save() {
    const groupIds = Object.keys(selGroups).filter(g => selGroups[g])
    if (!confirm(
      `Profil „${profileName}" deployen?\n\n` +
      `Es wird ein PowerShell-Plattformskript „WIN - DriveMapping - ${profileName}" in Intune angelegt/aktualisiert ` +
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

  // ---------- SharePoint-Sync-Mappings (OneDrive "Configure team site libraries to sync automatically") ----------
  let spLoading = $state(false)
  let spError = $state(null)
  let spProfiles = $state(null)
  let spSites = $state([])
  let spSitesLoading = $state(false)
  let spSitesError = $state(null)
  let spEditorOpen = $state(false)
  let spProfileName = $state('Standard')
  let spMappings = $state([])   // [{libraryName, tenantId, siteId, webId, listId, webUrl}]
  let spSiteFilter = $state('')
  let spSelSites = $state({})   // siteId -> bool, Mehrfachauswahl
  let spResolving = $state(false)
  let spResolveError = $state(null)
  let spSelGroups = $state({})
  let spSaving = $state(false)
  let spSaveMsg = $state(null)

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
    spProfileName = 'Standard'
    spMappings = []
    spSelSites = {}
    spSiteFilter = ''
    spSelGroups = {}
    spSaveMsg = null
    spLoadSites()
  }
  function spEdit(p) {
    spEditorOpen = true
    spProfileName = p.profileName
    spMappings = (p.config?.mappings || []).map(m => ({ ...m }))
    spSelSites = {}
    spSiteFilter = ''
    const sel = {}
    for (const gid of (p.groupIds || [])) sel[gid] = true
    spSelGroups = sel
    spSaveMsg = null
    spLoadSites()
  }
  const spAlreadyAddedIds = $derived(new Set(spMappings.map(m => m.siteId)))
  const spFilteredSites = $derived(
    spSites.filter(s => !spSiteFilter.trim() || s.displayName.toLowerCase().includes(spSiteFilter.trim().toLowerCase()))
  )
  const spSelSiteCount = $derived(Object.values(spSelSites).filter(Boolean).length)
  function spToggleAllFiltered(val) {
    const next = { ...spSelSites }
    for (const s of spFilteredSites) next[s.id] = val
    spSelSites = next
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
  const spSelGroupCount = $derived(Object.values(spSelGroups).filter(Boolean).length)

  async function spSave() {
    const groupIds = Object.keys(spSelGroups).filter(g => spSelGroups[g])
    if (!confirm(
      `Profil „${spProfileName}" deployen?\n\n` +
      `Es wird ein PowerShell-Plattformskript „WIN - SharePointSync - ${spProfileName}" in Intune angelegt/aktualisiert ` +
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
  let rpProfileName = $state('Standard')
  let rpEntries = $state([])   // [{path, name, type, value}]
  let rpSelGroups = $state({})
  let rpSaving = $state(false)
  let rpSaveMsg = $state(null)

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
    rpProfileName = 'Standard'
    rpEntries = []
    rpSelGroups = {}
    rpSaveMsg = null
  }
  function rpEdit(p) {
    rpEditorOpen = true
    rpProfileName = p.profileName
    rpEntries = (p.config?.entries || []).map(e => ({ ...e }))
    const sel = {}
    for (const gid of (p.groupIds || [])) sel[gid] = true
    rpSelGroups = sel
    rpSaveMsg = null
  }
  function rpApplyPreset(preset) {
    rpProfileName = preset.label
    rpEntries = [...rpEntries, ...preset.entries.map(e => ({ ...e }))]
  }
  function rpAddRow() { rpEntries = [...rpEntries, { path: '', name: '', type: 'DWORD', value: '' }] }
  function rpRemoveRow(i) { rpEntries = rpEntries.filter((_, j) => j !== i) }
  const rpSelGroupCount = $derived(Object.values(rpSelGroups).filter(Boolean).length)

  async function rpSave() {
    const groupIds = Object.keys(rpSelGroups).filter(g => rpSelGroups[g])
    if (!confirm(
      `Profil „${rpProfileName}" deployen?\n\n` +
      `Es wird ein PowerShell-Plattformskript „WIN - RegistryPolicy - ${rpProfileName}" in Intune angelegt/aktualisiert ` +
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

<TenantContext>
  <div class="dl-subtabs">
    <button type="button" class="dl-subtab" class:active={subTab === 'drives'} onclick={() => (subTab = 'drives')}>
      Netzlaufwerke{profiles?.length ? ` (${profiles.length})` : ''}
    </button>
    <button type="button" class="dl-subtab" class:active={subTab === 'printers'} onclick={() => (subTab = 'printers')}>
      Drucker{pmData?.profiles?.length ? ` (${pmData.profiles.length})` : ''}
    </button>
    <button type="button" class="dl-subtab" class:active={subTab === 'sharepoint'} onclick={() => (subTab = 'sharepoint')}>
      SharePoint-Sync{spProfiles?.length ? ` (${spProfiles.length})` : ''}
    </button>
    <button type="button" class="dl-subtab" class:active={subTab === 'registry'} onclick={() => (subTab = 'registry')}>
      Registry{rpProfiles?.length ? ` (${rpProfiles.length})` : ''}
    </button>
  </div>

  <div class="map-panel" class:tab-hidden={subTab !== 'drives'}>
  <div class="settings-group">
    <h4>Netzlaufwerk-Mappings <small>(Intune Drive Mapping Generator)</small></h4>
    <details class="map-info"><summary>Was macht das?</summary>
      <p class="ld-section-hint">Erzeugt aus deiner Laufwerk-Liste ein PowerShell-Plattformskript (Vorlage: <a href="https://github.com/nicolonsky/IntuneDriveMapping" target="_blank" rel="noopener">nicolonsky/IntuneDriveMapping</a>) und weist es dynamischen Gerätegruppen zu — ohne App-Abhängigkeit. Optionaler Gruppenfilter je Laufwerk nutzt On-Prem-AD-Gruppen (hybrid). Bearbeiten liest die Konfiguration direkt aus dem deployten Skript zurück.</p></details>
    <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
      <button class="btn btn-primary" onclick={newProfile}>Neues Profil</button>
      <button class="btn btn-secondary" onclick={load} disabled={loading}>{loading ? '…' : '🔄 Neu laden'}</button>
    </div>
  </div>

  {#if saveMsg}
    <div class="ld-banner {saveMsg.ok ? 'ok' : 'fail'}" style="margin-bottom:1rem;">{saveMsg.text}</div>
  {/if}

  {#if editorOpen}
    <div class="ld-job" style="margin-bottom:1.5rem;">
      <div class="ld-job-head"><strong>Profil-Konfigurator</strong>
        <button class="btn btn-secondary" style="padding:0.2rem 0.6rem; font-size:0.78rem;" onclick={() => (editorOpen = false)}>✕ schließen</button></div>

      <div class="input-group" style="max-width:320px; margin-bottom:0.75rem;">
        <label for="dmName">Profilname</label>
        <input id="dmName" type="text" bind:value={profileName} placeholder="Standard" />
        <small>Skriptname in Intune: <code>WIN - DriveMapping - {profileName || '…'}</code></small>
      </div>

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
        <button class="btn btn-secondary" style="padding:0.25rem 0.7rem; font-size:0.8rem;" onclick={downloadScript}>PowerShell-Skript herunterladen</button>
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

      <div class="ld-oib-target">
        <label style="display:flex; align-items:center; gap:0.4rem; cursor:pointer; font-size:0.84rem;">
          <input type="checkbox" bind:checked={removeStaleDrives} />
          Nicht (mehr) konfigurierte Netzlaufwerke automatisch trennen
        </label>
        <input type="text" bind:value={searchRoot} placeholder="AD-Domäne überschreiben, z.B. ad.firma.ch (optional)" style="min-width:260px;" />
      </div>

      <div class="ld-phase complete" style="margin-top:0.5rem;">
        <div class="ld-phase-title">👥 Zuweisung ({selGroupCount} Gruppe{selGroupCount === 1 ? '' : 'n'})</div>
        {#if !groups.length}
          <div class="ld-step pending"><small>Keine Gruppen geladen — Profil wird ohne Zuweisung angelegt.</small></div>
        {/if}
        {#each groups as g (g.id)}
          <label class="ld-oib-row">
            <input type="checkbox" checked={!!selGroups[g.id]}
                   onchange={(e) => (selGroups = { ...selGroups, [g.id]: e.target.checked })} />
            <span class="ld-oib-name">{g.displayName}</span>
          </label>
        {/each}
      </div>

      <div class="ld-confirm-actions">
        <button class="btn btn-primary" onclick={save} disabled={saving || !profileName.trim()}>
          {saving ? 'Deploye…' : '🚀 Profil deployen'}
        </button>
      </div>
    </div>
  {/if}

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
    <div class="ld-job">
      <div class="ld-job-head"><strong>Deployte Profile</strong>
        <span class="ld-job-meta">{profiles.length}</span></div>
      {#if !profiles.length}
        <div class="ld-step pending"><span class="ld-ico">○</span> Noch keine Profile — oben eines anlegen.</div>
      {/if}
      {#each profiles as p (p.id)}
        {@const gnames = (p.groupIds || []).map(gid => groups.find(g => g.id === gid)?.displayName || gid)}
        <div class="ld-phase complete">
          <div class="ld-phase-title">🗺️ {p.profileName}</div>
          {#if p.config}
            {#each p.config.mappings as m}
              <div class="ld-step ok"><span class="ld-ico">💾</span> <code>{m.driveLetter}:</code> → <code>{m.path}</code>{m.label ? ` · „${m.label}"` : ''}{m.groupFilter ? ` · 👥 ${m.groupFilter}` : ''}</div>
            {/each}
          {:else}
            <div class="ld-step"><small>⚠️ Konfiguration nicht parsebar (manuell verändertes Skript?) — Bearbeiten überschreibt es.</small></div>
          {/if}
          <div class="ld-step"><small>Zugewiesen: {gnames.length ? gnames.join(', ') : 'nicht zugewiesen'}</small></div>
          <div class="ld-oib-target" style="margin-top:0;">
            <button class="btn btn-secondary" onclick={() => editProfile(p)}>✏️ Bearbeiten / neu zuweisen</button>
          </div>
        </div>
      {/each}
    </div>
  {/if}

  </div>

  <div class="map-panel" class:tab-hidden={subTab !== 'printers'}>
  <div class="settings-group">
    <h4>Drucker-Mappings <small>(Weatherlights Intune Printer Mapping)</small></h4>
    <details class="map-info"><summary>Was macht das?</summary>
      <p class="ld-section-hint">Verbindet On-Prem-Netzwerkdrucker per <a href="https://github.com/Weatherlights/Intune-Printer-Mapping-Tool/wiki" target="_blank" rel="noopener">Intune-Printer-Mapping-Tool</a>: die ADMX-Vorlage wird automatisch importiert, das Konfigurationsprofil (inkl. Pflicht-Schalter) angelegt und die Store-App auf Wunsch gleich mit deployt. Voraussetzungen laut Wiki: Seamless SSO/Cloud Kerberos Trust, Druckertreiber auf den Geräten, Druckberechtigungen.</p></details>
    <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
      <button class="btn btn-primary" onclick={pmNew}>Neues Drucker-Profil</button>
      <button class="btn btn-secondary" onclick={pmLoad} disabled={pmLoading}>{pmLoading ? '…' : '🔄 Neu laden'}</button>
    </div>
  </div>

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

  {#if pmEditorOpen}
    <div class="ld-job" style="margin-bottom:1.5rem;">
      <div class="ld-job-head"><strong>Drucker-Profil-Konfigurator</strong>
        <button class="btn btn-secondary" style="padding:0.2rem 0.6rem; font-size:0.78rem;" onclick={() => (pmEditorOpen = false)}>✕ schließen</button></div>

      <div class="ld-oib-target">
        <div class="input-group" style="max-width:280px;">
          <label for="pmName">Profilname</label>
          <input id="pmName" type="text" bind:value={pmName} placeholder="Buero EG" />
        </div>
        <div class="input-group" style="max-width:220px;">
          <label for="pmScope">Kontext</label>
          <select id="pmScope" bind:value={pmScope}>
            <option value="user">Benutzer (empfohlen)</option>
            <option value="machine">Gerät (alle Benutzer)</option>
          </select>
        </div>
      </div>

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

      <label style="display:flex; align-items:center; gap:0.4rem; cursor:pointer; font-size:0.84rem; margin:0.4rem 0;">
        <input type="checkbox" bind:checked={pmDeployApp} />
        Store-App „Intune Printer Mapping" automatisch als Required-App mit deployen (an dieselben Gruppen)
      </label>

      <div class="ld-phase complete" style="margin-top:0.5rem;">
        <div class="ld-phase-title">👥 Zuweisung ({pmSelCount} Gruppe{pmSelCount === 1 ? '' : 'n'})</div>
        {#each groups as g (g.id)}
          <label class="ld-oib-row">
            <input type="checkbox" checked={!!pmSelGroups[g.id]}
                   onchange={(e) => (pmSelGroups = { ...pmSelGroups, [g.id]: e.target.checked })} />
            <span class="ld-oib-name">{g.displayName}</span>
          </label>
        {/each}
      </div>

      <div class="ld-confirm-actions">
        <button class="btn btn-primary" onclick={pmSave} disabled={pmBusy || !pmName.trim()}>
          {pmBusy ? 'Rolle aus…' : '🚀 Drucker-Profil ausrollen'}
        </button>
      </div>
    </div>
  {/if}

  {#if pmLoading && !pmData}
    <div class="ld-job"><div class="ld-step running"><span class="ld-spinner"></span> Lade Drucker-Profile…</div></div>
  {:else if pmError}
    <div class="ld-job"><div class="ld-banner fail">{pmError}</div></div>
  {:else if pmData}
    <div class="ld-job">
      <div class="ld-job-head"><strong>Deployte Drucker-Profile</strong>
        <span class="ld-job-meta">{pmData.profiles.length}</span></div>
      {#if !pmData.profiles.length}
        <div class="ld-step pending"><span class="ld-ico">○</span> Noch keine Drucker-Profile — oben eines anlegen.</div>
      {/if}
      {#each pmData.profiles as p (p.id)}
        {@const gnames = (p.groupIds || []).map(gid => groups.find(g => g.id === gid)?.displayName || gid)}
        <div class="ld-phase complete">
          <div class="ld-phase-title">🖨️ {p.profileName} <small style="font-weight:400; color:var(--text-dim);">· {p.scope === 'machine' ? 'Geräte-Kontext' : 'Benutzer-Kontext'}{p.enabled ? '' : ' · ⚠️ Enable-Schalter fehlt!'}</small></div>
          {#each p.printers as pr}
            <div class="ld-step ok"><span class="ld-ico">{pr.operation === 'Delete' ? '🗑️' : '🖨️'}</span> <code>{pr.path}</code>{pr.setDefault ? ' · ⭐ Standard' : ''}{pr.operation === 'Delete' ? ' · wird entfernt' : ''}</div>
          {/each}
          <div class="ld-step"><small>Zugewiesen: {gnames.length ? gnames.join(', ') : 'nicht zugewiesen'}</small></div>
          <div class="ld-oib-target" style="margin-top:0;">
            <button class="btn btn-secondary" onclick={() => pmEdit(p)}>✏️ Bearbeiten / neu zuweisen</button>
          </div>
        </div>
      {/each}
    </div>
  {/if}

  </div>

  <div class="map-panel" class:tab-hidden={subTab !== 'sharepoint'}>
  <div class="settings-group">
    <h4>SharePoint-Sync-Mappings <small>(OneDrive „Configure team site libraries to sync automatically")</small></h4>
    <details class="map-info"><summary>Was macht das?</summary>
      <p class="ld-section-hint">SharePoint-Bibliotheken auswählen — OneDrive synct sie beim nächsten Anmelden automatisch (Fenster bis zu 8h), ohne dass Nutzer die Site manuell besuchen/synchronisieren müssen. Voraussetzung: OneDrive Files On-Demand ist im Tenant aktiv.</p></details>
    <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
      <button class="btn btn-primary" onclick={spNew}>Neues Sync-Profil</button>
      <button class="btn btn-secondary" onclick={spLoad} disabled={spLoading}>{spLoading ? '…' : '🔄 Neu laden'}</button>
    </div>

    {#if spEditorOpen}
      <div class="ld-job" style="margin-top:1rem; margin-bottom:1.5rem;">
        <div class="ld-job-head"><strong>Sync-Profil-Konfigurator</strong>
          <button class="btn btn-secondary" style="padding:0.2rem 0.6rem; font-size:0.78rem;" onclick={() => (spEditorOpen = false)}>✕ schließen</button></div>

        <div class="input-group" style="max-width:280px; margin-bottom:0.75rem;">
          <label for="spName">Profilname</label>
          <input id="spName" type="text" bind:value={spProfileName} placeholder="Standard" />
        </div>

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

        <div class="ld-phase complete" style="margin-top:0.75rem;">
          <div class="ld-phase-title">👥 Zuweisung ({spSelGroupCount} Gruppe{spSelGroupCount === 1 ? '' : 'n'})</div>
          {#each groups as g (g.id)}
            <label class="ld-oib-row">
              <input type="checkbox" checked={!!spSelGroups[g.id]}
                     onchange={(e) => (spSelGroups = { ...spSelGroups, [g.id]: e.target.checked })} />
              <span class="ld-oib-name">{g.displayName}</span>
            </label>
          {/each}
        </div>

        <div class="ld-confirm-actions">
          <button class="btn btn-primary" onclick={spSave} disabled={spSaving || !spProfileName.trim() || !spMappings.length}>
            {spSaving ? 'Rolle aus…' : '🚀 Sync-Profil ausrollen'}
          </button>
        </div>
        {#if spSaveMsg}<div class="ld-banner {spSaveMsg.ok ? 'ok' : 'fail'}" style="margin-top:0.5rem;">{spSaveMsg.text}</div>{/if}
      </div>
    {/if}

    {#if spLoading && !spProfiles}
      <div class="ld-job" style="margin-top:1rem;"><div class="ld-step running"><span class="ld-spinner"></span> Lade Sync-Profile…</div></div>
    {:else if spError}
      <div class="ld-job" style="margin-top:1rem;"><div class="ld-banner fail">{spError}</div></div>
    {:else if spProfiles}
      <div class="ld-job" style="margin-top:1rem;">
        <div class="ld-job-head"><strong>Deployte Sync-Profile</strong>
          <span class="ld-job-meta">{spProfiles.length}</span></div>
        {#if !spProfiles.length}
          <div class="ld-step pending"><span class="ld-ico">○</span> Noch keine Sync-Profile — oben eines anlegen.</div>
        {/if}
        {#each spProfiles as p (p.id)}
          {@const gnames = (p.groupIds || []).map(gid => groups.find(g => g.id === gid)?.displayName || gid)}
          <div class="ld-phase complete">
            <div class="ld-phase-title">☁️ {p.profileName}</div>
            {#each (p.config?.mappings || []) as m}
              <div class="ld-step ok"><span class="ld-ico">📁</span> {m.libraryName} <small>({m.webUrl})</small></div>
            {/each}
            <div class="ld-step"><small>Zugewiesen: {gnames.length ? gnames.join(', ') : 'nicht zugewiesen'}</small></div>
            <div class="ld-oib-target" style="margin-top:0;">
              <button class="btn btn-secondary" onclick={() => spEdit(p)}>✏️ Bearbeiten / neu zuweisen</button>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>

  </div>

  <div class="map-panel" class:tab-hidden={subTab !== 'registry'}>
  <div class="settings-group">
    <h4>Registry-Richtlinien <small>(HKLM, generisch + Vorlagen)</small></h4>
    <details class="map-info"><summary>Was macht das?</summary>
      <p class="ld-section-hint">Für einzelne, einfache Registry-Schalter, die (noch) nicht als Settings-Catalog-Einstellung durchsuchbar sind (z.&nbsp;B. ganz neue Richtlinien) oder schlicht ein simpler Ein-Wert-Schalter sind. Erzeugt ein PowerShell-Plattformskript, das im Systemkontext (SYSTEM) direkt unter <code>HKLM</code> schreibt.</p></details>

    <div class="alert alert-info">
      <strong>ℹ️ Neu: EU-DMA-SSO-Prompt automatisch akzeptieren.</strong> Mit dem Sicherheitsupdate vom Juli 2026 (<a href="https://support.microsoft.com/en-us/servicing/os/windows-11/2026/07/july-14-2026-kb5101650-os-builds-26200-8875-and-26100-8875" target="_blank" rel="noopener">KB5101650</a>, Windows&nbsp;11 24H2/25H2) zeigt Windows in der EU/EWR nach der Windows-Anmeldung erstmalig pro App eine SSO-Rückfrage („Weiter anmelden?"), bevor die Windows-Anmeldedaten auch für andere Microsoft-Apps/-Dienste verwendet werden dürfen — eine Folge des EU Digital Markets Act. Für verwaltete Geräte mit Entra-ID-Konto lässt sich diese Abfrage per Registry-Richtlinie automatisch bestätigen: <code>HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\AAD</code> → <code>AutoAcceptSsoPermission</code> (DWORD) = <code>1</code>. Gilt <b>nicht</b> für private Microsoft-Konten (MSA) oder unverwaltete Geräte — dort bleibt der Prompt bestehen. Vorlage unten per Klick übernehmbar.
    </div>

    <div style="display:flex; gap:0.5rem; flex-wrap:wrap; margin-top:0.75rem;">
      <button class="btn btn-primary" onclick={rpNew}>Neues Profil</button>
      <button class="btn btn-secondary" onclick={rpLoad} disabled={rpLoading}>{rpLoading ? '…' : '🔄 Neu laden'}</button>
    </div>

    {#if rpEditorOpen}
      <div class="ld-job" style="margin-top:1rem; margin-bottom:1.5rem;">
        <div class="ld-job-head"><strong>Registry-Profil-Konfigurator</strong>
          <button class="btn btn-secondary" style="padding:0.2rem 0.6rem; font-size:0.78rem;" onclick={() => (rpEditorOpen = false)}>✕ schließen</button></div>

        <div class="input-group" style="max-width:320px; margin-bottom:0.75rem;">
          <label for="rpName">Profilname</label>
          <input id="rpName" type="text" bind:value={rpProfileName} placeholder="Standard" />
          <small>Skriptname in Intune: <code>WIN - RegistryPolicy - {rpProfileName || '…'}</code></small>
        </div>

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
        <button class="btn btn-secondary" style="margin-top:0.5rem;" onclick={rpAddRow}>Zeile hinzufügen</button>

        <div class="ld-phase complete" style="margin-top:0.75rem;">
          <div class="ld-phase-title">👥 Zuweisung ({rpSelGroupCount} Gruppe{rpSelGroupCount === 1 ? '' : 'n'})</div>
          {#each groups as g (g.id)}
            <label class="ld-oib-row">
              <input type="checkbox" checked={!!rpSelGroups[g.id]}
                     onchange={(e) => (rpSelGroups = { ...rpSelGroups, [g.id]: e.target.checked })} />
              <span class="ld-oib-name">{g.displayName}</span>
            </label>
          {/each}
        </div>

        <div class="ld-confirm-actions">
          <button class="btn btn-primary" onclick={rpSave} disabled={rpSaving || !rpProfileName.trim() || !rpEntries.length}>
            {rpSaving ? 'Rolle aus…' : '🚀 Registry-Profil ausrollen'}
          </button>
        </div>
        {#if rpSaveMsg}<div class="ld-banner {rpSaveMsg.ok ? 'ok' : 'fail'}" style="margin-top:0.5rem;">{rpSaveMsg.text}</div>{/if}
      </div>
    {/if}

    {#if rpLoading && !rpProfiles}
      <div class="ld-job" style="margin-top:1rem;"><div class="ld-step running"><span class="ld-spinner"></span> Lade Registry-Profile…</div></div>
    {:else if rpError}
      <div class="ld-job" style="margin-top:1rem;"><div class="ld-banner fail">{rpError}</div></div>
    {:else if rpProfiles}
      <div class="ld-job" style="margin-top:1rem;">
        <div class="ld-job-head"><strong>Deployte Registry-Profile</strong>
          <span class="ld-job-meta">{rpProfiles.length}</span></div>
        {#if !rpProfiles.length}
          <div class="ld-step pending"><span class="ld-ico">○</span> Noch keine Registry-Profile — oben eines anlegen.</div>
        {/if}
        {#each rpProfiles as p (p.id)}
          {@const gnames = (p.groupIds || []).map(gid => groups.find(g => g.id === gid)?.displayName || gid)}
          <div class="ld-phase complete">
            <div class="ld-phase-title">🖥️ {p.profileName}</div>
            {#each (p.config?.entries || []) as e}
              <div class="ld-step ok"><span class="ld-ico">🔑</span> {e.name} <small>(HKLM:\{e.path} = {e.value}, {e.type})</small></div>
            {/each}
            <div class="ld-step"><small>Zugewiesen: {gnames.length ? gnames.join(', ') : 'nicht zugewiesen'}</small></div>
            <div class="ld-oib-target" style="margin-top:0;">
              <button class="btn btn-secondary" onclick={() => rpEdit(p)}>✏️ Bearbeiten / neu zuweisen</button>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
  </div>
</TenantContext>
