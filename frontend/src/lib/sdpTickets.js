// Datenschicht fuer den Tickets-Tab (SDP-Ticket-Copilot). Kapselt die /api/sdp/*-Calls.
import { apiGet, apiPost, fileDownload } from './api.js'

export const sdpApi = {
  getTicket: (id) => apiGet(`/api/sdp/tickets/${encodeURIComponent(id)}`),
  getTicketsBatch: (ids) => apiPost('/api/sdp/tickets/batch', { ids }),
  attachmentUrl: (ticketId, attachmentId) =>
    `/api/sdp/tickets/${encodeURIComponent(ticketId)}/attachments/${encodeURIComponent(attachmentId)}`,
  downloadAttachment: (ticketId, attachmentId) =>
    fileDownload(sdpApi.attachmentUrl(ticketId, attachmentId))
}
