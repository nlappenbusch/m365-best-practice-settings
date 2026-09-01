"use strict";
/**
 * Namenskonvention — eine Stelle, an der entschieden wird, wie Objekte heissen.
 *
 * Vorher steckte jede Konvention als Literal in dem Modul, das sie brauchte
 * (`"AAD-" + tag` in groupTags, `"AAD-CA-RING-"` in conditionalAccess,
 * `"WIN - DriveMapping - "` in driveMapping …). Ein Schemawechsel hiess: alle
 * Stellen suchen und hoffen, keine zu vergessen. Jetzt liegen die Muster hier.
 *
 * Zwei mitgelieferte Profile:
 *  - `legacy` — der Bestand (AAD-*), Vorgabe
 *  - `v2`     — das Tier-Schema aus dem Namenskonventionen-Abgleich
 * Dazu `custom`: einzelne Muster lassen sich überschreiben, der Rest kommt aus
 * dem gewählten Grundprofil.
 *
 * Gültigkeit: global als Vorgabe, pro Tenant überschreibbar. Das ist Absicht —
 * ein neu onboardeter Tenant kann auf v2 laufen, während Bestandstenants ihre
 * gewachsenen Namen behalten. Ein globaler Zwangswechsel würde dort nur
 * Dubletten anlegen, weil bestehende Objekte NICHT umbenannt werden.
 *
 * Deshalb die zweite wichtige Funktion neben `render`: `candidates()` liefert
 * einen Namen nach ALLEN bekannten Profilen. Wer ein Objekt sucht, sucht damit
 * auch die Namen, die ein früheres Profil erzeugt hat — sonst legt das Tool
 * nach einem Schemawechsel neben dem bestehenden Objekt ein zweites an.
 */

// ---------------------------------------------------------------- Profile
const PROFILES = {
  legacy: {
    key: "legacy",
    label: "Bestand (AAD-*)",
    hint: "Die gewachsene Konvention der bestehenden Tenants.",
    templates: {
      deviceGroup: "AAD-{tag}",
      appGroup: "AAD-APP-{app}",
      pmpGroup: "AAD-PMP-{app}",
      caRing: "AAD-CA-RING-{RING}",
      caExclusionTemp: "AAD-CA-ExclusionTemp",
      caExclusionPerm: "AAD-CA-ExclusionPermanent",
      caBreakGlass: "AAD-CA-BreakGlass",
      caSyncAccounts: "AAD-CA-SyncAccounts",
      mamGroup: "AAD-USR-{app}",
      roleGroup: "AAD-ROLE-{app}",
      breakGlassUser: "breakglass-{nn}",
      scriptDrive: "WIN - DriveMapping - {name}",
      scriptPrinter: "WIN - PrinterMapping - {name}",
      scriptRegistry: "WIN - RegistryPolicy - {name}",
      scriptSharePoint: "WIN - SharePointSync - {name}",
      browserExtEdge: "WIN - BrowserExtensions - Edge - {name}",
      eopPrefix: "BP_"
    }
  },
  v2: {
    key: "v2",
    label: "v2 (Tier-Schema)",
    hint: "Schema aus dem Namenskonventionen-Abgleich: Tier-Präfix, DG für Geräte, CSG für Sicherheitsgruppen.",
    templates: {
      deviceGroup: "T2-DG-{tag}",
      appGroup: "T2-DG-WIN-App{App}",
      pmpGroup: "T2-DG-WIN-Pmp{App}",
      caRing: "T0-CSG-GOV-CA-Ring{Ring}",
      caExclusionTemp: "T0-CSG-GOV-CA-Temp-Exempt",
      caExclusionPerm: "T0-CSG-GOV-CA-Permanent-Exempt",
      caBreakGlass: "T0-CSG-GOV-CA-BreakGlass-Exempt",
      caSyncAccounts: "T0-CSG-GOV-CA-SyncAccounts-Exempt",
      mamGroup: "T2-CSG-GOV-MAM-{App}",
      roleGroup: "T2-CSG-ADM-ENTRA-{App}",
      breakGlassUser: "brk.notfall{nn}",
      scriptDrive: "T2-WIN-CP-DriveMapping-{Name}",
      scriptPrinter: "T2-WIN-CP-PrinterMapping-{Name}",
      scriptRegistry: "T2-WIN-CP-RegistryPolicy-{Name}",
      scriptSharePoint: "T2-WIN-CP-SharePointSync-{Name}",
      browserExtEdge: "T2-WIN-CP-BrowserExtensions-Edge-{Name}",
      eopPrefix: "BP_"
    }
  }
};

/** Was jedes Muster bedeutet — der Editor zeigt das an, damit niemand raten muss. */
const KINDS = [
  { key: "deviceGroup", label: "Gerätegruppe (GroupTag)", vars: ["tag"], example: { tag: "WIN-Std" },
    note: "Der GroupTag ergibt sich umgekehrt aus dem Gruppennamen ohne Präfix — beides muss zusammenpassen." },
  { key: "appGroup", label: "App-Zielgruppe (selbst paketiert)", vars: ["app"], example: { app: "Bitdefender" } },
  { key: "pmpGroup", label: "App-Zielgruppe (Patch My PC)", vars: ["app"], example: { app: "GoogleChrome" } },
  { key: "caRing", label: "CA-Ring-Gruppe", vars: ["ring"], example: { ring: "PILOT" } },
  { key: "caExclusionTemp", label: "CA-Ausnahme temporär", vars: [], example: {} },
  { key: "caExclusionPerm", label: "CA-Ausnahme dauerhaft", vars: [], example: {} },
  { key: "caBreakGlass", label: "CA-Gruppe Break-Glass", vars: [], example: {} },
  { key: "caSyncAccounts", label: "CA-Gruppe Sync-Konten", vars: [], example: {} },
  { key: "mamGroup", label: "Benutzergruppe App-Protection (MAM)", vars: ["app"], example: { app: "AppProtection" },
    note: "Benutzer als Ziel — nur dort, wo wirklich der Mensch gemeint ist, nicht das Gerät." },
  { key: "roleGroup", label: "Rollen-/RBAC-Gruppe", vars: ["app"], example: { app: "Helpdesk" } },
  { key: "breakGlassUser", label: "Break-Glass-Konto", vars: ["nn"], example: { nn: 1 },
    note: "Ohne Domäne — der UPN entsteht daraus plus der onmicrosoft-Domäne des Tenants." },
  { key: "scriptDrive", label: "Plattformskript Laufwerks-Mapping", vars: ["name"], example: { name: "Standard" } },
  { key: "scriptPrinter", label: "Konfiguration Drucker-Mapping", vars: ["name"], example: { name: "Standard" } },
  { key: "scriptRegistry", label: "Plattformskript Registry-Richtlinie", vars: ["name"], example: { name: "Bitwarden-Region" } },
  { key: "scriptSharePoint", label: "Plattformskript SharePoint-Sync", vars: ["name"], example: { name: "Standard" } },
  { key: "browserExtEdge", label: "Profil Browser-Erweiterungen (Edge)", vars: ["name"], example: { name: "Bitwarden" } },
  { key: "eopPrefix", label: "Präfix EOP-/Alert-Objekte", vars: [], example: {},
    note: "Tool-Marker für die eigenen Exchange-Objekte. Ändern heisst: Der Audit erkennt bestehende Objekte nicht mehr." }
];

// ---------------------------------------------------------------- Rendern
function camel(s) {
  return String(s == null ? "" : s)
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue")
    .replace(/Ä/g, "Ae").replace(/Ö/g, "Oe").replace(/Ü/g, "Ue").replace(/ß/g, "ss")
    .split(/[^A-Za-z0-9]+/).filter(Boolean)
    // Durchgehend grosse Woerter (PILOT, STD) werden zu Pilot/Std — die v2
    // verlangt CamelCase innerhalb einer Position, "RingPILOT" waere falsch.
    // Gemischte Schreibweisen (GoogleChrome) bleiben, wie sie sind.
    .map(p => (p === p.toUpperCase() && p.length > 1 ? p.charAt(0) + p.slice(1).toLowerCase() : p.charAt(0).toUpperCase() + p.slice(1)))
    .join("");
}

/**
 * Platzhalter: {x} liefert den Wert wie übergeben, {X} in Grossbuchstaben,
 * {Xx} in CamelCase ohne Sonderzeichen. {nn} wird zweistellig aufgefüllt.
 */
function render(template, vars) {
  let out = String(template || "");
  Object.keys(vars || {}).forEach(k => {
    const raw = vars[k];
    if (raw === undefined || raw === null) return;
    const asText = String(raw);
    const upperKey = k.toUpperCase();
    const camelKey = k.charAt(0).toUpperCase() + k.slice(1);
    out = out.split("{" + k + "}").join(k === "nn" ? String(parseInt(asText, 10) || 1).padStart(2, "0") : asText);
    out = out.split("{" + upperKey + "}").join(asText.toUpperCase());
    out = out.split("{" + camelKey + "}").join(camel(asText));
  });
  // Nicht gefüllte Platzhalter fliegen raus, statt roh im Objektnamen zu landen.
  return out.replace(/\{[A-Za-z]+\}/g, "").trim();
}

// ---------------------------------------------------------------- Konvention
let stateProvider = () => ({});

/** server.js reicht loadState herein — das Modul liest den Zustand nicht selbst. */
function useStateProvider(fn) { if (typeof fn === "function") stateProvider = fn; }

function baseProfile(key) { return PROFILES[key] ? PROFILES[key] : PROFILES.legacy; }

function mergeConvention(raw) {
  const profile = raw && PROFILES[raw.profile] ? raw.profile : "legacy";
  const templates = Object.assign({}, baseProfile(profile).templates);
  if (raw && raw.templates) {
    Object.keys(raw.templates).forEach(k => {
      const v = String(raw.templates[k] || "").trim();
      if (v && Object.prototype.hasOwnProperty.call(templates, k)) templates[k] = v;
    });
  }
  const custom = Object.keys(templates).some(k => templates[k] !== baseProfile(profile).templates[k]);
  return { profile, templates, custom };
}

/** Wirksame Konvention: Tenant-Override schlägt globale Vorgabe schlägt Bestand. */
function forTenant(tenantId) {
  const s = stateProvider() || {};
  const global = s.naming || null;
  let tenantRaw = null;
  if (tenantId) {
    const t = (s.tenants || []).find(x => x.id === tenantId || x.tenantId === tenantId);
    if (t && t.naming) tenantRaw = t.naming;
  }
  if (tenantRaw) {
    // Der Tenant erbt das globale Profil, wenn er nur einzelne Muster ändert.
    const merged = {
      profile: tenantRaw.profile || (global && global.profile) || "legacy",
      templates: Object.assign({}, (global && global.templates) || {}, tenantRaw.templates || {})
    };
    const c = mergeConvention(merged);
    c.source = "tenant";
    return c;
  }
  const c = mergeConvention(global);
  c.source = global ? "global" : "default";
  return c;
}

/** Einen Namen nach der wirksamen Konvention bilden. */
function name(kind, vars, tenantId) {
  const conv = forTenant(tenantId);
  const tpl = conv.templates[kind];
  if (!tpl) throw new Error("Unbekannter Namenstyp: " + kind);
  return render(tpl, vars || {});
}

/**
 * Alle Namen, unter denen ein Objekt existieren könnte — wirksame Konvention
 * zuerst, danach die mitgelieferten Profile. Wer sucht, sucht damit auch die
 * Namen früherer Schemata und legt nichts doppelt an.
 */
function candidates(kind, vars, tenantId) {
  const out = [];
  const push = v => { if (v && out.indexOf(v) < 0) out.push(v); };
  push(name(kind, vars, tenantId));
  Object.keys(PROFILES).forEach(p => push(render(PROFILES[p].templates[kind], vars || {})));
  return out;
}

/** Umkehrung zu deviceGroup: GroupTag aus einem Gruppennamen zurückgewinnen. */
function tagFromDeviceGroup(displayName, tenantId) {
  const n = String(displayName || "");
  const prefixes = candidates("deviceGroup", { tag: " " }, tenantId)
    .map(c => c.split(" ")[0])
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const p of prefixes) {
    if (n.toLowerCase().startsWith(p.toLowerCase())) return n.slice(p.length);
  }
  return null;
}

/** Profil- und Musterübersicht für den Editor. */
function describe(tenantId) {
  const conv = forTenant(tenantId);
  return {
    profiles: Object.keys(PROFILES).map(k => ({
      key: k, label: PROFILES[k].label, hint: PROFILES[k].hint, templates: PROFILES[k].templates
    })),
    kinds: KINDS,
    effective: conv,
    preview: KINDS.map(k => ({
      key: k.key,
      label: k.label,
      note: k.note || "",
      template: conv.templates[k.key],
      example: render(conv.templates[k.key], k.example)
    }))
  };
}

module.exports = {
  PROFILES, KINDS,
  useStateProvider, forTenant, name, candidates, render, camel,
  tagFromDeviceGroup, mergeConvention, describe
};
