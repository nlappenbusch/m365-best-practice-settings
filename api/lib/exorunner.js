/**
 * Exchange-Online-Runner: fuehrt EOP-Cmdlets app-only aus.
 *
 * Node spawnt pwsh 7, verbindet Exchange Online APP-ONLY mit dem Tenant-Zertifikat
 * (das PEM aus state/cert/<tenantId>.pem enthaelt Key + Cert) und fuehrt einen
 * Body aus, der sein Ergebnis als JSON zwischen BEGINJSON/ENDJSON-Markern ausgibt.
 *
 * Voraussetzung im Tenant (wird vom Onboarding gesetzt):
 *   - App-Permission "Office 365 Exchange Online" -> Exchange.ManageAsApp (Application)
 *   - Directory-Rolle "Exchange Administrator"
 * Fehlt der Consent, scheitert Connect-ExchangeOnline mit einer klaren Meldung —
 * der Runner gibt sie strukturiert zurueck (kein Crash).
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const PWSH = process.env.PWSH_PATH || "pwsh";

// Alle Cmdlets, die der Deploy-Body verwenden darf (haelt die EXO-Session schlank).
const COMMANDS = [
  "Get-AcceptedDomain",
  // IST-Bestandsaufnahme (inventory.js): Postfaecher + Shared Mailboxes.
  // Get-EXOMailbox statt Get-Mailbox -- laeuft ueber REST, deutlich schneller
  // bei vielen Postfaechern, gleicher Berechtigungsumfang.
  "Get-EXOMailbox",
  "Get-QuarantinePolicy", "New-QuarantinePolicy", "Set-QuarantinePolicy",
  "Get-AntiPhishPolicy", "New-AntiPhishPolicy", "Set-AntiPhishPolicy",
  "Get-AntiPhishRule", "New-AntiPhishRule", "Set-AntiPhishRule",
  "Get-HostedContentFilterPolicy", "New-HostedContentFilterPolicy", "Set-HostedContentFilterPolicy",
  "Get-HostedContentFilterRule", "New-HostedContentFilterRule", "Set-HostedContentFilterRule",
  "Get-MalwareFilterPolicy", "New-MalwareFilterPolicy", "Set-MalwareFilterPolicy",
  "Get-MalwareFilterRule", "New-MalwareFilterRule", "Set-MalwareFilterRule",
  // DKIM: Lesen fuer den Audit, New/Set fuer den Aktivieren-Knopf im Audit-Tab.
  // Rotate- steht bewusst NICHT hier: Ein Schluesselwechsel auf 2048 Bit hat ein
  // eigenes Zeitfenster und ist keine Nebenwirkung eines Aktivieren-Klicks.
  "Get-DkimSigningConfig", "New-DkimSigningConfig", "Set-DkimSigningConfig",
  // Ausgehend & Organisation (CIS 2.1.6, 2.1.15, 6.2.1, 6.2.3, 6.5.5).
  // Get-OrganizationConfig stand hier bisher nicht drin, obwohl der Deploy-Body
  // es fuer die IsDehydrated-Vorpruefung aufruft — die Pruefung lief deshalb
  // still ins Leere (der Aufruf steckt in einem leeren catch).
  "Get-OrganizationConfig", "Set-OrganizationConfig",
  "Get-HostedOutboundSpamFilterPolicy", "Set-HostedOutboundSpamFilterPolicy",
  "Get-ExternalInOutlook", "Set-ExternalInOutlook",
  "Get-TransportRule", "New-TransportRule", "Set-TransportRule", "Enable-TransportRule",
  // SMTP AUTH: Organisationsschalter + Ausnahmen je Postfach (Deploy, Audit, Auswahl-Erhebung).
  "Get-TransportConfig", "Set-TransportConfig", "Get-CASMailbox", "Set-CASMailbox",
  // Safe Links / Safe Attachments (Defender for Office 365, P1/P2, lizenzabhaengig).
  // Get-* stand hier zunaechst allein (Audit-Tab, reine Ist-Erhebung) -- aufgefallen
  // beim Acons-Phishing-Vorfall 04.09.2026, wo die fehlende Whitelist den Cmdlet-
  // Aufruf still scheitern liess und "keine Defender-Funktion erkennbar" zeigte,
  // obwohl der Tenant lizenziert sein kann. New-/Set-* kamen mit dem Deploy-Baustein
  // im "Ausrollen"-Tab dazu (BP_SafeLinks/BP_SafeAttachments, buildDeployBody).
  "Get-AtpPolicyForO365", "Set-AtpPolicyForO365",
  "Get-SafeLinksPolicy", "New-SafeLinksPolicy", "Set-SafeLinksPolicy",
  "Get-SafeLinksRule", "New-SafeLinksRule", "Set-SafeLinksRule",
  "Get-SafeAttachmentPolicy", "New-SafeAttachmentPolicy", "Set-SafeAttachmentPolicy",
  "Get-SafeAttachmentRule", "New-SafeAttachmentRule", "Set-SafeAttachmentRule",
  // Empfänger-Audit (Nachweise): Meldepostfach für vom Benutzer gemeldete Mails — nur lesend.
  "Get-ReportSubmissionPolicy",
  // Ist-Zustand-Doku (lib/istZustand.js) — nur lesend: welche Schutzrichtlinie wirkt
  // (Voreinstellungen Standard/Streng haben Vorrang vor eigenen Richtlinien),
  // Protokollierung, Weiterleitung nach extern, Connectoren.
  "Get-EOPProtectionPolicyRule", "Get-ATPProtectionPolicyRule", "Get-ATPBuiltInProtectionRule",
  "Get-HostedOutboundSpamFilterRule", "Get-AdminAuditLogConfig", "Get-RemoteDomain",
  "Get-InboundConnector", "Get-OutboundConnector",
  // Managed Service (lib/managedCollectors.js) — nur lesend: Inbox-Regeln je
  // Postfach, persoenliche Sichere/Blockierte Absender, Quarantaene-
  // Freigabeanfragen und die Tenant Allow/Block List.
  "Get-InboxRule", "Get-MailboxJunkEmailConfiguration", "Get-QuarantineMessage", "Get-TenantAllowBlockListItems"
].join(",");


// Generischer pwsh-Lauf: Skript ueber stdin, JSON zwischen Markern extrahieren.
// onProgress (optional) bekommt live jedes BPPROGRESS-Objekt aus dem stdout-Stream.
// onChild (optional) bekommt den Kindprozess, damit ein laufender Job von aussen
// abgebrochen werden kann (siehe /api/deploy/:jobId/cancel).
// opts.asFile: Skript als temporaere Datei mit -File statt ueber stdin starten.
// Noetig fuer Connect-IPPSSession: im stdin-Modus verschluckt es den Rest der
// Eingabe, pwsh endet still mit Exit 0 und gibt nur Terminal-Steuerzeichen aus
// (ESC[?1h) — beim Ist-Zustand am 15.10.2026 reproduziert, mit -File laeuft
// derselbe Lauf sauber durch.
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
function runPwsh(script, timeoutMs, onProgress, onChild, opts) {
  timeoutMs = timeoutMs || 180000;
  const asFile = !!(opts && opts.asFile);
  return new Promise((resolve) => {
    let ps, tmp = null;
    try {
      if (asFile) {
        tmp = path.join(os.tmpdir(), "bp-" + crypto.randomBytes(6).toString("hex") + ".ps1");
        fs.writeFileSync(tmp, script, { encoding: "utf8", mode: 0o600 });
      }
      const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", ...(asFile ? ["-File", tmp] : ["-Command", "-"])];
      ps = spawn(PWSH, args, { stdio: [asFile ? "ignore" : "pipe", "pipe", "pipe"] });
    } catch (e) {
      if (tmp) { try { fs.unlinkSync(tmp); } catch (x) { /* egal */ } }
      return resolve({ ok: false, error: "pwsh nicht startbar: " + e.message, raw: "" });
    }
    const cleanup = () => { if (tmp) { try { fs.unlinkSync(tmp); } catch (x) { /* schon weg */ } tmp = null; } };
    if (onChild) { try { onChild(ps); } catch (e) { /* Abbruch-Handle ist optional */ } }
    let out = "", err = "", done = false, scanned = 0;
    const scanProgress = () => {
      if (!onProgress) return;
      for (;;) {
        const s = out.indexOf("BPPROGRESS", scanned);
        if (s === -1) return;
        const e = out.indexOf("ENDPROGRESS", s);
        if (e === -1) return; // Marker noch unvollstaendig — auf naechsten Chunk warten
        const payload = out.slice(s + "BPPROGRESS".length, e);
        scanned = e + "ENDPROGRESS".length;
        try { onProgress(JSON.parse(payload)); } catch (x) { /* kaputter Marker — ignorieren */ }
      }
    };
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); try { ps.kill(); } catch (e) {} cleanup(); resolve(r); };
    const timer = setTimeout(() => finish({ ok: false, error: "Zeitueberschreitung (" + Math.round(timeoutMs / 1000) + "s)", raw: out + err }), timeoutMs);
    ps.on("error", e => finish({ ok: false, error: "pwsh-Fehler: " + e.message, raw: "" }));
    ps.stdout.on("data", d => { out += d.toString(); scanProgress(); });
    ps.stderr.on("data", d => err += d.toString());
    ps.on("close", () => {
      const m = out.match(/BEGINJSON([\s\S]*?)ENDJSON/);
      if (m) { try { return finish({ ok: true, data: JSON.parse(m[1]), raw: out }); } catch (e) { return finish({ ok: false, error: "JSON-Parse-Fehler: " + e.message, raw: m[1].slice(0, 500) }); } }
      // Kein Marker -> wahrscheinlich Connect-/Auth-Fehler in stderr
      // Steuerzeichen raus: sonst steht im UI/PDF nur "[?1h[?1l…" statt einer Meldung.
      const clean = s => String(s || "").replace(ANSI_RE, "");
      const reason = clean(err).trim() || clean(out).trim();
      const msg = reason.split(/\r?\n/).filter(Boolean).slice(-4).join(" | ") || "pwsh endete ohne Ausgabe";
      finish({ ok: false, error: msg.slice(0, 600), raw: clean(out + err).slice(0, 2000) });
    });
    if (!asFile) {
      ps.stdin.write(script + "\r\n");
      ps.stdin.end();
    }
  });
}

function psQuote(s) { return "'" + String(s == null ? "" : s).replace(/'/g, "''") + "'"; }

/**
 * Verbindet EXO app-only mit dem Zertifikat und fuehrt bodyScript aus.
 * @param {object} opts { appId, organization (tenant.onmicrosoft.com), certPemPath }
 * @param {string} bodyScript  gibt sein Ergebnis via BEGINJSON..ENDJSON aus
 */
async function runExo(opts, bodyScript, timeoutMs, onProgress, onChild) {
  if (!opts.certPemPath) return { ok: false, error: "Kein Zertifikat-Pfad." };
  const wrapper = [
    "$ErrorActionPreference = 'Stop'",
    "Write-Output ('BPPROGRESS' + (@{ type = 'phase'; label = 'Verbindung zu Exchange Online' } | ConvertTo-Json -Compress) + 'ENDPROGRESS')",
    "try {",
    "  Import-Module ExchangeOnlineManagement -ErrorAction Stop",
    "} catch { Write-Output ('BEGINJSON' + (@{ ok = $false; error = 'ExchangeOnlineManagement-Modul fehlt: ' + $_.Exception.Message } | ConvertTo-Json -Compress) + 'ENDJSON'); exit 0 }",
    "try {",
    // PEM (Key+Cert) laden -> X509Certificate2 mit privatem Schluessel
    "  $cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPemFile(" + psQuote(opts.certPemPath) + ")",
    "  Connect-ExchangeOnline -AppId " + psQuote(opts.appId) + " -Organization " + psQuote(opts.organization) + " -Certificate $cert -ShowBanner:$false -CommandName " + COMMANDS + " -ErrorAction Stop",
    "} catch { Write-Output ('BEGINJSON' + (@{ ok = $false; error = 'Connect-ExchangeOnline fehlgeschlagen (Exchange.ManageAsApp + Exchange-Admin-Rolle noetig?): ' + $_.Exception.Message } | ConvertTo-Json -Compress) + 'ENDJSON'); exit 0 }",
    "",
    bodyScript,
    "",
    "try { Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue | Out-Null } catch {}"
  ].join("\r\n");
  return runPwsh(wrapper, timeoutMs, onProgress, onChild);
}

// Hinweis: Ein runIpps (Connect-IPPSSession fuer die Alert Policy) gab es hier mal —
// Security & Compliance PowerShell ist laut Microsoft-Doku auf Linux nicht verfuegbar
// (Connect scheitert mit NullReferenceException). Die Alert Policy laeuft deshalb als
// manueller Schritt mit generiertem Snippet (siehe deploy.js buildAlertPolicySnippet).

module.exports = { runPwsh, runExo, psQuote };
