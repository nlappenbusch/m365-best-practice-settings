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
const { XMLParser } = require("fast-xml-parser");

function xmlEsc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// Name/SSID aus einem netsh-exportierten WLAN-Profil ziehen.
function parseWlanProfile(xml) {
  try {
    const p = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true });
    const doc = p.parse(String(xml));
    const wp = doc.WLANProfile || {};
    const name = wp.name || (wp.SSIDConfig && wp.SSIDConfig.SSID && wp.SSIDConfig.SSID.name) || "";
    const ssid = (wp.SSIDConfig && wp.SSIDConfig.SSID && wp.SSIDConfig.SSID.name) || name;
    return { name: String(name).trim(), ssid: String(ssid).trim() };
  } catch (e) {
    const m = String(xml).match(/<name>\s*([^<]+?)\s*<\/name>/i);
    return { name: m ? m[1].trim() : "", ssid: m ? m[1].trim() : "" };
  }
}

/**
 * Generiert die autounattend.xml fuer den Autopilot-Use-Case.
 * Vorgaben: deutsche UI (de-DE), Schweizer Locale/Tastatur (de-CH),
 * automatische Partitionierung, EULA automatisch, KEIN AutoLogon
 * (Anmeldung mit M365-User via Autopilot user-driven), optionales WLAN
 * (persistent, Passwort bleibt gespeichert).
 */
function buildAutounattend(opts) {
  opts = opts || {};
  const wlan = opts.wlanProfileXml ? parseWlanProfile(opts.wlanProfileXml) : null;

  // WLAN-Bausteine (specialize) nur wenn ein Profil hochgeladen wurde
  const wlanSpecialize = wlan ? [
    '  <settings pass="specialize">',
    '    <component name="Microsoft-Windows-Deployment" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">',
    '      <RunSynchronous>',
    '        <RunSynchronousCommand wcm:action="add">',
    '          <Order>1</Order>',
    "          <Path>powershell.exe -NoProfile -Command \"$x=[xml]::new(); $x.Load('C:\\Windows\\Panther\\unattend.xml'); $sb=[scriptblock]::Create($x.unattend.Extensions.ExtractScript); Invoke-Command -ScriptBlock $sb -ArgumentList $x;\"</Path>",
    '        </RunSynchronousCommand>',
    '        <RunSynchronousCommand wcm:action="add">',
    '          <Order>2</Order>',
    '          <Path>powershell.exe -ExecutionPolicy Unrestricted -NoProfile -File "C:\\Windows\\Setup\\Scripts\\Specialize.ps1"</Path>',
    '        </RunSynchronousCommand>',
    '      </RunSynchronous>',
    '    </component>',
    '  </settings>'
  ].join("\r\n") : '  <settings pass="specialize"></settings>';

  const wlanExtensions = wlan ? [
    '  <Extensions xmlns="https://schneegans.de/windows/unattend-generator/">',
    '    <ExtractScript>',
    'param([xml] $Document);',
    'foreach( $file in $Document.unattend.Extensions.File ) {',
    "  $path = [System.Environment]::ExpandEnvironmentVariables( $file.GetAttribute('path') );",
    "  mkdir -Path ( $path | Split-Path -Parent ) -ErrorAction 'SilentlyContinue';",
    '  [System.IO.File]::WriteAllBytes( $path, [System.Text.Encoding]::UTF8.GetPreamble() + [System.Text.Encoding]::UTF8.GetBytes( $file.InnerText.Trim() ) );',
    '}',
    '    </ExtractScript>',
    '    <File path="C:\\Windows\\Setup\\Scripts\\Wifi.xml">',
    xmlEsc(String(opts.wlanProfileXml).replace(/<\?xml[^>]*\?>/i, "").trim()),
    '    </File>',
    '    <File path="C:\\Windows\\Setup\\Scripts\\Specialize.ps1">',
    xmlEsc([
      '# WLAN-Profil dauerhaft (user=all) hinzufuegen und verbinden — Passwort bleibt gespeichert.',
      'netsh.exe wlan add profile filename="C:\\Windows\\Setup\\Scripts\\Wifi.xml" user=all',
      'netsh.exe wlan connect name="' + wlan.name.replace(/"/g, "") + '" ssid="' + wlan.ssid.replace(/"/g, "") + '"',
      '# Wifi.xml bewusst NICHT loeschen — Profil/Passwort bleiben erhalten.'
    ].join("\r\n")),
    '    </File>',
    '  </Extensions>'
  ].join("\r\n") : "";

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<unattend xmlns="urn:schemas-microsoft-com:unattend" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">',
    '  <!-- Generiert vom M365 Security Policy Manager (Autopilot user-driven).',
    '       Deutsche UI (de-DE), Schweizer Locale/Tastatur (de-CH), automatische Partitionierung,',
    '       EULA automatisch, KEIN AutoLogon (Anmeldung mit M365-User).' + (wlan ? ' WLAN: ' + xmlEsc(wlan.name) + ' (persistent).' : ' Kein WLAN eingebettet.') + ' -->',
    '  <settings pass="offlineServicing"></settings>',
    '  <settings pass="windowsPE">',
    '    <component name="Microsoft-Windows-International-Core-WinPE" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">',
    '      <UILanguage>de-DE</UILanguage>',
    '    </component>',
    '    <component name="Microsoft-Windows-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">',
    '      <ImageInstall><OSImage><InstallTo><DiskID>0</DiskID><PartitionID>3</PartitionID></InstallTo></OSImage></ImageInstall>',
    '      <UserData>',
    '        <ProductKey><Key>VK7JG-NPHTM-C97JM-9MPGT-3V66T</Key><WillShowUI>OnError</WillShowUI></ProductKey>',
    '        <AcceptEula>true</AcceptEula>',
    '      </UserData>',
    '      <UseConfigurationSet>false</UseConfigurationSet>',
    '      <RunSynchronous>',
    '        <RunSynchronousCommand wcm:action="add"><Order>1</Order><Path>cmd.exe /c "&gt;&gt;"X:\\diskpart.txt" (echo:SELECT DISK=0&amp;echo:CLEAN&amp;echo:CONVERT GPT&amp;echo:CREATE PARTITION EFI SIZE=300&amp;echo:FORMAT QUICK FS=FAT32 LABEL=^"System^"&amp;echo:ASSIGN LETTER=S&amp;echo:CREATE PARTITION MSR SIZE=16&amp;echo:CREATE PARTITION PRIMARY)"</Path></RunSynchronousCommand>',
    '        <RunSynchronousCommand wcm:action="add"><Order>2</Order><Path>cmd.exe /c "&gt;&gt;"X:\\diskpart.txt" (echo:SHRINK MINIMUM=1000&amp;echo:FORMAT QUICK FS=NTFS LABEL=^"Windows^"&amp;echo:ASSIGN LETTER=W&amp;echo:CREATE PARTITION PRIMARY&amp;echo:FORMAT QUICK FS=NTFS LABEL=^"Recovery^"&amp;echo:ASSIGN LETTER=R)"</Path></RunSynchronousCommand>',
    '        <RunSynchronousCommand wcm:action="add"><Order>3</Order><Path>cmd.exe /c "&gt;&gt;"X:\\diskpart.txt" (echo:SET ID=^"de94bba4-06d1-4d40-a16a-bfd50179d6ac^"&amp;echo:GPT ATTRIBUTES=0x8000000000000001)"</Path></RunSynchronousCommand>',
    '        <RunSynchronousCommand wcm:action="add"><Order>4</Order><Path>cmd.exe /c "diskpart.exe /s "X:\\diskpart.txt" &gt;&gt;"X:\\diskpart.log" || ( type "X:\\diskpart.log" &amp; echo diskpart encountered an error. &amp; pause &amp; exit /b 1 )"</Path></RunSynchronousCommand>',
    '      </RunSynchronous>',
    '    </component>',
    '  </settings>',
    '  <settings pass="generalize"></settings>',
    wlanSpecialize,
    '  <settings pass="auditSystem"></settings>',
    '  <settings pass="auditUser"></settings>',
    '  <settings pass="oobeSystem">',
    '    <component name="Microsoft-Windows-International-Core" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">',
    '      <InputLocale>0807:00000807</InputLocale>',
    '      <SystemLocale>de-CH</SystemLocale>',
    '      <UILanguage>de-DE</UILanguage>',
    '      <UserLocale>de-CH</UserLocale>',
    '    </component>',
    '    <component name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">',
    '      <OOBE>',
    '        <ProtectYourPC>3</ProtectYourPC>',
    '        <HideEULAPage>true</HideEULAPage>',
    '        <HideOnlineAccountScreens>false</HideOnlineAccountScreens>',
    '      </OOBE>',
    '    </component>',
    '  </settings>',
    wlanExtensions,
    '</unattend>'
  ].filter(Boolean).join("\r\n");
}

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
    // autounattend dynamisch: deutsche UI, kein AutoLogon, WLAN aus Upload (persistent)
    { name: "autounattend.xml", data: buildAutounattend({ wlanProfileXml: opts.wlanProfileXml }) },
    { name: "Export-WlanProfile.ps1", data: readAsset("Export-WlanProfile.ps1") },
    { name: "Export-WlanProfile.bat", data: readAsset("Export-WlanProfile.bat") },
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

/**
 * Autopilot-Deployment-Profil anlegen.
 *
 * Voreinstellungen entsprechen dem, was bei unseren Kunden ohnehin eingestellt
 * wird: user-driven Entra-Join, deutschsprachige OOBE, Datenschutz- und
 * EULA-Seite uebersprungen, Standardbenutzer (kein lokaler Admin). Bewusst
 * NICHT self-deploying -- das braucht TPM-Attestation und ist ein anderer Fall.
 */
async function createDeploymentProfile(tenant, certPemPath, opts) {
  const beta = { beta: true };
  const name = String(opts.displayName || "").trim();
  if (!name) { const e = new Error("Name des Profils fehlt."); e.status = 400; throw e; }

  // deviceNameTemplate: max. 15 Zeichen inklusive %SERIAL% / %RAND:x%.
  // Leer heisst "Windows vergibt den Namen".
  const tpl = String(opts.deviceNameTemplate || "").trim();
  if (tpl && tpl.length > 15) {
    const e = new Error("Gerätename-Vorlage: maximal 15 Zeichen (inklusive %SERIAL% bzw. %RAND:x%).");
    e.status = 400;
    throw e;
  }

  const payload = {
    "@odata.type": "#microsoft.graph.azureADWindowsAutopilotDeploymentProfile",
    displayName: name,
    description: String(opts.description || "").trim(),
    language: String(opts.language || "de-DE"),
    locale: String(opts.language || "de-DE"),
    // Hardware-Hash beim Enrollment nicht neu erheben -- die Geraete sind ueber
    // das Staging-Paket bzw. den Haendler bereits registriert.
    extractHardwareHash: false,
    deviceNameTemplate: tpl,
    deviceType: "windowsPc",
    enableWhiteGlove: opts.allowWhiteGlove === true,
    roleScopeTagIds: ["0"],
    hybridAzureADJoinSkipConnectivityCheck: false,
    outOfBoxExperienceSettings: {
      hidePrivacySettings: opts.hidePrivacy !== false,
      hideEULA: opts.hideEula !== false,
      userType: opts.userType === "administrator" ? "administrator" : "standard",
      deviceUsageType: "singleUser",
      skipKeyboardSelectionPage: opts.skipKeyboard !== false,
      hideEscapeLink: true
    }
  };

  const created = await graphReq(tenant, certPemPath, "POST",
    "/deviceManagement/windowsAutopilotDeploymentProfiles", payload, beta);
  return { id: created.id, displayName: created.displayName };
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

/**
 * Autopilot-Geraete des Tenants laden (v1.0, keine Zusatz-Permission noetig —
 * DeviceManagementServiceConfig.ReadWrite.All deckt Lesen+Schreiben ab).
 * Rueckgabe: [{ id, serialNumber, model, manufacturer, groupTag, enrollmentState, lastContactedDateTime }]
 */
async function loadAutopilotDevices(tenant, certPemPath) {
  // retryTransient 8: dieser Endpoint antwortet in der Praxis auch mal ueber
  // laengere Zeit mit einem 5xx ("An internal server error has occurred") ohne
  // Client-Fehler — die Standard-5-Versuche haben real nicht immer gereicht.
  const devices = await graphAllPages(tenant, certPemPath,
    "/deviceManagement/windowsAutopilotDeviceIdentities?$select=id,serialNumber,model,manufacturer,groupTag,enrollmentState,lastContactedDateTime,addressableUserName&$top=200",
    { retryTransient: 8 });
  return devices.map(d => ({
    id: d.id,
    serialNumber: d.serialNumber || "",
    model: d.model || "",
    manufacturer: d.manufacturer || "",
    groupTag: d.groupTag || "",
    enrollmentState: d.enrollmentState || "",
    lastContactedDateTime: d.lastContactedDateTime || null,
    addressableUserName: d.addressableUserName || ""
  })).sort((a, b) => (a.serialNumber || "").localeCompare(b.serialNumber || ""));
}

/** GroupTag (OrderID) eines einzelnen Autopilot-Geraets setzen. */
async function updateDeviceGroupTag(tenant, certPemPath, deviceId, groupTag) {
  await graphReq(tenant, certPemPath, "POST",
    `/deviceManagement/windowsAutopilotDeviceIdentities/${encodeURIComponent(deviceId)}/updateDeviceProperties`,
    { groupTag: String(groupTag || "") });
}

module.exports = { loadGroupTags, buildAutopilotZip, buildAutounattend, parseWlanProfile, tagsFromRule, loadAutopilotProfiles, createDeploymentProfile, assignProfileToGroup, loadAutopilotDevices, updateDeviceGroupTag };
