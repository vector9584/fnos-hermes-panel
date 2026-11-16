import * as fs from 'node:fs';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {StateFile, safeId, stateError} from './panel-state.js';

const PROMPT='Reply with exactly HERMES_OK and nothing else.';
export function createModelSource({python,serverRoot,getConfig,varRoot,start=spawn}){
 return body=>new Promise((resolve,reject)=>{
  const child=start(python,['-B',join(serverRoot,'panel-model-source.py'),getConfig(),varRoot],{stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
  let output='',settled=false;
  const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else resolve(result);};
  const timer=setTimeout(()=>{child.kill('SIGTERM');finish(stateError('读取模型配置超时',504));},10000);
  child.stdout.on('data',data=>{output+=data;if(output.length>1024*1024){child.kill('SIGTERM');finish(stateError('模型配置内容过大',502));}});
  child.stderr.resume();child.stdin.on('error',()=>{});
  child.on('error',()=>finish(stateError('模型配置读取进程无法启动',503)));
  child.on('close',code=>{try{const data=JSON.parse(output);if(code!==0||!data.ok)throw stateError(data.error||'读取模型配置失败',503);finish(null,data);}catch(error){finish(stateError(error.status?error.message:'模型配置返回格式不正确',error.status||502));}});
  child.stdin.end(JSON.stringify(body));
 });
}
function endpoint(base,route){const url=new URL(base);url.pathname=url.pathname.replace(/\/$/,'')+'/'+route;return url.href;}
function textContent(value){return typeof value==='string'?value:Array.isArray(value)?value.filter(p=>p.type==='text'||p.type==='output_text').map(p=>p.text||'').join(''):'';}
function extract(data,mode){
 if(data.error||data.type==='error'||data.status==='failed')throw stateError('服务返回了接口错误，未得到有效回复',502);
 if(mode==='anthropic_messages')return textContent(data.content);
 if(mode==='codex_responses')return data.output_text||(data.output||[]).filter(p=>p.type==='message').map(p=>textContent(p.content)).join('');
 return textContent(data.choices?.[0]?.message?.content);
}
export async function probeOnce(target,{signal,fetcher=fetch,timeoutMs=60000,prompt=PROMPT,maxTokens=2048,maxChars=16000}={}){
 const controller=new AbortController(),onAbort=()=>controller.abort(signal?.reason);let timedOut=false;
 if(signal?.aborted)onAbort();else signal?.addEventListener('abort',onAbort,{once:true});
 const timer=setTimeout(()=>{timedOut=true;controller.abort();},timeoutMs),started=Date.now();
 try{
  const headers={'Content-Type':'application/json',...target.headers};
  if(target.api_key)headers.Authorization='Bearer '+target.api_key;
  let route='chat/completions',payload={...target.extra_body,model:target.model,messages:[{role:'user',content:prompt}],max_tokens:maxTokens,stream:false};
  // No tools, no production conversation, no mutable global model setting.
  delete payload.tools;delete payload.tool_choice;delete payload.functions;delete payload.function_call;delete payload.messages_extra;delete payload.input;delete payload.instructions;delete payload.max_output_tokens;delete payload.max_completion_tokens;
  if(target.api_mode==='anthropic_messages'){
   route='messages';headers['anthropic-version']='2023-06-01';
   if(target.api_key){delete headers.Authorization;headers['x-api-key']=target.api_key;}
  }else if(target.api_mode==='codex_responses'){
   route='responses';payload={...target.extra_body,model:target.model,input:[{role:'user',content:prompt}],max_output_tokens:maxTokens,stream:false,store:false};
   delete payload.tools;delete payload.tool_choice;delete payload.functions;delete payload.function_call;delete payload.messages;delete payload.instructions;delete payload.max_tokens;delete payload.max_completion_tokens;
  }
  const response=await fetcher(endpoint(target.base_url,route),{method:'POST',headers,body:JSON.stringify(payload),signal:controller.signal,redirect:'error'});
  /* 2026-11-16：上游的错误体才是真答案（Content blocked / 451 缓存 / 模型不存在），
     以前这里只报「服务返回 HTTP 502」，等于把病历撕了只留体温 —— 面板上一片红
     却看不出为什么，就被当成密钥坏了。现在把 error.message 前 300 字带出来。 */
  if(!response.ok){
   let detail='';
   try{const body=await response.text();const parsed=JSON.parse(body);detail=String(parsed?.error?.message||parsed?.message||'').slice(0,300);}catch(_){}
   const base=response.status===401||response.status===403?'服务拒绝凭证（HTTP '+response.status+'）':response.status===429?'服务请求限流（HTTP 429）':'服务返回 HTTP '+response.status;
   throw stateError(detail?base+'：'+detail:base,502);
  }
  let raw='',size=0,imageSeen=false;
  if(!response.body)throw stateError('服务未返回响应内容',502);
  const reader=response.body.getReader(),decoder=new TextDecoder();
  /* 2026-11-16：生图响应是一大段 base64 data URL，动辄几 MB，撞到下面这个 1MB
     验证上限就被判「响应过大」—— 明明成功了却报错，面板上一片红。看到 data:image/
     就说明端点、密钥、模型都对，记个标记立刻停，不把整张图读进内存。 */
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;raw+=decoder.decode(value,{stream:true});if(raw.includes('data:image/')){imageSeen=true;break;}if(size>1024*1024)throw stateError('服务响应超过验证大小限制',502);}raw+=decoder.decode();}
  finally{await reader.cancel().catch(()=>{});}
  if(imageSeen)return {output:'（生图模型：请求成功，返回了一张图片）',truncated:false,exact_match:false,finish_reason:'image',response_model:target.model,latency_ms:Date.now()-started,usage:null,image_mode:true};
  let data;try{data=JSON.parse(raw);}catch(_){throw stateError('服务没有返回可解析的 JSON 回复',502);}
  const output=extract(data,target.api_mode);
  if(!output.trim())throw stateError('服务请求成功，但没有返回可显示的回复',502);
  const finish=data.choices?.[0]?.finish_reason||data.stop_reason||data.status||'';
  return {output:output.slice(0,maxChars),truncated:output.length>maxChars,exact_match:output.trim()==='HERMES_OK',finish_reason:finish,
   response_model:typeof data.model==='string'?data.model:'',latency_ms:Date.now()-started,usage:data.usage||null};
 }catch(error){
  if(timedOut)throw stateError('响应验证超过 '+Math.round(timeoutMs/1000)+' 秒，已停止等待',504);
  if(signal?.aborted)throw stateError('已取消本次验证',499);
  if(error.status)throw error;
  throw stateError('无法连接模型服务，请检查端点、网络和服务状态',502);
 }finally{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);}
 }
 /* 2026-11-16：生图模型没法用「回一句话」验证。上游把纯文本指令当成内容冲突，
   直接回 Content blocked；ZeroAPI 这类中转还有 24 小时 451 快照缓存 —— 同一个
   prompt 被拒一次，之后所有请求（连带别的模型）全部 451，看上去像整把密钥废了。
   实测同一把 key、同一个 nano-banana-pro，换成一句画图请求立刻 200 出图。
   所以被拦时换一句带随机 nonce 的画图请求重试一次：出图就判「通过 · 生图」，
   两次都被拦才算真失败。nonce 不能省，不带就等于去撞那 24 小时缓存。 */
 const IMAGE_PROBE = 'Draw a single blue circle centered on a white background. Nonce ';
 const IMAGE_BLOCKED = /content blocked|content polic|neither a usable image|rejected by the upstream|prohibited|HTTP 451/i;
 const IMAGE_MARK = /data:image\//i;
 export async function checkModelResponse(target,opts={}){
 try{return await probeOnce(target,opts);}
 catch(error){
 if(!IMAGE_BLOCKED.test(String(error&&error.message||'')))throw error;
 const nonce=Math.random().toString(36).slice(2,10);
 const out=await probeOnce(target,{...opts,prompt:IMAGE_PROBE+nonce+'. Draw something new; do not reuse or paraphrase any earlier prompt.',maxTokens:1024});
 /* probeOnce 读到 data:image/ 时已经置了 image_mode，这里不能再拿正则重算一遍 ——
    output 这时已经是下面那句中文描述，正则必然不中，等于把 true 覆盖成 false。 */
 out.image_mode=!!out.image_mode||IMAGE_MARK.test(String(out.output||''));
 /* 生图回的是 base64 data URL，几百 KB 到几 MB，绝不能原样塞进面板 */
 out.output=out.image_mode?'（生图模型：请求成功，返回了一张图片）':String(out.output||'').slice(0,120);
 out.truncated=false;out.exact_match=false;
 return out;
 }
 }
 const active=job=>job.status==='running';
export class ModelChecks{
 constructor({root,source,probe=checkModelResponse}){Object.assign(this,{root,source,probe});this.jobs=new Map();this.workers=new Map();this.creating=false;}
 file(id){return new StateFile(join(this.root,safeId(id)+'.json'),()=>null,{validate:j=>j&&j.version===1&&j.id===id&&typeof j.provider==='string'&&typeof j.model==='string'&&typeof j.status==='string'});}
 load(){
  if(!fs.existsSync(this.root))return this;
  for(const name of fs.readdirSync(this.root).filter(n=>n.endsWith('.json'))){const job=this.file(name.slice(0,-5)).read();if(active(job)){job.status='interrupted';job.error='服务重启中断了验证。已有结果已保留，可手动重新验证。';job.finished_at=Date.now();this.file(job.id).write(job);}this.jobs.set(job.id,job);}
  return this;
 }
 list(){return [...this.jobs.values()].sort((a,b)=>b.created_at-a.created_at).slice(0,30);}
 get(id){const job=this.jobs.get(safeId(id));if(!job)throw stateError('验证记录不存在',404);return job;}
 persist(job){this.file(job.id).write(job);this.jobs.set(job.id,job);return job;}
 async create(body){
  const id=safeId(body.request_id);if(typeof body.provider!=='string'||typeof body.model!=='string'||body.model.length>500)throw stateError('请选择服务和模型');
  const old=this.jobs.get(id);if(old){if(old.provider!==body.provider||old.model!==body.model)throw stateError('重复请求编号对应不同模型',409);return old;}
  if(this.creating||[...this.jobs.values()].some(active))throw stateError('已有模型验证正在执行，请等待或取消',409);
  this.creating=true;
  try{
   const {target}=await this.source({action:'resolve',provider:body.provider,model:body.model});
   const job=this.persist({version:1,id,provider:body.provider,provider_name:target.name,model:body.model,api_mode:target.api_mode,status:'running',created_at:Date.now(),result:null,error:''});
   const controller=new AbortController();this.workers.set(id,controller);
   this.run(job,target,controller);return job;
  }finally{this.creating=false;}
 }
 async run(job,target,controller){
  let finished;
  try{const result=await this.probe(target,{signal:controller.signal});finished={...job,status:controller.signal.aborted?'cancelled':'done',result};}
  catch(error){finished={...job,status:controller.signal.aborted?'cancelled':'failed',error:controller.signal.aborted?'已取消本次验证':error.status?error.message:'模型验证失败，请查看服务状态'};}
  try{this.persist({...finished,...(this.jobs.get(job.id)?.cancel_requested_at?{cancel_requested_at:this.jobs.get(job.id).cancel_requested_at}:{}),finished_at:Date.now()});}
  catch(_){this.jobs.set(job.id,{...job,status:'failed',error:'验证结果保存失败，请检查磁盘状态后刷新核对'});}
  finally{this.workers.delete(job.id);}
 }
 cancel(id){const job=this.get(id);if(!active(job))return job;const next=this.persist({...job,cancel_requested_at:Date.now()});this.workers.get(id)?.abort();return next;}
}
export function createModelChecksHandler({checks,checkToken}){
 const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
 return async(req,path)=>{
  if(!path.startsWith('/api/panel-models/checks')&&path!=='/api/panel-models/catalog'&&path!=='/api/panel-models/probe')return null;
  if(!checkToken(req))return reply({ok:false,error:'请重新登录后验证模型'},401);
  try{
   if(path==='/api/panel-models/probe'&&req.method==='POST'){
    // 表单里还没保存的服务也要能测：前端直传 base_url+key，或用服务 ID 借已存密钥。
    const body=await req.json(),model=typeof body.model==='string'?body.model.trim():'';
    if(!model||model.length>500)throw stateError('请先选择要测试的模型',400);
    let target={name:'临时测试',base_url:'',api_key:'',api_mode:typeof body.api_mode==='string'?body.api_mode:'',model,extra_body:{},extra_headers:{}};
    if(typeof body.provider_id==='string'&&body.provider_id){
     const resolved=await checks.source({action:'resolve',provider:body.provider_id,model});
     target={...resolved.target,...(target.api_mode?{api_mode:target.api_mode}:{})};
    }
    const url=typeof body.base_url==='string'?body.base_url.trim():'';
    if(url){const parsed=new URL(url);if(!['http:','https:'].includes(parsed.protocol))throw stateError('服务地址需为 HTTP/HTTPS',400);target.base_url=url;}
    if(typeof body.api_key==='string'&&body.api_key.trim())target.api_key=body.api_key.trim();
    if(!target.base_url)throw stateError('请先填写服务地址',400);
    const started=Date.now();
    try{
     // 推理型模型（deepseek-v4 这类）会把 16 个 token 全花在思考上，content 为空。
     // 先试小额度快测，遇到"没返回可显示回复"再放大一次额度重试。
     let result;
     try{result=await checkModelResponse(target,{timeoutMs:25000,maxTokens:64,prompt:'只回复两个字：收到'});}
     catch(error){
      if(/没有返回可显示的回复/.test(error.message||''))result=await checkModelResponse(target,{timeoutMs:40000,maxTokens:512,prompt:'只回复两个字：收到'});
      else throw error;
     }
     return reply({ok:true,latency_ms:result.latency_ms||Date.now()-started,response_model:result.response_model||'',image_mode:!!result.image_mode,output:String(result.output||'').slice(0,300)});
    }catch(error){
     if(error.status)throw error;
     throw stateError(error.message?('测试失败：'+error.message):'测试失败，检查地址与密钥',502);
    }
   }
   if(path==='/api/panel-models/catalog'&&req.method==='GET')return reply(await checks.source({action:'catalog'}));
   if(path==='/api/panel-models/checks'){
    if(req.method==='GET')return reply({ok:true,checks:checks.list()});
    if(req.method==='POST')return reply({ok:true,check:await checks.create(await req.json())},202);
   }
   const match=path.match(/^\/api\/panel-models\/checks\/([a-zA-Z0-9_-]+)(\/cancel)?$/);
   if(match&&match[2]&&req.method==='POST')return reply({ok:true,check:checks.cancel(match[1])});
   if(match&&!match[2]&&req.method==='GET')return reply({ok:true,check:checks.get(match[1])});
   return reply({ok:false,error:'验证操作不存在'},404);
  }catch(error){return reply({ok:false,error:error.status?error.message:'模型验证请求失败'},error.status||400);}
 };
}
