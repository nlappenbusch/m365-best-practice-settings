/**
 * Microsoft 365 Apps (Office) als Intune-App anlegen und zuweisen.
 *
 * Portal-Aequivalent: Intune > Apps > Windows > Hinzufuegen > "Microsoft 365 Apps
 * (Windows 10 und hoeher)". Graph kennt dafuer den Typ officeSuiteApp:
 *   POST /beta/deviceAppManagement/mobileApps
 * Der Typ existiert NUR in beta (Stand 09/2026) — deshalb ueberall BETA.
 * Permission: DeviceManagementApps.ReadWrite.All (hat das Tool bereits).
 *
 * Die Falle bei diesem Typ: `excludedApps` ist eine NEGATIV-Liste. Im Portal
 * hakt man an, was installiert werden soll; Graph will das Gegenteil — true
 * heisst "diese App NICHT installieren". Wer die Liste direkt durchreicht,
 * installiert genau die Apps, die er ausschliessen wollte. buildOfficeSuiteApp()
 * nimmt deshalb die Auswahl (was soll drauf) und dreht sie hier einmal um.
 */
const { graphReq, graphAllPages } = require("./graph");

const BETA = { beta: true };
const APPS_PATH = "/deviceAppManagement/mobileApps";

/**
 * Auswaehlbare Apps in Portal-Reihenfolge. `key` ist das Feld in excludedApps.
 * `def` = Vorauswahl fuer einen neuen Rollout.
 */
const OFFICE_APPS = [
  { key: "word", label: "Word", def: true },
  { key: "excel", label: "Excel", def: true },
  { key: "powerPoint", label: "PowerPoint", def: true },
  { key: "outlook", label: "Outlook", def: true },
  { key: "oneNote", label: "OneNote", def: true },
  { key: "oneDrive", label: "OneDrive", def: true },
  { key: "teams", label: "Teams", def: false,
    hint: "Teams wird seit 2024 eigenstaendig installiert und aktualisiert, nicht mehr ueber die Office-Suite." },
  { key: "access", label: "Access", def: false,
    hint: "Nur wenn wirklich jemand Access-Datenbanken nutzt — sonst unnoetige Angriffsflaeche." },
  { key: "publisher", label: "Publisher", def: false,
    hint: "Microsoft stellt Publisher im Oktober 2026 ein." },
  { key: "lync", label: "Skype for Business", def: false,
    hint: "Abgekuendigt, durch Teams ersetzt." }
];

/**
 * Nie installieren, auch nicht auf Wunsch: alle drei sind seit Jahren
 * abgekuendigt und im Portal-Designer gar nicht mehr sinnvoll waehlbar.
 * groove = der alte "OneDrive for Business"-Client (nicht der heutige OneDrive).
 */
const ALWAYS_EXCLUDED = ["groove", "infoPath", "sharePointDesigner"];

const UPDATE_CHANNELS = [
  { value: "monthlyEnterprise", label: "Monatlicher Enterprise-Kanal", hint: "Einmal im Monat Funktionen, vorher getestet — der Standard fuer verwaltete Umgebungen." },
  { value: "current", label: "Aktueller Kanal", hint: "Funktionen sofort, dafuer haeufigere Aenderungen fuer die Anwender." },
  { value: "deferred", label: "Halbjaehrlicher Enterprise-Kanal", hint: "Zweimal im Jahr Funktionen — fuer Umgebungen mit langen Testzyklen." },
  { value: "firstReleaseCurrent", label: "Aktueller Kanal (Vorschau)", hint: "Vorabversion, gehoert auf Testgeraete." },
  { value: "firstReleaseDeferred", label: "Halbjaehrlicher Kanal (Vorschau)", hint: "Vorabversion des halbjaehrlichen Kanals." }
];

const PRODUCTS = [
  { value: "o365ProPlusRetail", label: "Microsoft 365 Apps for enterprise", hint: "E3/E5 und Business Premium mit Enterprise-Apps." },
  { value: "o365BusinessRetail", label: "Microsoft 365 Apps for business", hint: "Business Basic/Standard/Premium mit der Business-Variante." }
];

const FILE_FORMATS = [
  { value: "officeOpenXMLFormat", label: "Office Open XML (.docx, .xlsx)" },
  { value: "officeOpenDocumentFormat", label: "OpenDocument (.odt, .ods)" }
];

/** Vorbelegung eines neuen Rollouts — Nils' Standard fuer igeeks-Kunden. */
const DEFAULTS = {
  displayName: "Microsoft 365 Apps",
  productId: "o365ProPlusRetail",
  apps: OFFICE_APPS.filter(a => a.def).map(a => a.key),
  architecture: "x64",
  updateChannel: "monthlyEnterprise",
  fileFormat: "officeOpenXMLFormat",
  locales: ["de-de", "en-us"],
  removeOtherVersions: true,
  sharedComputerActivation: false,
  installBingSearch: false,
  includeVisio: false,
  includeProject: false,
  showInstallProgress: true,
  intent: "required"
};

const LOCALE_RE = /^[a-z]{2,3}(-[A-Za-z]{2,8})*$/;
const VERSION_RE = /^\d+(\.\d+){1,3}$/;

function bad(msg) { const e = new Error(msg); e.status = 400; return e; }

/**
 * Konfiguration -> Graph-Payload. Wirft mit status 400, wenn die Auswahl nicht
 * deploybar waere — lieber hier als mit einer halben App im Kundentenant.
 */
function buildOfficeSuiteApp(cfg) {
  const c = cfg || {};
  const displayName = String(c.displayName || "").trim();
  if (displayName.length < 3 || displayName.length > 256) throw bad("Name der App-Suite: 3 bis 256 Zeichen.");

  const selected = Array.isArray(c.apps) ? c.apps.filter(k => OFFICE_APPS.some(a => a.key === k)) : [];
  if (!selected.length) throw bad("Mindestens eine Office-App auswaehlen.");

  if (!PRODUCTS.some(p => p.value === c.productId)) throw bad("Unbekannte Produktauswahl: " + c.productId);
  if (!["x64", "x86"].includes(c.architecture)) throw bad("Architektur muss x64 oder x86 sein.");
  if (!UPDATE_CHANNELS.some(u => u.value === c.updateChannel)) throw bad("Unbekannter Updatekanal: " + c.updateChannel);
  if (!FILE_FORMATS.some(f => f.value === c.fileFormat)) throw bad("Unbekanntes Standarddateiformat: " + c.fileFormat);
  if (!["required", "available"].includes(c.intent || "required")) throw bad("Zuweisungsart muss 'required' oder 'available' sein.");

  const locales = (Array.isArray(c.locales) ? c.locales : []).map(l => String(l).trim()).filter(Boolean);
  if (!locales.length) throw bad("Mindestens eine Sprache angeben (z.B. de-de).");
  const badLocale = locales.find(l => !LOCALE_RE.test(l));
  if (badLocale) throw bad("Sprachkuerzel sieht nicht nach RFC 6033 aus: " + badLocale + " (erwartet z.B. de-de, en-us).");

  const targetVersion = String(c.targetVersion || "").trim();
  if (targetVersion && !VERSION_RE.test(targetVersion)) {
    throw bad("Spezifische Version muss eine Build-Nummer sein (z.B. 16.0.17928.20114), nicht: " + targetVersion);
  }

  // Negativ-Liste bauen: alles, was NICHT ausgewaehlt wurde, wird ausgeschlossen.
  const excludedApps = { "@odata.type": "microsoft.graph.excludedApps" };
  for (const a of OFFICE_APPS) excludedApps[a.key] = !selected.includes(a.key);
  for (const k of ALWAYS_EXCLUDED) excludedApps[k] = true;
  // Bing ist im Portal ein eigener Schalter, in Graph aber eine "App".
  excludedApps.bing = !c.installBingSearch;
  excludedApps.visio = !c.includeVisio;

  const productIds = [c.productId];
  if (c.includeVisio) productIds.push("visioProRetail");
  if (c.includeProject) productIds.push("projectProRetail");

  const payload = {
    "@odata.type": "#microsoft.graph.officeSuiteApp",
    displayName,
    description: String(c.description || "").trim()
      || `Microsoft 365 Apps (${c.architecture}, ${channelLabel(c.updateChannel)}) — ausgerollt vom M365 Security Policy Manager.`,
    publisher: "Microsoft",
    // Ohne autoAcceptEula bleibt die Installation auf dem Geraet an der
    // Lizenzbedingungs-Abfrage haengen — im SYSTEM-Kontext sieht die niemand.
    autoAcceptEula: true,
    productIds,
    excludedApps,
    useSharedComputerActivation: !!c.sharedComputerActivation,
    updateChannel: c.updateChannel,
    officeSuiteAppDefaultFileFormat: c.fileFormat,
    officePlatformArchitecture: c.architecture,
    localesToInstall: locales,
    installProgressDisplayLevel: c.showInstallProgress === false ? "none" : "full",
    shouldUninstallOlderVersionsOfOffice: !!c.removeOtherVersions
  };
  if (targetVersion) payload.targetVersion = targetVersion;
  return payload;
}

function channelLabel(v) {
  const hit = UPDATE_CHANNELS.find(u => u.value === v);
  return hit ? hit.label : String(v || "");
}

/** Bereits vorhandene Microsoft-365-Apps-Suiten des Tenants, mit Zuweisungen. */
async function listOfficeSuiteApps(tenant, certPemPath) {
  const all = await graphAllPages(tenant, certPemPath, APPS_PATH + "?$expand=assignments", { ...BETA, retryTransient: true });
  return all
    .filter(a => String(a["@odata.type"] || "").toLowerCase() === "#microsoft.graph.officesuiteapp")
    .map(a => ({
      id: a.id,
      displayName: a.displayName,
      architecture: a.officePlatformArchitecture,
      updateChannel: a.updateChannel,
      updateChannelLabel: channelLabel(a.updateChannel),
      productIds: a.productIds || [],
      locales: a.localesToInstall || [],
      sharedComputerActivation: !!a.useSharedComputerActivation,
      removeOtherVersions: !!a.shouldUninstallOlderVersionsOfOffice,
      targetVersion: a.targetVersion || null,
      // Positiv-Liste zurueckdrehen, damit die Anzeige sagt, was DRAUF ist.
      includedApps: OFFICE_APPS.filter(x => !(a.excludedApps || {})[x.key]).map(x => x.label),
      assignments: (a.assignments || []).map(as => ({
        intent: as.intent,
        groupId: (as.target || {}).groupId || null,
        targetType: String((as.target || {})["@odata.type"] || "").split(".").pop()
      }))
    }));
}

async function createOfficeSuiteApp(tenant, certPemPath, payload) {
  return graphReq(tenant, certPemPath, "POST", APPS_PATH, payload, BETA);
}

/**
 * Zuweisen. Bewusst eigene Funktion statt win32app.assignAppToGroup: die App
 * existiert nur im beta-Modell, und die Zuweisungsart ist hier waehlbar
 * (Office wird oft "verfuegbar" statt "erforderlich" gestellt).
 */
async function assignToGroups(tenant, certPemPath, appId, groupIds, intent) {
  const mobileAppAssignments = (groupIds || []).map(groupId => ({
    "@odata.type": "#microsoft.graph.mobileAppAssignment",
    intent: intent === "available" ? "available" : "required",
    target: { "@odata.type": "microsoft.graph.groupAssignmentTarget", groupId }
  }));
  if (!mobileAppAssignments.length) throw bad("Keine Zielgruppe angegeben.");
  await graphReq(tenant, certPemPath, "POST", `${APPS_PATH}/${appId}/assign`,
    { mobileAppAssignments }, { ...BETA, retryTransient: true });
}

async function deleteOfficeSuiteApp(tenant, certPemPath, appId) {
  await graphReq(tenant, certPemPath, "DELETE", `${APPS_PATH}/${appId}`, null, BETA);
}

module.exports = {
  OFFICE_APPS, ALWAYS_EXCLUDED, UPDATE_CHANNELS, PRODUCTS, FILE_FORMATS, DEFAULTS,
  buildOfficeSuiteApp, listOfficeSuiteApps, createOfficeSuiteApp, assignToGroups,
  deleteOfficeSuiteApp, channelLabel
};
