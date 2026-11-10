import test from 'node:test';
import {SessionDrafts} from '../../../app/server/panel-state.js';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {LibraryStore,createLibraryHandler} from '../../../app/server/panel-library.js';
function fixture(t){const root=fs.mkdtempSync(join(tmpdir(),'library-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const knowledge=join(root,'knowledge'),memory=join(root,'memory'),reports=join(root,'reports');for(const d of [knowledge,memory,reports])fs.mkdirSync(d);fs.writeFileSync(join(knowledge,'原知识.md'),'# 原文\n\n完整内容\n');fs.writeFileSync(join(memory,'MEMORY.md'),'长期记忆\n');fs.writeFileSync(join(reports,'REPORT.md'),'报告全文'.repeat(500));let active=memory;const store=new LibraryStore({root:join(root,'state'),sources:()=>[{id:'knowledge',name:'知识库',root:knowledge,editable:true},{id:'memory',name:'长期记忆',root:active,files:['MEMORY.md'],editable:true},{id:'reports',name:'维护报告',root:reports,editable:false}]});return {root,store,knowledge,memory,reports,switchProfile:()=>active=knowledge};}
test('full text search and read retain long report content and do not create or edit source files',t=>{
 const {store,reports}=fixture(t),before=fs.readFileSync(join(reports,'REPORT.md'));const found=store.catalog({query:'完整内容'});assert.equal(found.total,1);assert.equal(found.items[0].source,'knowledge');assert.equal(store.read('reports','REPORT.md').content,'报告全文'.repeat(500));assert.deepEqual(fs.readFileSync(join(reports,'REPORT.md')),before);assert.equal(store.catalog({source:'memory'}).total,1);
});
test('folder catalog filters by safe relative subtree and note graph resolves real wikilinks only',t=>{
 const f=fixture(t),nested=join(f.knowledge,'项目甲','子目录');fs.mkdirSync(nested,{recursive:true});fs.writeFileSync(join(f.knowledge,'项目甲','索引.md'),'[[子目录/实施方案|方案]] [[原知识]] [[不存在的笔记]]');fs.writeFileSync(join(nested,'实施方案.md'),'正文');
 const catalog=f.store.catalog({source:'knowledge',limit:5000});assert.ok(catalog.folders.includes('项目甲'));assert.ok(catalog.folders.includes('项目甲/子目录'));
 assert.deepEqual(f.store.catalog({source:'knowledge',folder:'项目甲'}).items.map(item=>item.path).sort(),['项目甲/子目录/实施方案.md','项目甲/索引.md']);
 const graph=f.store.graph();assert.deepEqual(graph.edges.sort((a,b)=>a.to.localeCompare(b.to)),[{from:'项目甲/索引.md',to:'原知识.md'},{from:'项目甲/索引.md',to:'项目甲/子目录/实施方案.md'}]);assert.equal(graph.nodes.length,3);
 assert.throws(()=>f.store.catalog({source:'knowledge',folder:'../'}),/资料目录不存在/);
});
test('save requires source and file revision, persists backup before commit, and undo preserves prior bytes',t=>{
 const {store,knowledge}=fixture(t),before=fs.readFileSync(join(knowledge,'原知识.md')),doc=store.read('knowledge','原知识.md');const saved=store.write({...doc,request_id:'change-one',content:'# 修改\n新资料'});assert.equal(saved.content,'# 修改\n新资料');const history=store.history('knowledge','原知识.md');assert.equal(history.length,1);assert.equal(history[0].status,'committed');assert.equal(history[0].can_undo,true);assert.equal(store.write({...doc,request_id:'change-one',content:'# 修改\n新资料'}).duplicate,true);
 assert.throws(()=>store.write({...doc,request_id:'stale',content:'会覆盖'}),e=>e.status===409);store.undo({change_id:'change-one',revision:saved.revision,request_id:'undo-one'});assert.deepEqual(fs.readFileSync(join(knowledge,'原知识.md')),before);
});
test('external updates or active profile changes reject stale editing and undo',t=>{
 const f=fixture(t),doc=f.store.read('memory','MEMORY.md');fs.writeFileSync(join(f.memory,'MEMORY.md'),'内核写入');assert.throws(()=>f.store.write({...doc,request_id:'one',content:'旧浏览器'}),e=>e.status===409);assert.equal(fs.readFileSync(join(f.memory,'MEMORY.md'),'utf8'),'内核写入');f.switchProfile();assert.throws(()=>f.store.write({...doc,request_id:'two',content:'不能写错环境'}),e=>e.status===409);
});
test('path escape, symlink escape, read-only report writes and invalid UTF8 are rejected',t=>{
 const f=fixture(t),{store}=f;fs.writeFileSync(join(f.root,'secret.md'),'private');fs.symlinkSync(join(f.root,'secret.md'),join(f.knowledge,'outside.md'));assert.throws(()=>store.read('knowledge','../secret.md'));assert.throws(()=>store.read('knowledge','outside.md'),e=>e.status===403);assert.throws(()=>store.read('memory','other.md'));assert.throws(()=>store.write({...store.read('reports','REPORT.md'),request_id:'bad',content:'overwrite'}),e=>e.status===403);fs.writeFileSync(join(f.knowledge,'invalid.md'),Buffer.from([0xff,0xfe]));assert.throws(()=>store.read('knowledge','invalid.md'),e=>e.status===415);assert.equal(store.catalog({source:'knowledge'}).issues.length,1);
});
test('backup failure leaves original unchanged; repeated new-document requests do not overwrite later edits',t=>{
 const f=fixture(t),doc=f.store.read('knowledge','原知识.md'),before=fs.readFileSync(join(f.knowledge,'原知识.md'));fs.mkdirSync(f.store.root,{recursive:true});fs.writeFileSync(join(f.store.root,'library-history'),'blocked');assert.throws(()=>f.store.write({...doc,request_id:'one',content:'should not commit'}));assert.deepEqual(fs.readFileSync(join(f.knowledge,'原知识.md')),before);
});
test('new files use explicit absent revision and preserve existing documents; read endpoints require authentication',async t=>{
 const {store}=fixture(t),doc=store.read('knowledge','新目录/新笔记.md',{allowMissing:true});assert.equal(doc.exists,false);const saved=store.write({...doc,request_id:'new-one',content:'新笔记'});assert.equal(saved.exists,true);assert.equal(store.history('knowledge',doc.path)[0].can_undo,false);
 const denied=createLibraryHandler({store,checkToken:()=>false});assert.equal((await denied(new Request('http://fixture/api/panel-library'),'/api/panel-library')).status,401);
 const handler=createLibraryHandler({store,checkToken:()=>true});const response=await handler(new Request('http://fixture/api/panel-library/download?source=knowledge&path='+encodeURIComponent(doc.path)),'/api/panel-library/download');assert.equal(await response.text(),'新笔记');
});
const {LibraryReviews,createLibraryReviewHandler}=await import('../../../app/server/panel-library-reviews.js');
async function ready(reviews,id){for(let i=0;i<200&&reviews.get(id).status==='running';i++)await new Promise(r=>setTimeout(r,5));return reviews.get(id);}
test('memory review never mutates source until explicit apply; selected provenance and original backup are preserved',async t=>{
 const f=fixture(t),before=fs.readFileSync(join(f.memory,'MEMORY.md')),calls=[];
 const reviews=new LibraryReviews({root:join(f.root,'reviews'),library:f.store,source:async()=>({target:{name:'服务乙'}}),generate:async(target,options)=>{calls.push(options);return {output:'整理后的长期记忆\n',finish_reason:'stop'};}}).load();
 const body={request_id:'review-one',provider:'b',model:'same',sources:[{source:'knowledge',path:'原知识.md'}]};await reviews.create(body);await reviews.create(body);await ready(reviews,'review-one');assert.equal(calls.length,1);assert.match(calls[0].prompt,/完整内容/);assert.deepEqual(fs.readFileSync(join(f.memory,'MEMORY.md')),before);
 const result=reviews.apply('review-one',{request_id:'apply-one',content:'审阅后修改的记忆\n'});assert.equal(result.content,'审阅后修改的记忆\n');assert.equal(reviews.get('review-one').status,'applied');assert.equal(f.store.history('memory','MEMORY.md')[0].can_undo,true);
 f.store.undo({change_id:'apply-one',revision:result.revision,request_id:'undo-review'});assert.deepEqual(fs.readFileSync(join(f.memory,'MEMORY.md')),before);
});
test('memory review blocks changed references, truncated output and restart replay',async t=>{
 const f=fixture(t),options={root:join(f.root,'reviews'),library:f.store,source:async()=>({target:{name:'fixture'}}),generate:async()=>({output:'草稿',finish_reason:'stop'})};const reviews=new LibraryReviews(options).load();
 await reviews.create({request_id:'review-one',provider:'b',model:'same',sources:[{source:'knowledge',path:'原知识.md'}]});await ready(reviews,'review-one');fs.appendFileSync(join(f.knowledge,'原知识.md'),'新证据');assert.throws(()=>reviews.apply('review-one',{request_id:'apply-one',content:'草稿'}),e=>e.status===409);
 reviews.generate=async()=>({output:'截断片段',finish_reason:'length',usage:{input_tokens:10,output_tokens:5},response_model:'actual'});await reviews.create({request_id:'review-two',provider:'b',model:'same',sources:[]});assert.equal((await ready(reviews,'review-two')).status,'failed');assert.equal(fs.readFileSync(join(f.memory,'MEMORY.md'),'utf8'),'长期记忆\n');
 assert.deepEqual(reviews.get('review-two').usage,{input_tokens:10,output_tokens:5});assert.equal(reviews.get('review-two').response_model,'actual');
 const saved=reviews.get('review-two');reviews.persist({...saved,id:'review-three',status:'running'});const restarted=new LibraryReviews({...options,generate:()=>assert.fail('must not replay')}).load();assert.equal(restarted.get('review-three').status,'interrupted');
});
test('review recovers crash after document commit before acknowledgement without applying twice',async t=>{
 const f=fixture(t),options={root:join(f.root,'reviews'),library:f.store,source:async()=>({target:{name:'fixture'}}),generate:async()=>({output:'草稿',finish_reason:'stop'})},reviews=new LibraryReviews(options).load();
 await reviews.create({request_id:'review-one',provider:'b',model:'same',sources:[]});await ready(reviews,'review-one');const job=reviews.get('review-one'),body={request_id:'apply-one',content:'应用内容'};reviews.persist({...job,status:'applying',apply_request:body});f.store.write({...job.target,...body});const restarted=new LibraryReviews(options).load();assert.equal(restarted.get('review-one').status,'applied');assert.equal(restarted.get('review-one').applied_change,'apply-one');assert.equal(f.store.history('memory','MEMORY.md').length,1);
 const denied=createLibraryReviewHandler({reviews:restarted,checkToken:()=>false});assert.equal((await denied(new Request('http://fixture/api/panel-library-reviews'),'/api/panel-library-reviews')).status,401);
});
test('UTF8 BOM and newline bytes survive undo and missing memory files are editable without read-side writes',t=>{
 const f=fixture(t),bytes=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from('原文\r\n')]);fs.writeFileSync(join(f.knowledge,'原知识.md'),bytes);const doc=f.store.read('knowledge','原知识.md');const saved=f.store.write({...doc,request_id:'bom-save',content:'更改'});f.store.undo({change_id:'bom-save',revision:saved.revision,request_id:'bom-undo'});assert.deepEqual(fs.readFileSync(join(f.knowledge,'原知识.md')),bytes);
 fs.unlinkSync(join(f.memory,'MEMORY.md'));const list=f.store.catalog({source:'memory'});assert.equal(list.items[0].missing,true);assert.equal(fs.existsSync(join(f.memory,'MEMORY.md')),false);
});
test('review cancellation and disk failure cannot claim applied content or leave a rejected promise',async t=>{
 const f=fixture(t),reviews=new LibraryReviews({root:join(f.root,'reviews'),library:f.store,source:async()=>({target:{name:'fixture'}}),generate:async(_,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('abort')),{once:true}))}).load();
 await reviews.create({request_id:'cancel-one',provider:'b',model:'same',sources:[]});reviews.cancel('cancel-one');assert.equal((await ready(reviews,'cancel-one')).status,'cancelled');assert.equal(fs.readFileSync(join(f.memory,'MEMORY.md'),'utf8'),'长期记忆\n');
});
test('draft consumption retains concurrent primary and newly arrived conflict copies',async t=>{
 const {store}=fixture(t),handler=createLibraryHandler({store,checkToken:()=>true});
 const request=async(method,suffix,body)=>{const path='/api/panel-library/draft'+suffix;const r=await handler(new Request('http://fixture'+path+'?source=memory&path=MEMORY.md',{method,...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})}),path);return {status:r.status,...await r.json()};};
 const options={base:store.read('memory','MEMORY.md')};
 const first=(await request('PUT','',{revision:0,text:'已保存稿',options})).draft;
 const conflict=(await request('PUT','',{revision:0,text:'已合并的旧冲突',options})).draft.conflicts[0];
 await request('PUT','',{revision:0,text:'刚到的新冲突',options});
 const consumed=await request('POST','/consume',{root_revision:options.base.root_revision,expected:first,conflicts:[conflict]});
 assert.equal(consumed.draft.text,'');assert.deepEqual(consumed.draft.conflicts.map(d=>d.text),['刚到的新冲突']);assert.equal(consumed.remaining,true);
 const newer=(await request('PUT','',{revision:consumed.draft.revision,text:'另一设备正在编辑',options})).draft;
 await request('POST','/consume',{root_revision:options.base.root_revision,expected:first,conflicts:[]});
 assert.deepEqual((await request('GET','')).draft,newer);
 const bad=await request('POST','/consume',{root_revision:'changed-profile',expected:newer,conflicts:[]});assert.equal(bad.status,409);assert.deepEqual((await request('GET','')).draft,newer);
});
test('library drafts support long UTF8 documents and baselines without changing chat limits',t=>{
 const {store}=fixture(t),text='长文\n'.repeat(80000),base={...store.read('memory','MEMORY.md'),content:text};
 const saved=store.drafts.put('large',{revision:0,text,options:{base}});assert.equal(saved.ok,true);assert.equal(store.drafts.get('large').text,text);
 assert.throws(()=>store.drafts.put('large',{revision:1,text:'文'.repeat(3*1024*1024),options:{base}}),/8MB/);assert.equal(store.drafts.get('large').text,text);
 const ordinary=new SessionDrafts(join(store.root,'ordinary'));assert.throws(()=>ordinary.put('chat',{revision:0,text,options:{}}),/200000/);assert.throws(()=>ordinary.put('chat',{revision:0,text:'short',options:{base}}),/选项过大/);
});

test('consuming an intentional empty draft clears its baseline and does not restore it again',async t=>{
 const {store}=fixture(t),doc=store.read('memory','MEMORY.md'),handler=createLibraryHandler({store,checkToken:()=>true});
 const response=await handler(new Request('http://fixture/api/panel-library/draft?source=memory&path=MEMORY.md',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:0,text:'',options:{base:doc}})}),'/api/panel-library/draft');
 const snapshot=(await response.json()).draft;
 const consumed=store.consumeDraft('memory','MEMORY.md',{root_revision:doc.root_revision,expected:snapshot,conflicts:[]});assert.equal(consumed.remaining,false);assert.deepEqual(consumed.draft.options,{});assert.equal(consumed.draft.revision,snapshot.revision+1);
 const reopened=await handler(new Request('http://fixture/api/panel-library/draft?source=memory&path=MEMORY.md'),'/api/panel-library/draft');assert.deepEqual((await reopened.json()).draft.options,{});
});
test('review history pages all records with stable ties, excludes full text from summaries, and survives reopening',async t=>{
 const f=fixture(t),options={root:join(f.root,'reviews'),library:f.store},reviews=new LibraryReviews(options),target=f.store.read('memory','MEMORY.md');
 for(let i=0;i<123;i++)reviews.persist({version:1,id:'history-'+String(i).padStart(3,'0'),status:'applied',target,sources:[target],created_at:1000+Math.floor(i/3),proposal:'private draft',apply_request:{request_id:'apply-'+i,content:'private applied text'}});
 const reopened=new LibraryReviews(options).load(),handler=createLibraryReviewHandler({reviews:reopened,checkToken:()=>true});let cursor=null,ids=[];
 do{const response=await handler(new Request('http://fixture/api/panel-library-reviews'+(cursor?'?before='+cursor:'')),'/api/panel-library-reviews');assert.equal(response.status,200);const data=await response.json();assert.equal(data.total,ids.length?124:123);assert.ok(data.reviews.length<=50);assert.ok(!JSON.stringify(data).includes('private'));assert.ok(!JSON.stringify(data).includes('长期记忆'));ids.push(...data.reviews.map(r=>r.id));cursor=data.next;if(ids.length===50)reopened.persist({...reopened.get('history-000'),id:'history-new',created_at:2000});}while(cursor);
 assert.equal(ids.length,123);assert.equal(new Set(ids).size,123);const detail=reopened.view(reopened.get('history-000'),true);assert.equal(detail.proposal,'private draft');assert.equal(detail.apply_request.content,'private applied text');
 const bad=await handler(new Request('http://fixture/api/panel-library-reviews?before=missing'),'/api/panel-library-reviews');assert.equal(bad.status,409);
});
