"""Read-only asset evidence. No application imports, config values or message text in output.
Run with -B and HOME=/tmp. SQLite read transaction provides internally consistent row hashes.
File snapshots are per-file, not a globally atomic live-NAS backup.
"""
import argparse,collections,hashlib,json,os,shutil,sqlite3,stat,subprocess,time
from pathlib import Path

def digest(value):
 return hashlib.sha256(json.dumps(value,sort_keys=True,ensure_ascii=False,separators=(',',':'),default=lambda v:{'bytes':v.hex()}).encode()).hexdigest()
def acl_record(path):
 getfacl=shutil.which('getfacl')
 if not getfacl:return {'acl_sha256':None,'acl_error':'unavailable'}
 try:
  result=subprocess.run([getfacl,'-cpn','--',str(path)],capture_output=True,text=True,timeout=5,check=True)
  return {'acl_sha256':hashlib.sha256(result.stdout.encode()).hexdigest(),'acl_error':None}
 except (OSError,subprocess.SubprocessError):return {'acl_sha256':None,'acl_error':'unavailable'}
def fs_signature(info):
 return (info.st_dev,info.st_ino,info.st_mode,info.st_uid,info.st_gid,info.st_nlink,info.st_size,info.st_mtime_ns,info.st_ctime_ns)
def directory_record(path):
 try:
  before=path.lstat()
  if not stat.S_ISDIR(before.st_mode):return {'kind':'not_directory'}
  metadata=acl_record(path)
  after=path.lstat()
  same=fs_signature(before)==fs_signature(after)
  return {'kind':'directory','mode':stat.S_IMODE(after.st_mode),'uid':after.st_uid,'gid':after.st_gid,**metadata,'stable':same}
 except OSError as error:return {'error':type(error).__name__}
def file_record(path):
 try:
  before=path.lstat()
  if stat.S_ISLNK(before.st_mode):return {'kind':'symlink','target':os.readlink(path)}
  if not stat.S_ISREG(before.st_mode):return {'kind':'special','mode':stat.S_IMODE(before.st_mode)}
  descriptor=os.open(path,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0))
  opened=os.fstat(descriptor)
  if (before.st_dev,before.st_ino)!=(opened.st_dev,opened.st_ino):
   os.close(descriptor);return {'kind':'file','error':'changed_before_read'}
  h=hashlib.sha256()
  with os.fdopen(descriptor,'rb') as stream:
   for chunk in iter(lambda:stream.read(1024*1024),b''):h.update(chunk)
   after=os.fstat(stream.fileno())
  metadata=acl_record(path);path_info=path.lstat()
  stable=fs_signature(opened)==fs_signature(after)==fs_signature(path_info)
  return {'kind':'file','sha256':h.hexdigest(),'size':after.st_size,'mtime_ns':after.st_mtime_ns,'mode':stat.S_IMODE(after.st_mode),'uid':after.st_uid,'gid':after.st_gid,'device':after.st_dev,'inode':after.st_ino,'nlink':after.st_nlink,'hardlinked':after.st_nlink>1,**metadata,'stable':stable}
 except OSError as error:return {'error':type(error).__name__}
def tree(root):
 if root.is_symlink():return {'error':'root_is_symlink','files':{},'directories':{},'hardlink_groups':[],'errors':[]}
 if not root.exists():return {'error':'missing_root','files':{},'directories':{},'hardlink_groups':[],'errors':[]}
 files={};directories={};errors=[];links={}
 def fail(error):errors.append({'path':str(Path(error.filename).relative_to(root)),'error':type(error).__name__})
 for base,dirs,names in os.walk(root,followlinks=False,onerror=fail):
  base_path=Path(base);relative='.' if base_path==root else str(base_path.relative_to(root));directories[relative]=directory_record(base_path)
  dirs[:]=[n for n in dirs if n not in {'.git','node_modules','__pycache__'}]
  for name in list(dirs):
   path=Path(base)/name
   if path.is_symlink():files[str(path.relative_to(root))]=file_record(path);dirs.remove(name)
  for name in names:
   path=Path(base)/name;relative=str(path.relative_to(root));record=file_record(path);files[relative]=record
   if record.get('kind')=='file' and not record.get('error') and record.get('stable'):
    if record.get('nlink',0)>1:links.setdefault((record.get('device'),record.get('inode')),[]).append(relative)
 hardlinks=sorted((sorted(paths) for paths in links.values() if len(paths)>1),key=lambda paths:paths[0])
 return {'files':files,'directories':directories,'hardlink_groups':hardlinks,'errors':errors}
def database(path):
 try:
  before=path.lstat()
  if stat.S_ISLNK(before.st_mode):return {'error':'symlink_database'}
  if not stat.S_ISREG(before.st_mode):return {'error':'invalid_database_file'}
 except FileNotFoundError:return {'error':'missing_database'}
 except OSError as error:return {'error':type(error).__name__}
 descriptor=None;connection=None
 try:
  descriptor=os.open(path,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0))
  opened=os.fstat(descriptor)
  if fs_signature(before)!=fs_signature(opened):return {'error':'changed_before_read'}
  connection=sqlite3.connect(path.as_uri()+'?mode=ro',uri=True,timeout=10)
  connected=path.lstat()
  if fs_signature(connected)!=fs_signature(opened):return {'error':'changed_during_read'}
  connection.execute('PRAGMA query_only=ON');connection.execute('BEGIN');result={}
  for table in ['sessions','messages']:
   columns=[row[1] for row in connection.execute('PRAGMA table_info('+table+')')]
   if 'id' not in columns:return {'error':'invalid_database_schema'}
   rows=connection.execute('SELECT * FROM '+table+' ORDER BY id');hashes={};aggregate=hashlib.sha256();count=0
   for row in rows:
    hashed=digest(row);aggregate.update(hashed.encode());count+=1
    row_id=str(row[columns.index('id')])
    if row_id in hashes:return {'error':'duplicate_database_id'}
    hashes[row_id]=hashed
   result[table]={'count':count,'columns':columns,'rows_sha256':aggregate.hexdigest()}
   result[table]['row_hashes']=hashes
  result['sources']=connection.execute('SELECT source,count(*) FROM sessions GROUP BY source').fetchall();connection.rollback()
  after=os.fstat(descriptor);current=path.lstat()
  if fs_signature(opened)!=fs_signature(after) or (current.st_dev,current.st_ino)!=(opened.st_dev,opened.st_ino):return {'error':'changed_during_read'}
  if fs_signature(current)!=fs_signature(opened):return {'error':'changed_during_read'}
  return result
 except Exception as error:return {'error':type(error).__name__}
 finally:
  if connection is not None:
   try:connection.rollback()
   except sqlite3.Error:pass
   connection.close()
  if descriptor is not None:os.close(descriptor)

def echo_inventory(path):
 result={'file':file_record(path)}
 descriptor=None
 try:
  descriptor=os.open(path,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0)|getattr(os,'O_NONBLOCK',0))
  opened=os.fstat(descriptor)
  if not stat.S_ISREG(opened.st_mode):raise ValueError('not_regular_file')
  chunks=[]
  while True:
   chunk=os.read(descriptor,1024*1024)
   if not chunk:break
   chunks.append(chunk)
  after=os.fstat(descriptor);current=path.lstat();raw=b''.join(chunks)
  stable=fs_signature(opened)==fs_signature(after)==fs_signature(current)
  if not stable or len(raw)!=after.st_size:raise ValueError('changed_during_read')
  if result['file'].get('kind')!='file' or result['file'].get('sha256')!=hashlib.sha256(raw).hexdigest() or not result['file'].get('stable'):raise ValueError('changed_between_inventory_and_read')
  doc=json.loads(raw);tasks=doc['tasks']
  if not isinstance(tasks,list):raise ValueError('invalid_tasks')
  result.update({'sha256':hashlib.sha256(raw).hexdigest(),'count':len(tasks),'entries':sum(len(t.get('entries',[])) for t in tasks if isinstance(t,dict)),'events':sum(len(t.get('events',[])) for t in tasks if isinstance(t,dict)),'status_counts':dict(collections.Counter(t.get('status') for t in tasks if isinstance(t,dict))),'records':[{'id':t.get('id'),'sha256':hashlib.sha256(json.dumps(t,sort_keys=True,ensure_ascii=False).encode()).hexdigest()} for t in tasks if isinstance(t,dict)]})
  if len(result['records'])!=len(tasks):raise ValueError('invalid_task_record')
 except Exception as error:result['error']=str(error) if isinstance(error,ValueError) and str(error) in {'not_regular_file','changed_during_read','changed_between_inventory_and_read','invalid_tasks','invalid_task_record'} else type(error).__name__
 finally:
  if descriptor is not None:os.close(descriptor)
 return result
def collect(data,var,app,echo):
 roots={'skills':data/'skills','knowledge':data/'knowledge','panel_sessions':var/'chat/sessions','cron':data/'cron','memories':data/'memories','profiles':data/'profiles','memory':data/'memory','task_state':data/'task_state','pending_messages':data/'pending_messages','patch_scripts':data/'scripts/patches','runtime_ui':app/'ui','runtime_server':app/'server','runtime_python':app/'hermes-src','panel_state':var/'panel-state'}
 result={'version':1,'captured_at':time.time(),'scope':'per-file read-only live snapshot; not an atomic backup or proof of post-deploy preservation','roots':{key:tree(root) for key,root in roots.items()}}
 hardlinks={}
 for root_name,inventory in result['roots'].items():
  for name,record in inventory.get('files',{}).items():
   if record.get('kind')=='file' and record.get('stable') and record.get('nlink',0)>1:
    hardlinks.setdefault((record.get('device'),record.get('inode')),[]).append(root_name+'/'+name)
 result['hardlinks']={'groups':sorted((sorted(paths) for paths in hardlinks.values() if len(paths)>1),key=lambda paths:paths[0])}
 critical=[data/n for n in ['SOUL.md','config.yaml','.env','.env.providers','.tts_token','auth.json','panel-workspace.json','rooms.json']]+[var/n for n in ['chat/config.json','experts-overrides.json','extensions.json','providers-state.yaml','provider-models.json']]+[app/'cmd/main',app/'hermes-src/.git',app/'hot-patch.json']
 result['critical']={str(p):file_record(p) for p in critical};result['db']=database(data/'state.db');result['echo']=echo_inventory(echo)
 result['completed_at']=time.time();return result
if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--data',default='/vol1/@apphome/hermes-agent/data');parser.add_argument('--var',default='/vol1/@appdata/hermes-agent');parser.add_argument('--app',default='/vol1/@appcenter/hermes-agent');parser.add_argument('--echo',default='/vol1/1000/飞牛文件/html/.acl/tasks/tasks.json');args=parser.parse_args()
 print(json.dumps(collect(*[Path(getattr(args,k)).absolute() for k in ['data','var','app','echo']]),ensure_ascii=False,indent=2))
