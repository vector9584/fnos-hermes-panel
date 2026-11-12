import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {lookup} from 'node:dns/promises';
import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {isIP} from 'node:net';
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
   （2026-11-12 实测 direct.provider.example → 203.0.113.7 → 被拒）。
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
  const reqOptions={method:'GET',headers:options.headers,...(target.protocol==='https:'?{servername:target.hostname}:{})};
  if(pin)reqOptions.lookup=(_host,lookupOptions,callback)=>lookupOptions&&lookupOptions.all?callback(null,[{address:pin,family:4}]):callback(null,pin,4);
 return new Promise((resolve,reject)=>{
  const req=request(target,reqOptions,res=>{
   const chunks=[];let size=0;res.on('data',chunk=>{size+=chunk.length;if(size>1024*1024){req.destroy(Error('模型列表超过大小限制'));return;}chunks.push(chunk);});
   res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode||502,headers:res.headers})));res.on('error',reject);
  });
  const abort=()=>req.destroy(options.signal.reason||Error('请求已取消'));
  if(options.signal.aborted)abort();else options.signal.addEventListener('abort',abort,{once:true});
  req.on('close',()=>options.signal.removeEventListener('abort',abort));req.on('error',reject);req.end();
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
export function createModelsService({python,serverRoot,getConfig,state,varRoot,changed=()=>{},start=spawn,fetcher=pinnedHttpsFetch}){
 const modelSource=createModelSource({python,serverRoot,getConfig,varRoot,start});
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
  try{const body=req.method==='GET'?{action:'read'}:await req.json();if(JSON.stringify(body).length>512000)return reply({ok:false,error:'模型配置修改内容过长'},413);if(body.action==='discover'){try{let key=body.api_key;if(body.provider_id&&body.model&&body.use_saved_credential===true){const stored=await modelSource({action:'resolve',provider:body.provider_id,model:body.model});if(stored.target.base_url.replace(/\/+$/,'')!==String(body.base_url||'').trim().replace(/\/+$/,''))throw Error('服务地址已修改，请填写新密钥后获取模型');key=stored.target.api_key;}return reply(await discoverModels({...body,api_key:key},{fetcher}));}catch(error){return reply({ok:false,error:error.message||'获取模型失败'},400);}}const result=await execute(body);return reply(result,result.ok?200:result.status||500);}catch(_){return reply({ok:false,error:'模型配置请求格式不正确'},400);}
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
