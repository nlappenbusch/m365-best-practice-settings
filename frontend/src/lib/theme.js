// Hell/Dunkel-Umschalter. "auto" folgt prefers-color-scheme (Standard),
// "light"/"dark" setzen das data-theme-Attribut, das app.css bereits
// als Override fuer die Tokens definiert. Persistiert in localStorage.
import { writable } from 'svelte/store'

function initial() {
  try { return localStorage.getItem('m365-theme') || 'auto' } catch { return 'auto' }
}

export const theme = writable(initial())

theme.subscribe((t) => {
  if (typeof document === 'undefined') return
  if (t === 'auto') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', t)
  try { localStorage.setItem('m365-theme', t) } catch { /* egal */ }
})

const ORDER = ['auto', 'light', 'dark']
export function cycleTheme() {
  theme.update(t => ORDER[(ORDER.indexOf(t) + 1) % ORDER.length])
}
