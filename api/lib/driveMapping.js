/**
 * Drive-Mapping-Konfigurator (Port des "Intune Drive Mapping Generator" von
 * Nicola Suter, nicolonsky/IntuneDriveMapping, MIT):
 *
 * Ansatz-Entscheidung: Der Generator erzeugt ein reines PowerShell-Plattform-
 * skript (SYSTEM legt einen Scheduled Task an, der bei jedem User-Logon die
 * Laufwerke mappt, inkl. optionalem On-Prem-AD-Gruppenfilter) — KEINE App-
 * Abhaengigkeit. Die Weatherlights-Alternative haengt am Microsoft Store
 * (Store for Business ist eingestellt) + ADMX-Ingestion und faellt damit raus.
 *
 * Wir betten das Original-Template ein (assets/intune/IntuneDriveMappingTemplate.ps1)
 * und patchen exakt die drei Stellen, die auch der Web-Generator patcht:
 * !INTUNEDRIVEMAPPINGJSON!, $searchRoot, $removeStaleDrives.
 *
 * Profile sind zustandslos: die Konfiguration lebt IM deployten Skript (als
 * JSON) und wird zum Bearbeiten wieder herausgeparst — genau wie beim
 * Original ("bestehendes Skript einlesen").
 */
const fs = require("fs");
const path = require("path");
const { graphReq, graphAllPages } = require("./graph");

const BETA = { beta: true, retryTransient: true };
const TEMPLATE_PATH = path.join(__dirname, "..", "assets", "intune", "IntuneDriveMappingTemplate.ps1");
const SCRIPT_PREFIX = "WIN - DriveMapping - ";

function sanitizeProfileName(name) {
  const n = String(name || "").trim().replace(/[^A-Za-z0-9 ._-]/g, "").slice(0, 40);
  if (!n) throw new Error("Ungueltiger Profilname.");
  return n;
}

/** Mappings validieren: Laufwerksbuchstabe, UNC-Pfad, optionales Label/Gruppenfilter. */
function sanitizeMappings(raw) {
  const list = Array.isArray(raw) ? raw : [];
  if (!list.length) throw new Error("Mindestens ein Laufwerk angeben.");
  const seen = new Set();
  return list.map((m, i) => {
    const letter = String(m.driveLetter || "").trim().toUpperCase().replace(/:$/, "");
    if (!/^[D-Z]$/.test(letter)) throw new Error(`Zeile ${i + 1}: Laufwerksbuchstabe muss D-Z sein.`);
    if (seen.has(letter)) throw new Error(`Laufwerksbuchstabe ${letter} ist doppelt.`);
    seen.add(letter);
    const p = String(m.path || "").trim();
    if (!/^\\\\[^\\]+\\.+/.test(p)) throw new Error(`Zeile ${i + 1}: Pfad muss ein UNC-Pfad sein (\\\\server\\share).`);
    return {
      Path: p,
      DriveLetter: letter,
      Label: String(m.label || "").trim().slice(0, 60),
      Id: i + 1,
      GroupFilter: String(m.groupFilter || "").trim() || null
    };
  });
}

/** Fertiges PowerShell-Skript aus der Konfiguration erzeugen (Template-Patch wie im Original). */
function buildScript({ mappings, searchRoot, removeStaleDrives }) {
  const template = fs.readFileSync(TEMPLATE_PATH, "utf8");
  const json = JSON.stringify(sanitizeMappings(mappings));
  let out = template.replace("!INTUNEDRIVEMAPPINGJSON!", json.replace(/'/g, "''"));
  if (searchRoot && String(searchRoot).trim()) {
    out = out.replace('$searchRoot = ""', `$searchRoot = "${String(searchRoot).trim().replace(/"/g, "")}"`);
  }
  if (removeStaleDrives) {
    out = out.replace("$removeStaleDrives = $false", "$removeStaleDrives = $true");
  }
  return out;
}

/** Konfiguration aus einem deployten Skript zurueckparsen (fuer die Bearbeitung). */
function parseScript(scriptText) {
  const m = /\$driveMappingJson = '([\s\S]*?)'\r?\n/.exec(String(scriptText || ""));
  if (!m) return null;
  let mappings;
  try { mappings = JSON.parse(m[1].replace(/''/g, "'")); } catch (e) { return null; }
  const sr = /\$searchRoot = "([^"]*)"/.exec(scriptText);
  return {
    mappings: mappings.map(x => ({ driveLetter: x.DriveLetter, path: x.Path, label: x.Label || "", groupFilter: x.GroupFilter || "" })),
    searchRoot: sr ? sr[1] : "",
    removeStaleDrives: /\$removeStaleDrives = \$true/.test(scriptText)
  };
}

/** Vorhandene DriveMapping-Profile (Skripte mit unserem Praefix) inkl. Zuweisungen + Konfiguration. */
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

/** Profil anlegen/aktualisieren (idempotent nach displayName) + Gruppen zuweisen (ersetzt Zuweisungen des Skripts). */
async function deployProfile(tenant, cert, { profileName, mappings, searchRoot, removeStaleDrives, groupIds }) {
  const name = SCRIPT_PREFIX + sanitizeProfileName(profileName);
  const scriptContent = Buffer.from(buildScript({ mappings, searchRoot, removeStaleDrives }), "utf8").toString("base64");
  const body = {
    "@odata.type": "#microsoft.graph.deviceManagementScript",
    displayName: name,
    description: "Netzlaufwerk-Mapping — generiert vom M365 Security Policy Manager (Vorlage: nicolonsky/IntuneDriveMapping). Laeuft als SYSTEM und registriert einen Logon-Task pro Benutzer.",
    scriptContent,
    runAsAccount: "system",
    enforceSignatureCheck: false,
    fileName: "DriveMapping.ps1",
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

module.exports = { buildScript, parseScript, sanitizeMappings, listProfiles, deployProfile, SCRIPT_PREFIX };
