# M365 Best Practice Settings Tool - Changelog

## Version 2.3 - Autopilot-Paket-Generator (2026-07-19)

### 🚀 Neu: Autopilot-Staging-Paket pro Tenant

Im Tenant-Panel erzeugt **🚀 Autopilot → 📦 Staging-Paket erstellen** ein
komplettes ZIP für Nils' Autopilot-Use-Case (github.com/nlappenbusch/IntuneAutopilot):

- **Dedizierte App-Registrierung** `IG-Autopilot-Staging` wird per Admin-Device-Code
  angelegt — mit **Client Secret** (Staging während OOBE) **und** self-signed
  **Zertifikat** (PFX via openssl im Container), Autopilot-Graph-Permissions
  (DeviceManagementServiceConfig/ManagedDevices.ReadWrite, Group.ReadWrite,
  Directory.Read) + Admin-Consent.
- **GroupTag-Auswahl** kommt aus den **dynamischen Security Groups** des Ziel-Tenants
  (die Regeln werden nach `[OrderID]:<GroupTag>` geparst) — nur echte, konfigurierte
  GroupTags sind wählbar.
- **ZIP-Inhalt**: `AutopilotApp_config.json` (echte Tenant-/App-/Secret-/Cert-Werte),
  `wrapper-config.json`, `Run-AutopilotWithExternalAppConfig.ps1` (mit Auswahlmenü der
  gewählten GroupTags), das HWID-Community-Skript, `Start-Autopilot.bat`,
  `autounattend.xml`, die WIM-Bau-Anleitung, README und die Zertifikatsdateien
  (PFX + CER). ZIP-Erzeugung ohne externe Dependency (eigener Store/Deflate-Encoder).
- Download-Link ist einmalig und läuft nach 10 Minuten ab (Secret/PFX nur in der ZIP).

### 🎯 Neu: Autopilot-Deployment-Profile einsehen & zuweisen

**🚀 Autopilot → 🎯 Deployment-Profile** listet die
`windowsAutopilotDeploymentProfiles` inkl. bestehender Assignments und weist ein
Profil einer Security-Gruppe zu (Merge). Dafür hat die Management-App zusätzlich
`DeviceManagementServiceConfig.ReadWrite.All` — 🔧 Reparieren ergänzt sie.

## Version 2.2 - ASF-Defaults auf Off (2026-07-15)

### 🛡️ Breaking: Legacy-ASF-Optionen standardmäßig deaktiviert

Alle 9 Advanced-Spam-Filter-Schalter (`IncreaseScoreWith*`, `MarkAsSpam*` inkl.
**SPF Hard Fail**, **Backscatter**, **Sensitive Words**) stehen jetzt in allen
Presets auf **Off** — entsprechend der ausdrücklichen Microsoft-Empfehlung und
den Microsoft Standard-/Strict-Preset-Policies.

**Hintergrund (Lessons Learned aus Produktiv-Incident):** `MarkAsSpamSpfRecordHardFail`
stuft jeden SPF-Hartfehler pauschal als High-Confidence-Spam (SCL 9) ein und
übersteuert dabei gültige ARC-/Composite-Auth-Resultate. Hinter Inline-Gateways
(z.B. SEPPmail) ist ein SPF-Fail strukturell — legitime verschlüsselte
Geschäftsmails landeten in der Quarantäne. ASF-Treffer sind bei Microsoft zudem
nicht als False Positive meldbar. Die Schalter bleiben im Tool als bewusste
Opt-ins verfügbar (mit Warnhinweis).

**Wirkung auf bestehende Tenants:** Der nächste Live-Deploy bzw. Skript-Lauf
setzt die ASF-Parameter auf `Off`; das Audit (🔎 Prüfen) markiert Tenants mit
aktiven ASF-Schaltern als Abweichung.

### 🔔 Alert-Policy-Prüfung via TCM-Snapshot

Das Audit (🔎 Prüfen) prüft `BP_UserRequestReleaseStatus` jetzt automatisch —
trotz fehlendem S&C PowerShell auf Linux. Weg: Microsoft Graph **Tenant
Configuration Management** (GA-APIs) erstellt einen Snapshot der
`microsoft.securityandcompliance.protectionalert`-Ressourcen; das Backend
wertet Existenz, Aktiv-Status und Empfänger aus. Voraussetzungen richtet das
Onboarding/🔧 Reparieren automatisch ein: TCM-Service-Principal
(`03b07b79-…`) + M365 Admin Services SP im Tenant, TCM-SP bekommt
`Exchange.ManageAsApp` + Entra-Rolle **Security Reader**, unsere App bekommt
`ConfigurationMonitoring.ReadWrite.All`. Das Anlegen der Alert Policy bleibt
der manuelle 📋-Schritt (TCM kann nur lesen, `mode: monitorOnly`).

### 🧩 Neu: OIB-Policy-Zuweisung (Intune)

Pro Tenant zeigt der Button **🧩 OIB** alle "Win - OIB"-Policies (Settings Catalog
via `configurationPolicies` + Endpoint Security via `intents`, Graph beta) nach
Typ gruppiert, inklusive bestehender Assignments. Zuweisung an **dynamische
Security Groups** (GroupTag-Konzept) per Checkbox-Auswahl.

- **Merge statt Ersetzen:** `POST /assign` ersetzt in Graph die komplette
  Assignment-Liste — das Original-Skript hätte bestehende Assignments entfernt.
  Das Tool merged bestehende Targets (inkl. Assignment-Filter) mit der neuen Gruppe.
- Bereits zugewiesene Policies werden erkannt und übersprungen.
- Graph app-only per Client-Assertion mit dem Tenant-Zertifikat; Onboarding und
  🔧 Reparieren vergeben dafür die Graph-Permissions
  `DeviceManagementConfiguration.ReadWrite.All` + `Group.Read.All`.

### ✂️ Preset-Dropdown entfernt

Es gibt jetzt genau **eine** Best-Practice-Konfiguration (die geladenen
Defaults) statt vier wählbarer Presets — das Dropdown im Header ist weg.
Abweichungen für Einzelfälle weiterhin direkt über die Einstellungen im
Konfigurations-Tab; eigene Varianten lassen sich über Export/Import (JSON)
sichern und wiederverwenden.

## Version 2.1 - Quarantäne-Fixes + Live-Deploy (2026-07-15)

### 🐛 Fixes

#### Dateitypen ohne führenden Punkt (".."-Bug)
- **Problem**: Der Generator übergab Dateitypen mit führendem Punkt (`.exe`) an `-FileTypes`.
  M365 speichert den Wert roh und die GUI hängt selbst einen Punkt davor → `..exe` im Tenant.
- **Fix**: Führende Punkte (auch versehentliche `..exe`-Eingaben) und leere Einträge werden
  beim Generieren entfernt; das Skript enthält jetzt `@('ace', 'apk', …)`.

#### Spam/Bulk/Spoof in Quarantäne statt Junk-Ordner
- `SpamAction`, `HighConfidenceSpamAction`, `BulkSpamAction` und `AuthenticationFailAction`
  (Spoof) stehen jetzt standardmäßig auf `Quarantine` (Default, Presets "example"/"balanced", UI-Dropdowns).
- Neue Quarantine-Tags: `SpamQuarantineTag`, `HighConfidenceSpamQuarantineTag`, `BulkQuarantineTag`
  → `BP_Quarantine-SelfReleaseNotification`.
- Preset "relaxed" bleibt bewusst auf `MoveToJmf`.

#### Quarantine Policies korrigiert (waren ungültig konfiguriert)
- **Problem**: `EndUserQuarantinePermissionsValue 236/171` setzte u.a. RequestRelease UND Release
  gleichzeitig — laut Microsoft-Doku unzulässig; der Tenant-Zustand passte nicht zur Absicht.
- **Fix** (entspricht Referenz-Tenant vom 2026-07-10):
  - `BP_Quarantine-SelfReleaseNotification` = **59** (AllowSender+BlockSender+RequestRelease+Preview+Delete),
    ESN aktiv **inkl.** Nachrichten von blockierten Absendern
  - `BP_Quarantine-RequestReleaseNotification` = **26** (BlockSender+RequestRelease+Preview),
    ESN aktiv **ohne** Nachrichten von blockierten Absendern
  - Bestehende Policies werden per `Set-QuarantinePolicy` aktualisiert statt übersprungen.

### 🚀 Neu: Live-Deploy (Tab "🚀 Live-Deploy")

- Policies direkt aus dem Tool in den Tenant deployen — ohne manuelles PowerShell.
- **Backend** (`api/`, eigener Container): Node + PowerShell 7 + ExchangeOnlineManagement.
- **Onboarding per Device-Code**: legt automatisch App-Registrierung `M365-Security-Policy-Manager`
  mit `Exchange.ManageAsApp`, Exchange-Administrator-Rolle und self-signed Zertifikat an.
- **Deploy**: app-only `Connect-ExchangeOnline` mit Zertifikat, setzt alle BP_-Policies idempotent,
  Schritt-für-Schritt-Ergebnis in der UI.
- **Alert Policy als geführter manueller Schritt**: Security & Compliance PowerShell
  (`Connect-IPPSSession`) ist laut Microsoft-Doku auf Linux nicht verfügbar — der
  Backend-Container kann den Schritt nicht ausführen. Das Deploy-Ergebnis zeigt ihn
  als 📋-Schritt mit fertigem Copy-Paste-Snippet (einmalig pro Tenant auf Windows;
  `-AggregationType None` → kein E5 nötig). Das Onboarding vergibt die
  Compliance-Administrator-Rolle weiterhin (für einen späteren Windows-Worker).
- **🔎 Ist-Zustand-Prüfung**: Pro Tenant liest ein Audit die BP_-Policies live aus dem
  Tenant und zeigt einen Soll/Ist-Vergleich gegen die aktuelle Konfiguration —
  35+ Checks inkl. Quarantine-Permissions, Aktionen, Tags, erweiterten Spam-Filtern,
  Dateityp-Diff und Rule-Domains.
- **🔧 Permission-Fixer**: Repariert bestehende App-Registrierungen gezielt
  (Exchange.ManageAsApp, Admin-Consent, Exchange-Admin- + Compliance-Rolle,
  Zertifikat-Hinterlegung an der App) per Device-Code-Login — ohne das Zertifikat
  zu rotieren wie beim Neu-Onboarding. Aktualisiert die Status-Badges.
- nginx proxied `/api/` an den Backend-Container; ohne Backend zeigt der Tab einen Hinweis.
- **Live-Fortschritt**: Deploys laufen als Job — die UI zeigt in Echtzeit Phase, Schritt-Status
  (läuft/Retry/fertig/fehlgeschlagen), Fortschrittsbalken und Dauer. Vor dem Start fasst ein
  Panel zusammen, was angewendet wird (Domains, Aktionen, Dateitypen, Alert-Empfänger).
  Onboarding zeigt eine Einrichtungs-Checkliste (App, Consent, Rollen, Zertifikat).

## Version 2.0 - Enhanced Edition (2026-02-12)

### 🎯 Major Changes

#### AppRiver References Removed
- **Removed**: All references to AppRiver comparisons
- **Removed**: "Delta-Analyse" tab
- **Added**: "Best Practices & Empfehlungen" tab
- **Rationale**: Focus exclusively on M365 best practices without external product comparisons

#### Preset Templates
Added three professionally configured presets:

1. **⚖️ Ausgewogen (Empfohlen)** - Balanced
   - Bulk Threshold: 7
   - Spam → Junk, High Confidence → Junk
   - Phishing → Quarantine
   - Standard file types list

2. **🔒 Streng (Maximum Security)** - Strict
   - Bulk Threshold: 5
   - All spam levels → Quarantine
   - Extended file types (includes .docm, .xlsm, .pptm)
   - Spoof action → Quarantine

3. **🔓 Locker (Weniger False Positives)** - Relaxed
   - Bulk Threshold: 8
   - Reduced heuristic checks
   - Minimal file types list
   - More permissive actions

#### JSON Import/Export
- **Export**: Save current configuration as JSON
- **Import**: Load previously saved configurations
- **Use Cases**: Multi-tenant deployment, backup, version control

#### Enhanced PowerShell Generation
- Proper file types array handling
- Documentation header with metadata
- Better error handling
- Clearer structure and comments

#### Best Practices Tab
New comprehensive guidance section:
- Licensing comparison (EOP vs Defender P1 vs P2)
- Hardening recommendations without license upgrades
- Operational best practices (monitoring, maintenance)
- Quick wins visual cards
- Common pitfalls warnings
- Protection coverage matrix
- Links to Microsoft documentation

### 🛠️ Technical Improvements

#### Complete app.js Rewrite
- Modular function structure
- Preset template system
- Import/export handlers
- Improved config state management
- Better UI synchronization

#### Enhanced CSS
- Preset selector styling
- Quick wins grid layout
- Improved responsive design
- Better table formatting

#### HTML Updates
- Preset selector dropdown
- Import button
- Best Practices tab structure
- Improved semantic markup

### 📋 Files Modified

| File | Changes |
|------|---------|
| `index.html` | Added preset selector, import button, Best Practices tab |
| `app.js` | Complete rewrite with presets, import/export, improved generation |
| `styles.css` | Added preset selector, quick wins grid, enhanced tables |
| `README.md` | Updated to reflect new features |
| `QUICKSTART.md` | Added preset usage instructions |
| `walkthrough.md` | Comprehensive documentation of all features |

### 🎓 Documentation Enhancements

#### New Sections in Best Practices Tab
1. **Lizenz-Überlegungen**: Feature comparison across license tiers
2. **Härtungs-Empfehlungen**: Security improvements without upgrades
3. **Operational Best Practices**: Monitoring and maintenance schedules
4. **Quick Wins**: Visual cards for activated features
5. **Häufige Fehler vermeiden**: Common configuration mistakes
6. **Schutzumfang-Übersicht**: Threat protection matrix
7. **Weiterführende Ressourcen**: Links to Microsoft docs

### 🚀 Usage Improvements

#### Faster Configuration
- Select preset → Instant configuration
- Import JSON → Restore previous config
- No manual entry for standard scenarios

#### Better Portability
- Export JSON for backup
- Share configurations across teams
- Version control friendly

#### Enhanced Deployment
- Better PowerShell script structure
- Proper array handling for file types
- Documentation headers with metadata

### 🔍 Quality Improvements

#### Code Quality
- Modular JavaScript functions
- Clear separation of concerns
- Better error handling
- Consistent naming conventions

#### User Experience
- Clearer navigation
- Visual feedback for actions
- Comprehensive help text
- Professional design

#### Documentation
- Detailed walkthrough
- Usage examples
- Best practices guide
- Troubleshooting tips

### 📊 Metrics

- **Lines of Code**: ~1000 (app.js)
- **Preset Templates**: 3
- **Policy Types**: 4 (Quarantine, Anti-Phishing, Anti-Spam, Anti-Malware)
- **Configuration Options**: 30+
- **Documentation Sections**: 7 (Best Practices tab)

### 🎯 Migration from v1.0

No breaking changes - existing workflows continue to work:
1. Open tool
2. Configure settings
3. Export PowerShell
4. Deploy

New workflows available:
1. Select preset → Export → Deploy
2. Import JSON → Customize → Export → Deploy
3. Review Best Practices → Configure → Deploy

### 🔮 Future Enhancements (Potential)

- [ ] Direct M365 API integration for deployment
- [ ] Configuration comparison mode
- [ ] Policy drift detection
- [ ] Multi-language support
- [ ] Dark mode theme
- [ ] Export to other formats (ARM templates, Terraform)

### 🙏 Acknowledgments

- Microsoft 365 Security Team for EOP documentation
- Community feedback on best practices
- igeeks team for real-world deployment experience

---

**Version**: 2.0  
**Release Date**: 2026-02-12  
**Status**: Production Ready  
**Breaking Changes**: None
