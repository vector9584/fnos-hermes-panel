"""Read-only, redacted view of the active home's independent custom pool.

No native imports, hydration, token selection, persistence or network calls.
"""
import json
from pathlib import Path
from panel_config_txn import ConfigError,read_file
from panel_model_catalog import entries,provider_fields

def inspect(home,data):
 try:raw,_=read_file(Path(home)/'auth.json')
 except FileNotFoundError:raw=b'{}'
 try:store=json.loads(raw)
 except Exception:raise ConfigError('模型凭证池无法解析，原文件已保留',503)
 if not isinstance(store,dict) or not isinstance(store.get('credential_pool',{}),dict):raise ConfigError('模型凭证池结构不正确，原文件已保留',503)
 pools=store.get('credential_pool',{});catalog=entries(data);result={}
 normalize=lambda value:str(value or '').strip().lower().replace(' ','-')
 endpoint=lambda entry:provider_fields(entry[2],entry[0])['base_url'].rstrip('/')
 for identifier,entry in catalog.items():
  item=entry[2]
  name=normalize(item.get('name') or identifier);base=endpoint(entry)
  matches=[other for key,other in catalog.items() if normalize(other[2].get('name') or key)==name]
  rows=pools.get('custom:'+name,[])
  if not isinstance(rows,list):raise ConfigError('模型凭证池条目格式不正确，原文件已保留',503)
  eligible=[];excluded=0
  for row in rows:
   if not isinstance(row,dict):raise ConfigError('模型凭证池条目格式不正确，原文件已保留',503)
   source=str(row.get('source') or 'manual')
   if source.startswith(('config:','panel_config:')) or source=='model_config':continue
   target=str(row.get('base_url') or '').rstrip('/')
   scoped=(target==base and sum(endpoint(other)==base for other in matches)<=1) or (not target and len(matches)==1)
   if not scoped:excluded+=1;continue
   status={'dead':'已停用','exhausted':'等待额度恢复','ok':'可供选择'}.get(row.get('last_status'),'可供选择')
   # Never expose arbitrary source/label strings: they can contain identifiers
   # or manually pasted secrets. This is configured eligibility, not a probe.
   kind='手动凭证' if source=='manual' or source.startswith('manual:') else '其他独立凭证'
   eligible.append({'kind':kind,'status':status,'endpoint_bound':bool(target)})
  result[identifier]={'independent_count':len(eligible),'excluded_count':excluded,'entries':eligible,'scope':'current_home','verified_online':False}
 return result
