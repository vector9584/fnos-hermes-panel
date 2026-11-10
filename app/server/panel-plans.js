import * as fs from 'node:fs';
import {join} from 'node:path';
import {StateFile,SessionDrafts,clone,digest,safeId,stateError} from './panel-state.js';
const presets=JSON.parse(fs.readFileSync(new URL('./task-templates.json',import.meta.url),'utf8'));
const string=(value,max,label)=>{if(typeof value!=='string'||value.length>max)throw stateError(label+'格式不正确或过长');return value.trim();};
const presetId=key=>'template-'+digest(key).slice(0,24);
export class PlanStore{
 constructor({root,legacyConfig,legacyFlows,expert}){Object.assign(this,{root,legacyConfig,legacyFlows,expert});this.state=new StateFile(join(root,'plans.json'),()=>({version:1,overrides:{},history:[]}),{validate:d=>d&&d.version===1&&d.overrides&&Array.isArray(d.history)});this.drafts=new SessionDrafts(join(root,'plan-drafts'));}
 config(){if(!fs.existsSync(this.legacyConfig))return {};try{const d=JSON.parse(fs.readFileSync(this.legacyConfig,'utf8'));if(!d||typeof d!=='object'||Array.isArray(d))throw Error();return d.extensions||{};}catch(_){throw stateError('原专家分工配置无法读取，原文件已保留',503);}}
 bases(){
  const ext=this.config(),overrides=ext.workflow_templates_override||{},items=presets.map(p=>({...clone(p),...clone(overrides[p.key]||{}),id:presetId(p.key),kind:'task',source:'内置模板'}));
  items.unshift({id:'saved-team',kind:'team',name:ext.team_name||'我的专家分工',description:'按成员专长分析和分配任务，由当前助手汇总。',members:clone(ext.team||[]),source:'原专家团'});
  if(ext.workflow?.steps?.length)items.unshift({...clone(ext.workflow),id:'saved-workflow',kind:'task',source:'原自定义工作流'});
  if(fs.existsSync(this.legacyFlows))for(const file of fs.readdirSync(this.legacyFlows).filter(n=>n.endsWith('.json'))){
   let flow;try{flow=JSON.parse(fs.readFileSync(join(this.legacyFlows,file),'utf8'));if(!flow||!Array.isArray(flow.steps))throw Error();}catch(_){throw stateError('旧任务模板无法解析，原文件已保留：'+file,503);}
   items.push({...clone(flow),id:'legacy-'+digest(file).slice(0,24),legacy_id:flow.id,kind:'task',source:'原后台工作流',legacy_record:clone(flow),steps:flow.steps.map(s=>({...s,id:s.name,task:s.prompt,expert:s.system?'自定义职责':'按任务选用',system:s.system||'',output:s.name}))});
  }
  return items;
 }
 view(id,base,state){const override=state.overrides[id];if(!base&&!override)throw stateError('任务方案不存在',404);const item={...base,...override,id};return {...item,revision:digest(item),can_undo:state.history.some(h=>h.id===id)};}
 get(id){safeId(id);return this.view(id,this.bases().find(p=>p.id===id),this.state.read());}
 catalog({query='',kind='',offset=0,limit=24}={}){const state=this.state.read(),bases=new Map(this.bases().map(p=>[p.id,p])),ids=[...new Set([...bases.keys(),...Object.keys(state.overrides)])],q=String(query).toLowerCase();const all=ids.map(id=>this.view(id,bases.get(id),state)).filter(p=>(!kind||p.kind===kind)&&(!q||[p.name,p.description,p.category].join(' ').toLowerCase().includes(q)));return {total:all.length,catalog_total:ids.length,plans:all.slice(offset,offset+Math.min(60,limit)).map(({steps,members,legacy_record,...p})=>({...p,step_count:steps?.length||0,member_count:members?.length||0}))};}
 validate(body,previous={}){
  const kind=body.kind||previous.kind;if(!['team','task'].includes(kind))throw stateError('请选择专家分工或任务模板');const name=string(body.name??previous.name??'',100,'方案名称');if(!name)throw stateError('请输入方案名称');
  const result={kind,name,description:string(body.description??previous.description??'',4000,'方案简介'),category:string(body.category??previous.category??'',100,'分类')};
  if(kind==='team'){
   const members=body.members??previous.members??[];if(!Array.isArray(members)||members.length>12)throw stateError('分工最多12位专家');
   result.members=members.map(member=>{if(typeof member.id!=='string')throw stateError('请选择专家');const old=previous.members?.find(m=>m.id===member.id);if(old)return clone(old);const e=this.expert(member.id);return {id:e.id,name:e.name,icon:e.emoji,expert_revision:e.revision,prompt:e.prompt};});
   if(new Set(result.members.map(m=>m.id)).size!==result.members.length)throw stateError('请勿重复选择专家');
  }else{
   const inputs=body.inputs??previous.inputs??[],steps=body.steps??previous.steps??[];
   if(!Array.isArray(inputs)||inputs.length>30||!Array.isArray(steps)||!steps.length||steps.length>60)throw stateError('任务模板需要1到60个步骤，最多30项输入');
   result.inputs=inputs.map(i=>({name:string(i.name,100,'输入名称'),description:string(i.description||'',1000,'输入说明'),required:!!i.required}));
   if(result.inputs.some(i=>!i.name)||new Set(result.inputs.map(i=>i.name)).size!==result.inputs.length)throw stateError('输入名称不能为空或重复');
   result.steps=steps.map(step=>({...clone(previous.steps?.find(s=>s.id===step.id)||{}),id:string(step.id,100,'步骤标识'),expert:string(step.expert||'按任务选用',200,'步骤职责'),task:string(step.task||'',100000,'步骤任务'),output:string(step.output||'',100,'输出名称'),depends_on:Array.isArray(step.depends_on)?step.depends_on.map(id=>string(id,100,'依赖步骤')):[],...(step.system?{system:string(step.system,100000,'专家设定')}:{})}));
   const byId=new Map(result.steps.map(s=>[s.id,s]));if(byId.size!==result.steps.length||result.steps.some(s=>!s.id||!s.task))throw stateError('步骤标识不可重复或为空，任务内容不能为空');
   const visiting=new Set(),done=new Set();function visit(id){if(done.has(id))return;if(visiting.has(id))throw stateError('步骤依赖形成循环');const step=byId.get(id);if(!step)throw stateError('依赖步骤不存在：'+id);visiting.add(id);step.depends_on.forEach(visit);visiting.delete(id);done.add(id);}result.steps.forEach(s=>visit(s.id));
  }
  if(JSON.stringify(result).length>600000)throw stateError('方案内容过大');return result;
 }
 save(id,body){safeId(id);let previous;try{previous=this.get(id);}catch(error){if(error.status!==404)throw error;}
  if(previous&&body.revision!==previous.revision)throw stateError('方案已在其他页面修改，请保留草稿并重新读取',409);if(!previous&&body.revision)throw stateError('原方案不存在，请另存为新方案',409);
  const value=this.validate(body,previous||{});this.state.update(d=>{if(previous)d.history.push({id,at:Date.now(),value:previous});d.overrides[id]={...previous,...value,id,source:previous?.source||'自建方案',updated_at:Date.now()};delete d.overrides[id].revision;delete d.overrides[id].can_undo;});return this.get(id);
 }
 undo(id,revision){const current=this.get(id);if(current.revision!==revision)throw stateError('方案已更新，请重新读取',409);const old=this.state.read().history.filter(h=>h.id===id).at(-1);if(!old)throw stateError('没有可撤销的修改',404);return this.save(id,{...old.value,revision});}
 snapshot(id){const plan=this.get(id),members=(plan.members||[]).map(member=>{if(member.prompt)return clone(member);let e;try{e=this.expert(member.id);}catch(error){if(error.status!==404)throw error;if(!member.system)throw stateError('原分工成员 '+(member.name||member.id)+' 缺少职责，请在方案中重新选择');}return {...clone(member),prompt:member.system||e.prompt,expert_revision:member.expert_revision||e?.revision||digest(member.system),icon:member.icon||e?.emoji||'🧠'};});if(plan.kind==='team'&&!members.length)throw stateError('请先添加参与分工的专家');const steps=(plan.steps||[]).map(step=>{if(step.system)return clone(step);try{const e=this.expert(step.expert);return {...clone(step),expert:e.name,system:e.prompt,expert_id:e.id,expert_revision:e.revision};}catch(error){if(error.status!==404&&error.status!==400)throw error;return clone(step);}});return {...clone(plan),members,steps,captured_at:Date.now()};}
 prepare(id,body){const plan=this.snapshot(id);if(body.revision!==plan.revision)throw stateError('方案已更新，请读取最新内容后开始',409);const request=string(body.request||'',200000,'任务描述');if(!request)throw stateError('请输入任务目标');
  if(plan.kind==='team')return {plan,message:request};
  const inputs=body.inputs||{},vars={};for(const input of plan.inputs||[]){const value=string(inputs[input.name]||'',30000,'输入 '+input.name);if(input.required&&!value)throw stateError('请填写：'+(input.description||input.name));vars[input.name]=value||'未提供，由助手根据任务判断是否需要补充';}
  vars.request=request;vars.context=String(body.context||'').slice(0,30000);
  const resolve=value=>String(value).replace(/\{\{([^{}]+)\}\}/g,(match,key)=>Object.prototype.hasOwnProperty.call(vars,key)?vars[key]:match);
  const details=plan.steps.map((step,index)=>'步骤 '+(index+1)+' ['+step.id+']\n职责：'+step.expert+'\n依赖：'+(step.depends_on.join('、')||'无')+'\n输出：'+(step.output||'本步骤结果')+'\n'+resolve(step.task)+(step.system?'\n职责说明：'+step.system:''));
  return {plan,message:request+'\n\n【本次任务方案：'+plan.name+'】\n'+details.join('\n\n')+'\n\n按依赖关系组织任务。{{输出变量}}表示前序步骤的实际结果，请先取得结果再引用；尚未取得时说明缺失，不编造。只有实际使用工具或得到证据后才报告步骤已执行。'};
 }
}
export function planSystem(plan){
 if(!plan)return '';
 if(plan.kind==='task')return '【任务方案协调】'+plan.name+'\n根据本轮任务说明组织执行、核对依赖并汇总结果。仅使用当前工具定义支持的能力，不把方案文本视为已完成的执行。';
 return '【会话专家分工】'+plan.name+'\n你负责按职责组织任务、判断是否需要委派并汇总结果。仅依据实际可用工具执行；没有调用委派工具时不得声称其他专家已经独立工作。\n\n'+plan.members.map(m=>'◆ '+m.name+'\n'+m.prompt).join('\n\n')+'\n\n以上职责不改变SOUL、项目规范、技能和工具权限。';
}
export function createPlanHandler({store,checkToken,launch}){
 const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
 return async(req,path)=>{
  if(!path.startsWith('/api/panel-plans'))return null;if(!checkToken(req))return reply({error:'请重新登录后使用任务方案'},401);
  try{const url=new URL(req.url);if(path==='/api/panel-plans'&&req.method==='GET')return reply({ok:true,...store.catalog({query:url.searchParams.get('q')||'',kind:url.searchParams.get('kind')||'',offset:Math.max(0,Number(url.searchParams.get('offset'))||0),limit:24})});
   const match=path.match(/^\/api\/panel-plans\/([a-zA-Z0-9_-]+)(?:\/(undo|draft|launch))?$/);if(!match)throw stateError('方案操作不存在',404);const [,id,action]=match;
   if(!action&&req.method==='GET')return reply({ok:true,plan:store.get(id)});
   if(!action&&req.method==='PUT')return reply({ok:true,plan:store.save(id,await req.json())});
   if(action==='undo'&&req.method==='POST')return reply({ok:true,plan:store.undo(id,(await req.json()).revision)});
   if(action==='draft'){if(req.method==='GET')return reply({ok:true,draft:store.drafts.get(id)});if(req.method==='PUT'){const result=store.drafts.put(id,await req.json());return reply(result,result.conflict?409:200);}}
   if(action==='launch'&&req.method==='POST'){
    const body=await req.json(),requestId=safeId(body.request_id),file=new StateFile(join(store.root,'plan-launches',requestId+'.json'),()=>null,{validate:r=>r&&r.version===1&&r.id===requestId});let record=file.read();
    const hash=digest([id,body]);if(record&&record.input_hash!==hash)throw stateError('同一任务编号对应不同输入',409);
    if(!record){const prepared=store.prepare(id,body);record={version:1,id:requestId,input_hash:hash,session_id:'plan_'+digest(requestId).slice(0,40),prepared,created_at:Date.now()};file.write(record);}
    const result=await launch(record);return reply({ok:true,session_id:record.session_id,...result},202);
   }
   throw stateError('不支持此方案操作',405);
  }catch(error){return reply({ok:false,error:error.message},error.status||500);}
 };
}
export function createPlanLaunch({queue,ensureSession,attachPlan,capture,guard=()=>null}){
 return async record=>{
  try{const old=queue.get(record.id);return {request_id:old.id,status:old.status};}catch(error){if(error.status!==404)throw error;}
  const blocked=await guard(record.prepared.message);if(blocked)throw stateError('任务未通过当前执行检查，请检查任务内容',400);
  ensureSession(record.session_id,record.prepared.plan.name);
  attachPlan(record.session_id,record.prepared.plan);
  const payload={session_id:record.session_id,request_id:record.id,message:record.prepared.message,system:''};
  const result=queue.enqueue(payload,capture(record.session_id));return {request_id:result.job.id,status:result.job.status};
 };
}
