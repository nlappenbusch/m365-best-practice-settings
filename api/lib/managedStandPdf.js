"use strict";
/**
 * Managed Service: Stand-Dokument (PDF) — der eingefrorene Ist-Zustand eines
 * Tenants zu einem Zeitpunkt, so wie er als Referenz fuer die Drift-Erkennung
 * gilt. Optional mit Drift-Bericht (Abweichungen zum zuletzt erhobenen Ist).
 *
 * Bewusst KEIN Best-Practice-Abgleich: Dieses Dokument sagt "so war es
 * abgenommen", nicht "so sollte es sein". Der Abgleich mit den
 * igeeks-Best-Practices hat seinen eigenen Bericht.
 *
 * Layout: pdfDesign.js (igeeks-CI, Deckblatt, Inhaltsverzeichnis, Tabellen).
 */
const { create, fmtDate, fmtDateTime, pl } = require("./pdfDesign");
const STAND = require("./managedStand");

const CA_STATE = { enabled: "Ein", disabled: "Aus", enabledForReportingButNotEnforced: "Nur Bericht" };
const CHANGE_TONE = { neu: "info", "geändert": "warn", entfernt: "crit" };
const THREAT_KIND = {
  AntiPhish: "Anti-Phishing", Antispam: "Antispam", Antimalware: "Antimalware", Outbound: "Ausgehender Spam",
  SafeLinks: "Sichere Links", SafeAttachments: "Sichere Anlagen", PresetEOP: "Voreinstellung EOP",
  PresetATP: "Voreinstellung Defender", RemoteDomain: "Remotedomäne"
};

const arr = v => (Array.isArray(v) ? v : v == null ? [] : [v]);
const SPECIAL = { All: "alle", None: "keine", GuestsOrExternalUsers: "Gäste/Externe", Office365: "Office 365", AllTrusted: "alle vertrauenswürdigen", MicrosoftAdminPortals: "Admin-Portale" };
function idList(list, what) {
  const a = arr(list);
  if (!a.length) return null;
  const named = a.filter(x => SPECIAL[x]).map(x => SPECIAL[x]);
  const rest = a.length - named.length;
  return [...named, rest ? pl(rest, what, what + (what.endsWith("e") ? "n" : "e")) : null].filter(Boolean).join(", ");
}
function val(v) {
  if (v === true) return "ja";
  if (v === false) return "nein";
  if (v == null || v === "") return "—";
  if (Array.isArray(v)) return v.length ? v.join(", ") : "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Lesbare Kurzfassung einer CA-Policy (Graph-Objekt ohne fluechtige Felder). */
function caSummary(body) {
  const c = (body && body.conditions) || {};
  const u = c.users || {};
  const g = (body && body.grantControls) || {};
  const s = (body && body.sessionControls) || {};
  const users = [idList(u.includeUsers, "Benutzer"), idList(u.includeGroups, "Gruppe"), idList(u.includeRoles, "Rolle"),
    u.includeGuestsOrExternalUsers ? "Gäste/Externe" : null].filter(Boolean).join(" · ") || "—";
  const excl = [idList(u.excludeUsers, "Benutzer"), idList(u.excludeGroups, "Gruppe"), idList(u.excludeRoles, "Rolle"),
    u.excludeGuestsOrExternalUsers ? "Gäste/Externe" : null].filter(Boolean).join(" · ");
  const apps = c.applications || {};
  const appTxt = [idList(apps.includeApplications, "App"), arr(apps.includeUserActions).join(", "), apps.includeAuthenticationContextClassReferences && arr(apps.includeAuthenticationContextClassReferences).length ? "Authentifizierungskontext" : null].filter(Boolean).join(" · ") || "—";
  const cond = [];
  if (arr(c.clientAppTypes).length && !(arr(c.clientAppTypes).length === 1 && c.clientAppTypes[0] === "all")) cond.push("Client-Apps: " + arr(c.clientAppTypes).join(", "));
  if (c.platforms && arr(c.platforms.includePlatforms).length) cond.push("Plattformen: " + arr(c.platforms.includePlatforms).join(", "));
  if (c.locations && arr(c.locations.includeLocations).length) cond.push("Standorte: " + idList(c.locations.includeLocations, "Standort") + (arr(c.locations.excludeLocations).length ? " (ohne " + idList(c.locations.excludeLocations, "Standort") + ")" : ""));
  if (arr(c.signInRiskLevels).length) cond.push("Anmelderisiko: " + c.signInRiskLevels.join(", "));
  if (arr(c.userRiskLevels).length) cond.push("Benutzerrisiko: " + c.userRiskLevels.join(", "));
  if (c.devices && c.devices.deviceFilter) cond.push("Gerätefilter: " + (c.devices.deviceFilter.mode || "") + " " + (c.devices.deviceFilter.rule || ""));
  const grant = [];
  if (arr(g.builtInControls).length) grant.push(g.builtInControls.join(g.operator === "AND" ? " UND " : " ODER "));
  if (g.authenticationStrength) grant.push("Stärke: " + (g.authenticationStrength.displayName || g.authenticationStrength.id || ""));
  if (arr(g.termsOfUse).length) grant.push("Nutzungsbedingungen");
  const sess = Object.entries(s || {}).filter(([, v]) => v && (v.isEnabled || v === true || (typeof v === "object" && Object.keys(v).length))).map(([k]) => k);
  return { users, excl: excl || null, apps: appTxt, cond: cond.join(" · ") || null, grant: grant.join(" · ") || "—", session: sess.join(", ") || null };
}

async function build(tenant, d) {
  const { ver, history, drift, isCurrent } = d;
  const ca = (ver.areas.ca && ver.areas.ca.items) || {};
  const threat = (ver.areas.threat && ver.areas.threat.items) || {};
  const caList = Object.entries(ca).map(([id, p]) => ({ id, ...p })).sort((a, b) => String(a.name).localeCompare(String(b.name), "de"));
  const caOn = caList.filter(p => p.state === "enabled").length;

  const b = create({
    kicker: drift ? "Managed Service · Drift-Bericht" : "Managed Service · Dokumentierter Stand",
    titleLines: drift ? ["Drift-Bericht", `gegen Stand v${ver.v}`] : ["Eingefrorener Stand", `Version v${ver.v}`],
    subtitle: drift
      ? `Abweichungen des zuletzt erhobenen Ist-Zustands vom Stand v${ver.v} (${fmtDate(ver.at)}).`
      : "Referenz für die Drift-Erkennung: der abgenommene Ist-Zustand zu diesem Zeitpunkt.",
    tenantName: tenant.name, organization: tenant.organization, date: drift ? (drift.at || new Date().toISOString()) : ver.at,
    coverTiles: [
      { label: "Version", value: "v" + ver.v, tone: ver.provisional ? "warn" : "info" },
      { label: "CA-Policies (ein)", value: `${caList.length} (${caOn})` },
      { label: "Threat Policies", value: String(Object.keys(threat).length) },
      drift ? { label: "Abweichungen", value: String(drift.changes.length), tone: drift.changes.length ? "warn" : "ok" }
        : { label: "Änderungen ggü. Vorversion", value: String((ver.changes || []).length) }
    ],
    stamps: Object.values(ver.areas).map(a => `${a.label} erhoben ${fmtDateTime(a.at)}`),
    footerLabel: drift ? `Drift-Bericht · Stand v${ver.v}` : `Stand v${ver.v}`,
    coverNote: "Dieses Dokument hält den Ist-Zustand zum Zeitpunkt des Einfrierens fest. Es ist kein Abgleich mit den igeeks-Best-Practices — dafür gibt es den separaten Best-Practice-Bericht mit begründet zugelassenen Abweichungen."
  });
  b.cover();

  // ---------------------------------------------------------------- 1 Überblick
  b.h1("Überblick");
  if (ver.provisional) {
    b.note("Vorläufiger Stand", "Diese Version wurde automatisch aufgenommen, damit die Drift-Erkennung ab dem ersten Lauf greift. Sie ist noch nicht bewusst abgenommen. Empfehlung: Ist-Zustand prüfen und im Managed Service «Stand einfrieren» mit Begründung ausführen.", "warn");
  }
  if (!isCurrent && !drift) b.note("Nicht mehr aktuell", "Es gibt eine neuere Stand-Version. Dieses Dokument zeigt den Stand, wie er zum angegebenen Zeitpunkt galt.", "info");
  b.card([
    ["Version", `v${ver.v}${ver.prev ? " (Vorversion v" + ver.prev + ")" : " (erste Version)"}`],
    ["Eingefroren am", fmtDateTime(ver.at)],
    ["Eingefroren von", ver.by],
    ["Art", STAND.KIND_DE[ver.kind] || ver.kind],
    ["Umfang", ver.scope && ver.scope.objId ? `Nur ${ver.scope.name} (${(STAND.STAND_AREA[ver.scope.area] || {}).label || ver.scope.area})` : ver.scope && ver.scope.area ? `Bereich ${(STAND.STAND_AREA[ver.scope.area] || {}).label}` : "Alle eingefrorenen Bereiche"],
    ["Begründung", ver.reason]
  ]);
  b.h4("Bereiche");
  b.table([{ label: "Bereich", w: 0.32 }, { label: "Objekte", w: 0.14 }, { label: "Erhoben", w: 0.26 }, { label: "Fingerabdruck", w: 0.28 }],
    Object.values(ver.areas).map(a => [{ text: a.label, bold: true }, String(a.count), fmtDateTime(a.at), { text: a.hash, mono: true }]));
  b.small("Der Fingerabdruck ist eine Prüfsumme über alle Einstellungen des Bereichs. Gleicher Fingerabdruck = identischer Zustand.");

  // ---------------------------------------------------------------- Drift
  if (drift) {
    b.h1("Abweichungen zum aktuellen Ist");
    b.body(`Verglichen wurde Stand v${ver.v} mit dem zuletzt erhobenen Ist-Zustand (${fmtDateTime(drift.at)}).`);
    if (!drift.changes.length) b.note("Keine Abweichungen", "Der erhobene Ist-Zustand entspricht dem eingefrorenen Stand.", "ok");
    else changeTable(b, drift.changes, "Stand", "Ist");
  }

  // ---------------------------------------------------------------- Conditional Access
  if (ver.areas.ca) {
    b.h1("Conditional Access");
    b.tiles([
      { label: "Policies", value: String(caList.length) },
      { label: "Eingeschaltet", value: String(caOn), tone: "ok" },
      { label: "Nur Bericht", value: String(caList.filter(p => p.state === "enabledForReportingButNotEnforced").length), tone: "info" },
      { label: "Aus", value: String(caList.filter(p => p.state === "disabled").length), tone: "muted" }
    ]);
    b.table([{ label: "Policy", w: 0.56 }, { label: "Status", w: 0.16 }, { label: "Herkunft", w: 0.28 }],
      caList.map(p => [{ text: p.name, bold: true }, { text: CA_STATE[p.state] || p.state || "—", pill: p.state === "enabled" ? "ok" : p.state === "disabled" ? "muted" : "info" }, p.managed ? "igeeks (BP_)" : "kundenseitig"]));
    b.h2("Policies im Detail");
    for (const p of caList) {
      const s = caSummary(p.body);
      b.h3(p.name, CA_STATE[p.state] || p.state, p.state === "enabled" ? "ok" : p.state === "disabled" ? "muted" : "info");
      b.card([
        ["Gilt für", s.users], ["Ausgenommen", s.excl], ["Anwendungen", s.apps], ["Bedingungen", s.cond],
        ["Zugriff", s.grant], ["Sitzung", s.session], ["Objekt-ID", p.id, { mono: true }]
      ]);
    }
  }

  // ---------------------------------------------------------------- Threat Policies
  if (ver.areas.threat) {
    b.h1("Threat Policies (Exchange Online)");
    const byKind = {};
    for (const [k, p] of Object.entries(threat)) (byKind[p.kind || k.split(":")[0]] = byKind[p.kind || k.split(":")[0]] || []).push(p);
    for (const kind of Object.keys(THREAT_KIND).concat(Object.keys(byKind).filter(k => !THREAT_KIND[k]))) {
      const list = byKind[kind];
      if (!list || !list.length) continue;
      b.h2(`${THREAT_KIND[kind] || kind} (${list.length})`);
      for (const p of list.sort((a, c) => String(a.name).localeCompare(String(c.name), "de"))) {
        const body = p.body || {};
        b.h3(p.name || "—", body.IsDefault ? "Standard" : null, "muted");
        b.card(Object.entries(body).filter(([k]) => k !== "Name" && k !== "IsDefault").map(([k, v]) => [k, val(v)]));
      }
    }
  }

  // ---------------------------------------------------------------- Änderungen ggü. Vorversion
  if (!drift) {
    b.h1("Änderungen gegenüber der Vorversion");
    if (!ver.prev) b.body("Erste Version — keine Vorversion zum Vergleich.");
    else if (!(ver.changes || []).length) b.body(`Inhaltlich identisch mit v${ver.prev}. Die Version dokumentiert die erneute Abnahme.`);
    else { b.body(`Gegenüber v${ver.prev}: ${pl(ver.changes.length, "Änderung", "Änderungen")}. Begründung: ${ver.reason}`); changeTable(b, ver.changes, "v" + ver.prev, "v" + ver.v); }
  }

  // ---------------------------------------------------------------- Anhang Versionen
  b.h1("Versionsgeschichte", { appendix: true });
  b.table([{ label: "Version", w: 0.09 }, { label: "Datum", w: 0.17 }, { label: "Von", w: 0.2 }, { label: "Art", w: 0.18 }, { label: "Begründung", w: 0.36 }],
    [...history].reverse().map(h => [{ text: "v" + h.v, bold: h.v === ver.v }, fmtDateTime(h.at), h.by, STAND.KIND_DE[h.kind] || h.kind, (h.provisional ? "[vorläufig] " : "") + (h.reason || "")]));

  return b.finish();
}

function changeTable(b, changes, oldLabel, newLabel) {
  for (const a of STAND.STAND_AREAS) {
    const list = changes.filter(c => c.area === a.id);
    if (!list.length) continue;
    b.h2(`${a.label} (${list.length})`);
    b.table([{ label: "Objekt", w: 0.62 }, { label: "Art", w: 0.18 }, { label: "Felder", w: 0.2 }],
      list.map(c => [{ text: c.name, bold: true }, { text: c.type, pill: CHANGE_TONE[c.type] || "muted" }, c.fields ? String(c.fields.length) : "—"]));
    for (const c of list.filter(x => x.fields && x.fields.length).slice(0, 40)) {
      b.h4(c.name);
      b.table([{ label: "Feld", w: 0.34 }, { label: oldLabel, w: 0.33 }, { label: newLabel, w: 0.33 }],
        c.fields.map(f => [{ text: f.path, mono: true }, f.old, f.new]), { size: 7.6 });
    }
  }
}

module.exports = { build, caSummary };
