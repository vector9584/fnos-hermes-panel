import {spawn} from 'node:child_process';
import {join} from 'node:path';
export function createAuxiliaryHandler({python,serverRoot,getConfig,backupRoot,checkToken,start=spawn}){
 return async function(req,path){
  if(path!=='/api/panel-models/auxiliary')return null;
  const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
  if(!checkToken(req))return reply({ok:false,error:'请重新登录后管理辅助模型'},401);
  if(!['GET','PATCH'].includes(req.method))return reply({ok:false,error:'不支持此操作'},405);
  try{
   const body=req.method==='GET'?{action:'read'}:{...await req.json(),action:'update'};
   const serialized=JSON.stringify(body);if(serialized.length>128000)return reply({ok:false,error:'辅助模型配置过大'},413);
   return await new Promise(resolve=>{
    const child=start(python,['-B',join(serverRoot,'panel-auxiliary.py'),getConfig(),backupRoot],{stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});let output='',settled=false;
    const finish=(data,status)=>{if(settled)return;settled=true;clearTimeout(timer);resolve(reply(data,status));};
    const timer=setTimeout(()=>{child.kill('SIGTERM');finish({ok:false,error:'读取或保存超时，请刷新核对配置'},504);},15000);
    child.stdout.on('data',chunk=>{output+=chunk;if(output.length>1024*1024){child.kill('SIGTERM');finish({ok:false,error:'配置返回内容过大'},502);}});child.stderr.resume();child.stdin.on('error',()=>{});
    child.on('error',()=>finish({ok:false,error:'辅助模型管理进程无法启动'},503));child.on('close',code=>{try{const result=JSON.parse(output);finish(result,result.ok&&code===0?200:result.status||500);}catch(_){finish({ok:false,error:'未收到配置结果，请刷新核对'},502);}});child.stdin.end(serialized);
   });
  }catch(_){return reply({ok:false,error:'辅助模型请求格式不正确'},400);}
 };
}
