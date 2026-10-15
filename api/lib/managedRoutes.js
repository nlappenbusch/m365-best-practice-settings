"use strict";
/**
 * Managed Service: HTTP-Routen, Zeitplan, Ticket-Automatik und Benachrichtigung.
 *
 * Eingebunden aus server.js ueber register(app, deps) — die Abhaengigkeiten
 * (State, Zertifikat, Jobs, SDP) kommen hereingereicht, damit dieses Modul
 * nicht an den Interna von server.js haengt.
 *
 * Schreibt NIE in den Kundentenant. Schreibend sind nur: eigener State,
 * SDP-Tickets (igeeks-System) und die Teams-Benachrichtigung.
 */
const fs = require("fs");
const path = require("path");
const S = require("./managedService");
const R = require("./managedReport");
const { cut } = require("./managedCollectors");

const TICK_MS = 5 * 60 * 1000;
const MAX_TICKETS_PER_RUN = 8;

function register(app, deps) {
  const { STATE_DIR, loadState, saveState, certPemPath, requireTenant, wrap, createAppJob, appJobProgress, finishAppJob, appJobs, SDP, AISUGGEST } = deps;
  const who = req => (req.session && req.session.user) || "unbekannt";
  const globalCfg = () => ({ teamsWebhook: "", notifyMin: "high", brand: "igeeks AG", ...((loadState().managedGlobal) || {}), envWebhook: !!process.env.MANAGED_TEAMS_WEBHOOK });
  const webhookUrl = () => process.env.MANAGED_TEAMS_WEBHOOK || (loadState().managedGlobal || {}).teamsWebhook || "";

  // ---------------------------------------------------------------- KI-Einordnung Message Center
  // Optional (ANTHROPIC_API_KEY). Ein Aufruf je Lauf, nur fuer neue/geaenderte
  // relevante Meldungen, Ergebnis je Meldung gecacht (id + lastModified).
  async function aiEnrich(tenant, messages, facts, cache) {
    const cfg = AISUGGEST.config();
    if (!cfg.enabled) return null;
    const todo = messages.filter(m => !(cache[m.id] && cache[m.id].modified === m.modified)).slice(0, 10);
    if (!todo.length) return null;
    const prompt =
      `Du bist M365-Betriebsingenieur bei einem Schweizer MSP. Bewerte Microsoft-Message-Center-Meldungen für EINEN konkreten Kundentenant.\n` +
      `Tenant-Fakten (JSON): ${JSON.stringify(facts).slice(0, 3000)}\n\n` +
      `Meldungen (JSON): ${JSON.stringify(todo.map(m => ({ id: m.id, title: m.title, services: m.services, due: m.due, tags: m.tags, verdict: m.verdict, affected: m.affected, text: m.summary })))}\n\n` +
      `Antworte AUSSCHLIESSLICH mit JSON: {"items":[{"id":string,"relevant":boolean,"titel":string,"kurz":string,"wer":string,"wann":string,"impact":string,"actions":[string]}]}. ` +
      `Alle Texte auf Deutsch, Schweizer Schreibweise (ss statt ß), sachlich, ohne Marketing. ` +
      `"titel": deutscher Titel, max. 90 Zeichen. "kurz": was sich ändert, 1–2 Sätze. "wer": wer laut Microsoft betroffen ist, 1 Satz. "wann": Zeitplan in einem Satz mit Datum. ` +
      `"impact": ein Satz, was die Änderung für DIESEN Tenant konkret bedeutet — mit Zahlen aus den Fakten, wenn vorhanden. ` +
      `"actions": 1–4 konkrete Handlungsschritte für das Operations-Team (Portal, Einstellung, Zeitpunkt). Keine Allgemeinplätze; leer, wenn nichts zu tun ist. ` +
      `relevant=false, wenn der Tenant den Dienst/die Funktion laut Fakten nicht nutzt.`;
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": cfg.key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: cfg.model, max_tokens: 2500, messages: [{ role: "user", content: prompt }] })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error("KI-Einordnung: " + ((j.error && j.error.message) || r.status));
    const text = (j.content || []).map(c => c.text || "").join("").replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    const parsed = JSON.parse(text);
    const next = { ...cache };
    for (const it of parsed.items || []) {
      const m = todo.find(x => x.id === it.id);
      if (!m) continue;
      next[m.id] = { modified: m.modified, ai: {
        relevant: !!it.relevant, titel: cut(it.titel, 120), kurz: cut(it.kurz, 500), wer: cut(it.wer, 300), wann: cut(it.wann, 200),
        impact: cut(it.impact, 400), actions: (it.actions || []).map(a => cut(a, 300)).slice(0, 4)
      } };
    }
    return next;
  }

  // ---------------------------------------------------------------- Tickets
  const esc = x => String(x == null ? "" : x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  function ticketBody(t, f) {
    return `<b>Managed Service — automatisch erkannter Befund</b><br>` +
      `Tenant: ${esc(t.name)} (${esc(t.organization || "")})<br>` +
      `Bereich: ${esc((S.AREA[f.area] || {}).label || f.area)} · Schweregrad: <b>${esc(f.severity)}</b> · erkannt ${esc(String(f.firstSeen).slice(0, 16).replace("T", " "))}<br><br>` +
      `<b>${esc(f.title)}</b><br>${esc(f.summary || "")}<br><br>` +
      ((f.context || []).length ? `<b>Kontext</b><ul>${f.context.map(([k, v]) => `<li>${esc(k)}: ${esc(v)}</li>`).join("")}</ul>` : "") +
      ((f.diff || []).length ? `<b>Abweichung zur Baseline</b><ul>${f.diff.slice(0, 15).map(d => `<li>${esc(d.path)}: ${esc(d.old)} → ${esc(d.new)}</li>`).join("")}</ul>` : "") +
      ((f.steps || []).length ? `<b>Vorgehen</b><ol>${f.steps.map(s => `<li>${esc(s)}</li>`).join("")}</ol>` : "") +
      ((f.links || []).length ? `<b>Links</b><br>${f.links.map(l => `<a href="${esc(l.url)}">${esc(l.label)}</a>`).join(" · ")}<br>` : "") +
      `<br><small>Befund-ID ${esc(f.id)} — Status im m365-configurator unter «Managed Service».</small>`;
  }
  async function createTicket(t, f, by) {
    const sdp = SDP.config();
    if (!sdp.enabled) throw Object.assign(new Error("ServiceDesk Plus ist nicht konfiguriert."), { status: 400 });
    const subject = `[Managed M365 ${t.name}] ${f.severity === "critical" ? "KRITISCH: " : ""}${f.title}`.slice(0, 240);
    const ticket = await SDP.createRequest({ subject, description: ticketBody(t, f) });
    S.updateFinding(STATE_DIR, t.id, f.id, { status: "ticket", ticketId: ticket.id, ticketAt: new Date().toISOString() }, `Ticket #${ticket.id} angelegt`, by);
    console.log(`Managed Service: Ticket #${ticket.id} fuer ${t.name} — ${f.title}`);
    return ticket;
  }

  async function autoTickets(t, events) {
    const s = S.settingsOf(t);
    if (s.autoTicket === "off" || !SDP.config().enabled) return [];
    const min = S.SEV_RANK[s.autoTicket] || S.SEV_RANK.critical;
    const cands = events.filter(e => ["new", "drift", "reopened", "escalated"].includes(e.kind) && S.SEV_RANK[e.f.severity] >= min && !e.f.ticketId && e.f.status !== "ack");
    const out = [];
    for (const e of cands.slice(0, MAX_TICKETS_PER_RUN)) {
      try { out.push(await createTicket(t, e.f, "automatisch")); }
      catch (err) { console.log("Managed Service: Auto-Ticket fehlgeschlagen: " + err.message); break; }
    }
    // Ueberlauf nicht still verschlucken: ein Sammelticket fuer den Rest.
    const rest = cands.slice(MAX_TICKETS_PER_RUN);
    if (rest.length) {
      try {
        const subject = `[Managed M365 ${t.name}] ${rest.length} weitere Befunde ab «${s.autoTicket}»`;
        const description = `<b>Sammelticket</b> — zu viele Befunde für Einzeltickets in einem Lauf.<ul>${rest.map(e => `<li>[${esc(e.f.severity)}] ${esc(e.f.title)}</li>`).join("")}</ul>`;
        const tk = await SDP.createRequest({ subject, description });
        for (const e of rest) S.updateFinding(STATE_DIR, t.id, e.f.id, { status: "ticket", ticketId: tk.id, ticketAt: new Date().toISOString() }, `Sammelticket #${tk.id}`, "automatisch");
        out.push(tk);
      } catch (err) { console.log("Managed Service: Sammelticket fehlgeschlagen: " + err.message); }
    }
    return out;
  }

  // ---------------------------------------------------------------- Teams
  async function notify(t, events) {
    const url = webhookUrl();
    if (!url) return;
    const g = globalCfg();
    const s = S.settingsOf(t);
    const min = S.SEV_RANK[s.notifyMin || g.notifyMin] ?? S.SEV_RANK.high;
    const hits = events.filter(e => ["new", "drift", "reopened", "escalated"].includes(e.kind) && S.SEV_RANK[e.f.severity] >= min);
    if (!hits.length) return;
    const col = { critical: "Attention", high: "Warning", medium: "Accent", low: "Default" };
    const kindDe = { new: "neu", drift: "Drift", reopened: "wieder offen", escalated: "eskaliert" };
    const card = {
      type: "message",
      attachments: [{
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json", type: "AdaptiveCard", version: "1.4",
          body: [
            { type: "TextBlock", text: `Managed M365 · ${t.name}`, weight: "Bolder", size: "Medium" },
            { type: "TextBlock", text: `${hits.length} Meldung(en) ab Schweregrad «${s.notifyMin || g.notifyMin}»`, isSubtle: true, spacing: "None" },
            ...hits.slice(0, 10).map(e => ({
              type: "TextBlock", wrap: true, color: col[e.f.severity] || "Default",
              text: `**${String(e.f.severity).toUpperCase()}** (${kindDe[e.kind] || e.kind}) — ${e.f.title}${e.f.ticketId ? ` · Ticket #${e.f.ticketId}` : ""}`
            })),
            ...(hits.length > 10 ? [{ type: "TextBlock", text: `… und ${hits.length - 10} weitere`, isSubtle: true }] : [])
          ]
        }
      }]
    };
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(card) });
      if (!r.ok) console.log("Managed Service: Teams-Webhook HTTP " + r.status);
    } catch (e) { console.log("Managed Service: Teams-Webhook fehlgeschlagen: " + e.message); }
  }

  // ---------------------------------------------------------------- Lauf
  const running = new Set();
  async function execute(t, areas, job) {
    running.add(t.id);
    const say = job ? appJobProgress(job) : () => {};
    try {
      const r = await S.run({ stateDir: STATE_DIR, tenant: t, cert: certPemPath(t.tenantId), areas, onProgress: say, ai: aiEnrich });
      say("Tickets & Meldungen");
      // Tenant frisch laden: Einstellungen koennen sich waehrend des Laufs geaendert haben.
      const fresh = (loadState().tenants || []).find(x => x.id === t.id) || t;
      const findings = Object.fromEntries(S.listFindings(STATE_DIR, t.id).map(f => [f.id, f]));
      const events = r.events.map(e => ({ ...e, f: findings[e.f.id] || e.f }));
      const tickets = await autoTickets(fresh, events);
      // Ticketnummern in die Meldung uebernehmen.
      const after = Object.fromEntries(S.listFindings(STATE_DIR, t.id).map(f => [f.id, f]));
      await notify(fresh, events.map(e => ({ ...e, f: after[e.f.id] || e.f })));
      if (job) {
        job.result = { ran: r.ran, failed: r.failed, events: r.events.length, tickets: tickets.map(x => x.id) };
        finishAppJob(job, true, null, r.failed.length ? "Nicht abrufbar: " + r.failed.map(a => S.AREA[a].label).join(", ") : null);
      }
      return r;
    } catch (e) {
      console.log(`Managed Service: Lauf fuer ${t.name} fehlgeschlagen: ${e.message}`);
      if (job) finishAppJob(job, false, e.message, null);
      throw e;
    } finally { running.delete(t.id); }
  }

  // Quartalsreport des Vorquartals automatisch ablegen (einmal, beim ersten Tick im neuen Quartal).
  function ensureQuarterReport(t) {
    const q = R.previousQuarter();
    const d = S.dirOf(STATE_DIR, t.id, "reports");
    const f = path.join(d, q + ".html");
    if (fs.existsSync(f)) return;
    const hist = S.readJson(S.file(STATE_DIR, t.id, "history.json"), []);
    if (!hist.some(x => x.d < R.quarterRange(R.currentQuarter()).from.slice(0, 10))) return; // keine Daten aus dem Vorquartal
    fs.writeFileSync(f, R.build(STATE_DIR, t, q, { brand: globalCfg().brand }), "utf8");
    console.log(`Managed Service: Quartalsreport ${q} fuer ${t.name} abgelegt.`);
  }

  async function tick() {
    try {
      const s = loadState();
      const now = Date.now();
      for (const t of s.tenants || []) {
        const cfg = S.settingsOf(t);
        if (!cfg.enabled || running.has(t.id)) continue;
        if (!t.organization || !t.clientId || !fs.existsSync(certPemPath(t.tenantId))) continue;
        try { ensureQuarterReport(t); } catch (e) { console.log("Managed Service: Quartalsreport-Fehler: " + e.message); }
        const status = S.readJson(S.file(STATE_DIR, t.id, "status.json"), {});
        const due = S.dueAreas(t, status, now);
        if (!due.length) continue;
        // Kein Monitoring-Lauf parallel zu einem anderen Job desselben Tenants
        // (Exchange-Sitzungen pro App sind begrenzt).
        let busy = false;
        for (const j of appJobs.values()) if (j.tenantId === t.id && j.status === "running") { busy = true; break; }
        if (busy) continue;
        console.log(`Managed Service: Zeitplan ${t.name} — ${due.join(", ")}`);
        const job = createAppJob(t, ["Vorbereitung"]);
        job.isManaged = true; job.scheduled = true;
        execute(t, due, job).catch(() => {});
        return; // ein Tenant pro Tick
      }
    } catch (e) { console.log("Managed Service: Zeitplan-Fehler: " + e.message); }
  }
  setInterval(tick, TICK_MS);
  setTimeout(tick, 2 * 60 * 1000);

  // ---------------------------------------------------------------- Routen
  const tenantOf = req => {
    const t = (loadState().tenants || []).find(x => x.id === req.params.id);
    if (!t) throw Object.assign(new Error("Tenant nicht gefunden"), { status: 404 });
    return t;
  };

  app.get("/api/managed/meta", (req, res) => {
    res.json({ ok: true, areas: S.AREAS, defaults: S.DEFAULT_SETTINGS, sla: S.SLA_HOURS, global: { ...globalCfg(), teamsWebhook: globalCfg().teamsWebhook ? "••• hinterlegt" : "" }, sdp: SDP.config().enabled, ai: AISUGGEST.config().enabled });
  });

  app.put("/api/managed/global", (req, res) => {
    const b = req.body || {};
    const s = loadState();
    const g = s.managedGlobal || {};
    if (typeof b.teamsWebhook === "string" && !b.teamsWebhook.startsWith("•")) {
      const u = b.teamsWebhook.trim();
      if (u && !/^https:\/\/[^\s]+$/i.test(u)) return res.status(400).json({ error: "Webhook muss eine https-URL sein." });
      g.teamsWebhook = u;
    }
    if (["critical", "high", "medium", "low"].includes(b.notifyMin)) g.notifyMin = b.notifyMin;
    if (typeof b.brand === "string") g.brand = b.brand.trim().slice(0, 80) || "igeeks AG";
    s.managedGlobal = g;
    saveState(s);
    res.json({ ok: true });
  });

  app.post("/api/managed/global/test", wrap(async (req, res) => {
    if (!webhookUrl()) return res.status(400).json({ error: "Kein Teams-Webhook hinterlegt." });
    await notify({ id: "_test", name: "Testmeldung", managed: { notifyMin: "low" } }, [{ kind: "new", f: { severity: "high", title: "Testmeldung aus dem Managed Service — Verbindung funktioniert." } }]);
    res.json({ ok: true });
  }));

  app.get("/api/managed/fleet", (req, res) => {
    const s = loadState();
    const rows = (s.tenants || []).map(t => ({ ...S.fleetRow(STATE_DIR, t), running: running.has(t.id) }));
    const alerts = (s.tenants || []).flatMap(t => S.readAlerts(STATE_DIR, t.id, 40)).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 80);
    res.json({ ok: true, tenants: rows, alerts });
  });

  app.get("/api/tenants/:id/managed", wrap(async (req, res) => {
    const t = tenantOf(req);
    res.json({ ok: true, running: running.has(t.id), ...S.overview(STATE_DIR, t) });
  }));

  app.get("/api/tenants/:id/managed/area/:area", wrap(async (req, res) => {
    const t = tenantOf(req);
    const d = S.areaData(STATE_DIR, t.id, req.params.area);
    if (!d) return res.status(404).json({ error: "Unbekannter Bereich" });
    res.json({ ok: true, ...d });
  }));

  app.put("/api/tenants/:id/managed/settings", (req, res) => {
    const s = loadState();
    const t = (s.tenants || []).find(x => x.id === req.params.id);
    if (!t) return res.status(404).json({ error: "Tenant nicht gefunden" });
    const b = req.body || {};
    const cur = S.settingsOf(t);
    const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : d; };
    t.managed = {
      enabled: b.enabled !== undefined ? !!b.enabled : cur.enabled,
      graphIntervalMin: num(b.graphIntervalMin, 15, 1440, cur.graphIntervalMin),
      exoIntervalHours: num(b.exoIntervalHours, 1, 168, cur.exoIntervalHours),
      autoTicket: ["off", "critical", "high"].includes(b.autoTicket) ? b.autoTicket : cur.autoTicket,
      notifyMin: ["critical", "high", "medium", "low"].includes(b.notifyMin) ? b.notifyMin : cur.notifyMin,
      maxMailboxes: num(b.maxMailboxes, 10, 5000, cur.maxMailboxes),
      areas: Array.isArray(b.areas) ? b.areas.filter(a => S.AREA[a]) : cur.areas
    };
    saveState(s);
    res.json({ ok: true, settings: t.managed });
  });

  app.post("/api/tenants/:id/managed/run", wrap(async (req, res) => {
    const t = requireTenant(req);
    if (running.has(t.id)) return res.status(409).json({ error: "Für diesen Tenant läuft bereits eine Erhebung." });
    for (const j of appJobs.values()) if (j.tenantId === t.id && j.status === "running") return res.status(409).json({ error: "Für diesen Tenant läuft bereits ein Job.", jobId: j.id });
    const areas = Array.isArray(req.body && req.body.areas) ? req.body.areas.filter(a => S.AREA[a]) : [];
    const job = createAppJob(t, ["Vorbereitung"]);
    job.isManaged = true;
    execute(t, areas.length ? areas : null, job).catch(() => {});
    res.json({ ok: true, jobId: job.id });
  }));

  app.post("/api/tenants/:id/managed/findings/:fid/action", wrap(async (req, res) => {
    const t = tenantOf(req);
    const b = req.body || {};
    const f = S.listFindings(STATE_DIR, t.id).find(x => x.id === req.params.fid);
    if (!f) return res.status(404).json({ error: "Befund nicht gefunden" });
    const note = cut(String(b.note || "").trim(), 500);
    let out;
    switch (b.action) {
      case "ack": out = S.updateFinding(STATE_DIR, t.id, f.id, { status: "ack", ackBy: who(req), ackAt: new Date().toISOString(), note: note || f.note || null }, "quittiert" + (note ? ": " + note : ""), who(req)); break;
      case "snooze": {
        const days = Math.max(1, Math.min(90, Number(b.days) || 7));
        const until = new Date(Date.now() + days * 86400000).toISOString();
        out = S.updateFinding(STATE_DIR, t.id, f.id, { status: "snoozed", snoozeUntil: until, note: note || f.note || null }, `zurückgestellt bis ${until.slice(0, 10)}`, who(req)); break;
      }
      case "reopen": out = S.updateFinding(STATE_DIR, t.id, f.id, { status: "open", snoozeUntil: null }, "wieder geöffnet", who(req)); break;
      case "note": out = S.updateFinding(STATE_DIR, t.id, f.id, { note }, "Notiz: " + note, who(req)); break;
      case "ticket": {
        if (f.ticketId) return res.status(409).json({ error: `Bereits Ticket #${f.ticketId}.` });
        const tk = await createTicket(t, f, who(req));
        out = S.listFindings(STATE_DIR, t.id).find(x => x.id === f.id);
        return res.json({ ok: true, finding: out, ticket: tk });
      }
      case "baseline": {
        if (!f.drift) return res.status(400).json({ error: "Nur Drift-Befunde lassen sich als Baseline übernehmen." });
        S.acceptBaseline(STATE_DIR, t.id, f.area, who(req), f.objId);
        out = S.listFindings(STATE_DIR, t.id).find(x => x.id === f.id);
        break;
      }
      default: return res.status(400).json({ error: "Unbekannte Aktion" });
    }
    res.json({ ok: true, finding: out });
  }));

  app.post("/api/tenants/:id/managed/baseline/:area", wrap(async (req, res) => {
    const t = tenantOf(req);
    const base = S.acceptBaseline(STATE_DIR, t.id, req.params.area, who(req));
    res.json({ ok: true, acceptedAt: base.acceptedAt });
  }));

  app.get("/api/tenants/:id/managed/reports", (req, res) => {
    const t = (loadState().tenants || []).find(x => x.id === req.params.id);
    if (!t) return res.status(404).json({ error: "Tenant nicht gefunden" });
    const d = S.dirOf(STATE_DIR, t.id, "reports");
    const list = fs.readdirSync(d).filter(f => /^\d{4}-Q[1-4]\.html$/.test(f)).map(f => ({ quarter: f.replace(".html", ""), at: fs.statSync(path.join(d, f)).mtime.toISOString() }))
      .sort((a, b) => b.quarter.localeCompare(a.quarter));
    res.json({ ok: true, reports: list, current: R.currentQuarter(), previous: R.previousQuarter() });
  });

  // ?quarter=2026-Q3 — live erzeugen; ?stored=1 liefert die abgelegte Fassung; ?save=1 legt ab.
  app.get("/api/tenants/:id/managed/report", wrap(async (req, res) => {
    const t = tenantOf(req);
    const q = String(req.query.quarter || R.currentQuarter());
    R.quarterRange(q);
    const f = path.join(S.dirOf(STATE_DIR, t.id, "reports"), q + ".html");
    let html;
    if (req.query.stored && fs.existsSync(f)) html = fs.readFileSync(f, "utf8");
    else {
      html = R.build(STATE_DIR, t, q, { brand: globalCfg().brand });
      if (req.query.save) fs.writeFileSync(f, html, "utf8");
    }
    res.set("content-type", "text/html; charset=utf-8");
    if (req.query.download) res.set("content-disposition", `attachment; filename="Managed-M365_${String(t.name).replace(/[^A-Za-z0-9_-]+/g, "-")}_${q}.html"`);
    res.send(html);
  }));
}

module.exports = { register };
