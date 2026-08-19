// Globaler Tenant-Zustand: ersetzt die alte "erst Tenant-Karte aufklappen"-
// Logik durch EINEN Umschalter im Header, der fuer alle tenant-bezogenen
// Tabs (Mail-Security, Audit, Intune, Autopilot) gilt.
import { writable, derived, get } from 'svelte/store'
import { apiGet, apiDelete } from './api.js'

export const tenants = writable([])          // [{ id, name, organization, appId, exoRole, sccRole, tcm, certPresent, addedAt }]
export const activeTenantId = writable(null)
export const tenantsLoaded = writable(false)

// Geteilt zwischen Mail-Security (Deploy) und Audit: Domains automatisch aus
// dem Ziel-Tenant lesen (Get-AcceptedDomain) statt aus der Vorlage. Ein
// Schalter fuer beide Tabs, damit Audit und Deploy denselben Soll-Zustand pruefen.
export const autoDomains = writable(true)

export const activeTenant = derived(
  [tenants, activeTenantId],
  ([$tenants, $id]) => $tenants.find(t => t.id === $id) || null
)

export function tenantReady(t) {
  return !!(t && t.certPresent && t.exoRole && t.sccRole && t.tcm)
}

export function tenantMissing(t) {
  if (!t) return []
  return [
    t.certPresent ? null : 'Zertifikat',
    t.exoRole ? null : 'Exchange-Rolle',
    t.sccRole ? null : 'Compliance-Rolle',
    t.tcm ? null : 'TCM'
  ].filter(Boolean)
}

export async function loadTenants() {
  let list = []
  try { list = await apiGet('/api/tenants') } catch { list = [] }
  tenants.set(Array.isArray(list) ? list : [])
  tenantsLoaded.set(true)
  // Aktiven Tenant beibehalten, falls noch vorhanden; sonst ersten waehlen.
  const id = get(activeTenantId)
  if (id && list.some(t => t.id === id)) return
  activeTenantId.set(list.length ? list[0].id : null)
}

export function selectTenant(id) { activeTenantId.set(id) }

export async function removeTenant(id) {
  await apiDelete('/api/tenants/' + encodeURIComponent(id))
  await loadTenants()
}
