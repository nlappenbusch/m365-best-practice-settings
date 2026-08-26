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
 * @param {object} opts { tenant (Record aus state.json), certPemPath, outDir, testsDir?, timeoutMs?, tags?, onDetail? (Live-Fortschritt) }
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

  const summaryPath = path.join(opts.outDir, "summary-raw.json");

  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    // Keine ANSI-/Terminal-Sequenzen in den Streams — die Ausgabe wird geparst,
    // nicht angeschaut. (PSStyle gibt es ab 7.2; defensiv.)
    "try { $PSStyle.OutputRendering = 'PlainText' } catch {}",
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
    // Detailed: Pester schreibt pro Test eine Zeile — daraus baut das Backend
    // die Live-Anzeige (aktueller Block/Test + Zaehler).
    "  if ($cmd.Parameters.ContainsKey('Verbosity')) { $p['Verbosity'] = 'Detailed' }",
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
    // Die Zusammenfassung geht als DATEI raus, nicht ueber stdout: die Konsole
    // ist nach einem Maester-Lauf voller Terminal-Sequenzen, ein grosser
    // JSON-Marker darin ist schon einmal verstuemmelt worden. Ueber stdout
    // kommt nur noch ein Mini-Marker. Und alles in try/catch — stirbt die
    // Auswertung, soll eine klare Meldung stehen, kein roher Konsolenrest.
    "try {",
    // Feldnamen defensiv aufloesen — die Ergebnisobjekte haben sich zwischen
    // Maester-Versionen schon umbenannt (Name/Title, Id/Name).
    "  function BpField($o, $names) { foreach ($n in $names) { $pp = $o.PSObject.Properties[$n]; if ($pp -and $null -ne $pp.Value -and '' -ne [string]$pp.Value) { return $pp.Value } } return $null }",
    "  $tests = @($results.Tests | Where-Object { $null -ne $_ })",
    "  $passed = 0; $failedCount = 0; $skipped = 0; $other = 0; $failed = @()",
    "  foreach ($tt in $tests) {",
    "    $res = [string](BpField $tt @('Result'))",
    "    if ($res -like 'Passed*') { $passed++ }",
    "    elseif ($res -like 'Failed*') {",
    "      $failedCount++",
    "      if ($failed.Count -lt " + FAILED_CAP + ") {",
    "        $failed += [pscustomobject]@{",
    "          id = [string](BpField $tt @('Id','Name'))",
    "          title = [string](BpField $tt @('Title','Name'))",
    "          severity = [string](BpField $tt @('Severity'))",
    "          block = [string](BpField $tt @('Block'))",
    "          helpUrl = [string](BpField $tt @('HelpUrl'))",
    "        }",
    "      }",
    "    }",
    "    elseif ($res -like 'Skipped*') { $skipped++ }",
    "    else { $other++ }",
    "  }",
    "  $summary = @{",
    "    ok = $true",
    "    counts = @{ total = $tests.Count; passed = $passed; failed = $failedCount; skipped = $skipped; other = $other }",
    "    exoConnected = $exoConnected",
    "    exoError = $exoError",
    "    failed = @($failed)",
    "    maesterVersion = [string]((Get-Module Maester | Select-Object -First 1).Version)",
    "  }",
    "  $summary | ConvertTo-Json -Compress -Depth 6 | Set-Content -Path " + q(summaryPath) + " -Encoding utf8",
    "  Write-Output ('BEGINJSON' + (@{ ok = $true; summaryInFile = $true } | ConvertTo-Json -Compress) + 'ENDJSON')",
    "} catch { BpFail ('Auswertung fehlgeschlagen: ' + $_.Exception.Message) }"
  ].join("\r\n");

  const r = await EXO.runPwsh(script, opts.timeoutMs || DEFAULT_TIMEOUT_MS, onProgress, (child) => {
    attachLiveParser(child, opts.onDetail);
    if (onChild) onChild(child);
  });
  // Zusammenfassung aus der Datei nachladen (siehe Kommentar im Skript).
  if (r.ok && r.data && r.data.ok && r.data.summaryInFile) {
    try { r.data = { ...JSON.parse(fs.readFileSync(summaryPath, "utf8")), ok: true }; }
    catch (e) { return { ok: false, error: "Zusammenfassung nicht lesbar: " + e.message }; }
  }
  if (r.ok && r.data && r.data.ok) {
    r.data.htmlAvailable = fs.existsSync(htmlPath);
    r.data.jsonAvailable = fs.existsSync(jsonPath);
  }
  if (!r.ok && r.error) r.error = stripAnsi(r.error);
  if (r.data && r.data.error) r.data.error = stripAnsi(r.data.error);
  return r;
}

// Terminal-Steuersequenzen (Farben, [?1h-Modi) aus Texten entfernen, die in
// der Oberflaeche landen.
function stripAnsi(s) {
  return String(s == null ? "" : s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\[\?[0-9]+[hl]/g, "");
}

/**
 * Live-Fortschritt aus dem Pester-Stream (Verbosity Detailed): "Describing X"
 * = aktueller Block, [+]/[-]/[!] = Test bestanden/gefallen/uebersprungen.
 * Gedrosselt auf ~2 Updates/Sekunde — der Job wird ohnehin nur gepollt.
 */
function attachLiveParser(child, onDetail) {
  if (!child || !child.stdout || !onDetail) return;
  let buf = "", block = null, test = null, passed = 0, failed = 0, skipped = 0;
  let lastEmit = 0, pending = null;
  const emit = () => { try { onDetail({ block, test, passed, failed, skipped }); } catch (e) { /* Anzeige ist optional */ } };
  const schedule = () => {
    const now = Date.now();
    if (now - lastEmit > 400) { lastEmit = now; emit(); }
    else if (!pending) { pending = setTimeout(() => { pending = null; lastEmit = Date.now(); emit(); }, 450); }
  };
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = stripAnsi(buf.slice(0, idx)).trim();
      buf = buf.slice(idx + 1);
      let m;
      if ((m = line.match(/^Describing\s+(.+)$/))) { block = m[1]; test = null; schedule(); }
      else if ((m = line.match(/^\[\+\]\s+(.+?)(\s+\d[\d.,]*\s*m?s\b.*)?$/))) { passed++; test = m[1]; schedule(); }
      else if ((m = line.match(/^\[-\]\s+(.+?)(\s+\d[\d.,]*\s*m?s\b.*)?$/))) { failed++; test = m[1]; schedule(); }
      else if ((m = line.match(/^\[!\]\s+(.+?)(\s+\d[\d.,]*\s*m?s\b.*)?$/))) { skipped++; test = m[1]; schedule(); }
    }
    // Puffer nicht unbegrenzt wachsen lassen, falls nie ein \n kommt.
    if (buf.length > 65536) buf = buf.slice(-8192);
  });
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
