import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
test('global search reads latest room overlay and returns stable anchors including archived discussions',t=>{
 const root=mkdtempSync(join(tmpdir(),'room-search-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const home=join(root,'home'),variable=join(root,'var');mkdirSync(home);mkdirSync(join(variable,'panel-state/rooms'),{recursive:true});
 const legacy=[{id:'old',title:'原讨论',messages:[{text:'obsolete-marker',ts:1}]},{id:'legacy-only',title:'原始讨论',messages:[{text:'共同检索词 原始内容',ts:2}]}];const file=join(home,'rooms.json');writeFileSync(file,JSON.stringify(legacy));const before=readFileSync(file);
 writeFileSync(join(variable,'panel-state/rooms/old.json'),JSON.stringify({id:'old',title:'保留讨论',archived_at:5,messages:[{id:'stable-message',kind:'assistant',text:'共同检索词 新记录',ts:3}]}));
 const run=q=>JSON.parse(execFileSync('python3',['app/server/panel-search.py',home,variable,q],{encoding:'utf8'}));
 const results=run('共同检索词').results;assert.equal(results.length,2);assert.equal(results[0].message_id,'stable-message');assert.equal(results[0].session_id,'old');assert.equal(results[1].message_index,0);assert.equal(run('obsolete-marker').total,0);assert.deepEqual(readFileSync(file),before);
});
