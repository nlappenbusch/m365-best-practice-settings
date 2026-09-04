/**
 * IST-Bestandsaufnahme: rein lesende Momentaufnahme fuer einen Tenant, gedacht
 * als erster grober Ueberblick bei einem neuen Mandat -- Benutzer, Lizenzen,
 * Postfaecher/Shared Mailboxes, Intune-Geraete und Entra-ID-Geraete in einem Lauf.
 *
 * Users+Lizenzen kommen aus LICENSES.runLicenseReport (bereits vorhanden),
 * Intune-Geraete ueber denselben Graph-Endpoint wie REPORT.sectionDevices.
 * Neu: Entra-ID-Geraete (/devices, Permission Device.Read.All) und
 * Postfaecher (EXO app-only ueber exorunner, Get-EXOMailbox).
 *
 * Anders als der Security-Report (report.js) kappt die Bestandsaufnahme ihre
 * Listen nicht auf 50 Zeilen -- hier IST die vollstaendige Liste der Zweck,
 * nicht nur ein Befund.
 */
const LICENSES = require("./licenses");
const { graphAllPages } = require("./graph");
const EXO = require("./exorunner");

const SECTIONS = [
  { id: "users", label: "Benutzer", desc: "Alle Konten mit Status, Kontotyp und Anlegedatum" },
  { id: "licenses", label: "Lizenzen", desc: "Zugewiesene Lizenzen je SKU, freie Seats" },
  { id: "mailboxes", label: "Postfächer", desc: "Alle Exchange-Online-Postfächer nach Typ" },
  { id: "sharedMailboxes", label: "Shared Mailboxes", desc: "Freigegebene Postfächer im Detail" },
  { id: "intuneDevices", label: "Intune-Geräte", desc: "Verwaltete Geräte, Compliance, Betriebssystem" },
  { id: "entraDevices", label: "Azure-AD-Geräte", desc: "Im Verzeichnis registrierte/verbundene Geräte" }
];

function metric(label, value, state, detail) {
  return { label, value, state: state || "ok", detail: detail || null };
}

// Anders als report.js (LIST_CAP 50, "Befund statt Datenexport"): die
// Bestandsaufnahme SOLL vollstaendig sein. 5000 ist nur ein Sicherheitsnetz
// gegen Ausreisser-Tenants, das in der Praxis nie greift.
const LIST_CAP = 5000;
function list(id, label, columns, rows, state) {
  const capped = rows.slice(0, LIST_CAP);
  return {
    id, label, columns,
    rows: capped.map(r => r.map(c => (c === null || c === undefined || c === "") ? "—" : String(c))),
    more: Math.max(0, rows.length - capped.length),
    state: state || null
  };
}

function fmtDate(s) {
  if (!s) return null;
  const d = String(s).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

async function sectionUsers(tenant, cert) {
  const users = await graphAllPages(tenant, cert,
    "/users?$select=id,displayName,userPrincipalName,accountEnabled,userType,createdDateTime,department,jobTitle&$top=999",
    { retryTransient: true });
  const members = users.filter(u => u.userType !== "Guest");
  const guests = users.filter(u => u.userType === "Guest");
  const disabled = users.filter(u => u.accountEnabled === false);
  const sorted = [...users].sort((a, b) => (a.displayName || "").localeCompare(b.displayName || ""));

  return {
    metrics: [
      metric("Konten gesamt", users.length),
      metric("Mitglieder", members.length),
      metric("Gäste", guests.length, guests.length > 0 ? "warn" : "ok"),
      metric("Deaktiviert", disabled.length)
    ],
    lists: [
      list("allUsers", "Alle Benutzerkonten", ["Name", "UPN", "Typ", "Status", "Abteilung", "Angelegt"],
        sorted.map(u => [
          u.displayName, u.userPrincipalName, u.userType === "Guest" ? "Gast" : "Mitglied",
          u.accountEnabled === false ? "deaktiviert" : "aktiv", u.department, fmtDate(u.createdDateTime)
        ]))
    ],
    data: { total: users.length, guests: guests.length, disabled: disabled.length }
  };
}

async function sectionLicenses(tenant, cert) {
  const r = await LICENSES.runLicenseReport(tenant, cert);
  const t = r.totals || {};
  const skus = (r.skus || []).filter(s => s.assigned > 0 || s.purchased > 0);
  const userLic = r.userLicenses || [];
  return {
    metrics: [
      metric("Lizenzierte Benutzer", t.licensedUsers),
      metric("Bezahlte SKUs", t.paidSkus),
      metric("Freie bezahlte Seats", t.freeSeats, t.freeSeats > 5 ? "warn" : "ok")
    ],
    lists: [
      list("skus", "Lizenzbestand", ["Lizenz", "Zugewiesen", "Gekauft", "Frei"],
        skus.map(s => [s.name, s.assigned, s.purchased, s.available])),
      list("userLicenses", "Benutzer → Lizenzen", ["Benutzer", "UPN", "Status", "Lizenzen"],
        userLic.map(u => [u.displayName, u.upn, u.enabled ? "aktiv" : "deaktiviert", (u.licenses || []).join(", ")]))
    ],
    data: r
  };
}

// Postfaecher und Shared Mailboxes teilen sich EINEN EXO-Abruf (Get-EXOMailbox
// ist per REST deutlich schneller als klassisches Get-Mailbox, aber trotzdem
// kein Grund, den Tenant zweimal zu fragen).
async function fetchMailboxes(tenant, cert) {
  const body = [
    "$mbx = @(Get-EXOMailbox -ResultSize Unlimited -Properties ArchiveStatus,WhenMailboxCreated | " +
      "Select-Object DisplayName,PrimarySmtpAddress,RecipientTypeDetails,ArchiveStatus,WhenMailboxCreated)",
    "Write-Output ('BEGINJSON' + (@{ ok = $true; mailboxes = $mbx } | ConvertTo-Json -Compress -Depth 6) + 'ENDJSON')"
  ].join("\r\n");
  const r = await EXO.runExo(
    { appId: tenant.clientId, organization: tenant.organization, certPemPath: cert },
    body, 240000);
  if (!r.ok) throw Object.assign(new Error("EXO-Runner: " + r.error), { hint: "Exchange Online app-only nicht erreichbar." });
  if (!r.data || r.data.ok === false) {
    throw Object.assign(new Error((r.data && r.data.error) || "Postfach-Abfrage fehlgeschlagen"),
      { hint: "Braucht Exchange.ManageAsApp + Exchange-Administrator-Rolle (siehe Tenant-Verbindungstest)." });
  }
  const raw = r.data.mailboxes || [];
  return Array.isArray(raw) ? raw : [raw];
}

function sectionMailboxesFrom(mailboxes) {
  const byType = {};
  for (const m of mailboxes) {
    const t = m.RecipientTypeDetails || "Unbekannt";
    byType[t] = (byType[t] || 0) + 1;
  }
  const sorted = [...mailboxes].sort((a, b) => (a.DisplayName || "").localeCompare(b.DisplayName || ""));
  return {
    metrics: [
      metric("Postfächer gesamt", mailboxes.length),
      ...Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([k, v]) => metric(k, v))
    ],
    lists: [
      list("allMailboxes", "Alle Postfächer", ["Name", "E-Mail", "Typ", "Archiv", "Angelegt"],
        sorted.map(m => [m.DisplayName, m.PrimarySmtpAddress, m.RecipientTypeDetails, m.ArchiveStatus, fmtDate(m.WhenMailboxCreated)]))
    ],
    data: { byType }
  };
}

function sectionSharedMailboxesFrom(mailboxes) {
  const shared = mailboxes.filter(m => m.RecipientTypeDetails === "SharedMailbox");
  const sorted = [...shared].sort((a, b) => (a.DisplayName || "").localeCompare(b.DisplayName || ""));
  return {
    metrics: [metric("Shared Mailboxes", shared.length)],
    lists: shared.length ? [
      list("sharedList", "Shared Mailboxes", ["Name", "E-Mail", "Archiv", "Angelegt"],
        sorted.map(m => [m.DisplayName, m.PrimarySmtpAddress, m.ArchiveStatus, fmtDate(m.WhenMailboxCreated)]))
    ] : [],
    data: { total: shared.length }
  };
}

async function sectionIntuneDevices(tenant, cert) {
  // Property heisst im Graph-Schema von managedDevice "managedDeviceOwnerType",
  // nicht "ownerType" -- die falsche Bezeichnung liess $select mit einem
  // OData-Parse-Fehler scheitern und die ganze Sektion ausfallen.
  const devices = await graphAllPages(tenant, cert,
    "/deviceManagement/managedDevices?$select=id,deviceName,operatingSystem,osVersion,manufacturer,model,serialNumber,complianceState,lastSyncDateTime,userPrincipalName,managedDeviceOwnerType,enrolledDateTime",
    { retryTransient: true });
  const compliant = devices.filter(d => d.complianceState === "compliant").length;
  const byOs = {};
  for (const d of devices) { const os = d.operatingSystem || "unbekannt"; byOs[os] = (byOs[os] || 0) + 1; }
  const sorted = [...devices].sort((a, b) => (a.deviceName || "").localeCompare(b.deviceName || ""));

  return {
    metrics: [
      metric("Geräte gesamt", devices.length),
      metric("Konform", compliant, devices.length && compliant === 0 ? "crit" : "ok"),
      ...Object.entries(byOs).sort((a, b) => b[1] - a[1]).map(([os, n]) => metric(os, n))
    ],
    lists: [
      list("allIntuneDevices", "Alle Intune-Geräte",
        ["Gerät", "OS", "Version", "Hersteller/Modell", "Nutzer", "Besitz", "Compliance", "Letzter Sync"],
        sorted.map(d => [
          d.deviceName, d.operatingSystem, d.osVersion,
          [d.manufacturer, d.model].filter(Boolean).join(" "),
          d.userPrincipalName, d.managedDeviceOwnerType, d.complianceState,
          d.lastSyncDateTime ? fmtDate(d.lastSyncDateTime) : "nie"
        ]))
    ],
    data: { byOs }
  };
}

async function sectionEntraDevices(tenant, cert) {
  const devices = await graphAllPages(tenant, cert,
    "/devices?$select=id,displayName,operatingSystem,operatingSystemVersion,trustType,accountEnabled,approximateLastSignInDateTime,deviceOwnership,isManaged,isCompliant&$top=999",
    { retryTransient: true });
  const trustDe = (t) => t === "AzureAd" ? "Microsoft Entra ID – verbunden"
    : t === "ServerAd" ? "Hybrid Microsoft Entra ID – verbunden"
    : t === "Workplace" ? "Microsoft Entra ID – registriert"
    : (t || "unbekannt");
  const byTrust = {};
  for (const d of devices) { const t = trustDe(d.trustType); byTrust[t] = (byTrust[t] || 0) + 1; }
  const sorted = [...devices].sort((a, b) => (a.displayName || "").localeCompare(b.displayName || ""));

  return {
    metrics: [
      metric("Geräte im Verzeichnis", devices.length),
      ...Object.entries(byTrust).sort((a, b) => b[1] - a[1]).map(([k, v]) => metric(k, v))
    ],
    lists: [
      list("allEntraDevices", "Alle Entra-ID-Geräte", ["Gerät", "OS", "Version", "Verbindungstyp", "Status", "Letzte Anmeldung"],
        sorted.map(d => [
          d.displayName, d.operatingSystem, d.operatingSystemVersion, trustDe(d.trustType),
          d.accountEnabled === false ? "deaktiviert" : "aktiv",
          d.approximateLastSignInDateTime ? fmtDate(d.approximateLastSignInDateTime) : "nie"
        ]))
    ],
    data: { byTrust }
  };
}

/**
 * Bestandsaufnahme erzeugen. sections: Array gewuenschter Section-Ids (leer = alle).
 * onProgress(label) fuer die Fortschrittsanzeige.
 */
async function runInventory(tenant, cert, sections, onProgress) {
  const wanted = new Set(Array.isArray(sections) && sections.length ? sections : SECTIONS.map(s => s.id));
  const result = {
    tenantId: tenant.id, tenantName: tenant.name, organization: tenant.organization || null,
    generatedAt: new Date().toISOString(), sections: {}
  };

  const run = async (id, label, fn) => {
    if (!wanted.has(id)) return;
    if (onProgress) onProgress(label);
    try {
      const r = await fn();
      result.sections[id] = { ok: true, label, metrics: r.metrics, lists: r.lists || [], data: r.data };
    } catch (e) {
      result.sections[id] = { ok: false, label, error: e.message, hint: e.hint || null, metrics: [] };
    }
  };

  await run("users", "Benutzer", () => sectionUsers(tenant, cert));
  await run("licenses", "Lizenzen", () => sectionLicenses(tenant, cert));

  if (wanted.has("mailboxes") || wanted.has("sharedMailboxes")) {
    if (onProgress) onProgress("Postfächer");
    try {
      const mailboxes = await fetchMailboxes(tenant, cert);
      if (wanted.has("mailboxes")) {
        const r = sectionMailboxesFrom(mailboxes);
        result.sections.mailboxes = { ok: true, label: "Postfächer", metrics: r.metrics, lists: r.lists, data: r.data };
      }
      if (wanted.has("sharedMailboxes")) {
        const r = sectionSharedMailboxesFrom(mailboxes);
        result.sections.sharedMailboxes = { ok: true, label: "Shared Mailboxes", metrics: r.metrics, lists: r.lists, data: r.data };
      }
    } catch (e) {
      const fail = { ok: false, error: e.message, hint: e.hint || null, metrics: [] };
      if (wanted.has("mailboxes")) result.sections.mailboxes = { ...fail, label: "Postfächer" };
      if (wanted.has("sharedMailboxes")) result.sections.sharedMailboxes = { ...fail, label: "Shared Mailboxes" };
    }
  }

  await run("intuneDevices", "Intune-Geräte", () => sectionIntuneDevices(tenant, cert));
  await run("entraDevices", "Azure-AD-Geräte", () => sectionEntraDevices(tenant, cert));

  const all = Object.values(result.sections).flatMap(s => s.metrics || []);
  result.summary = {
    crit: all.filter(m => m.state === "crit").length,
    warn: all.filter(m => m.state === "warn").length,
    ok: all.filter(m => m.state === "ok").length,
    failedSections: Object.values(result.sections).filter(s => !s.ok).map(s => s.label)
  };
  return result;
}

module.exports = { runInventory, SECTIONS };
