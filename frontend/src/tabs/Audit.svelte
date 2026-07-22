<script>
  import { onDestroy } from 'svelte'
  import { config } from '../lib/config.js'
  import { apiGet, apiPost } from '../lib/api.js'
  import { activeTenant, autoDomains } from '../lib/tenantStore.js'
  import TenantContext from '../lib/TenantContext.svelte'

  function ldEsc(s) {
    const div = document.createElement('div')
    div.textContent = String(s == null ? '' : s)
    return div.innerHTML
  }

  // ---------- Soll/Ist-Vergleich (reine Funktionen, keine DOM-Abhaengigkeit) ----------
  function ldDomainsEqual(ist, soll) {
    const norm = a => (Array.isArray(a) ? a : (a ? [a] : [])).map(d => String(d).toLowerCase()).sort()
    const i = norm(ist), s = norm(soll)
    return i.length === s.length && i.every((v, k) => v === s[k])
  }

  function ldPermFlags(permString, expected) {
    const bad = []
    for (const [flag, want] of Object.entries(expected)) {
      const isTrue = new RegExp(flag + ':\\s*True', 'i').test(String(permString || ''))
      if (isTrue !== want) bad.push(flag.replace('PermissionTo', '') + (want ? ' fehlt' : ' zu viel'))
    }
    return bad
  }

  function buildAuditGroups(audit, alertPolicy, cfg, autoDomainsOn, devMap) {
    const ap = cfg.antiPhishing, as = cfg.antiSpam, am = cfg.antiMalware, g = cfg.global
    const sollDomains = autoDomainsOn ? (audit.acceptedDomains || []) : [...g.domains, g.onmicrosoftDomain].filter(Boolean)
    const groups = []
    function group(icon, title) { const grp = { icon, title, checks: [] }; groups.push(grp); return grp }
    function ok(grp, label, ist) { grp.checks.push({ state: 'ok', label, detail: ist }) }
    function bad(grp, label, soll, ist) { grp.checks.push({ state: 'bad', label, detail: 'Soll: ' + soll + ' · Ist: ' + ist }) }
    function missing(grp, label) { grp.checks.push({ state: 'missing', label, detail: 'nicht vorhanden — Deploy ausführen' }) }
    function info(grp, label, detail) { grp.checks.push({ state: 'info', label, detail }) }
    function cmp(grp, label, soll, ist) {
      if (String(soll) === String(ist)) ok(grp, label, String(ist))
      else bad(grp, label, String(soll), String(ist == null ? '(leer)' : ist))
    }
    function cmpBool(grp, label, soll, ist) { cmp(grp, label, soll ? 'true' : 'false', ist === true ? 'true' : (ist === false ? 'false' : ist)) }

    // Quarantine Policies
    const gq = group('🔒', 'Quarantine Policies')
    if (!audit.quarantineSelf) missing(gq, 'BP_Quarantine-SelfReleaseNotification')
    else {
      const q = audit.quarantineSelf
      ok(gq, 'BP_Quarantine-SelfReleaseNotification', 'vorhanden')
      cmpBool(gq, 'SelfRelease: Benachrichtigung aktiv', true, q.ESNEnabled)
      cmpBool(gq, 'SelfRelease: inkl. blockierte Absender', true, q.IncludeMessagesFromBlockedSenderAddress)
      const badFlags = ldPermFlags(q.Permissions, { PermissionToAllowSender: true, PermissionToBlockSender: true, PermissionToRequestRelease: true, PermissionToRelease: false, PermissionToPreview: true, PermissionToDelete: true })
      if (badFlags.length === 0) ok(gq, 'SelfRelease: Berechtigungen (59)', 'korrekt')
      else bad(gq, 'SelfRelease: Berechtigungen (59)', 'AllowSender+BlockSender+RequestRelease+Preview+Delete', badFlags.join(', '))
    }
    if (!audit.quarantineRequest) missing(gq, 'BP_Quarantine-RequestReleaseNotification')
    else {
      const q = audit.quarantineRequest
      ok(gq, 'BP_Quarantine-RequestReleaseNotification', 'vorhanden')
      cmpBool(gq, 'RequestRelease: Benachrichtigung aktiv', true, q.ESNEnabled)
      cmpBool(gq, 'RequestRelease: ohne blockierte Absender', false, q.IncludeMessagesFromBlockedSenderAddress)
      const badFlags = ldPermFlags(q.Permissions, { PermissionToAllowSender: false, PermissionToBlockSender: true, PermissionToRequestRelease: true, PermissionToRelease: false, PermissionToPreview: true, PermissionToDelete: false })
      if (badFlags.length === 0) ok(gq, 'RequestRelease: Berechtigungen (26)', 'korrekt')
      else bad(gq, 'RequestRelease: Berechtigungen (26)', 'BlockSender+RequestRelease+Preview', badFlags.join(', '))
    }

    // Anti-Phishing
    const gp = group('🎣', 'Anti-Phishing')
    if (!audit.antiPhish) missing(gp, 'BP_AntiPhishing')
    else {
      const p = audit.antiPhish
      cmpBool(gp, 'Policy aktiv', true, p.Enabled)
      cmpBool(gp, 'Spoof Intelligence', ap.spoofIntelligence, p.EnableSpoofIntelligence)
      cmpBool(gp, 'First Contact Safety Tip', ap.firstContactTip, p.EnableFirstContactSafetyTips)
      cmpBool(gp, 'Unauth-Sender-Symbol (?)', ap.unauthSenderSymbol, p.EnableUnauthenticatedSender)
      cmpBool(gp, 'Via-Tag', ap.viaTag, p.EnableViaTag)
      cmpBool(gp, 'DMARC beachten', ap.honorDmarc, p.HonorDmarcPolicy)
      cmp(gp, 'DMARC p=quarantine', ap.dmarcQuarantineAction, p.DmarcQuarantineAction)
      cmp(gp, 'DMARC p=reject', ap.dmarcRejectAction, p.DmarcRejectAction)
      cmp(gp, 'Spoof-Aktion', ap.spoofAction, p.AuthenticationFailAction)
      cmp(gp, 'Spoof-Quarantine-Tag', 'BP_Quarantine-SelfReleaseNotification', p.SpoofQuarantineTag)
    }
    if (!audit.antiPhishRule) missing(gp, 'BP_AntiPhishing_Rule')
    else {
      cmp(gp, 'Rule aktiv', 'Enabled', audit.antiPhishRule.State)
      if (ldDomainsEqual(audit.antiPhishRule.RecipientDomainIs, sollDomains)) ok(gp, 'Rule-Domains', (audit.antiPhishRule.RecipientDomainIs || []).join(', '))
      else bad(gp, 'Rule-Domains', sollDomains.join(', '), (audit.antiPhishRule.RecipientDomainIs || []).join(', ') || '(leer)')
    }

    // Anti-Spam
    const gs = group('📧', 'Anti-Spam')
    if (!audit.antiSpam) missing(gs, 'BP_AntiSpam_Inbound')
    else {
      const s = audit.antiSpam
      cmp(gs, 'Bulk-Schwelle', as.bulkThreshold, s.BulkThreshold)
      cmp(gs, 'Spam-Aktion', as.spamAction, s.SpamAction)
      cmp(gs, 'High-Conf-Spam-Aktion', as.highConfSpamAction, s.HighConfidenceSpamAction)
      cmp(gs, 'Bulk-Aktion', as.bulkAction, s.BulkSpamAction)
      cmp(gs, 'Phishing-Aktion', as.phishAction, s.PhishSpamAction)
      cmp(gs, 'High-Conf-Phishing-Aktion', as.highConfPhishAction, s.HighConfidencePhishAction)
      cmp(gs, 'Quarantäne-Aufbewahrung (Tage)', 30, s.QuarantineRetentionPeriod)
      const tagChecks = [
        ['Spam-Tag', s.SpamQuarantineTag, 'BP_Quarantine-SelfReleaseNotification'],
        ['High-Conf-Spam-Tag', s.HighConfidenceSpamQuarantineTag, 'BP_Quarantine-SelfReleaseNotification'],
        ['Bulk-Tag', s.BulkQuarantineTag, 'BP_Quarantine-SelfReleaseNotification'],
        ['Phishing-Tag', s.PhishQuarantineTag, 'BP_Quarantine-SelfReleaseNotification'],
        ['High-Conf-Phishing-Tag', s.HighConfidencePhishQuarantineTag, 'BP_Quarantine-RequestReleaseNotification']
      ]
      const badTags = tagChecks.filter(([, ist, soll]) => String(ist) !== soll).map(([l, ist]) => l + '=' + (ist || '(leer)'))
      if (badTags.length === 0) ok(gs, 'Quarantine-Tags (5)', 'alle korrekt')
      else bad(gs, 'Quarantine-Tags (5)', 'BP_-Tags', badTags.join(', '))
      const markMap = [
        ['bizInfoUrls', 'IncreaseScoreWithBizOrInfoUrls', 'ASF: URLs zu .biz/.info'],
        ['numericIpUrls', 'IncreaseScoreWithNumericIps', 'ASF: Numerische IP in URL'],
        ['urlRedirect', 'IncreaseScoreWithRedirectToOtherPort', 'ASF: URL-Redirect zu anderem Port'],
        ['emptyMessages', 'MarkAsSpamEmptyMessages', 'ASF: Leere Nachrichten'],
        ['jsVbScript', 'MarkAsSpamJavaScriptInHtml', 'ASF: JavaScript/VBScript in HTML'],
        ['frameIframe', 'MarkAsSpamFramesInHtml', 'ASF: Frame/IFrame-Tags'],
        ['sensitiveWords', 'MarkAsSpamSensitiveWordList', 'ASF: Sensible Wörter'],
        ['spfHardFail', 'MarkAsSpamSpfRecordHardFail', 'ASF: SPF Hard Fail'],
        ['backscatter', 'MarkAsSpamFromAddressAuthFail', 'ASF: Backscatter / From-Auth-Fail']
      ]
      const asfOn = markMap.filter(([, istKey]) => String(s[istKey]) === 'On').length
      info(gs, 'Erweiterte Spam-Filter (ASF, 9)', asfOn === 0
        ? 'alle Off — Best Practice (Microsoft empfiehlt Off)'
        : asfOn + ' von 9 aktiviert — Microsoft empfiehlt Off, nur gezielt & mit Grund aktivieren')
      for (const [cfgKey, istKey, label] of markMap) {
        cmp(gs, label, (as[cfgKey] ? 'On' : 'Off'), s[istKey])
      }
    }
    if (!audit.antiSpamRule) missing(gs, 'BP_AntiSpam_Inbound_Rule')
    else {
      cmp(gs, 'Rule aktiv', 'Enabled', audit.antiSpamRule.State)
      if (ldDomainsEqual(audit.antiSpamRule.RecipientDomainIs, sollDomains)) ok(gs, 'Rule-Domains', (audit.antiSpamRule.RecipientDomainIs || []).join(', '))
      else bad(gs, 'Rule-Domains', sollDomains.join(', '), (audit.antiSpamRule.RecipientDomainIs || []).join(', ') || '(leer)')
    }

    // Anti-Malware
    const gm = group('🦠', 'Anti-Malware')
    if (!audit.malware) missing(gm, 'BP_AntiMalware')
    else {
      const m = audit.malware
      cmpBool(gm, 'Anhang-Filter aktiv', am.commonAttachFilter, m.EnableFileFilter)
      cmpBool(gm, 'Zero-Hour Auto Purge (ZAP)', am.zapMalware, m.ZapEnabled)
      cmp(gm, 'Quarantine-Tag', 'BP_Quarantine-RequestReleaseNotification', m.QuarantineTag)
      cmp(gm, 'Admin-Benachrichtigung an', g.adminEmail, m.InternalSenderAdminAddress)
      const soll = String(am.customFileTypes || '').split(',').map(t => t.trim().replace(/^\.+/, '').toLowerCase()).filter(Boolean)
      const ist = (m.FileTypes || []).map(t => String(t).toLowerCase())
      const fehlt = soll.filter(t => !ist.includes(t))
      const extra = ist.filter(t => !soll.includes(t))
      if (fehlt.length === 0 && extra.length === 0) ok(gm, 'Blockierte Dateitypen (' + ist.length + ')', 'identisch mit Konfiguration')
      else bad(gm, 'Blockierte Dateitypen', soll.length + ' Typen', (fehlt.length ? 'fehlt: ' + fehlt.join(', ') : '') + (extra.length ? (fehlt.length ? ' · ' : '') + 'zusätzlich: ' + extra.join(', ') : ''))
    }
    if (!audit.malwareRule) missing(gm, 'BP_AntiMalware_Rule')
    else {
      cmp(gm, 'Rule aktiv', 'Enabled', audit.malwareRule.State)
      if (ldDomainsEqual(audit.malwareRule.RecipientDomainIs, sollDomains)) ok(gm, 'Rule-Domains', (audit.malwareRule.RecipientDomainIs || []).join(', '))
      else bad(gm, 'Rule-Domains', sollDomains.join(', '), (audit.malwareRule.RecipientDomainIs || []).join(', ') || '(leer)')
    }

    // Alert Policy — via TCM-Snapshot (Graph)
    const ga = group('🔔', 'Alert Policy (Security & Compliance)')
    const ap2 = alertPolicy || { status: 'error', error: 'keine TCM-Daten' }
    if (ap2.status === 'pending') {
      ga.checks.push({ state: 'loading', label: 'BP_UserRequestReleaseStatus', detail: 'TCM-Snapshot läuft — Ergebnis kommt gleich…' })
    } else if (ap2.status === 'error') {
      info(ga, 'BP_UserRequestReleaseStatus', 'nicht prüfbar: ' + (ap2.error || 'unbekannt') + (ap2.hint ? ' · ' + ap2.hint : ''))
    } else if (!ap2.found) {
      ga.checks.push({ state: 'missing', label: 'BP_UserRequestReleaseStatus', detail: 'nicht vorhanden — Snippet aus dem Deploy-Ergebnis auf Windows ausführen' })
    } else {
      ok(ga, 'BP_UserRequestReleaseStatus', 'vorhanden (geprüft via TCM-Snapshot)')
      cmpBool(ga, 'Alert aktiv', true, !ap2.disabled)
      const soll = [g.adminEmail, g.igeeksEmail].filter(Boolean).map(e => e.toLowerCase())
      const ist = (ap2.notifyUser || []).map(e => String(e).toLowerCase())
      const fehlend = soll.filter(e => !ist.includes(e))
      if (fehlend.length === 0) ok(ga, 'Empfänger', (ap2.notifyUser || []).join(', '))
      else bad(ga, 'Empfänger', soll.join(', '), (ap2.notifyUser || []).join(', ') || '(leer)')
    }

    // Gewollte Abweichungen ueberschreiben bad/missing -> 'accepted'
    for (const grp of groups) {
      for (const c of grp.checks) {
        const key = grp.title + ' :: ' + c.label
        if ((c.state === 'bad' || c.state === 'missing') && devMap[key] != null) {
          c.state = 'accepted'
          c.reason = devMap[key]
        }
      }
    }

    const domSrc = autoDomainsOn ? 'Accepted Domains des Tenants' : 'Domains aus dem Konfigurations-Tab'
    return { groups, sollDomains, domSrc }
  }

  const iconFor = { ok: '✅', bad: '❌', missing: '⚠️', info: 'ℹ️', accepted: 'ℹ️' }
  const clsFor = { ok: 'ok', bad: 'fail', missing: 'retry', info: '', loading: 'running', accepted: 'accepted' }

  // ---------- Komponenten-Zustand ----------
  let auditBusy = $state(false)
  let auditError = $state(null)
  let auditData = $state(null)     // { audit, alertPolicy }
  let deviations = $state([])      // [{key, reason}]
  let auditTcmTimer = null
  let lastTenantId = null

  // ---------- SPF/DKIM/DMARC-Checker ----------
  let daBusy = $state(false)
  let daError = $state(null)
  let daResults = $state(null) // [{domain, spf, dmarc, dkim}]

  $effect(() => {
    const id = $activeTenant?.id ?? null
    if (id !== lastTenantId) {
      lastTenantId = id
      auditBusy = false
      auditError = null
      auditData = null
      deviations = []
      daBusy = false
      daError = null
      daResults = null
      if (auditTcmTimer) { clearTimeout(auditTcmTimer); auditTcmTimer = null }
    }
  })

  onDestroy(() => { if (auditTcmTimer) clearTimeout(auditTcmTimer) })

  async function runAudit() {
    if (!$activeTenant) return
    if (auditTcmTimer) { clearTimeout(auditTcmTimer); auditTcmTimer = null }
    auditBusy = true
    auditError = null
    const tenantId = $activeTenant.id
    try {
      const r = await apiPost(`/api/tenants/${encodeURIComponent(tenantId)}/audit`)
      deviations = Array.isArray(r.acceptedDeviations) ? r.acceptedDeviations : []
      auditData = { audit: r.audit || {}, alertPolicy: r.alertPolicy || null }
      if (auditData.alertPolicy?.status === 'pending' && auditData.alertPolicy.jobId) {
        pollTcm(tenantId, auditData.alertPolicy.jobId, 0)
      }
    } catch (e) {
      auditError = e.message
    }
    auditBusy = false
  }

  async function runDomainAuth() {
    if (!$activeTenant) return
    daBusy = true
    daError = null
    try {
      const r = await apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/domainauth`)
      daResults = Array.isArray(r.results) ? r.results : []
    } catch (e) {
      daError = e.message
    }
    daBusy = false
  }

  function daBadge(status) {
    if (status === 'ok') return { icon: '✅', cls: 'ok', label: 'OK' }
    if (status === 'warn') return { icon: '⚠️', cls: 'warn', label: 'Teilweise' }
    return { icon: '❌', cls: 'bad', label: 'Fehlt/Fehlerhaft' }
  }

  const daKpi = $derived.by(() => {
    if (!daResults || !daResults.length) return null
    const total = daResults.length
    const spfOk = daResults.filter(d => d.spf.status === 'ok').length
    const dkimOk = daResults.filter(d => d.dkim.status === 'ok').length
    const dmarcOk = daResults.filter(d => d.dmarc.status === 'ok').length
    return { total, spfOk, dkimOk, dmarcOk }
  })

  function pollTcm(tenantId, jobId, tries) {
    auditTcmTimer = setTimeout(async () => {
      let result
      try {
        result = await apiGet(`/api/tenants/${encodeURIComponent(tenantId)}/tcm/${encodeURIComponent(jobId)}`)
      } catch (e) {
        auditData = { ...auditData, alertPolicy: { status: 'error', error: e.message } }
        return
      }
      if (result.status === 'pending') {
        if (tries + 1 >= 24) {
          auditData = { ...auditData, alertPolicy: { status: 'error', error: 'TCM-Snapshot dauert ungewöhnlich lange — später erneut prüfen.' } }
          return
        }
        pollTcm(tenantId, jobId, tries + 1)
        return
      }
      auditData = { ...auditData, alertPolicy: result }
    }, 5000)
  }

  async function markDeviation(groupTitle, label, action) {
    if (!auditData || !$activeTenant) return
    const key = groupTitle + ' :: ' + label
    let reason = ''
    if (action === 'accept') {
      reason = (window.prompt('Begründung für die gewollte Abweichung (erscheint im Audit-PDF):', '') || '').trim()
      if (!reason) return
    }
    try {
      const r = await apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/deviations`, { key, reason })
      deviations = Array.isArray(r.acceptedDeviations) ? r.acceptedDeviations : []
    } catch (e) {
      alert('Konnte die Markierung nicht speichern: ' + e.message)
    }
  }

  const devMap = $derived.by(() => {
    const m = {}
    for (const d of deviations) if (d && d.key) m[d.key] = d.reason
    return m
  })

  const auditResult = $derived.by(() => {
    if (!auditData) return null
    return buildAuditGroups(auditData.audit, auditData.alertPolicy, $config, $autoDomains, devMap)
  })

  const groups = $derived(auditResult?.groups ?? [])
  const sollDomains = $derived(auditResult?.sollDomains ?? [])
  const domSrc = $derived(auditResult?.domSrc ?? '')
  const allChecks = $derived(groups.flatMap(g => g.checks))
  const countable = $derived(allChecks.filter(c => c.state !== 'info' && c.state !== 'loading' && c.state !== 'accepted'))
  const okCount = $derived(countable.filter(c => c.state === 'ok').length)
  const acceptedCount = $derived(allChecks.filter(c => c.state === 'accepted').length)
  const allOk = $derived(okCount === countable.length)

  const pdfData = $derived.by(() => {
    if (!auditData || !$activeTenant) return null
    return { name: $activeTenant.name, groups, okCount, total: countable.length, accepted: acceptedCount, allOk, domSrc, sollDomains: sollDomains.slice() }
  })

  // ---------- Audit-Report als PDF (druckoptimiertes HTML-Dokument, kein PDF-Lib) ----------
  function ldAuditStatusMeta(state) {
    switch (state) {
      case 'ok': return { label: 'Konform', cls: 'ok' }
      case 'bad': return { label: 'Abweichung', cls: 'bad' }
      case 'missing': return { label: 'Fehlt', cls: 'missing' }
      case 'accepted': return { label: 'Gewollt', cls: 'accepted' }
      case 'loading': return { label: 'Läuft', cls: 'info' }
      default: return { label: 'Info', cls: 'info' }
    }
  }

  function ldAuditSollIst(check) {
    const d = String(check.detail || '')
    const m = /^Soll:\s*(.*?)\s*·\s*Ist:\s*(.*)$/.exec(d)
    if (m) return { soll: m[1] || '(leer)', ist: m[2] || '(leer)' }
    return { soll: '', ist: d }
  }

  function buildAuditReportHtml(data) {
    const now = new Date()
    const dateStr = now.toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric' })
    const timeStr = now.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })
    const deviationsCount = data.total - data.okCount
    const pct = data.total ? Math.round((data.okCount / data.total) * 100) : 100
    const accepted = data.accepted || 0
    const summaryCls = data.allOk ? 'ok' : (deviationsCount > (data.total / 4) ? 'bad' : 'warn')
    const accSuffix = accepted ? ' ' + accepted + ' Abweichung(en) sind als bewusst/gewollt markiert (siehe „Gewollt").' : ''
    const summaryText = (data.allOk
      ? 'Der Ist-Zustand entspricht vollständig der Best-Practice-Vorlage.'
      : deviationsCount + ' von ' + data.total + ' Prüfpunkten weichen von der Vorlage ab. Ein Deploy bringt den Tenant auf den Soll-Zustand.') + accSuffix

    const sections = data.groups.map(grp => {
      const gTotal = grp.checks.filter(c => c.state !== 'info' && c.state !== 'loading' && c.state !== 'accepted').length
      const gOk = grp.checks.filter(c => c.state === 'ok').length
      const gBadge = gTotal ? (gOk === gTotal
        ? '<span class="sec-badge ok">' + gOk + '/' + gTotal + ' konform</span>'
        : '<span class="sec-badge warn">' + gOk + '/' + gTotal + ' konform</span>')
        : '<span class="sec-badge info">Info</span>'
      const rows = grp.checks.map(c => {
        const sm = ldAuditStatusMeta(c.state)
        const si = ldAuditSollIst(c)
        const istCell = c.state === 'accepted'
          ? (si.ist ? ldEsc(si.ist) : '<span class="muted">—</span>') + '<div class="rsn">✋ gewollt: ' + ldEsc(c.reason || '') + '</div>'
          : (si.ist ? ldEsc(si.ist) : '<span class="muted">—</span>')
        return '<tr>' +
          '<td class="c-check">' + ldEsc(c.label) + '</td>' +
          '<td class="c-status"><span class="pill ' + sm.cls + '">' + sm.label + '</span></td>' +
          '<td class="c-soll">' + (si.soll ? ldEsc(si.soll) : '<span class="muted">—</span>') + '</td>' +
          '<td class="c-ist">' + istCell + '</td>' +
          '</tr>'
      }).join('')
      return '<section class="cat">' +
        '<div class="cat-head"><span class="cat-title">' + grp.icon + ' ' + ldEsc(grp.title) + '</span>' + gBadge + '</div>' +
        '<table class="cat-table"><thead><tr>' +
        '<th class="c-check">Prüfpunkt</th><th class="c-status">Status</th><th class="c-soll">Soll (Best Practice)</th><th class="c-ist">Ist (Tenant)</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table></section>'
    }).join('')

    const domList = (data.sollDomains && data.sollDomains.length) ? data.sollDomains.join(', ') : '—'

    return '<!DOCTYPE html><html lang="de"><head><meta charset="utf-8">' +
      '<title>Ist-Zustand ' + ldEsc(data.name) + ' — M365 Security Doku</title>' +
      '<style>' + ldAuditReportCss() + '</style></head><body>' +
      '<button class="no-print print-btn" onclick="window.print()">📄 Als PDF speichern / Drucken</button>' +
      '<div class="page">' +
      '<header class="rpt-head">' +
      '<div class="rpt-head-main">' +
      '<div class="rpt-kicker">M365 Security Policy Manager</div>' +
      '<h1>Ist-Zustand Dokumentation</h1>' +
      '<div class="rpt-sub">Best-Practice-Audit der Exchange-Online-Schutzrichtlinien</div>' +
      '</div>' +
      '<div class="rpt-score ' + summaryCls + '"><div class="score-num">' + pct + '%</div><div class="score-lbl">konform</div></div>' +
      '</header>' +
      '<div class="meta-grid">' +
      '<div class="meta-cell"><span class="meta-k">Tenant</span><span class="meta-v">' + ldEsc(data.name) + '</span></div>' +
      '<div class="meta-cell"><span class="meta-k">Erstellt am</span><span class="meta-v">' + dateStr + ' · ' + timeStr + ' Uhr</span></div>' +
      '<div class="meta-cell"><span class="meta-k">Soll-Domains</span><span class="meta-v">' + ldEsc(data.domSrc) + '</span></div>' +
      '<div class="meta-cell"><span class="meta-k">Geprüfte Domains</span><span class="meta-v">' + ldEsc(domList) + '</span></div>' +
      '</div>' +
      '<div class="summary ' + summaryCls + '"><strong>Ergebnis:</strong> ' + summaryText + '</div>' +
      sections +
      '<footer class="rpt-foot">Automatisch erzeugt vom M365 Security Policy Manager · ' + dateStr + ' ' + timeStr +
      ' · Soll = Best-Practice-Vorlage, Ist = live aus dem Tenant gelesen (app-only Exchange Online / Graph).</footer>' +
      '</div></body></html>'
  }

  function ldAuditReportCss() {
    return [
      '*{box-sizing:border-box;margin:0;padding:0}',
      'body{font-family:"Segoe UI",system-ui,-apple-system,Roboto,Helvetica,Arial,sans-serif;color:#1d2939;background:#f2f4f7;line-height:1.45;-webkit-print-color-adjust:exact;print-color-adjust:exact}',
      '.page{max-width:820px;margin:24px auto;background:#fff;padding:32px 36px 40px;box-shadow:0 2px 18px rgba(16,24,40,.12);border-radius:6px}',
      '.rpt-head{display:flex;align-items:center;justify-content:space-between;gap:20px;background:linear-gradient(120deg,#1e3a8a,#4338ca);color:#fff;padding:22px 26px;border-radius:10px;margin:-8px 0 22px}',
      '.rpt-kicker{font-size:11px;letter-spacing:.14em;text-transform:uppercase;opacity:.82;font-weight:600}',
      '.rpt-head h1{font-size:25px;font-weight:700;margin:4px 0 2px;line-height:1.15}',
      '.rpt-sub{font-size:12.5px;opacity:.85}',
      '.rpt-score{flex:none;text-align:center;min-width:96px;padding:12px 14px;border-radius:10px;background:rgba(255,255,255,.14)}',
      '.rpt-score .score-num{font-size:30px;font-weight:800;line-height:1}',
      '.rpt-score .score-lbl{font-size:11px;letter-spacing:.08em;text-transform:uppercase;opacity:.9;margin-top:3px}',
      '.meta-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:18px}',
      '.meta-cell{background:#f8fafc;border:1px solid #eaecf0;border-radius:8px;padding:9px 12px;display:flex;flex-direction:column;gap:2px}',
      '.meta-k{font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:#667085;font-weight:600}',
      '.meta-v{font-size:13.5px;font-weight:600;color:#1d2939;word-break:break-word}',
      '.summary{border-radius:8px;padding:11px 14px;font-size:13px;margin-bottom:22px;border:1px solid}',
      '.summary.ok{background:#ecfdf3;border-color:#abefc6;color:#067647}',
      '.summary.warn{background:#fffaeb;border-color:#fedf89;color:#b54708}',
      '.summary.bad{background:#fef3f2;border-color:#fecdca;color:#b42318}',
      '.rpt-score.ok{background:rgba(255,255,255,.18)}',
      '.cat{margin-bottom:16px;border:1px solid #eaecf0;border-radius:9px;overflow:hidden;break-inside:avoid;page-break-inside:avoid}',
      '.cat-head{display:flex;align-items:center;justify-content:space-between;background:#f8fafc;border-bottom:1px solid #eaecf0;padding:9px 14px}',
      '.cat-title{font-size:14.5px;font-weight:700;color:#1d2939}',
      '.sec-badge{font-size:11px;font-weight:700;padding:3px 9px;border-radius:20px}',
      '.sec-badge.ok{background:#ecfdf3;color:#067647}',
      '.sec-badge.warn{background:#fffaeb;color:#b54708}',
      '.sec-badge.info{background:#eef1f5;color:#475467}',
      '.cat-table{width:100%;border-collapse:collapse;font-size:12px}',
      '.cat-table th{text-align:left;font-size:10.5px;letter-spacing:.04em;text-transform:uppercase;color:#667085;font-weight:700;padding:7px 12px;background:#fcfcfd;border-bottom:1px solid #eaecf0}',
      '.cat-table td{padding:7px 12px;border-bottom:1px solid #f2f4f7;vertical-align:top}',
      '.cat-table tr:last-child td{border-bottom:none}',
      '.cat-table tbody tr:nth-child(even) td{background:#fcfcfd}',
      '.c-check{width:30%;font-weight:600;color:#1d2939}',
      '.c-status{width:16%}',
      '.c-soll{width:27%;color:#475467}',
      '.c-ist{width:27%;color:#1d2939}',
      '.muted{color:#98a2b3}',
      '.pill{display:inline-block;font-size:11px;font-weight:700;padding:2px 9px;border-radius:20px;white-space:nowrap}',
      '.pill.ok{background:#ecfdf3;color:#067647}',
      '.pill.bad{background:#fef3f2;color:#b42318}',
      '.pill.missing{background:#fffaeb;color:#b54708}',
      '.pill.info{background:#eef1f5;color:#475467}',
      '.pill.accepted{background:#eff4ff;color:#3538cd}',
      '.rsn{font-size:10px;color:#3538cd;margin-top:3px;font-style:italic}',
      '.rpt-foot{margin-top:20px;padding-top:12px;border-top:1px solid #eaecf0;font-size:10.5px;color:#98a2b3;line-height:1.5}',
      '.print-btn{position:fixed;top:16px;right:16px;z-index:9;background:#4338ca;color:#fff;border:none;padding:10px 16px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;box-shadow:0 3px 10px rgba(67,56,202,.35)}',
      // Saubere Seitenumbrueche: nie mitten in Zeilen/Absaetzen brechen; bricht
      // eine lange Tabelle doch, wiederholt thead den Kopf auf der Folgeseite.
      'tr,p,li{break-inside:avoid;page-break-inside:avoid}',
      'thead{display:table-header-group}',
      'h1,h2,h3,h4,.cat-head{break-after:avoid;page-break-after:avoid;break-inside:avoid}',
      '@media print{body{background:#fff}.no-print{display:none!important}.page{box-shadow:none;margin:0;max-width:none;border-radius:0;padding:0}.rpt-head{margin-top:0}}',
      '@page{size:A4;margin:14mm}'
    ].join('')
  }

  function openAuditPdfReport() {
    if (!pdfData) return
    const html = buildAuditReportHtml(pdfData)
    const w = window.open('', '_blank')
    if (!w) { alert('Der Browser hat das PDF-Fenster blockiert. Bitte Pop-ups für diese Seite erlauben und erneut „Audit-PDF" klicken.'); return }
    w.document.open(); w.document.write(html); w.document.close()
    setTimeout(() => { try { w.focus(); w.print() } catch (e) {} }, 400)
  }

  // ---------- Konfig-Doku (nuechtern) als PDF ----------
  const LD_DOC_INTRO = {
    'Quarantine Policies': 'Zwei Endnutzer-Quarantäne-Richtlinien mit aktivierter Quarantäne-Benachrichtigung (ESN). Berechtigungswert 59 = Selbst-Freigabe (AllowSender + BlockSender + RequestRelease + Preview + Delete), 26 = nur Freigabe-Anfrage (BlockSender + RequestRelease + Preview) für höher eingestufte Nachrichten.',
    'Anti-Phishing': 'Richtlinie BP_AntiPhishing: Spoof Intelligence, Safety Tips, Kennzeichnung nicht authentifizierter Absender und DMARC-Durchsetzung. Der Empfänger-Scope läuft über BP_AntiPhishing_Rule; der Spoof-Quarantine-Tag ist nur per PowerShell setzbar (Portal-Limitierung).',
    'Anti-Spam': 'Richtlinie BP_AntiSpam_Inbound: Spam- und Phishing-Verdicts gehen in die Quarantäne, Bulk-Mail (Graymail/Newsletter ab BCL-Schwelle) in den Junk-Ordner; Aufbewahrung 30 Tage, tägliche Endnutzer-Benachrichtigung. Die neun Legacy-ASF-Filter stehen gemäß Microsoft-Empfehlung auf Off — sie übersteuern ARC/Composite-Authentication, erzeugen False Positives (z.B. SPF Hard Fail hinter Inline-Gateways, Sensible Wörter bei Medizin-/Finanzkorrespondenz) und ASF-Treffer sind bei Microsoft nicht als False Positive meldbar.',
    'Anti-Malware': 'Richtlinie BP_AntiMalware: Common-Attachment-Filter und Zero-Hour Auto Purge (ZAP); Malware-Treffer gehen in die Quarantäne mit Freigabe-Anfrage, Admins werden bei internen wie externen Absendern benachrichtigt. Dateitypen werden ohne führenden Punkt gespeichert (Exchange ergänzt ihn selbst).',
    'Alert Policy (Security & Compliance)': 'Eigene Warnungsrichtlinie BP_UserRequestReleaseStatus, da die eingebaute Microsoft-Richtlinie schreibgeschützt ist. Meldet Freigabe-Anfragen aus der Quarantäne an Admin- und MSP-Postfach.'
  }

  function ldDocStatusCell(c) {
    switch (c.state) {
      case 'ok': return '<span class="st ok">✓ konform</span>'
      case 'bad': return '<span class="st bad">✗ Abweichung</span>'
      case 'missing': return '<span class="st bad">fehlt</span>'
      case 'accepted': return '<span class="st acc">✋ gewollt</span>' + (c.reason ? '<div class="rsn">' + ldEsc(c.reason) + '</div>' : '')
      default: return '<span class="st info">Info</span>'
    }
  }

  function buildTenantConfigDocHtml(data, cfg) {
    const now = new Date()
    const dateStr = now.toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric' })
    const timeStr = now.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })
    const g = cfg.global, am = cfg.antiMalware
    const pct = data.total ? Math.round((data.okCount / data.total) * 100) : 100
    const openDev = data.total - data.okCount
    const fileTypesSoll = String(am.customFileTypes || '').split(',').map(t => t.trim().replace(/^\.+/, '')).filter(Boolean)

    let n = 0
    const sec = (title, body) => { n++; return '<div class="section"><h2>' + n + '&nbsp;&nbsp;' + title + '</h2>' + body + '</div>' }

    const checksTable = grp => '<table><tr><th style="width:30%">Prüfpunkt</th><th style="width:26%">Soll (Best Practice)</th><th style="width:26%">Ist (Tenant)</th><th>Status</th></tr>' +
      grp.checks.map(c => {
        const si = ldAuditSollIst(c)
        const soll = si.soll || (c.state === 'ok' ? si.ist : '—')
        return '<tr><td class="pn">' + ldEsc(c.label) + '</td>' +
          '<td class="v">' + ldEsc(soll || '—') + '</td>' +
          '<td class="v">' + ldEsc(si.ist || '—') + '</td>' +
          '<td>' + ldDocStatusCell(c) + '</td></tr>'
      }).join('') + '</table>'

    const overview = sec('Überblick',
      '<p>Dieses Dokument beschreibt die in Exchange Online Protection wirksame Schutz-Konfiguration des Tenants ' +
      '<b>' + ldEsc(data.name) + '</b> gegenüber der Best-Practice-Vorlage des M365 Security Policy Manager. ' +
      'Alle Objekte tragen das Präfix <code>BP_</code> und sind über Regeln auf die Mail-Domains des Tenants eingeschränkt. ' +
      'Grundlage ist der Ist-Zustand vom ' + dateStr + ' (live aus dem Tenant gelesen, app-only Exchange Online / Graph).</p>' +
      '<p class="note">Nicht Teil dieser Dokumentation: Defender-for-Office-Funktionen (Safe Links / Safe Attachments), Intune / OpenIntuneBaseline sowie Identitäts-/Conditional-Access-Einstellungen.</p>')

    const globals = sec('Globale Parameter',
      '<table>' +
      '<tr><th style="width:34%">Parameter</th><th>Wert</th></tr>' +
      '<tr><td class="pn">Tenant</td><td class="v">' + ldEsc(data.name) + '</td></tr>' +
      '<tr><td class="pn">Erhebung (Audit)</td><td class="v">' + dateStr + ' · ' + timeStr + ' Uhr</td></tr>' +
      '<tr><td class="pn">Soll-Domain-Quelle</td><td class="v">' + ldEsc(data.domSrc) + '</td></tr>' +
      '<tr><td class="pn">Mail-Domains (Scope)</td><td class="v">' + ldEsc((data.sollDomains || []).join(', ') || '—') + '</td></tr>' +
      '<tr><td class="pn">Admin-E-Mail</td><td class="v">' + ldEsc(g.adminEmail || '—') + '</td></tr>' +
      '<tr><td class="pn">MSP-E-Mail</td><td class="v">' + ldEsc(g.igeeksEmail || '—') + '</td></tr>' +
      '<tr><td class="pn">Konformität</td><td class="v">' + data.okCount + ' von ' + data.total + ' Prüfpunkten (' + pct + '%)' +
      (data.accepted ? ' · ' + data.accepted + ' gewollte Abweichung(en)' : '') + '</td></tr>' +
      '</table>' +
      '<p class="note">Nicht-Mail-Domains (Teams-/SBC-/Telefonie-Domains ohne Postfächer) sind aus dem Scope ausgenommen.</p>')

    const areaSections = data.groups.map(grp => {
      let extra = ''
      if (grp.title === 'Anti-Malware' && fileTypesSoll.length) {
        extra = '<p class="ft"><b>Blockierte Dateitypen (Soll, ' + fileTypesSoll.length + '):</b> <span class="mono">' + ldEsc(fileTypesSoll.join(', ')) + '</span></p>'
      }
      return sec(grp.icon + ' ' + ldEsc(grp.title),
        '<p>' + (LD_DOC_INTRO[grp.title] || '') + '</p>' + checksTable(grp) + extra)
    }).join('')

    const wanted = [], open = []
    for (const grp of data.groups) {
      for (const c of grp.checks) {
        const si = ldAuditSollIst(c)
        if (c.state === 'accepted') wanted.push({ area: grp.title, label: c.label, soll: si.soll, ist: si.ist, reason: c.reason || '' })
        else if (c.state === 'bad' || c.state === 'missing') open.push({ area: grp.title, label: c.label, soll: si.soll, ist: si.ist || c.detail })
      }
    }
    const wantedHtml = wanted.length
      ? '<table><tr><th style="width:16%">Bereich</th><th style="width:22%">Prüfpunkt</th><th style="width:17%">Soll</th><th style="width:17%">Ist</th><th>Begründung</th></tr>' +
        wanted.map(d => '<tr><td>' + ldEsc(d.area) + '</td><td class="pn">' + ldEsc(d.label) + '</td><td class="v">' + ldEsc(d.soll || '—') + '</td><td class="v">' + ldEsc(d.ist || '—') + '</td><td class="rsn2">' + ldEsc(d.reason) + '</td></tr>').join('') + '</table>'
      : '<p>Keine.</p>'
    const openHtml = open.length
      ? '<table><tr><th style="width:16%">Bereich</th><th style="width:26%">Prüfpunkt</th><th style="width:29%">Soll</th><th>Ist</th></tr>' +
        open.map(d => '<tr><td>' + ldEsc(d.area) + '</td><td class="pn">' + ldEsc(d.label) + '</td><td class="v">' + ldEsc(d.soll || '—') + '</td><td class="v">' + ldEsc(d.ist || '—') + '</td></tr>').join('') + '</table>'
      : '<p>Keine — der Tenant entspricht (abgesehen von dokumentierten gewollten Abweichungen) der Vorlage.</p>'
    const deviationsSec = sec('Abweichungen &amp; Begründungen',
      '<p>Gewollte Abweichungen sind bewusste, pro Tenant dokumentierte Entscheidungen — sie gelten nicht als Mangel. Offene Abweichungen sind nicht begründet und sollten per Deploy oder gezielt behoben werden.</p>' +
      '<h3>Gewollte Abweichungen (' + wanted.length + ')</h3>' + wantedHtml +
      '<h3>Offene Abweichungen (' + open.length + ')</h3>' + openHtml)

    const hints = sec('Hinweise zur Anwendung',
      '<ul class="plain">' +
      '<li>Alle <code>*_Rule</code>-Objekte laufen mit <code>Priority 0</code> und sind über <code>RecipientDomainIs</code> auf die Mail-Domains eingeschränkt.</li>' +
      '<li>Der <code>SpoofQuarantineTag</code> wird ausschließlich per PowerShell gesetzt (im Portal nicht wählbar).</li>' +
      '<li>Deploys sind idempotent: bestehende <code>BP_</code>-Objekte werden aktualisiert, nicht doppelt angelegt.</li>' +
      '<li>Gewollte Abweichungen werden im Tool pro Tenant gepflegt (Audit → „als gewollt markieren") und in diesem Dokument ausgewiesen.</li>' +
      '</ul>')

    return '<!DOCTYPE html><html lang="de"><head><meta charset="utf-8">' +
      '<title>Konfig-Doku ' + ldEsc(data.name) + ' — M365 Security</title>' +
      '<style>' + ldTenantDocCss() + '</style></head><body>' +
      '<button class="no-print print-btn" onclick="window.print()">📘 Als PDF speichern / Drucken</button>' +
      '<div class="page">' +
      '<div class="doc-head">' +
      '<h1>Microsoft&nbsp;365 – Schutz-Konfiguration</h1>' +
      '<p class="lead">Konfigurationsdokumentation ' + ldEsc(data.name) + ' — Best Practice, Ist-Zustand und dokumentierte Abweichungen</p>' +
      '<div class="meta">' +
      '<div><b>Erstellt am:</b> ' + dateStr + ' · ' + timeStr + ' Uhr</div>' +
      '<div><b>Quelle:</b> M365 Security Policy Manager (Live-Audit)</div>' +
      '<div><b>Konformität:</b> ' + pct + '% (' + data.okCount + '/' + data.total + ')' + (data.accepted ? ' · ' + data.accepted + ' gewollt' : '') + '</div>' +
      '<div><b>Offene Abweichungen:</b> ' + openDev + '</div>' +
      '</div>' +
      '</div>' +
      overview + globals + areaSections + deviationsSec + hints +
      '<footer>Automatisch erzeugt vom M365 Security Policy Manager · ' + dateStr + ' ' + timeStr +
      ' · Soll = Best-Practice-Vorlage, Ist = live aus dem Tenant gelesen (app-only Exchange Online / Graph).</footer>' +
      '</div></body></html>'
  }

  function ldTenantDocCss() {
    return [
      '*{box-sizing:border-box;margin:0;padding:0}',
      'html{-webkit-print-color-adjust:exact;print-color-adjust:exact}',
      'body{font-family:"Segoe UI",system-ui,-apple-system,Arial,sans-serif;color:#1a1a1a;font-size:10.5pt;line-height:1.5;background:#f2f4f7}',
      '.page{max-width:860px;margin:24px auto;background:#fff;padding:34px 38px 40px;box-shadow:0 2px 18px rgba(16,24,40,.12);border-radius:6px}',
      'h1{font-size:19pt;font-weight:700;margin:0 0 2px;letter-spacing:-0.01em}',
      '.lead{font-size:10.5pt;color:#555;margin:0 0 12px}',
      '.doc-head{border-bottom:3px solid #1a1a1a;padding-bottom:12px;margin-bottom:6px}',
      '.meta{display:grid;grid-template-columns:1fr 1fr;gap:4px 24px;font-size:9.5pt;color:#333;margin-top:8px}',
      '.meta div{border-bottom:1px solid #eee;padding:2px 0}',
      '.meta b{color:#000;font-weight:600}',
      'h2{font-size:12.5pt;font-weight:700;margin:20px 0 7px;padding-bottom:4px;border-bottom:2px solid #1a1a1a;break-after:avoid}',
      'h3{font-size:10.8pt;font-weight:700;margin:12px 0 5px;break-after:avoid}',
      'p{margin:0 0 8px}',
      'table{width:100%;border-collapse:collapse;margin:6px 0 10px;font-size:9.5pt}',
      'th,td{text-align:left;vertical-align:top;padding:5px 8px;border-bottom:1px solid #e2e2e2}',
      'th{background:#f3f3f3;font-weight:600;border-bottom:1.5px solid #bbb}',
      'tr,p,li,.note{break-inside:avoid;page-break-inside:avoid}',
      'table{break-inside:avoid;page-break-inside:avoid}',
      'thead{display:table-header-group}',
      'h1,h2,h3,h4{break-after:avoid;page-break-after:avoid;break-inside:avoid}',
      'td.pn{font-weight:600;color:#1a1a1a}',
      'td.v{font-family:Consolas,monospace;font-size:9pt;color:#202a37;word-break:break-word}',
      'code,.mono{font-family:Consolas,monospace;font-size:9.2pt;background:#f4f4f4;padding:0 3px;border-radius:2px}',
      '.mono{line-height:1.7}',
      '.note{font-size:9.3pt;color:#555;border-left:3px solid #bbb;padding:4px 10px;margin:8px 0;background:#fafafa}',
      '.section{break-inside:avoid-page}',
      'ul.plain{margin:4px 0 10px;padding-left:18px}',
      'ul.plain li{margin:2px 0}',
      '.ft{font-size:9.3pt;margin-top:2px}',
      '.st{font-weight:700;font-size:9pt;white-space:nowrap}',
      '.st.ok{color:#067647}',
      '.st.bad{color:#b42318}',
      '.st.acc{color:#3538cd}',
      '.st.info{color:#475467}',
      '.rsn{font-size:8.8pt;color:#3538cd;font-style:italic;margin-top:2px}',
      '.rsn2{font-size:9pt;color:#3538cd;font-style:italic}',
      'footer{margin-top:24px;padding-top:8px;border-top:1px solid #ccc;font-size:8.7pt;color:#777}',
      '.print-btn{position:fixed;top:16px;right:16px;z-index:9;background:#1a1a1a;color:#fff;border:none;padding:10px 16px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;box-shadow:0 3px 10px rgba(0,0,0,.3)}',
      '@media print{body{background:#fff}.no-print{display:none!important}.page{box-shadow:none;margin:0;max-width:none;border-radius:0;padding:0}}',
      '@page{size:A4;margin:16mm}'
    ].join('')
  }

  function openTenantConfigDoc() {
    if (!pdfData) return
    const html = buildTenantConfigDocHtml(pdfData, $config)
    const w = window.open('', '_blank')
    if (!w) { alert('Der Browser hat das Dokument-Fenster blockiert. Bitte Pop-ups für diese Seite erlauben und erneut „Konfig-Doku" klicken.'); return }
    w.document.open(); w.document.write(html); w.document.close()
    setTimeout(() => { try { w.focus(); w.print() } catch (e) {} }, 400)
  }

  // ---------- SPF/DKIM/DMARC-Report als PDF ----------
  function daStatusLabel(status) { return status === 'ok' ? 'OK' : status === 'warn' ? 'Teilweise' : 'Fehlt/Fehlerhaft' }

  function buildDomainAuthReportHtml(data) {
    const now = new Date()
    const dateStr = now.toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric' })
    const timeStr = now.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })
    const total = data.results.length
    const okCells = data.results.reduce((n, d) => n + (d.spf.status === 'ok' ? 1 : 0) + (d.dmarc.status === 'ok' ? 1 : 0) + (d.dkim.status === 'ok' ? 1 : 0), 0)
    const pct = total ? Math.round((okCells / (total * 3)) * 100) : 100
    const summaryCls = pct === 100 ? 'ok' : (pct < 60 ? 'bad' : 'warn')

    const row = (label, r, extra) => {
      const cls = r.status === 'ok' ? 'ok' : (r.status === 'warn' ? 'warn' : 'bad')
      const record = r.record ? '<div class="rec">' + ldEsc(r.record) + '</div>' : ''
      const issues = (r.issues && r.issues.length) ? '<ul class="iss">' + r.issues.map(i => '<li>' + ldEsc(i) + '</li>').join('') + '</ul>' : ''
      return '<tr><td class="dm-label">' + label + '</td><td class="dm-status"><span class="pill ' + cls + '">' + daStatusLabel(r.status) + '</span></td>' +
        '<td class="dm-detail">' + (extra || record || '<span class="muted">—</span>') + issues + '</td></tr>'
    }

    const sections = data.results.map(d => {
      const dkimExtra = '<div class="dkim-meta">M365: ' + (d.dkim.enabledInM365 ? 'aktiviert' : 'nicht aktiviert') +
        ' · DNS-CNAMEs: ' + (d.dkim.cnamesPublished ? 'veröffentlicht' : 'fehlen') + '</div>'
      return '<section class="dom">' +
        '<div class="dom-head">' + ldEsc(d.domain) + '</div>' +
        '<table class="dom-table">' +
        row('SPF', d.spf) +
        row('DMARC', d.dmarc) +
        row('DKIM', d.dkim, dkimExtra) +
        '</table></section>'
    }).join('')

    return '<!DOCTYPE html><html lang="de"><head><meta charset="utf-8">' +
      '<title>Mail-Authentifizierung ' + ldEsc(data.name) + ' — SPF/DKIM/DMARC</title>' +
      '<style>' + ldDomainAuthReportCss() + '</style></head><body>' +
      '<button class="no-print print-btn" onclick="window.print()">📧 Als PDF speichern / Drucken</button>' +
      '<div class="page">' +
      '<header class="rpt-head">' +
      '<div class="rpt-head-main">' +
      '<div class="rpt-kicker">M365 Security Policy Manager</div>' +
      '<h1>Mail-Authentifizierung</h1>' +
      '<div class="rpt-sub">SPF · DKIM · DMARC je Domain — inkl. Abgleich Microsoft&nbsp;365 &harr; öffentliches DNS</div>' +
      '</div>' +
      '<div class="rpt-score ' + summaryCls + '"><div class="score-num">' + pct + '%</div><div class="score-lbl">bestanden</div></div>' +
      '</header>' +
      '<div class="meta-grid">' +
      '<div class="meta-cell"><span class="meta-k">Tenant</span><span class="meta-v">' + ldEsc(data.name) + '</span></div>' +
      '<div class="meta-cell"><span class="meta-k">Erstellt am</span><span class="meta-v">' + dateStr + ' · ' + timeStr + ' Uhr</span></div>' +
      '<div class="meta-cell"><span class="meta-k">Geprüfte Domains</span><span class="meta-v">' + total + '</span></div>' +
      '</div>' +
      sections +
      '<footer class="rpt-foot">Automatisch erzeugt vom M365 Security Policy Manager · ' + dateStr + ' ' + timeStr +
      ' · SPF/DMARC per öffentlicher DNS-Abfrage, DKIM-Aktivierung per Exchange Online (Get-DkimSigningConfig) — beides zusammen deckt auch den Fall ab, dass DKIM in M365 aktiviert, aber im DNS nie veröffentlicht wurde.</footer>' +
      '</div></body></html>'
  }

  function ldDomainAuthReportCss() {
    return [
      '*{box-sizing:border-box;margin:0;padding:0}',
      'body{font-family:"Segoe UI",system-ui,-apple-system,Roboto,Helvetica,Arial,sans-serif;color:#1d2939;background:#f2f4f7;line-height:1.45;-webkit-print-color-adjust:exact;print-color-adjust:exact}',
      '.page{max-width:820px;margin:24px auto;background:#fff;padding:32px 36px 40px;box-shadow:0 2px 18px rgba(16,24,40,.12);border-radius:6px}',
      '.rpt-head{display:flex;align-items:center;justify-content:space-between;gap:20px;background:linear-gradient(120deg,#0f5132,#0891b2);color:#fff;padding:22px 26px;border-radius:10px;margin:-8px 0 22px}',
      '.rpt-kicker{font-size:9.5pt;text-transform:uppercase;letter-spacing:.06em;opacity:.85}',
      '.rpt-head h1{font-size:21pt;margin:2px 0 4px}',
      '.rpt-sub{font-size:9.8pt;opacity:.92}',
      '.rpt-score{text-align:center;background:rgba(255,255,255,.16);border-radius:10px;padding:10px 20px;min-width:96px}',
      '.rpt-score .score-num{font-size:22pt;font-weight:800;line-height:1}',
      '.rpt-score .score-lbl{font-size:8.5pt;opacity:.9;text-transform:uppercase;letter-spacing:.04em}',
      '.meta-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:20px}',
      '.meta-cell{background:#f4f7f6;border-radius:8px;padding:9px 12px}',
      '.meta-k{display:block;font-size:8pt;text-transform:uppercase;letter-spacing:.04em;color:#667085}',
      '.meta-v{display:block;font-size:10.3pt;font-weight:600;color:#101828;margin-top:1px}',
      '.dom{break-inside:avoid;page-break-inside:avoid;margin-bottom:16px}',
      '.dom-head{font-size:12.5pt;font-weight:700;color:#0f5132;font-family:Consolas,monospace;background:#eefaf3;border-radius:6px 6px 0 0;padding:8px 12px;border:1px solid #d6ead9;border-bottom:none}',
      '.dom-table{width:100%;border-collapse:collapse;border:1px solid #d6ead9;border-radius:0 0 6px 6px;overflow:hidden}',
      '.dom-table td{padding:8px 12px;border-top:1px solid #e6eeea;vertical-align:top;font-size:9.6pt}',
      '.dm-label{font-weight:700;width:70px;color:#344054}',
      '.dm-status{width:110px}',
      '.pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:8.6pt;font-weight:700}',
      '.pill.ok{background:#ecfdf3;color:#067647}',
      '.pill.warn{background:#fffaeb;color:#b54708}',
      '.pill.bad{background:#fef3f2;color:#b42318}',
      '.rec{font-family:Consolas,monospace;font-size:8.6pt;color:#344054;word-break:break-all;background:#f9fafb;border-radius:4px;padding:3px 6px;margin-bottom:3px}',
      '.dkim-meta{font-size:8.8pt;color:#475467;margin-bottom:3px}',
      '.iss{margin:2px 0 0 16px;padding:0;font-size:8.8pt;color:#b54708}',
      '.iss li{margin:1px 0}',
      '.muted{color:#98a2b3}',
      'footer.rpt-foot{margin-top:20px;padding-top:10px;border-top:1px solid #e4e7ec;font-size:8.3pt;color:#667085;line-height:1.6}',
      '.print-btn{position:fixed;top:16px;right:16px;z-index:9;background:#0f5132;color:#fff;border:none;padding:10px 16px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;box-shadow:0 3px 10px rgba(0,0,0,.3)}',
      '@media print{body{background:#fff}.no-print{display:none!important}.page{box-shadow:none;margin:0;max-width:none;border-radius:0;padding:0}.rpt-head{margin-top:0}}',
      '@page{size:A4;margin:14mm}'
    ].join('')
  }

  function openDomainAuthReport() {
    if (!daResults || !daResults.length || !$activeTenant) return
    const html = buildDomainAuthReportHtml({ name: $activeTenant.name, results: daResults })
    const w = window.open('', '_blank')
    if (!w) { alert('Der Browser hat das PDF-Fenster blockiert. Bitte Pop-ups für diese Seite erlauben und erneut „Domain-PDF" klicken.'); return }
    w.document.open(); w.document.write(html); w.document.close()
    setTimeout(() => { try { w.focus(); w.print() } catch (e) {} }, 400)
  }
</script>

<TenantContext>
  <div class="settings-group">
    <h4>🔎 Audit</h4>
    <p class="ld-section-hint">Ist-Zustand aus dem Tenant lesen und mit der Vorlage vergleichen (Soll/Ist).</p>
    <label class="checkbox-label" style="margin-bottom: 0.75rem;">
      <input type="checkbox" bind:checked={$autoDomains} />
      <span>Domains automatisch aus dem Ziel-Tenant übernehmen (Get-AcceptedDomain) — empfohlen; sonst gelten die Domains aus dem Konfigurations-Tab</span>
    </label>
    <button class="btn btn-secondary" onclick={runAudit} disabled={auditBusy}>{auditBusy ? '…' : 'Ist-Zustand prüfen'}</button>
  </div>

  {#if auditBusy}
    <div class="ld-job">
      <div class="ld-job-head"><strong>🔎 Ist-Zustand: {$activeTenant.name}</strong></div>
      <div class="ld-step running"><span class="ld-spinner"></span> Lese Policies aus dem Tenant — dauert ca. 30–60 Sekunden…</div>
    </div>
  {:else if auditError}
    <div class="ld-job"><div class="ld-banner fail">❌ {auditError}</div></div>
  {:else if auditData}
    <div class="ld-job">
      <div class="ld-job-head">
        <strong>🔎 Ist-Zustand: {$activeTenant.name}</strong>
        <span class="ld-job-meta">Soll-Domains: {domSrc}</span>
        <button class="btn btn-secondary ld-pdf-btn" onclick={openAuditPdfReport} title="Audit-Report (Soll/Ist-Checkliste) als PDF speichern">📄 Audit-PDF</button>
        <button class="btn btn-secondary ld-pdf-btn ld-pdf-btn2" onclick={openTenantConfigDoc} title="Nüchterne Konfigurations-Dokumentation des Tenants (Best Practice + Ist + gewollte Abweichungen mit Begründung) als PDF">📘 Konfig-Doku</button>
      </div>

      {#if allOk}
        <div class="ld-banner ok">✅ Ist-Zustand entspricht der Konfiguration ({okCount}/{countable.length} Checks OK).{#if acceptedCount}<span class="ld-acc-note"> · {acceptedCount} als gewollt markiert</span>{/if}</div>
      {:else}
        <div class="ld-banner warn">⚠️ {countable.length - okCount} von {countable.length} Checks weichen ab — ein Deploy bringt den Tenant auf den Soll-Zustand.{#if acceptedCount}<span class="ld-acc-note"> · {acceptedCount} als gewollt markiert</span>{/if}</div>
      {/if}

      {#each groups as grp (grp.title)}
        {@const anyBad = grp.checks.some(c => c.state === 'bad' || c.state === 'missing')}
        <div class="ld-phase" class:active={anyBad} class:complete={!anyBad}>
          <div class="ld-phase-title">{grp.icon} {grp.title}</div>
          {#each grp.checks as c}
            <div class="ld-step {clsFor[c.state]}">
              <span class="ld-ico">{#if c.state === 'loading'}<span class="ld-spinner"></span>{:else}{iconFor[c.state]}{/if}</span>
              {c.label} <small>{c.detail}</small>
              {#if c.state === 'bad' || c.state === 'missing'}
                <button class="ld-dev-btn" onclick={() => markDeviation(grp.title, c.label, 'accept')}
                        title="Diese Abweichung als bewusst/gewollt markieren (erscheint dann als ℹ️ statt ❌, auch im PDF)">als gewollt markieren</button>
              {:else if c.state === 'accepted'}
                <span class="ld-dev-reason">✋ gewollt: {c.reason || ''}</span>
                <button class="ld-dev-btn" onclick={() => markDeviation(grp.title, c.label, 'clear')}
                        title="Markierung entfernen — Check wird wieder als Abweichung gewertet">✕</button>
              {/if}
            </div>
          {/each}
        </div>
      {/each}
    </div>
  {/if}

  <div class="settings-group" style="margin-top:1.5rem;">
    <h4>📧 Mail-Authentifizierung (SPF / DKIM / DMARC)</h4>
    <p class="ld-section-hint">Prüft je Mail-Domain des Tenants das öffentliche SPF- und DMARC-TXT-Record sowie
      — kombiniert aus Exchange Online (Get-DkimSigningConfig) und öffentlichem DNS — ob DKIM wirklich signiert
      wird. Deckt speziell den Fall ab, dass DKIM in M365 als „aktiviert" gilt, die CNAME-Records beim Registrar
      aber nie gesetzt wurden.</p>
    <button class="btn btn-secondary" onclick={runDomainAuth} disabled={daBusy}>{daBusy ? '…' : 'Domains prüfen'}</button>
  </div>

  {#if daBusy}
    <div class="ld-job">
      <div class="ld-step running"><span class="ld-spinner"></span> Lese DKIM-Status aus Exchange Online und löse DNS-Records auf…</div>
    </div>
  {:else if daError}
    <div class="ld-job"><div class="ld-banner fail">❌ {daError}</div></div>
  {:else if daResults}
    <div class="ld-job">
      <div class="ld-job-head">
        <strong>📧 Mail-Authentifizierung: {$activeTenant?.name}</strong>
        <span class="ld-job-meta">{daResults.length} Domain(s)</span>
        <button class="btn btn-secondary ld-pdf-btn" onclick={openDomainAuthReport} title="SPF/DKIM/DMARC-Report als PDF speichern" disabled={!daResults.length}>📧 Domain-PDF</button>
      </div>

      {#if !daResults.length}
        <div class="ld-banner warn">⚠️ Keine Mail-Domains gefunden.</div>
      {:else}
        {#if daKpi}
          <div class="kpi-grid">
            <div class="kpi-tile"><b>{daKpi.total}</b><span>Domains geprüft</span></div>
            <div class="kpi-tile" class:ok={daKpi.spfOk === daKpi.total} class:warn={daKpi.spfOk < daKpi.total}><b>{daKpi.spfOk}/{daKpi.total}</b><span>SPF gültig</span></div>
            <div class="kpi-tile" class:ok={daKpi.dkimOk === daKpi.total} class:bad={daKpi.dkimOk < daKpi.total}><b>{daKpi.dkimOk}/{daKpi.total}</b><span>DKIM aktiv + im DNS</span></div>
            <div class="kpi-tile" class:ok={daKpi.dmarcOk === daKpi.total} class:warn={daKpi.dmarcOk < daKpi.total}><b>{daKpi.dmarcOk}/{daKpi.total}</b><span>DMARC durchgesetzt</span></div>
          </div>
        {/if}

        {#each daResults as d (d.domain)}
          <div class="ld-phase" class:active={d.spf.status !== 'ok' || d.dmarc.status !== 'ok' || d.dkim.status !== 'ok'} class:complete={d.spf.status === 'ok' && d.dmarc.status === 'ok' && d.dkim.status === 'ok'}>
            <div class="ld-phase-title">🌐 {d.domain}</div>
            {#each [['SPF', d.spf], ['DMARC', d.dmarc], ['DKIM', d.dkim]] as [label, r] (label)}
              {@const b = daBadge(r.status)}
              <div class="ld-step {b.cls === 'ok' ? 'ok' : (b.cls === 'warn' ? 'retry' : 'fail')}">
                <span class="ld-ico">{b.icon}</span>
                <strong>{label}</strong>
                {#if r.record}<small class="da-record">{r.record}</small>{/if}
                {#if label === 'DKIM'}<small>M365: {r.enabledInM365 ? 'aktiviert' : 'nicht aktiviert'} · DNS-CNAMEs: {r.cnamesPublished ? 'veröffentlicht' : 'fehlen'}</small>{/if}
                {#if r.issues && r.issues.length}
                  <div class="da-issues">{#each r.issues as iss}<div>⚠️ {iss}</div>{/each}</div>
                {/if}
              </div>
            {/each}
          </div>
        {/each}
      {/if}
    </div>
  {/if}
</TenantContext>
