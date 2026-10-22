"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("fs"),
  path = require("path"),
  os = require("os"),
  express = require("express");
const { PlatformStore } = require("../lib/platformStore"),
  A = require("../lib/tenantAccess"),
  C = require("../lib/managedCollectors");
test("managed HTTP runs execute through the durable worker and recheck revoked tenant access before collection", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m36-managed-")),
    cert = path.join(dir, "test.pem");
  fs.writeFileSync(cert, "not-a-real-certificate");
  const platform = new PlatformStore(path.join(dir, "platform.sqlite"));
  platform.bootstrap("admin", "owner@example.com");
  let state = {
    tenants: [
      {
        id: "a",
        tenantId: "a",
        name: "Test",
        organization: "example.onmicrosoft.com",
        managed: { enabled: false, autoTicket: "off" },
      },
    ],
  };
  const grant = (enabled) =>
    platform.setAccess(
      "admin",
      {
        principal: "sso:op@example.com",
        role: "member",
        enabled,
        grants: [{ tenantId: "a", role: "operator" }],
      },
      ["a"],
    );
  grant(true);
  let collected = 0;
  const previous = C.GRAPH_COLLECTORS.credentials;
  C.GRAPH_COLLECTORS.credentials = async () => {
    collected++;
    return { metrics: [], data: { credentials: [] }, findings: [] };
  };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = { user: "sso:op@example.com" };
    next();
  });
  app.use("/api", A.middleware(platform));
  const jobs = new Map(),
    summary = (j) => ({
      phase: j.phase,
      steps: j.steps,
      tenantName: j.tenantName,
    });
  const runtime = require("../lib/managedRoutes").register(app, {
    STATE_DIR: dir,
    platform,
    loadState: () => structuredClone(state),
    saveState: (s) => (state = s),
    certPemPath: () => cert,
    requireTenant: () => state.tenants[0],
    wrap: (f) => (req, res, next) => Promise.resolve(f(req, res)).catch(next),
    createAppJob: () => {
      throw new Error("Legacy job path must not be used");
    },
    appJobProgress: (j) => (label) => {
      j.phase = label;
      j._durableProgress(summary(j));
    },
    finishAppJob: (j, ok, error) => {
      j.error = error;
      j.status = ok ? "done" : "failed";
      j._durableProgress(summary(j));
    },
    appJobs: jobs,
    SDP: { config: () => ({ enabled: false }) },
    AISUGGEST: {},
    jobSummary: summary,
  });
  app.use((e, req, res, next) =>
    res.status(e.status || 500).json({ error: e.message }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await runtime.stop();
    C.GRAPH_COLLECTORS.credentials = previous;
    platform.close();
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith("m36-managed-"));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const enqueue = async () => {
    const r = await fetch(
      `http://127.0.0.1:${server.address().port}/api/tenants/a/managed/run`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ areas: ["credentials"] }),
      },
    );
    assert.equal(r.status, 200);
    return (await r.json()).jobId;
  };
  const first = await enqueue();
  assert.equal(platform.job(first).status, "queued");
  runtime.worker.tick();
  await Promise.allSettled(runtime.worker.active.values());
  assert.equal(platform.job(first).status, "done");
  assert.equal(platform.sync("a")[0].status, "ok");
  assert.equal(collected, 1);
  const second = await enqueue();
  grant(false);
  runtime.worker.tick();
  await Promise.allSettled(runtime.worker.active.values());
  assert.equal(platform.job(second).status, "failed");
  assert.match(platform.job(second).error, /entzogen/);
  assert.equal(collected, 1);
});
