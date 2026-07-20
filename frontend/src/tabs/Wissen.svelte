<script>
  import { config } from '../lib/config.js'
  import { docsHtml, recoHtml } from '../lib/wissenTemplates.js'
  import { autopilotHtml, oibHtml, namingHtml, patchMyPcHtml } from '../lib/wissenIntune.js'
  import { openConfigDoc } from '../lib/configDoc.js'
  import { openKnowledgeDoc } from '../lib/knowledgeDoc.js'

  const docs = docsHtml()
  let reco = $derived(recoHtml($config.global.adminEmail))
  const autopilot = autopilotHtml()
  const oib = oibHtml()
  const naming = namingHtml()
  const patchMyPc = patchMyPcHtml()

  let sub = $state('mailsec')

  function pdfMailSecurity() {
    openKnowledgeDoc({
      title: 'Mail-Security — Best Practice Dokumentation',
      lead: 'Hintergrund und Best Practices zur Exchange-Online-Schutzkonfiguration',
      bodyHtml: '<h3>Best Practice Documentation</h3>' + docs + '<h3>Best Practices &amp; Empfehlungen</h3>' + reco,
      footerNote: 'Reiner Hintergrund-/Referenztext, unabhängig vom konkreten Tenant.'
    })
  }
  function pdfAutopilot() {
    openKnowledgeDoc({
      title: 'Autopilot — Geräteprovisionierung (Blueprint)',
      lead: 'GroupTag-Konzept, Admin-Einmal-Setup, Feld-Runbook und Sicherheitshinweise',
      bodyHtml: autopilot,
      footerNote: 'Abgeglichen mit den Tabs 🚀 Autopilot / 💻 Intune dieses Tools.'
    })
  }
  function pdfOib() {
    openKnowledgeDoc({
      title: 'OpenIntuneBaseline (OIB) — Management Summary',
      lead: 'Auditfähige Begründung des CIS-Deltas, ISO-27001-Mapping und praktische Anwendung',
      bodyHtml: oib,
      footerNote: 'Referenz-Frameworks: CIS Windows Benchmarks, Microsoft Intune Security Baseline, ISO/IEC 27001 Annex A (2022).'
    })
  }
  function pdfNaming() {
    openKnowledgeDoc({
      title: 'Gruppenkonzept & Namenskonventionen M365',
      lead: 'Zentrale Referenz für Entra-ID-Gruppen in Managed-Setups',
      bodyHtml: naming,
      footerNote: 'Gilt für Autopilot-, OIB- und App-Zuweisungen gleichermassen.'
    })
  }
</script>

<section class="docs-section">
  <h2>📘 Konfig-Doku (PDF)</h2>
  <div class="alert alert-info" style="display:flex;align-items:center;gap:1rem;flex-wrap:wrap;">
    <div style="flex:1;min-width:260px;">
      <strong>Nüchterne Konfigurationsdokumentation der aktuellen Mail-Security-Vorlage</strong> —
      alle <code>BP_</code>-Policies mit Parametern, Quarantäne-Berechtigungen, ASF-Begründung und
      Dateityp-Liste. Wird live aus der Vorlage erzeugt und ist damit immer aktuell.
    </div>
    <button class="btn btn-primary" style="white-space:nowrap;" onclick={() => openConfigDoc($config)}>
      📘 Öffnen / als PDF speichern
    </button>
  </div>
  <p style="font-size:.85rem;color:var(--text-dim);margin-top:.5rem;">
    💡 Die Doku eines <em>konkreten Tenants</em> (Ist-Zustand + gewollte Abweichungen mit Begründung)
    gibt es im Tab <strong>🔎 Audit</strong>.
  </p>
</section>

<div class="dl-subtabs">
  <button type="button" class="dl-subtab" class:active={sub === 'mailsec'} onclick={() => (sub = 'mailsec')}>🛡 Mail-Security</button>
  <button type="button" class="dl-subtab" class:active={sub === 'autopilot'} onclick={() => (sub = 'autopilot')}>🚀 Autopilot</button>
  <button type="button" class="dl-subtab" class:active={sub === 'oib'} onclick={() => (sub = 'oib')}>💻 OpenIntuneBaseline</button>
  <button type="button" class="dl-subtab" class:active={sub === 'pmp'} onclick={() => (sub = 'pmp')}>🧩 Patch My PC</button>
  <button type="button" class="dl-subtab" class:active={sub === 'naming'} onclick={() => (sub = 'naming')}>🏷️ Namenskonventionen</button>
</div>

<div class="dl-panel" class:active={sub === 'mailsec'}>
  <div class="ld-confirm-actions" style="margin-bottom:0.5rem;">
    <button class="btn btn-secondary" onclick={pdfMailSecurity}>📄 Als PDF speichern</button>
  </div>
  <section class="docs-section">
    <h2>Best Practice Documentation</h2>
    <div class="docs-content">{@html docs}</div>
  </section>
  <section class="recommendations-section">
    <h2>Best Practices &amp; Empfehlungen</h2>
    <div class="recommendations-content">{@html reco}</div>
  </section>
</div>

<div class="dl-panel" class:active={sub === 'autopilot'}>
  <div class="ld-confirm-actions" style="margin-bottom:0.5rem;">
    <button class="btn btn-secondary" onclick={pdfAutopilot}>📄 Als PDF speichern</button>
  </div>
  <section class="docs-section">
    <h2>Blueprint — Geräteprovisionierung (Autopilot)</h2>
    <div class="docs-content">{@html autopilot}</div>
  </section>
</div>

<div class="dl-panel" class:active={sub === 'oib'}>
  <div class="ld-confirm-actions" style="margin-bottom:0.5rem;">
    <button class="btn btn-secondary" onclick={pdfOib}>📄 Als PDF speichern (Audit-tauglich)</button>
  </div>
  <section class="docs-section">
    <h2>OpenIntuneBaseline (OIB) — Management Summary</h2>
    <div class="docs-content">{@html oib}</div>
  </section>
</div>

<div class="dl-panel" class:active={sub === 'pmp'}>
  <section class="docs-section">
    <h2>Automatisiertes Third-Party-Patch- und App-Management mit Patch My PC</h2>
    <div class="docs-content">{@html patchMyPc}</div>
  </section>
</div>

<div class="dl-panel" class:active={sub === 'naming'}>
  <div class="ld-confirm-actions" style="margin-bottom:0.5rem;">
    <button class="btn btn-secondary" onclick={pdfNaming}>📄 Als PDF speichern</button>
  </div>
  <section class="docs-section">
    <h2>Gruppenkonzept &amp; Namenskonventionen M365 (Blueprint)</h2>
    <div class="docs-content">{@html naming}</div>
  </section>
</div>
