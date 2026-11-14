"""Versioned model settings using the Gateway YAML as the only writable source.
No agent imports, migrations, env edits, model requests, or service starts.
"""
import copy,io,json,re,secrets,sys
from pathlib import Path
from urllib.parse import urlsplit
from panel_config_txn import ConfigError,config_lock,read_file,load_yaml,plain,semantic,checksum,commit

FIELDS=('providers','custom_providers','model','fallback_providers','fallback_model')
MODES=('chat_completions','codex_responses','anthropic_messages')
def revision(value):return checksum(semantic(value).encode())
def subset(data):return {key:data[key] for key in FIELDS if key in data}
from panel_model_catalog import enabled,entries,model_rows,model_ids,available_models,credential_fields,CREDENTIAL_FIELDS,provider_fields
from panel_model_credentials import inspect as inspect_credentials

def effective_chain(data):
 # Matches hermes_cli.fallback_config.get_fallback_chain, including legacy tail.
 result=[];seen=set()
 for key in ('fallback_providers','fallback_model'):
  raw=data.get(key,[]);raw=[raw] if isinstance(raw,dict) else raw if isinstance(raw,list) else []
  for index,item in enumerate(raw):
   if not isinstance(item,dict):continue
   provider=str(item.get('provider') or '').strip();model=str(item.get('model') or '').strip()
   if not provider or not model:continue
   identity=(provider.lower(),model.lower(),str(item.get('base_url') or '').strip().rstrip('/').lower())
   if identity in seen:continue
   seen.add(identity);result.append((key,index,item))
 return result

def public_provider(identifier,entry,legacy=None):
 origin,_,item=entry
 credentials=credential_fields(item,origin)
 fields=provider_fields(item,origin)
 models=[]
 legacy_rows=legacy.get(identifier,[]) if isinstance(legacy,dict) else []
 legacy_by_id={m.get('id') or m.get('name'):m for m in legacy_rows if isinstance(m,dict)} if isinstance(legacy_rows,list) else {}
 for mid in model_ids(item,origin):
  stored=next((m for m in model_rows(item,origin) if isinstance(m,dict) and (m.get('id') or m.get('model'))==mid),{})
  models.append({'id':mid,'name':str(stored.get('name') or legacy_by_id.get(mid,{}).get('name') or mid),'enabled':enabled(stored)})
 for mid,value in legacy_by_id.items():
  if mid and mid not in model_ids(item,origin):models.append({'id':mid,'name':str(value.get('name') or mid),'enabled':False})
 return {'id':identifier,'origin':origin,'name':str(item.get('name') or identifier),'revision':revision(item),'enabled':enabled(item),
  **fields,'models':models,
  'api_key_configured':bool(credentials['api_key'] or credentials['key_env']),
  'credential_source':'配置密钥优先，环境变量回退' if origin=='custom_providers' and credentials['api_key'] and credentials['key_env'] else '环境变量优先，配置密钥回退' if credentials['api_key'] and credentials['key_env'] else '环境变量' if credentials['key_env'] or credentials['api_key'].startswith('${') else '配置密钥' if credentials['api_key'] else '无密钥',
  'header_keys':list(item.get('extra_headers',{})) if isinstance(item.get('extra_headers',{}),dict) else [],
  'extra':{key:item[key] for key in ('context_length','max_output_tokens','request_timeout_seconds','rate_limit_delay','ssl_verify') if key in item},
  'note':str(item.get('note') or '')}

def catalog(data,legacy=None):
 providers=[public_provider(key,item,legacy) for key,item in entries(data).items()]
 primary=data.get('model',{});primary=primary if isinstance(primary,dict) else {'default':str(primary or '')}
 current={'provider':str(primary.get('provider') or ''),'model':str(primary.get('default') or '')}
 chain=[{'key':revision([key,index,item]),'provider':str(item['provider']).strip(),'model':str(item['model']).strip(),'source':key,
  'has_overrides':any(k not in ('provider','model') for k in item)} for key,index,item in effective_chain(data)]
 return {'ok':True,'revision':revision(subset(data)),'providers':providers,'primary':current,'fallbacks':chain,
  'active_provider':next((p['name'] for p in providers if p['id']==route_id(current['provider'])),current['provider']),
  'fallback_providers':[next((p['name'] for p in providers if p['id']==route_id(item['provider'])),item['provider']) for item in chain],
  'hermes_configured':bool(current['provider'] and current['model'])}

MOA_NAME=re.compile(r'[A-Za-z0-9_-]{1,40}')

def moa_raw(data):
 return data.get('moa') if isinstance(data.get('moa'),dict) else {}

def moa_primary(data):
 current=data.get('model');current=current if isinstance(current,dict) else {}
 return {'provider':str(current.get('provider') or ''),'model':str(current.get('default') or '')}

def moa_revision(data):
 # MOA 开关会改写主模型，所以指纹必须同时覆盖 moa 段与 model 段。
 return revision({'moa':moa_raw(data),'model':moa_primary(data)})

def moa_view(data):
 raw=moa_raw(data);presets=raw.get('presets') if isinstance(raw.get('presets'),dict) else {}
 primary=moa_primary(data);active=route_id(primary['provider'])=='moa'
 rows=[]
 for name,preset in presets.items():
  if not isinstance(preset,dict):continue
  refs=[]
  for item in preset.get('reference_models') or []:
   if isinstance(item,dict):refs.append({'provider':str(item.get('provider') or ''),'model':str(item.get('model') or ''),'enabled':item.get('enabled') is not False})
  agg=preset.get('aggregator') if isinstance(preset.get('aggregator'),dict) else {}
  rows.append({'name':str(name),'reference_models':refs,
   'aggregator':{'provider':str(agg.get('provider') or ''),'model':str(agg.get('model') or '')},
   'fanout':str(preset.get('fanout') or '')})
 return {'ok':True,'moa_revision':moa_revision(data),'enabled':active,
  'active_preset':primary['model'] if active else str(raw.get('active_preset') or ''),
  'default_preset':str(raw.get('default_preset') or ''),'presets':rows,'current_primary':primary,
  'previous_primary':raw.get('previous_primary') if isinstance(raw.get('previous_primary'),dict) else None,
  'configured':bool(raw)}

def moa_candidates(data,legacy):
 rows=[]
 for provider in catalog(data,legacy)['providers']:
  if not provider['enabled']:continue
  models=[{'id':m['id'],'name':m['name']} for m in provider['models'] if m.get('enabled') and m['id']!='auto']
  if models:rows.append({'id':provider['id'],'name':provider['name'],'models':models})
 return rows

def moa_apply(data,body):
 name=str(body.get('preset') or 'default').strip()
 if not MOA_NAME.fullmatch(name):raise ConfigError('预设名称只能用字母、数字、下划线，最多 40 字')
 if name.lower()=='moa':raise ConfigError('预设名称不能叫 moa')
 refs=body.get('reference_models');agg=body.get('aggregator');on=body.get('enabled')
 if type(on) is not bool:raise ConfigError('MOA 开关状态不正确')
 if not isinstance(agg,dict):raise ConfigError('请选择聚合模型')
 if not isinstance(refs,list) or not 1<=len(refs)<=8:raise ConfigError('参考模型要选 1 到 8 个')
 validate_target(data,agg.get('provider'),agg.get('model'))
 aggregate=(route_id(agg.get('provider')),agg.get('model'))
 clean=[];seen=set()
 for item in refs:
  if not isinstance(item,dict):raise ConfigError('参考模型格式不正确')
  validate_target(data,item.get('provider'),item.get('model'))
  identity=(route_id(item.get('provider')),item.get('model'))
  if identity in seen:raise ConfigError('参考模型不能重复')
  if identity==aggregate:raise ConfigError('聚合模型不能同时作为参考模型')
  seen.add(identity);clean.append({'provider':item['provider'],'model':item['model'],'enabled':True})
 moa=copy.deepcopy(moa_raw(data))
 presets=copy.deepcopy(moa.get('presets')) if isinstance(moa.get('presets'),dict) else {}
 preset=copy.deepcopy(presets.get(name)) if isinstance(presets.get(name),dict) else {}
 preset['reference_models']=clean
 preset['aggregator']={'provider':agg['provider'],'model':agg['model']}
 presets[name]=preset
 moa['presets']=presets
 if not moa.get('default_preset'):moa['default_preset']=name
 primary=moa_primary(data)
 if on:
  if route_id(primary['provider'])!='moa' and primary['provider'] and primary['model']:
   moa['previous_primary']={'provider':primary['provider'],'model':primary['model']}
  moa['active_preset']=name
  current=copy.deepcopy(data.get('model')) if isinstance(data.get('model'),dict) else {}
  current['provider']='moa';current['default']=name
  data['model']=current
 else:
  moa['active_preset']=''
  previous=moa.get('previous_primary')
  if route_id(primary['provider'])=='moa':
   if not isinstance(previous,dict) or not previous.get('provider') or not previous.get('model'):
    raise ConfigError('关掉 MOA 需要先回到主模型：请在上面的①里选好主模型再关')
   try:validate_target(data,str(previous['provider']),str(previous['model']))
   except ConfigError:raise ConfigError('原主模型已停用或不在列表里，请先在①里重选主模型再关 MOA')
   current=copy.deepcopy(data.get('model')) if isinstance(data.get('model'),dict) else {}
   current['provider']=str(previous['provider']);current['default']=str(previous['model'])
   data['model']=current
 data['moa']=moa
 return data

def text(value,label,limit=1000,empty=False):
 if not isinstance(value,str) or len(value)>limit or any(ord(c)<32 for c in value) or (not empty and not value.strip()):raise ConfigError(label+'格式不正确')
 return value.strip()

def destination(value):
 try:
  u=urlsplit(value);return u.scheme,u.hostname,u.port
 except ValueError:raise ConfigError('模型服务地址格式不正确')

def patch(old,changes,origin='providers',legacy=None):
 if not isinstance(changes,dict) or set(changes)-{'name','base_url','api_mode','default_model','models','credential','headers','note','context_length','max_output_tokens','request_timeout_seconds','rate_limit_delay','ssl_verify','headers_json'}:raise ConfigError('模型服务修改字段不正确')
 new=copy.deepcopy(old)
 if 'base_url' in changes:
  url=text(changes['base_url'],'模型服务地址',2000);u=urlsplit(url)
  if u.scheme not in ('http','https') or not u.hostname or u.username or u.password or u.query or u.fragment:raise ConfigError('服务地址需为不含凭证或查询参数的HTTP/HTTPS地址')
  if destination(provider_fields(old,origin)['base_url'])!=destination(url):
   for key in (*CREDENTIAL_FIELDS,'extra_headers'):new.pop(key,None)
  for key in ('api','url','baseUrl'):new.pop(key,None)
  new['base_url']=url.rstrip('/')
 if 'name' in changes:
  if origin=='custom_providers' and old.get('name') and not old.get('provider_key'):new['provider_key']=old['name']
  new['name']=text(changes['name'],'服务名称',120)
 if 'note' in changes:
  note=changes['note']
  if not isinstance(note,str) or len(note)>2000 or '\x00' in note:raise ConfigError('备注需为2000字以内的文本')
  new['note']=note.strip()
 if 'api_mode' in changes:
  mode=changes['api_mode']
  if mode not in ('',*MODES):raise ConfigError('模型接口协议不正确')
  for key in ('api_mode','transport','apiMode'):new.pop(key,None)
  if mode:new['api_mode']=mode
 if 'credential' in changes:
  operation=changes['credential']
  if not isinstance(operation,dict) or operation.get('action') not in ('keep','replace','clear'):raise ConfigError('密钥操作不正确')
  if operation['action']!='keep':
   for key in CREDENTIAL_FIELDS:new.pop(key,None)
   if operation['action']=='replace':new['api_key']=text(operation.get('value'),'API密钥',16000)
 if 'headers' in changes:
  if not isinstance(changes['headers'],dict):raise ConfigError('请求头修改格式不正确')
  headers=copy.deepcopy(new.get('extra_headers',{}))
  if not isinstance(headers,dict):raise ConfigError('原请求头结构无法识别，原配置已保留',503)
  for key,operation in changes['headers'].items():
   if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}',key) or not isinstance(operation,dict):raise ConfigError('请求头名称不正确')
   if operation.get('action')=='clear':headers.pop(key,None)
   elif operation.get('action')=='replace':headers[key]=text(operation.get('value'),'请求头值',16000)
   elif operation.get('action')!='keep':raise ConfigError('请求头操作不正确')
  if headers:new['extra_headers']=headers
  else:new.pop('extra_headers',None)
 if not old and (not new.get('name') or not new.get('base_url')):raise ConfigError('新服务需填写名称与服务地址')
 # Advanced per-provider knobs. Only keys the kernel recognizes are accepted; anything else
 # would be silently dropped by the runtime, so it is rejected here instead of stored as decoration.
 for key,low,high,isint in (('context_length',1000,4000000,True),('max_output_tokens',1,500000,True),
                            ('request_timeout_seconds',1,3600,True),('rate_limit_delay',0,600,False)):
  if key in changes:
   value=changes[key]
   if value in (None,''):
    new.pop(key,None);continue
   if isinstance(value,str):
    try:value=float(value)
    except ValueError:raise ConfigError('高级选项需填写数字')
   if isinstance(value,bool) or not isinstance(value,(int,float)) or value!=value or value<low or value>high:
    raise ConfigError('高级选项超出范围：'+key)
   new[key]=int(value) if isint else float(value)
 if 'ssl_verify' in changes:
  value=changes['ssl_verify']
  if value is None:new.pop('ssl_verify',None)
  elif type(value) is not bool:raise ConfigError('SSL 校验开关不正确')
  else:new['ssl_verify']=value
 if 'headers_json' in changes:
  extra=changes['headers_json']
  if extra is None:new.pop('extra_headers',None)
  elif not isinstance(extra,dict) or len(extra)>50:raise ConfigError('额外请求头需为对象且不超过 50 项')
  else:
   merged=copy.deepcopy(new.get('extra_headers',{}))
   if not isinstance(merged,dict):raise ConfigError('原请求头结构无法识别，原配置已保留',503)
   for key,value in extra.items():
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}',str(key)):raise ConfigError('请求头名称不正确')
    if not isinstance(value,str) or len(value)>16000:raise ConfigError('请求头值需为文本')
    merged[str(key)]=value
   new['extra_headers']=merged
 if 'models' in changes:
  models=changes['models']
  if not isinstance(models,list) or len(models)>2000:raise ConfigError('模型列表最多2000项')
  stored={m if isinstance(m,str) else m.get('id') or m.get('model'):m for m in model_rows(old,origin) if isinstance(m,(str,dict))};seen=set();updated=[]
  prior={m.get('id') or m.get('name'):m for m in legacy or [] if isinstance(m,dict)}
  for m in models:
   if not isinstance(m,dict) or set(m)-{'id','name','enabled'}:raise ConfigError('模型条目格式不正确')
   mid=text(m.get('id'),'模型ID',500)
   if mid in seen:raise ConfigError('模型ID重复：'+mid)
   seen.add(mid);original=stored.get(mid,{})
   value=copy.deepcopy(prior.get(mid,{}));value.update({'id':original} if isinstance(original,str) else copy.deepcopy(original))
   value['id']=mid;value['name']=text(m.get('name',mid),'模型名称',500)
   if type(m.get('enabled',True)) is not bool:raise ConfigError('模型启用状态不正确')
   value['enabled']=m.get('enabled',True);updated.append(value)
  # Removing a row archives it in place; preserves metadata and historical selections.
  for mid,value in stored.items():
   if mid not in seen:
    value=copy.deepcopy(value) if isinstance(value,dict) else {'id':value};value['enabled']=False;updated.append(value)
  new['models']={m['id']:{k:v for k,v in m.items() if k!='id'} for m in updated} if isinstance(old.get('models'),dict) else updated
 if 'default_model' in changes:
  for key in ('model','default_model','defaultModel'):new.pop(key,None)
  new['model' if origin=='custom_providers' else 'default_model']=text(changes['default_model'],'服务默认模型',500)
 default=provider_fields(new,origin)['model']
 if (not old or any(key in changes for key in ('default_model','models'))) and (not default or default not in available_models(new,origin)):raise ConfigError('服务默认模型必须在启用的模型列表中')
 return new

def set_entry(data,entry,identifier,value):
 origin,key,_=entry
 data[origin]=copy.deepcopy(data.get(origin,{} if origin=='providers' else []));data[origin][key]=value

def route_id(provider):return provider[7:] if isinstance(provider,str) and provider.startswith('custom:') else provider

def validate_target(data,provider,model):
 if not isinstance(provider,str) or not isinstance(model,str):raise ConfigError('请选择服务和模型')
 entry=entries(data).get(route_id(provider))
 if not entry or not enabled(entry[2]) or model not in available_models(entry[2],entry[0]):raise ConfigError('所选服务或模型未启用，请刷新配置',409)

def execute(body,path,state,var_root=None):
 with config_lock(state):
  legacy={}
  legacy_path=Path(var_root)/'provider-models.json' if var_root else None
  if legacy_path and legacy_path.exists():
   legacy_raw,_=read_file(legacy_path)
   try:legacy=json.loads(legacy_raw)
   except Exception:raise ConfigError('保留模型清单无法读取，原文件已保留',503)
   if not isinstance(legacy,dict):raise ConfigError('保留模型清单格式不正确',503)
  raw,_=read_file(path);yaml,data=load_yaml(raw)
  def view(value):
   output=catalog(value,legacy);pools=inspect_credentials(Path(path).parent,value)
   for provider in output['providers']:provider['credential_pool']=pools[provider['id']]
   return output
  action=body.get('action')
  if action=='read':return view(data)
  if action=='moa_read':return {**moa_view(data),'candidates':moa_candidates(data,legacy)}
  if action=='moa_save':
   if body.get('revision')!=moa_revision(data):raise ConfigError('MOA 配置已被其他页面修改，请重新核对',409)
   updated=moa_apply(copy.deepcopy(data),body)
   if semantic(updated)==semantic(data):
    return {**moa_view(updated),'candidates':moa_candidates(updated,legacy),'changed':False}
   output=io.StringIO();yaml.dump(updated,output);encoded=output.getvalue().encode();_,verified=load_yaml(encoded)
   if semantic(verified)!=semantic(updated):raise ConfigError('MOA 配置序列化不一致，原文件已保留',503)
   result=commit(path,state,raw,encoded,'moa:'+str(body.get('preset') or 'default'),{'models_after':revision(subset(updated)),'moa_after':moa_revision(updated)})
   return {**result,**moa_view(updated),'candidates':moa_candidates(updated,legacy),'changed':True,'reload_required':True}
  # Whole model-subtree revision: routes/credentials/list edits cannot race each other;
  # unrelated memory/channel/MCP saves do not cause model conflicts.
  if body.get('revision')!=revision(subset(data)):raise ConfigError('模型配置已被其他页面修改，当前表单已保留，请重新核对',409)
  updated=copy.deepcopy(data);all_entries=entries(data);identifier=body.get('id');entry=all_entries.get(identifier)
  if action=='create':
   identifier='custom_'+secrets.token_hex(10);value=patch({},body.get('changes',{}));updated['providers']=copy.deepcopy(data.get('providers',{}));updated['providers'][identifier]=value
  elif action in ('update','toggle'):
   if not entry:raise ConfigError('模型服务不存在，请刷新',404)
   if action=='toggle':
    value=copy.deepcopy(entry[2]);value['enabled']=body.get('enabled')
    if type(value['enabled']) is not bool:raise ConfigError('服务启用状态不正确')
   else:value=patch(entry[2],body.get('changes',{}),entry[0],legacy.get(identifier,[]))
   set_entry(updated,entry,identifier,value)
   references=[data.get('model',{})]+[item for _,_,item in effective_chain(data)]
   for route in references:
    if isinstance(route,dict) and route_id(route.get('provider'))==identifier:
     model=route.get('model') or route.get('default')
     if not enabled(value) or model not in available_models(value,entry[0]):raise ConfigError('此服务或模型仍用于默认或回退路线，请先调整路线',409)
  elif action in ('primary','fallback','routes'):
   primary_provider=body.get('provider') if action in ('primary','routes') else None
   primary_model=body.get('model') if action in ('primary','routes') else None
   if action in ('primary','routes'):
    validate_target(data,primary_provider,primary_model)
    value=copy.deepcopy(data.get('model',{}));value=value if isinstance(value,dict) else {}
    if value.get('provider')!=primary_provider:
     for key in ('base_url','api_key','key_env','api_key_env','api_mode','transport'):value.pop(key,None)
    value['provider']=primary_provider;value['default']=primary_model;updated['model']=value
   if action in ('fallback','routes'):
    current=effective_chain(data);items=body.get('entries')
    if not isinstance(items,list) or len(items)>40:raise ConfigError('回退路线最多40项')
    old={revision([key,index,value]):value for key,index,value in current};chain=[];seen=set()
    for item in items:
     if not isinstance(item,dict):raise ConfigError('回退路线格式不正确')
     if item.get('key'):
      if item['key'] not in old:raise ConfigError('回退路线已改变，请刷新',409)
      value=copy.deepcopy(old[item['key']])
     else:
      validate_target(data,item.get('provider'),item.get('model'));value={'provider':item['provider'],'model':item['model']}
     current_primary=data.get('model',{});current_primary=current_primary if isinstance(current_primary,dict) else {'default':str(current_primary or '')}
     effective_primary_provider=primary_provider if action=='routes' else current_primary.get('provider')
     effective_primary_model=primary_model if action=='routes' else current_primary.get('default')
     if route_id(value['provider'])==route_id(effective_primary_provider) and value['model']==effective_primary_model:raise ConfigError('主模型不能同时出现在回退路线中')
     identity=(value['provider'],value['model'],value.get('base_url',''))
     if identity in seen:raise ConfigError('回退路线不能重复')
     seen.add(identity);chain.append(value)
    updated['fallback_providers']=chain;updated.pop('fallback_model',None)
  elif action=='delete':
   # 2026-11-13：面板卡片只能加不能删，用户只能去改 config.yaml。这里补上删除动作：
   # 只删这条服务本身；仍被主模型/回退引用时拒绝，避免删出一条断掉的路线。
   if not entry:raise ConfigError('模型服务不存在，请刷新',404)
   for route in [data.get('model',{})]+[item for _,_,item in effective_chain(data)]:
    if isinstance(route,dict) and route_id(route.get('provider'))==identifier:
     raise ConfigError('此服务仍用于默认或回退路线，请先在卡片里改路线再删除',409)
   origin,key,_=entry
   container=copy.deepcopy(data.get(origin))
   if isinstance(container,dict):container.pop(key,None)
   elif isinstance(container,list):container.pop(key)
   updated[origin]=container
  elif action=='restore':
   change_id=body.get('change_id','')
   if not re.fullmatch(r'[0-9]+-[a-f0-9]{12}',change_id):raise ConfigError('恢复记录不正确')
   directory=Path(state)/'config-history';metadata=json.loads((directory/(change_id+'.json')).read_text())
   if metadata.get('details',{}).get('models_after')!=revision(subset(data)):raise ConfigError('此后模型配置已经修改，不能直接撤销旧操作',409)
   if metadata.get('file')!=str(path) or not metadata.get('reason','').startswith('models:'):raise ConfigError('恢复记录不属于当前模型配置',409)
   _,old=load_yaml((directory/(change_id+'.yaml')).read_bytes())
   for key in FIELDS:
    if key in old:updated[key]=copy.deepcopy(old[key])
    else:updated.pop(key,None)
  else:raise ConfigError('模型配置操作不存在',404)
  if semantic(updated)==semantic(data):return {**view(data),'changed':False}
  output=io.StringIO();yaml.dump(updated,output);encoded=output.getvalue().encode();_,verified=load_yaml(encoded)
  if semantic(verified)!=semantic(updated):raise ConfigError('模型配置序列化不一致，原文件已保留',503)
  public=view(updated)
  result=commit(path,state,raw,encoded,'models:'+action,{'models_after':revision(subset(updated))})
  return {**result,**public,'changed':True,'id':identifier,'reload_required':True}

if __name__=='__main__':
 try:print(json.dumps(execute(json.load(sys.stdin),Path(sys.argv[1]),Path(sys.argv[2]),sys.argv[3] if len(sys.argv)>3 else None),ensure_ascii=False))
 except Exception as error:
  print(json.dumps({'ok':False,'error':str(error) if isinstance(error,ConfigError) else '模型配置未收到保存确认，请重新读取核对','status':getattr(error,'status',500)},ensure_ascii=False));sys.exit(1)
