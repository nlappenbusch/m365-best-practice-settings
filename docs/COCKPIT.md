# Microsoft 365 Cockpit

Die neue Oberfläche orientiert sich an den bereitgestellten Marketplace-Screenshots: dunkles Petrol, gelbe Aktionen, durchsuchbare und einklappbare Navigation, Tenant-Auswahl, Kacheln, Filter, Tabellen und modale Formulare. Bestehende Modul-IDs, Tenant-Auswahl, Login und laufende Fachmodule bleiben eingebunden. Ein gespeichertes helles Theme bleibt erhalten; neue Sitzungen starten dunkel.

## Implementierte Abläufe

| Bereich | Funktion und Datenquelle |
| --- | --- |
| Dashboard | Tenant-Kacheln oder Liste, Suche, Verbindungsfilter, Handlungsbedarf, Secure Score, Geräte-Compliance, SLA, Synchronisierung über bestehende Managed-Service-Jobs |
| Benutzer & MFA | Live-Entra-Benutzer, Gäste, Gruppen, Lizenzzahlen, MFA-Registrierung, Suche/Filter, CSV, Kennzahlengrafiken; Passwort-/MFA-Reset und Sitzungswiderruf über bestehende freigabepflichtige Kontoaktionen |
| Apps | Service Principals, delegierte Grants und App-Role-Assignments; transparentes Berechtigungsrisiko; aufklappbare Faktoren; begründete Prüfvermerke je Tenant |
| Anmeldungen | Sieben Tage, maximal 1000 neueste Einträge, Länder-/Ereignisfilter, schematische Standortkarte, CSV; Begrenzung wird angezeigt |
| DSGVO-Check | Fünf technische Befundkategorien und zehn manuelle Maßnahmen; begründete Statusänderungen mit Benutzer/Zeitpunkt und gespeichertem Verlauf; Maßnahmenexport |
| Alarm-Regeln | Bereich, Mindestschweregrad, Anzahl, Aktivierung, Bearbeiten/Löschen, manuelle und automatische Auswertung nach Managed-Service-Lauf; interner Verlauf |
| Policy-Rollout | Vorhandene CA-Zustandsvorlagen erfassen, Zielmandanten wählen, pro Tenant vergleichen, Policy-Ausnahmen, explizite Aktivierungsfreigabe, Einzelresultate. Verwendet bestehende CA-APIs. |
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
- Der neue Multi-Tenant-Ablauf ändert Zustände bestehender CA-Policies. Er erzeugt keine neuen Länder-Policies, kopiert keine Tenant-IDs und legt keine fehlenden Policies an.
- CSV ist für Excel geeignet; es handelt sich nicht um native XLSX-Dateien. Formelanfänge werden neutralisiert.

## Betrieb und Berechtigungen

Alle neuen Routen liegen hinter dem bestehenden Session-Guard. Lokale Notizen, Alarmregeln, DMARC und Maßnahmen dürfen auch in einem Prüfmandat gespeichert werden; produktive Konto-/CA-Schreibaktionen bleiben gesperrt. Die neuen lokalen Daten liegen unter `tenant.cockpit` im bestehenden State und müssen zusammen mit diesem gesichert werden. XML-Rohdateien werden nicht gespeichert. Sign-in- und Identity-Antworten werden für die jeweilige Ansicht geladen.

Die bestehenden Graph-Application-Permissions und Zertifikate gelten weiter. MFA und [Sign-ins](https://learn.microsoft.com/en-us/graph/api/signin-list?view=graph-rest-1.0) benötigen `AuditLog.Read.All`, [Secure Score](https://learn.microsoft.com/en-us/graph/api/security-list-securescores?view=graph-rest-1.0) benötigt `SecurityEvents.Read.All`. Benutzer, Gruppen, Apps und Intune benötigen zusätzlich ihre jeweiligen Leserechte. Rechte werden durch diese Ansichten nicht automatisch erweitert; Fehler werden sichtbar ausgegeben.

Die Dependency-Locks wurden aktualisiert. `selfsigned` wurde auf die asynchrone v5-API umgestellt; beide Zertifikatswege verwenden den getesteten gemeinsamen Helfer mit RSA 2048, SHA-256 und 730 Tagen Laufzeit.

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
