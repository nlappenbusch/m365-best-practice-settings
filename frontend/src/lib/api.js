// Duenner Fetch-Wrapper. Alle Requests gehen an /api (Dev: Vite-Proxy, Prod: nginx).
// Session laeuft ueber das Cookie (same-origin), deshalb kein Token-Handling.

export async function apiGet(path) {
  const r = await fetch(path, { credentials: 'same-origin' })
  return handle(r)
}

export async function apiPost(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  return handle(r)
}

export async function apiPut(path, body) {
  const r = await fetch(path, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  return handle(r)
}

export async function apiDelete(path) {
  const r = await fetch(path, { method: 'DELETE', credentials: 'same-origin' })
  return handle(r)
}

async function handle(r) {
  let data = null
  try { data = await r.json() } catch { /* kein JSON */ }
  if (r.status === 401) {
    const e = new Error((data && data.error) || 'Nicht angemeldet')
    e.status = 401
    throw e
  }
  if (!r.ok) {
    const e = new Error((data && data.error) || `HTTP ${r.status}`)
    e.status = r.status
    throw e
  }
  return data
}

// Download ueber ein unsichtbares <a> anstossen (Datei-Streams vom Backend).
export function fileDownload(url) {
  const a = document.createElement('a')
  a.href = url
  a.download = ''
  document.body.appendChild(a)
  a.click()
  setTimeout(() => a.remove(), 1500)
}
