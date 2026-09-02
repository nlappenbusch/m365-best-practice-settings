"use strict";
/**
 * Remediations (Intune > Geraete > Skripts und Wartung > Wartungen).
 *
 * Ein Paar aus Erkennungs- und Behebungsskript, das wiederkehrend laeuft: Das
 * Erkennungsskript meldet mit Exit-Code 1 "muss reparieren werden", worauf
 * Intune das Behebungsskript startet. Genau das ist der Unterschied zu einem
 * Plattformskript (lib/registryPolicy.js): Ein Plattformskript laeuft einmal;
 * setzt ein Windows-Update den Zustand zurueck, merkt das niemand.
 *
 * Graph (beta):
 *   GET/POST /deviceManagement/deviceHealthScripts
 *   POST     /deviceManagement/deviceHealthScripts/{id}/assign
 * Permission: DeviceManagementConfiguration.ReadWrite.All (hat das Tool bereits).
 *
 * ✋ Voraussetzung im Tenant, die es NICHT per API gibt: Intune >
 * Mandantenadministration > Connectors und Token > Windows-Daten, Schalter
 * "Ich bestaetige, dass mein Mandant eine dieser Lizenzen besitzt" auf Ein
 * (Vorgabe: Aus). Ohne ihn laesst sich das Skriptpaar zwar anlegen, es laeuft
 * aber nie. Deshalb steht der Punkt in der Onboarding-Checkliste und wird in
 * der Oberflaeche vor dem Ausrollen genannt.
 */
const { graphReq, graphAllPages } = require("./graph");
const NAMING = require("./naming");

const BETA = { beta: true, retryTransient: true };
const PATH = "/deviceManagement/deviceHealthScripts";
const NAME_KIND = "remediation";
const NAME_SEP = "\u0001";

function knownPrefixes(tenant) {
  return NAMING.candidates(NAME_KIND, { name: NAME_SEP }, tenant && tenant.id)
    .map(c => c.split(NAME_SEP)[0])
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
}
function displayNameFor(tenant, name) {
  return NAMING.name(NAME_KIND, { name: sanitizeName(name) }, tenant && tenant.id);
}
function isOurs(tenant, displayName) {
  const n = String(displayName || "");
  return knownPrefixes(tenant).some(p => n.startsWith(p));
}

function sanitizeName(name) {
  const n = String(name || "").trim().replace(/[^A-Za-z0-9 ._-]/g, "").slice(0, 40);
  if (!n) throw Object.assign(new Error("Ungültiger Name für die Wartung."), { status: 400 });
  return n;
}

// ---------------------------------------------------------------- Katalog
/**
 * Fertige, in der Praxis gepruefte Paare. Der Katalog ist bewusst klein: Jede
 * Vorlage hier ist eine, die bei mehreren Kunden gleich gebraucht wird. Alles
 * Einmalige gehoert als eigene Wartung ins Portal, nicht in dieses Repository.
 */
const KATALOG = [
  {
    key: "sso-hinweis-ch",
    name: "SSO-Hinweis",
    label: "SSO-Anmeldeaufforderung unterdrücken (Schweiz)",
    beschreibung:
      "Windows blendet regionsabhängig einen SSO-Hinweis ein. Gesteuert wird das über " +
      "C:\\Windows\\System32\\IntegratedServicesRegionPolicySet.json: Steht CH in der „disabled“-Regionenliste " +
      "der Policy {1d290cdb-499c-4d42-938a-9b8dceffe998}, greift die Anzeige für die Schweiz. Die Wartung nimmt " +
      "Besitz und Berechtigungen der Datei (sie ist TrustedInstaller-geschützt) und entfernt CH aus der Liste.",
    warum:
      "Als wiederkehrende Wartung und nicht als Einmal-Skript, weil Windows-Updates die Datei zurücksetzen — " +
      "die Erkennung merkt den Rückfall und repariert erneut.",
    runAs32Bit: false,
    detection: [
      "# Detection Script for Proactive Remediation",
      '$filePath = "C:\\Windows\\System32\\IntegratedServicesRegionPolicySet.json"',
      "if (-not (Test-Path $filePath)) {",
      '    Write-Host "File does not exist."',
      "    exit 0",
      "}",
      "try {",
      "    $jsonContent = Get-Content -Path $filePath -Raw | ConvertFrom-Json",
      "    foreach ($policy in $jsonContent.policies) {",
      '        if ($policy.guid -eq "{1d290cdb-499c-4d42-938a-9b8dceffe998}") {',
      '            if ($policy.conditions.region.disabled -contains "CH") {',
      '                Write-Host "\'CH\' is still in the disabled list. Remediation required."',
      "                exit 1",
      "            }",
      "        }",
      "    }",
      '    Write-Host "\'CH\' is not in the disabled list. No remediation needed."',
      "    exit 0",
      "} catch {",
      '    Write-Host "Error reading JSON: $_"',
      "    exit 1",
      "}"
    ].join("\r\n"),
    remediation: [
      '$filePath = "C:\\Windows\\System32\\IntegratedServicesRegionPolicySet.json"',
      "if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()",
      '    ).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")) {',
      '    Write-Host "Administrative rights are required." -ForegroundColor Red; exit 1',
      "}",
      'if (-not (Test-Path $filePath)) { Write-Host "Target file not found: $filePath" -ForegroundColor Red; exit 1 }',
      "",
      "# 1) Besitz an Administratoren uebertragen",
      "takeown /F $filePath /A",
      'if (-not ((Get-Acl $filePath).Owner -like "*Administrators")) { Write-Host "Ownership update failed." -ForegroundColor Red; exit 1 }',
      "",
      "# 2) Vollzugriff fuer Administratoren",
      "icacls $filePath /grant:r Administrators:F /C",
      "$acl = Get-Acl $filePath",
      'if (-not ($acl.Access | Where-Object { $_.IdentityReference -like "*Administrators" -and $_.FileSystemRights -eq "FullControl" })) {',
      '    Write-Host "Permission update unsuccessful." -ForegroundColor Red; exit 1',
      "}",
      "",
      "# 3) CH aus der disabled-Liste entfernen und speichern",
      "try {",
      "    $jsonContent = Get-Content -Path $filePath -Raw | ConvertFrom-Json",
      "    foreach ($policy in $jsonContent.policies) {",
      '        if ($policy.guid -eq "{1d290cdb-499c-4d42-938a-9b8dceffe998}") {',
      '            $policy.conditions.region.disabled = $policy.conditions.region.disabled | Where-Object { $_ -ne "CH" }',
      "        }",
      "    }",
      "    $jsonContent | ConvertTo-Json -Depth 10 | Set-Content -Path $filePath -Force -Encoding UTF8",
      '    Write-Host "Configuration successfully updated." -ForegroundColor Green',
      "    exit 0",
      "} catch {",
      '    Write-Host "Error while updating: $_" -ForegroundColor Red',
      "    exit 1",
      "}"
    ].join("\r\n")
  }
];

function katalogEintrag(key) {
  const hit = KATALOG.find(k => k.key === key);
  if (!hit) throw Object.assign(new Error("Unbekannte Vorlage: " + key), { status: 400 });
  return hit;
}

/** Katalog fuer die Oberflaeche — ohne die Skriptinhalte, die sind lang. */
function katalogUebersicht() {
  return KATALOG.map(k => ({
    key: k.key, name: k.name, label: k.label, beschreibung: k.beschreibung, warum: k.warum,
    zeilenDetection: k.detection.split(/\r?\n/).length,
    zeilenRemediation: k.remediation.split(/\r?\n/).length
  }));
}

/** Skripttexte einer Vorlage — fuer die Vorschau, bevor irgendetwas ausgerollt wird. */
function katalogSkripte(key) {
  const k = katalogEintrag(key);
  return { key: k.key, detection: k.detection, remediation: k.remediation };
}

// ---------------------------------------------------------------- Lesen
/**
 * Vorhandene Wartungen des Tenants. Die vom Tool angelegten sind an ihrem
 * Namen erkennbar (ueber ALLE bekannten Praefixe, damit ein Schemawechsel
 * nicht dazu fuehrt, dass daneben ein zweites Objekt entsteht).
 */
async function list(tenant, certPemPath) {
  const alle = await graphAllPages(tenant, certPemPath,
    `${PATH}?$select=id,displayName,description,publisher,runAsAccount,runAs32Bit,enforceSignatureCheck,lastModifiedDateTime&$top=50`, BETA);

  const out = [];
  for (const s of alle) {
    let zuweisungen = [];
    try {
      const r = await graphReq(tenant, certPemPath, "GET", `${PATH}/${s.id}/assignments`, null, BETA);
      zuweisungen = (r.value || []).map(a => ({
        groupId: (a.target && a.target.groupId) || null,
        typ: String((a.target || {})["@odata.type"] || "").replace("#microsoft.graph.", ""),
        remediationLaeuft: a.runRemediationScript !== false
      }));
    } catch (e) { /* Zuweisungen sind Zusatzinfo, kein Grund die Liste zu kippen */ }

    out.push({
      id: s.id,
      displayName: s.displayName,
      description: s.description || "",
      publisher: s.publisher || "",
      runAsAccount: s.runAsAccount || null,
      runAs32Bit: !!s.runAs32Bit,
      enforceSignatureCheck: !!s.enforceSignatureCheck,
      geaendert: s.lastModifiedDateTime || null,
      unsere: isOurs(tenant, s.displayName),
      zuweisungen
    });
  }
  return out.sort((a, b) => String(a.displayName).localeCompare(String(b.displayName)));
}

// ---------------------------------------------------------------- Ausrollen
/**
 * Eine Vorlage ausrollen: anlegen oder aktualisieren, danach den Gerätegruppen
 * zuweisen.
 *
 * Zwei bewusste Festlegungen, die zur Wissensbasis passen:
 *  - runAsAccount "system", enforceSignatureCheck false, runAs32Bit false —
 *    genau die Werte aus dem Deployment-Abschnitt (Kap. 9.9).
 *  - Zuweisung IMMER direkt an die dynamische GroupTag-Gerätegruppe. Intune
 *    loest verschachtelte Gruppen nur beim App-Assignment auf; eine Wartung auf
 *    einer App-Zielgruppe erreicht ueber das Nesting kein einziges Geraet.
 */
async function deployKatalog(tenant, certPemPath, { key, groupIds, taeglich }) {
  const vorlage = katalogEintrag(key);
  const ids = (Array.isArray(groupIds) ? groupIds : []).filter(Boolean);
  if (!ids.length) {
    throw Object.assign(new Error("Mindestens eine Gerätegruppe auswählen — eine Wartung ohne Zuweisung läuft nirgends."), { status: 400 });
  }

  const displayName = displayNameFor(tenant, vorlage.name);
  const b64 = s => Buffer.from(s, "utf8").toString("base64");

  const body = {
    "@odata.type": "#microsoft.graph.deviceHealthScript",
    displayName,
    description: vorlage.label + " — angelegt vom M365 Security Policy Manager.",
    publisher: "igeeks AG",
    detectionScriptContent: b64(vorlage.detection),
    remediationScriptContent: b64(vorlage.remediation),
    runAsAccount: "system",
    enforceSignatureCheck: false,
    runAs32Bit: !!vorlage.runAs32Bit
  };

  // Vorhandenes Objekt unter ALLEN bekannten Namensschemata suchen, sonst legt
  // ein Schemawechsel eine zweite Wartung neben die bestehende.
  const vorhanden = await list(tenant, certPemPath);
  const namen = NAMING.candidates(NAME_KIND, { name: vorlage.name }, tenant && tenant.id).map(n => n.toLowerCase());
  const treffer = vorhanden.find(s => namen.includes(String(s.displayName).toLowerCase()));

  let scriptId;
  if (treffer) {
    await graphReq(tenant, certPemPath, "PATCH", `${PATH}/${treffer.id}`, body, BETA);
    scriptId = treffer.id;
  } else {
    const created = await graphReq(tenant, certPemPath, "POST", PATH, body, BETA);
    scriptId = created.id;
  }

  // Taeglich um 03:00 lokal ist die Voreinstellung: haeufig genug, um einen
  // Rueckfall nach einem Update zeitnah zu fangen, und ausserhalb der Arbeitszeit.
  const runSchedule = taeglich === false ? null : {
    "@odata.type": "#microsoft.graph.deviceHealthScriptDailySchedule",
    interval: 1,
    time: "03:00:00.0000000",
    useUtc: false
  };

  await graphReq(tenant, certPemPath, "POST", `${PATH}/${scriptId}/assign`, {
    deviceHealthScriptAssignments: ids.map(groupId => ({
      target: { "@odata.type": "#microsoft.graph.groupAssignmentTarget", groupId },
      runRemediationScript: true,
      ...(runSchedule ? { runSchedule } : {})
    }))
  }, BETA);

  return { scriptId, displayName, aktualisiert: !!treffer, gruppen: ids.length };
}

module.exports = {
  KATALOG, katalogUebersicht, katalogSkripte, katalogEintrag,
  list, deployKatalog, displayNameFor, isOurs, sanitizeName, PATH
};
