import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createRestartWorker,launchRestartWorker} from '../../../app/server/panel-restart-worker.js';
const linux=fs.existsSync('/proc/self/stat');
function setup(t){const keepAlive=setInterval(()=>{},1000);t.after(()=>clearInterval(keepAlive));const root=fs.mkdtempSync(join(tmpdir(),'restart-gate-'));fs.mkdirSync(join(root,'dev'));fs.writeFileSync(join(root,'dev/hermes-dev.sh'),'#!/bin/bash\nprintf "%s:%s" "$$" "$1" > invoked\nsleep 0.2\n');t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function gone(saved){const worker=createRestartWorker();for(let n=0;n<100;n++){if(worker.observe(saved).state==='exited')return;await pause(20);}throw Error('gate remained alive');}
test('official script executes only after durable identity and retains the observed PID',{skip:!linux},async t=>{
 const root=setup(t),worker=createRestartWorker();let saved,exit;
 const done=new Promise(r=>exit=r);
 const child=launchRestartWorker({start:spawn,source:root,fd:'ignore',worker,persist:identity=>{assert.equal(fs.existsSync(join(root,'invoked')),false);saved=identity;fs.writeFileSync(join(root,'identity'),JSON.stringify(identity));},onError:error=>assert.fail(error),onExit:code=>exit(code)});
 assert.equal(saved.pid,child.pid);assert.equal(await done,0);assert.equal(fs.readFileSync(join(root,'invoked'),'utf8'),child.pid+':restart');await gone(saved);
});
test('storage failure closes gate without invoking official script',{skip:!linux},async t=>{
 const root=setup(t);let saved,exit;const done=new Promise(r=>exit=r);
 assert.throws(()=>launchRestartWorker({start:spawn,source:root,fd:'ignore',worker:createRestartWorker(),persist:identity=>{saved=identity;throw Error('disk failure');},onError:()=>{},onExit:code=>exit(code)}),/disk failure/);
 assert.equal(await done,75);assert.equal(fs.existsSync(join(root,'invoked')),false);await gone(saved);
});
for(const mode of ['before-persist','after-persist'])test('Monitor death '+mode+' closes launch gate without invoking restart',{skip:!linux},async t=>{
 const root=setup(t),module=new URL('../../../app/server/panel-restart-worker.js',import.meta.url).href;
 const program=`import {spawn} from 'node:child_process';import * as fs from 'node:fs';import {createRestartWorker,launchRestartWorker} from ${JSON.stringify(module)};
 launchRestartWorker({start:spawn,source:${JSON.stringify(root)},fd:'ignore',worker:createRestartWorker(),persist:identity=>{fs.writeFileSync(${JSON.stringify(join(root,'observed'))},JSON.stringify(identity));if(${JSON.stringify(mode)}==='after-persist')fs.writeFileSync(${JSON.stringify(join(root,'identity'))},JSON.stringify(identity));process.kill(process.pid,'SIGKILL');},onError:()=>{},onExit:()=>{}});`;
 const monitor=spawn(process.execPath,['--input-type=module','-e',program],{stdio:['ignore','pipe','pipe']});let stderr='';monitor.stderr.on('data',b=>stderr+=b);const [code,signal]=await once(monitor,'exit');assert.equal(signal,'SIGKILL',stderr);assert.equal(code,null);
 const saved=JSON.parse(fs.readFileSync(join(root,'observed'),'utf8'));await gone(saved);assert.equal(fs.existsSync(join(root,'invoked')),false);assert.equal(fs.existsSync(join(root,'identity')),mode==='after-persist');
});
test('released script remains identifiable after Monitor death and finishes once',{skip:!linux},async t=>{
 const root=setup(t),module=new URL('../../../app/server/panel-restart-worker.js',import.meta.url).href;
 fs.writeFileSync(join(root,'dev/hermes-dev.sh'),'#!/bin/bash\nprintf "%s:%s\\n" "$$" "$1" >> invoked\nsleep 1\n');
 const program=`import {spawn} from 'node:child_process';import * as fs from 'node:fs';import {createRestartWorker,launchRestartWorker} from ${JSON.stringify(module)};
 const child=launchRestartWorker({start:spawn,source:${JSON.stringify(root)},fd:'ignore',worker:createRestartWorker(),persist:identity=>fs.writeFileSync(${JSON.stringify(join(root,'identity'))},JSON.stringify(identity)),onError:()=>{},onExit:()=>{}});child.stdin.once('finish',()=>process.kill(process.pid,'SIGKILL'));`;
 const monitor=spawn(process.execPath,['--input-type=module','-e',program],{stdio:['ignore','pipe','pipe']});let stderr='';monitor.stderr.on('data',b=>stderr+=b);const [,signal]=await once(monitor,'exit');assert.equal(signal,'SIGKILL',stderr);
 const saved=JSON.parse(fs.readFileSync(join(root,'identity'),'utf8'));assert.equal(createRestartWorker().observe(saved).state,'running');await gone(saved);assert.deepEqual(fs.readFileSync(join(root,'invoked'),'utf8').trim().split('\n'),[saved.pid+':restart']);
});
test('successful official script writes a request and worker-bound durable receipt',async t=>{
 const root=setup(t),app=join(root,'app'),varDir=join(root,'var');fs.mkdirSync(join(app,'server'),{recursive:true});fs.mkdirSync(varDir);
 const procRoot=join(root,'proc');fs.mkdirSync(procRoot);
 fs.copyFileSync(new URL('../../../app/server/panel_restart_receipt.py',import.meta.url),join(app,'server/panel_restart_receipt.py'));
 fs.copyFileSync(new URL('../../../app/server/panel_lifecycle.py',import.meta.url),join(app,'server/panel_lifecycle.py'));
 fs.copyFileSync(new URL('../../../app/server/panel_drain_store.py',import.meta.url),join(app,'server/panel_drain_store.py'));
 fs.writeFileSync(join(root,'dev/hermes-dev.sh'),'#!/bin/bash\nprintf "%s" "$1" > invoked\n');
 const requestId='11111111-1111-4111-8111-111111111111',worker={capture:pid=>({pid,start:'123456789',state:'running'}),observe:()=>({state:'exited'})};let saved;let finishExit;const done=new Promise(resolve=>{finishExit=resolve;});
 const log=fs.openSync(join(root,'worker.log'),'w');const child=launchRestartWorker({start:spawn,source:root,fd:log,worker,requestId,python:'python3',app,home:join(root,'home'),varDir,node:process.execPath,procRoot,persist:identity=>{saved=identity;const dir=join(procRoot,String(identity.pid));fs.mkdirSync(dir);fs.writeFileSync(join(dir,'stat'),'123 (fixture process) S '+[...Array(18).fill('0'),identity.start].join(' '));},onError:error=>assert.fail(error),onExit:status=>finishExit(status)});fs.closeSync(log);
 assert.equal(saved.pid,child.pid);assert.equal(await done,0,fs.readFileSync(join(root,'worker.log'),'utf8'));await gone(saved);
 const files=fs.readdirSync(join(varDir,'panel-state/restart-receipts'));assert.deepEqual(files,[requestId+'.json']);const receipt=JSON.parse(fs.readFileSync(join(varDir,'panel-state/restart-receipts',requestId+'.json'),'utf8'));
 assert.equal(receipt.request_id,requestId);assert.deepEqual(receipt.worker,{pid:saved.pid,start:saved.start});assert.equal(receipt.exit_code,0);assert.equal(fs.readFileSync(join(root,'invoked'),'utf8'),'restart');
});
