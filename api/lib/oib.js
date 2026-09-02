/**
 * OIB-Policy-Zuweisung (OpenIntuneBaseline): listet Win-OIB-Policies und
 * dynamische Security Groups eines Tenants und weist Policies Gruppen zu.
 *
 * Logik nach Nils' Assign-OIBPoliciesToGroup.ps1:
 *  - Zwei API-Quellen (beta): deviceManagement/configurationPolicies (Settings
 *    Catalog) und deviceManagement/intents (Endpoint Security), gefiltert auf
 *    den Namens-Praefix "Win - OIB".
 *  - Ziel sind ausschliesslich dynamische Security Groups (GroupTag-Konzept).
 *  - Bestehende Assignments werden angezeigt; ist die Zielgruppe schon
 *    zugewiesen, wird die Policy uebersprungen.
 *
 * Bewusste Abweichung vom Original-Skript: POST /assign ERSETZT die komplette
 * Assignment-Liste — das Skript schickte nur die neue Gruppe und haette damit
 * bestehende Assignments entfernt. Hier werden bestehende Targets gemerged.
 */
const { graphReq, graphAllPages } = require("./graph");
const FILTERS = require("./assignmentFilters");

const POLICY_PREFIX = "Win - OIB";

// Typ aus dem OIB-Namen: "Win - OIB - <TYP> - ..." (Reihenfolge wichtig,
// spezifische zuerst) — gleiche Typologie wie im M365-Dashboard.
const NAME_TYPES = [
  { key: "ES", label: "Endpoint Security", re: /- OIB - ES - / },
  { key: "SC", label: "Settings Catalog", re: /- OIB - SC - / },
  { key: "Compliance", label: "Compliance", re: /- OIB - Compliance - / },
  { key: "WUfBDrivers", label: "Driver Updates (WUfB)", re: /- OIB - WUfB Drivers - / },
  { key: "WUfB", label: "Update Rings (WUfB)", re: /- OIB - WUfB - / },
  { key: "TP", label: "Device Config (Templates)", re: /- OIB - TP - / }
];

function nameType(name) {
  const hit = NAME_TYPES.find(t => t.re.test(name));
  return hit ? hit.label : "Sonstige";
}

function describeTarget(t, groupNames) {
  const type = String((t && t["@odata.type"]) || "");
  if (/allDevices/i.test(type)) return "Alle Geräte";
  if (/allLicensedUsers|allUsers/i.test(type)) return "Alle Benutzer";
  if (/exclusion/i.test(type)) return "Ausschluss: " + (groupNames.get(t.groupId) || t.groupId);
  if (t && t.groupId) return groupNames.get(t.groupId) || t.groupId;
  return type.replace("#microsoft.graph.", "") || "unbekannt";
}

/** Dynamische Security Groups + Win-OIB-Policies inkl. Assignments laden. */
async function loadOibOverview(tenant, certPemPath) {
  const beta = { beta: true };

  // configurationPolicies mit $expand=assignments: die Folgeseiten (skiptoken)
  // liefern bei grossen Bestaenden gelegentlich generische 500er (real
  // aufgetreten bei ~100+ CIS-Policies) — retryTransient + kleinere Seiten.
  const [groups, configPolicies] = await Promise.all([
    graphAllPages(tenant, certPemPath,
      "/groups?$filter=groupTypes/any(c:c+eq+'DynamicMembership') and securityEnabled eq true&$select=id,displayName,membershipRule,membershipRuleProcessingState&$top=100", beta),
    graphAllPages(tenant, certPemPath,
      "/deviceManagement/configurationPolicies?$expand=assignments&$select=id,name&$top=50", { ...beta, retryTransient: 8 })
  ]);

  // Endpoint-Security-Intents separat und fehlertolerant: der Legacy-Endpoint
  // reagiert bei App-Only-Zugriff gelegentlich zickig — dann bleiben die
  // Settings-Catalog-Policies trotzdem nutzbar.
  let intents = [], intentsError = null;
  try {
    intents = await graphAllPages(tenant, certPemPath,
      "/deviceManagement/intents?$select=id,displayName&$top=100", beta);
  } catch (e) {
    intentsError = e.message;
  }

  const oibConfig = configPolicies.filter(p => String(p.name || "").startsWith(POLICY_PREFIX));
  const oibIntents = intents.filter(p => String(p.displayName || "").startsWith(POLICY_PREFIX));

  // Intent-Assignments einzeln nachladen ($expand wird dort nicht zuverlaessig unterstuetzt)
  const intentAssignments = new Map();
  for (const p of oibIntents) {
    try {
      const r = await graphReq(tenant, certPemPath, "GET", `/deviceManagement/intents/${p.id}/assignments`, null, beta);
      intentAssignments.set(p.id, r.value || []);
    } catch (e) { intentAssignments.set(p.id, []); }
  }

  // Gruppennamen fuer alle referenzierten Assignments aufloesen (dedupliziert)
  const groupNames = new Map(groups.map(g => [g.id, g.displayName]));
  const unknownIds = new Set();
  const collectIds = (assignments) => {
    for (const a of assignments || []) {
      const gid = a && a.target && a.target.groupId;
      if (gid && !groupNames.has(gid)) unknownIds.add(gid);
    }
  };
  oibConfig.forEach(p => collectIds(p.assignments));
  oibIntents.forEach(p => collectIds(intentAssignments.get(p.id)));
  for (const gid of unknownIds) {
    try {
      const g = await graphReq(tenant, certPemPath, "GET", `/groups/${gid}?$select=displayName`);
      groupNames.set(gid, g.displayName);
    } catch (e) { groupNames.set(gid, gid + " (nicht auflösbar)"); }
  }

  const toPolicy = (id, name, apiType, assignments) => ({
    id, name, apiType,
    type: nameType(name),
    // Doppelt gelieferte Build-Varianten kennzeichnen (Kap. 9.3): Die Sicht
    // braucht das, um beim Zuweisen den 24H2-Filter richtig herum anzubieten.
    variant: FILTERS.is24H2Variant(name) ? "24h2" : "legacy",
    assignments: (assignments || []).map(a => ({
      groupId: (a.target && a.target.groupId) || null,
      label: describeTarget(a.target, groupNames),
      filterId: (a.target && a.target.deviceAndAppManagementAssignmentFilterId) || null,
      filterType: (a.target && a.target.deviceAndAppManagementAssignmentFilterType) || "none"
    }))
  });

  const policies = [
    ...oibConfig.map(p => toPolicy(p.id, p.name, "configurationPolicies", p.assignments)),
    ...oibIntents.map(p => toPolicy(p.id, p.displayName, "intents", intentAssignments.get(p.id)))
  ].sort((a, b) => a.name.localeCompare(b.name));

  // Zuweisungsfilter des Tenants dazu — fehlertolerant: ohne sie bleibt die
  // normale Zuweisung nutzbar, es fehlt nur die Filter-Spalte.
  let filters = [], filtersError = null;
  try {
    filters = await FILTERS.list(tenant, certPemPath);
  } catch (e) {
    filtersError = e.message;
  }

  return {
    groups: groups
      .map(g => ({ id: g.id, displayName: g.displayName, membershipRule: g.membershipRule || "", state: g.membershipRuleProcessingState || "" }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    policies,
    filters,
    filtersError,
    // Paare aus 24H2- und Alt-Variante: genau die Faelle, fuer die der Filter
    // gedacht ist. Ist die Liste leer, braucht dieser Tenant ihn gar nicht.
    variantPairs: FILTERS.findVariantPairs(policies).map(pair => ({
      key: pair.key,
      neu: pair.neu.map(p => ({ id: p.id, name: p.name, apiType: p.apiType })),
      alt: pair.alt.map(p => ({ id: p.id, name: p.name, apiType: p.apiType }))
    })),
    intentsError
  };
}

/**
 * Eine Policy der Zielgruppe zuweisen — bestehende Assignments bleiben erhalten
 * (Merge). Rueckgabe: 'assigned' | 'skipped' | 'updated'.
 *
 * `filter` ist optional: { id, type: 'include' | 'exclude' }. Damit bekommt
 * dieselbe Gerätegruppe die 24H2-Variante einer Richtlinie mit Einschluss und
 * die Alt-Variante mit Ausschluss (Kap. 9.3 der Wissensbasis) — statt zweier
 * Gruppen, die man beim Build-Wechsel pflegen muesste.
 *
 * 'updated' heisst: Die Gruppe war schon zugewiesen, aber mit einem anderen
 * Filter. Das stumpfe 'skipped' von frueher haette hier genau die Aenderung
 * verschluckt, um die es geht.
 */
async function assignPolicyToGroup(tenant, certPemPath, policy, groupId, filter) {
  const beta = { beta: true };
  const base = policy.apiType === "intents" ? "/deviceManagement/intents" : "/deviceManagement/configurationPolicies";

  const wantFilterId = filter && filter.id ? filter.id : null;
  const wantFilterType = wantFilterId ? (filter.type === "exclude" ? "exclude" : "include") : "none";

  const current = await graphReq(tenant, certPemPath, "GET", `${base}/${policy.id}/assignments`, null, beta);
  const existing = current.value || [];
  const mine = existing.find(a => a.target && a.target.groupId === groupId);

  if (mine) {
    const istFilterId = mine.target.deviceAndAppManagementAssignmentFilterId || null;
    const istFilterType = mine.target.deviceAndAppManagementAssignmentFilterType || "none";
    if (istFilterId === wantFilterId && istFilterType === wantFilterType) return "skipped";
  }

  // Bestehende Targets 1:1 uebernehmen (inkl. ihrer Assignment-Filter), das
  // eigene Target ersetzen oder ergaenzen.
  const target = { "@odata.type": "#microsoft.graph.groupAssignmentTarget", groupId };
  if (wantFilterId) {
    target.deviceAndAppManagementAssignmentFilterId = wantFilterId;
    target.deviceAndAppManagementAssignmentFilterType = wantFilterType;
  }
  const assignments = existing
    .filter(a => !(a.target && a.target.groupId === groupId))
    .map(a => ({ target: a.target }));
  assignments.push({ target });

  await graphReq(tenant, certPemPath, "POST", `${base}/${policy.id}/assign`, { assignments }, beta);
  return mine ? "updated" : "assigned";
}

module.exports = { loadOibOverview, assignPolicyToGroup, POLICY_PREFIX, nameType };
