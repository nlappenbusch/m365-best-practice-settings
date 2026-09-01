"use strict";
/**
 * Baseline — die Betriebsrichtlinien als eine Quelle.
 *
 * Bisher standen dieselben Regeln an drei Orten: als Prosa in den
 * Wissensseiten, als Werte im Code und nochmal im Konzeptdokument. Das driftet
 * auseinander — genau das ist passiert, als die Doku den Bitwarden-Weg falsch
 * beschrieb, während das Werkzeug es längst besser konnte.
 *
 * Deshalb: `baseline/baseline.json` ist die Quelle, alles andere liest daraus.
 * Das Namensschema wird NICHT dupliziert, sondern beim Ausliefern aus
 * lib/naming.js dazugerechnet — sonst hätte man zwei Wahrheiten über Namen.
 *
 * Bewusst schreibgeschützt: Die Datei liegt im Git, Änderungen laufen über
 * einen Commit mit Review, nicht über einen Klick in der Oberfläche. Eine
 * Betriebsrichtlinie, die sich zur Laufzeit ändern lässt, ist keine.
 */
const fs = require("fs");
const path = require("path");
const NAMING = require("./naming");

const FILE = path.join(__dirname, "..", "baseline", "baseline.json");

let cache = null;
let cacheMtime = 0;

function readFile() {
  const stat = fs.statSync(FILE);
  if (cache && stat.mtimeMs === cacheMtime) return cache;
  cache = JSON.parse(fs.readFileSync(FILE, "utf8"));
  cacheMtime = stat.mtimeMs;
  return cache;
}

/**
 * Komplette Baseline inklusive des Namensschemas des Tenants.
 * tenantId optional — ohne ihn gilt die globale Vorgabe.
 */
function get(tenantId) {
  const base = readFile();
  const conv = NAMING.forTenant(tenantId);
  const beispiele = NAMING.describe(tenantId).preview;

  // Die Agent-Einträge tragen nur den Muster-Schlüssel; den fertigen
  // Gruppennamen rechnet die Baseline hier aus, damit niemand ihn abtippt.
  const agents = (base.agents || []).map(a => Object.assign({}, a, {
    zielgruppe: a.zielgruppeKind
      ? NAMING.name(a.zielgruppeKind, { app: a.zielgruppeApp || "" }, tenantId)
      : null
  }));

  return Object.assign({}, base, {
    agents,
    namensschema: {
      profil: conv.profile,
      eigeneMuster: conv.custom,
      quelle: conv.source,
      muster: conv.templates,
      beispiele
    }
  });
}

/** Einzelner Abschnitt — für Aufrufer, die nicht alles brauchen. */
function section(key, tenantId) {
  const all = get(tenantId);
  if (!Object.prototype.hasOwnProperty.call(all, key)) {
    const e = new Error("Unbekannter Baseline-Abschnitt: " + key);
    e.status = 404;
    throw e;
  }
  return all[key];
}

/** Ein Agent-Modul, fertig mit Zielgruppenname. */
function agent(key, tenantId) {
  const found = (get(tenantId).agents || []).find(a => a.key === String(key || "").toLowerCase());
  if (!found) {
    const e = new Error("Unbekanntes Agent-Modul: " + key);
    e.status = 404;
    throw e;
  }
  return found;
}

/**
 * Volltextsuche über die Baseline. Liefert Treffer mit Pfad, damit eine
 * Antwort zitierfähig bleibt ("Baseline 1.0 → oib.breakRisk[2]").
 */
function search(query, tenantId) {
  const q = String(query || "").trim().toLowerCase();
  if (q.length < 2) return [];
  const hits = [];

  function walk(node, pfad) {
    if (hits.length >= 60) return;
    if (node === null || node === undefined) return;
    if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") {
      const text = String(node);
      if (text.toLowerCase().includes(q)) hits.push({ pfad, text });
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, pfad + "[" + i + "]"));
      return;
    }
    Object.keys(node).forEach(k => walk(node[k], pfad ? pfad + "." + k : k));
  }

  walk(get(tenantId), "");
  return hits;
}

/** Kurzfassung für Kopfzeilen und Zitate. */
function meta() {
  const m = readFile().meta || {};
  return { version: m.version, gueltigAb: m.gueltigAb, titel: m.titel };
}

module.exports = { get, section, agent, search, meta, FILE };
