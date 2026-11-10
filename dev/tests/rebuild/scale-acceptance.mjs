#!/usr/bin/env node
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readdirSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {LibraryStore} from '../../../app/server/panel-library.js';

const ROOT=resolve(new URL('../../..',import.meta.url).pathname);
const PYTHON=process.env.PYTHON||'python3';
const REPEATS=Number(process.env.SCALE_REPEATS||25);
const root=mkdtempSync(join(tmpdir(),'hermes-scale-acceptance-'));
process.env.VAR_DIR=join(root,'var-experts');
const {expertCatalog}=await import('../../../app/server/panel-experts.js');
const results={scope:'synthetic local fixture; all generated files and database stay in a fresh temporary directory',repeats:REPEATS,dataset:{skills:3000,knowledge_files:1000,experts:315,sessions:1000,messages:20000}};
const percentile=(values,p)=>[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor((values.length-1)*p))];
function measure(fn){const times=[];let value;for(let i=0;i<REPEATS;i++){const start=performance.now();value=fn();times.push(performance.now()-start);}return {p50_ms:+percentile(times,.5).toFixed(2),p95_ms:+percentile(times,.95).toFixed(2),last:value};}
function writeJson(file,value){writeFileSync(file,JSON.stringify(value));}
try{
 const skills=join(root,'skills');
 for(let i=0;i<3000;i++){const dir=join(skills,'skill-'+String(i).padStart(4,'0'));mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'SKILL.md'),'---\nname: skill-'+i+'\ndescription: synthetic benchmark entry\n---\n\nBenchmark text '+i+'\n');}
 const countSkills=()=>{let count=0;for(const name of readdirSync(skills)){const file=join(skills,name,'SKILL.md');if(readFileSync(file,'utf8').includes('Benchmark text'))count++;}return count;};
 const skillResult=measure(countSkills);if(skillResult.last!==results.dataset.skills)throw Error('skill enumeration count mismatch');delete skillResult.last;results.skills_filesystem_enumeration=skillResult;

 const knowledge=join(root,'knowledge');mkdirSync(knowledge);
 for(let i=0;i<results.dataset.knowledge_files;i++)writeFileSync(join(knowledge,'note-'+String(i).padStart(4,'0')+'.md'),'# Synthetic knowledge '+i+'\n\n'+(i===731?'scale-needle-731':'ordinary reference text')+' content\n');
 const library=new LibraryStore({root:join(root,'var'),sources:()=>[{id:'knowledge',name:'知识库',root:knowledge,editable:true,group:'knowledge'}]});
 const libraryCatalog=measure(()=>library.catalog({source:'knowledge'}));
 if(libraryCatalog.last.total!==results.dataset.knowledge_files||libraryCatalog.last.items.length!==40)throw Error('knowledge catalog pagination mismatch');
 results.knowledge_catalog={p50_ms:libraryCatalog.p50_ms,p95_ms:libraryCatalog.p95_ms,total:libraryCatalog.last.total,returned_items:libraryCatalog.last.items.length,response_bytes:Buffer.byteLength(JSON.stringify(libraryCatalog.last))};
 const librarySearch=measure(()=>library.catalog({source:'knowledge',query:'scale-needle-731'}));
 if(librarySearch.last.total!==1||librarySearch.last.items[0]?.path!=='note-0731.md')throw Error('knowledge search mismatch');
 results.knowledge_search={p50_ms:librarySearch.p50_ms,p95_ms:librarySearch.p95_ms,total:librarySearch.last.total,partial:librarySearch.last.partial,response_bytes:Buffer.byteLength(JSON.stringify(librarySearch.last))};

 const expertResult=measure(()=>expertCatalog({offset:0,limit:36,details:false}));
 if(expertResult.last.experts.length!==36||expertResult.last.total!==results.dataset.experts)throw Error('expert catalog pagination mismatch');
 results.expert_catalog={p50_ms:expertResult.p50_ms,p95_ms:expertResult.p95_ms,total:expertResult.last.total,returned:expertResult.last.experts.length,response_bytes:Buffer.byteLength(JSON.stringify(expertResult.last))};

 const sessions=join(root,'var','chat','sessions');mkdirSync(sessions,{recursive:true});
 const database=join(root,'state.db');
 const fixture=`import json,sqlite3,sys\nfrom pathlib import Path\nr=Path(sys.argv[1]); db=sqlite3.connect(r/'state.db'); db.executescript("CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,display_name TEXT,last_activity_at INTEGER,source TEXT); CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,content TEXT,timestamp INTEGER,role TEXT,active INTEGER);"); db.execute("CREATE VIRTUAL TABLE messages_fts_trigram USING fts5(content, tokenize='trigram')")\nfor i in range(500):\n sid=f'channel-{i:04d}'; db.execute('INSERT INTO sessions VALUES(?,?,?,?,?)',(sid,f'Channel {i}',None,1700000000+i,'discord'))\n for j in range(20):\n  mid=i*20+j+1; content=('cross-scale-needle' if i==417 and j==8 else f'synthetic message {i} {j}'); role='user' if j%2==0 else 'assistant'; db.execute('INSERT INTO messages VALUES(?,?,?,?,?,1)',(mid,sid,content,1700000000+j,role)); db.execute('INSERT INTO messages_fts_trigram(rowid,content) VALUES(?,?)',(mid,content))\n db.commit()\nfor i in range(500):\n sid=f'panel-{i:04d}'; messages=[]\n for j in range(20): messages.append({'role':'user' if j%2==0 else 'assistant','content':'cross-scale-needle in local session' if i==213 and j==6 else f'local synthetic message {i} {j}','ts':1700000000000+j})\n (r/'var/chat/sessions'/f'{sid}.json').write_text(json.dumps({'id':sid,'title':f'Panel {i}','updated_at':1700000000+i,'messages':messages}))\ndb.close()`;
 const build=spawnSync(PYTHON,['-c',fixture,root],{encoding:'utf8',timeout:120000});
 if(build.status!==0)throw Error('synthetic SQLite setup failed: '+build.stderr);
 const searchScript=join(ROOT,'app/server/panel-search.py');
 const search=()=>{const run=spawnSync(PYTHON,[searchScript,root,join(root,'var'),'cross-scale-needle','0'],{encoding:'utf8',timeout:30000});if(run.status!==0)throw Error('panel-search failed: '+run.stderr);return JSON.parse(run.stdout);};
 const searchResult=measure(search);
 if(searchResult.last.total!==2||searchResult.last.results.length!==2||searchResult.last.partial)throw Error('cross-source search mismatch: '+JSON.stringify({total:searchResult.last.total,partial:searchResult.last.partial}));
 results.session_and_global_search={sessions:results.dataset.sessions,messages:results.dataset.messages,p50_ms:searchResult.p50_ms,p95_ms:searchResult.p95_ms,total:searchResult.last.total,returned:searchResult.last.results.length,response_bytes:Buffer.byteLength(JSON.stringify(searchResult.last)),sqlite_bytes:readFileSync(database).length};
 results.completed=true;
 for(const [name,result] of Object.entries(results))if(result&&typeof result.p95_ms==='number'&&result.p95_ms>1500)throw Error(name+' exceeded the 1.5s local operation budget');
 console.log(JSON.stringify(results,null,2));
}finally{rmSync(root,{recursive:true,force:true});}
