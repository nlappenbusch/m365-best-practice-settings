"use strict";
/**
 * Ist-Zustand Microsoft 365 — Erhebung für das Kunden-PDF (lib/istZustandPdf.js).
 *
 * Eine rein lesende Momentaufnahme dessen, was im Tenant konfiguriert ist und wie
 * es wirkt: Konten, Rollen, Lizenzen, Gäste, Anmeldemethoden, bedingter Zugriff,
 * Geräte und Intune, E-Mail (DNS, welche Schutzrichtlinie wirkt, weitere
 * Einstellungen, Warnungsrichtlinien), Anwendungen und Freigaben, SharePoint,
 * OneDrive und Teams, dazu optional das Änderungsprotokoll eines Zeitraums.
 *
 * Wiederverwendet statt neu gebaut: Conditional-Access-Auswertung und Intune-
 * Richtlinien (assignAudit.js, samt Gruppen-Resolver), SharePoint-Inventar
 * (sharepointInventory.js), SPF/DKIM/DMARC (domainAuth.js), Änderungsprotokoll
 * (evidence.js), Warnungsrichtlinien (recipients.js, eigener pwsh-Prozess).
 * Neu sind nur die Teile, die es im Werkzeug noch nicht gab: Lizenzen und Rollen
 * je Konto, Anmeldemethoden-Richtlinie, Zustimmungs-Einstellungen, delegierte und
 * Anwendungs-Freigaben, App-Registrierungen mit Ablauf, Exchange-Schutzrichtlinien
 * samt Vorrangregeln der Voreinstellungen.
 *
 * Grundhaltung wie überall im Werkzeug: Jeder Teil fängt seine Fehler selbst ab.
 * Was nicht lesbar war, steht als Lücke im Ergebnis (gaps) und im PDF — eine Lücke
 * darf nie als "nicht vorhanden" durchgehen.
 *
 * Berechtigungen: ausschliesslich solche, die beide App-Varianten schon haben
 * (Voll-App und Nur-lesen-App fürs Prüfmandat). Einzige Ausnahme ist die
 * Geräteregistrierungs-Richtlinie (Policy.Read.DeviceConfiguration) — fehlt sie,
 * bleibt der Satz dazu weg und die Lücke wird genannt.
 */
const dns = require("dns").promises;
const { graphReq, graphAllPages } = require("./graph");
const EXO = require("./exorunner");
const ASSIGNAUDIT = require("./assignAudit");
const SPINV = require("./sharepointInventory");
const DOMAINAUTH = require("./domainAuth");
const EVIDENCE = require("./evidence");
const RECIPIENTS = require("./recipients");
const LICENSES = require("./licenses");
const { NON_MAIL_DOMAIN_PS_FILTER } = require("./deploy");

const V1 = { retryTransient: 4 };
const BETA = { beta: true, retryTransient: 4 };
const ONE = {};          // Einzelabruf, 404 ist eine normale Antwort
const BETA_ONE = { beta: true };

// Microsoft-eigene Besitzer-Tenants (Erstanbieter-Apps).
const MS_OWNERS = new Set(["f8cdef31-a31e-4b4a-93e4-5f571e91255a", "72f988bf-86f1-41af-91ab-2d7cd011db47", "cdc5aeea-15c5-4db6-b079-fcadd2505dc2", "47df5bb7-e6bc-4256-afb0-dd8c8e3c1ce8"]);
// Microsoft-Werkzeuge, deren Freigaben trotzdem in die Doku gehören: damit wird administriert.
const MS_ADMIN_TOOLS = new Set([
  "14d82eec-204b-4c2f-b7e8-296a70dab67e", // Microsoft Graph Command Line Tools (Connect-MgGraph)
  "de8bc8b5-d9f9-48b1-a8ad-b748da725064", // Graph Explorer
  "1950a258-227b-4e31-a9cf-717495945fc2", // Microsoft Azure PowerShell
  "04b07795-8ddb-461a-bbee-02f9e1bf7b46", // Microsoft Azure CLI
  "1b730954-1685-4b74-9bfd-dac224a7b894", // Azure AD PowerShell
  "fb78d390-0c51-40cd-8e17-fdbfab77341b"  // Microsoft Exchange REST API Based PowerShell
]);

const METHOD_LABEL = {
  fido2: "FIDO2-Sicherheitsschlüssel", microsoftauthenticator: "Microsoft Authenticator", sms: "SMS", temporaryaccesspass: "Befristeter Zugriffspass",
  softwareoath: "Authenticator-Apps von Drittanbietern (Software-OATH)", hardwareoath: "Hardware-OATH-Token", voice: "Sprachanruf", email: "E-Mail-Einmalkennung",
  x509certificate: "Zertifikatbasierte Anmeldung", verifiablecredentials: "Überprüfbare Anmeldeinformationen", qrcodepin: "QR-Code", passkeyprofile: "Passkey-Profile",
  externalauthenticationmethod: "Externe Authentifizierungsmethode"
};

function isoOrNull(v) { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d.toISOString(); }
function lastOf(...vals) { return vals.filter(Boolean).sort().pop() || null; }

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const k = next++; out[k] = await fn(items[k], k); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ============================================================== Konten, Rollen, Lizenzen
async function collectIdentity(tenant, cert, R, gaps, say) {
  const out = { users: [], skus: [], roles: [], groups: [], signInAvailable: false, mfaAvailable: false };

  say("Organisation lesen");
  try {
    const o = (await graphReq(tenant, cert, "GET", "/organization?$select=id,displayName,verifiedDomains,createdDateTime,countryLetterCode", null, V1)).value[0] || {};
    out.org = {
      id: o.id || tenant.tenantId, displayName: o.displayName || tenant.name, created: o.createdDateTime || null, country: o.countryLetterCode || null,
      domains: (o.verifiedDomains || []).map(d => ({ name: d.name, isDefault: !!d.isDefault, isInitial: !!d.isInitial })).sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name))
    };
  } catch (e) { gaps.push("Organisation nicht lesbar: " + e.message); out.org = { id: tenant.tenantId, displayName: tenant.name, domains: [] }; }

  say("Lizenzen lesen");
  try {
    const skus = await graphAllPages(tenant, cert, "/subscribedSkus", V1);
    out.skus = skus.map(s => ({
      skuId: s.skuId, part: s.skuPartNumber, name: LICENSES.friendlySku(s.skuPartNumber),
      enabled: (s.prepaidUnits || {}).enabled || 0, suspended: (s.prepaidUnits || {}).suspended || 0, warning: (s.prepaidUnits || {}).warning || 0,
      consumed: s.consumedUnits || 0, free: LICENSES.FREE_SKUS.has(s.skuPartNumber) || ((s.prepaidUnits || {}).enabled || 0) >= 10000,
      appliesTo: s.appliesTo || null
    }));
  } catch (e) { gaps.push("Lizenzen nicht lesbar (Organization.Read.All): " + e.message); }
  const skuPart = new Map(out.skus.map(s => [s.skuId, s.part]));

  say("Konten lesen");
  const sel = "id,displayName,userPrincipalName,mail,userType,accountEnabled,createdDateTime,assignedLicenses,externalUserState,externalUserStateChangeDateTime,creationType,onPremisesSyncEnabled";
  let users = [];
  try {
    users = await graphAllPages(tenant, cert, `/users?$select=${sel},signInActivity&$top=500`, V1);
    out.signInAvailable = true;
  } catch (e) {
    gaps.push("Letzte Anmeldung je Konto nicht lesbar (Entra ID P1 und AuditLog.Read.All nötig): " + e.message);
    try { users = await graphAllPages(tenant, cert, `/users?$select=${sel}&$top=500`, V1); }
    catch (e2) { gaps.push("Konten nicht lesbar: " + e2.message); }
  }
  let reg = null;
  try {
    const list = await graphAllPages(tenant, cert, "/reports/authenticationMethods/userRegistrationDetails?$top=999", V1);
    reg = new Map(list.map(r => [r.id, r]));
    out.mfaAvailable = true;
  } catch (e) { gaps.push("MFA-Registrierung je Konto nicht lesbar (Entra ID P1 und AuditLog.Read.All nötig): " + e.message); }
  out.users = users.map(u => {
    const s = u.signInActivity || null;
    const r = reg ? reg.get(u.id) : null;
    return {
      id: u.id, upn: u.userPrincipalName, name: u.displayName, mail: u.mail || null,
      type: u.userType === "Guest" || /#EXT#/i.test(String(u.userPrincipalName || "")) ? "Guest" : "Member",
      enabled: u.accountEnabled !== false, created: u.createdDateTime || null, synced: !!u.onPremisesSyncEnabled,
      externalState: u.externalUserState || null, creationType: u.creationType || null,
      licenses: (u.assignedLicenses || []).map(l => skuPart.get(l.skuId) || l.skuId),
      lastSignIn: s ? lastOf(s.lastSignInDateTime, s.lastNonInteractiveSignInDateTime) : null,
      lastSuccess: s ? (s.lastSuccessfulSignInDateTime || null) : null,
      signInKnown: !!s,
      mfaRegistered: r ? !!r.isMfaRegistered : (reg ? false : null),
      methods: r ? (r.methodsRegistered || []) : [],
      isAdmin: r ? !!r.isAdmin : null
    };
  }).sort((a, b) => String(a.upn).toLowerCase().localeCompare(String(b.upn).toLowerCase()));

  say("Rollen lesen");
  try {
    const defs = await graphAllPages(tenant, cert, "/roleManagement/directory/roleDefinitions?$select=id,displayName,templateId,isBuiltIn", V1);
    const name = new Map();
    for (const d of defs) { name.set(d.id, d); if (d.templateId) name.set(d.templateId, d); }
    const asg = await graphAllPages(tenant, cert, "/roleManagement/directory/roleAssignments?$expand=principal&$top=999", V1);
    const push = (a, how) => {
      const d = name.get(a.roleDefinitionId) || { displayName: a.roleDefinitionId, templateId: a.roleDefinitionId };
      const p = a.principal || {};
      const t = String(p["@odata.type"] || "").toLowerCase();
      out.roles.push({
        role: d.displayName, templateId: d.templateId || a.roleDefinitionId,
        principalId: a.principalId, principalType: t.endsWith("user") ? "user" : t.endsWith("serviceprincipal") ? "sp" : t.endsWith("group") ? "group" : "other",
        principal: p.userPrincipalName || p.displayName || a.principalId, principalName: p.displayName || null, appId: p.appId || null,
        scope: a.directoryScopeId && a.directoryScopeId !== "/" ? a.directoryScopeId : null, how
      });
    };
    for (const a of asg) push(a, "dauerhaft");
    try {
      const el = await graphAllPages(tenant, cert, "/roleManagement/directory/roleEligibilitySchedules?$expand=principal&$top=999", V1);
      for (const a of el) push(a, "berechtigt (PIM)");
    } catch (e) { /* ohne Entra ID P2 gibt es keine berechtigten Zuweisungen */ }
    // Rollen über Gruppen: Mitglieder auflösen, damit "wer ist Globaler Administrator" stimmt.
    for (const r of out.roles.filter(x => x.principalType === "group")) {
      const ex = await R.expand(r.principalId);
      r.members = [...ex.users.values()].map(u => u.upn || u.displayName);
    }
  } catch (e) { gaps.push("Rollen nicht lesbar (RoleManagement.Read.Directory): " + e.message); }

  say("Richtlinien für Anmeldung und Zustimmung lesen");
  try {
    const p = await graphReq(tenant, cert, "GET", "/policies/authorizationPolicy", null, V1);
    const a = Array.isArray(p.value) ? p.value[0] : p;
    const d = a.defaultUserRolePermissions || {};
    out.authz = {
      allowInvitesFrom: a.allowInvitesFrom || null, guestUserRoleId: a.guestUserRoleId || null,
      allowedToSignUpEmailBasedSubscriptions: a.allowedToSignUpEmailBasedSubscriptions, allowEmailVerifiedUsersToJoinOrganization: a.allowEmailVerifiedUsersToJoinOrganization,
      allowedToUseSSPR: a.allowedToUseSSPR, blockMsolPowerShell: a.blockMsolPowerShell,
      allowedToCreateApps: d.allowedToCreateApps, allowedToCreateSecurityGroups: d.allowedToCreateSecurityGroups, allowedToCreateTenants: d.allowedToCreateTenants,
      allowedToReadBitlockerKeysForOwnedDevice: d.allowedToReadBitlockerKeysForOwnedDevice, allowedToReadOtherUsers: d.allowedToReadOtherUsers,
      permissionGrantPoliciesAssigned: d.permissionGrantPoliciesAssigned || []
    };
  } catch (e) { gaps.push("Autorisierungsrichtlinie nicht lesbar (Policy.Read.All): " + e.message); out.authz = null; }
  try {
    const c = await graphReq(tenant, cert, "GET", "/policies/adminConsentRequestPolicy", null, V1);
    out.adminConsent = { enabled: !!c.isEnabled, reviewers: (c.reviewers || []).length, notify: !!c.notifyReviewers, durationDays: c.requestDurationInDays || null };
  } catch (e) { gaps.push("Workflow für Administratorzustimmung nicht lesbar: " + e.message); out.adminConsent = null; }
  try {
    const m = await graphReq(tenant, cert, "GET", "/policies/authenticationMethodsPolicy", null, V1);
    out.authMethods = {
      migrationState: m.policyMigrationState || null,
      methods: (m.authenticationMethodConfigurations || []).map(x => ({ id: x.id, label: METHOD_LABEL[String(x.id).toLowerCase()] || x.id, state: x.state })),
      campaign: m.registrationEnforcement && m.registrationEnforcement.authenticationMethodsRegistrationCampaign
        ? { state: m.registrationEnforcement.authenticationMethodsRegistrationCampaign.state, snooze: m.registrationEnforcement.authenticationMethodsRegistrationCampaign.snoozeDurationInDays } : null
    };
  } catch (e) { gaps.push("Richtlinie für Anmeldemethoden nicht lesbar (Policy.Read.All): " + e.message); out.authMethods = null; }
  try {
    const sd = await graphReq(tenant, cert, "GET", "/policies/identitySecurityDefaultsEnforcementPolicy", null, V1);
    out.securityDefaults = !!sd.isEnabled;
  } catch (e) { gaps.push("Sicherheitsstandards nicht lesbar: " + e.message); out.securityDefaults = null; }
  try {
    const d = await graphReq(tenant, cert, "GET", "/policies/deviceRegistrationPolicy", null, ONE);
    const join = d.azureADJoin || {};
    const allowed = join.allowedToJoin || {};
    const t = String(allowed["@odata.type"] || "");
    out.deviceRegistration = {
      join: /allDeviceRegistrationMembership/i.test(t) ? "alle" : /enumeratedDeviceRegistrationMembership/i.test(t) ? "ausgewählte" : /noDeviceRegistrationMembership/i.test(t) ? "niemand" : null,
      joinEnabled: join.isAdminConfigurable === false ? null : true,
      mfa: d.multiFactorAuthConfiguration || null,
      quota: d.userDeviceQuota || null,
      localAdmins: join.localAdmins ? { registering: join.localAdmins.enableGlobalAdmins !== false, extra: !!(join.localAdmins.registeringUsers && /enumerated/i.test(String(join.localAdmins.registeringUsers["@odata.type"] || ""))) } : null
    };
  } catch (e) {
    out.deviceRegistration = null;
    gaps.push("Geräteregistrierung (Entra ID › Geräteeinstellungen) nicht lesbar" + (e.status === 403 ? " — braucht Policy.Read.DeviceConfiguration (bzw. Policy.ReadWrite.DeviceConfiguration), in der Nur-lesen-App nicht enthalten" : "") + ": " + e.message);
  }

  say("Gruppen lesen");
  try {
    out.groups = (await graphAllPages(tenant, cert, "/groups?$select=id,displayName,groupTypes,membershipRule,securityEnabled,mailEnabled,createdDateTime,visibility,resourceProvisioningOptions&$top=999", V1))
      .map(g => ({ id: g.id, name: g.displayName, dynamic: (g.groupTypes || []).includes("DynamicMembership"), m365: (g.groupTypes || []).includes("Unified"),
        rule: g.membershipRule || null, security: !!g.securityEnabled, created: g.createdDateTime || null, teams: (g.resourceProvisioningOptions || []).includes("Team") }));
  } catch (e) { gaps.push("Gruppen nicht lesbar: " + e.message); }
  return out;
}

// ============================================================== Bedingter Zugriff
async function collectCa(tenant, cert, R, gaps, say) {
  const audit = await ASSIGNAUDIT.auditConditionalAccess(tenant, cert, { signIns: false }, label => say("Bedingter Zugriff: " + label));
  for (const g of audit.gaps || []) gaps.push("Bedingter Zugriff: " + g);
  // Rohbedingungen (Gruppen-Ids) — für "ohne Wirkung, weil …" und die Gruppenliste.
  let raw = [];
  try { raw = await graphAllPages(tenant, cert, "/identity/conditionalAccess/policies", V1); } catch (e) { /* steht schon als Lücke drin */ }
  const rawById = new Map(raw.map(p => [p.id, p]));
  const groupIds = new Set();
  const policies = audit.policies.map(p => {
    const r = rawById.get(p.id) || {};
    const u = (r.conditions && r.conditions.users) || {};
    const a = (r.conditions && r.conditions.applications) || {};
    (u.includeGroups || []).forEach(g => groupIds.add(g));
    (u.excludeGroups || []).forEach(g => groupIds.add(g));
    return {
      ...p,
      raw: {
        includeUsers: u.includeUsers || [], excludeUsers: u.excludeUsers || [], includeGroups: u.includeGroups || [], excludeGroups: u.excludeGroups || [],
        includeRoles: u.includeRoles || [], excludeRoles: u.excludeRoles || [], includeGuests: !!u.includeGuestsOrExternalUsers, excludeGuests: !!u.excludeGuestsOrExternalUsers,
        includeApplications: a.includeApplications || [], includeUserActions: a.includeUserActions || [], includeAuthContext: a.includeAuthenticationContextClassReferences || [],
        grant: (r.grantControls && r.grantControls.builtInControls) || [], authStrength: !!(r.grantControls && r.grantControls.authenticationStrength)
      }
    };
  });
  say("Bedingter Zugriff: Geltungs- und Ausnahmegruppen");
  const groups = [];
  for (const gid of groupIds) {
    const g = await R.group(gid);
    const cls = await R.classify(gid);
    const ex = cls.kind === "missing" ? { users: new Map(), devices: new Map(), groups: [] } : await R.expand(gid);
    groups.push({
      id: gid, name: g ? g.displayName : gid, kind: cls.kind, kindLabel: cls.label, missing: !!(g && g.missing), dynamic: !!(g && g.dynamic), rule: g ? g.rule : "",
      users: [...ex.users.values()].map(x => x.upn || x.displayName).sort((a, b) => String(a).localeCompare(String(b))).slice(0, 200),
      userCount: ex.users.size, deviceCount: ex.devices.size, nested: ex.groups.map(x => x.displayName),
      includedBy: policies.filter(p => p.raw.includeGroups.includes(gid)).length, excludedBy: policies.filter(p => p.raw.excludeGroups.includes(gid)).length
    });
  }
  groups.sort((a, b) => b.includedBy - a.includedBy || a.name.localeCompare(b.name));
  return { policies, groups, summary: audit.summary, withoutMfa: audit.withoutMfa, namedLocations: audit.namedLocations, securityDefaults: audit.summary.securityDefaults };
}

// ============================================================== Geräte und Intune
async function collectDevices(tenant, cert, R, gaps, say) {
  const out = { intune: [], autopilot: [], entra: null, profiles: [], groups: [] };
  say("Intune-Geräte lesen");
  const sel = "id,deviceName,operatingSystem,osVersion,model,manufacturer,serialNumber,userPrincipalName,joinType,deviceEnrollmentType,enrolledDateTime,lastSyncDateTime,complianceState,isEncrypted,autopilotEnrolled,azureADDeviceId,managedDeviceOwnerType";
  try {
    let list;
    try { list = await graphAllPages(tenant, cert, `/deviceManagement/managedDevices?$select=${sel}&$top=500`, BETA); }
    catch (e) { list = await graphAllPages(tenant, cert, "/deviceManagement/managedDevices?$select=id,deviceName,operatingSystem,osVersion,model,manufacturer,serialNumber,userPrincipalName,enrolledDateTime,lastSyncDateTime,complianceState,isEncrypted,azureADDeviceId,managedDeviceOwnerType&$top=500", V1); }
    out.intune = list.map(d => ({
      id: d.id, name: d.deviceName, os: d.operatingSystem, osVersion: d.osVersion, model: d.model, manufacturer: d.manufacturer, serial: d.serialNumber,
      user: d.userPrincipalName || null, joinType: d.joinType || null, enrollmentType: d.deviceEnrollmentType || null, enrolled: d.enrolledDateTime || null,
      lastSync: d.lastSyncDateTime || null, compliance: d.complianceState || null, encrypted: d.isEncrypted === true ? true : d.isEncrypted === false ? false : null,
      autopilot: d.autopilotEnrolled === true ? true : d.autopilotEnrolled === false ? false : null, entraId: d.azureADDeviceId || null, owner: d.managedDeviceOwnerType || null
    })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  } catch (e) { gaps.push("Intune-Geräte nicht lesbar (DeviceManagementManagedDevices.Read.All): " + e.message); }

  say("Autopilot lesen");
  try {
    out.autopilot = (await graphAllPages(tenant, cert, "/deviceManagement/windowsAutopilotDeviceIdentities?$top=500", V1))
      .map(a => ({ serial: a.serialNumber, groupTag: a.groupTag || null, model: a.model || null, manufacturer: a.manufacturer || null, lastContact: a.lastContactedDateTime || null, enrollmentState: a.enrollmentState || null, entraDeviceId: a.azureActiveDirectoryDeviceId || null }));
  } catch (e) { gaps.push("Autopilot-Geräte nicht lesbar: " + e.message); }
  try {
    const prof = await graphAllPages(tenant, cert, "/deviceManagement/windowsAutopilotDeploymentProfiles?$expand=assignments", BETA);
    for (const p of prof) {
      const t = [];
      for (const a of p.assignments || []) {
        const gid = a.target && a.target.groupId;
        if (gid) { const g = await R.group(gid); t.push({ name: g ? g.displayName : gid, exclude: /exclusion/i.test(String(a.target["@odata.type"] || "")) }); }
        else if (/allDevices/i.test(String((a.target || {})["@odata.type"] || ""))) t.push({ name: "Alle Geräte", exclude: false });
      }
      const oobe = p.outOfBoxExperienceSettings || p.outOfBoxExperienceSetting || {};
      out.profiles.push({
        name: p.displayName, join: /activeDirectory/i.test(String(p["@odata.type"] || "")) ? "Hybrid-Join" : "Entra-Join",
        userType: oobe.userType || null, deviceNameTemplate: p.deviceNameTemplate || null, language: p.language || null, targets: t,
        preprovision: p.enableWhiteGlove === true || p.preprovisioningAllowed === true
      });
    }
  } catch (e) { gaps.push("Autopilot-Profile nicht lesbar: " + e.message); }

  say("Geräte in Entra ID lesen");
  try {
    out.entra = (await graphAllPages(tenant, cert, "/devices?$select=id,deviceId,displayName,operatingSystem,operatingSystemVersion,trustType,approximateLastSignInDateTime,registrationDateTime,isManaged,accountEnabled&$top=999", V1))
      .map(d => ({ id: d.id, deviceId: d.deviceId, name: d.displayName, os: d.operatingSystem, trust: d.trustType || null, lastSignIn: d.approximateLastSignInDateTime || null, registered: d.registrationDateTime || null, managed: d.isManaged === true, enabled: d.accountEnabled !== false }));
  } catch (e) { gaps.push("Geräte in Entra ID nicht lesbar (Device.Read.All bzw. Directory.Read.All): " + e.message); }
  return out;
}

async function collectIntune(tenant, cert, R, groups, gaps, say) {
  const out = { policies: [], apps: [], sourceErrors: [] };
  try {
    const pol = await ASSIGNAUDIT.auditPolicies(tenant, cert, { scope: "all", settings: false }, label => say("Intune: " + label));
    out.sourceErrors = pol.sourceErrors || [];
    for (const s of out.sourceErrors) gaps.push(`Intune ${s.source}: ${s.error}`);
    for (const g of pol.gaps || []) gaps.push("Intune: " + g);
    out.policies = pol.policies.map(p => ({
      id: p.id, name: p.name, source: p.source, type: p.type, odataType: p.odataType || null, templateFamily: p.templateFamily || null, platform: p.platform,
      created: p.createdDateTime || null, modified: p.lastModifiedDateTime || null, description: p.description || "",
      assignments: p.assignments.map(a => ({ kind: a.targetKind, exclude: a.exclude, filter: a.filter || null, group: a.group ? { id: a.group.id, name: a.group.displayName, kind: a.group.kind, kindLabel: a.group.kindLabel } : null, devices: a.deviceCount, users: a.userCount }))
    }));
    out.groupInventory = pol.groups || [];
  } catch (e) { gaps.push("Intune-Richtlinien nicht lesbar: " + e.message); }

  say("Intune: Apps lesen");
  try {
    const all = await graphAllPages(tenant, cert, "/deviceAppManagement/mobileApps?$expand=assignments&$top=100", { beta: true, retryTransient: 8 });
    const gname = new Map(groups.map(g => [g.id, g.name]));
    for (const a of all) {
      if (!(a.assignments || []).length) continue;
      if (/microsoftStoreForBusiness/i.test(String(a["@odata.type"] || ""))) continue;
      const type = ASSIGNAUDIT.appTypeOf(a);
      const targets = [];
      for (const x of a.assignments) {
        const t = x.target || {};
        const tt = String(t["@odata.type"] || "");
        let name;
        if (t.groupId) {
          name = gname.get(t.groupId);
          if (!name) { const g = await R.group(t.groupId); name = g ? g.displayName : t.groupId; }
        } else name = /allDevices/i.test(tt) ? "Alle Geräte" : /allLicensedUsers/i.test(tt) ? "Alle Benutzer" : tt.replace("#microsoft.graph.", "");
        targets.push({ intent: x.intent, target: name, exclude: /exclusion/i.test(tt) });
      }
      out.apps.push({ id: a.id, name: a.displayName, publisher: a.publisher || "", type: type.label, platform: type.platform, targets });
    }
    out.apps.sort((a, b) => String(a.name).toLowerCase().localeCompare(String(b.name).toLowerCase()));
  } catch (e) { gaps.push("Intune-Apps nicht lesbar: " + e.message); }
  return out;
}

// ============================================================== E-Mail
// Liest alles, was Kapitel 6 braucht, in EINER Exchange-Verbindung. Jede Abfrage
// einzeln abgesichert: fehlt ein Cmdlet (Lizenz, Rolle), bleibt nur dieser Teil leer
// und landet als Fehlertext in errors.
const EXO_BODY = [
  "$o = [ordered]@{ ok = $true; errors = @{} }",
  "function Q($name, [scriptblock]$sb) { try { $script:o[$name] = @(& $sb) } catch { $script:o.errors[$name] = $_.Exception.Message } }",
  "function S($v) { if ($null -eq $v) { $null } else { \"$v\" } }",
  "function A($v) { @($v | Where-Object { $_ } | ForEach-Object { \"$_\" }) }",
  // Gleicher Filter wie Audit/DKIM (deploy.js), hier auf DomainName statt auf die Zeichenkette angewandt.
  "Q 'domains' { Get-AcceptedDomain | " + NON_MAIL_DOMAIN_PS_FILTER.replace("$_ -notmatch", "\"$($_.DomainName)\" -notmatch") + " | ForEach-Object { @{ name = S $_.DomainName; default = [bool]$_.Default; type = S $_.DomainType } } }",
  "Q 'allDomains' { Get-AcceptedDomain | ForEach-Object { S $_.DomainName } }",
  "Q 'dkim' { Get-DkimSigningConfig | ForEach-Object { @{ Domain = S $_.Domain; Enabled = [bool]$_.Enabled; Status = S $_.Status; KeySize = $_.KeySize; Selector1CNAME = S $_.Selector1CNAME; Selector2CNAME = S $_.Selector2CNAME } } }",
  "Q 'spamPolicies' { Get-HostedContentFilterPolicy | ForEach-Object { @{ name = S $_.Name; isDefault = [bool]$_.IsDefault; recommended = S $_.RecommendedPolicyType; spam = S $_.SpamAction; hcSpam = S $_.HighConfidenceSpamAction; phish = S $_.PhishSpamAction; hcPhish = S $_.HighConfidencePhishAction; bulk = S $_.BulkSpamAction; bcl = $_.BulkThreshold; spamTag = S $_.SpamQuarantineTag; hcSpamTag = S $_.HighConfidenceSpamQuarantineTag; phishTag = S $_.PhishQuarantineTag; hcPhishTag = S $_.HighConfidencePhishQuarantineTag; bulkTag = S $_.BulkQuarantineTag; retention = $_.QuarantineRetentionPeriod; zapSpam = [bool]$_.SpamZapEnabled; zapPhish = [bool]$_.PhishZapEnabled; allowedSenders = @(A $_.AllowedSenders).Count; allowedDomains = @(A $_.AllowedSenderDomains).Count; blockedSenders = @(A $_.BlockedSenders).Count; blockedDomains = @(A $_.BlockedSenderDomains).Count } } }",
  "Q 'spamRules' { Get-HostedContentFilterRule | ForEach-Object { @{ name = S $_.Name; policy = S $_.HostedContentFilterPolicy; state = S $_.State; priority = $_.Priority; domains = (A $_.RecipientDomainIs); users = (A $_.SentTo); groups = (A $_.SentToMemberOf); exceptDomains = (A $_.ExceptIfRecipientDomainIs); exceptUsers = (A $_.ExceptIfSentTo); exceptGroups = (A $_.ExceptIfSentToMemberOf) } } }",
  "Q 'malwarePolicies' { Get-MalwareFilterPolicy | ForEach-Object { @{ name = S $_.Name; isDefault = [bool]$_.IsDefault; recommended = S $_.RecommendedPolicyType; fileFilter = [bool]$_.EnableFileFilter; fileTypes = @(A $_.FileTypes).Count; zap = [bool]$_.ZapEnabled; tag = S $_.QuarantineTag; internal = [bool]$_.EnableInternalSenderAdminNotifications; internalTo = S $_.InternalSenderAdminAddress; external = [bool]$_.EnableExternalSenderAdminNotifications; externalTo = S $_.ExternalSenderAdminAddress } } }",
  "Q 'malwareRules' { Get-MalwareFilterRule | ForEach-Object { @{ name = S $_.Name; policy = S $_.MalwareFilterPolicy; state = S $_.State; priority = $_.Priority; domains = (A $_.RecipientDomainIs); users = (A $_.SentTo); groups = (A $_.SentToMemberOf) } } }",
  "Q 'phishPolicies' { Get-AntiPhishPolicy | ForEach-Object { @{ name = S $_.Name; isDefault = [bool]$_.IsDefault; recommended = S $_.RecommendedPolicyType; enabled = [bool]$_.Enabled; spoof = [bool]$_.EnableSpoofIntelligence; firstContact = [bool]$_.EnableFirstContactSafetyTips; unauth = [bool]$_.EnableUnauthenticatedSender; dmarc = [bool]$_.HonorDmarcPolicy; impersonationUsers = [bool]$_.EnableTargetedUserProtection; impersonationDomains = [bool]$_.EnableOrganizationDomainsProtection; mailboxIntel = [bool]$_.EnableMailboxIntelligence; threshold = $_.PhishThresholdLevel; spoofTag = S $_.SpoofQuarantineTag; authFail = S $_.AuthenticationFailAction } } }",
  "Q 'phishRules' { Get-AntiPhishRule | ForEach-Object { @{ name = S $_.Name; policy = S $_.AntiPhishPolicy; state = S $_.State; priority = $_.Priority; domains = (A $_.RecipientDomainIs); users = (A $_.SentTo); groups = (A $_.SentToMemberOf) } } }",
  "Q 'eopPreset' { Get-EOPProtectionPolicyRule | ForEach-Object { @{ name = S $_.Name; identity = S $_.Identity; state = S $_.State; priority = $_.Priority; spamPolicy = S $_.HostedContentFilterPolicy; phishPolicy = S $_.AntiPhishPolicy; malwarePolicy = S $_.MalwareFilterPolicy; domains = (A $_.RecipientDomainIs); users = (A $_.SentTo); groups = (A $_.SentToMemberOf); exceptDomains = (A $_.ExceptIfRecipientDomainIs); exceptUsers = (A $_.ExceptIfSentTo); exceptGroups = (A $_.ExceptIfSentToMemberOf) } } }",
  "Q 'atpPreset' { Get-ATPProtectionPolicyRule | ForEach-Object { @{ name = S $_.Name; identity = S $_.Identity; state = S $_.State; priority = $_.Priority; safeLinksPolicy = S $_.SafeLinksPolicy; safeAttachmentPolicy = S $_.SafeAttachmentPolicy; domains = (A $_.RecipientDomainIs); users = (A $_.SentTo); groups = (A $_.SentToMemberOf) } } }",
  "Q 'builtIn' { Get-ATPBuiltInProtectionRule | ForEach-Object { @{ name = S $_.Name; state = S $_.State; exceptDomains = (A $_.ExceptIfRecipientDomainIs); exceptUsers = (A $_.ExceptIfSentTo); exceptGroups = (A $_.ExceptIfSentToMemberOf) } } }",
  "Q 'safeLinks' { Get-SafeLinksPolicy | ForEach-Object { @{ name = S $_.Name; recommended = S $_.RecommendedPolicyType; email = [bool]$_.EnableSafeLinksForEmail; teams = [bool]$_.EnableSafeLinksForTeams; office = [bool]$_.EnableSafeLinksForOffice; track = [bool]$_.TrackClicks; clickThrough = [bool]$_.AllowClickThrough; rewrite = -not [bool]$_.DisableUrlRewrite; internal = [bool]$_.EnableForInternalSenders; waitScan = [bool]$_.DeliverMessageAfterScan } } }",
  "Q 'safeLinksRules' { Get-SafeLinksRule | ForEach-Object { @{ name = S $_.Name; policy = S $_.SafeLinksPolicy; state = S $_.State; priority = $_.Priority; domains = (A $_.RecipientDomainIs); users = (A $_.SentTo); groups = (A $_.SentToMemberOf) } } }",
  "Q 'safeAttach' { Get-SafeAttachmentPolicy | ForEach-Object { @{ name = S $_.Name; recommended = S $_.RecommendedPolicyType; enabled = [bool]$_.Enable; action = S $_.Action; tag = S $_.QuarantineTag; redirect = [bool]$_.Redirect } } }",
  "Q 'safeAttachRules' { Get-SafeAttachmentRule | ForEach-Object { @{ name = S $_.Name; policy = S $_.SafeAttachmentPolicy; state = S $_.State; priority = $_.Priority; domains = (A $_.RecipientDomainIs); users = (A $_.SentTo); groups = (A $_.SentToMemberOf) } } }",
  "Q 'atpO365' { Get-AtpPolicyForO365 | Select-Object -First 1 | ForEach-Object { @{ spoTeamsOdb = [bool]$_.EnableATPForSPOTeamsODB; safeDocs = [bool]$_.EnableSafeDocs; safeDocsOpen = [bool]$_.AllowSafeDocsOpen } } }",
  "Q 'outbound' { Get-HostedOutboundSpamFilterPolicy | ForEach-Object { @{ name = S $_.Name; isDefault = [bool]$_.IsDefault; extHour = $_.RecipientLimitExternalPerHour; intHour = $_.RecipientLimitInternalPerHour; day = $_.RecipientLimitPerDay; action = S $_.ActionWhenThresholdReached; autoForward = S $_.AutoForwardingMode; notify = [bool]$_.NotifyOutboundSpam; notifyTo = (A $_.NotifyOutboundSpamRecipients); bcc = [bool]$_.BccSuspiciousOutboundMail; bccTo = (A $_.BccSuspiciousOutboundAdditionalRecipients) } } }",
  "Q 'outboundRules' { Get-HostedOutboundSpamFilterRule | ForEach-Object { @{ name = S $_.Name; policy = S $_.HostedOutboundSpamFilterPolicy; state = S $_.State; priority = $_.Priority; senders = (A $_.From); senderGroups = (A $_.FromMemberOf); senderDomains = (A $_.SenderDomainIs) } } }",
  "Q 'quarantine' { Get-QuarantinePolicy | Where-Object { $_.QuarantinePolicyType -ne 'GlobalQuarantinePolicy' } | ForEach-Object { @{ name = S $_.Name; esn = [bool]$_.ESNEnabled; perms = S $_.EndUserQuarantinePermissions; permsValue = $_.EndUserQuarantinePermissionsValue } } }",
  "Q 'quarantineGlobal' { Get-QuarantinePolicy -QuarantinePolicyType GlobalQuarantinePolicy | ForEach-Object { @{ frequency = S $_.EndUserSpamNotificationFrequency; frequencyDays = $_.EndUserSpamNotificationFrequencyInDays } } }",
  "Q 'transportRules' { Get-TransportRule | ForEach-Object { @{ name = S $_.Name; state = S $_.State; mode = S $_.Mode; priority = $_.Priority; description = S $_.Description } } }",
  "Q 'transportConfig' { Get-TransportConfig | ForEach-Object { @{ smtpAuthDisabled = [bool]$_.SmtpClientAuthenticationDisabled } } }",
  "Q 'orgConfig' { Get-OrganizationConfig | ForEach-Object { @{ auditDisabled = [bool]$_.AuditDisabled; rejectDirectSend = [bool]$_.RejectDirectSend; oauth = [bool]$_.OAuth2ClientProfileEnabled; name = S $_.Name } } }",
  "Q 'adminAudit' { Get-AdminAuditLogConfig | ForEach-Object { @{ unified = [bool]$_.UnifiedAuditLogIngestionEnabled; admin = [bool]$_.AdminAuditLogEnabled } } }",
  "Q 'externalTag' { Get-ExternalInOutlook | Select-Object -First 1 | ForEach-Object { @{ enabled = [bool]$_.Enabled; allow = @(A $_.AllowList).Count } } }",
  "Q 'submission' { Get-ReportSubmissionPolicy | ForEach-Object { @{ toMicrosoft = [bool]$_.EnableReportToMicrosoft; junkTo = (A $_.ReportJunkAddresses); phishTo = (A $_.ReportPhishAddresses); custom = [bool]($_.ReportJunkToCustomizedAddress -or $_.ReportPhishToCustomizedAddress); userButton = [bool]$_.EnableUserEmailNotification } } }",
  "Q 'remoteDomains' { Get-RemoteDomain | ForEach-Object { @{ name = S $_.Name; domain = S $_.DomainName; autoForward = [bool]$_.AutoForwardEnabled } } }",
  "Q 'inbound' { Get-InboundConnector | ForEach-Object { @{ name = S $_.Name; enabled = [bool]$_.Enabled; type = S $_.ConnectorType; senders = (A $_.SenderDomains) } } }",
  "Q 'outboundConnectors' { Get-OutboundConnector | ForEach-Object { @{ name = S $_.Name; enabled = [bool]$_.Enabled; type = S $_.ConnectorType; domains = (A $_.RecipientDomains); smarthosts = (A $_.SmartHosts) } } }",
  "Q 'mailboxes' { Get-EXOMailbox -ResultSize Unlimited -Properties ForwardingSmtpAddress,ForwardingAddress,DeliverToMailboxAndForward,AuditEnabled | ForEach-Object { @{ upn = S $_.UserPrincipalName; smtp = S $_.PrimarySmtpAddress; name = S $_.DisplayName; type = S $_.RecipientTypeDetails; fwdSmtp = S $_.ForwardingSmtpAddress; fwd = S $_.ForwardingAddress; keep = [bool]$_.DeliverToMailboxAndForward; audit = [bool]$_.AuditEnabled } } }",
  "Q 'cas' { Get-CASMailbox -ResultSize Unlimited | ForEach-Object { @{ smtp = S $_.PrimarySmtpAddress; smtpAuth = $_.SmtpClientAuthenticationDisabled; pop = [bool]$_.PopEnabled; imap = [bool]$_.ImapEnabled; eas = [bool]$_.ActiveSyncEnabled; owa = [bool]$_.OWAEnabled } } }",
  "Write-Output ('BEGINJSON' + ($o | ConvertTo-Json -Compress -Depth 8) + 'ENDJSON')"
].join("\r\n");

async function collectMail(tenant, cert, gaps, say) {
  const out = { exo: null, alerts: null, dlp: null, dns: [], domains: [] };
  say("Exchange Online lesen");
  const auth = { appId: tenant.clientId, organization: tenant.organization, certPemPath: cert };
  const r = await EXO.runExo(auth, EXO_BODY, 300000);
  if (!r.ok || !r.data || r.data.ok === false) {
    gaps.push("Exchange Online nicht abrufbar — Kapitel E-Mail ohne Schutzrichtlinien: " + ((r.data && r.data.error) || r.error || "unbekannt"));
  } else {
    const d = r.data;
    const arr = v => (Array.isArray(v) ? v : (v ? [v] : []));
    out.exo = {};
    for (const k of Object.keys(d)) if (k !== "ok" && k !== "errors") out.exo[k] = arr(d[k]);
    out.exo.errors = d.errors || {};
    for (const [k, v] of Object.entries(out.exo.errors)) {
      // Fehlende Defender-Lizenz: Safe Links/Attachments/ATP-Regeln fehlen — das ist ein Zustand, keine Lücke.
      if (/safeLinks|safeAttach|atpPreset|builtIn|atpO365/.test(k) && /not recognized|nicht erkannt|is not recognized as|CommandNotFound/i.test(String(v))) continue;
      gaps.push(`Exchange (${k}): ${v}`);
    }
    out.domains = out.exo.domains.map(x => x.name).filter(Boolean);
  }

  say("DNS prüfen (SPF, DKIM, DMARC, MX)");
  const dkim = out.exo ? out.exo.dkim : [];
  const domains = out.domains.length ? out.domains : [];
  if (domains.length) {
    try {
      const res = await DOMAINAUTH.checkDomains(domains, dkim);
      for (const x of res) {
        let mx = [];
        try { mx = (await dns.resolveMx(x.domain)).sort((a, b) => a.priority - b.priority).map(m => m.exchange); } catch (e) { /* keine MX */ }
        out.dns.push({ ...x, mx });
      }
    } catch (e) { gaps.push("DNS-Prüfung fehlgeschlagen: " + e.message); }
  }

  say("Security & Compliance lesen (Warnungsrichtlinien)");
  const sc = await EXO.runPwsh(RECIPIENTS.ippsScript(tenant, cert), 150000);
  if (!sc.ok || !sc.data || sc.data.ok === false) {
    gaps.push("Security & Compliance nicht abrufbar (Warnungsrichtlinien): " + ((sc.data && sc.data.error) || sc.error || "unbekannt"));
  } else {
    out.alerts = (sc.data.alerts || []).map(a => ({ name: a.name, category: a.category, severity: a.severity, disabled: !!a.disabled, system: !!a.system, notify: a.notifyEnabled !== false, notifyTo: a.notifyTo || [] }));
    out.dlp = (sc.data.dlp || []).map(x => ({ name: x.name, policy: x.policy, disabled: !!x.disabled }));
    if (sc.data.alertsError) gaps.push("Warnungsrichtlinien: " + sc.data.alertsError);
  }
  return out;
}

// ============================================================== Anwendungen und Freigaben
async function collectApps(tenant, cert, gaps, say) {
  const out = { grants: [], appPermissions: [], registrations: [], thirdParty: [] };
  say("Anwendungen lesen");
  let sps = [];
  try {
    sps = await graphAllPages(tenant, cert, "/servicePrincipals?$select=id,appId,displayName,publisherName,appOwnerOrganizationId,verifiedPublisher,createdDateTime,accountEnabled,servicePrincipalType,appRoles&$top=999", V1);
  } catch (e) { gaps.push("Unternehmensanwendungen nicht lesbar (Application.Read.All): " + e.message); }
  const spById = new Map(sps.map(s => [s.id, s]));
  const isMs = s => !s || MS_OWNERS.has(s.appOwnerOrganizationId) || !s.appOwnerOrganizationId;
  out.thirdParty = sps.filter(s => s.servicePrincipalType === "Application" && !isMs(s))
    .map(s => ({ id: s.id, appId: s.appId, name: s.displayName, created: s.createdDateTime || null, enabled: s.accountEnabled !== false, publisher: s.publisherName || "",
      verified: s.verifiedPublisher && s.verifiedPublisher.displayName ? s.verifiedPublisher.displayName : null, own: s.appOwnerOrganizationId === tenant.tenantId }))
    .sort((a, b) => String(a.created || "").localeCompare(String(b.created || "")));

  say("Delegierte Freigaben lesen");
  let userById = null;
  try {
    const grants = await graphAllPages(tenant, cert, "/oauth2PermissionGrants?$top=999", V1);
    const needUsers = grants.some(g => g.principalId);
    if (needUsers) {
      userById = new Map();
      for (const g of grants.filter(x => x.principalId)) {
        if (userById.has(g.principalId)) continue;
        try { const u = await graphReq(tenant, cert, "GET", `/users/${g.principalId}?$select=id,userPrincipalName`, null, ONE); userById.set(u.id, u.userPrincipalName); }
        catch (e) { userById.set(g.principalId, g.principalId); }
      }
    }
    out.grants = grants.map(g => {
      const c = spById.get(g.clientId), res = spById.get(g.resourceId);
      return {
        client: c ? c.displayName : g.clientId, clientAppId: c ? c.appId : null, clientSpId: g.clientId,
        microsoft: isMs(c) && !(c && MS_ADMIN_TOOLS.has(c.appId)), adminTool: !!(c && MS_ADMIN_TOOLS.has(c.appId)),
        resource: res ? res.displayName : g.resourceId, consentType: g.consentType,
        principal: g.principalId ? (userById && userById.get(g.principalId)) || g.principalId : null,
        scopes: String(g.scope || "").split(/\s+/).filter(Boolean)
      };
    });
  } catch (e) { gaps.push("Delegierte Freigaben nicht lesbar (Directory.Read.All): " + e.message); }

  say("Anwendungsberechtigungen von Drittanbieter-Apps lesen");
  const roleName = new Map();
  for (const s of sps) for (const r of s.appRoles || []) roleName.set(s.id + "|" + r.id, r.value || r.displayName);
  const third = out.thirdParty.slice(0, 150);
  let appPermErrors = 0;
  await mapLimit(third, 5, async a => {
    try {
      const asg = await graphAllPages(tenant, cert, `/servicePrincipals/${a.id}/appRoleAssignments?$top=999`, V1);
      for (const x of asg) out.appPermissions.push({ client: a.name, clientSpId: a.id, resource: x.resourceDisplayName, permission: roleName.get(x.resourceId + "|" + x.appRoleId) || x.appRoleId, created: x.createdDateTime || null });
    } catch (e) { appPermErrors++; }
  });
  if (appPermErrors) gaps.push(`${appPermErrors} Anwendung(en): Anwendungsberechtigungen nicht lesbar.`);

  say("App-Registrierungen lesen");
  try {
    const apps = await graphAllPages(tenant, cert, "/applications?$select=id,appId,displayName,createdDateTime,passwordCredentials,keyCredentials,signInAudience&$top=999", V1);
    out.registrations = apps.map(a => ({
      id: a.id, appId: a.appId, name: a.displayName, created: a.createdDateTime || null, audience: a.signInAudience || null,
      secrets: (a.passwordCredentials || []).map(c => ({ end: c.endDateTime || null, name: c.displayName || null })),
      certs: (a.keyCredentials || []).map(c => ({ end: c.endDateTime || null, name: c.displayName || null }))
    })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  } catch (e) { gaps.push("App-Registrierungen nicht lesbar (Application.Read.All): " + e.message); }
  return out;
}

// ============================================================== Gesamtlauf
/**
 * opts: { changes: { from, to } | null, spPeriod: 'D30' }
 * say(label): Fortschritt für den Job.
 */
async function collect(tenant, cert, opts, say) {
  say = typeof say === "function" ? say : () => {};
  opts = opts || {};
  const started = Date.now();
  const gaps = [];
  const R = ASSIGNAUDIT.createResolver(tenant, cert);
  const sections = {};
  const timings = {};
  const step = async (key, fn) => {
    const t0 = Date.now();
    try { sections[key] = await fn(); }
    catch (e) { gaps.push(`${key}: nicht erhoben — ${e.message}`); sections[key] = null; }
    timings[key] = Math.round((Date.now() - t0) / 1000);
  };

  await step("identity", () => collectIdentity(tenant, cert, R, gaps, say));
  await step("ca", () => collectCa(tenant, cert, R, gaps, say));
  await step("devices", () => collectDevices(tenant, cert, R, gaps, say));
  await step("intune", () => collectIntune(tenant, cert, R, (sections.identity && sections.identity.groups) || [], gaps, say));
  // Gerätegruppen (5.2): die Gruppen, an denen Intune hängt, plus dynamische Gerätegruppen.
  if (sections.devices) {
    try {
      const ids = new Set();
      for (const p of (sections.intune && sections.intune.policies) || []) for (const a of p.assignments) if (a.group && a.group.id) ids.add(a.group.id);
      for (const g of (sections.identity && sections.identity.groups) || []) if (g.dynamic && /\bdevice\./i.test(g.rule || "")) ids.add(g.id);
      const out = [];
      for (const id of ids) {
        const g = await R.group(id);
        if (!g || g.missing) continue;
        const cls = await R.classify(id);
        if (!/deviceGroup|mixed|container/.test(cls.kind)) continue;
        const ex = await R.expand(id);
        out.push({ id, name: g.displayName, kindLabel: cls.label, dynamic: g.dynamic, rule: g.rule || null, tags: g.tags || [], devices: ex.devices.size, users: ex.users.size, nested: ex.groups.map(x => x.displayName) });
      }
      sections.devices.groups = out.sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) { gaps.push("Gerätegruppen nicht auflösbar: " + e.message); }
  }
  await step("mail", () => collectMail(tenant, cert, gaps, say));
  await step("apps", () => collectApps(tenant, cert, gaps, say));
  await step("sharepoint", async () => {
    const sp = await SPINV.collectInventory(tenant, cert, { period: SPINV.PERIODS.includes(opts.spPeriod) ? opts.spPeriod : "D30" }, label => say("SharePoint: " + label));
    for (const g of sp.gaps || []) gaps.push("SharePoint: " + g);
    return sp;
  });
  if (opts.changes && opts.changes.from) {
    await step("changes", async () => {
      const c = await EVIDENCE.changeLog(tenant, cert, { from: opts.changes.from, to: opts.changes.to || opts.changes.from, sources: ["intune", "entra"], valueCap: 12000, cap: 20000 }, label => say("Änderungen: " + label));
      for (const g of c.gaps || []) gaps.push("Änderungsprotokoll: " + g);
      return { from: c.from, to: c.to, days: { from: opts.changes.from, to: opts.changes.to || opts.changes.from }, events: c.events, capped: c.capped, retention: c.retention };
    });
  }
  for (const g of R.gaps) gaps.push("Gruppen: " + g);

  return {
    version: 1,
    generatedAt: new Date(started).toISOString(),
    finishedAt: new Date().toISOString(),
    durationSec: Math.round((Date.now() - started) / 1000),
    timings,
    tenant: { name: tenant.name, organization: tenant.organization, tenantId: tenant.tenantId, readOnly: !!tenant.readOnly },
    params: { changes: opts.changes && opts.changes.from ? { from: opts.changes.from, to: opts.changes.to || opts.changes.from } : null, spPeriod: opts.spPeriod || "D30" },
    gaps: [...new Set(gaps)],
    sections
  };
}

module.exports = { collect, METHOD_LABEL, MS_OWNERS, MS_ADMIN_TOOLS, EXO_BODY };
