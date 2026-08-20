<script>
  // Konfigurator für die Tenant-zu-Tenant-Gerätemigration.
  //
  // Wichtig zum Verständnis: Der aktive Tenant im Tool ist der QUELLTENANT --
  // dort sind die Geräte noch Intune-verwaltet, dorthin wird das Paket
  // deployt. Der Zieltenant braucht kein Deployment, nur eine
  // App-Registrierung und ein Provisioning Package.
  import { onDestroy } from 'svelte'
  import { apiGet, apiPost, apiDelete } from '../lib/api.js'
  import { activeTenant } from '../lib/tenantStore.js'
  import TenantContext from '../lib/TenantContext.svelte'

  let form = $state({
    appName: 'Tenant-Migration',
    sourceTenant: { tenantName: '', clientId: '', clientSecret: '' },
    targetTenant: { tenantName: '', clientId: '', clientSecret: '' },
    groupTag: '',
    bitlocker: 'migrate',
    sccm: false,
    fallbackAdmin: { enabled: true, name: 'igeeksRecovery', password: '', removeAfterMigration: false },
    cleanupLocalPath: true
  })

  // Quelltenant vorbelegen, sobald ein Tenant gewählt ist
  let lastPrefill = null
  $effect(() => {
    const t = $activeTenant
    if (!t || lastPrefill === t.id) return
    lastPrefill = t.id
    form.sourceTenant.tenantName = t.organization || t.tenantId || ''
    loadPpkgState()
  })

  // ---------- App-Registrierungen anlegen lassen ----------
  // Client-ID und Secret aus zwei Portalen zusammenzusuchen ist fehleranfällig
  // und der häufigste Grund, warum es erst auf dem Gerät knallt. Stattdessen
  // meldet sich ein Admin des jeweiligen Tenants per Device-Code an, und das
  // Tool legt die App mit den passenden Rechten selbst an.
  let appRegStep = $state(null)      // { side, userCode, verificationUri }
  let appRegError = $state(null)
  let appRegDone = $state({})        // side -> { appId, permissions, consentOk, consentErr }
  let appRegCopied = $state(false)
  let appRegTimer = null

  const SIDE_LABEL = { source: 'Quelltenant', target: 'Zieltenant' }

  async function startAppReg(side) {
    const tenant = side === 'source' ? form.sourceTenant.tenantName : form.targetTenant.tenantName
    if (!tenant.trim()) { appRegError = `Erst die Domain des ${SIDE_LABEL[side]}s eintragen.`; return }
    appRegError = null
    appRegCopied = false
    if (appRegTimer) { clearTimeout(appRegTimer); appRegTimer = null }
    try {
      const r = await apiPost('/api/migration/appreg/start', { side, tenant })
      appRegStep = { side, userCode: r.userCode, verificationUri: r.verificationUri }
      pollAppReg(r.interval || 5)
    } catch (e) {
      appRegError = e.message
    }
  }

  function pollAppReg(interval) {
    appRegTimer = setTimeout(async () => {
      let r
      try { r = await apiPost('/api/migration/appreg/poll') }
      catch (e) { appRegError = e.message; appRegStep = null; return }
      if (r.status === 'pending') { pollAppReg(r.interval || interval); return }
      if (r.status === 'error') { appRegError = r.error; appRegStep = null; return }

      const side = r.side
      const target = side === 'source' ? form.sourceTenant : form.targetTenant
      target.clientId = r.appId
      target.clientSecret = r.clientSecret
      appRegDone[side] = { appId: r.appId, permissions: r.permissions, consentOk: r.consentOk, consentErr: r.consentErr, displayName: r.displayName }
      appRegStep = null
      // Mit den frischen Credentials gleich die GroupTags holen
      if (side === 'target') loadGroupTags()
    }, interval * 1000)
  }

  // ---------- GroupTags des Zieltenants ----------
  let groupTags = $state(null)       // null = nicht geladen, [] = keine gefunden
  let groupTagsError = $state(null)
  let groupTagsBusy = $state(false)

  async function loadGroupTags() {
    const t = form.targetTenant
    if (!t.tenantName.trim() || !t.clientId.trim() || !t.clientSecret.trim()) {
      groupTagsError = 'Zieltenant-Zugang fehlt — erst App-Registrierung anlegen.'
      return
    }
    groupTagsBusy = true
    groupTagsError = null
    try {
      const r = await apiPost('/api/migration/grouptags', {
        tenantName: t.tenantName, clientId: t.clientId, clientSecret: t.clientSecret
      })
      groupTags = r.groupTags || []
      if (groupTags.length && !form.groupTag) form.groupTag = groupTags[0].groupTag
    } catch (e) {
      groupTagsError = e.message
      groupTags = null
    }
    groupTagsBusy = false
  }

  // ---------- Provisioning Package ----------
  let ppkg = $state(null)      // { name, size }
  let ppkgBusy = $state(false)
  let ppkgError = $state(null)

  async function loadPpkgState() {
    if (!$activeTenant) return
    try {
      const r = await apiGet(`/api/tenants/${encodeURIComponent($activeTenant.id)}/migration/ppkg`)
      ppkg = r.present ? { name: r.name, size: r.size } : null
    } catch (e) { /* egal */ }
  }

  async function onPpkgSelected(e) {
    const file = e.target.files && e.target.files[0]
    if (!file || !$activeTenant) return
    ppkgBusy = true
    ppkgError = null
    try {
      const buf = await file.arrayBuffer()
      // In Blöcken zu Base64 -- String.fromCharCode(...ganzesArray) sprengt bei
      // grösseren Dateien den Stack.
      const bytes = new Uint8Array(buf)
      let binary = ''
      for (let i = 0; i < bytes.length; i += 8192) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192))
      }
      const r = await apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/migration/ppkg`, {
        name: file.name, dataBase64: btoa(binary)
      })
      ppkg = { name: r.name, size: r.size }
    } catch (err) {
      ppkgError = err.message
    }
    ppkgBusy = false
    e.target.value = ''
  }

  async function removePpkg() {
    if (!$activeTenant) return
    await apiDelete(`/api/tenants/${encodeURIComponent($activeTenant.id)}/migration/ppkg`)
    ppkg = null
  }

  // ---------- Vorschau ----------
  let preview = $state(null)
  let previewError = $state(null)

  async function loadPreview() {
    previewError = null
    preview = null
    try {
      const r = await apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/migration/preview`, form)
      preview = r.config
    } catch (e) {
      previewError = e.message
    }
  }

  // ---------- Deploy ----------
  let confirmOpen = $state(false)
  let job = $state(null)
  let deployError = $state(null)
  let jobTimer = null

  async function startDeploy() {
    confirmOpen = false
    deployError = null
    job = null
    let start
    try {
      start = await apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/migration/deploy`, form)
    } catch (e) {
      deployError = e.message
      return
    }
    pollJob(start.jobId)
  }

  function pollJob(jobId) {
    jobTimer = setTimeout(async () => {
      let j
      try { j = await apiGet(`/api/appjobs/${encodeURIComponent(jobId)}`) }
      catch (e) { deployError = 'Fortschritt nicht abrufbar: ' + e.message; return }
      job = j
      if (j.status === 'running') pollJob(jobId)
    }, 1500)
  }

  const ready = $derived(
    !!$activeTenant && !!ppkg &&
    !!form.appName.trim() &&
    !!form.targetTenant.tenantName.trim() && !!form.targetTenant.clientId.trim() && !!form.targetTenant.clientSecret.trim() &&
    !!form.sourceTenant.tenantName.trim() && !!form.sourceTenant.clientId.trim() && !!form.sourceTenant.clientSecret.trim()
  )

  onDestroy(() => {
    if (jobTimer) clearTimeout(jobTimer)
    if (appRegTimer) clearTimeout(appRegTimer)
  })
</script>

<TenantContext>
  <div class="alert alert-warning">
    <strong>⚠️ Dieses Paket löst Geräte aus dem aktuellen Tenant.</strong>
    Der aktive Tenant <strong>{$activeTenant?.name}</strong> ist der <strong>Quelltenant</strong> — dorthin wird die
    Intune-App deployt, dort laufen die Geräte noch. Der Zieltenant bekommt kein Deployment, nur eine
    App-Registrierung und das Provisioning Package. Zuweisen an eine Pilotgruppe machst du bewusst selbst in Intune.
  </div>

  {#if appRegError}
    <div class="alert alert-warning">❌ App-Registrierung: {appRegError}</div>
  {/if}

  <div class="settings-group">
    <h4>1️⃣ Intune-App</h4>
    <div class="input-group" style="max-width:420px">
      <label for="mg-appname">Name der App in Intune</label>
      <input id="mg-appname" type="text" bind:value={form.appName} />
      <small>Erscheint so im Quelltenant unter Apps → Windows.</small>
    </div>
  </div>

  {#snippet appRegBlock(side)}
    {@const done = appRegDone[side]}
    {#if done}
      <div class="wizard-step">
        <div class="wizard-step-body">
          <div class="wizard-step-title">✅ App „{done.displayName}" angelegt</div>
          <div class="wizard-step-desc">
            Client-ID {done.appId} · Secret übernommen (6 Monate gültig)<br />
            Rechte: {done.permissions.join(', ')}
            {#if !done.consentOk}<br /><strong>⚠️ Admin-Consent nicht durchgelaufen:</strong> {done.consentErr}{/if}
          </div>
        </div>
        <button class="btn btn-secondary" onclick={() => startAppReg(side)}>↻ Neu anlegen</button>
      </div>
    {:else if appRegStep?.side === side}
      <div class="ld-job">
        <div class="ld-onboard-step">1️⃣ Öffne <a href={appRegStep.verificationUri} target="_blank" rel="noopener">{appRegStep.verificationUri}</a></div>
        <div class="ld-onboard-step">2️⃣ Als <strong>Admin des {SIDE_LABEL[side]}s</strong> anmelden und diesen Code eingeben:
          <span class="ld-code">{appRegStep.userCode}</span>
          <button class="btn btn-secondary" style="padding:0.2rem 0.6rem; font-size:0.8rem;"
                  onclick={() => navigator.clipboard.writeText(appRegStep.userCode).then(() => (appRegCopied = true))}>
            {appRegCopied ? '✓ Kopiert' : 'Kopieren'}
          </button>
        </div>
        <div class="ld-onboard-step">3️⃣ <span class="ld-spinner"></span> Warte auf die Anmeldung…</div>
      </div>
    {:else}
      <button class="btn btn-primary" onclick={() => startAppReg(side)}>🔑 App-Registrierung im {SIDE_LABEL[side]} anlegen</button>
      <p class="ld-section-hint">Legt <code>IG-TenantMigration-{side === 'source' ? 'Source' : 'Target'}</code> an, erteilt den
        Admin-Consent und trägt Client-ID und Secret unten ein. Du brauchst dafür einen Admin-Login im {SIDE_LABEL[side]}.</p>
    {/if}
  {/snippet}

  <div class="settings-group">
    <h4>2️⃣ Quelltenant (hier laufen die Geräte heute)</h4>
    <p class="ld-section-hint">Die Skripte melden sich damit an, um Intune- und Autopilot-Objekt des Geräts nach der
      Migration zu entfernen.</p>
    <div class="input-group" style="max-width:420px; margin-bottom:0.6rem">
      <label for="mg-src-tenant">Tenant (Domain oder ID)</label>
      <input id="mg-src-tenant" type="text" bind:value={form.sourceTenant.tenantName} placeholder="alt.onmicrosoft.com" />
    </div>
    {@render appRegBlock('source')}
    <details style="margin-top:0.6rem">
      <summary class="ld-section-hint" style="cursor:pointer">Client-ID und Secret von Hand eintragen</summary>
      <div class="settings-grid" style="margin-top:0.5rem">
        <div class="input-group">
          <label for="mg-src-client">Client-ID</label>
          <input id="mg-src-client" type="text" bind:value={form.sourceTenant.clientId} placeholder="00000000-0000-0000-0000-000000000000" />
        </div>
        <div class="input-group">
          <label for="mg-src-secret">Client Secret</label>
          <input id="mg-src-secret" type="password" bind:value={form.sourceTenant.clientSecret} autocomplete="off" />
        </div>
      </div>
    </details>
  </div>

  <div class="settings-group">
    <h4>3️⃣ Zieltenant (dorthin wandern die Geräte)</h4>
    <div class="input-group" style="max-width:420px; margin-bottom:0.6rem">
      <label for="mg-dst-tenant">Tenant (Domain oder ID)</label>
      <input id="mg-dst-tenant" type="text" bind:value={form.targetTenant.tenantName} placeholder="neu.onmicrosoft.com" />
    </div>
    {@render appRegBlock('target')}
    <details style="margin-top:0.6rem">
      <summary class="ld-section-hint" style="cursor:pointer">Client-ID und Secret von Hand eintragen</summary>
      <div class="settings-grid" style="margin-top:0.5rem">
        <div class="input-group">
          <label for="mg-dst-client">Client-ID</label>
          <input id="mg-dst-client" type="text" bind:value={form.targetTenant.clientId} placeholder="00000000-0000-0000-0000-000000000000" />
        </div>
        <div class="input-group">
          <label for="mg-dst-secret">Client Secret</label>
          <input id="mg-dst-secret" type="password" bind:value={form.targetTenant.clientSecret} autocomplete="off" />
        </div>
      </div>
    </details>

    <div style="margin-top:0.9rem">
      <label for="mg-grouptag"><strong>GroupTag im Zieltenant</strong> <small>(optional)</small></label>
      {#if groupTags && groupTags.length}
        <div style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap; margin-top:0.3rem">
          <select id="mg-grouptag" bind:value={form.groupTag} style="max-width:320px">
            <option value="">— kein GroupTag —</option>
            {#each groupTags as g}
              <option value={g.groupTag}>{g.groupTag} → {g.groupName}</option>
            {/each}
          </select>
          <button class="btn btn-secondary" onclick={loadGroupTags} disabled={groupTagsBusy}>↻</button>
        </div>
        <small class="ld-section-hint">Aus den dynamischen Gruppen des Zieltenants gelesen ([OrderID]-Regel).</small>
      {:else}
        <div style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap; margin-top:0.3rem">
          <input id="mg-grouptag" type="text" bind:value={form.groupTag} placeholder="DEV-STD" style="max-width:220px" />
          <button class="btn btn-secondary" onclick={loadGroupTags} disabled={groupTagsBusy}>
            {groupTagsBusy ? 'Lade…' : '🔎 Aus dem Zieltenant laden'}
          </button>
        </div>
        {#if groupTags && groupTags.length === 0}
          <small class="ld-section-hint">Keine dynamischen Gruppen mit [OrderID]-Regel gefunden — Tag von Hand eintragen.</small>
        {/if}
      {/if}
      {#if groupTagsError}<div class="alert alert-warning" style="margin-top:0.5rem">{groupTagsError}</div>{/if}
    </div>
  </div>

  <div class="settings-group">
    <h4>4️⃣ Provisioning Package des Zieltenants</h4>
    <p class="ld-section-hint">Mit dem Windows Configuration Designer im Zieltenant erzeugen (Bulk-Enrollment-Token).
      Die Datei liegt nur in deiner Sitzung, nicht auf dem Server-Datenträger.</p>
    {#if ppkg}
      <div class="wizard-step">
        <div class="wizard-step-body">
          <div class="wizard-step-title">✅ {ppkg.name}</div>
          <div class="wizard-step-desc">{(ppkg.size / 1024).toFixed(1)} KB</div>
        </div>
        <button class="btn btn-secondary" onclick={removePpkg}>✕ Entfernen</button>
      </div>
    {:else}
      <input type="file" accept=".ppkg" onchange={onPpkgSelected} disabled={ppkgBusy} />
      {#if ppkgBusy}<span class="ld-section-hint">Lade hoch…</span>{/if}
    {/if}
    {#if ppkgError}<div class="alert alert-warning" style="margin-top:0.5rem">{ppkgError}</div>{/if}
  </div>

  <div class="settings-group">
    <h4>5️⃣ Verhalten auf dem Gerät</h4>
    <div class="settings-grid">
      <div class="input-group">
        <label for="mg-bitlocker">BitLocker</label>
        <select id="mg-bitlocker" bind:value={form.bitlocker}>
          <option value="migrate">Recovery-Key in den Zieltenant sichern</option>
          <option value="decrypt">Laufwerk entschlüsseln</option>
        </select>
        <small>Der Recovery-Key im Quelltenant ist danach weg — vorher exportieren.</small>
      </div>
      <div class="input-group">
        <label for="mg-sccm"><input id="mg-sccm" type="checkbox" bind:checked={form.sccm} /> SCCM-Client entfernen</label>
      </div>
      <div class="input-group">
        <label for="mg-cleanup"><input id="mg-cleanup" type="checkbox" bind:checked={form.cleanupLocalPath} /> Arbeitsverzeichnis nach der Migration löschen</label>
        <small>Enthält beide Client Secrets — ausschalten nur zur Fehlersuche.</small>
      </div>
    </div>
  </div>

  <div class="settings-group">
    <h4>6️⃣ Fallback-Admin</h4>
    <p class="ld-section-hint">Lokales Adminkonto, das vor dem ersten destruktiven Schritt angelegt wird und die
      Migration überlebt. Damit kommst du auf ein Gerät, das unterwegs hängen bleibt.</p>
    <div class="settings-grid">
      <div class="input-group">
        <label for="mg-fb-enabled"><input id="mg-fb-enabled" type="checkbox" bind:checked={form.fallbackAdmin.enabled} /> Fallback-Admin anlegen</label>
      </div>
      <div class="input-group">
        <label for="mg-fb-name">Kontoname</label>
        <input id="mg-fb-name" type="text" bind:value={form.fallbackAdmin.name} disabled={!form.fallbackAdmin.enabled} />
      </div>
      <div class="input-group">
        <label for="mg-fb-pw">Passwort <small>(leer = zufällig)</small></label>
        <input id="mg-fb-pw" type="password" bind:value={form.fallbackAdmin.password} disabled={!form.fallbackAdmin.enabled} autocomplete="off" />
        <small>Leer heisst: niemand kennt es. Dann nur sinnvoll, wenn der Zieltenant das Konto per Windows LAPS verwaltet.</small>
      </div>
      <div class="input-group">
        <label for="mg-fb-remove"><input id="mg-fb-remove" type="checkbox" bind:checked={form.fallbackAdmin.removeAfterMigration} disabled={!form.fallbackAdmin.enabled} /> Nach erfolgreicher Migration wieder entfernen</label>
      </div>
    </div>
  </div>

  <div class="settings-group">
    <h4>7️⃣ Prüfen und deployen</h4>
    <div style="display:flex; gap:0.5rem; flex-wrap:wrap">
      <button class="btn btn-secondary" onclick={loadPreview} disabled={!$activeTenant}>👁 config.json ansehen</button>
      <button class="btn btn-primary" onclick={() => (confirmOpen = true)} disabled={!ready || job?.status === 'running'}>
        🚀 Als Intune-App in {$activeTenant?.name ?? '—'} anlegen
      </button>
    </div>
    {#if !ready}
      <p class="ld-section-hint">Es fehlen noch Angaben — beide Tenants vollständig, App-Name und Provisioning Package.</p>
    {/if}

    {#if previewError}<div class="alert alert-warning" style="margin-top:0.75rem">{previewError}</div>{/if}
    {#if preview}
      <pre class="diag-log" style="max-height:22rem">{JSON.stringify(preview, null, 2)}</pre>
      <p class="ld-section-hint">So landet die Datei auf dem Gerät — Secrets sind hier nur in der Anzeige maskiert.</p>
    {/if}
  </div>

  {#if confirmOpen}
    <div class="ld-confirm">
      <strong>🚀 Migrationspaket nach {$activeTenant?.name} hochladen</strong>
      <ul>
        <li>Ziel der Migration: <strong>{form.targetTenant.tenantName}</strong></li>
        <li>Die App wird angelegt, aber <strong>keiner Gruppe zugewiesen</strong> — das machst du in Intune</li>
        <li>Das Paket enthält die Client Secrets beider Tenants</li>
        <li>Auf einem Gerät, das die App bekommt, startet die Migration <strong>ohne weitere Rückfrage</strong></li>
      </ul>
      <div class="ld-confirm-actions">
        <button class="btn btn-primary" onclick={startDeploy}>Jetzt hochladen</button>
        <button class="btn btn-secondary" onclick={() => (confirmOpen = false)}>Abbrechen</button>
      </div>
    </div>
  {/if}

  {#if deployError}
    <div class="ld-job"><div class="ld-banner fail">❌ {deployError}</div></div>
  {/if}

  {#if job}
    <div class="ld-job">
      <div class="ld-job-head">
        <strong>{job.status === 'running' ? '⏳' : ''} Paket-Upload</strong>
        <span class="ld-job-meta">{job.phase}</span>
      </div>
      {#if job.status === 'done'}
        <div class="ld-banner ok">✅ App angelegt (ID {job.appId}). {job.hint || ''}</div>
      {:else if job.status === 'failed'}
        <div class="ld-banner fail">❌ {job.error}{#if job.hint}<br /><small>💡 {job.hint}</small>{/if}</div>
      {/if}
      {#each job.steps as s}
        <div class="ld-step {s.state === 'failed' ? 'fail' : 'ok'}">
          <span class="ld-ico">{s.state === 'done' ? '✅' : s.state === 'failed' ? '❌' : s.state === 'running' ? '⏳' : '○'}</span>
          {s.name}{#if s.detail}<small> ({s.detail})</small>{/if}
        </div>
      {/each}
    </div>
  {/if}
</TenantContext>
