"use strict";
/**
 * Bitwarden-Desktop-App (Windows) — Release aufloesen, Installer + Offline-Paket
 * holen, fuer den Intune-Win32-Upload vorbereiten.
 *
 * Warum ein eigenes Modul statt "URL im Frontend eintippen" (wie FortiClient):
 * Bitwarden liefert den Windows-Client als **electron-builder "nsis-web"**-
 * Installer aus. Die heruntergeladene `Bitwarden-Installer-<ver>.exe` ist nur
 * ein ~0,7-MB-Stub — die eigentlichen ~125 MB liegen daneben als
 * `bitwarden-<ver>-<arch>.nsis.7z` und werden vom Stub WAEHREND der Installation
 * aus dem Internet nachgeladen. Fuer ein Intune-Deployment ist das die schlechte
 * Variante:
 *   - das Geraet braucht im SYSTEM-Kontext freien Zugriff auf github.com bzw.
 *     release-assets.githubusercontent.com (Proxy/Firewall killt das gerne), und
 *   - schlaegt der Download fehl, zeigt der NSIS-Stub eine MessageBox
 *     (MB_RETRYCANCEL) an, die im SYSTEM-Kontext niemand sieht — die Installation
 *     haengt bis zum Intune-Timeout.
 * electron-builder dokumentiert dafuer den Offline-Weg: liegt die Paketdatei im
 * SELBEN Ordner wie der Installer, wird sie automatisch erkannt und verwendet
 * (Pruefsumme wird geprueft) statt aus dem Internet geladen. Genau das bauen wir:
 * Stub + passende .nsis.7z landen zusammen im Intune-Paket (die
 * extraFiles-Mechanik gibt es dank FortiClient/.mst bereits).
 * Quelle: electron-builder-Doku "NSIS → Web Installer".
 *
 * Bitwarden-Cloud-Hosting (kein Self-Hosting): der Installer ist derselbe, die
 * Server-Region waehlt der Benutzer beim Login bzw. wird per Client-Konfiguration
 * vorgegeben — dafuer gibt es die Registry-Presets in lib/registryPolicy.js
 * ("bitwarden-*"), nicht diesen Upload hier.
 */
const crypto = require("crypto");
const { Readable } = require("stream");

// Offizieller Einstiegspunkt von bitwarden.com/download — antwortet mit 302 auf
// das GitHub-Release-Asset der jeweils aktuellen Version. Wir folgen dem Redirect
// bewusst NICHT automatisch: aus dem Location-Header lesen wir Version und Tag,
// und darueber kommen wir an die `latest.yml` mit Paketnamen und Pruefsummen.
const RELEASE_ENTRY = "https://vault.bitwarden.com/download/?app=desktop&platform=windows";

// Nur diese Hosts duerfen heruntergeladen werden. Alles hier ist von uns
// konstruiert (nie Benutzereingabe), die Pruefung ist die zweite Schranke gegen
// einen versehentlich offenen Proxy.
const ALLOWED_HOSTS = new Set(["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"]);
const RELEASE_URL_RE = /^https:\/\/github\.com\/bitwarden\/clients\/releases\/download\/(desktop-v([0-9][0-9A-Za-z.-]*))\/([A-Za-z0-9._-]+\.exe)$/;
const PACKAGE_NAME_RE = /^[A-Za-z0-9._-]+\.7z$/;

// Architekturen, die wir als Offline-Paket mitliefern koennen. ia32 (32-Bit)
// laesst Bitwarden zwar weiter mitbauen, auf verwalteten Geraeten 2026 ist es
// aber tot — wir bieten es bewusst nicht an.
const SUPPORTED_ARCHS = ["x64", "arm64"];

const CACHE_MS = 30 * 60 * 1000;
let releaseCache = null; // { at, release }

function httpError(msg, status) { return Object.assign(new Error(msg), { status: status || 502 }); }

function assertAllowedUrl(raw) {
  let u;
  try { u = new URL(raw); } catch (e) { throw httpError("Ungueltige Bitwarden-Download-URL.", 400); }
  if (u.protocol !== "https:" || !ALLOWED_HOSTS.has(u.hostname.toLowerCase())) {
    throw httpError("Download-URL nicht erlaubt (nur GitHub-Release-Assets von bitwarden/clients).", 400);
  }
  return u;
}

/**
 * Minimal-Parser fuer den `packages:`-Block der electron-builder-`latest.yml`.
 * Kein YAML-Paket als Dependency fuer 20 Zeilen immer gleich aufgebautes YAML:
 *
 *   packages:
 *     x64:
 *       size: 127653942
 *       sha512: <base64>
 *       path: bitwarden-2026.8.0-x64.nsis.7z
 *       file: bitwarden-2026.8.0-x64.nsis.7z
 */
function parsePackages(yml) {
  const out = [];
  let inPackages = false;
  let cur = null;
  for (const line of String(yml || "").split(/\r?\n/)) {
    if (/^packages:\s*$/.test(line)) { inPackages = true; continue; }
    if (!inPackages) continue;
    if (/^\S/.test(line)) break; // naechster Top-Level-Schluessel -> Block zu Ende
    const arch = /^ {2}([A-Za-z0-9_]+):\s*$/.exec(line);
    if (arch) { cur = { arch: arch[1], file: null, size: 0, sha512: null }; out.push(cur); continue; }
    if (!cur) continue;
    const kv = /^ {4}([A-Za-z0-9_]+):\s*(.+?)\s*$/.exec(line);
    if (!kv) continue;
    const val = kv[2].replace(/^['"]|['"]$/g, "");
    if (kv[1] === "size") cur.size = Number(val) || 0;
    else if (kv[1] === "sha512") cur.sha512 = val;
    // `path` steht vor `file` und ist derselbe Wert; `file` gewinnt.
    else if (kv[1] === "file" || (kv[1] === "path" && !cur.file)) cur.file = val;
  }
  // Dateinamen kommen aus einer fremden Datei und landen als Zip-Eintrag und in
  // einer URL -- nur schlichte Dateinamen zulassen, keine Pfade.
  return out.filter(p => p.file && PACKAGE_NAME_RE.test(p.file));
}

/** sha512 der `latest.yml` fuer den Installer selbst (Top-Level-Schluessel). */
function parseInstallerSha512(yml) {
  const m = /^sha512:\s*(\S+)\s*$/m.exec(String(yml || ""));
  return m ? m[1] : null;
}

async function fetchText(url) {
  const u = assertAllowedUrl(url);
  let r;
  try { r = await fetch(u, { redirect: "follow", signal: AbortSignal.timeout(60000) }); }
  catch (e) { throw httpError("Bitwarden-Release nicht erreichbar: " + e.message); }
  if (!r.ok) throw httpError(`Bitwarden-Release-Datei nicht ladbar (HTTP ${r.status}): ${u.pathname.split("/").pop()}`);
  return await r.text();
}

/**
 * Aktuelles Windows-Desktop-Release aufloesen (Version, Tag, Installer-Name,
 * Offline-Pakete inkl. Groesse und Pruefsumme). Ergebnis wird 30 Minuten
 * zwischengespeichert -- das Release wechselt monatlich, nicht minuetlich.
 */
async function resolveRelease(force) {
  if (!force && releaseCache && Date.now() - releaseCache.at < CACHE_MS) return releaseCache.release;

  let r;
  try { r = await fetch(RELEASE_ENTRY, { redirect: "manual", signal: AbortSignal.timeout(30000) }); }
  catch (e) { throw httpError("bitwarden.com/download nicht erreichbar: " + e.message); }

  const loc = r.headers.get("location");
  if (!loc) throw httpError(`bitwarden.com/download hat nicht auf ein Release verwiesen (HTTP ${r.status}).`);
  const m = RELEASE_URL_RE.exec(loc);
  if (!m) throw httpError("Unerwartetes Download-Ziel von bitwarden.com: " + loc);

  const [, tag, version, installerName] = m;
  const baseUrl = `https://github.com/bitwarden/clients/releases/download/${tag}`;
  const yml = await fetchText(`${baseUrl}/latest.yml`);
  const packages = parsePackages(yml).filter(p => SUPPORTED_ARCHS.includes(p.arch));
  if (!packages.length) throw httpError("In der latest.yml von Bitwarden stand kein verwendbares Offline-Paket.");

  // Groesse des Stubs steht nicht in der latest.yml -- einmal nachfragen, damit
  // das Frontend "Web-Installer (0,7 MB)" vs. "Offline (122 MB)" zeigen kann.
  let installerSize = 0;
  try {
    const h = await fetch(`${baseUrl}/${installerName}`, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(30000) });
    installerSize = Number(h.headers.get("content-length")) || 0;
  } catch (e) { /* nur Kosmetik */ }

  const release = {
    version, tag, baseUrl, installerName, installerSize,
    installerSha512: parseInstallerSha512(yml),
    packages
  };
  releaseCache = { at: Date.now(), release };
  return release;
}

/** Fuer das Frontend: nur die Felder, die dort angezeigt werden. */
async function releaseInfo(force) {
  const rel = await resolveRelease(force);
  return {
    version: rel.version,
    installerName: rel.installerName,
    installerSize: rel.installerSize,
    packages: rel.packages.map(p => ({ arch: p.arch, file: p.file, size: p.size }))
  };
}

async function fetchVerified(url, expectedSha512Base64, label) {
  const u = assertAllowedUrl(url);
  let r;
  try { r = await fetch(u, { redirect: "follow", signal: AbortSignal.timeout(600000) }); }
  catch (e) { throw httpError(`Download von ${label} fehlgeschlagen: ${e.message}`); }
  if (!r.ok) throw httpError(`Download von ${label} fehlgeschlagen (HTTP ${r.status}).`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (expectedSha512Base64) {
    const actual = crypto.createHash("sha512").update(buf).digest("base64");
    if (actual !== expectedSha512Base64) {
      // Wichtig genug fuer einen harten Abbruch: der NSIS-Stub prueft die
      // Pruefsumme des Offline-Pakets selbst und wuerde bei einer Abweichung
      // stillschweigend wieder aus dem Internet nachladen -- also genau das,
      // was wir verhindern wollen.
      throw httpError(`Pruefsumme von ${label} stimmt nicht mit der latest.yml ueberein — Download verworfen.`);
    }
  }
  return buf;
}

/** "x64" | ["x64","arm64"] | "online" | leer -> saubere Liste (leer = Web-Installer). */
function normalizeArchs(raw) {
  if (raw === "online" || raw === null || raw === undefined) return [];
  const list = (Array.isArray(raw) ? raw : [raw]).map(a => String(a || "").trim().toLowerCase()).filter(Boolean);
  const out = [];
  for (const a of list) {
    if (a === "online") continue;
    if (!SUPPORTED_ARCHS.includes(a)) throw httpError(`Unbekannte Architektur '${a}' (erlaubt: ${SUPPORTED_ARCHS.join(", ")}).`, 400);
    if (!out.includes(a)) out.push(a);
  }
  return out;
}

/**
 * Dateien fuer den Intune-Win32-Upload holen.
 * opts: { architectures: ["x64"] | [] , onProgress(label) }
 * Rueckgabe passt 1:1 auf createWin32AppWithContent({ installerBuffer, setupFileName, extraFiles }).
 */
async function fetchDesktopFiles(opts) {
  const o = opts || {};
  const onProgress = o.onProgress || (() => {});
  const archs = normalizeArchs(o.architectures);
  const rel = await resolveRelease();

  onProgress(`Installer laden (${rel.installerName})`);
  const buffer = await fetchVerified(`${rel.baseUrl}/${rel.installerName}`, rel.installerSha512, rel.installerName);

  const extraFiles = [];
  for (const arch of archs) {
    const pkg = rel.packages.find(p => p.arch === arch);
    if (!pkg) throw httpError(`Bitwarden ${rel.version} liefert kein ${arch}-Offline-Paket.`, 400);
    onProgress(`Offline-Paket ${arch} laden (${Math.round(pkg.size / 1048576)} MB)`);
    const data = await fetchVerified(`${rel.baseUrl}/${pkg.file}`, pkg.sha512, pkg.file);
    // store: keine Deflate-Runde ueber ein bereits LZMA-gepacktes Archiv --
    // das kostet nur Zeit und Speicher und bringt null Byte.
    extraFiles.push({ name: pkg.file, data, store: true });
  }

  return { buffer, fileName: rel.installerName, extraFiles, version: rel.version, architectures: archs };
}

/** Manueller Download aus dem Tab (Stub oder Offline-Paket). */
async function streamDownload({ what, arch }, res) {
  const rel = await resolveRelease();
  let url, fileName;
  if (what === "package") {
    const a = normalizeArchs(arch)[0];
    const pkg = a && rel.packages.find(p => p.arch === a);
    if (!pkg) throw httpError("Offline-Paket fuer diese Architektur gibt es in diesem Release nicht.", 400);
    url = `${rel.baseUrl}/${pkg.file}`; fileName = pkg.file;
  } else {
    url = `${rel.baseUrl}/${rel.installerName}`; fileName = rel.installerName;
  }

  const u = assertAllowedUrl(url);
  let r;
  try { r = await fetch(u, { redirect: "follow", signal: AbortSignal.timeout(600000) }); }
  catch (e) { throw httpError("Download fehlgeschlagen: " + e.message); }
  if (!r.ok || !r.body) throw httpError(`Download fehlgeschlagen (HTTP ${r.status}).`);

  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  res.setHeader("Cache-Control", "no-store");
  const len = r.headers.get("content-length");
  if (len) res.setHeader("Content-Length", len);
  Readable.fromWeb(r.body).pipe(res);
}

module.exports = {
  SUPPORTED_ARCHS, resolveRelease, releaseInfo, fetchDesktopFiles, streamDownload,
  normalizeArchs, parsePackages, parseInstallerSha512
};
