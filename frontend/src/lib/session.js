// Globale Session als Svelte-Store — ersetzt das session-change-Event aus dem
// Vanilla-Stand. Der Login gatet Live-Deploy UND Agent-Downloads, deshalb global.
import { writable } from 'svelte/store'
import { apiGet, apiPost } from './api.js'

export const session = writable({ online: false, loggedIn: false, pwsh: null, ticketsAllowed: false, ready: false })

export async function refreshSession() {
  try {
    const h = await apiGet('/api/health')
    session.set({ online: !!h.ok, loggedIn: !!h.loggedIn, pwsh: h.pwsh || null, ticketsAllowed: !!h.ticketsAllowed, ready: true })
  } catch {
    session.set({ online: false, loggedIn: false, pwsh: null, ticketsAllowed: false, ready: true })
  }
}

export async function login(username, password) {
  await apiPost('/api/login', { username: username || 'admin', password: password || '' })
  await refreshSession()
}

export async function logout() {
  try { await apiPost('/api/logout') } catch { /* egal */ }
  await refreshSession()
}
