import * as fs from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

// The pipe is a launch barrier: EOF (including Monitor death) never authorizes
// the official script. Persist the exact waiting child's identity before release.
export function launchRestartWorker({start,source,fd,worker,persist,onError,onExit,requestId,python,app,home,varDir,node,procRoot='/proc'}){
 const permit=randomUUID();
 const withReceipt=!!(requestId&&python&&app&&home&&varDir&&node);
 const command=withReceipt
  ?'IFS= read -r permit || exit 75; [ "$permit" = "$1" ] || exit 76; IFS= read -r worker_start || exit 77; bash dev/hermes-dev.sh restart; result=$?; "$3" -B "$4" finish "$5" "$6" "$7" "$8" "$2" "$$" "$worker_start" "$result" "$9" || exit 78; exit "$result"'
  :'IFS= read -r permit || exit 75; [ "$permit" = "$1" ] || exit 76; exec bash dev/hermes-dev.sh restart';
 const args=withReceipt?['-c',command,'panel-restart-gate',permit,requestId,python,join(app,'server/panel_restart_receipt.py'),app,home,varDir,node,procRoot]:['-c',command,'panel-restart-gate',permit];
 const child=start('bash',args,{cwd:source,detached:true,stdio:['pipe',fd,fd],env:{...process.env,HERMES_RESTART_RECEIPT:withReceipt?'1':'0'}});
 child.once('error',onError);child.once('exit',onExit);
 child.stdin?.once('error',onError);
 try{
  if(!child.stdin)throw Error('restart gate pipe unavailable');
  const identity=worker.capture(child.pid);
  if(identity.state!=='running'||!identity.start)throw Error('restart gate identity unavailable');
  persist(identity);
  child.stdin.end(permit+'\n'+(withReceipt?identity.start+'\n':''));
  child.unref?.();
  return child;
 }catch(error){child.stdin?.destroy();child.unref?.();throw error;}
}

// Observe only the child returned by spawn; never signal or adopt another PID.
export function createRestartWorker({io=fs,proc='/proc'}={}){
 function read(pid){
  if(!Number.isSafeInteger(pid)||pid<=0)return {state:'unverified'};
  try{
   const raw=io.readFileSync(join(proc,String(pid),'stat'),'utf8');
   const fields=raw.slice(raw.lastIndexOf(')')+2).trim().split(/\s+/);
   if(!/^\d+$/.test(fields[19]||''))return {state:'unverified'};
   return {state:['Z','X'].includes(fields[0])?'exited':'running',start:fields[19]};
  }catch(error){return {state:['ENOENT','ESRCH'].includes(error.code)?'exited':'unverified'};}
 }
 return {
  capture(pid){const found=read(pid);return {pid,...found};},
  observe(saved){
   if(!saved||!Number.isSafeInteger(saved.pid)||!saved.start)return {state:saved?.state==='exited'?'exited':'unverified'};
   const current=read(saved.pid);
   if(current.start&&current.start!==saved.start)return {state:'exited'};
   return {state:current.state};
  }
 };
}
