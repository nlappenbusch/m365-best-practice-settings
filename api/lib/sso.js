/**
 * SSO-Login ueber den iGeeks-M365-Tenant (OIDC Authorization Code Flow,
 * Confidential Client). Dient AUSSCHLIESSLICH der Authentifizierung am Tool —
 * nicht dem Management des iGeeks-Tenants (dafuer gibt es das normale
 * Tenant-Onboarding).
 *
 * Sicherheitsmodell:
 *  - Nur Konten aus dem konfigurierten Tenant (tid-Claim) werden akzeptiert.
 *  - state-Parameter gegen CSRF, nonce gegen Token-Replay — beide in der
 *    Server-Session gehalten und nach einmaliger Verwendung geloescht.
 *  - Der ID-Token kommt direkt vom Microsoft-Token-Endpoint ueber TLS
 *    (Code-Exchange mit Client-Secret). Nach OIDC Core 3.1.3.7 darf die
 *    Signaturpruefung dann entfallen; die Claims (iss/aud/tid/nonce/exp)
 *    werden trotzdem strikt geprueft.
 */
const crypto = require("crypto");

const AUTH_BASE = "https://login.microsoftonline.com";

function isConfigured(sso) {
  return !!(sso && sso.tenantId && sso.clientId && sso.clientSecret);
}

/** Redirect-URI aus dem Request ableiten (hinter nginx: trust proxy ist gesetzt). */
function redirectUri(req) {
  return `${req.protocol}://${req.get("host")}/api/auth/sso/callback`;
}

/** Authorize-URL bauen + state/nonce in der Session ablegen. */
function buildAuthorizeUrl(req, sso) {
  const state = crypto.randomBytes(24).toString("base64url");
  const nonce = crypto.randomBytes(24).toString("base64url");
  req.session.ssoFlow = { state, nonce, startedAt: Date.now() };
  const p = new URLSearchParams({
    client_id: sso.clientId,
    response_type: "code",
    redirect_uri: redirectUri(req),
    response_mode: "query",
    scope: "openid profile email",
    state, nonce
  });
  return `${AUTH_BASE}/${encodeURIComponent(sso.tenantId)}/oauth2/v2.0/authorize?${p}`;
}

function decodeJwtPayload(jwt) {
  const parts = String(jwt || "").split(".");
  if (parts.length !== 3) throw new Error("Ungueltiges ID-Token-Format.");
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
}

/**
 * Callback verarbeiten: state pruefen, Code gegen Token tauschen, Claims
 * validieren. Rueckgabe: { upn, name } des angemeldeten iGeeks-Nutzers.
 */
async function handleCallback(req, sso) {
  const flow = req.session.ssoFlow;
  delete req.session.ssoFlow; // einmalig verwendbar, auch bei Fehlern
  const q = req.query || {};
  if (q.error) throw new Error(q.error_description || q.error);
  if (!flow || !q.state || q.state !== flow.state) throw new Error("Ungueltiger oder abgelaufener Anmeldevorgang (state) — bitte erneut anmelden.");
  if (Date.now() - flow.startedAt > 10 * 60 * 1000) throw new Error("Anmeldevorgang abgelaufen — bitte erneut anmelden.");
  if (!q.code) throw new Error("Kein Autorisierungscode erhalten.");

  const body = new URLSearchParams({
    client_id: sso.clientId,
    client_secret: sso.clientSecret,
    grant_type: "authorization_code",
    code: q.code,
    redirect_uri: redirectUri(req),
    scope: "openid profile email"
  });
  const r = await fetch(`${AUTH_BASE}/${encodeURIComponent(sso.tenantId)}/oauth2/v2.0/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Token-Austausch fehlgeschlagen: " + (j.error_description || j.error || r.status));

  const claims = decodeJwtPayload(j.id_token);
  if (claims.aud !== sso.clientId) throw new Error("ID-Token: falsche Audience.");
  if (String(claims.tid || "").toLowerCase() !== String(sso.tenantId).toLowerCase()) {
    throw new Error("Anmeldung abgelehnt: Konto gehoert nicht zum konfigurierten Tenant.");
  }
  if (!String(claims.iss || "").includes(claims.tid)) throw new Error("ID-Token: unerwarteter Issuer.");
  if (claims.nonce !== flow.nonce) throw new Error("ID-Token: nonce stimmt nicht ueberein.");
  if (claims.exp && Date.now() / 1000 > claims.exp + 60) throw new Error("ID-Token bereits abgelaufen.");

  return {
    upn: claims.preferred_username || claims.email || claims.oid,
    name: claims.name || claims.preferred_username || "SSO-Nutzer"
  };
}

module.exports = { isConfigured, redirectUri, buildAuthorizeUrl, handleCallback };
