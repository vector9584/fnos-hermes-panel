"""Read configured model targets and credentials without importing the running agent."""
import json,os,re,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from panel_model_catalog import entries,enabled,available_models,detected_mode,credential_fields,provider_fields
from panel_config_txn import ConfigError,read_file,load_yaml,config_lock
from panel_env_txn import parse

class Failure(Exception):pass

def read_source(config_path,var_root,request):
    # Match the Monitor state root and serialize with multi-file recovery.
    # A verification request must never combine pre-save YAML with post-save
    # credentials. No network call occurs while this lock is held.
    try:
        with config_lock(Path(var_root)/'panel-state'):
            return _read_source(config_path,var_root,request)
    except ConfigError as error:raise Failure(str(error)) from error

def _read_source(config_path,var_root,request):
    path=Path(config_path)
    if path.is_symlink() or not path.is_file():raise Failure('模型配置文件不可读取')
    try:_,config=load_yaml(read_file(path)[0])
    except Exception:raise Failure('模型配置无法解析，原文件已保留')
    if not isinstance(config,dict):raise Failure('模型配置结构不正确')
    catalog=[];private={};origins={}
    for key,(origin,_,item) in entries(config).items():
        if not enabled(item):continue
        ids=available_models(item,origin)
        if not ids:continue
        catalog.append({'id':key,'name':str(item.get('name') or key),'models':ids})
        private[key]=item
        origins[key]=origin
    if request.get('action')=='catalog':return {'ok':True,'providers':catalog}
    provider=request.get('provider');model=request.get('model')
    if request.get('action')=='resolve' and not model:
        provider=provider or request.get('provider_id')
        target=next((item for item in catalog if item['id']==provider),None)
        if not target:raise Failure('所选服务不存在或已停用')
        model=next((value for value in target['models'] if isinstance(value,str)),None)
        if not model:raise Failure('服务没有可用于模型发现的模型条目')
    target=next((item for item in catalog if item['id']==provider),None)
    if not target or model not in target['models']:raise Failure('所选服务或模型已不在配置中，请刷新列表')
    item=private[provider]
    fields=provider_fields(item,origins[provider])
    base=fields['base_url'].rstrip('/')
    if not re.match(r'^https?://[^\s@]+$',base):raise Failure('所选服务的端点地址无效')
    # Resolve only stored references. Never send an API key to a caller-supplied URL.
    environment=dict(os.environ)
    # spawnHermes merges provider env first, then HOME/.env wins. Use its
    # strict dotenv parser too: malformed or linked files are not empty files.
    for env_file in (Path(var_root)/'.env.providers',path.parent/'.env'):
        try:raw,_=read_file(env_file)
        except FileNotFoundError:continue
        except Exception:raise Failure('模型凭证文件不可读取，原文件已保留')
        try:_,values=parse(raw)
        except Exception:raise Failure('模型凭证文件无法解析，原文件已保留')
        for key,value in values.items():
            if value is not None:environment[key]=value
    def expand(value):
        missing=[]
        def replace(match):
            name=match.group(1)
            if name not in environment:missing.append(name)
            return environment.get(name,'')
        result=re.sub(r'\$\{([A-Za-z_][A-Za-z0-9_]*)\}',replace,str(value or ''))
        if missing:raise Failure('所选服务引用的密钥环境变量尚未配置')
        return result
    credentials=credential_fields(item,origins[provider])
    key_env=credentials['key_env']
    from_env=environment.get(str(key_env),'').strip() if key_env else ''
    inline='' if origins[provider]=='providers' and from_env else expand(credentials['api_key']).strip()
    # Legacy custom_providers uses inline first; providers uses key_env first.
    api_key=(from_env or inline) if origins[provider]=='providers' else (inline or from_env)
    if key_env and not api_key:raise Failure('所选服务引用的密钥环境变量尚未配置')
    mode=fields['api_mode'] or detected_mode(base)
    if mode not in ('chat_completions','codex_responses','anthropic_messages'):raise Failure('此服务的接口协议不能用于直接响应验证')
    headers=item.get('extra_headers',{}) or {}
    if not isinstance(headers,dict):raise Failure('所选服务的附加请求头格式不正确')
    return {'ok':True,'target':{'provider':provider,'name':target['name'],'model':model,'base_url':base,'api_key':api_key,'api_mode':mode,
            'headers':{str(k):expand(v) for k,v in headers.items()},'extra_body':item.get('extra_body',{}) if isinstance(item.get('extra_body',{}),dict) else {}}}

if __name__=='__main__':
    try:print(json.dumps(read_source(sys.argv[1],sys.argv[2],json.load(sys.stdin)),ensure_ascii=False))
    except Exception as error:print(json.dumps({'ok':False,'error':str(error) if isinstance(error,Failure) else '模型配置读取失败'},ensure_ascii=False));sys.exit(1)
