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
// Graph-Application-Permissions: OIB-Zuweisung (Intune + Gruppen) und
// TCM-Snapshots (Alert-Policy-Pruefung im Audit)
const GRAPH_APP_PERMS = ["DeviceManagementConfiguration.ReadWrite.All", "DeviceManagementServiceConfig.ReadWrite.All", "Group.Read.All", "ConfigurationMonitoring.ReadWrite.All"];
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

// Auth-Guard fuer alles Weitere
app.use("/api", (req, res, next) => {
  if (req.session && req.session.user) return next();
  res.status(401).json({ error: "Nicht angemeldet" });
});

// ---------- Agent-Downloads (Bitdefender / N-sight RMM) ----------
// Die API-Keys bleiben hier im Backend; das Frontend laedt ueber diesen Proxy.

app.get("/api/downloads/config", (req, res) => {
  const bd = BD.config();
  const rmm = NSIGHT.config();
  res.json({ ok: true, bd: bd.enabled, rmm: rmm.enabled, bdHost: bd.host, rmmServer: rmm.fixed || null });
});

app.get("/api/downloads/bd/packages", wrap(async (req, res) => {
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
    certPresent: fs.existsSync(certPemPath(t.tenantId))
  })));
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
      { id: "p4", name: "Win - OIB - SC - Credential Management - D - Passwordless", apiType: "configurationPolicies", type: "Settings Catalog", assignments: [] }
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

// Live-Deploy starten: legt einen Job an und antwortet sofort mit der Job-Id.
// Die UI pollt /api/jobs/:id fuer den Live-Fortschritt.
app.post("/api/tenants/:id/deploy", wrap(async (req, res) => {
  const t = requireTenant(req);
  const b = req.body || {};
  let cfg;
  try { cfg = DEPLOY.sanitizeConfig(b.config); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  // autoDomains: Rules bekommen die Accepted Domains des Ziel-Tenants
  // (Get-AcceptedDomain zur Laufzeit) statt der Domains aus der Tool-Config.
  if (b.autoDomains) cfg.domains = [];

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
