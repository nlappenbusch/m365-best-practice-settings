"use strict";
/**
 * N-able N-sight RMM — Clients/Sites auflisten + Agent-Paket herunterladen.
 *
 * Portiert aus dem PowerShell-Agent-Downloader (RMM & Bitdefender Helper).
 * Der API-Key bleibt serverseitig; das Frontend spricht nur unseren Proxy an.
 *
 * Eigenheiten der N-sight-API, die hier bewusst nachgebaut sind:
 *  - Die API laeuft NICHT auf der Vanity-/Login-URL, sondern auf einem
 *    regionalen Server -> wir probieren die EU-Cluster der Reihe nach durch
 *    (RMM_SERVER setzt einen Host fest und ueberspringt das Raten).
 *  - Antworten sind XML. Fehler kommen als <result status="FAIL"> bzw. mit
 *    <error><message>, teils aber auch als HTML-Fehlerseite (Apache).
 *  - Der Agent-Download antwortet im Fehlerfall mit XML statt einer Datei ->
 *    wir schauen in den ersten Chunk rein, bevor wir streamen.
 */

const { Readable } = require("stream");
const { XMLParser } = require("fast-xml-parser");
const { fileNameFromDisposition } = require("./httputil");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
           "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const FALLBACK_SERVERS = [
  "dashboardeurope1.systemmonitor.eu.com",
  "wwweurope1.systemmonitor.eu.com",
  "www.systemmonitor.eu.com"
];

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,   // IDs als String lassen (keine Zahlen-Ueberraschungen)
  trimValues: true
});

// Einmal erkannter API-Server wird gemerkt, damit nicht jeder Call neu raet.
let resolvedServer = null;

function config() {
  const key = (process.env.RMM_API_KEY || "").trim();
  const fixed = (process.env.RMM_SERVER || "").trim();
  const candidates = [];
  for (const c of [fixed, ...FALLBACK_SERVERS]) {
    if (c && !candidates.includes(c)) candidates.push(c);
  }
  return { enabled: key.length > 0, key, fixed, candidates };
}

function asArray(x) {
  if (Array.isArray(x)) return x;
  return x === undefined || x === null ? [] : [x];
}

function buildUrl(server, service, extra = {}) {
  const cfg = config();
  let u = `https://${server}/api/?apikey=${encodeURIComponent(cfg.key)}&service=${encodeURIComponent(service)}`;
  for (const [k, v] of Object.entries(extra)) {
    u += `&${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`;
  }
  return u;
}

/** HTML-Fehlerseiten (Apache & Co.) auf einen lesbaren Satz eindampfen. */
function snippetFromHtml(text) {
  if (!text) return "";
  let t = String(text)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
  if (t.length > 300) t = t.slice(0, 300) + " ...";
  return t;
}

/** Einen XML-Service aufrufen und das <result>-Objekt zurueckgeben. */
async function xmlGet(server, service, extra = {}) {
  const url = buildUrl(server, service, extra);
  let r, text;
  try {
    r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(60000) });
    text = await r.text();
  } catch (e) {
    throw new Error(`Verbindungsfehler bei '${service}'. ${e.message}`);
  }
  if (!r.ok) {
    const snip = snippetFromHtml(text);
    throw new Error(`HTTP ${r.status} bei '${service}'.` + (snip ? ` Server-Antwort: ${snip}` : ""));
  }

  let obj;
  try { obj = parser.parse(text); } catch (e) {
    throw new Error(`Unerwartete Antwort bei '${service}' (kein XML).`);
  }
  const result = obj && obj.result;
  if (!result) throw new Error(`Unerwartete Antwort bei '${service}'.`);

  // status steht als Attribut ODER Kindelement drin - beides pruefen.
  const status = result["@_status"] || result.status;
  if (String(status).toUpperCase() === "FAIL" || result.error) {
    const msg = (result.error && (result.error.message || result.error)) || "Unbekannter Fehler.";
    throw new Error(`N-sight Fehler: ${msg}`);
  }
  return result;
}

/**
 * Clients holen. Beim ersten Mal wird der richtige regionale Server gesucht;
 * danach wird der gemerkte Host verwendet.
 */
async function listClients() {
  const cfg = config();
  if (!cfg.enabled) throw Object.assign(new Error("Kein N-sight-Key konfiguriert (RMM_API_KEY)."), { status: 400 });

  const servers = resolvedServer ? [resolvedServer] : cfg.candidates;
  const errors = [];
  for (const srv of servers) {
    try {
      const result = await xmlGet(srv, "list_clients");
      resolvedServer = srv;
      const clients = asArray(result.items && result.items.client)
        .filter(Boolean)
        .map(c => ({ id: String(c.clientid || "").trim(), name: String(c.name || "").trim() }))
        .filter(c => c.id);
      return { server: srv, clients };
    } catch (e) {
      errors.push(`[${srv}] ${e.message}`);
    }
  }
  resolvedServer = null;
  throw Object.assign(
    new Error("Kein N-sight-Server erreichbar. " + errors.join("   ||   ")),
    { status: 502 }
  );
}

async function listSites(clientid) {
  const cfg = config();
  if (!cfg.enabled) throw Object.assign(new Error("Kein N-sight-Key konfiguriert."), { status: 400 });
  if (!clientid) throw Object.assign(new Error("Keine clientid."), { status: 400 });

  // Server muss bekannt sein - notfalls ueber list_clients aufloesen.
  if (!resolvedServer) await listClients();

  const result = await xmlGet(resolvedServer, "list_sites", { clientid });
  const sites = asArray(result.items && result.items.site)
    .filter(Boolean)
    .map(s => ({
      id: String(s.siteid || "").trim(),
      name: String(s.name || s.n || "").trim()
    }))
    .filter(s => s.id);
  return { server: resolvedServer, sites };
}

/**
 * Einen Download-Versuch. Liefert true, wenn wirklich eine Datei gestreamt
 * wurde - false, wenn die API stattdessen XML (= Fehler/kein Build) schickt.
 */
async function tryStream(server, extra, res) {
  const url = buildUrl(server, "get_site_installation_package", extra);
  let r;
  try {
    r = await fetch(url, {
      headers: { "User-Agent": UA },
      redirect: "follow",
      signal: AbortSignal.timeout(600000)
    });
  } catch (e) { return false; }
  if (!r.ok || !r.body) return false;

  const reader = r.body.getReader();
  let first;
  try { first = await reader.read(); } catch (e) { return false; }
  if (first.done || !first.value || first.value.length === 0) {
    try { await reader.cancel(); } catch (e) {}
    return false;
  }

  // Reinschauen: XML = Fehlerantwort, keine Datei.
  const peek = Buffer.from(first.value.slice(0, 200)).toString("latin1");
  if (/^\s*<\?xml/.test(peek) || /<result\b/.test(peek)) {
    try { await reader.cancel(); } catch (e) {}
    return false;
  }

  const fallback = extra.type === "group_policy" ? "RMM-GroupPolicy-Package.zip" : "RMM-Agent-Setup.exe";
  const fileName = fileNameFromDisposition(r.headers.get("content-disposition"), fallback);

  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  res.setHeader("Cache-Control", "no-store");
  const len = r.headers.get("content-length");
  if (len) res.setHeader("Content-Length", len);

  // Ersten Chunk (schon gelesen) voranstellen, Rest hinterherstreamen.
  async function* body() {
    yield Buffer.from(first.value);
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield Buffer.from(value);
    }
  }
  await new Promise((resolve, reject) => {
    Readable.from(body()).on("error", reject).pipe(res).on("finish", resolve).on("error", reject);
  });
  return true;
}

/**
 * Agent-Paket holen. Reihenfolge wie im Original: erst 'authenticate'
 * (stoesst den Build an / liefert die echte Fehlermeldung), dann der
 * eigentliche Download-Modus, dann ohne Modus als Fallback.
 */
async function downloadAgent({ endcustomerid, siteid, type, os }, res) {
  const cfg = config();
  if (!cfg.enabled) throw Object.assign(new Error("Kein N-sight-Key konfiguriert."), { status: 400 });
  if (!endcustomerid || !siteid) throw Object.assign(new Error("endcustomerid/siteid fehlt."), { status: 400 });

  if (!resolvedServer) await listClients();
  const server = resolvedServer;

  const useOs = os && String(os).trim() ? String(os).trim() : "windows";
  const useType = type && String(type).trim() ? String(type).trim() : "remote_worker";
  const dlMode = useType === "group_policy" ? "downloadgp" : "downloadrwbuild";
  const base = { endcustomerid, siteid, os: useOs, type: useType };

  let authMsg = null;
  try { await xmlGet(server, "get_site_installation_package", { ...base, mode: "authenticate" }); }
  catch (e) { authMsg = e.message; }

  if (await tryStream(server, { ...base, mode: dlMode }, res)) return;
  if (await tryStream(server, base, res)) return;

  throw Object.assign(
    new Error("Agent-Download fehlgeschlagen: " +
      (authMsg || "Keine Datei zurueck. Berechtigung 'Site Installation Package' pruefen.")),
    { status: 502 }
  );
}

module.exports = { config, listClients, listSites, downloadAgent };
