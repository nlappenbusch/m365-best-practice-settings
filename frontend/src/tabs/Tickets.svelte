<script>
  import { session } from '../lib/session.js'
  import { sdpApi } from '../lib/sdpTickets.js'
  import { tenants } from '../lib/tenantStore.js'

  let sub = $state('single') // 'single' | 'batch' | 'runbooks'

  // ---------- KI-Vorschlag (pro Ticket-ID, da im Batch mehrere gleichzeitig offen sein koennen) ----------
  let aiTenantChoice = $state({})  // ticketId -> tenantId
  let aiLoading = $state({})       // ticketId -> bool
  let aiError = $state({})         // ticketId -> string
  let aiResult = $state({})        // ticketId -> suggestion
  let aiSavedRunbookId = $state({}) // ticketId -> runbookId | null

  async function requestAiSuggestion(ticketId) {
    aiLoading = { ...aiLoading, [ticketId]: true }
    aiError = { ...aiError, [ticketId]: null }
    aiResult = { ...aiResult, [ticketId]: null }
    aiSavedRunbookId = { ...aiSavedRunbookId, [ticketId]: null }
    try {
      const r = await sdpApi.aiSuggest(ticketId, aiTenantChoice[ticketId])
      aiResult = { ...aiResult, [ticketId]: r.suggestion }
      aiSavedRunbookId = { ...aiSavedRunbookId, [ticketId]: r.runbookId || null }
    } catch (e) {
      aiError = { ...aiError, [ticketId]: e.message }
    }
    aiLoading = { ...aiLoading, [ticketId]: false }
  }

  const VERDICT_CLASS = { bestaetigt: 'ok', widerlegt: 'fail', unklar: 'warn' }
  const VERDICT_ICON = { bestaetigt: '✅', widerlegt: '❌', unklar: '❔' }

  // ---------- KI-Runbooks (gespeicherte Vorschlaege, tenant-gepueft) ----------
  let runbooks = $state([])
  let runbooksLoading = $state(false)
  let runbooksError = $state(null)
  let runbookExpanded = $state({})  // runbookId -> bool

  async function loadRunbooks() {
    runbooksLoading = true
    runbooksError = null
    try {
      const r = await sdpApi.listRunbooks()
      runbooks = r.runbooks || []
    } catch (e) {
      runbooksError = e.message
    }
    runbooksLoading = false
  }

  async function removeRunbook(id) {
    if (!confirm('Diesen Runbook-Eintrag loeschen?')) return
    try {
      await sdpApi.deleteRunbook(id)
      runbooks = runbooks.filter(r => r.id !== id)
    } catch (e) {
      alert('Fehler: ' + e.message)
    }
  }

  function toggleRunbookExpand(id) {
    runbookExpanded = { ...runbookExpanded, [id]: !runbookExpanded[id] }
  }

  function switchSub(s) {
    sub = s
    if (s === 'runbooks' && !runbooks.length && !runbooksLoading && !runbooksError) loadRunbooks()
  }

  // ---------- Einzelticket ----------
  let singleId = $state('')
  let singleLoading = $state(false)
  let singleError = $state(null)
  let singleTicket = $state(null)

  async function loadSingle() {
    const id = singleId.trim()
    if (!id) return
    singleLoading = true
    singleError = null
    singleTicket = null
    try {
      const r = await sdpApi.getTicket(id)
      singleTicket = r.ticket
    } catch (e) {
      singleError = e.message
    }
    singleLoading = false
  }

  // ---------- Batch ----------
  let batchInput = $state('')
  let batchLoading = $state(false)
  let batchError = $state(null)
  let batchResults = $state([])   // [{id, ok, ticket|error}]
  let batchExpanded = $state({})  // id -> bool

  function parseBatchIds(raw) {
    return raw.split(/[\n,]+/).map(s => s.trim()).filter(Boolean)
  }

  async function loadBatch() {
    const ids = parseBatchIds(batchInput)
    if (!ids.length) return
    batchLoading = true
    batchError = null
    batchResults = []
    batchExpanded = {}
    try {
      const r = await sdpApi.getTicketsBatch(ids)
      batchResults = r.tickets || []
    } catch (e) {
      batchError = e.message
    }
    batchLoading = false
  }

  function toggleBatchExpand(id) {
    batchExpanded = { ...batchExpanded, [id]: !batchExpanded[id] }
  }

  const STATUS_CLASS = { 'Offen': 'warn', 'Open': 'warn', 'Geschlossen': 'ok', 'Closed': 'ok', 'Resolved': 'ok' }
  function statusClass(s) { return STATUS_CLASS[s] || 'warn' }
</script>

{#snippet ticketDetail(t)}
  <div class="ld-step"><small>
    <strong>Requester:</strong> {t.requester || '—'} · <strong>Techniker:</strong> {t.technician || '—'} ·
    <strong>Kategorie:</strong> {t.category || '—'}
  </small></div>
  <div class="ld-step"><small>
    <strong>Erstellt:</strong> {t.createdTime || '—'} · <strong>Fällig:</strong> {t.dueTime || '—'}
  </small></div>
  {#if t.description}
    <div class="ld-step" style="white-space:pre-wrap;">{t.description}</div>
  {/if}

  {#if t.attachments && t.attachments.length}
    <div class="settings-group">
      <h4>📎 Anhänge ({t.attachments.length})</h4>
      {#each t.attachments as a (a.id)}
        <div class="ld-step" style="display:flex; align-items:center; gap:0.6rem;">
          <span>{a.name}{#if a.size} <small>({Math.round(a.size / 1024)} KB)</small>{/if}</span>
          <button class="btn btn-secondary" style="padding:0.25rem 0.7rem; font-size:0.8rem;"
                  onclick={() => sdpApi.downloadAttachment(t.id, a.id)}>⬇ Herunterladen</button>
        </div>
      {/each}
    </div>
  {/if}

  <div class="settings-group">
    <h4>🗒️ Notizen {#if t.notesError}<small class="tbadge warn">Fehler: {t.notesError}</small>{/if}</h4>
    {#if !t.notes || !t.notes.length}
      <div class="ld-step"><small>Keine Notizen.</small></div>
    {:else}
      {#each t.notes as n (n.id)}
        <div class="ld-phase complete">
          <div class="ld-phase-title">{n.createdBy || '—'} <small style="font-weight:400;">— {n.createdTime}</small></div>
          <div class="ld-step" style="white-space:pre-wrap;">{n.description}</div>
        </div>
      {/each}
    {/if}
  </div>

  {#if t.tasks && t.tasks.length}
    <div class="settings-group">
      <h4>✅ Tasks</h4>
      {#each t.tasks as task (task.id)}
        <div class="ld-step"><small><code>{task.bookingTarget}</code> — {task.title} <span class="tbadge">{task.status}</span></small></div>
      {/each}
    </div>
  {/if}

  <div class="settings-group">
    <h4>🤖 KI-Vorschlag</h4>
    <div class="ld-oib-target">
      <select bind:value={aiTenantChoice[t.id]}>
        <option value="">— kein Tenant-Abgleich —</option>
        {#each $tenants as tn (tn.id)}<option value={tn.id}>{tn.name}</option>{/each}
      </select>
      <button class="btn btn-secondary" onclick={() => requestAiSuggestion(t.id)} disabled={aiLoading[t.id]}>
        {aiLoading[t.id] ? 'Analysiere…' : '🤖 KI-Vorschlag anfordern'}
      </button>
    </div>
    <div class="ld-step"><small>Ohne Tenant-Auswahl wird nur der Ticket-Text analysiert (keine Annahmen gegen Live-Daten geprueft).</small></div>

    {#if aiError[t.id]}
      <div class="ld-banner fail">❌ {aiError[t.id]}</div>
    {:else if aiResult[t.id]}
      {@const s = aiResult[t.id]}
      <div class="ld-phase complete" style="margin-top:0.5rem;">
        <div class="ld-phase-title">🎯 Vermutete Ursache</div>
        <div class="ld-step">{s.rootCause}</div>
      </div>
      {#if s.assumptions && s.assumptions.length}
        <div class="settings-group">
          <h4>Annahmen-Abgleich</h4>
          {#each s.assumptions as a}
            <div class="ld-step {VERDICT_CLASS[a.verdict] || 'warn'}">
              <span class="ld-ico">{VERDICT_ICON[a.verdict] || '❔'}</span>
              <strong>{a.claim}</strong> <small>— {a.reasoning}</small>
            </div>
          {/each}
        </div>
      {/if}
      {#if s.steps && s.steps.length}
        <div class="settings-group">
          <h4>Vorgeschlagene Schritte</h4>
          <ol style="margin:0 0 0 1.2rem; line-height:1.7; font-size:0.9rem;">
            {#each s.steps as step}<li>{step}</li>{/each}
          </ol>
        </div>
      {/if}
      <div class="ld-step"><small>{s.automatable ? '🤖' : 'ℹ️'} {s.automatableReason}</small></div>
      {#if aiSavedRunbookId[t.id]}
        <div class="ld-banner ok" style="margin-top:0.5rem;">💾 Als KI-Runbook gespeichert (siehe Tab „📚 Runbooks").</div>
      {/if}
    {/if}
  </div>
{/snippet}

<section class="settings-section">
  <h2>🎫 Tickets — SDP-Ticket-Copilot</h2>
  <div class="alert alert-info">
    <strong>ℹ️ So funktioniert es:</strong> Ticket-ID aus ServiceDesk Plus eingeben → kompletter Verlauf inkl.
    Notizen und Anhänge. Der API-Key bleibt im Backend (<code>SDP_API_KEY</code>) — landet nie im Browser.
  </div>

  {#if !$session.online}
    <div class="alert alert-warning"><strong>⚠️ Backend nicht erreichbar.</strong></div>
  {:else if !$session.loggedIn}
    <div class="alert alert-warning">
      <strong>🔒 Nicht angemeldet.</strong> Oben rechts im Header auf <strong>Anmelden</strong> klicken.
    </div>
  {:else}
    <div class="dl-subtabs">
      <button type="button" class="dl-subtab" class:active={sub === 'single'} onclick={() => switchSub('single')}>🎫 Einzelticket</button>
      <button type="button" class="dl-subtab" class:active={sub === 'batch'} onclick={() => switchSub('batch')}>📋 Batch</button>
      <button type="button" class="dl-subtab" class:active={sub === 'runbooks'} onclick={() => switchSub('runbooks')}>📚 Runbooks</button>
    </div>

    <div class="dl-panel" class:active={sub === 'single'}>
      <div class="dl-toolbar">
        <input type="text" class="dl-search" placeholder="Ticket-ID, z.B. 12345" bind:value={singleId}
               onkeydown={(e) => e.key === 'Enter' && loadSingle()} />
        <button class="btn btn-primary" onclick={loadSingle} disabled={singleLoading || !singleId.trim()}>
          {singleLoading ? 'Lade…' : 'Laden'}
        </button>
      </div>

      {#if singleLoading}
        <div class="ld-job"><div class="ld-step running"><span class="ld-spinner"></span> Lade Ticket…</div></div>
      {:else if singleError}
        <div class="ld-job"><div class="ld-banner fail">❌ {singleError}</div></div>
      {:else if singleTicket}
        {@const t = singleTicket}
        <div class="ld-job">
          <div class="ld-job-head"><strong>🎫 #{t.id} — {t.subject}</strong>
            <span class="ld-job-meta">
              <span class="tbadge {statusClass(t.status)}">{t.status}</span>
              <span class="tbadge">{t.priority}</span>
            </span>
          </div>
          {@render ticketDetail(t)}
        </div>
      {/if}
    </div>

    <div class="dl-panel" class:active={sub === 'batch'}>
      <div class="input-group" style="max-width:640px;">
        <label for="batchIds">Ticket-IDs (Komma- oder zeilengetrennt, max. 25)</label>
        <textarea id="batchIds" rows="3" bind:value={batchInput} placeholder={"12345\n12346, 12347"}></textarea>
      </div>
      <button class="btn btn-primary" onclick={loadBatch} disabled={batchLoading || !batchInput.trim()}>
        {batchLoading ? 'Lade…' : 'Alle laden'}
      </button>

      {#if batchLoading}
        <div class="ld-job"><div class="ld-step running"><span class="ld-spinner"></span> Lade Tickets…</div></div>
      {:else if batchError}
        <div class="ld-job"><div class="ld-banner fail">❌ {batchError}</div></div>
      {:else if batchResults.length}
        <table class="da-table">
          <thead>
            <tr><th>Ticket</th><th>Status</th><th>Priorität</th><th class="da-col-toggle"></th></tr>
          </thead>
          <tbody>
            {#each batchResults as r (r.id)}
              {@const isOpen = !!batchExpanded[r.id]}
              {#if r.ok}
                {@const t = r.ticket}
                <tr class="da-row" class:open={isOpen} role="button" tabindex="0"
                    onclick={() => toggleBatchExpand(r.id)}
                    onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleBatchExpand(r.id) } }}>
                  <td class="da-col-domain">🎫 #{t.id} — {t.subject}</td>
                  <td><span class="tbadge {statusClass(t.status)}">{t.status}</span></td>
                  <td><span class="tbadge">{t.priority}</span></td>
                  <td class="da-col-toggle">{isOpen ? '▾' : '▸'}</td>
                </tr>
                {#if isOpen}
                  <tr class="da-detail-row"><td colspan="4">{@render ticketDetail(t)}</td></tr>
                {/if}
              {:else}
                <tr class="da-row">
                  <td class="da-col-domain">🎫 #{r.id}</td>
                  <td colspan="3"><span class="tbadge warn">❌ {r.error}</span></td>
                </tr>
              {/if}
            {/each}
          </tbody>
        </table>
      {/if}
    </div>

    <div class="dl-panel" class:active={sub === 'runbooks'}>
      <div class="alert alert-info">
        <strong>ℹ️ Was ist das?</strong> Jeder KI-Vorschlag, der gegen einen konkreten Tenant geprueft wurde
        (Tenant-Auswahl bei „KI-Vorschlag anfordern"), wird hier automatisch gesammelt — inkl. Kennzeichnung,
        ob die KI die Aktion als potenziell automatisierbar einschaetzt.
      </div>
      <button class="btn btn-secondary" style="padding:0.3rem 0.7rem; font-size:0.8rem;" onclick={loadRunbooks}>🔄 Neu laden</button>

      {#if runbooksLoading}
        <div class="ld-job"><div class="ld-step running"><span class="ld-spinner"></span> Lade Runbooks…</div></div>
      {:else if runbooksError}
        <div class="ld-job"><div class="ld-banner fail">❌ {runbooksError}</div></div>
      {:else if !runbooks.length}
        <div class="ld-job"><div class="ld-banner warn">⚠️ Noch keine Runbooks gespeichert.</div></div>
      {:else}
        <table class="da-table">
          <thead>
            <tr><th>Ticket</th><th>Tenant</th><th>Erstellt</th><th></th><th class="da-col-toggle"></th></tr>
          </thead>
          <tbody>
            {#each runbooks as rb (rb.id)}
              {@const isOpen = !!runbookExpanded[rb.id]}
              <tr class="da-row" class:open={isOpen} role="button" tabindex="0"
                  onclick={() => toggleRunbookExpand(rb.id)}
                  onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleRunbookExpand(rb.id) } }}>
                <td class="da-col-domain">🎫 #{rb.ticketId} — {rb.ticketSubject}</td>
                <td>{rb.tenantName}</td>
                <td><small>{new Date(rb.createdAt).toLocaleString('de-CH')}</small></td>
                <td>{#if rb.suggestion?.automatable}<span class="tbadge ok">🤖 automatisierbar</span>{:else}<span class="tbadge">manuell</span>{/if}</td>
                <td class="da-col-toggle">{isOpen ? '▾' : '▸'}</td>
              </tr>
              {#if isOpen}
                <tr class="da-detail-row">
                  <td colspan="5">
                    <div class="ld-phase complete">
                      <div class="ld-phase-title">🎯 Vermutete Ursache</div>
                      <div class="ld-step">{rb.suggestion.rootCause}</div>
                    </div>
                    {#if rb.suggestion.assumptions?.length}
                      <div class="settings-group">
                        <h4>Annahmen-Abgleich</h4>
                        {#each rb.suggestion.assumptions as a}
                          <div class="ld-step {VERDICT_CLASS[a.verdict] || 'warn'}">
                            <span class="ld-ico">{VERDICT_ICON[a.verdict] || '❔'}</span>
                            <strong>{a.claim}</strong> <small>— {a.reasoning}</small>
                          </div>
                        {/each}
                      </div>
                    {/if}
                    {#if rb.suggestion.steps?.length}
                      <div class="settings-group">
                        <h4>Vorgeschlagene Schritte</h4>
                        <ol style="margin:0 0 0 1.2rem; line-height:1.7; font-size:0.9rem;">
                          {#each rb.suggestion.steps as step}<li>{step}</li>{/each}
                        </ol>
                      </div>
                    {/if}
                    <div class="ld-step"><small>{rb.suggestion.automatable ? '🤖' : 'ℹ️'} {rb.suggestion.automatableReason}</small></div>
                    <button class="btn btn-secondary" style="padding:0.25rem 0.7rem; font-size:0.8rem; margin-top:0.5rem;"
                            onclick={(e) => { e.stopPropagation(); removeRunbook(rb.id) }}>🗑️ Loeschen</button>
                  </td>
                </tr>
              {/if}
            {/each}
          </tbody>
        </table>
      {/if}
    </div>
  {/if}
</section>
