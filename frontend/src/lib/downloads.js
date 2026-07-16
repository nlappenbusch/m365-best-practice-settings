// Datenschicht fuer den Agent-Downloads-Tab. Kapselt die /api/downloads/*-Calls.
import { apiGet, fileDownload } from './api.js'

export const dlApi = {
  config: () => apiGet('/api/downloads/config'),
  bdPackages: () => apiGet('/api/downloads/bd/packages'),
  rmmClients: () => apiGet('/api/downloads/rmm/clients'),
  rmmSites: (clientid) => apiGet('/api/downloads/rmm/sites?clientid=' + encodeURIComponent(clientid)),
  bdDownload: (u) => fileDownload('/api/downloads/bd/download?u=' + encodeURIComponent(u)),
  rmmDownload: ({ endcustomerid, siteid, type, os }) => fileDownload(
    '/api/downloads/rmm/download?endcustomerid=' + encodeURIComponent(endcustomerid) +
    '&siteid=' + encodeURIComponent(siteid) +
    '&type=' + encodeURIComponent(type) +
    '&os=' + encodeURIComponent(os))
}
