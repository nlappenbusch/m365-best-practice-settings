"use strict";
const crypto=require('crypto');
const SECURITY=require('./securitySources');
const hash=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const RANK={info:0,low:1,medium:2,high:3,critical:4};
const TEMPLATES=[
  {name:'Defender: hohe Priorität',area:'defender',kind:'findings',severity:'high',threshold:1},
  ...Object.entries(SECURITY.CATEGORIES).map(([activity,name])=>({name,area:'directoryAudit',kind:'audit',activity,windowMinutes:60,severity:'low',threshold:1}))
].map(r=>({...r,description:'',enabled:true,notify:true}));
function init(platform) {
  SECURITY.init(platform);
  platform.db.exec(`CREATE TABLE IF NOT EXISTS alarm_states(tenant_id TEXT NOT NULL,rule_id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(tenant_id,rule_id));
    CREATE TABLE IF NOT EXISTS alarm_transitions(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,at INTEGER NOT NULL,body TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS alarm_transitions_tenant ON alarm_transitions(tenant_id,at);
    CREATE TABLE IF NOT EXISTS notification_outbox(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,destination_hash TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',attempts INTEGER NOT NULL DEFAULT 0,available_at INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,lease_token TEXT,lease_until INTEGER,error TEXT);
    CREATE INDEX IF NOT EXISTS notification_outbox_due ON notification_outbox(status,available_at);`);
}
function webhook(state) {return process.env.MANAGED_TEAMS_WEBHOOK||state.managedGlobal?.teamsWebhook||'';}
function enqueue(platform,tenant,id,url,payload,now=Date.now()) {
  init(platform);
  // No secret URL is copied into payloads or responses. A changed target requires explicit retry.
  platform.db.prepare(`INSERT OR IGNORE INTO notification_outbox(id,tenant_id,destination_hash,payload,available_at,created_at,updated_at,status,error) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(id,tenant,hash(url||''),JSON.stringify(payload),now,now,now,url?'queued':'blocked',url?null:'Teams-Ziel fehlt. Nach Einrichtung erneut senden.');
}
function card(tenant,title,lines,id) {
  return {type:'message',attachments:[{contentType:'application/vnd.microsoft.card.adaptive',content:{$schema:'http://adaptivecards.io/schemas/adaptive-card.json',type:'AdaptiveCard',version:'1.4',body:[
    {type:'TextBlock',text:`M365 · ${tenant.name}`,weight:'Bolder',size:'Medium',wrap:true},
    {type:'TextBlock',text:title,weight:'Bolder',wrap:true},
    ...lines.slice(0,10).map(text=>({type:'TextBlock',text:String(text).slice(0,1000),wrap:true})),
    {type:'TextBlock',text:`Meldungs-ID: ${id}`,isSubtle:true,wrap:true}
  ]}}]};
}
function stateRows(platform,tid) {init(platform);return platform.db.prepare('SELECT body FROM alarm_states WHERE tenant_id=?').all(tid).map(r=>JSON.parse(r.body));}
function view(platform,tid) {
  init(platform);
  return {alarms:stateRows(platform,tid),history:platform.db.prepare('SELECT body FROM alarm_transitions WHERE tenant_id=? ORDER BY at DESC LIMIT 200').all(tid).map(r=>JSON.parse(r.body)),
    deliveries:platform.db.prepare('SELECT id,status,attempts,created_at,updated_at,error,payload FROM notification_outbox WHERE tenant_id=? ORDER BY created_at DESC LIMIT 100').all(tid).map(({payload,...row})=>({...row,title:JSON.parse(payload)?.attachments?.[0]?.content?.body?.[1]?.text||'M365-Meldung'}))};
}
function evaluate(platform,tenant,findings,status,areas,url,now=Date.now()) {
  init(platform);
  const rules=tenant.cockpit?.rules||[],enabled=rules.filter(r=>r.enabled),checks=[];
  platform.tx(()=>{
    const save=body=>platform.db.prepare('INSERT INTO alarm_states VALUES(?,?,?) ON CONFLICT(tenant_id,rule_id) DO UPDATE SET body=excluded.body').run(tenant.id,body.ruleId,JSON.stringify(body));
    const previous=new Map(stateRows(platform,tenant.id).map(s=>[s.ruleId,s]));
    for(const old of previous.values()) if(!enabled.some(r=>r.id===old.ruleId)&&old.active) {
      save({...old,active:false,recovery:0,check:'disabled',message:'Regel deaktiviert oder entfernt; keine technische Entwarnung.',updatedAt:new Date(now).toISOString()});
    }
    for(const rule of enabled) {
      const sources=rule.kind==='audit'?['directoryAudit']:rule.area?[rule.area]:(tenant.managed?.areas?.length?tenant.managed.areas:areas.map(a=>a.id));
      const old=previous.get(rule.id)||{ruleId:rule.id,active:false,generation:0,recovery:0};
      const body={...old,name:rule.name,updatedAt:new Date(now).toISOString()};
      // Every dependency must have a recent successful collection; errors never become a recovery.
      const unavailable=sources.filter(source=>{
        const s=status[source],a=areas.find(a=>a.id===source);
        const interval=a?.intervalMin|| (a?.engine==='exo'?(tenant.managed?.exoIntervalHours||6)*60:(tenant.managed?.graphIntervalMin||60));
        return !s?.ok||!Number.isFinite(Date.parse(s.at))||now-Date.parse(s.at)>Math.max(30,interval*2)*60000;
      });
      if(unavailable.length){body.check='unknown';body.message='Nicht aktuell prüfbar: '+unavailable.map(id=>areas.find(a=>a.id===id)?.label||id).join(', ');body.recovery=0;save(body);checks.push(body);continue;}
      const version=hash({kind:rule.kind,area:rule.area,activity:rule.activity,windowMinutes:rule.windowMinutes,severity:rule.severity,threshold:rule.threshold});
      const sample=hash(sources.map(s=>[s,status[s].at]));
      // Repeated manual clicks on the same sample must not count as two good checks.
      const newSample=body.sample!==sample;
      if(body.version!==version) body.recovery=0;
      const matched=rule.kind==='audit'?SECURITY.records(platform,tenant.id,'directoryAudit',now-(rule.windowMinutes||60)*60000).filter(e=>Date.parse(e.at)<=now&&e.category===rule.activity&&RANK[e.severity]>=RANK[rule.severity]):
        findings.filter(f=>!['resolved','snoozed'].includes(f.status)&&sources.includes(f.area)&&RANK[f.severity]>=RANK[rule.severity]);
      body.count=matched.length;body.findingIds=matched.slice(0,100).map(f=>f.id);body.sample=sample;body.version=version;
      body.check='ok';body.message=rule.kind==='audit'?`Änderungen in den letzten ${rule.windowMinutes||60} Minuten`:'Offene Befunde';
      let transition=null;
      if(body.count>=rule.threshold) {
        body.recovery=0;
        if(!body.active){body.active=true;body.generation++;transition='triggered';}
      } else if(body.active&&newSample) {
        body.recovery=(body.recovery||0)+1;
        if(body.recovery>=2){body.active=false;transition='recovered';}
      }
      if(transition) {
        const id=hash([tenant.id,rule.id,body.generation,transition]);
        const event={id,ruleId:rule.id,name:rule.name,at:new Date(now).toISOString(),count:body.count,triggered:transition==='triggered',transition,
          message:transition==='recovered'?(rule.kind==='audit'?'Unter Schwellwert im Zeitfenster; ursprüngliche Änderungen bleiben prüfbar.':'Zwei erfolgreiche Prüfungen unter Schwellwert.'):'Schwellwert erreicht.'};
        platform.db.prepare('INSERT OR IGNORE INTO alarm_transitions VALUES(?,?,?,?)').run(id,tenant.id,now,JSON.stringify(event));
        if(rule.notify===true) enqueue(platform,tenant.id,id,url,card(tenant,`${event.triggered?'Alarm':'Unter Schwellwert'}: ${rule.name}`,[`${body.count} Treffer · ${event.message}`,...matched.slice(0,5).map(f=>f.title)],id),now);
      }
      save(body);checks.push(body);
    }
    platform.db.prepare('DELETE FROM alarm_transitions WHERE tenant_id=? AND at<?').run(tenant.id,now-180*86400000);
  });
  return checks;
}
function retry(platform,tenant,id,url,actor) {
  init(platform);
  if(!url) throw Object.assign(new Error('Zuerst Teams-Ziel einrichten.'),{status:400});
  const r=platform.db.prepare("UPDATE notification_outbox SET status='queued',attempts=0,available_at=?,updated_at=?,destination_hash=?,error=NULL,lease_token=NULL,lease_until=NULL WHERE id=? AND tenant_id=? AND status IN ('failed','blocked')").run(Date.now(),Date.now(),hash(url),id,tenant);
  if(!r.changes) throw Object.assign(new Error('Meldung nicht gefunden oder bereits in Zustellung.'),{status:409});
  platform.audit(actor,tenant,'notification.retry',id,'queued');
}
module.exports={init,hash,webhook,enqueue,card,view,evaluate,retry,TEMPLATES};
