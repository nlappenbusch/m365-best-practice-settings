<script>
  import { config } from '../lib/config.js'
  import { activeTenant } from '../lib/tenantStore.js'
  import { session } from '../lib/session.js'
  import { tenantConfigState, loadTenantConfig, saveTenantConfig, clearTenantConfig } from '../lib/tenantConfig.js'

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

  // Collapse-Zustand je Policy-Card (Vanilla: toggle-btn -> .expanded).
  let open = $state({ phish: false, spam: false, malware: false, quarantine: false })
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
        <button class="btn btn-secondary" onclick={forgetForTenant}>Verwerfen</button>
      {/if}
      {#if saveMsg}
        <span class="tcfg-msg {saveMsg.ok ? 'ok' : 'err'}">{saveMsg.ok ? '✅' : '⚠️'} {saveMsg.text}</span>
      {/if}
    </div>
  </div>
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
