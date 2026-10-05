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
  let filter = $state('attention')
  let textFilter = $state('')
  let historyFor = $state(null)
  let history = $state([])
  let historyLoading = $state(false)

  const tid = () => encodeURIComponent($activeTenant?.id || '')
  let shown = $derived(events.filter(ev => {
    const level = ev.analysis?.risk?.level || 'info'
    if (filter === 'critical' && level !== 'critical') return false
    if (filter === 'attention' && !['critical','high'].includes(level)) return false
    const q = textFilter.trim().toLowerCase()
    if (!q) return true
    return [
      ev.activity, ev.operation, ev.actor, ev.category,
      ev.analysis?.resource?.name,
      ev.analysis?.risk?.reason,
      ...(ev.targets || []).map(t => t.name)
    ].filter(Boolean).join(' ').toLowerCase().includes(q)
  }))

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

    {#if stats}
      <div class="chg-summary">
        <div><strong>{stats.events ?? 0}</strong><span>deduplizierte Events</span></div>
        <div class="crit"><strong>{stats.levels?.critical ?? 0}</strong><span>kritisch</span></div>
        <div class="high"><strong>{stats.levels?.high ?? 0}</strong><span>hoch</span></div>
        <div><strong>{stats.activeResources ?? 0}</strong><span>aktuelle Snapshots</span></div>
        <div><strong>{stats.duplicateObservations ?? 0}</strong><span>Duplikate vermieden</span></div>
        <div class="when"><strong>{ageLabel(stats.lastSnapshotAt || stats.lastEventIngestAt)}</strong><span>letzte Korrelation</span></div>
      </div>
    {/if}

    <div class="chg-toolbar">
      <div class="chg-filters">
        <button class:active={filter==='attention'} onclick={() => filter='attention'}>Aufmerksamkeit</button>
        <button class:active={filter==='critical'} onclick={() => filter='critical'}>Nur kritisch</button>
        <button class:active={filter==='all'} onclick={() => filter='all'}>Alle</button>
      </div>
      <input type="search" bind:value={textFilter} placeholder="Akteur, Objekt oder Vorgang…" />
    </div>

    {#if shown.length}
      <div class="chg-list">
        {#each shown as ev}
          {@const a = ev.analysis}
          {@const level = a?.risk?.level || 'info'}
          <article class="chg-item {level}">
            <div class="chg-item-top">
              <div class="chg-risk {level}">
                <span>{level.toUpperCase()}</span>
                <strong>{a?.risk?.reason || 'Noch nicht analysiert'}</strong>
              </div>
              <div class="chg-title">
                <strong>{ev.activity || ev.operation || 'Änderung'}</strong>
                <span>{a?.resource?.name || ev.targets?.[0]?.name || ev.category || ev.source} · {ev.actor || 'unbekannt'} · {fmtDateTime(ev.occurredAt)}</span>
              </div>
              <span class="chg-score">{a?.risk?.score ?? '—'}</span>
            </div>

            <div class="chg-intel">
              <div class:bad={a?.baseline?.compliant === false} class:good={a?.baseline?.compliant === true}>
                <span>Baseline</span>
                <strong>{baselineText(a)}</strong>
                {#if a?.baseline?.findings?.length}<small>{a.baseline.findings.map(x => x.text || x).join(' · ')}</small>{/if}
              </div>
              <div>
                <span>Impact</span>
                <strong>{a?.impact?.users != null ? a.impact.users + ' Benutzer' : 'nicht bestimmt'}</strong>
                {#if a?.impact?.guests}<small>davon {a.impact.guests} Gäste</small>{/if}
              </div>
              <div class:bad={a?.ticket && !a.ticket.found} class:good={a?.ticket?.found}>
                <span>Change / Ticket</span>
                <strong>{a?.ticket?.found ? a.ticket.refs.join(', ') : 'keine Referenz gefunden'}</strong>
                {#if a?.register?.length}<small>{a.register.length} dokumentierte Entscheide/Kommentare</small>{/if}
              </div>
              <div>
                <span>Evidence</span>
                <strong>{ev.evidence?.archiveId || 'Event Store'}</strong>
                <small>{ev.fingerprint?.slice(0,12)} · {ev.evidence?.collectedBy || 'System'}</small>
              </div>
            </div>

            {#if ev.targets?.length}
              <div class="chg-targets">
                {#each ev.targets as t}
                  <div class="chg-target">
                    <div><strong>{t.name || t.id || 'Objekt'}</strong>{#if t.type}<span>{t.type}</span>{/if}</div>
                    {#if t.changes?.length}
                      <div class="chg-diff">
                        {#each t.changes.slice(0,8) as c}
                          <div><span>{c.name}</span><code>{c.old || '—'}</code><b>→</b><code>{c.new || '—'}</code></div>
                        {/each}
                      </div>
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}

            {#if a?.remediation}
              <div class="chg-remediation">
                <div><span>REMEDIATION PLAN</span><strong>{a.remediation.suggestedAction}</strong></div>
                <div class="chg-rem-actions">
                  {#if a.remediation.route}<button class="btn btn-secondary" onclick={() => goToTab(a.remediation.route)}>Öffnen</button>{/if}
                  {#if a.resource}<button class="linklike" onclick={() => loadHistory(ev)}>Snapshot-Historie</button>{/if}
                  <button class="linklike" onclick={() => goToTab('nachweise')}>Rohnachweis</button>
                </div>
              </div>
            {/if}

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
          </article>
        {/each}
      </div>
    {:else if !loading}
      <div class="chg-empty chg-empty-big">
        <strong>Keine Events für diesen Filter.</strong>
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
  .chg-summary{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:.6rem}
  .chg-summary>div{border:1px solid var(--rule);border-radius:var(--radius-md);padding:.7rem .8rem;background:var(--bg-raised)}
  .chg-summary strong,.chg-summary span{display:block}.chg-summary strong{font-size:1.15rem}.chg-summary span{font-size:.7rem;color:var(--text-dim);margin-top:.1rem}
  .chg-summary .crit{border-top:3px solid var(--crit)} .chg-summary .high{border-top:3px solid var(--warn)} .chg-summary .when strong{font-size:.86rem}
  .chg-toolbar{display:flex;justify-content:space-between;gap:.8rem;align-items:center;border-bottom:1px solid var(--rule);padding-bottom:.7rem}
  .chg-filters{display:flex;gap:.3rem;flex-wrap:wrap}
  .chg-filters button{border:1px solid var(--rule);background:var(--bg-inset);color:var(--text-dim);border-radius:999px;padding:.28rem .7rem;font:inherit;font-size:.78rem;font-weight:700;cursor:pointer}
  .chg-filters button.active{background:var(--accent);border-color:var(--accent);color:white}
  .chg-toolbar input{min-width:250px;padding:.42rem .6rem;border:1px solid var(--rule);border-radius:var(--radius-sm);background:var(--bg-raised);color:var(--text)}
  .chg-list{display:flex;flex-direction:column;gap:.7rem}
  .chg-item{border:1px solid var(--rule);border-left-width:4px;border-radius:var(--radius-lg);padding:.85rem .95rem;background:var(--bg-raised)}
  .chg-item.critical{border-left-color:var(--crit)} .chg-item.high{border-left-color:var(--warn)} .chg-item.medium{border-left-color:var(--accent)} .chg-item.info{border-left-color:var(--rule)}
  .chg-item-top{display:grid;grid-template-columns:180px minmax(0,1fr) 36px;gap:.75rem;align-items:center}
  .chg-risk{display:flex;flex-direction:column;gap:.1rem}.chg-risk span{font-size:.6rem;font-weight:900;letter-spacing:.07em}.chg-risk strong{font-size:.74rem;line-height:1.25}
  .chg-risk.critical{color:var(--crit)} .chg-risk.high{color:var(--warn)} .chg-risk.medium{color:var(--accent)}
  .chg-title strong,.chg-title span{display:block}.chg-title span{color:var(--text-dim);font-size:.74rem;margin-top:.12rem}
  .chg-score{font-family:var(--font-mono);font-size:.76rem;color:var(--text-faint);text-align:right}
  .chg-intel{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:.5rem;margin-top:.7rem}
  .chg-intel>div{border:1px solid var(--rule);border-radius:var(--radius-sm);padding:.52rem .58rem;min-width:0}
  .chg-intel>div.bad{border-color:color-mix(in srgb,var(--crit) 45%,var(--rule));background:var(--crit-wash)}
  .chg-intel>div.good{border-color:color-mix(in srgb,var(--ok) 35%,var(--rule))}
  .chg-intel span,.chg-intel strong,.chg-intel small{display:block}.chg-intel span{font-size:.62rem;text-transform:uppercase;color:var(--text-faint);font-weight:800}.chg-intel strong{font-size:.77rem;margin-top:.13rem;overflow:hidden;text-overflow:ellipsis}.chg-intel small{font-size:.67rem;color:var(--text-dim);margin-top:.12rem;line-height:1.35}
  .chg-targets{margin-top:.7rem;border-top:1px solid var(--rule);padding-top:.58rem;display:flex;flex-direction:column;gap:.45rem}
  .chg-target>div:first-child{display:flex;gap:.5rem;align-items:center}.chg-target>div:first-child span{font-size:.7rem;color:var(--text-dim)}
  .chg-diff{display:flex;flex-direction:column;gap:.18rem;margin-top:.3rem}.chg-diff>div{display:grid;grid-template-columns:minmax(130px,.8fr) minmax(120px,1fr) 20px minmax(120px,1fr);gap:.35rem;align-items:center;font-size:.75rem}
  .chg-diff code{background:var(--bg-inset);padding:.2rem .35rem;border-radius:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text)}.chg-diff b{text-align:center;color:var(--text-faint)}
  .chg-remediation{margin-top:.65rem;background:var(--accent-wash);border:1px solid color-mix(in srgb,var(--accent) 30%,var(--rule));border-radius:var(--radius-md);padding:.55rem .65rem;display:flex;justify-content:space-between;align-items:center;gap:1rem}
  .chg-remediation span,.chg-remediation strong{display:block}.chg-remediation span{font-size:.6rem;font-weight:900;letter-spacing:.07em;color:var(--accent)}.chg-remediation strong{font-size:.76rem;margin-top:.12rem}.chg-rem-actions{display:flex;gap:.55rem;align-items:center;flex-shrink:0}
  .chg-history{margin-top:.65rem;padding:.6rem .7rem;border:1px solid var(--rule);border-radius:var(--radius-md);background:var(--bg-inset)}
  .chg-history-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:.35rem}.chg-history-row{display:grid;grid-template-columns:170px 100px 1fr;gap:.5rem;padding:.28rem 0;border-top:1px solid var(--rule);font-size:.72rem}.chg-history-row:first-of-type{border-top:0}.chg-history-row code{color:var(--text-dim)}
  .chg-empty{padding:1rem;border:1px dashed var(--rule);border-radius:var(--radius-md);color:var(--text-dim)}.chg-empty-big{display:flex;flex-direction:column;align-items:flex-start;gap:.5rem}.chg-empty-big strong{color:var(--text)}
  @media(max-width:1050px){.chg-summary{grid-template-columns:repeat(3,1fr)}.chg-intel{grid-template-columns:1fr 1fr}.chg-item-top{grid-template-columns:150px minmax(0,1fr) 30px}}
  @media(max-width:700px){.chg-head,.chg-toolbar,.chg-remediation{flex-direction:column;align-items:stretch}.chg-toolbar input{min-width:0;width:100%}.chg-summary{grid-template-columns:1fr 1fr}.chg-intel{grid-template-columns:1fr}.chg-item-top{grid-template-columns:1fr}.chg-score{display:none}.chg-diff>div{grid-template-columns:1fr}.chg-diff b{transform:rotate(90deg)}.chg-history-row{grid-template-columns:1fr}.chg-rem-actions{flex-wrap:wrap}}
</style>
