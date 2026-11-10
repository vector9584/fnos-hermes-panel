import {createVoiceSettings} from './panel-voice-settings.js';
import {createSpeechService} from './panel-speech.js';
import {readFileSync,existsSync} from 'fs';
import {join} from 'path';
import {randomUUID,createHash} from 'crypto';
import {StateFile, SessionDrafts, atomicWrite, safeId, stateError, digest} from './panel-state.js';
import {planSystem} from './panel-plans.js';
import {expertCatalog,getExpert,saveExpert,undoExpert} from './panel-experts.js';
import {execFile} from 'child_process';
import {promisify} from 'util';
const run=promisify(execFile);
const DATA=process.env.DATA_DIR||'/vol1/@apphome/hermes-agent/data';
const VAR=process.env.VAR_DIR||'/vol1/@appdata/hermes-agent';
const APP=process.env.APP_DIR||'/vol1/@appcenter/hermes-agent';
const PYTHON=process.env.PANEL_PYTHON||join(DATA,'venv/bin/python3');
const SERVER_ROOT=process.env.PANEL_SERVER_ROOT||APP;
const FILE=join(DATA,'panel-workspace.json');
const ROOT=join(VAR,'panel-state');
const overlay=new StateFile(join(ROOT,'workspace.json'),()=>({version:2}),{validate:d=>d&&d.version===2});
const drafts=new SessionDrafts(ROOT);
const defaults=()=>({version:1,folders:[],sessions:{},identity:{user_name:'Vector',user_avatar:'👤',assistant_name:'Hermes',assistant_avatar:'🤖',avatar_shape:'rounded'},voice:{engine:'windows',fallback:true,system_voice:'zh-CN-XiaoxiaoNeural'},favorites:[]});
function readLegacy(){const d=existsSync(FILE)?JSON.parse(readFileSync(FILE,'utf8')):{};return {...defaults(),...d,identity:{...defaults().identity,...d.identity},voice:{...defaults().voice,...d.voice}};}
export function readWorkspace(){const d=readLegacy(),o=overlay.read();return {...d,...o,identity:{...d.identity,...o.identity},voice:{...d.voice,...o.voice},sessions:{...d.sessions,...o.sessions}};}
export function bindSessionPlan(id,plan){if(!validSession(id))throw stateError('会话不存在',404);const d=readWorkspace(),meta=d.sessions[id]||{};if(meta.plan)return meta;d.sessions[id]={...meta,plan};save(d);return d.sessions[id];}
function save(d){
 const base=readLegacy(),o={version:2};
 for(const key of Object.keys(d)){
  if(key==='version')continue;
  if(['identity','voice','sessions'].includes(key)){
   const changed={};for(const [k,v]of Object.entries(d[key]||{}))if(digest(v)!==digest(base[key]?.[k]??null))changed[k]=v;
   if(Object.keys(changed).length)o[key]=changed;
  }else if(digest(d[key])!==digest(base[key]??null))o[key]=d[key];
 }
 overlay.write(o);
}
export function sessionSnapshot(sid,system=''){
 const d=readWorkspace(),meta=d.sessions[sid]||{};
 return {system:sessionSystem(sid,system),identity:sessionIdentity(sid,system),user_identity:{sender:d.identity.user_name,sender_avatar:d.identity.user_avatar,sender_kind:'user'},expert:meta.expert||null,personality:meta.personality||null,plan:meta.plan||null};
}
export function sessionExpert(sid){return readWorkspace().sessions[sid]?.expert||null;}
export function sessionIdentity(sid,system=''){
 const d=readWorkspace(),meta=d.sessions[sid]||{},e=meta.expert;
 if(meta.plan)return {sender:meta.plan.name,sender_avatar:'🧭',sender_kind:'coordinator',plan_id:meta.plan.id};
 if(e)return {sender:e.name,sender_avatar:e.emoji,sender_kind:'expert',expert_id:e.id};
 const named=String(system).match(/【专家角色】([^\n]+)/);
 return named?{sender:named[1].trim(),sender_avatar:'🧠',sender_kind:'expert'}:{sender:d.identity.assistant_name,sender_avatar:d.identity.assistant_avatar,sender_kind:'default'};
}
export const PERSONALITIES=Object.freeze([
 {id:'default',name:'默认表达',prompt:''},
 {id:'concise',name:'简洁',prompt:'直接给结论和必要步骤，减少重复和铺垫，保留关键条件。'},
 {id:'technical',name:'技术',prompt:'使用准确的专业术语，解释关键机制，提供可验证的细节与依据。'},
 {id:'teacher',name:'教学',prompt:'循序渐进解释，先建立必要概念，再用具体例子说明；根据用户基础调整深度。'},
 {id:'creative',name:'创意',prompt:'在事实与约束范围内提出多样思路，明确区分构想与已验证的事实。'},
]);
export function sessionSystem(sid,system=''){
 const meta=readWorkspace().sessions[sid]||{},e=meta.expert,p=PERSONALITIES.find(p=>p.id===meta.personality);
 // Fixed order and fixed text: no per-turn input, time, or fake tool list in system.
 const parts=[system];
 if(meta.plan)parts.push(planSystem(meta.plan));
 if(e&&!meta.plan)parts.push('【会话专家职责】'+e.name+'\n'+e.prompt+'\n专家设定不授予额外工具或权限。实际能力以当前工具定义与技能索引为准。');
 if(p?.prompt)parts.push('【表达偏好：'+p.name+'】\n'+p.prompt+'\n本层只调整表达，不改变 SOUL、项目规范、专家职责或工具权限；有冲突时保留上述规则。');
 return parts.filter(Boolean).join('\n\n');
}
const json=(d,status=200)=>new Response(JSON.stringify(d),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
const clean=(x,n)=>String(x??'').trim().slice(0,n);
function validSession(id){safeId(id);return existsSync(join(VAR,'chat/sessions',id+'.json'));}
function avatar(value){const v=String(value||'');if(v.startsWith('/api/workspace-ui/avatars/')){if(!/^\/api\/workspace-ui\/avatars\/[a-f0-9]{64}\.(png|jpg|gif|webp)$/.test(v)||!existsSync(join(ROOT,'avatars',v.split('/').pop())))throw stateError('头像文件不存在，请重新上传');return v;}if(v.length>16||/[<>\/]/.test(v))throw stateError('请上传图片或填写一个表情');return v;}
function expert(e){if(e===null)return null;if(!e||!clean(e.name,80)||!clean(e.prompt,100000))throw Error('专家名称和设定不能为空');const snapshot={id:clean(e.id,100),name:clean(e.name,80),emoji:avatar(e.emoji)||'🧠',prompt:clean(e.prompt,100000),quick_prompts:Array.isArray(e.quick_prompts)?e.quick_prompts.map(x=>clean(x,2000)).slice(0,12):[],skills:Array.isArray(e.skills)?e.skills.map(x=>clean(x,100)).slice(0,30):[]};return {...snapshot,revision:digest(snapshot),captured_at:Date.now()};}
async function ttsApi(path,body,signal){const r=await fetch('http://127.0.0.1:8902'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Auth-User':'hermes-agent'},body:body?JSON.stringify(body):undefined,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(60000)]):AbortSignal.timeout(60000)});if(!r.ok)throw Error('语音工作台暂不可用 ('+r.status+')');const d=await r.json();if(d.ok===false)throw Error(d.error||'语音设置失败');return d;}
const voiceSettings=createVoiceSettings({api:ttsApi,read:()=>readWorkspace().voice,save:voice=>{const state=readWorkspace();state.voice={...state.voice,...voice};save(state);},ledger:new StateFile(join(ROOT,'voice-save.json'),()=>({status:'none'}))});
const speech=createSpeechService({data:DATA,voice:()=>readWorkspace().voice,windowsCurrent:async signal=>(await ttsApi('/voice/current',undefined,signal)).current});
export async function handleWorkspace(req,checkToken,routePath){
 const u=new URL(req.url),p=routePath||u.pathname;if(!p.startsWith('/api/workspace-ui'))return null;
 const method=req.method;
 // Workspace metadata and prompt content are private even when read-only.
 // Content-addressed avatar files are the sole public exception because they
 // are consumed by <img src> and contain no workspace metadata.
 if(!(method==='GET'&&p.startsWith('/api/workspace-ui/avatars/'))&&!checkToken(req))return json({error:'Unauthorized'},401);
 try{
 if(p==='/api/workspace-ui'&&method==='GET')return json(readWorkspace());
 if(p==='/api/workspace-ui/experts'&&method==='GET')return json(expertCatalog({query:clean(u.searchParams.get('q'),160),offset:Math.max(0,Number(u.searchParams.get('offset'))||0),limit:Math.max(1,Number(u.searchParams.get('limit'))||60),details:u.searchParams.get('details')==='1',scene:clean(u.searchParams.get('scene'),100),ids:u.searchParams.get('favorites')==='1'?readWorkspace().favorites:null}));
 if(/^\/api\/workspace-ui\/experts\/[\w-]+\/undo$/.test(p)&&method==='POST')return json({ok:true,expert:undoExpert(p.split('/').at(-2),(await req.json()).revision)});
 if(/^\/api\/workspace-ui\/experts\/[\w-]+$/.test(p)){
  const id=p.split('/').pop();if(method==='GET')return json({expert:getExpert(id)});if(method==='PUT')return json({ok:true,expert:saveExpert(id,await req.json())});
 }
 if(p==='/api/workspace-ui/personalities'&&method==='GET')return json({personalities:PERSONALITIES.map(({id,name})=>({id,name}))});
 if(p==='/api/workspace-ui/draft'){
  if(!checkToken(req))return json({error:'请重新连接面板'},401);
  const id=u.searchParams.get('session_id');if(id!=='new'&&!validSession(id))return json({error:'会话不存在'},404);
  if(method==='GET')return json(drafts.get(id));
  if(method==='PUT'){const result=drafts.put(id,await req.json());return json(result,result.conflict?409:200);}
 }
 if(p==='/api/workspace-ui/avatars'&&method==='POST'){
  const form=await req.formData(),file=form.get('file');if(!file||typeof file==='string')throw stateError('请选择头像图片');
  if(file.size>2*1024*1024)throw stateError('头像不得超过 2 MB',413);
  const b=Buffer.from(await file.arrayBuffer());
  const kind=b.length>24&&b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'png':b.length>12&&b[0]===255&&b[1]===216&&b[2]===255?'jpg':b.length>16&&b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP'?'webp':b.length>13&&b[0]===71&&b[1]===73&&b[2]===70&&b[3]===56&&[55,57,97].includes(b[4])?'gif':null;
  if(!kind)throw stateError('请使用 PNG、JPEG、GIF 或 WebP 图片',415);
  const name=createHash('sha256').update(b).digest('hex')+'.'+kind;
  atomicWrite(join(ROOT,'avatars',name),b);
  return json({ok:true,url:'/api/workspace-ui/avatars/'+name});
 }
 if(p.startsWith('/api/workspace-ui/avatars/')&&method==='GET'){
  const name=p.split('/').pop();if(!/^[a-f0-9]{64}\.(png|jpg|gif|webp)$/.test(name))return json({error:'头像不存在'},404);
  const file=join(ROOT,'avatars',name);if(!existsSync(file))return json({error:'头像不存在'},404);
  return new Response(readFileSync(file),{headers:{'Content-Type':name.endsWith('.png')?'image/png':name.endsWith('.jpg')?'image/jpeg':name.endsWith('.gif')?'image/gif':'image/webp','X-Content-Type-Options':'nosniff','Cache-Control':'private,max-age=31536000,immutable'}});
 }
 if(p==='/api/workspace-ui/folders'&&method==='POST'){
  const b=await req.json(),d=readWorkspace(),name=clean(b.name,80),parent=clean(b.parent_id,80);if(!name)throw Error('请输入文件夹名称');if(parent&&!d.folders.some(f=>f.id===parent))throw Error('上级文件夹不存在');
  const folder={id:randomUUID(),name,parent_id:parent};d.folders.push(folder);save(d);return json({ok:true,folder});
 }
 if(p==='/api/workspace-ui/folders'&&method==='PUT'){
  const b=await req.json(),d=readWorkspace(),f=d.folders.find(f=>f.id===b.id);if(!f)throw Error('文件夹不存在');const name=clean(b.name,80),parent=clean(b.parent_id,80);if(!name)throw Error('请输入名称');let node=parent;const visited=new Set([f.id]);while(node){if(visited.has(node))throw Error('不能移动到自身或子文件夹');visited.add(node);const par=d.folders.find(f=>f.id===node);if(!par)throw Error('上级文件夹不存在');node=par.parent_id;}f.name=name;f.parent_id=parent;save(d);return json({ok:true});
 }
 if(p==='/api/workspace-ui/folders'&&method==='DELETE'){
  const b=await req.json(),d=readWorkspace(),f=d.folders.find(f=>f.id===b.id);if(!f)throw Error('文件夹不存在');d.folders=d.folders.filter(x=>x.id!==f.id);d.folders.forEach(x=>{if(x.parent_id===f.id)x.parent_id=f.parent_id;});Object.values(d.sessions).forEach(s=>{if(s.folder_id===f.id)s.folder_id=f.parent_id;});save(d);return json({ok:true});
 }
 if(p==='/api/workspace-ui/session'&&method==='PUT'){
  const b=await req.json(),d=readWorkspace();if(!validSession(b.id))return json({error:'会话不存在'},404);const meta={...(d.sessions[b.id]||{})};if('folder_id'in b){const id=clean(b.folder_id,80);if(id&&!d.folders.some(f=>f.id===id))throw Error('文件夹不存在');meta.folder_id=id;}if('expert'in b)meta.expert=expert(b.expert);if('expert_id'in b)meta.expert=b.expert_id?expert(getExpert(b.expert_id)):null;if('personality'in b){if(!PERSONALITIES.some(p=>p.id===b.personality))throw stateError('请选择有效的表达风格');meta.personality=b.personality;}if(('expert_id'in b)||('expert'in b))delete meta.plan;if(b.clear_plan===true)delete meta.plan;d.sessions[b.id]=meta;save(d);return json({ok:true,meta});
 }
 if(p==='/api/workspace-ui/preferences'&&method==='PUT'){
 const b=await req.json(),d=readWorkspace();if(b.identity)for(const k of ['user_name','assistant_name','user_avatar','assistant_avatar'])if(k in b.identity)d.identity[k]=(k.endsWith('avatar')?avatar(b.identity[k]):clean(b.identity[k],60))||defaults().identity[k];if(b.identity&&'avatar_shape'in b.identity){if(!['rounded','circle'].includes(b.identity.avatar_shape))throw stateError('请选择圆角方形或圆形头像');d.identity.avatar_shape=b.identity.avatar_shape;}
  if(b.display){if(!['collapsed','expanded','hidden'].includes(b.display.tools_mode))throw stateError('请选择有效的工具记录显示方式');d.display={...(d.display||{}),tools_mode:b.display.tools_mode};}
  if(b.voice)throw stateError('请刷新面板后通过声音设置保存',409);if(Array.isArray(b.favorites))d.favorites=b.favorites.filter(x=>typeof x==='string').slice(0,400);save(d);return json({ok:true,state:d});
 }
 if(p==='/api/workspace-ui/search'&&method==='GET'){
  const q=clean(u.searchParams.get('q'),160),offset=Math.max(0,Number(u.searchParams.get('offset'))||0);if(!q)return json({results:[],total:0});const {stdout}=await run(PYTHON,[join(SERVER_ROOT,'server/panel-search.py'),DATA,VAR,q,String(offset)],{timeout:15000,maxBuffer:4*1024*1024});return json(JSON.parse(stdout));
 }
 if(p==='/api/workspace-ui/channel-context'&&method==='GET'){
  const id=u.searchParams.get('id')||'',mid=Number(u.searchParams.get('message'))||0;
  const script=`import sqlite3,json,sys\nc=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True);c.row_factory=sqlite3.Row\nrows=c.execute("SELECT id,role,content,timestamp FROM messages WHERE session_id=? AND active=1 AND role IN ('user','assistant') AND id>=COALESCE((SELECT id FROM messages WHERE session_id=? AND id<=? AND active=1 AND role IN ('user','assistant') ORDER BY id DESC LIMIT 1 OFFSET 12),0) ORDER BY id LIMIT 40",(sys.argv[2],sys.argv[2],int(sys.argv[3]))).fetchall()\nprint(json.dumps([dict(r) for r in rows],ensure_ascii=False))`;
  const {stdout}=await run(PYTHON,['-c',script,join(DATA,'state.db'),id,String(mid)],{timeout:10000,maxBuffer:5*1024*1024});return json({messages:JSON.parse(stdout)});
 }
 if(p==='/api/workspace-ui/voice'){if(!checkToken(req))return json({error:'请重新登录后管理声音'},401);if(method==='GET')return json(await voiceSettings.inspect());if(method==='PUT')return json(await voiceSettings.update(await req.json()));}
 if(p==='/api/workspace-ui/speech-cancel'&&method==='POST')return json(speech.cancel((await req.json()).request_id));
 if(['/api/workspace-ui/speak','/api/workspace-ui/system-speak'].includes(p)&&method==='POST')return await speech.synthesize(await req.json(),p.endsWith('/system-speak')?'system':'windows',req.signal);
 return json({error:'not found'},404);
 }catch(e){const upstream=String(e.stderr||'').match(/TTS 服务 HTTP (\d+)/);const message=upstream?'Windows 合成服务返回 HTTP '+upstream[1]:e.message||String(e);return json({error:message,code:e.code},e.status||400);}
}
