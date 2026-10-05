"use strict";

/**
 * Evidence 3.0 — deduplicated event + resource snapshot store.
 *
 * The existing Evidence archive remains the immutable/raw proof. This module
 * adds an operational index on top:
 *   - deterministic event IDs -> overlapping collections do not duplicate data
 *   - append-only monthly event logs
 *   - resource snapshots with content hashes and history
 *   - annotations for baseline / impact / ticket-reference / remediation hints
 *
 * File based on purpose. STATE_DIR is already durable in the current product
 * and this keeps Evidence 3.0 dependency-free. The API shape deliberately hides
 * this implementation so it can later move to PostgreSQL without changing UI.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const VERSION = 3;

function safe(v) {
  return String(v == null ? "" : v).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 180) || "_";
}
function mkdir(p) { fs.mkdirSync(p, { recursive: true }); return p; }
function root(stateDir, tenantRecId) {
  return mkdir(path.join(stateDir, "evidence-v3", safe(tenantRecId)));
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return fallback; }
}
function writeJson(file, value) {
  const tmp = file + ".tmp-" + process.pid + "-" + crypto.randomBytes(3).toString("hex");
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, file);
}
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) {
      if (v[k] !== undefined) out[k] = canonical(v[k]);
    }
    return out;
  }
  return v;
}
function hash(v) {
  return crypto.createHash("sha256").update(JSON.stringify(canonical(v))).digest("hex");
}
function monthOf(iso) {
  const m = /^\d{4}-\d{2}/.exec(String(iso || ""));
  return m ? m[0] : new Date().toISOString().slice(0, 7);
}
function compactTarget(t) {
  return {
    id: t && t.id || null,
    name: t && t.name || "",
    type: t && t.type || "",
    changes: (t && t.changes || []).map(c => ({
      name: c && c.name || "",
      old: c && c.old == null ? "" : String(c.old),
      new: c && c.new == null ? "" : String(c.new)
    }))
  };
}
function eventFingerprint(ev) {
  if (ev && ev.source && ev.id) return hash({ v: VERSION, source: ev.source, nativeId: ev.id });
  return hash({
    v: VERSION,
    source: ev && ev.source,
    at: ev && ev.at,
    actor: ev && ev.actor,
    activity: ev && ev.activity,
    operation: ev && ev.operation,
    targets: (ev && ev.targets || []).map(compactTarget)
  });
}
function indexFile(stateDir, tenantRecId) { return path.join(root(stateDir, tenantRecId), "event-index.json"); }
function annotationsFile(stateDir, tenantRecId) { return path.join(root(stateDir, tenantRecId), "annotations.json"); }
function metaFile(stateDir, tenantRecId) { return path.join(root(stateDir, tenantRecId), "meta.json"); }
function latestFile(stateDir, tenantRecId) { return path.join(root(stateDir, tenantRecId), "resource-latest.json"); }

function meta(stateDir, tenantRecId) {
  return readJson(metaFile(stateDir, tenantRecId), {
    version: VERSION,
    createdAt: new Date().toISOString(),
    archiveBackfillComplete: false,
    archiveBackfillAt: null,
    events: 0,
    duplicateObservations: 0,
    snapshots: 0
  });
}
function updateMeta(stateDir, tenantRecId, patch) {
  const m = { ...meta(stateDir, tenantRecId), ...patch, version: VERSION, updatedAt: new Date().toISOString() };
  writeJson(metaFile(stateDir, tenantRecId), m);
  return m;
}

/**
 * Ingest normalized events from evidence.changeLog().
 * Returns inserted IDs and duplicates without writing duplicate events.
 */
function ingestChangeLog(stateDir, tenantRecId, data, context) {
  const r = root(stateDir, tenantRecId);
  const idxFile = indexFile(stateDir, tenantRecId);
  const idx = readJson(idxFile, {});
  const inserted = [], duplicates = [];
  const now = new Date().toISOString();
  const ctx = context || {};
  const byMonth = new Map();

  for (const raw of (data && data.events) || []) {
    const fingerprint = eventFingerprint(raw);
    const eventId = "ev_" + fingerprint.slice(0, 24);
    const existing = idx[fingerprint];
    if (existing) {
      existing.lastObservedAt = now;
      existing.observations = (existing.observations || 1) + 1;
      if (ctx.archiveId && !(existing.archiveIds || []).includes(ctx.archiveId)) {
        existing.archiveIds = [...(existing.archiveIds || []), ctx.archiveId].slice(-30);
      }
      duplicates.push(eventId);
      continue;
    }

    const event = {
      schema: VERSION,
      eventId,
      fingerprint,
      nativeId: raw.id || null,
      source: raw.source || "unknown",
      occurredAt: raw.at || now,
      observedAt: now,
      actor: raw.actor || "—",
      actorType: raw.actorType || "",
      app: raw.app || null,
      activity: raw.activity || "",
      operation: raw.operation || "",
      result: raw.result || "",
      category: raw.category || "",
      targets: (raw.targets || []).map(compactTarget),
      evidence: {
        archiveId: ctx.archiveId || null,
        archiveTitle: ctx.archiveTitle || null,
        collectedAt: ctx.collectedAt || now,
        collectedBy: ctx.collectedBy || "",
        params: ctx.params || {}
      }
    };

    const month = monthOf(event.occurredAt);
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month).push(event);
    idx[fingerprint] = {
      eventId, month, occurredAt: event.occurredAt,
      firstObservedAt: now, lastObservedAt: now, observations: 1,
      archiveIds: ctx.archiveId ? [ctx.archiveId] : []
    };
    inserted.push(eventId);
  }

  for (const [month, events] of byMonth) {
    const d = mkdir(path.join(r, "events"));
    fs.appendFileSync(path.join(d, month + ".jsonl"), events.map(x => JSON.stringify(x)).join("\n") + "\n", "utf8");
  }
  writeJson(idxFile, idx);
  const m = meta(stateDir, tenantRecId);
  updateMeta(stateDir, tenantRecId, {
    events: (m.events || 0) + inserted.length,
    duplicateObservations: (m.duplicateObservations || 0) + duplicates.length,
    lastEventIngestAt: now
  });
  return { inserted, duplicates, total: inserted.length + duplicates.length };
}

function resourceKey(type, id) { return safe(type) + ":" + safe(id); }

/**
 * Store a complete snapshot collection of one resource type.
 * Each resource must contain { id, name?, data, baseline?, impact? }.
 * Missing resources from the previous complete collection are recorded as
 * deleted snapshots.
 */
function ingestSnapshotCollection(stateDir, tenantRecId, type, resources, context) {
  const r = root(stateDir, tenantRecId);
  const latestPath = latestFile(stateDir, tenantRecId);
  const latest = readJson(latestPath, {});
  const now = (context && context.observedAt) || new Date().toISOString();
  const collectionId = (context && context.collectionId) || ("snap_" + now.replace(/[^0-9]/g, "").slice(0, 14) + "_" + crypto.randomBytes(3).toString("hex"));
  const seen = new Set(), changed = [], unchanged = [];

  function persist(item, deleted) {
    const id = String(item.id);
    const key = resourceKey(type, id);
    seen.add(key);
    const body = {
      schema: VERSION,
      collectionId,
      resourceType: type,
      resourceId: id,
      name: item.name || id,
      observedAt: now,
      deleted: !!deleted,
      data: deleted ? null : (item.data === undefined ? item : item.data),
      baseline: item.baseline || null,
      impact: item.impact || null,
      context: context || {}
    };
    const contentHash = hash({ deleted: body.deleted, data: body.data, baseline: body.baseline, impact: body.impact });
    const prev = latest[key] || null;
    if (prev && prev.hash === contentHash) {
      prev.lastObservedAt = now;
      prev.observations = (prev.observations || 1) + 1;
      unchanged.push({ key, id, name: body.name, hash: contentHash });
      return;
    }

    const dir = mkdir(path.join(r, "snapshots", safe(type), safe(id)));
    const file = now.replace(/[:.]/g, "-") + "_" + contentHash.slice(0, 12) + ".json";
    writeJson(path.join(dir, file), { ...body, hash: contentHash, previousHash: prev && prev.hash || null });
    latest[key] = {
      resourceType: type, resourceId: id, name: body.name, hash: contentHash,
      path: path.relative(r, path.join(dir, file)), observedAt: now, lastObservedAt: now,
      observations: 1, deleted: body.deleted, previousHash: prev && prev.hash || null
    };
    changed.push({ key, id, name: body.name, hash: contentHash, previous: prev, deleted: body.deleted });
  }

  for (const item of resources || []) {
    if (!item || item.id == null) continue;
    persist(item, false);
  }

  // A complete collection lets us prove deletion, not merely absence from a
  // partial API response.
  if (!context || context.complete !== false) {
    for (const [key, prev] of Object.entries(latest)) {
      if (prev.resourceType !== type || seen.has(key) || prev.deleted) continue;
      persist({ id: prev.resourceId, name: prev.name, baseline: null, impact: null }, true);
    }
  }

  writeJson(latestPath, latest);
  const m = meta(stateDir, tenantRecId);
  updateMeta(stateDir, tenantRecId, {
    snapshots: (m.snapshots || 0) + changed.length,
    lastSnapshotAt: now,
    lastSnapshotCollection: collectionId
  });
  return { collectionId, changed, unchanged, observedAt: now };
}

function loadSnapshotByMeta(stateDir, tenantRecId, rec) {
  if (!rec || !rec.path) return null;
  try { return JSON.parse(fs.readFileSync(path.join(root(stateDir, tenantRecId), rec.path), "utf8")); } catch (e) { return null; }
}
function latestResources(stateDir, tenantRecId, type) {
  const latest = readJson(latestFile(stateDir, tenantRecId), {});
  return Object.values(latest)
    .filter(x => !type || x.resourceType === type)
    .map(x => ({ ...x, snapshot: loadSnapshotByMeta(stateDir, tenantRecId, x) }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}
function resourceHistory(stateDir, tenantRecId, type, id) {
  const dir = path.join(root(stateDir, tenantRecId), "snapshots", safe(type), safe(id));
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(x => x.endsWith(".json")).sort().reverse().map(file => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")); } catch (e) { return null; }
  }).filter(Boolean);
}

function annotate(stateDir, tenantRecId, eventId, value) {
  const f = annotationsFile(stateDir, tenantRecId);
  const all = readJson(f, {});
  all[eventId] = {
    ...(all[eventId] || {}),
    ...value,
    updatedAt: new Date().toISOString()
  };
  writeJson(f, all);
  return all[eventId];
}
function annotations(stateDir, tenantRecId) { return readJson(annotationsFile(stateDir, tenantRecId), {}); }

function eventFiles(stateDir, tenantRecId) {
  const dir = path.join(root(stateDir, tenantRecId), "events");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(x => /^\d{4}-\d{2}\.jsonl$/.test(x)).sort().reverse();
}
function listEvents(stateDir, tenantRecId, opts) {
  opts = opts || {};
  const since = opts.since ? new Date(opts.since).getTime() : (Date.now() - (Math.min(Math.max(Number(opts.days) || 30, 1), 730) * 864e5));
  const until = opts.until ? new Date(opts.until).getTime() : Infinity;
  const limit = Math.min(Math.max(Number(opts.limit) || 500, 1), 5000);
  const ann = annotations(stateDir, tenantRecId);
  const out = [];

  for (const file of eventFiles(stateDir, tenantRecId)) {
    const lines = fs.readFileSync(path.join(root(stateDir, tenantRecId), "events", file), "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      let e; try { e = JSON.parse(line); } catch (err) { continue; }
      const at = new Date(e.occurredAt).getTime();
      if (!Number.isFinite(at) || at < since || at > until) continue;
      if (opts.source && e.source !== opts.source) continue;
      const merged = { ...e, analysis: ann[e.eventId] || null };
      if (opts.level && merged.analysis && merged.analysis.risk && merged.analysis.risk.level !== opts.level) continue;
      out.push(merged);
    }
  }
  return out.sort((a, b) => String(b.occurredAt).localeCompare(String(a.occurredAt))).slice(0, limit);
}

function matchLatestResource(stateDir, tenantRecId, event, type) {
  const resources = latestResources(stateDir, tenantRecId, type);
  const ids = new Set((event.targets || []).map(t => String(t.id || "").toLowerCase()).filter(Boolean));
  const names = new Set((event.targets || []).map(t => String(t.name || "").trim().toLowerCase()).filter(Boolean));
  return resources.find(r =>
    ids.has(String(r.resourceId || "").toLowerCase()) ||
    names.has(String(r.name || "").trim().toLowerCase())
  ) || null;
}

function stats(stateDir, tenantRecId) {
  const m = meta(stateDir, tenantRecId);
  const latest = readJson(latestFile(stateDir, tenantRecId), {});
  const ann = annotations(stateDir, tenantRecId);
  const levels = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const a of Object.values(ann)) {
    const l = a && a.risk && a.risk.level;
    if (Object.prototype.hasOwnProperty.call(levels, l)) levels[l]++;
  }
  return {
    ...m,
    resources: Object.values(latest).length,
    activeResources: Object.values(latest).filter(x => !x.deleted).length,
    levels
  };
}

module.exports = {
  VERSION, hash, meta, updateMeta,
  ingestChangeLog, ingestSnapshotCollection,
  latestResources, resourceHistory, matchLatestResource,
  annotate, annotations, listEvents, stats
};
