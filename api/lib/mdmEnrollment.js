/**
 * Automatische MDM-Einschreibung (Portal: Entra ID > Mobilitaet (MDM und MAM) >
 * Microsoft Intune, bzw. Intune > Geraete > Registrierung > Automatische
 * Registrierung).
 *
 * Graph bildet das als mobilityManagementPolicy ab:
 *   GET   /beta/policies/mobileDeviceManagementPolicies
 *   PATCH /beta/policies/mobileDeviceManagementPolicies/{id}
 * Nur beta. Permission: Policy.ReadWrite.MobilityManagement.
 *
 * Warum das der wichtigste Schalter im Tenant ist: Autopilot joint das Geraet
 * nur in Entra. Das Einschreiben in Intune stoesst danach Entra an — und zwar
 * genau ueber diese Richtlinie. Steht appliesTo auf "none", wird das Geraet
 * zwar Entra-beigetreten, bleibt aber unverwaltet. Microsoft fuehrt
 * "Configure Microsoft Entra automatic enrollment" deshalb unter den
 * Pflichtvoraussetzungen fuer Autopilot.
 *
 * Zwei Dinge werden hier bewusst NICHT geraten:
 *  - Die Richtlinien-Id wird gesucht, nicht hart verdrahtet. Die Intune-Policy
 *    traegt zwar ueblicherweise 0000000a-0000-0000-c000-000000000000, aber ein
 *    PATCH auf eine erratene Id im Kundentenant ist es nicht wert.
 *  - isMdmEnrollmentDuringRegistrationDisabled ist Public Preview und in der
 *    Ressourcen-Doku (Stand 09/2026) nicht aufgefuehrt. Geschrieben wird das
 *    Feld nur, wenn der GET es tatsaechlich zurueckliefert — sonst wuerde eine
 *    Tippfehler-Eigenschaft still im Objekt landen.
 */
const { graphReq } = require("./graph");

const BETA = { beta: true };
const LIST_PATH = "/policies/mobileDeviceManagementPolicies";
const INTUNE_APP_ID = "0000000a-0000-0000-c000-000000000000";
const SCOPES = ["none", "some", "all"];
const REG_FLAG = "isMdmEnrollmentDuringRegistrationDisabled";

function bad(msg, status) { const e = new Error(msg); e.status = status || 400; return e; }

/** Die Intune-Richtlinie aus der Liste holen — ueber Id, sonst ueber den Namen. */
async function findIntunePolicy(tenant, certPemPath) {
  const r = await graphReq(tenant, certPemPath, "GET", LIST_PATH, null, { ...BETA, retryTransient: true });
  const list = (r && r.value) || [];
  if (!list.length) throw bad("Keine Mobilitaets-Richtlinien im Tenant gefunden — automatische Einschreibung braucht Entra ID P1.", 412);
  const hit = list.find(p => String(p.id || "").toLowerCase() === INTUNE_APP_ID)
    || list.find(p => /microsoft intune$/i.test(String(p.displayName || "")))
    || list.find(p => /manage\.microsoft\.com/i.test(String(p.discoveryUrl || "")));
  if (!hit) throw bad("Microsoft-Intune-Richtlinie nicht gefunden. Vorhanden: " + list.map(p => p.displayName).join(", "), 404);
  return hit;
}

/** Anzeigefertiger Stand. `regFlagSupported` sagt, ob der Preview-Schalter da ist. */
function summarize(p) {
  const scope = String((p || {}).appliesTo || "none").toLowerCase();
  return {
    id: p.id,
    displayName: p.displayName || "Microsoft Intune",
    scope,
    scopeLabel: scope === "all" ? "Alle" : scope === "some" ? "Einige" : "Keine",
    autoEnrollActive: scope === "all" || scope === "some",
    isValid: p.isValid !== false,
    discoveryUrl: p.discoveryUrl || null,
    termsOfUseUrl: p.termsOfUseUrl || null,
    complianceUrl: p.complianceUrl || null,
    urlsComplete: !!(p.discoveryUrl && p.termsOfUseUrl && p.complianceUrl),
    regFlagSupported: Object.prototype.hasOwnProperty.call(p || {}, REG_FLAG),
    regFlagDisabled: !!(p || {})[REG_FLAG]
  };
}

async function read(tenant, certPemPath) {
  return summarize(await findIntunePolicy(tenant, certPemPath));
}

/**
 * Einschreibung scharf stellen. `scope` = none|some|all. `blockDuringRegistration`
 * ist optional und wird nur mitgeschickt, wenn der Tenant das Feld kennt.
 * Idempotent: steht schon alles richtig, wird nicht geschrieben.
 */
async function apply(tenant, certPemPath, { scope, blockDuringRegistration } = {}) {
  const want = String(scope || "all").toLowerCase();
  if (!SCOPES.includes(want)) throw bad("Benutzerbereich muss none, some oder all sein.");
  if (want === "some") throw bad("Benutzerbereich 'Einige' braucht eine Gruppenauswahl und wird hier nicht gesetzt — im Portal konfigurieren.");

  const before = await findIntunePolicy(tenant, certPemPath);
  const body = {};
  if (String(before.appliesTo || "").toLowerCase() !== want) body.appliesTo = want;
  if (blockDuringRegistration !== undefined && Object.prototype.hasOwnProperty.call(before, REG_FLAG)
      && !!before[REG_FLAG] !== !!blockDuringRegistration) {
    body[REG_FLAG] = !!blockDuringRegistration;
  }
  if (!Object.keys(body).length) {
    return { changed: false, before: summarize(before), policy: summarize(before), regFlagSkipped: false };
  }
  await graphReq(tenant, certPemPath, "PATCH", `${LIST_PATH}/${before.id}`, body, { ...BETA, retryTransient: true });
  const after = await findIntunePolicy(tenant, certPemPath);
  return {
    changed: true,
    before: summarize(before),
    policy: summarize(after),
    // Ehrlich melden, wenn der Preview-Schalter im Tenant gar nicht existiert:
    // sonst glaubt der Anwender, er haette ihn gesetzt.
    regFlagSkipped: blockDuringRegistration !== undefined && !Object.prototype.hasOwnProperty.call(before, REG_FLAG)
  };
}

module.exports = { read, apply, findIntunePolicy, summarize, SCOPES, LIST_PATH, INTUNE_APP_ID, REG_FLAG };
