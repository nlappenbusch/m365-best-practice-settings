# Alarme und Benachrichtigungen

## Im Alltag

1. Unter **Befunde & Überwachung** die Quellen **Defender-Vorfälle** und **Sicherheitsänderungen (Entra)** aktivieren und den Zeitplan einschalten. Beide Quellen laufen dann alle zehn Minuten; bestehende explizite Bereichsauswahlen werden nicht erweitert. „Defender & Protokoll aktualisieren“ auf der Alarmseite startet einen einmaligen Abruf.
2. Unter **Alarm-Regeln** eine Vorlage auswählen: hohe Defender-Priorität, Rollenänderungen, App-Zustimmungen, App-Zugangsdaten oder Zugriffsrichtlinien. Schwellwert und bei Audit-Regeln das Zeitfenster prüfen.
3. **Teams benachrichtigen** bewusst aktivieren. Der bestehende globale Teams-Webhook im Service-Cockpit wird verwendet. Alte Regeln erhalten keine neuen Versandrechte durch das Update.
4. Befunde, Bearbeitungsstatus und Notizen bleiben in **Befunde & Überwachung**. Die Alarmseite zeigt Regeln, Zustandsänderungen und Zustellversuche.

Ein anhaltender Schwellwertverstoß erzeugt einen Alarm. Zwei verschiedene erfolgreiche, aktuelle Datenstände unter dem Schwellwert schließen ihn. Wiederholtes Klicken auf „Regeln prüfen“ zählt nicht als neue Erhebung. Fehler und veraltete Quellen verhindern die Entwarnung. Bei Regeln für alle Bereiche zählen die konfigurierten Überwachungsbereiche; jeder davon muss aktuell prüfbar sein.

Bei Audit-Regeln bedeutet „unter Schwellwert“ nur, dass weniger Ereignisse im Zeitfenster liegen. Es bedeutet nicht, dass eine Rollenvergabe oder Zustimmung rückgängig gemacht wurde. Audit-Befunde bleiben nach Ablauf des Quellenarchivs erhalten und können quittiert oder kommentiert werden. Audit-Ereignisse erzeugen keine automatischen SDP-Tickets; ein Ticket kann nach Prüfung manuell erstellt werden.

## Microsoft-Anbindung

Es werden ausschließlich lesende Microsoft-Graph-v1.0-Aufrufe verwendet:

- [Defender-Alarme: SecurityAlert.Read.All](https://learn.microsoft.com/en-us/graph/api/security-list-alerts_v2?view=graph-rest-1.0)
- [Defender-Incidents: SecurityIncident.Read.All](https://learn.microsoft.com/en-us/graph/api/security-list-incidents?view=graph-rest-1.0)
- [Entra-Verzeichnisaudit: AuditLog.Read.All](https://learn.microsoft.com/en-us/graph/api/directoryaudit-list?view=graph-rest-1.0)

Die beiden Defender-Leserechte sind in den Onboarding-/Reparaturdefinitionen ergänzt. Bestehende App-Registrierungen benötigen gegebenenfalls erneute Administratorzustimmung. Das Deployment selbst erteilt keine Rechte. Fehlender Consent oder fehlende Produktverfügbarkeit werden als Quellenfehler dargestellt, niemals als „keine Vorfälle“.

„Audit“ meint hier Entra Directory Audits, nicht das vollständige Purview Unified Audit Log. Letzteres bleibt im bestehenden Protokollbereich. Erkannte erfolgreiche Sicherheitsänderungen sind Rollenänderungen, App-Consents/Berechtigungsvergaben, App-Zugangsdaten und Conditional-Access-Änderungen. Die Klassifikation nutzt Kategorie und Aktivitätsnamen und deckt nicht sämtliche Microsoft-Aktivitäten ab. Unbekannte Aktivitätstypen bleiben im Quellenarchiv, erzeugen aber keine dieser Vorlagenmeldungen.

## Dauerhaftigkeit und Datenstände

Neue Tabellen liegen in der bestehenden SQLite-Plattformdatenbank, mit deren WAL-/Backup-Verfahren. Quellen-IDs sind pro Tenant und Quelle eindeutig. Keine neue Datenbank oder zweite Job-Queue für Erhebungen.

Defender liest beide Collections vollständig über alle Seiten (maximal 100 Seiten pro Collection). Nur wenn beide Abrufe erfolgreich sind, werden ihre normalisierten Zustände gespeichert. Ein Alert mit bekanntem Incident wird unter diesem Incident dargestellt. Nicht mehr zurückgelieferte offene Objekte bleiben als unbestätigte offene Fälle erhalten; nur ein expliziter Microsoft-Status `resolved` gilt als geschlossen. Die API-Aufbewahrung kann die Abrufbarkeit älterer Objekte begrenzen.

Entra-Audit startet mit 24 Stunden, verwendet danach einen Cursor mit zehn Minuten Überlappung und zwei Minuten Sicherheitsabstand. Nach längeren Pausen werden höchstens sieben Tage nachgeladen; eine größere Lücke wird sichtbar benannt. Cursor und deduplizierte Einträge werden atomar erst nach vollständiger Pagination gespeichert. Ungültige Antworten, fremde Folgelinks und verlorene Worker-Leases verhindern den Commit. Audit-Quelldaten werden 30 Tage gespeichert. Es werden keine Credential-Werte oder vollständigen modifiedProperties übernommen.

Alarmzustand, Zustandswechsel und zugehöriger Benachrichtigungsauftrag werden in einer SQLite-Transaktion gespeichert. Der Verlauf hält 180 Tage. Alte Prüfzeilen aus `tenant.cockpit.alarmHistory` bleiben gespeichert, sind aber keine neuen Alarmepisoden. Die bisherigen einfachen Schwellwertprüfungen sind durch die gemeinsame Engine ersetzt.

## Zustellung

Die neue Outbox stellt Teams-Karten unabhängig vom Erhebungsjob zu. Auch die bisherigen direkten Monitoring-Teams-Meldungen laufen darüber. Ein expliziter Benachrichtigungs-Findingsregelbereich ersetzt die direkten Meldungen für diesen Bereich; Defender und Audit werden ausschließlich über ausdrücklich aktivierte Benachrichtigungsregeln gemeldet.

- Zustände: wartet, wird gesendet, erneuter Versuch, angenommen, fehlgeschlagen, Ziel prüfen.
- 15 Sekunden Request-Timeout; 60 Sekunden Lease mit eindeutiger Besitzerkennung; Neustarts geben abgelaufene Leases wieder frei.
- HTTP 429/5xx und Netzwerkfehler: höchstens acht Versuche mit exponentiellem Backoff; `Retry-After` wird berücksichtigt (maximal 24 Stunden).
- Andere HTTP-Fehler: sichtbar fehlgeschlagen, kein automatisches Wiederholen. Redirects werden nicht verfolgt.
- Ein fehlendes oder verändertes Teams-Ziel blockiert den Auftrag. Ein Tenant-Manager kann nach Prüfung zum aktuellen globalen Ziel erneut senden. Fremde Tenant-Aufträge sind nicht zugänglich.
- Webhook-Secrets werden nicht in die Outbox oder API-Antwort kopiert; der Auftrag bindet sich an einen Hash des Ziels. Fehlermeldungen enthalten keine Ziel-URL.

**Zustellgarantie:** dauerhafte Aufträge mit begrenzten Wiederholungen, keine Exactly-once-Garantie. Bei Timeout oder Absturz nach erfolgreicher Annahme kann ein erneuter Versand doppelt ankommen. Die Meldungs-ID bleibt gleich und wird im Header und in der Karte mitgegeben. Teams muss diesen Schlüssel nicht deduplizieren. HTTP-Erfolg bestätigt nur die Annahme des Webhooks, nicht die tatsächliche Anzeige oder das Lesen im Kanal. „Erneut senden“ ist deshalb eine bewusste Manager-Aktion.

Die SDP-Ticketautomatik nutzt weiterhin ihren bestehenden Unterbrechungsschutz und ist nicht Teil der neuen Outbox. SMTP, tenantindividuelle Empfänger und freie Webhook-Ziele sind in diesem Ausbau nicht hinzugefügt. Bereits vorgemerkte Meldungen bleiben bei Regeländerung/-löschung erhalten. Zustellaufträge werden derzeit nicht automatisch gelöscht; diese Tabelle gehört in die Größenüberwachung und Sicherung der Plattform.

## Prüfung und Einführung

Automatisierte Tests prüfen Klassifikation, Deduplikation, Teilfehler, Cursor, Incident-Bündelung, Alarm-/Outbox-Atomarität, veraltete Daten, doppelte Prüfungen, Wiederöffnung, Neustart, Lease-Fencing, 429, Timeout, permanente Fehler und Tenant-Rechte. Die vorhandene Worker-Integration wird mit einem tatsächlichen HTTP-Job geprüft. UI-Prüfung erfolgt mit Testdaten, ohne produktive Microsoft-Aufrufe oder echte Teams-Nachrichten.

Vor produktiver Aktivierung: lesenden Consent und Defender-Verfügbarkeit im Testtenant prüfen, Quellen abrufen, eine konkrete Regel speichern und eine Testzustellung im vorgesehenen Teams-Kanal kontrollieren. Es wird durch diese Entwicklung keine erfolgreiche Live-Abnahme behauptet.

Konzeptionelle Referenz: [Vigil365 AlarmEvaluator](https://github.com/sameerk27/vigil365/blob/9fda3160a44c76ee9b3064a9caf11e0f4b5922c0/src/M365SecurityDashboard.Api/Services/AlertEvaluator.cs). Umsetzung im bestehenden Node-/Svelte-Tool, ohne Übernahme der fremden Laufzeit.
