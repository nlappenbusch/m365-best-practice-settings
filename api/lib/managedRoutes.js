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
const STANDPDF = require("./managedStandPdf");
const AI = require("./aiProviders");
const MCAI = require("./mcAi");
const { cut } = require("./managedCollectors");
const ACCESS = require('./tenantAccess');
const ALARM = require('./alarmEngine');
const { NotificationWorker } = require('./notificationWorker');
const { DurableWorker } = require('./durableWorker');

const TICK_MS = 30 * 1000;
const MAX_TICKETS_PER_RUN = 8;

function register(app, deps) {
  const { STATE_DIR, loadState, saveState, certPemPath, requireTenant, wrap, createAppJob, appJobProgress, finishAppJob, appJobs, SDP, AISUGGEST, platform, jobSummary } = deps;
  const who = req => (req.session && req.session.user) || "unbekannt";
  const globalCfg = () => ({ teamsWebhook: "", notifyMin: "high", brand: "igeeks AG", ...((loadState().managedGlobal) || {}), envWebhook: !!process.env.MANAGED_TEAMS_WEBHOOK });
  const webhookUrl = () => process.env.MANAGED_TEAMS_WEBHOOK || (loadState().managedGlobal || {}).teamsWebhook || "";
  const notifications = new NotificationWorker(platform,loadState).start();
  // Import timestamps for all existing tenants, including disabled schedules. Never invent a fresh success.
  for(const t of loadState().tenants||[]){const cfg=S.settingsOf(t),old=S.readJson(S.file(STATE_DIR,t.id,'status.json'),{});for(const a of S.AREAS){const s=old[a.id];if(!s)continue;const interval=a.engine==='exo'?cfg.exoIntervalHours*3600000:(a.intervalMin||cfg.graphIntervalMin)*60000;platform.db.prepare('INSERT OR IGNORE INTO sync_state(tenant_id,source,attempt_at,success_at,next_at,status,error) VALUES(?,?,?,?,?,?,?)').run(t.id,a.id,Date.parse(s.at)||null,Date.parse(s.lastOkAt||(s.ok?s.at:''))||null,(Date.parse(s.at)||0)+interval,s.ok?'ok':'error',s.error||null)}}

  // ---------------------------------------------------------------- KI-Einordnung Message Center
  // Relevanz je Kunde ueber den KI-Dienst des Zwecks «messages» (lib/mcAi.js).
  // Ergebnis je Meldung gecacht (Aenderungsstand + Kundenprofil).
  async function aiEnrich(tenant, messages, facts, cache, force) {
    return MCAI.evaluate({ tenant, messages, facts, cache, note: S.settingsOf(tenant).profileNote, force });
  }

  // ---------------------------------------------------------------- Tickets
  const esc = x => String(x == null ? "" : x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  function ticketBody(t, f) {
    return `<b>Managed Service — automatisch erkannter Befund</b><br>` +
      `Tenant: ${esc(t.name)} (${esc(t.organization || "")})<br>` +
      `Bereich: ${esc((S.AREA[f.area] || {}).label || f.area)} · Schweregrad: <b>${esc(f.severity)}</b> · erkannt ${esc(String(f.firstSeen).slice(0, 16).replace("T", " "))}<br><br>` +
      `<b>${esc(f.title)}</b><br>${esc(f.summary || "")}<br><br>` +
      ((f.context || []).length ? `<b>Kontext</b><ul>${f.context.map(([k, v]) => `<li>${esc(k)}: ${esc(v)}</li>`).join("")}</ul>` : "") +
      ((f.diff || []).length ? `<b>Abweichung zum eingefrorenen Stand</b><ul>${f.diff.slice(0, 15).map(d => `<li>${esc(d.path)}: ${esc(d.old)} → ${esc(d.new)}</li>`).join("")}</ul>` : "") +
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
    const cands = events.filter(e => !e.f.eventFinding && ["new", "drift", "reopened", "escalated"].includes(e.kind) && S.SEV_RANK[e.f.severity] >= min && !e.f.ticketId && e.f.status !== "ack");
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
  async function notify(t, events, deliveryKey) {
    const url = webhookUrl();
    deliveryKey ||= require('crypto').randomUUID();
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
            { type: 'TextBlock',text: 'Meldungs-ID: '+deliveryKey,isSubtle:true,wrap:true },
            ...(hits.length > 10 ? [{ type: "TextBlock", text: `… und ${hits.length - 10} weitere`, isSubtle: true }] : [])
          ]
        }
      }]
    };
    ALARM.enqueue(platform,t.id,deliveryKey,url,card);
  }

  // ---------------------------------------------------------------- Lauf
  const running = new Set();
  async function execute(t, areas, job, control) {
    running.add(t.id);
    const say = job ? appJobProgress(job) : () => {};
    try {
      let checkpoint=control.persisted.checkpoint;
      let r;
      if(checkpoint?.collectionCompleted){const byId=Object.fromEntries(S.listFindings(STATE_DIR,t.id).map(f=>[f.id,f]));r={ran:checkpoint.ran,failed:checkpoint.failed,events:checkpoint.events.map(e=>({kind:e.kind,f:byId[e.id]})).filter(e=>e.f)};}
      else {
        r = await require('./graph').withSignal(control.signal,()=>S.run({ stateDir: STATE_DIR, tenant: t, cert: certPemPath(t.tenantId), areas, onProgress: say, ai: aiEnrich, platform, signal:control.signal,assertLease:control.assertLease }));
        checkpoint={collectionCompleted:true,ran:r.ran,failed:r.failed,events:r.events.map(e=>({kind:e.kind,id:e.f.id})),effectsStarted:false,effectsCompleted:false};control.progress(jobSummary(job),checkpoint);
      }
      control.assertLease();
      say("Tickets & Meldungen");
      // Tenant frisch laden: Einstellungen koennen sich waehrend des Laufs geaendert haben.
      const fresh = (loadState().tenants || []).find(x => x.id === t.id) || t;
      ALARM.evaluate(platform,fresh,S.listFindings(STATE_DIR,t.id),S.readJson(S.file(STATE_DIR,t.id,'status.json'),{}),S.AREAS,webhookUrl());
      const findings = Object.fromEntries(S.listFindings(STATE_DIR, t.id).map(f => [f.id, f]));
      const events = r.events.map(e => ({ ...e, f: findings[e.f.id] || e.f }));
      const rules=(fresh.cockpit?.rules||[]).filter(r=>r.enabled&&r.notify===true);
      const directEvents=events.filter(e=>!['defender','directoryAudit'].includes(e.f.area)&&!rules.some(r=>r.kind!=='audit'&&(!r.area||r.area===e.f.area)));
      await notify(fresh,directEvents,'managed:'+job.id);
      const uncertain=checkpoint.effectsStarted&&!checkpoint.effectsCompleted;
      let tickets=[];
      if(!checkpoint.effectsStarted){
      checkpoint.effectsStarted=true;control.progress(jobSummary(job),checkpoint);
      tickets = await autoTickets(fresh, events);

      checkpoint.effectsCompleted=true;control.progress(jobSummary(job),checkpoint);
      }
      if (job) {
        job.result = { ran: r.ran, failed: r.failed, events: r.events.length, tickets: tickets.map(x => x.id) };
        finishAppJob(job, true, null, r.failed.length ? "Nicht abrufbar: " + r.failed.map(a => S.AREA[a].label).join(", ") : null);
      }
      return {partial:r.failed.length>0||uncertain,warning:uncertain?'Ticketanlage nach Worker-Unterbrechung unbestätigt; keine automatische Wiederholung. Teams-Zustellung separat prüfen.':r.failed.length?'Nicht abrufbar: '+r.failed.join(', '):null};
    } catch (e) {
      console.log(`Managed Service: Lauf fuer ${t.name} fehlgeschlagen: ${e.message}`);
      if (job) finishAppJob(job, false, e.message, null);
      throw e;
    } finally { running.delete(t.id); }
  }

  const worker=new DurableWorker(platform,async(persisted,control)=>{
    const t=(loadState().tenants||[]).find(t=>t.id===persisted.tenant_id);
    if(!t)throw new Error('Tenant wurde entfernt.');
    if(persisted.payload.scheduled&&!S.settingsOf(t).enabled)throw new Error('Monitoring wurde deaktiviert.');
    if(!persisted.payload.scheduled&&!ACCESS.allowed(platform.access(persisted.actor),t.id,'operator'))throw Object.assign(new Error('Ausführungsberechtigung wurde entzogen.'),{status:403});
    if(!t.organization||!fs.existsSync(certPemPath(t.tenantId)))throw new Error('Tenant-Verbindung oder Zertifikat fehlt.');
    const job={id:persisted.id,tenantId:t.id,tenantName:t.name,status:'running',phase:'Vorbereitung',steps:[],isManaged:true,startedAt:new Date().toISOString(),...persisted.summary};
    job._durableProgress=control.progress;appJobs.set(job.id,job);
    const assertLease=()=>{control.signal.throwIfAborted();const current=platform.job(job.id);if(current?.lease_owner!==control.owner||current?.status!=='running'||current.lease_until<=Date.now())throw new Error('Worker-Lease verloren.');};
    try{return await execute(t,persisted.payload.areas,job,{...control,persisted,assertLease})}finally{appJobs.delete(job.id)}
  },{concurrency:2,blockedTenants:()=>[...appJobs.values()].filter(j=>j.status==='running'&&!j.isManaged).map(j=>j.tenantId)}).start();

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
        if (!cfg.enabled || platform.jobs().some(j=>j.tenant_id===t.id&&['queued','running','retry'].includes(j.status))) continue;
        if (!t.organization || !t.clientId || !fs.existsSync(certPemPath(t.tenantId))) continue;
        try { ensureQuarterReport(t); } catch (e) { console.log("Managed Service: Quartalsreport-Fehler: " + e.message); }
        const status = S.readJson(S.file(STATE_DIR, t.id, "status.json"), {});
        const sync=Object.fromEntries(platform.sync(t.id).map(s=>[s.source,s]));
        for(const a of S.AREAS){if(!sync[a.id]&&status[a.id]){const old=status[a.id],interval=a.engine==='exo'?cfg.exoIntervalHours*3600000:(a.intervalMin||cfg.graphIntervalMin)*60000;platform.db.prepare('INSERT OR IGNORE INTO sync_state(tenant_id,source,attempt_at,success_at,next_at,status,error) VALUES(?,?,?,?,?,?,?)').run(t.id,a.id,Date.parse(old.at)||null,Date.parse(old.lastOkAt||(old.ok?old.at:''))||null,(Date.parse(old.at)||0)+interval,old.ok?'ok':'error',old.error||null)}}
        const latest=Object.fromEntries(platform.sync(t.id).map(s=>[s.source,s]));
        const configured=new Set(cfg.areas?.length?cfg.areas:S.AREAS.map(a=>a.id));
        const due=S.AREAS.filter(a=>configured.has(a.id)&&(!latest[a.id]||latest[a.id].next_at<=now)).map(a=>a.id);
        if (!due.length) continue;
        // Kein Monitoring-Lauf parallel zu einem anderen Job desselben Tenants
        // (Exchange-Sitzungen pro App sind begrenzt).
        let busy = false;
        for (const j of appJobs.values()) if (j.tenantId === t.id && j.status === "running") { busy = true; break; }
        if (busy) continue;
        console.log(`Managed Service: Zeitplan ${t.name} — ${due.join(", ")}`);
        platform.enqueue(t,due,'system:scheduler',true);
      }
    } catch (e) { console.log("Managed Service: Zeitplan-Fehler: " + e.message); }
  }
  const scheduler=setInterval(tick,TICK_MS);scheduler.unref?.();
  const initial=setTimeout(tick,1000);initial.unref?.();

  // ---------------------------------------------------------------- Routen
  const tenantOf = req => {
    const t = (loadState().tenants || []).find(x => x.id === req.params.id);
    if (!t) throw Object.assign(new Error("Tenant nicht gefunden"), { status: 404 });
    return t;
  };

  app.get("/api/managed/meta", (req, res) => {
    res.json({ ok: true, areas: S.AREAS, defaults: S.DEFAULT_SETTINGS, sla: S.SLA_HOURS, global: { ...globalCfg(), teamsWebhook: globalCfg().teamsWebhook ? "••• hinterlegt" : "" }, sdp: SDP.config().enabled, ai: AI.enabledFor("messages") });
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
    await notify({ id: "_test", name: "Testmeldung", managed: { notifyMin: "low" } }, [{ kind: "new", f: { severity: "high", title: "Testmeldung aus dem Managed Service" } }]);
    res.json({ ok: true, queued:true });
  }));

  app.get("/api/managed/fleet", (req, res) => {
    const s = loadState();
    const visible=ACCESS.filtered(req.access,s.tenants || []);
    const rows = visible.map(t => ({ ...S.fleetRow(STATE_DIR, t), running: running.has(t.id) }));
    const alerts = visible.flatMap(t => S.readAlerts(STATE_DIR, t.id, 40)).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 80);
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
      areas: Array.isArray(b.areas) ? b.areas.filter(a => S.AREA[a]) : cur.areas,
      // Kundennotiz fuer die KI-Einordnung (Branche, Groesse, was genutzt wird).
      profileNote: typeof b.profileNote === "string" ? b.profileNote.trim().slice(0, 1500) : (cur.profileNote || "")
    };
    saveState(s);
    res.json({ ok: true, settings: t.managed });
  });

  app.post("/api/tenants/:id/managed/run", wrap(async (req, res) => {
    const t = requireTenant(req);
    if(req.body?.areas!==undefined && (!Array.isArray(req.body.areas)||req.body.areas.some(a=>!S.AREA[a])))return res.status(400).json({error:'Unbekannter Sync-Bereich.'});
    if (running.has(t.id)) return res.status(409).json({ error: "Für diesen Tenant läuft bereits eine Erhebung." });
    for (const j of appJobs.values()) if (j.tenantId === t.id && j.status === "running" && !j.isManaged) return res.status(409).json({ error: "Für diesen Tenant läuft bereits ein Job.", jobId: j.id });
    const areas = Array.isArray(req.body && req.body.areas) ? req.body.areas.filter(a => S.AREA[a]) : [];
    const job = platform.enqueue(t,areas.length?areas:S.AREAS.map(a=>a.id),who(req));
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
        if (!f.drift) return res.status(400).json({ error: "Nur Drift-Befunde lassen sich in den Stand übernehmen." });
        // Die Notiz ist hier die Pflicht-Begruendung — sie steht danach im Stand-Dokument.
        const ver = S.acceptBaseline(STATE_DIR, t.id, f.area, who(req), f.objId, note);
        out = S.listFindings(STATE_DIR, t.id).find(x => x.id === f.id);
        return res.json({ ok: true, finding: out, stand: { v: ver.v } });
      }
      default: return res.status(400).json({ error: "Unbekannte Aktion" });
    }
    res.json({ ok: true, finding: out });
  }));

  // ---------------------------------------------------------------- Stand (eingefrorener Ist-Zustand)
  // Schreibt ausschliesslich nach STATE_DIR/managed/<tenant>/stand/ (managedStand.js) —
  // nie in die globale igeeks-Baseline und nie in tenant.acceptedDeviations.
  app.post("/api/tenants/:id/managed/baseline/:area", wrap(async (req, res) => {
    const t = tenantOf(req);
    const ver = S.acceptBaseline(STATE_DIR, t.id, req.params.area, who(req), null, (req.body || {}).reason);
    console.log(`Managed Service: Stand v${ver.v} fuer ${t.name} — Bereich ${req.params.area} uebernommen (${who(req)}).`);
    res.json({ ok: true, v: ver.v, acceptedAt: ver.at });
  }));

  app.get("/api/tenants/:id/managed/stand", wrap(async (req, res) => {
    const t = tenantOf(req);
    res.json({ ok: true, ...S.standOverview(STATE_DIR, t.id) });
  }));

  app.post("/api/tenants/:id/managed/stand", wrap(async (req, res) => {
    const t = tenantOf(req);
    if (running.has(t.id)) return res.status(409).json({ error: "Gerade läuft eine Erhebung — danach einfrieren, sonst ist der Stand halb alt, halb neu." });
    const ver = S.freezeStand(STATE_DIR, t.id, who(req), (req.body || {}).reason);
    console.log(`Managed Service: Stand v${ver.v} fuer ${t.name} eingefroren (${who(req)}).`);
    res.json({ ok: true, v: ver.v, at: ver.at });
  }));

  // ?drift=1 haengt die Abweichungen zum zuletzt erhobenen Ist an (Drift-Bericht).
  app.get("/api/tenants/:id/managed/stand/:v/pdf", wrap(async (req, res) => {
    const t = tenantOf(req);
    const v = req.params.v === "current" ? null : Number(req.params.v);
    const d = S.standDocument(STATE_DIR, t.id, v, !!req.query.drift);
    if (!d) return res.status(404).json({ error: "Keine Stand-Version vorhanden." });
    const pdf = await STANDPDF.build(t, d);
    const kind = req.query.drift ? "Drift-Bericht" : "Stand";
    res.set("content-type", "application/pdf");
    res.set("content-disposition", `attachment; filename="${kind}_${String(t.name).replace(/[^A-Za-z0-9_-]+/g, "-")}_v${d.ver.v}${req.query.drift ? "_" + new Date().toISOString().slice(0, 10) : ""}.pdf"`);
    res.send(pdf);
  }));

  // Kundenprofil, wie die KI es sieht: automatisch erkannt + Notiz des Betreuers.
  app.get("/api/tenants/:id/managed/profile", wrap(async (req, res) => {
    const t = tenantOf(req);
    const status = S.readJson(S.file(STATE_DIR, t.id, "status.json"), {});
    const facts = status._facts || {};
    res.json({ ok: true, lines: MCAI.profileLines(t, facts), note: S.settingsOf(t).profileNote || "", collectedAt: (status.messages && status.messages.at) || status._lastRun || null,
      gaps: [!(facts.org && facts.org.readable) && "Firmenname/Domains nicht lesbar", facts.usage && !facts.usage.readable && `Nutzung nicht lesbar${facts.usage.error ? " (" + facts.usage.error + ")" : ""}`].filter(Boolean) });
  }));

  // ---------------------------------------------------------------- Message Center neu bewerten
  // Nur KI, kein Graph-Abruf: nimmt die zuletzt erhobenen Meldungen und Fakten.
  // Laeuft als Hintergrund-Job (mehrere KI-Aufrufe dauern Minuten — eine
  // einzelne Anfrage wuerde am Proxy-Timeout scheitern) und sichert nach jedem
  // Stapel, damit Ergebnisse schon waehrend der Arbeit erscheinen.
  const mcAiJobs = new Map();   // tenantRecId -> jobId
  const runningMcAi = tid => { const j = appJobs.get(mcAiJobs.get(tid)); return j && j.status === "running" ? j : null; };

  app.get("/api/tenants/:id/managed/messages/ai", wrap(async (req, res) => {
    const t = tenantOf(req);
    const j = runningMcAi(t.id);
    res.json({ ok: true, jobId: j ? j.id : null, ai: AI.enabledFor("messages") });
  }));

  app.post("/api/tenants/:id/managed/messages/ai", wrap(async (req, res) => {
    const t = tenantOf(req);
    const already = runningMcAi(t.id);
    if (already) return res.json({ ok: true, jobId: already.id, already: true });
    if (!AI.enabledFor("messages")) return res.status(400).json({ error: "Kein KI-Dienst für das Message Center eingerichtet (Service-Cockpit → KI-Dienste)." });
    const df = path.join(S.dirOf(STATE_DIR, t.id, "data"), "messages.json");
    const data = S.readJson(df, null);
    if (!data || !Array.isArray(data.messages)) return res.status(409).json({ error: "Message Center noch nicht erhoben." });
    const status = S.readJson(S.file(STATE_DIR, t.id, "status.json"), {});
    const cf = S.file(STATE_DIR, t.id, "mc-ai.json");
    const cache = S.readJson(cf, {});
    const job = createAppJob(t, ["KI-Einordnung"]);
    job.isManaged = true;
    job.mcAi = { done: 0, total: 0, provider: null, errors: [] };
    mcAiJobs.set(t.id, job.id);
    const persist = updated => {
      S.writeJson(cf, updated);
      for (const m of data.messages) if (updated[m.id] && updated[m.id].modified === m.modified) m.ai = updated[m.id].ai;
      delete data.aiError;
      S.writeJson(df, data);
    };
    (async () => {
      try {
        const updated = await MCAI.evaluate({
          tenant: t, messages: data.messages, facts: status._facts || {}, cache, note: S.settingsOf(t).profileNote,
          force: !!(req.body && req.body.force), max: 150,
          onProgress: p => { job.mcAi = p; job.phase = `KI bewertet ${p.done} von ${p.total}${p.provider ? " · " + p.provider : ""}`; },
          onBatch: persist
        });
        if (updated) persist(updated);
        const errs = job.mcAi.errors || [];
        finishAppJob(job, true, null, errs.length ? "Teilweise fehlgeschlagen: " + errs[errs.length - 1] : null);
        console.log(`Managed Service: KI-Einordnung ${t.name} — ${job.mcAi.done}/${job.mcAi.total} bewertet${errs.length ? ", Fehler: " + errs[errs.length - 1] : ""}.`);
      } catch (e) {
        data.aiError = e.message;
        try { S.writeJson(df, data); } catch (e2) { /* Anzeige des Fehlers optional */ }
        finishAppJob(job, false, e.message, null);
        console.log(`Managed Service: KI-Einordnung ${t.name} fehlgeschlagen: ${e.message}`);
      }
    })();
    res.json({ ok: true, jobId: job.id });
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
  return {worker,stop:async()=>{clearInterval(scheduler);clearTimeout(initial);await worker.stop();await notifications.stop()}};
}

module.exports = { register };
