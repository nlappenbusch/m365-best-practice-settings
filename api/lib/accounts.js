"use strict";
/**
 * Konten-Nachweise: privilegierte Konten, Konto-Steckbrief und das
 * Ausnahme-Register.
 *
 * Das Ausnahme-Register beantwortet, was Entra nicht speichert: WOZU ein
 * Sonderkonto (Test-, Admin-, Dienst-, Notfallkonto) existiert, wer es
 * verantwortet und wann es wieder weg soll. Die Einträge liegen im Werkzeug;
 * geprüft werden sie gegen den Tenant — abgelaufen, aber noch aktiv, ist der
 * typische Befund.
 *
 * Ausschliesslich lesend gegen den Tenant.
 */
const { graphReq, graphAllPages } = require("./graph");

const V1 = { retryTransient: 4 };
const BETA = { beta: true, retryTransient: 4 };

// Rollen, die als privilegiert gelten (Template-Ids der Microsoft-Standardrollen).
const PRIVILEGED = new Set([
  "62e90394-69f5-4237-9190-012177145e10", // Globaler Administrator
  "e8611ab8-c189-46e8-94e1-60213ab1f814", // Administrator für privilegierte Rollen
  "7be44c8a-adaf-4e2a-84d6-ab2649e08a13", // Administrator für privilegierte Authentifizierung
  "194ae4cb-b126-40b2-bd5b-6091b380977d", // Sicherheitsadministrator
  "29232cdf-9323-42fd-ade2-1d097af3e4de", // Exchange-Administrator
  "f28a1f50-f6e7-4571-818b-6a12f2af6b6c", // SharePoint-Administrator
  "3a2c62db-5318-420d-8d74-23affee5d9d5", // Intune-Administrator
  "fe930be7-5e62-47db-91af-98c3a49a38b1", // Benutzeradministrator
  "9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3", // Anwendungsadministrator
  "158c047a-c907-4556-b7ef-446551a6b5f7", // Cloudanwendungsadministrator
  "b1be1c3e-b65d-4f19-8427-f6fa0d97feb9", // Administrator für bedingten Zugriff
  "c4e39bd9-1100-46d3-8c65-fb160da0071f", // Authentifizierungsadministrator
  "8ac3fc64-6eca-42ea-9e69-59f4c7b60eb2", // Administrator für hybride Identität
  "17315797-102d-40b4-93e0-432062caca18", // Complianceadministrator
  "69091246-20e8-4a56-aa4d-066075b2a7a8"  // Teams-Administrator
]);
const GLOBAL_ADMIN = "62e90394-69f5-4237-9190-012177145e10";

const METHOD_LABEL = {
  microsoftAuthenticatorAuthenticationMethod: "Authenticator-App",
  phoneAuthenticationMethod: "Telefon",
  fido2AuthenticationMethod: "FIDO2-Schlüssel",
  windowsHelloForBusinessAuthenticationMethod: "Windows Hello",
  emailAuthenticationMethod: "E-Mail",
  passwordAuthenticationMethod: "Kennwort",
  softwareOathAuthenticationMethod: "OATH-Token (Software)",
  temporaryAccessPassAuthenticationMethod: "Befristeter Zugriffspass",
  platformCredentialAuthenticationMethod: "Plattform-Anmeldeinformation (macOS)",
  x509CertificateAuthenticationMethod: "Zertifikat"
};

const USER_SELECT = "id,displayName,userPrincipalName,accountEnabled,createdDateTime,userType,onPremisesSyncEnabled";

/** Benutzer mit letzter Anmeldung — signInActivity braucht Entra ID P1; ohne geht es ohne. */
async function getUser(tenant, cert, idOrUpn, extra) {
  const sel = USER_SELECT + (extra ? "," + extra : "");
  try { return await graphReq(tenant, cert, "GET", `/users/${encodeURIComponent(idOrUpn)}?$select=${sel},signInActivity`, null, V1); }
  catch (e) {
    if (e.status === 404) throw e;
    return graphReq(tenant, cert, "GET", `/users/${encodeURIComponent(idOrUpn)}?$select=${sel}`, null, V1);
  }
}

function lastSignIn(u) {
  const s = u && u.signInActivity;
  if (!s) return null;
  return [s.lastSignInDateTime, s.lastNonInteractiveSignInDateTime, s.lastSuccessfulSignInDateTime].filter(Boolean).sort().pop() || null;
}

async function loadRegistration(tenant, cert) {
  try {
    const list = await graphAllPages(tenant, cert, "/reports/authenticationMethods/userRegistrationDetails?$top=999", V1);
    return { map: new Map(list.map(r => [r.id, r])), error: null };
  } catch (e) { return { map: null, error: e.message }; }
}

async function roleNames(tenant, cert) {
  const m = new Map();
  for (const r of await graphAllPages(tenant, cert, "/roleManagement/directory/roleDefinitions?$select=id,displayName,templateId", V1)) {
    m.set(r.id, { name: r.displayName, templateId: r.templateId || r.id });
    if (r.templateId) m.set(r.templateId, { name: r.displayName, templateId: r.templateId });
  }
  return m;
}

// ============================================================== Privilegierte Konten
async function privilegedAccounts(tenant, cert, say) {
  say = say || (() => {});
  const gaps = [];
  say("Rollen lesen");
  const names = await roleNames(tenant, cert);
  const assignments = await graphAllPages(tenant, cert, "/roleManagement/directory/roleAssignments?$expand=principal&$top=999", V1);

  let eligible = [];
  try {
    say("PIM-berechtigte Zuweisungen lesen");
    eligible = await graphAllPages(tenant, cert, "/roleManagement/directory/roleEligibilitySchedules?$expand=principal&$top=999", V1);
  } catch (e) { gaps.push("PIM-Berechtigungen nicht lesbar (Entra ID P2 bzw. RoleEligibilitySchedule.Read.Directory): " + e.message); }
  const activated = new Map();
  try {
    const inst = await graphAllPages(tenant, cert, "/roleManagement/directory/roleAssignmentScheduleInstances?$filter=assignmentType eq 'Activated'&$top=999", V1);
    for (const i of inst) activated.set(i.principalId + "|" + i.roleDefinitionId, i.endDateTime || null);
  } catch (e) { /* ohne PIM: alles dauerhaft */ }

  const accounts = new Map();   // userId -> account
  const apps = new Map();
  const touch = (u) => {
    if (!accounts.has(u.id)) accounts.set(u.id, { id: u.id, upn: u.userPrincipalName || u.id, name: u.displayName || u.userPrincipalName || u.id, roles: [] });
    return accounts.get(u.id);
  };
  const addRole = async (a, how) => {
    const def = names.get(a.roleDefinitionId) || { name: a.roleDefinitionId, templateId: a.roleDefinitionId };
    const role = {
      name: def.name, privileged: PRIVILEGED.has(def.templateId), global: def.templateId === GLOBAL_ADMIN,
      how, scope: a.directoryScopeId && a.directoryScopeId !== "/" ? a.directoryScopeId : null,
      end: a.scheduleInfo && a.scheduleInfo.expiration ? (a.scheduleInfo.expiration.endDateTime || null) : null
    };
    const p = a.principal || {};
    const t = String(p["@odata.type"] || "").toLowerCase();
    if (t.endsWith("user")) touch(p).roles.push(role);
    else if (t.endsWith("serviceprincipal")) {
      if (!apps.has(p.id)) apps.set(p.id, { id: p.id, name: p.displayName, appId: p.appId, roles: [] });
      apps.get(p.id).roles.push(role);
    } else if (t.endsWith("group")) {
      try {
        const mem = await graphAllPages(tenant, cert, `/groups/${p.id}/transitiveMembers/microsoft.graph.user?$select=id,displayName,userPrincipalName&$top=999`, V1);
        for (const u of mem) touch(u).roles.push({ ...role, how: role.how + ` über Gruppe „${p.displayName}“` });
      } catch (e) { gaps.push(`Mitglieder der Rollengruppe ${p.displayName} nicht lesbar: ${e.message}`); }
    }
  };
  say("Zuweisungen auflösen");
  for (const a of assignments) {
    const act = activated.has(a.principalId + "|" + a.roleDefinitionId);
    await addRole(a, act ? "aktiviert (PIM)" : "dauerhaft");
  }
  for (const a of eligible) await addRole(a, "berechtigt (PIM)");

  say("Konten und MFA lesen");
  const reg = await loadRegistration(tenant, cert);
  if (reg.error) gaps.push("MFA-Registrierung nicht lesbar (Entra ID P1 nötig): " + reg.error);
  for (const acc of accounts.values()) {
    try {
      const u = await getUser(tenant, cert, acc.id);
      Object.assign(acc, {
        upn: u.userPrincipalName, name: u.displayName, enabled: u.accountEnabled !== false, created: u.createdDateTime || null,
        userType: u.userType || "", synced: !!u.onPremisesSyncEnabled, lastSignIn: lastSignIn(u), signInKnown: !!u.signInActivity
      });
    } catch (e) { acc.missing = true; }
    const r = reg.map ? reg.map.get(acc.id) : null;
    acc.mfaRegistered = reg.map ? !!(r && r.isMfaRegistered) : null;
    acc.methods = r ? (r.methodsRegistered || []) : [];
    acc.privileged = acc.roles.some(x => x.privileged);
    acc.globalAdmin = acc.roles.some(x => x.global && x.how !== "berechtigt (PIM)");
  }
  const list = [...accounts.values()].sort((a, b) => Number(b.globalAdmin) - Number(a.globalAdmin) || Number(b.privileged) - Number(a.privileged) || String(a.upn).localeCompare(String(b.upn)));
  const recent = Date.now() - 30 * 864e5;
  return {
    gaps,
    accounts: list,
    apps: [...apps.values()].sort((a, b) => String(a.name).localeCompare(String(b.name))),
    summary: {
      accounts: list.length,
      privileged: list.filter(a => a.privileged).length,
      globalAdmins: list.filter(a => a.globalAdmin).length,
      withoutMfa: list.filter(a => a.privileged && a.mfaRegistered === false).length,
      disabled: list.filter(a => a.enabled === false).length,
      createdLast30: list.filter(a => a.created && new Date(a.created).getTime() >= recent).length,
      apps: apps.size
    }
  };
}

// ============================================================== Konto-Steckbrief
async function accountDossier(tenant, cert, idOrUpn, registerEntries, say) {
  say = say || (() => {});
  const gaps = [];
  say("Konto lesen");
  let u;
  try {
    u = await getUser(tenant, cert, idOrUpn, "mail,creationType,externalUserState,onPremisesSamAccountName,jobTitle,department,companyName,employeeType,employeeId,usageLocation,lastPasswordChangeDateTime,passwordPolicies");
  } catch (e) {
    if (e.status === 404) throw Object.assign(new Error(`Konto „${idOrUpn}“ gibt es im Tenant nicht (mehr).`), { status: 404 });
    throw e;
  }
  const id = u.id;

  say("Gruppen und Rollen lesen");
  let groups = [];
  try {
    groups = (await graphAllPages(tenant, cert, `/users/${id}/transitiveMemberOf/microsoft.graph.group?$select=id,displayName,groupTypes,securityEnabled,mailEnabled,membershipRule&$top=999`, V1))
      .map(g => ({ id: g.id, name: g.displayName, dynamic: (g.groupTypes || []).includes("DynamicMembership"), m365: (g.groupTypes || []).includes("Unified"), security: !!g.securityEnabled }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  } catch (e) { gaps.push("Gruppen nicht lesbar: " + e.message); }

  const roles = [];
  try {
    const names = await roleNames(tenant, cert);
    const groupIds = new Set(groups.map(g => g.id));
    const all = await graphAllPages(tenant, cert, "/roleManagement/directory/roleAssignments?$top=999", V1);
    for (const a of all) {
      if (a.principalId !== id && !groupIds.has(a.principalId)) continue;
      const def = names.get(a.roleDefinitionId) || { name: a.roleDefinitionId, templateId: a.roleDefinitionId };
      const g = groups.find(x => x.id === a.principalId);
      roles.push({ name: def.name, privileged: PRIVILEGED.has(def.templateId), how: g ? `über Gruppe „${g.name}“` : "direkt", scope: a.directoryScopeId !== "/" ? a.directoryScopeId : null });
    }
    try {
      const el = await graphAllPages(tenant, cert, `/roleManagement/directory/roleEligibilitySchedules?$filter=principalId eq '${id}'&$top=999`, V1);
      for (const a of el) {
        const def = names.get(a.roleDefinitionId) || { name: a.roleDefinitionId, templateId: a.roleDefinitionId };
        roles.push({ name: def.name, privileged: PRIVILEGED.has(def.templateId), how: "berechtigt (PIM)", end: a.scheduleInfo && a.scheduleInfo.expiration ? a.scheduleInfo.expiration.endDateTime : null });
      }
    } catch (e) { /* ohne PIM */ }
  } catch (e) { gaps.push("Rollen nicht lesbar: " + e.message); }

  say("Lizenzen und Anmeldemethoden lesen");
  let licenses = [];
  try { licenses = (await graphAllPages(tenant, cert, `/users/${id}/licenseDetails`, V1)).map(l => l.skuPartNumber); } catch (e) { gaps.push("Lizenzen nicht lesbar: " + e.message); }
  let methods = [];
  try {
    methods = (await graphAllPages(tenant, cert, `/users/${id}/authentication/methods`, V1)).map(m => {
      const t = String(m["@odata.type"] || "").replace("#microsoft.graph.", "");
      return { type: METHOD_LABEL[t] || t, detail: m.displayName || m.phoneNumber || m.emailAddress || m.model || "", created: m.createdDateTime || null };
    });
  } catch (e) { gaps.push("Anmeldemethoden nicht lesbar (UserAuthenticationMethod.Read.All): " + e.message); }
  let owned = [];
  try {
    owned = (await graphAllPages(tenant, cert, `/users/${id}/ownedObjects?$select=id,displayName`, V1))
      .map(o => ({ name: o.displayName || o.id, type: String(o["@odata.type"] || "").replace("#microsoft.graph.", "") }));
  } catch (e) { /* optional */ }

  say("Anmeldungen und Protokoll lesen");
  let signIns = [];
  try {
    signIns = (await graphReq(tenant, cert, "GET", `/auditLogs/signIns?$filter=userId eq '${id}'&$top=50`, null, V1)).value || [];
    signIns = signIns.map(s => ({
      at: s.createdDateTime, app: s.appDisplayName, ip: s.ipAddress,
      location: [s.location && s.location.city, s.location && s.location.countryOrRegion].filter(Boolean).join(", "),
      device: [s.deviceDetail && s.deviceDetail.displayName, s.deviceDetail && s.deviceDetail.operatingSystem].filter(Boolean).join(" · "),
      result: s.status && s.status.errorCode === 0 ? "erfolgreich" : `Fehler ${s.status ? s.status.errorCode : "?"}`,
      ca: s.conditionalAccessStatus || ""
    }));
  } catch (e) { gaps.push("Anmeldeprotokoll nicht lesbar (Entra ID P1 nötig): " + e.message); }
  const mapAudit = e => ({
    at: e.activityDateTime, activity: e.activityDisplayName, result: e.result,
    by: (e.initiatedBy && ((e.initiatedBy.user && e.initiatedBy.user.userPrincipalName) || (e.initiatedBy.app && e.initiatedBy.app.displayName))) || "—",
    target: (e.targetResources || []).map(t => t.displayName || t.userPrincipalName).filter(Boolean).join(", ")
  });
  let about = [], by = [];
  try { about = (await graphAllPages(tenant, cert, `/auditLogs/directoryAudits?$filter=targetResources/any(t:t/id eq '${id}')&$top=200`, V1)).map(mapAudit); }
  catch (e) { gaps.push("Entra-Protokoll zum Konto nicht lesbar: " + e.message); }
  try { by = (await graphAllPages(tenant, cert, `/auditLogs/directoryAudits?$filter=initiatedBy/user/id eq '${id}'&$top=200`, V1)).map(mapAudit); }
  catch (e) { /* optional */ }

  const createdAgeDays = u.createdDateTime ? Math.floor((Date.now() - new Date(u.createdDateTime).getTime()) / 864e5) : null;
  const creation = about.find(a => /^add user$/i.test(String(a.activity || "")));
  const reg = (registerEntries || []).find(e => String(e.upn || "").toLowerCase() === String(u.userPrincipalName || "").toLowerCase()) || null;

  return {
    gaps,
    user: {
      id, upn: u.userPrincipalName, name: u.displayName, mail: u.mail || null, enabled: u.accountEnabled !== false,
      created: u.createdDateTime || null, createdAgeDays, userType: u.userType || "", creationType: u.creationType || null,
      externalState: u.externalUserState || null, synced: !!u.onPremisesSyncEnabled, samAccount: u.onPremisesSamAccountName || null,
      jobTitle: u.jobTitle || null, department: u.department || null, company: u.companyName || null, employeeType: u.employeeType || null,
      usageLocation: u.usageLocation || null, lastPasswordChange: u.lastPasswordChangeDateTime || null, passwordPolicies: u.passwordPolicies || null,
      lastSignIn: lastSignIn(u), signInKnown: !!u.signInActivity
    },
    createdBy: creation ? creation.by : null,
    createdByNote: creation ? null : (createdAgeDays !== null && createdAgeDays > 30
      ? `Angelegt vor ${createdAgeDays} Tagen — wer das Konto angelegt hat, steht nur noch im Unified Audit Log (bis 180 Tage, Vorgang „Add user.“).`
      : "Kein Anlage-Eintrag im Entra-Protokoll gefunden."),
    roles, groups, licenses, methods, owned, signIns, auditAbout: about, auditBy: by,
    register: reg,
    summary: { roles: roles.length, privileged: roles.filter(r => r.privileged).length, groups: groups.length, signIns: signIns.length, methods: methods.length }
  };
}

// ============================================================== Ausnahme-Register
const KINDS = { test: "Testkonto", admin: "Admin-Konto", service: "Dienstkonto", breakglass: "Notfallkonto", extern: "Externes Konto", sonstiges: "Sonstiges" };

function normalizeEntry(b, prev) {
  const upn = String(b.upn || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(upn)) throw Object.assign(new Error("UPN ungültig."), { status: 400 });
  const kind = KINDS[b.kind] ? b.kind : "sonstiges";
  const purpose = String(b.purpose || "").trim();
  if (!purpose) throw Object.assign(new Error("Zweck fehlt — genau das soll das Register festhalten."), { status: 400 });
  const date = v => { const s = String(v || "").trim(); if (!s) return null; if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw Object.assign(new Error("Datum im Format JJJJ-MM-TT."), { status: 400 }); return s; };
  return {
    id: prev ? prev.id : (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
    upn, kind, kindLabel: KINDS[kind], purpose: purpose.slice(0, 500),
    owner: String(b.owner || "").trim().slice(0, 120),
    ticket: String(b.ticket || "").trim().slice(0, 60),
    validFrom: date(b.validFrom), validUntil: date(b.validUntil),
    notes: String(b.notes || "").trim().slice(0, 1000),
    createdAt: prev ? prev.createdAt : new Date().toISOString(), createdBy: prev ? prev.createdBy : (b._user || ""),
    updatedAt: new Date().toISOString(), updatedBy: b._user || ""
  };
}

/**
 * Register-Erweiterung «Entscheide und Kommentare» (seit 2.57): dieselbe Liste, dieselben
 * Routen, dieselbe Ablage wie das Ausnahme-Register — Einträge mit objectType betreffen
 * aber kein Konto, sondern ein Objekt (CA-Richtlinie, Intune-Richtlinie, Gruppe, Site,
 * Änderung …) oder ein Kapitel der Ist-Zustand-Doku. Konten-Einträge bleiben, wie sie
 * sind (ohne objectType), und werden weiter gegen den Tenant geprüft; Objekt-Einträge
 * nicht — sie halten fest, was Entra und Intune nicht speichern: warum.
 */
function normalizeObjectEntry(b, prev, types) {
  const objectType = String(b.objectType || "").trim();
  if (!types[objectType]) throw Object.assign(new Error("Objektart unbekannt."), { status: 400 });
  const objectName = String(b.objectName || "").trim().slice(0, 300);
  const objectId = String(b.objectId || "").trim().slice(0, 200) || null;
  if (!objectName && !objectId) throw Object.assign(new Error("Objekt fehlt — Name oder Id angeben."), { status: 400 });
  const text = String(b.text || "").trim();
  if (!text) throw Object.assign(new Error("Text fehlt — genau das soll das Register festhalten."), { status: 400 });
  const date = String(b.date || "").trim();
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw Object.assign(new Error("Datum im Format JJJJ-MM-TT."), { status: 400 });
  return {
    id: prev ? prev.id : (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
    objectType, objectId, objectName: objectName || objectId,
    text: text.slice(0, 2000),
    decision: !!b.decision,
    ref: String(b.ref || "").trim().slice(0, 40) || null,
    author: String(b.author || "").trim().slice(0, 120) || (prev ? prev.author : (b._user || "")),
    date: date || (prev ? prev.date : new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Zurich" }).format(new Date())),
    createdAt: prev ? prev.createdAt : new Date().toISOString(), createdBy: prev ? prev.createdBy : (b._user || ""),
    updatedAt: new Date().toISOString(), updatedBy: b._user || ""
  };
}

const SPECIAL_RE = /(^|[._-])(test|tst|admin|adm|svc|service|srv|brk|notfall|breakglass|emergency|temp|tmp|demo|extern|ext|scan|scanner|noreply|shared)([._-]|\d|$)/i;

/** Register gegen den Tenant prüfen, dazu Vorschläge für noch nicht erfasste Sonderkonten. */
async function checkRegister(tenant, cert, entries, privileged, say) {
  say = say || (() => {});
  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
  const out = [];
  say("Registereinträge prüfen");
  for (const e of entries || []) {
    let u = null, missing = false;
    try { u = await getUser(tenant, cert, e.upn); } catch (err) { missing = err.status === 404; }
    const expired = e.validUntil && e.validUntil < today;
    const expiring = e.validUntil && !expired && e.validUntil <= soon;
    let state, tone;
    if (missing) { state = expired ? "gelöscht (Ablauf erreicht)" : "Konto existiert nicht"; tone = expired ? "ok" : "warn"; }
    else if (expired && u && u.accountEnabled !== false) { state = "abgelaufen, Konto noch aktiv"; tone = "crit"; }
    else if (expired) { state = "abgelaufen, Konto deaktiviert"; tone = "warn"; }
    else if (expiring) { state = "läuft in ≤ 14 Tagen ab"; tone = "warn"; }
    else if (!e.validUntil) { state = "ohne Ablaufdatum"; tone = "warn"; }
    else { state = "gültig"; tone = "ok"; }
    const priv = privileged ? privileged.accounts.find(a => String(a.upn).toLowerCase() === e.upn) : null;
    out.push({
      ...e, state, tone, exists: !missing,
      enabled: u ? u.accountEnabled !== false : null, created: u ? u.createdDateTime : null, lastSignIn: u ? lastSignIn(u) : null,
      roles: priv ? priv.roles.map(r => `${r.name} (${r.how})`) : []
    });
  }

  say("Sonderkonten ohne Registereintrag suchen");
  const known = new Set((entries || []).map(e => e.upn));
  const suggestions = [];
  try {
    const users = await graphAllPages(tenant, cert, "/users?$select=id,displayName,userPrincipalName,accountEnabled,createdDateTime,userType&$top=999", V1);
    for (const u of users) {
      const upn = String(u.userPrincipalName || "").toLowerCase();
      if (!upn || known.has(upn)) continue;
      const local = upn.split("@")[0];
      const priv = privileged ? privileged.accounts.find(a => String(a.upn).toLowerCase() === upn && a.privileged) : null;
      const reasons = [];
      if (priv) reasons.push("privilegierte Rolle: " + priv.roles.filter(r => r.privileged).map(r => r.name).join(", "));
      // Gäste tragen "#ext#" im UPN — das ist kein Hinweis auf ein Sonderkonto.
      if (String(u.userType || "").toLowerCase() !== "guest" && SPECIAL_RE.test(local)) reasons.push("Name deutet auf ein Sonderkonto");
      if (reasons.length) suggestions.push({ upn, name: u.displayName, enabled: u.accountEnabled !== false, created: u.createdDateTime || null, reasons });
    }
  } catch (e) { /* ohne Vorschläge */ }
  suggestions.sort((a, b) => String(a.upn).localeCompare(String(b.upn)));
  return {
    entries: out,
    suggestions: suggestions.slice(0, 300),
    summary: {
      entries: out.length,
      critical: out.filter(x => x.tone === "crit").length,
      warn: out.filter(x => x.tone === "warn").length,
      suggestions: suggestions.length
    }
  };
}

module.exports = { privilegedAccounts, accountDossier, checkRegister, normalizeEntry, normalizeObjectEntry, KINDS, PRIVILEGED };
