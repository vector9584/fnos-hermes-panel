"""APP-only bridge to the shared native/panel YAML transaction code."""
import importlib.util
import sys
import os
from contextlib import contextmanager
from pathlib import Path
_name='_hermes_panel_native_config'
if _name not in sys.modules:
 _spec=importlib.util.spec_from_file_location(_name,Path(__file__).resolve().parent.parent/'server/panel_native_config.py')
 _module=importlib.util.module_from_spec(_spec);sys.modules[_name]=_module;_spec.loader.exec_module(_module)
from _hermes_panel_native_config import capture,attach_raw,snapshot_of,write,dotted_update,inherit,raw_stream,missing_snapshot,revision_of,expect_revision,raw_document,replace_raw,empty_mapping,config_path,ensure_recovered
from _hermes_panel_native_config import txn
ConfigError=txn.ConfigError

def _env_module():
 name='_hermes_panel_env_txn'
 if name not in sys.modules:
  # The env helper shares panel_config_txn with the native YAML bridge.
  sys.modules.setdefault('panel_config_txn',txn)
  spec=importlib.util.spec_from_file_location(name,Path(__file__).resolve().parent.parent/'server/panel_env_txn.py')
  module=importlib.util.module_from_spec(spec);sys.modules[name]=module;spec.loader.exec_module(module)
 return sys.modules[name]

def update_env(path,key,value=None,*,remove=False):
 from _hermes_panel_native_config import config_path,state_root
 if not config_path(Path(path).with_name('config.yaml')):return None
 return _env_module().execute({'action':'remove' if remove else 'set','key':key,'value':value},path,state_root(path))

def read_env(path):
 if not config_path(Path(path).with_name('config.yaml')):return None
 ensure_recovered(path)
 try:raw,_=txn.read_file(path)
 except FileNotFoundError:return {}
 return {key:value for key,value in _env_module().parse(raw)[1].items() if value is not None}

@contextmanager
def auth_guard(path):
 from _hermes_panel_native_config import state_root
 if config_path(Path(path).with_name('config.yaml')):
  with txn.config_lock(state_root(path)):yield
 else:yield

def provider_credential(key,value=None,*,remove=False):
 from hermes_cli import config,auth,managed_scope
 from _hermes_panel_native_config import state_root
 env_path=config.get_env_path();yaml_path=config.get_config_path();auth_path=auth._auth_file_path()
 if not config_path(yaml_path):return None
 if config.is_managed() or managed_scope.is_env_managed(key):raise txn.ConfigError('此凭证由运行环境管理，未修改任何存储',403)
 if not isinstance(key,str) or not config._ENV_VAR_NAME_RE.fullmatch(key):raise txn.ConfigError('凭证变量名不正确')
 config._reject_denylisted_env_var(key)
 if not remove and (not isinstance(value,str) or not value.isascii() or any(c in value for c in '\r\n\x00')):raise txn.ConfigError('凭证需要单行ASCII文本，原值未修改')
 if env_path.parent!=yaml_path.parent or auth_path.parent!=yaml_path.parent:raise txn.ConfigError('凭证存储不在同一环境，尚未保存',409)
 name='_hermes_panel_provider_credentials'
 if name not in sys.modules:
  sys.modules.setdefault('panel_env_txn',_env_module())
  spec=importlib.util.spec_from_file_location(name,Path(__file__).resolve().parent.parent/'server/panel_provider_credentials.py')
  module=importlib.util.module_from_spec(spec);sys.modules[name]=module;spec.loader.exec_module(module)
 providers=[pid for pid,cfg in auth.PROVIDER_REGISTRY.items() if key in (cfg.api_key_env_vars or ())]
 with auth._auth_store_lock():
  result=sys.modules[name].update(yaml_path.parent,state_root(yaml_path),key,None if remove else value,providers)
 if remove:os.environ.pop(key,None)
 else:os.environ[key]=value
 config.invalidate_env_cache()
 # A derived model list is not an authority for credentials. Report failure
 # explicitly without undoing a successfully committed credential operation.
 failures=[]
 try:
  from hermes_cli.models import clear_provider_models_cache
  for provider in result['providers']:
   try:clear_provider_models_cache(provider)
   except Exception:failures.append(provider)
 except Exception:failures=list(result['providers'])
 if failures:result['cache_refresh_pending']=failures
 return result

def filter_auth_entries(store,entries):
 from hermes_cli import auth
 if not config_path(auth._auth_file_path().with_name('config.yaml')):return entries
 # May be invoked by a pool writer before the first lifecycle call.
 sys.modules.setdefault('panel_env_txn',_env_module())
 name='_hermes_panel_provider_credentials'
 if name not in sys.modules:
  spec=importlib.util.spec_from_file_location(name,Path(__file__).resolve().parent.parent/'server/panel_provider_credentials.py')
  module=importlib.util.module_from_spec(spec);sys.modules[name]=module;spec.loader.exec_module(module)
 return sys.modules[name].filter_pool_entries(store,entries)
