"use strict";
const test=require('node:test');
const assert=require('node:assert/strict');
const G=require('../lib/graph');
const {evaluateCredentials,collectCredentials}=require('../lib/appCredentials');
test('credential expiry produces lifecycle findings and never exposes secrets or certificate bytes',()=>{
  const now=Date.parse('2026-10-22T12:00:00Z');
  const dates=['2026-10-21T12:00:00Z','2026-10-25T12:00:00Z','2026-11-10T12:00:00Z','2027-01-01T12:00:00Z','bad'];
  const credentials=dates.map((endDateTime,i)=>({keyId:'k'+i,endDateTime,displayName:'test',secretText:'DO-NOT-RETURN',key:'PRIVATE-BYTES'}));
  const r=evaluateCredentials({applications:[{id:'a',appId:'app',displayName:'Example',passwordCredentials:credentials}]},now);
  assert.deepEqual(r.data.credentials.map(c=>c.status),['expired','urgent','soon','ok','unknown']);
  assert.equal(r.findings.length,4);assert.equal(r.findings[0].severity,'high');
  assert.ok(!JSON.stringify(r).includes('DO-NOT-RETURN'));assert.ok(!JSON.stringify(r).includes('PRIVATE-BYTES'));
  assert.equal(r.data.credentials[1].days,3);
});
test('partial credential scans fail closed instead of resolving existing findings',async t=>{
  const original=G.graphAllPages;t.after(()=>G.graphAllPages=original);
  G.graphAllPages=async(t,c,path)=>{if(path.startsWith('/servicePrincipals')) throw new Error('Denied');return []};
  await assert.rejects(()=>collectCredentials({},''),/Denied/);
});
