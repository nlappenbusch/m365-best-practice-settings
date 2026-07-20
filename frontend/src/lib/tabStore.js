// Globaler Tab-Zustand: erlaubt Sprung-Links aus dem Wissen-Tab direkt in das
// jeweilige Werkzeug (z.B. "Jetzt in Autopilot oeffnen" -> springt zum Tab).
import { writable } from 'svelte/store'

export const activeTab = writable('config')

export function goToTab(id) { activeTab.set(id) }
