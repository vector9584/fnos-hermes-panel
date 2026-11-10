"""Edit exactly one auxiliary task with round-trip YAML and an optimistic revision."""
import copy
import fcntl
import hashlib
import io
import json
import os
import re
import sys
import tempfile
import time
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from panel_config_txn import config_lock
from panel_model_catalog import entries as model_entries,enabled,available_models,provider_fields
from ruamel.yaml import YAML
from ruamel.yaml.comments import CommentedMap

TASKS = [('vision','图像理解'),('web_extract','网页提取'),('compression','上下文压缩'),
         ('skills_hub','技能库'),('approval','审批判定'),('mcp','MCP 调用'),
         ('title_generation','会话标题生成'),('triage_specifier','任务分诊'),
         ('kanban_decomposer','看板拆解'),('profile_describer','画像描述'),('curator','技能维护')]
PUBLIC = ('provider','model','base_url','key_env','timeout','download_timeout')

class Failure(Exception):
    def __init__(self, message, status=400):
        super().__init__(message);self.status=status


def plain(value):
    if isinstance(value,dict):return {str(k):plain(v) for k,v in value.items()}
    if isinstance(value,list):return [plain(v) for v in value]
    if value is None or isinstance(value,(str,int,float,bool)):return value
    return str(value)


def revision(value):
    return hashlib.sha256(json.dumps(plain(value),ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()


def public(task):
    if not isinstance(task,dict):raise Failure('辅助任务配置不是映射，原文件已保留',503)
    result={key:plain(task[key]) for key in PUBLIC if key in task}
    if 'key_env' not in result and task.get('api_key_env'):result['key_env']=plain(task['api_key_env'])
    result['credential_set']=bool(task.get('api_key') or task.get('key_env') or task.get('api_key_env'))
    chain=task.get('fallback_chain',[]) or []
    if not isinstance(chain,list) or any(not isinstance(item,dict) for item in chain):raise Failure('回退链格式不正确，原文件已保留',503)
    result['fallback_chain']=[{**{key:plain(item[key]) for key in PUBLIC if key in item},**({'key_env':plain(item['api_key_env'])} if not item.get('key_env') and item.get('api_key_env') else {}),'source_index':i,'credential_set':bool(item.get('api_key') or item.get('key_env') or item.get('api_key_env'))} for i,item in enumerate(chain)]
    return result


def document(path):
    if not path.is_file() or path.is_symlink():raise Failure('模型配置文件不存在或使用了符号链接',503)
    raw=path.read_bytes();yaml=YAML(typ='rt');yaml.preserve_quotes=True;yaml.allow_duplicate_keys=False;yaml.width=4096
    try:data=yaml.load(raw.decode())
    except Exception:raise Failure('模型配置无法解析，原文件已保留',503)
    if not isinstance(data,dict) or not isinstance(data.get('auxiliary',{}),dict):raise Failure('辅助模型配置结构不完整，原文件已保留',503)
    return raw,yaml,data


def listing(data):
    auxiliary=data.get('auxiliary',{})
    return [{**public(auxiliary.get(key,{}) or {}),'key':key,'label':label,'revision':revision(auxiliary.get(key,{})),'present':key in auxiliary} for key,label in TASKS]


def response(data):
    # The runtime config supplies canonical provider ids. Panel display ids (e.g.
    # openai versus openai-api) and guessed environment variable names are unsafe.
    services=[]
    for key,(origin,_,item) in model_entries(data).items():
        if not enabled(item):continue
        services.append({'id':'custom:'+key,'name':str(item.get('name') or key),'model':provider_fields(item,origin)['model'],'models':available_models(item,origin)})
    return {'ok':True,'tasks':listing(data),'services':services}


def scalar(key,value):
    if key in ('timeout','download_timeout'):
        if value is None:return None
        if isinstance(value,bool) or not isinstance(value,(int,float)) or not 1<=value<=3600:raise Failure('超时需为1到3600秒')
        return value
    if not isinstance(value,str) or len(value)>2000 or '\n' in value or '\r' in value:raise Failure('模型配置字段格式不正确')
    value=value.strip()
    if key=='base_url' and value and not re.match(r'^https?://[^\s@]+$',value):raise Failure('端点需使用HTTP或HTTPS地址，不能包含凭证')
    if key=='key_env' and value and not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*',value):raise Failure('密钥环境变量名格式不正确')
    return value


def patch_entry(old,changes):
    if not isinstance(changes,dict) or any(key not in PUBLIC for key in changes):raise Failure('包含不支持的辅助模型字段')
    updated=copy.deepcopy(old)
    for key,value in changes.items():
        value=scalar(key,value)
        if value is None or value=='':updated.pop(key,None)
        else:updated[key]=value
    if 'key_env' in changes and str(changes['key_env'])!=str(old.get('key_env',old.get('api_key_env',''))):
        updated.pop('api_key',None);updated.pop('api_key_env',None)
    if changes.get('provider')=='auto':
        for key in ('model','base_url','api_key','key_env','api_key_env'):updated.pop(key,None)
    # A credential tied to another endpoint must never silently follow a provider change.
    changed_endpoint=any(key in changes and str(changes[key])!=str(old.get(key,'')) for key in ('provider','base_url'))
    if changed_endpoint and changes.get('provider')!='auto':
        updated.pop('api_key',None)
        if 'key_env' not in changes:
            updated.pop('key_env',None);updated.pop('api_key_env',None)
        if updated.get('provider')=='custom' and not updated.get('base_url'):
            raise Failure('独立端点需要填写端点地址，或选择已有模型服务')
    return updated


def execute(request,path,root):
    if request.get('action')=='read':return response(document(path)[2])
    key=request.get('key')
    if key not in dict(TASKS):raise Failure('没有此辅助任务')
    root.mkdir(parents=True,exist_ok=True)
    with config_lock(root.parent):
        raw,yaml,data=document(path);aux=data.setdefault('auxiliary',CommentedMap());old=aux.get(key,{}) or {}
        if request.get('revision')!=revision(aux.get(key,{})):raise Failure('辅助模型已在其他页面修改，请重新读取后再保存',409)
        if not isinstance(old,dict):raise Failure('辅助模型结构不正确',503)
        changes=request.get('changes',{})
        if not isinstance(changes,dict):raise Failure('修改字段格式不正确')
        updated=patch_entry(old,{k:v for k,v in changes.items() if k!='fallback_chain'})
        if 'fallback_chain' in changes:
            if key!='vision':raise Failure('此任务没有回退链编辑入口')
            chain=changes['fallback_chain'];previous=old.get('fallback_chain',[]) or [];used=set();replacement=[]
            if not isinstance(chain,list) or len(chain)>20:raise Failure('回退链最多20项')
            for entry in chain:
                if not isinstance(entry,dict):raise Failure('回退项格式不正确')
                index=entry.get('source_index');prior={}
                if index is not None:
                    if type(index) is not int or index<0 or index>=len(previous) or index in used:raise Failure('回退项已变化，请重新读取',409)
                    used.add(index);prior=previous[index]
                item=patch_entry(prior,{k:v for k,v in entry.items() if k not in ('source_index','credential_set')})
                if not item.get('provider'):raise Failure('回退项需选择模型服务')
                replacement.append(item)
            updated['fallback_chain']=replacement
        aux[key]=updated
        output=io.StringIO();yaml.dump(data,output);encoded=output.getvalue().encode()
        # Verify no shared YAML alias mutated another configuration object.
        original=yaml.load(raw.decode());expected=copy.deepcopy(plain(original));expected.setdefault('auxiliary',{})[key]=plain(updated)
        if plain(yaml.load(encoded.decode()))!=expected:raise Failure('配置包含共享引用，无法独立修改此任务，原文件未改写',409)
        if plain(data)==plain(original):return response(data)
        backup=root/('auxiliary-'+str(time.time_ns())+'-'+hashlib.sha256(raw).hexdigest()[:12]+'.yaml')
        with backup.open('xb') as stream:
            os.fchmod(stream.fileno(),0o600);stream.write(raw);stream.flush();os.fsync(stream.fileno())
        fd,temp=tempfile.mkstemp(prefix='.auxiliary-',dir=path.parent)
        try:
            with os.fdopen(fd,'wb') as stream:
                os.fchmod(stream.fileno(),path.stat().st_mode&0o777);stream.write(encoded);stream.flush();os.fsync(stream.fileno())
            if path.read_bytes()!=raw:raise Failure('模型配置刚被其他进程修改，请重试',409)
            os.replace(temp,path)
            directory=os.open(path.parent,os.O_RDONLY)
            try:os.fsync(directory)
            finally:os.close(directory)
        finally:
            if os.path.exists(temp):os.unlink(temp)
        return response(data)


if __name__=='__main__':
    try:print(json.dumps(execute(json.load(sys.stdin),Path(sys.argv[1]),Path(sys.argv[2])),ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'ok':False,'error':str(error) if isinstance(error,Failure) else '辅助模型保存失败，未收到成功确认，请重新读取核对','status':getattr(error,'status',500)},ensure_ascii=False));sys.exit(1)
