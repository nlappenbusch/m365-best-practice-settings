# Microsoft 365 Cockpit

Die neue Oberfläche orientiert sich an den bereitgestellten Marketplace-Screenshots: dunkles Petrol, gelbe Aktionen, durchsuchbare und einklappbare Navigation, Tenant-Auswahl, Kacheln, Filter, Tabellen und modale Formulare. Bestehende Modul-IDs, Tenant-Auswahl, Login und laufende Fachmodule bleiben eingebunden. Ein gespeichertes helles Theme bleibt erhalten; neue Sitzungen starten dunkel.

## Implementierte Abläufe

| Bereich | Funktion und Datenquelle |
| --- | --- |
| Dashboard | Tenant-Kacheln oder Liste, Suche, Verbindungsfilter, Handlungsbedarf, Secure Score, Geräte-Compliance, SLA, Synchronisierung über bestehende Managed-Service-Jobs |
| Benutzer & MFA | Live-Entra-Benutzer, Gäste, Gruppen, Lizenzzahlen, MFA-Registrierung, Suche/Filter, CSV, Kennzahlengrafiken; Passwort-/MFA-Reset und Sitzungswiderruf über bestehende freigabepflichtige Kontoaktionen |
| Apps | Service Principals, delegierte Grants und App-Role-Assignments; transparentes Berechtigungsrisiko; aufklappbare Faktoren; begründete Prüfvermerke je Tenant |
| App-Credentials | Ablaufende Secrets-/Zertifikatsmetadaten in Apps und Service Principals; Monitoring-Befunde, Fristen, CSV und Anschluss an vorhandene Alarmierung |
| Anmeldungen | Persistiertes Archiv bis sieben Tage (initial 24 Stunden), paginierter Sync mit Überlappung und Deduplikation; Ansicht maximal 1000 neueste Einträge, Filter, Standortkarte, CSV |
| Jobs & Synchronisierung | Dauerhafte SQLite-Queue, Lease/Heartbeat, Wiederaufnahme, Retry/Abbruch, Quellzustände und Datenalter |
| Zugriff & Tenant-Rollen | Explizite SSO-Zuweisungen: Lesen, Operator, Tenant-Admin; Plattformadministration und Journal |
| DSGVO-Check | Fünf technische Befundkategorien und zehn manuelle Maßnahmen; begründete Statusänderungen mit Benutzer/Zeitpunkt und gespeichertem Verlauf; Maßnahmenexport |
| Alarm-Regeln | Bereich, Mindestschweregrad, Anzahl, Aktivierung, Bearbeiten/Löschen, manuelle und automatische Auswertung nach Managed-Service-Lauf; interner Verlauf |
| Policy-Rollout | Vorhandene CA-Zustandsvorlagen erfassen, Zielmandanten wählen, pro Tenant vergleichen, Policy-Ausnahmen, explizite Aktivierungsfreigabe, Einzelresultate. Verwendet bestehende CA-APIs. |
| Geo-Blocking | Neue Länder-Policies je Zieltenant, serverseitige Vorschau, explizite aktive Notfallkonto-Ausnahmen, Report-only-Start, Planbindung und Wiederaufnahme nach Teilfehlern |
| DMARC | Import unkomprimierter XML-Aggregatberichte, Format-/Größenprüfung, DTD-/Entity-Abweisung, Duplikaterkennung, nach Nachrichtenanzahl gewichtete Pass-Rate, Domain-/Fehlerfilter, CSV |
| Kostenplanung | Eigene Benutzerzahl, Preis, Grundgebühr und Währung; monatliche und jährliche Schätzung |

SharePoint/OneDrive, Geräte, Intune, Lizenzen, Rollen, Mail-Security, Maester, Evidence und Reports sind weiter über die Fachmodule erreichbar.

## Technische Grenzen

- Keine produktiven Microsoft-Zugriffe wurden während der Umsetzung ausgeführt. Die Graph-Anbindung verwendet die vorhandenen Tenant-Zertifikate und muss mit einem verbundenen Testtenant überprüft werden.
- MFA-Registrierung ist keine Aussage über MFA-Erzwingung. Nicht im Registrierungsreport vorhandene Benutzer erhalten den Zustand unbekannt. Siehe [Microsoft-Dokumentation](https://learn.microsoft.com/en-us/graph/api/authenticationmethodsroot-list-userregistrationdetails?view=graph-rest-1.0).
- Der Maßnahmen-Erfüllungsgrad ist eine Arbeitshilfe. Automatische Kategorien bewerten offene Befunde; er ist kein Rechtskonformitätszertifikat. Fehlende, fehlgeschlagene oder mehr als sieben Tage alte Erhebungen gelten als zu prüfen.
- App-Bewertungen priorisieren nach Berechtigungsnamen. Nicht auflösbare Rechte und Abruffehler werden als Datenlücke ausgewiesen. Prüfvermerke widerrufen keine Rechte.
- Alarmregeln erzeugen interne Ereignisse. Die bestehende Teams-/Ticket-Benachrichtigung des Managed Service bleibt separat konfiguriert; frei wählbare E-Mail-Empfänger sind nicht angebunden.
- DMARC enthält keinen automatischen Postfachempfang und keine DNS-Verifizierung. Derzeit werden höchstens 200 Berichte je Tenant aufbewahrt. Die Übersichten aggregieren die importierten Berichte; überlappende Zeiträume unterschiedlicher Reporter werden nicht zusätzlich dedupliziert.
- Die Kostenplanung bucht keine Subscription und verwendet keine fremden Marketplace-Preise als verbindliche Konditionen.
- Der CA-Zustandsrollout ändert bestehende eigene Policies. Der separate Geo-Ablauf erstellt neue Länder-Policies ausschließlich in Report-only; produktive Aktivierung erfolgt später in Conditional Access. Andere fehlende Baseline-Policies werden weiterhin im bestehenden Fachmodul angelegt.
- CSV ist für Excel geeignet; es handelt sich nicht um native XLSX-Dateien. Formelanfänge werden neutralisiert.

## Betrieb und Berechtigungen

Alle neuen Routen liegen hinter dem bestehenden Session-Guard. Lokale Notizen, Alarmregeln, DMARC und Maßnahmen dürfen auch in einem Prüfmandat gespeichert werden; produktive Konto-/CA-Schreibaktionen bleiben gesperrt. Die neuen lokalen Daten liegen unter `tenant.cockpit` im bestehenden State und müssen zusammen mit diesem gesichert werden. XML-Rohdateien werden nicht gespeichert. Identity-Antworten werden für die jeweilige Ansicht geladen; Sign-ins kommen aus dem dauerhaft synchronisierten Archiv.

Geo-Pläne liegen zusätzlich unter `STATE_DIR/managed/<tenant>/geo-plans.json`, atomar ersetzt und auf 100 Einträge begrenzt. Die Microsoft-Objekte werden nicht automatisch entfernt, wenn ein lokaler Historieneintrag ausläuft. Credential-Monitoring-Daten liegen in der bestehenden Managed-Service-Ablage. Beide Ablagen gehören ins Backup. Vollständiger Funktionsvergleich und weiteres Zielbild: [FOCUS-PARITY-PLAN.md](FOCUS-PARITY-PLAN.md).

Die bestehenden Graph-Application-Permissions und Zertifikate gelten weiter. MFA und [Sign-ins](https://learn.microsoft.com/en-us/graph/api/signin-list?view=graph-rest-1.0) benötigen `AuditLog.Read.All`, [Secure Score](https://learn.microsoft.com/en-us/graph/api/security-list-securescores?view=graph-rest-1.0) benötigt `SecurityEvents.Read.All`. Benutzer, Gruppen, Apps und Intune benötigen zusätzlich ihre jeweiligen Leserechte. Rechte werden durch diese Ansichten nicht automatisch erweitert; Fehler werden sichtbar ausgegeben.

Die Dependency-Locks wurden aktualisiert. `selfsigned` wurde auf die asynchrone v5-API umgestellt; beide Zertifikatswege verwenden den getesteten gemeinsamen Helfer mit RSA 2048, SHA-256 und 730 Tagen Laufzeit.

Dauerhafte Queue, Bootstrap der Rollen, Sicherung/Wiederherstellung und Wiederholungsgrenzen: [PLATFORM-OPERATIONS.md](PLATFORM-OPERATIONS.md). Die API benötigt Node.js ab 22.16 und weiterhin genau eine Instanz.

## Prüfung und lokaler Start

```powershell
cd api
npm ci
npm test
node --check server.js
# Bestehende lokale Backend-Konfiguration verwenden:
npm start
```

In einer zweiten Konsole:

```powershell
cd frontend
npm ci
npm run dev
```

Der Vite-Proxy erwartet das Backend auf Port 3000. Ein produktiver Frontend-Build entsteht mit `npm run build`. CI führt jetzt auch die Backend-Test-Suite aus. Produktive Deployments erfolgen im bestehenden Repo bei Merge auf `main`; diese Änderung wird deshalb als separater Branch/PR bereitgestellt.
