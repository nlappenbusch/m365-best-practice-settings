"use strict";
const test=require('node:test');
const assert=require('node:assert/strict');
const G=require('../lib/graph');
const GEO=require('../lib/geoPolicies');
const input={name:'DACH',mode:'allowOnly',countries:['CH','DE','AT'],excludedUpns:'bg@example.com'};
test('geo validation requires real country codes and explicit emergency account exclusions',()=>{
  assert.deepEqual(GEO.validateGeo({...input,countries:['ch','CH','DE']}).countries,['CH','DE']);
  for(const b of [{...input,excludedUpns:''},{...input,countries:['ZZ']},{...input,countries:[]},{...input,mode:'enabled'},{...input,name:''}]) assert.throws(()=>GEO.validateGeo(b));
});
test('geo bodies always create report-only block policies with distinct allow/block location semantics',()=>{
  const a=GEO.bodies(GEO.validateGeo(input),['bg'],'plan','loc');
  assert.equal(a.policy.state,'enabledForReportingButNotEnforced');
  assert.deepEqual(a.policy.conditions.users.excludeUsers,['bg']);
  assert.deepEqual(a.policy.conditions.locations,{includeLocations:['All'],excludeLocations:['loc']});
  const b=GEO.bodies({...GEO.validateGeo(input),mode:'blockSelected'},['bg'],'plan','loc');
  assert.deepEqual(b.policy.conditions.locations,{includeLocations:['loc'],excludeLocations:[]});
  assert.equal(b.location.includeUnknownCountriesAndRegions,false);
});
test('policy recovery refuses additional filters or changed enforcement',()=>{
  const p=GEO.bodies(GEO.validateGeo(input),['bg'],'plan','loc').policy;
  assert.equal(GEO.policyMatches({...p,id:'id',sessionControls:null},p),true);
  assert.equal(GEO.policyMatches({...p,state:'enabled'},p),false);
  assert.equal(GEO.policyMatches({...p,conditions:{...p.conditions,users:{...p.conditions.users,excludeGroups:['extra']}}},p),false);
});
test('ambiguous policy creation is recovered on retry without duplicate locations or policies',async t=>{
  const oldReq=G.graphReq,oldAll=G.graphAllPages;t.after(()=>{G.graphReq=oldReq;G.graphAllPages=oldAll});
  const locations=[],policies=[],posts=[];let fail=true;
  G.graphAllPages=async(t,c,p)=>p.endsWith('namedLocations')?locations:policies;
  G.graphReq=async(t,c,m,p,b)=>{
    if(m==='GET') return {id:'bg',userPrincipalName:'bg@example.com',displayName:'Break Glass',accountEnabled:true,userType:'Member'};
    posts.push(p);
    if(p.endsWith('namedLocations')){const x={...b,id:'loc'};locations.push(x);return x}
    const x={...b,id:'policy'};policies.push(x);if(fail){fail=false;throw new Error('Connection lost after server accepted policy')}return x;
  };
  const plan={id:'plan',config:GEO.validateGeo(input),exclusions:[{id:'bg'}]};
  await assert.rejects(()=>GEO.applyGeo({},'',plan,()=>{}),/Connection lost/);
  assert.equal(plan.locationId,'loc');
  const r=await GEO.applyGeo({},'',plan,()=>{});
  assert.equal(r.status,'done');assert.equal(r.policyId,'policy');assert.equal(posts.length,2);
});
test('disabled or guest emergency account fails preflight',async t=>{
  const old=G.graphReq;t.after(()=>G.graphReq=old);
  G.graphReq=async()=>({id:'bg',accountEnabled:false,userType:'Member'});
  await assert.rejects(()=>GEO.resolveExclusions({},'',GEO.validateGeo(input)),/aktives Mitglied/);
});
test('a removed or replaced location from an earlier attempt is not silently recreated',async t=>{
  const oldReq=G.graphReq,oldAll=G.graphAllPages;t.after(()=>{G.graphReq=oldReq;G.graphAllPages=oldAll});
  G.graphAllPages=async()=>[];
  let writes=0;
  G.graphReq=async(t,c,m)=>{if(m!=='GET')writes++;return {id:'bg',accountEnabled:true,userType:'Member'}};
  await assert.rejects(()=>GEO.applyGeo({},'',{id:'plan',config:GEO.validateGeo(input),exclusions:[{id:'bg'}],locationId:'already-created'},()=>{}),/fehlt oder wurde ersetzt/);
  assert.equal(writes,0);
});
