"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("fs"),
  os = require("os"),
  path = require("path");
const { PlatformStore } = require("../lib/platformStore");
function disk(t, close) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m36-platform-"));
  t.after(() => {
    close?.();
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith("m36-platform-"));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return path.join(dir, "platform.sqlite");
}
test("queued jobs and expired worker leases survive a database reopen; stale workers are fenced", (t) => {
  let s;
  const file = disk(t, () => s?.close());
  s = new PlatformStore(file);
  const job = s.enqueue({ id: "a", name: "A" }, ["risk"], "admin"),
    now = Date.now();
  assert.equal(s.claim("old", now + 1, 1000).id, job.id);
  s.close();
  s = new PlatformStore(file);
  t.after(() => s.close());
  assert.equal(s.job(job.id).status, "running");
  assert.equal(s.claim("new", now + 1002, 5000).id, job.id);
  assert.equal(s.job(job.id).attempts, 2);
  assert.equal(s.finish(job.id, "old", "done"), false);
  assert.equal(s.heartbeat(job.id, "old", now + 1003, 5000), false);
  assert.throws(() => s.progress(job.id, "old", { phase: "stale" }), /Lease/);
  assert.equal(s.finish(job.id, "new", "done"), true);
  assert.equal(s.job(job.id).status, "done");
  assert.equal(
    s.db
      .prepare("SELECT count(*) AS n FROM audit WHERE action='job.recovered'")
      .get().n,
    1,
  );
});
test("two connections cannot claim the same job; queued requests merge areas and preserve manual actor", (t) => {
  let s, other;
  const file = disk(t, () => {
    other?.close();
    s?.close();
  });
  s = new PlatformStore(file);
  other = new PlatformStore(file);
  t.after(() => {
    other.close();
    s.close();
  });
  const first = s.enqueue(
    { id: "a", name: "A" },
    ["risk"],
    "system:scheduler",
    true,
  );
  const merged = other.enqueue(
    { id: "a", name: "A" },
    ["score"],
    "sso:tech@example.com",
  );
  assert.equal(first.id, merged.id);
  assert.deepEqual(merged.payload.areas, ["risk", "score"]);
  assert.equal(merged.payload.scheduled, false);
  assert.equal(merged.actor, "sso:tech@example.com");
  const now = Date.now();
  assert.equal(s.claim("one", now, 10000).id, first.id);
  assert.equal(other.claim("two", now, 10000), null);
  assert.equal(other.enqueue({ id: "a" }, ["risk"], "tech").id, first.id);
  assert.throws(
    () => other.enqueue({ id: "a" }, ["devices"], "tech"),
    /andere Bereiche/,
  );
  const b = s.enqueue({ id: "b", name: "B" }, ["risk"], "admin");
  assert.equal(other.claim("two", Date.now(), 10000).id, b.id);
});
test("retry budgets terminate abandoned jobs; legacy write jobs remain interrupted and cannot auto-retry", (t) => {
  const s = new PlatformStore(":memory:");
  t.after(() => s.close());
  let now = Date.now();
  const j = s.enqueue({ id: "a" }, ["risk"], "admin");
  for (let i = 0; i < 3; i++) {
    assert.ok(s.claim("worker" + i, now, 1000));
    now += 1001;
  }
  assert.equal(s.claim("worker4", now, 1000), null);
  assert.equal(s.job(j.id).status, "failed");
  const retry = s.retry(j.id, "sso:operator@example.com");
  assert.equal(retry.status, "queued");
  assert.equal(retry.attempts, 0);
  assert.equal(retry.actor, "sso:operator@example.com");
  s.cancel(j.id, "operator");
  assert.equal(s.job(j.id).status, "cancelled");
  s.saveLegacy({
    id: "legacy",
    tenantId: "a",
    status: "running",
    phase: "Deploy",
    steps: [],
    result: { tempPassword: "DO-NOT-STORE" },
  });
  s.interruptLegacy();
  assert.equal(s.job("legacy").status, "interrupted");
  assert.ok(!JSON.stringify(s.job("legacy")).includes("DO-NOT-STORE"));
  assert.throws(() => s.retry("legacy", "admin"), /nicht erneut/);
});
test("sync failures preserve last success and persist backoff; secret-like messages are redacted", (t) => {
  const s = new PlatformStore(":memory:");
  t.after(() => s.close());
  s.syncStart("a", "signins");
  s.syncFinish("a", "signins", null, 600000);
  const before = s.sync("a")[0];
  s.syncStart("a", "signins");
  s.syncFinish("a", "signins", "token=0123456789abcdef", 600000);
  const failed = s.sync("a")[0];
  assert.equal(failed.success_at, before.success_at);
  assert.equal(failed.failures, 1);
  assert.equal(failed.status, "error");
  assert.ok(!failed.error.includes("0123456789abcdef"));
  s.syncFinish("a", "signins", "Forbidden", 600000, true);
  const blocked = s.sync("a")[0];
  assert.equal(blocked.status, "blocked");
  assert.ok(blocked.next_at >= Date.now() + 3599000);
  s.syncFinish("a", "signins", null, 600000);
  assert.equal(s.sync("a")[0].failures, 0);
});
test("bootstrap is one-time, new SSO users have no implicit tenant rights, and changes are immediate", (t) => {
  const s = new PlatformStore(":memory:");
  t.after(() => s.close());
  s.bootstrap("admin", "owner@example.com");
  s.bootstrap("admin", "other@example.com");
  assert.equal(s.access("admin").admin, true);
  assert.equal(s.access("sso:OWNER@example.com").admin, true);
  assert.equal(s.access("sso:other@example.com").admin, false);
  s.setAccess(
    "admin",
    {
      principal: "sso:tech@example.com",
      role: "member",
      enabled: true,
      grants: [{ tenantId: "a", role: "reader" }],
    },
    ["a", "b"],
  );
  assert.deepEqual(s.access("sso:tech@example.com").grants, { a: "reader" });
  s.setAccess(
    "admin",
    {
      principal: "sso:tech@example.com",
      role: "member",
      enabled: false,
      grants: [{ tenantId: "a", role: "manager" }],
    },
    ["a", "b"],
  );
  assert.deepEqual(s.access("sso:tech@example.com").grants, {});
  assert.throws(
    () =>
      s.setAccess(
        "sso:OWNER@example.com",
        {
          principal: "sso:owner@example.com",
          role: "member",
          enabled: true,
          grants: [],
        },
        ["a"],
      ),
    /Eigene/,
  );
});
