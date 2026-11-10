// Compatibility for existing panel/CLI and native Dashboard clients. Every
// restart launches the same approved application script; action polling reads
// the persistent ledger instead of interpreting an open port as success.
export function createRestartIngress({runtime,checkToken}){
 return async function(req,path){
  const native=path==='/proxy/dashboard/api/gateway/restart',action=path==='/proxy/dashboard/api/actions/gateway-restart/status';
  if(!native&&!action&&path!=='/api/restart')return null;
  const reply=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
  if(!checkToken(req))return reply({ok:false,error:'请重新登录后管理应用运行状态'},401);
  if(req.method!==(action?'GET':'POST'))return reply({ok:false,error:'运行操作的方法不正确'},405);
  try{
   if(action){
    await runtime.prepare?.();const state=runtime.status(),record=state.restart;
    const messages={requested:'已请求正式应用重启，等待新的应用进程。',restarted:'新的应用进程已启动，等待网关与仪表盘健康。',ready:'应用已重启，网关与仪表盘已恢复健康。',failed:record?.error||'应用重启未完成，请在本地维护中检查。'};
    return reply({name:'gateway-restart',running:!!state.restart_pending,exit_code:record?.status==='ready'?0:record?.status==='failed'?1:null,pid:null,lines:[record?messages[record.status]||'正在核对重启状态。':'尚未请求应用重启。'],restart_id:record?.id||null,scope:'application'});
   }
   const url=new URL(req.url);if(native&&url.searchParams.get('profile')&&!['default',''].includes(url.searchParams.get('profile')))return reply({ok:false,error:'此应用统一管理网关，请从本地维护重启整个应用'},409);
   let body={};const text=await req.text();if(text.trim()){try{body=JSON.parse(text);}catch{return reply({ok:false,error:'重启请求格式不正确'},400);}}
   if(!body||typeof body!=='object'||Array.isArray(body)||('interrupt'in body&&typeof body.interrupt!=='boolean'))return reply({ok:false,error:'重启请求格式不正确'},400);
   const result=await (runtime.requestRestart?runtime.requestRestart({interrupt:body.interrupt===true}):runtime.restart({interrupt:body.interrupt===true}));
   return reply({...result,name:'gateway-restart',pid:null,scope:'application'});
  }catch(error){return reply({ok:false,error:error.status?error.message:'应用重启未收到确认，请刷新运行状态核对'},error.status||503);}
 };
}
