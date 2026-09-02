"use strict";
/**
 * Tenant-Grundhaertung: die Standardberechtigungen des Verzeichnisses.
 *
 * Portal-Aequivalente (drei Seiten, ein Graph-Objekt):
 *   Entra ID > Benutzer > Benutzereinstellungen        (App-Registrierung, Tenant-Erstellung)
 *   Entra ID > Gruppen > Allgemein                      (Sicherheitsgruppen-Self-Service)
 *   Entra ID > Externe Identitaeten > Einstellungen     (Gastrechte, wer einladen darf)
 *   M365 Admin Center > Einstellungen > Org > Self-Service-Registrierung
 *
 * Graph fasst all das in einem Singleton zusammen:
 *   GET   /policies/authorizationPolicy
 *   PATCH /policies/authorizationPolicy
 * Permission: Policy.ReadWrite.Authorization (Application). Sie steht in
 * GRAPH_APP_PERMS_OPTIONAL — fehlt sie, meldet nur dieser Bereich, alles andere
 * laeuft weiter. Bestandstenants brauchen dafuer einmal "Reparieren".
 *
 * Anders als bei /policies/deviceRegistrationPolicy (dort PUT, Vollersatz, mit
 * der beruehmten userDeviceQuota-Falle) ist das hier ein PATCH: Es wird genau
 * das geschickt, was sich aendern soll. Trotzdem wird vorher gelesen und
 * verglichen — steht der Wert schon richtig, wird nicht geschrieben. Ein
 * Schreibvorgang ohne Wirkung ist im Kundentenant nur Risiko ohne Nutzen.
 */
const { graphReq } = require("./graph");

const POLICY_PATH = "/policies/authorizationPolicy";

// Die drei eingebauten Gastrollen. Die Werte sind feste Verzeichnis-Rollen-Ids,
// in jedem Tenant identisch — Microsoft dokumentiert sie so.
const GUEST_ROLES = {
  restricted: {
    id: "2af84b1e-32c8-42b7-82bc-daa82404023b",
    label: "Eingeschränkt (restriktivste Stufe)",
    hint: "Gäste sehen das Verzeichnis nicht — nur Eigenschaften und Mitgliedschaften eigener Objekte. Der Sollwert für Managed-Tenants."
  },
  guest: {
    id: "10dae51f-b6af-4016-8d66-8c2a99b929b3",
    label: "Standard-Gast",
    hint: "Microsofts Vorgabe: Gäste können Namen, E-Mail-Adressen und Gruppenmitgliedschaften anderer Benutzer lesen."
  },
  member: {
    id: "a0b1b346-4d3e-4e8b-98f8-753987be4970",
    label: "Wie ein Mitglied",
    hint: "Gäste haben dieselben Verzeichnisrechte wie eigene Benutzer. Für Managed-Tenants zu weit."
  }
};

const INVITE_FROM = {
  none: { label: "Niemand", hint: "Auch Administratoren laden nicht ein — nur sinnvoll, wenn externe Zusammenarbeit ganz ausgeschlossen ist." },
  adminsAndGuestInviters: { label: "Nur Administratoren und Gasteinlader", hint: "Der Sollwert: Einladungen laufen über einen benannten Kreis, nicht über jeden Mitarbeitenden." },
  adminsGuestInvitersAndAllMembers: { label: "Administratoren und alle Mitglieder", hint: "Microsofts Vorgabe — jeder Benutzer kann Externe hereinholen." },
  everyone: { label: "Alle, auch Gäste", hint: "Gäste laden weitere Gäste ein. Für Managed-Tenants nicht vertretbar." }
};

/**
 * Die Schalter dieses Bereichs — eine Liste statt verstreuter if-Zweige, damit
 * Lesen, Sollwert-Vergleich, Schreiben und die Oberflaeche dieselbe Quelle
 * benutzen. `path` ist der Ort im Graph-Objekt, `soll` der Managed-Default aus
 * der Baseline (Kap. 9.8 der Wissensbasis).
 */
const SWITCHES = [
  {
    key: "selfServiceSignUp",
    path: ["allowedToSignUpEmailBasedSubscriptions"],
    label: "Selbstregistrierung für E-Mail-basierte Abonnements",
    portal: "M365 Admin Center > Einstellungen > Organisationseinstellungen > Self-Service-Registrierung",
    soll: false,
    warum: "Sonst legen Benutzer sich eigenständig Abonnements an — unkontrollierte Identitäten ohne Onboarding-Prozess. In Academic-Tenants oft ab Werk an."
  },
  {
    key: "emailVerifiedJoin",
    path: ["allowEmailVerifiedUsersToJoinOrganization"],
    label: "Beitritt über verifizierte E-Mail-Adresse",
    portal: "M365 Admin Center > Einstellungen > Organisationseinstellungen",
    soll: false,
    warum: "Wer eine Adresse einer Tenant-Domain nachweisen kann, würde sonst selbst Mitglied — an jedem Onboarding vorbei."
  },
  {
    key: "createApps",
    path: ["defaultUserRolePermissions", "allowedToCreateApps"],
    label: "Benutzer dürfen Anwendungen registrieren",
    portal: "Entra ID > Benutzer > Benutzereinstellungen",
    soll: false,
    warum: "App-Registrierungen sind genehmigungspflichtig und laufen über benannte Konten. Ohne diese Sperre entstehen Apps mit Berechtigungen, die niemand inventarisiert."
  },
  {
    key: "createTenants",
    path: ["defaultUserRolePermissions", "allowedToCreateTenants"],
    label: "Nicht-Administratoren dürfen Tenants erstellen",
    portal: "Entra ID > Benutzer > Benutzereinstellungen",
    soll: false,
    warum: "Verhindert Shadow-Tenants: eigene Verzeichnisse neben dem betreuten, an jeder Governance vorbei."
  },
  {
    key: "createSecurityGroups",
    path: ["defaultUserRolePermissions", "allowedToCreateSecurityGroups"],
    label: "Benutzer dürfen Sicherheitsgruppen erstellen",
    portal: "Entra ID > Gruppen > Allgemein",
    soll: false,
    warum: "Das Gruppenkonzept wird zentral gesteuert — Self-Service würde es unterlaufen. Unified Groups bleiben davon unberührt: dort greifen Namensrichtlinie und Ablauf."
  },
  {
    key: "readOtherUsers",
    path: ["defaultUserRolePermissions", "allowedToReadOtherUsers"],
    label: "Benutzer dürfen andere Benutzer lesen",
    portal: "Entra ID > Benutzer > Benutzereinstellungen",
    soll: true,
    kritisch: true,
    warum: "Bleibt an. Microsoft unterstützt das Abschalten nur in Sonderfällen; aus bricht Adressbuch, Teams-Suche und Delegierung."
  }
];

/** Wert an einem Pfad im Objekt lesen, ohne bei fehlenden Zwischenebenen zu werfen. */
function at(obj, path) {
  return path.reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** Gastrolle aus der Id bestimmen — unbekannte Ids bleiben als solche sichtbar. */
function guestRoleKey(id) {
  const hit = Object.keys(GUEST_ROLES).find(k => GUEST_ROLES[k].id === String(id || "").toLowerCase());
  return hit || null;
}

async function readPolicy(tenant, certPemPath) {
  return graphReq(tenant, certPemPath, "GET", POLICY_PATH, null, { retryTransient: true });
}

/**
 * Fuers Frontend aufbereiteter Stand: je Schalter Ist, Soll und ob beides
 * uebereinstimmt. `raw` bleibt dabei, damit die Oberflaeche im Zweifel den
 * echten Graph-Stand anzeigen kann statt unserer Interpretation.
 */
function summarize(policy) {
  const p = policy || {};
  const switches = SWITCHES.map(s => {
    const ist = at(p, s.path);
    return {
      key: s.key,
      label: s.label,
      portal: s.portal,
      warum: s.warum,
      kritisch: !!s.kritisch,
      soll: s.soll,
      ist: typeof ist === "boolean" ? ist : null,
      konform: typeof ist === "boolean" ? ist === s.soll : null
    };
  });

  const roleKey = guestRoleKey(p.guestUserRoleId);
  const invite = String(p.allowInvitesFrom || "");

  return {
    switches,
    guest: {
      roleId: p.guestUserRoleId || null,
      roleKey,
      label: roleKey ? GUEST_ROLES[roleKey].label : (p.guestUserRoleId ? "Unbekannte Rolle" : "—"),
      konform: roleKey === "restricted",
      optionen: Object.keys(GUEST_ROLES).map(k => ({ key: k, ...GUEST_ROLES[k], soll: k === "restricted" }))
    },
    invites: {
      value: invite || null,
      label: INVITE_FROM[invite] ? INVITE_FROM[invite].label : (invite || "—"),
      konform: invite === "adminsAndGuestInviters",
      optionen: Object.keys(INVITE_FROM).map(k => ({ key: k, ...INVITE_FROM[k], soll: k === "adminsAndGuestInviters" }))
    },
    // Nur zur Anzeige — hier nicht schreibbar, weil beides eigene Baustellen
    // sind: SSPR haengt an der Authentifizierungsmethoden-Richtlinie, und
    // blockMsolPowerShell betrifft ein Modul, das Microsoft ohnehin abschaltet.
    info: {
      allowedToUseSSPR: typeof p.allowedToUseSSPR === "boolean" ? p.allowedToUseSSPR : null,
      blockMsolPowerShell: typeof p.blockMsolPowerShell === "boolean" ? p.blockMsolPowerShell : null
    },
    raw: p
  };
}

/** Wie viele Punkte stehen auf dem Sollwert — fuer die Kurzanzeige im Tab. */
function score(summary) {
  const items = [
    ...summary.switches.filter(s => !s.kritisch).map(s => s.konform),
    summary.guest.konform,
    summary.invites.konform
  ];
  const zaehlbar = items.filter(v => v !== null);
  return { konform: zaehlbar.filter(Boolean).length, gesamt: zaehlbar.length };
}

/**
 * Einen einzelnen Schalter setzen. Idempotent: steht der Wert schon so, wird
 * nichts geschrieben. `readOtherUsers` ist gesperrt — der Sollwert dort ist
 * "an", und ein versehentliches Aus haette tenantweite Nebenwirkungen, die
 * niemand mit einem Klick ausloesen sollte.
 */
async function setSwitch(tenant, certPemPath, key, value) {
  const def = SWITCHES.find(s => s.key === key);
  if (!def) throw Object.assign(new Error("Unbekannter Schalter: " + key), { status: 400 });
  if (def.kritisch) {
    throw Object.assign(new Error(`"${def.label}" wird vom Tool bewusst nicht umgeschaltet — im Portal ändern (${def.portal}).`), { status: 400 });
  }

  const before = await readPolicy(tenant, certPemPath);
  const want = !!value;
  if (at(before, def.path) === want) {
    return { changed: false, settings: summarize(before) };
  }

  // PATCH nur mit dem betroffenen Zweig. defaultUserRolePermissions ist ein
  // komplexes Feld: Graph ersetzt es als Ganzes, deshalb kommen die uebrigen
  // Unterfelder aus dem gelesenen Stand mit.
  let body;
  if (def.path.length === 1) {
    body = { [def.path[0]]: want };
  } else {
    const branch = Object.assign({}, before[def.path[0]] || {});
    branch[def.path[1]] = want;
    body = { [def.path[0]]: branch };
  }

  await graphReq(tenant, certPemPath, "PATCH", POLICY_PATH, body);
  const after = await readPolicy(tenant, certPemPath);
  return { changed: true, settings: summarize(after) };
}

/** Gastrolle setzen (restricted | guest | member). */
async function setGuestRole(tenant, certPemPath, roleKey) {
  const role = GUEST_ROLES[roleKey];
  if (!role) throw Object.assign(new Error("Unbekannte Gastrolle: " + roleKey), { status: 400 });
  const before = await readPolicy(tenant, certPemPath);
  if (String(before.guestUserRoleId || "").toLowerCase() === role.id) {
    return { changed: false, settings: summarize(before) };
  }
  await graphReq(tenant, certPemPath, "PATCH", POLICY_PATH, { guestUserRoleId: role.id });
  const after = await readPolicy(tenant, certPemPath);
  return { changed: true, settings: summarize(after) };
}

/** Wer Gaeste einladen darf. */
async function setInvitesFrom(tenant, certPemPath, value) {
  if (!INVITE_FROM[value]) throw Object.assign(new Error("Unbekannter Wert für Einladungen: " + value), { status: 400 });
  const before = await readPolicy(tenant, certPemPath);
  if (before.allowInvitesFrom === value) {
    return { changed: false, settings: summarize(before) };
  }
  await graphReq(tenant, certPemPath, "PATCH", POLICY_PATH, { allowInvitesFrom: value });
  const after = await readPolicy(tenant, certPemPath);
  return { changed: true, settings: summarize(after) };
}

/**
 * Alles auf den Managed-Default ziehen — in EINEM PATCH, nicht in sechs.
 * Der kritische Schalter bleibt aussen vor. Zurueck kommt, was tatsaechlich
 * geaendert wurde; stand schon alles richtig, wird gar nicht geschrieben.
 */
async function applyDefaults(tenant, certPemPath) {
  const before = await readPolicy(tenant, certPemPath);
  const body = {};
  const geaendert = [];

  const rolePerms = Object.assign({}, before.defaultUserRolePermissions || {});
  let rolePermsTouched = false;

  SWITCHES.filter(s => !s.kritisch).forEach(s => {
    if (at(before, s.path) === s.soll) return;
    geaendert.push(s.label);
    if (s.path.length === 1) body[s.path[0]] = s.soll;
    else { rolePerms[s.path[1]] = s.soll; rolePermsTouched = true; }
  });
  if (rolePermsTouched) body.defaultUserRolePermissions = rolePerms;

  if (String(before.guestUserRoleId || "").toLowerCase() !== GUEST_ROLES.restricted.id) {
    body.guestUserRoleId = GUEST_ROLES.restricted.id;
    geaendert.push("Gastzugriff auf die restriktivste Stufe");
  }
  if (before.allowInvitesFrom !== "adminsAndGuestInviters") {
    body.allowInvitesFrom = "adminsAndGuestInviters";
    geaendert.push("Einladungen nur durch Administratoren und Gasteinlader");
  }

  if (!Object.keys(body).length) {
    return { changed: false, geaendert: [], settings: summarize(before) };
  }
  await graphReq(tenant, certPemPath, "PATCH", POLICY_PATH, body);
  const after = await readPolicy(tenant, certPemPath);
  return { changed: true, geaendert, settings: summarize(after) };
}

module.exports = {
  POLICY_PATH, SWITCHES, GUEST_ROLES, INVITE_FROM,
  readPolicy, summarize, score, setSwitch, setGuestRole, setInvitesFrom, applyDefaults
};
