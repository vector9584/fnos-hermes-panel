import * as fs from 'node:fs';
import {createHash,randomBytes} from 'node:crypto';
import {join} from 'node:path';
import {atomicWriteJSON} from './panel-state.js';

const ALLOWED=new Set(['gateway.log','errors.log','agent.log','gui.log','gateway-restart.log','gateway-shutdown-diag.log','gateway-exit-diag.log','hermes.log']);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

export class LogClearStore{
 constructor({varDir,dataDir,io=fs,now=Date.now,id=()=>randomBytes(16).toString('hex')}={}){this.varDir=varDir;this.dataDir=dataDir;this.io=io;this.now=now;this.id=id;}
 path(file){if(!ALLOWED.has(file))throw Object.assign(new Error('disallowed'),{status:400});return file==='hermes.log'?join(this.varDir,file):join(this.dataDir,'logs',file);}
 pending(){const dir=join(this.varDir,'panel-state/log-clear');if(!this.io.existsSync(dir))return[];return this.io.readdirSync(dir).filter(name=>/^[a-f0-9]{32}\.json$/.test(name)).map(name=>{try{const item=JSON.parse(this.io.readFileSync(join(dir,name),'utf8'));return item.version===1&&item.id===name.slice(0,-5)&&!item.restored_at?{id:item.id,file:item.file,created_at:item.created_at,clear_state:item.clear_state||'cleared'}:null;}catch{return null;}}).filter(Boolean).sort((a,b)=>a.created_at-b.created_at);}
 clear(file){
  const target=this.path(file),id=this.id();if(!/^[a-f0-9]{32}$/.test(id))throw Error('invalid undo id');
  const dir=join(this.varDir,'panel-state/log-clear'),backup=join(dir,id+'.log'),recordPath=join(dir,id+'.json');
  const original=this.io.existsSync(target)?this.io.readFileSync(target):Buffer.alloc(0),digest=sha(original);
  this.io.mkdirSync(dir,{recursive:true,mode:0o700});this.io.writeFileSync(backup,original,{flag:'wx',mode:0o600});
  const record={version:1,id,file,sha256:digest,bytes:original.length,created_at:this.now(),restored_at:null,clear_state:'prepared'};
  atomicWriteJSON(recordPath,record,this.io);
  try{if(this.io.existsSync(target))this.io.writeFileSync(target,'');}
  catch(error){
   let after;
   try{after=this.io.readFileSync(target);}catch{}
   if(after&&after.equals(original)){
    for(const path of [recordPath,backup])try{this.io.unlinkSync(path);}catch{}
    }else{
    try{record.clear_state=after&&after.length===0?'cleared':'uncertain';atomicWriteJSON(recordPath,record,this.io);}catch{}
    error.undo_id=id;
   }
   throw error;
  }
  try{record.clear_state='cleared';atomicWriteJSON(recordPath,record,this.io);}catch(error){error.undo_id=id;throw error;}
  return {ok:true,undo_id:id,bytes:original.length};
 }
 restore(id){
  if(typeof id!=='string'||!/^[a-f0-9]{32}$/.test(id))throw Object.assign(new Error('撤销记录无效'),{status:400});
  const dir=join(this.varDir,'panel-state/log-clear'),recordPath=join(dir,id+'.json'),backupPath=join(dir,id+'.log');
  const record=JSON.parse(this.io.readFileSync(recordPath,'utf8'));
  if(record.version!==1||record.id!==id||record.restored_at)throw Object.assign(new Error('该清空记录已恢复或不存在'),{status:409});
  const target=this.path(record.file),original=this.io.readFileSync(backupPath);
  if(original.length!==record.bytes||sha(original)!==record.sha256)throw Object.assign(new Error('撤销快照校验失败，未恢复日志'),{status:409});
  const initial=this.io.existsSync(target)?this.io.readFileSync(target):Buffer.alloc(0);
  if(record.clear_state==='uncertain'||(record.clear_state==='prepared'&&!initial.equals(Buffer.alloc(0))))throw Object.assign(new Error('清空结果未能确认，未自动恢复；请先读取当前日志，确认后再重试'),{status:409});
  if(record.clear_state==='prepared'&&initial.equals(original)){
   record.clear_state='unchanged';record.restored_at=this.now();atomicWriteJSON(recordPath,record,this.io);
   return {ok:true,file:record.file,restored_bytes:0,unchanged:true};
  }
  const marker=Buffer.from(`\n--- 已恢复日志撤销记录 ${id} · ${record.file} · ${new Date(record.created_at).toISOString()} ---\n`);
  const current=this.io.existsSync(target)?this.io.readFileSync(target):Buffer.alloc(0),markerAt=current.indexOf(marker);
  if(original.length){
   if(markerAt<0){
    if(current.length){
     let markerPrefix=0;const existingLineBreak=current.at(-1)===10?1:0;for(let size=Math.min(marker.length-1,current.length);size>existingLineBreak;size--)if(current.subarray(current.length-size).equals(marker.subarray(0,size))){markerPrefix=size;break;}
     if(markerPrefix)this.io.appendFileSync(target,marker.subarray(markerPrefix));else this.io.appendFileSync(target,marker);
    }
    this.io.appendFileSync(target,original);
   }
   else{
    const after=current.subarray(markerAt+marker.length);
    if(!after.subarray(0,original.length).equals(original)){
     let written=0;while(written<original.length&&written<after.length&&after[written]===original[written])written++;
     this.io.appendFileSync(target,original.subarray(written));
    }
   }
  }
  record.restored_at=this.now();record.clear_state='restored';atomicWriteJSON(recordPath,record,this.io);
  return {ok:true,file:record.file,restored_bytes:original.length};
 }
}
