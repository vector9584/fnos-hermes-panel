import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'panel-workspace-test-'));
process.env.DATA_DIR=path.join(root,'data');process.env.VAR_DIR=path.join(root,'var');process.env.APP_DIR=path.dirname(new URL(import.meta.url).pathname);
fs.mkdirSync(path.join(process.env.VAR_DIR,'chat/sessions'),{recursive:true});
fs.writeFileSync(path.join(process.env.VAR_DIR,'chat/sessions/a.json'),'{}');fs.writeFileSync(path.join(process.env.VAR_DIR,'chat/sessions/b.json'),'{}');
const backend=fs.existsSync(new URL('./panel-workspace.js',import.meta.url))?new URL('./panel-workspace.js',import.meta.url):new URL('../../../app/server/panel-workspace.js',import.meta.url);
const {handleWorkspace,sessionSystem,sessionIdentity}=await import(backend);
async function call(route='',method='GET',body,auth=true){let res=await handleWorkspace(new Request('http://test/api/workspace-ui'+route,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined}),()=>auth);return {status:res.status,...await res.json()};}
try{
 assert.equal((await call('/folders','POST',{name:'拒绝'},false)).status,401);
 let parent=(await call('/folders','POST',{name:'项目'})).folder,child=(await call('/folders','POST',{name:'子项目',parent_id:parent.id})).folder;
 assert.equal((await call('/folders','PUT',{id:parent.id,name:'项目',parent_id:child.id})).status,400);
 assert.equal((await call('/session','PUT',{id:'../escape',folder_id:child.id})).status,400);
 assert.equal((await call('/session','PUT',{id:'a',folder_id:child.id,expert:{id:'test',name:'代码 专家',emoji:'🔧',prompt:'只输出测试',skills:['terminal']}})).ok,true);
 assert.match(sessionSystem('a','BASE'),/BASE.*|【专家角色】代码 专家/s);assert.match(sessionSystem('a'),/只输出测试/);assert.equal(sessionSystem('b','BASE'),'BASE');assert.equal(sessionIdentity('a').sender,'代码 专家');
 const frozen=sessionIdentity('a');await call('/session','PUT',{id:'a',expert:null});assert.equal(frozen.sender,'代码 专家');assert.equal(sessionIdentity('a').sender_kind,'default');
 await call('/folders','DELETE',{id:child.id});assert.equal((await call()).sessions.a.folder_id,parent.id);
 await call('/folders','DELETE',{id:parent.id});assert.equal((await call()).sessions.a.folder_id,'');
 await call('/preferences','PUT',{identity:{user_name:'测试 <用户>',assistant_name:'助手甲'},voice:{engine:'system'},favorites:['abc']});
 const onDisk=JSON.parse(fs.readFileSync(path.join(process.env.VAR_DIR,'panel-state/workspace.json')));assert.equal(onDisk.identity.user_name,'测试 <用户>');assert.equal(onDisk.voice.engine,'system');assert.equal(sessionIdentity('b').sender,'助手甲');assert(!fs.existsSync(path.join(process.env.DATA_DIR,'panel-workspace.json')));
 assert.equal((await call('/preferences','PUT',{voice:{engine:'garbage'}})).status,400);
 assert.equal((await call('/speak','POST',{text:'a'.repeat(16001)})).status,413);
 console.log('PASS: auth, nested folders/cycles/deletion, conversation role isolation, identity snapshot, preferences persistence, speech limits');
}finally{fs.rmSync(root,{recursive:true,force:true});}
