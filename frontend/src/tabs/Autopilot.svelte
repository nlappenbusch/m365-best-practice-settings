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

  // ---------- Profil anlegen ----------
  // Ohne Deployment-Profil bleibt jedes Autopilot-Gerät in der normalen OOBE
  // stehen. Bisher hiess das: rüber ins Intune-Portal wechseln.
  let newProfileOpen = $state(false)
  let newProfileBusy = $state(false)
  let newProfile = $state({
    displayName: 'Autopilot - User-Driven',
    description: '',
    language: 'de-DE',
    deviceNameTemplate: '',
    userType: 'standard',
    hideEula: true,
    hidePrivacy: true,
    skipKeyboard: true,
    allowWhiteGlove: false,
    groupId: ''
  })

  // ---------- Gerätename-Vorlage: Baukasten ----------
  // Intune-Regeln: max. 15 Zeichen, nur Buchstaben/Ziffern/Bindestrich, nicht nur
  // Ziffern. %SERIAL% → Seriennummer (Überlänge wird am Ende abgeschnitten),
  // %RAND:x% → x Zufallsziffern. Pro Vorlage ist nur ein Platzhalter sinnvoll.
  const TPL_MAX = 15
  let tplRandDigits = $state(4)

  function tplInsert(token) {
    const prefix = (newProfile.deviceNameTemplate || '').replace(/%SERIAL%|%RAND:\d+%/gi, '')
    newProfile.deviceNameTemplate = prefix + token
  }

  const tplCheck = $derived.by(() => {
    const t = (newProfile.deviceNameTemplate || '').trim()
    if (!t) return { text: '💡 Leer — Windows vergibt den Namen automatisch. Empfehlung: Präfix + Seriennummer, z. B. IG-%SERIAL%', error: false }
    const rand = t.match(/%RAND:(\d+)%/i)
    const hasSerial = /%SERIAL%/i.test(t)
    const fixed = t.replace(/%SERIAL%|%RAND:\d+%/gi, '')
    const placeholders = (t.match(/%SERIAL%|%RAND:\d+%/gi) || []).length
    if (placeholders > 1) return { text: '⛔ Nur ein Platzhalter pro Vorlage — %SERIAL% oder %RAND:x%, nicht beides.', error: true }
    if (/[^A-Za-z0-9-]/.test(fixed)) return { text: '⛔ Nur Buchstaben, Ziffern und Bindestrich erlaubt — keine Leer- oder Sonderzeichen.', error: true }
    if (rand) {
      const n = Number(rand[1])
      const len = fixed.length + n
      if (len > TPL_MAX) return { text: `⛔ Zu lang: Präfix ${fixed.length} + ${n} Zufallsziffern = ${len} von max. ${TPL_MAX} Zeichen.`, error: true }
      return { text: `✅ ${len} von ${TPL_MAX} Zeichen. Beispiel: ${t.replace(/%RAND:\d+%/i, '83052914'.slice(0, n))}`, error: false }
    }
    if (hasSerial) {
      const rest = TPL_MAX - fixed.length
      if (rest < 1) return { text: `⛔ Präfix füllt alle ${TPL_MAX} Zeichen — von der Seriennummer bliebe nichts übrig, alle Geräte hiessen gleich.`, error: true }
      const sample = t.replace(/%SERIAL%/i, '5CD045L29H').slice(0, TPL_MAX)
      return { text: `${rest < 4 ? '⚠️' : '✅'} Präfix ${fixed.length} Zeichen — ${rest} bleiben für die Seriennummer (längere werden abgeschnitten${rest < 4 ? ', Namenskollisionen möglich' : ''}). Beispiel: ${sample}`, error: false }
    }
    if (t.length > TPL_MAX) return { text: `⛔ Zu lang: ${t.length} von max. ${TPL_MAX} Zeichen.`, error: true }
    if (/^\d+$/.test(t)) return { text: '⛔ Der Name darf nicht nur aus Ziffern bestehen.', error: true }
    return { text: `⚠️ Fester Name (${t.length} von ${TPL_MAX} Zeichen) — jedes Gerät bekäme denselben Namen. Besser %SERIAL% oder Zufallsziffern anhängen.`, error: false }
  })

  async function createProfile() {
    if (!$activeTenant || !newProfile.displayName.trim()) return
    const gname = newProfile.groupId
      ? (profileGroups.find(g => g.id === newProfile.groupId)?.displayName || newProfile.groupId)
      : null
    if (!confirm(`Deployment-Profil „${newProfile.displayName}" im Tenant ${$activeTenant.name} anlegen?`
      + (gname
        ? `\n\nEs wird direkt der Gruppe „${gname}" zugewiesen.`
        : '\n\nOhne Zuweisung — das Profil wirkt erst, wenn du ihm unten eine Gruppe zuweist.'))) return

    newProfileBusy = true
    profilesError = null
    try {
      const r = await apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/autopilot/profiles`, newProfile)
      newProfileOpen = false
      await loadProfiles()
      if (r.assigned && String(r.assigned).startsWith('failed')) {
        profilesError = `Profil angelegt, aber die Zuweisung schlug fehl: ${String(r.assigned).slice(8)}`
      }
    } catch (e) {
      profilesError = e.message
    }
    newProfileBusy = false
  }

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
      profilesErrorDetail = e.hint || null
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
  <div class="settings-group">
    <h4>Autopilot</h4>
    <p class="ld-section-hint">Staging-Paket erzeugen (App-Registrierung mit Secret + Zertifikat, GroupTags aus den dynamischen Gruppen, fertiges ZIP) sowie Deployment-Profile einsehen und zuweisen.</p>
    <p class="ld-section-hint"><small>💡 Empfohlene Reihenfolge: <span class="step-n">1</span> Staging-Paket erstellen → <span class="step-n">2</span> Deployment-Profile der passenden Gruppe zuweisen → <span class="step-n">3</span> Geräte-GroupTags nur bei Bedarf nachträglich korrigieren.</small></p>
  </div>

  <div class="dl-subtabs">
    <button type="button" class="dl-subtab" class:active={subTab === 'staging'} onclick={() => selectSubTab('staging')}>📦 Staging-Paket</button>
    <button type="button" class="dl-subtab" class:active={subTab === 'profiles'} onclick={() => selectSubTab('profiles')}>🎯 Deployment-Profile</button>
    <button type="button" class="dl-subtab" class:active={subTab === 'devices'} onclick={() => selectSubTab('devices')}>📱 Geräte</button>
  </div>

  <div class="dl-panel" class:active={subTab === 'staging'}>
    {#if groupTagsLoading}
      <div class="ld-job"><div class="ld-step running"><span class="ld-spinner"></span> Lade GroupTags aus den dynamischen Gruppen…</div></div>
    {:else if groupTagsError}
      <div class="ld-job">
        <div class="ld-banner fail">{groupTagsError}</div>
        <div class="ld-step"><small>💡 Braucht die Graph-Permission Group.Read.All — ggf. im Tab „🏢 Tenants" einmal 🔧 Reparieren ausführen.</small></div>
      </div>
    {:else if !groupTags.length}
      <div class="ld-job"><div class="ld-banner warn">Keine GroupTags in den dynamischen Security Groups gefunden.
        <br /><small>Die Regeln müssen ein <code>[OrderID]:&lt;GroupTag&gt;</code> enthalten (Nils' GroupTag-Konzept). Zuerst die AAD-DEV-*-Gruppen anlegen.</small></div></div>
    {:else}
      <div class="ld-job">
        <div class="ld-job-head"><strong>Autopilot-Staging-Paket: {$activeTenant.name}</strong>
          <span class="ld-job-meta">{groupTags.length} GroupTags gefunden</span></div>
        <div class="ld-step"><small>Das Paket enthält eine dedizierte App-Registrierung <code>IG-Autopilot-Staging</code>
          (Client Secret + Zertifikat, Autopilot-Permissions), das HWID-Import-Skript, den Staging-Wrapper mit
          Auswahlmenü der gewählten GroupTags, Start-Batch, autounattend.xml und die WIM-Bau-Anleitung.</small></div>

        <div class="settings-group">
          <h4>GroupTags fürs Paket</h4>
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

        <div class="settings-group">
          <h4>Optionen</h4>
          <label class="checkbox-label"><input type="checkbox" bind:checked={assign} /> <span>Gerät nach Import direkt der Gruppe zuweisen (Assign + Wait)</span></label>
          <label class="checkbox-label"><input type="checkbox" bind:checked={reboot} /> <span>Nach dem Import neu starten</span></label>
        </div>

        <div class="settings-group">
          <h4>WLAN fürs Staging <small>(optional)</small></h4>
          <p class="ld-section-hint">Die <code>autounattend.xml</code> wird mit <strong>deutscher UI</strong>, Schweizer Locale/Tastatur,
            automatischer Partitionierung, automatischer EULA und <strong>ohne AutoLogon</strong> erzeugt (Anmeldung mit M365-User via Autopilot).
            Für WLAN-Zugang während der OOBE ein WLAN-Profil einbetten — bleibt dauerhaft gespeichert.</p>
          <ol style="margin:0.3rem 0 0.5rem 1.1rem; line-height:1.7; font-size:0.9rem;">
            <li><a href="/api/autopilot/wlan-helper">⬇️ WLAN-Export-Helper herunterladen</a> (<code>.cmd</code> — doppelklicken, fragt nach <strong>Admin-Rechten</strong> per UAC; das Klartext-Passwort exportiert nur elevated) auf einem Rechner ausführen, der mit dem Kunden-WLAN verbunden ist. Ergebnis liegt in <code>C:\Temp\wlan-export</code>.</li>
            <li>Die erzeugte <code>*.xml</code> hier hochladen:</li>
          </ol>
          <input type="file" accept=".xml" onchange={onWlanChange} />
          <div style="font-size:0.85rem; margin-top:0.3rem; color:var(--text-dim);">{wlanStatus}</div>
        </div>

        <div class="ld-confirm-actions">
          <button class="btn btn-primary" onclick={startBuild} disabled={building}>Paket erstellen (Admin-Login nötig)</button>
        </div>

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
            <div class="ld-step"><small>💡 Der Download-Link unten ist einmalig und läuft nach 10 Minuten ab — danach einfach „📦 Paket erstellen" erneut ausführen. Client Secret &amp; PFX sind nur in dieser ZIP — sicher ablegen.</small></div>
            <div class="ld-confirm-actions"><a class="btn btn-primary" href="/api/autopilot/download/{encodeURIComponent(buildResult.downloadToken)}">⬇️ ZIP herunterladen</a></div>
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

    <!-- Profil anlegen: gilt für beide Fälle, leerer Tenant und weiteres Profil -->
    {#if !profilesLoading && !profilesError}
      <div class="ld-job" style="margin-bottom:1rem">
        {#if !newProfileOpen}
          <button class="btn btn-primary" onclick={() => (newProfileOpen = true)}>➕ Deployment-Profil anlegen</button>
        {:else}
          <div class="ld-job-head"><strong>Neues Deployment-Profil</strong>
            <button class="btn btn-secondary" style="padding:0.2rem 0.6rem; font-size:0.78rem;" onclick={() => (newProfileOpen = false)}>✕</button>
          </div>
          <div class="settings-grid" style="margin-top:0.6rem">
            <div class="input-group">
              <label for="np-name">Name</label>
              <input id="np-name" type="text" bind:value={newProfile.displayName} />
            </div>
            <div class="input-group">
              <label for="np-lang">Sprache / Region</label>
              <select id="np-lang" bind:value={newProfile.language}>
                <option value="de-DE">Deutsch (de-DE)</option>
                <option value="de-CH">Deutsch Schweiz (de-CH)</option>
                <option value="fr-CH">Französisch Schweiz (fr-CH)</option>
                <option value="it-CH">Italienisch Schweiz (it-CH)</option>
                <option value="en-US">Englisch (en-US)</option>
                <option value="os-default">Betriebssystem-Standard</option>
              </select>
            </div>
            <div class="input-group">
              <label for="np-tpl">Gerätename-Vorlage <small>(max. 15 Zeichen, leer = automatisch)</small></label>
              <input id="np-tpl" type="text" bind:value={newProfile.deviceNameTemplate} placeholder="IG-%SERIAL%" />
              <div style="display:flex; gap:0.4rem; flex-wrap:wrap; align-items:center; margin-top:0.35rem; font-size:0.78rem">
                <span><small>Präfix tippen, dann:</small></span>
                <button type="button" class="btn btn-secondary" style="padding:0.15rem 0.5rem; font-size:0.75rem;" onclick={() => tplInsert('%SERIAL%')}>+ Seriennummer</button>
                <button type="button" class="btn btn-secondary" style="padding:0.15rem 0.5rem; font-size:0.75rem;" onclick={() => tplInsert(`%RAND:${tplRandDigits}%`)}>+ Zufallsziffern</button>
                <select bind:value={tplRandDigits} title="Anzahl Zufallsziffern" style="padding:0.1rem 0.25rem; font-size:0.75rem; width:auto">
                  {#each [2, 3, 4, 5, 6] as n}<option value={n}>{n}</option>{/each}
                </select>
              </div>
              <small style={tplCheck.error ? 'color:#c0392b' : ''}>{tplCheck.text}</small>
            </div>
            <div class="input-group">
              <label for="np-user">Kontotyp des Anwenders</label>
              <select id="np-user" bind:value={newProfile.userType}>
                <option value="standard">Standardbenutzer (empfohlen)</option>
                <option value="administrator">Lokaler Administrator</option>
              </select>
            </div>
            <div class="input-group">
              <label for="np-group">Direkt zuweisen an <small>(optional)</small></label>
              <select id="np-group" bind:value={newProfile.groupId}>
                <option value="">— später zuweisen —</option>
                {#each profileGroups as g}<option value={g.id}>{g.displayName}</option>{/each}
              </select>
            </div>
          </div>
          <div style="display:flex; gap:1rem; flex-wrap:wrap; margin-top:0.5rem; font-size:0.85rem">
            <label><input type="checkbox" bind:checked={newProfile.hidePrivacy} /> Datenschutzseite überspringen</label>
            <label><input type="checkbox" bind:checked={newProfile.hideEula} /> Lizenzbedingungen überspringen</label>
            <label><input type="checkbox" bind:checked={newProfile.skipKeyboard} /> Tastaturauswahl überspringen</label>
            <label><input type="checkbox" bind:checked={newProfile.allowWhiteGlove} /> Pre-Provisioning (White Glove) erlauben</label>
          </div>
          <div style="margin-top:0.75rem">
            <button class="btn btn-primary" disabled={newProfileBusy || !newProfile.displayName.trim() || tplCheck.error} onclick={createProfile}>
              {newProfileBusy ? 'Lege an…' : '✅ Profil anlegen'}
            </button>
            <small class="ld-section-hint">User-driven mit Entra-Join. Self-deploying wird bewusst nicht angeboten —
              das braucht TPM-Attestation und ist ein anderer Anwendungsfall.</small>
          </div>
        {/if}
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
          {@const assignedLabel = (p.assignments || []).map(a => a.label).join(', ') || 'nicht zugewiesen'}
          {@const res = profileResult[p.id]}
          <div class="ld-phase complete">
            <div class="ld-phase-title">🎯 {p.displayName}</div>
            <div class="ld-step"><small>{p.description || '(keine Beschreibung)'}</small></div>
            <div class="ld-step"><small>Gerätename-Template: <code>{p.deviceNameTemplate || '—'}</code> · Sprache: {p.language || 'os-default'}</small></div>
            <div class="ld-step ok"><span class="ld-ico">👥</span> Zugewiesen: <small>{assignedLabel}</small></div>
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
          <div class="ld-step"><small>💡 Das ist eine Störung auf Microsoft-Seite (der Geräte-Endpoint antwortet mit 500, Wiederholungen liefen bereits automatisch) — kein Konfigurationsfehler. Ein paar Minuten warten und oben „🔄" erneut laden.</small></div>
        {:else}
          <div class="ld-step"><small>💡 Braucht DeviceManagementServiceConfig — ggf. im Tab „🏢 Tenants" einmal 🔧 Reparieren ausführen.</small></div>
        {/if}
      </div>
    {:else if !devices.length}
      <div class="ld-job"><div class="ld-banner warn">Keine Autopilot-Geräte im Tenant registriert.</div></div>
    {:else}
      {#if devicesStale}
        <div class="ld-job">
          <div class="ld-banner warn">Microsoft-Dienst antwortet weiterhin mit 500 — zeige zuletzt erfolgreich geladene Liste{#if devicesCachedAt} vom {new Date(devicesCachedAt).toLocaleString('de-CH')}{/if}.</div>
          <div class="ld-step"><small>💡 GroupTag-Änderungen unten gehen direkt an einen anderen Endpoint und funktionieren meist trotzdem — die Liste selbst ist nur nicht taggenau aktuell.</small></div>
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
        <div class="ld-step"><small>GroupTag hier setzen/ändern wirkt wie ein nachträgliches „Etikett wechseln" — das Gerät rutscht dadurch
          über die dynamische Mitgliedschaftsregel automatisch in die passende Gruppe (siehe Tab „📖 Wissen → 🏷️ Namenskonventionen").
          Gleiche GroupTags wie im Tab „📦 Staging-Paket" — Freitextfeld unten schlägt bekannte Tags vor, prüft sie aber nicht.</small></div>

        {#each devices as dev (dev.id)}
          {@const res = deviceResult[dev.id]}
          <div class="ld-phase complete">
            <div class="ld-phase-title">💻 {dev.model || 'Unbekanntes Modell'} <small style="font-weight:400;">({dev.manufacturer || '—'})</small></div>
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
