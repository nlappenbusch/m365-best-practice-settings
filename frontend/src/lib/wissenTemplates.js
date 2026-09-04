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

        <div class="flow-diagram" role="img" aria-label="Mail-Flow: Internet, EOP-Filter, Aktion je Kategorie, Postfach">
          <svg viewBox="0 0 860 230" xmlns="http://www.w3.org/2000/svg" font-family="inherit">
            <g style="fill:var(--bg-raised);stroke:var(--rule)" stroke-width="1.5">
              <rect x="6" y="90" width="110" height="50" rx="9"></rect>
            </g>
            <text x="61" y="120" text-anchor="middle" style="fill:var(--text);font-size:13px;font-weight:700">Internet</text>

            <path d="M116 115 H176" style="stroke:var(--text-faint)" stroke-width="2" marker-end="url(#arrow1)"></path>

            <g style="fill:var(--accent-wash);stroke:var(--accent)" stroke-width="1.5">
              <rect x="180" y="70" width="150" height="90" rx="9"></rect>
            </g>
            <text x="255" y="98" text-anchor="middle" style="fill:var(--accent);font-size:12px;font-weight:700">EOP-Filter</text>
            <text x="255" y="118" text-anchor="middle" style="fill:var(--text-dim);font-size:10.5px">Anti-Spam</text>
            <text x="255" y="133" text-anchor="middle" style="fill:var(--text-dim);font-size:10.5px">Anti-Phishing</text>
            <text x="255" y="148" text-anchor="middle" style="fill:var(--text-dim);font-size:10.5px">Anti-Malware</text>

            <path d="M330 78 H392" style="stroke:var(--text-faint)" stroke-width="2" marker-end="url(#arrow1)"></path>
            <path d="M330 115 H392" style="stroke:var(--text-faint)" stroke-width="2" marker-end="url(#arrow1)"></path>
            <path d="M330 152 H392" style="stroke:var(--text-faint)" stroke-width="2" marker-end="url(#arrow1)"></path>

            <g style="fill:var(--ok-wash);stroke:var(--ok)" stroke-width="1.5"><rect x="396" y="6" width="220" height="34" rx="8"></rect></g>
            <text x="506" y="27" text-anchor="middle" style="fill:var(--ok);font-size:10px;font-weight:700">Spam/Phishing → Quarantäne (Self-Release)</text>

            <g style="fill:var(--warn-wash);stroke:var(--warn)" stroke-width="1.5"><rect x="396" y="98" width="220" height="34" rx="8"></rect></g>
            <text x="506" y="119" text-anchor="middle" style="fill:var(--warn);font-size:10px;font-weight:700">High-Conf. Phishing → Quarantäne (Request)</text>

            <g style="fill:var(--crit-wash);stroke:var(--crit)" stroke-width="1.5"><rect x="396" y="190" width="220" height="34" rx="8"></rect></g>
            <text x="506" y="211" text-anchor="middle" style="fill:var(--crit);font-size:10px;font-weight:700">Malware → Reject (NDR)</text>

            <path d="M616 23 H676" style="stroke:var(--ok)" stroke-width="2" marker-end="url(#arrowOk)"></path>
            <path d="M616 115 H676" style="stroke:var(--warn)" stroke-width="2" marker-end="url(#arrowWarn)"></path>
            <path d="M616 207 H676" style="stroke:var(--crit)" stroke-width="2" marker-end="url(#arrowCrit)"></path>

            <g style="fill:var(--bg-raised);stroke:var(--rule)" stroke-width="1.5"><rect x="680" y="70" width="174" height="90" rx="9"></rect></g>
            <text x="767" y="105" text-anchor="middle" style="fill:var(--text);font-size:12.5px;font-weight:700">📥 Postfach</text>
            <text x="767" y="126" text-anchor="middle" style="fill:var(--text-dim);font-size:10.5px">Quarantäne-Mail</text>
            <text x="767" y="141" text-anchor="middle" style="fill:var(--text-dim);font-size:10.5px">mit Freigabe-Option</text>

            <defs>
              <marker id="arrow1" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" style="fill:var(--text-faint)"></path></marker>
              <marker id="arrowOk" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" style="fill:var(--ok)"></path></marker>
              <marker id="arrowWarn" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" style="fill:var(--warn)"></path></marker>
              <marker id="arrowCrit" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" style="fill:var(--crit)"></path></marker>
            </defs>
          </svg>
        </div>

        <div class="tool-tie-in">
          <span>🛠️</span>
          <div><b>So macht das unser Tool:</b> Alle <code>BP_</code>-Policies dieser Seite werden per Klick
          ausgerollt im Tab <b>🛡 Mail-Security</b>; der aktuelle Ist-Zustand eines Tenants inkl. gewollter
          Abweichungen mit Begründung steht im Tab <b>🔎 Audit</b>.
          <div style="margin-top:.5rem;display:flex;gap:.5rem;flex-wrap:wrap;">
            <button type="button" class="btn btn-secondary tool-jump-btn" data-goto="mailsec">🛡 Zu Mail-Security</button>
            <button type="button" class="btn btn-secondary tool-jump-btn" data-goto="audit">🔎 Zum Audit</button>
          </div></div>
        </div>

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
        <p class="note">📐 <strong>Werte stehen in der Baseline.</strong> Welche Kategorie welche Aktion auslöst, steht unten in der Baseline-Fassung — dort wird es gepflegt, hier stand es bisher als Kopie.</p>

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

        <p class="note">📐 <strong>Werte stehen in der Baseline.</strong> Die Feature-Matrix EOP / Defender P1 / P2 steht unten in der Baseline-Fassung, zusammen mit der Regel zur Admin-Lizenz für den Threat Explorer.</p>

        <h3>🔒 Härtungs-Empfehlungen (ohne Lizenz-Upgrade)</h3>
        <p class="note">📐 <strong>Werte stehen in der Baseline.</strong> Die Härtungspunkte stehen unten in der Baseline-Fassung.</p>

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
            <li><strong>Microsoft Updates:</strong> Neue EOP-Features regelmässig evaluieren</li>
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
                <li><strong>Quarantine ohne Monitoring:</strong> Quarantine muss regelmässig überprüft werden</li>
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
