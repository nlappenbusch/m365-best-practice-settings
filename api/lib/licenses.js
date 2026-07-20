/**
 * Lizenz-Optimizer (Vorbilder: AdminDroid-Lizenzkosten-Skript, Office365ITPros
 * Licensing Report, M365Optimizer — hier als app-only-Web-Report):
 * liest SKUs + Nutzer-Lizenzzuweisungen und findet die klassischen
 * Geldverbrenner:
 *   - freie bezahlte Seats (gekauft, aber niemandem zugewiesen)
 *   - Lizenzen an DEAKTIVIERTEN Konten
 *   - Lizenzen an INAKTIVEN Konten (kein Sign-in seit >90 Tagen)
 *   - Nutzer mit mehreren bezahlten Suiten (Doppellizenzierung pruefen)
 * Bewusst ohne Preisrechnung — Seats/Namen sind belastbar, Fantasiepreise nicht.
 *
 * Permissions: Organization.Read.All (subscribedSkus), User.Read (in
 * User.ReadWrite.All enthalten); signInActivity zusaetzlich AuditLog.Read.All
 * — fehlt sie (oder kein Entra-P1), faellt nur das Inaktiv-Finding aus.
 */
const { graphAllPages } = require("./graph");

// Gaengige SKUs -> Klarnamen (Auszug aus Microsofts "Product names and service
// plan identifiers for licensing"; unbekannte SKUs zeigen den Partnummer-String).
const SKU_NAMES = {
  SPB: "Microsoft 365 Business Premium",
  O365_BUSINESS_PREMIUM: "Microsoft 365 Business Standard",
  O365_BUSINESS_ESSENTIALS: "Microsoft 365 Business Basic",
  SMB_BUSINESS: "Microsoft 365 Apps for Business",
  O365_BUSINESS: "Microsoft 365 Apps for Business",
  OFFICESUBSCRIPTION: "Microsoft 365 Apps for Enterprise",
  SPE_E3: "Microsoft 365 E3",
  SPE_E5: "Microsoft 365 E5",
  SPE_F1: "Microsoft 365 F3",
  M365_F1: "Microsoft 365 F1",
  DESKLESSPACK: "Office 365 F3",
  STANDARDPACK: "Office 365 E1",
  ENTERPRISEPACK: "Office 365 E3",
  ENTERPRISEPREMIUM: "Office 365 E5",
  ENTERPRISEPREMIUM_NOPSTNCONF: "Office 365 E5 (ohne Audio Conferencing)",
  EXCHANGESTANDARD: "Exchange Online (Plan 1)",
  EXCHANGEENTERPRISE: "Exchange Online (Plan 2)",
  EXCHANGEDESKLESS: "Exchange Online Kiosk",
  EMS: "Enterprise Mobility + Security E3",
  EMSPREMIUM: "Enterprise Mobility + Security E5",
  AAD_PREMIUM: "Microsoft Entra ID P1",
  AAD_PREMIUM_P2: "Microsoft Entra ID P2",
  ATP_ENTERPRISE: "Defender for Office 365 (Plan 1)",
  THREAT_INTELLIGENCE: "Defender for Office 365 (Plan 2)",
  DEFENDER_ENDPOINT_P1: "Defender for Endpoint P1",
  WIN_DEF_ATP: "Defender for Endpoint P2",
  ADALLOM_STANDALONE: "Defender for Cloud Apps",
  INTUNE_A: "Intune Plan 1",
  MCOMEETADV: "Teams Audio Conferencing",
  MCOEV: "Teams Phone Standard",
  PHONESYSTEM_VIRTUALUSER: "Teams Phone Resource Account",
  MCOPSTNC: "Communications Credits",
  Microsoft_Teams_Rooms_Pro: "Teams Rooms Pro",
  Microsoft_Teams_Rooms_Basic: "Teams Rooms Basic",
  POWER_BI_PRO: "Power BI Pro",
  POWER_BI_STANDARD: "Power BI (kostenlos)",
  PBI_PREMIUM_PER_USER_ADDON: "Power BI Premium per User",
  PROJECTPROFESSIONAL: "Project Plan 3",
  PROJECT_P1: "Project Plan 1",
  PROJECTPREMIUM: "Project Plan 5",
  VISIOCLIENT: "Visio Plan 2",
  VISIO_PLAN1_DEPT: "Visio Plan 1",
  Microsoft_365_Copilot: "Microsoft 365 Copilot",
  FLOW_FREE: "Power Automate (kostenlos)",
  POWERAPPS_VIRAL: "Power Apps (Trial/kostenlos)",
  POWERAPPS_DEV: "Power Apps Developer",
  CCIBOTS_PRIVPREV_VIRAL: "Copilot Studio (Trial)",
  TEAMS_EXPLORATORY: "Teams Exploratory",
  STREAM: "Microsoft Stream (Trial)",
  WINDOWS_STORE: "Windows Store",
  RIGHTSMANAGEMENT_ADHOC: "Rights Management (Ad-hoc)",
  MICROSOFT_BUSINESS_CENTER: "Microsoft Business Center",
  Power_Pages_vTrial_for_Makers: "Power Pages (Trial)",
  MDE_SMB: "Defender for Business",
  WINDOWS_365_BUSINESS_2VCPU_4GB_64GB: "Windows 365 Business (2vCPU/4GB)"
};

// Kostenlose/Trial-SKUs: tauchen im Bestand auf, sind aber nie "Verschwendung".
const FREE_SKUS = new Set([
  "FLOW_FREE", "POWERAPPS_VIRAL", "POWER_BI_STANDARD", "CCIBOTS_PRIVPREV_VIRAL",
  "TEAMS_EXPLORATORY", "STREAM", "WINDOWS_STORE", "RIGHTSMANAGEMENT_ADHOC",
  "MICROSOFT_BUSINESS_CENTER", "POWERAPPS_DEV", "Power_Pages_vTrial_for_Makers"
]);

function friendlySku(part) { return SKU_NAMES[part] || part; }

const INACTIVE_DAYS = 90;

function lastSignInOf(u) {
  const a = u.signInActivity || {};
  const times = [a.lastSignInDateTime, a.lastNonInteractiveSignInDateTime].filter(Boolean).map(x => Date.parse(x));
  return times.length ? Math.max(...times) : null;
}

async function runLicenseReport(tenant, cert) {
  const beta = { retryTransient: true };

  const skusRaw = await graphAllPages(tenant, cert, "/subscribedSkus", beta);
  const skuById = new Map(skusRaw.map(s => [s.skuId, s]));

  // signInActivity braucht AuditLog.Read.All + Entra P1 — bei Fehlern ohne
  // das Feld erneut laden, dann entfaellt nur das Inaktiv-Finding.
  const baseSelect = "id,displayName,userPrincipalName,accountEnabled,assignedLicenses,userType";
  let users, signInAvailable = true;
  try {
    users = await graphAllPages(tenant, cert, `/users?$select=${baseSelect},signInActivity&$top=500`, beta);
  } catch (e) {
    signInAvailable = false;
    users = await graphAllPages(tenant, cert, `/users?$select=${baseSelect}&$top=999`, beta);
  }

  const licensed = users.filter(u => (u.assignedLicenses || []).length && u.userType !== "Guest");
  const paidSkuIds = new Set(skusRaw.filter(s => !FREE_SKUS.has(s.skuPartNumber)).map(s => s.skuId));

  const userLicNames = u => (u.assignedLicenses || [])
    .map(l => skuById.get(l.skuId))
    .filter(Boolean)
    .map(s => ({ name: friendlySku(s.skuPartNumber), paid: paidSkuIds.has(s.skuId) }));

  const skus = skusRaw
    .map(s => ({
      skuPartNumber: s.skuPartNumber,
      name: friendlySku(s.skuPartNumber),
      free: FREE_SKUS.has(s.skuPartNumber),
      purchased: (s.prepaidUnits || {}).enabled || 0,
      warning: (s.prepaidUnits || {}).warning || 0,
      suspended: (s.prepaidUnits || {}).suspended || 0,
      assigned: s.consumedUnits || 0,
      available: Math.max(0, ((s.prepaidUnits || {}).enabled || 0) - (s.consumedUnits || 0)),
      capabilityStatus: s.capabilityStatus || ""
    }))
    .sort((a, b) => (a.free === b.free ? b.purchased - a.purchased : a.free ? 1 : -1));

  const now = Date.now();
  const cutoff = now - INACTIVE_DAYS * 24 * 3600 * 1000;

  const disabledWithLicense = licensed
    .filter(u => u.accountEnabled === false && userLicNames(u).some(l => l.paid))
    .map(u => ({ displayName: u.displayName, upn: u.userPrincipalName, licenses: userLicNames(u).filter(l => l.paid).map(l => l.name) }));

  const inactiveWithLicense = !signInAvailable ? null : licensed
    .filter(u => u.accountEnabled !== false)
    .filter(u => userLicNames(u).some(l => l.paid))
    .map(u => ({ u, last: lastSignInOf(u) }))
    .filter(x => x.last === null || x.last < cutoff)
    .map(x => ({
      displayName: x.u.displayName, upn: x.u.userPrincipalName,
      lastSignIn: x.last ? new Date(x.last).toISOString().slice(0, 10) : null,
      daysInactive: x.last ? Math.floor((now - x.last) / 86400000) : null,
      licenses: userLicNames(x.u).filter(l => l.paid).map(l => l.name)
    }))
    .sort((a, b) => (b.daysInactive ?? 99999) - (a.daysInactive ?? 99999));

  const multiSuite = licensed
    .map(u => ({ u, paid: userLicNames(u).filter(l => l.paid) }))
    .filter(x => x.paid.length >= 2)
    .map(x => ({ displayName: x.u.displayName, upn: x.u.userPrincipalName, licenses: x.paid.map(l => l.name) }));

  const unusedPaidSeats = skus.filter(s => !s.free && s.capabilityStatus === "Enabled" && s.available > 0);

  return {
    generatedAt: new Date().toISOString(),
    inactiveDays: INACTIVE_DAYS,
    signInAvailable,
    totals: {
      users: users.filter(u => u.userType !== "Guest").length,
      licensedUsers: licensed.length,
      paidSkus: skus.filter(s => !s.free).length,
      freeSeats: unusedPaidSeats.reduce((n, s) => n + s.available, 0),
      disabledWithLicense: disabledWithLicense.length,
      inactiveWithLicense: inactiveWithLicense ? inactiveWithLicense.length : null,
      multiSuite: multiSuite.length
    },
    skus,
    findings: { disabledWithLicense, inactiveWithLicense, multiSuite, unusedPaidSeats }
  };
}

module.exports = { runLicenseReport, friendlySku, SKU_NAMES, FREE_SKUS };
