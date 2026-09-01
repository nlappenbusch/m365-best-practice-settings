<script>
  import { apiGet, apiPost } from '../lib/api.js'
  import { session } from '../lib/session.js'

  // Grundhaltung dieser Seite: Sie zeigt, WELCHE Geheimnisse das Werkzeug hält
  // und in welchem Zustand — nicht deren Werte. Einblenden ist ein einzelner,
  // bestätigter Schritt pro Eintrag und landet im Audit-Log.
  //
  // Kein "alles einblenden": Hier liegen die Zertifikats-Privatschlüssel für
  // jeden angebundenen Kundentenant. Eine Ansicht, die sie gleichzeitig zeigt,
  // macht aus einem Screenshot oder einem offen stehenden Bildschirm die
  // Kompromittierung sämtlicher Mandate.
  let secrets = $state(null)
  let error = $state(null)
  let loading = $state(false)
  let loaded = false

  let revealed = $state({})   // id -> Wert (nur im Speicher, nie im localStorage)
  let revealBusy = $state({}) // id -> bool
  let copied = $state({})     // id -> bool
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
      `Der Vorgang wird im Audit-Log festgehalten. Der Wert bleibt sichtbar, bis du ihn ` +
      `wieder verbirgst oder die Seite verlässt.`
    )) return
    revealBusy = { ...revealBusy, [s.id]: true }
    try {
      const r = await apiPost('/api/admin/secrets/reveal', { id: s.id, confirm: true })
      revealed = { ...revealed, [s.id]: r.value }
    } catch (e) { alert(e.message) }
    revealBusy = { ...revealBusy, [s.id]: false }
  }

  function hide(id) {
    const next = { ...revealed }
    delete next[id]
    revealed = next
    copied = { ...copied, [id]: false }
  }

  function hideAll() {
    revealed = {}
    copied = {}
  }

  function copyValue(id) {
    const v = revealed[id]
    if (!v) return
    navigator.clipboard.writeText(v).then(() => {
      copied = { ...copied, [id]: true }
      setTimeout(() => { copied = { ...copied, [id]: false } }, 4000)
    })
  }

  const sevClass = { hoch: 'fail', mittel: 'warn' }

  const shown = $derived.by(() => {
    if (!secrets) return []
    const q = filter.trim().toLowerCase()
    if (!q) return secrets
    return secrets.filter(s =>
      (s.label + ' ' + s.kind + ' ' + s.scope).toLowerCase().includes(q)
    )
  })

  const revealedCount = $derived(Object.keys(revealed).length)
</script>

<div class="page-head">
  <h1>Geheimnisse</h1>
  <p class="page-sub">Welche Schlüssel und Zugangsdaten dieses Werkzeug hält — Zustand, Gültigkeit, gezieltes Einblenden</p>
</div>

<div class="ld-banner warn">
  Diese Seite listet den <strong>Zustand</strong> der Geheimnisse, nicht ihre Werte. Jedes Einblenden ist ein
  einzelner, bestätigter Schritt und wird im Audit-Log festgehalten. Hier liegen die Privatschlüssel für jeden
  angebundenen Kundentenant — mit Rechten bis <code>RoleManagement.ReadWrite.Directory</code>. Deshalb bewusst
  kein «alles anzeigen»: Ein Screenshot oder ein offen stehender Bildschirm würde sonst sämtliche Mandate betreffen.
</div>

{#if error}
  <div class="ld-banner fail">{error}</div>
{/if}

<div class="card">
  <div class="card-head">
    <h2>Bestand</h2>
    <span class="pill neutral">{secrets ? secrets.length : 0} Einträge</span>
  </div>
  <div class="actions" style="gap:0.6rem; flex-wrap:wrap;">
    <input placeholder="Filtern nach Name, Art oder Bereich…" bind:value={filter} style="min-width:16rem;">
    <button class="btn btn-secondary" onclick={load} disabled={loading}>{loading ? 'Lädt…' : 'Neu laden'}</button>
    {#if revealedCount > 0}
      <button class="btn btn-primary" onclick={hideAll}>{revealedCount} eingeblendete wieder verbergen</button>
    {/if}
  </div>
</div>

{#if loading && !secrets}
  <div class="empty">Lädt…</div>
{:else if secrets && shown.length === 0}
  <div class="empty">Kein Eintrag passt zum Filter.</div>
{/if}

{#each shown as s (s.id)}
  <div class="card" style="margin-bottom:0.9rem;">
    <div class="card-head">
      <h2>{s.label}</h2>
      <span class="pill {s.severity === 'hoch' ? 'bad' : s.severity === 'mittel' ? 'warn' : 'neutral'}">{s.kind}</span>
    </div>

    <div class="c-desc" style="margin-bottom:0.5rem;">
      Bereich: <strong>{s.scope}</strong>
      {#if s.severity !== '—'} · Schutzbedarf: <strong>{s.severity}</strong>{/if}
    </div>

    <div class="kv-grid">
      {#each Object.entries(s.meta || {}) as [k, v]}
        <div class="kv-k">{k}</div>
        <div class="kv-v">{v}</div>
      {/each}
    </div>

    {#if s.note}
      <div class="ld-banner {s.recoverable ? 'warn' : ''}" style="margin-top:0.6rem;">{s.note}</div>
    {/if}

    {#if s.recoverable}
      <div class="actions" style="margin-top:0.6rem;">
        {#if revealed[s.id] === undefined}
          <button class="btn btn-secondary" onclick={() => reveal(s)} disabled={revealBusy[s.id]}>
            {revealBusy[s.id] ? 'Lädt…' : '👁 Im Klartext anzeigen'}
          </button>
        {:else}
          <button class="btn btn-secondary" onclick={() => hide(s.id)}>Verbergen</button>
          <button class="btn btn-secondary" onclick={() => copyValue(s.id)}>{copied[s.id] ? '✓ Kopiert' : 'Kopieren'}</button>
        {/if}
      </div>
      {#if revealed[s.id] !== undefined}
        <pre class="secret-value">{revealed[s.id]}</pre>
      {/if}
    {:else}
      <div class="c-desc" style="margin-top:0.6rem; opacity:0.85;">Nicht abrufbar — siehe Hinweis oben.</div>
    {/if}
  </div>
{/each}

<style>
  .kv-grid {
    display: grid;
    grid-template-columns: minmax(8rem, max-content) 1fr;
    gap: 0.25rem 1rem;
    font-size: 0.88rem;
  }
  .kv-k { color: var(--text-muted); }
  .kv-v { word-break: break-word; font-variant-numeric: tabular-nums; }
  .secret-value {
    margin: 0.6rem 0 0;
    padding: 0.7rem 0.9rem;
    background: var(--surface-2, rgba(127,127,127,0.08));
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
    font-size: 0.8rem;
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 22rem;
    overflow: auto;
  }
</style>
