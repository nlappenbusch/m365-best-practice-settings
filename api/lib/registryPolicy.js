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
const NAMING = require("./naming");

// Die Objektnamen kommen aus der Namenskonvention (lib/naming.js). Gesucht wird
// ueber ALLE bekannten Praefixe -- sonst findet das Tool nach einem
// Schemawechsel die eigenen Objekte nicht mehr und legt daneben neue an.
const NAME_KIND = "scriptRegistry";
const NAME_SEP = "\u0001";

function knownPrefixes(tenant) {
  return NAMING.candidates(NAME_KIND, { name: NAME_SEP }, tenant && tenant.id)
    .map(c => c.split(NAME_SEP)[0])
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
}
function displayNameFor(tenant, profileName) {
  return NAMING.name(NAME_KIND, { name: sanitizeProfileName(profileName) }, tenant && tenant.id);
}
function isOurs(tenant, displayName) {
  const n = String(displayName || "");
  return knownPrefixes(tenant).some(p => n.startsWith(p));
}
function profileNameFrom(tenant, displayName) {
  const n = String(displayName || "");
  for (const p of knownPrefixes(tenant)) { if (n.startsWith(p)) return n.slice(p.length); }
  return n;
}

// ---------- Bitwarden-Client-Konfiguration ----------
// Die Bitwarden-Browsererweiterung liest ihre Server-Umgebung aus der
// 3rdparty-Extension-Policy des Browsers. Drei Pfade, weil es drei reale
// Installationswege gibt: Chrome, Edge mit der Edge-Add-ons-ID und Edge mit der
// Chrome-ID (wer die Erweiterung in Edge aus dem Chrome Web Store installiert,
// behaelt dort die Chrome-ID). Ueberfluessige Pfade schaden nicht -- sie stehen
// dann einfach in einer Registry-Struktur, die kein Browser liest.
// Quelle: Bitwarden-Doku "Connect Managed Devices".
//
// ACHTUNG, haeufiges Missverstaendnis: das gilt NUR fuer die Browsererweiterung.
// Die Desktop-App liest ihre Region aus einer data.json im Benutzerprofil, die
// erst beim ersten Start entsteht -- die ist so nicht vorgebbar.
const BITWARDEN_EXTENSION_IDS = {
  chrome: "nngceckbapebfimnlniiiahkandclblb",
  edge: "jbkfoedolllekgbhcbcoahefnbanhhlh"
};

const BITWARDEN_POLICY_PATHS = [
  `SOFTWARE\\Policies\\Google\\Chrome\\3rdparty\\extensions\\${BITWARDEN_EXTENSION_IDS.chrome}\\policy\\environment`,
  `SOFTWARE\\Policies\\Microsoft\\Edge\\3rdparty\\extensions\\${BITWARDEN_EXTENSION_IDS.edge}\\policy\\environment`,
  `SOFTWARE\\Policies\\Microsoft\\Edge\\3rdparty\\extensions\\${BITWARDEN_EXTENSION_IDS.chrome}\\policy\\environment`
];

// US ist Bitwardens Vorgabe -- dafuer braucht es kein Profil. Es steht hier
// trotzdem, damit ein Tenant, der versehentlich auf EU gestellt wurde, ohne
// Handarbeit zurueckgeholt werden kann.
const BITWARDEN_REGIONS = {
  eu: { key: "eu", label: "EU-Cloud (vault.bitwarden.eu)", base: "https://vault.bitwarden.eu", notifications: "https://notifications.bitwarden.eu" },
  us: { key: "us", label: "US-Cloud (vault.bitwarden.com)", base: "https://vault.bitwarden.com", notifications: "https://notifications.bitwarden.com" }
};

/** https-URL ohne Pfad-Schnickschnack -- landet als Registry-String auf Geraeten. */
function cleanBitwardenUrl(raw, label) {
  const v = String(raw || "").trim().replace(/\/+$/, "");
  if (!v) throw new Error(`${label} fehlt.`);
  let u;
  try { u = new URL(v); } catch (e) { throw new Error(`${label} ist keine gueltige URL.`); }
  if (u.protocol !== "https:") throw new Error(`${label} muss mit https:// beginnen.`);
  return v;
}

/**
 * Registry-Zeilen fuer die Server-Umgebung der Bitwarden-Browsererweiterung.
 * region: "eu" | "us" | "selfhost". Bei selfhost kommt base aus der Eingabe,
 * notifications ist dort optional (Bitwarden faellt sonst auf base zurueck).
 */
function bitwardenExtensionEntries({ region, base, notifications }) {
  const preset = BITWARDEN_REGIONS[region];
  if (!preset && region !== "selfhost") throw new Error(`Unbekannte Bitwarden-Region '${region}'.`);
  const b = cleanBitwardenUrl(preset ? preset.base : base, "Server-URL");
  const n = preset ? preset.notifications : (notifications ? cleanBitwardenUrl(notifications, "Notifications-URL") : null);
  return BITWARDEN_POLICY_PATHS.flatMap(path => [
    { path, name: "base", type: "String", value: b },
    ...(n ? [{ path, name: "notifications", type: "String", value: n }] : [])
  ]);
}

// Bewusst NICHT als Vorlage enthalten: OneDrive-Autoanmeldung und Known
// Folder Move. Die OpenIntuneBaseline deckt beides bereits vollstaendig ab
// ("Win - OIB - SC - Microsoft OneDrive - D/U - Configuration"): SilentAccountConfig,
// KFMOptInNoWizard (mit %OrganizationId%, das Intune selbst ersetzt), KFMBlockOptOut,
// FilesOnDemandEnabled, dazu DisablePersonalSync in der Benutzer-Policy. Eine
// zweite Quelle fuer dieselben HKLM-Werte waere Drift mit Ansage — wer zuletzt
// laeuft, gewinnt. Stattdessen die beiden OIB-Policies zuweisen (Tab Intune).
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
    entries: bitwardenExtensionEntries({ region: "eu" })
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
    // "Computer\HKEY_LOCAL_MACHINE\..." ist genau das, was regedit beim
    // Kopieren eines Schluessels liefert. Ohne dieses Abschneiden bestuende
    // der Pfad die Zeichenpruefung und landete still unter
    // HKLM:\HKEY_LOCAL_MACHINE\... — ein Wert, den nie jemand liest.
    const p = String(e.path || "").trim()
      .replace(/^Computer\\/i, "")
      .replace(/^(HKEY_LOCAL_MACHINE|HKLM):?\\?/i, "")
      .replace(/\\+$/, "");
    if (!p) throw new Error(`Zeile ${i + 1}: Registry-Pfad fehlt.`);
    if (!PATH_RE.test(p)) throw new Error(`Zeile ${i + 1}: Registry-Pfad enthaelt unerlaubte Zeichen: ${p}`);
    const name = String(e.name || "").trim();
    if (!name) throw new Error(`Zeile ${i + 1}: Name des Werts fehlt.`);
    if (!NAME_RE.test(name)) throw new Error(`Zeile ${i + 1}: Name des Werts enthaelt unerlaubte Zeichen: ${name}`);
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
  const ours = scripts.filter(s => isOurs(tenant, s.displayName));
  const result = [];
  for (const s of ours) {
    let full = s, assignments = [];
    try { full = await graphReq(tenant, cert, "GET", `/deviceManagement/deviceManagementScripts/${s.id}`, null, BETA); } catch (e) { /* Kopf reicht */ }
    try { assignments = (await graphReq(tenant, cert, "GET", `/deviceManagement/deviceManagementScripts/${s.id}/assignments`, null, BETA)).value || []; } catch (e) { /* egal */ }
    const content = full.scriptContent ? Buffer.from(full.scriptContent, "base64").toString("utf8") : "";
    result.push({
      id: s.id,
      profileName: profileNameFrom(tenant, s.displayName),
      displayName: s.displayName,
      config: parseScript(content),
      groupIds: assignments.map(a => a && a.target && a.target.groupId).filter(Boolean)
    });
  }
  return result;
}

/** Profil anlegen/aktualisieren (idempotent nach displayName) + Gruppen zuweisen. */
async function deployProfile(tenant, cert, { profileName, entries, groupIds }) {
  const name = displayNameFor(tenant, profileName);
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

module.exports = { PRESETS, buildScript, parseScript, sanitizeEntries, sanitizeProfileName, listProfiles, deployProfile, SCRIPT_PREFIX,
  BITWARDEN_REGIONS, BITWARDEN_POLICY_PATHS, bitwardenExtensionEntries };
