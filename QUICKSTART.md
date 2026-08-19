# 🚀 Quick Start Guide

## Sofort loslegen

1. **Öffne das Tool:**
   - Doppelklick auf `index.html`
   - Oder: Rechtsklick → "Öffnen mit" → Browser deiner Wahl

2. **Passe deine Einstellungen an:**
   - Ändere die Domain (z.B. `hotel-krone.ch`)
   - Ändere die Admin-Email
   - Konfiguriere die Policies nach Bedarf

3. **Exportiere PowerShell:**
   - Klick auf "Export PowerShell"
   - Kopiere das Script oder lade es herunter
   - Führe es in Exchange Online PowerShell aus

## 📋 Schnell-Checkliste

### Vor dem Deployment

- [ ] Domains korrekt eingetragen?
- [ ] Admin-Email korrekt?
- [ ] Alle Policies geprüft?
- [ ] PowerShell Script generiert?

### Deployment

```powershell
# 1. Mit Exchange Online verbinden
Connect-ExchangeOnline

# 2. Generiertes Script ausführen
# (Script aus dem Tool kopieren oder .ps1 Datei ausführen)

# 3. Verifizieren
Get-QuarantinePolicy | Where-Object {$_.Name -like "BP_*"}
Get-AntiPhishPolicy -Identity "BP_AntiPhishing"
```

### Nach dem Deployment

- [ ] Quarantine Policies erstellt?
- [ ] Anti-Phishing Policy aktiv?
- [ ] Anti-Spam Policy aktiv?
- [ ] Anti-Malware Policy aktiv?
- [ ] Verification Script ausgeführt?

## 💡 Tipps

### GUI Limitation Workaround

Die Quarantine Policy für Anti-Phishing **muss** per PowerShell zugewiesen werden:

```powershell
Set-AntiPhishPolicy -Identity "BP_AntiPhishing" `
    -SpoofQuarantineTag "BP_Quarantine-SelfReleaseNotification"
```

Das Tool generiert diesen Befehl automatisch im Export!

### Bulk Threshold Anpassung

Der Bulk Threshold (Standard: 7) bestimmt, wie streng Bulk-Mails gefiltert werden:

- **1-3:** Sehr streng (mehr False Positives)
- **4-7:** Ausgewogen (empfohlen)
- **8-9:** Weniger streng (mehr Bulk-Mails kommen durch)

### Custom File Types

Die Liste der blockierten File Types kann erweitert werden. Häufige Ergänzungen:

- `.docm` - Word Makro-Dokumente
- `.xlsm` - Excel Makro-Dokumente
- `.pptm` - PowerPoint Makro-Präsentationen

## 🎯 Häufige Szenarien

### Szenario 1: Neue Domain hinzufügen

1. Ändere "Primary Domain" im Tool
2. Exportiere neues PowerShell Script
3. Führe nur die Rule-Updates aus:

```powershell
Set-AntiPhishRule -Identity "BP_AntiPhishing_Rule" `
    -RecipientDomainIs "neue-domain.ch","kroneunterstrass.onmicrosoft.com"
```

### Szenario 2: Admin-Email ändern

1. Ändere "Admin Notification Email" im Tool
2. Exportiere Script
3. Update nur die Malware Policy:

```powershell
Set-MalwareFilterPolicy -Identity "BP_AntiMalware" `
    -InternalSenderAdminAddress "neue-email@domain.ch" `
    -ExternalSenderAdminAddress "neue-email@domain.ch"
```

### Szenario 3: Strengere Spam-Filterung

1. Ändere High Confidence Spam Action von "Move to Junk" auf "Quarantine"
2. Exportiere Script
3. Update die Policy:

```powershell
Set-HostedContentFilterPolicy -Identity "BP_AntiSpam_Inbound" `
    -HighConfidenceSpamAction Quarantine
```

## 🔍 Troubleshooting

### Problem: Policy existiert bereits

**Lösung:** Lösche die alte Policy oder ändere den Namen im generierten Script:

```powershell
Remove-AntiPhishPolicy -Identity "BP_AntiPhishing"
Remove-AntiPhishRule -Identity "BP_AntiPhishing_Rule"
```

### Problem: Quarantine Policy kann nicht zugewiesen werden

**Lösung:** Stelle sicher, dass die Quarantine Policy zuerst erstellt wurde:

```powershell
Get-QuarantinePolicy -Identity "BP_Quarantine-SelfReleaseNotification"
```

### Problem: Connection zu Exchange Online schlägt fehl

**Lösung:** Installiere/Update das Exchange Online PowerShell Modul:

```powershell
Install-Module -Name ExchangeOnlineManagement -Force
Update-Module -Name ExchangeOnlineManagement
```

## 📚 Weitere Ressourcen

- **Microsoft Docs:** [Office 365 Security](https://docs.microsoft.com/en-us/microsoft-365/security/office-365-security/)
- **igeeks Best Practices:** Siehe "Dokumentation" Tab im Tool
- **Delta-Analyse:** Siehe "Delta-Analyse" Tab im Tool

---

**Viel Erfolg beim Deployment! 🚀**
