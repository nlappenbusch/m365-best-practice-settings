/**
 * Printer-Mapping-Konfigurator (Weatherlights/Intune-Printer-Mapping-Tool):
 * verbindet On-Prem-Netzwerkdrucker auf Intune-Geraeten. Das Original-Konzept
 * (Wiki) besteht aus drei Teilen, die hier komplett app-only automatisiert sind:
 *
 *  1. Store-App "Intune Printer Mapping" (Produkt-ID 9N3TH84TXRF4, winGetApp)
 *     — wird auf Wunsch automatisch als Required-App mit deployt.
 *  2. ADMX/ADML des Tools — werden automatisch in den Tenant importiert
 *     (groupPolicyUploadedDefinitionFiles), Dateien liegen versioniert in
 *     assets/intune/ (Release 1.0.5).
 *  3. "Imported Administrative Templates"-Policy (groupPolicyConfigurations)
 *     mit dem Pflicht-Schalter "Enable Intune Printer Mapping" (Machine) und
 *     je Drucker einem "Printer operation <N>"-Slot (max. 15, User- oder
 *     Machine-Kontext) mit Path/Operation(Add|Delete)/SetDefault.
 *
 * Manuell bleibt (bewusst, wird in der UI angezeigt): der Autostart-Freigabe-
 * Eintrag der App (PFN HaukeGtze.IntunePrinterMapping_6bk20wvc8rfx2) in einer
 * Geraeterestriktions-Richtlinie sowie Treiber + Druckberechtigungen.
 */
const fs = require("fs");
const path = require("path");
const { graphReq, graphAllPages } = require("./graph");

const BETA = { beta: true, retryTransient: true };
const ASSET_DIR = path.join(__dirname, "..", "assets", "intune");
const ADMX_FILE = "Intune.Printer.Mapping.admx";
const ADML_FILE = "Intune.Printer.Mapping.adml";
const CONFIG_PREFIX = "WIN - PrinterMapping - ";
const NAMING = require("./naming");

// Die Objektnamen kommen aus der Namenskonvention (lib/naming.js). Gesucht wird
// ueber ALLE bekannten Praefixe -- sonst findet das Tool nach einem
// Schemawechsel die eigenen Objekte nicht mehr und legt daneben neue an.
const NAME_KIND = "scriptPrinter";
const NAME_SEP = "\u0001";

function knownPrefixes(tenant) {
  return NAMING.candidates(NAME_KIND, { name: NAME_SEP }, tenant && tenant.id)
    .map(c => c.split(NAME_SEP)[0])
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
}
function displayNameFor(tenant, profileName) {
  return NAMING.name(NAME_KIND, { name: profileName }, tenant && tenant.id);
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
const STORE_PRODUCT_ID = "9N3TH84TXRF4";
const APP_DISPLAY_NAME = "Intune Printer Mapping";
const AUTOSTART_PFN = "HaukeGtze.IntunePrinterMapping_6bk20wvc8rfx2";
const MAX_PRINTERS = 15;
const GRAPH_BETA_BASE = "https://graph.microsoft.com/beta";

function sanitizeProfileName(name) {
  const n = String(name || "").trim().replace(/[^A-Za-z0-9 ._-]/g, "").slice(0, 40);
  if (!n) throw new Error("Ungueltiger Profilname.");
  return n;
}

function sanitizePrinters(raw) {
  const list = Array.isArray(raw) ? raw : [];
  if (!list.length) throw new Error("Mindestens einen Drucker angeben.");
  if (list.length > MAX_PRINTERS) throw new Error(`Maximal ${MAX_PRINTERS} Drucker pro Profil (ADMX-Slots).`);
  return list.map((p, i) => {
    const up = String(p.path || "").trim();
    if (!/^\\\\[^\\]+\\.+/.test(up)) throw new Error(`Drucker ${i + 1}: Pfad muss ein UNC-Pfad sein (\\\\printserver\\drucker).`);
    const op = String(p.operation || "Add");
    if (!["Add", "Delete"].includes(op)) throw new Error(`Drucker ${i + 1}: Operation muss Add oder Delete sein.`);
    return { path: up, operation: op, setDefault: !!p.setDefault };
  });
}

/** XML-Datei als base64 lesen — ein UTF-8-BOM wird entfernt: der GroupPolicy-
 *  Dienst parst den dekodierten Inhalt als String und scheitert sonst mit
 *  "Content Parsing exception: Data at the root level is invalid. Line 1,
 *  position 1" (real aufgetreten; die Original-Releases sind mit BOM kodiert). */
function readXmlBase64(filePath) {
  let b = fs.readFileSync(filePath);
  if (b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) b = b.subarray(3);
  return b.toString("base64");
}

/** ADMX/ADML des Tools sicherstellen (einmalig pro Tenant importiert). */
async function ensureAdmx(tenant, cert, onProgress) {
  const notify = onProgress || (() => {});
  const files = await graphAllPages(tenant, cert, "/deviceManagement/groupPolicyUploadedDefinitionFiles", BETA);
  let file = files.find(f => String(f.fileName || "").toLowerCase() === ADMX_FILE.toLowerCase());
  if (!file) {
    notify("ADMX-Vorlage importieren");
    // defaultLanguageCode darf NICHT gesetzt sein — der Dienst lehnt das mit
    // "ADMXDefaultLanguageCodeNotNull" ab (real aufgetreten) und leitet die
    // Sprache selbst aus der ADML-Datei ab.
    file = await graphReq(tenant, cert, "POST", "/deviceManagement/groupPolicyUploadedDefinitionFiles", {
      fileName: ADMX_FILE,
      content: readXmlBase64(path.join(ASSET_DIR, ADMX_FILE)),
      groupPolicyUploadedLanguageFiles: [{
        fileName: ADML_FILE,
        languageCode: "en-US",
        content: readXmlBase64(path.join(ASSET_DIR, ADML_FILE))
      }]
    }, BETA);
  }
  // Auf Verarbeitung warten — der Import laeuft asynchron im Intune-Dienst.
  for (let tries = 0; tries < 60; tries++) {
    const cur = await graphReq(tenant, cert, "GET", `/deviceManagement/groupPolicyUploadedDefinitionFiles/${file.id}`, null, BETA);
    const status = String(cur.status || "").toLowerCase();
    if (status === "available") return cur;
    if (/fail|remove/.test(status)) throw new Error("ADMX-Import fehlgeschlagen (Status: " + cur.status + ").");
    notify(`ADMX-Verarbeitung abwarten (${cur.status || "pending"})`);
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error("ADMX-Import nicht rechtzeitig verfuegbar (Timeout).");
}

/** Definitionen per displayName-Filter suchen — die dokumentierte Navigation
 *  groupPolicyUploadedDefinitionFiles/{id}/definitions existiert im Dienst
 *  NICHT ("No OData route exists", real aufgetreten). policyType
 *  'admxIngested' unterscheidet unsere importierten Definitionen von
 *  eingebauten gleichen Namens. */
async function findDefinitionsByName(tenant, cert, displayName) {
  const lit = String(displayName).replace(/'/g, "''");
  const defs = await graphAllPages(tenant, cert,
    `/deviceManagement/groupPolicyDefinitions?$filter=displayName eq '${lit}'&$select=id,displayName,classType,policyType`, BETA);
  return defs.filter(d => String(d.policyType || "").toLowerCase() === "admxingested");
}

/** Master-Schalter + benoetigte Drucker-Slots (0..count-1) einsammeln. */
async function loadDefinitions(tenant, cert, printerCount) {
  const enableMatches = await findDefinitionsByName(tenant, cert, "Enable Intune Printer Mapping");
  const enable = enableMatches.find(d => String(d.classType).toLowerCase() === "machine");
  if (!enable) throw new Error("ADMX-Definition 'Enable Intune Printer Mapping' nicht gefunden — ADMX-Import noch nicht fertig repliziert? In 1-2 Minuten erneut versuchen.");
  const printers = { user: [], machine: [] };
  for (let i = 0; i < printerCount; i++) {
    for (const d of await findDefinitionsByName(tenant, cert, `Printer operation ${i}`)) {
      const cls = String(d.classType).toLowerCase() === "machine" ? "machine" : "user";
      printers[cls][i] = d;
    }
  }
  return { enable, printers };
}

/** Presentations einer Definition typisiert holen (Path=textBox, Operation=dropdown, SetDefault=checkBox). */
async function loadPresentations(tenant, cert, defId) {
  const pres = (await graphReq(tenant, cert, "GET", `/deviceManagement/groupPolicyDefinitions/${defId}/presentations`, null, BETA)).value || [];
  const byType = t => pres.find(p => String(p["@odata.type"] || "").toLowerCase().includes(t.toLowerCase()));
  return {
    path: byType("TextBox"),
    operation: byType("DropdownList"),
    setDefault: byType("CheckBox")
  };
}

function presBind(defId, presId) {
  return `${GRAPH_BETA_BASE}/deviceManagement/groupPolicyDefinitions('${defId}')/presentations('${presId}')`;
}
function defBind(defId) {
  return `${GRAPH_BETA_BASE}/deviceManagement/groupPolicyDefinitions('${defId}')`;
}

/**
 * Profil deployen: Konfiguration anlegen/aktualisieren (Werte werden komplett
 * ersetzt), Gruppen zuweisen, optional die Store-App mit ausrollen.
 */
async function deployProfile(tenant, cert, opts, onProgress) {
  const notify = onProgress || (() => {});
  const profileName = sanitizeProfileName(opts.profileName);
  const printers = sanitizePrinters(opts.printers);
  const scope = opts.scope === "machine" ? "machine" : "user";
  const groupIds = (Array.isArray(opts.groupIds) ? opts.groupIds : []).filter(Boolean);

  await ensureAdmx(tenant, cert, notify);
  notify("ADMX-Definitionen laden");
  const defs = await loadDefinitions(tenant, cert, printers.length);
  for (let i = 0; i < printers.length; i++) {
    if (!defs.printers[scope][i]) throw new Error(`ADMX-Slot 'Printer operation ${i}' (${scope}) nicht gefunden.`);
  }

  notify("Konfigurationsprofil anlegen");
  const displayName = displayNameFor(tenant, profileName);
  const existing = await graphAllPages(tenant, cert,
    `/deviceManagement/groupPolicyConfigurations?$filter=displayName eq '${displayName.replace(/'/g, "''")}'`, BETA);
  let cfgId;
  if (existing.length) {
    cfgId = existing[0].id;
  } else {
    const created = await graphReq(tenant, cert, "POST", "/deviceManagement/groupPolicyConfigurations", {
      displayName,
      description: "Drucker-Mapping (Weatherlights Intune Printer Mapping) — generiert vom M365 Security Policy Manager. Voraussetzungen: App installiert (wird optional mit deployt), Treiber vorhanden, Druckberechtigungen gesetzt."
    }, BETA);
    cfgId = created.id;
  }

  notify("Richtlinienwerte setzen");
  const currentValues = await graphAllPages(tenant, cert, `/deviceManagement/groupPolicyConfigurations/${cfgId}/definitionValues`, BETA);
  const added = [];

  // Pflicht-Schalter (Machine) — ohne ihn mappt das Tool nichts (Wiki).
  added.push({ enabled: true, "definition@odata.bind": defBind(defs.enable.id) });

  for (let i = 0; i < printers.length; i++) {
    const def = defs.printers[scope][i];
    const pres = await loadPresentations(tenant, cert, def.id);
    if (!pres.path || !pres.operation) throw new Error(`Presentations fuer 'Printer operation ${i}' unvollstaendig.`);
    const presentationValues = [
      { "@odata.type": "#microsoft.graph.groupPolicyPresentationValueText", value: printers[i].path, "presentation@odata.bind": presBind(def.id, pres.path.id) },
      { "@odata.type": "#microsoft.graph.groupPolicyPresentationValueText", value: printers[i].operation, "presentation@odata.bind": presBind(def.id, pres.operation.id) }
    ];
    if (pres.setDefault) {
      presentationValues.push({ "@odata.type": "#microsoft.graph.groupPolicyPresentationValueBoolean", value: printers[i].setDefault, "presentation@odata.bind": presBind(def.id, pres.setDefault.id) });
    }
    added.push({ enabled: true, "definition@odata.bind": defBind(def.id), presentationValues });
  }

  await graphReq(tenant, cert, "POST", `/deviceManagement/groupPolicyConfigurations/${cfgId}/updateDefinitionValues`, {
    added, updated: [], deletedIds: currentValues.map(v => v.id)
  }, BETA);

  notify("Gruppen zuweisen");
  await graphReq(tenant, cert, "POST", `/deviceManagement/groupPolicyConfigurations/${cfgId}/assign`, {
    assignments: groupIds.map(groupId => ({ target: { "@odata.type": "#microsoft.graph.groupAssignmentTarget", groupId } }))
  }, BETA);

  let appResult = null;
  if (opts.deployApp) {
    notify("Store-App bereitstellen");
    appResult = await ensureApp(tenant, cert, groupIds);
  }

  return { configId: cfgId, displayName, updated: !!existing.length, app: appResult };
}

/** Store-App (winGetApp) sicherstellen + Required-Assignment auf die Gruppen mergen. */
async function ensureApp(tenant, cert, groupIds) {
  const apps = await graphAllPages(tenant, cert,
    `/deviceAppManagement/mobileApps?$filter=displayName eq '${APP_DISPLAY_NAME.replace(/'/g, "''")}'`, BETA);
  let app = apps.find(a => String(a["@odata.type"] || "").includes("winGetApp")) || apps[0];
  let created = false;
  if (!app) {
    app = await graphReq(tenant, cert, "POST", "/deviceAppManagement/mobileApps", {
      "@odata.type": "#microsoft.graph.winGetApp",
      displayName: APP_DISPLAY_NAME,
      description: "Verbindet On-Prem-Netzwerkdrucker anhand der Intune-Printer-Mapping-Richtlinie (weatherlights.com). Automatisch bereitgestellt vom M365 Security Policy Manager.",
      publisher: "weatherlights.com (Hauke Goetze)",
      packageIdentifier: STORE_PRODUCT_ID,
      installExperience: { runAsAccount: "user" }
    }, BETA);
    created = true;
  }
  if (groupIds && groupIds.length) {
    let current = [];
    try { current = (await graphReq(tenant, cert, "GET", `/deviceAppManagement/mobileApps/${app.id}/assignments`, null, BETA)).value || []; } catch (e) { /* leer */ }
    const have = new Set(current.map(a => a && a.target && a.target.groupId).filter(Boolean));
    const merged = current.map(a => ({ "@odata.type": "#microsoft.graph.mobileAppAssignment", intent: a.intent, target: a.target }));
    for (const gid of groupIds) {
      if (!have.has(gid)) merged.push({ "@odata.type": "#microsoft.graph.mobileAppAssignment", intent: "required", target: { "@odata.type": "#microsoft.graph.groupAssignmentTarget", groupId: gid } });
    }
    await graphReq(tenant, cert, "POST", `/deviceAppManagement/mobileApps/${app.id}/assign`, { mobileAppAssignments: merged }, BETA);
  }
  return { appId: app.id, created };
}

/** Deployte Profile inkl. zurueckgeparster Drucker + Zuweisungen. */
async function listProfiles(tenant, cert) {
  const configs = await graphAllPages(tenant, cert, "/deviceManagement/groupPolicyConfigurations", BETA);
  const ours = configs.filter(c => isOurs(tenant, c.displayName));
  const result = [];
  for (const c of ours) {
    let printers = [], scope = "user", enabled = false, groupIdsList = [];
    try {
      const values = await graphAllPages(tenant, cert,
        `/deviceManagement/groupPolicyConfigurations/${c.id}/definitionValues?$expand=definition($select=id,displayName,classType)`, BETA);
      for (const v of values) {
        const dn = String(v.definition?.displayName || "");
        if (/enable intune printer mapping/i.test(dn)) { enabled = !!v.enabled; continue; }
        const m = /^Printer operation (\d+)$/i.exec(dn.trim());
        if (!m) continue;
        scope = String(v.definition?.classType).toLowerCase() === "machine" ? "machine" : "user";
        let pv = [];
        try { pv = (await graphReq(tenant, cert, "GET", `/deviceManagement/groupPolicyConfigurations/${c.id}/definitionValues/${v.id}/presentationValues`, null, BETA)).value || []; } catch (e) { /* egal */ }
        const texts = pv.filter(x => typeof x.value === "string").map(x => x.value);
        const bool = pv.find(x => typeof x.value === "boolean");
        printers[Number(m[1])] = {
          path: texts.find(t2 => t2.startsWith("\\\\")) || texts[0] || "",
          operation: texts.find(t2 => t2 === "Add" || t2 === "Delete") || "Add",
          setDefault: bool ? !!bool.value : false
        };
      }
      const asg = (await graphReq(tenant, cert, "GET", `/deviceManagement/groupPolicyConfigurations/${c.id}/assignments`, null, BETA)).value || [];
      groupIdsList = asg.map(a => a && a.target && a.target.groupId).filter(Boolean);
    } catch (e) { /* Profil trotzdem listen */ }
    result.push({
      id: c.id,
      profileName: profileNameFrom(tenant, c.displayName),
      displayName: c.displayName,
      enabled, scope,
      printers: printers.filter(Boolean),
      groupIds: groupIdsList
    });
  }
  return result;
}

module.exports = {
  deployProfile, listProfiles, ensureApp, ensureAdmx,
  sanitizePrinters, sanitizeProfileName,
  CONFIG_PREFIX, STORE_PRODUCT_ID, AUTOSTART_PFN, MAX_PRINTERS
};
