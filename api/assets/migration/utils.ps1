<#
.SYNOPSIS
    Utility functions for Intune migration process

.DESCRIPTION
    This script contains common utility functions used throughout the Intune migration process,
    including logging, Microsoft Graph authentication, and password generation.

.AUTHOR
    Created for Intune Migration v9

.DATE
    October 27, 2025

.VERSION
    1.0
#>

# Utilities used throughout the migration process

# Log function
function Log {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory, Position=0)]
        [ValidateSet('info','warning','error','success')]
        [string]$Type,

        [Parameter(Mandatory, Position=1)]
        [string]$Message
    )

    $date = Get-Date -Format 'yyyy-MM-dd hh:mm:ss tt' # or HH without tt
    $typeFormatted = switch ($Type.ToLower()) {
        'info'    { '[INFO]' }
        'warning' { '[WARNING]' }
        'error'   { '[ERROR]' }
        'success' { '[SUCCESS]' }
    }

    "$date - $typeFormatted - $Message" | Write-Output
}

# Graph authenticate
function msGraphAuthenticate() {
    [CmdletBinding()]
    Param(
        [Parameter(Mandatory = $true)]
        [string]$tenantName,
        [Parameter(Mandatory = $true)]
        [string]$clientId,
        [Parameter(Mandatory = $true)]
        [string]$clientSecret
    )
    $headers = New-Object "System.Collections.Generic.Dictionary[[String],[String]]"
    $headers.Add("Content-Type", "application/x-www-form-urlencoded")
    $body = "grant_type=client_credentials&scope=https://graph.microsoft.com/.default"
    $body += -join ("&client_id=", $clientId, "&client_secret=", $clientSecret)
    $response = Invoke-RestMethod "https://login.microsoftonline.com/$tenantName/oauth2/v2.0/token" -Method Post -Headers $headers -Body $body

    $token = -join ("Bearer ", $response.access_token)

    $headers = New-Object "System.Collections.Generic.Dictionary[[String],[String]]"
    $headers.Add("Authorization", $token)
    $headers.Add("Content-Type", "application/json")
    $headers = @{'Authorization' = "$($token)" }
    return $headers
}

# Generate password
function generatePassword() {
    Param(
        [int]$length = 12
    )
    $charSet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()-_=+[]{}|;:',<.>/?"
    $securePassword = New-Object -TypeName System.Security.SecureString
    1..$length | ForEach-Object {
        $random = $charSet[(Get-Random -Minimum 0 -Maximum $charSet.Length)]
        $securePassword.AppendChar($random)
    }
    return $securePassword
}

# [igeeks] Passwort als Klartext erzeugen.
# generatePassword liefert einen SecureString -- den brauchen New-LocalUser und
# Set-LocalUser, aber die Autologon-Registry und der Win32-Domain-Unjoin
# brauchen Klartext. Ausserdem stellt diese Funktion sicher, dass alle vier
# Zeichenklassen vorkommen: bei aktiver Komplexitaetsrichtlinie lehnt Windows
# sonst gelegentlich ein zufaelliges Passwort ab -- und zwar an einer Stelle,
# an der ein Abbruch besonders weh tut.
function generatePasswordPlain() {
    Param(
        [int]$length = 16
    )
    $lower = "abcdefghijklmnopqrstuvwxyz"
    $upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    $digit = "0123456789"
    $special = "!@#%^*-_=+"
    $all = $lower + $upper + $digit + $special

    # Aus jeder Klasse eines, Rest auffuellen, dann mischen
    $chars = @(
        $lower[(Get-Random -Maximum $lower.Length)],
        $upper[(Get-Random -Maximum $upper.Length)],
        $digit[(Get-Random -Maximum $digit.Length)],
        $special[(Get-Random -Maximum $special.Length)]
    )
    for ($i = $chars.Count; $i -lt $length; $i++) {
        $chars += $all[(Get-Random -Maximum $all.Length)]
    }
    return -join ($chars | Sort-Object { Get-Random })
}

# Set registry
function setRegistry() {
    Param(
        [string]$regPath,
        [string]$regName,
        [object]$regValue
    )

    # Check if the path exists
    if (-not (Test-Path $regPath)) {
        log warning "Registry path $regPath does not exist, creating it..."
        New-Item -Path $regPath -Force | Out-Null
    }

    # Check current value
    $currentValue = Get-ItemProperty -Path $regPath -Name $regName -ErrorAction SilentlyContinue

    if ($null -eq $currentValue) {
        New-ItemProperty -Path $regPath -Name $regName -Value $regValue -Force | Out-Null
    }
    elseif ($currentValue.$regName -ne $regValue) {
        Set-ItemProperty -Path $regPath -Name $regName -Value $regValue -Force | Out-Null
    }
    else {
        return
    }
}


