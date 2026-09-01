# M365 Best Practice Settings

**igeeks Security Policy Manager** – Web-basiertes Tool zur Konfiguration und Deployment von Microsoft 365 Security Best Practices.

## Features

- 🛡️ **Anti-Phishing Policy** Configuration
- 📧 **Anti-Spam Policy** Settings
- 🦠 **Anti-Malware Policy** Management
- 🔔 **Alert Policies** für Quarantine Notifications
- 📦 **Quarantine Policies** mit Self-Service & Admin-Approval
- 🔍 **Maester Security-Audit** (CISA SCuBA, CIS M365, EIDSCA, ORCA) pro Tenant mit Score, Verlauf und HTML-Report
- 📦 **App-Deployment nach Intune** (Win32-App) für Bitdefender, N-sight RMM,
  FortiClient und die **Bitwarden-Desktop-App**
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
- **Legacy-ASF-Optionen (Advanced Spam Filter): Off** — entspricht der
  Microsoft-Empfehlung und den Microsoft Standard-/Strict-Presets. Die
  ASF-Schalter übersteuern ARC/Composite-Authentication, erzeugen False
  Positives (z.B. SPF Hard Fail hinter Verschlüsselungs-Gateways wie SEPPmail)
  und ASF-Treffer sind nicht als False Positive meldbar. Im Tool bei Bedarf
  gezielt aktivierbar.
- **Differenzierte Aktionen:**
  - Spam/Bulk → Quarantine (Self-Release-Policy)
  - Phishing → Quarantine (Self-Release-Policy)
  - High Confidence Phishing → Quarantine (Request-Release-Policy)

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

1. Tenant Allow/Block List sauber pflegen
2. Erweiterte Custom File Types
3. User Awareness Training

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

## 📐 Baseline (Tab Wissen → Baseline)

Die Betriebsrichtlinien als **eine Quelle**: `api/baseline/baseline.json`.
Darin die Agent-Module mit allen PMP-Feldwerten und Erkennungsregeln, das
Grundgerüst für Custom Apps, CIS-Delta und Break-Risk-Liste, die
Onboarding-Checkliste, die Mail-Härtung und die Entscheidungsregeln.

Das Namensschema steht dort **nicht** — es kommt live aus der
Namenskonvention dazu. Die Agent-Einträge tragen nur den Muster-Schlüssel, den
fertigen Gruppennamen rechnet die Baseline aus.

| Zugang | Wofür |
|---|---|
| Wissensseite **Baseline** | nachschlagen, inkl. der Namen wie sie in diesem Tenant heissen |
| `GET /api/baseline/export.html` | eigenständiges Dokument zum Weitergeben und Drucken |
| `GET /api/mcp/v1/baseline` | für KI-Beratung «gemäss Baseline vX.Y» — ohne Tenant-Freigabe, es sind Richtlinien |

Geändert wird die Baseline über einen Commit mit Review, nicht über die
Oberfläche. Eine Betriebsrichtlinie, die sich zur Laufzeit ändern lässt, ist
keine.

## 🏷️ Namenskonvention (Tab Namenskonvention)

Legt fest, wie die Objekte heissen, die dieses Werkzeug anlegt. Zwei Profile,
dazu frei editierbare Muster je Objekttyp:

| Objekt | Bestand (Vorgabe) | v2 |
|---|---|---|
| Gerätegruppe | `AAD-WIN-Std` | `T2-DG-WIN-Std` |
| App-Zielgruppe | `AAD-APP-Bitdefender` | `T2-DG-WIN-AppBitdefender` |
| CA-Ring | `AAD-CA-RING-PILOT` | `T0-CSG-GOV-CA-RingPilot` |
| CA-Break-Glass | `AAD-CA-BreakGlass` | `T0-CSG-GOV-CA-BreakGlass-Exempt` |
| Break-Glass-Konto | `breakglass-01` | `brk.notfall01` |
| Plattformskript | `WIN - DriveMapping - Standard` | `T2-WIN-CP-DriveMapping-Standard` |

**Global als Vorgabe, pro Tenant überschreibbar** — ein neuer Kunde kann auf v2
laufen, während Bestandskunden ihre gewachsenen Namen behalten.

**Bestehende Objekte werden nie umbenannt.** Gesucht wird über alle bekannten
Muster, nicht nur über das aktive: Sonst legt das Werkzeug nach einem Wechsel
neben der vorhandenen Gruppe eine zweite an — bei einer leeren
Break-Glass-Ausnahmegruppe wäre das gefährlich.

Der `BP_`-Marker der EOP-Objekte ist bewusst ausgenommen: Er identifiziert die
tool-eigenen Exchange-Objekte, und der Audit erkennt sie daran wieder.

## 🧩 Browser-Erweiterungen erzwingen (Tab Browser-Erweiterungen)

Legt ein Custom-Konfigurationsprofil an (OMA-URI auf
`ExtensionInstallForcelist`), das die gewählten Erweiterungen in **Edge** still
installiert — der Benutzer kann sie nicht entfernen. Bitwarden ist als Vorlage
hinterlegt, weitere Erweiterungen lassen sich über ihre Id ergänzen.

**Zuweisung an die Gerätegruppe**, nie an eine App-Zielgruppe: Intune löst
verschachtelte Gruppen nur beim App-Assignment auf.

Chrome und Firefox brauchen eine ADMX-Ingestion und sind hier nicht abgedeckt.
Die Server-Region der Bitwarden-Erweiterung ist ein getrenntes Objekt — dafür
ist die Registry-Richtlinie zuständig.

## 🎯 App-Zielgruppen (Tab GroupTags)

Eine App wird immer an **genau eine** Gruppe zugewiesen. Welche Geräte sie
bekommen, steuert das **Nesting**: Die dynamische GroupTag-Gerätegruppe wird
Mitglied der App-Gruppe, Intune löst das beim App-Assignment auf. Der Bereich
*App-Zielgruppen* legt beides an — Gruppe und Verknüpfung —, sodass für ein
Agent-Rollout weder Entra- noch Intune-Portal geöffnet werden muss.

| Funktion | Details |
|---|---|
| Bestand anzeigen | alle Gruppen mit `AAD-APP-`, `AAD-PMP-`, `T2-DG-WIN-App`, `T2-DG-WIN-Pmp` |
| Mitglieder | verknüpfte Gerätegruppen als Chips, ✕ löst die Verknüpfung |
| Zuweisungsnachweis | zeigt, welche Intune-App mit welchem Intent auf der Gruppe hängt |
| Anlegen | Presets (Bitdefender, RMM-Agent, Bitwarden, FortiClient) oder freier Name |
| Schema | `AAD-APP-…` (Vorgabe) oder `T2-DG-WIN-App…` (v2) |

Angeboten werden nur Gerätegruppen mit `[OrderID]`-Tag — andere ergeben als
Mitglied keinen Sinn. Anlegen ist idempotent: Eine vorhandene Gruppe wird
wiederverwendet, nicht gedoppelt.

**Was das Tool nicht tut:** die App selbst zuweisen. Das bleibt in Patch My PC,
dort gegen diese eine Gruppe, Intent *Required*.

**Achtung bei Plattformskripten:** Intune löst verschachtelte Gruppen *nur beim
App-Assignment* auf. Ein Plattformskript (Drive-/Printer-Mapping,
Registry-Richtlinie) muss deshalb direkt an die Gerätegruppe zugewiesen werden,
nie an eine App-Gruppe — sonst erreicht es kein Gerät.

## 🔐 Bitwarden-Desktop-App per Intune verteilen

Tab **📦 Apps & Agents → 🔐 Bitwarden**. Kein API-Key nötig — der Windows-Client
liegt öffentlich als GitHub-Release-Asset, `bitwarden.com/download` verweist auf
das jeweils aktuelle Release. Das Backend liest daraus Version, Installer und
Offline-Pakete (`api/lib/bitwarden.js`).

### Warum das Tool das Offline-Paket mitliefert

Bitwarden liefert den Windows-Client als electron-builder-**nsis-web**-Installer
aus: `Bitwarden-Installer-<ver>.exe` ist nur ein ~0,7-MB-Stub, die eigentlichen
~122 MB liegen daneben als `bitwarden-<ver>-<arch>.nsis.7z` und werden erst
**während** der Installation nachgeladen.

Für ein Intune-Deployment ist das die schlechte Variante: das Gerät bräuchte im
SYSTEM-Kontext freien Zugriff auf `github.com`, und schlägt der Download fehl,
zeigt der Stub eine Meldung (Wiederholen/Abbrechen) an, die dort niemand sieht —
die Installation hängt bis zum Intune-Timeout.

electron-builder dokumentiert dafür den Offline-Weg: liegt die Paketdatei im
**selben Ordner** wie der Installer, wird sie automatisch erkannt und verwendet
(Prüfsumme wird geprüft). Genau das baut das Tool — Stub und passendes
`.nsis.7z` landen zusammen im Intune-Paket.

### Paketierung

| Variante | Upload | Wann |
|----------|--------|------|
| **Offline, x64** | ~122 MB | Standard |
| **Offline, x64 + ARM64** | ~244 MB | nur bei ARM64-Geräten im Tenant (verdoppelt auch den Speicherbedarf des Backends beim Deploy) |
| **Nur Web-Installer** | ~0,7 MB | nur wenn die Geräte sicher ans Internet kommen |

Zugewiesen wird nur, wofür auch ein Offline-Paket im Paket liegt
(`applicableArchitectures`). Installer und Paket werden vor dem Upload gegen die
SHA-512-Summen aus der `latest.yml` des Releases geprüft.

### Vorbelegte Werte (Bitwarden-Doku)

```
Install:    "Bitwarden-Installer-<ver>.exe" /allusers /S
Uninstall:  "C:\Program Files\Bitwarden\Uninstall Bitwarden.exe" /allusers /S
Erkennung:  Datei  C:\Program Files\Bitwarden  →  Bitwarden.exe
```

`/allusers` installiert maschinenweit (im SYSTEM-Kontext gibt es sonst keinen
Benutzer), `/S` still — bei NSIS **gross** geschrieben, sonst wirkungslos.

### Bezugsquelle

Der Installer ist für alle Regionen und auch für Self-Hosting derselbe. Geholt
wird er über drei Hosts, die das Backend (nicht die Endgeräte!) erreichen muss:

| Host | Wofür |
|------|-------|
| `vault.bitwarden.com` | Auflösung des aktuellen Releases (302 auf das GitHub-Release) |
| `github.com` | Release-Assets von `bitwarden/clients` (Installer, `latest.yml`, Offline-Pakete) |
| `release-assets.githubusercontent.com` | Auslieferung der Dateien — GitHub leitet vom Release-Pfad dorthin um |

Die Tabelle steht auch im Tab, und der Erreichbarkeitstest unter **Diagnose**
prüft genau diese Hosts.

### Server-Region der Browsererweiterung

Im Bereitstellen-Dialog lässt sich die Region **direkt mitgeben** — EU-Cloud,
US-Cloud oder eigene Instanz mit URL. Derselbe Lauf legt dann zusätzlich das
Plattformskript `WIN - RegistryPolicy - Bitwarden-Region` an (3rdparty-Extension-
Policy für Chrome und Edge, beide Erweiterungs-IDs) und weist es **der
dynamischen GroupTag-Gerätegruppe** zu — nicht der genesteten `AAD-APP-`-Gruppe,
denn Intune löst verschachtelte Gruppen nur beim App-Assignment auf, bei
Plattformskripten nicht.

Dasselbe gibt es weiterhin als Vorlage `bitwarden-browserext-eu` unter
**🗂️ Mappings → Registry-Richtlinie**, falls man es unabhängig vom App-Deployment
ausrollen will.

**Wichtig, drei getrennte Dinge:**

| | Was es tut |
|---|---|
| Win32-App | installiert die **Desktop-App** |
| Region-Skript | setzt die Serverregion der **Browsererweiterung** |
| Erweiterungsrichtlinie im Intune-Portal | **installiert** die Browsererweiterung — macht das Tool nicht |

Die Region der **Desktop-App** setzt nichts davon: die liest sie aus einer
`data.json` im Benutzerprofil, die erst beim ersten Start entsteht. Dort wählt
sie der Benutzer beim ersten Login.

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
