"""MCP configuration editor. No server startup and no remote calls."""
import copy
import io
import json
import re
import sys
from pathlib import Path
from urllib.parse import urlsplit
from panel_config_txn import ConfigError,config_lock,read_file,load_yaml,plain,semantic,checksum,commit

VISIBLE=('command','args','url','transport','timeout','connect_timeout','tools')
def revision(value):return checksum(semantic(value).encode())
def public(name,item):
 if not isinstance(item,dict):raise ConfigError('MCP服务配置不是映射',503)
 result={key:plain(item[key]) for key in VISIBLE if key in item}
 result.update(name=name,revision=revision(item),enabled=item.get('enabled',True) not in (False,'false',0),managed=name.startswith('conn-'),
  env_keys=list(item.get('env',{})),header_keys=list(item.get('headers',{})),has_credentials=bool(item.get('env') or item.get('headers')))
 return result

def catalog(data):
 servers=data.get('mcp_servers',{})
 if not isinstance(servers,dict):raise ConfigError('MCP配置不是映射，原文件已保留',503)
 return {'ok':True,'servers':[public(name,item) for name,item in servers.items()]}

def patch(old,body):
 updated=copy.deepcopy(old)
 changes=body.get('changes',{})
 if not isinstance(changes,dict) or any(key not in (*VISIBLE,'enabled','env','headers') for key in changes):raise ConfigError('MCP修改字段不正确')
 def destination(item):
  if item.get('url'):
   endpoint=urlsplit(item['url']);return ('remote',endpoint.scheme,endpoint.hostname,endpoint.port)
  return ('local',item.get('command',''))
 proposed={**old,**{key:value for key,value in changes.items() if key in ('url','command')}}
 if destination(old)!=destination(proposed):
  # Credentials must not silently follow a server to another host/command.
  updated.pop('headers',None);updated.pop('env',None)
 for key,value in changes.items():
  if key in ('env','headers'):
   if not isinstance(value,dict):raise ConfigError('凭证编辑内容不正确')
   values=copy.deepcopy(updated.get(key,{}))
   if not isinstance(values,dict):raise ConfigError('原凭证结构无法识别，请保留原文件核对',503)
   for name,operation in value.items():
    if not isinstance(name,str) or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_-]*',name) or not isinstance(operation,dict):raise ConfigError('凭证字段名称不正确')
    action=operation.get('action','keep')
    if action=='clear':values.pop(name,None)
    elif action=='replace':
     content=operation.get('value')
     if not isinstance(content,str) or not content or len(content)>16000 or '\r' in content or '\n' in content:raise ConfigError('凭证需填写非空单行文本')
     values[name]=content
    elif action!='keep':raise ConfigError('凭证操作不正确')
   if values:updated[key]=values
   else:updated.pop(key,None)
  elif key=='enabled':
   if type(value) is not bool:raise ConfigError('启用状态必须是布尔值')
   updated[key]=value
  elif key in ('timeout','connect_timeout'):
   if value in ('',None):updated.pop(key,None)
   elif isinstance(value,bool) or not isinstance(value,(int,float)) or not 1<=value<=3600:raise ConfigError('超时需为1到3600秒')
   else:updated[key]=value
  elif key=='args':
   if not isinstance(value,list) or len(value)>100 or any(not isinstance(v,str) or len(v)>4000 for v in value):raise ConfigError('启动参数需为文本列表')
   updated[key]=value
  elif key=='tools':
   if not isinstance(value,dict) or any(k not in ('include','exclude') for k in value):raise ConfigError('工具过滤格式不正确')
   filters=copy.deepcopy(updated.get('tools',{}))
   for kind,names in value.items():
    if not isinstance(names,list) or len(names)>500 or any(not isinstance(n,str) or not n or len(n)>200 for n in names):raise ConfigError('工具名称格式不正确')
    if names:filters[kind]=names
    else:filters.pop(kind,None)
   if filters:updated[key]=filters
   else:updated.pop(key,None)
  else:
   if not isinstance(value,str) or len(value)>4000 or '\n' in value or '\r' in value:raise ConfigError('服务字段需为单行文本')
   if value.strip():updated[key]=value.strip()
   else:updated.pop(key,None)
 if updated.get('url'):
  parsed=urlsplit(updated['url'])
  if parsed.scheme not in ('http','https') or not parsed.hostname or parsed.username or parsed.password:raise ConfigError('服务地址需为HTTP或HTTPS，凭证请放入请求头')
  if updated.get('transport') not in (None,'http','sse','streamable-http'):raise ConfigError('远程传输类型不正确')
  if updated.get('command'):raise ConfigError('远程地址和本地启动命令不能同时填写')
 else:
  if not updated.get('command'):raise ConfigError('本地服务需填写启动命令')
 return updated

def execute(body,path,state):
 with config_lock(state):
  raw,_=read_file(path);yaml,data=load_yaml(raw)
  if body.get('action')=='read':return catalog(data)
  action=body.get('action');name=body.get('name')
  if not isinstance(name,str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}',name):raise ConfigError('服务名称仅支持字母、数字、下划线和短横线')
  if name.startswith('conn-'):raise ConfigError('此服务由连接器管理，请到连接器页面修改',409)
  servers=data.get('mcp_servers',{})
  if not isinstance(servers,dict):raise ConfigError('MCP配置不是映射，原文件已保留',503)
  old=servers.get(name)
  if action=='create':
   if old is not None:raise ConfigError('已有同名服务，请换一个名称',409)
   updated=patch({},body)
  else:
   if old is None:raise ConfigError('服务不存在，请刷新列表',404)
   if revision(old)!=body.get('revision'):raise ConfigError('服务已被其他页面修改，请保留表单并重新读取',409)
   if action=='update':updated=patch(old,body)
   elif action=='toggle':updated=patch(old,{'changes':{'enabled':body.get('enabled')}})
   elif action=='restore':
    change_id=body.get('change_id','')
    if not re.fullmatch(r'[0-9]+-[a-f0-9]{12}',change_id):raise ConfigError('恢复记录不正确')
    directory=Path(state)/'config-history';metadata=json.loads((directory/(change_id+'.json')).read_text())
    if metadata['file']!=str(path):raise ConfigError('恢复记录属于其他环境',409)
    _,before=load_yaml((directory/(change_id+'.yaml')).read_bytes());updated=before.get('mcp_servers',{}).get(name)
    if not isinstance(updated,dict):raise ConfigError('这次操作没有旧服务可恢复；请停用新建的服务',409)
   else:raise ConfigError('服务操作不存在',404)
  new_data=copy.deepcopy(data);new_data['mcp_servers']=copy.deepcopy(servers);new_data['mcp_servers'][name]=updated
  if semantic(new_data)==semantic(data):return {**catalog(data),'changed':False}
  output=io.StringIO();yaml.dump(new_data,output);encoded=output.getvalue().encode()
  result=commit(path,state,raw,encoded,'MCP '+action+' '+name)
  return {**catalog(new_data),**result,'server':public(name,updated),'reload_required':True}

if __name__=='__main__':
 try:print(json.dumps(execute(json.load(sys.stdin),Path(sys.argv[1]),Path(sys.argv[2])),ensure_ascii=False))
 except Exception as error:
  print(json.dumps({'ok':False,'error':str(error) if isinstance(error,ConfigError) else '服务配置未收到保存确认，请重新读取核对','status':getattr(error,'status',500)},ensure_ascii=False));sys.exit(1)
