<script>
  import { onDestroy } from 'svelte'
  import { config } from '../lib/config.js'
  import { apiPost, apiGet } from '../lib/api.js'
  import { activeTenant, autoDomains } from '../lib/tenantStore.js'
  import TenantContext from '../lib/TenantContext.svelte'
  import { buildAlertPolicySnippet } from '../lib/alertPolicySnippet.js'

  let snippetCopied = $state(false)
  let alertSnippet = $derived(buildAlertPolicySnippet($config.global))
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
    if (deployRunning) { alert('Es läuft bereits ein Deploy — bitte warten.'); return }
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
      deployRunning = false
      deployError = e.message
      return
    }
    pollJob(start.jobId)
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

  onDestroy(() => { if (jobTimer) clearTimeout(jobTimer) })

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
</script>

<TenantContext>
  <div class="settings-group">
    <h4>🛡 Mail-Security</h4>
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
    <div class="ld-job-head"><strong>🪟 Was per Web/API nicht geht</strong></div>
    <div class="ld-banner warn">
      ⚠️ Die Warnungsrichtlinie <code>BP_UserRequestReleaseStatus</code> (Alert Policy für Freigabe-Anfragen aus der
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
      <div class="input-group" style="max-width:220px; margin-bottom:0;">
        <label for="alertAdminMail"><small>Admin Notification Email</small></label>
        <input id="alertAdminMail" type="email" bind:value={$config.global.adminEmail} placeholder="admin@example.com" />
      </div>
      <div class="input-group" style="max-width:220px; margin-bottom:0;">
        <label for="alertMspMail"><small>MSP Alert Email</small></label>
        <input id="alertMspMail" type="email" bind:value={$config.global.igeeksEmail} />
      </div>
      <small style="flex-basis:100%;">💡 Direkt hier änderbar — Snippet oben passt sich sofort an (dieselben Werte wie im Tab „⚙️ Vorlage").</small>
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
        <div class="ld-banner ok">✅ Verbindung OK — der Tenant ist bereit für den Deploy.</div>
        <div class="ld-step"><small>Accepted Domains im Tenant: {testResult.domains.join(', ')}</small></div>
      {:else}
        <div class="ld-banner fail">❌ {testResult.error}</div>
        {#if testResult.hint}<div class="ld-step"><small>💡 {testResult.hint}</small></div>{/if}
      {/if}
    </div>
  {/if}

  {#if confirmOpen}
    {@const g = $config.global}
    {@const as = $config.antiSpam}
    {@const am = $config.antiMalware}
    {@const fileTypeCount = String(am.customFileTypes || '').split(',').map(s => s.trim()).filter(Boolean).length}
    {@const recipients = [g.adminEmail, g.igeeksEmail].filter(Boolean).join(', ')}
    {@const domains = [...g.domains, g.onmicrosoftDomain].filter(Boolean)}
    <div class="ld-confirm">
      <strong>🚀 Deploy nach {$activeTenant.name} — das wird angewendet:</strong>
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
        <button class="btn btn-primary" onclick={startDeploy}>🚀 Jetzt deployen</button>
        <button class="btn btn-secondary" onclick={() => (confirmOpen = false)}>Abbrechen</button>
      </div>
    </div>
  {/if}

  {#if deployError}
    <div class="ld-job"><div class="ld-banner fail">❌ {deployError}</div></div>
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
      </div>
      <div class="ld-progress"><div class="ld-progress-fill" class:animated={running} style="width:{pct}%"></div></div>
      <div class="ld-progress-label">{finished} / {total} Schritte</div>

      {#if job.status === 'done'}
        {#if manualCount > 0 && !allManualAcked}
          <div class="ld-banner ok">✅ Alle automatischen Schritte erfolgreich ({elapsed(job.startedAt, job.finishedAt)}) — {manualCount} manueller Schritt übrig (siehe „📋 Manuelle Schritte" unten).</div>
        {:else if manualCount > 0}
          <div class="ld-banner ok">✅ Fertig — alle automatischen Schritte erfolgreich, manuelle Schritte von dir bestätigt.</div>
        {:else}
          <div class="ld-banner ok">✅ Fertig — alle {total} Schritte erfolgreich ({elapsed(job.startedAt, job.finishedAt)}).</div>
        {/if}
      {:else if job.status === 'partial'}
        <div class="ld-banner warn">⚠️ {failedCount} von {total} Schritten fehlgeschlagen (Details unten). Einfach erneut deployen — erfolgreiche Schritte werden dabei nur aktualisiert.</div>
      {:else if job.status === 'failed'}
        <div class="ld-banner fail">❌ {job.error || 'Deploy fehlgeschlagen'}{#if job.hint}<br /><small>💡 {job.hint}</small>{/if}</div>
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
