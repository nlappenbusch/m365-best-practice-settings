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
  const includeCount = (record.match(/include:/gi) || []).length;
  let status = "ok";
  if (/\+all\b/i.test(record)) { status = "bad"; issues.push('"+all" erlaubt jeden Absender — SPF ist wirkungslos.'); }
  else if (/\?all\b/i.test(record)) { status = "bad"; issues.push('"?all" (Neutral) trifft keine Aussage — praktisch wirkungslos.'); }
  else if (/~all\b/i.test(record)) { status = "warn"; issues.push('"~all" (Soft Fail) markiert nur, blockt aber nicht — "-all" ist strenger.'); }
  else if (!/-all\b/i.test(record)) { status = "warn"; issues.push('Kein "all"-Mechanismus gefunden — unklares Verhalten für nicht gelistete Absender.'); }
  if (includeCount > 7) issues.push(includeCount + ' include:-Verweise — Risiko, das SPF-DNS-Lookup-Limit (max. 10) zu überschreiten.');
  if (spf.length > 1 && status === "ok") status = "warn";
  return { status, record, issues };
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

module.exports = { buildDomainAuthExoBody, lookupSpf, lookupDmarc, lookupDkimCname, checkDomains };
