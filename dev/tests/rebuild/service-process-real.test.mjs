import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {spawn} from 'node:child_process';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createServiceProcesses} from '../../../app/server/panel-service-process.js';
test('real isolated process stops gracefully while unrelated process remains alive',{skip:process.platform!=='linux'||!process.env.TEST_PYTHON},async t=>{
 const root=fs.mkdtempSync(join(tmpdir(),'service-real-')),script=join(root,'hermes'),otherScript=join(root,'other'),python=process.env.TEST_PYTHON;
 fs.writeFileSync(script,'import time\nwhile True: time.sleep(0.1)\n');fs.copyFileSync(script,otherScript);
 const child=spawn(python,[script,'gateway','run'],{stdio:'ignore'}),other=spawn(python,[otherScript,'gateway','run'],{stdio:'ignore'});
 t.after(()=>{for(const p of [child,other])if(p.exitCode===null)p.kill('SIGKILL');fs.rmSync(root,{recursive:true,force:true});});
 await Promise.all([new Promise((r,j)=>{child.once('spawn',r);child.once('error',j);}),new Promise((r,j)=>{other.once('spawn',r);other.once('error',j);})]);
 const pidFiles={gateway:join(root,'gateway.pid'),dashboard:join(root,'dashboard.pid')};fs.writeFileSync(pidFiles.gateway,String(child.pid));
 const manager=createServiceProcesses({hermesBin:script,venvBin:dirname(python),pidFiles});assert.equal(manager.read('gateway').pid,child.pid);assert.equal(manager.identity(other.pid,'gateway'),null);
 const result=await manager.stop('gateway');assert.equal(result.ok,true);assert.equal(fs.existsSync(pidFiles.gateway),false);assert.equal(other.exitCode,null);process.kill(other.pid,0);
});
