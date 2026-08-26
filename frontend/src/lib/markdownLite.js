// Kompakter Markdown-Renderer für die Maester-Testtexte (Beschreibung/Befund).
// Bewusst keine Dependency: der Umfang ist klein und bekannt — Überschriften,
// Fettdruck, Inline-Code, Codeblöcke, Links, Listen, Tabellen, Blockquotes.
//
// Sicherheit: ALLES wird zuerst HTML-escaped, erst danach werden Markdown-
// Muster in Tags umgesetzt; Links nur mit http(s)-Zielen. Damit ist {@html}
// auf dem Ergebnis unbedenklich, auch wenn Testtexte Tenant-Daten enthalten.

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function inline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    // Link-Ziel wurde mitescaped — &amp; im Ziel zurückdrehen, http(s) erzwingen
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, text, url) =>
      `<a href="${url.replace(/&amp;/g, '&')}" target="_blank" rel="noreferrer">${text}</a>`)
}

export function mdLite(src) {
  if (!src) return ''
  let text = esc(String(src).replace(/\r\n/g, '\n'))

  // Codeblöcke rausziehen, damit die Zeilenlogik sie nicht anfasst. Der
  // Platzhalter nutzt ein Zeichen, das nach dem Escaping nicht vorkommen kann.
  const blocks = []
  text = text.replace(/```[a-zA-Z]*\n([\s\S]*?)```/g, (m, code) => {
    blocks.push(`<pre class="mdl-code">${code.replace(/\n$/, '')}</pre>`)
    return `\n@@MDLBLOCK${blocks.length - 1}@@\n`
  })

  const lines = text.split('\n')
  const out = []
  let list = null      // 'ul' | 'ol'
  let table = null     // gesammelte Tabellenzeilen
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null } }
  const flushTable = () => {
    if (!table) return
    const rows = table.filter(r => !/^\s*\|[\s:|-]+\|\s*$/.test(r)) // Trennzeile |---|---|
    const html = rows.map((r, i) => {
      const cells = r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => inline(c.trim()))
      const tag = i === 0 ? 'th' : 'td'
      return `<tr>${cells.map(c => `<${tag}>${c}</${tag}>`).join('')}</tr>`
    }).join('')
    out.push(`<table class="gt-table mdl-table">${html}</table>`)
    table = null
  }

  for (const raw of lines) {
    const line = raw.trimEnd()
    let m
    if ((m = line.match(/^@@MDLBLOCK(\d+)@@$/))) { closeList(); flushTable(); out.push(blocks[Number(m[1])]); continue }
    if (/^\s*\|.*\|\s*$/.test(line)) { closeList(); (table ??= []).push(line); continue }
    flushTable()
    if ((m = line.match(/^#{1,6}\s+(.*)$/))) { closeList(); out.push(`<p class="mdl-h"><strong>${inline(m[1])}</strong></p>`); continue }
    if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul' }
      out.push(`<li>${inline(m[1])}</li>`); continue
    }
    if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) {
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol' }
      out.push(`<li>${inline(m[1])}</li>`); continue
    }
    closeList()
    if ((m = line.match(/^&gt;\s?(.*)$/))) { out.push(`<p class="mdl-quote">${inline(m[1])}</p>`); continue }
    if (line.trim() === '') continue
    out.push(`<p>${inline(line)}</p>`)
  }
  closeList()
  flushTable()

  return out.join('\n')
}
