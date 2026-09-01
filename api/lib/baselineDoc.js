"use strict";
/**
 * Baseline als Dokument.
 *
 * Rendert die Baseline zu HTML — einmal als Fragment für die Wissensseite im
 * Werkzeug, einmal als eigenständiges Dokument zum Weitergeben und Drucken.
 *
 * Bewusst hier und nicht im Frontend: Sonst gäbe es die Darstellung zweimal,
 * und der Export würde langsam von der Wissensseite abweichen — genau das
 * Drift-Problem, das die Baseline abschaffen soll.
 *
 * Zur Gestaltung: Die Baseline ist ein Nachschlagewerk, kein Fliesstext. Man
 * kommt mit einer Frage («welche Silent-Switches hat Bitdefender?», «was
 * bricht die NTLM-Policy?») und will die Antwort in Sekunden. Deshalb
 * Sprungleiste oben, die Agents als Karten mit Kopfzeile statt als Tabellen-
 * kolonnen, Risiko und Pflicht als farbige Marker, und alles Erklärende in
 * aufklappbaren Blöcken — sichtbar bleibt, was man im Alltag braucht.
 */

const BL_CSS = `
.bl{--bl-accent:#0081ad;--bl-line:rgba(127,127,127,.28);--bl-soft:rgba(127,127,127,.08);
    --bl-high:#c0392b;--bl-mid:#b7791f;--bl-ok:#2c7a4d}
.bl h2{font-size:1.35rem;margin:0 0 .4rem;letter-spacing:-.01em}
.bl h3{font-size:1.02rem;margin:1.4rem 0 .5rem}
.bl h4{font-size:.92rem;margin:1rem 0 .35rem}
.bl p{margin:.4rem 0}
.bl-muted{opacity:.68;font-size:.86em}
.bl-sec{padding:1.6rem 0;border-top:1px solid var(--bl-line)}
.bl-sec:first-of-type{border-top:0}

.bl-hero{display:flex;gap:1rem;align-items:flex-start;padding:.2rem 0 1rem}
.bl-ver{display:inline-block;font-weight:700;font-size:.78rem;letter-spacing:.08em;text-transform:uppercase;
        color:var(--bl-accent);border:1px solid var(--bl-accent);border-radius:999px;padding:2px 12px;margin-bottom:.5rem}
.bl-jump{display:flex;flex-wrap:wrap;gap:.35rem;padding:.6rem 0 .2rem;position:sticky;top:0;z-index:5;
         background:inherit;border-bottom:1px solid var(--bl-line);margin-bottom:.4rem}
.bl-jump a{font-size:.82rem;text-decoration:none;color:inherit;opacity:.75;border:1px solid var(--bl-line);
           border-radius:999px;padding:3px 11px;white-space:nowrap}
.bl-jump a:hover{opacity:1;border-color:var(--bl-accent);color:var(--bl-accent)}

.bl-cards{display:grid;gap:.9rem}
.bl-card{border:1px solid var(--bl-line);border-radius:12px;overflow:hidden}
.bl-card-head{display:flex;align-items:center;justify-content:space-between;gap:.6rem;flex-wrap:wrap;
              padding:.6rem .9rem;background:var(--bl-soft);border-bottom:1px solid var(--bl-line)}
.bl-card-head h3{margin:0;font-size:1.02rem}
.bl-card-body{padding:.8rem .9rem}
.bl-lead{margin:0 0 .6rem}
.bl-badge{font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;font-weight:700;
          border:1px solid var(--bl-line);border-radius:999px;padding:2px 10px;opacity:.7}
.bl-badge-req{color:var(--bl-accent);border-color:var(--bl-accent);opacity:1}
.bl-tag{font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;opacity:.6}

.bl-fields{display:grid;grid-template-columns:minmax(120px,190px) 1fr;gap:.28rem .9rem;margin:.5rem 0}
.bl-fields dt{font-size:.8rem;text-transform:uppercase;letter-spacing:.05em;opacity:.6;padding-top:.15rem}
.bl-fields dd{margin:0;min-width:0;overflow-wrap:anywhere}

.bl-note{border-left:3px solid var(--bl-accent);background:var(--bl-soft);
         padding:.55rem .8rem;margin:.7rem 0;border-radius:0 8px 8px 0;font-size:.92em}
.bl-claim{font-size:1.02em;border-left:3px solid var(--bl-accent);padding-left:.8rem;margin:.6rem 0}
.bl-pre{background:var(--bl-soft);border:1px solid var(--bl-line);border-radius:8px;
        padding:.5rem .7rem;overflow-x:auto;font-size:.8rem;margin:.5rem 0}

.bl-det{border:1px solid var(--bl-line);border-radius:9px;margin:.6rem 0}
.bl-det>summary{cursor:pointer;padding:.45rem .8rem;font-weight:600;font-size:.9rem;list-style:none}
.bl-det>summary::-webkit-details-marker{display:none}
.bl-det>summary::before{content:"▸";color:var(--bl-accent);margin-right:.5rem}
.bl-det[open]>summary::before{content:"▾"}
.bl-det[open]>summary{border-bottom:1px solid var(--bl-line)}
.bl-det-body{padding:.5rem .8rem .7rem}
.bl-det-warn>summary::before{content:"⚠";color:var(--bl-mid)}
.bl-det-warn[open]>summary::before{content:"⚠"}

.bl-tw{overflow-x:auto;border:1px solid var(--bl-line);border-radius:10px;margin:.6rem 0}
table.bl-t{border-collapse:collapse;width:100%;font-size:.88rem}
table.bl-t th,table.bl-t td{text-align:left;padding:.45rem .7rem;border-bottom:1px solid var(--bl-line);vertical-align:top}
table.bl-t tbody tr:last-child td{border-bottom:0}
table.bl-t th{font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;opacity:.6;background:var(--bl-soft)}
.bl-val{color:var(--bl-accent)}

.bl-risk{font-size:.74rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;
         border-radius:999px;padding:2px 10px;white-space:nowrap;border:1px solid}
.bl-risk-high{color:var(--bl-high);border-color:var(--bl-high)}
.bl-risk-mid{color:var(--bl-mid);border-color:var(--bl-mid)}
.bl-risk-low{color:var(--bl-ok);border-color:var(--bl-ok)}

.bl-list{margin:.4rem 0;padding-left:1.1rem}
.bl-list li{margin:.25rem 0}
.bl-list-check{list-style:none;padding-left:0}
.bl-list-check li{position:relative;padding-left:1.3rem}
.bl-list-check li::before{content:"✓";position:absolute;left:0;color:var(--bl-accent);font-weight:700}

.bl-steps{list-style:none;counter-reset:s;padding:0;margin:.6rem 0}
.bl-steps li{counter-increment:s;position:relative;padding:.45rem 0 .45rem 2.1rem;border-bottom:1px solid var(--bl-line)}
.bl-steps li:last-child{border-bottom:0}
.bl-steps li::before{content:counter(s);position:absolute;left:0;top:.45rem;width:1.5rem;height:1.5rem;
                     border-radius:50%;background:var(--bl-soft);color:var(--bl-accent);font-size:.78rem;
                     font-weight:700;display:flex;align-items:center;justify-content:center}
.bl-steps strong{display:block}
.bl-steps span{display:block;opacity:.78;font-size:.9em}
.bl-steps-q strong{color:var(--bl-accent);margin-top:.15rem}

.bl-split{display:grid;grid-template-columns:1fr 1fr;gap:1.2rem}
@media (max-width:820px){.bl-split{grid-template-columns:1fr}.bl-fields{grid-template-columns:1fr}
  .bl-fields dt{padding-top:.4rem}}
.bl-cis{font-size:.74rem;opacity:.6;font-weight:400;letter-spacing:.04em}
.bl-chain{display:flex;flex-wrap:wrap;align-items:center;gap:.35rem;margin:.7rem 0}
.bl-chain-i{border:1px solid var(--bl-line);border-radius:8px;padding:.3rem .7rem;font-size:.85rem;background:var(--bl-soft)}
.bl-chain-a{color:var(--bl-accent);font-weight:700}
.bl-steps-plain li{padding-left:2.1rem}
.bl-steps-plain span{opacity:1;font-size:1em}
.bl-embed .bl-sec{border-top:0;padding-top:.4rem}
.bl-embed .bl-sec h2{font-size:1.1rem}
@media print{.bl-jump{display:none}.bl-det{border:0}.bl-det-body{padding-left:0}
  .bl-card,.bl-tw,.bl-steps li{break-inside:avoid}}
`;

function esc(s) {
  return String(s === undefined || s === null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function code(s) { return "<code>" + esc(s) + "</code>"; }
function table(headers, rows, cls) {
  return '<div class="bl-tw' + (cls ? " " + cls : "") + '"><table class="bl-t">\n<thead><tr>'
    + headers.map(h => "<th>" + esc(h) + "</th>").join("") + "</tr></thead><tbody>"
    + rows.map(r => "<tr>" + r.map(c => "<td>" + c + "</td>").join("") + "</tr>").join("\n")
    + "</tbody></table></div>";
}
function list(items, cls) {
  return '<ul class="' + (cls || "bl-list") + '">' + items.map(i => "<li>" + i + "</li>").join("") + "</ul>";
}
/** Feldpaare als kompaktes Raster statt als zweispaltige Tabelle. */
function fields(pairs) {
  return '<dl class="bl-fields">' + pairs.map(p =>
    "<dt>" + esc(p[0]) + "</dt><dd>" + p[1] + "</dd>").join("") + "</dl>";
}
function riskChip(level) {
  const k = String(level || "").toLowerCase();
  return '<span class="bl-risk bl-risk-' + (k === "hoch" ? "high" : k === "mittel" ? "mid" : "low") + '">' + esc(level) + "</span>";
}

function agentCard(a) {
  const zeilen = [
    ["Display Name", code(a.displayName)],
    ["Vendor", code(a.vendor)],
    a.description ? ["Description", code(a.description)] : null,
    a.installCommandLine ? ["Install Command Line", code(a.installCommandLine)] : null,
    a.silentInstallParameters ? ["Silent-Switches", code(a.silentInstallParameters)] : null,
    a.installedAppsName ? ["Installed Apps Name", code(a.installedAppsName)] : null,
    a.version ? ["Version", code(a.version) + (a.versionQuelle ? ' <span class="bl-muted">' + esc(a.versionQuelle) + "</span>" : "")] : null,
    a.uninstall ? ["Uninstall", esc(a.uninstall)] : null,
    a.zielgruppe ? ["Zielgruppe", code(a.zielgruppe) + ' <span class="bl-tag">Required</span>'] : null
  ].filter(Boolean);

  let h = '<article class="bl-card" id="bl-agent-' + esc(a.key) + '">';
  h += '<header class="bl-card-head"><h3>' + esc(a.titel) + "</h3>"
    + (a.pflicht ? '<span class="bl-badge bl-badge-req">Pflicht</span>'
                 : '<span class="bl-badge">kundenabhängig</span>') + "</header>";
  h += '<div class="bl-card-body">';
  if (a.herkunft) h += '<p class="bl-lead">' + esc(a.herkunft) + "</p>";
  if (a.bedingung) h += '<p class="bl-lead"><strong>Einsatz:</strong> ' + esc(a.bedingung) + "</p>";
  h += fields(zeilen);

  if (a.erkennung) {
    const e = a.erkennung, teile = [];
    if (e.pfad) teile.push(code(e.pfad));
    if (e.datei) teile.push(code(e.datei));
    if (e.vergleich) teile.push(esc(e.vergleich));
    h += '<div class="bl-note"><strong>Erkennung: ' + esc(e.empfohlen) + "</strong>"
      + (teile.length ? " — " + teile.join(" · ") : "")
      + (e.warum ? '<br><span class="bl-muted">' + esc(e.warum) + "</span>" : "") + "</div>";
  }
  if (a.zweiteiligkeit) {
    h += "<h4>Besteht aus mehreren Teilen</h4>"
      + table(["Teil", "Weg", "Zuweisung an"], a.zweiteiligkeit.map(t => [
        "<strong>" + esc(t.teil) + "</strong>", esc(t.weg), esc(t.ziel)]));
  }
  if (a.region) {
    h += '<div class="bl-note"><strong>Server-Region</strong> — EU ' + code(a.region.eu.base)
      + ", US " + code(a.region.us.base) + '<br><span class="bl-muted">' + esc(a.region.hinweis) + "</span></div>";
  }
  if (a.tokenFormat) {
    h += "<details class=\"bl-det\"><summary>Installer-Token entschlüsseln</summary><div class=\"bl-det-body\">"
      + "<p>" + esc(a.tokenFormat.beschreibung) + "</p><pre class=\"bl-pre\">" + esc(a.tokenFormat.urlMuster) + "</pre>"
      + '<p class="bl-muted">Prüfen ohne Ausführen: ' + code(a.tokenFormat.pruefen) + "</p></div></details>";
  }
  if (a.fallstricke && a.fallstricke.length) {
    h += '<details class="bl-det bl-det-warn"><summary>Fallstricke (' + a.fallstricke.length + ")</summary>"
      + '<div class="bl-det-body">' + list(a.fallstricke.map(esc)) + "</div></details>";
  }
  h += "</div></article>";
  return h;
}


function mailSection(mail) {
  if (!mail) return "";
  return `
<section id="bl-mail" class="bl-sec">
  <h2>Mail-Härtung ohne <code>BP_</code>-Objekt</h2>
  <div class="bl-note"><strong>Warum kein eigenes Objekt:</strong> ${esc(mail.warumKeinBpObjekt || "")}</div>
  <h3>Ausgehender Spam <span class="bl-cis">CIS ${esc(mail.ausgehenderSpam ? mail.ausgehenderSpam.cis : "")}</span></h3>
  ${table(["Einstellung", "Soll", "Hinweis"], ((mail.ausgehenderSpam || {}).werte || []).map(w =>
    [code(w.einstellung), '<strong class="bl-val">' + esc(w.soll) + "</strong>", '<span class="bl-muted">' + esc(w.hinweis || "") + "</span>"]))}
  ${list(((mail.ausgehenderSpam || {}).hinweise || []).map(esc))}
  <h3>Organisationseinstellungen <span class="bl-cis">CIS ${esc(mail.organisation ? mail.organisation.cis : "")}</span></h3>
  ${table(["Massnahme", "Wie", "Vorher erheben", "Hinweis"], ((mail.organisation || {}).massnahmen || []).map(x =>
    ["<strong>" + esc(x.was) + "</strong>", code(x.cmdlet), esc(x.vorher), '<span class="bl-muted">' + esc(x.hinweis) + "</span>"]))}
</section>`;
}

const JUMPS = [
  ["bl-agents", "Pflichtmodule"],
  ["bl-customapp", "Custom App"],
  ["bl-mailsec", "Mail-Security"],
  ["bl-mail", "Mail-Härtung"],
  ["bl-autopilot", "Autopilot"],
  ["bl-oib", "OpenIntuneBaseline"],
  ["bl-ca", "Conditional Access"],
  ["bl-mappings", "Mappings"],
  ["bl-remediations", "Remediations"],
  ["bl-backup", "Intune-Backup"],
  ["bl-onboarding", "Onboarding"],
  ["bl-regeln", "Entscheidungsregeln"],
  ["bl-namen", "Namensschema"]
];

/** Abschnitte, die es nur gibt, wenn die Baseline sie kennt — so bleibt der
 *  Renderer mit aelteren Baseline-Versionen benutzbar. */
function mailSecuritySection(ms, ns) {
  if (!ms) return "";
  const pfx = (ns && ns.muster && ns.muster.eopPrefix) || "BP_";
  return `
<section id="bl-mailsec" class="bl-sec">
  <h2>Mail-Security <span class="bl-cis">EOP Anti-Threat</span></h2>
  <p>${esc(ms.ziele || "")}</p>
  <div class="bl-note">${esc(ms.marker || "")} Aktuelles Präfix: ${code(pfx)}</div>
  <h3>Was mit welcher Kategorie passiert</h3>
  ${table(["Kategorie", "Aktion", "Warum"], (ms.kategorien || []).map(k =>
    ["<strong>" + esc(k.kategorie) + "</strong>", '<span class="bl-val">' + esc(k.aktion) + "</span>", '<span class="bl-muted">' + esc(k.warum) + "</span>"]))}
  <h3>Objektset</h3>
  ${table(["Objekt", "Sollzustand"], (ms.objekte || []).map(o =>
    ["<strong>" + code(pfx + o.objekt) + "</strong>", esc(o.soll)]))}
  <details class="bl-det"><summary>Blockierte Dateitypen (Common-Attachment-Filter)</summary>
    <div class="bl-det-body"><pre class="bl-pre">${esc(ms.blockierteDateitypen || "")}</pre></div></details>
  <details class="bl-det"><summary>Härtung und Betrieb ohne Lizenz-Upgrade</summary>
    <div class="bl-det-body">${list((ms.haertung || []).map(esc))}</div></details>
  <details class="bl-det"><summary>Lizenz-Matrix und Admin-Lizenz</summary><div class="bl-det-body">
    ${table(["Feature", "EOP", "Defender P1", "Defender P2"], (ms.lizenz || []).map(l =>
      ["<strong>" + esc(l.feature) + "</strong>", esc(l.eop), esc(l.p1), esc(l.p2)]))}
    <p>${esc(ms.adminLizenz || "")}</p>
  </div></details>
  <h3>Ausgehende Authentifizierung je Mail-Domain</h3>
  ${table(["Mechanismus", "Sollwert", "Wo"], (ms.domainAuth || []).map(d =>
    ["<strong>" + esc(d.mechanismus) + "</strong>", esc(d.soll), '<span class="bl-muted">' + esc(d.wo) + "</span>"]))}
  <div class="bl-note">${esc(ms.grenze || "")}</div>
</section>`;
}

function autopilotSection(ap) {
  if (!ap) return "";
  return `
<section id="bl-autopilot" class="bl-sec">
  <h2>Geräteprovisionierung (Autopilot)</h2>
  <p class="bl-claim">${esc(ap.merksatz || "")}</p>
  <div class="bl-chain">${(ap.kette || []).map(k => '<span class="bl-chain-i">' + esc(k) + "</span>").join('<span class="bl-chain-a">→</span>')}</div>
  <h3>Einmal pro Tenant</h3>
  ${table(["Schritt", "Wie", "Werkzeug"], (ap.einmalSetup || []).map(e =>
    ["<strong>" + esc(e.schritt) + "</strong>", esc(e.wie),
     e.automatisiert ? '<span class="bl-risk bl-risk-low">automatisiert</span>' : '<span class="bl-badge">manuell</span>']))}
  <h3>Am Gerät</h3>
  <ol class="bl-steps bl-steps-plain">${(ap.feldRunbook || []).map(f => "<li><span>" + esc(f) + "</span></li>").join("")}</ol>
  <details class="bl-det bl-det-warn"><summary>Wenn es klemmt</summary><div class="bl-det-body">
    ${table(["Problem", "Ursache", "Lösung"], (ap.stolpersteine || []).map(x =>
      ["<strong>" + esc(x.problem) + "</strong>", esc(x.ursache), esc(x.loesung)]))}
  </div></details>
  <div class="bl-note">${esc(ap.sicherheit || "")}</div>
</section>`;
}

function caSection(ca, agents) {
  if (!ca) return "";
  return `
<section id="bl-ca" class="bl-sec">
  <h2>Conditional Access</h2>
  <div class="bl-note"><strong>Die wichtigste Regel:</strong> ${esc(ca.wichtigsteRegel || "")}</div>
  <h3>Rollout-Ringe</h3>
  ${table(["Ring", "Gruppe", "Wer", "Regel"], (ca.ringe || []).map(r =>
    ['<strong class="bl-val">' + esc(r.ring) + "</strong>", r.gruppe ? code(r.gruppe) : "—", esc(r.wer), esc(r.regel)]))}
  <p class="bl-muted">${esc(ca.ringPrinzip || "")}</p>
  <h3>Schutzgruppen — immer leer angelegt</h3>
  ${table(["Gruppe", "Zweck"], (ca.schutzgruppen || []).map(g =>
    [code((g.name || g.kind)), esc(g.zweck)]))}
  <p class="bl-muted">${esc(ca.schutzgruppenRegel || "")}</p>
  <details class="bl-det"><summary>Ausbaustufen nach Lizenz</summary><div class="bl-det-body">
    ${table(["Stufe", "Umfang", "Lizenz"], (ca.ausbaustufen || []).map(a =>
      ["<strong>" + esc(a.stufe) + "</strong>", esc(a.umfang), esc(a.lizenz)]))}
  </div></details>
</section>`;
}

function mappingsSection(mp) {
  if (!mp) return "";
  return `
<section id="bl-mappings" class="bl-sec">
  <h2>Mappings — Laufwerke und Drucker</h2>
  <p>${esc(mp.ausgangslage || "")}</p>
  ${table(["Kriterium", "Laufwerks-Mapping", "Drucker-Mapping"], (mp.vergleich || []).map(v =>
    ["<strong>" + esc(v.kriterium) + "</strong>", esc(v.drive), esc(v.printer)]))}
  <div class="bl-note"><strong>Nesting-Falle:</strong> ${esc(mp.nestingFalle || "")}</div>
  <details class="bl-det bl-det-warn"><summary>Drucker-Mapping: dokumentierte Abweichung</summary>
    <div class="bl-det-body"><p>${esc(mp.warnung || "")}</p></div></details>
  <details class="bl-det"><summary>Voraussetzung: Cloud Kerberos Trust</summary>
    <div class="bl-det-body"><p>${esc(mp.kerberos || "")}</p></div></details>
</section>`;
}

function remediationsSection(rm) {
  if (!rm) return "";
  return `
<section id="bl-remediations" class="bl-sec">
  <h2>Remediations</h2>
  <div class="bl-note"><strong>Voraussetzung im Tenant:</strong> ${esc(rm.voraussetzung || "")}</div>
  ${table(["Teil", "Zweck"], (rm.aufbau || []).map(a => ["<strong>" + esc(a.teil) + "</strong>", esc(a.zweck)]))}
  <h3>Beim Anlegen</h3>
  ${list((rm.deployRegeln || []).map(esc), "bl-list bl-list-check")}
  <p class="bl-muted">${esc(rm.abgrenzung || "")}</p>
</section>`;
}

function backupSection(bk) {
  if (!bk) return "";
  return `
<section id="bl-backup" class="bl-sec">
  <h2>Intune-Backup und -Restore</h2>
  <p>${esc(bk.grund || "")}</p>
  <div class="bl-split">
    <div><h3>Gesichert</h3>${list((bk.gesichert || []).map(esc), "bl-list bl-list-check")}</div>
    <div><h3>Drei Nie-Regeln</h3>${list((bk.nieRegeln || []).map(esc))}</div>
  </div>
  <div class="bl-note"><strong>Bewusst nicht gesichert:</strong> ${esc(bk.nichtGesichert || "")}</div>
  <p class="bl-muted">${esc(bk.drift || "")}</p>
</section>`;
}

/** HTML-Fragment — das, was die Wissensseite im Werkzeug zeigt. */
function renderSections(b) {
  const m = b.meta || {};
  const ca = b.customApp || {};
  const oib = b.oib || {};
  const mail = b.mailHaertung || {};
  const reg = b.entscheidungsregeln || {};
  const ns = b.namensschema || {};

  const jump = '<nav class="bl-jump">' + JUMPS.map(j =>
    '<a href="#' + j[0] + '">' + esc(j[1]) + "</a>").join("") + "</nav>";

  // Die Styles reisen mit dem Fragment mit: Es wird per {@html} eingefuegt,
  // Svelte-Scoping greift dort nicht. Alle Selektoren tragen den bl-Praefix.
  return `<style>${BL_CSS}</style>
<div class="bl">
<div class="bl-hero">
  <div class="bl-hero-main">
    <span class="bl-ver">Baseline ${esc(m.version)}</span>
    <p>${esc(m.zweck)}</p>
    <p class="bl-muted">Gültig ab ${esc(m.gueltigAb)}. ${esc(m.hinweis || "")}</p>
  </div>
</div>
${jump}

<section id="bl-agents" class="bl-sec">
  <h2>Pflichtmodule je Kunde</h2>
  <p>Diese Agents gehören auf jeden Standard-Client. Die Zielgruppen sind nach der eingestellten
  Namenskonvention ausgerechnet — so heissen sie in diesem Tenant wirklich.</p>
  <div class="bl-cards">${(b.agents || []).map(agentCard).join("")}</div>
</section>

<section id="bl-customapp" class="bl-sec">
  <h2>Grundgerüst für jede Custom App</h2>
  <p>${esc(ca.beschreibung || "")}</p>
  ${table(["Feld", "Sollwert", "Warum"], (ca.felder || []).map(f =>
    ["<strong>" + esc(f.feld) + "</strong>", esc(f.soll), '<span class="bl-muted">' + esc(f.warum) + "</span>"]))}
  <div class="bl-split">
    <div>
      <h3>Rückgabecodes</h3>
      ${table(["Code", "Typ", "Bedeutung"], (ca.rueckgabecodes || []).map(r =>
        [code(r.code), esc(r.typ), esc(r.bedeutung)]))}
    </div>
    <div>
      <h3>Zuweisung</h3>
      ${list((ca.zuweisung || []).map(esc), "bl-list bl-list-check")}
    </div>
  </div>
</section>

${mailSecuritySection(b.mailSecurity, ns)}
${mailSection(mail)}
${autopilotSection(b.autopilot)}

<section id="bl-oib" class="bl-sec">
  <h2>OpenIntuneBaseline</h2>
  <p class="bl-claim">${esc(oib.aussage || "")}</p>
  <h3>Break-Risk-Policies — vor dem Scharfstellen testen</h3>
  ${table(["Policy", "Bricht potenziell", "Risiko"], (oib.breakRisk || []).map(r =>
    ["<strong>" + esc(r.policy) + "</strong>", esc(r.brichtPotenziell), riskChip(r.risiko)]))}
  <details class="bl-det"><summary>Bewusste Abweichungen von CIS (${(oib.cisDelta || []).length})</summary><div class="bl-det-body">
    ${table(["Bereich", "Warum nicht umgesetzt", "Kompensation"], (oib.cisDelta || []).map(d =>
      ["<strong>" + esc(d.bereich) + "</strong>", esc(d.warum), esc(d.kompensation)]))}
  </div></details>
  <div class="bl-note">
    <strong>Assignment-Filter statt Versionsgruppen</strong><br>
    ${esc(oib.assignmentFilter ? oib.assignmentFilter.zweck : "")}
    <pre class="bl-pre">${esc(oib.assignmentFilter ? oib.assignmentFilter.regel : "")}</pre>
    <span class="bl-muted">${esc(oib.zuweisungslogik || "")}</span>
  </div>
</section>

${caSection(b.conditionalAccess)}
${mappingsSection(b.mappings)}
${remediationsSection(b.remediations)}
${backupSection(b.intuneBackup)}

<section id="bl-onboarding" class="bl-sec">
  <h2>Onboarding-Checkliste</h2>
  <ol class="bl-steps">
    ${(b.onboarding || []).map(o =>
      "<li><strong>" + esc(o.punkt) + "</strong><span>" + esc(o.vorgabe) + "</span></li>").join("")}
  </ol>
</section>

<section id="bl-regeln" class="bl-sec">
  <h2>Entscheidungsregeln</h2>
  <div class="bl-split">
    <div>
      <h3>Welches Tier?</h3>
      <ol class="bl-steps bl-steps-q">
        ${(reg.tier || []).map(t => "<li><span>" + esc(t.frage) + "</span><strong>→ " + esc(t.ja)
          + (t.sonst ? ", sonst " + esc(t.sonst) : "") + "</strong></li>").join("")}
      </ol>
    </div>
    <div>
      <h3>Cloud Kerberos Trust nötig?</h3>
      <ol class="bl-steps bl-steps-q">
        ${(reg.cloudKerberos || []).map(k => "<li><span>" + esc(k.frage) + "</span><strong>"
          + (k.nein ? "Nein → " + esc(k.nein) : "") + (k.ja ? " · Ja → " + esc(k.ja) : "") + "</strong></li>").join("")}
      </ol>
    </div>
  </div>
</section>

<section id="bl-namen" class="bl-sec">
  <h2>Namensschema</h2>
  <p>Profil <strong>${esc(ns.profil)}</strong>${ns.eigeneMuster ? " mit eigenen Mustern" : ""} — Quelle: ${esc(ns.quelle)}.
  Geändert wird das im Tab <strong>Namenskonvention</strong>, nicht in dieser Datei.</p>
  ${table(["Objekt", "Muster", "Ergibt"], (ns.beispiele || []).map(p =>
    ["<strong>" + esc(p.label) + "</strong>", code(p.template), code(p.example)]))}
</section>
</div>`;
}

/** Styles — im Export eingebettet, im Werkzeug über den Wissen-Tab global gesetzt. */


const DOC_CSS = `
:root{--bg:#fff;--fg:#10242c;--line:#d7e3e8;--soft:#f4f8fa;--accent:#0081ad}
@media (prefers-color-scheme:dark){:root{--bg:#0e191f;--fg:#dfeaef;--line:#273d47;--soft:#142229;--accent:#45b0d3}}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--fg);margin:0;padding:0 20px;
     font:16px/1.6 "IBM Plex Sans","Segoe UI",system-ui,sans-serif}
.wrap{max-width:980px;margin:0 auto;padding:36px 0 80px}
header.doc{border-bottom:2px solid var(--accent);padding-bottom:14px;margin-bottom:10px}
header.doc h1{font-size:1.9rem;margin:0 0 4px;letter-spacing:-.015em}
header.doc p{margin:0;opacity:.7;font-size:.9rem}
code{font-family:"IBM Plex Mono",Consolas,monospace;font-size:.85em;background:var(--soft);
     border:1px solid var(--line);border-radius:4px;padding:1px 5px}
pre{font-family:"IBM Plex Mono",Consolas,monospace}
footer.doc{margin-top:40px;padding-top:14px;border-top:1px solid var(--line);opacity:.65;font-size:.82rem}
.bl{--bl-line:var(--line);--bl-soft:var(--soft);--bl-accent:var(--accent)}
.bl-jump{background:var(--bg)}
`;

/** Eigenständiges Dokument — zum Weitergeben, Drucken, Archivieren. */
function renderDocument(b, opts) {
  opts = opts || {};
  const m = b.meta || {};
  const stand = opts.stand || new Date().toISOString().slice(0, 10);
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(m.titel || "Baseline")} ${esc(m.version)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap">
<style>${DOC_CSS}${BL_CSS}</style></head>
<body><div class="wrap">
<header class="doc">
  <h1>${esc(m.titel || "Baseline")}</h1>
  <p>Version ${esc(m.version)} · gültig ab ${esc(m.gueltigAb)} · erzeugt am ${esc(stand)}${opts.tenantName ? " · Namensschema des Tenants " + esc(opts.tenantName) : ""}</p>
</header>
${renderSections(b)}
<footer class="doc">igeeks AG · intern — erzeugt aus <code>baseline.json</code>, Version ${esc(m.version)}. Änderungen laufen über einen Commit mit Review, nicht über diese Datei.</footer>
</div></body></html>`;
}

/**
 * Einen einzelnen Abschnitt ausschneiden — fuer die Prosa-Wissensseiten, die
 * ihre Werte aus der Baseline beziehen sollen statt eigene Kopien zu pflegen.
 *
 * Bewusst aus dem Gesamtfragment geschnitten und nicht als zweite Liste von
 * Render-Funktionen gefuehrt: So kommt jeder neue Abschnitt automatisch mit,
 * und es gibt keine Stelle, die man beim Erweitern vergessen kann. Die
 * Abschnitte sind nicht verschachtelt — Karten sind <article>, nicht <section>.
 */
function renderSection(b, id) {
  const key = "bl-" + String(id || "").replace(/^bl-/, "");
  const all = renderSections(b);
  const start = all.indexOf('<section id="' + key + '"');
  if (start < 0) {
    const e = new Error("Unbekannter Baseline-Abschnitt: " + id);
    e.status = 404;
    throw e;
  }
  const end = all.indexOf("</section>", start) + "</section>".length;
  return "<style>" + BL_CSS + '</style><div class="bl bl-embed">' + all.slice(start, end) + "</div>";
}

module.exports = { renderSections, renderSection, renderDocument, BL_CSS };
