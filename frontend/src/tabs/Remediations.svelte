<script>
  // Remediations — Erkennen und Beheben (Intune > Geräte > Skripts und Wartung).
  //
  // Der Unterschied zum Plattformskript (Tab Mappings, Registry-Richtlinie):
  // Ein Plattformskript läuft einmal. Setzt ein Windows-Update den Zustand
  // zurück, merkt das niemand. Eine Wartung prüft wiederkehrend und repariert
  // erneut — genau dafür ist der Katalog hier da.
  //
  // Zuweisung geht an die dynamische GERÄTEGRUPPE. Intune löst verschachtelte
  // Gruppen nur beim App-Assignment auf; eine Wartung auf einer App-Zielgruppe
  // erreicht kein einziges Gerät.
  import { apiGet, apiPost } from '../lib/api.js'
  import { activeTenant } from '../lib/tenantStore.js'
  import { session } from '../lib/session.js'
  import { activeTab } from '../lib/tabStore.js'
  import TenantContext from '../lib/TenantContext.svelte'

  let katalog = $state([])
  let scripts = $state(null)
  let groups = $state([])
  let deviceGroupIds = $state([])

  let selKey = $state('')
  let selGroups = $state({})
  let taeglich = $state(true)
  let skripte = $state(null)      // { key, detection, remediation }
  let skripteFuer = $state('')

  let busy = $state(false)
  let loading = $state(false)
  let error = $state(null)
  let notice = $state(null)

  const selected = $derived(Object.keys(selGroups).filter(g => selGroups[g]))
  const devGroups = $derived(groups.filter(g => deviceGroupIds.includes(g.id)))
  const vorlage = $derived(katalog.find(k => k.key === selKey) || null)

  let loadedFor = null
  $effect(() => {
    const t = $activeTenant
    if ($activeTab !== 'remediations') return
    if (!$session.loggedIn || !t) return
    if (loadedFor === t.id) return
    loadedFor = t.id
    scripts = null
    selGroups = {}
    load()
  })

  async function load() {
    loading = true; error = null; notice = null
    try {
      const id = encodeURIComponent($activeTenant.id)
      const [kat, list, grp, dyn] = await Promise.all([
        apiGet('/api/remediations/katalog'),
        apiGet(`/api/tenants/${id}/remediations`),
        apiGet(`/api/tenants/${id}/groups`).catch(() => ({ groups: [] })),
        apiPost('/api/grouptags/groups', { tenantId: $activeTenant.id }).catch(() => ({ groups: [] }))
      ])
      katalog = Array.isArray(kat?.katalog) ? kat.katalog : []
      scripts = Array.isArray(list?.scripts) ? list.scripts : []
      groups = Array.isArray(grp?.groups) ? grp.groups : []
      deviceGroupIds = (Array.isArray(dyn?.groups) ? dyn.groups : []).filter(x => (x.tags || []).length).map(x => x.id)
      if (!selKey && katalog.length) selKey = katalog[0].key
    } catch (e) {
      error = e.message
    }
    loading = false
  }

  async function zeigeSkripte(key) {
    if (skripteFuer === key) { skripte = null; skripteFuer = ''; return }
    try {
      skripte = await apiGet(`/api/remediations/katalog/${encodeURIComponent(key)}`)
      skripteFuer = key
    } catch (e) { error = e.message }
  }

  async function deploy() {
    if (!vorlage) return
    if (!selected.length) { error = 'Mindestens eine Gerätegruppe wählen — eine Wartung ohne Zuweisung läuft nirgends.'; return }
    const namen = groups.filter(g => selected.includes(g.id)).map(g => g.displayName)
    if (!confirm(`Wartung „${vorlage.label}" im Tenant ${$activeTenant.name} anlegen bzw. aktualisieren?\n\n`
      + `Zuweisung: ${namen.join(', ')}\n`
      + `Zeitplan: ${taeglich ? 'täglich um 03:00 Uhr lokal' : 'nur einmalig (kein Zeitplan)'}\n\n`
      + 'Voraussetzung im Tenant: Intune > Mandantenadministration > Connectors und Token > Windows-Daten — '
      + 'der Lizenz-Schalter muss auf Ein stehen. Sonst wird die Wartung angelegt, läuft aber nie.')) return

    busy = true; error = null; notice = null
    try {
      const r = await apiPost(`/api/tenants/${encodeURIComponent($activeTenant.id)}/remediations`, {
        key: vorlage.key, groupIds: selected, taeglich
      })
      notice = `✅ „${r.displayName}" ${r.aktualisiert ? 'aktualisiert' : 'angelegt'} und ${r.gruppen} Gruppe(n) zugewiesen.`
      await load()
    } catch (e) {
      error = e.message
    }
    busy = false
  }
</script>

<TenantContext>
  <div class="ld-wrap">
    <p class="ld-section-hint">
      Ein Paar aus Erkennungs- und Behebungsskript, das wiederkehrend läuft: Meldet die Erkennung „muss repariert
      werden", startet Intune die Behebung. Für Zustände, die ein Windows-Update zurücksetzen kann — dort wäre ein
      einmaliges Plattformskript die falsche Wahl.
    </p>

    <div class="ld-banner warn">
      <div>
        <b>Voraussetzung, die es nicht per API gibt</b>
        <div>
          Intune → Mandantenadministration → Connectors und Token → <b>Windows-Daten</b>: Der Schalter
          „Ich bestätige, dass mein Mandant eine dieser Lizenzen besitzt" muss auf <b>Ein</b> stehen (Vorgabe: Aus).
          Ohne ihn lässt sich die Wartung anlegen, sie läuft aber nie. Einmal pro Tenant, gehört in die Onboarding-Checkliste.
        </div>
      </div>
    </div>

    {#if error}<div class="alert alert-warning">❌ {error}</div>{/if}
    {#if notice}<div class="ld-banner ok"><div><b>{notice}</b></div></div>{/if}
    {#if loading}<p class="ld-section-hint"><span class="ld-spinner"></span> Lade…</p>{/if}

    {#if scripts}
      {#if scripts.length}
        <section class="hd-card">
          <div class="hd-head"><h4>Vorhandene Wartungen</h4></div>
          <table class="hd-table">
            <thead><tr><th>Name</th><th>Ausführung</th><th>Zuweisung</th></tr></thead>
            <tbody>
              {#each scripts as s (s.id)}
                <tr>
                  <td>
                    <b>{s.displayName}</b>
                    {#if s.unsere}<span class="hd-tag">vom Tool</span>{/if}
                    {#if s.description}<div class="hd-why">{s.description}</div>{/if}
                  </td>
                  <td>{s.runAsAccount === 'system' ? 'SYSTEM' : (s.runAsAccount || '—')}{s.runAs32Bit ? ' · 32-Bit' : ''}</td>
                  <td>{s.zuweisungen.length ? `${s.zuweisungen.length} Gruppe(n)` : 'keine'}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </section>
      {/if}

      <section class="hd-card">
        <div class="hd-head"><h4>Aus dem Katalog ausrollen</h4></div>

        <div class="rm-katalog">
          {#each katalog as k (k.key)}
            <label class="rm-item" class:sel={selKey === k.key}>
              <input type="radio" name="rm-vorlage" value={k.key} bind:group={selKey} />
              <span class="rm-body">
                <strong>{k.label}</strong>
                <small>{k.beschreibung}</small>
                <em>{k.warum}</em>
                <button class="hd-link" onclick={(e) => { e.preventDefault(); zeigeSkripte(k.key) }}>
                  {skripteFuer === k.key ? 'Skripte ausblenden' : `Skripte ansehen (${k.zeilenDetection} + ${k.zeilenRemediation} Zeilen)`}
                </button>
              </span>
            </label>
            {#if skripteFuer === k.key && skripte}
              <div class="rm-code">
                <div class="rm-code-label">Erkennung — Exit 1 heisst „reparieren“</div>
                <pre>{skripte.detection}</pre>
                <div class="rm-code-label">Behebung</div>
                <pre>{skripte.remediation}</pre>
              </div>
            {/if}
          {/each}
        </div>

        <div class="hd-label" style="margin-top:1rem">Gerätegruppen</div>
        {#if devGroups.length}
          <div class="hd-glist">
            {#each devGroups as g (g.id)}
              <label class="hd-g" class:sel={selGroups[g.id]}>
                <input type="checkbox" bind:checked={selGroups[g.id]} />
                <span>{g.displayName}</span>
              </label>
            {/each}
          </div>
        {:else}
          <p class="ld-section-hint">
            Keine dynamische Gerätegruppe gefunden — im Tab <strong>GroupTags</strong> zuerst eine anlegen.
          </p>
        {/if}

        <label class="rm-check">
          <input type="checkbox" bind:checked={taeglich} />
          <span>Täglich um 03:00 Uhr prüfen <small>— ohne Zeitplan läuft die Wartung nur einmal, und ein Rückfall nach einem Update bleibt unbemerkt.</small></span>
        </label>

        <div class="hd-actions">
          <button class="btn btn-primary" disabled={busy || !vorlage || !selected.length} onclick={deploy}>
            {busy ? '…' : 'Ausrollen'}
          </button>
          <span class="hd-why">
            {selected.length ? `${selected.length} Gruppe(n) gewählt` : 'Noch keine Gruppe gewählt'}
          </span>
        </div>
      </section>
    {/if}
  </div>
</TenantContext>
