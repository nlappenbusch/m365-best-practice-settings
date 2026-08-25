<script>
  // Administrative Rollen — im Vordergrund steht das Handeln: Globale
  // Administratoren setzen und entziehen, Konten löschen. Die vollständige
  // Rollenübersicht ist Beiwerk und deshalb eingeklappt.
  import { apiGet, apiPost } from '../lib/api.js'
  import { activeTenant } from '../lib/tenantStore.js'
  import { session } from '../lib/session.js'
  import TenantContext from '../lib/TenantContext.svelte'

  let data = $state(null)
  let busy = $state(false)
  let error = $state(null)
  let notice = $state(null)
  let showAllRoles = $state(false)
  let showEmpty = $state(false)

  let loadedFor = null
  $effect(() => {
    const t = $activeTenant
    if (!$session.loggedIn || !t || busy) return
    if (loadedFor === t.id) return
    loadedFor = t.id
    data = null
    load()
  })

  async function load() {
    if (!$activeTenant) return
    busy = true
    error = null
    try {
      data = await apiGet(`/api/tenants/${encodeURIComponent($activeTenant.id)}/adminroles`)
    } catch (e) {
      error = e.message
    }
    busy = false
  }

  function tenantPath(suffix) {
    return `/api/tenants/${encodeURIComponent($activeTenant.id)}${suffix}`
  }

  // ---------- Rolle entziehen ----------
  let rowBusy = $state({})

  async function removeGlobalAdmin(admin) {
    if (!confirm(`Globale Administratorrolle von „${admin.displayName || admin.upn}" entziehen?\n\n`
      + `Tenant: ${$activeTenant.name}\n`
      + 'Das Konto bleibt bestehen, verliert aber sofort alle Administratorrechte.')) return
    rowBusy[admin.id] = true
    error = null; notice = null
    try {
      const r = await apiPost(tenantPath('/adminroles/globaladmin/remove'), { userId: admin.id })
      notice = `Rolle entzogen. Verbleibende aktive Globale Administratoren: ${r.remainingActive}.`
      await load()
    } catch (e) {
      error = e.message
    }
    rowBusy[admin.id] = false
  }

  // ---------- Benutzer suchen, Rolle geben, Konto löschen ----------
  let query = $state('')
  let results = $state([])
  let searchBusy = $state(false)
  let searchTimer = null

  function onQueryInput() {
    if (searchTimer) clearTimeout(searchTimer)
    const q = query.trim()
    if (q.length < 2) { results = []; return }
    searchTimer = setTimeout(async () => {
      searchBusy = true
      try {
        const r = await apiGet(tenantPath(`/users/search?q=${encodeURIComponent(q)}`))
        results = r.users || []
      } catch (e) {
        error = e.message
      }
      searchBusy = false
    }, 350)
  }

  const isGlobalAdmin = (id) => !!data && data.globalAdmins.some(g => g.id === id)

  async function makeGlobalAdmin(u) {
    if (!confirm(`„${u.displayName}" (${u.userPrincipalName}) zum Globalen Administrator machen?\n\n`
      + `Tenant: ${$activeTenant.name}\n`
      + 'Das Konto bekommt damit volle Rechte auf den gesamten Tenant.')) return
    rowBusy[u.id] = true
    error = null; notice = null
    try {
      const r = await apiPost(tenantPath('/adminroles/globaladmin/add'), { userId: u.id })
      notice = r.alreadyMember
        ? `„${u.displayName}" war bereits Globaler Administrator.`
        : `„${u.displayName}" ist jetzt Globaler Administrator.`
      await load()
    } catch (e) {
      error = e.message
    }
    rowBusy[u.id] = false
  }

  async function deleteUser(u) {
    // Der UPN muss abgetippt werden — bei einer Aktion, die 30 Tage später
    // endgültig ist, darf ein Fehlklick nicht reichen.
    const typed = prompt(`Konto „${u.displayName}" endgültig löschen?\n\n`
      + `Tenant: ${$activeTenant.name}\n`
      + 'Microsoft behält es 30 Tage im Papierkorb, danach ist es weg.\n\n'
      + `Zum Bestätigen den Anmeldenamen eintippen:\n${u.userPrincipalName}`)
    if (!typed) return
    rowBusy[u.id] = true
    error = null; notice = null
    try {
      const r = await apiPost(tenantPath('/users/delete'), { userId: u.id, confirmUpn: typed })
      notice = `Konto ${r.deleted} gelöscht.`
      results = results.filter(x => x.id !== u.id)
      await load()
    } catch (e) {
      error = e.message
    }
    rowBusy[u.id] = false
  }

  const rolesShown = $derived(
    data ? (showEmpty ? data.roles : data.roles.filter(r => r.members.length > 0)) : []
  )
  const emptyCount = $derived(data ? data.roles.filter(r => !r.members.length).length : 0)
</script>

<TenantContext>
  <div style="display:flex; justify-content:flex-end; margin-bottom:0.5rem">
    <button class="btn btn-secondary" onclick={load} disabled={busy || !$activeTenant}>
      {busy ? 'Lade…' : '↻ Aktualisieren'}
    </button>
  </div>

  {#if busy && !data}<p class="ld-section-hint"><span class="ld-spinner"></span> Lese Verzeichnisrollen…</p>{/if}
  {#if error}
    <div class="alert alert-warning">❌ {error}
      {#if /privile|forbidden|403/i.test(error)}
        <br /><small>Rollen ändern braucht <code>RoleManagement.ReadWrite.Directory</code> — im Bereich „Tenants" einmal
          Reparieren ausführen, danach greift die Berechtigung.</small>
      {/if}
    </div>
  {/if}
  {#if notice}<div class="ld-banner ok">{notice}</div>{/if}

  {#if data}
    <!-- 1. Globale Administratoren: die Liste, um die es geht -->
    <div class="settings-group">
      <h4>Globale Administratoren ({data.globalAdmins.length})</h4>
      {#each data.findings.filter(f => f.state === 'crit') as f}
        <div class="ld-banner fail">{f.text}</div>
      {/each}
      {#each data.findings.filter(f => f.state === 'warn') as f}
        <div class="ld-banner warn">{f.text}</div>
      {/each}

      <div class="gt-table-wrap" style="margin-top:0.6rem">
        <table class="gt-table">
          <thead><tr><th>Konto</th><th>Anmeldename</th><th>Merkmale</th><th></th></tr></thead>
          <tbody>
            {#each data.globalAdmins as g (g.id)}
              <tr>
                <td><strong>{g.displayName || '—'}</strong></td>
                <td><code>{g.upn || '—'}</code></td>
                <td>
                  {#if !g.accountEnabled}<span class="tbadge">deaktiviert</span>{/if}
                  {#if g.synced}<span class="tbadge warn" title="Aus dem lokalen AD synchronisiert">aus AD</span>{/if}
                  {#if g.guest}<span class="tbadge warn">Gast</span>{/if}
                  {#if g.type === 'servicePrincipal'}<span class="tbadge warn">Dienstprinzipal</span>{/if}
                  {#if g.otherRoles.length}<span class="tbadge" title={g.otherRoles.join(', ')}>+{g.otherRoles.length} Rollen</span>{/if}
                  {#if g.groups?.length}<span class="tbadge" title={g.groups.map(x => x.displayName).join(', ')}>{g.groups.length} Gruppen</span>{/if}
                </td>
                <td style="text-align:right; white-space:nowrap">
                  <button class="ca-btn ca-btn-del" disabled={rowBusy[g.id] || g.type !== 'user'}
                          title={g.type !== 'user' ? 'Nur Benutzerkonten können hier geändert werden' : 'Globale Administratorrolle entziehen'}
                          onclick={() => removeGlobalAdmin(g)}>
                    {rowBusy[g.id] ? '…' : 'Rolle entziehen'}
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <p class="ld-section-hint">Der letzte aktive Globale Administrator lässt sich nicht entziehen — ein Tenant ohne
        Globalen Administrator kommt nur über den Microsoft-Support zurück.</p>
    </div>

    <!-- 2. Benutzer suchen: Rolle geben oder Konto löschen -->
    <div class="settings-group" style="margin-top:1.25rem">
      <h4>Benutzer suchen</h4>
      <div class="input-group" style="max-width:26rem">
        <label for="ar-search">Name oder Anmeldename <small>(ab 2 Zeichen)</small></label>
        <input id="ar-search" type="text" bind:value={query} oninput={onQueryInput} placeholder="z. B. Muster" />
      </div>

      {#if searchBusy}<p class="ld-section-hint"><span class="ld-spinner"></span> Suche…</p>{/if}

      {#if results.length}
        <div class="gt-table-wrap" style="margin-top:0.5rem">
          <table class="gt-table">
            <tbody>
              {#each results as u (u.id)}
                <tr>
                  <td><strong>{u.displayName}</strong><br /><code>{u.userPrincipalName}</code></td>
                  <td style="text-align:right; white-space:nowrap">
                    {#if isGlobalAdmin(u.id)}
                      <span class="tbadge">ist Globaler Administrator</span>
                    {:else}
                      <button class="ca-btn" disabled={rowBusy[u.id]} onclick={() => makeGlobalAdmin(u)}
                              title="Globale Administratorrolle zuweisen">zum Globalen Administrator</button>
                    {/if}
                    <button class="ca-btn ca-btn-del" disabled={rowBusy[u.id]} onclick={() => deleteUser(u)}
                            title="Konto löschen">Konto löschen</button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else if query.trim().length >= 2 && !searchBusy}
        <p class="ld-section-hint">Keine Treffer.</p>
      {/if}
    </div>

    <!-- 3. Vollständige Rollenübersicht: eingeklappt, damit sie nicht stört -->
    <div class="settings-group" style="margin-top:1.25rem">
      <button class="linklike" onclick={() => (showAllRoles = !showAllRoles)}>
        {showAllRoles ? '▾' : '▸'} Alle Rollen im Tenant ({data.totals.rolesInUse} besetzt, {data.totals.distinctAccounts} Konten)
      </button>

      {#if showAllRoles}
        <div class="gt-table-wrap" style="margin-top:0.6rem">
          <table class="gt-table">
            <thead><tr><th>Rolle</th><th>Anzahl</th><th>Konten</th></tr></thead>
            <tbody>
              {#each rolesShown as r (r.id)}
                <tr class:ar-priv={!!r.privilege}>
                  <td><strong>{r.displayName}</strong>{#if r.privilege}<br /><small>privilegiert</small>{/if}</td>
                  <td>{r.members.length}</td>
                  <td>{r.members.map(m => (m.displayName || m.upn || m.id) + (m.accountEnabled ? '' : ' (deaktiviert)')).join(', ') || '—'}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        {#if emptyCount}
          <button class="linklike" style="margin-top:0.5rem" onclick={() => (showEmpty = !showEmpty)}>
            {showEmpty ? 'Unbesetzte Rollen ausblenden' : `${emptyCount} unbesetzte Rollen einblenden`}
          </button>
        {/if}
      {/if}
    </div>
  {/if}
</TenantContext>
