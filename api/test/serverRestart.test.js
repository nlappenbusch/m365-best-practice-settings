"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("fs"),
  path = require("path"),
  os = require("os");
const { spawn } = require("child_process");
const { PlatformStore } = require("../lib/platformStore");
test("real API process preserves job history across restart and keeps unauthenticated requests blocked", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m36-server-"));
  let child;
  t.after(async () => {
    if (child && child.exitCode === null) {
      child.kill();
      await new Promise((r) => child.once("exit", r));
    }
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith("m36-server-"));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.writeFileSync(
    path.join(dir, "state.json"),
    JSON.stringify({
      tenants: [
        {
          id: "a",
          tenantId: "a",
          name: "Test",
          organization: "example.onmicrosoft.com",
          managed: { enabled: false, autoTicket: "off" },
        },
      ],
    }),
  );
  const db = new PlatformStore(path.join(dir, "platform.sqlite"));
  db.saveLegacy({
    id: "previous-write",
    tenantId: "a",
    status: "running",
    phase: "Provisioning",
    steps: [],
  });
  db.close();
  async function boot() {
    return new Promise((resolve, reject) => {
      child = spawn(process.execPath, [path.join(__dirname, "../server.js")], {
        env: {
          ...process.env,
          PORT: "0",
          STATE_DIR: dir,
          ADMIN_USER: "smoke",
          ADMIN_PASSWORD: "local-test-password-for-smoke",
          PWSH_PATH: "nonexistent-pwsh-for-test",
          FAKE_DEPLOY: "1",
          MANAGED_TEAMS_WEBHOOK: "",
          SDP_API_KEY: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let logs = "";
      const timeout = setTimeout(
        () => reject(new Error("API boot timeout: " + logs.slice(-1500))),
        10000,
      );
      child.once("error", (e) => {
        clearTimeout(timeout);
        reject(e);
      });
      child.stdout.on("data", (chunk) => {
        logs += chunk;
        const m = logs.match(/laeuft auf Port (\d+)/);
        if (m) {
          clearTimeout(timeout);
          resolve("http://127.0.0.1:" + m[1]);
        }
      });
      child.stderr.on("data", (chunk) => (logs += chunk));
      child.once("exit", (code) => {
        clearTimeout(timeout);
        if (!logs.includes("laeuft auf Port"))
          reject(new Error("API exited " + code + ": " + logs.slice(-1500)));
      });
    });
  }
  let base = await boot();
  assert.equal((await fetch(base + "/api/platform/jobs")).status, 401);
  async function login() {
    const r = await fetch(base + "/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "smoke",
        password: "local-test-password-for-smoke",
      }),
    });
    assert.equal(r.status, 200);
    return r.headers.get("set-cookie").split(";")[0];
  }
  let cookie = await login();
  let jobs = await (
    await fetch(base + "/api/platform/jobs", { headers: { cookie } })
  ).json();
  assert.equal(
    jobs.jobs.find((j) => j.id === "previous-write").queueState,
    "interrupted",
  );
  const oldCookie = cookie;
  const exited = new Promise((r) => child.once("exit", r));
  child.kill();
  await exited;
  child = null;
  base = await boot();
  assert.equal(
    (
      await fetch(base + "/api/platform/jobs", {
        headers: { cookie: oldCookie },
      })
    ).status,
    401,
  );
  cookie = await login();
  jobs = await (
    await fetch(base + "/api/platform/jobs", { headers: { cookie } })
  ).json();
  assert.equal(
    jobs.jobs.find((j) => j.id === "previous-write").queueState,
    "interrupted",
  );
});
