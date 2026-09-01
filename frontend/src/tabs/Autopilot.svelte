<script>
  import { onDestroy } from 'svelte'
  import { apiGet, apiPost } from '../lib/api.js'
  import { activeTenant } from '../lib/tenantStore.js'
  import TenantContext from '../lib/TenantContext.svelte'

  const WLAN_IDLE = 'Kein WLAN-Profil gewählt — autounattend wird ohne WLAN erzeugt.'

  let subTab = $state('staging') // 'staging' | 'profiles' | 'devices'
  let lastTenantId = null

  // ---------- Staging-Paket: GroupTags ----------
  let groupTagsLoading = $state(false)
  let groupTagsError = $state(null)
  let groupTags = $state([])
  let checkedTags = $state({})   // groupTag -> bool

  async function loadGroupTags() {
    if (!$activeTenant) return
    groupTagsLoading = true
    groupTagsError = null
    try {
      const d = await apiGet(`/api/tenants/${encodeURIComponent($activeTenant.id)}/autopilot/grouptags`)
      groupTags = d.groupTags || []
      const next = {}
      for (const g of groupTags) next[g.groupTag] = true
      checkedTags = next
    } catch (e) {
      groupTagsError = e.message
    }
    groupTagsLoading = false
  }
  function checkAllTags() { const next = {}; for (const g of groupTags) next[g.groupTag] = true; checkedTags = next }
  function checkNoneTags() { checkedTags = {} }

  // ---------- Staging-Paket: Optionen + WLAN ----------
  let assign = $state(true)
  let reboot = $state(false)
  let wlanXml = $state('')
  let wlanStatus = $state(WLAN_IDLE)

  function onWlanChange(e) {
    const f = e.target.files && e.target.files[0]
    if (!f) { wlanXml = ''; wlanStatus = WLAN_IDLE; return }
    if (f.size > 200000) { wlanXml = ''; wlanStatus = '❌ Datei zu groß — ist das ein netsh-WLAN-Export?'; return }
    const reader = new FileReader()
    reader.onload = () => {
      const txt = String(reader.result || '')
      if (!/<WLANProfile/i.test(txt)) { wlanXml = ''; wlanStatus = '❌ Keine gültige WLAN-Profil-XML (kein <WLANProfile>).'; return }
      wlanXml = txt
      const m = txt.match(/<name>\s*([^<]+?)\s*<\/name>/i)
      wlanStatus = '✅ WLAN-Profil geladen: ' + (m ? m[1].trim() : '(Name unklar)') + ' — wird persistent eingebettet.'
    }
    reader.readAsText(f)
  }

  // ---------- Staging-Paket: Build (Device-Code) ----------
  let building = $state(false)
  let buildStep = $state(null)     // { verificationUri, userCode, interval }
  let buildResult = $state(null)   // { error } | { appId, warnings, pfxIncluded, pfxPassword, wlanIncluded, groupTags, downloadToken }
  let buildTimer = null

  async function startBuild() {
    const tags = Object.keys(checkedTags).filter(t => checkedTags[t])
    if (!tags.length) { alert('Mindestens einen GroupTag auswählen.'); return }
    building = true
    buildStep = null
    buildResult = null
    if (buildTimer) { clearTimeout(buildTimer); buildTimer = null }
    let start
    try {
      start = await apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/autopilot/start`,
        { groupTags: tags, assign, reboot, wlanProfileXml: wlanXml || '' })
    } catch (e) {
      building = false
      buildResult = { error: e.message }
      return
    }
    buildStep = start
    scheduleBuildPoll(start.interval || 5)
  }

  function scheduleBuildPoll(interval) {
    buildTimer = setTimeout(async () => {
      let r
      try { r = await apiPost('/api/autopilot/poll') }
      catch (e) { building = false; buildStep = null; buildResult = { error: e.message }; return }
      if (r.status === 'pending') { scheduleBuildPoll(r.interval || interval); return }
      if (r.status === 'error') { building = false; buildStep = null; buildResult = { error: r.error }; return }
      building = false
      buildStep = null
      buildResult = {
        appId: r.appId, warnings: r.warnings || [], pfxIncluded: r.pfxIncluded, pfxPassword: r.pfxPassword,
        wlanIncluded: r.wlanIncluded, groupTags: r.groupTags || [], downloadToken: r.downloadToken
      }
    }, interval * 1000)
  }

  // ---------- Deployment-Profile ----------
  let profilesLoading = $state(false)
  let profilesError = $state(null)
  let profilesErrorDetail = $state(null)   // Operation-/Activity-ID für den Microsoft-Support
  let profilesStale = $state(false)        // Anzeige kommt aus dem Zwischenspeicher
  let profilesCachedAt = $state(null)
  let profiles = $state([])
  let profileGroups = $state([])
  let selectedGroupByProfile = $state({})  // profileId -> groupId
  let assigningProfile = $state({})        // profileId -> bool
  let profileResult = $state({})           // profileId -> { error } | { status, gname }

  // ---------- Deployment-Profile: anlegen im Intune-Portal ----------
  // Das Anlegen lief eine Zeit lang ueber dieses Tool. Der Dienst dahinter
  // (DeviceEnrollmentFE) faellt aber regelmaessig mit 500 aus, und ein
  // halb angelegtes Profil ist schlechter als gar keines. Deshalb fuehrt der
  // Weg jetzt direkt ins Portal -- dort sieht man auch, ob die Stoerung
  // gerade ueberhaupt Aktionen zulaesst.
  const INTUNE_PROFILES_URL = $derived(
    'https://intune.microsoft.com/' + ($activeTenant?.organization || '') +
    '#view/Microsoft_Intune_Enrollment/AutopilotDeploymentProfiles.ReactView'
  )


  async function loadProfiles() {
    if (!$activeTenant) return
    profilesLoading = true
    profilesError = null
    try {
      const [pdata, gdata] = await Promise.all([
        apiGet(`/api/tenants/${encodeURIComponent($activeTenant.id)}/autopilot/profiles`),
        apiGet(`/api/tenants/${encodeURIComponent($activeTenant.id)}/groups`)
      ])
      profiles = pdata.profiles || []
      profileGroups = gdata.groups || []
      // Der Dienst hinter den Deployment-Profilen faellt regelmaessig mit 500
      // aus. Dann liefert das Backend den letzten bekannten Stand -- brauchbar,
      // aber der Anwender muss wissen, dass er alt ist.
      profilesStale = !!pdata.stale
      profilesCachedAt = pdata.cachedAt || null
      profilesErrorDetail = pdata.warningDetail || null
      const nextSel = {}
      for (const p of profiles) nextSel[p.id] = ''
      selectedGroupByProfile = nextSel
      profileResult = {}
    } catch (e) {
      profilesError = e.message
      profilesErrorDetail = e.detail || e.hint || null
    }
    profilesLoading = false
  }

  async function assignProfile(p) {
    const groupId = selectedGroupByProfile[p.id]
    const gname = profileGroups.find(g => g.id === groupId)?.displayName || groupId
    if (!confirm(`Profil „${p.displayName}" der Gruppe „${gname}" zuweisen?`)) return
    assigningProfile = { ...assigningProfile, [p.id]: true }
    profileResult = { ...profileResult, [p.id]: null }
    try {
      const r = await apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/autopilot/profiles/${encodeURIComponent(p.id)}/assign`, { groupId })
      profileResult = { ...profileResult, [p.id]: { status: r.status, gname } }
    } catch (e) {
      profileResult = { ...profileResult, [p.id]: { error: e.message } }
    }
    assigningProfile = { ...assigningProfile, [p.id]: false }
  }

  // ---------- Geräte: Liste + GroupTag direkt zuweisen ----------
  let devicesLoading = $state(false)
  let devicesError = $state(null)
  let devices = $state([])
  let devicesStale = $state(false)
  let devicesStaleWarning = $state(null)
  let devicesCachedAt = $state(null)
  let groupTagDraft = $state({})    // deviceId -> string (editierbarer Wert im Feld)
  let savingDevice = $state({})     // deviceId -> bool
  let deviceResult = $state({})     // deviceId -> { error } | { ok }

  async function loadDevices() {
    if (!$activeTenant) return
    devicesLoading = true
    devicesError = null
    try {
      const d = await apiGet(`/api/tenants/${encodeURIComponent($activeTenant.id)}/autopilot/devices`)
      devices = d.devices || []
      devicesStale = !!d.stale
      devicesStaleWarning = d.warning || null
      devicesCachedAt = d.cachedAt || null
      const draft = {}
      for (const dev of devices) draft[dev.id] = dev.groupTag || ''
      groupTagDraft = draft
      deviceResult = {}
    } catch (e) {
      devicesError = e.message
    }
    devicesLoading = false
  }

  async function saveGroupTag(dev) {
    const tag = (groupTagDraft[dev.id] || '').trim()
    if (!tag) { alert('GroupTag darf nicht leer sein.'); return }
    const unknown = groupTags.length && !groupTags.some(g => g.groupTag === tag)
    if (!confirm(
      `GroupTag von „${dev.groupTag || '(keiner)'}" auf „${tag}" ändern?\n\n` +
      `Das Gerät wechselt dadurch bei der naechsten Autopilot-Sync automatisch in die zum neuen ` +
      `GroupTag passende Gruppe — und damit ggf. auf ein anderes Deployment-Profil/andere Policies.` +
      (unknown ? `\n\n⚠️ „${tag}" ist KEIN bekannter GroupTag aus dem Staging-Paket-Tab — bitte Tippfehler ausschliessen.` : '')
    )) return
    savingDevice = { ...savingDevice, [dev.id]: true }
    deviceResult = { ...deviceResult, [dev.id]: null }
    try {
      await apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/autopilot/devices/${encodeURIComponent(dev.id)}/grouptag`, { groupTag: tag })
      dev.groupTag = tag
      devices = [...devices]
      deviceResult = { ...deviceResult, [dev.id]: { ok: true } }
    } catch (e) {
      deviceResult = { ...deviceResult, [dev.id]: { error: e.message } }
    }
    savingDevice = { ...savingDevice, [dev.id]: false }
  }

  function fmtContact(iso) {
    if (!iso) return 'nie kontaktiert'
    return new Date(iso).toLocaleString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  }

  // ---------- Sub-Tab-Wechsel + Tenant-Wechsel ----------
  function selectSubTab(t) {
    subTab = t
    if (!$activeTenant) return
    if (t === 'staging' && !groupTags.length && !groupTagsLoading && !groupTagsError) loadGroupTags()
    if (t === 'profiles' && !profiles.length && !profilesLoading && !profilesError) loadProfiles()
    if (t === 'devices' && !devices.length && !devicesLoading && !devicesError) loadDevices()
  }

  $effect(() => {
    const id = $activeTenant?.id ?? null
    if (id !== lastTenantId) {
      lastTenantId = id
      groupTags = []; groupTagsError = null; checkedTags = {}
      profiles = []; profileGroups = []; profilesError = null; selectedGroupByProfile = {}; profileResult = {}; assigningProfile = {}
      building = false; buildStep = null; buildResult = null
      if (buildTimer) { clearTimeout(buildTimer); buildTimer = null }
      wlanXml = ''; wlanStatus = WLAN_IDLE
      devices = []; devicesError = null; devicesStale = false; devicesStaleWarning = null; devicesCachedAt = null; groupTagDraft = {}; savingDevice = {}; deviceResult = {}
      if (id) {
        if (subTab === 'staging') loadGroupTags()
        else if (subTab === 'profiles') loadProfiles()
        else loadDevices()
      }
    }
  })

  onDestroy(() => { if (buildTimer) clearTimeout(buildTimer) })
</script>

<TenantContext>
  <p class="ld-section-hint">Empfohlene Reihenfolge: <span class="step-n">1</span> Staging-Paket erstellen →
    <span class="step-n">2</span> Deployment-Profile der passenden Gruppe zuweisen →
    <span class="step-n">3</span> Geräte-GroupTags nur bei Bedarf nachträglich korrigieren.</p>

  <div class="dl-subtabs">
    <button type="button" class="dl-subtab" class:active={subTab === 'staging'} onclick={() => selectSubTab('staging')}>Staging-Paket</button>
    <button type="button" class="dl-subtab" class:active={subTab === 'profiles'} onclick={() => selectSubTab('profiles')}>Deployment-Profile</button>
    <button type="button" class="dl-subtab" class:active={subTab === 'devices'} onclick={() => selectSubTab('devices')}>Geräte</button>
  </div>

  <div class="dl-panel" class:active={subTab === 'staging'}>
    {#if groupTagsLoading}
      <div class="ld-job"><div class="ld-step running"><span class="ld-spinner"></span> Lade GroupTags aus den dynamischen Gruppen…</div></div>
    {:else if groupTagsError}
      <div class="step-card">
        <div class="ld-banner fail">{groupTagsError}</div>
        <p class="ld-section-hint" style="margin-top:0.5rem">
          {#if /zertifikat/i.test(groupTagsError)}
            Dieser Tenant ist noch nicht (fertig) onboardet — im Tab «Tenants» das Onboarding durchlaufen, dann hier neu laden.
          {:else}
            Braucht die Graph-Permission Group.Read.All — im Tab «Tenants» einmal Reparieren ausführen, dann hier neu laden.
          {/if}
        </p>
        <button class="btn btn-secondary" onclick={loadGroupTags}>Neu laden</button>
      </div>
    {:else if !groupTags.length}
      <div class="step-card"><div class="ld-banner warn">Keine GroupTags in den dynamischen Security Groups gefunden.
        <br /><small>Die Regeln müssen ein <code>[OrderID]:&lt;GroupTag&gt;</code> enthalten (Nils' GroupTag-Konzept). Zuerst die Gerätegruppen anlegen (Tab GroupTags).</small></div></div>
    {:else}
      {@const pickedCount = Object.values(checkedTags).filter(Boolean).length}
      <p class="ld-section-hint">Das Paket enthält eine dedizierte App-Registrierung <code>IG-Autopilot-Staging</code>
        (Client Secret + Zertifikat, Autopilot-Permissions), das HWID-Import-Skript, den Staging-Wrapper mit
        Auswahlmenü der gewählten GroupTags, Start-Batch, autounattend.xml und die WIM-Bau-Anleitung.</p>

      <div class="step-pair">
        <div class="step-card">
          <h4><span class="step-n">1</span> GroupTags fürs Paket
            <span class="step-state {pickedCount ? 'done' : 'open'}">{pickedCount} von {groupTags.length} gewählt</span></h4>
          <div class="ld-oib-toolbar">
            <button class="btn btn-secondary" style="padding:0.25rem 0.7rem; font-size:0.8rem;" onclick={checkAllTags}>Alle</button>
            <button class="btn btn-secondary" style="padding:0.25rem 0.7rem; font-size:0.8rem;" onclick={checkNoneTags}>Keine</button>
          </div>
          {#each groupTags as g (g.groupTag)}
            <label class="ld-oib-row" title="{g.groupName} — {g.rule}">
              <input type="checkbox" checked={!!checkedTags[g.groupTag]}
                     onchange={(e) => (checkedTags = { ...checkedTags, [g.groupTag]: e.target.checked })} />
              <span class="ld-oib-name"><strong>{g.groupTag}</strong></span>
              <small class="ld-oib-assigned">→ {g.groupName}</small>
            </label>
          {/each}
        </div>

        <div class="step-card">
          <h4><span class="step-n">2</span> Optionen</h4>
          <div class="check-row">
            <input id="ap-assign" type="checkbox" bind:checked={assign} />
            <div>
              <label class="cr-title" for="ap-assign">Gerät nach Import direkt der Gruppe zuweisen</label>
              <div class="cr-desc">Assign + Wait — das Gerät wartet auf die Profilzuweisung, bevor es weitergeht.</div>
            </div>
          </div>
          <div class="check-row">
            <input id="ap-reboot" type="checkbox" bind:checked={reboot} />
            <div><label class="cr-title" for="ap-reboot">Nach dem Import neu starten</label></div>
          </div>
        </div>
      </div>

      <div class="step-card">
        <h4><span class="step-n">3</span> WLAN fürs Staging
          <span class="step-state {wlanXml ? 'done' : 'open'}">{wlanXml ? '✓ eingebettet' : 'optional'}</span></h4>
        <p class="ld-section-hint">Die <code>autounattend.xml</code> wird mit <strong>deutscher UI</strong>, Schweizer Locale/Tastatur,
          automatischer Partitionierung, automatischer EULA und <strong>ohne AutoLogon</strong> erzeugt (Anmeldung mit M365-User via Autopilot).
          Für WLAN-Zugang während der OOBE ein WLAN-Profil einbetten — bleibt dauerhaft gespeichert.</p>
        <ol style="margin:0.3rem 0 0.5rem 1.1rem; line-height:1.7; font-size:0.9rem;">
          <li><a href="/api/autopilot/wlan-helper">WLAN-Export-Helper herunterladen</a> (<code>.cmd</code> — doppelklicken, fragt nach <strong>Admin-Rechten</strong> per UAC; das Klartext-Passwort exportiert nur elevated) auf einem Rechner ausführen, der mit dem Kunden-WLAN verbunden ist. Ergebnis liegt in <code>C:\Temp\wlan-export</code>.</li>
          <li>Die erzeugte <code>*.xml</code> hier hochladen:</li>
        </ol>
        <input type="file" accept=".xml" onchange={onWlanChange} />
        <div style="font-size:0.85rem; margin-top:0.3rem; color:var(--text-dim);">{wlanStatus}</div>
      </div>

      <div class="step-card">
        <h4><span class="step-n">4</span> Paket erstellen
          <span class="step-state {pickedCount ? 'done' : 'open'}">{pickedCount ? '✓ bereit' : 'GroupTag wählen'}</span></h4>
        <button class="btn btn-primary" onclick={startBuild} disabled={building || !pickedCount}>Paket erstellen (Admin-Login nötig)</button>

        {#if buildStep}
          <div style="margin-top:0.75rem;">
            <div class="ld-onboard-step"><span class="step-n">1</span> Öffne <a href={buildStep.verificationUri} target="_blank" rel="noopener">{buildStep.verificationUri}</a></div>
            <div class="ld-onboard-step"><span class="step-n">2</span> Als <strong>Admin von {$activeTenant.name}</strong> anmelden, Code eingeben:
              <span class="ld-code">{buildStep.userCode}</span></div>
            <div class="ld-onboard-step"><span class="step-n">3</span> <span class="ld-spinner"></span> Warte auf Anmeldung, dann wird die App angelegt und das Paket gebaut…</div>
          </div>
        {:else if buildResult?.error}
          <div class="ld-banner fail" style="margin-top:0.75rem">{buildResult.error}</div>
        {:else if buildResult?.appId}
          {@const warn = buildResult.warnings}
          {@const pfxLine = buildResult.pfxIncluded
            ? `PFX-Zertifikat enthalten · PFX-Passwort: ${buildResult.pfxPassword} (im Paket-JSON hinterlegt)`
            : 'Zertifikat als PEM enthalten (openssl-PFX nicht verfügbar)'}
          {@const wlanLine = buildResult.wlanIncluded ? ' · WLAN-Profil in autounattend.xml eingebettet' : ' · autounattend.xml ohne WLAN (deutsche UI, kein AutoLogon)'}
          <div style="margin-top:0.75rem;">
            <div class="ld-banner ok">App <code>{buildResult.appId}</code> angelegt, Paket gebaut.
              {#if warn.length}{#each warn as w}<br />⚠️ {w}{/each}{/if}</div>
            <div class="ld-step"><small>GroupTags im Wrapper-Menü: {buildResult.groupTags.join(', ')}{wlanLine}<br />{pfxLine}</small></div>
            <div class="ld-step"><small>Der Download-Link ist einmalig und läuft nach 10 Minuten ab — danach «Paket erstellen» erneut ausführen. Client Secret &amp; PFX sind nur in dieser ZIP — sicher ablegen.</small></div>
            <div class="ld-confirm-actions"><a class="btn btn-primary" href="/api/autopilot/download/{encodeURIComponent(buildResult.downloadToken)}">ZIP herunterladen</a></div>
          </div>
        {/if}
      </div>
    {/if}
  </div>

  <div class="dl-panel" class:active={subTab === 'profiles'}>
    {#if profilesLoading}
      <div class="ld-job"><div class="ld-step running"><span class="ld-spinner"></span> Lade Deployment-Profile und Gruppen…</div></div>
    {:else if profilesError}
      <div class="ld-job">
        <div class="ld-banner fail">{profilesError}</div>
        {#if /internal server error|an error has occurred|zeitüberschreitung/i.test(profilesError)}
          <div class="ld-step"><small>
            Störung auf Microsoft-Seite: der Enrollment-Dienst antwortet mit einem Fehler, Wiederholungen sind bereits
            gelaufen. Das ist kein Problem eurer Konfiguration. In ein paar Minuten erneut laden — beim nächsten
            erfolgreichen Abruf merkt sich das Tool die Profile und zeigt sie bei der nächsten Störung weiter an.
          </small></div>
        {:else}
          <div class="ld-step"><small>
            Braucht die Berechtigung DeviceManagementServiceConfig — im Bereich „Tenants" einmal Reparieren ausführen.
          </small></div>
        {/if}
        {#if profilesErrorDetail}
          <details class="ld-step"><summary><small>Technische Angaben für den Microsoft-Support</small></summary>
            <small><code>{profilesErrorDetail}</code></small>
          </details>
        {/if}
      </div>
    {:else if !profiles.length}
      <div class="ld-job">
        <div class="ld-banner warn">Keine Autopilot-Deployment-Profile im Tenant gefunden.</div>
        <div class="ld-step"><small>Ohne Profil bleibt jedes registrierte Gerät in der normalen Windows-Einrichtung
          stehen. Unten eines anlegen — die Voreinstellungen entsprechen unserem Standard.</small></div>
      </div>
    {/if}

    <!-- Anlegen fuehrt ins Portal, siehe Kommentar im Skriptteil -->
    {#if !profilesLoading}
      <div class="ld-job" style="margin-bottom:1rem">
        <div class="ld-step"><small>
          Neue Deployment-Profile werden im Intune-Portal angelegt. Das Anlegen über dieses Tool ist bewusst
          entfallen: der Dienst dahinter fällt regelmässig aus, und ein halb angelegtes Profil ist schlechter als
          keines. Zuweisen und Prüfen geht hier weiterhin.
        </small></div>
        <a class="btn btn-primary" href={INTUNE_PROFILES_URL} target="_blank" rel="noopener">
          Im Intune-Portal anlegen
        </a>
        <small class="ld-section-hint">
          Öffnet die Bereitstellungsprofile im Tenant {$activeTenant?.name}. Danach hier „Neu laden" — das Profil
          erscheint in der Liste und kann zugewiesen werden.
        </small>
      </div>
    {/if}

    {#if profilesStale}
      <div class="ld-banner warn">
        Der Intune-Dienst antwortet gerade nicht — angezeigt wird der zuletzt bekannte Stand
        {profilesCachedAt ? ` von ${new Date(profilesCachedAt).toLocaleString('de-CH')}` : ''}.
        Zuweisen und Anlegen funktionieren in diesem Zustand möglicherweise nicht.
      </div>
    {/if}

    {#if profiles.length}
      <div class="ld-job">
        <div class="ld-job-head"><strong>Autopilot-Profile: {$activeTenant.name}</strong>
          <span class="ld-job-meta">{profiles.length} Profile · {profileGroups.length} Gruppen</span></div>

        {#each profiles as p (p.id)}
          {@const assignedLabel = (p.assignments || []).map(a => a.label).join(', ')}
          {@const res = profileResult[p.id]}
          <div class="step-card">
            <h4>{p.displayName}
              <span class="step-state {assignedLabel ? 'done' : 'open'}">{assignedLabel ? '✓ zugewiesen' : 'nicht zugewiesen'}</span></h4>
            <div class="ld-step"><small>{p.description || '(keine Beschreibung)'}</small></div>
            <div class="ld-step"><small>Gerätename-Template: <code>{p.deviceNameTemplate || '—'}</code> · Sprache: {p.language || 'os-default'}</small></div>
            {#if assignedLabel}<div class="ld-step"><small>Zugewiesen an: {assignedLabel}</small></div>{/if}
            <div class="ld-oib-target">
              <select bind:value={selectedGroupByProfile[p.id]}>
                <option value="">— Gruppe wählen —</option>
                {#each profileGroups as g (g.id)}<option value={g.id}>{g.displayName}</option>{/each}
              </select>
              <button class="btn btn-secondary" onclick={() => assignProfile(p)} disabled={assigningProfile[p.id] || !selectedGroupByProfile[p.id]}>
                {assigningProfile[p.id] ? 'Weise zu…' : 'Dieser Gruppe zuweisen'}
              </button>
            </div>
            {#if res?.error}
              <div class="ld-banner fail">{res.error}</div>
            {:else if res}
              <div class="ld-banner {res.status === 'assigned' ? 'ok' : 'warn'}">
                {res.status === 'assigned' ? '✅ Zugewiesen' : '⏭️ War bereits zugewiesen'} — „{res.gname}"
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>

  <div class="dl-panel" class:active={subTab === 'devices'}>
    {#if devicesLoading}
      <div class="ld-job"><div class="ld-step running"><span class="ld-spinner"></span> Lade Autopilot-Geräte…</div></div>
    {:else if devicesError}
      <div class="ld-job">
        <div class="ld-banner fail">{devicesError}</div>
        {#if /internal server error/i.test(devicesError)}
          <div class="ld-step"><small>Störung auf Microsoft-Seite (der Geräte-Endpoint antwortet mit 500, Wiederholungen liefen bereits automatisch) — kein Konfigurationsfehler. Ein paar Minuten warten und erneut laden.</small></div>
        {:else}
          <div class="ld-step"><small>Braucht DeviceManagementServiceConfig — im Tab «Tenants» einmal Reparieren ausführen.</small></div>
        {/if}
      </div>
    {:else if !devices.length}
      <div class="ld-job"><div class="ld-banner warn">Keine Autopilot-Geräte im Tenant registriert.</div></div>
    {:else}
      {#if devicesStale}
        <div class="ld-job">
          <div class="ld-banner warn">Microsoft-Dienst antwortet weiterhin mit 500 — zeige zuletzt erfolgreich geladene Liste{#if devicesCachedAt} vom {new Date(devicesCachedAt).toLocaleString('de-CH')}{/if}.</div>
          <div class="ld-step"><small>GroupTag-Änderungen unten gehen direkt an einen anderen Endpoint und funktionieren meist trotzdem — die Liste selbst ist nur nicht taggenau aktuell.</small></div>
        </div>
      {/if}
      <datalist id="apKnownGroupTags">
        {#each groupTags as g (g.groupTag)}<option value={g.groupTag}></option>{/each}
      </datalist>
      <div class="ld-job">
        <div class="ld-job-head"><strong>Autopilot-Geräte: {$activeTenant.name}</strong>
          <span class="ld-job-meta">{devices.length} Geräte</span>
          <button class="btn btn-secondary" style="padding:0.3rem 0.7rem; font-size:0.8rem;" onclick={loadDevices}>Neu laden</button>
        </div>
        <div class="ld-step"><small>GroupTag hier setzen/ändern wirkt wie ein nachträgliches «Etikett wechseln» — das Gerät rutscht dadurch
          über die dynamische Mitgliedschaftsregel automatisch in die passende Gruppe (siehe Wissen → Namenskonventionen).
          Gleiche GroupTags wie im Staging-Paket — das Freitextfeld schlägt bekannte Tags vor, prüft sie aber nicht.</small></div>

        {#each devices as dev (dev.id)}
          {@const res = deviceResult[dev.id]}
          <div class="step-card">
            <h4>{dev.model || 'Unbekanntes Modell'} <small style="font-weight:400;">({dev.manufacturer || '—'})</small>
              {#if dev.groupTag}<span class="step-state done">{dev.groupTag}</span>{:else}<span class="step-state open">kein GroupTag</span>{/if}</h4>
            <div class="ld-step"><small>Seriennummer: <code>{dev.serialNumber || '—'}</code> · Enrollment: {dev.enrollmentState || 'unbekannt'} · Letzter Kontakt: {fmtContact(dev.lastContactedDateTime)}</small></div>
            <div class="ld-oib-target">
              <input type="text" list="apKnownGroupTags" placeholder="z.B. DEV-STD" style="min-width:200px; padding:0.35rem 0.5rem; border:1px solid var(--rule); border-radius:var(--radius-sm); background:var(--bg-raised); color:var(--text);"
                     value={groupTagDraft[dev.id] || ''} oninput={(e) => (groupTagDraft = { ...groupTagDraft, [dev.id]: e.target.value })} />
              <button class="btn btn-secondary" onclick={() => saveGroupTag(dev)} disabled={savingDevice[dev.id]}>
                {savingDevice[dev.id] ? 'Speichere…' : 'GroupTag setzen'}
              </button>
              {#if dev.groupTag}<span class="tbadge ok">aktuell: {dev.groupTag}</span>{:else}<span class="tbadge warn">kein GroupTag</span>{/if}
            </div>
            {#if res?.error}
              <div class="ld-banner fail">{res.error}</div>
            {:else if res?.ok}
              <div class="ld-banner ok">GroupTag gesetzt — Gerät fällt bei nächster Sync in die passende dynamische Gruppe.</div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
</TenantContext>
