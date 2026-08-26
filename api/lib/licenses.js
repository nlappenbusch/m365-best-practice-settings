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
  WINDOWS_365_BUSINESS_2VCPU_4GB_64GB: "Windows 365 Business (2vCPU/4GB)",
  BUSINESS_PREMIUM_AND_MICROSOFT_365_COPILOT_FOR_BUSINESS: "Microsoft 365 Business Premium + Copilot (Bundle)",
  O365_BUSINESS_ESSENTIALS_AND_MICROSOFT_365_COPILOT_FOR_BUSINESS: "Microsoft 365 Business Basic + Copilot (Bundle)",
  O365_BUSINESS_PREMIUM_AND_MICROSOFT_365_COPILOT_FOR_BUSINESS: "Microsoft 365 Business Standard + Copilot (Bundle)",
  DYN365_TEAM_MEMBERS: "Dynamics 365 Team Members",
  DYN365_ENTERPRISE_SALES: "Dynamics 365 Sales Enterprise",
  DYN365_BUSCENTRAL_ESSENTIAL: "Dynamics 365 Business Central Essentials",
  DYN365_BUSCENTRAL_TEAM_MEMBER: "Dynamics 365 Business Central Team Members",
  DYN365_BUSCENTRAL_PREMIUM: "Dynamics 365 Business Central Premium",
  CRMSTANDARD: "Dynamics CRM Online Professional"
};

// Kostenlose/Trial-SKUs: tauchen im Bestand auf, sind aber nie "Verschwendung".
const FREE_SKUS = new Set([
  "FLOW_FREE", "POWERAPPS_VIRAL", "POWER_BI_STANDARD", "CCIBOTS_PRIVPREV_VIRAL",
  "TEAMS_EXPLORATORY", "STREAM", "WINDOWS_STORE", "RIGHTSMANAGEMENT_ADHOC",
  "MICROSOFT_BUSINESS_CENTER", "POWERAPPS_DEV", "Power_Pages_vTrial_for_Makers",
  "RMSBASIC"
]);

// Nicht seat-basierte Bestaende: Verbrauchs-SKUs (Communications Credits) und
// virale Trials kommen mit Pools von 10'000 bis 10'000'000 "Seats" — die als
// "frei bezahlt" zu zaehlen ergibt Fantasiezahlen (real passiert: 10'020'019
// freie Seats im Report). Erkennung ueber Poolgroesse + Namensmuster.
function isConsumptionSku(s) {
  const prepaid = ((s.prepaidUnits || {}).enabled || 0);
  return prepaid >= 10000 || /VIRAL|TRIAL|_FREE\b/i.test(String(s.skuPartNumber || ""));
}

// Suiten (Basis-Plaene) — mehrere davon nebeneinander sind grundsaetzlich pruefenswert.
const SUITE_SKUS = new Set([
  "SPB", "O365_BUSINESS_PREMIUM", "O365_BUSINESS_ESSENTIALS", "SMB_BUSINESS", "O365_BUSINESS",
  "SPE_E3", "SPE_E5", "SPE_F1", "M365_F1", "DESKLESSPACK",
  "STANDARDPACK", "ENTERPRISEPACK", "ENTERPRISEPREMIUM", "ENTERPRISEPREMIUM_NOPSTNCONF",
  "BUSINESS_PREMIUM_AND_MICROSOFT_365_COPILOT_FOR_BUSINESS",
  "O365_BUSINESS_ESSENTIALS_AND_MICROSOFT_365_COPILOT_FOR_BUSINESS",
  "O365_BUSINESS_PREMIUM_AND_MICROSOFT_365_COPILOT_FOR_BUSINESS"
]);

// Bekannte Enthaltensein-Beziehungen (nur belegte Faelle, Quelle: Microsoft
// Learn "Teams add-on licensing" + Produktbeschreibungen): SKU X enthaelt die
// Faehigkeiten von SKU Y — X + Y gleichzeitig = doppelt bezahlt.
// Wichtig fuers Verstaendnis: E3 enthaelt Teams Phone/Audio Conferencing NICHT
// (dort sind MCOEV/MCOMEETADV notwendige Add-ons) — erst E5 enthaelt beides.
const SKU_CONTAINS = {
  SPE_E5: ["MCOEV", "MCOMEETADV", "POWER_BI_PRO", "THREAT_INTELLIGENCE", "ATP_ENTERPRISE", "WIN_DEF_ATP", "DEFENDER_ENDPOINT_P1", "ADALLOM_STANDALONE", "AAD_PREMIUM", "AAD_PREMIUM_P2", "INTUNE_A", "EXCHANGEENTERPRISE", "EXCHANGESTANDARD", "OFFICESUBSCRIPTION", "EMS", "EMSPREMIUM"],
  ENTERPRISEPREMIUM: ["MCOEV", "MCOMEETADV", "POWER_BI_PRO", "THREAT_INTELLIGENCE", "ATP_ENTERPRISE", "EXCHANGEENTERPRISE", "EXCHANGESTANDARD", "OFFICESUBSCRIPTION"],
  ENTERPRISEPREMIUM_NOPSTNCONF: ["MCOEV", "POWER_BI_PRO", "THREAT_INTELLIGENCE", "ATP_ENTERPRISE", "EXCHANGEENTERPRISE", "EXCHANGESTANDARD", "OFFICESUBSCRIPTION"],
  SPE_E3: ["AAD_PREMIUM", "INTUNE_A", "EXCHANGEENTERPRISE", "EXCHANGESTANDARD", "OFFICESUBSCRIPTION", "EMS"],
  ENTERPRISEPACK: ["EXCHANGEENTERPRISE", "EXCHANGESTANDARD", "OFFICESUBSCRIPTION"],
  SPB: ["EXCHANGESTANDARD", "ATP_ENTERPRISE", "AAD_PREMIUM", "INTUNE_A", "MDE_SMB", "O365_BUSINESS_PREMIUM", "O365_BUSINESS_ESSENTIALS", "SMB_BUSINESS", "O365_BUSINESS"],
  // Copilot-Bundles: enthalten die jeweilige Suite UND Copilot
  BUSINESS_PREMIUM_AND_MICROSOFT_365_COPILOT_FOR_BUSINESS: ["SPB", "Microsoft_365_Copilot", "EXCHANGESTANDARD", "ATP_ENTERPRISE", "AAD_PREMIUM", "INTUNE_A", "MDE_SMB", "O365_BUSINESS_PREMIUM", "O365_BUSINESS_ESSENTIALS", "SMB_BUSINESS", "O365_BUSINESS"],
  O365_BUSINESS_ESSENTIALS_AND_MICROSOFT_365_COPILOT_FOR_BUSINESS: ["O365_BUSINESS_ESSENTIALS", "Microsoft_365_Copilot", "EXCHANGESTANDARD"],
  O365_BUSINESS_PREMIUM_AND_MICROSOFT_365_COPILOT_FOR_BUSINESS: ["O365_BUSINESS_PREMIUM", "Microsoft_365_Copilot", "EXCHANGESTANDARD", "O365_BUSINESS_ESSENTIALS"],
  O365_BUSINESS_PREMIUM: ["EXCHANGESTANDARD", "O365_BUSINESS_ESSENTIALS"],
  O365_BUSINESS_ESSENTIALS: ["EXCHANGESTANDARD"],
  STANDARDPACK: ["EXCHANGESTANDARD"],
  EMSPREMIUM: ["EMS", "AAD_PREMIUM", "AAD_PREMIUM_P2", "INTUNE_A", "ADALLOM_STANDALONE"],
  EMS: ["AAD_PREMIUM", "INTUNE_A"],
  AAD_PREMIUM_P2: ["AAD_PREMIUM"],
  EXCHANGEENTERPRISE: ["EXCHANGESTANDARD"],
  WIN_DEF_ATP: ["DEFENDER_ENDPOINT_P1"],
  THREAT_INTELLIGENCE: ["ATP_ENTERPRISE"]
};

/**
 * Kombination bezahlter SKUs eines Nutzers bewerten:
 *  - redundant: eine Suite enthaelt eine ebenfalls zugewiesene Einzel-Lizenz
 *  - check:     mehrere Suiten nebeneinander (Ueberlappung wahrscheinlich)
 *  - addon:     eine Suite + notwendige Add-ons (z.B. E3 + Teams Phone) — normal
 */
function classifyCombo(parts) {
  const set = new Set(parts);
  const redundancies = [];
  for (const p of parts) {
    for (const contained of (SKU_CONTAINS[p] || [])) {
      if (set.has(contained)) redundancies.push({ container: friendlySku(p), contained: friendlySku(contained) });
    }
  }
  if (redundancies.length) {
    return { verdict: "redundant", reason: redundancies.map(r => `${r.contained} ist bereits in ${r.container} enthalten`).join("; ") };
  }
  const suites = parts.filter(p => SUITE_SKUS.has(p));
  if (suites.length >= 2) {
    return { verdict: "check", reason: "Mehrere Basis-Suiten nebeneinander (" + suites.map(friendlySku).join(" + ") + ") — Überlappung prüfen" };
  }
  return { verdict: "addon", reason: "Suite + Add-on(s) — übliche, notwendige Kombination (Add-ons sind nicht in der Suite enthalten)" };
}

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
      consumption: !FREE_SKUS.has(s.skuPartNumber) && isConsumptionSku(s),
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

  const userPaidParts = u => (u.assignedLicenses || [])
    .map(l => skuById.get(l.skuId))
    .filter(s => s && paidSkuIds.has(s.skuId))
    .map(s => s.skuPartNumber);

  const multiSuite = licensed
    .map(u => ({ u, parts: userPaidParts(u) }))
    .filter(x => x.parts.length >= 2)
    .map(x => {
      const cls = classifyCombo(x.parts);
      return {
        displayName: x.u.displayName, upn: x.u.userPrincipalName,
        licenses: x.parts.map(friendlySku),
        verdict: cls.verdict, reason: cls.reason
      };
    })
    .sort((a, b) => {
      const rank = { redundant: 0, check: 1, addon: 2 };
      return rank[a.verdict] - rank[b.verdict];
    });

  const unusedPaidSeats = skus.filter(s => !s.free && !s.consumption && s.capabilityStatus === "Enabled" && s.available > 0);

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
      // Nur die tatsaechlich handlungsrelevanten Kombis zaehlen — Suite+Add-on
      // (z.B. E3 + Teams Phone) ist normal und soll keine Warnung ausloesen.
      multiSuite: multiSuite.filter(m => m.verdict !== "addon").length,
      multiSuiteTotal: multiSuite.length
    },
    skus,
    findings: { disabledWithLicense, inactiveWithLicense, multiSuite, unusedPaidSeats }
  };
}

module.exports = { runLicenseReport, friendlySku, classifyCombo, SKU_NAMES, FREE_SKUS, SKU_CONTAINS, SUITE_SKUS };
