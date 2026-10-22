<script>
  import { onMount } from 'svelte'
  import { apiGet } from './api.js'
  import { url, csv } from './cockpit.js'
  import { fmtDateTime } from './product.js'
  import { msApi,followJob } from './managed.js'
  import { canOperate } from './cockpit.js'
  let { tenant } = $props()
  let data = $state(null), error = $state(''), busy = $state(false), country = $state(''), type = $state('all'), q = $state('')
  let countries = $derived([...new Set((data?.signins || []).map(s => s.country))].sort())
  let rows = $derived((data?.signins || []).filter(s => !country || s.country === country).filter(s => type === 'all' || (type === 'risk' ? s.risk : type === 'success' ? s.success : !s.success)).filter(s => !q || `${s.user} ${s.app} ${s.city}`.toLowerCase().includes(q.toLowerCase())))
  let locations = $derived(Object.values((data?.signins || []).filter(s => Number.isFinite(s.latitude) && Number.isFinite(s.longitude)).reduce((acc,s) => { const k = `${s.country}:${s.city}`; acc[k] ||= { ...s,count:0 }; acc[k].count++; return acc },{})))
  async function load() { busy = true; error = ''; try { data = await apiGet(url(tenant.id,'signins')) } catch(e) { error = e.message }; busy = false }
  async function sync(){busy=true;error='';try{const j=await msApi.run(tenant.id,['signins']);const result=await followJob(j.jobId);if(!result||result.status!=='done')throw new Error(result?.error||'Sync fehlgeschlagen');await load()}catch(e){error=e.message}finally{busy=false}}
  onMount(load)
</script>
<div class="cp-head"><div><h2>Globale Anmelde-Aktivität</h2><p>{tenant.name} · Letzte 7 Tage</p></div><div class="cp-actions"><button class="btn btn-secondary" onclick={() => csv('Anmeldungen',['Zeit','Benutzer','Anwendung','Land','Stadt','Erfolg','Risiko'],rows.map(s => [s.at,s.user,s.app,s.country,s.city,s.success,s.risk]))}>CSV Export</button><button class="btn btn-primary" onclick={sync} disabled={busy||!canOperate(tenant)}>{busy ? 'Sync läuft…' : 'Synchronisieren'}</button></div></div>
{#if data?.source==='archive'}<div class="cp-note">Persistierter Datenstand · letzter erfolgreicher Sync: {fmtDateTime(data.sync?.success_at)} · {data.sync?.status||'Noch nie synchronisiert'}. Der erste Lauf lädt 24 Stunden; danach wächst das Archiv bis auf sieben Tage. Neue Ereignisse werden mit Zeitüberlappung und Deduplikation eingelesen.</div>{/if}
{#if error}<div class="cp-note cp-gaps" role="alert">{error}</div>{/if}
{#if data?.sampled}<div class="cp-note cp-gaps">Die Ansicht enthält die neuesten 1000 Anmeldungen. Weitere Anmeldungen im Zeitraum sind vorhanden.</div>{/if}
<section class="cp-panel"><div class="cp-toolbar"><h3>Standorte</h3><span class="cp-sub">Klicke einen Punkt, um nach Land zu filtern. IP-Geolokation ist näherungsweise.</span></div>
  <svg class="cp-map" viewBox="0 0 1000 440" role="img" aria-label="Anmeldestandorte auf einer schematischen Weltkarte">
    <defs><pattern id="map-grid" width="50" height="44" patternUnits="userSpaceOnUse"><path d="M50 0H0V44" fill="none" stroke="#1b3153" stroke-width=".6"/></pattern></defs>
    <rect width="1000" height="440" fill="url(#map-grid)"/>
    <g fill="#142d51" stroke="#254565" stroke-width="1.5"><path d="M45 105 95 70 172 57 231 83 270 111 241 151 205 164 179 199 139 192 112 148 70 143Z M180 199 225 216 251 260 230 305 219 352 194 326 178 273 155 232Z M307 44 349 27 380 49 353 90 319 98Z"/><path d="M444 110 471 81 507 86 534 109 525 136 490 146 468 131Z M452 155 494 137 534 159 555 208 532 269 501 306 474 272 463 228 437 192Z M530 90 582 64 649 73 694 55 776 70 837 113 902 129 925 173 878 197 831 182 800 213 760 190 747 235 714 254 684 220 658 191 613 185 593 157 552 151Z M805 286 852 277 900 304 921 340 882 361 833 346 801 319Z M943 354 961 343 951 375 936 387Z M554 293 562 271 575 281 564 317Z"/></g>
    {#each locations as s}<circle class="cp-dot" cx={(s.longitude+180)/360*1000} cy={(90-s.latitude)/180*440} r={Math.min(12,4+Math.log2(s.count+1))} fill={s.risk ? '#ff4165' : s.success ? '#2bc99f' : '#ff9448'} fill-opacity=".8" stroke="currentColor" stroke-width="1" role="button" tabindex="0" aria-label={`${s.country} ${s.city}: ${s.count} Anmeldungen`} onclick={() => country = s.country} onkeydown={e => { if(e.key === 'Enter' || e.key === ' ') { e.preventDefault(); country = s.country } }}><title>{s.country} · {s.city}: {s.count}</title></circle>{/each}
  </svg><div class="cp-legend"><span>● Erfolg · Orange: Fehlschlag · Rot: Risiko</span><span>{locations.length} Standorte</span></div>
</section>
<div class="cp-panel cp-toolbar"><input type="search" placeholder="Benutzer oder Anwendung…" aria-label="Anmeldungen suchen" bind:value={q}/><select bind:value={country} aria-label="Land"><option value="">Alle Länder</option>{#each countries as c}<option>{c}</option>{/each}</select><select bind:value={type} aria-label="Ereignistyp"><option value="all">Alle Ereignisse</option><option value="success">Erfolg</option><option value="failure">Fehlschlag</option><option value="risk">Risiko</option></select><span class="cp-sub">{rows.length} Anmeldungen</span></div>
<div class="cp-table-wrap"><table><thead><tr><th>Zeit</th><th>Benutzer</th><th>Anwendung</th><th>Standort</th><th>Ergebnis</th></tr></thead><tbody>{#each rows as s}<tr><td>{fmtDateTime(s.at)}</td><td>{s.user}</td><td>{s.app}</td><td>{s.country} · {s.city}</td><td><span class="cp-badge" class:ok={s.success && !s.risk} class:high={!s.success || s.risk}>{s.risk ? 'Risiko' : s.success ? 'Erfolg' : 'Fehlschlag'}</span></td></tr>{:else}<tr><td colspan="5">{busy ? 'Anmeldungen werden geladen…' : 'Keine Anmeldungen in dieser Ansicht.'}</td></tr>{/each}</tbody></table></div>
