/**
 * Baut aus der Tool-Konfiguration (JSON aus dem Browser) den PowerShell-Body
 * fuer den EXO-Runner. Setzt exakt dieselben BP_-Policies wie das generierte
 * Deployment-Skript — ohne den Security-&-Compliance-Teil (Alert Policy), der
 * weiterhin nur ueber das generierte Skript laeuft.
 *
 * Die Config kommt vom Client und wird hier strikt validiert/normalisiert,
 * bevor irgendetwas in PowerShell-Text interpoliert wird.
 */
const { psQuote } = require("./exorunner");

const PHISH_SPOOF_ACTIONS = ["Quarantine", "MoveToJmf"];
const DMARC_Q_ACTIONS = ["Quarantine", "MoveToJmf", "Reject", "None"];
const DMARC_R_ACTIONS = ["Reject", "Quarantine"];
const SPAM_ACTIONS = ["Quarantine", "MoveToJmf"];
const HC_PHISH_ACTIONS = ["Quarantine", "Reject", "MoveToJmf"];

function pick(value, allowed, field) {
  const v = String(value == null ? "" : value);
  if (!allowed.includes(v)) throw new Error("Ungueltiger Wert fuer " + field + ": " + v.slice(0, 40));
  return v;
}
function bool(v) { return v ? "$true" : "$false"; }
function intRange(v, min, max, field) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error("Ungueltiger Wert fuer " + field + ": " + String(v).slice(0, 40));
  return n;
}
function isDomain(d) {
  return typeof d === "string" && /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(d);
}
function isEmail(e) { return typeof e === "string" && /^[^\s@']+@[^\s@']+\.[^\s@']{2,}$/.test(e); }
function psArray(items) { return "@(" + items.map(psQuote).join(", ") + ")"; }

/** Validiert die rohe Client-Config und gibt eine normalisierte Struktur zurueck. */
function sanitizeConfig(raw) {
  if (!raw || typeof raw !== "object") throw new Error("Keine Konfiguration uebergeben.");
  const g = raw.global || {};
  const ap = raw.antiPhishing || {};
  const as = raw.antiSpam || {};
  const am = raw.antiMalware || {};

  const domains = (Array.isArray(g.domains) ? g.domains : []).map(d => String(d || "").trim().toLowerCase()).filter(Boolean);
  for (const d of domains) if (!isDomain(d)) throw new Error("Ungueltige Domain: " + d.slice(0, 60));
  const onms = String(g.onmicrosoftDomain || "").trim().toLowerCase();
  if (onms && !isDomain(onms)) throw new Error("Ungueltige onmicrosoft-Domain: " + onms.slice(0, 60));
  if (onms && !domains.includes(onms)) domains.push(onms);

  const adminEmail = String(g.adminEmail || "").trim();
  if (!isEmail(adminEmail)) throw new Error("Ungueltige Admin-Email: " + adminEmail.slice(0, 60));

  // MSP-Alert-Email (optional, zweiter Empfaenger der Alert Policy)
  const mspEmail = String(g.igeeksEmail || "").trim();
  if (mspEmail && !isEmail(mspEmail)) throw new Error("Ungueltige MSP-Alert-Email: " + mspEmail.slice(0, 60));

  // Filetypes: fuehrende Punkte entfernen — M365 erwartet sie ohne Punkt,
  // sonst zeigt die GUI "..exe" an.
  const rawTypes = Array.isArray(am.customFileTypes) ? am.customFileTypes : String(am.customFileTypes || "").split(",");
  const fileTypes = rawTypes
    .map(t => String(t || "").trim().replace(/^\.+/, "").toLowerCase())
    .filter(t => t.length > 0);
  for (const t of fileTypes) if (!/^[a-z0-9_-]{1,20}$/.test(t)) throw new Error("Ungueltiger Dateityp: " + t.slice(0, 40));
  if (fileTypes.length === 0) throw new Error("Keine Dateitypen fuer den Anhang-Filter angegeben.");

  return {
    domains,
    adminEmail,
    mspEmail,
    antiPhishing: {
      spoofIntelligence: !!ap.spoofIntelligence,
      firstContactTip: !!ap.firstContactTip,
      unauthSenderSymbol: !!ap.unauthSenderSymbol,
      viaTag: !!ap.viaTag,
      honorDmarc: !!ap.honorDmarc,
      dmarcQuarantineAction: pick(ap.dmarcQuarantineAction, DMARC_Q_ACTIONS, "dmarcQuarantineAction"),
      dmarcRejectAction: pick(ap.dmarcRejectAction, DMARC_R_ACTIONS, "dmarcRejectAction"),
      spoofAction: pick(ap.spoofAction, PHISH_SPOOF_ACTIONS, "spoofAction")
    },
    antiSpam: {
      bulkThreshold: intRange(as.bulkThreshold, 1, 9, "bulkThreshold"),
      bizInfoUrls: !!as.bizInfoUrls,
      numericIpUrls: !!as.numericIpUrls,
      urlRedirect: !!as.urlRedirect,
      emptyMessages: !!as.emptyMessages,
      jsVbScript: !!as.jsVbScript,
      frameIframe: !!as.frameIframe,
      sensitiveWords: !!as.sensitiveWords,
      spfHardFail: !!as.spfHardFail,
      backscatter: !!as.backscatter,
      spamAction: pick(as.spamAction, SPAM_ACTIONS, "spamAction"),
      highConfSpamAction: pick(as.highConfSpamAction, SPAM_ACTIONS, "highConfSpamAction"),
      bulkAction: pick(as.bulkAction, SPAM_ACTIONS, "bulkAction"),
      phishAction: pick(as.phishAction, SPAM_ACTIONS, "phishAction"),
      highConfPhishAction: pick(as.highConfPhishAction, HC_PHISH_ACTIONS, "highConfPhishAction")
    },
    antiMalware: {
      commonAttachFilter: !!am.commonAttachFilter,
      zapMalware: !!am.zapMalware,
      fileTypes
    }
  };
}

// Ein Upsert-Schritt: Get -> New oder Set, Ergebnis in $steps sammeln.
function step(name, identity, getCmd, newLines, setLines) {
  return [
    "try {",
    "  $existing = " + getCmd + " -Identity " + psQuote(identity) + " -ErrorAction SilentlyContinue",
    "  if ($null -eq $existing) {",
    ...newLines.map(l => "    " + l),
    "    $steps += @{ name = " + psQuote(name) + "; ok = $true; action = 'created' }",
    "  } else {",
    ...setLines.map(l => "    " + l),
    "    $steps += @{ name = " + psQuote(name) + "; ok = $true; action = 'updated' }",
    "  }",
    "} catch { $steps += @{ name = " + psQuote(name) + "; ok = $false; error = $_.Exception.Message } }",
    ""
  ];
}

/** Baut den pwsh-Body (laeuft innerhalb der runExo-Verbindung). */
function buildDeployBody(cfg) {
  const ap = cfg.antiPhishing, as = cfg.antiSpam, am = cfg.antiMalware;
  const onOff = v => v ? "'On'" : "'Off'";

  const phishParams = (cmdlet, nameArg) => [
    cmdlet + " " + nameArg + " `",
    "  -Enabled $true `",
    "  -EnableSpoofIntelligence " + bool(ap.spoofIntelligence) + " `",
    "  -EnableFirstContactSafetyTips " + bool(ap.firstContactTip) + " `",
    "  -EnableUnauthenticatedSender " + bool(ap.unauthSenderSymbol) + " `",
    "  -EnableViaTag " + bool(ap.viaTag) + " `",
    "  -HonorDmarcPolicy " + bool(ap.honorDmarc) + " `",
    "  -DmarcQuarantineAction " + ap.dmarcQuarantineAction + " `",
    "  -DmarcRejectAction " + ap.dmarcRejectAction + " `",
    "  -AuthenticationFailAction " + ap.spoofAction + " `",
    "  -SpoofQuarantineTag 'BP_Quarantine-SelfReleaseNotification' | Out-Null"
  ];

  const spamParams = (cmdlet, nameArg) => [
    cmdlet + " " + nameArg + " `",
    "  -BulkThreshold " + as.bulkThreshold + " `",
    "  -SpamAction " + as.spamAction + " `",
    "  -HighConfidenceSpamAction " + as.highConfSpamAction + " `",
    "  -BulkSpamAction " + as.bulkAction + " `",
    "  -PhishSpamAction " + as.phishAction + " `",
    "  -HighConfidencePhishAction " + as.highConfPhishAction + " `",
    "  -QuarantineRetentionPeriod 30 `",
    "  -InlineSafetyTipsEnabled $true `",
    "  -SpamQuarantineTag 'BP_Quarantine-SelfReleaseNotification' `",
    "  -HighConfidenceSpamQuarantineTag 'BP_Quarantine-SelfReleaseNotification' `",
    "  -BulkQuarantineTag 'BP_Quarantine-SelfReleaseNotification' `",
    "  -PhishQuarantineTag 'BP_Quarantine-SelfReleaseNotification' `",
    "  -HighConfidencePhishQuarantineTag 'BP_Quarantine-RequestReleaseNotification' `",
    "  -IncreaseScoreWithBizOrInfoUrls " + onOff(as.bizInfoUrls) + " `",
    "  -IncreaseScoreWithNumericIps " + onOff(as.numericIpUrls) + " `",
    "  -IncreaseScoreWithRedirectToOtherPort " + onOff(as.urlRedirect) + " `",
    "  -MarkAsSpamEmptyMessages " + onOff(as.emptyMessages) + " `",
    "  -MarkAsSpamJavaScriptInHtml " + onOff(as.jsVbScript) + " `",
    "  -MarkAsSpamFramesInHtml " + onOff(as.frameIframe) + " `",
    "  -MarkAsSpamSensitiveWordList " + onOff(as.sensitiveWords) + " `",
    "  -MarkAsSpamSpfRecordHardFail " + onOff(as.spfHardFail) + " `",
    "  -MarkAsSpamFromAddressAuthFail " + onOff(as.backscatter) + " | Out-Null"
  ];

  const malwareParams = (cmdlet, nameArg) => [
    cmdlet + " " + nameArg + " `",
    "  -EnableFileFilter " + bool(am.commonAttachFilter) + " `",
    "  -FileTypes $fileTypes `",
    "  -EnableInternalSenderAdminNotifications $true `",
    "  -EnableExternalSenderAdminNotifications $true `",
    "  -InternalSenderAdminAddress " + psQuote(cfg.adminEmail) + " `",
    "  -ExternalSenderAdminAddress " + psQuote(cfg.adminEmail) + " `",
    "  -ZapEnabled " + bool(am.zapMalware) + " `",
    "  -QuarantineTag 'BP_Quarantine-RequestReleaseNotification' | Out-Null"
  ];

  const ruleStep = (name, identity, getCmd, newCmd, setCmd, policyParam, policyName) => step(
    name, identity, getCmd,
    [newCmd + " -Name " + psQuote(identity) + " -" + policyParam + " " + psQuote(policyName) + " -RecipientDomainIs $Domains -Priority 0 | Out-Null"],
    [setCmd + " -Identity " + psQuote(identity) + " -RecipientDomainIs $Domains | Out-Null"]
  );

  const lines = [
    "$steps = @()",
    "try {",
    "  $Domains = " + (cfg.domains.length ? psArray(cfg.domains) : "@(Get-AcceptedDomain | ForEach-Object DomainName)"),
    "} catch { Write-Output ('BEGINJSON' + (@{ ok = $false; error = 'Domains nicht ermittelbar: ' + $_.Exception.Message } | ConvertTo-Json -Compress) + 'ENDJSON'); exit 0 }",
    "$fileTypes = " + psArray(am.fileTypes),
    "",
    "# --- Quarantine Policies (59 = AllowSender+BlockSender+RequestRelease+Preview+Delete / 26 = BlockSender+RequestRelease+Preview) ---",
    ...step("Quarantine-Policy SelfRelease", "BP_Quarantine-SelfReleaseNotification", "Get-QuarantinePolicy",
      ["New-QuarantinePolicy -Name 'BP_Quarantine-SelfReleaseNotification' -EndUserQuarantinePermissionsValue 59 -ESNEnabled $true -IncludeMessagesFromBlockedSenderAddress $true | Out-Null"],
      ["Set-QuarantinePolicy -Identity 'BP_Quarantine-SelfReleaseNotification' -EndUserQuarantinePermissionsValue 59 -ESNEnabled $true -IncludeMessagesFromBlockedSenderAddress $true | Out-Null"]),
    ...step("Quarantine-Policy RequestRelease", "BP_Quarantine-RequestReleaseNotification", "Get-QuarantinePolicy",
      ["New-QuarantinePolicy -Name 'BP_Quarantine-RequestReleaseNotification' -EndUserQuarantinePermissionsValue 26 -ESNEnabled $true -IncludeMessagesFromBlockedSenderAddress $false | Out-Null"],
      ["Set-QuarantinePolicy -Identity 'BP_Quarantine-RequestReleaseNotification' -EndUserQuarantinePermissionsValue 26 -ESNEnabled $true -IncludeMessagesFromBlockedSenderAddress $false | Out-Null"]),
    "",
    "# --- Anti-Phishing ---",
    ...step("Anti-Phishing-Policy", "BP_AntiPhishing", "Get-AntiPhishPolicy",
      phishParams("New-AntiPhishPolicy", "-Name 'BP_AntiPhishing'"),
      phishParams("Set-AntiPhishPolicy", "-Identity 'BP_AntiPhishing'")),
    ...ruleStep("Anti-Phishing-Rule", "BP_AntiPhishing_Rule", "Get-AntiPhishRule", "New-AntiPhishRule", "Set-AntiPhishRule", "AntiPhishPolicy", "BP_AntiPhishing"),
    "",
    "# --- Anti-Spam ---",
    ...step("Anti-Spam-Policy", "BP_AntiSpam_Inbound", "Get-HostedContentFilterPolicy",
      spamParams("New-HostedContentFilterPolicy", "-Name 'BP_AntiSpam_Inbound' -EnableEndUserSpamNotifications $true -EndUserSpamNotificationFrequency 1"),
      spamParams("Set-HostedContentFilterPolicy", "-Identity 'BP_AntiSpam_Inbound'")),
    ...ruleStep("Anti-Spam-Rule", "BP_AntiSpam_Inbound_Rule", "Get-HostedContentFilterRule", "New-HostedContentFilterRule", "Set-HostedContentFilterRule", "HostedContentFilterPolicy", "BP_AntiSpam_Inbound"),
    "",
    "# --- Anti-Malware ---",
    ...step("Anti-Malware-Policy", "BP_AntiMalware", "Get-MalwareFilterPolicy",
      malwareParams("New-MalwareFilterPolicy", "-Name 'BP_AntiMalware'"),
      malwareParams("Set-MalwareFilterPolicy", "-Identity 'BP_AntiMalware'")),
    ...ruleStep("Anti-Malware-Rule", "BP_AntiMalware_Rule", "Get-MalwareFilterRule", "New-MalwareFilterRule", "Set-MalwareFilterRule", "MalwareFilterPolicy", "BP_AntiMalware"),
    "",
    "$failed = @($steps | Where-Object { -not $_.ok })",
    "Write-Output ('BEGINJSON' + (@{ ok = $true; allSucceeded = ($failed.Count -eq 0); steps = $steps; domains = @($Domains) } | ConvertTo-Json -Compress -Depth 6) + 'ENDJSON')"
  ];
  return lines.join("\r\n");
}

/**
 * Baut den pwsh-Body fuer die Alert Policy (laeuft innerhalb der runIpps-Verbindung,
 * Security & Compliance PowerShell). -AggregationType None + -Operation macht die
 * Policy auch ohne E5-Lizenz als Single-Event-Alert anlegbar.
 */
function buildAlertPolicyBody(cfg) {
  const recipients = [cfg.adminEmail];
  if (cfg.mspEmail && cfg.mspEmail !== cfg.adminEmail) recipients.push(cfg.mspEmail);
  const notify = psArray(recipients);
  return [
    "$steps = @()",
    "try {",
    "  $alert = Get-ProtectionAlert -Identity 'BP_UserRequestReleaseStatus' -ErrorAction SilentlyContinue",
    "  if ($null -eq $alert) {",
    "    New-ProtectionAlert -Name 'BP_UserRequestReleaseStatus' `",
    "      -Category ThreatManagement `",
    "      -ThreatType Activity `",
    "      -Operation QuarantineRequestReleaseMessage `",
    "      -NotifyUser " + notify + " `",
    "      -Severity Low `",
    "      -Description 'Best Practice: User requested to release a quarantined message' `",
    "      -AggregationType None | Out-Null",
    "    $steps += @{ name = 'Alert-Policy Quarantine-Release'; ok = $true; action = 'created' }",
    "  } else {",
    "    Set-ProtectionAlert -Identity 'BP_UserRequestReleaseStatus' -NotifyUser " + notify + " | Out-Null",
    "    $steps += @{ name = 'Alert-Policy Quarantine-Release'; ok = $true; action = 'updated' }",
    "  }",
    "} catch { $steps += @{ name = 'Alert-Policy Quarantine-Release'; ok = $false; error = $_.Exception.Message } }",
    "",
    "$failed = @($steps | Where-Object { -not $_.ok })",
    "Write-Output ('BEGINJSON' + (@{ ok = $true; allSucceeded = ($failed.Count -eq 0); steps = $steps } | ConvertTo-Json -Compress -Depth 6) + 'ENDJSON')"
  ].join("\r\n");
}

module.exports = { sanitizeConfig, buildDeployBody, buildAlertPolicyBody };
