<script>
  import { session } from './session.js'
  import { activeTenant, tenantReady, tenantMissing } from './tenantStore.js'

  let { children } = $props()
</script>

{#if !$session.online}
  <div class="alert alert-warning"><strong>Backend nicht erreichbar.</strong> Läuft nur im Docker-Stack (<code>docker compose up -d</code>).</div>
{:else if !$session.loggedIn}
  <div class="alert alert-warning"><strong>Nicht angemeldet.</strong> Oben rechts im Header auf <strong>Anmelden</strong> klicken.</div>
{:else if !$activeTenant}
  <div class="tctx-empty">
    <p>Kein Tenant ausgewählt.</p>
    <p>Oben im Header einen Tenant wählen — oder im Tab <strong>Tenants</strong> einen onboarden.</p>
  </div>
{:else}
  <div class="tctx">
    <span>Aktiver Tenant: <b>{$activeTenant.name}</b> · {$activeTenant.organization || $activeTenant.tenantId}</span>
    {#if tenantReady($activeTenant)}
      <span class="tbadge ok">✓ bereit</span>
    {:else}
      <span class="tbadge warn" title="Im Tab „Tenants“ reparieren">⚠ {tenantMissing($activeTenant).join(', ')} fehlt</span>
    {/if}
  </div>
  {@render children()}
{/if}
