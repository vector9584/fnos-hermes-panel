import {spawn} from 'node:child_process';
import {join} from 'node:path';
export function createTypingHandler({python,serverRoot,getConfig,state,platforms,checkToken,changed=()=>{},start=spawn}){
 return async(req,path)=>{if(path!=='/api/panel-channels/typing')return null;const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});if(!checkToken(req))return reply({ok:false,error:'请重新登录后管理通讯行为'},401);if(!['GET','POST'].includes(req.method))return reply({ok:false,error:'不支持此操作'},405);
  try{const definitions=platforms(),input=req.method==='GET'?{action:'read'}:{...await req.json(),action:'update'},body={...input,platforms:Object.keys(definitions)};
   const result=await new Promise(resolve=>{const child=start(python,['-B',join(serverRoot,'panel-typing.py'),getConfig(),state],{stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});let output='',done=false;const finish=result=>{if(done)return;done=true;clearTimeout(timer);resolve(result);};const timer=setTimeout(()=>{child.kill();finish({ok:false,error:'通讯配置处理超时，请刷新核对',status:504});},15000);child.stdout.on('data',part=>{output+=part;if(output.length>128000){child.kill();finish({ok:false,error:'通讯配置返回过大',status:502});}});child.stderr.resume();child.stdin.on('error',()=>{});child.on('error',()=>finish({ok:false,error:'通讯配置服务无法启动',status:503}));child.on('close',()=>{try{finish(JSON.parse(output));}catch(_){finish({ok:false,error:'通讯配置未收到结果，请重新读取',status:502});}});child.stdin.end(JSON.stringify(body));});
   if(result.platforms)result.platforms=result.platforms.map(({path,...platform})=>({...platform,name:definitions[platform.id].name||platform.id}));
   if(result.ok&&result.changed)changed('输入状态 · '+(definitions[body.platform]?.name||body.platform));return reply(result,result.ok?200:result.status||500);
  }catch(_){return reply({ok:false,error:'通讯行为设置未完成，请刷新核对'},500);}
 };
}
