"""Expose the platform typing setting using the native gateway's merge order."""
import copy
import io
import json
import sys
from pathlib import Path
from panel_config_txn import ConfigError,config_lock,read_file,load_yaml,semantic,checksum,assign,commit

def mapping(value):return value if isinstance(value,dict) else {}
def coerce(value):
 if value is None:return True
 if isinstance(value,str):
  lower=value.strip().lower()
  if lower in ('true','1','yes','on'):return True
  if lower in ('false','0','no','off'):return False
  return True
 return bool(value)

def effective(data,legacy,name):
 gateway=mapping(data.get('gateway'));nested=mapping(gateway.get('platforms'));top=mapping(data.get('platforms'))
 merged=copy.deepcopy(mapping(mapping(legacy.get('platforms')).get(name)))
 for block in [nested.get(name),top.get(name),gateway.get(name)]:
  if not isinstance(block,dict):continue
  extra={**mapping(merged.get('extra')),**mapping(block.get('extra'))};merged.update(copy.deepcopy(block));merged['extra']=extra
 chosen=data.get(name)
 if not isinstance(chosen,dict):
  chosen=nested.get(name)
  if not isinstance(chosen,dict):chosen=top.get(name)
 if isinstance(chosen,dict) and 'typing_indicator' in chosen:merged.setdefault('extra',{})['typing_indicator']=chosen['typing_indicator']
 value=merged.get('typing_indicator')
 if value is None:value=mapping(merged.get('extra')).get('typing_indicator')
 # A direct gateway.<platform> field wins the ordinary platforms field. Update
 # exactly that location when it exists, otherwise write platforms.<id>.
 path=['gateway',name,'typing_indicator'] if 'typing_indicator' in mapping(gateway.get(name)) else ['platforms',name,'typing_indicator']
 return {'enabled':coerce(value),'explicit':value is not None,'path':path}

def execute(body,path,state):
 path=Path(path);legacy_path=path.parent/'gateway.json'
 with config_lock(state):
  raw,_=read_file(path);yaml,data=load_yaml(raw)
  if legacy_path.exists():
   legacy_raw,_=read_file(legacy_path)
   try:legacy=json.loads(legacy_raw)
   except Exception:raise ConfigError('旧网关配置无法解析，请先核对原文件',503)
   if not isinstance(legacy,dict):raise ConfigError('旧网关配置格式不正确',503)
  else:legacy_raw=b'';legacy={}
  names=body.get('platforms',[])
  if not isinstance(names,list) or any(not isinstance(name,str) or not name.replace('_','').replace('-','').isalnum() for name in names):raise ConfigError('通讯平台清单不正确')
  revision=checksum(raw+b'\x00'+legacy_raw)
  if body.get('action')=='read':return {'ok':True,'revision':revision,'platforms':[{'id':name,**effective(data,legacy,name)} for name in names]}
  name=body.get('platform');enabled=body.get('enabled')
  if name not in names or type(enabled) is not bool:raise ConfigError('平台或状态不正确')
  if body.get('revision')!=revision:raise ConfigError('通讯配置已更新，请重新读取后设置',409)
  updated=copy.deepcopy(data);assign(updated,effective(data,legacy,name)['path'],enabled)
  if semantic(updated)==semantic(data):return {'ok':True,'changed':False}
  out=io.StringIO();yaml.dump(updated,out);result=commit(path,state,raw,out.getvalue().encode(),'typing '+name)
  return {'ok':True,**result,'platform':name,'enabled':enabled,'reload_required':True}

if __name__=='__main__':
 try:print(json.dumps(execute(json.load(sys.stdin),sys.argv[1],sys.argv[2]),ensure_ascii=False))
 except Exception as error:
  print(json.dumps({'ok':False,'error':str(error) if isinstance(error,ConfigError) else '通讯行为配置未收到保存确认，请重新读取核对','status':getattr(error,'status',500)},ensure_ascii=False));sys.exit(1)
