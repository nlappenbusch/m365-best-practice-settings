/**
 * App-Zielgruppen fuer App-Deployments (Patch My PC und selbst paketierte Agents).
 *
 * Prinzip (siehe Wissen -> Namenskonventionen): Eine App wird IMMER an genau
 * EINE Gruppe zugewiesen; welche Geraete sie bekommen, steuert das
 * Gruppen-Nesting -- die dynamische GroupTag-Geraetegruppe (z.B. AAD-DEV-STD)
 * wird als Mitglied der App-Gruppe aufgenommen, ihre Geraete sind dadurch
 * transitiv adressiert (Intune loest das beim App-Assignment auf).
 *
 * Deshalb liegt die komplette Zielgruppen-Vorbereitung hier -- auch fuer Apps,
 * die gar nicht ueber dieses Tool installiert werden, sondern ueber Patch My
 * PC: dort wird nur noch gegen die fertige Gruppe zugewiesen. Das Entra-/
 * Intune-Portal muss dafuer niemand mehr oeffnen.
 */
const { graphReq, graphAllPages } = require("./graph");
const GROUPTAGS = require("./groupTags");
const NAMING = require("./naming");

/**
 * Beide Zugangswege wie im GroupTag-Modul: onboardeter Tenant (Zertifikat)
 * oder fremder Tenant per Token. Alte Aufrufform (tenant, certPemPath, ...)
 * bleibt gueltig -- der Agent-Deploy nutzt sie.
 */
function toAccess(a, b) {
  if (a && a.kind) return a;
  return { kind: "cert", tenant: a, certPemPath: b };
}

async function req(access, method, path, body, opts) {
  if (access.kind === "cert") {
    return graphReq(access.tenant, access.certPemPath, method, path, body, opts);
  }
  return GROUPTAGS.accessReq(access, method, path, body, opts);
}

async function allPages(access, path, opts) {
  if (access.kind === "cert") {
    return graphAllPages(access.tenant, access.certPemPath, path, opts);
  }
  return GROUPTAGS.accessAllPages(access, path, opts);
}

/**
 * Die Muster kommen aus der Namenskonvention (lib/naming.js) -- global mit
 * Tenant-Override. `scheme` erzwingt ausnahmsweise ein bestimmtes Profil,
 * etwa wenn im Dialog bewusst das Altschema gewaehlt wird; ohne Angabe gilt
 * die Konvention des Tenants.
 */
const SEP = "\u0001";

function kindFor(managed) { return managed === "pmp" ? "pmpGroup" : "appGroup"; }

/** Alle bekannten Praefixe -- sonst findet das Tool nach einem Schemawechsel
 *  die eigenen Gruppen nicht mehr und legt daneben neue an. */
function allPrefixes(tenantId) {
  const out = [];
  ["appGroup", "pmpGroup"].forEach(kind => {
    NAMING.candidates(kind, { app: SEP }, tenantId).forEach(c => {
      const p = c.split(SEP)[0];
      if (p && out.indexOf(p) < 0) out.push(p);
    });
  });
  return out;
}

function sanitizeAppNameForGroup(name) {
  return String(name || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 60) || "App";
}

/** Gruppenname aus App-Name + Schema. managed: "app" (selbst paketiert) | "pmp" (Patch My PC). */
function buildAppGroupName(appName, opts) {
  opts = opts || {};
  const app = sanitizeAppNameForGroup(appName);
  const kind = kindFor(opts.managed);
  if (opts.scheme && NAMING.PROFILES[opts.scheme]) {
    return NAMING.render(NAMING.PROFILES[opts.scheme].templates[kind], { app });
  }
  return NAMING.name(kind, { app }, opts.tenantId);
}

function isAppGroupName(name, tenantId) {
  const n = String(name || "").toLowerCase();
  return allPrefixes(tenantId).some(p => n.startsWith(p.toLowerCase()));
}

function odataLit(s) { return String(s || "").replace(/'/g, "''"); }

/** App-Gruppe finden oder anlegen (idempotent). */
async function ensureAppGroup(a, b, appName, opts) {
  const access = toAccess(a, b);
  opts = opts || {};
  const displayName = String(opts.displayName || "").trim() || buildAppGroupName(appName, opts);
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{2,63}$/.test(displayName)) {
    const e = new Error("Gruppenname: 3-64 Zeichen, nur Buchstaben, Ziffern, Leerzeichen, . _ -");
    e.status = 400;
    throw e;
  }

  const existing = await allPages(access,
    `/groups?$filter=displayName eq '${odataLit(displayName)}'&$select=id,displayName`, { retryTransient: true });
  if (existing.length) return { id: existing[0].id, displayName, created: false };

  const g = await req(access, "POST", "/groups", {
    displayName,
    description: opts.description
      || "App-Zielgruppe (App-Deployment) — automatisch erzeugt vom M365 Security Policy Manager.",
    mailEnabled: false,
    mailNickname: displayName.toLowerCase().replace(/[^a-z0-9]/g, "") || ("app" + Date.now()),
    securityEnabled: true,
    groupTypes: []
  });
  // Verzeichnis-Replikation abwarten: eine frisch angelegte Gruppe ist nicht
  // ueberall sofort lesbar/referenzierbar — der naechste Schritt (Member
  // hinzufuegen) griffe sonst oft ins Leere ("Resource does not exist").
  await req(access, "GET", `/groups/${g.id}?$select=id`, null, { retryTransient: true });
  return { id: g.id, displayName, created: true };
}

/** Kindgruppe (z.B. dynamische Geraetegruppe) als Mitglied der Elterngruppe aufnehmen (idempotent). */
async function nestGroupAsMember(a, b, parentGroupId, childGroupId) {
  const access = toAccess(a, b);
  const members = await allPages(access, `/groups/${parentGroupId}/members?$select=id`, { retryTransient: true });
  if (members.some(m => m.id === childGroupId)) return "skipped";
  await req(access, "POST", `/groups/${parentGroupId}/members/$ref`, {
    "@odata.id": `https://graph.microsoft.com/v1.0/directoryObjects/${childGroupId}`
  }, { retryTransient: true });
  return "added";
}

/** Verknuepfung wieder loesen — fuer den Fall, dass eine Gruppe falsch genestet wurde. */
async function unnestGroupMember(a, b, parentGroupId, childGroupId) {
  const access = toAccess(a, b);
  await req(access, "DELETE", `/groups/${parentGroupId}/members/${childGroupId}/$ref`, null, { retryTransient: true });
  return "removed";
}

/**
 * Welche Intune-App haengt auf welcher Gruppe? Das ist der Nachweis, dass die
 * Zuweisung in Patch My PC tatsaechlich angekommen ist. Scheitert der Aufruf
 * (fehlende App-Leseberechtigung), laeuft die Liste ohne diese Spalte weiter —
 * die Gruppenpflege selbst haengt nicht daran.
 */
async function loadAssignmentsByGroup(access) {
  const apps = await allPages(access, "/deviceAppManagement/mobileApps?$expand=assignments");
  const map = new Map();
  for (const app of apps) {
    for (const as of app.assignments || []) {
      const gid = as.target && as.target.groupId;
      if (!gid) continue;
      if (!map.has(gid)) map.set(gid, []);
      map.get(gid).push({
        id: app.id,
        displayName: app.displayName,
        publisher: app.publisher || "",
        intent: as.intent || ""
      });
    }
  }
  return map;
}

/** Alle App-Zielgruppen mit ihren genesteten Geraetegruppen (und, wenn moeglich, den Intune-Apps darauf). */
async function listAppGroups(a, b, opts) {
  const access = toAccess(a, b);
  opts = opts || {};

  const tenantId = opts.tenantId || (access.tenant ? access.tenant.id : null);
  const prefixes = allPrefixes(tenantId);
  const filter = prefixes.map(p => `startswith(displayName,'${odataLit(p)}')`).join(" or ");
  let groups;
  try {
    groups = await allPages(access,
      `/groups?$filter=${encodeURIComponent(filter)}&$select=id,displayName,description&$top=999`,
      { retryTransient: true });
  } catch (e) {
    // Manche Tenants lehnen den zusammengesetzten startswith-Filter ab —
    // dann eben alle Sicherheitsgruppen holen und hier filtern.
    const all = await allPages(access,
      "/groups?$filter=securityEnabled eq true&$select=id,displayName,description&$top=999",
      { retryTransient: true });
    groups = all.filter(g => isAppGroupName(g.displayName, tenantId));
  }

  let assignments = new Map();
  let assignmentsOk = true;
  if (opts.withAssignments !== false) {
    try {
      assignments = await loadAssignmentsByGroup(access);
    } catch (e) {
      assignmentsOk = false;
    }
  }

  const out = [];
  for (const g of groups) {
    let members = [];
    try {
      members = await allPages(access, `/groups/${g.id}/members?$select=id,displayName`, { retryTransient: true });
    } catch (e) { /* eine unlesbare Gruppe darf die Liste nicht kippen */ }
    out.push({
      id: g.id,
      displayName: g.displayName,
      description: g.description || "",
      scheme: /^T2-DG-/i.test(g.displayName) ? "v2" : "legacy",
      // "Pmp" erkennt man am Muster, nicht am Profil — beide Schemata kennen es.
      managed: /(^AAD-PMP-|^T2-DG-WIN-Pmp)/i.test(g.displayName) ? "pmp" : "app",
      memberGroups: members
        .filter(m => String(m["@odata.type"] || "").toLowerCase().includes("group"))
        .map(m => ({ id: m.id, displayName: m.displayName })),
      otherMemberCount: members.filter(m => !String(m["@odata.type"] || "").toLowerCase().includes("group")).length,
      apps: assignments.get(g.id) || []
    });
  }
  out.sort((x, y) => x.displayName.localeCompare(y.displayName));
  return { groups: out, assignmentsOk };
}

module.exports = {
  ensureAppGroup, nestGroupAsMember, unnestGroupMember, listAppGroups,
  sanitizeAppNameForGroup, buildAppGroupName, isAppGroupName, allPrefixes
};
