"use strict";
/**
 * Browser-Erweiterungen erzwingen (Edge).
 *
 * Bisher war das die einzige Lücke im Passwortmanager-Rollout: Die Desktop-App
 * kommt als Win32-App, die Server-Region der Erweiterung setzt die
 * Registry-Richtlinie (lib/registryPolicy.js) — die Erweiterung selbst musste
 * jemand von Hand im Intune-Portal erzwingen.
 *
 * Weg: ein Custom-Konfigurationsprofil (OMA-URI) auf die Edge-Richtlinie
 * `ExtensionInstallForcelist`. Bewusst OMA-URI und nicht Settings Catalog:
 * Die Edge-Richtlinien sind zwar im Settings Catalog vorhanden, ihre
 * Definition-Ids sind aber lang, versionsabhaengig und muessten zur Laufzeit
 * gesucht werden. Der OMA-URI-Pfad ist stabil und deterministisch — das Profil
 * sieht im Portal genauso aus und laesst sich dort weiter pflegen.
 *
 * Chrome und Firefox brauchen dagegen eine ADMX-Ingestion (die ADMX-Datei muss
 * erst in den Tenant hochgeladen werden). Das ist ein eigener Mechanismus und
 * hier absichtlich nicht mit eingebaut.
 *
 * WICHTIG bei der Zuweisung: an die dynamische GroupTag-Geraetegruppe, nicht an
 * eine App-Zielgruppe. Intune loest verschachtelte Gruppen nur beim
 * App-Assignment auf, bei Konfigurationsprofilen nicht — ein Profil auf einer
 * genesteten Gruppe erreicht kein einziges Geraet.
 */
const { graphReq, graphAllPages } = require("./graph");
const NAMING = require("./naming");

const NAME_KIND = "browserExtEdge";
const NAME_SEP = "\u0001";

// Der Edge-Policy-Zweig im Policy-CSP. Kein ADMX-Import noetig — Edge ist
// eingebaut. Der Trenner U+F000 zwischen Listenposition und Wert ist Vorgabe
// des CSP; er wird als XML-Entity &#xF000; uebergeben.
const OMA_URI = "./Device/Vendor/MSFT/Policy/Config/microsoft_edge~Policy~microsoft_edge~Extensions/ExtensionInstallForcelist";
const LIST_SEP = "&#xF000;";

const EDGE_STORE = "https://edge.microsoft.com/extensionwebstorebase/v1/crx";
const CHROME_STORE = "https://clients2.google.com/service/update2/crx";

/**
 * Bekannte Erweiterungen als Ein-Klick-Vorlage. Bitwarden gibt es in Edge unter
 * zwei Ids: die aus den Edge-Add-ons und die des Chrome Web Store, falls sie
 * von dort installiert wurde. Erzwungen wird die Edge-Variante — die zweite Id
 * ist nur fuer die Region-Registry relevant (siehe registryPolicy.js).
 */
const CATALOG = [
  {
    key: "bitwarden",
    label: "Bitwarden (Passwortmanager)",
    extensionId: "jbkfoedolllekgbhcbcoahefnbanhhlh",
    updateUrl: EDGE_STORE,
    note: "Setzt die Erweiterung; die Server-Region kommt getrennt über die Registry-Richtlinie."
  }
];

function sanitizeProfileName(name) {
  return String(name || "").replace(/[\\/:*?"<>|]/g, "").trim().slice(0, 60) || "Standard";
}

/** Erweiterungs-Ids sind 32 Kleinbuchstaben a–p. */
function sanitizeExtensions(list) {
  const out = [];
  (Array.isArray(list) ? list : []).forEach(x => {
    const id = String((x && x.extensionId) || "").trim().toLowerCase();
    const url = String((x && x.updateUrl) || EDGE_STORE).trim();
    if (!/^[a-p]{32}$/.test(id)) {
      const e = new Error("Ungültige Erweiterungs-Id: " + id + " (32 Buchstaben a–p)");
      e.status = 400; throw e;
    }
    if (!/^https:\/\//i.test(url)) {
      const e = new Error("Update-URL muss mit https:// beginnen: " + url);
      e.status = 400; throw e;
    }
    if (!out.some(o => o.extensionId === id)) out.push({ extensionId: id, updateUrl: url });
  });
  if (!out.length) { const e = new Error("Keine Erweiterung ausgewählt."); e.status = 400; throw e; }
  if (out.length > 50) { const e = new Error("Maximal 50 Erweiterungen pro Profil."); e.status = 400; throw e; }
  return out;
}

/** ADMX-Listenformat: 1&#xF000;wert&#xF000;2&#xF000;wert … */
function buildForcelistValue(extensions) {
  const parts = [];
  extensions.forEach((x, i) => {
    parts.push(String(i + 1));
    parts.push(`${x.extensionId};${x.updateUrl}`);
  });
  return `<enabled/><data id="ExtensionInstallForcelistDesc" value="${parts.join(LIST_SEP)}"/>`;
}

function knownNames(tenant, profileName) {
  return NAMING.candidates(NAME_KIND, { name: sanitizeProfileName(profileName) }, tenant && tenant.id);
}

function knownPrefixes(tenant) {
  return NAMING.candidates(NAME_KIND, { name: NAME_SEP }, tenant && tenant.id)
    .map(c => c.split(NAME_SEP)[0])
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
}

/** Vorhandene Profile dieses Werkzeugs — über alle bekannten Namensmuster. */
async function listProfiles(tenant, cert) {
  const all = await graphAllPages(tenant, cert,
    "/deviceManagement/deviceConfigurations?$select=id,displayName,lastModifiedDateTime", { retryTransient: true });
  const prefixes = knownPrefixes(tenant);
  return all
    .filter(c => prefixes.some(p => String(c.displayName || "").startsWith(p)))
    .map(c => {
      let profileName = c.displayName;
      for (const p of prefixes) { if (profileName.startsWith(p)) { profileName = profileName.slice(p.length); break; } }
      return { id: c.id, displayName: c.displayName, profileName, lastModified: c.lastModifiedDateTime };
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/**
 * Profil anlegen/aktualisieren (idempotent über alle bekannten Namen) und den
 * gewählten Gerätegruppen zuweisen.
 */
async function deployProfile(tenant, cert, { profileName, extensions, groupIds }) {
  const clean = sanitizeProfileName(profileName);
  const list = sanitizeExtensions(extensions);
  const name = NAMING.name(NAME_KIND, { name: clean }, tenant && tenant.id);

  const body = {
    "@odata.type": "#microsoft.graph.windows10CustomConfiguration",
    displayName: name,
    description: "Erzwungene Edge-Erweiterungen — erzeugt vom M365 Security Policy Manager. "
      + "Die Erweiterungen werden still installiert und können vom Benutzer nicht entfernt werden.",
    omaSettings: [{
      "@odata.type": "#microsoft.graph.omaSettingString",
      displayName: "ExtensionInstallForcelist",
      description: list.map(x => x.extensionId).join(", "),
      omaUri: OMA_URI,
      value: buildForcelistValue(list)
    }]
  };

  const all = await graphAllPages(tenant, cert,
    "/deviceManagement/deviceConfigurations?$select=id,displayName", { retryTransient: true });
  const wanted = knownNames(tenant, clean);
  const match = all.find(c => wanted.indexOf(c.displayName) >= 0);

  let profileId;
  if (match) {
    await graphReq(tenant, cert, "PATCH", `/deviceManagement/deviceConfigurations/${match.id}`, body, { retryTransient: true });
    profileId = match.id;
  } else {
    const created = await graphReq(tenant, cert, "POST", "/deviceManagement/deviceConfigurations", body, { retryTransient: true });
    profileId = created.id;
  }

  const ids = (Array.isArray(groupIds) ? groupIds : []).filter(Boolean);
  await graphReq(tenant, cert, "POST", `/deviceManagement/deviceConfigurations/${profileId}/assign`, {
    assignments: ids.map(groupId => ({
      target: { "@odata.type": "#microsoft.graph.groupAssignmentTarget", groupId }
    }))
  }, { retryTransient: true });

  return {
    profileId,
    displayName: match ? match.displayName : name,
    updated: !!match,
    extensions: list,
    assignedGroups: ids.length
  };
}

module.exports = {
  CATALOG, OMA_URI, EDGE_STORE, CHROME_STORE,
  sanitizeExtensions, sanitizeProfileName, buildForcelistValue,
  listProfiles, deployProfile
};
