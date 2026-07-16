<script>
  import { onMount } from 'svelte'
  import { refreshSession } from './lib/session.js'
  import SessionWidget from './lib/SessionWidget.svelte'
  import ExportModal from './lib/ExportModal.svelte'
  import { exportJson, exportDocs, importConfig } from './lib/actions.js'
  import Config from './tabs/Config.svelte'
  import LiveDeploy from './tabs/LiveDeploy.svelte'
  import Wissen from './tabs/Wissen.svelte'
  import Downloads from './tabs/Downloads.svelte'

  const tabs = [
    { id: 'config',     label: '⚙️ Konfiguration' },
    { id: 'livedeploy', label: '🚀 Live-Deploy' },
    { id: 'downloads',  label: '📦 Agent-Downloads' },
    { id: 'wissen',     label: '📖 Wissen' }
  ]
  let active = $state('config')
  let exportOpen = $state(false)
  let toast = $state(null)   // { ok, msg }

  function doImport() {
    importConfig((ok, msg) => {
      toast = { ok, msg }
      setTimeout(() => (toast = null), 3500)
    })
  }

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
        {#if active === 'config'}
          <div style="display:flex;gap:.5rem">
            <button class="btn btn-secondary" onclick={doImport}>Import</button>
            <button class="btn btn-secondary" onclick={exportJson}>Export JSON</button>
            <button class="btn btn-secondary" onclick={exportDocs}>Export Doku</button>
            <button class="btn btn-primary" onclick={() => (exportOpen = true)}>Export PowerShell</button>
          </div>
        {/if}
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
        <Config />
      {:else if active === 'livedeploy'}
        <LiveDeploy />
      {:else if active === 'downloads'}
        <Downloads />
      {:else if active === 'wissen'}
        <Wissen />
      {/if}
    </div>
  </main>
</div>

<ExportModal open={exportOpen} onclose={() => (exportOpen = false)} />

{#if toast}
  <div class="app-toast {toast.ok ? 'ok' : 'err'}">{toast.ok ? '✅ ' : '❌ '}{toast.msg}</div>
{/if}
