<script>
  import { config } from '../lib/config.js'
  import { docsHtml, recoHtml } from '../lib/wissenTemplates.js'
  import { openConfigDoc } from '../lib/configDoc.js'

  // docs ist statisch; reco haengt nur an der Admin-Mail aus dem Config-Store.
  const docs = docsHtml()
  let reco = $derived(recoHtml($config.global.adminEmail))
</script>

<section class="docs-section">
  <h2>📘 Konfig-Doku (PDF)</h2>
  <div class="alert alert-info" style="display:flex;align-items:center;gap:1rem;flex-wrap:wrap;">
    <div style="flex:1;min-width:260px;">
      <strong>Nüchterne Konfigurationsdokumentation der aktuellen Best-Practice-Vorlage</strong> —
      alle <code>BP_</code>-Policies mit Parametern, Quarantäne-Berechtigungen, ASF-Begründung und
      Dateityp-Liste. Wird live aus der Vorlage erzeugt und ist damit immer aktuell.
      Im Druckdialog „Als PDF speichern" wählen.
    </div>
    <button class="btn btn-primary" style="white-space:nowrap;" onclick={() => openConfigDoc($config)}>
      📘 Öffnen / als PDF speichern
    </button>
  </div>
  <p style="font-size:.85rem;color:#64748b;margin-top:.5rem;">
    💡 Die Doku eines <em>konkreten Tenants</em> (Ist-Zustand + gewollte Abweichungen mit Begründung)
    gibt es im Tab <strong>🏢 Tenants</strong>: Audit ausführen → „📘 Konfig-Doku".
  </p>
</section>

<section class="docs-section">
  <h2>Best Practice Documentation</h2>
  <div class="docs-content">{@html docs}</div>
</section>

<section class="recommendations-section">
  <h2>Best Practices &amp; Empfehlungen</h2>
  <div class="recommendations-content">{@html reco}</div>
</section>
