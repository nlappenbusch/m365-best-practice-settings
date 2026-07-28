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
  let spSelSiteId = $state('')
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
    spSelSiteId = ''
    spSelGroups = {}
    spSaveMsg = null
    spLoadSites()
  }
  function spEdit(p) {
    spEditorOpen = true
    spProfileName = p.profileName
    spMappings = (p.config?.mappings || []).map(m => ({ ...m }))
    spSelSiteId = ''
    const sel = {}
    for (const gid of (p.groupIds || [])) sel[gid] = true
    spSelGroups = sel
    spSaveMsg = null
    spLoadSites()
  }
  async function spResolveAndAdd() {
    if (!spSelSiteId) return
    spResolving = true
    spResolveError = null
    try {
      const r = await apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/sharepointsites/resolve`, { siteId: spSelSiteId })
      const site = spSites.find(s => s.id === spSelSiteId)
      spMappings = [...spMappings, { ...r.library, libraryName: (site?.displayName || r.library.libraryName) }]
      spSelSiteId = ''
    } catch (e) {
      spResolveError = e.message
    }
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
</script>

<TenantContext>
  <div class="settings-group">
    <h4>🗺️ Netzlaufwerk-Mappings <small>(Intune Drive Mapping Generator)</small></h4>
    <p class="ld-section-hint">Erzeugt aus deiner Laufwerk-Liste ein PowerShell-Plattformskript (Vorlage: <a href="https://github.com/nicolonsky/IntuneDriveMapping" target="_blank" rel="noopener">nicolonsky/IntuneDriveMapping</a>) und weist es dynamischen Gerätegruppen zu — ohne App-Abhängigkeit. Optionaler Gruppenfilter je Laufwerk nutzt On-Prem-AD-Gruppen (hybrid). Bearbeiten liest die Konfiguration direkt aus dem deployten Skript zurück.</p>
    <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
      <button class="btn btn-primary" onclick={newProfile}>➕ Neues Profil</button>
      <button class="btn btn-secondary" onclick={load} disabled={loading}>{loading ? '…' : '🔄 Neu laden'}</button>
    </div>
  </div>

  {#if saveMsg}
    <div class="ld-banner {saveMsg.ok ? 'ok' : 'fail'}" style="margin-bottom:1rem;">{saveMsg.text}</div>
  {/if}

  {#if editorOpen}
    <div class="ld-job" style="margin-bottom:1.5rem;">
      <div class="ld-job-head"><strong>🛠 Profil-Konfigurator</strong>
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
        <button class="btn btn-secondary" style="padding:0.25rem 0.7rem; font-size:0.8rem;" onclick={downloadScript}>⬇️ PowerShell-Skript herunterladen</button>
        <button class="btn btn-secondary" style="padding:0.25rem 0.7rem; font-size:0.8rem;" onclick={() => (importOpen = !importOpen)}>{importOpen ? '✕ Import schließen' : '📥 Bestehendes Skript einlesen'}</button>
      </div>
      {#if importOpen}
        <div class="input-group" style="margin-bottom:0.75rem;">
          <label for="dmImport">Vorhandenes DriveMapping-Skript hier einfügen (aus Intune oder dem Original-Generator) — die Konfiguration wird herausgelesen und füllt die Tabelle:</label>
          <textarea id="dmImport" rows="5" bind:value={importText} placeholder="Inhalt der DriveMapping.ps1 einfügen…" style="font-family:var(--font-mono); font-size:0.78rem;"></textarea>
          <div><button class="btn btn-primary" onclick={importScript} disabled={!importText.trim()}>📥 Einlesen</button></div>
          {#if importError}<div class="ld-banner fail">❌ {importError}</div>{/if}
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
      <div class="ld-banner fail">❌ {loadError}</div>
      {#if /DeviceManagementScripts|not authorized/i.test(loadError)}
        <div class="ld-step"><small>💡 Braucht die Graph-Permission <code>DeviceManagementScripts.ReadWrite.All</code> — im Tab „🏢 Tenants" einmal 🔧 Reparieren ausführen (danach ein paar Minuten Consent-Replikation abwarten).</small></div>
      {/if}
    </div>
  {:else if profiles}
    <div class="ld-job">
      <div class="ld-job-head"><strong>📜 Deployte Profile</strong>
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

  <div class="settings-group" style="margin-top:2rem;">
    <h4>🖨️ Drucker-Mappings <small>(Weatherlights Intune Printer Mapping)</small></h4>
    <p class="ld-section-hint">Verbindet On-Prem-Netzwerkdrucker per <a href="https://github.com/Weatherlights/Intune-Printer-Mapping-Tool/wiki" target="_blank" rel="noopener">Intune-Printer-Mapping-Tool</a>: die ADMX-Vorlage wird automatisch importiert, das Konfigurationsprofil (inkl. Pflicht-Schalter) angelegt und die Store-App auf Wunsch gleich mit deployt. Voraussetzungen laut Wiki: Seamless SSO/Cloud Kerberos Trust, Druckertreiber auf den Geräten, Druckberechtigungen.</p>
    <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
      <button class="btn btn-primary" onclick={pmNew}>➕ Neues Drucker-Profil</button>
      <button class="btn btn-secondary" onclick={pmLoad} disabled={pmLoading}>{pmLoading ? '…' : '🔄 Neu laden'}</button>
    </div>
  </div>

  {#if pmJob}
    <div class="ld-job" style="margin-bottom:1rem;">
      {#if pmJob.status === 'failed'}
        <div class="ld-banner fail">❌ {pmJob.error}</div>
        {#if pmJob.hint}<div class="ld-step"><small>💡 {pmJob.hint}</small></div>{/if}
      {:else if pmJob.status === 'done'}
        <div class="ld-banner ok">✅ „{pmJob.results?.displayName}" {pmJob.results?.updated ? 'aktualisiert' : 'ausgerollt'}{pmJob.results?.app ? ` · Store-App ${pmJob.results.app.created ? 'angelegt' : 'war vorhanden'} und zugewiesen` : ''}.</div>
        <div class="ld-banner warn">📋 <b>Ein manueller Schritt bleibt</b> (einmal pro Tenant): Die App startet erst automatisch, wenn sie in einer Geräterestriktions-Richtlinie als erlaubte Autostart-App eingetragen ist —
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
      <div class="ld-job-head"><strong>🛠 Drucker-Profil-Konfigurator</strong>
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
    <div class="ld-job"><div class="ld-banner fail">❌ {pmError}</div></div>
  {:else if pmData}
    <div class="ld-job">
      <div class="ld-job-head"><strong>🖨️ Deployte Drucker-Profile</strong>
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

  <div class="settings-group">
    <h4>☁️ SharePoint-Sync-Mappings <small>(OneDrive „Configure team site libraries to sync automatically")</small></h4>
    <p class="ld-section-hint">SharePoint-Bibliotheken auswählen — OneDrive synct sie beim nächsten Anmelden automatisch (Fenster bis zu 8h), ohne dass Nutzer die Site manuell besuchen/synchronisieren müssen. Voraussetzung: OneDrive Files On-Demand ist im Tenant aktiv.</p>
    <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
      <button class="btn btn-primary" onclick={spNew}>➕ Neues Sync-Profil</button>
      <button class="btn btn-secondary" onclick={spLoad} disabled={spLoading}>{spLoading ? '…' : '🔄 Neu laden'}</button>
    </div>

    {#if spEditorOpen}
      <div class="ld-job" style="margin-top:1rem; margin-bottom:1.5rem;">
        <div class="ld-job-head"><strong>🛠 Sync-Profil-Konfigurator</strong>
          <button class="btn btn-secondary" style="padding:0.2rem 0.6rem; font-size:0.78rem;" onclick={() => (spEditorOpen = false)}>✕ schließen</button></div>

        <div class="input-group" style="max-width:280px; margin-bottom:0.75rem;">
          <label for="spName">Profilname</label>
          <input id="spName" type="text" bind:value={spProfileName} placeholder="Standard" />
        </div>

        <div class="ld-oib-target">
          <div class="input-group" style="max-width:420px;">
            <label for="spSite">SharePoint-Site hinzufügen</label>
            <select id="spSite" bind:value={spSelSiteId} disabled={spSitesLoading}>
              <option value="">{spSitesLoading ? 'Lade Sites…' : '— Site wählen —'}</option>
              {#each spSites as s (s.id)}<option value={s.id} title={s.webUrl}>{s.displayName}</option>{/each}
            </select>
          </div>
          <button class="btn btn-secondary" onclick={spResolveAndAdd} disabled={!spSelSiteId || spResolving}>
            {spResolving ? 'Löse auf…' : '+ Bibliothek hinzufügen'}
          </button>
        </div>
        {#if spSitesError}<div class="ld-banner fail" style="margin-top:0.5rem;">❌ Sites konnten nicht geladen werden: {spSitesError}<br /><small>Falls „Reparieren" seit dem letzten Update dieser Funktion nicht ausgeführt wurde: im Tab „Tenants" einmal „🔧 Reparieren" ausführen (neue Berechtigung Sites.Read.All).</small></div>{/if}
        {#if spResolveError}<div class="ld-banner fail" style="margin-top:0.5rem;">❌ {spResolveError}</div>{/if}

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
      <div class="ld-job" style="margin-top:1rem;"><div class="ld-banner fail">❌ {spError}</div></div>
    {:else if spProfiles}
      <div class="ld-job" style="margin-top:1rem;">
        <div class="ld-job-head"><strong>☁️ Deployte Sync-Profile</strong>
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
</TenantContext>
