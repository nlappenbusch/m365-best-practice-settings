/**
 * OpenIntuneBaseline-Import: holt die Windows-Baseline-Policies direkt aus dem
 * GitHub-Repo (SkipToTheEndpoint/OpenIntuneBaseline, MIT) und importiert sie
 * app-only per Graph in den Ziel-Tenant — Port der Importlogik aus
 * SkipToTheEndpoint/OIBDeployer (React/MSAL-SPA) auf unser Backend.
 *
 * Quelle: WINDOWS/IntuneManagement/<Ordner>/*.json (IntuneManagement-Exporte,
 * d.h. Graph-JSON mit Export-Ballast). Ordnername bestimmt den Ziel-Endpoint:
 *   SettingsCatalog      -> /deviceManagement/configurationPolicies
 *   CompliancePolicies   -> /deviceManagement/deviceCompliancePolicies
 *   DeviceConfiguration  -> /deviceManagement/deviceConfigurations
 *   DriverUpdateProfiles -> /deviceManagement/windowsDriverUpdateProfiles
 *   UpdatePolicies       -> nach @odata.type (Feature-/Quality-Profil oder
 *                           legacy windowsUpdateForBusinessConfiguration ->
 *                           deviceConfigurations)
 * Alles beta (wie OIBDeployer und unser oib.js — Intune lebt primaer in beta).
 *
 * Idempotenz: existiert im Tenant bereits eine Policy gleichen Namens, wird
 * die Datei uebersprungen (Status "skipped") — nie ueberschrieben.
 */
const { graphReq, graphAllPages } = require("./graph");

const GH_API = "https://api.github.com/repos/SkipToTheEndpoint/OpenIntuneBaseline/contents";
const GH_RAW = "https://raw.githubusercontent.com/SkipToTheEndpoint/OpenIntuneBaseline/main";
const BASE_PATH = "WINDOWS/IntuneManagement";
const FOLDERS = ["SettingsCatalog", "CompliancePolicies", "DeviceConfiguration", "DriverUpdateProfiles", "UpdatePolicies"];

async function ghJson(url) {
  const r = await fetch(url, { headers: { "user-agent": "m365-security-policy-manager", accept: "application/vnd.github+json" } });
  if (!r.ok) throw new Error(`GitHub-Abruf fehlgeschlagen (${r.status}): ${url}`);
  return r.json();
}

/** Baseline-Inhalt auflisten: [{ folder, fileName, name }] + oibVersion aus dem Manifest. */
async function fetchBaselineIndex() {
  let oibVersion = null;
  try {
    const raw = await fetch(`${GH_RAW}/WINDOWS/PolicyManifest.json`);
    if (raw.ok) oibVersion = (await raw.json()).oibVersion || null;
  } catch (e) { /* Version ist nice-to-have */ }

  const policies = [];
  for (const folder of FOLDERS) {
    const items = await ghJson(`${GH_API}/${BASE_PATH}/${encodeURIComponent(folder)}`);
    for (const it of items) {
      if (it.type !== "file" || !/\.json$/i.test(it.name)) continue;
      policies.push({ folder, fileName: it.name, name: it.name.replace(/\.json$/i, "") });
    }
  }
  return { oibVersion, policies };
}

/** Export-Ballast rekursiv entfernen: alle *@odata*-Annotationen (ausser dem
 *  Typ-Diskriminator "@odata.type" selbst) und alle "#microsoft.graph.*"-
 *  Action-Links, auf jeder Ebene. */
function stripExportNoise(node) {
  if (Array.isArray(node)) return node.map(stripExportNoise);
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith("#")) continue;
      if (k.includes("@odata") && k !== "@odata.type") continue;
      out[k] = stripExportNoise(v);
    }
    return out;
  }
  return node;
}

const TOP_PROPS_TO_REMOVE = [
  "id", "createdDateTime", "lastModifiedDateTime", "creationSource", "version",
  "supportsScopeTags", "roleScopeTagIds", "isAssigned", "assignments",
  "priorityMetaData", "settingCount", "deviceStatuses", "userStatuses",
  "deviceStatusOverview", "userStatusOverview", "deviceSettingStateSummaries",
  "groupAssignments", "templateId", "intentSettings"
];

/** Policy-Export fuer den Import vorbereiten (Port von OIBDeployer transformPolicyForImport). */
function transformForImport(policyJson, tenantId) {
  let p = stripExportNoise(policyJson);
  for (const prop of TOP_PROPS_TO_REMOVE) delete p[prop];

  // Tenant-Variable ersetzen (kommt in einzelnen Baseline-Policies vor)
  p = JSON.parse(JSON.stringify(p).replace(/%OrganizationId%/gi, tenantId));

  // Compliance: scheduledActionsForRule bereinigen bzw. Standard-Blockaktion
  // ergaenzen — Graph verlangt das Feld beim Anlegen.
  const isCompliance = /CompliancePolicy/i.test(String(p["@odata.type"] || ""));
  if (isCompliance) {
    if (Array.isArray(p.scheduledActionsForRule) && p.scheduledActionsForRule.length) {
      p.scheduledActionsForRule = p.scheduledActionsForRule.map(rule => {
        const r = { ...rule };
        delete r.id;
        if (Array.isArray(r.scheduledActionConfigurations)) {
          r.scheduledActionConfigurations = r.scheduledActionConfigurations.map(c => { const cc = { ...c }; delete cc.id; return cc; });
        }
        return r;
      });
    } else {
      p.scheduledActionsForRule = [{
        "@odata.type": "#microsoft.graph.deviceComplianceScheduledActionForRule",
        ruleName: null,
        scheduledActionConfigurations: [{
          "@odata.type": "#microsoft.graph.deviceComplianceActionItem",
          gracePeriodHours: 12, actionType: "block",
          notificationTemplateId: "00000000-0000-0000-0000-000000000000",
          notificationMessageCCList: []
        }]
      }];
    }
  }
  return p;
}

/** Ziel-Endpoint aus Ordner + @odata.type bestimmen. */
function endpointFor(folder, policy) {
  switch (folder) {
    case "SettingsCatalog": return "/deviceManagement/configurationPolicies";
    case "CompliancePolicies": return "/deviceManagement/deviceCompliancePolicies";
    case "DeviceConfiguration": return "/deviceManagement/deviceConfigurations";
    case "DriverUpdateProfiles": return "/deviceManagement/windowsDriverUpdateProfiles";
    case "UpdatePolicies": {
      const t = String(policy["@odata.type"] || "");
      if (t.includes("windowsFeatureUpdateProfile")) return "/deviceManagement/windowsFeatureUpdateProfiles";
      if (t.includes("windowsQualityUpdateProfile")) return "/deviceManagement/windowsQualityUpdateProfiles";
      if (t.includes("windowsDriverUpdateProfile")) return "/deviceManagement/windowsDriverUpdateProfiles";
      // Legacy WUfB-Ringe sind Device-Configuration-Objekte
      return "/deviceManagement/deviceConfigurations";
    }
    default: throw new Error("Unbekannter Baseline-Ordner: " + folder);
  }
}

/** Vorhandene Policy-Namen im Tenant einsammeln (fuer Skip-Logik), pro Endpoint. */
async function loadExistingNames(tenant, cert) {
  const beta = { beta: true, retryTransient: true };
  const names = new Set();
  const sources = [
    ["/deviceManagement/configurationPolicies?$select=id,name&$top=100", p => p.name],
    ["/deviceManagement/deviceCompliancePolicies?$select=id,displayName&$top=100", p => p.displayName],
    ["/deviceManagement/deviceConfigurations?$select=id,displayName&$top=100", p => p.displayName],
    ["/deviceManagement/windowsDriverUpdateProfiles?$select=id,displayName&$top=100", p => p.displayName],
    ["/deviceManagement/windowsFeatureUpdateProfiles?$select=id,displayName&$top=100", p => p.displayName],
    ["/deviceManagement/windowsQualityUpdateProfiles?$select=id,displayName&$top=100", p => p.displayName]
  ];
  for (const [path, pick] of sources) {
    try {
      const list = await graphAllPages(tenant, cert, path, beta);
      for (const p of list) { const n = pick(p); if (n) names.add(n); }
    } catch (e) { /* einzelner Endpoint nicht verfuegbar -> Skip-Logik dann eben ohne ihn */ }
  }
  return names;
}

/**
 * Ausgewaehlte Baseline-Dateien importieren.
 * selected: [{ folder, fileName }], onProgress(label).
 * Rueckgabe: [{ name, status: created|skipped|failed, error? }]
 */
async function importPolicies(tenant, cert, selected, onProgress) {
  const notify = onProgress || (() => {});
  const beta = { beta: true, retryTransient: true };

  notify("Bestehende Policies laden");
  const existing = await loadExistingNames(tenant, cert);

  const results = [];
  let i = 0;
  for (const sel of selected) {
    i++;
    const name = String(sel.fileName || "").replace(/\.json$/i, "");
    notify(`Policy ${i}/${selected.length}: ${name}`);
    try {
      if (!FOLDERS.includes(sel.folder)) throw new Error("Unbekannter Ordner: " + sel.folder);
      if (existing.has(name)) { results.push({ name, status: "skipped" }); continue; }

      const url = `${GH_RAW}/${BASE_PATH}/${encodeURIComponent(sel.folder)}/${encodeURIComponent(sel.fileName)}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Download fehlgeschlagen (${r.status})`);
      const raw = await r.json();

      const payload = transformForImport(raw, tenant.tenantId);
      const endpoint = endpointFor(sel.folder, payload);
      await graphReq(tenant, cert, "POST", endpoint, payload, beta);
      results.push({ name, status: "created" });
    } catch (e) {
      results.push({ name, status: "failed", error: e.message });
    }
  }
  return results;
}

module.exports = { fetchBaselineIndex, transformForImport, endpointFor, importPolicies, FOLDERS };
