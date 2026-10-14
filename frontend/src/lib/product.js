// Product-facing helpers for the new Control Center views.
// Keeps presentation/risk heuristics out of the raw Evidence collector.

export function fmtDateTime(iso) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('de-CH', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    })
  } catch { return String(iso) }
}

export function ageLabel(iso) {
  if (!iso) return 'noch nie'
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms)) return '—'
  const min = Math.max(0, Math.floor(ms / 60000))
  if (min < 2) return 'gerade eben'
  if (min < 60) return `vor ${min} Min.`
  const h = Math.floor(min / 60)
  if (h < 24) return `vor ${h} h`
  const d = Math.floor(h / 24)
  return `vor ${d} Tag${d === 1 ? '' : 'en'}`
}

export function eventText(ev) {
  const targets = (ev?.targets || []).map(t => [
    t?.name, t?.type,
    ...(t?.changes || []).flatMap(c => [c?.name, c?.old, c?.new])
  ].filter(Boolean).join(' ')).join(' ')
  return [ev?.source, ev?.activity, ev?.operation, ev?.category, ev?.actor, ev?.app, targets]
    .filter(Boolean).join(' ').toLowerCase()
}

// Deliberately conservative. This is triage, not a compliance verdict.
// It turns the existing Evidence stream into an attention queue while the
// server-side rules engine is still being built.
export function riskOfEvent(ev) {
  const hay = eventText(ev)
  const changes = (ev?.targets || []).flatMap(t => t?.changes || [])
  const beforeAfter = changes.map(c => `${c?.name || ''} ${c?.old || ''} ${c?.new || ''}`).join(' ').toLowerCase()

  if (/conditional access|conditionalaccess/.test(hay) &&
      /(disable|disabled|off|state)/.test(hay + ' ' + beforeAfter)) {
    return { level: 'critical', score: 95, label: 'CA geändert' }
  }
  if (/global administrator|privileged role|role assignment|add member to role|directory role/.test(hay)) {
    return { level: 'critical', score: 92, label: 'Privilegien geändert' }
  }
  if (/consent|oauth|service principal|application permission|app role assignment/.test(hay)) {
    return { level: 'high', score: 82, label: 'App-/Consent-Änderung' }
  }
  if (/authentication method|mfa|passwordless|fido|temporary access pass/.test(hay)) {
    return { level: 'high', score: 78, label: 'Authentifizierung geändert' }
  }
  if (/delete|remove|harddelete|softdelete|recycle/.test(hay)) {
    return { level: 'high', score: 76, label: 'Objekt entfernt' }
  }
  if (/intune|device management/.test(hay) && /assignment|assign|compliance|configuration|policy/.test(hay)) {
    return { level: 'medium', score: 58, label: 'Intune-Konfiguration' }
  }
  if (/update|change|set|modify|add|create|enable|disable/.test(hay)) {
    return { level: 'medium', score: 45, label: 'Konfiguration geändert' }
  }
  return { level: 'info', score: 10, label: 'Ereignis' }
}

export function rankEvents(events) {
  return (events || [])
    .map(ev => ({ ...ev, risk: riskOfEvent(ev) }))
    .sort((a, b) => b.risk.score - a.risk.score || String(b.at || '').localeCompare(String(a.at || '')))
}

export function levelCount(items, level) {
  return (items || []).filter(x => (x.risk?.level || x.level) === level).length
}

export function latestByKind(entries, kind) {
  return (entries || []).find(x => x.kind === kind) || null
}
