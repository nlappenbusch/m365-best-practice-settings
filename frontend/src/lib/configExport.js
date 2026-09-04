// Verbatim aus dem Vanilla-app.js portiert. Reine Generatoren, die den
// Config-State lesen - hier ueber eine Factory, die ueber `config` schliesst,
// damit die Funktionsruempfe 1:1 unveraendert bleiben.
/* eslint-disable */
export function makeExporters(config) {
function generateDomainList() {
    const allDomains = [...config.global.domains, config.global.onmicrosoftDomain];
    return allDomains.map(d => `"${d}"`).join(',');
}

function generateDocumentationHeader() {
    return `<#
.SYNOPSIS
    M365 Security Best Practice Deployment

.DESCRIPTION
    Dieses Script implementiert die Best-Practice Konfiguration für:
    - Anti-Phishing Policy
    - Anti-Spam Inbound Policy
    - Anti-Malware Policy
    - Safe Links / Safe Attachments (Defender for Office 365 P1/P2, falls lizenziert)
    - Quarantine Policies
    - Ausgehender Spam, Kennzeichnung externer Absender, Organisationseinstellungen

.NOTES
    Domains: ${config.global.domains.join(', ')}, ${config.global.onmicrosoftDomain}
    Admin Email: ${config.global.adminEmail}
    Generated: ${new Date().toISOString()}
    
.LINK
    https://docs.microsoft.com/en-us/microsoft-365/security/office-365-security/
#>

`;
}

// Helper function to generate domain list for PowerShell

// Ausgehend & Organisation (CIS 2.1.6, 2.1.15, 6.2.1, 6.2.3, 6.5.5).
// Bewusst als Array einfacher Strings statt im Template-Literal: PowerShell
// nutzt Backtick und $ — beides ist im Template ein Minenfeld.
function generateOutboundSection() {
    const ob = config.outbound || {};
    const q = (s) => '"' + String(s == null ? '' : s).replace(/"/g, '') + '"';
    const empf = [config.global.adminEmail, config.global.igeeksEmail].filter(Boolean);
    const L = [];
    L.push('# ============================================');
    L.push('# 6. AUSGEHEND & ORGANISATION');
    L.push('# ============================================');
    L.push('Write-Host "Configuring outbound spam and organisation settings..." -ForegroundColor Yellow');
    L.push('');
    L.push('# CIS 2.1.6 / 2.1.15 - Standard-Richtlinie fuer ausgehenden Spam.');
    L.push('# Bewusst die Default-Policy: sie gilt fuer alle Absender, und die');
    L.push('# Pruefwerkzeuge (CIS, Maester) lesen genau diese.');
    L.push('try {');
    L.push('    Set-HostedOutboundSpamFilterPolicy -Identity Default `');
    L.push('        -NotifyOutboundSpam ' + (ob.notifyOutboundSpam === false ? '$false' : '$true') + ' `');
    if (ob.notifyOutboundSpam !== false && empf.length) {
        L.push('        -NotifyOutboundSpamRecipients ' + empf.map(q).join(',') + ' `');
    }
    L.push('        -RecipientLimitExternalPerHour ' + (ob.limitExternalPerHour ?? 500) + ' `');
    L.push('        -RecipientLimitInternalPerHour ' + (ob.limitInternalPerHour ?? 1000) + ' `');
    L.push('        -RecipientLimitPerDay ' + (ob.limitPerDay ?? 1000) + ' `');
    if (ob.blockAutoForward) L.push('        -AutoForwardingMode Off `');
    L.push('        -ActionWhenThresholdReached ' + (ob.thresholdAction || 'BlockUserForToday'));
    L.push('    Write-Host "OK - outbound spam policy configured" -ForegroundColor Green');
    L.push('} catch {');
    L.push('    Write-Host "FEHLER - outbound spam policy: $_" -ForegroundColor Red');
    L.push('}');
    L.push('');
    if (ob.externalTagging) {
        L.push('# CIS 6.2.3 - Kennzeichnung externer Absender in Outlook.');
        L.push('# Wirkt beim Anwender mit bis zu 48 Stunden Verzoegerung.');
        L.push('try {');
        L.push('    Set-ExternalInOutlook -Enabled $true');
        L.push('    Write-Host "OK - external sender tagging enabled" -ForegroundColor Green');
        L.push('} catch {');
        L.push('    Write-Host "FEHLER - external sender tagging: $_" -ForegroundColor Red');
        L.push('}');
    } else {
        L.push('# CIS 6.2.3 Kennzeichnung externer Absender: in der Vorlage nicht aktiviert.');
    }
    L.push('');
    if (ob.blockAutoForward) {
        L.push('# CIS 6.2.1 - Automatische Weiterleitung nach aussen ablehnen.');
        L.push('# ACHTUNG: bestehende gewollte Weiterleitungen brechen. Vorher erheben:');
        L.push('#   Get-Mailbox -ResultSize Unlimited | Where-Object { $_.ForwardingSmtpAddress -or $_.ForwardingAddress }');
        L.push('try {');
        L.push('    $fwRule = Get-TransportRule -Identity "BP_Block-AutoForwarding" -ErrorAction SilentlyContinue');
        L.push('    if ($null -eq $fwRule) {');
        L.push('        New-TransportRule -Name "BP_Block-AutoForwarding" `');
        L.push('            -FromScope InOrganization `');
        L.push('            -SentToScope NotInOrganization `');
        L.push('            -MessageTypeMatches AutoForward `');
        L.push('            -RejectMessageEnhancedStatusCode "5.7.1" `');
        L.push('            -RejectMessageReasonText "Automatische Weiterleitung nach extern ist in dieser Organisation nicht zugelassen. Bitte leiten Sie die Nachricht von Hand weiter oder wenden Sie sich an Ihre IT." `');
        L.push('            -SetAuditSeverity High `');
        L.push('            -Mode Enforce');
        L.push('    } else {');
        L.push('        Enable-TransportRule -Identity "BP_Block-AutoForwarding" -Confirm:$false -ErrorAction SilentlyContinue');
        L.push('    }');
        L.push('    Write-Host "OK - BP_Block-AutoForwarding aktiv" -ForegroundColor Green');
        L.push('} catch {');
        L.push('    Write-Host "FEHLER - BP_Block-AutoForwarding: $_" -ForegroundColor Red');
        L.push('}');
    } else {
        L.push('# CIS 6.2.1 Auto-Forward-Sperre: in der Vorlage nicht aktiviert.');
    }
    L.push('');
    if (ob.rejectDirectSend) {
        L.push('# CIS 6.5.5 - Direct Send abweisen.');
        L.push('# ACHTUNG: schneidet Drucker, Scan-to-Mail und Fachanwendungen ohne');
        L.push('# Fehlermeldung ab. Vorher den Mailverkehr ueber mindestens einen');
        L.push('# Monatswechsel auswerten (Lohn-/Fakturierungslaeufe):');
        L.push('#   Get-MessageTraceV2 -StartDate (Get-Date).AddDays(-10) -EndDate (Get-Date)');
        L.push('try {');
        L.push('    Set-OrganizationConfig -RejectDirectSend $true');
        L.push('    Write-Host "OK - RejectDirectSend gesetzt" -ForegroundColor Green');
        L.push('} catch {');
        L.push('    Write-Host "FEHLER - RejectDirectSend: $_" -ForegroundColor Red');
        L.push('}');
    } else {
        L.push('# CIS 6.5.5 Direct Send abweisen: in der Vorlage nicht aktiviert.');
    }
    L.push('');
    L.push('# CIS 2.1.6 - Microsoft hat NotifyOutboundSpam abgekuendigt. Der Weg, der');
    L.push('# bleibt, ist die eingebaute Warnungsrichtlinie (Security & Compliance).');
    L.push('try {');
    L.push('    $restricted = Get-ProtectionAlert -Identity "User restricted from sending email" -ErrorAction SilentlyContinue');
    L.push('    if ($null -eq $restricted) {');
    L.push('        Write-Host "HINWEIS - Warnungsrichtlinie nicht gefunden" -ForegroundColor Yellow');
    L.push('    } else {');
    L.push('        $empf = @($restricted.NotifyUser) + @(' + empf.map(q).join(',') + ') | Where-Object { $_ } | Sort-Object -Unique');
    L.push('        Set-ProtectionAlert -Identity "User restricted from sending email" -NotifyUser $empf -NotificationEnabled $true -Confirm:$false');
    L.push('        Write-Host "OK - Warnungsrichtlinie aktualisiert" -ForegroundColor Green');
    L.push('    }');
    L.push('} catch {');
    L.push('    Write-Host "FEHLER - Warnungsrichtlinie: $_" -ForegroundColor Red');
    L.push('}');
    return L.join('\n');
}

// Safe Links / Safe Attachments (Defender for Office 365 P1/P2) — lizenzabhaengig,
// deshalb eigener enabled-Schalter statt harter Vorgabe wie bei den drei
// Bereichen davor. Gleiches Array-Push-Muster wie generateOutboundSection().
function generateSafeLinksSection() {
    const sl = config.safeLinks || {};
    const sa = config.safeAttach || {};
    const domainList = generateDomainList();
    const L = [];
    L.push('# ============================================');
    L.push('# 5. SAFE LINKS & SAFE ATTACHMENTS');
    L.push('# ============================================');
    if (sl.enabled === false) {
        L.push('Write-Host "Safe Links / Safe Attachments: in der Vorlage deaktiviert, uebersprungen." -ForegroundColor Yellow');
        return L.join('\n');
    }
    L.push('Write-Host "Configuring Safe Links / Safe Attachments (Defender for Office 365)..." -ForegroundColor Yellow');
    L.push('Write-Host "Braucht Plan 1 (u.a. Business Premium) oder Plan 2 (u.a. E5) - ohne Lizenz schlagen die naechsten Schritte fehl." -ForegroundColor Cyan');
    L.push('');
    L.push('# Organisationsweite Freischaltung - ohne sie greift keine SafeLinksPolicy,');
    L.push('# unabhaengig davon wie sie konfiguriert ist.');
    L.push('try {');
    L.push('    Set-AtpPolicyForO365 `');
    L.push('        -EnableSafeLinksForEmail $true `');
    L.push('        -EnableSafeLinksForTeams $true `');
    L.push('        -EnableSafeLinksForOffice $true `');
    L.push('        -EnableATPForSPOTeamsODB $true `');
    L.push('        -TrackClicks $true `');
    L.push('        -AllowClickThrough $' + (sl.allowClickThrough ? 'true' : 'false'));
    L.push('    Write-Host "OK - organisationsweite Safe-Links-Schalter gesetzt" -ForegroundColor Green');
    L.push('} catch {');
    L.push('    Write-Host "FEHLER - Safe-Links-Org-Schalter (fehlt die Lizenz?): $_" -ForegroundColor Red');
    L.push('}');
    L.push('');
    L.push('try {');
    L.push('    $slp = Get-SafeLinksPolicy -Identity "BP_SafeLinks" -ErrorAction SilentlyContinue');
    L.push('    if ($null -eq $slp) {');
    L.push('        New-SafeLinksPolicy -Name "BP_SafeLinks" `');
    L.push('            -IsEnabled $true `');
    L.push('            -ScanUrls $true `');
    L.push('            -EnableForInternalSenders $' + (sl.enableForInternalSenders !== false ? 'true' : 'false') + ' `');
    L.push('            -DeliverMessageAfterScan $true `');
    L.push('            -TrackClicks $true `');
    L.push('            -AllowClickThrough $' + (sl.allowClickThrough ? 'true' : 'false'));
    L.push('        Write-Host "OK - BP_SafeLinks angelegt" -ForegroundColor Green');
    L.push('    } else {');
    L.push('        Set-SafeLinksPolicy -Identity "BP_SafeLinks" `');
    L.push('            -IsEnabled $true `');
    L.push('            -ScanUrls $true `');
    L.push('            -EnableForInternalSenders $' + (sl.enableForInternalSenders !== false ? 'true' : 'false') + ' `');
    L.push('            -DeliverMessageAfterScan $true `');
    L.push('            -TrackClicks $true `');
    L.push('            -AllowClickThrough $' + (sl.allowClickThrough ? 'true' : 'false'));
    L.push('        Write-Host "OK - BP_SafeLinks aktualisiert" -ForegroundColor Green');
    L.push('    }');
    L.push('} catch {');
    L.push('    Write-Host "FEHLER - BP_SafeLinks: $_" -ForegroundColor Red');
    L.push('}');
    L.push('');
    L.push('try {');
    L.push('    $slr = Get-SafeLinksRule -Identity "BP_SafeLinks_Rule" -ErrorAction SilentlyContinue');
    L.push('    if ($null -eq $slr) {');
    L.push('        New-SafeLinksRule -Name "BP_SafeLinks_Rule" `');
    L.push('            -SafeLinksPolicy "BP_SafeLinks" `');
    L.push('            -RecipientDomainIs ' + domainList + ' `');
    L.push('            -Priority 0');
    L.push('        Write-Host "OK - BP_SafeLinks_Rule angelegt" -ForegroundColor Green');
    L.push('    } else {');
    L.push('        Write-Host "Hinweis - BP_SafeLinks_Rule existiert bereits, uebersprungen" -ForegroundColor Yellow');
    L.push('    }');
    L.push('} catch {');
    L.push('    Write-Host "FEHLER - BP_SafeLinks_Rule: $_" -ForegroundColor Red');
    L.push('}');
    L.push('');
    L.push('try {');
    L.push('    $sap = Get-SafeAttachmentPolicy -Identity "BP_SafeAttachments" -ErrorAction SilentlyContinue');
    L.push('    if ($null -eq $sap) {');
    L.push('        New-SafeAttachmentPolicy -Name "BP_SafeAttachments" `');
    L.push('            -Enable $true `');
    L.push('            -Action ' + (sa.action || 'Block') + ' `');
    L.push('            -ActionOnError $true `');
    L.push('            -QuarantineTag "BP_Quarantine-RequestReleaseNotification"');
    L.push('        Write-Host "OK - BP_SafeAttachments angelegt" -ForegroundColor Green');
    L.push('    } else {');
    L.push('        Set-SafeAttachmentPolicy -Identity "BP_SafeAttachments" `');
    L.push('            -Enable $true `');
    L.push('            -Action ' + (sa.action || 'Block') + ' `');
    L.push('            -ActionOnError $true `');
    L.push('            -QuarantineTag "BP_Quarantine-RequestReleaseNotification"');
    L.push('        Write-Host "OK - BP_SafeAttachments aktualisiert" -ForegroundColor Green');
    L.push('    }');
    L.push('} catch {');
    L.push('    Write-Host "FEHLER - BP_SafeAttachments: $_" -ForegroundColor Red');
    L.push('}');
    L.push('');
    L.push('try {');
    L.push('    $sar = Get-SafeAttachmentRule -Identity "BP_SafeAttachments_Rule" -ErrorAction SilentlyContinue');
    L.push('    if ($null -eq $sar) {');
    L.push('        New-SafeAttachmentRule -Name "BP_SafeAttachments_Rule" `');
    L.push('            -SafeAttachmentPolicy "BP_SafeAttachments" `');
    L.push('            -RecipientDomainIs ' + domainList + ' `');
    L.push('            -Priority 0');
    L.push('        Write-Host "OK - BP_SafeAttachments_Rule angelegt" -ForegroundColor Green');
    L.push('    } else {');
    L.push('        Write-Host "Hinweis - BP_SafeAttachments_Rule existiert bereits, uebersprungen" -ForegroundColor Yellow');
    L.push('    }');
    L.push('} catch {');
    L.push('    Write-Host "FEHLER - BP_SafeAttachments_Rule: $_" -ForegroundColor Red');
    L.push('}');
    return L.join('\n');
}

function generateDeploymentScript() {
    // M365 erwartet FileTypes OHNE führenden Punkt (die GUI ergänzt ihn selbst) -
    // sonst landet ".exe" als "..exe" im Tenant
    const fileTypesArray = config.antiMalware.customFileTypes
        .split(',')
        .map(t => t.trim().replace(/^\.+/, ''))
        .filter(t => t.length > 0)
        .map(t => `'${t}'`)
        .join(', ');
    const domainList = generateDomainList();

    return `# ============================================
# DEPLOYMENT SCRIPT
# ============================================

# Connect to Exchange Online
Write-Host "Connecting to Exchange Online..." -ForegroundColor Cyan
Connect-ExchangeOnline

# ⚠️ IMPORTANT: Alert Policy requires Security & Compliance PowerShell
Write-Host "Connecting to Security & Compliance PowerShell..." -ForegroundColor Cyan
Connect-IPPSSession

# ============================================
# 1. QUARANTINE POLICIES
# ============================================
Write-Host "Creating Quarantine Policies..." -ForegroundColor Yellow

# Self-Release Notification Policy
# Permissions 59 = AllowSender(32) + BlockSender(16) + RequestRelease(8) + Preview(2) + Delete(1)
# Notification inkl. Nachrichten von blockierten Absendern
try {
    $qp1 = Get-QuarantinePolicy -Identity "BP_Quarantine-SelfReleaseNotification" -ErrorAction SilentlyContinue
    if ($null -eq $qp1) {
        New-QuarantinePolicy -Name "BP_Quarantine-SelfReleaseNotification" \`
            -EndUserQuarantinePermissionsValue 59 \`
            -ESNEnabled $true \`
            -IncludeMessagesFromBlockedSenderAddress $true
        Write-Host "✓ Created BP_Quarantine-SelfReleaseNotification" -ForegroundColor Green
    } else {
        Set-QuarantinePolicy -Identity "BP_Quarantine-SelfReleaseNotification" \`
            -EndUserQuarantinePermissionsValue 59 \`
            -ESNEnabled $true \`
            -IncludeMessagesFromBlockedSenderAddress $true
        Write-Host "✓ Updated BP_Quarantine-SelfReleaseNotification" -ForegroundColor Green
    }
} catch {
    Write-Host "❌ Error creating BP_Quarantine-SelfReleaseNotification: $_" -ForegroundColor Red
}

# Request-Release Notification Policy
# Permissions 26 = BlockSender(16) + RequestRelease(8) + Preview(2)
# Notification OHNE Nachrichten von blockierten Absendern
try {
    $qp2 = Get-QuarantinePolicy -Identity "BP_Quarantine-RequestReleaseNotification" -ErrorAction SilentlyContinue
    if ($null -eq $qp2) {
        New-QuarantinePolicy -Name "BP_Quarantine-RequestReleaseNotification" \`
            -EndUserQuarantinePermissionsValue 26 \`
            -ESNEnabled $true \`
            -IncludeMessagesFromBlockedSenderAddress $false
        Write-Host "✓ Created BP_Quarantine-RequestReleaseNotification" -ForegroundColor Green
    } else {
        Set-QuarantinePolicy -Identity "BP_Quarantine-RequestReleaseNotification" \`
            -EndUserQuarantinePermissionsValue 26 \`
            -ESNEnabled $true \`
            -IncludeMessagesFromBlockedSenderAddress $false
        Write-Host "✓ Updated BP_Quarantine-RequestReleaseNotification" -ForegroundColor Green
    }
} catch {
    Write-Host "❌ Error creating BP_Quarantine-RequestReleaseNotification: $_" -ForegroundColor Red
}

# ============================================
# 2. ANTI-PHISHING POLICY
# ============================================
Write-Host "Configuring Anti-Phishing Policy..." -ForegroundColor Yellow

# Create or Update Anti-Phishing Policy
try {
    $ap = Get-AntiPhishPolicy -Identity "BP_AntiPhishing" -ErrorAction SilentlyContinue
    if ($null -eq $ap) {
        New-AntiPhishPolicy -Name "BP_AntiPhishing" \`
            -Enabled $true \`
            -EnableSpoofIntelligence $${config.antiPhishing.spoofIntelligence} \`
            -EnableFirstContactSafetyTips $${config.antiPhishing.firstContactTip} \`
            -EnableUnauthenticatedSender $${config.antiPhishing.unauthSenderSymbol} \`
            -EnableViaTag $${config.antiPhishing.viaTag} \`
            -HonorDmarcPolicy $${config.antiPhishing.honorDmarc} \`
            -DmarcQuarantineAction ${config.antiPhishing.dmarcQuarantineAction} \`
            -DmarcRejectAction ${config.antiPhishing.dmarcRejectAction} \`
            -AuthenticationFailAction ${config.antiPhishing.spoofAction}
        Write-Host "✓ Created BP_AntiPhishing policy" -ForegroundColor Green
    } else {
        Set-AntiPhishPolicy -Identity "BP_AntiPhishing" \`
            -Enabled $true \`
            -EnableSpoofIntelligence $${config.antiPhishing.spoofIntelligence} \`
            -EnableFirstContactSafetyTips $${config.antiPhishing.firstContactTip} \`
            -EnableUnauthenticatedSender $${config.antiPhishing.unauthSenderSymbol} \`
            -EnableViaTag $${config.antiPhishing.viaTag} \`
            -HonorDmarcPolicy $${config.antiPhishing.honorDmarc} \`
            -DmarcQuarantineAction ${config.antiPhishing.dmarcQuarantineAction} \`
            -DmarcRejectAction ${config.antiPhishing.dmarcRejectAction} \`
            -AuthenticationFailAction ${config.antiPhishing.spoofAction}
        Write-Host "✓ Updated BP_AntiPhishing policy" -ForegroundColor Green
    }
} catch {
    Write-Host "❌ Error with BP_AntiPhishing policy: $_" -ForegroundColor Red
}

# Create Anti-Phishing Rule
try {
    $apr = Get-AntiPhishRule -Identity "BP_AntiPhishing_Rule" -ErrorAction SilentlyContinue
    if ($null -eq $apr) {
        New-AntiPhishRule -Name "BP_AntiPhishing_Rule" \`
            -AntiPhishPolicy "BP_AntiPhishing" \`
            -RecipientDomainIs ${domainList} \`
            -Priority 0
        Write-Host "✓ Created BP_AntiPhishing_Rule" -ForegroundColor Green
    } else {
        Write-Host "⚠ BP_AntiPhishing_Rule already exists, skipping" -ForegroundColor Yellow
    }
} catch {
    Write-Host "❌ Error creating BP_AntiPhishing_Rule: $_" -ForegroundColor Red
}

# ⚠️ CRITICAL: Set Quarantine Policy via PowerShell (GUI limitation workaround)
Write-Host "Setting Spoof Quarantine Tag (GUI workaround)..." -ForegroundColor Cyan
try {
    Set-AntiPhishPolicy -Identity "BP_AntiPhishing" \`
        -SpoofQuarantineTag "BP_Quarantine-SelfReleaseNotification"
    Write-Host "✓ Set SpoofQuarantineTag to BP_Quarantine-SelfReleaseNotification" -ForegroundColor Green
} catch {
    Write-Host "❌ Error setting SpoofQuarantineTag: $_" -ForegroundColor Red
}

# ============================================
# 3. ANTI-SPAM POLICY
# ============================================
Write-Host "Configuring Anti-Spam Policy..." -ForegroundColor Yellow

# Create or Update Anti-Spam Policy
try {
    $asp = Get-HostedContentFilterPolicy -Identity "BP_AntiSpam_Inbound" -ErrorAction SilentlyContinue
    if ($null -eq $asp) {
        New-HostedContentFilterPolicy -Name "BP_AntiSpam_Inbound" \`
            -BulkThreshold ${config.antiSpam.bulkThreshold} \`
            -EnableEndUserSpamNotifications $true \`
            -EndUserSpamNotificationFrequency 1 \`
            -SpamAction ${config.antiSpam.spamAction} \`
            -HighConfidenceSpamAction ${config.antiSpam.highConfSpamAction} \`
            -BulkSpamAction ${config.antiSpam.bulkAction} \`
            -PhishSpamAction ${config.antiSpam.phishAction} \`
            -HighConfidencePhishAction ${config.antiSpam.highConfPhishAction} \`
            -QuarantineRetentionPeriod 30 \`
            -InlineSafetyTipsEnabled $true \`
            -SpamQuarantineTag "BP_Quarantine-SelfReleaseNotification" \`
            -HighConfidenceSpamQuarantineTag "BP_Quarantine-SelfReleaseNotification" \`
            -BulkQuarantineTag "BP_Quarantine-SelfReleaseNotification" \`
            -PhishQuarantineTag "BP_Quarantine-SelfReleaseNotification" \`
            -HighConfidencePhishQuarantineTag "BP_Quarantine-RequestReleaseNotification"
        Write-Host "✓ Created BP_AntiSpam_Inbound policy" -ForegroundColor Green
    } else {
        Set-HostedContentFilterPolicy -Identity "BP_AntiSpam_Inbound" \`
            -BulkThreshold ${config.antiSpam.bulkThreshold} \`
            -EnableEndUserSpamNotifications $true \`
            -EndUserSpamNotificationFrequency 1 \`
            -SpamAction ${config.antiSpam.spamAction} \`
            -HighConfidenceSpamAction ${config.antiSpam.highConfSpamAction} \`
            -BulkSpamAction ${config.antiSpam.bulkAction} \`
            -PhishSpamAction ${config.antiSpam.phishAction} \`
            -HighConfidencePhishAction ${config.antiSpam.highConfPhishAction} \`
            -QuarantineRetentionPeriod 30 \`
            -InlineSafetyTipsEnabled $true \`
            -SpamQuarantineTag "BP_Quarantine-SelfReleaseNotification" \`
            -HighConfidenceSpamQuarantineTag "BP_Quarantine-SelfReleaseNotification" \`
            -BulkQuarantineTag "BP_Quarantine-SelfReleaseNotification" \`
            -PhishQuarantineTag "BP_Quarantine-SelfReleaseNotification" \`
            -HighConfidencePhishQuarantineTag "BP_Quarantine-RequestReleaseNotification"
        Write-Host "✓ Updated BP_AntiSpam_Inbound policy" -ForegroundColor Green
    }
} catch {
    Write-Host "❌ Error with BP_AntiSpam_Inbound policy: $_" -ForegroundColor Red
}

# Advanced Spam Filters
try {
    Set-HostedContentFilterPolicy -Identity "BP_AntiSpam_Inbound" \`
        -IncreaseScoreWithBizOrInfoUrls $(if ($${config.antiSpam.bizInfoUrls}) {'On'} else {'Off'}) \`
        -IncreaseScoreWithNumericIps $(if ($${config.antiSpam.numericIpUrls}) {'On'} else {'Off'}) \`
        -IncreaseScoreWithRedirectToOtherPort $(if ($${config.antiSpam.urlRedirect}) {'On'} else {'Off'}) \`
        -MarkAsSpamEmptyMessages $(if ($${config.antiSpam.emptyMessages}) {'On'} else {'Off'}) \`
        -MarkAsSpamJavaScriptInHtml $(if ($${config.antiSpam.jsVbScript}) {'On'} else {'Off'}) \`
        -MarkAsSpamFramesInHtml $(if ($${config.antiSpam.frameIframe}) {'On'} else {'Off'}) \`
        -MarkAsSpamSensitiveWordList $(if ($${config.antiSpam.sensitiveWords}) {'On'} else {'Off'}) \`
        -MarkAsSpamSpfRecordHardFail $(if ($${config.antiSpam.spfHardFail}) {'On'} else {'Off'}) \`
        -MarkAsSpamFromAddressAuthFail $(if ($${config.antiSpam.backscatter}) {'On'} else {'Off'})
    Write-Host "✓ Configured advanced spam filters" -ForegroundColor Green
} catch {
    Write-Host "❌ Error setting advanced spam filters: $_" -ForegroundColor Red
}

# Create Anti-Spam Rule
try {
    $asr = Get-HostedContentFilterRule -Identity "BP_AntiSpam_Inbound_Rule" -ErrorAction SilentlyContinue
    if ($null -eq $asr) {
        New-HostedContentFilterRule -Name "BP_AntiSpam_Inbound_Rule" \`
            -HostedContentFilterPolicy "BP_AntiSpam_Inbound" \`
            -RecipientDomainIs ${domainList} \`
            -Priority 0
        Write-Host "✓ Created BP_AntiSpam_Inbound_Rule" -ForegroundColor Green
    } else {
        Write-Host "⚠ BP_AntiSpam_Inbound_Rule already exists, skipping" -ForegroundColor Yellow
    }
} catch {
    Write-Host "❌ Error creating BP_AntiSpam_Inbound_Rule: $_" -ForegroundColor Red
}

# ============================================
# 4. ANTI-MALWARE POLICY
# ============================================
Write-Host "Configuring Anti-Malware Policy..." -ForegroundColor Yellow

$fileTypes = @(${fileTypesArray})

# Create or Update Anti-Malware Policy
try {
    $amp = Get-MalwareFilterPolicy -Identity "BP_AntiMalware" -ErrorAction SilentlyContinue
    if ($null -eq $amp) {
        New-MalwareFilterPolicy -Name "BP_AntiMalware" \`
            -EnableFileFilter $${config.antiMalware.commonAttachFilter} \`
            -FileTypes $fileTypes \`
            -EnableInternalSenderAdminNotifications $true \`
            -EnableExternalSenderAdminNotifications $true \`
            -InternalSenderAdminAddress "${config.global.adminEmail}" \`
            -ExternalSenderAdminAddress "${config.global.adminEmail}" \`
            -ZapEnabled $${config.antiMalware.zapMalware} \`
            -QuarantineTag "BP_Quarantine-RequestReleaseNotification"
        Write-Host "✓ Created BP_AntiMalware policy" -ForegroundColor Green
    } else {
        Set-MalwareFilterPolicy -Identity "BP_AntiMalware" \`
            -EnableFileFilter $${config.antiMalware.commonAttachFilter} \`
            -FileTypes $fileTypes \`
            -EnableInternalSenderAdminNotifications $true \`
            -EnableExternalSenderAdminNotifications $true \`
            -InternalSenderAdminAddress "${config.global.adminEmail}" \`
            -ExternalSenderAdminAddress "${config.global.adminEmail}" \`
            -ZapEnabled $${config.antiMalware.zapMalware} \`
            -QuarantineTag "BP_Quarantine-RequestReleaseNotification"
        Write-Host "✓ Updated BP_AntiMalware policy" -ForegroundColor Green
    }
} catch {
    Write-Host "❌ Error with BP_AntiMalware policy: $_" -ForegroundColor Red
}

# Create Anti-Malware Rule
try {
    $amr = Get-MalwareFilterRule -Identity "BP_AntiMalware_Rule" -ErrorAction SilentlyContinue
    if ($null -eq $amr) {
        New-MalwareFilterRule -Name "BP_AntiMalware_Rule" \`
            -MalwareFilterPolicy "BP_AntiMalware" \`
            -RecipientDomainIs ${domainList} \`
            -Priority 0
        Write-Host "✓ Created BP_AntiMalware_Rule" -ForegroundColor Green
    } else {
        Write-Host "⚠ BP_AntiMalware_Rule already exists, skipping" -ForegroundColor Yellow
    }
} catch {
    Write-Host "❌ Error creating BP_AntiMalware_Rule: $_" -ForegroundColor Red
}

${generateSafeLinksSection()}

${generateOutboundSection()}

# ============================================
# 7. ALERT POLICY FOR QUARANTINE REQUESTS
# ============================================
Write-Host "Configuring Alert Policy for Quarantine Requests..." -ForegroundColor Yellow

# Note: Microsoft's default "User requested to release a quarantined message" policy is read-only
# We create a custom policy with MSP email notifications
try {
    $alert = Get-ProtectionAlert -Identity "BP_UserRequestReleaseStatus" -ErrorAction SilentlyContinue
    if ($null -eq $alert) {
        # Create new custom policy
        New-ProtectionAlert \`
            -Name "BP_UserRequestReleaseStatus" \`
            -Category ThreatManagement \`
            -ThreatType Activity \`
            -Operation QuarantineRequestReleaseMessage \`
            -NotifyUser "${config.global.adminEmail}","${config.global.igeeksEmail}" \`
            -Severity Low \`
            -Description "igeeks Best Practice: User requested to release a quarantined message" \`
            -AggregationType None
        Write-Host "✓ Created BP_UserRequestReleaseStatus alert policy" -ForegroundColor Green
    } else {
        # Update existing custom policy
        Set-ProtectionAlert -Identity "BP_UserRequestReleaseStatus" \`
            -NotifyUser "${config.global.adminEmail}","${config.global.igeeksEmail}"
        Write-Host "✓ Updated BP_UserRequestReleaseStatus alert policy" -ForegroundColor Green
    }
} catch {
    Write-Host "❌ Error with quarantine alert policy: $_" -ForegroundColor Red
    Write-Host "⚠️  Note: Alert policies may require Office 365 E5 or Defender for Office 365 P2" -ForegroundColor Yellow
}

Write-Host "\\nDeployment completed!" -ForegroundColor Green
Write-Host "Please review the output above for any errors." -ForegroundColor Cyan

`;
}

function generateVerificationScript() {
    return `
# ============================================
# VERIFICATION SCRIPT
# ============================================

Write-Host "\\n=== VERIFICATION ===" -ForegroundColor Cyan

# Verify Quarantine Policies
Write-Host "\\nQuarantine Policies:" -ForegroundColor Yellow
Get-QuarantinePolicy | Where-Object {$_.Name -like "BP_*"} | Format-Table Name, ESNEnabled

# Verify Anti-Phishing
Write-Host "\\nAnti-Phishing Policy:" -ForegroundColor Yellow
Get-AntiPhishPolicy -Identity "BP_AntiPhishing" | Format-List Name, Enabled, HonorDmarcPolicy, SpoofQuarantineTag

# Verify Anti-Spam
Write-Host "\\nAnti-Spam Policy:" -ForegroundColor Yellow
Get-HostedContentFilterPolicy -Identity "BP_AntiSpam_Inbound" | Format-List Name, BulkThreshold, PhishQuarantineTag, HighConfidencePhishQuarantineTag

# Verify Anti-Malware
Write-Host "\\nAnti-Malware Policy:" -ForegroundColor Yellow
Get-MalwareFilterPolicy -Identity "BP_AntiMalware" | Format-List Name, EnableFileFilter, ZapEnabled, QuarantineTag

# Verify Safe Links / Safe Attachments (nur falls lizenziert und aktiviert)
Write-Host "\\nSafe Links / Safe Attachments:" -ForegroundColor Yellow
Get-AtpPolicyForO365 | Format-List EnableSafeLinksForEmail, EnableSafeLinksForOffice, EnableSafeLinksForTeams
Get-SafeLinksPolicy -Identity "BP_SafeLinks" -ErrorAction SilentlyContinue | Format-List Name, IsEnabled, ScanUrls, AllowClickThrough
Get-SafeAttachmentPolicy -Identity "BP_SafeAttachments" -ErrorAction SilentlyContinue | Format-List Name, Enable, Action

# Verify Alert Policy
Write-Host "\\nAlert Policy:" -ForegroundColor Yellow
Get-ProtectionAlert -Identity "BP_UserRequestReleaseStatus" -ErrorAction SilentlyContinue | Format-List Name, Operation, NotifyUser, Severity

Write-Host "\\nVerification completed!" -ForegroundColor Green
`;
}

// Load Documentation

function generateMarkdownDocumentation() {
    const date = new Date().toLocaleDateString('de-DE');

    return `# Microsoft 365 Security Configuration
## M365 Security Best Practice Settings

**Erstellt am:** ${date}  
**Domains:** ${config.global.domains.join(', ')}, ${config.global.onmicrosoftDomain}  
**Admin Email:** ${config.global.adminEmail}

---

## 📋 Konfigurationsübersicht

### Globale Einstellungen

| Einstellung | Wert |
|-------------|------|
| **Accepted Domains** | ${config.global.domains.join(', ')} |
| **OnMicrosoft Domain** | ${config.global.onmicrosoftDomain} |
| **Admin Email** | ${config.global.adminEmail} |
| **MSP Email** | ${config.global.igeeksEmail} |

---

## 🛡️ Anti-Phishing Policy

| Feature | Status |
|---------|--------|
| **Spoof Intelligence** | ${config.antiPhishing.spoofIntelligence ? '✅ Aktiviert' : '❌ Deaktiviert'} |
| **First Contact Tip** | ${config.antiPhishing.firstContactTip ? '✅ Aktiviert' : '❌ Deaktiviert'} |
| **Unauthenticated Sender** | ${config.antiPhishing.unauthSenderSymbol ? '✅ Aktiviert' : '❌ Deaktiviert'} |
| **Via Tag** | ${config.antiPhishing.viaTag ? '✅ Aktiviert' : '❌ Deaktiviert'} |
| **Honor DMARC** | ${config.antiPhishing.honorDmarc ? '✅ Aktiviert' : '❌ Deaktiviert'} |

**DMARC Actions:** Quarantine=${config.antiPhishing.dmarcQuarantineAction}, Reject=${config.antiPhishing.dmarcRejectAction}

---

## 📧 Anti-Spam Policy

| Einstellung | Wert |
|-------------|------|
| **Bulk Threshold** | ${config.antiSpam.bulkThreshold} |
| **Spam Action** | ${config.antiSpam.spamAction} |
| **High Confidence Spam** | ${config.antiSpam.highConfSpamAction} |
| **Phishing Action** | ${config.antiSpam.phishAction} |
| **High Confidence Phishing** | ${config.antiSpam.highConfPhishAction} |

**Filter:** biz/info URLs=${config.antiSpam.bizInfoUrls ? '✅' : '❌'}, Numeric IPs=${config.antiSpam.numericIpUrls ? '✅' : '❌'}, JavaScript=${config.antiSpam.jsVbScript ? '✅' : '❌'}

---

## 🦠 Anti-Malware Policy

| Feature | Status |
|---------|--------|
| **Common Attachment Filter** | ${config.antiMalware.commonAttachFilter ? '✅ Aktiviert' : '❌ Deaktiviert'} |
| **ZAP** | ${config.antiMalware.zapMalware ? '✅ Aktiviert' : '❌ Deaktiviert'} |
| **Malware Action** | ${config.antiMalware.malwareAction} |

**Blockierte Dateitypen:** ${config.antiMalware.customFileTypes}

---

## 🔗 Safe Links & Safe Attachments

${(config.safeLinks && config.safeLinks.enabled === false) ? '❌ **In dieser Vorlage deaktiviert** — wird beim Deploy übersprungen.' : `Braucht Defender for Office 365 Plan 1 (u.a. in Business Premium enthalten) oder Plan 2 (u.a. in E5) — ohne passende Lizenz schlägt nur dieser Baustein fehl, der Rest des Deploys läuft durch.

| Einstellung | Wert |
|-------------|------|
| **Auch interne Mails scannen** | ${config.safeLinks?.enableForInternalSenders !== false ? '✅ Aktiviert' : '❌ Deaktiviert'} |
| **Durchklicken trotz Warnung erlaubt** | ${config.safeLinks?.allowClickThrough ? '⚠️ Ja (weniger sicher)' : '❌ Nein (Best Practice)'} |
| **Safe-Attachments-Aktion** | ${config.safeAttach?.action || 'Block'} |
`}

---

## 🔔 Alert Policy

**Policy:** BP_UserRequestReleaseStatus  
**Operation:** QuarantineRequestReleaseMessage  
**Benachrichtigung:** ${config.global.adminEmail}, ${config.global.igeeksEmail}

---

## 📦 Quarantine Policies

### BP_Quarantine-SelfReleaseNotification
✅ Self-Service Release | ✅ Preview | ✅ Delete

### BP_Quarantine-RequestReleaseNotification
✅ Request Release (Admin) | ✅ Preview | ✅ Delete | ❌ Direct Release

---

*Generiert mit M365 Security Policy Manager*
`;
}

  return { generateDeploymentScript, generateVerificationScript, generateMarkdownDocumentation, generateDomainList, generateDocumentationHeader };
}
