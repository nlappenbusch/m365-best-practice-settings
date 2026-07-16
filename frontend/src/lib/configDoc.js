// Nuechterne Konfigurationsdokumentation der Best-Practice-VORLAGE als
// druckbares Dokument (A4, window.print -> "Als PDF speichern"). Anders als
// die Tenant-Konfig-Doku im Audit (Soll/Ist) dokumentiert dieses Dokument nur
// die Vorlage selbst — dynamisch aus dem Config-Store, damit es bei
// Vorlagen-Aenderungen (z.B. Bulk-Aktion) automatisch aktuell bleibt.

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}
function onOff(v) { return v ? 'On' : 'Off' }
function psBool(v) { return v ? '$true' : '$false' }

const ASF_ROWS = [
  ['bizInfoUrls', 'IncreaseScoreWithBizOrInfoUrls', 'URLs zu .biz/.info'],
  ['numericIpUrls', 'IncreaseScoreWithNumericIps', 'Numerische IP in URL'],
  ['urlRedirect', 'IncreaseScoreWithRedirectToOtherPort', 'URL-Redirect zu anderem Port'],
  ['emptyMessages', 'MarkAsSpamEmptyMessages', 'Leere Nachrichten'],
  ['jsVbScript', 'MarkAsSpamJavaScriptInHtml', 'JavaScript/VBScript in HTML'],
  ['frameIframe', 'MarkAsSpamFramesInHtml', 'Frame/IFrame-Tags'],
  ['sensitiveWords', 'MarkAsSpamSensitiveWordList', 'Sensible Wörter'],
  ['spfHardFail', 'MarkAsSpamSpfRecordHardFail', 'SPF Hard Fail'],
  ['backscatter', 'MarkAsSpamFromAddressAuthFail', 'Backscatter / From-Auth-Fail']
]

export function buildConfigDocHtml(config) {
  const g = config.global, ap = config.antiPhishing, as = config.antiSpam, am = config.antiMalware
  const now = new Date()
  const dateStr = now.toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric' })
  const fileTypes = String(am.customFileTypes || '').split(',').map(t => t.trim().replace(/^\.+/, '')).filter(Boolean)
  const asfOnCount = ASF_ROWS.filter(([k]) => as[k]).length
  const bulkJunk = as.bulkAction === 'MoveToJmf'

  const row3 = (p, v, b) => '<tr><td class="p">' + esc(p) + '</td><td class="v">' + esc(v) + '</td><td>' + b + '</td></tr>'
  const row2 = (p, v) => '<tr><td class="p">' + esc(p) + '</td><td class="v">' + esc(v) + '</td></tr>'

  return `<!DOCTYPE html><html lang="de"><head><meta charset="utf-8">
<title>M365 Best-Practice-Konfiguration – Dokumentation</title>
<style>${docCss()}</style></head><body>
<button class="no-print print-btn" onclick="window.print()">📘 Als PDF speichern / Drucken</button>
<div class="page">

<div class="doc-head">
  <h1>Microsoft&nbsp;365 – Best-Practice-Konfiguration</h1>
  <p class="lead">Konfigurationsdokumentation der Exchange-Online-Schutzrichtlinien (Vorlagenstand)</p>
  <div class="meta">
    <div><b>Erstellt am:</b> ${dateStr}</div>
    <div><b>Quelle:</b> M365 Security Policy Manager – Best-Practice-Vorlage</div>
    <div><b>Geltungsbereich:</b> Exchange Online Protection (EOP), tenant-unabhängig</div>
    <div><b>Dokumenttyp:</b> Interne Referenz</div>
  </div>
</div>

<div class="section">
<h2>1&nbsp;&nbsp;Überblick</h2>
<p>Dieses Dokument beschreibt die Best-Practice-Vorlage, die der M365 Security Policy Manager pro Tenant
in Exchange Online Protection ausrollt. Alle Objekte werden mit dem Präfix <code>BP_</code> angelegt und
über zugehörige Regeln auf die Mail-Domains des Tenants eingeschränkt. Werte sind Vorgaben der Vorlage;
tenant-spezifische Angaben (Domains, Empfänger) werden beim Deploy gesetzt. Bewusste Kundenabweichungen
werden pro Tenant im Tool als „gewollte Abweichung" mit Begründung dokumentiert.</p>
<p><b>Angelegte Objekte:</b></p>
<ul class="plain">
  <li><code>BP_Quarantine-SelfReleaseNotification</code>, <code>BP_Quarantine-RequestReleaseNotification</code> — Quarantäne-Richtlinien</li>
  <li><code>BP_AntiPhishing</code> + <code>BP_AntiPhishing_Rule</code> — Anti-Phishing</li>
  <li><code>BP_AntiSpam_Inbound</code> + <code>BP_AntiSpam_Inbound_Rule</code> — Anti-Spam (eingehend)</li>
  <li><code>BP_AntiMalware</code> + <code>BP_AntiMalware_Rule</code> — Anti-Malware</li>
  <li><code>BP_UserRequestReleaseStatus</code> — Warnungsrichtlinie (Security &amp; Compliance)</li>
</ul>
<p class="note">Nicht Teil dieser Vorlage: Defender-for-Office-Funktionen (Safe Links / Safe Attachments),
Intune / OpenIntuneBaseline sowie Identitäts-/Conditional-Access-Einstellungen.</p>
</div>

<div class="section">
<h2>2&nbsp;&nbsp;Globale Parameter <span class="obj">(pro Tenant gesetzt)</span></h2>
<table>
  <tr><th style="width:34%">Parameter</th><th style="width:30%">Vorlagenwert / Herkunft</th><th>Verwendung</th></tr>
  ${row3('Accepted Domains', 'Get-AcceptedDomain (auto)', 'Empfänger-Scope aller <code>*_Rule</code>-Objekte; Nicht-Mail-Domains (Teams-/SBC-/Telefonie) werden automatisch ausgefiltert.')}
  ${row3('Admin-E-Mail', g.adminEmail || '(pro Tenant)', 'Empfänger der Malware-Admin-Benachrichtigung und der Warnungsrichtlinie.')}
  ${row3('MSP-E-Mail', g.igeeksEmail || '(pro Tenant)', 'Zweiter Empfänger der Warnungsrichtlinie (Betrieb/Monitoring).')}
</table>
</div>

<div class="section">
<h2>3&nbsp;&nbsp;Quarantäne-Richtlinien</h2>
<p>Zwei Endnutzer-Quarantäne-Richtlinien mit aktivierter Quarantäne-Benachrichtigung (ESN). Die
Berechtigungswerte kodieren die im Portal wählbaren Aktionen.</p>
<table>
  <tr><th style="width:24%">Richtlinie</th><th style="width:10%">ESN</th><th style="width:26%">Berechtigungen</th><th>Zweck / Besonderheit</th></tr>
  <tr>
    <td class="p">BP_Quarantine-<br>SelfReleaseNotification</td>
    <td class="v">Ein</td>
    <td class="v">59 = AllowSender + BlockSender + RequestRelease + Preview + Delete</td>
    <td>Standard-Tag für Spam/Spoof/Phishing. Endnutzer darf selbst freigeben. Benachrichtigung schließt Nachrichten blockierter Absender ein (<code>IncludeMessagesFromBlockedSenderAddress = true</code>).</td>
  </tr>
  <tr>
    <td class="p">BP_Quarantine-<br>RequestReleaseNotification</td>
    <td class="v">Ein</td>
    <td class="v">26 = BlockSender + RequestRelease + Preview</td>
    <td>Für höher eingestufte Nachrichten (High-Confidence-Phishing, Malware). Keine Selbst-Freigabe, nur Freigabe-Anfrage. Ohne Nachrichten blockierter Absender (<code>= false</code>).</td>
  </tr>
</table>
</div>

<div class="section">
<h2>4&nbsp;&nbsp;Anti-Phishing <span class="obj">BP_AntiPhishing</span></h2>
<table>
  <tr><th style="width:40%">Parameter (Set-AntiPhishPolicy)</th><th style="width:16%">Wert</th><th>Bedeutung</th></tr>
  ${row3('Enabled', '$true', 'Richtlinie aktiv.')}
  ${row3('EnableSpoofIntelligence', psBool(ap.spoofIntelligence), 'Spoof-Erkennung.')}
  ${row3('EnableFirstContactSafetyTips', psBool(ap.firstContactTip), 'Hinweis bei Erstkontakt-Absendern.')}
  ${row3('EnableUnauthenticatedSender', psBool(ap.unauthSenderSymbol), '„?"-Symbol bei nicht authentifizierten Absendern.')}
  ${row3('EnableViaTag', psBool(ap.viaTag), '„via"-Kennzeichnung im Absender.')}
  ${row3('HonorDmarcPolicy', psBool(ap.honorDmarc), 'DMARC-Richtlinie des Absenders wird beachtet.')}
  ${row3('DmarcQuarantineAction', ap.dmarcQuarantineAction, 'Aktion bei DMARC <code>p=quarantine</code>.')}
  ${row3('DmarcRejectAction', ap.dmarcRejectAction, 'Aktion bei DMARC <code>p=reject</code>.')}
  ${row3('AuthenticationFailAction', ap.spoofAction, 'Aktion bei Spoof (Auth-Fehler).')}
  ${row3('SpoofQuarantineTag', 'BP_Quarantine-SelfReleaseNotification', 'Quarantäne-Tag für Spoof-Treffer (nur per PowerShell setzbar – Portal-Limitierung).')}
</table>
<p><b>Regel <span class="mono">BP_AntiPhishing_Rule</span>:</b> <code>RecipientDomainIs</code> = Mail-Domains des Tenants, <code>Priority 0</code>.</p>
</div>

<div class="section">
<h2>5&nbsp;&nbsp;Anti-Spam (eingehend) <span class="obj">BP_AntiSpam_Inbound</span></h2>
<h3>5.1&nbsp;&nbsp;Verdict-Aktionen &amp; Kernparameter</h3>
<table>
  <tr><th style="width:40%">Parameter (Set-HostedContentFilterPolicy)</th><th style="width:22%">Wert</th><th>Bedeutung</th></tr>
  ${row3('SpamAction', as.spamAction, 'Aktion für Spam.')}
  ${row3('HighConfidenceSpamAction', as.highConfSpamAction, 'Aktion für High-Confidence-Spam.')}
  ${row3('BulkSpamAction', as.bulkAction, bulkJunk
    ? 'Massen-/Bulk-Mail (Graymail/Newsletter) → Junk-Ordner; hält die Quarantäne-Benachrichtigung sauber.'
    : 'Aktion für Massen-/Bulk-Mail.')}
  ${row3('PhishSpamAction', as.phishAction, 'Aktion für Phishing.')}
  ${row3('HighConfidencePhishAction', as.highConfPhishAction, 'Aktion für High-Confidence-Phishing.')}
  ${row3('BulkThreshold', as.bulkThreshold, 'Bulk-Schwellenwert (BCL).')}
  ${row3('QuarantineRetentionPeriod', '30', 'Aufbewahrung in Quarantäne (Tage).')}
  ${row3('EnableEndUserSpamNotifications', '$true', 'Endnutzer-Quarantäne-Benachrichtigung.')}
  ${row3('EndUserSpamNotificationFrequency', '1', 'Benachrichtigungsintervall (Tage).')}
  ${row3('InlineSafetyTipsEnabled', '$true', 'Sicherheitshinweise in der Nachricht.')}
</table>
<h3>5.2&nbsp;&nbsp;Quarantäne-Tags je Verdict</h3>
<table>
  <tr><th style="width:50%">Verdict</th><th>Quarantäne-Tag</th></tr>
  ${row2('Spam / High-Conf-Spam / Phishing', 'BP_Quarantine-SelfReleaseNotification')}
  <tr><td>Bulk</td><td class="v">BP_Quarantine-SelfReleaseNotification <span class="dim">${bulkJunk ? '(gesetzt; wirksam nur, falls die Bulk-Aktion abweichend auf Quarantine steht)' : ''}</span></td></tr>
  ${row2('High-Confidence-Phishing', 'BP_Quarantine-RequestReleaseNotification')}
</table>
${bulkJunk ? '<p class="note">Kunden, die bewusst nur Inbox und Quarantäne wollen (kein Junk-Ordner als dritter Ort), stellen die Bulk-Aktion auf <code>Quarantine</code> — im Tool als <b>gewollte Abweichung</b> pro Tenant dokumentiert.</p>' : ''}
<h3>5.3&nbsp;&nbsp;Erweiterte Spam-Filter (ASF)</h3>
<p>${asfOnCount === 0
    ? 'Alle neun Legacy-ASF-Filter stehen bewusst auf <b>Off</b> – entspricht der Microsoft-Empfehlung: sie übersteuern ARC/Composite-Authentication, erzeugen False Positives (z.B. SPF Hard Fail hinter Verschlüsselungs-Gateways, Sensible Wörter bei Medizin-/Finanzkorrespondenz) und ASF-Treffer sind bei Microsoft nicht als False Positive meldbar.'
    : '<b>Achtung:</b> ' + asfOnCount + ' von 9 ASF-Filtern sind in der Vorlage aktiviert. Microsoft empfiehlt Off – nur gezielt und mit klarem Grund aktivieren.'}</p>
<table>
  <tr><th style="width:45%">Parameter</th><th style="width:20%">Wert</th><th>Filter</th></tr>
  ${ASF_ROWS.map(([k, psName, label]) => row3(psName, onOff(as[k]), label)).join('\n  ')}
</table>
<p><b>Regel <span class="mono">BP_AntiSpam_Inbound_Rule</span>:</b> <code>RecipientDomainIs</code> = Mail-Domains des Tenants, <code>Priority 0</code>.</p>
</div>

<div class="section">
<h2>6&nbsp;&nbsp;Anti-Malware <span class="obj">BP_AntiMalware</span></h2>
<table>
  <tr><th style="width:40%">Parameter (Set-MalwareFilterPolicy)</th><th style="width:22%">Wert</th><th>Bedeutung</th></tr>
  ${row3('EnableFileFilter', psBool(am.commonAttachFilter), 'Anhangs-Filter (Common Attachment Filter).')}
  ${row3('ZapEnabled', psBool(am.zapMalware), 'Zero-Hour Auto Purge für bereits zugestellte Malware.')}
  ${row3('EnableInternal/ExternalSenderAdminNotifications', '$true', 'Admin-Benachrichtigung bei internem/externem Absender.')}
  ${row3('Internal/ExternalSenderAdminAddress', g.adminEmail || '(pro Tenant)', 'Empfänger der Benachrichtigung.')}
  ${row3('QuarantineTag', 'BP_Quarantine-RequestReleaseNotification', 'Malware-Treffer → Quarantäne mit Freigabe-Anfrage.')}
</table>
<h3>6.1&nbsp;&nbsp;Blockierte Dateitypen (${fileTypes.length})</h3>
<div class="filetypes">${fileTypes.map(t => '<span>' + esc(t) + '</span>').join('')}</div>
<p class="note">Dateitypen werden ohne führenden Punkt gespeichert (Exchange ergänzt ihn selbst) – so wird
z.&nbsp;B. aus <code>.exe</code> nicht <code>..exe</code>.</p>
<p><b>Regel <span class="mono">BP_AntiMalware_Rule</span>:</b> <code>RecipientDomainIs</code> = Mail-Domains des Tenants, <code>Priority 0</code>.</p>
</div>

<div class="section">
<h2>7&nbsp;&nbsp;Warnungsrichtlinie <span class="obj">BP_UserRequestReleaseStatus</span></h2>
<p>Eigene Warnungsrichtlinie (Security &amp; Compliance PowerShell), da die eingebaute Microsoft-Richtlinie
schreibgeschützt ist. Meldet Freigabe-Anfragen aus der Quarantäne an Admin und MSP.</p>
<table>
  <tr><th style="width:32%">Parameter (New-ProtectionAlert)</th><th>Wert</th></tr>
  ${row2('Category', 'ThreatManagement')}
  ${row2('ThreatType', 'Activity')}
  ${row2('Operation', 'QuarantineRequestReleaseMessage')}
  ${row2('Severity', 'Low')}
  ${row2('AggregationType', 'None')}
  ${row2('NotifyUser', [g.adminEmail, g.igeeksEmail].filter(Boolean).join(', ') || '(pro Tenant)')}
</table>
<p class="note">Warnungsrichtlinien setzen ggf. Office 365 E5 bzw. Defender for Office 365 P2 voraus.</p>
</div>

<div class="section">
<h2>8&nbsp;&nbsp;Hinweise zur Anwendung</h2>
<ul class="plain">
  <li>Alle <code>*_Rule</code>-Objekte laufen mit <code>Priority 0</code> und sind über <code>RecipientDomainIs</code> auf die Mail-Domains des Tenants eingeschränkt (Nicht-Mail-Domains werden ausgefiltert).</li>
  <li>Der <code>SpoofQuarantineTag</code> wird ausschließlich per PowerShell gesetzt (im Portal nicht wählbar).</li>
  <li>Quarantäne-Richtlinien und Warnungsrichtlinie müssen vor den referenzierenden Policies existieren; das Deploy legt sie in dieser Reihenfolge an.</li>
  <li>Idempotent: bestehende <code>BP_</code>-Objekte werden aktualisiert (<code>Set-*</code>), nicht doppelt angelegt.</li>
  <li>Bewusste Kundenabweichungen (z.&nbsp;B. Bulk in die Quarantäne statt Junk) werden pro Tenant im Audit als gewollte Abweichung markiert und in der Tenant-Konfig-Doku ausgewiesen.</li>
</ul>
</div>

<footer>
Erstellt aus der aktuellen Best-Practice-Vorlage des M365 Security Policy Manager · Stand ${dateStr} ·
Werte tenant-unabhängig; Domains und Empfänger werden pro Tenant gesetzt.
</footer>

</div></body></html>`
}

function docCss() {
  return `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: "Segoe UI", system-ui, -apple-system, Arial, sans-serif; color: #1a1a1a; font-size: 10.5pt; line-height: 1.5; background: #f2f4f7; }
  .page { max-width: 860px; margin: 24px auto; background: #fff; padding: 34px 38px 40px; box-shadow: 0 2px 18px rgba(16,24,40,.12); border-radius: 6px; }
  h1 { font-size: 20pt; font-weight: 700; margin: 0 0 2px; letter-spacing: -0.01em; }
  .lead { font-size: 10.5pt; color: #555; margin: 0 0 14px; }
  h2 { font-size: 13pt; font-weight: 700; margin: 22px 0 8px; padding-bottom: 4px; border-bottom: 2px solid #1a1a1a; break-after: avoid; }
  h2 .obj { font-family: Consolas, monospace; font-size: 10.5pt; font-weight: 600; color: #444; }
  h3 { font-size: 11pt; font-weight: 700; margin: 16px 0 6px; break-after: avoid; }
  p { margin: 0 0 8px; }
  .doc-head { border-bottom: 3px solid #1a1a1a; padding-bottom: 12px; margin-bottom: 4px; }
  .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 24px; font-size: 9.5pt; color: #333; margin-top: 10px; }
  .meta div { border-bottom: 1px solid #eee; padding: 2px 0; }
  .meta b { color: #000; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; margin: 6px 0 10px; font-size: 9.7pt; }
  th, td { text-align: left; vertical-align: top; padding: 5px 8px; border-bottom: 1px solid #e2e2e2; }
  th { background: #f3f3f3; font-weight: 600; border-bottom: 1.5px solid #bbb; }
  tr { break-inside: avoid; }
  td.p { font-family: Consolas, monospace; font-size: 9.2pt; color: #202a37; }
  td.v { font-family: Consolas, monospace; font-size: 9.2pt; font-weight: 600; }
  .dim { color: #777; font-weight: 400; font-family: "Segoe UI", sans-serif; font-size: 9pt; }
  code, .mono { font-family: Consolas, monospace; font-size: 9.4pt; background: #f4f4f4; padding: 0 3px; border-radius: 2px; }
  .note { font-size: 9.3pt; color: #555; border-left: 3px solid #bbb; padding: 4px 10px; margin: 8px 0; background: #fafafa; }
  .section { break-inside: avoid-page; }
  ul.plain { margin: 4px 0 10px; padding-left: 18px; }
  ul.plain li { margin: 2px 0; }
  .filetypes { font-family: Consolas, monospace; font-size: 9.1pt; line-height: 1.7; color: #202a37; }
  .filetypes span { display: inline-block; background: #f4f4f4; border: 1px solid #e2e2e2; border-radius: 3px; padding: 0 5px; margin: 0 3px 3px 0; }
  footer { margin-top: 26px; padding-top: 8px; border-top: 1px solid #ccc; font-size: 8.7pt; color: #777; }
  .print-btn { position: fixed; top: 16px; right: 16px; z-index: 9; background: #1a1a1a; color: #fff; border: none; padding: 10px 16px; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; box-shadow: 0 3px 10px rgba(0,0,0,.3); }
  @media print { body { background: #fff; } .no-print { display: none !important; } .page { box-shadow: none; margin: 0; max-width: none; border-radius: 0; padding: 0; } }
  @page { size: A4; margin: 16mm; }
  `
}

/** Oeffnet die Doku in einem neuen Tab und startet den Druckdialog. */
export function openConfigDoc(config) {
  const html = buildConfigDocHtml(config)
  const w = window.open('', '_blank')
  if (!w) {
    alert('Der Browser hat das Dokument-Fenster blockiert. Bitte Pop-ups für diese Seite erlauben und erneut klicken.')
    return
  }
  w.document.open()
  w.document.write(html)
  w.document.close()
  setTimeout(() => { try { w.focus(); w.print() } catch (e) { /* egal */ } }, 400)
}
