<script>
  import { config } from '../lib/config.js'
  import { activeTenant, tenants } from '../lib/tenantStore.js'
  import { session } from '../lib/session.js'
  import { tenantConfigState, loadTenantConfig, saveTenantConfig, clearTenantConfig, resetToDefaults } from '../lib/tenantConfig.js'

  // ---------- Vorlage pro Tenant ----------
  // Beim Umschalten die gespeicherte Vorlage des Tenants laden. Gibt es keine,
  // bleibt die aktuelle stehen — ein Wechsel soll nie unbemerkt Eingaben
  // wegwerfen (die Statuszeile sagt dann "noch nicht gespeichert").
  let lastLoadedFor = null
  let saveBusy = $state(false)
  let saveMsg = $state(null)

  $effect(() => {
    const t = $activeTenant
    if (!$session.loggedIn || !t) return
    if (lastLoadedFor === t.id) return
    lastLoadedFor = t.id
    loadTenantConfig(t.id)
  })

  async function saveForTenant() {
    if (!$activeTenant) return
    saveBusy = true
    saveMsg = null
    try {
      await saveTenantConfig($activeTenant.id)
      saveMsg = { ok: true, text: 'Gespeichert.' }
    } catch (e) {
      saveMsg = { ok: false, text: e.message }
    }
    saveBusy = false
    setTimeout(() => (saveMsg = null), 4000)
  }

  async function reloadForTenant() {
    if (!$activeTenant) return
    const r = await loadTenantConfig($activeTenant.id)
    saveMsg = r.loaded
      ? { ok: true, text: 'Gespeicherte Vorlage geladen.' }
      : { ok: false, text: 'Für diesen Tenant ist nichts gespeichert.' }
    setTimeout(() => (saveMsg = null), 4000)
  }

  async function forgetForTenant() {
    if (!$activeTenant) return
    if (!confirm(`Gespeicherte Vorlage für "${$activeTenant.name}" löschen?\n\nDie aktuell angezeigten Werte bleiben stehen — sie sind danach nur nicht mehr hinterlegt.`)) return
    try {
      await clearTenantConfig($activeTenant.id)
      saveMsg = { ok: true, text: 'Gespeicherte Vorlage gelöscht.' }
    } catch (e) {
      saveMsg = { ok: false, text: e.message }
    }
    setTimeout(() => (saveMsg = null), 4000)
  }

  const savedAtText = $derived(
    $tenantConfigState.savedAt ? new Date($tenantConfigState.savedAt).toLocaleString('de-CH') : null
  )

  // Stehen hier gerade die Werte eines ANDEREN Kunden? Das passiert, sobald man auf
  // einen Tenant ohne gespeicherte Vorlage umschaltet: die Eingaben bleiben absichtlich
  // stehen. Unsichtbar ist das gefaehrlich — die Admin-Adresse und die Domains landen
  // sonst beim naechsten Deploy im falschen Kundentenant.
  const inheritedFrom = $derived.by(() => {
    const st = $tenantConfigState
    if (!st.ownerId || !$activeTenant || st.ownerId === $activeTenant.id) return null
    const owner = $tenants.find(t => t.id === st.ownerId)
    return owner ? owner.name : 'einem anderen Tenant'
  })

  function useDefaults() {
    if (!confirm('Standardwerte laden?\n\nDie aktuell angezeigten Werte werden durch die Best-Practice-Vorgaben ersetzt. '
      + 'Eine bereits gespeicherte Vorlage dieses Tenants bleibt unberührt, bis du speicherst.')) return
    resetToDefaults($activeTenant?.id ?? null)
    saveMsg = { ok: true, text: 'Standardwerte geladen — noch nicht gespeichert.' }
    setTimeout(() => (saveMsg = null), 4000)
  }

  // Collapse-Zustand je Policy-Card (Vanilla: toggle-btn -> .expanded).
  let open = $state({ phish: false, spam: false, malware: false, safelinks: false, outbound: false, quarantine: false })
  const toggle = (k) => (open[k] = !open[k])

  function addDomain() { $config.global.domains = [...$config.global.domains, ''] }
  function removeDomain(i) { $config.global.domains = $config.global.domains.filter((_, j) => j !== i) }

  // Platzhalter-Erkennung: example.* darf nie in einen echten Tenant deployt
  // werden — das Backend blockt den Deploy hart, hier die sichtbare Warnung.
  const isPlaceholder = (v) => /(^|[@.])example\.(com|de|org|net)$/i.test(String(v || '').trim())
  const placeholderFields = $derived.by(() => {
    const g = $config.global
    const bad = []
    for (const d of (g.domains || [])) if (isPlaceholder(d)) bad.push(`Domain „${d}“`)
    if (isPlaceholder(g.onmicrosoftDomain)) bad.push('OnMicrosoft-Domain')
    if (isPlaceholder(g.adminEmail)) bad.push('Admin Notification Email')
    if (isPlaceholder(g.igeeksEmail)) bad.push('MSP Alert Email')
    return bad
  })
</script>

<!-- Vorlage am Tenant hinterlegen: sonst stehen nach jedem Reload wieder die
     Platzhalter da und die Werte müssen pro Kunde neu getippt werden. -->
{#if $session.loggedIn && $activeTenant}
  <div class="tcfg-bar">
    <div class="tcfg-status">
      <strong>Vorlage für {$activeTenant.name}</strong>
      {#if $tenantConfigState.loading}
        <span>wird geladen…</span>
      {:else if savedAtText}
        <span>gespeichert am {savedAtText} — beim Wechsel auf diesen Tenant automatisch geladen</span>
      {:else}
        <span>noch nicht gespeichert — die Werte unten gelten nur in diesem Browser-Tab</span>
      {/if}
    </div>
    <div class="tcfg-actions">
      <button class="btn btn-primary" disabled={saveBusy} onclick={saveForTenant}>
        {saveBusy ? 'Speichert…' : '💾 Für diesen Tenant speichern'}
      </button>
      {#if savedAtText}
        <button class="btn btn-secondary" onclick={reloadForTenant}>↺ Gespeicherte laden</button>
      {/if}
      <button class="btn btn-secondary" onclick={useDefaults}>Standardwerte laden</button>
      {#if savedAtText}
        <!-- Hiess "Verwerfen" und klang nach "meine Aenderungen verwerfen". Der Knopf
             loescht aber den GESPEICHERTEN Stand am Tenant. -->
        <button class="btn btn-secondary" onclick={forgetForTenant}>Gespeicherte Vorlage löschen</button>
      {/if}
      {#if saveMsg}
        <span class="tcfg-msg {saveMsg.ok ? 'ok' : 'err'}">{saveMsg.ok ? '✅' : '⚠️'} {saveMsg.text}</span>
      {/if}
    </div>
  </div>

  {#if inheritedFrom}
    <div class="alert alert-warning" style="margin-bottom:1rem">
      ⚠️ <strong>Diese Werte stammen von {inheritedFrom}</strong>, nicht von {$activeTenant.name} — für diesen Tenant
      ist noch keine Vorlage gespeichert, deshalb ist der vorherige Stand stehen geblieben.
      Prüfe vor dem Ausrollen besonders die <strong>Admin-Adresse</strong> und die <strong>Domains</strong>, oder
      lade die Standardwerte.
    </div>
  {/if}
{/if}

<!-- Globale Einstellungen -->
<section class="settings-section">
  <h2>Globale Einstellungen</h2>
  {#if placeholderFields.length}
    <div class="alert alert-warning">
      ⚠️ <strong>Platzhalter-Werte gefunden:</strong> {placeholderFields.join(', ')} —
      <code>example.*</code> sind Beispielwerte und müssen ersetzt werden.
      <strong>Der Live-Deploy ist blockiert, bis das angepasst ist.</strong>
    </div>
  {/if}
  <div class="settings-grid">
    <div class="input-group" style="grid-column: 1 / -1;">
      <label>Accepted Domains</label>
      <div style="display:flex;flex-direction:column;gap:.5rem;margin-bottom:.5rem;">
        {#each $config.global.domains as domain, i}
          <div style="display:flex;gap:.5rem;">
            <input type="text" bind:value={$config.global.domains[i]} placeholder="example.com" style="flex:1;" />
            <button class="btn btn-secondary" onclick={() => removeDomain(i)}
                    disabled={$config.global.domains.length <= 1} title="Entfernen">✕</button>
          </div>
        {/each}
      </div>
      <button class="btn btn-secondary" onclick={addDomain}
              style="width:fit-content;padding:.5rem 1rem;font-size:.875rem;">
        <span style="font-size:1.2rem;margin-right:.25rem;">+</span> Domain hinzufügen
      </button>
      <small>Domains für Policy-Regeln (z.B. example.com, example.de)</small>
    </div>
    <div class="input-group">
      <label for="onmDom">OnMicrosoft Domain</label>
      <input id="onmDom" type="text" bind:value={$config.global.onmicrosoftDomain} placeholder="tenant.onmicrosoft.com" />
    </div>
    <div class="input-group">
      <label for="adminMail">Admin Notification Email</label>
      <input id="adminMail" type="email" bind:value={$config.global.adminEmail} placeholder="admin@example.com" />
    </div>
    <div class="input-group">
      <label for="mspMail">MSP Alert Email</label>
      <input id="mspMail" type="email" bind:value={$config.global.igeeksEmail} />
      <small>Email für Managed Service Alerts (Quarantine Requests)</small>
    </div>
  </div>
</section>

<!-- Policy Cards -->
<section class="policies-section">
  <h2>Security Policies</h2>

  <!-- Anti-Phishing -->
  <div class="policy-card" class:expanded={open.phish}>
    <div class="policy-header" role="button" tabindex="0" onclick={() => toggle('phish')}
         onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggle('phish'))}>
      <div class="policy-title">
        <span class="policy-icon">🛡️</span>
        <div><h3>Anti-Phishing Policy</h3><p class="policy-name">BP_AntiPhishing</p></div>
      </div>
      <span class="toggle-btn" aria-hidden="true">▾</span>
    </div>
    <div class="policy-details" class:active={open.phish}>
      <div class="settings-group">
        <h4>Protection Settings</h4>
        <div class="checkbox-grid">
          <label class="checkbox-label"><input type="checkbox" bind:checked={$config.antiPhishing.spoofIntelligence}><span>Spoof Intelligence</span></label>
          <label class="checkbox-label"><input type="checkbox" bind:checked={$config.antiPhishing.firstContactTip}><span>First Contact Safety Tip</span></label>
          <label class="checkbox-label"><input type="checkbox" bind:checked={$config.antiPhishing.unauthSenderSymbol}><span>Unauthenticated Sender Symbol (?)</span></label>
          <label class="checkbox-label"><input type="checkbox" bind:checked={$config.antiPhishing.viaTag}><span>Show "via" Tag</span></label>
          <label class="checkbox-label"><input type="checkbox" bind:checked={$config.antiPhishing.honorDmarc}><span>Honor DMARC Policy</span></label>
        </div>
      </div>
      <div class="settings-group">
        <h4>Actions</h4>
        <div class="action-grid">
          <div class="input-group"><label>DMARC p=quarantine</label>
            <select bind:value={$config.antiPhishing.dmarcQuarantineAction}>
              <option value="Quarantine">Quarantine</option><option value="Reject">Reject</option><option value="MoveToJmf">Move to Junk</option>
            </select></div>
          <div class="input-group"><label>DMARC p=reject</label>
            <select bind:value={$config.antiPhishing.dmarcRejectAction}>
              <option value="Reject">Reject</option><option value="Quarantine">Quarantine</option>
            </select></div>
          <div class="input-group"><label>Spoof by Intelligence</label>
            <select bind:value={$config.antiPhishing.spoofAction}>
              <option value="Quarantine">Quarantine</option><option value="MoveToJmf">Move to Junk</option>
            </select></div>
        </div>
        <div class="policy-info">
          <small>💡 <strong>Spoof Quarantine:</strong> BP_Quarantine-SelfReleaseNotification</small><br>
          <small>⚠️ <strong>Hinweis:</strong> Spoof Quarantine Policy kann nur per PowerShell gesetzt werden (GUI-Limitation)</small>
        </div>
        <div class="alert alert-warning"><strong>GUI Limitation:</strong> Die Quarantine Policy für Spoof-Fälle kann nur per PowerShell zugewiesen werden.</div>
      </div>
    </div>
  </div>

  <!-- Anti-Spam -->
  <div class="policy-card" class:expanded={open.spam}>
    <div class="policy-header" role="button" tabindex="0" onclick={() => toggle('spam')}
         onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggle('spam'))}>
      <div class="policy-title">
        <span class="policy-icon">📧</span>
        <div><h3>Anti-Spam Inbound Policy</h3><p class="policy-name">BP_AntiSpam_Inbound</p></div>
      </div>
      <span class="toggle-btn" aria-hidden="true">▾</span>
    </div>
    <div class="policy-details" class:active={open.spam}>
      <div class="settings-group">
        <h4>Bulk & Spam Properties</h4>
        <div class="input-group"><label>Admin Email</label>
          <input type="email" bind:value={$config.global.adminEmail}><small>Email für Admin-Benachrichtigungen</small></div>
        <div class="input-group"><label>MSP Alert Email</label>
          <input type="email" bind:value={$config.global.igeeksEmail}><small>Email für Managed Service Alerts (Quarantine Requests)</small></div>
        <div class="alert alert-warning" style="margin-bottom:.75rem;">
          <strong>Legacy-ASF-Optionen (Advanced Spam Filter):</strong> Microsoft empfiehlt <strong>Off</strong> — auch die Microsoft Standard-/Strict-Presets lassen alle aus. Sie übersteuern ARC/Composite-Authentication, erzeugen False Positives (z.B. SPF Hard Fail hinter Verschlüsselungs-Gateways wie SEPPmail) und ASF-Treffer sind bei Microsoft <em>nicht als False Positive meldbar</em>. Nur gezielt und mit klarem Grund aktivieren.
        </div>
        <div class="checkbox-grid">
          <label class="checkbox-label"><input type="checkbox" bind:checked={$config.antiSpam.bizInfoUrls}><span>URLs zu .biz/.info</span></label>
          <label class="checkbox-label"><input type="checkbox" bind:checked={$config.antiSpam.numericIpUrls}><span>Numeric IP in URL</span></label>
          <label class="checkbox-label"><input type="checkbox" bind:checked={$config.antiSpam.urlRedirect}><span>URL Redirect to Other Port</span></label>
          <label class="checkbox-label"><input type="checkbox" bind:checked={$config.antiSpam.emptyMessages}><span>Empty Messages</span></label>
          <label class="checkbox-label"><input type="checkbox" bind:checked={$config.antiSpam.jsVbScript}><span>JavaScript/VBScript in HTML</span></label>
          <label class="checkbox-label"><input type="checkbox" bind:checked={$config.antiSpam.frameIframe}><span>Frame/IFrame Tags</span></label>
          <label class="checkbox-label"><input type="checkbox" bind:checked={$config.antiSpam.sensitiveWords}><span>Sensitive Words (FP-Risiko: Medizin-/Finanzkorrespondenz)</span></label>
          <label class="checkbox-label"><input type="checkbox" bind:checked={$config.antiSpam.spfHardFail}><span>SPF Hard Fail (FP-Risiko hinter Inline-Gateways)</span></label>
          <label class="checkbox-label"><input type="checkbox" bind:checked={$config.antiSpam.backscatter}><span>Backscatter / From-Auth-Fail</span></label>
        </div>
      </div>
      <div class="settings-group">
        <h4>Actions</h4>
        <div class="action-grid">
          <div class="input-group"><label>Spam</label><select bind:value={$config.antiSpam.spamAction}><option value="Quarantine">Quarantine</option><option value="MoveToJmf">Move to Junk</option></select></div>
          <div class="input-group"><label>High Confidence Spam</label><select bind:value={$config.antiSpam.highConfSpamAction}><option value="Quarantine">Quarantine</option><option value="MoveToJmf">Move to Junk</option></select></div>
          <div class="input-group"><label>Bulk</label><select bind:value={$config.antiSpam.bulkAction}><option value="Quarantine">Quarantine</option><option value="MoveToJmf">Move to Junk</option></select></div>
          <div class="input-group"><label>Phishing</label><select bind:value={$config.antiSpam.phishAction}><option value="Quarantine">Quarantine</option><option value="MoveToJmf">Move to Junk</option></select></div>
          <div class="input-group"><label>High Confidence Phishing</label><select bind:value={$config.antiSpam.highConfPhishAction}><option value="Quarantine">Quarantine</option><option value="Reject">Reject</option></select></div>
        </div>
        <div class="policy-info">
          <small>💡 <strong>Phishing Quarantine:</strong> BP_Quarantine-SelfReleaseNotification</small><br>
          <small>💡 <strong>High Conf Phishing Quarantine:</strong> BP_Quarantine-RequestReleaseNotification</small>
        </div>
      </div>
    </div>
  </div>

  <!-- Anti-Malware -->
  <div class="policy-card" class:expanded={open.malware}>
    <div class="policy-header" role="button" tabindex="0" onclick={() => toggle('malware')}
         onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggle('malware'))}>
      <div class="policy-title">
        <span class="policy-icon">🦠</span>
        <div><h3>Anti-Malware Policy</h3><p class="policy-name">BP_AntiMalware</p></div>
      </div>
      <span class="toggle-btn" aria-hidden="true">▾</span>
    </div>
    <div class="policy-details" class:active={open.malware}>
      <div class="settings-group">
        <h4>Protection Settings</h4>
        <label class="checkbox-label"><input type="checkbox" bind:checked={$config.antiMalware.commonAttachFilter}><span>Common Attachments Filter</span></label>
        <label class="checkbox-label"><input type="checkbox" bind:checked={$config.antiMalware.zapMalware}><span>Zero-Hour Auto Purge (ZAP)</span></label>
        <div class="input-group"><label>Custom File Types (comma-separated)</label>
          <textarea rows="3" bind:value={$config.antiMalware.customFileTypes}></textarea></div>
      </div>
      <div class="settings-group">
        <h4>Actions</h4>
        <div class="input-group"><label>Malware Detection Action</label>
          <select bind:value={$config.antiMalware.malwareAction}>
            <option value="Reject">Reject with NDR</option><option value="DeleteMessage">Delete Message</option>
          </select></div>
        <div class="policy-info">
          <small>💡 <strong>Malware Quarantine:</strong> BP_Quarantine-RequestReleaseNotification</small><br>
          <small>💡 <strong>Blocked File Types:</strong> Rejected with NDR (not quarantined)</small>
        </div>
      </div>
    </div>
  </div>

  <!-- Safe Links & Safe Attachments -->
  <div class="policy-card" class:expanded={open.safelinks}>
    <div class="policy-header" role="button" tabindex="0" onclick={() => toggle('safelinks')}
         onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggle('safelinks'))}>
      <div class="policy-title">
        <span class="policy-icon">🔗</span>
        <div><h3>Safe Links &amp; Safe Attachments</h3><p class="policy-name">BP_SafeLinks · BP_SafeAttachments</p></div>
      </div>
      <span class="toggle-btn" aria-hidden="true">▾</span>
    </div>
    <div class="policy-details" class:active={open.safelinks}>
      <div class="settings-group">
        <h4>Voraussetzung</h4>
        <label class="checkbox-label"><input type="checkbox" bind:checked={$config.safeLinks.enabled}><span>Beim Ausrollen mit deployen</span></label>
        <div class="policy-info">
          <small>💡 Braucht Defender for Office 365 Plan 1 (u.a. in Business Premium enthalten) oder Plan 2 (u.a. in E5). Ohne passende Lizenz schlägt nur dieser eine Baustein fehl — der Rest des Deploys läuft trotzdem durch. Lizenz-Status vor dem Ausrollen im Audit-Tab prüfen.</small>
        </div>
      </div>
      <div class="settings-group">
        <h4>Safe Links</h4>
        <label class="checkbox-label"><input type="checkbox" bind:checked={$config.safeLinks.enableForInternalSenders}><span>Auch interne Mails scannen</span></label>
        <label class="checkbox-label"><input type="checkbox" bind:checked={$config.safeLinks.allowClickThrough}><span>Durchklicken trotz Warnung erlauben (weniger sicher)</span></label>
        <div class="policy-info">
          <small>💡 <strong>Best Practice:</strong> beide Häkchen wie voreingestellt lassen — auch interne Mails scannen (bei einem bereits kompromittierten Konto sind es oft interne Empfänger), Durchklicken bei erkannt bösartigen Links nicht erlauben.</small>
        </div>
      </div>
      <div class="settings-group">
        <h4>Safe Attachments</h4>
        <div class="input-group"><label>Aktion bei erkanntem Schadcode</label>
          <select bind:value={$config.safeAttach.action}>
            <option value="Block">Block (Anhang zurückhalten bis der Scan fertig ist)</option>
            <option value="Replace">Replace (Anhang entfernen, Rest zustellen)</option>
            <option value="DynamicDelivery">Dynamic Delivery (Mail sofort ohne Anhang, Anhang nachreichen)</option>
          </select></div>
        <div class="policy-info">
          <small>💡 <strong>Quarantäne-Tag:</strong> BP_Quarantine-RequestReleaseNotification</small><br>
          <small>💡 Block ist Microsofts eigene Empfehlung — höchste Sicherheit, auf Kosten etwas längerer Zustellzeit.</small>
        </div>
      </div>
    </div>
  </div>

  <!-- Ausgehend & Organisation -->
  <div class="policy-card" class:expanded={open.outbound}>
    <div class="policy-header" role="button" tabindex="0" onclick={() => toggle('outbound')}
         onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggle('outbound'))}>
      <div class="policy-title">
        <span class="policy-icon">📤</span>
        <div><h3>Ausgehend &amp; Organisation</h3><p class="policy-name">Standard-Richtlinie · Tenant-Einstellungen</p></div>
      </div>
      <span class="toggle-btn" aria-hidden="true">▾</span>
    </div>
    <div class="policy-details" class:active={open.outbound}>
      <div class="alert alert-info">
        <strong>ℹ️ Kein <code>BP_</code>-Objekt:</strong> Diese Punkte sitzen an der <em>Standard</em>-Richtlinie für
        ausgehenden Spam bzw. direkt am Tenant. Das ist Absicht — sie gelten ohne Regel-Scope für alle Absender,
        und CIS-Benchmark wie Maester lesen genau diese Objekte.
      </div>

      <div class="settings-group">
        <h4>Ausgehender Spam <span class="policy-name">CIS 2.1.6 / 2.1.15</span></h4>
        <label class="checkbox-label">
          <input type="checkbox" bind:checked={$config.outbound.notifyOutboundSpam}>
          <span>Benachrichtigung bei ausgehendem Spam</span>
        </label>
        <small>Meldet ein Konto, das auffällig viele Nachrichten versendet — das typische Muster eines übernommenen
        Postfachs. Empfänger sind <strong>{[$config.global.adminEmail, $config.global.igeeksEmail].filter(Boolean).join(', ') || '(oben eintragen)'}</strong>
        aus den globalen Einstellungen. Ein Sammelpostfach ist einer persönlichen Adresse vorzuziehen, damit die
        Meldung auch in Ferienzeiten gelesen wird.</small>
        <div class="action-grid" style="margin-top:.75rem;">
          <div class="input-group"><label for="obExtH">Empfänger extern / Stunde</label>
            <input id="obExtH" type="number" min="1" max="10000" bind:value={$config.outbound.limitExternalPerHour}></div>
          <div class="input-group"><label for="obIntH">Empfänger intern / Stunde</label>
            <input id="obIntH" type="number" min="1" max="10000" bind:value={$config.outbound.limitInternalPerHour}></div>
          <div class="input-group"><label for="obDay">Empfänger / Tag</label>
            <input id="obDay" type="number" min="1" max="10000" bind:value={$config.outbound.limitPerDay}></div>
          <div class="input-group"><label for="obAct">Aktion bei Überschreitung</label>
            <select id="obAct" bind:value={$config.outbound.thresholdAction}>
              <option value="BlockUserForToday">Sperre bis Tagesende</option>
              <option value="BlockUser">Sperre bis zur manuellen Freigabe (CIS)</option>
            </select></div>
        </div>
        <div class="policy-info">
          <small>💡 Der Ausgangswert <code>0</code> heisst bei dieser Richtlinie nicht «unbegrenzt», sondern
          Service-Default (500/1000/1000). Der explizite Wert ändert das Verhalten nicht, macht es aber prüfbar.</small><br>
          <small>💡 <strong>Sperre bis zur manuellen Freigabe</strong> ist die CIS-Empfehlung, aber eine
          Betriebsentscheidung: es muss geklärt sein, wer im Ereignisfall freigibt.</small>
        </div>
      </div>

      <div class="settings-group">
        <h4>Organisation <span class="policy-name">CIS 6.2.1 / 6.2.3 / 6.5.5</span></h4>
        <label class="checkbox-label">
          <input type="checkbox" bind:checked={$config.outbound.externalTagging}>
          <span>Externe Absender in Outlook kennzeichnen</span>
        </label>
        <small>Wirksamste Einzelmassnahme gegen Phishing und kostenlos. Beim Anwender sichtbar mit bis zu
        48 Stunden Verzögerung.</small>

        <label class="checkbox-label" style="margin-top:.75rem;">
          <input type="checkbox" bind:checked={$config.outbound.blockAutoForward}>
          <span>Automatische Weiterleitung nach aussen sperren</span>
        </label>
        <small>Setzt <code>AutoForwardingMode = Off</code> und legt die Regel <code>BP_Block-AutoForwarding</code> an:
        Ablehnung mit Statuscode 5.7.1 und Begründungstext statt stiller Blockade.</small>
        {#if $config.outbound.blockAutoForward}
          <div class="alert alert-warning" style="margin-top:.5rem;">
            <strong>Vorher erheben:</strong> bestehende gewollte Weiterleitungen brechen sonst.<br>
            <code>Get-Mailbox -ResultSize Unlimited | Where-Object &#123; $_.ForwardingSmtpAddress -or $_.ForwardingAddress &#125;</code>
          </div>
        {/if}

        <label class="checkbox-label" style="margin-top:.75rem;">
          <input type="checkbox" bind:checked={$config.outbound.rejectDirectSend}>
          <span>Direct Send abweisen</span>
        </label>
        <small>Verhindert, dass fremde Systeme unauthentifiziert Mails mit einer Absenderadresse des Tenants
        einliefern.</small>
        {#if $config.outbound.rejectDirectSend}
          <div class="alert alert-warning" style="margin-top:.5rem;">
            <strong>Unterbruchrisiko:</strong> Multifunktionsdrucker, Scan-to-Mail, Monitoring und Fachanwendungen mit
            eigenem Mailversand werden <em>ohne Fehlermeldung an den Absender</em> abgeschnitten. Vorher den
            Mailverkehr über mindestens einen Monatswechsel auswerten, damit Monatsläufe wie Lohn oder Fakturierung
            im Erhebungszeitraum liegen:<br>
            <code>Get-MessageTraceV2 -StartDate (Get-Date).AddDays(-10) -EndDate (Get-Date)</code><br>
            Nach dem Setzen kontrollieren, ob etwas abgewiesen wurde (<code>-Status Failed</code>).
          </div>
        {/if}
      </div>

      <div class="policy-info">
        <small>🔔 Microsoft hat <code>NotifyOutboundSpam</code> zugunsten der Warnungsrichtlinien abgekündigt. Das
        Snippet im Tab «Mail-Security» setzt deshalb zusätzlich die eingebaute Richtlinie
        <strong>User restricted from sending email</strong> auf dieselben Empfänger — bestehende Empfänger dort
        bleiben erhalten.</small>
      </div>
    </div>
  </div>

  <!-- Quarantine (informativ) -->
  <div class="policy-card" class:expanded={open.quarantine}>
    <div class="policy-header" role="button" tabindex="0" onclick={() => toggle('quarantine')}
         onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggle('quarantine'))}>
      <div class="policy-title">
        <span class="policy-icon">🔒</span>
        <div><h3>Quarantine Policies</h3><p class="policy-name">Custom Release Workflows</p></div>
      </div>
      <span class="toggle-btn" aria-hidden="true">▾</span>
    </div>
    <div class="policy-details" class:active={open.quarantine}>
      <div class="alert alert-info"><strong>ℹ️ Wichtig:</strong> Eigene Quarantine Policies sind zwingend erforderlich für transparente User Experience und definierte Release-Governance.</div>
      <div class="quarantine-policy">
        <h4>BP_Quarantine-SelfReleaseNotification</h4>
        <p class="policy-description">Für Spam, Bulk, Spoof und normale Phishing-Fälle (Permissions-Wert 59)</p>
        <div class="permissions-list">
          <span class="permission enabled">✓ Request Release</span>
          <span class="permission enabled">✓ Allow Sender</span>
          <span class="permission enabled">✓ Block Sender</span>
          <span class="permission enabled">✓ Preview</span>
          <span class="permission enabled">✓ Delete</span>
          <span class="permission enabled">✓ Notifications (inkl. blockierte Absender)</span>
          <span class="permission disabled">✗ Direct Release</span>
        </div>
      </div>
      <div class="quarantine-policy">
        <h4>BP_Quarantine-RequestReleaseNotification</h4>
        <p class="policy-description">Für High Confidence Phishing und Malware mit Admin-Kontrolle (Permissions-Wert 26)</p>
        <div class="permissions-list">
          <span class="permission enabled">✓ Request Release</span>
          <span class="permission enabled">✓ Block Sender</span>
          <span class="permission enabled">✓ Preview</span>
          <span class="permission enabled">✓ Notifications (ohne blockierte Absender)</span>
          <span class="permission disabled">✗ Allow Sender</span>
          <span class="permission disabled">✗ Delete</span>
          <span class="permission disabled">✗ Direct Release</span>
        </div>
      </div>
    </div>
  </div>
</section>
