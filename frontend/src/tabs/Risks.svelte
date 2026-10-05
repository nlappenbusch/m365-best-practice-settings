<script>
  import { apiGet, errText } from '../lib/api.js'
  import { activeTenant } from '../lib/tenantStore.js'
  import { activeTab, goToTab } from '../lib/tabStore.js'
  import { session } from '../lib/session.js'
  import TenantContext from '../lib/TenantContext.svelte'
  import { fmtDateTime, ageLabel } from '../lib/product.js'

  let loading = $state(false)
  let error = $state(null)
  let maester = $state(null)
  let events = $state([])
  let stats = $state(null)
  let loadedFor = $state(null)
  let severity = $state('all')

  const tid = () => encodeURIComponent($activeTenant?.id || '')
  const sevScore = s => ({ critical:96, high:84, medium:62, low:35, info:10 }[String(s || '').toLowerCase()] ?? 50)

  let findings = $derived((maester?.failed || []).map(f => ({
    kind: 'finding',
    id: f.id,
    level: String(f.severity || 'medium').toLowerCase(),
    score: sevScore(f.severity),
    title: f.title || f.id,
    detail: f.block || 'Security-Audit',
    helpUrl: f.helpUrl || null
  })))

  let changes = $derived(events
    .filter(e => ['critical','high','medium'].includes(e.analysis?.risk?.level))
    .map(e => ({
      kind: 'change',
      id: e.eventId,
      level: e.analysis?.risk?.level || 'info',
      score: e.analysis?.risk?.score || 10,
      title: e.activity || e.operation || 'Änderung',
      detail: [
        e.analysis?.resource?.name || e.targets?.[0]?.name || e.category || e.source,
        e.actor || 'unbekannt'
      ].filter(Boolean).join(' · '),
      at: e.occurredAt,
      baseline: e.analysis?.baseline || null,
      impact: e.analysis?.impact || null,
      ticket: e.analysis?.ticket || null,
      remediation: e.analysis?.remediation || null
    })))

  let queue = $derived([...findings, ...changes]
    .filter(x => severity === 'all' || x.level === severity)
    .sort((a,b) => b.score - a.score))

  let criticalCount = $derived([...findings,...changes].filter(x => x.level === 'critical').length)
  let highCount = $derived([...findings,...changes].filter(x => x.level === 'high').length)

  async function load() {
    if (!$activeTenant || !$session.loggedIn || loading) return
    loading = true; error = null
    try {
      const [m, ev] = await Promise.all([
        apiGet(`/api/tenants/${tid()}/maester/latest`).catch(() => ({maester:null})),
        apiGet(`/api/tenants/${tid()}/evidence/v3/events?days=30&limit=1000`)
      ])
      maester = m.maester || null
      events = ev.events || []
      stats = ev.stats || null
      loadedFor = $activeTenant.id
    } catch (e) { error = errText(e) }
    loading = false
  }

  $effect(() => {
    if ($activeTab !== 'risks' || !$session.loggedIn || !$activeTenant) return
    if (loadedFor === $activeTenant.id) return
    maester = null; events = []; stats = null; loadedFor = null
    load()
  })
</script>

<TenantContext>
  <div class="rq">
    <div class="rq-head">
      <div>
        <div class="rq-eyebrow">UNIFIED RISK QUEUE</div>
        <h2>Was sollte als Nächstes bearbeitet werden?</h2>
        <p>Security-Findings und Evidence-3.0-Changes in einer priorisierten Arbeitsliste.</p>
      </div>
      <button class="btn btn-secondary" onclick={load} disabled={loading}>{loading ? 'Lade…' : '↻ Aktualisieren'}</button>
    </div>

    {#if error}<div class="alert alert-warning">{error}</div>{/if}

    <div class="rq-summary">
      <button class="crit" onclick={() => severity='critical'}><strong>{criticalCount}</strong><span>kritisch</span></button>
      <button class="high" onclick={() => severity='high'}><strong>{highCount}</strong><span>hoch</span></button>
      <button onclick={() => goToTab('maester')}><strong>{maester?.counts?.failed ?? '—'}</strong><span>Maester-Findings</span></button>
      <button onclick={() => goToTab('changes')}><strong>{changes.length}</strong><span>riskante Changes</span></button>
      <button class="score" onclick={() => goToTab('maester')}><strong>{maester?.score != null ? maester.score + '%' : '—'}</strong><span>Security-Score</span></button>
    </div>

    <div class="rq-toolbar">
      <div class="rq-filters">
        <button class:active={severity==='all'} onclick={() => severity='all'}>Alle</button>
        <button class:active={severity==='critical'} onclick={() => severity='critical'}>Critical</button>
        <button class:active={severity==='high'} onclick={() => severity='high'}>High</button>
        <button class:active={severity==='medium'} onclick={() => severity='medium'}>Medium</button>
      </div>
      <div class="rq-fresh">
        Audit: {maester?.generatedAt ? ageLabel(maester.generatedAt) : 'noch nie'} · Evidence 3.0: {stats?.lastEventIngestAt ? ageLabel(stats.lastEventIngestAt) : 'noch nie'}
      </div>
    </div>

    {#if queue.length}
      <div class="rq-list">
        {#each queue as item}
          <article class="rq-item {item.level}">
            <div class="rq-rank">{item.score}</div>
            <div class="rq-body">
              <div class="rq-title">
                <span class="rq-badge {item.level}">{item.level}</span>
                <strong>{item.title}</strong>
              </div>
              <div class="rq-detail">{item.detail}{item.at ? ' · ' + fmtDateTime(item.at) : ''}</div>

              {#if item.kind === 'change'}
                <div class="rq-intel">
                  {#if item.baseline}
                    <span class:bad={item.baseline.compliant === false}>
                      Baseline {item.baseline.version || '—'}: {item.baseline.compliant ? 'ok' : 'Abweichung'}
                    </span>
                  {/if}
                  {#if item.impact?.users != null}<span>{item.impact.users} Benutzer betroffen</span>{/if}
                  <span class:bad={item.ticket && !item.ticket.found}>
                    {item.ticket?.found ? 'Ref: ' + item.ticket.refs.join(', ') : 'keine Change-/Ticket-Referenz'}
                  </span>
                </div>
                {#if item.remediation?.suggestedAction}
                  <div class="rq-rem"><strong>Plan:</strong> {item.remediation.suggestedAction}</div>
                {/if}
              {/if}
            </div>

            <div class="rq-actions">
              {#if item.kind === 'finding'}
                <button class="btn btn-secondary" onclick={() => goToTab('maester')}>Audit öffnen</button>
                {#if item.helpUrl}<a href={item.helpUrl} target="_blank" rel="noreferrer">Doku ↗</a>{/if}
              {:else}
                <button class="btn btn-secondary" onclick={() => goToTab('changes')}>Change öffnen</button>
                <button class="linklike" onclick={() => goToTab('nachweise')}>Evidence</button>
              {/if}
            </div>
          </article>
        {/each}
      </div>
    {:else if !loading}
      <div class="rq-empty">
        <strong>Keine Risiken in dieser Ansicht.</strong>
        <span>Falls noch keine Daten vorhanden sind, zuerst Security-Audit oder Change-Evidence erheben.</span>
        <div><button class="btn btn-primary" onclick={() => goToTab('maester')}>Security-Audit</button> <button class="btn btn-secondary" onclick={() => goToTab('changes')}>Changes</button></div>
      </div>
    {/if}
  </div>
</TenantContext>

<style>
  .rq{display:flex;flex-direction:column;gap:.9rem}
  .rq-head{display:flex;justify-content:space-between;align-items:flex-start;gap:1rem}
  .rq-head h2{margin:.15rem 0 .25rem;font-size:1.45rem;letter-spacing:-.02em}.rq-head p{margin:0;color:var(--text-dim)}
  .rq-eyebrow{font-size:.68rem;letter-spacing:.12em;color:var(--text-faint);font-weight:800}
  .rq-summary{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:.6rem}
  .rq-summary button{border:1px solid var(--rule);border-radius:var(--radius-md);background:var(--bg-raised);padding:.72rem .82rem;text-align:left;color:inherit;cursor:pointer}
  .rq-summary button:hover{border-color:var(--accent)}.rq-summary strong,.rq-summary span{display:block}.rq-summary strong{font-size:1.25rem}.rq-summary span{font-size:.72rem;color:var(--text-dim);margin-top:.1rem}
  .rq-summary .crit{border-top:3px solid var(--crit)}.rq-summary .high{border-top:3px solid var(--warn)}.rq-summary .score{border-top:3px solid var(--accent)}
  .rq-toolbar{display:flex;justify-content:space-between;align-items:center;gap:.8rem;border-bottom:1px solid var(--rule);padding-bottom:.65rem}
  .rq-filters{display:flex;gap:.3rem;flex-wrap:wrap}.rq-filters button{border:1px solid var(--rule);background:var(--bg-inset);color:var(--text-dim);border-radius:999px;padding:.28rem .7rem;font:inherit;font-size:.78rem;font-weight:700;cursor:pointer}.rq-filters button.active{background:var(--accent);border-color:var(--accent);color:white}
  .rq-fresh{font-size:.72rem;color:var(--text-faint)}
  .rq-list{display:flex;flex-direction:column;gap:.55rem}.rq-item{display:grid;grid-template-columns:46px minmax(0,1fr) auto;gap:.75rem;align-items:center;border:1px solid var(--rule);border-left-width:4px;border-radius:var(--radius-lg);background:var(--bg-raised);padding:.72rem .8rem}
  .rq-item.critical{border-left-color:var(--crit)}.rq-item.high{border-left-color:var(--warn)}.rq-item.medium{border-left-color:var(--accent)}
  .rq-rank{font-family:var(--font-mono);font-size:.82rem;color:var(--text-faint);text-align:center}
  .rq-title{display:flex;gap:.45rem;align-items:center}.rq-detail{font-size:.74rem;color:var(--text-dim);margin-top:.18rem}
  .rq-badge{font-size:.62rem;text-transform:uppercase;font-weight:900;letter-spacing:.04em;padding:.14rem .38rem;border-radius:999px}.rq-badge.critical{background:var(--crit-wash);color:var(--crit)}.rq-badge.high{background:var(--warn-wash);color:var(--warn)}.rq-badge.medium{background:var(--accent-wash);color:var(--accent)}
  .rq-intel{display:flex;gap:.4rem;flex-wrap:wrap;margin-top:.35rem}.rq-intel span{font-size:.68rem;padding:.16rem .38rem;border-radius:999px;background:var(--bg-inset);color:var(--text-dim)}.rq-intel span.bad{background:var(--crit-wash);color:var(--crit)}
  .rq-rem{font-size:.72rem;color:var(--text-dim);margin-top:.3rem;line-height:1.4}
  .rq-actions{display:flex;gap:.5rem;align-items:center;white-space:nowrap}.rq-actions a{font-size:.76rem;color:var(--accent)}
  .rq-empty{display:flex;flex-direction:column;align-items:flex-start;gap:.5rem;border:1px dashed var(--rule);border-radius:var(--radius-md);padding:1rem;color:var(--text-dim)}.rq-empty strong{color:var(--text)}
  @media(max-width:900px){.rq-summary{grid-template-columns:repeat(3,1fr)}.rq-item{grid-template-columns:40px minmax(0,1fr)}.rq-actions{grid-column:2;justify-self:start}}
  @media(max-width:650px){.rq-head,.rq-toolbar{flex-direction:column;align-items:stretch}.rq-summary{grid-template-columns:1fr 1fr}}
</style>
