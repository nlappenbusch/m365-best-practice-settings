/**
 * App-Zielgruppen fuer selbst verteilte Agents (Bitdefender/N-sight), nach dem
 * Namenskonzept AAD-APP-<Name> (siehe Wissen -> Namenskonventionen): die App
 * wird IMMER an diese eine Gruppe zugewiesen; welche Geraete sie bekommen,
 * steuert man ueber Gruppen-Nesting — die dynamische GroupTag-Gerätegruppe
 * (z.B. AAD-DEV-STD) wird als Mitglied in AAD-APP-<Name> aufgenommen, ihre
 * Geraete werden dadurch transitiv adressiert (von Intune fuer App-Assignment
 * unterstuetzt).
 */
const { graphReq, graphAllPages } = require("./graph");

function sanitizeAppNameForGroup(name) {
  return String(name || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 60) || "App";
}

function odataLit(s) { return String(s || "").replace(/'/g, "''"); }

/** AAD-APP-<Name>-Gruppe finden oder anlegen (idempotent). */
async function ensureAppGroup(tenant, certPemPath, appName) {
  const displayName = "AAD-APP-" + sanitizeAppNameForGroup(appName);
  const existing = await graphAllPages(tenant, certPemPath,
    `/groups?$filter=displayName eq '${odataLit(displayName)}'&$select=id,displayName`);
  if (existing.length) return { id: existing[0].id, displayName, created: false };

  const g = await graphReq(tenant, certPemPath, "POST", "/groups", {
    displayName,
    description: "App-Zielgruppe (Win32-App-Deployment) — automatisch erzeugt vom M365 Security Policy Manager.",
    mailEnabled: false,
    mailNickname: displayName.toLowerCase().replace(/[^a-z0-9]/g, ""),
    securityEnabled: true,
    groupTypes: []
  });
  return { id: g.id, displayName, created: true };
}

/** Kindgruppe (z.B. dynamische Geraetegruppe) als Mitglied der Elterngruppe aufnehmen (idempotent). */
async function nestGroupAsMember(tenant, certPemPath, parentGroupId, childGroupId) {
  const members = await graphAllPages(tenant, certPemPath, `/groups/${parentGroupId}/members?$select=id`);
  if (members.some(m => m.id === childGroupId)) return "skipped";
  await graphReq(tenant, certPemPath, "POST", `/groups/${parentGroupId}/members/$ref`, {
    "@odata.id": `https://graph.microsoft.com/v1.0/directoryObjects/${childGroupId}`
  });
  return "added";
}

module.exports = { ensureAppGroup, nestGroupAsMember, sanitizeAppNameForGroup };
