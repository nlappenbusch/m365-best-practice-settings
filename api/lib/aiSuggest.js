"use strict";
/**
 * SDP-Ticket-Copilot: KI-Loesungsvorschlag ueber den eingerichteten KI-Dienst
 * (lib/aiProviders.js, Zweck «tickets» — Anthropic, OpenAI, Azure, Gemini …).
 *
 * Laeuft komplett serverseitig-intern: die Tenant-Daten werden VOR dem
 * Aufruf hier bereits von den bestehenden Lib-Funktionen (licenses.js,
 * conditionalAccess.js, ...) geholt -- dieses Modul bekommt nur das fertig
 * zusammengestellte Kontext-Objekt, keinen Tenant/Cert-Zugriff selbst.
 */

const AI = require("./aiProviders");

// Welcher KI-Dienst antwortet, steht in den KI-Diensten (Zweck «tickets»).
function config() { return { enabled: AI.enabledFor("tickets") }; }

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

async function suggestResolution({ ticket, tenantContext }) {
  const prompt = buildPrompt(ticket, tenantContext);
  try {
    const r = await AI.complete("tickets", { prompt, maxTokens: 4096, json: true });
    return r.json;
  } catch (e) {
    throw Object.assign(new Error(e.message), { status: e.status || 502 });
  }
}

module.exports = { config, suggestResolution };
