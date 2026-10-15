<script>
  // Message Center als Arbeitsansicht: links gruppierte Liste, rechts Leseansicht.
  // Reihenfolge der Information: zuerst das Urteil fuer DIESEN Tenant, dann
  // Zeitstrahl, dann die vier Fragen (was / wann / wer / was tun), ganz unten
  // der Microsoft-Originaltext — sauber gesetzt statt als Textblock.
  let { data, tenantName = '', onRefresh = null, refreshing = false } = $props()
  // schema 2 = ungekuerzter Text + Gliederung (seit 15.10.2026). Aeltere Daten
  // sind beim Speichern nach 700 Zeichen abgeschnitten worden.
  let stale = $derived(data && data.schema !== 2)
  const TD_LABEL = { teamsRoom: 'Teams Rooms', collaborationBar: 'Collab Bars', touchConsole: 'Konsolen', surfaceHub: 'Surface Hubs', teamsDisplay: 'Displays', teamsPanel: 'Panels', ipPhone: 'Telefone', lowCostPhone: 'Telefone', sip: 'SIP', unknown: 'Sonstige' }
  let tdText = $derived.by(() => {
    const td = data?.teamsDevices
    if (!td) return null
    if (!td.readable) return 'Teams-Geräte: nicht lesbar'
    if (!td.total) return 'Teams-Geräte: keine'
    const agg = {}
    for (const [k, n] of Object.entries(td.byType || {})) agg[TD_LABEL[k] || k] = (agg[TD_LABEL[k] || k] || 0) + n
    return 'Teams-Geräte: ' + Object.entries(agg).map(([k, n]) => n + ' ' + k).join(', ')
  })

  const VERDICT = {
    ja: { label: 'Betroffen', icon: '!', tone: 'crit' },
    pruefen: { label: 'Prüfen', icon: '?', tone: 'warn' },
    info: { label: 'Zur Info', icon: 'i', tone: 'info' },
    nein: { label: 'Nicht betroffen', icon: '–', tone: 'none' }
  }
  const GROUPS = [
    ['action', 'Handlungsbedarf', 'Betroffen und mit Stichtag oder hoher Relevanz'],
    ['check', 'Prüfen', 'Betroffenheit lässt sich nicht automatisch feststellen'],
    ['info', 'Zur Info', 'Betrifft genutzte Dienste, kein Handlungsbedarf erkennbar'],
    ['none', 'Nicht betroffen', 'Dienst nicht lizenziert oder Plattform nicht im Einsatz']
  ]
  const groupOf = m => m.v === 'ja' && (m.due || m.relevance === 'hoch') ? 'action'
    : m.v === 'pruefen' ? 'check' : m.v === 'nein' ? 'none' : 'info'

  let q = $state('')
  let selId = $state(null)
  let open = $state({ action: true, check: true, info: false, none: false })

  let msgs = $derived((data?.messages || []).map(m => ({ ...m, v: m.verdict || (m.notInTenant ? 'nein' : 'ja') }))
    .map(m => ({ ...m, g: groupOf(m) })))
  let filtered = $derived(msgs.filter(m => !q || (m.title + ' ' + m.id + ' ' + (m.ai?.titel || '') + ' ' + m.services.join(' ')).toLowerCase().includes(q.toLowerCase())))
  const byDue = (a, b) => (a.due && b.due ? String(a.due).localeCompare(String(b.due)) : (b.due ? 1 : 0) - (a.due ? 1 : 0)) || b.score - a.score
  let grouped = $derived(GROUPS.map(([k, l, d]) => ({ k, l, d, items: filtered.filter(m => m.g === k).sort(byDue) })))
  let sel = $derived(msgs.find(m => m.id === selId) || grouped.find(g => g.items.length)?.items[0] || null)

  const days = iso => iso ? Math.round((new Date(iso).getTime() - Date.now()) / 86400000) : null
  const fmt = iso => iso ? new Date(iso).toLocaleDateString('de-CH', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'
  const title = m => m.ai?.titel || m.title

  // [[Text|URL]] und Verweise auf andere Meldungen (MC1227622) -> Links.
  const MC_URL = id => `https://admin.microsoft.com/#/MessageCenter/:/messages/${id}`
  function parts(line) {
    const out = []; const re = /\[\[([^|\]]+)\|([^\]]+)\]\]|\b(MC\d{5,8})\b|(https?:\/\/[^\s)]+)/g; let last = 0, x
    while ((x = re.exec(line)) !== null) {
      if (x.index > last) out.push({ t: line.slice(last, x.index) })
      if (x[1]) out.push({ t: x[1], href: x[2] })
      else if (x[3]) out.push({ t: x[3], href: MC_URL(x[3]), mc: true })
      else out.push({ t: x[4].replace(/^https?:\/\/(www\.)?/, '').slice(0, 48), href: x[4] })
      last = re.lastIndex
    }
    if (last < line.length) out.push({ t: line.slice(last) })
    return out
  }

  // Aeltere Datensaetze (vor der Gliederung erhoben) haben nur Fliesstext:
  // hier dieselbe Gliederung nachholen wie im Backend (mcSections).
  const HEAD = [[/what and why|what is happening|what'?s changing|summary/i, 'Was ändert sich', 'what'], [/when this will happen|schedule|timeline|rollout/i, 'Zeitplan', 'when'],
    [/how this (will )?affect|impact|who is affected/i, 'Auswirkung', 'impact'], [/what you (need|can) (to )?do|prepare|action|recommend/i, 'Was zu tun ist', 'todo'],
    [/compliance/i, 'Compliance', 'compliance'], [/additional information|learn more|more information/i, 'Weitere Informationen', 'more']]
  function fallbackSections(text) {
    let t = String(text || '').replace(/^Updated [A-Z][a-z]+ \d{1,2}, \d{4}:?[^[]*/, '')
    t = t.replace(/\s*\[(?!\[)([A-Za-z][^[\]\n|]{2,60}?)\s*:?\]\s*:?\s*/g, '\n[$1]\n')
    const out = []; let cur = { key: 'intro', title: '', lines: [] }
    for (const l of t.split('\n').map(x => x.trim()).filter(Boolean)) {
      const h = l.match(/^\[([^\]]+)\]$/)
      if (h) { if (cur.lines.length) out.push(cur); const m = HEAD.find(([re]) => re.test(h[1])); cur = { key: m ? m[2] : 'other', title: m ? m[1] : h[1], original: h[1], lines: [] }; continue }
      cur.lines.push(l)
    }
    if (cur.lines.length) out.push(cur)
    return out
  }
  // Lange Absaetze in Saetze-Gruppen zerlegen — liest sich besser als eine Wand.
  function paras(line) {
    if (line.length < 320) return [line]
    const s = line.split(/(?<=[.!?])\s+(?=[A-Z])/); const out = []; let buf = ''
    for (const x of s) { if ((buf + ' ' + x).length > 260 && buf) { out.push(buf); buf = x } else buf = buf ? buf + ' ' + x : x }
    if (buf) out.push(buf)
    return out
  }
  const secsOf = m => m.sections?.length ? m.sections : fallbackSections(m.summary)
  // Kernaussage / Betroffene fuer alte Datensaetze aus der nachgeholten Gliederung.
  function leadOf(m) {
    if (m.lead) return m.lead
    const w = secsOf(m).find(s => s.key === 'what') || secsOf(m)[0]
    return w ? (w.lines.join(' ').split(/(?<=[.!?])\s+/)[0] || '') : ''
  }
  function affectedOf(m) {
    if (m.affected?.length) return m.affected
    const imp = secsOf(m).find(s => s.key === 'impact')
    const l = imp && imp.lines.find(x => /who is affected/i.test(x))
    const rest = l ? l.replace(/^.*?who is affected\s*:?\s*/i, '').trim() : ''
    return rest ? [rest.split(/(?<=[.!?])\s+/)[0]] : []
  }
  const fmtUpd = s => { const d = new Date(s); return isNaN(d) ? s : d.toLocaleDateString('de-CH', { day: 'numeric', month: 'long', year: 'numeric' }) }
  // "Who is affected: …" u. ä. als Zwischenueberschrift mit Text darunter.
  const isSubhead = l => /^(who is affected|platforms\/services|what will happen|what you need to do)\s*:/i.test(l)

  // Zeitstrahl: heute, Meilensteine aus dem Text, Stichtag.
  function timeline(m) {
    const pts = [...(m.milestones || []).map(x => ({ d: x.date, label: x.label, approx: x.approx, old: !!x.superseded }))]
    if (m.due && !pts.some(p => p.d === String(m.due).slice(0, 10))) pts.push({ d: String(m.due).slice(0, 10), label: 'Stichtag laut Microsoft', due: true })
    else for (const p of pts) if (m.due && p.d === String(m.due).slice(0, 10)) p.due = true
    if (!pts.length) return null
    const today = new Date().toISOString().slice(0, 10)
    const all = [...pts.map(p => p.d), today].sort()
    const t0 = new Date(all[0]).getTime(), t1 = new Date(all[all.length - 1]).getTime()
    const span = Math.max(1, t1 - t0)
    const pos = d => 4 + ((new Date(d).getTime() - t0) / span) * 92
    return { today: pos(today), pts: pts.sort((a, b) => a.d.localeCompare(b.d)).map(p => ({ ...p, x: pos(p.d), past: p.d < today })) }
  }

  const SEC_ICON = { what: '◆', when: '◷', impact: '◎', todo: '✓', compliance: '§', more: '↗', other: '•', intro: '•' }
</script>

<div class="mcw">
  <aside class="mcl">
    {#if stale}
      <div class="stale">
        <b>Mit älterer Version erhoben</b>
        <span>Texte sind dort gekürzt gespeichert, die Einordnung ist vereinfacht. Ein neuer Abruf dauert nur Sekunden.</span>
        {#if onRefresh}<button onclick={onRefresh} disabled={refreshing}>{refreshing ? 'Wird abgerufen…' : 'Message Center neu erheben'}</button>{/if}
      </div>
    {/if}
    <input class="mcs" type="search" placeholder="Meldung, MC-Nummer, Dienst…" bind:value={q} />
    <div class="mcmeta-l">Abgleich mit {data?.servicePlans ?? '—'} Service Plans, Intune-Geräten{tdText ? ' · ' + tdText : ''}{data?.aiError ? ' · KI: ' + data.aiError : ''}</div>
    {#each grouped as g}
      <section class="grp g-{g.k}">
        <button class="gh" onclick={() => open[g.k] = !open[g.k]} title={g.d}>
          <span class="chev" class:open={open[g.k]}>›</span>{g.l}<b>{g.items.length}</b>
        </button>
        {#if open[g.k]}
          {#each g.items as m (m.id)}
            {@const dd = days(m.due)}
            <button class="row" class:sel={sel?.id === m.id} onclick={() => selId = m.id}>
              <span class="dot t-{VERDICT[m.v].tone}">{VERDICT[m.v].icon}</span>
              <span class="rt"><span class="rtt">{title(m)}</span><span class="rts">{m.id} · {m.services.join(', ')}</span></span>
              {#if m.due}<span class="cd" class:soon={dd <= 30 && m.v !== 'nein'} class:over={dd < 0}>{dd < 0 ? '−' + Math.abs(dd) : dd}<small>T</small></span>{/if}
            </button>
          {:else}<div class="none">—</div>{/each}
        {/if}
      </section>
    {/each}
  </aside>

  {#if sel}
    {@const dd = days(sel.due)}
    {@const tl = timeline(sel)}
    {@const vv = VERDICT[sel.v]}
    {@const acts = sel.ai?.actions?.length ? sel.ai.actions : sel.actions}
    <article class="rd">
      <header class="rh t-{vv.tone}">
        <div class="rh-top">
          <span class="badge t-{vv.tone}">{vv.label}</span>
          <span class="rid">{sel.id}</span>
          {#if sel.major}<span class="tagm">Major Change</span>{/if}
          {#if sel.updated}<span class="tagu" title={sel.updated.note}>aktualisiert {fmtUpd(sel.updated.date)}</span>{/if}
          <a class="mclink" href={sel.url} target="_blank" rel="noreferrer">Message Center ↗</a>
        </div>
        <h3>{title(sel)}</h3>
        {#if sel.ai?.titel}<div class="orig-t">{sel.title}</div>{/if}
        <div class="verdict">
          <div class="vtxt">
            <span class="vlab">Für {tenantName}</span>
            <p>{sel.ai?.impact || sel.verdictReason || '—'}</p>
            {#if sel.checkUrl}<a href={sel.checkUrl} target="_blank" rel="noreferrer">→ Geräteinventar im Defender-Portal prüfen</a>{/if}
          </div>
          {#if sel.due}
            <div class="ring t-{dd < 0 ? 'crit' : dd <= 30 && sel.v !== 'nein' ? 'crit' : 'muted'}">
              <strong>{Math.abs(dd)}</strong><span>{dd >= 0 ? 'Tage bis' : 'Tage über'}<br>Stichtag</span><em>{fmt(sel.due)}</em>
            </div>
          {/if}
        </div>
      </header>

      {#if tl}
        <div class="tl" aria-label="Zeitstrahl">
          <div class="tl-bar"></div>
          <div class="tl-today" style="left:{tl.today}%"><span>Heute</span></div>
          {#each tl.pts as p}
            <div class="tl-pt" class:due={p.due} class:past={p.past} class:old={p.old} style="left:{p.x}%" title={p.label}>
              <i></i><b>{p.approx ? '≈ ' : ''}{p.approx ? new Date(p.d).toLocaleDateString('de-CH', { month: 'short', year: 'numeric' }) : fmt(p.d)}</b><span>{p.due ? 'Stichtag' : p.old ? 'ursprünglich geplant' : p.label.length > 44 ? p.label.slice(0, 42) + '…' : p.label}</span>
            </div>
          {/each}
        </div>
      {/if}

      <div class="q4">
        <section class="qa"><h4><i>◆</i>Was ändert sich</h4><p>{sel.ai?.kurz || leadOf(sel) || '—'}</p></section>
        <section class="qa"><h4><i>◷</i>Wann</h4><p>{sel.ai?.wann || (sel.due ? 'Stichtag ' + fmt(sel.due) : sel.start ? 'Seit ' + fmt(sel.start) : '—')}</p></section>
        <section class="qa"><h4><i>◎</i>Wer ist betroffen</h4>
          {#if sel.ai?.wer}<p>{sel.ai.wer}</p>{:else if affectedOf(sel).length}<ul>{#each affectedOf(sel) as a}<li>{a}</li>{/each}</ul>{:else}<p>Keine Angabe von Microsoft.</p>{/if}
          {#if sel.platforms?.length}<div class="plats">{#each sel.platforms as p}<span>{p}</span>{/each}</div>{/if}
        </section>
        <section class="qa todo"><h4><i>✓</i>Was ist zu tun</h4>
          {#if acts.length}<ol>{#each acts as a}<li>{a}</li>{/each}</ol>{:else}<p class="dimp">Nichts — für diesen Tenant kein Handlungsbedarf.</p>{/if}
        </section>
      </div>

      <details class="orig">
        <summary>Microsoft-Originaltext <span>{secsOf(sel).length} Abschnitte · Englisch</span></summary>
        <div class="doc">
          {#if sel.updated}<div class="upd"><b>Aktualisiert am {fmtUpd(sel.updated.date)}</b>{#if sel.updated.note} — {sel.updated.note}{/if}</div>{/if}
          {#each secsOf(sel) as s}
            <section>
              {#if s.title}<h5><i>{SEC_ICON[s.key] || '•'}</i>{s.title}{#if s.original && s.original !== s.title}<small>{s.original}</small>{/if}</h5>{/if}
              {#each s.lines as l}
                {#if l.startsWith('•')}<p class="li">{#each parts(l.slice(1).trim()) as p}{#if p.href}<a href={p.href} target="_blank" rel="noreferrer" class:mcref={p.mc}>{p.t}</a>{:else}{p.t}{/if}{/each}</p>
                {:else if l.length < 48 && !/[.:!?]$/.test(l) && !/^https?:/.test(l)}<h6>{l}</h6>
                {:else if isSubhead(l)}<h6>{l.split(':')[0]}</h6><p>{#each parts(l.slice(l.indexOf(':') + 1).trim()) as p}{#if p.href}<a href={p.href} target="_blank" rel="noreferrer" class:mcref={p.mc}>{p.t}</a>{:else}{p.t}{/if}{/each}</p>
                {:else}{#each paras(l) as para}<p>{#each parts(para) as p}{#if p.href}<a href={p.href} target="_blank" rel="noreferrer" class:mcref={p.mc}>{p.t}</a>{:else}{p.t}{/if}{/each}</p>{/each}{/if}
              {/each}
            </section>
          {/each}
        </div>
      </details>
    </article>
  {:else}
    <div class="rd empty">Keine Meldungen.</div>
  {/if}
</div>

<style>
  .mcw{display:grid;grid-template-columns:340px minmax(0,1fr);gap:1rem;align-items:start}
  .mcl{position:sticky;top:calc(var(--topbar-h) + .8rem);max-height:calc(100vh - var(--topbar-h) - 1.6rem);overflow:auto;display:flex;flex-direction:column;gap:.4rem;padding-right:.2rem}
  .stale{border:1px solid color-mix(in srgb,var(--warn) 45%,var(--rule));background:var(--warn-wash);border-radius:12px;padding:.6rem .7rem;display:flex;flex-direction:column;gap:.3rem;font-size:.74rem}
  .stale b{font-size:.78rem}.stale span{color:var(--text-dim);line-height:1.35}
  .stale button{align-self:flex-start;font:inherit;font-size:.74rem;font-weight:800;border:0;border-radius:999px;padding:.35rem .8rem;background:var(--warn);color:#fff;cursor:pointer}
  .stale button:disabled{opacity:.6;cursor:default}
  .mcs{font:inherit;font-size:.82rem;padding:.45rem .7rem;border:1px solid var(--rule);border-radius:999px;background:var(--bg-raised);color:var(--text)}
  .mcmeta-l{font-size:.66rem;color:var(--text-faint);padding:0 .3rem .2rem}
  .grp{display:flex;flex-direction:column;gap:.2rem}
  .gh{all:unset;cursor:pointer;display:flex;align-items:center;gap:.4rem;font-size:.66rem;font-weight:900;text-transform:uppercase;letter-spacing:.1em;color:var(--text-faint);padding:.45rem .3rem .25rem}
  .gh b{margin-left:auto;font-size:.68rem;background:var(--bg-inset);color:var(--text-dim);border-radius:999px;padding:.05rem .45rem;letter-spacing:0}
  .g-action .gh b{background:var(--crit);color:#fff}.g-check .gh b{background:var(--warn);color:#fff}
  .chev{display:inline-block;transition:transform .15s;font-size:.9rem}.chev.open{transform:rotate(90deg)}
  .row{all:unset;cursor:pointer;box-sizing:border-box;display:grid;grid-template-columns:22px minmax(0,1fr) auto;gap:.55rem;align-items:center;padding:.5rem .55rem;border-radius:10px;border:1px solid transparent;transition:background .12s}
  .row:hover{background:var(--bg-inset)}.row.sel{background:var(--bg-raised);border-color:var(--accent);box-shadow:var(--shadow-sm)}
  .dot{width:22px;height:22px;border-radius:50%;display:grid;place-items:center;font-size:.72rem;font-weight:900;color:#fff}
  .t-crit.dot{background:var(--crit)}.t-warn.dot{background:var(--warn)}.t-info.dot{background:var(--accent)}.t-none.dot{background:var(--text-faint)}
  .rt{display:flex;flex-direction:column;min-width:0}
  .rtt{font-size:.8rem;font-weight:700;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .rts{font-size:.64rem;color:var(--text-faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .cd{font-family:var(--font-mono);font-size:.8rem;font-weight:800;color:var(--text-dim);text-align:right}.cd small{font-size:.6rem;margin-left:1px}
  .cd.soon{color:var(--crit)}.cd.over{color:#fff;background:var(--crit);border-radius:6px;padding:0 .3rem}
  .none{font-size:.72rem;color:var(--text-faint);padding:.2rem .6rem}

  .rd{border:1px solid var(--rule);background:var(--bg-raised);border-radius:var(--radius-lg);overflow:hidden;display:flex;flex-direction:column}
  .rd.empty{padding:2rem;color:var(--text-dim)}
  .rh{padding:1.1rem 1.3rem 1rem;border-bottom:1px solid var(--rule);position:relative}
  .rh:before{content:"";position:absolute;inset:0 0 auto 0;height:4px;background:var(--rule)}
  .rh.t-crit:before{background:var(--crit)}.rh.t-warn:before{background:var(--warn)}.rh.t-info:before{background:var(--accent)}
  .rh-top{display:flex;gap:.45rem;align-items:center;flex-wrap:wrap}
  .badge{font-size:.62rem;font-weight:900;text-transform:uppercase;letter-spacing:.06em;padding:.22rem .6rem;border-radius:999px;color:#fff;background:var(--text-faint)}
  .badge.t-crit{background:var(--crit)}.badge.t-warn{background:var(--warn)}.badge.t-info{background:var(--accent)}
  .rid{font-family:var(--font-mono);font-size:.72rem;color:var(--text-faint)}
  .tagm{font-size:.62rem;font-weight:800;background:var(--warn-wash);color:var(--warn);border-radius:999px;padding:.12rem .5rem}
  .tagu{font-size:.62rem;background:var(--bg-inset);color:var(--text-dim);border-radius:999px;padding:.12rem .5rem}
  .mclink{margin-left:auto;font-size:.74rem;font-weight:700;color:var(--accent)}
  .rh h3{margin:.55rem 0 .1rem;font-size:1.28rem;line-height:1.25;letter-spacing:-.02em}
  .orig-t{font-size:.74rem;color:var(--text-faint);font-style:italic}
  .verdict{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:1rem;align-items:center;margin-top:.85rem;background:var(--bg-inset);border-radius:12px;padding:.75rem .9rem}
  .t-crit .verdict{background:var(--crit-wash)}.t-warn .verdict{background:var(--warn-wash)}.t-info .verdict{background:var(--accent-wash)}
  .vlab{font-size:.6rem;font-weight:900;text-transform:uppercase;letter-spacing:.1em;color:var(--text-faint)}
  .vtxt p{margin:.2rem 0 0;font-size:.92rem;line-height:1.45;font-weight:600}
  .vtxt a{display:inline-block;margin-top:.35rem;font-size:.76rem;font-weight:700;color:var(--accent)}
  .ring{width:96px;height:96px;border-radius:50%;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;border:5px solid var(--rule);background:var(--bg-raised);flex:none}
  .ring.t-crit{border-color:var(--crit)}
  .ring strong{font-size:1.55rem;line-height:1;letter-spacing:-.03em}.ring span{font-size:.54rem;text-transform:uppercase;font-weight:800;letter-spacing:.05em;color:var(--text-faint);line-height:1.15;margin-top:.15rem}
  .ring em{font-style:normal;font-size:.58rem;color:var(--text-dim);margin-top:.1rem}

  .tl{position:relative;height:84px;margin:.6rem 1.3rem .2rem}
  .tl-bar{position:absolute;left:0;right:0;top:28px;height:4px;border-radius:3px;background:linear-gradient(90deg,var(--rule),var(--accent))}
  .tl-today{position:absolute;top:14px;height:32px;border-left:2px dashed var(--text);transform:translateX(-1px)}
  .tl-today span{position:absolute;top:-14px;left:-14px;font-size:.6rem;font-weight:900;text-transform:uppercase;letter-spacing:.06em}
  .tl-pt{position:absolute;top:22px;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;width:130px;text-align:center}
  .tl-pt i{width:16px;height:16px;border-radius:50%;background:var(--bg-raised);border:3px solid var(--accent)}
  .tl-pt.due i{border-color:var(--crit);background:var(--crit)}.tl-pt.past i{border-color:var(--text-faint)}
  .tl-pt b{font-size:.68rem;margin-top:.2rem}.tl-pt span{font-size:.6rem;color:var(--text-faint);line-height:1.2}
  .tl-pt.due b{color:var(--crit)}
  .tl-pt.old b{text-decoration:line-through;color:var(--text-faint)}.tl-pt.old i{border-style:dashed;border-color:var(--text-faint)}
  .upd{font-size:.76rem;color:var(--text-dim);background:var(--bg-inset);border-radius:8px;padding:.45rem .65rem;margin-top:.6rem}
  .upd b{color:var(--text)}
  .doc a.mcref{font-family:var(--font-mono);font-size:.76rem;background:var(--accent-wash);padding:.05rem .35rem;border-radius:5px;text-decoration:none}

  .q4{display:grid;grid-template-columns:1fr 1fr;gap:.7rem;padding:1rem 1.3rem}
  .qa{border:1px solid var(--rule);border-radius:12px;padding:.7rem .85rem;background:var(--bg)}
  .qa h4{margin:0 0 .35rem;font-size:.66rem;text-transform:uppercase;letter-spacing:.1em;color:var(--text-faint);display:flex;gap:.4rem;align-items:center}
  .qa h4 i{font-style:normal;width:20px;height:20px;border-radius:6px;display:grid;place-items:center;background:var(--accent-wash);color:var(--accent);font-size:.72rem}
  .qa p{margin:0;font-size:.84rem;line-height:1.5}.qa ul{margin:0;padding-left:1rem;font-size:.82rem;line-height:1.45}
  .qa.todo{grid-column:1/-1;border-color:color-mix(in srgb,var(--accent) 35%,var(--rule))}
  .qa.todo h4 i{background:var(--accent);color:#fff}
  .qa ol{margin:0;padding:0;list-style:none;counter-reset:s;display:flex;flex-direction:column;gap:.4rem}
  .qa ol li{counter-increment:s;position:relative;padding-left:2rem;font-size:.86rem;line-height:1.45}
  .qa ol li:before{content:counter(s);position:absolute;left:0;top:0;width:1.4rem;height:1.4rem;border-radius:50%;background:var(--accent);color:#fff;font-weight:900;font-size:.72rem;display:grid;place-items:center}
  .dimp{color:var(--text-dim)}
  .plats{display:flex;gap:.3rem;flex-wrap:wrap;margin-top:.45rem}.plats span{font-size:.64rem;font-weight:800;background:#ede7f6;color:#5e35b1;border-radius:999px;padding:.1rem .5rem}

  .orig{margin:0 1.3rem 1.2rem;border:1px solid var(--rule);border-radius:12px}
  .orig summary{cursor:pointer;padding:.6rem .85rem;font-size:.8rem;font-weight:800;display:flex;justify-content:space-between;list-style:none}
  .orig summary::-webkit-details-marker{display:none}.orig summary span{font-weight:500;color:var(--text-faint);font-size:.72rem}
  .orig[open] summary{border-bottom:1px solid var(--rule)}
  .doc{padding:.4rem 1.1rem 1rem;max-width:72ch}
  .doc section{margin-top:.8rem}
  .doc h5{margin:0 0 .3rem;font-size:.86rem;display:flex;align-items:center;gap:.4rem}
  .doc h5 i{font-style:normal;color:var(--accent)}.doc h5 small{font-weight:500;color:var(--text-faint);font-size:.68rem;margin-left:.2rem}
  .doc h6{margin:.6rem 0 .15rem;font-size:.74rem;text-transform:uppercase;letter-spacing:.05em;color:var(--text-dim)}
  .doc p{margin:.25rem 0;font-size:.82rem;line-height:1.6;color:var(--text)}
  .doc p.li{padding-left:1.1rem;position:relative;margin:.15rem 0}.doc p.li:before{content:"";position:absolute;left:.3rem;top:.6em;width:5px;height:5px;border-radius:50%;background:var(--accent)}
  .doc a{color:var(--accent);font-weight:600;word-break:break-word}

  @media(max-width:1100px){.mcw{grid-template-columns:1fr}.mcl{position:static;max-height:none}}
  @media(max-width:700px){.q4{grid-template-columns:1fr}.verdict{grid-template-columns:1fr}.tl{display:none}}
</style>
