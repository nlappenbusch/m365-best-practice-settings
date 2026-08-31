// Datenschicht fuer den Agent-Downloads-Tab. Kapselt die /api/downloads/*-Calls.
import { apiGet, apiPost, fileDownload } from './api.js'

export const dlApi = {
  config: () => apiGet('/api/downloads/config'),
  bdPackages: () => apiGet('/api/downloads/bd/packages'),
  rmmClients: () => apiGet('/api/downloads/rmm/clients'),
  rmmSites: (clientid) => apiGet('/api/downloads/rmm/sites?clientid=' + encodeURIComponent(clientid)),
  bdDownload: (u) => fileDownload('/api/downloads/bd/download?u=' + encodeURIComponent(u)),
  bwRelease: (refresh) => apiGet('/api/downloads/bw/release' + (refresh ? '?refresh=1' : '')),
  bwDownload: ({ what, arch }) => fileDownload(
    '/api/downloads/bw/download?what=' + encodeURIComponent(what) +
    (arch ? '&arch=' + encodeURIComponent(arch) : '')),
  rmmDownload: ({ endcustomerid, siteid, type, os }) => fileDownload(
    '/api/downloads/rmm/download?endcustomerid=' + encodeURIComponent(endcustomerid) +
    '&siteid=' + encodeURIComponent(siteid) +
    '&type=' + encodeURIComponent(type) +
    '&os=' + encodeURIComponent(os)),
  groupTags: (tenantId) => apiGet(`/api/tenants/${encodeURIComponent(tenantId)}/autopilot/grouptags`),
  appDeployStart: (tenantId, body) => apiPost(`/api/tenants/${encodeURIComponent(tenantId)}/appdeploy/start`, body),
  appDeployPoll: (jobId) => apiGet(`/api/appjobs/${encodeURIComponent(jobId)}`)
}
