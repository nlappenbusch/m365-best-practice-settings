"use strict";
/**
 * Deutsche Erklaerungen fuer Maester-Findings ueber die Anthropic Messages API
 * (gleiches Muster wie aiSuggest.js: direktes fetch, kein SDK).
 *
 * Eingabe: die gefallenen Tests eines Laufs (Titel/Severity/Block + Maesters
 * englisches ResultDetail). Ausgabe: pro Test eine deutsche Erklaerung —
 * was der Test prueft, warum das wichtig ist, und konkrete Umsetzungsschritte.
 * Das Ergebnis wird vom Aufrufer pro Lauf als explain.json gecacht; die KI
 * laeuft also einmal pro Lauf, nicht bei jedem Seitenaufruf.
 */

const DEFAULT_MODEL = "claude-sonnet-4-5";
const API_URL = "https://api.anthropic.com/v1/messages";

function config() {
  const key = (process.env.ANTHROPIC_API_KEY || "").trim();
  const model = (process.env.ANTHROPIC_MODEL || DEFAULT_MODEL).trim();
  return { enabled: key.length > 0, key, model };
}

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

function parseJsonResponse(text) {
  const cleaned = String(text || "").replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  return JSON.parse(cleaned);
}

/**
 * @param {object} opts { tenantName, findings: [{id,title,severity,block,description,result}] }
 * @returns [{id, titel, bedeutung, umsetzung: [string], aufwand}]
 */
async function explainFindings(opts) {
  const cfg = config();
  if (!cfg.enabled) throw Object.assign(new Error("Kein Anthropic-Key konfiguriert (ANTHROPIC_API_KEY)."), { status: 400 });
  const findings = (opts.findings || []).slice(0, 60); // Prompt-Groesse im Zaum halten
  if (!findings.length) return [];

  let r;
  try {
    r = await fetch(API_URL, {
      method: "POST",
      headers: { "x-api-key": cfg.key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 16000,
        messages: [{ role: "user", content: buildPrompt(opts.tenantName || "?", findings) }]
      }),
      signal: AbortSignal.timeout(180000)
    });
  } catch (e) {
    throw Object.assign(new Error("Anthropic-API nicht erreichbar: " + e.message), { status: 502 });
  }
  const data = await r.json().catch(() => null);
  if (!r.ok) {
    const msg = (data && data.error && data.error.message) || `HTTP ${r.status}`;
    throw Object.assign(new Error("Anthropic-Fehler: " + msg), { status: 502 });
  }
  const text = (data && data.content && data.content[0] && data.content[0].text) || "";
  let parsed;
  try { parsed = parseJsonResponse(text); }
  catch (e) {
    if (data && data.stop_reason === "max_tokens") {
      throw Object.assign(new Error("KI-Antwort abgeschnitten (max_tokens) — zu viele Findings auf einmal."), { status: 502 });
    }
    throw Object.assign(new Error("KI-Antwort war kein gueltiges JSON — Rohtext: " + text.slice(0, 300)), { status: 502 });
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
