<script>
  // Diagnose-Bereich: Server-Log und Erreichbarkeitstest direkt im Tool.
  // Hintergrund: seit dem GitOps-Deploy laeuft die API als Pod — "docker logs"
  // gibt es nicht mehr, und kubectl hat nicht jeder zur Hand. Fuer die
  // typischen Faelle (500er beim Onboarding, Login geht nicht) reicht das hier.
  import { onDestroy } from 'svelte'
  import { apiGet } from '../lib/api.js'
  import { session } from '../lib/session.js'

  let entries = $state([])
  let logError = $state(null)
  let logLoading = $state(false)
  let onlyErrors = $state(false)
  let autoRefresh = $state(false)
  let lastLoad = $state(null)
  let timer = null

  let shown = $derived(onlyErrors ? entries.filter(e => e.level === 'error' || e.level === 'warn') : entries)

  async function loadLog() {
    logLoading = true
    try {
      const r = await apiGet('/api/serverlog?limit=300')
      entries = r.entries || []
      logError = null
      lastLoad = new Date()
    } catch (e) {
      logError = e.message
    }
    logLoading = false
  }

  function toggleAuto() {
    autoRefresh = !autoRefresh
    if (timer) { clearInterval(timer); timer = null }
    if (autoRefresh) { loadLog(); timer = setInterval(loadLog, 5000) }
  }

  function copyLog() {
    const text = shown.map(e => `${e.ts} [${e.level}] ${e.msg}`).join('\n')
    navigator.clipboard.writeText(text)
  }

  // ---------- Egress-Test ----------
  let egress = $state(null)
  let egressBusy = $state(false)
  let egressError = $state(null)

  async function runEgress() {
    egressBusy = true
    egressError = null
    try {
      const r = await apiGet('/api/diag/egress')
      egress = r.results || []
    } catch (e) {
      egressError = e.message
    }
    egressBusy = false
  }

  // Reihenfolge der Gruppen so lassen, wie das Backend sie liefert — sie ist
  // nach Wichtigkeit sortiert (Pflicht zuerst).
  let egressGroups = $derived.by(() => {
    const out = []
    for (const r of (egress || [])) {
      const key = r.group || 'Weitere'
      let g = out.find(x => x.name === key)
      if (!g) { g = { name: key, rows: [] }; out.push(g) }
      g.rows.push(r)
    }
    return out
  })
  let egressFailed = $derived((egress || []).filter(r => !r.skipped && !r.ok && !r.optional).length)

  onDestroy(() => { if (timer) clearInterval(timer) })
</script>

{#if !$session.online}
  <div class="alert alert-warning"><strong>Backend nicht erreichbar.</strong> Ohne API gibt es hier nichts zu sehen.</div>
{:else if !$session.loggedIn}
  <div class="alert alert-warning"><strong>Nicht angemeldet.</strong> Oben rechts anmelden.</div>
{:else}
  <div class="settings-group">
    <h4>Erreichbarkeit der Gegenstellen</h4>
    <p class="ld-section-hint">Testet aus dem Container heraus alle Hosts, die das Tool nach draussen anspricht —
      Onboarding und Graph, die Quellen für die App-Installer (Bitwarden, Bitdefender, N-sight, FortiClient),
      die Intune-Baselines und die optionalen Dienste. Schlägt hier etwas fehl, liegt es an Egress, DNS oder einem
      TLS-abfangenden Proxy — nicht am Tool. <b>Jede HTTP-Antwort zählt als erreichbar</b>, auch 401/403/404:
      geprüft wird die Netzwerkstrecke, nicht die Berechtigung.</p>
    <button class="btn btn-primary" disabled={egressBusy} onclick={runEgress}>
      {egressBusy ? 'Teste…' : '▶ Test starten'}
    </button>

    {#if egressError}
      <div class="alert alert-warning" style="margin-top:0.75rem;">Test fehlgeschlagen: {egressError}</div>
    {/if}

    {#if egress}
      <div class="ld-banner {egressFailed ? 'fail' : 'ok'}" style="margin-top:0.75rem;">
        {egressFailed
          ? egressFailed + ' Gegenstelle(n) nicht erreichbar — Details unten.'
          : 'Alle geprüften Gegenstellen erreichbar.'}
      </div>
      {#each egressGroups as g (g.name)}
        <h5 style="margin:0.9rem 0 0.35rem;">{g.name}</h5>
        <div class="ld-job">
          {#each g.rows as r}
            <div class="wizard-step">
              <div class="wizard-step-body">
                <div class="wizard-step-title">
                  {r.skipped ? 'ℹ️' : r.ok ? '✅' : r.optional ? '⚠️' : '❌'} {r.name}
                </div>
                <div class="wizard-step-desc">
                  {#if r.why}{r.why}<br />{/if}
                  {#if r.skipped}
                    <code>{r.host}</code> — nicht testbar
                  {:else if r.ok}
                    HTTP {r.status} · {r.ms} ms
                  {:else}
                    {r.error}{#if r.code} · <code>{r.code}</code>{/if} · nach {r.ms} ms
                    {#if r.optional} · nicht konfiguriert, daher unkritisch{/if}
                  {/if}
                  {#if r.url}<br /><code style="word-break:break-all;">{r.url}</code>{/if}
                </div>
              </div>
            </div>
          {/each}
        </div>
      {/each}
    {/if}
  </div>

  <div class="settings-group" style="margin-top:1.25rem;">
    <h4>Server-Log</h4>
    <p class="ld-section-hint">Die letzten Zeilen der laufenden API-Instanz. Passwörter, Tokens und Secrets werden
      vor der Anzeige maskiert. Der Puffer lebt im Arbeitsspeicher — ein Neustart des Pods setzt ihn zurück.</p>

    <div style="display:flex; gap:0.5rem; flex-wrap:wrap; align-items:center;">
      <button class="btn btn-primary" disabled={logLoading} onclick={loadLog}>{logLoading ? 'Lade…' : '⟳ Aktualisieren'}</button>
      <button class="btn btn-secondary" onclick={toggleAuto}>{autoRefresh ? '⏸ Auto-Aktualisierung aus' : '▶ Auto-Aktualisierung (5s)'}</button>
      <label style="display:flex; align-items:center; gap:0.35rem; font-size:0.85rem;">
        <input type="checkbox" bind:checked={onlyErrors} /> nur Fehler/Warnungen
      </label>
      {#if entries.length}
        <button class="btn btn-secondary" onclick={copyLog}>Kopieren</button>
      {/if}
      {#if lastLoad}
        <span class="ld-section-hint" style="margin:0;">Stand: {lastLoad.toLocaleTimeString('de-CH')}</span>
      {/if}
    </div>

    {#if logError}
      <div class="alert alert-warning" style="margin-top:0.75rem;">Log nicht abrufbar: {logError}</div>
    {/if}

    {#if entries.length === 0 && !logLoading && !logError}
      <p class="ld-section-hint" style="margin-top:0.75rem;">Noch nichts geladen — auf „Aktualisieren" klicken.</p>
    {:else if shown.length === 0 && entries.length > 0}
      <p class="ld-section-hint" style="margin-top:0.75rem;">Keine Fehler oder Warnungen im Puffer.</p>
    {:else if shown.length}
      <div class="diag-log">
        {#each shown as e}
          <div class="diag-line" class:err={e.level === 'error'} class:warn={e.level === 'warn'}>
            <span class="diag-ts">{new Date(e.ts).toLocaleTimeString('de-CH')}</span>
            <span class="diag-msg">{e.msg}</span>
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/if}
