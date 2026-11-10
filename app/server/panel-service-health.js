// Authenticated, bounded local probes. Persisted files and open ports alone
// cannot prove readiness or absence of active external-channel/cron work.
export class ServiceHealth {
 constructor({gateway,dashboard,identity,fetcher=fetch,now=Date.now}){Object.assign(this,{gateway,dashboard,identity,fetcher,now});this.inflight=null;this.latest=null;}
 async json(url,headers){const r=await this.fetcher(url,{headers,signal:AbortSignal.timeout(2500),redirect:'error'});if(!r.ok)throw Error('health unavailable');const reader=r.body.getReader();let bytes=0,parts=[];try{while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>256*1024)throw Error('health too large');parts.push(Buffer.from(value));}return JSON.parse(Buffer.concat(parts).toString('utf8'));}finally{await reader.cancel().catch(()=>{});}}
 refresh(){if(this.inflight)return this.inflight;this.inflight=this.probe().finally(()=>this.inflight=null);return this.inflight;}
 async probe(){
  const before={gateway:this.identity('gateway'),dashboard:this.identity('dashboard')};
  const same=(kind)=>{const current=this.identity(kind),old=before[kind];return !!old&&!!current&&old.pid===current.pid&&old.start===current.start;};
  const [gw,db]=await Promise.allSettled([
   before.gateway?this.json(this.gateway.url,{Authorization:'Bearer '+this.gateway.token()}):Promise.reject(Error()),
   before.dashboard?this.json(this.dashboard.url,{'X-Hermes-Session-Token':this.dashboard.token()}):Promise.reject(Error()),
  ]);
  const g=gw.status==='fulfilled'?gw.value:null,d=db.status==='fulfilled'?db.value:null;
  const counts=g?.readiness?.checks?.background_queues;
  const integer=value=>Number.isSafeInteger(value)&&value>=0;
  const verified=!!g&&same('gateway')&&g.platform==='hermes-agent'&&g.pid===before.gateway.pid;
  const workKnown=verified&&integer(g.active_agents)&&!!counts&&['active_api_runs','process_completions','active_delegations'].every(key=>integer(counts[key]));
  const active=workKnown?{agents:g.active_agents,api:counts.active_api_runs,completions:counts.process_completions,delegations:counts.active_delegations}:null;
  this.latest={observed_at:this.now(),gateway:{running:!!before.gateway,state:verified&&['running','draining','starting','stopping','stopped'].includes(g.gateway_state)?g.gateway_state:null,healthy:verified&&g.status==='ok'&&g.readiness?.status==='ok'&&g.gateway_state==='running',verified,work_known:workKnown,active,busy:workKnown?Object.values(active).some(v=>v>0):null},dashboard:{running:!!before.dashboard,healthy:!!d&&same('dashboard')&&typeof d.version==='string'&&typeof d.gateway_running==='boolean'}};
  return this.snapshot();
 }
 snapshot(){if(!this.latest||this.now()-this.latest.observed_at>10000)return {observed_at:this.latest?.observed_at||null,stale:true,gateway:{healthy:false,work_known:false,busy:null},dashboard:{healthy:false}};return {...this.latest,stale:false};}
}
