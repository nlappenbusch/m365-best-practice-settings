<script>
  import { apiGet, errText } from '../lib/api.js'
  import { activeTenant } from '../lib/tenantStore.js'
  import { activeTab, goToTab } from '../lib/tabStore.js'
  import { session } from '../lib/session.js'
  import TenantContext from '../lib/TenantContext.svelte'
  import { ageLabel, fmtDateTime, latestByKind, rankEvents } from '../lib/product.js'

  let loading = $state(false)
  let error = $state(null)
  let archive = $state([])
  let changelog = $state(null)
  let maester = $state(null)
  let jobs = $state([])
  let loadedFor = $state(null)

  const tenantId = () => encodeURIComponent($activeTenant?.id || '')
  let latestChangeMeta = $derived(latestByKind(archive, 'changelog'))
  let latestHealth = $derived(latestByKind(archive, 'health'))
  let ranked = $derived(rankEvents(changelog?.data?.events || []))
  let attention = $derived(ranked.filter(x => ['critical', 'high'].includes(x.risk.level)).slice(0, 6))
  let runningJobs = $derived(jobs.filter(j => j.status === 'running'))
  let lastEvidence = $derived(archive[0] || null)

  async function load() {
    if (!$activeTenant || !$session.loggedIn || loading) return
    loading = true; error = null
    try {
      const [a, m, j] = await Promise.all([
        apiGet(`/api/tenants/${tenantId()}/evidence/archive`),
        apiGet(`/api/tenants/${tenantId()}/maester/latest`).catch(() => ({ maester: null })),
        apiGet('/api/appjobs').catch(() => ({ jobs: [] }))
      ])
      archive = a.entries || []
      maester = m.maester || null
      jobs = (j.jobs || []).filter(x => x.tenantId === $activeTenant.id)

      const cm = archive.find(x => x.kind === 'changelog')
      if (cm) {
        const c = await apiGet(`/api/tenants/${tenantId()}/evidence/archive/${encodeURIComponent(cm.id)}`)
        changelog = c.entry || null
      } else {
        changelog = null
      }
      loadedFor = $activeTenant.id
    } catch (e) {
      error = errText(e)
    }
    loading = false
  }

  $effect(() => {
    if ($activeTab !== 'overview' || !$session.loggedIn || !$activeTenant) return
    if (loadedFor === $activeTenant.id) return
    load()
  })

  function scoreTone(score) {
    if (score == null) return 'neutral'
    if (score >= 80) return 'ok'
    if (score >= 60) return 'warn'
    return 'crit'
  }

  function healthTone() {
    const s = latestHealth?.summary
    if (!s) return 'neutral'
    if ((s.degraded || 0) > 0 || (s.open || 0) > 0) return 'warn'
    return 'ok'
  }
</script>

<TenantContext>
  <div class="cc">
    <section class="cc-hero">
      <div>
        <div class="cc-eyebrow">CONTROL CENTER</div>
        <h2>{$activeTenant?.name}</h2>
        <p>Was braucht jetzt Aufmerksamkeit? Sicherheit, Änderungen, Evidence und laufende Automationen in einer Sicht.</p>
      </div>
      <button class="btn btn-secondary" onclick={load} disabled={loading}>{loading ? 'Lade…' : '↻ Aktualisieren'}</button>
    </section>

    {#if error}<div class="alert alert-warning">{error}</div>{/if}

    <section class="cc-metrics">
      <button class="cc-metric {scoreTone(maester?.score)}" onclick={() => goToTab('risks')}>
        <span class="cc-metric-label">Security</span>
        <strong>{maester?.score != null ? maester.score + '%' : '—'}</strong>
        <small>{maester?.counts?.failed != null ? maester.counts.failed + ' Findings' : 'noch kein Audit'}</small>
      </button>
      <button class="cc-metric {attention.length ? 'crit' : latestChangeMeta ? 'ok' : 'neutral'}" onclick={() => goToTab('changes')}>
        <span class="cc-metric-label">Changes</span>
        <strong>{changelog?.data?.summary?.events ?? '—'}</strong>
        <small>{attention.length ? attention.length + ' auffällig' : latestChangeMeta ? ageLabel(latestChangeMeta.createdAt) : 'noch nicht erhoben'}</small>
      </button>
      <button class="cc-metric {lastEvidence ? 'ok' : 'warn'}" onclick={() => goToTab('nachweise')}>
        <span class="cc-metric-label">Evidence</span>
        <strong>{archive.length}</strong>
        <small>{lastEvidence ? 'zuletzt ' + ageLabel(lastEvidence.createdAt) : 'Archiv leer'}</small>
      </button>
      <button class="cc-metric {runningJobs.length ? 'warn' : 'neutral'}" onclick={() => goToTab('automations')}>
        <span class="cc-metric-label">Automation</span>
        <strong>{runningJobs.length}</strong>
        <small>{runningJobs.length ? 'läuft gerade' : 'keine aktiven Jobs'}</small>
      </button>
      <button class="cc-metric {healthTone()}" onclick={() => goToTab('nachweise')}>
        <span class="cc-metric-label">M365 Service</span>
        <strong>{latestHealth?.summary?.degraded ?? '—'}</strong>
        <small>{latestHealth ? (latestHealth.summary?.open || 0) + ' offene Meldungen' : 'kein Health-Nachweis'}</small>
      </button>
    </section>

    <div class="cc-grid">
      <section class="cc-card cc-card-wide">
        <div class="cc-card-head">
          <div>
            <span class="cc-eyebrow">ATTENTION QUEUE</span>
            <h3>Änderungen mit erhöhtem Risiko</h3>
          </div>
          <button class="linklike" onclick={() => goToTab('changes')}>Alle Changes →</button>
        </div>

        {#if !latestChangeMeta}
          <div class="cc-empty">
            <strong>Noch kein Änderungsprotokoll.</strong>
            <span>Erhebe Entra- und Intune-Changes, damit hier automatisch priorisiert wird.</span>
            <button class="btn btn-primary" onclick={() => goToTab('changes')}>Changes erfassen</button>
          </div>
        {:else if attention.length === 0}
          <div class="cc-good">Keine kritischen oder hohen Änderungen im letzten archivierten Change-Lauf.</div>
        {:else}
          <div class="cc-list">
            {#each attention as ev}
              <button class="cc-row" onclick={() => goToTab('changes')}>
                <span class="cc-dot {ev.risk.level}"></span>
                <div class="cc-row-main">
                  <strong>{ev.activity || ev.operation || 'Änderung'}</strong>
                  <small>{ev.targets?.[0]?.name || ev.category || ev.source} · {ev.actor || 'unbekannter Akteur'}</small>
                </div>
                <div class="cc-row-side">
                  <span class="cc-risk {ev.risk.level}">{ev.risk.label}</span>
                  <small>{fmtDateTime(ev.at)}</small>
                </div>
              </button>
            {/each}
          </div>
        {/if}
      </section>

      <section class="cc-card">
        <div class="cc-card-head">
          <div>
            <span class="cc-eyebrow">ASSURANCE</span>
            <h3>Letzte Nachweise</h3>
          </div>
          <button class="linklike" onclick={() => goToTab('nachweise')}>Archiv →</button>
        </div>
        {#if archive.length}
          <div class="cc-stack">
            {#each archive.slice(0, 6) as e}
              <div class="cc-mini">
                <div><strong>{e.title}</strong><small>{e.kind} · {e.createdBy || 'System'}</small></div>
                <span>{ageLabel(e.createdAt)}</span>
              </div>
            {/each}
          </div>
        {:else}
          <div class="cc-empty compact">Noch keine Evidence archiviert.</div>
        {/if}
      </section>

      <section class="cc-card">
        <div class="cc-card-head">
          <div>
            <span class="cc-eyebrow">NEXT ACTIONS</span>
            <h3>Pragmatisch weiter</h3>
          </div>
        </div>
        <div class="cc-actions">
          <button onclick={() => goToTab('changes')}><strong>Changes prüfen</strong><span>24h Change-Lauf starten und priorisieren</span></button>
          <button onclick={() => goToTab('risks')}><strong>Risiken bearbeiten</strong><span>Maester Findings und kritische Changes</span></button>
          <button onclick={() => goToTab('automations')}><strong>Automationen</strong><span>Jobs, Semaphore und Execution Engine</span></button>
          <button onclick={() => goToTab('istzustand')}><strong>Kundendoku</strong><span>Ist-Zustand und Entscheide als PDF</span></button>
        </div>
      </section>
    </div>
  </div>
</TenantContext>

<style>
  .cc { display:flex; flex-direction:column; gap:1rem; }
  .cc-hero { display:flex; justify-content:space-between; gap:1rem; align-items:flex-start; padding:0.25rem 0 0.4rem; }
  .cc-hero h2 { font-size:1.65rem; margin:0.15rem 0 0.25rem; letter-spacing:-0.025em; }
  .cc-hero p { margin:0; color:var(--text-dim); max-width:72ch; line-height:1.5; }
  .cc-eyebrow { font-size:0.68rem; letter-spacing:0.12em; color:var(--text-faint); font-weight:800; }
  .cc-metrics { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:0.7rem; }
  .cc-metric { text-align:left; border:1px solid var(--rule); background:var(--bg-raised); border-radius:var(--radius-lg); padding:0.85rem 0.95rem; cursor:pointer; color:var(--text); box-shadow:var(--shadow-sm); }
  .cc-metric:hover { border-color:var(--accent); transform:translateY(-1px); }
  .cc-metric strong { display:block; font-size:1.45rem; margin:0.25rem 0 0.1rem; }
  .cc-metric small { display:block; color:var(--text-dim); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .cc-metric-label { font-size:0.72rem; font-weight:800; color:var(--text-dim); }
  .cc-metric.ok { border-top:3px solid var(--ok); }
  .cc-metric.warn { border-top:3px solid var(--warn); }
  .cc-metric.crit { border-top:3px solid var(--crit); }
  .cc-metric.neutral { border-top:3px solid var(--rule); }
  .cc-grid { display:grid; grid-template-columns:minmax(0,1.55fr) minmax(280px,0.8fr); gap:0.85rem; }
  .cc-card { border:1px solid var(--rule); border-radius:var(--radius-lg); padding:1rem; background:var(--bg-raised); box-shadow:var(--shadow-sm); min-width:0; }
  .cc-card-wide { grid-row:span 2; }
  .cc-card-head { display:flex; align-items:flex-start; justify-content:space-between; gap:1rem; margin-bottom:0.75rem; }
  .cc-card h3 { margin:0.1rem 0 0; font-size:1rem; }
  .cc-list { display:flex; flex-direction:column; }
  .cc-row { width:100%; display:flex; gap:0.7rem; align-items:center; border:0; border-top:1px solid var(--rule); background:transparent; padding:0.7rem 0.15rem; color:inherit; text-align:left; cursor:pointer; }
  .cc-row:first-child { border-top:0; }
  .cc-row:hover { background:var(--bg-inset); }
  .cc-dot { width:8px; height:8px; border-radius:999px; flex:0 0 auto; }
  .cc-dot.critical { background:var(--crit); }
  .cc-dot.high { background:var(--warn); }
  .cc-dot.medium { background:var(--accent); }
  .cc-row-main { flex:1; min-width:0; }
  .cc-row-main strong,.cc-row-main small { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .cc-row-main small,.cc-row-side small { color:var(--text-dim); font-size:0.74rem; margin-top:0.15rem; }
  .cc-row-side { text-align:right; flex:0 0 auto; }
  .cc-risk { font-size:0.68rem; padding:0.15rem 0.45rem; border-radius:999px; font-weight:800; }
  .cc-risk.critical { color:var(--crit); background:var(--crit-wash); }
  .cc-risk.high { color:var(--warn); background:var(--warn-wash); }
  .cc-stack { display:flex; flex-direction:column; gap:0.55rem; }
  .cc-mini { display:flex; justify-content:space-between; align-items:flex-start; gap:0.8rem; padding-bottom:0.55rem; border-bottom:1px solid var(--rule); font-size:0.82rem; }
  .cc-mini:last-child { border-bottom:0; padding-bottom:0; }
  .cc-mini strong,.cc-mini small { display:block; }
  .cc-mini small,.cc-mini > span { color:var(--text-dim); font-size:0.72rem; }
  .cc-mini > span { white-space:nowrap; }
  .cc-actions { display:grid; grid-template-columns:1fr 1fr; gap:0.5rem; }
  .cc-actions button { border:1px solid var(--rule); background:var(--bg-inset); border-radius:var(--radius-md); padding:0.7rem; text-align:left; color:inherit; cursor:pointer; }
  .cc-actions button:hover { border-color:var(--accent); }
  .cc-actions strong,.cc-actions span { display:block; }
  .cc-actions span { color:var(--text-dim); font-size:0.74rem; margin-top:0.15rem; line-height:1.35; }
  .cc-empty { display:flex; flex-direction:column; align-items:flex-start; gap:0.45rem; padding:1.1rem; border:1px dashed var(--rule); border-radius:var(--radius-md); color:var(--text-dim); }
  .cc-empty strong { color:var(--text); }
  .cc-empty.compact { padding:0.8rem; }
  .cc-good { padding:0.8rem; border-radius:var(--radius-md); background:var(--ok-wash); color:var(--ok); font-weight:600; }
  @media (max-width:1100px) { .cc-metrics{grid-template-columns:repeat(3,1fr)} .cc-grid{grid-template-columns:1fr} .cc-card-wide{grid-row:auto} }
  @media (max-width:700px) { .cc-metrics{grid-template-columns:1fr 1fr} .cc-actions{grid-template-columns:1fr} .cc-hero{flex-direction:column} }
</style>
