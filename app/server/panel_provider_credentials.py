"""Prepare env/YAML/env-seeded auth-pool updates in one recoverable journal.

The native bridge must hold its auth-store lock AFTER config_lock; all native
auth writers must share that order before this helper is enabled in production.
No imports of Hermes, process startup, cache mutation or credential output.
"""
import copy,hashlib,io,json,re
from pathlib import Path
from panel_config_txn import ConfigError,config_lock,load_yaml,semantic
from panel_config_bundle import current,commit_bundle
from panel_env_txn import parse,render,quote

def reconcile_yaml(raw,old,value):
 if not raw or not old:return raw,[]
 yaml,data=load_yaml(raw);before=semantic(data);touched=[]
 def fix(block,path):
  if not isinstance(block,dict):return
  for key in ('api_key','api'):
   if isinstance(block.get(key),str) and block[key]==old:
    if value is None:block.pop(key)
    else:block[key]=value
    touched.append(path+'.'+key)
 fix(data.get('model'),'model')
 # New-style provider entries use "api" as an endpoint URL, unlike the
 # legacy model.api credential alias. Never rewrite provider URLs as keys.
 providers=data.get('providers')
 if isinstance(providers,dict):
  for name,block in providers.items():
   if isinstance(block,dict) and isinstance(block.get('api_key'),str) and block['api_key']==old:
    if value is None:block.pop('api_key')
    else:block['api_key']=value
    touched.append('providers.'+str(name)+'.api_key')
 for name,block in (data.get('auxiliary') or {}).items() if isinstance(data.get('auxiliary'),dict) else []:fix(block,'auxiliary.'+name)
 custom=data.get('custom_providers')
 for name,block in (custom.items() if isinstance(custom,dict) else enumerate(custom) if isinstance(custom,list) else []):fix(block,'custom_providers.'+str(name))
 if semantic(data)==before:return raw,touched
 stream=io.StringIO();yaml.dump(data,stream);encoded=stream.getvalue().encode();_,verified=load_yaml(encoded)
 if semantic(data)!=semantic(verified):raise ConfigError('凭证副本序列化不一致，尚未保存',503)
 return encoded,touched

def reconcile_auth(raw,key,value,providers):
 try:data=json.loads(raw) if raw is not None else {'version':1,'providers':{}}
 except Exception:raise ConfigError('凭证池无法解析，原文件已保留',503)
 if not isinstance(data,dict):raise ConfigError('凭证池格式不正确，原文件已保留',503)
 before=copy.deepcopy(data);source='env:'+key;pool=data.get('credential_pool',{});suppressed=data.get('suppressed_sources',{})
 if not isinstance(pool,dict) or not isinstance(suppressed,dict):raise ConfigError('凭证池结构不正确，原文件已保留',503)
 pruned=[]
 for provider,entries in list(pool.items()):
  if not isinstance(entries,list):raise ConfigError('凭证池条目格式不正确，原文件已保留',503)
  kept=[entry for entry in entries if not (isinstance(entry,dict) and entry.get('source')==source)]
  if len(kept)!=len(entries):
   pruned.append(provider)
   if kept:pool[provider]=kept
   else:del pool[provider]
 affected=sorted(set(providers)|set(pruned))
 if affected:
  markers=data.setdefault('panel_env_credentials',{})
  if not isinstance(markers,dict):raise ConfigError('凭证更新记录格式不正确，原文件已保留',503)
  markers[key]=None if value is None else hashlib.sha256(value.encode()).hexdigest()
 # Rotation prunes old env snapshots too. The native loader can seed the new
 # value; OAuth/manual/borrowed entries and provider grants stay byte-for-byte
 # equivalent as JSON values.
 for provider in affected:
  entries=suppressed.get(provider,[])
  if not isinstance(entries,list):raise ConfigError('凭证来源停用记录格式不正确，原文件已保留',503)
  if value is None:
   if source not in entries:suppressed[provider]=[*entries,source]
  else:
   kept=[entry for entry in entries if entry!=source]
   if kept:suppressed[provider]=kept
   else:suppressed.pop(provider,None)
 if suppressed:data['suppressed_sources']=suppressed
 else:data.pop('suppressed_sources',None)
 if data==before:return raw,pruned,affected
 return (json.dumps(data,ensure_ascii=False,indent=2)+'\n').encode(),pruned,affected

def filter_pool_entries(store,entries):
 """Reject stale in-memory env snapshots after an explicit rotation/removal."""
 markers=store.get('panel_env_credentials',{})
 if not isinstance(markers,dict):raise ConfigError('凭证更新记录格式不正确，原文件已保留',503)
 result=[]
 for entry in entries:
  source=entry.get('source') if isinstance(entry,dict) else None
  key=source[4:] if isinstance(source,str) and source.startswith('env:') else None
  if key in markers:
   expected=markers[key];token=entry.get('access_token') or entry.get('api_key')
   # Native disk-boundary sanitizer removes borrowed raw secrets and retains
   # its standard sha256:16 fingerprint; accept that representation as well.
   if expected is None:continue
   if isinstance(token,str):matches=hashlib.sha256(token.encode()).hexdigest()==expected
   else:matches=entry.get('secret_fingerprint')=='sha256:'+expected[:16]
   if not matches:continue
  result.append(entry)
 return result

def update(home,state,key,value,providers,*,after_publish=None):
 home=Path(home)
 if not isinstance(key,str) or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*',key):raise ConfigError('凭证变量名不正确')
 if value is not None:quote(value)
 with config_lock(state):
  env_path=home/'.env';yaml_path=home/'config.yaml';auth_path=home/'auth.json'
  env_raw,_=current(env_path);yaml_raw,_=current(yaml_path);auth_raw,_=current(auth_path)
  bindings,env=parse(env_raw or b'');old=env.get(key)
  # Validate YAML even if there is no old env value to match. Never continue a
  # credential update while an existing config cannot be inspected.
  if yaml_raw:load_yaml(yaml_raw)
  encoded_yaml,touched=reconcile_yaml(yaml_raw,old,value or None)
  encoded_auth,pruned,affected=reconcile_auth(auth_raw,key,value or None,providers)
  encoded_env=render(bindings,{key:value}) if value is not None or key in env else env_raw
  changes=[(p,b,a) for p,b,a in [(yaml_path,yaml_raw,encoded_yaml),(env_path,env_raw,encoded_env),(auth_path,auth_raw,encoded_auth)] if a is not None]
  result=commit_bundle(state,changes,'provider credential',after_publish=after_publish)
  return {**result,'ok':True,'key':key,'config_updates':touched,'config_scrubbed':touched if value is None else [],'pool_pruned':pruned,'providers':affected,'removed':value is None and key in env,'found':bool(key in env or pruned or touched)}
