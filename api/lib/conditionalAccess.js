/**
 * Conditional-Access-Deployment: rollt eine der drei Policy-Vorlagen (siehe
 * conditionalAccessPolicies.js) app-only in einen Tenant aus.
 *
 * Sicherheitsleitplanken (Conditional Access kann im schlimmsten Fall den
 * gesamten Tenant aussperren - anders als jede andere Automatisierung in
 * diesem Tool):
 *  - JEDE Policy wird IMMER mit state="enabledForReportingButNotEnforced"
 *    angelegt, komplett unabhaengig vom state-Feld in der Vorlage. Es gibt
 *    keinen Code-Pfad, der eine Policy direkt scharf anlegt.
 *  - Vier Schutzgruppen (Break-Glass, Sync-Konten, zwei Ausnahme-Gruppen)
 *    werden VOR dem Deploy sichergestellt und in jede Policy als Ausschluss
 *    eingetragen. Sie werden LEER angelegt - der Admin muss sie selbst
 *    befuellen (siehe UI-Warnhinweis).
 *  - Nur eigene Policies (erkennbar am Namensschema "<Nr> - BP - ...") werden
 *    von diesem Modul verwaltet; bestehende Fremd-Policies werden nie
 *    angefasst.
 *  - Aktivieren (state -> "enabled") ist ein bewusst getrennter, expliziter
 *    Schritt (setPolicyState) - nie Teil des Deploys.
 */
const { graphReq, graphAllPages } = require("./graph");
const NAMING = require("./naming");
const { CA_POLICY_TEMPLATES } = require("./conditionalAccessPolicies");

const TIER_META = {
  bareMinimum: {
    label: "Ohne Geräte-Compliance",
    shortLabel: "Bare Minimum",
    description: "Nur Authentication-Strength/MFA — keine Geräte-Compliance-Anforderung irgendeiner Art. " +
      "Funktioniert unabhängig davon, ob Geräte Intune-verwaltet/compliant sind. Keine zusätzliche Lizenz nötig.",
    license: "Keine Zusatzlizenz nötig (Security Defaults-Niveau, aber granularer)."
  },
  aadp1: {
    label: "Mit Geräte-Compliance (Entra ID P1)",
    shortLabel: "AADP1",
    description: "Erweitert um Geräte-Compliance/Hybrid-Join als zusätzliche Optionen, Anwendungsschutz (App Protection) " +
      "und mehr Attack-Surface-Reduction-Regeln.",
    license: "Braucht Microsoft Entra ID P1 (in M365 Business Premium/E3 enthalten)."
  },
  aadp1p2: {
    label: "Vollausbau (Entra ID P1+P2)",
    shortLabel: "AADP1+P2",
    description: "Zusätzlich Sign-in-/User-Risk-basierte Policies (Identity Protection), Insider-Risk-Signale und " +
      "Session-Kontrollen (Token-Schutz).",
    license: "Braucht Microsoft Entra ID P2 (in M365 E5 enthalten) zusätzlich zu P1."
  },
  deviceFirst: {
    label: "Gerät statt Standort (MFA + verwaltetes Gerät)",
    shortLabel: "Gerät statt Standort",
    description: "MFA (400) und verwaltetes Gerät (401) als zwei getrennte Policies — innerhalb einer Policy sind " +
      "Gewährungen mit ODER verknüpft, zwischen Policies gilt UND. Nur so gilt beides statt eines von beidem. " +
      "Keine der beiden hat eine Standortbedingung: Der Aufenthaltsort entscheidet nicht mehr über den Zugang, " +
      "eine bestehende Ländersperre wird dadurch entbehrlich. Normale MFA genügt (Authenticator), es sperrt " +
      "also niemanden ohne FIDO2-Schlüssel aus.",
    license: "Braucht Entra ID P1. VORAUSSETZUNG: Die Geräte müssen in Intune verwaltet sein — sonst ist 401 " +
      "keine Grundlinie, sondern eine Aussperrung."
  },
  deviceFirstStrong: {
    label: "Gerät statt Standort, phishing-resistent",
    shortLabel: "Gerät + Strong Auth",
    description: "Wie «Gerät statt Standort», aber die MFA-Hälfte verlangt phishing-resistente Authentication " +
      "Strength (409 statt 400): FIDO2, Windows Hello oder Zertifikat. Der stärkere Endzustand.",
    license: "Braucht Entra ID P1 und Intune-verwaltete Geräte. VORAUSSETZUNG: FIDO2/Windows Hello muss " +
      "ausgerollt sein — sonst sperrt das Scharfschalten alle aus."
  }
};

// Die Namen kommen aus der Namenskonvention (lib/naming.js); `kind` verweist
// auf das jeweilige Muster. Gesucht wird ueber alle bekannten Muster, damit
// nach einem Schemawechsel die bestehende Gruppe gefunden und nicht gedoppelt
// wird — eine zweite, leere Break-Glass-Ausnahmegruppe waere gefaehrlich.
const SUPPORT_GROUPS = [
  { key: "exclusionTemp", kind: "caExclusionTemp", placeholder: "<ExclusionTempGroup>", desc: "Temporäre Ausnahmen von Conditional-Access-Policies (z.B. Troubleshooting) — zeitnah wieder leeren." },
  { key: "exclusionPerm", kind: "caExclusionPerm", placeholder: "<ExclusionPermGroup>", desc: "Dauerhafte, bewusst dokumentierte Ausnahmen von Conditional-Access-Policies (z.B. Legacy-Systemkonten)." },
  { key: "breakGlass", kind: "caBreakGlass", placeholder: "<EmergencyAccessAccountsGroup>", desc: "Notfallzugriffskonten (Break-Glass) — WICHTIG: mit mindestens einem Konto befüllen, bevor Policies aktiviert werden." },
  { key: "syncAccounts", kind: "caSyncAccounts", placeholder: "<SynchronizationServiceAccountsGroup>", desc: "Entra-Connect-/Synchronisierungs-Dienstkonten — dürfen nie durch interaktive Auth-Anforderungen blockiert werden." }
];

/** Sollname einer Schutzgruppe nach der Konvention des Tenants. */
function supportGroupName(key, tenantId) {
  const g = SUPPORT_GROUPS.find(x => x.key === key);
  if (!g) throw new Error("Unbekannte CA-Schutzgruppe: " + key);
  return NAMING.name(g.kind, {}, tenantId);
}

function odataLit(s) { return String(s || "").replace(/'/g, "''"); }

/**
 * Ring-Konzept (aus AlexFilipin/ConditionalAccess Deploy-Policies.ps1):
 * Der Ring-Name ersetzt den <RING>-Platzhalter im Policy-Namen — dasselbe
 * Policy-Set kann so mehrfach nebeneinander existieren (z.B. PILOT und BROAD).
 * "Ring-getargetet" bedeutet: Policies, die auf "All users" zielen wuerden,
 * zielen stattdessen auf die Ring-Gruppe AAD-CA-RING-<RING> — damit testet
 * man das Set erst an einer Pilotgruppe, bevor der breite Ring auf alle geht.
 */
function normalizeRing(ring) {
  const r = String(ring || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{2,12}$/.test(r)) throw new Error("Ungueltiger Ring-Name (2-12 Zeichen, A-Z/0-9): " + ring);
  return r;
}

function ringGroupName(ring, tenantId) {
  return NAMING.name("caRing", { ring: normalizeRing(ring) }, tenantId);
}

/** Ring-Gruppe sicherstellen (idempotent, leer angelegt). Rueckgabe: { id, name, created }. */
async function ensureRingGroup(tenant, certPemPath, ring) {
  const tenantId = tenant && tenant.id;
  const name = ringGroupName(ring, tenantId);
  for (const candidate of NAMING.candidates("caRing", { ring: normalizeRing(ring) }, tenantId)) {
    const found = await graphAllPages(tenant, certPemPath,
      `/groups?$filter=displayName eq '${odataLit(candidate)}'&$select=id,displayName`, { retryTransient: true });
    if (found.length) return { id: found[0].id, name: found[0].displayName, created: false };
  }
  const created = await graphReq(tenant, certPemPath, "POST", "/groups", {
    displayName: name,
    description: `Ring-Zielgruppe fuer Conditional-Access-Rollout (Ring ${normalizeRing(ring)}) — automatisch angelegt vom M365 Security Policy Manager. Mitglieder = Nutzer, fuer die dieser Ring gilt.`,
    mailEnabled: false,
    mailNickname: name.toLowerCase().replace(/[^a-z0-9]/g, ""),
    securityEnabled: true,
    groupTypes: []
  });
  await graphReq(tenant, certPemPath, "GET", `/groups/${created.id}?$select=id`, null, { retryTransient: true });
  return { id: created.id, name, created: true };
}

/** Die vier Schutzgruppen sicherstellen (idempotent, leer angelegt). */
async function ensureSupportGroups(tenant, certPemPath) {
  const ids = {};
  const tenantId = tenant && tenant.id;
  for (const g of SUPPORT_GROUPS) {
    const name = NAMING.name(g.kind, {}, tenantId);
    let found = null;
    for (const candidate of NAMING.candidates(g.kind, {}, tenantId)) {
      const hit = await graphAllPages(tenant, certPemPath,
        `/groups?$filter=displayName eq '${odataLit(candidate)}'&$select=id,displayName`, { retryTransient: true });
      if (hit.length) { found = hit[0]; break; }
    }
    if (found) { ids[g.key] = { id: found.id, name: found.displayName, created: false }; continue; }
    const created = await graphReq(tenant, certPemPath, "POST", "/groups", {
      displayName: name,
      description: g.desc + " — automatisch angelegt vom M365 Security Policy Manager.",
      mailEnabled: false,
      mailNickname: name.toLowerCase().replace(/[^a-z0-9]/g, ""),
      securityEnabled: true,
      groupTypes: []
    });
    await graphReq(tenant, certPemPath, "GET", `/groups/${created.id}?$select=id`, null, { retryTransient: true });
    ids[g.key] = { id: created.id, name, created: true };
  }
  return ids;
}

/**
 * Platzhalter in einer Policy-Vorlage durch echte IDs ersetzen (tiefe Kopie,
 * Original bleibt unveraendert). ring ersetzt <RING> im Namen; ringGroupId
 * (optional, "Ring-getargetet") ersetzt ein "All"-Nutzer-Targeting durch die
 * Ring-Gruppe — Policies mit spezifischem Targeting (Rollen, Gruppen, Gaeste)
 * bleiben unangetastet, exakt wie im Original-Skript.
 */
function substitutePolicy(template, groupIds, ring, ringGroupId) {
  const json = JSON.parse(JSON.stringify(template));
  const map = {
    "<ExclusionTempGroup>": groupIds.exclusionTemp.id,
    "<ExclusionPermGroup>": groupIds.exclusionPerm.id,
    "<EmergencyAccessAccountsGroup>": groupIds.breakGlass.id,
    "<SynchronizationServiceAccountsGroup>": groupIds.syncAccounts.id
  };
  function walk(node) {
    if (Array.isArray(node)) {
      return node
        .filter(v => v !== "<AdministratorGroup>") // siehe conditionalAccessPolicies.js: Rollen-IDs decken das bereits ab
        .map(v => (typeof v === "string" && map[v]) ? map[v] : (typeof v === "object" ? walk(v) : v));
    }
    if (node && typeof node === "object") {
      for (const k of Object.keys(node)) node[k] = walk(node[k]);
      return node;
    }
    return node;
  }
  walk(json);
  json.displayName = String(json.displayName || "").replace(/<RING>/g, normalizeRing(ring || "BP"));
  if (ringGroupId && json.conditions && json.conditions.users &&
      Array.isArray(json.conditions.users.includeUsers) && json.conditions.users.includeUsers.includes("All")) {
    json.conditions.users.includeUsers = [];
    json.conditions.users.includeGroups = [ringGroupId];
  }
  // Sicherheitsleitplanke: state kommt NIE aus der Vorlage.
  json.state = "enabledForReportingButNotEnforced";
  delete json.createdDateTime;
  delete json.modifiedDateTime;
  return json;
}

const MANAGED_NAME_RE = /^\d+ - [A-Za-z0-9]{1,12} - /;

/** Nr+Ring-Praefix einer Policy als Matching-Key statt des vollen displayName.
 *  Grund: wird der Beschreibungstext einer Vorlage korrigiert (z.B. Policy 200,
 *  siehe docs/upstream-issue-ca200.md), aendert sich der displayName. Ein nach
 *  exaktem Namen matchender Upsert wuerde das bei bereits ausgerollten Tenants
 *  als neue Policy behandeln und eine zweite, veraltete daneben stehen lassen -
 *  der Nr+Ring-Praefix bleibt bei so einer Korrektur stabil. */
function policyKey(displayName) {
  const m = String(displayName || "").match(/^(\d+ - [A-Za-z0-9]{1,12}) - /);
  return m ? m[1] : displayName;
}

/** Bereits vorhandene, von diesem Tool verwaltete CA-Policies auflisten.
 *  Namensschema "<Nr> - <RING> - ..." — matcht jeden Ring (PILOT, BROAD, BP, ...),
 *  Fremd-Policies ohne dieses Schema werden nie angefasst. */
async function listManagedPolicies(tenant, certPemPath) {
  const all = await graphAllPages(tenant, certPemPath, "/identity/conditionalAccess/policies", { retryTransient: true });
  return all.filter(p => MANAGED_NAME_RE.test(String(p.displayName || "")));
}

/** ALLE Conditional-Access-Policies im Tenant (auch Fremd-Policies, z.B. manuell
 *  im Portal angelegt) -- fuer die Uebersicht/Aufraeum-Funktion, die anders als
 *  Deploy/Aktivieren nicht auf "unsere" Policies beschraenkt ist. Jede Policy
 *  traegt ein "managed"-Flag (Namensschema-Match), damit die UI Fremd-Policies
 *  sichtbar von Tool-Policies unterscheiden kann. */
async function listAllPolicies(tenant, certPemPath) {
  const all = await graphAllPages(tenant, certPemPath, "/identity/conditionalAccess/policies", { retryTransient: true });
  return all.map(p => ({ ...p, managed: MANAGED_NAME_RE.test(String(p.displayName || "")) }));
}

/** Einzelne Policy unwiderruflich loeschen. */
async function deletePolicy(tenant, certPemPath, policyId) {
  await graphReq(tenant, certPemPath, "DELETE", `/identity/conditionalAccess/policies/${encodeURIComponent(policyId)}`, null, { retryTransient: true });
}

/** Policy anlegen oder aktualisieren (idempotent nach Nr+Ring-Praefix, siehe policyKey),
 *  immer im Report-only-Zustand. */
async function upsertPolicy(tenant, certPemPath, policyJson, existingByKey) {
  const existing = existingByKey.get(policyKey(policyJson.displayName));
  if (existing) {
    // Bewusst konservativ: beim erneuten Deploy wird NUR bei einer bereits im
    // Report-only-Zustand befindlichen Policy aktualisiert — eine bereits vom
    // Admin scharf geschaltete Policy wird nicht ueberschrieben/zurueckgesetzt.
    if (existing.state !== "enabledForReportingButNotEnforced") return { status: "skipped-active", id: existing.id };
    await graphReq(tenant, certPemPath, "PATCH", `/identity/conditionalAccess/policies/${existing.id}`, policyJson, { retryTransient: true });
    return { status: "updated", id: existing.id };
  }
  const created = await graphReq(tenant, certPemPath, "POST", "/identity/conditionalAccess/policies", policyJson, { retryTransient: true });
  return { status: "created", id: created.id };
}

/**
 * Komplettes Tier ausrollen. onProgress(label) fuer Fortschrittsanzeige.
 * opts: { indices, ring, ringTargeted }
 *  - indices: nur diese Positionen aus der Tier-Vorlage (Vorschau/Feinjustierung)
 *  - ring: ersetzt <RING> im Policy-Namen (Default "BP" fuer Bestandskompatibilitaet)
 *  - ringTargeted: "All users"-Policies auf die Ring-Gruppe AAD-CA-RING-<RING>
 *    einschraenken (Staged Rollout) statt auf alle Nutzer
 * Rueckgabe: { groupIds, ringGroup, results: [{ name, status }] }
 */
async function deployTier(tenant, certPemPath, tierKey, onProgress, opts) {
  const { indices, ring = "BP", ringTargeted = false } = opts || {};
  let templates = CA_POLICY_TEMPLATES[tierKey];
  if (!templates) throw new Error("Unbekanntes Tier: " + tierKey);
  if (Array.isArray(indices)) templates = indices.map(i => templates[i]).filter(Boolean);
  const notify = onProgress || (() => {});

  notify("Schutzgruppen sicherstellen");
  const groupIds = await ensureSupportGroups(tenant, certPemPath);
  let ringGroup = null;
  if (ringTargeted) {
    notify("Ring-Gruppe sicherstellen");
    ringGroup = await ensureRingGroup(tenant, certPemPath, ring);
  }

  notify("Bestehende Policies laden");
  const existing = await listManagedPolicies(tenant, certPemPath);
  const existingByKey = new Map(existing.map(p => [policyKey(p.displayName), p]));

  const results = [];
  let i = 0;
  for (const template of templates) {
    i++;
    const policyJson = substitutePolicy(template, groupIds, ring, ringGroup ? ringGroup.id : null);
    notify(`Policy ${i}/${templates.length}: ${policyJson.displayName}`);
    try {
      const r = await upsertPolicy(tenant, certPemPath, policyJson, existingByKey);
      results.push({ name: policyJson.displayName, status: r.status, id: r.id });
    } catch (e) {
      results.push({ name: policyJson.displayName, status: "failed", error: e.message });
    }
  }
  return { groupIds, ringGroup, results };
}

/** Zustand einer Policy setzen — die einzige Stelle, die eine Policy scharf schalten kann. */
async function setPolicyState(tenant, certPemPath, policyId, state) {
  const allowed = ["enabledForReportingButNotEnforced", "enabled", "disabled"];
  if (!allowed.includes(state)) throw new Error("Ungültiger state: " + state);
  await graphReq(tenant, certPemPath, "PATCH", `/identity/conditionalAccess/policies/${policyId}`, { state }, { retryTransient: true });
}

/* -------------------------------------------------------------------------
 * Geltungsbereich: wen trifft eine Policy?
 *
 * Wozu: Die Policy-Liste zeigte bisher nur die Include-Seite und bei
 * includeUsers=["All"] schlicht "Alle" — die AUSNAHMEN blieben unsichtbar.
 * Genau die sind aber der Unterschied zwischen "trifft alle" und "trifft alle
 * ausser Break-Glass und Sync-Konten". Wer vor dem Scharfschalten wissen will,
 * wen es erwischt, braucht beide Seiten. Und die Vorlagen-Vorschau zeigte den
 * Geltungsbereich gar nicht, obwohl sie Policies scharf schalten kann.
 * ------------------------------------------------------------------------- */

/** Pseudo-Ids, die Entra in includeUsers/excludeUsers zulaesst. */
const PSEUDO_USER = {
  All: "alle Benutzer",
  None: "niemand",
  GuestsOrExternalUsers: "Gäste und externe Benutzer"
};

function alsListe(x) { return Array.isArray(x) ? x.filter(Boolean) : []; }

/**
 * Namensnachschlag fuer die Ids, die in den Policies vorkommen. Bewusst nur
 * fuer die TATSAECHLICH referenzierten Benutzer — ein Mandant kann tausende
 * haben, und fuer die Anzeige braucht es nur die paar aus den Ausnahmen.
 * Rollen kommen vollstaendig, das sind wenige.
 */
async function buildScopeLookup(tenant, certPemPath, policies, opts = {}) {
  const gruppen = new Map(alsListe(opts.groups).map(g => [g.id, g.displayName]));
  const rollen = new Map();
  const benutzer = new Map();

  const brauchtRollen = policies.some(p => {
    const u = (p.conditions && p.conditions.users) || {};
    return alsListe(u.includeRoles).length || alsListe(u.excludeRoles).length;
  });
  if (brauchtRollen) {
    try {
      // directoryRoleTemplates deckt auch Rollen ab, die im Mandanten nie
      // aktiviert wurden — in einer Policy darf eine solche Id trotzdem stehen.
      const tmpl = await graphAllPages(tenant, certPemPath, "/directoryRoleTemplates?$select=id,displayName", { retryTransient: true });
      for (const r of tmpl) rollen.set(r.id, r.displayName);
    } catch { /* ohne Namen zeigen wir die Id — besser als nichts */ }
  }

  const userIds = new Set();
  for (const p of policies) {
    const u = (p.conditions && p.conditions.users) || {};
    for (const id of [...alsListe(u.includeUsers), ...alsListe(u.excludeUsers)]) {
      if (!PSEUDO_USER[id]) userIds.add(id);
    }
  }
  for (const id of userIds) {
    try {
      const u = await graphReq(tenant, certPemPath, "GET",
        `/users/${encodeURIComponent(id)}?$select=id,displayName,userPrincipalName`, null, { retryTransient: true });
      benutzer.set(id, u.userPrincipalName ? `${u.displayName} (${u.userPrincipalName})` : u.displayName);
    } catch {
      // Ein geloeschter Benutzer bleibt als Id in der Policy stehen. Das ist
      // ein Befund, kein Fehler — also benennen statt verschweigen.
      benutzer.set(id, `${id} (nicht auffindbar, evtl. gelöscht)`);
    }
  }

  // Leere Gruppen sind der haeufigste stille Fehler: eine Policy, die auf eine
  // leere Pilotgruppe zeigt, trifft NIEMANDEN und sieht trotzdem scharf aus.
  const mitglieder = new Map();
  const gruppenIds = new Set();
  for (const p of policies) {
    const u = (p.conditions && p.conditions.users) || {};
    for (const id of [...alsListe(u.includeGroups), ...alsListe(u.excludeGroups)]) gruppenIds.add(id);
  }
  for (const id of gruppenIds) {
    try {
      const m = await graphAllPages(tenant, certPemPath, `/groups/${id}/members?$select=id`, { retryTransient: true });
      mitglieder.set(id, m.length);
    } catch { /* Zaehlfehler darf die Anzeige nicht kippen */ }
  }

  return { gruppen, rollen, benutzer, mitglieder };
}

/** Eine Seite (include oder exclude) in benannte Eintraege aufloesen. */
function seiteAufloesen(users, groups, roles, lookup) {
  const out = [];
  for (const id of alsListe(users)) {
    out.push(PSEUDO_USER[id]
      ? { art: "pseudo", id, name: PSEUDO_USER[id] }
      : { art: "benutzer", id, name: (lookup.benutzer.get(id) || id) });
  }
  for (const id of alsListe(groups)) {
    const anzahl = lookup.mitglieder.has(id) ? lookup.mitglieder.get(id) : null;
    out.push({ art: "gruppe", id, name: (lookup.gruppen.get(id) || id), mitglieder: anzahl });
  }
  for (const id of alsListe(roles)) {
    out.push({ art: "rolle", id, name: (lookup.rollen.get(id) || id) });
  }
  return out;
}

function eintragText(e) {
  if (e.art === "gruppe" && e.mitglieder === 0) return `${e.name} (LEER)`;
  if (e.art === "gruppe" && typeof e.mitglieder === "number") return `${e.name} (${e.mitglieder})`;
  if (e.art === "rolle") return `Rolle: ${e.name}`;
  return e.name;
}

/**
 * Geltungsbereich einer Policy beschreiben — strukturiert und als Text.
 * lookup kommt aus buildScopeLookup(); ohne lookup werden rohe Ids gezeigt.
 */
function describeScope(policy, lookup) {
  const lk = lookup || { gruppen: new Map(), rollen: new Map(), benutzer: new Map(), mitglieder: new Map() };
  const u = (policy.conditions && policy.conditions.users) || {};

  const include = seiteAufloesen(u.includeUsers, u.includeGroups, u.includeRoles, lk);
  const exclude = seiteAufloesen(u.excludeUsers, u.excludeGroups, u.excludeRoles, lk);

  const alleBenutzer = alsListe(u.includeUsers).includes("All");
  const nurGaeste = alsListe(u.includeUsers).includes("GuestsOrExternalUsers") && !alleBenutzer;

  const incText = include.length ? include.map(eintragText).join(", ") : "niemand (kein Include gesetzt)";
  const excText = exclude.length ? exclude.map(eintragText).join(", ") : null;
  const text = excText ? `${incText} — ohne ${excText}` : incText;

  // Die zwei Faelle, in denen eine Policy anders wirkt als ihr Name verspricht.
  const warnungen = [];
  if (!include.length) {
    warnungen.push("Kein Include gesetzt — die Policy trifft niemanden, auch scharf geschaltet nicht.");
  }
  const leereIncludeGruppen = include.filter(e => e.art === "gruppe" && e.mitglieder === 0);
  if (leereIncludeGruppen.length && !alleBenutzer) {
    warnungen.push(`Zielgruppe leer: ${leereIncludeGruppen.map(e => e.name).join(", ")} — die Policy trifft niemanden.`);
  }
  if (alleBenutzer) {
    warnungen.push("Gilt für ALLE Benutzer — Scharfschalten wirkt sofort auf den ganzen Mandanten.");
  }

  return { text, include, exclude, alleBenutzer, nurGaeste, warnungen };
}

/**
 * Nutzer-Scope einer Policy auf eine Pilotgruppe einschraenken oder auf "Alle"
 * zuruecksetzen. Liest die Policy VOLLSTAENDIG aus und schickt beim Update das
 * KOMPLETTE conditions-Objekt zurueck (nur users.includeUsers/includeGroups
 * geaendert) statt nur den users-Teilbaum — Graphs Merge-Verhalten fuer
 * verschachtelte Properties innerhalb eines PATCH ist nicht zuverlaessig genug
 * dokumentiert, um sich bei einer Conditional-Access-Policy darauf zu
 * verlassen (ein unbeabsichtigt geleertes excludeGroups wuerde die Break-
 * Glass-/Sync-Konten-Ausschluesse aufheben).
 */
async function setPolicyScope(tenant, certPemPath, policyId, ziel) {
  // Rueckwaertskompatibel: frueher kam hier eine einzelne Gruppen-Id oder null.
  let soll;
  if (ziel === null || ziel === undefined || ziel === "") {
    soll = { alle: true, groupIds: [], userIds: [] };
  } else if (typeof ziel === "string") {
    soll = { alle: false, groupIds: [ziel], userIds: [] };
  } else {
    soll = {
      alle: ziel.alle === true || ziel.all === true,
      groupIds: alsListe(ziel.groupIds),
      userIds: alsListe(ziel.userIds)
    };
  }

  // Ein Scope ohne Include trifft niemanden. Das ist fast immer ein Versehen
  // (Gruppe im Dialog nicht gewaehlt) und waere hinterher schwer zu bemerken,
  // weil die Policy scharf aussieht und nichts tut.
  if (!soll.alle && !soll.groupIds.length && !soll.userIds.length) {
    throw new Error("Geltungsbereich leer: mindestens eine Gruppe, ein Benutzer oder «alle Benutzer» angeben.");
  }
  if (soll.alle && (soll.groupIds.length || soll.userIds.length)) {
    throw new Error("«Alle Benutzer» und eine Auswahl schliessen sich aus — Entra wertet dann nur «alle» aus.");
  }

  const current = await graphReq(tenant, certPemPath, "GET", `/identity/conditionalAccess/policies/${policyId}`, null, { retryTransient: true });
  const conditions = JSON.parse(JSON.stringify(current.conditions || {}));
  conditions.users = conditions.users || {};

  if (soll.alle) {
    // Rollen-Policies (Admin-Schutz) haben kein includeUsers — dort wuerde
    // "All" den Rollenbezug aushebeln und die Policy auf jeden ausweiten.
    conditions.users.includeUsers = (conditions.users.includeRoles || []).length ? [] : ["All"];
    conditions.users.includeGroups = [];
  } else {
    conditions.users.includeUsers = soll.userIds;
    conditions.users.includeGroups = soll.groupIds;
  }

  // Die Ausnahmen bleiben unberuehrt. Sie tragen die Break-Glass- und
  // Sync-Konten-Ausschluesse; ein geleertes excludeGroups wuerde den
  // Notfallzugang mit aussperren.
  await graphReq(tenant, certPemPath, "PATCH", `/identity/conditionalAccess/policies/${policyId}`,
    { conditions }, { retryTransient: true });
  return { include: { groupIds: conditions.users.includeGroups, userIds: conditions.users.includeUsers } };
}

module.exports = {
  TIER_META, SUPPORT_GROUPS,
  ensureSupportGroups, ensureRingGroup, normalizeRing, ringGroupName, supportGroupName,
  substitutePolicy, listManagedPolicies, listAllPolicies, deletePolicy, policyKey,
  deployTier, setPolicyState, setPolicyScope,
  describeScope, buildScopeLookup
};
