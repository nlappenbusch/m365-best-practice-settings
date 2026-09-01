// Identisch zu api/lib/deploy.js (buildAlertPolicySnippet) — bewusst dupliziert,
// da es reine Textgenerierung aus der Konfiguration ist (kein Tenant-/Graph-
// Zugriff noetig) und im Mail-Security-Tab jederzeit sichtbar sein soll, auch
// ohne aktiven Tenant oder laufendes Backend.
function psArray(list) {
  return '@(' + list.map(e => "'" + String(e).replace(/'/g, "''") + "'").join(', ') + ')'
}

export function buildAlertPolicySnippet(global) {
  const recipients = [global.adminEmail].filter(Boolean)
  if (global.igeeksEmail && global.igeeksEmail !== global.adminEmail) recipients.push(global.igeeksEmail)
  const notify = psArray(recipients)
  return [
    "# Alert Policy fuer Quarantine-Release-Anfragen — einmalig pro Tenant",
    "# auf einem WINDOWS-Rechner ausfuehren (S&C PowerShell gibt es nicht auf Linux).",
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
    "    Write-Host 'Warnungsrichtlinie User restricted from sending email nicht gefunden — im Defender-Portal pruefen.' -ForegroundColor Yellow",
    "} else {",
    "    $empf = @($restricted.NotifyUser) + " + notify + " | Where-Object { $_ } | Sort-Object -Unique",
    "    Set-ProtectionAlert -Identity 'User restricted from sending email' -NotifyUser $empf -NotificationEnabled $true -Confirm:$false",
    "}",
    "Disconnect-ExchangeOnline -Confirm:$false"
  ].join('\r\n')
}
