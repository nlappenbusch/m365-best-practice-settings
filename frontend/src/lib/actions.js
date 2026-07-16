// Import/Export-Aktionen (Header-Buttons). Nutzt die verbatim portierten
// Generatoren aus configExport.js und den Config-Store.
import { get } from 'svelte/store'
import { config } from './config.js'
import { makeExporters } from './configExport.js'

function download(filename, text, type = 'text/plain') {
  const blob = new Blob([text], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export function exportJson() {
  download('m365-config.json', JSON.stringify(get(config), null, 2), 'application/json')
}

export function exportDocs() {
  const ex = makeExporters(get(config))
  download('M365-Security-Configuration.md', ex.generateMarkdownDocumentation(), 'text/markdown')
}

// PowerShell-Skript aus den gewaehlten Teilen zusammensetzen (fuer Modal + Download).
export function buildPowerShell({ deployment = true, verification = true, documentation = true } = {}) {
  const ex = makeExporters(get(config))
  let s = ''
  if (documentation) s += ex.generateDocumentationHeader()
  if (deployment) s += ex.generateDeploymentScript()
  if (verification) s += ex.generateVerificationScript()
  return s
}

export function downloadPs(text) {
  download('M365-BestPractice-Deployment.ps1', text, 'text/plain')
}

// JSON-Import: Datei waehlen, in den Store mergen. onDone(ok, message).
export function importConfig(onDone) {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.json'
  input.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      try {
        const imported = JSON.parse(ev.target.result)
        config.update((c) => {
          if (imported.global) Object.assign(c.global, imported.global)
          if (imported.antiPhishing) Object.assign(c.antiPhishing, imported.antiPhishing)
          if (imported.antiSpam) Object.assign(c.antiSpam, imported.antiSpam)
          if (imported.antiMalware) Object.assign(c.antiMalware, imported.antiMalware)
          return c
        })
        onDone && onDone(true, 'Konfiguration erfolgreich importiert.')
      } catch (err) {
        onDone && onDone(false, 'Fehler beim Importieren: ' + err.message)
      }
    }
    reader.readAsText(file)
  })
  input.click()
}
