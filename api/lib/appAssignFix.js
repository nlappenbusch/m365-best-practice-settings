"use strict";
/**
 * App-Zuweisungs-Fixer: stellt Apps, die direkt an einer Gerätegruppe hängen,
 * auf das Konzept um —
 *
 *     App  ->  App-Gruppe (nach Namenskonvention)  ->  GroupTag-Gerätegruppe (verschachtelt)
 *
 * Pro App in dieser Reihenfolge, damit kein Gerät zwischendurch aus der
 * Zuweisung fällt:
 *   1. App-Gruppe finden oder anlegen
 *   2. die bisher direkt zugewiesenen Gerätegruppen darin verschachteln
 *   3. Zuweisungsliste der App in EINEM Schritt ersetzen: App-Gruppe mit
 *      demselben Intent, Filter und denselben Einstellungen rein, die
 *      Direktzuweisungen raus (POST /assign ersetzt die komplette Liste —
 *      alle übrigen Zuweisungen werden 1:1 mit ihren Einstellungen übernommen)
 *   4. nachlesen und prüfen
 *
 * Ein kurzzeitig nicht adressiertes Gerät würde eine erforderliche App nicht
 * deinstallieren — Intune entfernt Apps nur bei einer Deinstallations-Zuweisung.
 * Deinstallations-Zuweisungen fasst der Fixer deshalb auch nie an.
 *
 * Jede Ausführung landet mit der Zuweisungsliste VORHER und NACHHER im Protokoll
 * (state/appassign-log/<tenant>.json). "Rückgängig" schreibt die Liste von vorher
 * zurück; angelegte Gruppen und Verschachtelungen bleiben stehen — sie stören
 * nicht und wären beim nächsten Versuch ohnehin wieder nötig.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { graphReq } = require("./graph");
const APPGROUPS = require("./appGroups");
const AUDIT = require("./assignAudit");

const BETA = { beta: true, retryTransient: 4 };

// ============================================================== Planen
function planForApp(app, existingAppGroups, tenantId) {
  const incl = app.assignments.filter(a => !a.exclude);
  const directDevice = incl.filter(a => a.group && a.group.kind === "deviceGroup" && a.intent !== "uninstall");
  const appGroupAs = incl.filter(a => a.group && (a.group.kind === "appGroup" || a.group.kind === "container"));
  const intents = [...new Set(directDevice.map(a => a.intent))];
  const migrateIntent = intents.includes("required") ? "required" : intents[0];
  const migrate = directDevice.filter(a => a.intent === migrateIntent);
  const leftover = directDevice.filter(a => a.intent !== migrateIntent);
  const conflicts = [];
  const warnings = [];

  // Zielgruppe: (1) der App schon mit gleichem Intent zugewiesene App-Gruppe,
  // (2) vorhandene App-Gruppe mit passendem Namen, (3) neu nach Konvention.
  let target = null;
  const assigned = appGroupAs.find(a => a.intent === migrateIntent);
  if (assigned) target = { id: assigned.group.id, displayName: assigned.group.displayName, source: "assigned" };
  if (!target) {
    const exp = app.expectedGroup;
    const expSuffix = AUDIT.groupSuffix(exp, tenantId);
    const byName = existingAppGroups.find(g => g.displayName.toLowerCase() === exp.toLowerCase())
      || existingAppGroups.find(g => {
        const s = AUDIT.groupSuffix(g.displayName, tenantId);
        return s.length >= 4 && (expSuffix === s || expSuffix.startsWith(s));
      });
    target = byName
      ? { id: byName.id, displayName: byName.displayName, source: "existing" }
      : { id: null, displayName: exp, source: "new" };
  }

  const otherIntent = appGroupAs.find(a => target.id && a.group.id === target.id && a.intent !== migrateIntent);
  if (otherIntent) conflicts.push(`„${target.displayName}“ ist dieser App schon als „${otherIntent.intentLabel}“ zugewiesen — eine Gruppe trägt je App nur eine Zuweisung.`);
  if (!migrate.length) conflicts.push("Keine Direktzuweisung an eine Gerätegruppe, die sich umstellen lässt.");

  const filterKeys = [...new Set(migrate.map(a => a.filter ? a.filter.id + "|" + a.filter.mode : "none"))];
  if (filterKeys.length > 1) conflicts.push("Die Direktzuweisungen haben unterschiedliche Zuweisungsfilter — welcher für die App-Gruppe gilt, ist eine Entscheidung, keine Automatik.");
  const settingKeys = [...new Set(migrate.map(a => JSON.stringify(a.settings || [])))];
  if (settingKeys.length > 1) {
    warnings.push(`Die Einstellungen der Direktzuweisungen weichen ab. Übernommen werden die von „${migrate[0].group.displayName}“: ${(migrate[0].settings || []).join(", ") || "Standard"}.`);
  }
  if (leftover.length) warnings.push(`Bleibt direkt: ${leftover.map(a => `${a.group.displayName} (${a.intentLabel})`).join(", ")} — pro App wird nur ein Intent umgestellt.`);
  if (app.managedBy === "pmp") warnings.push("Patch-My-PC-App: die Zuweisung danach auch in Patch My PC auf die App-Gruppe umstellen.");
  const shared = assigned && assigned.group.sharedWith && assigned.group.sharedWith.length ? assigned.group.sharedWith : [];
  if (shared.length) warnings.push(`Die Zielgruppe wird auch von ${shared.join(", ")} benutzt — deren Geräte bekommen die neu verschachtelten Gruppen mit.`);

  const nested = new Set();
  if (assigned) (assigned.group.memberGroups || []).forEach(m => nested.add(m.id));
  if (target.source === "existing") {
    const eg = existingAppGroups.find(g => g.id === target.id);
    ((eg && eg.memberGroups) || []).forEach(m => nested.add(m.id));
  }

  return {
    appId: app.id,
    appName: app.displayName,
    managedBy: app.managedBy,
    intent: migrateIntent || null,
    intentLabel: AUDIT.INTENT_LABEL[migrateIntent] || migrateIntent || "",
    target,
    nest: migrate.map(a => ({ id: a.group.id, displayName: a.group.displayName, tags: a.group.tags || [], already: nested.has(a.group.id) })),
    remove: migrate.map(a => ({ groupId: a.group.id, displayName: a.group.displayName })),
    filter: migrate[0] && migrate[0].filter ? migrate[0].filter : null,
    settings: migrate[0] ? migrate[0].settings : [],
    deviceCount: app.devices ? app.devices.length : null,
    conflicts,
    warnings,
    applicable: !conflicts.length
  };
}

function plansFromAudit(audit, tenantId) {
  return audit.apps.filter(a => a.status === "fix")
    .map(a => planForApp(a, audit.existingAppGroups || [], tenantId));
}

// ============================================================== Ausführen
function cleanAssignment(a) {
  const out = { "@odata.type": "#microsoft.graph.mobileAppAssignment", intent: a.intent, target: a.target };
  if (a.settings) out.settings = a.settings;
  return out;
}

async function readAssignments(tenant, cert, appId) {
  const r = await graphReq(tenant, cert, "GET", `/deviceAppManagement/mobileApps/${encodeURIComponent(appId)}/assignments`, null, BETA);
  return (r.value || []).map(cleanAssignment);
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{2,63}$/;

/**
 * Einen Plan ausführen. `override.targetName` ersetzt den vorgeschlagenen Namen
 * einer NEU anzulegenden Gruppe, `override.targetGroupId` wählt eine vorhandene.
 * Der Plan wird vorher gegen den Live-Zustand geprüft — was inzwischen schon
 * korrigiert ist, wird übersprungen statt doppelt geschrieben.
 */
async function applyPlan(tenant, cert, plan, override, say) {
  const log = [];
  const step = (text, ok) => { log.push({ at: new Date().toISOString(), text, ok: ok !== false }); if (say) say(text); };
  const access = { kind: "cert", tenant, certPemPath: cert };
  override = override || {};

  const before = await readAssignments(tenant, cert, plan.appId);
  const removeIds = new Set(plan.remove.map(r => r.groupId));
  const direct = before.filter(a => a.intent === plan.intent && a.target && a.target.groupId && removeIds.has(a.target.groupId)
    && AUDIT.targetKind(a.target) === "group");
  if (!direct.length) {
    step("Keine der geplanten Direktzuweisungen ist noch vorhanden — nichts zu tun.");
    return { status: "skipped", log, before, after: before, target: plan.target };
  }

  // 1. Zielgruppe
  let target;
  if (override.targetGroupId) {
    const g = await graphReq(tenant, cert, "GET", `/groups/${encodeURIComponent(override.targetGroupId)}?$select=id,displayName`, null, { retryTransient: true });
    target = { id: g.id, displayName: g.displayName, created: false };
    step(`Zielgruppe gewählt: ${g.displayName}`);
  } else if (plan.target.id) {
    const g = await graphReq(tenant, cert, "GET", `/groups/${encodeURIComponent(plan.target.id)}?$select=id,displayName`, null, { retryTransient: true });
    target = { id: g.id, displayName: g.displayName, created: false };
    step(`Zielgruppe vorhanden: ${g.displayName}`);
  } else {
    const name = String(override.targetName || plan.target.displayName || "").trim();
    if (!NAME_RE.test(name)) throw Object.assign(new Error(`Gruppenname „${name}“: 3-64 Zeichen, nur Buchstaben, Ziffern, Leerzeichen, . _ -`), { status: 400 });
    const g = await APPGROUPS.ensureAppGroup(access, null, plan.appName, {
      displayName: name,
      managed: plan.managedBy === "pmp" ? "pmp" : "app",
      tenantId: tenant.id,
      description: `App-Zielgruppe für „${plan.appName}“ — die GroupTag-Gerätegruppen sind darin verschachtelt. Angelegt vom App-Zuweisungs-Fixer des M365 Security Policy Manager.`
    });
    target = { id: g.id, displayName: g.displayName, created: g.created };
    step(g.created ? `App-Gruppe angelegt: ${g.displayName}` : `App-Gruppe gefunden: ${g.displayName}`);
  }

  // 2. Verschachteln — vor dem Umhängen, damit die Geräte über die App-Gruppe schon erreichbar sind
  for (const n of plan.nest) {
    if (n.id === target.id) continue;
    const r = await APPGROUPS.nestGroupAsMember(access, null, target.id, n.id);
    step(r === "added" ? `${n.displayName} in ${target.displayName} verschachtelt` : `${n.displayName} war schon Mitglied von ${target.displayName}`);
  }

  // 3. Zuweisungsliste in einem Schritt ersetzen
  const template = direct[0];
  const keep = before.filter(a => !direct.includes(a));
  const hasTarget = keep.find(a => a.target && a.target.groupId === target.id && AUDIT.targetKind(a.target) === "group");
  if (hasTarget && hasTarget.intent !== plan.intent) {
    throw Object.assign(new Error(`„${target.displayName}“ ist dieser App schon als „${hasTarget.intent}“ zugewiesen — abgebrochen, nichts an den Zuweisungen geändert.`), { status: 409 });
  }
  const next = keep.slice();
  if (!hasTarget) {
    const t = { "@odata.type": "#microsoft.graph.groupAssignmentTarget", groupId: target.id };
    if (template.target.deviceAndAppManagementAssignmentFilterId && template.target.deviceAndAppManagementAssignmentFilterType
      && template.target.deviceAndAppManagementAssignmentFilterType !== "none") {
      t.deviceAndAppManagementAssignmentFilterId = template.target.deviceAndAppManagementAssignmentFilterId;
      t.deviceAndAppManagementAssignmentFilterType = template.target.deviceAndAppManagementAssignmentFilterType;
    }
    const neu = { "@odata.type": "#microsoft.graph.mobileAppAssignment", intent: plan.intent, target: t };
    if (template.settings) neu.settings = template.settings;
    next.push(neu);
  }
  await graphReq(tenant, cert, "POST", `/deviceAppManagement/mobileApps/${encodeURIComponent(plan.appId)}/assign`,
    { mobileAppAssignments: next }, { beta: true, retryTransient: true });
  step(`Zuweisung umgestellt: ${direct.length} Direktzuweisung(en) entfernt, ${hasTarget ? "App-Gruppe war schon zugewiesen" : target.displayName + " als „" + (AUDIT.INTENT_LABEL[plan.intent] || plan.intent) + "“ zugewiesen"}`);

  // 4. Nachlesen
  const after = await readAssignments(tenant, cert, plan.appId);
  const okTarget = after.some(a => a.target && a.target.groupId === target.id && a.intent === plan.intent);
  const leftovers = after.filter(a => a.intent === plan.intent && a.target && removeIds.has(a.target.groupId));
  const kept = keep.every(k => after.some(a => a.target && k.target && a.target.groupId === k.target.groupId
    && String(a.target["@odata.type"]) === String(k.target["@odata.type"]) && a.intent === k.intent));
  if (okTarget && !leftovers.length && kept) step("Nachgelesen: stimmt.");
  else step(`Nachgelesen: ${okTarget ? "" : "App-Gruppe fehlt. "}${leftovers.length ? leftovers.length + " Direktzuweisung(en) noch da. " : ""}${kept ? "" : "Übrige Zuweisungen weichen ab."}`, false);

  return { status: okTarget && !leftovers.length && kept ? "done" : "partial", log, before, after, target };
}

async function rollback(tenant, cert, entry) {
  if (!entry || !Array.isArray(entry.before)) throw Object.assign(new Error("Protokolleintrag ohne Vorher-Stand."), { status: 400 });
  await graphReq(tenant, cert, "POST", `/deviceAppManagement/mobileApps/${encodeURIComponent(entry.appId)}/assign`,
    { mobileAppAssignments: entry.before }, { beta: true, retryTransient: true });
  return readAssignments(tenant, cert, entry.appId);
}

/** App-Gruppe umbenennen — nur auf einen Namen, den die Konvention als App-Gruppe erkennt. */
async function renameAppGroup(tenant, cert, groupId, newName) {
  const name = String(newName || "").trim();
  if (!NAME_RE.test(name)) throw Object.assign(new Error("Gruppenname: 3-64 Zeichen, nur Buchstaben, Ziffern, Leerzeichen, . _ -"), { status: 400 });
  if (!APPGROUPS.isAppGroupName(name, tenant.id)) {
    throw Object.assign(new Error(`„${name}“ ist kein App-Gruppen-Name nach der Konvention dieses Tenants.`), { status: 400 });
  }
  const before = await graphReq(tenant, cert, "GET", `/groups/${encodeURIComponent(groupId)}?$select=id,displayName,groupTypes`, null, { retryTransient: true });
  if ((before.groupTypes || []).includes("DynamicMembership")) {
    throw Object.assign(new Error("Dynamische Gruppen sind Gerätegruppen, keine App-Gruppen — nicht umbenannt."), { status: 400 });
  }
  await graphReq(tenant, cert, "PATCH", `/groups/${encodeURIComponent(groupId)}`, { displayName: name }, { retryTransient: true });
  return { id: groupId, from: before.displayName, to: name };
}

// ============================================================== Protokoll
function logFile(stateDir, tenantRecId) {
  return path.join(stateDir, "appassign-log", String(tenantRecId).replace(/[^A-Za-z0-9_-]/g, "") + ".json");
}

function readLog(stateDir, tenantRecId) {
  try { return JSON.parse(fs.readFileSync(logFile(stateDir, tenantRecId), "utf8")); }
  catch (e) { return []; }
}

function writeLog(stateDir, tenantRecId, entries) {
  const f = logFile(stateDir, tenantRecId);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(entries.slice(0, 300), null, 2), "utf8");
}

function appendLog(stateDir, tenantRecId, entry) {
  const e = { id: crypto.randomBytes(6).toString("hex"), at: new Date().toISOString(), ...entry };
  const all = readLog(stateDir, tenantRecId);
  all.unshift(e);
  writeLog(stateDir, tenantRecId, all);
  return e;
}

function updateLog(stateDir, tenantRecId, id, patch) {
  const all = readLog(stateDir, tenantRecId);
  const e = all.find(x => x.id === id);
  if (!e) return null;
  Object.assign(e, patch);
  writeLog(stateDir, tenantRecId, all);
  return e;
}

module.exports = {
  planForApp, plansFromAudit, applyPlan, rollback, renameAppGroup,
  readLog, appendLog, updateLog, cleanAssignment
};
