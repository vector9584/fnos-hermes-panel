import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {RoomStore} from '../../../app/server/panel-rooms.js';
function fixture(t){const dir=fs.mkdtempSync(join(tmpdir(),'rooms-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const legacy=join(dir,'legacy.json');const data=[{id:'old',title:'原讨论',members:[{key:'exp_coder',persona_id:'coder',label:'旧专家',system:'旧快照',emoji:'🔬'}],messages:Array.from({length:620},(_,index)=>({kind:'assistant',text:'原文'+index,ts:index})),shared_memory:[{text:'旧笔记'}]}];fs.writeFileSync(legacy,JSON.stringify(data));const before=fs.readFileSync(legacy);let version=1;const store=new RoomStore({root:join(dir,'state'),legacyFile:legacy,expert:id=>({id,name:'专家'+version,emoji:'🤖',prompt:'职责'+version,revision:String(version),quick_prompts:[]}),identity:()=>({user_name:'Vector',user_avatar:'👤'})});return {store,legacy,before,dir,changeExpert:()=>version++};}
test('legacy history over 500 messages remains complete and cursor stable across appends',t=>{const f=fixture(t),{store}=f;const page=store.page('old');assert.equal(page.messages.length,60);assert.equal(page.total,620);assert.equal(page.messages[0].text,'原文560');store.enqueue('old',{request_id:'first',text:'新增'});const older=store.page('old',{before:page.before});assert.equal(older.messages.at(-1).text,'原文559');assert.equal(store.get('old').messages.length,621);assert.deepEqual(fs.readFileSync(f.legacy),f.before);});
test('room creation and sends deduplicate by request id without losing explicit repeats',t=>{const {store}=fixture(t),body={request_id:'new-room',title:'新讨论',expert_ids:['coder']};store.create(body);store.create(body);assert.equal(store.list().length,2);store.enqueue('new-room',{request_id:'one',text:'相同内容'});store.enqueue('new-room',{request_id:'one',text:'相同内容'});assert.equal(store.get('new-room').messages.length,1);store.enqueue('new-room',{request_id:'two',text:'相同内容'});assert.equal(store.get('new-room').messages.length,2);assert.throws(()=>store.enqueue('new-room',{request_id:'one',text:'不同内容'}),error=>error.status===409);});
test('members and pending turns are immutable snapshots, round bounds reject before write',t=>{const f=fixture(t),{store}=f;store.create({request_id:'new-room',title:'新讨论',expert_ids:['coder']});store.enqueue('new-room',{request_id:'one',text:'评审',rounds:2});f.changeExpert();store.addMembers('new-room',{expert_ids:['researcher']});const room=store.get('new-room');assert.equal(room.members[0].system,'职责1');assert.equal(room.members[1].system,'职责2');assert.equal(room.requests[0].members.length,1);assert.equal(room.requests[0].members[0].system,'职责1');const before=JSON.stringify(room);assert.throws(()=>store.enqueue('new-room',{request_id:'bad',text:'评审',rounds:100}));assert.equal(JSON.stringify(store.get('new-room')),before);});
test('archive restore retains all messages notes and member state',t=>{const f=fixture(t),{store}=f;store.archive('old',true);assert.equal(store.list().length,0);assert.equal(store.list({archived:true})[0].message_count,620);store.archive('old',false);assert.equal(store.get('old').messages.length,620);assert.equal(store.get('old').shared_memory[0].text,'旧笔记');assert.deepEqual(fs.readFileSync(f.legacy),f.before);});
test('restart marks only active requests interrupted and never silently replays',t=>{const {store}=fixture(t);store.enqueue('old',{request_id:'one',text:'评审'});store.enqueue('old',{request_id:'two',text:'下一条'});store.updateRequest('old','one',r=>r.status='running');store.recover();assert.equal(store.request('old','one').status,'interrupted');assert.equal(store.request('old','two').status,'pending');assert.throws(()=>store.archive('old',true),error=>error.status===409);});
test('corrupt legacy or overlay fails closed without resetting data',t=>{const f=fixture(t);fs.writeFileSync(f.legacy,'broken');assert.throws(()=>f.store.list(),error=>error.status===503);assert.equal(fs.readFileSync(f.legacy,'utf8'),'broken');fs.writeFileSync(f.legacy,f.before);f.store.archive('old',true);const p=join(f.dir,'state/rooms/old.json');fs.writeFileSync(p,'broken overlay');assert.throws(()=>f.store.get('old'),error=>error.status===503);assert.equal(fs.readFileSync(p,'utf8'),'broken overlay');});
const {RoomRunner,createRoomHandler}=await import('../../../app/server/panel-rooms.js');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function idle(runner){for(let i=0;i<200&&runner.workers.size;i++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(runner.workers.size,0);}
test('runner serializes snapshots and records full text/tools before next member',async t=>{
 const {store}=fixture(t);store.create({request_id:'new-room',title:'讨论',expert_ids:['coder','researcher']});let calls=[];
 const runner=new RoomRunner({store,execute:async(job,{emit})=>{calls.push(job);emit({delta:'完整文本'+job.step});emit({tool_progress:{toolCallId:'one',tool:'read_file',status:'completed',result:'证据'}});return {status:'done',reply:'完整文本'+job.step,tools:[{toolCallId:'one',tool:'read_file',status:'completed',result:'证据'}]};}}).start();
 runner.enqueue('new-room',{request_id:'one',text:'比较',rounds:2});await idle(runner);assert.equal(calls.length,4);assert.equal(calls[0].system,'职责1');assert.match(calls[1].message,/完整文本0/);
 const room=store.get('new-room');assert.equal(room.requests[0].status,'done');assert.equal(room.messages.length,5);assert.equal(room.messages[1].tools[0].result,'证据');await runner.stop();
});
test('failed member pauses queue, resume retries only that step and preserves prior failure',async t=>{
 const {store}=fixture(t);store.create({request_id:'new-room',title:'讨论',expert_ids:['coder','researcher']});let calls=[],fail=true;
 const runner=new RoomRunner({store,execute:async(job,{emit})=>{calls.push(job);emit({delta:'已保存片段'});if(job.step===1&&fail)return {status:'failed',reply:'部分回复',error:'模型断开'};return {status:'done',reply:'成功'+job.step};}}).start();
 runner.enqueue('new-room',{request_id:'one',text:'讨论'});runner.enqueue('new-room',{request_id:'two',text:'排队'});await idle(runner);assert.equal(calls.length,2);assert.equal(store.request('new-room','one').status,'failed');assert.equal(store.request('new-room','two').status,'pending');
 fail=false;runner.resume('new-room','one');await idle(runner);assert.equal(calls[2].step,1);assert.equal(calls[2].attempt,1);assert.notEqual(calls[1].id,calls[2].id);assert.equal(store.request('new-room','two').status,'done');assert.ok(store.get('new-room').messages.some(m=>m.text==='部分回复'&&m.status==='failed'));await runner.stop();
});
test('shutdown retains checkpoint and blocks pending work until explicit continuation',async t=>{
 const {store}=fixture(t);let count=0;const runner=new RoomRunner({store,execute:async(job,{emit,signal})=>{count++;emit({delta:'中断前内容'});emit({tool_progress:{tool:'terminal',status:'running'}});return await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('stop')),{once:true}));}}).start();
 runner.enqueue('old',{request_id:'one',text:'长任务'});runner.enqueue('old',{request_id:'two',text:'下一条'});await tick();await runner.stop();
 const room=store.get('old');assert.equal(room.requests[0].status,'interrupted');assert.equal(room.messages.at(-1).text,'下一条');assert.ok(room.messages.some(m=>m.text==='中断前内容'&&m.tools[0].tool==='terminal'));
 const restarted=new RoomRunner({store,execute:async()=>assert.fail('must remain paused')}).start();await tick();assert.equal(count,1);await restarted.stop();
});
test('room HTTP protects reads and mutations; archived export retains complete history',async t=>{
 const {store}=fixture(t),runner=new RoomRunner({store,execute:async()=>({status:'done',reply:'ok'})});
 const denied=createRoomHandler({store,runner,checkToken:()=>false});assert.equal((await denied(new Request('http://fixture/api/panel-rooms'),'/api/panel-rooms')).status,401);
 const handler=createRoomHandler({store,runner,checkToken:()=>true});const response=await handler(new Request('http://fixture/api/panel-rooms/old/export'),'/api/panel-rooms/old/export');assert.equal((await response.json()).messages.length,620);
});
const {createRoomExecution}=await import('../../../app/server/panel-room-execution.js');
const {ChatQueue}=await import('../../../app/server/panel-queue.js');
test('room adapter reuses durable queue with isolated member sessions, stable request ids and no browser',async t=>{
 const f=fixture(t),calls=[],sessions=[];
 const queue=new ChatQueue({root:join(f.dir,'queue'),execute:async(job,{emit})=>{calls.push(job);emit({delta:'响应'});emit({tool_progress:{tool:'read_file',status:'completed'}});return {status:'done'};}}).load().start();
 const run=createRoomExecution({queue,ensureSession:(id)=>sessions.push(id),userIdentity:()=>({sender:'Vector'})});
 const job={id:'room-exec',room_id:'old',member:{key:'exp_coder',label:'程序员',emoji:'💻',persona_id:'coder'},message:'评审',system:'冻结职责',attempt:0,model:'same',provider:'service-b'};
 const packets=[];let result=await run(job,{signal:new AbortController().signal,emit:p=>packets.push(p)});assert.equal(result.reply,'响应');assert.equal(result.tools[0].tool,'read_file');assert.equal(calls[0].snapshot.system,'冻结职责');assert.equal(calls[0].payload.provider,'service-b');
 result=await run(job,{emit:()=>{}});assert.equal(calls.length,1);assert.equal(result.reply,'响应');assert.equal(sessions[0],sessions[1]);await queue.stop();
});
test('recovery reconciles final queue acknowledgement without executing the same member twice',async t=>{
 const {store}=fixture(t);store.create({request_id:'recover-room',title:'恢复',expert_ids:['coder']});store.enqueue('recover-room',{request_id:'one',text:'调用'});
 store.updateRequest('recover-room','one',(request,room)=>{Object.assign(request,{status:'running',active_step:0,active_execution:'execution-one'});room.messages.push({id:'reply',execution_id:'execution-one',kind:'assistant',text:'残留',status:'running'});});
 const runner=new RoomRunner({store,reconcile:()=>({status:'done',result:{reply:'已成功',tools:[{tool:'terminal',status:'completed'}]}}),execute:async()=>assert.fail('completed work must not replay')}).start();await tick();
 assert.equal(store.request('recover-room','one').status,'done');assert.equal(store.get('recover-room').messages.at(-1).text,'已成功');assert.equal(store.get('recover-room').messages.at(-1).tools[0].status,'completed');await runner.stop();
});
test('notes are idempotent, reversible, and frozen in the submitted discussion',async t=>{
 const f=fixture(t),{store}=f;const note={request_id:'saved-note',text:'具体决策'};store.addNote('old',note);store.addNote('old',note);assert.equal(store.get('old').shared_memory.length,2);
 store.enqueue('old',{request_id:'one',text:'下一步'});store.noteState('old',{note_id:'saved-note',archived:true});assert.equal(store.request('old','one').notes.length,2);
 store.enqueue('old',{request_id:'two',text:'再下一步'});assert.equal(store.request('old','two').notes.length,1);store.noteState('old',{note_id:'saved-note',archived:false});assert.equal(store.get('old').shared_memory.filter(n=>!n.archived_at).length,2);
 assert.deepEqual(fs.readFileSync(f.legacy),f.before);
});
test('room draft conflicts preserve both devices and survive store reload',async t=>{
 const f=fixture(t);f.store.drafts.put('old',{revision:0,text:'手机内容',options:{rounds:2,members:['exp_coder']}});
 const conflict=f.store.drafts.put('old',{revision:0,text:'电脑内容'});assert.equal(conflict.conflict,true);assert.equal(conflict.draft.text,'手机内容');assert.equal(conflict.draft.conflicts[0].text,'电脑内容');
 const reloaded=new RoomStore({root:f.store.root,legacyFile:f.legacy,expert:f.store.expert});assert.equal(reloaded.drafts.get('old').options.rounds,2);assert.equal(reloaded.drafts.get('old').conflicts.length,1);
 const merged=reloaded.drafts.put('old',{revision:1,text:'手机内容\n电脑内容',resolve_key:conflict.draft.conflicts[0].key});assert.equal(merged.ok,true);assert.equal(merged.draft.conflicts.length,0);
});
test('search around stable ids and compact list keep all full history in export',t=>{
 const {store}=fixture(t);const id=store.get('old').messages[45].id;const page=store.page('old',{around:id});assert.ok(page.messages.some(m=>m.id===id));assert.equal(page.messages.length,60);
 const list=store.list();assert.equal(list[0].message_count,620);assert.equal(list[0].messages,undefined);assert.equal(list[0].shared_memory,undefined);assert.equal(list[0].members[0].system,undefined);assert.equal(store.get('old').members[0].system,'旧快照');
});
test('room HTTP validates configured provider/model identity and optimistic settings',async t=>{
 const {store}=fixture(t),runner=new RoomRunner({store,execute:async()=>({status:'done',reply:'ok'})}),handler=createRoomHandler({store,runner,checkToken:()=>true,modelCatalog:async()=>({providers:[{id:'service-a',models:['same']},{id:'service-b',models:['same']}]})});
 const post=async(path,body)=>handler(new Request('http://fixture'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),path);
 let response=await post('/api/panel-rooms',{request_id:'chosen',title:'选模型',expert_ids:['coder'],provider:'service-b',model:'same'});assert.equal(response.status,200);assert.equal((await response.json()).room.provider,'service-b');
 response=await post('/api/panel-rooms',{request_id:'invalid',title:'不应创建',expert_ids:['coder'],provider:'missing',model:'same'});assert.equal(response.status,400);assert.throws(()=>store.get('invalid'));
 const room=store.get('chosen');response=await post('/api/panel-rooms/chosen/settings',{revision:room.revision,title:'更新名称',provider:'service-a',model:'same'});assert.equal(response.status,200);
 response=await post('/api/panel-rooms/chosen/settings',{revision:room.revision,title:'过期名称'});assert.equal(response.status,409);assert.equal(store.get('chosen').title,'更新名称');
});
