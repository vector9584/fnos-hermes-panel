import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ModelChecks,checkModelResponse,createModelChecksHandler} from '../../../app/server/panel-model-checks.js';
const target={provider:'a',name:'服务甲',model:'same',base_url:'https://fixture.invalid/v1',api_key:'private-key',api_mode:'chat_completions',headers:{},extra_body:{tools:[{bad:true}]}};
const response=data=>new Response(JSON.stringify(data));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function root(t){const p=fs.mkdtempSync(join(tmpdir(),'model-checks-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;}
test('response check sends exact provider endpoint and no tools or session',async()=>{
 let captured;const result=await checkModelResponse(target,{fetcher:async(url,options)=>{captured={url,options};return response({model:'reported',choices:[{message:{content:'HERMES_OK'},finish_reason:'stop'}]});}});
 assert.equal(captured.url,'https://fixture.invalid/v1/chat/completions');assert.equal(captured.options.headers.Authorization,'Bearer private-key');assert.equal(captured.options.redirect,'error');
 const body=JSON.parse(captured.options.body);assert.equal(body.model,'same');assert.equal(body.tools,undefined);assert.equal(body.session_id,undefined);assert.equal(result.exact_match,true);assert.equal(result.response_model,'reported');
});
test('protocol shapes and truthful instruction-match reporting',async()=>{
 for(const mode of ['anthropic_messages','codex_responses']){
  const result=await checkModelResponse({...target,api_mode:mode},{fetcher:async(url,options)=>{
   const body=JSON.parse(options.body);assert.equal(body.tools,undefined);
   if(mode==='anthropic_messages'){assert.ok(url.endsWith('/messages'));assert.equal(options.headers['x-api-key'],'private-key');return response({content:[{type:'text',text:'other text'}],stop_reason:'end_turn'});}
   assert.ok(url.endsWith('/responses'));assert.equal(body.store,false);return response({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'other text'}]}]});
  }});assert.equal(result.exact_match,false);assert.equal(result.output,'other text');
 }
});
test('401, empty content, malformed JSON and error envelopes fail without leaking upstream secrets',async()=>{
 for(const fetcher of [async()=>new Response('private-key',{status:401}),async()=>response({choices:[{message:{content:''}}]}),async()=>new Response('not json'),async()=>response({error:{message:'private-key'}})]){
  await assert.rejects(()=>checkModelResponse(target,{fetcher}),error=>error.status===502&&!error.message.includes('private-key'));
 }
});
test('deadline and cancellation stop request and report different results',async()=>{
 const fetcher=async(url,{signal})=>new Promise((resolve,reject)=>{if(signal.aborted)reject(Error('aborted'));else signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true});});
 await assert.rejects(()=>checkModelResponse(target,{fetcher,timeoutMs:10}),error=>error.status===504);
 const controller=new AbortController();const pending=checkModelResponse(target,{fetcher,signal:controller.signal});controller.abort();await assert.rejects(()=>pending,error=>error.status===499);
});
test('persistent jobs are idempotent, retain provider and survive reopen without repeating execution',async t=>{
 let finish,count=0;const r=root(t),source=async()=>({target});const checks=new ModelChecks({root:r,source,probe:async()=>{count++;return await new Promise(resolve=>finish=resolve);}}).load();
 const body={request_id:'one',provider:'a',model:'same'};await checks.create(body);await checks.create(body);assert.equal(count,1);assert.equal(checks.list()[0].provider,'a');
 await assert.rejects(()=>checks.create({...body,provider:'b'}),error=>error.status===409);
 const interrupted=new ModelChecks({root:r,source,probe:()=>assert.fail('must not rerun')}).load();assert.equal(interrupted.get('one').status,'interrupted');
 finish({output:'HERMES_OK',exact_match:true});await tick();assert.equal(checks.get('one').status,'done');
 const restored=new ModelChecks({root:r,source}).load();assert.equal(restored.get('one').result.output,'HERMES_OK');assert.ok(!fs.readFileSync(join(r,'one.json'),'utf8').includes('private-key'));
});
test('cancel persists intention; failed write cannot claim success; corrupt state is retained',async t=>{
 const r=root(t),source=async()=>({target});const checks=new ModelChecks({root:r,source,probe:async(t,{signal})=>await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}))}).load();
 await checks.create({request_id:'cancel',provider:'a',model:'same'});checks.cancel('cancel');await tick();assert.equal(checks.get('cancel').status,'cancelled');assert.ok(checks.get('cancel').cancel_requested_at);
 fs.writeFileSync(join(r,'broken.json'),'{broken');assert.throws(()=>new ModelChecks({root:r,source}).load());assert.equal(fs.readFileSync(join(r,'broken.json'),'utf8'),'{broken');
});
test('a result disk failure is visible and leaves the durable running record for restart reconciliation',async t=>{
 let finish;const r=root(t),checks=new ModelChecks({root:r,source:async()=>({target}),probe:async()=>await new Promise(resolve=>finish=resolve)}).load();
 await checks.create({request_id:'disk',provider:'a',model:'same'});checks.persist=()=>{throw Error('disk full');};finish({output:'HERMES_OK'});await tick();
 assert.equal(checks.get('disk').status,'failed');assert.match(checks.get('disk').error,/保存失败/);
 assert.equal(JSON.parse(fs.readFileSync(join(r,'disk.json'))).status,'running');
});
test('all model check routes authenticate before catalog or execution',async t=>{
 const checks=new ModelChecks({root:root(t),source:async()=>assert.fail('unauthorized source')});const handler=createModelChecksHandler({checks,checkToken:()=>false});
 for(const path of ['/api/panel-models/catalog','/api/panel-models/checks','/api/panel-models/checks/one'])assert.equal((await handler(new Request('http://fixture'+path),path)).status,401);
});
