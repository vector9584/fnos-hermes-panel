import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
export function createConfigRecovery({python,serverRoot,home,state,checkToken,changed=()=>{},run=spawnSync}){
 function execute(body){
  const result=run(python,['-B',join(serverRoot,'panel-config-recovery.py'),home,state],{input:JSON.stringify(body),encoding:'utf8',timeout:15000,maxBuffer:1024*1024,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
  let data;try{data=JSON.parse(result.stdout);}catch{return {ok:false,error:'配置恢复服务未返回结果，请刷新核对',status:503};}
  if(data.ok&&data.changed){try{changed('配置保存恢复');}catch{return {...data,ok:false,saved:true,error:'配置已处理，但待应用记录未写入，请刷新核对后重启应用',status:503};}}
  return data;
 }
 return {execute,status(){return existsSync(join(state,'config-bundle-pending.json'))?execute({action:'read'}):{ok:true,pending:null};},async handle(req,path){
  if(path!=='/api/config-recovery')return null;
  const reply=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
  if(!checkToken(req))return reply({ok:false,error:'请重新登录后处理配置恢复'},401);
  if(!['GET','POST'].includes(req.method))return reply({ok:false,error:'不支持此恢复操作'},405);
  try{const body=req.method==='GET'?{action:'read'}:await req.json();if(req.method==='POST'&&body.action!=='resolve')return reply({ok:false,error:'恢复操作不正确'},400);const data=execute(body);return reply(data,data.ok?200:data.status||503);}catch{return reply({ok:false,error:'配置恢复请求格式不正确'},400);}
 }};
}
