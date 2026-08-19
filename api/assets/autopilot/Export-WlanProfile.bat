@echo off
REM Startet den WLAN-Export ohne Execution-Policy-/Signatur-Problem.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Export-WlanProfile.ps1"
