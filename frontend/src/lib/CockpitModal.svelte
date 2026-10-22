<script>
  import { onMount } from 'svelte'
  let { label, onclose, busy = false, error = '', children } = $props()
  let element
  onMount(() => { element.showModal() })
</script>
<dialog bind:this={element} class="cp-modal" aria-label={label} oncancel={e => { e.preventDefault(); if (!busy) onclose() }}>
  {#if error}<div class="cp-note cp-gaps" role="alert">{error}</div>{/if}
  {@render children()}
</dialog>
