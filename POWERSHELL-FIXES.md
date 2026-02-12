# PowerShell Script Fixes - Technical Notes

## Issues Fixed

### 1. Quarantine Policy Creation Error
**Problem:**
```powershell
New-QuarantinePolicy : Cannot process argument transformation on parameter 'EndUserQuarantinePermissionsValue'. 
Cannot convert the "System.Collections.Hashtable" value of type "System.Collections.Hashtable" to type "System.Int32".
```

**Root Cause:**
Microsoft's `New-QuarantinePolicy` cmdlet expects an **integer value** for `-EndUserQuarantinePermissionsValue`, not a hashtable. The integer is a bitmask representing the permissions.

**Solution:**
Use numeric values instead of hashtables:

```powershell
# Self-Release (Full permissions except RequestRelease)
-EndUserQuarantinePermissionsValue 236

# Request-Release (Limited permissions, requires admin approval)
-EndUserQuarantinePermissionsValue 171
```

**Permission Bitmask Breakdown:**

| Permission | Bit Value | SelfRelease (236) | RequestRelease (171) |
|------------|-----------|-------------------|----------------------|
| PermissionToViewHeader | 1 | ✅ | ✅ |
| PermissionToDownload | 2 | ✅ | ✅ |
| PermissionToAllowSender | 4 | ✅ | ❌ |
| PermissionToBlockSender | 8 | ✅ | ✅ |
| PermissionToRequestRelease | 16 | ❌ | ✅ |
| PermissionToRelease | 32 | ✅ | ❌ |
| PermissionToPreview | 128 | ✅ | ✅ |
| PermissionToDelete | 64 | ✅ | ✅ |

**Calculation:**
- **SelfRelease (236)**: 128 + 64 + 32 + 8 + 4 + 2 + 1 = 236 (missing only RequestRelease=16)
- **RequestRelease (171)**: 128 + 64 + 16 + 8 + 2 + 1 = 171 (missing AllowSender=4 and Release=32)

### 2. Anti-Malware Policy Error
**Problem:**
```powershell
New-MalwareFilterPolicy : A parameter cannot be found that matches parameter name 'Action'.
```

**Root Cause:**
The `New-MalwareFilterPolicy` cmdlet does NOT have an `-Action` parameter. The action for malware is always to quarantine or reject based on other settings.

**Solution:**
Remove the `-Action` parameter entirely. The behavior is controlled by:
- File types are blocked (rejected with NDR) when `EnableFileFilter` is `$true`
- Malware is always quarantined
- The `QuarantineTag` parameter controls which quarantine policy is used

```powershell
# Correct syntax (no -Action parameter)
New-MalwareFilterPolicy -Name "BP_AntiMalware" `
    -EnableFileFilter $true `
    -FileTypes $fileTypes `
    -EnableInternalSenderAdminNotifications $true `
    -EnableExternalSenderAdminNotifications $true `
    -InternalSenderAdminAddress "alerts.normal@igeeks.ch" `
    -ExternalSenderAdminAddress "alerts.normal@igeeks.ch" `
    -ZapEnabled $true `
    -QuarantineTag "BP_Quarantine-RequestReleaseNotification"
```

### 3. Policy Already Exists Errors
**Problem:**
```powershell
Write-ErrorMessage : ||Die Anti-Phishing-Richtlinie "BP_AntiPhishing" ist bereits vorhanden.
```

**Root Cause:**
The script tried to create policies that already existed from previous runs.

**Solution:**
Added try-catch blocks with existence checks:

```powershell
try {
    $ap = Get-AntiPhishPolicy -Identity "BP_AntiPhishing" -ErrorAction SilentlyContinue
    if ($null -eq $ap) {
        New-AntiPhishPolicy -Name "BP_AntiPhishing" ...
        Write-Host "✓ Created BP_AntiPhishing policy" -ForegroundColor Green
    } else {
        Set-AntiPhishPolicy -Identity "BP_AntiPhishing" ...
        Write-Host "✓ Updated BP_AntiPhishing policy" -ForegroundColor Green
    }
} catch {
    Write-Host "❌ Error with BP_AntiPhishing policy: $_" -ForegroundColor Red
}
```

This makes the script **idempotent** - it can be run multiple times safely.

## Quarantine Policy Assignment

### Which Quarantine Policy is Used Where?

Based on the igeeks Best Practice configuration:

| Threat Type | Action | Quarantine Policy |
|-------------|--------|-------------------|
| **Anti-Phishing** | | |
| Spoof (via PowerShell workaround) | Quarantine | `BP_Quarantine-SelfReleaseNotification` |
| DMARC p=quarantine | Quarantine | Default (not customizable) |
| DMARC p=reject | Reject | N/A |
| **Anti-Spam** | | |
| Spam | Move to Junk | N/A |
| High Confidence Spam | Move to Junk | N/A |
| Bulk | Move to Junk | N/A |
| Phishing | Quarantine | `BP_Quarantine-SelfReleaseNotification` |
| High Confidence Phishing | Quarantine | `BP_Quarantine-RequestReleaseNotification` |
| **Anti-Malware** | | |
| Malware detected | Quarantine | `BP_Quarantine-RequestReleaseNotification` |
| Blocked file types | Reject with NDR | N/A |

### Critical PowerShell Workaround

Microsoft's GUI does **not** allow setting the quarantine policy for Anti-Phishing spoof detection. This must be done via PowerShell:

```powershell
Set-AntiPhishPolicy -Identity "BP_AntiPhishing" `
    -SpoofQuarantineTag "BP_Quarantine-SelfReleaseNotification"
```

**Why this is important:**
- Without this, spoofed emails use the default quarantine policy
- Default policy has inconsistent user permissions
- Users may not be able to release legitimate emails
- No control over notification behavior

## Verification

After running the deployment script, verify the configuration:

```powershell
# Check Quarantine Policies
Get-QuarantinePolicy | Where-Object {$_.Name -like "BP_*"} | Format-Table Name, ESNEnabled, EndUserQuarantinePermissionsValue

# Check Anti-Phishing Spoof Quarantine Tag
Get-AntiPhishPolicy -Identity "BP_AntiPhishing" | Format-List SpoofQuarantineTag

# Check Anti-Spam Quarantine Tags
Get-HostedContentFilterPolicy -Identity "BP_AntiSpam_Inbound" | Format-List PhishQuarantineTag, HighConfidencePhishQuarantineTag

# Check Anti-Malware Quarantine Tag
Get-MalwareFilterPolicy -Identity "BP_AntiMalware" | Format-List QuarantineTag
```

**Expected Output:**
```
Name                                     ESNEnabled EndUserQuarantinePermissionsValue
----                                     ---------- ---------------------------------
BP_Quarantine-SelfReleaseNotification          True                               236
BP_Quarantine-RequestReleaseNotification       True                               171

SpoofQuarantineTag           : BP_Quarantine-SelfReleaseNotification

PhishQuarantineTag               : BP_Quarantine-SelfReleaseNotification
HighConfidencePhishQuarantineTag : BP_Quarantine-RequestReleaseNotification

QuarantineTag : BP_Quarantine-RequestReleaseNotification
```

## Testing Recommendations

1. **Test Quarantine Policies:**
   - Send a test phishing email
   - Verify user can see it in quarantine
   - Test release functionality
   - Verify notifications are received

2. **Test Anti-Phishing:**
   - Send a spoofed email
   - Verify it's quarantined with correct policy
   - Test DMARC enforcement

3. **Test Anti-Spam:**
   - Send test spam/phishing emails
   - Verify correct actions (Junk vs. Quarantine)
   - Check quarantine policy assignments

4. **Test Anti-Malware:**
   - Send email with blocked file type
   - Verify rejection with NDR
   - Test ZAP functionality

## References

- [Microsoft Docs: Quarantine Policies](https://docs.microsoft.com/en-us/microsoft-365/security/office-365-security/quarantine-policies)
- [Microsoft Docs: Anti-Phishing Policies](https://docs.microsoft.com/en-us/microsoft-365/security/office-365-security/anti-phishing-policies-about)
- [Microsoft Docs: Anti-Spam Policies](https://docs.microsoft.com/en-us/microsoft-365/security/office-365-security/anti-spam-protection-about)
- [Microsoft Docs: Anti-Malware Policies](https://docs.microsoft.com/en-us/microsoft-365/security/office-365-security/anti-malware-protection-about)
