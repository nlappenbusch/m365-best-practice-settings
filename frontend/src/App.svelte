<script>
  import { onMount } from 'svelte'
  import { refreshSession } from './lib/session.js'
  import SessionWidget from './lib/SessionWidget.svelte'

  // Tab-State ist jetzt ein einziger reaktiver Wert — kein class-Toggling ueber
  // DOM-Knoten mehr. Neue Tabs = ein Eintrag hier + ein {#if}-Block unten.
  const tabs = [
    { id: 'config',     label: '⚙️ Konfiguration' },
    { id: 'livedeploy', label: '🚀 Live-Deploy' },
    { id: 'downloads',  label: '📦 Agent-Downloads' },
    { id: 'wissen',     label: '📖 Wissen' }
  ]
  let active = $state('config')

  onMount(refreshSession)
</script>

<div class="app-container">
  <header class="app-header">
    <div class="header-content">
      <div class="logo-section">
        <div>
          <h1 style="margin:0;font-size:1.5rem">M365 Security Policy Manager</h1>
          <p class="subtitle" style="margin:.25rem 0 0 0;font-size:.875rem;opacity:.8">
            Best Practice Configuration Tool
          </p>
        </div>
      </div>
      <div class="header-actions" style="display:flex;gap:.75rem;align-items:center">
        <!-- Import/Export kommen mit dem Konfigurations-Tab zurueck (kontextsensitiv). -->
        <SessionWidget />
      </div>
    </div>
  </header>

  <main class="main-content">
    <nav class="tabs">
      {#each tabs as t}
        <button class="tab-btn" class:active={active === t.id} onclick={() => (active = t.id)}>
          {t.label}
        </button>
      {/each}
    </nav>

    <div class="tab-content active">
      {#if active === 'config'}
        <section class="settings-section">
          <h2>Konfiguration</h2>
          <p class="subtitle">Wird migriert …</p>
        </section>
      {:else if active === 'livedeploy'}
        <section class="settings-section">
          <h2>🚀 Live-Deploy</h2>
          <p class="subtitle">Wird migriert …</p>
        </section>
      {:else if active === 'downloads'}
        <section class="settings-section">
          <h2>📦 Agent-Downloads</h2>
          <p class="subtitle">Wird migriert …</p>
        </section>
      {:else if active === 'wissen'}
        <section class="settings-section">
          <h2>📖 Wissen</h2>
          <p class="subtitle">Wird migriert …</p>
        </section>
      {/if}
    </div>
  </main>
</div>
