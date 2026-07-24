<script>
  import { onDestroy } from 'svelte'
  import { session } from '../lib/session.js'
  import { apiGet, apiPost, apiDelete } from '../lib/api.js'
  import { tenants, tenantsLoaded, activeTenantId, loadTenants, selectTenant, removeTenant, tenantReady, tenantMissing } from '../lib/tenantStore.js'
  import { goToTab } from '../lib/tabStore.js'

  // ---------- Einrichtungs-Assistent (gefuehrte Checkliste fuer neue Tenants) ----------
  // Reihenfolge nach tatsaechlichen Abhaengigkeiten: Tenant-Basis zuerst, dann Vorlage
  // (alle folgenden Schritte lesen dagegen), Mail-Security vor Audit (sonst nichts zu
  // pruefen), Conditional Access vor Autopilot (Geraete sollen sich unter den neuen
  // CA-Regeln registrieren), Mappings direkt nach Autopilot (gleiche Geraetegruppen),
  // Agents als letzter Geraete-Schritt, Lizenzen als loses Ende ohne Abhaengigkeit.
  const ONBOARDING_STEPS = [
    { id: 'config', icon: '⚙️', title: 'Vorlage/Baseline festlegen', desc: 'Domains, Admin-/MSP-E-Mail und Anti-Malware-Dateitypen prüfen — alle weiteren Schritte lesen gegen diese Vorlage.', tab: 'config' },
    { id: 'mailsec', icon: '🛡', title: 'Mail-Security ausrollen', desc: 'BP_-Policies (Quarantäne, Anti-Phishing, Anti-Spam, Anti-Malware) live deployen.', tab: 'mailsec' },
    { id: 'audit', icon: '🔎', title: 'Ist-Zustand + SPF/DKIM/DMARC prüfen', desc: 'Nach dem Deploy verifizieren, dass Soll = Ist, und die Mail-Authentifizierung der Domains checken.', tab: 'audit' },
    { id: 'ca', icon: '🔐', title: 'Conditional Access ausrollen', desc: 'Passende Tier wählen, im Pilot-Ring per Report-Only starten, Break-Glass-Konto anlegen.', tab: 'ca' },
    { id: 'autopilot', icon: '🚀', title: 'Autopilot-Staging vorbereiten', desc: 'Staging-Paket erzeugen, dynamische GroupTag-Gruppen anlegen, Deployment-Profile zuweisen.', tab: 'autopilot' },
    { id: 'mappings', icon: '🗺️', title: 'Laufwerke/Drucker konfigurieren', desc: 'Profile für Netzlaufwerke und Drucker anlegen, den GroupTag-Gruppen zuweisen.', tab: 'mappings' },
    { id: 'intune', icon: '💻', title: 'OIB-Policies zuweisen', desc: 'OpenIntuneBaseline-Policies an die dynamischen Gerätegruppen zuweisen (Break-Risk-Policies beachten).', tab: 'intune' },
    { id: 'agents', icon: '📦', title: 'Agents deployen (AV/RMM)', desc: 'Bitdefender und N-sight als Intune-Win32-App bereitstellen.', tab: 'downloads' },
    { id: 'lizenzen', icon: '💰', title: 'Lizenzen prüfen', desc: 'Ungenutzte/doppelte Lizenzen im Report identifizieren.', tab: 'lizenzen' }
  ]

  let wizardTargetId = $state(null)
  let wizardBusy = $state({}) // stepId -> bool, waehrend der Toggle-Request laeuft

  function toggleWizard(t) { wizardTargetId = wizardTargetId === t.id ? null : t.id }

  // ---------- KI-Schreibrechte (pro Tenant, defaultet auf AUS) ----------
  // Bewusst als kleine, klar benannte Liste einzelner Faehigkeiten statt einer
  // generischen "KI darf alles"-Option -- jede neue automatisierte Schreib-
  // Aktion bekommt ihren eigenen Schluessel, review-pflichtig vor Aktivierung.
  const AI_WRITE_CAPS = [
    { key: 'customPolicyImport', label: 'Eigene Settings-Catalog-Policy importieren + zuweisen',
      desc: 'Erlaubt das Einspielen einer selbst exportierten Intune-Konfigurationsprofil-JSON (z.B. aus einem KI-Runbook abgeleitet) inkl. Zuweisung an eine gewaehlte Gruppe. Siehe Tab „🎫 Tickets" → „📚 Runbooks".' },
    { key: 'resetMfa', label: 'Konto entsperren / MFA-Methoden entfernen',
      desc: 'Entfernt alle registrierten MFA-Methoden (Authenticator, Telefon, FIDO2, ...) eines Nutzers -- Passwort bleibt unberuehrt. Nutzer muss MFA danach neu einrichten. Braucht zusaetzliche Graph-Berechtigung (UserAuthenticationMethod.ReadWrite.All) -- bestehende Tenants ggf. erst „🔧 Reparieren".' },
    { key: 'resetPassword', label: 'Passwort zuruecksetzen',
      desc: 'Setzt ein zufaelliges temporaeres Passwort (mit Zwang zur Aenderung beim naechsten Login). Das Passwort wird nur einmalig im Tool angezeigt.' },
    { key: 'revokeSessions', label: 'Sitzungen widerrufen (ueberall abmelden)',
      desc: 'Erzwingt eine Neuanmeldung auf allen Geraeten/Sitzungen des Nutzers -- z.B. bei Verdacht auf ein kompromittiertes Konto.' },
    { key: 'groupMembership', label: 'Gruppenmitgliedschaft aendern',
      desc: 'Nutzer zu einer gewaehlten Gruppe hinzufuegen oder daraus entfernen. Wirkung haengt davon ab, was an die Gruppe geknuepft ist (Lizenz, Berechtigung, Policy-Scope, ...).' }
  ]
  let aiPermTargetId = $state(null)
  let aiPermBusy = $state({})

  function toggleAiPermPanel(t) { aiPermTargetId = aiPermTargetId === t.id ? null : t.id }

  async function toggleAiWritePermission(t, key, current) {
    aiPermBusy = { ...aiPermBusy, [key]: true }
    try {
      await apiPost(`/api/tenants/${encodeURIComponent(t.id)}/ai-write-permissions`, { key, enabled: !current })
      await loadTenants()
    } catch (e) {
      alert('Konnte die Berechtigung nicht speichern: ' + e.message)
    }
    aiPermBusy = { ...aiPermBusy, [key]: false }
  }

  // ---------- Automatisch vorgeschlagen (KI loest auf, Mensch bestaetigt) ----------
  // Bewusst getrennt von customPolicyImport: das eine erlaubt den manuellen
  // Suchen-dann-Ausrollen-Weg im Runbook, das hier laesst die KI die Einstellung
  // beim Erzeugen des Vorschlags GLEICH selbst auflösen (Suchbegriff -> gefundene
  // Einstellung + Wert) und zeigt einen fertig vorausgefuellten Bestaetigen-
  // Knopf -- geschrieben wird aber IMMER erst nach diesem einen Klick, nie
  // automatisch. Braucht zwingend eine vorher von Nils festgelegte Pilot-Gruppe
  // -- die KI sucht sich NIE selbst eine Gruppe aus.
  let autoDeployGroups = $state({})   // tenantId -> [{id, displayName}]
  let autoDeployBusy = $state({})

  async function ensureAutoDeployGroups(tenantId) {
    if (autoDeployGroups[tenantId]) return
    try {
      const r = await apiGet(`/api/tenants/${encodeURIComponent(tenantId)}/groups`)
      autoDeployGroups = { ...autoDeployGroups, [tenantId]: r.groups || [] }
    } catch (e) {
      autoDeployGroups = { ...autoDeployGroups, [tenantId]: [] }
    }
  }

  async function toggleAutoApply(t, current) {
    if (!current && !t.aiAutoDeployGroupId) {
      alert('Bitte zuerst eine Pilot-Gruppe wählen, bevor autonome Rollouts aktiviert werden.')
      return
    }
    if (!current && !confirm(
      `Die KI sucht/löst die Einstellung dann automatisch auf und zeigt im Runbook einen fertig vorausgefüllten „Bestätigen"-Knopf für die Pilot-Gruppe „${(autoDeployGroups[t.id] || []).find(g => g.id === t.aiAutoDeployGroupId)?.displayName || t.aiAutoDeployGroupId}" — geschrieben wird trotzdem erst nach diesem einen Klick.\n\nWirklich aktivieren?`
    )) return
    await toggleAiWritePermission(t, 'autoApplyPolicies', current)
  }

  async function setAutoDeployGroup(t, groupId) {
    autoDeployBusy = { ...autoDeployBusy, [t.id]: true }
    try {
      await apiPost(`/api/tenants/${encodeURIComponent(t.id)}/ai-auto-deploy-group`, { groupId })
      await loadTenants()
    } catch (e) {
      alert('Konnte die Pilot-Gruppe nicht speichern: ' + e.message)
    }
    autoDeployBusy = { ...autoDeployBusy, [t.id]: false }
  }

  async function toggleOnboardingStep(t, stepId, current) {
    wizardBusy = { ...wizardBusy, [stepId]: true }
    try {
      await apiPost(`/api/tenants/${encodeURIComponent(t.id)}/onboarding/${encodeURIComponent(stepId)}`, { done: !current })
      await loadTenants()
    } catch (e) {
      alert('Konnte den Schritt nicht speichern: ' + e.message)
    }
    wizardBusy = { ...wizardBusy, [stepId]: false }
  }

  // ---------- Onboarding (Device-Code) ----------
  let onboardTenant = $state('')
  let onboardBusy = $state(false)
  let onboardStep = $state(null)     // { verificationUri, userCode, interval } waehrend Warten auf Anmeldung
  let onboardResult = $state(null)   // { error } | { tenant, setup, warnings }
  let onboardCopied = $state(false)
  let onboardTimer = null

  async function startOnboard() {
    onboardBusy = true
    onboardStep = null
    onboardResult = null
    let start
    try {
      start = await apiPost('/api/onboard/start', { tenant: onboardTenant.trim() })
    } catch (e) {
      onboardResult = { error: e.message }
      onboardBusy = false
      return
    }
    onboardStep = start
    scheduleOnboardPoll(start.interval || 5)
  }

  function scheduleOnboardPoll(interval) {
    onboardTimer = setTimeout(async () => {
      let r
      try { r = await apiPost('/api/onboard/poll') }
      catch (e) { onboardResult = { error: e.message }; onboardBusy = false; onboardStep = null; return }
      if (r.status === 'pending') { scheduleOnboardPoll(r.interval || interval); return }
      if (r.status === 'error') { onboardResult = { error: r.error }; onboardBusy = false; onboardStep = null; return }
      onboardResult = { tenant: r.tenant, setup: r.setup || {}, warnings: r.warnings || [] }
      onboardBusy = false
      onboardStep = null
      onboardTenant = ''
      await loadTenants()
    }, interval * 1000)
  }

  function copyOnboardCode() {
    if (!onboardStep) return
    navigator.clipboard.writeText(onboardStep.userCode).then(() => { onboardCopied = true })
  }

  // ---------- Reparieren (bestehende App-Registrierung, Device-Code) ----------
  let fixTargetId = $state(null)
  let fixTargetName = $state('')
  let fixStep = $state(null)
  let fixResult = $state(null)       // { error } | { items }
  let fixCopied = $state(false)
  let fixTimer = null

  async function startFix(t) {
    if (fixTimer) { clearTimeout(fixTimer); fixTimer = null }
    fixTargetId = t.id
    fixTargetName = t.name
    fixStep = null
    fixResult = null
    fixCopied = false
    let start
    try {
      start = await apiPost(`/api/tenants/${encodeURIComponent(t.id)}/fix/start`)
    } catch (e) {
      fixResult = { error: e.message }
      return
    }
    fixStep = start
    scheduleFixPoll(start.interval || 5)
  }

  function scheduleFixPoll(interval) {
    fixTimer = setTimeout(async () => {
      let r
      try { r = await apiPost('/api/fix/poll') }
      catch (e) { fixResult = { error: e.message }; fixStep = null; return }
      if (r.status === 'pending') { scheduleFixPoll(r.interval || interval); return }
      if (r.status === 'error') { fixResult = { error: r.error }; fixStep = null; return }
      fixResult = { items: r.items || [] }
      fixStep = null
      await loadTenants()
    }, interval * 1000)
  }

  function copyFixCode() {
    if (!fixStep) return
    navigator.clipboard.writeText(fixStep.userCode).then(() => { fixCopied = true })
  }

  function closeFixPanel() {
    if (fixTimer) { clearTimeout(fixTimer); fixTimer = null }
    fixTargetId = null
    fixStep = null
    fixResult = null
  }

  async function doRemove(t) {
    if (!confirm(`Tenant "${t.name}" aus dem Tool entfernen? (Die App-Registrierung im Tenant bleibt bestehen.)`)) return
    try { await removeTenant(t.id) }
    catch (e) { alert(e.message) }
    if (fixTargetId === t.id) closeFixPanel()
  }

  const fixIcons = { ok: '✅', fixed: '🔧', failed: '❌' }
  const fixText = { ok: 'war korrekt', fixed: 'repariert', failed: 'fehlgeschlagen' }

  // ---------- SSO-Konfiguration (iGeeks-Tenant "verheiraten") ----------
  let ssoInfo = $state(null)        // { enabled, redirectUri }
  let ssoFormOpen = $state(false)
  let ssoTenantId = $state('')
  let ssoClientId = $state('')
  let ssoClientSecret = $state('')
  let ssoBusy = $state(false)
  let ssoMsg = $state(null)         // { ok, text }
  let ssoLoaded = false

  async function loadSsoInfo() {
    try { ssoInfo = await apiGet('/api/sso/config') } catch (e) { ssoInfo = null }
  }
  async function saveSso() {
    ssoBusy = true; ssoMsg = null
    try {
      await apiPost('/api/sso/config', { tenantId: ssoTenantId.trim(), clientId: ssoClientId.trim(), clientSecret: ssoClientSecret.trim() })
      ssoMsg = { ok: true, text: 'SSO gespeichert — der Microsoft-Login erscheint ab jetzt auf dem Anmeldebildschirm.' }
      ssoClientSecret = ''
      ssoFormOpen = false
      await loadSsoInfo()
    } catch (e) {
      ssoMsg = { ok: false, text: e.message }
    }
    ssoBusy = false
  }
  async function removeSso() {
    if (!confirm('SSO-Konfiguration entfernen? Danach ist nur noch der Passwort-Login möglich.')) return
    ssoBusy = true; ssoMsg = null
    try {
      await apiDelete('/api/sso/config')
      ssoMsg = { ok: true, text: 'SSO-Konfiguration entfernt.' }
      await loadSsoInfo()
    } catch (e) {
      ssoMsg = { ok: false, text: e.message }
    }
    ssoBusy = false
  }

  $effect(() => {
    if ($session.online && $session.loggedIn) {
      loadTenants()
      if (!ssoLoaded) { ssoLoaded = true; loadSsoInfo() }
    }
    if (!($session.online && $session.loggedIn)) ssoLoaded = false
  })

  onDestroy(() => {
    if (onboardTimer) clearTimeout(onboardTimer)
    if (fixTimer) clearTimeout(fixTimer)
  })
</script>

{#if !$session.online}
  <div class="alert alert-warning"><strong>⚠️ Backend nicht erreichbar.</strong> Läuft nur im Docker-Stack (<code>docker compose up -d</code>).</div>
{:else if !$session.loggedIn}
  <div class="alert alert-warning"><strong>🔒 Nicht angemeldet.</strong> Oben rechts im Header auf <strong>Anmelden</strong> klicken.</div>
{:else}
  <div class="settings-group">
    <h4>🏢 Onboardete Tenants</h4>
    {#if !$tenantsLoaded}
      <p class="ld-section-hint">Lade…</p>
    {:else if $tenants.length === 0}
      <p class="ld-section-hint">Noch keine Tenants onboardet — unten den ersten hinzufügen.</p>
    {:else}
      <div class="tlist">
        {#each $tenants as t (t.id)}
          {@const ready = tenantReady(t)}
          {@const missing = tenantMissing(t)}
          <div class="trow" class:active={$activeTenantId === t.id}
               onclick={() => selectTenant(t.id)} onkeydown={(e) => e.key === 'Enter' && selectTenant(t.id)}
               role="button" tabindex="0">
            <div class="trow-info">
              <div class="trow-name">
                {t.name}
                {#if ready}
                  <span class="tbadge ok">✓ bereit</span>
                {:else}
                  <span class="tbadge warn" title="{missing.join(', ')} fehlt — Tenant neu onboarden">⚠ {missing.join(', ')} fehlt</span>
                {/if}
              </div>
              <div class="trow-meta">{t.organization || t.tenantId} · App {(t.appId || '').slice(0, 8)}…</div>
            </div>
            <div class="trow-actions">
              <button class="btn btn-secondary" onclick={(e) => { e.stopPropagation(); toggleWizard(t) }}
                      title="Schritt-für-Schritt-Checkliste für das komplette Tenant-Setup">🧭 Assistent</button>
              <button class="btn btn-secondary" onclick={(e) => { e.stopPropagation(); toggleAiPermPanel(t) }}
                      title="Steuert, welche automatisierten Schreib-Aktionen (z.B. aus dem Ticket-Copilot) für diesen Tenant erlaubt sind">🤖 KI-Schreibrechte</button>
              <button class="btn btn-secondary" onclick={(e) => { e.stopPropagation(); startFix(t) }}
                      title="App-Registrierung prüfen/reparieren: Permission, Consent, Rollen, Zertifikat">🔧 Reparieren</button>
              <button class="btn btn-secondary" onclick={(e) => { e.stopPropagation(); doRemove(t) }}
                      title="Tenant aus dem Tool entfernen">✕ Entfernen</button>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>

  {#if wizardTargetId}
    {@const wt = $tenants.find(x => x.id === wizardTargetId)}
    {#if wt}
      {@const ready = tenantReady(wt)}
      {@const doneCount = ONBOARDING_STEPS.filter(s => wt.onboardingSteps?.[s.id]).length}
      <div class="ld-job" style="margin-bottom:1.5rem">
        <div class="ld-job-head">
          <strong>🧭 Einrichtungs-Assistent: {wt.name}</strong>
          <span class="ld-job-meta">{doneCount}/{ONBOARDING_STEPS.length} erledigt</span>
          <button class="btn btn-secondary" style="padding:0.2rem 0.6rem; font-size:0.78rem;" onclick={() => (wizardTargetId = null)}>✕ schließen</button>
        </div>
        <p class="ld-section-hint">Feste Reihenfolge für neue/wenig erfahrene Kolleg:innen beim Tenant-Setup — jeder
          Haken wird pro Tenant gespeichert, „Öffnen" springt direkt in den passenden Tab.</p>
        <div class="ld-progress" style="margin-bottom:0.9rem;">
          <div class="ld-progress-fill" style="width:{Math.round(doneCount / ONBOARDING_STEPS.length * 100)}%"></div>
        </div>

        <div class="wizard-step">
          <span class="wizard-step-check">{ready ? '✅' : '⚠️'}</span>
          <div class="wizard-step-body">
            <div class="wizard-step-title" class:done={ready}>🏢 Tenant-Setup (Basis)</div>
            <div class="wizard-step-desc">
              {#if ready}Automatisch erkannt — Berechtigungen, Zertifikat und TCM sind vorhanden.
              {:else}Noch nicht vollständig — oben „🔧 Reparieren" ausführen, bevor die folgenden Schritte Sinn ergeben.{/if}
            </div>
          </div>
        </div>

        {#each ONBOARDING_STEPS as step (step.id)}
          {@const done = !!wt.onboardingSteps?.[step.id]}
          <div class="wizard-step">
            <input type="checkbox" class="wizard-step-check" checked={done} disabled={wizardBusy[step.id]}
                   onchange={() => toggleOnboardingStep(wt, step.id, done)} />
            <div class="wizard-step-body">
              <div class="wizard-step-title" class:done={done}>{step.icon} {step.title}</div>
              <div class="wizard-step-desc">{step.desc}</div>
            </div>
            <button class="btn btn-secondary wizard-step-jump" onclick={() => goToTab(step.tab)}>Öffnen →</button>
          </div>
        {/each}
      </div>
    {/if}
  {/if}

  {#if aiPermTargetId}
    {@const apt = $tenants.find(x => x.id === aiPermTargetId)}
    {#if apt}
      <div class="ld-job" style="margin-bottom:1.5rem">
        <div class="ld-job-head">
          <strong>🤖 KI-Schreibrechte: {apt.name}</strong>
          <button class="btn btn-secondary" style="padding:0.2rem 0.6rem; font-size:0.78rem;" onclick={() => (aiPermTargetId = null)}>✕ schließen</button>
        </div>
        <p class="ld-section-hint">Steuert PRO TENANT, welche automatisierten Schreib-Aktionen aus dem Ticket-Copilot
          ausgeführt werden dürfen. Standardmäßig alles AUS — nur gezielt für Tenants aktivieren, bei denen das
          gewünscht ist. Jede Aktion schreibt echt in den Tenant.</p>
        {#each AI_WRITE_CAPS as cap (cap.key)}
          {@const enabled = !!apt.aiWritePermissions?.[cap.key]}
          <div class="wizard-step">
            <input type="checkbox" class="wizard-step-check" checked={enabled} disabled={aiPermBusy[cap.key]}
                   onchange={() => toggleAiWritePermission(apt, cap.key, enabled)} />
            <div class="wizard-step-body">
              <div class="wizard-step-title" class:done={enabled}>{cap.label}</div>
              <div class="wizard-step-desc">{cap.desc}</div>
            </div>
          </div>
        {/each}

        <div class="settings-group" style="margin-top:0.75rem; border-top:1px solid var(--border, #333); padding-top:0.75rem;">
          <h4>⚡ Automatisch vorgeschlagen</h4>
          <p class="ld-section-hint">
            Erweiterung von „Eigene Settings-Catalog-Policy": die KI sucht/löst die Einstellung beim Erzeugen eines
            Ticket-Vorschlags gleich selbst auf (Suchbegriff → gefundene Einstellung + Wert) und zeigt im Runbook
            direkt einen fertig vorausgefüllten „Bestätigen"-Knopf — geschrieben wird trotzdem immer erst nach diesem
            einen Klick, nie automatisch. Braucht zwingend eine vorher festgelegte Pilot-Gruppe; die KI wählt nie
            selbst eine Gruppe.
          </p>
          <div class="input-group" style="max-width:420px; margin-bottom:0.6rem;">
            <label for="autoGroup-{apt.id}">Pilot-Gruppe für autonome Rollouts</label>
            <select id="autoGroup-{apt.id}" value={apt.aiAutoDeployGroupId || ''} disabled={autoDeployBusy[apt.id]}
                    onfocus={() => ensureAutoDeployGroups(apt.id)}
                    onchange={(e) => setAutoDeployGroup(apt, e.target.value)}>
              <option value="">— keine gewählt —</option>
              {#each (autoDeployGroups[apt.id] || []) as g (g.id)}<option value={g.id}>{g.displayName}</option>{/each}
            </select>
          </div>
          <div class="wizard-step">
            <input type="checkbox" class="wizard-step-check" checked={!!apt.aiWritePermissions?.autoApplyPolicies} disabled={aiPermBusy['autoApplyPolicies']}
                   onchange={() => toggleAutoApply(apt, !!apt.aiWritePermissions?.autoApplyPolicies)} />
            <div class="wizard-step-body">
              <div class="wizard-step-title" class:done={!!apt.aiWritePermissions?.autoApplyPolicies}>KI darf Einstellungen automatisch auflösen + zur Bestätigung vorschlagen</div>
              <div class="wizard-step-desc">Nur wirksam, wenn oben eine Pilot-Gruppe gewählt ist. Jeder Versuch (Erfolg wie Fehlschlag) wird im zugehörigen Runbook protokolliert. Der eigentliche Rollout passiert erst nach manueller Bestätigung im Runbook.</div>
            </div>
          </div>
        </div>
      </div>
    {/if}
  {/if}

  {#if fixTargetId}
    <div class="ld-job" style="margin-bottom:1.5rem">
      <div class="ld-job-head">
        <strong>🔧 App-Registrierung reparieren: {fixTargetName}</strong>
        <button class="btn btn-secondary" style="padding:0.2rem 0.6rem; font-size:0.78rem;" onclick={closeFixPanel}>✕ schließen</button>
      </div>
      {#if fixStep}
        <div class="ld-step"><small>Prüft und repariert: Exchange.ManageAsApp, Admin-Consent, Exchange-Admin- + Compliance-Rolle, Zertifikat-Hinterlegung. Das bestehende Zertifikat bleibt unangetastet.</small></div>
        <div class="ld-onboard-step">1️⃣ Öffne <a href={fixStep.verificationUri} target="_blank" rel="noopener">{fixStep.verificationUri}</a></div>
        <div class="ld-onboard-step">2️⃣ Melde dich als <strong>Admin von {fixTargetName}</strong> an und gib diesen Code ein:
          <span class="ld-code">{fixStep.userCode}</span>
          <button class="btn btn-secondary" style="padding:0.2rem 0.6rem; font-size:0.8rem;" onclick={copyFixCode}>{fixCopied ? '✓ Kopiert' : 'Kopieren'}</button>
        </div>
        <div class="ld-onboard-step">3️⃣ <span class="ld-spinner"></span> Warte auf deine Anmeldung…</div>
      {:else if fixResult?.error}
        <div class="ld-banner fail">❌ {fixResult.error}</div>
      {:else if fixResult?.items}
        {@const failed = fixResult.items.filter(i => i.state === 'failed').length}
        {@const fixedCount = fixResult.items.filter(i => i.state === 'fixed').length}
        {#if failed > 0}
          <div class="ld-banner warn">⚠️ {failed} Punkt(e) konnten nicht repariert werden — Details unten.</div>
        {:else if fixedCount > 0}
          <div class="ld-banner ok">✅ Reparatur abgeschlossen — {fixedCount} Punkt(e) korrigiert, Rest war bereits korrekt.</div>
        {:else}
          <div class="ld-banner ok">✅ Alles bereits korrekt — nichts zu reparieren.</div>
        {/if}
        {#each fixResult.items as i}
          <div class="ld-step {i.state === 'failed' ? 'fail' : 'ok'}">
            <span class="ld-ico">{fixIcons[i.state]}</span> {i.name}
            <small>({fixText[i.state]}{i.detail ? ' — ' + i.detail : ''})</small>
          </div>
        {/each}
        <div class="ld-step"><small>💡 Danach im Tab „🛡 Mail-Security" mit „Verbindung testen" prüfen — frisch reparierte Rollen brauchen ggf. ein paar Minuten Replikationszeit.</small></div>
      {/if}
    </div>
  {/if}

  <div class="settings-group">
    <h4>➕ Neuen Tenant onboarden</h4>
    <p class="ld-section-hint">Legt im Ziel-Tenant eine App-Registrierung mit Exchange.ManageAsApp + Zertifikat an (Device-Code-Anmeldung als Admin).</p>
    <div class="input-group" style="max-width:420px; margin-bottom:0.75rem;">
      <label for="tOnboardTenant">Tenant-Domain oder Tenant-ID <small>(optional)</small></label>
      <input id="tOnboardTenant" type="text" placeholder="kunde.onmicrosoft.com" bind:value={onboardTenant} disabled={onboardBusy || !!onboardStep} />
    </div>
    <button class="btn btn-primary" onclick={startOnboard} disabled={onboardBusy || !!onboardStep}>
      {onboardBusy && !onboardStep ? '…' : '🚀 Onboarding starten'}
    </button>

    {#if onboardStep}
      <div class="ld-job" style="margin-top:1rem">
        <div class="ld-onboard-step">1️⃣ Öffne <a href={onboardStep.verificationUri} target="_blank" rel="noopener">{onboardStep.verificationUri}</a></div>
        <div class="ld-onboard-step">2️⃣ Melde dich als <strong>Admin des Ziel-Tenants</strong> an und gib diesen Code ein:
          <span class="ld-code">{onboardStep.userCode}</span>
          <button class="btn btn-secondary" style="padding:0.2rem 0.6rem; font-size:0.8rem;" onclick={copyOnboardCode}>{onboardCopied ? '✓ Kopiert' : 'Kopieren'}</button>
        </div>
        <div class="ld-onboard-step">3️⃣ <span class="ld-spinner"></span> Warte auf deine Anmeldung… (Code ist ca. 15 Minuten gültig)</div>
      </div>
    {:else if onboardResult?.error}
      <div class="ld-banner fail" style="margin-top:1rem">❌ {onboardResult.error}</div>
    {:else if onboardResult?.tenant}
      {@const su = onboardResult.setup}
      <div class="ld-job" style="margin-top:1rem">
        <div class="ld-banner ok">✅ <strong>{onboardResult.tenant.name}</strong> ist onboardet.</div>
        <div class="ld-setup-list">
          <span class="ld-badge {su.app ? 'ok' : 'warn'}">{su.app ? '✓' : '⚠'} App-Registrierung</span>
          <span class="ld-badge {su.consent ? 'ok' : 'warn'}">{su.consent ? '✓' : '⚠'} Admin-Consent</span>
          <span class="ld-badge {su.exoRole ? 'ok' : 'warn'}">{su.exoRole ? '✓' : '⚠'} Exchange-Admin-Rolle</span>
          <span class="ld-badge {su.sccRole ? 'ok' : 'warn'}">{su.sccRole ? '✓' : '⚠'} Compliance-Rolle</span>
          <span class="ld-badge {su.tcm ? 'ok' : 'warn'}">{su.tcm ? '✓' : '⚠'} TCM (Alert-Prüfung)</span>
          <span class="ld-badge {su.cert ? 'ok' : 'warn'}">{su.cert ? '✓' : '⚠'} Zertifikat</span>
        </div>
        {#if onboardResult.warnings?.length}
          <div style="margin-top:0.4rem;">
            {#each onboardResult.warnings as w}<div>⚠️ {w}</div>{/each}
          </div>
        {/if}
        <div class="ld-step" style="margin-top:0.5rem;"><small>💡 Frische App-Registrierungen brauchen ein paar Minuten Replikationszeit — erst im Tab „🛡 Mail-Security" mit „Test" prüfen, dann deployen.</small></div>
      </div>
    {/if}
  </div>

  <div class="settings-group">
    <h4>🔗 SSO: Anmeldung über den iGeeks-Tenant</h4>
    <p class="ld-section-hint">Verheiratet das Tool mit dem iGeeks-M365-Tenant als primäre Anmeldemethode — dient NUR dem Zugriff auf dieses Tool, nicht dem Management des iGeeks-Tenants. Der Passwort-Login bleibt als Fallback erhalten.</p>

    {#if ssoInfo?.enabled}
      <div class="ld-banner ok">✅ SSO ist aktiv — der Anmeldebildschirm zeigt „Mit Microsoft anmelden" als primären Weg.</div>
      <button class="btn btn-secondary" onclick={removeSso} disabled={ssoBusy}>✕ SSO-Konfiguration entfernen</button>
    {:else}
      <button class="btn btn-primary" onclick={() => (ssoFormOpen = !ssoFormOpen)} disabled={ssoBusy}>
        {ssoFormOpen ? '✕ Schließen' : '🔗 iGeeks-Tenant verheiraten'}
      </button>
    {/if}

    {#if ssoFormOpen && !ssoInfo?.enabled}
      <div class="ld-job" style="margin-top:1rem">
        <div class="ld-step"><small>Einmalig im <b>iGeeks-Tenant</b> eine App-Registrierung anlegen (Entra Admin Center → App-Registrierungen → Neu):
          Typ „Web", Redirect-URI wie unten, dann unter „Zertifikate &amp; Geheimnisse" ein Client-Secret erzeugen.
          Keine API-Berechtigungen nötig — der Standard-<code>openid</code>-Scope reicht.</small></div>
        <div class="ld-onboard-step">📋 Redirect-URI für die App-Registrierung: <code>{ssoInfo?.redirectUri || '…'}</code></div>
        <div class="settings-grid" style="margin-top:0.75rem;">
          <div class="input-group">
            <label for="ssoTid">iGeeks Tenant-ID</label>
            <input id="ssoTid" type="text" placeholder="00000000-0000-0000-0000-000000000000" bind:value={ssoTenantId} />
          </div>
          <div class="input-group">
            <label for="ssoCid">Client-ID (App-Registrierung)</label>
            <input id="ssoCid" type="text" placeholder="00000000-0000-0000-0000-000000000000" bind:value={ssoClientId} />
          </div>
          <div class="input-group">
            <label for="ssoSec">Client-Secret</label>
            <input id="ssoSec" type="password" placeholder="Wert des Secrets (nicht die Secret-ID)" bind:value={ssoClientSecret} />
          </div>
        </div>
        <button class="btn btn-primary" onclick={saveSso} disabled={ssoBusy || !ssoTenantId.trim() || !ssoClientId.trim() || !ssoClientSecret.trim()}>
          {ssoBusy ? '…' : '💾 SSO aktivieren'}
        </button>
      </div>
    {/if}

    {#if ssoMsg}
      <div class="ld-banner {ssoMsg.ok ? 'ok' : 'fail'}" style="margin-top:0.75rem;">{ssoMsg.ok ? '✅' : '❌'} {ssoMsg.text}</div>
    {/if}
  </div>
{/if}
