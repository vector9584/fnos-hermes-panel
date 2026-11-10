"""Pure model catalog helpers; never import the agent or mutate configuration."""
from panel_config_txn import ConfigError,plain
import re
from urllib.parse import urlsplit
def enabled(item):
 flag=item.get('enabled',True)
 return flag.strip().lower() not in ('false','0','no','off') if isinstance(flag,str) else bool(flag)
def entries(data):
 result={}
 providers=data.get('providers',{})
 if not isinstance(providers,dict):raise ConfigError('模型服务配置不是映射，原配置已保留',503)
 for key,item in providers.items():
  if isinstance(item,dict):result[str(key)]=('providers',key,item)
 legacy=data.get('custom_providers',[]) or []
 if not isinstance(legacy,list):raise ConfigError('旧模型服务配置不是列表，原配置已保留',503)
 for index,item in enumerate(legacy):
  if isinstance(item,dict):
   key=str(item.get('provider_key') or item.get('name') or '')
   if key and key not in result:result[key]=('custom_providers',index,item)
 return result

def provider_fields(item,origin):
 # A read-only projection, not a migration: legacy normalization and the new
 # named-provider resolver intentionally have different precedence rules.
 value=dict(item)
 if origin=='custom_providers':
  for alias,canonical in (('baseUrl','base_url'),('apiMode','api_mode'),('defaultModel','default_model')):
   if alias in value and canonical not in value:value[canonical]=value[alias]
  base=''
  for key in ('base_url','url','api'):
   candidate=value.get(key)
   if not isinstance(candidate,str) or not candidate.strip():continue
   candidate=candidate.strip()
   try:parsed=urlsplit(candidate);valid=bool(parsed.scheme and parsed.netloc)
   except ValueError:valid=False
   if re.search(r'\{[^}]+\}',candidate) or valid:base=candidate;break
  model=value.get('model') or value.get('default_model')
 else:
  base=value.get('api') or value.get('url') or value.get('base_url') or ''
  model=value.get('default_model')
 raw_mode=value.get('api_mode') or value.get('transport')
 mode=raw_mode.strip().lower() if isinstance(raw_mode,str) else ''
 if mode not in ('chat_completions','codex_responses','anthropic_messages','bedrock_converse','codex_app_server'):mode=''
 return {'base_url':str(base).strip(),'model':model.strip() if isinstance(model,str) else '', 'api_mode':mode}

def model_rows(item,origin='providers'):
 value=item.get('models',[]) or []
 if isinstance(value,dict):return [{**(plain(meta) if isinstance(meta,dict) else {}),'id':str(key)} for key,meta in value.items()]
 if isinstance(value,list):
  if origin!='custom_providers':return value
  rows=[]
  for row in value:
   if isinstance(row,str):rows.append(row.strip());continue
   if not isinstance(row,dict):continue
   mid=row.get('id')
   if not isinstance(mid,str) or not mid.strip():mid=row.get('name')
   if isinstance(mid,str) and mid.strip():rows.append({**plain(row),'id':mid.strip()})
  return rows
 raise ConfigError('模型清单格式无法识别，原配置已保留',503)

def model_ids(item,origin='providers'):
 result=[]
 for model in model_rows(item,origin):
  identifier=model if isinstance(model,str) else model.get('id') or model.get('model') if isinstance(model,dict) else None
  if identifier and identifier not in result:result.append(str(identifier))
 default=provider_fields(item,origin)['model']
 if default and default not in result:result.insert(0,str(default))
 return result

def available_models(item,origin='providers'):
 disabled={str(m.get('id') or m.get('model')) for m in model_rows(item,origin) if isinstance(m,dict) and not enabled(m)}
 return [identifier for identifier in model_ids(item,origin) if identifier not in disabled]


def detected_mode(base):
 # Mirrors runtime_provider._detect_api_mode_for_url for saved custom endpoints.
 parsed=urlsplit(base);host=(parsed.hostname or '').lower();path=parsed.path.lower().rstrip('/')
 if host=='api.x.ai' or host=='api.openai.com' or host in ('us.api.openai.com','eu.api.openai.com'):return 'codex_responses'
 if host=='api.anthropic.com' or path.endswith('/anthropic') or path.endswith('/anthropic/v1') or (host=='api.kimi.com' and '/coding' in path):return 'anthropic_messages'
 return 'chat_completions'

# Legacy entries pass through config._normalize_custom_provider_entry before
# native named resolution. New providers are read directly by that resolver.
CREDENTIAL_FIELDS=('api_key','key_env','api_key_env','apiKey','keyEnv','apiKeyEnv')
def credential_fields(item,origin):
 value=dict(item)
 if origin=='custom_providers':
  if 'api_key_env' in value and 'key_env' not in value:value['key_env']=value['api_key_env']
  for alias,canonical in (('apiKey','api_key'),('keyEnv','key_env'),('apiKeyEnv','key_env')):
   if alias in value and canonical not in value:value[canonical]=value[alias]
 return {key:str(value.get(key) or '').strip() for key in ('api_key','key_env')}
