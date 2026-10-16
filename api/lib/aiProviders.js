"use strict";
/**
 * KI-Dienste: mehrere Anbieter nach Wahl, je Zweck zuweisbar.
 *
 * Wozu: Bisher sprach jede KI-Funktion fest mit Anthropic (ANTHROPIC_API_KEY).
 * Jetzt lassen sich beliebig viele Dienste hinterlegen und je Zweck in einer
 * Reihenfolge zuweisen (erster = Standard, weitere = Ausweichdienst, wenn der
 * erste nicht antwortet):
 *   messages  Message Center: Relevanz je Kunde, Erklärung auf Deutsch
 *   tickets   SDP-Ticket-Copilot
 *   maester   Erklärungen im Security Audit
 *
 * Anbieter-Typen (eine HTTP-Form je Typ, bewusst ohne SDKs — wie graph.js):
 *   anthropic          Messages API
 *   openai             Chat Completions (api.openai.com)
 *   azure-openai       Azure OpenAI (Endpoint + Deployment + api-version) —
 *                      dieselben GPT-Modelle wie Microsoft Copilot, im eigenen Azure
 *   azure-foundry      Azure AI Foundry (Modell-Inferenz: GPT, Mistral, Llama,
 *                      DeepSeek … ueber einen Foundry-Endpoint)
 *   gemini             Google Generative Language API
 *   mistral            Mistral (OpenAI-kompatibel)
 *   openai-compatible  beliebige OpenAI-kompatible Gegenstelle: Ollama,
 *                      LM Studio, OpenRouter, Azure AI Foundry, vLLM …
 *
 * Ablage: STATE_DIR/ai-providers.json. API-Keys liegen dort AES-256-GCM-
 * verschluesselt (Schluessel aus AI_SECRET_KEY oder STATE_DIR/.ai-secret).
 * Das schuetzt vor Klartext-Keys in Backups und Exporten des Zustands, nicht
 * vor jemandem mit Vollzugriff auf den Container. Keys verlassen den Server
 * nie — die Oberflaeche sieht nur "hinterlegt" bzw. die letzten 4 Zeichen.
 *
 * ANTHROPIC_API_KEY aus der Umgebung bleibt als eingebauter Dienst «Anthropic
 * (Umgebung)» nutzbar, damit bestehende Installationen ohne Zutun weiterlaufen.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PURPOSES = {
  messages: "Message Center (Relevanz je Kunde)",
  tickets: "Ticket-Copilot (ServiceDesk Plus)",
  maester: "Security-Audit-Erklärungen"
};
const TYPES = {
  anthropic: { label: "Anthropic (Claude)", defaultModel: "claude-sonnet-4-5", needsKey: true, fields: [] },
  openai: { label: "OpenAI", defaultModel: "gpt-4.1-mini", needsKey: true, fields: [] },
  "azure-openai": { label: "Microsoft Azure OpenAI (GPT-Modelle wie in Copilot)", defaultModel: "", needsKey: true, fields: ["baseUrl", "deployment", "apiVersion"] },
  "azure-foundry": { label: "Microsoft Azure AI Foundry (GPT, Mistral, Llama, DeepSeek …)", defaultModel: "", needsKey: true, fields: ["baseUrl", "apiVersion"] },
  gemini: { label: "Google Gemini", defaultModel: "gemini-2.5-flash", needsKey: true, fields: [] },
  mistral: { label: "Mistral AI", defaultModel: "mistral-large-latest", needsKey: true, fields: [] },
  "openai-compatible": { label: "OpenAI-kompatibel (Ollama, LM Studio, OpenRouter …)", defaultModel: "", needsKey: false, fields: ["baseUrl"] }
};
const ENV_ID = "env-anthropic";
const TIMEOUT_MS = 120000;

let STATE_DIR = null;
function init(stateDir) { STATE_DIR = stateDir; }
const file = () => path.join(STATE_DIR || path.join(__dirname, "..", "state"), "ai-providers.json");

// ------------------------------------------------------------------ Verschluesselung
function secretKey() {
  if (process.env.AI_SECRET_KEY) return crypto.createHash("sha256").update(process.env.AI_SECRET_KEY).digest();
  const f = path.join(path.dirname(file()), ".ai-secret");
  try { return Buffer.from(fs.readFileSync(f, "utf8").trim(), "hex"); } catch (e) { /* neu anlegen */ }
  const k = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, k.toString("hex"), { encoding: "utf8", mode: 0o600 });
  return k;
}
function enc(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", secretKey(), iv);
  const data = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return [iv.toString("base64"), c.getAuthTag().toString("base64"), data.toString("base64")].join(".");
}
function dec(blob) {
  if (!blob) return "";
  const [iv, tag, data] = String(blob).split(".");
  const d = crypto.createDecipheriv("aes-256-gcm", secretKey(), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8");
}

// ------------------------------------------------------------------ Konfiguration
function readCfg() {
  try { const c = JSON.parse(fs.readFileSync(file(), "utf8")); return { providers: c.providers || [], assign: c.assign || {} }; }
  catch (e) { return { providers: [], assign: {} }; }
}
function writeCfg(c) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  const tmp = file() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file());
}
function envProvider() {
  const key = (process.env.ANTHROPIC_API_KEY || "").trim();
  if (!key) return null;
  return { id: ENV_ID, label: "Anthropic (Umgebung)", type: "anthropic", model: (process.env.ANTHROPIC_MODEL || TYPES.anthropic.defaultModel).trim(), enabled: true, builtin: true, _key: key };
}
function allProviders() {
  const c = readCfg();
  const list = c.providers.map(p => ({ ...p }));
  const env = envProvider();
  if (env) list.unshift(env);
  return { list, assign: c.assign };
}
function keyOf(p) {
  if (p._key) return p._key;
  try { return p.keyEnc ? dec(p.keyEnc) : ""; } catch (e) { return ""; }
}
/** Fuer die Oberflaeche: ohne Keys. */
function publicView() {
  const { list, assign } = allProviders();
  return {
    providers: list.map(p => {
      const k = keyOf(p);
      return {
        id: p.id, label: p.label, type: p.type, typeLabel: (TYPES[p.type] || {}).label || p.type, model: p.model || "",
        baseUrl: p.baseUrl || "", deployment: p.deployment || "", apiVersion: p.apiVersion || "", note: p.note || "",
        enabled: p.enabled !== false, builtin: !!p.builtin, hasKey: !!k, keyHint: k ? "…" + k.slice(-4) : "",
        lastTest: p.lastTest || null
      };
    }),
    assign, purposes: PURPOSES,
    types: Object.fromEntries(Object.entries(TYPES).map(([k, v]) => [k, { label: v.label, defaultModel: v.defaultModel, needsKey: v.needsKey, fields: v.fields }]))
  };
}

function cleanUrl(u) {
  const s = String(u || "").trim().replace(/\/+$/, "");
  if (!s) return "";
  if (!/^https?:\/\/[^\s]+$/i.test(s)) throw Object.assign(new Error("Adresse muss mit http:// oder https:// beginnen."), { status: 400 });
  return s;
}

function saveProvider(b) {
  const c = readCfg();
  if (b.id === ENV_ID) throw Object.assign(new Error("Der Dienst aus der Umgebung wird über ANTHROPIC_API_KEY gesteuert."), { status: 400 });
  const type = String(b.type || "");
  if (!TYPES[type]) throw Object.assign(new Error("Unbekannter Anbieter-Typ."), { status: 400 });
  const existing = b.id ? c.providers.find(p => p.id === b.id) : null;
  const p = existing || { id: "ai-" + crypto.randomBytes(5).toString("hex") };
  p.type = type;
  p.label = String(b.label || TYPES[type].label).trim().slice(0, 60);
  p.model = String(b.model || TYPES[type].defaultModel || "").trim().slice(0, 120);
  p.baseUrl = TYPES[type].fields.includes("baseUrl") ? cleanUrl(b.baseUrl) : "";
  p.deployment = type === "azure-openai" ? String(b.deployment || "").trim().slice(0, 120) : "";
  p.apiVersion = type === "azure-openai" ? (String(b.apiVersion || "").trim() || "2024-10-21")
    : type === "azure-foundry" ? String(b.apiVersion == null ? "2024-05-01-preview" : b.apiVersion).trim() : "";
  p.note = String(b.note || "").trim().slice(0, 200);
  p.enabled = b.enabled !== false;
  // Key nur ersetzen, wenn ein neuer kommt — leer heisst "unveraendert".
  if (typeof b.key === "string" && b.key.trim()) p.keyEnc = enc(b.key.trim());
  if (b.clearKey) delete p.keyEnc;
  if (type === "azure-openai" && (!p.baseUrl || !p.deployment)) throw Object.assign(new Error("Azure OpenAI braucht Endpoint-Adresse und Deployment-Namen."), { status: 400 });
  if (type === "azure-foundry" && !p.baseUrl) throw Object.assign(new Error("Foundry-Endpoint fehlt (z. B. https://<name>.services.ai.azure.com/models)."), { status: 400 });
  if (type === "openai-compatible" && !p.baseUrl) throw Object.assign(new Error("Adresse der Gegenstelle fehlt (z. B. http://ollama:11434/v1)."), { status: 400 });
  if (!p.model && type !== "azure-openai") throw Object.assign(new Error("Modell fehlt."), { status: 400 });
  if (TYPES[type].needsKey && !p.keyEnc) throw Object.assign(new Error("API-Key fehlt."), { status: 400 });
  if (!existing) c.providers.push(p);
  writeCfg(c);
  return p.id;
}

function deleteProvider(id) {
  const c = readCfg();
  c.providers = c.providers.filter(p => p.id !== id);
  for (const k of Object.keys(c.assign)) c.assign[k] = (c.assign[k] || []).filter(x => x !== id);
  writeCfg(c);
}

function setAssign(purpose, ids) {
  if (!PURPOSES[purpose]) throw Object.assign(new Error("Unbekannter Zweck."), { status: 400 });
  const known = new Set(allProviders().list.map(p => p.id));
  const c = readCfg();
  c.assign[purpose] = (Array.isArray(ids) ? ids : []).filter(id => known.has(id)).slice(0, 5);
  writeCfg(c);
}

function recordTest(id, result) {
  if (id === ENV_ID) return;
  const c = readCfg();
  const p = c.providers.find(x => x.id === id);
  if (!p) return;
  p.lastTest = result;
  writeCfg(c);
}

/** Dienste fuer einen Zweck in Reihenfolge; ohne Zuweisung: alle aktiven (Umgebung zuerst). */
function chainFor(purpose) {
  const { list, assign } = allProviders();
  const active = list.filter(p => p.enabled !== false);
  const ids = assign[purpose];
  if (ids && ids.length) return ids.map(id => active.find(p => p.id === id)).filter(Boolean);
  return active;
}
function enabledFor(purpose) { return chainFor(purpose).length > 0; }

// ------------------------------------------------------------------ Aufruf
async function http(url, headers, body) {
  let r;
  try {
    r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) { throw new Error("nicht erreichbar: " + e.message); }
  const j = await r.json().catch(() => null);
  if (!r.ok) {
    const m = j && ((j.error && (j.error.message || j.error)) || j.message);
    throw new Error(`HTTP ${r.status}${m ? ": " + (typeof m === "string" ? m : JSON.stringify(m)).slice(0, 300) : ""}`);
  }
  return j;
}

async function callOne(p, { system, prompt, maxTokens, json }) {
  const key = keyOf(p);
  const max = maxTokens || 3000;
  if (p.type === "anthropic") {
    const j = await http("https://api.anthropic.com/v1/messages", { "x-api-key": key, "anthropic-version": "2023-06-01" },
      { model: p.model, max_tokens: max, ...(system ? { system } : {}), messages: [{ role: "user", content: prompt }] });
    return { text: (j.content || []).map(c => c.text || "").join(""), truncated: j.stop_reason === "max_tokens" };
  }
  if (p.type === "gemini") {
    const j = await http(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(p.model)}:generateContent`, { "x-goog-api-key": key }, {
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: max, ...(json ? { responseMimeType: "application/json" } : {}) }
    });
    const cand = (j.candidates || [])[0] || {};
    return { text: ((cand.content && cand.content.parts) || []).map(x => x.text || "").join(""), truncated: cand.finishReason === "MAX_TOKENS" };
  }
  // OpenAI-Familie (openai, azure-openai, mistral, openai-compatible)
  let url, headers = {};
  if (p.type === "openai") { url = "https://api.openai.com/v1/chat/completions"; headers.authorization = "Bearer " + key; }
  else if (p.type === "mistral") { url = "https://api.mistral.ai/v1/chat/completions"; headers.authorization = "Bearer " + key; }
  else if (p.type === "azure-openai") {
    url = `${p.baseUrl}/openai/deployments/${encodeURIComponent(p.deployment)}/chat/completions?api-version=${encodeURIComponent(p.apiVersion || "2024-10-21")}`;
    headers["api-key"] = key;
  } else if (p.type === "azure-foundry") {
    url = (/\/chat\/completions$/.test(p.baseUrl) ? p.baseUrl : p.baseUrl + "/chat/completions") + (p.apiVersion ? `?api-version=${encodeURIComponent(p.apiVersion)}` : "");
    headers["api-key"] = key;
  } else {
    url = /\/chat\/completions$/.test(p.baseUrl) ? p.baseUrl : p.baseUrl + "/chat/completions";
    if (key) headers.authorization = "Bearer " + key;
  }
  const messages = [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: prompt }];
  const body = { messages, max_tokens: max, ...(p.type !== "azure-openai" ? { model: p.model } : {}) };
  if (json && p.type !== "openai-compatible" && p.type !== "azure-foundry") body.response_format = { type: "json_object" };
  const j = await http(url, headers, body);
  const ch = (j.choices || [])[0] || {};
  return { text: (ch.message && ch.message.content) || "", truncated: ch.finish_reason === "length" };
}

/** Robust gegen Codefences und Vor-/Nachtext. */
function parseJson(text) {
  const t = String(text || "").replace(/^\s*```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try { return JSON.parse(t); } catch (e) { /* weiter */ }
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
  throw new Error("Antwort war kein gültiges JSON: " + t.slice(0, 200));
}

/**
 * Anfrage an den ersten funktionierenden Dienst des Zwecks.
 * Rueckgabe: { text, json?, provider: { id, label, model } }.
 */
async function complete(purpose, opts) {
  const chain = opts && opts.providerId ? allProviders().list.filter(p => p.id === opts.providerId) : chainFor(purpose);
  if (!chain.length) throw Object.assign(new Error(`Kein KI-Dienst für «${PURPOSES[purpose] || purpose}» eingerichtet (Service-Cockpit → KI-Dienste).`), { status: 400 });
  const errors = [];
  for (const p of chain) {
    try {
      const r = await callOne(p, opts);
      const out = { text: r.text, provider: { id: p.id, label: p.label, model: p.model || p.deployment } };
      if (opts.json) {
        try { out.json = parseJson(r.text); }
        catch (e) { throw new Error(r.truncated ? "Antwort abgeschnitten (Token-Limit) — weniger auf einmal anfragen." : e.message); }
      }
      return out;
    } catch (e) { errors.push(`${p.label}: ${e.message}`); }
  }
  throw Object.assign(new Error("KI nicht verfügbar — " + errors.join(" · ")), { status: 502 });
}

async function test(id) {
  const t0 = Date.now();
  try {
    const r = await complete(null, { providerId: id, prompt: 'Antworte nur mit diesem JSON: {"ok":true,"sprache":"de"}', maxTokens: 60, json: true });
    const res = { ok: !!(r.json && r.json.ok), at: new Date().toISOString(), ms: Date.now() - t0, model: r.provider.model };
    recordTest(id, res);
    return res;
  } catch (e) {
    const res = { ok: false, at: new Date().toISOString(), ms: Date.now() - t0, error: e.message.replace(/^KI nicht verfügbar — /, "").slice(0, 300) };
    recordTest(id, res);
    return res;
  }
}

module.exports = { init, PURPOSES, TYPES, ENV_ID, publicView, saveProvider, deleteProvider, setAssign, chainFor, enabledFor, complete, test, parseJson, _enc: enc, _dec: dec };
