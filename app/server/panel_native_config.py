"""Native config write coordination, scoped to config.yaml only.

Read snapshots belong to returned dictionaries, never a thread's 'latest read'.
No service imports, no agent execution, no configuration reads at import time.
"""
import copy
import importlib.util
import io
import os
import sys
import tempfile
import threading
from collections import OrderedDict
from pathlib import Path

_spec=importlib.util.spec_from_file_location('_panel_shared_config_txn',Path(__file__).with_name('panel_config_txn.py'))
if _spec.name not in sys.modules:
 _module=importlib.util.module_from_spec(_spec);sys.modules[_spec.name]=_module;_spec.loader.exec_module(_module)
txn=sys.modules[_spec.name]
sys.modules.setdefault('panel_config_txn',txn)
if 'panel_config_bundle' not in sys.modules:
 _bundle_spec=importlib.util.spec_from_file_location('panel_config_bundle',Path(__file__).with_name('panel_config_bundle.py'))
 _bundle=importlib.util.module_from_spec(_bundle_spec);sys.modules[_bundle_spec.name]=_bundle;_bundle_spec.loader.exec_module(_bundle)
_raw_cache=OrderedDict()
_raw_cache_lock=threading.RLock()

class ConfigDocument(dict):
 def __init__(self,value,snapshot):super().__init__(value);self._panel_snapshot=snapshot
 def __copy__(self):return ConfigDocument(dict(self),copy.deepcopy(self._panel_snapshot))
 def copy(self):return self.__copy__()
 def __deepcopy__(self,memo):
  result=ConfigDocument({},copy.deepcopy(self._panel_snapshot,memo));memo[id(self)]=result
  for key,value in self.items():result[copy.deepcopy(key,memo)]=copy.deepcopy(value,memo)
  return result

def snapshot_of(value):return getattr(value,'_panel_snapshot',None)
def empty_mapping(value):return {} if value is None else value
def ensure_recovered(path):
 if not config_path(Path(path).with_name('config.yaml')):return
 root=state_root(path)
 if (root/'config-bundle-pending.json').exists():
  with txn.config_lock(root):pass
  return True
 return False
def yaml_source(raw):
 text=raw.decode('utf-8') if isinstance(raw,bytes) else raw
 return '{}' if all(not line.strip() or line.lstrip().startswith('#') or line.strip() in {'---','...'} for line in text.splitlines()) else raw
def revision_of(value):
 snap=snapshot_of(value)
 if not snap:raise txn.ConfigError('配置缺少读取版本，请重新读取',409)
 return snap['raw_hash'] or 'missing'

def expect_revision(value,revision):
 if not isinstance(revision,str) or not revision:raise txn.ConfigError('配置缺少读取版本，请重新读取后保存；当前编辑内容尚未保存',409)
 if revision_of(value)!=revision:raise txn.ConfigError('配置已在别处修改，当前编辑内容尚未保存；请保留内容并重新读取核对',409)
 if snapshot_of(value).get('invalid'):raise txn.ConfigError('原始配置格式损坏，请在 YAML 编辑器中修复后保存',409)
 snapshot_of(value)['expected_revision']=revision
 return value
def config_path(path):
 candidate=Path(path).absolute()
 if candidate.name!='config.yaml':return False
 # Restrict this application patch to its home/profiles. A skill may call the
 # generic YAML helper for an unrelated project's own config.yaml.
 configured=os.environ.get('HERMES_PANEL_CONFIG_ROOT') or os.environ.get('DATA_DIR')
 roots=[Path(configured)] if configured else [Path('/vol1/@apphome/hermes-agent/data')]
 if os.environ.get('HERMES_HOME'):roots.append(Path(os.environ['HERMES_HOME']))
 for root in roots:
  root=root.absolute()
  if candidate==root/'config.yaml':return True
  try:relative=candidate.relative_to(root/'profiles')
  except ValueError:continue
  if len(relative.parts)==2 and relative.parts[-1]=='config.yaml':return True
 return False
def raw_at(path):
 try:raw,_=txn.read_file(path)
 except FileNotFoundError:return None,{}
 digest=txn.checksum(raw)
 with _raw_cache_lock:
  data=_raw_cache.get(digest)
  if data is None:
   _,parsed=txn.load_yaml(yaml_source(raw));data=txn.plain(parsed);_raw_cache[digest]=data
   while len(_raw_cache)>8:_raw_cache.popitem(last=False)
  else:_raw_cache.move_to_end(digest)
  return raw,copy.deepcopy(data)

def capture(path,reader):
 """Bracket a native reader, including cache hits; do not attach a later revision."""
 path=Path(path)
 if not config_path(path):return reader()
 ensure_recovered(path)
 for _ in range(3):
  invalid=False
  try:before,raw_data=raw_at(path)
  except txn.ConfigError as error:
   if error.status!=503:raise
   # Preserve native last-known-good read behavior. These values may be used
   # at runtime, but cannot ever be written over the broken source document.
   before,_=txn.read_file(path);raw_data={};invalid=True
  value=reader()
  try:after,_=txn.read_file(path)
  except FileNotFoundError:after=None
  if before==after:
   if not isinstance(value,dict):return value
   return ConfigDocument(value,{'path':str(path),'raw':raw_data,'raw_hash':txn.checksum(before) if before is not None else None,'value':copy.deepcopy(dict(value)),'invalid':invalid})
 raise txn.ConfigError('读取配置时文件持续变化，请稍后重试',409)

def attach_raw(path,value,raw=None):
 """Attach source bytes supplied by a raw reader; never infer stale data's origin."""
 if not config_path(path) or not isinstance(value,dict):return value
 if raw is None:
  current,data=raw_at(path)
  if txn.semantic(data)!=txn.semantic(value):raise txn.ConfigError('原始配置读取期间文件改变，请重试',409)
 else:
  current=raw if isinstance(raw,bytes) else raw.encode();_,data=txn.load_yaml(yaml_source(current))
 return ConfigDocument(value,{'path':str(path),'raw':txn.plain(data),'raw_hash':txn.checksum(current) if current is not None else None,'value':copy.deepcopy(dict(value))})

def inherit(value,source):
 snap=snapshot_of(source)
 return ConfigDocument(value,copy.deepcopy(snap)) if snap and isinstance(value,dict) else value

def raw_stream(stream,loader):
 path=getattr(stream,'name',None)
 if not isinstance(path,(str,Path)) or not config_path(path):return loader(stream)
 recovered=ensure_recovered(path)
 raw=txn.read_file(path)[0] if recovered else stream.read();value=empty_mapping(loader(raw))
 return attach_raw(path,value,raw)

def missing_snapshot(path):
 raw,data=raw_at(path)
 if raw is not None:raise txn.ConfigError('配置保存缺少读取版本，请重新读取后重试',409)
 return {'path':str(path),'raw':{},'raw_hash':None,'value':{}}

def create_missing(path,root,encoded):
 # Atomic no-replace publication. Another creator can never be overwritten.
 path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
 for parent in [path.parent,*path.parent.parents]:
  if parent.is_symlink():raise txn.ConfigError('配置父目录包含链接，拒绝创建',403)
 fd,temp=tempfile.mkstemp(prefix='.panel-config-new-',dir=path.parent)
 try:
  with os.fdopen(fd,'wb') as stream:stream.write(encoded);stream.flush();os.fsync(stream.fileno())
  try:os.link(temp,path)
  except FileExistsError:raise txn.ConfigError('配置在创建期间已出现，请重新读取',409)
  os.unlink(temp)
  fd=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
  try:os.fsync(fd)
  finally:os.close(fd)
 finally:
  if os.path.exists(temp):os.unlink(temp)

def state_root(path):
 override=os.environ.get('HERMES_PANEL_STATE_DIR')
 if override:return Path(override)
 # APP bridge lives outside DATA. VAR symlink is resolved once, lock and backup
 # always live on the same panel state root as Monitor.
 return (Path(__file__).resolve().parents[1]/'var/panel-state').resolve()

def write(path,data,*,snapshot=None,baseline=None,state=None,managed_keys=(),effective_after=None):
 path=Path(path)
 if not config_path(path):return False
 snap=snapshot or snapshot_of(data)
 if not snap:snap=missing_snapshot(path)
 if snap.get('invalid'):raise txn.ConfigError('原始配置格式损坏，拒绝用回退值覆盖；请在 YAML 编辑器中修复',409)
 if str(path)!=snap['path']:raise txn.ConfigError('配置读取与写入路径不一致，拒绝跨环境保存',409)
 desired=copy.deepcopy(snap['raw']);before=baseline if baseline is not None else snap['value']
 # Only semantic changes requested by the caller are applied. Schema defaults,
 # managed overlays, and expanded secrets present in a native loaded config
 # must not become unrelated writes.
 for field,old,new in txn.changes(before,data):txn.assign(desired,field,new)
 for field in managed_keys:txn.assign(desired,tuple(field.split('.')),txn.MISSING)
 root=Path(state) if state else state_root(path)
 effective=copy.deepcopy(dict(data if effective_after is None else effective_after))
 with txn.config_lock(root):
  try:current,stat=txn.read_file(path)
  except FileNotFoundError:
   if snap['raw_hash'] is not None:raise txn.ConfigError('配置已被移走，拒绝重新创建',409)
   yaml,_=txn.load_yaml('{}');out=io.StringIO();yaml.dump(desired,out);encoded=out.getvalue().encode();create_missing(path,root,encoded)
   snap.update(raw=txn.plain(desired),raw_hash=txn.checksum(encoded),value=effective);snap.pop('expected_revision',None)
   return True
  yaml,value=txn.load_yaml(yaml_source(current))
  if snap['raw_hash'] is None:raise txn.ConfigError('配置在创建期间已出现，请重新读取',409)
  if snap.get('expected_revision') and txn.checksum(current)!=snap['expected_revision']:raise txn.ConfigError('配置在保存期间已改变，当前编辑内容尚未保存；请重新读取核对',409)
  updated=txn.merge_changes(value,snap['raw'],desired)
  if txn.semantic(updated)==txn.semantic(value):
   snap.update(raw=txn.plain(desired),raw_hash=txn.checksum(current),value=effective)
   snap.pop('expected_revision',None)
   return True
  out=io.StringIO();yaml.dump(updated,out);encoded=out.getvalue().encode();_,verified=txn.load_yaml(encoded)
  if txn.semantic(verified)!=txn.semantic(updated):raise txn.ConfigError('配置序列化不一致，原文件已保留',503)
  txn.commit(path,root,current,encoded,'native:configuration')
  # Keep unseen, concurrent fields at the caller's original baseline. A later
  # edit of that field must still conflict instead of silently claiming it.
  snap.update(raw=txn.plain(desired),raw_hash=txn.checksum(encoded),value=effective)
  snap.pop('expected_revision',None)
 return True

def raw_document(path):
 ensure_recovered(path)
 try:raw,_=txn.read_file(path)
 except FileNotFoundError:raw=None
 return {'yaml':raw.decode('utf-8') if raw is not None else '', 'path':str(path),'revision':txn.checksum(raw) if raw is not None else 'missing'}

def replace_raw(path,text,revision,managed_keys=()):
 """Versioned editor replacement: preserve exactly the submitted YAML text."""
 if not config_path(path):raise txn.ConfigError('配置路径不属于当前应用',403)
 if not isinstance(text,str) or len(text.encode())>8*1024*1024:raise txn.ConfigError('配置文件过大',413)
 encoded=text.encode('utf-8');_,desired=txn.load_yaml(encoded)
 root=state_root(path)
 with txn.config_lock(root):
  try:raw,_=txn.read_file(path)
  except FileNotFoundError:raw=None
  if not revision or revision!=(txn.checksum(raw) if raw is not None else 'missing'):raise txn.ConfigError('配置已在别处修改，当前编辑内容尚未保存；请保留内容并重新读取核对',409)
  current=txn.load_yaml(raw)[1] if managed_keys and raw is not None else {}
  for field in managed_keys:
   parts=tuple(field.split('.'))
   if not txn.equal(txn.at(current,parts),txn.at(desired,parts)):raise txn.ConfigError('此配置项由运行环境管理，不能在编辑器中修改：'+field,403)
  if raw is None:create_missing(path,root,encoded)
  else:txn.commit(path,root,raw,encoded,'native:raw editor')
 return txn.checksum(encoded)

def dotted_update(path,key_path,value,*,state=None):
 if not config_path(path):return False
 root=Path(state) if state else state_root(path)
 with txn.config_lock(root):
  try:raw,_=txn.read_file(path)
  except FileNotFoundError:raw=None
  yaml,current=txn.load_yaml(raw if raw is not None else '{}');updated=copy.deepcopy(current)
  field=key_path.split('.')
  if not field or any(not p for p in field):raise txn.ConfigError('配置字段路径不正确')
  txn.assign(updated,field,value)
  if txn.semantic(updated)==txn.semantic(current):return True
  out=io.StringIO();yaml.dump(updated,out)
  if raw is None:create_missing(path,root,out.getvalue().encode())
  else:txn.commit(path,root,raw,out.getvalue().encode(),'native:config set '+key_path)
 return True
