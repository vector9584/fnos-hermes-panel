import {spawn} from 'node:child_process';
import {join} from 'node:path';
export function createChannelsService({python,serverRoot,getConfig,state,checkToken,changed=()=>{},observe=()=>({verified:false,reason:"record_unavailable",platforms:{}}),start=spawn}){
 async function execute(body){
  const result=await new Promise(resolve=>{
   const child=start(python,['-B',join(serverRoot,'panel-channels.py'),getConfig(),state],{stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});let output='',done=false;
   const finish=data=>{if(done)return;done=true;clearTimeout(timer);resolve(data);};const timer=setTimeout(()=>{child.kill();finish({ok:false,error:'通讯配置处理超时，请刷新核对',status:504});},15000);
   child.stdout.on('data',part=>{output+=part;if(Buffer.byteLength(output)>2*1024*1024){child.kill();finish({ok:false,error:'通讯配置内容过大',status:413});}});child.stderr.resume();child.stdin.on('error',()=>{});child.on('error',()=>finish({ok:false,error:'通讯配置服务无法启动',status:503}));child.on('close',()=>{try{finish(JSON.parse(output));}catch{finish({ok:false,error:'通讯配置未返回处理结果，请刷新核对',status:502});}});child.stdin.end(JSON.stringify(body));
  });
  if(result.ok&&result.changed){try{changed('通讯渠道配置');}catch{return {...result,ok:false,saved:true,error:'通讯配置已保存，但待应用记录未写入，请刷新核对后重启应用',status:503};}}
  return result;
 }
 return {execute,async handle(req,path){
  if(!['/api/panel-channels','/api/panel-channels/runtime'].includes(path))return null;
  const reply=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
  if(!checkToken(req))return reply({ok:false,error:'请重新登录后管理通讯渠道'},401);
  if(path==='/api/panel-channels/runtime'){if(req.method!=='GET')return reply({ok:false,error:'运行状态只支持读取'},405);try{return reply({ok:true,runtime:observe()});}catch{return reply({ok:false,error:'运行状态读取失败',status:503},503);}}
  if(!['GET','POST'].includes(req.method))return reply({ok:false,error:'不支持此操作'},405);
  try{const body=req.method==='GET'?{action:'read'}:await req.json();if(JSON.stringify(body).length>512000)return reply({ok:false,error:'通讯配置修改内容过长'},413);const result=await execute(body);return reply(result,result.ok?200:result.status||503);}catch{return reply({ok:false,error:'通讯配置请求格式不正确'},400);}
 }};
}
