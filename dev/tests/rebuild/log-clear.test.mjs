import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {LogClearStore} from '../../../app/server/panel-log-clear.js';

test('log clear saves a checked snapshot and undo appends original bytes once', t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hermes-log-clear-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const data=path.join(root,'data'),vars=path.join(root,'var');fs.mkdirSync(path.join(data,'logs'),{recursive:true});fs.mkdirSync(vars,{recursive:true});
 const log=path.join(data,'logs','gateway.log');fs.writeFileSync(log,'old line\n');
 const store=new LogClearStore({dataDir:data,varDir:vars,now:()=>1700000000000,id:()=> 'a'.repeat(32)});
 const cleared=store.clear('gateway.log');assert.equal(cleared.ok,true);assert.equal(cleared.bytes,9);assert.equal(fs.readFileSync(log,'utf8'),'');
 assert.deepEqual(store.pending().map(item=>item.id),[cleared.undo_id]);
 fs.appendFileSync(log,'new line\n');const originalAppend=fs.appendFileSync.bind(fs);let failMarkerOnce=true;
 const io=Object.create(fs);io.appendFileSync=(file,data,...args)=>{if(failMarkerOnce&&String(data).includes('已恢复日志撤销记录')){failMarkerOnce=false;throw Error('marker write failed');}return originalAppend(file,data,...args);};
 const restoreStore=new LogClearStore({dataDir:data,varDir:vars,io,now:()=>1700000000000,id:()=> 'a'.repeat(32)});
 assert.throws(()=>restoreStore.restore(cleared.undo_id),/marker write failed/);assert.equal(JSON.parse(fs.readFileSync(path.join(vars,'panel-state/log-clear',cleared.undo_id+'.json'),'utf8')).restored_at,null);
 const restored=store.restore(cleared.undo_id);
 assert.deepEqual(store.pending(),[]);
 assert.equal(restored.file,'gateway.log');assert.equal(fs.readFileSync(log,'utf8'),`new line\n\n--- 已恢复日志撤销记录 ${cleared.undo_id} · gateway.log · 2023-11-14T22:13:20.000Z ---\nold line\n`);
 assert.throws(()=>store.restore(cleared.undo_id),/已恢复或不存在/);
});

test('log clear rejects paths and refuses a corrupt undo snapshot without touching the log', t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hermes-log-clear-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const data=path.join(root,'data'),vars=path.join(root,'var');fs.mkdirSync(path.join(data,'logs'),{recursive:true});fs.mkdirSync(vars,{recursive:true});
 const log=path.join(data,'logs','agent.log');fs.writeFileSync(log,'private original');
 const store=new LogClearStore({dataDir:data,varDir:vars,id:()=> 'b'.repeat(32)});
 assert.throws(()=>store.clear('../config.yaml'),/disallowed/);
 const cleared=store.clear('agent.log');fs.writeFileSync(path.join(vars,'panel-state/log-clear',cleared.undo_id+'.log'),'tampered');
 fs.appendFileSync(log,'new data');assert.throws(()=>store.restore(cleared.undo_id),/快照校验失败/);assert.equal(fs.readFileSync(log,'utf8'),'new data');
});

test('undo resumes a partial append after its marker without duplicating bytes',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hermes-log-clear-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const data=path.join(root,'data'),vars=path.join(root,'var');fs.mkdirSync(path.join(data,'logs'),{recursive:true});fs.mkdirSync(vars,{recursive:true});
 const log=path.join(data,'logs','gateway.log');fs.writeFileSync(log,'original log\n');
 const store=new LogClearStore({dataDir:data,varDir:vars,now:()=>1700000000000,id:()=> 'c'.repeat(32)}),cleared=store.clear('gateway.log');fs.appendFileSync(log,'new lines\n');
 const originalAppend=fs.appendFileSync.bind(fs);let partialOnce=true;
 const io=Object.create(fs);io.appendFileSync=(file,value,...args)=>{if(partialOnce&&Buffer.from(value).toString().includes('original log')){partialOnce=false;originalAppend(file,Buffer.from(value).subarray(0,8),...args);throw Error('partial append');}return originalAppend(file,value,...args);};
 const interrupted=new LogClearStore({dataDir:data,varDir:vars,io,now:()=>1700000000001});
 assert.throws(()=>interrupted.restore(cleared.undo_id),/partial append/);assert.equal(interrupted.pending().length,1);
 interrupted.restore(cleared.undo_id);assert.equal(fs.readFileSync(log,'utf8'),`new lines\n\n--- 已恢复日志撤销记录 ${cleared.undo_id} · gateway.log · 2023-11-14T22:13:20.000Z ---\noriginal log\n`);assert.equal(interrupted.pending().length,0);
});

test('undo completes a marker interrupted during its append before restoring snapshot',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hermes-log-clear-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const data=path.join(root,'data'),vars=path.join(root,'var');fs.mkdirSync(path.join(data,'logs'),{recursive:true});fs.mkdirSync(vars,{recursive:true});
 const log=path.join(data,'logs','gateway.log');fs.writeFileSync(log,'original log\n');
 const store=new LogClearStore({dataDir:data,varDir:vars,now:()=>1700000000000,id:()=> 'e'.repeat(32)}),cleared=store.clear('gateway.log');fs.appendFileSync(log,'new lines\n');
 const originalAppend=fs.appendFileSync.bind(fs);let partialOnce=true;
 const io=Object.create(fs);io.appendFileSync=(file,value,...args)=>{if(partialOnce&&String(value).includes('已恢复日志撤销记录')){partialOnce=false;originalAppend(file,Buffer.from(value).subarray(0,12),...args);throw Error('partial marker');}return originalAppend(file,value,...args);};
 const interrupted=new LogClearStore({dataDir:data,varDir:vars,io,now:()=>1700000000001});assert.throws(()=>interrupted.restore(cleared.undo_id),/partial marker/);
 interrupted.restore(cleared.undo_id);assert.equal(fs.readFileSync(log,'utf8'),`new lines\n\n--- 已恢复日志撤销记录 ${cleared.undo_id} · gateway.log · 2023-11-14T22:13:20.000Z ---\noriginal log\n`);assert.equal(interrupted.pending().length,0);
});

test('failed before truncate removes snapshot when original bytes are intact',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hermes-log-clear-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const data=path.join(root,'data'),vars=path.join(root,'var');fs.mkdirSync(path.join(data,'logs'),{recursive:true});fs.mkdirSync(vars,{recursive:true});
 const log=path.join(data,'logs','gateway.log');fs.writeFileSync(log,'still present\n');
 const base=Object.create(fs);base.writeFileSync=(file,value,options)=>{if(file===log)throw Error('truncate failed');return fs.writeFileSync(file,value,options);};
 const store=new LogClearStore({dataDir:data,varDir:vars,io:base,id:()=> 'd'.repeat(32)});
 assert.throws(()=>store.clear('gateway.log'),/truncate failed/);assert.equal(fs.readFileSync(log,'utf8'),'still present\n');assert.deepEqual(store.pending(),[]);assert.equal(fs.existsSync(path.join(vars,'panel-state/log-clear','d'.repeat(32)+'.log')),false);assert.equal(fs.existsSync(path.join(vars,'panel-state/log-clear','d'.repeat(32)+'.json')),false);
});

test('truncate that changes the log then throws retains a usable undo record',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hermes-log-clear-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const data=path.join(root,'data'),vars=path.join(root,'var');fs.mkdirSync(path.join(data,'logs'),{recursive:true});fs.mkdirSync(vars,{recursive:true});
 const log=path.join(data,'logs','gateway.log');fs.writeFileSync(log,'must not be lost\n');const actual=fs.writeFileSync.bind(fs);let failAfterChange=true;
 const io=Object.create(fs);io.writeFileSync=(file,value,options)=>{actual(file,value,options);if(file===log&&failAfterChange){failAfterChange=false;throw Error('reported truncate failure after changing bytes');}};
 const store=new LogClearStore({dataDir:data,varDir:vars,io,id:()=> 'f'.repeat(32)});
 assert.throws(()=>store.clear('gateway.log'),/reported truncate failure/);assert.equal(fs.readFileSync(log,'utf8'),'');assert.deepEqual(store.pending().map(item=>item.clear_state),['cleared']);
 store.restore('f'.repeat(32));assert.equal(fs.readFileSync(log,'utf8'),'must not be lost\n');assert.deepEqual(store.pending(),[]);
});

test('partial truncate failure keeps snapshot and refuses unsafe automatic restoration',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hermes-log-clear-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const data=path.join(root,'data'),vars=path.join(root,'var');fs.mkdirSync(path.join(data,'logs'),{recursive:true});fs.mkdirSync(vars,{recursive:true});
 const log=path.join(data,'logs','gateway.log');fs.writeFileSync(log,'0123456789 original tail\n');const actual=fs.writeFileSync.bind(fs);let failAfterChange=true;
 const io=Object.create(fs);io.writeFileSync=(file,value,options)=>{if(file===log&&failAfterChange){failAfterChange=false;actual(file,'partial',options);throw Error('partial truncate');}return actual(file,value,options);};
 const store=new LogClearStore({dataDir:data,varDir:vars,io,id:()=> '1'.repeat(32)});
 assert.throws(()=>store.clear('gateway.log'),/partial truncate/);assert.equal(fs.readFileSync(log,'utf8'),'partial');assert.deepEqual(store.pending().map(item=>item.clear_state),['uncertain']);
 assert.throws(()=>store.restore('1'.repeat(32)),/未能确认/);assert.equal(fs.readFileSync(log,'utf8'),'partial');assert.equal(fs.existsSync(path.join(vars,'panel-state/log-clear','1'.repeat(32)+'.log')),true);
});
