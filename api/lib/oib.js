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
const NAMING = require("./naming");

// Plattformen der Baseline. macOS kennt keine Endpoint-Security-Intents, dort
// kommt alles ueber den Settings Catalog und die Compliance-Richtlinien.
const PLATFORMS = {
  windows: { key: "windows", prefix: "Win - OIB", label: "Windows", intents: true },
  macos: { key: "macos", prefix: "MacOS - OIB", label: "macOS", intents: false }
};
function platformDef(key) { return PLATFORMS[key] || PLATFORMS.windows; }

// Alt-Export, Windows-Praefix -- von aussen weiter unter dem alten Namen lesbar.
const POLICY_PREFIX = PLATFORMS.windows.prefix;

// Macs haben keinen Autopilot-GroupTag; sie kommen ueber Apple Business Manager
// bzw. ADE. Die Zielgruppe bildet sich deshalb ueber das Betriebssystem.
// Microsoft fuehrt deviceOSType als "Any string value" und dokumentiert fuer
// macOS keinen Wert -- in der Praxis stehen je nach Aufnahmeweg "MacMDM" oder
// "macOS" drin. Die Regel nimmt beide; String-Vergleiche sind laut Doku nicht
// case-sensitiv, "macOS" deckt damit auch "MacOS" ab. managementType bleibt
// bewusst draussen: Ist es bei einem Mac nicht gesetzt, bliebe die Gruppe leer,
// und ein unverwalteter Mac in der Gruppe schadet den Intune-Richtlinien nicht.
const MAC_GROUP_TAG = "MAC-Std";
const MAC_GROUP_RULE = '(device.deviceOSType -eq "MacMDM") -or (device.deviceOSType -eq "macOS")';
function isMacRule(rule) {
  return /deviceOSType\s+-eq\s+"(MacMDM|macOS)"/i.test(String(rule || ""));
}

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

function nameType(name, platform) {
  const n = String(name || "");
  if (platform === "macos") {
    // "MacOS - OIB - <Bereich> - D|U - ..." -- ohne Typkuerzel wie bei Windows,
    // der Bereich selbst ist die sinnvolle Gruppierung.
    if (/- OIB - Compliance - /.test(n)) return "Compliance";
    const m = n.match(/^MacOS - OIB - (.+?) - [DU] - /);
    return m ? m[1] : "Sonstige";
  }
  const hit = NAME_TYPES.find(t => t.re.test(n));
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

/** Dynamische Security Groups + OIB-Policies einer Plattform inkl. Assignments laden. */
async function loadOibOverview(tenant, certPemPath, platformKey) {
  const beta = { beta: true };
  const plat = platformDef(platformKey);

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
  if (plat.intents) {
    try {
      intents = await graphAllPages(tenant, certPemPath,
        "/deviceManagement/intents?$select=id,displayName&$top=100", beta);
    } catch (e) {
      intentsError = e.message;
    }
  }

  // Compliance-Richtlinien -- wurden bisher nie geladen, damit war
  // "Win - OIB - Compliance - ..." im Tab nicht zuweisbar, obwohl die
  // Typ-Erkennung dafuer existierte. Fehlertolerant wie die Intents.
  let compliance = [], complianceError = null;
  try {
    compliance = await graphAllPages(tenant, certPemPath,
      "/deviceManagement/deviceCompliancePolicies?$expand=assignments&$select=id,displayName&$top=100", { ...beta, retryTransient: 4 });
  } catch (e) {
    complianceError = e.message;
  }

  const oibConfig = configPolicies.filter(p => String(p.name || "").startsWith(plat.prefix));
  const oibIntents = intents.filter(p => String(p.displayName || "").startsWith(plat.prefix));
  const oibCompliance = compliance.filter(p => String(p.displayName || "").startsWith(plat.prefix));

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
  oibCompliance.forEach(p => collectIds(p.assignments));
  for (const gid of unknownIds) {
    try {
      const g = await graphReq(tenant, certPemPath, "GET", `/groups/${gid}?$select=displayName`);
      groupNames.set(gid, g.displayName);
    } catch (e) { groupNames.set(gid, gid + " (nicht auflösbar)"); }
  }

  const toPolicy = (id, name, apiType, assignments) => ({
    id, name, apiType,
    type: nameType(name, plat.key),
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
    ...oibIntents.map(p => toPolicy(p.id, p.displayName, "intents", intentAssignments.get(p.id))),
    ...oibCompliance.map(p => toPolicy(p.id, p.displayName, "deviceCompliancePolicies", p.assignments))
  ].sort((a, b) => a.name.localeCompare(b.name));

  // Zuweisungsfilter des Tenants dazu — fehlertolerant: ohne sie bleibt die
  // normale Zuweisung nutzbar, es fehlt nur die Filter-Spalte.
  let filters = [], filtersError = null;
  try {
    filters = await FILTERS.list(tenant, certPemPath);
  } catch (e) {
    filtersError = e.message;
  }

  const mappedGroups = groups
    .map(g => ({
      id: g.id, displayName: g.displayName, membershipRule: g.membershipRule || "",
      state: g.membershipRuleProcessingState || "",
      macGroup: isMacRule(g.membershipRule)
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  // Bei macOS die passenden Gruppen nach vorn -- sonst ist die Vorauswahl im
  // Dropdown zufaellig die alphabetisch erste Windows-Gruppe.
  if (plat.key === "macos") mappedGroups.sort((a, b) => Number(b.macGroup) - Number(a.macGroup));

  return {
    platform: plat.key,
    groups: mappedGroups,
    macGroupRule: MAC_GROUP_RULE,
    hasMacGroup: mappedGroups.some(g => g.macGroup),
    complianceError,
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

// Zuweisung ist fuer alle drei Quellen dasselbe Schema (target + Assignment-
// Filter), nur der Pfad unterscheidet sich.
const ASSIGN_BASES = {
  configurationPolicies: "/deviceManagement/configurationPolicies",
  intents: "/deviceManagement/intents",
  deviceCompliancePolicies: "/deviceManagement/deviceCompliancePolicies"
};

/**
 * Mac-Zielgruppe anlegen -- idempotent. Existiert schon eine dynamische
 * Sicherheitsgruppe mit passender Regel, wird sie zurueckgegeben statt einer
 * zweiten. Der Name folgt der Namenskonvention des Tenants wie bei den
 * GroupTag-Gruppen (legacy: AAD-MAC-Std, v2: T2-DG-MAC-Std).
 */
async function ensureMacGroup(tenant, certPemPath, namingTenantId) {
  const beta = { beta: true };
  const groups = await graphAllPages(tenant, certPemPath,
    "/groups?$filter=groupTypes/any(c:c+eq+'DynamicMembership') and securityEnabled eq true&$select=id,displayName,membershipRule&$top=100", beta);
  const hit = groups.find(g => isMacRule(g.membershipRule));
  if (hit) return { created: false, group: { id: hit.id, displayName: hit.displayName, membershipRule: hit.membershipRule } };

  const name = NAMING.name("deviceGroup", { tag: MAC_GROUP_TAG }, namingTenantId);
  const created = await graphReq(tenant, certPemPath, "POST", "/groups", {
    displayName: name,
    description: "Verwaltete Macs (dynamisch ueber das Betriebssystem, automatisch angelegt)",
    mailEnabled: false,
    mailNickname: name.replace(/[^A-Za-z0-9]/g, "").slice(0, 60) || ("aadmac" + Date.now()),
    securityEnabled: true,
    groupTypes: ["DynamicMembership"],
    membershipRule: MAC_GROUP_RULE,
    membershipRuleProcessingState: "On"
  });
  return { created: true, group: { id: created.id, displayName: created.displayName, membershipRule: created.membershipRule } };
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
  const base = ASSIGN_BASES[policy.apiType] || ASSIGN_BASES.configurationPolicies;

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

module.exports = {
  loadOibOverview, assignPolicyToGroup, ensureMacGroup,
  POLICY_PREFIX, PLATFORMS, MAC_GROUP_RULE, nameType, isMacRule
};
