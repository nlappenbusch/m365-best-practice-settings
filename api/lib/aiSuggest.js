"use strict";
/**
 * SDP-Ticket-Copilot: KI-Loesungsvorschlag ueber die Anthropic Messages API.
 *
 * Bewusst kein SDK-Abhaengigkeit -- wie graph.js/bitdefender.js/nsight.js
 * spricht dieses Modul die HTTP-API direkt per fetch() an.
 *
 * Laeuft komplett serverseitig-intern: die Tenant-Daten werden VOR dem
 * Aufruf hier bereits von den bestehenden Lib-Funktionen (licenses.js,
 * conditionalAccess.js, ...) geholt -- dieses Modul bekommt nur das fertig
 * zusammengestellte Kontext-Objekt, keinen Tenant/Cert-Zugriff selbst.
 */

const DEFAULT_MODEL = "claude-sonnet-4-5";
const API_URL = "https://api.anthropic.com/v1/messages";

function config() {
  const key = (process.env.ANTHROPIC_API_KEY || "").trim();
  const model = (process.env.ANTHROPIC_MODEL || DEFAULT_MODEL).trim();
  return { enabled: key.length > 0, key, model };
}

function buildPrompt(ticket, tenantContext) {
  const notesText = (ticket.notes || [])
    .map(n => `[${n.createdTime}] ${n.createdBy}: ${n.description}`)
    .join("\n") || "(keine Notizen)";

  let tenantSection = "Kein Tenant zugeordnet -- keine Live-Daten zum Abgleich verfuegbar.";
  if (tenantContext) {
    const lic = tenantContext.licenses;
    const caLines = (tenantContext.caPolicies || [])
      .map(p => `- ${p.displayName} [${p.state}]`).join("\n") || "(keine)";
    tenantSection =
      `Tenant: ${tenantContext.tenantName}\n` +
      `Lizenz-Uebersicht: ${lic ? `${lic.totals?.licensedUsers ?? "?"} Nutzer mit Lizenz, ` +
        `${lic.findings?.unusedPaidSeats?.length ?? 0} SKUs mit ungenutzten bezahlten Plaetzen, ` +
        `${lic.findings?.multiSuite?.length ?? 0} Mehrfach-Lizenzierungen` : "(nicht verfuegbar)"}\n` +
      `Conditional-Access-Policies (Name [Status]):\n${caLines}`;
  }

  return `Du bist ein erfahrener M365/Entra-ID-Support-Techniker bei einem MSP (iGeeks). ` +
    `Analysiere das folgende ServiceDesk-Plus-Ticket und antworte AUSSCHLIESSLICH mit einem JSON-Objekt ` +
    `(kein Fliesstext davor/danach), das exakt folgendem Schema entspricht:\n` +
    `{"rootCause": string, "assumptions": [{"claim": string, "verdict": "bestaetigt"|"widerlegt"|"unklar", "reasoning": string}], ` +
    `"steps": [string], "automatable": boolean, "automatableReason": string, ` +
    `"automationSearchTerm": string|null, "automationDesiredValue": string|null}\n\n` +
    `Ticket #${ticket.id}: ${ticket.subject}\n` +
    `Status: ${ticket.status} · Prioritaet: ${ticket.priority} · Kategorie: ${ticket.category}\n` +
    `Requester: ${ticket.requester}\n` +
    `Beschreibung:\n${ticket.description || "(keine)"}\n\n` +
    `Notizen (neueste zuerst):\n${notesText}\n\n` +
    `Tenant-Kontext (live, zum Abgleich der Annahmen aus dem Ticket):\n${tenantSection}\n\n` +
    `Bewerte in "assumptions" konkret die Behauptungen/Annahmen aus dem Ticket-Text gegen den Tenant-Kontext ` +
    `oben -- wenn kein Tenant-Kontext vorliegt, alle Annahmen als "unklar" markieren statt zu raten.\n\n` +
    `WICHTIG fuer "steps": Wenn die Loesung eine Tenant-Konfigurationsaenderung ist (Intune-Policy, GPO, ` +
    `Conditional-Access-Regel o.ae.), gib dich NICHT mit allgemeiner Beratung ("Stakeholder einbeziehen", ` +
    `"Rueckmeldung abwarten") zufrieden, auch wenn das Ticket nur eine Beratungsanfrage ist. Nenne IMMER ZUSAETZLICH ` +
    `konkret: (a) die genaue Policy/den genauen Einstellungsnamen, (b) dass sie zunaechst NUR auf eine Pilot-/` +
    `Test-Gruppe angewendet werden sollte, nicht auf alle Nutzer (entspricht unserem etablierten Ring-Konzept ` +
    `Pilot -> UAT -> Broad), (c) erst nach erfolgreicher Pilotphase der volle Rollout. Diese konkreten Schritte ` +
    `ergaenzen die Beratungshinweise (Freigabe/Rueckmeldung einholen etc.), ersetzen sie aber nicht -- beides gehoert rein.\n\n` +
    `"automatable"/"automatableReason": true NUR wenn es sich um eine einzelne ADMX-basierte Windows/Browser-` +
    `Einstellung mit einem simplen Enabled/Disabled-artigen Wert handelt (z.B. Edge-/Windows-Policies) -- unser Tool ` +
    `kann solche Einstellungen LIVE per Suchbegriff in Intune Settings Catalog finden und als Policy ausrollen, ` +
    `OHNE dass jemand manuell etwas exportieren/einfuegen muss. Bei Conditional-Access-Aenderungen, komplexen ` +
    `Multi-Setting-Profilen oder allem ausserhalb von Windows/Intune (z.B. Exchange-Regeln) automatable auf false ` +
    `setzen, auch wenn es technisch grundsaetzlich automatisierbar waere -- dafuer gibt es (noch) keinen Suchmodus. ` +
    `Wenn automatable=true: "automationSearchTerm" = ein praeziser Suchbegriff (2-4 Woerter, moeglichst der offizielle ` +
    `Einstellungsname auf Englisch, z.B. "Password manager"), "automationDesiredValue" = der gewuenschte Optionswert ` +
    `(z.B. "Disabled"). automatableReason muss dann erklaeren, dass unser Tool das automatisch findet + pilotiert ` +
    `ausrollen kann. Wenn automatable=false: beide auf null setzen.`;
}

/** Robust gegen Markdown-Codefences, die das Modell trotz Anweisung manchmal noch anfuegt. */
function parseJsonResponse(text) {
  const cleaned = String(text || "").replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  return JSON.parse(cleaned);
}

async function suggestResolution({ ticket, tenantContext }) {
  const cfg = config();
  if (!cfg.enabled) throw Object.assign(new Error("Kein Anthropic-Key konfiguriert (ANTHROPIC_API_KEY)."), { status: 400 });

  const prompt = buildPrompt(ticket, tenantContext);
  let r;
  try {
    r = await fetch(API_URL, {
      method: "POST",
      headers: {
        "x-api-key": cfg.key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 1500,
        messages: [{ role: "user", content: prompt }]
      }),
      signal: AbortSignal.timeout(60000)
    });
  } catch (e) {
    throw Object.assign(new Error("Anthropic-API nicht erreichbar: " + e.message), { status: 502 });
  }

  const data = await r.json().catch(() => null);
  if (!r.ok) {
    const msg = (data && data.error && data.error.message) || `HTTP ${r.status}`;
    throw Object.assign(new Error(`Anthropic-Fehler: ${msg}`), { status: 502 });
  }

  const text = (data && data.content && data.content[0] && data.content[0].text) || "";
  try {
    return parseJsonResponse(text);
  } catch (e) {
    throw Object.assign(new Error("KI-Antwort war kein gueltiges JSON -- Rohtext: " + text.slice(0, 300)), { status: 502 });
  }
}

module.exports = { config, suggestResolution };
