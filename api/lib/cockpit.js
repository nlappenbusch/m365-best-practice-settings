"use strict";
const crypto = require('crypto');

const MANUAL = [
  ['avv', 'Auftragsverarbeitungsverträge dokumentiert', 'Art. 28'],
  ['tom', 'Technische und organisatorische Maßnahmen dokumentiert', 'Art. 32'],
  ['vvt', 'Verzeichnis der Verarbeitungstätigkeiten gepflegt', 'Art. 30'],
  ['privacy', 'Datenschutzhinweise und Ansprechpartner hinterlegt', 'Art. 13, 14'],
  ['incident', 'Meldeprozess für Datenschutzvorfälle festgelegt', 'Art. 33, 34'],
  ['retention', 'Lösch- und Aufbewahrungskonzept dokumentiert', 'Art. 5'],
  ['access', 'Berechtigungsprüfung und Offboarding dokumentiert', 'Art. 32'],
  ['training', 'Mitarbeitende zum Datenschutz geschult', 'Art. 39'],
  ['transfer', 'Drittlandübermittlungen geprüft', 'Art. 44 ff.'],
  ['restore', 'Backup und Wiederherstellung regelmäßig getestet', 'Art. 32']
].map(([id, title, article]) => ({ id, title, article, manual: true }));

function appRisk(permissions) {
  let score = 0;
  const factors = [...new Set(permissions)].map(name => {
    const critical = /^(RoleManagement\.ReadWrite\.Directory|AppRoleAssignment\.ReadWrite\.All|Directory\.ReadWrite\.All|Mail\.ReadWrite(?:\.All)?|Files\.ReadWrite\.All|Sites\.FullControl\.All)$/.test(name);
    const high = /ReadWrite|\.Send$|\.Manage|full_access/i.test(name);
    const weight = critical ? 100 : high ? 40 : /\.All$/.test(name) ? 10 : 2;
    score += weight;
    return { name, level: critical ? 'critical' : high ? 'high' : 'medium', weight };
  });
  return { score, level: factors.some(f => f.level === 'critical') ? 'critical' : factors.some(f => f.level === 'high') ? 'high' : factors.length ? 'medium' : 'low', factors };
}

function evaluateRules(rules, findings, at = new Date().toISOString()) {
  const rank = { low: 0, medium: 1, high: 2, critical: 3 };
  return rules.filter(r => r.enabled).map(r => {
    const matching = findings.filter(f => !['resolved', 'snoozed'].includes(f.status) && (!r.area || f.area === r.area) && rank[f.severity] >= rank[r.severity]);
    return { ruleId: r.id, name: r.name, at, count: matching.length, triggered: matching.length >= r.threshold, findingIds: matching.map(f => f.id) };
  });
}

function validateRule(b) {
  if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 120) throw new Error('Regelname fehlt oder ist zu lang.');
  if (!['critical', 'high', 'medium', 'low'].includes(b.severity)) throw new Error('Ungültiger Schweregrad.');
  if (!Number.isInteger(Number(b.threshold)) || Number(b.threshold) < 1 || Number(b.threshold) > 10000) throw new Error('Schwellwert muss zwischen 1 und 10000 liegen.');
  return { id: b.id || crypto.randomUUID(), name: b.name.trim(), description: String(b.description || '').slice(0, 1000), area: String(b.area || ''), severity: b.severity, threshold: Number(b.threshold), enabled: b.enabled !== false };
}

function parseDmarc(xml) {
  if (typeof xml !== 'string' || xml.length > 450000 || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Ungültige XML-Datei (max. 450 KB, keine DTD/Entities).');
  const { XMLParser, XMLValidator } = require('fast-xml-parser');
  if (XMLValidator.validate(xml) !== true) throw new Error('XML ist nicht wohlgeformt.');
  const f = new XMLParser({ ignoreAttributes: true, parseTagValue: false }).parse(xml)?.feedback;
  const domain = String(f?.policy_published?.domain || '').toLowerCase();
  const id = String(f?.report_metadata?.report_id || '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain) || !id) throw new Error('DMARC-Aggregatbericht mit Domain und Report-ID erwartet.');
  const records = f.record ? (Array.isArray(f.record) ? f.record : [f.record]) : [];
  const rows = records.map(r => {
    const count = Number(r.row?.count);
    if (!Number.isSafeInteger(count) || count < 0 || count > 1e9) throw new Error('Ungültige Nachrichtenanzahl.');
    return { ip: String(r.row?.source_ip || ''), count, pass: r.row?.policy_evaluated?.dkim === 'pass' || r.row?.policy_evaluated?.spf === 'pass', disposition: String(r.row?.policy_evaluated?.disposition || ''), from: String(r.identifiers?.header_from || domain) };
  });
  const begin = Number(f.report_metadata.date_range?.begin), end = Number(f.report_metadata.date_range?.end);
  if (!Number.isFinite(begin) || !Number.isFinite(end) || begin < 0 || end < begin || end > 1e11) throw new Error('Ungültiger Berichtszeitraum.');
  return { key: crypto.createHash('sha256').update(domain + ':' + String(f.report_metadata.org_name || '') + ':' + id).digest('hex'), domain, reportId: id, organization: String(f.report_metadata.org_name || ''), begin: new Date(begin * 1000).toISOString(), end: new Date(end * 1000).toISOString(), policy: String(f.policy_published.p || ''), rows, total: rows.reduce((n, r) => n + r.count, 0), failed: rows.filter(r => !r.pass).reduce((n, r) => n + r.count, 0) };
}

module.exports = { MANUAL, appRisk, evaluateRules, validateRule, parseDmarc };
