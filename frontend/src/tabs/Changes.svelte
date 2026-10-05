<script>
  import { apiGet, apiPost, errText } from '../lib/api.js'
  import { activeTenant } from '../lib/tenantStore.js'
  import { activeTab } from '../lib/tabStore.js'
  import { session } from '../lib/session.js'
  import TenantContext from '../lib/TenantContext.svelte'
  import { fmtDateTime, ageLabel, rankEvents, levelCount } from '../lib/product.js'

  let loading = $state(false)
  let running = $state(false)
  let error = $state(null)
  let notice = $state(null)
  let archive = $state([])
  let entry = $state(null)
  let job = $state(null)
  let loadedFor = $state(null)
  let filter = $state('attention')
  let textFilter = $state('')

  const tid = () => encodeURIComponent($activeTenant?.id || '')
  let ranked = $derived(rankEvents(entry?.data?.events || []))
  let shown = $derived(ranked.filter(ev => {
    if (filter === 'critical' && ev.risk.level !== 'critical') return false
    if (filter === 'attention' && !['critical','high'].includes(ev.risk.level)) return false
    if (filter === 'all') { /* no-op */ }
    const q = textFilter.trim().toLowerCase()
    if (!q) return true
    return [ev.activity, ev.operation, ev.actor, ev.category, ...(ev.targets || []).map(t => t.name)]
      .filter(Boolean).join(' ').toLowerCase().includes(q)
  }))

  function daysAgo(n) { return new Date(Date.now() - n * 864e5).toISOString().slice(0,10) }
  function today() { return new Date().toISOString().slice(0,10) }

  async function openLatest() {
    if (!$activeTenant) return
    loading = true; error = null
    try {
      const a = await apiGet(`/api/tenants/${tid()}/evidence/archive`)
      archive = a.entries || []
      const meta = archive.find(x => x.kind === 'changelog')
      if (!meta) { entry = null; loadedFor = $activeTenant.id; loading = false; return }
      const r = await apiGet(`/api/tenants/${tid()}/evidence/archive/${encodeURIComponent(meta.id)}`)
      entry = r.entry || null
      loadedFor = $activeTenant.id
    } catch (e) { error = errText(e) }
    loading = false
  }

  function poll(id) {
    setTimeout(async () => {
      try {
        const j = await apiGet(`/api/appjobs/${encodeURIComponent(id)}`)
        job = j
        if (j.status === 'running') { poll(id); return }
        running = false
        if (j.status === 'failed') { error = j.error || 'Erhebung fehlgeschlagen'; return }
        notice = 'Änderungsprotokoll aktualisiert und als Evidence archiviert.'
        await openLatest()
      } catch (e) {
        running = false
        error = errText(e)
      }
    }, 1100)
  }

  async function collect24h() {
    if (!$activeTenant || running) return
    running = true; error = null; notice = null
    try {
      const r = await apiPost(`/api/tenants/${tid()}/evidence/changelog`, {
        from: daysAgo(1), to: today(), sources: ['intune','entra']
      })
      job = { id:r.jobId, status:'running', phase:'Start' }
      poll(r.jobId)
    } catch (e) { running = false; error = errText(e) }
  }

  $effect(() => {
    if ($activeTab !== 'changes' || !$session.loggedIn || !$activeTenant) return
    if (loadedFor === $activeTenant.id) return
    entry = null; archive = []; loadedFor = null
    openLatest()
  })
</script>

<TenantContext>
  <div class="chg">
    <div class="chg-head">
      <div>
        <div class="chg-eyebrow">CHANGE INTELLIGENCE</div>
        <h2>Was hat sich verändert?</h2>
        <p>Dein bestehendes Evidence-Log wird hier nicht nur angezeigt, sondern nach Aufmerksamkeit priorisiert.</p>
      </div>
      <div class="chg-actions">
        <button class="btn btn-secondary" onclick={openLatest} disabled={loading || running}>↻ Aktualisieren</button>
        <button class="btn btn-primary" onclick={collect24h} disabled={running}>{running ? 'Erhebung läuft…' : 'Seit gestern erheben'}</button>
      </div>
    </div>

    {#if error}<div class="alert alert-warning">{error}</div>{/if}
    {#if notice}<div class="ld-banner ok">{notice}</div>{/if}
    {#if job?.status === 'running'}
      <div class="ld-job"><span class="ld-spinner"></span><div><strong>Evidence wird erhoben</strong><div class="ld-job-meta">{job.phase || '…'}</div></div></div>
    {/if}

    {#if entry}
      <div class="chg-summary">
        <div><strong>{ranked.length}</strong><span>Änderungen</span></div>
        <div class="crit"><strong>{levelCount(ranked,'critical')}</strong><span>kritisch</span></div>
        <div class="high"><strong>{levelCount(ranked,'high')}</strong><span>hoch</span></div>
        <div><strong>{entry.data?.summary?.intune ?? 0}</strong><span>Intune</span></div>
        <div><strong>{entry.data?.summary?.entra ?? 0}</strong><span>Entra</span></div>
        <div class="when"><strong>{ageLabel(entry.createdAt)}</strong><span>zuletzt erhoben</span></div>
      </div>

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
            <article class="chg-item {ev.risk.level}">
              <div class="chg-item-top">
                <div class="chg-risk {ev.risk.level}">
                  <span>{ev.risk.level === 'critical' ? 'CRITICAL' : ev.risk.level.toUpperCase()}</span>
                  <strong>{ev.risk.label}</strong>
                </div>
                <div class="chg-title">
                  <strong>{ev.activity || ev.operation || 'Änderung'}</strong>
                  <span>{ev.source} · {ev.actor || 'unbekannt'} · {fmtDateTime(ev.at)}</span>
                </div>
                <span class="chg-score">{ev.risk.score}</span>
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

              <div class="chg-meta">
                {#if ev.result}<span>Result: {ev.result}</span>{/if}
                {#if ev.category}<span>{ev.category}</span>{/if}
                <span>Evidence-ID: {entry.id}</span>
              </div>
            </article>
          {/each}
        </div>
      {:else}
        <div class="chg-empty">Für diesen Filter gibt es keine Änderungen.</div>
      {/if}
    {:else if !loading}
      <div class="chg-empty chg-empty-big">
        <strong>Noch kein Change-Evidence vorhanden.</strong>
        <span>Starte einen Lauf seit gestern. Entra und Intune werden gelesen, archiviert und anschliessend hier priorisiert.</span>
        <button class="btn btn-primary" onclick={collect24h} disabled={running}>Jetzt erheben</button>
      </div>
    {/if}
  </div>
</TenantContext>

<style>
  .chg{display:flex;flex-direction:column;gap:0.9rem}
  .chg-head{display:flex;justify-content:space-between;gap:1rem;align-items:flex-start}
  .chg-head h2{margin:0.15rem 0 0.25rem;font-size:1.45rem;letter-spacing:-0.02em}
  .chg-head p{margin:0;color:var(--text-dim);max-width:68ch}
  .chg-eyebrow{font-size:.68rem;letter-spacing:.12em;color:var(--text-faint);font-weight:800}
  .chg-actions{display:flex;gap:.5rem;flex-wrap:wrap}
  .chg-summary{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:.6rem}
  .chg-summary>div{border:1px solid var(--rule);border-radius:var(--radius-md);padding:.7rem .8rem;background:var(--bg-raised)}
  .chg-summary strong,.chg-summary span{display:block}.chg-summary strong{font-size:1.2rem}.chg-summary span{font-size:.72rem;color:var(--text-dim);margin-top:.1rem}
  .chg-summary .crit{border-top:3px solid var(--crit)} .chg-summary .high{border-top:3px solid var(--warn)}
  .chg-summary .when strong{font-size:.9rem}
  .chg-toolbar{display:flex;justify-content:space-between;gap:.8rem;align-items:center;border-bottom:1px solid var(--rule);padding-bottom:.7rem}
  .chg-filters{display:flex;gap:.3rem;flex-wrap:wrap}
  .chg-filters button{border:1px solid var(--rule);background:var(--bg-inset);color:var(--text-dim);border-radius:999px;padding:.28rem .7rem;font:inherit;font-size:.78rem;font-weight:700;cursor:pointer}
  .chg-filters button.active{background:var(--accent);border-color:var(--accent);color:white}
  .chg-toolbar input{min-width:250px;padding:.42rem .6rem;border:1px solid var(--rule);border-radius:var(--radius-sm);background:var(--bg-raised);color:var(--text)}
  .chg-list{display:flex;flex-direction:column;gap:.65rem}
  .chg-item{border:1px solid var(--rule);border-left-width:4px;border-radius:var(--radius-lg);padding:.8rem .9rem;background:var(--bg-raised)}
  .chg-item.critical{border-left-color:var(--crit)} .chg-item.high{border-left-color:var(--warn)} .chg-item.medium{border-left-color:var(--accent)} .chg-item.info{border-left-color:var(--rule)}
  .chg-item-top{display:grid;grid-template-columns:140px minmax(0,1fr) 36px;gap:.7rem;align-items:center}
  .chg-risk{display:flex;flex-direction:column;gap:.1rem}.chg-risk span{font-size:.62rem;font-weight:900;letter-spacing:.06em}.chg-risk strong{font-size:.76rem}
  .chg-risk.critical{color:var(--crit)} .chg-risk.high{color:var(--warn)} .chg-risk.medium{color:var(--accent)}
  .chg-title strong,.chg-title span{display:block}.chg-title span{color:var(--text-dim);font-size:.74rem;margin-top:.12rem}
  .chg-score{font-family:var(--font-mono);font-size:.76rem;color:var(--text-faint);text-align:right}
  .chg-targets{margin-top:.65rem;border-top:1px solid var(--rule);padding-top:.55rem;display:flex;flex-direction:column;gap:.45rem}
  .chg-target>div:first-child{display:flex;gap:.5rem;align-items:center}.chg-target>div:first-child span{font-size:.7rem;color:var(--text-dim)}
  .chg-diff{display:flex;flex-direction:column;gap:.18rem;margin-top:.3rem}
  .chg-diff>div{display:grid;grid-template-columns:minmax(130px,.8fr) minmax(120px,1fr) 20px minmax(120px,1fr);gap:.35rem;align-items:center;font-size:.75rem}
  .chg-diff code{background:var(--bg-inset);padding:.2rem .35rem;border-radius:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text)}
  .chg-diff b{text-align:center;color:var(--text-faint)}
  .chg-meta{display:flex;gap:.8rem;flex-wrap:wrap;color:var(--text-faint);font-size:.68rem;margin-top:.55rem}
  .chg-empty{padding:1rem;border:1px dashed var(--rule);border-radius:var(--radius-md);color:var(--text-dim)}
  .chg-empty-big{display:flex;flex-direction:column;align-items:flex-start;gap:.5rem}.chg-empty-big strong{color:var(--text)}
  @media(max-width:950px){.chg-summary{grid-template-columns:repeat(3,1fr)}.chg-item-top{grid-template-columns:110px minmax(0,1fr) 30px}}
  @media(max-width:650px){.chg-head,.chg-toolbar{flex-direction:column;align-items:stretch}.chg-toolbar input{min-width:0;width:100%}.chg-summary{grid-template-columns:1fr 1fr}.chg-item-top{grid-template-columns:1fr}.chg-score{display:none}.chg-diff>div{grid-template-columns:1fr}.chg-diff b{transform:rotate(90deg)}}
</style>
