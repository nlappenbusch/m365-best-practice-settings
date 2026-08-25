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
    selected = {}
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
          return (d.serialNumber + ' ' + d.model + ' ' + d.groupTag + ' ' + d.assignedUser).toLowerCase().includes(f)
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
  {#if notice}<div class="ld-banner ok">✅ {notice}</div>{/if}

  {#if groups}
    <div class="settings-group" style="margin-top:1.25rem">
      <h4>🏷 Dynamische Gruppen ({groups.length})</h4>
      {#if orphanTags.length}
        <div class="alert alert-warning">
          <strong>⚠️ {orphanTags.length} GroupTag(s) ohne Gruppe:</strong> {orphanTags.join(', ')}<br />
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
          <label for="gt-newname">Gruppenname <small>(leer = AAD-&lt;Tag&gt;)</small></label>
          <input id="gt-newname" type="text" bind:value={newName} placeholder="AAD-DEV-STD" />
        </div>
        <button class="btn btn-primary" disabled={!newTag.trim() || createBusy} onclick={() => createGroup()}>
          {createBusy ? 'Lege an…' : '➕ Gruppe anlegen'}
        </button>
      </div>
    </div>
  {/if}

  {#if devices}
    <div class="settings-group" style="margin-top:1.25rem">
      <h4>💻 Autopilot-Geräte ({devices.length}{untaggedCount ? `, davon ${untaggedCount} ohne Tag` : ''})</h4>

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
              <tr><th></th><th>Seriennummer</th><th>Modell</th><th>GroupTag</th><th>Zugewiesen an</th><th>Status</th></tr>
            </thead>
            <tbody>
              {#each shown as d (d.id)}
                <tr class:gt-untagged={!d.groupTag}>
                  <td><input type="checkbox" bind:checked={selected[d.id]} /></td>
                  <td><code>{d.serialNumber}</code></td>
                  <td>{d.manufacturer} {d.model}</td>
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
                  <td>{d.assignedUser || '—'}</td>
                  <td>{d.enrollmentState || '—'}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
      <p class="ld-section-hint">Ein geänderter GroupTag wirkt, sobald Entra die dynamischen Gruppen neu auswertet —
        das dauert üblicherweise ein paar Minuten.</p>
    </div>
  {/if}
</TenantContext>
