import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createConnectorProbeHandler} from '../../../app/server/panel-connector-probe.js';
const connector={kind:'fixture',fields:[{key:'token'},{key:'account'}],impl:{probeCredentials(){}}};
test('probe merges blank credentials in memory without changing saved state',async()=>{
 const state={fixture:{token:'existing-secret',account:'old'}};let used;
 const handler=createConnectorProbeHandler({checkToken:()=>true,getConnector:()=>connector,readState:()=>state,probe:async(kind,creds)=>{used={kind,creds};}});
 const response=await handler(new Request('http://local/api/connectors/fixture/probe',{method:'POST',body:JSON.stringify({token:'',account:'new'})}),'/api/connectors/fixture/probe');
 assert.equal(response.status,200);assert.deepEqual(used,{kind:'fixture',creds:{token:'existing-secret',account:'new'}});assert.deepEqual(state,{fixture:{token:'existing-secret',account:'old'}});
 assert.ok(!(await response.text()).includes('existing-secret'));
});
test('unauthorized, unsupported and incomplete probes never call remote service; errors redact credential output',async()=>{
 let calls=0;
 for(const scenario of ['unauthorized','remote','missing','failure']){
  const handler=createConnectorProbeHandler({checkToken:()=>scenario!=='unauthorized',getConnector:()=>scenario==='remote'?{...connector,impl:null}:connector,readState:()=>({}),probe:async()=>{calls++;throw Error('secret-token');}});
  const response=await handler(new Request('http://local/api/connectors/fixture/probe',{method:'POST',body:JSON.stringify(scenario==='missing'?{}:{token:'secret-token',account:'fixture'})}),'/api/connectors/fixture/probe');
  assert.equal(response.status,{unauthorized:401,remote:422,missing:400,failure:502}[scenario]);assert.ok(!(await response.text()).includes('secret-token'));
 }
 assert.equal(calls,1);
});
