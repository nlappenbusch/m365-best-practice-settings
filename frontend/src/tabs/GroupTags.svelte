<script>
  // GroupTag-Verwaltung: dynamische Gruppen anlegen, Autopilot-Geräte sehen und
  // ihnen Tags zuordnen.
  //
  // Funktioniert für zwei Fälle: den aktiven onboardeten Tenant (Zertifikat)
  // und einen fremden Tenant per Client-ID/Secret — etwa den Zieltenant einer
  // Migration, in dem die Gruppen erst noch entstehen müssen.
  import { apiPost } from '../lib/api.js'
  import { activeTenant } from '../lib/tenantStore.js'
  import { session } from '../lib/session.js'

  let mode = $state('active')     // 'active' = onboardeter Tenant | 'foreign' = per Secret
  let foreign = $state({ tenantName: '', clientId: '', clientSecret: '' })

  let groups = $state(null)
  let devices = $state(null)
  let busy = $state(false)
  let error = $state(null)
  let notice = $state(null)

  // Für den fremden Tenant müssen die Zugangsdaten bei jedem Aufruf mit —
  // serverseitig wird dafür nichts zwischengespeichert. Beim aktiven Tenant
  // geht die Id mit: diese Endpunkte liegen nicht unter /api/tenants/:id.
  function creds() {
    if (mode !== 'foreign') return { tenantId: $activeTenant ? $activeTenant.id : '' }
    return { tenantName: foreign.tenantName.trim(), clientId: foreign.clientId.trim(), clientSecret: foreign.clientSecret }
  }

  const canQuery = $derived(
    mode === 'active'
      ? !!$activeTenant
      : !!(foreign.tenantName.trim() && foreign.clientId.trim() && foreign.clientSecret.trim())
  )

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
    if (!confirm(`Dynamische Sicherheitsgruppe für GroupTag "${t}" anlegen?\n\nDas schreibt in den Tenant ${mode === 'active' ? $activeTenant?.name : foreign.tenantName}.`)) return
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

{#if !$session.loggedIn}
  <div class="alert alert-warning"><strong>🔒 Nicht angemeldet.</strong> Oben rechts anmelden.</div>
{:else}
  <div class="settings-group">
    <h4>Tenant</h4>
    <div style="display:flex; gap:1rem; flex-wrap:wrap; align-items:center">
      <label><input type="radio" bind:group={mode} value="active" /> Aktiver Tenant{$activeTenant ? ` (${$activeTenant.name})` : ''}</label>
      <label><input type="radio" bind:group={mode} value="foreign" /> Anderer Tenant per Client-ID/Secret</label>
    </div>
    {#if mode === 'foreign'}
      <p class="ld-section-hint">Für Tenants, die hier nicht onboardet sind — etwa das Ziel einer Migration. Die
        Zugangsdaten der App-Registrierung <code>IG-TenantMigration-Target</code> passen hier hinein.</p>
      <div class="settings-grid">
        <div class="input-group">
          <label for="gt-tenant">Tenant (Domain oder ID)</label>
          <input id="gt-tenant" type="text" bind:value={foreign.tenantName} placeholder="neu.onmicrosoft.com" />
        </div>
        <div class="input-group">
          <label for="gt-client">Client-ID</label>
          <input id="gt-client" type="text" bind:value={foreign.clientId} />
        </div>
        <div class="input-group">
          <label for="gt-secret">Client Secret</label>
          <input id="gt-secret" type="password" bind:value={foreign.clientSecret} autocomplete="off" />
        </div>
      </div>
    {/if}
    <button class="btn btn-primary" style="margin-top:0.6rem" onclick={loadAll} disabled={!canQuery || busy}>
      {busy ? 'Lade…' : '🔎 Gruppen und Geräte laden'}
    </button>
  </div>

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
        {#each groups as g (g.id)}
          <div class="wizard-step">
            <div class="wizard-step-body">
              <div class="wizard-step-title">{g.displayName} {#if g.state !== 'On'}<span class="tbadge warn">Regel {g.state || 'aus'}</span>{/if}</div>
              <div class="wizard-step-desc">
                {#if g.tags.length}Tags: <strong>{g.tags.join(', ')}</strong>{:else}<em>kein [OrderID]-Tag in der Regel</em>{/if}
                <br /><code style="font-size:0.72rem">{g.rule.slice(0, 160)}{g.rule.length > 160 ? '…' : ''}</code>
              </div>
            </div>
          </div>
        {/each}
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
                    {#if d.groupTag}
                      <strong>{d.groupTag}</strong>
                      {#if orphanTags.includes(d.groupTag)}<span class="tbadge warn" title="Keine Gruppe wertet diesen Tag aus">ohne Gruppe</span>{/if}
                    {:else}
                      <em>—</em>
                    {/if}
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
{/if}
