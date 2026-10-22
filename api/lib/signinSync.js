"use strict";
const G = require("./graph");
function normalize(s) {
  return {
    id: s.id,
    at: s.createdDateTime,
    user: s.userPrincipalName || "",
    app: s.appDisplayName || "",
    country: s.location?.countryOrRegion || "Unbekannt",
    city: s.location?.city || "",
    latitude: s.location?.geoCoordinates?.latitude,
    longitude: s.location?.geoCoordinates?.longitude,
    success: s.status?.errorCode === 0,
    risk: !["none", "hidden", "unknownFutureValue", undefined].includes(
      s.riskLevelDuringSignIn,
    ),
  };
}
async function collectSignins(
  tenant,
  cert,
  { platform, signal, assertLease } = {},
) {
  if (!platform) throw new Error("Persistente Sync-Ablage fehlt.");
  const end = Date.now() - 120000,
    watermark = platform.cursor(tenant.id, "signins");
  const start = Math.max(
    end - 7 * 86400000,
    (watermark || end - 86400000) - 10 * 60000,
  );
  let next =
    "/auditLogs/signIns?$filter=" +
    encodeURIComponent(
      `createdDateTime ge ${new Date(start).toISOString()} and createdDateTime le ${new Date(end).toISOString()}`,
    ) +
    "&$top=1000";
  const seen = new Set(),
    events = [];
  while (next) {
    if (signal?.aborted)
      throw new Error("Sync abgebrochen: Worker-Lease verloren.");
    if (seen.has(next) || seen.size >= 100)
      throw new Error(
        "Sign-in-Pagination ist zyklisch oder überschreitet 100 Seiten. Cursor bleibt unverändert.",
      );
    seen.add(next);
    const page = await G.graphReq(tenant, cert, "GET", next, null, { signal });
    if (!Array.isArray(page.value))
      throw new Error("Ungültige Sign-in-Antwort. Cursor bleibt unverändert.");
    for (const s of page.value) {
      if (!s.id || !Number.isFinite(Date.parse(s.createdDateTime)))
        throw new Error("Sign-in ohne ID oder Zeitpunkt.");
      events.push(normalize(s));
    }
    next = page["@odata.nextLink"] || null;
    if (next) {
      const u = new URL(next);
      if (
        u.protocol !== "https:" ||
        u.hostname !== "graph.microsoft.com" ||
        u.port ||
        !/^\/v1\.0\/auditLogs\/signins$/i.test(u.pathname)
      )
        throw new Error(
          "Unerwarteter Graph-Folgelink. Cursor bleibt unverändert.",
        );
    }
  }
  if (signal?.aborted)
    throw new Error("Sync abgebrochen: Worker-Lease verloren.");
  assertLease?.();
  platform.commitSignins(tenant.id, events, end);
  return {
    metrics: [
      { label: "Gelesene Anmeldungen", value: events.length, state: "ok" },
      {
        label: "Risiko",
        value: events.filter((e) => e.risk).length,
        state: events.some((e) => e.risk) ? "warn" : "ok",
      },
    ],
    data: {
      from: new Date(start).toISOString(),
      until: new Date(end).toISOString(),
      read: events.length,
    },
    findings: [],
  };
}
module.exports = { collectSignins, normalize };
