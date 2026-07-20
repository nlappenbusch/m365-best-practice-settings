/**
 * Assignment-Check (Idee: IntuneAssignmentChecker, als app-only-Neuimplementierung):
 * liest ALLE Intune-Policies + Apps eines Tenants inkl. Zuweisungen (read-only)
 * und findet die drei klassischen Zuweisungs-Probleme:
 *   - unassigned:  Policy/App ohne jede Zuweisung (totes Gewicht, wirkt nie)
 *   - emptyGroup:  Zuweisung auf eine Gruppe mit 0 Mitgliedern (sieht zugewiesen
 *                  aus, tut aber nichts)
 *   - broadAll:    Zuweisung auf "Alle Benutzer"/"Alle Geraete" (grosser
 *                  Wirkungsradius — bewusst pruefen, kein Fehler per se)
 * Alles beta (Intune lebt primaer in beta), nur GET-Aufrufe.
 */
const { graphReq, graphAllPages } = require("./graph");

const BETA = { beta: true, retryTransient: 8 };

function classifyTarget(target) {
  const t = String((target && target["@odata.type"]) || "");
  if (/allLicensedUsers/i.test(t)) return { kind: "allUsers", exclude: false };
  if (/allDevices/i.test(t)) return { kind: "allDevices", exclude: false };
  if (/exclusionGroup/i.test(t)) return { kind: "group", exclude: true };
  if (/groupAssignmentTarget/i.test(t)) return { kind: "group", exclude: false };
  return { kind: "other", exclude: false };
}

/** Policy-Quellen: [pfad, typLabel, namensfeld, assignmentsInline] */
const POLICY_SOURCES = [
  // $top=50: Folgeseiten mit $expand=assignments werfen bei grossen Bestaenden
  // gelegentlich generische 500er (siehe oib.js) — BETA enthaelt retryTransient.
  ["/deviceManagement/configurationPolicies?$expand=assignments&$select=id,name&$top=50", "Settings Catalog", p => p.name, true],
  ["/deviceManagement/deviceCompliancePolicies?$expand=assignments", "Compliance", p => p.displayName, true],
  ["/deviceManagement/deviceConfigurations?$expand=assignments", "Device Configuration", p => p.displayName, true],
  ["/deviceManagement/groupPolicyConfigurations?$expand=assignments", "Admin Template", p => p.displayName, true],
  ["/deviceManagement/windowsFeatureUpdateProfiles?$expand=assignments", "Feature Update", p => p.displayName, true],
  ["/deviceManagement/windowsQualityUpdateProfiles?$expand=assignments", "Quality Update", p => p.displayName, true],
  ["/deviceManagement/windowsDriverUpdateProfiles?$expand=assignments", "Driver Update", p => p.displayName, true]
];

async function runAssignmentCheck(tenant, cert) {
  const items = []; // { name, type, assignments: [...] }

  for (const [path, typeLabel, pickName] of POLICY_SOURCES) {
    let list = [];
    try { list = await graphAllPages(tenant, cert, path, BETA); }
    catch (e) { continue; } // Endpoint im Tenant nicht verfuegbar -> auslassen
    for (const p of list) {
      items.push({ name: pickName(p) || p.id, type: typeLabel, raw: p.assignments || [] });
    }
  }

  // Endpoint-Security-Intents: assignments nur per Einzelabruf
  try {
    const intents = await graphAllPages(tenant, cert, "/deviceManagement/intents?$select=id,displayName&$top=100", BETA);
    for (const it of intents) {
      let asg = [];
      try { asg = (await graphReq(tenant, cert, "GET", `/deviceManagement/intents/${it.id}/assignments`, null, BETA)).value || []; }
      catch (e) { /* dann eben ohne */ }
      items.push({ name: it.displayName || it.id, type: "Endpoint Security", raw: asg });
    }
  } catch (e) { /* intents nicht verfuegbar */ }

  // Apps: nur die, die Intune wirklich verwaltet (zuweisbare) — Built-ins ausblenden
  try {
    const apps = await graphAllPages(tenant, cert,
      "/deviceAppManagement/mobileApps?$expand=assignments&$select=id,displayName&$top=100", BETA);
    for (const a of apps) {
      const t = String(a["@odata.type"] || "");
      if (/builtIn|microsoftStoreForBusiness/i.test(t)) continue;
      items.push({ name: a.displayName || a.id, type: "App", raw: a.assignments || [] });
    }
  } catch (e) { /* Apps optional */ }

  // Referenzierte Gruppen einsammeln und Name + Mitgliederzahl aufloesen
  const groupIds = new Set();
  for (const it of items) for (const a of it.raw) {
    const gid = a && a.target && a.target.groupId;
    if (gid) groupIds.add(gid);
  }
  const groups = new Map(); // id -> { name, memberCount }
  for (const gid of groupIds) {
    try {
      const g = await graphReq(tenant, cert, "GET", `/groups/${gid}?$select=id,displayName`, null, BETA);
      let memberCount = null;
      try {
        memberCount = (await graphAllPages(tenant, cert, `/groups/${gid}/members?$select=id&$top=100`, BETA)).length;
      } catch (e) { /* Zaehlung optional */ }
      groups.set(gid, { name: g.displayName || gid, memberCount });
    } catch (e) {
      // Gruppe geloescht, Assignment zeigt ins Leere — eigenes Problem wert
      groups.set(gid, { name: gid, memberCount: null, missing: true });
    }
  }

  // Findings bauen
  const results = items.map(it => {
    const assignments = it.raw.map(a => {
      const cls = classifyTarget(a.target || {});
      const gid = a.target && a.target.groupId;
      const g = gid ? groups.get(gid) : null;
      return {
        kind: cls.kind, exclude: cls.exclude,
        label: cls.kind === "allUsers" ? "Alle Benutzer"
          : cls.kind === "allDevices" ? "Alle Geräte"
          : g ? g.name : (gid || cls.kind),
        memberCount: g ? g.memberCount : null,
        missingGroup: !!(g && g.missing)
      };
    });
    const issues = [];
    if (!assignments.length) issues.push("unassigned");
    if (assignments.some(a => a.kind === "group" && !a.exclude && a.memberCount === 0)) issues.push("emptyGroup");
    if (assignments.some(a => a.missingGroup)) issues.push("missingGroup");
    if (assignments.some(a => (a.kind === "allUsers" || a.kind === "allDevices") && !a.exclude)) issues.push("broadAll");
    return { name: it.name, type: it.type, assignments, issues };
  });

  results.sort((a, b) => (b.issues.length - a.issues.length) || a.type.localeCompare(b.type) || a.name.localeCompare(b.name));

  const summary = {
    total: results.length,
    unassigned: results.filter(r => r.issues.includes("unassigned")).length,
    emptyGroup: results.filter(r => r.issues.includes("emptyGroup")).length,
    missingGroup: results.filter(r => r.issues.includes("missingGroup")).length,
    broadAll: results.filter(r => r.issues.includes("broadAll")).length
  };
  return { summary, results };
}

module.exports = { runAssignmentCheck, classifyTarget };
