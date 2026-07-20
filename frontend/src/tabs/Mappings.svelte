<script>
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

  const selGroupCount = $derived(Object.values(selGroups).filter(Boolean).length)

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

      {#each mappings as m, i}
        <div class="ld-oib-target">
          <select bind:value={m.driveLetter} style="min-width:70px;">
            <option value="">–</option>
            {#each LETTERS as l}<option value={l}>{l}:</option>{/each}
          </select>
          <input type="text" bind:value={m.path} placeholder="\\server\share" style="flex:2; min-width:220px;" />
          <input type="text" bind:value={m.label} placeholder="Anzeigename (optional)" style="flex:1; min-width:140px;" />
          <input type="text" bind:value={m.groupFilter} placeholder="AD-Gruppenfilter, kommagetrennt (optional)" style="flex:1; min-width:180px;" />
          <button class="btn btn-secondary" onclick={() => removeRow(i)} disabled={mappings.length <= 1} title="Zeile entfernen">✕</button>
        </div>
      {/each}
      <div class="ld-oib-toolbar">
        <button class="btn btn-secondary" style="padding:0.25rem 0.7rem; font-size:0.8rem;" onclick={addRow}>+ Laufwerk</button>
      </div>

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
</TenantContext>
