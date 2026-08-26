<script>
  // Maester-Security-Audit (maester.dev): CISA-/CIS-/EIDSCA-/Community-Tests
  // rein lesend app-only gegen den Tenant. Die Übersicht liest wie bei den
  // Reports nur gespeicherte Ergebnisse — Läufe dauern mehrere Minuten.
  import { onDestroy } from 'svelte'
  import { apiGet, apiPost } from '../lib/api.js'
  import { activeTenant } from '../lib/tenantStore.js'
  import { session } from '../lib/session.js'

  let overview = $state([])
  let overviewLoading = $state(false)
  let loaded = $state(false)

  let job = $state(null)
  let jobError = $state(null)
  let jobTimer = null

  let latest = $state(null)
  let runs = $state([])
  let showAllFailed = $state(false)

  async function load() {
    overviewLoading = true
    try {
      const o = await apiGet('/api/maester/overview')
      overview = o.tenants || []
    } catch (e) { /* Anzeige bleibt leer */ }
    overviewLoading = false
    loaded = true
  }

  async function loadTenant(tid) {
    latest = null; runs = []; showAllFailed = false
    if (!tid) return
    try {
      const [l, r] = await Promise.all([
        apiGet(`/api/tenants/${encodeURIComponent(tid)}/maester/latest`),
        apiGet(`/api/tenants/${encodeURIComponent(tid)}/maester/runs`)
      ])
      latest = l.maester || null
      runs = r.runs || []
    } catch (e) { /* kein Stand vorhanden */ }
  }

  $effect(() => {
    if ($session.loggedIn && !loaded && !overviewLoading) load()
  })
  $effect(() => { if ($session.loggedIn) loadTenant($activeTenant?.id) })

  async function runAudit() {
    if (!$activeTenant) return
    jobError = null
    job = null
    try {
      const start = await apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/maester/run`)
      pollJob(start.jobId)
    } catch (e) {
      jobError = e.message + (e.hint ? ' — ' + e.hint : '')
    }
  }

  function pollJob(jobId) {
    jobTimer = setTimeout(async () => {
      let j
      try { j = await apiGet(`/api/appjobs/${encodeURIComponent(jobId)}`) }
      catch (e) { jobError = 'Fortschritt nicht abrufbar: ' + e.message; return }
      job = j
      if (j.status === 'running') { pollJob(jobId); return }
      await Promise.all([load(), loadTenant($activeTenant?.id)])
    }, 2500)
  }

  function openReport(runId) {
    if (!$activeTenant || !runId) return
    window.open(`/api/tenants/${encodeURIComponent($activeTenant.id)}/maester/runs/${encodeURIComponent(runId)}/report.html`, '_blank')
  }

  // Schweregrade der gefallenen Tests gruppieren — Kritisches zuerst.
  const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
  const sevRank = (s) => SEV_ORDER[String(s || '').toLowerCase()] ?? 5
  let failedSorted = $derived(
    latest ? [...(latest.failed || [])].sort((a, b) => sevRank(a.severity) - sevRank(b.severity)) : []
  )
  let failedShown = $derived(showAllFailed ? failedSorted : failedSorted.slice(0, 20))

  const scoreState = (sc) => sc == null ? '' : sc >= 80 ? 'ok' : sc >= 60 ? 'warn' : 'crit'
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
    <h4>Security-Score über alle Tenants</h4>
    <p class="ld-section-hint">Stand der zuletzt gelaufenen Maester-Audits — nichts wird live abgefragt.
      Score = bestandene Tests im Verhältnis zu allen bewerteten (Skips zählen nicht).</p>

    {#if overviewLoading}
      <p class="ld-section-hint">Lade…</p>
    {:else if overview.length === 0}
      <p class="ld-section-hint">Keine Tenants vorhanden.</p>
    {:else}
      <div class="rep-grid">
        {#each overview as row (row.id)}
          <div class="rep-card" class:crit={scoreState(row.score) === 'crit'} class:warn={scoreState(row.score) === 'warn'}>
            <div class="rep-card-head">
              <strong>{row.name}</strong>
              <span class="rep-age">{row.generatedAt ? age(row.generatedAt) : 'noch kein Audit'}</span>
            </div>
            {#if row.counts}
              <div class="rep-counts">
                <span class="rep-count {scoreState(row.score)}">{row.score != null ? row.score + '% Score' : '—'}</span>
                <span class="rep-count crit">{row.counts.failed} gefallen</span>
                <span class="rep-count ok">{row.counts.passed} bestanden</span>
              </div>
              {#if row.failedTop?.length}
                <ul class="rep-findings">
                  {#each row.failedTop as f}
                    <li>❌ {f.title || f.id}{f.severity ? ` (${f.severity})` : ''}</li>
                  {/each}
                </ul>
              {/if}
            {:else}
              <p class="ld-section-hint" style="margin:0.3rem 0 0">Noch nie geprüft.</p>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>

  <div class="settings-group" style="margin-top:1.25rem">
    <h4>Audit ausführen{$activeTenant ? ` — ${$activeTenant.name}` : ''}</h4>
    {#if !$activeTenant}
      <p class="ld-section-hint">Oben rechts einen Tenant wählen.</p>
    {:else}
      <p class="ld-section-hint">Führt die komplette Maester-Testsuite (CISA SCuBA, CIS M365, EIDSCA, ORCA,
        Community) rein lesend aus — es wird nichts verändert. Dauert je nach Tenant 5–20 Minuten.
        Voraussetzung: die Maester-Leseberechtigungen (bestehende Tenants einmal im Tab «Tenants» reparieren).</p>
      <div style="display:flex; gap:0.5rem; margin-top:0.5rem; flex-wrap:wrap">
        <button class="btn btn-primary" onclick={runAudit} disabled={job?.status === 'running'}>
          {job?.status === 'running' ? 'Läuft…' : '▶ Maester-Audit starten'}
        </button>
        {#if latest?.htmlAvailable && latest?.runId}
          <button class="btn btn-secondary" onclick={() => openReport(latest.runId)}>Interaktiven HTML-Report öffnen</button>
        {/if}
      </div>
    {/if}

    {#if jobError}<div class="ld-banner fail" style="margin-top:0.75rem">{jobError}</div>{/if}

    {#if job}
      <div class="ld-job" style="margin-top:0.75rem">
        <div class="ld-job-head"><strong>{job.status === 'running' ? '⏳' : ''} Maester-Audit {$activeTenant?.name}</strong>
          <span class="ld-job-meta">{job.phase}</span></div>
        {#if job.status === 'done'}
          <div class="ld-banner ok">Fertig.{job.hint ? ' ' + job.hint : ''}</div>
        {:else if job.status === 'failed'}
          <div class="ld-banner fail">{job.error}{job.hint ? ' — ' + job.hint : ''}</div>
        {/if}
        {#each job.steps as s}
          <div class="ld-step {s.state === 'failed' ? 'fail' : 'ok'}">
            <span class="ld-ico">{s.state === 'done' ? '✅' : s.state === 'failed' ? '❌' : s.state === 'running' ? '⏳' : '○'}</span> {s.name}
          </div>
        {/each}
      </div>
    {/if}

    {#if latest}
      <div class="rep-section-result">
        <div class="rep-section-title">Letztes Ergebnis <small>({age(latest.generatedAt)}{latest.maesterVersion ? ` · Maester ${latest.maesterVersion}` : ''})</small></div>
        <div class="rep-metrics">
          <div class="rep-metric {scoreState(latest.score)}">
            <div class="rep-metric-value">{latest.score != null ? latest.score + '%' : '—'}</div>
            <div class="rep-metric-label">Security-Score</div>
          </div>
          <div class="rep-metric ok">
            <div class="rep-metric-value">{latest.counts?.passed ?? '—'}</div>
            <div class="rep-metric-label">✅ Bestanden</div>
          </div>
          <div class="rep-metric {latest.counts?.failed ? 'crit' : 'ok'}">
            <div class="rep-metric-value">{latest.counts?.failed ?? '—'}</div>
            <div class="rep-metric-label">❌ Gefallen</div>
          </div>
          <div class="rep-metric">
            <div class="rep-metric-value">{latest.counts?.skipped ?? '—'}</div>
            <div class="rep-metric-label">⏭️ Übersprungen</div>
            {#if !latest.exoConnected}<div class="rep-metric-detail">EXO nicht verbunden — EXO-Tests fehlen</div>{/if}
          </div>
        </div>

        {#if failedSorted.length}
          <table class="gt-table" style="margin-top:0.75rem">
            <thead><tr><th>Schweregrad</th><th>Test</th><th>Bereich</th><th></th></tr></thead>
            <tbody>
              {#each failedShown as f}
                <tr>
                  <td>{f.severity || '—'}</td>
                  <td>{f.title || f.id}</td>
                  <td>{f.block || '—'}</td>
                  <td>{#if f.helpUrl}<a href={f.helpUrl} target="_blank" rel="noreferrer">Doku ↗</a>{/if}</td>
                </tr>
              {/each}
            </tbody>
          </table>
          {#if failedSorted.length > 20}
            <button class="linklike" style="margin-top:0.4rem" onclick={() => (showAllFailed = !showAllFailed)}>
              {showAllFailed ? '▾ Nur die ersten 20 zeigen' : `▸ Alle ${failedSorted.length} gefallenen Tests zeigen`}
            </button>
          {/if}
        {:else}
          <p class="ld-section-hint" style="margin-top:0.5rem">Kein Test gefallen. 🎉</p>
        {/if}
      </div>

      {#if runs.length > 1}
        <div class="rep-section-result">
          <div class="rep-section-title">Verlauf</div>
          <table class="gt-table">
            <thead><tr><th>Zeitpunkt</th><th>Score</th><th>Bestanden</th><th>Gefallen</th><th></th></tr></thead>
            <tbody>
              {#each runs as r (r.runId)}
                <tr>
                  <td>{r.generatedAt ? r.generatedAt.slice(0, 16).replace('T', ' ') : r.runId}</td>
                  <td>{r.score != null ? r.score + '%' : '—'}</td>
                  <td>{r.counts?.passed ?? '—'}</td>
                  <td>{r.counts?.failed ?? '—'}</td>
                  <td>{#if r.htmlAvailable}<button class="linklike" onclick={() => openReport(r.runId)}>Report ↗</button>{/if}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    {/if}
  </div>
{/if}
