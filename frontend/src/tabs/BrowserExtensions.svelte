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
  // erreicht kein einziges Gerät. Deshalb sortiert die Auswahl unten die
  // dynamischen Gerätegruppen nach oben und warnt bei App-Zielgruppen.
  import { apiGet, apiPost } from '../lib/api.js'
  import { activeTenant } from '../lib/tenantStore.js'
  import { session } from '../lib/session.js'
  import { activeTab } from '../lib/tabStore.js'
  import { loadNaming } from '../lib/naming.js'
  import TenantContext from '../lib/TenantContext.svelte'

  let catalog = $state([])
  let edgeStore = $state('https://edge.microsoft.com/extensionwebstorebase/v1/crx')
  let groups = $state([])
  let deviceGroupIds = $state([])   // Gruppen mit [OrderID]-Tag
  let profiles = $state(null)
  let naming = $state(null)

  let busy = $state(false)
  let error = $state(null)
  let notice = $state(null)

  let profileName = $state('Standard')
  let picked = $state({})
  let customId = $state('')
  let customUrl = $state('')
  let extras = $state([])
  let selGroups = $state({})
  let groupFilter = $state('')
  let showOther = $state(false)

  const selectedGroupIds = $derived(Object.keys(selGroups).filter(g => selGroups[g]))
  const chosen = $derived([
    ...catalog.filter(c => picked[c.key]).map(c => ({ extensionId: c.extensionId, updateUrl: c.updateUrl, label: c.label })),
    ...extras
  ])
  const targetName = $derived(naming ? naming.name('browserExtEdge', { name: profileName }) : '')

  // Eine App-Zielgruppe hier zu wählen ist der eine Fehler, der garantiert dazu
  // führt, dass das Profil kein Gerät erreicht — deshalb sichtbar machen.
  const APP_GROUP = /^(AAD-APP-|AAD-PMP-|T2-DG-WIN-(App|Pmp))/i
  function isAppGroup(name) { return APP_GROUP.test(String(name || '')) }
  function isDeviceGroup(g) { return deviceGroupIds.includes(g.id) }

  const filtered = $derived(
    groups.filter(g => {
      const q = groupFilter.trim().toLowerCase()
      return !q || String(g.displayName || '').toLowerCase().includes(q)
    })
  )
  const devGroups = $derived(filtered.filter(isDeviceGroup))
  const otherGroups = $derived(filtered.filter(g => !isDeviceGroup(g)))
  const selectedNames = $derived(groups.filter(g => selectedGroupIds.includes(g.id)).map(g => g.displayName))
  const wrongPick = $derived(selectedNames.filter(isAppGroup))

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
      const [cat, grp, prof, nm, dyn] = await Promise.all([
        apiGet('/api/browserext/catalog'),
        apiGet(`/api/tenants/${encodeURIComponent($activeTenant.id)}/groups`),
        apiGet(`/api/tenants/${encodeURIComponent($activeTenant.id)}/browserext/edge`),
        loadNaming($activeTenant.id),
        // Liefert die dynamischen Gruppen samt GroupTags — daraus wissen wir,
        // welche der vielen Gruppen überhaupt Gerätegruppen sind.
        apiPost('/api/grouptags/groups', { tenantId: $activeTenant.id }).catch(() => ({ groups: [] }))
      ])
      catalog = Array.isArray(cat?.catalog) ? cat.catalog : []
      edgeStore = cat?.edgeStore || edgeStore
      groups = Array.isArray(grp?.groups) ? grp.groups : []
      profiles = Array.isArray(prof?.profiles) ? prof.profiles : []
      naming = nm
      deviceGroupIds = (Array.isArray(dyn?.groups) ? dyn.groups : [])
        .filter(g => (g.tags || []).length).map(g => g.id)
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

  function removeExtra(id) { extras = extras.filter(e => e.extensionId !== id) }
  function toggleGroup(id) { selGroups = { ...selGroups, [id]: !selGroups[id] } }

  async function deploy() {
    if (!chosen.length) { error = 'Keine Erweiterung gewählt.'; return }
    const what = `Profil „${targetName || profileName}" mit ${chosen.length} Erweiterung(en) anlegen bzw. aktualisieren`
      + (selectedNames.length ? ` und ${selectedNames.join(', ')} zuweisen?` : ' und OHNE Zuweisung anlegen?')
    const warn = wrongPick.length
      ? `\n\nACHTUNG: ${wrongPick.join(', ')} ${wrongPick.length === 1 ? 'ist eine App-Zielgruppe' : 'sind App-Zielgruppen'} — `
        + 'Konfigurationsprofile lösen deren Nesting nicht auf, das Profil erreicht darüber kein Gerät.'
      : ''
    if (!confirm(`${what}${warn}\n\nDas schreibt in den Tenant ${$activeTenant?.name}. Die Erweiterungen werden auf den Geräten still installiert und lassen sich vom Benutzer nicht entfernen.`)) return

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
      const p = await apiGet(`/api/tenants/${encodeURIComponent($activeTenant.id)}/browserext/edge`)
      profiles = Array.isArray(p?.profiles) ? p.profiles : []
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
      kann sie nicht entfernen. Umgesetzt als OMA-URI auf <code>ExtensionInstallForcelist</code>.
      Chrome und Firefox bräuchten eine ADMX-Ingestion und sind hier nicht dabei.
    </p>

    {#if error}<div class="alert alert-warning">❌ {error}</div>{/if}
    {#if notice}<div class="ld-banner ok">{notice}</div>{/if}
    {#if busy && !profiles}<p class="ld-section-hint"><span class="ld-spinner"></span> Lade…</p>{/if}

    {#if profiles}
      {#if profiles.length}
        <div class="bx-existing">
          <span class="bx-existing-label">Vorhanden</span>
          {#each profiles as p (p.id)}
            <span class="bx-chip"><strong>{p.profileName}</strong><code>{p.displayName}</code></span>
          {/each}
        </div>
      {/if}

      <section class="bx-step">
        <h5><span class="bx-n">1</span> Erweiterungen wählen</h5>
        <div class="bx-ext-grid">
          {#each catalog as c (c.key)}
            <label class="bx-ext" class:sel={picked[c.key]}>
              <input type="checkbox" bind:checked={picked[c.key]} />
              <span class="bx-ext-body">
                <strong>{c.label}</strong>
                <code>{c.extensionId}</code>
                {#if c.note}<small>{c.note}</small>{/if}
              </span>
            </label>
          {/each}
          {#each extras as e (e.extensionId)}
            <div class="bx-ext sel">
              <span class="bx-ext-body">
                <strong>Eigene Erweiterung</strong>
                <code>{e.extensionId}</code>
                <small>{e.updateUrl}</small>
              </span>
              <button class="bx-x" title="entfernen" onclick={() => removeExtra(e.extensionId)}>✕</button>
            </div>
          {/each}
        </div>
        <details class="bx-more">
          <summary>Weitere Erweiterung von Hand</summary>
          <div class="bx-more-body">
            <div class="input-group" style="max-width:330px; margin:0">
              <label for="be-id">Erweiterungs-Id <small>(aus edge://extensions)</small></label>
              <input id="be-id" type="text" bind:value={customId} placeholder="32 Buchstaben a–p" />
            </div>
            <div class="input-group" style="max-width:330px; margin:0">
              <label for="be-url">Update-URL <small>(leer = Edge-Add-ons)</small></label>
              <input id="be-url" type="text" bind:value={customUrl} placeholder={edgeStore} />
            </div>
            <button class="btn btn-secondary" onclick={addCustom}>Hinzufügen</button>
          </div>
        </details>
      </section>

      <section class="bx-step">
        <h5><span class="bx-n">2</span> Gerätegruppen zuweisen</h5>
        <p class="ld-section-hint" style="margin-top:0">
          Konfigurationsprofile lösen kein Gruppen-Nesting auf — sie gehören direkt an die dynamischen
          Gerätegruppen, nicht an App-Zielgruppen.
        </p>

        {#if selectedGroupIds.length}
          <div class="bx-sel">
            {#each selectedGroupIds as id (id)}
              {@const g = groups.find(x => x.id === id)}
              {#if g}
                <span class="bx-chip bx-chip-sel" class:warn={isAppGroup(g.displayName)}>
                  {g.displayName}
                  <button class="bx-x" title="abwählen" onclick={() => toggleGroup(id)}>✕</button>
                </span>
              {/if}
            {/each}
          </div>
        {/if}

        {#if wrongPick.length}
          <div class="alert alert-warning">
            <strong>{wrongPick.join(', ')}</strong> {wrongPick.length === 1 ? 'ist eine App-Zielgruppe' : 'sind App-Zielgruppen'} —
            darüber erreicht das Profil kein Gerät. Nimm die Gerätegruppe, in der die Geräte tatsächlich Mitglied sind.
          </div>
        {/if}

        <div class="input-group" style="max-width:280px; margin:0 0 0.5rem">
          <label for="bx-filter">Gruppe suchen</label>
          <input id="bx-filter" type="search" bind:value={groupFilter} placeholder="Name…" />
        </div>

        {#if devGroups.length}
          <div class="bx-glabel">Dynamische Gerätegruppen <small>({devGroups.length})</small></div>
          <div class="bx-glist">
            {#each devGroups as g (g.id)}
              <label class="bx-g" class:sel={selGroups[g.id]}>
                <input type="checkbox" bind:checked={selGroups[g.id]} />
                <span>{g.displayName}</span>
              </label>
            {/each}
          </div>
        {:else}
          <p class="ld-section-hint">
            Keine dynamische Gerätegruppe gefunden — im Tab <strong>GroupTags</strong> zuerst eine anlegen,
            sonst hat das Profil kein sinnvolles Ziel.
          </p>
        {/if}

        {#if otherGroups.length}
          <button class="bx-toggle" onclick={() => (showOther = !showOther)}>
            {showOther ? '▾' : '▸'} Weitere Gruppen ({otherGroups.length})
          </button>
          {#if showOther}
            <div class="bx-glist">
              {#each otherGroups as g (g.id)}
                <label class="bx-g" class:sel={selGroups[g.id]} class:warn={isAppGroup(g.displayName)}>
                  <input type="checkbox" bind:checked={selGroups[g.id]} />
                  <span>{g.displayName}</span>
                  {#if isAppGroup(g.displayName)}<small class="bx-warnhint">App-Zielgruppe</small>{/if}
                </label>
              {/each}
            </div>
          {/if}
        {/if}
      </section>

      <section class="bx-step">
        <h5><span class="bx-n">3</span> Anlegen</h5>
        <div class="bx-final">
          <div class="input-group" style="max-width:240px; margin:0">
            <label for="be-name">Profilname</label>
            <input id="be-name" type="text" bind:value={profileName} placeholder="Standard" />
          </div>
          <div class="bx-summary">
            {#if targetName}<div>Heisst in Intune: <code>{targetName}</code></div>{/if}
            <div class="bx-muted">
              {chosen.length} Erweiterung{chosen.length === 1 ? '' : 'en'} ·
              {selectedGroupIds.length ? `${selectedGroupIds.length} Gruppe(n)` : 'ohne Zuweisung'}
            </div>
          </div>
          <button class="btn btn-primary" disabled={busy || !chosen.length} onclick={deploy}>
            {busy ? 'Rolle aus…' : '🧩 Profil anlegen und zuweisen'}
          </button>
        </div>
        <p class="ld-section-hint" style="margin-top:0.6rem">
          Die Server-Region der Bitwarden-Erweiterung ist ein getrenntes Objekt — die setzt die
          Registry-Richtlinie im Bereich <strong>Mappings</strong> bzw. der Bereitstellen-Dialog der Desktop-App.
        </p>
      </section>
    {/if}
  </div>
</TenantContext>

<style>
  .bx-step { margin: 1.4rem 0; padding-top: 1rem; border-top: 1px solid var(--border, rgba(127,127,127,.2)); }
  .bx-step:first-of-type { border-top: 0; }
  .bx-step h5 { display: flex; align-items: center; gap: .5rem; margin: 0 0 .5rem; font-size: .98rem; }
  .bx-n {
    width: 1.5rem; height: 1.5rem; border-radius: 50%; display: inline-flex;
    align-items: center; justify-content: center; font-size: .78rem; font-weight: 700;
    background: var(--surface-2, rgba(127,127,127,.12)); color: var(--accent, #0081ad);
  }

  .bx-existing { display: flex; align-items: center; gap: .4rem; flex-wrap: wrap; margin: .6rem 0; }
  .bx-existing-label { font-size: .72rem; text-transform: uppercase; letter-spacing: .06em; opacity: .55; }
  .bx-chip {
    display: inline-flex; align-items: center; gap: .4rem; font-size: .82rem;
    border: 1px solid var(--border, rgba(127,127,127,.3)); border-radius: 999px; padding: .15rem .7rem;
  }
  .bx-chip code { font-size: .74rem; opacity: .7; }
  .bx-chip-sel { background: var(--surface-2, rgba(127,127,127,.1)); padding-right: .25rem; }
  .bx-chip-sel.warn { border-color: #c0392b; color: #c0392b; }
  .bx-sel { display: flex; gap: .35rem; flex-wrap: wrap; margin-bottom: .6rem; }

  .bx-ext-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: .5rem; }
  .bx-ext {
    display: flex; align-items: flex-start; gap: .55rem; cursor: pointer;
    border: 1px solid var(--border, rgba(127,127,127,.25)); border-radius: 10px; padding: .6rem .7rem;
  }
  .bx-ext.sel { border-color: var(--accent, #0081ad); }
  .bx-ext-body { display: flex; flex-direction: column; gap: .15rem; min-width: 0; }
  .bx-ext-body code { font-size: .74rem; opacity: .75; overflow-wrap: anywhere; }
  .bx-ext-body small { opacity: .65; font-size: .78rem; }

  .bx-more { margin-top: .6rem; }
  .bx-more > summary { cursor: pointer; font-size: .85rem; opacity: .75; }
  .bx-more-body { display: flex; gap: .6rem; flex-wrap: wrap; align-items: flex-end; padding-top: .6rem; }

  .bx-glabel { font-size: .72rem; text-transform: uppercase; letter-spacing: .06em; opacity: .55; margin: .5rem 0 .3rem; }
  .bx-glist { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: .25rem; }
  .bx-g {
    display: flex; align-items: center; gap: .45rem; font-size: .86rem; cursor: pointer;
    padding: .3rem .5rem; border-radius: 7px; border: 1px solid transparent;
  }
  .bx-g:hover { background: var(--surface-2, rgba(127,127,127,.08)); }
  .bx-g.sel { border-color: var(--accent, #0081ad); }
  .bx-g.warn span { opacity: .7; }
  .bx-warnhint { color: #c0392b; font-size: .7rem; margin-left: auto; white-space: nowrap; }
  .bx-toggle {
    background: none; border: 0; cursor: pointer; font: inherit; font-size: .84rem;
    color: inherit; opacity: .7; padding: .5rem 0 .2rem;
  }
  .bx-toggle:hover { opacity: 1; }

  .bx-final { display: flex; gap: .9rem; align-items: flex-end; flex-wrap: wrap; }
  .bx-summary { font-size: .85rem; }
  .bx-muted { opacity: .65; }
  .bx-x {
    background: none; border: 0; cursor: pointer; color: inherit; opacity: .5;
    font-size: .8rem; line-height: 1; padding: .2rem .3rem; border-radius: 999px;
  }
  .bx-x:hover { opacity: 1; color: #c0392b; }
</style>
