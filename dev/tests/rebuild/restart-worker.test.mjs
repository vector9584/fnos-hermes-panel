import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {existsSync} from 'node:fs';
import {createRestartWorker} from '../../../app/server/panel-restart-worker.js';
const stat=(start,state='S')=>'123 (name with ) parentheses) '+[state,...Array(18).fill('0'),String(start)].join(' ');
test('restart worker distinguishes live incarnation, exit, PID reuse and inaccessible state',()=>{
 let value=stat(123);const worker=createRestartWorker({io:{readFileSync:()=>{if(value instanceof Error)throw value;return value;}}});const saved=worker.capture(123);assert.equal(saved.start,'123');assert.equal(worker.observe(saved).state,'running');value=stat(124);assert.equal(worker.observe(saved).state,'exited');value=Object.assign(Error('denied'),{code:'EACCES'});assert.equal(worker.observe(saved).state,'unverified');value=Object.assign(Error('gone'),{code:'ENOENT'});assert.equal(worker.observe(saved).state,'exited');value=stat(123,'Z');assert.equal(worker.observe(saved).state,'exited');assert.equal(worker.observe({pid:123}).state,'unverified');
});
test('real child remains running across a fresh observer and exits without signaling another process',{skip:!existsSync('/proc/self/stat')},async t=>{
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();});await once(child,'spawn');const worker=createRestartWorker(),saved=worker.capture(child.pid);assert.equal(saved.state,'running');assert.equal(createRestartWorker().observe(saved).state,'running');const exited=once(child,'exit');child.kill();await exited;assert.equal(worker.observe(saved).state,'exited');
});
