/**
 * Baut aus der Tool-Konfiguration (JSON aus dem Browser) den PowerShell-Body
 * fuer den EXO-Runner. Setzt exakt dieselben BP_-Policies wie das generierte
 * Deployment-Skript; die Alert Policy laeuft als separater IPPS-Body.
 *
 * Die Config kommt vom Client und wird hier strikt validiert/normalisiert,
 * bevor irgendetwas in PowerShell-Text interpoliert wird.
 */
const { psQuote } = require("./exorunner");

// Nicht-Mail-Domains (Teams Direct Routing / SBC / Operator-Connect / Skype)
// tragen keine Postfaecher und gehoeren nicht in Mail-Flow-Regeln
// (RecipientDomainIs). Sie tauchen aber in Get-AcceptedDomain auf und wuerden
// den Auto-Domain-Scope aufblaehen. Deploy und Audit ziehen die Domains aus
// demselben Get-AcceptedDomain — deshalb hier EIN gemeinsamer Filter, damit
// Soll (Audit) und Ist (deployte Rule) konsistent bleiben. Muster bewusst
// konservativ; bei Bedarf um weitere Carrier-/SBC-Suffixe erweitern.
const NON_MAIL_DOMAIN_PS_FILTER =
  "Where-Object { $_ -notmatch '(?i)(\\.sbc\\.|\\.teamsconn\\.net$|cloudsbv|\\.od\\.online\\.lync\\.com$)' }";

const PHISH_SPOOF_ACTIONS = ["Quarantine", "MoveToJmf"];
const DMARC_Q_ACTIONS = ["Quarantine", "MoveToJmf", "Reject", "None"];
const DMARC_R_ACTIONS = ["Reject", "Quarantine"];
const SPAM_ACTIONS = ["Quarantine", "MoveToJmf"];
const HC_PHISH_ACTIONS = ["Quarantine", "Reject", "MoveToJmf"];
const THRESHOLD_ACTIONS = ["BlockUser", "BlockUserForToday"];

// Ablehnungstext der Auto-Forward-Regel. Geht als NDR an den Absender, also
// bewusst ohne Umlaute — der Text laeuft durch pwsh-stdin und soll unterwegs
// nicht zerlegt werden.
const FORWARD_REJECT_TEXT =
  "Automatische Weiterleitung nach extern ist in dieser Organisation nicht zugelassen. " +
  "Bitte leiten Sie die Nachricht von Hand weiter oder wenden Sie sich an Ihre IT.";

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

// Weiche Varianten fuer den Abschnitt "outbound": eine vor dieser Erweiterung
// gespeicherte Tenant-Vorlage kennt die Felder nicht. Fehlt ein Wert, gilt der
// Standard — nicht ein harter Fehler, der den ganzen Deploy blockiert.
function intOr(v, def, min, max, field) {
  if (v === undefined || v === null || v === "") return def;
  return intRange(v, min, max, field);
}
function pickOr(v, allowed, def, field) {
  if (v === undefined || v === null || v === "") return def;
  return pick(v, allowed, field);
}
function boolOr(v, def) { return (v === undefined || v === null) ? def : !!v; }
function psArray(items) { return "@(" + items.map(psQuote).join(", ") + ")"; }

/** Validiert die rohe Client-Config und gibt eine normalisierte Struktur zurueck. */
function sanitizeConfig(raw) {
  if (!raw || typeof raw !== "object") throw new Error("Keine Konfiguration uebergeben.");
  const g = raw.global || {};
  const ap = raw.antiPhishing || {};
  const as = raw.antiSpam || {};
  const am = raw.antiMalware || {};
  const ob = raw.outbound || {};

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
    },
    // Ausgehend & Organisation. Zwei Schalter stehen absichtlich standardmaessig
    // auf false: Auto-Forward-Sperre und "Direct Send abweisen" koennen laufenden
    // Betrieb unterbrechen (Drucker, Scan-to-Mail, Fachanwendungen, gewollte
    // Weiterleitungen) und gehoeren erst nach einer Bestandsaufnahme im Tenant
    // gesetzt — sonst schneidet ein Deploy still Systeme ab.
    outbound: {
      notifyOutboundSpam: boolOr(ob.notifyOutboundSpam, true),
      limitExternalPerHour: intOr(ob.limitExternalPerHour, 500, 1, 10000, "limitExternalPerHour"),
      limitInternalPerHour: intOr(ob.limitInternalPerHour, 1000, 1, 10000, "limitInternalPerHour"),
      limitPerDay: intOr(ob.limitPerDay, 1000, 1, 10000, "limitPerDay"),
      // Rueckfallwerte greifen nur, wenn eine gespeicherte Vorlage das Feld gar
      // nicht kennt — also bei Vorlagen aus der Zeit vor Version 2.13. Bewusst
      // auf Best Practice gesetzt (Entscheid Nils, 01.09.2026): auch ein
      // Altkunde soll die Sperren bekommen, statt durch eine Luecke in seiner
      // alten Vorlage davon ausgenommen zu bleiben.
      // ACHTUNG beim Deploy alter Vorlagen: Direct Send schneidet Multifunktions-
      // drucker, Scan-to-Mail, Monitoring und Fachanwendungen mit eigenem
      // Mailversand ab — ohne Fehlermeldung an den Absender. Die Erhebung im
      // Konfigurations-Tab gehoert vorher gelaufen.
      thresholdAction: pickOr(ob.thresholdAction, THRESHOLD_ACTIONS, "BlockUser", "thresholdAction"),
      externalTagging: boolOr(ob.externalTagging, true),
      blockAutoForward: boolOr(ob.blockAutoForward, true),
      rejectDirectSend: boolOr(ob.rejectDirectSend, true)
    }
  };
}

// Upsert mit Retry: faengt transiente EXO-Fehler ab, die bei frischen Tenants
// real auftreten — Container-Race bei der allerersten Quarantine-Policy
// ("object already exists") und Replikationsverzoegerung, wenn eine Policy ein
// sekundenaltes Quarantine-Tag referenziert ("quarantine tag ... is not present").
// Send-BPProgress streamt den Live-Fortschritt an den Node-Runner (Marker im stdout).
const RETRY_HELPER = [
  "$steps = [System.Collections.Generic.List[object]]::new()",
  "function Send-BPProgress { param($o) Write-Output ('BPPROGRESS' + ($o | ConvertTo-Json -Compress -Depth 4) + 'ENDPROGRESS') }",
  // Fehler, bei denen Wiederholen prinzipiell nichts bringt: der Tenant ist
  // "dehydriert", d.h. die Organisationsanpassung wurde nie aktiviert. EXO
  // sperrt dann New-/Set-QuarantinePolicy & Co. mit "isn't currently allowed
  // in your organization ... first need to run Enable-OrganizationCustomization".
  // Ohne diese Erkennung laufen vier Versuche mit 60 s Wartezeit ins Leere und
  // der Anwender sieht nur eine abgeschnittene Meldung.
  "function Test-BPNeedsOrgCustomization { param([string]$Message)",
  "  return ($Message -match \"isn't currently allowed in your organization\") -or ($Message -match 'Enable-OrganizationCustomization')",
  "}",
  "function Invoke-BPStep {",
  "  param([string]$Name, [scriptblock]$Get, [scriptblock]$New, [scriptblock]$Set)",
  "  $maxTries = 4",
  "  Send-BPProgress @{ type = 'step'; name = $Name; state = 'running'; try = 1 }",
  "  for ($try = 1; $try -le $maxTries; $try++) {",
  "    try {",
  "      $existing = & $Get",
  "      $action = if ($null -eq $existing) { & $New; 'created' } else { & $Set; 'updated' }",
  "      $steps.Add(@{ name = $Name; ok = $true; action = $action; tries = $try })",
  "      Send-BPProgress @{ type = 'step'; name = $Name; state = 'done'; action = $action; tries = $try }",
  "      return",
  "    } catch {",
  "      $msg = $_.Exception.Message",
  "      if (Test-BPNeedsOrgCustomization $msg) {",
  "        $hint = 'Organisationsanpassung ist in diesem Tenant nicht aktiviert — Enable-OrganizationCustomization muss einmalig laufen (danach bis zu 4 Stunden Vorlauf).'",
  "        $steps.Add(@{ name = $Name; ok = $false; error = $msg; hint = $hint; needsOrgCustomization = $true; tries = $try })",
  "        Send-BPProgress @{ type = 'step'; name = $Name; state = 'failed'; error = $msg; hint = $hint; needsOrgCustomization = $true; tries = $try }",
  "        return",
  "      }",
  "      if ($try -eq $maxTries) {",
  "        $steps.Add(@{ name = $Name; ok = $false; error = $msg; tries = $try })",
  "        Send-BPProgress @{ type = 'step'; name = $Name; state = 'failed'; error = $msg; tries = $try }",
  "        return",
  "      }",
  "      Send-BPProgress @{ type = 'step'; name = $Name; state = 'retry'; try = ($try + 1); error = $msg }",
  "      Start-Sleep -Seconds (10 * $try)",
  "    }",
  "  }",
  "}"
].join("\r\n");

// Der geplante Ablauf — Basis fuer die Live-Anzeige im Frontend (Job-Steps
// werden damit vorbefuellt). Namen muessen zu den step()-Aufrufen passen.
const STEP_OUTBOUND = "Ausgehender Spam: Benachrichtigung & Limits";
const STEP_EXT_TAG = "Externe Absender kennzeichnen";
const STEP_AUTOFWD = "Automatische Weiterleitung nach aussen sperren";
const STEP_DIRECTSEND = "Direct Send abweisen";

const DEPLOY_PLAN = [
  { phase: "Quarantine Policies", steps: ["Quarantine-Policy SelfRelease", "Quarantine-Policy RequestRelease"] },
  { phase: "Anti-Phishing", steps: ["Anti-Phishing-Policy", "Anti-Phishing-Rule"] },
  { phase: "Anti-Spam", steps: ["Anti-Spam-Policy", "Anti-Spam-Rule"] },
  { phase: "Anti-Malware", steps: ["Anti-Malware-Policy", "Anti-Malware-Rule"] },
  { phase: "Ausgehend & Organisation", steps: [STEP_OUTBOUND, STEP_EXT_TAG, STEP_AUTOFWD, STEP_DIRECTSEND] },
  { phase: "Alert Policy (Security & Compliance)", steps: ["Alert-Policy Quarantine-Release"] }
];

/**
 * Der tatsaechliche Ablauf haengt an der Konfiguration: die drei optionalen
 * Organisationsschritte laufen nur, wenn sie angehakt sind. Ohne diese Filterung
 * stuenden sie in der Live-Anzeige dauerhaft auf "ausstehend" und der Anwender
 * wartet auf etwas, das nie kommt.
 */
function deployPlan(cfg) {
  const ob = (cfg && cfg.outbound) || {};
  return DEPLOY_PLAN.map(ph => {
    if (ph.phase !== "Ausgehend & Organisation") return ph;
    const steps = [STEP_OUTBOUND];
    if (ob.externalTagging) steps.push(STEP_EXT_TAG);
    if (ob.blockAutoForward) steps.push(STEP_AUTOFWD);
    if (ob.rejectDirectSend) steps.push(STEP_DIRECTSEND);
    return { phase: ph.phase, steps };
  });
}

function phaseMarker(label) {
  return "Send-BPProgress @{ type = 'phase'; label = " + psQuote(label) + " }";
}

// Ein Upsert-Schritt als Invoke-BPStep-Aufruf (Get -> New oder Set).
function step(name, identity, getCmd, newLines, setLines) {
  return [
    "Invoke-BPStep " + psQuote(name) + " `",
    "  { " + getCmd + " -Identity " + psQuote(identity) + " -ErrorAction SilentlyContinue } `",
    "  {",
    ...newLines.map(l => "    " + l),
    "  } `",
    "  {",
    ...setLines.map(l => "    " + l),
    "  }",
    ""
  ];
}

// Organisationsweite Einstellungen kennen kein New/Set-Paar — sie werden nur
// gesetzt. Get liefert deshalb fest $true, damit Invoke-BPStep in den Set-Zweig
// geht und Retry, Fortschritt und Fehlerbehandlung identisch greifen.
function orgStep(name, setLines) {
  return [
    "Invoke-BPStep " + psQuote(name) + " `",
    "  { $true } `",
    "  { throw 'unerreichbar' } `",
    "  {",
    ...setLines.map(l => "    " + l),
    "  }",
    ""
  ];
}

/** Baut den pwsh-Body (laeuft innerhalb der runExo-Verbindung). */
function buildDeployBody(cfg) {
  const ap = cfg.antiPhishing, as = cfg.antiSpam, am = cfg.antiMalware, ob = cfg.outbound;
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

  // 2.1.6 + 2.1.15 (+ 6.2.1 ueber AutoForwardingMode): alles an der
  // Standard-Richtlinie fuer ausgehenden Spam. Bewusst nicht als eigene BP_-Policy:
  // Pruefwerkzeuge (CIS, Maester) lesen genau diese Default-Richtlinie, und ohne
  // Rule-Scope gilt sie fuer alle Absender des Tenants.
  const notifyRecipients = [cfg.adminEmail];
  if (cfg.mspEmail && cfg.mspEmail !== cfg.adminEmail) notifyRecipients.push(cfg.mspEmail);

  const outboundLines = [
    "Set-HostedOutboundSpamFilterPolicy -Identity Default `",
    "  -NotifyOutboundSpam " + bool(ob.notifyOutboundSpam) + " `",
    ...(ob.notifyOutboundSpam ? ["  -NotifyOutboundSpamRecipients " + psArray(notifyRecipients) + " `"] : []),
    "  -RecipientLimitExternalPerHour " + ob.limitExternalPerHour + " `",
    "  -RecipientLimitInternalPerHour " + ob.limitInternalPerHour + " `",
    "  -RecipientLimitPerDay " + ob.limitPerDay + " `",
    ...(ob.blockAutoForward ? ["  -AutoForwardingMode Off `"] : []),
    "  -ActionWhenThresholdReached " + ob.thresholdAction + " | Out-Null"
  ];

  const fwRuleParams = (cmdlet, nameArg) => [
    cmdlet + " " + nameArg + " `",
    "  -FromScope InOrganization `",
    "  -SentToScope NotInOrganization `",
    "  -MessageTypeMatches AutoForward `",
    "  -RejectMessageEnhancedStatusCode '5.7.1' `",
    "  -RejectMessageReasonText " + psQuote(FORWARD_REJECT_TEXT) + " `",
    "  -SetAuditSeverity High `",
    "  -Mode Enforce | Out-Null"
  ];

  const ruleStep = (name, identity, getCmd, newCmd, setCmd, policyParam, policyName) => step(
    name, identity, getCmd,
    [newCmd + " -Name " + psQuote(identity) + " -" + policyParam + " " + psQuote(policyName) + " -RecipientDomainIs $Domains -Priority 0 | Out-Null"],
    [setCmd + " -Identity " + psQuote(identity) + " -RecipientDomainIs $Domains | Out-Null"]
  );

  const lines = [
    RETRY_HELPER,
    "try {",
    "  $Domains = " + (cfg.domains.length ? psArray(cfg.domains) : "@(Get-AcceptedDomain | ForEach-Object DomainName | " + NON_MAIL_DOMAIN_PS_FILTER + ")"),
    "} catch { Write-Output ('BEGINJSON' + (@{ ok = $false; error = 'Domains nicht ermittelbar: ' + $_.Exception.Message } | ConvertTo-Json -Compress) + 'ENDJSON'); exit 0 }",
    "",
    "# Dehydrierter Tenant: ohne Enable-OrganizationCustomization sperrt EXO alle",
    "# New-/Set-Cmdlets fuer eigene Policies. Vorab pruefen statt jeden der zehn",
    "# Schritte einzeln auflaufen zu lassen.",
    "try {",
    "  if ((Get-OrganizationConfig -ErrorAction Stop).IsDehydrated) {",
    "    Write-Output ('BEGINJSON' + (@{ ok = $false; needsOrgCustomization = $true; error = 'Die Organisationsanpassung ist in diesem Tenant nicht aktiviert (IsDehydrated). Exchange Online sperrt damit alle eigenen Policies. Einmalig Enable-OrganizationCustomization ausfuehren — die Freischaltung kann bis zu 4 Stunden dauern, danach Deploy erneut starten.' } | ConvertTo-Json -Compress) + 'ENDJSON'); exit 0",
    "  }",
    "} catch { }",
    "$fileTypes = " + psArray(am.fileTypes),
    "",
    "# --- Quarantine Policies (59 = AllowSender+BlockSender+RequestRelease+Preview+Delete / 26 = BlockSender+RequestRelease+Preview) ---",
    phaseMarker("Quarantine Policies"),
    ...step("Quarantine-Policy SelfRelease", "BP_Quarantine-SelfReleaseNotification", "Get-QuarantinePolicy",
      ["New-QuarantinePolicy -Name 'BP_Quarantine-SelfReleaseNotification' -EndUserQuarantinePermissionsValue 59 -ESNEnabled $true -IncludeMessagesFromBlockedSenderAddress $true | Out-Null"],
      ["Set-QuarantinePolicy -Identity 'BP_Quarantine-SelfReleaseNotification' -EndUserQuarantinePermissionsValue 59 -ESNEnabled $true -IncludeMessagesFromBlockedSenderAddress $true | Out-Null"]),
    ...step("Quarantine-Policy RequestRelease", "BP_Quarantine-RequestReleaseNotification", "Get-QuarantinePolicy",
      ["New-QuarantinePolicy -Name 'BP_Quarantine-RequestReleaseNotification' -EndUserQuarantinePermissionsValue 26 -ESNEnabled $true -IncludeMessagesFromBlockedSenderAddress $false | Out-Null"],
      ["Set-QuarantinePolicy -Identity 'BP_Quarantine-RequestReleaseNotification' -EndUserQuarantinePermissionsValue 26 -ESNEnabled $true -IncludeMessagesFromBlockedSenderAddress $false | Out-Null"]),
    "",
    "# --- Anti-Phishing ---",
    phaseMarker("Anti-Phishing"),
    ...step("Anti-Phishing-Policy", "BP_AntiPhishing", "Get-AntiPhishPolicy",
      phishParams("New-AntiPhishPolicy", "-Name 'BP_AntiPhishing'"),
      phishParams("Set-AntiPhishPolicy", "-Identity 'BP_AntiPhishing'")),
    ...ruleStep("Anti-Phishing-Rule", "BP_AntiPhishing_Rule", "Get-AntiPhishRule", "New-AntiPhishRule", "Set-AntiPhishRule", "AntiPhishPolicy", "BP_AntiPhishing"),
    "",
    "# --- Anti-Spam ---",
    phaseMarker("Anti-Spam"),
    ...step("Anti-Spam-Policy", "BP_AntiSpam_Inbound", "Get-HostedContentFilterPolicy",
      spamParams("New-HostedContentFilterPolicy", "-Name 'BP_AntiSpam_Inbound' -EnableEndUserSpamNotifications $true -EndUserSpamNotificationFrequency 1"),
      spamParams("Set-HostedContentFilterPolicy", "-Identity 'BP_AntiSpam_Inbound'")),
    ...ruleStep("Anti-Spam-Rule", "BP_AntiSpam_Inbound_Rule", "Get-HostedContentFilterRule", "New-HostedContentFilterRule", "Set-HostedContentFilterRule", "HostedContentFilterPolicy", "BP_AntiSpam_Inbound"),
    "",
    "# --- Anti-Malware ---",
    phaseMarker("Anti-Malware"),
    ...step("Anti-Malware-Policy", "BP_AntiMalware", "Get-MalwareFilterPolicy",
      malwareParams("New-MalwareFilterPolicy", "-Name 'BP_AntiMalware'"),
      malwareParams("Set-MalwareFilterPolicy", "-Identity 'BP_AntiMalware'")),
    ...ruleStep("Anti-Malware-Rule", "BP_AntiMalware_Rule", "Get-MalwareFilterRule", "New-MalwareFilterRule", "Set-MalwareFilterRule", "MalwareFilterPolicy", "BP_AntiMalware"),
    "",
    "# --- Ausgehend & Organisation ---",
    phaseMarker("Ausgehend & Organisation"),
    ...orgStep(STEP_OUTBOUND, outboundLines),
    ...(ob.externalTagging ? orgStep(STEP_EXT_TAG, [
      "Set-ExternalInOutlook -Enabled $true | Out-Null"
    ]) : []),
    ...(ob.blockAutoForward ? orgStep(STEP_AUTOFWD, [
      "$fwRule = Get-TransportRule -Identity 'BP_Block-AutoForwarding' -ErrorAction SilentlyContinue",
      "if ($null -eq $fwRule) {",
      ...fwRuleParams("  New-TransportRule", "-Name 'BP_Block-AutoForwarding'"),
      "} else {",
      ...fwRuleParams("  Set-TransportRule", "-Identity 'BP_Block-AutoForwarding'"),
      "  Enable-TransportRule -Identity 'BP_Block-AutoForwarding' -Confirm:$false -ErrorAction SilentlyContinue | Out-Null",
      "}"
    ]) : []),
    ...(ob.rejectDirectSend ? orgStep(STEP_DIRECTSEND, [
      // Aeltere Tenants kennen den Parameter noch nicht. Ohne diese Pruefung
      // laeuft der Schritt in einen unverstaendlichen Bindungsfehler.
      "if ((Get-Command Set-OrganizationConfig).Parameters.Keys -contains 'RejectDirectSend') {",
      "  Set-OrganizationConfig -RejectDirectSend $true | Out-Null",
      "} else {",
      "  throw 'Dieser Tenant kennt den Parameter RejectDirectSend nicht.'",
      "}"
    ]) : []),
    "",
    "$failed = @($steps | Where-Object { -not $_.ok })",
    "Write-Output ('BEGINJSON' + (@{ ok = $true; allSucceeded = ($failed.Count -eq 0); steps = @($steps); domains = @($Domains) } | ConvertTo-Json -Compress -Depth 6) + 'ENDJSON')"
  ];
  return lines.join("\r\n");
}

/**
 * Fertiges PowerShell-Snippet fuer die Alert Policy — als MANUELLER Schritt.
 * Grund: Security & Compliance PowerShell (Connect-IPPSSession) ist laut
 * Microsoft-Doku auf Linux nicht verfuegbar; der Backend-Container kann den
 * Schritt daher nicht ausfuehren. Einmalig pro Tenant auf Windows ausfuehren.
 * -AggregationType None + -Operation macht die Policy auch ohne E5 anlegbar.
 */
function buildAlertPolicySnippet(cfg) {
  const recipients = [cfg.adminEmail];
  if (cfg.mspEmail && cfg.mspEmail !== cfg.adminEmail) recipients.push(cfg.mspEmail);
  const notify = psArray(recipients);
  return [
    "# Alert Policy fuer Quarantine-Release-Anfragen — einmalig pro Tenant",
    "# auf einem WINDOWS-Rechner ausfuehren (S&C PowerShell gibt es nicht auf Linux).",
    "if (-not (Get-Module -ListAvailable -Name ExchangeOnlineManagement)) {",
    "    Write-Host 'ExchangeOnlineManagement-Modul fehlt — installiere es einmalig …' -ForegroundColor Yellow",
    "    Install-Module ExchangeOnlineManagement -Scope CurrentUser -Force -AllowClobber",
    "}",
    "Import-Module ExchangeOnlineManagement",
    "Connect-IPPSSession",
    "$alert = Get-ProtectionAlert -Identity 'BP_UserRequestReleaseStatus' -ErrorAction SilentlyContinue",
    "if ($null -eq $alert) {",
    "    New-ProtectionAlert -Name 'BP_UserRequestReleaseStatus' `",
    "        -Category ThreatManagement `",
    "        -ThreatType Activity `",
    "        -Operation QuarantineRequestReleaseMessage `",
    "        -NotifyUser " + notify + " `",
    "        -Severity Low `",
    "        -Description 'Best Practice: User requested to release a quarantined message' `",
    "        -AggregationType None",
    "} else {",
    "    Set-ProtectionAlert -Identity 'BP_UserRequestReleaseStatus' -NotifyUser " + notify,
    "}",
    "",
    "# CIS 2.1.6: Microsoft hat NotifyOutboundSpam abgekuendigt — die Meldung ueber ein",
    "# auffaellig sendendes Konto laeuft kuenftig ueber diese eingebaute Warnungsrichtlinie.",
    "# Bestehende Empfaenger bleiben erhalten, die eigenen kommen dazu.",
    "$restricted = Get-ProtectionAlert -Identity 'User restricted from sending email' -ErrorAction SilentlyContinue",
    "if ($null -eq $restricted) {",
    "    Write-Host 'Warnungsrichtlinie \"User restricted from sending email\" nicht gefunden — im Defender-Portal pruefen.' -ForegroundColor Yellow",
    // Am 02.09.2026 im Kundentenant nachgemessen: Diese Richtlinie ist
    // IsSystemRule = True. Set-ProtectionAlert lehnt sie ab — mit dem
    // Anzeigenamen, mit dem vollen DN und mit der Identity aus dem Objekt.
    // Exchange baut die Identity intern zu "<tenantguid>\\<name>" um und
    // findet sie dann selbst nicht. Es gibt keine Cmdlet-Variante, die
    // funktioniert; deshalb wird es gar nicht erst versucht.
    // Wichtig ausserdem: das EXO-REST-Modul meldet solche Fehler NICHT
    // terminierend (Write-ErrorMessage), try/catch greift also nicht — eine
    // Erfolgsmeldung nach dem Aufruf waere schlicht gelogen.
    "} elseif ($restricted.IsSystemRule) {",
    "    Write-Host 'Die Richtlinie \"User restricted from sending email\" ist eingebaut und systemverwaltet (IsSystemRule = True).' -ForegroundColor Cyan",
    "    Write-Host \"Sie ist aktiv und benachrichtigt: $($restricted.NotifyUser -join ', ')\" -ForegroundColor Cyan",
    "    Write-Host 'Damit ist die Anforderung erfuellt. Zusaetzliche Empfaenger lassen sich per PowerShell NICHT setzen —' -ForegroundColor Cyan",
    "    Write-Host 'falls gewuenscht: Defender-Portal > Richtlinien und Regeln > Warnungsrichtlinie > Richtlinie oeffnen.' -ForegroundColor Cyan",
    "} else {",
    "    $empf = @($restricted.NotifyUser) + " + notify + " | Where-Object { $_ } | Sort-Object -Unique",
    "    try {",
    "        Set-ProtectionAlert -Identity $restricted.Identity -NotifyUser $empf -NotificationEnabled $true -Confirm:$false -ErrorAction Stop",
    "        Write-Host \"Empfaenger gesetzt: $($empf -join ', ')\" -ForegroundColor Green",
    "    } catch {",
    "        Write-Host \"Konnte die Warnungsrichtlinie nicht aendern: $($_.Exception.Message)\" -ForegroundColor Yellow",
    "        Write-Host 'Dann im Defender-Portal unter Richtlinien und Regeln > Warnungsrichtlinie ergaenzen.' -ForegroundColor Yellow",
    "    }",
    "}",
    "Disconnect-ExchangeOnline -Confirm:$false"
  ].join("\r\n");
}

/**
 * Ist-Zustand-Audit: liest alle BP_-relevanten Objekte aus dem Tenant und gibt
 * sie strukturiert zurueck. Der Soll/Ist-Vergleich passiert im Frontend
 * (dort liegt die aktuelle Tool-Konfiguration).
 */
function buildAuditBody() {
  return [
    "function Get-Safe([scriptblock]$sb) { try { & $sb } catch { $null } }",
    "$audit = [ordered]@{",
    "  acceptedDomains  = @(Get-Safe { Get-AcceptedDomain | ForEach-Object DomainName | " + NON_MAIL_DOMAIN_PS_FILTER + " })",
    "  quarantineSelf   = Get-Safe { Get-QuarantinePolicy -Identity 'BP_Quarantine-SelfReleaseNotification' -ErrorAction SilentlyContinue | Select-Object Name, ESNEnabled, IncludeMessagesFromBlockedSenderAddress, @{ n = 'Permissions'; e = { '' + $_.EndUserQuarantinePermissions } } }",
    "  quarantineRequest = Get-Safe { Get-QuarantinePolicy -Identity 'BP_Quarantine-RequestReleaseNotification' -ErrorAction SilentlyContinue | Select-Object Name, ESNEnabled, IncludeMessagesFromBlockedSenderAddress, @{ n = 'Permissions'; e = { '' + $_.EndUserQuarantinePermissions } } }",
    "  antiPhish        = Get-Safe { Get-AntiPhishPolicy -Identity 'BP_AntiPhishing' -ErrorAction SilentlyContinue | Select-Object Name, Enabled, EnableSpoofIntelligence, EnableFirstContactSafetyTips, EnableUnauthenticatedSender, EnableViaTag, HonorDmarcPolicy, DmarcQuarantineAction, DmarcRejectAction, AuthenticationFailAction, SpoofQuarantineTag }",
    "  antiPhishRule    = Get-Safe { Get-AntiPhishRule -Identity 'BP_AntiPhishing_Rule' -ErrorAction SilentlyContinue | Select-Object Name, State, Priority, RecipientDomainIs }",
    "  antiSpam         = Get-Safe { Get-HostedContentFilterPolicy -Identity 'BP_AntiSpam_Inbound' -ErrorAction SilentlyContinue | Select-Object Name, BulkThreshold, SpamAction, HighConfidenceSpamAction, BulkSpamAction, PhishSpamAction, HighConfidencePhishAction, QuarantineRetentionPeriod, SpamQuarantineTag, HighConfidenceSpamQuarantineTag, BulkQuarantineTag, PhishQuarantineTag, HighConfidencePhishQuarantineTag, IncreaseScoreWithBizOrInfoUrls, IncreaseScoreWithNumericIps, IncreaseScoreWithRedirectToOtherPort, MarkAsSpamEmptyMessages, MarkAsSpamJavaScriptInHtml, MarkAsSpamFramesInHtml, MarkAsSpamSensitiveWordList, MarkAsSpamSpfRecordHardFail, MarkAsSpamFromAddressAuthFail }",
    "  antiSpamRule     = Get-Safe { Get-HostedContentFilterRule -Identity 'BP_AntiSpam_Inbound_Rule' -ErrorAction SilentlyContinue | Select-Object Name, State, Priority, RecipientDomainIs }",
    "  malware          = Get-Safe { Get-MalwareFilterPolicy -Identity 'BP_AntiMalware' -ErrorAction SilentlyContinue | Select-Object Name, EnableFileFilter, FileTypes, ZapEnabled, QuarantineTag, InternalSenderAdminAddress, ExternalSenderAdminAddress, EnableInternalSenderAdminNotifications, EnableExternalSenderAdminNotifications }",
    "  malwareRule      = Get-Safe { Get-MalwareFilterRule -Identity 'BP_AntiMalware_Rule' -ErrorAction SilentlyContinue | Select-Object Name, State, Priority, RecipientDomainIs }",
    "  outboundSpam     = Get-Safe { Get-HostedOutboundSpamFilterPolicy -Identity Default | Select-Object Name, NotifyOutboundSpam, NotifyOutboundSpamRecipients, RecipientLimitExternalPerHour, RecipientLimitInternalPerHour, RecipientLimitPerDay, ActionWhenThresholdReached, AutoForwardingMode }",
    "  externalTagging  = Get-Safe { Get-ExternalInOutlook | Select-Object -First 1 | Select-Object Enabled, AllowList }",
    "  orgConfig        = Get-Safe { Get-OrganizationConfig | Select-Object Name, RejectDirectSend }",
    "  autoForwardRule  = Get-Safe { Get-TransportRule -Identity 'BP_Block-AutoForwarding' -ErrorAction SilentlyContinue | Select-Object Name, State, Mode, FromScope, SentToScope, MessageTypeMatches }",
    "}",
    "Write-Output ('BEGINJSON' + (@{ ok = $true; audit = $audit } | ConvertTo-Json -Compress -Depth 8) + 'ENDJSON')"
  ].join("\r\n");
}

module.exports = { sanitizeConfig, buildDeployBody, buildAlertPolicySnippet, buildAuditBody, DEPLOY_PLAN, deployPlan, NON_MAIL_DOMAIN_PS_FILTER };
