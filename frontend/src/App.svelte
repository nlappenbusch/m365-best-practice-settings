<script>
  import { onMount } from 'svelte'
  import { refreshSession } from './lib/session.js'
  import { theme, cycleTheme } from './lib/theme.js'
  import { activeTab } from './lib/tabStore.js'
  import TenantSwitcher from './lib/TenantSwitcher.svelte'
  import SessionWidget from './lib/SessionWidget.svelte'
  import LoginScreen from './lib/LoginScreen.svelte'
  import ExportModal from './lib/ExportModal.svelte'
  import { exportJson, exportDocs, importConfig } from './lib/actions.js'
  import Config from './tabs/Config.svelte'
  import TenantsOverview from './tabs/TenantsOverview.svelte'
  import MailSecurity from './tabs/MailSecurity.svelte'
  import Audit from './tabs/Audit.svelte'
  import Intune from './tabs/Intune.svelte'
  import Autopilot from './tabs/Autopilot.svelte'
  import ConditionalAccess from './tabs/ConditionalAccess.svelte'
  import Lizenzen from './tabs/Lizenzen.svelte'
  import Mappings from './tabs/Mappings.svelte'
  import Wissen from './tabs/Wissen.svelte'
  import Downloads from './tabs/Downloads.svelte'
  import Tickets from './tabs/Tickets.svelte'

  // Gruppiert nach Themenbereich (nur visuell — Klickverhalten bleibt ein
  // flacher Tab-Wechsel wie zuvor, keine zweite Navigationsebene). Ein
  // Gruppenwechsel bekommt einen dezenten Trenner in der Leiste.
  const tabs = [
    { id: 'config',      label: '⚙️ Vorlage',    group: 'Einrichtung' },
    { id: 'tenants',     label: '🏢 Tenants',    group: 'Einrichtung' },
    { id: 'mailsec',     label: '🛡 Mail-Security', group: 'Mail-Security' },
    { id: 'audit',       label: '🔎 Audit',      group: 'Mail-Security' },
    { id: 'intune',      label: '💻 Intune',     group: 'Geräte' },
    { id: 'autopilot',   label: '🚀 Autopilot',  group: 'Geräte' },
    { id: 'mappings',    label: '🗺️ Mappings', group: 'Geräte', isNew: true },
    { id: 'downloads',   label: '📦 Agents',     group: 'Geräte' },
    { id: 'ca',          label: '🔐 Conditional Access', group: 'Identität' },
    { id: 'lizenzen',    label: '💰 Lizenzen',   group: 'Lizenzen' },
    { id: 'tickets',     label: '🎫 Tickets',    group: 'Ticketing', isNew: true },
    { id: 'wissen',      label: '📖 Wissen',     group: 'Referenz' }
  ]
  const THEME_META = {
    auto:  { icon: '🌓', label: 'Auto' },
    light: { icon: '☀️', label: 'Hell' },
    dark:  { icon: '🌙', label: 'Dunkel' }
  }

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
        <div class="logo-mark" aria-hidden="true">🛡️</div>
        <h1 title="Best Practice Configuration &amp; Autopilot Staging">M365 Security Policy Manager</h1>
      </div>
      <div class="header-actions">
        {#if $activeTab === 'config'}
          <div style="display:flex;gap:.5rem">
            <button class="btn btn-secondary" onclick={doImport}>Import</button>
            <button class="btn btn-secondary" onclick={exportJson}>Export JSON</button>
            <button class="btn btn-secondary" onclick={exportDocs}>Export Doku</button>
            <button class="btn btn-primary" onclick={() => (exportOpen = true)}>Export PowerShell</button>
          </div>
        {/if}
        <button class="btn btn-secondary theme-toggle" onclick={cycleTheme}
                title="Darstellung: {THEME_META[$theme].label} (klicken zum Wechseln)">
          {THEME_META[$theme].icon} {THEME_META[$theme].label}
        </button>
        <TenantSwitcher onManage={() => ($activeTab = 'tenants')} />
        <SessionWidget />
      </div>
    </div>
  </header>

  <main class="main-content">
    <nav class="tabs">
      {#each tabs as t, i}
        {#if i > 0 && tabs[i - 1].group !== t.group}<span class="tab-group-sep" aria-hidden="true"></span>{/if}
        <button class="tab-btn" class:active={$activeTab === t.id} onclick={() => ($activeTab = t.id)}>
          {t.label}
          {#if t.isNew}<span class="tab-pill-new">Neu</span>{/if}
        </button>
      {/each}
    </nav>

    <!-- Alle Tabs bleiben gemountet (nur via CSS versteckt), damit laufende
         Device-Code-/Job-Polls beim Tab-Wechsel nicht abbrechen. -->
    <div class="tab-content">
      <div class:tab-hidden={$activeTab !== 'config'}><Config /></div>
      <div class:tab-hidden={$activeTab !== 'tenants'}><TenantsOverview /></div>
      <div class:tab-hidden={$activeTab !== 'mailsec'}><MailSecurity /></div>
      <div class:tab-hidden={$activeTab !== 'audit'}><Audit /></div>
      <div class:tab-hidden={$activeTab !== 'intune'}><Intune /></div>
      <div class:tab-hidden={$activeTab !== 'autopilot'}><Autopilot /></div>
      <div class:tab-hidden={$activeTab !== 'ca'}><ConditionalAccess /></div>
      <div class:tab-hidden={$activeTab !== 'lizenzen'}><Lizenzen /></div>
      <div class:tab-hidden={$activeTab !== 'mappings'}><Mappings /></div>
      <div class:tab-hidden={$activeTab !== 'downloads'}><Downloads /></div>
      <div class:tab-hidden={$activeTab !== 'tickets'}><Tickets /></div>
      <div class:tab-hidden={$activeTab !== 'wissen'}><Wissen /></div>
    </div>
  </main>
</div>

<ExportModal open={exportOpen} onclose={() => (exportOpen = false)} />

<!-- Vollbild-Login-Gate (SSO primaer, Passwort-Fallback) — liegt ueber allem,
     solange die Session nicht angemeldet ist. Die Tabs bleiben darunter
     gemountet, damit nichts an laufendem Zustand verloren geht. -->
<LoginScreen />

{#if toast}
  <div class="app-toast {toast.ok ? 'ok' : 'err'}">{toast.ok ? '✅ ' : '❌ '}{toast.msg}</div>
{/if}
