<script>
  import { onMount } from 'svelte'
  import { tenants, tenantReady, selectTenant } from './tenantStore.js'
  import { session } from './session.js'
  import { goToTab } from './tabStore.js'
  import { msApi, followJob, pctOf } from './managed.js'
  import { ageLabel, fmtDateTime } from './product.js'
  import { canOperate } from './cockpit.js'
  import Icon from './Icon.svelte'
  import Modal from './CockpitModal.svelte'

  let rows = $state([]), loading = $state(false), error = $state(''), busy = $state({})
  let q = $state(''), connected = $state(false), list = $state(false), attention = $state(false)
  let views = $state([]), selected = $state('all'), editor = $state(null), settings = $state(false)
  let metrics = $state(['users','findings','devices','score']), colors = $state(true), ready = $state(false)
  const definitions = {
    users: { label:'Lizenzierte Benutzer', icon:'users', tone:'blue' },
    findings: { label:'Offene Befunde', icon:'bell', tone:'muted' },
    devices: { label:'Verwaltete Geräte', icon:'monitor', tone:'orange' },
    score: { label:'Secure Score', icon:'shieldCheck', tone:'yellow' },
    sla: { label:'SLA überschritten', icon:'clock', tone:'muted' }
  }
  const storageKey = () => 'm365-dashboard-v2:' + ($session.access?.principal || 'local')
  let activeView = $derived(views.find(v => v.id === selected))
  let shown = $derived($tenants.filter(t => !activeView || activeView.tenants.includes(t.id))
    .filter(t => !q || `${t.name} ${t.organization || ''}`.toLowerCase().includes(q.toLowerCase()))
    .filter(t => !connected || tenantReady(t))
    .filter(t => !attention || Object.values(rows.find(r => r.id === t.id)?.counts || {}).some(n => n > 0)))
  let connectedCount = $derived($tenants.filter(tenantReady).length)
  $effect(() => { if(ready) try { localStorage.setItem(storageKey(),JSON.stringify({views,selected,connected,list,attention,metrics,colors})) } catch {} })
  onMount(() => {
    try {
      const p = JSON.parse(localStorage.getItem(storageKey()) || '{}')
      views = Array.isArray(p.views) ? p.views.filter(v => typeof v.id==='string' && typeof v.name==='string' && Array.isArray(v.tenants)).slice(0,30) : []
      selected = views.some(v => v.id===p.selected) ? p.selected : 'all'
      connected = !!p.connected; list = !!p.list; attention = !!p.attention; colors = p.colors !== false
      if(Array.isArray(p.metrics) && p.metrics.some(k=>Object.hasOwn(definitions,k))) metrics = [...new Set(p.metrics.filter(k => Object.hasOwn(definitions,k)))]
    } catch {}
    ready = true; load()
  })
  async function load() {
    if(loading) return
    loading = true; error = ''
    try { rows = (await msApi.fleet()).tenants || [] } catch(e) { error = e.message }
    finally { loading = false }
  }
  const count = r => r?.lastRun ? Object.values(r.counts || {}).reduce((a,b) => a+b,0) : null
  function value(r,key) { return key==='users' ? r?.licensedUsers : key==='devices' ? r?.managedDevices : key==='score' ? pctOf(r?.score) : key==='findings' ? count(r) : r?.lastRun ? r?.slaBreached : null }
  function tone(r,key) {
    if(!colors) return 'neutral'
    const v = value(r,key)
    if(v==null) return 'muted'
    if(key==='score') return v<40 ? 'red' : v<70 ? 'yellow' : 'green'
    if(key==='findings'||key==='sla') return v>0 ? 'red' : 'muted'
    return definitions[key].tone
  }
  function detail(t) { selectTenant(t.id); goToTab($session.access?.admin?'overview':'cockpit-users') }
  async function sync(t) {
    busy = {...busy,[t.id]:'Wartet…'}; error = ''
    try {
      const j = await msApi.run(t.id)
      const result = await followJob(j.jobId,job => busy={...busy,[t.id]:job.queueState==='queued'?'Wartet…':'Synchronisiert…'})
      if(!result || result.status!=='done') throw new Error(result?.error || 'Synchronisierung fehlgeschlagen')
      await load()
      if(result.queueState==='partial') error = `${t.name}: ${result.error || result.hint || 'Nicht alle Quellen konnten erhoben werden.'}`
    } catch(e) { error = e.message } finally { busy = {...busy,[t.id]:null} }
  }
  function editView(v) { editor = v ? {...v,tenants:v.tenants.filter(id=>$tenants.some(t=>t.id===id))} : {id:crypto.randomUUID(),name:'',tenants:[]} }
  function toggleTenant(id) { editor.tenants = editor.tenants.includes(id) ? editor.tenants.filter(x=>x!==id) : [...editor.tenants,id] }
  function saveView() {
    if(!editor.name.trim() || !editor.tenants.length) return
    views = [...views.filter(v=>v.id!==editor.id),{...editor,name:editor.name.trim().slice(0,60)}]
    selected=editor.id;editor=null
  }
  function removeView() { views=views.filter(v=>v.id!==editor.id);selected='all';editor=null }
  function toggleMetric(key) { metrics=metrics.includes(key)?metrics.filter(k=>k!==key):Object.keys(definitions).filter(k=>k===key||metrics.includes(k)) }
</script>

<div class="focus-dashboard">
  <div class="cp-head fd-heading"><div><h2>Dashboard</h2><p>{connectedCount} von {$tenants.length} Kunden verbunden</p></div><div class="cp-actions"><button class="btn btn-secondary fd-refresh" onclick={load} disabled={loading} aria-label="Dashboard aktualisieren"><Icon name="refresh" size={17}/></button>{#if $session.access?.admin}<button class="btn btn-primary" onclick={()=>goToTab('tenants')}><Icon name="plus" size={18}/>Kunde hinzufügen</button>{/if}</div></div>

  <div class="fd-views" aria-label="Tenant-Ansichten">
    <button class="btn btn-secondary" class:fd-selected={selected==='all'} aria-pressed={selected==='all'} onclick={()=>selected='all'}><Icon name="eye" size={17}/>Alle Tenants</button>
    {#each views as v}<div class="fd-view"><button class="btn btn-secondary" class:fd-selected={selected===v.id} aria-pressed={selected===v.id} onclick={()=>selected=v.id}>{v.name}<span class="fd-view-count">{v.tenants.filter(id=>$tenants.some(t=>t.id===id)).length}</span></button><button class="fd-edit" aria-label={`${v.name} bearbeiten`} onclick={()=>editView(v)}><Icon name="pencil" size={17}/></button></div>{/each}
    <button class="btn btn-secondary" onclick={()=>editView(null)} disabled={views.length>=30}><Icon name="plus" size={17}/>Neue Ansicht</button>
  </div>

  <div class="cp-panel fd-toolbar">
    <div class="fd-search"><Icon name="search" size={19}/><input type="search" placeholder="Tenants durchsuchen…" aria-label="Tenants durchsuchen" bind:value={q}/></div>
    <button class="fd-switch" role="switch" aria-checked={connected} onclick={()=>connected=!connected}><span class:enabled={connected}></span>Nur verbundene</button>
    <button class="btn btn-secondary" onclick={()=>settings=true}><Icon name="shieldCheck" size={18}/>Score-Anzeige & Ampel</button>
    <div class="fd-layout" aria-label="Darstellung"><button class:active={!list} aria-label="Kachelansicht" aria-pressed={!list} onclick={()=>list=false}><Icon name="grid" size={19}/></button><button class:active={list} aria-label="Listenansicht" aria-pressed={list} onclick={()=>list=true}><Icon name="list" size={19}/></button></div>
  </div>
  <div class="fd-results"><span>{shown.length} {shown.length===1?'Tenant':'Tenants'}{activeView ? ` in „${activeView.name}“` : ''}</span><label><input type="checkbox" bind:checked={attention}/>Nur mit offenen Befunden</label></div>
  {#if error}<div class="cp-note cp-gaps" role="alert">{error}</div>{/if}
  <div class="fd-grid" class:fd-list={list} aria-busy={loading}>
    {#each shown as t (t.id)}
      {@const r=rows.find(r=>r.id===t.id)}
      <article class="fd-card">
        <div class="fd-card-head"><span class="fd-building"><Icon name="building" size={25}/></span><div class="fd-identity"><h3>{t.name}</h3><span title={t.organization}>{t.customerNumber || t.organization || 'Organisation noch nicht hinterlegt'}</span></div><span class="fd-connection" class:connected={tenantReady(t)}>{tenantReady(t)?'Verbunden':'Einrichtung offen'}</span></div>
        <div class="fd-metrics" style={`--columns:${Math.max(1,metrics.length)}`}>
          {#each metrics as key}{@const v=value(r,key)}<div class="fd-metric {tone(r,key)}" title={key==='score'?'Secure Score: unter 40% rot, unter 70% gelb, ab 70% grün.':key==='findings'?'Offene Monitoring-Befunde; keine gesonderte Alarmanzahl.':r?.metricAt?.[key==='users'?'licenses':key] ? `Letzter Erfolg: ${fmtDateTime(r.metricAt[key==='users'?'licenses':key])}` : 'Letzter gespeicherter Messwert'}><Icon name={definitions[key].icon} size={23}/><strong>{v ?? '—'}{key==='score'&&v!=null?'%':''}</strong><span>{definitions[key].label}</span>{#if key==='users'&&r?.totalUsers!=null}<small>{r.totalUsers} gesamt</small>{/if}</div>{/each}
        </div>
        <div class="fd-card-bottom"><div class="fd-status"><span class="fd-state" class:complete={!!r?.lastRun&&!r?.areasFailed?.length} class:partial={!!r?.areasFailed?.length}>{busy[t.id]?'Synchronisiert…':r?.lastRun?r.areasFailed?.length?'Teilweise':'Abgeschlossen':'Noch nicht erhoben'}</span><span title={fmtDateTime(r?.lastRun)}>{ageLabel(r?.lastRun)}</span>{#if t.readOnly}<span class="cp-badge">Prüfmandat</span>{/if}</div>
        <div class="fd-actions"><button class="btn btn-secondary" onclick={()=>sync(t)} disabled={!!busy[t.id]||!tenantReady(t)||!canOperate(t)}><Icon name="refresh" size={18}/>{busy[t.id]||'Synchronisieren'}</button><button class="btn btn-primary" onclick={()=>detail(t)}>Details anzeigen<Icon name="chevronRight" size={18}/></button></div></div>
      </article>
    {:else}<div class="cp-empty">{loading?'Tenants werden geladen…':'Keine Tenants in dieser Ansicht.'}{#if q||connected||attention}<button class="btn btn-secondary" onclick={()=>{q='';connected=false;attention=false}}>Filter zurücksetzen</button>{/if}</div>{/each}
  </div>
</div>

{#if editor}<Modal label="Tenant-Ansicht bearbeiten" onclose={()=>editor=null}><h3>{views.some(v=>v.id===editor.id)?'Ansicht bearbeiten':'Neue Ansicht'}</h3><p>Deine Ansichten und Anzeigeoptionen werden in diesem Browser gespeichert.</p><label>Name<input maxlength="60" bind:value={editor.name} placeholder="z. B. Betreuungsteam Zürich"/></label><div class="fd-tenant-options">{#each $tenants as t}<label><input type="checkbox" checked={editor.tenants.includes(t.id)} onchange={()=>toggleTenant(t.id)}/>{t.name}</label>{/each}</div><div class="cp-actions">{#if views.some(v=>v.id===editor.id)}<button class="btn btn-secondary" onclick={removeView}>Ansicht löschen</button>{/if}<button class="btn btn-secondary" onclick={()=>editor=null}>Abbrechen</button><button class="btn btn-primary" disabled={!editor.name.trim()||!editor.tenants.length} onclick={saveView}>Ansicht speichern</button></div></Modal>{/if}
{#if settings}<Modal label="Score-Anzeige und Ampel" onclose={()=>settings=false}><h3>Score-Anzeige & Ampel</h3><p>Wähle die Kennzahlen für deine Tenant-Kacheln.</p><div class="fd-tenant-options">{#each Object.entries(definitions) as [key,d]}<label><input type="checkbox" checked={metrics.includes(key)} disabled={metrics.length===1&&metrics.includes(key)} onchange={()=>toggleMetric(key)}/>{d.label}</label>{/each}<label><input type="checkbox" bind:checked={colors}/>Kennzahlen mit Ampelfarben anzeigen</label></div><p class="cp-sub">Secure Score: unter 40 % rot · 40–69 % gelb · ab 70 % grün. Offene Befunde werden rot markiert. Fehlende Daten erhalten keinen grünen Status.</p><div class="cp-actions"><button class="btn btn-primary" onclick={()=>settings=false}>Fertig</button></div></Modal>{/if}
