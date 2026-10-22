<script>
  import { activeTab, goToTab } from '../lib/tabStore.js'
  import { activeTenant, tenants, tenantReady, selectTenant } from '../lib/tenantStore.js'
  import { session } from '../lib/session.js'
  import { msApi, followJob, pctOf } from '../lib/managed.js'
  import { ageLabel } from '../lib/product.js'
  import Icon from '../lib/Icon.svelte'
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
  import { canOperate } from '../lib/cockpit.js'
  let q = $state(''), connected = $state(false), list = $state(false), attention = $state(false)
  let rows = $state([]), error = $state(''), loading = $state(false), busy = $state({}), loaded = $state(false)
  let shown = $derived($tenants.filter(t => !q || `${t.name} ${t.organization}`.toLowerCase().includes(q.toLowerCase())).filter(t => !connected || tenantReady(t)).filter(t => !attention || Object.values(rows.find(r => r.id === t.id)?.counts || {}).some(n => n > 0)))
  async function load() {
    loading = true; error = ''
    try { rows = (await msApi.fleet()).tenants || []; loaded = true } catch (e) { error = e.message }
    loading = false
  }
  $effect(() => { if ($session.loggedIn && !loaded) load() })
  function open(t) { selectTenant(t.id); goToTab($session.access?.admin?'overview':'cockpit-users') }
  async function sync(t) {
    busy = { ...busy, [t.id]: 'Läuft…' }; error = ''
    try {
      const j = await msApi.run(t.id)
      const result = await followJob(j.jobId)
      if (!result || result.status !== 'done') throw new Error(result?.error || 'Erhebung fehlgeschlagen')
      await load()
    } catch (e) { error = e.message }
    busy = { ...busy, [t.id]: null }
  }
</script>

<div class="cp">
  {#if $activeTab === 'cockpit'}
    <div class="cp-head"><div><h2>Dashboard</h2><p>{$tenants.filter(tenantReady).length} von {$tenants.length} Mandanten verbunden</p></div><div class="cp-actions"><button class="btn btn-secondary" onclick={load} disabled={loading}><Icon name="refresh" size={16}/>{loading ? 'Lade…' : 'Aktualisieren'}</button>{#if $session.access?.admin}<button class="btn btn-primary" onclick={() => goToTab('tenants')}><Icon name="plus" size={17}/>Mandant hinzufügen</button>{/if}</div></div>
    <div class="cp-tabs"><button class:active={!attention} onclick={() => attention = false}>Alle Mandanten</button><button class:active={attention} onclick={() => attention = true}>Mit Handlungsbedarf</button>{#if $session.access?.admin}<button onclick={() => goToTab('mspfleet')}>Service-Cockpit</button>{/if}</div>
    <div class="cp-panel cp-toolbar"><input type="search" placeholder="Mandanten durchsuchen…" aria-label="Mandanten durchsuchen" bind:value={q}/><label><input type="checkbox" bind:checked={connected}/>Nur verbundene</label><button class="btn btn-secondary" onclick={() => list = !list}><Icon name="building" size={16}/>{list ? 'Kacheln' : 'Listenansicht'}</button>{#if $session.access?.admin}<button class="btn btn-secondary" onclick={() => goToTab('reports')}><Icon name="chart" size={16}/>Berichte</button>{/if}</div>
    {#if error}<div class="cp-note cp-gaps" role="alert">{error}</div>{/if}
    <div class="cp-grid" class:cp-list={list}>
      {#each shown as t (t.id)}
        {@const r = rows.find(r => r.id === t.id)}
        {@const score = pctOf(r?.score)}
        {@const count = r ? Object.values(r.counts).reduce((a, b) => a + b, 0) : null}
        <article class="cp-tenant"><div class="cp-tenant-head"><span class="cp-tile-icon"><Icon name="building" size={24}/></span><div><h3>{t.name}</h3><span class="cp-sub">{t.organization || 'Kein Organisationsname'}</span></div><span class="cp-badge" class:ok={tenantReady(t)}>{tenantReady(t) ? 'Verbunden' : 'Einrichtung offen'}</span></div>
          <div class="cp-kpis"><div class="cp-kpi"><Icon name="shieldCheck" size={19}/><strong class:cp-crit={score !== null && score < 45}>{score === null ? '—' : score + '%'}</strong><span>Secure Score</span></div><div class="cp-kpi"><Icon name="alert" size={19}/><strong class:cp-crit={count > 0}>{r?.lastRun ? count : '—'}</strong><span>Offene Befunde</span></div><div class="cp-kpi"><Icon name="check" size={19}/><strong>{r?.compliance ?? '—'}</strong><span>Geräte konform</span></div><div class="cp-kpi"><Icon name="refresh" size={19}/><strong>{r?.slaBreached ?? '—'}</strong><span>SLA überschritten</span></div></div>
          <div><span class="cp-badge" class:ok={r?.lastRun && !r?.areasFailed?.length}>{r?.lastRun ? r.areasFailed.length ? 'Teilweise erhoben' : 'Erhoben' : 'Noch nicht erhoben'}</span><span class="cp-sub"> · {ageLabel(r?.lastRun)}</span><div class="cp-actions"><button class="btn btn-secondary" onclick={() => sync(t)} disabled={!!busy[t.id] || !tenantReady(t) || !canOperate(t)}><Icon name="refresh" size={15}/>{busy[t.id] || 'Synchronisieren'}</button><button class="btn btn-primary" onclick={() => open(t)}>Details anzeigen<Icon name="chevronRight" size={16}/></button></div></div>
        </article>
      {:else}<div class="cp-empty">{loading ? 'Mandanten werden geladen…' : 'Keine Mandanten in dieser Ansicht.'}</div>{/each}
    </div>
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
