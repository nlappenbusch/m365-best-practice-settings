// Globaler Tab-Zustand: erlaubt Sprung-Links aus dem Wissen-Tab direkt in das
// jeweilige Werkzeug (z.B. "Jetzt in Autopilot oeffnen" -> springt zum Tab) und
// merkt sich den zuletzt offenen Bereich ueber den Reload hinweg.
import { writable } from 'svelte/store'
import { navItem } from './nav.js'
import { closeMobileNav } from './sidebarStore.js'

const FALLBACK = 'cockpit'
const LEGACY_TABS = { overview: 'managed', risks: 'managed' }
export const resolveTab = id => LEGACY_TABS[id] || (navItem(id) ? id : FALLBACK)

function initial() {
  try {
    const saved = localStorage.getItem('m365-tab')
    return resolveTab(saved)
  } catch { return FALLBACK }
}

const tab = writable(initial())
export const activeTab = { subscribe: tab.subscribe, set: id => tab.set(resolveTab(id)), update: fn => tab.update(id => resolveTab(fn(id))) }

activeTab.subscribe((id) => {
  try { localStorage.setItem('m365-tab', id) } catch { /* egal */ }
})

export function goToTab(id) {
  activeTab.set(id)
  closeMobileNav()   // Sprunglinks sollen die Schublade auf Mobil nicht offen lassen
}
