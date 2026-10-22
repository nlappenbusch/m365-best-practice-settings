'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {PlatformStore}=require('../lib/platformStore');
const A=require('../lib/alarmEngine'),C=require('../lib/cockpit'),S=require('../lib/securitySources'),G=require('../lib/graph');
const {NotificationWorker}=require('../lib/notificationWorker');
const AREA=[{id:'defender',intervalMin:10},{id:'directoryAudit',intervalMin:10}];
const URL='https://teams.example.test/hook';
const now=Date.now();
const good=(n=now)=>({defender:{ok:true,at:new Date(n).toISOString()},directoryAudit:{ok:true,at:new Date(n).toISOString()}});
function tenant(rule={}) {return {id:'a',name:'Tenant A',cockpit:{rules:[C.validateRule({id:'rule',name:'Defender high',area:'defender',severity:'high',threshold:1,enabled:true,notify:true,...rule})]}};}
function store(t){const s=new PlatformStore(':memory:');t.after(()=>s.close());return s;}
const findings=[{id:'f',title:'Malware',severity:'high',area:'defender',status:'open'}];

test('informational Defender alerts do not become medium priority findings',()=>{
  assert.equal(S.defenderRecord({id:'informational',createdDateTime:new Date(now).toISOString(),severity:'informational'},'defenderAlerts').severity,'info');
});

test('one durable alarm per episode; manual repeat, source failures and stale samples cannot cause recovery',t=>{
  const db=store(t),customer=tenant();
  A.evaluate(db,customer,findings,good(),AREA,URL,now);
  A.evaluate(db,customer,findings,good(),AREA,URL,now);
  assert.equal(A.view(db,'a').history.length,1);assert.equal(A.view(db,'a').deliveries.length,1);
  A.evaluate(db,customer,[],{...good(),defender:{ok:false,at:new Date(now+1).toISOString()}},AREA,URL,now+1);
  assert.equal(A.view(db,'a').alarms[0].active,true);assert.equal(A.view(db,'a').alarms[0].check,'unknown');
  A.evaluate(db,customer,[],good(now+2),AREA,URL,now+2);
  A.evaluate(db,customer,[],good(now+2),AREA,URL,now+3);
  assert.equal(A.view(db,'a').alarms[0].active,true);
  A.evaluate(db,customer,[],good(now+4),AREA,URL,now+4);
  assert.equal(A.view(db,'a').alarms[0].active,false);assert.equal(A.view(db,'a').history.length,2);
  A.evaluate(db,customer,findings,good(now+5),AREA,URL,now+5);
  assert.equal(A.view(db,'a').history.length,3);
  assert.equal(A.view(db,'b').history.length,0);assert.equal(A.view(db,'b').deliveries.length,0);
  A.evaluate(db,customer,[],good(now),AREA,URL,now+3600000);
  assert.equal(A.view(db,'a').alarms[0].check,'unknown');assert.equal(A.view(db,'a').alarms[0].active,true);
});

test('state change and notification are atomic; absent destination is visible, not silently dropped',t=>{
  const db=store(t);A.evaluate(db,tenant(),findings,good(),AREA,'',now);
  assert.equal(A.view(db,'a').deliveries[0].status,'blocked');
  const id=A.view(db,'a').deliveries[0].id;
  assert.throws(()=>A.retry(db,'b',id,URL,'operator'),/nicht gefunden/);
  A.retry(db,'a',id,URL,'operator');assert.equal(A.view(db,'a').deliveries[0].status,'queued');
  assert.throws(()=>A.retry(db,'a',id,URL,'operator'),/bereits/);
  const other=tenant();other.id='c';
  db.db.exec("CREATE TRIGGER reject_outbox BEFORE INSERT ON notification_outbox BEGIN SELECT RAISE(ABORT,'disk full'); END;");
  assert.throws(()=>A.evaluate(db,other,findings,good(),AREA,URL,now),/disk full/);
  assert.equal(A.view(db,'c').history.length,0);assert.equal(A.view(db,'c').alarms.length,0);
});

test('legacy rules do not enable outbound notifications; disabled rules retire without false recovery',t=>{
  const db=store(t),customer=tenant({notify:undefined});
  A.evaluate(db,customer,findings,good(),AREA,URL,now);
  assert.equal(A.view(db,'a').deliveries.length,0);
  customer.cockpit.rules[0].enabled=false;
  A.evaluate(db,customer,[],good(now+1),AREA,URL,now+1);
  assert.equal(A.view(db,'a').alarms[0].check,'disabled');assert.equal(A.view(db,'a').history.length,1);
});

test('audit classification and window rules use exact event IDs, actor and targets without credential values',async t=>{
  const db=store(t),original=G.graphReq;t.after(()=>{G.graphReq=original});
  const event={id:'audit1',activityDateTime:new Date().toISOString(),activityDisplayName:'Add member to role',category:'RoleManagement',result:'success',initiatedBy:{user:{userPrincipalName:'admin@example.test'}},targetResources:[{id:'u',displayName:'Alice',modifiedProperties:[{newValue:'TOP-SECRET'}]}]};
  G.graphReq=async()=>({value:[event]});
  const customer=tenant({kind:'audit',activity:'role',severity:'low',windowMinutes:60});
  const result=await S.collectAudit(customer,'',{platform:db});
  await S.collectAudit(customer,'',{platform:db});
  assert.equal(S.records(db,'a','directoryAudit').length,1);
  assert.equal(result.findings.length,1);assert.equal(result.findings[0].eventFinding,true);
  assert.ok(!JSON.stringify(S.records(db,'a','directoryAudit')).includes('TOP-SECRET'));
  A.evaluate(db,customer,[],good(),AREA,URL,now+1000);
  assert.equal(A.view(db,'a').alarms[0].count,1);
  assert.equal(S.auditRecord({...event,result:'failure'}).category,null);
  assert.equal(S.auditRecord({...event,category:'ApplicationManagement',activityDisplayName:'Consent to application'}).category,'consent');
  assert.equal(S.auditRecord({...event,category:'ApplicationManagement',activityDisplayName:'Update application – Certificates and secrets management'}).category,'credential');
  assert.equal(S.auditRecord({...event,category:'Policy',activityDisplayName:'Update conditional access policy'}).category,'policy');
  assert.throws(()=>C.validateRule({...customer.cockpit.rules[0],activity:'anything'}));
  assert.throws(()=>C.validateRule({...customer.cockpit.rules[0],windowMinutes:100000}));
});

test('partial pagination, foreign links and lease loss never advance audit cursor',async t=>{
  const db=store(t),original=G.graphReq;t.after(()=>{G.graphReq=original});
  const event={id:'1',activityDateTime:new Date().toISOString(),activityDisplayName:'Add member to role',category:'RoleManagement',result:'success'};
  let calls=0;
  G.graphReq=async()=>{if(calls++)throw new Error('page failed');return {value:[event],'@odata.nextLink':'https://graph.microsoft.com/v1.0/auditLogs/directoryAudits?$skiptoken=x'}};
  await assert.rejects(S.collectAudit({id:'a'},'',{platform:db}),/page failed/);
  assert.equal(db.cursor('a','directoryAudit'),null);assert.equal(S.records(db,'a','directoryAudit').length,0);
  G.graphReq=async()=>({value:[event],'@odata.nextLink':'https://evil.example.test/v1.0/auditLogs/directoryAudits'});
  await assert.rejects(S.collectAudit({id:'a'},'',{platform:db}),/Folgelink/);
  G.graphReq=async()=>({value:[event]});let checks=0;
  await assert.rejects(S.collectAudit({id:'a'},'',{platform:db,assertLease:()=>{if(checks++)throw new Error('lease lost')}}),/lease lost/);
  assert.equal(db.cursor('a','directoryAudit'),null);
});

test('Defender bundles alerts in incidents, retains missing open items, and requires explicit resolution',async t=>{
  const db=store(t),original=G.graphReq;t.after(()=>{G.graphReq=original});
  const alert={id:'a1',incidentId:'i1',title:'Alert',status:'new',severity:'high',lastUpdateDateTime:new Date().toISOString()};
  let incidents=[{id:'i1',displayName:'Incident',status:'active',severity:'high',lastUpdateDateTime:new Date().toISOString()}],alerts=[alert];
  G.graphReq=async(t,c,m,p)=>({value:p.startsWith('/security/incidents')?incidents:alerts});
  let r=await S.collectDefender({id:'a'},'',{platform:db});assert.equal(r.findings.length,1);assert.equal(r.findings[0].title,'Incident');
  incidents=[];alerts=[];r=await S.collectDefender({id:'a'},'',{platform:db});assert.equal(r.findings.length,1);assert.match(r.findings[0].summary,/Nicht mehr/);
  incidents=[{id:'i1',displayName:'Incident',status:'resolved',severity:'high',lastUpdateDateTime:new Date().toISOString()}];
  r=await S.collectDefender({id:'a'},'',{platform:db});assert.equal(r.findings.length,0);
  G.graphReq=async(t,c,m,p)=>{if(p.startsWith('/security/incidents'))throw new Error('403');return {value:[{...alert,id:'new-alert'}]}};
  await assert.rejects(S.collectDefender({id:'b'},'',{platform:db}),/403/);assert.equal(S.records(db,'b','defenderAlerts').length,0);
});

test('outbox retries 429, survives reopen, fences stale leases, and never exposes or redirects to a changed target',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'alarm-persist-')),file=path.join(dir,'platform.sqlite');
  let db=new PlatformStore(file);t.after(()=>{db.close();assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('alarm-persist-'));fs.rmSync(dir,{recursive:true,force:true})});
  const customer=tenant();let time=now;
  A.evaluate(db,customer,findings,good(),AREA,URL,time);
  const config={tenants:[customer],managedGlobal:{teamsWebhook:URL}};
  let calls=0,seenId;
  let worker=new NotificationWorker(db,()=>config,{clock:()=>time,fetcher:async(url,options)=>{calls++;seenId=options.headers['X-Idempotency-Key'];assert.equal(options.redirect,'error');return new Response('',{status:429,headers:{'Retry-After':'30'}})}});
  await worker.sendOne();assert.equal(A.view(db,'a').deliveries[0].status,'retry');
  await worker.sendOne();assert.equal(calls,1);
  db.close();db=new PlatformStore(file);time+=31000;
  worker=new NotificationWorker(db,()=>config,{clock:()=>time,fetcher:async(url,options)=>{assert.equal(options.headers['X-Idempotency-Key'],seenId);return new Response('',{status:200})}});
  await worker.sendOne();assert.equal(A.view(db,'a').deliveries[0].status,'sent');
  A.enqueue(db,'a','other',URL,{},time);
  const lease1=worker.claim();time+=61000;const lease2=worker.claim();assert.notEqual(lease1.lease_token,lease2.lease_token);
  worker.finish(lease1,'sent');assert.equal(A.view(db,'a').deliveries.find(d=>d.id==='other').status,'sending');
  worker.finish(lease2,'failed','test');A.retry(db,'a','other',URL,'admin');time=Date.now()+100000;
  config.managedGlobal.teamsWebhook='https://different.example.test';await worker.sendOne();
  assert.equal(A.view(db,'a').deliveries.find(d=>d.id==='other').status,'blocked');
  assert.ok(!JSON.stringify(A.view(db,'a')).includes(URL));
});

test('network failures exhaust bounded attempts, permanent HTTP errors do not retry',async t=>{
  const db=store(t),config={tenants:[tenant()],managedGlobal:{teamsWebhook:URL}};let time=now;
  A.enqueue(db,'a','network',URL,{},time);
  const worker=new NotificationWorker(db,()=>config,{clock:()=>time,fetcher:async()=>{throw new Error('timeout '+URL)}});
  for(let n=0;n<8;n++){await worker.sendOne();time+=3600001;}
  const row=A.view(db,'a').deliveries[0];assert.equal(row.status,'failed');assert.equal(row.attempts,8);assert.ok(!row.error.includes(URL));
  A.enqueue(db,'a','denied',URL,{},time);worker.fetcher=async()=>new Response('',{status:403});await worker.sendOne();
  assert.equal(A.view(db,'a').deliveries.find(d=>d.id==='denied').status,'failed');
});
