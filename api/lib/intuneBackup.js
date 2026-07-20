/**
 * Intune-Backup & -Restore (Idee: ugurkocde/TenuVault, hier als app-only-
 * Neuimplementierung direkt im Tool — das Original ist ein delegiertes
 * PowerShell-Skript):
 *
 *  - Backup liest NUR (GET) und sichert die Konfiguration als JSON-Snapshot
 *    serverseitig (STATE_DIR/backups/<tenant>/<zeitstempel>.json) + Download.
 *  - Restore ist NON-DESTRUKTIV: legt ausschliesslich NEUE Policies mit
 *    "[Restored] "-Praefix an, ohne Zuweisungen — bestehende Objekte werden
 *    nie veraendert oder geloescht.
 *  - Keine zusaetzlichen Permissions noetig: DeviceManagementConfiguration/
 *    Apps/ServiceConfig.ReadWrite.All sind bereits Teil des Onboardings.
 *
 * Abgedeckte Typen (>= TenuVault): Settings Catalog (inkl. Settings),
 * Compliance, Device Configurations, Plattform-Skripte (inkl. Inhalt),
 * Feature-/Quality-/Driver-Update-Profile. Admin Templates (ADMX) sind
 * bewusst NICHT dabei — deren definitionValues-Modell braucht eine eigene
 * Restore-Logik und waere sonst nur Schein-Sicherheit.
 */
const fs = require("fs");
const path = require("path");
const { graphReq, graphAllPages } = require("./graph");
const { transformForImport } = require("./oibImport");

const BETA = { beta: true, retryTransient: true };

const CATEGORIES = [
  { key: "settingsCatalog", label: "Settings Catalog", nameOf: p => p.name },
  { key: "compliance", label: "Compliance", nameOf: p => p.displayName },
  { key: "deviceConfigurations", label: "Device Configurations", nameOf: p => p.displayName },
  { key: "scripts", label: "Plattform-Skripte", nameOf: p => p.displayName },
  { key: "featureUpdates", label: "Feature Updates", nameOf: p => p.displayName },
  { key: "qualityUpdates", label: "Quality Updates", nameOf: p => p.displayName },
  { key: "driverUpdates", label: "Driver Updates", nameOf: p => p.displayName }
];

function backupDir(stateDir, tenantUid) {
  const dir = path.join(stateDir, "backups", tenantUid.replace(/[^A-Za-z0-9_-]/g, "_"));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Kompletten Konfigurations-Snapshot lesen (nur GET-Aufrufe). */
async function collectSnapshot(tenant, cert, onProgress) {
  const notify = onProgress || (() => {});
  const cat = {};

  notify("Settings Catalog sichern");
  // $expand=settings liefert die kompletten Einstellungen mit — ohne die
  // waere ein Restore wertlos.
  cat.settingsCatalog = await graphAllPages(tenant, cert,
    "/deviceManagement/configurationPolicies?$expand=settings&$top=100", BETA).catch(() => []);

  notify("Compliance-Policies sichern");
  cat.compliance = await graphAllPages(tenant, cert,
    "/deviceManagement/deviceCompliancePolicies?$expand=scheduledActionsForRule($expand=scheduledActionConfigurations)", BETA).catch(() => []);

  notify("Device Configurations sichern");
  cat.deviceConfigurations = await graphAllPages(tenant, cert,
    "/deviceManagement/deviceConfigurations", BETA).catch(() => []);

  notify("Plattform-Skripte sichern");
  const scriptHeads = await graphAllPages(tenant, cert, "/deviceManagement/deviceManagementScripts", BETA).catch(() => []);
  cat.scripts = [];
  for (const s of scriptHeads) {
    // Skript-Inhalt (base64) kommt nur beim Einzelabruf mit.
    try { cat.scripts.push(await graphReq(tenant, cert, "GET", `/deviceManagement/deviceManagementScripts/${s.id}`, null, BETA)); }
    catch (e) { cat.scripts.push(s); }
  }

  notify("Update-Profile sichern");
  cat.featureUpdates = await graphAllPages(tenant, cert, "/deviceManagement/windowsFeatureUpdateProfiles", BETA).catch(() => []);
  cat.qualityUpdates = await graphAllPages(tenant, cert, "/deviceManagement/windowsQualityUpdateProfiles", BETA).catch(() => []);
  cat.driverUpdates = await graphAllPages(tenant, cert, "/deviceManagement/windowsDriverUpdateProfiles", BETA).catch(() => []);

  return cat;
}

function snapshotCounts(categories) {
  const counts = {};
  for (const c of CATEGORIES) counts[c.key] = (categories[c.key] || []).length;
  counts.total = Object.values(counts).reduce((a, b) => a + b, 0);
  return counts;
}

/** Backup ausfuehren und serverseitig ablegen. Rueckgabe: { backupId, counts }. */
async function runBackup(stateDir, tenant, cert, onProgress) {
  const categories = await collectSnapshot(tenant, cert, onProgress);
  const backupId = new Date().toISOString().replace(/[:.]/g, "-");
  const doc = {
    meta: {
      tool: "M365 Security Policy Manager",
      kind: "intune-backup", version: 1,
      tenantUid: tenant.id, tenantId: tenant.tenantId, tenantName: tenant.name,
      createdAt: new Date().toISOString()
    },
    categories
  };
  fs.writeFileSync(path.join(backupDir(stateDir, tenant.id), backupId + ".json"), JSON.stringify(doc), "utf8");
  return { backupId, counts: snapshotCounts(categories) };
}

/** Vorhandene Snapshots eines Tenants auflisten (neueste zuerst). */
function listBackups(stateDir, tenantUid) {
  const dir = backupDir(stateDir, tenantUid);
  return fs.readdirSync(dir)
    .filter(f => f.endsWith(".json"))
    .map(f => {
      try {
        const doc = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        return { backupId: f.replace(/\.json$/, ""), createdAt: doc.meta.createdAt, counts: snapshotCounts(doc.categories) };
      } catch (e) { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function loadBackup(stateDir, tenantUid, backupId) {
  const safe = String(backupId || "").replace(/[^A-Za-z0-9ZT-]/g, "");
  const p = path.join(backupDir(stateDir, tenantUid), safe + ".json");
  if (!fs.existsSync(p)) throw Object.assign(new Error("Backup nicht gefunden."), { status: 404 });
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

const RESTORE_ENDPOINTS = {
  settingsCatalog: "/deviceManagement/configurationPolicies",
  compliance: "/deviceManagement/deviceCompliancePolicies",
  deviceConfigurations: "/deviceManagement/deviceConfigurations",
  scripts: "/deviceManagement/deviceManagementScripts",
  featureUpdates: "/deviceManagement/windowsFeatureUpdateProfiles",
  qualityUpdates: "/deviceManagement/windowsQualityUpdateProfiles",
  driverUpdates: "/deviceManagement/windowsDriverUpdateProfiles"
};

/** Ein gesichertes Objekt fuer den Restore vorbereiten: Export-Ballast raus,
 *  "[Restored] "-Praefix rein, ohne Zuweisungen. */
function prepareRestore(categoryKey, raw, tenantId) {
  const p = transformForImport(raw, tenantId); // strippt @odata-Ballast/ids/assignments, fixt Compliance
  const prefix = "[Restored] ";
  if (categoryKey === "settingsCatalog") {
    p.name = prefix + String(p.name || "Policy");
  } else {
    p.displayName = prefix + String(p.displayName || "Policy");
  }
  return p;
}

/**
 * Ausgewaehlte Objekte aus einem Snapshot wiederherstellen.
 * items: [{ category, index }]; onProgress(label).
 * Rueckgabe: [{ name, status: created|failed, error? }]
 */
async function restoreItems(stateDir, tenant, cert, backupId, items, onProgress) {
  const notify = onProgress || (() => {});
  const doc = loadBackup(stateDir, tenant.id, backupId);
  const results = [];
  let i = 0;
  for (const it of items) {
    i++;
    const list = doc.categories[it.category] || [];
    const raw = list[it.index];
    const catMeta = CATEGORIES.find(c => c.key === it.category);
    if (!raw || !catMeta || !RESTORE_ENDPOINTS[it.category]) {
      results.push({ name: `${it.category}[${it.index}]`, status: "failed", error: "Eintrag nicht im Backup gefunden." });
      continue;
    }
    const origName = catMeta.nameOf(raw) || "Policy";
    notify(`Restore ${i}/${items.length}: ${origName}`);
    try {
      const payload = prepareRestore(it.category, raw, tenant.tenantId);
      await graphReq(tenant, cert, "POST", RESTORE_ENDPOINTS[it.category], payload, BETA);
      results.push({ name: "[Restored] " + origName, status: "created" });
    } catch (e) {
      results.push({ name: origName, status: "failed", error: e.message });
    }
  }
  return results;
}

module.exports = { CATEGORIES, runBackup, listBackups, loadBackup, restoreItems, prepareRestore, snapshotCounts };
