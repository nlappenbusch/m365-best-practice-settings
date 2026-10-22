<script>
  import { canManage } from './cockpit.js'
  import { onMount } from 'svelte'
  import { apiGet, apiPost } from './api.js'
  import { tenants, activeTenant } from './tenantStore.js'
  import { goToTab } from './tabStore.js'
  import Modal from './CockpitModal.svelte'
  let templates = $state([]), templateId = $state(''), selected = $state([]), step = $state(1), comparisons = $state([]), results = $state([]), exclusions = $state({}), busy = $state(false), error = $state(''), name = $state(''), capture = $state(false), allowEnable = $state(false)
  let chosen = $derived(templates.find(t => t.id === templateId))
  const base = id => `/api/tenants/${encodeURIComponent(id)}/conditionalaccess`
  async function load() { try { templates = (await apiGet('/api/ca-templates')).templates } catch(e) { error = e.message } }
  async function create() { busy = true; try { await apiPost(base($activeTenant.id) + '/capture-template',{ name }); capture = false; await load() } catch(e) { error = e.message }; busy = false }
  async function preview() {
    busy = true; error = ''; comparisons = []; exclusions = {}; results = []
    for (const id of selected) {
      try { comparisons.push({ id, comparison:(await apiPost(base(id)+'/compare-template',{ templateId })).vergleich }) }
      catch(e) { comparisons.push({ id,error:e.message }) }
    }
    busy = false; step = 3
  }
  function keys(c) { return c.comparison.zeilen.filter(z => z.aktion === 'aendern' && !exclusions[c.id + ':' + z.key] && (allowEnable || z.sollState !== 'enabled')).map(z => z.key) }
  async function apply() {
    busy = true; results = []; error = ''
    for (const c of comparisons.filter(c => !c.error)) {
      const picked = keys(c)
      if (!picked.length) { results.push({ id:c.id,message:'Keine freigegebenen Änderungen.' }); continue }
      try { const r = (await apiPost(base(c.id) + '/apply-template', { templateId,allowEnable,nurKeys:picked })).ergebnis; results.push({ id:c.id,message:`${r.gesetzt} gesetzt · ${r.uebersprungen} übersprungen · ${r.fehler} Fehler`,details:r.ergebnisse }) }
      catch(e) { results.push({ id:c.id,message:e.message }) }
    }
    busy = false; step = 4
  }
  onMount(load)
</script>
<div class="cp-head"><div><h2>Multi-Tenant Policy-Rollout</h2><p>Gespeicherte CA-Zustandsvorlagen mit Vorschau und Ausnahmen</p></div><button class="btn btn-secondary" disabled={!$activeTenant} onclick={() => { name = ''; capture = true }}>Blueprint aus Tenant erstellen</button></div>
<div class="cp-note">Dieser Ablauf übernimmt Zustände bereits vorhandener eigener CA-Policies. Fehlende Policies werden in der Vorschau ausgewiesen. Neue Baseline-Richtlinien stellst du im Bereich Conditional Access bereit. <button class="btn btn-secondary" onclick={()=>goToTab('cockpit-geo')}>Länder-Blueprint erstellen</button></div>
{#if error}<div class="cp-note cp-gaps" role="alert">{error}</div>{/if}
<div>{#each ['Blueprint','Mandanten','Vorschau & Ausnahmen','Ergebnis'] as label,i}<span class="cp-step" class:active={step === i+1}>{i+1} · {label}</span>{/each}</div>
{#if step === 1}<div class="cp-grid">{#each templates as t}<section class="cp-panel"><h3>{t.name}</h3><p>{t.quelle.tenantName} · {t.zusammenfassung.gesamt} Elemente</p><button class="btn btn-primary" onclick={() => { templateId = t.id; step = 2; selected = []; allowEnable = false }}>Auf Mandanten ausrollen</button></section>{:else}<div class="cp-empty">Noch keine Blueprints. Erstelle zuerst eine Vorlage aus einem verbundenen Mandanten.</div>{/each}</div>
{:else if step === 2}<section class="cp-panel"><h3>{chosen?.name} · Zielmandanten</h3>{#each $tenants as t}<label style="margin:16px 0"><input type="checkbox" value={t.id} bind:group={selected} disabled={t.readOnly || !canManage(t)}/>{t.name}{t.readOnly ? ' · Prüfmandat (nur lesend)' : ''}</label>{/each}<div class="cp-actions"><button class="btn btn-secondary" disabled={busy} onclick={() => step = 1}>Zurück</button><button class="btn btn-primary" disabled={busy || !selected.length} onclick={preview}>{busy ? 'Vergleiche…' : 'Vorschau erstellen'}</button></div></section>
{:else if step === 3}
  <section class="cp-panel"><h3>Pro Mandant prüfen</h3><p>Änderungen lassen sich pro Ziel ausschließen. Aktive Richtlinien werden nur mit der zusätzlichen Freigabe unten gesetzt.</p><label><input type="checkbox" bind:checked={allowEnable} disabled={busy}/>Auch aktive Zustände übernehmen (Policies können Anmeldungen blockieren)</label></section>
  {#each comparisons as c}<section class="cp-panel"><h3>{$tenants.find(t => t.id === c.id)?.name}</h3>{#if c.error}<p class="cp-crit">{c.error}</p>{:else}<p>{c.comparison.zusammenfassung.zuAendern} Änderungen · {c.comparison.zusammenfassung.fehlt} fehlende Policies · {c.comparison.zusammenfassung.davonScharfAlleBenutzer} Aktivierungen für alle Benutzer</p><div class="cp-table-wrap"><table><thead><tr><th>Übernehmen</th><th>Policy</th><th>Ist</th><th>Soll</th><th>Hinweis</th></tr></thead><tbody>{#each c.comparison.zeilen as z}<tr><td>{#if z.aktion === 'aendern'}<input type="checkbox" aria-label={z.displayName + ' übernehmen'} checked={!exclusions[c.id+':'+z.key]} disabled={busy || (z.sollState === 'enabled' && !allowEnable)} onchange={e => exclusions = { ...exclusions,[c.id+':'+z.key]:!e.currentTarget.checked }}/>{/if}</td><td>{z.displayName}</td><td>{z.istState || '—'}</td><td>{z.sollState || '—'}</td><td style="white-space:normal;max-width:300px">{z.hinweis || z.aktion}</td></tr>{/each}</tbody></table></div>{/if}</section>{/each}
  <div class="cp-actions"><button class="btn btn-secondary" disabled={busy} onclick={() => step = 2}>Zurück</button><button class="btn btn-secondary" disabled={busy} onclick={() => goToTab('ca')}>Conditional Access öffnen</button><button class="btn btn-primary" disabled={busy || !comparisons.some(c => !c.error && keys(c).length)} onclick={apply}>{busy ? 'Rollout läuft…' : 'Ausgewählte Änderungen ausführen'}</button></div>
{:else}{#each results as r}<section class="cp-panel"><h3>{$tenants.find(t => t.id === r.id)?.name}</h3><p>{r.message}</p>{#each r.details?.filter(d => d.status === 'fehler') || [] as d}<p class="cp-crit">{d.displayName}: {d.grund}</p>{/each}</section>{/each}<button class="btn btn-secondary" onclick={() => step = 1}>Zur Blueprint-Übersicht</button>{/if}
{#if capture}<Modal {error} label="Blueprint erstellen" onclose={() => capture = false} {busy}><h3>Vorlage aus {$activeTenant?.name}</h3><label>Name<input bind:value={name} maxlength="100"/></label><div class="cp-actions"><button class="btn btn-secondary" disabled={busy} onclick={() => capture = false}>Abbrechen</button><button class="btn btn-primary" disabled={busy || !name.trim()} onclick={create}>Blueprint erstellen</button></div></Modal>{/if}
