"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  express = require("express");
const { PlatformStore } = require("../lib/platformStore"),
  A = require("../lib/tenantAccess");
test("HTTP access isolation covers tenant URLs, aggregate lists, job IDs and alternate body routes", async (t) => {
  const s = new PlatformStore(":memory:");
  s.bootstrap("admin", "owner@example.com");
  for (const role of ["reader", "operator", "manager"])
    s.setAccess(
      "admin",
      {
        principal: `sso:${role}@example.com`,
        role: "member",
        enabled: true,
        grants: [{ tenantId: "a", role }],
      },
      ["a", "b"],
    );
  const job = s.enqueue({ id: "b" }, ["risk"], "admin");
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = { user: req.headers["x-user"] };
    next();
  });
  app.use("/api", A.middleware(s));
  app.get("/api/tenants", (req, res) =>
    res.json(A.filtered(req.access, [{ id: "a" }, { id: "b" }])),
  );
  app.get("/api/tenants/:id/cockpit/identity", (req, res) =>
    res.json({ tenant: req.params.id }),
  );
  app.post("/api/tenants/:id/managed/run", (req, res) =>
    res.json({ ok: true }),
  );
  app.put("/api/tenants/:id/managed/settings", (req, res) =>
    res.json({ ok: true }),
  );
  app.all("/api/*", (req, res) => res.json({ unexpected: true }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    s.close();
  });
  const req = async (path, role = "reader", method = "GET", body) => {
    const r = await fetch(
      `http://127.0.0.1:${server.address().port}/api${path}`,
      {
        method,
        headers: {
          "x-user":
            role === "unknown"
              ? "sso:unknown@example.com"
              : `sso:${role}@example.com`,
          "content-type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      },
    );
    return { status: r.status, data: await r.json() };
  };
  assert.equal((await req("/tenants/a/cockpit/identity")).status, 200);
  assert.equal((await req("/tenants/b/cockpit/identity")).status, 403);
  assert.deepEqual((await req("/tenants")).data, [{ id: "a" }]);
  assert.equal(
    (await req("/tenants/a/managed/run", "reader", "POST")).status,
    403,
  );
  assert.equal(
    (await req("/tenants/a/managed/run", "operator", "POST")).status,
    200,
  );
  assert.equal(
    (await req("/tenants/a/managed/settings", "operator", "PUT", {})).status,
    403,
  );
  assert.equal(
    (await req("/tenants/a/managed/settings", "manager", "PUT", {})).status,
    200,
  );
  for (const p of [
    "/platform/access",
    "/reports/overview",
    "/serverlog",
    `/appjobs/${job.id}`,
    "/tenants/a/new-unclassified-route",
    "/tenants/a/cockpit/new-unclassified-route",
    "/tenants/a/managed/new-unclassified-route",
  ])
    assert.equal((await req(p)).status, 403, p);
  assert.equal(
    (await req("/execution/run", "manager", "POST", { tenantId: "b" })).status,
    403,
  );
  assert.equal(
    (await req("/grouptags/groups", "manager", "POST", { tenantId: "b" }))
      .status,
    403,
  );
  assert.equal(
    (await req("/tenants/a/cockpit/identity", "unknown")).status,
    403,
  );
  assert.deepEqual((await req("/tenants", "unknown")).data, []);
  s.setAccess(
    "admin",
    {
      principal: "sso:reader@example.com",
      role: "member",
      enabled: false,
      grants: [],
    },
    ["a", "b"],
  );
  assert.equal((await req("/tenants/a/cockpit/identity")).status, 403);
});
