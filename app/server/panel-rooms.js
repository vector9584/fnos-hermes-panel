import * as fs from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {StateFile,SessionDrafts,clone,digest,safeId,stateError} from './panel-state.js';

const live=status=>status==='pending'||status==='running';
const text=(value,max,label)=>{if(typeof value!=='string'||value.length>max)throw stateError(label+'格式不正确或内容过长');return value.trim();};
export class RoomStore{
 constructor({root,legacyFile,expert,identity=()=>({user_name:'你',user_avatar:'👤',assistant_name:'Hermes',assistant_avatar:'🤖'})}){Object.assign(this,{root,legacyFile,expert,identity});this.drafts=new SessionDrafts(join(root,'room-drafts'));}
 legacy(){
  if(!fs.existsSync(this.legacyFile))return [];
  let rooms;try{rooms=JSON.parse(fs.readFileSync(this.legacyFile,'utf8'));}catch(_){throw stateError('原讨论文件无法解析，原文件已保留',503);}
  if(!Array.isArray(rooms)||rooms.some(r=>!r||typeof r.id!=='string'||!Array.isArray(r.messages||[])))throw stateError('原讨论文件结构不完整，原文件已保留',503);
  return rooms;
 }
 file(id){return new StateFile(join(this.root,'rooms',safeId(id)+'.json'),()=>null,{validate:r=>!!r&&r.version===2&&r.id===id&&Array.isArray(r.messages)&&Array.isArray(r.members)&&Array.isArray(r.requests)&&Number.isInteger(r.revision)});}
 normalize(original){
  const room=clone(original);room.version=2;room.revision=room.revision||0;room.requests=room.requests||[];room.members=room.members||[];room.shared_memory=room.shared_memory||[];
  room.messages=(room.messages||[]).map((message,index)=>({...message,id:message.id||'legacy-'+index+'-'+digest(message).slice(0,16)}));
  room.shared_memory=room.shared_memory.map((note,index)=>({...note,id:note.id||'note-'+index+'-'+digest(note).slice(0,16)}));
  // Runtime locks never survive a restart; old completed text is retained verbatim.
  delete room._chainBusy;return room;
 }
 ids(){const base=this.legacy().map(r=>safeId(r.id));const dir=join(this.root,'rooms');return [...new Set(base.concat(fs.existsSync(dir)?fs.readdirSync(dir).filter(n=>n.endsWith('.json')).map(n=>safeId(n.slice(0,-5))):[]))];}
 get(id){safeId(id);const overlay=this.file(id).read();if(overlay)return overlay;const original=this.legacy().find(r=>r.id===id);if(!original)throw stateError('讨论不存在',404);return this.normalize(original);}
 save(room){const next={...room,revision:room.revision+1,updated_at:Date.now()};this.file(room.id).write(next);return next;}
 update(id,callback,revision){const room=this.get(id);if(revision!==undefined&&revision!==room.revision)throw stateError('讨论已在其他页面更新，请读取最新版本',409);callback(room);return this.save(room);}
 list({archived=false}={}){return this.ids().map(id=>this.get(id)).filter(r=>!!r.archived_at===archived).sort((a,b)=>(b.updated_at||b.created_at||0)-(a.updated_at||a.created_at||0)).map(r=>({id:r.id,title:r.title,members:r.members.map(({key,label})=>({key,label})),message_count:r.messages.length,archived_at:r.archived_at,updated_at:r.updated_at}));}
 summary(room){const {messages,requests,members,...view}=room;return {...view,members:members.map(({system,quick_prompts,...member})=>member),message_count:messages.length,requests:requests.filter(r=>live(r.status)||(['failed','interrupted'].includes(r.status)&&!r.resolved_at)).map(({members,text,notes,results,...request})=>({...request,member_count:members.length}))};}
 page(id,{before=null,around=null,limit=60}={}){const room=this.get(id);if(!Number.isInteger(limit)||limit<1||limit>200)throw stateError('消息分页大小不正确');let end=room.messages.length;if(before){end=room.messages.findIndex(m=>m.id===before);if(end<0)throw stateError('消息定位不存在，请重新读取',404);}if(around){const at=room.messages.findIndex(m=>m.id===around);if(at<0)throw stateError('消息定位不存在，请重新读取',404);end=Math.min(room.messages.length,at+Math.ceil(limit/2));}const start=Math.max(0,end-limit);return {room:this.summary(room),messages:room.messages.slice(start,end),before:start>0?room.messages[start].id:null,total:room.messages.length};}
 snapshotMember(id){const e=this.expert(safeId(id));return {key:'exp_'+e.id,label:e.name,emoji:e.emoji,persona_id:e.id,system:e.prompt,expert_revision:e.revision,quick_prompts:e.quick_prompts||[],model:'',provider:''};}
 create(body){
  const id=safeId(body.request_id),title=text(body.title,100,'讨论名称');if(!title)throw stateError('请输入讨论名称');
  if(this.ids().includes(id)){const old=this.get(id);if(old.creation_hash!==digest(body))throw stateError('此创建编号已用于其他讨论',409);return old;}
  if(!Array.isArray(body.expert_ids)||!body.expert_ids.length||body.expert_ids.length>12||new Set(body.expert_ids).size!==body.expert_ids.length)throw stateError('请选择1到12位不同专家');
  const room={id,version:2,revision:0,title,created_at:Date.now(),updated_at:Date.now(),members:body.expert_ids.map(id=>this.snapshotMember(id)),messages:[],requests:[],shared_memory:[],creation_hash:digest(body),model:text(body.model||'',500,'模型'),provider:text(body.provider||'',200,'模型服务')};return this.save(room);
 }
 addMembers(id,body){return this.update(id,room=>{if(room.archived_at)throw stateError('请先恢复此讨论');if(!Array.isArray(body.expert_ids)||!body.expert_ids.length)throw stateError('请选择专家');for(const expertId of body.expert_ids){if(!room.members.some(m=>m.persona_id===expertId))room.members.push(this.snapshotMember(expertId));}if(room.members.length>12)throw stateError('讨论最多12位专家');},body.revision);}
 archive(id,archived){return this.update(id,room=>{if(room.requests.some(r=>live(r.status)))throw stateError('请先停止或等待正在执行的讨论',409);if(archived)room.archived_at=Date.now();else delete room.archived_at;});}
 settings(id,body){return this.update(id,room=>{if(room.archived_at)throw stateError('请先恢复此讨论');const title=text(body.title,100,'讨论名称');if(!title)throw stateError('请输入讨论名称');room.title=title;room.model=text(body.model||'',500,'模型');room.provider=text(body.provider||'',200,'模型服务');},body.revision);}
 addNote(id,body){return this.update(id,room=>{const value=text(body.text,20000,'讨论笔记'),noteId=safeId(body.request_id||randomUUID());if(!value)throw stateError('请输入讨论笔记');const existing=room.shared_memory.find(n=>n.id===noteId);if(existing){if(existing.text!==value)throw stateError('此笔记编号已用于其他内容',409);return;}room.shared_memory.push({id:noteId,text:value,from:this.identity().user_name,ts:Date.now()});});}
 noteState(id,body){return this.update(id,room=>{const note=room.shared_memory.find(n=>n.id===body.note_id);if(!note)throw stateError('笔记不存在',404);if(typeof body.archived!=='boolean')throw stateError('笔记状态不正确');if(body.archived)note.archived_at=Date.now();else delete note.archived_at;});}
 enqueue(id,body){
  const requestId=safeId(body.request_id),message=text(body.text,200000,'讨论消息');if(!message)throw stateError('请输入讨论内容');
  return this.update(id,room=>{
   if(room.archived_at)throw stateError('请先恢复此讨论');
   const hash=digest(body),old=room.requests.find(r=>r.id===requestId);
   if(old){if(old.input_hash!==hash)throw stateError('此发送编号对应另一条消息',409);return;}
   if(room.requests.filter(r=>live(r.status)).length>=30)throw stateError('待处理讨论较多，请稍后发送',429);
   const keys=Array.isArray(body.members)?body.members:room.members.map(m=>m.key);if(!keys.length||keys.length>12||new Set(keys).size!==keys.length)throw stateError('请选择讨论成员');
   const members=keys.map(key=>{const member=room.members.find(m=>m.key===key);if(!member)throw stateError('讨论成员已改变，请重新选择');const snapshot=clone(member);if(!snapshot.system&&snapshot.persona_id){const expert=this.expert(snapshot.persona_id);snapshot.system=expert.prompt;snapshot.expert_revision=expert.revision;}return snapshot;});
   const rounds=body.rounds??1;if(!Number.isInteger(rounds)||rounds<1||rounds>3||rounds*members.length>24)throw stateError('讨论需为1到3轮，最多24次回复');
   const identity=this.identity(),now=Date.now();room.messages.push({id:'user-'+requestId,kind:'user',from:'me',label:identity.user_name,avatar:identity.user_avatar,text:message,ts:now,request_id:requestId});
   room.requests.push({id:requestId,input_hash:hash,text:message,members,notes:clone(room.shared_memory.filter(n=>!n.archived_at)),model:room.model||'',provider:room.provider||'',rounds,next_step:0,status:'pending',created_at:now,results:[],error:''});
  });
 }
 request(id,requestId){const room=this.get(id),request=room.requests.find(r=>r.id===requestId);if(!request)throw stateError('讨论执行记录不存在',404);return request;}
 updateRequest(id,requestId,callback){return this.update(id,room=>{const request=room.requests.find(r=>r.id===requestId);if(!request)throw stateError('讨论执行记录不存在',404);callback(request,room);});}
 recover(reconcile=()=>null){
  for(const id of this.ids()){const room=this.get(id);if(!room.requests.some(r=>r.status==='running'))continue;this.update(id,room=>{room.requests.forEach(request=>{if(request.status==='running'){
   // ChatQueue may have committed completion just before Monitor died. Reconcile
   // that acknowledgement before allowing any manual retry of external effects.
   const saved=request.active_execution?reconcile(request.active_execution):null;
   const message=room.messages.find(m=>m.execution_id===request.active_execution);
   if(saved&&message){Object.assign(message,{text:saved.result.reply,reasoning:saved.result.reasoning,tools:clone(saved.result.tools||[]),error:saved.result.error||'',status:saved.status==='pending'||saved.status==='running'?'interrupted':saved.status});if(saved.status==='done')request.next_step=Math.max(request.next_step,request.active_step+1);}
   request.status=request.next_step>=request.rounds*request.members.length?'done':'interrupted';request.error=request.status==='done'?'':'服务重启中断了讨论，已保存的回复保留。请检查后继续或取消。';request.finished_at=Date.now();
  }});room.messages.forEach(message=>{if(message.status==='running')message.status='interrupted';});});}
 }
}

export class RoomRunner{
 constructor({store,execute,reconcile=()=>null,onFault=()=>{}}){Object.assign(this,{store,execute,reconcile,onFault});this.workers=new Map();this.enabled=false;this.fault=null;}
 start(){this.store.recover(this.reconcile);this.enabled=true;this.wake();return this;}
 wake(){
  if(!this.enabled||this.fault)return;
  try{for(const id of this.store.ids()){
   if(this.workers.has(id))continue;const room=this.store.get(id);if(room.archived_at||room.requests.some(r=>['failed','interrupted'].includes(r.status)&&!r.resolved_at))continue;
   const request=room.requests.find(r=>r.status==='pending');if(!request)continue;
   const worker={controller:new AbortController(),stopping:false,promise:null};this.workers.set(id,worker);
   worker.promise=this.run(id,request.id,worker).finally(()=>{this.workers.delete(id);if(this.enabled)queueMicrotask(()=>this.wake());});
  }}catch(error){this.fail(error);}
 }
 fail(error){this.fault=error;this.enabled=false;this.workers.forEach(w=>w.controller.abort());this.onFault(error);}
 async run(id,requestId,worker){
  let flushTimer=null,checkpoint=null,stepMessageId=null,progressError=null;
  const flush=()=>{
   clearTimeout(flushTimer);flushTimer=null;if(!checkpoint)return;
   const value=checkpoint;checkpoint=null;
   try{this.store.updateRequest(id,requestId,(request,room)=>{const message=room.messages.find(m=>m.id===stepMessageId);if(message)Object.assign(message,value);});}
   catch(error){progressError=error;this.fail(error);throw error;}
  };
  try{
   this.store.updateRequest(id,requestId,request=>{request.status='running';request.started_at=request.started_at||Date.now();delete request.error;});
   while(!worker.controller.signal.aborted){
    const request=this.store.request(id,requestId);if(request.next_step>=request.rounds*request.members.length)break;
    const step=request.next_step,member=request.members[step%request.members.length],attempt=request.attempts?.[step]||0;
    stepMessageId='reply-'+requestId+'-'+step+'-'+attempt;
    const executionId='room-'+digest([id,requestId,step,attempt]).slice(0,48);
    this.store.updateRequest(id,requestId,(request,room)=>{
     request.active_step=step;request.active_execution=executionId;
     if(!room.messages.some(m=>m.id===stepMessageId))room.messages.push({id:stepMessageId,request_id:requestId,execution_id:executionId,kind:'assistant',from:member.key,label:member.label,avatar:member.emoji,expert_revision:member.expert_revision||'',system_snapshot:member.system||'',text:'',reasoning:'',tools:[],status:'running',ts:Date.now()});
    });
    const room=this.store.get(id),context=room.messages.filter(m=>m.id!==stepMessageId&&m.kind==='assistant'&&m.status!=='running').slice(-12).map(m=>m.label+'：'+m.text).join('\n\n').slice(-24000);
    const progress={text:'',reasoning:'',tools:[]};
    const emit=packet=>{
     if(progressError)throw progressError;
     if(packet.snapshot){progress.text=packet.snapshot.reply||'';progress.reasoning=packet.snapshot.reasoning||'';progress.tools=clone(packet.snapshot.tools||[]);}
     if(packet.delta)progress.text+=packet.delta;if(packet.reasoning)progress.reasoning+=packet.reasoning;
     if(packet.tool_progress){const t=packet.tool_progress,index=progress.tools.findIndex(item=>(item.toolCallId||item.tool)===(t.toolCallId||t.tool));if(index<0)progress.tools.push(clone(t));else progress.tools[index]={...progress.tools[index],...clone(t)};}
     checkpoint=clone(progress);if(packet.tool_progress)flush();else if(!flushTimer)flushTimer=setTimeout(()=>{try{flush();}catch(_){}},150);
    };
    const result=await this.execute({id:executionId,room_id:id,request_id:requestId,step,attempt,member:clone(member),model:member.model||request.model,provider:member.provider||request.provider,
      message:request.text+((request.notes||[]).length?'\n\n【发送时的讨论笔记，仅作参考】\n'+request.notes.map(n=>n.text).join('\n\n').slice(-24000):'')+(context?'\n\n【其他成员已保存的讨论内容，仅作参考】\n'+context:''),system:member.system||''},{signal:worker.controller.signal,emit});
    flush();if(progressError)throw progressError;
    const successful=result.status==='done'&&!worker.controller.signal.aborted;
    this.store.updateRequest(id,requestId,(request,room)=>{
     const message=room.messages.find(m=>m.id===stepMessageId);Object.assign(message,{text:result.reply??progress.text,reasoning:result.reasoning??progress.reasoning,tools:result.tools??progress.tools,status:successful?'done':worker.stopping?'interrupted':worker.controller.signal.aborted?'cancelled':result.status||'failed',error:result.error||'',finished_at:Date.now()});
     request.results.push({step,attempt,message_id:stepMessageId,execution_id:executionId,status:message.status});delete request.active_execution;
     if(successful)request.next_step++;
    });
    if(!successful){if(worker.controller.signal.aborted)break;throw stateError(result.error||'成员回复未完成，请检查后继续',502);}
   }
   this.store.updateRequest(id,requestId,request=>{request.status=worker.stopping?'interrupted':worker.controller.signal.aborted?'cancelled':'done';request.finished_at=Date.now();request.error=worker.stopping?'服务关闭中断了讨论，已保存回复保留。':'';delete request.active_execution;});
  }catch(error){
   try{flush();}catch(_){}if(this.fault)return;
   try{this.store.updateRequest(id,requestId,(request,room)=>{
    request.status=worker.stopping?'interrupted':worker.controller.signal.aborted?'cancelled':'failed';request.finished_at=Date.now();request.error=worker.stopping?'服务关闭中断了讨论，已保存回复保留。':worker.controller.signal.aborted?'':error.message;
    const message=room.messages.find(m=>m.id===stepMessageId);if(message?.status==='running'){message.status=request.status;message.error=request.error;}
   });}catch(storageError){this.fail(storageError);}
  }finally{clearTimeout(flushTimer);}
 }
 enqueue(id,body){if(this.fault)throw stateError('讨论存储异常，消息未接收',503);const room=this.store.enqueue(id,body);this.wake();return room;}
 cancel(id,requestId){
  this.store.updateRequest(id,requestId,request=>{if(!live(request.status)&&!['failed','interrupted'].includes(request.status))return;request.cancel_requested_at=Date.now();if(request.status!=='running'){request.status='cancelled';request.resolved_at=Date.now();request.finished_at=Date.now();}});
  const worker=this.workers.get(id);if(worker&&this.store.request(id,requestId).status==='running')worker.controller.abort();this.wake();return this.store.request(id,requestId);
 }
 resume(id,requestId){
  if(this.fault)throw stateError('请先恢复讨论存储后继续',503);
  this.store.updateRequest(id,requestId,request=>{if(!['failed','interrupted'].includes(request.status))throw stateError('此讨论无需继续',409);request.attempts=request.attempts||{};request.attempts[request.next_step]=(request.attempts[request.next_step]||0)+1;request.status='pending';request.error='';delete request.finished_at;delete request.cancel_requested_at;});this.wake();return this.store.request(id,requestId);
 }
 async stop(){this.enabled=false;for(const worker of this.workers.values()){worker.stopping=true;worker.controller.abort();}await Promise.all([...this.workers.values()].map(w=>w.promise));}
}

export function createRoomHandler({store,runner,checkToken,modelCatalog=async()=>({providers:[]})}){
 const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
 const validateModel=async body=>{if(!body.model&&!body.provider)return;const {providers}=await modelCatalog();if(!providers.some(p=>p.id===body.provider&&p.models.includes(body.model)))throw stateError('所选服务或模型已不在配置中，请重新选择');};
 return async(req,path)=>{
  if(!path.startsWith('/api/panel-rooms'))return null;if(!checkToken(req))return reply({ok:false,error:'请重新登录后使用专家讨论'},401);
  try{
   const url=new URL(req.url);
   if(path==='/api/panel-rooms'){
    if(req.method==='GET')return reply({ok:true,rooms:store.list({archived:url.searchParams.get('archived')==='1'}),storage_ok:!runner.fault});
    if(req.method==='POST'){const body=await req.json();await validateModel(body);return reply({ok:true,room:store.summary(store.create(body))});}
   }
   const match=path.match(/^\/api\/panel-rooms\/([a-zA-Z0-9_-]+)(?:\/(members|settings|archive|restore|notes|note-state|draft|send|export|requests)(?:\/([a-zA-Z0-9_-]+)\/(cancel|resume))?)?$/);
   if(!match)throw stateError('讨论操作不存在',404);const [,id,action,requestId,requestAction]=match;
   if(!action&&req.method==='GET')return reply({ok:true,...store.page(id,{before:url.searchParams.get('before'),around:url.searchParams.get('around'),limit:Number(url.searchParams.get('limit')||60)})});
   if(action==='draft'){store.get(id);if(req.method==='GET')return reply({ok:true,draft:store.drafts.get(id)});if(req.method==='PUT'){const result=store.drafts.put(id,await req.json());return reply(result,result.conflict?409:200);}}
   if(action==='export'&&req.method==='GET')return new Response(JSON.stringify(store.get(id),null,2),{headers:{'Content-Type':'application/json','Content-Disposition':'attachment; filename="discussion-'+id+'.json"','Cache-Control':'no-store'}});
   if(req.method!=='POST')throw stateError('不支持此讨论操作',405);
   if(action==='members')return reply({ok:true,room:store.summary(store.addMembers(id,await req.json()))});
   if(action==='settings'){const body=await req.json();await validateModel(body);return reply({ok:true,room:store.summary(store.settings(id,body))});}
   if(action==='archive'||action==='restore')return reply({ok:true,room:store.summary(store.archive(id,action==='archive'))});
   if(action==='notes')return reply({ok:true,room:store.summary(store.addNote(id,await req.json()))});
   if(action==='note-state')return reply({ok:true,room:store.summary(store.noteState(id,await req.json()))});
   if(action==='send')return reply({ok:true,room:store.summary(runner.enqueue(id,await req.json()))},202);
   if(action==='requests'&&requestAction==='cancel')return reply({ok:true,request:runner.cancel(id,requestId)});
   if(action==='requests'&&requestAction==='resume')return reply({ok:true,request:runner.resume(id,requestId)});
   throw stateError('讨论操作不存在',404);
  }catch(error){return reply({ok:false,error:error.message||'讨论操作失败'},error.status||500);}
 };
}
