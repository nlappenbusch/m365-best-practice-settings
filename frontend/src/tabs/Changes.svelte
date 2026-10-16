<script>
  import { apiGet, apiPost, errText } from '../lib/api.js'
  import { activeTenant } from '../lib/tenantStore.js'
  import { activeTab, goToTab } from '../lib/tabStore.js'
  import { session } from '../lib/session.js'
  import TenantContext from '../lib/TenantContext.svelte'
  import { fmtDateTime, ageLabel } from '../lib/product.js'

  let loading = $state(false)
  let running = $state(false)
  let error = $state(null)
  let notice = $state(null)
  let events = $state([])
  let stats = $state(null)
  let job = $state(null)
  let loadedFor = $state(null)
  let filter = $state('attention')   // attention | relevant | routine
  let openKey = $state(null)
  let rawFor = $state(null)
  let textFilter = $state('')
  let historyFor = $state(null)
  let history = $state([])
  let historyLoading = $state(false)

  const tid = () => encodeURIComponent($activeTenant?.id || '')
  // Einordnung kommt vom Server (ev.view): Klartext, Stufe, Routine, Bündel.
  const RANK = { critical: 4, high: 3, medium: 2, low: 1, info: 0 }
  const LEVEL_DE = { critical: 'Kritisch', high: 'Hoch', medium: 'Prüfen', low: 'Niedrig', info: 'Info' }
  const vOf = ev => ev.view || { level: ev.analysis?.risk?.level || 'info', title: ev.activity || ev.operation || 'Änderung' }
  let groups = $derived.by(() => {
    const m = new Map()
    for (const ev of events) {
      const v = vOf(ev)
      const key = v.group || `${ev.activity}|${ev.targets?.[0]?.name || ''}|${ev.actor}|${String(ev.occurredAt).slice(0, 10)}`
      if (!m.has(key)) m.set(key, { key, events: [], level: 'info', routine: v.routine || null, view: v })
      const g = m.get(key)
      g.events.push(ev)
      if ((RANK[v.level] || 0) > (RANK[g.level] || 0)) { g.level = v.level; g.view = v }
      if (!v.routine) g.routine = null
    }
    return [...m.values()].map(g => ({
      ...g,
      latest: g.events[0]?.occurredAt, first: g.events[g.events.length - 1]?.occurredAt,
      actors: [...new Set(g.events.map(e => e.actor).filter(Boolean))],
      title: g.events.length > 1 && g.view.groupTitle ? g.view.groupTitle.replace('{n}', g.events.length) : (g.events.length > 1 ? `${g.view.title} (${g.events.length}×)` : g.view.title)
    })).sort((a, b) => (RANK[b.level] - RANK[a.level]) || String(b.latest).localeCompare(String(a.latest)))
  })
  let counts = $derived({
    attention: groups.filter(g => !g.routine && RANK[g.level] >= 3).length,
    relevant: groups.filter(g => !g.routine).length,
    routine: groups.filter(g => g.routine).length,
    routineEvents: groups.filter(g => g.routine).reduce((n, g) => n + g.events.length, 0)
  })
  let shown = $derived(groups.filter(g => {
    if (filter === 'attention' && (g.routine || RANK[g.level] < 3)) return false
    if (filter === 'relevant' && g.routine) return false
    if (filter === 'routine' && !g.routine) return false
    const q = textFilter.trim().toLowerCase()
    if (!q) return true
    return [g.title, ...g.actors, ...g.events.flatMap(e => [e.activity, e.operation, ...(e.targets || []).map(t => t.name)])].filter(Boolean).join(' ').toLowerCase().includes(q)
  }))
  const span = g => {
    const a = fmtDateTime(g.first), b = fmtDateTime(g.latest)
    return g.events.length > 1 && a !== b ? `${a} – ${b}` : b
  }

  function daysAgo(n) { return new Date(Date.now() - n * 864e5).toISOString().slice(0,10) }
  function today() { return new Date().toISOString().slice(0,10) }

  async function load() {
    if (!$activeTenant || !$session.loggedIn || loading) return
    loading = true; error = null
    try {
      const r = await apiGet(`/api/tenants/${tid()}/evidence/v3/events?days=30&limit=1000`)
      events = r.events || []
      stats = r.stats || null
      loadedFor = $activeTenant.id
    } catch (e) { error = errText(e) }
    loading = false
  }

  function poll(id, after) {
    setTimeout(async () => {
      try {
        const j = await apiGet(`/api/appjobs/${encodeURIComponent(id)}`)
        job = j
        if (j.status === 'running') { poll(id, after); return }
        running = false
        if (j.status === 'failed') { error = j.error || 'Erhebung fehlgeschlagen'; return }
        notice = after || 'Evidence 3.0 aktualisiert.'
        await load()
      } catch (e) {
        running = false
        error = errText(e)
      }
    }, 1100)
  }

  async function collectSinceYesterday() {
    if (!$activeTenant || running) return
    running = true; error = null; notice = null
    try {
      const r = await apiPost(`/api/tenants/${tid()}/evidence/changelog`, {
        from: daysAgo(1), to: today(), sources: ['intune','entra']
      })
      job = { id:r.jobId, status:'running', phase:'Start' }
      poll(r.jobId, 'Change-Evidence, Snapshot und Korrelation aktualisiert.')
    } catch (e) { running = false; error = errText(e) }
  }

  async function refreshCaSnapshot() {
    if (!$activeTenant || running) return
    running = true; error = null; notice = null
    try {
      const r = await apiPost(`/api/tenants/${tid()}/evidence/v3/snapshot/ca`, {})
      job = { id:r.jobId, status:'running', phase:'Conditional Access Snapshot' }
      poll(r.jobId, 'CA-Snapshot und bestehende Event-Korrelationen aktualisiert.')
    } catch (e) { running = false; error = errText(e) }
  }

  async function loadHistory(ev) {
    const r = ev.analysis?.resource
    if (!r?.type || !r?.id) return
    historyFor = ev.eventId
    history = []
    historyLoading = true
    try {
      const x = await apiGet(`/api/tenants/${tid()}/evidence/v3/resources/${encodeURIComponent(r.type)}/${encodeURIComponent(r.id)}/history`)
      history = x.history || []
    } catch (e) { error = errText(e) }
    historyLoading = false
  }

  function baselineText(a) {
    if (!a?.baseline) return 'nicht korreliert'
    if (a.baseline.compliant) return `Baseline ${a.baseline.version || '—'} · kein technischer Verstoss erkannt`
    return `Baseline ${a.baseline.version || '—'} · Abweichung`
  }

  $effect(() => {
    if ($activeTab !== 'changes' || !$session.loggedIn || !$activeTenant) return
    if (loadedFor === $activeTenant.id) return
    events = []; stats = null; loadedFor = null
    load()
  })
</script>

<TenantContext>
  <div class="chg">
    <div class="chg-head">
      <div>
        <div class="chg-eyebrow">EVIDENCE 3.0 · CHANGE INTELLIGENCE</div>
        <h2>Was hat sich verändert – und ist es relevant?</h2>
        <p>Deduplizierte Events, Ressourcen-Historie, Baseline-Korrelation, Impact und dokumentierte Entscheide in einer Sicht.</p>
      </div>
      <div class="chg-actions">
        <button class="btn btn-secondary" onclick={refreshCaSnapshot} disabled={loading || running}>CA neu korrelieren</button>
        <button class="btn btn-secondary" onclick={load} disabled={loading || running}>↻ Aktualisieren</button>
        <button class="btn btn-primary" onclick={collectSinceYesterday} disabled={running}>{running ? 'Erhebung läuft…' : 'Seit gestern erheben'}</button>
      </div>
    </div>

    {#if error}<div class="alert alert-warning">{error}</div>{/if}
    {#if notice}<div class="ld-banner ok">{notice}</div>{/if}
    {#if job?.status === 'running'}
      <div class="ld-job"><span class="ld-spinner"></span><div><strong>Evidence 3.0 aktualisiert</strong><div class="ld-job-meta">{job.phase || '…'}</div></div></div>
    {/if}

    {#if events.length}
      <div class="chg-summary2">
        <button class:on={filter === 'attention'} class="att" onclick={() => filter = 'attention'}><strong>{counts.attention}</strong><span>brauchen Aufmerksamkeit</span></button>
        <button class:on={filter === 'relevant'} onclick={() => filter = 'relevant'}><strong>{counts.relevant}</strong><span>Änderungen insgesamt (gebündelt)</span></button>
        <button class:on={filter === 'routine'} class="rt" onclick={() => filter = 'routine'}><strong>{counts.routineEvents}</strong><span>Routine-Events ausgeblendet</span></button>
        <div class="when"><strong>{ageLabel(stats?.lastSnapshotAt || stats?.lastEventIngestAt)}</strong><span>zuletzt erhoben · {events.length} Events, 30 Tage</span></div>
      </div>
    {/if}

    <div class="chg-toolbar">
      <div class="chg-filters">
        <button class:active={filter==='attention'} onclick={() => filter='attention'}>Aufmerksamkeit ({counts.attention})</button>
        <button class:active={filter==='relevant'} onclick={() => filter='relevant'}>Alle Änderungen ({counts.relevant})</button>
        <button class:active={filter==='routine'} onclick={() => filter='routine'}>Routine ({counts.routine})</button>
      </div>
      <input type="search" bind:value={textFilter} placeholder="Akteur, Objekt oder Vorgang…" />
    </div>

    {#if shown.length}
      <div class="chg-list">
        {#each shown as g (g.key)}
          {@const ev = g.events[0]}
          {@const a = ev.analysis}
          <article class="chg-card {g.level}" class:routine={g.routine}>
            <div class="cc-top">
              <span class="cc-lvl {g.level}">{g.routine ? 'Routine' : LEVEL_DE[g.level] || g.level}</span>
              <div class="cc-title">
                <strong>{g.title}</strong>
                <span>{g.actors.slice(0, 2).join(', ')}{g.actors.length > 2 ? ` +${g.actors.length - 2}` : ''} · {span(g)}</span>
              </div>
              <button class="cc-more" onclick={() => openKey = openKey === g.key ? null : g.key}>{openKey === g.key ? 'weniger' : g.events.length > 1 ? `${g.events.length} Events` : 'Details'}</button>
            </div>
            {#if g.view.hint}<p class="cc-hint"><b>Was tun:</b> {g.view.hint}</p>{/if}
            {#if a?.baseline || a?.impact?.users != null || a?.ticket?.found || a?.register?.length}
              <div class="cc-intel">
                {#if a?.baseline}<span class:bad={a.baseline.compliant === false}>{baselineText(a)}</span>{/if}
                {#if a?.impact?.users != null}<span>betrifft {a.impact.users} Benutzer{a.impact.guests ? `, davon ${a.impact.guests} Gäste` : ''}</span>{/if}
                {#if a?.ticket?.found}<span class="good">Ticket/Entscheid: {a.ticket.refs.join(', ')}</span>{/if}
                {#if a?.register?.length && !a?.ticket?.found}<span>{a.register.length} Entscheid(e)/Kommentar(e) dokumentiert</span>{/if}
              </div>
            {/if}

            {#if openKey === g.key}
              <div class="cc-events">
                {#each g.events.slice(0, 60) as e (e.eventId)}
                  <div class="cc-ev">
                    <span class="t">{fmtDateTime(e.occurredAt)}</span>
                    <span class="n">{vOf(e).title}</span>
                    <span class="w">{e.actor}</span>
                    <button class="linklike" onclick={() => rawFor = rawFor === e.eventId ? null : e.eventId}>{rawFor === e.eventId ? 'Rohdaten zu' : 'Rohdaten'}</button>
                  </div>
                  {#if rawFor === e.eventId}
                    <div class="chg-targets">
                      <div class="raw-meta">{e.activity || e.operation} · {e.source} · Nachweis {e.evidence?.archiveId || 'Event Store'} · {e.fingerprint?.slice(0, 12)}</div>
                      {#each e.targets || [] as t}
                        <div class="chg-target">
                          <div><strong>{t.name || t.id || 'Objekt'}</strong>{#if t.type}<span>{t.type}</span>{/if}</div>
                          {#if t.changes?.length}
                            <div class="chg-diff">
                              {#each t.changes.slice(0, 10) as c}
                                <div><span>{c.name}</span><code>{c.old || '—'}</code><b>→</b><code>{c.new || '—'}</code></div>
                              {/each}
                            </div>
                          {/if}
                        </div>
                      {/each}
                    </div>
                  {/if}
                {/each}
                {#if g.events.length > 60}<small class="dim">… und {g.events.length - 60} weitere</small>{/if}
                <div class="chg-rem-actions">
                  {#if a?.remediation?.route && a.remediation.route !== 'changes'}<button class="btn btn-secondary" onclick={() => goToTab(a.remediation.route)}>Zum Bereich</button>{/if}
                  {#if a?.resource}<button class="linklike" onclick={() => loadHistory(ev)}>Snapshot-Historie</button>{/if}
                  <button class="linklike" onclick={() => goToTab('nachweise')}>Nachweise</button>
                </div>
                {#if historyFor === ev.eventId}
                  <div class="chg-history">
                    <div class="chg-history-head"><strong>Resource-Historie</strong><button class="linklike" onclick={() => historyFor=null}>schliessen</button></div>
                    {#if historyLoading}<small>Lade…</small>
                    {:else if history.length}
                      {#each history.slice(0,8) as h}
                        <div class="chg-history-row">
                          <span>{fmtDateTime(h.observedAt)}</span>
                          <code>{h.hash?.slice(0,12)}</code>
                          <b>{h.deleted ? 'gelöscht' : h.baseline?.compliant === false ? 'Baseline-Abweichung' : 'Snapshot'}</b>
                        </div>
                      {/each}
                    {:else}<small>Keine frühere Version vorhanden.</small>{/if}
                  </div>
                {/if}
              </div>
            {/if}
          </article>
        {/each}
      </div>
    {:else if !loading}
      <div class="chg-empty chg-empty-big">
        <strong>{filter === 'attention' && events.length ? 'Nichts, was Aufmerksamkeit braucht.' : 'Keine Events für diesen Filter.'}</strong>
        <span>Bestehende Änderungsarchive werden automatisch in Evidence 3.0 backfilled. Für Baseline und Impact einmal CA korrelieren oder einen neuen Change-Lauf starten.</span>
        <div><button class="btn btn-primary" onclick={collectSinceYesterday} disabled={running}>Changes erheben</button> <button class="btn btn-secondary" onclick={refreshCaSnapshot} disabled={running}>CA korrelieren</button></div>
      </div>
    {/if}
  </div>
</TenantContext>

<style>
  .chg{display:flex;flex-direction:column;gap:.9rem}
  .chg-head{display:flex;justify-content:space-between;gap:1rem;align-items:flex-start}
  .chg-head h2{margin:.15rem 0 .25rem;font-size:1.45rem;letter-spacing:-.02em}
  .chg-head p{margin:0;color:var(--text-dim);max-width:76ch}
  .chg-eyebrow{font-size:.68rem;letter-spacing:.12em;color:var(--text-faint);font-weight:800}
  .chg-actions{display:flex;gap:.5rem;flex-wrap:wrap}
  .chg-toolbar{display:flex;justify-content:space-between;gap:.8rem;align-items:center;border-bottom:1px solid var(--rule);padding-bottom:.7rem}
  .chg-filters{display:flex;gap:.3rem;flex-wrap:wrap}
  .chg-filters button{border:1px solid var(--rule);background:var(--bg-inset);color:var(--text-dim);border-radius:999px;padding:.28rem .7rem;font:inherit;font-size:.78rem;font-weight:700;cursor:pointer}
  .chg-filters button.active{background:var(--accent);border-color:var(--accent);color:white}
  .chg-toolbar input{min-width:250px;padding:.42rem .6rem;border:1px solid var(--rule);border-radius:var(--radius-sm);background:var(--bg-raised);color:var(--text)}
  .chg-list{display:flex;flex-direction:column;gap:.5rem}
  .chg-summary2{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:.6rem}
  .chg-summary2>*{all:unset;box-sizing:border-box;border:1px solid var(--rule);border-radius:var(--radius-md);padding:.7rem .8rem;background:var(--bg-raised);cursor:pointer}
  .chg-summary2>div{cursor:default}
  .chg-summary2 strong,.chg-summary2 span{display:block}.chg-summary2 strong{font-size:1.25rem}.chg-summary2 span{font-size:.72rem;color:var(--text-dim);margin-top:.1rem}
  .chg-summary2 .att{border-top:3px solid var(--crit)}.chg-summary2 .rt{border-top:3px solid var(--rule)}
  .chg-summary2 button.on{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-wash)}
  .chg-summary2 .when strong{font-size:.9rem}
  .chg-card{border:1px solid var(--rule);border-left-width:4px;border-radius:var(--radius-md);padding:.65rem .8rem;background:var(--bg-raised);display:flex;flex-direction:column;gap:.4rem}
  .chg-card.critical{border-left-color:var(--crit)}.chg-card.high{border-left-color:var(--warn)}.chg-card.medium{border-left-color:var(--accent)}.chg-card.info,.chg-card.routine{border-left-color:var(--rule)}
  .cc-top{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:.7rem;align-items:center}
  .cc-lvl{font-size:.62rem;font-weight:900;text-transform:uppercase;letter-spacing:.06em;padding:.2rem .55rem;border-radius:999px;background:var(--bg-inset);color:var(--text-dim);white-space:nowrap}
  .cc-lvl.critical{background:var(--crit);color:#fff}.cc-lvl.high{background:var(--warn);color:#fff}.cc-lvl.medium{background:var(--accent-wash);color:var(--accent)}
  .routine .cc-lvl{background:var(--bg-inset);color:var(--text-faint)}
  .cc-title strong,.cc-title span{display:block}.cc-title strong{font-size:.9rem;line-height:1.3}.cc-title span{font-size:.72rem;color:var(--text-dim);margin-top:.1rem}
  .cc-more{all:unset;cursor:pointer;font-size:.74rem;font-weight:800;color:var(--accent);white-space:nowrap}
  .cc-hint{margin:0;font-size:.8rem;line-height:1.45;color:var(--text);background:var(--bg-inset);border-radius:8px;padding:.4rem .6rem}
  .routine .cc-hint{color:var(--text-dim)}
  .cc-intel{display:flex;gap:.4rem;flex-wrap:wrap}.cc-intel span{font-size:.7rem;background:var(--bg-inset);border-radius:999px;padding:.15rem .55rem;color:var(--text-dim)}
  .cc-intel span.bad{background:var(--crit-wash);color:var(--crit)}.cc-intel span.good{background:var(--ok-wash);color:var(--ok)}
  .cc-events{border-top:1px solid var(--rule);padding-top:.45rem;display:flex;flex-direction:column;gap:.25rem}
  .cc-ev{display:grid;grid-template-columns:120px minmax(0,1fr) minmax(0,.6fr) auto;gap:.6rem;font-size:.75rem;align-items:baseline}
  .cc-ev .t{color:var(--text-faint);font-family:var(--font-mono);font-size:.7rem}.cc-ev .w{color:var(--text-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .raw-meta{font-size:.68rem;color:var(--text-faint)}
  .dim{color:var(--text-dim)}
  .chg-targets{margin-top:.7rem;border-top:1px solid var(--rule);padding-top:.58rem;display:flex;flex-direction:column;gap:.45rem}
  .chg-target>div:first-child{display:flex;gap:.5rem;align-items:center}.chg-target>div:first-child span{font-size:.7rem;color:var(--text-dim)}
  .chg-diff{display:flex;flex-direction:column;gap:.18rem;margin-top:.3rem}.chg-diff>div{display:grid;grid-template-columns:minmax(130px,.8fr) minmax(120px,1fr) 20px minmax(120px,1fr);gap:.35rem;align-items:center;font-size:.75rem}
  .chg-diff code{background:var(--bg-inset);padding:.2rem .35rem;border-radius:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text)}.chg-diff b{text-align:center;color:var(--text-faint)}
  .chg-history{margin-top:.65rem;padding:.6rem .7rem;border:1px solid var(--rule);border-radius:var(--radius-md);background:var(--bg-inset)}
  .chg-history-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:.35rem}.chg-history-row{display:grid;grid-template-columns:170px 100px 1fr;gap:.5rem;padding:.28rem 0;border-top:1px solid var(--rule);font-size:.72rem}.chg-history-row:first-of-type{border-top:0}.chg-history-row code{color:var(--text-dim)}
  .chg-empty{padding:1rem;border:1px dashed var(--rule);border-radius:var(--radius-md);color:var(--text-dim)}.chg-empty-big{display:flex;flex-direction:column;align-items:flex-start;gap:.5rem}.chg-empty-big strong{color:var(--text)}
  @media(max-width:900px){.chg-summary2{grid-template-columns:1fr 1fr}.cc-ev{grid-template-columns:1fr}}
  @media(max-width:700px){.chg-head,.chg-toolbar{flex-direction:column;align-items:stretch}.chg-toolbar input{min-width:0;width:100%}.cc-top{grid-template-columns:1fr}.chg-diff>div{grid-template-columns:1fr}.chg-diff b{transform:rotate(90deg)}.chg-history-row{grid-template-columns:1fr}.chg-rem-actions{flex-wrap:wrap}}
</style>
