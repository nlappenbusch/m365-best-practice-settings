"use strict";
const A = require("./tenantAccess");
function register(app, { platform, loadState, wrap }) {
  app.get("/api/platform/me", (req, res) =>
    res.json({ ok: true, access: platform.access(req.session.user) }),
  );
  app.get("/api/platform/access", (req, res) =>
    res.json({
      ok: true,
      principals: platform.listAccess(),
      localAdmin: platform.localAdmin,
      tenants: (loadState().tenants || []).map((t) => ({
        id: t.id,
        name: t.name,
      })),
    }),
  );
  app.put(
    "/api/platform/access",
    wrap(async (req, res) => {
      platform.setAccess(
        req.session.user,
        req.body || {},
        (loadState().tenants || []).map((t) => t.id),
      );
      res.json({ ok: true });
    }),
  );
  app.get("/api/platform/jobs", (req, res) =>
    res.json({
      ok: true,
      jobs: platform
        .jobs()
        .filter((j) => A.visible(req.access, j.tenant_id))
        .map((j) => platform.publicJob(j)),
    }),
  );
  app.post(
    "/api/platform/jobs/:id/retry",
    wrap(async (req, res) => {
      const j = platform.job(req.params.id);
      if (!j || !A.allowed(req.access, j.tenant_id, "operator"))
        return res.status(403).json({ error: "Keine Berechtigung." });
      res.json({
        ok: true,
        job: platform.publicJob(platform.retry(j.id, req.session.user)),
      });
    }),
  );
  app.post(
    "/api/platform/jobs/:id/cancel",
    wrap(async (req, res) => {
      const j = platform.job(req.params.id);
      if (!j || !A.allowed(req.access, j.tenant_id, "operator"))
        return res.status(403).json({ error: "Keine Berechtigung." });
      platform.cancel(j.id, req.session.user);
      res.json({ ok: true });
    }),
  );
  app.get("/api/platform/audit", (req, res) =>
    res.json({
      ok: true,
      entries: platform.db
        .prepare("SELECT * FROM audit ORDER BY id DESC LIMIT 300")
        .all(),
    }),
  );
  app.get("/api/tenants/:id/sync", (req, res) => {
    const tenant = (loadState().tenants || []).find(
      (t) => t.id === req.params.id,
    );
    if (!tenant)
      return res.status(404).json({ error: "Tenant nicht gefunden." });
    const active = platform
      .jobs()
      .filter(
        (j) =>
          j.tenant_id === req.params.id &&
          ["queued", "retry", "running"].includes(j.status),
      );
    const states = Object.fromEntries(
      platform.sync(req.params.id).map((s) => [s.source, s]),
    );
    const S = require("./managedService"),
      cfg = S.settingsOf(tenant);
    res.json({
      ok: true,
      sources: S.AREAS.map((a) => {
        const s = states[a.id] || { source: a.id, status: "never" },
          interval =
            a.engine === "exo"
              ? cfg.exoIntervalHours * 3600000
              : (a.intervalMin || cfg.graphIntervalMin) * 60000;
        return {
          ...s,
          label: a.label,
          ageMs: s.success_at ? Date.now() - s.success_at : null,
          status:
            s.status === "running" && !active.length ? "interrupted" : s.status,
          freshness: !s.success_at
            ? "never"
            : Date.now() - s.success_at > interval * 2 + 120000
              ? "stale"
              : "current",
        };
      }),
      jobs: active.map((j) => platform.publicJob(j)),
    });
  });
}
module.exports = { register };
