<script>
  import { activeTab, goToTab } from '../lib/tabStore.js'
  import { activeTenant } from '../lib/tenantStore.js'
  import CockpitIdentity from '../lib/CockpitIdentity.svelte'
  import CockpitApps from '../lib/CockpitApps.svelte'
  import CockpitCompliance from '../lib/CockpitCompliance.svelte'
  import CockpitAlarms from '../lib/CockpitAlarms.svelte'
  import CockpitDmarc from '../lib/CockpitDmarc.svelte'
  import CockpitSignins from '../lib/CockpitSignins.svelte'
  import CockpitCosts from '../lib/CockpitCosts.svelte'
  import CockpitRollout from '../lib/CockpitRollout.svelte'
  import CockpitCredentials from '../lib/CockpitCredentials.svelte'
  import CockpitGeo from '../lib/CockpitGeo.svelte'
  import CockpitJobs from '../lib/CockpitJobs.svelte'
  import CockpitAccess from '../lib/CockpitAccess.svelte'
  import { session } from '../lib/session.js'
  import CockpitDashboard from '../lib/CockpitDashboard.svelte'
</script>

<div class="cp">
  {#if $activeTab === 'cockpit'}
    {#if $session.loggedIn}{#key $session.access?.principal}<CockpitDashboard/>{/key}{/if}
  {:else if $activeTab === 'cockpit-jobs'}<CockpitJobs/>
  {:else if $activeTab === 'cockpit-access'}<CockpitAccess/>
  {:else if $activeTab === 'cockpit-costs'}<CockpitCosts/>
  {:else if $activeTab === 'cockpit-rollout'}<CockpitRollout/>
  {:else if $activeTab === 'cockpit-geo'}<CockpitGeo/>
  {:else if !$activeTenant}<div class="cp-empty">Bitte zuerst einen Mandanten auswählen.<button class="btn btn-primary" onclick={() => goToTab('tenants')}>Mandanten verwalten</button></div>
  {:else}
    {#key $activeTenant.id + $activeTab}
      {#if $activeTab === 'cockpit-users'}<CockpitIdentity tenant={$activeTenant}/>
      {:else if $activeTab === 'cockpit-apps'}<CockpitApps tenant={$activeTenant}/>
      {:else if $activeTab === 'cockpit-credentials'}<CockpitCredentials tenant={$activeTenant}/>
      {:else if $activeTab === 'cockpit-compliance'}<CockpitCompliance tenant={$activeTenant}/>
      {:else if $activeTab === 'cockpit-alarms'}<CockpitAlarms tenant={$activeTenant}/>
      {:else if $activeTab === 'cockpit-dmarc'}<CockpitDmarc tenant={$activeTenant}/>
      {:else if $activeTab === 'cockpit-signins'}<CockpitSignins tenant={$activeTenant}/>{/if}
    {/key}
  {/if}
</div>
