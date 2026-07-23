<script>
  import { session } from '../lib/session.js'
  import { dlApi } from '../lib/downloads.js'
  import { activeTenant } from '../lib/tenantStore.js'
  import AppDeployModal from '../lib/AppDeployModal.svelte'

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
        .then(c => { cfg = c; if (c.bd) loadBd(); else if (c.rmm) { sub = 'rmm'; loadRmm() } })
        .catch(() => { cfg = { bd: false, rmm: false, error: true } })
    }
    if (!($session.loggedIn && $session.online)) { initTried = false; cfg = null }
  })

  function switchSub(s) {
    sub = s
    if (s === 'bd' && cfg?.bd && !bdLoaded) loadBd()
    if (s === 'rmm' && cfg?.rmm && !rmmLoaded) loadRmm()
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
  <h2>📦 Agent-Downloads — Bitdefender, N-sight RMM &amp; FortiClient</h2>
  <div class="alert alert-info">
    <strong>ℹ️ So funktioniert es:</strong> Kunde bzw. Paket suchen → Windows-Agent herunterladen.
    Die API-Keys liegen im Backend (<code>BD_API_KEY</code> / <code>RMM_API_KEY</code>) und werden
    serverseitig verwendet — sie landen nie im Browser oder in einer URL.
  </div>

  {#if !$session.online}
    <div class="alert alert-warning"><strong>⚠️ Backend nicht erreichbar.</strong></div>
  {:else if !$session.loggedIn}
    <div class="alert alert-warning">
      <strong>🔒 Nicht angemeldet.</strong> Oben rechts im Header auf <strong>Anmelden</strong> klicken.
    </div>
  {:else if !cfg}
    <div class="dl-empty">Lade …</div>
  {:else}
    <div class="dl-subtabs">
      <button type="button" class="dl-subtab" class:active={sub === 'bd'} onclick={() => switchSub('bd')}>🛡️ Bitdefender</button>
      <button type="button" class="dl-subtab" class:active={sub === 'rmm'} onclick={() => switchSub('rmm')}>🖥️ N-sight RMM</button>
      <button type="button" class="dl-subtab" class:active={sub === 'fc'} onclick={() => switchSub('fc')}>🔴 FortiClient</button>
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
  {/if}
</section>

{#if deployModal}
  <AppDeployModal open={true} onclose={() => (deployModal = null)}
                   vendor={deployModal.vendor} appNameDefault={deployModal.appNameDefault} source={deployModal.source}
                   tenantId={$activeTenant?.id ?? null} tenantName={$activeTenant?.name ?? ''} />
{/if}
