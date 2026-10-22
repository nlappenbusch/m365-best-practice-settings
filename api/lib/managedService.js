"use strict";
/**
 * Managed Service (MSP-Betrieb): Engine.
 *
 * Ablage pro Tenant unter STATE_DIR/managed/<tenantRecId>/
 *   status.json        letzter Lauf je Bereich (ok/Fehler, Kennzahlen, Zeit)
 *   data/<bereich>.json Detaildaten fuer die Fachansichten
 *   snap/<bereich>.json Zustand des letzten Laufs (Neu-Erkennung)
 *   stand/             eingefrorene Staende, versioniert (Drift-Referenz CA/Threat,
 *                      siehe managedStand.js — NIE die globale igeeks-Baseline)
 *   findings.json      Befunde mit Lebenszyklus
 *   alerts.jsonl       Meldungsstrom (neu, wieder offen, Drift, Eskalation)
 *   history.json       Tageswerte fuer Trend und Quartalsreport
 *   reports/<YYYY-Qn>.html
 *
 * Befund-Lebenszyklus: open -> (ack | snoozed | ticket) -> resolved.
 * Ein Befund gilt als behoben, wenn sein Bereich erfolgreich lief und ihn nicht
 * mehr meldet. Taucht er wieder auf, wird er wieder geoeffnet und erneut
 * gemeldet. Quittierte Befunde bleiben quittiert, solange sie bestehen.
 *
 * Bewusst KEINE Schreibzugriffe auf den Kundentenant: das Modul beobachtet und
 * meldet. Handeln tun Menschen — mit den Schritten, die der Befund nennt.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const C = require("./managedCollectors");
const STAND = require("./managedStand");

const AREAS = [
  { id: "credentials", label: "App-Credentials", group: "Identität", engine: "graph", icon: "key" },
  { id: "ca", label: "Conditional Access", group: "Identität", engine: "graph", icon: "lock", drift: "baseline" },
  { id: "risk", label: "Sign-in- & User-Risk", group: "Identität", engine: "graph", icon: "alert" },
  { id: "consent", label: "App-Consent-Anfragen", group: "Identität", engine: "graph", icon: "key", drift: "new" },
  { id: "score", label: "Secure Score", group: "Lage", engine: "graph", icon: "chart" },
  { id: "messages", label: "Message Center", group: "Lage", engine: "graph", icon: "book" },
  { id: "licenses", label: "Lizenzen & Drift", group: "Lage", engine: "graph", icon: "coins", drift: "licenses" },
  { id: "threat", label: "Threat Policies", group: "Mail", engine: "exo", icon: "shieldCheck", drift: "baseline" },
  { id: "quarantine", label: "Quarantäne-Anfragen", group: "Mail", engine: "exo", icon: "mail", drift: "new" },
  { id: "mailboxes", label: "Inbox-Regeln & Weiterleitungen", group: "Mail", engine: "exo", icon: "shuffle", drift: "new" },
  { id: "senderlists", label: "Block-/Allow-Listen", group: "Mail", engine: "exo", icon: "check", drift: "new" },
  { id: "sharing", label: "SharePoint-Freigabelinks", group: "Daten", engine: "graph", icon: "folder" },
  { id: "devices", label: "Geräte-Compliance", group: "Endpoint", engine: "graph", icon: "wrench" }
];
const AREA = Object.fromEntries(AREAS.map(a => [a.id, a]));
const SEV_RANK = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
// Reaktionsziele (SLA) je Schweregrad in Stunden — fuer Alterung in der Arbeitsliste.
const SLA_HOURS = { critical: 4, high: 24, medium: 72, low: 240, info: 720 };

const DEFAULT_SETTINGS = {
  enabled: false,
  graphIntervalMin: 60,
  exoIntervalHours: 6,
  autoTicket: "critical",       // off | critical | high
  notifyMin: "high",            // ab welchem Schweregrad Teams/Webhook
  maxMailboxes: 400,
  profileNote: "",
  areas: AREAS.map(a => a.id)
};

// ------------------------------------------------------------------ Ablage
function safe(v) { return String(v || "").replace(/[^A-Za-z0-9_.-]/g, "_"); }
function dirOf(stateDir, tid, ...sub) {
  const d = path.join(stateDir, "managed", safe(tid), ...sub);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function readJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return fb; } }
function writeJson(f, v) {
  const tmp = f + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(v), "utf8");
  fs.renameSync(tmp, f);
}
const file = (stateDir, tid, name) => path.join(dirOf(stateDir, tid), name);
const areaFile = (stateDir, tid, kind, area) => path.join(dirOf(stateDir, tid, kind), safe(area) + ".json");

function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canonical(v[k]);
    return o;
  }
  return v;
}
const hashOf = v => crypto.createHash("sha256").update(JSON.stringify(canonical(v))).digest("hex").slice(0, 16);

const diffPaths = (a, b, prefix) => STAND.diffPaths(a, b, prefix);

function settingsOf(tenant) { return { ...DEFAULT_SETTINGS, ...((tenant && tenant.managed) || {}) }; }

// ------------------------------------------------------------------ Drift
/**
 * Drift (CA, Threat Policies): Abweichung vom aktuell eingefrorenen Stand
 * (managedStand.js). Der Befund bleibt offen, bis jemand die Abweichung
 * zuruecknimmt oder sie mit Begruendung in einen neuen Stand uebernimmt.
 * Ohne Stand wird der Ist-Zustand als vorlaeufiger Stand aufgenommen.
 */
async function baselineDrift(stateDir, tid, area, snapshot, ctx) {
  const ref = STAND.referenceFor(stateDir, tid, area, snapshot);
  if (ref.created) return { findings: [], note: `Vorläufiger Stand v${ref.ver.v} aus dem Ist-Zustand aufgenommen — bitte bewusst einfrieren.` };
  const ver = ref.ver;
  const base = { acceptedAt: ver.at, acceptedBy: ver.by, items: ver.areas[area].items };
  const standLabel = `Stand v${ver.v} vom ${String(ver.at).slice(0, 10)}`;
  const findings = [];
  const items = base.items || {};
  const label = AREA[area].label;
  for (const [k, cur] of Object.entries(snapshot)) {
    const old = items[k];
    const name = cur.name || k;
    if (!old) {
      findings.push({
        key: "drift-new:" + k, severity: area === "ca" ? (cur.state === "enabled" ? "high" : "medium") : "medium", drift: true,
        title: `Drift ${label}: neu angelegt — ${name}`,
        summary: `Seit ${standLabel} hinzugekommen${cur.state ? " (Status " + cur.state + ")" : ""}.`,
        context: [["Objekt", name], ["Referenz", `${standLabel} (${base.acceptedBy})`]],
        steps: ["Prüfen, wer das Objekt angelegt hat und ob ein Change/Ticket dazu existiert.",
          "Gewollt: «In Stand übernehmen» mit Begründung (Change-Nr.). Ungewollt: Objekt entfernen bzw. deaktivieren."],
        objId: k, tab: area
      });
      continue;
    }
    const d = diffPaths(old.body || old, cur.body || cur, "");
    if (!d.length) continue;
    const stateChange = area === "ca" && old.state !== cur.state;
    const weakened = stateChange && old.state === "enabled";
    findings.push({
      key: "drift-chg:" + k, severity: weakened ? "critical" : area === "ca" ? "high" : "medium", drift: true,
      title: `Drift ${label}: ${weakened ? "Schutz abgeschwächt" : "geändert"} — ${name}`,
      summary: stateChange
        ? `Status von «${old.state}» auf «${cur.state}» geändert${d.length > 1 ? `, dazu ${d.length - 1} weitere Feldänderung(en)` : ""}.`
        : `${d.length} Feld(er) weichen vom ${standLabel} ab: ${d.slice(0, 3).map(x => x.path).join(", ")}${d.length > 3 ? " …" : ""}.`,
      context: [["Objekt", name], ["Referenz", `${standLabel} (${base.acceptedBy})`]],
      diff: d.slice(0, 25),
      steps: [
        "Änderung (Felder unten) mit dem Kunden/Team abgleichen: gibt es einen genehmigten Change?",
        weakened ? "Ungeplant: Policy sofort wieder auf «Ein» stellen und den Akteur klären — abgeschaltete CA-Policies sind ein typischer Angriffsschritt." : "Ungeplant: auf den Wert aus dem Stand zurücksetzen.",
        "Geplant: «In Stand übernehmen» mit Begründung — das erzeugt eine neue Stand-Version, die alte bleibt dokumentiert."
      ],
      objId: k, tab: area
    });
  }
  for (const [k, old] of Object.entries(items)) {
    if (snapshot[k]) continue;
    const wasOn = area === "ca" && old.state === "enabled";
    findings.push({
      key: "drift-del:" + k, severity: wasOn ? "critical" : "high", drift: true,
      title: `Drift ${label}: gelöscht — ${old.name || k}`,
      summary: `Objekt aus ${standLabel} existiert nicht mehr${wasOn ? " (war erzwungen)" : ""}.`,
      context: [["Objekt", old.name || k], ["Referenz", `${standLabel} (${base.acceptedBy})`]],
      steps: ["Akteur im Audit-Log ermitteln.", "Ungeplant: aus Stand-Dokument/Backup wiederherstellen. Geplant: «In Stand übernehmen» mit Begründung."],
      objId: k, tab: area
    });
  }
  // Wer hat's getan? (nur CA, gekappt — je Policy ein Audit-Abruf)
  if (area === "ca" && ctx && ctx.tenant) {
    for (const f of findings.slice(0, 8)) {
      if (!f.objId || f.key.startsWith("drift-del")) continue;
      const who = await C.lastPolicyActor(ctx.tenant, ctx.cert, f.objId);
      if (who) {
        f.context.push(["Zuletzt geändert", `${who.actor} · ${String(who.at).slice(0, 16).replace("T", " ")} (${who.activity})`]);
        f.actor = who.actor;
      }
      f.links = [{ label: "Policy öffnen", url: C.PORTAL.ca(f.objId) }];
    }
  }
  return { findings };
}

/** Neu-Erkennung: Eintraege, die seit dem letzten Lauf dazugekommen sind. */
function newSinceLast(stateDir, tid, area, snapshot) {
  const sf = areaFile(stateDir, tid, "snap", area);
  const prev = readJson(sf, null);
  writeJson(sf, { at: new Date().toISOString(), items: snapshot });
  if (!prev) return [];
  return Object.entries(snapshot).filter(([k]) => !(k in (prev.items || {}))).map(([k, v]) => ({ key: k, value: v }));
}

function licenseDrift(stateDir, tid, snapshot) {
  const sf = areaFile(stateDir, tid, "snap", "licenses");
  const prev = readJson(sf, null);
  writeJson(sf, { at: new Date().toISOString(), items: snapshot });
  if (!prev) return { findings: [], changes: [] };
  const changes = [];
  for (const [k, cur] of Object.entries(snapshot)) {
    const old = (prev.items || {})[k];
    if (!old) { changes.push({ sku: cur.name, kind: "neu", purchased: [0, cur.purchased], assigned: [0, cur.assigned] }); continue; }
    if (old.purchased !== cur.purchased || old.assigned !== cur.assigned) {
      changes.push({ sku: cur.name, kind: "geändert", purchased: [old.purchased, cur.purchased], assigned: [old.assigned, cur.assigned] });
    }
  }
  for (const [k, old] of Object.entries(prev.items || {})) if (!snapshot[k]) changes.push({ sku: old.name, kind: "entfallen", purchased: [old.purchased, 0], assigned: [old.assigned, 0] });
  const findings = [];
  for (const c of changes) {
    const over = c.assigned[1] > c.purchased[1] && c.purchased[1] >= 0;
    if (c.kind === "entfallen" || over || c.purchased[1] < c.purchased[0]) {
      findings.push({
        key: "licdrift:" + c.sku + ":" + c.purchased.join(">"), severity: over || c.kind === "entfallen" ? "high" : "medium",
        title: `Lizenz-Drift: ${c.sku} ${c.kind === "entfallen" ? "nicht mehr im Bestand" : `gekauft ${c.purchased[0]} → ${c.purchased[1]}`}`,
        summary: `Zugewiesen ${c.assigned[0]} → ${c.assigned[1]}.${over ? " Mehr zugewiesen als gekauft — Microsoft entzieht nach der Kulanzfrist Lizenzen." : ""}`,
        steps: ["Mit Vertrieb/Kunde klären: bewusste Reduktion, abgelaufenes Abo oder Zahlungsproblem?",
          over ? "Sofort: Lizenzen an inaktiven/deaktivierten Konten freigeben oder nachkaufen, bevor Benutzer den Zugriff verlieren." : "Bestand im Report dokumentieren."],
        links: [{ label: "Lizenzen", url: C.PORTAL.licenses }], tab: "licenses"
      });
    }
  }
  return { findings, changes };
}

// ------------------------------------------------------------------ Befunde
function fingerprint(area, key) { return area + ":" + hashOf(key); }

/**
 * Befunde eines Laufs mit dem Bestand abgleichen. ranAreas = Bereiche, die in
 * DIESEM Lauf erfolgreich liefen (nur dort darf etwas als behoben gelten).
 */
function reconcile(stateDir, tid, fresh, ranAreas) {
  const ff = file(stateDir, tid, "findings.json");
  const store = readJson(ff, {});
  const now = new Date().toISOString();
  const events = [];
  const seen = new Set();
  for (const f of fresh) {
    const id = fingerprint(f.area, f.key);
    seen.add(id);
    const old = store[id];
    const base = { ...f, id, lastSeen: now };
    if (!old) {
      store[id] = { ...base, firstSeen: now, status: "open", history: [{ at: now, what: "erkannt" }] };
      events.push({ kind: f.drift ? "drift" : "new", f: store[id] });
    } else {
      const reopened = old.status === "resolved";
      const snoozeOver = old.status === "snoozed" && old.snoozeUntil && old.snoozeUntil < now;
      const escalated = SEV_RANK[f.severity] > SEV_RANK[old.severity];
      store[id] = {
        ...old, ...base, firstSeen: reopened ? now : old.firstSeen,
        status: reopened || snoozeOver ? "open" : old.status,
        history: (old.history || []).concat(reopened ? [{ at: now, what: "wieder aufgetreten" }] : escalated ? [{ at: now, what: `eskaliert ${old.severity} → ${f.severity}` }] : []).slice(-30)
      };
      if (reopened) events.push({ kind: "reopened", f: store[id] });
      else if (escalated) events.push({ kind: "escalated", f: store[id] });
    }
  }
  for (const [id, f] of Object.entries(store)) {
    if (seen.has(id) || f.status === "resolved" || !ranAreas.has(f.area)) continue;
    f.status = "resolved"; f.resolvedAt = now;
    f.history = (f.history || []).concat([{ at: now, what: "nicht mehr festgestellt — behoben" }]).slice(-30);
    events.push({ kind: "resolved", f });
  }
  // Alte behobene Befunde nach 400 Tagen aufraeumen (Quartalsreport braucht ~1 Jahr).
  const cutoff = new Date(Date.now() - 400 * 86400000).toISOString();
  for (const [id, f] of Object.entries(store)) if (f.status === "resolved" && f.resolvedAt && f.resolvedAt < cutoff) delete store[id];
  writeJson(ff, store);
  return { store, events };
}

function listFindings(stateDir, tid) { return Object.values(readJson(file(stateDir, tid, "findings.json"), {})); }

function updateFinding(stateDir, tid, id, patch, what, by) {
  const ff = file(stateDir, tid, "findings.json");
  const store = readJson(ff, {});
  const f = store[id];
  if (!f) return null;
  Object.assign(f, patch);
  f.history = (f.history || []).concat([{ at: new Date().toISOString(), what, by: by || null }]).slice(-30);
  writeJson(ff, store);
  return f;
}

function lastSnap(stateDir, tid, area) { return readJson(areaFile(stateDir, tid, "snap", area), null); }
function lastSnaps(stateDir, tid) {
  const snaps = {};
  for (const a of STAND.STAND_AREAS) { const sn = lastSnap(stateDir, tid, a.id); if (sn) snaps[a.id] = sn; }
  return snaps;
}

// Drift-Befunde nach einer neuen Stand-Version sofort schliessen statt bis zum naechsten Lauf zu warten.
function closeDrift(stateDir, tid, ver, match) {
  const ff = file(stateDir, tid, "findings.json");
  const store = readJson(ff, {});
  for (const f of Object.values(store)) {
    if (!f.drift || f.status === "resolved" || !match(f)) continue;
    f.status = "resolved"; f.resolvedAt = ver.at;
    f.history = (f.history || []).concat([{ at: ver.at, what: `in Stand v${ver.v} übernommen: ${ver.reason}`, by: ver.by }]).slice(-30);
  }
  writeJson(ff, store);
}

/** Abweichung eines Bereichs bzw. eines Objekts mit Begruendung in eine neue Stand-Version uebernehmen. */
function acceptBaseline(stateDir, tid, area, by, onlyKey, reason) {
  if (!AREA[area] || AREA[area].drift !== "baseline" || !STAND.STAND_AREA[area]) throw Object.assign(new Error("Bereich hat keinen Stand."), { status: 400 });
  const ver = STAND.accept(stateDir, tid, { area, objId: onlyKey || null, by, reason, snap: lastSnap(stateDir, tid, area) });
  closeDrift(stateDir, tid, ver, f => f.area === area && (!onlyKey || f.objId === onlyKey));
  return ver;
}

/** Gesamten zuletzt erhobenen Ist-Zustand als neue Stand-Version einfrieren. */
function freezeStand(stateDir, tid, by, reason) {
  const ver = STAND.freeze(stateDir, tid, { by, reason, snaps: lastSnaps(stateDir, tid) });
  closeDrift(stateDir, tid, ver, f => !!ver.areas[f.area]);
  return ver;
}

/** Stand-Uebersicht fuer die Oberflaeche: Versionen, Alter des Ist, offene Drift. */
function standOverview(stateDir, tid) {
  const idx = STAND.index(stateDir, tid);
  const cur = idx.current ? STAND.get(stateDir, tid, idx.current) : null;
  const open = listFindings(stateDir, tid).filter(f => f.drift && f.status !== "resolved");
  return {
    current: cur ? STAND.summary(cur) : null,
    versions: [...idx.versions].reverse(),
    areas: STAND.STAND_AREAS.map(a => {
      const sn = lastSnap(stateDir, tid, a.id);
      return {
        id: a.id, label: a.label, snapAt: sn ? sn.at : null, snapCount: sn ? Object.keys(sn.items || {}).length : null,
        frozen: cur && cur.areas[a.id] ? { count: cur.areas[a.id].count, hash: cur.areas[a.id].hash, at: cur.areas[a.id].at } : null,
        openDrift: open.filter(f => f.area === a.id).length
      };
    }),
    openDrift: open.length,
    kinds: STAND.KIND_DE,
    reasonMin: STAND.REASON_MIN
  };
}

/** Daten fuer das Stand-PDF: Version, Versionsgeschichte und optional die Abweichungen zum zuletzt erhobenen Ist. */
function standDocument(stateDir, tid, v, withDrift) {
  const idx = STAND.index(stateDir, tid);
  const ver = STAND.get(stateDir, tid, v || idx.current);
  if (!ver) return null;
  const snaps = lastSnaps(stateDir, tid);
  return {
    ver, history: idx.versions, isCurrent: ver.v === idx.current,
    drift: withDrift ? { at: Object.values(snaps).map(x => x.at).sort()[0] || null, changes: STAND.driftAgainst(ver, snaps) } : null
  };
}

// ------------------------------------------------------------------ Alerts
function appendAlerts(stateDir, tid, tenantName, events) {
  const lines = [];
  for (const e of events) {
    if (e.kind === "resolved" && SEV_RANK[e.f.severity] < SEV_RANK.high) continue;
    lines.push(JSON.stringify({
      at: new Date().toISOString(), tenantId: tid, tenant: tenantName, kind: e.kind,
      severity: e.f.severity, area: e.f.area, title: e.f.title, findingId: e.f.id
    }));
  }
  if (lines.length) fs.appendFileSync(file(stateDir, tid, "alerts.jsonl"), lines.join("\n") + "\n", "utf8");
  return lines.length;
}

function readAlerts(stateDir, tid, limit) {
  try {
    const lines = fs.readFileSync(file(stateDir, tid, "alerts.jsonl"), "utf8").trim().split("\n").filter(Boolean);
    return lines.slice(-(limit || 200)).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean).reverse();
  } catch (e) { return []; }
}

// ------------------------------------------------------------------ Korrelation
/**
 * Bereichsuebergreifend — der Teil, den ein Mensch beim Durchklicken einzelner
 * Portale uebersieht: dasselbe Konto taucht als Risikobenutzer UND mit externer
 * Weiterleitung / verdaechtiger Regel / vielen anonymen Links auf.
 */
function correlate(fresh) {
  const byEntity = new Map();
  for (const f of fresh) {
    if (!f.entity) continue;
    if (!byEntity.has(f.entity)) byEntity.set(f.entity, []);
    byEntity.get(f.entity).push(f);
  }
  const out = [];
  for (const [entity, list] of byEntity) {
    const risk = list.find(f => f.area === "risk");
    const mail = list.filter(f => f.area === "mailboxes");
    const share = list.filter(f => f.area === "sharing");
    if (!risk || !(mail.length || share.length)) continue;
    out.push({
      area: "risk", key: "corr:" + entity, severity: "critical", entity, correlated: true,
      title: `Wahrscheinlich kompromittiert: ${entity}`,
      summary: `Risikobenutzer UND ${[mail.length ? mail.length + " Postfach-Befund(e) (Weiterleitung/verdächtige Regel)" : "", share.length ? "auffällige Freigabelinks" : ""].filter(Boolean).join(" und ")}. Diese Kombination ist das typische Muster einer Kontoübernahme (BEC).`,
      context: [["Konto", entity], ["Befunde", [risk, ...mail, ...share].map(f => f.title).slice(0, 4).join(" · ")]],
      steps: [
        "Sofort: Sitzungen widerrufen und Passwort zurücksetzen — Entscheid nicht bis zur Rückmeldung des Benutzers aufschieben.",
        "Weiterleitungen und verdächtige Regeln deaktivieren (Beweise sichern: Screenshot/Export vor dem Löschen).",
        "MFA-Methoden des Kontos prüfen, unbekannte entfernen. App-Consents des Benutzers prüfen.",
        "Gesendete Elemente der letzten 14 Tage auf Betrugsmails an Kunden/Lieferanten prüfen — Empfänger ggf. warnen.",
        "Kunde informieren (Sicherheitsvorfall), Vorgehen im Ticket dokumentieren."
      ],
      links: risk.links || [], tab: "risk"
    });
  }
  return out;
}

// ------------------------------------------------------------------ Lauf
function dueAreas(tenant, statusAll, now) {
  const s = settingsOf(tenant);
  const want = new Set(s.areas && s.areas.length ? s.areas : AREAS.map(a => a.id));
  const due = [];
  for (const a of AREAS) {
    if (!want.has(a.id)) continue;
    const st = statusAll[a.id];
    const last = st && st.at ? new Date(st.at).getTime() : 0;
    const gap = a.engine === "exo" ? s.exoIntervalHours * 3600000 : s.graphIntervalMin * 60000;
    // Fehlgeschlagene Bereiche frueher erneut versuchen, aber nicht im Minutentakt.
    const retry = st && st.ok === false ? Math.min(gap, 30 * 60000) : gap;
    if (now - last >= retry) due.push(a.id);
  }
  return due;
}

async function run(ctx) {
  const { stateDir, tenant, cert, areas, onProgress, ai } = ctx;
  const tid = tenant.id;
  const s = settingsOf(tenant);
  const statusFile = file(stateDir, tid, "status.json");
  const status = readJson(statusFile, {});
  const wanted = (areas && areas.length ? areas : AREAS.map(a => a.id)).filter(a => AREA[a]);
  const results = {};
  const facts = {};
  const say = l => { try { onProgress && onProgress(l); } catch (e) { /* Fortschritt optional */ } };

  // 1) Graph-Bereiche nacheinander (Graph drosselt parallele Abrufe pro App).
  for (const id of wanted.filter(a => AREA[a].engine === "graph" && C.GRAPH_COLLECTORS[a])) {
    say(AREA[id].label);
    try { results[id] = await C.GRAPH_COLLECTORS[id](tenant, cert); }
    catch (e) { results[id] = { error: e.message }; }
  }
  // 2) Exchange in einer Sitzung.
  const exoParts = wanted.filter(a => AREA[a].engine === "exo");
  if (exoParts.length) {
    say("Exchange Online verbinden");
    try {
      const r = await C.collectExo(tenant, cert, exoParts, { maxMailboxes: s.maxMailboxes }, say);
      Object.assign(results, r.results);
      facts.exo = r.facts;
      for (const p of exoParts) if (!results[p]) results[p] = { error: "Kein Ergebnis aus dem Exchange-Lauf." };
    } catch (e) { for (const p of exoParts) results[p] = { error: e.message }; }
  } else {
    // Fakten aus dem letzten Exchange-Lauf fuer die Message-Center-Einordnung.
    const last = status._facts && status._facts.exo;
    if (last) facts.exo = last;
  }
  if (results.threat && results.threat.facts) facts.threat = results.threat.facts;
  else if (status._facts && status._facts.threat) facts.threat = status._facts.threat;
  // 3) Freigaben (Audit-Log, zustandsbehaftet).
  if (wanted.includes("sharing")) {
    say(AREA.sharing.label);
    const uf = file(stateDir, tid, "ual-sharing.json");
    try {
      const r = await C.collectSharing(tenant, cert, readJson(uf, {}));
      writeJson(uf, r.ualState);
      delete r.ualState;
      results.sharing = r;
      facts.sharing = r.facts;
    } catch (e) { results.sharing = { error: e.message }; }
  } else if (status._facts && status._facts.sharing) facts.sharing = status._facts.sharing;
  // 4) Message Center zuletzt — braucht die Fakten der anderen Bereiche.
  const readData = a => readJson(areaFile(stateDir, tid, "data", a), null);
  if (wanted.includes("messages")) {
    say(AREA.messages.label);
    const ca = results.ca && results.ca.data ? results.ca.data : readData("ca");
    if (ca && ca.policies) facts.ca = { total: ca.policies.length, enabled: ca.policies.filter(p => p.state === "enabled").length, reportOnly: ca.policies.filter(p => p.state === "enabledForReportingButNotEnforced").length };
    const dev = results.devices && results.devices.data ? results.devices.data : readData("devices");
    if (dev) facts.devices = { byOs: dev.byOs };
    const lic = results.licenses && results.licenses.data ? results.licenses.data : readData("licenses");
    if (lic && lic.totals) facts.licenses = { licensedUsers: lic.totals.licensedUsers,
      skus: (lic.skus || []).filter(s => s.assigned > 0).sort((a, b) => b.assigned - a.assigned).slice(0, 15).map(s => ({ name: s.name, assigned: s.assigned })) };
    const sc = results.score && results.score.data ? results.score.data : readData("score");
    if (sc && sc.current && sc.current.pct != null) facts.score = sc.current.pct;
    // Teams-Geraete (Rooms, SIP, Telefone) — Grundlage fuer Meldungen zu Teams-Hardware.
    facts.teamsDevices = await C.teamsDevices(tenant, cert);
    facts.org = await C.orgInfo(tenant, cert);
    facts.usage = await C.usageInfo(tenant, cert);
    const cf = file(stateDir, tid, "mc-ai.json");
    const cache = readJson(cf, {});
    try {
      const r = await C.collectMessages(tenant, cert, facts, cache);
      if (ai) {
        try {
          // Alles, was lizenziert ist, bewertet die KI vor dem Kundenprofil — nicht nur, was die Regeln hoch einstufen.
          const updated = await ai(tenant, r.data.messages.filter(m => !m.notInTenant), facts, cache);
          if (updated) {
            writeJson(cf, updated);
            for (const m of r.data.messages) if (updated[m.id] && updated[m.id].modified === m.modified) m.ai = updated[m.id].ai;
          }
        } catch (e) { r.data.aiError = e.message; }
      }
      results.messages = r;
    } catch (e) { results.messages = { error: e.message }; }
  }

  // 5) Drift / Neu-Erkennung je Bereich, Befunde einsammeln.
  const fresh = [];
  const ran = new Set();
  const newItems = {};
  for (const id of wanted) {
    const r = results[id];
    const now = new Date().toISOString();
    if (!r || r.error) {
      status[id] = { ...(status[id] || {}), ok: false, error: r ? r.error : "nicht gelaufen", at: now, lastOkAt: (status[id] || {}).lastOkAt || null };
      continue;
    }
    ran.add(id);
    let extra = [];
    let note = null;
    if (AREA[id].drift === "baseline") {
      const d = await baselineDrift(stateDir, tid, id, r.snapshot || {}, { tenant, cert });
      extra = d.findings; note = d.note || null;
      writeJson(areaFile(stateDir, tid, "snap", id), { at: now, items: r.snapshot || {} });
    } else if (AREA[id].drift === "licenses") {
      const d = licenseDrift(stateDir, tid, r.snapshot || {});
      extra = d.findings;
      r.data.drift = d.changes;
    } else if (AREA[id].drift === "new") {
      const added = newSinceLast(stateDir, tid, id, r.snapshot || {});
      newItems[id] = added;
      // "Alert, wenn neue dazukommen": jeder neue Eintrag ein eigener Befund
      // (Regeln, Listen) — Anfragen (Consent/Quarantaene) sind ohnehin Befunde.
      if (id === "mailboxes" || id === "senderlists") {
        for (const n of added.slice(0, 40)) {
          const v = n.value || {};
          extra.push({
            key: "new:" + n.key, severity: "low", entity: v.mailbox || null,
            title: id === "mailboxes" ? `Neue Inbox-Regel: «${v.name || v.to || "?"}» — ${v.mailbox}` : `Neuer Eintrag ${v.list}: ${v.value} — ${v.mailbox}`,
            summary: id === "mailboxes"
              ? `Seit dem letzten Lauf hinzugekommen.${(v.forwardTo || []).length ? " Leitet weiter an " + v.forwardTo.join(", ") + "." : ""}${v.delete ? " Löscht Nachrichten." : ""}${v.moveTo ? " Verschiebt nach «" + v.moveTo + "»." : ""}`
              : "Seit dem letzten Lauf hinzugekommen.",
            steps: ["Kurz plausibilisieren: passt der Eintrag zum Benutzer und seiner Arbeit?", "Unauffällig: quittieren. Auffällig: mit dem Benutzer klären."],
            tab: id
          });
        }
      }
    }
    for (const f of [...(r.findings || []), ...extra]) fresh.push({ ...f, area: id });
    status[id] = { ok: true, at: now, lastOkAt: now, metrics: r.metrics || [], note: note || (r.data && r.data.note) || null, newItems: (newItems[id] || []).length };
    writeJson(areaFile(stateDir, tid, "data", id), r.data || {});
  }
  for (const c of correlate(fresh)) fresh.push(c);
  status._facts = { ...(status._facts || {}), ...facts };
  status._lastRun = new Date().toISOString();
  writeJson(statusFile, status);

  // 6) Lebenszyklus + Meldungen.
  const { store, events } = reconcile(stateDir, tid, fresh, ran);
  const alerted = appendAlerts(stateDir, tid, tenant.name, events);
  recordHistory(stateDir, tid, store, results);
  return { status, events, alerted, ran: [...ran], failed: wanted.filter(a => !ran.has(a)) };
}

// Tageswerte (eine Zeile pro Tag, letzter Lauf gewinnt) fuer Trend + Report.
function recordHistory(stateDir, tid, store, results) {
  const hf = file(stateDir, tid, "history.json");
  const h = readJson(hf, []);
  const day = new Date().toISOString().slice(0, 10);
  const open = Object.values(store).filter(f => f.status !== "resolved");
  const prev = h.find(x => x.d === day) || {};
  const pick = (v, fb) => (v === null || v === undefined ? fb : v);
  const dat = id => (results[id] && results[id].data) || null;
  const row = {
    d: day,
    open: open.length,
    critical: open.filter(f => f.severity === "critical").length,
    high: open.filter(f => f.severity === "high").length,
    score: pick(dat("score") && dat("score").current && dat("score").current.pct, pick(prev.score, null)),
    compliance: pick(dat("devices") && dat("devices").rate, pick(prev.compliance, null)),
    riskyUsers: pick(dat("risk") && dat("risk").riskyUsers && dat("risk").riskyUsers.length, pick(prev.riskyUsers, null)),
    freeSeats: pick(dat("licenses") && dat("licenses").totals && dat("licenses").totals.freeSeats, pick(prev.freeSeats, null)),
    anonLinks: dat("sharing") && dat("sharing").recent ? dat("sharing").recent.filter(e => e.anonymous && e.dir === "out").length : pick(prev.anonLinks, null)
  };

  const i = h.findIndex(x => x.d === day);
  if (i >= 0) h[i] = row; else h.push(row);
  writeJson(hf, h.slice(-800));
}

// ------------------------------------------------------------------ Lesen
function overview(stateDir, tenant) {
  const tid = tenant.id;
  const status = readJson(file(stateDir, tid, "status.json"), {});
  const findings = listFindings(stateDir, tid);
  const open = findings.filter(f => f.status !== "resolved");
  const now = Date.now();
  for (const f of open) {
    const ageH = (now - new Date(f.firstSeen).getTime()) / 3600000;
    f.ageHours = Math.round(ageH);
    f.slaHours = SLA_HOURS[f.severity] || 72;
    f.slaBreached = f.status === "open" && ageH > f.slaHours;
  }
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of open) if (f.status !== "snoozed") counts[f.severity] = (counts[f.severity] || 0) + 1;
  return {
    settings: settingsOf(tenant),
    areas: AREAS.map(a => ({ ...a, status: status[a.id] || null, open: open.filter(f => f.area === a.id && f.status !== "snoozed").length })),
    counts,
    lastRun: status._lastRun || null,
    findings: open.sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity] || (b.slaBreached - a.slaBreached) || String(a.firstSeen).localeCompare(String(b.firstSeen))),
    recentlyResolved: findings.filter(f => f.status === "resolved").sort((a, b) => String(b.resolvedAt).localeCompare(String(a.resolvedAt))).slice(0, 30),
    history: readJson(file(stateDir, tid, "history.json"), []).slice(-120),
    alerts: readAlerts(stateDir, tid, 50)
  };
}

function areaData(stateDir, tid, area) {
  if (!AREA[area]) return null;
  const data = readJson(areaFile(stateDir, tid, "data", area), null);
  const ver = AREA[area].drift === "baseline" ? STAND.current(stateDir, tid) : null;
  const fa = ver && ver.areas && ver.areas[area];
  return { data, baseline: fa ? { v: ver.v, acceptedAt: ver.at, acceptedBy: ver.by, count: fa.count, provisional: !!ver.provisional } : null };
}

function fleetRow(stateDir, tenant) {
  const tid = tenant.id;
  const status = readJson(file(stateDir, tid, "status.json"), {});
  const open = listFindings(stateDir, tid).filter(f => f.status !== "resolved" && f.status !== "snoozed");
  const now = Date.now();
  const sla = open.filter(f => f.status === "open" && (now - new Date(f.firstSeen).getTime()) / 3600000 > (SLA_HOURS[f.severity] || 72)).length;
  const scoreMetric = status.score && status.score.metrics ? status.score.metrics.find(m => m.label === "Secure Score") : null;
  const compMetric = status.devices && status.devices.metrics ? status.devices.metrics.find(m => m.label === "Konform") : null;
  const h = readJson(file(stateDir, tid, "history.json"), []).slice(-30);
  return {
    id: tid, name: tenant.name, organization: tenant.organization, readOnly: !!tenant.readOnly,
    settings: settingsOf(tenant), lastRun: status._lastRun || null,
    counts: {
      critical: open.filter(f => f.severity === "critical").length, high: open.filter(f => f.severity === "high").length,
      medium: open.filter(f => f.severity === "medium").length, low: open.filter(f => f.severity === "low").length
    },
    slaBreached: sla,
    tickets: open.filter(f => f.ticketId).length,
    score: scoreMetric ? scoreMetric.value : null,
    compliance: compMetric ? compMetric.value : null,
    areasFailed: AREAS.filter(a => status[a.id] && status[a.id].ok === false).map(a => a.label),
    areasNever: AREAS.filter(a => !status[a.id]).length,
    trend: h.map(x => ({ d: x.d, open: x.open, critical: x.critical, score: x.score })),
    top: open.sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity]).slice(0, 3).map(f => ({ id: f.id, title: f.title, severity: f.severity, area: f.area }))
  };
}

module.exports = {
  AREAS, AREA, SEV_RANK, SLA_HOURS, DEFAULT_SETTINGS,
  settingsOf, dueAreas, run, overview, areaData, fleetRow, listFindings, updateFinding, acceptBaseline, freezeStand, standOverview, standDocument,
  readAlerts, readJson, writeJson, file, dirOf
};
