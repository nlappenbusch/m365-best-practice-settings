<script>
  import { errText } from '../lib/api.js'
  import { activeTab, goToTab } from '../lib/tabStore.js'
  import { session } from '../lib/session.js'
  import { selectTenant } from '../lib/tenantStore.js'
  import { ageLabel, fmtDateTime } from '../lib/product.js'
  import { msApi, followJob, SEV, SEV_DE, KIND_DE, linePath, pctOf, openAiPanel } from '../lib/managed.js'
  import ManagedRing from '../lib/ManagedRing.svelte'
  import AiProviders from '../lib/AiProviders.svelte'

  let rows = $state([])
  let alerts = $state([])
  let meta = $state(null)
  let loading = $state(false)
  let error = $state(null)
  let filter = $state('all')       // all | attention | monitored | off
  let q = $state('')
  let busy = $state({})
  let showGlobal = $state(false)
  let g = $state({ teamsWebhook: '', notifyMin: 'high', brand: 'igeeks AG' })
  let gMsg = $state(null)
  let loaded = $state(false)

  let totals = $derived({
    monitored: rows.filter(r => r.settings.enabled).length,
    critical: rows.reduce((n, r) => n + r.counts.critical, 0),
    high: rows.reduce((n, r) => n + r.counts.high, 0),
    sla: rows.reduce((n, r) => n + r.slaBreached, 0),
    tickets: rows.reduce((n, r) => n + r.tickets, 0),
    failing: rows.filter(r => r.settings.enabled && r.areasFailed.length).length
  })

  const weight = r => r.counts.critical * 1000 + r.slaBreached * 100 + r.counts.high * 10 + r.counts.medium
  let shown = $derived(rows
    .filter(r => !q || (r.name + ' ' + (r.organization || '')).toLowerCase().includes(q.toLowerCase()))
    .filter(r => filter === 'all' ? true : filter === 'attention' ? (r.counts.critical || r.counts.high || r.slaBreached) : filter === 'monitored' ? r.settings.enabled : !r.settings.enabled)
    .sort((a, b) => (b.settings.enabled - a.settings.enabled) || weight(b) - weight(a) || a.name.localeCompare(b.name)))

  async function load() {
    if (!$session.loggedIn || loading) return
    loading = true; error = null
    try {
      const [f, m] = await Promise.all([msApi.fleet(), meta ? Promise.resolve(meta) : msApi.meta()])
      rows = f.tenants || []
      alerts = f.alerts || []
      meta = m
      g = { teamsWebhook: m.global?.teamsWebhook || '', notifyMin: m.global?.notifyMin || 'high', brand: m.global?.brand || 'igeeks AG' }
      loaded = true
    } catch (e) { error = errText(e) }
    loading = false
  }

  $effect(() => {
    if ($activeTab !== 'mspfleet' || !$session.loggedIn) return
    if (!loaded) load()
    const t = setInterval(() => { if ($activeTab === 'mspfleet') load() }, 60000)
    return () => clearInterval(t)
  })

  // Link «KI-Dienste» aus anderen Ansichten: Panel öffnen und hinscrollen.
  $effect(() => {
    if (!$openAiPanel || $activeTab !== 'mspfleet') return
    showGlobal = true
    openAiPanel.set(false)
    setTimeout(() => document.querySelector('.fl-ai')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80)
  })

  function open(r) { selectTenant(r.id); goToTab('managed') }

  async function toggle(r) {
    busy = { ...busy, [r.id]: 'toggle' }
    try { await msApi.settings(r.id, { enabled: !r.settings.enabled }); await load() } catch (e) { error = errText(e) }
    busy = { ...busy, [r.id]: null }
  }

  async function runNow(r) {
    busy = { ...busy, [r.id]: 'Startet…' }
    try {
      const s = await msApi.run(r.id)
      await followJob(s.jobId, j => { busy = { ...busy, [r.id]: j.phase || 'läuft' } })
      await load()
    } catch (e) { error = errText(e) }
    busy = { ...busy, [r.id]: null }
  }

  async function saveGlobal() {
    gMsg = null
    try { await msApi.global(g); gMsg = { ok: true, text: 'Gespeichert.' }; meta = null; await load() } catch (e) { gMsg = { ok: false, text: errText(e) } }
  }
  async function testHook() {
    gMsg = null
    try { await msApi.testWebhook(); gMsg = { ok: true, text: 'Testmeldung an Teams gesendet.' } } catch (e) { gMsg = { ok: false, text: errText(e) } }
  }
  const spark = r => linePath(r.trend.map(x => x.open), 120, 30, 3, 0)
</script>

<div class="fl">
  <header class="fl-hero">
    <div class="fl-hero-txt">
      <div class="eyebrow">MANAGED SERVICE · SERVICE-COCKPIT</div>
      <h2>Alle betreuten Tenants. Eine Arbeitsliste.</h2>
      <p>Überwachung von Identität, Mail, Daten und Endpoints mit Drift-Erkennung, SLA und automatischen Tickets.</p>
    </div>
    <div class="fl-hero-act">
      <button class="btn btn-secondary" onclick={() => showGlobal = !showGlobal}>⚙ Einstellungen & KI-Dienste</button>
      <button class="btn btn-primary" onclick={load} disabled={loading}>{loading ? 'Lade…' : '↻ Aktualisieren'}</button>
    </div>
    <div class="fl-kpis">
      <div class="k"><strong>{totals.monitored}<small>/{rows.length}</small></strong><span>überwacht</span></div>
      <div class="k crit" class:zero={!totals.critical}><strong>{totals.critical}</strong><span>kritisch offen</span></div>
      <div class="k high" class:zero={!totals.high}><strong>{totals.high}</strong><span>hoch offen</span></div>
      <div class="k sla" class:zero={!totals.sla}><strong>{totals.sla}</strong><span>SLA überschritten</span></div>
      <div class="k"><strong>{totals.tickets}</strong><span>in Tickets</span></div>
      <div class="k warnk" class:zero={!totals.failing}><strong>{totals.failing}</strong><span>mit Erhebungsfehler</span></div>
    </div>
  </header>

  {#if error}<div class="alert alert-warning">{error}</div>{/if}

  {#if showGlobal}
    <section class="fl-global">
      <div>
        <h3>Benachrichtigung & Branding</h3>
        <p class="dim">Meldungen gehen an einen Teams-Kanal (Workflows-Webhook «Beim Empfang einer Teams-Webhook-Anforderung»). Kritische Befunde landen zusätzlich automatisch als Ticket in ServiceDesk Plus{meta && !meta.sdp ? ' — SDP ist hier aktuell nicht konfiguriert' : ''}.</p>
      </div>
      <label>Teams-Webhook-URL
        <input type="text" bind:value={g.teamsWebhook} placeholder="https://…logic.azure.com/… oder …/webhookb2/…" disabled={meta?.global?.envWebhook} />
        {#if meta?.global?.envWebhook}<small class="dim">Per Umgebungsvariable MANAGED_TEAMS_WEBHOOK gesetzt.</small>{/if}
      </label>
      <label>Meldung ab Schweregrad
        <select bind:value={g.notifyMin}>{#each SEV as s}<option value={s}>{SEV_DE[s]}</option>{/each}</select>
      </label>
      <label>Absender im Kundenreport
        <input type="text" bind:value={g.brand} />
      </label>
      <div class="row">
        <button class="btn btn-primary" onclick={saveGlobal}>Speichern</button>
        <button class="btn btn-secondary" onclick={testHook}>Testmeldung senden</button>
        {#if gMsg}<span class:okt={gMsg.ok} class:bad={!gMsg.ok}>{gMsg.text}</span>{/if}
      </div>
    </section>
    <section class="fl-ai"><AiProviders /></section>
  {/if}

  <div class="fl-toolbar">
    <div class="chips">
      {#each [['all', 'Alle'], ['attention', 'Handlungsbedarf'], ['monitored', 'Überwacht'], ['off', 'Nicht überwacht']] as [k, l]}
        <button class:active={filter === k} onclick={() => filter = k}>{l}</button>
      {/each}
    </div>
    <input class="search" type="search" placeholder="Tenant suchen…" bind:value={q} />
  </div>

  <div class="fl-main">
    <div class="fl-grid">
      {#each shown as r (r.id)}
        {@const sc = pctOf(r.score)}
        {@const sp = spark(r)}
        <article class="card" class:off={!r.settings.enabled} class:hot={r.counts.critical > 0}>
          <div class="card-head">
            <div class="who">
              <button class="name" onclick={() => open(r)}>{r.name}</button>
              <span class="org">{r.organization || ''}</span>
            </div>
            <button class="pill" class:on={r.settings.enabled} onclick={() => toggle(r)} disabled={!!busy[r.id]} title="Überwachung ein/aus">
              <i></i>{r.settings.enabled ? 'Überwacht' : 'Aus'}
            </button>
          </div>

          <div class="card-body">
            <ManagedRing value={sc} size={74} stroke={8} label="Score" />
            <div class="sev">
              {#each SEV as s}
                <div class="sv {s}" class:zero={!r.counts[s]}><strong>{r.counts[s]}</strong><span>{SEV_DE[s]}</span></div>
              {/each}
            </div>
          </div>

          <div class="card-meta">
            <span title="Geräte-Compliance">📱 {r.compliance ?? '—'}</span>
            {#if r.slaBreached}<span class="badsla">⏱ {r.slaBreached} SLA</span>{/if}
            {#if r.tickets}<span>🎫 {r.tickets}</span>{/if}
            <span class="age" title={fmtDateTime(r.lastRun)}>{r.lastRun ? ageLabel(r.lastRun) : 'nie erhoben'}</span>
            {#if sp.line}
              <svg class="spark" viewBox="0 0 120 30" aria-label="Offene Befunde 30 Tage"><path d={sp.area} class="a" /><path d={sp.line} class="l" /></svg>
            {/if}
          </div>

          {#if r.top.length}
            <ul class="top">
              {#each r.top as f}<li><span class="dot {f.severity}"></span>{f.title}</li>{/each}
            </ul>
          {:else if r.lastRun}
            <div class="clean">✓ Keine offenen Befunde</div>
          {/if}
          {#if r.areasFailed.length}<div class="failed">Nicht abrufbar: {r.areasFailed.join(', ')}</div>{/if}

          <div class="card-act">
            <button class="btn btn-primary" onclick={() => open(r)}>Öffnen</button>
            <button class="btn btn-secondary" onclick={() => runNow(r)} disabled={!!busy[r.id]}>{busy[r.id] && busy[r.id] !== 'toggle' ? busy[r.id] : 'Jetzt erheben'}</button>
          </div>
        </article>
      {:else}
        {#if loaded}<div class="empty">Keine Tenants in dieser Ansicht.</div>{/if}
      {/each}
    </div>

    <aside class="feed">
      <h3>Live-Meldungen</h3>
      {#each alerts as a}
        <button class="ev {a.severity}" onclick={() => { selectTenant(a.tenantId); goToTab('managed') }}>
          <span class="evk">{KIND_DE[a.kind] || a.kind}</span>
          <strong>{a.title}</strong>
          <em>{a.tenant} · {ageLabel(a.at)}</em>
        </button>
      {:else}
        <p class="dim">Noch keine Meldungen. Überwachung pro Tenant einschalten — der erste Lauf startet innerhalb weniger Minuten.</p>
      {/each}
    </aside>
  </div>
</div>

<style>
  .fl{display:flex;flex-direction:column;gap:1rem}
  .fl-hero{position:relative;overflow:hidden;border-radius:var(--radius-lg);padding:1.4rem 1.5rem 1.1rem;color:#fff;
    background:radial-gradient(1200px 300px at 90% -40%,rgba(255,255,255,.18),transparent 60%),linear-gradient(130deg,#03445e 0%,#00698e 45%,#0081ad 75%,#1ea7d1 100%);
    display:grid;grid-template-columns:1fr auto;gap:.6rem 1rem;box-shadow:var(--shadow-md)}
  .fl-hero:after{content:"";position:absolute;right:-60px;bottom:-90px;width:260px;height:260px;border-radius:50%;border:38px solid rgba(255,255,255,.06)}
  .eyebrow{font-size:.66rem;letter-spacing:.16em;font-weight:800;opacity:.8}
  .fl-hero h2{margin:.25rem 0 .2rem;font-size:1.55rem;letter-spacing:-.025em}
  .fl-hero p{margin:0;opacity:.85;font-size:.86rem;max-width:56ch}
  .fl-hero-act{display:flex;gap:.5rem;align-items:flex-start;z-index:1}
  .fl-hero-act .btn-secondary{background:rgba(255,255,255,.14);border-color:rgba(255,255,255,.3);color:#fff}
  .fl-hero-act .btn-primary{background:#fff;color:#00698e;border-color:#fff}
  .fl-kpis{grid-column:1/-1;display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:.55rem;margin-top:.4rem;z-index:1}
  .k{background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.18);border-radius:12px;padding:.6rem .75rem;backdrop-filter:blur(4px)}
  .k strong{display:block;font-size:1.45rem;letter-spacing:-.03em;line-height:1.1}.k strong small{font-size:.8rem;opacity:.7}
  .k span{font-size:.68rem;opacity:.85;text-transform:uppercase;letter-spacing:.06em;font-weight:700}
  .k.crit{background:rgba(229,57,53,.32);border-color:rgba(255,138,128,.55)}.k.high{background:rgba(251,140,0,.28);border-color:rgba(255,204,128,.5)}
  .k.sla{background:rgba(171,71,188,.28);border-color:rgba(225,190,231,.45)}.k.warnk{background:rgba(255,255,255,.08)}
  .k.zero{background:rgba(255,255,255,.08);border-color:rgba(255,255,255,.16)}
  .fl-global{display:grid;grid-template-columns:1.2fr 1.4fr .7fr .8fr;gap:.8rem;align-items:end;border:1px solid var(--rule);background:var(--bg-raised);border-radius:var(--radius-lg);padding:1rem}
  .fl-ai{border:1px solid var(--rule);background:var(--bg-raised);border-radius:var(--radius-lg);padding:1rem}
  .fl-global h3{margin:0 0 .2rem;font-size:1rem}.fl-global p{margin:0;font-size:.76rem}
  .fl-global label{display:flex;flex-direction:column;gap:.25rem;font-size:.74rem;font-weight:700;color:var(--text-dim)}
  .fl-global input,.fl-global select{font:inherit;font-size:.82rem;padding:.42rem .55rem;border:1px solid var(--rule);border-radius:var(--radius-sm);background:var(--bg);color:var(--text)}
  .fl-global .row{grid-column:1/-1;display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;font-size:.8rem}
  .okt{color:var(--ok)}.bad{color:var(--crit)}.dim{color:var(--text-dim)}
  .fl-toolbar{display:flex;justify-content:space-between;gap:.8rem;align-items:center;flex-wrap:wrap}
  .chips{display:flex;gap:.3rem;flex-wrap:wrap}
  .chips button{border:1px solid var(--rule);background:var(--bg-inset);color:var(--text-dim);border-radius:999px;padding:.3rem .75rem;font:inherit;font-size:.78rem;font-weight:700;cursor:pointer}
  .chips button.active{background:var(--accent);border-color:var(--accent);color:#fff}
  .search{font:inherit;font-size:.82rem;padding:.4rem .7rem;border:1px solid var(--rule);border-radius:999px;background:var(--bg-raised);color:var(--text);min-width:220px}
  .fl-main{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:1rem;align-items:start}
  .fl-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:.8rem}
  .card{border:1px solid var(--rule);background:var(--bg-raised);border-radius:var(--radius-lg);padding:.9rem .95rem;display:flex;flex-direction:column;gap:.65rem;transition:transform .15s,box-shadow .15s,border-color .15s;position:relative}
  .card:hover{transform:translateY(-2px);box-shadow:var(--shadow-md);border-color:var(--accent)}
  .card.hot{border-color:color-mix(in srgb,var(--crit) 55%,var(--rule));box-shadow:0 0 0 3px var(--crit-wash)}
  .card.off{opacity:.72}
  .card-head{display:flex;justify-content:space-between;gap:.5rem;align-items:flex-start}
  .who{min-width:0}.name{all:unset;cursor:pointer;font-weight:800;font-size:1rem;letter-spacing:-.01em;display:block}.name:hover{color:var(--accent)}
  .org{font-size:.7rem;color:var(--text-faint);display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px}
  .pill{display:inline-flex;align-items:center;gap:.35rem;border:1px solid var(--rule);background:var(--bg-inset);border-radius:999px;padding:.2rem .6rem;font:inherit;font-size:.7rem;font-weight:800;color:var(--text-dim);cursor:pointer;white-space:nowrap}
  .pill i{width:8px;height:8px;border-radius:50%;background:var(--text-faint)}
  .pill.on{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 45%,var(--rule));background:var(--ok-wash)}
  .pill.on i{background:var(--ok);box-shadow:0 0 0 0 var(--ok);animation:pulse 2s infinite}
  @keyframes pulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--ok) 60%,transparent)}70%{box-shadow:0 0 0 7px transparent}100%{box-shadow:0 0 0 0 transparent}}
  .card-body{display:flex;gap:.8rem;align-items:center}
  .sev{display:grid;grid-template-columns:repeat(4,1fr);gap:.3rem;flex:1}
  .sv{border-radius:10px;padding:.35rem .2rem;text-align:center;background:var(--bg-inset)}
  .sv strong{display:block;font-size:1.15rem;line-height:1.1}.sv span{font-size:.56rem;text-transform:uppercase;letter-spacing:.05em;font-weight:800;color:var(--text-faint)}
  .sv.critical:not(.zero){background:var(--crit-wash);color:var(--crit)}.sv.high:not(.zero){background:var(--warn-wash);color:var(--warn)}
  .sv.medium:not(.zero){background:var(--accent-wash);color:var(--accent)}.sv.zero strong{color:var(--text-faint)}
  .card-meta{display:flex;gap:.6rem;align-items:center;font-size:.72rem;color:var(--text-dim);flex-wrap:wrap}
  .card-meta .age{margin-left:auto}.badsla{color:#8e24aa;font-weight:800}
  .spark{width:120px;height:30px}.spark .a{fill:var(--warn);opacity:.12}.spark .l{fill:none;stroke:var(--warn);stroke-width:1.8}
  .top{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:.25rem}
  .top li{font-size:.74rem;display:flex;gap:.4rem;align-items:baseline;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
  .dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--text-faint);transform:translateY(-1px)}
  .dot.critical{background:var(--crit)}.dot.high{background:var(--warn)}.dot.medium{background:var(--accent)}
  .clean{font-size:.76rem;color:var(--ok);font-weight:700}
  .failed{font-size:.68rem;color:var(--warn);background:var(--warn-wash);padding:.3rem .45rem;border-radius:8px}
  .card-act{display:flex;gap:.4rem;margin-top:auto}.card-act .btn{flex:1}
  .empty{color:var(--text-dim);border:1px dashed var(--rule);border-radius:var(--radius-md);padding:1.2rem}
  .feed{position:sticky;top:calc(var(--topbar-h) + .8rem);border:1px solid var(--rule);background:var(--bg-raised);border-radius:var(--radius-lg);padding:.8rem;max-height:calc(100vh - var(--topbar-h) - 2rem);overflow:auto;display:flex;flex-direction:column;gap:.4rem}
  .feed h3{margin:0 0 .3rem;font-size:.82rem;text-transform:uppercase;letter-spacing:.08em;color:var(--text-faint)}
  .ev{all:unset;cursor:pointer;display:flex;flex-direction:column;gap:.1rem;padding:.5rem .6rem;border-radius:10px;border-left:3px solid var(--rule);background:var(--bg-inset);font-size:.74rem}
  .ev:hover{background:var(--accent-wash)}
  .ev.critical{border-left-color:var(--crit)}.ev.high{border-left-color:var(--warn)}.ev.medium{border-left-color:var(--accent)}
  .ev strong{font-weight:700;line-height:1.3}.ev em{font-style:normal;color:var(--text-faint);font-size:.68rem}
  .evk{font-size:.58rem;text-transform:uppercase;letter-spacing:.08em;font-weight:900;color:var(--text-faint)}
  @media(max-width:1200px){.fl-main{grid-template-columns:1fr}.feed{position:static;max-height:none}.fl-global{grid-template-columns:1fr 1fr}}
  @media(max-width:800px){.fl-kpis{grid-template-columns:repeat(3,1fr)}.fl-hero{grid-template-columns:1fr}.fl-global{grid-template-columns:1fr}}
</style>
