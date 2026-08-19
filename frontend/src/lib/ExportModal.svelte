<script>
  import { buildPowerShell, downloadPs } from './actions.js'

  let { open = false, onclose } = $props()

  let incDeployment = $state(true)
  let incVerification = $state(true)
  let incDocumentation = $state(true)
  let copied = $state(false)

  // Preview reaktiv aus den gewaehlten Teilen.
  let preview = $derived(open ? buildPowerShell({
    deployment: incDeployment, verification: incVerification, documentation: incDocumentation
  }) : '')

  function copy() {
    navigator.clipboard.writeText(preview).then(() => {
      copied = true
      setTimeout(() => (copied = false), 2000)
    })
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="modal" style="display:flex" onclick={(e) => e.target === e.currentTarget && onclose?.()}>
    <div class="modal-content" role="dialog" aria-modal="true" aria-label="PowerShell Export">
      <div class="modal-header">
        <h2>PowerShell Export</h2>
        <button class="close-btn" onclick={() => onclose?.()}>&times;</button>
      </div>
      <div class="modal-body">
        <div class="export-options">
          <label class="checkbox-label"><input type="checkbox" bind:checked={incDocumentation}><span>Dokumentations-Header</span></label>
          <label class="checkbox-label"><input type="checkbox" bind:checked={incDeployment}><span>Deployment-Skript</span></label>
          <label class="checkbox-label"><input type="checkbox" bind:checked={incVerification}><span>Verification-Skript</span></label>
        </div>
        <pre class="export-preview"><code>{preview}</code></pre>
        <div style="display:flex;gap:.75rem;justify-content:flex-end;margin-top:1rem;">
          <button class="btn btn-primary" onclick={copy}>{copied ? '✓ Kopiert!' : 'Copy to Clipboard'}</button>
          <button class="btn btn-secondary" onclick={() => downloadPs(preview)}>Download .ps1</button>
        </div>
      </div>
    </div>
  </div>
{/if}
