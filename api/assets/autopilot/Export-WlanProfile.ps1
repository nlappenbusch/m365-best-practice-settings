# ============================================================
#  WLAN-Profil-Export-Helper (M365 Security Policy Manager)
# ------------------------------------------------------------
#  Auf einem Rechner ausfuehren, der bereits mit dem gewuenschten
#  Kunden-WLAN verbunden ist. Exportiert das Profil INKL. Passwort
#  (key=clear), damit es in die autounattend.xml eingebettet werden
#  kann. Danach die erzeugte XML im Tool hochladen.
# ============================================================
if ((Get-ExecutionPolicy -Scope Process) -ne 'Bypass') {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$PSCommandPath"
    exit
}

$outDir = Join-Path $PSScriptRoot 'wlan-export'
New-Item -ItemType Directory -Path $outDir -Force | Out-Null

Write-Host "`n=== Verfuegbare WLAN-Profile ===" -ForegroundColor Cyan
$profiles = (netsh wlan show profiles) |
    Select-String 'All User Profile\s*:\s*(.+)$|Profil fuer alle Benutzer\s*:\s*(.+)$' |
    ForEach-Object { ($_.Matches.Groups | Where-Object { $_.Success -and $_.Value -notmatch 'Profile' } | Select-Object -Last 1).Value.Trim() } |
    Where-Object { $_ }

if (-not $profiles) {
    # Fallback: einfache Spaltentrennung
    $profiles = (netsh wlan show profiles) | Select-String ':\s*(.+)$' | ForEach-Object { $_.Matches.Groups[1].Value.Trim() } | Where-Object { $_ -and $_ -notmatch 'Richtlinie|Policy|Gruppe|Group|Befehlszeile|Command' }
}

if (-not $profiles) { Write-Host 'Keine WLAN-Profile gefunden. Ist der Rechner mit einem WLAN verbunden?' -ForegroundColor Red; pause; exit 1 }

for ($i = 0; $i -lt $profiles.Count; $i++) { Write-Host ("  [{0}] {1}" -f ($i + 1), $profiles[$i]) }
do { $sel = (Read-Host "`nProfil-Nummer") -as [int] } while ($sel -lt 1 -or $sel -gt $profiles.Count)
$name = $profiles[$sel - 1]

Write-Host "Exportiere '$name' (inkl. Passwort)..." -ForegroundColor Yellow
netsh wlan export profile name="$name" key=clear folder="$outDir" | Out-Null

$file = Get-ChildItem -Path $outDir -Filter '*.xml' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($file) {
    Write-Host "`n[OK] Exportiert nach:" -ForegroundColor Green
    Write-Host "     $($file.FullName)" -ForegroundColor Green
    Write-Host "`n>> Diese XML im Tool unter 'Autopilot -> Staging-Paket -> WLAN-Profil' hochladen.`n"
    try { explorer.exe "/select,`"$($file.FullName)`"" } catch {}
} else {
    Write-Host 'Export fehlgeschlagen.' -ForegroundColor Red
}
pause
