/**
 * Kundenreport: fasst zusammen, was in den einzelnen Bereichen ohnehin schon
 * abgefragt wird, und macht daraus eine Momentaufnahme pro Tenant.
 *
 * Bewusst nur LESENDE Graph-Abfragen -- ein Report darf nichts veraendern.
 *
 * Jeder Baustein laeuft einzeln und faengt seine Fehler selbst ab: fehlt einem
 * Tenant z.B. Entra P1 (dann keine signInActivity) oder eine Berechtigung, soll
 * der Rest des Reports trotzdem entstehen. Fehlgeschlagene Bausteine stehen als
 * solche drin -- eine Luecke im Report muss sichtbar sein, nicht stillschweigend
 * als "alles gut" durchgehen.
 */
const LICENSES = require("./licenses");
const CONDACCESS = require("./conditionalAccess");
const OIB = require("./oib");
const { graphAllPages } = require("./graph");

const SECTIONS = [
  { id: "licenses", label: "Lizenzen", desc: "Bestand, freie Seats, Lizenzen an deaktivierten und inaktiven Konten" },
  { id: "conditionalAccess", label: "Conditional Access", desc: "Policies, Zustand (aktiv / Report-only / aus)" },
  { id: "identity", label: "Identitäten", desc: "Konten, Gäste, privilegierte Rollen" },
  { id: "devices", label: "Geräte", desc: "Intune-verwaltete Geräte, Compliance, Betriebssystem" },
  { id: "intuneBaseline", label: "Intune-Baseline", desc: "Zuweisungsstand der OIB-Policies" }
];

/** Ampel: ok | warn | crit — eine Kennzahl mit Bewertung fuer das Dashboard. */
function metric(label, value, state, detail) {
  return { label, value, state: state || "ok", detail: detail || null };
}

// Detail-Liste zu einer Sektion: generisch (Spalten + Zeilen), damit Tab,
// Kunden-HTML und Kunden-PDF sie mit EINEM Renderer anzeigen koennen.
// Immer gekappt — der Report soll Befund zeigen, nicht Datenexport sein.
const LIST_CAP = 50;
function list(id, label, columns, rows, state) {
  const capped = rows.slice(0, LIST_CAP);
  return {
    id, label, columns,
    rows: capped.map(r => r.map(c => (c === null || c === undefined) ? "—" : String(c))),
    more: Math.max(0, rows.length - capped.length),
    state: state || null
  };
}

async function sectionLicenses(tenant, cert) {
  const r = await LICENSES.runLicenseReport(tenant, cert);
  const t = r.totals || {};
  const metrics = [
    metric("Benutzer", t.users),
    metric("Lizenziert", t.licensedUsers),
    metric("Freie bezahlte Seats", t.freeSeats, t.freeSeats > 5 ? "warn" : "ok",
      t.freeSeats > 5 ? "Bezahlt, aber niemandem zugewiesen" : null),
    metric("Lizenz an deaktiviertem Konto", t.disabledWithLicense, t.disabledWithLicense > 0 ? "warn" : "ok")
  ];
  if (t.inactiveWithLicense !== null && t.inactiveWithLicense !== undefined) {
    metrics.push(metric(`Inaktiv >${r.inactiveDays} Tage`, t.inactiveWithLicense,
      t.inactiveWithLicense > 0 ? "warn" : "ok"));
  }

  const f = r.findings || {};
  const lists = [];
  const unused = f.unusedPaidSeats || [];
  if (unused.length) lists.push(list("freeSeats", "Freie bezahlte Seats", ["Lizenz", "Zugewiesen", "Gekauft", "Frei"],
    unused.map(s => [s.name, s.assigned, s.purchased, s.available]), "warn"));
  if ((f.disabledWithLicense || []).length) lists.push(list("disabledLic", "Lizenzen an deaktivierten Konten", ["Konto", "UPN", "Lizenzen"],
    f.disabledWithLicense.map(u => [u.displayName, u.upn, (u.licenses || []).join(", ")]), "warn"));
  if ((f.inactiveWithLicense || []).length) lists.push(list("inactiveLic", `Inaktive lizenzierte Konten (>${r.inactiveDays} Tage)`, ["Konto", "UPN", "Letzte Anmeldung", "Lizenzen"],
    f.inactiveWithLicense.map(u => [u.displayName, u.upn, u.lastSignIn || "nie angemeldet", (u.licenses || []).join(", ")]), "warn"));
  const multiRelevant = (f.multiSuite || []).filter(m => m.verdict !== "addon");
  if (multiRelevant.length) lists.push(list("multiSuite", "Mehrfach-Lizenzierung (prüfenswert)", ["Konto", "Lizenzen", "Einordnung"],
    multiRelevant.map(m => [`${m.displayName} (${m.upn})`, (m.licenses || []).join(", "), m.reason || m.verdict]), "warn"));

  return { metrics, lists, data: r };
}

async function sectionConditionalAccess(tenant, cert) {
  const all = await CONDACCESS.listAllPolicies(tenant, cert);
  const enabled = all.filter(p => p.state === "enabled").length;
  const reportOnly = all.filter(p => p.state === "enabledForReportingButNotEnforced").length;
  const disabled = all.filter(p => p.state === "disabled").length;
  const stateDe = (st) => st === "enabled" ? "Aktiv" : st === "enabledForReportingButNotEnforced" ? "Report-only" : st === "disabled" ? "Deaktiviert" : st;
  // Nicht-aktive zuerst — das ist das, was man in der Liste sucht.
  const sorted = [...all].sort((a, b) => (a.state === "enabled" ? 1 : 0) - (b.state === "enabled" ? 1 : 0));
  return {
    metrics: [
      metric("Policies gesamt", all.length, all.length === 0 ? "crit" : "ok",
        all.length === 0 ? "Kein Conditional Access aktiv" : null),
      metric("Aktiv", enabled, enabled === 0 ? "crit" : "ok"),
      metric("Report-only", reportOnly, reportOnly > 0 ? "warn" : "ok",
        reportOnly > 0 ? "Im Pilotmodus — greift noch nicht" : null),
      metric("Deaktiviert", disabled, disabled > 0 ? "warn" : "ok")
    ],
    lists: all.length ? [list("caPolicies", "Alle Conditional-Access-Policies", ["Policy", "Status", "Verwaltet"],
      sorted.map(p => [p.displayName, stateDe(p.state), p.managed ? "igeeks (BP_)" : "kundenseitig"]),
      (reportOnly + disabled) > 0 ? "warn" : null)] : [],
    data: all.map(p => ({ name: p.displayName, state: p.state, managed: p.managed }))
  };
}

async function sectionIdentity(tenant, cert) {
  const users = await graphAllPages(tenant, cert,
    "/users?$select=id,displayName,userPrincipalName,accountEnabled,userType&$top=999", { retryTransient: true });
  const guests = users.filter(u => u.userType === "Guest");
  const disabled = users.filter(u => u.accountEnabled === false);

  // Privilegierte Rollen: nur die aktivierten Verzeichnisrollen — inklusive
  // WER die Rollen hat (fuer die Detail-Liste im Report).
  let adminCount = null, globalAdmins = null;
  const adminRoles = new Map(); // memberId -> { name, roles: [] }
  try {
    const roles = await graphAllPages(tenant, cert, "/directoryRoles", { retryTransient: true });
    const seen = new Set();
    let ga = 0;
    for (const role of roles) {
      const members = await graphAllPages(tenant, cert,
        `/directoryRoles/${encodeURIComponent(role.id)}/members?$select=id,displayName,userPrincipalName`, { retryTransient: true });
      for (const m of members) {
        seen.add(m.id);
        const rec = adminRoles.get(m.id) || { name: m.displayName || m.userPrincipalName || m.id, upn: m.userPrincipalName || "", roles: [] };
        rec.roles.push(role.displayName || "?");
        adminRoles.set(m.id, rec);
      }
      if (/company administrator|global administrator/i.test(String(role.displayName || ""))) ga = members.length;
    }
    adminCount = seen.size;
    globalAdmins = ga;
  } catch (e) { /* Rollen brauchen RoleManagement.Read.Directory — optional */ }

  const metrics = [
    metric("Konten", users.filter(u => u.userType !== "Guest").length),
    metric("Gäste", guests.length, guests.length > 0 ? "warn" : "ok",
      guests.length > 0 ? "Externe Konten im Tenant — regelmässig prüfen" : null),
    metric("Deaktivierte Konten", disabled.length)
  ];
  if (adminCount !== null) {
    metrics.push(metric("Konten mit Adminrolle", adminCount));
    // Microsofts Empfehlung: mehr als 4 Global Admins sind selten begruendbar,
    // weniger als 2 ist ein Ausfallrisiko (kein Break-Glass).
    metrics.push(metric("Globale Administratoren", globalAdmins,
      globalAdmins > 4 ? "warn" : globalAdmins < 2 ? "warn" : "ok",
      globalAdmins > 4 ? "Mehr als 4 — Berechtigungen prüfen"
        : globalAdmins < 2 ? "Weniger als 2 — kein Break-Glass-Konto?" : null));
  }

  const lists = [];
  if (adminRoles.size) lists.push(list("admins", "Konten mit Adminrollen", ["Konto", "UPN", "Rollen"],
    [...adminRoles.values()].sort((a, b) => b.roles.length - a.roles.length)
      .map(a => [a.name, a.upn, a.roles.join(", ")])));
  if (guests.length) lists.push(list("guests", "Gastkonten", ["Konto", "UPN"],
    guests.map(g => [g.displayName || "—", g.userPrincipalName]), "warn"));
  if (disabled.length) lists.push(list("disabledAccounts", "Deaktivierte Konten", ["Konto", "UPN"],
    disabled.map(u => [u.displayName || "—", u.userPrincipalName])));

  return { metrics, lists, data: { guests: guests.map(g => g.userPrincipalName), globalAdmins } };
}

async function sectionDevices(tenant, cert) {
  const devices = await graphAllPages(tenant, cert,
    "/deviceManagement/managedDevices?$select=id,deviceName,operatingSystem,complianceState,lastSyncDateTime,osVersion",
    { retryTransient: true });
  const compliant = devices.filter(d => d.complianceState === "compliant").length;
  const nonCompliant = devices.filter(d => d.complianceState === "noncompliant").length;

  // 30 Tage ohne Sync heisst in der Praxis: eingemottet, verloren oder kaputt.
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  const stale = devices.filter(d => d.lastSyncDateTime && new Date(d.lastSyncDateTime).getTime() < cutoff).length;

  const byOs = {};
  for (const d of devices) {
    const os = d.operatingSystem || "unbekannt";
    byOs[os] = (byOs[os] || 0) + 1;
  }

  const fmtSync = (d) => d.lastSyncDateTime ? String(d.lastSyncDateTime).slice(0, 10) : "nie";
  const nonCompliantList = devices.filter(d => d.complianceState === "noncompliant");
  const staleList = devices.filter(d => d.lastSyncDateTime && new Date(d.lastSyncDateTime).getTime() < cutoff);
  const lists = [];
  if (nonCompliantList.length) lists.push(list("noncompliant", "Nicht konforme Geräte", ["Gerät", "OS", "Letzter Sync"],
    nonCompliantList.map(d => [d.deviceName, `${d.operatingSystem || "?"} ${d.osVersion || ""}`.trim(), fmtSync(d)]), "crit"));
  if (staleList.length) lists.push(list("staleDevices", "Geräte ohne Sync seit 30 Tagen", ["Gerät", "OS", "Letzter Sync"],
    staleList.map(d => [d.deviceName, `${d.operatingSystem || "?"} ${d.osVersion || ""}`.trim(), fmtSync(d)]), "warn"));

  return {
    metrics: [
      metric("Verwaltete Geräte", devices.length),
      metric("Konform", compliant, devices.length && compliant === 0 ? "crit" : "ok"),
      metric("Nicht konform", nonCompliant, nonCompliant > 0 ? "crit" : "ok"),
      metric("Seit 30 Tagen kein Sync", stale, stale > 0 ? "warn" : "ok")
    ],
    lists,
    data: { byOs }
  };
}

async function sectionIntuneBaseline(tenant, cert) {
  const overview = await OIB.loadOibOverview(tenant, cert);
  const policies = Array.isArray(overview.policies) ? overview.policies : [];
  const isAssigned = (p) => p.assigned || (p.assignments && p.assignments.length);
  const assigned = policies.filter(isAssigned).length;
  const unassigned = policies.filter(p => !isAssigned(p));
  return {
    metrics: [
      metric("OIB-Policies vorhanden", policies.length, policies.length === 0 ? "warn" : "ok"),
      metric("Davon zugewiesen", assigned, policies.length && assigned === 0 ? "warn" : "ok",
        policies.length && assigned === 0 ? "Angelegt, aber wirkungslos" : null)
    ],
    lists: unassigned.length ? [list("oibUnassigned", "Vorhandene, aber nicht zugewiesene OIB-Policies", ["Policy"],
      unassigned.map(p => [p.displayName || p.name || "?"]), "warn")] : [],
    data: { total: policies.length, assigned }
  };
}

const RUNNERS = {
  licenses: sectionLicenses,
  conditionalAccess: sectionConditionalAccess,
  identity: sectionIdentity,
  devices: sectionDevices,
  intuneBaseline: sectionIntuneBaseline
};

/**
 * Report erzeugen. sections: Array von Section-Ids (leer = alle).
 * onProgress(label) fuer die Fortschrittsanzeige.
 */
async function runReport(tenant, cert, sections, onProgress) {
  const wanted = (Array.isArray(sections) && sections.length ? sections : SECTIONS.map(s => s.id))
    .filter(id => RUNNERS[id]);

  const result = {
    tenantId: tenant.id,
    tenantName: tenant.name,
    organization: tenant.organization || null,
    generatedAt: new Date().toISOString(),
    sections: {}
  };

  for (const id of wanted) {
    const meta = SECTIONS.find(s => s.id === id);
    if (onProgress) onProgress(meta ? meta.label : id);
    try {
      const r = await RUNNERS[id](tenant, cert);
      result.sections[id] = { ok: true, label: meta.label, metrics: r.metrics, lists: r.lists || [], data: r.data };
    } catch (e) {
      // Bewusst nicht abbrechen: ein fehlender Baustein ist kein Grund, den
      // ganzen Report zu verlieren -- aber er muss als Luecke sichtbar sein.
      result.sections[id] = { ok: false, label: meta ? meta.label : id, error: e.message, metrics: [] };
    }
  }

  const all = Object.values(result.sections).flatMap(s => s.metrics || []);
  result.summary = {
    crit: all.filter(m => m.state === "crit").length,
    warn: all.filter(m => m.state === "warn").length,
    ok: all.filter(m => m.state === "ok").length,
    failedSections: Object.values(result.sections).filter(s => !s.ok).map(s => s.label)
  };
  return result;
}

module.exports = { runReport, SECTIONS };
