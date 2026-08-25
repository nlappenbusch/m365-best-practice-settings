<script>
  // Monitoring-Übersicht über alle Tenants + Report-Erzeugung für den aktiven.
  //
  // Die Übersicht liest ausschliesslich gespeicherte Reports — kein Live-Abruf.
  // Sonst würde die Seite bei einem Dutzend Tenants minutenlang laden. Wie alt
  // die Daten sind, steht deshalb an jeder Zeile.
  import { onDestroy } from 'svelte'
  import { apiGet, apiPost } from '../lib/api.js'
  import { activeTenant, tenants } from '../lib/tenantStore.js'
  import { session } from '../lib/session.js'
  import { buildReportHtml } from '../lib/reportDoc.js'

  let sections = $state([])
  let chosen = $state({})          // sectionId -> bool
  let overview = $state([])
  let overviewLoading = $state(false)
  let expanded = $state({})        // tenantId -> bool

  let job = $state(null)
  let jobError = $state(null)
  let jobTimer = null
  let fullReport = $state(null)

  async function load() {
    overviewLoading = true
    try {
      const [s, o] = await Promise.all([apiGet('/api/reports/sections'), apiGet('/api/reports/overview')])
      sections = s.sections || []
      if (!Object.keys(chosen).length) for (const sec of sections) chosen[sec.id] = true
      overview = o.tenants || []
    } catch (e) { /* Anzeige bleibt leer */ }
    overviewLoading = false
  }

  $effect(() => {
    if ($session.loggedIn && !sections.length && !overviewLoading) load()
  })

  async function runReport() {
    if (!$activeTenant) return
    jobError = null
    job = null
    fullReport = null
    const picked = sections.filter(s => chosen[s.id]).map(s => s.id)
    try {
      const start = await apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/report/run`, { sections: picked })
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
          const r = await apiGet(`/api/jobs/report/${encodeURIComponent(jobId)}`)
          fullReport = r.report
        } catch (e) { /* Kennzahlen stehen auch ohne Rohdaten in der Übersicht */ }
        await load()
      }
    }, 1500)
  }

  function exportHtml() {
    if (!fullReport) return
    const html = buildReportHtml(fullReport)
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `Report_${(fullReport.tenantName || 'Tenant').replace(/[^A-Za-z0-9]+/g, '-')}_${fullReport.generatedAt.slice(0, 10)}.html`
    document.body.appendChild(a)
    a.click()
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove() }, 2000)
  }

  const ICON = { ok: '✅', warn: '⚠️', crit: '❌' }
  const age = (iso) => {
    if (!iso) return null
    const h = Math.floor((Date.now() - new Date(iso)) / 3600000)
    if (h < 1) return 'gerade eben'
    if (h < 24) return `vor ${h} h`
    return `vor ${Math.floor(h / 24)} Tagen`
  }

  onDestroy(() => { if (jobTimer) clearTimeout(jobTimer) })
</script>

{#if !$session.loggedIn}
  <div class="alert alert-warning"><strong>Nicht angemeldet.</strong> Oben rechts anmelden.</div>
{:else}
  <div class="settings-group">
    <h4>Übersicht über alle Tenants</h4>
    <p class="ld-section-hint">Stand der zuletzt erzeugten Reports — nichts wird live abgefragt. Für frische Zahlen
      unten einen Report erzeugen.</p>

    {#if overviewLoading}
      <p class="ld-section-hint">Lade…</p>
    {:else if overview.length === 0}
      <p class="ld-section-hint">Keine Tenants vorhanden.</p>
    {:else}
      <div class="rep-grid">
        {#each overview as row (row.id)}
          <div class="rep-card" class:crit={row.summary?.crit > 0} class:warn={!row.summary?.crit && row.summary?.warn > 0}>
            <div class="rep-card-head">
              <strong>{row.name}</strong>
              <span class="rep-age">{row.generatedAt ? age(row.generatedAt) : 'noch kein Report'}</span>
            </div>
            {#if row.summary}
              <div class="rep-counts">
                <span class="rep-count crit">{row.summary.crit} kritisch</span>
                <span class="rep-count warn">{row.summary.warn} Hinweise</span>
                <span class="rep-count ok">{row.summary.ok} ok</span>
              </div>
              {#if row.findings.length}
                <button class="linklike" onclick={() => (expanded[row.id] = !expanded[row.id])}>
                  {expanded[row.id] ? '▾' : '▸'} {row.findings.length} auffällige Kennzahlen
                </button>
                {#if expanded[row.id]}
                  <ul class="rep-findings">
                    {#each row.findings as f}
                      <li>{ICON[f.state]} <strong>{f.label}:</strong> {f.value}
                        <small>({f.section}{f.detail ? ' — ' + f.detail : ''})</small></li>
                    {/each}
                  </ul>
                {/if}
              {:else}
                <p class="ld-section-hint" style="margin:0.3rem 0 0">Keine Auffälligkeiten.</p>
              {/if}
            {:else}
              <p class="ld-section-hint" style="margin:0.3rem 0 0">Noch nie ausgewertet.</p>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>

  <div class="settings-group" style="margin-top:1.25rem">
    <h4>Report erzeugen{$activeTenant ? ` — ${$activeTenant.name}` : ''}</h4>
    {#if !$activeTenant}
      <p class="ld-section-hint">Oben rechts einen Tenant wählen.</p>
    {:else}
      <p class="ld-section-hint">Liest ausschliesslich — es wird nichts verändert. Je nach Grösse des Tenants dauert
        das ein bis zwei Minuten.</p>
      <div class="checkbox-grid">
        {#each sections as sec}
          <label class="rep-section">
            <input type="checkbox" bind:checked={chosen[sec.id]} />
            <span><strong>{sec.label}</strong><br /><small>{sec.desc}</small></span>
          </label>
        {/each}
      </div>
      <div style="display:flex; gap:0.5rem; margin-top:0.75rem; flex-wrap:wrap">
        <button class="btn btn-primary" onclick={runReport} disabled={job?.status === 'running'}>
          {job?.status === 'running' ? 'Läuft…' : '▶ Report erzeugen'}
        </button>
        {#if fullReport}
          <button class="btn btn-secondary" onclick={exportHtml}>Als HTML speichern (druckbar)</button>
        {/if}
      </div>
    {/if}

    {#if jobError}<div class="ld-banner fail" style="margin-top:0.75rem">{jobError}</div>{/if}

    {#if job}
      <div class="ld-job" style="margin-top:0.75rem">
        <div class="ld-job-head"><strong>{job.status === 'running' ? '⏳' : ''} Report {$activeTenant?.name}</strong>
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

    {#if fullReport}
      {#each Object.entries(fullReport.sections) as [id, sec]}
        <div class="rep-section-result">
          <div class="rep-section-title">{sec.ok ? '' : '⚠️ '}{sec.label}</div>
          {#if !sec.ok}
            <p class="ld-section-hint">Nicht abrufbar: {sec.error}</p>
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
          {/if}
        </div>
      {/each}
    {/if}
  </div>
{/if}
