
<#
    .SYNOPSIS
        Runs post-migration tasks after device reboot and user sign-in.

    .DESCRIPTION
        Updates device group tag in Entra ID, sets the primary user in Intune, migrates the BitLocker recovery key, and registers the device with AutoPilot.

    .EXAMPLE
        .\postMigrate.ps1

    .AUTHOR
        Steve Weiner

    .CONTRIBUTORS
        Logan Lautt
#>

# Import utils functions
. "$($PSScriptRoot)\utils.ps1"


$ErrorActionPreference = "SilentlyContinue"

# Import settings from the JSON file
$config = Get-Content "C:\ProgramData\IntuneMigration\config.json" | ConvertFrom-Json

# Start Transcript
Start-Transcript -Path "$($config.logPath)\postMigrate.log" -Verbose
log info "Starting PostMigrate.ps1..."

# Sleep 60 seconds
log info "Waiting for device to initialize..."
Start-Sleep -Seconds 60

# Initialize script
$localPath = $config.localPath
if (!(Test-Path $localPath)) {
    log info "$($localPath) does not exist.  Creating..."
    mkdir $localPath
}
else {
    log info "$($localPath) already exists."
}

# Check context
$context = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
log info "Running as $($context)"
$systemSIDs = @("S-1-5-18") # SID for NT AUTHORITY\SYSTEM
$currentSID = ([System.Security.Principal.WindowsIdentity]::GetCurrent()).User.Value

if ($currentSID -notin $systemSIDs) {
    log error "Script must be run in system context. Exiting..."
    exit 1
}

# disable postMigrate task
log info "Disabling postMigrate task..."
Disable-ScheduledTask -TaskName "postMigrate"
log info "postMigrate task disabled."

# enable displayLastUserName
log "Enabling displayLastUserName..."
try {
    setRegistry -regPath "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System" -regName "DontDisplayLastUserName" -regValue 0
    log success "Successfully enabled display last user name."
}
catch {
    $message = $_.Exception.Message
    log warning "Could not enable display last user name."
}

# authenticate to target tenant if exists
if ($config.targetTenant.tenantName) {
    log "Authenticating to target tenant..."
    $headers = msGraphAuthenticate -tenantName $config.targetTenant.tenantName -clientID $config.targetTenant.clientID -clientSecret $config.targetTenant.clientSecret
    log "Authenticated to target tenant."
}
else {
    log "No target tenant specified.  Authenticating into source tenant."
    $headers = msGraphAuthenticate -tenantName $config.sourceTenant.tenantName -clientID $config.sourceTenant.clientID -clientSecret $config.sourceTenant.clientSecret
    log "Authenticated to source tenant."
}

# Get current device Intune and Entra attributes
log "Getting current device attributes..."
$intuneDeviceId = ((Get-ChildItem "Cert:\LocalMachine\My" | Where-Object { $_.Issuer -match "Microsoft Intune MDM Device CA" } | Select-Object Subject).Subject).TrimStart("CN=")
$entraDeviceId = ((Get-ChildItem "Cert:\LocalMachine\My" | Where-Object { $_.Issuer -match "MS-Organization-Access" } | Select-Object Subject).Subject).TrimStart("CN=")
$entraId = (Invoke-RestMethod -Method Get -Uri "https://graph.microsoft.com/beta/devices?`$filter=deviceid eq '$entraDeviceId'" -Headers $headers).value.id
log "Intune Device ID is $($intuneDeviceId)"
log "Entra Object ID is $($entraId)"

# setPrimaryUser
[string]$targetUserId = (Get-ItemProperty -Path "HKLM:\SOFTWARE\IntuneMigration" -Name "NEW_entraUserID").NEW_entraUserID
[string]$sourceUserId = (Get-ItemProperty -Path "HKLM:\SOFTWARE\IntuneMigration" -Name "OLD_entraUserID").OLD_entraUserID
    
if ([string]::IsNullOrEmpty($targetUserId)) {
    log "Target user not found- proceeding with source user $($sourceUserId)."
    $userId = $sourceUserId
}
else {
    log "Target user found- proceeding with target user $($targetUserId)."
    $userId = $targetUserId
}
$userUri = "https://graph.microsoft.com/beta/users/$userId"
$id = "@odata.id"
$JSON = @{ $id = $userUri } | ConvertTo-Json

# if fail, try again 3 times over 3 minutes
$maxAttempts = 4
$retryDelaySeconds = 60

try {
    for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
        try {
            Invoke-RestMethod -Uri "https://graph.microsoft.com/beta/deviceManagement/managedDevices/$intuneDeviceId/users/`$ref" -Method Post -Headers $headers -Body $JSON -ContentType "application/json"
            log success "Primary user set to $($userId)."
            break
        }
        catch {
            if ($attempt -lt $maxAttempts) {
                $message = $_.Exception.Message
                log warning "Attempt $attempt failed: $message. Retrying in $($retryDelaySeconds) seconds..."
                Start-Sleep -Seconds $retryDelaySeconds
            }
            else {
                throw 
            }
        }
    }
}
catch {
    $message = $_.Exception.Message
    log warning "Error setting primary user: $message"
    log warning "Adjust manually in Intune console."
}

# updateGroupTag

$tag1 = (Get-ItemProperty -Path "HKLM:\SOFTWARE\IntuneMigration" -Name "OLD_groupTag" -ErrorAction SilentlyContinue).OLD_groupTag
$tag2 = $config.groupTag

if (![string]::IsNullOrEmpty($tag1)) {
    $groupTag = $tag1
}
elseif (![string]::IsNullOrEmpty($tag2)) {
    $groupTag = $tag2
}
else {
    $groupTag = $null
    log info "No group tag found."
}

if (![string]::IsNullOrEmpty($groupTag)) {
    log info "Updating group tag to $($groupTag) for Entra Device $($entraId)..."
    $entraDeviceObject = Invoke-RestMethod -Method Get -Uri "https://graph.microsoft.com/beta/devices/$entraId" -Headers $headers
    $physicalIds = $entraDeviceObject.physicalIds
    $newTag = "[OrderID]:$groupTag"
    $physicalIds += $newTag

    $body = @{
        physicalIds = $physicalIds
    } | ConvertTo-Json

    $max = 4
    $retrySeconds = 60
    
    try {
        for ($attempt = 1; $attempt -le $max; $attempt++) {
            try {
                Invoke-RestMethod -Uri "https://graph.microsoft.com/beta/devices/$entraId" -Method Patch -Headers $headers -Body $body
                log success "Group tag updated to $($groupTag)."
                break
            }
            catch {
                if ($attempt -lt $max) {
                    $message = $_.Exception.Message
                    log warning "Attempt $attempt failed: $message. Retrying in $retrySeconds seconds"
                    Start-Sleep -Seconds $retrySeconds
                }
                else {
                    throw
                }                
            }       
        }
    }
    catch {
        $message = $_.Exception.Message
        log warning "Error setting group tag: $($message)."
        log warning "Set manually in Intune console."
    }
}



# FUNCTION: migrateBitlockerKey
function migrateBitlockerKey() {
    Param(
        [string]$mountPoint = "C:",
        [PSCustomObject]$bitLockerVolume = (Get-BitLockerVolume -MountPoint $mountPoint),
        [string]$keyProtectorId = ($bitLockerVolume.KeyProtector | Where-Object { $_.KeyProtectorType -eq "RecoveryPassword" }).KeyProtectorId
    )
    if ($bitLockerVolume.KeyProtector.count -gt 0) {
        BackupToAAD-BitLockerKeyProtector -MountPoint $mountPoint -KeyProtectorId $keyProtectorId
        log info "Bitlocker recovery key migrated."
    }
    else {
        log info "No bitlocker recovery key found."
    }
}

# FUNCTION: decryptDrive
function decryptDrive() {
    Param(
        [string]$mountPoint = "C:"
    )
    Disable-BitLocker -MountPoint $mountPoint
    log info "Drive decrypted."
}

# check bitlocker settings in config file and either migrate or decrypt
log info "Checking bitlocker settings..."
if ($config.bitlocker -eq "MIGRATE") {
    log info "Migrating bitlocker recovery key..."
    try {
        migrateBitlockerKey
        log info "Bitlocker recovery key migrated."
    }
    catch {
        $message = $_.Exception.Message
        log warning "Error migrating bitlocker recovery key: $message"
    }
}
elseif ($config.bitlocker -eq "DECRYPT") {
    log info "Decrypting drive..."
    try {
        decryptDrive
        log success "Drive decrypted."
    }
    catch {
        $message = $_.Exception.Message
        log warning "Error decrypting drive: $message"
    }
}
else {
    log info "Bitlocker settings not found."
}

# Register device in Autopilot
log info "Registering device in Autopilot..."

# Get hardware info
$serialNumber = (Get-CimInstance -ClassName Win32_BIOS).SerialNumber
$hardwareId = ((Get-CimInstance -Namespace root/cimv2/mdm/dmmap -ClassName MDM_DevDetail_Ext01 -Filter "InstanceID='Ext' AND ParentID='./DevDetail'").DeviceHardwareData)
if ([string]::IsNullOrEmpty($groupTag)) {
    $tag = ""
}
else {
    $tag = $groupTag
}

# Construct JSON
$json = @"
{
    "@odata.type": "#microsoft.graph.importedWindowsAutopilotDeviceIdentity",
    "groupTag":"$tag",
    "serialNumber":"$serialNumber",
    "productKey":"",
    "hardwareIdentifier":"$hardwareId",
    "assignedUserPrincipalName":"",
    "state":{
        "@odata.type":"microsoft.graph.importedWindowsAutopilotDeviceIdentityState",
        "deviceImportStatus":"pending",
        "deviceRegistrationId":"",
        "deviceErrorCode":0,
        "deviceErrorName":""
    }
}
"@

# Post device
try {
    Invoke-RestMethod -Method Post -Body $json -ContentType "application/json" -Uri "https://graph.microsoft.com/beta/deviceManagement/importedWindowsAutopilotDeviceIdentities" -Headers $headers
    log success "Device registered in Autopilot."
}
catch {
    $message = $_.Exception.Message
    log warning "Error registering device in Autopilot: $message"
}

# reset lock screen caption
# Specify the registry key path
log info "Resetting lock screen message..."
$registryKeyPath = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System"

# Specify the names of the registry entries to delete
$entryNames = @("legalnoticecaption", "legalnoticetext")

# Loop through each entry and delete it
foreach ($entryName in $entryNames) {
    try {
        Remove-ItemProperty -Path $registryKeyPath -Name $entryName -Force
        log success "Deleted registry entry: $entryName"
    }
    catch {
        log warning "Failed to delete registry entry: $entryName. Error: $_"
    }
}


# Cleanup


# Remove scheduled tasks
log info "Removing scheduled tasks..."
$tasks = @("reboot", "postMigrate")
foreach ($task in $tasks) {
    Unregister-ScheduledTask -TaskName $task -Confirm:$false
    log info "$task task removed."
}

# Remove MigrationUser
log info "Removing MigrationUser..."
Remove-LocalUser -Name "MigrationInProgress" -Confirm:$false
log info "MigrationUser removed."

# [igeeks] Fallback-Admin: bleibt standardmaessig bestehen, damit ein Geraet
# auch spaeter noch erreichbar ist, wenn im Zieltenant etwas schiefgeht. Wer das
# nicht will, setzt removeAfterMigration auf true -- ein dauerhaftes lokales
# Admin-Konto mit ueberall gleichem Passwort ist selbst ein Risiko (lateral
# movement). Sauberste Variante: Konto behalten und im Zieltenant per Windows
# LAPS verwalten lassen.
$fallbackConfig = $config.fallbackAdmin
if ($fallbackConfig -and $fallbackConfig.enabled -eq $true) {
    $fallbackName = if ([string]::IsNullOrWhiteSpace($fallbackConfig.name)) { "igeeksRecovery" } else { $fallbackConfig.name }
    if ($fallbackConfig.removeAfterMigration -eq $true) {
        log info "Removing fallback admin '$fallbackName' as configured..."
        try {
            Remove-LocalUser -Name $fallbackName -Confirm:$false
            log success "Fallback admin removed."
        }
        catch {
            log warning "Could not remove fallback admin '$($fallbackName)': $($_.Exception.Message)"
        }
    }
    else {
        log info "Fallback admin '$fallbackName' kept on the device (manage it with Windows LAPS in the destination tenant)."
    }
}

# [igeeks] Arbeitsverzeichnis loeschen. Es enthaelt config.json mit den Client
# Secrets beider Tenants und das Provisioning Package mit dem Bulk-Enrollment-
# Token des Zieltenants. Im Original blieb beides dauerhaft auf dem Geraet.
if ($config.cleanupLocalPath -ne $false) {
    log info "Removing working directory $($config.localPath)..."
    try {
        # Transcript liegt im logPath, nicht hier -- das Verzeichnis kann weg.
        Remove-Item -Path $config.localPath -Recurse -Force -ErrorAction Stop
        log success "Working directory removed -- tenant secrets are no longer on the device."
    }
    catch {
        $message = $_.Exception.Message
        log error "FAILED to remove $($config.localPath): $message"
        log error "Tenant secrets are still on this device -- remove the directory manually and rotate both client secrets."
    }
}
else {
    log warning "cleanupLocalPath disabled -- config.json with both client secrets stays on the device."
}

# End Transcript
log info "Device migration complete"
Stop-Transcript
