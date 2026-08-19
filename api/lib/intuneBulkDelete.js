"use strict";
/**
 * Bulk-Loeschung von Intune-/Entra-Objekten -- Portierung der Logik aus
 * Andrew Taylors bekanntem "IntuneEnvironmentCleaner"-Skript (Out-GridView-
 * Multi-Select -> Delete), aber als API-Route statt PowerShell-Skript, damit
 * die Auswahl im Web-Tool per Checkbox statt Out-GridView passiert.
 *
 * SICHERHEIT: Der Client waehlt Objekte nur ueber {id, type} aus einer festen
 * Typen-Liste (RESOURCE_TYPES unten) -- er kann NIE einen beliebigen Graph-Pfad
 * zum Loeschen erzwingen, die tatsaechliche URL wird ausschliesslich hier
 * server-seitig aus dem bekannten "type" zusammengesetzt.
 *
 * "AAD Group" ist bewusst als eigene, gesondert markierte Kategorie drin --
 * eine geloeschte Gruppe kann Lizenzen/Berechtigungen/Policy-Scopes fuer viele
 * Nutzer gleichzeitig kappen, das Risiko ist kategorisch groesser als bei einer
 * einzelnen Config-Policy.
 */
const { graphReq, graphAllPages } = require("./graph");

const RESOURCE_TYPES = [
  { type: "Config Policy", listPath: "/deviceManagement/deviceConfigurations", beta: true, nameField: "displayName" },
  { type: "Admin Template", listPath: "/deviceManagement/groupPolicyConfigurations", beta: true, nameField: "displayName" },
  // configurationPolicies liefert bei groesseren Bestaenden auf Folgeseiten
  // (skiptoken) gelegentlich generische 500er -- gleiches Muster wie in
  // oib.js's loadOibOverview: retryTransient + kleinere Seiten.
  { type: "Settings Catalog", listPath: "/deviceManagement/configurationPolicies?$select=id,name,description&$top=50", beta: true, nameField: "name", opts: { retryTransient: 8 } },
  { type: "Compliance Policy", listPath: "/deviceManagement/deviceCompliancePolicies", beta: true, nameField: "displayName" },
  { type: "Proactive Remediation", listPath: "/deviceManagement/deviceHealthScripts", beta: true, nameField: "displayName" },
  { type: "PowerShell Script", listPath: "/deviceManagement/deviceManagementScripts", beta: true, nameField: "displayName" },
  { type: "Security Policy", listPath: "/deviceManagement/intents", beta: true, nameField: "displayName" },
  { type: "Autopilot Profile", listPath: "/deviceManagement/windowsAutopilotDeploymentProfiles", beta: true, nameField: "displayName" },
  { type: "Autopilot ESP", listPath: "/deviceManagement/deviceEnrollmentConfigurations", beta: true, nameField: "displayName" },
  { type: "Mobile App", listPath: "/deviceAppManagement/mobileApps", beta: true, nameField: "displayName" },
  { type: "Android App Protection", listPath: "/deviceAppManagement/androidManagedAppProtections", beta: true, nameField: "displayName" },
  { type: "iOS App Protection", listPath: "/deviceAppManagement/iOSManagedAppProtections", beta: true, nameField: "displayName" },
  { type: "Conditional Access Policy", listPath: "/identity/conditionalAccess/policies", beta: false, nameField: "displayName" },
  // onPremisesSyncEnabled ist eine "non-indexed"-Eigenschaft -- der Filter
  // braucht zwingend ConsistencyLevel:eventual + $count=true (Graph Advanced
  // Query), sonst 400. Gleiches Muster wie entraUsers.js's searchUsers.
  { type: "AAD Group", listPath: "/groups?$filter=onPremisesSyncEnabled ne true&$count=true", beta: false, nameField: "displayName", riskier: true, opts: { headers: { ConsistencyLevel: "eventual" }, retryTransient: true } }
];

function basePathFor(type) {
  const def = RESOURCE_TYPES.find(r => r.type === type);
  if (!def) throw Object.assign(new Error("Unbekannter Objekt-Typ: " + type), { status: 400 });
  // Query-Parameter (z.B. beim Gruppen-Filter) gehoeren nicht in den Delete-Pfad.
  return { path: def.listPath.split("?")[0], beta: def.beta };
}

/** Alle loeschbaren Objekttypen parallel einsammeln -- ein kaputter Typ blockiert die anderen nicht. */
async function listDeletableObjects(tenant, cert) {
  const results = await Promise.allSettled(
    RESOURCE_TYPES.map(async def => {
      const items = await graphAllPages(tenant, cert, def.listPath, { beta: def.beta, ...(def.opts || {}) });
      return items.map(it => ({
        id: it.id,
        name: it[def.nameField] || it.displayName || it.name || "(ohne Namen)",
        description: it.description || null,
        type: def.type,
        riskier: !!def.riskier
      }));
    })
  );
  const objects = [];
  const errors = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") objects.push(...r.value);
    else errors.push({ type: RESOURCE_TYPES[i].type, error: r.reason.message });
  });
  return { objects, errors };
}

/** Ein einzelnes Objekt loeschen -- Loeschen der zugrundeliegenden Ressource entfernt Zuweisungen automatisch (Graph-Standardverhalten). */
async function deleteObject(tenant, cert, id, type) {
  const { path, beta } = basePathFor(type);
  await graphReq(tenant, cert, "DELETE", `${path}/${encodeURIComponent(id)}`, null, { beta });
}

module.exports = { RESOURCE_TYPES, listDeletableObjects, deleteObject };
