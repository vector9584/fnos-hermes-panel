import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {configTransaction,configReaderWriter,configRequestContext} from '../../../app/server/panel-config-txn.js';

test('config transaction errors are propagated without exposing subprocess output',()=>{
 const opts={python:'python',serverRoot:'/app',state:'/state',file:'/config',body:{action:'patch'}};
 assert.throws(()=>configTransaction({...opts,run:()=>({stdout:'secret invalid output'})}),e=>e.status===503&&!e.message.includes('secret'));
 assert.throws(()=>configTransaction({...opts,run:()=>({stdout:JSON.stringify({ok:false,error:'配置冲突',status:409})})}),e=>e.status===409);
 assert.equal(configTransaction({...opts,run:()=>({stdout:JSON.stringify({ok:true,changed:false})})}).changed,false);
});
test('overlapping custom requests retain their own original config snapshot',async t=>{
 const root=fs.mkdtempSync(join(tmpdir(),'config-request-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const file=join(root,'config.yaml');fs.writeFileSync(file,'model: a');const calls=[];
 const rw=configReaderWriter({getFile:()=>file,python:'python',serverRoot:root,state:root,run:(bin,args,opts)=>{calls.push(JSON.parse(opts.input));return {stdout:'{"ok":true}'};}});
 let resume;const pending=configRequestContext.run(new Map(),async()=>{rw.read();await new Promise(r=>resume=r);rw.write('model: request-a');});
 fs.writeFileSync(file,'model: b');configRequestContext.run(new Map(),()=>{rw.read();rw.write('model: request-b');});resume();await pending;
 assert.equal(calls[0].before,'model: b');assert.equal(calls[1].before,'model: a');assert.equal(calls[1].after,'model: request-a');
});
