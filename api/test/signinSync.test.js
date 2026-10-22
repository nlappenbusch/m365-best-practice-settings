"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const G = require("../lib/graph");
const { PlatformStore } = require("../lib/platformStore");
const { collectSignins } = require("../lib/signinSync");
const event = (id) => ({
  id,
  createdDateTime: new Date(Date.now() - 300000).toISOString(),
  userPrincipalName: "test@example.com",
  status: { errorCode: 0 },
});
test("pagination failure preserves cursor and events; successful overlap is deduplicated and tenant-scoped", async (t) => {
  const s = new PlatformStore(":memory:"),
    old = G.graphReq;
  t.after(() => {
    G.graphReq = old;
    s.close();
  });
  const prior = Date.now() - 3600000;
  s.commitSignins("a", [], prior);
  let fail = true,
    calls = [];
  G.graphReq = async (t, c, m, p) => {
    calls.push(p);
    if (!p.includes("$skiptoken"))
      return {
        value: [event("one")],
        "@odata.nextLink":
          "https://graph.microsoft.com/v1.0/auditLogs/signIns?$skiptoken=x",
      };
    if (fail)
      throw Object.assign(new Error("Graph throttled"), { status: 429 });
    return { value: [event("two")] };
  };
  await assert.rejects(
    () => collectSignins({ id: "a" }, "", { platform: s }),
    /throttled/,
  );
  assert.equal(s.cursor("a", "signins"), prior);
  assert.equal(s.signins("a", 0).signins.length, 0);
  fail = false;
  await collectSignins({ id: "a" }, "", { platform: s });
  assert.equal(s.signins("a", 0).signins.length, 2);
  assert.ok(s.cursor("a", "signins") > prior);
  await collectSignins({ id: "a" }, "", { platform: s });
  assert.equal(s.signins("a", 0).signins.length, 2);
  assert.equal(s.signins("b", 0).signins.length, 0);
  assert.ok(
    decodeURIComponent(calls[0]).includes(
      new Date(prior - 600000).toISOString(),
    ),
  );
});
test("foreign/cyclic next links, invalid responses and lost leases never commit a cursor", async (t) => {
  const s = new PlatformStore(":memory:"),
    old = G.graphReq;
  t.after(() => {
    G.graphReq = old;
    s.close();
  });
  G.graphReq = async () => ({
    value: [event("x")],
    "@odata.nextLink": "https://evil.example/v1.0/auditLogs/signIns",
  });
  await assert.rejects(
    () => collectSignins({ id: "a" }, "", { platform: s }),
    /Folgelink/,
  );
  G.graphReq = async () => ({ value: [event("x")] });
  await assert.rejects(
    () =>
      collectSignins({ id: "a" }, "", {
        platform: s,
        assertLease: () => {
          throw new Error("Lease lost");
        },
      }),
    /Lease lost/,
  );
  assert.equal(s.cursor("a", "signins"), null);
  assert.equal(s.signins("a", 0).signins.length, 0);
});
