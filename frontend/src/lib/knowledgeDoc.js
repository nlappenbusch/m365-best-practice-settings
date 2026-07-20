// Generischer Druck-Wrapper fuers Wissen: dieselbe HTML-Sektion, die im Tab
// per {@html} angezeigt wird, wird hier nur mit Kopf/Meta/Fusszeile umrahmt
// und per window.print() als PDF speicherbar gemacht (gleiches Muster wie
// configDoc.js/Audit.svelte — kein PDF-Lib, echter Vektor-Text).
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}

export function openKnowledgeDoc({ title, lead, meta, bodyHtml, footerNote }) {
  const now = new Date()
  const dateStr = now.toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric' })
  const metaHtml = (meta || []).map(([k, v]) => '<div><b>' + esc(k) + ':</b> ' + esc(v) + '</div>').join('')
  const html = `<!DOCTYPE html><html lang="de"><head><meta charset="utf-8">
<title>${esc(title)} — M365 Security Policy Manager</title>
<style>${knowledgeDocCss()}</style></head><body>
<button class="no-print print-btn" onclick="window.print()">📘 Als PDF speichern / Drucken</button>
<div class="page">
<div class="doc-head">
  <h1>${esc(title)}</h1>
  <p class="lead">${esc(lead)}</p>
  <div class="meta">
    <div><b>Erstellt am:</b> ${dateStr}</div>
    <div><b>Quelle:</b> M365 Security Policy Manager — Wissen</div>
    ${metaHtml}
  </div>
</div>
${bodyHtml}
<footer>Automatisch erzeugt vom M365 Security Policy Manager · ${dateStr}${footerNote ? ' · ' + esc(footerNote) : ''}</footer>
</div></body></html>`

  const w = window.open('', '_blank')
  if (!w) {
    alert('Der Browser hat das Dokument-Fenster blockiert. Bitte Pop-ups für diese Seite erlauben und erneut klicken.')
    return
  }
  w.document.open()
  w.document.write(html)
  w.document.close()
  setTimeout(() => { try { w.focus(); w.print() } catch (e) { /* egal */ } }, 400)
}

function knowledgeDocCss() {
  return `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: "Segoe UI", system-ui, -apple-system, Arial, sans-serif; color: #1a1a1a; font-size: 10.3pt; line-height: 1.55; background: #f2f4f7; }
  .page { max-width: 900px; margin: 24px auto; background: #fff; padding: 34px 40px 44px; box-shadow: 0 2px 18px rgba(16,24,40,.12); border-radius: 6px; }
  h1 { font-size: 19pt; font-weight: 700; margin: 0 0 2px; letter-spacing: -0.01em; }
  .lead { font-size: 10.3pt; color: #555; margin: 0 0 14px; }
  .doc-head { border-bottom: 3px solid #1a1a1a; padding-bottom: 12px; margin-bottom: 6px; }
  .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 24px; font-size: 9.3pt; color: #333; margin-top: 10px; }
  .meta div { border-bottom: 1px solid #eee; padding: 2px 0; }
  .meta b { color: #000; font-weight: 600; }
  h3 { font-size: 12.5pt; font-weight: 700; margin: 20px 0 8px; padding-bottom: 4px; border-bottom: 2px solid #1a1a1a; break-after: avoid; break-before: page; }
  h3:first-of-type { break-before: avoid; }
  h4 { font-size: 10.6pt; font-weight: 700; margin: 12px 0 5px; break-after: avoid; }
  p { margin: 0 0 8px; }
  ul, ol { margin: 0 0 10px 1.2rem; }
  li { margin: 2px 0; }
  table { width: 100%; border-collapse: collapse; margin: 6px 0 12px; font-size: 9.3pt; }
  th, td { text-align: left; vertical-align: top; padding: 5px 8px; border-bottom: 1px solid #e2e2e2; }
  th { background: #f3f3f3; font-weight: 600; border-bottom: 1.5px solid #bbb; }
  tr { break-inside: avoid; page-break-inside: avoid; }
  /* Saubere Seitenumbrueche: nie mitten in Absaetzen/Listenpunkten/Tabellen/
     Hinweisboxen brechen; bricht eine Tabelle doch (laenger als eine Seite),
     wiederholt thead den Kopf. Ueberschriften nie verwaist am Seitenende. */
  p, li, .note, .alert-box, pre { break-inside: avoid; page-break-inside: avoid; }
  table { break-inside: avoid; page-break-inside: avoid; }
  thead { display: table-header-group; }
  h1, h2, h3, h4 { break-after: avoid; page-break-after: avoid; break-inside: avoid; }
  code, .mono { font-family: Consolas, monospace; font-size: 9.2pt; background: #f4f4f4; padding: 0 3px; border-radius: 2px; }
  pre { font-family: Consolas, monospace; font-size: 8.6pt; line-height: 1.5; background: #1e293b; color: #e2e8f0; padding: 10px 14px; border-radius: 6px; margin: 8px 0 12px; overflow-x: auto; white-space: pre; }
  .note, .alert-box { font-size: 9.2pt; color: #444; border-left: 3px solid #bbb; padding: 6px 10px; margin: 8px 0; background: #fafafa; }
  .alert-box.warn { border-left-color: #b54708; background: #fffaeb; }
  .alert-box.info { border-left-color: #3538cd; background: #eff4ff; }
  .badge { display: inline-block; font-size: 8.6pt; font-weight: 700; padding: 1px 7px; border-radius: 20px; }
  .badge.hoch { background: #fef3f2; color: #b42318; }
  .badge.mittel { background: #fffaeb; color: #b54708; }
  .badge.gering { background: #ecfdf3; color: #067647; }
  .section { break-inside: avoid-page; }
  footer { margin-top: 26px; padding-top: 8px; border-top: 1px solid #ccc; font-size: 8.7pt; color: #777; }
  .print-btn { position: fixed; top: 16px; right: 16px; z-index: 9; background: #1a1a1a; color: #fff; border: none; padding: 10px 16px; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; box-shadow: 0 3px 10px rgba(0,0,0,.3); }
  @media print { body { background: #fff; } .no-print { display: none !important; } .page { box-shadow: none; margin: 0; max-width: none; border-radius: 0; padding: 0; } h3 { break-before: auto; } }
  @page { size: A4; margin: 16mm; }
  `
}
