// Globaler Tab-Zustand: erlaubt Sprung-Links aus dem Wissen-Tab direkt in das
// jeweilige Werkzeug (z.B. "Jetzt in Autopilot oeffnen" -> springt zum Tab) und
// merkt sich den zuletzt offenen Bereich ueber den Reload hinweg.
import { writable } from 'svelte/store'
import { navItem } from './nav.js'
import { closeMobileNav } from './sidebarStore.js'

const FALLBACK = 'tenants'

function initial() {
  try {
    const saved = localStorage.getItem('m365-tab')
    return saved && navItem(saved) ? saved : FALLBACK
  } catch { return FALLBACK }
}

export const activeTab = writable(initial())

activeTab.subscribe((id) => {
  try { localStorage.setItem('m365-tab', id) } catch { /* egal */ }
})

export function goToTab(id) {
  activeTab.set(id)
  closeMobileNav()   // Sprunglinks sollen die Schublade auf Mobil nicht offen lassen
}
