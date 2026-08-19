<script>
  import { NAV_GROUPS, isVisible } from './nav.js'
  import { activeTab, goToTab } from './tabStore.js'
  import { session } from './session.js'
  import { sidebarCollapsed, mobileNavOpen, toggleSidebar, closeMobileNav } from './sidebarStore.js'

  let groups = $derived(
    NAV_GROUPS
      .map(g => ({ ...g, items: g.items.filter(i => isVisible(i, $session)) }))
      .filter(g => g.items.length > 0)
  )
</script>

<aside class="sb" class:sb-collapsed={$sidebarCollapsed} class:sb-open={$mobileNavOpen}
       aria-label="Bereiche">
  <div class="sb-brand">
    <div class="sb-logo" aria-hidden="true">🛡️</div>
    <div class="sb-brand-text">
      <strong>Security Policy Manager</strong>
      <span>igeeks · Microsoft 365</span>
    </div>
    <button class="sb-drawer-close" onclick={closeMobileNav} aria-label="Menü schliessen">&times;</button>
  </div>

  <nav class="sb-nav">
    {#each groups as g (g.id)}
      <div class="sb-group">
        <div class="sb-group-label">{g.label}</div>
        {#each g.items as it (it.id)}
          <button class="sb-item" class:active={$activeTab === it.id}
                  onclick={() => goToTab(it.id)}
                  aria-current={$activeTab === it.id ? 'page' : undefined}
                  title={$sidebarCollapsed ? `${it.label} — ${it.desc}` : it.desc}>
            <span class="sb-icon" aria-hidden="true">{it.icon}</span>
            <span class="sb-label">{it.label}</span>
            {#if it.isNew}<span class="sb-new">Neu</span>{/if}
          </button>
        {/each}
      </div>
    {/each}
  </nav>

  <div class="sb-foot">
    <button class="sb-item sb-collapse" onclick={toggleSidebar}
            title={$sidebarCollapsed ? 'Seitenleiste ausklappen' : 'Seitenleiste einklappen'}>
      <span class="sb-icon" aria-hidden="true">{$sidebarCollapsed ? '»' : '«'}</span>
      <span class="sb-label">Einklappen</span>
    </button>
  </div>
</aside>
