"""Authenticated panel recovery; never automatically resolves an external edit."""
import json,sys
from pathlib import Path
from panel_config_txn import ConfigError,config_lock
from panel_config_bundle import inspect_pending,resolve_pending

def execute(body,home,state):
 home=Path(home);allowed=[home]
 profiles=home/'profiles'
 if profiles.is_dir() and not profiles.is_symlink():
  allowed.extend(p for p in profiles.iterdir() if p.is_dir() and not p.is_symlink())
 # Inspection must remain available precisely when ordinary config_lock refuses
 # recovery. It still takes the same flock; it only bypasses automatic replay.
 with config_lock(state,recover=False):
  if body.get('action')=='read':return inspect_pending(state,allowed)
  if body.get('action')=='resolve':return resolve_pending(state,allowed,body)
  raise ConfigError('配置恢复操作不存在',404)

if __name__=='__main__':
 try:print(json.dumps(execute(json.load(sys.stdin),sys.argv[1],sys.argv[2]),ensure_ascii=False))
 except Exception as error:
  print(json.dumps({'ok':False,'error':str(error) if isinstance(error,ConfigError) else '配置恢复记录无法读取，原文件已保留','status':getattr(error,'status',503)},ensure_ascii=False));sys.exit(1)
