// Namenskonvention im Frontend — nur für Vorschauen.
//
// Verbindlich ist immer die Serverseite (api/lib/naming.js); hier steht
// dieselbe Ersetzungslogik, damit die Oberfläche schon vor dem Deploy zeigen
// kann, wie das Objekt heissen wird. Wer einen Namen anzeigt, den das Werkzeug
// gleich anlegt, soll ihn nicht fest verdrahten.
import { apiGet } from './api.js'

export function camel(s) {
  return String(s ?? '')
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue').replace(/ß/g, 'ss')
    .split(/[^A-Za-z0-9]+/).filter(Boolean)
    .map(p => p.charAt(0).toUpperCase() + p.slice(1))
    .join('')
}

/** {x} wie übergeben, {X} in Grossbuchstaben, {Xx} als CamelCase, {nn} zweistellig. */
export function renderName(template, vars) {
  let out = String(template ?? '')
  for (const k of Object.keys(vars || {})) {
    const raw = vars[k]
    if (raw === undefined || raw === null) continue
    const t = String(raw)
    out = out.split(`{${k}}`).join(k === 'nn' ? String(parseInt(t, 10) || 1).padStart(2, '0') : t)
    out = out.split(`{${k.toUpperCase()}}`).join(t.toUpperCase())
    out = out.split(`{${k.charAt(0).toUpperCase() + k.slice(1)}}`).join(camel(t))
  }
  return out.replace(/\{[A-Za-z]+\}/g, '').trim()
}

/**
 * Wirksame Konvention eines Tenants laden. Ergebnis: { templates, name(kind, vars) }.
 * Fällt der Abruf aus, liefert `name()` einen leeren String — die Oberfläche
 * zeigt dann keinen Namen an, statt einen falschen zu behaupten.
 */
export async function loadNaming(tenantId) {
  let templates = {}
  try {
    const r = tenantId
      ? await apiGet(`/api/tenants/${encodeURIComponent(tenantId)}/naming`)
      : await apiGet('/api/naming')
    templates = (r.effective && r.effective.templates) || {}
  } catch {
    templates = {}
  }
  return {
    templates,
    name(kind, vars) {
      const tpl = templates[kind]
      return tpl ? renderName(tpl, vars || {}) : ''
    }
  }
}
