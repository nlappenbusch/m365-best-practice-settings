"use strict";
const crypto=require('crypto');
const A=require('./alarmEngine');
class NotificationWorker {
  constructor(platform,loadState,{fetcher=fetch,clock=Date.now}={}) {this.platform=platform;this.loadState=loadState;this.fetcher=fetcher;this.clock=clock;A.init(platform);}
  start(){this.timer=setInterval(()=>this.tick(),5000);this.timer.unref?.();this.tick();return this;}
  tick(){if(this.stopping||this.active)return;this.active=this.sendOne().catch(()=>{}).finally(()=>{this.active=null});}
  async stop(){this.stopping=true;clearInterval(this.timer);await this.active;}
  claim() {
    const db=this.platform.db,now=this.clock();
    return this.platform.tx(()=>{
      db.prepare("UPDATE notification_outbox SET status=CASE WHEN attempts>=8 THEN 'failed' ELSE 'retry' END,error='Zustellung nach Unterbrechung unbestätigt; Wiederholung kann doppelt ankommen.',lease_token=NULL,lease_until=NULL WHERE status='sending' AND lease_until<=?").run(now);
      const row=db.prepare("SELECT * FROM notification_outbox WHERE status IN ('queued','retry') AND available_at<=? ORDER BY available_at LIMIT 1").get(now);
      if(!row)return null;
      row.lease_token=crypto.randomUUID();row.attempts++;
      db.prepare("UPDATE notification_outbox SET status='sending',attempts=?,lease_token=?,lease_until=?,updated_at=? WHERE id=?").run(row.attempts,row.lease_token,now+60000,now,row.id);
      return row;
    });
  }
  finish(row,status,error=null,delay=0) {
    this.platform.db.prepare('UPDATE notification_outbox SET status=?,error=?,available_at=?,updated_at=?,lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=? AND status=\'sending\'').run(status,error,this.clock()+delay,this.clock(),row.id,row.lease_token);
  }
  async sendOne() {
    const row=this.claim();if(!row)return;
    const state=this.loadState(),url=A.webhook(state);
    if(row.tenant_id!=='_test'&&!state.tenants?.some(t=>t.id===row.tenant_id))return this.finish(row,'blocked','Tenant wurde entfernt.');
    if(!url||A.hash(url)!==row.destination_hash)return this.finish(row,'blocked','Teams-Ziel fehlt oder wurde geändert. Ziel prüfen und erneut senden.');
    try {const u=new URL(url);if(u.protocol!=='https:'||u.username||u.password)throw new Error();}catch{return this.finish(row,'failed','Teams-Ziel muss eine gültige HTTPS-URL sein.');}
    try {
      const response=await this.fetcher(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'content-type':'application/json','X-Idempotency-Key':row.id},body:row.payload});
      await response.body?.cancel().catch(()=>{});
      if(response.ok)return this.finish(row,'sent');
      if(response.status!==429&&response.status<500)return this.finish(row,'failed',`Teams hat die Meldung abgelehnt (HTTP ${response.status}).`);
      const header=response.headers.get('retry-after');
      const retryMs=header?(Number.isFinite(Number(header))?Number(header)*1000:Date.parse(header)-this.clock()):0;
      this.finish(row,row.attempts>=8?'failed':'retry',`Teams vorübergehend nicht erreichbar (HTTP ${response.status}).`,Math.min(86400000,Math.max(5000*2**(row.attempts-1),retryMs||0)));
    } catch {
      this.finish(row,row.attempts>=8?'failed':'retry','Keine Zustellbestätigung. Automatische Wiederholung kann eine doppelte Nachricht erzeugen.',Math.min(3600000,5000*2**(row.attempts-1)));
    }
  }
}
module.exports={NotificationWorker};
