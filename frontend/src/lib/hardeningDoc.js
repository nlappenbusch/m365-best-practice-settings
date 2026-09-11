/**
 * Tenant-Härtung als Audit-Dokument (druckoptimiertes HTML, kein PDF-Lib —
 * der Browser druckt es nach PDF, genau wie Audit- und Konfig-Doku).
 *
 * Deckt alle vier Blöcke des Härtungs-Tabs ab, nicht nur die
 * authorizationPolicy: Entra-Grundeinstellungen, Gastzugriff,
 * Geräteregistrierung und Intune-Registrierungseinschränkungen. Jeder Punkt
 * steht mit Soll, Ist, Status und Begründung da — ein Bericht, den man einem
 * Kunden hinlegen kann, statt eines Screenshots aus dem Tab.
 *
 * Stil bewusst identisch zur Konfig-Doku (gleiche Schrift, gleiche Tabellen),
 * damit beide Dokumente nebeneinander wie aus einem Haus aussehen.
 */

function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function jaNein(v) {
  return v === true ? 'ja' : (v === false ? 'nein' : '—')
}

function statusCell(konform) {
  if (konform === null || konform === undefined) return '<span class="st info">nicht lesbar</span>'
  return konform ? '<span class="st ok">✓ konform</span>' : '<span class="st bad">✗ Abweichung</span>'
}

function table(head, rows) {
  return '<table><thead><tr>' + head.map(h => '<th>' + esc(h.label) +
    (h.width ? '' : '') + '</th>').join('') + '</tr></thead><tbody>' +
    rows.join('') + '</tbody></table>'
}

/**
 * @param {object} d  { tenantName, hard, score, dev, enroll, hardError, devError, enrollError }
 */
export function buildHardeningDocHtml(d) {
  const now = new Date()
  const dateStr = now.toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric' })
  const timeStr = now.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })

  const hard = d.hard || null
  const sc = d.score || null
  const dev = d.dev || null
  const enroll = Array.isArray(d.enroll) ? d.enroll : []

  // Offene Punkte sammeln, während die Abschnitte gebaut werden — die
  // Zusammenfassung am Ende soll denselben Stand zeigen wie die Tabellen.
  const offen = []

  let n = 0
  const sec = (title, body) => { n++; return '<div class="section"><h2>' + n + '&nbsp;&nbsp;' + esc(title) + '</h2>' + body + '</div>' }

  // ---------------------------------------------------------------- Überblick
  const konformStr = sc ? (sc.konform + ' von ' + sc.gesamt) : '—'
  const pct = sc && sc.gesamt ? Math.round((sc.konform / sc.gesamt) * 100) : null

  const overview = sec('Überblick',
    '<p>Dieses Dokument hält den Ist-Zustand der tenantweiten Grundeinstellungen von ' +
    '<b>' + esc(d.tenantName || '—') + '</b> gegenüber der Best-Practice-Vorgabe fest. ' +
    'Es betrifft Einstellungen, die für den gesamten Tenant gelten und unabhängig von einzelnen ' +
    'Benutzern oder Geräten wirken — wer sich selbst registrieren darf, wer Anwendungen anlegen kann, ' +
    'was Gäste sehen und wer Geräte aufnehmen darf.</p>' +
    '<table><tr><th style="width:34%">Angabe</th><th>Wert</th></tr>' +
    '<tr><td class="pn">Tenant</td><td class="v">' + esc(d.tenantName || '—') + '</td></tr>' +
    '<tr><td class="pn">Erhebung</td><td class="v">' + dateStr + ' · ' + timeStr + ' Uhr</td></tr>' +
    '<tr><td class="pn">Auf Sollwert</td><td class="v">' + konformStr +
    (pct === null ? '' : ' (' + pct + '%)') + '</td></tr>' +
    '</table>' +
    '<p class="note">Gelesen wird app-only über Microsoft Graph. Einstellungen, die das Tool bewusst ' +
    'nicht selbst umschaltet, sind als solche gekennzeichnet und im Portal zu ändern.</p>')

  // ---------------------------------------- Entra-Grundeinstellungen (Schalter)
  let switchesSec
  if (d.hardError) {
    switchesSec = sec('Entra-Grundeinstellungen', '<p class="note">Nicht lesbar: ' + esc(d.hardError) + '</p>')
  } else if (!hard) {
    switchesSec = sec('Entra-Grundeinstellungen', '<p class="note">Keine Daten erhoben.</p>')
  } else {
    const rows = (hard.switches || []).map(s => {
      if (s.konform === false) offen.push({ bereich: 'Entra-Grundeinstellungen', punkt: s.label, soll: jaNein(s.soll), ist: jaNein(s.ist) })
      return '<tr><td class="pn">' + esc(s.label) +
        (s.kritisch ? '<div class="hint">Wird vom Tool bewusst nicht umgeschaltet — im Portal ändern' +
          (s.portal ? ': ' + esc(s.portal) : '') + '.</div>' : '') +
        '</td>' +
        '<td class="v">' + jaNein(s.soll) + '</td>' +
        '<td class="v">' + jaNein(s.ist) + '</td>' +
        '<td>' + statusCell(s.konform) + '</td>' +
        '<td class="why">' + esc(s.warum || '') + '</td></tr>'
    }).join('')
    switchesSec = sec('Entra-Grundeinstellungen',
      '<p>Schalter der Autorisierungsrichtlinie des Tenants. Sie wirken für alle Benutzer gleichzeitig; ' +
      'eine Abweichung hier lässt sich nicht durch eine Richtlinie für einzelne Gruppen ausgleichen.</p>' +
      '<table><thead><tr><th style="width:30%">Einstellung</th><th style="width:8%">Soll</th>' +
      '<th style="width:8%">Ist</th><th style="width:14%">Status</th><th>Warum</th></tr></thead><tbody>' +
      rows + '</tbody></table>')
  }

  // ---------------------------------------------------------------- Gastzugriff
  let guestSec = ''
  if (hard && hard.guest && hard.invites) {
    if (!hard.guest.konform) offen.push({ bereich: 'Gastzugriff', punkt: 'Gastberechtigungen', soll: 'Eingeschränkt (restriktivste Stufe)', ist: hard.guest.label })
    if (!hard.invites.konform) offen.push({ bereich: 'Gastzugriff', punkt: 'Wer darf Gäste einladen', soll: 'Nur Administratoren und Gasteinlader', ist: hard.invites.label })
    guestSec = sec('Gastzugriff',
      '<p>Gäste sind Konten aus fremden Verzeichnissen. Zwei Fragen entscheiden über das Risiko: ' +
      'was ein Gast im Verzeichnis sehen kann, und wer überhaupt Gäste hereinholen darf.</p>' +
      '<table><thead><tr><th style="width:30%">Einstellung</th><th style="width:26%">Soll</th>' +
      '<th style="width:26%">Ist</th><th>Status</th></tr></thead><tbody>' +
      '<tr><td class="pn">Gastberechtigungen</td><td class="v">Eingeschränkt (restriktivste Stufe)</td>' +
      '<td class="v">' + esc(hard.guest.label) + '</td><td>' + statusCell(hard.guest.konform) + '</td></tr>' +
      '<tr><td class="pn">Wer darf Gäste einladen</td><td class="v">Nur Administratoren und Gasteinlader</td>' +
      '<td class="v">' + esc(hard.invites.label) + '</td><td>' + statusCell(hard.invites.konform) + '</td></tr>' +
      '</tbody></table>')
  }

  // ------------------------------------------------------- Geräteregistrierung
  let devSec
  if (d.devError) {
    devSec = sec('Geräteregistrierung', '<p class="note">Nicht lesbar: ' + esc(d.devError) + '</p>')
  } else if (!dev) {
    devSec = sec('Geräteregistrierung', '<p class="note">Keine Daten erhoben.</p>')
  } else {
    const quota = dev.userDeviceQuota
    devSec = sec('Geräteregistrierung',
      '<p>Wer Geräte in den Tenant aufnehmen darf und wer darauf lokaler Administrator wird. ' +
      'Der Standardwert von Microsoft erlaubt jedem Benutzer beides.</p>' +
      '<table><thead><tr><th style="width:36%">Einstellung</th><th style="width:34%">Ist</th><th>Anmerkung</th></tr></thead><tbody>' +
      '<tr><td class="pn">Wer darf Geräte aufnehmen</td><td class="v">' + esc(dev.joinAllowed || '—') + '</td>' +
      '<td class="why">Sollte auf ausgewählte Gruppen eingeschränkt sein, nicht auf alle Benutzer.</td></tr>' +
      '<tr><td class="pn">Globale Administratoren als lokale Admins</td><td class="v">' + jaNein(dev.localAdminsGlobalAdmins) + '</td>' +
      '<td class="why">Betrifft jedes aufgenommene Gerät.</td></tr>' +
      '<tr><td class="pn">Registrierender Benutzer wird lokaler Admin</td><td class="v">' + esc(dev.localAdminsRegisteringUsers || '—') + '</td>' +
      '<td class="why">Wer sein Gerät selbst aufnimmt, ist sonst Administrator darauf.</td></tr>' +
      '<tr><td class="pn">Geräte pro Benutzer</td><td class="v">' + (quota === null || quota === undefined ? '—' : esc(quota)) + '</td>' +
      '<td class="why">Begrenzt, wie viele Geräte ein Konto aufnehmen kann.</td></tr>' +
      '<tr><td class="pn">Windows LAPS aktiv</td><td class="v">' + jaNein(dev.lapsEnabled) + '</td>' +
      '<td class="why">Verwaltet das lokale Administratorkennwort je Gerät.</td></tr>' +
      '</tbody></table>')
  }

  // -------------------------------------------- Registrierungseinschränkungen
  let enrollSec
  if (d.enrollError) {
    enrollSec = sec('Registrierungseinschränkungen (Intune)', '<p class="note">Nicht lesbar: ' + esc(d.enrollError) + '</p>')
  } else if (!enroll.length) {
    enrollSec = sec('Registrierungseinschränkungen (Intune)', '<p class="note">Keine Richtlinien gefunden.</p>')
  } else {
    const rows = enroll.map(it => {
      if (!it.personalDeviceEnrollmentBlocked) {
        offen.push({ bereich: 'Registrierungseinschränkungen', punkt: it.displayName, soll: 'private Geräte gesperrt', ist: 'erlaubt' })
      }
      return '<tr><td class="pn">' + esc(it.displayName) +
        (it.istStandard ? ' <span class="tag">Standard</span>' : '') + '</td>' +
        '<td class="v">' + (it.personalDeviceEnrollmentBlocked ? 'gesperrt' : 'erlaubt') + '</td>' +
        '<td>' + statusCell(!!it.personalDeviceEnrollmentBlocked) + '</td>' +
        '<td class="v">' + esc(it.osMinimumVersion || '—') + '</td></tr>'
    }).join('')
    enrollSec = sec('Registrierungseinschränkungen (Intune)',
      '<p>Steuert, ob private Geräte in die Verwaltung aufgenommen werden dürfen. In einem ' +
      'verwalteten Tenant sollen nur beschaffte Geräte aufgenommen werden.</p>' +
      '<table><thead><tr><th style="width:38%">Richtlinie</th><th style="width:18%">Private Geräte</th>' +
      '<th style="width:20%">Status</th><th>Mindest-OS</th></tr></thead><tbody>' + rows + '</tbody></table>')
  }

  // ------------------------------------------------------------- Offene Punkte
  const offenHtml = offen.length
    ? '<table><thead><tr><th style="width:24%">Bereich</th><th style="width:30%">Punkt</th>' +
      '<th style="width:23%">Soll</th><th>Ist</th></tr></thead><tbody>' +
      offen.map(o => '<tr><td>' + esc(o.bereich) + '</td><td class="pn">' + esc(o.punkt) + '</td>' +
        '<td class="v">' + esc(o.soll) + '</td><td class="v">' + esc(o.ist) + '</td></tr>').join('') +
      '</tbody></table>'
    : '<p>Keine — alle erhobenen Punkte stehen auf dem Sollwert.</p>'
  const offenSec = sec('Offene Punkte (' + offen.length + ')',
    '<p>Zusammenfassung der Abweichungen aus den Abschnitten oben. Punkte, die das Tool bewusst ' +
    'nicht selbst umschaltet, sind im jeweiligen Abschnitt als solche vermerkt und im Portal zu ändern.</p>' +
    offenHtml)

  return '<!DOCTYPE html><html lang="de"><head><meta charset="utf-8">' +
    '<title>Tenant-Härtung ' + esc(d.tenantName || '') + '</title>' +
    '<style>' + css() + '</style></head><body>' +
    '<button class="no-print print-btn" onclick="window.print()">Als PDF speichern / Drucken</button>' +
    '<div class="page">' +
    '<div class="doc-head"><h1>Tenant-Härtung</h1>' +
    '<p class="lead">Ist-Zustand der tenantweiten Grundeinstellungen · ' + esc(d.tenantName || '') + '</p></div>' +
    overview + switchesSec + guestSec + devSec + enrollSec + offenSec +
    '</div></body></html>'
}

function css() {
  return [
    '*{box-sizing:border-box;margin:0;padding:0}',
    'html{-webkit-print-color-adjust:exact;print-color-adjust:exact}',
    'body{font-family:"Segoe UI",system-ui,-apple-system,Arial,sans-serif;color:#1a1a1a;font-size:10.5pt;line-height:1.5;background:#f2f4f7}',
    '.page{max-width:860px;margin:24px auto;background:#fff;padding:34px 38px 40px;box-shadow:0 2px 18px rgba(16,24,40,.12);border-radius:6px}',
    'h1{font-size:19pt;font-weight:700;margin:0 0 2px;letter-spacing:-0.01em}',
    '.lead{font-size:10.5pt;color:#555;margin:0 0 12px}',
    '.doc-head{border-bottom:3px solid #1a1a1a;padding-bottom:12px;margin-bottom:6px}',
    'h2{font-size:12.5pt;font-weight:700;margin:20px 0 7px;padding-bottom:4px;border-bottom:2px solid #1a1a1a;break-after:avoid}',
    'p{margin:0 0 8px}',
    'table{width:100%;border-collapse:collapse;margin:6px 0 10px;font-size:9.5pt;break-inside:avoid;page-break-inside:avoid}',
    'th,td{text-align:left;vertical-align:top;padding:5px 8px;border-bottom:1px solid #e2e2e2}',
    'th{background:#f3f3f3;font-weight:600;border-bottom:1.5px solid #bbb}',
    'thead{display:table-header-group}',
    'tr,p,li,.note{break-inside:avoid;page-break-inside:avoid}',
    'h1,h2{break-after:avoid;page-break-after:avoid;break-inside:avoid}',
    'td.pn{font-weight:600;color:#1a1a1a}',
    'td.v{font-family:Consolas,monospace;font-size:9pt;color:#202a37;word-break:break-word}',
    'td.why{font-size:9pt;color:#555}',
    '.hint{font-size:8.8pt;color:#8a6d00;font-weight:400;margin-top:2px}',
    '.tag{font-size:8.5pt;background:#eef2f6;color:#334;padding:1px 5px;border-radius:3px;font-weight:600}',
    '.st{font-size:9pt;font-weight:600;white-space:nowrap}',
    '.st.ok{color:#0a7a3d}', '.st.bad{color:#b42318}', '.st.info{color:#666}',
    '.note{font-size:9.3pt;color:#555;border-left:3px solid #bbb;padding:4px 10px;margin:8px 0;background:#fafafa}',
    '.section{break-inside:avoid-page}',
    '.print-btn{position:fixed;top:16px;right:16px;z-index:9;background:#0081ad;color:#fff;border:none;padding:10px 16px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;box-shadow:0 3px 10px rgba(0,0,0,.3)}',
    '@media print{body{background:#fff}.no-print{display:none!important}.page{box-shadow:none;margin:0;max-width:none;border-radius:0;padding:0}}'
  ].join('')
}
