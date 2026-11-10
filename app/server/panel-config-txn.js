import {AsyncLocalStorage} from 'node:async_hooks';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import * as fs from 'node:fs';
import {stateError} from './panel-state.js';
export function configTransaction({python,serverRoot,state,file,body,run=spawnSync}){
 const result=run(python,['-B',join(serverRoot,'panel_config_txn.py'),file,state],{input:JSON.stringify(body),encoding:'utf8',timeout:15000,maxBuffer:1024*1024,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
 let output;try{output=JSON.parse(result.stdout);}catch{throw stateError('配置操作未收到确认，请重新读取核对',503);}
 if(!output.ok)throw stateError(output.error,output.status||500);
 return output;
}
export const configRequestContext=new AsyncLocalStorage();
export function configReaderWriter(options){
 const local=new Map(),snapshots=()=>configRequestContext.getStore()||local;
 return {read(){const file=options.getFile();const text=fs.readFileSync(file,'utf8');snapshots().set(file,text);return text;},write(after){const file=options.getFile(),before=snapshots().get(file);if(before===undefined)throw stateError('保存前必须先读取配置',409);const result=configTransaction({...options,file,body:{action:'replace_changes',before,after,reason:options.reason||'面板配置修改'}});snapshots().set(file,fs.readFileSync(file,'utf8'));return result;}};
}
