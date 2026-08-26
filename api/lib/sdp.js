"use strict";
/**
 * ServiceDesk Plus (on-prem, iGeeks-eigene Instanz) — Ticket-Details, Notizen,
 * Tasks und Anhaenge lesen. Portiert aus einem bereits bewaehrten, lokal bei
 * Nils laufenden Python-MCP-Skript (Endpunkte/Verhalten 1:1 uebernommen).
 *
 * Auth: Header TECHNICIAN_KEY: <key> (SDP-eigenes Schema, kein OAuth). Der
 * Key bleibt serverseitig (SDP_API_KEY) -- landet nie im Browser oder in
 * einer URL, analog zu BD_API_KEY/RMM_API_KEY in bitdefender.js/nsight.js.
 *
 * Anhang-Download: ManageEngines eigene Doku widerspricht sich, welcher Pfad
 * den Binaerinhalt liefert -- wir probieren beide bekannten Kandidaten der
 * Reihe nach (siehe downloadAttachment).
 */

const DEFAULT_BASE_URL = "https://sdp.igeeks.ch/api/v3";

function config() {
  const key = (process.env.SDP_API_KEY || "").trim();
  const baseUrl = (process.env.SDP_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  const ownerId = (process.env.SDP_OWNER_ID || "").trim();
  return { enabled: key.length > 0, key, baseUrl, ownerId };
}

function requireEnabled(cfg) {
  if (!cfg.enabled) throw Object.assign(new Error("Kein SDP-Key konfiguriert (SDP_API_KEY)."), { status: 400 });
}

/** HTML aus Notizen/Beschreibungen sicher als reinen Text darstellen (kein {@html} noetig). */
function htmlToText(html) {
  if (!html) return "";
  return String(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function sdpFetch(path, opts = {}) {
  const cfg = config();
  requireEnabled(cfg);
  const url = cfg.baseUrl + path;
  let r;
  try {
    r = await fetch(url, {
      method: opts.method || "GET",
      headers: {
        TECHNICIAN_KEY: cfg.key,
        Accept: "application/vnd.manageengine.sdp.v3+json",
        ...(opts.body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        ...opts.headers
      },
      body: opts.body,
      signal: AbortSignal.timeout(30000)
    });
  } catch (e) {
    throw Object.assign(new Error("SDP nicht erreichbar: " + e.message), { status: 502 });
  }
  return r;
}

async function sdpJson(path, opts) {
  const r = await sdpFetch(path, opts);
  const text = await r.text();
  let j; try { j = text ? JSON.parse(text) : {}; } catch (e) { j = null; }
  if (!r.ok) {
    const msg = (j && j.response_status && j.response_status.messages && j.response_status.messages[0] && j.response_status.messages[0].message)
      || (j && j.message) || `HTTP ${r.status}`;
    throw Object.assign(new Error(`SDP-Fehler: ${msg}`), { status: r.status === 404 ? 404 : 502 });
  }
  if (j === null) throw Object.assign(new Error("Unerwartete SDP-Antwort (kein JSON)."), { status: 502 });
  return j;
}

async function getTicketDetails(id) {
  const j = await sdpJson(`/requests/${encodeURIComponent(id)}`);
  const req = j.request || {};
  return {
    id: String(req.id || id),
    subject: req.subject || "",
    status: (req.status && req.status.name) || "",
    priority: (req.priority && req.priority.name) || "",
    requester: (req.requester && req.requester.name) || "",
    technician: (req.technician && req.technician.name) || "",
    category: (req.category && req.category.name) || "",
    createdTime: (req.created_time && req.created_time.display_value) || "",
    dueTime: (req.due_by_time && req.due_by_time.display_value) || "",
    description: htmlToText(req.description),
    hasAttachments: !!req.has_attachments,
    attachments: (req.attachments || []).map(a => ({
      id: String(a.file_id || a.id || ""),
      name: a.name || "Anhang",
      size: a.size || null,
      contentType: a.content_type || null
    }))
  };
}

async function getTicketNotes(id) {
  const j = await sdpJson(`/requests/${encodeURIComponent(id)}/notes`);
  const notes = j.request_notes || j.notes || [];
  return notes
    .map(n => ({
      id: String(n.id || ""),
      createdBy: (n.created_by && n.created_by.name) || "",
      createdTime: (n.created_time && n.created_time.display_value) || "",
      description: htmlToText(n.description),
      showToRequester: !!n.show_to_requester
    }))
    .sort((a, b) => Number(b.id) - Number(a.id));
}

async function getTicketTasks(id) {
  const j = await sdpJson(`/requests/${encodeURIComponent(id)}/tasks`);
  const tasks = j.tasks || [];
  return tasks.map(t => ({
    id: String(t.id || ""),
    bookingTarget: `T:${id}-${t.id}`,
    title: t.title || "",
    status: (t.status && t.status.name) || ""
  }));
}

/**
 * Anhang-Binaerinhalt holen. Zwei bekannte URL-Muster kursieren in
 * ManageEngines eigener Doku (siehe Kommentar oben) -- erst das
 * ticket-verschachtelte probieren, bei 404 auf das flache zurueckfallen.
 */
async function downloadAttachment(ticketId, attachmentId) {
  const cfg = config();
  requireEnabled(cfg);
  const candidates = [
    `/requests/${encodeURIComponent(ticketId)}/attachments/${encodeURIComponent(attachmentId)}/download`,
    `/attachments/${encodeURIComponent(attachmentId)}/download`
  ];
  let lastStatus = null;
  for (const path of candidates) {
    const r = await sdpFetch(path);
    if (r.ok && r.body) {
      const buffer = Buffer.from(await r.arrayBuffer());
      return { buffer, contentType: r.headers.get("content-type") || "application/octet-stream" };
    }
    lastStatus = r.status;
  }
  throw Object.assign(new Error(`Anhang-Download fehlgeschlagen (HTTP ${lastStatus}) -- beide bekannten URL-Muster erfolglos.`), { status: 502 });
}

/**
 * Alles fuer die Ticket-Ansicht in einem Aufruf. Teilfehler (z.B. Notes
 * nicht abrufbar) duerfen die anderen Teile nicht blockieren -- ein kaputtes
 * Sub-Ticket in einer Batch-Anfrage soll nicht die ganze Liste sprengen.
 */
async function getTicketFull(id) {
  const [details, notes, tasks] = await Promise.allSettled([
    getTicketDetails(id),
    getTicketNotes(id),
    getTicketTasks(id)
  ]);
  if (details.status === "rejected") {
    throw Object.assign(new Error(details.reason.message), { status: details.reason.status || 502 });
  }
  return {
    ...details.value,
    notes: notes.status === "fulfilled" ? notes.value : [],
    notesError: notes.status === "rejected" ? notes.reason.message : null,
    tasks: tasks.status === "fulfilled" ? tasks.value : [],
    tasksError: tasks.status === "rejected" ? tasks.reason.message : null
  };
}

/**
 * Neues Ticket anlegen (fuer Maester-Findings). SDP v3 erwartet die Nutzdaten
 * form-urlencoded als input_data-JSON. Beschreibung darf HTML sein.
 */
async function createRequest({ subject, description }) {
  const cfg = config();
  requireEnabled(cfg);
  const request = {
    subject: String(subject || "").slice(0, 250),
    description: String(description || "")
  };
  // Wenn ein Owner konfiguriert ist, direkt als Techniker zuweisen — sonst
  // landet das Ticket unassigned in der Queue (auch ok).
  if (cfg.ownerId) request.technician = { id: cfg.ownerId };
  const body = "input_data=" + encodeURIComponent(JSON.stringify({ request }));
  const j = await sdpJson("/requests", { method: "POST", body });
  const created = j.request || {};
  return { id: String(created.id || ""), subject: created.subject || request.subject };
}

module.exports = { config, getTicketDetails, getTicketNotes, getTicketTasks, downloadAttachment, getTicketFull, htmlToText, createRequest };
