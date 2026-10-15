<script>
  import { errText } from '../lib/api.js'
  import { activeTenant } from '../lib/tenantStore.js'
  import { activeTab, goToTab } from '../lib/tabStore.js'
  import { session } from '../lib/session.js'
  import TenantContext from '../lib/TenantContext.svelte'
  import { ageLabel, fmtDateTime } from '../lib/product.js'
  import { msApi, followJob, SEV, SEV_DE, STATUS_DE, KIND_DE, hoursLabel, linePath, pctOf } from '../lib/managed.js'
  import ManagedRing from '../lib/ManagedRing.svelte'
  import ManagedMessages from '../lib/ManagedMessages.svelte'
  import ManagedThreat from '../lib/ManagedThreat.svelte'

  const VIEWS = [
    ['queue', 'Arbeitsliste'], ['score', 'Secure Score'], ['messages', 'Message Center'],
    ['mailboxes', 'Postfächer'], ['senderlists', 'Block/Allow'], ['sharing', 'Freigaben'],
    ['devices', 'Geräte'], ['licenses', 'Lizenzen'], ['drift', 'Drift'], ['history', 'Verlauf'], ['settings', 'Einstellungen']
  ]
  // Bereich -> Fachansicht (fuer Kachel-Klick und "Im Detail")
  const AREA_VIEW = { ca: 'drift', threat: 'drift', risk: 'queue', consent: 'queue', quarantine: 'queue', score: 'score', messages: 'messages',
    mailboxes: 'mailboxes', senderlists: 'senderlists', sharing: 'sharing', devices: 'devices', licenses: 'licenses' }

  let ov = $state(null)
  let loading = $state(false)
  let error = $state(null)
  let loadedFor = $state(null)
  let view = $state('queue')
  let areaCache = $state({})
  let job = $state(null)
  let sel = $state(null)
  let note = $state('')
  let actBusy = $state(false)
  let actMsg = $state(null)

  // Filter Arbeitsliste
  let fSev = $state('all'), fArea = $state('all'), fStatus = $state('active'), fq = $state('')
  // Einstellungen
  let st = $state(null)
  let stMsg = $state(null)
  let reports = $state(null)
  let reportQ = $state('')
  // Fachansicht-Filter
  let mbOnly = $state('attention')

  const tid = () => $activeTenant?.id

  let findings = $derived((ov?.findings || [])
    .filter(f => fSev === 'all' || f.severity === fSev)
    .filter(f => fArea === 'all' || f.area === fArea)
    .filter(f => fStatus === 'all' ? true : fStatus === 'active' ? f.status !== 'snoozed' : f.status === fStatus)
    .filter(f => !fq || (f.title + ' ' + (f.summary || '') + ' ' + (f.entity || '')).toLowerCase().includes(fq.toLowerCase())))

  let areaById = $derived(Object.fromEntries((ov?.areas || []).map(a => [a.id, a])))
  let groups = $derived([...new Set((ov?.areas || []).map(a => a.group))])
  let scoreMetric = $derived(areaById.score?.status?.metrics?.find(m => m.label === 'Secure Score'))
  let scorePct = $derived(pctOf(scoreMetric?.value))
  let compPct = $derived(pctOf(areaById.devices?.status?.metrics?.find(m => m.label === 'Konform')?.value))
  let slaCount = $derived((ov?.findings || []).filter(f => f.slaBreached).length)
  let pending = $derived((ov?.findings || []).filter(f => (f.area === 'quarantine' || f.area === 'consent') && f.status !== 'snoozed' && /anfrage/i.test(f.title)).length)
  let riskCount = $derived(areaById.risk?.status?.metrics?.[0]?.value ?? '—')
  let totalOpen = $derived(SEV.reduce((n, s) => n + (ov?.counts?.[s] || 0), 0))

  async function load(silent) {
    if (!$activeTenant || !$session.loggedIn) return
    if (!silent) loading = true
    error = null
    try {
      ov = await msApi.overview(tid())
      st = { ...ov.settings }
      loadedFor = $activeTenant.id
      if (sel) sel = ov.findings.find(f => f.id === sel.id) || ov.recentlyResolved.find(f => f.id === sel.id) || null
    } catch (e) { error = errText(e) }
    loading = false
  }

  async function area(a, force) {
    if (!force && areaCache[a]) return areaCache[a]
    try {
      const d = await msApi.area(tid(), a)
      areaCache = { ...areaCache, [a]: d }
      return d
    } catch (e) { areaCache = { ...areaCache, [a]: { error: errText(e) } } }
  }

  $effect(() => {
    if ($activeTab !== 'managed' || !$session.loggedIn || !$activeTenant) return
    if (loadedFor === $activeTenant.id) return
    ov = null; areaCache = {}; sel = null; reports = null; job = null
    load()
  })

  // Fachdaten lazy nachladen
  $effect(() => {
    if (!ov) return
    const need = { score: ['score'], messages: ['messages'], mailboxes: ['mailboxes'], senderlists: ['senderlists'], sharing: ['sharing'],
      devices: ['devices'], licenses: ['licenses'], drift: ['ca', 'threat'] }[view] || []
    for (const a of need) if (!areaCache[a]) area(a)
    if (view === 'settings' && !reports) loadReports()
  })

  async function runNow(areas) {
    try {
      const s = await msApi.run(tid(), areas)
      job = { status: 'running', phase: 'Startet…' }
      const done = await followJob(s.jobId, j => { job = j })
      areaCache = {}
      await load(true)
      if (done && done.status === 'done') setTimeout(() => { if (job?.status === 'done') job = null }, 6000)
    } catch (e) { job = { status: 'failed', error: errText(e) } }
  }

  async function act(action, extra) {
    if (!sel) return
    actBusy = true; actMsg = null
    try {
      const r = await msApi.action(tid(), sel.id, { action, note, ...(extra || {}) })
      actMsg = { ok: true, text: action === 'ticket' ? `Ticket #${r.ticket?.id} angelegt.` : 'Gespeichert.' }
      note = ''
      await load(true)
    } catch (e) { actMsg = { ok: false, text: errText(e) } }
    actBusy = false
  }

  async function acceptBaseline(a) {
    if (!confirm('Den aktuellen Ist-Stand als neue Baseline übernehmen? Alle offenen Drift-Befunde dieses Bereichs werden geschlossen.')) return
    try { await msApi.baseline(tid(), a); areaCache = { ...areaCache, [a]: null }; await area(a, true); await load(true) } catch (e) { error = errText(e) }
  }

  async function saveSettings() {
    stMsg = null
    try { const r = await msApi.settings(tid(), st); st = { ...r.settings }; stMsg = { ok: true, text: 'Gespeichert.' }; await load(true) }
    catch (e) { stMsg = { ok: false, text: errText(e) } }
  }
  async function toggleMonitoring() {
    try { await msApi.settings(tid(), { enabled: !ov.settings.enabled }); await load(true) } catch (e) { error = errText(e) }
  }
  async function loadReports() {
    try { reports = await msApi.reports(tid()); reportQ = reportQ || reports.current } catch (e) { reports = { reports: [], error: errText(e) } }
  }
  function openReport(q, opts) { window.open(msApi.reportUrl(tid(), q, opts), '_blank', 'noopener') }

  function openFinding(f) { sel = f; note = f.note || ''; actMsg = null }
  function goArea(a) { const v = AREA_VIEW[a] || 'queue'; if (v === 'queue') { fArea = a; fStatus = 'active' } view = v }

  const histPts = $derived((ov?.history || []).slice(-60))
  const histOpen = $derived(linePath(histPts.map(x => x.open), 600, 110, 6, 0))
  const histCrit = $derived(linePath(histPts.map(x => (x.critical || 0) + (x.high || 0)), 600, 110, 6, 0, Math.max(1, ...histPts.map(x => x.open || 0))))
  const scoreArea = $derived(areaCache.score?.data)
  const scoreTrend = $derived(linePath((scoreArea?.trend || []).map(x => x.pct), 600, 120, 6))
  const stateDe = s => ({ enabled: 'Ein', disabled: 'Aus', enabledForReportingButNotEnforced: 'Report-only' }[s] || s)
  const days = iso => iso ? Math.round((new Date(iso).getTime() - Date.now()) / 86400000) : null
</script>

<TenantContext>
  <div class="ms">
    <!-- ============ HERO ============ -->
    <header class="hero">
      <div class="hero-l">
        <div class="eyebrow">MANAGED SERVICE · {$activeTenant?.name?.toUpperCase()}</div>
        <h2>Lage, Drift und Arbeitsliste</h2>
        <div class="hero-meta">
          <button class="mon" class:on={ov?.settings?.enabled} onclick={toggleMonitoring} title="Automatische Überwachung ein/aus">
            <i></i>{ov?.settings?.enabled ? `Überwachung aktiv · Graph alle ${ov.settings.graphIntervalMin} Min., Exchange alle ${ov.settings.exoIntervalHours} h` : 'Überwachung aus — nur manuelle Erhebung'}
          </button>
          <span>Letzte Erhebung: {ov?.lastRun ? ageLabel(ov.lastRun) : 'noch nie'}</span>
        </div>
      </div>
      <div class="hero-act">
        <button class="btn btn-ghost" onclick={() => view = 'settings'}>Report & Einstellungen</button>
        <button class="btn btn-light" onclick={() => runNow()} disabled={job?.status === 'running' || ov?.running}>
          {job?.status === 'running' || ov?.running ? 'Erhebung läuft…' : '▶ Jetzt erheben'}
        </button>
      </div>
      {#if job}
        <div class="jobbar" class:fail={job.status === 'failed'} class:ok={job.status === 'done'}>
          {#if job.status === 'running'}<span class="spin"></span>{job.phase}
          {:else if job.status === 'done'}✓ Erhebung abgeschlossen{job.hint ? ' — ' + job.hint : ''}{job.result?.tickets?.length ? ` · ${job.result.tickets.length} Ticket(s) angelegt` : ''}
          {:else}✗ {job.error}{/if}
        </div>
      {/if}
      <div class="kpis">
        <div class="kpi ring"><ManagedRing value={scorePct} size={78} stroke={8} label="Secure Score" sub={areaById.score?.status?.metrics?.[1] ? 'Δ7 ' + areaById.score.status.metrics[1].value : ''} /></div>
        <button class="kpi stack" onclick={() => { view = 'queue'; fSev = 'all' }}>
          <strong>{totalOpen}</strong><span>offene Befunde</span>
          <div class="sbar">{#each SEV as s}{#if ov?.counts?.[s]}<i class={s} style="flex:{ov.counts[s]}" title="{SEV_DE[s]}: {ov.counts[s]}"></i>{/if}{/each}</div>
          <div class="slegend">{#each SEV as s}<em class={s}>{ov?.counts?.[s] || 0}</em>{/each}</div>
        </button>
        <button class="kpi" class:alarm={slaCount} onclick={() => { view = 'queue'; fStatus = 'open' }}><strong>{slaCount}</strong><span>SLA überschritten</span></button>
        <button class="kpi" onclick={() => { view = 'queue'; fArea = 'risk' }}><strong>{riskCount}</strong><span>Risikobenutzer</span></button>
        <button class="kpi" onclick={() => { view = 'queue'; fArea = 'all'; fq = 'Anfrage' }}><strong>{pending}</strong><span>Anfragen offen</span><em>Quarantäne & Consent</em></button>
        <div class="kpi ring"><ManagedRing value={compPct} size={78} stroke={8} label="Compliance" /></div>
      </div>
    </header>

    {#if error}<div class="alert alert-warning">{error}</div>{/if}

    {#if ov}
      <!-- ============ BEREICHE ============ -->
      <section class="areas">
        {#each groups as g}
          <div class="agroup">
            <div class="glabel">{g}</div>
            <div class="atiles">
              {#each ov.areas.filter(a => a.group === g) as a}
                {@const s = a.status}
                {@const m = s?.metrics?.[0]}
                <button class="tile" class:bad={s && !s.ok} class:never={!s} class:hasopen={a.open} onclick={() => goArea(a.id)}
                  title={s && !s.ok ? s.error : s?.note || ''}>
                  <div class="trow"><span class="lamp" class:ok={s?.ok && !a.open} class:warn={s?.ok && a.open} class:err={s && !s.ok}></span><b>{a.label}</b>{#if a.open}<span class="cnt">{a.open}</span>{/if}</div>
                  <div class="tval">{#if !s}<em>noch nicht erhoben</em>{:else if !s.ok}<em class="errt">{s.error?.slice(0, 70)}</em>{:else if m}<strong>{m.value}</strong> <span>{m.label}</span>{/if}</div>
                  <div class="tage">{s?.at ? ageLabel(s.lastOkAt || s.at) : ''}{s?.newItems ? ` · ${s.newItems} neu` : ''}</div>
                </button>
              {/each}
            </div>
          </div>
        {/each}
      </section>

      <!-- ============ VIEW-TABS ============ -->
      <nav class="vtabs">
        {#each VIEWS as [k, l]}<button class:active={view === k} onclick={() => view = k}>{l}{#if k === 'queue' && totalOpen}<span>{totalOpen}</span>{/if}</button>{/each}
      </nav>

      <div class="body" class:withdrawer={sel}>
        <div class="main">
          <!-- ---------- ARBEITSLISTE ---------- -->
          {#if view === 'queue'}
            <div class="qtool">
              <div class="chips">
                <button class:active={fSev === 'all'} onclick={() => fSev = 'all'}>Alle</button>
                {#each SEV as s}<button class="c-{s}" class:active={fSev === s} onclick={() => fSev = s}>{SEV_DE[s]} <b>{ov.counts[s] || 0}</b></button>{/each}
              </div>
              <select bind:value={fArea}><option value="all">Alle Bereiche</option>{#each ov.areas as a}<option value={a.id}>{a.label}</option>{/each}</select>
              <select bind:value={fStatus}>
                <option value="active">Aktiv (ohne zurückgestellt)</option><option value="open">Nur offen</option><option value="ticket">Im Ticket</option>
                <option value="ack">Quittiert</option><option value="snoozed">Zurückgestellt</option><option value="all">Alle</option>
              </select>
              <input type="search" placeholder="Suchen (Konto, Policy, …)" bind:value={fq} />
            </div>
            {#if findings.length}
              <div class="qlist">
                {#each findings as f (f.id)}
                  <button class="qi {f.severity}" class:selected={sel?.id === f.id} onclick={() => openFinding(f)}>
                    <span class="qsev">{SEV_DE[f.severity]}</span>
                    <span class="qmain">
                      <strong>{f.title}</strong>
                      <span class="qsum">{f.summary}</span>
                      <span class="qtags">
                        <i class="tg">{areaById[f.area]?.label || f.area}</i>
                        {#if f.drift}<i class="tg drift">Drift</i>{/if}
                        {#if f.correlated}<i class="tg corr">Korreliert</i>{/if}
                        {#if f.status !== 'open'}<i class="tg st">{STATUS_DE[f.status]}{f.ticketId ? ' #' + f.ticketId : ''}</i>{/if}
                      </span>
                    </span>
                    <span class="qage" class:breach={f.slaBreached} title="Reaktionsziel {hoursLabel(f.slaHours)}">
                      {hoursLabel(f.ageHours)}<em>{f.slaBreached ? 'SLA überschritten' : 'Ziel ' + hoursLabel(f.slaHours)}</em>
                    </span>
                  </button>
                {/each}
              </div>
            {:else}
              <div class="empty">
                {#if !ov.lastRun}<strong>Noch keine Erhebung.</strong> «Jetzt erheben» startet alle Bereiche (Exchange-Teil dauert je nach Postfachzahl einige Minuten).
                {:else}<strong>✓ Keine Befunde in dieser Ansicht.</strong>{/if}
              </div>
            {/if}
            {#if ov.recentlyResolved?.length && fStatus !== 'open'}
              <details class="resolved"><summary>Zuletzt behoben ({ov.recentlyResolved.length})</summary>
                {#each ov.recentlyResolved as f}<button class="ri" onclick={() => openFinding(f)}><span class="dot {f.severity}"></span>{f.title}<em>{ageLabel(f.resolvedAt)}</em></button>{/each}
              </details>
            {/if}

          <!-- ---------- SECURE SCORE ---------- -->
          {:else if view === 'score'}
            {@const d = scoreArea}
            {#if areaCache.score?.error}<div class="alert alert-warning">{areaCache.score.error}</div>
            {:else if !d}<div class="empty">Noch keine Secure-Score-Daten — Bereich erheben.</div>
            {:else}
              <div class="scorehead">
                <ManagedRing value={d.current.pct} size={150} stroke={13} label="Secure Score" sub="{Math.round(d.current.score)} / {Math.round(d.current.max)} Pkt." />
                <div class="scorefacts">
                  <div><strong class:neg={d.current.delta7 < 0} class:pos={d.current.delta7 > 0}>{d.current.delta7 > 0 ? '+' : ''}{d.current.delta7}</strong><span>Punkte % · 7 Tage</span></div>
                  <div><strong class:neg={d.current.delta30 < 0} class:pos={d.current.delta30 > 0}>{d.current.delta30 > 0 ? '+' : ''}{d.current.delta30}</strong><span>Punkte % · 30 Tage</span></div>
                  <div><strong class="pos">{d.current.potential}%</strong><span>mit Top-10-Massnahmen</span></div>
                  {#if d.comparative?.AllTenants != null}<div><strong>{Math.round(d.comparative.AllTenants / d.current.max * 100)}%</strong><span>Ø alle Tenants</span></div>{/if}
                </div>
                <svg class="trend" viewBox="0 0 600 120" preserveAspectRatio="none" aria-label="Secure-Score-Verlauf 90 Tage">
                  <path d={scoreTrend.area} class="ta" /><path d={scoreTrend.line} class="tl" />
                </svg>
              </div>
              <h3 class="sh">Massnahmen zur Erhöhung <small>grösster Gewinn zuerst · Quick Wins markiert</small></h3>
              <div class="measures">
                {#each d.measures as m, i}
                  <details class="measure" open={i < 2}>
                    <summary>
                      <span class="gain">+{m.gain}</span>
                      <span class="mt"><strong>{m.title}</strong>
                        <span class="mtags"><i>{m.category}</i>{#if m.service}<i>{m.service}</i>{/if}{#if m.cost}<i>Aufwand {m.cost}</i>{/if}{#if m.impact}<i>Benutzer: {m.impact}</i>{/if}{#if m.quickWin}<i class="qw">Quick Win</i>{/if}</span>
                      </span>
                      <span class="gbar"><i style="width:{Math.min(100, m.gain / (d.measures[0]?.gain || 1) * 100)}%"></i></span>
                    </summary>
                    {#if m.why}<p class="why">{m.why}</p>{/if}
                    {#if m.remediation}<pre class="rem">{m.remediation}</pre>{/if}
                    <a href={m.url} target="_blank" rel="noreferrer">Im Defender-Portal öffnen ↗</a>
                  </details>
                {/each}
              </div>
            {/if}

          <!-- ---------- MESSAGE CENTER ---------- -->
          {:else if view === 'messages'}
            {@const d = areaCache.messages?.data}
            {#if !d}<div class="empty">{areaCache.messages?.error || 'Noch keine Meldungen erhoben.'}</div>
            {:else}
              <ManagedMessages data={d} tenantName={$activeTenant?.name || ''} refreshing={job?.status === 'running'} onRefresh={async () => { await runNow(['messages']); await area('messages', true) }} />
            {/if}

          <!-- ---------- POSTFAECHER ---------- -->
          {:else if view === 'mailboxes'}
            {@const d = areaCache.mailboxes?.data}
            {#if !d}<div class="empty">{areaCache.mailboxes?.error || 'Noch keine Postfachdaten erhoben.'}</div>
            {:else}
              <div class="banner" class:bad={d.forwarding?.blocked === false} class:good={d.forwarding?.blocked}>
                <b>Externe Weiterleitung per Richtlinie: {d.forwarding?.blocked ? 'blockiert' : d.forwarding?.blocked === false ? 'ERLAUBT' : 'unbekannt'}</b>
                <span>AutoForwardingMode = {d.forwarding?.mode || '—'}. {d.forwarding?.blocked ? 'Regeln mit externem Ziel sind wirkungslos und werden als Drift gemeldet.' : 'Regeln mit externem Ziel schicken Mails tatsächlich nach aussen.'}</span>
                <em>{d.scanned} von {d.total} Postfächern geprüft</em>
              </div>
              <div class="qtool">
                <div class="chips">
                  {#each [['attention', 'Auffällig'], ['external', 'Extern'], ['all', 'Alle Regeln']] as [k, l]}<button class:active={mbOnly === k} onclick={() => mbOnly = k}>{l}</button>{/each}
                </div>
              </div>
              <h3 class="sh">Benutzer mit eigenen Inbox-Regeln <small>{d.perUser.length}</small></h3>
              <div class="tw"><table>
                <thead><tr><th>Postfach</th><th class="n">Regeln</th><th class="n">aktiv</th><th class="n">Weiterleitung</th><th class="n">extern</th><th class="n">verdächtig</th></tr></thead>
                <tbody>{#each d.perUser.filter(u => mbOnly === 'all' || (mbOnly === 'external' ? u.external : (u.external || u.suspicious))).slice(0, 300) as u}
                  <tr class:rbad={u.external || u.suspicious}><td>{u.mailbox}</td><td class="n">{u.rules}</td><td class="n">{u.enabled}</td><td class="n">{u.forwarding}</td><td class="n">{u.external || ''}</td><td class="n">{u.suspicious || ''}</td></tr>
                {/each}</tbody></table></div>
              <h3 class="sh">Regeln</h3>
              <div class="tw"><table>
                <thead><tr><th>Postfach</th><th>Regel</th><th>Bedingung</th><th>Aktion</th><th>Status</th></tr></thead>
                <tbody>{#each d.rules.filter(r => mbOnly === 'all' || (mbOnly === 'external' ? r.external.length : (r.external.length || r.suspicious))).slice(0, 400) as r}
                  <tr class:rbad={r.external.length || r.suspicious}>
                    <td>{r.mailbox}</td><td><b>{r.name}</b></td><td>{r.conditions.join(' · ') || 'alle Mails'}</td>
                    <td>{[r.forwardTo.length ? '→ ' + r.forwardTo.join(', ') : '', r.delete ? 'löschen' : '', r.moveTo ? '↪ ' + r.moveTo : '', r.markRead ? 'gelesen' : ''].filter(Boolean).join(' · ')}</td>
                    <td>{r.enabled ? 'aktiv' : 'aus'}{r.suspicious ? ' · ⚠ BEC-Muster' : ''}</td>
                  </tr>
                {/each}</tbody></table></div>
              {#if d.mailboxForwarding.length}
                <h3 class="sh">Weiterleitung auf Postfachebene</h3>
                <div class="tw"><table><thead><tr><th>Postfach</th><th>Ziel</th><th>Extern</th><th>Kopie</th></tr></thead>
                  <tbody>{#each d.mailboxForwarding as m}<tr class:rbad={m.external}><td>{m.mailbox}</td><td>{m.to}</td><td>{m.external ? 'ja' : 'nein'}</td><td>{m.keepCopy ? 'ja' : 'nein'}</td></tr>{/each}</tbody></table></div>
              {/if}
            {/if}

          <!-- ---------- BLOCK/ALLOW ---------- -->
          {:else if view === 'senderlists'}
            {@const d = areaCache.senderlists?.data}
            {#if !d}<div class="empty">{areaCache.senderlists?.error || 'Noch nicht erhoben.'}</div>
            {:else}
              <p class="dim">Persönliche Listen «Sichere Absender» / «Blockierte Absender» je Postfach ({d.scanned} von {d.total} geprüft). Neue Einträge seit dem letzten Lauf erscheinen als Meldung in der Arbeitsliste.</p>
              <div class="tw"><table>
                <thead><tr><th>Postfach</th><th>Junk-Filter</th><th>Sichere Absender</th><th>Blockierte Absender</th></tr></thead>
                <tbody>{#each d.junk.filter(j => j.trusted.length || j.blocked.length || !j.enabled) as j}
                  <tr><td>{j.mailbox}</td><td>{j.enabled ? 'an' : '⚠ aus'}</td><td class="lst">{j.trusted.slice(0, 12).join(', ')}{j.trusted.length > 12 ? ` … (+${j.trusted.length - 12})` : ''}</td><td class="lst">{j.blocked.slice(0, 12).join(', ')}{j.blocked.length > 12 ? ` … (+${j.blocked.length - 12})` : ''}</td></tr>
                {:else}<tr><td colspan="4" class="dim">Keine persönlichen Listen.</td></tr>{/each}</tbody></table></div>
              <h3 class="sh">Tenant Allow/Block List <small>{d.tabl.length}</small></h3>
              <div class="tw"><table><thead><tr><th>Typ</th><th>Aktion</th><th>Wert</th><th>Ablauf</th><th>Notiz</th></tr></thead>
                <tbody>{#each d.tabl as x}<tr class:rbad={/allow/i.test(x.action)}><td>{x.type}</td><td>{x.action}</td><td>{x.value}</td><td>{x.expires || 'nie'}</td><td>{x.notes}</td></tr>{:else}<tr><td colspan="5" class="dim">Leer.</td></tr>{/each}</tbody></table></div>
            {/if}

          <!-- ---------- FREIGABEN ---------- -->
          {:else if view === 'sharing'}
            {@const d = areaCache.sharing?.data}
            {#if !d}<div class="empty">{areaCache.sharing?.error || 'Noch nicht erhoben.'}</div>
            {:else}
              <div class="cards3">
                <div class="mini"><span>Externe Freigabe</span><strong>{d.label || '—'}</strong><em>Standard-Linktyp: {d.defaultLinkType || '—'}{d.anyoneExpiry ? ` · Jeder-Links laufen nach ${d.anyoneExpiry} T ab` : ''}</em></div>
                <div class="mini"><span>Links erstellt (aus SharePoint)</span><strong>{d.recent.filter(e => e.dir === 'out').length}</strong><em>davon anonym {d.recent.filter(e => e.dir === 'out' && e.anonymous).length}</em></div>
                <div class="mini"><span>Zugriffe von aussen (in SharePoint)</span><strong>{d.recent.filter(e => e.dir === 'in').length}</strong><em>Fenster {d.window ? d.window.from + ' – ' + d.window.to : '—'}</em></div>
              </div>
              {#if d.note}<div class="alert alert-info">{d.note}</div>{/if}
              <h3 class="sh">Wer teilt am meisten</h3>
              <div class="tw"><table><thead><tr><th>Konto</th><th class="n">Links</th><th class="n">anonym</th><th class="n">Einladungen</th></tr></thead>
                <tbody>{#each d.topSharers as u}<tr class:rbad={u.anonymous >= 10}><td>{u.user}</td><td class="n">{u.out}</td><td class="n">{u.anonymous}</td><td class="n">{u.invites}</td></tr>{:else}<tr><td colspan="4" class="dim">Keine Freigaben im Fenster.</td></tr>{/each}</tbody></table></div>
              <h3 class="sh">Ereignisse</h3>
              <div class="tw"><table><thead><tr><th>Zeit</th><th>Richtung</th><th>Vorgang</th><th>Konto</th><th>Objekt</th></tr></thead>
                <tbody>{#each d.recent.slice(0, 200) as e}<tr><td>{fmtDateTime(e.at)}</td><td><i class="dir {e.dir}">{e.dir === 'out' ? '↗ aus' : '↙ in'}</i></td><td>{e.op}{e.anonymous ? ' · anonym' : ''}</td><td>{e.user}</td><td class="lst">{e.target}</td></tr>{/each}</tbody></table></div>
            {/if}

          <!-- ---------- GERAETE ---------- -->
          {:else if view === 'devices'}
            {@const d = areaCache.devices?.data}
            {#if !d}<div class="empty">{areaCache.devices?.error || 'Noch nicht erhoben.'}</div>
            {:else if d.unlicensed}<div class="empty"><strong>Nicht lizenziert ({d.unlicensed}).</strong> {d.note}</div>
            {:else}
              <div class="devhead">
                <ManagedRing value={d.rate} size={130} stroke={12} label="Konform" />
                <div class="osbars">
                  {#each Object.entries(d.byOs).sort((a, b) => b[1].total - a[1].total) as [os, v]}
                    <div class="ob"><span>{os}</span><span class="obt"><i class="c" style="flex:{v.compliant}"></i><i class="n" style="flex:{v.noncompliant}"></i><i class="o" style="flex:{Math.max(0, v.total - v.compliant - v.noncompliant)}"></i></span><b>{v.total}</b></div>
                  {/each}
                  <div class="dim small">Grün konform · Rot nicht konform · Grau sonstige · {d.policies ?? '?'} Compliance-Policies · Geräte ohne Policy gelten als {d.secureByDefault === false ? 'KONFORM ⚠' : d.secureByDefault ? 'nicht konform' : '—'}</div>
                </div>
              </div>
              <h3 class="sh">Nicht konform <small>{d.noncompliant.length}</small></h3>
              <div class="tw"><table><thead><tr><th>Gerät</th><th>OS</th><th>Benutzer</th><th>Letzte Sync.</th></tr></thead>
                <tbody>{#each d.noncompliant as x}<tr><td><b>{x.name}</b></td><td>{x.os}</td><td>{x.user}</td><td>{x.sync}</td></tr>{:else}<tr><td colspan="4" class="dim">Keine.</td></tr>{/each}</tbody></table></div>
              {#if d.stale.length}
                <h3 class="sh">Über 30 Tage ohne Synchronisierung <small>{d.stale.length}</small></h3>
                <div class="tw"><table><thead><tr><th>Gerät</th><th>OS</th><th>Benutzer</th><th>Letzte Sync.</th><th>Status</th></tr></thead>
                  <tbody>{#each d.stale as x}<tr><td>{x.name}</td><td>{x.os}</td><td>{x.user}</td><td>{x.sync}</td><td>{x.state}</td></tr>{/each}</tbody></table></div>
              {/if}
            {/if}

          <!-- ---------- LIZENZEN ---------- -->
          {:else if view === 'licenses'}
            {@const d = areaCache.licenses?.data}
            {#if !d}<div class="empty">{areaCache.licenses?.error || 'Noch nicht erhoben.'}</div>
            {:else}
              {#if d.drift?.length}
                <div class="banner bad"><b>Lizenz-Drift seit dem letzten Lauf</b>
                  <span>{d.drift.map(c => `${c.sku}: gekauft ${c.purchased[0]}→${c.purchased[1]}, zugewiesen ${c.assigned[0]}→${c.assigned[1]}`).join(' · ')}</span></div>
              {/if}
              <div class="tw"><table><thead><tr><th>Lizenz</th><th class="n">Gekauft</th><th class="n">Zugewiesen</th><th class="n">Frei</th><th>Auslastung</th></tr></thead>
                <tbody>{#each d.skus as s}
                  {@const u = s.purchased ? Math.round(s.assigned / s.purchased * 100) : 0}
                  <tr class:rbad={s.assigned > s.purchased}><td><b>{s.name}</b></td><td class="n">{s.purchased}</td><td class="n">{s.assigned}</td><td class="n">{s.available}</td>
                    <td><span class="util"><i class:over={u > 100} class:low={u < 80} style="width:{Math.min(100, u)}%"></i></span> {u}%</td></tr>
                {/each}</tbody></table></div>
              {#if d.disabled.length}
                <h3 class="sh">Lizenzen an deaktivierten Konten <small>{d.disabled.length}</small></h3>
                <div class="tw"><table><tbody>{#each d.disabled as u}<tr><td>{u.name}</td><td>{u.upn}</td><td>{(u.licenses || []).join(', ')}</td></tr>{/each}</tbody></table></div>
              {/if}
              {#if d.inactive.length}
                <h3 class="sh">Inaktiv seit über {d.inactiveDays} Tagen <small>{d.inactive.length}</small></h3>
                <div class="tw"><table><tbody>{#each d.inactive as u}<tr><td>{u.name}</td><td>{u.upn}</td><td>{u.last ? new Date(u.last).toLocaleDateString('de-CH') : 'nie'}</td><td>{(u.licenses || []).join(', ')}</td></tr>{/each}</tbody></table></div>
              {/if}
            {/if}

          <!-- ---------- DRIFT ---------- -->
          {:else if view === 'drift'}
            {#each [['ca', 'Conditional Access'], ['threat', 'Threat Policies']] as [a, l]}
              {@const c = areaCache[a]}
              <div class="driftbox">
                <div class="dhead">
                  <div><h3>{l}</h3>
                    <span class="dim">{c?.baseline ? `Baseline vom ${fmtDateTime(c.baseline.acceptedAt)} · ${c.baseline.acceptedBy} · ${c.baseline.count} Objekte` : 'Noch keine Baseline — wird beim ersten Lauf aus dem Ist-Stand gesetzt.'}</span></div>
                  <div class="row">
                    <span class="dcount">{(ov.findings || []).filter(f => f.area === a && f.drift).length} Abweichung(en)</span>
                    <button class="btn btn-secondary" onclick={() => { view = 'queue'; fArea = a }}>Befunde</button>
                    <button class="btn btn-secondary" onclick={() => acceptBaseline(a)} disabled={!c?.baseline}>Ist-Stand als Baseline</button>
                  </div>
                </div>
                {#if a === 'ca' && c?.data?.policies}
                  <div class="tw"><table><thead><tr><th>Policy</th><th>Status</th><th>Verwaltet</th><th>Geändert</th><th>Drift</th></tr></thead>
                    <tbody>{#each c.data.policies as p}
                      {@const df = (ov.findings || []).find(f => f.area === 'ca' && f.drift && f.objId === p.id)}
                      <tr class:rbad={df}><td><b>{p.name}</b></td><td><i class="state {p.state}">{stateDe(p.state)}</i></td><td>{p.managed ? 'igeeks (BP_)' : 'kundenseitig'}</td><td>{p.modified ? fmtDateTime(p.modified) : '—'}</td>
                        <td>{#if df}<button class="linkb" onclick={() => openFinding(df)}>{SEV_DE[df.severity]} ansehen</button>{:else}<span class="okt">✓</span>{/if}</td></tr>
                    {/each}</tbody></table></div>
                {:else if a === 'threat' && c?.data?.policies}
                  <ManagedThreat data={c.data} findings={ov.findings || []} onFinding={openFinding} />
                {:else if c?.error}<div class="alert alert-warning">{c.error}</div>{/if}
              </div>
            {/each}

          <!-- ---------- VERLAUF ---------- -->
          {:else if view === 'history'}
            <div class="histbox">
              <h3 class="sh">Offene Befunde <small>letzte {histPts.length} Tage · orange gesamt, rot kritisch+hoch</small></h3>
              {#if histOpen.line}
                <svg class="trend big" viewBox="0 0 600 110" preserveAspectRatio="none"><path d={histOpen.area} class="ha" /><path d={histOpen.line} class="hl" /><path d={histCrit.line} class="hc" /></svg>
              {:else}<div class="dim">Verlauf entsteht ab dem zweiten Tag mit Erhebung.</div>{/if}
            </div>
            <h3 class="sh">Meldungen</h3>
            <div class="alist">
              {#each ov.alerts as a}
                <div class="al {a.severity}"><span class="evk">{KIND_DE[a.kind] || a.kind}</span><b>{a.title}</b><em>{fmtDateTime(a.at)}</em></div>
              {:else}<div class="dim">Noch keine Meldungen.</div>{/each}
            </div>

          <!-- ---------- EINSTELLUNGEN & REPORT ---------- -->
          {:else if view === 'settings' && st}
            <div class="setgrid">
              <section class="panel">
                <h3>Quartalsreport</h3>
                <p class="dim">Kundenfähiger Bericht: Secure Score, Befunde erkannt/behoben, offene Punkte, Mail, Geräte, Lizenzen, relevante Microsoft-Änderungen. Im Browser als PDF speichern. Der Report des Vorquartals wird automatisch abgelegt.</p>
                <div class="row">
                  <select bind:value={reportQ}>
                    {#each [reports?.current, reports?.previous, ...(reports?.reports || []).map(r => r.quarter)].filter((v, i, a) => v && a.indexOf(v) === i) as qq}<option value={qq}>{qq}{qq === reports?.current ? ' (laufend)' : ''}</option>{/each}
                  </select>
                  <button class="btn btn-primary" onclick={() => openReport(reportQ)}>Öffnen</button>
                  <button class="btn btn-secondary" onclick={async () => { openReport(reportQ, { save: true }); setTimeout(loadReports, 1500) }}>Erzeugen & ablegen</button>
                </div>
                {#if reports?.reports?.length}
                  <ul class="replist">{#each reports.reports as r}<li><button class="linkb" onclick={() => openReport(r.quarter, { stored: true })}>{r.quarter}</button> <span class="dim">abgelegt {fmtDateTime(r.at)}</span></li>{/each}</ul>
                {/if}
              </section>

              <section class="panel">
                <h3>Überwachung</h3>
                <label class="tgl big"><input type="checkbox" bind:checked={st.enabled} /> Automatisch überwachen</label>
                <div class="f2">
                  <label>Graph-Bereiche alle (Min.)<input type="number" min="15" max="1440" bind:value={st.graphIntervalMin} /></label>
                  <label>Exchange-Bereiche alle (Std.)<input type="number" min="1" max="168" bind:value={st.exoIntervalHours} /></label>
                  <label>Auto-Ticket in SDP
                    <select bind:value={st.autoTicket}><option value="off">aus</option><option value="critical">ab Kritisch</option><option value="high">ab Hoch</option></select></label>
                  <label>Teams-Meldung ab
                    <select bind:value={st.notifyMin}>{#each SEV as s}<option value={s}>{SEV_DE[s]}</option>{/each}</select></label>
                  <label>Max. Postfächer je Lauf<input type="number" min="10" max="5000" bind:value={st.maxMailboxes} /></label>
                </div>
                <div class="areachk">
                  {#each ov.areas as a}<label><input type="checkbox" checked={st.areas.includes(a.id)} onchange={e => st.areas = e.currentTarget.checked ? [...st.areas, a.id] : st.areas.filter(x => x !== a.id)} /> {a.label}</label>{/each}
                </div>
                <div class="row"><button class="btn btn-primary" onclick={saveSettings}>Speichern</button>
                  <button class="btn btn-secondary" onclick={() => goToTab('mspfleet')}>Teams-Webhook (Service-Cockpit)</button>
                  {#if stMsg}<span class:okt={stMsg.ok} class:bad={!stMsg.ok}>{stMsg.text}</span>{/if}</div>
              </section>

              <section class="panel">
                <h3>Einzelne Bereiche erheben</h3>
                <div class="areabtns">{#each ov.areas as a}<button class="btn btn-secondary" disabled={job?.status === 'running'} onclick={() => runNow([a.id])}>{a.label}</button>{/each}</div>
                <p class="dim small">Neue Berechtigungen (Risikobenutzer, Secure Score, Message Center, Consent-Anfragen, Audit-Log): bei bestehenden Tenants einmal im Tab «Tenants» → Reparieren.</p>
              </section>
            </div>
          {/if}
        </div>

        <!-- ============ DRAWER ============ -->
        {#if sel}
          <aside class="drawer {sel.severity}">
            <div class="dtop">
              <span class="dsev">{SEV_DE[sel.severity]}</span>
              <span class="dst">{STATUS_DE[sel.status]}{sel.ticketId ? ' · Ticket #' + sel.ticketId : ''}</span>
              <button class="x" onclick={() => sel = null} aria-label="Schliessen">✕</button>
            </div>
            <h3>{sel.title}</h3>
            <p class="dsum">{sel.summary}</p>
            <div class="dmeta"><span>{areaById[sel.area]?.label}</span><span>erkannt {fmtDateTime(sel.firstSeen)}</span><span>zuletzt {ageLabel(sel.lastSeen)}</span></div>
            {#if sel.context?.length}
              <dl class="ctx">{#each sel.context as [k, v]}<dt>{k}</dt><dd>{v}</dd>{/each}</dl>
            {/if}
            {#if sel.diff?.length}
              <h4>Abweichung zur Baseline</h4>
              <div class="tw"><table class="diff"><thead><tr><th>Feld</th><th>Baseline</th><th>Ist</th></tr></thead>
                <tbody>{#each sel.diff as d}<tr><td>{d.path}</td><td class="old">{d.old}</td><td class="new">{d.new}</td></tr>{/each}</tbody></table></div>
            {/if}
            {#if sel.steps?.length}
              <h4>Vorgehen</h4>
              <ol class="steps">{#each sel.steps as s}<li>{s}</li>{/each}</ol>
            {/if}
            {#if sel.evidence?.length}
              <h4>Belege</h4>
              <div class="tw"><table><thead><tr>{#each Object.keys(sel.evidence[0]) as k}<th>{k}</th>{/each}</tr></thead>
                <tbody>{#each sel.evidence as e}<tr>{#each Object.values(e) as v}<td>{v}</td>{/each}</tr>{/each}</tbody></table></div>
            {/if}
            {#if sel.links?.length}<div class="dlinks">{#each sel.links as l}<a href={l.url} target="_blank" rel="noreferrer">{l.label} ↗</a>{/each}{#if AREA_VIEW[sel.area] && AREA_VIEW[sel.area] !== 'queue'}<button class="linkb" onclick={() => view = AREA_VIEW[sel.area]}>Fachansicht</button>{/if}</div>{/if}

            {#if sel.status !== 'resolved'}
              <textarea bind:value={note} rows="2" placeholder="Notiz / Begründung (landet im Verlauf)"></textarea>
              <div class="dact">
                {#if !sel.ticketId}<button class="btn btn-primary" disabled={actBusy} onclick={() => act('ticket')}>🎫 Ticket in SDP</button>{/if}
                {#if sel.drift}<button class="btn btn-secondary" disabled={actBusy} onclick={() => act('baseline')}>Als Baseline übernehmen</button>{/if}
                {#if sel.status !== 'ack'}<button class="btn btn-secondary" disabled={actBusy} onclick={() => act('ack')}>Quittieren</button>{/if}
                <button class="btn btn-secondary" disabled={actBusy} onclick={() => act('snooze', { days: 7 })}>7 T zurückstellen</button>
                {#if sel.status !== 'open'}<button class="btn btn-secondary" disabled={actBusy} onclick={() => act('reopen')}>Wieder öffnen</button>{/if}
                {#if note && note !== sel.note}<button class="btn btn-secondary" disabled={actBusy} onclick={() => act('note')}>Notiz speichern</button>{/if}
              </div>
              {#if actMsg}<div class:okt={actMsg.ok} class:bad={!actMsg.ok} class="small">{actMsg.text}</div>{/if}
            {/if}
            {#if sel.history?.length}
              <h4>Verlauf</h4>
              <ul class="hist">{#each [...sel.history].reverse() as h}<li><em>{fmtDateTime(h.at)}</em> {h.what}{h.by ? ' · ' + h.by : ''}</li>{/each}</ul>
            {/if}
          </aside>
        {/if}
      </div>
    {:else if loading}
      <div class="empty">Lade Managed-Service-Daten…</div>
    {/if}
  </div>
</TenantContext>

<style>
  .ms{display:flex;flex-direction:column;gap:1rem}
  .dim{color:var(--text-dim)}.small{font-size:.74rem}.okt{color:var(--ok)}.bad{color:var(--crit)}
  .hero{position:relative;overflow:hidden;border-radius:var(--radius-lg);padding:1.3rem 1.4rem 1rem;color:#fff;display:grid;grid-template-columns:1fr auto;gap:.5rem 1rem;box-shadow:var(--shadow-md);
    background:radial-gradient(900px 260px at 100% -30%,rgba(255,255,255,.2),transparent 60%),linear-gradient(125deg,#032f42 0%,#035676 40%,#0081ad 80%,#25aed6 100%)}
  .hero:before{content:"";position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.05) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.05) 1px,transparent 1px);background-size:28px 28px;mask-image:linear-gradient(90deg,transparent,black 70%);pointer-events:none}
  .eyebrow{font-size:.64rem;letter-spacing:.16em;font-weight:800;opacity:.8}
  .hero h2{margin:.2rem 0 .45rem;font-size:1.5rem;letter-spacing:-.025em}
  .hero-meta{display:flex;gap:.8rem;align-items:center;flex-wrap:wrap;font-size:.76rem;opacity:.95}
  .mon{all:unset;cursor:pointer;display:inline-flex;gap:.4rem;align-items:center;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.25);border-radius:999px;padding:.22rem .7rem;font-weight:700}
  .mon i{width:8px;height:8px;border-radius:50%;background:#b0bec5}.mon.on i{background:#69f0ae;box-shadow:0 0 8px #69f0ae}
  .hero-act{display:flex;gap:.5rem;align-items:flex-start;z-index:1}
  .btn-light{background:#fff;color:#035676;border:1px solid #fff;font-weight:800}.btn-ghost{background:rgba(255,255,255,.12);color:#fff;border:1px solid rgba(255,255,255,.3)}
  .jobbar{grid-column:1/-1;z-index:1;background:rgba(0,0,0,.22);border-radius:10px;padding:.45rem .7rem;font-size:.8rem;display:flex;gap:.5rem;align-items:center}
  .jobbar.fail{background:rgba(229,57,53,.45)}.jobbar.ok{background:rgba(46,125,50,.45)}
  .spin{width:12px;height:12px;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:sp 1s linear infinite}@keyframes sp{to{transform:rotate(360deg)}}
  .kpis{grid-column:1/-1;display:grid;grid-template-columns:auto 1.6fr 1fr 1fr 1fr auto;gap:.55rem;z-index:1;margin-top:.3rem}
  .kpi{all:unset;cursor:pointer;box-sizing:border-box;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);border-radius:14px;padding:.6rem .8rem;display:flex;flex-direction:column;justify-content:center;backdrop-filter:blur(4px);transition:background .15s}
  .kpi:hover{background:rgba(255,255,255,.17)}
  .kpi.ring{cursor:default;padding:.35rem .6rem;align-items:center}
  .kpi.ring :global(.txt span),.kpi.ring :global(.txt em){color:rgba(255,255,255,.8)}
  .kpi.ring :global(.track){stroke:rgba(255,255,255,.15)}
  .kpi strong{font-size:1.55rem;letter-spacing:-.03em;line-height:1.05}
  .kpi span{font-size:.66rem;text-transform:uppercase;letter-spacing:.07em;font-weight:800;opacity:.85}
  .kpi em{font-style:normal;font-size:.66rem;opacity:.7}
  .kpi.alarm{background:rgba(171,71,188,.4);border-color:rgba(225,190,231,.6)}
  .sbar{display:flex;height:8px;border-radius:5px;overflow:hidden;background:rgba(255,255,255,.15);margin-top:.4rem;gap:2px}
  .sbar i{display:block}.sbar .critical{background:#ff5252}.sbar .high{background:#ffab40}.sbar .medium{background:#4fc3f7}.sbar .low{background:#b0bec5}
  .slegend{display:flex;gap:.6rem;margin-top:.25rem}.slegend em{font-size:.68rem;opacity:.9}.slegend em:before{content:"●";margin-right:.15rem}
  .slegend .critical:before{color:#ff5252}.slegend .high:before{color:#ffab40}.slegend .medium:before{color:#4fc3f7}.slegend .low:before{color:#b0bec5}

  .areas{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:.7rem}
  @media(max-width:1250px){.areas{grid-template-columns:repeat(3,minmax(0,1fr))}}
  @media(max-width:700px){.areas{grid-template-columns:1fr}}
  .agroup{display:flex;flex-direction:column;gap:.35rem}
  .glabel{font-size:.62rem;letter-spacing:.14em;text-transform:uppercase;font-weight:900;color:var(--text-faint)}
  .atiles{display:flex;flex-direction:column;gap:.35rem}
  .tile{all:unset;cursor:pointer;box-sizing:border-box;border:1px solid var(--rule);background:var(--bg-raised);border-radius:12px;padding:.5rem .65rem;display:flex;flex-direction:column;gap:.15rem;transition:border-color .15s,transform .15s}
  .tile:hover{border-color:var(--accent);transform:translateX(2px)}
  .tile.hasopen{border-left:3px solid var(--warn)}.tile.bad{border-left:3px solid var(--crit);background:var(--crit-wash)}.tile.never{opacity:.7}
  .tile{text-align:left}
  .trow{display:flex;flex-direction:row;justify-content:flex-start;gap:.4rem;align-items:center;font-size:.8rem}.trow b{flex:1;font-weight:700}
  .lamp{width:8px;height:8px;border-radius:50%;background:var(--text-faint)}.lamp.ok{background:var(--ok)}.lamp.warn{background:var(--warn)}.lamp.err{background:var(--crit)}
  .cnt{font-size:.66rem;font-weight:900;background:var(--warn-wash);color:var(--warn);border-radius:999px;padding:.05rem .45rem}
  .tval{font-size:.76rem}.tval strong{font-size:.92rem}.tval span{color:var(--text-dim);font-size:.7rem}.tval em{font-style:normal;color:var(--text-faint);font-size:.7rem}.tval .errt{color:var(--crit)}
  .tage{font-size:.64rem;color:var(--text-faint)}

  .vtabs{display:flex;gap:.2rem;border-bottom:1px solid var(--rule);overflow-x:auto;scrollbar-width:thin}
  .vtabs button{all:unset;cursor:pointer;padding:.55rem .8rem;font-size:.82rem;font-weight:700;color:var(--text-dim);border-bottom:2px solid transparent;white-space:nowrap}
  .vtabs button:hover{color:var(--text)}.vtabs button.active{color:var(--accent);border-bottom-color:var(--accent)}
  .vtabs span{margin-left:.35rem;font-size:.66rem;background:var(--accent);color:#fff;border-radius:999px;padding:.05rem .4rem}

  .body{display:grid;grid-template-columns:minmax(0,1fr);gap:1rem;align-items:start}
  .body.withdrawer{grid-template-columns:minmax(0,1fr) 440px}
  .main{display:flex;flex-direction:column;gap:.7rem;min-width:0}
  .qtool{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}
  .qtool select,.qtool input[type=search]{font:inherit;font-size:.8rem;padding:.38rem .55rem;border:1px solid var(--rule);border-radius:var(--radius-sm);background:var(--bg-raised);color:var(--text)}
  .qtool input[type=search]{flex:1;min-width:180px}
  .chips{display:flex;gap:.3rem;flex-wrap:wrap}
  .chips button{border:1px solid var(--rule);background:var(--bg-inset);color:var(--text-dim);border-radius:999px;padding:.28rem .7rem;font:inherit;font-size:.76rem;font-weight:700;cursor:pointer}
  .chips button b{margin-left:.2rem}.chips button.active{background:var(--accent);border-color:var(--accent);color:#fff}
  .chips .c-critical.active{background:var(--crit);border-color:var(--crit)}.chips .c-high.active{background:var(--warn);border-color:var(--warn)}
  .qlist{display:flex;flex-direction:column;gap:.4rem}
  .qi{all:unset;cursor:pointer;box-sizing:border-box;display:grid;grid-template-columns:76px minmax(0,1fr) 108px;gap:.7rem;align-items:center;border:1px solid var(--rule);border-left:4px solid var(--rule);background:var(--bg-raised);border-radius:12px;padding:.6rem .75rem;transition:box-shadow .15s,border-color .15s}
  .qi:hover{box-shadow:var(--shadow-sm);border-color:var(--accent)}.qi.selected{box-shadow:0 0 0 2px var(--accent)}
  .qi.critical{border-left-color:var(--crit)}.qi.high{border-left-color:var(--warn)}.qi.medium{border-left-color:var(--accent)}.qi.low{border-left-color:var(--text-faint)}
  .qsev{font-size:.62rem;font-weight:900;text-transform:uppercase;letter-spacing:.05em;text-align:center;border-radius:999px;padding:.2rem .3rem;background:var(--bg-inset);color:var(--text-dim)}
  .critical .qsev{background:var(--crit-wash);color:var(--crit)}.high .qsev{background:var(--warn-wash);color:var(--warn)}.medium .qsev{background:var(--accent-wash);color:var(--accent)}
  .qmain{display:flex;flex-direction:column;gap:.15rem;min-width:0}.qmain strong{font-size:.86rem;line-height:1.3}
  .qsum{font-size:.74rem;color:var(--text-dim);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
  .qtags{display:flex;gap:.3rem;flex-wrap:wrap;margin-top:.1rem}
  .tg{font-style:normal;font-size:.62rem;font-weight:800;padding:.1rem .45rem;border-radius:999px;background:var(--bg-inset);color:var(--text-dim)}
  .tg.drift{background:#ede7f6;color:#5e35b1}.tg.corr{background:var(--crit-wash);color:var(--crit)}.tg.st{background:var(--ok-wash);color:var(--ok)}
  .qage{text-align:right;font-family:var(--font-mono);font-size:.8rem;font-weight:700;display:flex;flex-direction:column}
  .qage em{font-family:var(--font-ui);font-style:normal;font-size:.62rem;color:var(--text-faint);font-weight:600}
  .qage.breach{color:#8e24aa}.qage.breach em{color:#8e24aa}
  .empty{border:1px dashed var(--rule);border-radius:var(--radius-md);padding:1.1rem;color:var(--text-dim)}.empty strong{color:var(--text)}
  .resolved summary{cursor:pointer;font-size:.8rem;font-weight:700;color:var(--text-dim)}
  .ri{all:unset;cursor:pointer;display:flex;gap:.45rem;align-items:center;font-size:.76rem;padding:.25rem 0}.ri em{margin-left:auto;font-style:normal;color:var(--text-faint);font-size:.68rem}
  .dot{width:7px;height:7px;border-radius:50%;background:var(--text-faint);flex:none}.dot.critical{background:var(--crit)}.dot.high{background:var(--warn)}.dot.medium{background:var(--accent)}

  .sh{margin:.6rem 0 .1rem;font-size:.9rem}.sh small{color:var(--text-faint);font-weight:600;margin-left:.4rem;font-size:.72rem}
  .tw{overflow-x:auto;border:1px solid var(--rule);border-radius:var(--radius-md);background:var(--bg-raised)}
  table{width:100%;border-collapse:collapse;font-size:.76rem}
  th{text-align:left;font-size:.64rem;text-transform:uppercase;letter-spacing:.06em;color:var(--text-faint);padding:.45rem .55rem;border-bottom:1px solid var(--rule);background:var(--bg-inset);position:sticky;top:0}
  td{padding:.42rem .55rem;border-bottom:1px solid var(--rule);vertical-align:top}
  tr:last-child td{border-bottom:0}.n{text-align:right;font-variant-numeric:tabular-nums}
  tr.rbad td{background:color-mix(in srgb,var(--crit-wash) 65%,transparent)}
  .lst{max-width:380px;word-break:break-word}
  .banner{border-left:4px solid var(--rule);background:var(--bg-raised);border:1px solid var(--rule);border-radius:var(--radius-md);padding:.65rem .8rem;display:flex;flex-direction:column;gap:.15rem;font-size:.8rem}
  .banner.bad{border-left:4px solid var(--crit);background:var(--crit-wash)}.banner.good{border-left:4px solid var(--ok);background:var(--ok-wash)}
  .banner em{font-style:normal;font-size:.7rem;color:var(--text-dim)}

  .scorehead{display:grid;grid-template-columns:auto auto 1fr;gap:1.2rem;align-items:center;border:1px solid var(--rule);background:var(--bg-raised);border-radius:var(--radius-lg);padding:1rem}
  .scorefacts{display:grid;grid-template-columns:1fr 1fr;gap:.6rem 1.2rem}
  .scorefacts strong{display:block;font-size:1.3rem;letter-spacing:-.02em}.scorefacts span{font-size:.66rem;text-transform:uppercase;letter-spacing:.06em;color:var(--text-faint);font-weight:700}
  .pos{color:var(--ok)}.neg{color:var(--crit)}
  .trend{width:100%;height:120px}.trend.big{height:150px}
  .ta{fill:var(--accent);opacity:.12}.tl{fill:none;stroke:var(--accent);stroke-width:2.5;vector-effect:non-scaling-stroke}
  .ha{fill:var(--warn);opacity:.12}.hl{fill:none;stroke:var(--warn);stroke-width:2.5;vector-effect:non-scaling-stroke}.hc{fill:none;stroke:var(--crit);stroke-width:2;stroke-dasharray:5 4;vector-effect:non-scaling-stroke}
  .measures{display:flex;flex-direction:column;gap:.4rem}
  .measure{border:1px solid var(--rule);background:var(--bg-raised);border-radius:12px;padding:.55rem .7rem}
  .measure summary{display:grid;grid-template-columns:62px minmax(0,1fr) 140px;gap:.7rem;align-items:center;cursor:pointer;list-style:none}
  .measure summary::-webkit-details-marker{display:none}
  .gain{background:var(--accent-wash);color:var(--accent);font-weight:900;font-size:1rem;text-align:center;border-radius:10px;padding:.4rem 0}
  .mt{display:flex;flex-direction:column;gap:.2rem}.mt strong{font-size:.84rem}
  .mtags{display:flex;gap:.25rem;flex-wrap:wrap}.mtags i{font-style:normal;font-size:.62rem;padding:.08rem .4rem;border-radius:999px;background:var(--bg-inset);color:var(--text-dim)}
  .mtags i.qw{background:var(--ok-wash);color:var(--ok);font-weight:800}
  .gbar{height:7px;background:var(--bg-inset);border-radius:5px;overflow:hidden}.gbar i{display:block;height:100%;background:linear-gradient(90deg,var(--accent),#4fc3f7);border-radius:5px}
  .why{font-size:.78rem;color:var(--text-dim);margin:.5rem 0 .3rem}
  .rem{white-space:pre-wrap;font-family:var(--font-ui);font-size:.76rem;background:var(--bg-inset);border-radius:8px;padding:.55rem .65rem;margin:.3rem 0;max-height:280px;overflow:auto}
  .measure a,.mc a{font-size:.74rem;color:var(--accent)}

  .tgl{display:inline-flex;gap:.35rem;align-items:center;font-size:.8rem;font-weight:700}.tgl.big{font-size:.9rem;margin-bottom:.5rem}
  .mclist{display:flex;flex-direction:column;gap:.5rem}
  .mc{border:1px solid var(--rule);background:var(--bg-raised);border-radius:12px;padding:.7rem .8rem;display:flex;flex-direction:column;gap:.35rem}
  .mc.dim2{opacity:.55}
  .mchead{display:grid;grid-template-columns:52px minmax(0,1fr) auto;gap:.6rem;align-items:center}.mchead strong{font-size:.86rem}
  .rel{height:8px;border-radius:5px;background:var(--bg-inset);overflow:hidden}.rel i{display:block;height:100%}
  .rel.hoch i{background:var(--crit)}.rel.mittel i{background:var(--warn)}.rel.gering i{background:var(--text-faint)}
  .due{font-size:.7rem;font-weight:800;padding:.15rem .5rem;border-radius:999px;background:var(--bg-inset);white-space:nowrap}.due.soon{background:var(--crit-wash);color:var(--crit)}
  .mcmeta{display:flex;gap:.25rem;flex-wrap:wrap}.mcmeta i{font-style:normal;font-size:.62rem;padding:.08rem .4rem;border-radius:999px;background:var(--bg-inset);color:var(--text-dim)}.mcmeta .maj{background:var(--warn-wash);color:var(--warn);font-weight:800}
  .ai{font-size:.8rem;background:linear-gradient(90deg,var(--accent-wash),transparent);border-left:3px solid var(--accent);padding:.4rem .6rem;border-radius:6px}
  .acts{margin:0;padding-left:1.1rem;font-size:.78rem}.acts li{margin:.12rem 0}
  .mc details summary{font-size:.72rem;color:var(--text-faint);cursor:pointer}.mctext{font-size:.76rem;color:var(--text-dim);white-space:pre-wrap}
  .mc{border-left:4px solid var(--rule);gap:.55rem;padding:.8rem .9rem}
  .mc.v-ja{border-left-color:var(--crit)}.mc.v-pruefen{border-left-color:var(--warn)}.mc.v-info{border-left-color:var(--accent)}.mc.v-nein{opacity:.62}
  .mchead{grid-template-columns:auto minmax(0,1fr) auto;align-items:start}.mchead strong{font-size:.92rem;line-height:1.3}
  .verd{font-size:.62rem;font-weight:900;text-transform:uppercase;letter-spacing:.05em;padding:.22rem .55rem;border-radius:999px;white-space:nowrap;background:var(--bg-inset);color:var(--text-dim)}
  .verd.v-ja{background:var(--crit);color:#fff}.verd.v-pruefen{background:var(--warn);color:#fff}.verd.v-info{background:var(--accent-wash);color:var(--accent)}
  .due{display:grid;grid-template-columns:auto auto;grid-template-rows:auto auto;column-gap:.3rem;align-items:baseline;padding:.3rem .6rem;border-radius:10px;text-align:left}
  .due b{grid-row:span 2;font-size:1.25rem;line-height:1;letter-spacing:-.03em}.due small{font-size:.6rem;text-transform:uppercase;letter-spacing:.05em;font-weight:800}.due em{font-style:normal;font-size:.66rem;opacity:.8}
  .due.over{background:var(--crit);color:#fff}
  .mcwhy{display:flex;gap:.6rem;align-items:baseline;flex-wrap:wrap;font-size:.84rem;padding:.5rem .7rem;border-radius:10px;background:var(--bg-inset)}
  .mcwhy.v-ja{background:var(--crit-wash)}.mcwhy.v-pruefen{background:var(--warn-wash)}.mcwhy.v-info{background:var(--accent-wash)}
  .mcwhy-l{font-size:.6rem;text-transform:uppercase;letter-spacing:.08em;font-weight:900;color:var(--text-faint)}
  .mcwhy a{margin-left:auto;font-weight:700}
  .mcgrid{display:grid;grid-template-columns:1.3fr 1fr;gap:.8rem}
  .mc h5{margin:0 0 .2rem;font-size:.62rem;text-transform:uppercase;letter-spacing:.08em;color:var(--text-faint)}
  .mcgrid p{margin:0;font-size:.8rem;line-height:1.45}.mcgrid ul{margin:0;padding-left:1rem;font-size:.78rem;line-height:1.4}
  .mctodo ol{margin:0;padding-left:0;list-style:none;counter-reset:t;display:flex;flex-direction:column;gap:.3rem}
  .mctodo li{counter-increment:t;position:relative;padding-left:1.7rem;font-size:.8rem;line-height:1.4}
  .mctodo li:before{content:counter(t);position:absolute;left:0;top:0;width:1.2rem;height:1.2rem;border-radius:50%;background:var(--accent-wash);color:var(--accent);font-weight:900;font-size:.66rem;display:grid;place-items:center}
  .mcfoot{display:flex;justify-content:space-between;gap:.6rem;align-items:center;flex-wrap:wrap}
  .mcmeta .plat{background:#ede7f6;color:#5e35b1;font-weight:800}
  .mcorig{border-top:1px solid var(--rule);padding-top:.4rem}.mcorig summary{font-size:.72rem;color:var(--text-faint);cursor:pointer}
  .mcsec{margin-top:.5rem}.mcsec h6{margin:0 0 .15rem;font-size:.74rem;color:var(--text)}.mcsec h6 small{font-weight:500;color:var(--text-faint);margin-left:.3rem}
  .mcsec p{margin:.1rem 0;font-size:.76rem;color:var(--text-dim);line-height:1.45}.mcsec p.bul{padding-left:.9rem;position:relative}.mcsec p.bul:before{content:"•";position:absolute;left:.2rem}
  @media(max-width:760px){.mcgrid{grid-template-columns:1fr}.mchead{grid-template-columns:1fr}}

  .cards3{display:grid;grid-template-columns:repeat(3,1fr);gap:.6rem}
  .mini{border:1px solid var(--rule);background:var(--bg-raised);border-radius:12px;padding:.7rem .8rem;display:flex;flex-direction:column;gap:.15rem}
  .mini span{font-size:.64rem;text-transform:uppercase;letter-spacing:.06em;font-weight:800;color:var(--text-faint)}.mini strong{font-size:1.2rem}.mini em{font-style:normal;font-size:.72rem;color:var(--text-dim)}
  .dir{font-style:normal;font-size:.68rem;font-weight:800;padding:.08rem .45rem;border-radius:999px}.dir.out{background:var(--warn-wash);color:var(--warn)}.dir.in{background:var(--accent-wash);color:var(--accent)}

  .devhead{display:grid;grid-template-columns:auto 1fr;gap:1.2rem;align-items:center;border:1px solid var(--rule);background:var(--bg-raised);border-radius:var(--radius-lg);padding:1rem}
  .osbars{display:flex;flex-direction:column;gap:.4rem}
  .ob{display:grid;grid-template-columns:110px 1fr 40px;gap:.6rem;align-items:center;font-size:.78rem}
  .obt{display:flex;height:10px;border-radius:6px;overflow:hidden;background:var(--bg-inset)}.obt i{display:block}.obt .c{background:var(--ok)}.obt .n{background:var(--crit)}.obt .o{background:var(--text-faint);opacity:.5}
  .util{display:inline-block;width:90px;height:7px;border-radius:5px;background:var(--bg-inset);overflow:hidden;vertical-align:middle}.util i{display:block;height:100%;background:var(--ok)}.util i.low{background:var(--warn)}.util i.over{background:var(--crit)}

  .driftbox{border:1px solid var(--rule);background:var(--bg-raised);border-radius:var(--radius-lg);padding:.85rem;display:flex;flex-direction:column;gap:.6rem}
  .dhead{display:flex;justify-content:space-between;gap:.8rem;flex-wrap:wrap;align-items:flex-start}.dhead h3{margin:0;font-size:1rem}.dhead .dim{font-size:.74rem}
  .row{display:flex;gap:.45rem;align-items:center;flex-wrap:wrap}
  .dcount{font-size:.76rem;font-weight:800;color:#5e35b1;background:#ede7f6;border-radius:999px;padding:.2rem .6rem}
  .state{font-style:normal;font-size:.68rem;font-weight:800;padding:.08rem .45rem;border-radius:999px;background:var(--bg-inset)}
  .state.enabled{background:var(--ok-wash);color:var(--ok)}.state.disabled{background:var(--crit-wash);color:var(--crit)}.state.enabledForReportingButNotEnforced{background:var(--warn-wash);color:var(--warn)}
  .tpol{display:grid;grid-template-columns:repeat(4,1fr);gap:.5rem}
  .tp{border:1px solid var(--rule);border-radius:10px;padding:.5rem .6rem;display:flex;flex-direction:column}.tp span{font-size:.64rem;text-transform:uppercase;font-weight:800;color:var(--text-faint);letter-spacing:.05em}.tp strong{font-size:1.1rem}.tp em{font-style:normal;font-size:.66rem;color:var(--text-dim)}
  .linkb{all:unset;cursor:pointer;color:var(--accent);font-size:.76rem;font-weight:700}.linkb:hover{text-decoration:underline}

  .histbox{border:1px solid var(--rule);background:var(--bg-raised);border-radius:var(--radius-lg);padding:.8rem}
  .alist{display:flex;flex-direction:column;gap:.3rem}
  .al{display:grid;grid-template-columns:92px 1fr auto;gap:.6rem;align-items:center;font-size:.76rem;border-left:3px solid var(--rule);background:var(--bg-raised);padding:.4rem .6rem;border-radius:8px}
  .al.critical{border-left-color:var(--crit)}.al.high{border-left-color:var(--warn)}.al.medium{border-left-color:var(--accent)}.al em{font-style:normal;color:var(--text-faint);font-size:.68rem}
  .evk{font-size:.6rem;text-transform:uppercase;letter-spacing:.08em;font-weight:900;color:var(--text-faint)}

  .setgrid{display:grid;grid-template-columns:1fr 1fr;gap:.8rem}
  .panel{border:1px solid var(--rule);background:var(--bg-raised);border-radius:var(--radius-lg);padding:.9rem 1rem;display:flex;flex-direction:column;gap:.55rem}
  .panel h3{margin:0;font-size:1rem}.panel p{margin:0;font-size:.78rem}
  .panel:nth-child(2){grid-row:span 2}
  .panel select,.panel input[type=number]{font:inherit;font-size:.82rem;padding:.38rem .5rem;border:1px solid var(--rule);border-radius:var(--radius-sm);background:var(--bg);color:var(--text)}
  .f2{display:grid;grid-template-columns:1fr 1fr;gap:.5rem}.f2 label{display:flex;flex-direction:column;gap:.2rem;font-size:.72rem;font-weight:700;color:var(--text-dim)}
  .areachk{display:grid;grid-template-columns:1fr 1fr;gap:.2rem .6rem;font-size:.78rem}.areachk label{display:flex;gap:.35rem;align-items:center}
  .areabtns{display:flex;flex-wrap:wrap;gap:.35rem}.areabtns .btn{font-size:.74rem;padding:.3rem .55rem}
  .replist{margin:0;padding-left:1rem;font-size:.78rem}

  .drawer{position:sticky;top:calc(var(--topbar-h) + .8rem);max-height:calc(100vh - var(--topbar-h) - 1.6rem);overflow:auto;border:1px solid var(--rule);border-top:5px solid var(--rule);background:var(--bg-raised);border-radius:var(--radius-lg);padding:.9rem 1rem;box-shadow:var(--shadow-md);display:flex;flex-direction:column;gap:.5rem;animation:slide .2s ease-out}
  @keyframes slide{from{opacity:0;transform:translateX(16px)}to{opacity:1;transform:none}}
  .drawer.critical{border-top-color:var(--crit)}.drawer.high{border-top-color:var(--warn)}.drawer.medium{border-top-color:var(--accent)}
  .dtop{display:flex;gap:.5rem;align-items:center}
  .dsev{font-size:.64rem;font-weight:900;text-transform:uppercase;padding:.18rem .55rem;border-radius:999px;background:var(--bg-inset)}
  .critical .dsev{background:var(--crit);color:#fff}.high .dsev{background:var(--warn);color:#fff}.medium .dsev{background:var(--accent);color:#fff}
  .dst{font-size:.72rem;color:var(--text-dim);font-weight:700}
  .x{all:unset;cursor:pointer;margin-left:auto;width:28px;height:28px;border-radius:50%;display:grid;place-items:center;color:var(--text-dim)}.x:hover{background:var(--bg-inset)}
  .drawer h3{margin:0;font-size:1.02rem;line-height:1.3}
  .dsum{margin:0;font-size:.8rem;color:var(--text-dim);line-height:1.45}
  .dmeta{display:flex;gap:.6rem;flex-wrap:wrap;font-size:.68rem;color:var(--text-faint)}
  .ctx{display:grid;grid-template-columns:auto 1fr;gap:.25rem .7rem;margin:0;font-size:.76rem;background:var(--bg-inset);border-radius:10px;padding:.55rem .7rem}
  .ctx dt{color:var(--text-faint);font-weight:700}.ctx dd{margin:0;word-break:break-word}
  .drawer h4{margin:.4rem 0 0;font-size:.72rem;text-transform:uppercase;letter-spacing:.08em;color:var(--text-faint)}
  .steps{margin:0;padding-left:0;list-style:none;counter-reset:s;display:flex;flex-direction:column;gap:.35rem}
  .steps li{counter-increment:s;position:relative;padding-left:1.9rem;font-size:.8rem;line-height:1.4}
  .steps li:before{content:counter(s);position:absolute;left:0;top:0;width:1.35rem;height:1.35rem;border-radius:50%;background:var(--accent-wash);color:var(--accent);font-weight:900;font-size:.7rem;display:grid;place-items:center}
  .diff .old{color:var(--crit);text-decoration:line-through;text-decoration-color:color-mix(in srgb,var(--crit) 40%,transparent)}.diff .new{color:var(--ok);font-weight:700}
  .dlinks{display:flex;gap:.7rem;flex-wrap:wrap;font-size:.76rem}.dlinks a{color:var(--accent);font-weight:700}
  .drawer textarea{font:inherit;font-size:.8rem;padding:.45rem .55rem;border:1px solid var(--rule);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);resize:vertical}
  .dact{display:flex;flex-wrap:wrap;gap:.35rem}.dact .btn{font-size:.74rem;padding:.35rem .6rem}
  .hist{list-style:none;margin:0;padding:0;font-size:.72rem;display:flex;flex-direction:column;gap:.2rem;border-left:2px solid var(--rule);padding-left:.6rem}
  .hist em{font-style:normal;color:var(--text-faint)}

  @media(max-width:1300px){.body.withdrawer{grid-template-columns:minmax(0,1fr) 380px}}
  @media(max-width:1100px){.kpis{grid-template-columns:repeat(3,1fr)}.body.withdrawer{grid-template-columns:1fr}.drawer{position:static;max-height:none}.setgrid{grid-template-columns:1fr}.tpol{grid-template-columns:repeat(2,1fr)}}
  @media(max-width:760px){.hero{grid-template-columns:1fr}.kpis{grid-template-columns:1fr 1fr}.qi{grid-template-columns:62px minmax(0,1fr)}.qage{grid-column:2;text-align:left}.scorehead,.devhead{grid-template-columns:1fr}.cards3{grid-template-columns:1fr}.measure summary{grid-template-columns:56px 1fr}.gbar{display:none}}
</style>
