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

// { tenantId, savedAt, loading, error, ownerId }
//   ownerId = zu welchem Tenant die Werte gehoeren, die GERADE im config-Store stehen.
//   Weicht er von tenantId ab, sieht der Anwender die Vorlage eines ANDEREN Kunden —
//   das muss sichtbar sein: genau daraus entstand der Fall, dass die Richtlinien des
//   einen Kunden an den Administrator des anderen meldeten (siehe mailAdminEmail).
//   null = Standardwerte, gehoeren niemandem.
export const tenantConfigState = writable({ tenantId: null, savedAt: null, loading: false, error: null, ownerId: null })

export async function loadTenantConfig(tenantId) {
  if (!tenantId) {
    tenantConfigState.update(s => ({ ...s, tenantId: null, savedAt: null, loading: false, error: null }))
    return { loaded: false }
  }
  tenantConfigState.update(s => ({ ...s, tenantId, loading: true, error: null }))
  try {
    const r = await apiGet(`/api/tenants/${encodeURIComponent(tenantId)}/config`)
    if (r.config) {
      // Fehlende Abschnitte aus den Standardwerten auffuellen: eine aeltere
      // gespeicherte Vorlage darf nach einem Update nicht halb leer ankommen.
      config.set({ ...defaultConfig(), ...r.config })
      tenantConfigState.set({ tenantId, savedAt: r.savedAt || null, loading: false, error: null, ownerId: tenantId })
      return { loaded: true, savedAt: r.savedAt }
    }
    // Kein gespeicherter Stand: die Werte im Store bleiben absichtlich stehen (sonst
    // wuerde ein Tenantwechsel unbemerkt Eingaben wegwerfen) — ownerId bleibt deshalb
    // ebenfalls stehen und zeigt an, von wem sie stammen.
    tenantConfigState.update(s => ({ ...s, tenantId, savedAt: null, loading: false, error: null }))
    return { loaded: false }
  } catch (e) {
    tenantConfigState.update(s => ({ ...s, tenantId, savedAt: null, loading: false, error: e.message }))
    return { loaded: false, error: e.message }
  }
}

/** Standardwerte laden und die Herkunft zuruecksetzen (Knopf "Standardwerte laden"). */
export function resetToDefaults(tenantId) {
  config.set(defaultConfig())
  tenantConfigState.update(s => ({ ...s, tenantId: tenantId ?? s.tenantId, ownerId: null }))
}

export async function saveTenantConfig(tenantId) {
  if (!tenantId) throw new Error('Kein Tenant gewählt.')
  const r = await apiPut(`/api/tenants/${encodeURIComponent(tenantId)}/config`, { config: get(config) })
  tenantConfigState.set({ tenantId, savedAt: r.savedAt || new Date().toISOString(), loading: false, error: null, ownerId: tenantId })
  // Liste aktualisieren, damit die Tenant-Übersicht den Stand mitbekommt
  tenants.update(list => list.map(t => (t.id === tenantId ? { ...t, hasConfig: true, configSavedAt: r.savedAt } : t)))
  return r.savedAt
}

export async function clearTenantConfig(tenantId) {
  if (!tenantId) return
  await apiDelete(`/api/tenants/${encodeURIComponent(tenantId)}/config`)
  tenantConfigState.update(s => ({ ...s, tenantId, savedAt: null, loading: false, error: null }))
  tenants.update(list => list.map(t => (t.id === tenantId ? { ...t, hasConfig: false, configSavedAt: null } : t)))
}
