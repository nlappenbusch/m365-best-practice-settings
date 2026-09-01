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
  nutzen möchte — im Alltag braucht es ihn nicht mehr.
  <div style="margin-top:.5rem;display:flex;gap:.5rem;flex-wrap:wrap;">
    <button type="button" class="btn btn-secondary tool-jump-btn" data-goto="autopilot">🚀 Zu Autopilot</button>
    <button type="button" class="btn btn-secondary tool-jump-btn" data-goto="intune">💻 Zu Intune</button>
  </div></div>
</div>

<h3>🔗 Die Kette (so hängt alles zusammen)</h3>
<div class="flow-diagram" role="img" aria-label="Kette: Geraet, GroupTag, Gruppe, Autopilot-Profil und Policies">
  <svg viewBox="0 0 860 210" xmlns="http://www.w3.org/2000/svg">
    <g style="fill:var(--bg-raised);stroke:var(--rule)" stroke-width="1.5"><rect x="4" y="82" width="118" height="46" rx="9"></rect></g>
    <text x="63" y="110" text-anchor="middle" style="fill:var(--text);font-size:12.5px;font-weight:700">📱 Gerät</text>

    <path d="M122 105 H182" style="stroke:var(--text-faint)" stroke-width="2" marker-end="url(#apArrow)"></path>
    <text x="152" y="96" text-anchor="middle" style="fill:var(--text-faint);font-size:9px">OOBE-Skript</text>

    <g style="fill:var(--accent-wash);stroke:var(--accent)" stroke-width="1.5"><rect x="186" y="76" width="150" height="58" rx="9"></rect></g>
    <text x="261" y="100" text-anchor="middle" style="fill:var(--accent);font-size:12px;font-weight:700">GroupTag</text>
    <text x="261" y="119" text-anchor="middle" style="fill:var(--text-dim);font-size:10.5px" font-family="var(--font-mono)">z.B. DEV-STD</text>

    <path d="M336 105 H396" style="stroke:var(--text-faint)" stroke-width="2" marker-end="url(#apArrow)"></path>
    <text x="366" y="96" text-anchor="middle" style="fill:var(--text-faint);font-size:9px">OrderID</text>

    <g style="fill:var(--accent-wash);stroke:var(--accent)" stroke-width="1.5"><rect x="400" y="76" width="160" height="58" rx="9"></rect></g>
    <text x="480" y="100" text-anchor="middle" style="fill:var(--accent);font-size:12px;font-weight:700">Gruppe</text>
    <text x="480" y="119" text-anchor="middle" style="fill:var(--text-dim);font-size:10.5px" font-family="var(--font-mono)">AAD-DEV-STD</text>

    <path d="M560 90 C 610 90, 610 30, 660 30" style="fill:none;stroke:var(--text-faint)" stroke-width="2" marker-end="url(#apArrow)"></path>
    <path d="M560 120 C 610 120, 610 180, 660 180" style="fill:none;stroke:var(--text-faint)" stroke-width="2" marker-end="url(#apArrow)"></path>

    <g style="fill:var(--ok-wash);stroke:var(--ok)" stroke-width="1.5"><rect x="664" y="6" width="192" height="48" rx="9"></rect></g>
    <text x="760" y="26" text-anchor="middle" style="fill:var(--ok);font-size:11.5px;font-weight:700">Autopilot-Profil + ESP</text>
    <text x="760" y="42" text-anchor="middle" style="fill:var(--text-dim);font-size:9.5px">steuert das Windows-Setup</text>

    <g style="fill:var(--ok-wash);stroke:var(--ok)" stroke-width="1.5"><rect x="664" y="156" width="192" height="48" rx="9"></rect></g>
    <text x="760" y="176" text-anchor="middle" style="fill:var(--ok);font-size:11.5px;font-weight:700">Policies (OIB) + Apps</text>
    <text x="760" y="192" text-anchor="middle" style="fill:var(--text-dim);font-size:9.5px">Sicherheit, Updates</text>

    <defs><marker id="apArrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" style="fill:var(--text-faint)"></path></marker></defs>
  </svg>
</div>
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
    <tr><td>Gruppe</td><td><code>AAD-DEV-STD</code> bzw. <code>T2-DG-WIN-Std</code></td><td>Gerätegruppe für die Rolle «Standard-Client» — im Bestandsschema mit <code>AAD-DEV-</code>, in v2 mit Tier und Plattform</td></tr>
    <tr><td>GroupTag (OrderID)</td><td><code>DEV-STD</code> bzw. <code>WIN-Std</code></td><td>Gruppenname ohne das Präfix; steuert, in welche Gruppe das Gerät fällt</td></tr>
  </tbody>
</table>
<p>Vollständig im Abschnitt „🏷️ Namenskonventionen" dieses Wissen-Bereichs.</p>

<details class="wissen-accordion">
  <summary>📎 Referenz: manueller Weg ohne das Tool</summary>
  <p>Der ursprüngliche, tool-unabhängige Weg (eigene App-Registrierung <code>createApp.ps1</code>, USB-Stick mit
  <code>Start-Autopilot.bat</code> / <code>Run-AutopilotWithExternalAppConfig.ps1</code> /
  <code>get-windowsautopilotinfocommunity.ps1</code> / <code>wrapper-config.json</code>) bleibt als Fallback nutzbar
  und liegt im Repo <a href="https://github.com/nlappenbusch/IntuneAutopilot" target="_blank">nlappenbusch/IntuneAutopilot</a>.
  Die auswählbaren GroupTags stehen dort im Skript <code>Run-AutopilotWithExternalAppConfig.ps1</code> in der Zeile
  <code>$availableGroupTags = @(...)</code> — bei Umstellung auf neue Rollen/Namen bitte synchron mit den
  dynamischen Gruppen halten. Für den Alltag ist das Staging-Paket aus dem Tool jedoch der kürzere, sicherere Weg.</p>
</details>
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
  Risikobeschreibung aus.
  <div style="margin-top:.5rem;display:flex;gap:.5rem;flex-wrap:wrap;">
    <button type="button" class="btn btn-secondary tool-jump-btn" data-goto="intune">💻 Zu Intune</button>
  </div></div>
</div>

<div class="flow-diagram" role="img" aria-label="Vergleich: OIB stabil, Microsoft Baseline und CIS Benchmark riskant fuer Autopilot">
  <svg viewBox="0 0 860 130" xmlns="http://www.w3.org/2000/svg">
    <g style="fill:var(--ok-wash);stroke:var(--ok)" stroke-width="1.5"><rect x="4" y="6" width="270" height="118" rx="10"></rect></g>
    <text x="139" y="32" text-anchor="middle" style="fill:var(--ok);font-size:13px;font-weight:700">OpenIntuneBaseline</text>
    <text x="139" y="54" text-anchor="middle" style="fill:var(--text);font-size:10.5px">Autopilot stabil, kein Neustart</text>
    <text x="139" y="72" text-anchor="middle" style="fill:var(--text);font-size:10.5px">1× zusätzlich MFA (WHfB)</text>
    <text x="139" y="90" text-anchor="middle" style="fill:var(--text);font-size:10.5px">BitLocker + Helpdesk funktionieren</text>
    <text x="139" y="108" text-anchor="middle" style="fill:var(--ok);font-size:10.5px;font-weight:700">→ produktiv im Einsatz</text>

    <g style="fill:var(--warn-wash);stroke:var(--warn)" stroke-width="1.5"><rect x="295" y="6" width="270" height="118" rx="10"></rect></g>
    <text x="430" y="32" text-anchor="middle" style="fill:var(--warn);font-size:13px;font-weight:700">Microsoft Baseline</text>
    <text x="430" y="54" text-anchor="middle" style="fill:var(--text);font-size:10.5px">Neustart erforderlich</text>
    <text x="430" y="72" text-anchor="middle" style="fill:var(--text);font-size:10.5px">Bis zu 3× MFA</text>
    <text x="430" y="90" text-anchor="middle" style="fill:var(--text);font-size:10.5px">Defender vs. Windows-Konflikte</text>
    <text x="430" y="108" text-anchor="middle" style="fill:var(--warn);font-size:10.5px;font-weight:700">→ nur mit Anpassung nutzbar</text>

    <g style="fill:var(--crit-wash);stroke:var(--crit)" stroke-width="1.5"><rect x="586" y="6" width="270" height="118" rx="10"></rect></g>
    <text x="721" y="32" text-anchor="middle" style="fill:var(--crit);font-size:13px;font-weight:700">CIS Benchmark (1:1)</text>
    <text x="721" y="54" text-anchor="middle" style="fill:var(--text);font-size:10.5px">Bricht Autopilot ab</text>
    <text x="721" y="72" text-anchor="middle" style="fill:var(--text);font-size:10.5px">Bis 3× MFA + Strg+Alt+Entf</text>
    <text x="721" y="90" text-anchor="middle" style="fill:var(--text);font-size:10.5px">BitLocker enthalten, funktioniert nicht</text>
    <text x="721" y="108" text-anchor="middle" style="fill:var(--crit);font-size:10.5px;font-weight:700">→ so nicht praxistauglich</text>
  </svg>
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
<details class="wissen-accordion"><summary>Warum nicht 100&nbsp;% CIS?</summary>
<p>CIS ist ein Empfehlungskatalog, kein zwingender Standard. Alle Controls
wurden bewertet und an die cloud-native Architektur angepasst; nicht anwendbare oder geschäftskritische Controls
sind dokumentiert und durch alternative Maßnahmen ersetzt — CIS selbst empfiehlt dieses Vorgehen.</p></details>
<details class="wissen-accordion"><summary>Ist das Sicherheitsniveau wirklich gleichwertig?</summary>
<p>Ja — lokale Controls werden durch überlegene zentrale
Mechanismen ersetzt (Entra ID, Defender for Endpoint, Conditional Access, WHfB). In vielen Bereichen ist das
Ergebnis strenger als eine ungeprüfte 1:1-CIS-Umsetzung.</p></details>
<details class="wissen-accordion"><summary>Warum kein lokales PowerShell-Logging?</summary>
<p>CIS selbst dokumentiert das Credential-Exposure-Risiko bei
aktivierter Transkription. Defender for Endpoint bietet zentrales, manipulationssicheres Monitoring — der
sicherere Ansatz.</p></details>
<details class="wissen-accordion"><summary>Warum ist UAC nicht restriktiver?</summary>
<p>Volle Blockade würde LAPS, Remote-Diagnose und Fehlerbehebung in der
Benutzersitzung verhindern. UAC wird kontrolliert statt blockiert konfiguriert.</p></details>

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
<pre style="font-size:.78rem">(device.devicePhysicalIds -any (_ -eq "[OrderID]:DEV-STD"))   →   AAD-DEV-STD
(device.devicePhysicalIds -any (_ -eq "[OrderID]:WIN-Std"))   →   T2-DG-WIN-Std</pre>

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
<p>Es gibt <b>zwei</b> Konventionen: den gewachsenen Bestand (<code>AAD-*</code>) und das Tier-Schema der
Namenskonventionen v2. Welche in einem Tenant gilt, steht im Tab <b>Namenskonvention</b> — global als
Vorgabe, pro Tenant überschreibbar. Das Werkzeug legt Objekte nach der eingestellten Konvention an und
findet bestehende weiterhin unter beiden Namen; umbenannt wird nie.</p>
<table class="comparison-table">
  <thead><tr><th>Kategorie</th><th>Bestand</th><th>v2</th><th>Zweck</th></tr></thead>
  <tbody>
    <tr><td>Gerätegruppe</td><td><code>AAD-DEV-STD</code></td><td><code>T2-DG-WIN-Std</code></td><td>Sammelgruppe für Geräte (Ziel von Policies &amp; App-Gruppen)</td></tr>
    <tr><td>App-Gruppe (Patch My PC)</td><td><code>AAD-PMP-GoogleChrome</code></td><td><code>T2-DG-WIN-PmpGoogleChrome</code></td><td>genau eine Gruppe pro PMP-App (1:1)</td></tr>
    <tr><td>App-Gruppe (selbst paketiert)</td><td><code>AAD-APP-ZeiterfassungXY</code></td><td><code>T2-DG-WIN-AppZeiterfassungXY</code></td><td>eine Gruppe pro selbst paketierter App</td></tr>
    <tr><td>Benutzergruppe (sparsam)</td><td><code>AAD-USR-AppProtection</code></td><td><code>T2-CSG-GOV-MAM-AppProtection</code></td><td>nur wo der Benutzer das Ziel ist</td></tr>
    <tr><td>Rolle / RBAC</td><td><code>AAD-ROLE-Helpdesk</code></td><td><code>T2-CSG-ADM-ENTRA-Helpdesk</code></td><td>Admin-/Rollenzuweisung</td></tr>
    <tr><td>CA-Ring / -Ausnahme</td><td><code>AAD-CA-RING-PILOT</code></td><td><code>T0-CSG-GOV-CA-RingPilot</code></td><td>Rollout-Ringe und Ausnahmen für Conditional Access</td></tr>
    <tr><td>Notfallzugriffskonto (Break-Glass)</td><td><code>breakglass-01</code></td><td><code>brk.notfall01</code></td><td>dediziertes Konto für den CA-Notfallzugriff, nie für tägliche Arbeit</td></tr>
  </tbody>
</table>
<p>Gemeinsam ist beiden: Bindestrich trennt die Positionen, keine Leerzeichen, keine Umlaute, <b>kein
Kundenkürzel im Kundentenant</b> — identische Namen in jedem Tenant halten Skripte, Vorlagen und GroupTags
portabel. Der Unterschied liegt im Aufbau: Der Bestand kodiert die Kategorie (<code>DEV</code>,
<code>PMP</code>, <code>APP</code>), v2 stellt das Tier voran und trennt Gerätegruppen (<code>DG</code>) von
Sicherheitsgruppen (<code>CSG</code>).</p>
<p>Break-Glass-Konten sind <b>Benutzerobjekte</b>, nicht Gruppen — daher lowercase (UPN-Konvention) statt
Grossbuchstaben-Gruppenschema, aber gleiche Idee: kurz, sprechend, durchnummeriert (<code>-01</code>,
<code>-02</code>, …), da Microsoft mindestens zwei Notfallkonten empfiehlt. Kein Versuch, den Zweck zu
verschleiern — der Schutz kommt aus starkem Passwort, Monitoring und CA-Ausschluss (die Break-Glass-Gruppe
heisst je nach Konvention <code>AAD-CA-BreakGlass</code> oder <code>T0-CSG-GOV-CA-BreakGlass-Exempt</code>),
nicht aus einem unauffälligen Namen.</p>
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
<pre>(device.devicePhysicalIds -any (_ -eq "[OrderID]:DEV-STD"))   →   AAD-DEV-STD
(device.devicePhysicalIds -any (_ -eq "[OrderID]:WIN-Std"))   →   T2-DG-WIN-Std</pre>
<p>Regel: GroupTag = Gruppenname ohne das Präfix der Gerätegruppe — im Bestand ohne <code>AAD-</code>
(<code>AAD-DEV-STD</code> → <code>DEV-STD</code>), in v2 ohne <code>T2-DG-</code>
(<code>T2-DG-WIN-Std</code> → <code>WIN-Std</code>). So ist die Zuordnung auf einen Blick
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
<div class="flow-diagram" role="img" aria-label="Geraet ueber GroupTag zur Gruppe, die Autopilot-Profil, OIB-Policies und App-Gruppen zieht">
  <svg viewBox="0 0 860 200" xmlns="http://www.w3.org/2000/svg">
    <g style="fill:var(--bg-raised);stroke:var(--rule)" stroke-width="1.5"><rect x="4" y="76" width="110" height="48" rx="9"></rect></g>
    <text x="59" y="105" text-anchor="middle" style="fill:var(--text);font-size:12.5px;font-weight:700">Gerät</text>
    <path d="M114 100 H174" style="stroke:var(--text-faint)" stroke-width="2" marker-end="url(#nmArrow)"></path>

    <g style="fill:var(--accent-wash);stroke:var(--accent)" stroke-width="1.5"><rect x="178" y="70" width="150" height="60" rx="9"></rect></g>
    <text x="253" y="95" text-anchor="middle" style="fill:var(--accent);font-size:11.5px;font-weight:700">GroupTag</text>
    <text x="253" y="113" text-anchor="middle" style="fill:var(--text-dim);font-size:10px" font-family="var(--font-mono)">z.B. DEV-STD</text>
    <path d="M328 100 H388" style="stroke:var(--text-faint)" stroke-width="2" marker-end="url(#nmArrow)"></path>

    <g style="fill:var(--accent-wash);stroke:var(--accent)" stroke-width="1.5"><rect x="392" y="70" width="150" height="60" rx="9"></rect></g>
    <text x="467" y="95" text-anchor="middle" style="fill:var(--accent);font-size:11.5px;font-weight:700">Gruppe</text>
    <text x="467" y="113" text-anchor="middle" style="fill:var(--text-dim);font-size:10px" font-family="var(--font-mono)">AAD-DEV-STD</text>

    <path d="M542 84 C 590 84, 590 14, 638 14" style="fill:none;stroke:var(--text-faint)" stroke-width="2" marker-end="url(#nmArrow)"></path>
    <path d="M542 100 H638" style="stroke:var(--text-faint)" stroke-width="2" marker-end="url(#nmArrow)"></path>
    <path d="M542 116 C 590 116, 590 186, 638 186" style="fill:none;stroke:var(--text-faint)" stroke-width="2" marker-end="url(#nmArrow)"></path>

    <g style="fill:var(--ok-wash);stroke:var(--ok)" stroke-width="1.5"><rect x="642" y="0" width="214" height="40" rx="8"></rect></g>
    <text x="749" y="24" text-anchor="middle" style="fill:var(--ok);font-size:11px;font-weight:700">Autopilot-Profil + ESP</text>
    <g style="fill:var(--ok-wash);stroke:var(--ok)" stroke-width="1.5"><rect x="642" y="80" width="214" height="40" rx="8"></rect></g>
    <text x="749" y="104" text-anchor="middle" style="fill:var(--ok);font-size:11px;font-weight:700">OIB-Policies</text>
    <g style="fill:var(--ok-wash);stroke:var(--ok)" stroke-width="1.5"><rect x="642" y="166" width="214" height="34" rx="8"></rect></g>
    <text x="749" y="188" text-anchor="middle" style="fill:var(--ok);font-size:10.5px;font-weight:700">App-Gruppen AAD-PMP-*</text>

    <defs><marker id="nmArrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" style="fill:var(--text-faint)"></path></marker></defs>
  </svg>
</div>

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
<h3>Was Patch My PC macht</h3>
<p>Patch My PC ist ein Drittanbieter-Dienst für <b>automatisiertes Third-Party-Patch- und App-Management</b> in
Microsoft Intune: er verpackt aktuelle Versionen gängiger Drittanbieter-Software (Browser, Runtimes, PDF-Reader
u.&nbsp;v.&nbsp;m.) automatisch als Intune-Win32-Apps inkl. Erkennungsregeln und Update-Erkennung, und hält sie
laufend aktuell — ohne dass man jede App-Version manuell neu paketieren muss.</p>

<div class="flow-diagram" role="img" aria-label="Patch My PC Ablauf: Hersteller-Feed, automatisches Repackaging, Intune Win32-App, Geraetegruppe">
  <svg viewBox="0 0 860 100" xmlns="http://www.w3.org/2000/svg">
    <g style="fill:var(--bg-raised);stroke:var(--rule)" stroke-width="1.5"><rect x="4" y="26" width="180" height="48" rx="9"></rect></g>
    <text x="94" y="55" text-anchor="middle" style="fill:var(--text);font-size:11.5px;font-weight:700">Hersteller-Feed</text>
    <path d="M184 50 H244" style="stroke:var(--text-faint)" stroke-width="2" marker-end="url(#pmpArrow)"></path>

    <g style="fill:var(--accent-wash);stroke:var(--accent)" stroke-width="1.5"><rect x="248" y="26" width="180" height="48" rx="9"></rect></g>
    <text x="338" y="55" text-anchor="middle" style="fill:var(--accent);font-size:11.5px;font-weight:700">Auto-Repackaging</text>
    <path d="M428 50 H488" style="stroke:var(--text-faint)" stroke-width="2" marker-end="url(#pmpArrow)"></path>

    <g style="fill:var(--accent-wash);stroke:var(--accent)" stroke-width="1.5"><rect x="492" y="26" width="180" height="48" rx="9"></rect></g>
    <text x="582" y="55" text-anchor="middle" style="fill:var(--accent);font-size:11.5px;font-weight:700">Intune Win32-App</text>
    <path d="M672 50 H732" style="stroke:var(--text-faint)" stroke-width="2" marker-end="url(#pmpArrow)"></path>

    <g style="fill:var(--ok-wash);stroke:var(--ok)" stroke-width="1.5"><rect x="736" y="26" width="120" height="48" rx="9"></rect></g>
    <text x="796" y="47" text-anchor="middle" style="fill:var(--ok);font-size:10.5px;font-weight:700">AAD-PMP-*</text>
    <text x="796" y="63" text-anchor="middle" style="fill:var(--text-dim);font-size:9px">Gerätegruppe</text>

    <defs><marker id="pmpArrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" style="fill:var(--text-faint)"></path></marker></defs>
  </svg>
</div>

<h3>🧾 Individuelle App-Konfiguration (Custom Apps)</h3>
<p>Neben dem großen Katalog vorgefertigter Drittanbieter-Apps erlaubt Patch My PC auch eigene <b>Custom-App</b>-
Einträge — z.&nbsp;B. für den eigenen RMM-Agent, der pro Kunde anders benannt bzw. paketiert werden muss. Das
„App Info"-Formular dafür fragt genau die Metadaten ab, die später 1:1 in der Intune-App landen:</p>
<table class="comparison-table">
  <thead><tr><th>Feld (Patch My PC)</th><th>Landet in Intune als</th><th>Bemerkung</th></tr></thead>
  <tbody>
    <tr><td><code>Vendor</code> *</td><td><code>publisher</code></td><td>Pflichtfeld</td></tr>
    <tr><td><code>Description</code> *</td><td><code>description</code></td><td>Pflichtfeld — bei Kunden-individuellen Agents z.B. „igeeks RMM Client - &lt;Kundenname&gt;"</td></tr>
    <tr><td><code>Owner</code></td><td><code>owner</code></td><td>optional, rein informativ</td></tr>
    <tr><td><code>Intune Notes</code></td><td><code>notes</code></td><td>interner Kommentar</td></tr>
    <tr><td><code>Information URL</code> / <code>Privacy URL</code></td><td><code>informationUrl</code> / <code>privacyInformationUrl</code></td><td>optional</td></tr>
    <tr><td><code>Developer</code></td><td><code>developer</code></td><td>optional</td></tr>
    <tr><td><code>Set App as Featured</code></td><td><code>isFeatured</code></td><td>App erscheint im Company Portal hervorgehoben</td></tr>
    <tr><td><code>Allow Available Uninstall</code></td><td>—</td><td>siehe Hinweis unten</td></tr>
    <tr><td><code>Requirements → Minimum operating system</code></td><td><code>minimumSupportedWindowsRelease</code></td><td>dasselbe Feld, das auch unser eigener App-Deploy im Tab „📦 Agents" setzt</td></tr>
  </tbody>
</table>
<div class="alert alert-info">
  <strong>ℹ️ „Allow Available Uninstall" hat kein 1:1-Gegenstück im Win32-App-Schema.</strong> Im rohen Intune-/
  Graph-Datenmodell für Win32-Apps (<code>win32LobApp</code>) gibt es kein Feld dieses Namens — es greift nur bei
  Apps, die (zusätzlich) mit Zuweisungs-Intent <code>Available</code> im Company Portal bereitgestellt werden und
  steuert dort, ob Nutzer die App selbst deinstallieren dürfen. Unser Tool weist Agents ausschließlich mit Intent
  <code>Required</code> zu (siehe „🛠️ Bezug zum Tool" unten) — dort gibt es ohnehin kein Self-Service-Uninstall
  im Company Portal, das Feld wäre also nicht anwendbar.
</div>

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
  <code>AAD-APP-&lt;Name&gt;</code>-Konvention, sobald sie direkt nach Intune bereitgestellt werden. Die
  Zuweisung läuft dabei immer mit Intent <code>Required</code> (stiller Zwangs-Install, kein Company-Portal-
  Self-Service) — die Silent-Switches und Rückgabecodes dafür sind je Hersteller fest hinterlegt.
  <div style="margin-top:.5rem;display:flex;gap:.5rem;flex-wrap:wrap;">
    <button type="button" class="btn btn-secondary tool-jump-btn" data-goto="downloads">📦 Zu Agents</button>
  </div></div>
</div>
`
}

// ---------- Conditional Access: Ring-Konzept ----------
export function conditionalAccessHtml() {
  return `
<h3>🎯 Zielsetzung</h3>
<p>Conditional Access kann im schlimmsten Fall den <b>gesamten Tenant aussperren</b> — anders als jede andere
Automatisierung in diesem Tool. Deshalb gilt hier eine striktere Sicherheitsleitplanke als überall sonst: nichts
wird je direkt scharf angelegt, und der Rollout läuft immer in kontrollierten Wellen statt auf einen Schlag an
„alle Benutzer".</p>

<div class="alert alert-warning">
  <strong>⚠️ Die wichtigste Regel:</strong> Jede Policy wird beim Anlegen <b>immer</b> mit
  <code>enabledForReportingButNotEnforced</code> erzeugt — komplett unabhängig davon, was in der Vorlage steht.
  Es gibt im Code keinen Pfad, der eine Policy direkt scharf anlegt. Aktivieren (<code>state → enabled</code>) ist
  ein bewusst getrennter, expliziter Klick.
</div>

<div class="tool-tie-in">
  <span>🛠️</span>
  <div><b>So macht das unser Tool:</b> Vorschau mit Ring-/Ziel-Auswahl, Batch-Aktionen (aktivieren/deaktivieren)
  und der Nutzer-/Break-Glass-Konto-Ersteller laufen im Tab <b>🔐 Conditional Access</b>.
  <div style="margin-top:.5rem;display:flex;gap:.5rem;flex-wrap:wrap;">
    <button type="button" class="btn btn-secondary tool-jump-btn" data-goto="ca">🔐 Zu Conditional Access</button>
  </div></div>
</div>

<h3>🎚️ Drei Ausbaustufen</h3>
<p>Je nach Lizenzierung des Tenants steht eine passende Tier zur Verfügung — von reiner MFA-Erzwingung bis zu
Risiko-basierten Policies:</p>
<table class="comparison-table">
  <thead><tr><th>Tier</th><th>Umfang</th><th>Lizenz</th></tr></thead>
  <tbody>
    <tr><td><b>Bare Minimum</b></td><td>Nur Authentication-Strength/MFA — keine Geräte-Compliance-Anforderung. Funktioniert unabhängig davon, ob Geräte Intune-verwaltet sind.</td><td>Keine Zusatzlizenz (Security-Defaults-Niveau, aber granularer)</td></tr>
    <tr><td><b>AADP1</b></td><td>Zusätzlich Geräte-Compliance/Hybrid-Join als Optionen, App-Protection, mehr Attack-Surface-Reduction-Regeln.</td><td>Entra ID P1 (in Business Premium/E3 enthalten)</td></tr>
    <tr><td><b>AADP1+P2</b></td><td>Zusätzlich Sign-in-/User-Risk-Policies (Identity Protection), Insider-Risk-Signale, Session-/Token-Schutz.</td><td>Entra ID P2 zusätzlich zu P1 (in E5 enthalten)</td></tr>
  </tbody>
</table>

<h3>🔄 Das Ring-Konzept</h3>
<p>Ursprünglich waren die Policies fest auf eine einzige Zielgruppe verdrahtet — im Alltag zu grob, wenn man ein
neues Policy-Set erst an einer Pilotgruppe testen will, bevor es an alle geht. Das Ring-Konzept (Vorlage:
AlexFilipin/ConditionalAccess) löst das: derselbe Policy-Satz kann mehrfach nebeneinander existieren, einmal pro
Ring, und der <code>&lt;RING&gt;</code>-Platzhalter im Policy-Namen wird beim Deploy ersetzt.</p>

<div class="flow-diagram" role="img" aria-label="Ring-Rollout: Pilot-Gruppe, dann UAT, dann breiter Rollout, jeweils im Report-Only-Modus zuerst">
  <svg viewBox="0 0 860 150" xmlns="http://www.w3.org/2000/svg">
    <g style="fill:var(--ok-wash);stroke:var(--ok)" stroke-width="1.5"><rect x="4" y="10" width="260" height="130" rx="10"></rect></g>
    <text x="134" y="36" text-anchor="middle" style="fill:var(--ok);font-size:12.5px;font-weight:700">PILOT</text>
    <text x="134" y="58" text-anchor="middle" style="fill:var(--text);font-size:10px">AAD-CA-RING-PILOT</text>
    <text x="134" y="76" text-anchor="middle" style="fill:var(--text-dim);font-size:9.5px">wenige Testnutzer</text>
    <text x="134" y="112" text-anchor="middle" style="fill:var(--ok);font-size:10px;font-weight:700">Report-Only zuerst</text>

    <path d="M264 75 H320" style="stroke:var(--text-faint)" stroke-width="2" marker-end="url(#caArrow)"></path>

    <g style="fill:var(--warn-wash);stroke:var(--warn)" stroke-width="1.5"><rect x="300" y="10" width="260" height="130" rx="10"></rect></g>
    <text x="430" y="36" text-anchor="middle" style="fill:var(--warn);font-size:12.5px;font-weight:700">UAT</text>
    <text x="430" y="58" text-anchor="middle" style="fill:var(--text);font-size:10px">AAD-CA-RING-UAT</text>
    <text x="430" y="76" text-anchor="middle" style="fill:var(--text-dim);font-size:9.5px">breitere Testgruppe</text>
    <text x="430" y="112" text-anchor="middle" style="fill:var(--warn);font-size:10px;font-weight:700">Report-Only zuerst</text>

    <path d="M560 75 H616" style="stroke:var(--text-faint)" stroke-width="2" marker-end="url(#caArrow)"></path>

    <g style="fill:var(--crit-wash);stroke:var(--crit)" stroke-width="1.5"><rect x="596" y="10" width="260" height="130" rx="10"></rect></g>
    <text x="726" y="36" text-anchor="middle" style="fill:var(--crit);font-size:12.5px;font-weight:700">BROAD</text>
    <text x="726" y="58" text-anchor="middle" style="fill:var(--text);font-size:10px">AAD-CA-RING-BROAD</text>
    <text x="726" y="76" text-anchor="middle" style="fill:var(--text-dim);font-size:9.5px">alle Benutzer</text>
    <text x="726" y="112" text-anchor="middle" style="fill:var(--crit);font-size:10px;font-weight:700">erst nach sauberem UAT</text>

    <defs><marker id="caArrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" style="fill:var(--text-faint)"></path></marker></defs>
  </svg>
</div>
<p><b>Ring-getargetet</b> heisst: Policies, die eigentlich auf „All users" zielen würden, zielen stattdessen auf
die Ring-Gruppe. So testet man das komplette Set an einer Pilotgruppe, bevor der breite Ring alle erfasst. Named
Policies folgen dem Schema <code>&lt;Nr&gt; - BP - &lt;Name&gt;</code> — nur diese eigenen Policies werden vom
Tool verwaltet, bestehende Fremd-Policies bleiben unangetastet.</p>

<h3>🛡️ Vier Schutzgruppen (immer leer angelegt)</h3>
<p>Vor jedem Deploy stellt das Tool vier Ausschluss-Gruppen sicher und trägt sie in jede Policy ein — sie werden
aber bewusst <b>leer</b> angelegt, der Admin muss sie selbst befüllen:</p>
<table class="comparison-table">
  <thead><tr><th>Gruppe</th><th>Zweck</th></tr></thead>
  <tbody>
    <tr><td><code>AAD-CA-BreakGlass</code></td><td>Notfallzugriffskonten — <b>vor dem Aktivieren</b> mit mindestens einem Konto befüllen, sonst droht Aussperrung.</td></tr>
    <tr><td><code>AAD-CA-SyncAccounts</code></td><td>Entra-Connect-/Sync-Dienstkonten — dürfen nie durch interaktive Auth-Anforderungen blockiert werden.</td></tr>
    <tr><td><code>AAD-CA-ExclusionTemp</code></td><td>Temporäre Ausnahmen (z.B. Troubleshooting) — zeitnah wieder leeren.</td></tr>
    <tr><td><code>AAD-CA-ExclusionPermanent</code></td><td>Dauerhafte, dokumentierte Ausnahmen (z.B. Legacy-Systemkonten).</td></tr>
  </tbody>
</table>

<h3>🚨 Break-Glass-Konten</h3>
<p>Microsoft empfiehlt mindestens zwei Notfallkonten, ausgeschlossen von jeder Conditional-Access-Policy. Sie
folgen der Namenskonvention <code>breakglass-01</code>, <code>breakglass-02</code> (siehe Abschnitt
„🏷️ Namenskonventionen") — der Schutz kommt aus starkem Passwort, Monitoring und dem CA-Ausschluss selbst, nicht
aus einem unauffälligen Namen. Das Tool erzeugt auf Wunsch ein solches Konto direkt mit vorbelegtem, konventions-
konformem Benutzernamen und einem generierten Einmal-Passwort.</p>
`
}

// ---------- Intune-Backup & -Restore ----------
export function intuneBackupHtml() {
  return `
<h3>🎯 Zielsetzung</h3>
<p>Ein versehentlich gelöschtes oder überschriebenes Intune-Profil lässt sich ohne Sicherung nicht rückgängig
machen — Microsoft bietet dafür keine eingebaute Undo-Funktion. Dieser Abschnitt begründet den Backup/Restore-
Mechanismus (Idee: ugurkocde/TenuVault, hier als eigenständige app-only-Implementierung direkt im Tool statt als
delegiertes PowerShell-Skript).</p>

<div class="tool-tie-in">
  <span>🛠️</span>
  <div><b>So macht das unser Tool:</b> Backup erstellen, Snapshots einsehen und der Drift-Vergleich zwischen zwei
  Ständen laufen im Tab <b>💻 Intune → Backup &amp; Restore</b>.
  <div style="margin-top:.5rem;display:flex;gap:.5rem;flex-wrap:wrap;">
    <button type="button" class="btn btn-secondary tool-jump-btn" data-goto="intune">💻 Zu Intune</button>
  </div></div>
</div>

<div class="flow-diagram" role="img" aria-label="Backup liest nur, Restore legt neue Objekte mit Restored-Praefix unzugewiesen an">
  <svg viewBox="0 0 860 140" xmlns="http://www.w3.org/2000/svg">
    <g style="fill:var(--bg-raised);stroke:var(--rule)" stroke-width="1.5"><rect x="4" y="46" width="150" height="48" rx="9"></rect></g>
    <text x="79" y="75" text-anchor="middle" style="fill:var(--text);font-size:12px;font-weight:700">Intune (Live)</text>
    <path d="M154 70 H214" style="stroke:var(--text-faint)" stroke-width="2" marker-end="url(#ibArrow)"></path>
    <text x="184" y="60" text-anchor="middle" style="fill:var(--text-faint);font-size:9px">nur GET</text>

    <g style="fill:var(--ok-wash);stroke:var(--ok)" stroke-width="1.5"><rect x="218" y="46" width="170" height="48" rx="9"></rect></g>
    <text x="303" y="70" text-anchor="middle" style="fill:var(--ok);font-size:11.5px;font-weight:700">JSON-Snapshot</text>
    <text x="303" y="86" text-anchor="middle" style="fill:var(--text-dim);font-size:8.8px" font-family="var(--font-mono)">backups/&lt;tenant&gt;/&lt;ts&gt;.json</text>

    <path d="M388 70 H448" style="stroke:var(--text-faint)" stroke-width="2" marker-end="url(#ibArrow)"></path>
    <text x="418" y="60" text-anchor="middle" style="fill:var(--text-faint);font-size:9px">Restore</text>

    <g style="fill:var(--warn-wash);stroke:var(--warn)" stroke-width="1.5"><rect x="452" y="16" width="200" height="108" rx="9"></rect></g>
    <text x="552" y="42" text-anchor="middle" style="fill:var(--warn);font-size:11.5px;font-weight:700">Neue Objekte</text>
    <text x="552" y="62" text-anchor="middle" style="fill:var(--text);font-size:9.5px" font-family="var(--font-mono)">"[Restored] &lt;Name&gt;"</text>
    <text x="552" y="80" text-anchor="middle" style="fill:var(--text);font-size:9.5px">unzugewiesen</text>
    <text x="552" y="98" text-anchor="middle" style="fill:var(--warn);font-size:9px;font-weight:700">nichts Bestehendes</text>
    <text x="552" y="112" text-anchor="middle" style="fill:var(--warn);font-size:9px;font-weight:700">wird geändert/gelöscht</text>

    <path d="M656 70 H716" style="stroke:var(--text-faint)" stroke-width="2" marker-end="url(#ibArrow)"></path>
    <text x="686" y="60" text-anchor="middle" style="fill:var(--text-faint);font-size:9px">manuell</text>

    <g style="fill:var(--bg-raised);stroke:var(--rule)" stroke-width="1.5"><rect x="720" y="46" width="136" height="48" rx="9"></rect></g>
    <text x="788" y="68" text-anchor="middle" style="fill:var(--text);font-size:10.5px;font-weight:700">Prüfen &amp;</text>
    <text x="788" y="83" text-anchor="middle" style="fill:var(--text);font-size:10.5px;font-weight:700">zuweisen</text>

    <defs><marker id="ibArrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" style="fill:var(--text-faint)"></path></marker></defs>
  </svg>
</div>

<h3>📦 Was gesichert wird</h3>
<table class="comparison-table">
  <thead><tr><th>Kategorie</th><th>Umfang</th></tr></thead>
  <tbody>
    <tr><td>Settings Catalog</td><td>inkl. aller Settings (<code>$expand=settings</code>)</td></tr>
    <tr><td>Compliance Policies</td><td>inkl. Scheduled Actions for Rule</td></tr>
    <tr><td>Device Configurations</td><td>klassische Konfigurationsprofile</td></tr>
    <tr><td>Plattform-Skripte</td><td>inkl. Skript-Inhalt (pro Skript einzeln abgerufen)</td></tr>
    <tr><td>Feature-/Quality-/Driver-Updates</td><td>alle drei Update-Ring-Profiltypen</td></tr>
  </tbody>
</table>
<div class="alert alert-info">
  <strong>ℹ️ Bewusst nicht dabei: Admin Templates (ADMX).</strong> Deren <code>definitionValues</code>-Modell
  bräuchte eine eigene, deutlich komplexere Restore-Logik — ohne die wäre ein „Backup" davon nur Schein-Sicherheit.
  Betroffen ist insbesondere das Drucker-Mapping-Profil (siehe Abschnitt „🗺️ Mappings").
</div>

<h3>🔒 Warum Restore nie etwas überschreibt</h3>
<ul>
  <li><b>Nur neue Objekte:</b> jedes wiederhergestellte Profil bekommt das Präfix <code>[Restored] </code> im Namen — nie derselbe Name wie das Original, also nie ein Konflikt.</li>
  <li><b>Unzugewiesen:</b> Restore weist die wiederhergestellten Profile bewusst keiner Gruppe zu — ein Admin muss sie erst prüfen und aktiv zuweisen, bevor sie irgendein Gerät erreichen.</li>
  <li><b>Keine Löschungen:</b> Restore löscht oder verändert nie ein bestehendes Objekt im Tenant.</li>
</ul>

<h3>🔍 Drift-Vergleich</h3>
<p>Zwei Snapshots lassen sich gegeneinander vergleichen (pro Kategorie: hinzugekommen / entfernt / unverändert,
nach Name) — nützlich, um nachzuvollziehen, was sich zwischen zwei Zeitpunkten in der Intune-Konfiguration
tatsächlich geändert hat, unabhängig davon, ob das über dieses Tool oder direkt im Portal geschah.</p>
`
}

// ---------- Mappings: Drive- & Printer-Mapping ----------
export function mappingsHtml() {
  return `
<h3>🎯 Zielsetzung</h3>
<p>Beide Mapping-Tools lösen dasselbe Grundproblem: Cloud-only-Geräte (Entra-ID-joined, kein lokales AD) haben
von Haus aus keinen Zugriff auf klassische On-Prem-Netzwerkressourcen — Laufwerke und Drucker, die früher per
Login-Skript/GPO kamen. Für Laufwerke und Drucker wurden bewusst <b>unterschiedliche</b> Ansätze gewählt, weil
die jeweils beste verfügbare Community-Lösung unterschiedlich funktioniert.</p>

<div class="tool-tie-in">
  <span>🛠️</span>
  <div><b>So macht das unser Tool:</b> Beide Konfiguratoren (Profile anlegen, Skript generieren/parsen, App-
  Deployment, GroupTag-Zuweisung) laufen im Tab <b>🗺️ Mappings</b>.
  <div style="margin-top:.5rem;display:flex;gap:.5rem;flex-wrap:wrap;">
    <button type="button" class="btn btn-secondary tool-jump-btn" data-goto="mappings">🗺️ Zu Mappings</button>
  </div></div>
</div>

<h3>🖴 Drive-Mapping (Port von nicolonsky/IntuneDriveMapping)</h3>
<p>Der Generator erzeugt ein reines PowerShell-Plattformskript: SYSTEM legt einen Scheduled Task an, der bei
jedem Benutzer-Logon die Laufwerke mappt (optional mit On-Prem-AD-Gruppenfilter) — <b>ohne App-Abhängigkeit</b>.
Das Original-Template wird eingebettet und an genau den drei Stellen gepatcht, die auch der Web-Generator patcht
(<code>!INTUNEDRIVEMAPPINGJSON!</code>, <code>$searchRoot</code>, <code>$removeStaleDrives</code>).</p>
<p><b>Profile sind zustandslos:</b> Die Konfiguration lebt im deployten Skript selbst (als eingebettetes JSON)
und wird beim Bearbeiten wieder herausgeparst — es gibt keine separate Datenbank dafür. Laufwerksbuchstaben sind
auf <code>D–Z</code> beschränkt (nie <code>C</code>), Pfade müssen UNC sein (kein lokaler Pfad).</p>

<h3>🖨️ Printer-Mapping (Weatherlights/Intune-Printer-Mapping-Tool)</h3>
<p>Drucker funktionieren anders als Laufwerke: das Tool nutzt eine Store-App plus ADMX-Ingestion statt eines
reinen Skripts. Drei Teile, komplett app-only automatisiert:</p>
<ol>
  <li><b>Store-App</b> „Intune Printer Mapping" (Produkt-ID <code>9N3TH84TXRF4</code>), auf Wunsch automatisch als Required-App deployt.</li>
  <li><b>ADMX/ADML-Import</b> des Tools (<code>groupPolicyUploadedDefinitionFiles</code>), Dateien liegen versioniert im Tool (Release 1.0.5).</li>
  <li><b>Policy</b> („Imported Administrative Templates") mit Pflicht-Schalter „Enable Intune Printer Mapping" (Machine) und je Drucker einem „Printer operation &lt;N&gt;"-Slot (max. 15, User- oder Machine-Kontext) mit Pfad/Aktion (Add/Delete)/Standarddrucker.</li>
</ol>
<div class="alert alert-warning">
  <strong>⚠️ Manuell bleibt (bewusst, wird in der UI angezeigt):</strong> der Autostart-Freigabe-Eintrag der App
  (PFN <code>HaukeGtze.IntunePrinterMapping_6bk20wvc8rfx2</code>) in einer Geräterestriktions-Richtlinie, sowie
  Treiber und Druckberechtigungen auf den Zieldruckern selbst.
</div>

<h3>⚖️ Warum nicht dieselbe Lösung für beides</h3>
<table class="comparison-table">
  <thead><tr><th>Kriterium</th><th>Drive-Mapping (nicolonsky)</th><th>Printer-Mapping (Weatherlights)</th></tr></thead>
  <tbody>
    <tr><td>Mechanismus</td><td>PowerShell-Plattformskript + Scheduled Task</td><td>Store-App + ADMX-Ingestion</td></tr>
    <tr><td>App-Abhängigkeit</td><td>Keine</td><td>Ja (Store-App als Trägerprozess)</td></tr>
    <tr><td>Warum nicht die Weatherlights-Alternative für Laufwerke?</td><td colspan="2">Weatherlights’ Netzlaufwerk-Tool hängt am Microsoft Store for Business — der Dienst ist von Microsoft eingestellt, damit fiel diese Option weg.</td></tr>
  </tbody>
</table>
<p class="note">Beide Konfiguratoren weisen ihre Profile über dieselben dynamischen GroupTag-Gerätegruppen zu
wie Autopilot/OIB — siehe Abschnitt „🏷️ Namenskonventionen".</p>
`
}
