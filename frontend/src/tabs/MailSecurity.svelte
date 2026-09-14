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
    'Safe Links & Safe Attachments': '🔗',
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

  // ---------- SMTP AUTH: Ausnahmen je Postfach ----------
  // Gehoert zum TENANT wie die Admin-Adresse. Speichern aendert im Tenant noch
  // nichts; gesetzt wird beim Deploy, sofern der Schalter in der Vorlage an ist.
  let smtp = $state(null)            // { selection, state: { orgDisabled, mailboxes }, signIns }
  let smtpLoading = $state(false)
  let smtpError = $state(null)
  let smtpSelected = $state({})      // address -> true
  let smtpFilter = $state('')
  let smtpOnlyRelevant = $state(true)
  let smtpSaving = $state(false)
  let smtpMsg = $state(null)
  let smtpLoadedFor = null
  // Anmeldeprotokoll getrennt: kommt spaeter oder gar nicht, die Auswahl geht trotzdem.
  let smtpSignIns = $state(null)       // { ok, days, users, truncated, error }
  let smtpSignInsLoading = $state(false)
  let smtpTouched = false              // Anwender hat schon gehakt -> Vorschlag nicht mehr ueberschreiben
  let smtpApplying = $state(false)
  let smtpCheck = $state('')           // Anmeldename, mit dem sich das Geraet anmeldet

  $effect(() => {
    const id = $activeTenant?.id ?? null
    if (id === smtpLoadedFor) return
    smtpLoadedFor = id
    smtp = null; smtpError = null; smtpSelected = {}; smtpMsg = null; smtpFilter = ''
    smtpSignIns = null; smtpSignInsLoading = false; smtpTouched = false; smtpCheck = ''
  })

  // Adresse -> Postfach, ueber primaere Adresse UND alle Aliase. Geraete melden
  // sich oft mit dem UPN oder einem Alias an, nicht mit der primaeren Adresse.
  const smtpByAddr = $derived.by(() => {
    const map = new Map()
    for (const m of smtp?.state?.mailboxes || []) {
      map.set(m.address, m)
      for (const a of m.aliases || []) if (!map.has(a)) map.set(a, m)
    }
    return map
  })
  // Nutzung je Postfach (primaere Adresse); mehrere Anmeldenamen fuer dasselbe
  // Postfach werden zusammengezaehlt.
  const smtpUsage = $derived.by(() => {
    const map = new Map()
    for (const u of smtpSignIns?.users || []) {
      const m = smtpByAddr.get(u.upn)
      if (!m) continue
      const e = map.get(m.address)
      if (!e) map.set(m.address, { ...u })
      else map.set(m.address, { ...e, ok: e.ok + u.ok, failed: e.failed + u.failed, last: e.last > u.last ? e.last : u.last })
    }
    return map
  })
  const smtpCount = $derived(Object.values(smtpSelected).filter(Boolean).length)
  // Anmeldungen, zu denen kein Postfach passt (UPN weicht von der Adresse ab,
  // oder das Konto hat gar kein Postfach). Die duerfen nicht still verschwinden.
  const smtpOrphans = $derived.by(() => {
    if (!smtp?.state) return []
    return (smtpSignIns?.users || []).filter(u => !smtpByAddr.has(u.upn))
  })
  const smtpRows = $derived.by(() => {
    if (!smtp?.state) return []
    const f = smtpFilter.trim().toLowerCase()
    return smtp.state.mailboxes.filter(m => {
      if (f && !(m.address.includes(f) || (m.aliases || []).some(a => a.includes(f)) || (m.displayName || '').toLowerCase().includes(f))) return false
      if (smtpOnlyRelevant && !f) return !!smtpSelected[m.address] || m.setting === false || smtpUsage.has(m.address)
      return true
    })
  })

  async function loadSmtp() {
    const id = encodeURIComponent($activeTenant.id)
    smtpLoading = true
    smtpError = null
    smtpMsg = null
    smtpTouched = false
    // Beide parallel starten; die Postfaecher zeigen sich, sobald Exchange
    // antwortet -- das Anmeldeprotokoll darf spaeter nachziehen.
    smtpSignIns = null
    smtpSignInsLoading = true
    apiGet(`/api/tenants/${id}/smtpauth/signins`)
      .then(r => { smtpSignIns = r.signIns })
      .catch(e => { smtpSignIns = { ok: false, days: 30, users: [], error: e.message } })
      .finally(() => { smtpSignInsLoading = false; applySmtpSuggestion() })
    try {
      const r = await apiGet(`/api/tenants/${id}/smtpauth`)
      smtp = r
      applySmtpSuggestion()
    } catch (e) {
      smtpError = e.message
    }
    smtpLoading = false
  }

  // Vorauswahl: gespeicherte Auswahl, sonst heutige Freigaben plus Konten mit
  // erfolgreichen SMTP-Anmeldungen. Laeuft erneut, wenn das Anmeldeprotokoll
  // nachkommt -- aber nie, nachdem der Anwender selbst gehakt hat.
  function applySmtpSuggestion() {
    if (!smtp?.state || smtpTouched) return
    const next = {}
    if (smtp.selection) {
      for (const a of smtp.selection.allowed) next[a] = true
    } else {
      for (const m of smtp.state.mailboxes) if (m.setting === false || (smtpUsage.get(m.address)?.ok || 0) > 0) next[m.address] = true
    }
    smtpSelected = next
  }

  async function saveSmtp() {
    const allowed = Object.keys(smtpSelected).filter(a => smtpSelected[a]).sort()
    const verlieren = (smtp?.state?.mailboxes || []).filter(m => m.setting === false && !smtpSelected[m.address]).map(m => m.address)
    const lines = [
      `${anz(allowed.length, 'Postfach behält', 'Postfächer behalten')} SMTP AUTH in „${$activeTenant.name}":`,
      allowed.length ? allowed.map(a => '• ' + a).join('\n') : '• keine — SMTP AUTH wird für alle abgeschaltet'
    ]
    if (verlieren.length) lines.push('', `⚠️ ${anz(verlieren.length, 'Postfach hat', 'Postfächer haben')} HEUTE eine Freigabe und ${verlieren.length === 1 ? 'verliert sie' : 'verlieren sie'} beim Anwenden bzw. nächsten Deploy:`, verlieren.map(a => '• ' + a).join('\n'))
    lines.push('', 'Speichern ändert im Tenant noch nichts — gesetzt wird mit „Ausnahmen jetzt anwenden" oder beim Deploy.')
    if (!confirm(lines.join('\n'))) return
    smtpSaving = true
    smtpMsg = null
    try {
      const r = await apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/smtpauth`, { allowed })
      smtp = { ...smtp, selection: r.selection }
      smtpMsg = { ok: true, text: `Gespeichert: ${anz(r.selection.allowed.length, 'Ausnahme', 'Ausnahmen')}. Sofort setzen mit „Ausnahmen jetzt anwenden", sonst beim nächsten Deploy${$config.outbound.disableSmtpAuth ? '' : ' (sobald der Schalter in der Vorlage an ist)'}.` }
    } catch (e) {
      smtpMsg = { ok: false, text: e.message }
    }
    smtpSaving = false
  }

  // Gespeicherte Auswahl gegen den Tenant: was muss beim Anwenden passieren?
  const smtpPending = $derived.by(() => {
    if (!smtp?.state || !smtp.selection) return null
    const soll = new Set(smtp.selection.allowed)
    const on = [], unknown = []
    for (const a of smtp.selection.allowed) {
      const m = smtp.state.mailboxes.find(x => x.address === a)
      if (!m) unknown.push(a)
      else if (m.setting !== false) on.push(m)
    }
    const off = smtp.state.mailboxes.filter(m => m.setting === false && !soll.has(m.address))
    return { on, off, unknown }
  })
  // Haken weichen von der gespeicherten Auswahl ab -> erst speichern, dann anwenden.
  const smtpDirty = $derived.by(() => {
    if (!smtp?.selection) return smtpCount > 0
    const a = Object.keys(smtpSelected).filter(k => smtpSelected[k]).sort().join(',')
    return a !== [...smtp.selection.allowed].sort().join(',')
  })

  // Was gilt fuer dieses Postfach wirklich? Postfach-Einstellung vor Organisation --
  // fuer Basic Auth und OAuth gleichermassen.
  function smtpEffective(m) {
    if (m.setting === false) return { on: true, text: 'an', why: 'Ausnahme am Postfach' }
    if (m.setting === true) return { on: false, text: 'aus', why: 'am Postfach gesperrt' }
    return smtp.state.orgDisabled
      ? { on: false, text: 'aus', why: 'erbt Organisation' }
      : { on: true, text: 'an', why: 'erbt Organisation' }
  }

  const smtpCheckResult = $derived.by(() => {
    const a = smtpCheck.trim().toLowerCase()
    if (!smtp?.state || !a || !a.includes('@')) return null
    const m = smtpByAddr.get(a)
    if (!m) return { found: false, address: a }
    const eff = smtpEffective(m)
    return {
      found: true, m, eff,
      viaAlias: m.address !== a,
      inSelection: !!smtp.selection?.allowed.includes(m.address),
      checked: !!smtpSelected[m.address]
    }
  })

  function smtpAddToSelection(address) {
    smtpTouched = true
    smtpSelected = { ...smtpSelected, [address]: true }
    smtpFilter = address
  }

  async function applySmtp() {
    const p = smtpPending
    if (!p) return
    const lines = [`SMTP-AUTH-Ausnahmen JETZT in „${$activeTenant.name}" setzen:`]
    if (p.on.length) lines.push('', `✅ ${anz(p.on.length, 'Postfach bekommt', 'Postfächer bekommen')} eine Freigabe:`, p.on.map(m => '• ' + m.address).join('\n'))
    if (p.off.length) lines.push('', `↩️ ${anz(p.off.length, 'Postfach verliert', 'Postfächer verlieren')} die Freigabe (zurück auf „folgt der Organisation"):`, p.off.map(m => '• ' + m.address).join('\n'))
    if (!p.on.length && !p.off.length) lines.push('', 'Laut letztem Lesestand ist nichts zu ändern — es wird trotzdem gegen den aktuellen Tenant abgeglichen.')
    lines.push('', `Die Organisationseinstellung bleibt, wie sie ist (heute: SMTP AUTH ${smtp.state.orgDisabled ? 'aus' : 'an'}).`)
    if (!confirm(lines.join('\n'))) return
    smtpApplying = true
    smtpMsg = null
    try {
      const r = await apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/smtpauth/apply`, {})
      const res = r.result
      if (res.state) smtp = { ...smtp, state: res.state }
      const an = res.changes.filter(c => c.to === 'an').length, weg = res.changes.length - an
      const was = res.changes.length
        ? [an ? `${anz(an, 'Freigabe', 'Freigaben')} gesetzt` : null, weg ? `${anz(weg, 'Freigabe', 'Freigaben')} entfernt` : null].filter(Boolean).join(', ')
        : 'nichts zu ändern, Tenant entsprach schon der Auswahl'
      smtpMsg = res.ok
        ? { ok: true, text: `Angewendet: ${was}. Microsoft nennt keine Übernahmezeit — scheitert ein Test direkt danach, kurz warten und wiederholen.` }
        : { ok: false, text: `Abgebrochen: ${res.error}${was ? ` (bis dahin: ${was})` : ''}` }
    } catch (e) {
      smtpMsg = { ok: false, text: e.message }
    }
    smtpApplying = false
  }

  // "1 Postfach" / "3 Postfächer" statt "Postfach/Postfächer" -- das Kundentool
  // soll sich nicht wie ein Formular von 1998 lesen.
  function anz(n, eins, mehr) { return n + ' ' + (n === 1 ? eins : mehr) }

  function smtpSettingLabel(v) {
    return v === false ? 'freigegeben' : (v === true ? 'gesperrt' : 'wie Organisation')
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
    <div class="ld-job-head">
      <strong>SMTP AUTH: Ausnahmen für {$activeTenant.name}</strong>
      <span class="ld-job-meta">
        Vorlage: {$config.outbound.disableSmtpAuth ? 'wird abgeschaltet' : 'nicht aktiv'}
        {#if smtp}· {smtp.selection ? `${anz(smtp.selection.allowed.length, 'Ausnahme', 'Ausnahmen')} gespeichert` : 'noch keine Auswahl gespeichert'}{/if}
      </span>
    </div>
    <p class="ld-section-hint">SMTP AUTH organisationsweit aus, nur die hier gewählten Postfächer behalten es — typischerweise
      Drucker, Scanner und Fachanwendungen. Der Schalter gilt für das Protokoll, also für <b>OAuth und Basic Auth gleichermassen</b>.
      Die Freigabe am Postfach hat Vorrang vor der Organisation — die Organisation muss dafür nicht an sein.
      Speichern ändert im Tenant noch nichts; gesetzt wird mit „Ausnahmen jetzt anwenden" (nur Postfächer) oder beim Deploy
      (Postfächer, danach Organisation aus — wenn der Schalter in der Vorlage an ist).</p>

    {#if !smtp}
      <button class="btn btn-secondary" onclick={loadSmtp} disabled={smtpLoading}>
        {smtpLoading ? 'Lese Postfächer und Anmeldungen…' : '📬 Postfächer & SMTP-Nutzung laden'}
      </button>
      {#if smtpLoading}<div class="ld-step running" style="margin-top:.5rem;"><span class="ld-spinner"></span> Verbinde mit Exchange Online und lese die Postfächer — dauert ca. 20–40 Sekunden…</div>{/if}
      {#if smtpError}<div class="ld-banner fail" style="margin-top:.5rem;">{smtpError}</div>{/if}
    {:else}
      <div class="ld-banner {smtp.state.orgDisabled ? 'ok' : 'warn'}">
        <div>Organisation heute: <b>SMTP AUTH {smtp.state.orgDisabled ? 'aus' : 'an'}</b>
          · {anz(smtp.state.mailboxes.filter(m => m.setting === false).length, 'Postfach', 'Postfächer')} explizit freigegeben
          · {anz(smtp.state.mailboxes.length, 'Postfach', 'Postfächer')} insgesamt</div>
      </div>

      <div class="ld-step" style="margin-top:.6rem; display:block;">
        <div style="display:flex; gap:.6rem; align-items:center; flex-wrap:wrap;">
          <b style="font-size:.88rem;">🔎 Konto prüfen</b>
          <input type="search" class="dl-search" placeholder="Anmeldename des Geräts, z. B. scanner@kunde.ch" bind:value={smtpCheck} style="max-width:320px;" />
          <small>— der Name, mit dem sich Gerät oder Anwendung anmeldet, nicht die Absenderadresse.</small>
        </div>
        {#if smtpCheckResult}
          {@const c = smtpCheckResult}
          {#if !c.found}
            <div class="ld-banner warn" style="margin-top:.5rem;">Kein Postfach mit <b>{c.address}</b> — weder als primäre Adresse noch als Alias.
              SMTP AUTH meldet sich an einem Exchange-Online-Postfach an; ohne Postfach greift keine Ausnahme. Tippfehler? Sonst prüfen,
              zu welchem Postfach das Konto gehört.</div>
          {:else}
            <div class="ld-banner {c.eff.on ? 'ok' : 'fail'}" style="margin-top:.5rem;">
              <div><b>{c.m.displayName || c.m.address}</b>{c.viaAlias ? ` (Alias von ${c.m.address})` : ''}:
                SMTP AUTH <b>{c.eff.text}</b> — {c.eff.why}.
                {c.inSelection ? 'In der gespeicherten Auswahl.' : 'Nicht in der gespeicherten Auswahl.'}</div>
              {#if !c.eff.on && c.m.setting === null}
                <div style="margin-top:.3rem;">Genau das meldet ein Gerät als <code>535 5.7.139 … SmtpClientAuthentication is disabled for the Tenant</code>.
                  Abhilfe: Postfach in die Auswahl, speichern, <b>Ausnahmen jetzt anwenden</b>.</div>
              {:else if !c.eff.on}
                <div style="margin-top:.3rem;">Ein Gerät bekommt <code>535 5.7.139 … disabled for the Mailbox</code>. Mit der Auswahl und
                  „Ausnahmen jetzt anwenden" wird die Sperre am Postfach durch eine Freigabe ersetzt.</div>
              {:else}
                <div style="margin-top:.3rem;">An diesem Schalter liegt es nicht. Scheitert das Senden trotzdem, sind die üblichen Verdächtigen:
                  Berechtigung der App-Registrierung (<code>SMTP.Send</code> delegiert bzw. <code>SMTP.SendAsApp</code>), bei App-only
                  der Exchange-Service-Principal mit Postfachberechtigung, abgelaufenes Kennwort/Token oder Conditional Access.</div>
              {/if}
              {#if !c.eff.on}
                <div style="margin-top:.4rem; display:flex; gap:.5rem; flex-wrap:wrap;">
                  {#if !c.checked}<button class="btn btn-secondary" style="padding:.2rem .7rem; font-size:.8rem;" onclick={() => smtpAddToSelection(c.m.address)}>➕ In die Auswahl</button>
                  {:else if !c.inSelection}<small>Angehakt, aber noch nicht gespeichert.</small>{/if}
                </div>
              {/if}
            </div>
          {/if}
        {/if}
      </div>

      {#if smtpPending && (smtpPending.on.length || smtpPending.off.length || smtpPending.unknown.length)}
        <div class="ld-banner warn" style="margin-top:.6rem;">
          <div><b>Gespeicherte Auswahl ist im Tenant noch nicht angewendet.</b></div>
          {#if smtpPending.on.length}
            <div style="margin-top:.2rem;">Ohne Freigabe: {smtpPending.on.map(m => m.address).join(', ')}
              {#if smtp.state.orgDisabled} — <b>wird heute abgewiesen</b> (5.7.139){/if}</div>
          {/if}
          {#if smtpPending.off.length}
            <div style="margin-top:.2rem;">Noch freigegeben, nicht mehr in der Auswahl: {smtpPending.off.map(m => m.address).join(', ')}</div>
          {/if}
          {#if smtpPending.unknown.length}
            <div style="margin-top:.2rem;">In der Auswahl, aber kein Postfach mehr: {smtpPending.unknown.join(', ')}</div>
          {/if}
        </div>
      {:else if smtpPending}
        <p class="ld-section-hint" style="margin:.5rem 0 0;">✓ Tenant entspricht der gespeicherten Auswahl.</p>
      {/if}

      {#if smtpSignInsLoading}
        <div class="ld-step running" style="margin:.4rem 0;"><span class="ld-spinner"></span> Lese das Entra-Anmeldeprotokoll (bis zu 45 Sekunden) — die Auswahl unten geht schon.</div>
      {:else if smtpSignIns?.ok}
        <p class="ld-section-hint" style="margin:.4rem 0;">
          {smtpSignIns.users.length
            ? `${anz(smtpSignIns.users.length, 'Konto hat', 'Konten haben')} sich in den letzten ${smtpSignIns.days} Tagen per SMTP AUTH angemeldet.`
            : `Keine SMTP-AUTH-Anmeldungen in den letzten ${smtpSignIns.days} Tagen.`}
          {smtpSignIns.truncated ? 'Das Protokoll wurde nur teilweise gelesen (Zeitlimit) — es können Konten fehlen.' : ''}
          Systeme, die nur monatlich senden, können darin fehlen.</p>
      {:else if smtpSignIns}
        <div class="ld-banner warn" style="margin-top:.4rem;">Nutzung nicht erhebbar: {smtpSignIns.error || 'unbekannt'}
          <br /><small>Die Auswahl geht trotzdem — dann aber ohne Vorschlag aus den Anmeldungen. Vorher mit dem Kunden klären, welche Systeme Mails verschicken.</small></div>
      {/if}

      {#if smtpOrphans.length}
        <div class="ld-banner warn" style="margin-top:.4rem;">
          <div><b>{anz(smtpOrphans.length, 'Konto', 'Konten')} mit SMTP-Anmeldungen, aber ohne zuordenbares Postfach</b> — Anmeldename weicht von der Postfachadresse ab
            oder das Konto hat kein Postfach. Prüfen, zu welchem Postfach sie gehören:
            {smtpOrphans.map(u => `${u.upn} (${u.ok} ok${u.failed ? `, ${u.failed} fehlgeschlagen` : ''})`).join(', ')}</div>
        </div>
      {/if}

      <div style="display:flex; gap:.6rem; flex-wrap:wrap; align-items:center; margin:.6rem 0;">
        <input type="search" class="dl-search" placeholder="🔍 Postfach suchen …" bind:value={smtpFilter} style="max-width:280px;" />
        <label class="checkbox-label" style="margin:0;">
          <input type="checkbox" bind:checked={smtpOnlyRelevant} />
          <span>nur relevante (ausgewählt, freigegeben oder mit Anmeldungen)</span>
        </label>
        <button class="btn btn-secondary" style="padding:.25rem .7rem; font-size:.8rem;" onclick={loadSmtp} disabled={smtpLoading}>{smtpLoading ? '…' : '🔄 Neu laden'}</button>
      </div>

      <div class="gt-table-wrap">
        <table class="gt-table">
          <thead><tr><th style="width:2rem;"></th><th>Postfach</th><th>Einstellung</th><th>Wirksam</th><th>SMTP-Anmeldungen ({smtpSignIns?.days || 30} T.)</th></tr></thead>
          <tbody>
            {#each smtpRows as m (m.address)}
              {@const u = smtpUsage.get(m.address)}
              {@const eff = smtpEffective(m)}
              <tr>
                <td><input type="checkbox" checked={!!smtpSelected[m.address]}
                           onchange={(e) => { smtpTouched = true; smtpSelected = { ...smtpSelected, [m.address]: e.target.checked } }} /></td>
                <td><b>{m.displayName || m.address}</b><br /><small>{m.address}</small></td>
                <td><small>{smtpSettingLabel(m.setting)}</small></td>
                <td><small style="color:{eff.on ? 'var(--ok)' : 'var(--crit)'};">{eff.on ? '✅' : '⛔'} {eff.text}</small><br /><small>{eff.why}</small></td>
                <td><small>
                  {#if u}{u.ok} erfolgreich{u.failed ? ` · ${u.failed} fehlgeschlagen` : ''} · zuletzt {new Date(u.last).toLocaleDateString('de-CH')}{:else if smtpSignInsLoading}…{:else}—{/if}
                </small></td>
              </tr>
            {:else}
              <tr><td colspan="5"><small>{smtpFilter ? 'Kein Postfach passt zur Suche.' : 'Keine relevanten Postfächer — Haken bei „nur relevante" entfernen, um alle zu sehen.'}</small></td></tr>
            {/each}
          </tbody>
        </table>
      </div>

      <div style="display:flex; gap:.6rem; align-items:center; margin-top:.6rem; flex-wrap:wrap;">
        <button class="btn btn-primary" onclick={saveSmtp} disabled={smtpSaving}>
          {smtpSaving ? '…' : `Auswahl speichern (${smtpCount})`}
        </button>
        {#if smtp.selection}
          <button class="btn btn-secondary" onclick={applySmtp} disabled={smtpApplying || smtpDirty}
                  title={smtpDirty ? 'Erst die geänderte Auswahl speichern' : 'Setzt nur die Postfächer, die Organisation bleibt unverändert'}>
            {smtpApplying ? 'Setze Ausnahmen in Exchange Online…' : '⚡ Ausnahmen jetzt anwenden'}
          </button>
        {/if}
        {#if smtpDirty && smtp.selection}<small>Auswahl geändert — erst speichern, dann anwenden.</small>{/if}
        {#if !smtp.selection}<small>Vorauswahl ist ein Vorschlag aus heutigen Freigaben und Anmeldungen — noch nicht gespeichert.</small>{/if}
        {#if smtpMsg}<small style="color:{smtpMsg.ok ? 'var(--ok)' : 'var(--crit)'};">{smtpMsg.text}</small>{/if}
      </div>
    {/if}
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
    {@const sl = $config.safeLinks}
    {@const sa = $config.safeAttach}
    {@const ob = $config.outbound || {}}
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
        {#if sl.enabled}
          <li><strong>Safe Links / Safe Attachments:</strong> wird mit deployt · Anhang-Aktion {sa.action}{sl.allowClickThrough ? ' · Durchklicken erlaubt' : ''} <span class="ld-warn">← braucht Defender for O365 P1/P2, sonst schlägt nur dieser Baustein fehl</span></li>
        {:else}
          <li><strong>Safe Links / Safe Attachments:</strong> deaktiviert — wird nicht deployt</li>
        {/if}
        <li><strong>Quarantäne-Benachrichtigungen + Alert Policy an:</strong> {recipients}</li>
        <!-- Die Phase "Ausgehend & Organisation" fehlte hier lange komplett, obwohl drei
             ihrer vier Schritte standardmaessig mitlaufen und laufenden Betrieb unterbrechen
             koennen. Wer den Dialog liest, muss genau das sehen. -->
        <li><strong>Ausgehende Limits:</strong> {ob.limitExternalPerHour ?? 500} Empfänger/Stunde extern,
          {ob.limitPerDay ?? 1000}/Tag · bei Überschreitung {ob.thresholdAction === 'BlockUser' ? 'Sperre bis zur manuellen Freigabe' : 'Sperre bis Tagesende'}</li>
        {#if ob.externalTagging || ob.blockAutoForward || ob.rejectDirectSend || ob.disableSmtpAuth}
          <li><strong>Organisationsweite Schalter:</strong>
            <ul class="ld-confirm-sub">
              {#if ob.externalTagging}
                <li>Externe Absender werden in Outlook gekennzeichnet (wirkt mit bis zu 48 h Verzögerung)</li>
              {/if}
              {#if ob.blockAutoForward}
                <li>Automatische Weiterleitung nach aussen wird abgelehnt
                  <span class="ld-warn">← bricht bestehende gewollte Weiterleitungen</span></li>
              {/if}
              {#if ob.rejectDirectSend}
                <li>Direct Send wird abgewiesen
                  <span class="ld-warn">← schneidet Drucker, Scan-to-Mail und Fachanwendungen ab, ohne Fehlermeldung an den Absender</span></li>
              {/if}
              {#if ob.disableSmtpAuth}
                <li>SMTP AUTH organisationsweit aus{#if smtp?.selection}, {smtp.selection.allowed.length ? 'Ausnahmen für ' + anz(smtp.selection.allowed.length, 'Postfach', 'Postfächer') : 'ohne Ausnahmen'}{:else if smtp} — <b>keine Auswahl gespeichert, der Deploy wird abgelehnt</b>{:else} — Ausnahmen laut gespeicherter Auswahl{/if}
                  <span class="ld-warn">← alte Freigaben ausserhalb der Auswahl werden zurückgesetzt</span></li>
              {/if}
            </ul>
          </li>
        {/if}
      </ul>
      {#if ob.blockAutoForward || ob.rejectDirectSend}
        <div class="ld-banner warn" style="margin:0.6rem 0">
          <strong>Vor diesem Deploy erhoben?</strong> Auto-Forward-Sperre und Direct Send greifen sofort und
          betriebsstörend. Wurden Weiterleitungen und Einlieferungen dieses Kunden vorher ausgewertet? Wenn nicht:
          abbrechen und die beiden Schalter im Bereich „Vorlage" für diesen Tenant abwählen.
        </div>
      {/if}
      <small>Alles idempotent: Vorhandene BP_-Policies werden aktualisiert, fehlende angelegt.
        Das heisst <em>nicht</em> rückgängig machbar — was die Schalter oben abschalten, bleibt abgeschaltet,
        bis es jemand von Hand zurücksetzt.</small>
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
