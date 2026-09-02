/**
 * SPF/DKIM/DMARC-Checker.
 *
 * Der DKIM-Aktivierungsstatus kommt aus Exchange Online (Get-DkimSigningConfig,
 * ueber exorunner.js/BEGINJSON-Konvention). SPF, DMARC und die tatsaechlich im
 * oeffentlichen DNS veroeffentlichten DKIM-CNAME-Records werden direkt per
 * Node dns.promises aufgeloest — das sind oeffentliche Records, dafuer braucht
 * es keine Graph-/EXO-Berechtigung.
 *
 * Der Fall, den ein reiner M365-Status alleine verpasst: DKIM steht in
 * Exchange Online auf "Enabled", aber die zwei CNAME-Records wurden beim
 * Registrar nie gesetzt — Mails werden trotzdem NICHT signiert. Das faellt
 * nur auf, wenn man M365-Konfiguration und oeffentliches DNS zusammen prueft.
 */
const dns = require("dns").promises;
const { NON_MAIL_DOMAIN_PS_FILTER } = require("./deploy");

const DKIM_SELECTORS = ["selector1", "selector2"]; // Microsoft-365-Standardselektoren

// Ein EXO-Aufruf statt zwei getrennter Connect-/Disconnect-Zyklen: liefert
// dieselbe gefilterte Domain-Liste wie Audit (Get-AcceptedDomain, gemeinsamer
// Filter aus deploy.js) plus den DKIM-Status je Domain in einer Antwort.
function buildDomainAuthExoBody() {
  return [
    "function Get-Safe([scriptblock]$sb) { try { & $sb } catch { $null } }",
    "$domains = @(Get-Safe { Get-AcceptedDomain | ForEach-Object DomainName | " + NON_MAIL_DOMAIN_PS_FILTER + " })",
    "$configs = @(Get-Safe { Get-DkimSigningConfig | Select-Object Domain, Enabled, Status, Selector1CNAME, Selector2CNAME })",
    "Write-Output ('BEGINJSON' + (@{ ok = $true; domains = $domains; configs = $configs } | ConvertTo-Json -Compress -Depth 6) + 'ENDJSON')"
  ].join("\r\n");
}

/**
 * DKIM fuer EINE Domain einschalten.
 *
 * Der Ablauf ist derselbe wie im Portal, nur ohne Klickweg: Gibt es noch keine
 * Signierungs-Konfiguration, wird sie mit 2048 Bit angelegt (New-...), sonst
 * nur aktiviert (Set-...).
 *
 * Reihenfolge ist hier keine Geschmacksfrage: Exchange verweigert das
 * Einschalten, solange die beiden CNAME-Records nicht im oeffentlichen DNS
 * stehen ("CNAME record does not exist"). Genau deshalb prueft das Tool die
 * CNAMEs vorher selbst und bietet diesen Knopf erst an, wenn sie da sind — die
 * Fehlermeldung von Exchange wird trotzdem durchgereicht, falls das DNS
 * zwischenzeitlich wieder anders aussieht.
 *
 * Die Schluessellaenge einer BESTEHENDEN Konfiguration wird bewusst nicht
 * angefasst: Ein Wechsel auf 2048 Bit ist eine Rotation
 * (Rotate-DkimSigningConfig) mit eigenem Zeitfenster, kein Nebeneffekt eines
 * Aktivieren-Klicks. Der gelesene Wert kommt zurueck, damit die Oberflaeche
 * darauf hinweisen kann.
 */
function buildDkimEnableExoBody(domain) {
  const d = String(domain || "").trim().toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d)) {
    throw Object.assign(new Error("Ungültiger Domainname."), { status: 400 });
  }
  // Einfachquotes verdoppeln waere hier ueberfluessig (die Regex oben laesst
  // kein Quote durch), steht aber bewusst da: Wer die Pruefung spaeter lockert,
  // soll nicht gleichzeitig eine Injektionsluecke aufmachen.
  const lit = "'" + d.replace(/'/g, "''") + "'";
  return [
    "function Get-Safe([scriptblock]$sb) { try { & $sb } catch { $null } }",
    `$d = ${lit}`,
    "$cfg = Get-Safe { Get-DkimSigningConfig -Identity $d -ErrorAction Stop }",
    "$created = $false",
    "$err = $null",
    "try {",
    "    if ($null -eq $cfg) {",
    "        New-DkimSigningConfig -DomainName $d -KeySize 2048 -Enabled $true -ErrorAction Stop | Out-Null",
    "        $created = $true",
    "    } elseif (-not $cfg.Enabled) {",
    "        Set-DkimSigningConfig -Identity $d -Enabled $true -ErrorAction Stop | Out-Null",
    "    }",
    "} catch {",
    "    $err = $_.Exception.Message",
    "}",
    "$after = Get-Safe { Get-DkimSigningConfig -Identity $d -ErrorAction Stop }",
    "$res = @{",
    "    ok = ($null -eq $err)",
    "    error = $err",
    "    created = $created",
    "    domain = $d",
    "    enabled = [bool]$after.Enabled",
    "    status = [string]$after.Status",
    "    keySize = $after.KeySize",
    "    selector1CNAME = [string]$after.Selector1CNAME",
    "    selector2CNAME = [string]$after.Selector2CNAME",
    "}",
    "Write-Output ('BEGINJSON' + ($res | ConvertTo-Json -Compress -Depth 4) + 'ENDJSON')"
  ].join("\r\n");
}

// SPF-Kette rekursiv aufloesen: include:/redirect= nachschlagen, a/mx (die
// laut RFC ebenfalls Lookups kosten) best effort zu IPs aufloesen. Haelt sich
// ans 10-Lookup-Limit — was darueber liegt, bleibt unaufgeloest und wird als
// Problem markiert (strikte Pruefer werten das als permerror).
const SPF_MAX_LOOKUPS = 10;
const SPF_MAX_DEPTH = 5;

async function walkSpf(domain, depth, st) {
  if (depth > SPF_MAX_DEPTH) { st.chain.push({ source: domain, depth, error: "Maximale Verschachtelungstiefe erreicht" }); return; }
  const key = domain.toLowerCase();
  if (st.seen.has(key)) { st.chain.push({ source: domain, depth, error: "Schleife — bereits aufgelöst" }); return; }
  st.seen.add(key);

  let flat;
  try { flat = (await dns.resolveTxt(domain)).map(p => p.join("")); }
  catch (e) { st.chain.push({ source: domain, depth, error: "TXT nicht auflösbar" }); return; }
  const spf = flat.find(r => /^v=spf1\b/i.test(r));
  if (!spf) { st.chain.push({ source: domain, depth, error: "kein SPF-Record" }); return; }
  st.chain.push({ source: domain, depth, record: spf });

  for (const raw of spf.split(/\s+/).slice(1)) {
    const m = raw.replace(/^[+~?-]/, "");
    if (/^ip[46]:/i.test(m)) { st.ips.push(m); continue; }
    if (/^(include:|redirect=)/i.test(m)) {
      const target = m.replace(/^include:/i, "").replace(/^redirect=/i, "");
      st.lookups++;
      if (st.lookups > SPF_MAX_LOOKUPS) { st.exceeded = true; st.chain.push({ source: target, depth: depth + 1, error: "über dem 10-Lookup-Limit — nicht weiter aufgelöst" }); continue; }
      await walkSpf(target, depth + 1, st);
      continue;
    }
    if (/^(a|a:|mx|mx:)/i.test(m) && !/^all$/i.test(m)) {
      st.lookups++;
      if (st.lookups > SPF_MAX_LOOKUPS) { st.exceeded = true; st.others.push(m + " (nicht aufgelöst — Lookup-Limit)"); continue; }
      const host = m.includes(":") ? m.split(":")[1] : domain;
      try {
        if (/^mx/i.test(m)) {
          const mx = await dns.resolveMx(host);
          st.others.push(m + " → " + (mx.map(x => x.exchange).slice(0, 3).join(", ") || "keine MX"));
        } else {
          const a = await dns.resolve4(host).catch(() => []);
          st.others.push(m + " → " + (a.slice(0, 3).join(", ") || "keine A-Records"));
        }
      } catch (e) { st.others.push(m + " (nicht auflösbar)"); }
      continue;
    }
    if (/^exists:/i.test(m)) { st.lookups++; st.others.push(m); if (st.lookups > SPF_MAX_LOOKUPS) st.exceeded = true; continue; }
  }
}

async function lookupSpf(domain) {
  let records;
  try { records = await dns.resolveTxt(domain); }
  catch (e) { return { status: "bad", record: null, issues: ["Kein SPF-TXT-Record gefunden — jeder kann die Domain fälschen."] }; }
  const flat = records.map(parts => parts.join(""));
  const spf = flat.filter(r => /^v=spf1\b/i.test(r));
  if (!spf.length) return { status: "bad", record: null, issues: ["Kein SPF-TXT-Record gefunden — jeder kann die Domain fälschen."] };
  const issues = [];
  const record = spf[0];
  if (spf.length > 1) issues.push(spf.length + " SPF-Records gefunden — laut RFC ist nur EIN Record pro Domain erlaubt, das Ergebnis ist unbestimmt.");
  let status = "ok";
  if (/\+all\b/i.test(record)) { status = "bad"; issues.push('"+all" erlaubt jeden Absender — SPF ist wirkungslos.'); }
  else if (/\?all\b/i.test(record)) { status = "bad"; issues.push('"?all" (Neutral) trifft keine Aussage — praktisch wirkungslos.'); }
  else if (/~all\b/i.test(record)) { status = "warn"; issues.push('"~all" (Soft Fail) markiert nur, blockt aber nicht — "-all" ist strenger.'); }
  else if (!/-all\b/i.test(record)) { status = "warn"; issues.push('Kein "all"-Mechanismus gefunden — unklares Verhalten für nicht gelistete Absender.'); }
  if (spf.length > 1 && status === "ok") status = "warn";

  // Kette aufloesen (der Root-TXT-Lookup zaehlt nicht ins Limit — nur die
  // Mechanismen). Best effort: schlaegt die Aufloesung fehl, bleibt der
  // Basis-Befund trotzdem stehen.
  const st = { lookups: 0, seen: new Set(), chain: [], ips: [], others: [], exceeded: false };
  try { await walkSpf(domain, 0, st); } catch (e) { /* Kette optional */ }
  if (st.exceeded) {
    status = "bad";
    issues.push(`SPF überschreitet das 10-DNS-Lookup-Limit (${st.lookups}) — strikte Prüfer werten das als permerror, SPF fällt dann aus.`);
  } else if (st.lookups >= 8) {
    issues.push(`${st.lookups}/10 DNS-Lookups belegt — wenig Reserve für weitere include:-Verweise.`);
  }

  return {
    status, record, issues,
    chain: st.chain,
    effective: { ips: st.ips, others: st.others },
    lookups: st.lookups,
    lookupLimitExceeded: st.exceeded
  };
}

async function lookupDmarc(domain) {
  let records;
  try { records = await dns.resolveTxt("_dmarc." + domain); }
  catch (e) { return { status: "bad", record: null, policy: null, issues: ["Kein DMARC-Record unter _dmarc." + domain + " gefunden."] }; }
  const flat = records.map(parts => parts.join(""));
  const dmarc = flat.find(r => /^v=DMARC1\b/i.test(r));
  if (!dmarc) return { status: "bad", record: null, policy: null, issues: ["Kein DMARC-Record unter _dmarc." + domain + " gefunden."] };
  const pMatch = dmarc.match(/;\s*p=([a-z]+)/i);
  const policy = pMatch ? pMatch[1].toLowerCase() : null;
  const pctMatch = dmarc.match(/;\s*pct=(\d+)/i);
  const pct = pctMatch ? Number(pctMatch[1]) : 100;
  const hasRua = /;\s*rua=/i.test(dmarc);
  const issues = [];
  let status;
  if (policy === "reject" || policy === "quarantine") status = "ok";
  else if (policy === "none") { status = "warn"; issues.push('Policy "p=none" ist reines Monitoring — Spoofing wird noch NICHT blockiert.'); }
  else { status = "bad"; issues.push("Keine gültige p=-Angabe im DMARC-Record."); }
  if (pct < 100) issues.push("pct=" + pct + " — nur " + pct + "% der Mails werden nach dieser Policy behandelt, der Rest wie bei der nächstschwächeren Stufe.");
  if (!hasRua) issues.push("Kein rua= (Aggregatberichte) konfiguriert — Spoofing-Versuche bleiben unsichtbar.");
  return { status, record: dmarc, policy, pct, issues };
}

async function lookupDkimCname(domain, selector) {
  try {
    const target = await dns.resolveCname(selector + "._domainkey." + domain);
    return target[0] || null;
  } catch (e) {
    return null;
  }
}

/**
 * Fuehrt SPF/DMARC/DKIM-CNAME-DNS-Checks fuer alle domains parallel aus und
 * merged sie mit dem M365-seitigen DKIM-Status (dkimConfigs aus Get-DkimSigningConfig).
 */
async function checkDomains(domains, dkimConfigs) {
  const configByDomain = new Map();
  for (const c of (dkimConfigs || [])) {
    if (c && c.Domain) configByDomain.set(String(c.Domain).toLowerCase(), c);
  }
  return Promise.all(domains.map(async domain => {
    const [spf, dmarc, cname1, cname2] = await Promise.all([
      lookupSpf(domain),
      lookupDmarc(domain),
      lookupDkimCname(domain, DKIM_SELECTORS[0]),
      lookupDkimCname(domain, DKIM_SELECTORS[1])
    ]);
    const m365 = configByDomain.get(domain.toLowerCase());
    const cnamesPublished = !!(cname1 && cname2);
    let dkimStatus, dkimIssues = [];
    if (!m365) { dkimStatus = "bad"; dkimIssues.push("Für diese Domain existiert keine DKIM-Konfiguration in Exchange Online (New-DkimSigningConfig nie ausgeführt)."); }
    else if (!m365.Enabled) { dkimStatus = "bad"; dkimIssues.push("DKIM ist in Exchange Online für diese Domain vorhanden, aber nicht aktiviert (Enabled=false)."); }
    else if (!cnamesPublished) { dkimStatus = "bad"; dkimIssues.push("DKIM ist in Exchange Online aktiviert, aber die CNAME-Records (selector1/selector2._domainkey) sind im öffentlichen DNS nicht auffindbar — Mails werden trotzdem NICHT signiert."); }
    else { dkimStatus = "ok"; }
    return {
      domain,
      spf,
      dmarc,
      dkim: { status: dkimStatus, enabledInM365: !!(m365 && m365.Enabled), cnamesPublished, selector1: cname1, selector2: cname2, issues: dkimIssues }
    };
  }));
}

module.exports = { buildDomainAuthExoBody, buildDkimEnableExoBody, lookupSpf, lookupDmarc, lookupDkimCname, checkDomains, DKIM_SELECTORS };
