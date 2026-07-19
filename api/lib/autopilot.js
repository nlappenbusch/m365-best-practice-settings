/**
 * Autopilot-Paket-Generator: erzeugt das Staging-Kit fuer Nils' Autopilot-
 * Use-Case (github.com/nlappenbusch/IntuneAutopilot) mit echten Tenant-/App-
 * Werten und den im Tenant konfigurierten GroupTags.
 *
 * - GroupTags werden aus den dynamischen Security Groups des Ziel-Tenants
 *   gelesen (membershipRule enthaelt "[OrderID]:<GroupTag>").
 * - Das Paket enthaelt Config-JSON (App-Reg mit Secret + Cert-Thumbprint),
 *   wrapper-config, den Run-Wrapper (mit Menue der gewaehlten GroupTags),
 *   das HWID-Community-Skript, Start-Batch, autounattend.xml, README und
 *   die Zertifikatsdateien (PFX + CER).
 */
const fs = require("fs");
const path = require("path");
const { graphReq, graphAllPages } = require("./graph");
const { buildZip } = require("./zip");

const ASSET_DIR = path.join(__dirname, "..", "assets", "autopilot");

// GroupTags aus einer dynamischen Mitgliedschaftsregel ziehen.
// Muster: [OrderID]:DEV-STD  (Nils' GroupTag-Konzept, via Autopilot OrderID)
function tagsFromRule(rule) {
  const out = [];
  const re = /\[OrderID\]:([A-Za-z0-9._-]+)/g;
  let m;
  while ((m = re.exec(String(rule || "")))) out.push(m[1]);
  return out;
}

/**
 * Dynamische Security Groups des Tenants laden und die konfigurierten GroupTags
 * extrahieren. Rueckgabe: [{ groupTag, groupId, groupName, rule }]
 */
async function loadGroupTags(tenant, certPemPath) {
  const groups = await graphAllPages(tenant, certPemPath,
    "/groups?$filter=groupTypes/any(c:c+eq+'DynamicMembership') and securityEnabled eq true&$select=id,displayName,membershipRule&$top=100", { beta: true });

  const seen = new Map(); // groupTag -> entry (erste Gruppe gewinnt)
  for (const g of groups) {
    for (const tag of tagsFromRule(g.membershipRule)) {
      if (!seen.has(tag)) {
        seen.set(tag, { groupTag: tag, groupId: g.id, groupName: g.displayName, rule: g.membershipRule || "" });
      }
    }
  }
  return [...seen.values()].sort((a, b) => a.groupTag.localeCompare(b.groupTag));
}

// PEM (Key+Cert) -> PFX-Buffer via pwsh ist aufwendig; wir liefern stattdessen
// den PEM-Inhalt und eine CER (nur Public). Den PFX erzeugt der Aufrufer aus
// dem selfsigned-Ergebnis (hat Key+Cert im Speicher).

/** JSON-Config im Format von IG-MgtTool-AutoApp_config.json. */
function buildConfigJson(o) {
  return JSON.stringify({
    config: {
      description: "Entra ID App Configuration for " + o.appName,
      version: "1.0",
      createdAt: o.createdAt,
      generatedBy: "M365 Security Policy Manager"
    },
    tenant: { domain: o.domain, id: o.tenantId, organization: o.domain },
    application: {
      objectId: o.appObjectId, applicationId: o.appId, name: o.appName,
      clientId: o.appId, servicePrincipalId: o.servicePrincipalId
    },
    credentials: {
      clientSecret: { displayName: o.appName + "-secret", expiresAt: o.secretExpiresAt, value: o.clientSecret },
      certificate: {
        subject: "CN=" + o.appName, thumbprint: o.certThumbprint,
        storeLocation: "CurrentUser\\My", expiresAt: o.certExpiresAt,
        files: {
          privateKey: { path: o.appName + "_private.pfx", format: "PFX", password: o.pfxPassword },
          publicKey: { path: o.appName + "_public.cer", format: "CER" }
        }
      }
    },
    authentication: {
      methods: [
        { type: "Certificate", primary: true, thumbprint: o.certThumbprint },
        { type: "ClientSecret", primary: false, secretValue: o.clientSecret }
      ]
    },
    adminConsent: {
      granted: o.consentOk === true,
      url: "https://login.microsoftonline.com/" + o.tenantId + "/adminconsent?client_id=" + o.appId,
      required: true
    },
    services: {
      microsoftGraph: {
        connectionMethod: "Certificate", enabled: true,
        parameters: { ClientId: o.appId, TenantId: o.tenantId, CertificateThumbprint: o.certThumbprint },
        sampleCommand: "Connect-MgGraph -ClientId " + o.appId + " -TenantId " + o.tenantId + " -CertificateThumbprint " + o.certThumbprint
      }
    },
    permissions: { microsoftGraph: { application: o.permissions.map(p => ({ name: p })) } }
  }, null, 4);
}

function buildWrapperConfig(groupTags, assign, reboot) {
  return JSON.stringify({
    GroupTag: groupTags[0] || "",
    OutputFolder: ".",
    AppConfigPath: "AutopilotApp_config.json",
    AutopilotScriptPath: "Get-WindowsAutopilotInfoCommunity.ps1",
    Assign: assign !== false,
    Reboot: reboot === true
  }, null, 2);
}

// Run-Wrapper mit interaktivem Menue der gewaehlten GroupTags (Variante aus
// dem IntuneAutopilot-Repo). Basiert auf Nils' Original, GroupTag-Array wird
// mit der Auswahl befuellt.
function buildRunScript(groupTags) {
  const arr = "@(" + groupTags.map(t => "\"" + t.replace(/"/g, "") + "\"").join(", ") + ")";
  return [
    "# Generiert vom M365 Security Policy Manager — Autopilot-Staging-Wrapper.",
    "# Liest AutopilotApp_config.json (App-only-Zugang) und importiert die HWID",
    "# nach Windows Autopilot; GroupTag wird interaktiv aus der Auswahl gewaehlt.",
    "if (-not $env:AP_WRAPPER_BYPASS_RELAUNCHED) {",
    "    if ((Get-ExecutionPolicy -Scope Process) -ne 'Bypass') {",
    "        $env:AP_WRAPPER_BYPASS_RELAUNCHED = '1'",
    "        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"$PSCommandPath\"",
    "        exit",
    "    }",
    "}",
    "Set-StrictMode -Version Latest",
    "$ErrorActionPreference = 'Stop'",
    "$BasePath = $PSScriptRoot",
    "$appCfg = Get-Content (Join-Path $BasePath 'AutopilotApp_config.json') -Raw | ConvertFrom-Json",
    "$TenantId  = $appCfg.tenant.id",
    "$AppId     = $appCfg.application.applicationId",
    "$AppSecret = $appCfg.authentication.methods | Where-Object { $_.type -eq 'ClientSecret' } | Select-Object -First 1 -ExpandProperty secretValue",
    "if ([string]::IsNullOrWhiteSpace($AppSecret)) { throw 'ClientSecret fehlt in der Config' }",
    "",
    "$availableGroupTags = " + arr,
    "Write-Host \"`n=== GroupTag Auswahl ===\" -ForegroundColor Cyan",
    "for ($i = 0; $i -lt $availableGroupTags.Count; $i++) { Write-Host \"  [$($i + 1)] $($availableGroupTags[$i])\" }",
    "do { $sel = (Read-Host \"`nIhre Auswahl (1-$($availableGroupTags.Count))\") -as [int] } while ($sel -lt 1 -or $sel -gt $availableGroupTags.Count)",
    "$GroupTag = $availableGroupTags[$sel - 1]",
    "Write-Host \"Gewaehlter GroupTag: $GroupTag`n\" -ForegroundColor Green",
    "",
    "try { $serial = (Get-CimInstance -Class Win32_BIOS).SerialNumber } catch { $serial = $env:COMPUTERNAME }",
    "if ([string]::IsNullOrWhiteSpace($serial)) { $serial = $env:COMPUTERNAME }",
    "$csvPath = Join-Path $BasePath (\"HWID-$serial-\" + (Get-Date).ToString('yyyy-MM-dd') + '.csv')",
    "$assign = $true; if ($null -ne $appCfg.PSObject.Properties['Assign']) { $assign = [bool]$appCfg.Assign }",
    "",
    "$splat = @{ Online = $true; GroupTag = $GroupTag; OutputFile = $csvPath; TenantId = $TenantId; AppId = $AppId; AppSecret = $AppSecret }",
    "if ($assign) { $splat['Assign'] = $true }",
    "Write-Host 'Starte Autopilot-Import...'",
    "& { Set-StrictMode -Off; & (Join-Path $BasePath 'Get-WindowsAutopilotInfoCommunity.ps1') @splat }",
    "Write-Host \"Fertig. HWID-CSV: $csvPath\""
  ].join("\r\n");
}

/**
 * Baut das ZIP. opts enthaelt die App-Werte (aus der Registrierung) + Auswahl.
 * pfxBuffer/cerBuffer: die Zertifikatsdateien (Buffer), koennen null sein.
 */
function buildAutopilotZip(opts) {
  const readAsset = (name) => fs.readFileSync(path.join(ASSET_DIR, name));

  const entries = [
    { name: "AutopilotApp_config.json", data: buildConfigJson(opts) },
    { name: "wrapper-config.json", data: buildWrapperConfig(opts.groupTags, opts.assign, opts.reboot) },
    { name: "Run-AutopilotWithExternalAppConfig.ps1", data: buildRunScript(opts.groupTags) },
    { name: "Get-WindowsAutopilotInfoCommunity.ps1", data: readAsset("Get-WindowsAutopilotInfoCommunity.ps1") },
    { name: "Start-Autopilot.bat", data: readAsset("Start-Autopilot.bat") },
    { name: "autounattend.xml", data: readAsset("autounattend.xml") },
    { name: "Build-Windows11-WIM-NetFx3.ps1", data: readAsset("Build-Windows11-WIM-NetFx3.ps1") },
    { name: "README-Autopilot.md", data: readAsset("README-Autopilot.md") }
  ];
  if (opts.pfxBuffer) entries.push({ name: opts.appName + "_private.pfx", data: opts.pfxBuffer });
  if (opts.cerBuffer) entries.push({ name: opts.appName + "_public.cer", data: opts.cerBuffer });

  return buildZip(entries);
}

/**
 * Windows-Autopilot-Deployment-Profile inkl. Assignments laden.
 * Rueckgabe: [{ id, displayName, ..., assignments: [{ groupId, label }] }]
 */
async function loadAutopilotProfiles(tenant, certPemPath) {
  const beta = { beta: true };
  const profiles = await graphAllPages(tenant, certPemPath,
    "/deviceManagement/windowsAutopilotDeploymentProfiles?$expand=assignments&$top=50", beta);

  // Gruppennamen der zugewiesenen Gruppen aufloesen (dedupliziert)
  const ids = new Set();
  for (const p of profiles) for (const a of (p.assignments || [])) {
    const gid = a && a.target && a.target.groupId;
    if (gid) ids.add(gid);
  }
  const names = new Map();
  for (const gid of ids) {
    try {
      const g = await graphReq(tenant, certPemPath, "GET", `/groups/${gid}?$select=displayName`);
      names.set(gid, g.displayName);
    } catch (e) { names.set(gid, gid); }
  }

  return profiles.map(p => ({
    id: p.id,
    displayName: p.displayName,
    description: p.description || "",
    deviceNameTemplate: p.deviceNameTemplate || "",
    language: p.language || p.locale || "",
    hybridAzureADJoinSkipConnectivityCheck: p.hybridAzureADJoinSkipConnectivityCheck,
    outOfBoxExperienceSettings: p.outOfBoxExperienceSettings || null,
    "@odata.type": p["@odata.type"] || "",
    assignments: (p.assignments || []).map(a => {
      const type = String((a.target && a.target["@odata.type"]) || "");
      const gid = a.target && a.target.groupId;
      const label = /allDevices/i.test(type) ? "Alle Geräte"
        : gid ? (names.get(gid) || gid)
        : type.replace("#microsoft.graph.", "");
      return { groupId: gid || null, label, exclusion: /exclusion/i.test(type) };
    })
  }));
}

/** Autopilot-Profil einer Gruppe zuweisen (Merge, bestehende bleiben). */
async function assignProfileToGroup(tenant, certPemPath, profileId, groupId) {
  const beta = { beta: true };
  const cur = await graphReq(tenant, certPemPath, "GET",
    `/deviceManagement/windowsAutopilotDeploymentProfiles/${profileId}/assignments`, null, beta);
  const existing = cur.value || [];
  if (existing.some(a => a.target && a.target.groupId === groupId)) return "skipped";

  await graphReq(tenant, certPemPath, "POST",
    `/deviceManagement/windowsAutopilotDeploymentProfiles/${profileId}/assignments`, {
      target: { "@odata.type": "#microsoft.graph.groupAssignmentTarget", groupId }
    }, beta);
  return "assigned";
}

module.exports = { loadGroupTags, buildAutopilotZip, tagsFromRule, loadAutopilotProfiles, assignProfileToGroup };
