<script>
  import { onMount } from 'svelte'
  import { session, refreshSession } from './lib/session.js'
  import { theme, cycleTheme } from './lib/theme.js'
  import { activeTab } from './lib/tabStore.js'
  import { navItem } from './lib/nav.js'
  import { mobileNavOpen, toggleMobileNav, closeMobileNav } from './lib/sidebarStore.js'
  import Sidebar from './lib/Sidebar.svelte'
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
  import Diagnose from './tabs/Diagnose.svelte'
  import Migration from './tabs/Migration.svelte'

  // Tickets nur fuer den freigeschalteten Nutzer -- die Durchsetzung passiert
  // serverseitig (403 auf /api/sdp, /api/runbooks), das hier ist nur die Sicht.
  $effect(() => {
    if ($activeTab === 'tickets' && $session.ready && !$session.ticketsAllowed) {
      activeTab.set('tenants')
    }
  })

  let current = $derived(navItem($activeTab))

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

<svelte:window onkeydown={(e) => e.key === 'Escape' && closeMobileNav()} />

<div class="app-shell">
  <Sidebar />

  <!-- Abdunkelung hinter der Off-Canvas-Schublade (nur auf schmalen Schirmen sichtbar) -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="sb-backdrop" class:show={$mobileNavOpen} onclick={closeMobileNav}></div>

  <div class="workspace">
    <header class="topbar">
      <button class="topbar-burger" onclick={toggleMobileNav} aria-label="Menü öffnen">☰</button>

      <div class="topbar-title">
        <h1>{current ? `${current.icon} ${current.label}` : 'M365 Security Policy Manager'}</h1>
        {#if current}<p>{current.desc}</p>{/if}
      </div>

      <div class="topbar-actions">
        {#if $activeTab === 'config'}
          <div class="topbar-context">
            <button class="btn btn-secondary" onclick={doImport}>Import</button>
            <button class="btn btn-secondary" onclick={exportJson}>Export JSON</button>
            <button class="btn btn-secondary" onclick={exportDocs}>Export Doku</button>
            <button class="btn btn-primary" onclick={() => (exportOpen = true)}>Export PowerShell</button>
          </div>
        {/if}
        <button class="btn btn-secondary theme-toggle" onclick={cycleTheme}
                title="Darstellung: {THEME_META[$theme].label} (klicken zum Wechseln)"
                aria-label="Darstellung wechseln">
          <span aria-hidden="true">{THEME_META[$theme].icon}</span>
          <span class="theme-toggle-label">{THEME_META[$theme].label}</span>
        </button>
        <TenantSwitcher onManage={() => ($activeTab = 'tenants')} />
        <SessionWidget />
      </div>
    </header>

    <!-- Alle Bereiche bleiben gemountet (nur via CSS versteckt), damit laufende
         Device-Code-/Job-Polls beim Wechsel nicht abbrechen. -->
    <main class="content">
      <div class="content-card">
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
        {#if $session.ticketsAllowed}
          <div class:tab-hidden={$activeTab !== 'tickets'}><Tickets /></div>
        {/if}
        <div class:tab-hidden={$activeTab !== 'migration'}><Migration /></div>
        <div class:tab-hidden={$activeTab !== 'diagnose'}><Diagnose /></div>
        <div class:tab-hidden={$activeTab !== 'wissen'}><Wissen /></div>
      </div>
    </main>
  </div>
</div>

<ExportModal open={exportOpen} onclose={() => (exportOpen = false)} />

<!-- Vollbild-Login-Gate (SSO primaer, Passwort-Fallback) — liegt ueber allem,
     solange die Session nicht angemeldet ist. Die Bereiche bleiben darunter
     gemountet, damit nichts an laufendem Zustand verloren geht. -->
<LoginScreen />

{#if toast}
  <div class="app-toast {toast.ok ? 'ok' : 'err'}">{toast.ok ? '✅ ' : '❌ '}{toast.msg}</div>
{/if}
