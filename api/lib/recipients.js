"use strict";
/**
 * Empfänger-Audit: Welche Meldungen gehen an welche Adresse?
 *
 * Die Frage "Sind administrator@ und support@ noch irgendwo eingetragen?" hat
 * keine einzelne Stelle in Microsoft 365 — die Empfänger stehen verstreut:
 *  - Graph:     Tenant-Kontakte (technisch, Sicherheit/Compliance, Datenschutz)
 *  - Exchange:  Spam-Ausgang, Malware-Admin-Benachrichtigung, Meldepostfach für
 *               vom Benutzer gemeldete Mails, Transportregeln (Bcc, Vorfallbericht)
 *  - Security & Compliance: Warnungsrichtlinien (Alert Policies), DLP-Regeln
 * Dieses Modul sammelt alle an einer Stelle und dreht die Sicht um: je Adresse,
 * welche Meldungen sie bekommt.
 *
 * Security & Compliance PowerShell kann den pwsh-Prozess unter Linux hart
 * beenden (siehe maester.js) — deshalb läuft sie in einem EIGENEN Prozess und
 * ihr Scheitern kostet nur diesen Teil.
 *
 * Ausschliesslich lesend.
 */
const { graphReq } = require("./graph");
const EXO = require("./exorunner");

const V1 = { retryTransient: 4 };

const EXO_BODY = [
  "$o = @{ ok = $true }",
  "function Addr($v) { @($v | Where-Object { $_ } | ForEach-Object { \"$_\" }) }",
  "try { $o.outbound = @(Get-HostedOutboundSpamFilterPolicy | ForEach-Object { @{ name = $_.Name; isDefault = [bool]$_.IsDefault; notify = [bool]$_.NotifyOutboundSpam; notifyTo = (Addr $_.NotifyOutboundSpamRecipients); bcc = [bool]$_.BccSuspiciousOutboundMail; bccTo = (Addr $_.BccSuspiciousOutboundAdditionalRecipients) } }) } catch { $o.outboundError = $_.Exception.Message }",
  "try { $o.malware = @(Get-MalwareFilterPolicy | ForEach-Object { @{ name = $_.Name; isDefault = [bool]$_.IsDefault; internal = [bool]$_.EnableInternalSenderAdminNotifications; internalTo = \"$($_.InternalSenderAdminAddress)\"; external = [bool]$_.EnableExternalSenderAdminNotifications; externalTo = \"$($_.ExternalSenderAdminAddress)\" } }) } catch { $o.malwareError = $_.Exception.Message }",
  "try { $o.submission = @(Get-ReportSubmissionPolicy | ForEach-Object { @{ name = $_.Name; junk = [bool]$_.ReportJunkToCustomizedAddress; junkTo = (Addr $_.ReportJunkAddresses); notJunk = [bool]$_.ReportNotJunkToCustomizedAddress; notJunkTo = (Addr $_.ReportNotJunkAddresses); phish = [bool]$_.ReportPhishToCustomizedAddress; phishTo = (Addr $_.ReportPhishAddresses); toMicrosoft = [bool]$_.EnableReportToMicrosoft } }) } catch { $o.submissionError = $_.Exception.Message }",
  "try { $o.transport = @(Get-TransportRule | ForEach-Object { @{ name = $_.Name; state = \"$($_.State)\"; bcc = (Addr $_.BlindCopyTo); cc = (Addr $_.CopyTo); add = (Addr $_.AddToRecipients); redirect = (Addr $_.RedirectMessageTo); incident = \"$($_.GenerateIncidentReport)\"; description = \"$($_.Description)\" } }) } catch { $o.transportError = $_.Exception.Message }",
  "Write-Output ('BEGINJSON' + ($o | ConvertTo-Json -Depth 6 -Compress) + 'ENDJSON')"
].join("\r\n");

function ippsScript(t, certPemPath) {
  const q = EXO.psQuote;
  return [
    "$ErrorActionPreference = 'Stop'",
    "$o = @{ ok = $true }",
    "function Addr($v) { @($v | Where-Object { $_ } | ForEach-Object { \"$_\" }) }",
    "try {",
    "  Import-Module ExchangeOnlineManagement -ErrorAction Stop",
    "  $cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPemFile(" + q(certPemPath) + ")",
    "  $ipps = Get-Command Connect-IPPSSession -ErrorAction Stop",
    "  $scp = @{ AppId = " + q(t.clientId) + "; Organization = " + q(t.organization) + "; Certificate = $cert; ErrorAction = 'Stop' }",
    "  if ($ipps.Parameters.ContainsKey('ShowBanner')) { $scp['ShowBanner'] = $false }",
    "  Connect-IPPSSession @scp",
    "} catch { Write-Output ('BEGINJSON' + (@{ ok = $false; error = 'Security & Compliance nicht verbunden: ' + $_.Exception.Message } | ConvertTo-Json -Compress) + 'ENDJSON'); exit 0 }",
    "try { $o.alerts = @(Get-ProtectionAlert | ForEach-Object { @{ name = $_.Name; category = \"$($_.Category)\"; severity = \"$($_.Severity)\"; disabled = [bool]$_.Disabled; system = [bool]$_.IsSystemRule; notifyEnabled = [bool]$_.NotificationEnabled; notifyTo = (Addr $_.NotifyUser) } }) } catch { $o.alertsError = $_.Exception.Message }",
    "try { $o.dlp = @(Get-DlpComplianceRule | ForEach-Object { @{ name = $_.Name; policy = \"$($_.ParentPolicyName)\"; disabled = [bool]$_.Disabled; alertTo = (Addr $_.GenerateAlert); incidentTo = (Addr $_.GenerateIncidentReport); notifyTo = (Addr $_.NotifyUser) } }) } catch { $o.dlpError = $_.Exception.Message }",
    "Write-Output ('BEGINJSON' + ($o | ConvertTo-Json -Depth 6 -Compress) + 'ENDJSON')",
    "try { Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue | Out-Null } catch {}"
  ].join("\r\n");
}

// Nicht per API lesbar — gehört als Handprüfung in die Doku, sonst fehlt es unbemerkt.
const MANUAL = [
  { area: "Microsoft 365 Admin Center", what: "Service-Health-E-Mail-Benachrichtigungen (Einstellungen › Service-Integrität › Anpassen)" },
  { area: "Microsoft 365 Admin Center", what: "Nachrichtencenter-Einstellungen: wöchentliche Zusammenfassung und Einzelmeldungen per E-Mail" },
  { area: "Microsoft Defender XDR", what: "E-Mail-Benachrichtigungen für Vorfälle und Sicherheitsrisiken (Einstellungen › Microsoft Defender XDR › E-Mail-Benachrichtigungen)" },
  { area: "Entra ID", what: "PIM-Benachrichtigungen je Rolle (Rolleneinstellungen › Benachrichtigungen)" },
  { area: "Entra ID", what: "Identity Protection: Benachrichtigungen über gefährdete Benutzer und wöchentlicher Digest" }
];

function norm(a) { return String(a || "").trim().toLowerCase(); }
function arr(v) { return (Array.isArray(v) ? v : (v ? [v] : [])).map(x => String(x || "").trim()).filter(Boolean); }

async function notificationRecipients(tenant, certPemPath, opts, say) {
  say = say || (() => {});
  const entries = [];
  const gaps = [];
  const add = (area, object, trigger, recipients, enabled, note) => {
    const r = arr(recipients);
    if (!r.length) return;
    entries.push({ area, object, trigger, recipients: r, enabled: enabled !== false, note: note || "" });
  };

  say("Tenant-Kontakte lesen");
  try {
    const o = (await graphReq(tenant, certPemPath, "GET", "/organization?$select=displayName,technicalNotificationMails,securityComplianceNotificationMails,marketingNotificationEmails,privacyProfile", null, V1)).value[0] || {};
    add("Tenant", "Technischer Kontakt", "Technische Mitteilungen von Microsoft zum Tenant", o.technicalNotificationMails);
    add("Tenant", "Sicherheits- und Compliance-Kontakt", "Sicherheits- und Compliance-Mitteilungen von Microsoft", o.securityComplianceNotificationMails);
    add("Tenant", "Marketing-Kontakt", "Marketing-Mitteilungen", o.marketingNotificationEmails);
    if (o.privacyProfile && o.privacyProfile.contactEmail) add("Tenant", "Datenschutzkontakt", "Anfragen zum Datenschutz", o.privacyProfile.contactEmail);
  } catch (e) { gaps.push("Tenant-Kontakte nicht lesbar: " + e.message); }

  say("Exchange Online abfragen");
  const auth = { appId: tenant.clientId, organization: tenant.organization, certPemPath };
  const exo = await EXO.runExo(auth, EXO_BODY, 180000);
  if (!exo.ok || !exo.data || exo.data.ok === false) {
    gaps.push("Exchange Online nicht abrufbar: " + ((exo.data && exo.data.error) || exo.error || "unbekannt"));
  } else {
    const d = exo.data;
    for (const k of ["outboundError", "malwareError", "submissionError", "transportError"]) if (d[k]) gaps.push("Exchange: " + d[k]);
    for (const p of d.outbound || []) {
      add("Exchange · Spam ausgehend", p.name, "Absender wegen Spamversand gesperrt", p.notifyTo, p.notify);
      add("Exchange · Spam ausgehend", p.name, "Kopie verdächtiger ausgehender Mails (Bcc)", p.bccTo, p.bcc);
    }
    for (const p of d.malware || []) {
      add("Exchange · Malware", p.name, "Malware in Mail von internem Absender", p.internalTo, p.internal);
      add("Exchange · Malware", p.name, "Malware in Mail von externem Absender", p.externalTo, p.external);
    }
    for (const p of d.submission || []) {
      add("Exchange · Meldepostfach", p.name, "Vom Benutzer als Junk gemeldete Mails", p.junkTo, p.junk);
      add("Exchange · Meldepostfach", p.name, "Vom Benutzer als «kein Junk» gemeldete Mails", p.notJunkTo, p.notJunk);
      add("Exchange · Meldepostfach", p.name, "Vom Benutzer als Phishing gemeldete Mails", p.phishTo, p.phish);
    }
    for (const r of d.transport || []) {
      const on = String(r.state || "").toLowerCase() !== "disabled";
      add("Exchange · Transportregel", r.name, "Bcc an", r.bcc, on, r.description);
      add("Exchange · Transportregel", r.name, "Cc an", r.cc, on, r.description);
      add("Exchange · Transportregel", r.name, "Zusätzlicher Empfänger", r.add, on, r.description);
      add("Exchange · Transportregel", r.name, "Umgeleitet an", r.redirect, on, r.description);
      add("Exchange · Transportregel", r.name, "Vorfallbericht an", r.incident, on, r.description);
    }
  }

  if (!(opts && opts.skipCompliance)) {
    say("Security & Compliance abfragen");
    const sc = await EXO.runPwsh(ippsScript(tenant, certPemPath), 150000);
    if (!sc.ok || !sc.data || sc.data.ok === false) {
      gaps.push("Security & Compliance nicht abrufbar (Warnungsrichtlinien, DLP): " + ((sc.data && sc.data.error) || sc.error || "unbekannt") +
        " — Warnungsrichtlinien im Defender-Portal unter «Richtlinien & Regeln › Warnungsrichtlinie» prüfen.");
    } else {
      const d = sc.data;
      if (d.alertsError) gaps.push("Warnungsrichtlinien: " + d.alertsError);
      if (d.dlpError) gaps.push("DLP-Regeln: " + d.dlpError);
      for (const a of d.alerts || []) {
        add("Security & Compliance · Warnungsrichtlinie", a.name, `${a.category || "Warnung"} · Schweregrad ${a.severity || "?"}${a.system ? " · Standardrichtlinie" : ""}`, a.notifyTo, !a.disabled && a.notifyEnabled !== false);
      }
      for (const r of d.dlp || []) {
        add("Security & Compliance · DLP", `${r.policy} › ${r.name}`, "DLP-Warnung", r.alertTo, !r.disabled);
        add("Security & Compliance · DLP", `${r.policy} › ${r.name}`, "DLP-Vorfallbericht", r.incidentTo, !r.disabled);
        add("Security & Compliance · DLP", `${r.policy} › ${r.name}`, "Benachrichtigung (Benutzer/Rollen)", r.notifyTo, !r.disabled);
      }
    }
  }

  // Umgedrehte Sicht: je Adresse, welche Meldungen sie bekommt.
  const byAddress = new Map();
  for (const e of entries) for (const r of e.recipients) {
    const k = norm(r);
    if (!byAddress.has(k)) byAddress.set(k, { address: r, entries: [] });
    byAddress.get(k).entries.push({ area: e.area, object: e.object, trigger: e.trigger, enabled: e.enabled });
  }
  const addresses = [...byAddress.values()].sort((a, b) => b.entries.length - a.entries.length || a.address.localeCompare(b.address));

  // Beobachtungsliste: "administrator@", "support@", "compliance" — Teiltreffer genügen.
  const watch = arr(opts && opts.watch).map(norm);
  const watchResults = watch.map(w => ({
    watch: w,
    hits: addresses.filter(a => norm(a.address).includes(w)).map(a => ({ address: a.address, entries: a.entries }))
  }));

  return {
    gaps, entries, addresses, watch: watchResults, manual: MANUAL,
    summary: {
      entries: entries.length,
      addresses: addresses.length,
      disabled: entries.filter(e => !e.enabled).length,
      watchHits: watchResults.reduce((n, w) => n + w.hits.length, 0)
    }
  };
}

module.exports = { notificationRecipients, MANUAL };
