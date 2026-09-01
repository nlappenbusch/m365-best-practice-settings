<script>
  // Erzwungene Browser-Erweiterungen (Edge).
  //
  // Das war die letzte Handarbeit im Passwortmanager-Rollout: Desktop-App und
  // Server-Region kann das Werkzeug, die Erweiterung selbst musste jemand im
  // Portal erzwingen. Jetzt als Custom-Konfigurationsprofil (OMA-URI auf die
  // Edge-Richtlinie ExtensionInstallForcelist).
  //
  // Zuweisung geht an die GERÄTEGRUPPE. Intune löst verschachtelte Gruppen nur
  // beim App-Assignment auf — ein Konfigurationsprofil auf einer App-Zielgruppe
  // erreicht kein einziges Gerät.
  import { apiGet, apiPost } from '../lib/api.js'
  import { activeTenant } from '../lib/tenantStore.js'
  import { session } from '../lib/session.js'
  import { activeTab } from '../lib/tabStore.js'
  import { loadNaming } from '../lib/naming.js'
  import TenantContext from '../lib/TenantContext.svelte'

  let catalog = $state([])
  let edgeStore = $state('https://edge.microsoft.com/extensionwebstorebase/v1/crx')
  let groups = $state([])
  let profiles = $state(null)
  let naming = $state(null)

  let busy = $state(false)
  let error = $state(null)
  let notice = $state(null)

  let profileName = $state('Standard')
  let picked = $state({})        // catalog key -> bool
  let customId = $state('')
  let customUrl = $state('')
  let extras = $state([])        // frei ergänzte Erweiterungen
  let selGroups = $state({})     // groupId -> bool

  const canQuery = $derived(!!$activeTenant)
  const selectedGroupIds = $derived(Object.keys(selGroups).filter(g => selGroups[g]))
  const chosen = $derived([
    ...catalog.filter(c => picked[c.key]).map(c => ({ extensionId: c.extensionId, updateUrl: c.updateUrl, label: c.label })),
    ...extras
  ])
  const targetName = $derived(naming ? naming.name('browserExtEdge', { name: profileName }) : '')

  // Erst laden, wenn dieser Bereich auch offen ist: Alle Tabs bleiben gemountet,
  // und die Profilliste zieht sämtliche Konfigurationsprofile des Tenants über
  // Graph — das bei jedem Tenantwechsel im Hintergrund zu tun, waere unnötige
  // Last auf dem Kundentenant.
  let loadedFor = null
  $effect(() => {
    const t = $activeTenant
    if ($activeTab !== 'browserext') return
    if (!$session.loggedIn || !t) return
    if (loadedFor === t.id) return
    loadedFor = t.id
    profiles = null
    selGroups = {}
    load()
  })

  async function load() {
    busy = true; error = null; notice = null
    try {
      const [cat, grp, prof, nm] = await Promise.all([
        apiGet('/api/browserext/catalog'),
        apiGet(`/api/tenants/${encodeURIComponent($activeTenant.id)}/groups`),
        apiGet(`/api/tenants/${encodeURIComponent($activeTenant.id)}/browserext/edge`),
        loadNaming($activeTenant.id)
      ])
      // Defensiv, aus demselben Grund wie im Namenskonvention-Tab: Diese
      // Komponente ist immer gemountet.
      catalog = Array.isArray(cat?.catalog) ? cat.catalog : []
      edgeStore = cat?.edgeStore || edgeStore
      groups = Array.isArray(grp?.groups) ? grp.groups : []
      profiles = Array.isArray(prof?.profiles) ? prof.profiles : []
      naming = nm
      // Bitwarden ist der Regelfall — vorausgewählt, abwählbar.
      if (!Object.keys(picked).length && catalog.some(c => c.key === 'bitwarden')) picked = { bitwarden: true }
    } catch (e) {
      error = e.message
    }
    busy = false
  }

  function addCustom() {
    const id = customId.trim().toLowerCase()
    if (!/^[a-p]{32}$/.test(id)) { error = 'Erweiterungs-Id muss aus 32 Buchstaben a–p bestehen.'; return }
    const url = customUrl.trim() || edgeStore
    if (extras.some(e => e.extensionId === id) || catalog.some(c => c.extensionId === id && picked[c.key])) {
      error = 'Diese Erweiterung steht schon in der Liste.'; return
    }
    extras = [...extras, { extensionId: id, updateUrl: url, label: id }]
    customId = ''; customUrl = ''; error = null
  }

  function removeExtra(id) {
    extras = extras.filter(e => e.extensionId !== id)
  }

  async function deploy() {
    if (!chosen.length) { error = 'Keine Erweiterung gewählt.'; return }
    const gnames = groups.filter(g => selectedGroupIds.includes(g.id)).map(g => g.displayName)
    const what = `Profil „${targetName || profileName}" mit ${chosen.length} Erweiterung(en) anlegen bzw. aktualisieren`
      + (gnames.length ? ` und ${gnames.join(', ')} zuweisen?` : ' und OHNE Zuweisung anlegen?')
    if (!confirm(`${what}\n\nDas schreibt in den Tenant ${$activeTenant?.name}. Die Erweiterungen werden auf den Geräten still installiert und lassen sich vom Benutzer nicht entfernen.`)) return

    busy = true; error = null; notice = null
    try {
      const r = await apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/browserext/edge`, {
        profileName,
        extensions: chosen.map(c => ({ extensionId: c.extensionId, updateUrl: c.updateUrl })),
        groupIds: selectedGroupIds
      })
      notice = `„${r.displayName}" ${r.updated ? 'aktualisiert' : 'angelegt'}`
        + (r.assignedGroups ? `, ${r.assignedGroups} Gruppe(n) zugewiesen` : ' (ohne Zuweisung)')
        + '. Auf den Geräten greift es beim nächsten Richtlinien-Abgleich.'
      profiles = (await apiGet(`/api/tenants/${encodeURIComponent($activeTenant.id)}/browserext/edge`)).profiles || []
    } catch (e) {
      error = e.message
    }
    busy = false
  }
</script>

<TenantContext>
  <div class="settings-group">
    <h4>Erzwungene Browser-Erweiterungen <small>(Microsoft Edge)</small></h4>
    <p class="ld-section-hint" style="margin-top:0">
      Legt ein Konfigurationsprofil an, das die gewählten Erweiterungen still installiert — der Benutzer
      kann sie nicht entfernen. Umgesetzt als OMA-URI auf die Edge-Richtlinie
      <code>ExtensionInstallForcelist</code>; im Portal erscheint es als normales Custom-Profil.
    </p>
    <p class="ld-section-hint">
      <strong>Zuweisung gehört an die Gerätegruppe</strong>, nicht an eine App-Zielgruppe: Intune löst
      verschachtelte Gruppen nur beim App-Assignment auf, bei Konfigurationsprofilen nicht.
      <br />Chrome und Firefox brauchen stattdessen eine ADMX-Ingestion — das ist ein anderer Mechanismus
      und hier bewusst nicht mit drin.
    </p>

    {#if error}<div class="alert alert-warning">❌ {error}</div>{/if}
    {#if notice}<div class="ld-banner ok">{notice}</div>{/if}
    {#if busy && !profiles}<p class="ld-section-hint"><span class="ld-spinner"></span> Lade…</p>{/if}

    {#if profiles}
      {#if profiles.length}
        <h5 class="be-sub">Vorhandene Profile ({profiles.length})</h5>
        <div class="tbl-wrap">
          <table class="tbl">
            <thead><tr><th>Profil</th><th>Objekt in Intune</th></tr></thead>
            <tbody>
              {#each profiles as p (p.id)}
                <tr><td>{p.profileName}</td><td><code>{p.displayName}</code></td></tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else}
        <p class="ld-section-hint">Noch kein Profil in diesem Tenant.</p>
      {/if}

      <h5 class="be-sub">Neues Profil</h5>
      <div class="be-form">
        <div class="input-group" style="max-width:240px; margin:0">
          <label for="be-name">Profilname</label>
          <input id="be-name" type="text" bind:value={profileName} placeholder="Standard" />
        </div>
      </div>
      {#if targetName}
        <p class="ld-section-hint" style="margin-top:0.4rem">
          Heisst in Intune: <code>{targetName}</code> — nach der eingestellten Namenskonvention.
        </p>
      {/if}

      <h5 class="be-sub">Erweiterungen</h5>
      <div class="be-list">
        {#each catalog as c (c.key)}
          <label class="be-item">
            <input type="checkbox" bind:checked={picked[c.key]} />
            <span>
              <strong>{c.label}</strong>
              <br /><code>{c.extensionId}</code>
              {#if c.note}<br /><small>{c.note}</small>{/if}
            </span>
          </label>
        {/each}
        {#each extras as e (e.extensionId)}
          <label class="be-item">
            <input type="checkbox" checked disabled />
            <span>
              <strong>Eigene Erweiterung</strong>
              <br /><code>{e.extensionId}</code>
              <br /><small>{e.updateUrl}</small>
            </span>
            <button class="ag-link" onclick={() => removeExtra(e.extensionId)}>entfernen</button>
          </label>
        {/each}
      </div>

      <div class="be-form" style="margin-top:0.6rem">
        <div class="input-group" style="max-width:330px; margin:0">
          <label for="be-id">Weitere Erweiterung (Id aus edge://extensions)</label>
          <input id="be-id" type="text" bind:value={customId} placeholder="32 Buchstaben a–p" />
        </div>
        <div class="input-group" style="max-width:330px; margin:0">
          <label for="be-url">Update-URL <small>(leer = Edge-Add-ons)</small></label>
          <input id="be-url" type="text" bind:value={customUrl} placeholder={edgeStore} />
        </div>
        <button class="btn btn-secondary" onclick={addCustom}>Hinzufügen</button>
      </div>

      <h5 class="be-sub">Gerätegruppen</h5>
      {#if groups.length}
        <div class="be-list">
          {#each groups as g (g.id)}
            <label class="be-item">
              <input type="checkbox" bind:checked={selGroups[g.id]} />
              <span>{g.displayName}</span>
            </label>
          {/each}
        </div>
      {:else}
        <p class="ld-section-hint">Keine Gruppen gefunden.</p>
      {/if}

      <button class="btn btn-primary" style="margin-top:0.9rem"
              disabled={busy || !chosen.length} onclick={deploy}>
        {busy ? 'Rolle aus…' : '🧩 Profil anlegen und zuweisen'}
      </button>
      <p class="ld-section-hint" style="margin-top:0.6rem">
        Die Server-Region der Bitwarden-Erweiterung ist ein getrenntes Objekt — die setzt die
        Registry-Richtlinie im Bereich Mappings bzw. der Bereitstellen-Dialog der Desktop-App.
      </p>
    {/if}
  </div>
</TenantContext>

<style>
  .be-sub { margin: 1.4rem 0 0.5rem; font-size: 0.95rem; }
  .be-form { display: flex; gap: 0.6rem; flex-wrap: wrap; align-items: flex-end; }
  .be-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 0.45rem; }
  .be-item {
    display: flex; align-items: flex-start; gap: 0.5rem; font-size: 0.88rem; cursor: pointer;
    border: 1px solid var(--border, rgba(127,127,127,.25)); border-radius: 8px; padding: 0.5rem 0.65rem;
  }
  .be-item code { font-size: 0.76rem; opacity: .8; }
  .be-item small { opacity: .7; }
  .ag-link {
    background: none; border: 0; cursor: pointer; padding: 0; font: inherit;
    font-size: 0.78rem; text-decoration: underline; color: inherit; opacity: .8;
    margin-left: auto; white-space: nowrap;
  }
  .ag-link:hover { opacity: 1; }
</style>
