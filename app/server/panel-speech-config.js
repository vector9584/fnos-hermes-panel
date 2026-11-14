import {spawn} from 'node:child_process';
import {join} from 'node:path';
// 语音栈（TTS 提供方 / STT 提供方）与 JEV 只读状态的读写入口。
// 与 panel-auxiliary.js 同一套模式：子进程 + 15 秒超时 + 结构化 JSON 回传。
export function createSpeechConfigHandler({python,serverRoot,getConfig,lockRoot,checkToken,start=spawn}){
 return async function(req,path){
  if(path!=='/api/panel-models/voice')return null;
  const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
  if(!checkToken(req))return reply({ok:false,error:'请重新登录后管理语音配置'},401);
  if(!['GET','PATCH'].includes(req.method))return reply({ok:false,error:'不支持此操作'},405);
  try{
   const body=req.method==='GET'?{action:'read'}:{...await req.json(),action:'update'};
   const serialized=JSON.stringify(body);if(serialized.length>128000)return reply({ok:false,error:'语音配置内容过大'},413);
   return await new Promise(resolve=>{
    const child=start(python,['-B',join(serverRoot,'panel-speech-config.py'),getConfig(),lockRoot],{stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});let output='',settled=false;
    const finish=(data,status)=>{if(settled)return;settled=true;clearTimeout(timer);resolve(reply(data,status));};
    const timer=setTimeout(()=>{child.kill('SIGTERM');finish({ok:false,error:'读取或保存超时，请刷新核对配置'},504);},15000);
    child.stdout.on('data',chunk=>{output+=chunk;if(output.length>1024*1024){child.kill('SIGTERM');finish({ok:false,error:'配置返回内容过大'},502);}});child.stderr.resume();child.stdin.on('error',()=>{});
    child.on('error',()=>finish({ok:false,error:'语音配置管理进程无法启动'},503));child.on('close',code=>{try{const result=JSON.parse(output);finish(result,result.ok&&code===0?200:result.status||500);}catch(_){finish({ok:false,error:'未收到配置结果，请刷新核对'},502);}});child.stdin.end(serialized);
   });
  }catch(_){return reply({ok:false,error:'语音配置请求格式不正确'},400);}
 };
}
