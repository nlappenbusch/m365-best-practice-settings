<script>
  import { canManage,canOperate,url,LEVEL } from './cockpit.js'
  import Modal from './CockpitModal.svelte'
  import { onMount,onDestroy } from 'svelte'
  import { apiGet,apiPost,apiPut,apiDelete } from './api.js'
  import { fmtDateTime } from './product.js'
  let { tenant } = $props()
  let data=$state({rules:[],history:[],areas:[],alarms:[],deliveries:[],templates:[],activities:{},sources:[]})
  let error=$state(''),notice=$state(''),busy=$state(false),tab=$state('rules'),edit=$state(null),removing=$state(null),q=$state(''),jobId=$state(null)
  let timer, disposed=false
  const DELIVERY={queued:'Wartet',sending:'Wird gesendet',retry:'Wird erneut versucht',sent:'Von Teams angenommen',failed:'Fehlgeschlagen',blocked:'Ziel prüfen'}
  const shown=$derived(data.rules.filter(r=>!q||`${r.name} ${r.description}`.toLowerCase().includes(q.toLowerCase())))
  async function load(){try{const next=await apiGet(url(tenant.id,'alarms'));if(!disposed)data=next}catch(e){if(!disposed)error=e.message}}
  async function save(rule=edit){busy=true;error='';try{await apiPut(url(tenant.id,`alarms/${encodeURIComponent(rule.id||'new')}`),rule);edit=null;await load()}catch(e){error=e.message}finally{busy=false}}
  async function check(){busy=true;error='';try{await apiPost(url(tenant.id,'alarms/check'));notice='Gespeicherte Daten geprüft. Für aktuelle Daten die Quellen aktualisieren.';await load()}catch(e){error=e.message}finally{busy=false}}
  async function scan(){busy=true;error='';try{const r=await apiPost(`/api/tenants/${encodeURIComponent(tenant.id)}/managed/run`,{areas:['defender','directoryAudit']});jobId=r.jobId;notice='Defender und Entra-Protokoll werden geladen.'}catch(e){error=e.message}finally{busy=false}}
  async function refresh(){if(jobId){try{const j=await apiGet(`/api/appjobs/${encodeURIComponent(jobId)}`);if(!['queued','running','retry'].includes(j.status)){jobId=null;notice=j.status==='done'?'Daten aktualisiert und Regeln geprüft.':j.error||j.hint||'Lauf beendet. Quellenstatus prüfen.'}}catch(e){error=e.message;jobId=null}}await load()}
  async function retry(id){busy=true;try{await apiPost(url(tenant.id,`alarms/deliveries/${encodeURIComponent(id)}/retry`));await load()}catch(e){error=e.message}finally{busy=false}}
  async function remove(){busy=true;try{await apiDelete(url(tenant.id,`alarms/${encodeURIComponent(removing.id)}`));removing=null;await load()}catch(e){error=e.message}finally{busy=false}}
  onMount(()=>{load();timer=setInterval(refresh,5000)})
  onDestroy(()=>{disposed=true;clearInterval(timer)})
</script>
<div class="cp-head"><div><h2>Alarm-Regeln</h2><p>{tenant.name} · Was meldet das Tool – und ist die Nachricht angekommen?</p></div><div class="cp-actions">
  <button class="btn btn-secondary" disabled={busy||!!jobId||!canOperate(tenant)} onclick={scan}>{jobId?'Abruf läuft…':'Defender & Protokoll aktualisieren'}</button>
  <button class="btn btn-secondary" disabled={busy||!canOperate(tenant)} onclick={check}>Regeln prüfen</button>
  <button class="btn btn-primary" disabled={!canManage(tenant)} onclick={()=>edit={name:'',description:'',kind:'findings',area:'defender',severity:'high',threshold:1,enabled:true,notify:false,windowMinutes:60}}>+ Regel erstellen</button>
</div></div>
<div class="cp-note">Ein anhaltendes Problem bleibt ein Alarm. Nach zwei erfolgreichen Prüfungen unter dem Schwellwert folgt eine Entwarnung. Fehlende oder veraltete Daten schließen keinen Alarm. Bearbeitung und Notizen bleiben in „Befunde & Überwachung“.</div>
{#if error}<div class="cp-note cp-gaps" role="alert">{error}</div>{/if}
{#if notice}<div class="cp-note" role="status">{notice}</div>{/if}
<section class="cp-panel"><h3>Datenquellen</h3><p>Für regelmäßige Abrufe die beiden Bereiche unter „Befunde & Überwachung“ im Zeitplan aktivieren. Benötigt lesenden Zugriff auf Defender-Alarme, Defender-Incidents und Entra-Audit-Logs.</p>
  {#each data.sources as source}<p><strong>{source.label}</strong> · {source.ok===true?'Letzter erfolgreicher Abruf':source.ok===false?'Nicht abrufbar':'Noch nicht abgerufen'} · {fmtDateTime(source.lastOkAt)}{source.error?' · '+source.error:''}{source.note?' · '+source.note:''}</p>{/each}
</section>
<div class="cp-tabs"><button class:active={tab==='rules'} onclick={()=>tab='rules'}>Regeln ({data.rules.length})</button><button class:active={tab==='history'} onclick={()=>tab='history'}>Alarmverlauf</button><button class:active={tab==='deliveries'} onclick={()=>tab='deliveries'}>Zustellung ({data.deliveries.filter(d=>d.status!=='sent').length})</button></div>
{#if tab==='rules'}
  <section class="cp-panel"><h3>Regelvorlagen</h3><p>Vorlage auswählen, prüfen und speichern. Bestehende Regeln senden erst nach Aktivierung von „Teams benachrichtigen“.</p><div class="cp-actions">{#each data.templates as template}<button class="btn btn-secondary" disabled={!canManage(tenant)} onclick={()=>edit={...template}}>{template.name}</button>{/each}</div></section>
  <div class="cp-panel cp-toolbar"><input type="search" bind:value={q} placeholder="Regeln suchen…" aria-label="Regeln suchen"/></div>
  {#each shown as r}
    {@const state=data.alarms.find(a=>a.ruleId===r.id)}
    <section class="cp-panel cp-rule"><div><h3>{r.name}</h3><p>{r.description}</p>
      <p>{r.kind==='audit'?`${data.activities[r.activity]} · letzte ${r.windowMinutes} Minuten`:data.areas.find(a=>a.id===r.area)?.label||'Alle überwachten Bereiche'} · mindestens {r.threshold} Treffer ab {LEVEL[r.severity]}</p>
      <span class="cp-badge" class:high={state?.active}>{!r.enabled?'Pausiert':state?.check==='unknown'?'Daten fehlen':state?.active?'Alarm offen':state?'Unter Schwellwert':'Noch nicht geprüft'}</span>
      <small> {state?.message} {state?.count!=null?`· ${state.count} Treffer`:''} · {r.notify?'Teams aktiv':'Nur im Tool'}</small>
    </div><div class="cp-actions"><label><input type="checkbox" checked={r.enabled} disabled={busy||!canManage(tenant)} onchange={()=>save({...r,enabled:!r.enabled})}/>Aktiv</label><button class="btn btn-secondary" disabled={!canManage(tenant)} onclick={()=>edit={kind:'findings',windowMinutes:60,notify:false,...r}}>Bearbeiten</button><button class="btn btn-secondary" disabled={!canManage(tenant)} onclick={()=>removing=r}>Löschen</button></div></section>
  {:else}<div class="cp-empty">Keine Regeln. Wähle eine Vorlage für den ersten Alarm.</div>{/each}
{:else if tab==='history'}
  <div class="cp-table-wrap"><table><thead><tr><th>Zeitpunkt</th><th>Regel</th><th>Treffer</th><th>Ergebnis</th></tr></thead><tbody>{#each data.history as h}<tr><td>{fmtDateTime(h.at)}</td><td>{h.name}</td><td>{h.count}</td><td>{h.triggered?'Alarm ausgelöst':'Unter Schwellwert'}<small>{h.message}</small></td></tr>{:else}<tr><td colspan="4">Noch keine Zustandsänderungen. Wiederholte Prüfungen erzeugen keine neuen Alarme.</td></tr>{/each}</tbody></table></div>
{:else}
  <div class="cp-note">{data.configured?'Teams-Ziel ist eingerichtet.':'Teams-Ziel fehlt. Ein Administrator kann es im Service-Cockpit einrichten.'} Vorübergehende Fehler werden bis zu achtmal versucht. Bei einem Verbindungsabbruch kann Teams die Nachricht bereits erhalten haben; Wiederholungen tragen dieselbe Meldungs-ID. „Angenommen“ bestätigt die HTTP-Annahme durch Teams, nicht das Lesen der Nachricht.</div>
  <div class="cp-table-wrap"><table><thead><tr><th>Erstellt / Meldung</th><th>Zustand</th><th>Versuche</th><th>Hinweis</th><th></th></tr></thead><tbody>{#each data.deliveries as d}<tr><td>{fmtDateTime(d.created_at)}<small>{d.title}</small></td><td>{DELIVERY[d.status]||d.status}</td><td>{d.attempts}</td><td>{d.error||'—'}<small>Meldungs-ID: {d.id}</small></td><td>{#if ['failed','blocked'].includes(d.status)}<button class="btn btn-secondary" disabled={busy||!canManage(tenant)} onclick={()=>retry(d.id)}>Erneut senden</button>{/if}</td></tr>{:else}<tr><td colspan="5">Noch keine Benachrichtigungsaufträge.</td></tr>{/each}</tbody></table></div>
{/if}
{#if edit}<Modal {error} label="Alarmregel bearbeiten" onclose={()=>edit=null} {busy}>
  <h3>{edit.id?'Regel bearbeiten':'Regel erstellen'}</h3><label>Regelname<input bind:value={edit.name} maxlength="120"/></label><label>Beschreibung<textarea bind:value={edit.description} maxlength="1000"></textarea></label>
  <label>Was prüfen?<select bind:value={edit.kind}><option value="findings">Offene Befunde</option><option value="audit">Sicherheitsänderungen im Zeitfenster</option></select></label>
  {#if edit.kind==='audit'}<label>Änderung<select bind:value={edit.activity}><option value="">Bitte wählen</option>{#each Object.entries(data.activities) as [id,label]}<option value={id}>{label}</option>{/each}</select></label><label>Zeitraum in Minuten<input type="number" min="10" max="1440" bind:value={edit.windowMinutes}/></label><p>Unter Schwellwert bedeutet hier: weniger Änderungen im Zeitfenster. Die ursprüngliche Änderung bleibt prüfbar.</p>
  {:else}<label>Bereich<select bind:value={edit.area}><option value="">Alle überwachten Bereiche</option>{#each data.areas as a}<option value={a.id}>{a.label}</option>{/each}</select></label>{/if}
  <label>Schweregrad ab<select bind:value={edit.severity}>{#each Object.entries(LEVEL) as [id,label]}<option value={id}>{label}</option>{/each}</select></label><label>Ab wie vielen Treffern melden?<input type="number" min="1" max="10000" bind:value={edit.threshold}/></label>
  <label><input type="checkbox" bind:checked={edit.notify}/>Teams benachrichtigen (Alarm und Entwarnung)</label>
  <div class="cp-actions"><button class="btn btn-secondary" disabled={busy} onclick={()=>edit=null}>Abbrechen</button><button class="btn btn-primary" disabled={busy||!edit.name.trim()} onclick={()=>save()}>Speichern</button></div>
</Modal>{/if}
{#if removing}<Modal {error} label="Regel löschen" onclose={()=>removing=null} {busy}><h3>Regel löschen?</h3><p>{removing.name} · Bereits gespeicherte Benachrichtigungsaufträge bleiben erhalten.</p><div class="cp-actions"><button class="btn btn-secondary" disabled={busy} onclick={()=>removing=null}>Abbrechen</button><button class="btn btn-primary" disabled={busy} onclick={remove}>Löschen</button></div></Modal>{/if}
