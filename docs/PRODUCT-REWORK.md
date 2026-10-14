# M365 Control Plane — Product Rework

Branch: `product-rework`

This branch turns the existing internal M365 Security Policy Manager into a more
product-oriented MSP operations and assurance surface without rewriting the
working Microsoft 365 domain logic.

## Product model

The new shell separates five concerns:

1. **Desired State** — baseline, naming, policies and standards.
2. **Observed State** — current tenant configuration and snapshots.
3. **Events** — Entra/Intune/Unified Audit Log changes.
4. **Risk & Assurance** — Maester findings, evidence and reports.
5. **Execution** — local Graph/PowerShell today, optional Semaphore runners for
   PowerShell/Terraform/OpenTofu.

The product-facing flow is:

```text
M365 Control Plane
        |
        +-- Overview
        +-- Changes -------- Evidence archive
        +-- Risks ---------- Maester + Change triage
        +-- Automations ---- Execution adapter
                                  |
                    +-------------+-------------+
                    |                           |
                 local                       Semaphore
                    |                           |
             Graph / PowerShell        PowerShell / Terraform
                    |                           |
                    +-------------+-------------+
                                  |
                              M365 tenant
                                  |
                               Evidence
```

## What stays unchanged

The rework deliberately preserves the existing specialist modules and business
logic: tenant onboarding, Graph access, Exchange Online PowerShell, Intune/OIB,
Conditional Access, Mail Security, Maester, Evidence, reports, backups and
restores.

The new views consume those existing APIs instead of replacing them.

## Change Intelligence

`Changes` reads the latest archived Evidence change log and adds conservative
triage on top. It never claims a compliance violation merely from a heuristic.
The current risk scoring is a presentation-layer attention score until a
server-side baseline correlation engine is introduced.

Examples that are prioritised:

- Conditional Access changes
- privileged role changes
- application consent / OAuth permission changes
- authentication method changes
- delete/remove operations
- Intune assignment/configuration changes

The original Evidence entry remains the source of truth.

## Execution adapter

`api/lib/execution.js` is an optional adapter for Semaphore UI.

Without Semaphore configuration the existing local execution path remains the
default and all existing functions continue to work.

Configuration:

```text
SEMAPHORE_URL=https://semaphore.example.ch
SEMAPHORE_PROJECT_ID=1
SEMAPHORE_API_TOKEN=<secret>
```

The API token is backend-only.

When a Semaphore template is started, the Control Plane sends one JSON envelope
as the task message. Shell, PowerShell and Python templates can consume the
message from:

```text
SEMAPHORE_TASK_DETAILS_MESSAGE
```

Envelope example:

```json
{
  "version": 1,
  "source": "m365-control-plane",
  "action": "terraform-plan",
  "tenantId": "customer-record-id",
  "tenantName": "Customer AG",
  "organization": "customer.onmicrosoft.com",
  "payload": {},
  "requestedBy": "sso:admin@example.com",
  "requestedAt": "2026-10-05T10:00:00.000Z"
}
```

The template owns the concrete PowerShell/Terraform implementation. The product
owns authorisation, tenant context, presentation and evidence.

## Read-only tenants

The existing Prüfmandat protections remain in place. The external execution
route additionally blocks write-like actions for read-only tenants. Only
explicit read/plan actions such as Evidence, Maester and Terraform Plan may be
sent through the external adapter.

## Next technical steps

The branch establishes the product shell and execution seam. The next useful
backend steps are:

- persist job history instead of keeping only the current in-memory appJobs;
- normalise Evidence into a durable event/snapshot model;
- correlate change events with baseline rules;
- add ticket/change-request correlation;
- archive execution results next to Microsoft Evidence;
- optionally route selected existing PowerShell/Maester jobs through the
  execution adapter after the local path has proven stable.

Do not move all existing jobs to Semaphore in one migration. Use a strangler
approach: one job type at a time, with the local implementation remaining the
fallback until the external path is proven.
