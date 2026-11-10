import {panelPath} from './panel-auth.js';

export function panelBodyLimit(path){
 // Multipart carries the binary file directly. Leave 1 MiB for field headers.
 if(path==='/api/chat/upload-image')return 17*1024*1024;
 if(path==='/api/chat/upload-file')return 65*1024*1024;
 // JSON can escape each UTF-8 byte to six ASCII bytes. The document handler
 // still enforces the 8 MiB decoded-text limit before writing anything.
 if(path==='/api/panel-library/document'||path==='/api/files/write'||path==='/api/files/draft')return 49*1024*1024;
 if(path==='/api/workspace-ui/avatars')return 3*1024*1024;
 return 2*1024*1024;
}

export function toPanelRequest(req,{limit=2*1024*1024,response}={}){
 return new Promise((resolve,reject)=>{
  const length=Number(req.headers['content-length']||0);if(length>limit){req.resume();reject(Object.assign(Error('请求内容过大，请分批上传或减少内容'),{status:413}));return;}
  const chunks=[];let bytes=0,done=false;
  const fail=error=>{if(done)return;done=true;chunks.length=0;reject(error);};
  req.on('data',chunk=>{if(done)return;bytes+=chunk.length;if(bytes>limit){fail(Object.assign(Error('请求内容过大，请分批上传或减少内容'),{status:413}));return;}chunks.push(chunk);});
  req.on('end',()=>{if(done)return;done=true;try{
   const headers=new Headers();for(const [key,value] of Object.entries(req.headers))if(value!=null)headers.set(key,Array.isArray(value)?value.join(','):value);
   const controller=new AbortController();req.on('aborted',()=>controller.abort());
   response?.once('close',()=>controller.abort());
   resolve(new Request('http://localhost'+req.url,{method:req.method,headers,body:bytes?Buffer.concat(chunks):undefined,signal:controller.signal}));
  }catch(error){reject(Object.assign(error,{status:400}));}});
  req.on('error',fail);req.on('aborted',()=>fail(Object.assign(Error('请求已断开'),{status:400})));
 });
}

export async function dispatchPanel(req,res,{auth,basePath='',trustedUnix=false,maintenance,restart,channels,custom,main}){
 const path=panelPath('http://localhost'+req.url,basePath);
 const limit=panelBodyLimit(path);
 const request=auth.remember(await toPanelRequest(req,{limit,response:res}),{trustedUnix,remoteAddress:req.socket.remoteAddress||'unix',response:res});
 const denied=await auth.gate(request);if(denied)return denied;
 auth.track(request,res);
 return await maintenance(request,path)||(restart?await restart(request,path):null)||(channels?await channels(request,path):null)||await custom(request)||await main(request);
}

export function authorizePanelUpgrade(req,socket,{auth,trustedUnix=false}){
 try{
  const query=new URL(req.url,'http://localhost'),headers=new Headers();
  for(const [key,value] of Object.entries(req.headers))if(value!=null)headers.set(key,Array.isArray(value)?value.join(','):value);
  if(query.searchParams.get('token')&&!headers.get('cookie')?.includes('hermes_panel_device'))headers.set('x-monitor-token',query.searchParams.get('token'));
  const request=auth.remember(new Request('http://localhost'+req.url,{headers}),{trustedUnix,remoteAddress:req.socket.remoteAddress});
  if(!auth.valid(request)){socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');socket.destroy();return null;}
  auth.track(request,socket);return request;
 }catch{socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');socket.destroy();return null;}
}
