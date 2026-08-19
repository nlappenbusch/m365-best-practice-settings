// Zustand der linken Seitenleiste.
//  - collapsed: Schmalmodus (nur Icons) auf grossen Schirmen, in localStorage
//    gemerkt, damit die Wahl den Reload ueberlebt. Der Zustand haengt zusaetzlich
//    als data-sidebar am <html>, weil das Shell-Grid die Spaltenbreite aus
//    --sb-width liest (siehe app.css) — so bleiben Spalte und Leiste synchron.
//  - mobileOpen: Off-Canvas-Schublade auf schmalen Schirmen, bewusst NICHT
//    persistiert (soll bei jedem Aufruf zu sein).
import { writable } from 'svelte/store'

function stored() {
  try { return localStorage.getItem('m365-sidebar') === 'collapsed' } catch { return false }
}

export const sidebarCollapsed = writable(stored())
export const mobileNavOpen = writable(false)

sidebarCollapsed.subscribe((v) => {
  if (typeof document !== 'undefined') {
    if (v) document.documentElement.setAttribute('data-sidebar', 'collapsed')
    else document.documentElement.removeAttribute('data-sidebar')
  }
  try { localStorage.setItem('m365-sidebar', v ? 'collapsed' : 'expanded') } catch { /* egal */ }
})

export function toggleSidebar() { sidebarCollapsed.update(v => !v) }
export function closeMobileNav() { mobileNavOpen.set(false) }
export function toggleMobileNav() { mobileNavOpen.update(v => !v) }
