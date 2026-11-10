import * as fs from 'node:fs';
import {join} from 'node:path';
import {isApplicationService} from './panel-process-guard.js';

export function createServiceProcesses({hermesBin,venvBin,pidFiles,io=fs,proc='/proc',signal=(pid,name)=>process.kill(pid,name),delay=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now}){
 function identity(pid,kind){
  if(!Number.isSafeInteger(pid)||pid<=0)return null;
  try{
   const argv=io.readFileSync(join(proc,String(pid),'cmdline'),'utf8').split('\0').filter(Boolean);
   if(!isApplicationService(argv,{hermesBin,venvBin}))return null;
   const index=argv.indexOf(hermesBin),command=index>=0?argv[index+1]:argv[3];
   if(command!==kind)return null;
   const raw=io.readFileSync(join(proc,String(pid),'stat'),'utf8'),fields=raw.slice(raw.lastIndexOf(')')+2).trim().split(/\s+/);
   if(['Z','X'].includes(fields[0])||!/^\d+$/.test(fields[19]))return null;
   return {pid,kind,start:fields[19]};
  }catch{return null;}
 }
 function matches(saved){const current=identity(saved.pid,saved.kind);return !!current&&current.start===saved.start;}
 function read(kind){try{return identity(Number(io.readFileSync(pidFiles[kind],'utf8').trim()),kind);}catch{return null;}}
 function find(kind){try{for(const name of io.readdirSync(proc)){if(!/^\d+$/.test(name))continue;const found=identity(Number(name),kind);if(found)return found;}}catch{}return null;}
 function forget(kind,pid){try{const recorded=Number(io.readFileSync(pidFiles[kind],'utf8').trim());if(recorded===pid||!identity(recorded,kind))io.unlinkSync(pidFiles[kind]);}catch{}}
 async function stop(kind){
  const saved=read(kind)||find(kind);if(!saved)return {ok:true,stopped:false};
  // Every signal rechecks exact command ownership and the PID incarnation.
  try{if(matches(saved))signal(saved.pid,'SIGTERM');}catch(error){if(error.code!=='ESRCH')return {ok:false,error:'无法停止应用服务，请检查运行用户权限'};}
  const deadline=now()+5000;
  while(matches(saved)&&now()<deadline)await delay(100);
  if(matches(saved)){try{signal(saved.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')return {ok:false,error:'应用服务仍在运行，未完成停止'};}await delay(200);}
  if(matches(saved))return {ok:false,error:'应用服务尚未退出，请稍后核对'};
  if(!identity(saved.pid,kind))forget(kind,saved.pid);return {ok:true,stopped:true};
 }
 return {identity,read,find,stop,matches};
}
