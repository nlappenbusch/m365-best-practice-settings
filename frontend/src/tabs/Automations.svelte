<script>
  import { apiGet, apiPost, errText } from '../lib/api.js'
  import { activeTenant } from '../lib/tenantStore.js'
  import { activeTab } from '../lib/tabStore.js'
  import { session } from '../lib/session.js'
  import TenantContext from '../lib/TenantContext.svelte'
  import { fmtDateTime, ageLabel } from '../lib/product.js'

  let status = $state(null)
  let templates = $state([])
  let jobs = $state([])
  let loading = $state(false)
  let error = $state(null)
  let notice = $state(null)
  let templateId = $state('')
  let action = $state('evidence')
  let payloadText = $state('{}')
  let remoteTask = $state(null)
  let loadedFor = $state(null)

  let localJobs = $derived(jobs.filter(j => !$activeTenant || j.tenantId === $activeTenant.id).slice(0,12))
  let running = $derived(localJobs.filter(j => j.status === 'running').length)

  async function load() {
    if (!$session.loggedIn || loading) return
    loading = true; error = null
    try {
      const [s, j] = await Promise.all([
        apiGet('/api/execution/status'),
        apiGet('/api/appjobs')
      ])
      status = s
      jobs = j.jobs || []
      if (s.semaphore?.configured) {
        const t = await apiGet('/api/execution/templates')
        templates = t.templates || []
        if (!templateId && templates.length) templateId = String(templates[0].id)
      } else {
        templates = []
      }
      loadedFor = $activeTenant?.id || '_global'
    } catch (e) { error = errText(e) }
    loading = false
  }

  function terminal(s) {
    return ['success','failed','error','stopped','cancelled','canceled'].includes(String(s || '').toLowerCase())
  }

  function pollRemote(id) {
    setTimeout(async () => {
      try {
        const r = await apiGet(`/api/execution/tasks/${encodeURIComponent(id)}`)
        remoteTask = r.task
        if (!terminal(remoteTask?.status)) { pollRemote(id); return }
        notice = `Semaphore-Task ${id}: ${remoteTask?.status || 'beendet'}`
        await load()
      } catch (e) { error = errText(e) }
    }, 1500)
  }

  async function runSemaphore() {
    error = null; notice = null
    if (!$activeTenant) { error = 'Zuerst einen Tenant wählen.'; return }
    if (!templateId) { error = 'Semaphore-Template wählen.'; return }
    let payload
    try { payload = payloadText.trim() ? JSON.parse(payloadText) : {} }
    catch { error = 'Payload ist kein gültiges JSON.'; return }

    try {
      const r = await apiPost('/api/execution/run', {
        templateId: Number(templateId),
        tenantId: $activeTenant.id,
        action,
        payload
      })
      remoteTask = r.task
      const id = remoteTask?.id ?? remoteTask?.task_id
      notice = id != null ? `Semaphore-Task ${id} gestartet.` : 'Semaphore-Task gestartet.'
      if (id != null) pollRemote(id)
    } catch (e) { error = errText(e) }
  }

  $effect(() => {
    if ($activeTab !== 'automations' || !$session.loggedIn) return
    const k = $activeTenant?.id || '_global'
    if (loadedFor === k) return
    loadedFor = null
    load()
  })
</script>

<TenantContext>
  <div class="auto">
    <div class="auto-head">
      <div>
        <div class="auto-eyebrow">EXECUTION CONTROL</div>
        <h2>Automationen & Runner</h2>
        <p>Fachlogik bleibt im M365 Control Plane. Ausführung kann lokal oder über Semaphore laufen.</p>
      </div>
      <button class="btn btn-secondary" onclick={load} disabled={loading}>{loading ? 'Lade…' : '↻ Aktualisieren'}</button>
    </div>

    {#if error}<div class="alert alert-warning">{error}</div>{/if}
    {#if notice}<div class="ld-banner ok">{notice}</div>{/if}

    <div class="auto-status">
      <div class="auto-engine ok">
        <div><span class="auto-dot"></span><strong>Local Execution</strong></div>
        <p>Bestehende Graph-, PowerShell-, Maester- und Intune-Jobs bleiben aktiv.</p>
        <small>{running} laufende Job{running === 1 ? '' : 's'} für diesen Tenant</small>
      </div>
      <div class="auto-engine" class:ok={status?.semaphore?.configured} class:off={!status?.semaphore?.configured}>
        <div><span class="auto-dot"></span><strong>Semaphore UI</strong></div>
        <p>{status?.semaphore?.configured ? 'Verbunden als optionale Execution Engine.' : 'Optional: Runner, Schedules, PowerShell und Terraform/OpenTofu auslagern.'}</p>
        <small>{status?.semaphore?.configured ? `Projekt ${status.semaphore.projectId} · ${templates.length} Templates` : 'SEMAPHORE_URL / API_TOKEN / PROJECT_ID nicht gesetzt'}</small>
      </div>
    </div>

    <div class="auto-grid">
      <section class="auto-card">
        <div class="auto-card-head">
          <div><span class="auto-eyebrow">RUN HISTORY</span><h3>Lokale Jobs</h3></div>
          <span>{localJobs.length}</span>
        </div>
        {#if localJobs.length}
          <div class="auto-list">
            {#each localJobs as j (j.id)}
              <div class="auto-job">
                <span class="auto-state {j.status}"></span>
                <div>
                  <strong>{j.phase || j.appGroupName || j.tenantName || 'Job'}</strong>
                  <small>{j.status} · {j.startedAt ? fmtDateTime(j.startedAt) : '—'}{j.finishedAt ? ' · fertig ' + ageLabel(j.finishedAt) : ''}</small>
                </div>
                <code>{j.id.slice(0,8)}</code>
              </div>
            {/each}
          </div>
        {:else}
          <div class="auto-empty">Keine Jobs für diesen Tenant im In-Memory-Verlauf.</div>
        {/if}
      </section>

      <section class="auto-card">
        <div class="auto-card-head">
          <div><span class="auto-eyebrow">SEMAPHORE</span><h3>Extern ausführen</h3></div>
          <span>{status?.semaphore?.configured ? 'bereit' : 'optional'}</span>
        </div>

        {#if status?.semaphore?.configured}
          <div class="auto-form">
            <label>Template
              <select bind:value={templateId}>
                {#each templates as t}
                  <option value={String(t.id)}>{t.name}{t.app ? ' · ' + t.app : ''}</option>
                {/each}
              </select>
            </label>
            <label>Aktion
              <select bind:value={action}>
                <option value="evidence">Evidence / Read</option>
                <option value="maester">Security Audit</option>
                <option value="terraform-plan">Terraform Plan</option>
                <option value="terraform-apply">Terraform Apply</option>
                <option value="powershell">PowerShell Operation</option>
              </select>
            </label>
            <label>Payload JSON
              <textarea rows="5" bind:value={payloadText} spellcheck="false"></textarea>
            </label>
            <div class="auto-note">
              Tenant, Organisation, Akteur und Payload werden als JSON-Envelope an den Semaphore-Task übergeben.
              Das Template liest ihn aus <code>SEMAPHORE_TASK_DETAILS_MESSAGE</code>.
            </div>
            <button class="btn btn-primary" onclick={runSemaphore} disabled={!templateId}>Task starten</button>
          </div>

          {#if remoteTask}
            <div class="auto-remote">
              <strong>Letzter externer Task</strong>
              <div><span>Status</span><b>{remoteTask.status || 'gestartet'}</b></div>
              <div><span>ID</span><code>{remoteTask.id ?? remoteTask.task_id ?? '—'}</code></div>
              {#if remoteTask.start}<div><span>Start</span><b>{fmtDateTime(remoteTask.start)}</b></div>{/if}
              {#if remoteTask.end}<div><span>Ende</span><b>{fmtDateTime(remoteTask.end)}</b></div>{/if}
            </div>
          {/if}
        {:else}
          <div class="auto-empty">
            <strong>Semaphore ist bewusst optional.</strong>
            <span>Ohne Konfiguration funktioniert das bestehende Produkt unverändert. Nach dem Setzen der drei Variablen erscheinen hier die Templates.</span>
          </div>
        {/if}
      </section>
    </div>

    <section class="auto-card auto-architecture">
      <div><span>M365 Control Plane</span><b>entscheidet</b></div>
      <i>→</i>
      <div><span>Execution Adapter</span><b>routet</b></div>
      <i>→</i>
      <div><span>Local / Semaphore</span><b>führt aus</b></div>
      <i>→</i>
      <div><span>Graph / PowerShell / Terraform</span><b>ändert oder liest</b></div>
      <i>→</i>
      <div><span>Evidence</span><b>belegt</b></div>
    </section>
  </div>
</TenantContext>

<style>
  .auto{display:flex;flex-direction:column;gap:.9rem}
  .auto-head{display:flex;justify-content:space-between;align-items:flex-start;gap:1rem}
  .auto-head h2{margin:.15rem 0 .25rem;font-size:1.45rem;letter-spacing:-.02em}.auto-head p{margin:0;color:var(--text-dim)}
  .auto-eyebrow{font-size:.68rem;letter-spacing:.12em;color:var(--text-faint);font-weight:800}
  .auto-status{display:grid;grid-template-columns:1fr 1fr;gap:.7rem}
  .auto-engine{border:1px solid var(--rule);border-radius:var(--radius-lg);padding:.85rem .95rem;background:var(--bg-raised)}
  .auto-engine>div{display:flex;align-items:center;gap:.45rem}.auto-engine p{margin:.35rem 0 .2rem;color:var(--text-dim);font-size:.82rem}.auto-engine small{color:var(--text-faint)}
  .auto-dot{width:8px;height:8px;border-radius:999px;background:var(--text-faint)}.auto-engine.ok .auto-dot{background:var(--ok)}.auto-engine.off{opacity:.8}
  .auto-grid{display:grid;grid-template-columns:1fr 1fr;gap:.8rem}
  .auto-card{border:1px solid var(--rule);border-radius:var(--radius-lg);padding:.95rem;background:var(--bg-raised);box-shadow:var(--shadow-sm)}
  .auto-card-head{display:flex;justify-content:space-between;align-items:flex-start;gap:.8rem;margin-bottom:.65rem}.auto-card-head h3{margin:.1rem 0 0;font-size:1rem}.auto-card-head>span{font-size:.7rem;color:var(--text-faint)}
  .auto-list{display:flex;flex-direction:column}.auto-job{display:grid;grid-template-columns:10px minmax(0,1fr) auto;gap:.55rem;align-items:center;padding:.55rem 0;border-top:1px solid var(--rule)}.auto-job:first-child{border-top:0}
  .auto-job strong,.auto-job small{display:block}.auto-job small{font-size:.72rem;color:var(--text-dim);margin-top:.1rem}.auto-job code{font-size:.7rem;color:var(--text-faint)}
  .auto-state{width:7px;height:7px;border-radius:999px;background:var(--text-faint)}.auto-state.running{background:var(--warn)}.auto-state.done,.auto-state.success{background:var(--ok)}.auto-state.failed,.auto-state.error{background:var(--crit)}
  .auto-form{display:flex;flex-direction:column;gap:.55rem}.auto-form label{display:flex;flex-direction:column;gap:.2rem;font-size:.75rem;color:var(--text-dim)}
  .auto-form select,.auto-form textarea{border:1px solid var(--rule);border-radius:var(--radius-sm);background:var(--bg-inset);color:var(--text);padding:.45rem .55rem;font:inherit;font-size:.82rem}.auto-form textarea{font-family:var(--font-mono);resize:vertical}
  .auto-note{font-size:.74rem;color:var(--text-dim);line-height:1.45;padding:.55rem .65rem;background:var(--accent-wash);border-radius:var(--radius-sm)}.auto-note code{font-family:var(--font-mono)}
  .auto-remote{margin-top:.75rem;padding:.65rem;border:1px solid var(--rule);border-radius:var(--radius-sm);display:flex;flex-direction:column;gap:.3rem;font-size:.78rem}.auto-remote>div{display:grid;grid-template-columns:70px 1fr;gap:.5rem}.auto-remote span{color:var(--text-dim)}
  .auto-empty{display:flex;flex-direction:column;gap:.35rem;padding:.75rem;border:1px dashed var(--rule);border-radius:var(--radius-sm);color:var(--text-dim);font-size:.82rem}.auto-empty strong{color:var(--text)}
  .auto-architecture{display:flex;gap:.55rem;align-items:center;justify-content:center;overflow-x:auto}.auto-architecture>div{min-width:135px;padding:.55rem;background:var(--bg-inset);border-radius:var(--radius-sm);text-align:center}.auto-architecture span,.auto-architecture b{display:block}.auto-architecture span{font-size:.75rem;font-weight:700}.auto-architecture b{font-size:.66rem;color:var(--text-dim);margin-top:.1rem}.auto-architecture i{color:var(--text-faint);font-style:normal}
  @media(max-width:900px){.auto-grid,.auto-status{grid-template-columns:1fr}.auto-architecture{justify-content:flex-start}}
  @media(max-width:650px){.auto-head{flex-direction:column}.auto-architecture{flex-direction:column;align-items:stretch}.auto-architecture i{text-align:center;transform:rotate(90deg)}}
</style>
