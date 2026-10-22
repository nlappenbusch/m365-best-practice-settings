"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const { PlatformStore } = require("../lib/platformStore"),
  { DurableWorker } = require("../lib/durableWorker");
const settle = () => new Promise((r) => setImmediate(r));
test("worker respects concurrency and busy tenant exclusions, persists progress, and drains on shutdown", async (t) => {
  const s = new PlatformStore(":memory:"),
    gates = new Map(),
    started = [];
  for (const id of ["a", "b", "c"])
    s.enqueue({ id, name: id }, ["risk"], "admin");
  const w = new DurableWorker(
    s,
    async (j, ctx) => {
      started.push(j.tenant_id);
      ctx.progress({ phase: "Collecting", steps: [] });
      await new Promise((r) => gates.set(j.id, r));
      return { partial: j.tenant_id === "c" };
    },
    { concurrency: 2, blockedTenants: () => ["a"] },
  );
  t.after(async () => {
    for (const r of gates.values()) r();
    await w.stop();
    s.close();
  });
  w.tick();
  assert.deepEqual(started, ["b", "c"]);
  assert.equal(w.active.size, 2);
  assert.equal(s.jobs().find((j) => j.tenant_id === "a").status, "queued");
  for (const r of gates.values()) r();
  await w.stop();
  await settle();
  assert.equal(s.jobs().find((j) => j.tenant_id === "b").status, "done");
  assert.equal(s.jobs().find((j) => j.tenant_id === "c").status, "partial");
  w.tick();
  assert.equal(s.jobs().find((j) => j.tenant_id === "a").status, "queued");
});
test("transient errors are retried and permanent authorization errors terminate without replay", async (t) => {
  const s = new PlatformStore(":memory:");
  let calls = 0;
  const w = new DurableWorker(s, async () => {
    calls++;
    if (calls === 1)
      throw Object.assign(new Error("503 unavailable"), { status: 503 });
    throw Object.assign(new Error("Permission revoked"), { status: 403 });
  });
  t.after(async () => {
    await w.stop();
    s.close();
  });
  const j = s.enqueue({ id: "a" }, ["risk"], "admin");
  w.tick();
  await settle();
  assert.equal(s.job(j.id).status, "retry");
  s.db.prepare("UPDATE jobs SET available_at=0 WHERE id=?").run(j.id);
  w.tick();
  await settle();
  assert.equal(s.job(j.id).status, "failed");
  assert.equal(calls, 2);
});
