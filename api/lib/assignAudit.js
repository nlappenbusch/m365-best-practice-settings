"use strict";
/**
 * Zuweisungs-Audit: wer bekommt was, und auf welchem Weg.
 *
 * Drei Sichten auf denselben Kern:
 *  - Apps:        App -> Zuweisung -> App-Gruppe -> verschachtelte Gerätegruppe -> Gerät
 *  - Richtlinien: Intune-Richtlinie (OIB oder alle) -> Gruppe -> Gerät/Benutzer, dazu
 *                 ausgelesen, was die Richtlinie tatsächlich einstellt
 *  - Conditional Access: Richtlinie -> Benutzer/Gruppen/Rollen, Ausschlüsse, was sie
 *                 verlangt, und für wen sie effektiv gilt
 *
 * Der Kern ist der Resolver: Er löst eine Gruppe bis zu den Geräten und Benutzern
 * auf und merkt sich den Weg ("App-Gruppe › Gerätegruppe"). Genau dieser Weg ist
 * die Frage im Audit — nicht nur, OB ein Gerät eine App bekommt, sondern ÜBER
 * WELCHE Gruppe. Eine direkt an die Gerätegruppe gehängte App sieht im Ergebnis
 * gleich aus wie eine über die App-Gruppe, ist aber nach Konzept falsch.
 *
 * Ausschliesslich lesend. Jeder Baustein fängt seine Fehler selbst ab: Fehlt eine
 * Berechtigung (etwa DeviceManagementManagedDevices.Read.All für Intune-Details),
 * läuft der Audit ohne diese Spalte weiter und vermerkt die Lücke — eine Lücke im
 * Nachweis muss sichtbar sein, nicht stillschweigend als "alles gut" durchgehen.
 */
const { graphReq, graphAllPages } = require("./graph");
const NAMING = require("./naming");
const APPGROUPS = require("./appGroups");
const GROUPTAGS = require("./groupTags");
const APPHYGIENE = require("./appHygiene");

const BETA = { beta: true, retryTransient: 4 };
const V1 = { retryTransient: 4 };

// ============================================================== Labels
const INTENT_LABEL = {
  required: "Erforderlich",
  available: "Verfügbar",
  availableWithoutEnrollment: "Verfügbar ohne Registrierung",
  uninstall: "Deinstallieren"
};

const APP_TYPES = [
  [/win32LobApp$/i, "Win32-App", "Windows"],
  [/win32CatalogApp$/i, "Win32 (Enterprise App Catalog)", "Windows"],
  [/winGetApp$/i, "Microsoft Store (WinGet)", "Windows"],
  [/officeSuiteApp$/i, "Microsoft 365 Apps", "Windows"],
  [/windowsMicrosoftEdgeApp$/i, "Microsoft Edge", "Windows"],
  [/windowsMobileMSI$/i, "MSI (Branchen-App)", "Windows"],
  [/windowsUniversalAppX$/i, "AppX / MSIX", "Windows"],
  [/windowsStoreApp$/i, "Microsoft Store (Legacy)", "Windows"],
  [/windowsWebApp$/i, "Web-Link (Windows)", "Windows"],
  [/macOSMicrosoftEdgeApp$/i, "Microsoft Edge (macOS)", "macOS"],
  [/macOSOfficeSuiteApp$/i, "Microsoft 365 Apps (macOS)", "macOS"],
  [/macOSMicrosoftDefenderApp$/i, "Defender (macOS)", "macOS"],
  [/macOS/i, "macOS-App", "macOS"],
  [/ios/i, "iOS-App", "iOS"],
  [/android/i, "Android-App", "Android"],
  [/webApp$/i, "Web-Link", "Web"]
];

function appTypeOf(app) {
  const t = String(app["@odata.type"] || "");
  const hit = APP_TYPES.find(([re]) => re.test(t));
  return hit ? { label: hit[1], platform: hit[2] } : { label: t.replace("#microsoft.graph.", "") || "App", platform: "Andere" };
}

/** Patch My PC schreibt seine Kennungen in die Notizen der App. */
function isPmpApp(app) {
  const txt = [app.notes, app.description, app.developer, app.owner].map(x => String(x || "")).join(" ");
  return /PmpAppId|PmpReleaseId|patch\s*my\s*pc/i.test(txt);
}

function fmtIso(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d) ? null : d.toISOString();
}

// ============================================================== Resolver
/**
 * Löst Gruppen bis zu Geräten und Benutzern auf, mit Cache — dieselbe
 * Gerätegruppe hängt typischerweise an dutzenden Apps und Richtlinien.
 */
function createResolver(tenant, cert) {
  const tenantId = tenant.id;
  const groupCache = new Map();
  const memberCache = new Map();
  const gaps = new Set();

  async function group(id) {
    if (!id) return null;
    if (!groupCache.has(id)) {
      groupCache.set(id, (async () => {
        try {
          const g = await graphReq(tenant, cert, "GET",
            `/groups/${encodeURIComponent(id)}?$select=id,displayName,description,groupTypes,membershipRule,membershipRuleProcessingState,securityEnabled,createdDateTime`, null, V1);
          const dynamic = (g.groupTypes || []).includes("DynamicMembership");
          return {
            id: g.id,
            displayName: g.displayName || id,
            description: g.description || "",
            dynamic,
            rule: g.membershipRule || "",
            ruleState: g.membershipRuleProcessingState || "",
            tags: GROUPTAGS.tagsFromRule(g.membershipRule),
            createdDateTime: g.createdDateTime || null
          };
        } catch (e) {
          if (e.status === 404) return { id, displayName: id, missing: true, dynamic: false, rule: "", tags: [] };
          gaps.add("Gruppe nicht lesbar: " + e.message);
          return { id, displayName: id, unreadable: true, dynamic: false, rule: "", tags: [] };
        }
      })());
    }
    return groupCache.get(id);
  }

  /** Direkte Mitglieder, nach Typ getrennt. */
  async function members(id) {
    if (!memberCache.has(id)) {
      memberCache.set(id, (async () => {
        const out = { groups: [], devices: [], users: [], other: 0, error: null };
        let list;
        try {
          list = await graphAllPages(tenant, cert, `/groups/${encodeURIComponent(id)}/members?$top=999`, V1);
        } catch (e) {
          out.error = e.message;
          gaps.add("Mitglieder nicht lesbar: " + e.message);
          return out;
        }
        for (const m of list) {
          const t = String(m["@odata.type"] || "").toLowerCase();
          if (t.endsWith(".group")) out.groups.push({ id: m.id, displayName: m.displayName || m.id });
          else if (t.endsWith(".device")) {
            out.devices.push({
              id: m.id,
              deviceId: m.deviceId || null,
              displayName: m.displayName || m.id,
              os: m.operatingSystem || "",
              osVersion: m.operatingSystemVersion || "",
              trustType: m.trustType || "",
              lastSignIn: m.approximateLastSignInDateTime || null,
              accountEnabled: m.accountEnabled !== false,
              groupTag: tagFromPhysicalIds(m.physicalIds)
            });
          } else if (t.endsWith(".user")) {
            out.users.push({ id: m.id, displayName: m.displayName || m.id, upn: m.userPrincipalName || "" });
          } else out.other++;
        }
        return out;
      })());
    }
    return memberCache.get(id);
  }

  /** Art der Gruppe im Sinne des Konzepts. */
  async function classify(id) {
    const g = await group(id);
    if (!g) return { kind: "unknown", label: "unbekannt" };
    if (g.missing) return { kind: "missing", label: "gelöscht / nicht vorhanden" };
    if (APPGROUPS.isAppGroupName(g.displayName, tenantId)) return { kind: "appGroup", label: "App-Gruppe" };
    if (g.dynamic && /\bdevice\./i.test(g.rule)) {
      return { kind: "deviceGroup", label: g.tags.length ? "Gerätegruppe (GroupTag)" : "Gerätegruppe (dynamisch)" };
    }
    if (g.dynamic && /\buser\./i.test(g.rule)) return { kind: "userGroup", label: "Benutzergruppe (dynamisch)" };
    const m = await members(id);
    if (m.error) return { kind: "unknown", label: "Mitglieder nicht lesbar" };
    const d = m.devices.length, u = m.users.length, gr = m.groups.length;
    if (gr && !d && !u) return { kind: "container", label: "Sammelgruppe (nur Gruppen)" };
    if (d && !u) return { kind: "deviceGroup", label: gr ? "Gerätegruppe (statisch, mit Untergruppen)" : "Gerätegruppe (statisch)" };
    if (u && !d) return { kind: "userGroup", label: "Benutzergruppe" };
    if (u && d) return { kind: "mixed", label: "gemischt (Geräte und Benutzer)" };
    return { kind: "empty", label: "leer" };
  }

  /**
   * Alle Geräte und Benutzer einer Gruppe, rekursiv über verschachtelte Gruppen.
   * `via` ist der Weg dorthin, erste Gruppe = die zugewiesene.
   */
  async function expand(rootId, maxDepth) {
    const acc = { devices: new Map(), users: new Map(), groups: [], cyclic: false, truncated: false };
    const seen = new Set();
    async function walk(id, path, depth) {
      if (seen.has(id)) { if (path.length) acc.cyclic = acc.cyclic || path.includes(id); return; }
      if (depth > (maxDepth || 6)) { acc.truncated = true; return; }
      seen.add(id);
      const g = await group(id);
      const here = path.concat([g ? g.displayName : id]);
      if (depth > 0) acc.groups.push({ id, displayName: g ? g.displayName : id, depth, tags: g ? g.tags : [], dynamic: !!(g && g.dynamic) });
      const m = await members(id);
      for (const d of m.devices) {
        const prev = acc.devices.get(d.id);
        if (prev) prev.paths.push(here);
        else acc.devices.set(d.id, { ...d, groupTag: d.groupTag || (g && g.tags.length === 1 ? g.tags[0] : null), paths: [here] });
      }
      for (const u of m.users) {
        const prev = acc.users.get(u.id);
        if (prev) prev.paths.push(here);
        else acc.users.set(u.id, { ...u, paths: [here] });
      }
      for (const sub of m.groups) await walk(sub.id, here, depth + 1);
    }
    await walk(rootId, [], 0);
    return acc;
  }

  /** Alle bisher aufgelösten Gruppen — die Gruppenstruktur für die Doku. */
  async function inventory() {
    const out = [];
    for (const id of groupCache.keys()) {
      const g = await group(id);
      if (!g || g.missing || g.unreadable) continue;
      const cls = await classify(id);
      const m = await members(id);
      const ex = await expand(id);
      out.push({
        id, displayName: g.displayName, kind: cls.kind, kindLabel: cls.label, dynamic: g.dynamic, rule: g.rule, tags: g.tags,
        memberGroups: m.groups.map(x => x.displayName), directDevices: m.devices.length, directUsers: m.users.length,
        devices: ex.devices.size, users: ex.users.size
      });
    }
    return out.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  return { group, members, classify, expand, inventory, gaps, tenantId };
}

function tagFromPhysicalIds(ids) {
  for (const s of Array.isArray(ids) ? ids : []) {
    const m = String(s).match(/^\[OrderID\]:(.+)$/i);
    if (m) return m[1].trim();
  }
  return null;
}

/** Intune-Objekte der Geräte (Name, Primärbenutzer, Compliance) — optional. */
async function loadManagedDevices(tenant, cert) {
  try {
    const list = await graphAllPages(tenant, cert,
      "/deviceManagement/managedDevices?$select=id,deviceName,azureADDeviceId,userPrincipalName,operatingSystem,osVersion,complianceState,lastSyncDateTime,serialNumber,model,manufacturer&$top=999", V1);
    const map = new Map();
    for (const m of list) if (m.azureADDeviceId) map.set(String(m.azureADDeviceId).toLowerCase(), m);
    return { map, ok: true };
  } catch (e) {
    return { map: new Map(), ok: false, error: e.message };
  }
}

async function loadFilters(tenant, cert) {
  try {
    const list = await graphAllPages(tenant, cert, "/deviceManagement/assignmentFilters?$top=100", BETA);
    return new Map(list.map(f => [f.id, { id: f.id, displayName: f.displayName, rule: f.rule || "", platform: f.platform || "" }]));
  } catch (e) {
    return new Map();
  }
}

function describeFilter(target, filters) {
  const id = target && target.deviceAndAppManagementAssignmentFilterId;
  const type = target && target.deviceAndAppManagementAssignmentFilterType;
  if (!id || !type || type === "none") return null;
  const f = filters.get(id);
  return { id, mode: type === "exclude" ? "Ausschluss" : "Einschluss", name: f ? f.displayName : id, rule: f ? f.rule : "" };
}

function targetKind(target) {
  const t = String((target && target["@odata.type"]) || "");
  if (/exclusionGroupAssignmentTarget/i.test(t)) return "exclusion";
  if (/allDevicesAssignmentTarget/i.test(t)) return "allDevices";
  if (/allLicensedUsersAssignmentTarget|allUsers/i.test(t)) return "allUsers";
  if (/groupAssignmentTarget/i.test(t)) return "group";
  return "other";
}

function deviceRow(d, managed, extra) {
  const m = d.deviceId ? managed.get(String(d.deviceId).toLowerCase()) : null;
  const path = (d.paths && d.paths[0]) || [];
  return {
    id: d.id,
    deviceId: d.deviceId,
    name: (m && m.deviceName) || d.displayName,
    os: (m && m.operatingSystem) || d.os || "",
    osVersion: (m && m.osVersion) || d.osVersion || "",
    groupTag: d.groupTag || null,
    via: path.join(" › "),
    viaCount: (d.paths || []).length,
    user: m ? (m.userPrincipalName || "") : "",
    compliance: m ? (m.complianceState || "") : "",
    lastSync: m ? (m.lastSyncDateTime || null) : null,
    serial: m ? (m.serialNumber || "") : "",
    intune: !!m,
    ...(extra || {})
  };
}

// ============================================================== Apps
const INSTALL_LABEL = {
  installed: "installiert",
  failed: "fehlgeschlagen",
  notinstalled: "nicht installiert",
  uninstallfailed: "Deinstallation fehlgeschlagen",
  pendinginstall: "ausstehend",
  pending: "ausstehend",
  notapplicable: "nicht anwendbar",
  excluded: "ausgeschlossen",
  unknown: "unbekannt"
};

function installKey(v) {
  const k = String(v || "").toLowerCase().replace(/[^a-z]/g, "");
  return INSTALL_LABEL[k] ? k : (k ? k : "unknown");
}

/** Installationsstatus je Gerät aus dem Intune-Bericht. Fehlertolerant. */
async function loadInstallStatus(tenant, cert, appId) {
  const body = {
    filter: `(ApplicationId eq '${appId}')`,
    select: ["DeviceName", "DeviceId", "UserPrincipalName", "AppInstallState", "InstallState", "AppInstallStateDetails", "InstallStateDetail", "HexErrorCode", "LastModifiedDateTime", "AppVersion"],
    top: 1000,
    skip: 0
  };
  let r;
  try {
    r = await graphReq(tenant, cert, "POST", "/deviceManagement/reports/getDeviceInstallStatusReport", body, BETA);
  } catch (e) {
    // Manche Tenants kennen einzelne Spalten nicht — dann ohne Auswahl.
    try { r = await graphReq(tenant, cert, "POST", "/deviceManagement/reports/getDeviceInstallStatusReport", { filter: body.filter, top: 1000, skip: 0 }, BETA); }
    catch (e2) { return { ok: false, error: e2.message, byDeviceId: new Map(), byName: new Map() }; }
  }
  const schema = (r.Schema || r.schema || []).map(c => c.Column || c.column);
  const rows = r.Values || r.values || [];
  const col = name => schema.indexOf(name);
  const byDeviceId = new Map(), byName = new Map();
  for (const row of rows) {
    const get = n => { const i = col(n); return i >= 0 ? row[i] : null; };
    const state = get("AppInstallState") || get("InstallState");
    const entry = {
      state: installKey(state),
      detail: String(get("AppInstallStateDetails") || get("InstallStateDetail") || "").replace(/^0$/, ""),
      error: get("HexErrorCode") || null,
      at: get("LastModifiedDateTime") || null,
      version: get("AppVersion") || null,
      deviceName: get("DeviceName") || "",
      user: get("UserPrincipalName") || ""
    };
    const did = String(get("DeviceId") || "").toLowerCase();
    if (did) byDeviceId.set(did, entry);
    if (entry.deviceName) byName.set(entry.deviceName.toLowerCase(), entry);
  }
  return { ok: true, byDeviceId, byName, rows: rows.length };
}

function settingsSummary(settings) {
  if (!settings) return [];
  const out = [];
  const n = settings.notifications;
  if (n) out.push("Benachrichtigung: " + ({ showAll: "alle anzeigen", showReboot: "nur Neustart", hideAll: "keine" }[n] || n));
  if (settings.deliveryOptimizationPriority && settings.deliveryOptimizationPriority !== "notConfigured") {
    out.push("Übermittlung: " + (settings.deliveryOptimizationPriority === "foreground" ? "Vordergrund" : settings.deliveryOptimizationPriority));
  }
  const it = settings.installTimeSettings;
  if (it) {
    if (it.startDateTime) out.push("Verfügbar ab " + String(it.startDateTime).slice(0, 16).replace("T", " "));
    if (it.deadlineDateTime) out.push("Stichtag " + String(it.deadlineDateTime).slice(0, 16).replace("T", " "));
  }
  const rs = settings.restartSettings;
  if (rs && rs.gracePeriodInMinutes) out.push(`Neustart-Karenz ${rs.gracePeriodInMinutes} min`);
  if (settings.autoUpdateSettings && settings.autoUpdateSettings.autoUpdateSupersededAppsState === "enabled") out.push("Ersetzte Versionen automatisch aktualisieren");
  if (settings.uninstallOnDeviceRemoval === true) out.push("Beim Entfernen deinstallieren");
  return out;
}

// ---- Konfiguration einer App (für die Doku): was installiert wird und wie
const OPERATION = { exists: "vorhanden", doesNotExist: "nicht vorhanden", notExists: "nicht vorhanden", version: "Version", string: "Zeichenfolge",
  integer: "Zahl", dateCreated: "Erstelldatum", dateModified: "Änderungsdatum", sizeInMB: "Grösse (MB)", appVersion: "App-Version" };
const OPERATOR = { equal: "=", notEqual: "!=", greaterThan: ">", greaterThanOrEqual: ">=", lessThan: "<", lessThanOrEqual: "<=" };
const RETURN_CODE = { success: "Erfolg", softReboot: "Neustart (soft)", hardReboot: "Neustart (hard)", retry: "Wiederholen", failed: "Fehler" };

function ruleText(r) {
  const t = String(r["@odata.type"] || "");
  const cmp = r.comparisonValue ? ` ${OPERATOR[r.operator] || r.operator || ""} ${r.comparisonValue}` : "";
  const op = OPERATION[r.operationType] || r.operationType || "";
  if (/FileSystem/i.test(t)) return `Datei/Ordner ${[r.path, r.fileOrFolderName].filter(Boolean).join("\\")} — ${op}${cmp}`;
  if (/Registry/i.test(t)) return `Registry ${r.keyPath || ""}${r.valueName ? " › " + r.valueName : ""} — ${op}${cmp}`;
  if (/ProductCode/i.test(t)) return `MSI-Produktcode ${r.productCode || ""}${r.productVersion ? ` ${OPERATOR[r.productVersionOperator] || ""} ${r.productVersion}` : ""}`;
  if (/PowerShell/i.test(t)) return `PowerShell-Skript${r.displayName ? " „" + r.displayName + "“" : ""}${r.runAs32Bit ? " (32-Bit)" : ""}${r.runAsAccount === "user" ? " als Benutzer" : ""}`;
  return t.replace("#microsoft.graph.", "");
}

function minOsText(o) {
  if (!o) return null;
  const k = Object.keys(o).filter(x => o[x] === true).pop();
  return k ? k.replace(/^v(\d+)_(\d+)$/, "Windows $1 $2").replace(/^v/, "") : null;
}

function appConfig(app) {
  const t = String(app["@odata.type"] || "");
  const out = [];
  const add = (label, v) => {
    if (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length)) return;
    out.push({ label, value: Array.isArray(v) ? v.join(", ") : String(v) });
  };
  add("Hersteller", app.publisher);
  add("Version", app.displayVersion);
  if (app.description) add("Beschreibung", String(app.description).slice(0, 500));
  if (/win32LobApp|win32CatalogApp/i.test(t)) {
    add("Installationsdatei", app.setupFilePath || app.fileName);
    // Bitdefender-Tokens sind Einschreibe-Schlüssel — nie vollständig in die Doku.
    add("Installationsbefehl", app.installCommandLine ? APPHYGIENE.maskiereTokens(app.installCommandLine) : null);
    add("Deinstallationsbefehl", app.uninstallCommandLine ? APPHYGIENE.maskiereTokens(app.uninstallCommandLine) : null);
    const ie = app.installExperience || {};
    add("Installationskontext", { system: "System", user: "Benutzer" }[ie.runAsAccount] || ie.runAsAccount);
    add("Neustartverhalten", { basedOnReturnCode: "nach Rückgabecode", allow: "Neustart erlaubt", suppress: "kein Neustart", force: "Neustart erzwingen" }[ie.deviceRestartBehavior] || ie.deviceRestartBehavior);
    if (ie.maxRunTimeInMinutes) add("Maximale Laufzeit", ie.maxRunTimeInMinutes + " min");
    add("Mindest-Betriebssystem", app.minimumSupportedWindowsRelease || minOsText(app.minimumSupportedOperatingSystem));
    add("Architektur", app.allowedArchitectures || app.applicableArchitectures);
    const rules = app.rules || [];
    const det = [...new Set([...rules.filter(r => r.ruleType === "detection"), ...(app.detectionRules || [])].map(ruleText))];
    const req = [...new Set([...rules.filter(r => r.ruleType === "requirement"), ...(app.requirementRules || [])].map(ruleText))];
    add("Erkennung", det.join("\n"));
    add("Zusätzliche Anforderungen", req.join("\n"));
    add("Rückgabecodes", (app.returnCodes || []).map(r => `${r.returnCode} ${RETURN_CODE[r.type] || r.type}`).join(", "));
  } else if (/winGetApp/i.test(t)) {
    add("Store-Paket", app.packageIdentifier);
    add("Installationskontext", { system: "System", user: "Benutzer" }[(app.installExperience || {}).runAsAccount] || null);
  } else if (/officeSuiteApp/i.test(t)) {
    add("Produkte", app.productIds);
    add("Updatekanal", app.updateChannel);
    add("Architektur", app.officePlatformArchitecture);
    add("Sprachen", app.localesToInstall);
    const ex = Object.entries(app.excludedApps || {}).filter(([k, v]) => v === true && !k.startsWith("@")).map(([k]) => k);
    add("Nicht installiert", ex);
    if (app.useSharedComputerActivation) add("Aktivierung", "Gemeinsam genutzte Computer");
  } else if (/windowsMobileMSI/i.test(t)) {
    add("Produktcode", app.productCode);
    add("Befehlszeile", app.commandLine);
  } else if (/macOS/i.test(t)) {
    add("Bundle-ID", app.primaryBundleId || app.bundleId);
    add("Mindest-macOS", minOsText(app.minimumSupportedOperatingSystem));
  } else if (/StoreApp|webApp/i.test(t)) {
    add("Adresse", app.appStoreUrl || app.appUrl);
  }
  return out;
}

/** Sollname der App-Gruppe für eine App. Versionsnummern und Architekturzusätze fallen weg. */
const AGENT_GROUP_NAMES = { rmm: "AdvancedMonitoringAgent", bitdefender: "Bitdefender", bitwarden: "Bitwarden", forticlient: "FortiClient" };

function appBaseName(app) {
  const agent = APPHYGIENE.BEKANNTE_AGENTS.find(a =>
    a.match.test(String(app.displayName || "")) || a.match.test(String(app.installCommandLine || "")));
  if (agent && AGENT_GROUP_NAMES[agent.key]) return AGENT_GROUP_NAMES[agent.key];
  return String(app.displayName || "App")
    .replace(/\((x64|x86|arm64|64-bit|32-bit|machine|user|system)\)/ig, " ")
    .replace(/\s+v?\d+(\.\d+)+.*$/i, "")
    .trim() || "App";
}

function expectedAppGroupName(app, managed, tenantId) {
  return APPGROUPS.buildAppGroupName(appBaseName(app), { managed: managed === "pmp" ? "pmp" : "app", tenantId });
}

/** Präfix der App-Gruppen nach der wirksamen Konvention (ohne App-Namen). */
function conventionPrefix(managed, tenantId) {
  const SEP = String.fromCharCode(1);
  return NAMING.name(managed === "pmp" ? "pmpGroup" : "appGroup", { app: SEP }, tenantId).split(SEP)[0];
}

/** Präfixlose, vergleichbare Form eines Gruppennamens. */
function groupSuffix(name, tenantId) {
  const n = String(name || "");
  const prefixes = APPGROUPS.allPrefixes(tenantId).sort((a, b) => b.length - a.length);
  for (const p of prefixes) if (n.toLowerCase().startsWith(p.toLowerCase())) return n.slice(p.length).toLowerCase();
  return n.toLowerCase();
}

/**
 * Apps mit Zuweisungen, aufgelöst bis zum Gerät, dazu die Befunde gegen das
 * Konzept App -> App-Gruppe -> GroupTag-Gerätegruppe.
 *
 * opts.devices (Vorgabe true): Geräte auflösen. opts.installStatus: Installations-
 * bericht je App (eine Abfrage pro App — bei vielen Apps spürbar langsamer).
 */
async function auditApps(tenant, cert, opts, onProgress) {
  opts = opts || {};
  const say = onProgress || (() => {});
  const tenantId = tenant.id;
  const R = createResolver(tenant, cert);

  say("Apps laden");
  const all = await graphAllPages(tenant, cert, "/deviceAppManagement/mobileApps?$expand=assignments&$top=100", { beta: true, retryTransient: 8 });
  const filters = await loadFilters(tenant, cert);
  const managedRes = opts.devices === false ? { map: new Map(), ok: false, skipped: true } : await loadManagedDevices(tenant, cert);
  const managed = managedRes.map;

  const only = Array.isArray(opts.onlyAppIds) && opts.onlyAppIds.length ? new Set(opts.onlyAppIds) : null;
  const apps = all.filter(a => {
    if (only && !only.has(a.id)) return false;
    const t = String(a["@odata.type"] || "");
    if (/builtIn|microsoftStoreForBusiness/i.test(t)) return false;
    const plat = appTypeOf(a).platform;
    return (a.assignments || []).length > 0 || plat === "Windows" || plat === "macOS";
  });

  // Alle App-Gruppen des Tenants — für "welche Gruppe gibt es schon" im Fixer.
  let existingAppGroups = [];
  try {
    const r = await APPGROUPS.listAppGroups({ kind: "cert", tenant, certPemPath: cert }, null, { withAssignments: false, tenantId });
    existingAppGroups = r.groups;
  } catch (e) { R.gaps.add("App-Gruppen nicht auflistbar: " + e.message); }

  const groupUse = new Map(); // groupId -> Set(appName) — eine App-Gruppe gehört genau einer App
  for (const a of all) for (const as of a.assignments || []) {
    const gid = as.target && as.target.groupId;
    if (gid && targetKind(as.target) === "group") {
      if (!groupUse.has(gid)) groupUse.set(gid, new Set());
      groupUse.get(gid).add(a.displayName);
    }
  }

  const out = [];
  let i = 0;
  const wantDetails = opts.details !== undefined ? !!opts.details : opts.devices !== false;
  let detailCount = 0;
  for (const app of apps) {
    i++;
    if (i % 5 === 1) say(`Apps auflösen (${i}/${apps.length})`);
    const type = appTypeOf(app);
    const managedBy = isPmpApp(app) ? "pmp" : (/winGetApp|officeSuite|MicrosoftEdge|StoreApp/i.test(String(app["@odata.type"])) ? "store" : "app");

    // Detail je App: Kommandozeilen, Erkennung und Rückgabecodes stehen in der
    // Sammelabfrage nicht zuverlässig drin (siehe appHygiene).
    let full = app;
    if (wantDetails && detailCount < 200 && /win32|winGet|officeSuite|MSI|macOS/i.test(String(app["@odata.type"]))) {
      detailCount++;
      try { full = { ...app, ...(await graphReq(tenant, cert, "GET", `/deviceAppManagement/mobileApps/${encodeURIComponent(app.id)}`, null, BETA)) }; }
      catch (e) { /* dann eben mit den Listendaten */ }
    }

    const assignments = [];
    const devices = new Map();
    const users = new Map();
    const excludedDevices = new Set();
    for (const as of app.assignments || []) {
      const kind = targetKind(as.target);
      const gid = as.target && as.target.groupId;
      const row = {
        id: as.id || null,
        intent: as.intent || "",
        intentLabel: INTENT_LABEL[as.intent] || as.intent || "",
        targetKind: kind,
        exclude: kind === "exclusion",
        filter: describeFilter(as.target, filters),
        settings: settingsSummary(as.settings),
        group: null,
        deviceCount: null,
        userCount: null
      };
      if (gid) {
        const g = await R.group(gid);
        const cls = await R.classify(gid);
        const mem = await R.members(gid);
        row.group = {
          id: gid,
          displayName: g.displayName,
          kind: cls.kind,
          kindLabel: cls.label,
          dynamic: g.dynamic,
          rule: g.rule,
          tags: g.tags,
          memberGroups: mem.groups.map(x => ({ id: x.id, displayName: x.displayName })),
          directDevices: mem.devices.length,
          directUsers: mem.users.length,
          sharedWith: [...(groupUse.get(gid) || [])].filter(n => n !== app.displayName)
        };
        if (opts.devices !== false && cls.kind !== "missing") {
          const ex = await R.expand(gid);
          // Untergruppen mit ihrer Art, damit der Weg lesbar bleibt
          for (const sg of row.group.memberGroups) {
            const c = await R.classify(sg.id);
            const sgi = await R.group(sg.id);
            sg.kind = c.kind; sg.kindLabel = c.label; sg.tags = sgi.tags;
          }
          row.deviceCount = ex.devices.size;
          row.userCount = ex.users.size;
          row.cyclic = ex.cyclic;
          for (const d of ex.devices.values()) {
            if (row.exclude) { excludedDevices.add(d.id); continue; }
            if (!devices.has(d.id)) devices.set(d.id, { d, intents: new Set([row.intentLabel]), vias: [(d.paths[0] || []).join(" › ")] });
            else { const e = devices.get(d.id); e.intents.add(row.intentLabel); e.vias.push((d.paths[0] || []).join(" › ")); }
          }
          if (!row.exclude) for (const u of ex.users.values()) if (!users.has(u.id)) users.set(u.id, { ...u, via: (u.paths[0] || []).join(" › "), intent: row.intentLabel });
        }
      }
      assignments.push(row);
    }
    for (const id of excludedDevices) devices.delete(id);

    // Installationsbericht — nur wenn gewünscht und die App überhaupt Geräte erreicht.
    let install = null;
    if (opts.installStatus && (app.assignments || []).length) {
      install = await loadInstallStatus(tenant, cert, app.id);
    }

    const deviceRows = [...devices.values()].map(({ d, intents, vias }) => {
      let inst = null;
      if (install && install.ok) {
        inst = (d.deviceId && install.byDeviceId.get(String(d.deviceId).toLowerCase()))
          || install.byName.get(String(d.displayName || "").toLowerCase()) || null;
      }
      return deviceRow(d, managed, {
        intent: [...intents].join(", "),
        via: vias[0],
        viaCount: vias.length,
        install: inst ? inst.state : null,
        installLabel: inst ? (INSTALL_LABEL[inst.state] || inst.state) : null,
        installDetail: inst ? [inst.detail, inst.error].filter(x => x && x !== "0x0").join(" · ") : null
      });
    }).sort((a, b) => String(a.name).localeCompare(String(b.name)));

    const findings = appFindings(app, assignments, managedBy, tenantId, existingAppGroups);
    const status = findings.some(f => f.fix) ? "fix"
      : findings.some(f => f.severity === "fehler" || f.severity === "warn") ? "manual"
        : (app.assignments || []).length ? "ok" : "unassigned";

    const installSummary = {};
    for (const r of deviceRows) if (r.install) installSummary[r.install] = (installSummary[r.install] || 0) + 1;

    out.push({
      id: app.id,
      displayName: app.displayName,
      publisher: app.publisher || "",
      version: full.displayVersion || full.version || null,
      type: type.label,
      platform: type.platform,
      managedBy,
      managedByLabel: { pmp: "Patch My PC", store: "Microsoft/Store", app: "selbst paketiert" }[managedBy],
      createdDateTime: fmtIso(app.createdDateTime),
      lastModifiedDateTime: fmtIso(app.lastModifiedDateTime),
      expectedGroup: expectedAppGroupName(app, managedBy, tenantId),
      config: appConfig(full),
      assignments,
      findings,
      status,
      devices: deviceRows,
      users: [...users.values()].map(u => ({ name: u.displayName, upn: u.upn, via: u.via, intent: u.intent })),
      install: install ? { ok: install.ok, error: install.error || null, summary: installSummary } : null
    });
  }

  const rank = { fix: 0, manual: 1, ok: 2, unassigned: 3 };
  out.sort((a, b) => (rank[a.status] - rank[b.status]) || String(a.displayName).localeCompare(String(b.displayName)));

  // Geräte-Sicht: welches Gerät bekommt welche App, über welche Gruppe
  const byDevice = new Map();
  for (const a of out) for (const d of a.devices) {
    if (!byDevice.has(d.id)) byDevice.set(d.id, { name: d.name, groupTag: d.groupTag, user: d.user, os: d.os, apps: [] });
    byDevice.get(d.id).apps.push({ app: a.displayName, intent: d.intent, via: d.via, install: d.installLabel || null });
  }

  const conv = NAMING.forTenant(tenantId);
  return {
    kind: "apps",
    generatedAt: new Date().toISOString(),
    convention: { profile: conv.profile, appGroup: conv.templates.appGroup, pmpGroup: conv.templates.pmpGroup, deviceGroup: conv.templates.deviceGroup },
    readable: { managedDevices: managedRes.ok, managedDevicesError: managedRes.error || null, installStatus: !!opts.installStatus },
    gaps: [...R.gaps],
    summary: {
      apps: out.length,
      assigned: out.filter(a => a.assignments.length).length,
      ok: out.filter(a => a.status === "ok").length,
      fix: out.filter(a => a.status === "fix").length,
      manual: out.filter(a => a.status === "manual").length,
      unassigned: out.filter(a => a.status === "unassigned").length,
      devices: byDevice.size
    },
    apps: out,
    byDevice: [...byDevice.values()].sort((a, b) => String(a.name).localeCompare(String(b.name))),
    existingAppGroups: existingAppGroups.map(g => ({ id: g.id, displayName: g.displayName, managed: g.managed, memberGroups: g.memberGroups })),
    groups: opts.devices === false ? [] : await R.inventory()
  };
}

/**
 * Befunde einer App gegen das Konzept. `fix: true` heisst: der Fixer kann das
 * automatisch geraderücken (App-Gruppe anlegen/verwenden, Gerätegruppe
 * verschachteln, Direktzuweisung entfernen).
 */
function appFindings(app, assignments, managedBy, tenantId, existingAppGroups) {
  const f = [];
  const add = (code, severity, text, fix, extra) => f.push({ code, severity, text, fix: !!fix, ...(extra || {}) });
  const incl = assignments.filter(a => !a.exclude);

  if (!assignments.length) {
    add("unassigned", "hinweis", "Keine Zuweisung — die App erreicht kein Gerät.");
    return f;
  }

  const directDevice = incl.filter(a => a.group && a.group.kind === "deviceGroup" && a.intent !== "uninstall");
  const appGroupAs = incl.filter(a => a.group && (a.group.kind === "appGroup" || a.group.kind === "container"));
  const requiredDirect = directDevice.filter(a => a.intent === "required");

  if (directDevice.length) {
    const names = directDevice.map(a => `${a.group.displayName} (${a.intentLabel})`).join(", ");
    // Umgestellt wird ein Intent je App (Erforderlich vor allem anderen) — und
    // nur, wenn die umzustellenden Zuweisungen denselben Filter tragen. Welcher
    // Filter sonst für die App-Gruppe gälte, ist eine Entscheidung.
    const migrate = requiredDirect.length ? requiredDirect : directDevice.filter(a => a.intent === directDevice[0].intent);
    const filterKeys = new Set(migrate.map(a => a.filter ? a.filter.id + "|" + a.filter.mode : "none"));
    const fixable = filterKeys.size <= 1;
    add("directDevice", "fehler",
      `Direkt an Gerätegruppe zugewiesen: ${names}. Nach Konzept hängt die App an genau einer App-Gruppe, die Gerätegruppen sind darin verschachtelt.`
      + (fixable ? "" : " Die Direktzuweisungen tragen unterschiedliche Zuweisungsfilter — vor dem Umstellen entscheiden, welcher für die App-Gruppe gilt."),
      fixable);
  }
  const redundant = directDevice.filter(a => appGroupAs.some(ag => (ag.group.memberGroups || []).some(m => m.id === a.group.id)));
  if (redundant.length) {
    add("redundant", "warn", `Doppelt adressiert: ${redundant.map(a => a.group.displayName).join(", ")} ist schon Mitglied der App-Gruppe und zusätzlich direkt zugewiesen.`, true);
  }
  const uninstallDirect = incl.filter(a => a.intent === "uninstall" && a.group && a.group.kind === "deviceGroup");
  if (uninstallDirect.length) {
    add("uninstallDirect", "warn", `Deinstallation direkt an Gerätegruppe: ${uninstallDirect.map(a => a.group.displayName).join(", ")} — manuell prüfen, der Fixer fasst Deinstallationen nicht an.`);
  }
  for (const a of incl) {
    if (a.targetKind === "allDevices") add("allDevices", "warn", `Zuweisung an „Alle Geräte“ (${a.intentLabel}) — am Gruppenkonzept vorbei, grosser Wirkungsradius.`);
    if (a.targetKind === "allUsers") add("allUsers", "warn", `Zuweisung an „Alle Benutzer“ (${a.intentLabel}) — am Gruppenkonzept vorbei.`);
    if (a.group && a.group.kind === "missing") add("missingGroup", "fehler", `Zuweisung zeigt auf eine gelöschte Gruppe (${a.group.id}).`);
    if (a.group && a.group.kind === "mixed") add("mixedGroup", "warn", `„${a.group.displayName}“ enthält Geräte und Benutzer gemischt.`);
    if (a.group && a.group.kind === "empty") add("emptyGroup", "warn", `„${a.group.displayName}“ ist leer — die Zuweisung erreicht niemanden.`);
    if (a.group && a.group.kind === "userGroup" && a.intent === "required" && /Windows|macOS/.test(appTypeOf(app).platform)) {
      add("userRequired", "hinweis", `Erforderlich an Benutzergruppe „${a.group.displayName}“ — das Gerätekonzept adressiert Geräte, nicht Personen.`);
    }
  }
  for (const a of appGroupAs) {
    const g = a.group;
    if (g.kind === "appGroup" && !g.memberGroups.length && !g.directDevices) add("appGroupEmpty", "warn", `App-Gruppe „${g.displayName}“ hat keine verschachtelte Gerätegruppe — die App erreicht darüber kein Gerät.`);
    if (g.directDevices || g.directUsers) add("appGroupDirect", "hinweis", `App-Gruppe „${g.displayName}“ enthält ${g.directDevices + g.directUsers} direkte(s) Mitglied(er) — nach Konzept stehen dort nur Gerätegruppen.`);
    if (g.sharedWith && g.sharedWith.length) add("appGroupShared", "warn", `App-Gruppe „${g.displayName}“ wird auch von ${g.sharedWith.join(", ")} benutzt — eine App-Gruppe gehört genau einer App.`);
    const expected = expectedAppGroupName(app, managedBy, tenantId);
    if (g.kind === "container") {
      add("appGroupName", "hinweis", `„${g.displayName}“ arbeitet als App-Gruppe, heisst aber nicht nach Konvention (${expected}).`, false,
        { rename: { groupId: g.id, from: g.displayName, to: expected } });
    } else {
      const prefix = conventionPrefix(managedBy, tenantId);
      if (prefix && !g.displayName.toLowerCase().startsWith(prefix.toLowerCase())) {
        add("appGroupScheme", "hinweis", `„${g.displayName}“ folgt einem anderen Namensschema als der Tenant (Soll: ${expected}).`, false,
          { rename: { groupId: g.id, from: g.displayName, to: expected } });
      }
      const expSuffix = groupSuffix(expected, tenantId);
      const isSuffix = groupSuffix(g.displayName, tenantId);
      if (isSuffix && expSuffix && !expSuffix.startsWith(isSuffix) && !isSuffix.startsWith(expSuffix)) {
        add("appGroupOtherName", "hinweis", `App-Gruppe „${g.displayName}“ passt vom Namen her nicht zur App.`);
      }
    }
  }
  const reqGroups = incl.filter(a => a.intent === "required" && a.group && (a.group.kind === "appGroup" || a.group.kind === "container"));
  if (reqGroups.length > 1) add("multipleAppGroups", "warn", `Mehrere App-Gruppen unter „Erforderlich“: ${reqGroups.map(a => a.group.displayName).join(", ")}.`);
  if (managedBy === "pmp" && f.some(x => x.fix)) {
    add("pmpNote", "hinweis", "Patch-My-PC-App: Die Zuweisung auch in Patch My PC auf die App-Gruppe umstellen, sonst kann PMP sie beim nächsten Update wieder direkt setzen.");
  }
  return f;
}

// ============================================================== Richtlinien
const POLICY_SOURCES = [
  { key: "configurationPolicies", label: "Settings Catalog", path: "/deviceManagement/configurationPolicies?$expand=assignments&$top=50", name: p => p.name,
    platform: p => String(p.platforms || "") },
  { key: "deviceCompliancePolicies", label: "Compliance", path: "/deviceManagement/deviceCompliancePolicies?$expand=assignments&$top=100", name: p => p.displayName,
    platform: p => platformFromType(p["@odata.type"]) },
  { key: "deviceConfigurations", label: "Gerätekonfiguration", path: "/deviceManagement/deviceConfigurations?$expand=assignments&$top=100", name: p => p.displayName,
    platform: p => platformFromType(p["@odata.type"]) },
  { key: "groupPolicyConfigurations", label: "Administrative Vorlage", path: "/deviceManagement/groupPolicyConfigurations?$expand=assignments&$top=100", name: p => p.displayName,
    platform: () => "windows10" },
  { key: "windowsFeatureUpdateProfiles", label: "Funktionsupdate", path: "/deviceManagement/windowsFeatureUpdateProfiles?$expand=assignments", name: p => p.displayName,
    platform: () => "windows10" },
  { key: "windowsQualityUpdateProfiles", label: "Qualitätsupdate", path: "/deviceManagement/windowsQualityUpdateProfiles?$expand=assignments", name: p => p.displayName,
    platform: () => "windows10" },
  { key: "windowsDriverUpdateProfiles", label: "Treiberupdate", path: "/deviceManagement/windowsDriverUpdateProfiles?$expand=assignments", name: p => p.displayName,
    platform: () => "windows10" },
  { key: "intents", label: "Endpoint Security (Vorlage)", path: "/deviceManagement/intents?$top=100", name: p => p.displayName,
    platform: () => "windows10", assignmentsSeparate: true }
];

function platformFromType(t) {
  const s = String(t || "").toLowerCase();
  if (s.includes("macos")) return "macOS";
  if (s.includes("ios")) return "iOS";
  if (s.includes("android")) return "android";
  if (s.includes("windows") || s.includes("win10")) return "windows10";
  return "";
}

function platformLabel(p) {
  const s = String(p || "").toLowerCase();
  if (s.includes("windows")) return "Windows";
  if (s.includes("macos")) return "macOS";
  if (s.includes("ios")) return "iOS";
  if (s.includes("android")) return "Android";
  return p || "—";
}

function isOib(name) { return /^(Win|MacOS) - OIB - /i.test(String(name || "")); }

/**
 * OIB-Namen zerlegen: "Win - OIB - ES - Defender Antivirus - D - AV Configuration - v3.6"
 * -> Bereich, Geltung (Gerät/Benutzer), Inhalt, Version. Das ist bei OIB die beste
 * Kurzbeschreibung, die es gibt — die Richtlinien tragen selten eine Beschreibung.
 */
function parseOibName(name) {
  const n = String(name || "");
  // Bereich ist optional: "Win - OIB - WUfB - D - Ring 1 - v3.1" hat keinen.
  const m = n.match(/^(Win|MacOS) - OIB - (?:(ES|SC|TP|WUfB Drivers|WUfB|Compliance) - )?(?:(.+?) - )?([DU]) - (.+?)(?: - (v[\d.]+))?$/i);
  if (!m) return null;
  const typ = { ES: "Endpoint Security", SC: "Settings Catalog", TP: "Vorlage", WUfB: "Windows Update", "WUfB Drivers": "Treiber-Updates", Compliance: "Compliance" }[m[2]] || m[2] || "";
  return { plattform: m[1] === "Win" ? "Windows" : "macOS", typ, bereich: m[3] || typ, geltung: m[4].toUpperCase() === "D" ? "Gerät" : "Benutzer", inhalt: m[5], version: m[6] || null };
}

// ---- Einstellungen lesbar machen
const SKIP_PROPS = new Set(["id", "createdDateTime", "lastModifiedDateTime", "version", "displayName", "description", "roleScopeTagIds",
  "supportsScopeTags", "assignments", "deviceManagementApplicabilityRuleOsEdition", "deviceManagementApplicabilityRuleOsVersion",
  "deviceManagementApplicabilityRuleDeviceMode", "scheduledActionsForRule", "createdBy", "lastModifiedBy", "isAssigned", "templateId",
  "settingCount", "creationSource", "priorityMetaData", "technologies", "platforms", "name", "templateReference", "deviceStatuses", "userStatuses",
  "deviceStatusOverview", "userStatusOverview", "deviceSettingStateSummaries", "groupAssignments", "policySetItems", "assignedAccessMultiModeProfiles"]);

const PROP_LABEL = {
  passwordRequired: "Kennwort erforderlich",
  passwordBlockSimple: "Einfache Kennwörter blockieren",
  passwordMinimumLength: "Kennwort-Mindestlänge",
  passwordRequiredType: "Kennworttyp",
  passwordMinutesOfInactivityBeforeLock: "Sperre nach Inaktivität (min)",
  passwordExpirationDays: "Kennwortablauf (Tage)",
  passwordPreviousPasswordBlockCount: "Kennwort-Historie",
  requireHealthyDeviceReport: "Integritätsbericht erforderlich",
  osMinimumVersion: "Mindest-Betriebssystem",
  osMaximumVersion: "Höchst-Betriebssystem",
  bitLockerEnabled: "BitLocker erforderlich",
  secureBootEnabled: "Secure Boot erforderlich",
  codeIntegrityEnabled: "Codeintegrität erforderlich",
  storageRequireEncryption: "Speicherverschlüsselung erforderlich",
  activeFirewallRequired: "Firewall erforderlich",
  defenderEnabled: "Defender erforderlich",
  defenderVersion: "Defender-Mindestversion",
  signatureOutOfDate: "Signaturen aktuell",
  rtpEnabled: "Echtzeitschutz erforderlich",
  antivirusRequired: "Antivirus erforderlich",
  antiSpywareRequired: "Antispyware erforderlich",
  deviceThreatProtectionEnabled: "Gerätebedrohungsschutz erforderlich",
  deviceThreatProtectionRequiredSecurityLevel: "Maximal zulässige Bedrohungsstufe",
  tpmRequired: "TPM erforderlich",
  configurationManagerComplianceRequired: "ConfigMgr-Compliance erforderlich",
  systemIntegrityProtectionEnabled: "Systemintegritätsschutz (macOS)",
  firewallEnabled: "Firewall aktiv",
  firewallBlockAllIncoming: "Alle eingehenden Verbindungen blockieren",
  firewallEnableStealthMode: "Tarnmodus",
  gatekeeperAllowedAppSource: "Gatekeeper: erlaubte App-Quellen",
  qualityUpdatesDeferralPeriodInDays: "Qualitätsupdates zurückstellen (Tage)",
  featureUpdatesDeferralPeriodInDays: "Funktionsupdates zurückstellen (Tage)",
  deadlineForQualityUpdatesInDays: "Stichtag Qualitätsupdates (Tage)",
  deadlineForFeatureUpdatesInDays: "Stichtag Funktionsupdates (Tage)",
  deadlineGracePeriodInDays: "Karenzzeit (Tage)",
  automaticUpdateMode: "Automatische Updates",
  microsoftUpdateServiceAllowed: "Microsoft Update erlaubt",
  driversExcluded: "Treiber ausschliessen",
  businessReadyUpdatesOnly: "Update-Kanal",
  allowWindows11Upgrade: "Upgrade auf Windows 11 erlaubt",
  featureUpdateVersion: "Funktionsupdate-Version",
  approvalType: "Freigabe",
  deploymentDeferralInDays: "Verzögerung (Tage)",
  expeditedUpdateSettings: "Beschleunigtes Qualitätsupdate",
  userPauseAccess: "Pausieren durch Benutzer",
  userWindowsUpdateScanAccess: "Updatesuche durch Benutzer"
};

function humanizeKey(k) {
  if (PROP_LABEL[k]) return PROP_LABEL[k];
  return String(k)
    .replace(/^deviceConfiguration--/, "")
    .replace(/^[a-zA-Z0-9]+_/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/^./, c => c.toUpperCase());
}

function valueText(v) {
  if (v === true) return "Ja";
  if (v === false) return "Nein";
  if (v === null || v === undefined || v === "") return null;
  if (Array.isArray(v)) {
    if (!v.length) return null;
    return v.map(x => (typeof x === "object" ? (x.displayName || x.name || JSON.stringify(x)) : String(x))).join(", ").slice(0, 300);
  }
  if (typeof v === "object") {
    const inner = Object.entries(v).filter(([k, x]) => !k.startsWith("@odata") && x !== null && x !== "" && !(Array.isArray(x) && !x.length))
      .map(([k, x]) => `${humanizeKey(k)}: ${typeof x === "object" ? JSON.stringify(x) : x}`);
    return inner.length ? inner.join("; ").slice(0, 300) : null;
  }
  return String(v).slice(0, 300);
}

/** Skalare Eigenschaften einer Richtlinie (Compliance, Vorlagen, Update-Ringe). */
function propertySettings(obj) {
  const out = [];
  for (const [k, v] of Object.entries(obj || {})) {
    if (k.startsWith("@odata") || SKIP_PROPS.has(k)) continue;
    const text = valueText(v);
    if (text === null) continue;
    if (v === false && !PROP_LABEL[k]) continue; // "nein" bei unbekannten Schaltern ist Standard — Rauschen
    if (/^(notConfigured|userDefined|none)$/i.test(text)) continue;
    out.push({ label: humanizeKey(k), value: text, depth: 0 });
  }
  return out;
}

/** Settings-Catalog: Einstellungsbaum mit Anzeigenamen aus den Definitionen. */
function flattenCatalogSettings(items) {
  const out = [];
  for (const item of items || []) {
    const defs = new Map((item.settingDefinitions || []).map(d => [d.id, d]));
    const label = id => { const d = defs.get(id); return d ? (d.displayName || d.name || id) : humanizeKey(String(id || "").split("_").pop()); };
    const optionLabel = (defId, itemId) => {
      const d = defs.get(defId);
      const o = d && (d.options || []).find(x => x.itemId === itemId);
      return o ? (o.displayName || o.name || itemId) : String(itemId || "").split("_").pop();
    };
    const walk = (inst, depth) => {
      if (!inst) return;
      const t = String(inst["@odata.type"] || "");
      const defId = inst.settingDefinitionId;
      if (/ChoiceSettingInstance$/i.test(t)) {
        const cv = inst.choiceSettingValue || {};
        out.push({ label: label(defId), value: optionLabel(defId, cv.value), depth });
        (cv.children || []).forEach(c => walk(c, depth + 1));
      } else if (/ChoiceSettingCollectionInstance$/i.test(t)) {
        const vals = (inst.choiceSettingCollectionValue || []).map(v => optionLabel(defId, v.value));
        out.push({ label: label(defId), value: vals.join(", "), depth });
      } else if (/SimpleSettingInstance$/i.test(t)) {
        const v = inst.simpleSettingValue || {};
        const secret = /secret/i.test(String(v["@odata.type"] || ""));
        out.push({ label: label(defId), value: secret ? "(geheim)" : String(v.value === undefined ? "" : v.value), depth });
      } else if (/SimpleSettingCollectionInstance$/i.test(t)) {
        const vals = (inst.simpleSettingCollectionValue || []).map(v => String(v.value));
        out.push({ label: label(defId), value: vals.join(", ").slice(0, 400), depth });
      } else if (/GroupSettingCollectionInstance$/i.test(t)) {
        const groups = inst.groupSettingCollectionValue || [];
        out.push({ label: label(defId), value: groups.length > 1 ? `${groups.length} Einträge` : "", depth });
        groups.forEach(g => (g.children || []).forEach(c => walk(c, depth + 1)));
      } else if (/GroupSettingInstance$/i.test(t)) {
        out.push({ label: label(defId), value: "", depth });
        ((inst.groupSettingValue || {}).children || []).forEach(c => walk(c, depth + 1));
      } else {
        out.push({ label: label(defId), value: "(nicht darstellbar)", depth });
      }
    };
    walk(item.settingInstance, 0);
  }
  return out;
}

async function policySettings(tenant, cert, src, p) {
  try {
    if (src.key === "configurationPolicies") {
      const items = await graphAllPages(tenant, cert,
        `/deviceManagement/configurationPolicies/${p.id}/settings?$expand=settingDefinitions&$top=1000`, BETA);
      return { settings: flattenCatalogSettings(items) };
    }
    if (src.key === "intents") {
      const items = await graphAllPages(tenant, cert, `/deviceManagement/intents/${p.id}/settings`, BETA);
      return {
        settings: items.map(s => {
          let v = s.valueJson;
          try { v = JSON.parse(s.valueJson); } catch (e) { /* roh lassen */ }
          const text = valueText(v);
          return text === null ? null : { label: humanizeKey(s.definitionId), value: text, depth: 0 };
        }).filter(Boolean)
      };
    }
    if (src.key === "groupPolicyConfigurations") {
      const items = await graphAllPages(tenant, cert,
        `/deviceManagement/groupPolicyConfigurations/${p.id}/definitionValues?$expand=definition($select=displayName,categoryPath)`, BETA);
      return {
        settings: items.map(v => ({
          label: (v.definition && v.definition.displayName) || v.id,
          value: v.enabled ? "Aktiviert" : "Deaktiviert",
          depth: 0,
          category: v.definition && v.definition.categoryPath
        }))
      };
    }
    if (src.key === "deviceCompliancePolicies") {
      const full = await graphReq(tenant, cert, "GET",
        `/deviceManagement/deviceCompliancePolicies/${p.id}?$expand=scheduledActionsForRule($expand=scheduledActionConfigurations)`, null, BETA);
      const settings = propertySettings(full);
      for (const rule of full.scheduledActionsForRule || []) {
        for (const c of rule.scheduledActionConfigurations || []) {
          const what = { block: "Als nicht konform markieren", notification: "E-Mail an Benutzer", retire: "Gerät zur Außerbetriebnahme vormerken",
            remoteLock: "Gerät remote sperren", pushNotification: "Push-Benachrichtigung" }[c.actionType] || c.actionType;
          settings.push({ label: "Aktion bei Nichtkonformität", value: `${what} nach ${c.gracePeriodHours ? Math.round(c.gracePeriodHours / 24 * 10) / 10 + " Tag(en)" : "sofort"}`, depth: 0 });
        }
      }
      return { settings };
    }
    return { settings: propertySettings(p) };
  } catch (e) {
    return { settings: [], error: e.message };
  }
}

/**
 * Intune-Richtlinien mit Zuweisung, aufgelöst bis Gerät/Benutzer, und dem, was
 * sie einstellen. opts.scope: "oib" (Vorgabe) | "all".
 */
async function auditPolicies(tenant, cert, opts, onProgress) {
  opts = opts || {};
  const say = onProgress || (() => {});
  const scope = opts.scope === "all" ? "all" : "oib";
  const R = createResolver(tenant, cert);
  const filters = await loadFilters(tenant, cert);
  const managedRes = await loadManagedDevices(tenant, cert);
  const managed = managedRes.map;
  const sourceErrors = [];

  const raw = [];
  for (const src of POLICY_SOURCES) {
    say("Richtlinien laden: " + src.label);
    let list = [];
    try { list = await graphAllPages(tenant, cert, src.path, { beta: true, retryTransient: 8 }); }
    catch (e) { sourceErrors.push({ source: src.label, error: e.message }); continue; }
    for (const p of list) {
      const name = src.name(p) || p.id;
      if (scope === "oib" && !isOib(name)) continue;
      raw.push({ src, p, name });
    }
  }

  const out = [];
  let i = 0;
  for (const { src, p, name } of raw) {
    i++;
    if (i % 5 === 1) say(`Richtlinien auswerten (${i}/${raw.length})`);
    let asg = p.assignments || [];
    if (src.assignmentsSeparate) {
      try { asg = (await graphReq(tenant, cert, "GET", `/deviceManagement/intents/${p.id}/assignments`, null, BETA)).value || []; }
      catch (e) { asg = []; }
    }

    const assignments = [];
    const devices = new Map(), users = new Map();
    const exDevices = new Set(), exUsers = new Set();
    for (const a of asg) {
      const kind = targetKind(a.target);
      const gid = a.target && a.target.groupId;
      const row = { targetKind: kind, exclude: kind === "exclusion", filter: describeFilter(a.target, filters), group: null, deviceCount: null, userCount: null };
      if (gid) {
        const g = await R.group(gid);
        const cls = await R.classify(gid);
        row.group = { id: gid, displayName: g.displayName, kind: cls.kind, kindLabel: cls.label, dynamic: g.dynamic, tags: g.tags };
        if (cls.kind !== "missing") {
          const ex = await R.expand(gid);
          row.deviceCount = ex.devices.size;
          row.userCount = ex.users.size;
          row.nested = ex.groups.length > 0;
          row.nestedGroups = ex.groups.map(x => ({ id: x.id, displayName: x.displayName, tags: x.tags, dynamic: x.dynamic }));
          for (const d of ex.devices.values()) {
            if (row.exclude) exDevices.add(d.id);
            else if (!devices.has(d.id)) devices.set(d.id, d);
          }
          for (const u of ex.users.values()) {
            if (row.exclude) exUsers.add(u.id);
            else if (!users.has(u.id)) users.set(u.id, u);
          }
        }
      }
      assignments.push(row);
    }
    for (const id of exDevices) devices.delete(id);
    for (const id of exUsers) users.delete(id);

    const findings = [];
    const incl = assignments.filter(a => !a.exclude);
    if (!incl.length) findings.push({ severity: "warn", text: "Nicht zugewiesen — die Richtlinie wirkt nirgends." });
    for (const a of incl) {
      if (a.targetKind === "allDevices") findings.push({ severity: "hinweis", text: "Zuweisung an „Alle Geräte“." });
      if (a.targetKind === "allUsers") findings.push({ severity: "hinweis", text: "Zuweisung an „Alle Benutzer“." });
      if (a.group && a.group.kind === "missing") findings.push({ severity: "fehler", text: "Zuweisung zeigt auf eine gelöschte Gruppe." });
      if (a.group && a.group.kind === "empty") findings.push({ severity: "warn", text: `„${a.group.displayName}“ ist leer.` });
      if (a.group && a.group.kind === "appGroup") findings.push({ severity: "hinweis", text: `An App-Gruppe „${a.group.displayName}“ zugewiesen — Richtlinien gehören an die Gerätegruppe.` });
    }
    const parsed = parseOibName(name);
    if (parsed && parsed.geltung === "Gerät" && incl.some(a => a.group && a.group.kind === "userGroup")) {
      findings.push({ severity: "hinweis", text: "Geräterichtlinie (D) an Benutzergruppe zugewiesen." });
    }

    say(`Einstellungen lesen (${i}/${raw.length})`);
    const set = opts.settings === false ? { settings: [] } : await policySettings(tenant, cert, src, p);

    out.push({
      id: p.id,
      name,
      source: src.key,
      type: src.label,
      platform: platformLabel(src.platform(p)),
      oib: isOib(name),
      oibParts: parsed,
      description: p.description || "",
      createdDateTime: fmtIso(p.createdDateTime),
      lastModifiedDateTime: fmtIso(p.lastModifiedDateTime),
      assignments,
      findings,
      settings: set.settings.slice(0, 400),
      settingsTotal: set.settings.length,
      settingsError: set.error || null,
      devices: [...devices.values()].map(d => deviceRow(d, managed)).sort((a, b) => String(a.name).localeCompare(String(b.name))),
      users: [...users.values()].map(u => ({ name: u.displayName, upn: u.upn, via: (u.paths[0] || []).join(" › ") }))
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));

  // Abdeckung: welche Gerätegruppe bekommt welche Richtlinie — auch über eine
  // verschachtelte Gruppe — und welche nicht. Ein Ausschluss der Gruppe zählt als "nicht".
  const groupsSeen = new Map();
  const touch = (g, deviceCount) => {
    if (!groupsSeen.has(g.id)) groupsSeen.set(g.id, { id: g.id, displayName: g.displayName, tags: g.tags || [], devices: deviceCount, policies: new Set(), excluded: new Set() });
    return groupsSeen.get(g.id);
  };
  for (const p of out) for (const a of p.assignments) {
    if (!a.group) continue;
    const reached = [];
    if (a.group.kind === "deviceGroup") reached.push({ g: a.group, n: a.deviceCount });
    for (const ng of a.nestedGroups || []) if (ng.dynamic || (ng.tags && ng.tags.length)) reached.push({ g: ng, n: null });
    for (const { g, n } of reached) {
      const e = touch(g, n);
      if (a.exclude) e.excluded.add(p.id); else e.policies.add(p.id);
    }
  }
  const allDevicePolicies = out.filter(p => p.assignments.some(a => !a.exclude && a.targetKind === "allDevices")).map(p => p.id);
  for (const g of groupsSeen.values()) {
    if (g.devices === null || g.devices === undefined) {
      try { g.devices = (await R.expand(g.id)).devices.size; } catch (e) { /* bleibt offen */ }
    }
  }
  const coverage = [...groupsSeen.values()].map(g => {
    const has = new Set([...g.policies, ...allDevicePolicies].filter(id => !g.excluded.has(id)));
    const missing = out.filter(p => !has.has(p.id) && (!p.oibParts || p.oibParts.geltung === "Gerät")).map(p => p.name);
    return { id: g.id, displayName: g.displayName, tags: g.tags, devices: g.devices, assigned: has.size, missing };
  }).sort((a, b) => a.displayName.localeCompare(b.displayName));

  return {
    kind: "policies",
    scope,
    generatedAt: new Date().toISOString(),
    readable: { managedDevices: managedRes.ok, managedDevicesError: managedRes.error || null },
    gaps: [...R.gaps],
    sourceErrors,
    summary: {
      policies: out.length,
      assigned: out.filter(p => p.assignments.some(a => !a.exclude)).length,
      unassigned: out.filter(p => !p.assignments.some(a => !a.exclude)).length,
      withFindings: out.filter(p => p.findings.some(f => f.severity !== "hinweis")).length,
      devices: new Set(out.flatMap(p => p.devices.map(d => d.id))).size
    },
    policies: out,
    coverage,
    groups: await R.inventory()
  };
}

// ============================================================== Conditional Access
const CA_STATE = {
  enabled: "Aktiv",
  enabledForReportingButNotEnforced: "Nur Bericht (Report-only)",
  disabled: "Aus"
};

const WELL_KNOWN_APPS = {
  All: "Alle Cloud-Apps",
  None: "keine",
  Office365: "Office 365",
  MicrosoftAdminPortals: "Microsoft-Adminportale",
  "00000002-0000-0ff1-ce00-000000000000": "Exchange Online",
  "00000003-0000-0ff1-ce00-000000000000": "SharePoint Online",
  "00000003-0000-0000-c000-000000000000": "Microsoft Graph",
  "797f4846-ba00-4fd7-ba43-dac1f8f63013": "Windows Azure Service Management API",
  "d4ebce55-015a-49b5-a083-c84d1797ae8c": "Microsoft Intune Enrollment",
  "0000000a-0000-0000-c000-000000000000": "Microsoft Intune",
  "cc15fd57-2c6c-4117-a88c-83b1d56b4bbe": "Microsoft Teams Services",
  "1fec8e78-bce4-4aaf-ab1b-5451cc387264": "Microsoft Teams",
  "00000006-0000-0ff1-ce00-000000000000": "Microsoft 365 Portal",
  "c44b4083-3bb0-49c1-b47d-974e53cbdf3c": "Azure Portal",
  "372140e0-b3b7-4226-8ef9-d57986796201": "Azure Windows VM Sign-In",
  "38aa3b87-a06d-4817-b275-7a316988d93b": "Microsoft Remote Desktop / Windows Sign-In"
};

const USER_ACTIONS = {
  "urn:user:registersecurityinfo": "Sicherheitsinformationen registrieren",
  "urn:user:registerdevice": "Geräte registrieren oder beitreten"
};

// [Kurzform für Tabellen, Satzform für den Klartext]
const BUILTIN_CONTROLS = {
  mfa: ["MFA", "MFA"],
  compliantDevice: ["konformes Gerät", "ein konformes Gerät"],
  domainJoinedDevice: ["Hybrid-Join", "ein Hybrid-Entra-verbundenes Gerät"],
  approvedApplication: ["genehmigte App", "eine genehmigte Client-App"],
  compliantApplication: ["App-Schutz", "eine App-Schutzrichtlinie"],
  passwordChange: ["Kennwortänderung", "eine Kennwortänderung"],
  block: ["Blockieren", "Blockieren"]
};

const PLATFORM_LABEL = { all: "alle", android: "Android", iOS: "iOS", windows: "Windows", windowsPhone: "Windows Phone", macOS: "macOS", linux: "Linux" };

function joinOr(items, word) {
  if (items.length <= 1) return items.join("");
  return items.slice(0, -1).join(", ") + " " + word + " " + items[items.length - 1];
}

const CLIENT_APP_TYPES = {
  all: "alle Client-Apps",
  browser: "Browser",
  mobileAppsAndDesktopClients: "Mobile Apps und Desktop-Clients",
  exchangeActiveSync: "Exchange ActiveSync",
  easSupported: "Exchange ActiveSync",
  other: "andere (Legacy-Authentifizierung)"
};

const BUILTIN_STRENGTHS = {
  "00000000-0000-0000-0000-000000000002": "Multifaktor-Authentifizierung",
  "00000000-0000-0000-0000-000000000003": "Kennwortlose MFA",
  "00000000-0000-0000-0000-000000000004": "Phishing-resistente MFA"
};

const RISK = { low: "niedrig", medium: "mittel", high: "hoch", none: "keins", hidden: "verborgen" };

function list(arr) { return (arr || []).filter(Boolean); }

// ---- Auswirkungsprognose für Report-only-Richtlinien
// Entra wertet jede Anmeldung auch gegen Report-only-Richtlinien aus und schreibt
// das Ergebnis ins Anmeldeprotokoll, als wäre die Richtlinie scharf. Daraus lässt
// sich vor dem Scharfschalten ablesen, wen es treffen würde — und warum.
const ENFORCED_LABEL = {
  mfa: "MFA", block: "Blockieren", requirecompliantdevice: "konformes Gerät", compliantdevice: "konformes Gerät",
  requiredomainjoineddevice: "Hybrid-Join", domainjoineddevice: "Hybrid-Join", requireapprovedapp: "genehmigte App",
  approvedapplication: "genehmigte App", requirecompliantapp: "App-Schutz", compliantapplication: "App-Schutz",
  passwordchange: "Kennwortänderung", requirepasswordchange: "Kennwortänderung", termsofuse: "Nutzungsbedingungen"
};
function enforcedText(arr) {
  return [...new Set((arr || []).map(x => ENFORCED_LABEL[String(x).toLowerCase().replace(/[^a-z]/g, "")] || x))].join(", ");
}

const VERDICT = {
  blocked: "würde blockiert",
  setup: "müsste MFA einrichten",
  prompt: "würde zusätzlich gefragt",
  ok: "erfüllt",
  na: "nicht zutreffend"
};

async function buildForecast(tenant, cert, pols, signIns, userById, info) {
  const ro = pols.filter(p => p.state === "enabledForReportingButNotEnforced");
  const disabled = pols.filter(p => p.state === "disabled").map(p => p.name);
  const complete = !(info.capped || info.nonInteractiveCapped || info.nonInteractiveError);

  // MFA-Registrierung aller Konten in einem Aufruf (braucht Entra ID P1).
  let reg = null, regError = null;
  try {
    const listReg = await graphAllPages(tenant, cert, "/reports/authenticationMethods/userRegistrationDetails?$top=999", V1);
    reg = new Map(listReg.map(r => [r.id, r]));
  } catch (e) { regError = e.message; }

  const rank = { reportOnlyFailure: 3, reportOnlyInterrupted: 2, reportOnlySuccess: 1, reportOnlyNotApplied: 0 };
  const byUser = new Map();
  const out = [];
  for (const p of ro) {
    const per = new Map();
    for (const si of signIns) {
      const ap = (si.appliedConditionalAccessPolicies || []).find(a => a.id === p.id);
      if (!ap) continue;
      const uid = si.userId || si.userPrincipalName;
      if (!per.has(uid)) per.set(uid, { worst: null, total: 0, bad: 0, upn: si.userPrincipalName, name: si.userDisplayName, samples: [], lastAt: null, requires: [] });
      const e = per.get(uid);
      e.total++;
      const r = ap.result;
      if ((rank[r] ?? -1) > (rank[e.worst] ?? -1)) e.worst = r;
      if (r === "reportOnlyFailure" || r === "reportOnlyInterrupted") {
        e.bad++;
        if (!e.lastAt || String(si.createdDateTime) > e.lastAt) e.lastAt = si.createdDateTime;
        const dd = si.deviceDetail || {};
        const sample = [
          dd.operatingSystem || "Betriebssystem unbekannt",
          dd.displayName ? dd.displayName : "Gerät nicht registriert",
          dd.isCompliant ? "konform" : "nicht konform",
          dd.isManaged ? null : "nicht verwaltet",
          si.appDisplayName || null,
          si.clientAppUsed ? "Client: " + si.clientAppUsed : null,
          si._nonInteractive ? "nicht interaktiv" : null
        ].filter(Boolean).join(" · ");
        if (e.samples.length < 3 && !e.samples.includes(sample)) e.samples.push(sample);
        e.requires = e.requires.concat(ap.enforcedGrantControls || []);
      }
    }

    const rows = [];
    for (const [uid, e] of per) {
      const u = userById.get(uid) || {};
      const upn = e.upn || u.userPrincipalName || uid;
      const mfa = reg ? reg.get(uid) : null;
      const mfaRegistered = reg ? !!(mfa && mfa.isMfaRegistered) : null;
      let verdict = "na";
      if (e.worst === "reportOnlyFailure") verdict = "blocked";
      else if (e.worst === "reportOnlyInterrupted") {
        const wantsMfa = p._requiresMfa || e.requires.some(x => /mfa/i.test(String(x)));
        verdict = (wantsMfa && mfaRegistered === false) ? "setup" : "prompt";
      }
      else if (e.worst === "reportOnlySuccess") verdict = "ok";
      const row = {
        upn, name: e.name || u.displayName || upn, guest: String(u.userType || "").toLowerCase() === "guest",
        verdict, verdictLabel: VERDICT[verdict], bad: e.bad, total: e.total, lastAt: e.lastAt,
        requires: enforcedText(e.requires) || p.effectShort,
        samples: e.samples,
        mfaRegistered, methods: mfa ? (mfa.methodsRegistered || []) : null
      };
      rows.push(row);
      if (verdict === "blocked" || verdict === "setup" || verdict === "prompt") {
        if (!byUser.has(upn)) byUser.set(upn, { upn, name: row.name, guest: row.guest, worst: verdict, policies: [] });
        const bu = byUser.get(upn);
        bu.policies.push({ name: p.name, verdict, verdictLabel: VERDICT[verdict], requires: row.requires, sample: row.samples[0] || null });
        if (["blocked", "setup", "prompt"].indexOf(verdict) < ["blocked", "setup", "prompt"].indexOf(bu.worst)) bu.worst = verdict;
      }
    }
    const seen = new Set(per.keys());
    const noData = [...(p._eff || [])].filter(id => !seen.has(id)).map(id => userById.get(id))
      .filter(u => u && u.accountEnabled !== false)
      .map(u => ({ upn: u.userPrincipalName, name: u.displayName, guest: String(u.userType || "").toLowerCase() === "guest" }));
    const pick = v => rows.filter(r => r.verdict === v).sort((a, b) => b.bad - a.bad);
    out.push({
      id: p.id, name: p.name, effect: p.effectShort,
      blocked: pick("blocked"), setup: pick("setup"), prompt: pick("prompt"),
      ok: pick("ok").length, notApplicable: pick("na").length,
      noData: noData.sort((a, b) => String(a.upn).localeCompare(String(b.upn)))
    });
  }

  const users = [...byUser.values()].sort((a, b) =>
    ["blocked", "setup", "prompt"].indexOf(a.worst) - ["blocked", "setup", "prompt"].indexOf(b.worst) || String(a.upn).localeCompare(String(b.upn)));
  const noDataAll = new Set(out.flatMap(p => p.noData.map(u => u.upn)));
  return {
    window: info,
    complete,
    mfaRegistration: reg ? "ok" : regError,
    disabledNotEvaluated: disabled,
    summary: {
      reportOnly: ro.length,
      blockedUsers: users.filter(u => u.worst === "blocked").length,
      setupUsers: users.filter(u => u.worst === "setup").length,
      promptUsers: users.filter(u => u.worst === "prompt").length,
      noDataUsers: noDataAll.size
    },
    policies: out,
    users
  };
}

/**
 * Conditional-Access-Richtlinien lesbar machen und auflösen, für wen sie gelten.
 * opts.signIns: Anmeldeprotokoll der letzten opts.signInDays Tage auswerten
 * (zeigt bei Report-only-Richtlinien, was sie scharf bewirkt hätten).
 */
async function auditConditionalAccess(tenant, cert, opts, onProgress) {
  opts = opts || {};
  const say = onProgress || (() => {});
  const gaps = [];

  say("Richtlinien laden");
  const policies = await graphAllPages(tenant, cert, "/identity/conditionalAccess/policies", V1);

  // Ohne CA-Richtlinien kann MFA trotzdem über die Sicherheitsstandards erzwungen sein.
  let securityDefaults = null;
  try {
    const sd = await graphReq(tenant, cert, "GET", "/policies/identitySecurityDefaultsEnforcementPolicy", null, V1);
    securityDefaults = !!sd.isEnabled;
  } catch (e) { gaps.push("Sicherheitsstandards nicht lesbar: " + e.message); }

  say("Standorte, Rollen und Authentifizierungsstärken laden");
  const namedLocations = new Map();
  try {
    for (const l of await graphAllPages(tenant, cert, "/identity/conditionalAccess/namedLocations", V1)) {
      const t = String(l["@odata.type"] || "");
      namedLocations.set(l.id, {
        name: l.displayName,
        detail: /countryNamedLocation/i.test(t) ? "Länder: " + list(l.countriesAndRegions).join(", ")
          : /ipNamedLocation/i.test(t) ? `${(l.ipRanges || []).length} IP-Bereich(e)${l.isTrusted ? ", vertrauenswürdig" : ""}` : ""
      });
    }
  } catch (e) { gaps.push("Benannte Standorte nicht lesbar: " + e.message); }

  const roleNames = new Map();
  try {
    for (const r of await graphAllPages(tenant, cert, "/roleManagement/directory/roleDefinitions?$select=id,displayName,templateId", V1)) {
      roleNames.set(r.templateId || r.id, r.displayName);
      roleNames.set(r.id, r.displayName);
    }
  } catch (e) { gaps.push("Rollendefinitionen nicht lesbar: " + e.message); }

  const strengths = new Map(Object.entries(BUILTIN_STRENGTHS));
  try {
    for (const s of await graphAllPages(tenant, cert, "/policies/authenticationStrengthPolicies?$select=id,displayName", V1)) strengths.set(s.id, s.displayName);
  } catch (e) { /* Standardnamen reichen */ }

  say("Benutzer laden");
  let users = [];
  let usersTruncated = false;
  try {
    users = await graphAllPages(tenant, cert, "/users?$select=id,displayName,userPrincipalName,userType,accountEnabled,createdDateTime&$top=999", V1);
    if (users.length > 20000) { users = users.slice(0, 20000); usersTruncated = true; }
  } catch (e) { gaps.push("Benutzer nicht lesbar: " + e.message); }
  const userById = new Map(users.map(u => [u.id, u]));

  // Referenzierte Gruppen -> transitive Benutzer
  const groupIds = new Set();
  const roleIds = new Set();
  const appIds = new Set();
  const directUserIds = new Set();
  for (const p of policies) {
    const u = (p.conditions && p.conditions.users) || {};
    list(u.includeGroups).concat(list(u.excludeGroups)).forEach(g => groupIds.add(g));
    list(u.includeRoles).concat(list(u.excludeRoles)).forEach(r => roleIds.add(r));
    list(u.includeUsers).concat(list(u.excludeUsers)).forEach(x => { if (/^[0-9a-f-]{36}$/i.test(x)) directUserIds.add(x); });
    const a = (p.conditions && p.conditions.applications) || {};
    list(a.includeApplications).concat(list(a.excludeApplications)).forEach(x => { if (/^[0-9a-f-]{36}$/i.test(x)) appIds.add(x); });
  }

  say(`Gruppen auflösen (${groupIds.size})`);
  const groupInfo = new Map();
  for (const gid of groupIds) {
    let name = gid, members = [], missing = false;
    try {
      const g = await graphReq(tenant, cert, "GET", `/groups/${gid}?$select=id,displayName`, null, V1);
      name = g.displayName || gid;
    } catch (e) { missing = e.status === 404; name = missing ? gid + " (gelöscht)" : gid; }
    if (!missing) {
      try {
        members = (await graphAllPages(tenant, cert, `/groups/${gid}/transitiveMembers/microsoft.graph.user?$select=id&$top=999`, V1)).map(m => m.id);
      } catch (e) {
        try { members = (await graphAllPages(tenant, cert, `/groups/${gid}/transitiveMembers?$select=id&$top=999`, V1)).filter(m => /user/i.test(String(m["@odata.type"] || ""))).map(m => m.id); }
        catch (e2) { gaps.push(`Mitglieder von ${name} nicht lesbar: ${e2.message}`); }
      }
    }
    groupInfo.set(gid, { name, members: new Set(members), missing });
  }

  say(`Rollen auflösen (${roleIds.size})`);
  const roleInfo = new Map();
  for (const rid of roleIds) {
    const holders = new Set();
    try {
      const asg = await graphAllPages(tenant, cert,
        `/roleManagement/directory/roleAssignments?$filter=roleDefinitionId eq '${rid}'&$expand=principal`, V1);
      for (const a of asg) {
        const pr = a.principal || {};
        const t = String(pr["@odata.type"] || "");
        if (/user/i.test(t)) holders.add(pr.id);
        else if (/group/i.test(t)) {
          try {
            (await graphAllPages(tenant, cert, `/groups/${pr.id}/transitiveMembers/microsoft.graph.user?$select=id&$top=999`, V1)).forEach(m => holders.add(m.id));
          } catch (e) { /* rollenzuweisbare Gruppe nicht lesbar */ }
        }
      }
    } catch (e) { gaps.push(`Rolleninhaber (${roleNames.get(rid) || rid}) nicht lesbar: ${e.message}`); }
    roleInfo.set(rid, { name: roleNames.get(rid) || rid, holders });
  }

  const appNames = new Map(Object.entries(WELL_KNOWN_APPS));
  for (const id of appIds) {
    if (appNames.has(id)) continue;
    try {
      const sp = await graphAllPages(tenant, cert, `/servicePrincipals?$filter=appId eq '${id}'&$select=appId,displayName`, V1);
      appNames.set(id, sp[0] ? sp[0].displayName : id);
    } catch (e) { appNames.set(id, id); }
  }
  for (const id of directUserIds) {
    if (userById.has(id)) continue;
    try {
      const u = await graphReq(tenant, cert, "GET", `/users/${id}?$select=id,displayName,userPrincipalName,userType,accountEnabled`, null, V1);
      userById.set(u.id, u);
    } catch (e) { /* gelöscht */ }
  }

  const userLabel = id => {
    if (id === "All") return "Alle Benutzer";
    if (id === "GuestsOrExternalUsers") return "Gäste und externe Benutzer";
    if (id === "None") return "niemand";
    const u = userById.get(id);
    return u ? `${u.displayName} (${u.userPrincipalName})` : id + " (gelöscht)";
  };

  // ---- Wirkung je Benutzer
  const isGuest = u => String(u.userType || "").toLowerCase() === "guest";
  function scopeOf(p) {
    const cu = (p.conditions && p.conditions.users) || {};
    const inc = new Set(), exc = new Set();
    const incUsers = list(cu.includeUsers), excUsers = list(cu.excludeUsers);
    if (incUsers.includes("All")) users.forEach(u => inc.add(u.id));
    if (incUsers.includes("GuestsOrExternalUsers") || cu.includeGuestsOrExternalUsers) users.filter(isGuest).forEach(u => inc.add(u.id));
    incUsers.filter(x => userById.has(x)).forEach(x => inc.add(x));
    list(cu.includeGroups).forEach(g => (groupInfo.get(g) || { members: new Set() }).members.forEach(x => inc.add(x)));
    list(cu.includeRoles).forEach(r => (roleInfo.get(r) || { holders: new Set() }).holders.forEach(x => inc.add(x)));
    if (excUsers.includes("GuestsOrExternalUsers") || cu.excludeGuestsOrExternalUsers) users.filter(isGuest).forEach(u => exc.add(u.id));
    excUsers.filter(x => userById.has(x)).forEach(x => exc.add(x));
    list(cu.excludeGroups).forEach(g => (groupInfo.get(g) || { members: new Set() }).members.forEach(x => exc.add(x)));
    list(cu.excludeRoles).forEach(r => (roleInfo.get(r) || { holders: new Set() }).holders.forEach(x => exc.add(x)));
    const eff = new Set([...inc].filter(x => !exc.has(x)));
    return { inc, exc, eff };
  }

  const pols = [];
  const perUser = new Map(); // userId -> [{policyId, name, state, effect}]
  for (const p of policies) {
    const c = p.conditions || {};
    const cu = c.users || {};
    const ca = c.applications || {};
    const g = p.grantControls || null;
    const s = p.sessionControls || null;

    const grant = [];      // Kurzform
    const grantLong = [];  // Satzform
    if (g) {
      list(g.builtInControls).filter(x => x !== "block").forEach(x => {
        const l = BUILTIN_CONTROLS[x] || [x, x];
        grant.push(l[0]); grantLong.push(l[1]);
      });
      if (g.authenticationStrength) {
        const sid = g.authenticationStrength.id;
        const sn = g.authenticationStrength.displayName || strengths.get(sid) || sid;
        grant.push("Authentifizierungsstärke „" + sn + "“");
        grantLong.push("die Authentifizierungsstärke „" + sn + "“");
      }
      list(g.termsOfUse).forEach(t => { grant.push("Nutzungsbedingungen"); grantLong.push("die Zustimmung zu den Nutzungsbedingungen " + t); });
      list(g.customAuthenticationFactors).forEach(t => { grant.push("Kontrolle " + t); grantLong.push("die benutzerdefinierte Kontrolle " + t); });
    }
    const blocks = !!(g && list(g.builtInControls).includes("block"));
    const orOp = !!(g && g.operator === "OR");

    const session = [];
    if (s) {
      if (s.signInFrequency && s.signInFrequency.isEnabled) {
        session.push("Anmeldehäufigkeit: " + (s.signInFrequency.frequencyInterval === "everyTime" ? "jedes Mal"
          : `alle ${s.signInFrequency.value} ${s.signInFrequency.type === "days" ? "Tage" : "Stunden"}`));
      }
      if (s.persistentBrowser && s.persistentBrowser.isEnabled) session.push("Beständige Browsersitzung: " + (s.persistentBrowser.mode === "never" ? "nie" : "immer"));
      if (s.applicationEnforcedRestrictions && s.applicationEnforcedRestrictions.isEnabled) session.push("App-erzwungene Einschränkungen");
      if (s.cloudAppSecurity && s.cloudAppSecurity.isEnabled) session.push("Defender for Cloud Apps: " + (s.cloudAppSecurity.cloudAppSecurityType || "aktiv"));
      if (s.continuousAccessEvaluation && s.continuousAccessEvaluation.mode) session.push("Fortlaufende Zugriffsauswertung: " + s.continuousAccessEvaluation.mode);
      if (s.disableResilienceDefaults) session.push("Resilienz-Standards deaktiviert");
      if (s.secureSignInSession && s.secureSignInSession.isEnabled) session.push("Tokenschutz (gebundene Sitzung)");
    }

    const cond = [];
    const plat = c.platforms;
    if (plat && list(plat.includePlatforms).length) {
      cond.push("Plattform: " + list(plat.includePlatforms).map(x => PLATFORM_LABEL[x] || x).join(", ")
        + (list(plat.excludePlatforms).length ? " (ausser " + list(plat.excludePlatforms).map(x => PLATFORM_LABEL[x] || x).join(", ") + ")" : ""));
    }
    const loc = c.locations;
    const locName = id => id === "All" ? "alle Standorte" : id === "AllTrusted" ? "alle vertrauenswürdigen Standorte"
      : (namedLocations.get(id) || { name: id }).name;
    if (loc && list(loc.includeLocations).length) {
      cond.push("Standort: " + list(loc.includeLocations).map(locName).join(", ")
        + (list(loc.excludeLocations).length ? " — ausgenommen " + list(loc.excludeLocations).map(locName).join(", ") : ""));
    }
    const cat = list(c.clientAppTypes).filter(x => x !== "all");
    if (cat.length) cond.push("Client-Apps: " + cat.map(x => CLIENT_APP_TYPES[x] || x).join(", "));
    if (list(c.signInRiskLevels).length) cond.push("Anmelderisiko: " + list(c.signInRiskLevels).map(x => RISK[x] || x).join(", "));
    if (list(c.userRiskLevels).length) cond.push("Benutzerrisiko: " + list(c.userRiskLevels).map(x => RISK[x] || x).join(", "));
    if (list(c.servicePrincipalRiskLevels).length) cond.push("Dienstprinzipal-Risiko: " + list(c.servicePrincipalRiskLevels).map(x => RISK[x] || x).join(", "));
    if (c.insiderRiskLevels) cond.push("Insider-Risiko: " + String(c.insiderRiskLevels).replace(/,/g, ", "));
    if (c.devices && c.devices.deviceFilter && c.devices.deviceFilter.rule) {
      cond.push(`Gerätefilter (${c.devices.deviceFilter.mode === "exclude" ? "Ausschluss" : "Einschluss"}): ${c.devices.deviceFilter.rule}`);
    }
    if (c.authenticationFlows && c.authenticationFlows.transferMethods) {
      cond.push("Authentifizierungsflüsse: " + String(c.authenticationFlows.transferMethods).replace("deviceCodeFlow", "Gerätecode-Fluss").replace("authenticationTransfer", "Authentifizierungsübertragung"));
    }

    const incApps = list(ca.includeApplications).map(x => appNames.get(x) || x);
    const excApps = list(ca.excludeApplications).map(x => appNames.get(x) || x);
    const actions = list(ca.includeUserActions).map(x => USER_ACTIONS[x] || x);
    const authCtx = list(ca.includeAuthenticationContextClassReferences);

    const whoInc = [
      ...list(cu.includeUsers).map(userLabel),
      ...list(cu.includeGroups).map(x => "Gruppe " + (groupInfo.get(x) || { name: x }).name),
      ...list(cu.includeRoles).map(x => "Rolle " + (roleInfo.get(x) || { name: roleNames.get(x) || x }).name)
    ];
    if (cu.includeGuestsOrExternalUsers) whoInc.push("Gäste/externe Benutzer (" + String(cu.includeGuestsOrExternalUsers.guestOrExternalUserTypes || "").replace(/,/g, ", ") + ")");
    const whoExc = [
      ...list(cu.excludeUsers).map(userLabel),
      ...list(cu.excludeGroups).map(x => "Gruppe " + (groupInfo.get(x) || { name: x }).name),
      ...list(cu.excludeRoles).map(x => "Rolle " + (roleInfo.get(x) || { name: roleNames.get(x) || x }).name)
    ];
    if (cu.excludeGuestsOrExternalUsers) whoExc.push("Gäste/externe Benutzer (" + String(cu.excludeGuestsOrExternalUsers.guestOrExternalUserTypes || "").replace(/,/g, ", ") + ")");
    const wi = c.clientApplications;
    if (wi && list(wi.includeServicePrincipals).length) whoInc.push("Workload-Identitäten: " + list(wi.includeServicePrincipals).join(", "));

    // Klartext: Für wen, wobei, unter welchen Bedingungen, was passiert
    const target = actions.length ? "bei der Aktion „" + actions.join("“, „") + "“"
      : authCtx.length ? "beim Authentifizierungskontext " + authCtx.join(", ")
        : "beim Zugriff auf " + (incApps.join(", ") || "—") + (excApps.length ? " (ausser " + excApps.join(", ") + ")" : "");
    const effect = blocks ? "wird der Zugriff blockiert"
      : grantLong.length ? `wird ${joinOr(grantLong, orOp ? "oder" : "und")} verlangt`
        : session.length ? "gelten Sitzungseinschränkungen" : "passiert nichts (keine Gewährung konfiguriert)";
    const summary = `Für ${whoInc.join(", ") || "niemanden"}${whoExc.length ? " (ausgenommen: " + whoExc.join(", ") + ")" : ""} ${target}` +
      (cond.length ? `, sofern ${cond.join("; ")},` : "") + ` ${effect}.` +
      (session.length && (blocks || grant.length) ? " Zusätzlich: " + session.join("; ") + "." : "");

    const scope = scopeOf(p);
    const effectShort = blocks ? "Blockieren" : (joinOr(grant, orOp ? "oder" : "und") || session.join("; ") || "—");
    for (const uid of scope.eff) {
      if (!perUser.has(uid)) perUser.set(uid, []);
      perUser.get(uid).push({ id: p.id, name: p.displayName, state: p.state, effect: effectShort });
    }

    const excludedUsers = [...scope.exc].filter(x => scope.inc.has(x)).map(x => userById.get(x)).filter(Boolean)
      .map(u => ({ name: u.displayName, upn: u.userPrincipalName, guest: isGuest(u), enabled: u.accountEnabled !== false }));
    const effUsers = [...scope.eff].map(x => userById.get(x)).filter(Boolean);

    const findings = [];
    if (p.state === "enabledForReportingButNotEnforced") {
      const since = p.modifiedDateTime || p.createdDateTime;
      const days = since ? Math.floor((Date.now() - new Date(since).getTime()) / 864e5) : null;
      findings.push({ severity: "hinweis", text: `Nur Bericht — wirkt nicht${days !== null ? `, seit ${days} Tag(en) unverändert` : ""}.` });
    }
    if (p.state === "disabled") findings.push({ severity: "hinweis", text: "Ausgeschaltet." });
    if (list(cu.excludeGroups).some(x => (groupInfo.get(x) || {}).missing) || list(cu.includeGroups).some(x => (groupInfo.get(x) || {}).missing)) {
      findings.push({ severity: "fehler", text: "Verweist auf eine gelöschte Gruppe." });
    }
    if (list(cu.includeUsers).includes("All") && !list(cu.excludeGroups).length && !list(cu.excludeUsers).length && p.state === "enabled") {
      findings.push({ severity: "warn", text: "Gilt für alle Benutzer ohne jeden Ausschluss — auch für die Notfallkonten." });
    }
    for (const x of list(cu.excludeGroups)) {
      const gi = groupInfo.get(x);
      if (gi && gi.members.size > 20) findings.push({ severity: "warn", text: `Ausschlussgruppe „${gi.name}“ hat ${gi.members.size} Mitglieder — Ausnahmen sollten die Ausnahme sein.` });
    }

    pols.push({
      id: p.id,
      name: p.displayName,
      state: p.state,
      stateLabel: CA_STATE[p.state] || p.state,
      createdDateTime: p.createdDateTime || null,
      modifiedDateTime: p.modifiedDateTime || null,
      summary,
      who: { include: whoInc, exclude: whoExc },
      apps: { include: incApps, exclude: excApps, actions, authContext: authCtx },
      conditions: cond,
      grant: { controls: grant, operator: g ? g.operator : null, blocks },
      session,
      effectShort,
      scope: {
        included: scope.inc.size,
        excluded: excludedUsers.length,
        effective: scope.eff.size,
        guests: effUsers.filter(isGuest).length,
        disabled: effUsers.filter(u => u.accountEnabled === false).length
      },
      excludedUsers,
      effectiveUsers: effUsers.slice(0, 500).map(u => ({ name: u.displayName, upn: u.userPrincipalName, guest: isGuest(u), enabled: u.accountEnabled !== false })),
      findings,
      signIns: null,
      _eff: scope.eff,          // nur intern, für die Prognose — wird vor der Rückgabe entfernt
      _requiresMfa: grant.some(c => /MFA|Authentifizierungsstärke/i.test(c)) && !blocks
    });
  }

  // ---- Anmeldeprotokoll: was haben die Richtlinien tatsächlich bewirkt
  let signInInfo = null;
  let forecast = null;
  if (opts.signIns) {
    const days = Math.min(Math.max(Number(opts.signInDays) || 7, 1), 30);
    const cap = Math.min(Math.max(Number(opts.signInCap) || 5000, 100), 20000);
    say(`Anmeldeprotokoll lesen (${days} Tage)`);
    const since = new Date(Date.now() - days * 864e5).toISOString().replace(/\.\d{3}Z$/, "Z");
    const readPaged = async (path, limit, o) => {
      const out = [];
      let resp = await graphReq(tenant, cert, "GET", path, null, o || V1);
      for (;;) {
        out.push(...(resp.value || []));
        if (out.length >= limit || !resp["@odata.nextLink"]) return { list: out.slice(0, limit), capped: !!resp["@odata.nextLink"] || out.length > limit };
        resp = await graphReq(tenant, cert, "GET", resp["@odata.nextLink"], null, o || V1);
      }
    };
    try {
      const inter = await readPaged(`/auditLogs/signIns?$filter=createdDateTime ge ${since}&$top=500`, cap);
      const got = inter.list;
      // Nicht-interaktive Anmeldungen (Token-Erneuerung, z. B. Mail-App auf dem
      // Handy) — genau die treffen eine Geräte-Richtlinie oft zuerst. Nur beta.
      let nonInter = { list: [], capped: false, error: null };
      if (opts.nonInteractive !== false) {
        say("Nicht-interaktive Anmeldungen lesen");
        try {
          nonInter = await readPaged(`/auditLogs/signIns?$filter=createdDateTime ge ${since} and signInEventTypes/any(t: t eq 'nonInteractiveUser')&$top=500`, cap, BETA);
        } catch (e) { nonInter = { list: [], capped: false, error: e.message }; }
      }
      const all = got.concat(nonInter.list.map(x => ({ ...x, _nonInteractive: true })));

      const stats = new Map();
      for (const si of got) {
        for (const ap of si.appliedConditionalAccessPolicies || []) {
          if (!stats.has(ap.id)) stats.set(ap.id, { counts: {}, users: new Map() });
          const st = stats.get(ap.id);
          st.counts[ap.result] = (st.counts[ap.result] || 0) + 1;
          if (/failure|interrupted/i.test(ap.result)) {
            const k = si.userPrincipalName || si.userId;
            st.users.set(k, (st.users.get(k) || 0) + 1);
          }
        }
      }
      for (const p of pols) {
        const st = stats.get(p.id);
        if (!st) { p.signIns = { counts: {}, topUsers: [] }; continue; }
        p.signIns = {
          counts: st.counts,
          topUsers: [...st.users.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([upn, n]) => ({ upn, n }))
        };
      }
      signInInfo = { days, read: got.length, capped: inter.capped, since, nonInteractive: nonInter.list.length, nonInteractiveCapped: nonInter.capped, nonInteractiveError: nonInter.error };

      // ---- Auswirkungsprognose: wen würden die Report-only-Richtlinien scharf treffen?
      say("Auswirkungsprognose berechnen");
      forecast = await buildForecast(tenant, cert, pols, all, userById, signInInfo);
    } catch (e) {
      signInInfo = { days, error: e.message };
      gaps.push("Anmeldeprotokoll nicht lesbar (Entra ID P1 und AuditLog.Read.All nötig): " + e.message);
    }
  }

  // ---- Wirkungsmatrix und Lücken
  const active = pols.filter(p => p.state === "enabled");
  const mfaLike = p => p.grant.blocks || p.grant.controls.some(c => /MFA|Authentifizierungsstärke/i.test(c));
  const allApps = p => p.apps.include.includes("Alle Cloud-Apps") || p.apps.include.includes("Office 365");
  const matrix = users.filter(u => u.accountEnabled !== false).map(u => {
    const ps = perUser.get(u.id) || [];
    return {
      name: u.displayName, upn: u.userPrincipalName, guest: isGuest(u),
      active: ps.filter(x => x.state === "enabled").map(x => ({ name: x.name, effect: x.effect })),
      reportOnly: ps.filter(x => x.state === "enabledForReportingButNotEnforced").map(x => ({ name: x.name, effect: x.effect }))
    };
  }).sort((a, b) => String(a.name).localeCompare(String(b.name)));

  const mfaIds = new Set(active.filter(p => mfaLike(p) && allApps(p) && !p.grant.blocks).map(p => p.id));
  const withoutMfa = users.filter(u => u.accountEnabled !== false && !(perUser.get(u.id) || []).some(x => mfaIds.has(x.id)))
    .map(u => ({ name: u.displayName, upn: u.userPrincipalName, guest: isGuest(u) }));
  const excludedFromAll = active.length ? users.filter(u => u.accountEnabled !== false && !(perUser.get(u.id) || []).some(x => x.state === "enabled"))
    .map(u => ({ name: u.displayName, upn: u.userPrincipalName, guest: isGuest(u) })) : [];
  const legacyBlocked = active.some(p => p.grant.blocks && p.conditions.some(c => /Legacy|ActiveSync/i.test(c)));

  pols.sort((a, b) => ({ enabled: 0, enabledForReportingButNotEnforced: 1, disabled: 2 }[a.state] - { enabled: 0, enabledForReportingButNotEnforced: 1, disabled: 2 }[b.state]) || a.name.localeCompare(b.name));
  for (const p of pols) { delete p._eff; delete p._requiresMfa; }

  return {
    kind: "ca",
    generatedAt: new Date().toISOString(),
    gaps,
    signIns: signInInfo,
    forecast,
    summary: {
      policies: pols.length,
      enabled: pols.filter(p => p.state === "enabled").length,
      reportOnly: pols.filter(p => p.state === "enabledForReportingButNotEnforced").length,
      disabled: pols.filter(p => p.state === "disabled").length,
      users: users.filter(u => u.accountEnabled !== false).length,
      guests: users.filter(u => u.accountEnabled !== false && isGuest(u)).length,
      usersTruncated,
      withoutMfa: withoutMfa.length,
      excludedFromAll: excludedFromAll.length,
      legacyBlocked,
      securityDefaults
    },
    policies: pols,
    matrix,
    withoutMfa,
    excludedFromAll,
    namedLocations: [...namedLocations.values()]
  };
}

// ============================================================== Aufräumen
// Pfade werden ausschliesslich hier aus der bekannten Quelle gebildet — der
// Client kann keinen beliebigen Graph-Pfad zum Löschen vorgeben.
const POLICY_PATHS = {
  configurationPolicies: "/deviceManagement/configurationPolicies",
  deviceCompliancePolicies: "/deviceManagement/deviceCompliancePolicies",
  deviceConfigurations: "/deviceManagement/deviceConfigurations",
  groupPolicyConfigurations: "/deviceManagement/groupPolicyConfigurations",
  windowsFeatureUpdateProfiles: "/deviceManagement/windowsFeatureUpdateProfiles",
  windowsQualityUpdateProfiles: "/deviceManagement/windowsQualityUpdateProfiles",
  windowsDriverUpdateProfiles: "/deviceManagement/windowsDriverUpdateProfiles",
  intents: "/deviceManagement/intents"
};

/**
 * Eine NICHT zugewiesene Richtlinie löschen. Die Zuweisung wird unmittelbar
 * vorher frisch gelesen — hat die Richtlinie inzwischen eine, wird sie nicht
 * angefasst. Vor dem Löschen landet das komplette Objekt (bei Settings Catalog
 * mit Einstellungen) als JSON in snapshotDir, damit es sich wiederherstellen lässt.
 */
async function deleteUnassignedPolicy(tenant, cert, source, id, snapshotDir) {
  const base = POLICY_PATHS[source];
  if (!base) throw Object.assign(new Error("Unbekannte Richtlinienquelle: " + source), { status: 400 });
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw Object.assign(new Error("Ungültige Richtlinien-Id."), { status: 400 });
  const asg = await graphReq(tenant, cert, "GET", `${base}/${id}/assignments`, null, BETA);
  if ((asg.value || []).length) return { status: "skipped", reason: "Hat inzwischen eine Zuweisung — nicht gelöscht." };
  const full = await graphReq(tenant, cert, "GET", `${base}/${id}${source === "configurationPolicies" ? "?$expand=settings" : ""}`, null, BETA);
  let settings = null;
  if (source === "intents") {
    try { settings = (await graphReq(tenant, cert, "GET", `${base}/${id}/settings`, null, BETA)).value || []; } catch (e) { /* ohne */ }
  }
  if (source === "groupPolicyConfigurations") {
    try { settings = await graphAllPages(tenant, cert, `${base}/${id}/definitionValues?$expand=definition($select=id,displayName),presentationValues`, BETA); } catch (e) { /* ohne */ }
  }
  const fs = require("fs");
  const path = require("path");
  fs.mkdirSync(snapshotDir, { recursive: true });
  const file = path.join(snapshotDir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${source}_${id}.json`);
  fs.writeFileSync(file, JSON.stringify({ source, deletedAt: new Date().toISOString(), object: full, settings }, null, 2), "utf8");
  await graphReq(tenant, cert, "DELETE", `${base}/${id}`, null, BETA);
  return { status: "deleted", name: full.name || full.displayName || id, snapshot: path.basename(file) };
}

module.exports = {
  auditApps, auditPolicies, auditConditionalAccess, deleteUnassignedPolicy, POLICY_PATHS,
  createResolver, appFindings, expectedAppGroupName, appBaseName, groupSuffix, isPmpApp, appTypeOf,
  parseOibName, flattenCatalogSettings, propertySettings, targetKind, settingsSummary, INTENT_LABEL
};
