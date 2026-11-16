"""Versioned model settings using the Gateway YAML as the only writable source.
No agent imports, migrations, env edits, model requests, or service starts.
"""
import copy,hashlib,io,json,os,re,secrets,sys,tempfile,time
from pathlib import Path
from urllib.parse import urlsplit
from panel_config_txn import ConfigError,config_lock,read_file,load_yaml,plain,semantic,checksum,commit

FIELDS=('providers','custom_providers','model','fallback_providers','fallback_model')
MODES=('chat_completions','codex_responses','anthropic_messages')
def revision(value):return checksum(semantic(value).encode())
def subset(data):return {key:data[key] for key in FIELDS if key in data}
from panel_model_catalog import enabled,entries,model_rows,model_ids,available_models,credential_fields,CREDENTIAL_FIELDS,provider_fields,REQUEST_EXTRA_BLOCKED
from panel_model_credentials import inspect as inspect_credentials

# ── 官方服务商预设：面板下拉的唯一数据源 ──────────────────────────────
# 2026-11-16：这份表原来在 app/server/provider-config.js 里，全仓没有任何文件
# import 它（grep 只命中它自己）—— 表写好了却没接上，所以面板两个弹层都只能
# 手输地址。现在搬到真正被调用的地方，由 catalog() 随 read 一起吐给前端，
# 前端不再复制一份；provider-config.js 随之删除。
# 列表顺序就是下拉顺序：常用的在前，长尾在后。
# api_mode 只能取 MODES 里的值，写了别的会被后端当无效协议。
PROVIDER_PRESETS=[
 {'id':'deepseek','name':'DeepSeek','base_url':'https://api.deepseek.com','api_mode':'chat_completions'},
 {'id':'openai','name':'OpenAI','base_url':'https://api.openai.com/v1','api_mode':'chat_completions'},
 {'id':'anthropic','name':'Anthropic','base_url':'https://api.anthropic.com/v1','api_mode':'anthropic_messages'},
 {'id':'gemini','name':'Google AI (Gemini)','base_url':'https://generativelanguage.googleapis.com/v1beta/openai','api_mode':'chat_completions'},
 {'id':'alibaba','name':'通义千问','base_url':'https://dashscope.aliyuncs.com/compatible-mode/v1','api_mode':'chat_completions'},
 {'id':'zai','name':'智谱 AI','base_url':'https://open.bigmodel.cn/api/paas/v4','api_mode':'chat_completions'},
 {'id':'kimi-coding','name':'Moonshot / Kimi','base_url':'https://api.moonshot.cn/v1','api_mode':'chat_completions'},
 {'id':'minimax-cn','name':'MiniMax（国内）','base_url':'https://api.minimaxi.com/v1','api_mode':'chat_completions'},
 {'id':'siliconflow','name':'硅基流动 SiliconFlow','base_url':'https://api.siliconflow.cn/v1','api_mode':'chat_completions'},
 {'id':'openrouter','name':'OpenRouter','base_url':'https://openrouter.ai/api/v1','api_mode':'chat_completions'},
 {'id':'xai','name':'xAI (Grok)','base_url':'https://api.x.ai/v1','api_mode':'chat_completions'},
 {'id':'stepfun','name':'阶跃星辰 StepFun','base_url':'https://api.stepfun.ai/step_plan/v1','api_mode':'chat_completions'},
 {'id':'xiaomi','name':'小米 MiMo','base_url':'https://api.xiaomimimo.com/v1','api_mode':'chat_completions'},
 {'id':'tencent-tokenhub','name':'腾讯 TokenHub','base_url':'https://tokenhub.tencentmaas.com/v1','api_mode':'chat_completions'},
 {'id':'arcee','name':'Arcee AI','base_url':'https://api.arcee.ai/api/v1','api_mode':'chat_completions'},
 {'id':'gmi','name':'GMI Cloud','base_url':'https://api.gmi-serving.com/v1','api_mode':'chat_completions'},
 {'id':'kilocode','name':'Kilo Code','base_url':'https://api.kilo.ai/api/gateway','api_mode':'chat_completions'},
 {'id':'alibaba-coding-plan','name':'阿里云（Coding Plan）','base_url':'https://coding-intl.dashscope.aliyuncs.com/v1','api_mode':'chat_completions'},
 {'id':'nvidia','name':'NVIDIA NIM','base_url':'https://integrate.api.nvidia.com/v1','api_mode':'chat_completions'},
 {'id':'mistral','name':'Mistral','base_url':'https://api.mistral.ai/v1','api_mode':'chat_completions'},
 {'id':'huggingface','name':'HuggingFace','base_url':'https://api-inference.huggingface.co/v1','api_mode':'chat_completions'},
 {'id':'ollama-cloud','name':'Ollama Cloud','base_url':'https://ollama.com/v1','api_mode':'chat_completions'},
 {'id':'ollama-local','name':'Ollama（本机）','base_url':'http://localhost:11434/v1','api_mode':'chat_completions'},
 {'id':'lmstudio','name':'LM Studio（本机）','base_url':'http://localhost:1234/v1','api_mode':'chat_completions'},
]
def norm_endpoint(value):
 # 端点归一：去尾斜杠，再砍掉末尾的 /v1。
 # https://api.deepseek.com 和 https://api.deepseek.com/v1 是同一个端点，
 # 配置里两种写法都真实存在（本机就有一条写成带 /v1 的 DeepSeek 官方）。
 # 只认末尾那一段，路径更深的（/v1/chat/completions 这种）原样保留。
 text=str(value or '').strip().rstrip('/')
 if text.endswith('/v1'):text=text[:-3].rstrip('/')
 return text

# 官方端点集合：卡片标识和弹层反查都按「地址是否落在这张表里」判，不看名字。
OFFICIAL_URLS={norm_endpoint(p['base_url']) for p in PROVIDER_PRESETS}



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

def credential_ready(credentials,env=None):
 """这把密钥现在真能用吗。

 2026-11-16：原来只判 bool(api_key) or bool(key_env)，而 config.yaml 存的是
 ${VAR} 引用 —— 字符串非空就算「有密钥」。x666 的 CUSTOM_UMW1USSWYV8ZB_API_KEY
 在 .env 里根本没有，服务商卡片照旧显示「1 把密钥」，密钥子页却说「缺密钥」，
 同一件事两个答案。

 判据统一到 env 落地：${VAR} 或 key_env 必须在 .env 里有非空值；配置内明文
 （不以 ${ 开头）也算。env=None 表示调用方没拿到 .env 路径，退回原来的粗判，
 免得 moa_candidates 这类不关心密钥的路径行为漂移。
 """
 inline=str(credentials.get('api_key') or '').strip()
 name=str(credentials.get('key_env') or '').strip()
 if not name and inline.startswith('${') and inline.endswith('}'):
  name=inline[2:-1].strip()
 if env is None:
  return bool(inline or name)
 if name:
  return bool(env.get(name))
 return bool(inline) and not inline.startswith('${')

def public_provider(identifier,entry,legacy=None,env=None):
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
  'group':str(item.get('group') or ''),'key_label':str(item.get('key_label') or ''),
  **fields,'models':models,
  'api_key_configured':credential_ready(credentials,env),
  'credential_source':'配置密钥优先，环境变量回退' if origin=='custom_providers' and credentials['api_key'] and credentials['key_env'] else '环境变量优先，配置密钥回退' if credentials['api_key'] and credentials['key_env'] else '环境变量' if credentials['key_env'] or credentials['api_key'].startswith('${') else '配置密钥' if credentials['api_key'] else '无密钥',
  'header_keys':list(item.get('extra_headers',{})) if isinstance(item.get('extra_headers',{}),dict) else [],
  'extra':{key:item[key] for key in ('context_length','max_output_tokens','request_timeout_seconds','rate_limit_delay','ssl_verify') if key in item},
  'request_extra':dict(item.get('extra_body')) if isinstance(item.get('extra_body'),dict) else {},
  # 2026-11-16：清单里一个启用的模型都没有 —— 这个服务点进去选不出任何模型。
  # 不能靠「服务默认模型」垫着，那字段已废弃。前端据此在概览和卡片上提醒。
  'needs_models':not any(m['enabled'] for m in models),
  'note':str(item.get('note') or '')}

def group_view(providers):
 # 同一 group 的多条 provider 收成一张卡；没写 group 的自成一张卡。
 # 一个中转站可以有 N 把 key，每把 key 就是一条独立 provider（内核视角），
 # 面板视角则是一个服务商 —— 这个函数就是两个视角的换算。
 groups=[];index={}
 for provider in providers:
  name=str(provider.get('group') or '')
  slot=name or ('#'+provider['id'])
  if slot not in index:
   # group 的值是内部聚合键（多把 key 时等于第一条 provider 的 id），
   # 它只是后端用来收卡的，绝不能当显示名 —— 否则用户看到的是
   # custom_umw4fn6uw5d42 而配置里明明写着 ZeroAPI。
   # 2026-11-16：卡片上要标「官方 / 第三方」。判据是地址是否落在 PROVIDER_PRESETS
   # 里，不做名字猜测 —— 名字是用户自己起的（「ZeroAPI」「x666」），叫什么都可能。
   # 末尾斜杠归一，https://api.deepseek.com 和 .../ 视为同一个端点。
   base_url=str(provider.get('base_url') or '')
   card={'group':name,'name':str(provider.get('name') or provider['id']),'base_url':base_url,
    'official':norm_endpoint(base_url) in OFFICIAL_URLS,'keys':[]}
   index[slot]=card;groups.append(card)
  index[slot]['keys'].append({'id':provider['id'],'key_label':str(provider.get('key_label') or ''),'name':provider['name'],
   'enabled':provider.get('enabled'),'models':provider.get('models',[]),'api_mode':str(provider.get('api_mode') or ''),
   'base_url':str(provider.get('base_url') or ''),'api_key_configured':provider.get('api_key_configured'),
   'credential_source':provider.get('credential_source'),'note':str(provider.get('note') or ''),
   # 2026-11-16：「服务默认模型」已报废 —— 它从没参与过对话路由（真正决定
   # 跑哪个模型的是 config.model.provider+default），只在模型清单为空时当
   # 占位符，名字叫默认却从不起默认作用。这里改成如实上报「清单是空的」。
   'needs_models':bool(provider.get('needs_models')),
   'revision':provider.get('revision')})
 for card in groups:card['count']=len(card['keys'])
 return groups

def catalog(data,legacy=None,env=None):
 providers=[public_provider(key,item,legacy,env) for key,item in entries(data).items()]
 primary=data.get('model',{});primary=primary if isinstance(primary,dict) else {'default':str(primary or '')}
 current={'provider':str(primary.get('provider') or ''),'model':str(primary.get('default') or '')}
 chain=[{'key':revision([key,index,item]),'provider':str(item['provider']).strip(),'model':str(item['model']).strip(),'source':key,
  'has_overrides':any(k not in ('provider','model') for k in item)} for key,index,item in effective_chain(data)]
 return {'ok':True,'revision':revision(subset(data)),'providers':providers,'groups':group_view(providers),'primary':current,'fallbacks':chain,
  'active_provider':next((p['name'] for p in providers if p['id']==route_id(current['provider'])),current['provider']),
  'fallback_providers':[next((p['name'] for p in providers if p['id']==route_id(item['provider'])),item['provider']) for item in chain],
  # 2026-11-16：官方服务商预设随 read 一起下发，添加/编辑两个弹层的「选择官方服务商」
  # 下拉都吃这一份。前端一个字都不硬编码 —— 加厂商只改上面 PROVIDER_PRESETS。
  'presets':PROVIDER_PRESETS,
  'request_extra_rules':{'blocked':list(REQUEST_EXTRA_BLOCKED)},
  # 2026-11-16：模型清单为空的服务商不再静默存在。概览页据此出横幅，
  # 服务商卡片据此挂徽标；空清单是「配了一半」的状态，必须被看见。
  'alerts':[{'provider':p['id'],'name':p['name'],'level':'bad',
   'text':p['name']+' 还没拉到模型，对话里选它选不出任何东西'} for p in providers if p['needs_models']],
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

def request_extra(value):
 # Generic per-provider extra request-body params. The kernel copies
 # providers.<id>.extra_body straight into the outgoing body, so whatever lands
 # here reaches the provider verbatim — no kernel key list to validate against,
 # which is exactly why the envelope keys are blocked above and the rest is only
 # checked for shape and size.
 if not isinstance(value,dict):raise ConfigError('请求扩展参数需为对象')
 if len(value)>64:raise ConfigError('请求扩展参数最多 64 项')
 for key in value:
  if not isinstance(key,str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,64}',key):raise ConfigError('参数名不正确：'+str(key)[:40])
  if key.lower() in REQUEST_EXTRA_BLOCKED:raise ConfigError('该参数会覆盖请求结构，面板不放行：'+key)
 def walk(node,depth):
  if depth>4:raise ConfigError('请求扩展参数嵌套过深（最多 4 层）')
  if isinstance(node,dict):
   for key,child in node.items():
    if not isinstance(key,str) or not key or len(key)>64:raise ConfigError('嵌套参数名不正确')
    walk(child,depth+1)
  elif isinstance(node,list):
   if len(node)>200:raise ConfigError('请求扩展参数列表过长（最多 200 项）')
   for child in node:walk(child,depth+1)
  elif node is None or isinstance(node,(bool,int,float)):
   pass
  elif isinstance(node,str):
   if len(node)>8000:raise ConfigError('请求扩展参数文本过长')
  else:raise ConfigError('请求扩展参数只接受 JSON 可表示的值')
 walk(value,1)
 if len(json.dumps(value,ensure_ascii=False))>16000:raise ConfigError('请求扩展参数体积过大')
 return copy.deepcopy(value)

def secret_name(identifier):
 # 密钥真值一律落 .env，config 只留 ${VAR}。变量名按 provider id 生成，所以「改同一把
 # 密钥」和「新建密钥」都天然幂等，不会每存一次多一个变量。
 raw=re.sub(r'[^A-Za-z0-9]','_',str(identifier or '')).strip('_').upper()
 if not raw:raw='PROVIDER'
 if not raw[0].isalpha():raw='P_'+raw
 return raw[:56]+'_API_KEY'

def key_env_name(item):
 """provider 的 api_key 若是 ${VAR} 形式，返回变量名；明文或空返回空串。"""
 if not isinstance(item,dict):return ''
 value=item.get('api_key')
 if isinstance(value,str) and value.startswith('${') and value.endswith('}'):
  return value[2:-1].strip()
 return ''

def atomic_env_write(env_path,content):
 # 备份 + 0600 + 原子替换。write_secrets / prune_secrets 共用这一份，
 # 免得两条路径的权限和备份行为不一致。
 env_path=Path(env_path)
 try:original=env_path.read_bytes()
 except OSError:original=b''
 try:
  backup=env_path.parent/'.env-backups';backup.mkdir(parents=True,exist_ok=True)
  stamp=backup/('env-'+str(time.time_ns())+'-'+hashlib.sha256(original).hexdigest()[:12]+'.bak')
  with stamp.open('xb') as stream:
   os.fchmod(stream.fileno(),0o600);stream.write(original)
 except OSError:pass
 fd,temp=tempfile.mkstemp(prefix='.env-',dir=str(env_path.parent))
 try:
  with os.fdopen(fd,'wb') as stream:
   os.fchmod(stream.fileno(),0o600);stream.write(content);stream.flush();os.fsync(stream.fileno())
  os.replace(temp,env_path)
 finally:
  if os.path.exists(temp):os.unlink(temp)

def prune_secrets(env_path,names):
 """删掉已经没人引用的变量行。只删调用方点名的，不按前缀猜。"""
 env_path=Path(env_path)
 try:text=env_path.read_text(encoding='utf-8',errors='replace')
 except OSError:return []
 drop=set(names);kept=[];hits=set()
 for line in text.splitlines():
  stripped=line.strip()
  if stripped and not stripped.startswith('#') and '=' in stripped:
   key=stripped.split('=',1)[0].strip()
   if key.startswith('export '):key=key[7:].strip()
   if key in drop:hits.add(key);continue
  kept.append(line)
 if not hits:return []
 atomic_env_write(env_path,('\n'.join(kept)+'\n').encode('utf-8'))
 return sorted(hits)

def write_secrets(env_path,values):
 """把若干变量一次写进 .env（同名覆盖、缺则追加）。"""
 env_path=Path(env_path)
 try:text=env_path.read_text(encoding='utf-8',errors='replace')
 except OSError:text=''
 names=set(values);out=[];seen=set()
 for line in text.splitlines():
  stripped=line.strip()
  if not stripped or stripped.startswith('#') or '=' not in stripped:
   out.append(line);continue
  key=stripped.split('=',1)[0].strip()
  if key.startswith('export '):key=key[7:].strip()
  if key in names:out.append(key+'='+values[key]);seen.add(key)
  else:out.append(line)
 for key in sorted(names-seen):out.append(key+'='+values[key])
 atomic_env_write(env_path,('\n'.join(out)+'\n').encode('utf-8'))
 return sorted(names)

def patch(old,changes,origin='providers',legacy=None,identifier=None,secrets=None):
 if not isinstance(changes,dict) or set(changes)-{'name','base_url','api_mode','default_model','models','credential','headers','note','context_length','max_output_tokens','request_timeout_seconds','rate_limit_delay','ssl_verify','headers_json','request_extra','group','key_label'}:raise ConfigError('模型服务修改字段不正确')
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
 # group / key_label 是面板聚合用的元数据，内核解析 provider 时会忽略这两个键 ——
 # 它们不改变任何请求，只让「一个中转站挂多把 key」在面板上收成一张卡。
 for field,label in (('group','分组'),('key_label','密钥名称')):
  if field in changes:
   raw=changes[field]
   if raw in (None,''):new.pop(field,None)
   else:
    cleaned=text(raw,label,120)
    if cleaned:new[field]=cleaned
    else:new.pop(field,None)
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
   if operation['action']=='replace':
    raw=text(operation.get('value'),'API密钥',16000)
    # 密钥真值一律落 .env，config 里只留 ${VAR}：
    #  · 面板「密钥」页只读 .env，明文写进 config 就等于在那边看不见，两处各存一份
    #  · config.yaml 是最容易被下载/贴出去的文件，不该躺明文
    #  · 内核解析 ${VAR} 和明文走同一条路径，行为不变
    if raw.startswith('${') and raw.endswith('}'):
     new['api_key']=raw
    else:
     previous=old.get('api_key') if isinstance(old,dict) else None
     name=''
     if isinstance(previous,str) and previous.startswith('${') and previous.endswith('}'):
      # 换值不换名：沿用原有变量名，别把历史变量留成孤儿
      name=previous[2:-1].strip()
     if not name or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,63}',name):
      name=secret_name(identifier)
     new['api_key']='${'+name+'}'
     if secrets is not None:secrets[name]=raw
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
 if 'request_extra' in changes:
  extra=changes['request_extra']
  if extra is None:new.pop('extra_body',None)
  else:new['extra_body']=request_extra(extra)
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
  # 2026-11-16：「服务默认模型」(providers 段 default_model) 报废。内核从来没读过
  # 它 —— 真正决定会话跑哪个模型的是 config.model.provider + config.model.default。
  # 它唯一的作用是清单为空时当占位符，名字叫默认却从不起默认作用。只剩老格式
  # custom_providers 还在使 model 字段，那条路保持原样。
  if origin!='custom_providers':raise ConfigError('模型服务不再有「默认模型」这个设置，模型在清单里逐个启用即可')
  new['model']=text(changes['default_model'],'服务默认模型',500)
  for key in ('default_model','defaultModel'):
   new.pop(key,None)
 # 2026-11-16：空模型清单不许保存。清单为空 = 对话里选这个服务，二级列表一个
 # 模型都没有，等于配了一半。想存就得先把模型拉下来（拉不到说明地址或密钥不对）。
 # 新建（old 为空）也一并挡住：从源头就不产生空壳服务商。
 if 'models' in changes or not old:
  _rows=model_rows(new,origin)
  _live=[m for m in _rows if (enabled(m) if isinstance(m,dict) else bool(str(m or '').strip()))]
  if not _live:
   raise ConfigError('模型清单不能为空：先点「从端点获取」把这台服务可用的模型拉下来；拉不到就说明地址或密钥不对')
 return new

def set_entry(data,entry,identifier,value):
 origin,key,_=entry
 data[origin]=copy.deepcopy(data.get(origin,{} if origin=='providers' else []));data[origin][key]=value

def route_id(provider):return provider[7:] if isinstance(provider,str) and provider.startswith('custom:') else provider

# 2026-11-16：删除服务商时的引用检查原来只覆盖主模型和回退路线（effective_chain
# 只读 fallback_providers / fallback_model），辅助模型和 MOA 不在保护面里 —— 删掉一条
# 被它们引用的服务会留下指向空气的 provider id，界面上完全看不出来。这里补上。
AUX_LABELS={'vision':'图像理解','web_extract':'网页提取','compression':'上下文压缩',
 'approval':'命令审批','mcp':'MCP 调用','title_generation':'会话标题生成',
 'memory_query_rewrite':'记忆检索改写','tts_audio_tags':'语音情绪标签','skills_hub':'技能检索',
 'triage_specifier':'任务分诊','kanban_decomposer':'任务拆解','profile_describer':'档案描述',
 'curator':'技能复盘'}

def reference_holders(data,identifier):
 "返回「删了就跑不动」的引用，空列表代表可以安全删除。"

 # 分级原则（2026-11-16 用户定的）：「少一项还能跑」的引用不拦，由 auto_clean
 # 自动摘掉；「少了就跑不动」的才拦在这里。所以本函数只看唯一字段：
 # 主模型、辅助任务的主 provider、MOA 的聚合模型。
 # 列表里的一项（回退链、参考模型）、可选覆盖（频道、会话 /model）、历史回滚
 # 记录（previous_primary）全归 auto_clean —— 用户原话是「只要有一个频道在用
 # 就不能删，这得多麻烦」。
 result=[];target=route_id(identifier)
 if not target:return result
 auxiliary=data.get('auxiliary')
 if isinstance(auxiliary,dict):
  for task,config in auxiliary.items():
   if not isinstance(config,dict):continue
   label=AUX_LABELS.get(task,task)
   if route_id(config.get('provider'))==target:result.append('辅助模型「'+label+'」正在使用')
 moa=data.get('moa')
 presets=moa.get('presets') if isinstance(moa,dict) else None
 if isinstance(presets,dict):
  for name,preset in presets.items():
   if not isinstance(preset,dict):continue
   aggregate=preset.get('aggregator')
   if isinstance(aggregate,dict) and route_id(aggregate.get('provider'))==target:
    result.append('MOA 预设「'+str(name)+'」的聚合模型')
 # 2026-11-16 补：image_gen 是唯一字段，摘掉就没有生图能力了，按「少了就跑不动」拦。
 # 它的真实 provider id 藏在 image_gen.custom.provider_id，不是 image_gen.provider
 # （后者只会是 custom / openai / xai 这类内置名）。
 image_gen=data.get('image_gen')
 if isinstance(image_gen,dict):
  custom=image_gen.get('custom')
  holder_id=route_id((custom if isinstance(custom,dict) else image_gen).get('provider_id'))
  if holder_id==target:result.append('图像生成（生图模型）正在使用')
 return result

def auto_clean(data,targets):
 """把「摘掉之后配置照样成立」的引用一次清干净，返回人话清单。

 分级原则同上：列表里的一项、可选的覆盖、历史回滚记录 —— 摘掉之后默认值会
 顶上来，不拦，替用户清掉。唯一字段仍在 reference_holders 里拦。
 2026-11-16 现场：13 个 Discord 频道覆盖 + moa.previous_primary 指着已删的
 custom_umw4fn6uw5d42，闸门看不见这些位置，一路放行。
 """
 cleaned=[]
 targets={route_id(item) for item in (targets or []) if route_id(item)}
 if not targets:return cleaned
 def hit(route):return isinstance(route,dict) and route_id(route.get('provider')) in targets
 chain=data.get('fallback_providers')
 if isinstance(chain,list):
  keep=[item for item in chain if not hit(item)]
  if len(keep)!=len(chain):
   cleaned.append('回退路线里的 '+str(len(chain)-len(keep))+' 项')
   data['fallback_providers']=keep
 auxiliary=data.get('auxiliary')
 if isinstance(auxiliary,dict):
  for task,config in auxiliary.items():
   if not isinstance(config,dict):continue
   sub=config.get('fallback_chain')
   if isinstance(sub,list):
    keep=[item for item in sub if not hit(item)]
    if len(keep)!=len(sub):
     cleaned.append('辅助模型「'+AUX_LABELS.get(task,task)+'」的回退链 '+str(len(sub)-len(keep))+' 项')
     config['fallback_chain']=keep
 moa=data.get('moa')
 presets=moa.get('presets') if isinstance(moa,dict) else None
 if isinstance(presets,dict):
  for name,preset in presets.items():
   if not isinstance(preset,dict):continue
   refs=preset.get('reference_models')
   if isinstance(refs,list):
    keep=[item for item in refs if not hit(item)]
    if len(keep)!=len(refs):
     cleaned.append('MOA 预设「'+str(name)+'」的参考模型 '+str(len(refs)-len(keep))+' 个')
     preset['reference_models']=keep
 if isinstance(moa,dict) and hit(moa.get('previous_primary')):
  moa.pop('previous_primary',None)
  cleaned.append('MOA 记的上一个主模型')
 platforms=data.get('platforms')
 if isinstance(platforms,dict):
  for pname,pcfg in platforms.items():
   if not isinstance(pcfg,dict):continue
   overrides=pcfg.get('channel_overrides')
   if not isinstance(overrides,dict):continue
   dead=[cid for cid,row in overrides.items() if hit(row)]
   for cid in dead:overrides.pop(cid,None)
   if dead:cleaned.append('平台「'+str(pname)+'」的 '+str(len(dead))+' 个频道模型覆盖')
 return cleaned

def clean_session_model_overrides(config_path,targets,base_urls,default_model='',retired=None):
 """会话级模型引用存在两处，两处的优先级都高于全局默认 —— 只清频道覆盖救不回
 已经开着的会话：

 1. state.db 的 gateway_routing.entry_json.model_override
    会话 /model 覆盖。run.py:6823 的优先级原文是
    ``session /model → channel_overrides → global config``。
 2. state.db 的 sessions.model / model_config.gateway_runtime
    api_server 会话持久化的模型选择（「对话模块」走的就是这条）。
    api_server.py:2648 那里一句
    ``model = resolve_effective_model(None, session_row_model, model)``
    让 sessions.model 压过全局默认 —— 这一条是 2026-11-16 补上的，
    之前只清 gateway_routing，对话模块的老会话还在拿已删服务商的名字发请求。

 还有第三种命中方式（2026-11-16 补，用户问「我在会话 model 里手动设置、
 再从面板删掉这个模型，会落回默认吗」）：``retired`` 传 ``{provider_id: {模型名...}}``，
 只在某个模型被停用时用。因为面板「删掉一个模型」实际是就地归档成
  ``enabled: False``（patch() :465-468 的注释写着 preserves historical selections），
  provider 和 base_url 都还在，按 provider/host 匹配一条也命中不了 —— 会话会
  继续拿那个已经不在清单里的模型名发请求。

 清失败不阻断删除：config 那边已经落盘，会话记录清不掉只会让老会话多错一次，
 不该反过来把删服务商这件事判成失败。
 """
 result=[]
 try:
  import sqlite3
  db=Path(config_path).parent/'state.db'
  if not db.exists():return result
  targets={route_id(item) for item in (targets or []) if route_id(item)}
  hosts=set()
  for url in (base_urls or []):
   if not url:continue
   try:hosts.add(urlsplit(str(url)).netloc.lower())
   except Exception:pass
  # retired: {provider_id: {被停用的模型名}}，只在「停用某个模型」时传。
  retired={route_id(k):{str(x) for x in (v or [])} for k,v in (retired or {}).items() if route_id(k)}
  def _retired_hit(provider,model):
   names=retired.get(provider)
   return bool(names) and str(model or '') in names
  con=sqlite3.connect(str(db),timeout=5)
  try:
   # ① 会话 /model 覆盖
   rows=list(con.execute('SELECT session_key,entry_json FROM gateway_routing'))
   for key,raw in rows:
    try:entry=json.loads(raw)
    except Exception:continue
    if not isinstance(entry,dict):continue
    override=entry.get('model_override')
    if not isinstance(override,dict):continue
    provider=route_id(override.get('provider'))
    try:host=urlsplit(str(override.get('base_url') or '')).netloc.lower()
    except Exception:host=''
    if provider in targets or (host and host in hosts) or _retired_hit(provider,override.get('model')):
     entry['model_override']=None
     con.execute('UPDATE gateway_routing SET entry_json=? WHERE session_key=?',
                 (json.dumps(entry,ensure_ascii=False),key))
     result.append('会话「%s」' % (entry.get('display_name') or key))
   # ② 对话模块的会话持久化模型（sessions.model + model_config.gateway_runtime）
   for sid,model,raw in list(con.execute(
     "SELECT id,model,model_config FROM sessions WHERE model_config LIKE '%gateway_runtime%'")):
    try:config=json.loads(raw) if raw else {}
    except Exception:continue
    if not isinstance(config,dict):continue
    runtime=config.get('gateway_runtime')
    if not isinstance(runtime,dict):continue
    provider=route_id(runtime.get('provider'))
    try:host=urlsplit(str(runtime.get('base_url') or '')).netloc.lower()
    except Exception:host=''
    if not (provider in targets or (host and host in hosts) or _retired_hit(provider,runtime.get('model'))):continue
    config.pop('gateway_runtime',None)
    if default_model:
     con.execute('UPDATE sessions SET model=?,model_config=? WHERE id=?',
                 (default_model,json.dumps(config,ensure_ascii=False),sid))
    else:
     con.execute('UPDATE sessions SET model_config=? WHERE id=?',
                 (json.dumps(config,ensure_ascii=False),sid))
    result.append('对话模块「%s」' % (model or sid))
   con.commit()
  finally:con.close()
 except Exception:
  return []
 return result

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
  from panel_model_extras import env_file as _env_file
  env_from_disk=_env_file(path)
  def view(value):
   output=catalog(value,legacy,env_from_disk);pools=inspect_credentials(Path(path).parent,value)
   for provider in output['providers']:provider['credential_pool']=pools[provider['id']]
   return output
  action=body.get('action')
  if action=='read':return view(data)
  # 2026-11-15 模型页六域重构：密钥状态、能力后端、工具集、config 预览、审计原来
  # 分散在别的页面或根本不存在，统一由 panel_model_extras 提供。它的 revision 覆盖
  # 整份配置（不是模型子树），所以必须在下面那条模型子树 revision 校验之前分派，
  # 否则切换一个工具集就会拿「模型配置已被修改」把用户挡回去。
  if action in ('keys','save_key','backends','toolsets','config_preview','audit','save_backend','save_toolsets','config_write'):
   from panel_model_extras import execute as run_extras
   return run_extras(body,path,state,raw)
  # 2026-11-15：能力实验室。只读动作，不写配置、不碰 revision——
  # 上面所有写动作都要先过 revision 校验，这里提前返回，避免"测一下能力"被并发锁挡住。
  if action in ('cap_matrix','cap_run'):
   from panel_model_caps import run as run_capability
   return run_capability({**body,'cap':'matrix' if action=='cap_matrix' else body.get('cap')},data,Path(path).parent)
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
  # patch() 里收到明文密钥时不写 config，塞进这个 dict，commit 前统一落 .env。
  pending_secrets={}
  # 被删掉的 provider 引用的 .env 变量名，commit 前确认无人再引用就清掉，
  # 否则密码本页看不到（它只列有引用的），变成隐形残留。
  prune_candidates=[]
  # 自动清理账本：auto_cleaned 是 config 里顺手摘掉的引用，sessions_reset 是
  # 会话库里清掉的 /model 覆盖。两个都要回给前端，用户得知道自己少配了什么。
  auto_cleaned=[];doomed=set();doomed_urls=[]
  # 被停用（面板上的「删掉模型」）的模型名，按 provider 归集，见 clean_session_model_overrides
  retired={}
  if action=='create':
   identifier='custom_'+secrets.token_hex(10);value=patch({},body.get('changes',{}),'providers',None,identifier,pending_secrets);updated['providers']=copy.deepcopy(data.get('providers',{}));updated['providers'][identifier]=value
  elif action in ('update','toggle'):
   if not entry:raise ConfigError('模型服务不存在，请刷新',404)
   if action=='toggle':
    value=copy.deepcopy(entry[2]);value['enabled']=body.get('enabled')
    if type(value['enabled']) is not bool:raise ConfigError('服务启用状态不正确')
   else:value=patch(entry[2],body.get('changes',{}),entry[0],legacy.get(identifier,[]),identifier,pending_secrets)
   set_entry(updated,entry,identifier,value)
   references=[data.get('model',{})]+[item for _,_,item in effective_chain(data)]
   for route in references:
    if isinstance(route,dict) and route_id(route.get('provider'))==identifier:
     model=route.get('model') or route.get('default')
     if not enabled(value) or model not in available_models(value,entry[0]):raise ConfigError('此服务或模型仍用于默认或回退路线，请先调整路线',409)
   # 停用等于断开：辅助模型和 MOA 里的引用会当场失效，和删除同理，一起拦。
   if not enabled(value):
    holders=reference_holders(data,identifier)
    if holders:raise ConfigError('此服务还在被用着，停用会让下面这些配置失效，请先改掉再停用：'+'；'.join(holders),409)
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
   # 主模型必须拦：它是配置的心脏，摘掉就没有默认模型了。
   # 回退路线里的一项不拦 —— auto_clean 会把那一项摘掉，链短一截照样能跑。
   primary_route=data.get('model')
   if isinstance(primary_route,dict) and route_id(primary_route.get('provider'))==identifier:
    raise ConfigError('此服务是当前主模型，先在「主模型」里换一个再回来删',409)
   holders=reference_holders(data,identifier)
   if holders:raise ConfigError('此服务还在被用着，删掉会让下面这些配置指向不存在的服务，请先改掉再删：'+'；'.join(holders),409)
   # 「少一项还能跑」的引用不拦，顺手清掉：频道覆盖、回退链里的一项、回滚记录。
   # 用户 2026-11-16 原话「只要有一个频道在用就不能删，这得多麻烦」—— 频道覆盖
   # 只是偏好，删了回落全局默认，不该成为删服务商的阻碍。
   auto_cleaned=auto_clean(updated,{identifier})
   doomed={identifier};doomed_urls=[str((entry[2] or {}).get('base_url') or '')]
   origin,key,_=entry
   name=key_env_name(entry[2])
   if name:prune_candidates.append(name)
   container=copy.deepcopy(data.get(origin))
   if isinstance(container,dict):container.pop(key,None)
   elif isinstance(container,list):container.pop(key)
   updated[origin]=container
  elif action=='group_delete':
   # 2026-11-16 血泪（用户实测踩出来的）：整组删除必须原子。前端原来逐把发
   # delete，第一把没被引用就删掉了、第二把被 MOA 引用才报 409 —— 结果弹窗
   # 上写着「还有引用，删不了」，回来一看组里少了一半，报错和事实完全对不上。
   # 这里先把整组所有成员的引用一次查完，任何一个有引用就整组一把都不删。
   anchor=all_entries.get(identifier)
   if not anchor:raise ConfigError('模型服务不存在，请刷新',404)
   if anchor[0]!='providers':raise ConfigError('只有 providers 段支持整组删除',400)
   anchor_group=(anchor[2].get('group') or '').strip()
   members={}
   for pid,candidate in all_entries.items():
    if candidate[0]!='providers':continue
    if pid==identifier or (anchor_group and (candidate[2].get('group') or '').strip()==anchor_group):members[pid]=candidate[2]
   # 前端传了名单就按名单收窄 —— 卡片渲染到点击之间 group 可能被别处改过，
   # 按名单删不会把后来才并进这组的那把顺手带走。
   wanted=body.get('ids')
   if isinstance(wanted,list) and wanted:
    narrowed={pid:members[pid] for pid in wanted if pid in members}
    if narrowed:members=narrowed
   if not members:raise ConfigError('没有可删除的密钥，请刷新',404)
   primary_route=data.get('model')
   blockers=[]
   for pid,row in members.items():
    who=str(row.get('key_label') or row.get('name') or pid)
    if isinstance(primary_route,dict) and route_id(primary_route.get('provider'))==pid:
     blockers.append('「'+who+'」是当前主模型，先在「主模型」里换掉')
    for holder in reference_holders(data,pid):
     blockers.append('「'+who+'」'+holder)
   if blockers:
    raise ConfigError('这个服务还在被用着，整组一把都不会删。请先改掉下面这些引用再回来：'+'；'.join(blockers),409)
   auto_cleaned=auto_clean(updated,set(members))
   doomed=set(members);doomed_urls=[str((row or {}).get('base_url') or '') for row in members.values()]
   container=copy.deepcopy(data.get('providers',{}))
   for pid in members:
    name=key_env_name(container.get(pid))
    if name:prune_candidates.append(name)
    container.pop(pid,None)
   updated['providers']=container
   body=dict(body);body['_group_touched']={'created':0,'removed':list(members)}
  elif action=='group_update':
   # 2026-11-16：一张「服务卡」= 同一 group 下的多条 provider（每条一把 key）。
   # 面板编辑页把这张卡渲染成「名称/地址共用 + 密钥数组」，一次提交，这里拆合。
   # group 由后端自己维护（第一条 provider 的 id），用户不需要知道它存在。
   anchor=all_entries.get(identifier)
   if not anchor:raise ConfigError('模型服务不存在，请刷新',404)
   if anchor[0]!='providers':raise ConfigError('只有 providers 段支持多密钥编辑',400)
   incoming=body.get('keys')
   if not isinstance(incoming,list) or not incoming:raise ConfigError('至少要保留一把密钥')
   if len(incoming)>20:raise ConfigError('一个服务最多 20 把密钥')
   shared=body.get('changes') or {}
   if not isinstance(shared,dict):raise ConfigError('服务信息格式不正确')
   shared={k:shared[k] for k in ('name','base_url','api_mode','note') if k in shared}
   anchor_group=(anchor[2].get('group') or '').strip()
   members={}
   for pid,candidate in all_entries.items():
    if candidate[0]!='providers':continue
    if pid==identifier or (anchor_group and (candidate[2].get('group') or '').strip()==anchor_group):members[pid]=candidate[2]
   # 多把 key 才需要 group；只剩一把就清空 —— 组是用来把多把 key 归成一张卡
   # 的，一把 key 不需要组。原来这里是「只剩一把时保留原有 group」，可那条
   # group 值往往就是刚被删掉的那把 key 的 id，留着等于留一根悬空指针：
   # 卡片拿它去查同伴查不到，渲染成一张孤卡（2026-11-16 删 ZeroAPI 剩一把后
   # 的现场就是这样，group 还指着已经不在的 custom_umw4fn6uw5d42）。
   group_name=((shared.get('group') or anchor_group or identifier) if len(incoming)>1 else '')
   container=copy.deepcopy(data.get('providers',{}))
   routes=[data.get('model',{})]+[item for _,_,item in effective_chain(data)]
   kept=[];created=0
   for item in incoming:
    if not isinstance(item,dict):raise ConfigError('密钥条目格式不正确')
    pid=str(item.get('id') or '').strip()
    row=dict(shared);row['key_label']=item.get('key_label','') or ''
    row['group']=group_name
    # 2026-11-16：模型清单也是「每把 key 一份」——同一个端点，不同 key 能看见的
    # 模型完全不同（实测 DeepSeek 那把 4 个文本模型，生图那把 15 个含 image）。
    # 前端把合并列表按来源 key 拆回来，一次 group_update 写到底，所以这里必须
    # 允许每把 key 带自己的 models。patch() 会照常校验格式，并且拒绝空清单。
    if item.get('models') is not None:row['models']=item['models']
    if item.get('credential') is not None:row['credential']=item['credential']
    if pid and pid in members:
     container[pid]=patch(container.get(pid,{}),row,'providers',legacy.get(pid,[]),pid,pending_secrets);kept.append(pid)
    else:
     fresh='custom_'+secrets.token_hex(10)
     container[fresh]=patch({},row,'providers',[],fresh,pending_secrets);kept.append(fresh);created+=1
   # 2026-11-16：同一个服务下 key 值必须唯一。两把一样的密钥，「这个模型来自哪把
   # key」就成了废话，配额和计费也对不上。前端只能比新填的明文，已存的 ${VAR}
   # 只有这里能比 —— 按 .env 里的真值逐个核，前端拦不住的漏网在这里收。
   env_values={}
   try:
    for line in (Path(path).parent/'.env').read_text(encoding='utf-8',errors='replace').splitlines():
     stripped=line.strip()
     if not stripped or stripped.startswith('#') or '=' not in stripped:continue
     name,value=stripped.split('=',1);name=name.strip()
     if name.startswith('export '):name=name[7:].strip()
     env_values[name]=value.strip()
   except OSError:pass
   seen_values={};seen_labels={}
   for pid in kept:
    entry=container.get(pid) or {}
    # 2026-11-16 血泪：这里千万别用 raw 当变量名。外层 raw 是 execute() 开头读到的
    # config.yaml 原始字节，要一路传给 commit() 做并发比对；在这遮蔽掉它，commit
    # 就会拿 api_key 字符串去和文件字节比，必然不等，group_update 每次必报
    # 「配置已被其他进程修改」，重试永远无用。
    key_ref=str(entry.get('api_key') or '')
    if key_ref.startswith('${') and key_ref.endswith('}'):
     var=key_ref[2:-1].strip();value=pending_secrets.get(var) or env_values.get(var) or ''
    else:value=key_ref
    label=str(entry.get('key_label') or '').strip()
    if value:
     if value in seen_values:
      raise ConfigError('同一个服务里不能挂两把一样的密钥：「'+seen_values[value]+'」和「'+(label or '未命名')+'」填的是同一个值，改掉一把或者删掉重复的那把',400)
     seen_values[value]=label or '未命名'
    if label:
     if label in seen_labels:raise ConfigError('两把密钥用了同一个名字「'+label+'」—— 模型清单上分不清哪个模型来自哪把，换个名字',400)
     seen_labels[label]=1
   removed=[]
   for pid in list(members):
    if pid in kept:continue
    for route in routes:
     if isinstance(route,dict) and route_id(route.get('provider'))==pid:
      raise ConfigError('这把密钥还被默认或回退路线用着，先改路线再删：'+str(members[pid].get('key_label') or pid),409)
    holders=reference_holders(data,pid)
    if holders:raise ConfigError('这把密钥还在被用着，删掉会让下面这些配置指向不存在的服务，请先改掉再删：'+str(members[pid].get('key_label') or pid)+' → '+'；'.join(holders),409)
    name=key_env_name(container.get(pid))
    if name:prune_candidates.append(name)
    container.pop(pid,None);removed.append(pid)
   updated['providers']=container
   identifier=kept[0]
   body=dict(body);body['_group_touched']={'created':created,'removed':removed}
   # 2026-11-16：前端「删掉一个模型」走的是这里（不是 update）—— 取消勾选时
   # patch() 把那一行就地归档成 enabled:False，provider 和 base_url 全都还在，
   # 按 provider 匹配一条会话也命中不了。逐个 member 比对前后 enabled 集合，
   # 差集（被停用的模型名）交给会话清理函数按「provider + 模型名」精确命中。
   for pid in kept:
    if pid not in members:continue
    def _names(_item):
     return {str(m.get('id') or m.get('model') or '') for m in model_rows(_item or {},'providers') if isinstance(m,dict) and enabled(m)}
    _gone=_names(members[pid])-_names(container.get(pid))-{''}
    if _gone:retired[pid]=_gone
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
  # 明文密钥落 .env 必须排在写 config 之前：万一 .env 写失败，config 还引用旧变量，
  # 只是这轮没改成；反过来先写 config 再写 .env 失败，就会指向一个不存在的变量。
  if pending_secrets:
   try:write_secrets(Path(path).parent/'.env',pending_secrets)
   except OSError as error:raise ConfigError('密钥写不进 .env（'+type(error).__name__+'），本次未保存',500)
  if prune_candidates:
   # 只有「更新后的配置里没人再引用 ${VAR}」才删，共用一个变量的服务不会被误伤。
   # 清理失败不该挡住保存：config 已经是新的，.env 多一条孤儿只是不洁。
   live=json.dumps(updated,ensure_ascii=False)
   dead=[name for name in prune_candidates if '${'+name+'}' not in live]
   if dead:
    try:prune_secrets(Path(path).parent/'.env',dead)
    except OSError:pass
  # 2026-11-16：主模型必须挂在启用中的模型上。取消勾选最后一行、或删掉主模型
  # 所在的那把密钥，config.model.default 就指向一个已停用的 id —— 概览照实显示成
  # 「主模型」，对话一跑才发现未启用。这里不自动改主模型（等于悄悄换掉他跑什么），
  # 而是拦下来，让人先在①里重选。
  _prim=updated.get('model')
  _pp=_pm=''
  if isinstance(_prim,dict):
   _pp=str(_prim.get('provider') or '').strip();_pm=str(_prim.get('default') or '').strip()
   if _pp and _pm and route_id(_pp) not in ('moa','auto'):
    try:validate_target(updated,_pp,_pm)
    except ConfigError:
     raise ConfigError('「%s」是当前主模型，现在被停用了。先在上面①「主模型」里换一个，再回来取消它' % _pm,409)
  if semantic(updated)==semantic(data):return {**view(data),'changed':False}
  output=io.StringIO();yaml.dump(updated,output);encoded=output.getvalue().encode();_,verified=load_yaml(encoded)
  if semantic(verified)!=semantic(updated):raise ConfigError('模型配置序列化不一致，原文件已保留',503)
  public=view(updated)
  result=commit(path,state,raw,encoded,'models:'+action,{'models_after':revision(subset(updated))})
  # 配置落盘之后才动会话库 —— config 是真相，会话覆盖只是跟着它的记录。
  # 反过来先改会话、再写 config 失败，就变成「配置还在但会话已经飘走」。
  # 2026-11-16：面板上「删掉一个模型」实际是就地归档成 enabled:False
  # （patch() :465-468，注释写着 preserves historical selections），provider 和
  # base_url 全都还在 —— 按 provider/host 匹配一条会话也命中不了，会话会继续拿
  # 那个已经不在清单里的模型名去请求。这里算出 update 前后 enabled 集合的差集，
  # 交给清理函数按「provider + 模型名」精确命中。
  if action in ('update','toggle') and entry and identifier:
   def _live(_item):
    return {str(m.get('id') or m.get('model') or '') for m in model_rows(_item or {},entry[0]) if isinstance(m,dict) and enabled(m)}
   _gone=_live(entry[2])-_live(value)-{''}
   if _gone:retired={identifier:_gone}
  swept=clean_session_model_overrides(path,doomed,doomed_urls,_pm,retired) if (doomed or retired) else []
  return {**result,**public,'changed':True,'id':identifier,'reload_required':True,
          'auto_cleaned':auto_cleaned,'sessions_reset':swept}

if __name__=='__main__':
 try:print(json.dumps(execute(json.load(sys.stdin),Path(sys.argv[1]),Path(sys.argv[2]),sys.argv[3] if len(sys.argv)>3 else None),ensure_ascii=False))
 except Exception as error:
  print(json.dumps({'ok':False,'error':str(error) if isinstance(error,ConfigError) else '模型配置未收到保存确认，请重新读取核对','status':getattr(error,'status',500)},ensure_ascii=False));sys.exit(1)
