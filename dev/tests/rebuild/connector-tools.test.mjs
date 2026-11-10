import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createConnectorToolsHandler} from '../../../app/server/panel-connector-tools.js';
const connector={kind:'fixture',fields:[{key:'token'}],impl:{callTool(){}},tools:[{name:'search',inputSchema:{type:'object',properties:{query:{type:'string'},limit:{type:'integer'}},required:['query']}}]};
function setup(){let calls=0;const handler=createConnectorToolsHandler({getConnector:kind=>kind==='fixture'?connector:null,readState:()=>({fixture:{token:'secret'}}),checkToken:req=>req.headers.get('x-monitor-token')==='yes',call:async(kind,creds,name,args)=>{calls++;return JSON.stringify({name,args});}});return {handler,calls:()=>calls};}
async function call(handler,path,body,auth=true){const response=await handler(new Request('http://local'+path,{method:'POST',headers:auth?{'X-Monitor-Token':'yes'}:{},body:JSON.stringify(body)}),path);return {status:response.status,body:response.status===202?null:await response.json()};}
test('REST and MCP enforce credentials and identical tool schemas before provider calls',async()=>{
 const f=setup();
 for(const rpc of [false,true]){
  const path=rpc?'/mcp-proxy/fixture':'/api/connectors/fixture/call';
  const body=args=>rpc?{id:1,method:'tools/call',params:{name:'search',arguments:args}}:{tool:'search',args};
  assert.equal((await call(f.handler,path,body({query:'ok'}),false)).status,401);
  for(const args of [{},{query:'ok',limit:'10'},{query:'ok',shell:'bad'},{query:' '},{query:'ok',limit:1.5}]){
   const response=await call(f.handler,path,body(args));assert.equal(rpc?response.body.result.isError:response.status,rpc?true:400);
  }
  const result=await call(f.handler,path,body({query:'safe',limit:3}));assert.equal(result.status,200);assert.equal(rpc?result.body.result.isError:!result.body.ok, rpc?undefined:false);
 }
 assert.equal(f.calls(),2);
});
test('MCP initialize/list/ping and notifications retain protocol behavior without invoking provider',async()=>{
 const f=setup(),path='/mcp-proxy/fixture';
 assert.equal((await call(f.handler,path,{method:'notifications/initialized'})).status,202);
 const init=await call(f.handler,path,{id:1,method:'initialize'});assert.equal(init.body.result.protocolVersion,'2024-11-05');
 const list=await call(f.handler,path,{id:2,method:'tools/list'});assert.deepEqual(list.body.result.tools[0].inputSchema.required,['query']);
 assert.equal((await call(f.handler,path,{id:3,method:'ping'})).status,200);assert.equal(f.calls(),0);
});
test('generated MCP bridge reads latest token for every request and forwards without embedding secret',async()=>{
 const source=readFileSync(new URL('../../../app/server/monitor.js',import.meta.url),'utf8');let script;
 const start=source.indexOf('function _ensureMcpBridgeScript()'),end=source.indexOf('\n}\n',start)+3;
 vm.runInNewContext(source.slice(start,end)+'\n_ensureMcpBridgeScript();',{TOKEN_FILE:'/fixture/monitor.token',MCP_BRIDGE_SCRIPT:'/fixture/bridge.js',writeFileSync:(path,value)=>{script=value;},log:()=>{}});
 assert.match(script,/readFileSync\(tokenFile/);assert.doesNotMatch(script,/fixture-secret/);
 let current='first',handler,headers=[],output=[];
 const http={request:(opts,callback)=>{headers.push(opts.headers);let events={};const res={on:(name,fn)=>{events[name]=fn;}};callback(res);return {on(){},write(){},end(){events.data(Buffer.from('{"result":{}}'));events.end();}};}};
 const process={argv:['node','bridge','fixture','8650'],stdin:{setEncoding(){},on:(event,fn)=>{if(event==='data')handler=fn;}},stdout:{write:value=>output.push(value)},exit(){}};
 vm.runInNewContext(script,{require:name=>name==='http'?http:{readFileSync:()=>current},process,URL,Buffer,Promise});
 handler('{"id":1,"method":"ping"}\n');await new Promise(resolve=>setImmediate(resolve));current='second';handler('{"id":2,"method":"ping"}\n');await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(headers.map(value=>value['X-Monitor-Token']),['first','second']);assert.equal(output.length,2);
});
