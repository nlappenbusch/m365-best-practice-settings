<script>
  import { onDestroy } from 'svelte'
  import { config } from '../lib/config.js'
  import { apiPost, apiGet } from '../lib/api.js'
  import { activeTenant, autoDomains } from '../lib/tenantStore.js'
  import TenantContext from '../lib/TenantContext.svelte'
  import { buildAlertPolicySnippet } from '../lib/alertPolicySnippet.js'

  let snippetCopied = $state(false)

  // Admin-Benachrichtigungsadresse gehoert zum TENANT, nicht in die globale
  // Vorlage: sie landet live in -InternalSenderAdminAddress/-ExternalSender-
  // AdminAddress der Anti-Malware-Policy und in -NotifyOutboundSpamRecipients.
  // Stand in der Vorlage noch ein anderer Kunde, meldeten die Richtlinien des
  // einen Kunden an den Administrator des anderen.
  let tenantAdminEmail = $state('')
  let tenantAdminSaving = $state(false)
  let tenantAdminMsg = $state(null)
  let tenantAdminLoadedFor = null

  $effect(() => {
    const id = $activeTenant?.id ?? null
    if (id === tenantAdminLoadedFor) return
    tenantAdminLoadedFor = id
    tenantAdminEmail = ''
    tenantAdminMsg = null
    if (id) {
      apiGet(`/api/tenants/${encodeURIComponent(id)}/mailsec-admin`)
        .then(r => { tenantAdminEmail = r.email || '' })
        .catch(() => { /* Anzeige bleibt leer, Vorlage greift */ })
    }
  })

  // Was wirklich deployt wird: Tenant-Adresse, sonst die Vorlage.
  const effectiveAdminEmail = $derived(tenantAdminEmail.trim() || $config.global.adminEmail)
  const adminFromTemplate = $derived(!tenantAdminEmail.trim())

  async function saveTenantAdmin() {
    if (!$activeTenant) return
    tenantAdminSaving = true
    tenantAdminMsg = null
    try {
      await apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/mailsec-admin`, { email: tenantAdminEmail.trim() })
      tenantAdminMsg = tenantAdminEmail.trim()
        ? { ok: true, text: 'Gespeichert — gilt nur für diesen Tenant.' }
        : { ok: true, text: 'Gelöscht — es gilt wieder die Adresse aus der Vorlage.' }
    } catch (e) {
      tenantAdminMsg = { ok: false, text: e.message }
    }
    tenantAdminSaving = false
  }

  let alertSnippet = $derived(buildAlertPolicySnippet({ ...$config.global, adminEmail: effectiveAdminEmail }))
  function copyAlertSnippet() {
    navigator.clipboard.writeText(alertSnippet).then(() => {
      snippetCopied = true
      setTimeout(() => (snippetCopied = false), 2000)
    })
  }

  const LD_PHASE_ICONS = {
    'Quarantine Policies': '🔒',
    'Anti-Phishing': '🎣',
    'Anti-Spam': '📧',
    'Anti-Malware': '🦠',
    'Alert Policy (Security & Compliance)': '🔔'
  }
  const LD_ACTION_DE = { created: 'angelegt', updated: 'aktualisiert' }

  function elapsed(startIso, endIso) {
    const ms = (endIso ? new Date(endIso) : new Date()) - new Date(startIso)
    const s = Math.max(0, Math.floor(ms / 1000))
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') + ' min'
  }

  let testBusy = $state(false)
  let testResult = $state(null)   // { ok, domains } | { ok:false, error, hint }

  let confirmOpen = $state(false)
  let deployRunning = $state(false)
  let deployError = $state(null)
  let job = $state(null)
  let jobTimer = null
  let cancelBusy = $state(false)

  // Nach einem Reload oder Tenantwechsel den laufenden bzw. letzten Deploy
  // wieder einblenden — sonst ist ein laufender Job unsichtbar und der
  // naechste Startversuch laeuft nur in "laeuft bereits".
  let lastCheckedTenant = null
  $effect(() => {
    const t = $activeTenant
    if (!t || lastCheckedTenant === t.id) return
    lastCheckedTenant = t.id
    if (jobTimer) { clearTimeout(jobTimer); jobTimer = null }
    job = null
    deployRunning = false
    deployError = null
    attachRunningJob(t.id)
  })
  let lastTenantId = null
  let manualAck = $state({}) // Schrittname -> bool ("ich habe das manuell erledigt")

  // Tenant im globalen Umschalter gewechselt -> lokale Tenant-Workspace-
  // Ausgabe zuruecksetzen (ein laufender Job auf dem Backend laeuft trotzdem
  // zu Ende, wir hoeren nur auf, ihn hier anzuzeigen).
  $effect(() => {
    const id = $activeTenant?.id ?? null
    if (id !== lastTenantId) {
      lastTenantId = id
      testResult = null
      confirmOpen = false
      job = null
      deployError = null
      deployRunning = false
      if (jobTimer) { clearTimeout(jobTimer); jobTimer = null }
    }
  })

  async function testConnection() {
    if (!$activeTenant) return
    testBusy = true
    testResult = null
    try {
      const r = await apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/test`)
      testResult = { ok: true, domains: r.domains || [] }
    } catch (e) {
      testResult = { ok: false, error: e.message, hint: e.hint }
    }
    testBusy = false
  }

  function openConfirm() {
    // Laeuft schon einer: nicht wegklicken, sondern den Fortschritt zeigen —
    // dort steht auch der Abbrechen-Knopf.
    if (deployRunning) return
    confirmOpen = true
    job = null
    deployError = null
  }

  async function startDeploy() {
    confirmOpen = false
    deployRunning = true
    deployError = null
    job = null
    manualAck = {}
    if (jobTimer) { clearTimeout(jobTimer); jobTimer = null }
    const tenantId = $activeTenant.id
    let start
    try {
      start = await apiPost(`/api/tenants/${encodeURIComponent(tenantId)}/deploy`, { config: $config, autoDomains: $autoDomains })
    } catch (e) {
      // 409 heisst: es laeuft schon einer. Statt nur zu meckern an den
      // laufenden Job andocken — der Fortschritt ist sonst nicht einsehbar,
      // weil die Job-Id bisher nur im Browser-Tab lebte.
      if (e.status === 409) {
        const running = await attachRunningJob(tenantId)
        if (running) return
      }
      deployRunning = false
      deployError = e.message
      return
    }
    pollJob(start.jobId)
  }

  // Laufenden (oder letzten) Deploy des Tenants holen und anzeigen.
  async function attachRunningJob(tenantId) {
    try {
      const r = await apiGet(`/api/tenants/${encodeURIComponent(tenantId)}/deploy/active`)
      if (!r.job) return false
      job = r.job
      if (r.running) {
        deployRunning = true
        deployError = null
        pollJob(r.job.id)
        return true
      }
      deployRunning = false
      return false
    } catch (e) {
      return false
    }
  }

  async function cancelDeploy() {
    if (!job || job.status !== 'running') return
    if (!confirm('Laufenden Deploy abbrechen?\n\nWas bereits in Exchange Online geschrieben wurde, bleibt bestehen — '
      + 'die Schritte sind idempotent, ein erneuter Deploy zieht den Rest nach.')) return
    cancelBusy = true
    try {
      await apiPost(`/api/jobs/${encodeURIComponent(job.id)}/cancel`)
      if (jobTimer) { clearTimeout(jobTimer); jobTimer = null }
      job = await apiGet(`/api/jobs/${encodeURIComponent(job.id)}`)
      deployRunning = false
    } catch (e) {
      deployError = 'Abbrechen fehlgeschlagen: ' + e.message
    }
    cancelBusy = false
  }

  function pollJob(jobId) {
    jobTimer = setTimeout(async () => {
      let j
      try { j = await apiGet(`/api/jobs/${encodeURIComponent(jobId)}`) }
      catch (e) { deployRunning = false; deployError = 'Fortschritt nicht abrufbar: ' + e.message; return }
      job = j
      if (j.status === 'running') pollJob(jobId)
      else deployRunning = false
    }, 1500)
  }

  function copySnippet(text) {
    if (text) navigator.clipboard.writeText(text)
  }

  onDestroy(() => {
    if (jobTimer) clearTimeout(jobTimer)
    if (watchTimer) clearTimeout(watchTimer)
  })

  // Zwei unabhaengige $derived statt einem, das nebenbei ein anderes $state
  // mutiert — Svelte 5 verbietet Zustandsmutation waehrend der Auswertung
  // eines $derived (state_unsafe_mutation) und haette die Reaktivitaet
  // stillschweigend abgebrochen, sobald ein "manual"-Schritt auftaucht.
  // Automatische und manuelle Schritte sauber getrennt: automatische Schritte
  // bleiben nach Phase gruppiert, manuelle Schritte (aktuell nur Alert Policy)
  // landen in einer eigenen Liste mit Bestaetigungs-Checkbox.
  const phases = $derived.by(() => {
    if (!job) return []
    const list = []
    for (const s of job.steps) {
      if (s.state === 'manual') continue
      let ph = list.find(p => p.name === s.phase)
      if (!ph) { ph = { name: s.phase, steps: [] }; list.push(ph) }
      ph.steps.push(s)
    }
    return list
  })

  const manualSteps = $derived(job ? job.steps.filter(s => s.state === 'manual') : [])
  const allManualAcked = $derived(manualSteps.length > 0 && manualSteps.every(s => manualAck[s.name]))

  // ---------- Dehydrierter Tenant (Enable-OrganizationCustomization) ----------
  // Die Vorpruefung im Deploy-Skript meldet es direkt, ein einzelner Schritt
  // ueber sein needsOrgCustomization-Flag — beides deutet auf dieselbe Ursache.
  let orgCustBusy = $state(false)
  let orgCustResult = $state(null)

  // Freischaltung beobachten: nach Enable-OrganizationCustomization dauert es
  // bis zu 4 Stunden. Statt selbst alle paar Minuten zu klicken, prueft das
  // Tool im Hintergrund (rein lesend) und meldet, sobald es soweit ist.
  let watchTimer = null
  let watching = $state(false)
  let watchState = $state(null)   // { ready, checkedAt, error }
  const WATCH_INTERVAL_MS = 3 * 60 * 1000

  async function checkOrgStatus() {
    const t = $activeTenant
    if (!t) return null
    try {
      const r = await apiGet(`/api/tenants/${encodeURIComponent(t.id)}/org-customization-status`)
      // ready = das ANLEGEN einer Policy laeuft durch (Trockenlauf). Lesen
      // funktioniert in dehydrierten Tenants auch, sagt also nichts aus.
      watchState = {
        ready: !!r.ready,
        readOk: !!r.readOk,
        cmdletError: r.cmdletError || null,
        whatIfUnsupported: !!r.whatIfUnsupported,
        checkedAt: new Date(),
        error: null
      }
      return r
    } catch (e) {
      watchState = { ready: false, checkedAt: new Date(), error: e.message }
      return null
    }
  }

  function stopWatching() {
    watching = false
    if (watchTimer) { clearTimeout(watchTimer); watchTimer = null }
  }

  async function toggleWatch() {
    if (watching) { stopWatching(); return }
    watching = true
    const tick = async () => {
      if (!watching) return
      const r = await checkOrgStatus()
      if (r && r.ready) { stopWatching(); return }   // fertig — Deploy kann laufen
      if (watching) watchTimer = setTimeout(tick, WATCH_INTERVAL_MS)
    }
    tick()
  }

  let needsOrgCustomization = $derived(
    !!job && (job.needsOrgCustomization === true || (job.steps || []).some(s => s.needsOrgCustomization))
  )

  async function enableOrgCustomization() {
    const t = $activeTenant
    if (!t) return
    if (!confirm(`Organisationsanpassung im Tenant "${t.name}" aktivieren?\n\n`
      + 'Enable-OrganizationCustomization ist ein schreibender Eingriff im Kundentenant und lässt sich '
      + 'nicht rückgängig machen. Die Freischaltung kann bis zu 4 Stunden dauern.')) return
    orgCustBusy = true
    orgCustResult = null
    try {
      const r = await apiPost(`/api/tenants/${encodeURIComponent(t.id)}/enable-org-customization`)
      // cmdletOk ist der belastbare Teil: ein echter Aufruf von
      // Get-QuarantinePolicy. IsDehydrated allein sagt nur, dass die
      // Freischaltung angestossen wurde, nicht dass sie wirkt.
      orgCustResult = { ok: !!r.cmdletOk, text: r.hint || 'Erledigt.' }
    } catch (e) {
      orgCustResult = { ok: false, text: 'Fehlgeschlagen: ' + e.message }
    }
    orgCustBusy = false
  }
</script>

<TenantContext>
  <div class="settings-group">
    <h4>Mail-Security</h4>
    <p class="ld-section-hint">Best-Practice-Policies (Anti-Phishing/Spam/Malware/Quarantäne) aus der Vorlage im Tenant anlegen/aktualisieren.</p>
    <label class="checkbox-label" style="margin-bottom: 0.9rem;">
      <input type="checkbox" bind:checked={$autoDomains} />
      <span>Domains automatisch aus dem Ziel-Tenant übernehmen (Get-AcceptedDomain) — empfohlen; sonst gelten die Domains aus dem Konfigurations-Tab</span>
    </label>
    <div style="display:flex; gap:0.6rem; flex-wrap:wrap;">
      <button class="btn btn-secondary" onclick={testConnection} disabled={testBusy} title="Nur Verbindung testen">
        {testBusy ? '…' : 'Verbindung testen'}
      </button>
      <button class="btn btn-primary" onclick={openConfirm} disabled={deployRunning}>Deployen</button>
    </div>
  </div>

  <div class="ld-job" style="margin-bottom:1.25rem;">
    <div class="ld-job-head"><strong>Was per Web/API nicht geht</strong></div>
    <div class="ld-banner warn">Die Warnungsrichtlinie <code>BP_UserRequestReleaseStatus</code> (Alert Policy für Freigabe-Anfragen aus der
      Quarantäne) kann dieses Tool <strong>nicht automatisch</strong> setzen: Security &amp; Compliance PowerShell
      (<code>Connect-IPPSSession</code>) läuft laut Microsoft-Dokumentation nicht auf Linux — das Backend läuft aber
      in einem Linux-Container. Alles andere auf dieser Seite läuft vollautomatisch per Exchange-Online-App-only.
    </div>
    <p class="ld-section-hint">So richtest du es ein — dauert unter 2 Minuten, einmalig pro Tenant:</p>
    <ol style="margin:0 0 0.7rem 1.2rem; line-height:1.7; font-size:0.9rem;">
      <li>Snippet unten kopieren.</li>
      <li>Auf einem <strong>Windows-Rechner</strong> mit Global-Admin-Rechten für diesen Tenant PowerShell öffnen
        (Modul <code>ExchangeOnlineManagement</code> nötig — falls nicht vorhanden: <code>Install-Module ExchangeOnlineManagement</code>).</li>
      <li>Snippet einfügen und ausführen — fragt interaktiv nach der Anmeldung.</li>
    </ol>
    <pre class="ld-snippet">{alertSnippet}</pre>
    <button class="btn btn-secondary" style="padding:0.3rem 0.8rem; font-size:0.82rem;" onclick={copyAlertSnippet}>
      {snippetCopied ? '✓ Kopiert' : '📋 Snippet kopieren'}
    </button>
    <div class="ld-step" style="margin-top:0.5rem; display:flex; gap:0.75rem; flex-wrap:wrap; align-items:flex-end;">
      <div class="input-group" style="max-width:260px; margin-bottom:0;">
        <label for="alertAdminMail"><small>Admin Notification Email <b>für {$activeTenant.name}</b></small></label>
        <input id="alertAdminMail" type="email" bind:value={tenantAdminEmail}
               placeholder={$config.global.adminEmail || 'admin@kundendomain.ch'} />
      </div>
      <button class="btn btn-secondary" style="padding:0.3rem 0.8rem; font-size:0.82rem;"
              onclick={saveTenantAdmin} disabled={tenantAdminSaving}>
        {tenantAdminSaving ? '…' : 'Für diesen Tenant speichern'}
      </button>
      <div class="input-group" style="max-width:220px; margin-bottom:0;">
        <label for="alertMspMail"><small>MSP Alert Email (global)</small></label>
        <input id="alertMspMail" type="email" bind:value={$config.global.igeeksEmail} />
      </div>
      {#if tenantAdminMsg}
        <small style="flex-basis:100%; color:{tenantAdminMsg.ok ? 'var(--ok)' : 'var(--crit)'};">{tenantAdminMsg.text}</small>
      {/if}
      {#if adminFromTemplate}
        <small style="flex-basis:100%;">⚠️ Für diesen Tenant ist keine eigene Adresse hinterlegt — es gilt
          <code>{$config.global.adminEmail}</code> aus der Vorlage. Die Vorlage ist für <b>alle</b> Tenants dieselbe;
          eine fremde Kundenadresse würde hier live in die Richtlinien geschrieben. Vor dem Deploy prüft das Tool das
          zusätzlich gegen die verifizierten Domains des Tenants.</small>
      {:else}
        <small style="flex-basis:100%;">Die MSP-Alert-Adresse ist bewusst global — die ist für alle Kunden dieselbe.</small>
      {/if}
    </div>
  </div>

  {#if testBusy}
    <div class="ld-job">
      <div class="ld-job-head"><strong>Verbindungstest: {$activeTenant.name}</strong></div>
      <div class="ld-step running"><span class="ld-spinner"></span> Verbinde app-only mit Exchange Online — dauert ca. 20–30 Sekunden…</div>
    </div>
  {:else if testResult}
    <div class="ld-job">
      {#if testResult.ok}
        <div class="ld-banner ok">Verbindung OK — der Tenant ist bereit für den Deploy.</div>
        <div class="ld-step"><small>Accepted Domains im Tenant: {testResult.domains.join(', ')}</small></div>
      {:else}
        <div class="ld-banner fail">{testResult.error}</div>
        {#if testResult.hint}<div class="ld-step"><small>💡 {testResult.hint}</small></div>{/if}
      {/if}
    </div>
  {/if}

  {#if confirmOpen}
    {@const g = $config.global}
    {@const as = $config.antiSpam}
    {@const am = $config.antiMalware}
    {@const fileTypeCount = String(am.customFileTypes || '').split(',').map(s => s.trim()).filter(Boolean).length}
    {@const recipients = [effectiveAdminEmail, g.igeeksEmail].filter(Boolean).join(', ')}
    {@const domains = [...g.domains, g.onmicrosoftDomain].filter(Boolean)}
    <div class="ld-confirm">
      <strong>Deploy nach {$activeTenant.name} — das wird angewendet:</strong>
      <ul>
        {#if $autoDomains}
          <li><strong>Domains:</strong> automatisch aus dem Ziel-Tenant (Get-AcceptedDomain) ✅</li>
        {:else}
          <li><strong>Domains:</strong> {domains.join(', ')} <span class="ld-warn">← aus dem Konfigurations-Tab, bitte prüfen!</span></li>
        {/if}
        <li><strong>Spam / High-Conf-Spam / Bulk:</strong> {as.spamAction} / {as.highConfSpamAction} / {as.bulkAction} (Bulk-Schwelle {as.bulkThreshold})</li>
        <li><strong>Phishing / High-Conf-Phishing:</strong> {as.phishAction} / {as.highConfPhishAction}</li>
        <li><strong>Anhang-Filter:</strong> {fileTypeCount} blockierte Dateitypen · ZAP {am.zapMalware ? 'an' : 'aus'}</li>
        <li><strong>Quarantäne-Benachrichtigungen + Alert Policy an:</strong> {recipients}</li>
      </ul>
      <small>Alles idempotent: Vorhandene BP_-Policies werden aktualisiert, fehlende angelegt.</small>
      <div class="ld-confirm-actions">
        <button class="btn btn-primary" onclick={startDeploy}>Jetzt deployen</button>
        <button class="btn btn-secondary" onclick={() => (confirmOpen = false)}>Abbrechen</button>
      </div>
    </div>
  {/if}

  {#if deployError}
    <div class="ld-job"><div class="ld-banner fail">{deployError}</div></div>
  {/if}

  {#if job}
    {@const total = job.steps.length}
    {@const finished = job.steps.filter(s => s.state === 'done' || s.state === 'failed').length}
    {@const pct = total ? Math.round(finished / total * 100) : 0}
    {@const running = job.status === 'running'}
    {@const manualCount = job.steps.filter(s => s.state === 'manual').length}
    {@const failedCount = job.steps.filter(s => s.state === 'failed').length}
    <div class="ld-job">
      <div class="ld-job-head">
        <strong>{running ? '⏳' : ''} Deploy nach {$activeTenant.name}</strong>
        <span class="ld-job-meta">{running ? job.phase + ' · läuft seit ' : ''}{elapsed(job.startedAt, job.finishedAt)}</span>
        {#if running}
          <button class="btn btn-secondary" style="padding:0.2rem 0.6rem; font-size:0.78rem;"
                  disabled={cancelBusy} onclick={cancelDeploy}>
            {cancelBusy ? 'Bricht ab…' : '⏹ Abbrechen'}
          </button>
        {/if}
      </div>
      <div class="ld-progress"><div class="ld-progress-fill" class:animated={running} style="width:{pct}%"></div></div>
      <div class="ld-progress-label">{finished} / {total} Schritte</div>

      {#if job.status === 'done'}
        {#if manualCount > 0 && !allManualAcked}
          <div class="ld-banner ok">Alle automatischen Schritte erfolgreich ({elapsed(job.startedAt, job.finishedAt)}) — {manualCount} manueller Schritt übrig (siehe „📋 Manuelle Schritte" unten).</div>
        {:else if manualCount > 0}
          <div class="ld-banner ok">Fertig — alle automatischen Schritte erfolgreich, manuelle Schritte von dir bestätigt.</div>
        {:else}
          <div class="ld-banner ok">Fertig — alle {total} Schritte erfolgreich ({elapsed(job.startedAt, job.finishedAt)}).</div>
        {/if}
      {:else if job.status === 'cancelled'}
        <div class="ld-banner warn">⏹ Abgebrochen. Bereits geschriebene Policies bleiben bestehen — einfach erneut deployen, die Schritte sind idempotent.</div>
      {:else if job.status === 'partial'}
        <div class="ld-banner warn">{failedCount} von {total} Schritten fehlgeschlagen (Details unten). Einfach erneut deployen — erfolgreiche Schritte werden dabei nur aktualisiert.</div>
      {:else if job.status === 'failed'}
        <div class="ld-banner fail">{job.error || 'Deploy fehlgeschlagen'}{#if job.hint}<br /><small>💡 {job.hint}</small>{/if}</div>
      {/if}

      <!-- Dehydrierter Tenant: EXO sperrt eigene Policies, bis die
           Organisationsanpassung einmalig aktiviert wurde. -->
      {#if needsOrgCustomization}
        <div class="ld-banner warn" style="margin-top:0.5rem">In diesem Tenant ist die <strong>Organisationsanpassung</strong> nicht aktiviert. Exchange Online sperrt damit
          alle eigenen Policies — deshalb schlägt schon die erste Quarantäne-Policy fehl.
        </div>
        <div class="ld-step">
          <small>
            <code>Enable-OrganizationCustomization</code> muss einmalig im Tenant laufen. Das ist ein schreibender,
            <strong>nicht rückgängig zu machender</strong> Eingriff im Kundentenant und schaltet dauerhaft die
            Anpassbarkeit frei. Die Freischaltung kann bis zu 4 Stunden dauern; danach den Deploy erneut starten.
          </small>
          <div style="margin-top:0.5rem; display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap">
            <button class="btn btn-secondary" disabled={orgCustBusy} onclick={enableOrgCustomization}>
              {orgCustBusy ? 'Läuft…' : '🔓 Organisationsanpassung jetzt aktivieren'}
            </button>
            <button class="btn btn-secondary" onclick={toggleWatch}>
              {watching ? '⏸ Überwachung stoppen' : '👀 Auf Freischaltung warten'}
            </button>
            {#if orgCustResult}
              <span class="ld-section-hint" style="margin:0">
                {orgCustResult.ok ? '✅' : '⏳'} {orgCustResult.text}
              </span>
            {/if}
          </div>

          {#if watchState}
            {#if watchState.ready}
              <div class="ld-banner ok" style="margin-top:0.5rem">Freigeschaltet — das Anlegen einer Policy läuft im Trockenlauf durch. Deploy kann jetzt laufen.
              </div>
            {:else if watchState.whatIfUnsupported}
              <div class="ld-banner warn" style="margin-top:0.5rem">Konnte nicht sicher geprüft werden (kein <code>-WhatIf</code> an diesem Cmdlet). Deploy starten und schauen.
              </div>
            {:else}
              <div class="ld-step" style="margin-top:0.35rem">
                <small>
                  {watching ? '⏳ Überwachung läuft, Prüfung alle 3 Minuten.' : '⏸ Überwachung gestoppt.'}
                  Zuletzt geprüft {watchState.checkedAt.toLocaleTimeString('de-CH')}: Anlegen noch gesperrt{watchState.readOk ? ' (Lesen geht bereits — das allein reicht nicht)' : ''}.
                  {#if watchState.cmdletError}<br />Exchange meldet: <code>{watchState.cmdletError.slice(0, 220)}</code>{/if}
                  {#if watchState.error}<br />Fehler bei der Prüfung: {watchState.error}{/if}
                  <br />Die Überwachung läuft nur, solange diese Seite offen ist — du kannst genauso gut später
                  wiederkommen und einmal prüfen.
                </small>
              </div>
            {/if}
          {/if}
        </div>
      {/if}

      {#if job.domains?.length}
        <div class="ld-step"><small>Rules gelten für: {job.domains.join(', ')}</small></div>
      {/if}

      {#if phases.length}
        <div class="ld-step-section-title">⚙️ Automatische Schritte</div>
        {#each phases as ph (ph.name)}
          {@const allDone = ph.steps.every(s => s.state === 'done')}
          {@const anyActive = ph.steps.some(s => s.state === 'running' || s.state === 'retry')}
          <div class="ld-phase" class:active={anyActive} class:complete={!anyActive && allDone}>
            <div class="ld-phase-title">{LD_PHASE_ICONS[ph.name] || '⚙️'} {ph.name}</div>
            {#each ph.steps as s}
              {#if s.state === 'pending'}
                <div class="ld-step pending"><span class="ld-ico">○</span> {s.name}</div>
              {:else if s.state === 'running'}
                <div class="ld-step running"><span class="ld-spinner"></span> {s.name} <small>wird angewendet…</small></div>
              {:else if s.state === 'retry'}
                <div class="ld-step retry"><span class="ld-ico">🔁</span> {s.name} <small>{s.try}. Versuch läuft… ({(s.lastError || '').slice(0, 120)})</small></div>
              {:else if s.state === 'done'}
                <div class="ld-step ok"><span class="ld-ico">✅</span> {s.name} <small>({LD_ACTION_DE[s.action] || s.action}{s.tries > 1 ? ', ' + s.tries + '. Versuch' : ''})</small></div>
              {:else}
                <div class="ld-step fail"><span class="ld-ico">❌</span> {s.name} — <small>{s.error || 'Fehler'}</small></div>
              {/if}
            {/each}
          </div>
        {/each}
      {/if}

      {#if manualSteps.length}
        <div class="ld-step-section-title manual">📋 Manuelle Schritte <small>(dieses Tool kann sie nicht selbst ausführen)</small></div>
        {#each manualSteps as s (s.name)}
          <div class="ld-phase manual-phase" class:complete={manualAck[s.name]}>
            <div class="ld-phase-title">
              <span class="ld-ico">{manualAck[s.name] ? '✅' : '📋'}</span> {s.name}
            </div>
            <div class="ld-manual-box">
              <small>{s.info || ''}</small>
              <pre class="ld-snippet">{s.snippet || ''}</pre>
              <button class="btn btn-secondary" style="padding:0.25rem 0.7rem; font-size:0.8rem;" onclick={() => copySnippet(s.snippet)}>📋 Snippet kopieren</button>
            </div>
            <label class="checkbox-label" style="margin-top:0.5rem;">
              <input type="checkbox" checked={!!manualAck[s.name]}
                     onchange={(e) => (manualAck = { ...manualAck, [s.name]: e.target.checked })} />
              <span>Ich habe diesen Schritt manuell ausgeführt</span>
            </label>
          </div>
        {/each}
      {/if}
    </div>
  {/if}
</TenantContext>
