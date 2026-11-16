import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {lookup} from 'node:dns/promises';
import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {isIP} from 'node:net';
import {readFileSync,writeFileSync,mkdirSync,renameSync} from 'node:fs';
import {createModelSource} from './panel-model-checks.js';
function privateIPv4(address){
 if(isIP(address)!==4)return false;
 const [a,b]=address.split('.').map(Number);
 return a===10||a===127||a===172&&b>=16&&b<=31||a===192&&b===168;
}
function modelEndpoint(base){
 const url=new URL(base);
 const literal=url.hostname.replace(/^\[|\]$/g,'');
 const localHttp=url.protocol==='http:'&&privateIPv4(literal);
 if((url.protocol!=='https:'&&!localHttp)||url.username||url.password||url.hash)throw Error('模型发现只允许 HTTPS 公网服务，或明确填写 IP 的 HTTP 内网服务');
 let pth=url.pathname.replace(/\/+$/,'');if(!pth.endsWith('/models'))pth+='/models';url.pathname=pth;url.search='';return url.href;
}
function publicIPv4(address){
 if(isIP(address)!==4)return false;
 const [a,b]=address.split('.').map(Number);
 const c=Number(address.split('.')[2]);
 return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===0||b===2||b===88&&c===99||b===168)||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113);
}
/* 本机全部流量走 Clash TUN，域名会被解析成 198.18.x.x 的 fake-ip 占位地址。
   这类地址不是内网目标：连接仍然按域名进 TUN，由代理决定去哪。
   以前一刀切按「公网 IPv4」过滤，导致「获取模型」在这台机器上必然失败
   （2026-11-12 实测 direct.saviour.cc.cd → 198.18.5.117 → 被拒）。
   只对「用户填的是域名、且解析结果全落在 198.18.0.0/15」的情况放行，
   字面 IP 依旧走原有公网/内网判定。 */
function fakeIPv4(address){
 if(isIP(address)!==4)return false;
 const [a,b]=address.split('.').map(Number);
 return a===198&&(b===18||b===19);
}
async function pinnedHttpsFetch(url,options){
 const target=new URL(url),literal=target.hostname.replace(/^\[|\]$/g,''),localHttp=target.protocol==='http:'&&privateIPv4(literal);
 const records=localHttp?[{address:literal}]:await lookup(target.hostname,{all:true,verbatim:true}),addresses=records.filter(record=>publicIPv4(record.address));
 const fake=isIP(literal)?[]:records.filter(record=>fakeIPv4(record.address));
 if(!localHttp&&!addresses.length&&!fake.length)throw Error('模型服务地址没有可用的公网 IPv4 地址，已拒绝连接');
 const selected=localHttp?records[0]:(addresses[0]||fake[0]),request=target.protocol==='http:'?httpRequest:httpsRequest;
  /* 只有拿到合法 IP 才钉住解析结果；拿不到就交回系统解析，绝不把 undefined 甩给 net
     （2026-11-12 实测：钉住值可能为空，net 会直接抛 Invalid IP address: undefined）。 */
  const pin=selected&&isIP(String(selected.address))?String(selected.address):null;
  /* 2026-11-16：加了 POST。单模型连通测试要发一条最小的 chat 请求 ——
     只靠 GET /v1/models 看不出欠费和限流（中转站的清单接口基本不校验余额，
     要到真正对话时才报），这里必须能把 body 发出去。 */
  const payload=typeof options.body==='string'?options.body:null;
  const headers={...(options.headers||{})};
  if(payload)headers['Content-Length']=String(Buffer.byteLength(payload));
  const reqOptions={method:options.method||'GET',headers,...(target.protocol==='https:'?{servername:target.hostname}:{})};
  if(pin)reqOptions.lookup=(_host,lookupOptions,callback)=>lookupOptions&&lookupOptions.all?callback(null,[{address:pin,family:4}]):callback(null,pin,4);
 return new Promise((resolve,reject)=>{
  const req=request(target,reqOptions,res=>{
   /* 2026-11-16：1MB → 16MB。这个上限原本只服务 GET /v1/models（列表就几百 KB），
      现在同一个通道还要发画图请求 —— nano-banana-pro 一张图回来是 2.1MB 的
      data:image/png，1MB 直接把响应砍断、抛「模型列表超过大小限制」，生图模型
      于是永远测不出来。16MB 是给多图/大图留的余量，再大就是上游异常了。 */
   const chunks=[];let size=0;res.on('data',chunk=>{size+=chunk.length;if(size>16*1024*1024){req.destroy(Error('上游响应超过大小限制'));return;}chunks.push(chunk);});
   res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode||502,headers:res.headers})));res.on('error',reject);
  });
  const abort=()=>req.destroy(options.signal.reason||Error('请求已取消'));
  if(options.signal.aborted)abort();else options.signal.addEventListener('abort',abort,{once:true});
  req.on('close',()=>options.signal.removeEventListener('abort',abort));req.on('error',reject);req.end(payload||undefined);
 });
}
async function discoverModels(body,{fetcher=fetch,timeoutMs=12000,maxBytes=1024*1024}={}){
 const base=String(body.base_url||'').trim(),key=String(body.api_key||'').trim();
 if(!base)throw Error('请先填写服务地址');
 if(!key)throw Error('获取模型需要填写 API 密钥');
 const endpoint=modelEndpoint(base),headers={Authorization:'Bearer '+key,Accept:'application/json'};
 if(body.api_mode==='anthropic_messages'){delete headers.Authorization;headers['x-api-key']=key;headers['anthropic-version']='2023-06-01';}
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
 try{
  const response=await fetcher(endpoint,{headers,signal:controller.signal,redirect:'error'});
  if(!response.ok)throw Error(response.status===401||response.status===403?'服务拒绝了该密钥（HTTP '+response.status+'）':'服务返回 HTTP '+response.status);
  if(!response.body)throw Error('服务没有返回模型列表');
  let raw='',size=0;const reader=response.body.getReader(),decoder=new TextDecoder();
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes)throw Error('模型列表超过大小限制');raw+=decoder.decode(value,{stream:true});}raw+=decoder.decode();}finally{await reader.cancel().catch(()=>{});}
  let data;try{data=JSON.parse(raw);}catch(_){throw Error('服务没有返回有效的 JSON 模型列表');}
  const rows=Array.isArray(data)?data:Array.isArray(data.data)?data.data:Array.isArray(data.models)?data.models:null;
  if(!rows)throw Error('响应中没有模型列表');
  const seen=new Set(),models=[];
  for(const row of rows){const id=typeof row==='string'?row:row?.id||row?.name;if(typeof id!=='string'||!id.trim()||id.length>500||seen.has(id.trim()))continue;const value=id.trim();seen.add(value);models.push({id:value,name:typeof row==='object'&&typeof row.name==='string'&&row.name.trim()?row.name.trim().slice(0,200):value});if(models.length>=1000)break;}
  return {ok:true,models};
 }catch(error){if(error.name==='AbortError')throw Error('获取模型超时（12 秒），请检查地址和服务状态');if(error.message==='fetch failed'||!error.message)throw Error('无法连接模型服务，请检查地址和网络');throw error;}finally{clearTimeout(timer);}
}
/* 和 modelEndpoint 一样的地址校验（只放行 HTTPS 公网 / 显式 IP 的 HTTP 内网），
   但拼的是对话端点而不是清单端点。 */
function apiEndpoint(base,suffix){
 const url=new URL(base);
 const literal=url.hostname.replace(/^\[|\]$/g,'');
 const localHttp=url.protocol==='http:'&&privateIPv4(literal);
 if((url.protocol!=='https:'&&!localHttp)||url.username||url.password||url.hash)throw Error('只允许 HTTPS 公网服务，或明确填写 IP 的 HTTP 内网服务');
 let pth=url.pathname.replace(/\/+$/,'');
 if(!pth.endsWith(suffix))pth+=suffix;
 url.pathname=pth;url.search='';return url.href;
}

/* 连通结果的分类表。用户原话：「比如 200 404 之类的我不太懂」——
   所以对外只给一个短标签（可用 / 欠费 / 限流 / 无此模型 / 密钥失效 / 超时 /
   连不上 / 上游异常），HTTP 码塞进 detail 备查，不往脸上糊。
   判据是「状态码 + 错误体关键词」双份：
   · 只看状态码分不出「余额没了」和「并发超了」——中转站把上游的欠费包成 429，
     官方 OpenAI 也是 429 insufficient_quota，光凭 429 会误报成限流。
   · 只看关键词也不行，有些站只回状态码不带 message。
   所以先跑关键词表（更具体），没命中再按状态码兜底。 */
const PROBE_TEXT=[
 [/insufficient_quota|insufficient_balance|exceeded your current quota|余额不足|欠费|额度不足|quota exceeded/i,'billing','欠费'],
 [/rate.?limit|too many requests|concurren|并发|请求过于频繁|tpm|rpm/i,'ratelimit','限流'],
 [/model_not_found|does not exist|no such model|无可用渠道|模型不存在|unknown model|invalid model|pricing is not configured|no available channel/i,'nomodel','无此模型'],
 [/invalid.?api.?key|incorrect api key|无效的令牌|令牌无效|认证失败|unauthorized|api key not valid/i,'auth','密钥失效'],
 [/context.?length|maximum context|too many tokens|max_tokens/i,'ok','可用'],
 [/overloaded|internal server error|bad gateway|service unavailable|upstream/i,'upstream','上游异常']
];
function classifyProbe(status,text){
 const body=String(text||'').slice(0,4000);
 for(const [pattern,state,label] of PROBE_TEXT){if(pattern.test(body))return {state,label};}
 if(status===402)return {state:'billing',label:'欠费'};
 if(status===401||status===403)return {state:'auth',label:'密钥失效'};
 if(status===404)return {state:'nomodel',label:'无此模型'};
 if(status===429)return {state:'ratelimit',label:'限流'};
 if(status===408||status===504)return {state:'timeout',label:'超时'};
 if(status>=500)return {state:'upstream',label:'上游异常'};
 if(status===400)return {state:'rejected',label:'被拒绝'};
 return {state:'unknown',label:'未知'};
}

/* 模型类型：测出来的，不按名字猜。中转站挂什么名字都不奇怪（nano-banana-pro
   也可能是个纯文本代理），猜错的标签比没有更坏。三种判据：
     image —— 响应里出现图片（data:image/、b64_json）
     tools —— 响应里出现 tool_calls（说明这条路上工具调用是通的）
     chat  —— 其余能正常回话的
   用户问过「官方有哪些分类」：Gemini 官方 models 页分 Gemini 4/3/2.5、Audio、
   Generative media、Tool and agent、Specialized task。前四类能测（生图/对话/
   工具/语音），Audio 要另发 /audio 请求、Specialized task 是 embedding 和 rerank
   这类，不在 chat 通路上 —— 所以这里只报测得出来的三种，宁可少标也不编。 */
function kindOf(raw){
 const text=String(raw||'');
 /* 图有几种回来法，只认一种就会把别家的 key 判错（2026-11-16 补）：
    ① data URI / b64_json —— OpenAI 生图接口的经典回法；
    ② 本机存的 CDN 图 —— 有的中转把图画好传对象存储，只回一个图片地址
       {"image_url":"https://…/x.png"} 或 {"data":[{"url":"https://…/x.png"}]}；
    ③ markdown 图片 —— 有的模型把结果当正文写回来 ![](https://…/x.png)。
    原来的判据只有 ①，接别家 key 时 ②③ 一律落成 chat，看面板就是「它是对话模型」，
    而它明明画了图。 */
 if(/data:image\/|"b64_json"/i.test(text))return 'image';
 if(/"(?:image_url|image|url)"\s*:\s*"https?:\/\/[^"]*\.(?:png|jpe?g|webp|gif|avif)/i.test(text))return 'image';
 if(/!\[[^\]]*\]\(\s*https?:\/\/[^)\s]+\.(?:png|jpe?g|webp|gif|avif)/i.test(text))return 'image';
 /* 工具调用也有三种写法：OpenAI 的 tool_calls（键）、老接口的 function_call（键）、
    Anthropic 的 tool_use（是 type 的值，"type":"tool_use"，不是键名）。只认第一种，
    走别的协议的 key 全判成 chat。 */
 if(/"(?:tool_calls|function_call)"\s*:/.test(text))return 'tools';
 if(/"type"\s*:\s*"tool_use"/.test(text))return 'tools';
 return 'chat';
}

/* 单模型连通测试：发一条最短的真画图请求（「画一只蓝色的鲸鱼」+ nonce），
   一次拿到三件事 —— 能不能用、为什么不能用、这个模型是生图还是对话。
   返回的 probe.state 才是结论；ok 只表示「测完了、没抛异常」。
   2026-11-16 两处改动：
   ① 超时 25 秒 → 90 秒。生图模型实测 26~35 秒，原来的 25 秒注定超时，
      「所有生图模型都失败」被误读成密钥坏了，实际是量的是对话模型的耐心。
   ② 顺带判类型（kindOf），并给生图留一条重试：让绘图模型「只回一句 ping」会被
      上游判成内容冲突（Content blocked；ZeroAPI 这类中转还有 24 小时 451 快照
      缓存，同一条 prompt 会连着失败），换一句真画图的请求才通。nonce 是为了
      每次都换一条 prompt，躲开那个缓存。
   ③ 第一发改成真画图（见函数内注释）—— 发 ping 判不出生图模型。
   导出给离线核验用：node -e 'import(...).then(m=>m.testModel({...}))'，
   这样改完不必重启 monitor 就能先验一遍判定对不对。 */
export async function testModel(body,{fetcher=pinnedHttpsFetch,timeoutMs=90000}={}){
 const base=String(body.base_url||'').trim(),model=String(body.model||'').trim(),key=String(body.api_key||'').trim();
 if(!base)throw Error('这个模型没有服务地址');
 if(!model)throw Error('没有指定要测哪个模型');
 if(!key)throw Error('这个服务没有可用的密钥');
 const anthropic=body.api_mode==='anthropic_messages';
 const endpoint=apiEndpoint(base,anthropic?'/messages':'/chat/completions');
 const headers={'Content-Type':'application/json',Accept:'application/json'};
 if(anthropic){headers['x-api-key']=key;headers['anthropic-version']='2023-06-01';}
 else headers.Authorization='Bearer '+key;
 async function once(payload,limit){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),limit);
  const started=Date.now();
  try{
   const response=await fetcher(endpoint,{method:'POST',headers,body:JSON.stringify(payload),signal:controller.signal});
   const ms=Date.now()-started;
   let raw='';try{raw=await response.text();}catch(_){}
   return {ok:response.ok,status:response.status,ms,raw,aborted:false,network:''};
  }catch(error){
   const ms=Date.now()-started;
   if(error&&error.name==='AbortError')return {ok:false,status:0,ms,raw:'',aborted:true,network:''};
   const message=String(error&&error.message||'');
   if(/fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network|证书|certificate/i.test(message))
    return {ok:false,status:0,ms,raw:'',aborted:false,network:message};
   throw error;
  }finally{clearTimeout(timer);}
 }
 /* 2026-11-16：第一发就直接画，不再发 ping。
    文本 ping 判不出生图模型 —— 实测 nano-banana-pro 收到 ping 会当普通对话回
    一句话（45.7s、HTTP 200），kindOf 于是判成 chat；它真画图是 33.3s、回 2.1MB
    的 data:image/png。而下面那条「被拦了才换画图」的重试只有内容冲突/451 的
    模型才走得到，正常回话的生图模型永远进不去 —— 等于永久漏标一类。
    nonce 仍用来躲 451 快照缓存；图片走 content 里的 data URI，不占 max_tokens。 */
 const brief='画一只蓝色的鲸鱼。Nonce '+Date.now();
 const ask=anthropic
  ?{model,max_tokens:512,messages:[{role:'user',content:brief}]}
  :{model,max_tokens:512,stream:false,messages:[{role:'user',content:brief}]};
 const first=await once(ask,timeoutMs);
 if(first.ok)return {ok:true,probe:{state:'ok',label:'可用',code:first.status,ms:first.ms,kind:kindOf(first.raw)}};
 if(first.network)return {ok:true,probe:{state:'network',label:'连不上',code:0,ms:first.ms,detail:first.network.slice(0,200)}};
 /* 超时或被判内容冲突 —— 这两种都是生图/多模态模型对「只回一句话」的标准反应 */
 const blocked=first.aborted||/content blocked|content polic|HTTP 451|rejected by the upstream|prohibited/i.test(first.raw);
 if(blocked){
  const brief2='画一个蓝色圆点。Nonce '+Date.now();
  const draw=anthropic
   ?{model,max_tokens:2048,messages:[{role:'user',content:brief2}]}
   :{model,max_tokens:2048,stream:false,messages:[{role:'user',content:brief2}]};
  const second=await once(draw,timeoutMs);
  if(second.ok)return {ok:true,probe:{state:'ok',label:'可用',code:second.status,ms:second.ms,kind:kindOf(second.raw)}};
  if(second.network)return {ok:true,probe:{state:'network',label:'连不上',code:0,ms:second.ms,detail:second.network.slice(0,200)}};
  if(second.aborted)return {ok:true,probe:{state:'timeout',label:'超时',code:0,ms:second.ms}};
  const retry=classifyProbe(second.status,second.raw);
  return {ok:true,probe:{state:retry.state,label:retry.label,code:second.status,ms:second.ms,detail:second.raw.slice(0,300)}};
 }
 if(first.aborted)return {ok:true,probe:{state:'timeout',label:'超时',code:0,ms:first.ms}};
 const verdict=classifyProbe(first.status,first.raw);
 return {ok:true,probe:{state:verdict.state,label:verdict.label,code:first.status,ms:first.ms,detail:first.raw.slice(0,300)}};
}

export function createModelsService({python,serverRoot,getConfig,state,varRoot,changed=()=>{},start=spawn,fetcher=pinnedHttpsFetch}){
 const modelSource=createModelSource({python,serverRoot,getConfig,varRoot,start});
 /* 模型能力实测结果的落盘（2026-11-16 加）。
    背景：testModel 每次真打一发「画一只蓝色的鲸鱼」来判 kind（image/tools/chat），
    判得很准（连 nano-banana-pro 会当对话回一句话这种坑都写进注释了），但结果只存在
    前端内存 probe{} 里，刷新页面就清空 —— 用户看到的是「明明测过，一刷新又不知道
    这模型是干什么的了」。
    这里把它持久化：测一次记一次，重启/换设备都还在。文件放面板自己的 state 里，
    不写 config.yaml（那是内核配置，多一个面板私有字段会污染内核解析）。 */
 const kindsPath=()=>join(varRoot||state||'.','panel-state','model-kinds.json');
 function readKinds(){
  try{
   const obj=JSON.parse(readFileSync(kindsPath(),'utf8'));
   const models=obj&&typeof obj==='object'&&obj.models&&typeof obj.models==='object'?obj.models:{};
   return {models};
  }catch(_){return {models:{}};}
 }
 function writeKinds(models){
  if(!models||typeof models!=='object')throw Error('模型能力记录格式不对');
  const target=kindsPath();
  mkdirSync(join(target,'..'),{recursive:true});
  const tmp=target+'.tmp';
  writeFileSync(tmp,JSON.stringify({v:1,models}),'utf8');
  renameSync(tmp,target);
 }
 /* 单条写入：只收 image/tools/chat 三个值，其余一律拒。宁可少记一个，
    也别把 'unknown' 之类塞进去污染后面按能力筛选的清单。 */
 function saveKind(body){
  const keyId=String(body.provider_id||'').trim();
  const model=String(body.model||'').trim();
  const kind=String(body.kind||'').trim();
  if(!model)throw Error('没有指定模型');
  if(!['image','tools','chat'].includes(kind))throw Error('不认识的模型类型：'+kind);
  const all=readKinds().models;
  all[keyId+'|'+model]={kind,at:Date.now(),code:Number(body.code)||0,ms:Number(body.ms)||0};
  writeKinds(all);
  return {ok:true,key:keyId+'|'+model,kind};
 }
 async function execute(body){
  const result=await new Promise(resolve=>{
   const child=start(python,['-B',join(serverRoot,'panel-models.py'),getConfig(),state,...(varRoot?[varRoot]:[])],{stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});let output='',done=false;
   const finish=data=>{if(done)return;done=true;clearTimeout(timer);resolve(data);};const timer=setTimeout(()=>{child.kill();finish({ok:false,error:'模型配置处理超时，请刷新核对',status:504});},15000);
   child.stdout.on('data',part=>{output+=part;if(Buffer.byteLength(output)>2*1024*1024){child.kill();finish({ok:false,error:'模型配置内容过大',status:413});}});child.stderr.resume();child.stdin.on('error',()=>{});child.on('error',()=>finish({ok:false,error:'模型配置服务无法启动',status:503}));child.on('close',()=>{try{finish(JSON.parse(output));}catch(_){finish({ok:false,error:'模型配置未收到处理结果，请刷新核对',status:502});}});child.stdin.end(JSON.stringify(body));
  });
  if(result.ok&&result.changed){try{changed('模型服务与路线');}catch(_){return {...result,ok:false,saved:true,error:'模型配置已保存，但待应用记录未写入，请刷新核对后重启应用',status:503};}}
  return result;
 }
 return {execute,async handle(req,path,checkToken){
  if(path!=='/api/panel-models')return null;
  const reply=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
  if(!checkToken(req))return reply({ok:false,error:'请重新登录后管理模型'},401);
  if(!['GET','POST'].includes(req.method))return reply({ok:false,error:'不支持此操作'},405);
  try{const body=req.method==='GET'?{action:'read'}:await req.json();if(JSON.stringify(body).length>512000)return reply({ok:false,error:'模型配置修改内容过长'},413);if(body.action==='kinds'){try{return reply({ok:true,models:readKinds().models});}catch(error){return reply({ok:false,error:(error&&error.message)||'读不到模型能力记录'},500);}}if(body.action==='save_kind'){try{return reply(saveKind(body));}catch(error){return reply({ok:false,error:(error&&error.message)||'记不下这个模型的能力'},400);}}if(body.action==='test_model'){try{let key=body.api_key;if(body.provider_id&&body.use_saved_credential===true){const stored=await modelSource({action:'resolve',provider:body.provider_id,model:''});if(stored.target.base_url.replace(/\/+$/,'')!==String(body.base_url||'').trim().replace(/\/+$/,''))throw Error('服务地址改过了，填上新密钥再测');key=stored.target.api_key;}return reply(await testModel({...body,api_key:key},{fetcher}));}catch(error){const msg=(error&&error.message)||'连通测试失败';if(/密钥环境变量尚未配置|凭证文件|密钥未配置|未配置密钥/.test(msg))return reply({ok:true,probe:{state:'nokey',label:'未配置',code:0,ms:0,detail:msg}});return reply({ok:false,error:msg},400);}}if(body.action==='discover'){try{let key=body.api_key;if(body.provider_id&&body.use_saved_credential===true){const stored=await modelSource({action:'resolve',provider:body.provider_id,model:body.model||''});if(stored.target.base_url.replace(/\/+$/,'')!==String(body.base_url||'').trim().replace(/\/+$/,''))throw Error('服务地址已修改，请填写新密钥后获取模型');key=stored.target.api_key;}return reply(await discoverModels({...body,api_key:key},{fetcher}));}catch(error){return reply({ok:false,error:error.message||'获取模型失败'},400);}}const result=await execute(body);return reply(result,result.ok?200:result.status||500);}catch(_){return reply({ok:false,error:'模型配置请求格式不正确'},400);}
 }};
}

// Every chat keeps the agent/tool path. A stale explicit choice must never
// silently select another provider or become a direct provider request.
export function resolveModelRoutes(config,override){
 if(!config?.ok)throw Error(config?.error||'无法读取模型配置');
 if(override?.model&&override.model!=='auto'&&!override.provider){
  const matches=config.providers.filter(p=>p.enabled&&p.models.some(m=>m.id===override.model&&m.enabled!==false));
  if(matches.length!==1)throw Error('此模型没有唯一对应的服务，请重新选择服务与模型');
  override={...override,provider:matches[0].id};
 }
 if(override?.provider){
  const selected=override.provider.startsWith('custom:')?override.provider.slice(7):override.provider;
  const names=config.providers.filter(p=>p.name===selected);
  const provider=config.providers.find(p=>p.id===selected)||(names.length===1?names[0]:null);
  if(!provider||!provider.enabled)throw Error('会话所选模型服务已停用或不存在，请重新选择');
  const model=override.model&&override.model!=='auto'?override.model:provider.model;
  if(!provider.models.some(m=>m.id===model&&m.enabled!==false))throw Error('会话所选模型已停用或不在列表中，请重新选择');
  return [{...provider,model,viaGateway:true,gatewayProvider:'custom:'+provider.id}];
 }
 if(!config.primary?.provider||!config.primary?.model)throw Error('请先设置默认服务和模型');
 const primaryId=config.primary.provider.replace(/^custom:/,'');
 const provider=config.providers.find(p=>p.id===primaryId);
 if(provider&&(!provider.enabled||!provider.models.some(m=>m.id===config.primary.model&&m.enabled!==false)))throw Error('默认模型路线已失效，请检查模型配置');
 // Gateway owns its fallback chain. Monitor must not retry the entire agent
 // conversation against another provider after tools may already have run.
 return [{...(provider||{id:config.primary.provider,name:config.primary.provider}),model:config.primary.model,viaGateway:true}];
}
