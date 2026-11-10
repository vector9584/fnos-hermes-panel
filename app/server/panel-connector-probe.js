export function createConnectorProbeHandler({checkToken,getConnector,readState,probe}){
  return async function(req,path){
    const match=path.match(/^\/api\/connectors\/([A-Za-z0-9_-]+)\/probe$/);if(!match)return null;
    const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
    if(!checkToken(req))return reply({ok:false,error:'请重新登录后测试连接'},401);
    if(req.method!=='POST')return reply({ok:false,error:'测试连接需要POST请求'},405);
    const connector=getConnector(match[1]);if(!connector)return reply({ok:false,error:'连接器不存在'},404);
    if(!connector.impl?.probeCredentials)return reply({ok:false,error:'此连接器由远程MCP管理，不提供直接凭证探测'},422);
    try{
      const body=await req.json(),stored=readState()[connector.kind]||{},credentials={};
      for(const field of connector.fields||[]){const value=body[field.key];credentials[field.key]=value==null||String(value).trim()===''?stored[field.key]||'':String(value).trim();}
      if((connector.fields||[]).some(field=>!credentials[field.key]))return reply({ok:false,error:'请填写所有必填凭证'},400);
      await probe(connector.kind,credentials);
      return reply({ok:true,message:'连接测试通过，未保存凭证或重启服务'});
    }catch(error){return reply({ok:false,error:error instanceof SyntaxError?'请求格式不正确':'连接测试失败，请检查凭证和网络后重试'},error instanceof SyntaxError?400:502);}
  };
}
