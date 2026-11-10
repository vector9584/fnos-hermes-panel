import test from 'node:test';import assert from 'node:assert/strict';import {resolveModelRoutes,createModelsService} from '../../../app/server/panel-models.js';
import {createServer} from 'node:http';
const config={ok:true,providers:[{id:'one',name:'duplicate',enabled:true,model:'a',models:[{id:'a',enabled:true},{id:'b',enabled:false}]},{id:'two',name:'duplicate',enabled:false,models:[]}],primary:{provider:'one',model:'a'},fallbacks:[{provider:'two',model:'x'}]};
test('explicit model choices stay in Gateway and missing choices fail closed',()=>{const before=JSON.stringify(config);assert.deepEqual(resolveModelRoutes(config,{provider:'one',model:'a'}).map(p=>[p.gatewayProvider,p.model,p.viaGateway]),[['custom:one','a',true]]);for(const choice of [{provider:'absent',model:'a'},{provider:'one',model:'b'},{provider:'two',model:'x'}])assert.throws(()=>resolveModelRoutes(config,choice));assert.equal(JSON.stringify(config),before);});
test('default uses one agent execution; fallback chain belongs to Gateway',()=>{const routes=resolveModelRoutes(config);assert.equal(routes.length,1);assert.equal(routes[0].viaGateway,true);assert.throws(()=>resolveModelRoutes({ok:false,error:'broken'}),/broken/);assert.throws(()=>resolveModelRoutes({...config,primary:{}}));});
test('model operations require auth and valid methods before spawning',async()=>{const service=createModelsService({start:()=>{throw Error('unexpected spawn');}});assert.equal((await service.handle(new Request('http://fixture/api/panel-models'),'/api/panel-models',()=>false)).status,401);assert.equal((await service.handle(new Request('http://fixture/api/panel-models',{method:'DELETE'}),'/api/panel-models',()=>true)).status,405);assert.equal(await service.handle(new Request('http://fixture/api/other'),'/api/other',()=>true),null);});
test('temporary model discovery is authenticated, bounded, and never persists config',async()=>{
 let received;const service=createModelsService({start:()=>{throw Error('discovery must not spawn config writer');},fetcher:async(url,options)=>{received={url,options};return new Response(JSON.stringify({data:[{id:'alpha',name:'Alpha'},'beta',{id:'alpha'}]}),{status:200,headers:{'Content-Type':'application/json'}});}});
 const request=()=>new Request('http://fixture/api/panel-models',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'discover',base_url:'https://models.example/v1/',api_key:'secret',api_mode:'chat_completions'})});
 assert.equal((await service.handle(request(),'/api/panel-models',()=>false)).status,401);
 const response=await service.handle(request(),'/api/panel-models',()=>true),out=await response.json();assert.equal(response.status,200);assert.deepEqual(out.models,[{id:'alpha',name:'Alpha'},{id:'beta',name:'beta'}]);assert.equal(received.url,'https://models.example/v1/models');assert.equal(received.options.headers.Authorization,'Bearer secret');assert.equal(received.options.redirect,'error');assert.equal(received.options.method,undefined);
});
test('model discovery rejects unsafe URL syntax and reports invalid model responses',async()=>{
 let calls=0;const service=createModelsService({start:()=>{throw Error('unexpected spawn');},fetcher:async()=>{calls++;return new Response(JSON.stringify({unexpected:true}));}});
 const post=body=>new Request('http://fixture/api/panel-models',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'discover',api_key:'secret',...body})});
 let response=await service.handle(post({base_url:'http://user:pass@example.com/v1'}),'/api/panel-models',()=>true);assert.equal(response.status,400);assert.equal(calls,0);
 response=await service.handle(post({base_url:'https://models.example/v1'}),'/api/panel-models',()=>true);assert.equal(response.status,400);assert.match((await response.json()).error,/没有模型列表/);assert.equal(calls,1);
});
test('model discovery can read an explicitly addressed loopback HTTP model proxy',async t=>{
 const server=createServer((request,response)=>{assert.equal(request.url,'/v1/models');assert.equal(request.headers.authorization,'Bearer local-key');response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({data:[{id:'local-model'}]}));});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});t.after(()=>new Promise(resolve=>server.close(resolve)));
 const address=server.address(),service=createModelsService({start:()=>{throw Error('discovery must not spawn config writer');}});
 const request=new Request('http://fixture/api/panel-models',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'discover',base_url:`http://127.0.0.1:${address.port}/v1`,api_key:'local-key'})});
 const response=await service.handle(request,'/api/panel-models',()=>true),result=await response.json();assert.equal(response.status,200);assert.deepEqual(result.models,[{id:'local-model',name:'local-model'}]);
});
test('model discovery requires HTTPS and enforces streamed response size without echoing credentials',async()=>{
 let calls=0;const service=createModelsService({start:()=>{throw Error('unexpected spawn');},fetcher:async()=>{calls++;return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('x'.repeat(1024*1024+1)));controller.close();}}));}});
 const post=base_url=>new Request('http://fixture/api/panel-models',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'discover',base_url,api_key:'sensitive-discovery-key'})});
 let response=await service.handle(post('http://models.example/v1'),'/api/panel-models',()=>true);assert.equal(response.status,400);assert.equal(calls,0);
 response=await service.handle(post('https://models.example/v1'),'/api/panel-models',()=>true);const body=await response.json();assert.equal(response.status,400);assert.match(body.error,/大小限制/);assert.equal(JSON.stringify(body).includes('sensitive-discovery-key'),false);assert.equal(calls,1);
});
import fs from 'node:fs';import vm from 'node:vm';
test('Monitor sends default request without pinning primary and never retries agent failure',async()=>{
 const source=fs.readFileSync(new URL('../../../app/server/monitor.js',import.meta.url),'utf8'),start=source.indexOf('async function chatRequest('),end=source.indexOf('// ─── 辅助：',start);let calls=[];
 const sandbox={GATEWAY_API:'http://gateway.local/v1',MONITOR_TOKEN:'fixture',resolveProviderBase:()=> 'http://gateway.local/v1',log:()=>{},fetch:async(url,init)=>{calls.push({url,body:JSON.parse(init.body)});return {ok:false,status:502,text:async()=> 'fixture-failure'};}};
 vm.createContext(sandbox);vm.runInContext(source.slice(start,end),sandbox);
 await assert.rejects(sandbox.chatRequest(resolveModelRoutes(config)[0],null,[],null),/502/);assert.equal(calls.length,1);assert.equal(calls[0].body.provider,undefined);assert.equal(calls[0].body.model,undefined);
 calls=[];await assert.rejects(sandbox.chatRequest(resolveModelRoutes(config,{provider:'one',model:'a'})[0],null,[],null));assert.equal(calls[0].body.provider,'custom:one');assert.equal(calls[0].body.model,'a');assert.equal(calls.length,1);
});

test('legacy model-only selections resolve uniquely or fail instead of using default',()=>{assert.equal(resolveModelRoutes(config,{model:'a'})[0].gatewayProvider,'custom:one');assert.throws(()=>resolveModelRoutes(config,{model:'missing'}));const duplicates={...config,providers:[...config.providers,{id:'other',name:'other',enabled:true,models:[{id:'a',enabled:true}]}]};assert.throws(()=>resolveModelRoutes(duplicates,{model:'a'}));});
