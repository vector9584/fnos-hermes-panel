"""Serialized VAR drain record mutations shared by Monitor and fnOS stop."""
import contextlib,fcntl,json,os,sys,time,uuid
from pathlib import Path

class DrainStoreError(Exception):pass

@contextlib.contextmanager
def locked_record(path):
 path=Path(path);path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
 fd=os.open(path.with_name('gateway-drain.lock'),os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'r+') as lock:
  deadline=time.monotonic()+2
  while True:
   try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);break
   except BlockingIOError:
    if time.monotonic()>=deadline:raise DrainStoreError('排空状态正在更新，请稍后重试')
    time.sleep(.02)
  if path.is_symlink():raise DrainStoreError('排空记录是链接，未修改原文件')
  raw=path.read_bytes() if path.exists() else None
  if raw is not None:
   if len(raw)>8192:raise DrainStoreError('排空记录过大，已保留原文件')
   try:record=json.loads(raw)
   except (ValueError,UnicodeError):raise DrainStoreError('排空记录无法读取，已保留原文件')
   if not isinstance(record,dict):raise DrainStoreError('排空记录格式不正确，已保留原文件')
  else:record=None
  yield record

def write_record(path,record):
 path=Path(path);temp=path.with_name('.gateway-drain-'+uuid.uuid4().hex)
 fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 try:
  with os.fdopen(fd,'w') as stream:json.dump(record,stream);stream.flush();os.fsync(stream.fileno())
  os.replace(temp,path)
  fd=os.open(path.parent,os.O_RDONLY)
  try:os.fsync(fd)
  finally:os.close(fd)
 finally:
  if temp.exists():temp.unlink()

def mutate(path,body):
 with locked_record(path) as record:
  action=body['action'];identifier=body['id'];now=body.get('now',time.time()*1000)
  if action=='begin':
   lease=body['lease']
   owner=(record or {}).get('stop_owner')
   if isinstance(owner,dict):
    try:
     fields=(Path('/proc')/str(owner['pid'])/'stat').read_text().rsplit(')',1)[1].split()
     if fields[0] not in ('Z','X') and fields[19]==str(owner.get('start')):raise DrainStoreError('应用停止操作仍在执行，不能替换排空记录')
    except (OSError,ValueError,KeyError,IndexError):pass
   if record and record.get('expires_at',0)>now and record.get('id')!=identifier:raise DrainStoreError('已有另一次重启正在排空任务')
   write_record(path,lease)
  elif action=='dispatch':
   identity=body['identity']
   if not record or record.get('id')!=identifier or record.get('phase')!='preparing' or record.get('pid')!=identity.get('pid') or record.get('start')!=identity.get('start') or record.get('expires_at',0)-now<30000:raise DrainStoreError('排空确认已失效，尚未执行重启')
   record['phase']='dispatched';write_record(path,record)
  elif action=='release':
   if record and record.get('id')==identifier:
    if record.get('phase') in ('dispatched','cancelled') or record.get('stop_owner'):
     record['phase']='cancelled';write_record(path,record)
    else:Path(path).unlink()
  else:raise DrainStoreError('排空操作不存在')
 return {'ok':True}

if __name__=='__main__':
 try:print(json.dumps(mutate(sys.argv[1],json.load(sys.stdin)),ensure_ascii=False))
 except DrainStoreError as error:print(json.dumps({'ok':False,'error':str(error)},ensure_ascii=False));sys.exit(1)
 except Exception:print(json.dumps({'ok':False,'error':'排空状态未能更新，原记录已保留'},ensure_ascii=False));sys.exit(1)
