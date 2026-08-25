<script>
  // Administrative Rollen: wer hat erhöhte Rechte, und wie kam er dazu.
  // Rein lesend — hier wird nichts verändert.
  import { apiGet } from '../lib/api.js'
  import { activeTenant } from '../lib/tenantStore.js'
  import { session } from '../lib/session.js'
  import TenantContext from '../lib/TenantContext.svelte'

  let data = $state(null)
  let busy = $state(false)
  let error = $state(null)
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

  // Rollen ohne Mitglieder sind der Normalfall und verstopfen die Ansicht.
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

  {#if busy && !data}
    <p class="ld-section-hint"><span class="ld-spinner"></span> Lese Verzeichnisrollen…</p>
  {/if}
  {#if error}
    <div class="alert alert-warning">❌ {error}
      <br /><small>Braucht RoleManagement.Read.Directory bzw. Directory.Read.All — im Bereich „Tenants" einmal Reparieren ausführen.</small>
    </div>
  {/if}

  {#if data}
    <div class="ar-summary">
      <div class="rep-metric"><div class="rep-metric-value">{data.totals.activeGlobalAdmins}</div>
        <div class="rep-metric-label">aktive Globale Administratoren</div></div>
      <div class="rep-metric"><div class="rep-metric-value">{data.totals.distinctAccounts}</div>
        <div class="rep-metric-label">Konten mit einer Rolle</div></div>
      <div class="rep-metric"><div class="rep-metric-value">{data.totals.rolesInUse}</div>
        <div class="rep-metric-label">besetzte Rollen</div></div>
    </div>

    {#if data.findings.length}
      <div style="margin-top:0.9rem">
        {#each data.findings as f}
          <div class="ld-banner {f.state === 'crit' ? 'fail' : 'warn'}">{f.state === 'crit' ? '❌' : '⚠️'} {f.text}</div>
        {/each}
      </div>
    {:else}
      <div class="ld-banner ok" style="margin-top:0.9rem">✅ Keine Auffälligkeiten bei den privilegierten Rollen.</div>
    {/if}

    <!-- Globale Administratoren zuerst und ausführlich: das ist die Rolle, die zählt -->
    <div class="settings-group" style="margin-top:1.25rem">
      <h4>Globale Administratoren ({data.globalAdmins.length})</h4>
      {#if data.globalAdmins.length === 0}
        <p class="ld-section-hint">Keine Mitglieder in dieser Rolle.</p>
      {:else}
        {#each data.globalAdmins as g (g.id)}
          <div class="ar-admin" class:ar-flag={g.synced || g.guest || !g.accountEnabled}>
            <div class="ar-admin-head">
              <strong>{g.displayName || g.upn || g.id}</strong>
              {#if g.type === 'servicePrincipal'}<span class="tbadge warn">Dienstprinzipal</span>{/if}
              {#if g.guest}<span class="tbadge warn">Gast</span>{/if}
              {#if g.synced}<span class="tbadge warn">aus lokalem AD</span>{/if}
              {#if !g.accountEnabled}<span class="tbadge">deaktiviert</span>{/if}
            </div>
            {#if g.upn}<div class="ar-upn">{g.upn}</div>{/if}

            {#if g.otherRoles.length}
              <div class="ar-line"><span class="ar-key">Weitere Rollen</span> {g.otherRoles.join(', ')}</div>
            {/if}

            <div class="ar-line">
              <span class="ar-key">Gruppen</span>
              {#if g.groupsError}
                <em>nicht lesbar ({g.groupsError})</em>
              {:else if g.groups.length === 0}
                <em>keine</em>
              {:else}
                <span class="ar-groups">
                  {#each g.groups as gr}
                    <span class="gt-tag" title={gr.dynamic ? 'dynamische Gruppe' : 'zugewiesene Gruppe'}>
                      {gr.displayName}{gr.dynamic ? ' ⟳' : ''}
                    </span>
                  {/each}
                </span>
              {/if}
            </div>
          </div>
        {/each}
        <p class="ld-section-hint">⟳ = dynamische Gruppe. Mitgliedschaften darin ändern sich automatisch — ein Konto
          kann so Rechte bekommen, ohne dass jemand es zuweist.</p>
      {/if}
    </div>

    <div class="settings-group" style="margin-top:1.25rem">
      <h4>Alle besetzten Rollen ({rolesShown.length})</h4>
      <div class="gt-table-wrap">
        <table class="gt-table">
          <thead><tr><th>Rolle</th><th>Mitglieder</th><th>Konten</th></tr></thead>
          <tbody>
            {#each rolesShown as r (r.id)}
              <tr class:ar-priv={!!r.privilege}>
                <td>
                  <strong>{r.displayName}</strong>
                  {#if r.privilege}<span class="tbadge warn" title="privilegierte Rolle">privilegiert</span>{/if}
                  {#if r.error}<br /><small>nicht lesbar: {r.error}</small>{/if}
                </td>
                <td>{r.members.length}</td>
                <td>
                  {#if r.members.length}
                    {r.members.map(m => (m.displayName || m.upn || m.id) + (m.accountEnabled ? '' : ' (deaktiviert)')).join(', ')}
                  {:else}
                    <em>—</em>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if emptyCount}
        <button class="linklike" style="margin-top:0.5rem" onclick={() => (showEmpty = !showEmpty)}>
          {showEmpty ? '▾ Unbesetzte Rollen ausblenden' : `▸ ${emptyCount} unbesetzte Rollen einblenden`}
        </button>
      {/if}
      <p class="ld-section-hint">Microsoft Graph liefert nur aktivierte Verzeichnisrollen. Eine Rolle, die hier fehlt,
        wurde im Tenant noch nie vergeben.</p>
    </div>
  {/if}
</TenantContext>
