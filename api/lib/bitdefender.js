"use strict";
/**
 * Bitdefender GravityZone — Agent-Pakete auflisten + Installer herunterladen.
 *
 * Portiert aus dem PowerShell-Agent-Downloader (RMM & Bitdefender Helper).
 * Der API-Key bleibt serverseitig: das Frontend bekommt nur Paketnamen und
 * spricht den Download ueber unseren Proxy an — der Key landet nie im Browser.
 *
 * API: JSON-RPC 2.0 auf https://<host>/api/v1.0/jsonrpc/<endpoint>
 * Auth: Basic mit dem API-Key als Benutzer und leerem Passwort.
 */

const { Readable } = require("stream");
const { fileNameFromDisposition, sanitizeFileName } = require("./httputil");

const DEFAULT_HOST = "cloudgz.gravityzone.bitdefender.com";

function config() {
  const host = (process.env.BD_HOST || DEFAULT_HOST).trim();
  const key = (process.env.BD_API_KEY || "").trim();
  return {
    host,
    enabled: key.length > 0,
    authHeader: key ? "Basic " + Buffer.from(key + ":", "utf8").toString("base64") : null
  };
}

/** Freundliche Meldung statt nackter HTTP-Codes. */
function friendlyHttpError(status) {
  if (status === 401 || status === 403) {
    return `Auth fehlgeschlagen (${status}). Bitdefender-Key pruefen und ob die API 'Packages' aktiviert ist.`;
  }
  if (status === 429) return "Rate-Limit (429). Kurz warten und erneut versuchen.";
  return `Bitdefender HTTP ${status}.`;
}

async function rpc(endpoint, method, params = {}) {
  const cfg = config();
  if (!cfg.enabled) throw Object.assign(new Error("Kein Bitdefender-Key konfiguriert (BD_API_KEY)."), { status: 400 });

  const url = `https://${cfg.host}/api/v1.0/jsonrpc/${endpoint}`;
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: require("crypto").randomUUID(),
    method,
    params
  });

  let r;
  try {
    r = await fetch(url, {
      method: "POST",
      headers: { Authorization: cfg.authHeader, "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(60000)
    });
  } catch (e) {
    throw Object.assign(new Error("Bitdefender nicht erreichbar: " + e.message), { status: 502 });
  }

  if (!r.ok) throw Object.assign(new Error(friendlyHttpError(r.status)), { status: 502 });

  let data;
  try { data = await r.json(); } catch (e) {
    throw Object.assign(new Error("Unerwartete Bitdefender-Antwort (kein JSON)."), { status: 502 });
  }
  if (data && data.error) {
    const det = (data.error.data && data.error.data.details) || data.error.message || "Unbekannter Fehler";
    throw Object.assign(new Error(`Bitdefender API-Fehler ${data.error.code}: ${det}`), { status: 502 });
  }
  return data ? data.result : null;
}

/** Alle Installationspakete (nur die Felder, die das Frontend braucht). */
async function listPackages() {
  const result = await rpc("packages", "getInstallationLinks", {});
  const arr = Array.isArray(result) ? result : (result ? [result] : []);
  return arr.map(p => ({
    packageName: p.packageName,
    installLinkWindows: p.installLinkWindows,
    fullKitWindowsX64: p.fullKitWindowsX64,
    fullKitWindowsX32: p.fullKitWindowsX32,
    fullKitWindowsArm64: p.fullKitWindowsArm64
  }));
}

/**
 * Installer streamen. Die URL kommt aus getInstallationLinks, wird aber
 * trotzdem geprueft (nur https + exakt unser GravityZone-Host) — sonst waere
 * der Endpunkt ein offener Proxy (SSRF).
 */
async function streamDownload(rawUrl, res) {
  const cfg = config();
  if (!cfg.enabled) throw Object.assign(new Error("Kein Bitdefender-Key konfiguriert."), { status: 400 });

  let u;
  try { u = new URL(rawUrl); } catch (e) {
    throw Object.assign(new Error("Ungueltige URL."), { status: 400 });
  }
  if (u.protocol !== "https:" || u.hostname.toLowerCase() !== cfg.host.toLowerCase()) {
    throw Object.assign(new Error("URL nicht erlaubt (nur GravityZone-Host)."), { status: 400 });
  }

  let r;
  try {
    r = await fetch(u, {
      headers: { Authorization: cfg.authHeader },
      redirect: "follow",
      signal: AbortSignal.timeout(600000)
    });
  } catch (e) {
    throw Object.assign(new Error("Download fehlgeschlagen: " + e.message), { status: 502 });
  }
  if (!r.ok || !r.body) {
    throw Object.assign(new Error(`Download fehlgeschlagen (HTTP ${r.status}).`), { status: 502 });
  }

  // Fallback-Name aus dem letzten URL-Segment, wenn es nach Installer aussieht.
  let fallback = "BitdefenderSetup.exe";
  const seg = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() || "");
  if (/\.(exe|tar|dmg|gz|msi)$/i.test(seg)) fallback = seg;
  const fileName = fileNameFromDisposition(r.headers.get("content-disposition"), fallback);

  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  res.setHeader("Cache-Control", "no-store");
  const len = r.headers.get("content-length");
  if (len) res.setHeader("Content-Length", len);

  Readable.fromWeb(r.body).pipe(res);
}

/**
 * Wie streamDownload, liefert den Installer aber als Buffer zurueck statt an
 * eine Response zu streamen — fuer den Intune-App-Upload (Bytes muessen erst
 * verschluesselt werden, bevor irgendetwas den Prozess verlaesst).
 */
async function fetchInstallerBuffer(rawUrl) {
  const cfg = config();
  if (!cfg.enabled) throw Object.assign(new Error("Kein Bitdefender-Key konfiguriert."), { status: 400 });

  let u;
  try { u = new URL(rawUrl); } catch (e) {
    throw Object.assign(new Error("Ungueltige URL."), { status: 400 });
  }
  if (u.protocol !== "https:" || u.hostname.toLowerCase() !== cfg.host.toLowerCase()) {
    throw Object.assign(new Error("URL nicht erlaubt (nur GravityZone-Host)."), { status: 400 });
  }

  let r;
  try {
    r = await fetch(u, { headers: { Authorization: cfg.authHeader }, redirect: "follow", signal: AbortSignal.timeout(600000) });
  } catch (e) {
    throw Object.assign(new Error("Download fehlgeschlagen: " + e.message), { status: 502 });
  }
  if (!r.ok || !r.body) throw Object.assign(new Error(`Download fehlgeschlagen (HTTP ${r.status}).`), { status: 502 });

  let fallback = "BitdefenderSetup.exe";
  const seg = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() || "");
  if (/\.(exe|tar|dmg|gz|msi)$/i.test(seg)) fallback = seg;
  const fileName = fileNameFromDisposition(r.headers.get("content-disposition"), fallback);

  const buffer = Buffer.from(await r.arrayBuffer());
  return { buffer, fileName };
}

module.exports = { config, listPackages, streamDownload, fetchInstallerBuffer };
