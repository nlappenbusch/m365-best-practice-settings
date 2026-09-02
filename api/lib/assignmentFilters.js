"use strict";
/**
 * Zuweisungsfilter (Intune > Mandantenadministration > Filter).
 *
 * Der Anlass ist der Fall aus der Wissensbasis (Kap. 9.3): Die
 * OpenIntuneBaseline liefert einige Richtlinien doppelt — eine Variante fuer
 * Windows 11 24H2 und neuer, eine fuer aeltere Builds. Ohne Filter muesste man
 * dafuer zwei Geraetegruppen fuehren und die Geraete beim Build-Wechsel
 * umhaengen. Mit Filter bleibt es eine Gruppe: dieselbe Zuweisung, einmal mit
 * dem Filter als Einschluss (24H2-Variante), einmal als Ausschluss (Alt-Variante).
 *
 * Graph:
 *   GET  /deviceManagement/assignmentFilters
 *   POST /deviceManagement/assignmentFilters
 * Permission: DeviceManagementConfiguration.ReadWrite.All (hat das Tool bereits).
 *
 * Warum `-startsWith "10.0.26"` und nicht ein Vergleich auf die volle Build-
 * Nummer: 24H2 ist 10.0.26100, 25H2 ist 10.0.26200 — beide sollen die neue
 * Variante bekommen. Ein `-eq` auf eine konkrete Build-Nummer waere schon beim
 * naechsten Patchday falsch.
 */
const { graphReq, graphAllPages } = require("./graph");

const BETA = { beta: true, retryTransient: true };
const PATH = "/deviceManagement/assignmentFilters";

/**
 * Der eine Filter, den das Tool selbst anlegt. Bewusst mit dem Namen aus der
 * Wissensbasis — wer ihn im Portal sucht, findet ihn unter genau dieser
 * Bezeichnung wieder.
 */
const WIN11_24H2 = {
  key: "win11-24h2",
  displayName: "Windows 11 24H2 Device Filter",
  description: "Geräte ab Windows 11 24H2 (Build 10.0.26xxx). Für die doppelt gelieferten OIB-Richtlinien: 24H2-Variante mit Einschluss, Alt-Variante mit Ausschluss — beides an dieselbe Gerätegruppe. Angelegt vom M365 Security Policy Manager.",
  platform: "windows10AndLater",
  rule: '(device.osVersion -startsWith "10.0.26")',
  assignmentFilterManagementType: "devices"
};

/** Alle Filter des Tenants, aufbereitet. */
async function list(tenant, certPemPath) {
  const all = await graphAllPages(tenant, certPemPath, `${PATH}?$top=100`, BETA);
  return all.map(f => ({
    id: f.id,
    displayName: f.displayName,
    description: f.description || "",
    platform: f.platform,
    rule: f.rule,
    managementType: f.assignmentFilterManagementType || "devices",
    // Unser Filter wird an der Regel erkannt, nicht am Namen: Wer ihn im Portal
    // umbenennt, soll trotzdem nicht einen zweiten danebengelegt bekommen.
    istUnserer: normRule(f.rule) === normRule(WIN11_24H2.rule) && /windows/i.test(String(f.platform || ""))
  })).sort((a, b) => String(a.displayName).localeCompare(String(b.displayName)));
}

/** Regeln vergleichbar machen: Leerraum und Anfuehrungszeichen sind egal. */
function normRule(rule) {
  return String(rule || "").replace(/\s+/g, "").replace(/["']/g, "").toLowerCase();
}

/**
 * Den 24H2-Filter sicherstellen. Idempotent in beide Richtungen: gibt es ihn
 * schon (an der Regel erkannt), wird er wiederverwendet und nicht gedoppelt.
 */
async function ensureWin11Filter(tenant, certPemPath) {
  const vorhanden = await list(tenant, certPemPath);
  const hit = vorhanden.find(f => f.istUnserer);
  if (hit) return { created: false, filter: hit };

  const created = await graphReq(tenant, certPemPath, "POST", PATH, {
    displayName: WIN11_24H2.displayName,
    description: WIN11_24H2.description,
    platform: WIN11_24H2.platform,
    rule: WIN11_24H2.rule,
    assignmentFilterManagementType: WIN11_24H2.assignmentFilterManagementType
  }, BETA);

  return {
    created: true,
    filter: {
      id: created.id,
      displayName: created.displayName,
      description: created.description || "",
      platform: created.platform,
      rule: created.rule,
      managementType: created.assignmentFilterManagementType || "devices",
      istUnserer: true
    }
  };
}

// ---------------------------------------------------------------- Paar-Erkennung
/**
 * Ein Name ohne sein Versions-Kennzeichen. Aus
 *   "Win - OIB - SC - Local Security Policies - D - 24H2+"
 * und
 *   "Win - OIB - SC - Local Security Policies - D"
 * wird derselbe Schluessel — daran erkennt das Tool die doppelt gelieferten
 * Varianten, ohne die OIB-Namensregeln fest zu verdrahten.
 */
function versionKey(name) {
  return String(name || "")
    .replace(/\b(24h2|25h2|23h2|22h2|21h2)\s*\+?/gi, "")
    .replace(/\bwin(dows)?\s*11\b/gi, "")
    .replace(/[\s\-–—+]+/g, " ")
    .trim()
    .toLowerCase();
}

function is24H2Variant(name) {
  return /\b(24h2|25h2)\b/i.test(String(name || ""));
}

/**
 * Paare aus einer Policy-Liste bilden. Zurueck kommt nur, was wirklich doppelt
 * vorliegt — eine einzelne 24H2-Policy ohne Gegenstueck braucht keinen Filter
 * und taucht hier nicht auf.
 */
function findVariantPairs(policies) {
  const buckets = new Map();
  (policies || []).forEach(p => {
    const k = versionKey(p.name);
    if (!k) return;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(p);
  });

  const paare = [];
  buckets.forEach((list, key) => {
    if (list.length < 2) return;
    const neu = list.filter(p => is24H2Variant(p.name));
    const alt = list.filter(p => !is24H2Variant(p.name));
    if (!neu.length || !alt.length) return;
    paare.push({ key, neu, alt });
  });
  return paare.sort((a, b) => a.key.localeCompare(b.key));
}

module.exports = { list, ensureWin11Filter, findVariantPairs, versionKey, is24H2Variant, normRule, WIN11_24H2, PATH };
