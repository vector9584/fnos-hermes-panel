import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PlanStore,planSystem,createPlanHandler} from '../../../app/server/panel-plans.js';
function fixture(t){const root=fs.mkdtempSync(join(tmpdir(),'plans-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const config=join(root,'config.json'),flows=join(root,'flows');fs.mkdirSync(flows);fs.writeFileSync(config,JSON.stringify({extensions:{team_name:'原来的四人',team:['a','b','c','d'].map(id=>({id,name:'专家'+id})),workflow_templates_override:{'academic-paper-outline':{name:'自己的论文方案'}}}}));fs.writeFileSync(join(flows,'old.json'),JSON.stringify({id:'old',name:'旧任务',status:'failed',steps:[{name:'开始',prompt:'请分析',system:'自己的职责'}],results:{开始:{status:'failed',output:'保留输出'}}}));const before=[fs.readFileSync(config),fs.readFileSync(join(flows,'old.json'))];const store=new PlanStore({root:join(root,'state'),legacyConfig:config,legacyFlows:flows,expert:id=>({id,name:'专家'+id,prompt:'职责'+id,emoji:'🤖',revision:'1'})});return {root,store,before,config,flows};}
test('all 81 bundled templates, original four members, overrides and legacy flow results remain readable',t=>{
 const {store}=fixture(t),catalog=store.catalog({limit:60});assert.equal(catalog.catalog_total,83);assert.equal(catalog.plans.length,60);assert.equal(store.get('saved-team').members.length,4);
 const paper=store.catalog({query:'自己的论文方案'}).plans[0];assert.equal(store.get(paper.id).steps.length,4);
 const flow=store.catalog({query:'旧任务'}).plans[0];assert.equal(store.get(flow.id).legacy_record.results.开始.output,'保留输出');assert(!('legacy_record'in flow));
});
test('edits and undo preserve original config bytes, reject stale revisions and dependency cycles',t=>{
 const {store,before,config,flows}=fixture(t),old=store.get('saved-team');const saved=store.save(old.id,{revision:old.revision,name:'新的分工',members:[{id:'a'},{id:'e'}]});assert.equal(saved.members[1].prompt,'职责e');assert.equal(saved.members[0].name,'专家a');assert.throws(()=>store.save(old.id,{revision:old.revision,name:'过期修改'}),e=>e.status===409);
 const undone=store.undo(old.id,saved.revision);assert.equal(undone.members.length,4);assert.equal(undone.name,'原来的四人');
 assert.throws(()=>store.save('cycle',{kind:'task',name:'循环',steps:[{id:'a',task:'x',depends_on:['b']},{id:'b',task:'y',depends_on:['a']}]}),/循环/);
 assert.deepEqual([fs.readFileSync(config),fs.readFileSync(join(flows,'old.json'))],before);
});
test('task input is resolved in user message while stable plan prompt excludes per-run values',t=>{
 const {store}=fixture(t);const plan=store.save('custom',{kind:'task',name:'评审',inputs:[{name:'project',description:'项目名称',required:true}],steps:[{id:'first',task:'审查 {{project}} 的 {{request}}',expert:'程序员',output:'review',depends_on:[]},{id:'second',task:'总结 {{review}}',depends_on:['first']}]});
 assert.throws(()=>store.prepare('custom',{revision:plan.revision,request:'功能'}),/项目名称/);
 const prepared=store.prepare('custom',{revision:plan.revision,request:'重试逻辑',inputs:{project:'独有项目名称'}});assert.match(prepared.message,/审查 独有项目名称 的 重试逻辑/);assert.match(prepared.message,/总结 \{\{review\}\}/);assert.doesNotMatch(planSystem(prepared.plan),/独有项目名称|重试逻辑/);
});
test('team selection freezes one catalog snapshot and never advertises fake tools or completed delegates',t=>{
 const {store}=fixture(t),plan=store.snapshot('saved-team');assert.equal(plan.members.length,4);assert.equal(plan.members[0].prompt,'职责a');assert.match(planSystem(plan),/没有调用委派工具时不得声称/);assert.doesNotMatch(planSystem(plan),/code_execution|file_manager/);
 store.expert=id=>({id,prompt:'已改变',revision:'2'});assert.equal(plan.members[0].prompt,'职责a');assert.equal(store.snapshot('saved-team').members[0].prompt,'已改变');
});
test('launch retry uses frozen snapshot even after edits and rejects request-id collisions',async t=>{
 const {store}=fixture(t),calls=[];const handler=createPlanHandler({store,checkToken:()=>true,launch:async record=>{calls.push(record);return {request_id:record.id};}});const plan=store.get('saved-team'),body={request_id:'run-one',revision:plan.revision,request:'分析架构'};
 const send=body=>handler(new Request('http://fixture/api/panel-plans/saved-team/launch',{method:'POST',body:JSON.stringify(body)}),'/api/panel-plans/saved-team/launch');
 assert.equal((await send(body)).status,202);store.save('saved-team',{revision:plan.revision,name:'后来名称'});assert.equal((await send(body)).status,202);assert.equal(calls[1].prepared.plan.name,'原来的四人');assert.equal(calls[0].session_id,calls[1].session_id);assert.equal((await send({...body,request:'其他任务'})).status,409);
 const denied=createPlanHandler({store,checkToken:()=>false,launch:()=>assert.fail()});assert.equal((await denied(new Request('http://fixture/api/panel-plans'),'/api/panel-plans')).status,401);
});
const {createPlanLaunch}=await import('../../../app/server/panel-plans.js');
const {ChatQueue}=await import('../../../app/server/panel-queue.js');
test('plan launch resumes submission safely after acknowledgement loss and survives queue restart without a second model run',async t=>{
 const f=fixture(t),sessions=new Map(),calls=[];
 const queue=new ChatQueue({root:join(f.root,'queue'),execute:async job=>{calls.push(job);return {status:'done',result:{reply:'完成'}};}}).load().start();
 const launch=createPlanLaunch({queue,ensureSession:(id,title)=>{if(!sessions.has(id))sessions.set(id,{title});},attachPlan:(id,plan)=>{if(!sessions.get(id).plan)sessions.get(id).plan=plan;},capture:id=>({system:planSystem(sessions.get(id).plan),plan:sessions.get(id).plan})});
 const record={id:'request-one',session_id:'plan_one',prepared:f.store.prepare('saved-team',{revision:f.store.get('saved-team').revision,request:'分析'})};
 await launch(record);await launch(record);for(let i=0;i<100&&queue.get(record.id).status!=='done';i++)await new Promise(r=>setTimeout(r,10));assert.equal(calls.length,1);assert.equal(calls[0].snapshot.plan.members.length,4);assert.equal(sessions.size,1);await queue.stop();
 const reloaded=new ChatQueue({root:join(f.root,'queue'),execute:async()=>assert.fail('must not replay')}).load().start();assert.equal(reloaded.get(record.id).status,'done');await reloaded.stop();
});
