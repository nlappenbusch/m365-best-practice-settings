<script>
  import { config } from '../lib/config.js'
  import { docsHtml, recoHtml } from '../lib/wissenTemplates.js'

  // docs ist statisch; reco haengt nur an der Admin-Mail aus dem Config-Store.
  const docs = docsHtml()
  let reco = $derived(recoHtml($config.global.adminEmail))
</script>

<section class="docs-section">
  <h2>Best Practice Documentation</h2>
  <div class="docs-content">{@html docs}</div>
</section>

<section class="recommendations-section">
  <h2>Best Practices &amp; Empfehlungen</h2>
  <div class="recommendations-content">{@html reco}</div>
</section>
