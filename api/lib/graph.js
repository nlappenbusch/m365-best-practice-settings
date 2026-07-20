/**
 * Microsoft Graph app-only pro Tenant: Token via Client-Assertion (JWT, signiert
 * mit dem Tenant-Zertifikat aus state/cert/<tenantId>.pem) — gleiches Muster wie
 * die EXO-Verbindung, nur direkt in Node ohne pwsh.
 *
 * Voraussetzung: Die App-Registrierung hat die noetigen Graph-Application-
 * Permissions (setzt Onboarding/Fixer): DeviceManagementConfiguration.ReadWrite.All,
 * Group.Read.All.
 */
const fs = require("fs");
const crypto = require("crypto");

const GRAPH_V1 = "https://graph.microsoft.com/v1.0";
const GRAPH_BETA = "https://graph.microsoft.com/beta";

const tokenCache = new Map(); // tenantId -> { value, exp }

function clientAssertion(tenant, pem, thumbHex) {
  const tokenUrl = `https://login.microsoftonline.com/${tenant.tenantId}/oauth2/v2.0/token`;
  const now = Math.floor(Date.now() / 1000);
  const b64 = o => Buffer.from(JSON.stringify(o)).toString("base64url");
  const x5t = Buffer.from(thumbHex.replace(/[^0-9a-fA-F]/g, ""), "hex").toString("base64url");
  const head = b64({ alg: "RS256", typ: "JWT", x5t });
  const body = b64({ aud: tokenUrl, iss: tenant.clientId, sub: tenant.clientId, jti: crypto.randomUUID(), nbf: now, iat: now, exp: now + 300 });
  const sig = crypto.createSign("RSA-SHA256").update(head + "." + body).sign(pem).toString("base64url");
  return `${head}.${body}.${sig}`;
}

async function getGraphToken(tenant, certPemPath) {
  const cached = tokenCache.get(tenant.tenantId);
  if (cached && Date.now() < cached.exp - 60000) return cached.value;

  const pem = fs.readFileSync(certPemPath, "utf8");
  const thumb = String(tenant.certThumbprint || "");
  if (!thumb) throw Object.assign(new Error("Kein Zertifikat-Thumbprint hinterlegt — Tenant neu onboarden."), { status: 412 });

  const url = `https://login.microsoftonline.com/${tenant.tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: tenant.clientId,
    grant_type: "client_credentials",
    scope: "https://graph.microsoft.com/.default",
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: clientAssertion(tenant, pem, thumb)
  });
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Graph-Token-Fehler: " + (j.error_description || j.error || r.status));
  tokenCache.set(tenant.tenantId, { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 });
  return j.access_token;
}

function clearTenantToken(tenantId) { tokenCache.delete(tenantId); }

// Manche Graph-Ressourcen sind nach dem Anlegen kurz nicht sofort ueberall
// lesbar/referenzierbar (Verzeichnis-Replikation) — betrifft v.a. frisch
// erzeugte Gruppen, die man direkt danach referenziert (Member hinzufuegen).
// Ausserdem antwortet windowsAutopilotDeviceIdentities in der Praxis gelegentlich
// mit einem transienten 5xx ("An internal server error has occurred") ohne
// erkennbaren Client-Fehler. opts.retryTransient aktiviert fuer beides ein
// Retry mit Backoff, bevor der Aufruf als fehlgeschlagen gilt.
function isTransientGraphError(status, message) {
  if (status >= 500) return true;
  if (status === 404) return true;
  if (status === 400 && /does not exist|not present/i.test(String(message || ""))) return true;
  return false;
}

/** Graph-Request app-only. path beginnt mit '/', opts.beta fuer beta-Endpoint. */
async function graphReq(tenant, certPemPath, method, path, body, opts) {
  const token = await getGraphToken(tenant, certPemPath);
  const base = (opts && opts.beta) ? GRAPH_BETA : GRAPH_V1;
  const url = path.startsWith("https://") ? path : base + path;
  const r = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}), ...(opts && opts.headers) },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let j; try { j = text ? JSON.parse(text) : {}; } catch { j = { raw: text }; }
  if (!r.ok) {
    // 401/403 einmal mit frischem Token wiederholen: nach Reparieren/Onboarding
    // kann noch ein gecachter Token OHNE die neuen Rollen im Umlauf sein.
    if ((r.status === 401 || r.status === 403) && !(opts && opts._retried)) {
      clearTenantToken(tenant.tenantId);
      return graphReq(tenant, certPemPath, method, path, body, { ...(opts || {}), _retried: true });
    }
    const msg = (j && j.error && j.error.message) ? j.error.message : (text || ("Graph " + r.status));
    if (opts && opts.retryTransient && isTransientGraphError(r.status, msg)) {
      // retryTransient: true = 5 Versuche; alternativ eine Zahl fuer Endpoints,
      // die laenger stoerrisch sind (z.B. windowsAutopilotDeviceIdentities).
      const maxTries = typeof opts.retryTransient === "number" ? opts.retryTransient : 5;
      const tries = (opts._transientTries || 0) + 1;
      if (tries <= maxTries) {
        await new Promise(res => setTimeout(res, 1500 * tries));
        return graphReq(tenant, certPemPath, method, path, body, { ...opts, _transientTries: tries });
      }
    }
    throw Object.assign(new Error(msg), { status: r.status });
  }
  return j;
}

/** Alle Seiten einer Graph-Collection einsammeln (@odata.nextLink). */
async function graphAllPages(tenant, certPemPath, path, opts) {
  let results = [];
  let resp = await graphReq(tenant, certPemPath, "GET", path, null, opts);
  for (;;) {
    results = results.concat(resp.value || []);
    if (!resp["@odata.nextLink"]) break;
    resp = await graphReq(tenant, certPemPath, "GET", resp["@odata.nextLink"], null, opts);
  }
  return results;
}

module.exports = { graphReq, graphAllPages, getGraphToken, clearTenantToken };
