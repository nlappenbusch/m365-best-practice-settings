<script>
  import { canManage } from './cockpit.js'
  import { onMount } from 'svelte'
  import { apiGet,apiPost } from './api.js'
  import { tenants,selectTenant } from './tenantStore.js'
  import { goToTab } from './tabStore.js'
  import { url } from './cockpit.js'
  import { fmtDateTime } from './product.js'
  let name=$state('Nur DACH erlauben'),mode=$state('allowOnly'),countryText=$state('CH, DE, AT'),selected=$state([]),exceptions=$state({}),plans=$state([]),results=$state([]),busy=$state(false),error=$state(''),step=$state(1),history=$state([])
  const presets=[['DACH','CH, DE, AT'],['Schweiz','CH'],['Eigene Auswahl','']]
  async function preview() {
    busy=true;error='';plans=[];results=[]
    for(const id of selected) {
      try { const p=await apiPost(url(id,'geo/preview'),{name,mode,countries:countryText.split(/[\s,;]+/).filter(Boolean),excludedUpns:exceptions[id] || ''});plans.push({id,plan:p.plan}) }
      catch(e) {plans.push({id,error:e.message})}
    }
    busy=false;step=2
  }
  async function apply() {
    busy=true;results=[];error=''
    for(const p of plans.filter(p=>p.plan)) {
      try { const r=await apiPost(url(p.id,'geo/apply'),{planId:p.plan.id});results.push({id:p.id,plan:r.plan}) }
      catch(e) {results.push({id:p.id,error:e.message})}
    }
    busy=false;step=3;await loadHistory()
  }
  async function loadHistory() {
    const all=await Promise.allSettled($tenants.map(async t=>({id:t.id,plans:(await apiGet(url(t.id,'geo/plans'))).plans})))
    history=all.filter(r=>r.status==='fulfilled').flatMap(r=>r.value.plans.map(p=>({...p,target:r.value.id}))).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))
  }
  onMount(loadHistory)
  const tenantName=id=>$tenants.find(t=>t.id===id)?.name || id
</script>
<div class="cp-head"><div><h2>Geo-Blocking Blueprint</h2><p>Länder-Regeln auf mehrere Mandanten ausrollen</p></div><button class="btn btn-secondary" onclick={()=>goToTab('cockpit-rollout')}>CA-Zustandsvorlagen</button></div>
<div class="cp-note">Neue Policies starten immer in Report-only. Dieser Modus protokolliert die mögliche Blockierung und blockiert noch keine Anmeldung. Zum späteren Aktivieren prüfst du die Ergebnisse in Conditional Access. Die Standortbestimmung erfolgt anhand der Client-IP.</div>
{#if error}<div class="cp-note cp-gaps" role="alert">{error}</div>{/if}
<div>{#each ['Konfiguration & Mandanten','Vorschau','Ergebnis'] as label,i}<span class="cp-step" class:active={step===i+1}>{i+1} · {label}</span>{/each}</div>
{#if step===1}
  <section class="cp-panel"><h3>Konfiguration</h3><div class="cp-toolbar" style="margin-top:18px">{#each presets as [label,codes]}<button class="btn btn-secondary" onclick={()=>{countryText=codes;name=label==='Eigene Auswahl'?'Eigene Länderregel':`Nur ${label} erlauben`;mode='allowOnly'}}>{label}</button>{/each}</div><div class="cp-toolbar" style="margin-top:18px"><label>Policy-Name<input bind:value={name} maxlength="80"/></label><label>Modus<select bind:value={mode}><option value="allowOnly">Nur diese Länder erlauben</option><option value="blockSelected">Diese Länder blockieren</option></select></label><label>Ländercodes<input bind:value={countryText} placeholder="CH, DE, AT"/></label></div><p class="cp-sub" style="margin-top:12px">Bei „Nur diese Länder erlauben“ umfasst die simulierte Blockierung auch unbekannte Standorte. Bei „Diese Länder blockieren“ werden unbekannte Standorte nicht erfasst.</p></section>
  <section class="cp-panel"><h3>Zielmandanten und Notfallkonten</h3><p>Je Ziel mindestens ein aktives Mitgliedskonto ausdrücklich ausnehmen. Prüfe, dass diese Konten für den Notfall geeignet und unabhängig erreichbar sind.</p>{#each $tenants as t}<div style="border-top:1px solid var(--rule);padding:16px 0"><label><input type="checkbox" bind:group={selected} value={t.id} disabled={t.readOnly || !canManage(t)}/>{t.name}{t.readOnly?' · Prüfmandat':''}</label>{#if selected.includes(t.id)}<label style="margin-top:12px">Ausgenommene Notfallkonten (UPN)<textarea style="width:100%" value={exceptions[t.id] || ''} oninput={e=>exceptions={...exceptions,[t.id]:e.currentTarget.value}} placeholder="breakglass@kunde.onmicrosoft.com"></textarea></label>{/if}</div>{/each}<button class="btn btn-primary" disabled={busy || !selected.length || !name.trim() || !countryText.trim()} onclick={preview}>{busy?'Prüfe Zielmandanten…':'Vorschau erstellen'}</button></section>
{:else if step===2}
  {#each plans as p}<section class="cp-panel"><h3>{tenantName(p.id)}</h3>{#if p.error}<p class="cp-crit">{p.error}</p>{:else}<p>{p.plan.config.name} · {p.plan.config.mode==='allowOnly'?'Nur erlauben':'Blockieren'}: {p.plan.config.countries.join(', ')}</p><p>Ausnahmen: {p.plan.exclusions.map(u=>u.upn).join(', ')}</p><p class="cp-sub">Vorschau gültig bis {fmtDateTime(p.plan.expiresAt)} · Plan-ID {p.plan.id}</p><details><summary>Geprüfte Graph-Konfiguration anzeigen</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px">{JSON.stringify(p.plan.preview,null,2)}</pre></details>{/if}</section>{/each}<div class="cp-actions"><button class="btn btn-secondary" disabled={busy} onclick={()=>step=1}>Zurück</button><button class="btn btn-primary" disabled={busy || !plans.some(p=>p.plan)} onclick={apply}>{busy?'Rollout läuft…':'Geprüfte Policies in Report-only erstellen'}</button></div>
{:else}
  {#each results as r}<section class="cp-panel"><h3>{tenantName(r.id)}</h3>{#if r.error}<p class="cp-crit">{r.error}</p><p>Bei Teilfehlern können bereits Objekte angelegt worden sein. Details stehen im Verlauf. Derselbe Plan kann bis zum Ablauf erneut versucht werden.</p>{:else}<p class="cp-ok">Report-only-Policy erstellt.</p><p class="cp-sub">Policy-ID: {r.plan.policyId} · Standort-ID: {r.plan.locationId}</p><button class="btn btn-secondary" onclick={()=>{selectTenant(r.id);goToTab('ca')}}>Conditional Access öffnen</button>{/if}</section>{/each}<div class="cp-actions"><button class="btn btn-secondary" onclick={()=>step=1}>Neuer Blueprint</button>{#if results.some(r=>r.error)}<button class="btn btn-secondary" disabled={busy} onclick={apply}>Dieselben Pläne erneut versuchen</button>{/if}</div>
{/if}
{#if history.length}<section class="cp-panel" style="margin-top:22px"><h3>Verlauf</h3><div class="cp-table-wrap" style="margin-top:16px"><table><thead><tr><th>Mandant</th><th>Name</th><th>Status</th><th>Zeit / Ausführender</th><th>Objekte / Fehler</th></tr></thead><tbody>{#each history as h}<tr><td>{tenantName(h.target)}</td><td>{h.config.name}</td><td>{h.status==='done'?'Erstellt':h.status==='failed'?'Teilweise / Fehler':'Vorschau'}</td><td>{fmtDateTime(h.createdAt)}<small>{h.by}</small></td><td style="white-space:normal;max-width:340px">{h.policyId || h.locationId || 'Noch keine Objekte'}{h.error?' · '+h.error:''}</td></tr>{/each}</tbody></table></div></section>{/if}
