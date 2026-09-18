"use strict";
/**
 * SharePoint- und OneDrive-Inventar (rein lesend, Microsoft Graph app-only).
 *
 * Erhoben wird, was eine Konfigurationsdoku braucht:
 *  - alle Sites mit Art (Team-Site mit/ohne Teams, Kommunikationsseite, klassisch …),
 *    Adresse, Anlage-/Änderungsdatum, Speicher und — bei gruppenverbundenen Sites —
 *    Besitzer, Mitglieder, Gäste und Sichtbarkeit der M365-Gruppe
 *  - OneDrive je Konto: belegt, Kontingent, letzte Aktivität
 *  - die tenantweiten Freigabe-Einstellungen, in Klartext übersetzt
 *
 * Quellen und ihre Grenzen:
 *  - /sites/getAllSites (Sites.Read.All) liefert Sites samt OneDrives, aber KEINE
 *    Vorlage (Kommunikationsseite / Team-Site / klassisch). Die kommt nur aus dem
 *    Nutzungsbericht getSharePointSiteUsageDetail ("Root Web Template",
 *    Reports.Read.All). Ohne Bericht bleibt die Art bei Sites ohne Gruppe offen —
 *    das wird so angezeigt, nicht geraten.
 *  - Gruppenverbundene Sites werden über /groups/{id}/sites/root zugeordnet, nicht
 *    über den Namen: URL und Gruppenname laufen nach Umbenennungen auseinander.
 *  - Die Nutzungsberichte ersetzen Namen und Adressen durch Kennungen, wenn im
 *    Microsoft 365 Admin Center «verborgene Namen anzeigen» aktiv ist
 *    (/admin/reportSettings displayConcealedNames = true). Dann lässt sich eine
 *    Berichtszeile nur noch über die Site-Id zuordnen (SharePoint) bzw. gar nicht
 *    (OneDrive). Speicher je OneDrive kommt deshalb direkt aus dem Laufwerk
 *    (/sites/{id}/drive quota) — mit echtem Namen. Die Anonymisierung wird im
 *    Ergebnis ausgewiesen, nicht verschwiegen; die Einstellung selbst fasst das
 *    Werkzeug nicht an.
 *  - Was Graph gar nicht liefert (Freigabestufe je Site, OneDrive-Freigabestufe,
 *    Standard-Linktyp, Ablauf anonymer Links, SharePoint-Gruppen von Sites ohne
 *    M365-Gruppe …), steht in NOT_VIA_GRAPH und wird in Oberfläche und PDF als
 *    «nicht über Graph verfügbar» gekennzeichnet.
 *
 * Berechtigungen (alle schon Teil der App-Registrierung, auch der Nur-lesen-App
 * fürs Prüfmandat): Sites.Read.All, Group.Read.All bzw. Group.ReadWrite.All,
 * User.Read.All bzw. User.ReadWrite.All, Reports.Read.All, ReportSettings.Read.All,
 * SharePointTenantSettings.Read.All. Fehlt eine davon, läuft die Erhebung ohne
 * den betroffenen Teil weiter und vermerkt die Lücke.
 */
const { graphReq, graphAllPages } = require("./graph");

// Listen-Abrufe mit Wiederholung bei transienten Fehlern. Einzelabrufe, bei denen
// 404 eine normale Antwort ist (Gruppe ohne Site, Site ohne Standardbibliothek),
// laufen OHNE retryTransient — graph.js wertet 404 dort als transient und würde
// jeden dieser Fälle mehrfach mit Wartezeit wiederholen.
const LIST = { retryTransient: 3 };
const ONE = {};
const PERIODS = ["D7", "D30", "D90", "D180"];
const MEMBER_CAP = 300;        // gespeicherte Mitglieder je Gruppe (Zählung bleibt vollständig)
const ONEDRIVE_CAP = 2000;     // OneDrives mit Einzelabruf des Laufwerks
const PARALLEL = 6;

// ============================================================== Klartext
const SHARING = {
  disabled: { label: "Nur Personen in der Organisation", short: "Nur intern", tone: "ok", level: 0,
    description: "Inhalte lassen sich nur mit Personen der eigenen Organisation teilen. Keine externe Freigabe." },
  existingExternalUserSharingOnly: { label: "Bestehende Gäste", short: "Bestehende Gäste", tone: "info", level: 1,
    description: "Teilen nur mit Gästen, die bereits im Verzeichnis der Organisation stehen." },
  externalUserSharingOnly: { label: "Neue und bestehende Gäste", short: "Neue und bestehende Gäste", tone: "warn", level: 2,
    description: "Teilen auch mit neuen Gästen. Gäste melden sich an oder bestätigen mit einem Einmalcode." },
  externalUserAndGuestSharing: { label: "Jeder (anonyme Links)", short: "Jeder", tone: "crit", level: 3,
    description: "Zusätzlich Links, die ohne Anmeldung funktionieren («Jeder mit dem Link»)." }
};
const SHARING_ORDER = ["disabled", "existingExternalUserSharingOnly", "externalUserSharingOnly", "externalUserAndGuestSharing"];

const KIND = {
  teams: { label: "Team-Site mit Teams", short: "Teams", order: 1 },
  group: { label: "Team-Site mit M365-Gruppe (ohne Teams)", short: "M365-Gruppe", order: 2 },
  communication: { label: "Kommunikationsseite", short: "Kommunikation", order: 3 },
  teamSite: { label: "Team-Site ohne Gruppe", short: "Team-Site", order: 4 },
  classic: { label: "Klassische Site", short: "Klassisch", order: 5 },
  channel: { label: "Teams-Kanal-Site (privat/freigegeben)", short: "Kanal", order: 6 },
  other: { label: "Andere Vorlage", short: "Andere", order: 7 },
  unknown: { label: "Ohne Gruppe — Art nicht über Graph verfügbar", short: "Art offen", order: 8 },
  system: { label: "System-Site", short: "System", order: 9 }
};

const VISIBILITY = { Public: "Öffentlich", Private: "Privat", HiddenMembership: "Verborgene Mitgliedschaft" };

// Was Graph (v1.0 und beta) nicht liefert — geprüft gegen die Doku zu site,
// sharepointSettings und den Nutzungsberichten (Stand 09/2026).
const NOT_VIA_GRAPH = [
  { topic: "Freigabestufe je Site", detail: "Graph liefert nur die tenantweite Stufe. Eine einzelne Site kann sie einschränken, aber nicht erweitern." },
  { topic: "Freigabestufe OneDrive", detail: "Die eigene OneDrive-Stufe (höchstens so offen wie SharePoint) steht nur im SharePoint Admin Center bzw. in SharePoint Online PowerShell." },
  { topic: "Standard-Linktyp und -Berechtigung", detail: "Welcher Link beim Teilen vorausgewählt ist (z. B. «Personen in der Organisation», Anzeigen oder Bearbeiten)." },
  { topic: "Ablauf von «Jeder»-Links und Gastzugriff", detail: "Gültigkeitsdauer anonymer Links und automatisches Entfernen von Gästen nach einer Frist." },
  { topic: "Besitzer und Mitglieder von Sites ohne M365-Gruppe", detail: "Websitesammlungsadministratoren und SharePoint-Gruppen (Besitzer, Mitglieder, Besucher) sind nur über SharePoint-REST bzw. PowerShell lesbar." },
  { topic: "Zugriff von nicht verwalteten Geräten", detail: "Die SharePoint-eigene Zugriffssteuerung (nur Web, eingeschränkter Zugriff) ist nicht in Graph abgebildet; wirksame Conditional-Access-Richtlinien dokumentiert der Bereich Conditional Access." },
  { topic: "Loop- und Fluid-Komponenten", detail: "Graph liefert zwar isLoopEnabled, der Wert entspricht aber nicht den Schaltern der SharePoint-Verwaltung (IsLoopEnabled, IsFluidEnabled) und wird deshalb nicht übernommen." }
];

// ============================================================== Helfer
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const k = next++;
      out[k] = await fn(items[k], k);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const num = v => { if (v === null || v === undefined || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const isoDate = v => { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d.toISOString(); };
const normUrl = u => String(u || "").trim().toLowerCase().replace(/\/+$/, "");
const collectionIdOf = siteId => { const p = String(siteId || "").split(","); return (p.length >= 2 ? p[1] : "").toLowerCase(); };
// GUID als Vergleichsschlüssel: nur die 32 Hex-Ziffern, klein — "{ABC…}", "abc…" und
// "ABC…" ohne Bindestriche ergeben denselben Schlüssel. Kein GUID-Muster -> null.
const guidKey = v => {
  const s = String(v || "").trim();
  if (!/^\{?[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\}?$/i.test(s)) return null;
  return s.toLowerCase().replace(/[^0-9a-f]/g, "");
};
// Alle GUIDs in einer Berichts-Id: einzelne GUID oder Graph-Form "host,sammlung,web".
const guidKeys = v => String(v || "").split(",").map(guidKey).filter(Boolean);
// Hex-Kennung beliebiger Länge (anonymisierte Felder), klein, ohne Trennzeichen.
const hexKey = v => { const s = String(v || "").trim(); return /^[0-9a-f-]{16,}$/i.test(s) ? s.toLowerCase().replace(/-/g, "") : null; };
/** Welche Form hat die "Site Id" im Bericht? guid | graphId | hash | empty | mixed */
function classifySiteIds(rows) {
  const kinds = new Set(rows.map(r => {
    const v = String(r.siteId || "").trim();
    if (!v) return "empty";
    if (v.includes(",")) return guidKeys(v).length ? "graphId" : "other";
    if (/^[0-9a-f]{32}$/i.test(v)) return "hex32";            // GUID ohne Bindestriche oder MD5-Prüfsumme
    if (guidKey(v)) return "guid";
    return hexKey(v) ? "hash" : "other";
  }));
  if (!kinds.size) return null;
  return kinds.size === 1 ? [...kinds][0] : "mixed";
}
// Kandidaten, aus denen eine anonymisierte Site-Id als Prüfsumme entstanden sein
// könnte. Ein Treffer ist ein Beleg (Kollision ausgeschlossen), kein Raten.
function hashCandidates(s, coll, web) {
  const crypto = require("crypto");
  const url = String(s.webUrl || "");
  const vals = new Set([coll, web, s.id, url, url + "/", url.toLowerCase(), url.toLowerCase() + "/"].filter(Boolean).flatMap(v => [v, String(v).toLowerCase(), String(v).toUpperCase()]));
  const out = [];
  for (const v of vals) for (const alg of ["md5", "sha1", "sha256"]) out.push(crypto.createHash(alg).update(String(v)).digest("hex"));
  return out;
}
const isGuest = u => !!u && (u.userType === "Guest" || /#EXT#/i.test(String(u.userPrincipalName || "")));

function fmtMB(mb) {
  const n = num(mb);
  if (n === null) return null;
  if (n >= 1024 * 1024) return `${+(n / 1024 / 1024).toFixed(1)} TB`;
  if (n >= 1024) return `${+(n / 1024).toFixed(1)} GB`;
  return `${n} MB`;
}
function fmtSec(s) {
  const n = num(s);
  if (n === null) return null;
  return n >= 3600 && n % 3600 === 0 ? `${n / 3600} Std.` : `${Math.round(n / 60)} Min.`;
}
const yesNo = (v, yes, no) => v === true ? yes : v === false ? no : null;
/** Freigabestufe aus dem Nutzungsbericht (SharePoint-Schreibweise, Gross/Klein egal) -> Stufe aus SHARING. */
function sharingFromReport(v) {
  const raw = String(v || "").trim();
  const key = SHARING_ORDER.find(k => k.toLowerCase() === raw.toLowerCase().replace(/\s+/g, ""));
  return key ? { key, label: SHARING[key].label, tone: SHARING[key].tone, raw } : { key: null, label: raw, tone: "muted", raw };
}

// ============================================================== Nutzungsberichte (CSV)
const HEADER_KEYS = {
  "report refresh date": "reportRefreshDate", "site id": "siteId", "site url": "siteUrl", "owner display name": "ownerDisplayName",
  "is deleted": "isDeleted", "last activity date": "lastActivityDate", "file count": "fileCount", "active file count": "activeFileCount",
  "page view count": "pageViewCount", "visited page count": "visitedPageCount", "storage used (byte)": "storageUsedInBytes",
  "storage allocated (byte)": "storageAllocatedInBytes", "root web template": "rootWebTemplate", "owner principal name": "ownerPrincipalName",
  "report period": "reportPeriod"
};
function headerKey(h) {
  const k = String(h || "").trim().toLowerCase();
  return HEADER_KEYS[k] || k.replace(/\(byte\)/, "inbytes").replace(/[^a-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ""));
}

/** RFC-4180-CSV (Anführungszeichen, Kommas und Zeilenumbrüche in Feldern, BOM). */
function parseCsv(text) {
  const s = String(text || "").replace(/^﻿/, "");
  const rows = [];
  let row = [], cur = "", quoted = false;
  const endRow = () => { row.push(cur); cur = ""; if (row.some(x => x !== "")) rows.push(row); row = []; };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else quoted = false; } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\r" || c === "\n") { if (c === "\r" && s[i + 1] === "\n") i++; endRow(); }
    else cur += c;
  }
  if (cur !== "" || row.length) endRow();
  if (!rows.length) return [];
  const head = rows[0].map(headerKey);
  return rows.slice(1).map(r => Object.fromEntries(head.map((h, i) => [h, r[i] === undefined ? "" : r[i]])));
}

/**
 * v1.0 antwortet mit 302 auf eine vorab signierte CSV-Datei; fetch folgt der
 * Weiterleitung (und lässt den Bearer-Token beim Hostwechsel weg), graph.js
 * liefert den Text als { raw }. Falls Microsoft JSON schickt ({ value }), geht das auch.
 */
async function loadReport(tenant, cert, fn, period) {
  const r = await graphReq(tenant, cert, "GET", `/reports/${fn}(period='${period}')`, null, LIST);
  if (r && Array.isArray(r.value)) return r.value;
  if (r && typeof r.raw === "string") return parseCsv(r.raw);
  return [];
}

/** Sieht ein Berichtsfeld nach Kennung statt Klartext aus? (Adresse ohne https://, UPN ohne @) */
function looksConcealed(rows, field, re) {
  const vals = rows.map(r => String(r[field] || "").trim()).filter(Boolean);
  if (!vals.length) return null;
  const hashed = vals.filter(v => !re.test(v)).length;
  return hashed / vals.length > 0.5;
}

// ============================================================== Site-Art
/** Vorlage aus dem Nutzungsbericht -> Art. Kennt Vorlagen-Ids (GROUP#0) und Anzeigenamen ("Communication Site"). */
function templateKind(tpl) {
  const t = String(tpl || "").trim();
  if (!t) return null;
  if (/^GROUP(#\d+)?$/i.test(t) || /^group$/i.test(t)) return "group";
  if (/SITEPAGEPUBLISHING|communication/i.test(t)) return "communication";
  if (/TEAMCHANNEL|channel/i.test(t)) return "channel";
  if (/APPCATALOG|app catalog|SRCHCEN|SRCHCENTERLITE|\bsearch\b|SPSMSITEHOST|REDIRECTSITE|POINTPUBLISHING|TENANTADMIN|SPSPERS|EHS#/i.test(t)) return "system";
  if (/^STS#3$/i.test(t) || /^team site$/i.test(t)) return "teamSite";
  if (/^STS#/i.test(t)) return "classic";
  if (/publishing|BLANKINTERNET|CMSPUBLISHING|ENTERWIKI|wiki|^BDR|document center|PROJECTSITE|project|blank|BLOG|records|OFFILE|visio/i.test(t)) return "classic";
  return "other";
}

/** System-Sites an der Adresse erkennen (unabhängig vom Bericht). */
function systemByUrl(url) {
  const u = String(url || "");
  let host = "", path = "";
  try { const x = new URL(u); host = x.hostname.toLowerCase(); path = x.pathname.replace(/\/+$/, "").toLowerCase(); } catch (e) { return false; }
  if (/-my\.sharepoint\./.test(host) && !path) return true;                       // OneDrive-Stammadresse
  if (/-admin\.sharepoint\./.test(host)) return true;
  return /^\/(sites\/appcatalog|sites\/contenttypehub|sites\/compliancepolicycenter|search|portals\/hub|portals\/community|portals\/personal\/[^/]+)$/i.test(path);
}

// ============================================================== Freigabe-Einstellungen
function describeSettings(raw) {
  if (!raw) return null;
  const cap = SHARING[raw.sharingCapability] || null;
  const sharing = {
    key: raw.sharingCapability || null,
    label: cap ? cap.label : (raw.sharingCapability || "unbekannt"),
    short: cap ? cap.short : (raw.sharingCapability || "unbekannt"),
    description: cap ? cap.description : "Wert von Microsoft nicht bekannt — Rohwert angezeigt.",
    tone: cap ? cap.tone : "muted",
    level: cap ? cap.level : null
  };
  const domains = raw.sharingDomainRestrictionMode === "allowList"
    ? `Nur an erlaubte Domains: ${(raw.sharingAllowedDomainList || []).join(", ") || "— (Liste leer)"}`
    : raw.sharingDomainRestrictionMode === "blockList"
      ? `An alle Domains ausser: ${(raw.sharingBlockedDomainList || []).join(", ") || "— (Liste leer)"}`
      : raw.sharingDomainRestrictionMode === "none" ? "Keine Einschränkung nach Domain" : (raw.sharingDomainRestrictionMode || null);
  const idle = raw.idleSessionSignOut || null;
  const groups = [
    { title: "Externe Freigabe", items: [
      { label: "Freigabestufe SharePoint", value: sharing.label, tone: sharing.tone, detail: sharing.description },
      { label: "Domains", value: domains },
      { label: "Weiterteilen durch Gäste", value: yesNo(raw.isResharingByExternalUsersEnabled, "Gäste dürfen Dateien, Ordner und Sites weiterteilen, die ihnen nicht gehören", "Gäste dürfen nicht weiterteilen") },
      { label: "Einladung annehmen", value: yesNo(raw.isRequireAcceptingUserToMatchInvitedUserEnabled, "Nur mit dem Konto, an das die Einladung ging", "Auch mit einem anderen Konto möglich") }
    ] },
    { title: "Sites und Speicher", items: [
      { label: "Sites erstellen", value: yesNo(raw.isSiteCreationEnabled, "Benutzer dürfen Sites erstellen", "Nur Administratoren erstellen Sites") },
      { label: "Befehl «Site erstellen»", value: yesNo(raw.isSiteCreationUIEnabled, "sichtbar", "ausgeblendet") },
      { label: "Pfad neuer Team-Sites", value: raw.siteCreationDefaultManagedPath ? "/" + String(raw.siteCreationDefaultManagedPath).replace(/^\/+/, "") : null },
      { label: "Speicherverwaltung", value: yesNo(raw.isSitesStorageLimitAutomatic, "Automatisch (Sites teilen sich den Tenant-Speicher)", "Manuell (Kontingent je Site)") },
      { label: "Standardkontingent neuer Sites", value: raw.isSitesStorageLimitAutomatic === true ? null : fmtMB(raw.siteCreationDefaultStorageLimitInMB) },
      { label: "Neue Seiten erstellen", value: yesNo(raw.isSitePagesCreationEnabled, "erlaubt", "gesperrt") },
      { label: "Kommentare auf Seiten", value: yesNo(raw.isCommentingOnSitePagesEnabled, "erlaubt", "gesperrt") },
      // Loop/Fluid bewusst NICHT aus raw.isLoopEnabled: Graph meldete dort in einem
      // Kundentenant false, während die SharePoint-Verwaltung IsLoopEnabled=True und
      // IsFluidEnabled=True zeigte. Die Übersetzung war nicht invertiert — der
      // Graph-Wert ist nicht derselbe Schalter. Steht deshalb in NOT_VIA_GRAPH.
      { label: "Zeitzone neuer Sites", value: raw.tenantDefaultTimezone || null }
    ] },
    { title: "OneDrive", items: [
      { label: "Standardkontingent", value: fmtMB(raw.personalSiteDefaultStorageLimitInMB) },
      { label: "Aufbewahrung nach Kontolöschung", value: num(raw.deletedUserPersonalSiteRetentionPeriodInDays) !== null ? `${raw.deletedUserPersonalSiteRetentionPeriodInDays} Tage` : null },
      { label: "Synchronisieren", value: raw.isUnmanagedSyncAppForTenantRestricted === true
        ? `Nur auf Geräten bestimmter Domänen (${(raw.allowedDomainGuidsForSyncApp || []).length} hinterlegt)`
        : raw.isUnmanagedSyncAppForTenantRestricted === false ? "Auf allen Geräten" : null },
      { label: "Sync-App für Mac", value: yesNo(raw.isMacSyncAppEnabled, "erlaubt", "gesperrt") },
      { label: "Nicht synchronisierte Dateitypen", value: (raw.excludedFileExtensionsForSyncApp || []).length ? raw.excludedFileExtensionsForSyncApp.join(", ") : (Array.isArray(raw.excludedFileExtensionsForSyncApp) ? "keine" : null) },
      { label: "Sync-Knopf in OneDrive", value: yesNo(raw.isSyncButtonHiddenOnPersonalSite, "ausgeblendet", "sichtbar") }
    ] },
    { title: "Anmeldung und Sitzung", items: [
      { label: "Ältere Protokolle", value: yesNo(raw.isLegacyAuthProtocolsEnabled, "Ältere Authentifizierungsprotokolle erlaubt", "Nur moderne Authentifizierung") },
      { label: "Abmeldung bei Inaktivität", value: idle ? (idle.isEnabled ? `nach ${fmtSec(idle.signOutAfterInSeconds) || "?"}${idle.warnAfterInSeconds ? `, Warnung nach ${fmtSec(idle.warnAfterInSeconds)}` : ""}` : "aus") : null }
    ] }
  ].map(g => ({ ...g, items: g.items.filter(i => i.value !== null && i.value !== undefined && i.value !== "") })).filter(g => g.items.length);
  return { sharing, groups };
}

// ============================================================== Erhebung
/**
 * opts: { period: 'D30' }
 * onProgress(label): Fortschritt für den Job.
 */
async function collectInventory(tenant, cert, opts, onProgress) {
  const say = typeof onProgress === "function" ? onProgress : () => {};
  const period = PERIODS.includes(String(opts && opts.period)) ? String(opts.period) : "D30";
  const periodDays = Number(period.slice(1));
  const gaps = [];
  const readable = { sites: false, groups: false, settings: false, reportSettings: false, siteReport: false, oneDriveReport: false, users: false };

  // ---------------------------------------------------------- Einstellungen
  say("Freigabe-Einstellungen");
  let settingsRaw = null;
  try { settingsRaw = await graphReq(tenant, cert, "GET", "/admin/sharepoint/settings", null, LIST); readable.settings = true; }
  catch (e) { gaps.push(`Tenantweite SharePoint-Einstellungen nicht lesbar (SharePointTenantSettings.Read.All nötig — im Tab Tenants einmal Reparieren): ${e.message}`); }
  if (settingsRaw) delete settingsRaw["@odata.context"];

  let concealedSetting = null;
  try {
    const rs = await graphReq(tenant, cert, "GET", "/admin/reportSettings", null, LIST);
    if (typeof rs.displayConcealedNames === "boolean") concealedSetting = rs.displayConcealedNames;
    readable.reportSettings = true;
  } catch (e) { gaps.push(`Berichtseinstellung (Anonymisierung) nicht lesbar (ReportSettings.Read.All nötig): ${e.message}`); }

  // ---------------------------------------------------------- Sites
  say("Sites");
  let allSites = [], sitesSource = "getAllSites";
  try {
    allSites = await graphAllPages(tenant, cert, "/sites/getAllSites", LIST);
    readable.sites = true;
  } catch (e) {
    try {
      allSites = await graphAllPages(tenant, cert, "/sites?search=*", LIST);
      sitesSource = "search";
      readable.sites = true;
      gaps.push(`/sites/getAllSites nicht verfügbar (${e.message}) — Sites über die Suche gelesen; OneDrives fehlen in dieser Liste, neu angelegte Sites erscheinen dort erst nach der Indizierung.`);
    } catch (e2) {
      gaps.push(`Sites nicht lesbar (Sites.Read.All nötig — im Tab Tenants einmal Reparieren): ${e2.message}`);
    }
  }
  const isPersonal = s => s.isPersonalSite === true || /-my\.sharepoint\.[^/]+\/personal\//i.test(String(s.webUrl || ""));
  const seen = new Set();
  allSites = allSites.filter(s => s && s.id && s.webUrl && !seen.has(s.id) && seen.add(s.id));
  const personalSites = allSites.filter(isPersonal);
  const spSites = allSites.filter(s => !isPersonal(s));

  // ---------------------------------------------------------- Nutzungsberichte
  say("Nutzungsberichte");
  let siteRows = [], odRows = [];
  try { siteRows = (await loadReport(tenant, cert, "getSharePointSiteUsageDetail", period)).filter(r => !/^true$/i.test(String(r.isDeleted))); readable.siteReport = true; }
  catch (e) { gaps.push(`Nutzungsbericht SharePoint nicht lesbar (Reports.Read.All nötig): ${e.message}`); }
  try { odRows = (await loadReport(tenant, cert, "getOneDriveUsageAccountDetail", period)).filter(r => !/^true$/i.test(String(r.isDeleted))); readable.oneDriveReport = true; }
  catch (e) { gaps.push(`Nutzungsbericht OneDrive nicht lesbar (Reports.Read.All nötig): ${e.message}`); }

  const detected = looksConcealed([...siteRows, ...odRows], "siteUrl", /^https?:\/\//i);
  const concealed = concealedSetting !== null ? concealedSetting : detected;
  const reportRefresh = (siteRows[0] || odRows[0] || {}).reportRefreshDate || null;

  // Zuordnung Bericht -> Site. Die "Site Id" des Berichts wird nicht als fertiger
  // Schlüssel verglichen, sondern in ihre GUID-Bestandteile zerlegt (Klammern,
  // Bindestriche, Gross/Klein egal) — der Bericht kann die Websitesammlungs-GUID,
  // die GUID des Stammwebs oder die volle Graph-Id "host,sammlung,web" liefern.
  // Bei anonymisierten Berichten kommt sie womöglich als Prüfsumme: dann wird
  // versucht, sie aus den bekannten Kennungen nachzurechnen (siehe siteJoin).
  const reportBySiteId = new Map();
  const reportByUrl = new Map();
  const reportHashed = [];
  for (const r of siteRows) {
    const keys = guidKeys(r.siteId);
    for (const k of keys) if (!reportBySiteId.has(k)) reportBySiteId.set(k, r);
    // Hex ohne Bindestriche kann eine GUID oder eine Prüfsumme sein — beide Wege offen halten.
    if (hexKey(r.siteId) && !/[-,{]/.test(String(r.siteId))) reportHashed.push(r);
    if (r.siteUrl && /^https?:/i.test(r.siteUrl)) reportByUrl.set(normUrl(r.siteUrl), r);
  }
  const siteIdFormat = classifySiteIds(siteRows);
  const joinedBy = { collection: 0, web: 0, url: 0, hash: 0 };
  const hashIndex = reportHashed.length ? new Map(reportHashed.map(r => [hexKey(r.siteId), r])) : null;
  function siteJoin(s) {
    const [, coll, web] = String(s.id || "").split(",");
    const kc = guidKey(coll), kw = guidKey(web);
    if (kc && reportBySiteId.has(kc)) { joinedBy.collection++; return reportBySiteId.get(kc); }
    if (kw && reportBySiteId.has(kw)) { joinedBy.web++; return reportBySiteId.get(kw); }
    const byUrl = reportByUrl.get(normUrl(s.webUrl));
    if (byUrl) { joinedBy.url++; return byUrl; }
    if (hashIndex) {
      for (const cand of hashCandidates(s, coll, web)) {
        const r = hashIndex.get(cand);
        if (r) { joinedBy.hash++; return r; }
      }
    }
    return null;
  }

  // ---------------------------------------------------------- M365-Gruppen
  say("M365-Gruppen");
  let groups = [];
  try {
    groups = await graphAllPages(tenant, cert,
      "/groups?$filter=groupTypes/any(c:c eq 'Unified')&$select=id,displayName,mail,visibility,resourceProvisioningOptions,createdDateTime,description&$top=999", LIST);
    readable.groups = true;
  } catch (e) { gaps.push(`M365-Gruppen nicht lesbar (Group.Read.All nötig): ${e.message}`); }

  // Gruppe -> Site: über /groups/{id}/sites/root, nicht über den Namen.
  const groupByCollection = new Map();
  let groupSiteErrors = 0;
  await mapLimit(groups, PARALLEL, async g => {
    try {
      const s = await graphReq(tenant, cert, "GET", `/groups/${encodeURIComponent(g.id)}/sites/root?$select=id,webUrl`, null, ONE);
      const cid = collectionIdOf(s && s.id);
      if (cid) groupByCollection.set(cid, g);
    } catch (e) {
      if (e.status !== 404) groupSiteErrors++;
    }
  });
  if (groupSiteErrors) gaps.push(`${groupSiteErrors} M365-Gruppe(n): zugehörige Site nicht abrufbar — diese Sites erscheinen ohne Gruppe.`);

  // ---------------------------------------------------------- Sites zusammensetzen
  say("Sites auswerten");
  const personNorm = o => ({
    id: o.id,
    name: o.displayName || o.userPrincipalName || o.id,
    // Gäste: die Mailadresse sagt mehr als der #EXT#-Anmeldename.
    upn: isGuest(o) ? (o.mail || o.userPrincipalName || null) : (o.userPrincipalName || o.mail || null),
    guest: isGuest(o),
    type: String(o["@odata.type"] || "#microsoft.graph.user").replace("#microsoft.graph.", "")
  });
  let memberErrors = 0;
  const sites = await mapLimit(spSites, PARALLEL, async s => {
    const cid = collectionIdOf(s.id);
    const rep = siteJoin(s);
    const g = groupByCollection.get(cid) || null;
    const template = rep ? (rep.rootWebTemplate || null) : null;
    let url; try { url = new URL(s.webUrl); } catch (e) { url = null; }
    const isRoot = !!(url && url.pathname.replace(/\/+$/, "") === "" && !/-my\.sharepoint\./i.test(url.hostname));

    let kind;
    if (g) kind = (g.resourceProvisioningOptions || []).includes("Team") ? "teams" : "group";
    else if (systemByUrl(s.webUrl)) kind = "system";
    else kind = templateKind(template) || "unknown";
    // Bericht sagt "Gruppe", die Gruppe ist aber nicht (mehr) auffindbar — z. B. gelöscht.
    const orphanGroup = !g && kind === "group";

    const site = {
      id: s.id, collectionId: cid,
      name: s.displayName || s.name || (url ? url.pathname.split("/").filter(Boolean).pop() : "") || s.webUrl,
      url: s.webUrl, path: url ? (url.pathname.replace(/\/+$/, "") || "/") : s.webUrl, host: url ? url.hostname : null,
      isRoot, kind,
      kindLabel: isRoot && kind === "unknown" ? "Stammsite — Art nicht über Graph verfügbar"
        : orphanGroup ? "Team-Site mit M365-Gruppe — Gruppe nicht auffindbar" : KIND[kind].label,
      template, orphanGroup,
      created: isoDate(s.createdDateTime), modified: isoDate(s.lastModifiedDateTime),
      lastActivity: rep && rep.lastActivityDate ? rep.lastActivityDate : null,
      fileCount: rep ? num(rep.fileCount) : null, activeFileCount: rep ? num(rep.activeFileCount) : null,
      pageViews: rep ? num(rep.pageViewCount) : null,
      storageUsed: rep ? num(rep.storageUsedInBytes) : null, storageAllocated: rep ? num(rep.storageAllocatedInBytes) : null,
      storageSource: rep && num(rep.storageUsedInBytes) !== null ? "report" : null,
      // Neuere Fassungen des Berichts tragen die Freigabestufe je Site ("External
      // Sharing"). Nur übernehmen, wenn die Spalte da ist — sonst bleibt es bei
      // "nicht über Graph verfügbar".
      reportSharing: rep && rep.externalSharing ? sharingFromReport(rep.externalSharing) : null,
      reportOwner: rep && !concealed && (rep.ownerDisplayName || rep.ownerPrincipalName) && !g ? { name: rep.ownerDisplayName || null, upn: rep.ownerPrincipalName || null } : null,
      inReport: !!rep,
      _rep: rep,
      group: null
    };

    // Speicher aus dem Laufwerk, wenn der Bericht die Site nicht kennt (neu, oder Bericht fehlt).
    if (site.storageUsed === null) {
      try {
        const d = await graphReq(tenant, cert, "GET", `/sites/${encodeURIComponent(s.id)}/drive?$select=id,quota`, null, ONE);
        if (d && d.quota) {
          site.storageUsed = num(d.quota.used);
          site.storageAllocated = num(d.quota.total);
          site.storageSource = site.storageUsed !== null ? "drive" : null;
        }
      } catch (e) { /* Site ohne Standardbibliothek — Speicher bleibt offen */ }
    }

    if (g) {
      const grp = {
        id: g.id, displayName: g.displayName, mail: g.mail || null, description: g.description || null,
        visibility: g.visibility || null, visibilityLabel: VISIBILITY[g.visibility] || g.visibility || "—",
        teams: (g.resourceProvisioningOptions || []).includes("Team"), created: isoDate(g.createdDateTime),
        owners: [], members: [], guests: [], ownerCount: null, memberCount: null, guestCount: null, membersTruncated: false
      };
      try {
        const owners = await graphAllPages(tenant, cert, `/groups/${encodeURIComponent(g.id)}/owners?$select=id,displayName,userPrincipalName,userType,mail&$top=999`, LIST);
        grp.owners = owners.map(personNorm);
        grp.ownerCount = grp.owners.length;
      } catch (e) { memberErrors++; grp.error = "Besitzer nicht lesbar: " + e.message; }
      try {
        const members = (await graphAllPages(tenant, cert, `/groups/${encodeURIComponent(g.id)}/members?$select=id,displayName,userPrincipalName,userType,mail&$top=999`, LIST)).map(personNorm);
        const guests = members.filter(m => m.guest);
        grp.memberCount = members.length;
        grp.guestCount = guests.length;
        grp.guests = guests.slice(0, 100);
        grp.members = members.sort((a, b) => (a.guest - b.guest) || a.name.localeCompare(b.name, "de")).slice(0, MEMBER_CAP);
        grp.membersTruncated = members.length > MEMBER_CAP;
      } catch (e) { memberErrors++; grp.error = (grp.error ? grp.error + " · " : "") + "Mitglieder nicht lesbar: " + e.message; }
      site.group = grp;
    }
    return site;
  });
  if (memberErrors) gaps.push(`${memberErrors} Abruf(e) von Besitzern/Mitgliedern fehlgeschlagen — betroffene Sites zeigen den Fehler im Detail.`);
  sites.sort((a, b) => (KIND[a.kind].order - KIND[b.kind].order) || (b.isRoot - a.isRoot) || a.name.localeCompare(b.name, "de"));

  // Berichtszeilen ohne Site in der Liste (z. B. Sites, die getAllSites nicht zeigt).
  const joinedRows = new Set(sites.map(s => s._rep).filter(Boolean));
  const reportOnlySites = siteRows.filter(r => !joinedRows.has(r)).length;
  for (const s of sites) delete s._rep;

  // ---------------------------------------------------------- Konten (für OneDrive)
  const userById = new Map();
  if (personalSites.length) {
    say("Konten");
    try {
      const users = await graphAllPages(tenant, cert, "/users?$select=id,displayName,userPrincipalName,accountEnabled,userType&$top=999", LIST);
      for (const u of users) userById.set(u.id, u);
      readable.users = true;
    } catch (e) { gaps.push(`Konten nicht lesbar (User.Read.All nötig) — OneDrives ohne Anmeldename und Kontostatus: ${e.message}`); }
  }

  // ---------------------------------------------------------- OneDrive
  say("OneDrive");
  const odByUrl = new Map();
  if (!concealed) for (const r of odRows) if (r.siteUrl) odByUrl.set(normUrl(r.siteUrl), r);
  const odList = personalSites.slice(0, ONEDRIVE_CAP);
  if (personalSites.length > ONEDRIVE_CAP) gaps.push(`${personalSites.length} OneDrives — Speicher je Laufwerk nur für die ersten ${ONEDRIVE_CAP} einzeln abgerufen.`);
  let driveErrors = 0;
  const accounts = await mapLimit(odList, PARALLEL, async s => {
    let d = null;
    try { d = await graphReq(tenant, cert, "GET", `/sites/${encodeURIComponent(s.id)}/drive?$select=id,quota,owner,lastModifiedDateTime`, null, ONE); }
    catch (e) { if (e.status !== 404) driveErrors++; }
    const ownerUser = d && d.owner && d.owner.user ? d.owner.user : null;
    const u = ownerUser && ownerUser.id ? userById.get(ownerUser.id) : null;
    const rep = odByUrl.get(normUrl(s.webUrl)) || null;
    if (rep) odByUrl.delete(normUrl(s.webUrl));
    const used = d && d.quota ? num(d.quota.used) : null;
    return {
      name: (u && u.displayName) || (ownerUser && ownerUser.displayName) || s.displayName || s.name || s.webUrl,
      upn: (u && u.userPrincipalName) || (rep && rep.ownerPrincipalName) || null,
      enabled: u ? u.accountEnabled !== false : null,
      guest: u ? isGuest(u) : false,
      url: s.webUrl,
      created: isoDate(s.createdDateTime),
      modified: isoDate((d && d.lastModifiedDateTime) || s.lastModifiedDateTime),
      storageUsed: used !== null ? used : (rep ? num(rep.storageUsedInBytes) : null),
      storageAllocated: d && d.quota && num(d.quota.total) !== null ? num(d.quota.total) : (rep ? num(rep.storageAllocatedInBytes) : null),
      lastActivity: rep && rep.lastActivityDate ? rep.lastActivityDate : null,
      fileCount: rep ? num(rep.fileCount) : null,
      source: d ? "drive" : rep ? "report" : "site"
    };
  });
  if (driveErrors) gaps.push(`${driveErrors} OneDrive-Laufwerk(e) nicht abrufbar — Speicher dort offen.`);
  // Berichtszeilen ohne passende OneDrive-Site (nur ohne Anonymisierung zuordenbar)
  if (!concealed) {
    for (const rep of odByUrl.values()) {
      accounts.push({
        name: rep.ownerDisplayName || rep.ownerPrincipalName || rep.siteUrl, upn: rep.ownerPrincipalName || null, enabled: null, guest: false,
        url: rep.siteUrl, created: null, modified: null,
        storageUsed: num(rep.storageUsedInBytes), storageAllocated: num(rep.storageAllocatedInBytes),
        lastActivity: rep.lastActivityDate || null, fileCount: num(rep.fileCount), source: "report"
      });
    }
  }
  accounts.sort((a, b) => (b.storageUsed || 0) - (a.storageUsed || 0) || String(a.name).localeCompare(String(b.name), "de"));

  const refreshMs = reportRefresh ? new Date(reportRefresh).getTime() : Date.now();
  const activeIn = rows => rows.filter(r => r.lastActivityDate && (refreshMs - new Date(r.lastActivityDate).getTime()) / 864e5 < periodDays).length;
  const oneDrive = {
    accounts,
    report: {
      readable: readable.oneDriveReport, rows: odRows.length, activeAccounts: activeIn(odRows),
      storageUsed: odRows.reduce((a, r) => a + (num(r.storageUsedInBytes) || 0), 0),
      joined: accounts.filter(a => a.lastActivity).length
    }
  };

  // ---------------------------------------------------------- Zusammenfassung
  const content = sites.filter(s => s.kind !== "system");
  const byKind = {};
  for (const k of Object.keys(KIND)) byKind[k] = sites.filter(s => s.kind === k).length;
  const guestIds = new Set();
  for (const s of sites) for (const gu of (s.group ? s.group.guests : [])) guestIds.add(gu.id);
  const sum = arr => arr.reduce((a, x) => a + (x || 0), 0);
  const settings = describeSettings(settingsRaw);
  const summary = {
    sites: content.length, systemSites: byKind.system, byKind,
    teams: byKind.teams, groupSites: byKind.teams + byKind.group,
    storageUsed: sum(sites.map(s => s.storageUsed)),
    storageUnknown: sites.filter(s => s.storageUsed === null).length,
    oneDrives: accounts.length,
    oneDriveStorage: sum(accounts.map(a => a.storageUsed)),
    oneDriveActive: oneDrive.report.readable ? oneDrive.report.activeAccounts : null,
    guests: guestIds.size,
    sitesWithGuests: sites.filter(s => s.group && s.group.guestCount).length,
    sharing: settings ? settings.sharing.key : null,
    sharingLabel: settings ? settings.sharing.label : null,
    sharingTone: settings ? settings.sharing.tone : null
  };

  const result = {
    generatedAt: new Date().toISOString(),
    period, periodDays, sitesSource,
    summary,
    settings: settings ? { ...settings, raw: settingsRaw } : null,
    reports: {
      concealed, concealedSetting, concealedDetected: detected, refreshDate: reportRefresh,
      siteRows: siteRows.length, siteRowsJoined: sites.filter(s => s.inReport).length, reportOnlySites,
      siteIdFormat, joinedBy,
      joinNote: joinNote(siteRows.length, sites.filter(s => s.inReport).length, sites.length, siteIdFormat, joinedBy, concealed),
      oneDriveRows: odRows.length
    },
    sites, oneDrive,
    notViaGraph: NOT_VIA_GRAPH,
    readable, gaps
  };
  result.hints = buildHints(result);
  return result;
}

/**
 * Ein Satz dazu, wie Berichtszeilen den Sites zugeordnet wurden — für Oberfläche
 * und PDF gleich. Bei 0 Treffern steht der Grund da statt "0 von n zugeordnet".
 */
function joinNote(rows, joined, total, format, by, concealed) {
  if (!rows) return null;
  const via = [by.collection && "Websitesammlungs-Id", by.web && "Web-Id", by.url && "Adresse", by.hash && "Prüfsumme der Kennung"].filter(Boolean);
  if (joined) return `${joined} von ${total} Sites dem Nutzungsbericht zugeordnet (über ${via.join(", ")}).`;
  const what = "Art (ohne Gruppe), Aktivität und Berichtsspeicher bleiben offen; der Speicher kommt aus der Standardbibliothek der Site.";
  if (format === "empty") return `Der ${concealed ? "anonymisierte " : ""}Bericht enthält keine Site-Id — keine Zuordnung möglich. ${what}`;
  if (format === "hash" || format === "hex32" || format === "other") return `Die Site-Id ist im ${concealed ? "anonymisierten " : ""}Bericht ebenfalls verborgen (Kennung statt GUID) — keine Zuordnung möglich. ${what}`;
  return `Die Site-Ids des Berichts (${format === "graphId" ? "Graph-Form" : "GUID"}) passen zu keiner Site aus Graph — keine Zuordnung. ${what}`;
}

// ============================================================== Hinweise (Anhang)
/**
 * Bewertende Hinweise — gehören in den abwählbaren Anhang, nicht in die
 * beschreibende Doku. severity: warn | hinweis.
 */
function buildHints(r) {
  const out = [];
  const add = (severity, text) => out.push({ severity, text });
  const raw = r.settings && r.settings.raw;
  const cap = raw && raw.sharingCapability;
  if (cap === "externalUserAndGuestSharing") add("warn", "Tenantweit sind «Jeder»-Links (ohne Anmeldung) erlaubt. Ablaufdauer und vorausgewählter Linktyp sind nicht über Graph lesbar und im SharePoint Admin Center zu prüfen.");
  if (raw && cap && cap !== "disabled") {
    if (raw.isResharingByExternalUsersEnabled === true) add("warn", "Gäste dürfen Inhalte weiterteilen, die ihnen nicht gehören.");
    if (raw.sharingDomainRestrictionMode === "none") add("hinweis", "Externe Freigaben sind nicht auf bestimmte Domains beschränkt.");
    if (raw.isRequireAcceptingUserToMatchInvitedUserEnabled === false) add("hinweis", "Einladungen lassen sich mit einem anderen Konto annehmen als dem eingeladenen.");
  }
  if (raw && raw.isLegacyAuthProtocolsEnabled === true) add("warn", "Ältere Authentifizierungsprotokolle sind für SharePoint erlaubt.");
  if (raw && raw.idleSessionSignOut && raw.idleSessionSignOut.isEnabled === false) add("hinweis", "Keine automatische Abmeldung bei Inaktivität für SharePoint und OneDrive im Browser.");

  const gs = r.sites.filter(s => s.group);
  const noOwner = gs.filter(s => s.group.ownerCount === 0);
  if (noOwner.length) add("warn", `Gruppe ohne Besitzer (${noOwner.length}): ${noOwner.map(s => s.name).join(", ")}.`);
  const oneOwner = gs.filter(s => s.group.ownerCount === 1);
  if (oneOwner.length) add("hinweis", `Nur ein Besitzer (${oneOwner.length}): ${oneOwner.slice(0, 30).map(s => s.name).join(", ")}${oneOwner.length > 30 ? " …" : ""}.`);
  const pubGuests = gs.filter(s => s.group.visibility === "Public" && s.group.guestCount);
  if (pubGuests.length) add("warn", `Öffentliche Gruppe mit Gästen (${pubGuests.length}): ${pubGuests.map(s => `${s.name} (${s.group.guestCount})`).join(", ")}.`);
  const withGuests = gs.filter(s => s.group.guestCount && s.group.visibility !== "Public");
  if (withGuests.length) add("hinweis", `Weitere Sites mit Gästen (${withGuests.length}): ${withGuests.slice(0, 30).map(s => `${s.name} (${s.group.guestCount})`).join(", ")}${withGuests.length > 30 ? " …" : ""}.`);
  const orphan = r.sites.filter(s => s.orphanGroup);
  if (orphan.length) add("hinweis", `Laut Nutzungsbericht gruppenverbunden, Gruppe aber nicht auffindbar (${orphan.length}): ${orphan.map(s => s.name).join(", ")}.`);
  const yearAgo = Date.now() - 365 * 864e5;
  const stale = r.sites.filter(s => s.kind !== "system" && s.modified && new Date(s.modified).getTime() < yearAgo);
  if (stale.length) add("hinweis", `Seit über einem Jahr nicht geändert (${stale.length}): ${stale.slice(0, 30).map(s => s.name).join(", ")}${stale.length > 30 ? " …" : ""}.`);
  const full = r.sites.filter(s => s.storageUsed && s.storageAllocated && s.storageUsed / s.storageAllocated >= 0.9);
  if (full.length) add("warn", `Speicher zu mindestens 90 % belegt (${full.length}): ${full.map(s => s.name).join(", ")}.`);
  const disabledOd = r.oneDrive.accounts.filter(a => a.enabled === false);
  if (disabledOd.length) add("hinweis", `${disabledOd.length} OneDrive(s) gehören deaktivierten Konten: ${disabledOd.slice(0, 30).map(a => a.upn || a.name).join(", ")}${disabledOd.length > 30 ? " …" : ""}.`);
  const fullOd = r.oneDrive.accounts.filter(a => a.storageUsed && a.storageAllocated && a.storageUsed / a.storageAllocated >= 0.9);
  if (fullOd.length) add("warn", `OneDrive zu mindestens 90 % belegt (${fullOd.length}): ${fullOd.map(a => a.upn || a.name).join(", ")}.`);
  return out;
}

// ============================================================== CSV
function csvRows(d, kind) {
  const gb = b => (b === null || b === undefined ? "" : (b / 1024 ** 3).toFixed(2));
  if (kind === "members") {
    const rows = [["Site", "Adresse", "Rolle", "Name", "Anmeldename", "Gast"]];
    for (const s of d.sites) {
      if (!s.group) continue;
      for (const o of s.group.owners) rows.push([s.name, s.url, "Besitzer", o.name, o.upn, o.guest ? "ja" : "nein"]);
      for (const m of s.group.members) rows.push([s.name, s.url, "Mitglied", m.name, m.upn, m.guest ? "ja" : "nein"]);
      if (s.group.membersTruncated) rows.push([s.name, s.url, "Mitglied", `… ${s.group.memberCount - s.group.members.length} weitere (nicht gespeichert)`, "", ""]);
    }
    return rows;
  }
  if (kind === "onedrive") {
    const rows = [["Name", "Anmeldename", "Konto", "Adresse", "Belegt (GB)", "Kontingent (GB)", "Letzte Aktivität", "Dateien", "Geändert", "Quelle"]];
    for (const a of d.oneDrive.accounts) rows.push([a.name, a.upn, a.enabled === false ? "deaktiviert" : a.enabled ? "aktiv" : "", a.url, gb(a.storageUsed), gb(a.storageAllocated),
      a.lastActivity || (d.reports.concealed ? "anonymisiert" : ""), a.fileCount === null ? "" : a.fileCount, a.modified ? a.modified.slice(0, 10) : "", a.source]);
    return rows;
  }
  const rows = [["Site", "Adresse", "Art", "Vorlage (Bericht)", "M365-Gruppe", "Sichtbarkeit", "Teams", "Besitzer", "Mitglieder", "Gäste", "Erstellt", "Geändert", "Letzte Aktivität", "Belegt (GB)", "Kontingent (GB)", "Speicherquelle", "Freigabestufe der Site"]];
  for (const s of d.sites) {
    const g = s.group;
    rows.push([s.name, s.url, s.kindLabel, s.template || "", g ? g.displayName : "", g ? g.visibilityLabel : "", g ? (g.teams ? "ja" : "nein") : "",
      g ? g.owners.map(o => o.upn || o.name).join(", ") : (s.reportOwner ? (s.reportOwner.upn || s.reportOwner.name) + " (Bericht)" : "nicht über Graph verfügbar"),
      g && g.memberCount !== null ? g.memberCount : "", g && g.guestCount !== null ? g.guestCount : "",
      s.created ? s.created.slice(0, 10) : "", s.modified ? s.modified.slice(0, 10) : "", s.lastActivity || "",
      gb(s.storageUsed), gb(s.storageAllocated), s.storageSource === "report" ? "Nutzungsbericht" : s.storageSource === "drive" ? "Standardbibliothek" : "", "nicht über Graph verfügbar"]);
  }
  return rows;
}

module.exports = {
  collectInventory, describeSettings, buildHints, csvRows, parseCsv, templateKind,
  SHARING, SHARING_ORDER, KIND, NOT_VIA_GRAPH, PERIODS
};
