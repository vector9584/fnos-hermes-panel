import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConnectorStore,createConnectorHandler} from '../../../app/server/panel-connectors.js';
const cat={kind:'fixture',name:'测试连接器',fields:[{key:'token'}],impl:{probeCredentials(){}}};
function setup(t,options={}){
 const root=fs.mkdtempSync(join(tmpdir(),'connectors-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const legacy=join(root,'legacy.json');fs.writeFileSync(legacy,JSON.stringify({fixture:{token:'old'},other:{token:'preserve'}}));
 const original=fs.readFileSync(legacy);const store=new ConnectorStore(join(root,'var'),legacy);let probes=0,applies=0;
 const handler=createConnectorHandler({catalog:[cat],store,checkToken:req=>req.headers.get('x-monitor-token')==='yes',probe:async()=>{probes++;},apply:async()=>{applies++;},...options});
 const call=async(body,action='',method='POST')=>{const path='/api/connectors/fixture'+action;const response=await handler(new Request('http://fixture'+path,{method,headers:{'X-Monitor-Token':'yes'},body:body?JSON.stringify(body):undefined}),path);return {status:response.status,...await response.json()};};
 return {root,legacy,original,store,handler,call,counts:()=>({probes,applies})};
}
test('credentials stay in VAR, blank retains existing, undo and reconnect survive fresh store',async t=>{
 const f=setup(t),initial=f.store.get('fixture');
 let response=await f.call({revision:initial.revision,token:'new'});assert.equal(response.status,200);assert.equal(response.activation,'restart_requested');assert.equal(response.can_undo,true);assert.ok(!JSON.stringify(response).includes('"new"'));
 const reloaded=new ConnectorStore(join(f.root,'var'),f.legacy);assert.equal(reloaded.get('fixture').credentials.token,'new');assert.equal(reloaded.all().other.token,'preserve');
 assert.equal(fs.statSync(reloaded.file.file).mode&0o777,0o600);
 response=await f.call({revision:response.revision,token:''});assert.equal(f.store.get('fixture').credentials.token,'new');
 response=await f.call({revision:response.revision},'', 'DELETE');assert.equal(response.configured,false);assert.equal(f.store.all().fixture,undefined);
 response=await f.call({revision:response.revision},'/restore');assert.equal(response.configured,true);assert.equal(f.store.get('fixture').credentials.token,'new');
 assert.deepEqual(fs.readFileSync(f.legacy),f.original);
});
test('stale edit and simultaneous probe cannot overwrite newer credentials',async t=>{
 let resume;const f=setup(t,{probe:()=>new Promise(resolve=>resume=resolve)}),revision=f.store.get('fixture').revision;
 const pending=f.call({revision,token:'next'});await new Promise(resolve=>setImmediate(resolve));
 assert.equal((await f.call({revision,token:'other'})).status,409);resume();const response=await pending;assert.equal(response.status,200);
 assert.equal((await f.call({revision,token:'stale'})).status,409);assert.equal(f.store.get('fixture').credentials.token,'next');
});
test('probe and disk failures preserve credentials; apply failure is explicit and retryable',async t=>{
 const failure=setup(t,{probe:async()=>{throw Error('upstream secret');}}),revision=failure.store.get('fixture').revision;
 const rejected=await failure.call({revision,token:'new'});assert.equal(rejected.status,422);assert.equal(failure.store.get('fixture').credentials.token,'old');assert.equal(failure.counts().applies,0);
 const disk=setup(t);disk.store.file.write=()=>{throw Error('disk full');};assert.equal((await disk.call({revision:disk.store.get('fixture').revision,token:'next'})).status,500);assert.equal(disk.counts().applies,0);assert.equal(disk.store.get('fixture').credentials.token,'old');
 let fail=true;const apply=setup(t,{apply:async()=>{if(fail)throw Error('config unavailable');}});let response=await apply.call({revision:apply.store.get('fixture').revision,token:'saved'});
 assert.equal(response.status,503);assert.equal(response.saved,true);assert.equal(response.activation,'apply_failed');assert.equal(apply.store.get('fixture').credentials.token,'saved');
 fail=false;response=await apply.call({revision:response.revision},'/activate');assert.equal(response.status,200);assert.equal(response.activation,'restart_requested');
});
test('corrupt legacy state is not reset, and unauthorized reads cannot expose credential metadata',async t=>{
 const f=setup(t);fs.writeFileSync(f.legacy,'{bad');const response=await f.call(undefined,'','GET');assert.equal(response.status,503);assert.equal(fs.readFileSync(f.legacy,'utf8'),'{bad');assert.ok(!fs.existsSync(f.store.file.file));
 const path='/api/connectors';const denied=await f.handler(new Request('http://fixture'+path),path);assert.equal(denied.status,401);
});
