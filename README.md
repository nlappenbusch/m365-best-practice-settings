# M365 Control Plane

Tenant-zentrische Microsoft-365 Operations- und Assurance-Plattform für MSPs.

Der Control Plane verbindet **Baseline / Desired State**, den tatsächlichen
Tenant-Zustand, Audit- und Change-Daten, Security-Findings, Evidence,
Dokumentation und Automationen in einer Oberfläche.

## Kernbereiche

- **Overview** — Tenant Health, Security, Changes, Evidence und Jobs
- **Changes / Evidence 3.0** — deduplizierter Event-Store, Resource-Historie,
  Baseline-Korrelation, Impact und Remediation-Plan
- **Risks** — gemeinsame Queue aus Maester-Findings und kritischen Changes
- **Evidence** — revisionsnahe Roh-Nachweise aus Entra, Intune, Unified Audit Log,
  Konten, Enterprise Apps und Service Health
- **Security Audit** — Maester / CIS / CISA SCuBA / EIDSCA / ORCA
- **Automations** — bestehende lokale Graph-/PowerShell-Jobs plus optional
  Semaphore UI als Runner für PowerShell, Terraform und OpenTofu
- **Tenant Operations** — Conditional Access, Mail Security, Intune, Autopilot,
  Apps, Remediations, Zuweisungen, Migration und Dokumentation

## Evidence 3.0

Das bestehende JSON-Evidence-Archiv bleibt der unveränderte Roh-Nachweis.
Darüber liegt ein operativer, deduplizierter Store:

```text
Microsoft Audit / Tenant State
          |
          v
Raw Evidence Archive
          |
          v
Evidence 3.0
  +-- deterministic event IDs / dedup
  +-- resource snapshots + history
  +-- baseline version + findings
  +-- impact / affected users
  +-- decision / change reference
  +-- remediation proposal
          |
          +--> Overview
          +--> Changes
          +--> Risk Queue
          +--> Reports / AI
```

Bestehende Change-Archive werden beim ersten Evidence-3.0-Aufruf automatisch
lokal backfilled und dedupliziert.

## Execution

Die vorhandene lokale Execution bleibt der Default. Semaphore ist optional:

```text
SEMAPHORE_URL=https://semaphore.example.ch
SEMAPHORE_PROJECT_ID=1
SEMAPHORE_API_TOKEN=<secret>
```

Secrets bleiben ausschliesslich im Backend.

## Entwicklung

Frontend:

```bash
cd frontend
npm ci
npm run build
```

Backend-Syntax:

```bash
node --check api/server.js
node --check api/lib/evidenceStore.js
node --check api/lib/evidenceAnalyze.js
node --check api/lib/execution.js
```

## Deployment

Das neue Produktrepo deployt **nicht automatisch** bei einem Push auf `main`.
Der Workflow ist zunächst nur manuell startbar, damit die bestehende
m365.nerdag.ch-Installation nicht überschrieben wird.

Vorgesehener separater Hostpfad:

```text
/opt/m365-control-plane
```

## Architektur

Siehe [docs/PRODUCT-REWORK.md](docs/PRODUCT-REWORK.md).

© 2026
