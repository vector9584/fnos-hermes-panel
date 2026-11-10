import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {StateFile,atomicWriteJSON,clone,digest,safeId,stateError} from './panel-state.js';
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const validCredentials=value=>object(value)&&Object.values(value).every(item=>typeof item==='string');

// Existing credentials are a read-only base; new versions and undo copies stay in VAR.
export class ConnectorStore {
  constructor(root,legacy){
    this.root=root;this.legacy=legacy;
    this.file=new StateFile(join(root,'connectors.json'),()=>({version:1,entries:{}}),{
      validate:value=>value?.version===1&&object(value.entries)&&Object.values(value.entries).every(entry=>
        object(entry)&&typeof entry.revision==='string'&&(entry.credentials===null||validCredentials(entry.credentials))&&
        (!entry.previous||object(entry.previous)&&(entry.previous.credentials===null||validCredentials(entry.previous.credentials))))});
  }
  base(){
    if(!existsSync(this.legacy))return {};
    let value;try{value=JSON.parse(readFileSync(this.legacy,'utf8'));}catch(_){throw stateError('原连接器凭证文件无法读取，未改写原文件',503);}
    if(!object(value)||!Object.values(value).every(validCredentials))throw stateError('原连接器凭证格式不正确，未改写原文件',503);
    return value;
  }
  get(kind){
    safeId(kind);const base=this.base(),entry=this.file.read().entries[kind];
    return entry?clone(entry):{credentials:base[kind]||null,revision:digest({kind,credentials:base[kind]||null}),activation:'existing'};
  }
  all(){const values=this.base();for(const [kind,entry]of Object.entries(this.file.read().entries)){if(entry.credentials===null)delete values[kind];else values[kind]=entry.credentials;}return values;}
  commit(kind,credentials,expected){
    const previous=this.get(kind);if(previous.revision!==expected)throw stateError('连接器已在其他页面修改，请重新读取后再保存',409);
    if(credentials!==null&&!validCredentials(credentials))throw stateError('凭证格式不正确');
    const state=this.file.read();
    // Backup is required before replacing either a credential or its prior undo copy.
    atomicWriteJSON(join(this.root,'connector-backups',kind+'-'+randomUUID()+'.json'),previous);
    const entry={credentials:clone(credentials),revision:randomUUID(),activation:'pending',updated_at:Date.now(),
      previous:{credentials:previous.credentials,activation:previous.activation}};
    state.entries[kind]=entry;this.file.write(state);return clone(entry);
  }
  activation(kind,revision,value){
    const state=this.file.read(),entry=state.entries[kind];
    if(!entry||entry.revision!==revision)throw stateError('连接器版本已变化，请刷新查看当前状态',409);
    entry.activation=value;entry.updated_at=Date.now();this.file.write(state);
  }
}
function mergedCredentials(connector,previous,body){
  const next={...(previous||{})};
  for(const field of connector.fields||[]){
    const value=body[field.key];
    if(value!==undefined&&typeof value!=='string')throw stateError('凭证字段必须是文本');
    if(typeof value==='string'&&value.trim()){if(value.length>16384)throw stateError('凭证字段过长');next[field.key]=value.trim();}
  }
  if((connector.fields||[]).some(field=>!next[field.key]))throw stateError('请填写所有必填凭证');
  return next;
}
export function createConnectorHandler({catalog,store,checkToken,probe,apply}){
  const locks=new Set();
  const summary=(connector,entry)=>({kind:connector.kind,name:connector.name,icon:connector.icon,color:connector.color,
    description:connector.description,auth_kind:connector.auth_kind,mcp_mode:connector.mcp_mode,doc_url:connector.doc_url,
    auth_hint:connector.auth_hint,fields:connector.fields,tools:connector.tools,
    configured:!!entry.credentials&&(connector.fields||[]).every(field=>!!entry.credentials[field.key]),
    revision:entry.revision,activation:entry.activation,can_undo:!!entry.previous,
    probe_supported:!!connector.impl?.probeCredentials,
    creds_set:Object.fromEntries((connector.fields||[]).map(field=>[field.key,!!entry.credentials?.[field.key]]))});
  const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
  return async function handle(req,path,applyCurrent=apply){
    const list=path==='/api/connectors',match=path.match(/^\/api\/connectors\/([A-Za-z0-9_-]+)(?:\/(restore|activate))?$/);
    if(!list&&!match)return null;
    if(!checkToken(req))return reply({ok:false,error:'请重新登录后管理连接器'},401);
    let locked,saved;
    try{
      if(list){if(req.method!=='GET')throw stateError('连接器列表仅支持读取',405);return reply({ok:true,connectors:catalog.map(connector=>summary(connector,store.get(connector.kind)))});}
      const kind=match[1],action=match[2],connector=catalog.find(item=>item.kind===kind);
      if(!connector)throw stateError('连接器不存在',404);
      let entry=store.get(kind);
      if(req.method==='GET'&&!action)return reply({ok:true,...summary(connector,entry)});
      if(!['POST','DELETE'].includes(req.method)||action&&req.method!=='POST')throw stateError('不支持这个连接器操作',405);
      if(locks.has(kind))throw stateError('此连接器正在处理，请稍后重试',409);
      locks.add(kind);locked=kind;
      const body=await req.json();
      if(!object(body)||typeof body.revision!=='string')throw stateError('缺少连接器版本，请重新打开配置');
      if(body.revision!==entry.revision)throw stateError('连接器已在其他页面修改，请重新读取后再保存',409);
      if(action==='activate'){saved=entry;}
      else{
        let credentials;
        if(action==='restore'){if(!entry.previous)throw stateError('没有可撤销的上次修改',409);credentials=entry.previous.credentials;}
        else if(req.method==='DELETE')credentials=null;
        else{
          credentials=mergedCredentials(connector,entry.credentials,body);
          if(connector.impl?.probeCredentials){try{await probe(kind,credentials);}catch(_){throw stateError('凭证校验失败，未保存；请检查凭证和网络',422);}}
        }
        saved=store.commit(kind,credentials,body.revision);
      }
      try{
        // Registration may fail after credentials were persisted: do not disguise that as a failed save.
        const applied=await applyCurrent(connector,saved.credentials);
        store.activation(kind,saved.revision,applied?.activation||'restart_requested');
      }catch(_){
        try{store.activation(kind,saved.revision,'apply_failed');}catch(_){}
        return reply({ok:false,saved:true,error:'凭证已保存，但服务配置未应用。请重试应用。',...summary(connector,store.get(kind))},503);
      }
      return reply({ok:true,saved:true,...summary(connector,store.get(kind)),message:store.get(kind).activation==='pending_restart'?'配置已保存，等待应用重启生效':'配置已保存，已请求重新加载服务'});
    }catch(error){return reply({ok:false,error:error instanceof SyntaxError?'请求格式不正确':error.message},error.status||500);}
    finally{if(locked)locks.delete(locked);}
  };
}
