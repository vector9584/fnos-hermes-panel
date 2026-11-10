import {readdirSync,lstatSync,openSync,closeSync,fstatSync,readSync,constants} from 'node:fs';
import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import {join} from 'node:path';
const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
export function reportedUsage(raw){
 if(!raw||typeof raw!=='object')return null;
 const input=count(raw.input_tokens??raw.prompt_tokens),output=count(raw.output_tokens??raw.completion_tokens);
 if(input===null&&output===null)return null;
 // Keep provider conventions: Anthropic cache tokens are separate from input;
 // OpenAI cached_tokens is a subset. Do not add either to input automatically.
 return {input_tokens:input,output_tokens:output,cache_read_tokens:count(raw.cache_read_input_tokens??raw.prompt_tokens_details?.cached_tokens??raw.input_tokens_details?.cached_tokens),cache_write_tokens:count(raw.cache_creation_input_tokens)};
}
function readRecord(file){
 const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const before=fstatSync(fd),limit=4*1024*1024;if(!before.isFile()||before.size>limit)throw Error('invalid record');
  const bytes=Buffer.alloc(before.size+1);let size=0,read;
  while(size<bytes.length&&(read=readSync(fd,bytes,size,bytes.length-size,null))>0)size+=read;
  const after=fstatSync(fd);if(size!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs)throw Error('record changed');
  return JSON.parse(bytes.subarray(0,size).toString('utf8'));
 }finally{closeSync(fd);}
}
export function readPanelUsage(root){
 const groups=new Map();let records=0,reported=0,unreadable=0;
 for(const [folder,task] of [['model-checks','model_check'],['library-reviews','memory_review']]){
  const directory=join(root,folder);let names;
  try{if(lstatSync(directory).isSymbolicLink())throw Error();names=readdirSync(directory);}catch(error){if(error.code==='ENOENT')continue;unreadable++;continue;}
  for(const name of names.filter(n=>/^[A-Za-z0-9_-]+\.json$/.test(n))){
   let job;try{const file=join(directory,name),stat=lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4*1024*1024)throw Error();job=readRecord(file);if(job.version!==1||typeof job.id!=='string'||!job.status)throw Error();}catch{unreadable++;continue;}
   records++;const usage=reportedUsage(job.result?.usage||job.usage);if(!usage)continue;reported++;
   const model=job.result?.response_model||job.response_model||null,provider=job.provider_name||job.provider||null,key=JSON.stringify([model,provider,task]);
   if(!groups.has(key))groups.set(key,{model,provider,task,records:0,input_tokens:0,output_tokens:0,missing_input:0,missing_output:0});
   const row=groups.get(key);row.records++;for(const field of ['input','output']){const value=usage[field+'_tokens'];if(value===null)row['missing_'+field]++;else row[field+'_tokens']+=value;}
  }
 }
 return {source:'面板直接请求',records,reported_records:reported,unreported_records:records-reported,unreadable_records:unreadable,by_model:[...groups.values()],input_tokens:[...groups.values()].reduce((n,r)=>n+r.input_tokens,0),output_tokens:[...groups.values()].reduce((n,r)=>n+r.output_tokens,0),note:'模型验证与记忆整理直接请求服务，单独列示，不并入原生会话总量。仅统计服务返回的用量；未返回或未落盘的消耗无法补算。'};
}

// File traversal and JSON parsing stay off Monitor's event loop. The caller
// shares this one worker across concurrent usage requests and never persists a cache.
export function readPanelUsageAsync(root,{timeoutMs=15000,start=options=>new Worker(new URL(import.meta.url),options)}={}){
 return new Promise((resolve,reject)=>{
  let worker,settled=false,timer;
  const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);if(worker)worker.terminate().catch(()=>{});if(error)reject(error);else resolve(result);};
  try{
   worker=start({workerData:{task:'panel-usage',root},resourceLimits:{maxOldGenerationSizeMb:96}});
   timer=setTimeout(()=>finish(Error('面板直接请求统计超时，请重试')),timeoutMs);
   worker.once('message',message=>{if(message?.ok)finish(null,message.result);else finish(Error('面板直接请求记录无法读取，请检查存储状态'));});
   worker.once('error',()=>finish(Error('面板直接请求统计失败，请重试')));
   worker.once('exit',()=>{if(!settled)finish(Error('面板直接请求统计未完成，请重试'));});
  }catch{finish(Error('面板直接请求统计无法启动，请重试'));}
 });
}
if(!isMainThread&&workerData?.task==='panel-usage'){
 try{parentPort.postMessage({ok:true,result:readPanelUsage(workerData.root)});}catch{parentPort.postMessage({ok:false});}
}
