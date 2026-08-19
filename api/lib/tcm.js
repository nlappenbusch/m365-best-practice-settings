/**
 * Tenant Configuration Management (TCM) — Graph-basierte Snapshot-Pruefung
 * der Alert Policy. Schliesst die Audit-Luecke, die entsteht, weil Security &
 * Compliance PowerShell auf Linux nicht laeuft: Der TCM-Dienst (Microsoft-
 * gehostet) liest die protectionAlert-Ressourcen und liefert sie als Snapshot.
 *
 * Voraussetzungen im Tenant (richtet Onboarding/Fixer ein):
 *  - Unsere App: Graph-Permission ConfigurationMonitoring.ReadWrite.All
 *  - TCM-Service-Principal (03b07b79-...) vorhanden, mit Exchange.ManageAsApp
 *    (Read-Zugriff auf S&C-Ressourcen) + Entra-Rolle "Security Reader"
 *  - M365 Admin Services SP (6b91db1b-...) vorhanden
 */
const { graphReq } = require("./graph");

const RESOURCE = "microsoft.securityandcompliance.protectionalert";
const ALERT_NAME = "BP_UserRequestReleaseStatus";

/** Snapshot-Job fuer die protectionAlert-Ressourcen starten. */
async function startAlertPolicySnapshot(tenant, certPemPath) {
  const job = await graphReq(tenant, certPemPath, "POST",
    "/admin/configurationManagement/configurationSnapshots/createSnapshot", {
      displayName: "BP-AlertPolicy-Audit " + new Date().toISOString().slice(0, 16),
      description: "Automatische Pruefung der Alert Policy durch den M365 Security Policy Manager",
      resources: [RESOURCE]
    });
  return job; // { id, status, ... }
}

// Rekursiv nach dem Alert-Policy-Objekt suchen — das Snapshot-Schema ist das
// Baseline-Schema; wir suchen defensiv nach einem Objekt mit Name=ALERT_NAME.
function findAlertObject(node) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const item of node) { const hit = findAlertObject(item); if (hit) return hit; }
    return null;
  }
  const nameVal = node.Name || node.name;
  if (typeof nameVal === "string" && nameVal.toLowerCase() === ALERT_NAME.toLowerCase()) return node;
  for (const v of Object.values(node)) { const hit = findAlertObject(v); if (hit) return hit; }
  return null;
}

function pick(obj, keys) {
  for (const k of keys) if (obj && obj[k] !== undefined) return obj[k];
  return undefined;
}

/**
 * Job-Status pruefen. Rueckgabe:
 *  { status: 'pending' } | { status: 'error', error } |
 *  { status: 'done', found, notifyUser, disabled, aggregationType }
 */
async function getAlertPolicySnapshotResult(tenant, certPemPath, jobId) {
  const job = await graphReq(tenant, certPemPath, "GET",
    `/admin/configurationManagement/configurationSnapshotJobs/${encodeURIComponent(jobId)}`);
  const status = String(job.status || "").toLowerCase();
  if (["succeeded", "success", "completed"].includes(status)) {
    const loc = job.resourceLocation;
    if (!loc) return { status: "error", error: "Snapshot fertig, aber keine resourceLocation vorhanden." };
    let snapshot;
    if (/graph\.microsoft\.com/i.test(loc)) {
      snapshot = await graphReq(tenant, certPemPath, "GET", loc);
    } else {
      const r = await fetch(loc);
      if (!r.ok) return { status: "error", error: "Snapshot-Download fehlgeschlagen: HTTP " + r.status };
      snapshot = await r.json().catch(() => null);
    }
    if (!snapshot) return { status: "error", error: "Snapshot-Inhalt nicht lesbar." };

    // Aufraeumen (max. 12 sichtbare Jobs pro Tenant) — best effort
    try {
      await graphReq(tenant, certPemPath, "DELETE",
        `/admin/configurationManagement/configurationSnapshotJobs/${encodeURIComponent(jobId)}`);
    } catch (e) { /* egal */ }

    const alert = findAlertObject(snapshot);
    if (!alert) return { status: "done", found: false };
    const notify = pick(alert, ["NotifyUser", "notifyUser"]);
    return {
      status: "done",
      found: true,
      notifyUser: Array.isArray(notify) ? notify : (notify ? [notify] : []),
      disabled: pick(alert, ["Disabled", "disabled"]) === true,
      aggregationType: pick(alert, ["AggregationType", "aggregationType"]) || ""
    };
  }
  if (["failed", "error"].includes(status)) {
    return { status: "error", error: "Snapshot-Job fehlgeschlagen (" + (job.status || "unbekannt") + "). TCM-Einrichtung pruefen (🔧 Reparieren)." };
  }
  return { status: "pending" };
}

module.exports = { startAlertPolicySnapshot, getAlertPolicySnapshotResult, ALERT_NAME };
