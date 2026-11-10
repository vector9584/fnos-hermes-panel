"""Shared .env transactions. Values never appear in returned metadata/errors."""
import io
import json
import re
import sys
from pathlib import Path
from dotenv.parser import parse_stream
from panel_config_txn import ConfigError,checksum,config_lock,read_file,commit

def parse(raw):
 try:text=(raw.decode('utf-8-sig') if isinstance(raw,bytes) else raw).removeprefix('\ufeff')
 except UnicodeDecodeError:raise ConfigError('凭证文件不是有效 UTF-8，原文件已保留',503)
 bindings=list(parse_stream(io.StringIO(text)));values={}
 for binding in bindings:
  if binding.error:raise ConfigError('凭证文件第 '+str(binding.original.line)+' 行无法解析，原文件已保留',503)
  if binding.key:
   if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*',binding.key):raise ConfigError('凭证文件含不支持的变量名，原文件已保留',503)
   values[binding.key]=binding.value
 return bindings,values

def quote(value):
 if not isinstance(value,str) or '\n' in value or '\r' in value or '\x00' in value:raise ConfigError('凭证值必须是单行文本')
 # Double quoting matches native Hermes' parser and preserves ${VAR} refs.
 return '"'+value.replace('\\','\\\\').replace('"','\\"')+'"'

def render(bindings,operations):
 out=[];seen=set()
 for binding in bindings:
  key=binding.key
  if key not in operations:out.append(binding.original.string);continue
  if key in seen:continue
  seen.add(key);value=operations[key]
  if value is not None:out.append(key+'='+quote(value)+'\n')
 for key,value in operations.items():
  if key in seen or value is None:continue
  if out and not out[-1].endswith(('\n','\r')):out.append('\n')
  out.append(key+'='+quote(value)+'\n')
 return ''.join(out).encode('utf-8')

def prepare_changes(raw,before,after):
 bindings,current=parse(raw or b'');_,original=parse(before);_,desired=parse(after);operations={}
 for key in sorted(set(original)|set(desired)):
  if original.get(key)!=desired.get(key) or (key in original)!=(key in desired):
   if current.get(key)!=original.get(key) and current.get(key)!=desired.get(key):raise ConfigError('凭证项 '+key+' 已改变，请重新读取核对',409)
   operations[key]=desired.get(key)
 return render(bindings,operations) if operations else (raw or b'')

def execute(body,path,state):
 path=Path(path)
 if path.name!='.env':raise ConfigError('凭证文件路径不正确')
 with config_lock(state):
  try:raw,_=read_file(path)
  except FileNotFoundError:raw=None
  bindings,current=parse(raw or b'');revision=checksum(raw) if raw is not None else 'missing'
  action=body.get('action');operations={}
  if action=='replace_changes':
   _,before=parse(body.get('before',''));_,after=parse(body.get('after',''))
   for key in sorted(set(before)|set(after)):
    if before.get(key)!=after.get(key) or (key in before)!=(key in after):
     if current.get(key)!=before.get(key) and current.get(key)!=after.get(key):raise ConfigError('凭证项 '+key+' 已改变，请重新读取核对',409)
     operations[key]=after.get(key)
  elif action in ('set','remove'):
   key=body.get('key')
   if not isinstance(key,str) or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*',key):raise ConfigError('凭证变量名不正确')
   if body.get('revision') is not None and body['revision']!=revision:raise ConfigError('凭证文件已改变，请重新读取核对',409)
   value=body.get('value') if action=='set' else None
   if action=='set':quote(value)
   operations[key]=value
  else:raise ConfigError('凭证操作不存在',404)
  encoded=render(bindings,operations);found=any(key in current for key in operations)
  if encoded==(raw or b''):return {'ok':True,'changed':False,'found':found,'revision':revision}
  parse(encoded)
  if raw is None:
   # Imported lazily: creation uses the same no-replace publication as YAML.
   try:from _hermes_panel_native_config import create_missing
   except ImportError:from panel_native_config import create_missing
   create_missing(path,state,encoded);result={'changed':True,'revision':checksum(encoded)}
  else:result=commit(path,state,raw,encoded,'environment '+action,{'keys':sorted(operations)})
  return {'ok':True,'found':found,**result}

if __name__=='__main__':
 try:print(json.dumps(execute(json.load(sys.stdin),sys.argv[1],sys.argv[2]),ensure_ascii=False))
 except Exception as error:
  print(json.dumps({'ok':False,'error':str(error) if isinstance(error,ConfigError) else '凭证保存未收到确认，请重新读取核对','status':getattr(error,'status',500)},ensure_ascii=False));sys.exit(1)
