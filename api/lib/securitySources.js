"use strict";
const G = require('./graph');
const DAY = 86400000;
const CATEGORIES = {
  role: 'Administrative Rolle geändert',
  consent: 'App-Zustimmung geändert',
  credential: 'App-Zugangsdaten geändert',
  policy: 'Zugriffsrichtlinie geändert'
};
function init(platform) {
  if (!platform) throw new Error('Dauerhafte Ablage fehlt.');
  platform.db.exec(`CREATE TABLE IF NOT EXISTS security_records(tenant_id TEXT NOT NULL,source TEXT NOT NULL,event_id TEXT NOT NULL,at INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(tenant_id,source,event_id));
    CREATE INDEX IF NOT EXISTS security_records_time ON security_records(tenant_id,source,at);`);
}
function records(platform, tenant, source, since = 0) {
  init(platform);
  return platform.db.prepare('SELECT body FROM security_records WHERE tenant_id=? AND source=? AND at>=? ORDER BY at DESC').all(tenant,source,since).map(r=>JSON.parse(r.body));
}
function commit(platform, tenant, sources, watermark) {
  init(platform);
  platform.tx(()=>{
    const put=platform.db.prepare('INSERT INTO security_records VALUES(?,?,?,?,?) ON CONFLICT(tenant_id,source,event_id) DO UPDATE SET at=excluded.at,body=excluded.body');
    for(const [source,rows] of Object.entries(sources)) {
      for(const r of rows) put.run(tenant,source,r.id,Date.parse(r.at),JSON.stringify(r));
      if(source==='directoryAudit') {
        platform.db.prepare('INSERT INTO sync_cursors VALUES(?,?,?) ON CONFLICT(tenant_id,source) DO UPDATE SET watermark=excluded.watermark').run(tenant,source,watermark);
        platform.db.prepare('DELETE FROM security_records WHERE tenant_id=? AND source=? AND at<?').run(tenant,source,watermark-30*DAY);
      }
    }
  });
}
async function pages(tenant,cert,path,ctx={}) {
  const expected=new URL('https://graph.microsoft.com/v1.0'+path).pathname.toLowerCase();
  const seen=new Set(),rows=[];
  let next=path;
  while(next) {
    ctx.signal?.throwIfAborted();ctx.assertLease?.();
    if(seen.has(next)||seen.size>=100) throw new Error('Zu viele oder zyklische Graph-Seiten. Voriger Datenstand bleibt erhalten.');
    seen.add(next);
    const page=await G.graphReq(tenant,cert,'GET',next,null,{signal:ctx.signal,retryTransient:2});
    if(!Array.isArray(page.value)) throw new Error('Unvollständige Graph-Antwort. Voriger Datenstand bleibt erhalten.');
    rows.push(...page.value);next=page['@odata.nextLink']||null;
    if(next) {
      const u=new URL(next);
      if(u.protocol!=='https:'||u.hostname!=='graph.microsoft.com'||u.port||u.username||u.password||u.pathname.toLowerCase()!==expected) throw new Error('Unerwarteter Graph-Folgelink.');
    }
  }
  return rows;
}
const clean = (v,n=500)=>String(v||'').slice(0,n);
function requireIdentity(r,at) {
  if(!r.id||!Number.isFinite(Date.parse(at))) throw new Error('Graph-Eintrag ohne ID oder gültigen Zeitpunkt.');
}
function defenderRecord(r,source) {
  requireIdentity(r,r.lastUpdateDateTime||r.createdDateTime);
  return {id:String(r.id),source,at:r.lastUpdateDateTime||r.createdDateTime,createdAt:r.createdDateTime,
    title:clean(r.title||r.displayName),status:clean(r.status,60),severity:r.severity==='informational'?'info':['high','medium','low'].includes(r.severity)?r.severity:'medium',
    incidentId:r.incidentId==null?null:String(r.incidentId),category:clean(r.category,100),
    entity:clean(r.evidence?.find(e=>e.userAccount)?.userAccount?.userPrincipalName||r.evidence?.find(e=>e.deviceDnsName)?.deviceDnsName),
    url:source==='defenderIncidents'?`https://security.microsoft.com/incidents/${encodeURIComponent(r.id)}/overview`:`https://security.microsoft.com/alerts/${encodeURIComponent(r.id)}`};
}
function auditRecord(r) {
  requireIdentity(r,r.activityDateTime);
  const activity=clean(r.activityDisplayName), category=clean(r.category,100);
  // Only successful, specific security changes become findings. Other events remain searchable source data.
  let kind=null;
  if(r.result==='success') {
    if(category==='RoleManagement'&&/add|remove|activate|update/i.test(activity)) kind='role';
    else if(/consent|permission grant|app role assignment/i.test(activity)) kind='consent';
    else if(/credential|certificates and secrets/i.test(activity)&&/application|service principal/i.test(activity)) kind='credential';
    else if(/conditional access/i.test(activity)&&/add|update|delete/i.test(activity)) kind='policy';
  }
  return {id:String(r.id),source:'directoryAudit',at:r.activityDateTime,title:activity,category:kind,result:clean(r.result,60),
    severity:kind==='role'||kind==='credential'?'high':'medium',
    actor:clean(r.initiatedBy?.user?.userPrincipalName||r.initiatedBy?.app?.displayName||'Unbekannt'),
    targets:(r.targetResources||[]).slice(0,20).map(t=>({id:clean(t.id,150),name:clean(t.displayName||t.userPrincipalName),type:clean(t.type,80)}))};
}
async function collectDefender(tenant,cert,ctx={}) {
  init(ctx.platform);
  // Full retained collections, not just a recent window: an old unresolved incident must remain visible.
  const alerts=(await pages(tenant,cert,'/security/alerts_v2?$top=100',ctx)).map(r=>defenderRecord(r,'defenderAlerts'));
  const incidents=(await pages(tenant,cert,'/security/incidents?$top=100',ctx)).map(r=>defenderRecord(r,'defenderIncidents'));
  ctx.signal?.throwIfAborted();ctx.assertLease?.();
  commit(ctx.platform,tenant.id,{defenderAlerts:alerts,defenderIncidents:incidents});
  const all=[...records(ctx.platform,tenant.id,'defenderIncidents'),...records(ctx.platform,tenant.id,'defenderAlerts')];
  const incidentIds=new Set(all.filter(r=>r.source==='defenderIncidents').map(r=>r.id));
  const currentIds=new Set([...alerts,...incidents].map(r=>r.source+':'+r.id));
  const open=all.filter(r=>r.status!=='resolved'&&!(r.source==='defenderAlerts'&&r.incidentId&&incidentIds.has(r.incidentId)));
  return {metrics:[{label:'Offene Vorfälle / Einzelalarme',value:open.length,state:open.length?'warn':'ok'}],
    data:{records:all.slice(0,1000),note:'Zugeordnete Alarme werden unter ihrem Incident zusammengefasst. Fehlende Einträge werden nicht automatisch als behoben gewertet.'},
    findings:open.map(r=>({key:r.source+':'+r.id,severity:r.severity,title:r.title||'Defender-Meldung',entity:r.entity,
      summary:`Microsoft Defender: ${r.status}.${currentIds.has(r.source+':'+r.id)?'':' Nicht mehr im aktuellen Abruf enthalten; Status im Defender prüfen.'}`,
      context:[['Quelle',r.source==='defenderIncidents'?'Defender Incident':'Defender Alarm'],['Letzte Änderung',r.at]],
      steps:['Vorfall im Microsoft Defender öffnen, betroffene Konten und Geräte prüfen.','Bearbeitung im Befund dokumentieren. Der Microsoft-Status wird beim nächsten Abruf übernommen.'],links:[{label:'In Defender öffnen',url:r.url}]}))};
}
async function collectAudit(tenant,cert,ctx={}) {
  init(ctx.platform);
  const end=Date.now()-120000,previous=ctx.platform.cursor(tenant.id,'directoryAudit');
  const start=Math.max(end-7*DAY,(previous||end-DAY)-600000);
  const filter=encodeURIComponent(`activityDateTime ge ${new Date(start).toISOString()} and activityDateTime le ${new Date(end).toISOString()}`);
  const rows=(await pages(tenant,cert,'/auditLogs/directoryAudits?$top=100&$filter='+filter,ctx)).map(auditRecord);
  ctx.signal?.throwIfAborted();ctx.assertLease?.();
  commit(ctx.platform,tenant.id,{directoryAudit:rows},end);
  const changes=records(ctx.platform,tenant.id,'directoryAudit',end-30*DAY).filter(r=>r.category);
  return {metrics:[{label:'Sicherheitsänderungen (30 Tage)',value:changes.length,state:changes.length?'warn':'ok'}],
    data:{events:changes.slice(0,1000),from:new Date(start).toISOString(),until:new Date(end).toISOString(),note:previous&&previous<end-7*DAY?'Erhebungslücke: Es wurden höchstens sieben Tage nachgeladen. Ältere Ereignisse fehlen.':'Erster Abruf: letzte 24 Stunden; danach fortlaufend. Aufbewahrung im Tool: 30 Tage.'},
    findings:changes.map(r=>({key:'audit:'+r.id,eventFinding:true,severity:r.severity,title:CATEGORIES[r.category],entity:r.targets[0]?.name,
      summary:`${r.actor}: ${r.title}`,context:[['Zeitpunkt',r.at],['Bearbeiter',r.actor],['Objekte',r.targets.map(t=>t.name||t.id).join(', ')]],
      steps:['Änderung mit dem geplanten Auftrag abgleichen.','Berechtigte Änderung quittieren; unerwartete Änderung untersuchen. Ein Audit-Ereignis ist noch kein bestätigter Angriff.'],links:[{label:'Entra Audit-Protokoll',url:'https://entra.microsoft.com/#view/Microsoft_AAD_IAM/ActiveDirectoryMenuBlade/~/Audit'}]}))};
}
module.exports={init,records,pages,auditRecord,defenderRecord,collectDefender,collectAudit,CATEGORIES};
