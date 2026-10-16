"use strict";
/**
 * Message Center × KI: was ist fuer DIESEN Kunden relevant — verstaendlich auf Deutsch.
 *
 * Die Regel-Einordnung in managedCollectors.js (Lizenzen, Plattformen, Geraete)
 * bleibt die Grundlage und filtert vor: Meldungen zu nicht lizenzierten
 * Diensten gehen gar nicht erst an die KI. Alles andere bewertet die KI vor
 * dem Kundenprofil — dem erhobenen Ist-Zustand plus der freien Kundennotiz
 * aus den Managed-Einstellungen («Treuhandbuero, 30 MA, Telefonie ueber Teams»).
 *
 * Ergebnis je Meldung (m.ai):
 *   art       handeln | chance | info | nicht
 *   relevant  true bei handeln/chance (info nur, wenn Benutzer es merken)
 *   titel, kurz, warum, wer, wann   einfache Sprache, ohne Fachjargon
 *   actions   Schritte fuer das Team (Feldname wie bisher, Befunde nutzen ihn)
 *   kunde     ein Satz, den man dem Kunden so weitergeben kann
 *   impact    = warum (Kompatibilitaet zur bisherigen Oberflaeche)
 *   provider, model, at, profileHash
 *
 * Cache je Meldung: gueltig solange Microsoft die Meldung nicht aendert UND
 * das Kundenprofil gleich bleibt. Neue Profilnotiz => Neubewertung.
 *
 * Datenschutz: An die KI gehen nur Kennzahlen und Produktnamen des Tenants,
 * keine Benutzernamen, Mailadressen oder Inhalte.
 */
const crypto = require("crypto");
const AI = require("./aiProviders");

const BATCH = 6;
const DEFAULT_MAX = 40;
const ARTEN = ["handeln", "chance", "info", "nicht"];
const cut = (s, n) => { s = String(s == null ? "" : s).trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

/**
 * Kundenprofil, automatisch aus dem Tenant — Liste von [Bereich, Text].
 * Die Kundennotiz kommt getrennt dazu (profileText), damit die Oberflaeche
 * zeigen kann, was erkannt wurde und was ergaenzt ist.
 */
function profileLines(tenant, facts) {
  const f = facts || {};
  const L = [];
  const o = f.org && f.org.readable ? f.org : null;
  const name = (o && o.name) || (tenant && tenant.name);
  if (name) L.push(["Firma", `${name}${o && o.domains && o.domains.length ? ` (Domains: ${o.domains.join(", ")})` : ""}`]);
  if (o && (o.city || o.country)) L.push(["Standort", [o.city, o.country].filter(Boolean).join(", ")]);
  if (f.licenses) {
    L.push(["Grösse", `${f.licenses.licensedUsers ?? "?"} lizenzierte Benutzer`]);
    if (Array.isArray(f.licenses.skus) && f.licenses.skus.length) L.push(["Lizenzen", f.licenses.skus.map(s => `${s.name} (${s.assigned})`).join(", ")]);
  }
  const u = f.usage && f.usage.readable ? f.usage : null;
  if (u && u.activeUsers) {
    const a = u.activeUsers;
    const parts = [["Mail", a.exchange], ["Teams", a.teams], ["OneDrive", a.oneDrive], ["SharePoint", a.sharePoint], ["Viva Engage", a.yammer]]
      .filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`);
    L.push(["Genutzt (30 Tage, aktive Personen)", parts.length ? parts.join(", ") : "keine Nutzung gemeldet"]);
  }
  if (u && u.teams30d) L.push(["Teams (30 Tage)", `${u.teams30d.calls} Anrufe, ${u.teams30d.meetings} Besprechungen, ${u.teams30d.chats} Chatnachrichten`]);
  if (f.devices && f.devices.byOs) {
    const os = Object.entries(f.devices.byOs).map(([k, v]) => `${k}: ${v.total}`).join(", ");
    L.push(["Geräte (Intune)", os || "keine verwaltet"]);
  }
  if (f.teamsDevices) L.push(["Teams-Geräte", f.teamsDevices.readable ? (f.teamsDevices.total ? Object.entries(f.teamsDevices.byType).map(([k, v]) => `${k} ${v}`).join(", ") : "keine") : "nicht lesbar"]);
  if (f.exo) {
    const x = f.exo;
    L.push(["Mail", `${x.mailboxes || 0} Postfächer (${x.shared || 0} freigegeben)` +
      (x.smtpAuthDisabled !== undefined ? `, SMTP AUTH ${x.smtpAuthDisabled ? "aus" : "AN"}` : "") +
      (x.forwardingBlocked !== undefined && x.forwardingBlocked !== null ? `, externe Weiterleitung ${x.forwardingBlocked ? "blockiert" : "erlaubt"}` : "")]);
  }
  if (f.threat && f.threat.summary) L.push(["Mail-Schutz", f.threat.summary]);
  if (f.ca) L.push(["Conditional Access", `${f.ca.total} Richtlinien, ${f.ca.enabled} erzwungen, ${f.ca.reportOnly} nur Bericht`]);
  if (f.sharing && f.sharing.label) L.push(["Externe Freigabe", f.sharing.label]);
  if (f.score != null) L.push(["Secure Score", `${f.score}%`]);
  return L;
}
/** Profil als Text fuer den Prompt: erkannter Ist-Zustand plus optionale Notiz. */
function tenantProfile(tenant, facts, note) {
  const L = profileLines(tenant, facts).map(([k, v]) => `${k}: ${v}`);
  if (note && String(note).trim()) L.push(`Ergänzung des Betreuers: ${cut(note, 1500)}`);
  return L.join("\n");
}
const hash = s => crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 12);

const SYSTEM =
  "Du bist M365-Betriebsberater bei einem Schweizer IT-Dienstleister (MSP). Du sortierst Microsoft-Message-Center-Meldungen " +
  "für EINEN bestimmten Kunden: Was davon ist für genau diesen Kunden wichtig, was ist eine echte Chance, und was kann man ignorieren? " +
  "Schreibe auf Deutsch in Schweizer Schreibweise (ss statt ß), einfach und ohne Fachjargon — so, dass eine Geschäftsführerin ohne " +
  "IT-Wissen es versteht. Produktnamen wie Teams oder Outlook sind in Ordnung, Abkürzungen vermeiden oder kurz erklären. " +
  "Keine Werbesprache, nichts erfinden. Wenn das Kundenprofil eine Frage nicht beantwortet, sag das ehrlich («ob … genutzt wird, ist nicht bekannt»). " +
  "Leite aus Firmenname und Domains die vermutliche Branche ab und berücksichtige sie (z. B. Treuhand, Arztpraxis, Bau, Gemeinde) — " +
  "formuliere dann vorsichtig («als vermutlich …»). " +
  "Sei streng: lieber wenige, wirklich wichtige Meldungen als viele halbwichtige.";

function prompt(profile, batch) {
  return `KUNDENPROFIL (Ist-Zustand aus dem Tenant):\n${profile || "(keine Angaben)"}\n\n` +
    `MELDUNGEN (JSON):\n${JSON.stringify(batch.map(m => ({
      id: m.id, titel: m.title, dienste: m.services, stichtag: m.due, tags: m.tags, kategorie: m.category,
      regelUrteil: m.verdict, regelGrund: m.verdictReason, betroffenLautMicrosoft: m.affected, text: cut(m.summary, 2500)
    })))}\n\n` +
    `Antworte AUSSCHLIESSLICH mit JSON in genau dieser Form:\n` +
    `{"items":[{"id":string,"art":"handeln"|"chance"|"info"|"nicht","titel":string,"kurz":string,"warum":string,"wer":string,"wann":string,"wasTun":[string],"kunde":string}]}\n\n` +
    `Bedeutung von "art":\n` +
    `- "handeln": Der Kunde ist betroffen und wir müssen etwas tun oder entscheiden (Stichtag, Abschaltung, Kosten, Sicherheitsrisiko, Benutzer merken eine Störung).\n` +
    `- "chance": Neue Funktion oder Verbesserung, die DIESEM Kunden spürbar nützt und zu seinen Lizenzen und seiner Nutzung passt — ein guter Anlass, den Kunden zu beraten.\n` +
    `- "info": Betrifft genutzte Dienste, aber es gibt nichts zu tun und keinen spürbaren Nutzen.\n` +
    `- "nicht": Betrifft den Kunden nicht (Dienst oder Gerät nicht im Einsatz, nur für Behörden/andere Regionen, reine Entwicklerthemen).\n` +
    `Felder: "titel" verständlicher deutscher Titel (max. 80 Zeichen). "kurz" was sich ändert, 1–2 einfache Sätze. ` +
    `"warum" warum das für DIESEN Kunden wichtig ist oder nicht — mit konkretem Bezug auf das Kundenprofil, Zahlen nennen wenn vorhanden. ` +
    `"wer" wer beim Kunden etwas merkt, 1 Satz. "wann" Zeitpunkt in einem Satz mit Datum. ` +
    `"wasTun" 0–4 konkrete Schritte für unser Betreuungsteam (leer bei "info"/"nicht"). ` +
    `"kunde" bei "handeln"/"chance" ein freundlicher Satz, den wir dem Kunden so weitergeben können; sonst leer. ` +
    `Die Regel-Einschätzung (regelUrteil) ist ein Hinweis, kein Zwang — das Kundenprofil entscheidet.`;
}

function normalize(it, provider, profileHash) {
  const art = ARTEN.includes(it.art) ? it.art : "info";
  const warum = cut(it.warum, 500);
  return {
    art, relevant: art === "handeln" || art === "chance",
    titel: cut(it.titel, 120), kurz: cut(it.kurz, 500), warum, impact: warum, wer: cut(it.wer, 300), wann: cut(it.wann, 200),
    actions: (Array.isArray(it.wasTun) ? it.wasTun : []).map(a => cut(a, 300)).filter(Boolean).slice(0, 4),
    kunde: cut(it.kunde, 400),
    provider: provider.label, model: provider.model, at: new Date().toISOString(), profileHash
  };
}

/**
 * Bewertet offene Meldungen und gibt den aktualisierten Cache zurueck (oder
 * null, wenn nichts zu tun war). messages = data.messages aus collectMessages.
 */
async function evaluate({ tenant, messages, facts, cache, note, force, max }) {
  if (!AI.enabledFor("messages")) return null;
  const profile = tenantProfile(tenant, facts, note);
  const ph = hash(profile);
  const fresh = m => {
    const c = cache && cache[m.id];
    return c && c.modified === m.modified && c.ai && c.ai.art !== undefined && c.ai.profileHash === ph;
  };
  const todo = (messages || []).filter(m => !m.notInTenant && (force || !fresh(m))).slice(0, max || DEFAULT_MAX);
  if (!todo.length) return null;
  const next = { ...(cache || {}) };
  const errors = [];
  let done = 0;
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    try {
      const r = await AI.complete("messages", { system: SYSTEM, prompt: prompt(profile, batch), maxTokens: 4000, json: true });
      for (const it of (r.json && r.json.items) || []) {
        const m = batch.find(x => x.id === it.id);
        if (m) { next[m.id] = { modified: m.modified, ai: normalize(it, r.provider, ph) }; done++; }
      }
    } catch (e) { errors.push(e.message); if (/Kein KI-Dienst/.test(e.message)) break; }
  }
  if (errors.length && !done) throw new Error(errors[0]);
  return next;
}

module.exports = { evaluate, tenantProfile, profileLines, SYSTEM, ARTEN };
