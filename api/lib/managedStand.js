"use strict";
/**
 * Managed Service: eingefrorene Staende je Tenant (Referenz fuer die Drift-Erkennung).
 *
 * Ein Stand haelt den Ist-Zustand eines Tenants zu einem Zeitpunkt fest —
 * bewusst eingefroren, mit Begruendung, nachvollziehbar versioniert. Drift ist
 * jede Abweichung vom aktuellen Stand. Das ist etwas anderes als der Abgleich
 * mit den igeeks-Best-Practices (baseline.json + tenant.acceptedDeviations):
 * dort geht es um das Soll fuer die Erstkonfiguration, hier um "so war es
 * abgenommen".
 *
 * Ablage: STATE_DIR/managed/<tenantRecId>/stand/
 *   index.json   Verzeichnis der Versionen + aktuelle Version
 *   v0001.json   eine Version — einmal geschrieben, nie geaendert
 *
 * Schutzregeln (hart, nicht konfigurierbar):
 *  - Dieses Modul schreibt AUSSCHLIESSLICH in das stand/-Verzeichnis des
 *    jeweiligen Tenants. Jeder Schreibzugriff laeuft durch guardedWrite(), das
 *    jedes andere Ziel verweigert — insbesondere die globale igeeks-Baseline
 *    (api/baseline/baseline.json). Ein Stand kann damit weder die
 *    Best-Practices noch einen anderen Tenant veraendern.
 *  - Versionen sind unveraenderlich. Uebernehmen erzeugt immer eine neue
 *    Version; die alte bleibt fuer Audit und PDF erhalten.
 *  - Jede bewusste Aenderung des Stands braucht eine Begruendung. Nur die
 *    automatische Erstaufnahme (damit Drift ab dem ersten Lauf greift) kommt
 *    ohne aus — sie ist als "vorlaeufig" markiert, bis jemand bewusst einfriert.
 *
 * Bewusst ohne Abhaengigkeit auf managedService.js (das bindet dieses Modul ein).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Bereiche, deren Zustand eingefroren wird. Reihenfolge = Reihenfolge im PDF.
const STAND_AREAS = [
  { id: "ca", label: "Conditional Access" },
  { id: "threat", label: "Threat Policies" }
];
const STAND_AREA = Object.fromEntries(STAND_AREAS.map(a => [a.id, a]));
const KIND_DE = {
  initial: "Erstaufnahme (automatisch)",
  migrated: "Aus bisheriger Baseline übernommen",
  freeze: "Stand eingefroren",
  accept: "Änderung übernommen"
};
const REASON_MIN = 10;
const REASON_MAX = 1000;

// Die globale Best-Practice-Vorlage. Wird hier nur benannt, um sie als Ziel
// auszuschliessen — dieses Modul liest und schreibt sie nie.
const PROTECTED_FILES = [path.resolve(__dirname, "..", "baseline", "baseline.json")];

// ------------------------------------------------------------------ Hilfen
function safe(v) { return String(v || "").replace(/[^A-Za-z0-9_.-]/g, "_"); }
function standDir(stateDir, tid) {
  if (!safe(tid) || safe(tid) === "." || safe(tid) === "..") throw Object.assign(new Error("Ungültige Tenant-ID."), { status: 400 });
  const d = path.join(path.resolve(stateDir), "managed", safe(tid), "stand");
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function readJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return fb; } }

/**
 * Einziger Schreibweg dieses Moduls. Ziel muss direkt im stand/-Verzeichnis
 * des Tenants liegen; once=true verweigert das Ueberschreiben (Versionen).
 */
function guardedWrite(stateDir, tid, name, value, opts) {
  const root = standDir(stateDir, tid);
  const target = path.resolve(root, String(name));
  const bad = () => Object.assign(new Error(`Schreibzugriff verweigert: ${name} liegt ausserhalb des Stand-Verzeichnisses.`), { status: 500, guard: true });
  if (path.dirname(target) !== root) throw bad();
  if (PROTECTED_FILES.some(p => path.resolve(p).toLowerCase() === target.toLowerCase())) throw bad();
  if (opts && opts.once && fs.existsSync(target)) {
    throw Object.assign(new Error(`Stand-Version ${path.basename(target)} existiert bereits — Versionen sind unveränderlich.`), { status: 409 });
  }
  const tmp = target + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value), "utf8");
  if (opts && opts.once && fs.existsSync(target)) { fs.unlinkSync(tmp); throw bad(); }
  fs.renameSync(tmp, target);
}

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
const cut = (s, n) => { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

/** Feldgenauer Vergleich zweier Objekte -> Liste {path, old, new} (gekappt). */
function diffPaths(a, b, prefix, out, limit) {
  out = out || [];
  limit = limit || 40;
  if (out.length > limit) return out;
  const isObj = x => x && typeof x === "object" && !Array.isArray(x);
  if (isObj(a) && isObj(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffPaths(a[k], b[k], prefix ? prefix + "." + k : k, out, limit);
    return out;
  }
  if (JSON.stringify(canonical(a)) !== JSON.stringify(canonical(b))) {
    const show = v => v === undefined ? "∅" : cut(typeof v === "string" ? v : JSON.stringify(v), 120);
    out.push({ path: prefix || "(Wert)", old: show(a), new: show(b) });
  }
  return out;
}

/** Objektweiser Vergleich zweier Item-Mengen eines Bereichs. */
function compareItems(area, before, after) {
  before = before || {}; after = after || {};
  const out = [];
  const nameOf = (o, k) => (o && o.name) || k;
  for (const [k, cur] of Object.entries(after)) {
    const old = before[k];
    if (!old) { out.push({ area, key: k, name: nameOf(cur, k), type: "neu" }); continue; }
    const fields = diffPaths(old.body || old, cur.body || cur, "");
    if (fields.length) out.push({ area, key: k, name: nameOf(cur, k), type: "geändert", fields: fields.slice(0, 25) });
  }
  for (const [k, old] of Object.entries(before)) if (!after[k]) out.push({ area, key: k, name: nameOf(old, k), type: "entfernt" });
  return out;
}

function checkReason(reason) {
  const r = String(reason == null ? "" : reason).replace(/\s+/g, " ").trim();
  if (r.length < REASON_MIN) {
    throw Object.assign(new Error(`Begründung fehlt (mindestens ${REASON_MIN} Zeichen). Sie steht im Stand-Dokument und im Verlauf.`), { status: 400 });
  }
  return r.slice(0, REASON_MAX);
}

// ------------------------------------------------------------------ Lesen
const vName = v => "v" + String(v).padStart(4, "0") + ".json";

function index(stateDir, tid) {
  const dir = standDir(stateDir, tid);
  const idx = readJson(path.join(dir, "index.json"), null);
  if (idx && Array.isArray(idx.versions)) return idx;
  // Index verloren? Aus den Versionsdateien neu aufbauen — die sind die Wahrheit.
  const files = fs.readdirSync(dir).filter(f => /^v\d{4}\.json$/.test(f)).sort();
  if (!files.length) return { current: null, versions: [] };
  const versions = files.map(f => summary(readJson(path.join(dir, f), null))).filter(Boolean);
  return { current: versions.length ? versions[versions.length - 1].v : null, versions };
}

function get(stateDir, tid, v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) return null;
  return readJson(path.join(standDir(stateDir, tid), vName(n)), null);
}

function current(stateDir, tid) {
  const idx = index(stateDir, tid);
  return idx.current ? get(stateDir, tid, idx.current) : null;
}

function summary(ver) {
  if (!ver) return null;
  return {
    v: ver.v, at: ver.at, by: ver.by, reason: ver.reason, kind: ver.kind, scope: ver.scope || null,
    provisional: !!ver.provisional, prev: ver.prev || null,
    counts: Object.fromEntries(Object.entries(ver.areas || {}).map(([a, x]) => [a, x.count])),
    changes: (ver.changes || []).length
  };
}

// ------------------------------------------------------------------ Schreiben
/**
 * Neue Version anlegen. areas: { <area>: { at, items } } — fehlende Bereiche
 * werden aus der Vorversion uebernommen.
 */
function writeVersion(stateDir, tid, { by, reason, kind, scope, areas, provisional }) {
  const idx = index(stateDir, tid);
  const prev = idx.current ? get(stateDir, tid, idx.current) : null;
  const v = (idx.versions.reduce((m, x) => Math.max(m, x.v), 0) || 0) + 1;
  const at = new Date().toISOString();
  const outAreas = {};
  const changes = [];
  for (const a of STAND_AREAS) {
    const p = prev && prev.areas && prev.areas[a.id];
    const n = areas && areas[a.id];
    const src = n || p;
    if (!src) continue;
    const items = src.items || {};
    outAreas[a.id] = { label: a.label, at: src.at || at, count: Object.keys(items).length, hash: hashOf(items), items };
    if (n && p) changes.push(...compareItems(a.id, p.items, items));
  }
  const ver = {
    schema: 1, v, at, by: by || "unbekannt", reason, kind, scope: scope || null,
    provisional: !!provisional, prev: prev ? prev.v : null, areas: outAreas, changes
  };
  guardedWrite(stateDir, tid, vName(v), ver, { once: true });
  const versions = idx.versions.filter(x => x.v !== v).concat([summary(ver)]);
  guardedWrite(stateDir, tid, "index.json", { current: v, versions });
  return ver;
}

/**
 * Bisherige Baseline-Dateien (managed/<tid>/base/<area>.json, vor den
 * versionierten Staenden) einmalig als v1 uebernehmen. Nur lesend dort.
 */
function migrateLegacy(stateDir, tid) {
  const idx = index(stateDir, tid);
  if (idx.current) return null;
  const legacyDir = path.join(path.resolve(stateDir), "managed", safe(tid), "base");
  const areas = {};
  let by = null, at = null, auto = true;
  for (const a of STAND_AREAS) {
    const b = readJson(path.join(legacyDir, safe(a.id) + ".json"), null);
    if (!b || !b.items) continue;
    areas[a.id] = { at: b.acceptedAt, items: b.items };
    if (!at || String(b.acceptedAt) > at) { at = b.acceptedAt; by = b.acceptedBy; }
    if (b.acceptedBy && b.acceptedBy !== "Erstaufnahme") auto = false;
  }
  if (!Object.keys(areas).length) return null;
  return writeVersion(stateDir, tid, {
    by: "System", kind: "migrated", areas, provisional: auto,
    reason: `Aus der bisherigen Baseline übernommen (zuletzt ${String(at || "").slice(0, 10)}${by ? ", " + by : ""}). Bitte bewusst neu einfrieren, um den Stand zu dokumentieren.`
  });
}

/**
 * Referenz fuer die Drift-Erkennung eines Bereichs. Gibt es noch keinen Stand
 * (oder fehlt der Bereich darin), wird der Ist-Zustand als vorlaeufiger Stand
 * aufgenommen — sonst gaebe es bis zum ersten Klick keine Drift-Erkennung.
 */
function referenceFor(stateDir, tid, area, snapshotItems) {
  if (!STAND_AREA[area]) throw Object.assign(new Error("Bereich wird nicht eingefroren."), { status: 400 });
  migrateLegacy(stateDir, tid);
  let ver = current(stateDir, tid);
  if (ver && ver.areas && ver.areas[area]) return { ver, created: false };
  ver = writeVersion(stateDir, tid, {
    by: "System", kind: "initial", provisional: true,
    areas: { [area]: { at: new Date().toISOString(), items: snapshotItems || {} } },
    reason: `Erstaufnahme ${STAND_AREA[area].label} beim ersten Lauf — vorläufig, bis der Stand bewusst eingefroren wird.`
  });
  return { ver, created: true };
}

/** Ganzen Ist-Zustand einfrieren. snaps: { <area>: { at, items } } aus dem letzten Lauf. */
function freeze(stateDir, tid, { by, reason, snaps }) {
  const r = checkReason(reason);
  migrateLegacy(stateDir, tid);
  const areas = {};
  for (const a of STAND_AREAS) if (snaps && snaps[a.id] && snaps[a.id].items) areas[a.id] = { at: snaps[a.id].at, items: snaps[a.id].items };
  if (!Object.keys(areas).length) throw Object.assign(new Error("Noch kein erfolgreicher Lauf für Conditional Access oder Threat Policies — erst erheben, dann einfrieren."), { status: 409 });
  return writeVersion(stateDir, tid, { by, reason: r, kind: "freeze", areas, provisional: false });
}

/**
 * Abweichung eines Bereichs (oder nur eines Objekts) in den Stand uebernehmen.
 * Ergebnis ist immer eine neue Version.
 */
function accept(stateDir, tid, { area, objId, by, reason, snap }) {
  if (!STAND_AREA[area]) throw Object.assign(new Error("Bereich hat keinen Stand."), { status: 400 });
  const r = checkReason(reason);
  if (!snap || !snap.items) throw Object.assign(new Error("Noch kein Lauf für diesen Bereich."), { status: 409 });
  migrateLegacy(stateDir, tid);
  const cur = current(stateDir, tid);
  const base = (cur && cur.areas && cur.areas[area] && cur.areas[area].items) || {};
  let items, scope;
  if (objId) {
    items = { ...base };
    const obj = snap.items[objId] || base[objId];
    if (snap.items[objId]) items[objId] = snap.items[objId]; else delete items[objId];
    scope = { area, objId, name: (obj && obj.name) || objId };
  } else {
    items = snap.items;
    scope = { area };
  }
  return writeVersion(stateDir, tid, { by, reason: r, kind: "accept", scope, areas: { [area]: { at: snap.at, items } }, provisional: false });
}

/** Abweichungen einer Version gegenueber dem zuletzt erhobenen Ist. */
function driftAgainst(ver, snaps) {
  const out = [];
  for (const a of STAND_AREAS) {
    const s = snaps && snaps[a.id];
    const base = ver && ver.areas && ver.areas[a.id];
    if (!s || !base) continue;
    out.push(...compareItems(a.id, base.items, s.items));
  }
  return out;
}

module.exports = {
  STAND_AREAS, STAND_AREA, KIND_DE, REASON_MIN, PROTECTED_FILES,
  index, get, current, summary, referenceFor, freeze, accept, driftAgainst, compareItems, diffPaths, hashOf, checkReason,
  // nur fuer Tests
  _guardedWrite: guardedWrite
};
