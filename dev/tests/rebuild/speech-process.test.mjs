import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,existsSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {runSpeechProcess} from '../../../app/server/panel-speech-process.js';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function waitFor(fn){for(let i=0;i<100;i++){if(fn())return;await delay(20);}assert.fail('fixture condition timed out');}
function alive(pid){try{if(process.platform==='linux'){const raw=readFileSync('/proc/'+pid+'/stat','utf8');if(['Z','X'].includes(raw.slice(raw.lastIndexOf(')')+2).split(' ')[0]))return false;}process.kill(pid,0);return true;}catch{return false;}}
test('cancellation kills only the synthesis process group including its descendant',{skip:process.platform==='win32'},async t=>{
 const root=mkdtempSync(join(tmpdir(),'speech-group-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const pids=join(root,'pids');
 const unrelated=spawn(process.execPath,['-e','setInterval(()=>{},1000)']);t.after(()=>unrelated.kill('SIGKILL'));
 const script="const {spawn}=require('node:child_process'),fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});fs.writeFileSync(process.argv[1],JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);";
 const controller=new AbortController();const pending=runSpeechProcess(process.execPath,['-e',script,pids],{signal:controller.signal});const rejected=assert.rejects(pending,e=>e.name==='AbortError');await waitFor(()=>existsSync(pids));const [parent,child]=JSON.parse(readFileSync(pids));assert.ok(alive(parent)&&alive(child));controller.abort();await rejected;await waitFor(()=>!alive(parent)&&!alive(child));assert.ok(alive(unrelated.pid));
});
test('deadline, output limit, launch failure and successful completion are distinct',async()=>{
 await assert.rejects(runSpeechProcess(process.execPath,['-e','setInterval(()=>{},1000)'],{timeout:40}),e=>e.killed===true);
 await assert.rejects(runSpeechProcess(process.execPath,['-e',"process.stdout.write('x'.repeat(10000));setInterval(()=>{},1000)"],{maxBuffer:100}),e=>e.killed===false);
 await assert.rejects(runSpeechProcess('/not/a/real/speech-program',[]),e=>e.code==='ENOENT');
 assert.equal((await runSpeechProcess(process.execPath,['-e',"process.stdout.write('done')"])).stdout,'done');
});
test('parent exit also cleans a descendant that retains its output pipes',{skip:process.platform==='win32'},async t=>{
 const root=mkdtempSync(join(tmpdir(),'speech-orphan-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const file=join(root,'pid');
 await runSpeechProcess(process.execPath,['-e',"const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});require('node:fs').writeFileSync(process.argv[1],String(c.pid));c.unref();",file],{timeout:3000});const pid=Number(readFileSync(file));await waitFor(()=>!alive(pid));
});
