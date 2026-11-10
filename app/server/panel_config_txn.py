"""Shared, conflict-aware YAML transaction for panel-owned config operations."""
import copy
import importlib.util
import fcntl
import hashlib
import io
import json
import os
import sys
import tempfile
import time
import threading
from contextlib import contextmanager
from pathlib import Path
from ruamel.yaml import YAML

class ConfigError(Exception):
 def __init__(self,message,status=400):super().__init__(message);self.status=status

MISSING=object()
_bundle_module=None
_locks={}
_locks_guard=threading.Lock()
def recover_bundle(root):
 global _bundle_module
 if _bundle_module is None:
  spec=importlib.util.spec_from_file_location('_panel_bundle_recovery',Path(__file__).with_name('panel_config_bundle.py'))
  module=importlib.util.module_from_spec(spec)
  # Allow the bundle's import of shared helpers without depending on sys.path.
  if 'panel_config_txn' not in sys.modules:
   import types
   shared=types.ModuleType('panel_config_txn');shared.__dict__.update(globals());sys.modules['panel_config_txn']=shared
  spec.loader.exec_module(module)
  module.ConfigError=ConfigError;module.checksum=checksum;module.read_file=read_file
  _bundle_module=module
 _bundle_module.recover_pending(root)
def plain(value):
 if isinstance(value,dict):return {str(k):plain(v) for k,v in value.items()}
 if isinstance(value,list):return [plain(v) for v in value]
 if value is None or isinstance(value,(str,int,float,bool)):return value
 return str(value)
def checksum(raw):return hashlib.sha256(raw).hexdigest()
def semantic(value):return json.dumps(plain(value),ensure_ascii=False,sort_keys=True,separators=(',',':'))
def equal(a,b):return a is b if a is MISSING or b is MISSING else semantic(a)==semantic(b)
def load_yaml(raw):
 yaml=YAML(typ='rt');yaml.preserve_quotes=True;yaml.allow_duplicate_keys=False;yaml.width=4096
 try:value=yaml.load(raw.decode('utf-8') if isinstance(raw,bytes) else raw)
 except Exception:raise ConfigError('配置无法解析，原文件已保留',503)
 if not isinstance(value,dict):raise ConfigError('配置根节点必须是映射，原文件已保留',503)
 return yaml,value

def changes(before,after,prefix=()):
 if isinstance(before,dict) and isinstance(after,dict):
  result=[]
  for key in sorted(set(before)|set(after)):
   old=before.get(key,MISSING);new=after.get(key,MISSING)
   if isinstance(old,dict) and isinstance(new,dict):result.extend(changes(old,new,prefix+(key,)))
   elif not equal(old,new):result.append((prefix+(key,),old,new))
  return result
 return [(prefix,before,after)] if not equal(before,after) else []

def at(data,path):
 value=data
 for part in path:
  if not isinstance(value,dict) or part not in value:return MISSING
  value=value[part]
 return value

def assign(data,path,value):
 target=data
 for part in path[:-1]:
  if part not in target:target[part]={}
  if not isinstance(target[part],dict):raise ConfigError('配置层级已被其他操作修改，请重新读取',409)
  target[part]=copy.deepcopy(target[part])
  target=target[part]
 if value is MISSING:target.pop(path[-1],None)
 else:target[path[-1]]=copy.deepcopy(value)

def merge_changes(current,before,after):
 updated=copy.deepcopy(current)
 for path,old,new in changes(before,after):
  present=at(current,path)
  if not equal(present,old) and not equal(present,new):raise ConfigError('配置项“'+'.'.join(path)+'”已改变，请重新读取后保存',409)
  assign(updated,path,new)
 return updated

@contextmanager
def config_lock(root,*,recover=True):
 root=Path(root);root.mkdir(parents=True,exist_ok=True,mode=0o700)
 # Native credential operations nest YAML/env helpers under the auth-store
 # guard. Re-enter only in the same thread; retain flock across processes.
 key=(os.getpid(),str(root.resolve()))
 with _locks_guard:
  lock,holder=_locks.setdefault(key,(threading.RLock(),threading.local()))
 with lock:
  if getattr(holder,'depth',0):
   holder.depth+=1
   try:yield
   finally:holder.depth-=1
   return
  fd=os.open(root/'config-transaction.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
  try:
   fcntl.flock(fd,fcntl.LOCK_EX);holder.depth=1
   if recover:recover_bundle(root)
   yield
  finally:holder.depth=0;os.close(fd)

def read_file(path):
 path=Path(path)
 # Reject intermediate symlinks as well as a final link. Runtime resolves the
 # configured HOME alias before choosing the config path.
 for parent in [path,*path.parents]:
  if parent.is_symlink():raise ConfigError('配置路径包含链接，请先核对运行环境',403)
 for _ in range(4):
  fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
  try:
   st=os.fstat(fd)
   if not __import__('stat').S_ISREG(st.st_mode) or st.st_nlink>1:raise ConfigError('配置不是独立普通文件',403)
   with os.fdopen(os.dup(fd),'rb') as stream:raw=stream.read(8*1024*1024+1)
   if len(raw)>8*1024*1024:raise ConfigError('配置文件过大',413)
   current=os.stat(path,follow_symlinks=False)
   after=os.fstat(fd)
   # Atomic replacement can unlink the inode after open. Retry only when the
   # configured path now names a different inode; a linked current inode is
   # still rejected below.
   if (st.st_dev,st.st_ino)!=(current.st_dev,current.st_ino):continue
   if after.st_nlink==0:
    newest=os.stat(path,follow_symlinks=False)
    if (st.st_dev,st.st_ino)!=(newest.st_dev,newest.st_ino):continue
    raise ConfigError('配置文件正在被替换，请重试',409)
   if after.st_nlink!=1:raise ConfigError('配置不是独立普通文件',403)
   return raw,st
  finally:os.close(fd)
 raise ConfigError('配置文件正在被替换，请重试',409)

def commit(path,root,raw,encoded,reason,details=None):
 if raw==encoded:return {'changed':False,'revision':checksum(raw)}
 current,stat=read_file(path)
 if current!=raw:raise ConfigError('配置已被其他进程修改，请重试',409)
 directory=Path(root)/'config-history';directory.mkdir(parents=True,exist_ok=True,mode=0o700)
 identifier=str(time.time_ns())+'-'+checksum(raw)[:12]
 backup=directory/(identifier+'.yaml')
 fd=os.open(backup,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
 with os.fdopen(fd,'wb') as stream:stream.write(raw);stream.flush();os.fsync(stream.fileno())
 metadata={'id':identifier,'file':str(path),'before':checksum(raw),'after':checksum(encoded),'reason':str(reason)[:160],'created_at':int(time.time()*1000),'details':details or {}}
 fd=os.open(directory/(identifier+'.json'),os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
 with os.fdopen(fd,'w') as stream:json.dump(metadata,stream,ensure_ascii=False);stream.flush();os.fsync(stream.fileno())
 fd=os.open(directory,os.O_RDONLY|os.O_DIRECTORY)
 try:os.fsync(fd)
 finally:os.close(fd)
 fd,temp=tempfile.mkstemp(prefix='.panel-config-',dir=Path(path).parent)
 try:
  with os.fdopen(fd,'wb') as stream:
   os.fchmod(stream.fileno(),stat.st_mode&0o777)
   if stat.st_uid!=os.getuid() or stat.st_gid!=os.getgid():os.fchown(stream.fileno(),stat.st_uid,stat.st_gid)
   stream.write(encoded);stream.flush();os.fsync(stream.fileno())
  latest,latest_stat=read_file(path)
  if latest!=raw or (latest_stat.st_dev,latest_stat.st_ino)!=(stat.st_dev,stat.st_ino):raise ConfigError('保存前配置发生变化，请重新读取',409)
  os.replace(temp,path)
  fd=os.open(Path(path).parent,os.O_RDONLY|os.O_DIRECTORY)
  try:os.fsync(fd)
  finally:os.close(fd)
 finally:
  if os.path.exists(temp):os.unlink(temp)
 return {'changed':True,'revision':checksum(encoded),'change_id':identifier}

def execute(body,path,root):
 path=Path(path)
 with config_lock(root):
  if body.get('action')=='recover':return {'ok':True,'recovered':True}
  raw,_=read_file(path);yaml,current=load_yaml(raw)
  action=body.get('action')
  if action=='bundle_changes':
   if str(Path(__file__).parent) not in sys.path:sys.path.insert(0,str(Path(__file__).parent))
   from panel_env_txn import prepare_changes
   commit_bundle=_bundle_module.commit_bundle
   _,before=load_yaml(body.get('before',''));_,after=load_yaml(body.get('after',''));updated=merge_changes(current,before,after)
   out=io.StringIO();yaml.dump(updated,out);encoded=raw if equal(updated,current) else out.getvalue().encode();_,verified=load_yaml(encoded)
   if not equal(verified,updated):raise ConfigError('配置序列化不一致，原文件已保留',503)
   env_path=path.with_name('.env')
   try:env_raw,_=read_file(env_path)
   except FileNotFoundError:env_raw=None
   env_after=prepare_changes(env_raw,body.get('env_before',''),body.get('env_after',''))
   if env_raw is None and not env_after:return commit_bundle(root,[(path,raw,encoded)],'通讯配置与凭证')
   return commit_bundle(root,[(path,raw,encoded),(env_path,env_raw,env_after)],'通讯配置与凭证')
  if action=='replace_changes':
   _,before=load_yaml(body.get('before',''));_,after=load_yaml(body.get('after',''));updated=merge_changes(current,before,after)
  elif action=='managed_mcp':
   entries=body.get('entries')
   if not isinstance(entries,dict) or any(not str(key).startswith('conn-') or not isinstance(value,dict) for key,value in entries.items()):raise ConfigError('连接器注册内容不正确')
   updated=copy.deepcopy(current);updated['mcp_servers']=copy.deepcopy(current.get('mcp_servers',{}));servers=updated['mcp_servers']
   if not isinstance(servers,dict):raise ConfigError('MCP配置不是映射，原文件已保留',503)
   for key in list(servers):
    if str(key).startswith('conn-') and key not in entries:del servers[key]
   for key,value in entries.items():servers[key]=value
  elif action=='mcp_entry':
   name=body.get('name');entry=body.get('entry')
   if not isinstance(name,str) or not __import__('re').fullmatch(r'[A-Za-z0-9_-]{1,100}',name) or (entry is not None and not isinstance(entry,dict)):raise ConfigError('MCP服务内容不正确')
   updated=copy.deepcopy(current);updated['mcp_servers']=copy.deepcopy(current.get('mcp_servers',{}));servers=updated['mcp_servers']
   if not isinstance(servers,dict):raise ConfigError('MCP配置不是映射，原文件已保留',503)
   if entry is None:servers.pop(name,None)
   else:servers[name]=entry
  elif action=='patch':
   updated=copy.deepcopy(current)
   for operation in body.get('operations',[]):
    field=operation.get('path')
    if not isinstance(field,list) or not field or any(not isinstance(p,str) or not p for p in field):raise ConfigError('配置字段路径不正确')
    expected=operation.get('expected',MISSING);value=operation.get('value',MISSING)
    if not equal(at(current,field),expected) and not equal(at(current,field),value):raise ConfigError('配置项“'+'.'.join(field)+'”已改变，请重新读取',409)
    assign(updated,field,value)
  else:raise ConfigError('配置操作不存在',404)
  if equal(current,updated):return {'ok':True,'changed':False,'revision':checksum(raw)}
  out=io.StringIO();yaml.dump(updated,out);encoded=out.getvalue().encode();_,verified=load_yaml(encoded)
  if not equal(verified,updated):raise ConfigError('配置序列化不一致，原文件已保留',503)
  return {'ok':True,**commit(path,root,raw,encoded,body.get('reason',action))}

if __name__=='__main__':
 try:print(json.dumps(execute(json.load(sys.stdin),sys.argv[1],sys.argv[2]),ensure_ascii=False))
 except Exception as error:
  print(json.dumps({'ok':False,'error':str(error) if isinstance(error,ConfigError) else '配置未收到保存确认，请重新读取核对','status':getattr(error,'status',500)},ensure_ascii=False));sys.exit(1)
