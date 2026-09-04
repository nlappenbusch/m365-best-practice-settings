// Bestandsaufnahme als eigenstaendige HTML-Datei — zum Weitergeben oder als
// PDF drucken. Bewusst ohne externe Ressourcen (siehe reportDoc.js).
//
// Anders als reportDoc.js (nur Kennzahlen): hier sind die LISTEN der eigentliche
// Zweck — eine Bestandsaufnahme ohne die vollstaendige Liste aller Postfaecher/
// Geraete waere nur ein Befund, kein Bestand.

const ICON = { ok: '&#10003;', warn: '!', crit: '&#10007;' }

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function metricRow(m) {
  return `<tr class="${esc(m.state)}">
    <td class="ico">${ICON[m.state] || ''}</td>
    <td class="lbl">${esc(m.label)}</td>
    <td class="val">${esc(m.value ?? '—')}</td>
    <td class="det">${esc(m.detail || '')}</td>
  </tr>`
}

function listTable(l) {
  return `<div class="list-block">
    <h3>${esc(l.label)} <span class="count">(${l.rows.length}${l.more ? ` von ${l.rows.length + l.more}` : ''})</span></h3>
    <table class="data">
      <thead><tr>${l.columns.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>${l.rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody>
    </table>
    ${l.more ? `<p class="hint">… und ${l.more} weitere (Liste gekappt).</p>` : ''}
  </div>`
}

export function buildInventoryHtml(inventory) {
  const date = new Date(inventory.generatedAt)
  const dateStr = date.toLocaleString('de-CH')
  const s = inventory.summary || { crit: 0, warn: 0, ok: 0, failedSections: [] }

  const sections = Object.entries(inventory.sections || {}).map(([id, sec]) => {
    if (!sec.ok) {
      return `<section><h2>${esc(sec.label)}</h2>
        <p class="fail">Nicht abrufbar: ${esc(sec.error)}</p>
        <p class="hint">Meist fehlt dafür eine Berechtigung oder eine Lizenz im Tenant.</p></section>`
    }
    return `<section><h2>${esc(sec.label)}</h2>
      <table class="metrics">${(sec.metrics || []).map(metricRow).join('')}</table>
      ${(sec.lists || []).map(listTable).join('\n')}
    </section>`
  }).join('\n')

  const failed = (s.failedSections || []).length
    ? `<p class="hint">Nicht auswertbar: ${esc((s.failedSections || []).join(', '))}</p>`
    : ''

  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8" />
<title>M365-Bestandsaufnahme — ${esc(inventory.tenantName)}</title>
<style>
  :root { --rule:#e1e5ec; --dim:#5b6472; --crit:#c6334b; --warn:#a15e06; --ok:#1f9d63; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", system-ui, sans-serif; color:#1b2430; line-height:1.5;
         max-width: 1100px; margin: 2rem auto; padding: 0 1.5rem; }
  header { border-bottom: 3px solid #2b5fe2; padding-bottom: 1rem; margin-bottom: 1.5rem; }
  h1 { font-size: 1.5rem; margin: 0 0 .3rem; }
  .meta { color: var(--dim); font-size: .85rem; }
  .counts { display: flex; gap: 1rem; margin: 1.25rem 0; flex-wrap: wrap; }
  .count { border: 1px solid var(--rule); border-radius: 8px; padding: .6rem 1rem; min-width: 7rem; }
  .count b { display: block; font-size: 1.6rem; line-height: 1.1; }
  .count.crit b { color: var(--crit); } .count.warn b { color: var(--warn); } .count.ok b { color: var(--ok); }
  section { margin: 2rem 0; page-break-inside: avoid; }
  h2 { font-size: 1.15rem; border-bottom: 1px solid var(--rule); padding-bottom: .3rem; margin-bottom: .5rem; }
  h3 { font-size: .95rem; margin: 1rem 0 .4rem; }
  .count-label, .list-block .count { color: var(--dim); font-weight: normal; font-size: .85rem; }
  table.metrics { width: 100%; border-collapse: collapse; font-size: .9rem; }
  table.metrics td { padding: .35rem .5rem; border-bottom: 1px solid var(--rule); vertical-align: top; }
  table.metrics td.ico { width: 1.5rem; font-weight: bold; }
  table.metrics td.val { width: 6rem; text-align: right; font-variant-numeric: tabular-nums; }
  table.metrics td.det { color: var(--dim); font-size: .82rem; }
  tr.crit td.ico { color: var(--crit); } tr.warn td.ico { color: var(--warn); } tr.ok td.ico { color: var(--ok); }
  table.data { width: 100%; border-collapse: collapse; font-size: .82rem; margin-bottom: .25rem; }
  table.data th { text-align: left; border-bottom: 2px solid var(--rule); padding: .3rem .45rem; white-space: nowrap; }
  table.data td { padding: .3rem .45rem; border-bottom: 1px solid var(--rule); }
  table.data tr:nth-child(even) { background: rgba(43,95,226,.03); }
  .fail { color: var(--crit); } .hint { color: var(--dim); font-size: .85rem; }
  footer { margin-top: 2.5rem; padding-top: 1rem; border-top: 1px solid var(--rule);
           color: var(--dim); font-size: .8rem; }
  @media print { body { margin: 0; max-width: none; } section { page-break-inside: auto; } }
</style></head>
<body>
<header>
  <h1>M365-Bestandsaufnahme</h1>
  <div class="meta"><strong>${esc(inventory.tenantName)}</strong>${inventory.organization ? ' · ' + esc(inventory.organization) : ''}<br />
  Stand: ${esc(dateStr)}</div>
</header>

<div class="counts">
  <div class="count crit"><b>${s.crit}</b>kritisch</div>
  <div class="count warn"><b>${s.warn}</b>Hinweise</div>
  <div class="count ok"><b>${s.ok}</b>unauffällig</div>
</div>
${failed}

${sections}

<footer>
  Erzeugt mit dem igeeks M365 Security Policy Manager. Die Zahlen sind eine Momentaufnahme zum
  angegebenen Zeitpunkt und ausschliesslich lesend erhoben — es wurde nichts am Tenant verändert.
</footer>
</body></html>`
}
