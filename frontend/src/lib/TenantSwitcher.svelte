<script>
  import { session } from './session.js'
  import { tenants, activeTenant, activeTenantId, tenantsLoaded, loadTenants, selectTenant, tenantReady, tenantMissing } from './tenantStore.js'

  let { onManage } = $props() // () => void — springt in den "Tenants"-Tab

  let open = $state(false)
  let loaded = $state(false)

  $effect(() => {
    if ($session.ready && $session.online && $session.loggedIn && !loaded) {
      loaded = true
      loadTenants()
    }
    if (!($session.loggedIn && $session.online)) loaded = false
  })

  function initials(name) {
    return String(name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?'
  }
  function pick(id) { selectTenant(id); open = false }
  function manage() { open = false; onManage && onManage() }

  function onDocClick(e) {
    if (!open) return
    const el = document.getElementById('tswitchRoot')
    if (el && !el.contains(e.target)) open = false
  }
</script>

<svelte:window onclick={onDocClick} onkeydown={(e) => open && e.key === 'Escape' && (open = false)} />

{#if $session.online && $session.loggedIn}
  <div class="tswitch" id="tswitchRoot">
    <button class="tswitch-btn" onclick={(e) => { e.stopPropagation(); open = !open }} aria-haspopup="listbox" aria-expanded={open}>
      {#if $activeTenant}
        <span class="tswitch-avatar">{initials($activeTenant.name)}</span>
        <span class="tswitch-name">{$activeTenant.name}</span>
      {:else if $tenantsLoaded && $tenants.length === 0}
        <span class="tswitch-placeholder">Kein Tenant onboardet</span>
      {:else}
        <span class="tswitch-placeholder">Tenant wählen…</span>
      {/if}
      <span class="tswitch-car">▾</span>
    </button>

    {#if open}
      <div class="tswitch-panel" role="listbox">
        {#if $tenants.length === 0}
          <div class="tswitch-empty">Noch keine Tenants onboardet.</div>
        {:else}
          {#each $tenants as t (t.id)}
            {@const ready = tenantReady(t)}
            <div class="tswitch-item" class:active={$activeTenantId === t.id} role="option" aria-selected={$activeTenantId === t.id}
                 onclick={() => pick(t.id)} onkeydown={(e) => e.key === 'Enter' && pick(t.id)} tabindex="0">
              <div>
                <div class="tswitch-item-name">{t.name}</div>
                <div class="tswitch-item-org">{t.organization || t.tenantId}</div>
              </div>
              {#if ready}
                <span class="tbadge ok">✓ bereit</span>
              {:else}
                <span class="tbadge warn" title="{tenantMissing(t).join(', ')} fehlt">⚠ {tenantMissing(t).length}</span>
              {/if}
            </div>
          {/each}
        {/if}
        <div class="tswitch-foot">
          <button type="button" class="linklike" onclick={manage}>⚙ Tenants verwalten / onboarden</button>
        </div>
      </div>
    {/if}
  </div>
{/if}
