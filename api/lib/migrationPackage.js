/**
 * Paketbau fuer die Tenant-zu-Tenant-Geraetemigration.
 *
 * Grundlage ist der igeeks-Fork von stevecapacity/intunemigration-v9
 * (gitlab.igeeks.ch/igeeks/igeeks-apps/intune-tenant-migration). Die Skripte
 * liegen unveraendert unter assets/migration; dieses Modul erzeugt nur die
 * config.json und stellt die Dateiliste fuer die Win32-App zusammen.
 *
 * Deployt wird ausschliesslich im QUELLTENANT — dort sind die Geraete noch
 * Intune-verwaltet. Der Zieltenant braucht kein Deployment, sondern nur eine
 * App-Registrierung (deren Secret hier in die config wandert) und ein
 * Provisioning Package fuer den Join.
 */
const fs = require("fs");
const path = require("path");

const ASSET_DIR = path.join(__dirname, "..", "assets", "migration");

// Reihenfolge egal, aber vollstaendig: StartMigrate laeuft als Installer, die
// uebrigen Skripte werden von den Scheduled Tasks aufgerufen und muessen
// deshalb im selben Verzeichnis liegen.
const SCRIPT_FILES = [
  "StartMigrate.ps1",
  "reboot.ps1",
  "postMigrate.ps1",
  "groupTag.ps1",
  "utils.ps1",
  "reboot.xml",
  "postMigrate.xml",
  "groupTag.xml"
];

const SETUP_FILE = "StartMigrate.ps1";

function isGuidOrDomain(v) {
  const s = String(v || "").trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) || /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(s);
}

/**
 * Prueft die Eingaben und baut die config.json.
 * Wirft mit .status = 400, damit der Aufrufer den Fehler direkt durchreichen kann.
 */
function buildConfig(input) {
  const bad = (msg) => { const e = new Error(msg); e.status = 400; throw e; };

  const src = input.sourceTenant || {};
  const dst = input.targetTenant || {};

  for (const [label, t] of [["Quelltenant", src], ["Zieltenant", dst]]) {
    if (!isGuidOrDomain(t.tenantName)) bad(`${label}: Tenant-Name muss eine Domain oder Tenant-ID sein.`);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(t.clientId || "").trim())) {
      bad(`${label}: Client-ID ist keine gueltige GUID.`);
    }
    if (String(t.clientSecret || "").trim().length < 8) bad(`${label}: Client Secret fehlt.`);
  }

  const bitlocker = String(input.bitlocker || "migrate").toLowerCase();
  if (!["migrate", "decrypt"].includes(bitlocker)) bad("BitLocker-Modus muss 'migrate' oder 'decrypt' sein.");

  const fb = input.fallbackAdmin || {};
  const fallbackEnabled = fb.enabled !== false;   // Standard: an
  const fallbackName = String(fb.name || "igeeksRecovery").trim();
  if (fallbackEnabled && !/^[A-Za-z0-9_-]{3,20}$/.test(fallbackName)) {
    bad("Name des Fallback-Admins: 3-20 Zeichen, nur Buchstaben, Ziffern, - und _.");
  }
  // Leeres Passwort ist erlaubt und bedeutet "zufaellig" — dann kennt es
  // niemand und das Konto ist nur mit Windows LAPS im Ziel brauchbar.
  const fallbackPw = String(fb.password || "");
  if (fallbackPw && fallbackPw.length < 12) bad("Passwort des Fallback-Admins: mindestens 12 Zeichen (oder leer lassen für ein Zufallspasswort).");

  return {
    localPath: "C:\\ProgramData\\IntuneMigration",
    logPath: "C:\\ProgramData\\Microsoft\\IntuneManagementExtension\\Logs",
    regPath: "HKLM\\SOFTWARE\\IntuneMigration",
    sourceTenant: {
      clientId: String(src.clientId).trim(),
      clientSecret: String(src.clientSecret).trim(),
      tenantName: String(src.tenantName).trim()
    },
    targetTenant: {
      clientId: String(dst.clientId).trim(),
      clientSecret: String(dst.clientSecret).trim(),
      tenantName: String(dst.tenantName).trim()
    },
    groupTag: String(input.groupTag || "").trim(),
    bitlocker: bitlocker,
    SCCM: input.sccm === true,
    fallbackAdmin: {
      enabled: fallbackEnabled,
      name: fallbackName,
      password: fallbackPw,
      removeAfterMigration: fb.removeAfterMigration === true
    },
    cleanupLocalPath: input.cleanupLocalPath !== false   // Standard: an
  };
}

/**
 * Liefert { setupFileName, installerBuffer, extraFiles } fuer
 * WIN32APP.createWin32AppWithContent.
 * ppkg: { name, data(Buffer) } — das Provisioning Package des Zieltenants.
 */
function buildPackageFiles(config, ppkg) {
  if (!ppkg || !ppkg.data || !ppkg.data.length) {
    const e = new Error("Kein Provisioning Package hinterlegt — ohne .ppkg kann das Geraet dem Zieltenant nicht beitreten.");
    e.status = 400;
    throw e;
  }

  const extraFiles = [];
  for (const name of SCRIPT_FILES) {
    if (name === SETUP_FILE) continue;   // der ist der Installer selbst
    const p = path.join(ASSET_DIR, name);
    if (!fs.existsSync(p)) {
      const e = new Error("Migrationsskript fehlt im Paket: " + name);
      e.status = 500;
      throw e;
    }
    extraFiles.push({ name, data: fs.readFileSync(p) });
  }

  extraFiles.push({ name: ppkg.name || "migration.ppkg", data: ppkg.data });
  extraFiles.push({ name: "config.json", data: Buffer.from(JSON.stringify(config, null, 4), "utf8") });

  return {
    setupFileName: SETUP_FILE,
    installerBuffer: fs.readFileSync(path.join(ASSET_DIR, SETUP_FILE)),
    extraFiles
  };
}

/**
 * Win32-App-Payload. Detection: die Datei, die StartMigrate.ps1 gleich zu
 * Beginn selbst anlegt (IntuneDetectionRule.txt) — dieselbe Konvention wie im
 * Original-Repo.
 */
function buildAppPayload(opts) {
  return {
    "@odata.type": "#microsoft.graph.win32LobApp",
    displayName: opts.appName,
    description: opts.description || "Geraetemigration in den Tenant " + opts.targetTenantName + " (igeeks)",
    publisher: "igeeks AG",
    fileName: opts.packageName,
    installCommandLine: 'powershell.exe -ExecutionPolicy Bypass -NoProfile -File .\\StartMigrate.ps1',
    uninstallCommandLine: 'cmd.exe /c "echo Deinstallation nicht vorgesehen"',
    applicableArchitectures: "x64, arm",
    setupFilePath: SETUP_FILE,
    installExperience: {
      "@odata.type": "microsoft.graph.win32LobAppInstallExperience",
      runAsAccount: "system",
      // Das Skript startet den Rechner selbst neu, sobald das Provisioning
      // Package sitzt. Intune darf nicht zusaetzlich rebooten.
      deviceRestartBehavior: "suppress"
    },
    returnCodes: [
      { returnCode: 0, type: "success" },
      { returnCode: 1707, type: "success" },
      { returnCode: 3010, type: "softReboot" },
      { returnCode: 1641, type: "hardReboot" },
      { returnCode: 1618, type: "retry" }
    ],
    detectionRules: [{
      "@odata.type": "microsoft.graph.win32LobAppFileSystemRule",
      ruleType: "detection",
      check32BitOn64System: false,
      path: "C:\\ProgramData\\IntuneMigration",
      fileOrFolderName: "IntuneDetectionRule.txt",
      operationType: "exists"
    }],
    minimumSupportedWindowsRelease: "1903"
  };
}

module.exports = { buildConfig, buildPackageFiles, buildAppPayload, SCRIPT_FILES, SETUP_FILE, ASSET_DIR };
