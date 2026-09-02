/**
 * Automatische MDM-Einschreibung (Portal: Entra ID > Mobilitaet (MDM und MAM) >
 * Microsoft Intune, gleichbedeutend Intune > Geraete > Registrierung > Windows >
 * Automatische Registrierung).
 *
 *   GET   /beta/policies/mobileDeviceManagementPolicies
 *   PATCH /beta/policies/mobileDeviceManagementPolicies/{id}
 *
 * WARUM HIER EIN TOKEN STATT DES TENANT-ZERTIFIKATS REINKOMMT: Graph laesst
 * diesen Endpunkt NICHT app-only zu. Ein Client-Credentials-Token bekommt
 * "Unsupported app-only call" zurueck, und Policy.ReadWrite.MobilityManagement
 * existiert nur als delegierte Berechtigung. Der Rest des Konfigurators
 * arbeitet app-only per Zertifikat — dieser eine Schalter braucht deshalb eine
 * einmalige Admin-Anmeldung per Device-Code (wie Onboarding und Offboarding).
 * Wer das hier auf graphReq umstellt, baut den Fehler von 2.25 nach.
 *
 * Der Schalter selbst ist die Voraussetzung, ohne die ein Geraet zwar Entra
 * beitritt, aber nie in Intune landet — Autopilot eingeschlossen. Microsoft
 * fuehrt "Configure Microsoft Entra automatic enrollment" unter den
 * Autopilot-Pflichtvoraussetzungen.
 */
const GRAPH_BETA = "https://graph.microsoft.com/beta";
const LIST_PATH = "/policies/mobileDeviceManagementPolicies";
const INTUNE_APP_ID = "0000000a-0000-0000-c000-000000000000";
const SCOPES = ["none", "some", "all"];
const REG_FLAG = "isMdmEnrollmentDuringRegistrationDisabled";
/** Delegierter Scope fuer den Device-Code-Login. */
const GRAPH_SCOPE = "Policy.ReadWrite.MobilityManagement offline_access openid";

function bad(msg, status) { const e = new Error(msg); e.status = status || 400; return e; }

/** Graph-beta mit delegiertem Bearer-Token. */
async function gBeta(token, method, path, body) {
  const r = await fetch(GRAPH_BETA + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let j; try { j = text ? JSON.parse(text) : {}; } catch { j = { raw: text }; }
  if (!r.ok) {
    const msg = (j && j.error && j.error.message) ? j.error.message : (text || ("Graph " + r.status));
    throw bad(msg, r.status);
  }
  return j;
}

/**
 * Die Intune-Richtlinie holen — ueber die uebliche Id, sonst ueber Name oder
 * Ermittlungs-URL. Gesucht statt hart verdrahtet: ein PATCH auf eine erratene
 * Id im Kundentenant ist die Abkuerzung nicht wert.
 */
async function findIntunePolicy(token) {
  const r = await gBeta(token, "GET", LIST_PATH);
  const list = (r && r.value) || [];
  if (!list.length) throw bad("Keine Mobilitaets-Richtlinien im Tenant gefunden — automatische Einschreibung braucht Entra ID P1.", 412);
  const hit = list.find(p => String(p.id || "").toLowerCase() === INTUNE_APP_ID)
    || list.find(p => /microsoft intune$/i.test(String(p.displayName || "")))
    || list.find(p => /manage\.microsoft\.com/i.test(String(p.discoveryUrl || "")));
  if (!hit) throw bad("Microsoft-Intune-Richtlinie nicht gefunden. Vorhanden: " + list.map(p => p.displayName).join(", "), 404);
  return hit;
}

function summarize(p) {
  const scope = String((p || {}).appliesTo || "none").toLowerCase();
  return {
    id: p.id,
    displayName: p.displayName || "Microsoft Intune",
    scope,
    scopeLabel: scope === "all" ? "Alle" : scope === "some" ? "Einige" : "Keine",
    autoEnrollActive: scope === "all" || scope === "some",
    discoveryUrl: p.discoveryUrl || null,
    termsOfUseUrl: p.termsOfUseUrl || null,
    complianceUrl: p.complianceUrl || null,
    urlsComplete: !!(p.discoveryUrl && p.termsOfUseUrl && p.complianceUrl),
    regFlagSupported: Object.prototype.hasOwnProperty.call(p || {}, REG_FLAG),
    regFlagDisabled: !!(p || {})[REG_FLAG]
  };
}

async function read(token) {
  return summarize(await findIntunePolicy(token));
}

/**
 * Benutzerbereich setzen. Idempotent: steht alles schon richtig, wird nicht
 * geschrieben. `blockDuringRegistration` wird nur mitgeschickt, wenn der Tenant
 * das Feld kennt — es ist Public Preview und in der Ressourcen-Doku (09/2026)
 * nicht aufgefuehrt; sonst landete eine Tippfehler-Eigenschaft still im Objekt.
 */
async function apply(token, { scope, blockDuringRegistration } = {}) {
  const want = String(scope || "all").toLowerCase();
  if (!SCOPES.includes(want)) throw bad("Benutzerbereich muss none, some oder all sein.");
  if (want === "some") throw bad("Benutzerbereich 'Einige' braucht eine Gruppenauswahl und wird hier nicht gesetzt — im Portal konfigurieren.");

  const before = await findIntunePolicy(token);
  const body = {};
  if (String(before.appliesTo || "").toLowerCase() !== want) body.appliesTo = want;
  if (blockDuringRegistration !== undefined && Object.prototype.hasOwnProperty.call(before, REG_FLAG)
      && !!before[REG_FLAG] !== !!blockDuringRegistration) {
    body[REG_FLAG] = !!blockDuringRegistration;
  }
  if (!Object.keys(body).length) {
    return { changed: false, before: summarize(before), policy: summarize(before), regFlagSkipped: false };
  }
  await gBeta(token, "PATCH", `${LIST_PATH}/${before.id}`, body);
  const after = await findIntunePolicy(token);
  return {
    changed: true,
    before: summarize(before),
    policy: summarize(after),
    // Ehrlich melden, wenn es den Preview-Schalter im Tenant nicht gibt — sonst
    // glaubt der Anwender, er haette ihn gesetzt.
    regFlagSkipped: blockDuringRegistration !== undefined && !Object.prototype.hasOwnProperty.call(before, REG_FLAG)
  };
}

module.exports = { read, apply, findIntunePolicy, summarize, SCOPES, GRAPH_SCOPE, LIST_PATH, INTUNE_APP_ID, REG_FLAG };
