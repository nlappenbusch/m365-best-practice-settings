/**
 * Entra-Geraeteeinstellungen (Portal: Entra ID > Geraete > Geraeteeinstellungen).
 *
 * Graph fasst diese Seite in genau einem Objekt zusammen:
 *   GET  /policies/deviceRegistrationPolicy
 *   PUT  /policies/deviceRegistrationPolicy
 * Beides seit Maerz 2026 in v1.0 (vorher nur beta). Noetige Application-
 * Permission: Policy.ReadWrite.DeviceConfiguration — es gibt keine engere und
 * keine hoehere. Bestehende Tenants brauchen dafuer einmal "Reparieren".
 *
 * ACHTUNG, der gefaehrliche Teil: Das Update ist ein PUT und ersetzt das ganze
 * Objekt. Microsoft dokumentiert alle fuenf Felder als "Required", und fuer
 * userDeviceQuota steht ausdruecklich: fehlt sie im Body, setzt Graph sie auf 0
 * — dann kann NIEMAND mehr ein Geraet joinen, tenantweit, ohne Fehlermeldung.
 * Deshalb wird hier ausschliesslich read-modify-write gemacht: lesen, genau das
 * eine Feld aendern, alles andere unveraendert zurueckschreiben. Sieht der
 * gelesene Stand nicht vollstaendig aus, wird gar nicht geschrieben.
 */
const { graphReq } = require("./graph");

const POLICY_PATH = "/policies/deviceRegistrationPolicy";

/** Rohen Policy-Stand lesen. */
async function readPolicy(tenant, certPemPath) {
  return graphReq(tenant, certPemPath, "GET", POLICY_PATH, null, { retryTransient: true });
}

/**
 * Nur die schreibbaren Felder — id/displayName/description sind read-only und
 * werden von Graph zurueckgewiesen. Wirft, wenn der gelesene Stand unvollstaendig
 * ist: lieber ein Fehler als ein PUT, das die Quota auf 0 zieht.
 */
function writableBody(policy) {
  const p = policy || {};
  if (typeof p.userDeviceQuota !== "number") {
    throw new Error("Geraeteeinstellungen unvollstaendig gelesen (userDeviceQuota fehlt) — nicht geschrieben, "
      + "sonst wuerde Graph die Quota auf 0 setzen und alle Geraeteregistrierungen blockieren.");
  }
  if (!p.azureADJoin || !p.azureADRegistration || !p.multiFactorAuthConfiguration) {
    throw new Error("Geraeteeinstellungen unvollstaendig gelesen (Join-/Registrierungs-/MFA-Teil fehlt) — nicht geschrieben.");
  }
  return {
    userDeviceQuota: p.userDeviceQuota,
    multiFactorAuthConfiguration: p.multiFactorAuthConfiguration,
    azureADRegistration: p.azureADRegistration,
    azureADJoin: p.azureADJoin,
    localAdminPassword: { isEnabled: !!(p.localAdminPassword || {}).isEnabled }
  };
}

/** Polymorphe Mitgliedschaft ("wer darf?") in einen lesbaren Satz uebersetzen. */
function describeMembership(m) {
  const type = String((m || {})["@odata.type"] || "");
  if (/allDeviceRegistrationMembership/i.test(type)) return "Alle";
  if (/noDeviceRegistrationMembership/i.test(type)) return "Niemand";
  if (/enumeratedDeviceRegistrationMembership/i.test(type)) {
    const u = ((m || {}).users || []).length, g = ((m || {}).groups || []).length;
    return `Ausgewaehlte (${u} Benutzer, ${g} Gruppen)`;
  }
  return m ? "unbekannt" : "—";
}

/** Fuers Frontend aufbereiteter Stand — der Rohstand bleibt als `raw` dabei. */
function summarize(policy) {
  const p = policy || {};
  const join = p.azureADJoin || {};
  const reg = p.azureADRegistration || {};
  return {
    lapsEnabled: !!(p.localAdminPassword || {}).isEnabled,
    userDeviceQuota: typeof p.userDeviceQuota === "number" ? p.userDeviceQuota : null,
    multiFactorAuthConfiguration: p.multiFactorAuthConfiguration || null,
    joinAllowed: describeMembership(join.allowedToJoin),
    joinAdminConfigurable: join.isAdminConfigurable !== false,
    localAdminsGlobalAdmins: !!((join.localAdmins || {}).enableGlobalAdmins),
    localAdminsRegisteringUsers: describeMembership((join.localAdmins || {}).registeringUsers),
    registerAllowed: describeMembership(reg.allowedToRegister),
    registerAdminConfigurable: reg.isAdminConfigurable !== false,
    raw: p
  };
}

/**
 * LAPS ein- oder ausschalten. Idempotent: steht der Wert schon richtig, wird
 * nicht geschrieben (changed:false) — ein PUT nur zum Bestaetigen waere unnoetiges
 * Risiko an einem tenantweiten Objekt.
 */
async function setLapsEnabled(tenant, certPemPath, enabled) {
  const before = await readPolicy(tenant, certPemPath);
  const body = writableBody(before);
  const want = !!enabled;
  if (body.localAdminPassword.isEnabled === want) {
    return { changed: false, before: summarize(before), policy: summarize(before) };
  }
  body.localAdminPassword = { isEnabled: want };
  const updated = await graphReq(tenant, certPemPath, "PUT", POLICY_PATH, body);
  // PUT liefert laut Doku das aktualisierte Objekt zurueck; falls doch leer,
  // den Stand frisch lesen statt den Wunschwert zu behaupten.
  const after = (updated && typeof updated.userDeviceQuota === "number") ? updated : await readPolicy(tenant, certPemPath);
  return { changed: true, before: summarize(before), policy: summarize(after) };
}

module.exports = { readPolicy, summarize, setLapsEnabled, writableBody, describeMembership, POLICY_PATH };
