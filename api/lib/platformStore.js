"use strict";
const { DatabaseSync } = require("node:sqlite");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const uuid = () => crypto.randomUUID();
const parse = (s, fb) => (s ? JSON.parse(s) : fb);
const redact = require("./serverlog").redact;
function scrub(value) {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([k]) =>
            !/(^password$|^secret$|^token$|privateKey|secretText|access_token|refresh_token)/i.test(
              k,
            ),
        )
        .map(([k, v]) => [k, scrub(v)]),
    );
  return value;
}
class PlatformStore {
  constructor(file) {
    if (file !== ":memory:")
      fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file, { timeout: 5000 });
    if (file !== ":memory:") fs.chmodSync(file, 0o600);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS platform_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS principals(principal TEXT PRIMARY KEY,role TEXT NOT NULL CHECK(role IN ('admin','member')),enabled INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS tenant_grants(principal TEXT NOT NULL REFERENCES principals(principal) ON DELETE CASCADE,tenant_id TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('reader','operator','manager')),PRIMARY KEY(principal,tenant_id));
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL,summary TEXT NOT NULL DEFAULT '{}',actor TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,available_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,max_attempts INTEGER NOT NULL DEFAULT 3,lease_owner TEXT,lease_until INTEGER,error TEXT,checkpoint TEXT);
      CREATE INDEX IF NOT EXISTS jobs_waiting ON jobs(status,available_at,created_at);
      CREATE INDEX IF NOT EXISTS jobs_tenant ON jobs(tenant_id,updated_at);
      CREATE UNIQUE INDEX IF NOT EXISTS jobs_pending_unique ON jobs(tenant_id,kind) WHERE status IN ('queued','retry');
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,actor TEXT NOT NULL,tenant_id TEXT,action TEXT NOT NULL,reference TEXT,result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sync_state(tenant_id TEXT NOT NULL,source TEXT NOT NULL,attempt_at INTEGER,success_at INTEGER,next_at INTEGER,failures INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'never',error TEXT,PRIMARY KEY(tenant_id,source));
      CREATE TABLE IF NOT EXISTS sync_cursors(tenant_id TEXT NOT NULL,source TEXT NOT NULL,watermark INTEGER NOT NULL,PRIMARY KEY(tenant_id,source));
      CREATE TABLE IF NOT EXISTS signins(tenant_id TEXT NOT NULL,event_id TEXT NOT NULL,at INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(tenant_id,event_id));
      CREATE INDEX IF NOT EXISTS signins_time ON signins(tenant_id,at);
      INSERT OR IGNORE INTO platform_meta VALUES('schema','1');`);
  }
  tx(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  close() {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
  audit(actor, tenant, action, reference, result) {
    this.db
      .prepare(
        "INSERT INTO audit(at,actor,tenant_id,action,reference,result) VALUES(?,?,?,?,?,?)",
      )
      .run(
        Date.now(),
        String(actor || "system"),
        tenant || null,
        action,
        reference || null,
        result,
      );
  }
  bootstrap(localAdmin, ssoAdmin) {
    this.localAdmin = localAdmin;
    this.tx(() => {
      if (
        this.db
          .prepare(
            "SELECT value FROM platform_meta WHERE key='rbac_initialized'",
          )
          .get()
      )
        return;
      if (ssoAdmin)
        this.db
          .prepare(
            "INSERT OR IGNORE INTO principals(principal,role,enabled) VALUES(?,'admin',1)",
          )
          .run("sso:" + ssoAdmin.toLowerCase());
      this.db
        .prepare("INSERT INTO platform_meta VALUES('rbac_initialized','1')")
        .run();
      this.audit("system", null, "rbac.bootstrap", null, "initialized");
    });
  }
  access(principal) {
    if (String(principal || "").startsWith("sso:"))
      principal = principal.toLowerCase();
    if (principal && principal === this.localAdmin)
      return { principal, admin: true, enabled: true, grants: {} };
    const p = this.db
      .prepare("SELECT * FROM principals WHERE principal=?")
      .get(String(principal || ""));
    const grants = {};
    if (p?.enabled)
      for (const g of this.db
        .prepare("SELECT tenant_id,role FROM tenant_grants WHERE principal=?")
        .all(principal))
        grants[g.tenant_id] = g.role;
    return {
      principal,
      admin: !!(p?.enabled && p.role === "admin"),
      enabled: !!p?.enabled,
      grants,
    };
  }
  listAccess() {
    return this.db
      .prepare("SELECT * FROM principals ORDER BY principal")
      .all()
      .map((p) => ({
        ...p,
        enabled: !!p.enabled,
        grants: this.db
          .prepare(
            "SELECT tenant_id AS tenantId,role FROM tenant_grants WHERE principal=?",
          )
          .all(p.principal),
      }));
  }
  setAccess(actor, input, tenantIds) {
    const principal = String(input.principal || "")
      .trim()
      .toLowerCase();
    if (
      !/^sso:[^\s@]+@[^\s@]+\.[^\s@]+$/.test(principal) ||
      principal.length > 250
    )
      throw Object.assign(
        new Error("SSO-Identität als sso:name@domain erforderlich."),
        { status: 400 },
      );
    if (
      !["admin", "member"].includes(input.role) ||
      typeof input.enabled !== "boolean" ||
      !Array.isArray(input.grants)
    )
      throw Object.assign(new Error("Ungültige Rollenangaben."), {
        status: 400,
      });
    const unique = new Set();
    for (const g of input.grants) {
      if (
        !tenantIds.includes(g.tenantId) ||
        !["reader", "operator", "manager"].includes(g.role) ||
        unique.has(g.tenantId)
      )
        throw Object.assign(
          new Error("Ungültige oder doppelte Tenant-Zuweisung."),
          { status: 400 },
        );
      unique.add(g.tenantId);
    }
    if (
      principal === String(actor).toLowerCase() &&
      (!input.enabled || input.role !== "admin")
    )
      throw Object.assign(
        new Error("Eigene Admin-Freigabe kann hier nicht entzogen werden."),
        { status: 409 },
      );
    this.tx(() => {
      this.db
        .prepare(
          "INSERT INTO principals VALUES(?,?,?) ON CONFLICT(principal) DO UPDATE SET role=excluded.role,enabled=excluded.enabled",
        )
        .run(principal, input.role, input.enabled ? 1 : 0);
      this.db
        .prepare("DELETE FROM tenant_grants WHERE principal=?")
        .run(principal);
      for (const g of input.grants)
        this.db
          .prepare("INSERT INTO tenant_grants VALUES(?,?,?)")
          .run(principal, g.tenantId, g.role);
      this.audit(
        actor,
        null,
        "access.update",
        principal,
        input.enabled ? input.role : "disabled",
      );
    });
  }
  enqueue(tenant, areas, actor, scheduled = false, now = Date.now()) {
    return this.tx(() => {
      const pending = this.db
        .prepare(
          "SELECT * FROM jobs WHERE tenant_id=? AND kind='managed' AND status IN ('queued','retry')",
        )
        .get(tenant.id);
      if (pending) {
        const p = parse(pending.payload, {});
        p.areas = [...new Set([...p.areas, ...areas])];
        if (!scheduled) p.scheduled = false;
        this.db
          .prepare("UPDATE jobs SET payload=?,actor=?,updated_at=? WHERE id=?")
          .run(
            JSON.stringify(p),
            scheduled ? pending.actor : actor,
            now,
            pending.id,
          );
        return this.job(pending.id);
      }
      const running = this.db
        .prepare(
          "SELECT * FROM jobs WHERE tenant_id=? AND kind='managed' AND status='running'",
        )
        .get(tenant.id);
      if (
        running &&
        areas.every((a) => parse(running.payload, {}).areas.includes(a))
      )
        return this.job(running.id);
      if (running)
        throw Object.assign(
          new Error(
            "Der laufende Sync umfasst andere Bereiche. Nach seinem Abschluss erneut starten.",
          ),
          { status: 409 },
        );
      const id = uuid(),
        payload = { areas, scheduled },
        summary = {
          tenantName: tenant.name,
          phase: "Wartet auf Worker",
          steps: [],
          isManaged: true,
          scheduled,
        };
      this.db
        .prepare(
          "INSERT INTO jobs(id,tenant_id,kind,status,payload,summary,actor,created_at,updated_at,available_at) VALUES(?,?,'managed','queued',?,?,?,?,?,?)",
        )
        .run(
          id,
          tenant.id,
          JSON.stringify(payload),
          JSON.stringify(scrub(summary)),
          actor,
          now,
          now,
          now,
        );
      this.audit(actor, tenant.id, "job.enqueued", id, "queued");
      return this.job(id);
    });
  }
  job(id) {
    const r = this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id);
    return r
      ? {
          ...r,
          payload: parse(r.payload, {}),
          summary: parse(r.summary, {}),
          checkpoint: parse(r.checkpoint, null),
        }
      : null;
  }
  jobs() {
    return this.db
      .prepare("SELECT id FROM jobs ORDER BY updated_at DESC LIMIT 500")
      .all()
      .map((r) => this.job(r.id));
  }
  publicJob(j) {
    return {
      ...j.summary,
      id: j.id,
      tenantId: j.tenant_id,
      kind: j.kind,
      status: ["queued", "retry", "running"].includes(j.status)
        ? "running"
        : j.status === "partial"
          ? "done"
          : j.status,
      queueState: j.status,
      attempts: j.attempts,
      maxAttempts: j.max_attempts,
      requestedBy: j.actor,
      createdAt: new Date(j.created_at).toISOString(),
      startedAt: j.summary.startedAt || new Date(j.created_at).toISOString(),
      finishedAt: [
        "done",
        "partial",
        "failed",
        "cancelled",
        "interrupted",
      ].includes(j.status)
        ? new Date(j.updated_at).toISOString()
        : null,
      error: j.error || j.summary.error || null,
      durable: true,
      nextAttemptAt: new Date(j.available_at).toISOString(),
    };
  }
  claim(owner, now, leaseMs, blockedTenants = []) {
    return this.tx(() => {
      this.recover(now);
      const eligible = this.db
        .prepare(
          "SELECT id,tenant_id FROM jobs WHERE kind='managed' AND status IN ('queued','retry') AND available_at<=? ORDER BY available_at,created_at",
        )
        .all(now);
      const row = eligible.find(
        (r) =>
          !blockedTenants.includes(r.tenant_id) &&
          !this.db
            .prepare(
              "SELECT id FROM jobs WHERE tenant_id=? AND status='running' AND lease_until>?",
            )
            .get(r.tenant_id, now),
      );
      if (!row) return null;
      this.db
        .prepare(
          "UPDATE jobs SET status='running',attempts=attempts+1,lease_owner=?,lease_until=?,updated_at=? WHERE id=?",
        )
        .run(owner, now + leaseMs, now, row.id);
      this.audit("worker", row.tenant_id, "job.claimed", row.id, "running");
      return this.job(row.id);
    });
  }
  recover(now = Date.now()) {
    const rows = this.db
      .prepare(
        "SELECT * FROM jobs WHERE kind='managed' AND status='running' AND lease_until<=?",
      )
      .all(now);
    for (const j of rows) {
      const status = j.attempts >= j.max_attempts ? "failed" : "retry";
      this.db
        .prepare(
          "UPDATE jobs SET status=?,lease_owner=NULL,lease_until=NULL,available_at=?,updated_at=?,error=? WHERE id=?",
        )
        .run(
          status,
          now,
          now,
          "Worker-Lease abgelaufen; Lauf wird kontrolliert wiederholt.",
          j.id,
        );
      this.audit("system", j.tenant_id, "job.recovered", j.id, status);
    }
  }
  heartbeat(id, owner, now, leaseMs) {
    return (
      this.db
        .prepare(
          "UPDATE jobs SET lease_until=?,updated_at=? WHERE id=? AND status='running' AND lease_owner=? AND lease_until>?",
        )
        .run(now + leaseMs, now, id, owner, now).changes === 1
    );
  }
  progress(id, owner, summary, checkpoint) {
    const now = Date.now();
    const sql =
      checkpoint === undefined
        ? "UPDATE jobs SET summary=?,updated_at=? WHERE id=? AND status='running' AND lease_owner=? AND lease_until>?"
        : "UPDATE jobs SET summary=?,updated_at=?,checkpoint=? WHERE id=? AND status='running' AND lease_owner=? AND lease_until>?";
    const args =
      checkpoint === undefined
        ? [JSON.stringify(scrub(summary)), now, id, owner, now]
        : [
            JSON.stringify(scrub(summary)),
            now,
            JSON.stringify(checkpoint),
            id,
            owner,
            now,
          ];
    if (!this.db.prepare(sql).run(...args).changes)
      throw new Error("Worker-Lease verloren.");
  }
  finish(id, owner, status, error = null, retryMs = 0) {
    error = error ? redact(String(error)) : null;
    const now = Date.now();
    return this.tx(() => {
      const j = this.job(id);
      if (
        !j ||
        j.status !== "running" ||
        j.lease_owner !== owner ||
        j.lease_until <= now
      )
        return false;
      const target =
        status === "retry" && j.attempts >= j.max_attempts ? "failed" : status;
      this.db
        .prepare(
          "UPDATE jobs SET status=?,error=?,lease_owner=NULL,lease_until=NULL,updated_at=?,available_at=? WHERE id=?",
        )
        .run(target, error, now, now + retryMs, id);
      this.audit("worker", j.tenant_id, "job.finished", id, target);
      return true;
    });
  }
  retry(id, actor) {
    return this.tx(() => {
      const j = this.job(id);
      if (
        !j ||
        j.kind !== "managed" ||
        !["failed", "partial", "interrupted"].includes(j.status)
      )
        throw Object.assign(
          new Error("Dieser Job ist nicht erneut startbar."),
          { status: 409 },
        );
      if (
        this.db
          .prepare(
            "SELECT id FROM jobs WHERE tenant_id=? AND kind='managed' AND status IN ('queued','retry','running')",
          )
          .get(j.tenant_id)
      )
        throw Object.assign(
          new Error("Für diesen Tenant ist bereits ein Lauf aktiv."),
          { status: 409 },
        );
      this.db
        .prepare(
          "UPDATE jobs SET status='queued',actor=?,payload=?,summary=?,attempts=0,available_at=?,updated_at=?,checkpoint=NULL,error=NULL WHERE id=?",
        )
        .run(
          actor,
          JSON.stringify({ ...j.payload, scheduled: false }),
          JSON.stringify({
            tenantName: j.summary.tenantName,
            phase: "Wartet auf Worker",
            steps: [],
            isManaged: true,
          }),
          Date.now(),
          Date.now(),
          id,
        );
      this.audit(actor, j.tenant_id, "job.retry", id, "queued");
      return this.job(id);
    });
  }
  cancel(id, actor) {
    return this.tx(() => {
      const j = this.job(id);
      if (!j || !["queued", "retry"].includes(j.status))
        throw Object.assign(new Error("Nur wartende Jobs sind abbrechbar."), {
          status: 409,
        });
      this.db
        .prepare("UPDATE jobs SET status='cancelled',updated_at=? WHERE id=?")
        .run(Date.now(), id);
      this.audit(actor, j.tenant_id, "job.cancel", id, "cancelled");
    });
  }
  saveLegacy(job) {
    const safe = {};
    for (const k of [
      "id",
      "tenantId",
      "tenantName",
      "status",
      "phase",
      "steps",
      "startedAt",
      "finishedAt",
      "error",
      "hint",
      "isManaged",
    ])
      if (job[k] !== undefined) safe[k] = job[k];
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO jobs(id,tenant_id,kind,status,payload,summary,actor,created_at,updated_at,available_at,max_attempts) VALUES(?,?,'legacy',?,'{}',?,'legacy',?,?,?,1) ON CONFLICT(id) DO UPDATE SET status=excluded.status,summary=excluded.summary,updated_at=excluded.updated_at",
      )
      .run(
        job.id,
        job.tenantId,
        job.status,
        JSON.stringify(scrub(safe)),
        Date.parse(job.startedAt) || now,
        now,
        now,
      );
  }
  interruptLegacy() {
    this.db
      .prepare(
        "UPDATE jobs SET status='interrupted',error='Backend neu gestartet; schreibender Alt-Job wird nicht automatisch wiederholt.',updated_at=? WHERE kind='legacy' AND status='running'",
      )
      .run(Date.now());
  }
  sync(tenant) {
    return this.db
      .prepare("SELECT * FROM sync_state WHERE tenant_id=?")
      .all(tenant);
  }
  syncStart(tenant, source) {
    this.db
      .prepare(
        "INSERT INTO sync_state(tenant_id,source,attempt_at,status) VALUES(?,?,?,'running') ON CONFLICT(tenant_id,source) DO UPDATE SET attempt_at=excluded.attempt_at,status='running'",
      )
      .run(tenant, source, Date.now());
  }
  syncFinish(tenant, source, error, intervalMs, permission = false) {
    error = error ? redact(String(error)) : null;
    const now = Date.now();
    const old = this.db
      .prepare("SELECT * FROM sync_state WHERE tenant_id=? AND source=?")
      .get(tenant, source);
    const failures = error ? (old?.failures || 0) + 1 : 0;
    const backoff = error
      ? permission
        ? Math.max(intervalMs, 3600000)
        : Math.min(3600000, 60000 * 2 ** Math.min(failures - 1, 6))
      : intervalMs;
    this.db
      .prepare(
        "INSERT INTO sync_state(tenant_id,source,attempt_at,success_at,next_at,failures,status,error) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,source) DO UPDATE SET success_at=excluded.success_at,next_at=excluded.next_at,failures=excluded.failures,status=excluded.status,error=excluded.error",
      )
      .run(
        tenant,
        source,
        old?.attempt_at || now,
        error ? old?.success_at || null : now,
        now + backoff,
        failures,
        error ? (permission ? "blocked" : "error") : "ok",
        error || null,
      );
  }
  cursor(tenant, source) {
    return (
      this.db
        .prepare(
          "SELECT watermark FROM sync_cursors WHERE tenant_id=? AND source=?",
        )
        .get(tenant, source)?.watermark || null
    );
  }
  commitSignins(tenant, events, watermark) {
    this.tx(() => {
      const insert = this.db.prepare(
        "INSERT OR IGNORE INTO signins VALUES(?,?,?,?)",
      );
      for (const e of events)
        insert.run(tenant, e.id, Date.parse(e.at), JSON.stringify(e));
      this.db
        .prepare(
          "INSERT INTO sync_cursors VALUES(?,?,?) ON CONFLICT(tenant_id,source) DO UPDATE SET watermark=MAX(watermark,excluded.watermark)",
        )
        .run(tenant, "signins", watermark);
      this.db
        .prepare("DELETE FROM signins WHERE tenant_id=? AND at<?")
        .run(tenant, Date.now() - 7 * 86400000);
    });
  }
  signins(tenant, since, limit = 1000) {
    const rows = this.db
      .prepare(
        "SELECT body FROM signins WHERE tenant_id=? AND at>=? ORDER BY at DESC LIMIT ?",
      )
      .all(tenant, since, limit + 1);
    return {
      sampled: rows.length > limit,
      signins: rows.slice(0, limit).map((r) => parse(r.body, {})),
    };
  }
}
module.exports = { PlatformStore };
