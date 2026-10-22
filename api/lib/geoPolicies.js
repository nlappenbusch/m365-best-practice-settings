"use strict";
const G = require('./graph');
const COUNTRIES = new Set('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' '));
const bad = message => Object.assign(new Error(message),{status:400});
function validateGeo(b) {
  const name = String(b.name || '').trim();
  if (!name || name.length>80) throw bad('Policy-Name erforderlich (maximal 80 Zeichen).');
  if (!['allowOnly','blockSelected'].includes(b.mode)) throw bad('Ungültiger Geo-Modus.');
  if (!Array.isArray(b.countries) || !b.countries.length || b.countries.length>100) throw bad('1 bis 100 Länder erforderlich.');
  const countries = [...new Set(b.countries.map(c=>String(c).trim().toUpperCase()))].sort();
  if (countries.some(c=>!COUNTRIES.has(c))) throw bad('Ungültiger Ländercode; ISO-Alpha-2 erwartet.');
  const excludedUpns = [...new Set(String(b.excludedUpns || '').split(/[\n,;]+/).map(u=>u.trim().toLowerCase()).filter(Boolean))];
  if (!excludedUpns.length || excludedUpns.length>10 || excludedUpns.some(u=>!/^\S+@\S+\.\S+$/.test(u))) throw bad('1 bis 10 explizite Notfallkonten als UPN erforderlich.');
  return {name,mode:b.mode,countries,excludedUpns};
}
function bodies(config, excludedIds, planId, locationId = '<NAMED_LOCATION_ID>') {
  const suffix = `M36-GEO-${planId}`;
  return {
    location:{'@odata.type':'#microsoft.graph.countryNamedLocation',displayName:`${suffix} Länder`,countriesAndRegions:config.countries,includeUnknownCountriesAndRegions:false,countryLookupMethod:'clientIpAddress'},
    policy:{displayName:`${suffix} ${config.name}`,state:'enabledForReportingButNotEnforced',conditions:{clientAppTypes:['all'],applications:{includeApplications:['All']},users:{includeUsers:['All'],excludeUsers:excludedIds},locations:config.mode==='allowOnly'?{includeLocations:['All'],excludeLocations:[locationId]}:{includeLocations:[locationId],excludeLocations:[]}},grantControls:{operator:'OR',builtInControls:['block']}}
  };
}
async function resolveExclusions(tenant,cert,config) {
  const users=[];
  for(const upn of config.excludedUpns) {
    const u=await G.graphReq(tenant,cert,'GET',`/users/${encodeURIComponent(upn)}?$select=id,displayName,userPrincipalName,accountEnabled,userType`);
    if(!u.id || u.accountEnabled!==true || u.userType!=='Member') throw bad(`Notfallkonto ${upn} muss ein aktives Mitglied im Zieltenant sein.`);
    users.push({id:u.id,name:u.displayName,upn:u.userPrincipalName});
  }
  return users;
}
function policyMatches(actual,expected) {
  function normalize(v) {
    if(Array.isArray(v)) return v.map(normalize).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
    if(v && typeof v==='object') return Object.fromEntries(Object.keys(v).sort().filter(k=>v[k]!=null && !(Array.isArray(v[k]) && !v[k].length)).map(k=>[k,normalize(v[k])]));
    return v;
  }
  const relevant=p=>normalize({displayName:p.displayName,state:p.state,conditions:p.conditions,grantControls:p.grantControls,sessionControls:p.sessionControls});
  return JSON.stringify(relevant(actual))===JSON.stringify(relevant(expected));
}
async function applyGeo(tenant,cert,plan,save) {
  // Revalidate the excluded accounts at apply time; membership may have changed since preview.
  const exclusions=await resolveExclusions(tenant,cert,plan.config);
  if(exclusions.map(u=>u.id).sort().join('|')!==plan.exclusions.map(u=>u.id).sort().join('|')) throw Object.assign(new Error('Notfallkonten haben sich seit der Vorschau geändert.'),{status:409});
  const expected=bodies(plan.config,plan.exclusions.map(u=>u.id),plan.id);
  // Recover ambiguous POST results by unique plan marker rather than creating duplicates.
  const locations=await G.graphAllPages(tenant,cert,'/identity/conditionalAccess/namedLocations');
  const matching=locations.filter(l=>l.displayName===expected.location.displayName);
  if(matching.length>1) throw Object.assign(new Error('Mehrere Standorte mit derselben Plan-ID. Manuelle Prüfung erforderlich.'),{status:409});
  let location=matching[0];
  if(plan.locationId && location?.id!==plan.locationId) throw Object.assign(new Error('Bereits erstellter Standort fehlt oder wurde ersetzt. Neue Vorschau und manuelle Prüfung erforderlich.'),{status:409});
  if(location && (location['@odata.type']!=='#microsoft.graph.countryNamedLocation' || [...(location.countriesAndRegions||[])].sort().join('|')!==plan.config.countries.join('|') || location.includeUnknownCountriesAndRegions===true || (location.countryLookupMethod && location.countryLookupMethod!=='clientIpAddress'))) throw Object.assign(new Error('Vorhandener Standort weicht von der Vorschau ab.'),{status:409});
  if(!location) location=await G.graphReq(tenant,cert,'POST','/identity/conditionalAccess/namedLocations',expected.location);
  if(!location?.id) throw new Error('Graph lieferte keine Standort-ID.');
  plan.locationId=location.id; save(plan);
  const policy=bodies(plan.config,plan.exclusions.map(u=>u.id),plan.id,location.id).policy;
  const policies=await G.graphAllPages(tenant,cert,'/identity/conditionalAccess/policies');
  const found=policies.filter(p=>p.displayName===policy.displayName);
  if(found.length>1 || (found[0] && !policyMatches(found[0],policy))) throw Object.assign(new Error('Vorhandene Policy weicht von der Vorschau ab. Keine Änderung ausgeführt.'),{status:409});
  const created=found[0] || await G.graphReq(tenant,cert,'POST','/identity/conditionalAccess/policies',policy);
  if(!created?.id) throw new Error('Graph lieferte keine Policy-ID.');
  plan.policyId=created.id;plan.status='done';plan.completedAt=new Date().toISOString();delete plan.error;save(plan);
  return plan;
}
module.exports={validateGeo,bodies,resolveExclusions,applyGeo,policyMatches};
