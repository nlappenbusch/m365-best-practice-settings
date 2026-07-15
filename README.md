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

#### `BP_Quarantine-SelfReleaseNotification` (Permissions-Wert 59)
Für Spam, Bulk, Spoof und normale Phishing-Fälle:
- ✅ Request Release
- ✅ Allow Sender
- ✅ Block Sender
- ✅ Preview
- ✅ Delete
- ✅ Notifications (inkl. Nachrichten von blockierten Absendern)
- ❌ Direct Release

#### `BP_Quarantine-RequestReleaseNotification` (Permissions-Wert 26)
Für High Confidence Phishing und Malware mit Admin-Kontrolle:
- ✅ Request Release
- ✅ Block Sender
- ✅ Preview
- ✅ Notifications (ohne Nachrichten von blockierten Absendern)
- ❌ Allow Sender
- ❌ Delete
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
m365-best-practice-settings/
├── index.html          # Haupt-Interface
├── styles.css          # Microsoft 365 Design System
├── app.js              # Konfiguration & Export-Logik
├── livedeploy.js       # Frontend für Live-Deploy (Tab "🚀 Live-Deploy")
├── api/                # Live-Deploy-Backend (Node + pwsh im Container)
│   ├── server.js       # Login, Tenant-Onboarding (Device-Code), Deploy-API
│   ├── lib/exorunner.js# App-only Connect-ExchangeOnline via Zertifikat
│   ├── lib/deploy.js   # Config-Validierung + PowerShell-Body-Generator
│   └── Dockerfile      # node:20 + PowerShell 7 + ExchangeOnlineManagement
└── README.md           # Diese Datei
```

### Browser-Kompatibilität

- ✅ Chrome/Edge 90+
- ✅ Firefox 88+
- ✅ Safari 14+

### Server-Komponente optional

Die Konfigurations- und Export-Funktionen laufen vollständig im Browser. Für den
**Live-Deploy** (Tab "🚀 Live-Deploy") läuft zusätzlich das Backend aus `api/`
im Docker-Stack — im rein statischen Betrieb zeigt der Tab einen Hinweis und
die generierten PowerShell-Skripte bleiben der Weg zum Deployment.

## 🚀 Live-Deploy (Policies direkt anwenden)

Statt das generierte Skript manuell auszuführen, kann das Tool die Policies
direkt in einen Tenant deployen:

1. **Backend-Login**: Zugangsdaten stehen beim ersten Start im Container-Log
   (`docker logs m365-security-api`) oder werden über `ADMIN_PASSWORD` in der
   Compose-Umgebung vorgegeben.
2. **Tenant onboarden** (einmalig pro Tenant): Admin meldet sich per
   Device-Code an. Dabei wird automatisch angelegt:
   - App-Registrierung `M365-Security-Policy-Manager`
   - API-Permission `Exchange.ManageAsApp` (Office 365 Exchange Online) inkl. Admin-Consent
   - Entra-Rollen **Exchange Administrator** (Policies) und **Compliance
     Administrator** (Alert Policy via Security & Compliance PowerShell)
   - Self-signed Zertifikat (Public Key in der App, PEM im Backend-Volume `api-state`)
3. **Deploy**: wendet die aktuelle Konfiguration idempotent an — Quarantine-,
   Anti-Phishing-, Anti-Spam- und Anti-Malware-Policies inkl. Rules (app-only
   `Connect-ExchangeOnline`) mit Live-Fortschritt. Vorhandene `BP_`-Policies
   werden aktualisiert statt übersprungen.
4. **🔎 Prüfen**: liest den Ist-Zustand der BP_-Policies live aus dem Tenant und
   zeigt einen Soll/Ist-Vergleich gegen die aktuelle Konfiguration.

**Alert Policy = manueller Mini-Schritt:** Security & Compliance PowerShell
(`Connect-IPPSSession`) ist laut Microsoft-Doku auf Linux nicht verfügbar — der
Backend-Container kann `BP_UserRequestReleaseStatus` daher nicht selbst anlegen.
Das Deploy-Ergebnis liefert stattdessen ein fertiges Snippet zum einmaligen
Ausführen auf einem Windows-Rechner (Single-Event-Alert via
`-AggregationType None`, kein E5 nötig).

**Hinweis:** Frisch onboardete Tenants brauchen wenige Minuten
Entra-Replikationszeit, bevor der erste Verbindungstest/Deploy klappt. Tenants,
die vor der Alert-Policy-Erweiterung onboardet wurden, einfach neu onboarden —
dabei wird die fehlende Compliance-Administrator-Rolle ergänzt (App und
Zertifikat bleiben erhalten bzw. werden erneuert).

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
