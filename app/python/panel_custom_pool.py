"""Scope a named custom runtime pool to the selected provider's live config.

Preserves independent manual entries on disk. Config-seeded credentials are
rehydrated from the actual named resolver, not a colliding display-name lookup.
"""
import hashlib
from dataclasses import replace

def resolve(base_url,custom,requested,api_key):
 from agent.credential_pool import CredentialPool,PooledCredential,get_custom_provider_pool_key
 from hermes_cli.config import load_config,get_compatible_custom_providers
 from hermes_cli.auth import AuthError,is_source_suppressed,read_credential_pool
 pool_key=get_custom_provider_pool_key(base_url,provider_name=custom.get('name'))
 if not pool_key:return None
 # Do not call load_pool here: it seeds by display name before this filter,
 # which can rewrite another service's config reference on a name collision.
 entries=[PooledCredential.from_dict(pool_key,row) for row in read_credential_pool(pool_key)]
 name=str(custom.get('name') or '').strip();normalized=lambda s:str(s or '').strip().lower().replace(' ','-')
 matches=[c for c in get_compatible_custom_providers(load_config()) if normalized(c.get('name'))==normalized(name)]
 unique=len(matches)==1
 endpoint_unique=sum(str(c.get('base_url') or '').rstrip('/')==base_url.rstrip('/') for c in matches)<=1
 kept=[];matching_config=None
 identity='panel_config:'+normalized(requested)
 fingerprint='sha256:'+hashlib.sha256(api_key.encode()).hexdigest()[:16] if api_key else None
 for entry in entries:
  source=str(entry.source or '')
  if source.startswith('config:') or source=='model_config' or source.startswith('panel_config:'):
   # Reuse valid cooldown/accounting only if both token and endpoint match.
   same_key=bool(api_key) and (entry.runtime_api_key==api_key or entry.extra.get('secret_fingerprint')==fingerprint)
   if same_key and str(entry.base_url or '').rstrip('/')==base_url.rstrip('/') and (source==identity or (not source.startswith('panel_config:') and unique)):matching_config=entry
   continue
  endpoint=str(entry.base_url or '').rstrip('/')
  if (endpoint==base_url.rstrip('/') and endpoint_unique) or (not endpoint and unique):kept.append(entry)
 if api_key and not is_source_suppressed(pool_key,'config:'+name):
  if matching_config:configured=replace(matching_config,source=identity,access_token=api_key)
  else:configured=PooledCredential(provider=pool_key,id=hashlib.sha256(identity.encode()).hexdigest()[:12],label=name,auth_type='api_key',priority=max((e.priority for e in kept),default=-1)+1,source=identity,access_token=api_key,base_url=base_url)
  kept.append(configured)
 scoped=CredentialPool(pool_key,kept)
 if not scoped.has_credentials():return None
 entry=scoped.select()
 if not entry:raise AuthError('所选服务的凭证暂不可用，请检查凭证冷却或停用状态')
 token=entry.runtime_api_key
 if not token:return None
 return {'provider':'custom','api_mode':custom.get('api_mode') or 'chat_completions','base_url':base_url,'api_key':token,'source':'pool:'+pool_key,'credential_pool':scoped}
