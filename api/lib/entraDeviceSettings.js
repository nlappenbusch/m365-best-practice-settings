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
 * Gemeinsamer Schreibweg fuer alle Schalter dieser Seite: lesen, den vollen
 * schreibbaren Koerper bauen, `mutate` genau ein Feld aendern lassen, schreiben.
 * Meldet `mutate` false zurueck ("steht schon so"), wird gar nicht geschrieben.
 *
 * Warum nicht jede Funktion fuer sich: Es gibt hier nur einen einzigen sicheren
 * Ablauf (read-modify-write mit Vollstaendigkeitspruefung). Jede Kopie davon
 * waere eine Stelle, an der die userDeviceQuota-Falle wieder aufgehen kann.
 */
async function updatePolicy(tenant, certPemPath, mutate) {
  const before = await readPolicy(tenant, certPemPath);
  const body = writableBody(before);
  if (mutate(body, before) === false) {
    return { changed: false, before: summarize(before), policy: summarize(before) };
  }
  const updated = await graphReq(tenant, certPemPath, "PUT", POLICY_PATH, body);
  // PUT liefert laut Doku das aktualisierte Objekt zurueck; falls doch leer,
  // den Stand frisch lesen statt den Wunschwert zu behaupten.
  const after = (updated && typeof updated.userDeviceQuota === "number") ? updated : await readPolicy(tenant, certPemPath);
  return { changed: true, before: summarize(before), policy: summarize(after) };
}

/**
 * LAPS ein- oder ausschalten. Idempotent: steht der Wert schon richtig, wird
 * nicht geschrieben (changed:false) — ein PUT nur zum Bestaetigen waere unnoetiges
 * Risiko an einem tenantweiten Objekt.
 */
async function setLapsEnabled(tenant, certPemPath, enabled) {
  const want = !!enabled;
  return updatePolicy(tenant, certPemPath, (body) => {
    if (body.localAdminPassword.isEnabled === want) return false;
    body.localAdminPassword = { isEnabled: want };
  });
}

// ---------------------------------------------------------------- Mitgliedschaften
// Die polymorphen "wer darf?"-Felder kennen drei Auspraegungen. Sie werden hier
// gebaut statt an den Aufrufstellen zusammengesteckt, weil ein falscher
// @odata.type von Graph nicht als Fehler, sondern als "niemand" interpretiert
// werden kann — und das faellt erst auf, wenn kein Geraet mehr joint.
const MEMBERSHIP_TYPES = {
  all: "#microsoft.graph.allDeviceRegistrationMembership",
  none: "#microsoft.graph.noDeviceRegistrationMembership",
  selected: "#microsoft.graph.enumeratedDeviceRegistrationMembership"
};

function buildMembership(mode, groupIds, userIds) {
  if (mode === "all" || mode === "none") return { "@odata.type": MEMBERSHIP_TYPES[mode] };
  if (mode !== "selected") throw Object.assign(new Error("Unbekannter Modus: " + mode), { status: 400 });
  const groups = (groupIds || []).filter(Boolean);
  const users = (userIds || []).filter(Boolean);
  if (!groups.length && !users.length) {
    throw Object.assign(new Error("Für „Ausgewählte“ mindestens eine Gruppe oder einen Benutzer angeben — sonst darf faktisch niemand, ohne dass es so dasteht."), { status: 400 });
  }
  return { "@odata.type": MEMBERSHIP_TYPES.selected, users, groups };
}

/** Zwei Mitgliedschaften vergleichen, um ein PUT ohne Wirkung zu vermeiden. */
function sameMembership(a, b) {
  const ta = String((a || {})["@odata.type"] || ""), tb = String((b || {})["@odata.type"] || "");
  if (ta.toLowerCase() !== tb.toLowerCase()) return false;
  if (!/enumerated/i.test(ta)) return true;
  const norm = x => [...new Set(x || [])].map(String).sort().join(",");
  return norm((a || {}).groups) === norm((b || {}).groups) && norm((a || {}).users) === norm((b || {}).users);
}

/**
 * Wer Geraete per Entra-Join in den Tenant bringen darf.
 * Managed-Default: "Ausgewählte" (IT-Koordinatoren) oder "Niemand" — Geraete
 * kommen kontrolliert ueber Autopilot. Ab Werk duerfen alle Benutzer bis zu
 * 20 Geraete selbst joinen; so landen private Geraete im Tenant, sobald sich
 * jemand mit Firmen-Anmeldedaten anmeldet.
 */
async function setJoinAllowed(tenant, certPemPath, { mode, groupIds, userIds }) {
  const want = buildMembership(mode, groupIds, userIds);
  return updatePolicy(tenant, certPemPath, (body) => {
    const join = body.azureADJoin || {};
    if (sameMembership(join.allowedToJoin, want)) return false;
    body.azureADJoin = Object.assign({}, join, { allowedToJoin: want });
  });
}

/** Dasselbe fuer die Geraete-Registrierung (BYOD/Workplace Join). */
async function setRegisterAllowed(tenant, certPemPath, { mode, groupIds, userIds }) {
  const want = buildMembership(mode, groupIds, userIds);
  return updatePolicy(tenant, certPemPath, (body) => {
    const reg = body.azureADRegistration || {};
    if (sameMembership(reg.allowedToRegister, want)) return false;
    body.azureADRegistration = Object.assign({}, reg, { allowedToRegister: want });
  });
}

/**
 * Lokale Administratoren beim Entra-Join.
 * Managed-Default: Globale Administratoren NEIN (Tier-Trennung — GAs haben auf
 * Endgeraeten nichts verloren), registrierender Benutzer NIEMAND (Benutzer
 * bleiben Standardbenutzer). Lokale Rechte laufen ueber LAPS und, befristet,
 * ueber die Intune-Policy fuer die Einfuehrungsphase.
 */
async function setLocalAdmins(tenant, certPemPath, { globalAdmins, registeringUsers, groupIds }) {
  return updatePolicy(tenant, certPemPath, (body) => {
    const join = body.azureADJoin || {};
    const local = Object.assign({}, join.localAdmins || {});
    let touched = false;

    if (typeof globalAdmins === "boolean" && !!local.enableGlobalAdmins !== globalAdmins) {
      local.enableGlobalAdmins = globalAdmins;
      touched = true;
    }
    if (registeringUsers) {
      const want = buildMembership(registeringUsers, groupIds, null);
      if (!sameMembership(local.registeringUsers, want)) { local.registeringUsers = want; touched = true; }
    }
    if (!touched) return false;
    body.azureADJoin = Object.assign({}, join, { localAdmins: local });
  });
}

/**
 * Geraetekontingent pro Benutzer. Microsofts Vorgabe ist 20; im Managed-Setup
 * mit Autopilot braucht ein Benutzer keines, weil nicht er das Geraet einbringt.
 * 0 ist erlaubt und heisst wirklich null — deshalb der explizite Typcheck statt
 * einer Wahrheitswertpruefung.
 */
async function setDeviceQuota(tenant, certPemPath, quota) {
  const n = Number(quota);
  if (!Number.isInteger(n) || n < 0 || n > 20) {
    throw Object.assign(new Error("Gerätekontingent muss eine ganze Zahl zwischen 0 und 20 sein."), { status: 400 });
  }
  return updatePolicy(tenant, certPemPath, (body) => {
    if (body.userDeviceQuota === n) return false;
    body.userDeviceQuota = n;
  });
}

module.exports = {
  readPolicy, summarize, writableBody, describeMembership, POLICY_PATH,
  updatePolicy, setLapsEnabled, setJoinAllowed, setRegisterAllowed, setLocalAdmins, setDeviceQuota,
  buildMembership, sameMembership, MEMBERSHIP_TYPES
};
