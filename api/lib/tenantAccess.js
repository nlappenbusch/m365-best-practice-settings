"use strict";
const rank = { reader: 1, operator: 2, manager: 3 };
const visible = (access, id) => !!(access?.admin || access?.grants?.[id]);
const allowed = (access, id, role = "reader") =>
  !!(access?.admin || (rank[access?.grants?.[id]] || 0) >= rank[role]);
const filtered = (access, rows, key = "id") =>
  rows.filter((r) => visible(access, r[key]));
const readPrefixes = [
  "inventory/latest",
  "licenses",
  "groups",
  "users/search",
  "conditionalaccess/policies",
  "conditionalaccess/users",
  "authmethods",
  "sharepoint",
  "sharepointsites",
  "report/latest",
  "maester/latest",
  "evidence/archive",
  "evidence/v3",
  "evidence/schedule",
  "istzustand",
  "adminroles",
];
function tenantRole(method, sub) {
  if (["GET", "HEAD"].includes(method))
    return /^(sync|cockpit\/(identity|geo\/plans|apps|signins|compliance|alarms|dmarc)|managed(?:\/(area\/[^/]+|stand(?:\/[^/]+\/pdf)?|profile|messages\/ai|reports|report))?)$/.test(
      sub,
    ) || readPrefixes.some((p) => sub === p || sub.startsWith(p + "/"))
      ? "reader"
      : null;
  if (
    /^(managed\/run|inventory\/run|report\/run|cockpit\/(alarms\/check|geo\/preview))$/.test(
      sub,
    )
  )
    return "operator";
  if (
    /^(managed\/findings\/[^/]+\/action|cockpit\/(compliance\/[^/]+|apps\/[^/]+\/review|dmarc\/import))$/.test(
      sub,
    )
  )
    return "operator";
  if (
    /^(cockpit\/(alarms\/[^/]+|geo\/apply)|managed\/(settings|baseline\/[^/]+)|conditionalaccess\/(deploy|apply-template|capture-template|compare-template|policies\/[^/]+\/(state|scope|delete))|user-actions\/[^/]+)$/.test(
      sub,
    )
  )
    return "manager";
  return null; // All new or unclassified routes remain admin-only.
}
function middleware(store) {
  return (req, res, next) => {
    if (req.path.startsWith("/mcp/v1/")) return next(); // Separate API-key authority and tenant permissions.
    const access = store.access(req.session?.user);
    req.access = access;
    if (access.admin) return next();
    const deny = () =>
      res
        .status(403)
        .json({ error: "Keine Berechtigung für diesen Bereich oder Tenant." });
    const m = req.path.match(/^\/tenants\/([^/]+)(?:\/(.*))?$/);
    if (m) {
      let id;
      try {
        id = decodeURIComponent(m[1]);
      } catch {
        return deny();
      }
      const required = tenantRole(req.method, m[2] || "");
      if (!required || !allowed(access, id, required)) return deny();
      req.authorizedTenantId = id;
      return next();
    }
    if (
      ["GET", "HEAD"].includes(req.method) &&
      [
        "/platform/me",
        "/platform/jobs",
        "/tenants",
        "/managed/fleet",
        "/managed/meta",
        "/appjobs",
      ].includes(req.path)
    )
      return next();
    const job = req.path.match(
      /^\/(?:appjobs|platform\/jobs)\/([^/]+)(?:\/(retry|cancel))?$/,
    );
    if (job) {
      const j = store.job(job[1]);
      if (!j || !allowed(access, j.tenant_id, job[2] ? "operator" : "reader"))
        return deny();
      if (job[2] && req.method !== "POST") return deny();
      if (!job[2] && !["GET", "HEAD"].includes(req.method)) return deny();
      return next();
    }
    return deny();
  };
}
module.exports = { visible, allowed, filtered, middleware, tenantRole };
