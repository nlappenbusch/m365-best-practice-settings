"use strict";
/**
 * Nachweise: Protokolle, Unified Audit Log, Service-Status — und das Archiv, in
 * dem jede Erhebung mit Zeitstempel und Ersteller liegen bleibt.
 *
 * Warum ein Archiv: Microsoft löscht Entra-Audit- und Anmeldeprotokolle nach 30
 * Tagen (mit Entra ID P1/P2; ohne nach 7), das Unified Audit Log nach 180 Tagen
 * (Audit Standard). Wer einen Vorgang später belegen muss — etwa für eine
 * Prüfungsdokumentation —, muss ihn sichern, solange er noch da ist. Eine
 * Erhebung hier IST diese Sicherung: Sie landet unter state/evidence/<tenant>/.
 *
 * Ausschliesslich lesend gegen den Tenant. Einzige Ausnahme ist das Anlegen
 * einer Audit-Log-Suche (POST /security/auditLog/queries) — das ist eine
 * Suchanfrage, keine Konfigurationsänderung.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { graphReq, graphAllPages } = require("./graph");

const V1 = { retryTransient: 4 };
const BETA = { beta: true, retryTransient: 4 };

function isoZ(d) { return new Date(d).toISOString().replace(/\.\d{3}Z$/, "Z"); }
function trunc(v, n) {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > (n || 300) ? s.slice(0, (n || 300) - 1) + "…" : s;
}

/** Offset von Europe/Zurich an einem Tag, z. B. "+02:00" (Sommerzeit) oder "+01:00". */
function zurichOffset(day) {
  try {
    const d = new Date(day + "T12:00:00Z");
    const s = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Zurich", timeZoneName: "shortOffset" }).formatToParts(d).find(p => p.type === "timeZoneName").value;
    const m = s.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
    return m ? `${m[1]}${m[2].padStart(2, "0")}:${m[3] || "00"}` : "+01:00";
  } catch (e) { return "+01:00"; }
}

/** Zeitraum aus Tagesangaben (YYYY-MM-DD, "bis" inklusive) — Tage in Schweizer Zeit. */
function dayRange(from, to) {
  const fd = String(from || ""), td = String(to || from || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fd) || !/^\d{4}-\d{2}-\d{2}$/.test(td)) throw Object.assign(new Error("Zeitraum ungültig (von/bis im Format JJJJ-MM-TT)."), { status: 400 });
  const f = new Date(`${fd}T00:00:00${zurichOffset(fd)}`);
  const t = new Date(`${td}T23:59:59${zurichOffset(td)}`);
  if (isNaN(f) || isNaN(t) || t < f) throw Object.assign(new Error("Zeitraum ungültig (von/bis im Format JJJJ-MM-TT)."), { status: 400 });
  if ((t - f) / 864e5 > 92) throw Object.assign(new Error("Höchstens 92 Tage pro Erhebung."), { status: 400 });
  return { from: isoZ(f), to: isoZ(t) };
}

async function readCapped(tenant, cert, p, cap, opts) {
  const out = [];
  let resp = await graphReq(tenant, cert, "GET", p, null, opts);
  for (;;) {
    out.push(...(resp.value || []));
    if (out.length >= cap) return { items: out.slice(0, cap), capped: true };
    if (!resp["@odata.nextLink"]) return { items: out, capped: false };
    resp = await graphReq(tenant, cert, "GET", resp["@odata.nextLink"], null, opts);
  }
}

// ============================================================== Aufbewahrung
/** Wann löscht Microsoft Einträge eines Tages? Grundlage für die Warnung im UI. */
function retentionInfo(fromIso) {
  const from = new Date(fromIso);
  const entraGone = new Date(from.getTime() + 30 * 864e5);
  const ualGone = new Date(from.getTime() + 180 * 864e5);
  return {
    entraDeletedAround: entraGone.toISOString(),
    entraAlreadyGone: entraGone < new Date(),
    ualDeletedAround: ualGone.toISOString(),
    ualAlreadyGone: ualGone < new Date()
  };
}

// ============================================================== Änderungsprotokoll
function mapIntune(e) {
  const a = e.actor || {};
  return {
    source: "Intune",
    at: e.activityDateTime,
    actor: a.userPrincipalName || a.applicationDisplayName || a.servicePrincipalName || a.userId || "—",
    actorType: a.userPrincipalName ? "Benutzer" : (a.applicationDisplayName || a.servicePrincipalName ? "App" : (a.type || "")),
    app: a.applicationDisplayName || null,
    activity: e.displayName || e.activity || "",
    operation: e.activityOperationType || e.activityType || "",
    result: e.activityResult || "",
    category: e.category || e.componentName || "",
    targets: (e.resources || []).map(r => ({
      name: r.displayName || r.resourceId || "",
      type: r.type || r.auditResourceType || "",
      changes: (r.modifiedProperties || []).slice(0, 40).map(m => ({ name: m.displayName, old: trunc(m.oldValue, 200), new: trunc(m.newValue, 200) }))
    }))
  };
}

function mapEntra(e) {
  const ib = e.initiatedBy || {};
  const actor = (ib.user && (ib.user.userPrincipalName || ib.user.displayName)) || (ib.app && (ib.app.displayName || ib.app.servicePrincipalName)) || "—";
  return {
    source: "Entra",
    at: e.activityDateTime,
    actor,
    actorType: ib.user ? "Benutzer" : (ib.app ? "App" : ""),
    app: ib.app ? ib.app.displayName : null,
    activity: e.activityDisplayName || "",
    operation: e.operationType || "",
    result: e.result || "",
    category: [e.loggedByService, e.category].filter(Boolean).join(" / "),
    targets: (e.targetResources || []).map(t => ({
      name: t.displayName || t.userPrincipalName || t.id || "",
      type: t.type || "",
      changes: (t.modifiedProperties || []).slice(0, 40).map(m => ({ name: m.displayName, old: trunc(m.oldValue, 200), new: trunc(m.newValue, 200) }))
    }))
  };
}

function mapSignIn(s) {
  const d = s.deviceDetail || {}, loc = s.location || {}, st = s.status || {};
  return {
    at: s.createdDateTime, user: s.userPrincipalName, app: s.appDisplayName, ip: s.ipAddress,
    location: [loc.city, loc.countryOrRegion].filter(Boolean).join(", "),
    client: s.clientAppUsed, device: [d.displayName, d.operatingSystem].filter(Boolean).join(" · "),
    compliant: d.isCompliant === true, managed: d.isManaged === true,
    result: st.errorCode === undefined || st.errorCode === null ? "—" : st.errorCode === 0 ? "erfolgreich" : `Fehler ${st.errorCode}${st.failureReason ? ": " + st.failureReason : ""}`,
    ca: s.conditionalAccessStatus || "",
    mfa: s.authenticationRequirement || "",
    nonInteractive: !!s._nonInteractive
  };
}

/**
 * opts: { from, to (YYYY-MM-DD), sources: ["intune","entra","signins"], actor, text, user, cap }
 * actor/text/user filtern NACH dem Lesen (Teilzeichenfolge, Gross/Klein egal).
 */
async function changeLog(tenant, cert, opts, say) {
  say = say || (() => {});
  const { from, to } = dayRange(opts.from, opts.to);
  const sources = Array.isArray(opts.sources) && opts.sources.length ? opts.sources : ["intune", "entra"];
  const cap = Math.min(Math.max(Number(opts.cap) || 10000, 100), 50000);
  const actor = String(opts.actor || "").trim().toLowerCase();
  const text = String(opts.text || "").trim().toLowerCase();
  const user = String(opts.user || "").trim().toLowerCase();
  const hit = ev => {
    if (actor && !String(ev.actor || "").toLowerCase().includes(actor) && !String(ev.app || "").toLowerCase().includes(actor)) return false;
    if (text) {
      const hay = [ev.activity, ev.category, ...ev.targets.map(t => t.name + " " + t.type)].join(" ").toLowerCase();
      if (!hay.includes(text)) return false;
    }
    return true;
  };
  const out = { from, to, params: { ...opts }, retention: retentionInfo(from), gaps: [], events: [], signIns: null, capped: {} };

  if (sources.includes("intune")) {
    say("Intune-Protokoll lesen");
    try {
      let r;
      try { r = await readCapped(tenant, cert, `/deviceManagement/auditEvents?$filter=activityDateTime ge ${from} and activityDateTime le ${to}&$orderby=activityDateTime desc&$top=500`, cap, BETA); }
      catch (e) { r = await readCapped(tenant, cert, `/deviceManagement/auditEvents?$filter=activityDateTime ge ${from} and activityDateTime le ${to}&$top=500`, cap, BETA); }
      out.events.push(...r.items.map(mapIntune).filter(hit));
      out.capped.intune = r.capped;
    } catch (e) { out.gaps.push("Intune-Protokoll nicht lesbar: " + e.message); }
  }
  if (sources.includes("entra")) {
    say("Entra-Protokoll lesen");
    if (out.retention.entraAlreadyGone) out.gaps.push("Entra hält Audit-Einträge 30 Tage — Einträge vor dem " + new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10) + " sind bei Microsoft bereits gelöscht.");
    try {
      const r = await readCapped(tenant, cert, `/auditLogs/directoryAudits?$filter=activityDateTime ge ${from} and activityDateTime le ${to}&$top=999`, cap, V1);
      out.events.push(...r.items.map(mapEntra).filter(hit));
      out.capped.entra = r.capped;
    } catch (e) { out.gaps.push("Entra-Protokoll nicht lesbar: " + e.message); }
  }
  if (sources.includes("signins")) {
    say("Anmeldeprotokoll lesen");
    try {
      const uf = user ? ` and startswith(userPrincipalName,'${user.replace(/'/g, "''")}')` : "";
      const r = await readCapped(tenant, cert, `/auditLogs/signIns?$filter=createdDateTime ge ${from} and createdDateTime le ${to}${uf}&$top=999`, cap, V1);
      let list = r.items.map(mapSignIn);
      out.capped.signIns = r.capped;
      if (opts.nonInteractive) {
        say("Nicht-interaktive Anmeldungen lesen");
        try {
          const n = await readCapped(tenant, cert, `/auditLogs/signIns?$filter=createdDateTime ge ${from} and createdDateTime le ${to}${uf} and signInEventTypes/any(t: t eq 'nonInteractiveUser')&$top=999`, cap, BETA);
          list = list.concat(n.items.map(x => mapSignIn({ ...x, _nonInteractive: true })));
          out.capped.nonInteractive = n.capped;
        } catch (e) { out.gaps.push("Nicht-interaktive Anmeldungen nicht lesbar: " + e.message); }
      }
      out.signIns = list.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    } catch (e) { out.gaps.push("Anmeldeprotokoll nicht lesbar (Entra ID P1 nötig): " + e.message); }
  }

  out.events.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const count = (arr, key) => { const m = new Map(); for (const x of arr) m.set(x[key], (m.get(x[key]) || 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ key: k, n })); };
  out.summary = {
    events: out.events.length,
    intune: out.events.filter(e => e.source === "Intune").length,
    entra: out.events.filter(e => e.source === "Entra").length,
    signIns: out.signIns ? out.signIns.length : null,
    byActor: count(out.events, "actor").slice(0, 15),
    byActivity: count(out.events, "activity").slice(0, 20)
  };
  return out;
}

// ============================================================== Unified Audit Log
// Graph-Audit-Log-Suche: asynchron — Suche anlegen, Status abfragen, Ergebnisse
// holen. Microsoft braucht dafür oft einige Minuten.
const UAL_PATH = "/security/auditLog/queries";

async function ualReq(tenant, cert, method, p, body) {
  try { return await graphReq(tenant, cert, method, p, body, V1); }
  catch (e) {
    if (e.status === 400 || e.status === 404) return graphReq(tenant, cert, method, p, body, BETA);
    throw e;
  }
}

async function ualCreate(tenant, cert, q) {
  const { from, to } = dayRange(q.from, q.to);
  const arr = v => (Array.isArray(v) ? v : String(v || "").split(/[,;\n]/)).map(x => String(x).trim()).filter(Boolean);
  const body = {
    "@odata.type": "#microsoft.graph.security.auditLogQuery",
    displayName: String(q.name || "M365 Security Policy Manager").slice(0, 100),
    filterStartDateTime: from,
    filterEndDateTime: to
  };
  if (q.keyword) body.keywordFilter = String(q.keyword).slice(0, 200);
  if (arr(q.operations).length) body.operationFilters = arr(q.operations);
  if (arr(q.users).length) body.userPrincipalNameFilters = arr(q.users);
  if (arr(q.objectIds).length) body.objectIdFilters = arr(q.objectIds);
  if (arr(q.recordTypes).length) body.recordTypeFilters = arr(q.recordTypes);
  if (q.service) body.serviceFilter = String(q.service);
  const r = await ualReq(tenant, cert, "POST", UAL_PATH, body);
  return { graphId: r.id, status: r.status || "notStarted", from, to, body };
}

async function ualStatus(tenant, cert, graphId) {
  const r = await ualReq(tenant, cert, "GET", `${UAL_PATH}/${encodeURIComponent(graphId)}`);
  return { status: r.status, displayName: r.displayName };
}

// Operationen, die etwas verändern oder entfernen — für den Nachweis "hat die
// App etwas gelöscht/verschoben/gesendet?" gesondert ausgewiesen.
const UAL_CHANGING = /delete|remove|move|send|forward|set-|new-|create|update|upload|rename|restore|softdelete|harddelete|recycle|share|add|disable|enable|consent/i;
const UAL_DELETING = /harddelete|softdelete|movetodeleteditems|delete|remove-|recycle/i;
// Verschieben getrennt ausweisen: Im KI-Connector-Negativtest ist "SharePoint-
// Element verschieben" eigens gesperrt — das muss sich einzeln belegen lassen.
const UAL_MOVING = /^(move|filemoved|foldermoved|filemovedtorecyclebin)$/i;

function mapUal(r) {
  let d = r.auditData || {};
  if (typeof d === "string") { try { d = JSON.parse(d); } catch (e) { d = {}; } }
  const appId = d.AppId || d.ClientAppId || d.ApplicationId || (d.AppAccessContext && d.AppAccessContext.ClientAppId) || null;
  const item = d.Item ? (d.Item.Subject || d.Item.ParentFolder && d.Item.ParentFolder.Path) : null;
  const target = d.ObjectId || d.SourceFileName || item || (d.AffectedItems && d.AffectedItems[0] && (d.AffectedItems[0].Subject || d.AffectedItems[0].ParentFolder && d.AffectedItems[0].ParentFolder.Path)) || r.objectId || "";
  return {
    at: r.createdDateTime, operation: r.operation || d.Operation || "", user: r.userPrincipalName || d.UserId || "",
    service: r.service || d.Workload || "", recordType: r.auditLogRecordType || d.RecordType || "",
    ip: r.clientIp || d.ClientIP || "", appId, target: trunc(target, 160),
    result: d.ResultStatus || "", changing: UAL_CHANGING.test(r.operation || ""), deleting: UAL_DELETING.test(r.operation || ""),
    moving: UAL_MOVING.test(r.operation || "")
  };
}

async function ualRecords(tenant, cert, graphId, cap, appIdFilter) {
  const r = await (async () => {
    try { return await readCapped(tenant, cert, `${UAL_PATH}/${encodeURIComponent(graphId)}/records?$top=1000`, cap || 20000, V1); }
    catch (e) { return readCapped(tenant, cert, `${UAL_PATH}/${encodeURIComponent(graphId)}/records?$top=1000`, cap || 20000, BETA); }
  })();
  let records = r.items.map(mapUal);
  // Stichwortsuche trifft auch Einträge, in denen die App-Id nur irgendwo steht —
  // für den App-Nachweis zählt nur, was die App selbst getan hat.
  const onlyApp = appIdFilter ? String(appIdFilter).toLowerCase() : null;
  const other = onlyApp ? records.filter(x => String(x.appId || "").toLowerCase() !== onlyApp).length : 0;
  if (onlyApp) records = records.filter(x => String(x.appId || "").toLowerCase() === onlyApp);
  const byOp = new Map();
  for (const x of records) {
    const k = x.operation || "(ohne)";
    if (!byOp.has(k)) byOp.set(k, { operation: k, n: 0, users: new Set(), changing: x.changing, deleting: x.deleting, moving: x.moving });
    const e = byOp.get(k); e.n++; if (x.user) e.users.add(x.user);
  }
  return {
    records: records.sort((a, b) => String(b.at).localeCompare(String(a.at))),
    capped: r.capped,
    otherAppRecords: other,
    operations: [...byOp.values()].map(o => ({ ...o, users: [...o.users] })).sort((a, b) => b.n - a.n),
    summary: {
      records: records.length,
      changing: records.filter(x => x.changing).length,
      deleting: records.filter(x => x.deleting).length,
      moving: records.filter(x => x.moving).length,
      users: new Set(records.map(x => x.user).filter(Boolean)).size
    }
  };
}

// ============================================================== Service-Status
function stripHtml(s) { return String(s || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\n{3,}/g, "\n\n").trim(); }

async function serviceHealth(tenant, cert, opts, say) {
  say = say || (() => {});
  const days = Math.min(Math.max(Number(opts && opts.days) || 7, 1), 90);
  const since = Date.now() - days * 864e5;
  const q = String((opts && opts.service) || "").trim().toLowerCase();
  say("Service-Status lesen");
  let overview = [];
  const gaps = [];
  try {
    overview = (await graphAllPages(tenant, cert, "/admin/serviceAnnouncement/healthOverviews?$select=service,status", V1))
      .map(o => ({ service: o.service, status: o.status }));
  } catch (e) { gaps.push("Übersicht nicht lesbar (ServiceHealth.Read.All nötig — im Tab Tenants einmal Reparieren): " + e.message); }
  let issues = [];
  try {
    say("Störungen und Hinweise lesen");
    const all = await graphAllPages(tenant, cert, "/admin/serviceAnnouncement/issues?$top=100", V1);
    issues = all.filter(i => !i.isResolved || new Date(i.startDateTime || i.lastModifiedDateTime).getTime() >= since || new Date(i.lastModifiedDateTime).getTime() >= since)
      .filter(i => !q || [i.service, i.title, i.feature, i.impactDescription].join(" ").toLowerCase().includes(q))
      .map(i => {
        const posts = (i.posts || []).slice().sort((a, b) => String(b.createdDateTime).localeCompare(String(a.createdDateTime)));
        return {
          id: i.id, title: i.title, service: i.service, feature: i.feature || "", classification: i.classification === "incident" ? "Störung" : "Hinweis",
          status: i.status, resolved: !!i.isResolved, start: i.startDateTime, end: i.endDateTime || null, updated: i.lastModifiedDateTime,
          impact: i.impactDescription || "", latest: posts[0] ? trunc(stripHtml(posts[0].description && posts[0].description.content), 1500) : ""
        };
      })
      .sort((a, b) => Number(a.resolved) - Number(b.resolved) || String(b.updated).localeCompare(String(a.updated)));
  } catch (e) { gaps.push("Störungen nicht lesbar (ServiceHealth.Read.All nötig): " + e.message); }
  return {
    days, service: q || null, gaps,
    overview: overview.sort((a, b) => Number(a.status === "serviceOperational") - Number(b.status === "serviceOperational") || String(a.service).localeCompare(String(b.service))),
    issues,
    summary: { open: issues.filter(i => !i.resolved).length, resolved: issues.filter(i => i.resolved).length, degraded: overview.filter(o => o.status !== "serviceOperational").length },
    note: "Power Platform (Dataverse, Power Apps, Power Automate) meldet Störungen zusätzlich im Power Platform Admin Center — nicht alle erscheinen hier."
  };
}

// ============================================================== Archiv
function dir(stateDir, tenantRecId) {
  const d = path.join(stateDir, "evidence", String(tenantRecId).replace(/[^A-Za-z0-9_-]/g, ""));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function archive(stateDir, tenantRecId, entry) {
  const id = new Date().toISOString().replace(/[:.]/g, "-") + "-" + crypto.randomBytes(3).toString("hex");
  const rec = { id, kind: entry.kind, title: entry.title, params: entry.params || {}, createdAt: new Date().toISOString(), createdBy: entry.createdBy || "", data: entry.data };
  fs.writeFileSync(path.join(dir(stateDir, tenantRecId), id + ".json"), JSON.stringify(rec), "utf8");
  return rec;
}

function listArchive(stateDir, tenantRecId) {
  const d = dir(stateDir, tenantRecId);
  return fs.readdirSync(d).filter(f => f.endsWith(".json") && f !== "ual-queries.json").map(f => {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(d, f), "utf8"));
      return { id: r.id, kind: r.kind, title: r.title, params: r.params, createdAt: r.createdAt, createdBy: r.createdBy, summary: r.data && r.data.summary ? r.data.summary : null, size: fs.statSync(path.join(d, f)).size };
    } catch (e) { return null; }
  }).filter(Boolean).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function loadArchive(stateDir, tenantRecId, id) {
  if (!/^[A-Za-z0-9-]+$/.test(String(id))) return null;
  try { return JSON.parse(fs.readFileSync(path.join(dir(stateDir, tenantRecId), id + ".json"), "utf8")); } catch (e) { return null; }
}

function deleteArchive(stateDir, tenantRecId, id) {
  if (!/^[A-Za-z0-9-]+$/.test(String(id))) return false;
  const f = path.join(dir(stateDir, tenantRecId), id + ".json");
  if (!fs.existsSync(f)) return false;
  fs.unlinkSync(f);
  return true;
}

// Audit-Log-Suchen merken (Microsoft braucht Minuten — die Suche muss einen
// Neustart des Backends überleben).
function readQueries(stateDir, tenantRecId) {
  try { return JSON.parse(fs.readFileSync(path.join(dir(stateDir, tenantRecId), "ual-queries.json"), "utf8")); } catch (e) { return []; }
}
function writeQueries(stateDir, tenantRecId, list) {
  fs.writeFileSync(path.join(dir(stateDir, tenantRecId), "ual-queries.json"), JSON.stringify(list.slice(0, 200), null, 2), "utf8");
}

module.exports = {
  dayRange, retentionInfo, changeLog, ualCreate, ualStatus, ualRecords, serviceHealth,
  archive, listArchive, loadArchive, deleteArchive, readQueries, writeQueries, mapUal, trunc
};
