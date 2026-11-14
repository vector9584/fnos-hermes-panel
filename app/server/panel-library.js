import * as fs from 'node:fs';
import {join,resolve,dirname,relative,basename,sep} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {StateFile,SessionDrafts,digest,safeId,stateError} from './panel-state.js';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const within=(root,path)=>path===root||path.startsWith(root+sep);
export class LibraryStore{
 constructor({root,sources}){Object.assign(this,{root,sources});this.drafts=new SessionDrafts(join(root,'library-drafts'),{maxTextBytes:8*1024*1024,maxOptionsLength:64*1024*1024});}
 source(id){const source=this.sources().find(s=>s.id===id);if(!source)throw stateError('资料来源不存在',404);const root=resolve(source.root),actual=fs.existsSync(root)?fs.realpathSync(root):root;return {...source,root,root_revision:digest([id,actual])};}
 path(sourceId,path,{create=false}={}){
  const source=this.source(sourceId);if(typeof path!=='string'||!path||path.length>800||path.includes('\0')||path.includes('\\')||path.split('/').some(s=>!s||s==='.'||s==='..'||s.startsWith('.')))throw stateError('资料路径不正确');
  const target=resolve(source.root,path);if(!within(source.root,target)||!(/\.(md|txt|json)$/i.test(path)))throw stateError('只能操作资料目录中的文本文件');
  if((source.files&&!source.files.includes(path))||(source.pattern&&!source.pattern.test(path)))throw stateError('此文件不属于所选资料来源');
  let cursor=source.root;if(fs.existsSync(cursor))cursor=fs.realpathSync(cursor);const realRoot=cursor;
  for(const part of path.split('/')){cursor=join(cursor,part);if(!fs.existsSync(cursor)){try{fs.lstatSync(cursor);throw stateError('资料路径包含失效链接');}catch(error){if(error.code!=='ENOENT')throw error;}if(create)continue;throw stateError('资料文件不存在',404);}const stat=fs.lstatSync(cursor);if(stat.isSymbolicLink())throw stateError('资料路径包含符号链接，请在原位置处理',403);if(!within(realRoot,cursor))throw stateError('资料路径越界',403);}
  return {source,target:cursor,path};
 }
 read(sourceId,path,{allowMissing=false}={}){
  const located=this.path(sourceId,path,{create:allowMissing}),{target,source}=located;const exists=fs.existsSync(target);
  if(exists&&!fs.statSync(target).isFile())throw stateError('所选路径不是文件');if(exists&&fs.statSync(target).size>8*1024*1024)throw stateError('资料超过8MB，请下载原文后查看',413);
  const bytes=exists?fs.readFileSync(target):Buffer.alloc(0);let content;try{content=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch(_){throw stateError('资料不是UTF-8文本，请下载原文查看',415);}if(bytes.includes(0))throw stateError('所选资料不是文本文件',415);
  return {source:sourceId,path,title:basename(path),content,revision:hash(bytes),root_revision:source.root_revision,exists,editable:!!source.editable,mtime:exists?fs.statSync(target).mtimeMs:null,bytes:bytes.length};
 }
 catalog({source:sourceId,query='',folder='',offset=0,limit=40}={}){
  const sources=this.sources(),items=[],issues=[];let partial=false;const q=String(query).trim().toLowerCase(),deadline=Date.now()+4000;
  for(const item of sources){if(sourceId&&sourceId!==item.id)continue;const source=this.source(item.id);if(source.files){for(const file of source.files){if(!fs.existsSync(join(source.root,file))&&(!q||file.toLowerCase().includes(q)))items.push({source:source.id,source_name:source.name,path:file,title:basename(file),bytes:0,mtime:0,editable:!!source.editable,missing:true,snippet:'尚未建立此文件，打开后可编辑保存。'});}}if(!fs.existsSync(source.root))continue;
   const scan=(directory,prefix='',depth=0)=>{if(depth>20){issues.push({source:source.id,path:prefix,reason:'目录层级超过检索范围'});return;}for(const entry of fs.readdirSync(directory,{withFileTypes:true})){if(entry.name.startsWith('.'))continue;const path=prefix?prefix+'/'+entry.name:entry.name,absolute=join(directory,entry.name);if(source.files&&!source.files.includes(path)&&!source.files.some(p=>p.startsWith(path+'/')))continue;
    if(entry.isSymbolicLink()){issues.push({source:source.id,path,reason:'符号链接不在面板中编辑'});continue;}if(entry.isDirectory()){scan(absolute,path,depth+1);continue;}if(!entry.isFile()||!(/\.(md|txt|json)$/i.test(entry.name)))continue;
    const stat=fs.statSync(absolute);let snippet='',matched=!q||path.toLowerCase().includes(q);
    if(q&&!matched){if(Date.now()>deadline||stat.size>8*1024*1024){partial=true;continue;}const text=fs.readFileSync(absolute,'utf8'),at=text.toLowerCase().indexOf(q);if(at>=0){matched=true;snippet=text.slice(Math.max(0,at-50),at+q.length+140);}}
    if(source.pattern&&!source.pattern.test(path))continue;
    if(matched)items.push({source:source.id,source_name:source.name,path,title:basename(path),bytes:stat.size,mtime:stat.mtimeMs,editable:!!source.editable,snippet});
   }};scan(source.root);
  }
  if(sourceId&&!sources.some(s=>s.id===sourceId))throw stateError('资料来源不存在',404);
  items.sort((a,b)=>b.mtime-a.mtime||a.path.localeCompare(b.path));
  const folders=[...new Set(items.flatMap(item=>{const parts=item.path.split('/');return parts.slice(0,-1).map((_,index)=>parts.slice(0,index+1).join('/'));}))].sort((a,b)=>a.localeCompare(b));
  if(folder&&!folders.includes(folder))throw stateError('资料目录不存在',404);
  const visible=folder?items.filter(item=>item.path.startsWith(folder+'/')):items;
  return {sources:sources.map(({root,pattern,files,...s})=>s),folders,items:visible.slice(offset,offset+Math.min(limit,5000)),total:visible.length,has_more:offset+limit<visible.length,partial,issues};
 }
 graph(sourceId='knowledge'){
  const source=this.source(sourceId);if(sourceId!=='knowledge'&&source.group!=='knowledge')throw stateError('只有知识库资料支持笔记关系图',400);
  const {items}=this.catalog({source:sourceId,limit:5000});
  const notes=items.filter(item=>/\.md$/i.test(item.path)&&!item.missing),byPath=new Map(notes.map(item=>[item.path,item]));
  const byName=new Map();for(const item of notes){for(const name of [item.title,item.title.replace(/\.md$/i,'')]){const key=name.toLowerCase(),list=byName.get(key)||[];list.push(item);byName.set(key,list);}}
  const edges=[],linked=new Set();
  for(const item of notes){const content=this.read(sourceId,item.path).content;for(const match of content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)){
    const target=match[1].trim().replace(/\\/g,'/');if(!target)continue;
    const direct=[target,target.toLowerCase().endsWith('.md')?target:target+'.md'].flatMap(path=>[relative(source.root,resolve(source.root,dirname(item.path),path)).split(sep).join('/'),relative(source.root,resolve(source.root,path)).split(sep).join('/')]);
    let found=direct.map(path=>byPath.get(path)).find(Boolean);
    if(!found){const matches=byName.get(basename(target.replace(/\.md$/i,'')).toLowerCase())||[];if(matches.length===1)found=matches[0];}
    if(found&&found.path!==item.path){const key=item.path+'\0'+found.path;if(!linked.has(key)){linked.add(key);edges.push({from:item.path,to:found.path});}}
  }}
  const included=new Set(edges.flatMap(edge=>[edge.from,edge.to])),nodes=notes.filter(item=>included.has(item.path)).map(item=>({path:item.path,title:item.title,links:edges.filter(edge=>edge.from===item.path).map(edge=>edge.to),bytes:item.bytes}));
  return {nodes,edges};
 }
 consumeDraft(source,path,body){
  const located=this.path(source,path,{create:true});
  if(body.root_revision!==located.source.root_revision)throw stateError('当前资料环境已改变，草稿仍保留',409);
  const key='doc-'+digest([source,path,located.source.root_revision]).slice(0,40),file=this.drafts.file(key),current=file.read();
  const expected=body.expected;
  if(!expected||!Number.isInteger(expected.revision)||typeof expected.text!=='string'||!Array.isArray(body.conflicts))throw stateError('缺少本次已处理的草稿快照');
  const same=current.revision===expected.revision&&current.text===expected.text&&digest(current.options)===digest(expected.options||{});
  const consumed=new Set(body.conflicts.filter(c=>c&&typeof c.key==='string').filter(c=>current.conflicts.some(v=>v.key===c.key&&digest(v)===digest(c))).map(c=>c.key));
  const next={...current,conflicts:current.conflicts.filter(c=>!consumed.has(c.key))};
  if(same){next.text='';next.options={};next.attachments=[];}
  if((same&&(current.text!==''||Object.keys(current.options||{}).length||current.attachments?.length))||next.conflicts.length!==current.conflicts.length){next.revision++;next.updated_at=Date.now();file.write(next);}
  return {ok:true,draft:next,remaining:!!next.text||!!next.options?.base||next.conflicts.length>0};
 }
 records(){const dir=join(this.root,'library-history');if(!fs.existsSync(dir))return [];return fs.readdirSync(dir).filter(n=>n.endsWith('.json')).map(n=>this.record(n.slice(0,-5)).read());}
 record(id){return new StateFile(join(this.root,'library-history',safeId(id)+'.json'),()=>null,{validate:d=>d&&d.version===1&&d.id===id&&typeof d.before==='string'&&typeof d.after==='string'});}
 history(source,path){const root_revision=this.source(source).root_revision;return this.records().filter(r=>r.source===source&&r.path===path&&r.root_revision===root_revision).sort((a,b)=>b.created_at-a.created_at).map(({before,after,...r})=>({...r,can_undo:r.status==='committed'&&r.before_exists}));}
 write(body){
  const id=safeId(body.request_id),located=this.path(body.source,body.path,{create:true}),{source,target}=located;
  if(!source.editable)throw stateError('此来源仅供查看',403);if(body.root_revision!==source.root_revision)throw stateError('当前资料环境已改变，请重新读取后合并',409);
  if(typeof body.content!=='string'||Buffer.byteLength(body.content)>8*1024*1024)throw stateError('资料内容超过8MB或格式不正确',413);
  const file=this.record(id),existing=file.read(),input_hash=digest(body);if(existing&&existing.input_hash!==input_hash)throw stateError('重复保存编号对应不同内容',409);
  const before=this.read(body.source,body.path,{allowMissing:true}),after=Buffer.from(body.content);
  if(existing){if(before.revision===existing.after_hash&&before.exists){if(existing.status!=='committed')file.write({...existing,status:'committed',finished_at:Date.now()});return {...before,change_id:id,duplicate:true};}throw stateError('保存请求已记录，但文件内容随后改变；请重新读取核对',409);}
  if(body.revision!==before.revision||body.exists!==before.exists)throw stateError('原文已被其他设备或内核修改，请保留草稿并合并',409);
  if(before.exists&&before.content===body.content)return {...before,unchanged:true};
  const record={version:1,id,input_hash,source:body.source,path:body.path,root_revision:source.root_revision,before:Buffer.from(before.content).toString('base64'),before_hash:before.revision,before_exists:before.exists,after:after.toString('base64'),after_hash:hash(after),created_at:Date.now(),status:'prepared',reason:String(body.reason||'手动编辑').slice(0,200),...(body.undo_of?{undo_of:body.undo_of}:{})};
  file.write(record); // Backup and intent must be durable before touching a user file.
  fs.mkdirSync(dirname(target),{recursive:true,mode:0o700});const previous=before.exists?fs.statSync(target):null,temp=target+'.panel-'+randomUUID()+'.tmp';let fd;
  try{fd=fs.openSync(temp,'wx',previous?previous.mode&0o777:0o600);fs.writeFileSync(fd,after);if(previous&&typeof process.getuid==='function'&&previous.uid!==process.getuid())fs.fchownSync(fd,previous.uid,previous.gid);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
   const current=this.read(body.source,body.path,{allowMissing:true});if(current.revision!==before.revision||current.exists!==before.exists)throw stateError('保存前原文发生变化，请重新读取后合并',409);
   fs.renameSync(temp,target);fd=fs.openSync(dirname(target),'r');fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;file.write({...record,status:'committed',finished_at:Date.now()});
  }finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(temp))fs.unlinkSync(temp);}
  return {...this.read(body.source,body.path),change_id:id};
 }
 undo(body){const record=this.record(safeId(body.change_id)).read();if(!record)throw stateError('修改记录不存在',404);if(record.status!=='committed')throw stateError('此修改未确认完成，请重新读取核对',409);
  const current=this.read(record.source,record.path);if(current.revision!==record.after_hash||body.revision!==current.revision)throw stateError('文件在这次修改后又发生变化，请手动合并',409);
  if(!record.before_exists)throw stateError('这是新建资料，请通过编辑保留需要的内容；面板不删除原文件',409);
  return this.write({source:record.source,path:record.path,root_revision:record.root_revision,revision:current.revision,exists:true,request_id:body.request_id,content:Buffer.from(record.before,'base64').toString('utf8'),reason:'撤销修改',undo_of:record.id});
 }
}
export function createLibraryHandler({store,checkToken}){
 const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
 return async(req,path)=>{if(path!=='/api/panel-library'&&!path.startsWith('/api/panel-library/'))return null;if(!checkToken(req))return reply({error:'请重新登录后查看资料'},401);
  try{const url=new URL(req.url),source=url.searchParams.get('source'),file=url.searchParams.get('path');
   if(path==='/api/panel-library'&&req.method==='GET')return reply({ok:true,...store.catalog({source,query:url.searchParams.get('q')||'',folder:url.searchParams.get('folder')||'',offset:Math.max(0,Number(url.searchParams.get('offset'))||0),limit:Math.min(5000,Math.max(1,Number(url.searchParams.get('limit'))||40))})});
   if(path==='/api/panel-library/graph'&&req.method==='GET')return reply({ok:true,...store.graph(source||'knowledge')});
   if(path==='/api/panel-library/document'){
    if(req.method==='GET')return reply({ok:true,document:store.read(source,file,{allowMissing:url.searchParams.get('new')==='1'}),history:store.history(source,file)});
    if(req.method==='PUT')return reply({ok:true,document:store.write(await req.json())});
   }
   if(path==='/api/panel-library/undo'&&req.method==='POST')return reply({ok:true,document:store.undo(await req.json())});
   if(path==='/api/panel-library/download'&&req.method==='GET'){const {target}=store.path(source,file);if(!fs.statSync(target).isFile())throw stateError('所选路径不是资料文件');return new Response(fs.readFileSync(target),{headers:{'Content-Type':'text/plain; charset=utf-8','Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(basename(file)),'Cache-Control':'no-store'}});}
   if(path==='/api/panel-library/draft/consume'&&req.method==='POST')return reply(store.consumeDraft(source,file,await req.json()));
   if(path==='/api/panel-library/draft'){const key='doc-'+digest([source,file,store.source(source).root_revision]).slice(0,40);store.path(source,file,{create:true});if(req.method==='GET')return reply({ok:true,draft:store.drafts.get(key)});if(req.method==='PUT'){const result=store.drafts.put(key,await req.json());return reply(result,result.conflict?409:200);}}
   throw stateError('资料操作不存在',404);
  }catch(error){return reply({ok:false,error:error.message},error.status||500);}
 };
}
