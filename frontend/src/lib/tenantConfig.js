// Vorlage pro Tenant laden/speichern.
//
// Die Vorlage lag bisher nur im Browser-Tab (config-Store ohne Persistenz) —
// nach einem Reload stand wieder example.com da. Hier haengt sie am Tenant:
// beim Umschalten wird die gespeicherte Vorlage automatisch geladen, sofern es
// eine gibt. Ohne gespeicherte Vorlage bleibt die aktuelle stehen, damit ein
// Tenantwechsel nie unbemerkt Eingaben wegwirft.
import { writable, get } from 'svelte/store'
import { apiGet, apiPut, apiDelete } from './api.js'
import { config, defaultConfig } from './config.js'
import { tenants } from './tenantStore.js'

// { tenantId, savedAt, dirtySince } — Grundlage der Statuszeile im Vorlage-Bereich
export const tenantConfigState = writable({ tenantId: null, savedAt: null, loading: false, error: null })

export async function loadTenantConfig(tenantId) {
  if (!tenantId) {
    tenantConfigState.set({ tenantId: null, savedAt: null, loading: false, error: null })
    return { loaded: false }
  }
  tenantConfigState.update(s => ({ ...s, tenantId, loading: true, error: null }))
  try {
    const r = await apiGet(`/api/tenants/${encodeURIComponent(tenantId)}/config`)
    if (r.config) {
      // Fehlende Abschnitte aus den Standardwerten auffuellen: eine aeltere
      // gespeicherte Vorlage darf nach einem Update nicht halb leer ankommen.
      config.set({ ...defaultConfig(), ...r.config })
      tenantConfigState.set({ tenantId, savedAt: r.savedAt || null, loading: false, error: null })
      return { loaded: true, savedAt: r.savedAt }
    }
    tenantConfigState.set({ tenantId, savedAt: null, loading: false, error: null })
    return { loaded: false }
  } catch (e) {
    tenantConfigState.set({ tenantId, savedAt: null, loading: false, error: e.message })
    return { loaded: false, error: e.message }
  }
}

export async function saveTenantConfig(tenantId) {
  if (!tenantId) throw new Error('Kein Tenant gewählt.')
  const r = await apiPut(`/api/tenants/${encodeURIComponent(tenantId)}/config`, { config: get(config) })
  tenantConfigState.set({ tenantId, savedAt: r.savedAt || new Date().toISOString(), loading: false, error: null })
  // Liste aktualisieren, damit die Tenant-Übersicht den Stand mitbekommt
  tenants.update(list => list.map(t => (t.id === tenantId ? { ...t, hasConfig: true, configSavedAt: r.savedAt } : t)))
  return r.savedAt
}

export async function clearTenantConfig(tenantId) {
  if (!tenantId) return
  await apiDelete(`/api/tenants/${encodeURIComponent(tenantId)}/config`)
  tenantConfigState.set({ tenantId, savedAt: null, loading: false, error: null })
  tenants.update(list => list.map(t => (t.id === tenantId ? { ...t, hasConfig: false, configSavedAt: null } : t)))
}
