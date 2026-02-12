<#
.SYNOPSIS
    igeeks Best Practice M365 Security Policy Deployment - EXAMPLE

.DESCRIPTION
    Dieses Script implementiert die igeeks Best-Practice Konfiguration für:
    - Anti-Phishing Policy
    - Anti-Spam Inbound Policy
    - Anti-Malware Policy
    - Quarantine Policies

.NOTES
    Domains: hotel-krone.ch, kroneunterstrass.onmicrosoft.com
    Admin Email: alerts.normal@igeeks.ch
    Generated: 2026-02-12
    
.LINK
    https://docs.microsoft.com/en-us/microsoft-365/security/office-365-security/
#>

# ============================================
# DEPLOYMENT SCRIPT
# ============================================

# Connect to Exchange Online
Write-Host "Connecting to Exchange Online..." -ForegroundColor Cyan
Connect-ExchangeOnline

# ============================================
# 1. QUARANTINE POLICIES
# ============================================
Write-Host "Creating Quarantine Policies..." -ForegroundColor Yellow

# Self-Release Notification Policy
New-QuarantinePolicy -Name "BP_Quarantine-SelfReleaseNotification" `
    -EndUserQuarantinePermissionsValue @{
        PermissionToRelease = $true
        PermissionToPreview = $true
        PermissionToAllowSender = $true
        PermissionToBlockSender = $true
        PermissionToDelete = $true
        PermissionToRequestRelease = $false
    } `
    -ESNEnabled $true

# Request-Release Notification Policy
New-QuarantinePolicy -Name "BP_Quarantine-RequestReleaseNotification" `
    -EndUserQuarantinePermissionsValue @{
        PermissionToRelease = $false
        PermissionToPreview = $true
        PermissionToAllowSender = $false
        PermissionToBlockSender = $true
        PermissionToDelete = $true
        PermissionToRequestRelease = $true
    } `
    -ESNEnabled $true

# ============================================
# 2. ANTI-PHISHING POLICY
# ============================================
Write-Host "Configuring Anti-Phishing Policy..." -ForegroundColor Yellow

# Create Anti-Phishing Policy
New-AntiPhishPolicy -Name "BP_AntiPhishing" `
    -Enabled $true `
    -EnableSpoofIntelligence $true `
    -EnableFirstContactSafetyTips $true `
    -EnableUnauthenticatedSender $true `
    -EnableViaTag $true `
    -HonorDmarcPolicy $true `
    -DmarcQuarantineAction Quarantine `
    -DmarcRejectAction Reject `
    -AuthenticationFailAction MoveToJmf

# Create Anti-Phishing Rule
New-AntiPhishRule -Name "BP_AntiPhishing_Rule" `
    -AntiPhishPolicy "BP_AntiPhishing" `
    -RecipientDomainIs "hotel-krone.ch","kroneunterstrass.onmicrosoft.com" `
    -Priority 0

# ⚠️ CRITICAL: Set Quarantine Policy via PowerShell (GUI limitation workaround)
Set-AntiPhishPolicy -Identity "BP_AntiPhishing" `
    -SpoofQuarantineTag "BP_Quarantine-SelfReleaseNotification"

# ============================================
# 3. ANTI-SPAM POLICY
# ============================================
Write-Host "Configuring Anti-Spam Policy..." -ForegroundColor Yellow

New-HostedContentFilterPolicy -Name "BP_AntiSpam_Inbound" `
    -BulkThreshold 7 `
    -EnableEndUserSpamNotifications $true `
    -EndUserSpamNotificationFrequency 1 `
    -SpamAction MoveToJmf `
    -HighConfidenceSpamAction MoveToJmf `
    -BulkSpamAction MoveToJmf `
    -PhishSpamAction Quarantine `
    -HighConfidencePhishAction Quarantine `
    -QuarantineRetentionPeriod 30 `
    -InlineSafetyTipsEnabled $true `
    -PhishQuarantineTag "BP_Quarantine-SelfReleaseNotification" `
    -HighConfidencePhishQuarantineTag "BP_Quarantine-RequestReleaseNotification"

# Advanced Spam Filters
Set-HostedContentFilterPolicy -Identity "BP_AntiSpam_Inbound" `
    -IncreaseScoreWithBizOrInfoUrls On `
    -IncreaseScoreWithNumericIps On `
    -IncreaseScoreWithRedirectToOtherPort On `
    -MarkAsSpamEmptyMessages On `
    -MarkAsSpamJavaScriptInHtml On `
    -MarkAsSpamFramesInHtml On `
    -MarkAsSpamSensitiveWordList On `
    -MarkAsSpamSpfRecordHardFail On `
    -MarkAsSpamFromAddressAuthFail On

# Create Anti-Spam Rule
New-HostedContentFilterRule -Name "BP_AntiSpam_Inbound_Rule" `
    -HostedContentFilterPolicy "BP_AntiSpam_Inbound" `
    -RecipientDomainIs "hotel-krone.ch","kroneunterstrass.onmicrosoft.com" `
    -Priority 0

# ============================================
# 4. ANTI-MALWARE POLICY
# ============================================
Write-Host "Configuring Anti-Malware Policy..." -ForegroundColor Yellow

$fileTypes = @('.ace', '.apk', '.app', '.appx', '.arj', '.bat', '.cab', '.cmd', '.com', '.deb', '.dex', '.dll', '.dmg', '.elf', '.exe', '.hta', '.img', '.iso', '.jar', '.jnlp', '.kext', '.lha', '.lib', '.library', '.lnk', '.lzh', '.macho', '.msc', '.msi', '.msix', '.msp', '.mst', '.pif', '.pkg', '.prf', '.ps1', '.scr', '.sct', '.sys', '.vb', '.vbe', '.vbs', '.vxd', '.wsc', '.wsf', '.wsh', '.xll')

New-MalwareFilterPolicy -Name "BP_AntiMalware" `
    -EnableFileFilter $true `
    -FileTypes $fileTypes `
    -Action Reject `
    -EnableInternalSenderAdminNotifications $true `
    -EnableExternalSenderAdminNotifications $true `
    -InternalSenderAdminAddress "alerts.normal@igeeks.ch" `
    -ExternalSenderAdminAddress "alerts.normal@igeeks.ch" `
    -ZapEnabled $true `
    -QuarantineTag "BP_Quarantine-RequestReleaseNotification"

# Create Anti-Malware Rule
New-MalwareFilterRule -Name "BP_AntiMalware_Rule" `
    -MalwareFilterPolicy "BP_AntiMalware" `
    -RecipientDomainIs "hotel-krone.ch","kroneunterstrass.onmicrosoft.com" `
    -Priority 0

Write-Host "Deployment completed successfully!" -ForegroundColor Green

# ============================================
# VERIFICATION SCRIPT
# ============================================

Write-Host "`n=== VERIFICATION ===" -ForegroundColor Cyan

# Verify Quarantine Policies
Write-Host "`nQuarantine Policies:" -ForegroundColor Yellow
Get-QuarantinePolicy | Where-Object {$_.Name -like "BP_*"} | Format-Table Name, ESNEnabled

# Verify Anti-Phishing
Write-Host "`nAnti-Phishing Policy:" -ForegroundColor Yellow
Get-AntiPhishPolicy -Identity "BP_AntiPhishing" | Format-List Name, Enabled, HonorDmarcPolicy, SpoofQuarantineTag

# Verify Anti-Spam
Write-Host "`nAnti-Spam Policy:" -ForegroundColor Yellow
Get-HostedContentFilterPolicy -Identity "BP_AntiSpam_Inbound" | Format-List Name, BulkThreshold, PhishQuarantineTag, HighConfidencePhishQuarantineTag

# Verify Anti-Malware
Write-Host "`nAnti-Malware Policy:" -ForegroundColor Yellow
Get-MalwareFilterPolicy -Identity "BP_AntiMalware" | Format-List Name, EnableFileFilter, ZapEnabled, QuarantineTag

Write-Host "`nVerification completed!" -ForegroundColor Green
