import * as fs from 'node:fs';
import {join,resolve} from 'node:path';

const labels={connected:'已连接',connecting:'正在连接',retrying:'正在重连',fatal:'连接失败',paused:'已暂停',disabled:'已停用',disconnected:'连接已断开'};
const authVars={weixin:'WEIXIN_ALLOW_ALL_USERS',qqbot:'QQ_ALLOW_ALL_USERS',discord:'DISCORD_ALLOW_ALL_USERS',feishu:'FEISHU_ALLOW_ALL_USERS',telegram:'TELEGRAM_ALLOW_ALL_USERS',wecom:'WECOM_ALLOW_ALL_USERS'};
const enabled=value=>['true','1','yes'].includes(String(value||'').toLowerCase());
function readBounded(io,path,limit=1024*1024){const fd=io.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const st=io.fstatSync(fd);if(!st.isFile()||st.size>limit)throw Error('invalid file');const bytes=Buffer.alloc(limit+1),size=io.readSync(fd,bytes,0,bytes.length,0);if(size>limit)throw Error('large file');return bytes.subarray(0,size).toString('utf8');}finally{io.closeSync(fd);}}

// Read-only Linux observation. Never return raw argv, environment, upstream
// error strings or credentials. A persisted connected record alone is not
// evidence that its original Gateway is still running.
export function createChannelRuntime({home,gatewayPid,hermesBin,io=fs,proc='/proc',now=Date.now}){
 return function observe(){
  const unavailable=reason=>({verified:false,reason,observed_at:now(),platforms:{}});
  try{
   const pid=gatewayPid();if(!Number.isSafeInteger(pid)||pid<=0)return unavailable('gateway_stopped');
   let record;try{record=JSON.parse(readBounded(io,join(home,'gateway_state.json')));}catch{return unavailable('record_unavailable');}
   if(record.kind!=='hermes-gateway'||record.pid!==pid||!Number.isSafeInteger(record.start_time))return unavailable('process_changed');
   const base=join(proc,String(pid)),stat=readBounded(io,join(base,'stat'),16384),fields=stat.slice(stat.lastIndexOf(')')+2).split(/\s+/);
   if(['Z','X'].includes(fields[0])||Number(fields[19])!==record.start_time)return unavailable('process_changed');
   const argv=readBounded(io,join(base,'cmdline'),65536).split('\0').filter(Boolean),index=argv.indexOf(hermesBin);
   if(index<0||index>1||(index===1&&!['python','python3'].some(name=>argv[0]===join(home,'venv/bin',name)))||argv[index+1]!=='gateway'||argv[index+2]!=='run')return unavailable('process_changed');
   let env=null;try{env=Object.create(null);for(const entry of readBounded(io,join(base,'environ')).split('\0')){const at=entry.indexOf('=');if(at>0)env[entry.slice(0,at)]=entry.slice(at+1);}}catch{env=null;}
   const processHome=env?.HERMES_HOME||record.hermes_home;
   if(!processHome||resolve(processHome)!==resolve(home))return unavailable('environment_mismatch');
   const btime=readBounded(io,join(proc,'stat'),65536).match(/^btime (\d+)$/m);
   // USER_HZ is 100 on this Linux NAS; process identity also requires the
   // exact native start_time fingerprint, independent of wall-clock age.
   const started=Number(btime?.[1])*1000+record.start_time*10;
   if(!btime||!Number.isFinite(started)||started>now()+2000)return unavailable('record_unavailable');
   const state=record.gateway_state,platforms={};
   for(const id of Object.keys(authVars)){
    const entry=record.platforms?.[id],at=Date.parse(entry?.updated_at),current=Number.isFinite(at)&&at>=started-1000&&at<=now()+5000;
    const status=['running','starting','draining'].includes(state)&&current&&Object.hasOwn(labels,entry?.state)?entry.state:state==='stopped'||state==='stopping'||state==='startup_failed'?'gateway_stopped':'not_observed';
    platforms[id]={state:status,label:labels[status]||(status==='gateway_stopped'?'网关已停止':'本次启动尚无连接记录'),updated_at:current?at:null,authorization:env?{platform_allow_all:enabled(env[authVars[id]]),global_allow_all:enabled(env.GATEWAY_ALLOW_ALL_USERS)}:null};
   }
   // Recheck identity after reading several /proc files, including PID reuse.
   const finalRaw=readBounded(io,join(base,'stat'),16384),finalStat=finalRaw.slice(finalRaw.lastIndexOf(')')+2).split(/\s+/);
   if(gatewayPid()!==pid||Number(finalStat[19])!==record.start_time)return unavailable('process_changed');
   return {verified:true,gateway_state:['running','starting','draining','stopping','stopped','startup_failed'].includes(state)?state:'not_observed',observed_at:now(),started_at:started,platforms};
  }catch{return unavailable('observation_failed');}
 };
}
