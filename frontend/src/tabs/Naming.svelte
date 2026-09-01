<script>
  // Namenskonvention: ein Ort, an dem festgelegt wird, wie die Objekte heissen,
  // die dieses Werkzeug anlegt — Gerätegruppen, App-Zielgruppen, CA-Gruppen,
  // Break-Glass-Konten, Plattformskripte.
  //
  // Global gilt als Vorgabe, ein Tenant kann davon abweichen. Das ist Absicht:
  // Ein neu onboardeter Kunde kann auf v2 laufen, während Bestandskunden ihre
  // gewachsenen Namen behalten. Bestehende Objekte werden NIE umbenannt —
  // gesucht wird serverseitig über alle bekannten Muster, damit nach einem
  // Wechsel nichts doppelt angelegt wird.
  import { apiGet, apiPost } from '../lib/api.js'
  import { activeTenant } from '../lib/tenantStore.js'
  import { session } from '../lib/session.js'

  let data = $state(null)          // Antwort von /api/naming
  let busy = $state(false)
  let error = $state(null)
  let notice = $state(null)

  let scope = $state('global')     // 'global' | 'tenant'
  let profile = $state('legacy')
  let templates = $state({})       // nur die abweichenden Muster
  let tenantOverride = $state(null)

  // Defensiv: Eine unerwartete Antwort darf diese Komponente nicht zerlegen —
  // sie ist immer gemountet, ein Fehler beim Rendern legt sonst die ganze
  // Oberflaeche lahm (auch den Tenant-Umschalter im Kopf).
  const kinds = $derived(Array.isArray(data?.kinds) ? data.kinds : [])
  const profiles = $derived(Array.isArray(data?.profiles) ? data.profiles : [])
  const tenantRows = $derived(Array.isArray(data?.tenants) ? data.tenants : [])
  const baseTemplates = $derived(
    (profiles.find(p => p.key === profile) || { templates: {} }).templates
  )
  const hasOverride = $derived(!!tenantOverride)
  const changedCount = $derived(Object.keys(templates).length)

  // Dieselbe Ersetzungslogik wie serverseitig in lib/naming.js — hier nur für
  // die Live-Vorschau, damit man beim Tippen sofort sieht, was entsteht.
  function camel(s) {
    return String(s ?? '')
      .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
      .replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue').replace(/ß/g, 'ss')
      .split(/[^A-Za-z0-9]+/).filter(Boolean)
      .map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('')
  }
  function render(tpl, vars) {
    let out = String(tpl ?? '')
    for (const k of Object.keys(vars || {})) {
      const raw = vars[k]
      if (raw === undefined || raw === null) continue
      const t = String(raw)
      out = out.split(`{${k}}`).join(k === 'nn' ? String(parseInt(t, 10) || 1).padStart(2, '0') : t)
      out = out.split(`{${k.toUpperCase()}}`).join(t.toUpperCase())
      out = out.split(`{${k.charAt(0).toUpperCase() + k.slice(1)}}`).join(camel(t))
    }
    return out.replace(/\{[A-Za-z]+\}/g, '').trim()
  }

  function effectiveTemplate(kind) {
    return templates[kind.key] ?? baseTemplates[kind.key] ?? ''
  }
  function previewOf(kind) {
    return render(effectiveTemplate(kind), kind.example || {})
  }
  function isChanged(kind) {
    return templates[kind.key] !== undefined && templates[kind.key] !== baseTemplates[kind.key]
  }

  async function load() {
    busy = true; error = null
    try {
      data = await apiGet('/api/naming')
      applyScope()
    } catch (e) {
      error = e.message
    }
    busy = false
  }

  function applyScope() {
    if (!data) return
    if (scope === 'tenant' && $activeTenant) {
      const t = tenantRows.find(x => x.id === $activeTenant.id)
      tenantOverride = t ? t.naming : null
      const src = tenantOverride || data.global || { profile: 'legacy', templates: {} }
      profile = src.profile || 'legacy'
      templates = { ...(src.templates || {}) }
    } else {
      tenantOverride = null
      const src = data.global || { profile: 'legacy', templates: {} }
      profile = src.profile || 'legacy'
      templates = { ...(src.templates || {}) }
    }
  }

  let loaded = false
  $effect(() => {
    if (!$session.loggedIn || loaded) return
    loaded = true
    load()
  })

  // Nach einem Fehlversuch (etwa 401 kurz vor der Anmeldung) darf es einen
  // zweiten Anlauf geben — sonst bleibt der Bereich dauerhaft leer.
  $effect(() => {
    if (error && !data) loaded = false
  })

  function setScope(v) {
    scope = v
    applyScope()
    notice = null
  }

  function setTemplate(kind, value) {
    const v = String(value ?? '')
    if (!v.trim() || v === baseTemplates[kind.key]) {
      const { [kind.key]: _drop, ...rest } = templates
      templates = rest
    } else {
      templates = { ...templates, [kind.key]: v }
    }
  }

  function resetKind(kind) {
    const { [kind.key]: _drop, ...rest } = templates
    templates = rest
  }

  function switchProfile(p) {
    // Eigene Muster hätten nach dem Wechsel eine andere Grundlage — deshalb
    // ausdrücklich fragen, statt sie stillschweigend mitzuschleppen.
    if (changedCount && !confirm(`Grundprofil wechseln?\n\n${changedCount} eigene(s) Muster wird dabei verworfen.`)) return
    profile = p
    templates = {}
  }

  async function save() {
    const where = scope === 'tenant' ? `den Tenant ${$activeTenant?.name}` : 'alle Tenants ohne eigene Einstellung'
    if (!confirm(`Namenskonvention für ${where} speichern?\n\nBestehende Objekte werden NICHT umbenannt — die Konvention gilt für alles, was ab jetzt neu angelegt wird.`)) return
    busy = true; error = null; notice = null
    try {
      const body = { profile, templates }
      if (scope === 'tenant') {
        await apiPost(`/api/tenants/${$activeTenant.id}/naming`, body)
        notice = `Konvention für ${$activeTenant.name} gespeichert.`
      } else {
        await apiPost('/api/naming', body)
        notice = 'Globale Konvention gespeichert.'
      }
      await load()
    } catch (e) {
      error = e.message
    }
    busy = false
  }

  async function removeOverride() {
    if (!$activeTenant) return
    if (!confirm(`Eigene Konvention von ${$activeTenant.name} entfernen?\n\nDanach gilt wieder die globale Vorgabe.`)) return
    busy = true; error = null; notice = null
    try {
      await apiPost(`/api/tenants/${$activeTenant.id}/naming`, { reset: true })
      notice = `${$activeTenant.name} folgt wieder der globalen Vorgabe.`
      await load()
    } catch (e) {
      error = e.message
    }
    busy = false
  }

  function tenantLabel(t) {
    if (!t.naming) return 'global'
    const p = (profiles.find(x => x.key === (t.naming.profile || 'legacy')) || {}).label || t.naming.profile
    const n = Object.keys(t.naming.templates || {}).length
    return n ? `${p} + ${n} eigene` : p
  }
</script>

<div class="settings-group">
  <h4>Namenskonvention</h4>
  <p class="ld-section-hint" style="margin-top:0">
    Legt fest, wie die Objekte heissen, die dieses Werkzeug anlegt: Gerätegruppen, App-Zielgruppen,
    CA-Schutzgruppen, Break-Glass-Konten und Plattformskripte. <strong>Bestehende Objekte werden nie
    umbenannt.</strong> Gesucht wird immer über alle bekannten Muster — nach einem Wechsel findet das
    Werkzeug also weiterhin, was unter dem alten Schema entstanden ist, und legt nichts doppelt an.
  </p>

  {#if error}<div class="alert alert-warning">❌ {error}</div>{/if}
  {#if notice}<div class="ld-banner ok">{notice}</div>{/if}

  {#if busy && !data}
    <p class="ld-section-hint"><span class="ld-spinner"></span> Lade…</p>
  {/if}

  {#if data && kinds.length}
    <div class="nm-scope">
      <button class="btn {scope === 'global' ? 'btn-primary' : 'btn-secondary'}" onclick={() => setScope('global')}>
        Global
      </button>
      <button class="btn {scope === 'tenant' ? 'btn-primary' : 'btn-secondary'}"
              disabled={!$activeTenant} onclick={() => setScope('tenant')}>
        {$activeTenant ? $activeTenant.name : 'Kein Tenant gewählt'}
      </button>
      {#if scope === 'tenant' && hasOverride}
        <span class="tbadge">eigene Konvention</span>
        <button class="btn btn-secondary" onclick={removeOverride}>Override entfernen</button>
      {:else if scope === 'tenant'}
        <span class="ld-section-hint" style="margin:0">folgt der globalen Vorgabe — Speichern legt einen Override an</span>
      {/if}
    </div>

    <h5 class="nm-sub">Grundprofil</h5>
    <div class="nm-profiles">
      {#each profiles as p}
        <button class="nm-profile" class:sel={profile === p.key} onclick={() => switchProfile(p.key)}>
          <span class="nm-profile-t">{p.label}</span>
          <span class="nm-profile-d">{p.hint}</span>
          <code class="nm-profile-x">{render(p.templates.deviceGroup, { tag: 'WIN-Std' })}</code>
        </button>
      {/each}
    </div>

    <h5 class="nm-sub">
      Muster
      {#if changedCount}<span class="tbadge warn">{changedCount} vom Profil abweichend</span>{/if}
    </h5>
    <div class="tbl-wrap">
      <table class="tbl nm-tbl">
        <thead>
          <tr><th>Objekt</th><th>Muster</th><th>Ergibt</th><th></th></tr>
        </thead>
        <tbody>
          {#each kinds as k (k.key)}
            <tr class:nm-changed={isChanged(k)}>
              <td>
                <strong>{k.label}</strong>
                {#if k.note}<br /><small>{k.note}</small>{/if}
              </td>
              <td>
                <input type="text" class="nm-input" value={effectiveTemplate(k)}
                       oninput={(e) => setTemplate(k, e.currentTarget.value)} />
                {#if k.vars.length}
                  <small class="nm-vars">
                    Platzhalter: {#each k.vars as v}<code>{'{' + v + '}'}</code> {/each}
                    <span class="nm-vars-hint">— gross geschrieben ergibt GROSSBUCHSTABEN, mit grossem Anfangsbuchstaben CamelCase</span>
                  </small>
                {/if}
              </td>
              <td><code>{previewOf(k) || '—'}</code></td>
              <td>
                {#if isChanged(k)}
                  <button class="ag-link" onclick={() => resetKind(k)}>zurücksetzen</button>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    <button class="btn btn-primary" style="margin-top:0.9rem" disabled={busy} onclick={save}>
      {busy ? 'Speichere…' : (scope === 'tenant' ? '💾 Für diesen Tenant speichern' : '💾 Global speichern')}
    </button>

    {#if tenantRows.length}
      <h5 class="nm-sub">Was gilt wo</h5>
      <div class="tbl-wrap">
        <table class="tbl">
          <thead><tr><th>Tenant</th><th>Konvention</th></tr></thead>
          <tbody>
            {#each tenantRows as t (t.id)}
              <tr>
                <td>{t.name}</td>
                <td>{tenantLabel(t)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <p class="ld-section-hint">
        «global» heisst: Der Tenant folgt der oben eingestellten Vorgabe. Ein eigener Eintrag entsteht erst,
        wenn hier mit gewähltem Tenant gespeichert wird.
      </p>
    {/if}
  {/if}
</div>

<style>
  .nm-scope { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; margin: 0.9rem 0 0.4rem; }
  .nm-sub { margin: 1.5rem 0 0.5rem; font-size: 0.95rem; display: flex; align-items: center; gap: 0.5rem; }

  .nm-profiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 0.6rem; }
  .nm-profile {
    text-align: left; cursor: pointer; font: inherit; color: inherit;
    background: transparent; border: 1px solid var(--border, rgba(127,127,127,.3));
    border-radius: 10px; padding: 0.7rem 0.85rem; display: flex; flex-direction: column; gap: 0.2rem;
  }
  .nm-profile:hover { border-color: var(--accent, #0081ad); }
  .nm-profile.sel { border-color: var(--accent, #0081ad); box-shadow: inset 0 0 0 1px var(--accent, #0081ad); }
  .nm-profile-t { font-weight: 600; }
  .nm-profile-d { font-size: 0.8rem; opacity: .7; line-height: 1.35; }
  .nm-profile-x { font-size: 0.78rem; opacity: .85; margin-top: 0.25rem; }

  .nm-tbl td { vertical-align: top; }
  .nm-input {
    width: 100%; min-width: 200px; font-family: ui-monospace, Consolas, monospace; font-size: 0.85rem;
    background: var(--bg, transparent); color: inherit;
    border: 1px solid var(--border, rgba(127,127,127,.3)); border-radius: 6px; padding: 0.35rem 0.5rem;
  }
  .nm-vars { display: block; margin-top: 0.25rem; opacity: .65; font-size: 0.75rem; }
  .nm-vars-hint { opacity: .8; }
  .nm-changed { background: color-mix(in srgb, var(--accent, #0081ad) 7%, transparent); }

  .ag-link {
    background: none; border: 0; cursor: pointer; padding: 0; font: inherit;
    font-size: 0.78rem; text-decoration: underline; color: inherit; opacity: .8; white-space: nowrap;
  }
  .ag-link:hover { opacity: 1; }
</style>
