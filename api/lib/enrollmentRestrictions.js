"use strict";
/**
 * Intune-Registrierungseinschraenkungen — die Geraeteseite dessen, was
 * lib/tenantHardening.js und lib/entraDeviceSettings.js auf der Entra-Seite tun.
 *
 * Portal-Aequivalent: Intune > Geraete > Registrieren > Registrierungs-
 * einschraenkungen > Geraetetypeinschraenkungen.
 *
 * Graph:
 *   GET   /deviceManagement/deviceEnrollmentConfigurations
 *   PATCH /deviceManagement/deviceEnrollmentConfigurations/{id}
 * Permission: DeviceManagementServiceConfig.ReadWrite.All (hat das Tool bereits).
 *
 * Warum das neben dem Entra-Schalter noetig ist: "Users may join devices" in
 * Entra regelt den Entra-Join. Die Intune-Einschraenkung regelt die MDM-
 * Einschreibung. Wer nur den einen setzt, hat die andere Tuer offen — deshalb
 * nennt die Onboarding-Checkliste beide, und deshalb zeigt das Tool sie
 * nebeneinander.
 *
 * Zwei Objektformen, historisch gewachsen:
 *   deviceEnrollmentPlatformRestrictionsConfiguration  (Plural, die alte
 *       Sammelrichtlinie mit einem Block je Plattform — das ist auch die
 *       Standardrichtlinie mit Prioritaet 0)
 *   deviceEnrollmentPlatformRestrictionConfiguration   (Singular, neuer, eine
 *       Richtlinie je Plattform)
 * Beide koennen im selben Tenant vorkommen. Wer nur die eine kennt, uebersieht
 * im Zweifel genau die, die greift.
 */
const { graphReq, graphAllPages } = require("./graph");

const PATH = "/deviceManagement/deviceEnrollmentConfigurations";
const TYPE_PLURAL = "#microsoft.graph.deviceEnrollmentPlatformRestrictionsConfiguration";
const TYPE_SINGULAR = "#microsoft.graph.deviceEnrollmentPlatformRestrictionConfiguration";

/** Nur die Windows-Plattform interessiert hier — der Managed-Bestand ist Windows. */
function windowsPart(cfg) {
  const type = String(cfg["@odata.type"] || "");
  if (type === TYPE_PLURAL) {
    return { feld: "windowsRestriction", restriction: cfg.windowsRestriction || null };
  }
  if (type === TYPE_SINGULAR && /^windows/i.test(String(cfg.platformType || ""))) {
    return { feld: "platformRestriction", restriction: cfg.platformRestriction || null };
  }
  return null;
}

/**
 * Alle Richtlinien mit Windows-Bezug, aufbereitet. Die Standardrichtlinie
 * (Prioritaet 0) ist die, die ohne Zuweisung fuer alle gilt — sie steht deshalb
 * zuerst und ist der Ort, an dem der Managed-Default hingehoert.
 */
async function list(tenant, certPemPath) {
  const all = await graphAllPages(tenant, certPemPath, PATH, { retryTransient: true });
  const items = [];
  all.forEach(cfg => {
    const part = windowsPart(cfg);
    if (!part || !part.restriction) return;
    const r = part.restriction;
    items.push({
      id: cfg.id,
      displayName: cfg.displayName || (cfg.priority === 0 ? "Alle Benutzer (Standard)" : "(ohne Namen)"),
      priority: typeof cfg.priority === "number" ? cfg.priority : null,
      istStandard: cfg.priority === 0,
      odataType: cfg["@odata.type"],
      feld: part.feld,
      platformBlocked: !!r.platformBlocked,
      personalDeviceEnrollmentBlocked: !!r.personalDeviceEnrollmentBlocked,
      osMinimumVersion: r.osMinimumVersion || null,
      osMaximumVersion: r.osMaximumVersion || null,
      konform: !!r.personalDeviceEnrollmentBlocked
    });
  });
  items.sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));
  return items;
}

/**
 * Private Geraete fuer eine Richtlinie sperren oder freigeben.
 *
 * Read-modify-write, weil der Restriction-Block als Ganzes ersetzt wird: Wer
 * nur `personalDeviceEnrollmentBlocked` schickt, verliert eine gesetzte
 * Mindest-OS-Version oder eine Herstellersperre still mit.
 */
async function setPersonalBlocked(tenant, certPemPath, configId, blocked) {
  const cfg = await graphReq(tenant, certPemPath, "GET", `${PATH}/${encodeURIComponent(configId)}`, null, { retryTransient: true });
  const part = windowsPart(cfg);
  if (!part || !part.restriction) {
    throw Object.assign(new Error("Diese Registrierungseinschränkung hat keinen Windows-Teil — nichts geändert."), { status: 400 });
  }
  const want = !!blocked;
  if (!!part.restriction.personalDeviceEnrollmentBlocked === want) {
    return { changed: false, items: await list(tenant, certPemPath) };
  }

  const restriction = Object.assign({}, part.restriction, { personalDeviceEnrollmentBlocked: want });
  const body = { "@odata.type": cfg["@odata.type"], [part.feld]: restriction };
  await graphReq(tenant, certPemPath, "PATCH", `${PATH}/${encodeURIComponent(configId)}`, body);
  return { changed: true, items: await list(tenant, certPemPath) };
}

module.exports = { list, setPersonalBlocked, PATH, TYPE_PLURAL, TYPE_SINGULAR, windowsPart };
