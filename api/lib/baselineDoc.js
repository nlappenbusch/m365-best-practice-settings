"use strict";
/**
 * Baseline als Dokument.
 *
 * Rendert die Baseline zu HTML — einmal als Fragment für die Wissensseite im
 * Werkzeug, einmal als eigenständiges Dokument zum Weitergeben und Drucken.
 *
 * Bewusst hier und nicht im Frontend: Sonst gäbe es die Darstellung zweimal,
 * und der Export würde langsam von der Wissensseite abweichen — genau das
 * Drift-Problem, das die Baseline abschaffen soll. Das Frontend holt das
 * Fragment über die API und zeigt es an.
 */

function esc(s) {
  return String(s === undefined || s === null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function code(s) { return "<code>" + esc(s) + "</code>"; }
function table(headers, rows) {
  return '<div class="tablewrap"><table>\n<tr>' + headers.map(h => "<th>" + esc(h) + "</th>").join("") + "</tr>\n"
    + rows.map(r => "<tr>" + r.map(c => "<td>" + c + "</td>").join("") + "</tr>").join("\n")
    + "\n</table></div>";
}
function list(items) { return "<ul>" + items.map(i => "<li>" + i + "</li>").join("") + "</ul>"; }

function agentBlock(a) {
  const zeilen = [
    ["Display Name", code(a.displayName)],
    ["Vendor", code(a.vendor)],
    a.description ? ["Description", code(a.description)] : null,
    a.installCommandLine ? ["Install Command Line", code(a.installCommandLine)] : null,
    a.silentInstallParameters ? ["Silent Install Parameters", code(a.silentInstallParameters)] : null,
    a.installedAppsName ? ["Installed Apps Name", code(a.installedAppsName)] : null,
    a.version ? ["Version", code(a.version) + (a.versionQuelle ? ' <span class="alt">(' + esc(a.versionQuelle) + ")</span>" : "")] : null,
    a.uninstall ? ["Uninstall", esc(a.uninstall)] : null,
    a.zielgruppe ? ["Zielgruppe", code(a.zielgruppe) + ' <span class="alt">(Intent Required)</span>'] : null
  ].filter(Boolean);

  let h = "<h3>" + esc(a.titel) + (a.pflicht ? "" : ' <span class="alt">(kundenabhängig)</span>') + "</h3>";
  if (a.herkunft) h += "<p>" + esc(a.herkunft) + "</p>";
  if (a.bedingung) h += "<p><strong>Einsatz:</strong> " + esc(a.bedingung) + "</p>";
  h += table(["Feld", "Wert"], zeilen.map(z => ["<strong>" + esc(z[0]) + "</strong>", z[1]]));

  if (a.erkennung) {
    const e = a.erkennung, teile = [];
    if (e.pfad) teile.push("Pfad " + code(e.pfad));
    if (e.datei) teile.push("Datei " + code(e.datei));
    if (e.vergleich) teile.push(esc(e.vergleich));
    h += "<p><strong>Erkennung:</strong> " + esc(e.empfohlen) + (teile.length ? " — " + teile.join(", ") : "");
    if (e.warum) h += '<br><span class="alt">' + esc(e.warum) + "</span>";
    h += "</p>";
  }
  if (a.zweiteiligkeit) {
    h += "<p><strong>Besteht aus mehreren Teilen:</strong></p>"
      + table(["Teil", "Weg", "Zuweisung an"], a.zweiteiligkeit.map(t => [esc(t.teil), esc(t.weg), esc(t.ziel)]));
  }
  if (a.region) {
    h += "<p><strong>Server-Region:</strong> EU " + code(a.region.eu.base) + ", US " + code(a.region.us.base)
      + '<br><span class="alt">' + esc(a.region.hinweis) + "</span></p>";
  }
  if (a.tokenFormat) {
    h += "<p><strong>Installer-Token:</strong> " + esc(a.tokenFormat.beschreibung) + "</p>"
      + "<pre>" + esc(a.tokenFormat.urlMuster) + "</pre>"
      + '<p class="alt">Prüfen ohne Ausführen: ' + code(a.tokenFormat.pruefen) + "</p>";
  }
  if (a.fallstricke && a.fallstricke.length) {
    h += "<p><strong>Fallstricke:</strong></p>" + list(a.fallstricke.map(esc));
  }
  return h;
}

/** HTML-Fragment — das, was die Wissensseite im Werkzeug zeigt. */
function renderSections(b) {
  const m = b.meta || {};
  const ca = b.customApp || {};
  const oib = b.oib || {};
  const mail = b.mailHaertung || {};
  const reg = b.entscheidungsregeln || {};
  const ns = b.namensschema || {};

  return `
<h2 id="bl-meta">Baseline ${esc(m.version)}</h2>
<p>${esc(m.zweck)} <span class="alt">Gültig ab ${esc(m.gueltigAb)}.</span></p>
<p class="alt">${esc(m.hinweis || "")}</p>

<h2 id="bl-agents">Pflichtmodule je Kunde</h2>
<p>Diese Agents gehören auf jeden Standard-Client. Die Zielgruppen sind nach der eingestellten
Namenskonvention ausgerechnet — so heissen sie in diesem Tenant wirklich.</p>
${(b.agents || []).map(agentBlock).join("")}

<h2 id="bl-customapp">Grundgerüst für jede Custom App</h2>
<p>${esc(ca.beschreibung || "")}</p>
${table(["Feld", "Sollwert", "Warum"], (ca.felder || []).map(f => ["<strong>" + esc(f.feld) + "</strong>", esc(f.soll), esc(f.warum)]))}
<h3>Rückgabecodes</h3>
${table(["Code", "Typ", "Bedeutung"], (ca.rueckgabecodes || []).map(r => [code(r.code), esc(r.typ), esc(r.bedeutung)]))}
<h3>Zuweisung</h3>
${list((ca.zuweisung || []).map(esc))}

<h2 id="bl-oib">OpenIntuneBaseline</h2>
<p>${esc(oib.aussage || "")}</p>
<h3>Bewusste Abweichungen von CIS</h3>
${table(["Bereich", "Warum nicht umgesetzt", "Kompensation"], (oib.cisDelta || []).map(d => ["<strong>" + esc(d.bereich) + "</strong>", esc(d.warum), esc(d.kompensation)]))}
<h3>Break-Risk-Policies — vor dem Scharfstellen testen</h3>
${table(["Policy", "Bricht potenziell", "Risiko"], (oib.breakRisk || []).map(r => ["<strong>" + esc(r.policy) + "</strong>", esc(r.brichtPotenziell), esc(r.risiko)]))}
<h3>Assignment-Filter statt Versionsgruppen</h3>
<p>${esc(oib.assignmentFilter ? oib.assignmentFilter.zweck : "")}</p>
<pre>${esc(oib.assignmentFilter ? oib.assignmentFilter.regel : "")}</pre>
<p class="alt">${esc(oib.zuweisungslogik || "")}</p>

<h2 id="bl-onboarding">Onboarding-Checkliste</h2>
${table(["Punkt", "Vorgabe"], (b.onboarding || []).map(o => ["<strong>" + esc(o.punkt) + "</strong>", esc(o.vorgabe)]))}

<h2 id="bl-mail">Mail-Härtung ohne <code>BP_</code>-Objekt</h2>
<p><strong>Warum kein eigenes Objekt:</strong> ${esc(mail.warumKeinBpObjekt || "")}</p>
<h3>Ausgehender Spam <span class="alt">CIS ${esc(mail.ausgehenderSpam ? mail.ausgehenderSpam.cis : "")}</span></h3>
${table(["Einstellung", "Soll", "Hinweis"], ((mail.ausgehenderSpam || {}).werte || []).map(w => [code(w.einstellung), "<strong>" + esc(w.soll) + "</strong>", esc(w.hinweis || "")]))}
${list(((mail.ausgehenderSpam || {}).hinweise || []).map(esc))}
<h3>Organisationseinstellungen <span class="alt">CIS ${esc(mail.organisation ? mail.organisation.cis : "")}</span></h3>
${table(["Massnahme", "Wie", "Vorher erheben", "Hinweis"], ((mail.organisation || {}).massnahmen || []).map(x => ["<strong>" + esc(x.was) + "</strong>", code(x.cmdlet), esc(x.vorher), esc(x.hinweis)]))}

<h2 id="bl-regeln">Entscheidungsregeln</h2>
<h3>Welches Tier?</h3>
${list((reg.tier || []).map(t => esc(t.frage) + " → <strong>" + esc(t.ja) + "</strong>" + (t.sonst ? ", sonst <strong>" + esc(t.sonst) + "</strong>" : "")))}
<h3>Cloud Kerberos Trust nötig?</h3>
${list((reg.cloudKerberos || []).map(k => esc(k.frage) + (k.nein ? " → <strong>Nein:</strong> " + esc(k.nein) : "") + (k.ja ? " <strong>Ja:</strong> " + esc(k.ja) : "")))}

<h2 id="bl-namen">Namensschema</h2>
<p>Profil <strong>${esc(ns.profil)}</strong>${ns.eigeneMuster ? " mit eigenen Mustern" : ""} — Quelle: ${esc(ns.quelle)}.
Geändert wird das im Tab <strong>Namenskonvention</strong>, nicht in dieser Datei.</p>
${table(["Objekt", "Muster", "Beispiel"], (ns.beispiele || []).map(p => [esc(p.label), code(p.template), code(p.example)]))}
`;
}

const CSS = `
:root{--bg:#fff;--surface:#f4f8fa;--border:#d7e3e8;--ink:#10242c;--muted:#5d7581;--accent:#0081ad;--code:#eef4f7}
@media (prefers-color-scheme:dark){:root{--bg:#0e191f;--surface:#142229;--border:#273d47;--ink:#dfeaef;--muted:#8ba3ae;--accent:#45b0d3;--code:#16262e}}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--ink);font:16px/1.6 "IBM Plex Sans","Segoe UI",system-ui,sans-serif;margin:0;padding:0 20px}
.wrap{max-width:940px;margin:0 auto;padding:40px 0 80px}
header{border-bottom:2px solid var(--accent);padding-bottom:16px;margin-bottom:24px}
h1{font-size:30px;margin:0 0 6px;letter-spacing:-.01em}
h2{font-size:22px;margin:40px 0 12px;padding-bottom:6px;border-bottom:1px solid var(--border)}
h3{font-size:17px;margin:26px 0 8px}
p,ul{max-width:72ch}
code{font-family:"IBM Plex Mono",Consolas,monospace;font-size:.86em;background:var(--code);border:1px solid var(--border);border-radius:4px;padding:1px 5px}
pre{background:var(--code);border:1px solid var(--border);border-radius:8px;padding:12px 14px;overflow-x:auto;font-family:"IBM Plex Mono",Consolas,monospace;font-size:12.5px}
.tablewrap{overflow-x:auto;border:1px solid var(--border);border-radius:10px;margin:14px 0}
table{border-collapse:collapse;width:100%;font-size:14.5px}
th,td{text-align:left;padding:9px 13px;border-bottom:1px solid var(--border);vertical-align:top}
tr:last-child td{border-bottom:0}
th{font-size:11.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);background:var(--surface)}
.alt{color:var(--muted);font-size:13px}
.meta{color:var(--muted);font-size:14px;margin:0}
nav.toc{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px 18px;margin:20px 0}
nav.toc a{color:var(--accent);text-decoration:none;margin-right:14px;font-size:14px;white-space:nowrap}
footer{margin-top:50px;padding-top:14px;border-top:1px solid var(--border);color:var(--muted);font-size:13px}
@media print{nav.toc{display:none}body{font-size:11pt}.tablewrap,pre{break-inside:avoid}}
`;

/** Eigenständiges Dokument — zum Weitergeben, Drucken, Archivieren. */
function renderDocument(b, opts) {
  opts = opts || {};
  const m = b.meta || {};
  const stand = opts.stand || new Date().toISOString().slice(0, 10);
  const toc = [
    ["#bl-agents", "Pflichtmodule"], ["#bl-customapp", "Custom App"], ["#bl-oib", "OpenIntuneBaseline"],
    ["#bl-onboarding", "Onboarding"], ["#bl-mail", "Mail-Härtung"], ["#bl-regeln", "Entscheidungsregeln"],
    ["#bl-namen", "Namensschema"]
  ].map(t => '<a href="' + t[0] + '">' + esc(t[1]) + "</a>").join("");

  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(m.titel || "Baseline")} ${esc(m.version)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap">
<style>${CSS}</style></head>
<body><div class="wrap">
<header>
  <h1>${esc(m.titel || "Baseline")}</h1>
  <p class="meta">Version ${esc(m.version)} · gültig ab ${esc(m.gueltigAb)} · erzeugt am ${esc(stand)}${opts.tenantName ? " · Namensschema des Tenants " + esc(opts.tenantName) : ""}</p>
</header>
<nav class="toc">${toc}</nav>
${renderSections(b)}
<footer>igeeks AG · intern — erzeugt aus <code>baseline.json</code>, Version ${esc(m.version)}. Änderungen laufen über einen Commit mit Review, nicht über diese Datei.</footer>
</div></body></html>`;
}

module.exports = { renderSections, renderDocument };
