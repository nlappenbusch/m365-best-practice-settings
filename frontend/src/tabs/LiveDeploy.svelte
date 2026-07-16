<script>
  import { onMount, onDestroy } from 'svelte'
  import { initializeLiveDeploy } from '../lib/livedeploy-legacy.js'

  // Die 820 Zeilen Deploy-Logik sind battle-tested und bleiben verbatim; die
  // Komponente stellt nur das Markup bereit und startet/raeumt sie auf.
  let teardown
  onMount(() => { teardown = initializeLiveDeploy() })
  onDestroy(() => { try { teardown && teardown() } catch (e) {} })
</script>

<div id="livedeploy">
  <section class="settings-section">
    <h2>🚀 Live-Deploy — Policies direkt anwenden</h2>
    <div class="alert alert-info">
      <strong>ℹ️ So funktioniert es:</strong> Statt das generierte PowerShell-Skript manuell auszuführen,
      wendet das Backend die aktuelle Konfiguration direkt per app-only Exchange Online PowerShell an — mit
      Live-Fortschritt. Mit <strong>🔎 Prüfen</strong> siehst du jederzeit den Ist-Zustand des Tenants als
      Soll/Ist-Vergleich. Einmalig pro Tenant: <strong>Onboarding</strong> per Admin-Login (Device-Code) — dabei
      werden App-Registrierung, <code>Exchange.ManageAsApp</code>-Permission, Rollen und Zertifikat automatisch
      angelegt. Nur die Alert Policy (Security &amp; Compliance) bleibt ein manueller Mini-Schritt — Microsoft
      unterstützt S&amp;C PowerShell nicht auf Linux; das Tool liefert dafür ein fertiges Copy-Paste-Snippet.
    </div>

    <div id="ldOffline" class="alert alert-warning" style="display: none;">
      <strong>⚠️ Backend nicht erreichbar.</strong> Das Live-Deploy-Backend läuft nur im Docker-Stack
      (<code>docker compose up -d</code>). Im statischen Betrieb stehen weiterhin die generierten
      PowerShell-Skripte zur Verfügung.
    </div>

    <div id="ldNeedLogin" class="alert alert-warning" style="display: none;">
      <strong>🔒 Nicht angemeldet.</strong> Oben rechts im Header auf <strong>Anmelden</strong> klicken.
    </div>

    <div id="ldMain" style="display: none;">
      <div class="settings-group">
        <h4>Onboardete Tenants</h4>
        <label class="checkbox-label" style="margin-bottom: 0.75rem;">
          <input type="checkbox" id="ldAutoDomains" checked />
          <span>Domains automatisch aus dem Ziel-Tenant übernehmen (Get-AcceptedDomain) — empfohlen; sonst gelten
            die Domains aus dem Konfigurations-Tab</span>
        </label>
        <div id="ldTenants"></div>
      </div>

      <div class="settings-group">
        <h4>Neuen Tenant onboarden</h4>
        <div class="settings-grid">
          <div class="input-group" style="grid-column: 1 / -1;">
            <label for="ldOnboardTenant">Tenant</label>
            <input type="text" id="ldOnboardTenant" placeholder="kunde.onmicrosoft.com oder Tenant-ID" />
            <small>Der Admin-Login legt automatisch die App-Registrierung "M365-Security-Policy-Manager" mit
              Zertifikat an.</small>
          </div>
        </div>
        <button id="ldOnboardBtn" class="btn btn-primary">Onboarding starten</button>
        <div id="ldDeviceCode" class="alert alert-info" style="display: none; margin-top: 0.75rem;"></div>
      </div>

      <div class="settings-group">
        <h4>Ergebnis</h4>
        <div id="ldLog" class="ld-log">Noch kein Deploy ausgeführt.</div>
      </div>
    </div>
  </section>
</div>
