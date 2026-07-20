<script>
  import { apiGet } from '../lib/api.js'
  import { activeTenant } from '../lib/tenantStore.js'
  import TenantContext from '../lib/TenantContext.svelte'

  let loading = $state(false)
  let loadError = $state(null)
  let data = $state(null)
  let lastTenantId = null

  $effect(() => {
    const id = $activeTenant?.id ?? null
    if (id !== lastTenantId) {
      lastTenantId = id
      data = null; loadError = null
      if (id) load()
    }
  })

  async function load() {
    if (!$activeTenant) return
    loading = true
    loadError = null
    try {
      data = await apiGet(`/api/tenants/${encodeURIComponent($activeTenant.id)}/licenses`)
    } catch (e) {
      loadError = e.message
    }
    loading = false
  }

  const paidSkus = $derived((data?.skus || []).filter(s => !s.free))
  const freeSkus = $derived((data?.skus || []).filter(s => s.free))

  function esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }

  function pdfHtml() {
    const d = data
    const t = $activeTenant
    const today = new Date().toLocaleDateString('de-CH', { year: 'numeric', month: '2-digit', day: '2-digit' })
    const skuRows = paidSkus.map(s =>
      `<tr><td class="pn">${esc(s.name)}</td><td class="num">${s.purchased}</td><td class="num">${s.assigned}</td>` +
      `<td class="num ${s.available > 0 ? 'warn' : 'ok'}">${s.available}</td><td>${esc(s.capabilityStatus)}</td></tr>`).join('')
    const disRows = d.findings.disabledWithLicense.map(u =>
      `<tr><td class="pn">${esc(u.displayName)}</td><td>${esc(u.upn)}</td><td>${esc(u.licenses.join(', '))}</td></tr>`).join('')
    const inactRows = (d.findings.inactiveWithLicense || []).map(u =>
      `<tr><td class="pn">${esc(u.displayName)}</td><td>${esc(u.upn)}</td>` +
      `<td>${u.lastSignIn ? esc(u.lastSignIn) + ` (${u.daysInactive} Tage)` : 'nie angemeldet'}</td>` +
      `<td>${esc(u.licenses.join(', '))}</td></tr>`).join('')
    // Nur die handlungsrelevanten Kombis ins PDF — normale Suite+Add-on-Kombis
    // (verdict "addon") verwirren im Report nur und bleiben draussen.
    const verdictLabel = { redundant: '🔴 doppelt bezahlt', check: '🟠 prüfen' }
    const multiActionable = d.findings.multiSuite.filter(u => u.verdict !== 'addon')
    const multiAddonCount = d.findings.multiSuite.length - multiActionable.length
    const multiRows = multiActionable.map(u =>
      `<tr><td class="pn">${esc(u.displayName)}</td><td>${esc(u.upn)}</td><td>${esc(u.licenses.join(' + '))}</td>` +
      `<td>${esc(verdictLabel[u.verdict] || '')}${u.reason ? '<br><span class="dim">' + esc(u.reason) + '</span>' : ''}</td></tr>`).join('')

    return `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Lizenzreport — ${esc(t.name)}</title><style>
      * { margin:0; padding:0; box-sizing:border-box; }
      body { font-family:"Segoe UI",-apple-system,sans-serif; font-size:10pt; line-height:1.55; color:#1a1a1a; background:#e8e8e8; }
      .page { max-width:820px; margin:24px auto; background:#fff; padding:40px 48px; box-shadow:0 2px 14px rgba(0,0,0,.18); border-radius:4px; }
      h1 { font-size:17pt; margin-bottom:2px; }
      h2 { font-size:12.5pt; margin:20px 0 6px; border-bottom:1.5px solid #ccc; padding-bottom:3px; }
      .lead { color:#555; font-size:9.5pt; margin-bottom:12px; }
      .kpis { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; margin:12px 0 4px; }
      .kpi { border:1px solid #e2e2e2; border-radius:7px; padding:8px 10px; }
      .kpi b { display:block; font-size:15pt; }
      .kpi span { font-size:8.6pt; color:#666; }
      .kpi.warn b { color:#b54708; }
      .kpi.bad b { color:#b42318; }
      table { width:100%; border-collapse:collapse; margin:6px 0 12px; font-size:9.3pt; }
      th, td { text-align:left; vertical-align:top; padding:5px 8px; border-bottom:1px solid #e2e2e2; }
      th { background:#f3f3f3; font-weight:600; border-bottom:1.5px solid #bbb; }
      td.num { text-align:right; font-variant-numeric:tabular-nums; }
      td.warn { color:#b54708; font-weight:700; }
      td.ok { color:#067647; }
      td.pn { font-weight:600; }
      .note { font-size:9.2pt; color:#555; border-left:3px solid #bbb; padding:5px 10px; margin:8px 0; background:#fafafa; }
      .dim { color:#777; font-size:8.6pt; font-weight:400; }
      .empty { color:#067647; font-size:9.4pt; margin:4px 0 10px; }
      footer { margin-top:24px; padding-top:8px; border-top:1px solid #ccc; font-size:8.7pt; color:#777; }
      .print-btn { position:fixed; top:16px; right:16px; z-index:9; background:#1a1a1a; color:#fff; border:none; padding:10px 16px; border-radius:8px; font-size:13px; font-weight:600; cursor:pointer; box-shadow:0 3px 10px rgba(0,0,0,.3); }
      tr, p, li, .note, .kpi { break-inside:avoid; page-break-inside:avoid; }
      table { break-inside:avoid; page-break-inside:avoid; }
      thead { display:table-header-group; }
      h1, h2 { break-after:avoid; page-break-after:avoid; break-inside:avoid; }
      .kpis { break-inside:avoid; page-break-inside:avoid; }
      @media print { body { background:#fff; } .no-print { display:none !important; } .page { box-shadow:none; margin:0; max-width:none; border-radius:0; padding:0; } }
      @page { size:A4; margin:16mm; }
    </style></head><body>
    <button class="no-print print-btn" onclick="window.print()">📄 Als PDF speichern / Drucken</button>
    <div class="page">
      <h1>Lizenzreport &amp; Optimierungspotenzial</h1>
      <p class="lead">${esc(t.name)} · ${esc(t.organization || t.tenantId)} · Stand ${today}</p>
      <div class="kpis">
        <div class="kpi"><b>${d.totals.licensedUsers}</b><span>lizenzierte Benutzer (von ${d.totals.users})</span></div>
        <div class="kpi ${d.totals.freeSeats ? 'warn' : ''}"><b>${d.totals.freeSeats}</b><span>bezahlte, freie Seats</span></div>
        <div class="kpi ${d.totals.disabledWithLicense ? 'bad' : ''}"><b>${d.totals.disabledWithLicense}</b><span>Lizenzen an deaktivierten Konten</span></div>
        <div class="kpi ${d.totals.inactiveWithLicense ? 'warn' : ''}"><b>${d.totals.inactiveWithLicense ?? '–'}</b><span>lizenzierte Konten &gt;${d.inactiveDays} Tage inaktiv</span></div>
      </div>

      <h2>Lizenzbestand (bezahlte SKUs)</h2>
      <table><thead><tr><th>Produkt</th><th style="text-align:right">gekauft</th><th style="text-align:right">zugewiesen</th><th style="text-align:right">frei</th><th>Status</th></tr></thead>
      <tbody>${skuRows}</tbody></table>

      <h2>Handlungsfeld 1 — Lizenzen an deaktivierten Konten</h2>
      ${disRows ? `<p class="note">Diese Konten sind gesperrt, belegen aber weiterhin bezahlte Lizenzen. Empfehlung: Lizenz entziehen (Postfach vorher ggf. in ein freigegebenes Postfach umwandeln oder per Exportregelung sichern).</p><table><thead><tr><th>Name</th><th>Anmeldename</th><th>Lizenzen</th></tr></thead><tbody>${disRows}</tbody></table>` : '<p class="empty">✓ Keine — alle bezahlten Lizenzen haengen an aktiven Konten.</p>'}

      <h2>Handlungsfeld 2 — Inaktive lizenzierte Konten (&gt;${d.inactiveDays} Tage)</h2>
      ${d.signInAvailable
        ? (inactRows ? `<p class="note">Kein Sign-in (interaktiv oder nicht-interaktiv) seit mehr als ${d.inactiveDays} Tagen. Empfehlung: Klaeren, ob das Konto noch gebraucht wird — sonst Lizenz entziehen.</p><table><thead><tr><th>Name</th><th>Anmeldename</th><th>Letzter Sign-in</th><th>Lizenzen</th></tr></thead><tbody>${inactRows}</tbody></table>` : '<p class="empty">✓ Keine — alle lizenzierten Konten waren in den letzten ' + d.inactiveDays + ' Tagen aktiv.</p>')
        : '<p class="note">Sign-in-Daten nicht verfuegbar (braucht AuditLog.Read.All + Entra ID P1 im Tenant) — dieses Handlungsfeld konnte nicht geprueft werden.</p>'}

      <h2>Handlungsfeld 3 — Freie bezahlte Seats</h2>
      ${d.findings.unusedPaidSeats.length ? `<p class="note">Gekaufte, aber niemandem zugewiesene Lizenzen. Empfehlung: beim naechsten Renewal reduzieren, falls kein kurzfristiger Bedarf besteht.</p><table><thead><tr><th>Produkt</th><th style="text-align:right">gekauft</th><th style="text-align:right">zugewiesen</th><th style="text-align:right">frei</th></tr></thead><tbody>${d.findings.unusedPaidSeats.map(s => `<tr><td class="pn">${esc(s.name)}</td><td class="num">${s.purchased}</td><td class="num">${s.assigned}</td><td class="num warn">${s.available}</td></tr>`).join('')}</tbody></table>` : '<p class="empty">✓ Keine — jeder gekaufte Seat ist zugewiesen.</p>'}

      <h2>Handlungsfeld 4 — Mehrfach-Lizenzierung</h2>
      ${multiRows
        ? `<p class="note">Nur handlungsrelevante Kombinationen: 🔴 = die Suite enthaelt die Zusatzlizenz bereits (doppelt bezahlt, kuendbar) · 🟠 = mehrere Basis-Suiten, Ueberlappung pruefen.${multiAddonCount ? ` ${multiAddonCount} uebliche Suite+Add-on-Kombination(en) (z.B. E3 + Teams Phone) sind korrekt lizenziert und hier bewusst nicht aufgefuehrt.` : ''}</p><table><thead><tr><th>Name</th><th>Anmeldename</th><th>Lizenzen</th><th>Bewertung</th></tr></thead><tbody>${multiRows}</tbody></table>`
        : `<p class="empty">✓ Keine doppelt bezahlten oder ueberlappenden Lizenzkombinationen.${multiAddonCount ? ` (${multiAddonCount} uebliche Suite+Add-on-Kombination(en) sind korrekt lizenziert und nicht aufgefuehrt.)` : ''}</p>`}

      <footer>Erzeugt vom M365 Security Policy Manager am ${today}. Read-only-Report ohne Preisdaten — Seats und Konten sind belastbar aus Microsoft Graph gelesen (subscribedSkus, users inkl. signInActivity), Kostenbewertung erfolgt bewusst nicht automatisch.</footer>
    </div></body></html>`
  }

  function openPdf() {
    if (!data) return
    const w = window.open('', '_blank')
    if (!w) { alert('Der Browser hat das Dokument-Fenster blockiert. Bitte Pop-ups für diese Seite erlauben.'); return }
    w.document.open(); w.document.write(pdfHtml()); w.document.close()
    setTimeout(() => { try { w.focus(); w.print() } catch (e) {} }, 400)
  }
</script>

<TenantContext>
  <div class="settings-group">
    <h4>💰 Lizenzen &amp; Optimierung</h4>
    <p class="ld-section-hint">Read-only-Lizenzreport: Bestand, freie bezahlte Seats, Lizenzen an deaktivierten oder inaktiven Konten, Mehrfach-Lizenzierung. Bewusst ohne Fantasie-Preisrechnung — die Seats und Konten sind belastbar.</p>
    <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
      <button class="btn btn-secondary" onclick={load} disabled={loading}>{loading ? '…' : '🔄 Neu laden'}</button>
      <button class="btn btn-primary" onclick={openPdf} disabled={!data}>📄 Report als PDF</button>
    </div>
  </div>

  {#if loading}
    <div class="ld-job"><div class="ld-step running"><span class="ld-spinner"></span> Lese SKUs und Benutzer-Lizenzen aus dem Tenant…</div></div>
  {:else if loadError}
    <div class="ld-job">
      <div class="ld-banner fail">❌ {loadError}</div>
      <div class="ld-step"><small>💡 Braucht Organization.Read.All + AuditLog.Read.All — im Tab „🏢 Tenants" einmal 🔧 Reparieren ausführen.</small></div>
    </div>
  {:else if data}
    <div class="ld-setup-list" style="margin-bottom:1rem;">
      <span class="ld-badge ok">👥 {data.totals.licensedUsers}/{data.totals.users} lizenziert</span>
      <span class="ld-badge {data.totals.freeSeats ? 'warn' : 'ok'}">💺 {data.totals.freeSeats} bezahlte Seats frei</span>
      <span class="ld-badge {data.totals.disabledWithLicense ? 'warn' : 'ok'}">🚫 {data.totals.disabledWithLicense} an deaktivierten Konten</span>
      <span class="ld-badge {data.totals.inactiveWithLicense ? 'warn' : 'ok'}">😴 {data.totals.inactiveWithLicense ?? '–'} inaktiv &gt;{data.inactiveDays}d</span>
      <span class="ld-badge {data.totals.multiSuite ? 'warn' : 'ok'}">📚 {data.totals.multiSuite} Lizenz-Überlappungen</span>
    </div>

    <div class="ld-job" style="margin-bottom:1.25rem;">
      <div class="ld-job-head"><strong>📦 Lizenzbestand</strong>
        <span class="ld-job-meta">{paidSkus.length} bezahlte SKUs{freeSkus.length ? ` · ${freeSkus.length} kostenlose` : ''}</span></div>
      {#each paidSkus as s (s.skuPartNumber)}
        <div class="ld-step {s.available > 0 ? 'retry' : 'ok'}">
          <span class="ld-ico">{s.available > 0 ? '⚠️' : '✅'}</span>
          <strong>{s.name}</strong>
          <small> — {s.assigned}/{s.purchased} zugewiesen{s.available > 0 ? `, ${s.available} frei bezahlt` : ''}{s.capabilityStatus !== 'Enabled' ? ` · ${s.capabilityStatus}` : ''}</small>
        </div>
      {/each}
      {#each freeSkus as s (s.skuPartNumber)}
        <div class="ld-step pending"><span class="ld-ico">○</span> {s.name} <small>(kostenlos — {s.assigned} zugewiesen)</small></div>
      {/each}
    </div>

    <div class="ld-job" style="margin-bottom:1.25rem;">
      <div class="ld-job-head"><strong>🚫 Lizenzen an deaktivierten Konten</strong>
        <span class="ld-job-meta">{data.findings.disabledWithLicense.length}</span></div>
      {#if data.findings.disabledWithLicense.length}
        {#each data.findings.disabledWithLicense as u (u.upn)}
          <div class="ld-step fail"><span class="ld-ico">🚫</span> {u.displayName} <small>({u.upn}) — {u.licenses.join(', ')}</small></div>
        {/each}
        <div class="ld-step"><small>💡 Lizenz entziehen; Postfach vorher ggf. in ein freigegebenes Postfach umwandeln.</small></div>
      {:else}
        <div class="ld-banner ok">✅ Keine bezahlten Lizenzen an deaktivierten Konten.</div>
      {/if}
    </div>

    <div class="ld-job" style="margin-bottom:1.25rem;">
      <div class="ld-job-head"><strong>😴 Inaktive lizenzierte Konten (&gt;{data.inactiveDays} Tage)</strong>
        <span class="ld-job-meta">{data.findings.inactiveWithLicense ? data.findings.inactiveWithLicense.length : '–'}</span></div>
      {#if !data.signInAvailable}
        <div class="ld-banner warn">⚠️ Sign-in-Daten nicht verfügbar (braucht AuditLog.Read.All + Entra ID P1 im Tenant) — einmal 🔧 Reparieren ausführen und neu laden.</div>
      {:else if data.findings.inactiveWithLicense.length}
        {#each data.findings.inactiveWithLicense as u (u.upn)}
          <div class="ld-step retry"><span class="ld-ico">😴</span> {u.displayName}
            <small>({u.upn}) — {u.lastSignIn ? `zuletzt ${u.lastSignIn}, ${u.daysInactive} Tage` : 'nie angemeldet'} — {u.licenses.join(', ')}</small></div>
        {/each}
      {:else}
        <div class="ld-banner ok">✅ Alle lizenzierten Konten waren in den letzten {data.inactiveDays} Tagen aktiv.</div>
      {/if}
    </div>

    <div class="ld-job">
      <div class="ld-job-head"><strong>📚 Mehrfach-Lizenzierung</strong>
        <span class="ld-job-meta">{data.totals.multiSuite ?? data.findings.multiSuite.length} prüfenswert · {data.findings.multiSuite.length} gesamt</span></div>
      {#if data.findings.multiSuite.length}
        {#each data.findings.multiSuite as u (u.upn)}
          {#if u.verdict === 'redundant'}
            <div class="ld-step fail"><span class="ld-ico">🔴</span> {u.displayName}
              <small>({u.upn}) — {u.licenses.join(' + ')} · <b>doppelt bezahlt:</b> {u.reason}</small></div>
          {:else if u.verdict === 'check'}
            <div class="ld-step retry"><span class="ld-ico">🟠</span> {u.displayName}
              <small>({u.upn}) — {u.licenses.join(' + ')} · {u.reason}</small></div>
          {:else}
            <div class="ld-step ok"><span class="ld-ico">🟢</span> {u.displayName}
              <small>({u.upn}) — {u.licenses.join(' + ')} · notwendiges Add-on (nicht in der Suite enthalten), kein Handlungsbedarf</small></div>
          {/if}
        {/each}
        <div class="ld-step"><small>💡 🔴 = die Suite enthält die Zusatzlizenz bereits (kündbar) · 🟠 = mehrere Suiten, Überlappung prüfen · 🟢 = übliche Suite+Add-on-Kombi (z.B. E3 + Teams Phone — Teams Phone ist erst in E5 enthalten).</small></div>
      {:else}
        <div class="ld-banner ok">✅ Keine Konten mit mehreren bezahlten Produkten.</div>
      {/if}
    </div>
  {/if}
</TenantContext>
