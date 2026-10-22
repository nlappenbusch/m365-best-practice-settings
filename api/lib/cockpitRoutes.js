"use strict";
const C = require('./cockpit');
const S = require('./managedService');
const G = require('./graph');

function register(app, deps) {
  const { STATE_DIR, loadState, saveState, requireTenant, certPemPath, wrap } = deps;
  const prefix = '/api/tenants/:id/cockpit';
  const tenant = req => {
    const t = (loadState().tenants || []).find(t => t.id === req.params.id);
    if (!t) throw Object.assign(new Error('Tenant nicht gefunden'), { status: 404 });
    return t;
  };
  function update(req, change) {
    const state = loadState();
    const t = state.tenants.find(t => t.id === req.params.id);
    if (!t) throw Object.assign(new Error('Tenant nicht gefunden'), { status: 404 });
    t.cockpit ||= {};
    change(t.cockpit);
    saveState(state);
    return t.cockpit;
  }
  async function collect(req, paths) {
    const t = requireTenant(req), cert = certPemPath(t.tenantId);
    const data = {}, gaps = [];
    await Promise.all(Object.entries(paths).map(async ([key, path]) => {
      try { data[key] = await G.graphAllPages(t, cert, path); }
      catch (e) { data[key] = null; gaps.push({ source: key, message: e.message }); }
    }));
    return { ...data, gaps, at: new Date().toISOString() };
  }
  app.get(prefix + '/identity', wrap(async (req, res) => {
    const d = await collect(req, {
      users: '/users?$select=id,displayName,userPrincipalName,accountEnabled,userType,assignedLicenses,createdDateTime&$top=999',
      mfa: '/reports/authenticationMethods/userRegistrationDetails?$top=999',
      groups: '/groups?$select=id,displayName,groupTypes,securityEnabled,mailEnabled&$top=999',
      devices: '/deviceManagement/managedDevices?$select=id,deviceName,complianceState,operatingSystem&$top=999',
      scores: '/security/secureScores?$top=2'
    });
    const mfa = new Map((d.mfa || []).map(x => [x.id, x]));
    d.users = d.users?.map(u => ({ ...u, mfaRegistered: mfa.has(u.id) ? !!mfa.get(u.id).isMfaRegistered : null, methods: mfa.get(u.id)?.methodsRegistered || [] }));
    delete d.mfa;
    res.json({ ok: true, ...d });
  }));
  app.get(prefix + '/apps', wrap(async (req, res) => {
    const d = await collect(req, {
      apps: '/servicePrincipals?$select=id,appId,displayName,appOwnerOrganizationId,appRoles,oauth2PermissionScopes,createdDateTime&$top=999',
      grants: '/oauth2PermissionGrants?$top=999'
    });
    const t = tenant(req), cert = certPemPath(t.tenantId);
    // Bounded concurrency; failed assignments never turn into a low-risk result.
    const resources = new Map((d.apps || []).map(a => [a.id, a]));
    const rows = [], queue = [...(d.apps || [])];
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (queue.length) {
        const a = queue.shift();
        const permissions = (d.grants || []).filter(g => g.clientId === a.id).flatMap(g => String(g.scope || '').split(' ').filter(Boolean));
        let gap = d.grants === null ? 'Delegierte Berechtigungen nicht lesbar' : '';
        try {
          const assigned = await G.graphAllPages(t, cert, `/servicePrincipals/${encodeURIComponent(a.id)}/appRoleAssignments`);
          for (const p of assigned) {
            const role = resources.get(p.resourceId)?.appRoles?.find(r => r.id === p.appRoleId);
            if (role) permissions.push(role.value);
            else if (p.appRoleId !== '00000000-0000-0000-0000-000000000000') gap = 'Mindestens eine Ressourcenberechtigung nicht auflösbar';
          }
        } catch (e) { gap = e.message; }
        rows.push({ id: a.id, appId: a.appId, name: a.displayName, created: a.createdDateTime, ...C.appRisk(permissions), gap, reviewed: t.cockpit?.appReviews?.[a.id] || null });
      }
    }));
    res.json({ ok: true, apps: rows.sort((a, b) => b.score - a.score), gaps: d.gaps, at: d.at });
  }));
  app.put(prefix + '/apps/:appId/review', wrap(async (req, res) => {
    tenant(req);
    const note = String(req.body?.note || '').trim();
    if (!note || note.length > 2000) return res.status(400).json({ error: 'Begründung mit maximal 2000 Zeichen erforderlich.' });
    const c = update(req, c => { c.appReviews = { ...(c.appReviews || {}), [req.params.appId]: { note, at: new Date().toISOString(), by: req.session.user } }; });
    res.json({ ok: true, review: c.appReviews[req.params.appId] });
  }));
  app.get(prefix + '/signins', wrap(async (req, res) => {
    const since = new Date(Date.now() - 7 * 86400000).toISOString();
    // A bounded sample is labelled as such; do not silently imply complete logs.
    const t = requireTenant(req);
    const d = await G.graphReq(t, certPemPath(t.tenantId), 'GET', `/auditLogs/signIns?$filter=createdDateTime ge ${since}&$top=1000`);
    res.json({ ok: true, since, sampled: !!d['@odata.nextLink'], signins: (d.value || []).map(s => ({ id: s.id, at: s.createdDateTime, user: s.userPrincipalName, app: s.appDisplayName, country: s.location?.countryOrRegion || 'Unbekannt', city: s.location?.city || '', latitude: s.location?.geoCoordinates?.latitude, longitude: s.location?.geoCoordinates?.longitude, success: s.status?.errorCode === 0, risk: !['none', 'hidden', 'unknownFutureValue', undefined].includes(s.riskLevelDuringSignIn) })) });
  }));
  app.get(prefix + '/compliance', wrap(async (req, res) => {
    const t = tenant(req), ov = S.overview(STATE_DIR, t);
    const areas = ['ca', 'risk', 'sharing', 'devices', 'threat'];
    const labels = { ca: 'Zugriff und Identität', risk: 'Identitätsrisiken', sharing: 'Externe Freigaben', devices: 'Geräte-Compliance', threat: 'Mail-Schutz' };
    const technical = areas.map(id => {
      const a = ov.areas.find(a => a.id === id);
      const findings = ov.findings.filter(f => f.area === id && !['resolved', 'snoozed'].includes(f.status));
      const recent = a?.status?.at && Date.now() - Date.parse(a.status.at) < 7 * 86400000;
      return { id, title: labels[id], manual: false, status: !a?.status?.ok || !recent ? 'unknown' : findings.length ? 'open' : 'fulfilled', at: a?.status?.at, findings: findings.length };
    });
    res.json({ ok: true, checks: [...technical, ...C.MANUAL.map(m => ({ ...m, status: t.cockpit?.compliance?.[m.id]?.status || 'unknown', evidence: t.cockpit?.compliance?.[m.id] || null }))] });
  }));
  app.put(prefix + '/compliance/:checkId', wrap(async (req, res) => {
    tenant(req);
    if (!C.MANUAL.some(c => c.id === req.params.checkId)) return res.status(400).json({ error: 'Nur manuelle Maßnahmen sind bearbeitbar.' });
    const status = req.body?.status, note = String(req.body?.note || '').trim();
    if (!['fulfilled', 'open', 'na', 'unknown'].includes(status) || !note || note.length > 4000) return res.status(400).json({ error: 'Status und Begründung (max. 4000 Zeichen) erforderlich.' });
    const entry = { status, note, by: req.session.user, at: new Date().toISOString() };
    update(req, c => { c.compliance ||= {}; c.compliance[req.params.checkId] = entry; c.complianceHistory = [...(c.complianceHistory || []), { checkId: req.params.checkId, ...entry }].slice(-2000); });
    res.json({ ok: true, entry });
  }));
  app.get(prefix + '/alarms', wrap(async (req, res) => {
    const c = tenant(req).cockpit || {};
    res.json({ ok: true, rules: c.rules || [], history: c.alarmHistory || [], areas: S.AREAS.map(a => ({ id: a.id, label: a.label })) });
  }));
  app.put(prefix + '/alarms/:ruleId', wrap(async (req, res) => {
    let rule;
    try { rule = C.validateRule({ ...req.body, id: req.params.ruleId === 'new' ? undefined : req.params.ruleId }); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    if (rule.area && !S.AREA[rule.area]) return res.status(400).json({ error: 'Unbekannter Bereich' });
    update(req, c => { c.rules = [...(c.rules || []).filter(r => r.id !== rule.id), rule]; });
    res.json({ ok: true, rule });
  }));
  app.delete(prefix + '/alarms/:ruleId', wrap(async (req, res) => {
    update(req, c => { c.rules = (c.rules || []).filter(r => r.id !== req.params.ruleId); });
    res.json({ ok: true });
  }));
  app.post(prefix + '/alarms/check', wrap(async (req, res) => {
    const t = tenant(req);
    const results = C.evaluateRules(t.cockpit?.rules || [], S.listFindings(STATE_DIR, t.id));
    update(req, c => { c.alarmHistory = [...results, ...(c.alarmHistory || [])].slice(0, 1000); });
    res.json({ ok: true, results });
  }));
  app.get(prefix + '/dmarc', wrap(async (req, res) => res.json({ ok: true, reports: tenant(req).cockpit?.dmarc || [] })));
  app.post(prefix + '/dmarc/import', wrap(async (req, res) => {
    let report;
    try { report = C.parseDmarc(req.body?.xml); } catch (e) { return res.status(400).json({ error: e.message }); }
    const t = tenant(req);
    if (t.cockpit?.dmarc?.some(r => r.key === report.key)) return res.json({ ok: true, duplicate: true });
    update(req, c => { c.dmarc = [report, ...(c.dmarc || [])].slice(0, 200); });
    res.json({ ok: true, report });
  }));
}
module.exports = { register };
