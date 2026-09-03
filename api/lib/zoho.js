"use strict";
/**
 * Zoho CRM — nur lesend, nur Deals. Fuer den SDP-CRM-Matcher im /plan/-Dashboard:
 * zeigt an, ob ein SDP-Projekt bereits einen Zoho-Deal hat (Serges Vorgabe
 * "kein Angebot ohne Deal", siehe [[offerte-immer-deal-im-crm]] in Nils' Memory).
 *
 * Gleiches OAuth-Muster wie im bestehenden igeeks-offerten-tool
 * (offerten-tool/lib/zoho.js): Self-Client mit Refresh-Token, EU-Rechenzentrum.
 * Bewusst read-only (kein ZohoCRM.modules.ALL) -- dieses Werkzeug schreibt nichts.
 *
 * Einzurichten in der Zoho API Console (https://api-console.zoho.eu):
 *   1. Self Client anlegen
 *   2. Scope: ZohoCRM.modules.deals.READ,ZohoCRM.settings.modules.READ
 *   3. Erzeugten Code binnen 3 Minuten gegen ein Refresh-Token tauschen:
 *      curl -X POST "https://accounts.zoho.eu/oauth/v2/token" \
 *        -d grant_type=authorization_code -d client_id=... \
 *        -d client_secret=... -d code=...
 *   4. client_id/client_secret/refresh_token als ZOHO_CLIENT_ID/ZOHO_CLIENT_SECRET/
 *      ZOHO_REFRESH_TOKEN setzen (Secrets, nie ins Repo).
 */

const ORG_ID = "20066824835"; // igeeks CRM-Org, siehe Nils' Memory zoho-crm-records-connector

function config() {
  const region = (process.env.ZOHO_REGION || "eu").trim();
  const clientId = (process.env.ZOHO_CLIENT_ID || "").trim();
  const clientSecret = (process.env.ZOHO_CLIENT_SECRET || "").trim();
  const refreshToken = (process.env.ZOHO_REFRESH_TOKEN || "").trim();
  return {
    enabled: !!(clientId && clientSecret && refreshToken),
    region, clientId, clientSecret, refreshToken,
    authUrl: `https://accounts.zoho.${region}/oauth/v2/token`,
    apiUrl: `https://www.zohoapis.${region}/crm/v6`,
  };
}

let cachedToken = null;
let tokenExpiresAt = 0;

async function accessToken() {
  const cfg = config();
  if (!cfg.enabled) throw Object.assign(new Error("Zoho ist nicht konfiguriert (ZOHO_CLIENT_ID/ZOHO_CLIENT_SECRET/ZOHO_REFRESH_TOKEN)."), { status: 400 });
  if (cachedToken && Date.now() < tokenExpiresAt - 60000) return cachedToken;
  const p = new URLSearchParams({
    refresh_token: cfg.refreshToken, client_id: cfg.clientId, client_secret: cfg.clientSecret,
    grant_type: "refresh_token",
  });
  const r = await fetch(cfg.authUrl + "?" + p, { method: "POST" });
  const d = await r.json().catch(() => ({}));
  if (!d.access_token) throw Object.assign(new Error("Zoho-Anmeldung fehlgeschlagen: " + (d.error || JSON.stringify(d))), { status: 502 });
  cachedToken = d.access_token;
  tokenExpiresAt = Date.now() + Number(d.expires_in || 3600) * 1000;
  return cachedToken;
}

async function call(path, params) {
  const cfg = config();
  const t = await accessToken();
  const url = cfg.apiUrl + path + (params ? "?" + new URLSearchParams(params) : "");
  const r = await fetch(url, { headers: { Authorization: "Zoho-oauthtoken " + t } });
  if (r.status === 204) return { data: [] };
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`Zoho ${r.status}: ${d && d.message ? d.message : JSON.stringify(d)}`), { status: r.status === 401 ? 502 : r.status });
  return d;
}

/** Deal-Weblink im UI-Format (tab/Potentials, nicht /Deals -- siehe Memory). */
function dealUrl(id) {
  return `https://crm.zoho.${config().region}/crm/org${ORG_ID}/tab/Potentials/${id}`;
}

/**
 * Alle zuletzt geänderten Deals (fuer den Namensabgleich). Zoho liefert max. 200/Seite;
 * fuer den Matcher reichen die letzten paar hundert -- ein Deal zu einem aktiven
 * SDP-Projekt ist so gut wie nie älter als das.
 */
async function recentDeals(maxPages) {
  const pages = maxPages || 3;
  const out = [];
  for (let page = 1; page <= pages; page++) {
    const d = await call("/Deals", { per_page: 200, page, sort_by: "Modified_Time", sort_order: "desc",
      fields: "Deal_Name,Account_Name,Stage,Closing_Date,Owner" });
    const rows = d.data || [];
    for (const x of rows) {
      out.push({
        id: x.id, name: x.Deal_Name || "",
        account: (x.Account_Name && x.Account_Name.name) || "",
        stage: (x.Stage) || "",
        owner: (x.Owner && x.Owner.name) || "",
        url: dealUrl(x.id),
      });
    }
    if (rows.length < 200) break;
  }
  return out;
}

module.exports = { config, recentDeals, dealUrl, ORG_ID };
