<script>
  // KI-Dienste: beliebig viele Anbieter hinterlegen und je Zweck zuweisen
  // (erster = Standard, weitere = Ausweichdienst). Keys sieht die Oberfläche nie,
  // nur «hinterlegt …abcd».
  import { apiGet, apiPost, apiPut, apiDelete, errText } from './api.js'

  let v = $state(null)
  let err = $state(null)
  let msg = $state(null)
  let form = $state(null)          // Bearbeiten/Neu
  let busy = $state({})

  async function load() {
    try { v = await apiGet('/api/ai/providers') } catch (e) { err = errText(e) }
  }
  load()

  function blank(type) {
    const t = v.types[type]
    return { id: null, type, label: t.label.replace(/ \(.*\)$/, ''), model: t.defaultModel, baseUrl: '', deployment: '', apiVersion: '2024-10-21', note: '', key: '', enabled: true }
  }
  function edit(p) { form = { ...p, key: '' }; msg = null }

  async function save() {
    busy = { ...busy, save: true }; msg = null
    try {
      const r = await apiPost('/api/ai/providers', form)
      v = r; form = null
      msg = { ok: true, text: 'Gespeichert. Mit «Testen» prüfen, ob der Dienst antwortet.' }
    } catch (e) { msg = { ok: false, text: errText(e) } }
    busy = { ...busy, save: false }
  }
  async function remove(p) {
    if (!confirm(`KI-Dienst «${p.label}» entfernen? Zuweisungen zu diesem Dienst entfallen.`)) return
    try { v = await apiDelete(`/api/ai/providers/${encodeURIComponent(p.id)}`) } catch (e) { msg = { ok: false, text: errText(e) } }
  }
  async function testIt(p) {
    busy = { ...busy, [p.id]: true }; msg = null
    try {
      const r = await apiPost(`/api/ai/providers/${encodeURIComponent(p.id)}/test`)
      v = r
      msg = r.result.ok ? { ok: true, text: `«${p.label}» antwortet (${r.result.ms} ms, ${r.result.model || 'Modell ok'}).` } : { ok: false, text: `«${p.label}»: ${r.result.error}` }
    } catch (e) { msg = { ok: false, text: errText(e) } }
    busy = { ...busy, [p.id]: false }
  }
  async function assign(purpose, idx, id) {
    const cur = [...(v.assign[purpose] || [])]
    if (id) cur[idx] = id; else cur.splice(idx, 1)
    const clean = cur.filter((x, i) => x && cur.indexOf(x) === i)
    try { v = await apiPut(`/api/ai/assign/${encodeURIComponent(purpose)}`, { providers: clean }) } catch (e) { msg = { ok: false, text: errText(e) } }
  }
  const active = $derived((v?.providers || []).filter(p => p.enabled))
  const nameOf = id => (v?.providers || []).find(p => p.id === id)?.label || id
</script>

<section class="aip">
  <div class="aih">
    <div>
      <h3>KI-Dienste</h3>
      <p class="dim">Mehrere Anbieter nach Wahl — je Aufgabe ein Standard-Dienst und optional Ausweichdienste, falls einer nicht antwortet. An die KI gehen nur Kennzahlen und Produktnamen der Tenants, keine Benutzernamen oder Inhalte.</p>
    </div>
    {#if v}
      <div class="add">
        <select onchange={e => { if (e.currentTarget.value) { form = blank(e.currentTarget.value); msg = null } e.currentTarget.value = '' }}>
          <option value="">+ KI-Dienst hinzufügen…</option>
          {#each Object.entries(v.types) as [k, t]}<option value={k}>{t.label}</option>{/each}
        </select>
      </div>
    {/if}
  </div>
  {#if err}<div class="alert alert-warning">{err}</div>{/if}

  {#if form && v}
    {@const t = v.types[form.type]}
    <div class="aiform">
      <h4>{form.id ? 'KI-Dienst bearbeiten' : 'Neuer KI-Dienst'} · {t.label}</h4>
      <div class="g">
        <label>Name<input bind:value={form.label} placeholder="z. B. OpenAI (Firma)" /></label>
        {#if form.type !== 'azure-openai'}<label>Modell<input bind:value={form.model} placeholder={t.defaultModel || 'z. B. llama3.1:8b'} /></label>{/if}
        {#if t.fields.includes('baseUrl')}<label class="w2">{form.type === 'azure-openai' ? 'Endpoint' : 'Adresse der Gegenstelle'}<input bind:value={form.baseUrl} placeholder={form.type === 'azure-openai' ? 'https://<name>.openai.azure.com' : 'http://ollama:11434/v1 · https://openrouter.ai/api/v1'} /></label>{/if}
        {#if form.type === 'azure-openai'}
          <label>Deployment<input bind:value={form.deployment} placeholder="gpt-4o-mini" /></label>
          <label>API-Version<input bind:value={form.apiVersion} /></label>
        {/if}
        <label class="w2">API-Key {form.id && form.hasKey ? `(hinterlegt ${form.keyHint} — leer lassen = unverändert)` : t.needsKey ? '' : '(optional)'}
          <input type="password" autocomplete="off" bind:value={form.key} placeholder={t.needsKey ? 'Key einfügen' : 'nur falls die Gegenstelle einen verlangt'} /></label>
        <label class="w2">Notiz<input bind:value={form.note} placeholder="z. B. Datenstandort EU, Vertrag bis 2027, lokal im Rechenzentrum" /></label>
        <label class="chk"><input type="checkbox" bind:checked={form.enabled} /> aktiv</label>
      </div>
      <div class="row">
        <button class="btn btn-primary" disabled={busy.save} onclick={save}>{busy.save ? 'Speichere…' : 'Speichern'}</button>
        <button class="btn btn-secondary" onclick={() => form = null}>Abbrechen</button>
      </div>
    </div>
  {/if}

  {#if v}
    {#if v.providers.length}
      <div class="tw"><table>
        <thead><tr><th>Dienst</th><th>Anbieter · Modell</th><th>Key</th><th>Letzter Test</th><th></th></tr></thead>
        <tbody>{#each v.providers as p}
          <tr class:off={!p.enabled}>
            <td><b>{p.label}</b>{#if !p.enabled} <span class="dim">(inaktiv)</span>{/if}{#if p.note}<br><span class="dim small">{p.note}</span>{/if}</td>
            <td>{p.typeLabel}<br><code>{p.model || p.deployment || '—'}</code>{#if p.baseUrl}<br><span class="dim small">{p.baseUrl}</span>{/if}</td>
            <td>{p.builtin ? 'aus Umgebung' : p.hasKey ? 'hinterlegt ' + p.keyHint : '—'}</td>
            <td>{#if p.lastTest}<span class:okt={p.lastTest.ok} class:bad={!p.lastTest.ok} title={p.lastTest.error || ''}>{p.lastTest.ok ? '✓ ok' : '✕ Fehler'}</span> <span class="dim small">{new Date(p.lastTest.at).toLocaleString('de-CH', { dateStyle: 'short', timeStyle: 'short' })}</span>{:else}<span class="dim">—</span>{/if}</td>
            <td class="act">
              <button class="btn btn-secondary" disabled={busy[p.id]} onclick={() => testIt(p)}>{busy[p.id] ? 'Teste…' : 'Testen'}</button>
              {#if !p.builtin}<button class="btn btn-secondary" onclick={() => edit(p)}>Bearbeiten</button><button class="btn btn-secondary" onclick={() => remove(p)}>Entfernen</button>{/if}
            </td>
          </tr>
        {/each}</tbody>
      </table></div>
    {:else}
      <div class="empty">Noch kein KI-Dienst. Oben einen hinzufügen — z. B. OpenAI, Azure OpenAI, Anthropic, Google Gemini, Mistral oder ein lokales Modell über Ollama.</div>
    {/if}

    {#if v.providers.length}
      <h4 class="sh">Zuweisung je Aufgabe</h4>
      <div class="assign">
        {#each Object.entries(v.purposes) as [pk, pl]}
          {@const list = v.assign[pk] || []}
          <div class="as">
            <b>{pl}</b>
            {#each [...list, null] as id, i}
              {#if i < 3}
                <label class="dim small">{i === 0 ? 'Standard' : `Ausweich ${i}`}
                  <select value={id || ''} onchange={e => assign(pk, i, e.currentTarget.value)}>
                    <option value="">{i === 0 && !list.length ? `automatisch (${active[0]?.label || 'keiner'})` : '—'}</option>
                    {#each active as p}<option value={p.id}>{p.label}</option>{/each}
                  </select>
                </label>
              {/if}
            {/each}
            {#if !list.length}<span class="dim small">Ohne Zuweisung: alle aktiven Dienste der Reihe nach{active.length ? ` (zuerst ${nameOf(active[0].id)})` : ''}.</span>{/if}
          </div>
        {/each}
      </div>
    {/if}
  {/if}
  {#if msg}<div class:okt={msg.ok} class:bad={!msg.ok} class="small">{msg.text}</div>{/if}
</section>

<style>
  .aip{display:flex;flex-direction:column;gap:.7rem}
  .aih{display:flex;justify-content:space-between;gap:1rem;align-items:flex-start;flex-wrap:wrap}
  .aih h3{margin:0 0 .2rem;font-size:1rem}.aih p{margin:0;font-size:.76rem;max-width:70ch}
  .add select,.aiform input,.as select{font:inherit;font-size:.82rem;padding:.4rem .55rem;border:1px solid var(--rule);border-radius:var(--radius-sm);background:var(--bg);color:var(--text)}
  .aiform{border:1px dashed var(--accent);background:var(--accent-wash);border-radius:var(--radius-md);padding:.8rem .9rem;display:flex;flex-direction:column;gap:.55rem}
  .aiform h4{margin:0;font-size:.9rem}
  .g{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.55rem .8rem}
  .g label{display:flex;flex-direction:column;gap:.2rem;font-size:.72rem;font-weight:700;color:var(--text-dim)}
  .g .w2{grid-column:1/-1}.g .chk{flex-direction:row;align-items:center;gap:.4rem}
  .row{display:flex;gap:.45rem;flex-wrap:wrap;align-items:center}
  .tw{overflow:auto}
  table{width:100%;border-collapse:collapse;font-size:.8rem}
  th{text-align:left;font-size:.64rem;text-transform:uppercase;letter-spacing:.06em;color:var(--text-faint);padding:.35rem .5rem;border-bottom:1px solid var(--rule)}
  td{padding:.45rem .5rem;border-bottom:1px solid var(--rule);vertical-align:top}
  tr.off td{opacity:.6}
  td.act{white-space:nowrap;text-align:right}td.act .btn{margin-left:.3rem;padding:.25rem .55rem;font-size:.74rem}
  code{font-size:.74rem}
  .sh{margin:.4rem 0 0;font-size:.82rem}
  .assign{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:.6rem}
  .as{display:flex;flex-direction:column;gap:.35rem;background:var(--bg-inset);border-radius:10px;padding:.6rem .7rem;font-size:.8rem}
  .as label{display:flex;flex-direction:column;gap:.15rem}
  .empty{border:1px dashed var(--rule);border-radius:var(--radius-md);padding:.9rem;color:var(--text-dim);font-size:.8rem}
  .dim{color:var(--text-dim)}.small{font-size:.72rem}.okt{color:var(--ok)}.bad{color:var(--crit)}
  @media(max-width:700px){.g{grid-template-columns:1fr}}
</style>
