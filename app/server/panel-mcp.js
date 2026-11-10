import {spawn} from 'node:child_process';
import {join} from 'node:path';
export function createMcpHandler({python,serverRoot,getConfig,state,checkToken,changed=()=>{},start=spawn}){
 return async(req,path)=>{if(path!=='/api/panel-mcp')return null;const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});if(!checkToken(req))return reply({ok:false,error:'请重新登录后管理工具服务'},401);
  if(!['GET','POST'].includes(req.method))return reply({ok:false,error:'不支持此操作'},405);
  try{const body=req.method==='GET'?{action:'read'}:await req.json();if(JSON.stringify(body).length>256000)return reply({ok:false,error:'服务配置过长'},413);
   const result=await new Promise(resolve=>{const child=start(python,['-B',join(serverRoot,'panel-mcp.py'),getConfig(),state],{stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});let output='',done=false;const finish=data=>{if(done)return;done=true;clearTimeout(timer);resolve(data);};const timer=setTimeout(()=>{child.kill();finish({ok:false,error:'服务配置处理超时，请刷新核对',status:504});},15000);
    child.stdout.on('data',part=>{output+=part;if(Buffer.byteLength(output)>2*1024*1024){child.kill();finish({ok:false,error:'服务列表过大，请检查配置',status:413});}});child.stderr.resume();child.stdin.on('error',()=>{});child.on('error',()=>finish({ok:false,error:'配置服务无法启动',status:503}));child.on('close',()=>{try{finish(JSON.parse(output));}catch(_){finish({ok:false,error:'服务配置未收到结果，请刷新核对',status:502});}});child.stdin.end(JSON.stringify(body));});
   if(result.ok&&result.changed){try{changed('MCP · '+body.name);}catch(_){return reply({...result,ok:false,saved:true,error:'配置已保存，但待应用记录写入失败，请核对后重启应用'},503);}}
   return reply(result,result.ok?200:result.status||500);
  }catch(_){return reply({ok:false,error:'服务请求格式不正确'},400);}
 };
}
