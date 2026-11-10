import {spawnSync,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';
import {stateError} from './panel-state.js';

// APP-owned receipt checks; the approved DATA development script stays intact.
export function createRestartReceipt({python,app,home,varDir,node=process.execPath,pid=process.pid,run=spawnSync,verifyRun=promisify(execFile)}){
 function call(action,before){
  const result=run(python,['-B',join(app,'server/panel_restart_receipt.py'),action,app,home,varDir,node,...(before?[JSON.stringify(before),String(pid)]:[])],{encoding:'utf8',timeout:2500,maxBuffer:16384,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
  let value;try{value=JSON.parse(result.stdout);}catch{throw stateError('无法核实Monitor重启身份，请查看维护记录',503);}
  if(result.status!==0)throw stateError('Monitor重启身份核验失败，请查看维护记录',503);
  return value;
 }
 let pending=false,confirmed=null,captured=null;
 return {
  python,app,home,varDir,node,
  capture(){const before=call('capture');if(!before||before.pid!==pid||typeof before.start!=='string')throw stateError('当前Monitor身份未获确认，尚未请求重启',503);captured=before;return before;},
  verify(before,requestId,worker){
   if(!before||(captured&&before.pid===captured.pid&&before.start===captured.start))return false;
   if(!requestId||!worker?.pid||!worker?.start)return false;
   const key=JSON.stringify({before,requestId,worker:{pid:worker.pid,start:worker.start}});if(confirmed===key)return true;
   if(!pending){pending=true;verifyRun(python,['-B',join(app,'server/panel_restart_receipt.py'),'verify',app,home,varDir,node,JSON.stringify(before),String(pid),requestId,JSON.stringify(worker)],{timeout:2500,maxBuffer:16384,encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}}).then(result=>{try{if(JSON.parse(result.stdout).verified===true)confirmed=key;}catch{}}).catch(()=>{}).finally(()=>{pending=false;});}
   return false;
  }
 };
}
