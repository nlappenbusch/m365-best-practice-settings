"use strict";

/**
 * Evidence 3.0 analysis/correlation.
 *
 * Server-side on purpose: risk and baseline conclusions must not depend on the
 * browser. Raw Evidence stays unchanged; this module writes annotations next to
 * deduplicated events.
 */
const STORE = require("./evidenceStore");

function hay(event) {
  return [
    event.source, event.activity, event.operation, event.category, event.actor, event.app,
    ...(event.targets || []).flatMap(t => [
      t.id, t.name, t.type,
      ...(t.changes || []).flatMap(c => [c.name, c.old, c.new])
    ])
  ].filter(Boolean).join(" ").toLowerCase();
}
function risk(event, resource) {
  const h = hay(event);
  const baselineViolation = resource && resource.snapshot && resource.snapshot.baseline && resource.snapshot.baseline.compliant === false;

  if (/conditional access|conditionalaccess/.test(h) &&
      /(disable|disabled|state|exclude|grantcontrols|conditions)/.test(h)) {
    return {
      level: baselineViolation ? "critical" : "high",
      score: baselineViolation ? 98 : 86,
      reason: baselineViolation ? "Conditional Access geändert und Baseline-Abweichung erkannt" : "Sicherheitskritische Conditional-Access-Änderung"
    };
  }
  if (/global administrator|privileged role|role assignment|directory role/.test(h)) {
    return { level: "critical", score: 94, reason: "Privilegierte Berechtigung geändert" };
  }
  if (/consent|oauth|service principal|application permission|app role assignment/.test(h)) {
    return { level: "high", score: 84, reason: "App-/Consent-Berechtigung geändert" };
  }
  if (/authentication method|mfa|passwordless|fido|temporary access pass/.test(h)) {
    return { level: "high", score: 80, reason: "Authentifizierung geändert" };
  }
  if (/delete|remove|harddelete|softdelete|recycle/.test(h)) {
    return { level: "high", score: 78, reason: "Objekt entfernt" };
  }
  if (/intune|device management/.test(h) && /assignment|assign|compliance|configuration|policy/.test(h)) {
    return { level: baselineViolation ? "high" : "medium", score: baselineViolation ? 82 : 60, reason: "Intune-Konfiguration geändert" };
  }
  if (/update|change|set|modify|add|create|enable|disable/.test(h)) {
    return { level: baselineViolation ? "high" : "medium", score: baselineViolation ? 80 : 48, reason: "Konfiguration geändert" };
  }
  return { level: "info", score: 10, reason: "Audit-Ereignis" };
}

function objectRefs(event) {
  return (event.targets || []).flatMap(t => [t.id, t.name]).filter(Boolean).map(x => String(x).toLowerCase());
}
function correlateRegister(event, resource, registerEntries) {
  const refs = new Set(objectRefs(event));
  if (resource) {
    refs.add(String(resource.resourceId || "").toLowerCase());
    refs.add(String(resource.name || "").toLowerCase());
  }
  const matches = (registerEntries || []).filter(e => {
    if (!e || !e.objectType) return false;
    const id = String(e.objectId || "").toLowerCase();
    const name = String(e.objectName || "").toLowerCase();
    if (id && refs.has(id)) return true;
    if (name && refs.has(name)) return true;
    // exact target-id match is preferred, but older comments often only carry
    // the policy name. Conservative substring matching only for names >= 8 chars.
    if (name.length >= 8) return [...refs].some(r => r.length >= 8 && (r.includes(name) || name.includes(r)));
    return false;
  });
  return matches.map(e => ({
    id: e.id,
    objectType: e.objectType,
    objectId: e.objectId || null,
    objectName: e.objectName || "",
    text: e.text || "",
    decision: !!e.decision,
    ref: e.ref || null,
    author: e.author || "",
    date: e.date || null
  }));
}
function impactOf(resource) {
  const s = resource && resource.snapshot;
  if (!s) return null;
  const i = s.impact || {};
  return {
    users: Number.isFinite(i.users) ? i.users : null,
    guests: Number.isFinite(i.guests) ? i.guests : null,
    disabledUsers: Number.isFinite(i.disabledUsers) ? i.disabledUsers : null,
    sampleUsers: Array.isArray(i.sampleUsers) ? i.sampleUsers.slice(0, 20) : [],
    source: i.source || null
  };
}

function oldNewState(event) {
  for (const t of event.targets || []) for (const c of t.changes || []) {
    if (/state|enabled|status/i.test(String(c.name || ""))) {
      return { field: c.name, before: c.old || null, after: c.new || null };
    }
  }
  return null;
}
function remediationOf(event, resource, analysisRisk) {
  const h = hay(event);
  const state = oldNewState(event);
  const baseline = resource && resource.snapshot && resource.snapshot.baseline;

  if (/conditional access|conditionalaccess/.test(h)) {
    const proposal = {
      kind: "conditional-access-review",
      requiresApproval: true,
      resourceId: resource && resource.resourceId || (event.targets && event.targets[0] && event.targets[0].id) || null,
      resourceName: resource && resource.name || (event.targets && event.targets[0] && event.targets[0].name) || null,
      route: "ca"
    };
    if (state && /enabled/i.test(String(state.before || "")) && /disabled/i.test(String(state.after || ""))) {
      proposal.suggestedAction = "Vorherigen Aktivierungszustand prüfen und bei unbeabsichtigter Änderung wiederherstellen.";
      proposal.proposed = { state: state.before };
    } else if (baseline && baseline.compliant === false) {
      proposal.suggestedAction = "Policy gegen die dokumentierte Baseline und den letzten konformen Snapshot prüfen.";
    } else {
      proposal.suggestedAction = "Änderung fachlich prüfen; bei Absicht als Entscheid dokumentieren, sonst vorherigen Snapshot als Referenz verwenden.";
    }
    return proposal;
  }

  if (analysisRisk.level === "critical" || analysisRisk.level === "high") {
    return {
      kind: "review",
      requiresApproval: true,
      suggestedAction: "Änderung prüfen, Ticket/Entscheid referenzieren und nur bei fehlender Freigabe zurückbauen.",
      route: "changes"
    };
  }
  return null;
}

function analyzeEvent(stateDir, tenantRecId, event, opts) {
  opts = opts || {};
  // CA is the first deep snapshot vertical. Generic event analysis still works
  // for every other source and gains resource correlation as more snapshot
  // collectors are added.
  let resource = STORE.matchLatestResource(stateDir, tenantRecId, event, "conditionalAccessPolicy");
  const r = risk(event, resource);
  const register = correlateRegister(event, resource, opts.registerEntries || []);
  const baseline = resource && resource.snapshot && resource.snapshot.baseline || null;
  const impact = impactOf(resource);
  const ticketRefs = [...new Set(register.map(x => x.ref).filter(Boolean))];

  const analysis = {
    analyzedAt: new Date().toISOString(),
    risk: r,
    resource: resource ? {
      type: resource.resourceType,
      id: resource.resourceId,
      name: resource.name,
      snapshotHash: resource.hash,
      snapshotObservedAt: resource.observedAt
    } : null,
    baseline: baseline ? {
      version: baseline.version || null,
      compliant: baseline.compliant !== false,
      findings: baseline.findings || [],
      statement: baseline.statement || null
    } : null,
    impact,
    register,
    ticket: {
      found: ticketRefs.length > 0,
      refs: ticketRefs,
      source: ticketRefs.length ? "decision-register" : null
    },
    remediation: remediationOf(event, resource, r)
  };
  STORE.annotate(stateDir, tenantRecId, event.eventId, analysis);
  return analysis;
}

function analyzeEvents(stateDir, tenantRecId, eventIds, opts) {
  const wanted = new Set(eventIds || []);
  const events = STORE.listEvents(stateDir, tenantRecId, { days: 730, limit: 5000 })
    .filter(e => !wanted.size || wanted.has(e.eventId));
  return events.map(e => ({ eventId: e.eventId, analysis: analyzeEvent(stateDir, tenantRecId, e, opts) }));
}

/** Translate the rich CA audit into generic snapshot resources. */
function caResources(audit, baselineMeta) {
  const version = baselineMeta && baselineMeta.version || null;
  return (audit && audit.policies || []).map(p => {
    const hard = (p.findings || []).filter(f => ["fehler", "warn", "critical", "high"].includes(String(f.severity || "").toLowerCase()));
    const compliant = hard.length === 0;
    return {
      id: p.id,
      name: p.name,
      data: p,
      baseline: {
        version,
        compliant,
        findings: hard,
        statement: compliant
          ? "Keine technische Abweichung aus den aktuell codierten CA-Sicherheitsregeln erkannt."
          : `${hard.length} Abweichung(en) von den aktuell codierten CA-Sicherheitsregeln.`
      },
      impact: {
        users: p.scope && Number.isFinite(p.scope.effective) ? p.scope.effective : null,
        guests: p.scope && Number.isFinite(p.scope.guests) ? p.scope.guests : null,
        disabledUsers: p.scope && Number.isFinite(p.scope.disabled) ? p.scope.disabled : null,
        sampleUsers: (p.effectiveUsers || []).slice(0, 20),
        source: "conditional-access-scope"
      }
    };
  });
}

module.exports = { risk, analyzeEvent, analyzeEvents, caResources, correlateRegister };
