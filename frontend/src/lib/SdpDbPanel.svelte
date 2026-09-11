<script>
  // Lesender SQL-Zugang zur SDP-Datenbank.
  //
  // Zweck: alles, was ueber viele Tickets rechnet, ist ueber die V3-API eine
  // Requestlawine und in SQL eine Abfrage. Geschrieben wird hier nichts --
  // das Backend laesst ausschliesslich SELECT durch, in einer Nur-Lese-Sitzung.
  // Aenderungen an SDP laufen weiter ueber die API.
  //
  // Der Bereich dient zwei Dingen: das Schema kennenlernen (welche Tabelle
  // haelt Worklogs? wie haengt Ticket an Kunde?) und Auswertungen ausprobieren,
  // bevor sie als feste Funktion eingebaut werden.
  import { apiGet, apiPost, apiDelete, errText } from './api.js'

  let db = $state(null)
  let pw = $state('')
  let busy = $state(false)
  let fehler = $state(null)
  let info = $state(null)

  let sql = $state('SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY n_live_tup DESC')
  let limit = $state(200)
  let ergebnis = $state(null)
  let queryFehler = $state(null)
  let queryBusy = $state(false)

  let tabellenSuche = $state('')
  let tabellen = $state(null)

  async function ladeStatus() {
    try { db = (await apiGet('/api/sdp/db/status')).db } catch (e) { fehler = errText(e) }
  }
  ladeStatus()

  async function verbinden() {
    busy = true; fehler = null; info = null
    try {
      const r = await apiPost('/api/sdp/db/password', { password: pw })
      db = r.db
      info = `Verbunden als ${r.info.benutzer} auf ${r.info.db}`
      pw = ''
    } catch (e) { fehler = errText(e) }
    busy = false
  }

  async function trennen() {
    busy = true; fehler = null; info = null
    try { db = (await apiDelete('/api/sdp/db/password')).db; ergebnis = null; tabellen = null } catch (e) { fehler = errText(e) }
    busy = false
  }

  async function ausfuehren() {
    queryBusy = true; queryFehler = null
    try { ergebnis = await apiPost('/api/sdp/db/query', { sql, limit }) } catch (e) { queryFehler = errText(e); ergebnis = null }
    queryBusy = false
  }

  async function ladeTabellen() {
    queryBusy = true; queryFehler = null
    try {
      tabellen = await apiGet('/api/sdp/db/tables' + (tabellenSuche ? '?suche=' + encodeURIComponent(tabellenSuche) : ''))
    } catch (e) { queryFehler = errText(e) }
    queryBusy = false
  }

  function spaltenZeigen(tabelle) {
    sql = `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${tabelle}' ORDER BY ordinal_position`
    ausfuehren()
  }

  function alsCsv() {
    if (!ergebnis) return
    const esc = v => {
      const s = v === null || v === undefined ? '' : String(v)
      return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
    }
    const zeilen = [ergebnis.columns.join(';'), ...ergebnis.rows.map(r => ergebnis.columns.map(c => esc(r[c])).join(';'))]
    navigator.clipboard.writeText(zeilen.join('\n'))
  }

  function zelle(v) {
    if (v === null || v === undefined) return '—'
    if (v instanceof Date) return v.toLocaleString('de-CH')
    if (typeof v === 'object') return JSON.stringify(v)
    const s = String(v)
    return s.length > 300 ? s.slice(0, 300) + '…' : s
  }
</script>

<div class="settings-group">
  <h4>SDP-Datenbank — Lesezugriff</h4>
  <p class="ld-section-hint">
    Direkte SQL-Abfragen auf die ServiceDesk-Plus-Datenbank. <b>Nur lesend</b>: das Backend lässt ausschliesslich
    <code>SELECT</code> durch und fährt jede Abfrage in einer Nur-Lese-Sitzung — in die SDP-Datenbank schreibt dieses
    Tool nie, Änderungen laufen weiter über die API. Gedacht für Auswertungen über viele Tickets, für die die API
    dutzende Requests bräuchte.
  </p>

  {#if fehler}<div class="alert alert-warning">{fehler}</div>{/if}
  {#if info}<div class="ld-banner ok">{info}</div>{/if}

  {#if db}
    <div class="ld-step">
      <small>
        <code>{db.user}@{db.host}:{db.port}/{db.database}</code> ·
        {#if db.hasPassword}
          <span class="tbadge">verbunden{db.fromEnv ? ' (Passwort aus der Umgebung)' : ''}</span>
        {:else}
          <span class="tbadge warn">kein Passwort gesetzt</span>
        {/if}
      </small>
    </div>

    {#if !db.hasPassword}
      <p class="ld-section-hint">
        Das Passwort wird nicht gespeichert — es lebt nur im Arbeitsspeicher der laufenden Instanz und ist nach einem
        Neustart weg. Absicht: es ist das Passwort des Schema-Owners, und als hinterlegtes Secret hätte jeder Zugriff
        darauf, der im Cluster an Secrets kommt.
      </p>
      <div style="display:flex; gap:0.5rem; flex-wrap:wrap; align-items:center;">
        <input type="password" bind:value={pw} placeholder="Datenbank-Passwort" style="min-width:18rem;"
               onkeydown={e => { if (e.key === 'Enter' && pw) verbinden() }} />
        <button class="btn btn-primary" disabled={busy || !pw} onclick={verbinden}>{busy ? 'Prüfe…' : 'Verbinden'}</button>
      </div>
    {:else}
      <div style="display:flex; gap:0.5rem; flex-wrap:wrap; align-items:center; margin-bottom:0.75rem;">
        <input bind:value={tabellenSuche} placeholder="Tabelle suchen (z.B. workorder)" style="min-width:14rem;"
               onkeydown={e => { if (e.key === 'Enter') ladeTabellen() }} />
        <button class="btn btn-secondary" disabled={queryBusy} onclick={ladeTabellen}>Tabellen auflisten</button>
        {#if !db.fromEnv}<button class="btn btn-secondary" disabled={busy} onclick={trennen}>Verbindung trennen</button>{/if}
      </div>

      {#if tabellen}
        <div class="diag-log" style="max-height:14rem;">
          {#each tabellen.rows as t}
            <div class="diag-line" style="cursor:pointer;" onclick={() => spaltenZeigen(t.tabelle)} role="button" tabindex="0"
                 onkeydown={e => { if (e.key === 'Enter') spaltenZeigen(t.tabelle) }}>
              <span class="diag-msg"><code>{t.tabelle}</code> — {t.zeilen_geschaetzt} Zeilen · {t.groesse}</span>
            </div>
          {/each}
          {#if !tabellen.rows.length}<div class="diag-line"><span class="diag-msg">Nichts gefunden.</span></div>{/if}
        </div>
        <p class="ld-section-hint">Klick auf eine Tabelle zeigt ihre Spalten.</p>
      {/if}

      <textarea bind:value={sql} rows="5" spellcheck="false"
                style="width:100%; font-family:ui-monospace,Menlo,Consolas,monospace; font-size:0.85rem;"></textarea>
      <div style="display:flex; gap:0.5rem; flex-wrap:wrap; align-items:center; margin-top:0.5rem;">
        <button class="btn btn-primary" disabled={queryBusy} onclick={ausfuehren}>{queryBusy ? 'Läuft…' : '▶ Abfrage ausführen'}</button>
        <label style="display:flex; align-items:center; gap:0.35rem; font-size:0.85rem;">
          max. Zeilen <input type="number" bind:value={limit} min="1" max={db.maxRows} style="width:6rem;" />
        </label>
        {#if ergebnis}<button class="btn btn-secondary" onclick={alsCsv}>Als CSV kopieren</button>{/if}
      </div>

      {#if queryFehler}
        <div class="alert alert-warning" style="margin-top:0.75rem;">{queryFehler}</div>
      {/if}

      {#if ergebnis}
        <p class="ld-section-hint" style="margin-top:0.75rem;">
          {ergebnis.rowCount} Zeilen in {ergebnis.ms} ms{#if ergebnis.truncated} · <b>beim Limit abgeschnitten</b>{/if}
        </p>
        <div class="gt-table-wrap" style="overflow-x:auto; max-height:26rem; overflow-y:auto;">
          <table class="gt-table" style="font-size:0.8rem;">
            <thead><tr>{#each ergebnis.columns as c}<th>{c}</th>{/each}</tr></thead>
            <tbody>
              {#each ergebnis.rows as r}
                <tr>{#each ergebnis.columns as c}<td style="white-space:pre-wrap; vertical-align:top;">{zelle(r[c])}</td>{/each}</tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    {/if}
  {/if}
</div>
