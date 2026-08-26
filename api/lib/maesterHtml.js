"use strict";
/**
 * Kundenfaehiger HTML-Report fuer ein Maester-Security-Audit — EINE
 * selbsttragende Datei (Inline-CSS, Logo als data-URI, keine Skripte), damit
 * sie als Mail-Anhang verschickt und ueberall geoeffnet werden kann.
 *
 * Gegenueber dem PDF: Accordions (<details>) fuer Findings und Skips — bei
 * vielen Befunden bleibt die Uebersicht erhalten. Bewusst wenig vorab
 * aufgeklappt: nur kritische/hohe Findings starten offen.
 *
 * Gleiche Datenbasis wie der PDF (collectMaesterReportData in server.js),
 * gleiche igeeks-Gestaltungsregeln: Petrol #0081ad, nummerierte Kapitel.
 */
const path = require("path");
const fs = require("fs");

const ACCENT = "#0081ad";
const LOGO_PATH = path.join(__dirname, "..", "assets", "igeeks-logo.png");
let LOGO_URI = null;
try { LOGO_URI = "data:image/png;base64," + fs.readFileSync(LOGO_PATH).toString("base64"); } catch (e) { /* Text-Fallback */ }

const SEV_LABEL = { critical: "Kritisch", high: "Hoch", medium: "Mittel", low: "Niedrig", info: "Info" };
const SEV_CLASS = { critical: "crit", high: "high", medium: "med", low: "low", info: "info" };
const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const sevKey = (s) => String(s || "").toLowerCase();
const sevRank = (s) => SEV_ORDER[sevKey(s)] ?? 5;

// Skip-Gruende — gleiche Uebersetzungen wie im PDF (maesterPdf.skipReasonLabel).
function skipReasonLabel(reason) {
  const r = String(reason || "").trim();
  const map = {
    NotLicensedEntraIDP2: "Lizenz erforderlich: Microsoft Entra ID P2",
    NotLicensedEntraIDP2OrGovernance: "Lizenz erforderlich: Entra ID P2 oder ID Governance",
    NotLicensedEntraIDGovernance: "Lizenz erforderlich: Microsoft Entra ID Governance",
    NotLicensedCustomerLockbox: "Lizenz erforderlich: Customer Lockbox (Microsoft 365 E5)",
    NotConnectedSecurityCompliance: "Security-&-Compliance-Verbindung stand beim Lauf nicht zur Verfügung",
    NotConnectedExchange: "Exchange-Online-Verbindung stand beim Lauf nicht zur Verfügung",
    NotConnectedTeams: "Teams-Verbindung stand beim Lauf nicht zur Verfügung",
    NotConnectedSharePoint: "SharePoint-Verbindung stand beim Lauf nicht zur Verfügung",
    NotConnectedAzure: "Kein Azure-Log-Export eingerichtet (Sentinel/SIEM) — Prüfung nicht anwendbar",
    NotConnectedGitHub: "Nicht zutreffend (GitHub-spezifische Tests)",
    NotDotGovDomain: "Nicht zutreffend (nur für US-Behörden relevant)",
    Custom: "Manuelle Prüfung erforderlich (nicht automatisiert bewertbar)"
  };
  if (map[r]) return map[r];
  if (/^NotLicensed/i.test(r)) return "Lizenz erforderlich: " + r.replace(/^NotLicensed/i, "");
  if (/^NotConnected/i.test(r)) return "Verbindung nicht verfügbar: " + r.replace(/^NotConnected/i, "");
  return r || "Ohne Grundangabe";
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return String(d.getDate()).padStart(2, "0") + "." + String(d.getMonth() + 1).padStart(2, "0") + "." + d.getFullYear();
}

// Maester-Markdown -> HTML. Gleiches Verhalten wie der PDF-Renderer: Tabellen,
// Codefences UND unfenced PowerShell, Links klickbar, fortlaufende Nummerierung.
function mdToHtml(src) {
  if (!src) return "";
  let text = esc(String(src).replace(/\r\n/g, "\n"));
  const blocks = [];
  text = text.replace(/```[a-zA-Z]*\n([\s\S]*?)```/g, (m, code) => {
    blocks.push(code.replace(/\n+$/, ""));
    return "\n@@CODE" + (blocks.length - 1) + "@@\n";
  }).replace(/```[a-zA-Z]*\n?/g, "");

  const inline = (s) => s
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, t, u) => `<a href="${u.replace(/&amp;/g, "&")}" target="_blank" rel="noreferrer">${t}</a>`)
    .replace(/\[([^\]]*)\]\([^)]*$/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/\*\*/g, "")
    .replace(/`([^`]+)`/g, "<code>$1</code>");

  const looksLikeCode = (l) =>
    /^\s*(\$\w|@\{|\}\s*$|["']?\w[\w.]*["']?\s*=\s*)/.test(l) ||
    /^\s*(New|Set|Get|Connect|Disconnect|Update|Invoke|Remove|Add|Enable|Disable|Import|Install)-[A-Z]/.test(l);

  const out = [];
  let list = null, table = null, codeBuf = null, olCounter = 0;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const flushCode = () => { if (codeBuf) { out.push(`<pre>${codeBuf.join("\n")}</pre>`); codeBuf = null; } };
  const flushTable = () => {
    if (!table) return;
    const rows = table.filter(r => !/^[\s|:\-]+$/.test(r.replace(/\|/g, "")))
      .map(r => r.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map(c => inline(c.trim())));
    table = null;
    if (rows.length < 2) return;
    const cellCls = (c) => /^(Pass|OK|True)$/i.test(c) ? ' class="ok"' : /^Fail(ed)?$/i.test(c) ? ' class="bad"' : /^Skip(ped)?$/i.test(c) ? ' class="warn"' : "";
    out.push('<table><thead><tr>' + rows[0].map(c => `<th>${c}</th>`).join("") + "</tr></thead><tbody>" +
      rows.slice(1).map(r => "<tr>" + r.map(c => `<td${cellCls(c.replace(/<[^>]+>/g, ""))}>${c}</td>`).join("") + "</tr>").join("") +
      "</tbody></table>");
  };

  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    let m;
    if ((m = line.match(/^@@CODE(\d+)@@$/))) { closeList(); flushTable(); flushCode(); olCounter = 0; out.push(`<pre>${blocks[Number(m[1])]}</pre>`); continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) { closeList(); flushCode(); (table ??= []).push(line); continue; }
    flushTable();
    if (looksLikeCode(line)) { closeList(); (codeBuf ??= []).push(line); continue; }
    flushCode();
    if (line.trim() === "") { closeList(); continue; }
    if ((m = line.match(/^#{1,6}\s+(.*)$/))) { closeList(); olCounter = 0; out.push(`<p class="mdh">${inline(m[1])}</p>`); continue; }
    if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) {
      olCounter += 1;
      if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; }
      out.push(`<li value="${olCounter}">${inline(m[1])}</li>`); continue;
    }
    if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; }
      out.push(`<li>${inline(m[1])}</li>`); continue;
    }
    closeList();
    if ((m = line.match(/^&gt;\s?(.*)$/))) { olCounter = 0; out.push(`<p class="quote">${inline(m[1])}</p>`); continue; }
    olCounter = 0;
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList(); flushTable(); flushCode();
  return out.join("\n");
}

function buildHtml(data) {
  const c = data.counts || {};
  const rated = (c.passed || 0) + (c.failed || 0);
  const findings = [...(data.findings || [])].sort((a, b) => sevRank(a.severity) - sevRank(b.severity));
  const skipped = data.skipped || [];
  const critHigh = findings.filter(f => ["critical", "high"].includes(sevKey(f.severity))).length;
  const scoreCls = data.score == null ? "" : data.score >= 80 ? "ok" : data.score >= 60 ? "warn" : "bad";

  const bySev = {};
  for (const f of findings) { const k = sevKey(f.severity) || "info"; bySev[k] = (bySev[k] || 0) + 1; }
  const sevKeys = Object.keys(bySev).sort((a, b) => sevRank(a) - sevRank(b));
  const maxSev = Math.max(1, ...sevKeys.map(k => bySev[k]));

  const findingHtml = (f, i) => {
    const k = sevKey(f.severity);
    const open = ["critical", "high"].includes(k) ? " open" : "";
    const body = f.bedeutung
      ? `<p>${esc(f.bedeutung)}</p>` +
        (Array.isArray(f.umsetzung) && f.umsetzung.length
          ? `<p class="mdh">Empfohlene Umsetzung${f.aufwand ? ` (Aufwand: ${esc(f.aufwand)})` : ""}</p><ol>` +
            f.umsetzung.map(s => `<li>${esc(s)}</li>`).join("") + "</ol>"
          : "")
      : (mdToHtml(f.description) +
         (f.result ? `<p class="mdh">Befund im Tenant</p>` + mdToHtml(f.result) : ""));
    return `<details class="finding${open ? " sev-open" : ""}"${open}>
      <summary><span class="num">2.${i + 1}</span><span class="sev ${SEV_CLASS[k] || "info"}">${esc(SEV_LABEL[k] || f.severity || "Info")}</span><span class="ft">${esc(f.titel || f.title || f.id)}</span></summary>
      <div class="fbody">${body}${f.helpUrl ? `<p class="ref">Referenz: <a href="${esc(f.helpUrl)}" target="_blank" rel="noreferrer">${esc(f.helpUrl)}</a></p>` : ""}</div>
    </details>`;
  };

  // Skips nach Grund gruppieren
  const groups = new Map();
  for (const sItem of skipped) {
    const label = skipReasonLabel(sItem.reason);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(sItem);
  }

  const da = data.domainAuth || [];
  const daStat = (o) => {
    const st = (o || {}).status;
    return st === "ok" ? '<td class="ok">OK</td>' : st === "warn" ? '<td class="warn">Warnung</td>' : '<td class="bad">Problem</td>';
  };
  const daIssues = [];
  for (const d of da) {
    for (const [name, o] of [["SPF", d.spf], ["DKIM", d.dkim], ["DMARC", d.dmarc]]) {
      if (o && o.status !== "ok" && o.issues && o.issues.length) daIssues.push(`${d.domain} · ${name}: ${o.issues[0]}`);
    }
  }

  let chapter = 0;
  const h2 = (t) => { chapter += 1; return `<h2><span>${chapter}</span>${esc(t)}</h2>`; };

  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Security-Audit ${esc(data.tenantName || "")} — igeeks AG</title>
<style>
  :root { --accent: ${ACCENT}; --text: #373737; --muted: #707070; --line: #dfe4e8; --ok: #2e7d32; --warn: #b45309; --bad: #b3261e; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "Segoe UI", -apple-system, Roboto, Arial, sans-serif; color: var(--text); background: #f5f7f8; line-height: 1.55; }
  .topbar { height: 10px; background: var(--accent); }
  .page { max-width: 860px; margin: 0 auto; padding: 28px 34px 60px; background: #fff; }
  header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; padding: 10px 0 22px; border-bottom: 1px solid var(--line); }
  header img { width: 140px; height: auto; }
  header .meta { text-align: right; color: var(--muted); font-size: 13px; }
  h1 { font-size: 26px; margin: 26px 0 2px; }
  h1 .sub { color: var(--accent); }
  .tenant { font-size: 17px; font-weight: 600; margin: 8px 0 0; }
  .tsub { color: var(--muted); font-size: 13px; margin: 2px 0 0; }
  h2 { font-size: 19px; margin: 34px 0 12px; padding-bottom: 6px; border-bottom: 1px solid var(--line); }
  h2 span { color: var(--accent); margin-right: 12px; }
  .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin: 14px 0 6px; }
  .kpi { border: 1px solid var(--line); border-radius: 8px; padding: 12px 8px; text-align: center; }
  .kpi b { display: block; font-size: 24px; }
  .kpi span { font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); }
  .ok { color: var(--ok); } .warn { color: var(--warn); } .bad { color: var(--bad); }
  .hint { color: var(--muted); font-size: 12.5px; }
  .sevbar { display: flex; align-items: center; gap: 10px; margin: 4px 0; font-size: 13.5px; }
  .sevbar .lbl { width: 90px; }
  .sevbar .bar { height: 12px; border-radius: 4px; }
  .sevbar .n { font-weight: 700; }
  .bar.crit { background: var(--bad); } .bar.high { background: #c2410c; } .bar.med { background: var(--warn); } .bar.low { background: #4d7c0f; } .bar.info { background: var(--muted); }
  details.finding { border: 1px solid var(--line); border-radius: 8px; margin: 10px 0; background: #fff; }
  details.finding > summary { display: flex; align-items: center; gap: 12px; padding: 11px 14px; cursor: pointer; list-style: none; }
  details.finding > summary::-webkit-details-marker { display: none; }
  details.finding > summary::after { content: "▸"; margin-left: auto; color: var(--muted); }
  details[open].finding > summary::after { content: "▾"; }
  .num { color: var(--accent); font-weight: 700; min-width: 34px; }
  .sev { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; padding: 2px 8px; border-radius: 10px; color: #fff; flex-shrink: 0; }
  .sev.crit { background: var(--bad); } .sev.high { background: #c2410c; } .sev.med { background: var(--warn); } .sev.low { background: #4d7c0f; } .sev.info { background: var(--muted); }
  .ft { font-weight: 600; }
  .fbody { padding: 4px 16px 14px 60px; border-top: 1px solid var(--line); font-size: 14px; }
  .fbody p { margin: 8px 0; }
  .mdh { font-weight: 700; margin-top: 14px !important; }
  .quote { color: var(--muted); border-left: 3px solid var(--line); padding-left: 10px; }
  .ref { font-size: 12.5px; color: var(--muted); }
  pre { background: #f1f4f6; border: 1px solid var(--line); border-radius: 6px; padding: 10px 12px; font-size: 12.5px; overflow-x: auto; font-family: Consolas, Menlo, monospace; white-space: pre-wrap; word-break: break-word; }
  code { background: #f1f4f6; border-radius: 4px; padding: 1px 5px; font-size: 0.92em; font-family: Consolas, Menlo, monospace; }
  table { border-collapse: collapse; width: 100%; margin: 10px 0; font-size: 13px; }
  th { text-align: left; background: #f0f4f6; color: var(--muted); text-transform: uppercase; font-size: 11px; letter-spacing: 0.04em; padding: 7px 9px; }
  td { padding: 7px 9px; border-bottom: 1px solid var(--line); }
  td.ok, td .ok { color: var(--ok); font-weight: 700; } td.bad { color: var(--bad); font-weight: 700; } td.warn { color: var(--warn); font-weight: 700; }
  a { color: var(--accent); }
  details.skipgrp { border: 1px solid var(--line); border-radius: 8px; margin: 8px 0; }
  details.skipgrp > summary { padding: 10px 14px; cursor: pointer; font-weight: 600; font-size: 14px; }
  details.skipgrp ul { margin: 0 0 12px; padding: 0 16px 0 34px; font-size: 13.5px; color: var(--muted); }
  .cta { background: #e9f4f8; border-left: 4px solid var(--accent); border-radius: 8px; padding: 18px 22px; margin: 16px 0; }
  .cta h3 { margin: 0 0 8px; color: var(--accent); font-size: 17px; }
  footer { margin-top: 40px; padding-top: 12px; border-top: 1px solid var(--line); color: var(--muted); font-size: 12px; display: flex; justify-content: space-between; }
  @media print { body { background: #fff; } .page { max-width: none; padding: 0; } details { page-break-inside: avoid; } }
</style>
</head>
<body>
<div class="topbar"></div>
<div class="page">
  <header>
    ${LOGO_URI ? `<img src="${LOGO_URI}" alt="igeeks AG">` : `<div><strong style="color:var(--accent)">igeeks AG</strong><br><span class="hint">Microsoft-365- und Security-Consulting</span></div>`}
    <div class="meta">Vertraulich — nur für den Empfänger bestimmt.<br>Prüfdatum: ${fmtDate(data.generatedAt)}</div>
  </header>

  <h1>Microsoft 365 <span class="sub">Security-Audit</span></h1>
  <p class="tenant">${esc(data.tenantName || "—")}</p>
  ${data.organization ? `<p class="tsub">${esc(data.organization)}</p>` : ""}

  ${h2("Management-Zusammenfassung")}
  <div class="kpis">
    <div class="kpi"><b class="${scoreCls}">${data.score == null ? "—" : data.score + "%"}</b><span>Security-Score</span></div>
    <div class="kpi"><b class="ok">${c.passed ?? "—"}</b><span>Bestanden</span></div>
    <div class="kpi"><b class="${(c.failed || 0) > 0 ? "bad" : "ok"}">${c.failed ?? "—"}</b><span>Handlungsbedarf</span></div>
    <div class="kpi"><b>${c.skipped ?? 0}</b><span>Nicht bewertbar</span></div>
  </div>
  <p class="hint">Der Score setzt bestandene Tests ins Verhältnis zu allen bewerteten (${rated}). Nicht bewertbare Tests (fehlende Lizenz, nicht zutreffende Konfiguration) fliessen nicht ein.</p>
  ${sevKeys.length ? sevKeys.map(k => `<div class="sevbar"><span class="lbl">${SEV_LABEL[k] || "Ohne Angabe"}</span><span class="bar ${SEV_CLASS[k] || "info"}" style="width:${Math.max(4, Math.round(bySev[k] / maxSev * 55))}%"></span><span class="n">${bySev[k]}</span></div>`).join("") : ""}
  <p>Von ${rated} bewerteten Tests wurden ${c.passed ?? 0} bestanden. ${findings.length} Punkte erfordern Handlungsbedarf${critHigh ? `, davon ${critHigh} mit hoher oder kritischer Einstufung — diese sollten priorisiert angegangen werden` : ""}.${c.skipped ? ` ${c.skipped} Tests waren im Tenant nicht bewertbar (Kapitel weiter unten).` : ""}</p>

  ${(() => {
    const sr = data.statusReport;
    if (!sr || !sr.sections) return "";
    const stateCls = (st) => st === "crit" ? "bad" : st === "warn" ? "warn" : "ok";
    const stateWord = (st) => st === "crit" ? "Kritisch" : st === "warn" ? "Hinweis" : "OK";
    const secs = Object.values(sr.sections);
    return h2("Tenant-Status im Überblick") + `
  <p class="hint">Kennzahlen aus dem igeeks-Statusreport vom ${fmtDate(sr.generatedAt)} — Lizenzen, Conditional Access, Identitäten, Geräte und Intune-Baseline auf einen Blick.</p>
  ${secs.map(sec => sec.ok
    ? `<details class="skipgrp"${(sec.metrics || []).some(m => m.state !== "ok") ? " open" : ""}><summary>${esc(sec.label)}${(sec.metrics || []).some(m => m.state === "crit") ? ' <span class="bad">— kritisch</span>' : (sec.metrics || []).some(m => m.state === "warn") ? ' <span class="warn">— Hinweise</span>' : ""}</summary>
      <table><thead><tr><th>Kennzahl</th><th>Wert</th><th>Bewertung</th><th>Hinweis</th></tr></thead><tbody>
      ${(sec.metrics || []).map(m => `<tr><td>${esc(m.label)}</td><td><strong>${esc(m.value ?? "—")}</strong></td><td class="${stateCls(m.state)}">${stateWord(m.state)}</td><td class="hint">${esc(m.detail || "")}</td></tr>`).join("")}
      </tbody></table>
      ${(sec.lists || []).map(l => `<p class="mdh" style="padding:0 16px">${esc(l.label)}${l.more ? ` <span class="hint">(erste ${l.rows.length} von ${l.rows.length + l.more})</span>` : ""}</p>
        <div style="padding:0 16px 8px"><table><thead><tr>${(l.columns || []).map(cH => `<th>${esc(cH)}</th>`).join("")}</tr></thead><tbody>
        ${(l.rows || []).map(r => `<tr>${r.map(cell => `<td>${esc(cell)}</td>`).join("")}</tr>`).join("")}
        </tbody></table></div>`).join("")}
      </details>`
    : `<details class="skipgrp"><summary>${esc(sec.label)} <span class="warn">— nicht abrufbar</span></summary><ul><li>${esc(sec.error || "Keine Daten")}</li></ul></details>`
  ).join("\n")}`;
  })()}

  ${h2(`Handlungsbedarf im Detail (${findings.length})`)}
  ${findings.length
    ? `<p class="hint">Kritische und hohe Punkte sind aufgeklappt — alles Weitere per Klick.</p>` + findings.map(findingHtml).join("\n")
    : "<p>Keine Beanstandungen — alle bewerteten Tests wurden bestanden.</p>"}

  ${da.length ? h2("Domain-Authentifizierung (SPF · DKIM · DMARC)") + `
  <p>Ergänzend zur Maester-Testsuite wird die E-Mail-Authentifizierung jeder Maildomain direkt geprüft — die Konfiguration in Exchange Online und die tatsächlich im öffentlichen DNS veröffentlichten Records zusammen.</p>
  <table><thead><tr><th>Domain</th><th>SPF</th><th>DKIM</th><th>DMARC</th></tr></thead><tbody>
  ${da.map(d => `<tr><td><strong>${esc(d.domain)}</strong></td>${daStat(d.spf)}${daStat(d.dkim)}${daStat(d.dmarc)}</tr>`).join("")}
  </tbody></table>
  ${daIssues.length ? `<ul class="hint" style="padding-left:18px">${daIssues.map(i => `<li>${esc(i)}</li>`).join("")}</ul>` : ""}` : ""}

  ${skipped.length ? h2(`Nicht bewertbare Tests (${skipped.length})`) + `
  <p>Diese Tests konnten im Tenant nicht bewertet werden — üblicherweise, weil das geprüfte Produkt nicht lizenziert ist, die Prüfung nicht zutrifft oder eine Dienstverbindung beim Lauf nicht zur Verfügung stand. Sie sind keine Mängel.</p>
  ${[...groups.entries()].map(([label, items]) => `<details class="skipgrp"><summary>${esc(label)} (${items.length})</summary><ul>${items.map(it => `<li>${esc(it.title || it.id)}</li>`).join("")}</ul></details>`).join("\n")}` : ""}

  ${h2("Methodik")}
  <p>Die Prüfung erfolgte automatisiert mit dem Open-Source-Framework Maester (maester.dev)${data.maesterVersion ? `, Version ${esc(data.maesterVersion)}` : ""}. Ausgeführte Testsuiten: ${data.suites && data.suites.length ? esc(data.suites.join(", ")) : "alle Suiten (CISA SCuBA, CIS Microsoft 365, EIDSCA, ORCA, Maester Community)"}. Alle Zugriffe erfolgten ausschliesslich lesend über eine dedizierte, zertifikatsbasierte Anwendung — am Tenant wurde nichts verändert.</p>
  <p>Die Tests basieren auf öffentlichen Sicherheitsbaselines, unter anderem CISA SCuBA, dem CIS Microsoft 365 Foundations Benchmark und dem Entra ID Security Config Analyzer (EIDSCA). Die Testsuiten werden laufend aktualisiert; eine Wiederholungsprüfung nach Umsetzung der Massnahmen wird empfohlen.</p>

  ${h2("Nächste Schritte")}
  <div class="cta">
    <h3>Lassen Sie uns den Report gemeinsam anschauen</h3>
    <p>Wir empfehlen, die Ergebnisse dieses Audits in einem gemeinsamen Termin im Detail zu besprechen: die Befunde für Ihre Umgebung einordnen, Prioritäten festlegen und daraus konkrete, aufeinander abgestimmte Massnahmen ableiten — inklusive Aufwandsschätzung und Umsetzungsplanung durch igeeks. Melden Sie sich dazu einfach bei Ihrem igeeks-Ansprechpartner — wir bereiten den Termin auf Basis dieses Reports vor.</p>
  </div>
  <p class="mdh">Wichtig zur Einordnung der Ergebnisse</p>
  <p class="hint" style="font-size:13.5px">Dieser Report wurde automatisiert nach technisch festgelegten Prüfmechanismen erstellt. In Ihrer Umgebung können bewusst gewählte Richtlinien gelten, die von den Standard-Baselines abweichen und von der automatischen Prüfung nicht als solche erkannt werden. Der Report zeigt deshalb eine Tendenz und potenzielle Verbesserungsmassnahmen auf — ein als «Handlungsbedarf» markierter Punkt ist nicht zwingend ein tatsächliches Problem. Die verbindliche Beurteilung erfolgt in der gemeinsamen Detailbetrachtung; eingreifende Änderungen setzen wir grundsätzlich erst nach Absprache um (Pilotgruppe bzw. Report-only zuerst).</p>

  <footer><span>igeeks AG · Security-Audit ${esc(data.tenantName || "")}</span><span>${fmtDate(data.generatedAt)}</span></footer>
</div>
</body>
</html>`;
}

module.exports = { buildHtml };
