import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {appendFileSync,statSync,renameSync} from 'node:fs';
import {StateFile,stateError} from './panel-state.js';

const COOKIE='hermes_panel_device';
const hash=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b)=>{if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;const left=Buffer.from(a),right=Buffer.from(b);return left.length===right.length&&timingSafeEqual(left,right);};
const safeMethods=new Set(['GET','HEAD','OPTIONS']);
// ── 鉴权取证日志 ──
// 401/403 全记（异常要留痕）；200 只在「首次见到这个设备/来源」时留一行——
// 前端每秒轮询 status/chat-queue/gateway-health/panel-runtime-status 四个接口，
// 逐条记会在请求路径上做同步写盘，实测 7 天灌到 14 MB / 44k 行，其中 97% 是正常流量。
const DEBUG_LOG=(process.env.TRIM_PKGVAR||'/vol1/@appdata/hermes-agent')+'/panel-auth-debug.log';
const DEBUG_LOG_MAX=5*1024*1024;
let debugLogSize=-1;
function rotateDebugLog(){
 try{
  if(debugLogSize<0){try{debugLogSize=statSync(DEBUG_LOG).size;}catch{debugLogSize=0;}}
  if(debugLogSize<DEBUG_LOG_MAX)return true;
  try{renameSync(DEBUG_LOG,DEBUG_LOG+'.1');}catch{}
  debugLogSize=0;
  return true;
 }catch{return true;}
}
// 200 去重：同一 note+来源只落一次，防止轮询把盘写满。
const seenOkNotes=new Set();
function dbgOk(req,context,note,id){
 try{
  const key=note+'|'+(id||(context&&context.remoteAddress)||'');
  if(seenOkNotes.has(key))return;
  if(seenOkNotes.size>200)seenOkNotes.clear();
  seenOkNotes.add(key);
  dbgAuth(req,context,200,note);
 }catch{}
}
function dbgAuth(req,context,code,note){
 if(!rotateDebugLog())return;
 try{
  const cookie=String(req.headers.get('cookie')||'');
  const line=JSON.stringify({t:new Date().toISOString(),code,note,m:req.method,
   path:new URL(req.url).pathname,unix:!!(context&&context.trustedUnix),remote:(context&&context.remoteAddress)||'',
   origin:req.headers.get('origin')||'',fs:req.headers.get('sec-fetch-site')||'',
   ck:cookie.includes(COOKIE),hdr:!!req.headers.get('x-monitor-token'),
   fh:req.headers.get('x-forwarded-host')||'',host:req.headers.get('host')||'',
   ua:String(req.headers.get('user-agent')||'').slice(0,70)});
  appendFileSync(DEBUG_LOG,line+'\n');debugLogSize+=Buffer.byteLength(line)+1;
 }catch{}
}
// 局域网/本机来源：没有飞牛网关签名也要能自助发设备，否则原生壳永远卡在 bootstrap 401。
function localSource(context){
 const raw=String((context&&context.remoteAddress)||'').replace(/^::ffff:/,'');
 // 2026-11-17：127.0.0.1 的 TCP 不再自动信任。frp / 端口转发隧道进来时对端也是 127.0.0.1，
 // 公网访问会被误判成内网并自动发设备（2026-11-17 实测公网隧道入口直接拿到 token）。
 // 真本机走的是 fnOS gateway 的 unix socket（trustedUnix），不受影响；
 // 局域网 192.168.x 仍照旧放行。
 if(!raw)return true;
 if(raw==='unix')return true;
 if(raw==='::1'||raw==='127.0.0.1')return false;
 return /^10\./.test(raw)||/^192\.168\./.test(raw)||/^172\.(1[6-9]|2\d|3[01])\./.test(raw);
}
export function panelPath(url,base='') {let path=new URL(url).pathname;if(base&&path.startsWith(base+'/'))path=path.slice(base.length);else if(path===base)path='/';return path;}
function cookieValue(req,name=COOKIE){const matches=String(req.headers.get('cookie')||'').split(';').map(v=>v.trim()).filter(v=>v.startsWith(name+'='));return matches.length===1?matches[0].slice(name.length+1):'';}
function authority(value){try{const url=new URL('http://'+value);return url.username||url.password||url.pathname!=='/'||url.search||url.hash?'':url.host.toLowerCase();}catch{return '';}}
export function sameOrigin(req,{trustedUnix=false}={}){
 const origin=req.headers.get('origin'),fetchSite=req.headers.get('sec-fetch-site');
 if(fetchSite==='cross-site')return false;
 // Safari / WKWebView 对同源请求会明示 sec-fetch-site: same-origin 或 none，
 // 这比 Origin 更可靠 —— 原生壳里 Origin 常常是 null 而不是主机名。
 if(fetchSite==='same-origin'||fetchSite==='none')return true;
 if(!origin)return true;
 // Origin: null 是不透明来源（file:// / about:blank / 沙箱 WebView），
 // new URL('null') 会抛异常，旧逻辑直接判假 → 带着有效 cookie 也回 401。
 if(origin==='null')return safeMethods.has(req.method);
 let parsed;try{parsed=new URL(origin);}catch{return false;}
 // 原生壳 WebView（飞牛 App / Capacitor / file://）的 Origin 不是 http(s)，没有主机名
 // 可比，旧逻辑一律判假 —— 于是带着有效设备也只回「设备授权已失效」。这类来源只放行
 // 安全方法；写操作必须携带显式 x-monitor-token（见 valid / gate）。
 if(!['http:','https:'].includes(parsed.protocol))return safeMethods.has(req.method);
 if(parsed.origin!==origin)return false;
 const hosts=[authority(req.headers.get('host')||new URL(req.url).host)];
 if(trustedUnix){const forwarded=req.headers.get('x-forwarded-host');if(forwarded&&!forwarded.includes(','))hosts.push(authority(forwarded));}
 return hosts.filter(Boolean).includes(parsed.host.toLowerCase());
}
export class PanelAuth{
 constructor({file,legacyToken,basePath='',now=Date.now,random=()=>randomBytes(32).toString('base64url')}){Object.assign(this,{legacyToken,basePath,now,random});this.file=new StateFile(file,()=>({version:1,devices:[],pairs:[]}),{validate:d=>d&&d.version===1&&Array.isArray(d.devices)&&Array.isArray(d.pairs)});this.context=new WeakMap();this.failures=new Map();this.connections=new Map();this.autoIssued=new Map();this.decided=new WeakMap();}
 remember(req,context){this.context.set(req,context);return req;}
 contextOf(req){return this.context.get(req)||{};}
 // cookie 名不能依赖请求路径：旧逻辑按「路径是否以 basePath/ 开头」决定要不要 _fnos 后缀，
 // 于是 /app/hermes-agent（无尾斜杠）和 /app/hermes-agent/（有尾斜杠）算出两个不同的 cookie 名，
 // pair 时写一个、reload 后读另一个，用户在这两个 URL 间跳一次就永久 401。
 // 2026-11-17 ai.ruibing.wang 实测：pair 成功建了设备（auth.json 里查得到），
 // 日志里 cookie 也确实发了，却一直判 no-device —— 就是名字对不上。
 // 只要配置了 basePath 就固定用带后缀的名字。
 cookieName(req){return COOKIE+(this.basePath?'_fnos':'');}
 track(req,connection){const device=this.valid(req);if(!device||device.service)return;let set=this.connections.get(device.id);if(!set){set=new Set();this.connections.set(device.id,set);}set.add(connection);const timer=setInterval(()=>{if(device.expires_at<=this.now())connection.destroy();},60000);timer.unref?.();const clean=()=>{clearInterval(timer);set.delete(connection);if(!set.size)this.connections.delete(device.id);};connection.once('close',clean);connection.once('finish',clean);}
 disconnect(id,except){for(const connection of this.connections.get(id)||[])if(connection!==except)connection.destroy();}
 valid(req){
  // gate() 已经放行的同一个请求：把结论记在 req 上，避免下游 handler 再跑一次
  // valid() 时因为 cookie 是失效/刚补发而第二次判 401（冷启动底部那条 Unauthorized (HTTP 401)）。
  const decided=this.decided.get(req);if(decided)return decided;
  const header=req.headers.get('x-monitor-token')||'',cookie=cookieValue(req,this.cookieName(req));
  if(this.legacyToken&&same(header,this.legacyToken))return {id:'local-service',name:'本机维护凭证',service:true};
  const now=this.now(),devices=this.file.read().devices.filter(d=>d.expires_at>now);
  const match=token=>/^[A-Za-z0-9_-]{43}$/.test(token)?(devices.find(d=>same(d.token_hash,hash(token)))||null):null;
  // 显式头凭证不会被浏览器自动携带，跨站页面无法伪造，因此不受同源校验约束。
  const byHeader=match(header);if(byHeader)return byHeader;
  // cookie 由浏览器自动附带，必须过同源校验。头凭证失效时回落到 cookie ——
  // 前端持久化的旧 token 不能把仍然有效的 cookie 顶掉。
  if(!sameOrigin(req,this.contextOf(req)))return null;
  return match(cookie);
 }
 cookie(token,req,remove=false){const secure=req.headers.get('origin')?.startsWith('https:')||req.headers.get('x-forwarded-proto')==='https';
 // Path 不能带尾斜杠：RFC 6265 里 Path=/app/hermes-agent/ 不匹配请求路径 /app/hermes-agent，
 // 用户少打一个斜杠浏览器就不发这个 cookie（2026-11-17 实测：带斜杠是主面板，去掉斜杠立刻回授权墙）。
 // 用不带尾斜杠的 basePath，/app/hermes-agent、/app/hermes-agent/、/app/hermes-agent/api/x 三者都匹配。
 // 统一 Path=/：根路径直连（https://ai.ruibing.wang/）和子路径入口（/app/hermes-agent/）
 // 都要能读到同一个 cookie。按 basePath 设 Path 会让根路径场景永远读不到刚下发的 cookie
 // —— 用户输完授权码 reload 回 / 就又掉回授权墙（2026-11-17 实测）。
 // cookie 名带 _fnos 后缀已经足够独特，不会和同域其它应用撞。
 const path='/';return this.cookieName(req)+'='+token+'; Path='+path+'; HttpOnly; SameSite=Lax; Max-Age='+(remove?0:30*86400)+(secure?'; Secure':'');}
 issue(req,name){const token=this.random(),now=this.now(),data=this.file.read();const device={id:randomBytes(12).toString('hex'),name:String(name||'此浏览器').trim().slice(0,60)||'此浏览器',token_hash:hash(token),created_at:now,expires_at:now+30*86400000};data.devices=data.devices.filter(d=>d.expires_at>now);const sameName=data.devices.filter(d=>d.name===device.name).sort((a,b)=>b.created_at-a.created_at);if(sameName.length>=5){const drop=new Set(sameName.slice(4).map(d=>d.id));data.devices=data.devices.filter(d=>!drop.has(d.id));}if(data.devices.length>=100){data.devices=data.devices.slice(data.devices.sort((a,b)=>a.created_at-b.created_at).length-99);}data.devices.push(device);this.file.write(data);return {token,device};}
 response(body,status=200,headers={}){return new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}});}
 async gate(req){
  const context=this.contextOf(req),path=panelPath(req.url,this.basePath);
  // 带显式头凭证的请求不是 CSRF 载体（跨站无法设置自定义头，且预检不通过），
  // 因此不做同源拦截 —— 否则原生壳 WebView 里连发消息都会被 403 挡掉。
  if(!req.headers.get('x-monitor-token')&&!sameOrigin(req,context)){dbgAuth(req,context,403,'origin');return this.response({ok:false,error:'请从当前面板页面发起操作'},403);}
  if(req.method==='OPTIONS')return new Response(null,{status:204,headers:{'Cache-Control':'no-store'}});
  if(path==='/api/health'&&safeMethods.has(req.method))return this.response({ok:true,ts:this.now()});
  let device;try{device=this.valid(req);}catch(error){return this.response({ok:false,error:'设备授权记录读取失败，请检查存储后重试'},503);}
  try{
   if(path==='/api/panel-auth/bootstrap'&&req.method==='GET'){
    if(device){const token=req.headers.get('x-monitor-token')||cookieValue(req,this.cookieName(req));return this.response({ok:true,token,device:this.view(device)});}
    if(!context.trustedUnix&&!localSource(context)){dbgAuth(req,context,401,'boot-not-trusted');return this.response({ok:false,error:'请先授权此设备',pairing_required:true},401);}
    const issued=this.issue(req,'飞牛浏览器');return this.response({ok:true,token:issued.token,device:this.view(issued.device)},200,{'Set-Cookie':this.cookie(issued.token,req)});
   }
   if(path==='/api/panel-auth/pair'&&req.method==='POST'){
    const key=context.remoteAddress||'direct',attempt=this.failures.get(key);if(attempt&&attempt.until>this.now()&&attempt.count>=8)throw stateError('授权码尝试过多，请十分钟后重试',429);
    const body=await req.json(),code=String(body.code||'').trim(),data=this.file.read(),index=data.pairs.findIndex(p=>p.expires_at>this.now()&&same(p.hash,hash(code)));
    if(index<0){this.failures.set(key,{count:attempt&&attempt.until>this.now()?attempt.count+1:1,until:this.now()+600000});if(this.failures.size>1000)this.failures.delete(this.failures.keys().next().value);throw stateError('授权码无效或已过期，请在已登录的面板重新生成',401);}
    data.pairs.splice(index,1);this.file.write(data);const issued=this.issue(req,body.name||'独立面板浏览器');this.failures.delete(key);
    // 新设备接入是唯一的低频高价值事件：逐条审计，事后能查出哪台设备、从哪、何时被授权。
    dbgAuth(req,context,200,'device-paired:'+String(issued.device.name||'').slice(0,60));
    return this.response({ok:true},200,{'Set-Cookie':this.cookie(issued.token,req)});
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
   // 服务端自愈：cookie 指向的设备已被清理/过期时，旧前端不会再去 bootstrap，
   // 于是永远 401。可信来源（飞牛网关 unix 通道 / 局域网）在这里直接补发设备、
   // 把新 cookie 挂回本次响应，并照常放行 —— 不依赖前端版本。
   if(!device&&(context.trustedUnix||localSource(context))){
    const ua=String(req.headers.get('user-agent')||'').slice(0,60),key=(context.remoteAddress||'unix')+'|'+ua,last=this.autoIssued.get(key)||0;
    if(this.now()-last>30000){
     try{
      const issued=this.issue(req,'飞牛浏览器');
      if(context.response&&typeof context.response.setHeader==='function'&&!context.response.headersSent)context.response.setHeader('Set-Cookie',this.cookie(issued.token,req));
      device=issued.device;this.autoIssued.set(key,this.now());
      if(this.autoIssued.size>500)this.autoIssued.delete(this.autoIssued.keys().next().value);
      dbgOk(req,context,'auto-issued',device.id);
     }catch{}
    }
    // 补发被节流时也不能回 401：一页会并发十几条请求，只有第一条拿得到新 cookie，
    // 其余若被拦，前端照样弹授权墙。网关/局域网来源本身已通过飞牛登录，不再二次拦。
    if(!device){device={id:'fnos-gateway',name:'飞牛网关会话',service:true};dbgOk(req,context,'gateway-pass',device.id);}
   }
   if(!device){
    if((path==='/'||path==='/index.html')&&req.method==='GET'){
     if(context.trustedUnix)return null;
     return new Response(this.loginPage(req),{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
    }
    dbgAuth(req,context,401,'no-device');return this.response({ok:false,error:'设备授权已失效，请重新登录面板',pairing_required:true},401);
   }
   this.decided.set(req,device);return null;
  }catch(error){return this.response({ok:false,error:error.status?error.message:'设备授权操作失败，请重试'},error.status||500);}
 }
 view(device){return {id:device.id,name:device.name,created_at:device.created_at,expires_at:device.expires_at,service:!!device.service};}
 loginPage(req){const base=new URL(req.url).pathname.startsWith(this.basePath+'/')?this.basePath:'';return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>授权设备 · Hermes</title><style>body{margin:0;background:#131b23;color:#e9eef3;font:16px/1.6 system-ui;min-height:100dvh;display:grid;place-items:center}main{box-sizing:border-box;width:min(460px,100%);padding:32px}h1{font-size:26px}p{color:#bac8d5}label{display:block;margin:18px 0}input,button{box-sizing:border-box;width:100%;padding:14px;border:1px solid #415361;border-radius:10px;font:inherit;background:#1d2b36;color:inherit}button{background:#6cd9bf;color:#122c27;cursor:pointer}#feedback{min-height:28px;color:#ffb5ad}</style><main><h1>授权此设备</h1><p>在已登录的飞牛 Hermes 面板，进入「偏好设置 → 设备授权」生成授权码，再填到这里。授权有效期为30天，可随时撤销。</p><form><label>设备名称<input name="name" maxlength="60" value="我的浏览器" autocomplete="off"></label><label>一次性授权码<input name="code" required autocomplete="off" autocapitalize="none" spellcheck="false"></label><button>连接面板</button><p id="feedback" role="status"></p></form></main><script>document.querySelector('form').onsubmit=async function(e){e.preventDefault();var b=this.querySelector('button'),f=document.getElementById('feedback');b.disabled=true;f.textContent='正在授权…';try{var r=await fetch(${JSON.stringify(base+'/api/panel-auth/pair')},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:this.name.value,code:this.code.value})});var d=await r.json();if(!r.ok)throw Error(d.error);location.reload();}catch(e){f.textContent=e.message;}finally{b.disabled=false;}};</script></html>`;}
}
