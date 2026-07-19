# ============================================================
#  WLAN-Profil-Export-Helper (M365 Security Policy Manager)
# ------------------------------------------------------------
#  Auf einem Rechner ausfuehren, der bereits mit dem gewuenschten
#  Kunden-WLAN verbunden ist. Exportiert das Profil INKL. Passwort
#  (key=clear) -> braucht Admin-Rechte (fordert UAC selbst an).
#  Danach die erzeugte XML im Tool hochladen.
# ============================================================

# --- Self-Elevation (key=clear braucht Administrator) + Bypass ---
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "Fordere Administrator-Rechte an (fuer key=clear-Export)..." -ForegroundColor Yellow
    try {
        Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`""
        )
    } catch {
        Write-Host "UAC abgebrochen oder fehlgeschlagen. Bitte PowerShell 'Als Administrator' oeffnen und erneut starten." -ForegroundColor Red
        pause
    }
    exit
}

$ErrorActionPreference = 'Stop'

# Fester, gut auffindbarer Ausgabeordner (unabhaengig vom Start-Kontext)
$outDir = 'C:\Temp\wlan-export'
New-Item -ItemType Directory -Path $outDir -Force | Out-Null

Write-Host "`n=== Verfuegbare WLAN-Profile ===" -ForegroundColor Cyan
$raw = netsh wlan show profiles
$profiles = @()
foreach ($line in $raw) {
    if ($line -match ':\s*(.+?)\s*$' -and $line -match 'Profil|Profile') {
        $name = ($line -split ':', 2)[1].Trim()
        if ($name -and $name -notmatch 'Gruppenrichtlinie|Group [Pp]olicy|Befehlszeile|Command line|Benutzerprofil|User profile|:$') { $profiles += $name }
    }
}
$profiles = $profiles | Select-Object -Unique

if (-not $profiles) {
    Write-Host "Keine WLAN-Profile gefunden. Ist der Rechner mit einem WLAN verbunden?" -ForegroundColor Red
    pause; exit 1
}

for ($i = 0; $i -lt $profiles.Count; $i++) { Write-Host ("  [{0}] {1}" -f ($i + 1), $profiles[$i]) }
do { $sel = (Read-Host "`nProfil-Nummer") -as [int] } while ($sel -lt 1 -or $sel -gt $profiles.Count)
$name = $profiles[$sel - 1]

Write-Host "Exportiere '$name' (inkl. Passwort)..." -ForegroundColor Yellow
$res = netsh wlan export profile name="$name" key=clear folder="$outDir"
Write-Host ($res -join "`n") -ForegroundColor DarkGray

$file = Get-ChildItem -Path $outDir -Filter '*.xml' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($file) {
    Write-Host "`n[OK] Exportiert nach:" -ForegroundColor Green
    Write-Host "     $($file.FullName)" -ForegroundColor Green
    Write-Host "`n>> Diese XML im Tool unter 'Autopilot -> Staging-Paket -> WLAN' hochladen.`n"
    try { Start-Process explorer.exe "/select,`"$($file.FullName)`"" } catch {}
} else {
    Write-Host "Export fehlgeschlagen (kein XML erzeugt). Passwort-Export braucht Admin + verbundenes/gespeichertes Profil." -ForegroundColor Red
}
pause
