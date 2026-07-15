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

const PWSH = process.env.PWSH_PATH || "pwsh";

// Alle Cmdlets, die der Deploy-Body verwenden darf (haelt die EXO-Session schlank).
const COMMANDS = [
  "Get-AcceptedDomain",
  "Get-QuarantinePolicy", "New-QuarantinePolicy", "Set-QuarantinePolicy",
  "Get-AntiPhishPolicy", "New-AntiPhishPolicy", "Set-AntiPhishPolicy",
  "Get-AntiPhishRule", "New-AntiPhishRule", "Set-AntiPhishRule",
  "Get-HostedContentFilterPolicy", "New-HostedContentFilterPolicy", "Set-HostedContentFilterPolicy",
  "Get-HostedContentFilterRule", "New-HostedContentFilterRule", "Set-HostedContentFilterRule",
  "Get-MalwareFilterPolicy", "New-MalwareFilterPolicy", "Set-MalwareFilterPolicy",
  "Get-MalwareFilterRule", "New-MalwareFilterRule", "Set-MalwareFilterRule"
].join(",");


// Generischer pwsh-Lauf: Skript ueber stdin, JSON zwischen Markern extrahieren.
function runPwsh(script, timeoutMs) {
  timeoutMs = timeoutMs || 180000;
  return new Promise((resolve) => {
    let ps;
    try {
      ps = spawn(PWSH, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"], { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      return resolve({ ok: false, error: "pwsh nicht startbar: " + e.message, raw: "" });
    }
    let out = "", err = "", done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); try { ps.kill(); } catch (e) {} resolve(r); };
    const timer = setTimeout(() => finish({ ok: false, error: "Zeitueberschreitung (" + Math.round(timeoutMs / 1000) + "s)", raw: out + err }), timeoutMs);
    ps.on("error", e => finish({ ok: false, error: "pwsh-Fehler: " + e.message, raw: "" }));
    ps.stdout.on("data", d => out += d.toString());
    ps.stderr.on("data", d => err += d.toString());
    ps.on("close", () => {
      const m = out.match(/BEGINJSON([\s\S]*?)ENDJSON/);
      if (m) { try { return finish({ ok: true, data: JSON.parse(m[1]), raw: out }); } catch (e) { return finish({ ok: false, error: "JSON-Parse-Fehler: " + e.message, raw: m[1].slice(0, 500) }); } }
      // Kein Marker -> wahrscheinlich Connect-/Auth-Fehler in stderr
      const reason = (err || out).trim().split(/\r?\n/).filter(Boolean).slice(-4).join(" | ") || "keine Ausgabe";
      finish({ ok: false, error: reason.slice(0, 600), raw: (out + err).slice(0, 2000) });
    });
    ps.stdin.write(script + "\r\n");
    ps.stdin.end();
  });
}

function psQuote(s) { return "'" + String(s == null ? "" : s).replace(/'/g, "''") + "'"; }

/**
 * Verbindet EXO app-only mit dem Zertifikat und fuehrt bodyScript aus.
 * @param {object} opts { appId, organization (tenant.onmicrosoft.com), certPemPath }
 * @param {string} bodyScript  gibt sein Ergebnis via BEGINJSON..ENDJSON aus
 */
async function runExo(opts, bodyScript, timeoutMs) {
  if (!opts.certPemPath) return { ok: false, error: "Kein Zertifikat-Pfad." };
  const wrapper = [
    "$ErrorActionPreference = 'Stop'",
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
  return runPwsh(wrapper, timeoutMs);
}

/**
 * Verbindet Security & Compliance PowerShell app-only (Connect-IPPSSession, gleiche
 * App + Zertifikat wie EXO) und fuehrt bodyScript aus. Voraussetzung im Tenant:
 * Exchange.ManageAsApp + Entra-Rolle "Compliance Administrator" (setzt das Onboarding).
 * Modul v3.2+ verbindet REST-basiert — laeuft damit auch im Linux-Container.
 */
async function runIpps(opts, bodyScript, timeoutMs) {
  if (!opts.certPemPath) return { ok: false, error: "Kein Zertifikat-Pfad." };
  const wrapper = [
    "$ErrorActionPreference = 'Stop'",
    "try {",
    "  Import-Module ExchangeOnlineManagement -ErrorAction Stop",
    "} catch { Write-Output ('BEGINJSON' + (@{ ok = $false; error = 'ExchangeOnlineManagement-Modul fehlt: ' + $_.Exception.Message } | ConvertTo-Json -Compress) + 'ENDJSON'); exit 0 }",
    "try {",
    "  $cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPemFile(" + psQuote(opts.certPemPath) + ")",
    "} catch { Write-Output ('BEGINJSON' + (@{ ok = $false; error = 'Zertifikat nicht ladbar: ' + $_.Exception.Message } | ConvertTo-Json -Compress) + 'ENDJSON'); exit 0 }",
    // Dokumentierter Microsoft-Workaround: Connect-IPPSSession hat auf Linux einen
    // Plattform-Erkennungs-Bug bei CBA — $Global:IsWindows = $true umgeht ihn.
    "try { Set-Variable -Name IsWindows -Value $true -Scope Global -Force -ErrorAction SilentlyContinue } catch {}",
    // Retry: frisch zugewiesene Compliance-Administrator-Rollen brauchen Replikationszeit.
    "$ippsConnected = $false",
    "$ippsErr = ''",
    "for ($ci = 1; $ci -le 3; $ci++) {",
    "  try {",
    "    Connect-IPPSSession -AppId " + psQuote(opts.appId) + " -Organization " + psQuote(opts.organization) + " -Certificate $cert -ShowBanner:$false -ErrorAction Stop",
    "    $ippsConnected = $true",
    "    break",
    "  } catch {",
    "    $ippsErr = $_.Exception.Message",
    "    if ($ci -lt 3) { Start-Sleep -Seconds (15 * $ci) }",
    "  }",
    "}",
    "if (-not $ippsConnected) { Write-Output ('BEGINJSON' + (@{ ok = $false; error = 'Connect-IPPSSession fehlgeschlagen (Compliance-Administrator-Rolle noetig? Tenant neu onboarden): ' + $ippsErr } | ConvertTo-Json -Compress) + 'ENDJSON'); exit 0 }",
    "",
    bodyScript,
    "",
    "try { Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue | Out-Null } catch {}"
  ].join("\r\n");
  return runPwsh(wrapper, timeoutMs);
}

module.exports = { runPwsh, runExo, runIpps, psQuote };
