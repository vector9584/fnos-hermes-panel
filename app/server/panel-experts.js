import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {StateFile,digest,safeId,stateError,clone} from './panel-state.js';

const templates=JSON.parse(readFileSync(new URL('./expert-catalog.json',import.meta.url),'utf8'));
const VAR=process.env.VAR_DIR||'/vol1/@appdata/hermes-agent';
const legacy=new StateFile(join(VAR,'experts-overrides.json'),()=>({}),{validate:v=>v&&typeof v==='object'&&!Array.isArray(v)});
const store=new StateFile(join(VAR,'panel-state','experts.json'),()=>({version:1,overrides:{},history:[]}),{validate:v=>v&&v.version===1&&v.overrides&&typeof v.overrides==='object'&&Array.isArray(v.history)});
const revisions=new StateFile(join(VAR,'panel-state','expert-revisions.json'),()=>({version:1,records:[]}),{validate:v=>v&&v.version===1&&Array.isArray(v.records)});
export function expertCatalog({query='',offset=0,limit=60,details=false,scene='',ids=null}={}){
 const overrides={...legacy.read(),...store.read().overrides},q=String(query).toLowerCase();
 const all=templates.map(t=>({...t,...overrides[t.id],id:t.id,slug:t.id}));
 const list=all.filter(e=>(!ids||ids.includes(e.id))&&(!scene||e.scene===scene)&&(!q||[e.id,e.name,e.desc,e.scene].join(' ').toLowerCase().includes(q)));
 return {total:list.length,catalog_total:all.length,scenes:[...new Set(all.map(e=>e.scene||'通用'))].sort(),experts:list.slice(offset,offset+Math.min(limit,400)).map(e=>{
  const revision=digest(e);
  if(details)return {...e,revision};
  const {prompt,skills,...summary}=e;return {...summary,revision};
 })};
}
export function getExpert(id){safeId(id);const found=templates.find(e=>e.id===id);if(!found)throw stateError('专家不存在',404);const state=store.read(),e={...found,...legacy.read()[id],...state.overrides[id],id,slug:id};return {...e,revision:digest(e),can_undo:state.history.some(record=>record.id===id)||revisions.read().records.some(record=>record.id===id)};}
export function saveExpert(id,body){
 const previous=getExpert(id);
 if(body.revision!==previous.revision)throw stateError('专家设定已被修改，请刷新后合并',409);
 const text=(key,max)=>{const v=String(body[key]??previous[key]??'').trim();if(v.length>max)throw stateError('专家'+key+'过长');return v;};
 const next={name:text('name',80),emoji:text('emoji',160),desc:text('desc',500),scene:text('scene',100),prompt:text('prompt',100000)};
 if(!next.name||!next.prompt)throw stateError('专家名称和设定不能为空');
 if(next.emoji.startsWith('/api/workspace-ui/avatars/')){
  const name=next.emoji.split('/').pop();if(!/^[a-f0-9]{64}\.(png|jpg|gif|webp)$/.test(name)||!existsSync(join(VAR,'panel-state/avatars',name)))throw stateError('头像文件不存在');
 }else if(next.emoji.length>16||/[<>/]/.test(next.emoji))throw stateError('请上传头像图片或填写表情');
 next.quick_prompts=Array.isArray(body.quick_prompts)?body.quick_prompts.map(String).map(x=>x.trim()).filter(Boolean).slice(0,12).map(x=>x.slice(0,2000)):previous.quick_prompts;
 // Historical skills metadata is retained, but never advertised as active tools.
 next.skills=previous.skills||[];
 store.update(d=>{d.history.push({id,revision:previous.revision,saved_at:Date.now(),template:clone(previous)});d.overrides[id]=next;});return getExpert(id);
}
export function undoExpert(id,revision){
 const current=getExpert(id);if(revision!==current.revision)throw stateError('专家设定已在其他页面修改，请读取最新版本',409);
 const previous=[...revisions.read().records,...store.read().history].filter(record=>record.id===id).at(-1);
 if(!previous)throw stateError('此专家没有可撤销的修改',404);
 return saveExpert(id,{...previous.template,revision:current.revision});
}
