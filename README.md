# M365 Best Practice Settings

**igeeks Security Policy Manager** – Web-basiertes Tool zur Konfiguration und Deployment von Microsoft 365 Security Best Practices.

## Features

- 🛡️ **Anti-Phishing Policy** Configuration
- 📧 **Anti-Spam Policy** Settings
- 🦠 **Anti-Malware Policy** Management
- 🔔 **Alert Policies** für Quarantine Notifications
- 📦 **Quarantine Policies** mit Self-Service & Admin-Approval
- 📜 **PowerShell Script Export** für automatisches Deployment
- 💾 **JSON Export/Import** für Konfigurationsverwaltung
- 📄 **Markdown Documentation Export**

## Deployment

### Lokal testen

Einfach `index.html` im Browser öffnen.

### Produktion

Automatisches Deployment via GitHub Actions:

```bash
git add .
git commit -m "Update configuration"
git push
```

→ Container wird automatisch auf dem Docker-Server neu gebaut und deployed.

**Live URL:** https://m365-security.igeeks.ch

## Technologie

- **Frontend:** Vanilla HTML/CSS/JavaScript
- **Deployment:** Docker + Nginx
- **CI/CD:** GitHub Actions mit Self-hosted Runner
- **Proxy:** Nginx Proxy Manager

## Lizenz

© 2026 igeeks AG

Ein interaktives Web-Tool zur Verwaltung und Dokumentation von Microsoft 365 Security Policies nach igeeks Best Practices.

## 🎯 Features

- **Interaktive Konfiguration** aller Security Policies (Anti-Phishing, Anti-Spam, Anti-Malware, Quarantine)
- **Domain & Email Anpassung** - Einfache Anpassung von Domains und Admin-E-Mails
- **PowerShell Export** - Generierung von Deployment- und Verification-Scripts
- **Umfassende Dokumentation** - Best Practice Erklärungen und Delta-Analyse
- **Settings-as-Code** - Exportierbare PowerShell-Scripts für automatisierte Deployments

## 🚀 Verwendung

### Lokale Nutzung

1. Öffne `index.html` in einem modernen Browser (Chrome, Edge, Firefox)
2. Passe die globalen Einstellungen an (Domain, Admin-Email)
3. Konfiguriere die einzelnen Policies nach Bedarf
4. Exportiere die PowerShell-Scripts über den "Export PowerShell" Button

### Deployment in M365

1. Generiere das PowerShell-Script über die Export-Funktion
2. Verbinde dich mit Exchange Online PowerShell:
   ```powershell
   Connect-ExchangeOnline
   ```
3. Führe das generierte Script aus
4. Verifiziere die Konfiguration mit dem Verification-Script

## 📋 Konfigurierte Policies

### 1. Anti-Phishing Policy (`BP_AntiPhishing`)

- **Spoof Intelligence** aktiviert
- **DMARC Honor Policy** aktiviert
- **First Contact Safety Tips** aktiviert
- **Differenzierte Aktionen** basierend auf DMARC-Policy

**⚠️ Wichtig:** Die Quarantine Policy für Spoof-Fälle kann nur per PowerShell zugewiesen werden:

```powershell
Set-AntiPhishPolicy -Identity "BP_AntiPhishing" `
    -SpoofQuarantineTag "BP_Quarantine-SelfReleaseNotification"
```

### 2. Anti-Spam Inbound Policy (`BP_AntiSpam_Inbound`)

- **Bulk Threshold:** 7
- **Erweiterte Spam-Filter** aktiviert
- **Differenzierte Aktionen:**
  - Spam/Bulk → Junk Folder
  - Phishing → Quarantine (Self-Release)
  - High Confidence Phishing → Quarantine (Request-Release)

### 3. Anti-Malware Policy (`BP_AntiMalware`)

- **Common Attachments Filter** aktiviert
- **47+ Custom File Types** blockiert
- **Zero-Hour Auto Purge (ZAP)** aktiviert
- **Admin Notifications** konfiguriert

### 4. Quarantine Policies

#### `BP_Quarantine-SelfReleaseNotification`
Für normale Phishing-Fälle mit moderatem Risiko:
- ✅ Release
- ✅ Allow Sender
- ✅ Block Sender
- ✅ Preview
- ✅ Delete
- ✅ Notifications

#### `BP_Quarantine-RequestReleaseNotification`
Für High Confidence Phishing mit Admin-Kontrolle:
- ✅ Request Release
- ✅ Block Sender
- ✅ Preview
- ✅ Delete
- ✅ Notifications
- ❌ Direct Release

## 🔐 Warum eigene Quarantine Policies?

Microsoft Default Quarantine Policies haben folgende Probleme:

- ❌ Unklare Userrechte
- ❌ Inkonsistente Freigabelogik
- ❌ Keine granular steuerbare Benachrichtigungen
- ❌ Keine definierte Release-Governance
- ❌ Intransparente User Experience

**igeeks Lösung:** Zwei differenzierte Policies für unterschiedliche Risikostufen mit klaren Benutzerrechten und konsistenten Notifications.

## 📊 Delta-Analyse: AppRiver → M365

### ✅ Abgedeckt

| AppRiver Feature | M365 Mapping | Status |
|-----------------|--------------|--------|
| SPF/DKIM/DMARC | AntiSpam + AntiPhish | ✅ |
| Banned File Extensions | Anti-Malware Filter | ✅ |
| Phishing Tests | Anti-Phishing Policy | ✅ |
| Quarantine Workflow | Custom Quarantine Policies | ✅ |

### ⚠️ Lizenz-bedingte Lücken

**Ohne Defender for Office 365 nicht verfügbar:**

- **Safe Links** - URL Rewrite + Time-of-click Protection
- **Safe Attachments** - Sandbox / Detonation / Dynamic Delivery

**Empfohlene Kompensation:**

1. Strengeres Handling für High Confidence Spam (Quarantine statt Junk)
2. Tenant Allow/Block List sauber pflegen
3. Erweiterte Custom File Types
4. User Awareness Training

## 🛠️ Technische Details

### Projektstruktur

```
M365-BEst-PracticeSettings/
├── index.html          # Haupt-Interface
├── styles.css          # Microsoft 365 Design System
├── app.js              # Konfiguration & Export-Logik
└── README.md           # Diese Datei
```

### Browser-Kompatibilität

- ✅ Chrome/Edge 90+
- ✅ Firefox 88+
- ✅ Safari 14+

### Keine Server-Komponente erforderlich

Das Tool läuft vollständig im Browser - keine Installation, keine Dependencies, keine Server-Infrastruktur notwendig.

## 📖 Verwendete Standards

- **Microsoft 365 Security Best Practices**
- **igeeks Security Guidelines**
- **RFC-konforme DMARC Enforcement**
- **Zero Trust Security Principles**

## 🎨 Design

Das Tool verwendet das offizielle Microsoft 365 Design System:

- **Farben:** Microsoft Blue (#0078D4), Teal (#00BCF2), Light Blue (#50E6FF)
- **Typography:** Inter Font Family
- **Animations:** Smooth transitions und micro-interactions
- **Responsive:** Mobile-first Design

## 📝 Lizenz

© 2026 igeeks - Internes Tool für M365 Security Policy Management

## 🤝 Support

Bei Fragen oder Problemen wende dich an das igeeks Security Team.

---

**Version:** 1.0.0  
**Letzte Aktualisierung:** 2026-02-12  
**Maintainer:** igeeks Security Team
