# Dauerhafte Jobs, Tenant-Rollen und Synchronisierung

Stand: 23. Oktober 2026. Diese Erweiterung ist für die bestehende Installation mit **einer API-Instanz** ausgelegt. Sie verwendet Node.js ab 22.16 und die integrierte SQLite-API; CI prüft Node 22 und 24. Das Produktionsimage bleibt auf Node 22. SQLite kann je nach Runtime eine ExperimentalWarning ausgeben.

## Persistenz und Betrieb

`STATE_DIR/platform.sqlite` enthält Jobs, Leases, Rollen, Plattform-Journal, Quellzustände, Sign-in-Cursor und normalisierte Anmeldungen. SQLite verwendet WAL, FULL synchronous und einen Busy-Timeout. Die bisherigen Tenant-Konfigurationen, Zertifikate und Managed-Service-Artefakte bleiben an ihren bisherigen Orten. Der zentrale JSON-State wird über temporäre Datei und Rename ersetzt.

Das gesamte `STATE_DIR` muss auf dem vorhandenen persistenten Volume liegen. Compose und Helm verwenden bereits `/app/state`; API-Replikate bleiben auf eins. Kein geteiltes Netzwerk-Dateisystem und keine zweite API auf demselben State: SQLite-Leases ersetzen keine Mehrprozesskoordination der übrigen JSON-Dateien oder speichergebundenen Sessions. Eine Skalierung auf mehrere API-Instanzen erfordert eine weitere Migration, beispielsweise nach PostgreSQL, und einen gemeinsamen Session-Store.

Backup: API kontrolliert stoppen und anschließend das gesamte State-Verzeichnis samt Zertifikaten, JSON-Artefakten und vorhandenen SQLite-`-wal`/`-shm`-Dateien konsistent sichern. Eine laufende SQLite-Datei allein zu kopieren ist kein vollständiges Backup. Restore in ein leeres, abgeschottetes State-Verzeichnis; anschließend Datenbank mit `PRAGMA integrity_check` prüfen, Tenant-/Rollenzuweisungen und Jobhistorie kontrollieren. Ein restaurierter State darf nicht parallel zum Original gegen Microsoft oder Ticket-/Teams-Systeme arbeiten. Sessions überleben einen API-Neustart nicht; erneute Anmeldung ist erforderlich.

Jobs und Journal werden derzeit nicht automatisch gelöscht; die Ansichten zeigen die letzten 500 Jobs beziehungsweise 300 Journaleinträge. Speicherbedarf überwachen und vor Einführung einer Aufbewahrungsrichtlinie sichern. Sign-ins werden auf sieben Tage begrenzt, wenn diese Quelle erfolgreich synchronisiert wird.

## Rollen und erste Anmeldung

Der vorhandene lokale Admin bleibt Wiederherstellungszugang. Beim erstmaligen Anlegen der Datenbank wird `RBAC_BOOTSTRAP_ADMIN_UPN` als SSO-Plattformadmin eingetragen; ohne Variable gilt der vorhandene Betreiber `nils.lappenbusch@igeeks.ch`. Die Variable ist **nur ein einmaliger Bootstrap**, kein bei jedem Start wieder gesetztes Recht. Weitere SSO-Zuweisungen erfolgen unter „Zugriff & Tenant-Rollen“. Es werden keine Microsoft-Konten oder Graph-Consents angelegt.

| Rolle | Befugnis im zugewiesenen Tenant |
| --- | --- |
| Lesen | Freigegebene Cockpit-Daten, Jobs und Sync-Zustände ansehen |
| Operator | Zusätzlich Monitoring-Prüfungen starten, wartende Läufe abbrechen/wiederholen, Befunde und lokale Nachweise dokumentieren |
| Tenant-Admin | Zusätzlich Monitoring konfigurieren, Alarmregeln und freigegebene Konto-/CA-Aktionen verwalten |
| Plattform-Admin | Alle Tenants, globale Fachmodule, Rollen und Plattform-Journal |

Unbekannte und deaktivierte SSO-Benutzer haben keinen Tenant-Zugriff. Rechte werden bei jeder Anfrage und vor Ausführung eines manuellen Queue-Jobs neu geprüft. Eine laufende Anfrage wird durch nachträglichen Rechteentzug nicht rückwirkend zurückgenommen. Tenant-Listen und Job-/Fleet-Abfragen werden serverseitig gefiltert; nicht klassifizierte Routen bleiben Plattformadmins vorbehalten. Einige ältere Fachmodule sind deshalb für Mitglieder noch ausgeblendet. Bestehende Read-only-, Aktionsfreigabe- und Microsoft-Berechtigungsgrenzen gelten zusätzlich. MCP behält seine separate API-Key- und Tenant-Autorisierung.

## Job-Lebenszyklus

Monitoring läuft über eine dauerhafte Queue: wartend → läuft → abgeschlossen/teilweise/fehlgeschlagen. Zwei Tenants können parallel laufen, pro Tenant höchstens ein Collector-Lauf. Ein wartender Auftrag wird bei erneuter Anforderung zusammengeführt; ein abweichender Auftrag für einen bereits laufenden Tenant erhält einen Konflikt. Der Scheduler prüft alle 30 Sekunden die fälligen Quellen aktivierter Tenants.

Worker verwenden eine 120-Sekunden-Lease mit Heartbeat. Abgelaufene Leases werden nach einem Prozessabbruch wieder beansprucht; alte Worker dürfen ihren Job nicht mehr abschließen. Transiente Worker-Fehler werden mit Backoff bis zu drei Versuchen wiederholt. Quellfehler führen zu Teilergebnissen und einem getrennten Quell-Backoff; sie verwerfen nicht den letzten erfolgreichen Datenstand. 403-/Lizenzfehler pausieren eine Quelle länger. Ein manueller Wiederholungsauftrag startet einen neuen Versuchshaushalt unter dem anfordernden Benutzer.

Collector-Leseoperationen dürfen nach Abbruch erneut laufen. Quelle und globale Befunddateien sind nicht gemeinsam mit SQLite transaktional: Wiederholbare Erhebung und vollständige Sign-in-Commits begrenzen dieses Übergangsmodell. Abschluss-Checkpoints verhindern, dass bei unklarem Ticket-/Teams-Zustellstand blind erneut zugestellt wird; stattdessen ist der Lauf teilweise erfolgreich und verlangt Prüfung. Eine transaktionale Zustell-Outbox und garantierte Exactly-once-Zustellung sind **nicht** implementiert.

Ältere schreibende Fachmodul-Jobs werden mit bereinigter Zusammenfassung dauerhaft protokolliert, nach einem Neustart als unterbrochen markiert und nicht automatisch wiederholt. Vor manueller Neuausführung die tatsächliche Wirkung im Zielsystem kontrollieren. SIGTERM/SIGINT stoppt neue Arbeit und wartet bis zu 20 Sekunden auf laufende Jobs; danach greift bei Neustart die Lease-Wiederaufnahme.

## Synchronisierung und Anmeldungen

Jede Quelle führt letzten Versuch, letzten Erfolg, nächsten Versuch, Fehlerfolge und Datenalter. Initial werden vorhandene Quellzeitstempel übernommen; ein Neustart erfindet keinen aktuellen Datenstand. Explizit gespeicherte Bereichsauswahlen werden nicht automatisch erweitert: „Anmeldungen“ bei Bedarf in der Monitoring-Konfiguration auswählen oder einmal manuell starten.

Sign-ins werden alle zehn Minuten eingelesen, wenn diese Quelle aktiviert ist. Der erste Lauf lädt 24 Stunden; danach wächst das Archiv bis auf sieben Tage. Abrufe enden zwei Minuten vor der aktuellen Zeit und beginnen zehn Minuten vor dem Cursor, um verzögert eintreffende Ereignisse aufzufangen. Das ist keine vollständige Garantie gegen später als die Überlappung eintreffende Microsoft-Ereignisse. Bei längeren Ausfällen wird höchstens der noch verfügbare Sieben-Tage-Zeitraum nachgeholt.

Alle Seiten müssen erfolgreich sein, bevor Events und Cursor gemeinsam committed werden. Tenant-/Event-ID deduplizieren Wiederholungen. Fremde/cyclische Nextlinks, Seitenfehler oder Lease-Verlust lassen den Cursor unverändert; maximal 100 Seiten je Abruf. Die Ansicht liest das persistierte Archiv und zeigt höchstens die neuesten 1000 Ereignisse mit Begrenzungshinweis. Es wird kein universeller Graph-Delta-Endpunkt behauptet.

## Verifikation und verbleibende Abnahme

Automatisiert geprüft: konkurrierende Queue-Claims, Lease-Verlust, Neustart mit gleicher Datenbank, realer API-Neustart, sichere Behandlung alter Jobs, Berechtigungen pro Tenant und Job-ID, sofortige Sperrwirkung, Rollenentzug vor Ausführung, Scheduler/Worker-Integration, Retry-Grenzen, Quell-Backoff, Sign-in-Pagination, Deduplikation und unveränderter Cursor nach Fehlern.

Die Umsetzung wurde mit isolierten Testdaten geprüft. Die Live-Abnahme gegen einen Microsoft-Testtenant, reale Graph-Drosselung und der vollständige Backup-/Restore-Prozess im Zielcluster stehen noch aus. Ein Push dieses Featurebranches aktualisiert PR #4; erst ein Merge auf `main` startet das bestehende Produktionsdeployment.
