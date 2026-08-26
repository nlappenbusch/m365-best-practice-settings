<script>
  // Maester-Security-Audit (maester.dev): CISA-/CIS-/EIDSCA-/Community-Tests
  // rein lesend app-only gegen den Tenant. Die Übersicht liest wie bei den
  // Reports nur gespeicherte Ergebnisse — Läufe dauern mehrere Minuten.
  import { onDestroy } from 'svelte'
  import { apiGet, apiPost, apiPut } from '../lib/api.js'
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

  // Suiten-Auswahl: alle an = komplette Testsuite (inkl. nicht getaggter Tests),
  // Teilmenge = Tag-Filter im Backend. Tags sind die offiziellen Maester-Tags.
  const SUITES = [
    { tag: 'CISA', label: 'CISA SCuBA', desc: 'US-Behörden-Baseline (SCuBA) für M365' },
    { tag: 'CIS', label: 'CIS Microsoft 365', desc: 'CIS-Benchmark' },
    { tag: 'EIDSCA', label: 'EIDSCA', desc: 'Entra ID Security Config Analyzer' },
    { tag: 'ORCA', label: 'ORCA', desc: 'Exchange-Online-Mailschutz' },
    { tag: 'Maester', label: 'Maester Community', desc: 'Community-Tests des Maester-Projekts' }
  ]
  let suiteChosen = $state(Object.fromEntries(SUITES.map(s => [s.tag, true])))

  // Zeitplan: serverseitig, Browser muss nicht offen sein.
  const INTERVALS = [
    { key: 'daily', label: 'täglich' },
    { key: 'weekly', label: 'wöchentlich' },
    { key: 'biweekly', label: 'alle 2 Wochen' },
    { key: 'monthly', label: 'monatlich' }
  ]
  const intervalLabel = (k) => INTERVALS.find(i => i.key === k)?.label || k
  let schedEnabled = $state(false)
  let schedInterval = $state('weekly')
  let schedSaved = $state(null)     // { ok, msg }
  let schedBusy = $state(false)

  // Testsuite-Stand (Maester-Version, letzte Aktualisierung)
  let suite = $state(null)
  let suiteBusy = $state(false)
  let suiteMsg = $state(null)
  let suiteTimer = null

  async function load() {
    overviewLoading = true
    try {
      const [o, su] = await Promise.all([apiGet('/api/maester/overview'), apiGet('/api/maester/suite')])
      overview = o.tenants || []
      suite = su.suite || null
    } catch (e) { /* Anzeige bleibt leer */ }
    overviewLoading = false
    loaded = true
  }

  async function updateSuite() {
    suiteBusy = true; suiteMsg = null
    try {
      const start = await apiPost('/api/maester/suite/update')
      pollSuiteJob(start.jobId)
    } catch (e) { suiteMsg = { ok: false, msg: e.message }; suiteBusy = false }
  }

  function pollSuiteJob(id) {
    suiteTimer = setTimeout(async () => {
      let j
      try { j = await apiGet(`/api/appjobs/${encodeURIComponent(id)}`) }
      catch (e) { suiteMsg = { ok: false, msg: e.message }; suiteBusy = false; return }
      if (j.status === 'running') { pollSuiteJob(id); return }
      suiteBusy = false
      suiteMsg = j.status === 'done' ? { ok: true, msg: j.hint || 'Aktualisiert.' } : { ok: false, msg: j.error || 'Fehlgeschlagen.' }
      load()
    }, 2000)
  }

  async function loadTenant(tid) {
    latest = null; runs = []; showAllFailed = false
    schedEnabled = false; schedInterval = 'weekly'; schedSaved = null
    if (!tid) return
    try {
      const [l, r, a, sc] = await Promise.all([
        apiGet(`/api/tenants/${encodeURIComponent(tid)}/maester/latest`),
        apiGet(`/api/tenants/${encodeURIComponent(tid)}/maester/runs`),
        apiGet(`/api/tenants/${encodeURIComponent(tid)}/maester/active`),
        apiGet(`/api/tenants/${encodeURIComponent(tid)}/maester/schedule`)
      ])
      latest = l.maester || null
      runs = r.runs || []
      if (sc.schedule) {
        schedEnabled = !!sc.schedule.enabled
        schedInterval = sc.schedule.interval || 'weekly'
        if (sc.schedule.suites?.length) {
          for (const s of SUITES) suiteChosen[s.tag] = sc.schedule.suites.includes(s.tag)
        }
      }
      // Laeuft fuer diesen Tenant schon ein Job (anderes Fenster, Reload,
      // MCP-Start), Fortschritt wieder aufnehmen statt spaeter in den 409 zu laufen.
      if (a.jobId && (!job || job.status !== 'running')) pollJob(a.jobId)
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
    const picked = SUITES.filter(s => suiteChosen[s.tag]).map(s => s.tag)
    if (!picked.length) { jobError = 'Mindestens eine Testsuite wählen.'; return }
    try {
      const start = await apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/maester/run`, { suites: picked })
      pollJob(start.jobId)
    } catch (e) {
      if (e.status === 409) {
        // Es laeuft schon ein Job fuer diesen Tenant — dranhaengen statt meckern.
        try { const a = await apiGet(`/api/tenants/${encodeURIComponent($activeTenant.id)}/maester/active`); if (a.jobId) { pollJob(a.jobId); return } } catch {}
      }
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
    }, 1500)
  }

  async function saveSchedule() {
    if (!$activeTenant) return
    schedBusy = true; schedSaved = null
    const picked = SUITES.filter(s => suiteChosen[s.tag]).map(s => s.tag)
    try {
      await apiPut(`/api/tenants/${encodeURIComponent($activeTenant.id)}/maester/schedule`, {
        enabled: schedEnabled, interval: schedInterval, suites: picked
      })
      schedSaved = { ok: true, msg: schedEnabled ? `Gespeichert — läuft ${intervalLabel(schedInterval)} automatisch.` : 'Gespeichert — Automatik aus.' }
      load()
    } catch (e) { schedSaved = { ok: false, msg: e.message } }
    schedBusy = false
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

  onDestroy(() => { if (jobTimer) clearTimeout(jobTimer); if (suiteTimer) clearTimeout(suiteTimer) })
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
            {#if row.schedule}
              <div class="ld-section-hint" style="margin:0.15rem 0 0">⏰ automatisch {intervalLabel(row.schedule.interval)}{row.schedule.lastResult && row.schedule.lastResult !== 'ok' ? ` · ⚠️ letzter Lauf: ${row.schedule.lastResult}` : ''}</div>
            {/if}
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
    <h4>🧪 Testsuite</h4>
    <p class="ld-section-hint">Die Testszenarien stecken im Maester-Modul und werden <strong>einmal täglich
      automatisch aktualisiert</strong> (neue Modulversion von der PSGallery, Tests frisch extrahiert). Hier lässt
      sich das sofort anstossen.</p>
    <div style="display:flex; gap:0.75rem; align-items:center; flex-wrap:wrap">
      {#if suite}
        <span>Maester <strong>{suite.version || '—'}</strong> · Tests: {suite.source}{suite.updatedAt ? `, Stand ${suite.updatedAt.slice(0, 16).replace('T', ' ')}` : ''}{suite.checkedAt ? ` · zuletzt geprüft ${age(suite.checkedAt)}` : ''}</span>
      {/if}
      <button class="btn btn-secondary" onclick={updateSuite} disabled={suiteBusy || suite?.refreshing}>
        {suiteBusy || suite?.refreshing ? 'Aktualisiert…' : 'Jetzt aktualisieren'}
      </button>
      {#if suiteMsg}<span class={suiteMsg.ok ? '' : 'ld-banner fail'}>{suiteMsg.ok ? '✅ ' : ''}{suiteMsg.msg}</span>{/if}
      {#if suite?.error && !suiteMsg}<span class="ld-banner fail">Letzte Auto-Prüfung: {suite.error}</span>{/if}
    </div>
  </div>

  <div class="settings-group" style="margin-top:1.25rem">
    <h4>Audit ausführen{$activeTenant ? ` — ${$activeTenant.name}` : ''}</h4>
    {#if !$activeTenant}
      <p class="ld-section-hint">Oben rechts einen Tenant wählen.</p>
    {:else}
      <p class="ld-section-hint">Führt die Maester-Testsuite rein lesend aus — es wird nichts verändert.
        Dauert je nach Tenant und Auswahl 5–20 Minuten. Voraussetzung: die Maester-Leseberechtigungen
        (bestehende Tenants einmal im Tab «Tenants» reparieren — fehlt das, bricht der Lauf mit Hinweis ab).</p>
      <div class="checkbox-grid">
        {#each SUITES as s (s.tag)}
          <label class="rep-section">
            <input type="checkbox" bind:checked={suiteChosen[s.tag]} />
            <span><strong>{s.label}</strong><br /><small>{s.desc}</small></span>
          </label>
        {/each}
      </div>
      <div style="display:flex; gap:0.5rem; margin-top:0.75rem; flex-wrap:wrap">
        <button class="btn btn-primary" onclick={runAudit} disabled={job?.status === 'running'}>
          {job?.status === 'running' ? 'Läuft…' : '▶ Maester-Audit starten'}
        </button>
        {#if latest?.htmlAvailable && latest?.runId}
          <button class="btn btn-secondary" onclick={() => openReport(latest.runId)}>Interaktiven HTML-Report öffnen</button>
        {/if}
      </div>

      <div class="settings-group" style="margin-top:1rem">
        <h4>⏰ Automatisch ausführen</h4>
        <p class="ld-section-hint">Läuft serverseitig — der Browser muss nicht offen sein. Verwendet die oben
          gewählten Suiten. Es läuft immer nur ein Audit gleichzeitig; sind mehrere Tenants fällig, kommen sie
          nacheinander dran. Schlägt ein automatischer Lauf fehl, steht das an der Tenant-Karte oben.</p>
        <div style="display:flex; gap:0.75rem; align-items:center; flex-wrap:wrap">
          <label style="display:flex; gap:0.4rem; align-items:center">
            <input type="checkbox" bind:checked={schedEnabled} />
            <span>Automatik an</span>
          </label>
          <select bind:value={schedInterval} disabled={!schedEnabled}>
            {#each INTERVALS as i}<option value={i.key}>{i.label}</option>{/each}
          </select>
          <button class="btn btn-secondary" onclick={saveSchedule} disabled={schedBusy}>Speichern</button>
          {#if schedSaved}<span class={schedSaved.ok ? '' : 'ld-banner fail'}>{schedSaved.ok ? '✅ ' : ''}{schedSaved.msg}</span>{/if}
        </div>
      </div>
    {/if}

    {#if jobError}<div class="ld-banner fail" style="margin-top:0.75rem">{jobError}</div>{/if}

    {#if job}
      <div class="ld-job" style="margin-top:0.75rem">
        <div class="ld-job-head"><strong>{job.status === 'running' ? '⏳' : ''} Maester-Audit {job.tenantName || $activeTenant?.name}</strong>
          <span class="ld-job-meta">{job.phase}</span></div>
        {#if job.status === 'done'}
          <div class="ld-banner ok">Fertig.{job.hint ? ' ' + job.hint : ''}</div>
        {:else if job.status === 'failed'}
          <div class="ld-banner fail">{job.error}{job.hint ? ' — ' + job.hint : ''}</div>
        {/if}
        {#each job.steps as s}
          <div class="ld-step {s.state === 'failed' ? 'fail' : 'ok'}">
            <span class="ld-ico">{s.state === 'done' ? '✅' : s.state === 'failed' ? '❌' : s.state === 'running' ? '⏳' : '○'}</span> {s.name}
            {#if s.detail}<small style="opacity:0.75"> — {s.detail}</small>{/if}
          </div>
          {#if s.state === 'running' && job.live}
            <div class="ld-step" style="padding-left:1.6rem; opacity:0.85">
              <small>
                {#if job.live.block}<strong>{job.live.block}</strong>{/if}
                {#if job.live.test} · {job.live.test}{/if}
                <br />✅ {job.live.passed} bestanden · ❌ {job.live.failed} gefallen · ⏭️ {job.live.skipped} übersprungen
              </small>
            </div>
          {/if}
        {/each}
      </div>
    {/if}

    {#if latest}
      <div class="rep-section-result">
        <div class="rep-section-title">Letztes Ergebnis <small>({age(latest.generatedAt)}{latest.maesterVersion ? ` · Maester ${latest.maesterVersion}` : ''}{latest.suites?.length ? ` · Suiten: ${latest.suites.join(', ')}` : ' · alle Suiten'})</small></div>
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
