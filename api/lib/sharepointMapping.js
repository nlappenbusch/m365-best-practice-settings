"use strict";
/**
 * SharePoint-Sync-Mapping -- konfiguriert OneDrives natives "Configure team
 * site libraries to sync automatically"-Feature (Group Policy + Intune,
 * offiziell dokumentiert: https://learn.microsoft.com/sharepoint/use-group-policy).
 *
 * Registry-Format ist offiziell dokumentiert und per Graph vollstaendig
 * herleitbar (SharePointIds-Ressource auf dem drive-Objekt liefert siteId/
 * webId/listId/tenantId/siteUrl) -- deshalb bewusst NICHT ueber Settings-
 * Catalog (dessen JSON-Schema fuer diese Mehrfachwert-ADMX-Policy riskant zu
 * erraten waere), sondern wie Drive-/Printer-Mapping als eigenstaendiges
 * PowerShell-Platform-Skript (deviceManagementScripts), das die Werte direkt
 * unter HKCU schreibt -- deshalb runAsAccount "user" (nicht "system"!), sonst
 * landen die Werte im falschen Registry-Hive und OneDrive sieht sie nie.
 *
 * Voraussetzung (nicht Teil dieses Moduls, siehe Wissen-Tab-Hinweis): OneDrive
 * Files On-Demand muss aktiv sein -- eine einfache Choice-Einstellung, ueber
 * den bereits bestehenden Settings-Catalog-Suchmechanismus (settingsCatalog.js)
 * ausrollbar.
 */
const fs = require("fs");
const path = require("path");
const { graphReq, graphAllPages } = require("./graph");

const BETA = { beta: true, retryTransient: true };
const SCRIPT_PREFIX = "WIN - SharePointSync - ";

function sanitizeProfileName(name) {
  const n = String(name || "").trim().replace(/[^A-Za-z0-9 ._-]/g, "").slice(0, 40);
  if (!n) throw new Error("Ungueltiger Profilname.");
  return n;
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Mappings validieren -- alle Felder kommen aus resolveLibrary(), nicht von Hand eingetippt. */
function sanitizeMappings(raw) {
  const list = Array.isArray(raw) ? raw : [];
  if (!list.length) throw new Error("Mindestens eine Bibliothek angeben.");
  const seen = new Set();
  return list.map((m, i) => {
    const libraryName = String(m.libraryName || "").trim().slice(0, 60);
    if (!libraryName) throw new Error(`Zeile ${i + 1}: Bezeichnung fehlt.`);
    if (seen.has(libraryName)) throw new Error(`Bezeichnung "${libraryName}" ist doppelt.`);
    seen.add(libraryName);
    for (const f of ["tenantId", "siteId", "webId", "listId"]) {
      if (!GUID_RE.test(String(m[f] || ""))) throw new Error(`Zeile ${i + 1}: ${f} ist keine gueltige GUID -- Site erneut ueber die Auswahl aufloesen.`);
    }
    if (!/^https:\/\//.test(String(m.webUrl || ""))) throw new Error(`Zeile ${i + 1}: webUrl fehlt/ungueltig.`);
    return {
      LibraryName: libraryName,
      TenantId: m.tenantId,
      SiteId: m.siteId,
      WebId: m.webId,
      ListId: m.listId,
      WebUrl: m.webUrl
    };
  });
}

/** Fertiges PowerShell-Skript erzeugen -- schreibt HKCU\...\TenantAutoMount Value-fuer-Value. */
function buildScript({ mappings }) {
  const json = JSON.stringify(sanitizeMappings(mappings)).replace(/'/g, "''");
  return `# SharePoint-Sync-Mapping -- generiert vom M365 Security Policy Manager
# Konfiguriert OneDrives "Configure team site libraries to sync automatically"
# (https://learn.microsoft.com/sharepoint/use-group-policy). Laeuft im Kontext
# des angemeldeten Benutzers (HKCU) -- Voraussetzung: OneDrive Files On-Demand
# ist aktiv, sonst greift die Einstellung nicht.
$mappingsJson = '${json}'
$mappings = $mappingsJson | ConvertFrom-Json

$regPath = "HKCU:\\SOFTWARE\\Policies\\Microsoft\\OneDrive\\TenantAutoMount"
if (-not (Test-Path $regPath)) { New-Item -Path $regPath -Force | Out-Null }

foreach ($m in $mappings) {
    $value = "tenantId=$($m.TenantId)&siteId={$($m.SiteId)}&webId={$($m.WebId)}&listId={$($m.ListId)}&webUrl=$($m.WebUrl)&version=1"
    Set-ItemProperty -Path $regPath -Name $m.LibraryName -Value $value -Type String -Force
    Write-Output "Gemappt: $($m.LibraryName)"
}
`;
}

/** Konfiguration aus einem deployten Skript zurueckparsen (fuer die Bearbeitung). */
function parseScript(scriptText) {
  const m = /\$mappingsJson = '([\s\S]*?)'\r?\n/.exec(String(scriptText || ""));
  if (!m) return null;
  let mappings;
  try { mappings = JSON.parse(m[1].replace(/''/g, "'")); } catch (e) { return null; }
  return {
    mappings: mappings.map(x => ({
      libraryName: x.LibraryName, tenantId: x.TenantId, siteId: x.SiteId,
      webId: x.WebId, listId: x.ListId, webUrl: x.WebUrl
    }))
  };
}

/** Alle SharePoint-Sites im Tenant -- Graph kennt keinen direkten "list all"-Endpoint, daher der uebliche search=*-Trick. */
async function listSites(tenant, cert) {
  const sites = await graphAllPages(tenant, cert, "/sites?search=*&$select=id,displayName,webUrl", {});
  return sites
    .filter(s => s.webUrl && !/\/personal\//i.test(s.webUrl)) // OneDrive-Personal-"Sites" ausschliessen
    .map(s => ({ id: s.id, displayName: s.displayName || s.webUrl, webUrl: s.webUrl }));
}

/** Fuer eine gewaehlte Site die IDs der Standard-Dokumentbibliothek aufloesen (SharePointIds-Ressource). */
async function resolveLibrary(tenant, cert, siteId) {
  const drive = await graphReq(tenant, cert, "GET", `/sites/${encodeURIComponent(siteId)}/drive`, null, {});
  const ids = drive.sharepointIds || drive.sharePointIds;
  if (!ids || !ids.siteId || !ids.webId || !ids.listId) {
    throw Object.assign(new Error("Konnte Bibliotheks-IDs nicht auflösen (keine Standard-Dokumentbibliothek?)."), { status: 502 });
  }
  return {
    libraryName: drive.name || "Dokumente",
    tenantId: ids.tenantId,
    siteId: ids.siteId,
    webId: ids.webId,
    listId: ids.listId,
    webUrl: ids.siteUrl || drive.webUrl
  };
}

/** Vorhandene Profile (Skripte mit unserem Praefix) inkl. Zuweisungen + Konfiguration. */
async function listProfiles(tenant, cert) {
  const scripts = await graphAllPages(tenant, cert, "/deviceManagement/deviceManagementScripts", BETA);
  const ours = scripts.filter(s => String(s.displayName || "").startsWith(SCRIPT_PREFIX));
  const result = [];
  for (const s of ours) {
    let full = s, assignments = [];
    try { full = await graphReq(tenant, cert, "GET", `/deviceManagement/deviceManagementScripts/${s.id}`, null, BETA); } catch (e) { /* Kopf reicht */ }
    try { assignments = (await graphReq(tenant, cert, "GET", `/deviceManagement/deviceManagementScripts/${s.id}/assignments`, null, BETA)).value || []; } catch (e) { /* egal */ }
    const content = full.scriptContent ? Buffer.from(full.scriptContent, "base64").toString("utf8") : "";
    result.push({
      id: s.id,
      profileName: String(s.displayName).slice(SCRIPT_PREFIX.length),
      displayName: s.displayName,
      config: parseScript(content),
      groupIds: assignments.map(a => a && a.target && a.target.groupId).filter(Boolean)
    });
  }
  return result;
}

/** Profil anlegen/aktualisieren (idempotent nach displayName) + Gruppen zuweisen. */
async function deployProfile(tenant, cert, { profileName, mappings, groupIds }) {
  const name = SCRIPT_PREFIX + sanitizeProfileName(profileName);
  const scriptContent = Buffer.from(buildScript({ mappings }), "utf8").toString("base64");
  const body = {
    "@odata.type": "#microsoft.graph.deviceManagementScript",
    displayName: name,
    description: "SharePoint-Sync-Mapping — generiert vom M365 Security Policy Manager (OneDrive „Configure team site libraries to sync automatically\"). Laeuft als angemeldeter Benutzer (schreibt HKCU).",
    scriptContent,
    runAsAccount: "user",
    enforceSignatureCheck: false,
    fileName: "SharePointSyncMapping.ps1",
    runAs32Bit: false
  };

  const existing = await graphAllPages(tenant, cert, "/deviceManagement/deviceManagementScripts", BETA);
  const match = existing.find(s => s.displayName === name);
  let scriptId;
  if (match) {
    await graphReq(tenant, cert, "PATCH", `/deviceManagement/deviceManagementScripts/${match.id}`, body, BETA);
    scriptId = match.id;
  } else {
    const created = await graphReq(tenant, cert, "POST", "/deviceManagement/deviceManagementScripts", body, BETA);
    scriptId = created.id;
  }

  const ids = (Array.isArray(groupIds) ? groupIds : []).filter(Boolean);
  await graphReq(tenant, cert, "POST", `/deviceManagement/deviceManagementScripts/${scriptId}/assign`, {
    deviceManagementScriptAssignments: ids.map(groupId => ({
      target: { "@odata.type": "#microsoft.graph.groupAssignmentTarget", groupId }
    }))
  }, BETA);

  return { scriptId, displayName: name, updated: !!match };
}

module.exports = { buildScript, parseScript, sanitizeMappings, listSites, resolveLibrary, listProfiles, deployProfile, SCRIPT_PREFIX };
