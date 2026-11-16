import {spawn} from 'node:child_process';
import {join} from 'node:path';
// 语音栈（TTS 提供方 / STT 提供方）与 JEV 只读状态的读写入口。
// 与 panel-auxiliary.js 同一套模式：子进程 + 结构化 JSON 回传。
// 配置读写 15 秒预算；/api/panel-models/voice-test 是真合成/真转写，单独给 300 秒。
export function createSpeechConfigHandler({python,serverRoot,getConfig,lockRoot,checkToken,start=spawn}){
 return async function(req,path){
  const isTest=path==='/api/panel-models/voice-test';
  if(path!=='/api/panel-models/voice'&&!isTest)return null;
  const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
  if(!checkToken(req))return reply({ok:false,error:'请重新登录后管理语音配置'},401);
  // 实测走独立路由：真合成要几秒、STT 闭环要十几秒，
  // 配置读写的 15 秒预算必然把它掐死，所以单独放长到 300 秒。
  const allowed=isTest?['POST']:['GET','PATCH'];
  if(!allowed.includes(req.method))return reply({ok:false,error:'不支持此操作'},405);
  const budget=isTest?300000:15000;
  try{
   const body=isTest?{...await req.json(),action:'test'}:(req.method==='GET'?{action:'read'}:{...await req.json(),action:'update'});
   const serialized=JSON.stringify(body);if(serialized.length>128000)return reply({ok:false,error:'语音配置内容过大'},413);
   return await new Promise(resolve=>{
    const child=start(python,['-B',join(serverRoot,'panel-speech-config.py'),getConfig(),lockRoot],{stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});let output='',settled=false;
    const finish=(data,status)=>{if(settled)return;settled=true;clearTimeout(timer);resolve(reply(data,status));};
    const timer=setTimeout(()=>{child.kill('SIGTERM');finish({ok:false,error:'实测超时，提供方可能挂住；配置读写本身正常'},504);},budget);
    child.stdout.on('data',chunk=>{output+=chunk;if(output.length>1024*1024){child.kill('SIGTERM');finish({ok:false,error:'配置返回内容过大'},502);}});child.stderr.resume();child.stdin.on('error',()=>{});
    child.on('error',()=>finish({ok:false,error:'语音配置管理进程无法启动'},503));child.on('close',code=>{try{const result=JSON.parse(output);
     // 「测出来不通」是这次测试的成功结论，不是请求失败：一律 200 让前端读 body 的 ok/error 渲染，
     // 只有进程压根没跑起来（下面 catch）才算 5xx。
     finish(result,isTest?200:(result.ok&&code===0?200:result.status||500));}catch(_){finish({ok:false,error:'未收到配置结果，请刷新核对'},502);}});child.stdin.end(serialized);
   });
  }catch(_){return reply({ok:false,error:'语音配置请求格式不正确'},400);}
 };
}
