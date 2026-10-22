<script>
  import { canOperate } from './cockpit.js'
  import { onMount } from 'svelte'
  import { apiGet, apiPost } from './api.js'
  import { url, csv } from './cockpit.js'
  import { fmtDateTime } from './product.js'
  let { tenant } = $props()
  let reports = $state([]), error = $state(''), message = $state(''), busy = $state(false), domain = $state(''), q = $state(''), failures = $state(false)
  let domains = $derived([...new Set(reports.map(r => r.domain))])
  let rows = $derived(reports.filter(r => !domain || r.domain === domain).flatMap(r => r.rows.map(x => ({ ...x, domain:r.domain, at:r.begin, reporter:r.organization }))).filter(r => !failures || !r.pass).filter(r => !q || `${r.ip} ${r.domain} ${r.reporter}`.toLowerCase().includes(q.toLowerCase())))
  let total = $derived(rows.reduce((n,r) => n + r.count,0)), failed = $derived(rows.filter(r => !r.pass).reduce((n,r) => n + r.count,0))
  async function load() { try { reports = (await apiGet(url(tenant.id,'dmarc'))).reports } catch(e) { error = e.message } }
  async function upload(e) {
    const input = e.currentTarget, files = [...(input.files || [])]; busy = true; error = ''; message = ''
    let imported = 0, duplicates = 0
    for (const file of files) {
      try {
        if (file.size > 450000) throw new Error('Maximal 450 KB pro unkomprimierter XML-Datei.')
        const result = await apiPost(url(tenant.id,'dmarc/import'), { xml:await file.text() })
        if (result.duplicate) duplicates++; else imported++
      } catch(err) { error += `${file.name}: ${err.message} ` }
    }
    message = `${imported} Bericht(e) importiert, ${duplicates} Duplikat(e) übersprungen.`
    await load(); busy = false; input.value = ''
  }
  onMount(load)
</script>
<div class="cp-head"><div><h2>DMARC Reporting</h2><p>{tenant.name} · Aggregatberichte und fehlgeschlagene Authentifizierung</p></div><div class="cp-actions"><button class="btn btn-secondary" onclick={() => csv('DMARC',['Domain','Quell-IP','Anzahl','Bestanden','Disposition','Reporter','Zeitraum ab'],rows.map(r => [r.domain,r.ip,r.count,r.pass,r.disposition,r.reporter,r.at]))}>CSV Export</button><label class="btn btn-primary" style="color:#08202a;cursor:pointer">{busy ? 'Import läuft…' : '+ XML-Berichte importieren'}<input type="file" accept=".xml,text/xml,application/xml" multiple onchange={upload} disabled={busy || !canOperate(tenant)} style="display:none"/></label></div></div>
<div class="cp-note">Importiere unkomprimierte DMARC-Aggregatberichte (.xml) aus deinem Reporting-Postfach. Der Import dedupliziert nach Domain, Reporter und Report-ID. Automatischer E-Mail-Empfang und DNS-Verifizierung sind hier nicht eingerichtet. Eine Nachricht besteht, wenn SPF oder DKIM im DMARC-Ergebnis als ausgerichtet und bestanden gemeldet wird.</div>
{#if error}<div class="cp-note cp-gaps" role="alert">{error}</div>{/if}{#if message}<div class="cp-note" role="status">{message}</div>{/if}
<div class="cp-kpis"><div class="cp-kpi"><span>Domains</span><strong>{domains.length}</strong></div><div class="cp-kpi"><span>Berichte gesamt</span><strong>{reports.length}</strong></div><div class="cp-kpi"><span>Pass-Rate (gefiltert)</span><strong class="cp-ok">{total ? ((total-failed)/total*100).toFixed(1)+'%' : '—'}</strong></div><div class="cp-kpi"><span>Fehlgeschlagen (gefiltert)</span><strong class="cp-crit">{failed}</strong></div></div>
<div class="cp-panel cp-toolbar"><input type="search" bind:value={q} placeholder="Domain, IP oder Reporter suchen…" aria-label="DMARC durchsuchen"/><select bind:value={domain} aria-label="Domain"><option value="">Alle Domains</option>{#each domains as d}<option>{d}</option>{/each}</select><label><input type="checkbox" bind:checked={failures}/>Nur fehlgeschlagene</label></div>
<div class="cp-table-wrap"><table><thead><tr><th>Domain</th><th>Quell-IP</th><th>Nachrichten</th><th>DMARC</th><th>Disposition</th><th>Reporter / Zeitraum</th></tr></thead><tbody>{#each rows as r}<tr><td>{r.domain}</td><td>{r.ip}</td><td>{r.count}</td><td><span class="cp-badge" class:ok={r.pass} class:high={!r.pass}>{r.pass ? 'Bestanden' : 'Fehlgeschlagen'}</span></td><td>{r.disposition}</td><td>{r.reporter}<small>{fmtDateTime(r.at)}</small></td></tr>{:else}<tr><td colspan="6">Keine Berichte in dieser Ansicht. Importiere deinen ersten DMARC-Bericht.</td></tr>{/each}</tbody></table></div>
