<script>
  // SharePoint & OneDrive — Inventar des Kundentenants, rein lesend:
  //  - Kennzahlen und Zusammensetzung nach Art (Teams, M365-Gruppe, Kommunikation …)
  //  - alle Sites mit Speicher, Besitzern, Mitgliedern, Gästen; aufklappbar
  //  - OneDrive je Konto
  //  - tenantweite Freigabe-Einstellungen in Klartext
  // Was Graph nicht liefert (Freigabestufe je Site, SharePoint-Gruppen von Sites
  // ohne M365-Gruppe …), steht als «nicht über Graph verfügbar» da, statt zu fehlen.
  // Erheben läuft als Job; das Ergebnis bleibt pro Tenant gespeichert und ist
  // zugleich das Kapitel «SharePoint und OneDrive» der Konfigurationsdoku.
  import { apiGet, apiPost, fileDownload, errText } from '../lib/api.js'
  import { activeTenant } from '../lib/tenantStore.js'
  import { session } from '../lib/session.js'
  import { activeTab } from '../lib/tabStore.js'
  import TenantContext from '../lib/TenantContext.svelte'

  let data = $state(null)
  let loading = $state(false)
  let error = $state(null)
  let notice = $state(null)
  let job = $state(null)
  let period = $state('D30')
  let optAppendix = $state(true)

  const tid = () => encodeURIComponent($activeTenant.id)
  const busy = $derived(!!job && job.status === 'running')

  let loadedFor = null
  $effect(() => {
    const t = $activeTenant
    if ($activeTab !== 'sharepoint') return
    if (!$session.loggedIn || !t) return
    if (loadedFor === t.id) return
    loadedFor = t.id
    data = null; job = null; error = null; notice = null; open = {}
    loadStored()
  })

  async function loadStored() {
    loading = true
    try {
      const r = await apiGet(`/api/tenants/${tid()}/sharepoint`)
      data = r.data || null
      if (data && data.period) period = data.period
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

  async function run() {
    error = null; notice = null
    try {
      const r = await apiPost(`/api/tenants/${tid()}/sharepoint/run`, { period })
      job = { id: r.jobId, status: 'running', phase: 'Start' }
      poll(r.jobId, async (j) => {
        await loadStored()
        if (j.status === 'failed') error = j.error || 'Erhebung fehlgeschlagen.'
        else if (j.hint) notice = j.hint
      })
    } catch (e) { error = errText(e) }
  }

  function pdf() { fileDownload(`/api/tenants/${tid()}/assignaudit/report.pdf?kinds=sharepoint&anhang=${optAppendix ? 1 : 0}`) }
  function csv(kind) { fileDownload(`/api/tenants/${tid()}/sharepoint/export.csv?kind=${kind}`) }

  // ---------------------------------------------------------------- Format
  function bytes(b) {
    if (b === null || b === undefined) return '—'
    const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
    let v = Number(b), i = 0
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
    return `${v.toLocaleString('de-CH', { maximumFractionDigits: v < 100 && i > 0 ? 1 : 0 })} ${u[i]}`
  }
  function fmt(iso) {
    if (!iso) return '—'
    return new Date(iso).toLocaleString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  }
  function day(s) {
    if (!s) return '—'
    const d = new Date(s.length === 10 ? s + 'T12:00:00Z' : s)
    return isNaN(d) ? '—' : d.toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric' })
  }
  function age(iso) {
    if (!iso) return ''
    const h = Math.round((Date.now() - new Date(iso).getTime()) / 36e5)
    return h < 1 ? 'gerade eben' : h < 48 ? `vor ${h} h` : `vor ${Math.round(h / 24)} Tagen`
  }

  // ---------------------------------------------------------------- Art
  const KIND = {
    teams: { short: 'Teams', cls: 'k-teams' },
    group: { short: 'M365-Gruppe', cls: 'k-group' },
    communication: { short: 'Kommunikation', cls: 'k-comm' },
    teamSite: { short: 'Team-Site', cls: 'k-team' },
    classic: { short: 'Klassisch', cls: 'k-classic' },
    channel: { short: 'Teams-Kanal', cls: 'k-chan' },
    other: { short: 'Andere Vorlage', cls: 'k-other' },
    unknown: { short: 'Art offen', cls: 'k-unknown' },
    system: { short: 'System', cls: 'k-system' }
  }
  const kindShort = s => s.orphanGroup ? 'Gruppe fehlt' : (KIND[s.kind] || {}).short || s.kind
  const SHARE_TONE = { ok: 'ok', info: 'info', warn: 'warn', crit: 'crit', muted: '' }
  const SHARE_STEPS = [
    ['disabled', 'Nur Personen in der Organisation', 'ok'],
    ['existingExternalUserSharingOnly', 'Bestehende Gäste', 'info'],
    ['externalUserSharingOnly', 'Neue und bestehende Gäste', 'warn'],
    ['externalUserAndGuestSharing', 'Jeder (anonyme Links)', 'crit']
  ]

  // ---------------------------------------------------------------- Sites
  const FILTERS = [['all', 'Alle'], ['teams', 'Mit Teams'], ['group', 'Mit M365-Gruppe'], ['communication', 'Kommunikation'], ['nogroup', 'Ohne Gruppe'], ['guests', 'Mit Gästen'], ['system', 'System']]
  let filter = $state('all')
  let search = $state('')
  let sort = $state('kind')
  let open = $state({})
  const S = $derived(data?.summary)
  const maxSite = $derived(Math.max(1, ...(data?.sites || []).map(s => s.storageUsed || 0)))
  const sitesShown = $derived.by(() => {
    const q = search.trim().toLowerCase()
    const list = (data?.sites || []).filter(s => {
      if (filter === 'all' && s.kind === 'system') return false
      if (filter === 'teams' && s.kind !== 'teams') return false
      if (filter === 'group' && !s.group) return false
      if (filter === 'communication' && s.kind !== 'communication') return false
      if (filter === 'nogroup' && (s.group || s.kind === 'system')) return false
      if (filter === 'guests' && !(s.group && s.group.guestCount)) return false
      if (filter === 'system' && s.kind !== 'system') return false
      if (!q) return true
      const g = s.group
      return [s.name, s.url, s.kindLabel, s.template, g?.displayName, g?.mail, ...(g ? g.owners.map(o => o.name + ' ' + o.upn) : []), ...(g ? g.members.map(m => m.name + ' ' + m.upn) : [])]
        .join(' ').toLowerCase().includes(q)
    })
    const by = {
      kind: () => 0,
      name: (a, b) => a.name.localeCompare(b.name, 'de'),
      storage: (a, b) => (b.storageUsed || 0) - (a.storageUsed || 0),
      activity: (a, b) => String(b.lastActivity || b.modified || '').localeCompare(String(a.lastActivity || a.modified || '')),
      members: (a, b) => (b.group?.memberCount ?? -1) - (a.group?.memberCount ?? -1)
    }[sort]
    return sort === 'kind' ? list : [...list].sort(by)
  })
  const filterCount = k => (data?.sites || []).filter(s =>
    k === 'all' ? s.kind !== 'system' : k === 'teams' ? s.kind === 'teams' : k === 'group' ? !!s.group
      : k === 'communication' ? s.kind === 'communication' : k === 'nogroup' ? (!s.group && s.kind !== 'system')
        : k === 'guests' ? !!(s.group && s.group.guestCount) : s.kind === 'system').length
  // Nur https-Adressen verlinken (Daten stammen aus dem Kundentenant)
  const safeUrl = u => /^https:\/\//i.test(String(u || '')) ? u : undefined
  const toggle = id => { open = { ...open, [id]: !open[id] } }
  const barWidth = (used, max) => used ? Math.max(2, Math.round(used / max * 100)) : 0
  const fillClass = (used, alloc) => !used || !alloc ? '' : used / alloc >= 0.9 ? 'crit' : used / alloc >= 0.75 ? 'warn' : ''
  const fillTitle = (used, alloc) => used && alloc ? `${(used / alloc * 100).toLocaleString('de-CH', { maximumFractionDigits: 1 })} % des Kontingents belegt` : ''

  // Zusammensetzung nach Art (Balken + Legende); ohne System-Sites
  const composition = $derived(Object.keys(KIND).filter(k => k !== 'system').map(k => ({ k, n: S?.byKind?.[k] || 0 })).filter(e => e.n))
  const compTotal = $derived(composition.reduce((a, e) => a + e.n, 0) || 1)
  const COMP_FILTER = { teams: 'teams', group: 'group', communication: 'communication' }

  // ---------------------------------------------------------------- OneDrive
  let odSearch = $state('')
  let odLimit = $state(50)
  const odShown = $derived((data?.oneDrive?.accounts || []).filter(a => !odSearch.trim() || `${a.name} ${a.upn}`.toLowerCase().includes(odSearch.trim().toLowerCase())))
  const maxOd = $derived(Math.max(1, ...(data?.oneDrive?.accounts || []).map(a => a.storageUsed || 0)))
  const defaultQuota = $derived(data?.settings?.raw?.personalSiteDefaultStorageLimitInMB)
</script>

<TenantContext>
  <div class="sp">
    <p class="ld-section-hint">
      Alle SharePoint-Sites mit Art, Speicher, Besitzern, Mitgliedern und Gästen, OneDrive je Konto und die tenantweiten
      Freigabe-Einstellungen — rein lesend, auch im Prüfmandat. Das Ergebnis bleibt pro Tenant gespeichert und ist zugleich
      das Kapitel «SharePoint und OneDrive» der Konfigurationsdoku (auch im Bereich «Zuweisungen &amp; Audit» wählbar).
    </p>

    <div class="sp-bar">
      <div class="sp-stamp">
        {#if data}Datenstand {fmt(data.generatedAt)} <span class="sp-faint">({age(data.generatedAt)})</span>{:else if loading}Lade…{:else}Noch nicht erhoben.{/if}
      </div>
      <label class="sp-opt" title="Zeitraum des Microsoft-365-Nutzungsberichts (Speicher, letzte Aktivität, Vorlage)">
        Nutzungsbericht
        <select bind:value={period} disabled={busy}>
          <option value="D7">7 Tage</option><option value="D30">30 Tage</option><option value="D90">90 Tage</option><option value="D180">180 Tage</option>
        </select>
      </label>
      <button class="btn btn-secondary" disabled={busy} onclick={run}>{data ? '↻ Neu erheben' : 'Erheben'}</button>
      <label class="sp-opt" title="Bewertende Hinweise (Gäste in öffentlichen Gruppen, Gruppen ohne Besitzer …) als Anhang — für die Doku an den Kunden abwählen">
        <input type="checkbox" bind:checked={optAppendix} /> Hinweise als Anhang
      </label>
      <button class="btn btn-primary" disabled={!data} onclick={pdf}>Doku-PDF</button>
    </div>

    {#if error}<div class="alert alert-warning">❌ {error}</div>{/if}
    {#if notice}<div class="ld-banner ok">{notice}</div>{/if}
    {#if job && job.status === 'running'}
      <div class="ld-job sp-job">
        <span class="ld-spinner"></span>
        <div><strong>Erhebung läuft</strong><div class="ld-job-meta">{job.phase || '…'}</div></div>
      </div>
    {/if}

    {#if data && S}
      <!-- ============================================================ Kennzahlen -->
      <div class="sp-hero">
        <div class="sp-kpi">
          <div class="sp-kpi-value">{S.sites}</div>
          <div class="sp-kpi-label">Sites</div>
          <div class="sp-kpi-detail">{S.systemSites ? `+ ${S.systemSites} System-Sites` : 'ohne System-Sites'}</div>
        </div>
        <div class="sp-kpi">
          <div class="sp-kpi-value">{S.teams}</div>
          <div class="sp-kpi-label">davon mit Teams</div>
          <div class="sp-kpi-detail">{S.groupSites} mit M365-Gruppe</div>
        </div>
        <div class="sp-kpi">
          <div class="sp-kpi-value">{bytes(S.storageUsed + S.oneDriveStorage)}</div>
          <div class="sp-kpi-label">Speicher gesamt</div>
          <div class="sp-kpi-detail">SharePoint {bytes(S.storageUsed)} · OneDrive {bytes(S.oneDriveStorage)}</div>
        </div>
        <div class="sp-kpi">
          <div class="sp-kpi-value">{S.oneDrives}</div>
          <div class="sp-kpi-label">OneDrive-Konten</div>
          <div class="sp-kpi-detail">{S.oneDriveActive !== null && S.oneDriveActive !== undefined ? `${S.oneDriveActive} aktiv in ${data.periodDays} Tagen` : 'Aktivität nicht lesbar'}</div>
        </div>
        <div class="sp-kpi sp-kpi-share tone-{SHARE_TONE[S.sharingTone] ?? ''}">
          <div class="sp-kpi-label">Externe Freigabe</div>
          <div class="sp-share-badge">{S.sharingLabel || 'nicht lesbar'}</div>
          <div class="sp-kpi-detail">{data.settings ? data.settings.sharing.description : 'SharePointTenantSettings.Read.All fehlt — im Tab Tenants einmal Reparieren.'}</div>
        </div>
      </div>

      {#if composition.length}
        <div class="sp-comp" role="img" aria-label="Sites nach Art">
          {#each composition as e (e.k)}
            <span class="sp-comp-seg {KIND[e.k].cls}" style="width:{e.n / compTotal * 100}%" title="{KIND[e.k].short}: {e.n}"></span>
          {/each}
        </div>
        <div class="sp-legend">
          {#each composition as e (e.k)}
            <button class="sp-legend-item" onclick={() => { filter = COMP_FILTER[e.k] || (e.k === 'system' ? 'system' : 'nogroup'); sort = 'kind' }}>
              <span class="sp-dot {KIND[e.k].cls}"></span>{KIND[e.k].short} <strong>{e.n}</strong>
            </button>
          {/each}
          {#if S.guests}<span class="sp-legend-note">{S.guests} Gäste in {S.sitesWithGuests} Sites</span>{/if}
        </div>
      {/if}

      {#if data.reports?.concealed}
        <div class="ld-banner warn">
          <strong>Nutzungsberichte anonymisiert.</strong> Microsoft 365 ersetzt in den Berichten dieses Tenants Namen und Adressen durch
          Kennungen (Admin Center › Einstellungen › Organisationseinstellungen › Berichte: «Display concealed user, group, and site names in all reports»).
          Sites sind über die Site-Id zugeordnet ({data.reports.siteRowsJoined} von {data.sites.length}); bei OneDrive ist die letzte Aktivität je Konto
          nicht zuordenbar, Speicher kommt direkt aus dem Laufwerk. Das Werkzeug ändert die Einstellung nicht.
        </div>
      {/if}
      {#if data.gaps?.length}
        <div class="alert alert-warning">
          <strong>Nicht vollständig erhoben:</strong>
          <ul class="sp-gaps">{#each data.gaps as g}<li>{g}</li>{/each}</ul>
        </div>
      {/if}

      <!-- ============================================================ Sites -->
      <section class="sp-section">
        <div class="sp-section-head">
          <h3>Sites</h3>
          <span class="sp-dim sp-small">Freigabestufe je Site: <span class="sp-na" title="Graph liefert nur die tenantweite Stufe; eine Site kann sie einschränken, nicht erweitern.">nicht über Graph verfügbar</span></span>
          <span class="sp-csv">CSV: <button class="sp-link" onclick={() => csv('sites')}>Sites</button> · <button class="sp-link" onclick={() => csv('members')}>Mitglieder</button></span>
        </div>
        <div class="sp-filterbar">
          {#each FILTERS as [k, l]}
            {@const n = filterCount(k)}
            {#if n || k === 'all'}
              <button class="topic-chip" class:active={filter === k} onclick={() => (filter = k)}>{l} <span class="sp-chip-n">{n}</span></button>
            {/if}
          {/each}
          <select class="sp-sort" bind:value={sort} aria-label="Sortierung">
            <option value="kind">nach Art</option><option value="name">nach Name</option><option value="storage">nach Speicher</option>
            <option value="activity">nach Aktivität</option><option value="members">nach Mitgliedern</option>
          </select>
          <input class="sp-search" type="search" placeholder="Site, Adresse, Person suchen…" bind:value={search} />
        </div>

        <div class="gt-table-wrap">
          <table class="gt-table sp-table">
            <thead>
              <tr><th class="sp-caret"></th><th>Site</th><th>Art</th><th>Speicher</th><th>Besitzer</th><th class="num">Mitgl.</th><th class="num">Gäste</th><th>Aktivität</th></tr>
            </thead>
            <tbody>
              {#each sitesShown as s (s.id)}
                {@const g = s.group}
                <tr class="sp-row" class:open={open[s.id]} onclick={() => toggle(s.id)}>
                  <td class="sp-caret"><button class="sp-caret-btn" aria-expanded={!!open[s.id]} aria-label="Details zu {s.name}" onclick={(e) => { e.stopPropagation(); toggle(s.id) }}>{open[s.id] ? '▾' : '▸'}</button></td>
                  <td>
                    <div class="sp-name">{s.name}{#if s.isRoot}{" "}<span class="tbadge">Stammsite</span>{/if}</div>
                    <a class="sp-url" href={safeUrl(s.url)} target="_blank" rel="noopener noreferrer" onclick={(e) => e.stopPropagation()}>{s.path === '/' ? s.host : s.path}</a>
                  </td>
                  <td>
                    <span class="sp-kind {KIND[s.kind]?.cls}" title={s.kindLabel}>{kindShort(s)}</span>
                    {#if g}<div class="sp-dim sp-small">{g.visibilityLabel}</div>{/if}
                  </td>
                  <td class="sp-storage" title={fillTitle(s.storageUsed, s.storageAllocated)}>
                    <div class="sp-meter"><span class={fillClass(s.storageUsed, s.storageAllocated)} style="width:{barWidth(s.storageUsed, maxSite)}%"></span></div>
                    <div class="sp-small">{bytes(s.storageUsed)}{#if s.storageAllocated}{" "}<span class="sp-faint">von {bytes(s.storageAllocated)}</span>{/if}</div>
                  </td>
                  <td class="sp-small">
                    {#if g}
                      {#if g.ownerCount === 0}<span class="tbadge crit">keine</span>
                      {:else}{g.owners.slice(0, 2).map(o => o.name).join(', ')}{#if g.owners.length > 2}{" "}<span class="sp-faint">+{g.owners.length - 2}</span>{/if}{/if}
                    {:else if s.reportOwner}
                      {s.reportOwner.name || s.reportOwner.upn} <span class="sp-faint">(Bericht)</span>
                    {:else}
                      <span class="sp-na" title="Sites ohne M365-Gruppe: Websitesammlungsadministratoren und SharePoint-Gruppen liefert Graph nicht">nicht über Graph verfügbar</span>
                    {/if}
                  </td>
                  <td class="num">{g && g.memberCount !== null ? g.memberCount : '—'}</td>
                  <td class="num">{#if g?.guestCount}<span class="tbadge warn">{g.guestCount}</span>{:else}{g ? 0 : '—'}{/if}</td>
                  <td class="sp-small">
                    {s.lastActivity ? day(s.lastActivity) : '—'}
                    <div class="sp-faint">geändert {day(s.modified)}</div>
                  </td>
                </tr>
                {#if open[s.id]}
                  <tr class="sp-detail">
                    <td></td>
                    <td colspan="7">
                      <div class="sp-detail-grid">
                        <div class="sp-kv">
                          <span>Adresse</span><a href={safeUrl(s.url)} target="_blank" rel="noopener noreferrer">{s.url}</a>
                          <span>Art</span><span>{s.kindLabel}{#if s.template}{' '}<code>{s.template}</code>{/if}</span>
                          <span>Erstellt</span><span>{day(s.created)}</span>
                          <span>Geändert</span><span>{day(s.modified)}</span>
                          <span>Nutzung</span><span>{#if s.inReport}{s.lastActivity ? 'letzte Aktivität ' + day(s.lastActivity) : 'keine Aktivität im Bericht'}{#if s.fileCount !== null}{' '}· {s.fileCount.toLocaleString('de-CH')} Dateien{/if}{#if s.pageViews}{' '}· {s.pageViews.toLocaleString('de-CH')} Seitenaufrufe{/if}{:else}<span class="sp-dim">nicht im Nutzungsbericht (neu oder Bericht nicht lesbar)</span>{/if}</span>
                          <span>Speicher</span><span>{bytes(s.storageUsed)}{#if s.storageAllocated}{' '}von {bytes(s.storageAllocated)}{/if} <span class="sp-faint">{s.storageSource === 'report' ? '(Nutzungsbericht)' : s.storageSource === 'drive' ? '(Standardbibliothek)' : ''}</span></span>
                          <span>Freigabestufe der Site</span><span><span class="sp-na">nicht über Graph verfügbar</span> <span class="sp-dim sp-small">— höchstens «{S.sharingLabel || '?'}» (Tenant)</span></span>
                          {#if g}
                            <span>Gruppe</span><span>{g.displayName}{#if g.mail}{' '}· <span class="sp-dim">{g.mail}</span>{/if}</span>
                            <span>Sichtbarkeit</span><span>{g.visibilityLabel}{g.teams ? ' · mit Teams' : ''} · Gruppe erstellt {day(g.created)}</span>
                            {#if g.description}<span>Beschreibung</span><span>{g.description}</span>{/if}
                          {:else if s.reportOwner}
                            <span>Primärer Besitzer</span><span>{s.reportOwner.name}{#if s.reportOwner.upn}{' '}· <span class="sp-dim">{s.reportOwner.upn}</span>{/if} <span class="sp-faint">(Nutzungsbericht)</span></span>
                          {/if}
                        </div>
                        <div class="sp-people">
                          {#if g}
                            {#if g.error}<div class="za-line warn">{g.error}</div>{/if}
                            <h5>Besitzer ({g.ownerCount ?? '?'})</h5>
                            <div class="sp-chips">
                              {#each g.owners as o (o.id)}<span class="sp-person" class:guest={o.guest} title={o.upn}>{o.name}</span>{:else}<span class="tbadge crit">keine Besitzer</span>{/each}
                            </div>
                            <h5>Mitglieder ({g.memberCount ?? '?'}){#if g.guestCount}, davon {g.guestCount} Gäste{/if}</h5>
                            <div class="sp-chips">
                              {#each g.members as m (m.id)}<span class="sp-person" class:guest={m.guest} title={m.upn}>{m.name}{#if m.guest}{" "}<small>Gast</small>{/if}</span>{/each}
                              {#if g.membersTruncated}<span class="sp-dim sp-small">… {g.memberCount - g.members.length} weitere im CSV-Export</span>{/if}
                            </div>
                          {:else}
                            <h5>Besitzer und Mitglieder</h5>
                            <p class="sp-small"><span class="sp-na">nicht über Graph verfügbar</span> — Sites ohne M365-Gruppe regeln den Zugriff über
                              SharePoint-Gruppen und Websitesammlungsadministratoren; beides liest nur SharePoint-REST bzw. PowerShell.</p>
                          {/if}
                        </div>
                      </div>
                    </td>
                  </tr>
                {/if}
              {:else}
                <tr><td colspan="8" class="sp-dim">Keine Site passt zum Filter.</td></tr>
              {/each}
            </tbody>
          </table>
        </div>
      </section>

      <!-- ============================================================ OneDrive -->
      <section class="sp-section">
        <div class="sp-section-head">
          <h3>OneDrive</h3>
          <span class="sp-dim sp-small">
            {S.oneDrives} Konten · {bytes(S.oneDriveStorage)} belegt{#if defaultQuota}{' '}· Standardkontingent {bytes(defaultQuota * 1024 * 1024)}{/if}
            {#if data.oneDrive.report.readable}{' '}· Nutzungsbericht: {data.oneDrive.report.rows} Konten, {data.oneDrive.report.activeAccounts} aktiv in {data.periodDays} Tagen{/if}
          </span>
          <span class="sp-csv">CSV: <button class="sp-link" onclick={() => csv('onedrive')}>OneDrive</button></span>
        </div>
        {#if data.reports?.concealed}
          <p class="sp-small sp-dim">Letzte Aktivität je Konto: <span class="sp-na">anonymisiert</span> — der Bericht nennt keine zuordenbaren Namen. Namen, Speicher und Kontingent stammen direkt aus den Laufwerken.</p>
        {/if}
        {#if data.oneDrive.accounts.length}
          <div class="sp-filterbar">
            <input class="sp-search" type="search" placeholder="Konto suchen…" bind:value={odSearch} />
          </div>
          <div class="gt-table-wrap">
            <table class="gt-table sp-table">
              <thead><tr><th>Konto</th><th>Speicher</th><th>Letzte Aktivität</th><th>Geändert</th><th>Status</th></tr></thead>
              <tbody>
                {#each odShown.slice(0, odLimit) as a (a.url)}
                  <tr>
                    <td><div class="sp-name">{a.name}</div><div class="sp-faint sp-small">{a.upn || '—'}</div></td>
                    <td class="sp-storage" title={fillTitle(a.storageUsed, a.storageAllocated)}>
                      <div class="sp-meter"><span class={fillClass(a.storageUsed, a.storageAllocated)} style="width:{barWidth(a.storageUsed, maxOd)}%"></span></div>
                      <div class="sp-small">{bytes(a.storageUsed)}{#if a.storageAllocated}{" "}<span class="sp-faint">von {bytes(a.storageAllocated)}</span>{/if}</div>
                    </td>
                    <td class="sp-small">{#if a.lastActivity}{day(a.lastActivity)}{:else if data.reports?.concealed}<span class="sp-na">anonymisiert</span>{:else}—{/if}</td>
                    <td class="sp-small">{day(a.modified)}</td>
                    <td>
                      {#if a.enabled === false}<span class="tbadge warn">Konto deaktiviert</span>
                      {:else if a.enabled}<span class="tbadge ok">aktiv</span>
                      {:else}<span class="sp-faint sp-small" title="Nur im Nutzungsbericht — kein Laufwerk mehr in Graph">nur im Bericht</span>{/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          {#if odShown.length > odLimit}
            <button class="sp-link" onclick={() => (odLimit = odShown.length)}>alle {odShown.length} anzeigen</button>
          {/if}
        {:else}
          <p class="sp-dim sp-small">Keine OneDrives gefunden{data.sitesSource === 'search' ? ' — die Sites kamen über die Suche, die OneDrives nicht liefert.' : '.'}</p>
        {/if}
      </section>

      <!-- ============================================================ Freigabe -->
      <section class="sp-section">
        <div class="sp-section-head"><h3>Freigabe-Einstellungen (tenantweit)</h3></div>
        {#if data.settings}
          <div class="sp-scale" role="list" aria-label="Freigabestufe SharePoint">
            {#each SHARE_STEPS as [key, label, tone], i}
              <div class="sp-step tone-{tone}" class:on={data.settings.sharing.key === key} role="listitem" aria-current={data.settings.sharing.key === key ? 'true' : undefined}>
                <span class="sp-step-n">{i + 1}</span>{label}
              </div>
            {/each}
          </div>
          <p class="sp-small sp-dim sp-scale-note"><span>geschlossener</span><span>offener</span></p>
          <div class="sp-settings">
            {#each data.settings.groups as grp (grp.title)}
              <div class="sp-card">
                <h4>{grp.title}</h4>
                <div class="sp-kv">
                  {#each grp.items as it (it.label)}
                    <span>{it.label}</span>
                    <span>{#if it.tone}<span class="tbadge {SHARE_TONE[it.tone] ?? ''}">{it.value}</span>{:else}{it.value}{/if}</span>
                  {/each}
                </div>
              </div>
            {/each}
          </div>
        {:else}
          <div class="alert alert-warning">Tenantweite Einstellungen nicht lesbar — SharePointTenantSettings.Read.All fehlt (im Tab «Tenants» einmal Reparieren).</div>
        {/if}
        <div class="sp-card sp-na-card">
          <h4>Nicht über Graph verfügbar</h4>
          <p class="sp-small sp-dim">Stellt Microsoft Graph nicht bereit — im SharePoint Admin Center bzw. per SharePoint Online PowerShell nachsehen.</p>
          <ul>
            {#each data.notViaGraph || [] as n (n.topic)}<li><strong>{n.topic}</strong> — {n.detail}</li>{/each}
          </ul>
        </div>
      </section>

      {#if data.hints?.length}
        <details class="sp-hints">
          <summary>Hinweise ({data.hints.length}) — bewertend, im PDF nur als abwählbarer Anhang</summary>
          {#each data.hints as h}<div class="za-line" class:warn={h.severity === 'warn'}>{h.text}</div>{/each}
        </details>
      {/if}
    {:else if !loading && !busy}
      <div class="sp-empty">
        <p><strong>Noch kein Inventar für {$activeTenant?.name}.</strong></p>
        <p class="sp-dim">«Erheben» liest Sites, M365-Gruppen, OneDrives, Nutzungsberichte und die Freigabe-Einstellungen — nur lesend, dauert je nach Tenant einige Sekunden bis Minuten.</p>
      </div>
    {/if}
  </div>
</TenantContext>

<style>
  .sp { display: flex; flex-direction: column; gap: 0.8rem; }
  .sp-bar { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
  .sp-stamp { font-size: 0.84rem; color: var(--text-dim); margin-right: auto; }
  .sp-opt { display: inline-flex; align-items: center; gap: 0.35rem; font-size: 0.82rem; color: var(--text-dim); }
  .sp-opt select { padding: 0.2rem 0.3rem; font-size: 0.82rem; }
  .sp-job { display: flex; gap: 0.75rem; align-items: center; }
  .sp-dim { color: var(--text-dim); }
  .sp-faint { color: var(--text-faint); }
  .sp-small { font-size: 0.78rem; }
  .sp-na {
    display: inline-block; font-size: 0.72rem; font-weight: 600; color: var(--text-dim);
    border: 1px dashed color-mix(in srgb, var(--text-faint) 70%, transparent); border-radius: 999px; padding: 0.05rem 0.5rem; white-space: nowrap;
  }
  .sp-link { background: none; border: 0; cursor: pointer; padding: 0; font: inherit; font-size: 0.8rem; text-decoration: underline; color: var(--accent); }

  /* ---------- Kennzahlen */
  .sp-hero { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)) minmax(0, 1.5fr); gap: 0.7rem; }
  .sp-kpi {
    background: var(--bg-raised); border: 1px solid var(--rule); border-radius: var(--radius-md);
    padding: 0.85rem 1rem; box-shadow: var(--shadow-sm); display: flex; flex-direction: column; gap: 0.1rem; min-width: 0;
    position: relative; overflow: hidden;
  }
  .sp-kpi::after { content: ''; position: absolute; inset: 0 auto 0 0; width: 3px; background: var(--accent); opacity: 0.55; }
  .sp-kpi-value { font-size: 1.75rem; font-weight: 700; line-height: 1.1; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
  .sp-kpi-label { font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-dim); }
  .sp-kpi-detail { font-size: 0.76rem; color: var(--text-faint); margin-top: 0.15rem; }
  .sp-kpi-share { --tone: var(--text-dim); --wash: var(--bg-inset); background: var(--wash); border-color: color-mix(in srgb, var(--tone) 40%, var(--rule)); }
  .sp-kpi-share::after { background: var(--tone); opacity: 1; }
  .sp-kpi-share.tone-ok { --tone: var(--ok); --wash: var(--ok-wash); }
  .sp-kpi-share.tone-info { --tone: var(--info); --wash: var(--info-wash); }
  .sp-kpi-share.tone-warn { --tone: var(--warn); --wash: var(--warn-wash); }
  .sp-kpi-share.tone-crit { --tone: var(--crit); --wash: var(--crit-wash); }
  .sp-share-badge {
    align-self: flex-start; margin: 0.3rem 0 0.1rem; padding: 0.3rem 0.8rem; border-radius: 999px;
    background: var(--tone); color: #fff; font-weight: 700; font-size: 0.95rem;
  }
  .sp-kpi-share .sp-kpi-detail { color: var(--text-dim); }

  /* ---------- Zusammensetzung */
  .sp-comp { display: flex; height: 12px; border-radius: 6px; overflow: hidden; background: var(--bg-inset); gap: 2px; }
  .sp-comp-seg { display: block; height: 100%; min-width: 4px; }
  .sp-legend { display: flex; flex-wrap: wrap; gap: 0.35rem 0.9rem; align-items: center; margin-top: -0.35rem; }
  .sp-legend-item { display: inline-flex; align-items: center; gap: 0.35rem; background: none; border: 0; cursor: pointer; font: inherit; font-size: 0.8rem; color: var(--text-dim); padding: 0; }
  .sp-legend-item:hover { color: var(--text); }
  .sp-legend-item strong { color: var(--text); }
  .sp-legend-note { font-size: 0.8rem; color: var(--warn); margin-left: auto; }
  .sp-dot { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }

  /* Farben je Art — Blautöne für Gruppen/Teams, Grau für ohne Gruppe/System */
  .k-teams { --k: #005f80; }
  .k-group { --k: #0081ad; }
  .k-comm { --k: #3aa6d0; }
  .k-team { --k: #7cc3e0; }
  .k-classic { --k: #8d98a3; }
  .k-chan { --k: #6b7fa6; }
  .k-other { --k: #aab4bc; }
  .k-unknown { --k: #c3ccd3; }
  .k-system { --k: #dde3e8; }
  .sp-comp-seg, .sp-dot { background: var(--k); }
  .sp-kind {
    display: inline-block; font-size: 0.72rem; font-weight: 700; padding: 0.12rem 0.55rem; border-radius: 999px; white-space: nowrap;
    color: color-mix(in srgb, var(--k) 80%, var(--text)); background: color-mix(in srgb, var(--k) 16%, transparent);
    border: 1px solid color-mix(in srgb, var(--k) 45%, transparent);
  }

  /* ---------- Abschnitte */
  .sp-section { display: flex; flex-direction: column; gap: 0.55rem; margin-top: 0.4rem; }
  .sp-section-head { display: flex; align-items: baseline; gap: 0.8rem; flex-wrap: wrap; }
  .sp-section-head h3 { font-size: 1.05rem; margin: 0; }
  .sp-csv { margin-left: auto; font-size: 0.8rem; color: var(--text-dim); }
  .sp-filterbar { display: flex; gap: 0.4rem; flex-wrap: wrap; align-items: center; }
  .sp-chip-n { opacity: 0.7; font-variant-numeric: tabular-nums; margin-left: 0.15rem; }
  .sp-sort { margin-left: auto; padding: 0.3rem 0.4rem; font-size: 0.82rem; border: 1px solid var(--rule); border-radius: var(--radius-sm); background: transparent; color: inherit; }
  .sp-search { min-width: 220px; padding: 0.35rem 0.6rem; font-size: 0.85rem; border: 1px solid var(--rule); border-radius: var(--radius-sm); background: transparent; color: inherit; }

  .sp-table td { vertical-align: top; }
  .sp-table th.num, .sp-table td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .sp-caret { width: 1.4rem; color: var(--text-faint); padding-right: 0 !important; }
  .sp-row { cursor: pointer; }
  .sp-caret-btn { background: none; border: 0; padding: 0 0.2rem; cursor: pointer; color: inherit; font: inherit; }
  .sp-caret-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; border-radius: 3px; }
  .sp-row.open td { background: color-mix(in srgb, var(--accent) 5%, transparent); }
  .sp-name { font-weight: 700; }
  .sp-url { font-family: var(--font-mono); font-size: 0.74rem; color: var(--text-dim); text-decoration: none; word-break: break-all; }
  .sp-url:hover { color: var(--accent); text-decoration: underline; }
  .sp-storage { min-width: 9rem; }
  .sp-meter { height: 6px; border-radius: 3px; background: var(--bg-inset); overflow: hidden; margin: 0.35rem 0 0.2rem; }
  .sp-meter span { display: block; height: 100%; border-radius: 3px; background: var(--accent); }
  .sp-meter span.warn { background: var(--warn); }
  .sp-meter span.crit { background: var(--crit); }

  .sp-detail > td { background: color-mix(in srgb, var(--accent) 3%, transparent); padding: 0.75rem 0.8rem 0.9rem !important; }
  .sp-detail-grid { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: 1.2rem; }
  .sp-kv { display: grid; grid-template-columns: 10.5rem minmax(0, 1fr); gap: 0.3rem 0.8rem; font-size: 0.82rem; align-content: start; }
  .sp-kv > span:nth-child(odd) { color: var(--text-dim); font-weight: 600; }
  .sp-kv a { word-break: break-all; color: var(--accent); }
  .sp-kv code { font-size: 0.74rem; }
  .sp-people h5 { margin: 0 0 0.3rem; font-size: 0.82rem; }
  .sp-people h5 + .sp-chips { margin-bottom: 0.7rem; }
  .sp-chips { display: flex; flex-wrap: wrap; gap: 0.3rem; }
  .sp-person { font-size: 0.76rem; padding: 0.12rem 0.5rem; border-radius: 999px; background: var(--bg-inset); border: 1px solid var(--rule); }
  .sp-person.guest { background: var(--warn-wash); border-color: color-mix(in srgb, var(--warn) 40%, transparent); }
  .sp-person small { color: var(--warn); font-weight: 700; }

  /* ---------- Freigabe */
  .sp-scale { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0.35rem; }
  .sp-step {
    --tone: var(--text-dim); --wash: var(--bg-inset);
    display: flex; align-items: center; gap: 0.5rem; padding: 0.6rem 0.75rem; border-radius: var(--radius-sm);
    background: var(--bg-inset); color: var(--text-faint); font-size: 0.84rem; font-weight: 600; border: 1px solid transparent;
  }
  .sp-step.tone-ok { --tone: var(--ok); --wash: var(--ok-wash); }
  .sp-step.tone-info { --tone: var(--info); --wash: var(--info-wash); }
  .sp-step.tone-warn { --tone: var(--warn); --wash: var(--warn-wash); }
  .sp-step.tone-crit { --tone: var(--crit); --wash: var(--crit-wash); }
  .sp-step.on { background: var(--wash); color: var(--text); border-color: var(--tone); box-shadow: inset 0 -3px 0 var(--tone); }
  .sp-step-n {
    flex: none; width: 1.4rem; height: 1.4rem; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;
    font-size: 0.72rem; background: color-mix(in srgb, var(--text-faint) 25%, transparent); color: var(--text-dim);
  }
  .sp-step.on .sp-step-n { background: var(--tone); color: #fff; }
  .sp-scale-note { display: flex; justify-content: space-between; margin-top: -0.3rem; }
  .sp-settings { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(360px, 100%), 1fr)); gap: 0.7rem; }
  .sp-card { background: var(--bg-raised); border: 1px solid var(--rule); border-radius: var(--radius-md); padding: 0.8rem 0.95rem; }
  .sp-card h4 { margin: 0 0 0.5rem; font-size: 0.88rem; }
  .sp-card .sp-kv { grid-template-columns: minmax(7rem, 38%) minmax(0, 1fr); }
  .sp-na-card { border-style: dashed; }
  .sp-na-card ul { margin: 0.4rem 0 0 1.1rem; font-size: 0.82rem; display: flex; flex-direction: column; gap: 0.25rem; }

  .sp-hints summary { cursor: pointer; font-size: 0.86rem; font-weight: 700; color: var(--text-dim); margin-bottom: 0.4rem; }
  .sp-hints .za-line { font-size: 0.84rem; padding-left: 0.6rem; border-left: 3px solid var(--rule); margin: 0.2rem 0; }
  .sp-hints .za-line.warn { border-left-color: var(--warn); }
  .sp-people .za-line { font-size: 0.8rem; padding-left: 0.6rem; border-left: 3px solid var(--warn); margin-bottom: 0.4rem; }
  .sp-gaps { margin: 0.3rem 0 0 1.1rem; font-size: 0.82rem; }
  .sp-empty { border: 1px dashed var(--rule); border-radius: var(--radius-md); padding: 1.4rem; text-align: center; display: flex; flex-direction: column; gap: 0.35rem; }

  @media (max-width: 1100px) {
    .sp-hero { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .sp-kpi-share { grid-column: 1 / -1; }
  }
  @media (max-width: 720px) {
    .sp-kpi { padding: 0.7rem 0.8rem; }
    .sp-kpi-value { font-size: 1.45rem; }
    .sp-scale { grid-template-columns: 1fr 1fr; }
    .sp-detail-grid { grid-template-columns: 1fr; }
    .sp-kv, .sp-card .sp-kv { grid-template-columns: 1fr; gap: 0.05rem; }
    .sp-kv > span:nth-child(even) { margin-bottom: 0.3rem; }
    .sp-search, .sp-sort { margin-left: 0; width: 100%; }
    .sp-csv { margin-left: 0; }
  }
</style>
