# Netzwerk-Freigaben (Egress)

Welche Gegenstellen der **api**-Container erreichen muss, damit das Tool funktioniert.
Alles ausgehend über **443/tcp**, sofern nicht anders vermerkt.

Stand: 2026-08-19. Die Liste ist aus dem Code hergeleitet (`api/server.js`, `api/lib/*.js`),
nicht geraten — pro Eintrag ist die Fundstelle angegeben.

## Zwingend — ohne diese Ziele startet nichts

| Ziel | Wofür | Fundstelle |
|---|---|---|
| `login.microsoftonline.com` | Device-Code-Onboarding, App-only-Token für Graph und Exchange, SSO-Login ins Tool selbst | `server.js` (Device-Code), `lib/graph.js`, `lib/sso.js` |
| `graph.microsoft.com` | Tenants, Conditional Access, Intune, Autopilot, Lizenzen, Gruppen, Mappings — v1.0 und beta | `server.js:66`, `lib/graph.js:13-14` |
| `outlook.office365.com` | Exchange Online PowerShell (`Connect-ExchangeOnline`) — Mail-Security-Deploy und Audit | `lib/exorunner.js` |
| **DNS (53/udp+tcp)** nach aussen | SPF-, DKIM- und DMARC-Prüfung liest öffentliche TXT-/CNAME-Records direkt per Resolver | `lib/domainAuth.js:15` |

Ohne die ersten drei sind Onboarding, Mail-Security, Conditional Access, Intune und
Autopilot komplett tot. Ohne DNS-Auflösung nach aussen fehlt nur der Domain-Auth-Teil
des Audits.

## Funktionsabhängig — nur wenn der jeweilige Bereich genutzt wird

| Ziel | Wofür | Fundstelle |
|---|---|---|
| `*.blob.core.windows.net` | Intune-Win32-App-Upload. Die SAS-URI kommt von Graph, das Hochladen geht direkt an Azure Blob Storage | `lib/win32app.js:82-102` |
| `raw.githubusercontent.com`, `api.github.com` | Import der OpenIntuneBaseline-Policies (Repo `SkipToTheEndpoint/OpenIntuneBaseline`) | `lib/oibImport.js:23-24` |
| `cloudgz.gravityzone.bitdefender.com` | Bitdefender-Agents: Paketliste und Download. Überschreibbar per `BD_HOST` | `lib/bitdefender.js:16` |
| `dashboardeurope1.systemmonitor.eu.com`, `wwweurope1.systemmonitor.eu.com`, `www.systemmonitor.eu.com` | N-sight RMM: Kunden/Sites lesen, Agent-Download. Fester Server per `RMM_SERVER`, sonst werden die drei der Reihe nach probiert | `lib/nsight.js:25-29` |
| `sdp.igeeks.ch` | ServiceDesk-Plus-Tickets (Tickets-Bereich). Überschreibbar per `SDP_BASE_URL` | `lib/sdp.js:16` |
| `api.anthropic.com` | KI-Vorschläge im Tool | `lib/aiSuggest.js:15` |

Der Bitdefender-Download folgt Redirects (`redirect: "follow"`). Zeigt GravityZone auf ein
CDN, muss das Redirect-Ziel ebenfalls erreichbar sein.

## Nicht nötig — bewusst nicht in der Liste

- **`*.sharepoint.com`** — SharePoint-Laufwerke werden über Graph gelesen, nicht direkt
  angesprochen (`lib/sharepointMapping.js:123`).
- **`schneegans.de`** — steht nur als XML-Namespace in der generierten `autounattend.xml`
  (`lib/autopilot.js:70`). Namespaces werden nicht aufgelöst, es gibt keinen Netzaufruf.
- **`learn.microsoft.com`, `tech.nicolonsky.ch`, `intunedrivemapping.azurewebsites.net`** —
  reine Quellenangaben in Kommentaren und Doku-Texten.

## Build-Zeit (nur CI-Runner, nicht der laufende Pod)

Der Kaniko-Build zieht: `packages.microsoft.com` (PowerShell 7 via apt),
PowerShell Gallery (`ExchangeOnlineManagement`), die npm-Registry und
`registry.igeeks.ch`. Betrifft den Runner, nicht `igeeks-prod`.

## Prüfen

Im Tool: **Diagnose → Test starten** prüft die drei zwingenden Microsoft-Ziele aus dem
laufenden Container heraus und zeigt bei Fehlschlag den Netzcode (`ENOTFOUND`,
`ECONNREFUSED`, Timeout).

Von aussen, im richtigen Namespace:

```
kubectl -n igeeks-prod run egresstest --rm -it --image=curlimages/curl --restart=Never \
  --command -- curl -sS -m 8 -o /dev/null -w "%{http_code}\n" \
  https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration
```

## Bekanntes Problem (Stand 2026-08-19)

Im Cluster `igeeks-k8s-201` laufen alle Microsoft-Ziele in einen Timeout, während anderer
Egress funktioniert (Let's Encrypt antwortet). Kein DNS-Fehler, kein «connection refused»,
sondern Timeout beim Verbindungsaufbau — deutet auf eine Firewall- oder Routing-Regel für
Microsoft-Ziele aus dem Cluster-Netz. Damit sind Onboarding und alle Deploy-Funktionen in
`igeeks-prod` unbenutzbar.
