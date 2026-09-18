<script>
  // Zuweisungen & Audit — drei Sichten auf dieselbe Frage: wer bekommt was, und
  // über welche Gruppe.
  //
  //  - Apps: App › App-Gruppe › verschachtelte GroupTag-Gerätegruppe › Gerät.
  //    Dazu der Fixer: Apps, die direkt an einer Gerätegruppe hängen, auf ihre
  //    App-Gruppe umstellen (Gruppe nach Konvention anlegen, Gerätegruppe
  //    verschachteln, Direktzuweisung ersetzen). Jede Umstellung ist protokolliert
  //    und zurücknehmbar.
  //  - Richtlinien: OIB (oder alle Intune-Richtlinien) mit Zuweisung, effektiven
  //    Geräten und dem, was sie einstellen.
  //  - Conditional Access: aktiv / nur Bericht / aus, was die Richtlinie verlangt,
  //    für wen sie effektiv gilt, wer ausgenommen ist.
  //
  // Auswerten ist rein lesend und läuft als Job im Hintergrund; das Ergebnis
  // bleibt pro Tenant gespeichert, PDF und CSV entstehen daraus.
  import { apiGet, apiPost, fileDownload, errText } from '../lib/api.js'
  import { activeTenant } from '../lib/tenantStore.js'
  import { session } from '../lib/session.js'
  import { activeTab } from '../lib/tabStore.js'
  import TenantContext from '../lib/TenantContext.svelte'

  const KIND_LABEL = { apps: 'Apps', policies: 'Richtlinien', ca: 'Conditional Access' }

  let sub = $state('apps')
  let data = $state({ apps: null, policies: null, ca: null })
  let loading = $state(false)
  let error = $state(null)
  let notice = $state(null)
  let job = $state(null)          // { id, kinds, status, phase, error, hint }

  // Optionen der Auswertung
  let optInstall = $state(true)
  let optScope = $state('oib')
  let optSignIns = $state(false)
  let optDays = $state(7)
  let optAppendix = $state(true)   // Anhang "Abweichungen" ins Doku-PDF

  const tid = () => encodeURIComponent($activeTenant.id)
  const busy = $derived(!!job && job.status === 'running')

  let loadedFor = null
  $effect(() => {
    const t = $activeTenant
    if ($activeTab !== 'zuweisungen') return
    if (!$session.loggedIn || !t) return
    if (loadedFor === t.id) return
    loadedFor = t.id
    data = { apps: null, policies: null, ca: null }
    plans = null; log = []; job = null; error = null; notice = null
    loadStored()
    loadLog()
  })

  async function loadStored() {
    loading = true
    try {
      const r = await apiGet(`/api/tenants/${tid()}/assignaudit`)
      data = { apps: r.apps || null, policies: r.policies || null, ca: r.ca || null }
      if (data.policies && data.policies.scope) optScope = data.policies.scope
    } catch (e) { error = errText(e) }
    loading = false
  }

  function poll(jobId, done) {
    setTimeout(async () => {
      let j
      try { j = await apiGet(`/api/appjobs/${encodeURIComponent(jobId)}`) }
      catch (e) { job = { ...(job || {}), status: 'failed', error: errText(e) }; return }
      job = { ...(job || {}), ...j }
      if (j.status === 'running') { poll(jobId, done); return }
      if (done) await done(j)
    }, 1200)
  }

  async function run(kinds) {
    error = null; notice = null
    try {
      const r = await apiPost(`/api/tenants/${tid()}/assignaudit/run`, {
        kinds, installStatus: optInstall, policyScope: optScope, signIns: optSignIns, signInDays: optDays
      })
      job = { id: r.jobId, kinds, status: 'running', phase: 'Start' }
      poll(r.jobId, async (j) => {
        await loadStored()
        if (j.status === 'failed') error = j.error || 'Auswertung fehlgeschlagen.'
        else if (j.hint) notice = j.hint
      })
    } catch (e) { error = errText(e) }
  }

  const available = $derived(Object.keys(KIND_LABEL).filter(k => data[k]))
  function pdf(kinds) { fileDownload(`/api/tenants/${tid()}/assignaudit/report.pdf?kinds=${kinds.join(',')}&anhang=${optAppendix ? 1 : 0}`) }
  function csv(kind) { fileDownload(`/api/tenants/${tid()}/assignaudit/export.csv?kind=${kind}`) }

  function fmt(iso) {
    if (!iso) return '—'
    const d = new Date(iso)
    return d.toLocaleString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  }
  function pl(n, one, many) { return `${n} ${n === 1 ? one : many}` }
  function age(iso) {
    if (!iso) return ''
    const h = Math.round((Date.now() - new Date(iso).getTime()) / 36e5)
    return h < 1 ? 'gerade eben' : h < 48 ? `vor ${h} h` : `vor ${Math.round(h / 24)} Tagen`
  }

  // ================================================================ Apps
  const STATUS = {
    fix: { label: 'Korrigierbar', cls: 'crit' },
    manual: { label: 'Prüfen', cls: 'warn' },
    ok: { label: 'Konform', cls: 'ok' },
    unassigned: { label: 'Ohne Zuweisung', cls: '' }
  }
  let appFilter = $state('all')
  let appSearch = $state('')
  const appsShown = $derived(
    (data.apps?.apps || []).filter(a => (appFilter === 'all' || a.status === appFilter)
      && (!appSearch.trim() || [a.displayName, a.publisher, ...a.assignments.map(x => x.group?.displayName)].join(' ').toLowerCase().includes(appSearch.trim().toLowerCase())))
  )

  const KIND_CLASS = { appGroup: 'app', container: 'app', deviceGroup: 'dev', userGroup: 'usr', mixed: 'bad', empty: 'bad', missing: 'bad' }
  function targetName(a) {
    if (a.group) return a.group.displayName
    return { allDevices: 'Alle Geräte', allUsers: 'Alle Benutzer' }[a.targetKind] || a.targetKind
  }

  // ---------------------------------------------------------------- Fixer
  let plans = $state(null)
  let planLoading = $state(false)
  let planSel = $state({})         // appId -> bool
  let planName = $state({})        // appId -> Name der neuen Gruppe
  let planTarget = $state({})      // appId -> gewählte vorhandene Gruppe ('' = Vorschlag)
  let renames = $state([])
  let existingGroups = $state([])
  let fixResults = $state(null)

  async function loadPlans() {
    planLoading = true; error = null
    try {
      const r = await apiGet(`/api/tenants/${tid()}/appassign/plans`)
      plans = r.plans || []
      renames = r.renames || []
      existingGroups = r.existingAppGroups || []
      const sel = {}, names = {}
      for (const p of plans) { sel[p.appId] = p.applicable; names[p.appId] = p.target.displayName }
      planSel = sel; planName = names; planTarget = {}
    } catch (e) { error = errText(e) }
    planLoading = false
  }

  const selectedPlans = $derived((plans || []).filter(p => planSel[p.appId] && p.applicable))

  function targetLabel(p) {
    const gid = planTarget[p.appId]
    if (gid) return (existingGroups.find(g => g.id === gid) || {}).displayName || gid
    return p.target.id ? p.target.displayName : (planName[p.appId] || p.target.displayName)
  }

  async function applyPlans() {
    const sel = selectedPlans
    if (!sel.length) return
    const lines = sel.map(p => {
      const neu = !planTarget[p.appId] && !p.target.id
      return `• ${p.appName}: ${neu ? 'neue Gruppe ' : ''}${targetLabel(p)} ← ${p.nest.map(n => n.displayName).join(', ')} (${p.intentLabel})`
    })
    if (!confirm(`${sel.length} App(s) im Tenant ${$activeTenant.name} umstellen?\n\n${lines.join('\n')}\n\n`
      + 'Je App: App-Gruppe anlegen bzw. verwenden, Gerätegruppe(n) darin verschachteln, dann die Direktzuweisung '
      + 'durch die App-Gruppe ersetzen (gleicher Intent, Filter und Einstellungen). Kein Gerät verliert die App. '
      + 'Jeder Schritt wird protokolliert und lässt sich zurücknehmen.')) return

    error = null; notice = null; fixResults = null
    try {
      const r = await apiPost(`/api/tenants/${tid()}/appassign/apply`, {
        items: sel.map(p => ({
          appId: p.appId,
          targetGroupId: planTarget[p.appId] || undefined,
          targetName: !planTarget[p.appId] && !p.target.id ? planName[p.appId] : undefined
        }))
      })
      job = { id: r.jobId, kinds: ['fix'], status: 'running', phase: 'Start' }
      poll(r.jobId, async (j) => {
        fixResults = j.results || []
        if (j.status === 'failed') error = j.error
        const done = fixResults.filter(x => x.status === 'done').length
        notice = `${done} von ${sel.length} App(s) umgestellt.` + (j.hint ? ' ' + j.hint : '')
        await loadLog()
        await loadPlans()
        run(['apps'])
      })
    } catch (e) { error = errText(e) }
  }

  async function renameGroup(r) {
    if (!confirm(`App-Gruppe „${r.from}“ in „${r.to}“ umbenennen?\n\nDie Gruppen-Id bleibt, damit auch alle Zuweisungen und Mitgliedschaften. `
      + `Patch My PC und Skripte, die die Gruppe über den NAMEN suchen, müssen nachgezogen werden.\n\nDas schreibt in den Tenant ${$activeTenant.name}.`)) return
    error = null
    try {
      await apiPost(`/api/tenants/${tid()}/appassign/rename`, { groupId: r.groupId, name: r.to })
      notice = `„${r.from}“ heisst jetzt „${r.to}“.`
      await loadLog(); await loadPlans()
    } catch (e) { error = errText(e) }
  }

  // ---------------------------------------------------------------- Protokoll
  let log = $state([])
  let logOpen = $state(false)
  const LOG_STATUS = { done: 'erledigt', partial: 'teilweise', failed: 'fehlgeschlagen', skipped: 'übersprungen' }
  async function loadLog() {
    try { log = (await apiGet(`/api/tenants/${tid()}/appassign/log`)).log || [] } catch (e) { log = [] }
  }
  async function rollback(e) {
    if (!confirm(`Umstellung von „${e.app}“ zurücknehmen?\n\nDie Zuweisungsliste der App wird auf den Stand vom ${fmt(e.at)} zurückgesetzt. `
      + `Angelegte Gruppen und Verschachtelungen bleiben stehen.\n\nDas schreibt in den Tenant ${$activeTenant.name}.`)) return
    error = null
    try {
      await apiPost(`/api/tenants/${tid()}/appassign/rollback`, { logId: e.id })
      notice = `„${e.app}“ ist zurückgesetzt.`
      await loadLog()
      run(['apps'])
    } catch (err) { error = errText(err) }
  }

  // ================================================================ Richtlinien
  let polFilter = $state('all')
  let polSearch = $state('')
  const polShown = $derived(
    (data.policies?.policies || []).filter(p => {
      if (polFilter === 'findings' && !p.findings.some(f => f.severity !== 'hinweis')) return false
      if (polFilter === 'unassigned' && p.assignments.some(a => !a.exclude)) return false
      const q = polSearch.trim().toLowerCase()
      return !q || [p.name, p.type, ...p.assignments.map(a => a.group?.displayName)].join(' ').toLowerCase().includes(q)
    })
  )
  let settingsAll = $state({})

  // ================================================================ Conditional Access
  let caSearch = $state('')
  let matrixLimit = $state(150)
  const matrixShown = $derived(
    (data.ca?.matrix || []).filter(u => !caSearch.trim() || (u.upn + ' ' + u.name).toLowerCase().includes(caSearch.trim().toLowerCase()))
  )
  const CA_CLS = { enabled: 'ok', enabledForReportingButNotEnforced: 'warn', disabled: '' }
  const SIGNIN_LABEL = {
    success: 'erfüllt', failure: 'nicht erfüllt / blockiert', notApplied: 'nicht angewendet',
    reportOnlySuccess: 'Bericht: wäre erfüllt', reportOnlyFailure: 'Bericht: wäre blockiert',
    reportOnlyNotApplied: 'Bericht: nicht angewendet', reportOnlyInterrupted: 'Bericht: hätte unterbrochen', notEnabled: 'nicht aktiv'
  }
</script>

<TenantContext>
  <div class="za">
    <p class="ld-section-hint">
      Rein lesende Auswertung, bis aufs Gerät bzw. Konto aufgelöst — mit dem Weg dorthin. Ergebnis bleibt pro Tenant
      gespeichert; PDF und CSV entstehen daraus. Nur der App-Fixer schreibt, und nur auf ausdrücklichen Klick.
    </p>

    <div class="za-top">
      <div class="dl-subtabs za-subtabs">
        {#each Object.entries(KIND_LABEL) as [k, label]}
          <button type="button" class="dl-subtab" class:active={sub === k} onclick={() => (sub = k)}>
            {label}
            {#if k === 'apps' && data.apps?.summary.fix}<span class="tbadge crit">{data.apps.summary.fix}</span>{/if}
          </button>
        {/each}
      </div>
      <div class="za-top-actions">
        <button class="btn btn-secondary" disabled={busy} onclick={() => run(['apps', 'policies', 'ca'])}>Alles auswerten</button>
        <label class="za-opt" title="Anhang mit den Abweichungen vom Zuweisungskonzept — für die Doku an den Kunden abwählen">
          <input type="checkbox" bind:checked={optAppendix} /> Abweichungen als Anhang
        </label>
        <button class="btn btn-primary" disabled={!available.length} onclick={() => pdf(available)}
                title="Konfigurationsdokumentation mit allen bereits ausgewerteten Bereichen">Konfig-Doku (PDF)</button>
      </div>
    </div>

    {#if error}<div class="alert alert-warning">❌ {error}</div>{/if}
    {#if notice}<div class="ld-banner ok">{notice}</div>{/if}

    {#if job && job.status === 'running'}
      <div class="ld-job za-job">
        <span class="ld-spinner"></span>
        <div>
          <strong>{job.kinds && job.kinds[0] === 'fix' ? 'Umstellung läuft' : 'Auswertung läuft'}</strong>
          <div class="ld-job-meta">{job.phase || '…'}</div>
        </div>
      </div>
    {/if}

    <!-- ============================================================ APPS -->
    {#if sub === 'apps'}
      <div class="za-bar">
        <div class="za-stamp">
          {#if data.apps}Datenstand {fmt(data.apps.generatedAt)} <span class="za-age">({age(data.apps.generatedAt)})</span>{:else if !loading}Noch nicht ausgewertet.{/if}
        </div>
        <label class="za-opt"><input type="checkbox" bind:checked={optInstall} /> Installationsstatus je Gerät mitlesen</label>
        <button class="btn btn-secondary" disabled={busy} onclick={() => run(['apps'])}>{data.apps ? '↻ Neu auswerten' : 'Auswerten'}</button>
        <button class="btn btn-secondary" disabled={!data.apps} onclick={() => pdf(['apps'])}>Doku-PDF</button>
        <button class="btn btn-secondary" disabled={!data.apps} onclick={() => csv('apps')}>CSV</button>
      </div>

      {#if data.apps}
        {@const s = data.apps.summary}
        <div class="rep-metrics za-metrics">
          <div class="rep-metric"><div class="rep-metric-value">{s.apps}</div><div class="rep-metric-label">Apps</div></div>
          <div class="rep-metric"><div class="rep-metric-value za-ok">{s.ok}</div><div class="rep-metric-label">Konform</div></div>
          <div class="rep-metric" class:crit={s.fix}><div class="rep-metric-value">{s.fix}</div><div class="rep-metric-label">Korrigierbar</div></div>
          <div class="rep-metric" class:warn={s.manual}><div class="rep-metric-value">{s.manual}</div><div class="rep-metric-label">Prüfen</div></div>
          <div class="rep-metric"><div class="rep-metric-value">{s.unassigned}</div><div class="rep-metric-label">Ohne Zuweisung</div></div>
          <div class="rep-metric"><div class="rep-metric-value">{s.devices}</div><div class="rep-metric-label">Geräte erreicht</div></div>
        </div>
        {#if data.apps.readable && !data.apps.readable.managedDevices}
          <div class="alert alert-warning">Intune-Gerätedetails (Name, Primärbenutzer, Compliance) waren nicht lesbar — im Tab «Tenants» einmal <strong>Reparieren</strong>, dann neu auswerten.</div>
        {/if}
      {/if}

      <!-- ---------------- Fixer -->
      <div class="settings-group za-fixer">
        <div class="za-fixer-head">
          <div>
            <h4>App-Zuweisungen korrigieren</h4>
            <p class="ld-section-hint" style="margin:0">
              Soll: <strong>App › App-Gruppe › GroupTag-Gerätegruppe</strong>. Apps, die direkt an einer Gerätegruppe hängen,
              werden auf ihre App-Gruppe nach Namenskonvention umgestellt. Der Plan wird frisch aus dem Tenant gelesen.
            </p>
          </div>
          <button class="btn btn-secondary" disabled={planLoading || busy} onclick={loadPlans}>
            {planLoading ? 'Lese Tenant…' : plans ? '↻ Plan neu laden' : 'Korrekturplan laden'}
          </button>
        </div>

        {#if plans && !plans.length}
          <div class="ld-banner ok">Keine App hängt direkt an einer Gerätegruppe — nichts umzustellen.</div>
        {/if}

        {#if plans && plans.length}
          <div class="za-plans">
            {#each plans as p (p.appId)}
              <div class="za-plan" class:za-plan-off={!p.applicable}>
                <label class="za-plan-head">
                  <input type="checkbox" bind:checked={planSel[p.appId]} disabled={!p.applicable} />
                  <strong>{p.appName}</strong>
                  {#if p.managedBy === 'pmp'}<span class="tbadge">Patch My PC</span>{/if}
                  <span class="za-dim">{p.intentLabel}</span>
                  {#if !p.applicable}<span class="tbadge warn">manuell</span>{/if}
                </label>

                <div class="za-plan-body">
                  <div class="za-flow">
                    <span class="za-node app">
                      {#if !p.target.id && !planTarget[p.appId]}
                        <input class="za-name" bind:value={planName[p.appId]} disabled={!p.applicable} aria-label="Name der neuen App-Gruppe" />
                        <small>neu anlegen</small>
                      {:else}
                        {targetLabel(p)}<small>{p.target.source === 'assigned' ? 'schon zugewiesen' : 'vorhanden'}</small>
                      {/if}
                    </span>
                    <span class="za-arrow">⊃</span>
                    {#each p.nest as n}
                      <span class="za-node dev">{n.displayName}<small>{n.already ? 'schon verschachtelt' : 'wird verschachtelt'}</small></span>
                    {/each}
                  </div>
                  {#if !p.target.id && existingGroups.length}
                    <div class="za-plan-alt">
                      <label>stattdessen vorhandene App-Gruppe:
                        <select bind:value={planTarget[p.appId]} disabled={!p.applicable}>
                          <option value="">— neue Gruppe nach Konvention —</option>
                          {#each existingGroups as g}<option value={g.id}>{g.displayName}</option>{/each}
                        </select>
                      </label>
                    </div>
                  {/if}
                  <div class="za-dim za-small">
                    Direktzuweisung entfällt: {p.remove.map(r => r.displayName).join(', ')}
                    {#if p.filter} · Filter {p.filter.mode}: {p.filter.name}{/if}
                    {#if p.settings?.length} · {p.settings.join(' · ')}{/if}
                  </div>
                  {#each p.conflicts as c}<div class="za-line crit">⛔ {c}</div>{/each}
                  {#each p.warnings as w}<div class="za-line warn">⚠ {w}</div>{/each}
                </div>
              </div>
            {/each}
          </div>
          <div class="za-plan-actions">
            <button class="za-link" onclick={() => { for (const p of plans) planSel[p.appId] = p.applicable }}>alle</button>
            <button class="za-link" onclick={() => (planSel = {})}>keine</button>
            <button class="btn btn-primary" disabled={!selectedPlans.length || busy} onclick={applyPlans}>
              {selectedPlans.length} App(s) umstellen
            </button>
          </div>
        {/if}

        {#if renames.length}
          <h5 class="za-h5">App-Gruppen nach altem Namensschema</h5>
          {#each renames as r (r.groupId)}
            <div class="za-rename">
              <code>{r.from}</code> <span class="za-arrow">→</span> <code>{r.to}</code>
              <span class="za-dim">({r.app})</span>
              <button class="btn btn-secondary za-btn-sm" disabled={busy} onclick={() => renameGroup(r)}>Umbenennen</button>
            </div>
          {/each}
        {/if}

        {#if fixResults && fixResults.length}
          <h5 class="za-h5">Ergebnis der letzten Umstellung</h5>
          {#each fixResults as r}
            <div class="za-line" class:crit={r.status === 'failed'} class:warn={r.status === 'partial' || r.status === 'skipped'}>
              <strong>{r.app}</strong> —
              {r.status === 'done' ? 'umgestellt' : r.status === 'partial' ? 'teilweise, bitte prüfen' : r.status === 'skipped' ? 'übersprungen' : 'fehlgeschlagen'}
              {#if r.message}: {r.message}{/if}
              {#if r.steps}<div class="za-dim za-small">{r.steps.join(' · ')}</div>{/if}
            </div>
          {/each}
        {/if}

        <details class="za-log" bind:open={logOpen}>
          <summary>Protokoll ({log.length})</summary>
          {#if !log.length}
            <p class="ld-section-hint">Noch keine Umstellung in diesem Tenant.</p>
          {:else}
            <div class="gt-table-wrap">
              <table class="gt-table">
                <thead><tr><th>Zeit</th><th>Wer</th><th>Was</th><th>Status</th><th></th></tr></thead>
                <tbody>
                  {#each log as e (e.id)}
                    <tr>
                      <td>{fmt(e.at)}</td>
                      <td class="za-small">{e.user}</td>
                      <td>
                        {#if e.type === 'fix'}
                          <strong>{e.app}</strong>{#if e.target} › {e.target.displayName}{/if}
                          {#if e.removed}<div class="za-dim za-small">direkt entfernt: {e.removed.join(', ')}</div>{/if}
                          {#if e.error}<div class="za-line crit">{e.error}</div>{/if}
                        {:else if e.type === 'rollback'}
                          Zurückgenommen: <strong>{e.app}</strong>
                        {:else if e.type === 'rename'}
                          Umbenannt: <code>{e.from}</code> → <code>{e.to}</code>
                        {/if}
                      </td>
                      <td>
                        <span class="tbadge" class:ok={e.status === 'done'} class:warn={e.status === 'partial'} class:crit={e.status === 'failed'}>{LOG_STATUS[e.status] || e.status}</span>
                        {#if e.rolledBackAt}<div class="za-dim za-small">zurückgenommen {fmt(e.rolledBackAt)}</div>{/if}
                      </td>
                      <td>
                        {#if e.type === 'fix' && e.before && !e.rolledBackAt && e.status !== 'failed'}
                          <button class="btn btn-secondary za-btn-sm" disabled={busy} onclick={() => rollback(e)}>Rückgängig</button>
                        {/if}
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}
        </details>
      </div>

      <!-- ---------------- Liste -->
      {#if data.apps}
        <div class="za-filterbar">
          {#each [['all', 'Alle'], ['fix', 'Korrigierbar'], ['manual', 'Prüfen'], ['ok', 'Konform'], ['unassigned', 'Ohne Zuweisung']] as [k, l]}
            <button class="topic-chip" class:active={appFilter === k} onclick={() => (appFilter = k)}>{l}</button>
          {/each}
          <input class="za-search" type="search" placeholder="App oder Gruppe suchen…" bind:value={appSearch} />
        </div>

        {#each appsShown as a (a.id)}
          <details class="za-item">
            <summary>
              <span class="za-item-name">{a.displayName}</span>
              <span class="za-dim za-small">{a.type} · {a.managedByLabel}</span>
              <span class="za-item-right">
                <span class="za-dim za-small">{a.devices.length} Gerät{a.devices.length === 1 ? '' : 'e'}{a.users.length ? ` · ${a.users.length} Benutzer` : ''}</span>
                <span class="tbadge {STATUS[a.status].cls}">{STATUS[a.status].label}</span>
              </span>
            </summary>
            <div class="za-item-body">
              {#each a.findings as f}
                <div class="za-line" class:crit={f.severity === 'fehler'} class:warn={f.severity === 'warn'}>{f.text}{#if f.fix} <span class="tbadge">automatisch korrigierbar</span>{/if}</div>
              {/each}

              {#each a.assignments as as}
                <div class="za-flow">
                  <span class="za-intent" class:za-excl={as.exclude}>{as.exclude ? 'Ausschluss' : as.intentLabel}</span>
                  <span class="za-arrow">›</span>
                  <span class="za-node {as.group ? KIND_CLASS[as.group.kind] || '' : 'bad'}">
                    {targetName(as)}
                    {#if as.group}<small>{as.group.kindLabel}{as.group.tags?.length ? ' · ' + as.group.tags.join(', ') : ''}</small>{/if}
                  </span>
                  {#if as.group?.memberGroups?.length}
                    <span class="za-arrow">⊃</span>
                    {#each as.group.memberGroups as mg}
                      <span class="za-node {KIND_CLASS[mg.kind] || ''}">{mg.displayName}<small>{mg.kindLabel || ''}{mg.tags?.length ? ' · ' + mg.tags.join(', ') : ''}</small></span>
                    {/each}
                  {/if}
                  {#if as.deviceCount !== null}<span class="za-dim za-small">{as.deviceCount} Gerät{as.deviceCount === 1 ? '' : 'e'}</span>{/if}
                  {#if as.filter}<span class="tbadge">Filter {as.filter.mode}: {as.filter.name}</span>{/if}
                </div>
                {#if as.settings?.length}<div class="za-dim za-small za-indent">{as.settings.join(' · ')}</div>{/if}
              {/each}

              {#if a.devices.length}
                <div class="gt-table-wrap za-devtable">
                  <table class="gt-table">
                    <thead><tr><th>Gerät</th><th>GroupTag</th><th>Erreicht über</th><th>Benutzer</th><th>Compliance</th>{#if a.install}<th>Installation</th>{/if}</tr></thead>
                    <tbody>
                      {#each a.devices as d (d.id)}
                        <tr>
                          <td><strong>{d.name}</strong><div class="za-dim za-small">{d.os} {d.osVersion}</div></td>
                          <td>{d.groupTag || '—'}</td>
                          <td class="za-small">{d.via}{#if d.viaCount > 1} <span class="tbadge warn" title="Das Gerät ist über mehrere Wege adressiert">+{d.viaCount - 1}</span>{/if}</td>
                          <td class="za-small">{d.user || '—'}</td>
                          <td class="za-small">{d.compliance || '—'}</td>
                          {#if a.install}
                            <td class="za-small">
                              {#if d.installLabel}<span class="tbadge" class:ok={d.install === 'installed'} class:crit={d.install === 'failed'} class:warn={d.install === 'pendinginstall'}>{d.installLabel}</span>{:else}—{/if}
                              {#if d.installDetail}<div class="za-dim">{d.installDetail}</div>{/if}
                            </td>
                          {/if}
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                </div>
              {:else if a.users.length}
                <p class="za-dim za-small">Benutzerzuweisung: {a.users.map(u => u.upn || u.name).join(', ')}</p>
              {/if}
            </div>
          </details>
        {:else}
          <p class="ld-section-hint">Keine App für diesen Filter.</p>
        {/each}
      {/if}
    {/if}

    <!-- ============================================================ RICHTLINIEN -->
    {#if sub === 'policies'}
      <div class="za-bar">
        <div class="za-stamp">
          {#if data.policies}Datenstand {fmt(data.policies.generatedAt)} <span class="za-age">({age(data.policies.generatedAt)})</span> · {data.policies.scope === 'oib' ? 'nur OIB' : 'alle Richtlinien'}{:else if !loading}Noch nicht ausgewertet.{/if}
        </div>
        <label class="za-opt">Umfang
          <select bind:value={optScope}>
            <option value="oib">OpenIntuneBaseline (Win/MacOS - OIB)</option>
            <option value="all">alle Intune-Richtlinien</option>
          </select>
        </label>
        <button class="btn btn-secondary" disabled={busy} onclick={() => run(['policies'])}>{data.policies ? '↻ Neu auswerten' : 'Auswerten'}</button>
        <button class="btn btn-secondary" disabled={!data.policies} onclick={() => pdf(['policies'])}>Doku-PDF</button>
        <button class="btn btn-secondary" disabled={!data.policies} onclick={() => csv('policies')}>CSV</button>
      </div>

      {#if data.policies}
        {@const s = data.policies.summary}
        <div class="rep-metrics za-metrics">
          <div class="rep-metric"><div class="rep-metric-value">{s.policies}</div><div class="rep-metric-label">Richtlinien</div></div>
          <div class="rep-metric"><div class="rep-metric-value za-ok">{s.assigned}</div><div class="rep-metric-label">Zugewiesen</div></div>
          <div class="rep-metric" class:warn={s.unassigned}><div class="rep-metric-value">{s.unassigned}</div><div class="rep-metric-label">Nicht zugewiesen</div></div>
          <div class="rep-metric" class:warn={s.withFindings}><div class="rep-metric-value">{s.withFindings}</div><div class="rep-metric-label">Mit Befund</div></div>
          <div class="rep-metric"><div class="rep-metric-value">{s.devices}</div><div class="rep-metric-label">Geräte erreicht</div></div>
        </div>
        {#if (data.policies.sourceErrors || []).length}
          <div class="alert alert-warning">Nicht lesbar: {data.policies.sourceErrors.map(e => e.source).join(', ')} — {data.policies.sourceErrors[0].error}</div>
        {/if}

        {#if data.policies.coverage?.length}
          <div class="settings-group">
            <h4>Abdeckung je Gerätegruppe</h4>
            <p class="ld-section-hint" style="margin-top:0">Welche Richtlinien eine Gerätegruppe nicht bekommt — auch über verschachtelte Gruppen gezählt, Benutzerrichtlinien ausgenommen.</p>
            <div class="gt-table-wrap">
              <table class="gt-table">
                <thead><tr><th>Gerätegruppe</th><th>Geräte</th><th>Zugewiesen</th><th>Fehlt</th></tr></thead>
                <tbody>
                  {#each data.policies.coverage as c (c.id)}
                    <tr class:ac-issue={c.missing.length}>
                      <td><strong>{c.displayName}</strong>{#if c.tags?.length}<div class="za-dim za-small">{c.tags.join(', ')}</div>{/if}</td>
                      <td>{c.devices ?? '—'}</td>
                      <td>{c.assigned}</td>
                      <td class="za-small">{#if c.missing.length}{c.missing.join(' · ')}{:else}<span class="tbadge ok">vollständig</span>{/if}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          </div>
        {/if}

        <div class="za-filterbar">
          {#each [['all', 'Alle'], ['findings', 'Mit Befund'], ['unassigned', 'Nicht zugewiesen']] as [k, l]}
            <button class="topic-chip" class:active={polFilter === k} onclick={() => (polFilter = k)}>{l}</button>
          {/each}
          <input class="za-search" type="search" placeholder="Richtlinie oder Gruppe suchen…" bind:value={polSearch} />
        </div>

        {#each polShown as p (p.id)}
          <details class="za-item">
            <summary>
              <span class="za-item-name">{p.name}</span>
              <span class="za-dim za-small">{p.type} · {p.platform}</span>
              <span class="za-item-right">
                <span class="za-dim za-small">{p.devices.length} Gerät{p.devices.length === 1 ? '' : 'e'}{p.users.length ? ` · ${p.users.length} Benutzer` : ''}</span>
                {#if !p.assignments.some(a => !a.exclude)}<span class="tbadge warn">nicht zugewiesen</span>
                {:else if p.findings.some(f => f.severity === 'fehler')}<span class="tbadge crit">Befund</span>
                {:else if p.findings.some(f => f.severity === 'warn')}<span class="tbadge warn">Befund</span>
                {:else}<span class="tbadge ok">zugewiesen</span>{/if}
              </span>
            </summary>
            <div class="za-item-body">
              {#if p.oibParts}
                <div class="za-kv"><span>Zweck</span><span>{p.oibParts.bereich} — {p.oibParts.inhalt}</span></div>
                <div class="za-kv"><span>Geltung</span><span>{p.oibParts.geltung}{p.oibParts.version ? ' · OIB ' + p.oibParts.version : ''}</span></div>
              {/if}
              {#if p.description}<div class="za-kv"><span>Beschreibung</span><span>{p.description}</span></div>{/if}
              {#each p.findings as f}
                <div class="za-line" class:crit={f.severity === 'fehler'} class:warn={f.severity === 'warn'}>{f.text}</div>
              {/each}
              {#each p.assignments as as}
                <div class="za-flow">
                  <span class="za-intent" class:za-excl={as.exclude}>{as.exclude ? 'Ausschluss' : 'Zugewiesen'}</span>
                  <span class="za-arrow">›</span>
                  <span class="za-node {as.group ? KIND_CLASS[as.group.kind] || '' : 'bad'}">{targetName(as)}{#if as.group}<small>{as.group.kindLabel}</small>{/if}</span>
                  {#if as.nestedGroups?.length}
                    <span class="za-arrow">⊃</span>
                    {#each as.nestedGroups as ng}<span class="za-node dev">{ng.displayName}</span>{/each}
                  {/if}
                  {#if as.deviceCount !== null && as.deviceCount !== undefined}<span class="za-dim za-small">{pl(as.deviceCount, 'Gerät', 'Geräte')}{as.userCount ? ` · ${as.userCount} Benutzer` : ''}</span>{/if}
                  {#if as.filter}<span class="tbadge">Filter {as.filter.mode}: {as.filter.name}</span>{/if}
                </div>
              {/each}
              {#if p.devices.length}
                <div class="za-chips">
                  {#each p.devices.slice(0, 120) as d (d.id)}<span class="gt-tag" title={d.via}>{d.name}{d.groupTag ? ' · ' + d.groupTag : ''}</span>{/each}
                  {#if p.devices.length > 120}<span class="za-dim za-small">… +{p.devices.length - 120}</span>{/if}
                </div>
              {/if}
              {#if p.settings.length}
                <h5 class="za-h5">Einstellungen ({p.settingsTotal})</h5>
                <div class="gt-table-wrap">
                  <table class="gt-table za-settings">
                    <tbody>
                      {#each (settingsAll[p.id] ? p.settings : p.settings.slice(0, 40)) as st}
                        <tr><td style="padding-left:{0.6 + (st.depth || 0) * 1.1}rem" class:za-sub={st.depth}>{st.label}</td><td>{st.value}</td></tr>
                      {/each}
                    </tbody>
                  </table>
                </div>
                {#if p.settings.length > 40 && !settingsAll[p.id]}
                  <button class="za-link" onclick={() => (settingsAll[p.id] = true)}>alle {p.settings.length} anzeigen</button>
                {/if}
              {:else if p.settingsError}
                <p class="za-dim za-small">Einstellungen nicht lesbar: {p.settingsError}</p>
              {/if}
            </div>
          </details>
        {:else}
          <p class="ld-section-hint">Keine Richtlinie für diesen Filter.</p>
        {/each}
      {/if}
    {/if}

    <!-- ============================================================ CONDITIONAL ACCESS -->
    {#if sub === 'ca'}
      <div class="za-bar">
        <div class="za-stamp">
          {#if data.ca}Datenstand {fmt(data.ca.generatedAt)} <span class="za-age">({age(data.ca.generatedAt)})</span>{:else if !loading}Noch nicht ausgewertet.{/if}
        </div>
        <label class="za-opt"><input type="checkbox" bind:checked={optSignIns} /> Anmeldeprotokoll der letzten
          <select bind:value={optDays} disabled={!optSignIns}><option value={1}>1</option><option value={7}>7</option><option value={14}>14</option><option value={30}>30</option></select> Tage auswerten</label>
        <button class="btn btn-secondary" disabled={busy} onclick={() => run(['ca'])}>{data.ca ? '↻ Neu auswerten' : 'Auswerten'}</button>
        <button class="btn btn-secondary" disabled={!data.ca} onclick={() => pdf(['ca'])}>Doku-PDF</button>
        <button class="btn btn-secondary" disabled={!data.ca} onclick={() => csv('ca')}>CSV</button>
      </div>

      {#if data.ca}
        {@const s = data.ca.summary}
        <div class="rep-metrics za-metrics">
          <div class="rep-metric"><div class="rep-metric-value">{s.policies}</div><div class="rep-metric-label">Richtlinien</div></div>
          <div class="rep-metric"><div class="rep-metric-value za-ok">{s.enabled}</div><div class="rep-metric-label">Aktiv</div></div>
          <div class="rep-metric" class:warn={s.reportOnly}><div class="rep-metric-value">{s.reportOnly}</div><div class="rep-metric-label">Nur Bericht</div></div>
          <div class="rep-metric"><div class="rep-metric-value">{s.disabled}</div><div class="rep-metric-label">Aus</div></div>
          <div class="rep-metric" class:crit={s.withoutMfa}><div class="rep-metric-value">{s.withoutMfa}</div><div class="rep-metric-label">Konten ohne MFA-Pflicht</div></div>
          <div class="rep-metric" class:warn={s.excludedFromAll > 3}><div class="rep-metric-value">{s.excludedFromAll}</div><div class="rep-metric-label">Überall ausgenommen</div></div>
        </div>
        <div class="za-notes">
          <span class="tbadge" class:ok={s.legacyBlocked} class:warn={!s.legacyBlocked}>Legacy-Auth {s.legacyBlocked ? 'blockiert' : 'nicht ausdrücklich blockiert'}</span>
          {#if s.securityDefaults !== null && s.securityDefaults !== undefined}<span class="tbadge">Sicherheitsstandards {s.securityDefaults ? 'an' : 'aus'}</span>{/if}
          <span class="za-dim za-small">{pl(s.users, 'aktives Konto', 'aktive Konten')}, davon {pl(s.guests, 'Gast', 'Gäste')}</span>
          {#if data.ca.signIns}
            <span class="za-dim za-small">· Anmeldeprotokoll: {data.ca.signIns.error ? 'nicht lesbar' : `${data.ca.signIns.read} Anmeldungen / ${data.ca.signIns.days} Tage${data.ca.signIns.capped ? ' (gekappt)' : ''}`}</span>
          {/if}
        </div>
        {#if data.ca.gaps?.length}<div class="alert alert-warning">{data.ca.gaps.join(' · ')}</div>{/if}

        {#if data.ca.withoutMfa?.length}
          <details class="za-item">
            <summary><span class="za-item-name">Konten ohne MFA-Pflicht ({data.ca.withoutMfa.length})</span><span class="za-dim za-small">keine aktive Richtlinie verlangt MFA für alle Cloud-Apps</span></summary>
            <div class="za-item-body za-chips">{#each data.ca.withoutMfa as u}<span class="gt-tag">{u.upn}{u.guest ? ' (Gast)' : ''}</span>{/each}</div>
          </details>
        {/if}
        {#if data.ca.excludedFromAll?.length}
          <details class="za-item">
            <summary><span class="za-item-name">Von allen aktiven Richtlinien ausgenommen ({data.ca.excludedFromAll.length})</span><span class="za-dim za-small">Notfallkonten gehören hierher, sonst niemand</span></summary>
            <div class="za-item-body za-chips">{#each data.ca.excludedFromAll as u}<span class="gt-tag">{u.upn}{u.guest ? ' (Gast)' : ''}</span>{/each}</div>
          </details>
        {/if}

        <h4 class="za-h4">Richtlinien</h4>
        {#each data.ca.policies as p (p.id)}
          <details class="za-item">
            <summary>
              <span class="za-item-name">{p.name}</span>
              <span class="za-dim za-small">{p.effectShort}</span>
              <span class="za-item-right">
                <span class="za-dim za-small">{p.scope.effective} Konten · {p.scope.excluded} ausgenommen</span>
                <span class="tbadge {CA_CLS[p.state]}">{p.stateLabel}</span>
              </span>
            </summary>
            <div class="za-item-body">
              <p class="za-summary">{p.summary}</p>
              {#each p.findings as f}
                <div class="za-line" class:crit={f.severity === 'fehler'} class:warn={f.severity === 'warn'}>{f.text}</div>
              {/each}
              <div class="za-kv"><span>Gilt für</span><span>{p.who.include.join(' · ') || 'niemanden'}</span></div>
              {#if p.who.exclude.length}<div class="za-kv"><span>Ausgenommen</span><span>{p.who.exclude.join(' · ')}</span></div>{/if}
              <div class="za-kv"><span>Cloud-Apps</span><span>{[...p.apps.include, ...p.apps.actions.map(x => 'Aktion: ' + x), ...p.apps.authContext.map(x => 'Kontext: ' + x)].join(', ')}{p.apps.exclude.length ? ' — ausser ' + p.apps.exclude.join(', ') : ''}</span></div>
              {#if p.conditions.length}<div class="za-kv"><span>Bedingungen</span><span>{p.conditions.join(' · ')}</span></div>{/if}
              <div class="za-kv"><span>Gewähren</span><span>{p.grant.blocks ? 'Zugriff blockieren' : (p.grant.controls.join(p.grant.operator === 'OR' ? ' ODER ' : ' UND ') || '—')}</span></div>
              {#if p.session.length}<div class="za-kv"><span>Sitzung</span><span>{p.session.join(' · ')}</span></div>{/if}
              <div class="za-kv"><span>Effektiv betroffen</span><span>{pl(p.scope.effective, 'Konto', 'Konten')}{p.scope.guests ? `, davon ${pl(p.scope.guests, 'Gast', 'Gäste')}` : ''}{p.scope.disabled ? `, ${p.scope.disabled} deaktiviert` : ''}</span></div>
              {#if p.excludedUsers.length}
                <div class="za-kv"><span>Ausgenommene Konten</span><span class="za-chips">{#each p.excludedUsers as u}<span class="gt-tag">{u.upn}{u.guest ? ' (Gast)' : ''}{u.enabled ? '' : ' (deaktiviert)'}</span>{/each}</span></div>
              {/if}
              {#if p.signIns}
                <div class="za-kv"><span>Anmeldeprotokoll</span><span>
                  {#if Object.keys(p.signIns.counts || {}).length}
                    {#each Object.entries(p.signIns.counts) as [k, n]}<span class="tbadge" class:crit={/failure|interrupted/i.test(k)} class:ok={/success/i.test(k)}>{SIGNIN_LABEL[k] || k}: {n}</span> {/each}
                    {#if p.signIns.topUsers?.length}<div class="za-dim za-small">häufigste Treffer: {p.signIns.topUsers.map(u => `${u.upn} (${u.n})`).join(', ')}</div>{/if}
                  {:else}keine Anmeldung im Zeitraum{/if}
                </span></div>
              {/if}
              {#if p.effectiveUsers.length}
                <details class="za-sub-details">
                  <summary>Betroffene Konten ({p.scope.effective})</summary>
                  <div class="za-chips">{#each p.effectiveUsers as u}<span class="gt-tag">{u.upn}{u.guest ? ' (Gast)' : ''}</span>{/each}{#if p.scope.effective > p.effectiveUsers.length}<span class="za-dim za-small">… vollständig im CSV</span>{/if}</div>
                </details>
              {/if}
            </div>
          </details>
        {/each}

        <h4 class="za-h4">Wirkung je Konto</h4>
        <p class="ld-section-hint" style="margin-top:0">Welche Richtlinien für ein Konto greifen — Ausschlüsse abgezogen; Standort, Plattform und Risiko sind nicht simuliert.</p>
        <input class="za-search" type="search" placeholder="Konto suchen…" bind:value={caSearch} style="margin-bottom:0.5rem" />
        <div class="gt-table-wrap">
          <table class="gt-table">
            <thead><tr><th>Konto</th><th>Aktiv</th><th>Nur Bericht</th></tr></thead>
            <tbody>
              {#each matrixShown.slice(0, matrixLimit) as u (u.upn)}
                <tr class:ac-issue={!u.active.length}>
                  <td><strong>{u.name}</strong><div class="za-dim za-small">{u.upn}{u.guest ? ' · Gast' : ''}</div></td>
                  <td class="za-small">{#if u.active.length}{u.active.map(x => x.name).join(' · ')}{:else}<span class="tbadge crit">keine</span>{/if}</td>
                  <td class="za-small">{u.reportOnly.map(x => x.name).join(' · ') || '—'}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        {#if matrixShown.length > matrixLimit}
          <button class="za-link" onclick={() => (matrixLimit += 300)}>weitere {Math.min(300, matrixShown.length - matrixLimit)} anzeigen ({matrixShown.length - matrixLimit} offen)</button>
        {/if}
      {/if}
    {/if}
  </div>
</TenantContext>

<style>
  .za { display: flex; flex-direction: column; gap: 0.75rem; }
  .za-top { display: flex; align-items: flex-end; gap: 0.75rem; flex-wrap: wrap; }
  .za-subtabs { flex: 1; margin-bottom: 0; min-width: 280px; }
  .za-subtabs .tbadge { margin-left: 0.35rem; }
  .za-top-actions { display: flex; gap: 0.5rem; padding-bottom: 0.35rem; }
  .za-job { display: flex; gap: 0.75rem; align-items: center; }
  .za-bar { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
  .za-stamp { font-size: 0.84rem; color: var(--text-dim); margin-right: auto; }
  .za-age { color: var(--text-faint); }
  .za-opt { display: inline-flex; align-items: center; gap: 0.35rem; font-size: 0.82rem; color: var(--text-dim); }
  .za-opt select { padding: 0.2rem 0.3rem; font-size: 0.82rem; }
  .za-metrics { margin: 0; }
  .za-ok { color: var(--ok); }
  .za-notes { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }

  .za-fixer { margin-top: 0.25rem; }
  .za-fixer-head { display: flex; gap: 1rem; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; margin-bottom: 0.6rem; }
  .za-fixer-head h4 { margin: 0 0 0.25rem; }
  .za-plans { display: flex; flex-direction: column; gap: 0.5rem; }
  .za-plan { border: 1px solid var(--rule); border-radius: var(--radius-sm); padding: 0.6rem 0.75rem; }
  .za-plan-off { opacity: 0.75; border-style: dashed; }
  .za-plan-head { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; cursor: pointer; }
  .za-plan-body { margin: 0.45rem 0 0 1.6rem; display: flex; flex-direction: column; gap: 0.3rem; }
  .za-plan-alt { font-size: 0.8rem; color: var(--text-dim); }
  .za-plan-alt select { margin-left: 0.35rem; font-size: 0.8rem; padding: 0.15rem 0.3rem; }
  .za-plan-actions { display: flex; gap: 0.75rem; align-items: center; justify-content: flex-end; margin-top: 0.7rem; }
  .za-name { font: inherit; font-weight: 700; border: 1px solid var(--rule); border-radius: 4px; padding: 0.1rem 0.35rem; min-width: 16rem; background: var(--bg, transparent); color: inherit; }
  .za-rename { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; font-size: 0.85rem; margin: 0.25rem 0; }
  .za-btn-sm { padding: 0.2rem 0.6rem; font-size: 0.78rem; }
  .za-h4 { margin: 0.75rem 0 0.2rem; }
  .za-h5 { margin: 0.9rem 0 0.35rem; font-size: 0.9rem; }
  .za-log { margin-top: 0.9rem; }
  .za-log summary, .za-sub-details summary { cursor: pointer; font-size: 0.86rem; font-weight: 700; color: var(--text-dim); }

  .za-filterbar { display: flex; gap: 0.4rem; flex-wrap: wrap; align-items: center; }
  .za-search { margin-left: auto; min-width: 220px; padding: 0.35rem 0.6rem; font-size: 0.85rem; border: 1px solid var(--rule); border-radius: var(--radius-sm); background: transparent; color: inherit; }

  .za-item { border: 1px solid var(--rule); border-radius: var(--radius-sm); }
  .za-item > summary { display: flex; align-items: baseline; gap: 0.6rem; padding: 0.55rem 0.75rem; cursor: pointer; flex-wrap: wrap; list-style: none; }
  .za-item > summary::-webkit-details-marker { display: none; }
  .za-item > summary::before { content: '▸'; color: var(--text-faint); font-size: 0.8rem; }
  .za-item[open] > summary::before { content: '▾'; }
  .za-item[open] > summary { border-bottom: 1px solid var(--rule); }
  .za-item-name { font-weight: 700; }
  .za-item-right { margin-left: auto; display: inline-flex; gap: 0.6rem; align-items: center; }
  .za-item-body { padding: 0.65rem 0.85rem; display: flex; flex-direction: column; gap: 0.45rem; }

  .za-flow { display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; }
  .za-intent { font-size: 0.74rem; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--accent); }
  .za-intent.za-excl { color: var(--text-faint); }
  .za-arrow { color: var(--text-faint); }
  .za-node {
    display: inline-flex; flex-direction: column; line-height: 1.2;
    border: 1px solid var(--rule); border-radius: 6px; padding: 0.2rem 0.5rem; font-size: 0.83rem; font-weight: 600;
  }
  .za-node small { font-weight: 400; font-size: 0.7rem; color: var(--text-dim); }
  .za-node.app { border-color: color-mix(in srgb, var(--accent) 55%, var(--rule)); background: var(--accent-wash); }
  .za-node.dev { border-color: color-mix(in srgb, var(--ok) 50%, var(--rule)); background: var(--ok-wash); }
  .za-node.usr { border-color: color-mix(in srgb, var(--info) 40%, var(--rule)); }
  .za-node.bad { border-color: color-mix(in srgb, var(--crit) 55%, var(--rule)); background: var(--crit-wash); }
  .za-indent { margin-left: 1rem; }
  .za-devtable { margin-top: 0.3rem; }

  .za-line { font-size: 0.84rem; padding-left: 0.6rem; border-left: 3px solid var(--rule); }
  .za-line.crit { border-left-color: var(--crit); }
  .za-line.warn { border-left-color: var(--warn); }
  .za-dim { color: var(--text-dim); }
  .za-small { font-size: 0.78rem; }
  .za-chips { display: flex; flex-wrap: wrap; gap: 0.3rem; }
  .za-kv { display: grid; grid-template-columns: 11rem 1fr; gap: 0.75rem; font-size: 0.85rem; }
  .za-kv > span:first-child { color: var(--text-dim); font-weight: 600; }
  .za-summary { margin: 0; padding: 0.45rem 0.7rem; border-left: 3px solid var(--accent); background: var(--accent-wash); font-size: 0.88rem; }
  .za-settings td:first-child { width: 58%; }
  .za-link {
    background: none; border: 0; cursor: pointer; padding: 0; font: inherit;
    font-size: 0.8rem; text-decoration: underline; color: var(--accent);
  }
  .za-sub { color: var(--text-dim); }

  @media (max-width: 720px) {
    .za-kv { grid-template-columns: 1fr; gap: 0.1rem; }
    .za-search { margin-left: 0; width: 100%; }
    .za-item-right { margin-left: 0; }
  }
</style>
