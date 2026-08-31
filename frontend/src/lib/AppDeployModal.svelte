<script>
  import { onDestroy } from 'svelte'
  import { dlApi } from './downloads.js'

  let { open = false, onclose, vendor, appNameDefault = '', source = null, tenantId = null, tenantName = '' } = $props()

  const DEFAULTS = {
    bitdefender: {
      install: '{file} /bdparams /silent',
      uninstall: '',
      detectionType: 'registry',
      hint: 'Bitdefender GravityZone: /bdparams /silent ist der von uns verifizierte Standard-Switch fuer den setupdownloader-Installer. Uninstall-Kommando und Erkennungsregel bitte nach einer Testinstallation aus dem Uninstall-Registry-Schluessel ergaenzen.'
    },
    nsight: {
      install: '{file} /quiet /norestart',
      uninstall: '',
      detectionType: 'file',
      hint: 'N-sight-RMM-Agent: /quiet /norestart ist der von uns verifizierte Standard-Switch. Uninstall-Kommando und Erkennungsregel bitte nach einer Testinstallation ergaenzen.'
    },
    forticlient: {
      install: 'msiexec /i "{file}" TRANSFORMS="forticlient.mst" /qn REBOOT=ReallySuppress DONT_PROMPT_REBOOT=1',
      uninstall: 'msiexec /x "{file}" /qn REBOOT=ReallySuppress',
      detectionType: 'registry',
      hint: 'FortiClient (MSI+MST von EMS, site-spezifisch): offizielle Fortinet-Silent-Syntax msiexec /qn + REBOOT=ReallySuppress + DONT_PROMPT_REBOOT=1. Die .mst-Transform-Datei wird automatisch mit hochgeladen. Erkennungsregel und Uninstall-Kommando (ProductCode kann je Version abweichen) bitte nach einer Testinstallation verifizieren.'
    },
    // Bitwarden-Desktop-App: Install-/Uninstall-Kommando und Erkennungsregel
    // stehen so in der Bitwarden-Doku ("Deploy Desktop Apps with Intune",
    // Reiter "Win32 app") — anders als bei den Agents oben also nicht selbst
    // zu ermitteln, deshalb hier komplett vorbelegt.
    bitwarden: {
      install: '"{file}" /allusers /S',
      uninstall: '"C:\\Program Files\\Bitwarden\\Uninstall Bitwarden.exe" /allusers /S',
      detectionType: 'file',
      detection: { path: 'C:\\Program Files\\Bitwarden', fileOrFolderName: 'Bitwarden.exe' },
      hint: 'Bitwarden-Desktop-App: /allusers /S installiert maschinenweit und still (offizielle Bitwarden-Doku). Install-/Uninstall-Kommando und Erkennungsregel sind bereits korrekt vorbelegt — normalerweise unverändert lassen.'
    }
  }

  let appName = $state('')
  let description = $state('')
  let installCommandLine = $state('')
  let uninstallCommandLine = $state('')
  let detectionType = $state('registry')
  let detectionKeyPath = $state('')
  let detectionValueName = $state('')
  let detectionPath = $state('')
  let detectionFileOrFolderName = $state('')
  let groupTag = $state('')
  // Bitwarden-Client-Konfiguration: die Server-Region der Browsererweiterung
  // gleich mitgeben, statt sie hinterher unter Mappings von Hand zu bauen.
  let bwRegionOn = $state(false)
  let bwRegion = $state('eu')
  let bwSelfhostBase = $state('')
  let groupTags = $state([])
  let groupTagsLoading = $state(false)
  let groupTagsError = $state(null)

  let starting = $state(false)
  let startError = $state(null)
  let jobId = $state(null)
  let job = $state(null)
  let jobTimer = null

  let lastOpen = false
  $effect(() => {
    if (open && !lastOpen) {
      lastOpen = true
      const d = DEFAULTS[vendor] || DEFAULTS.bitdefender
      appName = appNameDefault
      description = ''
      installCommandLine = d.install
      uninstallCommandLine = d.uninstall
      detectionType = d.detectionType
      detectionKeyPath = d.detection?.keyPath || ''
      detectionValueName = d.detection?.valueName || ''
      detectionPath = d.detection?.path || ''
      detectionFileOrFolderName = d.detection?.fileOrFolderName || ''
      groupTag = ''
      bwRegionOn = false; bwRegion = 'eu'; bwSelfhostBase = ''
      startError = null; jobId = null; job = null
      if (jobTimer) { clearTimeout(jobTimer); jobTimer = null }
      loadGroupTags()
    } else if (!open) {
      lastOpen = false
    }
  })

  async function loadGroupTags() {
    if (!tenantId) return
    groupTagsLoading = true
    groupTagsError = null
    try {
      const r = await dlApi.groupTags(tenantId)
      groupTags = r.groupTags || []
      groupTag = groupTags[0]?.groupTag || ''
    } catch (e) {
      groupTagsError = e.message
    }
    groupTagsLoading = false
  }

  function close() {
    if (jobTimer) { clearTimeout(jobTimer); jobTimer = null }
    onclose?.()
  }

  async function start() {
    if (!tenantId) { alert('Kein Tenant ausgewählt.'); return }
    if (!appName.trim()) { alert('App-Name fehlt.'); return }
    if (!installCommandLine.trim() || !uninstallCommandLine.trim()) {
      alert('Install- und Uninstall-Kommando sind Pflicht — Intune kann sonst nicht (de)installieren.')
      return
    }
    if (!groupTag) { alert('Ziel-GroupTag fehlt.'); return }
    const detection = detectionType === 'registry'
      ? { type: 'registry', keyPath: detectionKeyPath, valueName: detectionValueName }
      : { type: 'file', path: detectionPath, fileOrFolderName: detectionFileOrFolderName }

    let clientConfig = null
    if (vendor === 'bitwarden' && bwRegionOn) {
      if (bwRegion === 'selfhost' && !bwSelfhostBase.trim()) {
        alert('Server-URL der eigenen Bitwarden-Instanz fehlt.')
        return
      }
      clientConfig = bwRegion === 'selfhost'
        ? { region: 'selfhost', base: bwSelfhostBase.trim() }
        : { region: bwRegion }
    }

    starting = true
    startError = null
    try {
      const r = await dlApi.appDeployStart(tenantId, {
        vendor, source, appName: appName.trim(), description, installCommandLine, uninstallCommandLine,
        detection, groupTag, clientConfig
      })
      jobId = r.jobId
      pollJob()
    } catch (e) {
      startError = e.message
    }
    starting = false
  }

  function pollJob() {
    jobTimer = setTimeout(async () => {
      let j
      try { j = await dlApi.appDeployPoll(jobId) }
      catch (e) { startError = e.message; return }
      job = j
      if (j.status === 'running') pollJob()
    }, 1200)
  }

  onDestroy(() => { if (jobTimer) clearTimeout(jobTimer) })
</script>

{#if open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="modal" style="display:flex" onclick={(e) => e.target === e.currentTarget && close()}>
    <div class="modal-content" role="dialog" aria-modal="true" aria-label="In Intune bereitstellen">
      <div class="modal-header">
        <h2>In Intune bereitstellen</h2>
        <button class="close-btn" onclick={close}>&times;</button>
      </div>
      <div class="modal-body">
        {#if !tenantId}
          <div class="alert alert-warning">⚠️ Kein Tenant ausgewählt — oben im Header einen Tenant wählen.</div>
        {:else if job}
          <div class="ld-job">
            <div class="ld-job-head"><strong>App-Deployment: {tenantName}</strong></div>
            {#if job.status === 'done'}
              <div class="ld-banner ok">App veröffentlicht und zugewiesen.</div>
              <div class="ld-step"><small>Intune-App-ID: <code>{job.appId}</code><br />
                Ziel: <code>{job.appGroupName}</code> ({job.deviceGroupName} genestet)</small></div>
              {#if job.clientConfig}
                <div class="ld-step"><small>Server-Region: Plattformskript <code>{job.clientConfig.displayName}</code>
                  {job.clientConfig.updated ? 'aktualisiert' : 'angelegt'} ({job.clientConfig.values} Registry-Werte),
                  zugewiesen an <code>{job.clientConfig.groupName}</code>.</small></div>
              {/if}
            {:else if job.status === 'failed'}
              <div class="ld-banner fail">{job.error}</div>
              {#if job.hint}<div class="ld-step"><small>💡 {job.hint}</small></div>{/if}
            {/if}
            {#each job.steps as s}
              {#if s.state === 'running'}
                <div class="ld-step running"><span class="ld-spinner"></span> {s.name}{#if s.detail}<small> · {s.detail}</small>{/if}</div>
              {:else if s.state === 'done'}
                <div class="ld-step ok"><span class="ld-ico">✅</span> {s.name}</div>
              {:else}
                <div class="ld-step pending"><span class="ld-ico">○</span> {s.name}</div>
              {/if}
            {/each}
          </div>
        {:else}
          <div class="tool-tie-in" style="margin-top:0;">
            <span>ℹ️</span>
            <div>Zielgruppe ist immer <code>AAD-APP-{'<Name>'}</code> — die gewählte dynamische GroupTag-Gruppe
              wird als Mitglied genestet, ihre Geräte bekommen die App dadurch automatisch (siehe Wissen →
              Namenskonventionen). <b>Vor breitem Rollout mit einem Pilot-/Testgerät prüfen.</b></div>
          </div>
          <div class="alert alert-warning">⚠️ {(DEFAULTS[vendor] || DEFAULTS.bitdefender).hint}</div>

          <div class="input-group" style="margin-bottom:0.7rem;">
            <label for="adAppName">App-Name (wird auch für <code>AAD-APP-&lt;Name&gt;</code> verwendet)</label>
            <input id="adAppName" type="text" bind:value={appName} />
          </div>
          <div class="input-group" style="margin-bottom:0.7rem;">
            <label for="adDesc">Beschreibung <small>(optional)</small></label>
            <input id="adDesc" type="text" bind:value={description} />
          </div>
          <div class="settings-grid">
            <div class="input-group">
              <label for="adInstall">Install-Kommando</label>
              <input id="adInstall" type="text" bind:value={installCommandLine} />
              <small><code>{'{file}'}</code> wird automatisch durch den heruntergeladenen Installer-Dateinamen ersetzt.</small>
            </div>
            <div class="input-group">
              <label for="adUninstall">Uninstall-Kommando</label>
              <input id="adUninstall" type="text" bind:value={uninstallCommandLine} placeholder="z.B. {'{file}'} /uninstall /silent" />
            </div>
          </div>

          <div class="settings-group">
            <h4>Erkennungsregel (Detection Rule)</h4>
            <div style="display:flex; gap:1rem; margin-bottom:0.5rem;">
              <label class="checkbox-label"><input type="radio" name="adDetType" value="registry" checked={detectionType === 'registry'} onchange={() => (detectionType = 'registry')} /> <span>Registry</span></label>
              <label class="checkbox-label"><input type="radio" name="adDetType" value="file" checked={detectionType === 'file'} onchange={() => (detectionType = 'file')} /> <span>Datei/Ordner</span></label>
            </div>
            {#if detectionType === 'registry'}
              <div class="settings-grid">
                <div class="input-group">
                  <label for="adKeyPath">Registry-Pfad</label>
                  <input id="adKeyPath" type="text" bind:value={detectionKeyPath} placeholder="HKEY_LOCAL_MACHINE\SOFTWARE\...\Uninstall\{'{GUID}'}" />
                </div>
                <div class="input-group">
                  <label for="adValueName">Wertname <small>(optional)</small></label>
                  <input id="adValueName" type="text" bind:value={detectionValueName} placeholder="DisplayVersion" />
                </div>
              </div>
            {:else}
              <div class="settings-grid">
                <div class="input-group">
                  <label for="adPath">Ordnerpfad</label>
                  <input id="adPath" type="text" bind:value={detectionPath} placeholder="C:\Program Files\..." />
                </div>
                <div class="input-group">
                  <label for="adFile">Datei-/Ordnername</label>
                  <input id="adFile" type="text" bind:value={detectionFileOrFolderName} placeholder="agent.exe" />
                </div>
              </div>
            {/if}
          </div>

          {#if vendor === 'bitwarden'}
            <div class="settings-group">
              <h4>Server-Region vorgeben <small>(optional)</small></h4>
              <label class="checkbox-label" style="display:flex; gap:.5rem; margin-bottom:.5rem;">
                <input type="checkbox" bind:checked={bwRegionOn} />
                <span>Beim Bereitstellen zusätzlich die Server-Region der <b>Browsererweiterung</b> festlegen</span>
              </label>
              {#if bwRegionOn}
                <div class="input-group" style="max-width:380px; margin-bottom:0.5rem;">
                  <label for="adBwRegion">Region</label>
                  <select id="adBwRegion" bind:value={bwRegion}>
                    <option value="eu">EU-Cloud — vault.bitwarden.eu</option>
                    <option value="us">US-Cloud — vault.bitwarden.com (Bitwarden-Vorgabe)</option>
                    <option value="selfhost">Eigene Instanz (Self-Hosting)</option>
                  </select>
                </div>
                {#if bwRegion === 'selfhost'}
                  <div class="input-group" style="max-width:380px; margin-bottom:0.5rem;">
                    <label for="adBwBase">Server-URL</label>
                    <input id="adBwBase" type="text" bind:value={bwSelfhostBase} placeholder="https://bitwarden.kunde.ch" />
                  </div>
                {/if}
                <small>Legt zusätzlich das Intune-Plattformskript <code>WIN - RegistryPolicy - Bitwarden-Region</code> an
                  und weist es <b>derselben GroupTag-Gerätegruppe</b> zu. Wirkt auf die Bitwarden-Erweiterung in Chrome
                  und Edge. <b>Die Desktop-App ist davon nicht betroffen</b> — die liest ihre Region aus dem
                  Benutzerprofil, dort wählt sie der Benutzer beim ersten Login.</small>
              {/if}
            </div>
          {/if}

          <div class="input-group" style="margin-bottom:0.7rem; max-width:340px;">
            <label for="adGroupTag">Ziel-GroupTag (dynamische Gerätegruppe)</label>
            {#if groupTagsLoading}
              <small>Lade GroupTags…</small>
            {:else if groupTagsError}
              <small style="color:var(--crit)">{groupTagsError}</small>
            {:else}
              <select id="adGroupTag" bind:value={groupTag}>
                {#each groupTags as g (g.groupTag)}<option value={g.groupTag}>{g.groupTag} → {g.groupName}</option>{/each}
              </select>
            {/if}
          </div>

          {#if startError}<div class="ld-banner fail">{startError}</div>{/if}
        {/if}
      </div>
      <div class="modal-footer">
        {#if !job}
          <button class="btn btn-secondary" onclick={close}>Abbrechen</button>
          <button class="btn btn-primary" onclick={start} disabled={starting || !tenantId}>{starting ? 'Starte…' : '🚀 Bereitstellen'}</button>
        {:else}
          <button class="btn btn-secondary" onclick={close}>Schließen</button>
        {/if}
      </div>
    </div>
  </div>
{/if}
