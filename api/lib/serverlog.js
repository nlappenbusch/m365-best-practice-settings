/**
 * Ring-Buffer der letzten Server-Log-Zeilen.
 *
 * Hintergrund: seit dem GitOps-Deploy laeuft die API als Pod im Cluster —
 * "docker logs" gibt es dort nicht mehr, und `kubectl logs` hat nicht jeder
 * zur Hand. Damit ein 500er nicht blind bleibt, landen alle console-Ausgaben
 * zusaetzlich in diesem Puffer und sind ueber /api/serverlog (nur angemeldet)
 * abrufbar. Der stdout-Weg bleibt unveraendert, kubectl/ArgoCD sehen dasselbe.
 *
 * Vorsicht Geheimnisse: beim ersten Start schreibt der Server das generierte
 * Admin-Passwort ins Log, und Fehlermeldungen koennen Tokens enthalten. Alles,
 * was danach aussieht, wird vor dem Ablegen im Puffer maskiert.
 */
const MAX_ENTRIES = 400;

const entries = [];
let installed = false;

const REDACTIONS = [
  [/(Passwort:\s*)\S+/gi, "$1<redigiert>"],
  [/(Bearer\s+)[A-Za-z0-9._~+/-]{20,}=*/g, "$1<redigiert>"],
  [/eyJ[A-Za-z0-9._-]{20,}/g, "<jwt redigiert>"],
  [/((?:client_secret|secret|token|api[_-]?key|password|passwort)["']?\s*[:=]\s*["']?)([^\s"',;}]{8,})/gi, "$1<redigiert>"],
  // GitLab-/Graph-artige Schluessel, die frei im Text stehen
  [/\bglpat-[A-Za-z0-9_-]{10,}/g, "<redigiert>"]
];

function redact(text) {
  let out = String(text);
  for (const [re, replacement] of REDACTIONS) out = out.replace(re, replacement);
  return out;
}

function format(args) {
  return args.map(a => {
    if (typeof a === "string") return a;
    if (a instanceof Error) return a.stack || a.message;
    try { return JSON.stringify(a); } catch (e) { return String(a); }
  }).join(" ");
}

function push(level, args) {
  entries.push({ ts: new Date().toISOString(), level, msg: redact(format(args)).slice(0, 4000) });
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
}

/** Haengt sich in console.* ein — die Originalausgabe bleibt erhalten. */
function install() {
  if (installed) return;
  installed = true;
  for (const level of ["log", "info", "warn", "error"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      try { push(level, args); } catch (e) { /* Logging darf nie werfen */ }
      original(...args);
    };
  }
}

/** Neueste zuletzt. limit begrenzt auf die letzten n Zeilen. */
function list(limit) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 200, 1), MAX_ENTRIES);
  return entries.slice(-n);
}

module.exports = { install, list, redact, MAX_ENTRIES };
