// Managed Service: gemeinsame Helfer fuer Flotten- und Tenant-Ansicht.
import { writable } from 'svelte/store'
import { apiGet, apiPost, apiPut } from './api.js'

// Service-Cockpit mit offenem KI-Dienste-Panel öffnen (Link aus dem Message Center).
export const openAiPanel = writable(false)

export const SEV = ['critical', 'high', 'medium', 'low']
export const SEV_DE = { critical: 'Kritisch', high: 'Hoch', medium: 'Mittel', low: 'Niedrig', info: 'Info' }
export const STATUS_DE = { open: 'Offen', ack: 'Quittiert', ticket: 'Im Ticket', snoozed: 'Zurückgestellt', resolved: 'Behoben' }
export const KIND_DE = { new: 'Neu', drift: 'Drift', reopened: 'Wieder offen', escalated: 'Eskaliert', resolved: 'Behoben' }

const enc = encodeURIComponent
export const msApi = {
  meta: () => apiGet('/api/managed/meta'),
  fleet: () => apiGet('/api/managed/fleet'),
  global: (b) => apiPut('/api/managed/global', b),
  testWebhook: () => apiPost('/api/managed/global/test'),
  overview: (tid) => apiGet(`/api/tenants/${enc(tid)}/managed`),
  area: (tid, a) => apiGet(`/api/tenants/${enc(tid)}/managed/area/${enc(a)}`),
  settings: (tid, b) => apiPut(`/api/tenants/${enc(tid)}/managed/settings`, b),
  run: (tid, areas) => apiPost(`/api/tenants/${enc(tid)}/managed/run`, { areas: areas || [] }),
  action: (tid, fid, b) => apiPost(`/api/tenants/${enc(tid)}/managed/findings/${enc(fid)}/action`, b),
  baseline: (tid, area, reason) => apiPost(`/api/tenants/${enc(tid)}/managed/baseline/${enc(area)}`, { reason }),
  profile: (tid) => apiGet(`/api/tenants/${enc(tid)}/managed/profile`),
  mcAi: (tid, force) => apiPost(`/api/tenants/${enc(tid)}/managed/messages/ai`, { force: !!force }),
  mcAiStatus: (tid) => apiGet(`/api/tenants/${enc(tid)}/managed/messages/ai`),
  stand: (tid) => apiGet(`/api/tenants/${enc(tid)}/managed/stand`),
  freeze: (tid, reason) => apiPost(`/api/tenants/${enc(tid)}/managed/stand`, { reason }),
  standPdfUrl: (tid, v, drift) => `/api/tenants/${enc(tid)}/managed/stand/${enc(v || 'current')}/pdf${drift ? '?drift=1' : ''}`,
  reports: (tid) => apiGet(`/api/tenants/${enc(tid)}/managed/reports`),
  reportUrl: (tid, q, opts) => `/api/tenants/${enc(tid)}/managed/report?quarter=${enc(q)}${opts?.stored ? '&stored=1' : ''}${opts?.save ? '&save=1' : ''}${opts?.download ? '&download=1' : ''}`,
  job: (id) => apiGet(`/api/appjobs/${enc(id)}`)
}

/** Job bis zum Ende verfolgen; onTick bekommt den Job bei jeder Abfrage. */
export async function followJob(jobId, onTick) {
  for (;;) {
    let j
    try { j = await msApi.job(jobId) } catch (e) { onTick?.({ status: 'failed', error: e.message }); return null }
    onTick?.(j)
    if (j.status !== 'running') return j
    await new Promise(r => setTimeout(r, 2000))
  }
}

export function hoursLabel(h) {
  if (h == null) return '—'
  if (h < 1) return '< 1 h'
  if (h < 48) return `${Math.round(h)} h`
  return `${Math.round(h / 24)} T`
}

/** SVG-Pfad fuer eine Sparkline/Linie in einer w x h Box. */
export function linePath(values, w, h, pad = 2, min, max) {
  const v = values.map(x => (x == null ? null : Number(x)))
  const nums = v.filter(x => x != null && Number.isFinite(x))
  if (nums.length < 2) return { line: '', area: '' }
  const lo = min ?? Math.min(...nums), hi = max ?? Math.max(...nums)
  const span = hi - lo || 1
  const xs = i => pad + (i * (w - pad * 2)) / Math.max(1, v.length - 1)
  const ys = x => h - pad - ((x - lo) / span) * (h - pad * 2)
  let line = '', first = null, last = null
  v.forEach((x, i) => {
    if (x == null) return
    line += (line ? ' L' : 'M') + xs(i).toFixed(1) + ' ' + ys(x).toFixed(1)
    if (first == null) first = i
    last = i
  })
  const area = line + ` L${xs(last).toFixed(1)} ${h - pad} L${xs(first).toFixed(1)} ${h - pad} Z`
  return { line, area, lastX: xs(last), lastY: ys(v[last]) }
}

export function scoreTone(pct) {
  if (pct == null) return 'neutral'
  if (pct >= 70) return 'ok'
  if (pct >= 45) return 'warn'
  return 'crit'
}

export function pctOf(v) {
  const n = parseFloat(String(v ?? '').replace('%', ''))
  return Number.isFinite(n) ? n : null
}
