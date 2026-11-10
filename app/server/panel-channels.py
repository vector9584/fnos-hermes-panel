"""Structured channel edits using the shared YAML/env recoverable publication.

No adapter imports, dependency installation, connection attempts or gateway
startup. GET only returns selected non-secret values and secret presence flags.
"""
import copy,io,json,os,re,sys
from pathlib import Path
from panel_config_txn import ConfigError,config_lock,read_file,load_yaml,checksum,semantic,assign,at,MISSING
from panel_config_bundle import commit_bundle,payload
from panel_env_txn import parse,render
from panel_channel_schema import CATALOG,AUTH_PREFIXES,ACCESS_FIELDS

def startup_authorization(state,env):
 # Match spawnHermes: inherited env -> app default -> .env.providers -> .env.
 # Only expose these non-secret switches. Never return a full environment.
 keys=['GATEWAY_ALLOW_ALL_USERS',*(p+'_ALLOW_ALL_USERS' for p in AUTH_PREFIXES.values())]
 values={k:os.environ[k] for k in keys if k in os.environ};sources={k:'process' for k in values}
 values['GATEWAY_ALLOW_ALL_USERS']='true';sources['GATEWAY_ALLOW_ALL_USERS']='application_default'
 try:provider_raw,_=read_file(Path(state).parent/'.env.providers')
 except FileNotFoundError:provider_raw=b''
 _,providers=parse(provider_raw or b'')
 for source,layer in [('providers',providers),('env',env)]:
  for key in keys:
   if key in layer and layer[key] is not None:values[key]=layer[key];sources[key]=source
 return {k:values.get(k,'') for k in keys},{k:sources.get(k,'native_default') for k in keys}

def access_summary(values,sources):
 key='GATEWAY_ALLOW_ALL_USERS'
 return {'values':{'global_allow_all':str(values[key]).strip().lower() in ['true','1','yes']},'source':sources[key],'fields':ACCESS_FIELDS}

def mapping(value):return value if isinstance(value,dict) else {}
def blocks(data,legacy,name):
 gateway=mapping(data.get('gateway'))
 return [mapping(mapping(legacy.get('platforms')).get(name)),mapping(mapping(gateway.get('platforms')).get(name)),mapping(mapping(data.get('platforms')).get(name)),mapping(gateway.get(name))]
def chosen_block(data,name):
 gateway=mapping(data.get('gateway'))
 for candidate in [data.get(name),mapping(gateway.get('platforms')).get(name),mapping(data.get('platforms')).get(name)]:
  if isinstance(candidate,dict):return candidate
 return {}
def effective(data,legacy,name):
 result={}
 for block in blocks(data,legacy,name):
  extra={**mapping(result.get('extra')),**mapping(block.get('extra'))};result.update(copy.deepcopy(block));result['extra']=extra
 top=mapping(data.get(name))
 if 'enabled' in top:result['enabled']=top['enabled']
 return result

def value_at(data,path):return at(data,path.split('.')) if path else MISSING

def normalize(value,field,*,strict=False):
 kind=field['kind']
 if kind=='bool':
  if type(value) is bool:return value
  if not strict and str(value).strip().lower() in ['true','1','yes','on']:return True
  if not strict and str(value).strip().lower() in ['false','0','no','off']:return False
  raise ConfigError('字段“'+field['label']+'”需要开关值')
 if kind=='list':
  if isinstance(value,str):value=re.split(r'[,;\n]',value)
  if not isinstance(value,list) or any(not isinstance(item,(str,int)) for item in value):raise ConfigError('字段“'+field['label']+'”需要列表')
  values=list(dict.fromkeys(str(item).strip() for item in value if str(item).strip()))
  if len(values)>1000 or any(len(item)>500 for item in values):raise ConfigError('列表内容过长')
  return values
 if kind=='port':
  if not str(value).isdigit() or not 1<=int(value)<=65535:raise ConfigError('端口必须在 1 到 65535 之间')
  return int(value)
 if not isinstance(value,str) or len(value)>16000 or any(c in value for c in '\r\n\x00'):raise ConfigError('字段“'+field['label']+'”需要单行文本')
 if kind=='select' and value not in field['choices'] and strict:raise ConfigError('字段“'+field['label']+'”的选项不正确')
 return value

def field_value(data,legacy,env,name,field):
 if field['key']=='allow_all_users':return str(env.get(field['env'],'')).strip().lower() in ['true','1','yes'],'startup'
 cfg=effective(data,legacy,name);chosen=chosen_block(data,name);path=field['path'];key=field['key'];source='default';value=MISSING
 # Native env bridges/adapter options take a non-empty env value first. Empty
 # env values fall back to YAML; writes therefore update existing YAML aliases.
 if not field.get('yaml_first') and field['env'] and env.get(field['env']):value=env[field['env']];source='env'
 if value is MISSING:
  value=value_at(cfg,path)
  if field['env'] and path and not path.startswith('extra.') and key not in ['token','typing_indicator','gateway_restart_notification']:
   chosen_value=value_at(chosen,path)
   if chosen_value is not MISSING:value=chosen_value
  # Shared bridge selects a top-level platform block, then nested gateway,
  # then ordinary platforms. Direct PlatformConfig fields retain precedence.
  shared=path and (path.startswith('extra.') or key in ['typing_indicator','gateway_restart_notification'])
  if shared:
   alias=path.removeprefix('extra.')
   v=value_at(chosen,alias)
   if v is not MISSING and (path.startswith('extra.') or value is MISSING):value=v
  if value is MISSING:
   for alias in field['aliases']:
    v=value_at(chosen,alias)
    if v is not MISSING:value=v;break
  if value is not MISSING:source='yaml'
 if (value is MISSING or value is None) and field['env'] and env.get(field['env']):value=env[field['env']];source='env'
 if value is MISSING or value is None:value=field['default'];source='default'
 if field['kind']=='list' and value=='':value=[]
 if field['kind']=='bool' and value=='':value=False
 # Invalid saved values remain visible for correction; no GET silently rewrites.
 try:normalized=normalize(value,field)
 except ConfigError:normalized=value
 return normalized,source

def bool_value(value):return value if type(value) is bool else str(value).lower() in ['true','1','yes','on']
def summary(data,legacy,env,name):
 schema=CATALOG[name];values={};secrets={};sources={}
 for field in schema['fields']:
  value,source=field_value(data,legacy,env,name,field);sources[field['key']]=source
  if field['secret']:secrets[field['key']]={'configured':bool(value),'source':source}
  else:values[field['key']]=value
 present=lambda key:secrets.get(key,{}).get('configured',bool(values.get(key)))
 missing=[key for key in schema['required'] if not present(key)]
 if schema['alternative'] and not any(present(key) for key in schema['alternative']):missing.extend(schema['alternative'])
 configured=not missing
 if name=='whatsapp':configured=bool_value(env.get('WHATSAPP_ENABLED')) or bool(value_at(effective(data,legacy,name),'extra.session_path') is not MISSING)
 cfg=effective(data,legacy,name);explicit=cfg.get('enabled',MISSING)
 enabled=bool_value(explicit) if explicit is not MISSING else configured
 return {'id':name,'name':schema['name'],'values':values,'secrets':secrets,'sources':sources,'enabled':enabled,'enabled_explicit':explicit is not MISSING,'configured':configured,'missing_fields':missing,'fields':schema['fields'],'qr':schema['qr']}

def load(path):
 raw,_=read_file(path);yaml,data=load_yaml(raw)
 try:env_raw,_=read_file(path.with_name('.env'))
 except FileNotFoundError:env_raw=None
 bindings,env=parse(env_raw or b'')
 try:legacy_raw,_=read_file(path.with_name('gateway.json'))
 except FileNotFoundError:legacy_raw=b''
 try:legacy=json.loads(legacy_raw) if legacy_raw else {}
 except Exception:raise ConfigError('旧网关配置无法解析，原文件已保留',503)
 if not isinstance(legacy,dict):raise ConfigError('旧网关配置格式不正确',503)
 revision=checksum(raw+b'\x00'+(env_raw or b'')+b'\x00'+legacy_raw)
 return raw,yaml,data,env_raw,bindings,env,legacy,revision

def update_yaml(data,name,field,value,legacy):
 path=field.get('path')
 # Write the canonical winning merge block, and update only aliases already
 # present elsewhere. Preserve nested unknown fields and per-chat overrides.
 bases=[['platforms',name],['gateway','platforms',name],['gateway',name],[name]]
 paths=[*([path] if path else []),*field.get('aliases',[])]
 if path and path.startswith('extra.'):paths.append(path[len('extra.'):])
 if path and (not field['secret'] or (value=='' and value_at(effective(data,legacy,name),path) is not MISSING)):assign(data,['platforms',name,*path.split('.')],value)
 for base in bases:
  for candidate in set(paths):
   location=[*base,*candidate.split('.')]
   if at(data,location) is not MISSING:assign(data,location,value)

def set_enabled(data,name,value):
 if type(value) is not bool:raise ConfigError('启用状态必须是开关值')
 assign(data,['platforms',name,'enabled'],value)
 for base in [[name],['gateway',name],['gateway','platforms',name]]:
  location=base+['enabled']
  if at(data,location) is not MISSING:assign(data,location,value)

def execute(body,path,state):
 path=Path(path)
 if path.name!='config.yaml':raise ConfigError('通讯配置路径不正确')
 with config_lock(state):
  raw,yaml,data,env_raw,bindings,env,legacy,revision=load(path)
  auth,auth_sources=startup_authorization(state,env)
  revision=checksum((revision+json.dumps([auth,auth_sources],sort_keys=True)).encode())
  effective_env={**env,**auth}
  action=body.get('action','read')
  if action=='read':return {'ok':True,'revision':revision,'access':access_summary(auth,auth_sources),'channels':[summary(data,legacy,effective_env,name) for name in CATALOG]}
  if body.get('revision')!=revision:raise ConfigError('通讯配置已在别处修改，当前输入已保留，请核对最新配置',409)
  name=body.get('id')
  shared=name=='gateway-access'
  if name not in CATALOG and not shared:raise ConfigError('通讯渠道不存在',404)
  if shared and ('enabled' in body or action=='toggle'):raise ConfigError('共享授权没有渠道启用开关')
  updated=copy.deepcopy(data);operations={};schema={'fields':ACCESS_FIELDS} if shared else CATALOG[name]
  if action=='save':
   edits=body.get('changes',{})
   if not isinstance(edits,dict):raise ConfigError('通讯设置格式不正确')
   fields={item['key']:item for item in schema['fields']}
   for key,patch in edits.items():
    if key not in fields:raise ConfigError('此设置不受当前渠道支持，请刷新面板',400)
    field=fields[key]
    if field['secret']:
     if not isinstance(patch,dict) or patch.get('action') not in ('keep','replace','clear'):raise ConfigError('请选择保留、替换或清除凭证')
     if patch['action']=='keep':continue
     value='' if patch['action']=='clear' else normalize(patch.get('value'),field,strict=True)
     if patch['action']=='replace' and not value:raise ConfigError('替换凭证不能为空；如需移除，请选择清除')
    else:value=normalize(patch,field,strict=True)
    if field['env']:operations[field['env']]=','.join(value) if isinstance(value,list) else str(value).lower() if type(value) is bool else str(value)
    update_yaml(updated,name,field,value,legacy)
   if 'enabled' in body:set_enabled(updated,name,body['enabled'])
  elif action=='toggle':set_enabled(updated,name,body.get('enabled'))
  elif action=='restore':
   identifier=body.get('change_id','')
   if not isinstance(identifier,str) or not re.fullmatch(r'[0-9]+-[a-f0-9]{32}',identifier):raise ConfigError('撤销记录不正确')
   directory=Path(state)/'config-bundles'/identifier
   record_raw,_=read_file(directory/'journal.json')
   try:record=json.loads(record_raw)
   except Exception:raise ConfigError('撤销记录无法解析，原文件已保留',503)
   if record.get('reason')!='channel:'+name or record.get('status')!='committed':raise ConfigError('此记录不属于该渠道的已完成保存',409)
   changes=[]
   for index,item in enumerate(record['entries']):
    target=Path(item['path'])
    if target not in (path,path.with_name('.env')):raise ConfigError('撤销记录的环境不匹配',409)
    current=raw if target==path else env_raw
    if (checksum(current) if current is not None else None)!=item['after']:raise ConfigError('此后配置已有修改，不能直接撤销旧保存',409)
    before=payload(directory,item,index,'before')
    # New-file undo keeps an empty env file rather than deleting configuration.
    changes.append((target,current,before if before is not None else b''))
   return {**commit_bundle(state,changes,'channel:'+name), 'ok':True,'restart_required':True}
  else:raise ConfigError('通讯配置操作不存在',404)
  changed_env=render(bindings,operations) if operations else env_raw
  resulting_env={**effective_env,**operations};view=access_summary(resulting_env,{**auth_sources,**{k:'env' for k in operations}}) if shared else summary(updated,legacy,resulting_env,name)
  if body.get('enabled') is True and not view['configured']:raise ConfigError('请先补齐渠道必需的凭证和地址，再启用')
  if name in ('whatsapp','webhook') and 'enabled' in body:
   operations['WHATSAPP_ENABLED' if name=='whatsapp' else 'WEBHOOK_ENABLED']='true' if body['enabled'] else 'false';changed_env=render(bindings,operations)
  stream=io.StringIO();yaml.dump(updated,stream);encoded=raw if semantic(data)==semantic(updated) else stream.getvalue().encode();_,verified=load_yaml(encoded)
  if semantic(updated)!=semantic(verified):raise ConfigError('通讯配置序列化不一致，原文件已保留',503)
  changes=[(path,raw,encoded)]
  if changed_env is not None:changes.append((path.with_name('.env'),env_raw,changed_env))
  result=commit_bundle(state,changes,'channel:'+name)
  return {**result,'ok':True,'restart_required':bool(result.get('changed')),'channel':view}

if __name__=='__main__':
 try:print(json.dumps(execute(json.load(sys.stdin),sys.argv[1],sys.argv[2]),ensure_ascii=False))
 except Exception as error:
  print(json.dumps({'ok':False,'error':str(error) if isinstance(error,ConfigError) else '通讯配置未收到保存确认，请重新读取核对','status':getattr(error,'status',503)},ensure_ascii=False));sys.exit(1)
