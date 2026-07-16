// Verbatim aus dem Vanilla-app.js portiert (loadDocumentation / loadRecommendations).
// Reiner Lesestoff — bis auf die eine Admin-Mail keine Dynamik.
/* eslint-disable */
export function docsHtml() {
  return `        <h3>🎯 Zielsetzung</h3>
        <p>Die Best-Practice Anti-Threat Konfiguration verfolgt folgende Ziele:</p>
        <ul>
            <li>Schutz vor Spoofing, Phishing und Malware</li>
            <li>Transparente Benutzerführung (Safety Tips + Quarantäne-Dialoge)</li>
            <li>Kontrollierte Freigabeprozesse</li>
            <li>Minimierung von False Positives</li>
            <li>Nachvollziehbare Admin-Benachrichtigung</li>
        </ul>

        <h3>🔐 Warum eigene Quarantäne-Policies zwingend sind</h3>
        <div class="alert alert-warning">
            <strong>⚠️ Microsoft Default Verhalten:</strong>
            <ul>
                <li>Unklare Userrechte und inkonsistente Freigabelogik</li>
                <li>Keine granular steuerbare Benachrichtigungen</li>
                <li>Keine definierte Release-Governance</li>
                <li>Intransparente User Experience</li>
            </ul>
        </div>

        <p><strong>Lösung:</strong> Zwei differenzierte Quarantine Policies:</p>
        <ul>
            <li><code>BP_Quarantine-SelfReleaseNotification</code> (Permissions 59) - Für Spam, Bulk, Spoof und normale Phishing-Fälle:
                User können Freigabe anfordern, Absender erlauben/blockieren, Vorschau und Löschen;
                Benachrichtigung inklusive Nachrichten von blockierten Absendern</li>
            <li><code>BP_Quarantine-RequestReleaseNotification</code> (Permissions 26) - Für High Confidence Phishing und Malware:
                nur Freigabe anfordern, Absender blockieren und Vorschau;
                Benachrichtigung ohne Nachrichten von blockierten Absendern</li>
        </ul>

        <h3>📧 Alert Policy für Managed Services</h3>
        <div class="alert alert-info">
            <strong>ℹ️ Wichtig für Managed Service Provider:</strong>
            Die Alert Policy <code>BP_UserRequestReleaseStatus</code> benachrichtigt den MSP automatisch, 
            wenn User eine Freigabe von quarantinierten Nachrichten anfordern.
        </div>
        <p><strong>Warum ist das kritisch?</strong></p>
        <ul>
            <li>User können Nachrichten NICHT selbst freigeben, sondern nur eine Freigabe-Anfrage stellen ("Request Release")</li>
            <li>Ohne Alert Policy würde der MSP diese Anfragen nicht mitbekommen</li>
            <li>Besonders wichtig für High Confidence Phishing und Malware</li>
        </ul>
        <p><strong>Empfänger:</strong></p>
        <ul>
            <li>Tenant Admin Email (konfigurierbar)</li>
            <li>MSP Alert Email (konfigurierbar, Standard: <code>support@msp-provider.com</code>)</li>
        </ul>
        <p><strong>Technische Details:</strong></p>
        <ul>
            <li><strong>Cmdlet:</strong> <code>New-ActivityAlert</code> (nicht New-ProtectionAlert!)</li>
            <li><strong>Operation:</strong> <code>QuarantineRequestReleaseMessage</code></li>
            <li><strong>Lizenz:</strong> Funktioniert mit EOP (alle M365 Lizenzen)</li>
            <li><strong>Severity:</strong> Low (informative Benachrichtigung)</li>
        </ul>

        <h3>⚠️ GUI Limitation: PowerShell Workaround</h3>
        <p>Microsoft implementiert in der GUI <strong>keine Auswahl der Quarantäne-Policy</strong> für Anti-Phishing Spoof-Fälle.</p>
        <p><strong>Lösung:</strong> Zuweisung per PowerShell:</p>
        <pre><code>Set-AntiPhishPolicy -Identity "BP_AntiPhishing" \`
    -SpoofQuarantineTag "BP_Quarantine-SelfReleaseNotification"</code></pre>

        <h3>📊 Aktionen-Differenzierung</h3>
        <table class="comparison-table">
            <thead>
                <tr>
                    <th>Kategorie</th>
                    <th>Aktion</th>
                    <th>Begründung</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td>Spam / Bulk</td>
                    <td>Quarantine (Self-Release-Policy)</td>
                    <td>Zentrale Kontrolle statt Junk-Ordner; User werden benachrichtigt und können Freigabe anfordern</td>
                </tr>
                <tr>
                    <td>Phishing</td>
                    <td>Quarantine (Self-Release-Policy)</td>
                    <td>Erhöhtes Risiko, kontrollierte Freigabe</td>
                </tr>
                <tr>
                    <td>High Confidence Phishing</td>
                    <td>Quarantine (Request-Release)</td>
                    <td>Hohes Risiko, Admin-Kontrolle</td>
                </tr>
                <tr>
                    <td>Malware</td>
                    <td>Reject with NDR</td>
                    <td>Kritisches Risiko, technische Ablehnung</td>
                </tr>
            </tbody>
        </table>

        <h3>🛡️ DMARC Honor Policy</h3>
        <p>Die Konfiguration respektiert DMARC-Records der Absender-Domains:</p>
        <ul>
            <li><strong>DMARC p=reject</strong> → Nachricht wird abgelehnt</li>
            <li><strong>DMARC p=quarantine</strong> → Nachricht wird in Quarantäne verschoben</li>
            <li><strong>Spoof Intelligence</strong> → Verdächtige Nachrichten werden in Quarantäne verschoben</li>
        </ul>`;
}

export function recoHtml(adminEmail) {
  return `        <h3>🎯 Lizenz-Überlegungen</h3>
        <div class="alert alert-info">
            <strong>ℹ️ Aktueller Scope:</strong> Diese Konfiguration basiert auf <strong>Exchange Online Protection (EOP)</strong> - enthalten in allen M365 Business/Enterprise Lizenzen.
        </div>

        <table class="comparison-table">
            <thead>
                <tr>
                    <th>Feature</th>
                    <th>EOP (Basis)</th>
                    <th>Defender for Office 365 P1</th>
                    <th>Defender for Office 365 P2</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td>Anti-Phishing / Anti-Spam / Anti-Malware</td>
                    <td>✅ Enthalten</td>
                    <td>✅ Erweitert</td>
                    <td>✅ Erweitert</td>
                </tr>
                <tr>
                    <td>Quarantine Policies</td>
                    <td>✅ Enthalten</td>
                    <td>✅ Enthalten</td>
                    <td>✅ Enthalten</td>
                </tr>
                <tr>
                    <td>Safe Links (URL Protection)</td>
                    <td>❌</td>
                    <td>✅</td>
                    <td>✅</td>
                </tr>
                <tr>
                    <td>Safe Attachments (Sandbox)</td>
                    <td>❌</td>
                    <td>✅</td>
                    <td>✅</td>
                </tr>
                <tr>
                    <td>Threat Investigation & Response</td>
                    <td>❌</td>
                    <td>❌</td>
                    <td>✅</td>
                </tr>
                <tr>
                    <td>Automated Investigation (AIR)</td>
                    <td>❌</td>
                    <td>❌</td>
                    <td>✅</td>
                </tr>
            </tbody>
        </table>

        <h3>🔒 Härtungs-Empfehlungen (ohne Lizenz-Upgrade)</h3>
        <ul>
            <li><strong>Legacy-ASF-Optionen aus lassen:</strong> Die Advanced-Spam-Filter-Schalter (SPF Hard Fail, Sensitive Words, JavaScript in HTML, …)
                übersteuern ARC/Composite-Authentication, erzeugen False Positives (z.B. hinter Verschlüsselungs-Gateways wie SEPPmail)
                und ASF-Treffer sind nicht als False Positive meldbar. Microsoft-Empfehlung und Tool-Default: <strong>Off</strong></li>
            <li><strong>Tenant Allow/Block List pflegen:</strong> Regelmäßige Pflege der Allow/Block Listen im Security Portal</li>
            <li><strong>Custom File Types erweitern:</strong> Zusätzliche gefährliche Dateitypen blockieren (z.B. .docm, .xlsm, .pptm)</li>
            <li><strong>DMARC für eigene Domains:</strong> DMARC-Records mit p=quarantine oder p=reject implementieren</li>
            <li><strong>User Awareness Training:</strong> Regelmäßige Schulungen zu Phishing-Erkennung</li>
        </ul>

        <h3>📋 Operational Best Practices</h3>
        
        <h4>Monitoring & Reporting</h4>
        <ul>
            <li><strong>Quarantine Review:</strong> Tägliche Überprüfung der Quarantine für False Positives</li>
            <li><strong>Threat Dashboard:</strong> Wöchentliche Analyse im Microsoft 365 Security Center</li>
            <li><strong>Admin Notifications:</strong> Sicherstellen dass <code>${adminEmail}</code> aktiv überwacht wird</li>
            <li><strong>Message Trace:</strong> Bei Problemen Message Trace für Debugging nutzen</li>
        </ul>

        <h4>Wartung & Updates</h4>
        <ul>
            <li><strong>Quartalweise Review:</strong> Policies alle 3 Monate auf Aktualität prüfen</li>
            <li><strong>Allow/Block List Cleanup:</strong> Veraltete Einträge monatlich entfernen</li>
            <li><strong>File Type List Update:</strong> Neue Bedrohungen in Custom File Types aufnehmen</li>
            <li><strong>Microsoft Updates:</strong> Neue EOP-Features regelmäßig evaluieren</li>
        </ul>

        <h3>⚡ Quick Wins</h3>
        <div class="quick-wins-grid">
            <div class="quick-win-card">
                <h4>🎯 DMARC Enforcement</h4>
                <p>Aktiviere "Honor DMARC Policy" um Spoofing-Schutz zu maximieren</p>
                <code>✅ Bereits in Best Practice aktiviert</code>
            </div>
            <div class="quick-win-card">
                <h4>🔔 User Notifications</h4>
                <p>Aktiviere End-User Spam Notifications für Transparenz</p>
                <code>✅ Bereits in Best Practice aktiviert</code>
            </div>
            <div class="quick-win-card">
                <h4>🗑️ Zero-Hour Auto Purge</h4>
                <p>ZAP entfernt Malware automatisch aus Postfächern</p>
                <code>✅ Bereits in Best Practice aktiviert</code>
            </div>
            <div class="quick-win-card">
                <h4>⚠️ Safety Tips</h4>
                <p>Visuelle Warnungen bei verdächtigen E-Mails</p>
                <code>✅ Bereits in Best Practice aktiviert</code>
            </div>
        </div>

        <h3>🚨 Häufige Fehler vermeiden</h3>
        <div class="alert alert-warning">
            <strong>⚠️ Typische Fallstricke:</strong>
            <ul>
                <li><strong>Zu viele Allow-List Einträge:</strong> Reduziert Schutz erheblich - nur wenn absolut notwendig</li>
                <li><strong>Bulk Threshold zu hoch:</strong> Werte über 7 lassen zu viel Spam durch</li>
                <li><strong>Quarantine ohne Monitoring:</strong> Quarantine muss regelmäßig überprüft werden</li>
                <li><strong>Default Quarantine Policy:</strong> Immer eigene Policies verwenden für Kontrolle</li>
                <li><strong>Fehlende DMARC Records:</strong> Eigene Domains ohne DMARC sind anfällig für Spoofing</li>
            </ul>
        </div>

        <h3>📊 Schutzumfang-Übersicht</h3>
        <table class="comparison-table">
            <thead>
                <tr>
                    <th>Bedrohungstyp</th>
                    <th>Schutzlevel (EOP)</th>
                    <th>Empfehlung</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td>Known Malware</td>
                    <td>✅ Hoch</td>
                    <td>Gut abgedeckt durch Signatur-basierte Erkennung</td>
                </tr>
                <tr>
                    <td>Known Phishing</td>
                    <td>✅ Hoch</td>
                    <td>Gut abgedeckt durch Heuristik + DMARC</td>
                </tr>
                <tr>
                    <td>Spoofing / DMARC</td>
                    <td>✅ Hoch</td>
                    <td>Exzellent mit Honor DMARC Policy</td>
                </tr>
                <tr>
                    <td>Spam / Bulk</td>
                    <td>✅ Hoch</td>
                    <td>Gut konfigurierbar mit Bulk Threshold</td>
                </tr>
                <tr>
                    <td>Zero-Day URLs</td>
                    <td>⚠️ Mittel</td>
                    <td>Upgrade auf Defender P1 für Safe Links empfohlen</td>
                </tr>
                <tr>
                    <td>Zero-Day Attachments</td>
                    <td>⚠️ Mittel</td>
                    <td>Upgrade auf Defender P1 für Safe Attachments empfohlen</td>
                </tr>
                <tr>
                    <td>Advanced Persistent Threats</td>
                    <td>⚠️ Niedrig</td>
                    <td>Upgrade auf Defender P2 für AIR + Threat Hunting</td>
                </tr>
            </tbody>
        </table>

        <h3>🎓 Weiterführende Ressourcen</h3>
        <ul>
            <li><a href="https://docs.microsoft.com/en-us/microsoft-365/security/office-365-security/" target="_blank">Microsoft 365 Security Documentation</a></li>
            <li><a href="https://docs.microsoft.com/en-us/microsoft-365/security/office-365-security/recommended-settings-for-eop-and-office365" target="_blank">Microsoft Recommended Settings for EOP</a></li>
            <li><a href="https://docs.microsoft.com/en-us/microsoft-365/security/office-365-security/quarantine-policies" target="_blank">Quarantine Policies Documentation</a></li>
            <li><a href="https://docs.microsoft.com/en-us/microsoft-365/security/office-365-security/anti-spam-protection" target="_blank">Anti-Spam Protection</a></li>
        </ul>`;
}
