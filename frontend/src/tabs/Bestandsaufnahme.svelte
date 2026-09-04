<script>
  // Erster grober IST-Überblick für einen (meist neuen) Tenant: Benutzer,
  // Lizenzen, Postfächer/Shared Mailboxes, Intune- und Entra-ID-Geräte in
  // einem Lauf. Rein lesend — es wird nichts am Tenant verändert.
  //
  // Bewusst ohne Monitoring-Grid über alle Tenants (siehe Reports.svelte):
  // eine Bestandsaufnahme ist ein einmaliger Ist-Check bei Mandatsstart, kein
  // laufendes Monitoring. Struktur (Job-Polling, Metrics/Listen-Renderer)
  // folgt trotzdem demselben Muster wie der Kundenreport.
  import { onDestroy } from 'svelte'
  import { apiGet, apiPost } from '../lib/api.js'
  import { activeTenant } from '../lib/tenantStore.js'
  import { session } from '../lib/session.js'
  import { buildInventoryHtml } from '../lib/inventoryDoc.js'

  let sections = $state([])
  let chosen = $state({})          // sectionId -> bool

  let job = $state(null)
  let jobError = $state(null)
  let jobTimer = null
  let fullInventory = $state(null)
  let latestInventory = $state(null)   // gespeicherter Stand (inkl. Listen)
  let listOpen = $state({})            // "sectionId/listId" -> bool

  // Angezeigt wird der frische Lauf, sonst der gespeicherte Stand.
  let shownInventory = $derived(fullInventory || latestInventory)

  async function loadLatest(tid) {
    latestInventory = null; listOpen = {}
    if (!tid) return
    try {
      const r = await apiGet(`/api/tenants/${encodeURIComponent(tid)}/inventory/latest`)
      latestInventory = r.inventory || null
    } catch (e) { /* kein Stand */ }
  }
  $effect(() => { if ($session.loggedIn) { fullInventory = null; loadLatest($activeTenant?.id) } })

  async function load() {
    try {
      const s = await apiGet('/api/inventory/sections')
      sections = s.sections || []
      if (!Object.keys(chosen).length) for (const sec of sections) chosen[sec.id] = true
    } catch (e) { /* Anzeige bleibt leer */ }
  }

  $effect(() => {
    if ($session.loggedIn && !sections.length) load()
  })

  async function runInventory() {
    if (!$activeTenant) return
    jobError = null
    job = null
    fullInventory = null
    const picked = sections.filter(s => chosen[s.id]).map(s => s.id)
    try {
      const start = await apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/inventory/run`, { sections: picked })
      pollJob(start.jobId)
    } catch (e) {
      jobError = e.message
    }
  }

  function pollJob(jobId) {
    jobTimer = setTimeout(async () => {
      let j
      try { j = await apiGet(`/api/appjobs/${encodeURIComponent(jobId)}`) }
      catch (e) { jobError = 'Fortschritt nicht abrufbar: ' + e.message; return }
      job = j
      if (j.status === 'running') { pollJob(jobId); return }
      if (j.status === 'done') {
        try {
          const r = await apiGet(`/api/jobs/inventory/${encodeURIComponent(jobId)}`)
          fullInventory = r.inventory
        } catch (e) { /* Kennzahlen stehen auch ohne Rohdaten im gespeicherten Stand */ }
        loadLatest($activeTenant?.id)
      }
    }, 1500)
  }

  function exportHtml() {
    if (!fullInventory) return
    const html = buildInventoryHtml(fullInventory)
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `Bestandsaufnahme_${(fullInventory.tenantName || 'Tenant').replace(/[^A-Za-z0-9]+/g, '-')}_${fullInventory.generatedAt.slice(0, 10)}.html`
    document.body.appendChild(a)
    a.click()
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove() }, 2000)
  }

  const ICON = { ok: '✅', warn: '⚠️', crit: '❌' }

  onDestroy(() => { if (jobTimer) clearTimeout(jobTimer) })
</script>

{#if !$session.loggedIn}
  <div class="alert alert-warning"><strong>Nicht angemeldet.</strong> Oben rechts anmelden.</div>
{:else}
  <div class="settings-group">
    <h4>Bestandsaufnahme erzeugen{$activeTenant ? ` — ${$activeTenant.name}` : ''}</h4>
    {#if !$activeTenant}
      <p class="ld-section-hint">Oben rechts einen Tenant wählen.</p>
    {:else}
      <p class="ld-section-hint">Liest ausschliesslich — es wird nichts verändert. Postfächer/Shared Mailboxes
        laufen über Exchange Online und können bei grossen Tenants ein paar Minuten dauern.</p>
      <div class="checkbox-grid">
        {#each sections as sec}
          <label class="rep-section">
            <input type="checkbox" bind:checked={chosen[sec.id]} />
            <span><strong>{sec.label}</strong><br /><small>{sec.desc}</small></span>
          </label>
        {/each}
      </div>
      <div style="display:flex; gap:0.5rem; margin-top:0.75rem; flex-wrap:wrap">
        <button class="btn btn-primary" onclick={runInventory} disabled={job?.status === 'running'}>
          {job?.status === 'running' ? 'Läuft…' : '▶ Bestandsaufnahme erzeugen'}
        </button>
        {#if fullInventory}
          <button class="btn btn-secondary" onclick={exportHtml}>Als HTML speichern (druckbar)</button>
        {/if}
      </div>
    {/if}

    {#if jobError}<div class="ld-banner fail" style="margin-top:0.75rem">{jobError}</div>{/if}

    {#if job}
      <div class="ld-job" style="margin-top:0.75rem">
        <div class="ld-job-head"><strong>{job.status === 'running' ? '⏳' : ''} Bestandsaufnahme {$activeTenant?.name}</strong>
          <span class="ld-job-meta">{job.phase}</span></div>
        {#if job.status === 'done'}
          <div class="ld-banner ok">Fertig.{job.hint ? ' ' + job.hint : ''}</div>
        {:else if job.status === 'failed'}
          <div class="ld-banner fail">{job.error}</div>
        {/if}
        {#each job.steps as s}
          <div class="ld-step {s.state === 'failed' ? 'fail' : 'ok'}">
            <span class="ld-ico">{s.state === 'done' ? '✅' : s.state === 'failed' ? '❌' : s.state === 'running' ? '⏳' : '○'}</span> {s.name}
          </div>
        {/each}
      </div>
    {/if}

    {#if shownInventory}
      {#if !fullInventory}
        <p class="ld-section-hint" style="margin-top:0.75rem">Gespeicherter Stand vom
          {shownInventory.generatedAt ? shownInventory.generatedAt.slice(0, 16).replace('T', ' ') : '—'} —
          für frische Zahlen oben neu erzeugen.</p>
      {/if}
      {#each Object.entries(shownInventory.sections) as [id, sec] (id)}
        <div class="rep-section-result">
          <div class="rep-section-title">{sec.ok ? '' : '⚠️ '}{sec.label}</div>
          {#if !sec.ok}
            <p class="ld-section-hint">Nicht abrufbar: {sec.error}{sec.hint ? ' — ' + sec.hint : ''}</p>
          {:else}
            <div class="rep-metrics">
              {#each sec.metrics as m}
                <div class="rep-metric {m.state}">
                  <div class="rep-metric-value">{m.value ?? '—'}</div>
                  <div class="rep-metric-label">{ICON[m.state]} {m.label}</div>
                  {#if m.detail}<div class="rep-metric-detail">{m.detail}</div>{/if}
                </div>
              {/each}
            </div>
            {#each sec.lists || [] as l (l.id)}
              {@const key = `${id}/${l.id}`}
              <button class="linklike" style="margin-top:0.5rem; display:block"
                      onclick={() => (listOpen[key] = !listOpen[key])}>
                {listOpen[key] ? '▾' : '▸'} {l.label}
                ({l.rows.length}{l.more ? ` von ${l.rows.length + l.more}` : ''})
              </button>
              {#if listOpen[key]}
                <div class="gt-table-wrap" style="margin-top:0.35rem">
                  <table class="gt-table">
                    <thead><tr>{#each l.columns as c}<th>{c}</th>{/each}</tr></thead>
                    <tbody>
                      {#each l.rows as r}
                        <tr>{#each r as cell}<td>{cell}</td>{/each}</tr>
                      {/each}
                    </tbody>
                  </table>
                </div>
                {#if l.more}<p class="ld-section-hint" style="margin-top:0.25rem">… und {l.more} weitere (Liste im gespeicherten Stand gekappt).</p>{/if}
              {/if}
            {/each}
          {/if}
        </div>
      {/each}
    {/if}
  </div>
{/if}
