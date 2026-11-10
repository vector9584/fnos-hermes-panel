"""Verify a new Monitor incarnation after the official fnOS restart command."""
import json,os,re,secrets,stat,sys,time
from pathlib import Path
from panel_lifecycle import Lifecycle

def receipt_path(var,request_id):
 if not isinstance(request_id,str) or not re.fullmatch(r'[0-9a-f-]{36}',request_id):raise ValueError('invalid restart request id')
 return Path(var)/'panel-state/restart-receipts'/(request_id+'.json')

def open_receipt_dir(var,create=True):
 flags=os.O_RDONLY|os.O_DIRECTORY|getattr(os,'O_NOFOLLOW',0)
 raw_var=Path(var).absolute();var_path=raw_var.parent.resolve(strict=True)/raw_var.name
 fd=os.open('/',flags)
 try:
  for part in var_path.parts[1:]:
   next_fd=None
   try:next_fd=os.open(part,flags,dir_fd=fd)
   except FileNotFoundError:
    if not create:raise
    os.mkdir(part,0o700,dir_fd=fd);next_fd=os.open(part,flags,dir_fd=fd)
   os.close(fd);fd=next_fd
  for part in ('panel-state','restart-receipts'):
   try:next_fd=os.open(part,flags,dir_fd=fd)
   except FileNotFoundError:
    if not create:raise
    os.mkdir(part,0o700,dir_fd=fd);next_fd=os.open(part,flags,dir_fd=fd)
   os.close(fd);fd=next_fd
  return fd
 except BaseException:
  os.close(fd);raise

def read_receipt(var,request_id):
 name=receipt_path(var,request_id).name;directory=open_receipt_dir(var,False);fd=None
 try:
  fd=os.open(name,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0)|getattr(os,'O_NONBLOCK',0),dir_fd=directory)
  info=os.fstat(fd)
  if not stat.S_ISREG(info.st_mode) or info.st_size>65536:raise ValueError('invalid receipt file')
  with os.fdopen(fd,'r') as stream:
   fd=None;value=json.load(stream)
  if not isinstance(value,dict):raise ValueError('invalid receipt payload')
  return value
 finally:
  if fd is not None:os.close(fd)
  os.close(directory)

def finish(var,request_id,pid,start,exit_code,proc_root='/proc'):
 worker_pid=int(pid)
 if worker_pid<=0 or not re.fullmatch(r'\d+',start):raise ValueError('worker identity invalid')
 actual=Path(proc_root,str(worker_pid),'stat').read_text().rsplit(')',1)[1].split()[19]
 if actual!=start:raise ValueError('worker start identity mismatch')
 name=receipt_path(var,request_id).name;directory=open_receipt_dir(var,True);temp='.'+name+'.'+str(os.getpid())+'.'+secrets.token_hex(8)
 payload={'request_id':request_id,'worker':{'pid':int(pid),'start':start},'exit_code':int(exit_code),'finished_at':time.time()}
 fd=None
 try:
  fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,'O_NOFOLLOW',0),0o600,dir_fd=directory)
  with os.fdopen(fd,'w') as stream:fd=None;json.dump(payload,stream);stream.flush();os.fsync(stream.fileno())
  try:
   existing=os.open(name,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0)|getattr(os,'O_NONBLOCK',0),dir_fd=directory)
   try:
    if not stat.S_ISREG(os.fstat(existing).st_mode):raise ValueError('invalid receipt target')
   finally:os.close(existing)
  except FileNotFoundError:pass
  os.replace(temp,name,src_dir_fd=directory,dst_dir_fd=directory);os.fsync(directory)
 finally:
  if fd is not None:os.close(fd)
  try:os.unlink(temp,dir_fd=directory)
  except FileNotFoundError:pass
  os.close(directory)
 return payload

def capture(lifecycle):
 record=lifecycle.stored()
 return {'pid':record[0],'start':record[1]} if record else None

def observe(lifecycle,before):
 record=lifecycle.stored()
 if not record:return False
 if before and (record[0],record[1])==(before.get('pid'),before.get('start')):return False
 return lifecycle.health(record[0])

if __name__=='__main__':
 try:
  action,app,home,var,node,*extra=sys.argv[1:];lifecycle=Lifecycle(app,home,var,node)
  if action=='capture':print(json.dumps(capture(lifecycle)))
  elif action=='verify':
   before=json.loads(extra[0]);expected=int(extra[1]);record=lifecycle.stored()
   request_id=extra[2];worker=json.loads(extra[3]);receipt=read_receipt(var,request_id)
   saved_worker=receipt.get('worker') or {}
   worker_ok=(receipt.get('request_id')==request_id and receipt.get('exit_code')==0 and saved_worker.get('pid')==worker.get('pid') and saved_worker.get('start')==worker.get('start'))
   print(json.dumps({'verified':bool(worker_ok and record and record[0]==expected and before and observe(lifecycle,before))}))
  elif action=='finish':
   payload=finish(var,extra[0],extra[1],extra[2],extra[3],extra[4]);print(json.dumps({'finished':True,'request_id':payload['request_id'],'exit_code':payload['exit_code']}))
  elif action=='wait':
   before=json.loads(extra[0]);deadline=time.monotonic()+30
   while time.monotonic()<deadline:
    if observe(lifecycle,before):print('新的Monitor已通过进程身份与socket健康核验');break
    time.sleep(.25)
   else:print('未确认新的健康Monitor，重启未完成');sys.exit(1)
  else:sys.exit(1)
 except Exception:print('无法核实应用重启结果，请检查生命周期日志',file=sys.stderr);sys.exit(1)
