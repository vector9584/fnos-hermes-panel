import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import * as fs from 'node:fs';
import {stateError} from './panel-state.js';
import {configRequestContext,configTransaction} from './panel-config-txn.js';
export function envTransaction({python,serverRoot,state,file,body,run=spawnSync}){
 const result=run(python,['-B',join(serverRoot,'panel_env_txn.py'),file,state],{input:JSON.stringify(body),encoding:'utf8',timeout:15000,maxBuffer:1024*1024,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
 let output;try{output=JSON.parse(result.stdout);}catch{throw stateError('凭证操作未收到确认，请重新读取核对',503);}
 if(!output.ok)throw stateError(output.error,output.status||500);return output;
}
export function envReaderWriter(options){
 const local=new Map(),snapshots=()=>configRequestContext.getStore()||local;
 const read=()=>{try{return fs.readFileSync(options.getFile(),'utf8');}catch(error){if(error.code==='ENOENT')return '';throw stateError('凭证文件无法读取，尚未保存',503);}};
 return {read(){const text=read();snapshots().set(options.getFile(),text);return text;},write(after){const file=options.getFile(),before=snapshots().get(file);if(before===undefined)throw stateError('保存凭证前必须先读取配置',409);const result=envTransaction({...options,file,body:{action:'replace_changes',before,after}});snapshots().set(file,read());return result;}};
}
// Transitional channel writer: keep both edited texts in memory and publish
// them together only after the synchronous channel operation finishes.
export function channelConfigWriter(options){
 let active=null;
 function fileText(file){try{return fs.readFileSync(file,'utf8');}catch(error){if(error.code==='ENOENT')return '';throw stateError('通讯配置无法读取，尚未保存',503);}}
 return {
  get active(){return active!==null;},
  read(kind){if(!active)throw stateError('通讯事务尚未开始',500);return active[kind+'_after'];},
  write(kind,text){if(!active)throw stateError('通讯事务尚未开始',500);active[kind+'_after']=text;},
  run(work){
   if(active)return work();
   const file=options.getConfig(),envFile=options.getEnv();if(join(file,'..','.env')!==envFile)throw stateError('通讯凭证与配置不在同一环境，拒绝跨环境保存',409);
   const before=fileText(file),env_before=fileText(envFile);active={yaml_after:before,env_after:env_before};
   try{const result=work();if(result?.then)throw stateError('通讯事务不接受异步回调',500);if(result?.ok===false)return result;
    const saved=configTransaction({...options,file,body:{action:'bundle_changes',before,after:active.yaml_after,env_before,env_after:active.env_after}});
    return {...result,change_id:saved.change_id,changed:saved.changed,restart_required:!!saved.changed};
   }finally{active=null;}
  }
 };
}
