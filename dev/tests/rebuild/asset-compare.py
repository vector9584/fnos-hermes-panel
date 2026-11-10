"""Compare hash inventories without inferring causes or equating counts with preservation."""
import argparse,json
from pathlib import Path

REQUIRED_ROOTS=('skills','knowledge','panel_sessions','cron','memories','profiles','memory','task_state','pending_messages','patch_scripts','runtime_ui','runtime_server','runtime_python','panel_state')

def compare(before,after):
 if not isinstance(before,dict) or not isinstance(after,dict):return unavailable('file_inventory_missing')
 result={'unchanged':0,'changed':[],'missing':[],'added':[],'unverifiable':[],'metadata_changed':[],'metadata_unverifiable':[]}
 for name,old in before.items():
  new=after.get(name)
  if new is None:result['missing'].append(name)
  elif not isinstance(old,dict) or not isinstance(new,dict) or old.get('error') or new.get('error') or old.get('stable') is False or new.get('stable') is False or not old.get('sha256') or not new.get('sha256'):result['unverifiable'].append(name)
  else:
   if old['sha256']==new['sha256']:result['unchanged']+=1
   else:result['changed'].append(name)
  if new is not None:
   metadata=('mode','uid','gid','nlink','acl_sha256')
   reliable=isinstance(old,dict) and isinstance(new,dict) and not old.get('error') and not new.get('error') and old.get('stable') is not False and new.get('stable') is not False
   if reliable and any(key in old and key in new and old[key] is not None and new[key] is not None and old[key]!=new[key] for key in metadata):result['metadata_changed'].append(name)
   if not reliable or any(key not in old or key not in new or old[key] is None or new[key] is None for key in metadata):result['metadata_unverifiable'].append(name)
 result['added']=sorted(set(after)-set(before));return result
def compare_rows(before,after):
 result={'unchanged':0,'changed':[],'missing':[],'added':sorted(set(after)-set(before)),'unverifiable':[],'metadata_changed':[],'metadata_unverifiable':[]}
 for name,old in before.items():
  if name not in after:result['missing'].append(name)
  elif old==after[name]:result['unchanged']+=1
  else:result['changed'].append(name)
 return result
def compare_directories(before,after):
 if not isinstance(before,dict) or not isinstance(after,dict):return unavailable('directory_inventory_missing')
 result={'unchanged':0,'changed':[],'missing':[],'added':sorted(set(after)-set(before)),'unverifiable':[],'metadata_changed':[],'metadata_unverifiable':[]}
 for name,old in before.items():
  new=after.get(name)
  if new is None:result['missing'].append(name);continue
  reliable=isinstance(old,dict) and isinstance(new,dict) and not old.get('error') and not new.get('error') and old.get('stable') is not False and new.get('stable') is not False
  if not reliable:result['unverifiable'].append(name)
  else:result['unchanged']+=1
  metadata=('mode','uid','gid','acl_sha256')
  if reliable and any(key in old and key in new and old[key] is not None and new[key] is not None and old[key]!=new[key] for key in metadata):result['metadata_changed'].append(name)
  if not reliable or any(key not in old or key not in new or old[key] is None or new[key] is None for key in metadata):result['metadata_unverifiable'].append(name)
 return result
def compare_database_rows(before,after):
 if before is None or after is None:return {'status':'unverifiable','reason':'row_hashes_missing','changed':[],'missing':[],'added':[],'unchanged':0}
 return {'status':'compared',**compare_rows(before,after)}

def compare_hardlinks(before,after):
 old=(before or {}).get('groups') if isinstance(before,dict) else None
 new=(after or {}).get('groups') if isinstance(after,dict) else None
 if not isinstance(old,list) or not isinstance(new,list):
  return {'status':'unverifiable','reason':'hardlink_groups_missing','changed':[],'before':old,'after':new}
 def normalize(groups):
  normalized=[];seen=set()
  for group in groups:
   if not isinstance(group,list) or len(group)<2 or any(not isinstance(path,str) or not path for path in group):return None
   members=tuple(sorted(set(group)))
   if len(members)!=len(group) or seen.intersection(members):return None
   seen.update(members);normalized.append(members)
  return sorted(normalized)
 old_norm,new_norm=normalize(old),normalize(new)
 if old_norm is None or new_norm is None:
  return {'status':'unverifiable','reason':'invalid_hardlink_groups','changed':[],'before':old_norm,'after':new_norm}
 return {'status':'compared' if old_norm==new_norm else 'changed','before':old_norm,'after':new_norm,'changed':old_norm!=new_norm}

def unavailable(reason):
 return {'unchanged':0,'changed':[],'missing':[],'added':[],'unverifiable':[],'metadata_changed':[],'metadata_unverifiable':[],'status':'unverifiable','reason':reason}

def records(value,key):
 if not isinstance(value,dict):return None
 rows=value.get(key)
 return rows if isinstance(rows,dict) else None

def compare_root(before,after):
 if not isinstance(before,dict) or not isinstance(after,dict):return unavailable('root_inventory_missing')
 if before.get('error') or after.get('error'):return unavailable('root_inventory_unreadable')
 if not isinstance(before.get('errors'),list) or not isinstance(after.get('errors'),list):return unavailable('walk_error_inventory_missing')
 if before['errors'] or after['errors']:
  result=unavailable('walk_errors_present');result['before_walk_errors']=before['errors'];result['after_walk_errors']=after['errors'];return result
 old=before.get('files');new=after.get('files')
 if not isinstance(old,dict) or not isinstance(new,dict):return unavailable('file_inventory_missing')
 if not isinstance(before.get('directories'),dict) or not isinstance(after.get('directories'),dict):return unavailable('directory_inventory_missing')
 if not isinstance(before.get('hardlink_groups'),list) or not isinstance(after.get('hardlink_groups'),list):return unavailable('root_hardlink_inventory_missing')
 result=compare(old,new)
 result['directories']=compare_directories(before.get('directories'),after.get('directories'))
 result['hardlinks']=compare_hardlinks({'groups':before['hardlink_groups']},{'groups':after['hardlink_groups']})
 return result

def compare_echo(before,after):
 def indexed(snapshot):
  if not isinstance(snapshot,dict) or not isinstance(snapshot.get('records'),list):return None,'echo_records_missing'
  records_list=snapshot['records'];count=snapshot.get('count')
  if not isinstance(count,int) or isinstance(count,bool) or count!=len(records_list):return None,'echo_record_count_mismatch'
  indexed={}
  for record in records_list:
   if not isinstance(record,dict):return None,'invalid_echo_record'
   identifier=record.get('id');digest=record.get('sha256')
   if isinstance(identifier,bool) or not isinstance(identifier,(str,int)) or not str(identifier):return None,'invalid_echo_id'
   key=str(identifier)
   if key in indexed:return None,'duplicate_echo_id'
   if not isinstance(digest,str) or len(digest)!=64 or any(char not in '0123456789abcdef' for char in digest):return None,'invalid_echo_record_hash'
   indexed[key]=record
  return indexed,None
 old,old_error=indexed(before);new,new_error=indexed(after)
 if old_error or new_error:return unavailable(old_error or new_error)
 return compare(old,new)

def database_count(db,table):
 if not isinstance(db,dict):return None
 value=db.get(table)
 if not isinstance(value,dict) or not isinstance(value.get('count'),int):return None
 return value['count']

def compare_table_rows(before,after,table):
 old_table=before.get(table) if isinstance(before,dict) else None
 new_table=after.get(table) if isinstance(after,dict) else None
 old=old_table.get('row_hashes') if isinstance(old_table,dict) else None
 new=new_table.get('row_hashes') if isinstance(new_table,dict) else None
 if not isinstance(old,dict):old=None
 if not isinstance(new,dict):new=None
 old_count=database_count(before,table);new_count=database_count(after,table)
 if old is None or new is None:return {'status':'unverifiable','reason':'database_row_hashes_missing','changed':[],'missing':[],'added':[],'unchanged':0}
 if old_count is None or new_count is None or old_count!=len(old) or new_count!=len(new):
  return {'status':'unverifiable','reason':'database_row_count_mismatch','changed':[],'missing':[],'added':[],'unchanged':0,'before_count':old_count,'before_hashes':len(old),'after_count':new_count,'after_hashes':len(new)}
 if any(not isinstance(key,str) or not isinstance(value,str) or len(value)!=64 or any(char not in '0123456789abcdef' for char in value) for rows in (old,new) for key,value in rows.items()):
  return {'status':'unverifiable','reason':'invalid_database_row_hash','changed':[],'missing':[],'added':[],'unchanged':0}
 return {'status':'compared',**compare_rows(old,new)}

def report(baseline,extended,echo,current):
 before_roots=baseline.get('roots',{}) if isinstance(baseline,dict) else {}
 now_roots=current.get('roots',{}) if isinstance(current,dict) else {}
 result={'scope':'read-only comparison with earlier audit; no deployment has occurred; changes have not been attributed','roots':{},
         'critical':compare(baseline.get('critical',{}),current.get('critical',{})) if isinstance(baseline,dict) and isinstance(current,dict) and isinstance(baseline.get('critical'),dict) and isinstance(current.get('critical'),dict) else unavailable('critical_inventory_missing')}
 result['hardlinks']=compare_hardlinks(baseline.get('hardlinks') if isinstance(baseline,dict) else None,current.get('hardlinks') if isinstance(current,dict) else None)
 for name in sorted(set(REQUIRED_ROOTS)|set(before_roots)|set(now_roots)):
  old_root=before_roots.get(name);new_root=now_roots.get(name)
  if old_root is None:result['roots'][name]=unavailable('baseline_root_missing')
  elif new_root is None:result['roots'][name]=unavailable('current_root_missing')
  else:result['roots'][name]=compare_root(old_root,new_root)
 extended=extended if isinstance(extended,dict) else {}
 for name in ['profiles','memory','task_state','pending_messages']:
  if name not in result['roots']:
   current_root=now_roots.get(name)
   result['roots'][name]=compare_root({'files':extended.get(name,{})},current_root)
 extra=extended.get('extra_files',{})
 critical_now=current.get('critical',{}) if isinstance(current,dict) else {}
 result['extra_files']=compare(extra,{k:v for k,v in critical_now.items() if k in extra}) if isinstance(extra,dict) and isinstance(critical_now,dict) else unavailable('extra_file_inventory_missing')
 result['echo']=compare_echo(echo,current.get('echo') if isinstance(current,dict) else None)
 result['counts']={name:{'before':len(before_roots.get(name,{}).get('files',{})) if isinstance(before_roots.get(name),dict) and isinstance(before_roots.get(name,{}).get('files'),dict) else None,
                                'now':len(now_roots.get(name,{}).get('files',{})) if isinstance(now_roots.get(name),dict) and isinstance(now_roots.get(name,{}).get('files'),dict) else None}
                   for name in result['roots']}
 before_db=baseline.get('db') if isinstance(baseline,dict) else None;now_db=current.get('db') if isinstance(current,dict) else None
 result['database_counts']={table:{'before':database_count(before_db,table),'now':database_count(now_db,table)} for table in ['sessions','messages']}
 result['database_rows']={table:compare_table_rows(before_db,now_db,table) for table in ['sessions','messages']}
 result['coverage_gaps']=['Earlier SQLite baseline has counts, not row hashes; cannot prove old rows preserved from counts.','Live files are hashed independently; this is not an atomic cross-file backup.','Missing roots, symlinks, read errors and files changing during read require separate review.','ACL metadata is unverifiable when getfacl is unavailable or denied; do not interpret this as unchanged.','Production before/after deployment and restore evidence remains required.']
 result['root_coverage']={'required':list(REQUIRED_ROOTS),'baseline_missing':sorted(set(REQUIRED_ROOTS)-set(before_roots)),'current_missing':sorted(set(REQUIRED_ROOTS)-set(now_roots)),'baseline_extra':sorted(set(before_roots)-set(REQUIRED_ROOTS)),'current_extra':sorted(set(now_roots)-set(REQUIRED_ROOTS))}
 result['read_issues']={}
 for name,root in now_roots.items():
  if not isinstance(root,dict):result['read_issues'][name]={'root_error':'invalid_inventory'};continue
  files=root.get('files',{}) if isinstance(root.get('files'),dict) else {};directories=root.get('directories',{}) if isinstance(root.get('directories'),dict) else {}
  file_issues=[p for p,r in files.items() if not isinstance(r,dict) or r.get('error') or r.get('stable') is False or r.get('kind')!='file']
  directory_issues=[p for p,r in directories.items() if not isinstance(r,dict) or r.get('error') or r.get('stable') is False or r.get('kind')!='directory']
  if root.get('error') or root.get('errors') or file_issues or directory_issues:
   result['read_issues'][name]={'root_error':root.get('error'),'walk_errors':root.get('errors',[]),'file_issues':file_issues,'directory_issues':directory_issues}
 return result
if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('baseline');parser.add_argument('extended');parser.add_argument('echo');parser.add_argument('current');args=parser.parse_args()
 print(json.dumps(report(*[json.loads(Path(getattr(args,key)).read_text()) for key in ['baseline','extended','echo','current']]),ensure_ascii=False,indent=2))
