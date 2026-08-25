<script>
  import { session } from '../lib/session.js'
  import { sdpApi } from '../lib/sdpTickets.js'
  import { tenants } from '../lib/tenantStore.js'
  import { apiGet, apiPost } from '../lib/api.js'
  import { goToTab } from '../lib/tabStore.js'

  let sub = $state('single') // 'single' | 'batch' | 'runbooks'

  // ---------- KI-Vorschlag (pro Ticket-ID, da im Batch mehrere gleichzeitig offen sein koennen) ----------
  let aiTenantChoice = $state({})  // ticketId -> tenantId
  let aiLoading = $state({})       // ticketId -> bool
  let aiError = $state({})         // ticketId -> string
  let aiResult = $state({})        // ticketId -> suggestion
  let aiSavedRunbookId = $state({}) // ticketId -> runbookId | null
  let aiAutoPreview = $state({})   // ticketId -> {ok, preview, groupId} | {ok:false, error} | null
  let aiConfirmBusy = $state({})
  let aiConfirmResult = $state({})
  let aiConfirmError = $state({})

  async function requestAiSuggestion(ticketId) {
    aiLoading = { ...aiLoading, [ticketId]: true }
    aiError = { ...aiError, [ticketId]: null }
    aiResult = { ...aiResult, [ticketId]: null }
    aiSavedRunbookId = { ...aiSavedRunbookId, [ticketId]: null }
    aiAutoPreview = { ...aiAutoPreview, [ticketId]: null }
    aiConfirmResult = { ...aiConfirmResult, [ticketId]: null }
    aiConfirmError = { ...aiConfirmError, [ticketId]: null }
    try {
      const r = await sdpApi.aiSuggest(ticketId, aiTenantChoice[ticketId])
      aiResult = { ...aiResult, [ticketId]: r.suggestion }
      aiSavedRunbookId = { ...aiSavedRunbookId, [ticketId]: r.runbookId || null }
      aiAutoPreview = { ...aiAutoPreview, [ticketId]: r.autoPreview || null }
    } catch (e) {
      aiError = { ...aiError, [ticketId]: e.message }
    }
    aiLoading = { ...aiLoading, [ticketId]: false }
  }

  // Ein Klick bestaetigt + rollt den bereits automatisch aufgeloesten Vorschlag
  // aus -- schreibt erst JETZT, nie vorher. tenantId kommt vom Ticket-Kontext
  // (aiTenantChoice), nicht aus dem Preview-Objekt (das enthaelt bewusst nur
  // die aufgeloeste Einstellung, keine Tenant-Referenz).
  async function confirmAutoPreview(ticketId, suggestion) {
    const ap = aiAutoPreview[ticketId]
    if (!ap || !ap.ok) return
    if (!confirm(`Policy „${ap.preview.settingDisplayName}" = ${ap.preview.resolvedOptionLabel} wirklich anlegen und der Pilot-Gruppe zuweisen?`)) return
    aiConfirmError = { ...aiConfirmError, [ticketId]: null }
    aiConfirmBusy = { ...aiConfirmBusy, [ticketId]: true }
    try {
      const tenantId = aiTenantChoice[ticketId]
      const r = await apiPost(`/api/tenants/${encodeURIComponent(tenantId)}/deploy/auto-setting`, {
        name: '', searchTerm: suggestion.automationSearchTerm, desiredLabel: suggestion.automationDesiredValue, groupId: ap.groupId
      })
      aiConfirmResult = { ...aiConfirmResult, [ticketId]: r.result }
    } catch (e) {
      aiConfirmError = { ...aiConfirmError, [ticketId]: e.message }
    }
    aiConfirmBusy = { ...aiConfirmBusy, [ticketId]: false }
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
    const opening = !runbookExpanded[id]
    runbookExpanded = { ...runbookExpanded, [id]: !runbookExpanded[id] }
    if (opening) {
      const rb = runbooks.find(r => r.id === id)
      if (rb && autoSearchTerm[id] === undefined) {
        autoSearchTerm = { ...autoSearchTerm, [id]: rb.suggestion?.automationSearchTerm || '' }
        autoDesiredValue = { ...autoDesiredValue, [id]: rb.suggestion?.automationDesiredValue || '' }
      }
    }
  }

  // ---------- Policy ausrollen (aus einem Runbook heraus, permission-gated) ----------
  // Zwei Modi: "auto" (Standard) sucht die Einstellung live per Suchbegriff in
  // Intune Settings Catalog und rollt sie direkt aus -- echte Automatisierung,
  // kein manuelles Exportieren/Einfuegen noetig. "manual" bleibt als Fallback
  // fuer Exoten, die sich nicht per Suchbegriff eindeutig finden lassen.
  let deployMode = $state({})       // runbookId -> 'auto' | 'manual'
  let deployGroups = $state({})     // tenantId -> [{id, displayName}]
  let deployGroupChoice = $state({}) // runbookId -> groupId
  let deployBusy = $state({})
  let deployError = $state({})
  let deployResult = $state({})

  let autoSearchTerm = $state({})   // runbookId -> string
  let autoDesiredValue = $state({}) // runbookId -> string
  let autoName = $state({})         // runbookId -> string (optional Policy-Name)
  let autoPreview = $state({})      // runbookId -> preview result | null
  let autoPreviewBusy = $state({})
  let autoPreviewError = $state({})

  let deployJsonText = $state({})   // runbookId -> string (manueller Modus)

  function modeOf(rbId) { return deployMode[rbId] || 'auto' }

  async function ensureDeployGroups(tenantId) {
    if (deployGroups[tenantId]) return
    try {
      const r = await apiGet(`/api/tenants/${encodeURIComponent(tenantId)}/groups`)
      deployGroups = { ...deployGroups, [tenantId]: r.groups || [] }
    } catch (e) {
      deployGroups = { ...deployGroups, [tenantId]: [] }
    }
  }

  async function previewAutoSetting(rb) {
    autoPreviewError = { ...autoPreviewError, [rb.id]: null }
    autoPreview = { ...autoPreview, [rb.id]: null }
    const searchTerm = (autoSearchTerm[rb.id] || '').trim()
    const desiredLabel = (autoDesiredValue[rb.id] || '').trim()
    if (!searchTerm || !desiredLabel) {
      autoPreviewError = { ...autoPreviewError, [rb.id]: 'Suchbegriff und gewünschter Wert erforderlich.' }
      return
    }
    autoPreviewBusy = { ...autoPreviewBusy, [rb.id]: true }
    try {
      const r = await apiPost(`/api/tenants/${encodeURIComponent(rb.tenantId)}/deploy/auto-setting/preview`, { searchTerm, desiredLabel })
      autoPreview = { ...autoPreview, [rb.id]: r.preview }
    } catch (e) {
      autoPreviewError = { ...autoPreviewError, [rb.id]: e.message }
    }
    autoPreviewBusy = { ...autoPreviewBusy, [rb.id]: false }
  }

  async function deployAutoSettingAction(rb) {
    const groupId = deployGroupChoice[rb.id]
    if (!groupId) { deployError = { ...deployError, [rb.id]: 'Bitte Ziel-Gruppe wählen.' }; return }
    if (!autoPreview[rb.id]) { deployError = { ...deployError, [rb.id]: 'Bitte zuerst „Vorschau" prüfen.' }; return }
    if (!confirm(`Policy „${autoPreview[rb.id].settingDisplayName}" = ${autoPreview[rb.id].resolvedOptionLabel} wirklich anlegen und der gewählten Gruppe zuweisen?`)) return

    deployError = { ...deployError, [rb.id]: null }
    deployResult = { ...deployResult, [rb.id]: null }
    deployBusy = { ...deployBusy, [rb.id]: true }
    try {
      const r = await apiPost(`/api/tenants/${encodeURIComponent(rb.tenantId)}/deploy/auto-setting`, {
        name: autoName[rb.id] || '', searchTerm: (autoSearchTerm[rb.id] || '').trim(),
        desiredLabel: (autoDesiredValue[rb.id] || '').trim(), groupId
      })
      deployResult = { ...deployResult, [rb.id]: r.result }
    } catch (e) {
      deployError = { ...deployError, [rb.id]: e.message }
    }
    deployBusy = { ...deployBusy, [rb.id]: false }
  }

  // Bestaetigt einen bereits vom Backend automatisch aufgeloesten Vorschlag
  // (rb.autoPreview) -- ein Klick, schreibt aber erst JETZT, nie vorher.
  async function confirmRunbookAutoPreview(rb) {
    if (!rb.autoPreview || !rb.autoPreview.ok) return
    if (!confirm(`Policy „${rb.autoPreview.preview.settingDisplayName}" = ${rb.autoPreview.preview.resolvedOptionLabel} wirklich anlegen und der Pilot-Gruppe zuweisen?`)) return
    deployError = { ...deployError, [rb.id]: null }
    deployResult = { ...deployResult, [rb.id]: null }
    deployBusy = { ...deployBusy, [rb.id]: true }
    try {
      const r = await apiPost(`/api/tenants/${encodeURIComponent(rb.tenantId)}/deploy/auto-setting`, {
        name: '', searchTerm: rb.suggestion.automationSearchTerm, desiredLabel: rb.suggestion.automationDesiredValue,
        groupId: rb.autoPreview.groupId
      })
      deployResult = { ...deployResult, [rb.id]: r.result }
    } catch (e) {
      deployError = { ...deployError, [rb.id]: e.message }
    }
    deployBusy = { ...deployBusy, [rb.id]: false }
  }

  async function deployCustomPolicy(rb) {
    deployError = { ...deployError, [rb.id]: null }
    deployResult = { ...deployResult, [rb.id]: null }
    let parsed
    try {
      parsed = JSON.parse(deployJsonText[rb.id] || '')
    } catch (e) {
      deployError = { ...deployError, [rb.id]: 'Ungültiges JSON: ' + e.message }
      return
    }
    const groupId = deployGroupChoice[rb.id]
    if (!groupId) { deployError = { ...deployError, [rb.id]: 'Bitte Ziel-Gruppe wählen.' }; return }
    deployBusy = { ...deployBusy, [rb.id]: true }
    try {
      const r = await apiPost(`/api/tenants/${encodeURIComponent(rb.tenantId)}/deploy/custom-policy`, { policyJson: parsed, groupId })
      deployResult = { ...deployResult, [rb.id]: r.result }
    } catch (e) {
      deployError = { ...deployError, [rb.id]: e.message }
    }
    deployBusy = { ...deployBusy, [rb.id]: false }
  }

  // ---------- Nutzer-Aktionen (aus einem Runbook heraus, permission-gated pro Aktion) ----------
  const USER_ACTION_LABELS = {
    resetMfa: { key: 'reset-mfa', icon: '🔓', label: 'MFA-Methoden entfernen' },
    resetPassword: { key: 'reset-password', icon: '🔑', label: 'Passwort zurücksetzen' },
    revokeSessions: { key: 'revoke-sessions', icon: '🚪', label: 'Sitzungen widerrufen' }
  }

  let actionUserQuery = $state({})    // runbookId -> string
  let actionUserResults = $state({})  // runbookId -> [{id, displayName, userPrincipalName}]
  let actionUserSearching = $state({})
  let actionSelectedUser = $state({}) // runbookId -> user object
  let actionGroupChoice = $state({})  // runbookId -> groupId
  let actionGroupMode = $state({})    // runbookId -> 'add' | 'remove'
  let actionBusy = $state({})         // runbookId -> actionKey while running
  let actionError = $state({})
  let actionResult = $state({})       // runbookId -> { actionKey, result }
  let actionSearchTimer = null

  function onActionUserInput(rbId, tenantId, value) {
    actionUserQuery = { ...actionUserQuery, [rbId]: value }
    actionSelectedUser = { ...actionSelectedUser, [rbId]: null }
    if (actionSearchTimer) clearTimeout(actionSearchTimer)
    actionSearchTimer = setTimeout(() => searchActionUser(rbId, tenantId), 350)
  }

  async function searchActionUser(rbId, tenantId) {
    const q = (actionUserQuery[rbId] || '').trim()
    if (q.length < 2) { actionUserResults = { ...actionUserResults, [rbId]: [] }; return }
    actionUserSearching = { ...actionUserSearching, [rbId]: true }
    try {
      const r = await apiGet(`/api/tenants/${encodeURIComponent(tenantId)}/conditionalaccess/users?q=${encodeURIComponent(q)}`)
      actionUserResults = { ...actionUserResults, [rbId]: r.users || r || [] }
    } catch (e) {
      actionUserResults = { ...actionUserResults, [rbId]: [] }
    }
    actionUserSearching = { ...actionUserSearching, [rbId]: false }
  }

  function pickActionUser(rbId, user) {
    actionSelectedUser = { ...actionSelectedUser, [rbId]: user }
    actionUserResults = { ...actionUserResults, [rbId]: [] }
    actionUserQuery = { ...actionUserQuery, [rbId]: user.displayName + ' (' + user.userPrincipalName + ')' }
  }

  async function runUserAction(rb, capKey) {
    const user = actionSelectedUser[rb.id]
    if (!user) { actionError = { ...actionError, [rb.id]: 'Bitte zuerst einen Nutzer auswählen.' }; return }
    const def = USER_ACTION_LABELS[capKey]
    if (capKey === 'groupMembership' && !actionGroupChoice[rb.id]) {
      actionError = { ...actionError, [rb.id]: 'Bitte Ziel-Gruppe wählen.' }
      return
    }
    if (!confirm(`„${def ? def.label : 'Gruppenmitgliedschaft ändern'}" für ${user.displayName} (${user.userPrincipalName}) wirklich ausführen?`)) return

    actionError = { ...actionError, [rb.id]: null }
    actionResult = { ...actionResult, [rb.id]: null }
    actionBusy = { ...actionBusy, [rb.id]: capKey }
    try {
      const routeKey = def ? def.key : 'group-membership'
      const body = { userId: user.id }
      if (capKey === 'groupMembership') { body.groupId = actionGroupChoice[rb.id]; body.action = actionGroupMode[rb.id] || 'add' }
      const r = await apiPost(`/api/tenants/${encodeURIComponent(rb.tenantId)}/user-actions/${routeKey}`, body)
      actionResult = { ...actionResult, [rb.id]: { capKey, result: r.result } }
    } catch (e) {
      actionError = { ...actionError, [rb.id]: e.message }
    }
    actionBusy = { ...actionBusy, [rb.id]: null }
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
      <h4>Anhänge ({t.attachments.length})</h4>
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
    <h4>Notizen {#if t.notesError}<small class="tbadge warn">Fehler: {t.notesError}</small>{/if}</h4>
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
      <h4>Tasks</h4>
      {#each t.tasks as task (task.id)}
        <div class="ld-step"><small><code>{task.bookingTarget}</code> — {task.title} <span class="tbadge">{task.status}</span></small></div>
      {/each}
    </div>
  {/if}

  <div class="settings-group">
    <h4>KI-Vorschlag</h4>
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
      <div class="ld-banner fail">{aiError[t.id]}</div>
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
        <div class="ld-banner ok" style="margin-top:0.5rem;">Als KI-Runbook gespeichert (siehe Tab „📚 Runbooks").</div>
      {/if}
      {#if aiConfirmResult[t.id]}
        {@const cr = aiConfirmResult[t.id]}
        <div class="ld-banner ok" style="margin-top:0.5rem;">„{cr.policyName}" angelegt und zugewiesen ({cr.assignStatus}).</div>
      {:else if aiAutoPreview[t.id]?.ok}
        {@const ap = aiAutoPreview[t.id]}
        <div class="ld-banner ok" style="margin-top:0.5rem;">Automatisch gefunden: „{ap.preview.settingDisplayName}" → wird gesetzt auf <strong>{ap.preview.resolvedOptionLabel}</strong>
          <br>
          <button class="btn btn-primary" style="margin-top:0.4rem;" disabled={aiConfirmBusy[t.id]}
                  onclick={() => confirmAutoPreview(t.id, s)}>
            {aiConfirmBusy[t.id] ? 'Rolle aus…' : '✅ Bestätigen & Ausrollen (Pilot-Gruppe)'}
          </button>
        </div>
        {#if aiConfirmError[t.id]}
          <div class="ld-banner fail" style="margin-top:0.4rem;">{aiConfirmError[t.id]}</div>
        {/if}
      {:else if aiAutoPreview[t.id] && !aiAutoPreview[t.id].ok}
        <div class="ld-banner warn" style="margin-top:0.5rem;">Automatische Auflösung nicht möglich: {aiAutoPreview[t.id].error} — bitte im Runbook manuell ausrollen.
        </div>
      {/if}
    {/if}
  </div>
{/snippet}

<section class="settings-section">
  <h2>Tickets — SDP-Ticket-Copilot</h2>
  <div class="alert alert-info">
    <strong>ℹ️ So funktioniert es:</strong> Ticket-ID aus ServiceDesk Plus eingeben → kompletter Verlauf inkl.
    Notizen und Anhänge. Der API-Key bleibt im Backend (<code>SDP_API_KEY</code>) — landet nie im Browser.
  </div>

  {#if !$session.online}
    <div class="alert alert-warning"><strong>Backend nicht erreichbar.</strong></div>
  {:else if !$session.loggedIn}
    <div class="alert alert-warning">
      <strong>Nicht angemeldet.</strong> Oben rechts im Header auf <strong>Anmelden</strong> klicken.
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
        <div class="ld-job"><div class="ld-banner fail">{singleError}</div></div>
      {:else if singleTicket}
        {@const t = singleTicket}
        <div class="ld-job">
          <div class="ld-job-head"><strong>#{t.id} — {t.subject}</strong>
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
        <div class="ld-job"><div class="ld-banner fail">{batchError}</div></div>
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
      <button class="btn btn-secondary" style="padding:0.3rem 0.7rem; font-size:0.8rem;" onclick={loadRunbooks}>Neu laden</button>

      {#if runbooksLoading}
        <div class="ld-job"><div class="ld-step running"><span class="ld-spinner"></span> Lade Runbooks…</div></div>
      {:else if runbooksError}
        <div class="ld-job"><div class="ld-banner fail">{runbooksError}</div></div>
      {:else if !runbooks.length}
        <div class="ld-job"><div class="ld-banner warn">Noch keine Runbooks gespeichert.</div></div>
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
                <td>
                  {#if rb.autoPreview?.ok}<span class="tbadge ok">🤖⚡ bereit zur Bestätigung</span>
                  {:else if rb.autoPreview && !rb.autoPreview.ok}<span class="tbadge warn">🤖⚡ Auflösung fehlgeschlagen</span>
                  {:else if rb.suggestion?.automatable}<span class="tbadge ok">🤖 automatisierbar</span>
                  {:else}<span class="tbadge">manuell</span>{/if}
                </td>
                <td class="da-col-toggle">{isOpen ? '▾' : '▸'}</td>
              </tr>
              {#if isOpen}
                {@const rbTenant = $tenants.find(x => x.id === rb.tenantId)}
                {@const permOk = !!rbTenant?.aiWritePermissions?.customPolicyImport}
                <tr class="da-detail-row">
                  <td colspan="5">
                    <div class="ld-phase complete">
                      <div class="ld-phase-title">🎯 Vermutete Ursache</div>
                      <div class="ld-step">{rb.suggestion.rootCause}</div>
                    </div>
                    {#if deployResult[rb.id]}
                      <div class="ld-banner ok">„{deployResult[rb.id].policyName}" angelegt und zugewiesen ({deployResult[rb.id].assignStatus}).
                      </div>
                    {:else if rb.autoPreview?.ok}
                      <div class="ld-banner ok">Automatisch gefunden: „{rb.autoPreview.preview.settingDisplayName}" → wird gesetzt auf
                        <strong>{rb.autoPreview.preview.resolvedOptionLabel}</strong>
                        <br>
                        <button class="btn btn-primary" style="margin-top:0.4rem;" disabled={deployBusy[rb.id]}
                                onclick={(e) => { e.stopPropagation(); confirmRunbookAutoPreview(rb) }}>
                          {deployBusy[rb.id] ? 'Rolle aus…' : '✅ Bestätigen & Ausrollen (Pilot-Gruppe)'}
                        </button>
                      </div>
                      {#if deployError[rb.id]}
                        <div class="ld-banner fail">{deployError[rb.id]}</div>
                      {/if}
                    {:else if rb.autoPreview && !rb.autoPreview.ok}
                      <div class="ld-banner warn">Automatische Auflösung fehlgeschlagen: {rb.autoPreview.error} — unten manuell ausrollen.</div>
                    {/if}
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

                    <div class="settings-group">
                      <h4>Policy ausrollen</h4>
                      {#if !rbTenant}
                        <div class="ld-banner warn">Tenant nicht mehr im Tool vorhanden.</div>
                      {:else if !permOk}
                        <div class="ld-banner warn">Für „{rbTenant.name}" nicht freigeschaltet.
                          <button class="btn btn-secondary" style="padding:0.2rem 0.6rem; font-size:0.78rem;"
                                  onclick={() => goToTab('tenants')}>Im Tenants-Tab freischalten →</button>
                        </div>
                      {:else}
                        <div class="dl-subtabs" style="margin-bottom:0.75rem;">
                          <button type="button" class="dl-subtab" class:active={modeOf(rb.id) === 'auto'}
                                  onclick={() => (deployMode = { ...deployMode, [rb.id]: 'auto' })}>🔍 Automatisch suchen</button>
                          <button type="button" class="dl-subtab" class:active={modeOf(rb.id) === 'manual'}
                                  onclick={() => (deployMode = { ...deployMode, [rb.id]: 'manual' })}>📋 Eigene JSON</button>
                        </div>

                        {#if modeOf(rb.id) === 'auto'}
                          <p class="ld-section-hint">
                            Sucht die Einstellung live in Intune Settings Catalog per Suchbegriff und legt die Policy
                            direkt an — kein manuelles Exportieren nötig. Funktioniert fuer einzelne ADMX-basierte
                            Windows/Browser-Einstellungen mit Enabled/Disabled-artigem Wert.
                          </p>
                          <div class="input-group" style="max-width:420px; margin-bottom:0.5rem;">
                            <label for="autoSearch-{rb.id}">Einstellung suchen</label>
                            <input id="autoSearch-{rb.id}" type="text" bind:value={autoSearchTerm[rb.id]}
                                   placeholder="z.B. Password manager" />
                          </div>
                          <div class="input-group" style="max-width:420px; margin-bottom:0.5rem;">
                            <label for="autoValue-{rb.id}">Gewünschter Wert</label>
                            <input id="autoValue-{rb.id}" type="text" bind:value={autoDesiredValue[rb.id]}
                                   placeholder="z.B. Disabled" />
                          </div>
                          <div class="input-group" style="max-width:420px; margin-bottom:0.5rem;">
                            <label for="autoName-{rb.id}">Policy-Name <small>(optional)</small></label>
                            <input id="autoName-{rb.id}" type="text" bind:value={autoName[rb.id]}
                                   placeholder="Standard: Auto: gefundene Einstellung" />
                          </div>
                          <button class="btn btn-secondary" disabled={autoPreviewBusy[rb.id]} onclick={() => previewAutoSetting(rb)}>
                            {autoPreviewBusy[rb.id] ? 'Suche…' : '🔍 Vorschau'}
                          </button>

                          {#if autoPreviewError[rb.id]}
                            <div class="ld-banner fail" style="margin-top:0.5rem;">{autoPreviewError[rb.id]}</div>
                          {:else if autoPreview[rb.id]}
                            {@const pv = autoPreview[rb.id]}
                            <div class="ld-banner ok" style="margin-top:0.5rem;">Gefunden: <strong>{pv.settingDisplayName}</strong> → wird gesetzt auf <strong>{pv.resolvedOptionLabel}</strong>
                              {#if pv.settingDescription}<br><small>{pv.settingDescription}</small>{/if}
                            </div>
                            <div class="ld-oib-target" style="margin-top:0.5rem;">
                              <select bind:value={deployGroupChoice[rb.id]} onfocus={() => ensureDeployGroups(rb.tenantId)}>
                                <option value="">— Ziel-Gruppe wählen (Pilot!) —</option>
                                {#each (deployGroups[rb.tenantId] || []) as g (g.id)}<option value={g.id}>{g.displayName}</option>{/each}
                              </select>
                              <button class="btn btn-primary" disabled={deployBusy[rb.id]} onclick={() => deployAutoSettingAction(rb)}>
                                {deployBusy[rb.id] ? 'Rolle aus…' : '🚀 Ausrollen'}
                              </button>
                            </div>
                          {/if}
                        {:else}
                          <p class="ld-section-hint">
                            Fallback fuer Einstellungen, die sich nicht per Suchbegriff eindeutig finden lassen: Policy
                            einmal manuell im Intune-Portal anlegen, per Graph exportieren
                            (<code>GET /deviceManagement/configurationPolicies/&#123;id&#125;?$expand=settings</code>)
                            und die JSON hier einfügen.
                          </p>
                          <div class="input-group" style="margin-bottom:0.6rem;">
                            <label for="deployJson-{rb.id}">Exportierte Policy-JSON</label>
                            <textarea id="deployJson-{rb.id}" rows="4" style="font-family:monospace; font-size:0.8rem;"
                                      bind:value={deployJsonText[rb.id]} placeholder={'{ "@odata.type": "#microsoft.graph.deviceManagementConfigurationPolicy", ... }'}></textarea>
                          </div>
                          <div class="ld-oib-target">
                            <select bind:value={deployGroupChoice[rb.id]} onfocus={() => ensureDeployGroups(rb.tenantId)}>
                              <option value="">— Ziel-Gruppe wählen —</option>
                              {#each (deployGroups[rb.tenantId] || []) as g (g.id)}<option value={g.id}>{g.displayName}</option>{/each}
                            </select>
                            <button class="btn btn-primary" disabled={deployBusy[rb.id]} onclick={() => deployCustomPolicy(rb)}>
                              {deployBusy[rb.id] ? 'Rolle aus…' : '🚀 Ausrollen'}
                            </button>
                          </div>
                        {/if}

                        {#if deployError[rb.id]}
                          <div class="ld-banner fail" style="margin-top:0.5rem;">{deployError[rb.id]}</div>
                        {:else if deployResult[rb.id]}
                          <div class="ld-banner ok" style="margin-top:0.5rem;">„{deployResult[rb.id].policyName}" angelegt und zugewiesen ({deployResult[rb.id].assignStatus}).</div>
                        {/if}
                      {/if}
                    </div>

                    {#if rbTenant && (rbTenant.aiWritePermissions?.resetMfa || rbTenant.aiWritePermissions?.resetPassword || rbTenant.aiWritePermissions?.revokeSessions || rbTenant.aiWritePermissions?.groupMembership)}
                      <div class="settings-group">
                        <h4>Nutzer-Aktionen</h4>
                        <div class="input-group" style="max-width:420px; position:relative; margin-bottom:0.6rem;">
                          <label for="actionUser-{rb.id}">Ziel-Nutzer suchen</label>
                          <input id="actionUser-{rb.id}" type="text" autocomplete="off"
                                 value={actionUserQuery[rb.id] || ''}
                                 oninput={(e) => onActionUserInput(rb.id, rb.tenantId, e.target.value)}
                                 placeholder="Name, UPN oder E-Mail …" />
                          {#if actionUserResults[rb.id]?.length}
                            <div class="dl-scroll" style="position:absolute; z-index:5; top:100%; left:0; right:0;
                                        background:var(--bg-elevated,#fff); border:1px solid var(--border,#ccc);
                                        border-radius:6px; max-height:200px; overflow-y:auto;">
                              {#each actionUserResults[rb.id] as u (u.id)}
                                <div class="dl-card dl-click" role="button" tabindex="0"
                                     onmousedown={() => pickActionUser(rb.id, u)}
                                     onkeydown={(e) => e.key === 'Enter' && pickActionUser(rb.id, u)}>
                                  <div class="dl-name">{u.displayName} <small>({u.userPrincipalName})</small></div>
                                </div>
                              {/each}
                            </div>
                          {/if}
                        </div>

                        {#if actionSelectedUser[rb.id]}
                          <div class="ld-step ok"><small>✓ Ausgewählt: {actionSelectedUser[rb.id].displayName} ({actionSelectedUser[rb.id].userPrincipalName})</small></div>

                          <div style="display:flex; flex-wrap:wrap; gap:0.5rem; margin:0.5rem 0;">
                            {#if rbTenant.aiWritePermissions?.resetMfa}
                              <button class="btn btn-secondary" disabled={!!actionBusy[rb.id]} onclick={() => runUserAction(rb, 'resetMfa')}>
                                {actionBusy[rb.id] === 'resetMfa' ? '…' : '🔓 MFA entfernen'}
                              </button>
                            {/if}
                            {#if rbTenant.aiWritePermissions?.resetPassword}
                              <button class="btn btn-secondary" disabled={!!actionBusy[rb.id]} onclick={() => runUserAction(rb, 'resetPassword')}>
                                {actionBusy[rb.id] === 'resetPassword' ? '…' : '🔑 Passwort zurücksetzen'}
                              </button>
                            {/if}
                            {#if rbTenant.aiWritePermissions?.revokeSessions}
                              <button class="btn btn-secondary" disabled={!!actionBusy[rb.id]} onclick={() => runUserAction(rb, 'revokeSessions')}>
                                {actionBusy[rb.id] === 'revokeSessions' ? '…' : '🚪 Sitzungen widerrufen'}
                              </button>
                            {/if}
                          </div>

                          {#if rbTenant.aiWritePermissions?.groupMembership}
                            <div class="ld-oib-target">
                              <select bind:value={actionGroupChoice[rb.id]} onfocus={() => ensureDeployGroups(rb.tenantId)}>
                                <option value="">— Gruppe wählen —</option>
                                {#each (deployGroups[rb.tenantId] || []) as g (g.id)}<option value={g.id}>{g.displayName}</option>{/each}
                              </select>
                              <select bind:value={actionGroupMode[rb.id]}>
                                <option value="add">hinzufügen</option>
                                <option value="remove">entfernen</option>
                              </select>
                              <button class="btn btn-secondary" disabled={!!actionBusy[rb.id]} onclick={() => runUserAction(rb, 'groupMembership')}>
                                {actionBusy[rb.id] === 'groupMembership' ? '…' : '👥 Ausführen'}
                              </button>
                            </div>
                          {/if}
                        {/if}

                        {#if actionError[rb.id]}
                          <div class="ld-banner fail">{actionError[rb.id]}</div>
                        {:else if actionResult[rb.id]}
                          {@const ar = actionResult[rb.id]}
                          {#if ar.capKey === 'resetPassword'}
                            <div class="ld-banner ok">Neues temporäres Passwort: <code>{ar.result.tempPassword}</code> (wird nur hier einmalig angezeigt).</div>
                          {:else if ar.capKey === 'resetMfa'}
                            <div class="ld-banner ok">{ar.result.removed.length} MFA-Methode(n) entfernt{ar.result.skipped.length ? `, ${ar.result.skipped.length} übersprungen` : ''}.</div>
                          {:else}
                            <div class="ld-banner ok">Aktion ausgeführt.</div>
                          {/if}
                        {/if}
                      </div>
                    {/if}

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
