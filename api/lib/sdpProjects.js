"use strict";
/**
 * ServiceDesk Plus — Projekte, Meilensteine und Tasks fuer das Projektplan-
 * Dashboard unter /plan/. Portiert aus dem lokalen SDP-Tracker (sdp-tracker/
 * backend.py), Endpunkte und Feldnamen 1:1 uebernommen.
 *
 * Nur die Faelle, die das Dashboard braucht:
 *   - offene Projekte auflisten (nach Kunde gruppierbar)
 *   - Meilensteine und Tasks eines Projekts (Board, Gantt, Kundenplan)
 *   - Task einem Meilenstein zuordnen, Meilenstein anlegen/umbenennen/terminieren
 *
 * Alles andere (Worklogs, Beschreibungen schreiben, Attachments) bleibt bewusst
 * im lokalen Tracker. Der SDP-Key kommt aus sdp.js (SDP_API_KEY), nie in den Browser.
 */

const { sdpJson, htmlToText } = require("./sdp");

const DONE_STATUS = new Set(["closed", "completed", "resolved", "cancelled", "canceled", "erledigt", "abgeschlossen", "done"]);

function listInfo(extra) {
  return "?input_data=" + encodeURIComponent(JSON.stringify({ list_info: { row_count: 100, ...(extra || {}) } }));
}

/** estimated_effort -> Stunden (float). display_value ist '7 hr', '4 hr 30 min' oder leer. */
function parseHours(eff) {
  if (!eff) return 0;
  const dv = typeof eff === "object" ? (eff.display_value || "") : String(eff);
  if (!dv) return 0;
  const h = /(\d+)\s*hr/.exec(dv), m = /(\d+)\s*min/.exec(dv);
  if (h || m) return (h ? parseInt(h[1], 10) : 0) + (m ? parseInt(m[1], 10) / 60 : 0);
  const f = parseFloat(dv);
  return Number.isFinite(f) ? f : 0;
}

/** Kunde = Namensteil vor dem ersten ' - ' (bzw. Gedankenstrich). */
function customerOf(name) {
  for (const sep of [" - ", " – ", " — "]) {
    if ((name || "").includes(sep)) return name.split(sep)[0].trim();
  }
  return (name || "").trim();
}

function tsOf(v) {
  const n = v && v.value ? parseInt(v.value, 10) : 0;
  return Number.isFinite(n) ? n : 0;
}
function dispOf(v) { return (v && v.display_value) ? String(v.display_value).split(" ")[0] : ""; }

/** --- Nils · Datum --- ... ------ Bloecke (interne Notizen) aus der Beschreibung entfernen. */
function stripNotes(html) {
  return String(html || "").replace(/---\s*Nils[\s\S]*?------/g, "").trim();
}

/** Nur den <b>Scope:</b>-Teil einer Task-Beschreibung (Kundenplan zeigt nie Voraussetzung/Input/Umsetzung). */
function scopeOf(html) {
  const s = String(html || "");
  const m = /<b>\s*Scope:\s*<\/b>\s*([\s\S]*?)(?:<br\s*\/?>\s*<b|$)/i.exec(s);
  const raw = m ? m[1] : (/<b>/.test(s) ? "" : s);
  return htmlToText(stripNotes(raw));
}

async function listProjects() {
  const j = await sdpJson("/projects" + listInfo({ sort_field: "id", sort_order: "desc" }));
  const out = [];
  for (const p of (j.projects || [])) {
    const status = (p.status && p.status.name) || "";
    if (DONE_STATUS.has(status.toLowerCase())) continue;
    out.push({
      id: parseInt(p.id, 10),
      name: p.title || "",
      customer: customerOf(p.title || ""),
      owner: (p.owner && p.owner.name) || "",
      status,
      due: dispOf(p.scheduled_end_time),
      pc: parseInt(p.percentage_completion || 0, 10) || 0
    });
  }
  out.sort((a, b) => a.customer.localeCompare(b.customer, "de") || a.id - b.id);
  return out;
}

async function projectHead(pid) {
  const j = await sdpJson(`/projects/${encodeURIComponent(pid)}`);
  const p = j.project || {};
  return {
    id: parseInt(pid, 10),
    name: p.title || "",
    customer: customerOf(p.title || ""),
    owner: (p.owner && p.owner.name) || "",
    status: (p.status && p.status.name) || "",
    due: dispOf(p.scheduled_end_time),
    // Beschreibung ohne interne Notizen, als Text (kein {@html} im Frontend noetig)
    description: htmlToText(stripNotes(p.description || ""))
  };
}

async function milestones(pid) {
  const j = await sdpJson(`/projects/${encodeURIComponent(pid)}/milestones` + listInfo());
  const out = (j.milestones || []).map(m => {
    const st = m.status || {};
    return {
      id: String(m.id),
      title: m.title || "(ohne Titel)",
      status: st.name || "",
      done: DONE_STATUS.has(String(st.name || "").toLowerCase()),
      color: st.color || "#8b98a5",
      start: dispOf(m.scheduled_start_time),
      end: dispOf(m.scheduled_end_time),
      _s: tsOf(m.scheduled_start_time),
      _e: tsOf(m.scheduled_end_time)
    };
  });
  out.sort((a, b) => (a._s || 9e18) - (b._s || 9e18));
  return out;
}

async function tasks(pid, withScope) {
  const j = await sdpJson(`/projects/${encodeURIComponent(pid)}/tasks` + listInfo());
  const list = (j.tasks || []).map(t => ({
    id: parseInt(t.id, 10),
    title: t.title || "",
    mid: t.milestone ? String(t.milestone.id) : null,
    est: Math.round(parseHours(t.estimated_effort) * 100) / 100,
    status: (t.status && t.status.name) || "",
    owner: (t.owner && t.owner.name) || "",
    ts: tsOf(t.scheduled_start_time),
    te: tsOf(t.scheduled_end_time),
    pc: parseInt(t.percentage_completion || 0, 10) || 0,
    scope: ""
  }));
  if (withScope) {
    // Die Listen-API liefert keine description — Einzelabruf, parallel in Bloecken.
    const CHUNK = 8;
    for (let i = 0; i < list.length; i += CHUNK) {
      await Promise.all(list.slice(i, i + CHUNK).map(async t => {
        try {
          const d = await sdpJson(`/projects/${encodeURIComponent(pid)}/tasks/${t.id}`);
          t.scope = scopeOf((d.task && d.task.description) || "");
        } catch { t.scope = ""; }
      }));
    }
  }
  return list;
}

function isDone(t) {
  return (t.pc || 0) >= 100 || DONE_STATUS.has(String(t.status || "").toLowerCase());
}

/** Alles, was Board, Gantt und Kundenplan eines Projekts brauchen. */
async function projectFull(pid, withScope) {
  const [head, mss, ts] = await Promise.all([projectHead(pid), milestones(pid), tasks(pid, withScope)]);
  const byMid = {};
  for (const t of ts) { t.done = isDone(t); (byMid[t.mid || ""] = byMid[t.mid || ""] || []).push(t); }
  for (const m of mss) {
    m.tasks = byMid[m.id] || [];
    m.est = Math.round(m.tasks.reduce((s, t) => s + (t.est || 0), 0) * 100) / 100;
    // Meilenstein zu, wenn SDP ihn zu hat ODER alle Tasks erledigt sind
    if (!m.done && m.tasks.length && m.tasks.every(t => t.done)) m.done = true;
  }
  return { ...head, milestones: mss, tasks: ts, unassigned: byMid[""] || [] };
}

/** Alle offenen Projekte mit Meilensteinen und Tasks — Grundlage der Gesamtansicht. */
async function gantt() {
  const projects = await listProjects();
  const out = [];
  const CHUNK = 4;
  for (let i = 0; i < projects.length; i += CHUNK) {
    await Promise.all(projects.slice(i, i + CHUNK).map(async p => {
      try {
        const [mss, ts] = await Promise.all([milestones(p.id), tasks(p.id, false)]);
        const byMid = {};
        for (const t of ts) { t.done = isDone(t); (byMid[t.mid || ""] = byMid[t.mid || ""] || []).push(t); }
        for (const m of mss) {
          m.tasks = byMid[m.id] || [];
          m.est = Math.round(m.tasks.reduce((s, t) => s + (t.est || 0), 0) * 100) / 100;
          if (!m.done && m.tasks.length && m.tasks.every(t => t.done)) m.done = true;
        }
        out.push({ ...p, milestones: mss, unassigned: byMid[""] || [] });
      } catch (e) {
        out.push({ ...p, milestones: [], unassigned: [], error: e.message });
      }
    }));
  }
  out.sort((a, b) => a.customer.localeCompare(b.customer, "de") || a.id - b.id);
  return out;
}

function form(obj) {
  return "input_data=" + encodeURIComponent(JSON.stringify(obj));
}

async function setTaskMilestone(pid, tid, mid) {
  const body = form({ task: { milestone: mid ? { id: String(mid) } : null } });
  await sdpJson(`/projects/${encodeURIComponent(pid)}/tasks/${encodeURIComponent(tid)}`, { method: "PUT", body });
  return true;
}

function epochOf(isoDate) {
  if (!isoDate) return null;
  const d = new Date(isoDate + "T00:00:00");
  return Number.isFinite(d.getTime()) ? String(d.getTime()) : null;
}

/** mid leer = neuer Meilenstein. start/end als YYYY-MM-DD, leer = unveraendert. */
async function saveMilestone(pid, mid, title, start, end) {
  const m = { title: String(title || "").trim() };
  if (!m.title) throw Object.assign(new Error("Titel darf nicht leer sein."), { status: 400 });
  const s = epochOf(start), e = epochOf(end);
  if (s) m.scheduled_start_time = { value: s };
  if (e) m.scheduled_end_time = { value: String(parseInt(e, 10) + 23 * 3600 * 1000 + 59 * 60 * 1000) };
  const body = form({ milestone: m });
  const path = `/projects/${encodeURIComponent(pid)}/milestones` + (mid ? `/${encodeURIComponent(mid)}` : "");
  const j = await sdpJson(path, { method: mid ? "PUT" : "POST", body });
  return String((j.milestone && j.milestone.id) || mid || "");
}

module.exports = { listProjects, projectFull, gantt, setTaskMilestone, saveMilestone, customerOf, parseHours, scopeOf };
