"use strict";

/**
 * Execution adapter.
 *
 * The product owns the domain logic. Semaphore UI is optional infrastructure:
 * schedules, runners, PowerShell/Terraform/OpenTofu execution and run history.
 * No Semaphore credential or internal URL is ever returned to the browser.
 *
 * A started template receives one JSON envelope in the task message. Semaphore
 * exposes that message to Shell/PowerShell/Python tasks as
 * SEMAPHORE_TASK_DETAILS_MESSAGE, so templates can parse tenant/action/payload
 * without this application depending on template-specific variable names.
 */

function config() {
  const baseUrl = String(process.env.SEMAPHORE_URL || "").trim().replace(/\/+$/, "");
  const token = String(process.env.SEMAPHORE_API_TOKEN || "").trim();
  const projectId = Number(process.env.SEMAPHORE_PROJECT_ID || 0);
  return {
    baseUrl,
    token,
    projectId: Number.isInteger(projectId) && projectId > 0 ? projectId : null,
    configured: !!(baseUrl && token && Number.isInteger(projectId) && projectId > 0)
  };
}

function publicStatus() {
  const c = config();
  return {
    provider: c.configured ? "semaphore" : "local",
    local: { enabled: true },
    semaphore: {
      configured: c.configured,
      projectId: c.projectId
    }
  };
}

async function request(path, opts) {
  const c = config();
  if (!c.configured) {
    const e = new Error("Semaphore UI ist nicht konfiguriert.");
    e.status = 503;
    e.hint = "SEMAPHORE_URL, SEMAPHORE_API_TOKEN und SEMAPHORE_PROJECT_ID setzen.";
    throw e;
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(c.baseUrl + path, {
      method: (opts && opts.method) || "GET",
      headers: {
        Authorization: "Bearer " + c.token,
        Accept: "application/json",
        ...((opts && opts.body) ? { "Content-Type": "application/json" } : {})
      },
      body: opts && opts.body ? JSON.stringify(opts.body) : undefined,
      signal: ctl.signal
    });
    const txt = await r.text();
    let data;
    try { data = txt ? JSON.parse(txt) : {}; } catch (e) { data = { raw: txt }; }
    if (!r.ok) {
      const msg = (data && (data.message || data.error)) || `Semaphore HTTP ${r.status}`;
      const e = new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
      e.status = r.status >= 500 ? 502 : r.status;
      throw e;
    }
    return data;
  } catch (e) {
    if (e.name === "AbortError") {
      const x = new Error("Semaphore UI antwortet nicht innerhalb von 20 Sekunden.");
      x.status = 504;
      throw x;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function templates() {
  const c = config();
  const data = await request(`/api/project/${c.projectId}/templates`);
  const list = Array.isArray(data) ? data : (Array.isArray(data.templates) ? data.templates : []);
  return list.map(t => ({
    id: t.id,
    name: t.name || t.alias || ("Template " + t.id),
    description: t.description || "",
    app: t.app || t.type || null,
    playbook: t.playbook || null
  })).filter(t => t.id != null);
}

async function runTemplate(templateId, context) {
  const c = config();
  const id = Number(templateId);
  if (!Number.isInteger(id) || id <= 0) {
    const e = new Error("Ungültige Semaphore-Template-ID.");
    e.status = 400;
    throw e;
  }
  const envelope = {
    version: 1,
    source: "m365-control-plane",
    ...context
  };
  return request(`/api/project/${c.projectId}/tasks`, {
    method: "POST",
    body: {
      template_id: id,
      message: JSON.stringify(envelope)
    }
  });
}

async function task(taskId) {
  const c = config();
  return request(`/api/project/${c.projectId}/tasks/${encodeURIComponent(taskId)}`);
}

module.exports = { config, publicStatus, templates, runTemplate, task };
