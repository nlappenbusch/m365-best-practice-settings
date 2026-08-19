"use strict";
/**
 * Dynamische Aufloesung + Deploy von Settings-Catalog-Einstellungen (Intune) --
 * echte Automatisierung statt "JSON selbst exportieren" (siehe customPolicy.js
 * fuer den manuellen Fallback, der weiterhin fuer Exoten/Nicht-Choice-Settings
 * bleibt).
 *
 * Sucht die passende Einstellung LIVE ueber Graph (deviceManagement/
 * configurationSettings) statt eine settingDefinitionId hart einzuprogrammieren
 * -- ADMX-Versionsstaende (z.B. "microsoft_edgev139") aendern sich mit neuen
 * Browser-/Windows-Versionen, ein fest einprogrammierter String wuerde
 * irgendwann still brechen. Deckt choice-basierte (Enabled/Disabled-artige)
 * Einstellungen ab -- das ist die ganz grosse Mehrheit der ADMX-Browser-/
 * Windows-Policies (Edge, Chrome-ADMX, Windows-Komponenten, ...).
 *
 * WICHTIG: previewSetting() macht KEINEN Schreibzugriff -- erst deployAutoSetting()
 * legt die Policy tatsaechlich an. Das Frontend zeigt die Vorschau IMMER vor dem
 * Ausrollen, damit die aufgeloeste Einstellung/der Wert visuell bestaetigt werden
 * kann, bevor irgendetwas in den Tenant geschrieben wird.
 */
const { graphReq, graphAllPages } = require("./graph");
const OIB = require("./oib");

// Nur Windows/MDM-Settings -- deckt Edge/Chrome-ADMX + native Windows-Policies ab
// und nutzt die offiziell als filterbar dokumentierten Felder (applicability),
// statt versuchen die ganze (sehr grosse) Collection zu filtern.
const SEARCH_PATH = "/deviceManagement/configurationSettings" +
  "?$filter=applicability/technologies has 'mdm' and applicability/platform eq 'windows10'";

function scoreMatch(def, terms) {
  const hay = [def.displayName, def.name, def.id, ...(def.keywords || [])].join(" ").toLowerCase();
  return terms.every(t => hay.includes(t.toLowerCase()));
}

async function searchSetting(tenant, cert, searchTerm) {
  const terms = String(searchTerm || "").trim().split(/\s+/).filter(Boolean);
  if (!terms.length) throw Object.assign(new Error("Kein Suchbegriff angegeben."), { status: 400 });

  const all = await graphAllPages(tenant, cert, SEARCH_PATH, { beta: true, retryTransient: true });
  const candidates = all.filter(d =>
    d["@odata.type"] === "#microsoft.graph.deviceManagementConfigurationChoiceSettingDefinition" &&
    scoreMatch(d, terms));

  if (candidates.length === 0) {
    throw Object.assign(new Error(`Keine Einstellung gefunden fuer "${searchTerm}". Suchbegriff praezisieren (z.B. exakter Policy-Name) oder ueber "Eigene JSON" einspielen.`), { status: 404 });
  }
  if (candidates.length > 1) {
    const names = candidates.slice(0, 8).map(c => c.displayName).join(" | ");
    throw Object.assign(new Error(`Mehrdeutig (${candidates.length} Treffer) fuer "${searchTerm}": ${names}${candidates.length > 8 ? " ..." : ""} -- Suchbegriff praezisieren.`), { status: 409 });
  }
  return candidates[0];
}

/** Liste liefert "options" ggf. nicht mit -- volle Definition per Get nachladen. */
async function loadFullDefinition(tenant, cert, settingId) {
  return graphReq(tenant, cert, "GET", `/deviceManagement/configurationSettings/${encodeURIComponent(settingId)}`, null, { beta: true });
}

function resolveOption(def, desiredLabel) {
  const options = def.options || [];
  if (!options.length) {
    throw Object.assign(new Error(`Einstellung "${def.displayName}" hat keine bekannten Auswahloptionen -- vermutlich kein einfaches Enabled/Disabled-Setting, ueber "Eigene JSON" einspielen.`), { status: 502 });
  }
  const wanted = String(desiredLabel || "").trim().toLowerCase();
  const exact = options.find(o => (o.displayName || "").toLowerCase() === wanted);
  const partial = options.filter(o => (o.displayName || "").toLowerCase().includes(wanted));
  const match = exact || (partial.length === 1 ? partial[0] : null);
  if (!match) {
    const names = options.map(o => o.displayName).join(" | ");
    throw Object.assign(new Error(`Wert "${desiredLabel}" nicht eindeutig fuer "${def.displayName}" -- verfuegbare Optionen: ${names}`), { status: 400 });
  }
  return match;
}

/** Nur AUFLOESEN + anzeigen, kein Schreibzugriff -- fuer die Vorschau vor dem Klick. */
async function previewSetting(tenant, cert, searchTerm, desiredLabel) {
  const found = await searchSetting(tenant, cert, searchTerm);
  const full = await loadFullDefinition(tenant, cert, found.id);
  const option = resolveOption(full, desiredLabel);
  return {
    settingId: full.id,
    settingDisplayName: full.displayName,
    settingDescription: full.description || null,
    resolvedOptionId: option.itemId,
    resolvedOptionLabel: option.displayName
  };
}

async function deployAutoSetting(tenant, cert, { name, searchTerm, desiredLabel }, groupId) {
  if (!groupId) throw Object.assign(new Error("Keine Ziel-Gruppe angegeben."), { status: 400 });
  const preview = await previewSetting(tenant, cert, searchTerm, desiredLabel);

  const payload = {
    "@odata.type": "#microsoft.graph.deviceManagementConfigurationPolicy",
    name: (name || "").trim() || `Auto: ${preview.settingDisplayName}`,
    platforms: "windows10",
    technologies: "mdm",
    settings: [{
      "@odata.type": "#microsoft.graph.deviceManagementConfigurationSetting",
      settingInstance: {
        "@odata.type": "#microsoft.graph.deviceManagementConfigurationChoiceSettingInstance",
        settingDefinitionId: preview.settingId,
        choiceSettingValue: {
          "@odata.type": "#microsoft.graph.deviceManagementConfigurationChoiceSettingValue",
          value: preview.resolvedOptionId,
          children: []
        }
      }
    }]
  };

  const created = await graphReq(tenant, cert, "POST", "/deviceManagement/configurationPolicies", payload, { beta: true });
  const assignStatus = await OIB.assignPolicyToGroup(tenant, cert, { id: created.id, apiType: "configurationPolicies" }, groupId);
  return {
    policyId: created.id, policyName: created.name, assignStatus,
    resolvedSetting: preview.settingDisplayName, resolvedOption: preview.resolvedOptionLabel
  };
}

module.exports = { searchSetting, previewSetting, deployAutoSetting };
