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

const EXO = require("./lib/exorunner");
const DEPLOY = require("./lib/deploy");
const OIB = require("./lib/oib");
const TCM = require("./lib/tcm");
const AUTOPILOT = require("./lib/autopilot");
const GRAPHLIB = require("./lib/graph");
const BD = require("./lib/bitdefender");
const NSIGHT = require("./lib/nsight");
const WIN32APP = require("./lib/win32app");
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
// verschachteln + Win32-App-Upload) und Conditional-Access-Deployment.
// Bestehende Tenants brauchen dafuer einmal "Reparieren" (idempotent additiv,
// siehe repairAppReg — kein Neu-Onboarding noetig).
const GRAPH_APP_PERMS = ["DeviceManagementConfiguration.ReadWrite.All", "DeviceManagementServiceConfig.ReadWrite.All", "Group.ReadWrite.All", "DeviceManagementApps.ReadWrite.All", "ConfigurationMonitoring.ReadWrite.All", "Policy.ReadWrite.ConditionalAccess", "Policy.Read.All", "Application.Read.All", "User.ReadWrite.All", "Organization.Read.All", "AuditLog.Read.All", "DeviceManagementScripts.ReadWrite.All"];
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

  return { exoSp, manageRole, graphSp, graphRoles };
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
  const { exoSp, manageRole, graphSp, graphRoles } = await resolvePermissionTargets(token);
  const requiredResourceAccess = [
    { resourceAppId: EXO_APP_ID, resourceAccess: [{ id: manageRole.id, type: "Role" }] },
    { resourceAppId: GRAPH_APP_ID, resourceAccess: graphRoles.map(r => ({ id: r.id, type: "Role" })) }
  ];

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
    for (const r of graphRoles) await ensureAppRoleAssignment(token, appSp.id, graphSp.id, r.id, existing);
  } catch (e) { consentOk = false; consentErr = e.message; }

  // Entra-Rollen zuweisen: Exchange Administrator (Policies schreiben) und
  // Compliance Administrator (fuer einen spaeteren Windows-Worker der Alert Policy).
  let exoRole = false, exoRoleErr = null;
  try { await ensureDirectoryRole(token, appSp.id, EXCHANGE_ADMIN_ROLE_TEMPLATE); exoRole = true; } catch (e) { exoRoleErr = e.message || String(e); }
  let sccRole = false, sccRoleErr = null;
  try { await ensureDirectoryRole(token, appSp.id, COMPLIANCE_ADMIN_ROLE_TEMPLATE); sccRole = true; } catch (e) { sccRoleErr = e.message || String(e); }

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
async function repairAppReg(token, rec) {
  const items = [];
  const push = (name, state, detail) => items.push({ name, state, detail: detail || "" });

  // 1. App-Registrierung ueber die bekannte Client-Id finden (praeziser als displayName)
  const app = (await gReq(token, "GET", `/applications?$filter=appId eq '${rec.clientId}'`)).value[0];
  if (!app) {
    push("App-Registrierung", "failed", "App " + rec.clientId + " nicht gefunden — Tenant neu onboarden.");
    return { items, exoRole: false, sccRole: false };
  }
  push("App-Registrierung", "ok", app.displayName);

  // 2. API-Permissions: Exchange.ManageAsApp + Graph-Rollen (OIB) im Manifest
  const { exoSp, manageRole, graphSp, graphRoles } = await resolvePermissionTargets(token);
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
    ensureEntry(GRAPH_APP_ID, graphRoles.map(r => r.id));
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
      for (const r of graphRoles) states.push(await ensureAppRoleAssignment(token, appSp.id, graphSp.id, r.id, existing));
      push("Admin-Consent (EXO + Graph)", states.includes("fixed") ? "fixed" : "ok");
    } catch (e) { push("Admin-Consent (EXO + Graph)", "failed", e.message); }
  }

  // 5./6. Entra-Rollen
  let exoRole = false, sccRole = false, tcm = false;
  if (appSp) {
    try { push("Exchange-Administrator-Rolle", await ensureDirectoryRole(token, appSp.id, EXCHANGE_ADMIN_ROLE_TEMPLATE)); exoRole = true; }
    catch (e) { push("Exchange-Administrator-Rolle", "failed", e.message); }
    try { push("Compliance-Administrator-Rolle", await ensureDirectoryRole(token, appSp.id, COMPLIANCE_ADMIN_ROLE_TEMPLATE)); sccRole = true; }
    catch (e) { push("Compliance-Administrator-Rolle", "failed", e.message); }
  }

  // 6b. TCM-Einrichtung (Alert-Policy-Pruefung im Audit)
  try { push("TCM-Einrichtung (Alert-Policy-Prüfung)", await ensureTcmSetup(token, exoSp, manageRole)); tcm = true; }
  catch (e) { push("TCM-Einrichtung (Alert-Policy-Prüfung)", "failed", e.message); }

  // 7. Zertifikat: KEINE Rotation — nur pruefen und ggf. den Public Key aus dem
  //    lokalen PEM wieder an der App hinterlegen (falls dort entfernt).
  try {
    const localPem = fs.existsSync(certPemPath(rec.tenantId)) ? fs.readFileSync(certPemPath(rec.tenantId), "utf8") : null;
    const appHasCert = Array.isArray(app.keyCredentials) && app.keyCredentials.length > 0;
    if (!localPem) {
      push("Zertifikat", "failed", "Kein lokales Zertifikat im Backend — Tenant neu onboarden (erzeugt ein neues).");
    } else if (appHasCert) {
      push("Zertifikat", "ok", "lokal + in der App hinterlegt");
    } else {
      const m = localPem.match(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/);
      if (!m) {
        push("Zertifikat", "failed", "Lokales PEM enthaelt kein Zertifikat — Tenant neu onboarden.");
      } else {
        const certB64 = m[1].replace(/\s+/g, "");
        await gReq(token, "PATCH", `/applications/${app.id}`, {
          keyCredentials: [{ type: "AsymmetricX509Cert", usage: "Verify", key: certB64, displayName: APP_DISPLAY_NAME + "-cert" }]
        });
        push("Zertifikat", "fixed", "Public Key aus lokalem PEM wieder an der App hinterlegt");
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
  cookie: { httpOnly: true, sameSite: "lax", secure: false, maxAge: 8 * 3600 * 1000 }
}));

function wrap(fn) {
  return (req, res) => fn(req, res).catch(e => {
    console.error(e.message);
    res.status(e.status || 500).json({ error: e.message });
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

app.get("/api/health", (req, res) => res.json({ ok: true, pwsh: pwshInfo, loggedIn: !!(req.session && req.session.user) }));

app.post("/api/login", (req, res) => {
  const s = loadState();
  const { username, password } = req.body || {};
  if (s.auth && (username || "admin") === s.auth.username) {
    const a = Buffer.from(hashPw(password || "", s.auth.salt), "hex");
    const b = Buffer.from(s.auth.passwordHash, "hex");
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) { req.session.user = s.auth.username; return res.json({ ok: true }); }
  }
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

// Auth-Guard fuer alles Weitere
app.use("/api", (req, res, next) => {
  if (req.session && req.session.user) return next();
  res.status(401).json({ error: "Nicht angemeldet" });
});

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

// ---------- Tenants ----------
app.get("/api/tenants", (req, res) => {
  const s = loadState();
  res.json((s.tenants || []).map(t => ({
    id: t.id, name: t.name, tenantId: t.tenantId, organization: t.organization,
    appId: t.clientId, exoRole: !!t.exoRole, sccRole: !!t.sccRole, tcm: !!t.tcm, addedAt: t.addedAt,
    certPresent: fs.existsSync(certPemPath(t.tenantId)),
    onboardingSteps: t.onboardingSteps || {}
  })));
});

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

  if (process.env.FAKE_DEPLOY === "1") {
    req.session.fix = { tenantRecId: t.id, fake: true, polls: 0 };
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
    tenantRecId: t.id, loginTenant,
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

  const result = await repairAppReg(j.access_token, t);

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
  const profiles = await AUTOPILOT.loadAutopilotProfiles(t, certPemPath(t.tenantId));
  res.json({ ok: true, profiles });
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

app.get("/api/tenants/:id/autopilot/devices", wrap(async (req, res) => {
  const t = requireTenant(req);
  if (process.env.FAKE_DEPLOY === "1") return res.json({ ok: true, ...fakeAutopilotDevices() });
  try {
    const devices = await AUTOPILOT.loadAutopilotDevices(t, certPemPath(t.tenantId));
    writeAutopilotCache(t.tenantId, devices);
    res.json({ ok: true, devices });
  } catch (e) {
    const cached = /internal server error/i.test(String(e.message || "")) ? readAutopilotCache(t.tenantId) : null;
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
    if (evt.type === "phase" && evt.label) { job.phase = String(evt.label); return; }
    if (evt.type === "step" && evt.name) {
      let st = job.steps.find(s => s.name === evt.name);
      if (!st) { st = { phase: job.phase, name: String(evt.name), state: "pending" }; job.steps.push(st); }
      if (evt.state === "running") { st.state = "running"; st.try = evt.try || 1; }
      else if (evt.state === "retry") { st.state = "retry"; st.try = evt.try; st.lastError = evt.error; }
      else if (evt.state === "done") { st.state = "done"; st.action = evt.action; st.tries = evt.tries; }
      else if (evt.state === "failed") { st.state = "failed"; st.error = evt.error; st.tries = evt.tries; }
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
    }
  }
}

function finishJob(job) {
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

  const r = await EXO.runExo(auth, DEPLOY.buildDeployBody(cfg), 600000, onProgress);
  if (!r.ok || !r.data || r.data.ok === false) {
    job.status = "failed";
    job.error = (r.data && r.data.error) || r.error || "Deploy fehlgeschlagen";
    job.hint = "Braucht Exchange.ManageAsApp + Exchange-Administrator-Rolle (Tenant neu onboarden). Frische App-Registrierungen brauchen ein paar Minuten Replikationszeit.";
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

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job nicht gefunden (Backend neu gestartet?)" });
  res.json(job);
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
  res.json(job);
});

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
    publisher: b.vendor === "bitdefender" ? "Bitdefender" : "N-able (N-sight RMM)",
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
    let buffer, fileName;
    if (process.env.FAKE_DEPLOY === "1") {
      await new Promise(r => setTimeout(r, 800));
      buffer = Buffer.from("Fake-Installer-Bytes fuer UI-Test — kein echtes Graph-Upload.");
      fileName = b.vendor === "bitdefender" ? "BitdefenderSetup.exe" : "RMM-Agent-Setup.exe";
    } else if (b.vendor === "bitdefender") {
      ({ buffer, fileName } = await BD.fetchInstallerBuffer(b.source.downloadUrl));
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
      // interaktiver Installer haengt sonst unsichtbar im SYSTEM-Kontext:
      //   Bitdefender: "<datei>" /bdparams /silent   ·   N-sight: "<datei>" /quiet /norestart
      const requiredSwitches = b.vendor === "bitdefender" ? ["/bdparams", "/silent"] : ["/quiet", "/norestart"];
      if (!installCmd.trim()) installCmd = `"${fileName}"`;
      for (const sw of requiredSwitches) {
        if (!new RegExp(sw.replace("/", "\\/") + "\\b", "i").test(installCmd)) installCmd += " " + sw;
      }
      const subst = { ...b, installCommandLine: installCmd,
        uninstallCommandLine: String(b.uninstallCommandLine || "").replace(/\{file\}/g, fileName) };
      const payload = buildWin32AppPayload(subst, fileName);
      const r = await WIN32APP.createWin32AppWithContent(t, cert, {
        appPayload: payload, setupFileName: fileName, installerBuffer: buffer, onProgress
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
      { id: "ca-p1", displayName: "100 - PILOT - Admin protection - All apps: Require Strong Auth For admins", state: "enabledForReportingButNotEnforced", scope: "Rollen: Admins" },
      { id: "ca-p2", displayName: "200 - PILOT - Base protection - All apps: Require Strong Auth or trusted device or trusted location", state: "enabledForReportingButNotEnforced", scope: "AAD-CA-RING-PILOT" },
      { id: "ca-p3", displayName: "300 - BP - Attack surface reduction - All apps: Block access When using other clients", state: "enabled", scope: "Alle" }
    ]
  };
}

app.get("/api/tenants/:id/conditionalaccess/policies", wrap(async (req, res) => {
  const t = requireTenant(req);
  if (process.env.FAKE_DEPLOY === "1") return res.json({ ok: true, ...fakeCaPolicies() });
  const cert = certPemPath(t.tenantId);
  const [policies, groups] = await Promise.all([
    CONDACCESS.listManagedPolicies(t, cert),
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
      return { id: p.id, displayName: p.displayName, state: p.state, scope };
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
