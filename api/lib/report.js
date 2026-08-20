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
  return { metrics, data: r };
}

async function sectionConditionalAccess(tenant, cert) {
  const all = await CONDACCESS.listAllPolicies(tenant, cert);
  const enabled = all.filter(p => p.state === "enabled").length;
  const reportOnly = all.filter(p => p.state === "enabledForReportingButNotEnforced").length;
  const disabled = all.filter(p => p.state === "disabled").length;
  return {
    metrics: [
      metric("Policies gesamt", all.length, all.length === 0 ? "crit" : "ok",
        all.length === 0 ? "Kein Conditional Access aktiv" : null),
      metric("Aktiv", enabled, enabled === 0 ? "crit" : "ok"),
      metric("Report-only", reportOnly, reportOnly > 0 ? "warn" : "ok",
        reportOnly > 0 ? "Im Pilotmodus — greift noch nicht" : null),
      metric("Deaktiviert", disabled, disabled > 0 ? "warn" : "ok")
    ],
    data: all.map(p => ({ name: p.displayName, state: p.state, managed: p.managed }))
  };
}

async function sectionIdentity(tenant, cert) {
  const users = await graphAllPages(tenant, cert,
    "/users?$select=id,displayName,userPrincipalName,accountEnabled,userType&$top=999", { retryTransient: true });
  const guests = users.filter(u => u.userType === "Guest");
  const disabled = users.filter(u => u.accountEnabled === false);

  // Privilegierte Rollen: nur die aktivierten Verzeichnisrollen, das reicht
  // fuer die Aussage "wie viele Konten haben erhoehte Rechte".
  let adminCount = null, globalAdmins = null;
  try {
    const roles = await graphAllPages(tenant, cert, "/directoryRoles", { retryTransient: true });
    const seen = new Set();
    let ga = 0;
    for (const role of roles) {
      const members = await graphAllPages(tenant, cert,
        `/directoryRoles/${encodeURIComponent(role.id)}/members?$select=id`, { retryTransient: true });
      for (const m of members) seen.add(m.id);
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
  return { metrics, data: { guests: guests.map(g => g.userPrincipalName), globalAdmins } };
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

  return {
    metrics: [
      metric("Verwaltete Geräte", devices.length),
      metric("Konform", compliant, devices.length && compliant === 0 ? "crit" : "ok"),
      metric("Nicht konform", nonCompliant, nonCompliant > 0 ? "crit" : "ok"),
      metric("Seit 30 Tagen kein Sync", stale, stale > 0 ? "warn" : "ok")
    ],
    data: { byOs }
  };
}

async function sectionIntuneBaseline(tenant, cert) {
  const overview = await OIB.loadOibOverview(tenant, cert);
  const policies = Array.isArray(overview.policies) ? overview.policies : [];
  const assigned = policies.filter(p => p.assigned || (p.assignments && p.assignments.length)).length;
  return {
    metrics: [
      metric("OIB-Policies vorhanden", policies.length, policies.length === 0 ? "warn" : "ok"),
      metric("Davon zugewiesen", assigned, policies.length && assigned === 0 ? "warn" : "ok",
        policies.length && assigned === 0 ? "Angelegt, aber wirkungslos" : null)
    ],
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
      result.sections[id] = { ok: true, label: meta.label, metrics: r.metrics, data: r.data };
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
