import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createEchoHandler} from '../../../app/server/panel-echo.js';

const root=mkdtempSync(join(tmpdir(),'panel-echo-http-'));
const queue=join(root,'tasks.json'),draftFile=join(root,'var/panel-state/echo-drafts.json');
mkdirSync(join(root,'var/panel-state'),{recursive:true});
writeFileSync(queue,JSON.stringify({version:1,seq:0,tasks:[],last_run:null}));
const original=readFileSync(queue);
const handler=createEchoHandler({python:'python3',serverRoot:join(process.cwd(),'app/server'),queueFile:queue,backupRoot:join(root,'backups'),draftFile,checkToken:req=>req.headers.get('x-test-auth')==='yes'});
async function request(action,body={},authorized=true){const req=new Request('http://fixture/api/echo',{method:action?'POST':'GET',headers:{'Content-Type':'application/json','x-test-auth':authorized?'yes':'no'},body:action?JSON.stringify({action,...body}):undefined});const response=await handler(req,'/api/echo');return {status:response.status,...await response.json()};}
test.after(()=>rmSync(root,{recursive:true,force:true}));

test('ECHO list exposes validated server pagination and searches complete task families',async()=>{
 const tasks=Array.from({length:35},(_,index)=>({id:index+1,title:`根任务 ${index+1}`,detail:'根要求',status:'done',star:3}));
 tasks.push({id:36,parent:35,title:'跨页子任务',detail:'唯一命中词',status:'pending'});
 writeFileSync(queue,JSON.stringify({version:1,seq:36,tasks,last_run:'fixture'}));
 let first=await request(null);assert.equal(first.total,35);assert.equal(first.limit,null);
 const pageOne=await handler(new Request('http://fixture/api/echo?limit=30&offset=0',{headers:{'x-test-auth':'yes'}}),'/api/echo');
 const one={...await pageOne.json()};assert.equal(one.total,35);assert.equal(one.has_more,true);assert.equal(one.tasks.filter(task=>!task.parent).length,30);
 const pageTwo=await handler(new Request(`http://fixture/api/echo?limit=30&before_id=${one.next_before_id}`,{headers:{'x-test-auth':'yes'}}),'/api/echo');
 const two=await pageTwo.json();assert.equal(two.has_more,false);assert.deepEqual(two.tasks.map(task=>task.id),[5,4,3,2,1]);
 const search=await handler(new Request('http://fixture/api/echo?limit=30&offset=0&query=%E5%94%AF%E4%B8%80%E5%91%BD%E4%B8%AD%E8%AF%8D',{headers:{'x-test-auth':'yes'}}),'/api/echo');
 const found=await search.json();assert.equal(found.total,1);assert.deepEqual(found.tasks.map(task=>task.id),[35,36]);
 const denied=await handler(new Request('http://fixture/api/echo?limit=30',{headers:{'x-test-auth':'no'}}),'/api/echo');assert.equal(denied.status,401);
 const invalid=await handler(new Request('http://fixture/api/echo?limit=1000',{headers:{'x-test-auth':'yes'}}),'/api/echo');assert.equal(invalid.status,422);
 const badCursor=await handler(new Request('http://fixture/api/echo?before_id=0',{headers:{'x-test-auth':'yes'}}),'/api/echo');assert.equal(badCursor.status,422);
 const malformed=await handler(new Request('http://fixture/api/echo?limit=NaN',{headers:{'x-test-auth':'yes'}}),'/api/echo');assert.equal(malformed.status,422);
 writeFileSync(queue,original);
});

test('ECHO draft API is authenticated, versioned, and separate from task queue writes',async()=>{
 assert.equal((await request('draft_save',{key:'create:new',values:{title:'x'}} ,false)).status,401);
 let saved=await request('draft_save',{key:'create:new',values:{title:'跨设备标题',detail:'未提交'},initial:{title:'',detail:''},source_revision:null,request_id:'draft-http-123',client_id:'device-a'});
 assert.equal(saved.status,200);assert.equal(saved.draft.values.detail,'未提交');assert.match(saved.draft.draft_revision,/^[a-f0-9]{64}$/);
 assert.equal((await request('draft_get',{key:'create:new'})).draft.draft_revision,saved.draft.draft_revision);
 let stale=await request('draft_save',{key:'create:new',draft_revision:'stale',values:{detail:'覆盖'}});assert.equal(stale.status,409);
 assert.equal((await request('draft_get',{key:'create:new'})).draft.values.detail,'未提交');
 assert.equal(readFileSync(queue).toString(),original.toString());assert.equal(statSync(draftFile).mode&0o777,0o600);
 assert.equal((await request('draft_delete',{key:'create:new',draft_revision:saved.draft.draft_revision})).status,200);
 assert.equal((await request('draft_get',{key:'create:new'})).draft,null);
});

test('ECHO draft API rejects invalid keys and oversized drafts without changing saved draft',async()=>{
 const first=await request('draft_save',{key:'update:9',values:{detail:'保留'}});assert.equal(first.status,200);
 assert.equal((await request('draft_get',{key:'../tasks.json'})).status,422);
 const tooLarge=await request('draft_save',{key:'update:9',draft_revision:first.draft.draft_revision,values:{detail:'x'.repeat(70000)}});assert.equal(tooLarge.status,422);
 assert.equal((await request('draft_get',{key:'update:9'})).draft.values.detail,'保留');
});
