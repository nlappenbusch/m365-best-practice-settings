"use strict";
/**
 * Registry-Richtlinien-Konfigurator (HKLM) -- generischer Ersatz fuer den Fall,
 * dass eine neue Windows-/Intune-Richtlinie noch nicht als Settings-Catalog-
 * Einstellung durchsuchbar ist (z. B. ganz frisch per Sicherheitsupdate
 * eingefuehrt) oder schlicht ein simpler Ein-Wert-Registry-Schalter ist, fuer
 * den sich die Settings-Catalog-Suche + JSON-Schema-Raterei nicht lohnt.
 *
 * Gleicher Ansatz wie Drive-/Printer-/SharePoint-Mapping: eigenstaendiges
 * PowerShell-Plattformskript (deviceManagementScripts), diesmal runAsAccount
 * "system" (nicht "user"!), weil HKLM nur im System-Kontext beschreibbar ist.
 *
 * PRESETS enthaelt bekannte, fertig geprueft Werte (z. B. das EU-DMA
 * "AutoAcceptSsoPermission"-Reg-Update aus KB5101650, Juli 2026) als
 * Ein-Klick-Vorlage -- das Tool selbst bleibt aber allgemein nutzbar fuer
 * kuenftige, aehnlich simple Ein-Wert-Richtlinien.
 */
const { graphReq, graphAllPages } = require("./graph");

const BETA = { beta: true, retryTransient: true };
const SCRIPT_PREFIX = "WIN - RegistryPolicy - ";

const PRESETS = [
  {
    key: "dma-sso-autoaccept",
    label: "EU DMA: SSO-Anmeldeaufforderung automatisch akzeptieren",
    description:
      "Unterdrueckt den \"Weiter anmelden?\"-SSO-Prompt (EU Digital Markets Act) auf verwalteten Windows-11-Geraeten (24H2/25H2 + Sicherheitsupdate Juli 2026, KB5101650). Gilt nur fuer Entra-ID-Konten auf verwalteten Geraeten -- private Microsoft-Konten und unverwaltete Geraete sind nicht betroffen.",
    entries: [
      { path: "SOFTWARE\\Policies\\Microsoft\\Windows\\AAD", name: "AutoAcceptSsoPermission", type: "DWORD", value: "1" }
    ]
  },
  {
    key: "bitwarden-browserext-eu",
    label: "Bitwarden-Browsererweiterung: Server-Region EU vorgeben",
    description:
      "Setzt die Server-Umgebung der Bitwarden-Browsererweiterung fest auf die EU-Cloud (vault.bitwarden.eu), damit " +
      "der Benutzer beim ersten Login nicht selbst die Region umstellen muss (Standard waere die US-Cloud). Wirkt ueber " +
      "die 3rdparty-Extension-Policy von Chrome und Edge — die Erweiterung selbst wird davon NICHT installiert, das macht " +
      "die Erweiterungsrichtlinie im Intune-Portal. Auf der US-Cloud braucht es dieses Profil nicht (das ist die Vorgabe); " +
      "fuer eine selbst gehostete Instanz einfach die beiden URLs unten auf den eigenen Server aendern. " +
      "Die Edge-Zeilen decken beide Erweiterungs-IDs ab: die aus den Edge-Add-ons und die aus dem Chrome Web Store " +
      "(bei der Installation aus dem Chrome-Store behaelt die Erweiterung auch in Edge ihre Chrome-ID). " +
      "Quelle: Bitwarden-Doku \"Connect Managed Devices\".",
    entries: [
      { path: "SOFTWARE\\Policies\\Google\\Chrome\\3rdparty\\extensions\\nngceckbapebfimnlniiiahkandclblb\\policy\\environment", name: "base", type: "String", value: "https://vault.bitwarden.eu" },
      { path: "SOFTWARE\\Policies\\Google\\Chrome\\3rdparty\\extensions\\nngceckbapebfimnlniiiahkandclblb\\policy\\environment", name: "notifications", type: "String", value: "https://notifications.bitwarden.eu" },
      { path: "SOFTWARE\\Policies\\Microsoft\\Edge\\3rdparty\\extensions\\jbkfoedolllekgbhcbcoahefnbanhhlh\\policy\\environment", name: "base", type: "String", value: "https://vault.bitwarden.eu" },
      { path: "SOFTWARE\\Policies\\Microsoft\\Edge\\3rdparty\\extensions\\jbkfoedolllekgbhcbcoahefnbanhhlh\\policy\\environment", name: "notifications", type: "String", value: "https://notifications.bitwarden.eu" },
      { path: "SOFTWARE\\Policies\\Microsoft\\Edge\\3rdparty\\extensions\\nngceckbapebfimnlniiiahkandclblb\\policy\\environment", name: "base", type: "String", value: "https://vault.bitwarden.eu" },
      { path: "SOFTWARE\\Policies\\Microsoft\\Edge\\3rdparty\\extensions\\nngceckbapebfimnlniiiahkandclblb\\policy\\environment", name: "notifications", type: "String", value: "https://notifications.bitwarden.eu" }
    ]
  }
];

function sanitizeProfileName(name) {
  const n = String(name || "").trim().replace(/[^A-Za-z0-9 ._-]/g, "").slice(0, 40);
  if (!n) throw new Error("Ungueltiger Profilname.");
  return n;
}

const REG_TYPES = new Set(["DWORD", "String", "QWORD"]);
// HKLM-Unterpfad, keine Laufwerks-/Datei-Sonderzeichen, kein Zugriff ausserhalb der Policies-Hive erzwungen (aber nicht technisch eingeschraenkt --
// Nils tippt hier bewusst als Admin, kein Fremdinput).
const PATH_RE = /^[A-Za-z0-9 _.\\-]+$/;
const NAME_RE = /^[A-Za-z0-9 _.-]+$/;

/** Eintraege validieren -- Pfad relativ zu HKLM:\, Name, Typ, Wert. */
function sanitizeEntries(raw) {
  const list = Array.isArray(raw) ? raw : [];
  if (!list.length) throw new Error("Mindestens einen Registry-Wert angeben.");
  return list.map((e, i) => {
    const p = String(e.path || "").trim().replace(/^HKLM:?\\?/i, "").replace(/\\+$/, "");
    if (!p || !PATH_RE.test(p)) throw new Error(`Zeile ${i + 1}: Registry-Pfad ungueltig.`);
    const name = String(e.name || "").trim();
    if (!name || !NAME_RE.test(name)) throw new Error(`Zeile ${i + 1}: Werte-Name ungueltig.`);
    const type = String(e.type || "DWORD").trim();
    if (!REG_TYPES.has(type)) throw new Error(`Zeile ${i + 1}: Typ muss DWORD, QWORD oder String sein.`);
    const value = String(e.value ?? "").trim();
    if (!value) throw new Error(`Zeile ${i + 1}: Wert fehlt.`);
    if (type === "DWORD" || type === "QWORD") {
      if (!/^\d+$/.test(value)) throw new Error(`Zeile ${i + 1}: ${type}-Wert muss eine Zahl sein.`);
      const max = type === "DWORD" ? 0xFFFFFFFFn : 0xFFFFFFFFFFFFFFFFn;
      if (BigInt(value) > max) throw new Error(`Zeile ${i + 1}: ${type}-Wert ist zu gross (max. ${max}).`);
    }
    return { Path: p, Name: name, Type: type, Value: value };
  });
}

/** Fertiges PowerShell-Skript erzeugen -- schreibt HKLM Value-fuer-Value. */
function buildScript({ entries }) {
  const json = JSON.stringify(sanitizeEntries(entries)).replace(/'/g, "''");
  return `# Registry-Richtlinie -- generiert vom M365 Security Policy Manager
# Schreibt die konfigurierten Werte unter HKLM:\\ (Systemkontext -- runAsAccount "system").
$entriesJson = '${json}'
$entries = $entriesJson | ConvertFrom-Json

foreach ($e in $entries) {
    $regPath = "HKLM:\\$($e.Path)"
    if (-not (Test-Path $regPath)) { New-Item -Path $regPath -Force | Out-Null }
    $psType = switch ($e.Type) { "DWORD" { "DWord" } "QWORD" { "QWord" } default { "String" } }
    # Unsigned-Casts: [int64] wuerde bei DWORD-Werten > 2147483647 (z.B. 0xFFFFFFFF)
    # in Set-ItemProperty -Type DWord einen Ueberlauf-Fehler ausloesen.
    $value = switch ($psType) { "DWord" { [uint32]$e.Value } "QWord" { [uint64]$e.Value } default { $e.Value } }
    Set-ItemProperty -Path $regPath -Name $e.Name -Value $value -Type $psType -Force
    Write-Output "Gesetzt: HKLM:\\$($e.Path) [$($e.Name)] = $($e.Value) ($($e.Type))"
}
`;
}

/** Konfiguration aus einem deployten Skript zurueckparsen (fuer die Bearbeitung). */
function parseScript(scriptText) {
  const m = /\$entriesJson = '([\s\S]*?)'\r?\n/.exec(String(scriptText || ""));
  if (!m) return null;
  let entries;
  try { entries = JSON.parse(m[1].replace(/''/g, "'")); } catch (e) { return null; }
  return {
    entries: entries.map(x => ({ path: x.Path, name: x.Name, type: x.Type, value: x.Value }))
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
async function deployProfile(tenant, cert, { profileName, entries, groupIds }) {
  const name = SCRIPT_PREFIX + sanitizeProfileName(profileName);
  const scriptContent = Buffer.from(buildScript({ entries }), "utf8").toString("base64");
  const body = {
    "@odata.type": "#microsoft.graph.deviceManagementScript",
    displayName: name,
    description: "Registry-Richtlinie (HKLM) — generiert vom M365 Security Policy Manager. Laeuft als SYSTEM.",
    scriptContent,
    runAsAccount: "system",
    enforceSignatureCheck: false,
    fileName: "RegistryPolicy.ps1",
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

module.exports = { PRESETS, buildScript, parseScript, sanitizeEntries, sanitizeProfileName, listProfiles, deployProfile, SCRIPT_PREFIX };
