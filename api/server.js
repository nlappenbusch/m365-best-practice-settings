/**
 * Live-Deploy-Backend fuer den M365 Security Policy Manager.
 *
 * Statt das generierte PowerShell-Skript manuell auszufuehren, kann das Tool
 * die BP_-Policies direkt anwenden:
 *   1. Onboarding (einmalig pro Tenant): Device-Code-Login eines Admins ->
 *      legt automatisch eine App-Registrierung an (Exchange.ManageAsApp,
 *      Exchange-Administrator-Rolle, self-signed Zertifikat) und speichert
 *      das Zertifikat unter state/cert/<tenantId>.pem.
 *   2. Deploy: verbindet Exchange Online app-only mit dem Zertifikat und
 *      setzt die Policies idempotent (siehe lib/deploy.js).
 *
 * Die Alert Policy (Security & Compliance) laeuft weiterhin ueber das
 * generierte Skript — Connect-IPPSSession ist bewusst nicht Teil des Backends.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const express = require("express");
const session = require("express-session");
const { spawn } = require("child_process");

const SERVERLOG = require("./lib/serverlog");
// Ab hier landen alle console-Ausgaben zusaetzlich im Ring-Puffer
// (abrufbar ueber /api/serverlog) — stdout bleibt unveraendert.
SERVERLOG.install();

const EXO = require("./lib/exorunner");
const DEPLOY = require("./lib/deploy");
const OIB = require("./lib/oib");
const TCM = require("./lib/tcm");
const AUTOPILOT = require("./lib/autopilot");
const GRAPHLIB = require("./lib/graph");
const BD = require("./lib/bitdefender");
const NSIGHT = require("./lib/nsight");
const FORTICLIENT = require("./lib/forticlient");
const WIN32APP = require("./lib/win32app");
const MIGRATION = require("./lib/migrationPackage");
const REPORT = require("./lib/report");
const GROUPTAGS = require("./lib/groupTags");
const ADMINROLES = require("./lib/adminRoles");
const APPGROUPS = require("./lib/appGroups");
const ENTRAUSERS = require("./lib/entraUsers");
const SSO = require("./lib/sso");
const OIBIMPORT = require("./lib/oibImport");
const ASSIGNCHECK = require("./lib/assignmentCheck");
const LICENSES = require("./lib/licenses");
const IBACKUP = require("./lib/intuneBackup");
const DRIVEMAP = require("./lib/driveMapping");
const PRINTMAP = require("./lib/printerMapping");
const CONDACCESS = require("./lib/conditionalAccess");
const DOMAINAUTH = require("./lib/domainAuth");
const SDP = require("./lib/sdp");
const AISUGGEST = require("./lib/aiSuggest");
const CUSTOMPOLICY = require("./lib/customPolicy");
const SETTINGSCATALOG = require("./lib/settingsCatalog");
const USERACTIONS = require("./lib/userActions");
const BULKDELETE = require("./lib/intuneBulkDelete");
const SPMAP = require("./lib/sharepointMapping");
const REGPOLICY = require("./lib/registryPolicy");
const MAESTER = require("./lib/maester");
const MAESTER_EXPLAIN = require("./lib/maesterExplain");
const MAESTER_PDF = require("./lib/maesterPdf");
const MAESTER_HTML = require("./lib/maesterHtml");

const PORT = Number(process.env.PORT || 3000);
const STATE_DIR = process.env.STATE_DIR || path.join(__dirname, "state");
const CERT_DIR = path.join(STATE_DIR, "cert");
fs.mkdirSync(CERT_DIR, { recursive: true });
const STATE_FILE = path.join(STATE_DIR, "state.json");

const GRAPH = "https://graph.microsoft.com/v1.0";
// "Microsoft Graph Command Line Tools" — oeffentlicher First-Party-Client (wie Connect-MgGraph).
const GRAPH_CLI_CLIENT = "14d82eec-204b-4c2f-b7e8-296a70dab67e";
const APP_DISPLAY_NAME = "M365-Security-Policy-Manager";
const EXO_APP_ID = "00000002-0000-0ff1-ce00-000000000000"; // Office 365 Exchange Online
const EXCHANGE_ADMIN_ROLE_TEMPLATE = "29232cdf-9323-42fd-ade2-1d097af3e4de"; // Exchange Administrator (EXO PowerShell)
const COMPLIANCE_ADMIN_ROLE_TEMPLATE = "17315797-102d-40b4-93e0-432062caca18"; // Compliance Administrator (Security & Compliance PowerShell)
const GRAPH_APP_ID = "00000003-0000-0000-c000-000000000000"; // Microsoft Graph
// Graph-Application-Permissions: OIB-Zuweisung (Intune + Gruppen), TCM-Snapshots
// (Alert-Policy-Pruefung im Audit), App-Deployment (AAD-APP-*-Gruppe anlegen/
// verschachteln + Win32-App-Upload), Conditional-Access-Deployment und
// KI-Schreibrechte-Aktionen (MFA-Reset braucht die eigene, engere
// UserAuthenticationMethod.ReadWrite.All-Berechtigung -- die anderen Aktionen
// dort (Passwort/Sitzungen/Gruppen) deckt User.ReadWrite.All/Group.ReadWrite.All
// bereits ab).
// Bestehende Tenants brauchen dafuer einmal "Reparieren" (idempotent additiv,
// siehe repairAppReg — kein Neu-Onboarding noetig).
const GRAPH_APP_PERMS = ["DeviceManagementConfiguration.ReadWrite.All", "DeviceManagementServiceConfig.ReadWrite.All", "Group.ReadWrite.All", "DeviceManagementApps.ReadWrite.All", "ConfigurationMonitoring.ReadWrite.All", "Policy.ReadWrite.ConditionalAccess", "Policy.Read.All", "Application.Read.All", "User.ReadWrite.All", "Organization.Read.All", "AuditLog.Read.All", "DeviceManagementScripts.ReadWrite.All", "UserAuthenticationMethod.ReadWrite.All", "Sites.Read.All", "RoleManagement.ReadWrite.Directory"];
// Read-Only-Permissions fuer das Maester-Security-Audit (maester.dev, Liste aus
// deren app-only-Doku). OPTIONAL: einzelne davon existieren nicht in jedem
// Graph-Service-Principal (NetworkAccess = Global Secure Access, Security-
// Identities = Defender for Identity) — fehlende werden beim Onboarding/
// Reparieren uebersprungen statt den Vorgang abzubrechen; die betroffenen
// Maester-Tests fallen dann einfach als "nicht abrufbar" aus.
// Bestehende Tenants: einmal "Reparieren" im Tab Tenants ausfuehren.
const GRAPH_APP_PERMS_MAESTER = ["Directory.Read.All", "DirectoryRecommendations.Read.All", "EntitlementManagement.Read.All", "IdentityRiskEvent.Read.All", "NetworkAccess.Read.All", "OnPremDirectorySynchronization.Read.All", "OrgSettings-AppsAndServices.Read.All", "OrgSettings-Forms.Read.All", "Policy.Read.ConditionalAccess", "Reports.Read.All", "ReportSettings.Read.All", "RoleEligibilitySchedule.Read.Directory", "RoleManagement.Read.All", "RoleManagementAlert.Read.Directory", "SecurityIdentitiesHealth.Read.All", "SecurityIdentitiesSensors.Read.All", "SharePointTenantSettings.Read.All", "ThreatHunting.Read.All", "UserAuthenticationMethod.Read.All", "DeviceManagementManagedDevices.Read.All", "DeviceManagementRBAC.Read.All"];
// Maester-Zusatzverbindungen (auf Nils' Wunsch, 26.08.2026): Teams-Tests
// brauchen die Teams-Administrator-Rolle fuer den App-SP, SharePoint-Tests die
// SharePoint-Application-Permission Sites.FullControl.All (app-only Zugriff
// auf die Admin-Site — SharePoint kennt kein engeres app-only-Aequivalent;
// genutzt wird sie ausschliesslich lesend).
const TEAMS_ADMIN_ROLE_TEMPLATE = "69091246-20e8-4a56-aa4d-066075b2a7a8"; // Teams Administrator
const SPO_APP_ID = "00000003-0000-0ff1-ce00-000000000000"; // Office 365 SharePoint Online
const SPO_APP_PERMS_MAESTER = ["Sites.FullControl.All"];
// Tenant Configuration Management: Microsofts TCM-Dienst-SP liest fuer uns die
// S&C-Ressourcen (protectionAlert) — braucht Exchange.ManageAsApp + Security Reader.
const TCM_APP_ID = "03b07b79-c5bc-4b5e-9bfa-13acf4a99998";
const M365_ADMIN_SERVICES_APP_ID = "6b91db1b-f05b-405a-a0b2-e3f60b28d645";
const SECURITY_READER_ROLE_TEMPLATE = "5d6b6bb7-de71-4623-b4af-96380a352509"; // Security Reader

// ---------- Persistenz ----------
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch (e) { return { tenants: [] }; }
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), "utf8"); }
function certPemPath(tenantId) { return path.join(CERT_DIR, tenantId + ".pem"); }

// ---------- Lokaler Admin-Login ----------
function hashPw(pw, salt) { return crypto.scryptSync(String(pw), salt, 32).toString("hex"); }
function ensureAdmin(s) {
  let changed = false;
  const envUser = process.env.ADMIN_USER;
  const envPw = process.env.ADMIN_PASSWORD;
  if (!s.auth || !s.auth.passwordHash) {
    const pw = envPw || crypto.randomBytes(16).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 18);
    const salt = crypto.randomBytes(16).toString("hex");
    s.auth = { username: envUser || "admin", salt, passwordHash: hashPw(pw, salt) };
    changed = true;
    if (envPw) {
      console.log("Live-Deploy-Login angelegt (Passwort aus ADMIN_PASSWORD uebernommen).");
    } else {
      console.log("\n==================================================");
      console.log("  LIVE-DEPLOY LOGIN ANGELEGT");
      console.log("    Benutzer:  " + s.auth.username);
      console.log("    Passwort:  " + pw);
      console.log("  >> JETZT NOTIEREN — wird nicht erneut angezeigt.");
      console.log("==================================================\n");
    }
  } else if (envPw) {
    // ADMIN_PASSWORD aus der Umgebung ist verbindlich: weicht der gespeicherte
    // Hash ab (z.B. Passwort via GitHub-Secret geaendert), wird er aktualisiert.
    if (hashPw(envPw, s.auth.salt) !== s.auth.passwordHash) {
      const salt = crypto.randomBytes(16).toString("hex");
      s.auth.salt = salt;
      s.auth.passwordHash = hashPw(envPw, salt);
      changed = true;
      console.log("Live-Deploy-Login: Passwort aus ADMIN_PASSWORD aktualisiert.");
    }
    if (envUser && s.auth.username !== envUser) { s.auth.username = envUser; changed = true; }
  }
  if (!s.sessionSecret) { s.sessionSecret = crypto.randomBytes(24).toString("hex"); changed = true; }
  if (changed) saveState(s);
  return s;
}

// ---------- Graph-Helfer (delegierter Token aus dem Onboarding) ----------
function odataLit(s) { return encodeURIComponent(String(s == null ? "" : s).replace(/'/g, "''")); }
async function gReq(token, method, p, body) {
  const r = await fetch(GRAPH + p, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let j; try { j = text ? JSON.parse(text) : {}; } catch { j = { raw: text }; }
  if (!r.ok) throw new Error((j && j.error && j.error.message) ? j.error.message : (text || ("Graph " + r.status)));
  return j;
}

/**
 * Entra-Rolle idempotent zuweisen: Rolle bei Bedarf aktivieren, Service Principal
 * als Mitglied hinzufuegen; "already exists" = Ziel erreicht.
 * Rueckgabe: 'ok' (war schon Mitglied) oder 'fixed' (neu zugewiesen).
 */
async function ensureDirectoryRole(token, spId, roleTemplateId) {
  let dirRole = null;
  try { dirRole = (await gReq(token, "GET", `/directoryRoles?$filter=roleTemplateId eq '${roleTemplateId}'`)).value[0]; } catch (e) { /* unten aktivieren */ }
  if (!dirRole) {
    try {
      dirRole = await gReq(token, "POST", "/directoryRoles", { roleTemplateId }); // Rolle aktivieren
    } catch (e) {
      dirRole = (await gReq(token, "GET", `/directoryRoles?$filter=roleTemplateId eq '${roleTemplateId}'`)).value[0];
      if (!dirRole) throw e;
    }
  }
  try {
    await gReq(token, "POST", `/directoryRoles/${dirRole.id}/members/$ref`, { "@odata.id": `${GRAPH}/directoryObjects/${spId}` });
    return "fixed";
  } catch (e) {
    if (/already exist/i.test(String(e.message || ""))) return "ok"; // schon Mitglied
    throw e;
  }
}

// Ziel-Permissions aufloesen: EXO Exchange.ManageAsApp + Graph-Rollen fuer OIB.
async function resolvePermissionTargets(token) {
  const exoSp = (await gReq(token, "GET", `/servicePrincipals?$filter=appId eq '${EXO_APP_ID}'`)).value[0];
  if (!exoSp) throw new Error("Service Principal 'Office 365 Exchange Online' nicht gefunden.");
  const manageRole = (exoSp.appRoles || []).find(x => x.value === "Exchange.ManageAsApp" && (x.allowedMemberTypes || []).includes("Application"));
  if (!manageRole) throw new Error("Exchange.ManageAsApp nicht im EXO-Service-Principal gefunden.");

  const graphSp = (await gReq(token, "GET", `/servicePrincipals?$filter=appId eq '${GRAPH_APP_ID}'`)).value[0];
  if (!graphSp) throw new Error("Microsoft-Graph Service-Principal nicht gefunden.");
  const graphRoles = GRAPH_APP_PERMS.map(v => {
    const role = (graphSp.appRoles || []).find(x => x.value === v && (x.allowedMemberTypes || []).includes("Application"));
    if (!role) throw new Error("Graph-Application-Berechtigung fehlt im SP: " + v);
    return role;
  });

  // Maester-Permissions tolerant aufloesen: was der Graph-SP des Tenants nicht
  // kennt, wird uebersprungen (siehe Kommentar an GRAPH_APP_PERMS_MAESTER).
  const graphRolesMaester = [];
  const maesterMissing = [];
  for (const v of GRAPH_APP_PERMS_MAESTER) {
    const role = (graphSp.appRoles || []).find(x => x.value === v && (x.allowedMemberTypes || []).includes("Application"));
    if (role) graphRolesMaester.push(role); else maesterMissing.push(v);
  }
  if (maesterMissing.length) console.log("Maester-Permissions im Tenant nicht verfuegbar (uebersprungen): " + maesterMissing.join(", "));

  // SharePoint-Rollen (fuer die Maester-SPO-Tests) — tolerant wie oben.
  let spoSp = null;
  const spoRolesMaester = [];
  try {
    spoSp = (await gReq(token, "GET", `/servicePrincipals?$filter=appId eq '${SPO_APP_ID}'`)).value[0] || null;
    if (spoSp) {
      for (const v of SPO_APP_PERMS_MAESTER) {
        const role = (spoSp.appRoles || []).find(x => x.value === v && (x.allowedMemberTypes || []).includes("Application"));
        if (role) spoRolesMaester.push(role);
      }
    }
  } catch (e) { console.log("SharePoint-SP nicht aufloesbar (uebersprungen): " + e.message); }

  return { exoSp, manageRole, graphSp, graphRoles, graphRolesMaester, spoSp, spoRolesMaester };
}

// Admin-Consent (App-Role-Assignment) idempotent setzen.
async function ensureAppRoleAssignment(token, appSpId, resourceSpId, appRoleId, existing) {
  if (existing.find(a => a.appRoleId === appRoleId && a.resourceId === resourceSpId)) return "ok";
  try {
    await gReq(token, "POST", `/servicePrincipals/${appSpId}/appRoleAssignments`,
      { principalId: appSpId, resourceId: resourceSpId, appRoleId });
    return "fixed";
  } catch (e) {
    if (/already exist|duplicate/i.test(String(e.message || ""))) return "ok";
    throw e;
  }
}

// Service Principal fuer eine App-Id sicherstellen (idempotent).
async function ensureServicePrincipal(token, appId) {
  let sp = (await gReq(token, "GET", `/servicePrincipals?$filter=appId eq '${appId}'`)).value[0];
  if (sp) return sp;
  try {
    sp = await gReq(token, "POST", "/servicePrincipals", { appId });
    return sp;
  } catch (e) {
    if (/already exist/i.test(String(e.message || ""))) {
      return (await gReq(token, "GET", `/servicePrincipals?$filter=appId eq '${appId}'`)).value[0];
    }
    throw e;
  }
}

/**
 * TCM-Einrichtung fuer die Alert-Policy-Pruefung: TCM- und M365-Admin-Services-SP
 * anlegen, dem TCM-SP Exchange.ManageAsApp geben und die Security-Reader-Rolle
 * zuweisen (gemaess Microsoft-Doku fuer S&C-Ressourcen).
 */
async function ensureTcmSetup(token, exoSp, manageRole) {
  const tcmSp = await ensureServicePrincipal(token, TCM_APP_ID);
  await ensureServicePrincipal(token, M365_ADMIN_SERVICES_APP_ID);
  const existing = (await gReq(token, "GET", `/servicePrincipals/${tcmSp.id}/appRoleAssignments`)).value || [];
  const states = [
    await ensureAppRoleAssignment(token, tcmSp.id, exoSp.id, manageRole.id, existing),
    await ensureDirectoryRole(token, tcmSp.id, SECURITY_READER_ROLE_TEMPLATE)
  ];
  return states.includes("fixed") ? "fixed" : "ok";
}

/**
 * Legt die App-Registrierung an (idempotent): Exchange.ManageAsApp (app-only EXO),
 * Graph-Permissions fuer die OIB-Zuweisung, Entra-Rollen + Zertifikat.
 */
async function provisionAppReg(token) {
  const { exoSp, manageRole, graphSp, graphRoles, graphRolesMaester, spoSp, spoRolesMaester } = await resolvePermissionTargets(token);
  const allGraphRoles = [...graphRoles, ...graphRolesMaester];
  const requiredResourceAccess = [
    { resourceAppId: EXO_APP_ID, resourceAccess: [{ id: manageRole.id, type: "Role" }] },
    { resourceAppId: GRAPH_APP_ID, resourceAccess: allGraphRoles.map(r => ({ id: r.id, type: "Role" })) }
  ];
  if (spoRolesMaester.length) {
    requiredResourceAccess.push({ resourceAppId: SPO_APP_ID, resourceAccess: spoRolesMaester.map(r => ({ id: r.id, type: "Role" })) });
  }

  let app = (await gReq(token, "GET", `/applications?$filter=displayName eq '${odataLit(APP_DISPLAY_NAME)}'`)).value[0];
  if (app) {
    await gReq(token, "PATCH", `/applications/${app.id}`, { requiredResourceAccess, signInAudience: "AzureADMyOrg" });
  } else {
    app = await gReq(token, "POST", "/applications", { displayName: APP_DISPLAY_NAME, signInAudience: "AzureADMyOrg", requiredResourceAccess });
  }
  let appSp = (await gReq(token, "GET", `/servicePrincipals?$filter=appId eq '${app.appId}'`)).value[0];
  if (!appSp) appSp = await gReq(token, "POST", "/servicePrincipals", { appId: app.appId });

  // Admin-Consent = App-Role-Assignments direkt setzen (idempotent).
  let consentOk = true, consentErr = null;
  try {
    const existing = (await gReq(token, "GET", `/servicePrincipals/${appSp.id}/appRoleAssignments`)).value || [];
    await ensureAppRoleAssignment(token, appSp.id, exoSp.id, manageRole.id, existing);
    for (const r of allGraphRoles) await ensureAppRoleAssignment(token, appSp.id, graphSp.id, r.id, existing);
    if (spoSp) for (const r of spoRolesMaester) await ensureAppRoleAssignment(token, appSp.id, spoSp.id, r.id, existing);
  } catch (e) { consentOk = false; consentErr = e.message; }

  // Entra-Rollen zuweisen: Exchange Administrator (Policies schreiben) und
  // Compliance Administrator (fuer einen spaeteren Windows-Worker der Alert Policy).
  let exoRole = false, exoRoleErr = null;
  try { await ensureDirectoryRole(token, appSp.id, EXCHANGE_ADMIN_ROLE_TEMPLATE); exoRole = true; } catch (e) { exoRoleErr = e.message || String(e); }
  let sccRole = false, sccRoleErr = null;
  try { await ensureDirectoryRole(token, appSp.id, COMPLIANCE_ADMIN_ROLE_TEMPLATE); sccRole = true; } catch (e) { sccRoleErr = e.message || String(e); }
  // Teams Administrator: fuer die app-only Teams-Verbindung der Maester-Tests.
  try { await ensureDirectoryRole(token, appSp.id, TEAMS_ADMIN_ROLE_TEMPLATE); } catch (e) { console.log("Teams-Admin-Rolle nicht zuweisbar: " + (e.message || e)); }

  // TCM einrichten (Alert-Policy-Pruefung im Audit) — best effort
  let tcm = false, tcmErr = null;
  try { await ensureTcmSetup(token, exoSp, manageRole); tcm = true; } catch (e) { tcmErr = e.message || String(e); }

  // Zertifikat erzeugen + hochladen (kein Client Secret — app-only EXO braucht ein Cert).
  let certThumbprint = null, certPem = null, certError = null;
  try {
    const selfsigned = require("selfsigned");
    const pems = selfsigned.generate([{ name: "commonName", value: APP_DISPLAY_NAME }], { keySize: 2048, days: 730, algorithm: "sha256" });
    const certB64 = pems.cert.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
    certThumbprint = crypto.createHash("sha1").update(Buffer.from(certB64, "base64")).digest("hex");
    await gReq(token, "PATCH", `/applications/${app.id}`, {
      keyCredentials: [{ type: "AsymmetricX509Cert", usage: "Verify", key: certB64, displayName: APP_DISPLAY_NAME + "-cert" }]
    });
    // Key UND Zertifikat speichern — X509Certificate2.CreateFromPemFile braucht beides.
    certPem = pems.private + "\n" + pems.cert;
  } catch (e) { certError = e.message; }

  return { appId: app.appId, consentOk, consentErr, exoRole, exoRoleErr, sccRole, sccRoleErr, tcm, tcmErr, certThumbprint, certPem, certError };
}

/**
 * Permission-Fixer: prueft die BESTEHENDE App-Registrierung eines Tenants und
 * repariert gezielt, was fehlt — Exchange.ManageAsApp, Service Principal,
 * Admin-Consent, beide Entra-Rollen und die Zertifikat-Hinterlegung an der App
 * (aus dem lokalen PEM, KEINE Rotation). Liefert pro Punkt ok/fixed/failed.
 */
async function repairAppReg(token, rec, opts) {
  const replaceCert = !!(opts && opts.replaceCert);
  const items = [];
  const push = (name, state, detail) => items.push({ name, state, detail: detail || "" });

  // 1. App-Registrierung ueber die bekannte Client-Id finden (praeziser als displayName)
  const app = (await gReq(token, "GET", `/applications?$filter=appId eq '${rec.clientId}'`)).value[0];
  if (!app) {
    push("App-Registrierung", "failed", "App " + rec.clientId + " nicht gefunden — Tenant neu onboarden.");
    return { items, exoRole: false, sccRole: false };
  }
  push("App-Registrierung", "ok", app.displayName);

  // 2. API-Permissions: Exchange.ManageAsApp + Graph-Rollen (OIB + Maester) im Manifest
  const { exoSp, manageRole, graphSp, graphRoles, graphRolesMaester, spoSp, spoRolesMaester } = await resolvePermissionTargets(token);
  const allGraphRoles = [...graphRoles, ...graphRolesMaester];
  try {
    const rra = Array.isArray(app.requiredResourceAccess) ? app.requiredResourceAccess : [];
    let changed = false;
    const ensureEntry = (resourceAppId, roleIds) => {
      let entry = rra.find(r => r.resourceAppId === resourceAppId);
      if (!entry) { entry = { resourceAppId, resourceAccess: [] }; rra.push(entry); }
      for (const id of roleIds) {
        if (!(entry.resourceAccess || []).some(a => a.id === id)) {
          entry.resourceAccess = [...(entry.resourceAccess || []), { id, type: "Role" }];
          changed = true;
        }
      }
    };
    ensureEntry(EXO_APP_ID, [manageRole.id]);
    ensureEntry(GRAPH_APP_ID, allGraphRoles.map(r => r.id));
    if (spoRolesMaester.length) ensureEntry(SPO_APP_ID, spoRolesMaester.map(r => r.id));
    if (changed) {
      await gReq(token, "PATCH", `/applications/${app.id}`, { requiredResourceAccess: rra });
      push("API-Permissions (EXO + Graph)", "fixed");
    } else {
      push("API-Permissions (EXO + Graph)", "ok");
    }
  } catch (e) { push("API-Permissions (EXO + Graph)", "failed", e.message); }

  // 3. Service Principal
  let appSp = null;
  try {
    appSp = (await gReq(token, "GET", `/servicePrincipals?$filter=appId eq '${app.appId}'`)).value[0];
    if (appSp) push("Service Principal", "ok");
    else { appSp = await gReq(token, "POST", "/servicePrincipals", { appId: app.appId }); push("Service Principal", "fixed"); }
  } catch (e) { push("Service Principal", "failed", e.message); }

  // 4. Admin-Consent (App-Role-Assignments fuer EXO + Graph)
  if (appSp) {
    try {
      const existing = (await gReq(token, "GET", `/servicePrincipals/${appSp.id}/appRoleAssignments`)).value || [];
      const states = [await ensureAppRoleAssignment(token, appSp.id, exoSp.id, manageRole.id, existing)];
      for (const r of allGraphRoles) states.push(await ensureAppRoleAssignment(token, appSp.id, graphSp.id, r.id, existing));
      if (spoSp) for (const r of spoRolesMaester) states.push(await ensureAppRoleAssignment(token, appSp.id, spoSp.id, r.id, existing));
      push("Admin-Consent (EXO + Graph + SharePoint)", states.includes("fixed") ? "fixed" : "ok");
    } catch (e) { push("Admin-Consent (EXO + Graph)", "failed", e.message); }
  }

  // 5./6. Entra-Rollen
  let exoRole = false, sccRole = false, tcm = false;
  if (appSp) {
    try { push("Exchange-Administrator-Rolle", await ensureDirectoryRole(token, appSp.id, EXCHANGE_ADMIN_ROLE_TEMPLATE)); exoRole = true; }
    catch (e) { push("Exchange-Administrator-Rolle", "failed", e.message); }
    try { push("Compliance-Administrator-Rolle", await ensureDirectoryRole(token, appSp.id, COMPLIANCE_ADMIN_ROLE_TEMPLATE)); sccRole = true; }
    catch (e) { push("Compliance-Administrator-Rolle", "failed", e.message); }
    try { push("Teams-Administrator-Rolle (Maester)", await ensureDirectoryRole(token, appSp.id, TEAMS_ADMIN_ROLE_TEMPLATE)); }
    catch (e) { push("Teams-Administrator-Rolle (Maester)", "failed", e.message); }
  }

  // 6b. TCM-Einrichtung (Alert-Policy-Pruefung im Audit)
  try { push("TCM-Einrichtung (Alert-Policy-Prüfung)", await ensureTcmSetup(token, exoSp, manageRole)); tcm = true; }
  catch (e) { push("TCM-Einrichtung (Alert-Policy-Prüfung)", "failed", e.message); }

  // 7. Zertifikat: KEINE Rotation — nur pruefen und ggf. den Public Key aus dem
  //    lokalen PEM wieder an der App hinterlegen (falls dort entfernt).
  try {
    const localPem = fs.existsSync(certPemPath(rec.tenantId)) ? fs.readFileSync(certPemPath(rec.tenantId), "utf8") : null;
    const m = localPem && localPem.match(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/);
    const registered = Array.isArray(app.keyCredentials) ? app.keyCredentials : [];

    if (!localPem) {
      push("Zertifikat", "failed", "Kein lokales Zertifikat im Backend — Tenant neu onboarden (erzeugt ein neues).");
    } else if (!m) {
      push("Zertifikat", "failed", "Lokales PEM enthaelt kein Zertifikat — Tenant neu onboarden.");
    } else {
      // Es reicht NICHT zu pruefen, ob ueberhaupt Schluessel an der App haengen:
      // liegt dort ein anderes Zertifikat, meldet Azure beim Token-Holen
      // AADSTS700027 ("key was not found"), waehrend die Pruefung "ok" sagt.
      // Deshalb Thumbprint-Vergleich. customKeyIdentifier ist der SHA1-
      // Thumbprint base64-kodiert.
      const certB64 = m[1].replace(/\s+/g, "");
      const localThumb = crypto.createHash("sha1").update(Buffer.from(certB64, "base64")).digest("hex").toUpperCase();
      const thumbs = registered
        .map(k => (k.customKeyIdentifier ? Buffer.from(k.customKeyIdentifier, "base64").toString("hex").toUpperCase() : null))
        .filter(Boolean);

      if (thumbs.includes(localThumb)) {
        push("Zertifikat", "ok", "lokal + an der App hinterlegt (Thumbprint " + localThumb.slice(0, 8) + "…)");
      } else if (registered.length === 0) {
        await gReq(token, "PATCH", `/applications/${app.id}`, {
          keyCredentials: [{ type: "AsymmetricX509Cert", usage: "Verify", key: certB64, displayName: APP_DISPLAY_NAME + "-cert" }]
        });
        push("Zertifikat", "fixed", "Public Key aus lokalem PEM an der App hinterlegt");
      } else if (!replaceCert) {
        // Fremde Schluessel NICHT stillschweigend wegwerfen: Graph liefert den
        // oeffentlichen Teil bestehender keyCredentials beim GET nicht mit,
        // ein PATCH ersetzt die Liste also zwangslaeufig komplett. Wer sonst
        // noch mit dieser App-Registrierung arbeitet, verliert dabei den
        // Zugriff — das muss eine bewusste Entscheidung sein.
        const others = registered
          .map(k => `${k.displayName || "ohne Namen"} (${k.customKeyIdentifier ? Buffer.from(k.customKeyIdentifier, "base64").toString("hex").toUpperCase().slice(0, 8) + "…" : "?"}${k.endDateTime ? ", gültig bis " + String(k.endDateTime).slice(0, 10) : ""})`)
          .join(", ");
        push("Zertifikat", "mismatch",
          `An der App hängen ${registered.length} Zertifikat(e), aber nicht unseres (lokal: ${localThumb.slice(0, 8)}…). ` +
          `Vorhanden: ${others}. Deshalb schlägt die Anmeldung mit AADSTS700027 fehl. ` +
          `Ersetzen ist möglich, entfernt aber die vorhandenen Zertifikate von dieser App-Registrierung.`);
      } else {
        await gReq(token, "PATCH", `/applications/${app.id}`, {
          keyCredentials: [{ type: "AsymmetricX509Cert", usage: "Verify", key: certB64, displayName: APP_DISPLAY_NAME + "-cert" }]
        });
        push("Zertifikat", "fixed",
          `Zertifikate an der App durch das lokale ersetzt (${registered.length} vorheriges/vorherige entfernt, neu: ${localThumb.slice(0, 8)}…)`);
      }
    }
  } catch (e) { push("Zertifikat", "failed", e.message); }

  return { items, exoRole, sccRole, tcm };
}

// ---------- App ----------
const state = ensureAdmin(loadState());
const app = express();
app.use(express.json({ limit: "512kb" }));
if (process.env.TRUST_PROXY !== "0") app.set("trust proxy", 1);
app.use(session({
  secret: state.sessionSecret,
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: "auto", maxAge: 8 * 3600 * 1000 }
}));

function causeOf(e) {
  const c = e && e.cause;
  if (!c) return null;
  const parts = [c.code, c.message].filter(Boolean);
  return parts.length ? parts.join(" ") : null;
}

function wrap(fn) {
  return (req, res) => fn(req, res).catch(e => {
    // "fetch failed" allein ist wertlos — bei Netzfehlern steckt der Grund
    // (ENOTFOUND, ECONNREFUSED, ETIMEDOUT, Zertifikat) in e.cause.
    const cause = causeOf(e);
    const raw = cause ? `${e.message} (${cause})` : e.message;

    // Fehler der Intune-Dienste reicht Graph als JSON-Block durch
    // ({_version, Message, Url, HttpHeaders, ...}). Das gehoert zentral
    // aufbereitet und nicht in einzelnen Endpunkten -- sonst rutscht der
    // Rohtext ueberall dort durch, wo niemand daran gedacht hat.
    const human = humanizeGraphError(raw);

    // Vollstaendige Meldung ins Log, lesbare Fassung ins Frontend.
    console.error(`${req.method} ${req.originalUrl} -> ${e.status || 500}: ${raw}`);
    res.status(e.status || 500).json({
      error: human.text,
      detail: human.detail || e.hint || null
    });
  });
}

// pwsh-Verfuegbarkeit einmal beim Start pruefen (fuer /api/health).
let pwshInfo = { checked: false, ok: false, version: null };
(function checkPwsh() {
  try {
    const ps = spawn(process.env.PWSH_PATH || "pwsh", ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"]);
    let out = "";
    ps.stdout.on("data", d => out += d.toString());
    ps.on("close", code => { pwshInfo = { checked: true, ok: code === 0, version: out.trim() || null }; });
    ps.on("error", () => { pwshInfo = { checked: true, ok: false, version: null }; });
  } catch (e) { pwshInfo = { checked: true, ok: false, version: null }; }
})();

// Tickets-Tab (SDP-Ticket-Copilot) bleibt auf einen einzelnen SSO-Nutzer
// beschraenkt -- der lokale Admin-Login zaehlt ebenfalls, da er kein
// personenbezogenes Konto ist, sondern das gemeinsame Live-Deploy-Login.
const TICKETS_ALLOWED_UPN = "nils.lappenbusch@igeeks.ch";
function isTicketsAllowed(req) {
  const u = req.session && req.session.user;
  if (!u) return false;
  if (u.startsWith("sso:")) return u.slice(4).toLowerCase() === TICKETS_ALLOWED_UPN;
  return true;
}

app.get("/api/health", (req, res) => res.json({ ok: true, pwsh: pwshInfo, loggedIn: !!(req.session && req.session.user), ticketsAllowed: isTicketsAllowed(req) }));

// Brute-Force-Schutz fuer den lokalen Admin-Login (kein SSO/MFA-Schutz wie beim
// iGeeks-SSO-Pfad) -- pro IP max. 5 Fehlversuche innerhalb von 15 Minuten, danach
// 429 bis das Fenster abgelaufen ist. Bewusst kein neues Package (express-rate-limit)
// fuer diesen einen Endpunkt, analog zum Rest des Projekts (minimale Abhaengigkeiten).
const LOGIN_RATE_LIMIT = { max: 5, windowMs: 15 * 60 * 1000 };
const loginAttempts = new Map(); // ip -> { count, resetAt }
function checkLoginRateLimit(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now >= entry.resetAt) return { blocked: false };
  return { blocked: entry.count >= LOGIN_RATE_LIMIT.max, retryAfterMs: entry.resetAt - now };
}
function registerLoginFailure(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now >= entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_RATE_LIMIT.windowMs });
  } else {
    entry.count++;
  }
}
function clearLoginFailures(ip) { loginAttempts.delete(ip); }

app.post("/api/login", (req, res) => {
  const ip = req.ip;
  const limit = checkLoginRateLimit(ip);
  if (limit.blocked) {
    return res.status(429).json({ error: `Zu viele Fehlversuche -- bitte in ${Math.ceil(limit.retryAfterMs / 60000)} Minute(n) erneut versuchen.` });
  }

  const s = loadState();
  const { username, password } = req.body || {};
  if (s.auth && (username || "admin") === s.auth.username) {
    const a = Buffer.from(hashPw(password || "", s.auth.salt), "hex");
    const b = Buffer.from(s.auth.passwordHash, "hex");
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      clearLoginFailures(ip);
      req.session.user = s.auth.username;
      return res.json({ ok: true });
    }
  }
  registerLoginFailure(ip);
  res.status(401).json({ error: "Login fehlgeschlagen" });
});
app.post("/api/logout", (req, res) => req.session.destroy(() => res.json({ ok: true })));

// ---------- SSO ueber iGeeks-Tenant (vor dem Auth-Guard: Login-Flow ist public) ----------
// Login-Screen muss VOR der Anmeldung wissen, ob SSO verfuegbar ist — keine Secrets in der Antwort.
app.get("/api/sso/config", (req, res) => {
  const s = loadState();
  res.json({ ok: true, enabled: SSO.isConfigured(s.sso), redirectUri: SSO.redirectUri(req) });
});

app.get("/api/auth/sso/start", (req, res) => {
  const s = loadState();
  if (!SSO.isConfigured(s.sso)) return res.redirect("/?ssoError=" + encodeURIComponent("SSO ist nicht konfiguriert."));
  res.redirect(SSO.buildAuthorizeUrl(req, s.sso));
});

app.get("/api/auth/sso/callback", wrap(async (req, res) => {
  const s = loadState();
  if (!SSO.isConfigured(s.sso)) return res.redirect("/?ssoError=" + encodeURIComponent("SSO ist nicht konfiguriert."));
  try {
    const who = await SSO.handleCallback(req, s.sso);
    req.session.user = "sso:" + who.upn;
    req.session.ssoName = who.name;
    res.redirect("/");
  } catch (e) {
    res.redirect("/?ssoError=" + encodeURIComponent(e.message));
  }
}));

// Auth-Guard fuer alles Weitere -- /api/mcp/v1 ausgenommen: das ist der
// API-Key-authentifizierte Endpunkt fuer externe MCP-Clients (kein Session-
// Cookie), eigene Pruefung via requireMcpApiKey weiter unten.
app.use("/api", (req, res, next) => {
  if (req.path.startsWith("/mcp/v1/")) return next();
  if (req.session && req.session.user) return next();
  res.status(401).json({ error: "Nicht angemeldet" });
});

// Tickets-Bereich (SDP-Ticket-Copilot + Runbooks) zusaetzlich auf
// TICKETS_ALLOWED_UPN + lokalen Login beschraenkt.
app.use(["/api/sdp", "/api/runbooks"], (req, res, next) => {
  if (isTicketsAllowed(req)) return next();
  res.status(403).json({ error: "Kein Zugriff auf den Tickets-Bereich." });
});

// Server-Log der laufenden Instanz (letzte Zeilen, Geheimnisse maskiert).
// Ersetzt "docker logs" bzw. "kubectl logs" fuer die schnelle Fehlersuche.
app.get("/api/serverlog", (req, res) => {
  res.json({ ok: true, max: SERVERLOG.MAX_ENTRIES, entries: SERVERLOG.list(req.query.limit) });
});

// Erreichbarkeitstest der Gegenstellen, die das Tool zwingend braucht.
// Beantwortet die Frage "kommt der Container ueberhaupt raus?" ohne Shell im
// Pod — im Cluster ist fehlender Egress die haeufigste Ursache fuer 500er
// beim Onboarding (Device-Code-Start laeuft gegen login.microsoftonline.com).
const EGRESS_TARGETS = [
  { name: "Microsoft Login (Device-Code)", url: "https://login.microsoftonline.com/common/discovery/instance?api-version=1.1&authorization_endpoint=https%3A%2F%2Flogin.microsoftonline.com%2Fcommon%2Foauth2%2Fv2.0%2Fauthorize" },
  { name: "Microsoft Graph", url: "https://graph.microsoft.com/v1.0/$metadata" },
  { name: "Exchange Online", url: "https://outlook.office365.com/powershell-liveid" }
];

app.get("/api/diag/egress", wrap(async (req, res) => {
  const results = [];
  for (const t of EGRESS_TARGETS) {
    const started = Date.now();
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8000);
      const r = await fetch(t.url, { method: "GET", signal: ctl.signal });
      clearTimeout(timer);
      results.push({ name: t.name, ok: true, status: r.status, ms: Date.now() - started });
    } catch (e) {
      results.push({
        name: t.name, ok: false, ms: Date.now() - started,
        error: e.name === "AbortError" ? "Zeitueberschreitung nach 8s" : e.message,
        code: causeOf(e)
      });
    }
  }
  res.json({ ok: true, results });
}));

// SSO-Konfiguration schreiben/loeschen — nur fuer bereits angemeldete Admins.
app.post("/api/sso/config", (req, res) => {
  const b = req.body || {};
  const tenantId = String(b.tenantId || "").trim();
  const clientId = String(b.clientId || "").trim();
  const clientSecret = String(b.clientSecret || "").trim();
  if (!tenantId || !clientId || !clientSecret) return res.status(400).json({ error: "tenantId, clientId und clientSecret sind erforderlich." });
  const s = loadState();
  s.sso = { tenantId, clientId, clientSecret };
  saveState(s);
  res.json({ ok: true });
});

app.delete("/api/sso/config", (req, res) => {
  const s = loadState();
  delete s.sso;
  saveState(s);
  res.json({ ok: true });
});

// ---------- Agent-Downloads (Bitdefender / N-sight RMM) ----------
// Die API-Keys bleiben hier im Backend; das Frontend laedt ueber diesen Proxy.

app.get("/api/downloads/config", (req, res) => {
  const bd = BD.config();
  const rmm = NSIGHT.config();
  if (process.env.FAKE_DEPLOY === "1") return res.json({ ok: true, bd: true, rmm: true, bdHost: bd.host, rmmServer: "fake.systemmonitor.eu.com" });
  res.json({ ok: true, bd: bd.enabled, rmm: rmm.enabled, bdHost: bd.host, rmmServer: rmm.fixed || null });
});

app.get("/api/downloads/bd/packages", wrap(async (req, res) => {
  if (process.env.FAKE_DEPLOY === "1") {
    return res.json({ ok: true, packages: [
      { packageName: "Bitdefender Endpoint Security (Standard)", installLinkWindows: "https://cloudgz.gravityzone.bitdefender.com/fake-installer.exe", fullKitWindowsX64: "https://cloudgz.gravityzone.bitdefender.com/fake-full-x64.exe" }
    ] });
  }
  res.json({ ok: true, packages: await BD.listPackages() });
}));

app.get("/api/downloads/bd/download", wrap(async (req, res) => {
  const u = String(req.query.u || "").trim();
  if (!u) throw Object.assign(new Error("Keine URL."), { status: 400 });
  await BD.streamDownload(u, res);
}));

app.get("/api/downloads/rmm/clients", wrap(async (req, res) => {
  res.json({ ok: true, ...(await NSIGHT.listClients()) });
}));

app.get("/api/downloads/rmm/sites", wrap(async (req, res) => {
  res.json({ ok: true, ...(await NSIGHT.listSites(String(req.query.clientid || "").trim())) });
}));

app.get("/api/downloads/rmm/download", wrap(async (req, res) => {
  await NSIGHT.downloadAgent({
    endcustomerid: String(req.query.endcustomerid || "").trim(),
    siteid: String(req.query.siteid || "").trim(),
    type: String(req.query.type || "").trim(),
    os: String(req.query.os || "").trim()
  }, res);
}));

// ---------- SDP-Ticket-Copilot (ServiceDesk Plus lesen) ----------
// Tickets sind kein M365-Tenant-Konzept -- eigener Namespace, kein requireTenant.

function fakeSdpTicket(id) {
  return {
    id: String(id), subject: `Beispiel-Ticket ${id} (FAKE_DEPLOY)`, status: "Offen", priority: "Mittel",
    requester: "Max Muster", technician: "Nils Lappenbusch", category: "Netzwerk",
    createdTime: "23.07.2026 08:00", dueTime: "24.07.2026 17:00",
    description: "Beispieltext -- FAKE_DEPLOY-Fixture, keine echten SDP-Daten.",
    hasAttachments: true, attachments: [{ id: "9001", name: "screenshot.png", size: 12345, contentType: "image/png" }],
    notes: [{ id: "2", createdBy: "Nils Lappenbusch", createdTime: "23.07.2026 09:00", description: "Rueckruf vereinbart.", showToRequester: true }],
    notesError: null,
    tasks: [{ id: "1", bookingTarget: `T:${id}-1`, title: "Vor-Ort-Termin", status: "Offen" }],
    tasksError: null
  };
}

app.get("/api/sdp/tickets/:id", wrap(async (req, res) => {
  if (process.env.FAKE_DEPLOY === "1") return res.json({ ok: true, ticket: fakeSdpTicket(req.params.id) });
  res.json({ ok: true, ticket: await SDP.getTicketFull(req.params.id) });
}));

app.post("/api/sdp/tickets/batch", wrap(async (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(x => String(x || "").trim()).filter(Boolean) : [];
  if (!ids.length) throw Object.assign(new Error("Keine Ticket-IDs angegeben."), { status: 400 });
  if (ids.length > 25) throw Object.assign(new Error("Maximal 25 Tickets pro Batch."), { status: 400 });

  const results = await Promise.allSettled(ids.map(id =>
    process.env.FAKE_DEPLOY === "1" ? Promise.resolve(fakeSdpTicket(id)) : SDP.getTicketFull(id)
  ));
  res.json({
    ok: true,
    tickets: results.map((r, i) => r.status === "fulfilled"
      ? { id: ids[i], ok: true, ticket: r.value }
      : { id: ids[i], ok: false, error: r.reason.message })
  });
}));

app.get("/api/sdp/tickets/:id/attachments/:attachmentId", wrap(async (req, res) => {
  if (process.env.FAKE_DEPLOY === "1") {
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Disposition", 'attachment; filename="screenshot.png"');
    return res.send(Buffer.from("Fake-Anhang-Bytes -- kein echter SDP-Download."));
  }
  const { buffer, contentType } = await SDP.downloadAttachment(req.params.id, req.params.attachmentId);
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", `attachment; filename="anhang-${encodeURIComponent(req.params.attachmentId)}"`);
  res.send(buffer);
}));

// Tenant per ID nachschlagen, ohne ueber /api/tenants/:id zu gehen (der Aufrufer
// hier ist ein Ticket, kein Tenant-Tab) -- bewusst schlank gehalten statt einer
// eigenen Lib, wird beim Bau des Tenant-MCP-Servers (Phase 3) ohnehin dorthin
// extrahiert.
function loadTenantById(id) {
  const s = loadState();
  const t = (s.tenants || []).find(x => x.id === id);
  if (!t) throw Object.assign(new Error("Tenant nicht gefunden."), { status: 404 });
  if (!fs.existsSync(certPemPath(t.tenantId))) throw Object.assign(new Error("Kein Zertifikat fuer diesen Tenant hinterlegt."), { status: 412 });
  return t;
}

// KI-Runbooks: jeder AI-Vorschlag, der gegen einen konkreten Tenant geprueft
// wurde, wird automatisch als wiederfindbarer Eintrag gespeichert -- Grundlage
// fuer spaetere Wiedererkennung ("das hatten wir schon") und fuer den
// Tenant-MCP-Server (Phase 6), der "automatable"-markierte Runbooks als
// Kandidaten fuer echte Automatisierungen aufgreifen kann. Ohne Tenant-Auswahl
// (rein textbasierte Analyse) wird bewusst NICHT gespeichert -- ohne
// Live-Abgleich ist die Aussage zu unsicher, um als Runbook zu taugen.
function saveRunbookEntry({ ticketId, ticketSubject, tenantId, tenantName, suggestion, autoPreview }) {
  const s = loadState();
  const entry = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    ticketId, ticketSubject, tenantId, tenantName, suggestion,
    autoPreview: autoPreview || null
  };
  s.runbooks = s.runbooks || [];
  s.runbooks.unshift(entry);
  saveState(s);
  return entry;
}

// Automatisch AUFLOESEN (Suchbegriff -> gefundene Einstellung + Wert), aber
// NIE automatisch SCHREIBEN -- der eigentliche Deploy (POST .../deploy/
// auto-setting) bleibt immer ein separater, expliziter Klick. Das hier ist
// reiner Lesezugriff (previewSetting), macht also nichts im Tenant kaputt,
// selbst wenn die KI sich irrt. Ergebnis wird im Runbook gespeichert, damit
// die UI direkt einen "Bestaetigen"-Knopf mit vorausgefuellten Werten zeigen
// kann, statt dass der Mensch Suchbegriff/Wert/Gruppe nochmal eintippen muss.
async function attemptAutoPreview(t, cert, suggestion) {
  if (!t.aiWritePermissions || !t.aiWritePermissions.autoApplyPolicies) return null;
  if (!t.aiAutoDeployGroupId) return { ok: false, error: "Keine Pilot-Gruppe fuer autonome Vorschlaege hinterlegt (Tenants-Tab)." };
  if (!suggestion.automatable || !suggestion.automationSearchTerm || !suggestion.automationDesiredValue) return null;

  try {
    const preview = await SETTINGSCATALOG.previewSetting(t, cert, suggestion.automationSearchTerm, suggestion.automationDesiredValue);
    return { ok: true, preview, groupId: t.aiAutoDeployGroupId };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

app.post("/api/sdp/tickets/:id/ai-suggest", wrap(async (req, res) => {
  const tenantId = String((req.body || {}).tenantId || "").trim();

  if (process.env.FAKE_DEPLOY === "1") {
    const t = tenantId ? (loadState().tenants || []).find(x => x.id === tenantId) : null;
    const suggestion = {
      rootCause: "FAKE_DEPLOY-Beispiel: Edge-Passwort-Manager soll unternehmensweit deaktiviert werden.",
      assumptions: [{ claim: "Bitwarden-Extension ist bereits ausgerollt", verdict: t ? "bestaetigt" : "unklar",
        reasoning: t ? `Gegen Tenant „${t.name}" geprueft (Fixture-Daten).` : "Kein Tenant ausgewaehlt." }],
      steps: [
        "Policy 'Password manager' (Microsoft Edge) auf 'Disabled' setzen",
        "Zunaechst nur auf Pilot-Gruppe anwenden, dann UAT, dann volle Nutzerbasis (Ring-Konzept)",
        "Rueckmeldung an Requester nach erfolgreicher Pilotphase"
      ],
      automatable: true,
      automatableReason: "Einzelne ADMX-basierte Edge-Einstellung mit Enabled/Disabled-Wert -- unser Tool kann das live per Suchbegriff finden und pilotiert ausrollen.",
      automationSearchTerm: "Password manager",
      automationDesiredValue: "Disabled"
    };
    let autoPreview = null;
    if (t && t.aiWritePermissions && t.aiWritePermissions.autoApplyPolicies) {
      autoPreview = t.aiAutoDeployGroupId
        ? { ok: true, groupId: t.aiAutoDeployGroupId, preview: {
            settingId: "fake-setting-id",
            settingDisplayName: `Enable saving passwords to the password manager (${suggestion.automationSearchTerm})`,
            settingDescription: "Fake-Beschreibung (FAKE_DEPLOY).",
            resolvedOptionId: "fake-option-id", resolvedOptionLabel: suggestion.automationDesiredValue
          } }
        : { ok: false, error: "Keine Pilot-Gruppe fuer autonome Vorschlaege hinterlegt (Tenants-Tab)." };
    }
    const runbook = t ? saveRunbookEntry({ ticketId: req.params.id, ticketSubject: `Beispiel-Ticket ${req.params.id} (FAKE_DEPLOY)`, tenantId, tenantName: t.name, suggestion, autoPreview }) : null;
    return res.json({ ok: true, suggestion, runbookId: runbook ? runbook.id : null, autoPreview });
  }

  const ticket = await SDP.getTicketFull(req.params.id);

  let tenantContext = null, tenantName = null, tenantForDeploy = null, certForDeploy = null;
  if (tenantId) {
    const t = loadTenantById(tenantId);
    tenantForDeploy = t;
    tenantName = t.name;
    const cert = certPemPath(t.tenantId);
    certForDeploy = cert;
    const [licenses, caPoliciesRaw] = await Promise.all([
      LICENSES.runLicenseReport(t, cert).catch(() => null),
      CONDACCESS.listManagedPolicies(t, cert).catch(() => [])
    ]);
    tenantContext = {
      tenantName: t.name,
      licenses,
      caPolicies: (caPoliciesRaw || []).map(p => ({ displayName: p.displayName, state: p.state }))
    };
  }

  const suggestion = await AISUGGEST.suggestResolution({ ticket, tenantContext });
  const autoPreview = tenantForDeploy ? await attemptAutoPreview(tenantForDeploy, certForDeploy, suggestion) : null;
  const runbook = tenantId
    ? saveRunbookEntry({ ticketId: req.params.id, ticketSubject: ticket.subject, tenantId, tenantName, suggestion, autoPreview })
    : null;
  res.json({ ok: true, suggestion, runbookId: runbook ? runbook.id : null, autoPreview });
}));

// Maester-Finding als SDP-Ticket anlegen. Liegt unter /api/sdp und ist damit
// automatisch auf den Tickets-Nutzer beschraenkt (Middleware oben). Nutzt die
// deutsche KI-Erklaerung des Laufs, falls vorhanden — sonst die englischen
// Detailtexte aus results.json.
app.post("/api/sdp/maester-task", wrap(async (req, res) => {
  const { tenantId, runId, findingId } = req.body || {};
  const s = loadState();
  const t = (s.tenants || []).find(x => x.id === String(tenantId || ""));
  if (!t) return res.status(404).json({ error: "Tenant nicht gefunden" });
  const failed = maesterRunFailedDetails(t.id, String(runId || "")) || [];
  const f = failed.find(x => x.id === String(findingId || ""));
  if (!f) return res.status(404).json({ error: "Finding nicht (mehr) im Lauf gefunden." });
  const ex = (loadMaesterExplain(t.id, String(runId)) || []).find(x => x.id === f.id) || null;

  const esc = (x) => String(x == null ? "" : x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const subject = `[Security-Audit ${t.name}] ${(ex && ex.titel) || f.title || f.id}`.slice(0, 240);
  const description =
    `<b>Maester-Finding aus dem Security-Audit</b><br>` +
    `Tenant: ${esc(t.name)}<br>Test: ${esc(f.id)} — ${esc(f.title)}<br>` +
    `Schweregrad: ${esc(f.severity || "—")} · Bereich: ${esc(f.block || "—")}<br><br>` +
    (ex
      ? `<b>Bedeutung:</b><br>${esc(ex.bedeutung)}<br><br><b>Umsetzung:</b><ol>` +
        (ex.umsetzung || []).map(step => `<li>${esc(step)}</li>`).join("") + `</ol>` +
        (ex.aufwand ? `Gesch&auml;tzter Aufwand: ${esc(ex.aufwand)}<br>` : "")
      : `${esc(f.description)}<br><br><b>Befund:</b><br>${esc(f.result)}<br>`) +
    (f.helpUrl ? `<br>Referenz: <a href="${esc(f.helpUrl)}">${esc(f.helpUrl)}</a>` : "");

  const ticket = await SDP.createRequest({ subject, description });
  console.log(`Maester-Finding als SDP-Ticket angelegt: #${ticket.id} (${t.name}, ${f.id})`);
  res.json({ ok: true, ticket });
}));

app.get("/api/runbooks", (req, res) => {
  const s = loadState();
  const tenantId = String(req.query.tenantId || "").trim();
  let list = s.runbooks || [];
  if (tenantId) list = list.filter(r => r.tenantId === tenantId);
  res.json({ ok: true, runbooks: list });
});

app.delete("/api/runbooks/:id", (req, res) => {
  const s = loadState();
  const list = (s.runbooks || []).filter(r => r.id !== req.params.id);
  s.runbooks = list;
  saveState(s);
  res.json({ ok: true });
});

// ---------- Tenants ----------
app.get("/api/tenants", (req, res) => {
  const s = loadState();
  res.json((s.tenants || []).map(t => ({
    id: t.id, name: t.name, tenantId: t.tenantId, organization: t.organization,
    appId: t.clientId, exoRole: !!t.exoRole, sccRole: !!t.sccRole, tcm: !!t.tcm, addedAt: t.addedAt,
    certPresent: fs.existsSync(certPemPath(t.tenantId)),
    onboardingSteps: t.onboardingSteps || {},
    // Nur ob und wann eine Vorlage hinterlegt ist — der Inhalt kommt ueber
    // /api/tenants/:id/config, damit die Liste schlank bleibt.
    hasConfig: !!t.config,
    configSavedAt: t.configSavedAt || null,
    aiWritePermissions: t.aiWritePermissions || {},
    aiAutoDeployGroupId: t.aiAutoDeployGroupId || null,
    mcpPermissions: t.mcpPermissions || {}
  })));
});

// Pilot-Gruppe fuer autonome KI-Rollouts festlegen. Bewusst ein separates,
// von Nils manuell gewaehltes Ziel statt dass die KI sich selbst eine Gruppe
// aussucht (Namens-Matching waere zu riskant -- eine falsch getroffene Gruppe
// koennte sehr viel breiter treffen als beabsichtigt). Ohne gesetzte Gruppe
// kann autoApplyPolicies nichts bewirken, siehe ai-suggest-Handler unten.
app.post("/api/tenants/:id/ai-auto-deploy-group", (req, res) => {
  const s = loadState();
  const t = (s.tenants || []).find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "Tenant nicht gefunden" });
  const groupId = String((req.body || {}).groupId || "").trim();
  t.aiAutoDeployGroupId = groupId || null;
  saveState(s);
  res.json({ ok: true, aiAutoDeployGroupId: t.aiAutoDeployGroupId });
});

// KI-Schreibrechte pro Tenant: definiert, welche automatisierten Schreib-
// Aktionen (aktuell: eigene Settings-Catalog-Policy importieren+zuweisen)
// fuer diesen Tenant ueberhaupt ausgefuehrt werden duerfen. Defaultet IMMER
// auf AUS (Feld fehlt/false) -- muss pro Tenant explizit im Tenants-Tab
// freigeschaltet werden, exakt wie die ASF-Legacy-Filter und das
// CA-Break-Glass-Gate in diesem Tool.
app.post("/api/tenants/:id/ai-write-permissions", (req, res) => {
  const s = loadState();
  const t = (s.tenants || []).find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "Tenant nicht gefunden" });
  const key = String((req.body || {}).key || "").trim();
  if (!key) return res.status(400).json({ error: "key fehlt" });
  const enabled = !!(req.body && req.body.enabled);
  t.aiWritePermissions = { ...(t.aiWritePermissions || {}), [key]: enabled };
  saveState(s);
  res.json({ ok: true, aiWritePermissions: t.aiWritePermissions });
});

// Eigene Settings-Catalog-Policy (z.B. eine aus einem KI-Runbook abgeleitete,
// von Nils einmalig manuell im Intune-Portal angelegte + wieder exportierte
// Policy) importieren + einer Pilot-/Test-Gruppe zuweisen. Schreibt echt in
// den Tenant -- deshalb hart am Permission-Schalter oben vorbei: ohne
// explizite Freigabe fuer DIESEN Tenant immer 403, nie stillschweigend erlaubt.
app.post("/api/tenants/:id/deploy/custom-policy", wrap(async (req, res) => {
  const t = requireTenant(req);
  if (!t.aiWritePermissions || !t.aiWritePermissions.customPolicyImport) {
    throw Object.assign(new Error("Fuer diesen Tenant nicht freigeschaltet — erst im Tenants-Tab unter „🤖 KI-Schreibrechte\" aktivieren."), { status: 403 });
  }
  const groupId = String((req.body || {}).groupId || "").trim();
  const policyJson = (req.body || {}).policyJson;

  if (process.env.FAKE_DEPLOY === "1") {
    CUSTOMPOLICY.validatePolicyJson(policyJson);
    if (!groupId) throw Object.assign(new Error("Keine Ziel-Gruppe angegeben."), { status: 400 });
    return res.json({ ok: true, result: { policyId: "fake-policy-id", policyName: policyJson.name || "Fake Policy", assignStatus: "assigned" } });
  }

  const cert = certPemPath(t.tenantId);
  const result = await CUSTOMPOLICY.importCustomPolicy(t, cert, policyJson, groupId);
  res.json({ ok: true, result });
}));

// Settings-Catalog-Einstellung per Suchbegriff aufloesen + anzeigen -- KEIN
// Schreibzugriff, nur Vorschau vor dem eigentlichen Ausrollen. Trotzdem hinter
// demselben Permission-Schalter, damit nicht ungefragt in der Tenant-Struktur
// gestoebert werden kann.
app.post("/api/tenants/:id/deploy/auto-setting/preview", wrap(async (req, res) => {
  const t = requireTenant(req);
  if (!t.aiWritePermissions || !t.aiWritePermissions.customPolicyImport) {
    throw Object.assign(new Error("Fuer diesen Tenant nicht freigeschaltet — erst im Tenants-Tab unter „🤖 KI-Schreibrechte\" aktivieren."), { status: 403 });
  }
  const searchTerm = String((req.body || {}).searchTerm || "").trim();
  const desiredLabel = String((req.body || {}).desiredLabel || "").trim();

  if (process.env.FAKE_DEPLOY === "1") {
    if (!searchTerm || !desiredLabel) throw Object.assign(new Error("Suchbegriff und gewuenschter Wert erforderlich."), { status: 400 });
    return res.json({ ok: true, preview: {
      settingId: "fake-setting-id", settingDisplayName: `Enable saving passwords to the password manager (${searchTerm})`,
      settingDescription: "Fake-Beschreibung (FAKE_DEPLOY).", resolvedOptionId: "fake-option-id", resolvedOptionLabel: desiredLabel
    } });
  }

  const cert = certPemPath(t.tenantId);
  const preview = await SETTINGSCATALOG.previewSetting(t, cert, searchTerm, desiredLabel);
  res.json({ ok: true, preview });
}));

app.post("/api/tenants/:id/deploy/auto-setting", wrap(async (req, res) => {
  const t = requireTenant(req);
  if (!t.aiWritePermissions || !t.aiWritePermissions.customPolicyImport) {
    throw Object.assign(new Error("Fuer diesen Tenant nicht freigeschaltet — erst im Tenants-Tab unter „🤖 KI-Schreibrechte\" aktivieren."), { status: 403 });
  }
  const { name, searchTerm, desiredLabel, groupId } = req.body || {};

  if (process.env.FAKE_DEPLOY === "1") {
    if (!groupId) throw Object.assign(new Error("Keine Ziel-Gruppe angegeben."), { status: 400 });
    return res.json({ ok: true, result: {
      policyId: "fake-policy-id", policyName: name || `Auto: ${searchTerm}`, assignStatus: "assigned",
      resolvedSetting: `Enable saving passwords to the password manager (${searchTerm})`, resolvedOption: desiredLabel
    } });
  }

  const cert = certPemPath(t.tenantId);
  const result = await SETTINGSCATALOG.deployAutoSetting(t, cert, { name, searchTerm, desiredLabel }, String(groupId || "").trim());
  res.json({ ok: true, result });
}));

// Direkte Nutzerkonto-Aktionen (aus einem KI-Runbook heraus) -- jede einzeln
// ueber aiWritePermissions gegatet, jede fuer sich allein aktivierbar. Nutzt
// ausschliesslich stabile, offiziell dokumentierte Graph-v1.0-Endpunkte
// (userActions.js) statt geratener Payload-Strukturen.
const USER_ACTION_DEFS = {
  "reset-mfa": { permKey: "resetMfa", label: "MFA-Methoden entfernen" },
  "reset-password": { permKey: "resetPassword", label: "Passwort zuruecksetzen" },
  "revoke-sessions": { permKey: "revokeSessions", label: "Sitzungen widerrufen" },
  "group-membership": { permKey: "groupMembership", label: "Gruppenmitgliedschaft aendern" }
};

app.post("/api/tenants/:id/user-actions/:action", wrap(async (req, res) => {
  const t = requireTenant(req);
  const def = USER_ACTION_DEFS[req.params.action];
  if (!def) throw Object.assign(new Error("Unbekannte Aktion: " + req.params.action), { status: 404 });
  if (!t.aiWritePermissions || !t.aiWritePermissions[def.permKey]) {
    throw Object.assign(new Error(`"${def.label}" ist fuer diesen Tenant nicht freigeschaltet — erst im Tenants-Tab unter „🤖 KI-Schreibrechte\" aktivieren.`), { status: 403 });
  }
  const userId = String((req.body || {}).userId || "").trim();
  if (!userId) throw Object.assign(new Error("Keine Ziel-userId angegeben."), { status: 400 });

  if (process.env.FAKE_DEPLOY === "1") {
    if (req.params.action === "reset-mfa") return res.json({ ok: true, result: { removed: [{ type: "#microsoft.graph.phoneAuthenticationMethod", displayName: "Fake-Telefon" }], skipped: [] } });
    if (req.params.action === "reset-password") return res.json({ ok: true, result: { tempPassword: "Fake-Temp-Pw!23" } });
    if (req.params.action === "revoke-sessions") return res.json({ ok: true, result: { revoked: true } });
    if (req.params.action === "group-membership") return res.json({ ok: true, result: { action: (req.body || {}).action || "add" } });
  }

  const cert = certPemPath(t.tenantId);
  let result;
  if (req.params.action === "reset-mfa") result = await USERACTIONS.resetUserMfa(t, cert, userId);
  else if (req.params.action === "reset-password") result = await USERACTIONS.resetUserPassword(t, cert, userId);
  else if (req.params.action === "revoke-sessions") result = await USERACTIONS.revokeUserSessions(t, cert, userId);
  else if (req.params.action === "group-membership") {
    const groupId = String((req.body || {}).groupId || "").trim();
    const action = String((req.body || {}).action || "").trim();
    if (!groupId) throw Object.assign(new Error("Keine Ziel-Gruppe angegeben."), { status: 400 });
    result = await USERACTIONS.changeGroupMembership(t, cert, userId, groupId, action);
  }
  res.json({ ok: true, result });
}));

// ---------- Tenant-MCP-Zugriff (externe Claude-Sessions, API-Key statt Session-Cookie) ----------
// Erlaubt lokalen MCP-Servern (z.B. aus anderen Projektordnern heraus) denselben
// Lese-/Schreibzugriff wie die Tickets-KI im Browser -- aber OHNE den
// Vorschau-+Bestaetigungsbutton-Schritt, weil es dafuer bei einem programmatischen
// Tool-Aufruf keine sinnvolle Entsprechung gibt. Das Sicherheitsnetz hier ist
// stattdessen: (a) pro Tenant UND pro Aktion einzeln freizuschalten (mcpPermissions,
// defaultet auf AUS, komplett getrennt von aiWritePermissions -- andere
// Vertrauensgrenze), (b) jede Aktion landet im Audit-Log.
function generateApiKey() { return "mcp_" + crypto.randomBytes(32).toString("base64url"); }
function hashApiKey(key) { return crypto.createHash("sha256").update(key).digest("hex"); }

function logMcpAction(entry) {
  const s = loadState();
  s.mcpAuditLog = s.mcpAuditLog || [];
  s.mcpAuditLog.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), ...entry });
  if (s.mcpAuditLog.length > 500) s.mcpAuditLog.length = 500;
  saveState(s);
}

// Session-gated: Admin-Panel verwaltet Keys + sieht das Audit-Log -- das ist
// bewusst NICHT ueber einen API-Key erreichbar (sonst koennte ein kompromittierter
// Key sich selbst neue, weitere Keys ausstellen).
app.post("/api/mcp/keys", (req, res) => {
  const s = loadState();
  const label = String((req.body || {}).label || "").trim() || "Unbenannt";
  const key = generateApiKey();
  const entry = { id: crypto.randomUUID(), label, keyHash: hashApiKey(key), createdAt: new Date().toISOString(), lastUsedAt: null };
  s.mcpApiKeys = [...(s.mcpApiKeys || []), entry];
  saveState(s);
  res.json({ ok: true, id: entry.id, label: entry.label, key }); // key nur hier, einmalig, im Klartext
});

app.get("/api/mcp/keys", (req, res) => {
  const s = loadState();
  res.json({ ok: true, keys: (s.mcpApiKeys || []).map(k => ({ id: k.id, label: k.label, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt })) });
});

app.delete("/api/mcp/keys/:id", (req, res) => {
  const s = loadState();
  s.mcpApiKeys = (s.mcpApiKeys || []).filter(k => k.id !== req.params.id);
  saveState(s);
  res.json({ ok: true });
});

app.get("/api/mcp/audit-log", (req, res) => {
  const s = loadState();
  res.json({ ok: true, log: (s.mcpAuditLog || []).slice(0, Number(req.query.limit) || 100) });
});

// Permission-Matrix pro Tenant, komplett getrennt von aiWritePermissions -- siehe
// Kommentar oben. Gleiches Muster wie /api/tenants/:id/ai-write-permissions.
app.post("/api/tenants/:id/mcp-permissions", (req, res) => {
  const s = loadState();
  const t = (s.tenants || []).find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "Tenant nicht gefunden" });
  const key = String((req.body || {}).key || "").trim();
  if (!key) return res.status(400).json({ error: "key fehlt" });
  const enabled = !!(req.body && req.body.enabled);
  t.mcpPermissions = { ...(t.mcpPermissions || {}), [key]: enabled };
  saveState(s);
  res.json({ ok: true, mcpPermissions: t.mcpPermissions });
});

// API-Key-Auth-Guard fuer den eigentlichen, maschinell aufrufbaren MCP-Endpunkt.
// Bewusst EIGENE Middleware statt der session-basierten von oben -- greift nur
// unter /api/mcp/v1, alles andere unter /api/mcp bleibt session-gated (siehe oben).
function requireMcpApiKey(req, res, next) {
  const auth = String(req.headers.authorization || "");
  const key = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!key) return res.status(401).json({ error: "Kein API-Key (Authorization: Bearer <key>)." });
  const s = loadState();
  const hash = hashApiKey(key);
  const match = (s.mcpApiKeys || []).find(k => k.keyHash === hash);
  if (!match) return res.status(401).json({ error: "Ungueltiger API-Key." });
  match.lastUsedAt = new Date().toISOString();
  saveState(s);
  req.mcpKeyId = match.id;
  req.mcpKeyLabel = match.label;
  next();
}
app.use("/api/mcp/v1", requireMcpApiKey);

function requireMcpPermission(t, permKey) {
  if (!t.mcpPermissions || !t.mcpPermissions[permKey]) {
    throw Object.assign(new Error(`MCP-Zugriff "${permKey}" ist fuer diesen Tenant nicht freigeschaltet.`), { status: 403 });
  }
}

app.get("/api/mcp/v1/tenants", (req, res) => {
  const s = loadState();
  const visible = (s.tenants || []).filter(t => t.mcpPermissions && Object.values(t.mcpPermissions).some(Boolean));
  res.json({ ok: true, tenants: visible.map(t => ({ id: t.id, name: t.name })) });
});

app.get("/api/mcp/v1/tenants/:id/licenses", wrap(async (req, res) => {
  const t = requireTenant(req);
  requireMcpPermission(t, "readLicenses");
  const report = await LICENSES.runLicenseReport(t, certPemPath(t.tenantId));
  logMcpAction({ keyId: req.mcpKeyId, keyLabel: req.mcpKeyLabel, tenantId: t.id, action: "licenses", result: "ok" });
  res.json({ ok: true, report });
}));

app.get("/api/mcp/v1/tenants/:id/ca-policies", wrap(async (req, res) => {
  const t = requireTenant(req);
  requireMcpPermission(t, "readCaPolicies");
  const policies = await CONDACCESS.listManagedPolicies(t, certPemPath(t.tenantId));
  logMcpAction({ keyId: req.mcpKeyId, keyLabel: req.mcpKeyLabel, tenantId: t.id, action: "ca-policies", result: "ok" });
  res.json({ ok: true, policies });
}));

app.get("/api/mcp/v1/tenants/:id/users", wrap(async (req, res) => {
  const t = requireTenant(req);
  requireMcpPermission(t, "readUsers");
  const users = await ENTRAUSERS.searchUsers(t, certPemPath(t.tenantId), String(req.query.q || ""));
  logMcpAction({ keyId: req.mcpKeyId, keyLabel: req.mcpKeyLabel, tenantId: t.id, action: "users-search", result: "ok" });
  res.json({ ok: true, users });
}));

app.post("/api/mcp/v1/tenants/:id/user-actions/:action", wrap(async (req, res) => {
  const t = requireTenant(req);
  const def = USER_ACTION_DEFS[req.params.action];
  if (!def) throw Object.assign(new Error("Unbekannte Aktion: " + req.params.action), { status: 404 });
  requireMcpPermission(t, def.permKey);
  const userId = String((req.body || {}).userId || "").trim();
  if (!userId) throw Object.assign(new Error("Keine Ziel-userId angegeben."), { status: 400 });

  if (process.env.FAKE_DEPLOY === "1") {
    logMcpAction({ keyId: req.mcpKeyId, keyLabel: req.mcpKeyLabel, tenantId: t.id, action: req.params.action, userId, result: "ok (fake)" });
    if (req.params.action === "reset-mfa") return res.json({ ok: true, result: { removed: [{ type: "#microsoft.graph.phoneAuthenticationMethod", displayName: "Fake-Telefon" }], skipped: [] } });
    if (req.params.action === "reset-password") return res.json({ ok: true, result: { tempPassword: "Fake-Temp-Pw!23" } });
    if (req.params.action === "revoke-sessions") return res.json({ ok: true, result: { revoked: true } });
    if (req.params.action === "group-membership") return res.json({ ok: true, result: { action: (req.body || {}).action || "add" } });
  }

  const cert = certPemPath(t.tenantId);
  let result;
  try {
    if (req.params.action === "reset-mfa") result = await USERACTIONS.resetUserMfa(t, cert, userId);
    else if (req.params.action === "reset-password") result = await USERACTIONS.resetUserPassword(t, cert, userId);
    else if (req.params.action === "revoke-sessions") result = await USERACTIONS.revokeUserSessions(t, cert, userId);
    else if (req.params.action === "group-membership") {
      const groupId = String((req.body || {}).groupId || "").trim();
      const gAction = String((req.body || {}).action || "").trim();
      if (!groupId) throw Object.assign(new Error("Keine Ziel-Gruppe angegeben."), { status: 400 });
      result = await USERACTIONS.changeGroupMembership(t, cert, userId, groupId, gAction);
    }
  } catch (e) {
    logMcpAction({ keyId: req.mcpKeyId, keyLabel: req.mcpKeyLabel, tenantId: t.id, action: req.params.action, userId, result: "error: " + e.message });
    throw e;
  }
  logMcpAction({ keyId: req.mcpKeyId, keyLabel: req.mcpKeyLabel, tenantId: t.id, action: req.params.action, userId, result: "ok" });
  res.json({ ok: true, result });
}));

app.post("/api/mcp/v1/tenants/:id/deploy/auto-setting/preview", wrap(async (req, res) => {
  const t = requireTenant(req);
  requireMcpPermission(t, "customPolicyImport");
  const searchTerm = String((req.body || {}).searchTerm || "").trim();
  const desiredLabel = String((req.body || {}).desiredLabel || "").trim();
  const preview = await SETTINGSCATALOG.previewSetting(t, certPemPath(t.tenantId), searchTerm, desiredLabel);
  res.json({ ok: true, preview });
}));

app.post("/api/mcp/v1/tenants/:id/deploy/auto-setting", wrap(async (req, res) => {
  const t = requireTenant(req);
  requireMcpPermission(t, "customPolicyImport");
  const { name, searchTerm, desiredLabel, groupId } = req.body || {};
  try {
    const result = await SETTINGSCATALOG.deployAutoSetting(t, certPemPath(t.tenantId), { name, searchTerm, desiredLabel }, String(groupId || "").trim());
    logMcpAction({ keyId: req.mcpKeyId, keyLabel: req.mcpKeyLabel, tenantId: t.id, action: "deploy-auto-setting", result: "ok", detail: result.resolvedSetting });
    res.json({ ok: true, result });
  } catch (e) {
    logMcpAction({ keyId: req.mcpKeyId, keyLabel: req.mcpKeyLabel, tenantId: t.id, action: "deploy-auto-setting", result: "error: " + e.message });
    throw e;
  }
}));

// Maester-Security-Audit via MCP: Ergebnisse lesen ("readMaester") und Lauf
// anstossen ("runMaester") — beides rein lesend auf dem Tenant, der Lauf
// veraendert dort nichts. Job-Fortschritt ueber den maester/job-Endpunkt.
app.get("/api/mcp/v1/tenants/:id/maester/latest", wrap(async (req, res) => {
  const t = requireTenant(req);
  requireMcpPermission(t, "readMaester");
  logMcpAction({ keyId: req.mcpKeyId, keyLabel: req.mcpKeyLabel, tenantId: t.id, action: "maester-latest", result: "ok" });
  res.json({ ok: true, maester: t.maester || null });
}));

app.post("/api/mcp/v1/tenants/:id/maester/run", wrap(async (req, res) => {
  const t = requireTenant(req);
  requireMcpPermission(t, "runMaester");
  for (const j of appJobs.values()) {
    if (j.tenantId === t.id && j.status === "running") {
      return res.status(409).json({ error: "Fuer diesen Tenant laeuft bereits ein Job.", jobId: j.id });
    }
  }
  const job = createAppJob(t, MAESTER_PHASES);
  runMaesterJob(job, t, MAESTER.sanitizeTags((req.body || {}).suites));
  logMcpAction({ keyId: req.mcpKeyId, keyLabel: req.mcpKeyLabel, tenantId: t.id, action: "maester-run", result: "gestartet (Job " + job.id + ")" });
  res.json({ ok: true, jobId: job.id, hint: "Fortschritt: GET /api/mcp/v1/tenants/" + t.id + "/maester/job/" + job.id });
}));

app.get("/api/mcp/v1/tenants/:id/maester/job/:jobId", wrap(async (req, res) => {
  const t = requireTenant(req);
  requireMcpPermission(t, "readMaester");
  const job = appJobs.get(req.params.jobId);
  if (!job || job.tenantId !== t.id) return res.status(404).json({ error: "Job nicht gefunden (Backend neu gestartet?)" });
  res.json({ ok: true, status: job.status, phase: job.phase, live: job.live || null, error: job.error, hint: job.hint, maester: job.maester || null });
}));

// Einrichtungs-Assistent: haekt einen Schritt der gefuehrten Onboarding-Checkliste
// pro Tenant ab/aus. Rein manuelle Markierung (kein automatischer Status-Check je
// Schritt) -- soll neuen/wenig erfahrenen Mitarbeitern eine feste Reihenfolge und
// einen Fortschrittsstand geben, der auch sitzungsuebergreifend erhalten bleibt.
app.post("/api/tenants/:id/onboarding/:stepId", (req, res) => {
  const s = loadState();
  const t = (s.tenants || []).find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "Tenant nicht gefunden" });
  const stepId = String(req.params.stepId || "").trim();
  if (!stepId) return res.status(400).json({ error: "stepId fehlt" });
  const done = !!(req.body && req.body.done);
  t.onboardingSteps = { ...(t.onboardingSteps || {}), [stepId]: done };
  saveState(s);
  res.json({ ok: true, onboardingSteps: t.onboardingSteps });
});

app.delete("/api/tenants/:id", (req, res) => {
  const s = loadState();
  const t = (s.tenants || []).find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "Tenant nicht gefunden" });
  s.tenants = s.tenants.filter(x => x.id !== req.params.id);
  saveState(s);
  try { fs.unlinkSync(certPemPath(t.tenantId)); } catch (e) { /* egal */ }
  res.json({ ok: true });
});

// ---------- Onboarding (Device-Code) ----------
app.post("/api/onboard/start", wrap(async (req, res) => {
  const b = req.body || {};
  const tenant = String(b.tenant || "").trim() || "organizations";
  const params = new URLSearchParams({
    client_id: GRAPH_CLI_CLIENT,
    // RoleManagement.ReadWrite.Directory: fuer die Exchange-Admin-Rollenzuweisung.
    scope: "Application.ReadWrite.All AppRoleAssignment.ReadWrite.All Directory.ReadWrite.All RoleManagement.ReadWrite.Directory offline_access openid"
  });
  const r = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/devicecode`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: params
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Device-Code-Start fehlgeschlagen: " + (j.error_description || j.error || r.status));
  req.session.onboard = {
    tenant, deviceCode: j.device_code, interval: (j.interval || 5),
    expiresAt: Date.now() + (j.expires_in || 900) * 1000
  };
  res.json({ userCode: j.user_code, verificationUri: j.verification_uri || "https://microsoft.com/devicelogin", interval: j.interval || 5 });
}));

app.post("/api/onboard/poll", wrap(async (req, res) => {
  const df = req.session.onboard;
  if (!df) return res.status(400).json({ error: "Kein laufender Onboarding-Vorgang." });
  if (Date.now() > df.expiresAt) { delete req.session.onboard; return res.json({ status: "error", error: "Anmeldecode abgelaufen — bitte neu starten." }); }

  const params = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    client_id: GRAPH_CLI_CLIENT, device_code: df.deviceCode
  });
  const r = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(df.tenant)}/oauth2/v2.0/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: params
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (j.error === "authorization_pending") return res.json({ status: "pending" });
    if (j.error === "slow_down") { df.interval = (df.interval || 5) + 5; return res.json({ status: "pending", slowDown: true, interval: df.interval }); }
    delete req.session.onboard;
    return res.json({ status: "error", error: j.error_description || j.error || ("HTTP " + r.status) });
  }

  const token = j.access_token;
  const result = await provisionAppReg(token);

  // Tenant-Infos ziehen (Id, Name, initiale onmicrosoft-Domain fuer -Organization).
  let tenantId = df.tenant, orgName = df.tenant, organization = null;
  try {
    const orgInfo = await gReq(token, "GET", "/organization?$select=id,displayName,verifiedDomains");
    const o = orgInfo.value && orgInfo.value[0];
    if (o) {
      tenantId = o.id; orgName = o.displayName || tenantId;
      const doms = o.verifiedDomains || [];
      const initial = doms.find(d => d.isInitial) || doms.find(d => /\.onmicrosoft\.com$/i.test(d.name));
      organization = initial ? initial.name : null;
    }
  } catch (e) { /* Fallbacks bleiben */ }
  if (!organization) organization = /\.onmicrosoft\.com$/i.test(df.tenant) ? df.tenant : null;

  if (result.certPem) fs.writeFileSync(certPemPath(tenantId), result.certPem, "utf8");

  const s = loadState();
  const baseId = (orgName || tenantId).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || ("t-" + tenantId.slice(0, 8));
  const existingIdx = (s.tenants || []).findIndex(x => x.tenantId === tenantId);
  const uid = existingIdx >= 0 ? s.tenants[existingIdx].id
    : (s.tenants.some(x => x.id === baseId) ? baseId + "-" + tenantId.slice(0, 4) : baseId);
  const rec = {
    id: uid, name: orgName, tenantId, organization, clientId: result.appId,
    certThumbprint: result.certThumbprint || "", exoRole: result.exoRole, sccRole: result.sccRole,
    tcm: result.tcm, addedAt: new Date().toISOString()
  };
  if (existingIdx >= 0) s.tenants[existingIdx] = Object.assign(s.tenants[existingIdx], rec);
  else s.tenants.push(rec);
  saveState(s);
  delete req.session.onboard;
  GRAPHLIB.clearTenantToken(tenantId);

  res.json({
    status: "done", tenant: { id: uid, name: orgName, tenantId, organization, appId: result.appId },
    setup: {
      app: true,
      consent: !!result.consentOk,
      exoRole: !!result.exoRole,
      sccRole: !!result.sccRole,
      tcm: !!result.tcm,
      cert: !!result.certPem
    },
    warnings: [
      result.consentOk ? null : ("Admin-Consent fehlgeschlagen: " + result.consentErr),
      result.exoRole ? null : ("Exchange-Administrator-Rolle nicht zugewiesen: " + (result.exoRoleErr || "unbekannt")),
      result.sccRole ? null : ("Compliance-Administrator-Rolle nicht zugewiesen: " + (result.sccRoleErr || "unbekannt")),
      result.tcm ? null : ("TCM-Einrichtung fehlgeschlagen (Alert-Policy-Prüfung im Audit nicht möglich): " + (result.tcmErr || "unbekannt")),
      result.certPem ? null : ("Zertifikat konnte nicht erstellt werden: " + (result.certError || "unbekannt"))
    ].filter(Boolean)
  });
}));

// ---------- Permission-Fixer (Device-Code, wie Onboarding) ----------
app.post("/api/tenants/:id/fix/start", wrap(async (req, res) => {
  const s = loadState();
  const t = (s.tenants || []).find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "Tenant nicht gefunden" });

  // replaceCert nur setzen, wenn der Aufrufer es ausdruecklich mitgibt: das
  // Ersetzen wirft die an der App hinterlegten Zertifikate weg (siehe
  // repairAppReg) und ist damit ein bewusster Eingriff im Kundentenant.
  const replaceCert = !!(req.body && req.body.replaceCert);

  if (process.env.FAKE_DEPLOY === "1") {
    req.session.fix = { tenantRecId: t.id, fake: true, polls: 0, replaceCert };
    return res.json({ userCode: "FAKE-CODE", verificationUri: "https://microsoft.com/devicelogin", interval: 2 });
  }

  const loginTenant = t.organization || t.tenantId;
  const params = new URLSearchParams({
    client_id: GRAPH_CLI_CLIENT,
    scope: "Application.ReadWrite.All AppRoleAssignment.ReadWrite.All Directory.ReadWrite.All RoleManagement.ReadWrite.Directory offline_access openid"
  });
  const r = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(loginTenant)}/oauth2/v2.0/devicecode`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: params
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Device-Code-Start fehlgeschlagen: " + (j.error_description || j.error || r.status));
  req.session.fix = {
    tenantRecId: t.id, loginTenant, replaceCert,
    deviceCode: j.device_code, interval: (j.interval || 5),
    expiresAt: Date.now() + (j.expires_in || 900) * 1000
  };
  res.json({ userCode: j.user_code, verificationUri: j.verification_uri || "https://microsoft.com/devicelogin", interval: j.interval || 5 });
}));

app.post("/api/fix/poll", wrap(async (req, res) => {
  const df = req.session.fix;
  if (!df) return res.status(400).json({ error: "Kein laufender Reparatur-Vorgang." });

  if (df.fake) {
    df.polls = (df.polls || 0) + 1;
    if (df.polls < 2) return res.json({ status: "pending" });
    delete req.session.fix;
    return res.json({
      status: "done",
      items: [
        { name: "App-Registrierung", state: "ok", detail: "M365-Security-Policy-Manager" },
        { name: "Permission Exchange.ManageAsApp", state: "ok", detail: "" },
        { name: "Service Principal", state: "ok", detail: "" },
        { name: "Admin-Consent", state: "fixed", detail: "" },
        { name: "Exchange-Administrator-Rolle", state: "ok", detail: "" },
        { name: "Compliance-Administrator-Rolle", state: "fixed", detail: "" },
        { name: "TCM-Einrichtung (Alert-Policy-Prüfung)", state: "fixed", detail: "" },
        { name: "Zertifikat", state: "ok", detail: "lokal + in der App hinterlegt" }
      ]
    });
  }

  if (Date.now() > df.expiresAt) { delete req.session.fix; return res.json({ status: "error", error: "Anmeldecode abgelaufen — bitte neu starten." }); }

  const params = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    client_id: GRAPH_CLI_CLIENT, device_code: df.deviceCode
  });
  const r = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(df.loginTenant)}/oauth2/v2.0/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: params
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (j.error === "authorization_pending") return res.json({ status: "pending" });
    if (j.error === "slow_down") { df.interval = (df.interval || 5) + 5; return res.json({ status: "pending", slowDown: true, interval: df.interval }); }
    delete req.session.fix;
    return res.json({ status: "error", error: j.error_description || j.error || ("HTTP " + r.status) });
  }

  const s = loadState();
  const t = (s.tenants || []).find(x => x.id === df.tenantRecId);
  if (!t) { delete req.session.fix; return res.json({ status: "error", error: "Tenant nicht mehr vorhanden." }); }

  const result = await repairAppReg(j.access_token, t, { replaceCert: !!df.replaceCert });

  // Tenant-Flags aktualisieren, damit die Badges den echten Zustand zeigen
  t.exoRole = result.exoRole;
  t.sccRole = result.sccRole;
  t.tcm = result.tcm;
  saveState(s);
  delete req.session.fix;
  // Gecachte Graph-Tokens verwerfen — sie enthalten die neuen Rollen noch nicht
  GRAPHLIB.clearTenantToken(t.tenantId);

  res.json({ status: "done", items: result.items });
}));

// ---------- OIB-Policy-Zuweisung (Graph app-only) ----------
function fakeOib() {
  return {
    groups: [
      { id: "g1", displayName: "AAD-DEV-STD", membershipRule: '(device.devicePhysicalIds -any (_ -eq "[OrderID]:DEV-STD"))', state: "On" },
      { id: "g2", displayName: "AAD-DEV-ADM", membershipRule: '(device.devicePhysicalIds -any (_ -eq "[OrderID]:DEV-ADM"))', state: "On" }
    ],
    policies: [
      { id: "p1", name: "Win - OIB - ES - Defender Antivirus - D - AV Configuration", apiType: "intents", type: "Endpoint Security", assignments: [{ groupId: "g1", label: "AAD-DEV-STD" }] },
      { id: "p2", name: "Win - OIB - ES - Encryption - D - BitLocker (OS Disk)", apiType: "intents", type: "Endpoint Security", assignments: [] },
      { id: "p3", name: "Win - OIB - SC - Device Security - D - Local Security Policies", apiType: "configurationPolicies", type: "Settings Catalog", assignments: [{ groupId: null, label: "Alle Geräte" }] },
      { id: "p4", name: "Win - OIB - SC - Credential Management - D - Passwordless", apiType: "configurationPolicies", type: "Settings Catalog", assignments: [] },
      { id: "p5", name: "Win - OIB - SC - Microsoft Edge - U - User Experience - v3.7", apiType: "configurationPolicies", type: "Settings Catalog", assignments: [] },
      { id: "p6", name: "Win - OIB - SC - Microsoft Edge - U - User Experience - v3.8", apiType: "configurationPolicies", type: "Settings Catalog", assignments: [{ groupId: "g1", label: "AAD-DEV-STD" }] }
    ]
  };
}

app.get("/api/tenants/:id/oib", wrap(async (req, res) => {
  const t = requireTenant(req);
  if (process.env.FAKE_DEPLOY === "1") return res.json({ ok: true, ...fakeOib() });
  const data = await OIB.loadOibOverview(t, certPemPath(t.tenantId));
  res.json({ ok: true, ...data });
}));

app.post("/api/tenants/:id/oib/assign", wrap(async (req, res) => {
  const t = requireTenant(req);
  const b = req.body || {};
  const groupId = String(b.groupId || "");
  const policies = Array.isArray(b.policies) ? b.policies : [];
  if (!groupId || policies.length === 0) return res.status(400).json({ error: "groupId und policies erforderlich." });

  if (process.env.FAKE_DEPLOY === "1") {
    return res.json({
      ok: true,
      results: policies.map((p, i) => ({ id: p.id, status: i === 0 ? "skipped" : "assigned" }))
    });
  }

  const results = [];
  for (const p of policies) {
    if (!p || !p.id || !["configurationPolicies", "intents"].includes(p.apiType)) {
      results.push({ id: p && p.id, status: "failed", error: "Ungueltige Policy-Referenz" });
      continue;
    }
    try {
      const status = await OIB.assignPolicyToGroup(t, certPemPath(t.tenantId), p, groupId);
      results.push({ id: p.id, status });
    } catch (e) {
      results.push({ id: p.id, status: "failed", error: e.message });
    }
  }
  res.json({ ok: true, results });
}));

// ---------- OIB-Baseline-Import (OIBDeployer-Port) ----------
// Index 10 Minuten cachen — die GitHub-Contents-API ist unauthentifiziert auf
// 60 Requests/Stunde limitiert (ein Index-Abruf kostet ~6 Requests).
let oibBaselineCache = { data: null, exp: 0 };
app.get("/api/oib/baseline", wrap(async (req, res) => {
  if (oibBaselineCache.data && Date.now() < oibBaselineCache.exp) {
    return res.json({ ok: true, ...oibBaselineCache.data });
  }
  const data = await OIBIMPORT.fetchBaselineIndex();
  oibBaselineCache = { data, exp: Date.now() + 10 * 60 * 1000 };
  res.json({ ok: true, ...data });
}));

app.post("/api/tenants/:id/oib/import", wrap(async (req, res) => {
  const t = requireTenant(req);
  const files = Array.isArray((req.body || {}).files) ? req.body.files : [];
  if (!files.length) return res.status(400).json({ error: "files erforderlich." });
  for (const j of appJobs.values()) {
    if (j.tenantId === t.id && j.status === "running") {
      return res.status(409).json({ error: "Fuer diesen Tenant laeuft bereits ein Job.", jobId: j.id });
    }
  }
  const job = createAppJob(t, ["Bestehende Policies laden", "Baseline importieren"]);
  (async () => {
    const onProgress = appJobProgress(job);
    try {
      if (process.env.FAKE_DEPLOY === "1") {
        onProgress("Bestehende Policies laden"); await new Promise(r => setTimeout(r, 500));
        for (let i = 1; i <= files.length; i++) { onProgress(`Policy ${i}/${files.length}`); await new Promise(r => setTimeout(r, 120)); }
        job.results = { created: Math.max(0, files.length - 1), skipped: Math.min(1, files.length), failed: 0 };
      } else {
        const results = await OIBIMPORT.importPolicies(t, certPemPath(t.tenantId), files, onProgress);
        job.results = {
          created: results.filter(x => x.status === "created").length,
          skipped: results.filter(x => x.status === "skipped").length,
          failed: results.filter(x => x.status === "failed").length,
          details: results
        };
      }
      finishAppJob(job, true);
    } catch (e) {
      const isPermIssue = e.status === 403 || /insufficient privileges|authorization|forbidden/i.test(String(e.message || ""));
      finishAppJob(job, false, e.message, isPermIssue
        ? "Der Baseline-Import braucht DeviceManagementConfiguration.ReadWrite.All — im Tab 'Tenants' einmal Reparieren ausfuehren."
        : null);
    }
  })();
  res.json({ ok: true, jobId: job.id });
}));

// ---------- Drive-Mapping-Konfigurator (nicolonsky/IntuneDriveMapping-Port) ----------
// Generator-UX des Originals: Skript ohne Deploy erzeugen (Download) und
// bestehendes Skript wieder einlesen (Konfig-Roundtrip) — tenant-unabhaengig.
app.post("/api/drivemappings/generate", (req, res) => {
  const b = req.body || {};
  try {
    res.json({ ok: true, script: DRIVEMAP.buildScript({ mappings: b.mappings, searchRoot: b.searchRoot, removeStaleDrives: !!b.removeStaleDrives }) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/drivemappings/parse", (req, res) => {
  const cfg = DRIVEMAP.parseScript(String((req.body || {}).script || ""));
  if (!cfg) return res.status(400).json({ error: "Kein DriveMapping-Skript erkannt (JSON-Block nicht gefunden)." });
  res.json({ ok: true, config: cfg });
});

app.get("/api/tenants/:id/drivemappings", wrap(async (req, res) => {
  const t = requireTenant(req);
  if (process.env.FAKE_DEPLOY === "1") {
    return res.json({
      ok: true,
      profiles: [{
        id: "dm-1", profileName: "Standard", displayName: "WIN - DriveMapping - Standard",
        config: { mappings: [{ driveLetter: "H", path: "\\\\srv01\\home$", label: "Home", groupFilter: "" }, { driveLetter: "S", path: "\\\\srv01\\share", label: "Firma", groupFilter: "GG-Vertrieb" }], searchRoot: "", removeStaleDrives: true },
        groupIds: ["g1"]
      }]
    });
  }
  res.json({ ok: true, profiles: await DRIVEMAP.listProfiles(t, certPemPath(t.tenantId)) });
}));

app.post("/api/tenants/:id/drivemappings", wrap(async (req, res) => {
  const t = requireTenant(req);
  const b = req.body || {};
  if (process.env.FAKE_DEPLOY === "1") {
    // Validierung auch im Fake-Modus echt laufen lassen (UI-Fehlerbild testbar)
    DRIVEMAP.buildScript({ mappings: b.mappings, searchRoot: b.searchRoot, removeStaleDrives: b.removeStaleDrives });
    return res.json({ ok: true, scriptId: "dm-1", displayName: "WIN - DriveMapping - " + String(b.profileName || ""), updated: false });
  }
  const r = await DRIVEMAP.deployProfile(t, certPemPath(t.tenantId), {
    profileName: b.profileName, mappings: b.mappings,
    searchRoot: b.searchRoot, removeStaleDrives: !!b.removeStaleDrives,
    groupIds: Array.isArray(b.groupIds) ? b.groupIds : []
  });
  res.json({ ok: true, ...r });
}));

// ---------- Printer-Mapping-Konfigurator (Weatherlights-Tool, app-only) ----------
app.get("/api/tenants/:id/printermappings", wrap(async (req, res) => {
  const t = requireTenant(req);
  if (process.env.FAKE_DEPLOY === "1") {
    return res.json({
      ok: true, autostartPfn: PRINTMAP.AUTOSTART_PFN, maxPrinters: PRINTMAP.MAX_PRINTERS,
      profiles: [{
        id: "pm-1", profileName: "Buero EG", displayName: "WIN - PrinterMapping - Buero EG",
        enabled: true, scope: "user",
        printers: [
          { path: "\\\\printsrv\\Kyocera-EG", operation: "Add", setDefault: true },
          { path: "\\\\printsrv\\Etiketten", operation: "Add", setDefault: false }
        ],
        groupIds: ["g1"]
      }]
    });
  }
  res.json({ ok: true, autostartPfn: PRINTMAP.AUTOSTART_PFN, maxPrinters: PRINTMAP.MAX_PRINTERS, profiles: await PRINTMAP.listProfiles(t, certPemPath(t.tenantId)) });
}));

app.post("/api/tenants/:id/printermappings", wrap(async (req, res) => {
  const t = requireTenant(req);
  const b = req.body || {};
  try { PRINTMAP.sanitizeProfileName(b.profileName); PRINTMAP.sanitizePrinters(b.printers); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  for (const j of appJobs.values()) {
    if (j.tenantId === t.id && j.status === "running") return res.status(409).json({ error: "Fuer diesen Tenant laeuft bereits ein Job.", jobId: j.id });
  }
  const job = createAppJob(t, ["Drucker-Profil ausrollen"]);
  (async () => {
    const onProgress = appJobProgress(job);
    try {
      if (process.env.FAKE_DEPLOY === "1") {
        for (const s of ["ADMX-Vorlage importieren", "ADMX-Verarbeitung abwarten (pending)", "ADMX-Definitionen laden", "Konfigurationsprofil anlegen", "Richtlinienwerte setzen", "Gruppen zuweisen", ...(b.deployApp ? ["Store-App bereitstellen"] : [])]) {
          onProgress(s); await new Promise(r => setTimeout(r, 300));
        }
        job.results = { configId: "pm-1", displayName: "WIN - PrinterMapping - " + b.profileName, updated: false, app: b.deployApp ? { appId: "app-1", created: true } : null };
      } else {
        job.results = await PRINTMAP.deployProfile(t, certPemPath(t.tenantId), b, onProgress);
      }
      finishAppJob(job, true);
    } catch (e) {
      const isPermIssue = e.status === 403 || /insufficient privileges|authorization|not authorized|forbidden/i.test(String(e.message || ""));
      finishAppJob(job, false, e.message, isPermIssue
        ? "Braucht DeviceManagementConfiguration + DeviceManagementApps (ReadWrite) — im Tab 'Tenants' einmal Reparieren ausfuehren."
        : null);
    }
  })();
  res.json({ ok: true, jobId: job.id });
}));

// ---------- SharePoint-Sync-Mapping (OneDrive "Configure team site libraries
// to sync automatically", https://learn.microsoft.com/sharepoint/use-group-policy) ----------
app.get("/api/tenants/:id/sharepointsites", wrap(async (req, res) => {
  const t = requireTenant(req);
  if (process.env.FAKE_DEPLOY === "1") {
    return res.json({ ok: true, sites: [
      { id: "fake-site-1", displayName: "Marketing", webUrl: "https://demokunde.sharepoint.com/sites/Marketing" },
      { id: "fake-site-2", displayName: "Finance", webUrl: "https://demokunde.sharepoint.com/sites/Finance" }
    ] });
  }
  res.json({ ok: true, sites: await SPMAP.listSites(t, certPemPath(t.tenantId)) });
}));

app.post("/api/tenants/:id/sharepointsites/resolve", wrap(async (req, res) => {
  const t = requireTenant(req);
  const siteId = String((req.body || {}).siteId || "").trim();
  if (!siteId) throw Object.assign(new Error("Keine Site angegeben."), { status: 400 });
  if (process.env.FAKE_DEPLOY === "1") {
    return res.json({ ok: true, libraries: [{
      libraryName: "Dokumente", tenantId: "00000000-0000-0000-0000-000000000001",
      siteId: "11111111-1111-1111-1111-111111111111", webId: "22222222-2222-2222-2222-222222222222",
      listId: "33333333-3333-3333-3333-333333333333", webUrl: "https://demokunde.sharepoint.com/sites/Marketing"
    }] });
  }
  res.json({ ok: true, libraries: await SPMAP.resolveLibraries(t, certPemPath(t.tenantId), siteId) });
}));

app.get("/api/tenants/:id/sharepointmappings", wrap(async (req, res) => {
  const t = requireTenant(req);
  if (process.env.FAKE_DEPLOY === "1") {
    return res.json({
      ok: true,
      profiles: [{
        id: "spm-1", profileName: "Standard", displayName: "WIN - SharePointSync - Standard",
        config: { mappings: [{
          libraryName: "Marketing-Dokumente", tenantId: "00000000-0000-0000-0000-000000000001",
          siteId: "11111111-1111-1111-1111-111111111111", webId: "22222222-2222-2222-2222-222222222222",
          listId: "33333333-3333-3333-3333-333333333333", webUrl: "https://demokunde.sharepoint.com/sites/Marketing"
        }] },
        groupIds: ["g1"]
      }]
    });
  }
  res.json({ ok: true, profiles: await SPMAP.listProfiles(t, certPemPath(t.tenantId)) });
}));

app.post("/api/tenants/:id/sharepointmappings", wrap(async (req, res) => {
  const t = requireTenant(req);
  const b = req.body || {};
  if (process.env.FAKE_DEPLOY === "1") {
    SPMAP.buildScript({ mappings: b.mappings }); // Validierung auch im Fake-Modus echt laufen lassen
    return res.json({ ok: true, scriptId: "spm-1", displayName: "WIN - SharePointSync - " + String(b.profileName || ""), updated: false });
  }
  const r = await SPMAP.deployProfile(t, certPemPath(t.tenantId), {
    profileName: b.profileName, mappings: b.mappings,
    groupIds: Array.isArray(b.groupIds) ? b.groupIds : []
  });
  res.json({ ok: true, ...r });
}));

// ---------- Registry-Richtlinien-Konfigurator (HKLM, generisch + Presets) ----------
app.get("/api/registrypolicy/presets", (req, res) => {
  res.json({ ok: true, presets: REGPOLICY.PRESETS });
});

app.get("/api/tenants/:id/registrypolicy", wrap(async (req, res) => {
  const t = requireTenant(req);
  if (process.env.FAKE_DEPLOY === "1") {
    return res.json({
      ok: true,
      profiles: [{
        id: "rp-1", profileName: "EU DMA SSO", displayName: "WIN - RegistryPolicy - EU DMA SSO",
        config: { entries: [{ path: "SOFTWARE\\Policies\\Microsoft\\Windows\\AAD", name: "AutoAcceptSsoPermission", type: "DWORD", value: "1" }] },
        groupIds: ["g1"]
      }]
    });
  }
  res.json({ ok: true, profiles: await REGPOLICY.listProfiles(t, certPemPath(t.tenantId)) });
}));

app.post("/api/tenants/:id/registrypolicy", wrap(async (req, res) => {
  const t = requireTenant(req);
  const b = req.body || {};
  if (process.env.FAKE_DEPLOY === "1") {
    REGPOLICY.buildScript({ entries: b.entries }); // Validierung auch im Fake-Modus echt laufen lassen
    return res.json({ ok: true, scriptId: "rp-1", displayName: "WIN - RegistryPolicy - " + String(b.profileName || ""), updated: false });
  }
  const r = await REGPOLICY.deployProfile(t, certPemPath(t.tenantId), {
    profileName: b.profileName, entries: b.entries,
    groupIds: Array.isArray(b.groupIds) ? b.groupIds : []
  });
  res.json({ ok: true, ...r });
}));

// ---------- Intune-Bulk-Loeschung (Checkbox-Auswahl -> Loeschen + Log) ----------
// Portierung von Andrew Taylors bekanntem Cleanup-Skript. Loeschen ist
// unumkehrbar -- Frontend zeigt zwingend eine Bestaetigung mit Anzahl+Typen-
// Aufschluesselung, bevor dieser Endpunkt ueberhaupt aufgerufen wird. Jeder
// Versuch (Erfolg wie Fehlschlag) landet im persistierten Log.
function logBulkDelete(tenantId, entry) {
  const s = loadState();
  s.intuneDeleteLog = s.intuneDeleteLog || [];
  s.intuneDeleteLog.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), tenantId, ...entry });
  if (s.intuneDeleteLog.length > 1000) s.intuneDeleteLog.length = 1000;
  saveState(s);
}

app.get("/api/tenants/:id/intune-bulk-delete/objects", wrap(async (req, res) => {
  const t = requireTenant(req);
  if (process.env.FAKE_DEPLOY === "1") {
    return res.json({
      ok: true,
      objects: [
        { id: "fake-cfg-1", name: "BP_AntiMalware Baseline", description: "Fake-Beschreibung", type: "Config Policy", riskier: false },
        { id: "fake-sc-1", name: "Edge Password Manager Disabled", description: null, type: "Settings Catalog", riskier: false },
        { id: "fake-ca-1", name: "CA_Ring0_MFA", description: null, type: "Conditional Access Policy", riskier: false },
        { id: "fake-grp-1", name: "AAD-CA-RING-BP", description: null, type: "AAD Group", riskier: true }
      ],
      errors: []
    });
  }
  const { objects, errors } = await BULKDELETE.listDeletableObjects(t, certPemPath(t.tenantId));
  res.json({ ok: true, objects, errors });
}));

app.post("/api/tenants/:id/intune-bulk-delete", wrap(async (req, res) => {
  const t = requireTenant(req);
  const items = Array.isArray((req.body || {}).items) ? req.body.items : [];
  if (!items.length) throw Object.assign(new Error("Keine Objekte ausgewaehlt."), { status: 400 });

  const cert = certPemPath(t.tenantId);
  const results = [];
  for (const item of items) {
    const id = String(item.id || "");
    const type = String(item.type || "");
    const name = String(item.name || "");
    try {
      if (process.env.FAKE_DEPLOY === "1") {
        // no-op
      } else {
        await BULKDELETE.deleteObject(t, cert, id, type);
      }
      results.push({ id, type, name, ok: true });
      logBulkDelete(t.id, { objectId: id, type, name, result: "ok" });
    } catch (e) {
      results.push({ id, type, name, ok: false, error: e.message });
      logBulkDelete(t.id, { objectId: id, type, name, result: "error: " + e.message });
    }
  }
  res.json({ ok: true, results });
}));

app.get("/api/tenants/:id/intune-bulk-delete/log", (req, res) => {
  const s = loadState();
  const log = (s.intuneDeleteLog || []).filter(l => l.tenantId === req.params.id).slice(0, Number(req.query.limit) || 100);
  res.json({ ok: true, log });
});

// ---------- Intune-Backup & -Restore (TenuVault-Idee, app-only) ----------
const FAKE_BACKUP = {
  backupId: "2026-07-20T18-00-00-000Z",
  createdAt: "2026-07-20T18:00:00.000Z",
  counts: { settingsCatalog: 4, compliance: 2, deviceConfigurations: 1, scripts: 2, featureUpdates: 1, qualityUpdates: 0, driverUpdates: 0, total: 10 }
};

app.get("/api/tenants/:id/intunebackup", wrap(async (req, res) => {
  const t = requireTenant(req);
  if (process.env.FAKE_DEPLOY === "1") return res.json({ ok: true, backups: [FAKE_BACKUP], categories: IBACKUP.CATEGORIES.map(c => ({ key: c.key, label: c.label })) });
  res.json({ ok: true, backups: IBACKUP.listBackups(STATE_DIR, t.id), categories: IBACKUP.CATEGORIES.map(c => ({ key: c.key, label: c.label })) });
}));

app.post("/api/tenants/:id/intunebackup", wrap(async (req, res) => {
  const t = requireTenant(req);
  for (const j of appJobs.values()) {
    if (j.tenantId === t.id && j.status === "running") return res.status(409).json({ error: "Fuer diesen Tenant laeuft bereits ein Job.", jobId: j.id });
  }
  const job = createAppJob(t, ["Konfiguration sichern"]);
  (async () => {
    const onProgress = appJobProgress(job);
    try {
      if (process.env.FAKE_DEPLOY === "1") {
        for (const s of ["Settings Catalog sichern", "Compliance-Policies sichern", "Device Configurations sichern", "Plattform-Skripte sichern", "Update-Profile sichern"]) {
          onProgress(s); await new Promise(r => setTimeout(r, 350));
        }
        job.results = { backupId: FAKE_BACKUP.backupId, counts: FAKE_BACKUP.counts };
      } else {
        job.results = await IBACKUP.runBackup(STATE_DIR, t, certPemPath(t.tenantId), onProgress);
      }
      finishAppJob(job, true);
    } catch (e) {
      finishAppJob(job, false, e.message, null);
    }
  })();
  res.json({ ok: true, jobId: job.id });
}));

// Inhalt eines Snapshots (nur Namen je Kategorie — fuer den Restore-Picker).
app.get("/api/tenants/:id/intunebackup/:backupId", wrap(async (req, res) => {
  const t = requireTenant(req);
  if (process.env.FAKE_DEPLOY === "1") {
    return res.json({
      ok: true, backupId: req.params.backupId,
      items: {
        settingsCatalog: ["Win - OIB - SC - Device Security - D - Local Security Policies - v3.7", "Win - OIB - SC - Credential Management - D - Passwordless - v3.5", "Win - OIB - SC - Microsoft Edge - U - User Experience - v3.8", "Eigene Policy - Kiosk"],
        compliance: ["Win - OIB - Compliance - D - Baseline", "Compliance iOS"],
        deviceConfigurations: ["Legacy WUfB Ring"],
        scripts: ["Map-Drives.ps1", "Set-Timezone.ps1"],
        featureUpdates: ["Win11 24H2 Rollout"], qualityUpdates: [], driverUpdates: []
      }
    });
  }
  const doc = IBACKUP.loadBackup(STATE_DIR, t.id, req.params.backupId);
  const items = {};
  for (const c of IBACKUP.CATEGORIES) items[c.key] = (doc.categories[c.key] || []).map(p => c.nameOf(p) || "(ohne Namen)");
  res.json({ ok: true, backupId: req.params.backupId, items });
}));

// Drift-Vergleich zweier Snapshots (TenuVault-Idee): je Kategorie, was auf
// Namensebene hinzugekommen/weggefallen ist (A = aelter, B = neuer).
app.get("/api/tenants/:id/intunebackup/:backupId/compare/:otherId", wrap(async (req, res) => {
  const t = requireTenant(req);
  if (process.env.FAKE_DEPLOY === "1") {
    return res.json({
      ok: true,
      diff: [
        { key: "settingsCatalog", label: "Settings Catalog", added: ["Win - OIB - SC - Neue Policy - v3.9"], removed: ["Alte Test-Policy"], same: 3 },
        { key: "compliance", label: "Compliance", added: [], removed: [], same: 2 },
        { key: "scripts", label: "Plattform-Skripte", added: ["WIN - DriveMapping - Standard"], removed: [], same: 2 }
      ]
    });
  }
  const a = IBACKUP.loadBackup(STATE_DIR, t.id, req.params.backupId);
  const b2 = IBACKUP.loadBackup(STATE_DIR, t.id, req.params.otherId);
  const diff = IBACKUP.CATEGORIES.map(c => {
    const namesA = new Set((a.categories[c.key] || []).map(p => c.nameOf(p) || ""));
    const namesB = new Set((b2.categories[c.key] || []).map(p => c.nameOf(p) || ""));
    return {
      key: c.key, label: c.label,
      added: [...namesB].filter(n => !namesA.has(n)),
      removed: [...namesA].filter(n => !namesB.has(n)),
      same: [...namesB].filter(n => namesA.has(n)).length
    };
  });
  res.json({ ok: true, diff });
}));

app.get("/api/tenants/:id/intunebackup/:backupId/download", wrap(async (req, res) => {
  const t = requireTenant(req);
  if (process.env.FAKE_DEPLOY === "1") {
    res.setHeader("Content-Disposition", `attachment; filename="intune-backup-fake.json"`);
    return res.json({ meta: { fake: true }, categories: {} });
  }
  const doc = IBACKUP.loadBackup(STATE_DIR, t.id, req.params.backupId);
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="intune-backup-${t.id}-${req.params.backupId}.json"`);
  res.send(JSON.stringify(doc, null, 2));
}));

app.post("/api/tenants/:id/intunebackup/:backupId/restore", wrap(async (req, res) => {
  const t = requireTenant(req);
  const items = Array.isArray((req.body || {}).items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: "items erforderlich." });
  for (const j of appJobs.values()) {
    if (j.tenantId === t.id && j.status === "running") return res.status(409).json({ error: "Fuer diesen Tenant laeuft bereits ein Job.", jobId: j.id });
  }
  const backupId = req.params.backupId;
  const job = createAppJob(t, ["Wiederherstellen"]);
  (async () => {
    const onProgress = appJobProgress(job);
    try {
      if (process.env.FAKE_DEPLOY === "1") {
        for (let i = 1; i <= items.length; i++) { onProgress(`Restore ${i}/${items.length}`); await new Promise(r => setTimeout(r, 250)); }
        job.results = { created: items.length, failed: 0, details: items.map((it, i) => ({ name: `[Restored] Objekt ${i + 1}`, status: "created" })) };
      } else {
        const results = await IBACKUP.restoreItems(STATE_DIR, t, certPemPath(t.tenantId), backupId, items, onProgress);
        job.results = {
          created: results.filter(x => x.status === "created").length,
          failed: results.filter(x => x.status === "failed").length,
          details: results
        };
      }
      finishAppJob(job, true);
    } catch (e) {
      finishAppJob(job, false, e.message, null);
    }
  })();
  res.json({ ok: true, jobId: job.id });
}));

// ---------- Lizenz-Optimizer (read-only Lizenzreport) ----------
app.get("/api/tenants/:id/licenses", wrap(async (req, res) => {
  const t = requireTenant(req);
  if (process.env.FAKE_DEPLOY === "1") {
    return res.json({
      ok: true,
      generatedAt: new Date().toISOString(), inactiveDays: 90, signInAvailable: true,
      totals: { users: 42, licensedUsers: 38, paidSkus: 3, freeSeats: 5, disabledWithLicense: 2, inactiveWithLicense: 3, multiSuite: 2, multiSuiteTotal: 3 },
      skus: [
        { skuPartNumber: "SPB", name: "Microsoft 365 Business Premium", free: false, purchased: 40, warning: 0, suspended: 0, assigned: 36, available: 4, capabilityStatus: "Enabled" },
        { skuPartNumber: "EXCHANGESTANDARD", name: "Exchange Online (Plan 1)", free: false, purchased: 5, warning: 0, suspended: 0, assigned: 4, available: 1, capabilityStatus: "Enabled" },
        { skuPartNumber: "Microsoft_365_Copilot", name: "Microsoft 365 Copilot", free: false, purchased: 2, warning: 0, suspended: 0, assigned: 2, available: 0, capabilityStatus: "Enabled" },
        { skuPartNumber: "FLOW_FREE", name: "Power Automate (kostenlos)", free: true, purchased: 10000, warning: 0, suspended: 0, assigned: 7, available: 9993, capabilityStatus: "Enabled" }
      ],
      findings: {
        disabledWithLicense: [
          { displayName: "Ex Mitarbeiter", upn: "ex.mitarbeiter@example.com", licenses: ["Microsoft 365 Business Premium"] },
          { displayName: "Alte Praktikantin", upn: "praktikant@example.com", licenses: ["Exchange Online (Plan 1)"] }
        ],
        inactiveWithLicense: [
          { displayName: "Urlauber Lang", upn: "urlauber@example.com", lastSignIn: "2026-02-01", daysInactive: 168, licenses: ["Microsoft 365 Business Premium"] },
          { displayName: "Nie Angemeldet", upn: "nie@example.com", lastSignIn: null, daysInactive: null, licenses: ["Microsoft 365 Business Premium"] },
          { displayName: "Selten Da", upn: "selten@example.com", lastSignIn: "2026-03-20", daysInactive: 121, licenses: ["Exchange Online (Plan 1)"] }
        ],
        multiSuite: [
          { displayName: "Doppelt Lizenziert", upn: "doppelt@example.com", licenses: ["Microsoft 365 E5", "Teams Phone Standard"], verdict: "redundant", reason: "Teams Phone Standard ist bereits in Microsoft 365 E5 enthalten" },
          { displayName: "Zwei Suiten", upn: "zweisuiten@example.com", licenses: ["Microsoft 365 Business Premium", "Microsoft 365 E3"], verdict: "check", reason: "Mehrere Basis-Suiten nebeneinander (Microsoft 365 Business Premium + Microsoft 365 E3) — Überlappung prüfen" },
          { displayName: "Telefonie Nutzer", upn: "telefonie@example.com", licenses: ["Microsoft 365 E3", "Teams Phone Standard"], verdict: "addon", reason: "Suite + Add-on(s) — übliche, notwendige Kombination (Add-ons sind nicht in der Suite enthalten)" }
        ],
        unusedPaidSeats: [
          { skuPartNumber: "SPB", name: "Microsoft 365 Business Premium", free: false, purchased: 40, assigned: 36, available: 4, capabilityStatus: "Enabled" },
          { skuPartNumber: "EXCHANGESTANDARD", name: "Exchange Online (Plan 1)", free: false, purchased: 5, assigned: 4, available: 1, capabilityStatus: "Enabled" }
        ]
      }
    });
  }
  const data = await LICENSES.runLicenseReport(t, certPemPath(t.tenantId));
  res.json({ ok: true, ...data });
}));

// ---------- Assignment-Check (read-only Zuweisungs-Audit) ----------
app.get("/api/tenants/:id/assignmentcheck", wrap(async (req, res) => {
  const t = requireTenant(req);
  if (process.env.FAKE_DEPLOY === "1") {
    return res.json({
      ok: true,
      summary: { total: 5, unassigned: 1, emptyGroup: 1, missingGroup: 1, broadAll: 1 },
      results: [
        { name: "Win - OIB - SC - Credential Management - D - Passwordless", type: "Settings Catalog", assignments: [], issues: ["unassigned"] },
        { name: "Win - OIB - ES - Encryption - D - BitLocker (OS Disk)", type: "Endpoint Security", assignments: [{ kind: "group", exclude: false, label: "AAD-DEV-KIOSK", memberCount: 0, missingGroup: false }], issues: ["emptyGroup"] },
        { name: "Alte Baseline-Policy", type: "Device Configuration", assignments: [{ kind: "group", exclude: false, label: "11111111-dead-dead-dead-111111111111", memberCount: null, missingGroup: true }], issues: ["missingGroup"] },
        { name: "Win - OIB - SC - Device Security - D - Local Security Policies", type: "Settings Catalog", assignments: [{ kind: "allDevices", exclude: false, label: "Alle Geräte", memberCount: null, missingGroup: false }], issues: ["broadAll"] },
        { name: "Win - OIB - ES - Defender Antivirus - D - AV Configuration", type: "Endpoint Security", assignments: [{ kind: "group", exclude: false, label: "AAD-DEV-STD", memberCount: 12, missingGroup: false }], issues: [] }
      ]
    });
  }
  const data = await ASSIGNCHECK.runAssignmentCheck(t, certPemPath(t.tenantId));
  res.json({ ok: true, ...data });
}));

// ---------- Autopilot-Paket-Generator ----------
const AUTOPILOT_APP_PREFIX = "IG-Autopilot-Staging";
// Graph-Application-Permissions fuer den Autopilot-Staging-Use-Case
const AUTOPILOT_PERMS = [
  "DeviceManagementServiceConfig.ReadWrite.All", // Autopilot-Geraete importieren
  "DeviceManagementManagedDevices.ReadWrite.All",
  "Group.ReadWrite.All",                          // GroupTag/Assign
  "Directory.Read.All"
];
// gebaute Pakete kurzlebig im Speicher (Download folgt direkt nach dem Bauen)
const autopilotPackages = new Map(); // token -> { zip, filename, exp }

function purgeExpiredPackages() {
  const now = Date.now();
  for (const [k, v] of autopilotPackages) if (v.exp < now) autopilotPackages.delete(k);
}

// PFX aus PEM (Key+Cert) via openssl bauen; bei Fehler null (dann PEM ins ZIP).
function pemToPfx(privatePem, certPem, password) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-cert-"));
  try {
    const keyPath = path.join(dir, "k.pem");
    const crtPath = path.join(dir, "c.pem");
    const pfxPath = path.join(dir, "out.pfx");
    fs.writeFileSync(keyPath, privatePem);
    fs.writeFileSync(crtPath, certPem);
    execFileSync("openssl", ["pkcs12", "-export", "-inkey", keyPath, "-in", crtPath,
      "-out", pfxPath, "-passout", "pass:" + password, "-legacy"], { stdio: "pipe" });
    return fs.readFileSync(pfxPath);
  } catch (e) {
    // ohne -legacy nochmal versuchen (aeltere openssl-Versionen)
    try {
      const keyPath = path.join(dir, "k.pem"), crtPath = path.join(dir, "c.pem"), pfxPath = path.join(dir, "o2.pfx");
      execFileSync("openssl", ["pkcs12", "-export", "-inkey", keyPath, "-in", crtPath, "-out", pfxPath, "-passout", "pass:" + password], { stdio: "pipe" });
      return fs.readFileSync(pfxPath);
    } catch (e2) { return null; }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* egal */ }
  }
}

/**
 * Legt eine DEDIZIERTE Autopilot-App im Tenant an (getrennt von der Management-
 * App): Graph-Autopilot-Permissions, Admin-Consent, Client Secret + self-signed
 * Zertifikat. Braucht einen delegierten Admin-Token (Device-Code).
 */
async function createAutopilotApp(token) {
  const graphSp = (await gReq(token, "GET", `/servicePrincipals?$filter=appId eq '${GRAPH_APP_ID}'`)).value[0];
  if (!graphSp) throw new Error("Microsoft-Graph Service-Principal nicht gefunden.");
  const roles = AUTOPILOT_PERMS.map(v => {
    const role = (graphSp.appRoles || []).find(x => x.value === v && (x.allowedMemberTypes || []).includes("Application"));
    if (!role) throw new Error("Graph-Permission fehlt im SP: " + v);
    return role;
  });
  const requiredResourceAccess = [{ resourceAppId: GRAPH_APP_ID, resourceAccess: roles.map(r => ({ id: r.id, type: "Role" })) }];

  let app = (await gReq(token, "GET", `/applications?$filter=displayName eq '${odataLit(AUTOPILOT_APP_PREFIX)}'`)).value[0];
  if (app) {
    await gReq(token, "PATCH", `/applications/${app.id}`, { requiredResourceAccess, signInAudience: "AzureADMyOrg" });
  } else {
    app = await gReq(token, "POST", "/applications", { displayName: AUTOPILOT_APP_PREFIX, signInAudience: "AzureADMyOrg", requiredResourceAccess });
  }
  let appSp = (await gReq(token, "GET", `/servicePrincipals?$filter=appId eq '${app.appId}'`)).value[0];
  if (!appSp) appSp = await gReq(token, "POST", "/servicePrincipals", { appId: app.appId });

  // Admin-Consent
  let consentOk = true, consentErr = null;
  try {
    const existing = (await gReq(token, "GET", `/servicePrincipals/${appSp.id}/appRoleAssignments`)).value || [];
    for (const r of roles) await ensureAppRoleAssignment(token, appSp.id, graphSp.id, r.id, existing);
  } catch (e) { consentOk = false; consentErr = e.message; }

  // Client Secret (24 Monate) — der Staging-Wrapper nutzt das Secret waehrend OOBE
  const pw = await gReq(token, "POST", `/applications/${app.id}/addPassword`, {
    passwordCredential: { displayName: AUTOPILOT_APP_PREFIX + "-secret", endDateTime: isoInMonths(24) }
  });
  const clientSecret = pw.secretText;

  // Self-signed Zertifikat (Public Key an die App, PFX ins Paket)
  const selfsigned = require("selfsigned");
  const pems = selfsigned.generate([{ name: "commonName", value: AUTOPILOT_APP_PREFIX }], { keySize: 2048, days: 730, algorithm: "sha256" });
  const certB64 = pems.cert.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const certThumbprint = crypto.createHash("sha1").update(Buffer.from(certB64, "base64")).digest("hex");
  await gReq(token, "PATCH", `/applications/${app.id}`, {
    keyCredentials: [{ type: "AsymmetricX509Cert", usage: "Verify", key: certB64, displayName: AUTOPILOT_APP_PREFIX + "-cert" }]
  });

  return {
    appId: app.appId, appObjectId: app.id, servicePrincipalId: appSp.id,
    clientSecret, secretExpiresAt: isoInMonths(24),
    certThumbprint, certExpiresAt: isoInMonths(24),
    privatePem: pems.private, certPem: pems.cert,
    consentOk, consentErr, permissions: AUTOPILOT_PERMS
  };
}

function isoInMonths(m) {
  const d = new Date();
  d.setMonth(d.getMonth() + m);
  return d.toISOString();
}

// GroupTags aus den dynamischen Security Groups des Tenants (Management-App)
app.get("/api/tenants/:id/autopilot/grouptags", wrap(async (req, res) => {
  const t = requireTenant(req);
  if (process.env.FAKE_DEPLOY === "1") {
    return res.json({ ok: true, groupTags: [
      { groupTag: "DEV-STD", groupId: "g1", groupName: "AAD-DEV-STD", rule: '... "[OrderID]:DEV-STD" ...' },
      { groupTag: "DEV-ADM", groupId: "g2", groupName: "AAD-DEV-ADM", rule: '... "[OrderID]:DEV-ADM" ...' }
    ] });
  }
  const groupTags = await AUTOPILOT.loadGroupTags(t, certPemPath(t.tenantId));
  res.json({ ok: true, groupTags });
}));

// Autopilot-App anlegen (Device-Code) + Paket bauen
app.post("/api/tenants/:id/autopilot/start", wrap(async (req, res) => {
  const s = loadState();
  const t = (s.tenants || []).find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "Tenant nicht gefunden" });
  const b = req.body || {};
  const groupTags = (Array.isArray(b.groupTags) ? b.groupTags : []).map(x => String(x)).filter(Boolean);
  if (groupTags.length === 0) return res.status(400).json({ error: "Mindestens einen GroupTag auswaehlen." });

  // Optionales WLAN-Profil (netsh-Export) fuer die autounattend.xml
  let wlanProfileXml = typeof b.wlanProfileXml === "string" ? b.wlanProfileXml : "";
  if (wlanProfileXml && (wlanProfileXml.length > 200000 || !/<WLANProfile/i.test(wlanProfileXml))) {
    return res.status(400).json({ error: "Die hochgeladene Datei ist kein gueltiges WLAN-Profil (netsh-Export)." });
  }

  const opts = { groupTags, assign: b.assign !== false, reboot: b.reboot === true, wlanProfileXml };

  if (process.env.FAKE_DEPLOY === "1") {
    req.session.autopilot = { tenantRecId: t.id, fake: true, polls: 0, opts };
    return res.json({ userCode: "FAKE-CODE", verificationUri: "https://microsoft.com/devicelogin", interval: 2 });
  }

  const loginTenant = t.organization || t.tenantId;
  const params = new URLSearchParams({
    client_id: GRAPH_CLI_CLIENT,
    scope: "Application.ReadWrite.All AppRoleAssignment.ReadWrite.All Directory.ReadWrite.All offline_access openid"
  });
  const r = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(loginTenant)}/oauth2/v2.0/devicecode`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: params
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Device-Code-Start fehlgeschlagen: " + (j.error_description || j.error || r.status));
  req.session.autopilot = {
    tenantRecId: t.id, loginTenant, opts,
    deviceCode: j.device_code, interval: (j.interval || 5),
    expiresAt: Date.now() + (j.expires_in || 900) * 1000
  };
  res.json({ userCode: j.user_code, verificationUri: j.verification_uri || "https://microsoft.com/devicelogin", interval: j.interval || 5 });
}));

app.post("/api/autopilot/poll", wrap(async (req, res) => {
  const df = req.session.autopilot;
  if (!df) return res.status(400).json({ error: "Kein laufender Autopilot-Vorgang." });

  purgeExpiredPackages();

  async function finishWith(appResult, t) {
    const pfxPassword = crypto.randomBytes(9).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 12) + "1!";
    const pfxBuffer = appResult.privatePem ? pemToPfx(appResult.privatePem, appResult.certPem, pfxPassword) : null;
    const zip = AUTOPILOT.buildAutopilotZip({
      appName: AUTOPILOT_APP_PREFIX,
      tenantId: t.tenantId, domain: t.organization,
      appId: appResult.appId, appObjectId: appResult.appObjectId, servicePrincipalId: appResult.servicePrincipalId,
      clientSecret: appResult.clientSecret, secretExpiresAt: appResult.secretExpiresAt,
      certThumbprint: appResult.certThumbprint, certExpiresAt: appResult.certExpiresAt,
      pfxPassword, consentOk: appResult.consentOk, permissions: appResult.permissions,
      createdAt: new Date().toISOString(),
      groupTags: df.opts.groupTags, assign: df.opts.assign, reboot: df.opts.reboot, wlanProfileXml: df.opts.wlanProfileXml,
      pfxBuffer, cerBuffer: pfxBuffer ? Buffer.from(appResult.certPem, "utf8") : null
    });
    const token = crypto.randomBytes(16).toString("hex");
    autopilotPackages.set(token, { zip, filename: "Autopilot-" + t.id + ".zip", exp: Date.now() + 10 * 60 * 1000 });
    delete req.session.autopilot;
    return {
      status: "done", downloadToken: token,
      appId: appResult.appId, groupTags: df.opts.groupTags,
      pfxIncluded: !!pfxBuffer, pfxPassword,
      wlanIncluded: !!df.opts.wlanProfileXml,
      warnings: appResult.consentOk ? [] : ["Admin-Consent unvollstaendig: " + (appResult.consentErr || "unbekannt")]
    };
  }

  if (df.fake) {
    df.polls = (df.polls || 0) + 1;
    if (df.polls < 2) return res.json({ status: "pending" });
    const s = loadState();
    const t = (s.tenants || []).find(x => x.id === df.tenantRecId) || { id: df.tenantRecId, tenantId: "fake", organization: "demo.onmicrosoft.com" };
    const fakeApp = {
      appId: "aaaaaaaa-1111-2222-3333-444444444444", appObjectId: "obj", servicePrincipalId: "sp",
      clientSecret: "FAKE~secret~value", secretExpiresAt: isoInMonths(24),
      certThumbprint: "ABCDEF0123456789", certExpiresAt: isoInMonths(24),
      privatePem: null, certPem: "", consentOk: true, permissions: AUTOPILOT_PERMS
    };
    return res.json(await finishWith(fakeApp, t));
  }

  if (Date.now() > df.expiresAt) { delete req.session.autopilot; return res.json({ status: "error", error: "Anmeldecode abgelaufen — bitte neu starten." }); }

  const params = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    client_id: GRAPH_CLI_CLIENT, device_code: df.deviceCode
  });
  const r = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(df.loginTenant)}/oauth2/v2.0/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: params
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (j.error === "authorization_pending") return res.json({ status: "pending" });
    if (j.error === "slow_down") { df.interval = (df.interval || 5) + 5; return res.json({ status: "pending", slowDown: true, interval: df.interval }); }
    delete req.session.autopilot;
    return res.json({ status: "error", error: j.error_description || j.error || ("HTTP " + r.status) });
  }

  const s = loadState();
  const t = (s.tenants || []).find(x => x.id === df.tenantRecId);
  if (!t) { delete req.session.autopilot; return res.json({ status: "error", error: "Tenant nicht mehr vorhanden." }); }

  const appResult = await createAutopilotApp(j.access_token);
  res.json(await finishWith(appResult, t));
}));

app.get("/api/autopilot/download/:token", (req, res) => {
  purgeExpiredPackages();
  const pkg = autopilotPackages.get(req.params.token);
  if (!pkg) return res.status(404).json({ error: "Paket nicht gefunden oder abgelaufen — bitte neu erstellen." });
  autopilotPackages.delete(req.params.token); // einmalig
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${pkg.filename}"`);
  res.send(pkg.zip);
});

// WLAN-Export-Helper (Standalone-Download) als SELBSTSTAENDIGE .cmd:
// Batch unterliegt keiner Execution Policy — es dekodiert das eingebettete
// PowerShell (base64) und startet es mit -ExecutionPolicy Bypass. So gibt es
// kein "not digitally signed"-Problem beim heruntergeladenen Einzelfile.
app.get("/api/autopilot/wlan-helper", (req, res) => {
  try {
    const ps1 = fs.readFileSync(path.join(__dirname, "assets", "autopilot", "Export-WlanProfile.ps1"), "utf8");
    const b64 = Buffer.from(ps1, "utf8").toString("base64");
    const cmd = [
      "@echo off",
      "REM WLAN-Export-Helper (M365 Security Policy Manager) — selbststaendig, ohne Signatur/Policy-Problem.",
      "setlocal",
      'set "PS1=%TEMP%\\Export-WlanProfile.ps1"',
      'set "B64=%TEMP%\\Export-WlanProfile.b64"',
      '>"%B64%" echo ' + b64,
      'certutil -decode "%B64%" "%PS1%" >nul',
      'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS1%"',
      'del "%B64%" >nul 2>&1'
    ].join("\r\n") + "\r\n";
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", 'attachment; filename="Export-WlanProfile.cmd"');
    res.send(cmd);
  } catch (e) { res.status(500).json({ error: "Helper-Skript nicht verfuegbar." }); }
});

// Autopilot-Deployment-Profile einsehen + einer Gruppe zuweisen
function fakeProfiles() {
  return {
    profiles: [
      { id: "prof1", displayName: "AP - Standard User-Driven", description: "Entra Join, OOBE minimal", deviceNameTemplate: "IG-%SERIAL%", language: "de-CH",
        assignments: [{ groupId: "g1", label: "AAD-DEV-STD" }] },
      { id: "prof2", displayName: "AP - Kiosk Self-Deploying", description: "Self-Deploying", deviceNameTemplate: "KIOSK-%RAND:4%", language: "os-default", assignments: [] }
    ]
  };
}

app.get("/api/tenants/:id/autopilot/profiles", wrap(async (req, res) => {
  const t = requireTenant(req);
  if (process.env.FAKE_DEPLOY === "1") return res.json({ ok: true, ...fakeProfiles() });
  try {
    const profiles = await Promise.race([
      AUTOPILOT.loadAutopilotProfiles(t, certPemPath(t.tenantId)),
      new Promise((_, reject) => setTimeout(
        () => reject(Object.assign(new Error("Zeitüberschreitung nach 90 s — der Intune-Dienst antwortet nicht."), { timedOut: true })), 90000))
    ]);
    writeProfileCache(t.tenantId, profiles);
    res.json({ ok: true, profiles });
  } catch (e) {
    const human = humanizeGraphError(e.message);
    // Bei Diensstoerung den letzten bekannten Stand ausliefern statt einer
    // leeren Seite -- Profile aendern sich selten, der Cache ist brauchbar.
    const transient = e.timedOut || /internal server error|error has occurred|503|500/i.test(String(e.message || ""));
    const cached = transient ? readProfileCache(t.tenantId) : null;
    if (cached) {
      return res.json({
        ok: true, profiles: cached.profiles, stale: true, cachedAt: cached.cachedAt,
        warning: human.text, warningDetail: human.detail
      });
    }
    const err = new Error(human.text);
    err.status = e.status || 502;
    err.hint = human.detail;
    err.serviceOutage = transient;
    throw err;
  }
}));

app.post("/api/tenants/:id/autopilot/profiles/:profileId/assign", wrap(async (req, res) => {
  const t = requireTenant(req);
  const groupId = String((req.body || {}).groupId || "");
  if (!groupId) return res.status(400).json({ error: "groupId erforderlich." });
  if (process.env.FAKE_DEPLOY === "1") return res.json({ ok: true, status: "assigned" });
  const status = await AUTOPILOT.assignProfileToGroup(t, certPemPath(t.tenantId), req.params.profileId, groupId);
  res.json({ ok: true, status });
}));

// Dynamische Security Groups (fuer die Profil-Zuweisung im UI)
app.get("/api/tenants/:id/groups", wrap(async (req, res) => {
  const t = requireTenant(req);
  if (process.env.FAKE_DEPLOY === "1") {
    return res.json({ ok: true, groups: [{ id: "g1", displayName: "AAD-DEV-STD" }, { id: "g2", displayName: "AAD-DEV-ADM" }] });
  }
  const groups = await GRAPHLIB.graphAllPages(t, certPemPath(t.tenantId),
    "/groups?$filter=securityEnabled eq true&$select=id,displayName&$top=200", { beta: true });
  res.json({ ok: true, groups: groups.map(g => ({ id: g.id, displayName: g.displayName })).sort((a, b) => a.displayName.localeCompare(b.displayName)) });
}));

// Autopilot-Geraete einsehen + GroupTag direkt zuweisen (keine Zusatz-
// Permission noetig, DeviceManagementServiceConfig.ReadWrite.All ist bereits vorhanden).
function fakeAutopilotDevices() {
  return {
    devices: [
      { id: "dev1", serialNumber: "PF3ABCDE", model: "Latitude 5440", manufacturer: "Dell Inc.", groupTag: "DEV-STD", enrollmentState: "enrolled", lastContactedDateTime: new Date(Date.now() - 3600e3).toISOString(), addressableUserName: "" },
      { id: "dev2", serialNumber: "5CD1234XYZ", model: "EliteBook 840", manufacturer: "HP", groupTag: "", enrollmentState: "notContacted", lastContactedDateTime: null, addressableUserName: "" },
      { id: "dev3", serialNumber: "R9K2N4P1", model: "ThinkPad T14", manufacturer: "LENOVO", groupTag: "DEV-ADM", enrollmentState: "notContacted", lastContactedDateTime: new Date(Date.now() - 86400e3 * 2).toISOString(), addressableUserName: "" }
    ]
  };
}

// windowsAutopilotDeviceIdentities antwortet bei manchen Tenants ueber Stunden
// hinweg durchgaengig mit 500 (echte MS-seitige Stoerung, kein Config-Fehler
// — real bei Faltin Travel beobachtet: jeder Reload haengt 8 Retries lang und
// scheitert dann). Letzte erfolgreiche Liste wird deshalb gecacht, damit der
// Tenant waehrend eines laengeren Ausfalls nicht komplett blockiert ist.
const AUTOPILOT_CACHE_DIR = path.join(STATE_DIR, "autopilot-cache");
fs.mkdirSync(AUTOPILOT_CACHE_DIR, { recursive: true });
function autopilotCachePath(tenantId) { return path.join(AUTOPILOT_CACHE_DIR, `${tenantId}.json`); }
function readAutopilotCache(tenantId) {
  try { return JSON.parse(fs.readFileSync(autopilotCachePath(tenantId), "utf8")); } catch { return null; }
}
function writeAutopilotCache(tenantId, devices) {
  try { fs.writeFileSync(autopilotCachePath(tenantId), JSON.stringify({ devices, cachedAt: new Date().toISOString() })); } catch { /* Cache ist best-effort */ }
}

// Profile werden genauso zwischengespeichert wie die Geraete: der
// Enrollment-Dienst hinter windowsAutopilotDeploymentProfiles faellt
// regelmaessig mit 500 aus, und ohne Profilliste ist der ganze Bereich tot.
function profileCachePath(tenantId) { return path.join(AUTOPILOT_CACHE_DIR, `${tenantId}-profiles.json`); }
function readProfileCache(tenantId) {
  try { return JSON.parse(fs.readFileSync(profileCachePath(tenantId), "utf8")); } catch { return null; }
}
function writeProfileCache(tenantId, profiles) {
  try { fs.writeFileSync(profileCachePath(tenantId), JSON.stringify({ profiles, cachedAt: new Date().toISOString() })); } catch { /* best effort */ }
}

/**
 * Fehlermeldungen der Intune-Dienste lesbar machen.
 *
 * Der Enrollment-Dienst antwortet im Fehlerfall mit einem JSON-Block
 * ({_version, Message, Operation ID, Url, ...}), den Graph unveraendert
 * durchreicht. Ungefiltert landet dieser Blob im Frontend und sagt niemandem
 * etwas. Hier wird daraus ein Satz plus die Kennungen, die Microsoft im
 * Supportfall wissen will.
 */
function humanizeGraphError(message) {
  const raw = String(message || "");
  const start = raw.indexOf("{");
  if (start === -1) return { text: raw, detail: null };
  let obj;
  try { obj = JSON.parse(raw.slice(start)); } catch (e) { return { text: raw, detail: null }; }
  const inner = String(obj.Message || obj.message || "");
  if (!inner) return { text: raw, detail: null };

  const opId = (inner.match(/Operation ID \(for customer support\):\s*([0-9a-f-]+)/i) || [])[1] || null;
  const actId = (inner.match(/Activity ID:\s*([0-9a-f-]+)/i) || [])[1] || null;
  const url = (inner.match(/Url:\s*(\S+)/i) || [])[1] || null;
  const head = inner.split(" - ")[0].trim() || "Der Dienst meldet einen Fehler.";

  return {
    text: head,
    detail: [
      opId ? "Operation ID: " + opId : null,
      actId ? "Activity ID: " + actId : null,
      url ? "Endpunkt: " + url.replace(/^https:\/\/[^/]+/, "") : null
    ].filter(Boolean).join(" · ") || null
  };
}

app.get("/api/tenants/:id/autopilot/devices", wrap(async (req, res) => {
  const t = requireTenant(req);
  if (process.env.FAKE_DEPLOY === "1") return res.json({ ok: true, ...fakeAutopilotDevices() });
  try {
    // Zeitgrenze: der Graph-Aufruf wiederholt bei transienten Fehlern und kann
    // dabei minutenlang laufen. Ohne Grenze bleibt das Frontend im Ladezustand
    // haengen, ohne dass jemand erfaehrt, woran es liegt.
    const devices = await Promise.race([
      AUTOPILOT.loadAutopilotDevices(t, certPemPath(t.tenantId)),
      new Promise((_, reject) => setTimeout(
        () => reject(Object.assign(new Error("Zeitüberschreitung nach 90 s — Microsoft Graph antwortet nicht."), { timedOut: true })),
        90000))
    ]);
    writeAutopilotCache(t.tenantId, devices);
    res.json({ ok: true, devices });
  } catch (e) {
    // Bei Timeout und bei Graph-500ern den letzten bekannten Stand ausliefern,
    // deutlich als veraltet markiert -- besser als eine leere Seite.
    const useCache = e.timedOut || /internal server error/i.test(String(e.message || ""));
    const cached = useCache ? readAutopilotCache(t.tenantId) : null;
    if (!cached) throw e;
    res.json({ ok: true, devices: cached.devices, stale: true, cachedAt: cached.cachedAt, warning: e.message });
  }
}));

app.post("/api/tenants/:id/autopilot/devices/:deviceId/grouptag", wrap(async (req, res) => {
  const t = requireTenant(req);
  const groupTag = String((req.body || {}).groupTag || "").trim();
  if (!groupTag) return res.status(400).json({ error: "groupTag erforderlich." });
  if (process.env.FAKE_DEPLOY === "1") return res.json({ ok: true });
  await AUTOPILOT.updateDeviceGroupTag(t, certPemPath(t.tenantId), req.params.deviceId, groupTag);
  res.json({ ok: true });
}));

// ---------- Verbindungstest + Deploy ----------
function requireTenant(req) {
  const s = loadState();
  const t = (s.tenants || []).find(x => x.id === req.params.id);
  if (!t) { const e = new Error("Tenant nicht gefunden"); e.status = 404; throw e; }
  if (!t.organization) { const e = new Error("Keine onmicrosoft-Domain fuer den Tenant hinterlegt — bitte neu onboarden."); e.status = 412; throw e; }
  if (!fs.existsSync(certPemPath(t.tenantId))) { const e = new Error("Kein Zertifikat hinterlegt — Tenant neu onboarden."); e.status = 412; throw e; }
  return t;
}

// Verbindungstest: EXO app-only verbinden und Accepted Domains lesen.
app.post("/api/tenants/:id/test", wrap(async (req, res) => {
  const t = requireTenant(req);
  const body = [
    "$doms = @(Get-AcceptedDomain | ForEach-Object DomainName)",
    "Write-Output ('BEGINJSON' + (@{ ok = $true; domains = $doms } | ConvertTo-Json -Compress) + 'ENDJSON')"
  ].join("\r\n");
  const r = await EXO.runExo({ appId: t.clientId, organization: t.organization, certPemPath: certPemPath(t.tenantId) }, body, 120000);
  if (!r.ok) return res.status(502).json({ error: "EXO-Runner: " + r.error });
  if (!r.data || r.data.ok === false) return res.status(502).json({ error: (r.data && r.data.error) || "Verbindungstest fehlgeschlagen", hint: "Frische App-Registrierungen brauchen ein paar Minuten Replikationszeit." });
  res.json({ ok: true, domains: r.data.domains || [] });
}));

// ---------- Vorlage pro Tenant ----------
// Die Vorlage (Domains, Admin-/MSP-Adresse, Policy-Werte) lag bisher nur im
// Browser-Tab: nach einem Reload stand wieder example.com da, und wer mehrere
// Kunden betreut, tippte die Werte bei jedem Wechsel neu. Sie wird deshalb pro
// Tenant im State abgelegt — keine Geheimnisse, nur Domains, Mailadressen und
// Policy-Werte.
const TENANT_CONFIG_MAX_BYTES = 100 * 1024;

app.get("/api/tenants/:id/config", (req, res) => {
  const s = loadState();
  const t = (s.tenants || []).find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "Tenant nicht gefunden" });
  res.json({ ok: true, config: t.config || null, savedAt: t.configSavedAt || null });
});

app.put("/api/tenants/:id/config", (req, res) => {
  const s = loadState();
  const idx = (s.tenants || []).findIndex(x => x.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: "Tenant nicht gefunden" });

  const cfg = req.body && req.body.config;
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
    return res.status(400).json({ error: "Keine Konfiguration uebergeben." });
  }
  if (Buffer.byteLength(JSON.stringify(cfg), "utf8") > TENANT_CONFIG_MAX_BYTES) {
    return res.status(413).json({ error: "Konfiguration zu gross." });
  }
  // Bewusst ohne sanitizeConfig: hier darf auch ein Zwischenstand liegen, der
  // noch nicht deploybar ist. Geprueft wird beim Deploy, nicht beim Speichern.
  s.tenants[idx].config = cfg;
  s.tenants[idx].configSavedAt = new Date().toISOString();
  saveState(s);
  res.json({ ok: true, savedAt: s.tenants[idx].configSavedAt });
});

app.delete("/api/tenants/:id/config", (req, res) => {
  const s = loadState();
  const idx = (s.tenants || []).findIndex(x => x.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: "Tenant nicht gefunden" });
  delete s.tenants[idx].config;
  delete s.tenants[idx].configSavedAt;
  saveState(s);
  res.json({ ok: true });
});

// Pruefsnippet: Ist das SCHREIBENDE Policy-Cmdlet freigegeben?
//
// Ein lesendes Get-QuarantinePolicy taugt dafuer nicht — in dehydrierten
// Tenants antwortet es normal, waehrend New-/Set- weiterhin gesperrt sind.
// Getestet wird deshalb mit -WhatIf, also einem Trockenlauf: das Cmdlet
// durchlaeuft serverseitig Berechtigungs- und Hydration-Pruefung, legt aber
// nichts an. Als Sicherheitsnetz wird hinterher geprueft, ob wider Erwarten
// doch etwas entstanden ist, und das dann wieder entfernt.
const ORG_PROBE_PS = [
  "$probeName = 'BP_Probe_OrgCustomizationCheck'",
  "$writeOk = $false; $writeError = $null; $whatIfUnsupported = $false; $probeLeftOver = $false",
  "try {",
  "  New-QuarantinePolicy -Name $probeName -EndUserQuarantinePermissionsValue 0 -WhatIf -ErrorAction Stop | Out-Null",
  "  $writeOk = $true",
  "} catch {",
  "  $writeError = $_.Exception.Message",
  "  if ($writeError -match \"parameter name 'WhatIf'\" -or $writeError -match 'A parameter cannot be found') { $whatIfUnsupported = $true }",
  "}",
  "try {",
  "  $left = Get-QuarantinePolicy -Identity $probeName -ErrorAction SilentlyContinue",
  "  if ($left) { $probeLeftOver = $true; Remove-QuarantinePolicy -Identity $probeName -Confirm:$false -ErrorAction SilentlyContinue }",
  "} catch { }",
  "$readOk = $false",
  "try { Get-QuarantinePolicy -ErrorAction Stop | Out-Null; $readOk = $true } catch { }"
].join("\r\n");

// Nur pruefen, nichts schreiben: sind die Policy-Cmdlets inzwischen frei?
// Nach Enable-OrganizationCustomization dauert es bis zu 4 Stunden, bis die
// Freischaltung durchgezogen ist. Damit laesst sich das ueberwachen, ohne
// jedes Mal den schreibenden Endpunkt anzufassen.
app.get("/api/tenants/:id/org-customization-status", wrap(async (req, res) => {
  const t = requireTenant(req);
  const body = [
    "$cfg = Get-OrganizationConfig -ErrorAction Stop",
    ORG_PROBE_PS,
    "Write-Output ('BEGINJSON' + (@{ ok = $true; isDehydrated = [bool]$cfg.IsDehydrated; cmdletOk = $writeOk; readOk = $readOk;",
    "  cmdletError = $writeError; whatIfUnsupported = $whatIfUnsupported; probeLeftOver = $probeLeftOver } | ConvertTo-Json -Compress) + 'ENDJSON')"
  ].join("\r\n");
  const r = await EXO.runExo({ appId: t.clientId, organization: t.organization, certPemPath: certPemPath(t.tenantId) }, body, 180000);
  if (!r.ok) return res.status(502).json({ error: "EXO-Runner: " + r.error });
  if (!r.data || r.data.ok === false) return res.status(502).json({ error: (r.data && r.data.error) || "Prüfung fehlgeschlagen" });
  res.json({
    ok: true,
    isDehydrated: !!r.data.isDehydrated,
    // "ready" heisst: das schreibende Cmdlet laeuft durch. Nur darauf kommt es an.
    ready: !!r.data.cmdletOk,
    readOk: !!r.data.readOk,
    cmdletError: r.data.cmdletError || null,
    whatIfUnsupported: !!r.data.whatIfUnsupported,
    probeLeftOver: !!r.data.probeLeftOver,
    checkedAt: new Date().toISOString()
  });
}));

// Organisationsanpassung aktivieren (Enable-OrganizationCustomization).
// Schreibender Eingriff im Kundentenant und nicht rueckgaengig zu machen —
// wird deshalb NIE automatisch im Deploy mitgemacht, sondern nur ueber diesen
// Endpunkt nach ausdruecklicher Bestaetigung im Frontend. Ohne ihn sperrt EXO
// in dehydrierten Tenants saemtliche eigenen Policies.
app.post("/api/tenants/:id/enable-org-customization", wrap(async (req, res) => {
  const t = requireTenant(req);
  // IsDehydrated allein sagt nur, ob Enable-OrganizationCustomization
  // ANGESTOSSEN wurde — nicht, ob die Cmdlets schon freigegeben sind. Die
  // Freischaltung zieht im Hintergrund durch (bis zu 4 Stunden); in der
  // Zwischenzeit meldet sich die Organisation als angepasst, waehrend
  // New-QuarantinePolicy weiter blockt. Deshalb zusaetzlich ein echter
  // Funktionstest mit einem lesenden Cmdlet aus derselben Familie.
  const body = [
    "$cfg = Get-OrganizationConfig -ErrorAction Stop",
    "$dehydrated = [bool]$cfg.IsDehydrated",
    "$enabled = $false; $err = $null",
    "if ($dehydrated) {",
    "  try { Enable-OrganizationCustomization -ErrorAction Stop; $enabled = $true }",
    "  catch {",
    "    $m = $_.Exception.Message",
    "    if ($m -match 'already been enabled' -or $m -match 'is already') { $enabled = $false }",
    "    else { $err = $m }",
    "  }",
    "}",
    "# Funktionstest mit dem SCHREIBENDEN Cmdlet (Trockenlauf) — lesend sagt nichts aus.",
    ORG_PROBE_PS,
    "Write-Output ('BEGINJSON' + (@{",
    "  ok = ($null -eq $err); error = $err;",
    "  wasDehydrated = $dehydrated; enabled = $enabled;",
    "  cmdletOk = $writeOk; readOk = $readOk; cmdletError = $writeError;",
    "  whatIfUnsupported = $whatIfUnsupported; probeLeftOver = $probeLeftOver",
    "} | ConvertTo-Json -Compress) + 'ENDJSON')"
  ].join("\r\n");
  const r = await EXO.runExo({ appId: t.clientId, organization: t.organization, certPemPath: certPemPath(t.tenantId) }, body, 300000);
  if (!r.ok) return res.status(502).json({ error: "EXO-Runner: " + r.error });
  if (!r.data || r.data.ok === false) return res.status(502).json({ error: (r.data && r.data.error) || "Enable-OrganizationCustomization fehlgeschlagen" });

  const d = r.data;
  let hint;
  if (d.whatIfUnsupported) {
    hint = "Konnte nicht sicher geprüft werden: New-QuarantinePolicy kennt hier kein -WhatIf. "
         + "Deploy starten und schauen, ob er durchläuft.";
  } else if (d.cmdletOk && d.enabled) {
    hint = "Freischaltung angestossen und bereits wirksam — Deploy kann laufen.";
  } else if (d.cmdletOk) {
    hint = "Organisationsanpassung ist aktiv und das Anlegen von Policies funktioniert — Deploy kann laufen.";
  } else if (d.enabled) {
    hint = "Freischaltung angestossen, aber noch nicht wirksam: die Policy-Cmdlets sind weiterhin gesperrt. "
         + "Das kann bis zu 4 Stunden dauern. Danach Deploy erneut starten.";
  } else if (!d.wasDehydrated) {
    // Genau der scheinbare Widerspruch: Organisation meldet sich als angepasst,
    // die schreibenden Cmdlets bleiben trotzdem gesperrt.
    hint = "Die Organisation meldet sich als angepasst (IsDehydrated = false)"
         + (d.readOk ? " und Policies lassen sich lesen" : "")
         + ", das Anlegen ist aber weiterhin gesperrt. Die Freischaltung wurde also schon angestossen und ist noch nicht "
         + "durchgezogen — das dauert bis zu 4 Stunden."
         + (d.cmdletError ? " Meldung von Exchange: " + String(d.cmdletError).slice(0, 300) : "");
  } else {
    hint = "Enable-OrganizationCustomization lief bereits, die Policy-Cmdlets sind aber noch gesperrt. "
         + "Bis zu 4 Stunden warten, dann Deploy erneut starten.";
  }

  res.json({
    ok: true,
    wasDehydrated: !!d.wasDehydrated,
    enabled: !!d.enabled,
    cmdletOk: !!d.cmdletOk,
    cmdletError: d.cmdletError || null,
    hint
  });
}));

// ---------- Deploy-Jobs (asynchron, Fortschritt via Polling) ----------
const jobs = new Map(); // jobId -> Job
const JOB_KEEP = 20;

function createJob(t) {
  const id = crypto.randomBytes(8).toString("hex");
  const steps = [];
  for (const ph of DEPLOY.DEPLOY_PLAN) for (const name of ph.steps) steps.push({ phase: ph.phase, name, state: "pending" });
  const job = {
    id, tenantId: t.id, tenantName: t.name,
    status: "running", phase: "Vorbereitung", steps,
    domains: null, error: null, hint: null,
    startedAt: new Date().toISOString(), finishedAt: null
  };
  // Alte fertige Jobs wegwerfen, damit die Map nicht waechst
  if (jobs.size >= JOB_KEEP) {
    for (const [k, j] of jobs) {
      if (jobs.size < JOB_KEEP) break;
      if (j.status !== "running") jobs.delete(k);
    }
  }
  jobs.set(id, job);
  return job;
}

// Progress-Events aus dem pwsh-Stream in den Job uebertragen
function jobProgressHandler(job) {
  return (evt) => {
    if (!evt || typeof evt !== "object") return;
    // Nach einem Abbruch nichts mehr am Job aendern: der PowerShell-Prozess
    // kann noch Marker nachliefern, bevor der Kill greift.
    if (job.status === "cancelled") return;
    if (evt.type === "phase" && evt.label) { job.phase = String(evt.label); return; }
    if (evt.type === "step" && evt.name) {
      let st = job.steps.find(s => s.name === evt.name);
      if (!st) { st = { phase: job.phase, name: String(evt.name), state: "pending" }; job.steps.push(st); }
      if (evt.state === "running") { st.state = "running"; st.try = evt.try || 1; }
      else if (evt.state === "retry") { st.state = "retry"; st.try = evt.try; st.lastError = evt.error; }
      else if (evt.state === "done") { st.state = "done"; st.action = evt.action; st.tries = evt.tries; }
      else if (evt.state === "failed") {
        st.state = "failed"; st.error = evt.error; st.tries = evt.tries;
        if (evt.hint) st.hint = evt.hint;
        if (evt.needsOrgCustomization) { st.needsOrgCustomization = true; job.needsOrgCustomization = true; }
      }
    }
  };
}

// Endergebnis eines Laufs als Fallback in die Job-Steps mergen
// (falls einzelne Progress-Marker im Stream verloren gingen).
function mergeStepResults(job, resultSteps) {
  for (const s of resultSteps || []) {
    const st = job.steps.find(x => x.name === s.name);
    if (!st) continue;
    if (st.state !== "done" && st.state !== "failed") {
      st.state = s.ok ? "done" : "failed";
      st.action = s.action; st.error = s.error; st.tries = s.tries;
      if (s.hint) st.hint = s.hint;
      if (s.needsOrgCustomization) { st.needsOrgCustomization = true; job.needsOrgCustomization = true; }
    }
  }
}

function finishJob(job) {
  // Ein abgebrochener Job bleibt abgebrochen — sonst ueberschreibt der
  // auslaufende Lauf den Abbruch mit "partial"/"done".
  if (job.status === "cancelled") return;
  job.phase = "Fertig";
  // "manual" zaehlt nicht als Fehlschlag — der Schritt ist bewusst dem Admin ueberlassen.
  job.status = job.steps.every(s => s.state === "done" || s.state === "manual") ? "done" : "partial";
  job.finishedAt = new Date().toISOString();
}

async function runDeployJob(job, t, cfg) {
  const auth = { appId: t.clientId, organization: t.organization, certPemPath: certPemPath(t.tenantId) };
  const onProgress = jobProgressHandler(job);

  // Dev-Simulation fuer UI-Tests ohne echten Tenant (FAKE_DEPLOY=1 — nie in Prod setzen)
  if (process.env.FAKE_DEPLOY === "1") return fakeDeployJob(job, onProgress, cfg);

  // Kindprozess am Job merken, damit /api/jobs/:id/cancel ihn beenden kann.
  const r = await EXO.runExo(auth, DEPLOY.buildDeployBody(cfg), 600000, onProgress, (child) => { job.child = child; });
  job.child = null;
  if (job.status === "cancelled") { job.finishedAt = job.finishedAt || new Date().toISOString(); return; }
  if (!r.ok || !r.data || r.data.ok === false) {
    job.status = "failed";
    job.error = (r.data && r.data.error) || r.error || "Deploy fehlgeschlagen";
    // Dehydrierter Tenant hat eine eigene Ursache und einen eigenen Weg raus —
    // der Standardhinweis auf Rollen/Replikation waere hier irrefuehrend.
    if (r.data && r.data.needsOrgCustomization) {
      job.needsOrgCustomization = true;
      job.hint = "Enable-OrganizationCustomization muss einmalig im Tenant laufen (siehe Knopf unten).";
    } else {
      job.hint = "Braucht Exchange.ManageAsApp + Exchange-Administrator-Rolle (Tenant neu onboarden). Frische App-Registrierungen brauchen ein paar Minuten Replikationszeit.";
    }
    job.finishedAt = new Date().toISOString();
    return;
  }
  job.domains = r.data.domains || [];
  mergeStepResults(job, r.data.steps);

  // Alert Policy: Security & Compliance PowerShell ist auf Linux nicht verfuegbar
  // (Microsoft-Doku) — der Schritt wird als MANUELL markiert und bekommt ein
  // fertiges Snippet fuer die einmalige Ausfuehrung auf einem Windows-Rechner.
  markAlertStepManual(job, cfg);
  finishJob(job);
}

function markAlertStepManual(job, cfg) {
  const st = job.steps.find(s => s.name === "Alert-Policy Quarantine-Release");
  if (!st) return;
  st.state = "manual";
  st.info = "Security & Compliance PowerShell (Connect-IPPSSession) ist auf Linux nicht verfuegbar — einmalig pro Tenant auf einem Windows-Rechner ausfuehren.";
  st.snippet = DEPLOY.buildAlertPolicySnippet(cfg);
}

// Simulierter Deploy (nur fuer lokale UI-Entwicklung, FAKE_DEPLOY=1)
async function fakeDeployJob(job, onProgress, cfg) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  onProgress({ type: "phase", label: "Verbindung zu Exchange Online" });
  await sleep(1500);
  for (const ph of DEPLOY.DEPLOY_PLAN) {
    onProgress({ type: "phase", label: ph.phase });
    for (const name of ph.steps) {
      if (name === "Alert-Policy Quarantine-Release") continue; // wird unten als manual markiert
      onProgress({ type: "step", name, state: "running", try: 1 });
      await sleep(900);
      if (name === "Anti-Phishing-Policy") {
        onProgress({ type: "step", name, state: "retry", try: 2, error: "quarantine tag not present (simuliert)" });
        await sleep(1200);
      }
      if (name === "Anti-Malware-Rule") {
        onProgress({ type: "step", name, state: "failed", error: "Simulierter Fehler fuer UI-Test" });
        continue;
      }
      onProgress({ type: "step", name, state: "done", action: "created", tries: name === "Anti-Phishing-Policy" ? 2 : 1 });
    }
  }
  job.domains = ["demo.ch", "demo.onmicrosoft.com"];
  markAlertStepManual(job, cfg);
  finishJob(job);
}

// Simulierter Audit (nur fuer lokale UI-Entwicklung, FAKE_DEPLOY=1)
function fakeAudit() {
  return {
    acceptedDomains: ["demo.ch", "demo.onmicrosoft.com"],
    quarantineSelf: { Name: "BP_Quarantine-SelfReleaseNotification", ESNEnabled: true, IncludeMessagesFromBlockedSenderAddress: true, Permissions: "PermissionToAllowSender: True, PermissionToBlockSender: True, PermissionToRequestRelease: True, PermissionToRelease: False, PermissionToPreview: True, PermissionToDelete: True" },
    quarantineRequest: null, // simuliert: fehlt
    antiPhish: { Name: "BP_AntiPhishing", Enabled: true, EnableSpoofIntelligence: true, EnableFirstContactSafetyTips: true, EnableUnauthenticatedSender: true, EnableViaTag: true, HonorDmarcPolicy: true, DmarcQuarantineAction: "Quarantine", DmarcRejectAction: "Reject", AuthenticationFailAction: "MoveToJmf", SpoofQuarantineTag: "BP_Quarantine-SelfReleaseNotification" },
    antiPhishRule: { Name: "BP_AntiPhishing_Rule", State: "Enabled", Priority: 0, RecipientDomainIs: ["example.com", "example.onmicrosoft.com"] },
    antiSpam: { Name: "BP_AntiSpam_Inbound", BulkThreshold: 7, SpamAction: "Quarantine", HighConfidenceSpamAction: "Quarantine", BulkSpamAction: "MoveToJmf", PhishSpamAction: "Quarantine", HighConfidencePhishAction: "Quarantine", QuarantineRetentionPeriod: 30, SpamQuarantineTag: "BP_Quarantine-SelfReleaseNotification", HighConfidenceSpamQuarantineTag: "BP_Quarantine-SelfReleaseNotification", BulkQuarantineTag: "BP_Quarantine-SelfReleaseNotification", PhishQuarantineTag: "BP_Quarantine-SelfReleaseNotification", HighConfidencePhishQuarantineTag: "BP_Quarantine-RequestReleaseNotification", IncreaseScoreWithBizOrInfoUrls: "On", IncreaseScoreWithNumericIps: "On", IncreaseScoreWithRedirectToOtherPort: "On", MarkAsSpamEmptyMessages: "On", MarkAsSpamJavaScriptInHtml: "On", MarkAsSpamFramesInHtml: "On", MarkAsSpamSensitiveWordList: "On", MarkAsSpamSpfRecordHardFail: "On", MarkAsSpamFromAddressAuthFail: "On" },
    antiSpamRule: { Name: "BP_AntiSpam_Inbound_Rule", State: "Enabled", Priority: 0, RecipientDomainIs: ["demo.ch", "demo.onmicrosoft.com"] },
    malware: { Name: "BP_AntiMalware", EnableFileFilter: true, FileTypes: ["ace", "apk", "exe", "ps1"], ZapEnabled: true, QuarantineTag: "BP_Quarantine-RequestReleaseNotification", InternalSenderAdminAddress: "admin@example.com", ExternalSenderAdminAddress: "admin@example.com", EnableInternalSenderAdminNotifications: true, EnableExternalSenderAdminNotifications: true },
    malwareRule: { Name: "BP_AntiMalware_Rule", State: "Enabled", Priority: 0, RecipientDomainIs: ["demo.ch", "demo.onmicrosoft.com"] }
  };
}

// Simulierter SPF/DKIM/DMARC-Check (nur fuer lokale UI-Entwicklung, FAKE_DEPLOY=1)
function fakeDomainAuth() {
  return [
    { domain: "demo.ch", spf: { status: "ok", record: "v=spf1 include:spf.protection.outlook.com -all", issues: [] },
      dmarc: { status: "warn", record: "v=DMARC1; p=none", policy: "none", pct: 100, issues: ['Policy "p=none" ist reines Monitoring — Spoofing wird noch NICHT blockiert.'] },
      dkim: { status: "ok", enabledInM365: true, cnamesPublished: true, selector1: "selector1-demo-ch._domainkey.demo.onmicrosoft.com", selector2: "selector2-demo-ch._domainkey.demo.onmicrosoft.com", issues: [] } },
    { domain: "demo.onmicrosoft.com", spf: { status: "ok", record: "v=spf1 include:spf.protection.outlook.com -all", issues: [] },
      dmarc: { status: "bad", record: null, policy: null, issues: ["Kein DMARC-Record unter _dmarc.demo.onmicrosoft.com gefunden."] },
      dkim: { status: "bad", enabledInM365: true, cnamesPublished: false, selector1: null, selector2: null, issues: ["DKIM ist in Exchange Online aktiviert, aber die CNAME-Records (selector1/selector2._domainkey) sind im öffentlichen DNS nicht auffindbar — Mails werden trotzdem NICHT signiert."] } }
  ];
}

// Live-Deploy starten: legt einen Job an und antwortet sofort mit der Job-Id.
// Die UI pollt /api/jobs/:id fuer den Live-Fortschritt.
// Platzhalter-Werte duerfen NIE in einen echten Tenant deployt werden — die
// Vorlage kommt mit example.com-Beispielen, die der Admin ersetzen muss.
function findPlaceholderValues(cfg) {
  // Feldnamen des SANITISIERTEN cfg (deploy.js): domains (inkl. gemergter
  // onmicrosoft-Domain), adminEmail, mspEmail.
  const bad = [];
  const isPlaceholder = v => /(^|[@.])example\.(com|de|org|net)$/i.test(String(v || "").trim());
  for (const d of (cfg.domains || [])) if (isPlaceholder(d)) bad.push(`Domain "${d}"`);
  if (isPlaceholder(cfg.adminEmail)) bad.push(`Admin-Email "${cfg.adminEmail}"`);
  if (isPlaceholder(cfg.mspEmail)) bad.push(`MSP-Alert-Email "${cfg.mspEmail}"`);
  return bad;
}

app.post("/api/tenants/:id/deploy", wrap(async (req, res) => {
  const t = requireTenant(req);
  const b = req.body || {};
  let cfg;
  try { cfg = DEPLOY.sanitizeConfig(b.config); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  // autoDomains: Rules bekommen die Accepted Domains des Ziel-Tenants
  // (Get-AcceptedDomain zur Laufzeit) statt der Domains aus der Tool-Config.
  if (b.autoDomains) cfg.domains = [];

  const placeholders = findPlaceholderValues(cfg);
  if (placeholders.length) {
    return res.status(400).json({
      error: "Platzhalter-Werte in der Vorlage — bitte im Tab '⚙️ Vorlage' anpassen, bevor deployt wird: " + placeholders.join(", ")
    });
  }

  for (const j of jobs.values()) {
    if (j.tenantId === t.id && j.status === "running") {
      return res.status(409).json({ error: "Fuer diesen Tenant laeuft bereits ein Deploy.", jobId: j.id });
    }
  }

  const job = createJob(t);
  runDeployJob(job, t, cfg).catch(e => {
    job.status = "failed"; job.error = e.message; job.finishedAt = new Date().toISOString();
  });
  res.json({ ok: true, jobId: job.id });
}));

// job.child ist der laufende pwsh-Prozess — der darf nie in die Antwort, sonst
// scheitert die Serialisierung. Deshalb geht jede Job-Ausgabe hier durch.
function publicJob(job) {
  if (!job) return null;
  const { child, ...rest } = job;
  return rest;
}

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job nicht gefunden (Backend neu gestartet?)" });
  res.json(publicJob(job));
});

// Laufender bzw. letzter Deploy eines Tenants. Ohne das war ein Deploy nach
// einem Reload unsichtbar: die Job-Id lebte nur im Browser-Tab, und ein Neustart
// lief in "Fuer diesen Tenant laeuft bereits ein Deploy" ohne Weg zum Status.
app.get("/api/tenants/:id/deploy/active", (req, res) => {
  const list = [...jobs.values()].filter(j => j.tenantId === req.params.id);
  const running = list.find(j => j.status === "running");
  const latest = list.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0] || null;
  res.json({ ok: true, job: publicJob(running || latest || null), running: !!running });
});

// Laufenden Deploy abbrechen: beendet den pwsh-Prozess. Was bis dahin in
// Exchange Online geschrieben wurde, bleibt geschrieben — die Schritte sind
// idempotent, ein erneuter Deploy zieht den Rest nach.
app.post("/api/jobs/:id/cancel", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job nicht gefunden (Backend neu gestartet?)" });
  if (job.status !== "running") return res.status(409).json({ error: "Dieser Job läuft nicht mehr.", status: job.status });

  job.cancelRequested = true;
  let killed = false;
  if (job.child) {
    try { job.child.kill(); killed = true; } catch (e) { /* Prozess schon weg */ }
  }
  job.status = "cancelled";
  job.error = "Vom Benutzer abgebrochen." + (killed ? "" : " (Der PowerShell-Prozess war bereits beendet.)");
  job.finishedAt = new Date().toISOString();
  for (const s of job.steps) {
    if (s.state === "running" || s.state === "retry") {
      s.state = "failed";
      s.error = "abgebrochen";
    }
  }
  res.json({ ok: true, killed });
});

// ---------- App-Deployment-Jobs: Agent (Bitdefender/N-sight) -> Intune-Win32-App ----------
// Zielgruppe ist immer AAD-APP-<Name> (siehe lib/appGroups.js); die gewaehlte
// dynamische GroupTag-Geraetegruppe wird als Mitglied genestet, damit ihre
// Geraete transitiv adressiert werden (Intune unterstuetzt das fuer App-Assignment).
const appJobs = new Map(); // jobId -> Job
const APPDEPLOY_PHASES = ["Installer holen", "Gruppen vorbereiten", "App erzeugen & hochladen", "Veröffentlichen & zuweisen"];

function createAppJob(t, phaseNames) {
  const id = crypto.randomBytes(8).toString("hex");
  const steps = phaseNames.map(name => ({ phase: name, name, state: "pending" }));
  const job = {
    id, tenantId: t.id, tenantName: t.name,
    status: "running", phase: phaseNames[0] || "Vorbereitung", steps,
    appId: null, appGroupName: null, deviceGroupName: null, error: null, hint: null,
    startedAt: new Date().toISOString(), finishedAt: null
  };
  if (appJobs.size >= 20) {
    for (const [k, j] of appJobs) { if (appJobs.size < 20) break; if (j.status !== "running") appJobs.delete(k); }
  }
  appJobs.set(id, job);
  return job;
}

// Feingranularer, linearer Fortschritt: jedes neue Label wird ein eigener
// Schritt; vorherige "running"-Schritte gelten dann automatisch als erledigt.
function appJobProgress(job) {
  return (label, extra) => {
    let st = job.steps.find(s => s.name === label);
    if (!st) { st = { phase: label, name: label, state: "pending" }; job.steps.push(st); }
    for (const s of job.steps) {
      if (s === st) break;
      if (s.state === "running") s.state = "done";
    }
    job.phase = label;
    st.state = "running";
    if (extra && extra.total) st.detail = `${extra.done}/${extra.total} Chunks`;
  };
}

function finishAppJob(job, ok, error, hint) {
  for (const s of job.steps) { if (s.state === "running") s.state = "done"; }
  job.status = ok ? "done" : "failed";
  if (!ok) { job.error = error; job.hint = hint || null; }
  job.finishedAt = new Date().toISOString();
}

app.get("/api/appjobs/:id", (req, res) => {
  const job = appJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job nicht gefunden (Backend neu gestartet?)" });
  // _child ist der laufende pwsh-Prozess (Maester) — gehoert nie in die Antwort.
  const { _child, ...rest } = job;
  res.json(rest);
});

const APP_PUBLISHER_BY_VENDOR = { bitdefender: "Bitdefender", forticlient: "Fortinet" };

function buildWin32AppPayload(b, fileName) {
  const rules = [b.detection && b.detection.type === "registry"
    ? {
        "@odata.type": "microsoft.graph.win32LobAppRegistryRule",
        ruleType: "detection", check32BitOn64System: true,
        keyPath: (b.detection.keyPath || "").trim(), valueName: (b.detection.valueName || "").trim(),
        operationType: "exists"
      }
    : {
        "@odata.type": "microsoft.graph.win32LobAppFileSystemRule",
        ruleType: "detection", check32BitOn64System: true,
        path: (b.detection && b.detection.path || "").trim(), fileOrFolderName: (b.detection && b.detection.fileOrFolderName || "").trim(),
        operationType: "exists"
      }];
  return {
    "@odata.type": "#microsoft.graph.win32LobApp",
    displayName: b.appName,
    description: b.description || "",
    publisher: APP_PUBLISHER_BY_VENDOR[b.vendor] || "N-able (N-sight RMM)",
    // fileName (mobileLobApp) und setupFilePath (win32LobApp) sind ZWEI verschiedene
    // Felder. fileName ist der PAKET-Name — das IntuneWin32App-Modul sendet hier
    // immer "IntunePackage.intunewin", nie den Setup-Dateinamen (der kann bei
    // Bitdefender 150+ Zeichen mit Klammern sein und gehoert nur in setupFilePath).
    fileName: WIN32APP.INTUNE_PACKAGE_NAME,
    installCommandLine: b.installCommandLine,
    uninstallCommandLine: b.uninstallCommandLine,
    // windowsArchitecture ist ein Flags-Enum (none/x86/x64/arm/neutral) -- RMM-/AV-Agents
    // wie Bitdefender und N-sight liefern real nur x64- und ARM64-Builds aus, nie x86.
    applicableArchitectures: "x64, arm",
    installExperience: { "@odata.type": "microsoft.graph.win32LobAppInstallExperience", runAsAccount: "system", deviceRestartBehavior: "suppress" },
    // Standard-MSI-/Installer-Rueckgabecodes (Quelle: Microsoft Learn win32LobAppReturnCode
    // + gaengige RMM-/AV-Installer-Doku) -- ohne diese wertet Intune z.B. 3010 (Soft Reboot
    // noetig) faelschlich als Fehlschlag statt als Erfolg mit ausstehendem Neustart.
    returnCodes: [
      { "@odata.type": "microsoft.graph.win32LobAppReturnCode", returnCode: 0, type: "success" },
      { "@odata.type": "microsoft.graph.win32LobAppReturnCode", returnCode: 1707, type: "success" },
      { "@odata.type": "microsoft.graph.win32LobAppReturnCode", returnCode: 3010, type: "softReboot" },
      { "@odata.type": "microsoft.graph.win32LobAppReturnCode", returnCode: 1641, type: "hardReboot" },
      { "@odata.type": "microsoft.graph.win32LobAppReturnCode", returnCode: 1618, type: "retry" }
    ],
    rules,
    setupFilePath: fileName,
    // "Windows10_1607" (vorheriger Wert) ist kein gueltiger Wert -- Graph lehnt es mit
    // "Unknown MinimumSupportedWindowsRelease" ab. Das Namensschema wechselt ab 21H2
    // von kurzen Strings ("1607".."21H1") auf "Windows10_"/"Windows11_"-Praefixe; wir
    // setzen hier bewusst die niedrigste Version in diesem gueltigen Schema, die noch
    // deutlich unter jedem real verwalteten Geraet 2026 liegt (Quelle: MSEndpointMgr/
    // IntuneWin32App-Modul, New-IntuneWin32AppRequirementRule.ps1 OperatingSystemTable).
    minimumSupportedWindowsRelease: "Windows10_21H2"
  };
}

async function runAppDeployJob(job, t, b) {
  const onProgress = appJobProgress(job);
  const cert = certPemPath(t.tenantId);
  try {
    onProgress("Installer holen");
    let buffer, fileName, extraFiles;
    if (process.env.FAKE_DEPLOY === "1") {
      await new Promise(r => setTimeout(r, 800));
      buffer = Buffer.from("Fake-Installer-Bytes fuer UI-Test — kein echtes Graph-Upload.");
      fileName = b.vendor === "bitdefender" ? "BitdefenderSetup.exe" : b.vendor === "forticlient" ? "forticlient.msi" : "RMM-Agent-Setup.exe";
      if (b.vendor === "forticlient") extraFiles = [{ name: "forticlient.mst", data: Buffer.from("Fake-MST") }];
    } else if (b.vendor === "bitdefender") {
      ({ buffer, fileName } = await BD.fetchInstallerBuffer(b.source.downloadUrl));
    } else if (b.vendor === "forticlient") {
      // Kein API bei FortiClient EMS -- Admin gibt die site-spezifische
      // Ordner-URL an, dort liegt bereits ein von EMS vorkonfiguriertes
      // MSI+MST-Paar (die .mst-Datei enthaelt die EMS-Server-/Site-Registrierung).
      const { msiBuffer, mstBuffer, msiName, mstName } = await FORTICLIENT.fetchInstallerFiles((b.source || {}).baseUrl);
      buffer = msiBuffer; fileName = msiName;
      extraFiles = [{ name: mstName, data: mstBuffer }];
    } else {
      ({ buffer, fileName } = await NSIGHT.downloadAgentBuffer(b.source || {}));
    }

    onProgress("Gruppen vorbereiten");
    let appGroupId, deviceGroupName;
    if (process.env.FAKE_DEPLOY === "1") {
      await new Promise(r => setTimeout(r, 600));
      appGroupId = "fake-app-group"; deviceGroupName = "AAD-" + (b.groupTag || "DEV-STD");
    } else {
      const tags = await AUTOPILOT.loadGroupTags(t, cert);
      const match = tags.find(g => g.groupTag === b.groupTag);
      if (!match) throw new Error("GroupTag '" + b.groupTag + "' nicht (mehr) unter den dynamischen Gruppen gefunden.");
      deviceGroupName = match.groupName;
      const appGroup = await APPGROUPS.ensureAppGroup(t, cert, b.appName);
      appGroupId = appGroup.id;
      await APPGROUPS.nestGroupAsMember(t, cert, appGroupId, match.groupId);
    }

    onProgress("App erzeugen & hochladen");
    let appId;
    if (process.env.FAKE_DEPLOY === "1") {
      for (let i = 1; i <= 5; i++) { onProgress("Installer hochladen", { done: i, total: 5 }); await new Promise(r => setTimeout(r, 400)); }
      appId = "fake-app-id-1234";
    } else {
      // {file} im Kommando durch den tatsaechlich heruntergeladenen Dateinamen
      // ersetzen — Admin muss den (erst beim Download bekannten) Namen nicht raten.
      let installCmd = String(b.installCommandLine || "").replace(/\{file\}/g, fileName);
      // Silent-Switches je Vendor IMMER erzwingen (fehlende ergaenzen) — ein
      // interaktiver Installer haengt sonst unsichtbar im SYSTEM-Kontext. FortiClient
      // ist MSI-basiert (msiexec-Syntax) und braucht andere Tokens als die
      // EXE-Installer von Bitdefender/N-sight — NICHT in denselben Zweig werfen,
      // sonst wuerde z.B. "/norestart" (EXE-Konvention) an msiexec haengen, das
      // dort ohne Wirkung waere (msiexec braucht REBOOT=ReallySuppress).
      const REQUIRED_SWITCHES_BY_VENDOR = {
        bitdefender: ["/bdparams", "/silent"],
        forticlient: ["/qn", "REBOOT=ReallySuppress", "DONT_PROMPT_REBOOT=1"]
      };
      const requiredSwitches = REQUIRED_SWITCHES_BY_VENDOR[b.vendor] || ["/quiet", "/norestart"];
      if (!installCmd.trim()) installCmd = `"${fileName}"`;
      for (const sw of requiredSwitches) {
        if (!new RegExp(sw.replace("/", "\\/") + "\\b", "i").test(installCmd)) installCmd += " " + sw;
      }
      const subst = { ...b, installCommandLine: installCmd,
        uninstallCommandLine: String(b.uninstallCommandLine || "").replace(/\{file\}/g, fileName) };
      const payload = buildWin32AppPayload(subst, fileName);
      const r = await WIN32APP.createWin32AppWithContent(t, cert, {
        appPayload: payload, setupFileName: fileName, installerBuffer: buffer, extraFiles, onProgress
      });
      appId = r.appId;
    }

    onProgress("Veröffentlichen & zuweisen");
    if (process.env.FAKE_DEPLOY !== "1") {
      await WIN32APP.assignAppToGroup(t, cert, appId, appGroupId);
    } else {
      await new Promise(r => setTimeout(r, 500));
    }

    job.appId = appId;
    job.appGroupName = "AAD-APP-" + APPGROUPS.sanitizeAppNameForGroup(b.appName);
    job.deviceGroupName = deviceGroupName;
    finishAppJob(job, true);
  } catch (e) {
    // Nur bei einem tatsaechlichen Berechtigungsfehler auf "Reparieren" hinweisen —
    // sonst waere der Hinweis irrefuehrend (z.B. bei einem echten Downloadfehler
    // oder einer nach mehreren Versuchen weiter bestehenden Replikationsverzoegerung).
    const isPermIssue = e.status === 403 || /insufficient privileges|authorization|forbidden/i.test(String(e.message || ""));
    finishAppJob(job, false, e.message, e.hint || (isPermIssue
      ? "App-Deployment braucht Group.ReadWrite.All + DeviceManagementApps.ReadWrite.All — im Tab 'Tenants' einmal Reparieren ausfuehren."
      : null));
  }
}

app.post("/api/tenants/:id/appdeploy/start", wrap(async (req, res) => {
  const t = requireTenant(req);
  const b = req.body || {};
  if (!b.vendor || !b.appName || !b.installCommandLine || !b.uninstallCommandLine || !b.groupTag) {
    return res.status(400).json({ error: "vendor, appName, installCommandLine, uninstallCommandLine und groupTag sind erforderlich." });
  }
  for (const j of appJobs.values()) {
    if (j.tenantId === t.id && j.status === "running") {
      return res.status(409).json({ error: "Fuer diesen Tenant laeuft bereits ein App-Deployment.", jobId: j.id });
    }
  }
  const job = createAppJob(t, APPDEPLOY_PHASES);
  runAppDeployJob(job, t, b);
  res.json({ ok: true, jobId: job.id });
}));

// ---------- Administrative Rollen ----------
// Wer hat erhoehte Rechte, und wie kam er dazu. Rein lesend.
app.get("/api/tenants/:id/adminroles", wrap(async (req, res) => {
  const t = requireTenant(req);
  res.json({ ok: true, ...(await ADMINROLES.loadAdminRoles(t, certPemPath(t.tenantId))) });
}));

// Rollen setzen und entziehen, Konten loeschen. Alles schreibende Eingriffe im
// Kundentenant -- die Bestaetigung passiert im Frontend, die Schutzregeln
// (letzter Globaler Administrator, UPN-Bestaetigung beim Loeschen) sitzen in
// lib/adminRoles.js und damit serverseitig.
// Benutzersuche unter neutralem Pfad -- dieselbe Suche gibt es historisch
// unter /conditionalaccess/users, was ausserhalb des CA-Bereichs verwirrt.
app.get("/api/tenants/:id/users/search", wrap(async (req, res) => {
  const t = requireTenant(req);
  const q = String(req.query.q || "").trim();
  if (q.length < 2) return res.json({ ok: true, users: [] });
  res.json({ ok: true, users: await ENTRAUSERS.searchUsers(t, certPemPath(t.tenantId), q) });
}));

app.post("/api/tenants/:id/adminroles/globaladmin/add", wrap(async (req, res) => {
  const t = requireTenant(req);
  const userId = String((req.body || {}).userId || "").trim();
  if (!userId) return res.status(400).json({ error: "userId fehlt." });
  const r = await ADMINROLES.assignGlobalAdmin(t, certPemPath(t.tenantId), userId);
  res.json({ ok: true, ...r });
}));

app.post("/api/tenants/:id/adminroles/globaladmin/remove", wrap(async (req, res) => {
  const t = requireTenant(req);
  const userId = String((req.body || {}).userId || "").trim();
  if (!userId) return res.status(400).json({ error: "userId fehlt." });
  const r = await ADMINROLES.removeGlobalAdmin(t, certPemPath(t.tenantId), userId);
  res.json({ ok: true, ...r });
}));

app.post("/api/tenants/:id/users/delete", wrap(async (req, res) => {
  const t = requireTenant(req);
  const b = req.body || {};
  if (!b.userId) return res.status(400).json({ error: "userId fehlt." });
  const r = await ADMINROLES.deleteUser(t, certPemPath(t.tenantId), String(b.userId), b.confirmUpn);
  res.json({ ok: true, ...r });
}));

// ---------- GroupTags: Gruppen und Geraetezuordnung ----------
// Nutzbar fuer beide Faelle: den aktiven onboardeten Tenant (Zertifikat) und
// einen fremden Tenant per Client-ID/Secret -- etwa den Zieltenant einer
// Migration, in dem die AAD-Gruppen erst noch entstehen muessen.
async function groupTagAccess(req) {
  const b = req.body || {};
  const q = req.query || {};
  const tenantName = String(b.tenantName || q.tenantName || "").trim();
  const clientId = String(b.clientId || q.clientId || "").trim();
  const clientSecret = String(b.clientSecret || q.clientSecret || "").trim();

  if (tenantName && clientId && clientSecret) {
    const accessToken = await GROUPTAGS.tokenFromSecret(tenantName, clientId, clientSecret);
    return { kind: "token", accessToken, label: tenantName };
  }
  // Diese Endpunkte liegen NICHT unter /api/tenants/:id, deshalb kommt die
  // Tenant-Id im Body statt aus dem Pfad -- requireTenant() sucht in
  // req.params.id und griffe hier ins Leere ("Tenant nicht gefunden").
  // Die Pruefungen bleiben dieselben wie dort.
  const tenantId = String(b.tenantId || q.tenantId || "").trim();
  if (!tenantId) { const e = new Error("Kein Tenant gewaehlt."); e.status = 400; throw e; }

  const s = loadState();
  const t = (s.tenants || []).find(x => x.id === tenantId);
  if (!t) { const e = new Error("Tenant nicht gefunden"); e.status = 404; throw e; }
  if (!t.organization) { const e = new Error("Keine onmicrosoft-Domain hinterlegt — bitte neu onboarden."); e.status = 412; throw e; }
  if (!fs.existsSync(certPemPath(t.tenantId))) { const e = new Error("Kein Zertifikat hinterlegt — Tenant neu onboarden."); e.status = 412; throw e; }

  return { kind: "cert", tenant: t, certPemPath: certPemPath(t.tenantId), label: t.name };
}

app.post("/api/grouptags/groups", wrap(async (req, res) => {
  const access = await groupTagAccess(req);
  res.json({ ok: true, tenant: access.label, groups: await GROUPTAGS.listGroups(access) });
}));

app.post("/api/grouptags/devices", wrap(async (req, res) => {
  const access = await groupTagAccess(req);
  res.json({ ok: true, tenant: access.label, devices: await GROUPTAGS.listDevices(access) });
}));

// Schreibend im Kundentenant — legt eine dynamische Sicherheitsgruppe an.
app.post("/api/grouptags/groups/create", wrap(async (req, res) => {
  const b = req.body || {};
  const access = await groupTagAccess(req);
  const r = await GROUPTAGS.createGroupForTag(access, b.groupTag, b.displayName);
  res.json({ ok: true, ...r });
}));

// Schreibend im Kundentenant — setzt den GroupTag eines Autopilot-Geraets.
app.post("/api/grouptags/devices/tag", wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.deviceId) return res.status(400).json({ error: "deviceId fehlt." });
  const access = await groupTagAccess(req);
  const r = await GROUPTAGS.setDeviceTag(access, b.deviceId, b.groupTag);
  res.json({ ok: true, ...r });
}));

// Mehrere Geraete auf einmal — bei einer Migrationswelle sind das schnell
// dreissig Stueck. Fehler pro Geraet sammeln statt beim ersten abzubrechen.
app.post("/api/grouptags/devices/tag-bulk", wrap(async (req, res) => {
  const b = req.body || {};
  const ids = Array.isArray(b.deviceIds) ? b.deviceIds : [];
  if (!ids.length) return res.status(400).json({ error: "Keine Geraete ausgewaehlt." });
  if (ids.length > 200) return res.status(400).json({ error: "Maximal 200 Geraete pro Durchgang." });

  const access = await groupTagAccess(req);
  const results = [];
  for (const id of ids) {
    try {
      await GROUPTAGS.setDeviceTag(access, id, b.groupTag);
      results.push({ deviceId: id, ok: true });
    } catch (e) {
      results.push({ deviceId: id, ok: false, error: e.message });
    }
  }
  res.json({ ok: true, results, failed: results.filter(r => !r.ok).length });
}));

// ---------- Migration: App-Registrierungen anlegen lassen ----------
// Client-IDs und Secrets von Hand aus zwei Portalen zusammenzusuchen ist die
// Stelle, an der eine Migration typischerweise scheitert -- ein Zeichen falsch
// und der Fehler faellt erst auf dem Geraet auf. Deshalb legt das Tool die
// beiden App-Registrierungen selbst an, per Device-Code-Anmeldung eines Admins
// im jeweiligen Tenant.
const MIGRATION_APP_NAME = "IG-TenantMigration";

// Getrennte Rechte je Seite (nicht eine Sammelliste fuer beides):
// Im Quelltenant wird geloescht, im Zieltenant geschrieben und gelesen.
const MIGRATION_PERMS = {
  source: [
    "DeviceManagementManagedDevices.ReadWrite.All", // Intune-Objekt des Geraets loeschen
    "DeviceManagementServiceConfig.ReadWrite.All",  // Autopilot-Eintrag loeschen
    "Directory.Read.All"                            // Geraet/Benutzer nachschlagen
  ],
  target: [
    "DeviceManagementManagedDevices.ReadWrite.All", // Primary User setzen
    "DeviceManagementServiceConfig.ReadWrite.All",  // Autopilot-Import
    "Device.ReadWrite.All",                         // GroupTag in physicalIds schreiben
    "Group.Read.All",                               // dynamische Gruppen fuer die GroupTag-Auswahl
    "Directory.Read.All"
  ]
};

async function createMigrationApp(token, side) {
  const perms = MIGRATION_PERMS[side];
  const displayName = MIGRATION_APP_NAME + "-" + (side === "source" ? "Source" : "Target");

  const graphSp = (await gReq(token, "GET", `/servicePrincipals?$filter=appId eq '${GRAPH_APP_ID}'`)).value[0];
  if (!graphSp) throw new Error("Microsoft-Graph Service-Principal nicht gefunden.");
  const roles = perms.map(v => {
    const role = (graphSp.appRoles || []).find(x => x.value === v && (x.allowedMemberTypes || []).includes("Application"));
    if (!role) throw new Error("Graph-Permission fehlt im SP: " + v);
    return role;
  });
  const requiredResourceAccess = [{ resourceAppId: GRAPH_APP_ID, resourceAccess: roles.map(r => ({ id: r.id, type: "Role" })) }];

  let app = (await gReq(token, "GET", `/applications?$filter=displayName eq '${odataLit(displayName)}'`)).value[0];
  if (app) {
    await gReq(token, "PATCH", `/applications/${app.id}`, { requiredResourceAccess, signInAudience: "AzureADMyOrg" });
  } else {
    app = await gReq(token, "POST", "/applications", { displayName, signInAudience: "AzureADMyOrg", requiredResourceAccess });
  }
  let appSp = (await gReq(token, "GET", `/servicePrincipals?$filter=appId eq '${app.appId}'`)).value[0];
  if (!appSp) appSp = await gReq(token, "POST", "/servicePrincipals", { appId: app.appId });

  let consentOk = true, consentErr = null;
  try {
    const existing = (await gReq(token, "GET", `/servicePrincipals/${appSp.id}/appRoleAssignments`)).value || [];
    for (const r of roles) await ensureAppRoleAssignment(token, appSp.id, graphSp.id, r.id, existing);
  } catch (e) { consentOk = false; consentErr = e.message; }

  // Secret bewusst kurzlebig: es wandert in ein Paket, das auf Kundengeraeten
  // landet. 6 Monate reichen fuer jede Migrationswelle.
  const pw = await gReq(token, "POST", `/applications/${app.id}/addPassword`, {
    passwordCredential: { displayName: displayName + "-secret", endDateTime: isoInMonths(6) }
  });

  return {
    appId: app.appId, clientSecret: pw.secretText, displayName,
    permissions: perms, consentOk, consentErr, secretExpiresAt: isoInMonths(6)
  };
}

app.post("/api/migration/appreg/start", wrap(async (req, res) => {
  const b = req.body || {};
  const side = b.side === "target" ? "target" : "source";
  const tenant = String(b.tenant || "").trim();
  if (!tenant) return res.status(400).json({ error: "Tenant-Domain oder -ID angeben." });

  const params = new URLSearchParams({
    client_id: GRAPH_CLI_CLIENT,
    scope: "Application.ReadWrite.All AppRoleAssignment.ReadWrite.All Directory.ReadWrite.All offline_access openid"
  });
  const r = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/devicecode`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: params
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Device-Code-Start fehlgeschlagen: " + (j.error_description || j.error || r.status));

  req.session.migrationAppReg = {
    side, tenant, deviceCode: j.device_code, interval: (j.interval || 5),
    expiresAt: Date.now() + (j.expires_in || 900) * 1000
  };
  res.json({ userCode: j.user_code, verificationUri: j.verification_uri || "https://microsoft.com/devicelogin", interval: j.interval || 5, side });
}));

app.post("/api/migration/appreg/poll", wrap(async (req, res) => {
  const df = req.session.migrationAppReg;
  if (!df) return res.status(400).json({ error: "Kein laufender Vorgang." });
  if (Date.now() > df.expiresAt) { delete req.session.migrationAppReg; return res.json({ status: "error", error: "Anmeldecode abgelaufen — bitte neu starten." }); }

  const params = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    client_id: GRAPH_CLI_CLIENT, device_code: df.deviceCode
  });
  const r = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(df.tenant)}/oauth2/v2.0/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: params
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (j.error === "authorization_pending") return res.json({ status: "pending" });
    if (j.error === "slow_down") { df.interval = (df.interval || 5) + 5; return res.json({ status: "pending", slowDown: true, interval: df.interval }); }
    delete req.session.migrationAppReg;
    return res.json({ status: "error", error: j.error_description || j.error || ("HTTP " + r.status) });
  }

  const side = df.side;
  const tenant = df.tenant;
  delete req.session.migrationAppReg;
  const result = await createMigrationApp(j.access_token, side);
  res.json({ status: "done", side, tenant, ...result });
}));

// GroupTags des ZIELtenants — gelesen mit genau den Credentials, die gerade
// erzeugt wurden. Dort gibt es kein Zertifikat wie bei den onboardeten
// Tenants, deshalb client_credentials statt des ueblichen Graph-Helfers.
app.post("/api/migration/grouptags", wrap(async (req, res) => {
  const b = req.body || {};
  const tenant = String(b.tenantName || "").trim();
  const clientId = String(b.clientId || "").trim();
  const clientSecret = String(b.clientSecret || "").trim();
  if (!tenant || !clientId || !clientSecret) return res.status(400).json({ error: "Tenant, Client-ID und Secret noetig." });

  const body = new URLSearchParams({
    grant_type: "client_credentials", client_id: clientId,
    client_secret: clientSecret, scope: "https://graph.microsoft.com/.default"
  });
  const tr = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body
  });
  const tj = await tr.json().catch(() => ({}));
  if (!tr.ok) {
    const e = new Error("Anmeldung am Zieltenant fehlgeschlagen: " + (tj.error_description || tj.error || tr.status));
    e.status = 400;
    throw e;
  }

  const gr = await fetch("https://graph.microsoft.com/beta/groups?$filter=" +
    encodeURIComponent("groupTypes/any(c:c eq 'DynamicMembership') and securityEnabled eq true") +
    "&$select=id,displayName,membershipRule&$top=100",
    { headers: { Authorization: "Bearer " + tj.access_token } });
  const gj = await gr.json().catch(() => ({}));
  if (!gr.ok) {
    const e = new Error("Gruppen nicht lesbar: " + ((gj.error && gj.error.message) || gr.status) +
      " — Admin-Consent im Zieltenant noch nicht durch?");
    e.status = 400;
    throw e;
  }

  // [OrderID]:<Tag> aus den Mitgliedschaftsregeln ziehen — dieselbe Konvention
  // wie im Autopilot-Bereich.
  const seen = new Map();
  for (const g of gj.value || []) {
    const rule = String(g.membershipRule || "");
    const re = /\[OrderID\]:([^"'\s)]+)/gi;
    let m;
    while ((m = re.exec(rule)) !== null) {
      const tag = m[1].trim();
      if (tag && !seen.has(tag)) seen.set(tag, { groupTag: tag, groupName: g.displayName, groupId: g.id });
    }
  }
  res.json({ ok: true, groupTags: [...seen.values()].sort((a, b) => a.groupTag.localeCompare(b.groupTag)) });
}));

// ---------- Kundenreports und Monitoring-Uebersicht ----------
const REPORT_PHASES_PREFIX = "Verbinden";

app.get("/api/reports/sections", (req, res) => res.json({ ok: true, sections: REPORT.SECTIONS }));

// Im State landet NUR die Auswertung (Kennzahlen, Zusammenfassung), nicht die
// Rohdaten: der Lizenzbaustein liefert alle Benutzer mit, das wuerde state.json
// bei einem Dutzend Tenants unnoetig aufblaehen.
function storeReport(tenantRecId, report) {
  const s = loadState();
  const idx = (s.tenants || []).findIndex(x => x.id === tenantRecId);
  if (idx < 0) return;
  const slim = {
    generatedAt: report.generatedAt,
    summary: report.summary,
    sections: {}
  };
  for (const [id, sec] of Object.entries(report.sections)) {
    slim.sections[id] = { ok: sec.ok, label: sec.label, metrics: sec.metrics || [], error: sec.error || null };
  }
  s.tenants[idx].report = slim;
  saveState(s);
}

async function runReportJob(job, t) {
  const onProgress = appJobProgress(job);
  const cert = certPemPath(t.tenantId);
  try {
    onProgress(REPORT_PHASES_PREFIX);
    const report = await REPORT.runReport(t, cert, job.sections, (label) => onProgress(label));
    job.report = report;
    storeReport(t.id, report);
    const failed = report.summary.failedSections;
    finishAppJob(job, true, null, failed.length
      ? "Nicht abrufbar: " + failed.join(", ") + " — fehlende Berechtigung oder Lizenz im Tenant."
      : null);
  } catch (e) {
    finishAppJob(job, false, e.message, e.hint || null);
  }
}

app.post("/api/tenants/:id/report/run", wrap(async (req, res) => {
  const t = requireTenant(req);
  for (const j of appJobs.values()) {
    if (j.tenantId === t.id && j.status === "running") {
      return res.status(409).json({ error: "Fuer diesen Tenant laeuft bereits ein Job.", jobId: j.id });
    }
  }
  const sections = Array.isArray(req.body && req.body.sections) ? req.body.sections : [];
  const labels = [REPORT_PHASES_PREFIX, ...REPORT.SECTIONS
    .filter(s => !sections.length || sections.includes(s.id))
    .map(s => s.label)];
  const job = createAppJob(t, labels);
  job.sections = sections;
  runReportJob(job, t);
  res.json({ ok: true, jobId: job.id });
}));

// Vollstaendiger Report inklusive Rohdaten — nur solange der Job im Speicher
// liegt. Was den Neustart ueberlebt, ist die schlanke Fassung im State.
app.get("/api/jobs/report/:jobId", (req, res) => {
  const job = appJobs.get(req.params.jobId);
  if (!job || !job.report) return res.status(404).json({ error: "Report nicht (mehr) verfuegbar — bitte neu erzeugen." });
  res.json({ ok: true, report: job.report });
});

app.get("/api/tenants/:id/report/latest", (req, res) => {
  const s = loadState();
  const t = (s.tenants || []).find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "Tenant nicht gefunden" });
  res.json({ ok: true, report: t.report || null });
});

// Monitoring-Uebersicht ueber ALLE Tenants — liest nur die gespeicherten
// Reports, fragt also nichts live ab. Damit bleibt die Seite schnell, auch
// wenn zwoelf Tenants hinterlegt sind.
app.get("/api/reports/overview", (req, res) => {
  const s = loadState();
  const rows = (s.tenants || []).map(t => {
    const r = t.report;
    return {
      id: t.id,
      name: t.name,
      organization: t.organization || null,
      generatedAt: r ? r.generatedAt : null,
      summary: r ? r.summary : null,
      // Auffaellige Kennzahlen nach oben holen, damit die Uebersicht ohne
      // Aufklappen zeigt, wo etwas zu tun ist.
      findings: r
        ? Object.values(r.sections || {})
            .flatMap(sec => (sec.metrics || []).filter(m => m.state !== "ok")
              .map(m => ({ section: sec.label, ...m })))
            .sort((a, b) => (a.state === "crit" ? -1 : 1) - (b.state === "crit" ? -1 : 1))
        : []
    };
  });
  res.json({ ok: true, tenants: rows });
});

// ---------- Maester-Security-Audit (maester.dev) ----------
// Rein lesende Testsuite (CISA, CIS, EIDSCA, Community) app-only gegen den
// Tenant. HTML-Report + Roh-JSON liegen pro Lauf unter state/maester/<recId>/,
// im state.json steht nur die schlanke Zusammenfassung (analog Reports).
const MAESTER_DIR = path.join(STATE_DIR, "maester");
const MAESTER_KEEP_RUNS = 8;

function storeMaesterSummary(tenantRecId, summary) {
  const s = loadState();
  const idx = (s.tenants || []).findIndex(x => x.id === tenantRecId);
  if (idx < 0) return;
  s.tenants[idx].maester = summary;
  saveState(s);
}

function maesterRunDir(tenantRecId, runId) {
  // runId ist Teil eines Dateipfads — striktes Muster statt Pfad-Sanitizing.
  if (!/^[A-Za-z0-9-]+$/.test(String(runId || ""))) {
    throw Object.assign(new Error("Ungueltige Run-Id."), { status: 400 });
  }
  return path.join(MAESTER_DIR, tenantRecId, runId);
}

// Vorpruefung: sind die Maester-Leseberechtigungen wirklich als App-Role-
// Assignments am Tenant-SP? Ohne sie laeuft Maester zwar durch, markiert aber
// reihenweise Tests als gefallen — ein falscher Score ist schlimmer als ein
// klarer Abbruch mit Hinweis auf "Reparieren". Nur Permissions zaehlen, die es
// im Graph-SP des Tenants ueberhaupt gibt (siehe GRAPH_APP_PERMS_MAESTER).
// Scheitert die Pruefung selbst (Netz, Token), laeuft der Audit trotzdem —
// echte Auth-Probleme meldet dann Connect-MgGraph.
async function maesterMissingPerms(t) {
  const cert = certPemPath(t.tenantId);
  const appSp = await GRAPHLIB.graphReq(t, cert, "GET", `/servicePrincipals(appId='${encodeURIComponent(t.clientId)}')?$select=id`);
  const graphSp = await GRAPHLIB.graphReq(t, cert, "GET", `/servicePrincipals(appId='${GRAPH_APP_ID}')?$select=id,appRoles`);
  const assigned = new Set((await GRAPHLIB.graphAllPages(t, cert, `/servicePrincipals/${appSp.id}/appRoleAssignments`)).map(a => a.appRoleId));
  const missing = [];
  for (const v of GRAPH_APP_PERMS_MAESTER) {
    const role = (graphSp.appRoles || []).find(x => x.value === v && (x.allowedMemberTypes || []).includes("Application"));
    if (role && !assigned.has(role.id)) missing.push(v);
  }
  return missing;
}

async function runMaesterJob(job, t, tags) {
  try {
    await runMaesterJobInner(job, t, tags);
  } finally {
    // Zeitplan-Laeufe: Ergebnis im State verewigen — der Job selbst lebt nur im
    // Speicher, und bei einem naechtlichen Lauf schaut niemand auf den Fortschritt.
    if (job.scheduled) {
      try {
        const s = loadState();
        const rec = (s.tenants || []).find(x => x.id === t.id);
        if (rec) {
          rec.maesterSchedule = {
            ...(rec.maesterSchedule || {}),
            lastResult: job.status === "done" ? "ok" : "Fehler: " + (job.error || "unbekannt"),
            lastResultAt: new Date().toISOString()
          };
          saveState(s);
        }
      } catch (e) { /* Protokollierung darf nie den Lauf beschaedigen */ }
    }
  }
}

async function runMaesterJobInner(job, t, tags) {
  const onProgress = appJobProgress(job);
  try {
    onProgress("Berechtigungen prüfen");
    let missing = [];
    try { missing = await maesterMissingPerms(t); } catch (e) { console.log("Maester-Berechtigungspruefung uebersprungen: " + e.message); }
    if (missing.length) {
      return finishAppJob(job, false,
        "Maester-Leseberechtigungen fehlen (" + missing.slice(0, 6).join(", ") + (missing.length > 6 ? " und " + (missing.length - 6) + " weitere" : "") + ").",
        "Im Tab 'Tenants' einmal Reparieren ausfuehren, dann erneut starten.");
    }
    const runId = new Date().toISOString().slice(0, 19).replace(/[:]/g, "-");
    const outDir = path.join(MAESTER_DIR, t.id, runId);

    // Einzelne Connects (IPPS/Teams/PnP) koennen den pwsh-Prozess unter Linux
    // HART beenden — kein catch moeglich. Stirbt der Lauf in einer
    // Verbindungsphase (job.phase = letzte gemeldete Phase), wird er einmal
    // pro Connector ohne diesen wiederholt; die betroffenen Tests erscheinen
    // dann regulaer als uebersprungen.
    const CONNECTOR_BY_PHASE = {
      "Verbindung zu Security & Compliance": ["sc", "Security & Compliance"],
      "Verbindung zu Teams": ["teams", "Teams"],
      "Verbindung zu SharePoint": ["sp", "SharePoint"]
    };
    const skip = {};
    const disabledConnectors = [];
    let r;
    for (let attempt = 0; attempt < 4; attempt++) {
      r = await MAESTER.runMaester(
        {
          tenant: t, certPemPath: certPemPath(t.tenantId), outDir, tags, skip: { ...skip },
          // Live-Anzeige: aktueller Block/Test + Zaehler, landet 1:1 im Job und
          // damit im Poll-Ergebnis des Frontends.
          onDetail: (live) => { job.live = live; }
        },
        (p) => { if (p && p.label) onProgress(p.label); },
        (child) => { job._child = child; }
      );
      if (r.ok) break;
      const conn = CONNECTOR_BY_PHASE[job.phase];
      if (!conn || skip[conn[0]]) break;
      skip[conn[0]] = true;
      disabledConnectors.push(conn[1]);
      console.log("Maester (" + t.name + "): pwsh-Prozess in Phase '" + job.phase + "' beendet — neuer Versuch ohne " + conn[1] + ".");
      onProgress("Neuer Versuch ohne " + conn[1]);
    }
    job.live = null;
    job._child = null;
    if (!r.ok || !r.data || !r.data.ok) {
      const msg = (r.data && r.data.error) || r.error || "Maester-Lauf fehlgeschlagen.";
      // Rohes Ende des Laufs ins Server-Log (Diagnose-Tab) — die Fehlermeldung
      // allein hat bei den bisherigen Abbruechen nicht gereicht.
      if (r.raw) console.log("Maester-Rohausgabe (Ende, " + t.name + "): " + String(r.raw).slice(-1500));
      // Nur wegputzen, wenn nichts Brauchbares drinliegt (results.json/HTML
      // eines abgebrochenen Laufs sind fuer die Fehlersuche Gold wert).
      try { if (!fs.readdirSync(outDir).length) fs.rmSync(outDir, { recursive: true, force: true }); } catch (e) { /* leer lassen */ }
      return finishAppJob(job, false, msg,
        /fehlt im SP|Berechtigung|Authorization|403/i.test(msg)
          ? "Im Tab 'Tenants' einmal Reparieren ausfuehren — das setzt die Maester-Leseberechtigungen."
          : null);
    }
    onProgress("Auswertung");
    const summary = {
      runId,
      generatedAt: new Date().toISOString(),
      suites: MAESTER.sanitizeTags(tags),
      counts: r.data.counts,
      score: MAESTER.score(r.data.counts || {}),
      exoConnected: !!r.data.exoConnected,
      exoError: r.data.exoError || null,
      scConnected: !!r.data.scConnected,
      scError: r.data.scError || null,
      teamsConnected: !!r.data.teamsConnected,
      spConnected: !!r.data.spConnected,
      failed: r.data.failed || [],
      skipped: r.data.skipped || [],
      maesterVersion: r.data.maesterVersion || null,
      htmlAvailable: !!r.data.htmlAvailable
    };
    fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
    MAESTER.pruneRuns(MAESTER_DIR, t.id, MAESTER_KEEP_RUNS);
    storeMaesterSummary(t.id, summary);
    job.maester = summary;
    const hints = [];
    if (disabledConnectors.length) hints.push("Die Verbindung zu " + disabledConnectors.join(" und ") + " hat den PowerShell-Prozess beendet (bekanntes Linux-Problem) — der Lauf wurde automatisch ohne sie wiederholt; betroffene Tests erscheinen als uebersprungen.");
    if (r.data.salvaged) hints.push("Der pwsh-Prozess endete unsauber (" + r.data.salvaged + ") — Ergebnis wurde aus results.json gerettet.");
    if (r.data.exoConnected === false) hints.push("Exchange Online nicht verbunden — EXO-/ORCA-Tests uebersprungen" + (summary.exoError ? " (" + summary.exoError + ")" : "") + ".");
    if (r.data.exoConnected === true && r.data.scConnected === false) hints.push("Security & Compliance nicht verbunden — betroffene CISA-Tests uebersprungen" + (r.data.scError ? " (" + String(r.data.scError).slice(0, 200) + ")" : "") + ".");
    if (r.data.teamsConnected === false) hints.push("Teams nicht verbunden" + (r.data.teamsError ? " (" + String(r.data.teamsError).slice(0, 150) + ")" : "") + " — ggf. einmal Reparieren (Teams-Admin-Rolle).");
    if (r.data.spConnected === false) hints.push("SharePoint nicht verbunden" + (r.data.spError ? " (" + String(r.data.spError).slice(0, 150) + ")" : "") + " — ggf. einmal Reparieren (SharePoint-Permission).");
    finishAppJob(job, true, null, hints.length ? hints.join(" ") : null);
  } catch (e) {
    finishAppJob(job, false, e.message, e.hint || null);
  }
}

const MAESTER_PHASES = [
  "Berechtigungen prüfen",
  "Verbindung zu Microsoft Graph",
  "Verbindung zu Exchange Online",
  "Verbindung zu Security & Compliance",
  "Verbindung zu Teams",
  "Verbindung zu SharePoint",
  "Testsuite vorbereiten",
  "Maester-Tests laufen (dauert mehrere Minuten)",
  "Auswertung"
];

app.post("/api/tenants/:id/maester/run", wrap(async (req, res) => {
  const t = requireTenant(req);
  for (const j of appJobs.values()) {
    if (j.tenantId === t.id && j.status === "running") {
      return res.status(409).json({ error: "Fuer diesen Tenant laeuft bereits ein Job.", jobId: j.id });
    }
  }
  const tags = MAESTER.sanitizeTags((req.body || {}).suites);
  const job = createAppJob(t, MAESTER_PHASES);
  runMaesterJob(job, t, tags);
  res.json({ ok: true, jobId: job.id });
}));

// Laufender Job des Tenants (falls vorhanden) — damit das Frontend nach einem
// Reload oder Tenant-Wechsel den Fortschritt wieder aufnehmen kann, statt beim
// naechsten Klick in den 409 zu laufen.
app.get("/api/tenants/:id/maester/active", (req, res) => {
  for (const j of appJobs.values()) {
    if (j.tenantId === req.params.id && j.status === "running") return res.json({ ok: true, jobId: j.id });
  }
  res.json({ ok: true, jobId: null });
});

app.get("/api/tenants/:id/maester/latest", (req, res) => {
  const s = loadState();
  const t = (s.tenants || []).find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "Tenant nicht gefunden" });
  res.json({ ok: true, maester: t.maester || null });
});

app.get("/api/tenants/:id/maester/runs", (req, res) => {
  const s = loadState();
  const t = (s.tenants || []).find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "Tenant nicht gefunden" });
  res.json({ ok: true, runs: MAESTER.listRuns(MAESTER_DIR, t.id) });
});

// Der interaktive Maester-HTML-Report eines Laufs — session-gated wie alles
// unter /api, daher unbedenklich direkt auszuliefern.
app.get("/api/tenants/:id/maester/runs/:runId/report.html", wrap(async (req, res) => {
  const s = loadState();
  const t = (s.tenants || []).find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "Tenant nicht gefunden" });
  const file = path.join(maesterRunDir(t.id, req.params.runId), "report.html");
  if (!fs.existsSync(file)) return res.status(404).json({ error: "Kein HTML-Report fuer diesen Lauf." });
  res.type("html").send(fs.readFileSync(file, "utf8"));
}));

app.get("/api/tenants/:id/maester/runs/:runId/results.json", wrap(async (req, res) => {
  const s = loadState();
  const t = (s.tenants || []).find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "Tenant nicht gefunden" });
  const file = path.join(maesterRunDir(t.id, req.params.runId), "results.json");
  if (!fs.existsSync(file)) return res.status(404).json({ error: "Keine Rohdaten fuer diesen Lauf." });
  res.type("json").send(fs.readFileSync(file, "utf8"));
}));

// ---------- Maester: Details, deutsche Erklaerungen, Kunden-PDF ----------
function maesterExplainPath(tenantRecId, runId) {
  return path.join(maesterRunDir(tenantRecId, runId), "explain.json");
}

function loadMaesterExplain(tenantRecId, runId) {
  try { return JSON.parse(fs.readFileSync(maesterExplainPath(tenantRecId, runId), "utf8")); }
  catch (e) { return null; }
}

// Gefallene Tests eines Laufs inkl. der englischen Detailtexte aus results.json
// (Testbeschreibung + konkreter Befund) — Grundlage fuer Accordion, KI und PDF.
function maesterRunFailedDetails(tenantRecId, runId) {
  const file = path.join(maesterRunDir(tenantRecId, runId), "results.json");
  if (!fs.existsSync(file)) return null;
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return null; }
  const pick = (o, names) => { for (const n of names) { if (o && o[n] !== null && o[n] !== undefined && o[n] !== "") return o[n]; } return null; };
  const tests = Array.isArray(doc.Tests) ? doc.Tests : (Array.isArray(doc.tests) ? doc.tests : []);
  return tests
    .filter(t => t && /^Failed/i.test(String(pick(t, ["Result", "result"]) || "")))
    .map(t => {
      const rd = pick(t, ["ResultDetail", "resultDetail"]) || {};
      return {
        id: String(pick(t, ["Id", "id", "Name", "name"]) || ""),
        title: String(pick(t, ["Title", "title", "Name", "name"]) || ""),
        severity: String(pick(t, ["Severity", "severity"]) || ""),
        block: String(pick(t, ["Block", "block"]) || ""),
        helpUrl: String(pick(t, ["HelpUrl", "helpUrl"]) || ""),
        // Grosszuegig kappen — die CIS-Texte mit PowerShell-Snippets sind lang,
        // und ein mitten im Codeblock abgeschnittener Text sieht kaputt aus.
        description: String(pick(rd, ["TestDescription", "testDescription"]) || "").slice(0, 4000),
        result: String(pick(rd, ["TestResult", "testResult"]) || "").slice(0, 3500)
      };
    });
}

app.get("/api/tenants/:id/maester/runs/:runId/details", wrap(async (req, res) => {
  const s = loadState();
  const t = (s.tenants || []).find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "Tenant nicht gefunden" });
  const failed = maesterRunFailedDetails(t.id, req.params.runId);
  if (failed === null) return res.status(404).json({ error: "Keine Rohdaten fuer diesen Lauf." });
  res.json({ ok: true, failed, explain: loadMaesterExplain(t.id, req.params.runId), aiEnabled: MAESTER_EXPLAIN.config().enabled });
}));

// Deutsche Erklaerungen (Bedeutung + Umsetzungsschritte) per KI erzeugen —
// einmal pro Lauf, danach aus explain.json.
app.post("/api/tenants/:id/maester/runs/:runId/explain", wrap(async (req, res) => {
  const s = loadState();
  const t = (s.tenants || []).find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "Tenant nicht gefunden" });
  const existing = loadMaesterExplain(t.id, req.params.runId);
  if (existing && !(req.body && req.body.force)) return res.json({ ok: true, explain: existing });
  const failed = maesterRunFailedDetails(t.id, req.params.runId);
  if (failed === null) return res.status(404).json({ error: "Keine Rohdaten fuer diesen Lauf." });
  if (!failed.length) return res.json({ ok: true, explain: [] });
  const explain = await MAESTER_EXPLAIN.explainFindings({ tenantName: t.name, findings: failed });
  fs.writeFileSync(maesterExplainPath(t.id, req.params.runId), JSON.stringify(explain, null, 2), "utf8");
  res.json({ ok: true, explain });
}));

// Gemeinsame Datensammlung fuer die Kundenreports (PDF + HTML): Zusammenfassung,
// Findings (mit engl. Details und ggf. deutschen KI-Erklaerungen gemerged) und
// die Domain-Authentifizierung (live, best effort).
async function collectMaesterReportData(t, runId) {
  let summary;
  try { summary = JSON.parse(fs.readFileSync(path.join(maesterRunDir(t.id, runId), "summary.json"), "utf8")); }
  catch (e) { return null; }
  const details = maesterRunFailedDetails(t.id, runId) || [];
  const explain = loadMaesterExplain(t.id, runId) || [];
  const exMap = new Map(explain.map(x => [x.id, x]));
  const detMap = new Map(details.map(x => [x.id, x]));
  const findings = (summary.failed || []).map(f => ({ ...f, ...(detMap.get(f.id) || {}), ...(exMap.get(f.id) || {}) }));
  let domainAuth = null;
  try {
    const auth = { appId: t.clientId, organization: t.organization, certPemPath: certPemPath(t.tenantId) };
    const dr = await EXO.runExo(auth, DOMAINAUTH.buildDomainAuthExoBody(), 60000);
    if (dr.ok && dr.data && dr.data.ok !== false && (dr.data.domains || []).length) {
      domainAuth = await DOMAINAUTH.checkDomains(dr.data.domains, dr.data.configs || []);
    }
  } catch (e) { console.log("Domain-Auth fuer den Kundenreport nicht abrufbar: " + e.message); }
  return {
    domainAuth,
    // Letzter Statusreport aus dem Reports-Tab (Lizenzen/CA/Identitaeten/
    // Geraete/OIB, schlanke Fassung) — macht aus dem Maester-Report den
    // vollumfaenglichen Kundenreport. Fehlt er, faellt das Kapitel weg.
    statusReport: t.report || null,
    tenantName: t.name,
    organization: t.organization || null,
    generatedAt: summary.generatedAt,
    suites: summary.suites || [],
    counts: summary.counts || {},
    score: summary.score,
    maesterVersion: summary.maesterVersion || null,
    findings,
    skipped: summary.skipped || []
  };
}

function maesterReportFilename(t, data, ext) {
  const safeName = String(t.name || "Tenant").replace(/[^A-Za-z0-9._-]+/g, "-");
  return `SecurityAudit_${safeName}_${String(data.generatedAt || "").slice(0, 10)}.${ext}`;
}

// Kundenfaehiger PDF-Report (deutsch, serverseitig erzeugt). Nutzt die
// KI-Erklaerungen, wenn sie fuer den Lauf schon erzeugt wurden.
app.get("/api/tenants/:id/maester/runs/:runId/report.pdf", wrap(async (req, res) => {
  const s = loadState();
  const t = (s.tenants || []).find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "Tenant nicht gefunden" });
  const data = await collectMaesterReportData(t, req.params.runId);
  if (!data) return res.status(404).json({ error: "Kein Ergebnis fuer diesen Lauf." });
  const pdf = await MAESTER_PDF.buildPdf(data);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${maesterReportFilename(t, data, "pdf")}"`);
  res.send(pdf);
}));

// Kundenfaehiger HTML-Report — eine einzelne, selbsttragende Datei (Inline-CSS,
// Logo eingebettet, Accordions per <details>) zum Versenden als Mail-Anhang.
app.get("/api/tenants/:id/maester/runs/:runId/report-kunde.html", wrap(async (req, res) => {
  const s = loadState();
  const t = (s.tenants || []).find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "Tenant nicht gefunden" });
  const data = await collectMaesterReportData(t, req.params.runId);
  if (!data) return res.status(404).json({ error: "Kein Ergebnis fuer diesen Lauf." });
  const html = MAESTER_HTML.buildHtml(data);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (req.query.download !== undefined) {
    res.setHeader("Content-Disposition", `attachment; filename="${maesterReportFilename(t, data, "html")}"`);
  }
  res.send(html);
}));

// Uebersicht ueber alle Tenants — liest wie /api/reports/overview nur den
// gespeicherten Stand, keine Live-Abfragen.
app.get("/api/maester/overview", (req, res) => {
  const s = loadState();
  const rows = (s.tenants || []).map(t => {
    const m = t.maester;
    return {
      id: t.id,
      name: t.name,
      organization: t.organization || null,
      generatedAt: m ? m.generatedAt : null,
      runId: m ? m.runId : null,
      score: m ? m.score : null,
      counts: m ? m.counts : null,
      failedTop: m ? (m.failed || []).slice(0, 5) : [],
      schedule: (t.maesterSchedule && t.maesterSchedule.enabled)
        ? { interval: t.maesterSchedule.interval || "weekly", lastResult: t.maesterSchedule.lastResult || null, lastResultAt: t.maesterSchedule.lastResultAt || null }
        : null
    };
  });
  res.json({ ok: true, tenants: rows });
});

// ---------- Maester-Zeitplan ----------
// Serverseitige, wiederkehrende Audits pro Tenant. Kein Cron-Daemon: ein
// Node-Interval prueft alle 15 Minuten, ob ein Tenant faellig ist, und startet
// dann EINEN Lauf (Maester ist pwsh-lastig — mehrere Tenants parallel wuerden
// den Container quaelen; der naechste faellige kommt im naechsten Tick dran).
const MAESTER_SCHEDULE_TICK_MS = 15 * 60 * 1000;
// Nach einem Fehlversuch (z.B. fehlende Berechtigungen) nicht jeden Tick neu
// anrennen — fruehestens nach 6 Stunden wieder.
const MAESTER_RETRY_GAP_MS = 6 * 3600 * 1000;
const MAESTER_INTERVALS = { daily: 1, weekly: 7, biweekly: 14, monthly: 30 };

app.get("/api/tenants/:id/maester/schedule", (req, res) => {
  const s = loadState();
  const t = (s.tenants || []).find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "Tenant nicht gefunden" });
  res.json({ ok: true, schedule: t.maesterSchedule || null });
});

app.put("/api/tenants/:id/maester/schedule", (req, res) => {
  const s = loadState();
  const t = (s.tenants || []).find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "Tenant nicht gefunden" });
  const b = req.body || {};
  const interval = Object.prototype.hasOwnProperty.call(MAESTER_INTERVALS, b.interval) ? b.interval : "weekly";
  t.maesterSchedule = {
    ...(t.maesterSchedule || {}),
    enabled: !!b.enabled,
    interval,
    suites: MAESTER.sanitizeTags(b.suites)
  };
  saveState(s);
  res.json({ ok: true, schedule: t.maesterSchedule });
});

// ---------- Testsuite aktuell halten ----------
// Die Testszenarien stecken IM Maester-Modul (Install-MaesterTests kopiert sie
// nur heraus). Aktualisieren heisst also: neue Modulversion von der PSGallery
// holen und die Suite neu ins State-Volume extrahieren. Passiert automatisch
// einmal taeglich (im Zeitplan-Tick) und auf Knopfdruck.
let maesterSuiteRefreshing = false;

async function refreshMaesterSuite(job) {
  if (maesterSuiteRefreshing) return;
  maesterSuiteRefreshing = true;
  try {
    const r = await MAESTER.refreshSuite();
    const s = loadState();
    s.maesterSuite = {
      checkedAt: new Date().toISOString(),
      ok: r.ok,
      version: r.version || (s.maesterSuite && s.maesterSuite.version) || null,
      updated: !!r.updated,
      error: r.ok ? (r.galleryError || null) : r.error
    };
    saveState(s);
    console.log(r.ok
      ? "Maester-Testsuite: " + (r.updated ? "aktualisiert auf " + r.version : "aktuell (Maester " + r.version + ")")
      : "Maester-Testsuite-Aktualisierung fehlgeschlagen: " + r.error);
    if (job) {
      if (r.ok) finishAppJob(job, true, null, (r.updated ? "Maester auf " + r.version + " aktualisiert." : "Bereits aktuell (Maester " + r.version + ").") + (r.galleryError ? " Hinweis: PSGallery nicht erreichbar (" + r.galleryError + ") — Tests aus der vorhandenen Version extrahiert." : ""));
      else finishAppJob(job, false, r.error, null);
    }
  } catch (e) {
    console.log("Maester-Testsuite-Aktualisierung fehlgeschlagen: " + e.message);
    if (job) finishAppJob(job, false, e.message, null);
  } finally { maesterSuiteRefreshing = false; }
}

app.get("/api/maester/suite", (req, res) => {
  const s = loadState();
  res.json({ ok: true, suite: { ...MAESTER.suiteInfo(), ...(s.maesterSuite || {}), refreshing: maesterSuiteRefreshing } });
});

app.post("/api/maester/suite/update", (req, res) => {
  if (maesterSuiteRefreshing) return res.status(409).json({ error: "Aktualisierung laeuft bereits." });
  for (const j of appJobs.values()) {
    if (j.isMaester && j.status === "running") return res.status(409).json({ error: "Waehrend eines laufenden Audits nicht aktualisieren — kurz warten." });
  }
  const job = createAppJob({ id: "_maester_suite", name: "Maester-Testsuite" }, ["Nach Updates suchen und installieren"]);
  appJobProgress(job)("Nach Updates suchen und installieren");
  refreshMaesterSuite(job);
  res.json({ ok: true, jobId: job.id });
});

async function maesterScheduleTick() {
  try {
    // Nur ein Maester-Lauf gleichzeitig — egal ob manuell oder geplant.
    for (const j of appJobs.values()) {
      if (j.isMaester && j.status === "running") return;
    }
    const s = loadState();
    const now = Date.now();
    // Testsuite einmal taeglich aktuell halten — Audits kommen im naechsten
    // Tick dran, nie parallel zur Aktualisierung.
    if (!maesterSuiteRefreshing && (!s.maesterSuite || !s.maesterSuite.checkedAt || now - new Date(s.maesterSuite.checkedAt).getTime() > 24 * 3600000)) {
      refreshMaesterSuite(null);
      return;
    }
    for (const t of s.tenants || []) {
      const sch = t.maesterSchedule;
      if (!sch || !sch.enabled) continue;
      const days = MAESTER_INTERVALS[sch.interval] || 7;
      const last = t.maester && t.maester.generatedAt ? new Date(t.maester.generatedAt).getTime() : 0;
      if (now - last < days * 86400000) continue;
      if (sch.lastAttemptAt && now - new Date(sch.lastAttemptAt).getTime() < MAESTER_RETRY_GAP_MS) continue;
      if (!t.organization || !t.clientId || !fs.existsSync(certPemPath(t.tenantId))) continue;
      let running = false;
      for (const j of appJobs.values()) { if (j.tenantId === t.id && j.status === "running") { running = true; break; } }
      if (running) continue;

      // Versuch sofort verbuchen, damit ein haengender/langsamer Lauf im
      // naechsten Tick nicht doppelt startet.
      const s2 = loadState();
      const rec = (s2.tenants || []).find(x => x.id === t.id);
      if (rec) { rec.maesterSchedule = { ...(rec.maesterSchedule || {}), lastAttemptAt: new Date().toISOString() }; saveState(s2); }

      console.log("Maester-Zeitplan: starte Audit fuer " + t.name + " (" + (sch.interval || "weekly") + ")");
      const job = createAppJob(t, MAESTER_PHASES);
      job.isMaester = true;
      job.scheduled = true;
      runMaesterJob(job, t, MAESTER.sanitizeTags(sch.suites));
      return; // ein Lauf pro Tick
    }
  } catch (e) { console.log("Maester-Zeitplan-Fehler: " + e.message); }
}
setInterval(maesterScheduleTick, MAESTER_SCHEDULE_TICK_MS);
// Kurz nach dem Start einmal pruefen — faellige Tenants sollen nicht bis zum
// ersten Tick warten, aber der Container darf erst in Ruhe hochkommen.
setTimeout(maesterScheduleTick, 90 * 1000);

// ---------- Tenant-zu-Tenant-Geraetemigration ----------
// Konfigurator fuer das Migrationspaket (igeeks-Fork von
// stevecapacity/intunemigration-v9). Deployt wird ausschliesslich im
// QUELLTENANT -- dort sind die Geraete noch Intune-verwaltet. Der Zieltenant
// braucht kein Deployment, nur eine App-Registrierung und ein Provisioning
// Package. Der aktive Tenant im Tool ist also immer der Quelltenant.
const MIGRATION_PHASES = [
  "Paket zusammenstellen",
  "App-Objekt anlegen",
  "Content-Version anlegen",
  "Installer verschluesseln",
  "Content-Datei registrieren",
  "Auf Azure-Storage-URI warten",
  "Installer hochladen",
  "Veroeffentlichen"
];

// Das Provisioning Package liegt waehrend der Konfiguration in der Session,
// nicht im State: es enthaelt den Bulk-Enrollment-Token des Zieltenants und
// hat auf der Platte des Servers nichts verloren.
app.post("/api/tenants/:id/migration/ppkg", express.json({ limit: "8mb" }), (req, res) => {
  const b = req.body || {};
  const name = String(b.name || "").trim();
  if (!/\.ppkg$/i.test(name)) return res.status(400).json({ error: "Datei muss auf .ppkg enden." });
  let data;
  try { data = Buffer.from(String(b.dataBase64 || ""), "base64"); }
  catch (e) { return res.status(400).json({ error: "Datei nicht lesbar." }); }
  if (!data.length) return res.status(400).json({ error: "Datei ist leer." });
  if (data.length > 6 * 1024 * 1024) return res.status(413).json({ error: "Provisioning Package groesser als 6 MB — das ist vermutlich kein PPKG." });

  req.session.migrationPpkg = { name, dataBase64: data.toString("base64"), size: data.length };
  res.json({ ok: true, name, size: data.length });
});

app.get("/api/tenants/:id/migration/ppkg", (req, res) => {
  const p = req.session.migrationPpkg;
  res.json({ ok: true, present: !!p, name: p ? p.name : null, size: p ? p.size : 0 });
});

app.delete("/api/tenants/:id/migration/ppkg", (req, res) => {
  delete req.session.migrationPpkg;
  res.json({ ok: true });
});

// Vorschau der config.json — damit vor dem Deploy sichtbar ist, was auf den
// Geraeten landet. Secrets werden maskiert.
app.post("/api/tenants/:id/migration/preview", wrap(async (req, res) => {
  const cfg = MIGRATION.buildConfig(req.body || {});
  const masked = JSON.parse(JSON.stringify(cfg));
  masked.sourceTenant.clientSecret = "<gesetzt>";
  masked.targetTenant.clientSecret = "<gesetzt>";
  if (masked.fallbackAdmin.password) masked.fallbackAdmin.password = "<gesetzt>";
  res.json({ ok: true, config: masked, ppkg: req.session.migrationPpkg ? req.session.migrationPpkg.name : null });
}));

async function runMigrationDeployJob(job, t, b, ppkg) {
  const onProgress = appJobProgress(job);
  const cert = certPemPath(t.tenantId);
  try {
    onProgress("Paket zusammenstellen");
    const cfg = MIGRATION.buildConfig(b);
    const files = MIGRATION.buildPackageFiles(cfg, { name: ppkg.name, data: Buffer.from(ppkg.dataBase64, "base64") });
    const payload = MIGRATION.buildAppPayload({
      appName: b.appName || "Tenant-Migration",
      description: b.description,
      targetTenantName: cfg.targetTenant.tenantName,
      packageName: WIN32APP.INTUNE_PACKAGE_NAME
    });

    let appId;
    if (process.env.FAKE_DEPLOY === "1") {
      for (const p of MIGRATION_PHASES.slice(1)) { onProgress(p); await new Promise(r => setTimeout(r, 300)); }
      appId = "fake-migration-app";
    } else {
      const r = await WIN32APP.createWin32AppWithContent(t, cert, {
        appPayload: payload,
        setupFileName: files.setupFileName,
        installerBuffer: files.installerBuffer,
        extraFiles: files.extraFiles,
        onProgress
      });
      appId = r.appId;
    }

    job.appId = appId;
    // Bewusst KEINE automatische Zuweisung: dieses Paket loest ein Geraet aus
    // dem Tenant. Die Zuweisung an eine Pilotgruppe macht der Admin in Intune
    // selbst -- eine falsch getroffene Zielgruppe waere hier nicht reparabel.
    job.hint = "Nicht zugewiesen — Zuweisung an die Pilotgruppe bewusst manuell in Intune vornehmen.";
    finishAppJob(job, true);
  } catch (e) {
    const isPermIssue = e.status === 403 || /insufficient privileges|authorization|forbidden/i.test(String(e.message || ""));
    finishAppJob(job, false, e.message, e.hint || (isPermIssue
      ? "Braucht DeviceManagementApps.ReadWrite.All im Quelltenant — im Bereich 'Tenants' einmal Reparieren ausfuehren."
      : null));
  }
}

app.post("/api/tenants/:id/migration/deploy", wrap(async (req, res) => {
  const t = requireTenant(req);
  const b = req.body || {};
  const ppkg = req.session.migrationPpkg;
  if (!ppkg) return res.status(400).json({ error: "Kein Provisioning Package hochgeladen." });
  if (!String(b.appName || "").trim()) return res.status(400).json({ error: "Name der Intune-App fehlt." });

  // Validierung vor dem Job, damit Eingabefehler im Formular landen statt als
  // fehlgeschlagener Job.
  MIGRATION.buildConfig(b);

  for (const j of appJobs.values()) {
    if (j.tenantId === t.id && j.status === "running") {
      return res.status(409).json({ error: "Fuer diesen Tenant laeuft bereits ein App-Deployment.", jobId: j.id });
    }
  }
  const job = createAppJob(t, MIGRATION_PHASES);
  runMigrationDeployJob(job, t, b, ppkg);
  res.json({ ok: true, jobId: job.id });
}));

// ---------- Conditional Access ----------
app.get("/api/conditionalaccess/tiers", (req, res) => {
  const { CA_POLICY_TEMPLATES } = require("./lib/conditionalAccessPolicies");
  const tiers = {};
  for (const key of Object.keys(CONDACCESS.TIER_META)) {
    const templates = CA_POLICY_TEMPLATES[key] || [];
    tiers[key] = {
      ...CONDACCESS.TIER_META[key],
      policyCount: templates.length,
      // Namen mit <RING>-Platzhalter roh ausliefern — das Frontend ersetzt
      // live mit dem gewaehlten Ring, damit die Vorschau exakt zeigt, was
      // beim Deploy angelegt wird.
      policyNames: templates.map(t => String(t.displayName || ""))
    };
  }
  res.json({ ok: true, tiers });
});

function fakeCaPolicies() {
  return {
    supportGroups: [
      { key: "breakGlass", name: "AAD-CA-BreakGlass", id: "ca-g1", memberCount: 0 },
      { key: "syncAccounts", name: "AAD-CA-SyncAccounts", id: "ca-g2", memberCount: 1 },
      { key: "exclusionTemp", name: "AAD-CA-ExclusionTemp", id: "ca-g3", memberCount: 0 },
      { key: "exclusionPerm", name: "AAD-CA-ExclusionPermanent", id: "ca-g4", memberCount: 0 },
      { key: "ring:PILOT", name: "AAD-CA-RING-PILOT", id: "ca-g5", memberCount: 0 }
    ],
    policies: [
      { id: "ca-p1", displayName: "100 - PILOT - Admin protection - All apps: Require Strong Auth For admins", state: "enabledForReportingButNotEnforced", scope: "Rollen: Admins", managed: true },
      { id: "ca-p2", displayName: "200 - PILOT - Base protection - All apps: Require Strong Auth or trusted device or trusted location", state: "enabledForReportingButNotEnforced", scope: "AAD-CA-RING-PILOT", managed: true },
      { id: "ca-p3", displayName: "300 - BP - Attack surface reduction - All apps: Block access When using other clients", state: "enabled", scope: "Alle", managed: true },
      { id: "ca-p4", displayName: "Legacy - Block Legacy Auth (manuell im Portal angelegt)", state: "enabled", scope: "Alle", managed: false }
    ]
  };
}

app.get("/api/tenants/:id/conditionalaccess/policies", wrap(async (req, res) => {
  const t = requireTenant(req);
  if (process.env.FAKE_DEPLOY === "1") return res.json({ ok: true, ...fakeCaPolicies() });
  const cert = certPemPath(t.tenantId);
  const [policies, groups] = await Promise.all([
    CONDACCESS.listAllPolicies(t, cert),
    GRAPHLIB.graphAllPages(t, cert, "/groups?$select=id,displayName", { retryTransient: true })
  ]);
  const groupName = new Map(groups.map(g => [g.id, g.displayName]));
  const supportGroups = [];
  for (const g of CONDACCESS.SUPPORT_GROUPS) {
    const match = groups.find(x => x.displayName === g.name);
    let memberCount = 0;
    if (match) {
      try { memberCount = (await GRAPHLIB.graphAllPages(t, cert, `/groups/${match.id}/members?$select=id`, { retryTransient: true })).length; } catch (e) { /* egal */ }
    }
    supportGroups.push({ key: g.key, name: g.name, id: match ? match.id : null, memberCount });
  }
  // Ring-Zielgruppen (AAD-CA-RING-*) mit anzeigen — sie steuern, WEN ein
  // ring-getargetetes Deployment trifft, und brauchen dieselbe Mitglieder-Pflege.
  for (const g of groups.filter(x => /^AAD-CA-RING-[A-Z0-9]{2,12}$/i.test(String(x.displayName || "")))) {
    let memberCount = 0;
    try { memberCount = (await GRAPHLIB.graphAllPages(t, cert, `/groups/${g.id}/members?$select=id`, { retryTransient: true })).length; } catch (e) { /* egal */ }
    supportGroups.push({ key: "ring:" + g.displayName.replace(/^AAD-CA-RING-/i, "").toUpperCase(), name: g.displayName, id: g.id, memberCount });
  }
  res.json({
    ok: true,
    supportGroups,
    policies: policies.map(p => {
      const u = (p.conditions && p.conditions.users) || {};
      const scope = (u.includeGroups || []).length ? (u.includeGroups.map(id => groupName.get(id) || id).join(", "))
        : (u.includeRoles || []).length ? "Rollen (" + u.includeRoles.length + ")"
        : "Alle";
      return { id: p.id, displayName: p.displayName, state: p.state, scope, managed: !!p.managed };
    })
  });
}));

app.post("/api/tenants/:id/conditionalaccess/deploy", wrap(async (req, res) => {
  const t = requireTenant(req);
  const tier = String((req.body || {}).tier || "");
  const indices = Array.isArray((req.body || {}).indices) ? (req.body.indices.map(Number).filter(n => Number.isInteger(n) && n >= 0)) : null;
  const ringTargeted = !!(req.body || {}).ringTargeted;
  let ring;
  try { ring = CONDACCESS.normalizeRing((req.body || {}).ring || "BP"); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  if (!CONDACCESS.TIER_META[tier]) return res.status(400).json({ error: "Unbekanntes Tier: " + tier });
  for (const j of appJobs.values()) {
    if (j.tenantId === t.id && j.status === "running") {
      return res.status(409).json({ error: "Fuer diesen Tenant laeuft bereits ein Job.", jobId: j.id });
    }
  }
  const job = createAppJob(t, ["Schutzgruppen sicherstellen", "Bestehende Policies laden", "Policies ausrollen"]);
  (async () => {
    const onProgress = appJobProgress(job);
    try {
      if (process.env.FAKE_DEPLOY === "1") {
        onProgress("Schutzgruppen sicherstellen"); await new Promise(r => setTimeout(r, 600));
        onProgress("Bestehende Policies laden"); await new Promise(r => setTimeout(r, 400));
        const { CA_POLICY_TEMPLATES } = require("./lib/conditionalAccessPolicies");
        const count = indices ? indices.length : (CA_POLICY_TEMPLATES[tier] || []).length;
        for (let i = 1; i <= count; i++) { onProgress(`Policy ${i}/${count}`); await new Promise(r => setTimeout(r, 150)); }
        job.results = { created: count, updated: 0, failed: 0 };
      } else {
        const r = await CONDACCESS.deployTier(t, certPemPath(t.tenantId), tier, onProgress, { indices, ring, ringTargeted });
        const created = r.results.filter(x => x.status === "created").length;
        const updated = r.results.filter(x => x.status === "updated").length;
        const failed = r.results.filter(x => x.status === "failed").length;
        job.results = { created, updated, failed, ring, ringGroup: r.ringGroup ? r.ringGroup.name : null, details: r.results };
      }
      finishAppJob(job, true);
    } catch (e) {
      const isPermIssue = e.status === 403 || /insufficient privileges|authorization|forbidden/i.test(String(e.message || ""));
      finishAppJob(job, false, e.message, isPermIssue
        ? "Conditional-Access-Deployment braucht Policy.ReadWrite.ConditionalAccess — im Tab 'Tenants' einmal Reparieren ausfuehren."
        : null);
    }
  })();
  res.json({ ok: true, jobId: job.id });
}));

app.post("/api/tenants/:id/conditionalaccess/policies/:policyId/state", wrap(async (req, res) => {
  const t = requireTenant(req);
  const state = String((req.body || {}).state || "");
  if (!["enabledForReportingButNotEnforced", "enabled", "disabled"].includes(state)) {
    return res.status(400).json({ error: "Ungültiger state." });
  }
  if (process.env.FAKE_DEPLOY === "1") return res.json({ ok: true });
  await CONDACCESS.setPolicyState(t, certPemPath(t.tenantId), req.params.policyId, state);
  res.json({ ok: true });
}));

app.post("/api/tenants/:id/conditionalaccess/policies/:policyId/scope", wrap(async (req, res) => {
  const t = requireTenant(req);
  const pilotGroupId = (req.body || {}).pilotGroupId || null;
  if (process.env.FAKE_DEPLOY === "1") return res.json({ ok: true });
  await CONDACCESS.setPolicyScope(t, certPemPath(t.tenantId), req.params.policyId, pilotGroupId);
  res.json({ ok: true });
}));

// Loeschen ist unumkehrbar (anders als Deaktivieren/Report-only) -- bewusst
// als eigener Endpunkt, nicht Teil von /state. Wirkt auf JEDE Policy im
// Tenant (auch Fremd-Policies), nicht nur auf tool-verwaltete -- das Frontend
// erzwingt dafuer eine verschaerfte Bestaetigung (siehe "riskier"-Flag).
app.post("/api/tenants/:id/conditionalaccess/policies/:policyId/delete", wrap(async (req, res) => {
  const t = requireTenant(req);
  if (process.env.FAKE_DEPLOY === "1") return res.json({ ok: true });
  await CONDACCESS.deletePolicy(t, certPemPath(t.tenantId), req.params.policyId);
  res.json({ ok: true });
}));

// Nutzer-Suche fuer den Schutzgruppen-Assignment-Assistenten (z.B. Break-Glass befuellen).
app.get("/api/tenants/:id/conditionalaccess/users", wrap(async (req, res) => {
  const t = requireTenant(req);
  const q = String(req.query.q || "");
  if (process.env.FAKE_DEPLOY === "1") {
    const fake = [
      { id: "fake-u1", displayName: "Anna Admin", userPrincipalName: "anna.admin@" + (t.organization || "test.onmicrosoft.com"), mail: "anna.admin@example.com" },
      { id: "fake-u2", displayName: "Max Mustermann", userPrincipalName: "max.mustermann@" + (t.organization || "test.onmicrosoft.com"), mail: "max.mustermann@example.com" }
    ];
    return res.json({ ok: true, users: q.length < 2 ? [] : fake.filter(u => u.displayName.toLowerCase().includes(q.toLowerCase())) });
  }
  const users = await ENTRAUSERS.searchUsers(t, certPemPath(t.tenantId), q);
  res.json({ ok: true, users });
}));

// Bestehenden Nutzer in eine Schutz- oder Ring-Gruppe aufnehmen (Assignment-Assistent).
// key: einer der SUPPORT_GROUPS-Keys ODER "ring:<RING>" fuer AAD-CA-RING-<RING>.
app.post("/api/tenants/:id/conditionalaccess/supportgroups/:key/members", wrap(async (req, res) => {
  const t = requireTenant(req);
  const key = req.params.key;
  const userId = String((req.body || {}).userId || "");
  const isRing = key.startsWith("ring:");
  if (!isRing && !CONDACCESS.SUPPORT_GROUPS.some(g => g.key === key)) return res.status(400).json({ error: "Unbekannte Schutzgruppe: " + key });
  if (!userId) return res.status(400).json({ error: "userId fehlt." });
  if (process.env.FAKE_DEPLOY === "1") return res.json({ ok: true });
  const cert = certPemPath(t.tenantId);
  let groupId;
  if (isRing) {
    groupId = (await CONDACCESS.ensureRingGroup(t, cert, key.slice(5))).id;
  } else {
    groupId = (await CONDACCESS.ensureSupportGroups(t, cert))[key].id;
  }
  await APPGROUPS.nestGroupAsMember(t, cert, groupId, userId);
  res.json({ ok: true });
}));

// Dediziertes Break-Glass-Notfallzugriffskonto anlegen + direkt der Schutzgruppe zuweisen.
// Passwort wird NUR in dieser Antwort sichtbar (Graph speichert es nicht im Klartext) —
// das Frontend muss es einmalig anzeigen und darf es nicht weiter cachen/loggen.
app.post("/api/tenants/:id/conditionalaccess/breakglass/create", wrap(async (req, res) => {
  const t = requireTenant(req);
  const username = String((req.body || {}).username || "").trim();
  if (!username) return res.status(400).json({ error: "Benutzername fehlt." });
  if (process.env.FAKE_DEPLOY === "1") {
    return res.json({ ok: true, userPrincipalName: username + "@" + (t.organization || "test.onmicrosoft.com"), password: "Fake-" + Math.random().toString(36).slice(2, 10) + "!Aa1" });
  }
  const cert = certPemPath(t.tenantId);
  const domain = t.organization || t.tenantId;
  const created = await ENTRAUSERS.createBreakGlassUser(t, cert, domain, username);
  const groupIds = await CONDACCESS.ensureSupportGroups(t, cert);
  await APPGROUPS.nestGroupAsMember(t, cert, groupIds.breakGlass.id, created.id);
  res.json({ ok: true, userPrincipalName: created.userPrincipalName, password: created.password });
}));

// Ist-Zustand-Audit: liest die BP_-Policies live aus dem Tenant (EXO) und
// startet parallel einen TCM-Snapshot fuer die Alert Policy (Graph).
// Der Soll/Ist-Vergleich passiert im Frontend (dort liegt die Konfiguration).
app.post("/api/tenants/:id/audit", wrap(async (req, res) => {
  const t = requireTenant(req);
  if (process.env.FAKE_DEPLOY === "1") {
    return res.json({
      ok: true, audit: fakeAudit(),
      alertPolicy: { status: "done", found: true, notifyUser: ["admin@example.com", "support@msp-provider.com"], disabled: false, aggregationType: "None" },
      acceptedDeviations: t.acceptedDeviations || []
    });
  }

  // TCM-Snapshot parallel zum EXO-Audit anstossen (der Job braucht ohnehin etwas)
  let tcmJob = null, tcmStartErr = null;
  try { tcmJob = await TCM.startAlertPolicySnapshot(t, certPemPath(t.tenantId)); }
  catch (e) { tcmStartErr = e.message; }

  const auth = { appId: t.clientId, organization: t.organization, certPemPath: certPemPath(t.tenantId) };
  const r = await EXO.runExo(auth, DEPLOY.buildAuditBody(), 180000);
  if (!r.ok) return res.status(502).json({ error: "EXO-Runner: " + r.error });
  if (!r.data || r.data.ok === false) return res.status(502).json({ error: (r.data && r.data.error) || "Audit fehlgeschlagen" });

  // TCM-Ergebnis kurz abwarten (max ~30s), sonst uebernimmt das Frontend das Polling
  let alertPolicy;
  if (!tcmJob || !tcmJob.id) {
    alertPolicy = { status: "error", error: tcmStartErr || "TCM-Snapshot konnte nicht gestartet werden", hint: "🔧 Reparieren ausführen — richtet die TCM-Voraussetzungen ein (TCM-SP, Exchange.ManageAsApp, Security Reader, ConfigurationMonitoring-Permission)." };
  } else {
    alertPolicy = { status: "pending", jobId: tcmJob.id };
    for (let i = 0; i < 6; i++) {
      await new Promise(rs => setTimeout(rs, 5000));
      try {
        const result = await TCM.getAlertPolicySnapshotResult(t, certPemPath(t.tenantId), tcmJob.id);
        if (result.status !== "pending") { alertPolicy = result; break; }
      } catch (e) { alertPolicy = { status: "error", error: e.message }; break; }
    }
    if (alertPolicy.status === "pending") alertPolicy.jobId = tcmJob.id;
  }

  res.json({ ok: true, audit: r.data.audit || {}, alertPolicy, acceptedDeviations: t.acceptedDeviations || [] });
}));

// SPF/DKIM/DMARC-Checker: DKIM-Aktivierungsstatus per EXO (Get-DkimSigningConfig),
// SPF/DMARC/DKIM-CNAME-Records direkt per DNS (oeffentliche Records, keine
// zusaetzliche Berechtigung noetig). Deckt speziell den Fall ab, dass DKIM in
// M365 "Enabled" ist, die CNAMEs beim Registrar aber nie gesetzt wurden.
app.post("/api/tenants/:id/domainauth", wrap(async (req, res) => {
  const t = requireTenant(req);
  if (process.env.FAKE_DEPLOY === "1") return res.json({ ok: true, results: fakeDomainAuth() });

  const auth = { appId: t.clientId, organization: t.organization, certPemPath: certPemPath(t.tenantId) };
  const r = await EXO.runExo(auth, DOMAINAUTH.buildDomainAuthExoBody(), 60000);
  if (!r.ok) return res.status(502).json({ error: "EXO-Runner: " + r.error });
  if (!r.data || r.data.ok === false) return res.status(502).json({ error: (r.data && r.data.error) || "DKIM-Abfrage fehlgeschlagen" });

  const domains = r.data.domains || [];
  if (!domains.length) return res.json({ ok: true, results: [] });
  const results = await DOMAINAUTH.checkDomains(domains, r.data.configs || []);
  res.json({ ok: true, results });
}));

// Gewollte Abweichungen: einzelne Audit-Checks pro Tenant als bewusst abweichend
// markieren (z.B. Spoof-Aktion = MoveToJmf). Sie erscheinen dann im Audit/PDF als
// ℹ️ statt ❌ und zaehlen nicht als Abweichung. reason leer => Markierung entfernen.
app.post("/api/tenants/:id/deviations", wrap(async (req, res) => {
  requireTenant(req);
  const key = String((req.body && req.body.key) || "").trim();
  const reason = String((req.body && req.body.reason) || "").trim();
  if (!key) return res.status(400).json({ error: "key fehlt" });
  const s = loadState();
  const tenant = (s.tenants || []).find(x => x.id === req.params.id);
  if (!tenant) return res.status(404).json({ error: "Tenant nicht gefunden" });
  const list = (tenant.acceptedDeviations || []).filter(d => d.key !== key);
  if (reason) list.push({ key, reason: reason.slice(0, 300), ts: new Date().toISOString() });
  tenant.acceptedDeviations = list;
  saveState(s);
  res.json({ ok: true, acceptedDeviations: list });
}));

// Fortsetzung des TCM-Snapshot-Pollings (wenn der Job beim Audit noch lief)
app.get("/api/tenants/:id/tcm/:jobId", wrap(async (req, res) => {
  const t = requireTenant(req);
  const result = await TCM.getAlertPolicySnapshotResult(t, certPemPath(t.tenantId), req.params.jobId);
  res.json(result);
}));

app.listen(PORT, () => console.log("Live-Deploy-API laeuft auf Port " + PORT + " (State: " + STATE_DIR + ")"));
