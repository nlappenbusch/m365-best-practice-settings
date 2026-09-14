/**
 * SMTP AUTH (authenticated client SMTP submission): organisationsweit aus,
 * gezielte Ausnahmen je Postfach.
 *
 * Microsoft empfiehlt, SMTP AUTH tenantweit abzuschalten und nur fuer die
 * Postfaecher freizugeben, die es wirklich brauchen (Drucker, Scanner,
 * Fachanwendungen, POP/IMAP-Clients). Die Postfach-Einstellung hat Vorrang vor
 * der Organisationseinstellung; $null heisst "folgt der Organisation".
 *
 * Diese Datei liefert nur die Erhebung fuer die Auswahl im Tab. Das Setzen
 * passiert im Deploy (deploy.js, Schritt "SMTP AUTH"), gelesen fuer den
 * Soll-Ist-Vergleich im Audit (buildAuditBody).
 */
const EXO = require("./exorunner");
const { graphReq } = require("./graph");

/** Organisationseinstellung + alle Postfaecher mit ihrer SMTP-AUTH-Einstellung. */
async function readState(tenant, cert) {
  const body = [
    "$tc = Get-TransportConfig | Select-Object SmtpClientAuthenticationDisabled",
    "$mbx = @(Get-CASMailbox -ResultSize Unlimited | Select-Object DisplayName, PrimarySmtpAddress, SmtpClientAuthenticationDisabled)",
    "Write-Output ('BEGINJSON' + (@{ ok = $true; org = $tc; mailboxes = $mbx } | ConvertTo-Json -Compress -Depth 5) + 'ENDJSON')"
  ].join("\r\n");
  const r = await EXO.runExo(
    { appId: tenant.clientId, organization: tenant.organization, certPemPath: cert },
    body, 240000);
  if (!r.ok) throw Object.assign(new Error("EXO-Runner: " + r.error), { hint: "Exchange Online app-only nicht erreichbar." });
  if (!r.data || r.data.ok === false) {
    throw Object.assign(new Error((r.data && r.data.error) || "SMTP-AUTH-Abfrage fehlgeschlagen"),
      { hint: "Braucht Exchange.ManageAsApp + Exchange-Administrator-Rolle (im Tab Tenants einmal Reparieren)." });
  }
  const raw = r.data.mailboxes || [];
  const mailboxes = (Array.isArray(raw) ? raw : [raw]).map(m => ({
    displayName: m.DisplayName || "",
    address: String(m.PrimarySmtpAddress || "").toLowerCase(),
    // true = aus, false = explizit an, null = folgt der Organisation
    setting: m.SmtpClientAuthenticationDisabled === true ? true : (m.SmtpClientAuthenticationDisabled === false ? false : null)
  })).filter(m => m.address).sort((a, b) => a.address.localeCompare(b.address));

  const org = r.data.org || {};
  return {
    orgDisabled: org.SmtpClientAuthenticationDisabled === true,
    mailboxes
  };
}

/**
 * Wer hat in den letzten Tagen tatsaechlich per SMTP AUTH gesendet? Grundlage
 * fuer die Vorauswahl -- ohne diese Erhebung schneidet das Abschalten still
 * Drucker und Fachanwendungen ab.
 *
 * Grenzen, die die Anzeige nennen muss:
 *  - Sign-in-Logs per Graph brauchen Entra ID P1/P2. Ohne Lizenz -> Fehler,
 *    der Rest der Auswahl bleibt nutzbar.
 *  - Graph dokumentiert den Wert als "SMTP", das Portal zeigt "Authenticated
 *    SMTP". Abgefragt wird beides, weil nicht belegt ist, welcher ankommt.
 *  - Erfasst sind Anmeldungen, die in Entra landen. Ein System, das nur selten
 *    sendet (Monatslauf), taucht in 30 Tagen womoeglich nicht auf.
 */
async function readSignIns(tenant, cert, days) {
  const d = Math.max(1, Math.min(30, Number(days) || 30));
  const since = new Date(Date.now() - d * 86400000).toISOString();
  const byUpn = new Map();
  const errors = [];
  let sawAny = false;

  for (const clientApp of ["SMTP", "Authenticated SMTP"]) {
    const filter = `clientAppUsed eq '${clientApp}' and createdDateTime ge ${since}`;
    let path = "/auditLogs/signIns?$filter=" + encodeURIComponent(filter) +
      "&$select=userPrincipalName,createdDateTime,status&$top=999";
    let pages = 0;
    try {
      // Seiten begrenzen: ein aktiver Scanner erzeugt Tausende Anmeldungen im
      // Monat -- fuer die Frage "nutzt dieses Konto SMTP AUTH" reicht ein Ausschnitt.
      while (path && pages < 10) {
        const r = await graphReq(tenant, cert, "GET", path);
        sawAny = true;
        for (const s of (r.value || [])) {
          const upn = String(s.userPrincipalName || "").toLowerCase();
          if (!upn) continue;
          const e = byUpn.get(upn) || { upn, ok: 0, failed: 0, last: null };
          const code = s.status && typeof s.status.errorCode === "number" ? s.status.errorCode : 0;
          if (code === 0) e.ok++; else e.failed++;
          if (!e.last || s.createdDateTime > e.last) e.last = s.createdDateTime;
          byUpn.set(upn, e);
        }
        path = r["@odata.nextLink"] || null;
        pages++;
      }
    } catch (e) {
      errors.push(clientApp + ": " + e.message);
    }
  }

  const users = [...byUpn.values()].sort((a, b) => (b.ok + b.failed) - (a.ok + a.failed));
  // Beide Abfragen gescheitert -> ehrlich als nicht erhebbar melden statt "niemand nutzt es".
  if (!sawAny && errors.length) {
    const lic = /license|premium|P1|P2|Authentication_RequestFromNonPremiumTenant/i.test(errors.join(" "));
    return {
      ok: false, days: d, users: [],
      error: lic
        ? "Sign-in-Logs sind in diesem Tenant nicht per Graph lesbar (Entra ID P1/P2 erforderlich)."
        : "Sign-in-Logs nicht lesbar: " + errors[0]
    };
  }
  return { ok: true, days: d, users };
}

/** E-Mail-Adresse fuer die Auswahl pruefen -- sie landet in einem PowerShell-Array. */
function normalizeAddress(v) {
  const a = String(v || "").trim().toLowerCase();
  return /^[^@\s'"`$;|&<>()]+@[^@\s'"`$;|&<>()]+\.[a-z0-9-]+$/i.test(a) ? a : null;
}

module.exports = { readState, readSignIns, normalizeAddress };
