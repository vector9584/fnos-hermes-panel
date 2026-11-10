import {stateError} from './panel-state.js';
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
export function validateConnectorArguments(connector,name,args){
  const tool=(connector.tools||[]).find(item=>item.name===name);
  if(!tool||!connector.impl?.callTool)throw stateError('此连接器没有该可调用工具',400);
  if(!object(args))throw stateError('工具参数必须是对象',400);
  const schema=tool.inputSchema||{},properties=schema.properties||{};
  for(const key of schema.required||[])if(args[key]===undefined||args[key]===null||typeof args[key]==='string'&&!args[key].trim())throw stateError('请填写工具必填参数：'+key,400);
  for(const [key,value]of Object.entries(args)){
    const field=properties[key];if(!field)throw stateError('工具不支持参数：'+key,400);
    const valid=field.type==='integer'?Number.isSafeInteger(value):field.type==='number'?typeof value==='number'&&Number.isFinite(value):field.type==='boolean'?typeof value==='boolean':field.type==='string'?typeof value==='string':false;
    if(!valid)throw stateError('工具参数类型不正确：'+key,400);
    if(typeof value==='string'&&value.length>100000)throw stateError('工具参数内容过长：'+key,400);
  }
  return args;
}
export function createConnectorToolsHandler({getConnector,readState,checkToken,call}){
  return async function(req,path){
    const rest=path.match(/^\/api\/connectors\/([A-Za-z0-9_-]+)\/call$/),rpc=path.match(/^\/mcp-proxy\/([A-Za-z0-9_-]+)$/);
    if(!rest&&!rpc)return null;
    const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
    if(!checkToken(req))return reply({ok:false,error:'连接器调用需要有效的面板凭证'},401);
    if(req.method!=='POST')return reply({ok:false,error:'工具调用需要POST请求'},405);
    let body;
    try{
      const connector=getConnector((rest||rpc)[1]);if(!connector)throw stateError('连接器不存在',404);
      body=await req.json();if(!object(body))throw stateError('请求格式不正确',400);
      if(rpc){
        if(body.id===undefined||body.id===null)return new Response(null,{status:202});
        if(body.method==='initialize')return reply({jsonrpc:'2.0',id:body.id,result:{protocolVersion:'2024-11-05',capabilities:{tools:{listChanged:false}},serverInfo:{name:'hermes-conn-'+connector.kind,version:'1.0.0'}}});
        if(body.method==='ping')return reply({jsonrpc:'2.0',id:body.id,result:{}});
        if(body.method==='tools/list')return reply({jsonrpc:'2.0',id:body.id,result:{tools:connector.impl?.callTool?(connector.tools||[]).map(tool=>({name:tool.name,description:tool.description||'',inputSchema:tool.inputSchema||{type:'object',properties:{}}})):[]}});
        if(body.method!=='tools/call')return reply({jsonrpc:'2.0',id:body.id,error:{code:-32601,message:'不支持此MCP方法'}});
      }
      const name=rpc?body.params?.name:body.tool,args=rpc?body.params?.arguments||{}:body.args||{};
      validateConnectorArguments(connector,name,args);
      const credentials=readState()[connector.kind];
      if(!credentials||(connector.fields||[]).some(field=>!credentials[field.key]))throw stateError('连接器尚未配置，请先保存凭证',409);
      let result;try{result=await call(connector.kind,credentials,name,args);}catch(_){throw stateError('连接器调用失败，请检查凭证、参数和服务状态后重试',502);}
      if(rpc)return reply({jsonrpc:'2.0',id:body.id,result:{content:[{type:'text',text:typeof result==='string'?result:JSON.stringify(result)}]}});
      return reply({ok:true,result});
    }catch(error){const message=error instanceof SyntaxError?'请求格式不正确':error.message;
      if(rpc&&body?.id!==undefined)return reply({jsonrpc:'2.0',id:body.id,result:{content:[{type:'text',text:message}],isError:true}});
      return reply({ok:false,error:message},error instanceof SyntaxError?400:error.status||500);
    }
  };
}
