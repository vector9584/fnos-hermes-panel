// Runs after authentication and before either legacy route table. Old cached
// editors cannot bypass revision checks or retrieve clear-text credentials.
export function createChannelIngress({channels,pairing,checkToken}){
 return async function(req,path){
  const current=await channels.handle(req,path);if(current)return current;
  const qr=await pairing(req,path);if(qr)return qr;
  if(path!=='/api/channels'&&!path.startsWith('/api/channels/'))return null;
  const reply=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
  if(!checkToken(req))return reply({ok:false,error:'请重新登录后管理通讯渠道'},401);
  if(path==='/api/channels'&&req.method==='GET'){
   const result=await channels.execute({action:'read'});if(!result.ok)return reply(result,result.status||503);
   const defs={},items={};for(const c of result.channels){defs[c.id]={name:c.name};items[c.id]={id:c.id,name:c.name,configured:c.configured,enabled:c.enabled};}
   return reply({ok:true,defs,channels:items});
  }
  return reply({ok:false,error:'通讯配置入口已更新，请刷新面板后重新操作'},410);
 };
}
