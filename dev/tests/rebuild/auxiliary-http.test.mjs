import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createAuxiliaryHandler} from '../../../app/server/panel-auxiliary.js';
const path='/api/panel-models/auxiliary';
function fixture(mode='ok'){
 const calls=[];
 const handler=createAuxiliaryHandler({python:'fixture-python',serverRoot:'/fixture',getConfig:()=>'/fixture/config',backupRoot:'/fixture/backups',checkToken:req=>req.headers.get('x-monitor-token')==='test',start:(bin,args,options)=>{
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.kill=()=>{};
  let input='';child.stdin.on('data',b=>input+=b);child.stdin.on('end',()=>{calls.push({bin,args,options,input:JSON.parse(input)});queueMicrotask(()=>{
   if(mode==='error')child.emit('error',Error('secret must not escape'));
   else {child.stdout.write(mode==='invalid'?'bad':JSON.stringify(mode==='conflict'?{ok:false,error:'版本冲突',status:409}:{ok:true,tasks:[]}));child.emit('close',mode==='conflict'?1:0);}
  });});return child;
 }});
 const request=(method='GET',body,token=true)=>handler(new Request('http://fixture'+path,{method,headers:token?{'x-monitor-token':'test'}:{},body:body===undefined?undefined:JSON.stringify(body)}),path);
 return {request,calls};
}
test('auxiliary authentication and methods fail before process creation',async()=>{const f=fixture();assert.equal((await f.request('GET',undefined,false)).status,401);assert.equal((await f.request('DELETE')).status,405);assert.equal(f.calls.length,0);});
test('auxiliary launches isolated structured stdin and fixed script args',async()=>{const f=fixture();assert.equal((await f.request('PATCH',{key:'vision',revision:'abc',changes:{model:'two'}})).status,200);assert.deepEqual(f.calls[0].input,{key:'vision',revision:'abc',changes:{model:'two'},action:'update'});assert.deepEqual(f.calls[0].args,['-B','/fixture/panel-auxiliary.py','/fixture/config','/fixture/backups']);});
test('auxiliary propagates optimistic conflict and redacts subprocess errors',async()=>{assert.equal((await fixture('conflict').request('PATCH',{})).status,409);const error=await fixture('error').request();assert.equal(error.status,503);assert.ok(!(await error.text()).includes('secret'));assert.equal((await fixture('invalid').request()).status,502);});
