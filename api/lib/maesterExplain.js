"use strict";
/**
 * Deutsche Erklaerungen fuer Maester-Findings ueber den eingerichteten KI-Dienst
 * (lib/aiProviders.js, Zweck «maester»).
 *
 * Eingabe: die gefallenen Tests eines Laufs (Titel/Severity/Block + Maesters
 * englisches ResultDetail). Ausgabe: pro Test eine deutsche Erklaerung —
 * was der Test prueft, warum das wichtig ist, und konkrete Umsetzungsschritte.
 * Das Ergebnis wird vom Aufrufer pro Lauf als explain.json gecacht; die KI
 * laeuft also einmal pro Lauf, nicht bei jedem Seitenaufruf.
 */

const AI = require("./aiProviders");

// Welcher KI-Dienst antwortet, steht in den KI-Diensten (Zweck «maester»).
function config() { return { enabled: AI.enabledFor("maester") }; }

function clip(s, n) { return String(s == null ? "" : s).slice(0, n); }

function buildPrompt(tenantName, findings) {
  const list = findings.map((f, i) =>
    `${i + 1}. id: ${f.id}\n   Titel: ${clip(f.title, 200)}\n   Severity: ${f.severity || "?"} · Bereich: ${clip(f.block, 120)}\n` +
    (f.description ? `   Testbeschreibung: ${clip(f.description, 600)}\n` : "") +
    (f.result ? `   Befund: ${clip(f.result, 700)}\n` : "")
  ).join("\n");

  return `Du bist ein erfahrener M365-/Entra-ID-Security-Consultant bei einem Schweizer MSP (igeeks AG). ` +
    `Ein Maester-Security-Audit (maester.dev) im Tenant "${tenantName}" hat die unten gelisteten Tests als GEFALLEN markiert.\n\n` +
    `Antworte AUSSCHLIESSLICH mit einem JSON-Array (kein Text davor/danach). Pro Finding ein Objekt exakt nach diesem Schema:\n` +
    `{"id": string (die id aus der Liste, unveraendert), "titel": string (deutscher, kundenverstaendlicher Titel, max. 90 Zeichen), ` +
    `"bedeutung": string (2-3 Saetze: was ist hier nicht gut konfiguriert und welches Risiko entsteht daraus — fuer einen ` +
    `IT-affinen Kunden verstaendlich, ohne Panik), "umsetzung": [string] (2-5 konkrete Schritte zur Behebung: wo im Admin-Portal, ` +
    `welche Einstellung, welcher Zielwert; bei eingreifenden Aenderungen den Hinweis auf Pilotgruppe/Report-only zuerst), ` +
    `"aufwand": "klein"|"mittel"|"gross" (grobe Einschaetzung des Umsetzungsaufwands)}\n\n` +
    `Schweizer Schreibweise (ss statt ß). Sachlich und direkt, kein Marketing. ` +
    `Wenn ein Finding eine Lizenz voraussetzt, die typische KMU-Tenants nicht haben (z.B. Entra ID P2), das in "umsetzung" erwaehnen.\n\n` +
    `Findings:\n${list}`;
}

/**
 * @param {object} opts { tenantName, findings: [{id,title,severity,block,description,result}] }
 * @returns [{id, titel, bedeutung, umsetzung: [string], aufwand}]
 */
async function explainFindings(opts) {
  const findings = (opts.findings || []).slice(0, 60); // Prompt-Groesse im Zaum halten
  if (!findings.length) return [];

  let parsed;
  try {
    const r = await AI.complete("maester", { prompt: buildPrompt(opts.tenantName || "?", findings), maxTokens: 16000, json: true });
    parsed = r.json;
    // Einige Dienste liefern im JSON-Modus nur Objekte — Array dann aus dem ersten Feld holen.
    if (parsed && !Array.isArray(parsed)) parsed = Object.values(parsed).find(Array.isArray) || parsed;
  } catch (e) {
    throw Object.assign(new Error(e.message), { status: e.status || 502 });
  }
  if (!Array.isArray(parsed)) throw Object.assign(new Error("KI-Antwort hatte nicht das erwartete Array-Format."), { status: 502 });
  // Nur bekannte Felder uebernehmen — die Antwort landet als Datei im State.
  return parsed.map(x => ({
    id: String(x.id || ""),
    titel: clip(x.titel, 160),
    bedeutung: clip(x.bedeutung, 1200),
    umsetzung: Array.isArray(x.umsetzung) ? x.umsetzung.slice(0, 6).map(s => clip(s, 400)) : [],
    aufwand: ["klein", "mittel", "gross"].includes(x.aufwand) ? x.aufwand : null
  })).filter(x => x.id);
}

module.exports = { config, explainFindings };
