// Bestandsaufnahme als eigenstaendiges, druckbares Dokument (A4, window.print
// -> "Als PDF speichern"). Bewusst ohne externe Ressourcen: die Datei soll auch
// in fuenf Jahren im Anhang einer Mail noch so aussehen wie heute.
//
// Kein pdfkit: dieses Dokument besteht fast nur aus Tabellen, und Seitenumbruch,
// wiederholter Tabellenkopf und Spaltenbreiten sind in HTML/CSS geloest, waehrend
// man sie in pdfkit von Hand zeichnen muesste. Dasselbe Muster wie configDoc.js
// und der Audit-Report.
//
// Aufbau: Deckblatt -> Einordnung -> Beobachtungen -> Zahlen im Ueberblick ->
// Querschnitte -> Bestandslisten -> Abgrenzung -> Methodik. Die Beobachtungen
// stehen VOR den Tabellen: wer das Dokument nur ueberfliegt, soll die Aussage
// mitnehmen, nicht die Rohdaten.

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function fmtNum(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return esc(n)
  return v.toLocaleString('de-CH').replace(/ | /g, '’')
}

// Tabellenzellen kommen als fertige Strings aus dem Backend. Eine Zelle wird nur
// dann als Zahl gruppiert, wenn sie AUSSCHLIESSLICH aus Ziffern besteht und gross
// genug ist, dass die Gruppierung ueberhaupt hilft -- damit bleiben Versions-
// nummern (10.0.22621.525), Datumsangaben und kleine Zahlen unangetastet.
function cell(v) {
  const s = String(v == null ? '' : v)
  return /^\d{5,}$/.test(s) ? fmtNum(Number(s)) : esc(s)
}

function dateLong(iso) {
  const d = new Date(iso)
  if (isNaN(d)) return '—'
  return d.toLocaleDateString('de-CH', { day: '2-digit', month: 'long', year: 'numeric' })
    + ', ' + d.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' }) + ' Uhr'
}

function table(columns, rows, opts) {
  const cls = (opts && opts.cls) || ''
  return `<table class="data ${cls}">
    <thead><tr>${columns.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(r => `<tr>${r.map(c => `<td>${cell(c)}</td>`).join('')}</tr>`).join('')}</tbody>
  </table>`
}

function listBlock(l) {
  if (!l || !l.rows || !l.rows.length) return ''
  return `<div class="list-block">
    <h3>${esc(l.label)} <span class="count">${fmtNum(l.rows.length)}${l.more ? ` von ${fmtNum(l.rows.length + l.more)}` : ''}</span></h3>
    ${table(l.columns, l.rows)}
    ${l.more ? `<p class="hint">… und ${fmtNum(l.more)} weitere (Liste gekürzt).</p>` : ''}
  </div>`
}

// Einordnung in Prosa: was fuer ein Betrieb steht hinter diesen Zahlen. Wird aus
// den Zaehlern gebaut, damit sie nie auseinanderlaufen koennen.
function buildIntro(inv) {
  const c = inv.counts || {}
  const kinds = inv.accountKinds || {}
  const parts = []

  if (c.accounts != null) {
    const kindText = Object.entries(kinds)
      .filter(([k]) => k !== 'Benutzerkonto')
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${fmtNum(n)} ${esc(k)}${n === 1 ? '' : n && k.endsWith('e') ? 'n' : 'n'}`)
    parts.push(`Der Tenant umfasst <b>${fmtNum(c.accounts)} Konten</b>` +
      (kinds['Benutzerkonto'] ? `, davon ${fmtNum(kinds['Benutzerkonto'])} Benutzerkonten` : '') +
      (kindText.length ? ` sowie ${kindText.join(', ')}` : '') + '.')
  }
  if (c.licensed != null) parts.push(`${fmtNum(c.licensed)} Konten tragen mindestens eine Lizenz.`)
  if (c.mailboxes != null) parts.push(`In Exchange Online liegen <b>${fmtNum(c.mailboxes)} Postfächer</b>.`)
  if (c.intuneDevices != null && c.entraDevices != null) {
    parts.push(`Über Intune verwaltet werden <b>${fmtNum(c.intuneDevices)} Geräte</b>, im Verzeichnis stehen ` +
      `${fmtNum(c.entraDevices)}.`)
  }
  return parts.join(' ')
}

export function buildInventoryHtml(inventory) {
  const inv = inventory || {}
  const dateStr = dateLong(inv.generatedAt)
  const observations = inv.observations || []
  const crossChecks = inv.crossChecks || []
  const kinds = inv.accountKinds || {}
  const counts = inv.counts || {}
  const failed = (inv.summary && inv.summary.failedSections) || []

  // --- Beobachtungen: der Teil, den man in die Offerte kopiert.
  const obsHtml = observations.length
    ? `<ol class="obs">${observations.map(o => `<li>
        <div class="obs-title">${esc(o.title)}</div>
        <p>${esc(o.text)}</p>
        ${o.detail && o.detail.length
          ? `<p class="obs-detail">${o.detail.slice(0, 12).map(esc).join(' · ')}${o.detail.length > 12 ? ` … (${fmtNum(o.detail.length)} gesamt)` : ''}</p>`
          : ''}
      </li>`).join('')}</ol>`
    : `<p class="hint">Keine Punkte mit Handlungsbedarf erkannt. Das heisst nicht, dass der Tenant vollständig
       geprüft wurde — siehe Abschnitt „Was nicht Teil dieser Erhebung ist".</p>`

  // --- Zahlen im Ueberblick: die Differenzen sind die Aussage, deshalb stehen
  //     die Werte nebeneinander statt in vier getrennten Abschnitten.
  const overviewRows = [
    counts.accounts != null ? ['Konten im Verzeichnis', fmtNum(counts.accounts)] : null,
    counts.licensed != null ? ['davon mit Lizenz', fmtNum(counts.licensed)] : null,
    counts.mailboxes != null ? ['Postfächer in Exchange Online', fmtNum(counts.mailboxes)] : null,
    counts.intuneDevices != null ? ['Geräte über Intune verwaltet', fmtNum(counts.intuneDevices)] : null,
    counts.entraDevices != null ? ['Geräte im Verzeichnis (Entra ID)', fmtNum(counts.entraDevices)] : null
  ].filter(Boolean)

  const kindRows = Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => [k, fmtNum(n)])

  // Bereiche liegen INNERHALB des Kapitels "Bestand im Detail" -- deshalb h3,
  // nicht h2. Mit h2 saehen sie aus wie eigene Kapitel und die Nummerierung
  // haette einen Sprung (5 ... Benutzer ... Lizenzen ... 6).
  const sectionNo = crossChecks.length ? 5 : 4
  const sections = Object.entries(inv.sections || {}).map(([id, sec], i) => {
    const no = `${sectionNo}.${i + 1}`
    if (!sec.ok) {
      return `<div class="subsection"><h3 class="sub">${no}&nbsp;&nbsp;${esc(sec.label)}</h3>
        <p class="fail">Nicht abrufbar: ${esc(sec.error)}</p>
        ${sec.hint ? `<p class="hint">${esc(sec.hint)}</p>` : ''}</div>`
    }
    const metrics = (sec.metrics || []).filter(m => m.value != null)
    return `<div class="subsection"><h3 class="sub">${no}&nbsp;&nbsp;${esc(sec.label)}</h3>
      ${metrics.length ? `<div class="metrics">${metrics.map(m =>
        `<div class="metric"><span class="mv">${fmtNum(m.value)}</span><span class="ml">${esc(m.label)}</span></div>`
      ).join('')}</div>` : ''}
      ${(sec.lists || []).map(listBlock).join('\n')}
    </div>`
  }).join('\n')

  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8" />
<title>M365-Bestandsaufnahme — ${esc(inv.tenantName)}</title>
<style>${docCss()}</style></head>
<body>
<button class="no-print print-btn" onclick="window.print()">Als PDF speichern / Drucken</button>
<div class="page">

<header class="cover">
  <div class="kicker">Microsoft 365 · Bestandsaufnahme</div>
  <h1>${esc(inv.tenantName)}</h1>
  ${inv.organization ? `<div class="org">${esc(inv.organization)}</div>` : ''}
  <dl class="cover-meta">
    <div><dt>Erhoben am</dt><dd>${esc(dateStr)}</dd></div>
    <div><dt>Erhebungsart</dt><dd>Ausschliesslich lesend, app-only</dd></div>
    <div><dt>Erstellt mit</dt><dd>igeeks M365 Security Policy Manager</dd></div>
    <div><dt>Dokumenttyp</dt><dd>Momentaufnahme</dd></div>
  </dl>
</header>

<div class="section">
<h2>1&nbsp;&nbsp;Einordnung</h2>
<p>${buildIntro(inv)}</p>
<p>Dieses Dokument hält fest, <em>was vorhanden ist</em> — Konten, Lizenzen, Postfächer und Geräte zum genannten
Zeitpunkt. Es bewertet nicht den Sicherheitszustand des Tenants; welche Schutzrichtlinien greifen, ist nicht Teil
dieser Erhebung (siehe Abschnitt&nbsp;6). Die Punkte, die aus dem Bestand heraus eine Entscheidung verlangen, stehen
im nächsten Abschnitt.</p>
${failed.length ? `<p class="fail">Nicht auswertbar: ${esc(failed.join(', '))} — die Zahlen sind insoweit unvollständig.</p>` : ''}
</div>

<div class="section">
<h2>2&nbsp;&nbsp;Beobachtungen mit Handlungsbedarf</h2>
${obsHtml}
</div>

<div class="section">
<h2>3&nbsp;&nbsp;Zahlen im Überblick</h2>
<p>Die Differenzen zwischen diesen Zahlen sind aussagekräftiger als die Zahlen selbst: mehr Geräte im Verzeichnis
als in der Verwaltung bedeutet unverwaltete Geräte, mehr Konten als Lizenzen bedeutet Funktions- und
Ressourcenkonten.</p>
<div class="two-col">
  ${table(['Kennzahl', 'Anzahl'], overviewRows, { cls: 'kv' })}
  ${kindRows.length ? table(['Kontoart', 'Anzahl'], kindRows, { cls: 'kv' }) : ''}
</div>
${kindRows.length ? `<p class="hint">Kontoarten werden aus belastbaren Merkmalen abgeleitet — Telefonie-Ressourcen am
Microsoft-Feld <code>department</code>, Funktionspostfächer am Postfachtyp, Break-Glass an der Namenskonvention.
„Benutzerkonto" ist der Rückfall: darunter können weitere Funktionskonten sein, die sich technisch nicht von einem
Mitarbeitendenkonto unterscheiden.</p>` : ''}
</div>

${crossChecks.length ? `<div class="section">
<h2>4&nbsp;&nbsp;Querschnitte</h2>
<p>Diese Listen entstehen aus der Verknüpfung mehrerer Bereiche — sie sind in keiner der Einzelaufstellungen
weiter unten enthalten.</p>
${crossChecks.map(listBlock).join('\n')}
</div>` : ''}

<div class="section">
<h2>${crossChecks.length ? '5' : '4'}&nbsp;&nbsp;Bestand im Detail</h2>
${sections}
</div>

<div class="section">
<h2>${crossChecks.length ? '6' : '5'}&nbsp;&nbsp;Was nicht Teil dieser Erhebung ist</h2>
<p>Damit aus diesem Dokument keine Aussage abgeleitet wird, die es nicht trägt: Die folgenden Bereiche wurden
<b>nicht</b> geprüft.</p>
<ul class="plain">
  <li><b>Schutzrichtlinien</b> — Conditional Access, Multi-Faktor-Authentifizierung, Mail-Security (Anti-Phishing,
      Anti-Spam, Anti-Malware, Safe Links), Defender-Einstellungen.</li>
  <li><b>Datenablage</b> — SharePoint, OneDrive, Teams: weder Struktur noch Freigaben noch externe Zugriffe.</li>
  <li><b>Datensicherung und Aufbewahrung</b> — ob und wie Postfächer und Dateien gesichert werden.</li>
  <li><b>Lokale Infrastruktur</b> — Server, Netzwerk, Drucker, Verzeichnisdienst vor Ort, hybride Kopplung.</li>
  <li><b>Inhalte</b> — es wurden keine Postfächer, Dateien oder Nachrichten geöffnet oder gelesen.</li>
</ul>
<p class="hint">Ob Geräte konform sind, wird aus Intune übernommen; welche Regeln dieser Konformität zugrunde
liegen, ist nicht Gegenstand dieser Erhebung.</p>
</div>

<div class="section">
<h2>${crossChecks.length ? '7' : '6'}&nbsp;&nbsp;Methodik</h2>
<p>Die Daten wurden über Microsoft Graph und Exchange Online ausgelesen, mit einer app-only-Anmeldung per
Zertifikat — ohne Benutzerkonto und ohne Passwort. Es kamen ausschliesslich lesende Aufrufe zum Einsatz;
am Tenant wurde nichts verändert.</p>
<p>Alle Angaben sind eine Momentaufnahme vom ${esc(dateStr)}. Konten, Lizenzen und Geräte ändern sich laufend;
für eine Entscheidung mit finanzieller oder vertraglicher Wirkung gehört der Stand kurz vorher erneut erhoben.</p>
</div>

<footer>
  Erzeugt mit dem igeeks M365 Security Policy Manager · ${esc(dateStr)} ·
  ${esc(inv.tenantName)}${inv.organization ? ' · ' + esc(inv.organization) : ''}
</footer>

</div></body></html>`
}

function docCss() {
  return `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: "Segoe UI", system-ui, -apple-system, Arial, sans-serif; color: #1a1a1a;
         font-size: 10.5pt; line-height: 1.5; background: #f2f4f7; }
  .page { max-width: 900px; margin: 24px auto; background: #fff; padding: 34px 38px 40px;
          box-shadow: 0 2px 18px rgba(16,24,40,.12); border-radius: 6px; }

  /* Deckblatt */
  .cover { border-bottom: 3px solid #0081ad; padding-bottom: 16px; margin-bottom: 22px; }
  .kicker { font-size: 10pt; letter-spacing: .12em; text-transform: uppercase; color: #0081ad; font-weight: 700; }
  h1 { font-size: 24pt; font-weight: 700; margin: 6px 0 2px; letter-spacing: -0.01em; line-height: 1.15; }
  .org { font-size: 11pt; color: #555; font-family: Consolas, monospace; }
  .cover-meta { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 24px; margin-top: 16px; font-size: 9.5pt; }
  .cover-meta > div { border-bottom: 1px solid #eee; padding: 3px 0; display: flex; gap: 8px; }
  .cover-meta dt { color: #667085; font-weight: 600; min-width: 8.5em; }
  .cover-meta dd { color: #1a1a1a; font-weight: 600; }

  h2 { font-size: 13pt; font-weight: 700; margin: 24px 0 8px; padding-bottom: 4px;
       border-bottom: 2px solid #1a1a1a; }
  h3 { font-size: 10.5pt; font-weight: 700; margin: 14px 0 5px; }
  h3 .count { font-weight: 400; color: #667085; font-size: 9.5pt; }
  /* Bereichs-Ueberschrift innerhalb von "Bestand im Detail" -- klar unter h2,
     aber deutlich ueber den Listentiteln darin. */
  h3.sub { font-size: 11.5pt; margin: 20px 0 6px; padding-bottom: 3px; border-bottom: 1px solid #d5d9e0; }
  .subsection { break-inside: auto; }
  p { margin: 0 0 9px; }
  code { font-family: Consolas, monospace; font-size: 9.4pt; background: #f4f4f4; padding: 0 3px; border-radius: 2px; }

  /* Beobachtungen */
  ol.obs { margin: 0; padding-left: 0; list-style: none; counter-reset: obs; }
  ol.obs li { counter-increment: obs; margin: 0 0 12px; padding: 10px 12px 10px 40px; position: relative;
              background: #fafbfc; border: 1px solid #eaecf0; border-left: 3px solid #0081ad; border-radius: 4px;
              break-inside: avoid; page-break-inside: avoid; }
  ol.obs li::before { content: counter(obs); position: absolute; left: 12px; top: 10px;
                      font-weight: 700; color: #0081ad; font-size: 11pt; }
  .obs-title { font-weight: 700; margin-bottom: 3px; }
  ol.obs p { margin: 0; font-size: 10pt; }
  .obs-detail { margin-top: 5px !important; font-size: 9pt; color: #555;
                font-family: Consolas, monospace; line-height: 1.45; }

  /* Kennzahlen je Bereich */
  .metrics { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0 4px; }
  .metric { border: 1px solid #eaecf0; border-radius: 5px; padding: 6px 12px; min-width: 6.5rem; background: #fcfcfd; }
  .metric .mv { display: block; font-size: 15pt; font-weight: 700; line-height: 1.1;
                font-variant-numeric: tabular-nums; }
  .metric .ml { display: block; font-size: 8.6pt; color: #667085; margin-top: 1px; }

  /* Tabellen */
  table.data { width: 100%; border-collapse: collapse; font-size: 9.2pt; margin: 4px 0 8px; }
  table.data th { text-align: left; background: #f3f3f3; font-weight: 600; padding: 5px 8px;
                  border-bottom: 1.5px solid #bbb; white-space: nowrap; }
  table.data td { padding: 4px 8px; border-bottom: 1px solid #e8e8e8; vertical-align: top;
                  font-variant-numeric: tabular-nums; }
  table.data tbody tr:nth-child(even) td { background: #fcfcfd; }
  table.kv { width: 100%; }
  table.kv td:last-child, table.kv th:last-child { text-align: right; width: 6rem; }
  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; align-items: start; }

  .list-block { break-inside: auto; }
  .hint { font-size: 9pt; color: #667085; }
  .fail { color: #b42318; font-weight: 600; }
  ul.plain { margin: 4px 0 10px; padding-left: 18px; }
  ul.plain li { margin: 3px 0; }
  footer { margin-top: 28px; padding-top: 9px; border-top: 1px solid #ccc; font-size: 8.5pt; color: #777; }

  .print-btn { position: fixed; top: 16px; right: 16px; z-index: 9; background: #0081ad; color: #fff; border: none;
               padding: 10px 16px; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer;
               box-shadow: 0 3px 10px rgba(0,0,0,.3); }

  /* Druck: Tabellenkopf je Seite wiederholen, nie mitten in einer Zeile oder
     einem Absatz brechen, Ueberschriften nicht verwaist am Seitenende stehen
     lassen. Lange Tabellen duerfen umbrechen -- sonst entstehen leere Seiten. */
  thead { display: table-header-group; }
  tr, p, li { break-inside: avoid; page-break-inside: avoid; }
  h1, h2, h3 { break-after: avoid; page-break-after: avoid; break-inside: avoid; }
  .section { break-inside: auto; }
  .cover { break-inside: avoid; }

  @media print {
    body { background: #fff; }
    .no-print { display: none !important; }
    .page { box-shadow: none; margin: 0; max-width: none; border-radius: 0; padding: 0; }
    .two-col { gap: 12px; }
  }
  @page { size: A4; margin: 16mm; }
  `
}
