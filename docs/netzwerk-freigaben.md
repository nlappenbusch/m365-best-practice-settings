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

## Build-Zeit (CI-Runner, nicht der laufende Pod)

| Ziel | Wofür | Job |
|---|---|---|
| `gcr.io` | Kaniko-Executor-Image | build-website, build-api |
| `registry.igeeks.ch` | Ziel-Registry für die gebauten Images | build-* , deploy-prod |
| `packages.microsoft.com` | PowerShell 7 via apt im api-Image | build-api |
| PowerShell Gallery (`psg-prod-*.azureedge.net`, `www.powershellgallery.com`) | `ExchangeOnlineManagement` | build-api |
| `registry.npmjs.org` | `npm ci` für Frontend und API | build-* |
| Docker Hub (`registry-1.docker.io`, `auth.docker.io`) | Basis-Images `node`, `alpine/git` | build-*, deploy-prod |

**Nicht mehr nötig:** `dl-cdn.alpinelinux.org` (Alpine-Paketrepository). Der
`deploy-prod`-Job installierte sich früher `git` per `apk add` und scheiterte
daran — der Runner erreicht diesen CDN nicht. Seit 25.08.2026 nutzt der Job ein
Image mit vorinstalliertem git und braucht keinen Paket-CDN mehr.

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

## Egress im Cluster ist selektiv (Stand 2026-08-25)

Der Cluster `igeeks-k8s-201` erreicht manche Ziele, andere nicht — und zwar nicht
zufällig, sondern reproduzierbar:

| | |
|---|---|
| erreichbar | Let's Encrypt, gcr.io, Docker Hub, registry.igeeks.ch |
| **nicht** erreichbar | `dl-cdn.alpinelinux.org` (zweimal reproduziert, Job 1077 + 1078) |
| war nicht erreichbar, inzwischen freigegeben | die Microsoft-Endpunkte (19.08.2026, Timeout beim Verbindungsaufbau) |

Das Muster ist immer dasselbe: kein DNS-Fehler, kein «connection refused», sondern
Timeout — also eine Firewall- oder Routing-Regel, keine Namensauflösung. Die
Microsoft-Freigabe hat den Egress nicht generell geöffnet. Wer hier aufräumt, sollte
das Cluster-Netz als Ganzes betrachten und nicht Ziel für Ziel freischalten.

Im Tool lässt sich der Zustand jederzeit prüfen: **Diagnose → Test starten**.
