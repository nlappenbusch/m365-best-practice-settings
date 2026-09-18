"use strict";
/**
 * Ist-Zustand — Auswertung ohne Tenant-Zugriff: aus der gespeicherten Erhebung
 * (lib/istZustand.js) und dem Register «Entscheide und Kommentare» wird, was PDF und
 * Oberfläche gleichermassen brauchen:
 *
 *  - Kapitelnummern (Kapitel 9 im Hauptteil, als Anhang oder weggelassen)
 *  - Wirkung je CA-Richtlinie: wirksam / Nur Bericht / aus / ohne Wirkung (mit Grund)
 *  - welche Mail-Schutzrichtlinie für welche Domain wirkt — mit den Vorrangregeln
 *    von Microsoft (Streng > Standard > eigene Regeln nach Priorität > Standardrichtlinie)
 *  - regelbasierte Hinweise für Kapitel 9 (beschreibend, mit Kapitelverweis)
 *  - Änderungen eines Zeitraums als Zeilen vorher / nachher / Begründung
 *  - Register-Treffer je Objekt
 *
 * Reine Funktionen, keine I/O — damit lassen sie sich ohne Tenant testen.
 */

// ============================================================== Register
const OBJECT_TYPES = {
  ca: { label: "Richtlinie für bedingten Zugriff", chapter: "anm.ca" },
  intune: { label: "Intune-Richtlinie", chapter: "ger" },
  app: { label: "Intune-App", chapter: "ger.apps" },
  geraet: { label: "Gerät", chapter: "ger.geraete" },
  gruppe: { label: "Gruppe", chapter: "sp.gruppen" },
  site: { label: "SharePoint-Site", chapter: "sp.sites" },
  mail: { label: "E-Mail: Richtlinie oder Einstellung", chapter: "mail.schutz" },
  anwendung: { label: "Anwendung oder Freigabe", chapter: "apps.freigaben" },
  kapitel: { label: "Text zu einem Kapitel", chapter: null },
  aenderung: { label: "Begründung einer Änderung", chapter: "aend" },
  allgemein: { label: "Allgemeiner Hinweis", chapter: "abw" }
};

/** Einträge des Registers, die Objekte betreffen (Konten-Einträge haben keinen objectType). */
function objectEntries(register) { return (register || []).filter(e => e && e.objectType && OBJECT_TYPES[e.objectType]); }
function accountEntries(register) { return (register || []).filter(e => e && !e.objectType && e.upn); }

function norm(s) { return String(s == null ? "" : s).trim().toLowerCase(); }
/** Zweck aus dem Ausnahme-Register ohne Schlusspunkt — er steht mitten im Satz. */
function purp(r) { return String((r && r.purpose) || "").trim().replace(/[.\s]+$/, ""); }

function createLookup(register) {
  const obj = objectEntries(register);
  const acc = accountEntries(register);
  return {
    /** Einträge zu einem Objekt: zuerst über die Id, sonst über den Namen. */
    of(type, id, name) {
      const hits = obj.filter(e => e.objectType === type && ((id && e.objectId && norm(e.objectId) === norm(id)) || (!e.objectId && name && norm(e.objectName) === norm(name)) || (e.objectId && name && !id && norm(e.objectName) === norm(name))));
      return hits.sort((a, b) => String(a.date || a.createdAt).localeCompare(String(b.date || b.createdAt)));
    },
    /** Irgendein Eintrag zu dieser Objekt-Id, gleich welcher Art (für Begründungen in Kapitel 10). */
    anyById(id) { return id ? obj.filter(e => e.objectId && norm(e.objectId) === norm(id) && e.objectType !== "aenderung") : []; },
    chapter(key) { return obj.filter(e => e.objectType === "kapitel" && norm(e.objectId) === norm(key)); },
    account(upn) { return acc.find(e => norm(e.upn) === norm(upn)) || null; },
    decisions() { return obj.filter(e => e.decision && e.objectType !== "allgemein"); },
    general() { return obj.filter(e => e.objectType === "allgemein"); },
    all: obj,
    accounts: acc
  };
}

/** Kommentartext für eine Zeile: mehrere Einträge hintereinander. */
function commentText(entries) {
  return (entries || []).map(e => e.text).filter(Boolean).join(" ");
}

// ============================================================== Kapitel
const SUBS = {
  konten: [["konten.intern", "Interne Konten"], ["konten.rollen", "Administrative Rollen"], ["konten.gaeste", "Gäste"], ["konten.lizenzen", "Lizenzen"]],
  anm: [["anm.methoden", "Anmeldemethoden"], ["anm.ca", "Richtlinien für bedingten Zugriff"], ["anm.gruppen", "Geltungs- und Ausnahmegruppen"]],
  ger: [["ger.geraete", "Geräte in Intune"], ["ger.gruppen", "Gerätegruppen und Autopilot"], ["ger.konform", "Konformitätsrichtlinien"], ["ger.win", "Konfiguration Windows"], ["ger.mac", "Konfiguration macOS"], ["ger.apps", "Zugewiesene Anwendungen"], ["ger.weitere", "Weitere Plattformen"]],
  mail: [["mail.dns", "Absenderauthentisierung (öffentliches DNS)"], ["mail.schutz", "Welche Schutzrichtlinie wirkt"], ["mail.weitere", "Weitere Einstellungen"], ["mail.warnungen", "Warnungsrichtlinien"]],
  apps: [["apps.einst", "Einstellungen"], ["apps.freigaben", "Freigaben mit weitreichenden Berechtigungen"], ["apps.reg", "App-Registrierungen mit Anmeldedaten"], ["apps.dritt", "Unternehmensanwendungen von Drittanbietern"]],
  sp: [["sp.freigabe", "Freigabe-Einstellungen des Mandanten"], ["sp.sites", "Sites"], ["sp.gruppen", "Microsoft 365-Gruppen: Besitzer und Mitglieder"], ["sp.onedrive", "OneDrive"], ["sp.extern", "Externe Personen"]]
};
const CHAPTERS = [
  ["zweck", "Zweck und Grundlage"], ["ueberblick", "Überblick"], ["konten", "Konten, Rollen, Lizenzen und Gäste"], ["anm", "Anmeldung und bedingter Zugriff"],
  ["ger", "Geräte und Intune"], ["mail", "E-Mail"], ["apps", "Anwendungen und Freigaben"], ["sp", "SharePoint, OneDrive und Teams"],
  ["abw", "Abweichungen und Hinweise"], ["aend", "Änderungen"], ["freigabe", "Freigabe"]
];

/**
 * Nummern je Kapitel-Schlüssel. opts.kapitel9: "haupt" | "anhang" | "weg";
 * opts.changes: Kapitel Änderungen vorhanden; opts.hasOtherPlatforms.
 */
function numbering(opts) {
  opts = opts || {};
  const k9 = opts.kapitel9 || "haupt";
  const n = {}, titles = {};
  let i = 0;
  const main = [];
  for (const [key, title] of CHAPTERS) {
    if (key === "abw" && k9 !== "haupt") continue;
    if (key === "aend" && !opts.changes) continue;
    i++;
    n[key] = String(i); titles[key] = title; main.push(key);
    let j = 0;
    for (const [sk, st] of SUBS[key] || []) {
      if (sk === "ger.weitere" && !opts.hasOtherPlatforms) continue;
      j++; n[sk] = `${i}.${j}`; titles[sk] = st;
    }
  }
  if (k9 === "anhang") { n.abw = "A"; titles.abw = "Abweichungen und Hinweise"; }
  const ref = keys => (Array.isArray(keys) ? keys : [keys]).map(k => n[k]).filter(Boolean).join(", ");
  return { n, titles, main, appendix: k9 === "anhang" ? ["abw"] : [], ref, k9 };
}

// ============================================================== Bedingter Zugriff
const STATE_LABEL = { enabled: "scharf", enabledForReportingButNotEnforced: "Nur Bericht", disabled: "aus" };

/** Wirkung einer Richtlinie: { kind: wirksam|bericht|aus|keine, label, tone, reason } */
function caEffect(p, groupsById) {
  if (p.state === "disabled") return { kind: "aus", label: "aus", tone: "na" };
  if (p.state === "enabledForReportingButNotEnforced") return { kind: "bericht", label: "Nur Bericht", tone: "nt" };
  const r = p.raw || {};
  const apps = r.includeApplications || [];
  if ((!apps.length || (apps.length === 1 && apps[0] === "None")) && !(r.includeUserActions || []).length && !(r.includeAuthContext || []).length) {
    return { kind: "keine", label: "keine: keine App gewählt", tone: "open", reason: "keine App gewählt" };
  }
  if (p.scope && p.scope.effective === 0) {
    const inc = (r.includeGroups || []).map(id => groupsById.get(id)).filter(Boolean);
    const broad = (r.includeUsers || []).some(x => x === "All" || x === "GuestsOrExternalUsers") || r.includeGuests || (r.includeRoles || []).length;
    let reason = "niemand erfasst";
    if (!broad && inc.length && inc.every(g => g.userCount === 0 && g.deviceCount > 0)) reason = "Gruppe enthält nur Geräte";
    else if (!broad && inc.length && inc.every(g => g.userCount === 0)) reason = inc.some(g => g.missing) ? "Gruppe gelöscht" : "Gruppe ohne Mitglieder";
    else if ((r.includeRoles || []).length && !inc.length) reason = "Rolle ohne Inhaber";
    else if (p.scope.included > 0) reason = "alle Erfassten ausgenommen";
    return { kind: "keine", label: "keine: " + reason, tone: "open", reason };
  }
  return { kind: "wirksam", label: "wirksam", tone: "ok" };
}

function caKey(p) {
  const m = String(p.name || "").match(/^(\d{2,4})\b/);
  return m ? [0, Number(m[1]), p.name] : [1, 0, p.name];
}
function sortCa(list) {
  return [...list].sort((a, b) => { const x = caKey(a), y = caKey(b); return x[0] - y[0] || x[1] - y[1] || String(x[2]).localeCompare(String(y[2])); });
}

/** Richtlinien, die MFA für alle Benutzer und alle Apps verlangen (scharf). */
function mfaForAll(policies) {
  return (policies || []).filter(p => p.state === "enabled" && p.raw && (p.raw.includeUsers || []).includes("All") &&
    ((p.raw.includeApplications || []).includes("All") || (p.raw.includeApplications || []).includes("Office365")) &&
    ((p.raw.grant || []).includes("mfa") || p.raw.authStrength) && !(p.raw.grant || []).includes("block"));
}

// ============================================================== E-Mail: welche Richtlinie wirkt
const ACTION_LABEL = {
  MoveToJmf: "Junk-E-Mail-Ordner", Quarantine: "Quarantäne", Delete: "löschen", Redirect: "umleiten", AddXHeader: "X-Header ergänzen",
  ModifySubject: "Betreff ändern", NoAction: "keine Aktion", Block: "blockieren", Replace: "Anlage ersetzen", DynamicDelivery: "dynamische Zustellung", Allow: "zulassen"
};
const TAG_LABEL = {
  DefaultFullAccessPolicy: "Empfänger gibt selbst frei (Microsoft-Standard)",
  DefaultFullAccessWithNotificationPolicy: "Empfänger gibt selbst frei, mit Benachrichtigung",
  AdminOnlyAccessPolicy: "nur die Administration gibt frei",
  AdminOnlyWithNotificationPolicy: "nur die Administration gibt frei, mit Benachrichtigung"
};
function tagText(tag, quarantine) {
  if (!tag) return "—";
  if (TAG_LABEL[tag]) return `${tag}: ${TAG_LABEL[tag]}`;
  const q = (quarantine || []).find(x => norm(x.name) === norm(tag));
  if (!q) return tag;
  const v = Number(q.permsValue) || 0;
  const how = (v & 32) ? "Empfänger gibt selbst frei" : (v & 16) ? "Freigabe nur auf Anfrage, freigegeben wird durch die Administration" : "nur die Administration gibt frei";
  return `${tag}: ${how}${q.esn ? ", mit Benachrichtigung" : ""}`;
}
function actionText(a) { return a ? (ACTION_LABEL[a] || a) : "—"; }

/** Gilt eine Regel für die Domain? full | partial | null */
function ruleCovers(rule, domain) {
  if (!rule || norm(rule.state) !== "enabled") return null;
  const d = norm(domain);
  if ((rule.exceptDomains || []).map(norm).includes(d)) return null;
  const doms = (rule.domains || []).map(norm);
  if (doms.includes(d)) return (rule.exceptUsers || []).length || (rule.exceptGroups || []).length ? "partial" : "full";
  if (!doms.length && ((rule.users || []).length || (rule.groups || []).length)) return "partial";
  if (!doms.length && !(rule.users || []).length && !(rule.groups || []).length) return "full";
  return null;
}

/**
 * Je Domain und Schutzart die wirksame Richtlinie nach der Vorrangregel von Microsoft:
 * Voreinstellung Streng > Standard > eigene Regeln (Priorität) > Standardrichtlinie
 * bzw. integrierter Schutz (Safe Links/Attachments).
 */
function mailEffective(exo) {
  if (!exo) return null;
  const domains = (exo.domains || []).map(d => d.name).filter(Boolean);
  const presetEop = exo.eopPreset || [], presetAtp = exo.atpPreset || [];
  const strict = arr => arr.find(r => /strict/i.test(r.name || r.identity || ""));
  const standard = arr => arr.find(r => /standard/i.test(r.name || r.identity || ""));
  const kinds = [
    { key: "spam", label: "Anti-Spam", rules: exo.spamRules || [], policyField: "spamPolicy", ruleField: "policy", policies: exo.spamPolicies || [], preset: presetEop },
    { key: "malware", label: "Anti-Malware", rules: exo.malwareRules || [], policyField: "malwarePolicy", ruleField: "policy", policies: exo.malwarePolicies || [], preset: presetEop },
    { key: "phish", label: "Anti-Phishing", rules: exo.phishRules || [], policyField: "phishPolicy", ruleField: "policy", policies: exo.phishPolicies || [], preset: presetEop },
    { key: "safeLinks", label: "Safe Links", rules: exo.safeLinksRules || [], policyField: "safeLinksPolicy", ruleField: "policy", policies: exo.safeLinks || [], preset: presetAtp, atp: true },
    { key: "safeAttach", label: "Safe Attachments", rules: exo.safeAttachRules || [], policyField: "safeAttachmentPolicy", ruleField: "policy", policies: exo.safeAttach || [], preset: presetAtp, atp: true }
  ];
  const builtIn = (exo.builtIn || [])[0] || null;
  const result = [];
  const shadowed = [];
  for (const k of kinds) {
    const chain = [];
    const s = strict(k.preset), st = standard(k.preset);
    if (s) chain.push({ rule: s, via: "Voreinstellung «Streng»", policy: s[k.policyField], preset: "Streng" });
    if (st) chain.push({ rule: st, via: "Voreinstellung «Standard»", policy: st[k.policyField], preset: "Standard" });
    for (const r of [...k.rules].sort((a, b) => (a.priority || 0) - (b.priority || 0))) chain.push({ rule: r, via: `eigene Regel «${r.name}» (Priorität ${r.priority})`, policy: r[k.ruleField] });
    const def = k.atp ? null : (k.policies.find(p => p.isDefault) || null);
    const perDomain = domains.map(d => {
      const partial = [];
      for (const c of chain) {
        const cov = ruleCovers(c.rule, d);
        if (cov === "full") return { domain: d, policy: c.policy, via: c.via, preset: c.preset || null, partial };
        if (cov === "partial") partial.push({ policy: c.policy, via: c.via });
      }
      if (k.atp) {
        if (builtIn && norm(builtIn.state) !== "disabled" && !(builtIn.exceptDomains || []).map(norm).includes(norm(d))) return { domain: d, policy: "Built-In Protection Policy", via: "integrierter Schutz von Microsoft", builtIn: true, partial };
        return { domain: d, policy: null, via: "keine Richtlinie", partial };
      }
      return { domain: d, policy: def ? def.name : "Default", via: "Standardrichtlinie (Default)", isDefault: true, partial };
    });
    // Eigene Regeln, die für keine ihrer Domains zum Zug kommen, weil eine Voreinstellung Vorrang hat.
    for (const r of k.rules) {
      if (norm(r.state) !== "enabled") continue;
      const doms = (r.domains || []).length ? r.domains : domains;
      const winners = doms.map(d => perDomain.find(x => norm(x.domain) === norm(d))).filter(Boolean);
      if (winners.length && winners.every(w => w.preset && norm(w.policy) !== norm(r.policy))) {
        shadowed.push({ kind: k.label, rule: r.name, policy: r.policy, by: [...new Set(winners.map(w => w.via))].join(", "), domains: doms });
      }
    }
    result.push({ key: k.key, label: k.label, perDomain, available: !k.atp || k.policies.length > 0 || !!builtIn || k.rules.length > 0 });
  }
  const presets = [];
  for (const [label, rs] of [["EOP", presetEop], ["Defender", presetAtp]]) {
    for (const r of rs) presets.push({ area: label, name: r.name || r.identity, state: r.state, domains: r.domains || [], users: r.users || [], groups: r.groups || [] });
  }
  return { domains, kinds: result, shadowed, presets };
}

// ============================================================== Hilfen
const DAY = 864e5;
function days(iso) { return iso ? Math.floor((Date.now() - new Date(iso).getTime()) / DAY) : null; }
function listNames(arr, max) {
  const a = (arr || []).filter(Boolean);
  if (!a.length) return "";
  const m = max || 12;
  return a.slice(0, m).join(", ") + (a.length > m ? ` und ${a.length - m} weitere` : "");
}
function localPart(upn) { const s = String(upn || ""); return s.includes("@") ? s.split("@")[0] + "@" : s; }
const GLOBAL_ADMIN = "62e90394-69f5-4237-9190-012177145e10";
const PRIVILEGED_RE = /Administrator|Administrator:in|Admin$/i;

function globalAdmins(identity) {
  const roles = (identity && identity.roles) || [];
  const out = new Map();
  for (const r of roles.filter(x => x.templateId === GLOBAL_ADMIN && x.how !== "berechtigt (PIM)")) {
    if (r.principalType === "user") out.set(norm(r.principal), r.principal);
    if (r.principalType === "group") for (const m of r.members || []) out.set(norm(m), m);
  }
  return [...out.values()].sort((a, b) => a.localeCompare(b));
}
/** Kapitel, in dem ein Registereintrag zum Objekt steht (Gruppen und Intune je nach Fundort). */
function refFor(e, S) {
  const id = norm(e.objectId), name = norm(e.objectName);
  const hit = list => (list || []).some(x => (id && norm(x.id) === id) || (!id && name && norm(x.name || x.displayName) === name));
  if (e.objectType === "gruppe") {
    if (hit(S.devices && S.devices.groups)) return "ger.gruppen";
    if (hit(S.ca && S.ca.groups)) return "anm.gruppen";
    return "sp.gruppen";
  }
  if (e.objectType === "intune") {
    const p = ((S.intune && S.intune.policies) || []).find(x => (id && norm(x.id) === id) || norm(x.name) === name);
    if (!p) return "ger";
    if (p.source === "deviceCompliancePolicies") return "ger.konform";
    return p.platform === "macOS" ? "ger.mac" : p.platform === "Windows" ? "ger.win" : "ger.weitere";
  }
  return null;
}
function joinDe(list) { const a = (list || []).filter(Boolean); return a.length <= 1 ? (a[0] || "") : a.slice(0, -1).join(", ") + " und " + a[a.length - 1]; }
/**
 * Administrationskonten im Sinn «eigenes Konto für die Verwaltung»: privilegierte Rolle
 * und entweder ohne Lizenz, mit Admin-Namen oder im Register als Admin-/Notfallkonto.
 * Persönliche Konten mit Admin-Rolle (z. B. die Geschäftsleitung) zählen nicht dazu.
 */
function adminAccounts(identity, L) {
  const priv = privilegedUpns(identity);
  const users = new Map(((identity && identity.users) || []).map(u => [norm(u.upn), u]));
  const out = new Set();
  for (const upn of priv) {
    const u = users.get(upn);
    const r = L ? L.account(upn) : null;
    if ((u && !(u.licenses || []).length) || /(^|[._-])(adm|admin|administrator|emergency|notfall|breakglass|brk)([._-]|\d|@|$)/i.test(upn) || (r && /admin|breakglass/.test(r.kind))) out.add(upn);
  }
  return out;
}
function privilegedUpns(identity) {
  const s = new Set();
  for (const r of (identity && identity.roles) || []) {
    if (r.how === "berechtigt (PIM)") continue;
    if (!/Administrator/i.test(r.role)) continue;
    if (r.principalType === "user") s.add(norm(r.principal));
    if (r.principalType === "group") for (const m of r.members || []) s.add(norm(m));
  }
  return s;
}

// ============================================================== Hinweise (Kapitel 9)
/**
 * Regelbasierte Feststellungen. Jede beschreibt den Zustand, nicht die Massnahme.
 * Rückgabe: [{ id, text, ref: [kapitel], source: "regel"|"register", entryId? }]
 */
function hints(ds, register, opts) {
  const S = (ds && ds.sections) || {};
  const L = createLookup(register);
  const out = [];
  const add = (id, text, ref, extra) => out.push({ id, text, ref: Array.isArray(ref) ? ref : [ref], source: "regel", ...(extra || {}) });
  const I = S.identity, CA = S.ca, D = S.devices, IN = S.intune, M = S.mail, A = S.apps, SP = S.sharepoint;
  const groupsById = new Map(((CA && CA.groups) || []).map(g => [g.id, g]));

  // --- Bedingter Zugriff
  if (CA && CA.policies) {
    const pol = sortCa(CA.policies);
    const rep = pol.filter(p => p.state === "enabledForReportingButNotEnforced");
    if (rep.length) add("ca-bericht", `${rep.length === 1 ? "Eine Richtlinie läuft" : rep.length + " Richtlinien laufen"} im Modus «Nur Bericht» und wirken nicht: ${listNames(rep.map(p => p.name), 20)}.` +
      (rep.some(p => L.of("ca", p.id, p.name).length) ? " Begründungen stehen unter der jeweiligen Richtlinie." : ""), "anm.ca");
    const none = pol.map(p => ({ p, e: caEffect(p, groupsById) })).filter(x => x.e.kind === "keine");
    if (none.length) add("ca-ohne-wirkung", `${none.length === 1 ? "Eine eingeschaltete Richtlinie ist" : none.length + " eingeschaltete Richtlinien sind"} ohne Wirkung: ` +
      none.map(x => `${x.p.name} (${x.e.reason})`).join("; ") + ".", "anm.ca");
    const off = pol.filter(p => p.state === "disabled");
    if (off.length) add("ca-aus", `${off.length === 1 ? "Eine Richtlinie ist" : off.length + " Richtlinien sind"} ausgeschaltet: ${listNames(off.map(p => p.name), 15)}.`, "anm.ca");
    const mfa = mfaForAll(CA.policies);
    if (mfa.length) {
      const ex = new Map();
      for (const p of mfa) {
        for (const u of p.excludedUsers || []) ex.set(norm(u.upn), u.upn);
      }
      if (ex.size) {
        const names = [...ex.values()].sort().map(u => {
          const r = L.account(u);
          return r ? `${u} (${r.kindLabel || "Register"}: ${purp(r)}${r.validUntil ? ", bis " + fmtDay(r.validUntil) : ", ohne Ablauf"})` : u;
        });
        add("mfa-ausnahmen", `Von der MFA-Pflicht für alle Benutzer ${ex.size === 1 ? "ist ein Konto" : `sind ${ex.size} Konten`} ausgenommen: ${names.join("; ")}.`, ["anm.gruppen"]);
      }
    } else if (I && I.securityDefaults === false) {
      add("mfa-keine", "Keine eingeschaltete Richtlinie verlangt MFA für alle Benutzer und alle Apps, und die Sicherheitsstandards sind ausgeschaltet.", ["anm.methoden", "anm.ca"]);
    }
  }

  // --- Konten
  if (I) {
    const ga = globalAdmins(I);
    if (ga.length) {
      const users = new Map((I.users || []).map(u => [norm(u.upn), u]));
      const neverOrNew = ga.map(u => users.get(norm(u))).filter(Boolean).filter(u => u.signInKnown && !u.lastSuccess && !u.lastSignIn)
        .map(u => `${u.upn} (angelegt ${fmtDay(u.created)}, noch nie angemeldet)`);
      add("ga", `${ga.length === 1 ? "Ein Konto trägt" : ga.length + " Konten tragen"} die Rolle Globaler Administrator: ${ga.join(", ")}.` + (neverOrNew.length ? ` ${neverOrNew.join("; ")}.` : ""), "konten.rollen");
    }
    if (I.mfaAvailable) {
      const no = (I.users || []).filter(u => u.type === "Member" && u.enabled && u.mfaRegistered === false && (u.licenses || []).length);
      // Ressourcenkonten der Telefonie (nur virtuelle Lizenz) melden sich nicht an — nicht mitzählen.
      const resource = u => (u.licenses || []).length && u.licenses.every(l => /VIRTUALUSER|MCOPSTN|PHONESYSTEM_VIRTUAL/i.test(l));
      const no2 = no.filter(u => !resource(u));
      if (no2.length) add("ohne-mfa", `${no2.length === 1 ? "Ein lizenziertes Konto hat" : no2.length + " lizenzierte Konten haben"} keine MFA-Methode registriert: ${no2.slice(0, 12).map(u => { const r = L.account(u.upn); return r ? `${u.upn} (${r.kindLabel}: ${purp(r)})` : u.upn; }).join("; ")}${no2.length > 12 ? " und weitere" : ""}.`, ["konten.intern", "anm.methoden"]);
    }
    const am = I.authMethods;
    if (am) {
      const on = am.methods.filter(m => m.state === "enabled").map(m => m.label);
      const auth = am.methods.find(m => norm(m.id) === "microsoftauthenticator");
      const parts = [];
      if (am.migrationState && am.migrationState !== "migrationComplete") parts.push(`Die Migration der Richtlinie für Anmeldemethoden ist nicht abgeschlossen (${am.migrationState}); zusätzlich gelten die älteren MFA- und SSPR-Einstellungen`);
      if (auth && auth.state !== "enabled") parts.push(`In der Richtlinie für Anmeldemethoden ist Microsoft Authenticator deaktiviert; aktiviert sind ${on.length ? on.join(", ") : "keine Methoden"}`);
      if (parts.length) add("anmeldemethoden", parts.join(". ") + ".", "anm.methoden");
    }
    const guests = (I.users || []).filter(u => u.type === "Guest");
    if (guests.length && I.signInAvailable) {
      const sp = SP && SP.sites ? SP.sites : [];
      const inactive = guests.filter(u => { const d = days(u.lastSuccess || u.lastSignIn); return d === null ? (days(u.created) || 0) > 90 : d > 180; });
      if (inactive.length) {
        const gtxt = inactive.slice(0, 12).map(u => {
          const addr = u.mail || u.upn;
          const inGroups = sp.filter(s => s.group && (s.group.members || []).some(m => norm(m.id) === norm(u.id))).map(s => s.group.displayName);
          const last = u.lastSuccess || u.lastSignIn;
          return `${addr} (${last ? "zuletzt angemeldet " + fmtDay(last) : "nie angemeldet, eingeladen " + fmtDay(u.created)}${inGroups.length ? "; Mitglied von «" + inGroups.join("», «") + "»" : ""})`;
        });
        add("gaeste-inaktiv", `${inactive.length === 1 ? "Ein Gast hat" : inactive.length + " Gäste haben"} sich seit über 180 Tagen nicht angemeldet: ${gtxt.join("; ")}${inactive.length > 12 ? " und weitere" : ""}.`, ["konten.gaeste", "sp.gruppen"]);
      }
    }
    // Register: abgelaufen, aber aktiv
    for (const r of L.accounts) {
      const u = (I.users || []).find(x => norm(x.upn) === norm(r.upn));
      if (r.validUntil && r.validUntil < new Date().toISOString().slice(0, 10) && u && u.enabled) {
        add("register-abgelaufen-" + r.id, `Das Konto ${r.upn} (${r.kindLabel}: ${purp(r)}) war laut Register bis ${fmtDay(r.validUntil)} vorgesehen und ist weiterhin aktiv.`, "konten.intern");
      }
    }
  }

  // --- Geräte und Intune
  if (D) {
    const nc = (D.intune || []).filter(d => d.compliance && d.compliance !== "compliant");
    if (nc.length) add("geraete-nicht-konform", `${nc.length === 1 ? "Ein Gerät ist" : nc.length + " Geräte sind"} nicht konform: ${nc.map(d => `${d.name} (${complianceLabel(d.compliance)})`).join(", ")}.`, "ger.geraete");
    if (D.entra) {
      const ids = new Set((D.intune || []).map(d => norm(d.entraId)).filter(Boolean));
      const only = D.entra.filter(d => !ids.has(norm(d.deviceId)) && !/ios|android/i.test(d.os || ""));
      const stale = only.filter(d => (days(d.lastSignIn) || 9999) > 180);
      if (stale.length) add("geraete-entra-alt", `${stale.length} Einträge in Entra ID ohne Intune-Verwaltung sind seit über 180 Tagen nicht mehr aktiv (${listNames(stale.map(d => d.name), 10)}).`, "ger.geraete");
    }
  }
  if (IN && IN.policies) {
    const unassigned = IN.policies.filter(p => !p.assignments.some(a => !a.exclude));
    if (unassigned.length) add("intune-nicht-zugewiesen", `${unassigned.length === 1 ? "Eine Intune-Richtlinie ist" : unassigned.length + " Intune-Richtlinien sind"} keiner Gruppe zugewiesen und wirken nicht: ${listNames(unassigned.map(p => p.name), 15)}.`, ["ger.win", "ger.mac"]);
    // Mehrere Update-Ringe an derselben Gruppe
    const rings = IN.policies.filter(p => /windowsUpdateForBusinessConfiguration/i.test(p.odataType || ""));
    const byGroup = new Map();
    for (const p of rings) for (const a of p.assignments) if (!a.exclude && a.group) { if (!byGroup.has(a.group.name)) byGroup.set(a.group.name, []); byGroup.get(a.group.name).push(p.name); }
    for (const [g, list] of byGroup) if (list.length > 1) add("update-ringe-" + g, `Der Gruppe ${g} sind ${list.length} Update-Ringe zugewiesen: ${list.join(", ")}. Welcher Wert gilt, entscheidet Intune je Einstellung als Konflikt.`, "ger.win");
  }

  // --- E-Mail
  if (M && M.exo) {
    const eff = mailEffective(M.exo);
    if (eff && eff.shadowed.length) {
      const byRule = new Map();
      for (const s of eff.shadowed) { const k = s.by; if (!byRule.has(k)) byRule.set(k, []); byRule.get(k).push(`${s.policy} (${s.kind})`); }
      for (const [by, list] of byRule) {
        add("mail-vorrang", `Die ${by} hat nach der Vorrangregel von Microsoft Vorrang vor den eigenen Richtlinien ${list.join(", ")}; diese wirken für die betroffenen Domains nicht.`, "mail.schutz");
      }
    }
    if (eff) {
      const onlyDefault = eff.kinds.filter(k => ["spam", "malware", "phish"].includes(k.key)).flatMap(k => k.perDomain.filter(x => x.isDefault).map(x => `${k.label} für ${x.domain}`));
      if (onlyDefault.length) add("mail-standard", `Es wirkt nur die Microsoft-Standardrichtlinie (Default): ${listNames(onlyDefault, 10)}.`, "mail.schutz");
    }
    const tc = (M.exo.transportConfig || [])[0];
    const smtpOn = (M.exo.cas || []).filter(c => c.smtpAuth === false).map(c => c.smtp);
    if (tc && tc.smtpAuthDisabled === false) add("smtp-auth", "SMTP AUTH ist auf Organisationsebene eingeschaltet.", "mail.weitere");
    else if (smtpOn.length) add("smtp-auth", `SMTP AUTH ist auf Organisationsebene aus, für ${smtpOn.length === 1 ? "ein Postfach" : smtpOn.length + " Postfächer"} einzeln freigegeben: ${listNames(smtpOn, 10)}.`, "mail.weitere");
    const fwd = (M.exo.mailboxes || []).filter(m => m.fwdSmtp);
    if (fwd.length) add("weiterleitung", `${fwd.length === 1 ? "Ein Postfach leitet" : fwd.length + " Postfächer leiten"} an eine externe Adresse weiter: ${fwd.map(m => `${m.smtp} → ${String(m.fwdSmtp).replace(/^smtp:/i, "")}`).join(", ")}.`, "mail.weitere");
    const ob = (M.exo.outbound || []).find(o => o.isDefault) || (M.exo.outbound || [])[0];
    if (ob && norm(ob.autoForward) === "on") add("weiterleitung-erlaubt", "Die automatische Weiterleitung nach extern ist in der ausgehenden Spamrichtlinie ausdrücklich erlaubt.", "mail.weitere");
    const ad = (M.exo.adminAudit || [])[0], oc = (M.exo.orgConfig || [])[0];
    if ((ad && ad.unified === false) || (oc && oc.auditDisabled)) add("protokoll", [ad && ad.unified === false ? "Das einheitliche Überwachungsprotokoll ist ausgeschaltet" : null, oc && oc.auditDisabled ? "die Postfach-Überwachung ist organisationsweit ausgeschaltet" : null].filter(Boolean).join("; ") + ".", "mail.weitere");
  }
  if (M && M.dns && M.dns.length) {
    for (const x of M.dns.filter(d => !/\.onmicrosoft\.com$/i.test(d.domain))) {
      const bits = [];
      if (!x.dmarc || !x.dmarc.record) bits.push("kein DMARC-Eintrag");
      else if (x.dmarc.policy === "none") bits.push(`DMARC steht auf p=none${/rua=/i.test(x.dmarc.record) ? "" : " ohne Berichtsadresse"}`);
      if (!x.spf || !x.spf.record) bits.push("kein SPF-Eintrag");
      else if (x.spf.lookupLimitExceeded) bits.push(`SPF überschreitet das Limit von 10 DNS-Abfragen (${x.spf.lookups})`);
      else if (/\?all|\+all/i.test(x.spf.record)) bits.push("SPF endet ohne Schutzwirkung (?all/+all)");
      if (x.dkim && !x.dkim.enabledInM365) bits.push("DKIM-Signierung nicht aktiv");
      else if (x.dkim && !x.dkim.cnamesPublished) bits.push("DKIM aktiv, CNAME-Einträge fehlen im DNS");
      if (bits.length) add("dns-" + x.domain, `${x.domain}: ${bits.join("; ")}.`, "mail.dns");
    }
  }

  // --- Anwendungen
  if (I && I.authz) {
    const userConsent = (I.authz.permissionGrantPoliciesAssigned || []).filter(x => /microsoft-user-default|ManagePermissionGrantsForSelf/i.test(x));
    const bits = [];
    if (I.adminConsent && !I.adminConsent.enabled) bits.push("Der Workflow für Administratorzustimmung ist aus");
    if (userConsent.length) bits.push(userConsent.some(x => /legacy/i.test(x)) ? "Benutzer dürfen allen Apps selbst zustimmen" : "Benutzer dürfen Apps mit geringen Berechtigungen selbst zustimmen");
    if (I.authz.allowedToCreateApps) bits.push("Benutzer dürfen App-Registrierungen anlegen");
    if (bits.length) add("zustimmung", bits.join("; ") + ".", "apps.einst");
  }
  if (A) {
    const wide = grantRows(A).filter(g => g.orgWide && g.write);
    if (wide.length) add("freigaben", `Organisationsweite Freigaben mit Schreibrechten: ${wide.map(g => `${g.client} (${g.scopes.filter(s => WRITE_RE.test(s)).slice(0, 5).join(", ")}${g.scopes.filter(s => WRITE_RE.test(s)).length > 5 ? " …" : ""})`).join("; ")}.`, "apps.freigaben");
    const now = Date.now();
    const exp = [];
    for (const r of A.registrations || []) {
      for (const c of [...r.secrets.map(x => ({ ...x, k: "Geheimnis" })), ...r.certs.map(x => ({ ...x, k: "Zertifikat" }))]) {
        if (!c.end) continue;
        const t = new Date(c.end).getTime();
        if (t < now) exp.push(`${r.name}: ${c.k} abgelaufen am ${fmtDay(c.end)}`);
        else if (t - now < 30 * DAY) exp.push(`${r.name}: ${c.k} läuft am ${fmtDay(c.end)} ab`);
      }
    }
    if (exp.length) add("anmeldedaten", `Anmeldedaten von App-Registrierungen: ${exp.join("; ")}.`, "apps.reg");
  }

  // --- SharePoint
  if (SP && SP.sites) {
    const gs = SP.sites.filter(s => s.group);
    const noOwner = gs.filter(s => s.group.ownerCount === 0).map(s => s.group.displayName);
    if (noOwner.length) add("sp-ohne-besitzer", `${noOwner.length === 1 ? "Die Gruppe «" + noOwner[0] + "» hat" : "Die Gruppen " + joinDe(noOwner.map(x => "«" + x + "»")) + " haben"} keinen Besitzer; Mitglieder und Einstellungen lassen sich nur über die Administration ändern.`, "sp.gruppen");
    const priv = adminAccounts(I, L);
    if (priv.size) {
      const hit = new Map();
      for (const s of gs) for (const m of [...(s.group.owners || []), ...(s.group.members || [])]) {
        if (m.upn && priv.has(norm(m.upn))) { if (!hit.has(m.upn)) hit.set(m.upn, new Set()); hit.get(m.upn).add(s.group.displayName); }
      }
      if (hit.size) add("sp-admins", `Administrationskonten sind Besitzer oder Mitglied von Microsoft 365-Gruppen und haben damit Zugriff auf deren Dateien: ${[...hit.entries()].map(([u, g]) => `${localPart(u)} in ${[...g].sort().join(", ")}`).join("; ")}.`, ["sp.gruppen", "konten.rollen"]);
    }
    const raw = SP.settings && SP.settings.raw;
    if (raw && raw.sharingCapability && raw.sharingCapability !== "disabled") {
      const bits = [`Externe Freigabe: ${SP.settings.sharing.label}`];
      if (raw.isResharingByExternalUsersEnabled) bits.push("Gäste dürfen weiterteilen");
      if (raw.sharingDomainRestrictionMode === "none") bits.push("keine Einschränkung auf bestimmte Domains");
      const guests = I ? (I.users || []).filter(u => u.type === "Guest").length : null;
      add("sp-freigabe", bits.join("; ") + (guests !== null ? `. ${guests} Gastkonten in Entra ID.` : "."), ["sp.freigabe", "sp.extern"]);
    }
  }

  // --- Register: bewusste Entscheide und allgemeine Hinweise
  for (const e of L.decisions()) {
    const t = OBJECT_TYPES[e.objectType] || {};
    out.push({ id: "register-" + e.id, source: "register", entryId: e.id, decision: true,
      text: `Bewusster Entscheid${e.objectName ? " zu «" + e.objectName + "»" : ""}: ${e.text}`, ref: e.ref ? [] : [refFor(e, S) || t.chapter].filter(Boolean), refText: e.ref || null });
  }
  for (const e of L.general()) {
    out.push({ id: "register-" + e.id, source: "register", entryId: e.id, decision: !!e.decision, text: (e.decision ? "Bewusster Entscheid: " : "") + e.text, ref: e.ref ? [] : ["abw"], refText: e.ref || null });
  }
  return out;
}

// ============================================================== Anwendungen
const WRITE_RE = /ReadWrite|\.Send|FullControl|full_access|Manage|AccessAsUser|RoleManagement|\.Write/i;
function grantRows(A) {
  const rows = [];
  for (const g of (A && A.grants) || []) {
    if (g.microsoft) continue;
    const scopes = g.scopes.filter(s => !["openid", "profile", "email", "offline_access"].includes(s));
    if (!scopes.length) continue;
    const write = scopes.some(s => WRITE_RE.test(s));
    const broad = scopes.some(s => /\.All$/i.test(s));
    if (!write && !broad) continue;
    rows.push({ client: g.client, clientSpId: g.clientSpId, resource: g.resource, orgWide: g.consentType === "AllPrincipals", who: g.consentType === "AllPrincipals" ? "ganze Organisation" : "Benutzer " + (g.principal || "?"), scopes: scopes.sort(), write, kind: "delegiert" });
  }
  const byApp = new Map();
  for (const p of (A && A.appPermissions) || []) {
    const k = p.client + "|" + p.resource;
    if (!byApp.has(k)) byApp.set(k, { client: p.client, clientSpId: p.clientSpId, resource: p.resource, orgWide: true, who: "Anwendung (ohne Benutzer)", scopes: [], kind: "Anwendung" });
    byApp.get(k).scopes.push(p.permission);
  }
  for (const r of byApp.values()) {
    r.scopes.sort();
    r.write = r.scopes.some(s => WRITE_RE.test(s));
    if (r.write || r.scopes.some(s => /\.All$/i.test(s))) rows.push(r);
  }
  return rows.sort((a, b) => String(a.client).localeCompare(String(b.client)) || String(a.kind).localeCompare(String(b.kind)));
}

// ============================================================== Änderungen (Kapitel 10)
const AREA = [
  ["ca", "Bedingter Zugriff", e => /conditional access/i.test(e.activity) || /ConditionalAccess/i.test(e.category)],
  ["intune", "Intune", e => e.source === "Intune"],
  ["rollen", "Administrative Rollen", e => /role/i.test(e.activity) && /RoleManagement/i.test(e.category)],
  ["apps", "Anwendungen und Freigaben", e => /ApplicationManagement/i.test(e.category) || /consent|permission grant|service principal|application/i.test(e.activity)],
  ["gruppen", "Gruppen", e => /GroupManagement/i.test(e.category)],
  ["geraete", "Geräte in Entra ID", e => /Device/i.test(e.category) && /device/i.test(e.activity)],
  ["konten", "Konten", e => /UserManagement/i.test(e.category)],
  ["richtlinien", "Richtlinien in Entra ID", e => /Policy|Authentication/i.test(e.category) || /policy/i.test(e.activity)],
  ["sonst", "Weitere Änderungen", () => true]
];
// Vorgänge, die das Werkzeug als Rauschen ausblendet: Anmeldungen, automatische
// Aktualisierungen durch Microsoft-Dienste, Gerätestatus.
const NOISE = /^(Update user|Update device|Add registered (owner|users?) to device|Add device|Update StsRefreshTokenValidFrom Timestamp|Change user license|Update agreement|Update PasswordProfile|User registered security info|User started security info registration|User deleted security info|Update service principal|Update application)$/i;
const NOISE_ACTORS = /^(Microsoft Substrate Management|Device Registration Service|Microsoft Intune|MS-PIM|Azure AD Cloud Sync|Microsoft Office 365 Portal|Office 365 Exchange Online|Microsoft Online Services|Windows Azure Active Directory|Office365 Shell WCSS-Server|Microsoft Teams Services|Microsoft Approval Management|Signup|Managed Service Identity|AAD App Management|Microsoft Graph Change Tracking)$/i;

function isRelevant(e, opts) {
  if (!e) return false;
  if (/failure|fail/i.test(String(e.result || "")) && !/success/i.test(String(e.result || ""))) return false;
  if (e.source === "Intune") {
    if (/^(get|search|list)/i.test(e.operation || "")) return false;
    if (/sync|retire|wipe|reboot|locate|collect/i.test(e.activity || "") && !/policy|configuration/i.test(e.activity || "")) return false;
    return true;
  }
  if (NOISE_ACTORS.test(String(e.actor || "")) && !(opts && opts.includeServiceChanges)) return false;
  if (NOISE.test(String(e.activity || "").trim())) return false;
  return true;
}

function parseJson(s) {
  if (!s) return null;
  let v = s;
  for (let i = 0; i < 2 && typeof v === "string"; i++) { try { v = JSON.parse(v); } catch (e) { return null; } }
  // Entra schreibt Objekte teils als Liste mit einem Element ("[{...}]").
  if (Array.isArray(v) && v.length === 1 && v[0] && typeof v[0] === "object" && !Array.isArray(v[0])) v = v[0];
  return v && typeof v === "object" ? v : null;
}

/** Die Teile einer CA-Richtlinie, die in «vorher/nachher» vorkommen können. */
function caParts(obj, gname) {
  if (!obj) return null;
  const p = obj.conditions ? obj : (obj.policyDetail || obj);
  const u = (p.conditions && p.conditions.users) || {};
  const a = (p.conditions && p.conditions.applications) || {};
  const g = p.grantControls || {};
  const inc = [
    (u.includeUsers || []).includes("All") ? "alle Benutzer" : null,
    ...(u.includeGroups || []).map(id => "Gruppe " + gname(id)),
    (u.includeRoles || []).length ? `${u.includeRoles.length} Rollen` : null
  ].filter(Boolean);
  return {
    state: STATE_LABEL[p.state] || p.state || "",
    inc: inc.join(", "),
    exc: (u.excludeGroups || []).map(id => gname(id)).join(", "),
    apps: (a.includeApplications || []).join(", "),
    grant: ((g && g.builtInControls) || []).join(", ")
  };
}
function caSummary(obj, gname) {
  const x = caParts(obj, gname);
  return x ? [x.state, x.inc, x.exc ? "ohne " + x.exc : null].filter(Boolean).join(", ") : null;
}
/** Nur was sich geändert hat — sonst stünden alle Ausnahmegruppen doppelt in der Zeile. */
function caDiff(o, n, gname) {
  const a = caParts(o, gname), b = caParts(n, gname);
  if (!a || !b) return null;
  const L = { state: "", inc: "", exc: "ohne ", apps: "Apps ", grant: "verlangt " };
  const keys = Object.keys(L).filter(k => a[k] !== b[k]);
  if (!keys.length) return { vorher: a.state, nachher: a.state + ", geändert (weitere Einstellungen)" };
  // Der Zustand (scharf / Nur Bericht / aus) steht immer da — er ist die wichtigste Angabe.
  if (!keys.includes("state")) keys.unshift("state");
  const side = x => keys.map(k => (x[k] ? L[k] + x[k] : (k === "exc" ? "ohne Ausnahmegruppe" : "—"))).join(", ");
  return { vorher: side(a), nachher: side(b) };
}

function shortValFull(v) {
  if (v === null || v === undefined) return "";
  return String(v).replace(/^"+|"+$/g, "").replace(/\\"/g, "\"").trim();
}
function shortVal(v) {
  if (v === null || v === undefined || v === "") return "—";
  let s = String(v).replace(/^"+|"+$/g, "").replace(/\\"/g, "\"");
  const j = parseJson(v);
  if (Array.isArray(j)) s = j.map(x => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(", ");
  s = s.replace(/[\[\]]/g, "").trim();
  return s.length > 90 ? s.slice(0, 89) + "…" : (s || "—");
}

const PROP_SKIP = /^(LastModifiedDateTime|Version|Included Updated Properties|TargetId\.ServicePrincipalNames|Action Client Name|OtherTarget|DeviceOSType|DeviceTrustType|RoleDefinitionOriginId|RoleDefinitionOriginType|TemplateId|Role\.ObjectID|Role\.TemplateId|Role\.WellKnownObjectName|Group\.ObjectID|App.*Id|AppId|ServicePrincipal.*Id|MethodExecutionResult\.)/i;

/** Eine Änderung als Zeile: Objekt, vorher, nachher. */
function changeRow(e, gname) {
  const t = (e.targets || [])[0] || {};
  const act = String(e.activity || "");
  let objekt = t.name || "—", vorher = "—", nachher = "—";
  const typ = /conditional access/i.test(act) ? "Richtlinie für bedingten Zugriff" : (t.type || "");
  if (/conditional access policy/i.test(act)) {
    const ch = (t.changes || []).find(c => /ConditionalAccessPolicy/i.test(c.name)) || (t.changes || [])[0] || {};
    const o = parseJson(ch.old), n = parseJson(ch.new);
    if (o && o.displayName) objekt = o.displayName; else if (n && n.displayName) objekt = n.displayName;
    if (/^add/i.test(act)) { vorher = "—"; nachher = "neu" + (n ? ": " + caSummary(n, gname) : ""); }
    else if (/^delete/i.test(act)) { vorher = o ? caSummary(o, gname) : "vorhanden"; nachher = "gelöscht"; }
    else { const d = caDiff(o, n, gname); if (d) { vorher = d.vorher; nachher = d.nachher; } else { nachher = "geändert"; } }
  } else if (/permission grant|consent to application/i.test(act)) {
    // Delegierte Freigabe: Ziel 1 ist meist die Ressource (Microsoft Graph), Ziel 2 die App.
    const client = (e.targets || []).find(x => /ServicePrincipal/i.test(x.type || "") && x !== t) || null;
    objekt = client ? `${client.name} › ${t.name}` : t.name;
    const sc = (e.targets || []).flatMap(x => x.changes || []).find(c => /Scope/i.test(c.name || ""));
    if (sc) {
      const was = String(shortValFull(sc.old)).split(/\s+/).filter(Boolean), now = String(shortValFull(sc.new)).split(/\s+/).filter(Boolean);
      const added = now.filter(x => !was.includes(x)), removed = was.filter(x => !now.includes(x));
      vorher = was.length ? `${was.length} Berechtigungen` : "keine Freigabe";
      nachher = [added.length ? "ergänzt: " + added.join(", ") : null, removed.length ? "entfernt: " + removed.join(", ") : null].filter(Boolean).join("; ") || `${now.length} Berechtigungen`;
    } else nachher = /^remove/i.test(act) ? "entfernt" : "erteilt";
  } else if ((t.changes || []).some(c => /Assignment/i.test(c.name || "")) && !/^(delete|remove)/i.test(act)) {
    const ch = (t.changes || []).filter(c => /Assignment/i.test(c.name || ""));
    const ids = s => String(s || "").match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || [];
    const was = [...new Set(ch.flatMap(c => ids(c.old)))], now = [...new Set(ch.flatMap(c => ids(c.new)))];
    vorher = was.length ? "zugewiesen: " + was.map(gname).join(", ") : "nicht zugewiesen";
    nachher = now.length ? "zugewiesen: " + now.map(gname).join(", ") : "keine Zuweisung";
  } else if (/^(delete|remove)/i.test(act) || /^Delete/i.test(e.operation || "")) {
    vorher = /member|owner/i.test(act) ? "Mitglied" : "vorhanden";
    nachher = /member|owner/i.test(act) ? "entfernt" : "gelöscht";
    if (/member|owner/i.test(act) && (e.targets || []).length > 1) objekt = `${t.name} aus ${(e.targets[1] || {}).name || "?"}`;
  } else if (/^(add|create)/i.test(act) || /^Create/i.test(e.operation || "")) {
    vorher = "—";
    if (/member to (group|role)|owner to/i.test(act) && (e.targets || []).length > 1) { objekt = t.name; nachher = (/role/i.test(act) ? "Rolle " : /owner/i.test(act) ? "Besitzer von " : "Mitglied von ") + ((e.targets[1] || {}).name || "?"); }
    else if (/member to role/i.test(act)) { const r = (t.changes || []).find(c => /Role\.DisplayName/i.test(c.name)); nachher = "Rolle " + (r ? shortVal(r.new) : "?"); }
    else nachher = "neu";
  } else {
    const ch = (t.changes || []).filter(c => !PROP_SKIP.test(c.name || ""));
    if (ch.length) {
      vorher = ch.slice(0, 3).map(c => `${c.name}: ${shortVal(c.old)}`).join("; ") + (ch.length > 3 ? " …" : "");
      nachher = ch.slice(0, 3).map(c => `${c.name}: ${shortVal(c.new)}`).join("; ") + (ch.length > 3 ? ` … (${ch.length} Eigenschaften)` : "");
    } else { nachher = "geändert"; }
  }
  // Intune-Zuweisungen: Gruppen-Ids in Namen übersetzen
  const fix = s => String(s).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, m => gname(m));
  return { objekt, typ, vorher: fix(vorher), nachher: fix(nachher), activity: act, targetId: t.id || null };
}

/**
 * Änderungen gruppiert nach Tag und Bereich: [{ key, title, day, area, actors, rows: [...] }]
 * opts: { actor (Teilzeichenfolge), includeServiceChanges }
 */
function changeGroups(ds, register, opts) {
  const C = ds && ds.sections && ds.sections.changes;
  if (!C) return null;
  const L = createLookup(register);
  const gmap = new Map();
  const S = ds.sections;
  for (const g of (S.identity && S.identity.groups) || []) gmap.set(norm(g.id), g.name);
  for (const g of (S.ca && S.ca.groups) || []) gmap.set(norm(g.id), g.name);
  const gname = id => gmap.get(norm(id)) || id;
  const actor = norm(opts && opts.actor);
  const events = (C.events || []).filter(e => isRelevant(e, opts)).filter(e => !actor || norm(e.actor).includes(actor) || norm(e.app).includes(actor));
  const groups = new Map();
  for (const e of events.sort((a, b) => String(a.at).localeCompare(String(b.at)))) {
    const area = AREA.find(a => a[2](e));
    const day = zurichDay(e.at);
    const key = `aend-${day}-${area[0]}`;
    if (!groups.has(key)) groups.set(key, { key, day, area: area[0], title: `${area[1]}, ${fmtDay(day + "T12:00:00Z")}`, actors: new Map(), rows: [], first: e.at, last: e.at });
    const g = groups.get(key);
    g.last = e.at;
    g.actors.set(e.actor, (g.actors.get(e.actor) || 0) + 1);
    const r = changeRow(e, gname);
    // Begründung: zuerst ein Eintrag genau zu dieser Änderung, sonst der Kommentar
    // zum geänderten Objekt (über die Id, bei CA/Intune notfalls über den Namen).
    const own = e.id ? L.of("aenderung", e.id, null) : [];
    let any = own;
    if (!any.length) any = L.anyById(r.targetId);
    if (!any.length && area[0] === "ca") any = L.of("ca", null, r.objekt);
    if (!any.length && area[0] === "intune") any = L.of("intune", null, r.objekt);
    g.rows.push({ ...r, id: e.id || null, at: e.at, actor: e.actor, begruendung: commentText(any), begruendungFrom: own.length ? "aenderung" : any.length ? "objekt" : null });
  }
  return [...groups.values()].sort((a, b) => String(a.first).localeCompare(String(b.first))).map(g => ({
    ...g, actors: [...g.actors.entries()].sort((a, b) => b[1] - a[1]).map(([a, n]) => ({ actor: a, n })),
    intro: commentText(L.chapter(g.key))
  }));
}

// ============================================================== Objekte für die Register-Auswahl
function objectsForRegister(ds) {
  const S = (ds && ds.sections) || {};
  const out = { ca: [], intune: [], app: [], geraet: [], gruppe: [], site: [], mail: [], anwendung: [], aenderung: [], kapitel: [] };
  for (const p of (S.ca && S.ca.policies) || []) out.ca.push({ id: p.id, name: p.name });
  for (const p of (S.intune && S.intune.policies) || []) out.intune.push({ id: p.id, name: p.name, detail: p.platform });
  for (const a of (S.intune && S.intune.apps) || []) out.app.push({ id: a.id, name: a.name });
  for (const d of (S.devices && S.devices.intune) || []) out.geraet.push({ id: d.id, name: d.name, detail: d.user || "" });
  const seen = new Set();
  const addGroup = (id, name, detail) => { if (!id || seen.has(id)) return; seen.add(id); out.gruppe.push({ id, name, detail }); };
  for (const g of (S.ca && S.ca.groups) || []) addGroup(g.id, g.name, "bedingter Zugriff");
  for (const g of (S.devices && S.devices.groups) || []) addGroup(g.id, g.name, "Gerätegruppe");
  for (const s of (S.sharepoint && S.sharepoint.sites) || []) if (s.group) addGroup(s.group.id, s.group.displayName, "Microsoft 365-Gruppe");
  for (const s of (S.sharepoint && S.sharepoint.sites) || []) if (s.kind !== "system") out.site.push({ id: s.id, name: s.name, detail: s.path });
  const ex = S.mail && S.mail.exo;
  if (ex) {
    for (const k of ["spamPolicies", "malwarePolicies", "phishPolicies", "safeLinks", "safeAttach", "outbound"]) for (const p of ex[k] || []) out.mail.push({ id: p.name, name: p.name, detail: { spamPolicies: "Anti-Spam", malwarePolicies: "Anti-Malware", phishPolicies: "Anti-Phishing", safeLinks: "Safe Links", safeAttach: "Safe Attachments", outbound: "ausgehend" }[k] });
    for (const r of ex.eopPreset || []) out.mail.push({ id: r.name, name: r.name, detail: "Voreinstellung" });
    for (const r of ex.transportRules || []) out.mail.push({ id: r.name, name: r.name, detail: "Transportregel" });
  }
  const A = S.apps;
  if (A) {
    for (const a of A.thirdParty || []) out.anwendung.push({ id: a.id, name: a.name, detail: "Unternehmensanwendung" });
    for (const a of A.registrations || []) out.anwendung.push({ id: a.id, name: a.name, detail: "App-Registrierung" });
    for (const g of grantRows(A)) if (!out.anwendung.some(x => x.id === g.clientSpId)) out.anwendung.push({ id: g.clientSpId, name: g.client, detail: "Freigabe" });
  }
  const nb = numbering({ kapitel9: "haupt", changes: true, hasOtherPlatforms: true });
  for (const key of Object.keys(nb.titles)) if (!["zweck", "freigabe"].includes(key)) out.kapitel.push({ id: key, name: `${nb.n[key]} ${nb.titles[key]}` });
  for (const o of Object.values(out)) o.sort((a, b) => String(a.name).localeCompare(String(b.name), "de"));
  out.kapitel.sort((a, b) => a.name.localeCompare(b.name, "de", { numeric: true }));
  return out;
}

// ============================================================== Formate
const TZ = "Europe/Zurich";
function fmtDay(iso) {
  if (!iso) return "—";
  const s = String(iso);
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + "T12:00:00Z" : s);
  if (isNaN(d)) return "—";
  return d.toLocaleDateString("de-CH", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric" });
}
function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleTimeString("de-CH", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
}
function zurichDay(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "0000-00-00";
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  return p;
}
function complianceLabel(c) {
  return { compliant: "konform", noncompliant: "nicht konform", inGracePeriod: "Karenzzeit", unknown: "unbekannt", error: "Fehler", conflict: "Konflikt", configManager: "Configuration Manager" }[c] || c || "—";
}

/** Stand je Kapitel für die Oberfläche: automatisch, mit Register, Lücken. */
function chapterStatus(ds, register) {
  const S = (ds && ds.sections) || {};
  const L = createLookup(register);
  const gapsFor = re => (ds.gaps || []).filter(g => re.test(g)).length;
  const reg = types => L.all.filter(e => types.includes(e.objectType)).length;
  return [
    { key: "konten", title: "Konten, Rollen, Lizenzen, Gäste", auto: !!S.identity, register: L.accounts.length, gaps: gapsFor(/Konten|Rollen|Lizenzen|Anmeldung je Konto|MFA-Registrierung|Organisation/) },
    { key: "anm", title: "Anmeldung und bedingter Zugriff", auto: !!S.ca, register: reg(["ca"]), gaps: gapsFor(/Bedingter Zugriff|Anmeldemethoden|Sicherheitsstandards|Geräteregistrierung/), needs: "Kommentar je Richtlinie" },
    { key: "ger", title: "Geräte und Intune", auto: !!S.devices, register: reg(["intune", "app", "geraet"]), gaps: gapsFor(/Intune|Autopilot|Geräte/) },
    { key: "mail", title: "E-Mail", auto: !!(S.mail && S.mail.exo), register: reg(["mail"]), gaps: gapsFor(/Exchange|DNS|Security & Compliance|Warnungsrichtlinien/) },
    { key: "apps", title: "Anwendungen und Freigaben", auto: !!S.apps, register: reg(["anwendung"]), gaps: gapsFor(/Anwendung|Freigaben|App-Registrierungen|Autorisierungsrichtlinie|Administratorzustimmung/) },
    { key: "sp", title: "SharePoint, OneDrive und Teams", auto: !!S.sharepoint, register: reg(["site", "gruppe"]), gaps: gapsFor(/SharePoint/) },
    { key: "abw", title: "Abweichungen und Hinweise", auto: true, register: L.decisions().length + L.general().length, needs: "bewusste Entscheide" },
    { key: "aend", title: "Änderungen", auto: !!S.changes, register: reg(["aenderung"]), needs: "Begründung je Änderung" }
  ];
}

module.exports = {
  OBJECT_TYPES, CHAPTERS, SUBS, numbering, createLookup, commentText, objectEntries, accountEntries,
  caEffect, sortCa, mfaForAll, mailEffective, actionText, tagText, hints, grantRows, WRITE_RE,
  changeGroups, changeRow, isRelevant, objectsForRegister, chapterStatus, globalAdmins, privilegedUpns,
  fmtDay, fmtTime, zurichDay, complianceLabel, STATE_LABEL, listNames, localPart, days, adminAccounts, joinDe, refFor
};
