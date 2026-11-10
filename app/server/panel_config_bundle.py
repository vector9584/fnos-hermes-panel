"""Recoverable config.yaml + .env publication, always under config_lock.

No claim of atomic visibility across two filenames. A durable journal makes
interrupted publication finishable before the next cooperating config write.
Recovery refuses to overwrite any post-journal change made by another writer.
"""
import json,os,re,stat,tempfile,time,uuid
from pathlib import Path
# Assigned by the shared transaction loader to avoid duplicate exception/module
# identities when the native bridge loads files by absolute path.
from panel_config_txn import ConfigError,checksum,read_file

def sync_dir(path):
 fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY)
 try:os.fsync(fd)
 finally:os.close(fd)

def private_write(path,raw):
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'wb') as stream:stream.write(raw);stream.flush();os.fsync(stream.fileno())

def state_write(path,value):
 fd,temp=tempfile.mkstemp(prefix='.journal-',dir=path.parent)
 try:
  with os.fdopen(fd,'w') as stream:json.dump(value,stream,ensure_ascii=False);stream.flush();os.fsync(stream.fileno())
  os.replace(temp,path);sync_dir(path.parent)
 finally:
  if os.path.exists(temp):os.unlink(temp)

def current(path):
 try:raw,meta=read_file(path);return raw,meta
 except FileNotFoundError:return None,None

def publish(path,encoded,before,metadata):
 existing,st=current(path)
 if existing!=before:raise ConfigError('配置在提交期间改变，请重新读取核对',409)
 if before is not None and metadata and (st.st_dev,st.st_ino)!=(metadata.st_dev,metadata.st_ino):raise ConfigError('配置文件在提交期间被替换，请重新读取核对',409)
 if encoded is None:
  if st:
   latest,latest_st=current(path)
   if latest!=before or (latest_st.st_dev,latest_st.st_ino)!=(st.st_dev,st.st_ino):raise ConfigError('配置在恢复期间改变，请重新读取核对',409)
   os.unlink(path);sync_dir(path.parent)
  return
 fd,temp=tempfile.mkstemp(prefix='.panel-bundle-',dir=path.parent)
 try:
  with os.fdopen(fd,'wb') as stream:
   if st:
    os.fchmod(stream.fileno(),stat.S_IMODE(st.st_mode))
    if (st.st_uid,st.st_gid)!=(os.getuid(),os.getgid()):os.fchown(stream.fileno(),st.st_uid,st.st_gid)
   stream.write(encoded);stream.flush();os.fsync(stream.fileno())
  latest,latest_st=current(path)
  if latest!=before or (st is not None and (latest_st.st_dev,latest_st.st_ino)!=(st.st_dev,st.st_ino)):raise ConfigError('配置在提交期间改变，请重新读取核对',409)
  if st:os.replace(temp,path)
  else:
   try:os.link(temp,path)
   except FileExistsError:raise ConfigError('配置文件已被创建，请重新读取核对',409)
   os.unlink(temp)
  sync_dir(path.parent)
 finally:
  if os.path.exists(temp):os.unlink(temp)

def validate_targets(entries):
 paths=[Path(item['path']) for item in entries]
 if not paths or len(paths)>3 or len(set(paths))!=len(paths) or len({p.parent for p in paths})!=1 or any(not p.is_absolute() or p.name not in {'.env','config.yaml','auth.json'} for p in paths):raise ConfigError('配置事务目标不正确，已保留待恢复记录',503)
 for path in paths:
  for part in [path,*path.parents]:
   if part.is_symlink():raise ConfigError('配置事务目标包含链接，已保留待恢复记录',503)

def payload(directory,item,index,side,prefix=''):
 digest=item[side]
 if digest is None:return None
 raw,_=read_file(directory/(prefix+str(index)+'.'+side))
 if checksum(raw)!=digest:raise ConfigError('配置事务校验失败，已保留原文件和恢复记录',503)
 return raw

def active_plan(record):return record.get('resolution') or record

def apply_journal(directory,record,*,after_publish=None):
 plan=active_plan(record);entries=plan['entries'];validate_targets(entries)
 prefix=plan.get('prefix','')
 if prefix and not re.fullmatch(r'resolution-[a-f0-9]{32}-',prefix):raise ConfigError('配置恢复文件名不正确',503)
 # Validate all targets and payload checksums BEFORE writing any of them.
 pending=[]
 for index,item in enumerate(entries):
  path=Path(item['path']);raw,meta=current(path);digest=checksum(raw) if raw is not None else None
  encoded=payload(directory,item,index,'after',prefix)
  if digest==item['after']:continue
  if digest!=item['before']:raise ConfigError('配置事务恢复发现其他修改，已停止覆盖并保留记录',409)
  pending.append((index,path,encoded,raw,meta))
 for index,path,encoded,raw,meta in pending:
  publish(path,encoded,raw,meta)
  if after_publish:after_publish(index)
 record['status']='resolved' if record.get('resolution') else 'committed';record['completed_at']=int(time.time()*1000);state_write(directory/'journal.json',record)
 return {'ok':True,'changed':True,'change_id':record['id'],'recovered':bool(record.get('recovering'))}

def pending_record(root):
 root=Path(root);pointer=root/'config-bundle-pending.json'
 if not pointer.exists():return None
 raw,_=read_file(pointer)
 try:identifier=json.loads(raw)['id']
 except Exception:raise ConfigError('配置恢复指针无法解析，已保留原文件',503)
 if not isinstance(identifier,str) or not re.fullmatch(r'[0-9]+-[a-f0-9]{32}',identifier):raise ConfigError('配置恢复指针不正确',503)
 directory=root/'config-bundles'/identifier;raw,_=read_file(directory/'journal.json')
 try:record=json.loads(raw)
 except Exception:raise ConfigError('配置恢复记录无法解析，已保留原文件',503)
 if record.get('id')!=identifier or record.get('status') not in ('prepared','committed','resolved'):raise ConfigError('配置恢复记录状态不正确',503)
 validate_targets(record['entries'])
 if record.get('resolution'):
  validate_targets(record['resolution']['entries'])
  if [item['path'] for item in record['entries']]!=[item['path'] for item in record['resolution']['entries']]:raise ConfigError('配置恢复目标与原记录不符',503)
 return directory,record

def recover_pending(root):
 root=Path(root);pending=pending_record(root)
 if not pending:return
 directory,record=pending
 if record['status']=='prepared':record['recovering']=True;apply_journal(directory,record)
 (root/'config-bundle-pending.json').unlink();sync_dir(root)

def inspect_pending(root,allowed_parents):
 pending=pending_record(root)
 if not pending:return {'ok':True,'pending':None}
 directory,record=pending;allowed={str(Path(p).absolute()) for p in allowed_parents}
 if any(str(Path(item['path']).parent) not in allowed for item in record['entries']):raise ConfigError('待恢复配置不属于当前应用环境，请核对维护目录',403)
 files=[];digests=[]
 for index,item in enumerate(record['entries']):
  # Verify the restore material before presenting any action. No contents or
  # key names are sent to the browser: both YAML and dotenv can contain secrets.
  payload(directory,item,index,'before');payload(directory,item,index,'after')
  raw,_=current(Path(item['path']));digest=checksum(raw) if raw is not None else None;digests.append(digest)
  state='after' if digest==item['after'] else 'before' if digest==item['before'] else 'external'
  files.append({'name':Path(item['path']).name,'state':state,'exists':raw is not None,'before_exists':item['before'] is not None,'current_hash':digest,'before_hash':item['before'],'after_hash':item['after']})
 revision=checksum(json.dumps([record,digests],sort_keys=True,ensure_ascii=False).encode())
 return {'ok':True,'pending':{'id':record['id'],'revision':revision,'created_at':record['created_at'],'status':record['status'],'files':files,'has_external_changes':any(item['state']=='external' for item in files),'resolution_started':bool(record.get('resolution'))}}

def resolve_pending(root,allowed_parents,body,*,after_publish=None):
 view=inspect_pending(root,allowed_parents)['pending']
 if not view:raise ConfigError('没有待处理的配置保存，请刷新状态',409)
 if body.get('id')!=view['id'] or body.get('revision')!=view['revision']:raise ConfigError('配置或恢复记录已变化，请重新核对后处理',409)
 choice=body.get('choice')
 if choice not in ('finish','rollback','keep'):raise ConfigError('请选择完成保存、恢复保存前或保留当前文件')
 if view['has_external_changes'] and choice!='keep':raise ConfigError('存在后来的修改，请先保留当前文件，再在设置中重新编辑；不会覆盖后来的修改',409)
 directory,record=pending_record(root);prefix='resolution-'+uuid.uuid4().hex+'-';entries=[]
 for index,item in enumerate(record['entries']):
  path=Path(item['path']);raw,_=current(path)
  if (checksum(raw) if raw is not None else None)!=view['files'][index]['current_hash']:raise ConfigError('配置在核对后再次变化，请刷新后处理',409)
  desired=raw if choice=='keep' else payload(directory,item,index,'after' if choice=='finish' else 'before')
  if raw is not None:private_write(directory/(prefix+str(index)+'.before'),raw)
  if desired is not None:private_write(directory/(prefix+str(index)+'.after'),desired)
  entries.append({'path':str(path),'before':checksum(raw) if raw is not None else None,'after':checksum(desired) if desired is not None else None})
 if record.get('resolution'):record.setdefault('prior_resolutions',[]).append(record['resolution'])
 record['resolution']={'prefix':prefix,'choice':choice,'entries':entries,'created_at':int(time.time()*1000)};record['status']='prepared'
 state_write(directory/'journal.json',record)
 apply_journal(directory,record,after_publish=after_publish)
 (Path(root)/'config-bundle-pending.json').unlink();sync_dir(root)
 return {'ok':True,'changed':True,'choice':choice,'change_id':record['id'],'restart_required':True}

def commit_bundle(root,changes,reason,*,after_publish=None):
 """changes = [(absolute_path, exact_before_bytes_or_none, after_bytes)]."""
 changes=[entry for entry in changes if entry[1]!=entry[2]]
 if not changes:return {'ok':True,'changed':False}
 entries=[{'path':str(Path(path).absolute()),'before':checksum(before) if before is not None else None,'after':checksum(after)} for path,before,after in changes];validate_targets(entries)
 for path,before,after in changes:
  raw,_=current(path)
  if raw!=before:raise ConfigError('配置在准备保存期间改变，请重新读取核对',409)
 parent=Path(root)/'config-bundles';parent.mkdir(mode=0o700,parents=True,exist_ok=True)
 identifier=str(time.time_ns())+'-'+uuid.uuid4().hex;directory=parent/identifier;directory.mkdir(mode=0o700)
 for index,(_,before,after) in enumerate(changes):
  if before is not None:private_write(directory/(str(index)+'.before'),before)
  private_write(directory/(str(index)+'.after'),after)
 record={'version':1,'id':identifier,'reason':reason,'status':'prepared','created_at':int(time.time()*1000),'entries':entries}
 state_write(directory/'journal.json',record);sync_dir(parent)
 pointer=Path(root)/'config-bundle-pending.json'
 if pointer.exists():raise ConfigError('先前配置事务尚未恢复，拒绝新提交',409)
 state_write(pointer,{'id':identifier})
 result=apply_journal(directory,record,after_publish=after_publish)
 pointer.unlink();sync_dir(root)
 return result
