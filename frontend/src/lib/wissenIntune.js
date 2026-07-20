// Wissen-Inhalte rund um Intune/Autopilot: Blueprint, OpenIntuneBaseline (OIB)
// und Gruppen-/Namenskonzept. Reiner Lesestoff (statisch), abgeglichen mit dem,
// was der Tab 🚀 Autopilot / 💻 Intune im Tool bereits automatisiert.

export function autopilotHtml() {
  return `
<h3>🎯 In einem Satz</h3>
<p>Jedes neue Gerät bekommt beim Setup einen <b>GroupTag</b> (eine Art Versandetikett). Dieses Etikett sortiert
das Gerät automatisch in die richtige Gruppe — und diese Gruppe zieht dann von allein das passende Windows-Setup
und alle Sicherheitseinstellungen nach. Der Techniker wählt also nur ein Etikett aus einem Menü, der Rest passiert
automatisch — ohne Login, ohne Passwort, ohne MFA am Gerät.</p>

<div class="tool-tie-in">
  <span>🛠️</span>
  <div><b>So macht das unser Tool:</b> Der komplette Admin-Einmal-Setup aus „Teil A" unten (App-Registrierung mit
  Zertifikat, Staging-Wrapper, autounattend.xml, WLAN-Einbettung) wird nicht mehr manuell aus dem GitHub-Repo
  zusammengebaut — der Tab <b>🚀 Autopilot → 📦 Staging-Paket</b> erzeugt das komplette, fertige ZIP pro Tenant
  per Klick (inkl. Device-Code-Login statt Client-Secret-im-Klartext-Problem). Deployment-Profile weist man im
  selben Tab unter <b>🎯 Deployment-Profile</b> zu, OIB-Policies im Tab <b>💻 Intune</b>. Der Abschnitt „Teil A" unten
  bleibt als Referenz stehen, falls man den manuellen Weg (z.B. für Bulk-Staging ohne das Tool) verstehen oder
  nutzen möchte — im Alltag braucht es ihn nicht mehr.</div>
</div>

<h3>🔗 Die Kette (so hängt alles zusammen)</h3>
<pre>   Gerät
     │   im OOBE: Stick rein, Skript starten, GroupTag aus Menü wählen
     ▼
   GroupTag  z.B.  DEV-STD           ← das Einzige, was pro Gerät gewählt wird
     │   wird automatisch erkannt (OrderID)
     ▼
   Gruppe    z.B.  AAD-DEV-STD       ← Gerät rutscht automatisch rein
     │
     ├──►  Autopilot-Profil + ESP    ← steuert das Windows-Setup (OOBE)
     └──►  alle Policies (OIB)        ← Sicherheit, Apps, Updates</pre>
<p><b>Merksatz:</b> Ein GroupTag = ein komplett fertig eingerichtetes Gerät.</p>

<h3>👥 Zwei Rollen — wer macht was?</h3>
<table class="comparison-table">
  <thead><tr><th></th><th>Admin (einmalig)</th><th>Techniker (pro Gerät)</th></tr></thead>
  <tbody>
    <tr><td><b>Aufgabe</b></td><td>Tenant onboarden, Staging-Paket bauen, Profil/Policies zuweisen</td><td>Gerät via ZIP/Stick in Autopilot bringen</td></tr>
    <tr><td><b>Wie oft</b></td><td>Einmal pro Tenant/GroupTag</td><td>Pro Gerät, ~5 Min</td></tr>
    <tr><td><b>Abschnitt</b></td><td>Teil A</td><td>Teil B</td></tr>
  </tbody>
</table>
<p><b>Wichtigster Punkt:</b> Teil A wird einmal gemacht (heute: im Tool). Danach fasst im Alltag niemand mehr
Gruppen, App oder Policies an — nur noch Teil B mit dem fertigen ZIP/Stick.</p>

<h3>⚙️ Teil A — Einmal-Setup (Admin)</h3>
<h4>A1. Staging-Paket erzeugen</h4>
<p>Im Tool: Tab <b>🏢 Tenants</b> → Tenant onboarden/aktiv wählen → Tab <b>🚀 Autopilot</b> → GroupTags auswählen →
„📦 Paket erstellen". Die Admin-Anmeldung läuft per Device-Code (kein Secret manuell tippen); das Tool legt eine
dedizierte App-Registrierung <code>IG-Autopilot-Staging</code> an (Client Secret + Zertifikat, nur die für
Autopilot nötigen Berechtigungen), baut das HWID-Import-Skript, den Staging-Wrapper mit Auswahlmenü der gewählten
GroupTags, ein Start-Skript, die <code>autounattend.xml</code> (optional mit eingebettetem WLAN-Profil) und eine
WIM-Bau-Anleitung — alles fertig gezippt zum Download.</p>

<h4>A2. Pro GroupTag eine dynamische Gruppe anlegen</h4>
<p>Intune → Gruppen → Neue Gruppe → Typ <i>Sicherheit</i>, Mitgliedschaft <i>Dynamisches Gerät</i>, Regel
(Beispiel für <code>DEV-STD</code>):</p>
<pre>(device.devicePhysicalIds -any (_ -eq "[OrderID]:DEV-STD"))</pre>
<p>Intunes Feld „Group Tag" heisst intern <code>OrderID</code> — die Regel muss exakt darauf matchen
(Gross-/Kleinschreibung beachten), sonst bleibt die Gruppe leer. Namenskonvention und GroupTag-Zuordnung: siehe
Abschnitt „🏷️ Namenskonventionen" in diesem Wissen-Bereich.</p>

<h4>A3. Autopilot-Profil + ESP der Gruppe zuweisen</h4>
<p>Im Tool: Tab <b>🚀 Autopilot → 🎯 Deployment-Profile</b> — Profil auswählen, Zielgruppe wählen, zuweisen. Die
Enrollment Status Page (der Ladebalken, der das Gerät erst nach vollständiger Einrichtung freigibt) wird separat
im Intune-Portal derselben Gruppe zugewiesen.</p>

<h4>A4. Policies der Gruppe zuweisen (OIB)</h4>
<p>Im Tool: Tab <b>💻 Intune</b> — siehe Abschnitt „💻 OpenIntuneBaseline" in diesem Wissen-Bereich für Details
und die dort markierten Break-Risk-Policies.</p>

<h3>🧑‍🔧 Teil B — Feld-Runbook: neues Gerät aufsetzen (Techniker)</h3>
<p><b>Bevor du anfängst:</b> das neue Gerät (Netzteil dran), Netzwerk (LAN-Kabel oder WLAN — Gerät MUSS online
sein), das ZIP aus dem Tab 🚀 Autopilot (oder der fertig bestückte USB-Stick daraus). Kein Login nötig — die
App-Anmeldung steckt im Paket.</p>
<ol>
  <li>Gerät einschalten, bis der erste Setup-Bildschirm kommt (Sprache/Region). Hier nicht weiterklicken.</li>
  <li>USB-Stick/Medium mit dem entpackten ZIP einstecken.</li>
  <li><b>Umschalt (Shift) + F10</b> drücken → schwarzes Eingabefenster öffnet sich.</li>
  <li>Den Laufwerksbuchstaben finden und das Start-Skript ausführen (oft <code>D:</code> oder <code>E:</code>):
    <pre>E:
cd \\Autopilot
Start-Autopilot.bat</pre>
  </li>
  <li>Im Menü GroupTag auswählen (Zahl eingeben), z.&nbsp;B. <code>1</code> für <code>DEV-STD</code>.</li>
  <li>Warten, bis „Autopilot-Import erfolgreich abgeschlossen" erscheint. Das Skript meldet sich app-only an
    (kein Login-Fenster) und legt HWID-CSV + Log auf dem Medium ab.</li>
  <li>Gerät neu starten. Beim nächsten Hochfahren zieht es automatisch sein Setup — ab hier läuft alles von
    allein bis zum fertigen, verwalteten Gerät.</li>
</ol>

<h4>✅ Erfolg sieht so aus</h4>
<ul>
  <li>Im Fenster: „Autopilot-Import erfolgreich abgeschlossen".</li>
  <li>Auf dem Medium liegt <code>HWID-&lt;Seriennr&gt;-&lt;Datum&gt;.csv</code> und <code>logs\\autopilot-log.txt</code>.</li>
  <li>In Intune (Geräte → Windows Autopilot) erscheint das Gerät mit dem gewählten GroupTag; nach ein paar
    Minuten ist es in der passenden Gruppe.</li>
</ul>

<h4>⚠️ Wenn's klemmt</h4>
<table class="comparison-table">
  <thead><tr><th>Problem</th><th>Ursache</th><th>Lösung</th></tr></thead>
  <tbody>
    <tr><td>Fehler beim Import / Timeout</td><td>Keine Internetverbindung</td><td>Netzwerk prüfen, im OOBE WLAN verbinden, erneut starten</td></tr>
    <tr><td>Konfigurationsdatei nicht gefunden</td><td>Falscher Ordner</td><td>Erst <code>cd \\Autopilot</code> auf dem Medium-Laufwerk</td></tr>
    <tr><td>Import OK, aber Gerät zieht Setup nicht</td><td>Gruppen-Aufnahme dauert noch</td><td>5–10 Min warten, dann neu starten</td></tr>
    <tr><td>Gerät landet in keiner Gruppe</td><td>GroupTag ohne passende dyn. Gruppe</td><td>In A2 fehlt die Gruppe zu diesem Tag</td></tr>
  </tbody>
</table>

<h3>💽 Optional: vollautomatisches Installationsmedium (für Mengen-Staging)</h3>
<p>Damit am Gerät gar nichts mehr getippt wird (auch kein WLAN-Passwort), kann ein angepasstes
Windows-Installationsmedium gebaut werden:</p>
<ul>
  <li><code>autounattend.xml</code> — wird vom Tool bereits automatisch erzeugt: deutsche UI, Schweizer
    Locale/Tastatur, automatische Partitionierung (GPT, ESP 300&nbsp;MB, Auto-Wipe), Zufalls-Computername (damit
    Intune die Namensvergabe übernimmt), <b>ohne AutoLogon</b> (Anmeldung erfolgt über Autopilot/den M365-User),
    optional mit eingebettetem WLAN-Profil.</li>
  <li><code>Build-Windows11-WIM-NetFx3.ps1</code> — injiziert WLAN-/LAN-/Storage-Treiber rekursiv in
    <code>install.wim</code> (optional <code>boot.wim</code>) und integriert .NET&nbsp;3.5.</li>
</ul>
<p>Ergebnis: Gerät bootet, verbindet WLAN selbst, kommt klickfrei ins OOBE — dort dann weiter mit Teil B.</p>

<h3>🔒 Sicherheits- &amp; Verbesserungshinweise</h3>
<div class="alert alert-warning">
  <strong>⚠️ Hochprivilegiertes Secret im Paket.</strong> Das Staging-ZIP enthält ein Client Secret im Klartext.
  Die tenant-eigene <code>IG-Autopilot-Staging</code>-App ist bereits enger gescoped als eine geteilte
  Community-App, aber ein verlorenes Medium bleibt ein Tenant-Risiko: ZIP/Stick wie ein Geheimnis behandeln,
  nach Gebrauch einziehen bzw. löschen, Secret-Laufzeit kurz halten.
</div>
<div class="alert alert-info">
  <strong>ℹ️ GroupTags zentral pflegen.</strong> Die im Staging-Paket angebotenen GroupTags und die dynamischen
  Gruppen (A2) müssen synchron sein. Am besten GroupTag-Liste + Gruppen + Profil-/Policy-Zuweisung als eine
  Checkliste führen, sonst landet ein Gerät „in keiner Gruppe".
</div>

<h3>🏷️ Namenskonvention (Kurzform)</h3>
<table class="comparison-table">
  <thead><tr><th>Element</th><th>Beispiel</th><th>Bedeutung</th></tr></thead>
  <tbody>
    <tr><td>Gruppe</td><td><code>AAD-DEV-STD</code></td><td>AAD = cloud-native Entra-Gruppe, DEV = Gerätegruppe, STD = Rolle (Standard-Client)</td></tr>
    <tr><td>GroupTag (OrderID)</td><td><code>DEV-STD</code> / <code>DEV-PROD</code></td><td>Gruppensuffix ohne <code>AAD-</code>; steuert, in welche Gruppe das Gerät fällt</td></tr>
  </tbody>
</table>
<p>Vollständig im Abschnitt „🏷️ Namenskonventionen" dieses Wissen-Bereichs.</p>

<h3>📎 Referenz: manueller Weg ohne das Tool</h3>
<p>Der ursprüngliche, tool-unabhängige Weg (eigene App-Registrierung <code>createApp.ps1</code>, USB-Stick mit
<code>Start-Autopilot.bat</code> / <code>Run-AutopilotWithExternalAppConfig.ps1</code> /
<code>get-windowsautopilotinfocommunity.ps1</code> / <code>wrapper-config.json</code>) bleibt als Fallback nutzbar
und liegt im Repo <a href="https://github.com/nlappenbusch/IntuneAutopilot" target="_blank">nlappenbusch/IntuneAutopilot</a>.
Die auswählbaren GroupTags stehen dort im Skript <code>Run-AutopilotWithExternalAppConfig.ps1</code> in der Zeile
<code>$availableGroupTags = @(...)</code> — bei Umstellung auf neue Rollen/Namen bitte synchron mit den
dynamischen Gruppen halten. Für den Alltag ist das Staging-Paket aus dem Tool jedoch der kürzere, sicherere Weg.</p>
`
}

// ---------- OpenIntuneBaseline (OIB) ----------
export function oibHtml() {
  return `
<h3>🎯 Zielsetzung</h3>
<p>Dieser Abschnitt begründet den Einsatz der <b>OpenIntuneBaseline (OIB)</b> als primäres Sicherheits-Framework
für unsere Windows-Endgeräte. Die implementierte Konfiguration basiert auf einer Analyse etablierter
Sicherheitsstandards (v.&nbsp;a. CIS), weicht aber aus dokumentierten Gründen der Betriebsfähigkeit,
Cloud-Architektur und modernen Nutzererfahrung bewusst in definierten Punkten von einer 100%igen
Benchmark-Umsetzung ab.</p>
<div class="alert alert-info">
  <strong>Kernaussage:</strong> Die Abweichungen (das „Delta") sind keine Sicherheitslücken, sondern bewusste
  Architekturentscheidungen — vollständig dokumentiert, fachlich begründet und durch alternative
  Sicherheitsmaßnahmen kompensiert.
</div>

<div class="tool-tie-in">
  <span>🛠️</span>
  <div><b>So macht das unser Tool:</b> Die Zuweisung aller <code>Win - OIB - *</code>-Policies an die passende
  dynamische Gerätegruppe läuft über den Tab <b>💻 Intune</b> (Merge-Zuweisung, „bereits zugewiesen"-Erkennung).
  Die vier bekannten <b>Break-Risk-Policies</b> (Abschnitt „⚠️ Policies mit Break-Risiko" unten) sind dort direkt
  in der Liste markiert und lösen vor dem Zuweisen einen zusätzlichen Bestätigungsdialog mit der konkreten
  Risikobeschreibung aus.</div>
</div>

<h3>📐 Geltungsbereich</h3>
<table class="comparison-table">
  <thead><tr><th>In Scope</th><th>Out of Scope</th></tr></thead>
  <tbody>
    <tr><td>Windows 11 Enterprise, Intune-verwaltet, Entra-ID-joined (Cloud-only), Windows Autopilot, Standardbenutzer (kein lokaler Admin)</td>
        <td>On-Premises-AD-Geräte, Hybrid Azure AD Join, Server (Windows Server), macOS/Linux/Mobile</td></tr>
  </tbody>
</table>

<h3>⚖️ OIB vs. Microsoft-Baseline vs. CIS-Benchmark</h3>
<table class="comparison-table">
  <thead><tr><th>Kriterium</th><th>OIB</th><th>Microsoft Baseline</th><th>CIS Benchmark</th></tr></thead>
  <tbody>
    <tr><td>Autopilot-Stabilität</td><td>Kein Neustart, stabil</td><td>Neustart erforderlich</td><td>Bricht Autopilot ab</td></tr>
    <tr><td>MFA-Anforderungen</td><td>1× zusätzlich (WHfB)</td><td>Bis zu 3× MFA</td><td>Bis zu 3× MFA + Strg+Alt+Entf</td></tr>
    <tr><td>App-Konfiguration</td><td>Edge/Outlook/OneDrive automatisch</td><td>Manuelle Anmeldung</td><td>Manuelle Anmeldung</td></tr>
    <tr><td>BitLocker</td><td>Funktionsfähig</td><td>Nicht enthalten</td><td>Enthalten, funktioniert nicht</td></tr>
    <tr><td>Helpdesk-Support (UAC)</td><td>Erlaubt</td><td>Blockiert</td><td>Blockiert</td></tr>
    <tr><td>Richtlinien-Konflikte</td><td>Keine</td><td>Defender vs. Windows Baseline</td><td>WUfB-Konflikte</td></tr>
  </tbody>
</table>

<h3>📋 Das CIS-Delta (Auszug — bewusste Abweichungen)</h3>
<p>Jede Abweichung erfüllt drei Kriterien: dokumentiert, fachlich begründet, durch alternative Maßnahmen
kompensiert.</p>
<table class="comparison-table">
  <thead><tr><th>Bereich</th><th>Beispiel-Control</th><th>Warum nicht umgesetzt</th><th>Kompensation</th></tr></thead>
  <tbody>
    <tr><td>Eigene Risiken vermeiden</td><td>Command-Line-Logging, PowerShell-Transkription</td><td>Credentials/Tokens landen im Klartext in Logs</td><td>Microsoft Defender for Endpoint (EDR, zentral, manipulationssicher)</td></tr>
    <tr><td>Autopilot-Betriebsfähigkeit</td><td>AutoAdminLogon deaktivieren, Anmeldetext/-titel</td><td>Bricht Pre-Provisioning/Autopilot vollständig ab</td><td>AutoLogon nach Enrollment nicht mehr nötig; Nutzungsrichtlinie rechtlich abgesichert</td></tr>
    <tr><td>Moderne Identität (WHfB)</td><td>Passwort-Policies (Länge/Alter/Komplexität), „STRG+ALT+ENTF erzwingen"</td><td>Zerstört WHfB-UX, redundant bei Cloud-Identity</td><td>Windows Hello for Business + MFA + Conditional Access</td></tr>
    <tr><td>IT-Support (BAU)</td><td>UAC: Erhöhung für Standardbenutzer automatisch ablehnen</td><td>Blockiert Helpdesk, LAPS nicht nutzbar</td><td>UAC bleibt kontrolliert nutzbar</td></tr>
    <tr><td>Irrelevanz Cloud-Architektur</td><td>UNC-Härtung, GPO-Hintergrundverarbeitung, NTLM-/PKU2U-Auditing</td><td>Kein lokales AD, kein SYSVOL, kein GPO-Management</td><td>Technisch nicht anwendbar (Entra-only)</td></tr>
    <tr><td>Modernes Update-Management</td><td>Feature-/Quality-Update-Deferrals, Neustart-Steuerung</td><td>Starr, keine Ring-Steuerung</td><td>Windows Autopatch / Windows Update for Business Rings</td></tr>
  </tbody>
</table>
<p class="note">CIS plant, die klassischen Passwort-Richtlinien im nächsten Benchmark selbst zu entfernen — sie
gelten für moderne Cloud-Umgebungen als überholt.</p>

<h3>🧩 Kompensierende Maßnahmen im Überblick</h3>
<table class="comparison-table">
  <thead><tr><th>Maßnahme</th><th>Kompensiert</th></tr></thead>
  <tbody>
    <tr><td>Microsoft Defender for Endpoint (EDR)</td><td>PowerShell-/Command-Line-Logging, Malware Detection</td></tr>
    <tr><td>Conditional Access</td><td>Passwort-Policies, Netzwerk-Controls</td></tr>
    <tr><td>MFA + Windows Hello for Business</td><td>Passwort-Komplexität/-Länge, lokale Anmelde-Restriktionen</td></tr>
    <tr><td>BitLocker + LAPS</td><td>Datenschutz bei Verlust, lokale Admin-Sicherheit</td></tr>
    <tr><td>Windows Autopatch / WUfB</td><td>Starre Update-Deferrals</td></tr>
    <tr><td>ASR-Regeln + SmartScreen + Credential Guard</td><td>Exploit-Schutz, Phishing/Malware, Credential-Diebstahl</td></tr>
  </tbody>
</table>

<h3>🗺️ ISO/IEC 27001 Mapping (Auszug, Annex A / 2022)</h3>
<table class="comparison-table">
  <thead><tr><th>ISO Control</th><th>Beschreibung</th><th>Umsetzung</th></tr></thead>
  <tbody>
    <tr><td>A.5.15–A.5.20</td><td>Access Control / Identity / Privileged Access</td><td>Entra ID + Conditional Access + Intune Compliance + LAPS + PIM (falls lizenziert)</td></tr>
    <tr><td>A.8.1, A.8.7–A.8.9</td><td>Endpoint Devices, Malware, Vulnerability-, Configuration-Mgmt</td><td>Intune + OIB Baseline + Autopilot + Defender AV/ASR + Autopatch</td></tr>
    <tr><td>A.8.24–A.8.25</td><td>Cryptography, Key Management</td><td>BitLocker (AES-256) mit TPM, Entra-ID-Recovery-Key-Escrow</td></tr>
    <tr><td>A.8.20–A.8.22</td><td>Network/Segmentation</td><td>Defender Firewall (OIB-konfiguriert), Conditional Access</td></tr>
    <tr><td>A.8.15–A.8.16, A.5.7</td><td>Logging, Monitoring, Threat Intelligence</td><td>Defender for Endpoint zentral (statt lokalem PowerShell-Logging)</td></tr>
    <tr><td>A.5.1, A.5.36</td><td>Policies, Compliance</td><td>Dieses Dokument + Intune Compliance Policies</td></tr>
  </tbody>
</table>

<h3>❓ Auditor-Q&amp;A (Auszug)</h3>
<p><b>Warum nicht 100&nbsp;% CIS?</b> CIS ist ein Empfehlungskatalog, kein zwingender Standard. Alle Controls
wurden bewertet und an die cloud-native Architektur angepasst; nicht anwendbare oder geschäftskritische Controls
sind dokumentiert und durch alternative Maßnahmen ersetzt — CIS selbst empfiehlt dieses Vorgehen.</p>
<p><b>Ist das Sicherheitsniveau wirklich gleichwertig?</b> Ja — lokale Controls werden durch überlegene zentrale
Mechanismen ersetzt (Entra ID, Defender for Endpoint, Conditional Access, WHfB). In vielen Bereichen ist das
Ergebnis strenger als eine ungeprüfte 1:1-CIS-Umsetzung.</p>
<p><b>Warum kein lokales PowerShell-Logging?</b> CIS selbst dokumentiert das Credential-Exposure-Risiko bei
aktivierter Transkription. Defender for Endpoint bietet zentrales, manipulationssicheres Monitoring — der
sicherere Ansatz.</p>
<p><b>Warum ist UAC nicht restriktiver?</b> Volle Blockade würde LAPS, Remote-Diagnose und Fehlerbehebung in der
Benutzersitzung verhindern. UAC wird kontrolliert statt blockiert konfiguriert.</p>

<h3>🏷️ Policy-Präfixe je Typ</h3>
<table class="comparison-table">
  <thead><tr><th>Policy-Typ</th><th>Präfix</th><th>Beschreibung</th></tr></thead>
  <tbody>
    <tr><td>Endpoint Security</td><td><code>Win - OIB - ES</code></td><td>Antivirus, Firewall, Disk Encryption etc. (Endpoint-Security-Blade)</td></tr>
    <tr><td>Settings Catalog</td><td><code>Win - OIB - SC</code></td><td>Geräteverwaltung &amp; Nutzererfahrung</td></tr>
    <tr><td>Compliance Policies</td><td><code>Win - OIB - Compliance</code></td><td>Geräte-Compliance-Anforderungen &amp; Health-Checks</td></tr>
    <tr><td>Device Configuration</td><td><code>Win - OIB - TP</code></td><td>Legacy-Geräte-Konfigurationsprofile</td></tr>
    <tr><td>Update Policies</td><td><code>Win - OIB - WUfB</code></td><td>Windows Update for Business (nicht ausrollen, wenn Autopatch genutzt wird)</td></tr>
    <tr><td>Driver Update Policies</td><td><code>Win - OIB - WUfB Drivers</code></td><td>Treiber-Updates via WUfB (nicht ausrollen, wenn Autopatch genutzt wird)</td></tr>
  </tbody>
</table>
<p class="note">Policies bestehen teilweise redundant für neuere/ältere Windows-Versionen. Da wir in der Regel
Windows-Builds neuer als 24H2 einsetzen, jeweils diese Variante ausrollen.</p>

<h3>🔗 Zuweisungslogik: GroupTag → dynamische Gruppe → Policies</h3>
<p>Jedes Gerät trägt einen GroupTag, der bereits beim Autopilot-/Enrollment-Prozess gesetzt wird. Über eine
dynamische Mitgliedschaftsregel wird das Gerät automatisch Mitglied der passenden Sicherheitsgruppe. Die
Policy-Zuweisung erfolgt anschliessend nicht pro Gerät, sondern ausschliesslich an diese dynamischen
Gerätegruppen — Details siehe „🏷️ Namenskonventionen".</p>
<pre>(device.devicePhysicalIds -any (_ -eq "[OrderID]:DEV-STD"))   →   AAD-DEV-STD</pre>

<h3>⚠️ Policies mit Break-Risiko (vor dem Enforce testen)</h3>
<p>Folgende Policies können bestehenden Zugriff brechen und sollten vor dem scharfen Ausrollen getestet werden
(wo möglich zuerst Audit-Mode/Audit-Logs nutzen, Legacy-Abhängigkeiten klären, dann enforcen). Der Tab
<b>💻 Intune</b> markiert genau diese vier Policies automatisch.</p>
<table class="comparison-table">
  <thead><tr><th>Policy</th><th>Bricht potenziell</th><th>Risiko</th></tr></thead>
  <tbody>
    <tr><td>Network Security – D – Disable NTLM</td><td>RDP per IP, Legacy-Apps/-Dienste mit NTLM</td><td><span class="risk-badge hoch">Hoch</span></td></tr>
    <tr><td>Device Security – D – Local Security Policies (24H2+)</td><td>Alte NAS/Drucker/SMBv1, LAN-Manager-/SMB-Signing-Auth</td><td><span class="risk-badge hoch">Hoch</span></td></tr>
    <tr><td>Device Security – U – Device Guard, Credential Guard &amp; HVCI</td><td>NTLMv1-SSO, RDP/VPN/802.1x mit Passwort-SSO, gespeicherte RDP-Creds, inkompatible Treiber</td><td><span class="risk-badge hoch">Hoch</span></td></tr>
    <tr><td>Device Security – D – Remote Desktop Services and RPC</td><td>RDP, Legacy-RPC-Apps</td><td><span class="risk-badge hoch">Hoch</span></td></tr>
  </tbody>
</table>

<h3>🛠️ Praktische Anwendung: So arbeitet man mit OIB</h3>
<p>OIB ist eine modulare Sammlung von Intune-Konfigurationen als „known-good"-Baseline. Grundprinzip: in drei
Schritten arbeiten — <b>Importieren → Zuweisen (Pilot) → Ausweiten (Rollout)</b>.</p>
<ol>
  <li><b>Baseline beziehen:</b> OIB aus der offiziellen Quelle importieren, Version/Release-Notes nachvollziehen.</li>
  <li><b>Pilot-Import:</b> Policies in Intune einspielen, Namenskonventionen konsistent halten.</li>
  <li><b>Nur an Pilot-Gruppen zuweisen:</b> Geräte-/Benutzergruppen für den Pilot definieren, schrittweise
    aktivieren (Konflikte bei Defender/BitLocker/ASR früh erkennen).</li>
  <li><b>Konflikt- &amp; Wirkungsprüfung:</b> Intune Policy Conflicts/Device Status, Defender ASR-Events/Alerts,
    Autopilot Pre-Provisioning + User-Phase stabil durchtesten.</li>
  <li><b>Delta bewusst verwalten:</b> Passt eine Policy nicht, nicht „wild" ändern, sondern Abweichung
    dokumentieren, Risiko bewerten, kompensierende Maßnahme festhalten (auditfähiges Delta-Register).</li>
  <li><b>Rollout in Wellen:</b> Pilot → Early Adopters → breite Masse, je Welle mit Erfolgskriterien (Autopilot-
    Erfolgsquote, Supportfälle, Defender-Findings).</li>
</ol>
<h4>Typische Stolpersteine</h4>
<ul>
  <li>Parallel laufende Baselines (Microsoft Security Baseline + OIB + eigene Policies) → Konflikte.</li>
  <li>Zu schneller Rollout ohne Pilot → Autopilot-/UX-Probleme erst im Produktivbetrieb.</li>
  <li>„CIS um jeden Preis" → kann Cloud-UX (WHfB) und Autopilot zerstören.</li>
  <li>Fehlende Dokumentation → macht jede Abweichung im Audit schwer erklärbar.</li>
</ul>

<h3>📝 Offizielles Audit-Statement</h3>
<p>Die implementierte Sicherheitsbaseline stellt eine risikobasierte, vollständig dokumentierte und an
anerkannten Frameworks orientierte Umsetzung von Sicherheitsstandards dar. Abweichungen zu CIS Benchmarks sind
bewusst entschieden, technisch begründet und durch alternative Maßnahmen kompensiert. Die Architektur
gewährleistet ein hohes Sicherheitsniveau bei gleichzeitiger Betriebsstabilität und Praxistauglichkeit.</p>
<p class="note">Quelle: <a href="https://github.com/SkipToTheEndpoint/OpenIntuneBaseline" target="_blank">OpenIntuneBaseline</a> ·
<a href="https://learn.microsoft.com/en-us/mem/intune/protect/security-baseline-settings-mdm-all" target="_blank">Microsoft Intune Security Baseline</a></p>
`
}

// ---------- Gruppenkonzept & Namenskonventionen ----------
export function namingHtml() {
  return `
<h3>Die drei Grundprinzipien</h3>
<ol>
  <li><b>Geräte tragen ein Etikett (GroupTag), das alles auslöst.</b> Beim Staging bekommt jedes Gerät einen
    GroupTag. Eine dynamische Gerätegruppe nimmt es darüber automatisch auf. An dieser Gruppe hängen dann
    Autopilot-Profil, Policies und Apps. → Ein GroupTag = ein fertig konfiguriertes Gerät.</li>
  <li><b>Steuerung über Gruppenmitgliedschaft, nicht über Einzel-Assignments.</b> Policies und Apps werden
    einmalig an Gruppen gebunden. Was ein Gerät bekommt, ändert man danach über die Mitgliedschaft — nicht durch
    ständiges Umhängen von Zuweisungen.</li>
  <li><b>Bei nicht geteilten Geräten: an das Gerät binden, nicht an den Benutzer.</b> Alles was „das Gerät"
    betrifft (Hardening, Compliance, Baseline, Standard-Apps) hängt am Device-Objekt — robust bei
    Benutzerwechsel, schnelleres Onboarding, keine Seiteneffekte bei Rollen-/Gruppenwechseln, sauber für
    Break-Glass/Support. Benutzer-Gruppen nur, wo wirklich der Mensch das Ziel ist (z.&nbsp;B.
    App-Protection-Policies). Nie User und Geräte in derselben Gruppe mischen.</li>
</ol>

<h3>📐 Festgelegte Konvention</h3>
<p>Aufbau: <code>AAD-&lt;KATEGORIE&gt;-&lt;DETAIL&gt;[-&lt;RING&gt;]</code> — Grossbuchstaben,
Bindestrich-getrennt, keine Leerzeichen, keine Umlaute, keine Kundenkürzel.</p>
<table class="comparison-table">
  <thead><tr><th>Kategorie</th><th>Schema</th><th>Beispiel</th><th>Zweck</th></tr></thead>
  <tbody>
    <tr><td>Gerätegruppe</td><td><code>AAD-DEV-&lt;ROLLE&gt;[-&lt;RING&gt;]</code></td><td><code>AAD-DEV-STD</code></td><td>Sammelgruppe für Geräte (Ziel von Policies &amp; App-Gruppen)</td></tr>
    <tr><td>App-Gruppe (Patch My PC)</td><td><code>AAD-PMP-&lt;APP&gt;</code></td><td><code>AAD-PMP-GoogleChrome</code></td><td>genau eine Gruppe pro PMP-App (1:1)</td></tr>
    <tr><td>App-Gruppe (manuell/selbstpaketiert)</td><td><code>AAD-APP-&lt;APP&gt;</code></td><td><code>AAD-APP-ZeiterfassungXY</code></td><td>eine Gruppe pro selbst paketierter App</td></tr>
    <tr><td>Benutzergruppe (sparsam)</td><td><code>AAD-USR-&lt;ZWECK&gt;</code></td><td><code>AAD-USR-AppProtection</code></td><td>nur wo der Benutzer das Ziel ist</td></tr>
    <tr><td>Rolle / RBAC</td><td><code>AAD-ROLE-&lt;ZWECK&gt;</code></td><td><code>AAD-ROLE-Helpdesk</code></td><td>Admin-/Rollenzuweisung</td></tr>
  </tbody>
</table>
<p>Geräterolle (<code>&lt;ROLLE&gt;</code>) ist die primäre Dimension — nach Zweck, nicht nach Formfaktor
(WS/NB brauchen selten eigene Configs und blähen nur auf). Beispiele: <code>STD</code> (Standard-Client /
Office / Knowledge-Worker), <code>PROD</code> (Produktionsgerät / Shopfloor), <code>KIOSK</code>, <code>EXEC</code>.
Formfaktor nur dann als eigene Rolle, wenn er wirklich andere Configs bedingt.</p>
<p>Rollout-Ring (<code>&lt;RING&gt;</code>) nur anhängen, wo tatsächlich geringt wird: <code>PILOT → UAT → BROAD</code>.
<code>PROD</code> wird nie als Ring verwendet (kollidiert mit der Geräterolle „Produktion"); der breite Ring
heisst <code>BROAD</code>.</p>
<p>App-Gruppen werden nach Verwaltung unterschieden, nicht nach Paketformat: <code>PMP</code> für
Patch-My-PC-Apps, <code>APP</code> für selbst paketierte. WIN32/Paketformat-Token werden nicht verwendet
(altert mit Store/winget/MSIX).</p>

<h3>🔗 GroupTag ↔ Gerätegruppe</h3>
<p>Der GroupTag (Autopilot) steuert die Mitgliedschaft der Gerätegruppe per dynamischer Regel auf dem Attribut
<code>OrderID</code>:</p>
<pre>(device.devicePhysicalIds -any (_ -eq "[OrderID]:DEV-STD"))   →   AAD-DEV-STD</pre>
<p>Regel: GroupTag = Gruppensuffix ohne <code>AAD-</code> (Gruppe <code>AAD-DEV-STD</code> → Tag
<code>DEV-STD</code>, <code>AAD-DEV-PROD</code> → <code>DEV-PROD</code>). So ist die Zuordnung auf einen Blick
lesbar.</p>

<h3>❓ Warum <code>AAD-</code> statt Kundenkürzel als Präfix</h3>
<p>Bisherige Praxis: Gruppen wurden oft mit dem Kundenkürzel präfixiert (z.&nbsp;B. <code>WIE-…</code>,
<code>EDU-…</code>) — ein Relikt aus der MSP-/ConfigMgr-Zeit, in der man Kunden in einer gemeinsamen Sicht
auseinanderhalten musste.</p>
<p><b>Warum wir das ablegen:</b></p>
<ul>
  <li><b>Pro-Tenant-Isolation:</b> Jeder Kunde hat heute seinen eigenen Entra-Tenant — innerhalb des Tenants ist
    man immer schon „beim Kunden", das Kürzel ist redundantes Rauschen.</li>
  <li><b>Blueprint-Portabilität:</b> Identische Gruppennamen in jedem Kundentenant bedeuten, dass dieselben
    Skripte, Vorlagen und GroupTags (OIB-Zuweisung, Patch-My-PC-Vorlage, Autopilot-Tags) überall ohne
    kundenspezifische String-Anpassung laufen.</li>
  <li><b>Automatisierung/Onboarding:</b> Templatisierbar, weniger Fehlerquellen.</li>
</ul>
<p><b>Warum genau <code>AAD-</code> (wichtig in Hybrid-Umgebungen):</b> Das Präfix kennzeichnet die
Herkunft/Autorität der Gruppe. <code>AAD-</code> = cloud-native Entra-Sicherheitsgruppe: kann dynamisch sein,
ist in der Cloud verwaltbar und für Intune-/Autopilot-/Conditional-Access-Zuweisungen nutzbar. In
Hybrid-Umgebungen (Entra Connect Sync) gibt es daneben aus dem On-Prem-AD synchronisierte Gruppen — die
verhalten sich grundlegend anders: Mitgliedschaft wird on-prem gemastert (in der Cloud praktisch read-only),
sie können nicht dynamisch gemacht werden, und sie eignen sich nicht für dynamische Geräte-/Autopilot-Szenarien.
Ein klares <code>AAD-</code> (cloud-geboren) gegenüber z.&nbsp;B. <code>AD-</code> (synchronisiert) verhindert,
dass jemand versehentlich eine synchronisierte On-Prem-Gruppe für eine Intune-/Autopilot-Zuweisung greift und
stille Fehler erntet.</p>

<h3>🗺️ Die Kette im Überblick</h3>
<pre>Gerät → GroupTag (z.B. DEV-STD) → AAD-DEV-STD
                                     ├──► Autopilot-Profil + ESP   (Autopilot-Wissen)
                                     ├──► OIB-Policies              (OpenIntuneBaseline-Wissen)
                                     └──► App-Gruppen AAD-PMP-*     (Patch My PC)</pre>

<h3>🛡️ Technische Leitplanken (Microsoft-Best-Practice)</h3>
<ul>
  <li>Gruppen für Intune müssen <b>Sicherheitsgruppen</b> sein (M365-Gruppen werden nicht unterstützt).
    Dynamische Gerätegruppen brauchen keine Zusatzlizenz; dynamische Benutzergruppen benötigen Entra&nbsp;ID&nbsp;P1
    pro Mitglied.</li>
  <li><b>Assignment-Filter statt eigener dynamischer Gruppen</b>, wenn nur einfache Geräte-Eigenschaften (OS,
    Modell, Hersteller, Ownership, Kategorie) gefiltert werden und die Gruppe nur von Intune genutzt wird — wird
    beim Check-in ausgewertet, ohne Gruppen-Verarbeitung. Dynamische Gruppen bleiben nötig für Autopilot,
    Conditional Access, Lizenzierung und Benutzer-Gruppen.</li>
  <li><b>Verschachtelte Gruppen</b> werden für die App-Zuweisung unterstützt (Mitglieder der Kindgruppen werden
    mitadressiert), Microsoft rät aber von Wildwuchs dedizierter „App-/Policy-Gruppen" und grossen
    Nesting-Änderungen ab (Sync-Last). Für übliche SMB-/MSP-Tenant-Grössen unkritisch; bei Skalierung Gruppen
    wiederverwenden.</li>
  <li>Keine eigenen „All Users/All Devices"-Gruppen bauen — die Intune-Virtual-Groups nutzen.</li>
</ul>

<h3>🔄 Migration bestehender Namen</h3>
<table class="comparison-table">
  <thead><tr><th>Alt</th><th>Neu</th></tr></thead>
  <tbody>
    <tr><td><code>AAD-DG-STD</code></td><td><code>AAD-DEV-STD</code> (GroupTag <code>DEV-STD</code>)</td></tr>
    <tr><td><code>AAD-DEV-WS-PRD</code></td><td><code>AAD-DEV-STD</code></td></tr>
    <tr><td>GroupTag <code>DG_STD</code></td><td><code>DEV-STD</code></td></tr>
    <tr><td>GroupTag <code>EDU-DG-Office</code></td><td><code>DEV-STD</code></td></tr>
    <tr><td>GroupTag <code>EDU-DG-PROD</code> (Produktion)</td><td><code>DEV-PROD</code></td></tr>
    <tr><td>GroupTag <code>DV-NB-MA</code></td><td><code>DEV-STD</code> (oder eigene Rolle, falls Notebooks anders konfiguriert)</td></tr>
    <tr><td><code>AAD-WIN32-&lt;APP&gt;</code></td><td><code>AAD-APP-&lt;APP&gt;</code></td></tr>
  </tbody>
</table>
<p class="note">Umzustellen: die Skript-Liste <code>$availableGroupTags</code> im Autopilot-Wrapper (falls der
manuelle Weg genutzt wird — das Staging-Paket aus dem Tool erzeugt die Liste automatisch aus den vorhandenen
dynamischen Gruppen), die dynamischen Gruppenregeln in Intune und die zugehörigen Profil-/Policy-/App-Zuweisungen.</p>
`
}

// ---------- Patch My PC ----------
export function patchMyPcHtml() {
  return `
<div class="alert alert-info">
  <strong>ℹ️ Hinweis:</strong> Der ausführliche interne Runbook-Text zu Patch My PC lag beim letzten Update noch
  nicht vor — dieser Abschnitt ist bewusst als kurzer Platzhalter gehalten. Sobald die Detail-Doku (Onboarding,
  App-Auswahl, Update-Kadenzen, Freigabeprozess) vorliegt, wird sie hier vollständig nachgezogen.
</div>

<h3>Was Patch My PC macht</h3>
<p>Patch My PC ist ein Drittanbieter-Dienst für <b>automatisiertes Third-Party-Patch- und App-Management</b> in
Microsoft Intune: er verpackt aktuelle Versionen gängiger Drittanbieter-Software (Browser, Runtimes, PDF-Reader
u.&nbsp;v.&nbsp;m.) automatisch als Intune-Win32-Apps inkl. Erkennungsregeln und Update-Erkennung, und hält sie
laufend aktuell — ohne dass man jede App-Version manuell neu paketieren muss.</p>

<h3>🔗 Einordnung ins Gruppenkonzept</h3>
<p>Jede über Patch My PC verwaltete App bekommt <b>genau eine</b> Zielgruppe nach dem Schema
<code>AAD-PMP-&lt;APP&gt;</code> (z.&nbsp;B. <code>AAD-PMP-GoogleChrome</code>) — 1:1, keine Sammelgruppen. Diese
Gruppen sind reine App-Ziele; die Steuerung, <i>welche Geräte</i> die App bekommen, läuft weiterhin über die
Gerätegruppen (<code>AAD-DEV-&lt;ROLLE&gt;</code>) und deren GroupTag-Zuordnung — siehe Abschnitt
„🏷️ Namenskonventionen". Für selbst paketierte (nicht über Patch My PC verwaltete) Apps gilt stattdessen das
Schema <code>AAD-APP-&lt;APP&gt;</code>.</p>

<div class="tool-tie-in">
  <span>🛠️</span>
  <div><b>Bezug zum Tool:</b> Die im Tab <b>📦 Agents</b> gelisteten Bitdefender-/N-sight-Installer sind
  klassische selbst verteilte Agents (nicht Patch-My-PC-verwaltet) und folgen daher der
  <code>AAD-APP-&lt;Name&gt;</code>-Konvention, sobald sie direkt nach Intune bereitgestellt werden.</div>
</div>
`
}
