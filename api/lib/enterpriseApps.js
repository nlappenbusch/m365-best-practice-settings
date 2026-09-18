"use strict";
/**
 * Enterprise-Apps-Nachweis — gebaut für KI-Connectoren (Claude, ChatGPT, Copilot
 * Studio …), passt aber für jede Drittanbieter-App im Tenant.
 *
 * Die Fragen einer Prüfung: Welche Rechte hat die App im Tenant (delegiert und
 * als Anwendung)? Wer hat zugestimmt — für alle oder einzelne Benutzer? Wer ist
 * zugewiesen, wer benutzt sie? Und was hat sie getan? Das Letzte beantwortet das
 * Unified Audit Log (evidence.js, Suche nach der App-Id) — dort steht auch, ob
 * die App je etwas gelöscht, verschoben oder gesendet hat.
 *
 * Was sich NICHT aus dem Tenant lesen lässt: Einstellungen, die der Anbieter auf
 * SEINER Seite hält (bei Claude etwa die Werkzeugsperren je Connector in den
 * Organisationseinstellungen). Die gehören als Handnachweis in die Doku.
 *
 * Ausschliesslich lesend.
 */
const { graphReq, graphAllPages } = require("./graph");

const V1 = { retryTransient: 4 };
const BETA = { beta: true, retryTransient: 4 };

// Microsoft-eigene Anwendungen (Besitzer-Tenants) — die interessieren hier nicht.
const MS_OWNERS = new Set(["f8cdef31-a31e-4b4a-93e4-5f571e91255a", "72f988bf-86f1-41af-91ab-2d7cd011db47", "cdc5aeea-15c5-4db6-b079-fcadd2505dc2"]);
const AI_RE = /claude|anthropic|openai|chatgpt|\bgpt\b|copilot studio|gemini|perplexity|mistral|cursor|notion|otter|fireflies|jasper|grammarly|deepl|poe\b|character\.ai|llama/i;

// Rechte, die schreiben, senden oder breit lesen — im Nachweis hervorgehoben.
const RISKY = /^(Mail\.(Send|ReadWrite)|Mail\.Read$|MailboxSettings\.ReadWrite|Calendars\.ReadWrite|Contacts\.ReadWrite|Files\.(ReadWrite|Read)\.All|Sites\.(ReadWrite|FullControl|Manage)\.All|Directory\.ReadWrite\.All|User\.ReadWrite\.All|Group\.ReadWrite\.All|Chat\.ReadWrite|ChannelMessage\.Send|full_access_as_user|EWS\.AccessAsUser\.All|Notes\.ReadWrite|Tasks\.ReadWrite|RoleManagement|Application\.ReadWrite)/i;

function scopesOf(grant) { return String(grant.scope || "").split(/\s+/).filter(Boolean); }

async function listEnterpriseApps(tenant, cert, say) {
  say = say || (() => {});
  say("Enterprise-Apps lesen");
  const sps = await graphAllPages(tenant, cert,
    "/servicePrincipals?$select=id,appId,displayName,publisherName,appOwnerOrganizationId,verifiedPublisher,createdDateTime,accountEnabled,appRoleAssignmentRequired,servicePrincipalType&$top=999", V1);
  let grants = [];
  try { grants = await graphAllPages(tenant, cert, "/oauth2PermissionGrants?$top=999", V1); } catch (e) { /* ohne Rechte-Spalte */ }
  const byClient = new Map();
  for (const g of grants) {
    if (!byClient.has(g.clientId)) byClient.set(g.clientId, { scopes: new Set(), admin: false, users: 0 });
    const e = byClient.get(g.clientId);
    scopesOf(g).forEach(s => e.scopes.add(s));
    if (g.consentType === "AllPrincipals") e.admin = true; else e.users++;
  }
  const apps = sps
    .filter(s => s.servicePrincipalType === "Application" && !MS_OWNERS.has(s.appOwnerOrganizationId))
    .map(s => {
      const g = byClient.get(s.id);
      const scopes = g ? [...g.scopes].sort() : [];
      return {
        id: s.id, appId: s.appId, name: s.displayName, publisher: s.publisherName || "",
        verified: !!(s.verifiedPublisher && s.verifiedPublisher.displayName), verifiedName: s.verifiedPublisher ? s.verifiedPublisher.displayName || null : null,
        created: s.createdDateTime || null, enabled: s.accountEnabled !== false, assignmentRequired: !!s.appRoleAssignmentRequired,
        ownTenant: s.appOwnerOrganizationId === tenant.tenantId,
        ai: AI_RE.test(s.displayName + " " + (s.publisherName || "") + " " + (s.verifiedPublisher && s.verifiedPublisher.displayName || "")),
        scopes, risky: scopes.filter(x => RISKY.test(x)),
        adminConsent: g ? g.admin : false, userConsents: g ? g.users : 0
      };
    })
    .sort((a, b) => Number(b.ai) - Number(a.ai) || b.risky.length - a.risky.length || String(a.name).localeCompare(String(b.name)));
  return { apps, summary: { apps: apps.length, ai: apps.filter(a => a.ai).length, risky: apps.filter(a => a.risky.length).length } };
}

async function appEvidence(tenant, cert, spId, opts, say) {
  say = say || (() => {});
  const gaps = [];
  const days = Math.min(Math.max(Number(opts && opts.days) || 30, 1), 30);
  say("App lesen");
  const sp = await graphReq(tenant, cert, "GET", `/servicePrincipals/${encodeURIComponent(spId)}?$select=id,appId,displayName,publisherName,appOwnerOrganizationId,verifiedPublisher,createdDateTime,accountEnabled,appRoleAssignmentRequired,homepage,replyUrls,notes,tags`, null, V1);

  let owners = [];
  try { owners = (await graphAllPages(tenant, cert, `/servicePrincipals/${sp.id}/owners?$select=id,displayName,userPrincipalName`, V1)).map(o => o.userPrincipalName || o.displayName); } catch (e) { /* optional */ }

  say("Delegierte Rechte und Zustimmungen lesen");
  const delegated = [];
  try {
    const grants = await graphAllPages(tenant, cert, `/oauth2PermissionGrants?$filter=clientId eq '${sp.id}'`, V1);
    const resNames = new Map();
    for (const g of grants) {
      if (!resNames.has(g.resourceId)) {
        try { resNames.set(g.resourceId, (await graphReq(tenant, cert, "GET", `/servicePrincipals/${g.resourceId}?$select=displayName`, null, V1)).displayName); }
        catch (e) { resNames.set(g.resourceId, g.resourceId); }
      }
      let who = "alle Benutzer (Administratorzustimmung)";
      if (g.consentType !== "AllPrincipals" && g.principalId) {
        try { const u = await graphReq(tenant, cert, "GET", `/users/${g.principalId}?$select=userPrincipalName`, null, V1); who = u.userPrincipalName; }
        catch (e) { who = g.principalId; }
      }
      delegated.push({ resource: resNames.get(g.resourceId), scopes: scopesOf(g), risky: scopesOf(g).filter(x => RISKY.test(x)), consent: g.consentType === "AllPrincipals" ? "Administrator" : "Benutzer", who });
    }
  } catch (e) { gaps.push("Delegierte Rechte nicht lesbar: " + e.message); }

  say("Anwendungsrechte lesen");
  const application = [];
  try {
    const asg = await graphAllPages(tenant, cert, `/servicePrincipals/${sp.id}/appRoleAssignments`, V1);
    const roleCache = new Map();
    for (const a of asg) {
      if (!roleCache.has(a.resourceId)) {
        try { roleCache.set(a.resourceId, (await graphReq(tenant, cert, "GET", `/servicePrincipals/${a.resourceId}?$select=appRoles`, null, V1)).appRoles || []); }
        catch (e) { roleCache.set(a.resourceId, []); }
      }
      const role = roleCache.get(a.resourceId).find(r => r.id === a.appRoleId);
      const value = role ? role.value : a.appRoleId;
      application.push({ resource: a.resourceDisplayName, permission: value, risky: RISKY.test(value || ""), granted: a.createdDateTime || null });
    }
  } catch (e) { gaps.push("Anwendungsrechte nicht lesbar: " + e.message); }

  let assigned = [];
  try {
    assigned = (await graphAllPages(tenant, cert, `/servicePrincipals/${sp.id}/appRoleAssignedTo?$top=999`, V1))
      .map(a => ({ name: a.principalDisplayName, type: a.principalType, since: a.createdDateTime || null }));
  } catch (e) { gaps.push("Zuweisungen nicht lesbar: " + e.message); }

  say(`Anmeldungen der letzten ${days} Tage lesen`);
  const since = new Date(Date.now() - days * 864e5).toISOString().replace(/\.\d{3}Z$/, "Z");
  const usage = new Map();
  let signInCount = 0, signInError = null;
  const readSignIns = async (p, o, nonInteractive) => {
    let resp = await graphReq(tenant, cert, "GET", p, null, o);
    let n = 0;
    for (;;) {
      for (const s of resp.value || []) {
        n++;
        const k = s.userPrincipalName || s.servicePrincipalName || "—";
        if (!usage.has(k)) usage.set(k, { user: k, interactive: 0, nonInteractive: 0, failed: 0, last: null, ips: new Set() });
        const u = usage.get(k);
        if (nonInteractive) u.nonInteractive++; else u.interactive++;
        if (s.status && s.status.errorCode !== 0) u.failed++;
        if (!u.last || s.createdDateTime > u.last) u.last = s.createdDateTime;
        if (s.ipAddress) u.ips.add(s.ipAddress);
      }
      if (n >= 5000 || !resp["@odata.nextLink"]) break;
      resp = await graphReq(tenant, cert, "GET", resp["@odata.nextLink"], null, o);
    }
    return n;
  };
  try {
    signInCount += await readSignIns(`/auditLogs/signIns?$filter=appId eq '${sp.appId}' and createdDateTime ge ${since}&$top=500`, V1, false);
    try { signInCount += await readSignIns(`/auditLogs/signIns?$filter=appId eq '${sp.appId}' and createdDateTime ge ${since} and signInEventTypes/any(t: t eq 'nonInteractiveUser')&$top=500`, BETA, true); }
    catch (e) { gaps.push("Nicht-interaktive Anmeldungen nicht lesbar: " + e.message); }
    if (application.length) {
      try { signInCount += await readSignIns(`/auditLogs/signIns?$filter=appId eq '${sp.appId}' and createdDateTime ge ${since} and signInEventTypes/any(t: t eq 'servicePrincipal')&$top=500`, BETA, true); }
      catch (e) { /* App-Anmeldungen optional */ }
    }
  } catch (e) { signInError = e.message; gaps.push("Anmeldeprotokoll nicht lesbar (Entra ID P1 nötig): " + e.message); }

  say("Entra-Protokoll zur App lesen");
  let audit = [];
  try {
    audit = (await graphAllPages(tenant, cert, `/auditLogs/directoryAudits?$filter=targetResources/any(t:t/id eq '${sp.id}')&$top=200`, V1)).map(e => ({
      at: e.activityDateTime, activity: e.activityDisplayName, result: e.result,
      by: (e.initiatedBy && ((e.initiatedBy.user && e.initiatedBy.user.userPrincipalName) || (e.initiatedBy.app && e.initiatedBy.app.displayName))) || "—"
    })).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  } catch (e) { gaps.push("Entra-Protokoll nicht lesbar: " + e.message); }

  const users = [...usage.values()].map(u => ({ ...u, ips: [...u.ips].slice(0, 5) })).sort((a, b) => (b.interactive + b.nonInteractive) - (a.interactive + a.nonInteractive));
  return {
    gaps,
    app: {
      id: sp.id, appId: sp.appId, name: sp.displayName, publisher: sp.publisherName || "",
      verified: sp.verifiedPublisher && sp.verifiedPublisher.displayName ? sp.verifiedPublisher.displayName : null,
      created: sp.createdDateTime || null, enabled: sp.accountEnabled !== false, assignmentRequired: !!sp.appRoleAssignmentRequired,
      homepage: sp.homepage || null, replyUrls: (sp.replyUrls || []).slice(0, 10), owners,
      ai: AI_RE.test(sp.displayName + " " + (sp.publisherName || ""))
    },
    delegated, application, assigned,
    signIns: { days, count: signInCount, error: signInError, users },
    audit,
    auditNote: "Das Entra-Protokoll reicht 30 Tage zurück. Ältere Zustimmungen («Consent to application») und alles, was die App getan hat, stehen im Unified Audit Log (bis 180 Tage) — Suche mit der App-Id im Reiter Protokolle.",
    vendorNote: "Einstellungen, die der Anbieter auf seiner Seite hält (bei Claude z. B. die Werkzeugsperren je Connector in den Organisationseinstellungen), sind aus dem Tenant nicht lesbar — als Bildschirmfoto mit Datum nachweisen.",
    summary: {
      delegatedScopes: new Set(delegated.flatMap(d => d.scopes)).size,
      riskyScopes: new Set([...delegated.flatMap(d => d.risky), ...application.filter(a => a.risky).map(a => a.permission)]).size,
      applicationPermissions: application.length,
      userConsents: delegated.filter(d => d.consent === "Benutzer").length,
      adminConsent: delegated.some(d => d.consent === "Administrator"),
      activeUsers: users.length
    }
  };
}

module.exports = { listEnterpriseApps, appEvidence, AI_RE, RISKY };
