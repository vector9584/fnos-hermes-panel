import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {envReaderWriter,envTransaction,channelConfigWriter} from '../../../app/server/panel-env-txn.js';
import {configRequestContext} from '../../../app/server/panel-config-txn.js';
test('env operations keep subprocess diagnostics secret and report failure',()=>{
 const options={python:'python',serverRoot:'/fixture',state:'/fixture',file:'/fixture/.env',body:{action:'set',key:'KEY',value:'secret'}};
 assert.throws(()=>envTransaction({...options,run:()=>({stdout:'private subprocess stderr'})}),e=>e.status===503&&!e.message.includes('private'));
 assert.throws(()=>envTransaction({...options,run:()=>({stdout:'{"ok":false,"error":"凭证冲突","status":409}'})}),e=>e.status===409);
});
test('channel save stages both texts and submits once, with no partial writes on errors',t=>{
 const root=fs.mkdtempSync(join(tmpdir(),'panel-channel-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const file=join(root,'config.yaml'),env=join(root,'.env'),calls=[];fs.writeFileSync(file,'model: first');fs.writeFileSync(env,'KEY=first');
 const rw=channelConfigWriter({python:'python',serverRoot:root,state:root,getConfig:()=>file,getEnv:()=>env,run:(bin,args,options)=>{calls.push(JSON.parse(options.input));return {stdout:'{"ok":true,"changed":true,"change_id":"fixture"}'};}});
 const result=rw.run(()=>{assert.equal(rw.read('yaml'),'model: first');rw.write('env','KEY=next');rw.write('yaml','model: next');assert.equal(fs.readFileSync(env,'utf8'),'KEY=first');return {ok:true};});assert.equal(result.restart_required,true);assert.equal(calls.length,1);assert.equal(calls[0].env_before,'KEY=first');assert.equal(calls[0].after,'model: next');assert.equal(rw.active,false);
 assert.throws(()=>rw.run(()=>{rw.write('env','KEY=bad');throw Error('fixture failure');}));assert.equal(calls.length,1);assert.equal(rw.active,false);assert.equal(fs.readFileSync(env,'utf8'),'KEY=first');
});
test('env requests preserve their own read snapshot and missing file is explicit',async t=>{
 const root=fs.mkdtempSync(join(tmpdir(),'panel-env-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const file=join(root,'.env'),calls=[];
 const rw=envReaderWriter({python:'python',serverRoot:root,state:root,getFile:()=>file,run:(bin,args,options)=>{calls.push(JSON.parse(options.input));return {stdout:'{"ok":true}'};}});
 assert.throws(()=>rw.write('KEY=a'),e=>e.status===409);assert.equal(rw.read(),'');fs.writeFileSync(file,'KEY=first');let resume;
 const waiting=configRequestContext.run(new Map(),async()=>{rw.read();await new Promise(r=>resume=r);rw.write('KEY=changed-first');});
 fs.writeFileSync(file,'KEY=second');configRequestContext.run(new Map(),()=>{rw.read();rw.write('KEY=changed-second');});resume();await waiting;
 assert.equal(calls[0].before,'KEY=second');assert.equal(calls[1].before,'KEY=first');
});
