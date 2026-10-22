"use strict";
const G = require('./graph');
const DAY = 86400000;

// Whitelist metadata only. Credential values, secretText and private keys never leave this module.
function evaluateCredentials(sources, now = Date.now()) {
  const credentials = [], findings = [];
  for (const [source, apps] of Object.entries(sources)) {
    for (const a of apps) {
      for (const [field,type] of [['passwordCredentials','Secret'],['keyCredentials','Zertifikat']]) {
        for (const c of a[field] || []) {
          const end = Date.parse(c.endDateTime);
          const days = Number.isFinite(end) ? Math.ceil((end-now)/DAY) : null;
          const item = { source,objectId:a.id,appId:a.appId,name:a.displayName,keyId:c.keyId,type,label:c.displayName || type,expires:Number.isFinite(end)?new Date(end).toISOString():null,days,status:days===null?'unknown':end<=now?'expired':days<=7?'urgent':days<=30?'soon':'ok' };
          credentials.push(item);
          if (['expired','urgent','soon','unknown'].includes(item.status)) findings.push({
            key:`credential:${source}:${a.id}:${c.keyId}`,severity:['expired','urgent'].includes(item.status)?'high':'medium',
            entity:a.appId,title:`${type} ${item.status==='expired'?'abgelaufen':item.status==='unknown'?'ohne gültiges Ablaufdatum':`läuft in ${days} Tagen ab`}: ${a.displayName}`,
            summary:`${source==='applications'?'App-Registrierung':'Unternehmensanwendung'} · ${item.label} · ${item.expires || 'Ablaufdatum nicht auswertbar'}. Nutzung und Rotation vor einer Änderung prüfen.`,
            context:[['App-ID',a.appId],['Credential-ID',c.keyId],['Typ',type],['Ablauf',item.expires || 'unbekannt']],
            steps:['Verantwortlichen und tatsächliche Nutzung der Anwendung prüfen.','Neues Credential hinterlegen und abhängige Dienste umstellen.','Funktion verifizieren und erst danach das alte Credential entfernen.'],
            links:[{label:'App-Registrierungen',url:'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade'}],tab:'cockpit-credentials'
          });
        }
      }
    }
  }
  credentials.sort((a,b)=>(a.days??Infinity)-(b.days??Infinity));
  return { metrics:[{label:'Credentials',value:credentials.length,state:'ok'},{label:'Abgelaufen',value:credentials.filter(c=>c.status==='expired').length,state:credentials.some(c=>c.status==='expired')?'crit':'ok'},{label:'In 30 Tagen fällig',value:credentials.filter(c=>['soon','urgent'].includes(c.status)).length,state:credentials.some(c=>['soon','urgent'].includes(c.status))?'warn':'ok'}],data:{credentials,at:new Date(now).toISOString()},findings };
}
async function collectCredentials(tenant,cert) {
  // Reject a partial scan: reconcile must never resolve findings from a source that failed.
  const [applications,servicePrincipals] = await Promise.all([
    G.graphAllPages(tenant,cert,'/applications?$select=id,appId,displayName,passwordCredentials,keyCredentials&$top=999'),
    G.graphAllPages(tenant,cert,'/servicePrincipals?$select=id,appId,displayName,passwordCredentials,keyCredentials&$top=999')
  ]);
  return evaluateCredentials({applications,servicePrincipals});
}
module.exports = { evaluateCredentials,collectCredentials };
