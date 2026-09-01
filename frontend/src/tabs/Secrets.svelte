<script>
  import { apiGet, apiPost } from '../lib/api.js'
  import { session } from '../lib/session.js'

  // Grundhaltung dieser Seite: Sie zeigt, WELCHE Geheimnisse das Werkzeug hält
  // und in welchem Zustand — nicht deren Werte. Einblenden ist ein einzelner,
  // bestätigter Schritt pro Eintrag und landet im Audit-Log.
  //
  // Kein "alles einblenden": Hier liegen die Zertifikats-Privatschlüssel für
  // jeden angebundenen Kundentenant. Eine Ansicht, die sie gleichzeitig zeigt,
  // macht aus einem Screenshot die Kompromittierung sämtlicher Mandate.
  let secrets = $state(null)
  let error = $state(null)
  let loading = $state(false)
  let loaded = false

  let revealed = $state({})   // id -> Wert (nur im Speicher, nie persistiert)
  let revealBusy = $state({})
  let copied = $state({})
  let filter = $state('')

  async function load() {
    loading = true; error = null
    try {
      const r = await apiGet('/api/admin/secrets')
      secrets = r.secrets || []
      loaded = true
    } catch (e) { error = e.message }
    loading = false
  }

  $effect(() => {
    if ($session.ready && $session.online && $session.loggedIn && !loaded) load()
    if (!($session.loggedIn && $session.online)) { loaded = false; revealed = {} }
  })

  async function reveal(s) {
    if (!confirm(
      `«${s.label}» im Klartext anzeigen?\n\n` +
      `Der Vorgang wird im Audit-Log festgehalten. Der Wert bleibt sichtbar, bis du ihn wieder ` +
      `verbirgst oder die Seite verlässt.`
    )) return
    revealBusy = { ...revealBusy, [s.id]: true }
    try {
      const r = await apiPost('/api/admin/secrets/reveal', { id: s.id, confirm: true })
      revealed = { ...revealed, [s.id]: r.value }
    } catch (e) { alert(e.message) }
    revealBusy = { ...revealBusy, [s.id]: false }
  }

  function hide(id) {
    const next = { ...revealed }; delete next[id]; revealed = next
    copied = { ...copied, [id]: false }
  }
  function hideAll() { revealed = {}; copied = {} }

  function copyValue(id) {
    const v = revealed[id]
    if (!v) return
    navigator.clipboard.writeText(v).then(() => {
      copied = { ...copied, [id]: true }
      setTimeout(() => { copied = { ...copied, [id]: false } }, 4000)
    })
  }

  // ---------- Bearbeiten ----------
  // Der Entwurf lebt nur im Feld. Geschrieben wird ausschliesslich beim
  // ausdrücklichen Speichern — Abbrechen verwirft ihn ersatzlos.
  let draft = $state({})      // id -> Entwurfstext
  let saveBusy = $state({})
  let saveNote = $state({})   // id -> Meldung nach dem Speichern

  function startEdit(s) {
    // Vorhandenen Wert übernehmen, wenn er gerade eingeblendet ist — sonst
    // leer beginnen, damit niemand versehentlich eine Maskierung speichert.
    draft = { ...draft, [s.id]: revealed[s.id] !== undefined ? revealed[s.id] : '' }
    saveNote = { ...saveNote, [s.id]: null }
  }
  function cancelEdit(id) {
    const next = { ...draft }; delete next[id]; draft = next
  }
  function isEditing(id) { return draft[id] !== undefined }

  async function save(s) {
    const value = draft[s.id]
    if (!value || !value.trim()) { alert('Leerer Wert — nichts gespeichert.'); return }
    if (!confirm(
      `«${s.label}» jetzt überschreiben?\n\n` +
      (s.editHint ? s.editHint + '\n\n' : '') +
      `Der Vorgang wird im Audit-Log festgehalten.`
    )) return
    saveBusy = { ...saveBusy, [s.id]: true }
    try {
      const r = await apiPost('/api/admin/secrets/update', { id: s.id, value, confirm: true })
      cancelEdit(s.id)
      hide(s.id)
      saveNote = { ...saveNote, [s.id]: r.warning || 'Gespeichert.' }
      await load()
    } catch (e) { alert(e.message) }
    saveBusy = { ...saveBusy, [s.id]: false }
  }

  const GROUP_ORDER = ['Kundentenants', 'Dieses Werkzeug', 'Angebundene Dienste', 'Nicht abrufbar']

  const grouped = $derived.by(() => {
    if (!secrets) return []
    const q = filter.trim().toLowerCase()
    const list = q
      ? secrets.filter(s => (s.label + ' ' + s.kind + ' ' + s.scope).toLowerCase().includes(q))
      : secrets
    const by = {}
    for (const s of list) (by[s.group] = by[s.group] || []).push(s)
    return GROUP_ORDER.filter(g => by[g]).map(g => ({ name: g, items: by[g] }))
  })

  const revealedCount = $derived(Object.keys(revealed).length)
  const totalCount = $derived(secrets ? secrets.length : 0)
</script>

{#if !$session.online}
  <div class="alert alert-warning"><strong>Backend nicht erreichbar.</strong> Ohne API gibt es hier nichts zu sehen.</div>
{:else if !$session.loggedIn}
  <div class="alert alert-warning"><strong>Nicht angemeldet.</strong> Oben rechts anmelden.</div>
{:else}

  <div class="settings-group">
    <h4>Was dieses Werkzeug hält</h4>
    <p class="ld-section-hint">
      Diese Seite zeigt den <b>Zustand</b> der hinterlegten Geheimnisse, nicht ihre Werte. Jedes Einblenden ist
      ein einzelner, bestätigter Schritt und wird im Audit-Log festgehalten. Bewusst gibt es kein
      «alles anzeigen»: Hier liegen die Privatschlüssel für jeden angebundenen Kundentenant — mit Rechten bis
      <code>RoleManagement.ReadWrite.Directory</code>. Eine Ansicht, die sie gleichzeitig rendert, würde aus
      einem Screenshot oder einem offen stehenden Bildschirm die Kompromittierung sämtlicher Mandate machen.
    </p>

    <div class="secrets-toolbar">
      <input class="secrets-filter" placeholder="Filtern nach Name, Art oder Bereich…" bind:value={filter}>
      <button class="btn btn-secondary" onclick={load} disabled={loading}>{loading ? 'Lädt…' : 'Neu laden'}</button>
      {#if revealedCount > 0}
        <button class="btn btn-primary" onclick={hideAll}>{revealedCount} eingeblendete verbergen</button>
      {/if}
      <span class="secrets-count">{totalCount} Einträge</span>
    </div>

    {#if error}
      <div class="ld-banner fail" style="margin-top:0.75rem;">{error}</div>
    {/if}
  </div>

  {#if loading && !secrets}
    <div class="settings-group"><p class="ld-section-hint">Lädt…</p></div>
  {:else if secrets && grouped.length === 0}
    <div class="settings-group"><p class="ld-section-hint">Kein Eintrag passt zum Filter.</p></div>
  {/if}

  {#each grouped as g (g.name)}
    <div class="settings-group">
      <h4>{g.name}</h4>

      {#each g.items as s (s.id)}
        <div class="ld-job secret-card" class:secret-missing={s.recoverable === false && s.severity !== '—'}>
          <div class="ld-job-head">
            <strong>{s.label}</strong>
            <span class="secret-kind">{s.kind}{s.severity !== '—' ? ' · Schutzbedarf ' + s.severity : ''}</span>
          </div>

          <dl class="secret-meta">
            {#each Object.entries(s.meta || {}) as [k, v]}
              <dt>{k}</dt><dd>{v}</dd>
            {/each}
          </dl>

          {#if s.note}
            <p class="ld-section-hint secret-note">{s.note}</p>
          {/if}

          {#if saveNote[s.id]}
            <div class="ld-banner ok" style="margin-top:0.6rem;">{saveNote[s.id]}</div>
          {/if}

          {#if s.recoverable || s.editable}
            <div class="secret-actions">
              {#if s.recoverable && revealed[s.id] === undefined}
                <button class="btn btn-secondary" onclick={() => reveal(s)} disabled={revealBusy[s.id]}>
                  {revealBusy[s.id] ? 'Lädt…' : 'Im Klartext anzeigen'}
                </button>
              {:else if s.recoverable}
                <button class="btn btn-secondary" onclick={() => hide(s.id)}>Verbergen</button>
                <button class="btn btn-secondary" onclick={() => copyValue(s.id)}>{copied[s.id] ? 'Kopiert' : 'Kopieren'}</button>
              {/if}
              {#if s.editable && !isEditing(s.id)}
                <button class="btn btn-secondary" onclick={() => startEdit(s)}>Bearbeiten</button>
              {/if}
            </div>

            {#if s.recoverable && revealed[s.id] !== undefined && !isEditing(s.id)}
              <pre class="secret-value">{revealed[s.id]}</pre>
            {/if}

            {#if isEditing(s.id)}
              <div class="secret-edit">
                {#if s.editHint}<p class="ld-section-hint" style="margin:0 0 0.5rem;">{s.editHint}</p>{/if}
                <textarea
                  class="secret-input"
                  rows={s.id.startsWith('cert:') ? 12 : 2}
                  spellcheck="false"
                  autocomplete="off"
                  placeholder={s.id.startsWith('cert:') ? '-----BEGIN PRIVATE KEY-----\n…' : 'Neuer Wert'}
                  bind:value={draft[s.id]}></textarea>
                <div class="secret-actions">
                  <button class="btn btn-primary" onclick={() => save(s)} disabled={saveBusy[s.id]}>
                    {saveBusy[s.id] ? 'Speichert…' : 'Speichern'}
                  </button>
                  <button class="btn btn-secondary" onclick={() => cancelEdit(s.id)} disabled={saveBusy[s.id]}>Abbrechen</button>
                  <span class="secret-editnote">Bis zum Speichern wird nichts geändert.</span>
                </div>
              </div>
            {/if}
          {/if}
        </div>
      {/each}
    </div>
  {/each}

{/if}

<style>
  .secrets-toolbar {
    display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem;
    margin-top: 0.75rem;
  }
  .secrets-filter { min-width: 15rem; flex: 1 1 15rem; }
  .secrets-count { margin-left: auto; font-size: 0.82rem; opacity: 0.7; }

  .secret-card { margin-bottom: 0.7rem; }
  .secret-card:last-child { margin-bottom: 0; }
  .secret-missing { border-left: 3px solid var(--warn); }

  .secret-kind { font-size: 0.78rem; opacity: 0.75; white-space: nowrap; }

  /* Zwei Spalten: Bezeichnung schmal, Wert bricht um. Unter 40rem untereinander,
     sonst quetscht der Dateipfad die Spalte zusammen. */
  .secret-meta {
    display: grid;
    grid-template-columns: minmax(7rem, max-content) minmax(0, 1fr);
    gap: 0.2rem 1rem;
    margin: 0.55rem 0 0;
    font-size: 0.85rem;
  }
  .secret-meta dt { opacity: 0.7; }
  .secret-meta dd { margin: 0; overflow-wrap: anywhere; }

  .secret-note { margin: 0.5rem 0 0; }
  .secret-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 0.6rem; }

  .secret-edit { margin-top: 0.6rem; }
  .secret-input {
    width: 100%;
    font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
    font-size: 0.78rem;
    line-height: 1.45;
    resize: vertical;
  }
  .secret-editnote { font-size: 0.78rem; opacity: 0.7; align-self: center; }

  .secret-value {
    margin: 0.55rem 0 0;
    padding: 0.65rem 0.8rem;
    border: 1px solid var(--border, rgba(127,127,127,0.3));
    border-radius: 6px;
    background: rgba(127,127,127,0.08);
    font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
    font-size: 0.78rem;
    line-height: 1.45;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 20rem;
    overflow: auto;
  }

  @media (max-width: 40rem) {
    .secret-meta { grid-template-columns: minmax(0, 1fr); gap: 0.05rem; }
    .secret-meta dt { margin-top: 0.35rem; }
    .secrets-count { margin-left: 0; }
  }
</style>
