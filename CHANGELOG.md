# M365 Best Practice Settings Tool - Changelog

## Version 2.20 - Baseline vollstaendig (2026-09-01)

Die Baseline (2.19) hatte die Agent-Module, das Custom-App-Grundgeruest, OIB,
Onboarding, Mail-Haertung und die Entscheidungsregeln. Alles Weitere stand nur
als Prosa in den Wissensseiten — und driftete damit weiter. Jetzt vollstaendig,
Baseline **1.1**:

| Neu in der Quelle | Was drinsteht |
|---|---|
| **Mail-Security** | Kategorie-Aktionen (Spam/Bulk/Phishing/Malware), das komplette Objektset mit Sollwerten, die 47 blockierten Dateitypen, Haertungsregeln, Lizenz-Matrix, SPF/DKIM/DMARC |
| **Autopilot** | GroupTag-Kette, Einmal-Setup je Tenant, Feld-Runbook fuer Techniker, Stolpersteine, Sicherheitshinweis zum Staging-Paket |
| **Conditional Access** | Ringe mit aufgeloesten Gruppennamen, die vier Schutzgruppen, Ausbaustufen nach Lizenz, die Report-only-Regel |
| **Mappings** | Drive gegen Printer im Vergleich, die Store-App-Abweichung, Cloud Kerberos Trust — und die Nesting-Falle |
| **Remediations** | Lizenz-Schalter als Voraussetzung, Aufbau, Deploy-Regeln, Abgrenzung zu Pre-/Post-Install-Skripten |
| **Intune-Backup** | was gesichert wird, was bewusst nicht, die drei Nie-Regeln beim Restore |

Wie bei den Agents rechnet die Baseline auch hier die **Namen** aus: Die
CA-Schutzgruppen und Ring-Gruppen tragen in der Quelle nur den
Muster-Schluessel, ausgeliefert wird der Name nach der Konvention des Tenants.

Die Wissensseiten erklaeren weiterhin das Warum — mit einem Satz darueber, wo
die verbindlichen Werte stehen: *Wo beides auseinandergeht, gilt die Baseline.*


## Version 2.19 - Baseline als eine Quelle (2026-09-01)

### 📐 Die Betriebsrichtlinien liegen jetzt an einer Stelle

Dieselben Regeln standen an drei Orten: als Prosa in den Wissensseiten, als
Werte im Code und nochmal im Konzeptdokument. Das driftet auseinander — zuletzt
beschrieb die Dokumentation den Bitwarden-Weg falsch, waehrend das Werkzeug es
laengst besser konnte.

Neu: `api/baseline/baseline.json` ist die Quelle. Darin stehen die
Agent-Module (RMM, Bitdefender, Bitwarden, FortiClient) mit allen
PMP-Feldwerten und Erkennungsregeln, das Grundgeruest fuer Custom Apps samt
Rueckgabecodes, das CIS-Delta und die Break-Risk-Liste, die
Onboarding-Checkliste, die Mail-Haertung ohne `BP_`-Objekt und die
Entscheidungsregeln (Tier, Cloud Kerberos Trust).

**Das Namensschema wird bewusst NICHT dupliziert** — es kommt beim Ausliefern
live aus `lib/naming.js` dazu. Sonst gaebe es zwei Wahrheiten ueber Namen. Die
Agent-Eintraege tragen nur den Muster-Schluessel; den fertigen Gruppennamen
rechnet die Baseline aus, damit ihn niemand abtippt.

**Schreibgeschuetzt, mit Absicht:** Die Datei liegt im Git, Aenderungen laufen
ueber einen Commit mit Review — nicht ueber einen Klick in der Oberflaeche. Eine
Betriebsrichtlinie, die sich zur Laufzeit aendern laesst, ist keine.

### Drei Wege zur selben Quelle

| Weg | Wofuer |
|---|---|
| Wissensseite **Baseline** (Tab Wissen) | die Sollwerte im Werkzeug nachschlagen — inkl. der Zielgruppennamen, wie sie in DIESEM Tenant heissen |
| `GET /api/baseline/export.html` | eigenstaendiges Dokument zum Weitergeben, Drucken, Archivieren |
| `GET /api/mcp/v1/baseline` (+ `/search`, `/agents/:key`) | damit eine KI «gemaess Baseline vX.Y» beraet, statt sich Regeln auszudenken |

Gerendert wird an einer Stelle (`lib/baselineDoc.js`) — Wissensseite und Export
zeigen deshalb dasselbe. Die Suche liefert Treffer mit Pfad
(`oib.breakRisk[2]`), damit eine Antwort zitierfaehig bleibt.

Die MCP-Endpunkte brauchen bewusst keine Tenant-Freigabe: Hier stehen
Richtlinien, keine Kundendaten.


## Version 2.18 - Namenskonvention einstellbar, Edge-Erweiterungen erzwingen (2026-09-01)

### 🏷️ Eine Stelle fuer alle Objektnamen

Wie die angelegten Objekte heissen, stand bisher als Literal in dem Modul, das
sie brauchte — `"AAD-" + tag` in groupTags, `"AAD-CA-RING-"` in
conditionalAccess, `"WIN - DriveMapping - "` in driveMapping. Ein Schemawechsel
hiess: alle Stellen suchen und hoffen, keine zu vergessen. Das liegt jetzt in
`api/lib/naming.js`.

Zwei mitgelieferte Profile, dazu frei editierbare Muster:

| | Geraetegruppe | App-Zielgruppe | CA-Ring | Break-Glass |
|---|---|---|---|---|
| **Bestand** (Vorgabe) | `AAD-WIN-Std` | `AAD-APP-Bitdefender` | `AAD-CA-RING-PILOT` | `breakglass-01` |
| **v2** | `T2-DG-WIN-Std` | `T2-DG-WIN-AppBitdefender` | `T0-CSG-GOV-CA-RingPilot` | `brk.notfall01` |

**Global als Vorgabe, pro Tenant ueberschreibbar.** Das ist der Punkt: Ein neu
onboardeter Kunde kann auf v2 laufen, waehrend Bestandskunden ihre gewachsenen
Namen behalten.

**Bestehende Objekte werden nie umbenannt.** Gesucht wird ueber ALLE bekannten
Muster (`candidates()`), nicht nur ueber das aktive — sonst wuerde das Werkzeug
nach einem Wechsel neben der vorhandenen Gruppe eine zweite anlegen. Bei einer
leeren Break-Glass-Ausnahmegruppe waere das gefaehrlich.

Neuer Tab **Namenskonvention** (Einrichtung): Grundprofil waehlen, einzelne
Muster ueberschreiben, Live-Vorschau je Objekttyp, Uebersicht welcher Tenant
welcher Konvention folgt.

Umgestellt sind: Geraetegruppen (GroupTags), App-Zielgruppen, CA-Ring- und
-Schutzgruppen, Break-Glass-Konten, die vier Mapping-/Skript-Module und die
Profile der Browser-Erweiterungen. Der `BP_`-Marker der EOP-Objekte bleibt —
er ist mit Anish noch offen.

### 🧩 Erzwungene Browser-Erweiterungen (Edge)

Die letzte Handarbeit im Passwortmanager-Rollout: Desktop-App und Server-Region
kann das Werkzeug laengst, die Erweiterung selbst musste jemand im Portal
erzwingen. Neuer Tab **Browser-Erweiterungen** (Intune) legt dafuer ein
Custom-Konfigurationsprofil an — OMA-URI auf die Edge-Richtlinie
`ExtensionInstallForcelist`.

Bewusst OMA-URI statt Settings Catalog: Die Edge-Richtlinien sind dort zwar
vorhanden, ihre Definition-Ids sind aber lang, versionsabhaengig und muessten
zur Laufzeit gesucht werden. Der OMA-URI-Pfad ist stabil; im Portal sieht das
Profil gleich aus und laesst sich dort weiterpflegen.

**Zuweisung geht an die Geraetegruppe, nicht an eine App-Zielgruppe.** Intune
loest verschachtelte Gruppen nur beim App-Assignment auf — bei
Konfigurationsprofilen nicht. Dieselbe Falle wie beim Region-Skript.

Chrome und Firefox brauchen eine ADMX-Ingestion (Datei muss erst in den Tenant
hochgeladen werden). Anderer Mechanismus, hier bewusst nicht mit drin.

### Oberflaeche zieht mit

Die Oberflaeche zeigte an rund 50 Stellen fest verdrahtete Objektnamen — bei
einem Tenant auf v2 haette dort gestanden, was das Werkzeug gar nicht anlegt.
Jetzt kommen sie aus der Konvention:

| Wo | Was |
|---|---|
| Mappings (alle vier Bereiche) | Bestaetigungstexte und Vorschau zeigen den echten Skript-/Profilnamen |
| Conditional Access | Ring- und Break-Glass-Gruppennamen in Dialogen, Bannern und Tooltips |
| App-Deploy-Dialog | Zielgruppe und Region-Skript |
| GroupTags | Gruppennamen-Platzhalter; App-Gruppen-Schema neu mit Option **nach Konvention** (Vorgabe) |
| Wissen | Namensgenerator erzeugt Namen nach der eingestellten Konvention; Schema-Tabelle zeigt Bestand und v2 nebeneinander |

Zwei Punkte, die dabei aufgefallen sind und mitkorrigiert wurden: Der
Namensgenerator im Wissen-Tab nimmt bei Geraetegruppen jetzt den **GroupTag**
als Eingabe (im Bestand `DEV-STD`, in v2 `WIN-Std`) — die Kategorie steckt im
Tag, nicht im Praefix, und andersherum gerechnet waere es fehleranfaellig.
Dazu kennt die Konvention zwei weitere Gruppenarten: `mamGroup`
(`AAD-USR-*` / `T2-CSG-GOV-MAM-*`) und `roleGroup`
(`AAD-ROLE-*` / `T2-CSG-ADM-ENTRA-*`).

### Technisch

| Datei | Was |
|---|---|
| `api/lib/naming.js` | Profile, Muster-Rendering, wirksame Konvention, `candidates()` fuer die Suche |
| `api/lib/browserExtensions.js` | Edge-Forcelist als Custom-Profil, Katalog, Validierung |
| `api/server.js` | `/api/naming`, `/api/tenants/:id/naming`, `/api/browserext/*` |
| `api/lib/{groupTags,appGroups,conditionalAccess,driveMapping,printerMapping,registryPolicy,sharepointMapping}.js` | Namen kommen aus der Konvention, Suche ueber alle Muster |
| `frontend/src/tabs/{Naming,BrowserExtensions}.svelte` | die beiden neuen Bereiche |
| `frontend/src/lib/naming.js` | dieselbe Rendering-Logik fuer Vorschauen in der Oberflaeche |


## Version 2.17 - App-Zielgruppen anlegen und verknuepfen (2026-09-01)

### 🎯 Zuweisungsstruktur ohne Portal

Der Tab *GroupTags* hat einen neuen Bereich **App-Zielgruppen**. Er nimmt die
Arbeit ab, fuer die man sonst ins Entra-Portal wechselt: Gruppe nach Schema
anlegen, die richtigen GroupTag-Geraetegruppen hineinnesten — idempotent, eine
vorhandene Gruppe wird wiederverwendet statt gedoppelt.

Hintergrund: Eine App wird immer an **genau eine** Gruppe zugewiesen. Welche
Geraete sie bekommen, steuert das Nesting — die dynamische Geraetegruppe wird
Mitglied der App-Gruppe, Intune loest das beim App-Assignment auf. Damit laesst
sich die komplette Zielgruppen-Vorbereitung im Tool erledigen, auch fuer Apps,
die spaeter ueber Patch My PC installiert werden.

| Die Ansicht zeigt | Wozu |
|---|---|
| alle App-Zielgruppen (`AAD-APP-`, `AAD-PMP-`, `T2-DG-WIN-App`, `T2-DG-WIN-Pmp`) | Bestandsaufnahme, auch von Hand angelegte Gruppen |
| verknuepfte Geraetegruppen als Chips, mit ✕ zum Loesen | das Nesting ist die eigentliche Steuerung |
| welche **Intune-App** auf der Gruppe haengt, mit Intent | Nachweis, dass die Zuweisung in Patch My PC angekommen ist |
| Warnung «erreicht so kein Geraet» bei leerer Gruppe | der haeufigste stille Fehler |

Anlegen ueber Presets (Bitdefender, RMM-Agent, Bitwarden, FortiClient) oder mit
freiem App-Namen; dazu Verwaltung (selbst paketiert / Patch My PC) und
Namensschema. Der fertige Gruppenname steht als Vorschau da, ein bereits
existierender wird als solcher gemeldet. Zur Auswahl stehen nur Geraetegruppen
mit `[OrderID]`-Tag — andere haben als Mitglied keinen Zweck. Jede schreibende
Aktion fragt vorher nach und nennt den Tenant beim Namen.

**Namensschema als Umschalter:** Voreingestellt bleibt der Bestand
(`AAD-APP-…`), das v2-Schema (`T2-DG-WIN-App…`) steht als zweite Option bereit.
Bewusst kein stiller Wechsel — solange die v2 nicht freigegeben ist, wuerde er
in Kundentenants nur Dubletten erzeugen.

**Grenze:** Das Tool bereitet die Zielgruppe vor. Die Zuweisung der App selbst
bleibt in Patch My PC — dort gegen diese eine Gruppe, Intent *Required*.

### Technisch

| Datei | Was |
|---|---|
| `api/lib/appGroups.js` | Schema-Bau (`buildAppGroupName`), Liste mit Mitgliedern und App-Zuweisungen, Entkoppeln; beide Zugangswege (Zertifikat und Token) wie im GroupTag-Modul |
| `api/lib/groupTags.js` | `accessReq`/`accessAllPages` exportiert, statt sie im App-Gruppen-Modul zu verdoppeln |
| `api/server.js` | `POST /api/appgroups/list`, `/ensure`, `/unnest` |
| `frontend/src/tabs/GroupTags.svelte` | Bereich «App-Zielgruppen» |


## Version 2.16 - Geheimnisse bearbeiten, Organisationsschalter auch im Backend (2026-09-01)

### ✏️ Bearbeiten im Panel — geschrieben wird erst beim Speichern

Der Tab *Geheimnisse* kann jetzt auch ändern. Der Entwurf lebt bis dahin nur im
Eingabefeld: **Abbrechen verwirft ihn ersatzlos, geschrieben wird ausschliesslich
beim ausdrücklichen «Speichern»** — mit Bestätigungsdialog und Eintrag im
Audit-Log.

Änderbar sind die Werte, die im Zustand oder als Datei liegen:

| Eintrag | Prüfung | Nebenwirkung |
|---|---|---|
| SSO-Clientgeheimnis | nicht leer | bis zum Eintragen des neuen Werts schlägt die SSO-Anmeldung fehl |
| Sitzungsgeheimnis | mindestens 16 Zeichen | meldet **alle** offenen Sitzungen ab, auch die eigene |
| Zertifikat je Tenant | PEM-Block muss vorhanden sein | vorheriger Stand wird als `.bak` daneben gelegt |

**Umgebungsvariablen sind bewusst nicht änderbar.** Sie kommen aus der Umgebung
des Containers (GitHub-Secret bzw. Compose); ein zur Laufzeit gesetzter Wert wäre
beim nächsten Neustart weg. Das Panel bietet es deshalb gar nicht erst an und
schreibt den Grund dazu, statt eine Änderung vorzutäuschen, die nicht hält.

### 📤 Organisationsschalter jetzt auch als Rückfallwert

Ergänzung zu 2.15: Auch die serverseitigen Rückfallwerte in `deploy.js` stehen
jetzt auf Best Practice — `blockAutoForward` und `rejectDirectSend` auf `true`,
`thresholdAction` auf `BlockUser`. Sie greifen nur bei gespeicherten Vorlagen,
die das Feld gar nicht kennen (aus der Zeit vor 2.13).

**Damit bekommt auch ein Altkunde die Sperren**, statt durch eine Lücke in seiner
alten Vorlage davon ausgenommen zu bleiben. Die Kehrseite gehört genannt: Beim
Deploy einer solchen Vorlage greift Direct-Send-Abweisung, ohne dass jemand ein
Häkchen gesetzt hat — Multifunktionsdrucker, Scan-to-Mail, Monitoring und
Fachanwendungen mit eigenem Mailversand werden dann abgeschnitten, *ohne
Fehlermeldung an den Absender*. Die Erhebung im Konfigurations-Tab gehört vorher
gelaufen.

## Version 2.15 - Ausgehend & Organisation: Best Practice als Vorgabe (2026-09-01)

Die drei Organisationsschalter stehen in der Vorlage jetzt **an**, und die
Sperre bei Überschreitung der Sendelimits ist **bis zur manuellen Freigabe**:

| Einstellung | vorher | jetzt |
|---|---|---|
| Externe Absender kennzeichnen | an | an |
| Automatische Weiterleitung sperren | **aus** | **an** |
| Direct Send abweisen | **aus** | **an** |
| Aktion bei Limit-Überschreitung | `BlockUserForToday` | **`BlockUser`** |

Begründung für die Sperre: Ein kompromittiertes Postfach, das sich nach 24 Stunden
von selbst wieder entsperrt, ist kein Schutz. Setzt voraus, dass geklärt ist, wer
im Ereignisfall freigibt.

**Die Erhebung vorher bleibt Pflicht** — die Befehle stehen unverändert im
Konfigurations-Tab. Gewollte Weiterleitungen, Multifunktionsdrucker, Scan-to-Mail
und Fachanwendungen mit eigenem Mailversand brechen sonst; bei Direct Send *ohne
Fehlermeldung an den Absender*. Abwählen bleibt pro Tenant jederzeit möglich.

**Der serverseitige Rückfallwert bleibt bewusst `false`.** Er greift nur, wenn
eine gespeicherte Vorlage das Feld gar nicht kennt — also bei Vorlagen aus der
Zeit vor 2.13. Dort hat niemand eine Entscheidung getroffen, und eine fehlende
Angabe darf nicht als «ja, bitte sperren» gelesen werden. Wer die neuen Vorgaben
für einen bestehenden Kunden will, öffnet die Vorlage einmal und speichert sie.

## Version 2.14 - Tab «Geheimnisse»: was das Werkzeug hält (2026-09-01)

### 🔑 Übersicht statt Blindflug

Neuer Bereich unter *Betrieb → Geheimnisse*. Er beantwortet die Frage, die man
sich sonst nur über SSH auf den Container beantworten kann: **Welche Schlüssel und
Zugangsdaten hält dieses Werkzeug, und in welchem Zustand?**

Gruppiert in vier Bereiche:

- **Kundentenants** — Zertifikats-Privatschlüssel je Tenant, mit Fingerabdruck,
  Gültigkeit bis, Dateizustand und zugehöriger App-Id
- **Dieses Werkzeug** — SSO-Clientgeheimnis, Sitzungsgeheimnis, `ADMIN_PASSWORD`
- **Angebundene Dienste** — `ANTHROPIC_API_KEY`, `SDP_API_KEY`,
  `BD_API_KEY` (Bitdefender GravityZone), `RMM_API_KEY` (N-sight). Dazu die
  Gegenstellen (`BD_HOST`, `RMM_SERVER`, `SDP_BASE_URL` …) offen im Klartext —
  sie tragen kein Geheimnis, aber ohne sie sagt ein Key wenig. Und ausdrücklich
  auch die Integrationen, die **keine** Zugangsdaten speichern: FortiClient lädt
  von einer fest verdrahteten, vertrauenswürdigen URL und weist andere Hosts ab;
  Bitwarden verpackt nur das öffentliche Installationspaket.
- **Nicht abrufbar** — MCP-Keys und Admin-Passwort, siehe unten

**Fehlt eine Zertifikatsdatei, steht das da** — mit dem Hinweis, dass «Reparieren»
im Tab Tenants ein neues anlegt. Das ist die häufigste Ursache für AADSTS700027
und war bisher nur im Fehlerfall sichtbar.

### 👁 Einblenden ist ein Schritt, kein Zustand

Die Übersicht zeigt **Zustand, nicht Werte**. Jedes Einblenden ist ein einzelner,
bestätigter Aufruf pro Eintrag und landet im Audit-Log. Bewusst gibt es **kein
«alles anzeigen»**: Hier liegen die Privatschlüssel für jeden angebundenen
Kundentenant, mit Rechten bis `RoleManagement.ReadWrite.Directory`. Eine Ansicht,
die sie gleichzeitig rendert, würde aus einem Screenshot oder einem offen
stehenden Bildschirm die Kompromittierung sämtlicher Mandate machen. Eingeblendete
Werte liegen nur im Speicher der Seite und lassen sich einzeln oder gesammelt
wieder verbergen.

Die Liste der abrufbaren Umgebungsvariablen ist **fest verdrahtet**, nicht
`process.env` durchgereicht — sonst wäre jede künftige Variable automatisch über
die Weboberfläche lesbar.

### 🚫 Zwei Dinge kann auch ein Admin nicht sehen

**MCP-API-Keys** liegen nur als SHA-256-Hash vor; der Klartext erscheint einmalig
bei der Erzeugung. **Das Admin-Passwort** liegt als gesalzener Hash vor. Beide
werden trotzdem aufgeführt — mit dem Vermerk, dass sie nicht abrufbar sind, damit
niemand sie hier sucht und glaubt, sie seien verloren gegangen.


## Version 2.13 - Ausgehend & Organisation (2026-09-01)

### 📤 Sechs Punkte, die bisher von Hand liefen

Bei PKRück wurden am 01.09.2026 sechs CIS-Punkte einzeln per Skript gesetzt, weil
das Werkzeug sie nicht kannte. Genau die sind jetzt drin — als eigener Bereich
**«Ausgehend & Organisation»** in der Vorlage, im Deploy, im Audit, im
Export-Skript und in der Konfigurationsdoku:

| CIS | Einstellung | Objekt |
|---|---|---|
| 2.1.6 | Benachrichtigung bei ausgehendem Spam + Empfänger | Outbound-Spam-Richtlinie *Default* |
| 2.1.15 | Empfängerlimits explizit, Aktion bei Überschreitung | dieselbe |
| 6.2.3 | Kennzeichnung externer Absender in Outlook | `Set-ExternalInOutlook` |
| 6.2.1 | Automatische Weiterleitung nach aussen sperren | `AutoForwardingMode` + Regel `BP_Block-AutoForwarding` |
| 6.5.5 | Direct Send abweisen | `Set-OrganizationConfig -RejectDirectSend` |
| 2.1.6 | Warnungsrichtlinie «User restricted from sending email» | im manuellen S&C-Snippet |

**Bewusst keine eigene `BP_`-Policy:** Diese Punkte sitzen an der *Standard*-Richtlinie
bzw. am Tenant. Eine eigene Policy mit Rule-Scope wäre konsistenter mit dem Rest des
Werkzeugs, aber CIS-Benchmark und Maester lesen die Default-Richtlinie — eine
danebengelegte BP_-Policy würde im Audit als «nicht erfüllt» erscheinen.

### 🛑 Zwei Schalter stehen absichtlich aus

**Auto-Forward-Sperre** und **Direct Send abweisen** können laufenden Betrieb
unterbrechen: gewollte Weiterleitungen, Multifunktionsdrucker, Scan-to-Mail,
Fachanwendungen mit eigenem Mailversand — bei Direct Send *ohne Fehlermeldung an den
Absender*. Beide sind in der Vorlage `false` und tragen im Konfigurations-Tab den
Erhebungsbefehl, der vorher zu laufen hat. Alles Unkritische (Benachrichtigung,
Limits, externe Kennzeichnung) steht auf Best Practice.

`ActionWhenThresholdReached` steht auf `BlockUserForToday`. CIS empfiehlt `BlockUser`
— das ist aber eine Betriebsentscheidung und setzt voraus, dass geklärt ist, wer im
Ereignisfall freigibt. Als Auswahl vorhanden, nicht als Vorgabe.

### 🔔 NotifyOutboundSpam ist abgekündigt

Microsoft hat den Parameter zugunsten der Warnungsrichtlinien abgekündigt. Das
Werkzeug setzt deshalb **beide** Wege: den Parameter an der Default-Richtlinie und —
im manuellen Snippet, weil S&C-PowerShell auf Linux nicht läuft — die eingebaute
Richtlinie «User restricted from sending email». Bestehende Empfänger dort bleiben
erhalten, die eigenen kommen dazu.

### 🐛 Cmdlet-Whitelist: `Get-OrganizationConfig` fehlte

`Connect-ExchangeOnline -CommandName` listete `Get-OrganizationConfig` nicht, obwohl
der Deploy-Body es für die `IsDehydrated`-Vorprüfung aufruft. Der Aufruf steckt in
einem leeren `catch` — die Prüfung lief also seit jeher ins Leere und der Anwender
bekam bei dehydrierten Tenants zehn Einzelfehler statt einer klaren Meldung. Jetzt
in der Whitelist, zusammen mit den neuen Cmdlets.

### 🧭 Ablaufplan hängt an der Konfiguration

`deployPlan(cfg)` ersetzt die feste `DEPLOY_PLAN`-Liste beim Anlegen eines Jobs:
abgewählte Organisationsschritte stehen nicht mehr dauerhaft als «ausstehend» in der
Live-Anzeige.

### 🔄 Bestehende Tenant-Vorlagen

Eine vor dieser Version gespeicherte Vorlage kennt den Abschnitt nicht. Der Store
füllt fehlende Abschnitte aus den Standardwerten auf, das Backend nimmt fehlende
Einzelwerte weich an — ein alter Stand blockiert den Deploy also nicht. Wer die
Werte pro Kunde festhalten will, speichert die Vorlage einmal neu.


## Version 2.12 - «Gerät statt Standort» als allgemeine Vorlage, Banner-Layout (2026-09-01)

### 🔁 Kundenname raus, Beschreibung rein

Die in 2.10 eingeführte Zusammenstellung hiess «REMONDIS» — ein Kundenname als
Vorlagenbezeichnung ist in einem Werkzeug, das Kollegen bedienen, eine Falle: Der
Nächste weiss nicht, ob das ein Muster oder ein Sonderfall ist, und traut sich
nicht, es woanders zu nehmen. Die Sache selbst ist keine Eigenheit, sondern eine
Grundlinie. Deshalb zwei benannte Varianten:

- **«Gerät statt Standort»** (`deviceFirst`) — 400 (`mfa`) + 401 (verwaltetes Gerät)
- **«Gerät statt Standort, phishing-resistent»** (`deviceFirstStrong`) — 409
  (Authentication Strength) statt 400

Beide ohne Standortbedingung: Der Aufenthaltsort entscheidet nicht mehr über den
Zugang, eine bestehende Ländersperre wird entbehrlich. Die **Voraussetzung steht
jetzt in der Lizenzzeile**, nicht im Kleingedruckten — ohne Intune-verwaltete
Geräte ist 401 keine Grundlinie, sondern eine Aussperrung; ohne ausgerollte
FIDO2-Anmeldung gilt dasselbe für 409.

Beide werden aus den bestehenden Vorlagen zusammengesetzt (`buildSelectionTier`),
nicht dupliziert. Weitere Varianten sind ein Eintrag in `SELECTION_DEFS`.

### 🐛 Tier-Liste war fest verdrahtet

`TIER_ORDER` im CA-Tab listete nur die drei Lizenz-Tiers. Neue Zusammenstellungen
kamen zwar aus der API, wurden aber nie angezeigt. Die Reihenfolge wird jetzt
abgeleitet: Lizenz-Tiers zuerst, danach alles Weitere.

### 🐛 Hinweisbanner zerfielen in Spalten

`.ld-banner` war ein Flex-Container. Jedes `<code>`, `<strong>` oder `<a>` im
Bannertext wurde dadurch zu einer eigenen Spalte mit `gap` dazwischen — der Satz
zerfiel sichtbar in Kolumnen (am deutlichsten im Tab Mail-Security). Jetzt
normaler Textfluss, das Symbol sitzt absolut im eingerückten Freiraum. Betrifft
alle Banner mit Inline-Auszeichnung, nicht nur den auffälligen.


## Version 2.11 - Offboarding: App-Registrierung im Kundentenant wird jetzt entfernt (2026-09-01)

### 🧹 Tenant-Offboarding als Gegenstück zum Onboarding

Bisher entfernte «✕ Entfernen» nur den lokalen Eintrag und das Zertifikat — der
Bestätigungsdialog sagte das sogar selbst: *«Die App-Registrierung im Tenant bleibt
bestehen.»* Zurück blieb im Kundenverzeichnis eine App mit
`DeviceManagementConfiguration.ReadWrite.All`, `Policy.ReadWrite.ConditionalAccess`,
`User.ReadWrite.All`, `RoleManagement.ReadWrite.Directory` und der
Exchange-Verwaltungsrolle — ohne brauchbare Anmeldedaten, aber auch ohne dass noch
jemand wusste, wofür sie da war.

**Neu: «🧹 Offboarden»** im Tab Tenants. Löscht im Kundentenant zuerst den
Dienstprinzipal (damit fallen Rollenzuweisungen und erteilte Admin-Zustimmungen weg),
danach die App-Registrierung — und räumt **erst dann** lokal auf.

**Warum noch einmal Device-Code:** Die App hat nur `Application.Read.All`, nicht
`ReadWrite` — sie kann sich nicht selbst löschen. Das Aufräumen braucht deshalb
zwingend eine Anmeldung mit Anwendungsadministrator-Rechten im Kundentenant, genau
wie das Anlegen.

**Reihenfolge ist Absicht:** Scheitert der Remote-Teil, wird lokal *nichts* gelöscht
und der Vorgang meldet `partial` mit Hinweis. Sonst stünde die App mit ihren Rechten
weiter im Kundentenant, während wir hier die Mittel wegwerfen, sie überhaupt noch zu
finden.

**Zweiter, bewusst getrennter Weg: «✕ Nur lokal».** Für den Fall, dass der Zugang
schon weg ist oder die App dort von Hand entfernt wurde. Verlangt eine ausdrückliche
Bestätigung und sagt danach klar, dass die App-Registrierung stehen bleibt.

Die Löschung ist eine **Soft-Löschung**: Entra behält das Objekt 30 Tage im
Papierkorb, ein Versehen ist zurückholbar. Bewusst kein permanentes Purge.

## Version 2.10 - Kundenzusammenstellung REMONDIS als eigenes Tier (2026-09-01)

### 🎯 Viertes Tier: «REMONDIS — Gerät statt Standort»

Aus Ticket RE-46191. Der Tenant sperrt Zugriffe heute nach Herkunftsland; künftig
soll der Gerätezustand entscheiden, nicht der Aufenthaltsort. Das Tier bildet das
Zielbild ab und ist über `/api/conditionalaccess/tiers` wie die anderen wählbar.

**Warum zwei Policies statt einer kombinierten.** Innerhalb einer Policy sind die
Gewährungen mit `OR` verknüpft — jedes zusätzliche Control ist ein weiterer *Weg
hinein*, keine zusätzliche Hürde. Eine Vorlage wie 208 («Strong Auth or trusted
device») bedeutet deshalb: wer ein verwaltetes Gerät hat, braucht überhaupt keine
MFA mehr. **Zwischen** Policies gilt das Gegenteil — alle zutreffenden müssen
erfüllt sein. Deshalb:

- **400** «All apps: Require MFA» — verlangt MFA, überall, ohne Standortbedingung
- **401** «All apps: Require trusted device» — verlangt ein verwaltetes Gerät,
  überall, Externe ausgenommen

Zusammen ergibt das MFA **und** Gerät. Der Aufenthaltsort entscheidet in keiner der
beiden über den Zugang, wodurch die Ländersperre entbehrlich wird.

**Ohne Authentication Strength.** Bewusst keine Policy mit phishing-resistenter
Stärke (100, 104, 110, 200, 211): ohne ausgerollte FIDO2-/Windows-Hello-Anmeldung
sperrt das beim Scharfschalten aus. 400 verlangt schlicht `mfa`, der Authenticator
genügt. Besonders 110 wäre gefährlich — sie verlangt starke Auth ausgerechnet für
die Notfallkonten, die im Ernstfall noch hereinkommen müssen.

**Zwei Overrides**, beide zwingend: 400 und 401 sind «Specific apps»-Vorlagen und
liefern `includeApplications: ["None"]`. Ohne gesetzten Geltungsbereich würden sie
sich erfolgreich deployen und **nichts tun** — im Portal sehen sie dabei aktiv aus.
Der `displayName` zieht auf «All apps» mit, damit der Name nicht wieder etwas
anderes behauptet als die Policy tut. 401 nimmt zusätzlich alle externen
Benutzertypen aus: Gastgeräte sind im Tenant keine Objekte und können eine
Compliance-Anforderung strukturell nicht erfüllen.

**Nicht dupliziert:** Das Tier wird beim Laden aus den bestehenden Vorlagen
zusammengesetzt (`buildRemondisTier()`), nicht abgeschrieben — bei einem
Upstream-Abgleich bleibt es damit automatisch in Sync. Weggelassene Policies sind
mit Begründung in `REMONDIS_SELECTION_META.excluded` hinterlegt, damit die Lücke
dokumentiert ist statt unsichtbar.

## Version 2.9.1 - CA-Policy 200 heisst jetzt, was sie tut (2026-09-01)

### 🏷️ Irreführender Name bei Conditional-Access-Policy 200 korrigiert

Policy 200 hiess `All apps: Require Strong Auth or trusted device or trusted
location`, hatte aber keine Geräte-Alternative: `builtInControls` ist leer, es
wirkt nur die phishing-resistente Authentication Strength plus die
Standortausnahme. Der Name versprach etwas, das die Policy nie konnte.

Neuer Name in allen drei Tiers (`bareMinimum`, `aadp1`, `aadp1p2`) und in der
lokalen `ca-policies/`-Ablage:

    200 - <RING> - Base protection - All apps: Require Strong Auth or trusted location

- **Das Verhalten ändert sich nicht.** `grantControls` wurden nicht angefasst —
  weder Operator noch Controls noch Authentication Strength.
- **Bewusst nicht** `["compliantDevice","domainJoinedDevice"]` ergänzt: der
  Operator ist `OR`, jedes weitere Control ist ein zusätzlicher Weg hinein. Ein
  compliant Device würde die Policy dann ohne jede MFA erfüllen — schwächer als
  heute. Im `bareMinimum`-Tier hätte es zusätzlich die zugesicherte
  Intune-Freiheit gebrochen.
- Der neue Name folgt Policy **211**, die bei identischer Konstruktion (leere
  `builtInControls` + Authentication Strength) schon immer so heisst.
- Vermerk im Dateikopf von `conditionalAccessPolicies.js`, damit der nächste
  Upstream-Abgleich das nicht als Transkriptionsfehler zurückrollt.
- Upstream-Meldung vorbereitet: `docs/upstream-issue-ca200.md`.

**Achtung bei bereits ausgerollten Tenants:** `upsertPolicy` erkennt Policies am
`displayName`. Wo 200 schon deployt ist, legt der nächste Lauf eine zweite
Policy unter dem neuen Namen an; die alte bleibt stehen und muss von Hand weg.
Beide sind `enabledForReportingButNotEnforced`, es sperrt also niemanden aus.

## Version 2.9 - Bitwarden-Region beim Deployen, Erreichbarkeitstest ausgebaut (2026-08-31)

### 🔐 Server-Region direkt beim Bereitstellen mitgeben

Bisher musste man die Region der Bitwarden-Browsererweiterung hinterher von Hand
unter *Mappings → Registry-Richtlinie* zusammenbauen. Jetzt steht sie als Option
im Bereitstellen-Dialog: **EU-Cloud**, **US-Cloud** oder **eigene Instanz**
(mit URL-Feld). Ist sie gesetzt, legt derselbe Lauf zusätzlich das
Plattformskript `WIN - RegistryPolicy - Bitwarden-Region` an und weist es zu.

- **Ziel ist die dynamische GroupTag-Gerätegruppe**, nicht die genestete
  `AAD-APP-`-Gruppe: Intune löst verschachtelte Gruppen nur beim App-Assignment
  auf, bei Plattformskripten nicht — über die App-Gruppe käme das Skript nie an.
- **Fester Profilname**, ein erneuter Lauf aktualisiert das vorhandene Skript
  statt ein zweites danebenzulegen.
- Die Self-Host-URL wird beim Start geprüft, nicht erst nach dem 122-MB-Upload.
- Die Vorlage `bitwarden-browserext-eu` und der Deploy-Schritt teilen sich jetzt
  denselben Generator (`bitwardenExtensionEntries`) — die Registry-Pfade stehen
  nur noch an einer Stelle.

**Klargestellt, wo es vorher missverständlich war:** das gilt ausschließlich für
die **Browsererweiterung**. Die **Desktop-App** liest ihre Region aus dem
Benutzerprofil (`data.json`, entsteht erst beim ersten Start) — die setzt weder
die Win32-App noch das Skript; dort wählt der Benutzer sie beim ersten Login.
Der Hinweistext im Tab sagt das jetzt so.

### 📡 Bezugsquelle sichtbar

Der Bitwarden-Bereich zeigt eine Tabelle **Bezugsquelle**: welcher Host wofür
angesprochen wird (`vault.bitwarden.com` → `github.com` →
`release-assets.githubusercontent.com`) plus die URL des aktuellen Releases.
Die Liste kommt aus `lib/bitwarden.js` und ist dieselbe, die der
Erreichbarkeitstest prüft — sie kann also nicht auseinanderlaufen.

### 🩺 Diagnose: Erreichbarkeit statt nur Microsoft

Der Test deckte bisher drei Microsoft-Endpunkte ab. Jetzt alle Gegenstellen, die
das Tool wirklich anspricht, nach Wichtigkeit gruppiert:

- **Microsoft — Pflicht**: Login, Graph, Exchange Online, PowerShell Gallery
  (Maester-/Modul-Updates) und der Intune-Content-Upload nach Azure Blob Storage
  — letzterer als Info-Zeile, weil Intune die Ziel-URL pro Upload als SAS-Link
  auf ein wechselndes Speicherkonto erzeugt und ein fester Testaufruf geraten
  statt gemessen wäre.
- **App-Deployment**: die drei Bitwarden-Hosts, Bitdefender GravityZone,
  N-sight RMM und der FortiClient-Installer-Host.
- **Intune-Baselines**: GitHub-API und Rohdateien des OpenIntuneBaseline-Repos.
- **Optional**: ServiceDesk Plus und die Anthropic-API — ohne passenden Key als
  „nicht konfiguriert, daher unkritisch" markiert statt als Fehler.

Dazu: Tests laufen **parallel** (vorher nacheinander mit je 8 s Timeout — im
schlechtesten Fall knapp zwei Minuten Wartezeit), per HEAD statt GET, jede Zeile
nennt Zweck und URL, und oben steht eine Zusammenfassung. Jede HTTP-Antwort
zählt als erreichbar, auch 401/403/404 — geprüft wird die Netzwerkstrecke, nicht
die Berechtigung.

## Version 2.8 - Bitwarden-Desktop-App per Intune verteilen (2026-08-31)

### 🔐 Neuer Bereich „Bitwarden" unter *Apps & Agents*

Die Bitwarden-Desktop-App (Windows) lässt sich jetzt genau wie Bitdefender,
N-sight und FortiClient direkt aus dem Tool als **Intune-Win32-App** ausrollen —
inklusive Zielgruppe `AAD-APP-<Name>` und genesteter GroupTag-Gerätegruppe.

- **Kein API-Key nötig**: `bitwarden.com/download` verweist auf das jeweils
  aktuelle GitHub-Release; das Backend löst daraus Version, Installer und
  Offline-Pakete auf (`api/lib/bitwarden.js`, Ergebnis 30 Min. gecacht).
- **Offline-Paketierung statt Web-Installer** (Standard): Bitwarden liefert
  einen electron-builder-*nsis-web*-Stub aus (~0,7 MB) — die eigentlichen
  ~122 MB lädt er erst *während* der Installation aus dem Internet nach. Auf
  einem verwalteten Gerät ist das fragil: der SYSTEM-Kontext braucht dafür
  freien Zugriff auf `github.com`, und schlägt der Download fehl, wartet der
  Stub auf eine Meldung, die dort niemand wegklicken kann. Das Tool packt
  deshalb das passende `bitwarden-<ver>-<arch>.nsis.7z` mit ins Intune-Paket —
  liegt es neben dem Installer, verwendet der Stub es direkt (dokumentiertes
  electron-builder-Verhalten, Prüfsumme wird geprüft).
- **Architektur wählbar**: `x64` (Standard), `x64 + ARM64` oder „nur
  Web-Installer". Zugewiesen wird nur, wofür auch ein Offline-Paket im Paket
  liegt (`applicableArchitectures`) — sonst wäre eine ARM64-Zuweisung ohne
  ARM64-Paket eine stille Fehlerquelle.
- **Prüfsummen**: Installer und Offline-Paket werden serverseitig gegen die
  `latest.yml` des Releases (SHA-512) geprüft, bevor irgendetwas hochgeladen
  wird.
- **Vorbelegte Deploy-Werte** nach Bitwarden-Doku: Install `"{file}" /allusers
  /S`, Uninstall `"C:\Program Files\Bitwarden\Uninstall Bitwarden.exe"
  /allusers /S`, Erkennungsregel Datei `C:\Program Files\Bitwarden` →
  `Bitwarden.exe`. Der Deploy-Dialog übernimmt Erkennungsregeln jetzt
  allgemein aus den Vendor-Vorgaben, statt sie immer leer zu lassen.
- **Direkt-Downloads** für Installer und Offline-Pakete im Tab (für den
  manuellen Fall), Backend-seitig auf die GitHub-Release-Assets von
  `bitwarden/clients` beschränkt.

### 🧩 Client-Konfiguration (Bitwarden-Cloud, kein Self-Hosting)

Neue Vorlage **`bitwarden-browserext-eu`** unter *Mappings →
Registry-Richtlinie*: setzt die Server-Region der Bitwarden-Browsererweiterung
per 3rdparty-Extension-Policy fest auf die EU-Cloud (`vault.bitwarden.eu` +
`notifications.bitwarden.eu`), für Chrome und Edge (beide Erweiterungs-IDs).
Auf der US-Cloud braucht es das Profil nicht; für eine selbst gehostete Instanz
werden einfach die beiden URLs in den Zeilen ersetzt.

### 🛠️ Nebenbei

- **Silent-Schalter case-sensitiv prüfen**: `/S` (NSIS) und MSI-Eigenschaften
  wie `REBOOT=ReallySuppress` müssen groß geschrieben sein. Bisher hätte ein
  klein geschriebenes `/s` im Install-Kommando als „ist schon drin" gezählt und
  einen interaktiven Installer im SYSTEM-Kontext hängen lassen.
- **ZIP-Encoder**: `store`-Flag pro Eintrag, um bereits gepackte Nutzlasten
  (das 122-MB-`.nsis.7z`) nicht sinnlos noch einmal durch Deflate zu schicken.

## Version 2.7 - Detailreports & Kundenreport-Ausbau (2026-08-26)

- **Statusreport mit Detail-Listen**: die Report-Sektionen liefern jetzt
  konkrete, gekappte Listen statt nur Zähler — welche Konten inaktiv/
  deaktiviert lizenziert sind, alle CA-Policies mit Status, Konten mit
  Adminrollen, Gäste, nicht konforme/sync-lose Geräte, nicht zugewiesene
  OIB-Policies, freie Seats je SKU, Mehrfach-Lizenzierungen. Persistiert als
  Datei pro Tenant (`state/reports/`), state.json bleibt schlank.
- **Reports-Tab** zeigt den gespeicherten Detailreport auch ohne frischen
  Lauf und rendert die Listen aufklappbar als Tabellen.
- **Kunden-HTML & Kunden-PDF** betten die Detail-Listen im Kapitel
  «Tenant-Status im Überblick» ein (HTML: volle Tabellen in den Accordions,
  PDF: kompakt auf 15 Zeilen gekappt mit Verweis auf den HTML-Report).
- Kunden-HTML-Report (Accordions, Mail-Anhang) und die PDF-Formatierung
  (Logo, Codeblöcke, echte Tabellen, klickbare Links, durchlaufende
  Nummerierung) aus den Nachzügen von Version 2.6.

## Version 2.6 - Maester-Security-Audit integriert (2026-08-26)

### 🔍 Neuer Bereich „Security-Audit" (Maester)

Die komplette [Maester](https://maester.dev)-Testsuite (360+ Tests: CISA SCuBA,
CIS Microsoft 365, EIDSCA, ORCA, Community) läuft jetzt direkt aus dem Tool —
app-only mit dem vorhandenen Tenant-Zertifikat, **rein lesend**:

- **Neuer Tab „Security-Audit"** unter *Betrieb*: Lauf starten (5–20 Min.,
  Fortschrittsanzeige über die bekannte Job-Mechanik), Security-Score,
  gefallene Tests nach Schweregrad sortiert mit Doku-Links, Verlauf pro Tenant
  und Übersicht über alle Tenants (wie bei den Reports: nur gespeicherter
  Stand, keine Live-Abfragen).
- **Interaktiver Maester-HTML-Report** pro Lauf abrufbar
  (`/api/tenants/:id/maester/runs/:runId/report.html`, session-gated); die
  letzten 8 Läufe bleiben unter `state/maester/` liegen, Rohdaten als JSON.
- **Verbindungen**: Connect-MgGraph app-only mit dem Tenant-PEM; Exchange
  Online best effort dazu — scheitert EXO, laufen die Graph-Tests trotzdem und
  der Hinweis steht am Ergebnis.
- **Berechtigungen**: Onboarding und „Reparieren" setzen jetzt zusätzlich die
  Maester-Leseberechtigungen (Directory.Read.All, Reports.Read.All,
  RoleManagement.Read.All u. a. — vollständige Liste in `GRAPH_APP_PERMS_MAESTER`).
  Permissions, die es im Tenant nicht gibt (z. B. Global Secure Access,
  Defender for Identity), werden übersprungen statt den Vorgang abzubrechen.
  **Bestehende Tenants: einmal „Reparieren" im Tab Tenants ausführen.**
- **MCP**: zwei neue, pro Tenant freischaltbare Berechtigungen —
  `readMaester` (letztes Ergebnis lesen) und `runMaester` (Lauf anstossen),
  inkl. Job-Polling-Endpunkt.
- **Image**: Maester, Pester und Microsoft.Graph.Authentication sind im
  API-Container installiert; die Testsuite wird beim Build nach
  `/opt/maester-tests` eingefroren und aktualisiert sich mit jedem Deploy.

Nachgezogen nach dem ersten Praxistest (gleicher Tag):

- **Suiten-Auswahl**: CISA SCuBA, CIS M365, EIDSCA, ORCA und Maester Community
  einzeln an-/abwählbar (Tag-Filter, alle an = kompletter Lauf); die gewählten
  Suiten stehen am Ergebnis. Auch über MCP (`suites` im Run-Body).
- **Berechtigungs-Vorprüfung**: fehlen die Maester-Leseberechtigungen am
  Tenant-SP, bricht der Lauf sofort mit klarem Hinweis auf «Reparieren» ab —
  vorher lief Maester durch und lieferte einen falschen Score, weil reihenweise
  Tests an 403ern scheiterten.
- **Job überlebt Reload**: laufende Audits werden beim Öffnen des Tabs wieder
  aufgenommen (`/maester/active`), ein Klick auf Start hängt sich an einen
  bereits laufenden Job dran statt mit 409 zu meckern; die Job-Anzeige nennt
  den Tenant des Jobs, nicht den gerade gewählten.
- **Zeitplan**: pro Tenant «Automatisch ausführen» (täglich/wöchentlich/
  14-tägig/monatlich) mit den gewählten Suiten — läuft serverseitig (Interval-
  Check alle 15 Min., ein Audit gleichzeitig, 6 h Sperre nach Fehlversuch);
  Ergebnis automatischer Läufe steht an der Tenant-Karte.
- **Live-Fortschritt**: während des Laufs zeigt der Job den aktuellen Block/
  Test und laufende Zähler (bestanden/gefallen/übersprungen) — geparst aus dem
  Pester-Stream (Verbosity Detailed).
- **Robustere Auswertung**: Zusammenfassung wandert als Datei aus dem
  pwsh-Lauf (stdout war voller Terminal-Sequenzen und hat den JSON-Marker
  schon einmal zerlegt), Auswertung in try/catch mit klarer Fehlermeldung,
  ANSI-Reste werden aus Fehlertexten gefiltert, `/api/appjobs` liefert den
  pwsh-Prozess-Handle nicht mehr mit aus.
- **Testsuite hält sich selbst aktuell**: die Testszenarien stecken im
  Maester-Modul — das Backend prüft einmal täglich die PSGallery, installiert
  neue Maester-Versionen und extrahiert die Tests frisch ins State-Volume
  (`state/maester-tests`, Fallback bleibt die beim Build eingefrorene Kopie);
  im Tab gibt es dazu eine Testsuite-Box mit Version, Stand und
  «Jetzt aktualisieren».
- **Skip-Gründe sichtbar**: aufklappbare Liste «N übersprungene Tests — und
  warum» am Ergebnis (Grund aus Maesters ResultDetail: fehlende Lizenz,
  fehlendes Modul, nicht zutreffend, …).
- **Deutsche Erklärungen per KI**: «Auf Deutsch erklären» erzeugt pro
  gefallenem Test einen kundenverständlichen Titel, die Bedeutung/das Risiko
  und konkrete Umsetzungsschritte inkl. Aufwandsschätzung (Anthropic-API wie
  im Ticket-Copilot, einmal pro Lauf gecacht als `explain.json`).
- **Findings-Accordion**: Klick auf einen gefallenen Test klappt Details auf —
  deutsche Erklärung, sonst Maesters englische Testbeschreibung + Befund.
- **SDP-Anbindung**: pro Finding «Als SDP-Ticket anlegen» (nur für den
  freigeschalteten Tickets-Nutzer) — Ticket mit deutscher Erklärung und
  Umsetzungsschritten, `POST /api/sdp/maester-task` + `SDP.createRequest`.
- **Kunden-PDF**: serverseitig erzeugter deutscher Report (pdfkit, neue
  Dependency) mit Score-Kennzahlen, Findings inkl. KI-Erklärungen,
  Skip-Gründen und Methodik — `GET …/maester/runs/:runId/report.pdf`.
- **Kunden-PDF komplett neu gestaltet**: Deckblatt, Management-Zusammenfassung
  (Score-Kacheln, Schweregrad-Balken, Einordnung, Top-Prioritäten), Findings
  mit Schweregrad-Markern, **Domain-Authentifizierung (SPF/DKIM/DMARC)** als
  eigener Abschnitt (live geprüft — deckt die ORCA-«Custom»-Skips ab),
  nicht bewertbare Tests **nach Grund gruppiert und deutsch erklärt**,
  Methodik + Disclaimer, saubere Fusszeilen. Ohne KI-Erklärung stehen die
  englische Testbeschreibung und der Befund im Finding (statt eines
  Platzhaltersatzes).
- **Zählerkorrektur**: bei Suiten-Auswahl markiert Maester abgewählte Tests
  als «NotRun» — die zählen nicht mehr als «übersprungen» (vorher standen
  700 Skips im Report, wenn nur eine Suite lief).
- **Markdown-Darstellung**: Testbeschreibung/Befund im Accordion werden als
  formatiertes Markdown gerendert (eigener Mini-Renderer, HTML-escaped).
- **Teams- und SharePoint-Verbindung**: der Lauf verbindet zusätzlich
  MicrosoftTeams (app-only, braucht die Teams-Administrator-Rolle) und
  SharePoint via PnP (braucht die SharePoint-Permission Sites.FullControl.All
  — SharePoint kennt kein engeres app-only-Äquivalent; genutzt wird sie rein
  lesend). Onboarding/«Reparieren» setzen Rolle und Permission;
  **bestehende Tenants: erneut Reparieren ausführen.**
- **Security & Compliance wird mitverbunden**: best-effort
  `Connect-IPPSSession` app-only (Compliance-Administrator-Rolle setzt das
  Onboarding schon) — schaltet die CISA-Tests zu Defender/Spam/DLP/Audit
  frei, die bisher als `NotConnectedSecurityCompliance` übersprungen wurden.
  Scheitert der Connect (Linux-Einschränkungen), läuft der Rest unverändert.
- **Auswertung läuft jetzt in Node statt in pwsh**: Zusammenfassung wird aus
  Maesters `results.json` gerechnet. Grund: der pwsh-Prozess wurde am Ende
  zweier realer Läufe kommentarlos abgeschossen (kein stderr — mutmasslich
  Speicherlimit). Stirbt der Prozess künftig nach dem Testlauf, wird das
  Ergebnis aus `results.json` gerettet und der Lauf gilt als erfolgreich (mit
  Hinweis); die Roh-Ausgabe des Laufendes landet im Server-Log (Diagnose),
  Ergebnisdateien abgebrochener Läufe werden nicht mehr gelöscht.

## Version 2.5 - Vorlage pro Tenant, Diagnose, zwei handfeste Fehlerquellen (2026-08-20)

### 💾 Vorlage pro Tenant speicherbar

Die Vorlage (Domains, Admin-/MSP-Adresse, alle Policy-Werte) lebte bisher nur im
Browser-Tab: nach einem Reload standen wieder die `example.com`-Platzhalter da, und
wer mehrere Kunden betreut, tippte bei jedem Wechsel neu. Neu hängt sie am Tenant:

- **„Für diesen Tenant speichern"** im Bereich *Vorlage*, mit Statuszeile
  (gespeichert am … / noch nicht gespeichert).
- Beim Umschalten des Tenants wird die gespeicherte Vorlage **automatisch geladen**.
  Gibt es keine, bleiben die aktuellen Werte stehen — ein Wechsel wirft nie
  unbemerkt Eingaben weg.
- Fehlende Abschnitte einer älteren gespeicherten Vorlage werden aus den
  Standardwerten aufgefüllt.
- Endpunkte: `GET/PUT/DELETE /api/tenants/:id/config`. Geprüft wird beim Deploy,
  nicht beim Speichern — ein unfertiger Zwischenstand darf liegen bleiben.

### 🩺 Neuer Bereich „Diagnose"

Seit dem GitOps-Deploy läuft die API als Pod; `docker logs` gibt es nicht mehr.

- **Server-Log** der laufenden Instanz (letzte 400 Zeilen, Auto-Refresh,
  Fehlerfilter, Kopieren). Passwörter, Tokens und JWTs werden maskiert.
- **Erreichbarkeitstest** gegen `login.microsoftonline.com`, `graph.microsoft.com`
  und `outlook.office365.com` — beantwortet „kommt der Container raus?" ohne Shell
  im Pod.
- Fehler landen mit Methode, Pfad und Status im Log; bei Netzfehlern wird
  zusätzlich `e.cause` ausgegeben (`ENOTFOUND`, `ECONNREFUSED`, Zertifikat).
  „fetch failed" allein sagte nichts.

### 🔑 Zertifikat-Prüfung vergleicht jetzt Thumbprints

Die Reparatur meldete „Zertifikat ok", sobald an der App-Registrierung überhaupt
ein Schlüssel hing — auch wenn es ein anderes Zertifikat war. Beim Token-Holen kam
dann `AADSTS700027`, während die Prüfung Entwarnung gab. Neu wird der SHA1-
Thumbprint des lokalen PEM gegen die registrierten `keyCredentials` verglichen.
Passt er nicht, gibt es den Zustand **„Eingriff nötig"** samt Auflistung der
vorhandenen Zertifikate — Ersetzen nur auf ausdrücklichen Knopfdruck, weil Graph
den öffentlichen Teil bestehender Schlüssel beim GET nicht mitliefert und ein PATCH
die Liste zwangsläufig komplett ersetzt.

### 🔓 Dehydrierte Tenants werden erkannt

Ist die Organisationsanpassung nie aktiviert worden, sperrt Exchange Online alle
eigenen Policies. Das lief bisher in die Retry-Schleife: vier Versuche, 60 Sekunden
Wartezeit, am Ende eine abgeschnittene Meldung.

- Vorprüfung `Get-OrganizationConfig.IsDehydrated` bricht sofort mit Begründung ab.
- Das Fehlermuster bricht ohne Retry ab; transiente Fehler (Replikation, Race)
  gehen weiterhin in die Wiederholung.
- `POST /api/tenants/:id/enable-org-customization` führt
  `Enable-OrganizationCustomization` aus — eigener Endpunkt hinter einer Rückfrage,
  nie automatisch im Deploy: schreibender, nicht rückgängig zu machender Eingriff
  im Kundentenant.

### 📄 Netzwerk-Freigaben dokumentiert

`docs/netzwerk-freigaben.md` listet alle Gegenstellen mit Fundstelle im Code,
getrennt nach zwingend, funktionsabhängig und Build-Zeit.

## Version 2.4 - Neue Navigation: Seitenleiste statt Tab-Leiste (2026-08-19)

### 🧭 Linke Seitenleiste, nach Arbeitsablauf gruppiert

Die zwölf Bereiche lagen bisher als flache Pillen-Leiste nebeneinander — auf
schmaleren Schirmen musste man horizontal scrollen, und die Gruppen waren nur
als dünner Strich erkennbar. Neu:

- **Seitenleiste links** mit sichtbaren Gruppenüberschriften:
  *Start* (Tenants, Vorlage) → *Mail-Security* (Ausrollen, Audit) →
  *Identität* (Conditional Access) → *Geräte* (Intune, Autopilot, Mappings,
  Agents) → *Betrieb* (Lizenzen, Tickets) → *Referenz* (Wissen).
  Die Reihenfolge entspricht dem Einrichtungs-Assistenten aus dem Tenants-Tab:
  von oben nach unten abarbeiten ergibt die richtige Reihenfolge.
- **Einklappbar** auf reine Icons (Zustand bleibt in localStorage gespeichert).
- **Schlanke Kopfzeile** zeigt den Namen des aktuellen Bereichs plus eine Zeile,
  was er tut — daneben nur noch Tenant-Umschalter, Session und Darstellung.
  Die Export-/Import-Schaltflächen erscheinen weiterhin nur im Bereich *Vorlage*.
- **Schmale Schirme**: Die Leiste wird zur Schublade hinter einem Menü-Knopf
  (schliesst per Auswahl, Backdrop-Klick oder Escape).
- **Zuletzt offener Bereich** wird gemerkt; Startbereich ist neu *Tenants*
  (dort wird der Kunde gewählt — alles Weitere arbeitet gegen diesen Tenant).

Die Bereiche selbst sind unverändert und bleiben wie bisher alle gemountet,
damit laufende Device-Code- und Job-Polls beim Wechsel nicht abbrechen.

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

#### autounattend.xml jetzt dynamisch + WLAN-Upload

Die `autounattend.xml` im Paket wird nicht mehr statisch mitgeliefert, sondern
pro Paket generiert — mit den Vorgaben: **deutsche UI (de-DE)**, Schweizer
Locale/Tastatur (de-CH), automatische Partitionierung, **EULA automatisch**,
**kein AutoLogon** (Anmeldung mit M365-User via Autopilot user-driven — keine
lokalen Konten).

WLAN optional: **WLAN-Export-Helper** (`Export-WlanProfile.ps1`) herunterladen,
auf einem Rechner mit dem Kunden-WLAN ausführen (Export inkl. Passwort,
`key=clear`), die XML im Tool **hochladen** → das Profil wird persistent
(`user=all`) in die autounattend.xml eingebettet, **Passwort bleibt gespeichert**
(Wifi.xml wird bewusst nicht gelöscht).

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
