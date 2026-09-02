<script>
  import { session } from '../lib/session.js'
  import { dlApi } from '../lib/downloads.js'
  import { apiGet } from '../lib/api.js'
  import { activeTenant } from '../lib/tenantStore.js'
  import AppDeployModal from '../lib/AppDeployModal.svelte'

  // ---------- App-Hygiene ----------
  // Rein lesende Prüfung der vorhandenen Win32-Apps gegen das gemeinsame
  // Grundgerüst: Kundenname im App-Namen, derselbe Installer zweimal in der
  // Kommandozeile, ein fremdes GravityZone-Token, Hersteller-Tippfehler, leeres
  // Mindest-Betriebssystem, Zuweisung am 1:1-Prinzip vorbei. Nichts davon fällt
  // im Portal auf, jedes einzelne kostet später Zeit.
  let hyg = $state(null)
  let hygBusy = $state(false)
  let hygError = $state(null)
  let hygNurBefunde = $state(true)

  const hygSichtbar = $derived(
    !hyg ? [] : (hygNurBefunde ? hyg.apps.filter(a => a.funde.length) : hyg.apps)
  )

  async function loadHyg() {
    if (!$activeTenant) { hygError = 'Kein Tenant ausgewählt — oben im Header einen wählen.'; return }
    hygBusy = true; hygError = null
    try {
      hyg = await apiGet(`/api/tenants/${encodeURIComponent($activeTenant.id)}/apphygiene`)
    } catch (e) {
      hygError = e.message
    }
    hygBusy = false
  }

  let deployModal = $state(null) // { vendor, appNameDefault, source } | null

  // Config kommt vom Backend (welcher Bereich hat einen Key). Wird geladen,
  // sobald man angemeldet ist und der Tab offen ist (lazy).
  let cfg = $state(null)
  let initTried = $state(false)
  let sub = $state('bd')

  // Bitdefender
  let bdAll = $state([])
  let bdLoaded = $state(false)
  let bdStatus = $state('')
  let bdErr = $state(false)
  let bdQuery = $state('')
  let bdFiltered = $derived(
    bdQuery.trim()
      ? bdAll.filter(p => (p.packageName || '').toLowerCase().includes(bdQuery.trim().toLowerCase()))
      : bdAll
  )

  // N-sight
  let rmmAll = $state([])
  let rmmLoaded = $state(false)
  let rmmStatus = $state('')
  let rmmErr = $state(false)
  let rmmQuery = $state('')
  let rmmOs = $state('windows')
  let rmmServer = $state('')
  let openClient = $state(null)      // clientid, dessen Sites offen sind
  let sites = $state([])
  let sitesStatus = $state('')
  let rmmFiltered = $derived(
    rmmQuery.trim()
      ? rmmAll.filter(c => (c.name || '').toLowerCase().includes(rmmQuery.trim().toLowerCase()))
      : rmmAll
  )

  // Init laeuft, sobald angemeldet. $effect reagiert auf Session-Wechsel.
  $effect(() => {
    if ($session.ready && $session.online && $session.loggedIn && !initTried) {
      initTried = true
      dlApi.config()
        .then(c => {
          cfg = c
          if (c.bd) loadBd()
          else if (c.rmm) { sub = 'rmm'; loadRmm() }
          else if (c.bw) { sub = 'bw'; loadBw() }
        })
        .catch(() => { cfg = { bd: false, rmm: false, bw: false, error: true } })
    }
    if (!($session.loggedIn && $session.online)) { initTried = false; cfg = null }
  })

  function switchSub(s) {
    sub = s
    if (s === 'bd' && cfg?.bd && !bdLoaded) loadBd()
    if (s === 'rmm' && cfg?.rmm && !rmmLoaded) loadRmm()
    if (s === 'bw' && !bwRel && !bwLoading) loadBw()
  }

  async function loadBd() {
    bdErr = false; bdStatus = 'Pakete laden …'; bdAll = []
    try {
      const r = await dlApi.bdPackages()
      bdAll = r.packages || []; bdLoaded = true
      bdStatus = bdAll.length ? '' : 'Keine Pakete gefunden.'; bdErr = !bdAll.length
    } catch (e) { bdErr = true; bdStatus = 'Fehler: ' + e.message }
  }

  async function loadRmm() {
    rmmErr = false; rmmStatus = 'Clients laden … (Server-Erkennung kann kurz dauern)'; rmmAll = []
    try {
      const r = await dlApi.rmmClients()
      rmmAll = r.clients || []; rmmServer = r.server || ''; rmmLoaded = true
      rmmStatus = rmmAll.length ? (rmmServer ? 'Server: ' + rmmServer : '') : 'Keine Clients gefunden.'
      rmmErr = !rmmAll.length
    } catch (e) { rmmErr = true; rmmStatus = 'Fehler: ' + e.message }
  }

  async function toggleSites(clientid) {
    if (openClient === clientid) { openClient = null; sites = []; return }
    openClient = clientid; sites = []; sitesStatus = 'Sites laden …'
    try {
      const r = await dlApi.rmmSites(clientid)
      sites = r.sites || []; sitesStatus = sites.length ? '' : 'Keine Sites.'
    } catch (e) { sitesStatus = 'Fehler: ' + e.message }
  }

  // Bitwarden-Desktop-App. Kein API-Key noetig: bitwarden.com/download leitet
  // auf das aktuelle GitHub-Release um, das Backend loest Version, Stub-Installer
  // und Offline-Pakete daraus auf (siehe api/lib/bitwarden.js).
  let bwRel = $state(null)
  let bwLoading = $state(false)
  let bwStatus = $state('')
  let bwErr = $state(false)
  // Paketierung: 'x64' (Standard), 'x64+arm64' oder 'online' (nur der Stub).
  let bwMode = $state('x64')
  const BW_MODE_ARCHS = { x64: ['x64'], 'x64+arm64': ['x64', 'arm64'], online: [] }
  let bwArchs = $derived(BW_MODE_ARCHS[bwMode] || ['x64'])
  let bwPkg = $derived(Object.fromEntries((bwRel?.packages || []).map(p => [p.arch, p])))
  let bwUploadSize = $derived(
    (bwRel?.installerSize || 0) + bwArchs.reduce((n, a) => n + (bwPkg[a]?.size || 0), 0))

  function mb(bytes) {
    if (!bytes) return '?'
    return bytes >= 1048576 ? Math.round(bytes / 1048576) + ' MB' : (bytes / 1024).toFixed(0) + ' KB'
  }

  async function loadBw(refresh) {
    bwLoading = true; bwErr = false; bwStatus = 'Aktuelles Release ermitteln …'
    try {
      const r = await dlApi.bwRelease(refresh)
      bwRel = r.release
      bwStatus = ''
    } catch (e) { bwErr = true; bwStatus = 'Fehler: ' + e.message }
    bwLoading = false
  }

  // FortiClient (EMS bietet keine API — Admin gibt die site-spezifische
  // Installer-Ordner-URL manuell an, wir laden MSI+MST von dort direkt).
  let fcUrl = $state('')

  // Bekannte EMS-Site-Namen (Stand: manueller Export aus der EMS-Konsole,
  // "Site and License Configuration" — 24 von insgesamt 47 Sites erfasst;
  // "Global" ist kein Kunde, sondern der Lizenz-Pool, daher hier ausgelassen).
  // Dient nur als Gedächtnisstütze beim Zusammenbauen der Installer-URL, da
  // EMS keine API zum Auflisten der Sites bietet.
  const FC_KNOWN_SITES = [
    'ACT', 'AUGENARZTZENTRUM', 'BarmettlerEntertainmentLaw', 'BelleriveMonte', 'Bienvenue',
    'BonAssistus', 'Brandsoul', 'BruehlmannBeratungenSH', 'CloudIB', 'Compark',
    'CorraTransporteSH', 'DDM', 'DrItenDudli', 'EcoLysis', 'FINserv',
    'Frauenhotel', 'GoetteOptik', 'igeeks', 'IM43', 'IndependentCapital',
    'JudundPartner', 'JUVENAL', 'KurtSchlatterAG', 'LimmatCapital'
  ]
  let fcSiteQuery = $state('')
  let fcSiteOpen = $state(false)
  let fcSiteFiltered = $derived(
    fcSiteQuery.trim()
      ? FC_KNOWN_SITES.filter(s => s.toLowerCase().includes(fcSiteQuery.trim().toLowerCase()))
      : FC_KNOWN_SITES
  )
  function pickFcSite(site) {
    fcUrl = `https://forticlient.igeekscloud.ch:10443/installers/${site}/${site} 7.4.3/msi/x64/`
    fcSiteQuery = site
    fcSiteOpen = false
  }

  function bdBtns(p) {
    const b = []
    if (p.installLinkWindows) b.push({ u: p.installLinkWindows, t: '⬇ Installer', primary: true })
    if (p.fullKitWindowsX64) b.push({ u: p.fullKitWindowsX64, t: 'x64' })
    if (p.fullKitWindowsArm64) b.push({ u: p.fullKitWindowsArm64, t: 'ARM64' })
    if (p.fullKitWindowsX32) b.push({ u: p.fullKitWindowsX32, t: 'x32' })
    return b
  }
</script>

<section class="settings-section">
  <h2>Apps &amp; Agents — Bitdefender, N-sight RMM, FortiClient &amp; Bitwarden</h2>
  <div class="alert alert-info">
    <strong>ℹ️ So funktioniert es:</strong> Kunde bzw. Paket suchen → Windows-Agent herunterladen oder direkt
    als Win32-App in Intune bereitstellen. Die API-Keys liegen im Backend (<code>BD_API_KEY</code> /
    <code>RMM_API_KEY</code>) und werden serverseitig verwendet — sie landen nie im Browser oder in einer URL.
    Bitwarden braucht keinen Key (öffentlicher Download).
  </div>

  {#if !$session.online}
    <div class="alert alert-warning"><strong>Backend nicht erreichbar.</strong></div>
  {:else if !$session.loggedIn}
    <div class="alert alert-warning">
      <strong>Nicht angemeldet.</strong> Oben rechts im Header auf <strong>Anmelden</strong> klicken.
    </div>
  {:else if !cfg}
    <div class="dl-empty">Lade …</div>
  {:else}
    <div class="dl-subtabs">
      <button type="button" class="dl-subtab" class:active={sub === 'bd'} onclick={() => switchSub('bd')}>🛡️ Bitdefender</button>
      <button type="button" class="dl-subtab" class:active={sub === 'rmm'} onclick={() => switchSub('rmm')}>🖥️ N-sight RMM</button>
      <button type="button" class="dl-subtab" class:active={sub === 'fc'} onclick={() => switchSub('fc')}>🔴 FortiClient</button>
      <button type="button" class="dl-subtab" class:active={sub === 'bw'} onclick={() => switchSub('bw')}>🔐 Bitwarden</button>
      <button type="button" class="dl-subtab" class:active={sub === 'hyg'} onclick={() => { sub = 'hyg'; if (!hyg && !hygBusy) loadHyg() }}>🔎 App-Hygiene</button>
    </div>

    <!-- App-Hygiene -->
    <div class="dl-panel" class:active={sub === 'hyg'}>
      <div class="alert alert-info">
        <strong>Was hier geprüft wird:</strong> die vorhandenen Win32-Apps des aktiven Tenants gegen das gemeinsame
        Grundgerüst — Anzeigename ohne Kundennamen, genau eine Nennung des Installers, ein Token passend zur
        hochgeladenen Datei, korrekter Hersteller, gesetztes Mindest-Betriebssystem, genau eine Required-Gruppe.
        Rein lesend: Das Werkzeug ändert hier nichts, es sagt nur, was zu ändern ist.
      </div>

      <div class="dl-toolbar">
        <button class="btn btn-primary" disabled={hygBusy} onclick={loadHyg}>{hygBusy ? 'Prüfe…' : (hyg ? 'Erneut prüfen' : 'Prüfen')}</button>
        {#if hyg}
          <label class="rm-check" style="margin:0">
            <input type="checkbox" bind:checked={hygNurBefunde} />
            <span>Nur Apps mit Befund</span>
          </label>
          <span class="dl-count">
            {hyg.zusammenfassung.gesamt} Apps · {hyg.zusammenfassung.fehler} Fehler ·
            {hyg.zusammenfassung.warn} Warnungen · {hyg.zusammenfassung.hinweis} Hinweise
          </span>
        {/if}
      </div>

      {#if hygError}<div class="alert alert-warning">❌ {hygError}</div>{/if}

      {#if hyg}
        {#if hyg.zusammenfassung.detailFehlt}
          <div class="alert alert-warning">
            Für {hyg.zusammenfassung.detailFehlt} App(s) konnten die Details nicht geladen werden — bei sehr vielen Apps
            wird die Detailrunde begrenzt, damit die Prüfung nicht in einen Timeout läuft. Erkennungsregeln und
            Kommandozeile fehlen dort in der Bewertung.
          </div>
        {/if}

        {#if !hygSichtbar.length}
          <div class="dl-empty">
            {hyg.zusammenfassung.gesamt ? 'Kein Befund — alle geprüften Apps entsprechen dem Grundgerüst.' : 'Keine Win32-Apps in diesem Tenant.'}
          </div>
        {/if}

        {#each hygSichtbar as a (a.id)}
          <div class="ah-app {a.schwere}">
            <div class="ah-app-head">
              <b>{a.displayName}</b>
              <span class="ah-sev {a.schwere}">{a.schwere === 'ok' ? 'in Ordnung' : a.schwere}</span>
              {#if a.agent}<span class="hd-tag">{a.agent.label}</span>{/if}
              {#if a.publisher}<span class="hd-why" style="margin:0">{a.publisher}</span>{/if}
            </div>

            {#if a.installCommandLine}<div class="ah-meta">{a.installCommandLine}</div>{/if}

            {#if a.bitdefender}
              <div class="ah-meta">
                {#each a.bitdefender.tokens as t (t.token)}
                  <div>
                    Token {t.token}
                    {#if t.lesbar}→ Paket {t.paketId || '?'} · Sprache {t.sprache || '?'}{:else}→ {t.grund}{/if}
                  </div>
                {/each}
              </div>
            {/if}

            {#if a.assignments.length}
              <div class="hd-why">
                Zuweisung: {a.assignments.map(x => `${x.gruppe} (${x.intent}${x.mitgliederBekannt ? `, ${x.mitglieder} Mitglied(er)` : ''})`).join(' · ')}
              </div>
            {:else}
              <div class="hd-why">Keine Zuweisung.</div>
            {/if}

            {#each a.funde as f}
              <div class="ah-fund">
                <b>{f.schwere === 'fehler' ? '❌' : f.schwere === 'warn' ? '⚠️' : 'ℹ️'} {f.titel}</b>
                {f.text}
                {#if f.empfehlung}<div class="ah-emp">→ {f.empfehlung}</div>{/if}
              </div>
            {/each}
          </div>
        {/each}
      {/if}
    </div>

    <!-- Bitdefender -->
    <div class="dl-panel" class:active={sub === 'bd'}>
      {#if !cfg.bd}
        <div class="alert alert-warning">Kein <code>BD_API_KEY</code> gesetzt — Bereich inaktiv.</div>
      {:else}
        <div class="dl-toolbar">
          <input type="search" class="dl-search" placeholder="🔍 Paket filtern …" bind:value={bdQuery} />
          <span class="dl-count">{bdFiltered.length === bdAll.length ? (bdAll.length || '') : bdFiltered.length + ' von ' + bdAll.length}</span>
          <button class="btn btn-secondary dl-reload" title="Neu laden" onclick={loadBd}>↻</button>
        </div>
        <div class="dl-status" class:err={bdErr}>{bdStatus}</div>
        <div class="dl-scroll">
          {#if !bdFiltered.length}
            <div class="dl-empty">{bdLoaded ? 'Keine Treffer.' : ''}</div>
          {:else}
            {#each bdFiltered as p}
              <div class="dl-card">
                <div class="dl-name">{p.packageName}</div>
                <div class="dl-actions">
                  {#each bdBtns(p) as b}
                    <button class="btn {b.primary ? 'btn-primary' : 'btn-secondary'}"
                            onclick={() => { dlApi.bdDownload(b.u); bdStatus = 'Download gestartet — Seite offen lassen.' }}>
                      {b.t}
                    </button>
                  {/each}
                  <button class="btn btn-secondary" title="Direkt als Win32-App in Intune bereitstellen"
                          onclick={() => (deployModal = { vendor: 'bitdefender', appNameDefault: p.packageName, source: { downloadUrl: p.installLinkWindows || p.fullKitWindowsX64 } })}>
                    🟦 In Intune
                  </button>
                </div>
              </div>
            {/each}
          {/if}
        </div>
      {/if}
    </div>

    <!-- N-sight -->
    <div class="dl-panel" class:active={sub === 'rmm'}>
      {#if !cfg.rmm}
        <div class="alert alert-warning">Kein <code>RMM_API_KEY</code> gesetzt — Bereich inaktiv.</div>
      {:else}
        <div class="dl-toolbar">
          <input type="search" class="dl-search" placeholder="🔍 Client filtern …" bind:value={rmmQuery} />
          <select class="dl-os" title="Betriebssystem" bind:value={rmmOs}>
            <option value="windows">Windows</option>
            <option value="mac">macOS</option>
            <option value="linux">Linux</option>
          </select>
          <span class="dl-count">{rmmFiltered.length === rmmAll.length ? (rmmAll.length || '') : rmmFiltered.length + ' von ' + rmmAll.length}</span>
          <button class="btn btn-secondary dl-reload" title="Neu laden" onclick={loadRmm}>↻</button>
        </div>
        <div class="dl-status" class:err={rmmErr}>{rmmStatus}</div>
        <div class="dl-scroll">
          {#if !rmmFiltered.length}
            <div class="dl-empty">{rmmLoaded ? 'Keine Treffer.' : ''}</div>
          {:else}
            {#each rmmFiltered as cl}
              <div class="dl-item">
                <div class="dl-card dl-click" onclick={() => toggleSites(cl.id)} role="button" tabindex="0"
                     onkeydown={(e) => e.key === 'Enter' && toggleSites(cl.id)}>
                  <div class="dl-name">{openClient === cl.id ? '▾' : '▸'} {cl.name} <small>(ID: {cl.id})</small></div>
                </div>
                {#if openClient === cl.id}
                  <div class="dl-sites">
                    {#if sitesStatus}
                      <div class="dl-empty" class:err={sitesStatus.startsWith('Fehler')}>{sitesStatus}</div>
                    {/if}
                    {#each sites as s}
                      <div class="dl-site">
                        <div class="dl-name">{s.name} <small>(Site: {s.id})</small></div>
                        <div class="dl-actions">
                          <button class="btn btn-primary"
                                  onclick={() => { dlApi.rmmDownload({ endcustomerid: cl.id, siteid: s.id, type: 'remote_worker', os: rmmOs }); rmmStatus = 'Download gestartet (remote_worker, ' + rmmOs + '). Build kann dauern.' }}>⬇ Remote Worker</button>
                          <button class="btn btn-secondary"
                                  onclick={() => { dlApi.rmmDownload({ endcustomerid: cl.id, siteid: s.id, type: 'group_policy', os: rmmOs }); rmmStatus = 'Download gestartet (group_policy, ' + rmmOs + '). Build kann dauern.' }}>Group Policy</button>
                          <button class="btn btn-secondary" title="Direkt als Win32-App in Intune bereitstellen"
                                  onclick={() => (deployModal = { vendor: 'nsight', appNameDefault: cl.name + ' RMM-Agent', source: { endcustomerid: cl.id, siteid: s.id, type: 'remote_worker', os: rmmOs } })}>
                            🟦 In Intune
                          </button>
                        </div>
                      </div>
                    {/each}
                  </div>
                {/if}
              </div>
            {/each}
          {/if}
        </div>
        <small class="dl-hint">Client anklicken → Sites. Der erste Agent-Build kann einige Sekunden dauern — Seite offen lassen.</small>
      {/if}
    </div>

    <!-- FortiClient -->
    <div class="dl-panel" class:active={sub === 'fc'}>
      <div class="alert alert-info">
        <strong>ℹ️ Keine API bei FortiClient EMS</strong> (bestätigt — es gibt dort weder eine Möglichkeit, Sites
        aufzulisten, noch Installer-Links zu erzeugen). Pro Kunde/Site liegt stattdessen bereits ein von EMS
        vorkonfiguriertes MSI+MST-Paar unter <code>forticlient.igeekscloud.ch</code> — die .mst-Transform-Datei
        enthält die Registrierung auf den passenden EMS-Server/die Site. Ordner-URL des jeweiligen Kunden
        unten einfügen (Pfad endet auf <code>msi/x64/</code>, im Browser bei EMS/dem Installer-Host abrufbar).
      </div>
      <div class="input-group" style="max-width:640px; margin-bottom:0.75rem;">
        <label for="fcSiteSearch">Bekannte Site suchen (24 von 47 EMS-Sites erfasst)</label>
        <div style="position:relative;">
          <input id="fcSiteSearch" type="text" bind:value={fcSiteQuery}
                 onfocus={() => (fcSiteOpen = true)}
                 onblur={() => setTimeout(() => (fcSiteOpen = false), 150)}
                 placeholder="🔍 Kunde/Site tippen …" autocomplete="off" />
          {#if fcSiteOpen && fcSiteFiltered.length}
            <div class="dl-scroll" style="position:absolute; z-index:5; top:100%; left:0; right:0;
                        background:var(--bg-elevated,#fff); border:1px solid var(--border,#ccc);
                        border-radius:6px; max-height:220px; overflow-y:auto;">
              {#each fcSiteFiltered as site}
                <div class="dl-card dl-click" role="button" tabindex="0"
                     onmousedown={() => pickFcSite(site)}
                     onkeydown={(e) => e.key === 'Enter' && pickFcSite(site)}>
                  <div class="dl-name">{site}</div>
                </div>
              {/each}
            </div>
          {/if}
        </div>
        <small>Liste ist unvollständig (24/47) — EMS bietet keine API dafür. Fehlt ein Kunde, unten die URL manuell eintragen.</small>
      </div>
      <div class="input-group" style="max-width:640px; margin-bottom:0.75rem;">
        <label for="fcUrl">Installer-Ordner-URL (site-spezifisch)</label>
        <input id="fcUrl" type="text" bind:value={fcUrl}
               placeholder="https://forticlient.igeekscloud.ch:10443/installers/<site>/<site> 7.4.3/msi/x64/" />
        <small>Muss auf <code>forticlient.igeekscloud.ch</code> zeigen — das Tool lädt von dort <code>forticlient.msi</code> und <code>forticlient.mst</code>. Version (<code>7.4.3</code>) ggf. anpassen, falls der Kunde eine andere FortiClient-Version bekommt.</small>
      </div>
      <button class="btn btn-secondary" disabled={!fcUrl.trim()}
              title="Direkt als Win32-App in Intune bereitstellen"
              onclick={() => (deployModal = { vendor: 'forticlient', appNameDefault: 'FortiClient', source: { baseUrl: fcUrl.trim() } })}>
        🟦 In Intune bereitstellen
      </button>
    </div>

    <!-- Bitwarden -->
    <div class="dl-panel" class:active={sub === 'bw'}>
      <div class="alert alert-info">
        <strong>ℹ️ Was hier ausgerollt wird:</strong> die <b>Desktop-App</b> als Win32-App. Die Server-Region der
        <b>Browsererweiterung</b> (EU statt US) kannst du im Bereitstellen-Dialog <b>direkt mitgeben</b> — sie wird dann
        als Plattformskript derselben Gerätegruppe zugewiesen. Die Region der <b>Desktop-App</b> setzt weder das eine noch
        das andere: die liest sie aus dem Benutzerprofil, dort wählt sie der Benutzer beim ersten Login.
        Für Bitwarden-Cloud <i>und</i> Self-Hosting ist der Installer derselbe. Kein API-Key nötig.
      </div>

      <div class="dl-toolbar">
        <span class="dl-count">{bwRel ? 'Version ' + bwRel.version : ''}</span>
        <button class="btn btn-secondary dl-reload" title="Release neu ermitteln" onclick={() => loadBw(true)} disabled={bwLoading}>↻</button>
      </div>
      <div class="dl-status" class:err={bwErr}>{bwStatus}</div>

      {#if bwRel}
        <div class="alert alert-warning">
          ⚠️ <strong>Der Bitwarden-Installer ist ein Web-Installer.</strong>
          <code>{bwRel.installerName}</code> ist nur ein Stub von {mb(bwRel.installerSize)} — die eigentlichen
          ~{mb(bwPkg.x64?.size)} lädt er <b>während der Installation</b> aus dem Internet nach. Auf einem verwalteten Gerät
          ist das die schlechte Variante: das Gerät braucht im SYSTEM-Kontext freien Zugriff auf
          <code>github.com</code>, und schlägt der Download fehl, zeigt der Installer eine Meldung an, die dort niemand
          sieht — die Installation hängt bis zum Intune-Timeout. Deshalb packen wir das Offline-Paket standardmäßig
          mit ins Intune-Paket: liegt es neben dem Installer, wird es (mit Prüfsummen-Kontrolle) direkt verwendet.
        </div>

        <div class="settings-group">
          <h4>Paketierung für Intune</h4>
          <label class="checkbox-label" style="display:flex; gap:.5rem; margin-bottom:.35rem;">
            <input type="radio" name="bwMode" value="x64" checked={bwMode === 'x64'} onchange={() => (bwMode = 'x64')} />
            <span><b>Offline, x64</b> <small>({mb((bwRel.installerSize || 0) + (bwPkg.x64?.size || 0))} Upload)</small> —
              empfohlen. Zuweisung nur an x64-Geräte.</span>
          </label>
          <label class="checkbox-label" style="display:flex; gap:.5rem; margin-bottom:.35rem;">
            <input type="radio" name="bwMode" value="x64+arm64" checked={bwMode === 'x64+arm64'} onchange={() => (bwMode = 'x64+arm64')} />
            <span><b>Offline, x64 + ARM64</b> <small>({mb((bwRel.installerSize || 0) + (bwPkg.x64?.size || 0) + (bwPkg.arm64?.size || 0))} Upload)</small> —
              nur nötig, wenn im Tenant ARM64-Geräte (z.B. Snapdragon-Notebooks) laufen. Verdoppelt Upload und
              Arbeitsspeicherbedarf des Backends während des Deployments (grob 1,6 GB statt 0,8 GB).</span>
          </label>
          <label class="checkbox-label" style="display:flex; gap:.5rem;">
            <input type="radio" name="bwMode" value="online" checked={bwMode === 'online'} onchange={() => (bwMode = 'online')} />
            <span><b>Nur Web-Installer</b> <small>({mb(bwRel.installerSize)} Upload)</small> —
              das Gerät lädt bei der Installation selbst nach. Nur wählen, wenn die Geräte sicher ans Internet kommen.</span>
          </label>
        </div>

        <div class="dl-card">
          <div class="dl-name">{bwRel.installerName} <small>({mb(bwRel.installerSize)})</small></div>
          <div class="dl-actions">
            <button class="btn btn-primary"
                    onclick={() => { dlApi.bwDownload({ what: 'installer' }); bwStatus = 'Download gestartet — Seite offen lassen.' }}>⬇ Installer</button>
            {#each bwRel.packages as p (p.arch)}
              <button class="btn btn-secondary" title="Offline-Paket {p.file}"
                      onclick={() => { dlApi.bwDownload({ what: 'package', arch: p.arch }); bwStatus = 'Download gestartet (' + p.arch + ', ' + mb(p.size) + ') — Seite offen lassen.' }}>
                ⬇ Paket {p.arch}
              </button>
            {/each}
            <button class="btn btn-secondary" title="Direkt als Win32-App in Intune bereitstellen"
                    onclick={() => (deployModal = { vendor: 'bitwarden', appNameDefault: 'Bitwarden', source: { architectures: bwArchs } })}>
              🟦 In Intune
            </button>
          </div>
        </div>
        <small class="dl-hint">
          Für den Intune-Upload lädt das Backend {bwArchs.length ? 'Installer + Offline-Paket' : 'nur den Installer'}
          selbst herunter (~{mb(bwUploadSize)}) und prüft die Prüfsummen gegen Bitwardens <code>latest.yml</code> —
          die Dateien oben braucht man dafür nicht manuell.
          {#if bwArchs.length}Der Upload dauert entsprechend ein paar Minuten.{/if}
        </small>

        <div class="settings-group" style="margin-top:1rem;">
          <h4>Bezugsquelle</h4>
          <p class="ld-section-hint">Woher das Backend die Dateien holt — und damit, was die Firewall für den
            <b>Server</b> offen haben muss (nicht für die Endgeräte: die installieren aus dem Intune-Paket).</p>
          <table class="gt-table">
            <thead><tr><th>Host</th><th>Wofür</th></tr></thead>
            <tbody>
              {#each bwRel.sourceHosts || [] as h (h.host)}
                <tr><td><code>{h.host}</code></td><td>{h.purpose}</td></tr>
              {/each}
            </tbody>
          </table>
          <small class="dl-hint" style="display:block; margin-top:.5rem;">
            Aktuelles Release: <code>{bwRel.baseUrl}</code><br />
            Erreichbarkeit dieser Hosts prüfen: Tab <b>Diagnose → Erreichbarkeit</b>.
          </small>
        </div>
      {/if}
    </div>
  {/if}
</section>

{#if deployModal}
  <AppDeployModal open={true} onclose={() => (deployModal = null)}
                   vendor={deployModal.vendor} appNameDefault={deployModal.appNameDefault} source={deployModal.source}
                   tenantId={$activeTenant?.id ?? null} tenantName={$activeTenant?.name ?? ''} />
{/if}
