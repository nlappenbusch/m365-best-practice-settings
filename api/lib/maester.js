/**
 * Maester-Security-Audit: fuehrt die Maester-Testsuite (maester.dev) app-only
 * gegen einen Tenant aus — CISA-, CIS-, EIDSCA- und Community-Tests, rein lesend.
 *
 * Ablauf pro Lauf: Connect-MgGraph app-only mit dem Tenant-Zertifikat (gleiches
 * PEM wie die EXO-Verbindung), best-effort zusaetzlich Connect-ExchangeOnline
 * (ohne EXO werden die EXO-/ORCA-Tests uebersprungen, der Rest laeuft trotzdem).
 * Die Testsuite liegt gebacken im Image (MAESTER_TESTS_DIR, Default
 * /opt/maester-tests) und wird pro Lauf in ein Temp-Verzeichnis kopiert, weil
 * Pester in den Testordner schreibt.
 *
 * Ergebnis: report.html + results.json im uebergebenen outDir, dazu eine
 * kompakte Zusammenfassung (Zaehler + gefallene Tests) via BEGINJSON-Marker.
 */
const fs = require("fs");
const path = require("path");
const EXO = require("./exorunner");

const DEFAULT_TESTS_DIR = process.env.MAESTER_TESTS_DIR || "/opt/maester-tests";
// Laufzeit: 360+ Tests, Graph-lastig — grosse Tenants brauchen locker 15 Minuten.
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
// Mehr gefallene Tests als das speichern wir nicht in der Zusammenfassung —
// die Vollliste steht in results.json auf der Platte.
const FAILED_CAP = 200;

// Suiten-Filter: nur bekannte Maester-Tags durchlassen — die Werte landen im
// generierten pwsh-Skript, deshalb strikte Allowlist statt Escaping.
const ALLOWED_TAGS = ["CISA", "CIS", "EIDSCA", "ORCA", "Maester"];
function sanitizeTags(tags) {
  return Array.isArray(tags) ? tags.filter(t => ALLOWED_TAGS.includes(t)) : [];
}
function tagsClause(tags) {
  const clean = sanitizeTags(tags);
  if (!clean.length || clean.length === ALLOWED_TAGS.length) return ""; // alles = kein Filter
  return "; $p['Tag'] = @(" + clean.map(t => "'" + t + "'").join(",") + ")";
}

/**
 * Maester-Lauf starten.
 * @param {object} opts { tenant (Record aus state.json), certPemPath, outDir, testsDir?, timeoutMs?, tags? }
 * @param {function} onProgress  bekommt Phasen-Labels (BPPROGRESS-Stream)
 * @param {function} onChild     bekommt den pwsh-Kindprozess (Abbruch)
 */
async function runMaester(opts, onProgress, onChild) {
  const testsDir = opts.testsDir || DEFAULT_TESTS_DIR;
  if (!fs.existsSync(testsDir)) {
    return { ok: false, error: "Maester-Testsuite nicht gefunden (" + testsDir + ") — Image ohne Maester gebaut? Neu deployen." };
  }
  if (!opts.certPemPath || !fs.existsSync(opts.certPemPath)) {
    return { ok: false, error: "Kein Tenant-Zertifikat — Tenant neu onboarden." };
  }
  fs.mkdirSync(opts.outDir, { recursive: true });

  const q = EXO.psQuote;
  const t = opts.tenant;
  const htmlPath = path.join(opts.outDir, "report.html");
  const jsonPath = path.join(opts.outDir, "results.json");

  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "function BpPhase($label) { Write-Output ('BPPROGRESS' + (@{ type = 'phase'; label = $label } | ConvertTo-Json -Compress) + 'ENDPROGRESS') }",
    "function BpFail($msg) { Write-Output ('BEGINJSON' + (@{ ok = $false; error = [string]$msg } | ConvertTo-Json -Compress) + 'ENDJSON'); exit 0 }",
    "",
    "BpPhase 'Verbindung zu Microsoft Graph'",
    "try { Import-Module Microsoft.Graph.Authentication -ErrorAction Stop } catch { BpFail ('Microsoft.Graph.Authentication-Modul fehlt: ' + $_.Exception.Message) }",
    "try {",
    "  $cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPemFile(" + q(opts.certPemPath) + ")",
    "  Connect-MgGraph -ClientId " + q(t.clientId) + " -TenantId " + q(t.tenantId) + " -Certificate $cert -NoWelcome -ErrorAction Stop | Out-Null",
    "} catch { BpFail ('Connect-MgGraph fehlgeschlagen (Berechtigungen im Tab Tenants reparieren?): ' + $_.Exception.Message) }",
    "",
    "BpPhase 'Verbindung zu Exchange Online'",
    "$exoConnected = $false; $exoError = $null",
    "try {",
    "  Import-Module ExchangeOnlineManagement -ErrorAction Stop",
    "  Connect-ExchangeOnline -AppId " + q(t.clientId) + " -Organization " + q(t.organization) + " -Certificate $cert -ShowBanner:$false -ErrorAction Stop",
    "  $exoConnected = $true",
    "} catch { $exoError = $_.Exception.Message }",
    "",
    "BpPhase 'Testsuite vorbereiten'",
    "$runDir = Join-Path ([System.IO.Path]::GetTempPath()) ('maester-' + [guid]::NewGuid().ToString('N'))",
    "try { Copy-Item -Recurse -Path " + q(testsDir) + " -Destination $runDir -ErrorAction Stop } catch { BpFail ('Testsuite nicht kopierbar: ' + $_.Exception.Message) }",
    "",
    "BpPhase 'Maester-Tests laufen (dauert mehrere Minuten)'",
    "try { Import-Module Maester -ErrorAction Stop } catch { BpFail ('Maester-Modul fehlt: ' + $_.Exception.Message) }",
    "$results = $null; $invokeError = $null",
    "try {",
    "  $p = @{ Path = $runDir; PassThru = $true }" + (tagsClause(opts.tags) || ""),
    "  $cmd = Get-Command Invoke-Maester",
    // Optionale Schalter nur setzen, wenn die installierte Maester-Version sie
    // kennt — so bricht ein Modul-Update den Lauf nicht mit ParameterNotFound.
    "  foreach ($opt in 'NonInteractive','SkipVersionCheck','DisableTelemetry') { if ($cmd.Parameters.ContainsKey($opt)) { $p[$opt] = $true } }",
    "  if ($cmd.Parameters.ContainsKey('OutputHtmlFile')) { $p['OutputHtmlFile'] = " + q(htmlPath) + " }",
    "  if ($cmd.Parameters.ContainsKey('OutputJsonFile')) { $p['OutputJsonFile'] = " + q(jsonPath) + " }",
    "  $results = Invoke-Maester @p",
    "} catch { $invokeError = $_.Exception.Message }",
    "finally {",
    "  try { Disconnect-MgGraph -ErrorAction SilentlyContinue | Out-Null } catch {}",
    "  if ($exoConnected) { try { Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue | Out-Null } catch {} }",
    "  try { Remove-Item -Recurse -Force $runDir -ErrorAction SilentlyContinue } catch {}",
    "}",
    "if ($invokeError) { BpFail ('Invoke-Maester fehlgeschlagen: ' + $invokeError) }",
    "if (-not $results) { BpFail 'Invoke-Maester lieferte kein Ergebnis (keine Tests gelaufen?).' }",
    "",
    "BpPhase 'Auswertung'",
    // Feldnamen defensiv aufloesen — die Ergebnisobjekte haben sich zwischen
    // Maester-Versionen schon umbenannt (Name/Title, Id/Name).
    "function BpField($o, $names) { foreach ($n in $names) { $pp = $o.PSObject.Properties[$n]; if ($pp -and $null -ne $pp.Value -and '' -ne [string]$pp.Value) { return $pp.Value } } return $null }",
    "$tests = @($results.Tests)",
    "$passed = 0; $failedCount = 0; $skipped = 0; $other = 0; $failed = @()",
    "foreach ($tt in $tests) {",
    "  $res = [string](BpField $tt @('Result'))",
    "  if ($res -like 'Passed*') { $passed++ }",
    "  elseif ($res -like 'Failed*') {",
    "    $failedCount++",
    "    if ($failed.Count -lt " + FAILED_CAP + ") {",
    "      $failed += [pscustomobject]@{",
    "        id = [string](BpField $tt @('Id','Name'))",
    "        title = [string](BpField $tt @('Title','Name'))",
    "        severity = [string](BpField $tt @('Severity'))",
    "        block = [string](BpField $tt @('Block'))",
    "        helpUrl = [string](BpField $tt @('HelpUrl'))",
    "      }",
    "    }",
    "  }",
    "  elseif ($res -like 'Skipped*') { $skipped++ }",
    "  else { $other++ }",
    "}",
    "$summary = @{",
    "  ok = $true",
    "  counts = @{ total = $tests.Count; passed = $passed; failed = $failedCount; skipped = $skipped; other = $other }",
    "  exoConnected = $exoConnected",
    "  exoError = $exoError",
    "  failed = @($failed)",
    "  maesterVersion = [string]((Get-Module Maester | Select-Object -First 1).Version)",
    "}",
    "Write-Output ('BEGINJSON' + ($summary | ConvertTo-Json -Compress -Depth 6) + 'ENDJSON')"
  ].join("\r\n");

  const r = await EXO.runPwsh(script, opts.timeoutMs || DEFAULT_TIMEOUT_MS, onProgress, onChild);
  if (r.ok && r.data && r.data.ok) {
    r.data.htmlAvailable = fs.existsSync(htmlPath);
    r.data.jsonAvailable = fs.existsSync(jsonPath);
  }
  return r;
}

/** Score in Prozent: bestanden / (bestanden + gefallen). Skips zaehlen nicht. */
function score(counts) {
  const rated = (counts.passed || 0) + (counts.failed || 0);
  return rated ? Math.round(((counts.passed || 0) / rated) * 100) : null;
}

/** Historie eines Tenants von der Platte lesen (nur die summary.json je Lauf). */
function listRuns(baseDir, tenantRecId) {
  const dir = path.join(baseDir, tenantRecId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(n => /^[A-Za-z0-9-]+$/.test(n))
    .sort().reverse()
    .map(runId => {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(dir, runId, "summary.json"), "utf8"));
        return { runId, generatedAt: s.generatedAt, counts: s.counts, score: score(s.counts || {}), exoConnected: !!s.exoConnected, htmlAvailable: !!s.htmlAvailable };
      } catch (e) { return null; }
    })
    .filter(Boolean);
}

/** Alte Laeufe wegputzen — Reports sind ein paar hundert KB, das laeppert sich. */
function pruneRuns(baseDir, tenantRecId, keep) {
  const dir = path.join(baseDir, tenantRecId);
  if (!fs.existsSync(dir)) return;
  const runs = fs.readdirSync(dir).filter(n => /^[A-Za-z0-9-]+$/.test(n)).sort().reverse();
  for (const old of runs.slice(keep || 8)) {
    try { fs.rmSync(path.join(dir, old), { recursive: true, force: true }); } catch (e) { /* best effort */ }
  }
}

module.exports = { runMaester, listRuns, pruneRuns, score, sanitizeTags, ALLOWED_TAGS };
