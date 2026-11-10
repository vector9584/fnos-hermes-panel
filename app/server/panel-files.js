import * as fs from 'node:fs';
import {spawn} from 'node:child_process';
import {join,resolve,relative,sep,basename} from 'node:path';
import {Readable} from 'node:stream';
import {stateError} from './panel-state.js';

// Static assets are served from a pinned application tree, never user links.
export function openStaticFile(root,path){
 const base=fs.realpathSync(root),part=relative(resolve(root),resolve(path)),target=resolve(base,part);
 if(!part||part.startsWith('..'+sep)||part==='..'||part.startsWith(sep))throw stateError('静态文件路径越界',403);
 let cursor=base;
 for(const segment of part.split(sep)){if(segment.startsWith('.'))throw stateError('禁止隐藏资源',403);cursor=join(cursor,segment);if(fs.lstatSync(cursor).isSymbolicLink())throw stateError('静态文件不允许链接',403);}
 const fd=fs.openSync(target,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.nlink!==1)throw stateError('静态资源不是普通文件',403);
  if(process.platform==='linux'){const actual=fs.readlinkSync('/proc/self/fd/'+fd);if(actual!==target)throw stateError('静态资源路径发生变化',403);}
  return {fd,stat};
 }catch(error){fs.closeSync(fd);throw error;}
}

export function createFileRoots({data,varDir,librarySources=()=>[]}){
 const canonical=path=>fs.existsSync(path)?fs.realpathSync(path):resolve(path);
 data=canonical(data);varDir=canonical(varDir);
 return ()=>{
  const roots=[{id:'workspace',name:'工作区',path:join(data,'workspace'),editable:true},
   {id:'uploads',name:'对话附件',path:join(data,'uploads'),editable:false,upload:true},
   {id:'temporary',name:'临时产物',path:join(varDir,'tmp'),editable:false}];
  for(const source of librarySources())if(source.id==='knowledge')roots.push({id:'knowledge',name:'知识库附件',path:canonical(source.root),editable:false});
  const profiles=join(data,'profiles');if(fs.existsSync(profiles))for(const entry of fs.readdirSync(profiles,{withFileTypes:true})){if(!entry.isDirectory()||!/^[\w-]{1,100}$/.test(entry.name))continue;for(const kind of ['workspace','uploads']){const path=join(profiles,entry.name,kind);if(fs.existsSync(path)||kind==='uploads')roots.push({id:'profile-'+entry.name+'-'+kind,name:entry.name+' · '+(kind==='workspace'?'工作区':'附件'),path,editable:kind==='workspace',upload:kind==='uploads'});}}
  return roots;
 };

}
export function fileReference(input,{roots,data,varDir,basePath=''}){
 if(typeof input!=='string'||!input||input.includes('\0')||input.includes('\\'))throw stateError('文件路径不正确');
 data=fs.existsSync(data)?fs.realpathSync(data):resolve(data);varDir=fs.existsSync(varDir)?fs.realpathSync(varDir):resolve(varDir);
 let path=input;
 if(basePath&&path.startsWith(basePath+'/'))path=path.slice(basePath.length);
 if(path.startsWith('/api/download?')||path.startsWith('/api/preview?'))path=new URL(path,'http://localhost').searchParams.get('path')||'';
 const alreadyAbsolute=roots().some(root=>path.startsWith(resolve(root.path)+sep));
 if(alreadyAbsolute){}
 else if(path.startsWith('/uploads/p/')){const match=path.match(/^\/uploads\/p\/([\w-]{1,100})\/(.*)$/);if(!match)throw stateError('附件路径不正确');path=join(data,'profiles',match[1],'uploads',decodeURIComponent(match[2]));}
 else if(path.startsWith('/uploads/'))path=join(data,'uploads',decodeURIComponent(path.slice(9)));
 else if(path.startsWith('/workspace/'))path=join(data,'workspace',decodeURIComponent(path.slice(11)));
 else if(path.startsWith('/tmp/')&&!fs.existsSync(path))path=join(varDir,'tmp',decodeURIComponent(path.slice(5)));
 else if(path.startsWith('/data/'))path=join(data,decodeURIComponent(path.slice(6)));
 else if(path.startsWith('~/'))path=join(data,path.slice(2));
 else if(!path.startsWith('/'))path=join(data,path);
 const absolute=resolve(path);
 const source=roots().filter(root=>absolute===resolve(root.path)||absolute.startsWith(resolve(root.path)+sep)).sort((a,b)=>b.path.length-a.path.length)[0];
 if(!source)throw stateError('此文件不在可访问的工作目录中',403);
 const rel=relative(resolve(source.path),absolute);if(!rel||rel.split(sep).some(part=>part.startsWith('.')))throw stateError('请选择工作目录中的普通文件',403);
 return {root:source.id,path:rel.split(sep).join('/'),absolute};
}
const types={jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',gif:'image/gif',webp:'image/webp',svg:'image/svg+xml',bmp:'image/bmp',ico:'image/x-icon',pdf:'application/pdf',html:'text/html; charset=utf-8',htm:'text/html; charset=utf-8',mp3:'audio/mpeg',wav:'audio/wav',mp4:'video/mp4',webm:'video/webm'};
export function createFileHandler({python,serverRoot,state,roots,data,varDir,basePath='',checkToken,start=spawn}){
 const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
 function childFor(body){const child=start(python,['-B',join(serverRoot,'panel-files.py')],{stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});child.stderr.resume();child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({roots:roots(),state,body}));return child;}
 async function call(body){return new Promise((resolve,reject)=>{let output='',settled=false;const child=childFor(body),timer=setTimeout(()=>{child.kill('SIGTERM');finish(null,stateError('文件操作超时，记录已保留，请刷新核对',504));},30000);
  function finish(value,error){if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);}
  child.stdout.on('data',chunk=>{output+=chunk;if(Buffer.byteLength(output)>52*1024*1024){child.kill('SIGTERM');finish(null,stateError('返回内容过大，请缩小读取范围',413));}});
  child.on('error',()=>finish(null,stateError('文件服务无法启动',503)));child.on('close',()=>{try{const result=JSON.parse(output);if(!result.ok)throw stateError(result.error,result.status||500);finish(result);}catch(error){finish(null,error.status?error:stateError('文件服务返回异常，请刷新核对',502));}});
 });}
 async function stream(ref,{download=false,office=false,signal}={}){
  const child=childFor({action:'stream',root:ref.root,path:ref.path}),iterator=child.stdout[Symbol.asyncIterator]();let prefix=Buffer.alloc(0),first=Buffer.alloc(0),metadata;
  child.on('error',()=>{});const timer=setTimeout(()=>child.kill('SIGTERM'),30000);
  const cancel=()=>child.kill('SIGTERM');signal?.addEventListener('abort',cancel,{once:true});
  try{while(true){const next=await iterator.next();if(next.done)throw stateError('文件读取未完成',502);prefix=Buffer.concat([prefix,next.value]);const at=prefix.indexOf(10);if(at<0){if(prefix.length>65536)throw stateError('文件服务返回异常',502);continue;}metadata=JSON.parse(prefix.subarray(0,at));first=prefix.subarray(at+1);break;}
   if(!metadata.ok)throw stateError(metadata.error,metadata.status||500);
  }catch(error){cancel();signal?.removeEventListener('abort',cancel);throw error;}finally{clearTimeout(timer);}
  const name=basename(ref.path),ext=name.split('.').pop().toLowerCase();
  if(office){
   // The converter receives a private temporary copy of the descriptor stream,
   // never a mutable user path. Conversion output is sandboxed by the response.
   const temp=fs.mkdtempSync(join(varDir,'tmp','panel-preview-')),file=join(temp,'source.'+ext);let fd;
   try{fd=fs.openSync(file,'wx',0o600);fs.writeSync(fd,first);let bytes=first.length;for await(const chunk of iterator){bytes+=chunk.length;if(bytes>64*1024*1024)throw stateError('Office文件超过64MB，请下载查看',413);fs.writeSync(fd,chunk);}fs.closeSync(fd);fd=undefined;
    const html=await new Promise((resolve,reject)=>{const process=start(python,['-B',join(serverRoot,'preview_conv.py'),file],{stdio:['ignore','pipe','pipe']});let output='',done=false;const limit=setTimeout(()=>{process.kill();finish(stateError('预览转换超时，请下载查看',504));},30000);function finish(error){if(done)return;done=true;clearTimeout(limit);error?reject(error):resolve(output);}process.stdout.on('data',part=>{output+=part;if(Buffer.byteLength(output)>32*1024*1024){process.kill();finish(stateError('预览内容过大，请下载查看',413));}});process.stderr.resume();process.on('error',()=>finish(stateError('预览服务无法启动',503)));process.on('close',code=>finish(code?stateError('预览转换失败，请下载原文件',422):null));});
    return new Response(html,{headers:{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'",'Cache-Control':'no-store'}});
   }finally{if(fd!==undefined)fs.closeSync(fd);fs.rmSync(temp,{recursive:true,force:true});cancel();signal?.removeEventListener('abort',cancel);}
  }
  const iterable=async function*(){try{if(first.length)yield first;for await(const chunk of iterator)yield chunk;}finally{cancel();signal?.removeEventListener('abort',cancel);}};
  return new Response(Readable.toWeb(Readable.from(iterable())),{headers:{'Content-Type':types[ext]||'application/octet-stream','Content-Disposition':(download?'attachment':'inline')+"; filename*=UTF-8''"+encodeURIComponent(name),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"sandbox; default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'"}});
 }
 const handler=async(req,path)=>{
  const workspaceAPI=path==='/api/files'||path.startsWith('/api/files/'),preview=['/api/preview','/api/download','/api/preview/office'].includes(path),alias=/^\/(?:uploads|workspace|data|tmp)\//.test(path);
  if(!workspaceAPI&&!preview&&!alias)return null;
  if(!checkToken(req))return reply({ok:false,error:'请重新登录后查看文件'},401);
  try{
   const url=new URL(req.url);
   if(preview||alias){if(req.method!=='GET')throw stateError('此入口仅支持读取',405);const ref=fileReference(alias?path:url.searchParams.get('path'),{roots,data,varDir,basePath}),ext=ref.path.split('.').pop().toLowerCase();if(path==='/api/preview'&&!types[ext])return reply(await call({action:'read',root:ref.root,path:ref.path}));return await stream(ref,{download:path==='/api/download',office:path==='/api/preview/office',signal:req.signal});}
   if(path==='/api/files/roots'&&req.method==='GET')return reply({ok:true,roots:roots().map(({path,...root})=>({...root,available:fs.existsSync(path)}))});
   const params=Object.fromEntries(url.searchParams),body=req.method==='GET'?params:await req.json();
   const action=path==='/api/files'?'list':path.slice('/api/files/'.length);
   const allowed={list:'GET',read:'GET',history:'GET',version:'GET',write:'POST',mkdir:'POST',archive:'POST',restore:'POST',undo:'POST'};
   if(!(action==='draft'&&['GET','POST'].includes(req.method))&&req.method!==allowed[action])throw stateError('文件操作不存在，请刷新面板',405);
   return reply(await call({...body,action,root:body.root||'workspace'}));
  }catch(error){return reply({ok:false,error:error.status?error.message:'文件操作未完成，请刷新核对'},error.status||500);}
 };
 handler.upload=async(profile,kind,name,bytes)=>{if(profile&&!/^[\w-]{1,100}$/.test(profile))throw stateError('附件环境标识不正确');return call({action:'upload',root:profile&&profile!=='default'?'profile-'+profile+'-uploads':'uploads',kind,name,base64:bytes.toString('base64')});};
 handler.inspect=async(path,image=false)=>{const ref=fileReference(path,{roots,data,varDir,basePath});return call({action:image?'image':'inspect',root:ref.root,path:ref.path});};
 return handler;
}
