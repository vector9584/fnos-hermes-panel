import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {StateFile,stateError} from './panel-state.js';

const COOKIE='hermes_panel_device';
const hash=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b)=>{if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;const left=Buffer.from(a),right=Buffer.from(b);return left.length===right.length&&timingSafeEqual(left,right);};
const safeMethods=new Set(['GET','HEAD','OPTIONS']);
export function panelPath(url,base='') {let path=new URL(url).pathname;if(base&&path.startsWith(base+'/'))path=path.slice(base.length);else if(path===base)path='/';return path;}
function cookieValue(req,name=COOKIE){const matches=String(req.headers.get('cookie')||'').split(';').map(v=>v.trim()).filter(v=>v.startsWith(name+'='));return matches.length===1?matches[0].slice(name.length+1):'';}
function authority(value){try{const url=new URL('http://'+value);return url.username||url.password||url.pathname!=='/'||url.search||url.hash?'':url.host.toLowerCase();}catch{return '';}}
export function sameOrigin(req,{trustedUnix=false}={}){
 const origin=req.headers.get('origin'),fetchSite=req.headers.get('sec-fetch-site');
 if(fetchSite==='cross-site')return false;
 if(!origin)return true;
 let parsed;try{parsed=new URL(origin);}catch{return false;}
 if(!['http:','https:'].includes(parsed.protocol)||parsed.origin!==origin)return false;
 const hosts=[authority(req.headers.get('host')||new URL(req.url).host)];
 if(trustedUnix){const forwarded=req.headers.get('x-forwarded-host');if(forwarded&&!forwarded.includes(','))hosts.push(authority(forwarded));}
 return hosts.filter(Boolean).includes(parsed.host.toLowerCase());
}
export class PanelAuth{
 constructor({file,legacyToken,basePath='',now=Date.now,random=()=>randomBytes(32).toString('base64url')}){Object.assign(this,{legacyToken,basePath,now,random});this.file=new StateFile(file,()=>({version:1,devices:[],pairs:[]}),{validate:d=>d&&d.version===1&&Array.isArray(d.devices)&&Array.isArray(d.pairs)});this.context=new WeakMap();this.failures=new Map();this.connections=new Map();}
 remember(req,context){this.context.set(req,context);return req;}
 contextOf(req){return this.context.get(req)||{};}
 cookieName(req){return COOKIE+(this.basePath&&new URL(req.url).pathname.startsWith(this.basePath+'/')?'_fnos':'');}
 track(req,connection){const device=this.valid(req);if(!device||device.service)return;let set=this.connections.get(device.id);if(!set){set=new Set();this.connections.set(device.id,set);}set.add(connection);const timer=setInterval(()=>{if(device.expires_at<=this.now())connection.destroy();},60000);timer.unref?.();const clean=()=>{clearInterval(timer);set.delete(connection);if(!set.size)this.connections.delete(device.id);};connection.once('close',clean);connection.once('finish',clean);}
 disconnect(id,except){for(const connection of this.connections.get(id)||[])if(connection!==except)connection.destroy();}
 valid(req){
  if(!sameOrigin(req,this.contextOf(req)))return null;
  const header=req.headers.get('x-monitor-token')||'',cookie=cookieValue(req,this.cookieName(req));
  if(this.legacyToken&&same(header,this.legacyToken))return {id:'local-service',name:'本机维护凭证',service:true};
  const token=header||cookie;if(!/^[A-Za-z0-9_-]{43}$/.test(token))return null;
  const hashed=hash(token),now=this.now();
  return this.file.read().devices.find(d=>d.expires_at>now&&same(d.token_hash,hashed))||null;
 }
 cookie(token,req,remove=false){const secure=req.headers.get('origin')?.startsWith('https:')||req.headers.get('x-forwarded-proto')==='https';const path=new URL(req.url).pathname.startsWith(this.basePath+'/')?this.basePath+'/':'/';return this.cookieName(req)+'='+token+'; Path='+path+'; HttpOnly; SameSite=Strict; Max-Age='+(remove?0:30*86400)+(secure?'; Secure':'');}
 issue(req,name){const token=this.random(),now=this.now(),data=this.file.read();const device={id:randomBytes(12).toString('hex'),name:String(name||'此浏览器').trim().slice(0,60)||'此浏览器',token_hash:hash(token),created_at:now,expires_at:now+30*86400000};data.devices=data.devices.filter(d=>d.expires_at>now);if(data.devices.length>=100)throw stateError('已授权设备过多，请撤销不再使用的设备',409);data.devices.push(device);this.file.write(data);return {token,device};}
 response(body,status=200,headers={}){return new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}});}
 async gate(req){
  const context=this.contextOf(req),path=panelPath(req.url,this.basePath);
  if(!sameOrigin(req,context))return this.response({ok:false,error:'请从当前面板页面发起操作'},403);
  if(req.method==='OPTIONS')return new Response(null,{status:204,headers:{'Cache-Control':'no-store'}});
  if(path==='/api/health'&&safeMethods.has(req.method))return this.response({ok:true,ts:this.now()});
  let device;try{device=this.valid(req);}catch(error){return this.response({ok:false,error:'设备授权记录读取失败，请检查存储后重试'},503);}
  try{
   if(path==='/api/panel-auth/bootstrap'&&req.method==='GET'){
    if(device){const token=req.headers.get('x-monitor-token')||cookieValue(req,this.cookieName(req));return this.response({ok:true,token,device:this.view(device)});}
    if(!context.trustedUnix)return this.response({ok:false,error:'请先授权此设备',pairing_required:true},401);
    const issued=this.issue(req,'飞牛浏览器');return this.response({ok:true,token:issued.token,device:this.view(issued.device)},200,{'Set-Cookie':this.cookie(issued.token,req)});
   }
   if(path==='/api/panel-auth/pair'&&req.method==='POST'){
    const key=context.remoteAddress||'direct',attempt=this.failures.get(key);if(attempt&&attempt.until>this.now()&&attempt.count>=8)throw stateError('授权码尝试过多，请十分钟后重试',429);
    const body=await req.json(),code=String(body.code||'').trim(),data=this.file.read(),index=data.pairs.findIndex(p=>p.expires_at>this.now()&&same(p.hash,hash(code)));
    if(index<0){this.failures.set(key,{count:attempt&&attempt.until>this.now()?attempt.count+1:1,until:this.now()+600000});if(this.failures.size>1000)this.failures.delete(this.failures.keys().next().value);throw stateError('授权码无效或已过期，请在已登录的面板重新生成',401);}
    data.pairs.splice(index,1);this.file.write(data);const issued=this.issue(req,body.name||'独立面板浏览器');this.failures.delete(key);return this.response({ok:true},200,{'Set-Cookie':this.cookie(issued.token,req)});
   }
   if(path==='/api/panel-auth/code'&&req.method==='POST'){
    if(!device)throw stateError('请先通过飞牛登录面板',401);const data=this.file.read(),code=this.random().slice(0,24),now=this.now();data.pairs=data.pairs.filter(p=>p.expires_at>now);if(data.pairs.length>=10)data.pairs.shift();data.pairs.push({hash:hash(code),expires_at:now+600000,by:device.id});this.file.write(data);return this.response({ok:true,code,expires_at:now+600000});
   }
   if(path==='/api/panel-auth/devices'&&req.method==='GET'){
    if(!device)throw stateError('请先登录面板',401);return this.response({ok:true,current:device.id,devices:this.file.read().devices.filter(d=>d.expires_at>this.now()).map(d=>this.view(d))});
   }
   if(path==='/api/panel-auth/revoke'&&req.method==='POST'){
    if(!device)throw stateError('请先登录面板',401);const body=await req.json(),data=this.file.read();if(!data.devices.some(d=>d.id===body.id))throw stateError('设备授权不存在',404);data.devices=data.devices.filter(d=>d.id!==body.id);this.file.write(data);this.disconnect(body.id,context.response);return this.response({ok:true,current:body.id===device.id},200,body.id===device.id?{'Set-Cookie':this.cookie('',req,true)}:{});
   }
   // Static application assets contain no user data. Everything else, including
   // read APIs, file previews, custom routes and upstream proxies, needs a device.
   const publicAsset=safeMethods.has(req.method)&&/^\/(?:css|js|images|scripts)\//.test(path)&&!decodeURIComponent(path).includes('..');
   if(publicAsset)return null;
   if(!device){
    if((path==='/'||path==='/index.html')&&req.method==='GET'){
     if(context.trustedUnix)return null;
     return new Response(this.loginPage(req),{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
    }
    return this.response({ok:false,error:'设备授权已失效，请重新登录面板',pairing_required:true},401);
   }
   return null;
  }catch(error){return this.response({ok:false,error:error.status?error.message:'设备授权操作失败，请重试'},error.status||500);}
 }
 view(device){return {id:device.id,name:device.name,created_at:device.created_at,expires_at:device.expires_at,service:!!device.service};}
 loginPage(req){const base=new URL(req.url).pathname.startsWith(this.basePath+'/')?this.basePath:'';return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>授权设备 · Hermes</title><style>body{margin:0;background:#131b23;color:#e9eef3;font:16px/1.6 system-ui;min-height:100dvh;display:grid;place-items:center}main{box-sizing:border-box;width:min(460px,100%);padding:32px}h1{font-size:26px}p{color:#bac8d5}label{display:block;margin:18px 0}input,button{box-sizing:border-box;width:100%;padding:14px;border:1px solid #415361;border-radius:10px;font:inherit;background:#1d2b36;color:inherit}button{background:#6cd9bf;color:#122c27;cursor:pointer}#feedback{min-height:28px;color:#ffb5ad}</style><main><h1>授权此设备</h1><p>在已登录的飞牛 Hermes 面板，进入「偏好设置 → 设备授权」生成授权码，再填到这里。授权有效期为30天，可随时撤销。</p><form><label>设备名称<input name="name" maxlength="60" value="我的浏览器" autocomplete="off"></label><label>一次性授权码<input name="code" required autocomplete="off" autocapitalize="none" spellcheck="false"></label><button>连接面板</button><p id="feedback" role="status"></p></form></main><script>document.querySelector('form').onsubmit=async function(e){e.preventDefault();var b=this.querySelector('button'),f=document.getElementById('feedback');b.disabled=true;f.textContent='正在授权…';try{var r=await fetch(${JSON.stringify(base+'/api/panel-auth/pair')},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:this.name.value,code:this.code.value})});var d=await r.json();if(!r.ok)throw Error(d.error);location.reload();}catch(e){f.textContent=e.message;}finally{b.disabled=false;}};</script></html>`;}
}
