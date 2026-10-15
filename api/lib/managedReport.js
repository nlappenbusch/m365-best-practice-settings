"use strict";
/**
 * Managed Service: Quartalsreport (HTML, druckoptimiert A4 -> PDF im Browser).
 *
 * Quelle sind ausschliesslich die gespeicherten Monitoring-Daten — der Report
 * fragt nichts live ab und laesst sich deshalb auch fuer ein vergangenes
 * Quartal reproduzierbar erzeugen (Verlauf + Befund-Lebenszyklus). Bereiche,
 * die nur einen aktuellen Stand kennen (Massnahmen, Geraeteliste), sind als
 * "Stand <Datum>" gekennzeichnet.
 */
const S = require("./managedService");

const esc = v => String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const SEV_DE = { critical: "Kritisch", high: "Hoch", medium: "Mittel", low: "Niedrig", info: "Info" };
const SEV_COL = { critical: "#c62828", high: "#e07b00", medium: "#0081ad", low: "#6b7c86", info: "#9aa7ae" };

function quarterRange(q) {
  const m = String(q || "").match(/^(\d{4})-Q([1-4])$/);
  if (!m) throw Object.assign(new Error("Quartal im Format JJJJ-Qn angeben."), { status: 400 });
  const y = Number(m[1]), n = Number(m[2]);
  const from = new Date(Date.UTC(y, (n - 1) * 3, 1));
  const to = new Date(Date.UTC(y, n * 3, 1));
  return { from: from.toISOString(), to: to.toISOString(), label: `Q${n} ${y}`, y, n };
}
function currentQuarter(d) { d = d || new Date(); return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`; }
function previousQuarter(d) {
  d = d || new Date();
  let y = d.getUTCFullYear(), n = Math.floor(d.getUTCMonth() / 3) + 1 - 1;
  if (n === 0) { n = 4; y--; }
  return `${y}-Q${n}`;
}

// Kleine Inline-SVG-Linie (keine externen Bibliotheken — der Report muss offline drucken).
function lineChart(points, opts) {
  const w = opts.w || 640, h = opts.h || 150, pad = 28;
  const vals = points.map(p => p.v).filter(v => v !== null && v !== undefined);
  if (vals.length < 2) return `<div class="nochart">Zu wenige Messpunkte im Quartal.</div>`;
  const min = opts.min !== undefined ? opts.min : Math.min(...vals), max = opts.max !== undefined ? opts.max : Math.max(...vals);
  const span = max - min || 1;
  const xs = i => pad + (i * (w - pad * 2)) / Math.max(1, points.length - 1);
  const ys = v => h - pad - ((v - min) / span) * (h - pad * 2);
  let d = "", area = "";
  points.forEach((p, i) => {
    if (p.v === null || p.v === undefined) return;
    d += (d ? " L" : "M") + xs(i).toFixed(1) + " " + ys(p.v).toFixed(1);
  });
  const first = points.findIndex(p => p.v !== null && p.v !== undefined);
  const lastIdx = points.length - 1 - [...points].reverse().findIndex(p => p.v !== null && p.v !== undefined);
  area = d + ` L${xs(lastIdx).toFixed(1)} ${h - pad} L${xs(first).toFixed(1)} ${h - pad} Z`;
  const ticks = [min, min + span / 2, max].map(v => `<text x="4" y="${ys(v) + 4}" class="ax">${Math.round(v * 10) / 10}${opts.unit || ""}</text><line x1="${pad}" x2="${w - pad}" y1="${ys(v)}" y2="${ys(v)}" class="grid"/>`).join("");
  const labels = [0, Math.floor(points.length / 2), points.length - 1].map(i => `<text x="${xs(i)}" y="${h - 6}" text-anchor="middle" class="ax">${esc(String(points[i].d).slice(5).split("-").reverse().join("."))}</text>`).join("");
  const last = vals[vals.length - 1];
  return `<svg viewBox="0 0 ${w} ${h}" class="chart" role="img" aria-label="${esc(opts.label || "Verlauf")}">
    ${ticks}${labels}
    <path d="${area}" fill="${opts.color || "#0081ad"}" opacity=".10"/>
    <path d="${d}" fill="none" stroke="${opts.color || "#0081ad"}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${xs(lastIdx)}" cy="${ys(last)}" r="4" fill="${opts.color || "#0081ad"}"/>
  </svg>`;
}

function bar(label, value, max, color) {
  const pct = max && value ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return `<div class="bar"><span class="bl">${esc(label)}</span><span class="bt"><span style="width:${pct}%;background:${color}"></span></span><span class="bv">${value}</span></div>`;
}

function build(stateDir, tenant, quarter, meta) {
  const q = quarterRange(quarter);
  const tid = tenant.id;
  const all = S.listFindings(stateDir, tid);
  const inQ = iso => iso && iso >= q.from && iso < q.to;
  const opened = all.filter(f => inQ(f.firstSeen));
  const resolved = all.filter(f => inQ(f.resolvedAt));
  // Am Quartalsende offen: vor Ende entstanden und (nicht behoben oder erst danach).
  const openAtEnd = all.filter(f => f.firstSeen < q.to && (f.status !== "resolved" || (f.resolvedAt && f.resolvedAt >= q.to)));
  const ticketed = all.filter(f => f.ticketId && (inQ(f.ticketAt) || inQ(f.firstSeen)));
  const hist = S.readJson(S.file(stateDir, tid, "history.json"), []).filter(x => x.d >= q.from.slice(0, 10) && x.d < q.to.slice(0, 10));
  const data = a => (S.areaData(stateDir, tid, a) || {}).data || null;
  // Teil-Daten (Bereich nie gelaufen / fehlgeschlagen) duerfen den Report nicht brechen.
  const L = v => Array.isArray(v) ? v : [];
  const withDef = (o, def) => o ? { ...def, ...o } : null;
  const score = withDef(data("score"), { trend: [], measures: [], comparative: {} });
  const devices = withDef(data("devices"), { rate: null, noncompliant: [] });
  const lic0 = data("licenses");
  const lic = lic0 && lic0.totals ? withDef(lic0, { skus: [], drift: [] }) : null;
  const risk = withDef(data("risk"), { riskyUsers: [], detections: [] });
  const mailboxes = withDef(data("mailboxes"), { rules: [], mailboxForwarding: [], perUser: [], scanned: 0, total: 0, forwarding: null });
  const senders = withDef(data("senderlists"), { junk: [] });
  const sharing = withDef(data("sharing"), { recent: [] });
  const msgs = withDef(data("messages"), { messages: [] });
  const consent = withDef(data("consent"), { requests: [] });
  if (score && !score.current) score.current = null;
  const status = S.readJson(S.file(stateDir, tid, "status.json"), {});

  const sevCount = list => Object.fromEntries(["critical", "high", "medium", "low"].map(s => [s, list.filter(f => f.severity === s).length]));
  const oc = sevCount(opened), rc = sevCount(resolved), ec = sevCount(openAtEnd);
  const maxSev = Math.max(1, ...Object.values(oc), ...Object.values(rc));
  const byArea = S.AREAS.map(a => ({ a, opened: opened.filter(f => f.area === a.id).length, resolved: resolved.filter(f => f.area === a.id).length, open: openAtEnd.filter(f => f.area === a.id).length }))
    .filter(x => x.opened || x.resolved || x.open);
  const mttr = (() => {
    const d = resolved.map(f => (new Date(f.resolvedAt) - new Date(f.firstSeen)) / 3600000).filter(x => x >= 0);
    if (!d.length) return null;
    d.sort((a, b) => a - b);
    return Math.round(d[Math.floor(d.length / 2)]);
  })();

  const scoreStart = hist.find(x => x.score !== null && x.score !== undefined);
  const scoreEnd = [...hist].reverse().find(x => x.score !== null && x.score !== undefined);
  const scoreDelta = scoreStart && scoreEnd ? Math.round((scoreEnd.score - scoreStart.score) * 10) / 10 : null;
  // Score-Verlauf: History (eigene Tageswerte) ergaenzt um den Microsoft-Verlauf, falls im Quartal.
  const scorePts = (() => {
    const m = new Map();
    for (const t of L(score && score.trend)) if (t.d >= q.from.slice(0, 10) && t.d < q.to.slice(0, 10)) m.set(t.d, t.pct);
    for (const x of hist) if (x.score !== null && x.score !== undefined) m.set(x.d, x.score);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([d, v]) => ({ d, v }));
  })();

  const crit = openAtEnd.filter(f => f.severity === "critical" || f.severity === "high").sort((a, b) => S.SEV_RANK[b.severity] - S.SEV_RANK[a.severity]).slice(0, 12);
  const measures = (score && score.current ? L(score.measures) : []).slice(0, 8);
  const relevantMsgs = L(msgs && msgs.messages).filter(m => !m.notInTenant && m.relevance === "hoch").slice(0, 8);

  const stand = a => status[a] && status[a].at ? new Date(status[a].at).toLocaleDateString("de-CH") : "—";
  const kpi = (label, value, sub, tone) => `<div class="kpi ${tone || ""}"><div class="kv">${esc(value)}</div><div class="kl">${esc(label)}</div>${sub ? `<div class="ks">${esc(sub)}</div>` : ""}</div>`;
  const generated = new Date().toLocaleString("de-CH");
  const brand = (meta && meta.brand) || "igeeks AG";

  const verdict = (() => {
    if (ec.critical) return { tone: "bad", text: `${ec.critical} kritische${ec.critical === 1 ? "r" : ""} Befund${ec.critical === 1 ? "" : "e"} am Quartalsende offen — Handlungsbedarf.` };
    if (ec.high) return { tone: "warn", text: `Keine kritischen Befunde offen, ${ec.high} mit hoher Priorität in Bearbeitung.` };
    return { tone: "good", text: "Keine kritischen oder hohen Befunde offen. Die Umgebung ist im Soll." };
  })();

  return `<!doctype html>
<html lang="de-CH"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Managed M365 · ${esc(tenant.name)} · ${esc(q.label)}</title>
<style>
  :root{--brand:#0081ad;--ink:#1d2a31;--dim:#5a6b74;--rule:#dbe3e7;--wash:#eef6f9;--bad:#c62828;--warn:#e07b00;--good:#2e7d32}
  *{box-sizing:border-box}
  body{margin:0;font:13px/1.5 "Segoe UI",system-ui,-apple-system,sans-serif;color:var(--ink);background:#f3f6f8}
  .page{max-width:900px;margin:24px auto;background:#fff;box-shadow:0 2px 18px rgba(0,0,0,.08)}
  .cover{background:linear-gradient(135deg,#00698e 0%,#0081ad 55%,#2bb3d9 100%);color:#fff;padding:46px 48px 38px;position:relative;overflow:hidden}
  .cover:after{content:"";position:absolute;right:-80px;top:-80px;width:320px;height:320px;border-radius:50%;background:rgba(255,255,255,.08)}
  .cover .eyebrow{letter-spacing:.18em;font-size:11px;font-weight:700;opacity:.85}
  .cover h1{font-size:30px;margin:8px 0 4px;letter-spacing:-.02em}
  .cover .sub{font-size:15px;opacity:.92}
  .cover .meta{margin-top:26px;display:flex;gap:28px;font-size:12px;opacity:.9;flex-wrap:wrap}
  .cover .meta b{display:block;font-size:14px}
  section{padding:26px 48px;border-bottom:1px solid var(--rule);break-inside:avoid-page}
  h2{font-size:17px;margin:0 0 4px;color:var(--brand);letter-spacing:-.01em}
  h2 small{font-weight:500;color:var(--dim);font-size:11px;margin-left:8px}
  .lead{color:var(--dim);margin:0 0 14px}
  .verdict{border-left:5px solid;padding:12px 16px;border-radius:6px;font-size:14px;font-weight:600;margin:14px 0 4px}
  .verdict.bad{border-color:var(--bad);background:#fdecea}.verdict.warn{border-color:var(--warn);background:#fff4e5}.verdict.good{border-color:var(--good);background:#edf7ed}
  .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:14px}
  .kpi{border:1px solid var(--rule);border-radius:10px;padding:12px 14px;border-top:4px solid var(--brand)}
  .kpi.bad{border-top-color:var(--bad)}.kpi.warn{border-top-color:var(--warn)}.kpi.good{border-top-color:var(--good)}
  .kv{font-size:22px;font-weight:700;letter-spacing:-.02em}.kl{font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.06em;font-weight:600}.ks{font-size:11px;color:var(--dim);margin-top:2px}
  .chart{width:100%;height:auto}.chart .ax{font-size:10px;fill:#8a979e}.chart .grid{stroke:#eef1f3}
  .nochart{color:var(--dim);font-style:italic;padding:12px 0}
  .two{display:grid;grid-template-columns:1fr 1fr;gap:22px}
  .bar{display:grid;grid-template-columns:90px 1fr 34px;gap:8px;align-items:center;margin:5px 0;font-size:12px}
  .bt{height:9px;background:#eef1f3;border-radius:5px;overflow:hidden;display:block}.bt span{display:block;height:100%;border-radius:5px}
  .bv{text-align:right;font-weight:600}
  table{width:100%;border-collapse:collapse;font-size:12px;margin-top:6px}
  th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--dim);border-bottom:2px solid var(--rule);padding:6px 6px}
  td{border-bottom:1px solid #eef1f3;padding:7px 6px;vertical-align:top}
  .sev{display:inline-block;padding:1px 8px;border-radius:999px;color:#fff;font-size:10.5px;font-weight:700}
  .muted{color:var(--dim)}
  .measure{display:grid;grid-template-columns:54px 1fr;gap:12px;padding:9px 0;border-bottom:1px solid #eef1f3}
  .gain{background:var(--wash);color:var(--brand);font-weight:800;border-radius:8px;text-align:center;padding:8px 0;font-size:15px}
  .tag{display:inline-block;font-size:10px;padding:1px 7px;border-radius:999px;background:#eef1f3;color:var(--dim);margin-right:4px}
  .tag.qw{background:#e3f3e5;color:var(--good)}
  footer{padding:18px 48px;color:var(--dim);font-size:11px;display:flex;justify-content:space-between}
  .printbtn{position:fixed;right:20px;bottom:20px;background:var(--brand);color:#fff;border:0;border-radius:999px;padding:12px 20px;font-weight:700;cursor:pointer;box-shadow:0 6px 20px rgba(0,129,173,.35)}
  @media print{body{background:#fff}.page{box-shadow:none;margin:0;max-width:none}.printbtn{display:none}section{padding:18px 32px}.cover{padding:36px 32px;-webkit-print-color-adjust:exact;print-color-adjust:exact}.kpi,.sev,.gain,.bt span,.verdict{-webkit-print-color-adjust:exact;print-color-adjust:exact}@page{size:A4;margin:12mm}}
  @media(max-width:700px){section,.cover,footer{padding-left:18px;padding-right:18px}.kpis{grid-template-columns:1fr 1fr}.two{grid-template-columns:1fr}}
</style></head><body>
<button class="printbtn" onclick="window.print()">Als PDF speichern</button>
<div class="page">
  <div class="cover">
    <div class="eyebrow">MANAGED MICROSOFT 365 · QUARTALSBERICHT</div>
    <h1>${esc(tenant.name)}</h1>
    <div class="sub">${esc(q.label)} · Sicherheits- und Betriebslage</div>
    <div class="meta">
      <div><b>${esc(new Date(q.from).toLocaleDateString("de-CH"))} – ${esc(new Date(new Date(q.to).getTime() - 86400000).toLocaleDateString("de-CH"))}</b>Berichtszeitraum</div>
      <div><b>${esc(tenant.organization || tenant.tenantId || "")}</b>Tenant</div>
      <div><b>${esc(brand)}</b>Betreuung</div>
    </div>
  </div>

  <section>
    <h2>Zusammenfassung</h2>
    <div class="verdict ${verdict.tone}">${esc(verdict.text)}</div>
    <div class="kpis">
      ${kpi("Secure Score", scoreEnd ? scoreEnd.score + "%" : (score && score.current ? score.current.pct + "%" : "—"), scoreDelta !== null ? (scoreDelta >= 0 ? "+" : "") + scoreDelta + " Pkt. im Quartal" : "", scoreDelta !== null && scoreDelta < 0 ? "warn" : "good")}
      ${kpi("Befunde erkannt", opened.length, `${oc.critical} kritisch · ${oc.high} hoch`, oc.critical ? "bad" : "")}
      ${kpi("Befunde behoben", resolved.length, mttr !== null ? `Median ${mttr < 48 ? mttr + " h" : Math.round(mttr / 24) + " Tage"} bis Behebung` : "", "good")}
      ${kpi("Offen am Ende", openAtEnd.length, `${ec.critical} kritisch · ${ec.high} hoch`, ec.critical ? "bad" : ec.high ? "warn" : "good")}
    </div>
  </section>

  <section>
    <h2>Secure Score <small>Microsoft-Bewertung der Sicherheitskonfiguration</small></h2>
    <p class="lead">${score && score.current ? `Aktuell ${esc(score.current.pct)}% (${Math.round(score.current.score)} von ${Math.round(score.current.max)} Punkten)${score.comparative && score.comparative.AllTenants !== undefined ? ` · Durchschnitt aller Microsoft-Tenants: ${esc(Math.round(score.comparative.AllTenants / (score.current.max || 1) * 1000) / 10)}%` : ""}.` : "Keine Secure-Score-Daten verfügbar."}</p>
    ${lineChart(scorePts, { label: "Secure Score", unit: "%" })}
  </section>

  ${measures.length ? `<section>
    <h2>Empfohlene Massnahmen <small>Stand ${esc(stand("score"))} · grösster Punktegewinn zuerst</small></h2>
    <p class="lead">Umgesetzt würden diese Massnahmen den Score auf etwa <b>${esc(score.current.potential)}%</b> heben.</p>
    ${measures.map(m => `<div class="measure"><div class="gain">+${esc(m.gain)}</div><div><b>${esc(m.title)}</b><br>
      <span class="tag">${esc(m.category || "")}</span>${m.cost ? `<span class="tag">Aufwand ${esc(m.cost)}</span>` : ""}${m.impact ? `<span class="tag">Benutzer: ${esc(m.impact)}</span>` : ""}${m.quickWin ? `<span class="tag qw">Quick Win</span>` : ""}
      ${m.why ? `<div class="muted" style="margin-top:4px">${esc(m.why.slice(0, 260))}</div>` : ""}</div></div>`).join("")}
  </section>` : ""}

  <section>
    <h2>Befunde im Quartal</h2>
    <div class="two">
      <div><div class="muted" style="font-weight:600;margin-bottom:4px">Erkannt nach Schweregrad</div>
        ${["critical", "high", "medium", "low"].map(s => bar(SEV_DE[s], oc[s], maxSev, SEV_COL[s])).join("")}</div>
      <div><div class="muted" style="font-weight:600;margin-bottom:4px">Behoben nach Schweregrad</div>
        ${["critical", "high", "medium", "low"].map(s => bar(SEV_DE[s], rc[s], maxSev, SEV_COL[s])).join("")}</div>
    </div>
    ${byArea.length ? `<table><thead><tr><th>Bereich</th><th style="text-align:right">Erkannt</th><th style="text-align:right">Behoben</th><th style="text-align:right">Offen am Ende</th></tr></thead><tbody>
      ${byArea.map(x => `<tr><td>${esc(x.a.label)}</td><td style="text-align:right">${x.opened}</td><td style="text-align:right">${x.resolved}</td><td style="text-align:right"><b>${x.open}</b></td></tr>`).join("")}
    </tbody></table>` : `<p class="muted">Keine Befunde im Quartal.</p>`}
    ${hist.length > 1 ? `<div style="margin-top:14px">${lineChart(hist.map(x => ({ d: x.d, v: x.open })), { label: "Offene Befunde", min: 0, color: "#e07b00" })}<div class="muted" style="font-size:11px;text-align:center">Offene Befunde im Verlauf</div></div>` : ""}
  </section>

  ${crit.length ? `<section>
    <h2>Offene Punkte mit Priorität</h2>
    <table><thead><tr><th>Schwere</th><th>Befund</th><th>Seit</th><th>Ticket</th></tr></thead><tbody>
      ${crit.map(f => `<tr><td><span class="sev" style="background:${SEV_COL[f.severity]}">${esc(SEV_DE[f.severity])}</span></td><td><b>${esc(f.title)}</b><div class="muted">${esc(String(f.summary || "").slice(0, 220))}</div></td><td>${esc(new Date(f.firstSeen).toLocaleDateString("de-CH"))}</td><td>${f.ticketId ? "#" + esc(f.ticketId) : "—"}</td></tr>`).join("")}
    </tbody></table>
  </section>` : ""}

  <section>
    <h2>Identität &amp; Zugriff</h2>
    <div class="kpis">
      ${kpi("Risikobenutzer", risk ? risk.riskyUsers.length : "—", "Stand " + stand("risk"), risk && risk.riskyUsers.length ? "warn" : "good")}
      ${kpi("Risikoerkennungen", risk ? risk.detections.length : "—", "letzte 14 Tage")}
      ${kpi("Consent-Anfragen", consent ? consent.requests.length : "—", consent && consent.userConsent === "all" ? "Benutzer-Consent offen!" : "offen", consent && consent.userConsent === "all" ? "bad" : "")}
      ${kpi("Drift CA (Quartal)", opened.filter(f => f.area === "ca" && f.drift).length, "Abweichungen von der Baseline")}
    </div>
  </section>

  <section>
    <h2>Mail &amp; Kommunikation</h2>
    <div class="kpis">
      ${kpi("Ext. Weiterleitungen", mailboxes ? (mailboxes.rules || []).filter(r => r.external.length).length + (mailboxes.mailboxForwarding || []).filter(m => m.external).length : "—", mailboxes && mailboxes.forwarding ? (mailboxes.forwarding.blocked ? "durch Policy blockiert" : "Policy erlaubt!") : "", mailboxes && mailboxes.forwarding && mailboxes.forwarding.blocked === false ? "bad" : "")}
      ${kpi("Postfächer mit Regeln", mailboxes ? mailboxes.perUser.length : "—", mailboxes ? `${mailboxes.scanned} von ${mailboxes.total} geprüft` : "")}
      ${kpi("Persönliche Listen", senders ? senders.junk.filter(j => j.trusted.length || j.blocked.length).length : "—", "Postfächer mit Allow/Block")}
      ${kpi("Quarantäne-Anfragen", opened.filter(f => f.area === "quarantine").length, "im Quartal bearbeitet")}
    </div>
  </section>

  <section>
    <h2>Geräte, Daten &amp; Lizenzen</h2>
    <div class="kpis">
      ${kpi("Geräte-Compliance", devices && devices.rate !== null ? devices.rate + "%" : "—", devices ? `${(devices.noncompliant || []).length} nicht konform` : "", devices && devices.rate !== null && devices.rate < 90 ? "warn" : "good")}
      ${kpi("Externe Freigabe", sharing && sharing.label ? sharing.label : "—", sharing ? `${(sharing.recent || []).filter(e => e.anonymous && e.dir === "out").length} anonyme Links (7 T.)` : "", sharing && sharing.capability === "externalUserAndGuestSharing" ? "warn" : "")}
      ${kpi("Freie Lizenzen", lic ? lic.totals.freeSeats : "—", lic ? `${lic.totals.licensedUsers} lizenzierte Benutzer` : "", lic && lic.totals.freeSeats > 5 ? "warn" : "")}
      ${kpi("Lizenz-Drift", lic && lic.drift ? lic.drift.length : 0, "Bestandsänderungen letzter Lauf")}
    </div>
    ${lic && lic.skus && lic.skus.length ? `<table><thead><tr><th>Lizenz</th><th style="text-align:right">Gekauft</th><th style="text-align:right">Zugewiesen</th><th style="text-align:right">Frei</th></tr></thead><tbody>
      ${lic.skus.slice(0, 12).map(s => `<tr><td>${esc(s.name)}</td><td style="text-align:right">${esc(s.purchased)}</td><td style="text-align:right">${esc(s.assigned)}</td><td style="text-align:right">${esc(s.available)}</td></tr>`).join("")}
    </tbody></table>` : ""}
  </section>

  ${relevantMsgs.length ? `<section>
    <h2>Angekündigte Microsoft-Änderungen <small>für diesen Tenant relevant</small></h2>
    <table><thead><tr><th>Meldung</th><th>Stichtag</th><th>Was es für Sie bedeutet</th></tr></thead><tbody>
      ${relevantMsgs.map(m => `<tr><td><b>${esc(m.title)}</b><div class="muted">${esc(m.id)} · ${esc(m.services.join(", "))}</div></td><td>${m.due ? esc(new Date(m.due).toLocaleDateString("de-CH")) : "—"}</td><td>${esc((m.ai && m.ai.impact) || (m.actions || [])[0] || "Information, kein Handlungsbedarf erkennbar.")}</td></tr>`).join("")}
    </tbody></table>
  </section>` : ""}

  <footer><span>${esc(brand)} · Managed Microsoft 365</span><span>Erstellt ${esc(generated)}</span></footer>
</div></body></html>`;
}

module.exports = { build, quarterRange, currentQuarter, previousQuarter };
