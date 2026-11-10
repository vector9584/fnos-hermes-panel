import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
import {StateFile, SessionDrafts, atomicWriteJSON} from '../../../app/server/panel-state.js';
import {ChatQueue} from '../../../app/server/panel-queue.js';
import {createQueueHandler, queueEvents} from '../../../app/server/panel-queue-http.js';
import {recoverInterruptedAssistantMessage} from '../../../app/server/panel-chat-recovery.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
function temp(t) { const dir = fs.mkdtempSync(join(tmpdir(), 'hermes-rebuild-test-')); t.after(() => fs.rmSync(dir, {recursive:true,force:true})); return dir; }
const input = (request_id, session_id='session-a', message='hello') => ({request_id, session_id, message});
async function until(fn) { for (let n=0;n<200;n++) { if (fn()) return; await sleep(10); } throw Error('condition timeout'); }

test('atomic failure keeps exact previous bytes and cleans only its temp file', t => {
  const dir=temp(t), file=join(dir,'state.json');
  atomicWriteJSON(file,{data:'original'});
  const before=fs.readFileSync(file);
  const io={...fs, renameSync(){throw Object.assign(Error('disk unavailable'),{code:'EIO'});}};
  assert.throws(()=>atomicWriteJSON(file,{data:'replacement'},io),/disk unavailable/);
  assert.deepEqual(fs.readFileSync(file),before);
  assert.deepEqual(fs.readdirSync(dir),['state.json']);
  assert.equal(fs.statSync(file).mode & 0o777,0o600);
});

test('corrupt state is neither emptied nor silently ignored', t => {
  const file=join(temp(t),'state.json'); fs.writeFileSync(file,'{broken');
  const store=new StateFile(file,()=>({}));
  assert.throws(()=>store.update(x=>{x.would='erase';}),/原文件已保留/);
  assert.equal(fs.readFileSync(file,'utf8'),'{broken');
});

test('draft revisions retain both device versions and explicit conflict resolution', t => {
  const drafts=new SessionDrafts(temp(t));
  const a=drafts.put('sid',{revision:0,text:'device A',options:{expert:'reviewer'}});
  const b=drafts.put('sid',{revision:0,text:'device B',attachments:[{url:'/a.png'}]});
  assert.equal(a.ok,true);assert.equal(b.conflict,true);assert.equal(b.draft.text,'device A');
  assert.equal(b.draft.conflicts[0].text,'device B');
  const loaded=new SessionDrafts(drafts.root).get('sid');
  assert.equal(loaded.options.expert,'reviewer');
  const chosen=drafts.put('sid',{revision:loaded.revision,text:'device B',attachments:loaded.conflicts[0].attachments,resolve_key:loaded.conflicts[0].key});
  assert.equal(chosen.draft.conflicts.length,0);assert.equal(chosen.draft.revision,2);
  assert.throws(()=>drafts.get('../soul'),/无效/);
});

test('durable acknowledgement, idempotent retry, and distinct same-text sends', async t => {
  const root=temp(t), called=[];
  const q=new ChatQueue({root,execute:async job=>{called.push(job.id);}}).load();t.after(()=>q.stop());
  assert.equal(q.enqueue(input('a')).duplicate,false);
  assert.equal(q.enqueue(input('a')).duplicate,true);
  assert.throws(()=>q.enqueue(input('a','session-a','other')),e=>e.status===409);
  assert.equal(JSON.parse(fs.readFileSync(join(root,'a.json'))).status,'pending');
  q.enqueue(input('b'));q.start();await q.idle();assert.deepEqual(called,['a','b']);
});

test('same-session FIFO and independent sessions run concurrently', async t => {
  const root=temp(t), starts=[],completed=[],counts=new Map();let parallel=0,maxParallel=0;
  const q=new ChatQueue({root,execute:async job=>{
    assert.equal(counts.get(job.session_id)||0,0);counts.set(job.session_id,1);
    starts.push(job.id);maxParallel=Math.max(maxParallel,++parallel);await sleep(20);
    completed.push(job.id);parallel--;counts.set(job.session_id,0);
  }}).load();t.after(()=>q.stop());
  ['z','y','x'].forEach(id=>q.enqueue(input(id)));q.enqueue(input('w','session-b'));q.start();await q.idle();
  assert.deepEqual(starts.filter(x=>x!=='w'),['z','y','x']);assert.equal(maxParallel,2);assert.equal(completed.length,4);
});

test('transport disconnect does not abort work; reconnect gets persisted text and tools', async t => {
  const root=temp(t);let release;const gate=new Promise(r=>release=r);
  const q=new ChatQueue({root,flushMs:1,execute:async (job,{emit})=>{
    emit({delta:'first'});emit({tool_progress:{toolCallId:'t1',tool:'terminal',status:'running'}});
    await gate;emit({tool_progress:{toolCallId:'t1',tool:'terminal',status:'done',result:'ok'}});emit({delta:' last'});
  }}).load().start();t.after(()=>q.stop());
  q.enqueue(input('a'));await until(()=>q.get('a').result.reply==='first');
  const c=new AbortController(),stream=queueEvents(q,'a',c.signal),reader=stream.getReader();
  const first=await reader.read();assert.match(new TextDecoder().decode(first.value),/first/);c.abort();
  const second=[];const unsub=q.subscribe('a',e=>second.push(e));release();await q.idle();unsub();
  assert.equal(q.get('a').result.reply,'first last');assert.equal(q.get('a').result.tools[0].status,'done');
  assert.equal(q.get('a').status,'done');assert.equal(q.subscribers.size,0);
  assert.equal(new ChatQueue({root,execute:()=>{throw Error('must not rerun');}}).load().get('a').status,'done');
});

test('pending cancellation never invokes executor; running cancellation keeps partial result', async t => {
  const called=[];const q=new ChatQueue({root:temp(t),execute:async (job,{signal,emit})=>{
    called.push(job.id);emit({delta:'saved'});await new Promise(r=>signal.addEventListener('abort',r,{once:true}));
  }}).load();t.after(()=>q.stop());
  q.enqueue(input('queued'));q.cancel('queued');q.enqueue(input('running'));q.start();
  await until(()=>called.length===1);q.cancel('running');await q.idle();
  assert.deepEqual(called,['running']);assert.equal(q.get('running').status,'cancelled');assert.ok(q.get('running').cancel_requested_at);
  assert.equal(q.get('running').result.reply,'saved');
});

test('gateway unavailability leaves accepted messages durable and pending', async t => {
  let ready=false,calls=0;const q=new ChatQueue({root:temp(t),available:()=>ready,execute:async()=>{calls++;}}).load().start();t.after(()=>q.stop());
  q.enqueue(input('waiting'));await sleep(30);assert.equal(calls,0);assert.equal(q.get('waiting').status,'pending');
  ready=true;q.pump();await q.idle();assert.equal(calls,1);
});

test('real worker process death preserves queue and blocks unsafe continuation', async t => {
  const root=temp(t),module=new URL('../../../app/server/panel-queue.js', import.meta.url).href;
  const script=`import {ChatQueue} from ${JSON.stringify(module)};
    const q=new ChatQueue({root:${JSON.stringify(root)},execute:async(job,{emit})=>{
      emit({delta:'checkpoint'});emit({tool_progress:{toolCallId:'call-1',tool:'terminal',status:'running'}});
      process.send('checkpoint');await new Promise(()=>{});
    }}).load();q.enqueue(${JSON.stringify(input('a'))});q.enqueue(${JSON.stringify(input('b'))});q.start();setInterval(()=>{},1000);`;
  const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','pipe','pipe','ipc']});
  t.after(()=>{if(!child.killed)child.kill('SIGKILL');});
  const arrived=await Promise.race([once(child,'message'),once(child,'exit').then(()=>{throw Error('worker exited early');})]);
  assert.equal(arrived[0],'checkpoint');child.kill('SIGKILL');await once(child,'exit');
  const called=[];const q=new ChatQueue({root,execute:async j=>{called.push(j.id);}}).load().start();t.after(()=>q.stop());
  await sleep(30);assert.equal(q.get('a').status,'interrupted');assert.equal(q.get('a').result.reply,'checkpoint');assert.deepEqual(q.get('a').result.tools,[{toolCallId:'call-1',tool:'terminal',status:'running'}]);assert.deepEqual(called,[]);
  assert.equal(q.get('b').status,'pending');q.resolve('a');q.pump();await q.idle();assert.deepEqual(called,['b']);
});

test('restart recovery closes the transcript turn and retains its interrupted tool checkpoint', t => {
  const root=temp(t),sessions=join(root,'sessions');fs.mkdirSync(sessions);
  const sessionFile=join(sessions,'session-a.json');
  const session={id:'session-a',messages:[{role:'user',request_id:'a',content:'检查'}]};
  atomicWriteJSON(sessionFile,session);
  const queueRoot=join(root,'queue');fs.mkdirSync(queueRoot);
  const job={version:1,id:'a',session_id:'session-a',input_hash:'test',payload:{message:'检查'},snapshot:{},status:'running',seq:2,created_at:1,order:1,updated_at:1,result:{reply:'已检查一部分',reasoning:'',tools:[
    {tool:'read_file',toolCallId:'read-1',status:'completed',result:'保留结果'},
    {tool:'terminal',toolCallId:'run-1',status:'running'},
  ],info:'',error:'',usage:null}};
  atomicWriteJSON(join(queueRoot,'a.json'),job);
  const q=new ChatQueue({root:queueRoot,execute:()=>assert.fail('interrupted work must not replay'),onInterrupted:current=>{
    const saved=JSON.parse(fs.readFileSync(sessionFile,'utf8'));
    const message=recoverInterruptedAssistantMessage(saved,current,{now:()=>42});
    atomicWriteJSON(sessionFile,saved);
    return {reply:message.content,tools:message.tools};
  }}).load();t.after(()=>q.stop());
  const recovered=JSON.parse(fs.readFileSync(sessionFile,'utf8')).messages[1];
  assert.equal(recovered._streaming,undefined);assert.equal(recovered.queue_status,'interrupted');
  assert.match(recovered.content,/被打断/);assert.equal(recovered.tools[0].result,'保留结果');
  assert.equal(recovered.tools[0].status,'completed');assert.equal(recovered.tools[1].status,'interrupted');
  assert.equal(q.get('a').status,'interrupted');assert.equal(q.get('a').result.tools[0].result,'保留结果');
});

test('crash after chat final save reconciles without duplicate model execution', async t => {
  const root=temp(t);const q1=new ChatQueue({root,execute:()=>{}}).load();q1.enqueue(input('a'));
  const file=join(root,'a.json'),job=JSON.parse(fs.readFileSync(file));job.status='running';atomicWriteJSON(file,job);
  let calls=0;const q2=new ChatQueue({root,execute:()=>{calls++;},reconcile:j=>j.id==='a'?{status:'done',result:{reply:'saved final'}}:null}).load().start();
  t.after(()=>q2.stop());await q2.idle();assert.equal(calls,0);assert.equal(q2.get('a').result.reply,'saved final');
});

test('storage failure never acknowledges enqueue and never starts execution', async t => {
  const root=temp(t),io={...fs,renameSync(){throw Error('ENOSPC');}};let called=0;
  const q=new ChatQueue({root,io,execute:()=>{called++;}}).load().start();t.after(()=>q.stop());
  assert.throws(()=>q.enqueue(input('a')),/ENOSPC/);await sleep(20);assert.equal(called,0);assert.equal(q.list().length,0);
});

test('failed progress checkpoint aborts executor and preserves prior on-disk state', async t => {
  const root=temp(t);let fail=false,aborted=false;
  const io={...fs,renameSync(a,b){if(fail)throw Error('ENOSPC');return fs.renameSync(a,b);}};
  const q=new ChatQueue({root,io,execute:async(j,{emit,signal})=>{
    fail=true;try{emit({tool_progress:{tool:'terminal',status:'running'}});}catch{}
    aborted=signal.aborted;
  }}).load().start();t.after(()=>q.stop());q.enqueue(input('a'));await until(()=>q.fault);
  assert.equal(aborted,true);assert.equal(q.get('a').result.tools.length,0);
  assert.equal(JSON.parse(fs.readFileSync(join(root,'a.json'))).status,'running');
});

test('HTTP authenticates reads/writes, rejects traversal and snapshots without reexecution', async t => {
  let count=0;const q=new ChatQueue({root:temp(t),execute:async()=>{count++;}}).load().start();t.after(()=>q.stop());
  const handle=createQueueHandler({queue:q,checkToken:r=>r.headers.get('x-monitor-token')==='test',sessionExists:s=>s==='session-a'});
  const req=(path,method='GET',body,auth=true)=>new Request('http://localhost/api/chat/queue'+path,{method,headers:{'Content-Type':'application/json',...(auth?{'X-Monitor-Token':'test'}:{})},body:body?JSON.stringify(body):undefined});
  assert.equal((await handle(req('','GET',null,false))).status,401);
  assert.equal((await handle(req('','POST',input('a','../bad')))).status,400);
  assert.equal((await handle(req('','POST',input('a')))).status,202);await q.idle();
  assert.equal((await handle(req('','POST',input('a')))).status,200);
  const response=await handle(req('/a/events'));assert.match(await response.text(),/"status":"done"/);assert.equal(count,1);assert.equal(q.subscribers.size,0);
});
