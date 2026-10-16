"use strict";
/**
 * Evidence: Audit-Events in Klartext einordnen — was ist Routine, was ist relevant?
 *
 * Warum: Die bisherige Einstufung (evidenceAnalyze.risk) sucht Woerter im ganzen
 * Event-Text. Dadurch wurde «IsSoftDeleted» in einer Provisioning-Synchronisation
 * zu «Objekt entfernt», der Akteur «Azure MFA StrongAuthenticationService» zu
 * «Authentifizierung geaendert» und jede App-Rollenzuweisung zu «kritisch».
 * Bei PKRueck stand die Liste am 16.10.2026 voller solcher Meldungen; die zwei
 * Ereignisse, die wirklich interessant waren (CSP-Partner, neuer Copilot-Agent),
 * gingen darin unter.
 *
 * classify(event, ctx) gibt fuer die Anzeige zurueck:
 *   level    critical | high | medium | info
 *   title    Klartext-Titel
 *   routine  Bezeichnung, wenn es Routine ist (dann standardmaessig ausgeblendet)
 *   group    Schluessel zum Buendeln gleichartiger Events
 *   groupTitle  Titel fuer das Buendel («Werkzeug-App hat 45 Berechtigungen erhalten»)
 *   hint     was zu tun ist — konkret, statt «Aenderung pruefen»
 *
 * Rein berechnend, ohne Ablage: aendern sich die Regeln, gilt das sofort auch
 * fuer bereits erhobene Events.
 */

const unq = v => String(v == null ? "" : v).replace(/^\[?"?|"?\]?$/g, "").trim();
const low = v => String(v || "").toLowerCase();
const day = iso => String(iso || "").slice(0, 10);

function allChanges(ev) {
  const m = {};
  for (const t of ev.targets || []) for (const c of t.changes || []) if (c && c.name && !(c.name in m)) m[c.name] = c;
  return m;
}
const val = (ch, name) => (ch[name] ? unq(ch[name].new) || unq(ch[name].old) : "");
function deviceOf(json) {
  const s = String(json || "");
  const name = (s.match(/"DeviceName":"([^"]*)"/) || [])[1] || "";
  const token = (s.match(/"DeviceToken":"([^"]{0,40})/) || [])[1] || "";
  return { name, token };
}
const isAdminAccount = s => /\badmin|\(ga\b|\(ga\)|breakglass|break-glass|emergency|notfall/i.test(String(s || ""));

// App-Rollen, die schreiben oder sehr weit lesen — fuer fremde Apps kritisch.
const POWERFUL_ROLE = /readwrite|fullcontrol|rolemanagement|manageasapp|mail\.send|\.all$/i;
const WRITE_ROLE = /readwrite|fullcontrol|rolemanagement|manageasapp|mail\.send/i;

const SYNC_ACTIVITY = /^(synchronization rule action|process escrow|import|export|entry synchronization|stagedrecord|object import|object export)$/i;

function classify(ev, ctx) {
  ctx = ctx || {};
  const act = String(ev.activity || ev.operation || "").trim();
  const a = low(act);
  const actor = String(ev.actor || "").trim();
  const t0 = (ev.targets || [])[0] || {};
  const target = t0.name || t0.id || ev.category || "Objekt";
  const ch = allChanges(ev);
  const selfId = low(ctx.selfAppId);
  const hayIds = low([...(ev.targets || []).flatMap(t => [t.id, t.name]), ...Object.values(ch).flatMap(c => [c.old, c.new])].join(" "));
  const isSelf = !!selfId && hayIds.includes(selfId) || /m365-security-policy-manager/i.test(hayIds);
  const d = day(ev.occurredAt);

  // 1) Eigenes Werkzeug bekommt Berechtigungen (Reparieren / Einwilligung)
  if (isSelf && /app role assignment|service principal|permission grant|consent/.test(a)) {
    const role = val(ch, "AppRole.Value");
    return {
      level: "medium", kind: "self",
      title: role ? `Eigenes Werkzeug erhielt Berechtigung «${role}»` : `Eigenes Werkzeug: ${act}`,
      group: `self:${d}`, groupTitle: `Eigenes Werkzeug (M365-Security-Policy-Manager) hat {n} Berechtigungen erhalten`,
      hint: "Erwartet nach «Reparieren» oder neuer Einwilligung im Tab Tenants. Passt Zeitpunkt und Person (" + actor + ")? Dann als Entscheid dokumentieren.",
      reason: "Eigenes Werkzeug"
    };
  }

  // 2) Provisioning-Synchronisation (Cloud Sync, App-Provisioning) — läuft alle ~40 Min.
  // Nur echte Sync-Dienste — «PPMIProvisioningAppProd» legt z. B. Copilot-Agenten an und ist KEIN Sync.
  if ((/cloud sync|sync fabric|azure ad provisioning|aad provisioning/i.test(actor) && !/service principal/i.test(act)) || SYNC_ACTIVITY.test(act)) {
    return {
      level: "info", kind: "routine", routine: "Synchronisation",
      title: `Synchronisation «${target}» (automatisch)`,
      group: `sync:${low(target)}`, groupTitle: `Automatische Synchronisation «${target}» — {n} Läufe`,
      hint: "Routine: das Provisioning gleicht Benutzer mit der App ab. Nur ansehen, wenn die App Fehler meldet.",
      reason: "Routine: Synchronisation"
    };
  }

  // 3) Microsoft räumt auf (endgültiges Löschen bereits gelöschter Objekte)
  if (/garbage collector/i.test(actor)) {
    return {
      level: "info", kind: "routine", routine: "Microsoft-Aufräumjob",
      title: `«${target}» endgültig entfernt (Microsoft-Aufräumjob)`,
      group: `gc:${low(target)}`, groupTitle: `Microsoft-Aufräumjob: «${target}» endgültig entfernt ({n}×)`,
      hint: "Routine: Microsoft löscht Objekte, die vorher schon gelöscht wurden.",
      reason: "Routine: Aufräumjob"
    };
  }

  // 4) Authenticator-App: Update der App vs. neues Gerät
  if (/strongauthenticationservice/i.test(actor) && ch.StrongAuthenticationPhoneAppDetail) {
    const o = deviceOf(ch.StrongAuthenticationPhoneAppDetail.old), n = deviceOf(ch.StrongAuthenticationPhoneAppDetail.new);
    const sameDevice = o.name === n.name && (!o.token || !n.token || o.token === n.token);
    if (sameDevice) {
      return {
        level: "info", kind: "routine", routine: "Authenticator-App aktualisiert",
        title: `Authenticator-App aktualisiert: ${target}`,
        group: "mfa-app-update", groupTitle: `Authenticator-App bei {n} Benutzern aktualisiert`,
        hint: "Routine: die App auf dem Handy hat sich selbst aktualisiert.",
        reason: "Routine: App-Update"
      };
    }
    const admin = isAdminAccount(target);
    return {
      level: admin ? "high" : "medium", kind: "mfa-device",
      title: `${target}: Anmelde-App auf neuem Gerät (${o.name || "?"} → ${n.name || "?"})`,
      group: `mfa-device:${ev.eventId}`,
      hint: admin
        ? "Admin-Konto mit neuem Anmeldegerät: kurz mit der Person bestätigen, dass sie das Handy gewechselt hat."
        : "Normal bei neuem Handy. Hat die Person kein neues Gerät, Konto prüfen (möglicher Fremdzugriff).",
      reason: "Neues Anmeldegerät"
    };
  }

  // 5) Anmeldemethoden selbst registriert (Self-Service)
  if (/security info|passkey creation|registered all required/i.test(act)) {
    // Akteur ist mal der Anzeigename, mal der Anmeldename — beides als «selbst» werten.
    const norm = x => low(x).replace(/[._-]+/g, " ").replace(/\s+/g, " ").trim();
    const la = norm(actor), lt = norm(target), local = la.split("@")[0].trim();
    const selfService = !actor || la === lt || local === lt.split("@")[0] || (local.length >= 4 && lt.includes(local)) || (lt.length >= 4 && la.includes(lt));
    const deleted = /delet|remov/i.test(act);
    const admin = isAdminAccount(actor) || isAdminAccount(target);
    if (selfService && !deleted && !admin) {
      return {
        level: "info", kind: "routine", routine: "Anmeldemethode eingerichtet",
        title: `${target} hat eine Anmeldemethode eingerichtet`,
        group: "secinfo", groupTitle: `{n}× Anmeldemethode durch Benutzer eingerichtet`,
        hint: "Routine: Benutzer richtet MFA oder Passkey selbst ein.",
        reason: "Routine: MFA-Registrierung"
      };
    }
    return {
      level: deleted || !selfService ? "high" : "medium", kind: "secinfo",
      title: deleted ? `${target}: Anmeldemethode entfernt` : admin ? `Admin-Konto ${target}: Anmeldemethode eingerichtet` : `${target}: Anmeldemethode durch ${actor} gesetzt`,
      group: `secinfo:${low(target)}:${d}`,
      hint: deleted ? "Entfernte Anmeldemethode: mit der Person klären — Angreifer entfernen gern die echte MFA-Methode."
        : admin ? "Admin-Konto mit neuer Anmeldemethode: kurz bestätigen lassen." : "Methode wurde von jemand anderem gesetzt: prüfen, ob das ein Support-Fall war.",
      reason: "Anmeldemethode geändert"
    };
  }

  // 6) Partner (CSP/GDAP) erneuert delegierte Berechtigungen
  if (/^user_[0-9a-f]{16,}@/i.test(actor) || (/@[^@]*csp[^@]*\.onmicrosoft\.com$/i.test(actor))) {
    const partner = actor.split("@")[1] || actor;
    return {
      level: "medium", kind: "partner",
      title: `Partner «${partner}»: ${/remove/i.test(act) ? "Berechtigung entfernt" : "Berechtigung erteilt"} — ${target}`,
      group: `partner:${low(partner)}:${d}`, groupTitle: `Partner «${partner}» hat Berechtigungen erneuert ({n} Änderungen)`,
      hint: "Typisch für den Lizenz-/CSP-Partner. Prüfen, ob dieser Partner noch Zugriff haben soll: Admin Center → Einstellungen → Partnerbeziehungen.",
      reason: "Partner-Zugriff"
    };
  }

  // 7) Neue Unternehmensanwendung / KI-Agent, angelegt durch einen Dienst
  if (/^add service principal$|^add owner to service principal$/i.test(act)) {
    const name = val(ch, "DisplayName") || val(ch, "ServicePrincipal.DisplayName") || target;
    const appId = val(ch, "AppPrincipalId") || val(ch, "ServicePrincipal.AppId") || low(name);
    const agent = /copilot studio|agent/i.test(name);
    return {
      level: agent ? "high" : "medium", kind: "newapp",
      title: agent ? `Neuer KI-Agent: «${name}»` : `Neue Unternehmensanwendung: «${name}»`,
      group: `newapp:${low(appId)}`, groupTitle: agent ? `Neuer KI-Agent: «${name}»` : `Neue Unternehmensanwendung: «${name}»`,
      hint: agent
        ? "Ein Copilot-Studio-Agent wurde im Tenant registriert. Klären, wer ihn gebaut hat und auf welche Daten er zugreift (Power Platform Admin Center → Agents)."
        : "Neue App im Tenant: Herkunft und Berechtigungen prüfen (Entra → Unternehmensanwendungen).",
      reason: agent ? "Neuer KI-Agent" : "Neue App"
    };
  }

  // 8) App-Rollen (Anwendungsberechtigungen) für fremde Apps
  if (/app role assignment/.test(a)) {
    const role = val(ch, "AppRole.Value");
    const app = val(ch, "ServicePrincipal.DisplayName") || target;
    const removed = /remove/i.test(a);
    const strong = WRITE_ROLE.test(role) || (POWERFUL_ROLE.test(role) && !/\.read\./i.test(role));
    return {
      level: removed ? "medium" : strong ? "critical" : "high", kind: "approle",
      title: removed ? `App «${app}»: Berechtigung «${role || "?"}» entzogen` : `App «${app}» erhielt Berechtigung «${role || "?"}»`,
      group: `approle:${low(app)}:${removed ? "rm" : "add"}:${d}`, groupTitle: `App «${app}» erhielt {n} Berechtigungen`,
      hint: removed ? "Berechtigung entfernt — meist Aufräumen. Prüfen, ob die App danach noch funktioniert."
        : "Anwendungsberechtigung gilt ohne angemeldeten Benutzer für den ganzen Tenant. Wer hat zugestimmt, und braucht die App das wirklich?",
      reason: "Anwendungsberechtigung"
    };
  }

  return null;
}

// Klartext fuer haeufige Vorgaenge ohne eigene Regel.
const ACT_DE = [
  [/^add member to role|^add eligible member to role|^add scoped member to role/i, "Admin-Rolle vergeben", "critical"],
  [/^remove member from role|^remove eligible member from role/i, "Admin-Rolle entzogen", "high"],
  [/^delete user|^hard delete user/i, "Benutzer gelöscht", "high"],
  [/^add user/i, "Benutzer angelegt", "medium"],
  [/^restore user/i, "Benutzer wiederhergestellt", "medium"],
  [/^reset (user )?password|^reset password/i, "Passwort zurückgesetzt", "medium"],
  [/^change (user )?password/i, "Passwort geändert", "info"],
  [/^disable account|^update user.*accountenabled/i, "Konto deaktiviert", "medium"],
  [/^update user/i, "Benutzer geändert", "info"],
  [/^add member to group/i, "Zur Gruppe hinzugefügt", "info"],
  [/^remove member from group/i, "Aus Gruppe entfernt", "info"],
  [/^add group/i, "Gruppe angelegt", "info"],
  [/^delete group|^hard delete group/i, "Gruppe gelöscht", "medium"],
  [/^update group/i, "Gruppe geändert", "info"],
  [/^add device|^register device/i, "Gerät registriert", "info"],
  [/^delete device|^hard delete device/i, "Gerät gelöscht", "info"],
  [/^update device/i, "Gerät geändert", "info"],
  [/conditional access policy/i, "Conditional-Access-Richtlinie geändert", "high"],
  [/^add policy|^update policy|^delete policy/i, "Richtlinie geändert", "medium"],
  [/^add delegated permission grant|^consent to application/i, "Delegierte Berechtigung erteilt", "high"],
  [/^remove delegated permission grant/i, "Delegierte Berechtigung entfernt", "medium"],
  [/^update application|^update service principal/i, "App-Registrierung geändert", "medium"],
  [/^add application/i, "App-Registrierung angelegt", "medium"],
  [/^set domain authentication|^set federation/i, "Domain-Anmeldung geändert (Federation)", "critical"],
  [/^add (verified )?domain|^verify domain/i, "Domain hinzugefügt", "high"]
];
/**
 * Auffangregel: Klartext-Titel und eine Stufe, die nur auf den Vorgang schaut
 * (nicht auf Akteur oder Feldnamen). Bei Conditional Access behaelt die
 * bisherige Analyse das letzte Wort — sie kennt Baseline und Impact.
 */
function fallback(ev, analysis) {
  const act = String(ev.activity || ev.operation || "").trim();
  const t0 = (ev.targets || [])[0] || {};
  const target = t0.name || t0.id || "";
  const hit = ACT_DE.find(([re]) => re.test(act));
  const prev = analysis && analysis.risk;
  let level = hit ? hit[2] : "info";
  if (/conditional access/i.test(act) && prev && prev.level) level = prev.level;
  if (prev && prev.level === "critical" && /conditional access/i.test(act)) level = "critical";
  return {
    level, kind: "generic",
    title: `${hit ? hit[1] : act || "Änderung"}${target ? ": " + target : ""}`,
    group: null,
    hint: level === "critical" || level === "high" ? "Wer hat das gemacht, und gibt es dazu einen Auftrag? Ohne Auftrag: rückgängig machen und Konto prüfen." : null,
    reason: hit ? hit[1] : (prev && prev.reason) || "Änderung"
  };
}

function view(ev, ctx) { return classify(ev, ctx) || fallback(ev, ev.analysis); }

// Gleichartige Events zusammenfassen. Rein für die Anzeige.
function groupEvents(events) {
  const groups = new Map();
  const rank = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
  for (const e of events) {
    const v = e.view || {};
    const key = v.group || `${low(e.activity)}|${low((e.targets || [])[0] && e.targets[0].name)}|${low(e.actor)}|${day(e.occurredAt)}`;
    if (!groups.has(key)) groups.set(key, { key, events: [], level: "info" });
    const g = groups.get(key);
    g.events.push(e);
    if ((rank[v.level] || 0) > (rank[g.level] || 0)) g.level = v.level;
  }
  return [...groups.values()];
}

module.exports = { classify, fallback, view, groupEvents, deviceOf, isAdminAccount, ACT_DE };
