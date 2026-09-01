<script>
  // GroupTag-Verwaltung: dynamische Gruppen anlegen, Autopilot-Geräte sehen und
  // ihnen Tags zuordnen — immer im oben gewählten Tenant.
  //
  // (Die Endpunkte können serverseitig auch fremde Tenants per Client-Id/Secret
  // bedienen. Das nutzt der Migrations-Bereich für den Zieltenant; hier wäre
  // ein zweiter Tenant-Umschalter neben dem im Kopf nur verwirrend.)
  import { apiPost } from '../lib/api.js'
  import { activeTenant } from '../lib/tenantStore.js'
  import { session } from '../lib/session.js'
  import TenantContext from '../lib/TenantContext.svelte'
  import { loadNaming } from '../lib/naming.js'

  let groups = $state(null)
  let devices = $state(null)
  let busy = $state(false)
  let error = $state(null)
  let notice = $state(null)

  // Die Endpunkte liegen nicht unter /api/tenants/:id, deshalb geht die Id im
  // Body mit. (Serverseitig kann derselbe Weg auch fremde Tenants per
  // Client-Id/Secret bedienen — das nutzt der Migrations-Bereich für den
  // Zieltenant. Hier gilt immer der oben gewählte Tenant.)
  function creds() {
    return { tenantId: $activeTenant ? $activeTenant.id : '' }
  }

  const canQuery = $derived(!!$activeTenant)

  // Beim Betreten und bei jedem Tenantwechsel automatisch laden — der Knopf
  // war ein unnötiger Zwischenschritt.
  let loadedFor = null
  $effect(() => {
    const t = $activeTenant
    if (!$session.loggedIn || !t || busy) return
    if (loadedFor === t.id) return
    loadedFor = t.id
    groups = null
    devices = null
    appGroups = null
    selected = {}
    agSelected = {}
    loadAll()
  })

  async function loadAll() {
    if (!canQuery) return
    busy = true; error = null; notice = null
    try {
      const [g, d] = await Promise.all([
        apiPost('/api/grouptags/groups', creds()),
        apiPost('/api/grouptags/devices', creds())
      ])
      groups = g.groups || []
      devices = d.devices || []
    } catch (e) {
      error = e.message
    }
    busy = false
    // Eigener Durchgang: Fehlen die App-Leserechte, soll wenigstens der Rest
    // der Seite stehen — deshalb nicht in dasselbe try wie oben.
    loadAppGroups()
  }

  // ---------- Gruppe anlegen ----------
  let newTag = $state('')
  let newName = $state('')
  let createBusy = $state(false)

  const knownTags = $derived(groups ? [...new Set(groups.flatMap(g => g.tags))].sort() : [])
  // Tags, die auf Geräten kleben, für die es keine Gruppe gibt — genau die
  // laufen ins Leere und sind der häufigste Grund für "Gerät bekommt nichts".
  const orphanTags = $derived(
    devices && groups
      ? [...new Set(devices.map(d => d.groupTag).filter(Boolean))].filter(t => !knownTags.includes(t)).sort()
      : []
  )
  const untaggedCount = $derived(devices ? devices.filter(d => !d.groupTag).length : 0)

  async function createGroup(tag) {
    const t = (tag || newTag).trim()
    if (!t) return
    if (!confirm(`Dynamische Sicherheitsgruppe für GroupTag "${t}" anlegen?\n\nDas schreibt in den Tenant ${$activeTenant?.name}.`)) return
    createBusy = true; error = null; notice = null
    try {
      const r = await apiPost('/api/grouptags/groups/create', { ...creds(), groupTag: t, displayName: tag ? '' : newName })
      notice = r.created
        ? `Gruppe „${r.group.displayName}" angelegt. Die Zuordnung der Geräte übernimmt Entra, das dauert ein paar Minuten.`
        : `Für „${t}" gibt es bereits die Gruppe „${r.group.displayName}" — nichts angelegt.`
      newTag = ''; newName = ''
      await loadAll()
    } catch (e) {
      error = e.message
    }
    createBusy = false
  }

  // ---------- App-Zielgruppen ----------
  // Eine App wird in Intune (bzw. in Patch My PC) immer an genau EINE Gruppe
  // zugewiesen; welche Geräte sie bekommen, steuert das Nesting: die
  // dynamische GroupTag-Gerätegruppe wird Mitglied der App-Gruppe. Damit lässt
  // sich die ganze Zuweisungsstruktur hier vorbereiten — im Entra- oder
  // Intune-Portal muss dafür niemand mehr etwas anlegen.
  let appGroups = $state(null)
  let appGroupsError = $state(null)
  let assignmentsOk = $state(true)
  let agName = $state('')
  let agScheme = $state('auto')
  let nm = $state(null)
  let agManaged = $state('app')
  let agSelected = $state({})     // deviceGroupId -> bool
  let agBusy = $state(false)
  let agUnnestBusy = $state({})   // appGroupId|deviceGroupId -> bool

  // Die drei Pflichtmodule je Kunde plus FortiClient, wo Fortinet steht.
  const AG_PRESETS = [
    { label: 'Bitdefender', name: 'Bitdefender', managed: 'app' },
    { label: 'RMM-Agent', name: 'AdvancedMonitoringAgent', managed: 'app' },
    { label: 'Bitwarden', name: 'Bitwarden', managed: 'pmp' },
    { label: 'FortiClient', name: 'FortiClient', managed: 'app' }
  ]

  // 'auto' folgt der eingestellten Namenskonvention (Tab Namenskonvention);
  // die beiden anderen Werte erzwingen ein Profil — etwa wenn in einem Tenant
  // bewusst noch das Altschema weitergeführt wird.
  function agBuildName(name, scheme, managed) {
    const clean = String(name || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 60)
    if (!clean) return ''
    if (scheme === 'auto') {
      const kind = managed === 'pmp' ? 'pmpGroup' : 'appGroup'
      const v = nm ? nm.name(kind, { app: clean }) : ''
      if (v) return v
    }
    const prefix = scheme === 'v2'
      ? (managed === 'pmp' ? 'T2-DG-WIN-Pmp' : 'T2-DG-WIN-App')
      : (managed === 'pmp' ? 'AAD-PMP-' : 'AAD-APP-')
    return prefix + clean
  }

  const agPreview = $derived(agBuildName(agName, agScheme, agManaged))
  // Nur Gruppen mit [OrderID]-Tag sind Autopilot-Gerätegruppen — nur die
  // ergeben als Mitglied einer App-Gruppe Sinn.
  const agCandidates = $derived(groups ? groups.filter(g => g.tags.length) : [])
  const agSelectedIds = $derived(Object.entries(agSelected).filter(([, v]) => v).map(([k]) => k))
  const agExists = $derived(
    appGroups && agPreview ? appGroups.some(g => g.displayName.toLowerCase() === agPreview.toLowerCase()) : false
  )

  async function loadAppGroups() {
    if (!canQuery) return
    appGroupsError = null
    try { nm = await loadNaming($activeTenant.id) } catch (e) { /* Rückfall auf die festen Präfixe */ }
    try {
      const r = await apiPost('/api/appgroups/list', creds())
      appGroups = r.groups || []
      assignmentsOk = r.assignmentsOk !== false
    } catch (e) {
      appGroups = []
      appGroupsError = e.message
    }
  }

  function agPreset(p) {
    agName = p.name
    agManaged = p.managed
  }

  async function createAppGroup() {
    if (!agPreview) return
    const names = agCandidates.filter(g => agSelectedIds.includes(g.id)).map(g => g.displayName)
    const what = names.length
      ? `Gruppe „${agPreview}" anlegen und ${names.join(', ')} als Mitglied aufnehmen?`
      : `Gruppe „${agPreview}" ohne Mitglieder anlegen?`
    if (!confirm(`${what}\n\nDas schreibt in den Tenant ${$activeTenant?.name}.`)) return

    agBusy = true; error = null; notice = null
    try {
      const r = await apiPost('/api/appgroups/ensure', {
        ...creds(),
        appName: agName,
        scheme: agScheme,
        managed: agManaged,
        deviceGroupIds: agSelectedIds
      })
      const added = (r.nested || []).filter(n => n.status === 'added').length
      const failed = (r.nested || []).filter(n => n.status === 'failed')
      notice = `${r.group.created ? 'Gruppe angelegt' : 'Gruppe war schon vorhanden'}: „${r.group.displayName}"`
        + (added ? `, ${added} Gerätegruppe(n) verknüpft` : '')
        + (failed.length ? ` — ${failed.length} Verknüpfung(en) fehlgeschlagen: ${failed[0].error}` : '')
        + '. Die Zuweisung der App selbst passiert in Patch My PC gegen diese Gruppe.'
      agName = ''
      agSelected = {}
      await loadAppGroups()
    } catch (e) {
      error = e.message
    }
    agBusy = false
  }

  async function unnest(appGroup, deviceGroup) {
    if (!confirm(`„${deviceGroup.displayName}" aus „${appGroup.displayName}" entfernen?\n\nDie Geräte dieser Gruppe bekommen die App danach nicht mehr. Das schreibt in den Tenant ${$activeTenant?.name}.`)) return
    const key = appGroup.id + '|' + deviceGroup.id
    agUnnestBusy[key] = true; error = null; notice = null
    try {
      await apiPost('/api/appgroups/unnest', { ...creds(), appGroupId: appGroup.id, deviceGroupId: deviceGroup.id })
      notice = `„${deviceGroup.displayName}" ist nicht mehr Mitglied von „${appGroup.displayName}".`
      await loadAppGroups()
    } catch (e) {
      error = e.message
    }
    agUnnestBusy[key] = false
  }

  // ---------- Geräte taggen ----------
  let selected = $state({})       // deviceId -> bool
  let bulkTag = $state('')
  let bulkBusy = $state(false)
  let filter = $state('')
  let rowBusy = $state({})        // deviceId -> bool, während eine Einzelzuweisung läuft
  let rowDone = $state({})        // deviceId -> true, kurz nach Erfolg

  // Einzelzuweisung direkt in der Zeile: für "dieses eine Gerät bitte auf
  // DEV-ADM" ist der Umweg über Auswahl + Bulk unnötig umständlich.
  async function setRowTag(device, tag) {
    if (tag === device.groupTag) return
    rowBusy[device.id] = true
    error = null
    try {
      await apiPost('/api/grouptags/devices/tag', { ...creds(), deviceId: device.id, groupTag: tag })
      device.groupTag = tag          // sofort sichtbar, statt die ganze Liste neu zu ziehen
      rowDone[device.id] = true
      setTimeout(() => { rowDone[device.id] = false }, 2500)
    } catch (e) {
      error = `Gerät ${device.serialNumber}: ${e.message}`
    }
    rowBusy[device.id] = false
  }

  // Auswahlmöglichkeiten für die Zuweisung: bekannte Tags plus die, die schon
  // auf Geräten kleben (auch ohne Gruppe — sonst kann man sie nicht wieder
  // wegnehmen, wenn man sie im Dropdown nicht sieht).
  const assignableTags = $derived(
    [...new Set([...(knownTags || []), ...(devices || []).map(d => d.groupTag).filter(Boolean)])].sort()
  )

  const shown = $derived(
    devices
      ? devices.filter(d => {
          const f = filter.trim().toLowerCase()
          if (!f) return true
          return [d.serialNumber, d.model, d.deviceName, d.groupTag, d.user, d.userDisplayName, d.assignedUser]
            .filter(Boolean).join(' ').toLowerCase().includes(f)
        })
      : []
  )
  const selectedIds = $derived(Object.entries(selected).filter(([, v]) => v).map(([k]) => k))

  function toggleAllShown(on) {
    for (const d of shown) selected[d.id] = on
  }

  async function applyBulkTag() {
    if (!selectedIds.length) return
    const tag = bulkTag.trim()
    const what = tag ? `auf „${tag}" setzen` : 'GroupTag entfernen'
    if (!confirm(`Bei ${selectedIds.length} Gerät(en) den ${what}?\n\nDas schreibt in den Tenant. Wirksam wird es, sobald Entra die dynamischen Gruppen neu auswertet.`)) return
    bulkBusy = true; error = null; notice = null
    try {
      const r = await apiPost('/api/grouptags/devices/tag-bulk', { ...creds(), deviceIds: selectedIds, groupTag: tag })
      notice = r.failed
        ? `${selectedIds.length - r.failed} von ${selectedIds.length} Geräten gesetzt, ${r.failed} fehlgeschlagen.`
        : `${selectedIds.length} Gerät(e) auf „${tag || '— kein Tag —'}" gesetzt.`
      selected = {}
      await loadAll()
    } catch (e) {
      error = e.message
    }
    bulkBusy = false
  }
</script>

<TenantContext>
  <div style="display:flex; justify-content:flex-end; margin-bottom:0.5rem">
    <button class="btn btn-secondary" onclick={loadAll} disabled={!canQuery || busy}>
      {busy ? 'Lade…' : '↻ Aktualisieren'}
    </button>
  </div>

  {#if busy && !groups}
    <p class="ld-section-hint"><span class="ld-spinner"></span> Lade Gruppen und Geräte…</p>
  {/if}

  {#if error}<div class="alert alert-warning">❌ {error}</div>{/if}
  {#if notice}<div class="ld-banner ok">{notice}</div>{/if}

  {#if groups}
    <div class="settings-group" style="margin-top:1.25rem">
      <h4>Dynamische Gruppen ({groups.length})</h4>
      {#if orphanTags.length}
        <div class="alert alert-warning">
          <strong>{orphanTags.length} GroupTag(s) ohne Gruppe:</strong> {orphanTags.join(', ')}<br />
          <small>Geräte tragen diese Tags, aber keine Gruppe wertet sie aus — die Geräte bekommen weder Profil noch Policies.</small>
          <div style="margin-top:0.5rem; display:flex; gap:0.4rem; flex-wrap:wrap">
            {#each orphanTags as t}
              <button class="btn btn-secondary" disabled={createBusy} onclick={() => createGroup(t)}>➕ Gruppe für „{t}" anlegen</button>
            {/each}
          </div>
        </div>
      {/if}

      {#if groups.length === 0}
        <p class="ld-section-hint">Keine dynamischen Sicherheitsgruppen vorhanden.</p>
      {:else}
        <div class="gt-groups">
          {#each groups as g (g.id)}
            {@const count = devices ? devices.filter(d => d.groupTag && g.tags.includes(d.groupTag)).length : null}
            <div class="gt-group" class:gt-group-plain={!g.tags.length}>
              <div class="gt-group-head">
                <strong>{g.displayName}</strong>
                {#if g.state !== 'On'}<span class="tbadge warn">Regel {g.state || 'aus'}</span>{/if}
              </div>
              {#if g.tags.length}
                <div class="gt-taglist">
                  {#each g.tags as t}<span class="gt-tag">{t}</span>{/each}
                  {#if count !== null}<span class="gt-count">{count} Gerät{count === 1 ? '' : 'e'}</span>{/if}
                </div>
              {:else}
                <div class="gt-plainnote">kein [OrderID]-Tag — für GroupTags nicht relevant</div>
              {/if}
              <details class="gt-rule">
                <summary>Regel</summary>
                <code>{g.rule || '—'}</code>
              </details>
            </div>
          {/each}
        </div>
      {/if}

      <div style="margin-top:0.85rem; display:flex; gap:0.5rem; flex-wrap:wrap; align-items:flex-end">
        <div class="input-group" style="max-width:200px; margin:0">
          <label for="gt-newtag">Neuer GroupTag</label>
          <input id="gt-newtag" type="text" bind:value={newTag} placeholder="DEV-STD" />
        </div>
        <div class="input-group" style="max-width:240px; margin:0">
          <label for="gt-newname">Gruppenname <small>(leer = nach Konvention)</small></label>
          <input id="gt-newname" type="text" bind:value={newName} placeholder={nm ? nm.name('deviceGroup', { tag: newTag || 'WIN-Std' }) : 'AAD-DEV-STD'} />
        </div>
        <button class="btn btn-primary" disabled={!newTag.trim() || createBusy} onclick={() => createGroup()}>
          {createBusy ? 'Lege an…' : '➕ Gruppe anlegen'}
        </button>
      </div>
    </div>
  {/if}

  {#if groups}
    <div class="settings-group" style="margin-top:1.25rem">
      <h4>App-Zielgruppen {appGroups ? `(${appGroups.length})` : ''}</h4>
      <p class="ld-section-hint" style="margin-top:0">
        Eine App wird immer an <strong>genau eine</strong> Gruppe zugewiesen. Welche Geräte sie bekommen,
        steuert die Mitgliedschaft: Die dynamische GroupTag-Gerätegruppe wird Mitglied der App-Gruppe.
        Hier angelegt, in Patch My PC nur noch ausgewählt — im Entra- oder Intune-Portal ist dafür nichts zu tun.
      </p>

      {#if appGroupsError}
        <div class="alert alert-warning">App-Zielgruppen konnten nicht gelesen werden: {appGroupsError}</div>
      {:else if !assignmentsOk}
        <div class="alert alert-warning">
          Die Gruppen sind gelesen, die zugewiesenen Apps nicht — dafür fehlt der App-Registrierung die
          Leseberechtigung auf Intune-Apps. Anlegen und Verknüpfen funktioniert trotzdem.
        </div>
      {/if}

      {#if appGroups && appGroups.length}
        <div class="gt-groups">
          {#each appGroups as g (g.id)}
            <div class="gt-group">
              <div class="gt-group-head">
                <strong>{g.displayName}</strong>
                {#if g.scheme === 'v2'}<span class="tbadge">v2-Schema</span>{/if}
                {#if g.managed === 'pmp'}<span class="tbadge">Patch My PC</span>{/if}
              </div>

              {#if g.memberGroups.length}
                <div class="gt-taglist">
                  {#each g.memberGroups as m (m.id)}
                    <span class="ag-member">
                      {m.displayName}
                      <button class="ag-x" title="Verknüpfung lösen"
                              disabled={agUnnestBusy[g.id + '|' + m.id]}
                              onclick={() => unnest(g, m)}>✕</button>
                    </span>
                  {/each}
                </div>
              {:else}
                <div class="gt-plainnote">keine Gerätegruppe verknüpft — die App erreicht so kein Gerät</div>
              {/if}

              {#if g.otherMemberCount}
                <div class="gt-plainnote">
                  zusätzlich {g.otherMemberCount} direkte(s) Mitglied(er) — laut Konzept gehören dort nur Gruppen hinein
                </div>
              {/if}

              {#if assignmentsOk}
                <div class="ag-apps">
                  {#if g.apps.length}
                    {#each g.apps as a}
                      <span class="ag-app">📦 {a.displayName}{a.intent ? ` · ${a.intent}` : ''}</span>
                    {/each}
                  {:else}
                    <span class="ag-app ag-app-none">noch keine Intune-App auf dieser Gruppe zugewiesen</span>
                  {/if}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {:else if appGroups}
        <p class="ld-section-hint">Noch keine App-Zielgruppen in diesem Tenant.</p>
      {/if}

      <h5 class="ag-sub">Neue App-Zielgruppe</h5>
      <div class="ag-presets">
        {#each AG_PRESETS as p}
          <button class="btn btn-secondary" onclick={() => agPreset(p)}>{p.label}</button>
        {/each}
      </div>

      <div class="ag-form">
        <div class="input-group" style="max-width:220px; margin:0">
          <label for="ag-name">App</label>
          <input id="ag-name" type="text" bind:value={agName} placeholder="Bitdefender" />
        </div>
        <div class="input-group" style="max-width:190px; margin:0">
          <label for="ag-managed">Verwaltung</label>
          <select id="ag-managed" bind:value={agManaged}>
            <option value="app">selbst paketiert</option>
            <option value="pmp">Patch My PC</option>
          </select>
        </div>
        <div class="input-group" style="max-width:230px; margin:0">
          <label for="ag-scheme">Namensschema</label>
          <select id="ag-scheme" bind:value={agScheme}>
            <option value="auto">nach Konvention</option>
            <option value="legacy">Bestand (AAD-APP-…)</option>
            <option value="v2">v2 (T2-DG-WIN-App…)</option>
          </select>
        </div>
      </div>

      {#if agPreview}
        <p class="ag-preview">
          Gruppenname: <code>{agPreview}</code>
          {#if agExists}<span class="tbadge warn">gibt es schon — es wird nur verknüpft</span>{/if}
        </p>
      {/if}

      <div class="ag-pick">
        <div class="ag-pick-head">
          Gerätegruppen, die diese App bekommen sollen
          {#if agCandidates.length}
            <button class="ag-link" onclick={() => { for (const g of agCandidates) agSelected[g.id] = true }}>alle</button>
            <button class="ag-link" onclick={() => (agSelected = {})}>keine</button>
          {/if}
        </div>
        {#if agCandidates.length}
          <div class="ag-pick-list">
            {#each agCandidates as g (g.id)}
              <label class="ag-pick-item">
                <input type="checkbox" bind:checked={agSelected[g.id]} />
                <span>{g.displayName}</span>
                <span class="ag-pick-tags">{g.tags.join(', ')}</span>
              </label>
            {/each}
          </div>
        {:else}
          <p class="ld-section-hint">
            Keine dynamische GroupTag-Gerätegruppe vorhanden — zuerst oben eine anlegen,
            sonst hat die App-Gruppe keine Mitglieder.
          </p>
        {/if}
      </div>

      <button class="btn btn-primary" style="margin-top:0.75rem"
              disabled={!agPreview || agBusy} onclick={createAppGroup}>
        {agBusy ? 'Lege an…' : '➕ Gruppe anlegen und verknüpfen'}
      </button>
      <p class="ld-section-hint" style="margin-top:0.6rem">
        Danach in Patch My PC die App gegen diese Gruppe zuweisen — Intent <strong>Required</strong>,
        keine Ringe. Bis Entra die Mitgliedschaft ausgewertet hat, vergehen ein paar Minuten.
      </p>
    </div>
  {/if}

  {#if devices}
    <div class="settings-group" style="margin-top:1.25rem">
      <h4>Autopilot-Geräte ({devices.length}{untaggedCount ? `, davon ${untaggedCount} ohne Tag` : ''})</h4>

      <div style="display:flex; gap:0.5rem; flex-wrap:wrap; align-items:flex-end; margin-bottom:0.6rem">
        <div class="input-group" style="max-width:240px; margin:0">
          <label for="gt-filter">Filter</label>
          <input id="gt-filter" type="text" bind:value={filter} placeholder="Seriennummer, Modell, Tag…" />
        </div>
        <button class="btn btn-secondary" onclick={() => toggleAllShown(true)}>Alle sichtbaren wählen</button>
        <button class="btn btn-secondary" onclick={() => (selected = {})}>Auswahl leeren</button>
      </div>

      {#if selectedIds.length}
        <div class="ld-job" style="margin-bottom:0.6rem">
          <strong>{selectedIds.length} Gerät(e) ausgewählt</strong>
          <div style="display:flex; gap:0.5rem; flex-wrap:wrap; align-items:center; margin-top:0.5rem">
            {#if knownTags.length}
              <select bind:value={bulkTag} style="max-width:220px">
                <option value="">— GroupTag entfernen —</option>
                {#each knownTags as t}<option value={t}>{t}</option>{/each}
              </select>
            {:else}
              <input type="text" bind:value={bulkTag} placeholder="DEV-STD" style="max-width:200px" />
            {/if}
            <button class="btn btn-primary" disabled={bulkBusy} onclick={applyBulkTag}>
              {bulkBusy ? 'Setze…' : '🏷 GroupTag zuweisen'}
            </button>
          </div>
        </div>
      {/if}

      {#if shown.length === 0}
        <p class="ld-section-hint">Keine Geräte{filter ? ' für diesen Filter' : ''}.</p>
      {:else}
        <div class="gt-table-wrap">
          <table class="gt-table">
            <thead>
              <tr><th></th><th>Gerät</th><th>Seriennummer</th><th>GroupTag</th><th>Autopilot-Profil</th><th>Benutzer</th><th>Status</th></tr>
            </thead>
            <tbody>
              {#each shown as d (d.id)}
                <tr class:gt-untagged={!d.groupTag}>
                  <td><input type="checkbox" bind:checked={selected[d.id]} /></td>
                  <td>
                    {#if d.deviceName}<strong>{d.deviceName}</strong><br />{/if}
                    <small>{d.manufacturer} {d.model}</small>
                  </td>
                  <td><code>{d.serialNumber}</code></td>
                  <td>
                    <div class="gt-tagcell">
                      <select class="gt-tagselect" disabled={rowBusy[d.id]}
                              value={d.groupTag}
                              onchange={(e) => setRowTag(d, e.currentTarget.value)}>
                        <option value="">— kein Tag —</option>
                        {#each assignableTags as t}<option value={t}>{t}</option>{/each}
                      </select>
                      {#if rowBusy[d.id]}
                        <span class="ld-spinner"></span>
                      {:else if rowDone[d.id]}
                        <span class="gt-ok" title="gesetzt">✅</span>
                      {:else if d.groupTag && orphanTags.includes(d.groupTag)}
                        <button class="tbadge warn gt-fix" title="Keine Gruppe wertet diesen Tag aus — Gruppe anlegen"
                                onclick={() => createGroup(d.groupTag)}>ohne Gruppe ➕</button>
                      {/if}
                    </div>
                  </td>
                  <td>
                    {#if d.profileName}
                      {d.profileName}
                      {#if d.profileStatus && !/assignedinsync|assigned$/i.test(d.profileStatus)}
                        <br /><small title={d.profileStatusDetail}>{d.profileStatus}</small>
                      {/if}
                    {:else if d.profileStatus}
                      <em>{d.profileStatus}</em>
                    {:else}
                      <em>kein Profil</em>
                    {/if}
                  </td>
                  <td>
                    {#if d.user}
                      {d.userDisplayName || d.user}
                      {#if d.userDisplayName}<br /><small>{d.user}</small>{/if}
                    {:else if d.assignedUser}
                      {d.assignedUser}<br /><small>vorab zugewiesen, noch nicht angemeldet</small>
                    {:else}
                      <em>—</em>
                    {/if}
                  </td>
                  <td>{d.enrollmentState || '—'}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
      <p class="ld-section-hint">„Benutzer" ist der Primärbenutzer aus Intune — wer sich als Erster am Gerät
        angemeldet hat. Leer heisst: noch keine Anmeldung, ein gemeinsam genutztes Gerät, oder der Primärbenutzer
        wurde bewusst entfernt.
        <br />Pro Gerät wirkt genau <strong>ein</strong> Autopilot-Profil. Sind mehrere Profile auf Gruppen zugewiesen,
        in denen das Gerät steckt, entscheidet Intune selbst — angezeigt wird das tatsächlich wirksame.
        <br />Ein geänderter GroupTag wirkt, sobald Entra die dynamischen Gruppen neu auswertet — das dauert
        üblicherweise ein paar Minuten.</p>
    </div>
  {/if}
</TenantContext>

<style>
  .ag-sub { margin: 1.4rem 0 0.5rem; font-size: 0.95rem; }
  .ag-presets { display: flex; gap: 0.4rem; flex-wrap: wrap; margin-bottom: 0.6rem; }
  .ag-form { display: flex; gap: 0.6rem; flex-wrap: wrap; align-items: flex-end; }
  .ag-preview { margin: 0.7rem 0 0; display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }

  .ag-member {
    display: inline-flex; align-items: center; gap: 0.35rem;
    background: var(--surface-2, rgba(127, 127, 127, .12));
    border: 1px solid var(--border, rgba(127, 127, 127, .3));
    border-radius: 999px; padding: 0.1rem 0.25rem 0.1rem 0.6rem; font-size: 0.82rem;
  }
  .ag-x {
    background: none; border: 0; cursor: pointer; color: inherit; opacity: .55;
    font-size: 0.85rem; line-height: 1; padding: 0.2rem 0.35rem; border-radius: 999px;
  }
  .ag-x:hover:not(:disabled) { opacity: 1; color: #c0392b; }
  .ag-x:disabled { opacity: .3; cursor: default; }

  .ag-apps { display: flex; flex-wrap: wrap; gap: 0.35rem; margin-top: 0.45rem; }
  .ag-app { font-size: 0.78rem; opacity: .85; }
  .ag-app-none { opacity: .5; font-style: italic; }

  .ag-pick { margin-top: 0.9rem; }
  .ag-pick-head {
    display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;
    font-size: 0.8rem; text-transform: uppercase; letter-spacing: .05em;
    opacity: .7; margin-bottom: 0.4rem;
  }
  .ag-link {
    background: none; border: 0; cursor: pointer; padding: 0; font: inherit;
    font-size: 0.78rem; text-decoration: underline; color: inherit; opacity: .8;
  }
  .ag-link:hover { opacity: 1; }
  .ag-pick-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 0.3rem; }
  .ag-pick-item { display: flex; align-items: center; gap: 0.45rem; font-size: 0.87rem; cursor: pointer; }
  .ag-pick-tags { opacity: .55; font-size: 0.78rem; margin-left: auto; }
</style>
