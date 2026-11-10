import importlib.util,tempfile,unittest,json,sqlite3,os
from unittest.mock import patch
from pathlib import Path
ROOT=Path(__file__).parent
spec=importlib.util.spec_from_file_location('inventory',ROOT/'asset-inventory.py');inventory=importlib.util.module_from_spec(spec);spec.loader.exec_module(inventory)
spec=importlib.util.spec_from_file_location('compare',ROOT/'asset-compare.py');comparison=importlib.util.module_from_spec(spec);spec.loader.exec_module(comparison)
class Assets(unittest.TestCase):
 def test_no_content_no_symlink_traversal_and_read_only_sqlite(self):
  with tempfile.TemporaryDirectory() as temporary:
   root=Path(temporary);data=root/'data';var=root/'var';app=root/'app';data.mkdir();(data/'skills').mkdir();secret='credential-and-private-message';(data/'.env').write_text(secret);(data/'skills/a.md').write_text('skill');(data/'skills/link').symlink_to(data,target_is_directory=True)
   with sqlite3.connect(data/'state.db') as c:
    c.executescript('CREATE TABLE sessions(id TEXT,source TEXT);CREATE TABLE messages(id INTEGER,content TEXT);');c.execute('INSERT INTO sessions VALUES (?,?)',('one','test'));c.execute('INSERT INTO messages VALUES (?,?)',(1,secret))
   before=inventory.file_record(data/'state.db')['sha256'];echo=root/'echo.json';echo.write_text(json.dumps({'tasks':[{'id':1,'text':secret}]}));result=inventory.collect(data,var,app,echo)
   self.assertNotIn(secret,json.dumps(result));self.assertEqual(result['db']['messages']['count'],1);self.assertEqual(inventory.file_record(data/'state.db')['sha256'],before);self.assertEqual(result['roots']['skills']['files']['link']['kind'],'symlink');self.assertEqual(len(result['roots']['skills']['files']),2)
   self.assertIn('.',result['roots']['skills']['directories']);self.assertIn('1',result['db']['messages']['row_hashes'])
 def test_asset_root_symlink_and_symlink_database_are_not_followed(self):
  with tempfile.TemporaryDirectory() as temporary:
   root=Path(temporary);outside=root/'outside';outside.mkdir();(outside/'private').write_text('do not traverse');link=root/'linked';link.symlink_to(outside,target_is_directory=True)
   result=inventory.tree(link)
   self.assertEqual(result['error'],'root_is_symlink');self.assertEqual(result['files'],{})
   database=root/'state.db';database.symlink_to(outside/'private')
   self.assertEqual(inventory.database(database),{'error':'symlink_database'})
 def test_database_rejects_duplicate_ids_and_path_replacement_during_read(self):
  with tempfile.TemporaryDirectory() as temporary:
   root=Path(temporary);database=root/'state.db'
   with sqlite3.connect(database) as connection:
    connection.executescript('CREATE TABLE sessions(id TEXT,source TEXT);CREATE TABLE messages(id INTEGER,content TEXT);')
    connection.executemany('INSERT INTO sessions VALUES (?,?)',[('same','one'),('same','two')])
   self.assertEqual(inventory.database(database),{'error':'duplicate_database_id'})
   with sqlite3.connect(database) as connection:connection.execute('DELETE FROM sessions')
   replacement=root/'replacement.db'
   with sqlite3.connect(replacement) as connection:connection.executescript('CREATE TABLE sessions(id TEXT,source TEXT);CREATE TABLE messages(id INTEGER,content TEXT);')
   connect=sqlite3.connect
   def replace_after_open(*args,**kwargs):
    result=connect(*args,**kwargs);os.replace(replacement,database);return result
   with patch.object(inventory.sqlite3,'connect',side_effect=replace_after_open):
    self.assertEqual(inventory.database(database),{'error':'changed_during_read'})
 def test_database_wal_inventory_keeps_one_snapshot_during_concurrent_commit(self):
  with tempfile.TemporaryDirectory() as temporary:
   database=Path(temporary)/'state.db'
   with sqlite3.connect(database) as connection:
    connection.execute('PRAGMA journal_mode=WAL')
    connection.executescript('CREATE TABLE sessions(id TEXT PRIMARY KEY,source TEXT);CREATE TABLE messages(id INTEGER PRIMARY KEY,content TEXT);')
    connection.execute('INSERT INTO sessions VALUES (?,?)',('s1','before'))
    connection.execute('INSERT INTO messages VALUES (?,?)',(1,'private-before'))
   connect=sqlite3.connect;writer_ran=False
   class ReadConnection:
    def __init__(self,connection):self.connection=connection
    def execute(self,sql,*args):
     nonlocal writer_ran
     cursor=self.connection.execute(sql,*args)
     if sql=='SELECT * FROM sessions ORDER BY id' and not writer_ran:
      writer_ran=True
      with connect(database) as writer:
       writer.execute('UPDATE sessions SET source=? WHERE id=?',('after','s1'))
       writer.execute('INSERT INTO messages VALUES (?,?)',(2,'private-after'))
     return cursor
    def rollback(self):return self.connection.rollback()
    def close(self):return self.connection.close()
   with patch.object(inventory.sqlite3,'connect',side_effect=lambda *args,**kwargs:ReadConnection(connect(*args,**kwargs))):
    snapshot=inventory.database(database)
   self.assertTrue(writer_ran)
   self.assertEqual(snapshot['sessions']['count'],1)
   self.assertEqual(snapshot['sources'],[('before',1)])
   self.assertEqual(snapshot['messages']['count'],1)
   self.assertNotIn('private-before',json.dumps(snapshot))
   self.assertNotIn('private-after',json.dumps(snapshot))
 def test_echo_inventory_reads_one_stable_regular_file_without_following_links(self):
  with tempfile.TemporaryDirectory() as temporary:
   root=Path(temporary);target=root/'target.json';target.write_text(json.dumps({'tasks':[{'id':1,'status':'done','entries':[],'events':[]}]}));link=root/'tasks.json';link.symlink_to(target)
   result=inventory.echo_inventory(link)
   self.assertEqual(result.get('error'),'OSError');self.assertEqual(result['file']['kind'],'symlink')
   fifo=root/'fifo';os.mkfifo(fifo)
   result=inventory.echo_inventory(fifo)
   self.assertEqual(result.get('error'),'not_regular_file')
   good=inventory.echo_inventory(target)
   self.assertEqual(good['count'],1);self.assertEqual(len(good['records']),1);self.assertNotIn('tasks',good)
 def test_file_and_directory_metadata_changes_during_acl_probe_mark_snapshot_unstable(self):
  with tempfile.TemporaryDirectory() as temporary:
   root=Path(temporary);file=root/'asset';file.write_text('content');directory=root/'folder';directory.mkdir()
   def mutate(path):
    path.chmod(path.stat().st_mode ^ 0o100)
    return {'acl_sha256':'a'*64,'acl_error':None}
   with patch.object(inventory,'acl_record',side_effect=mutate):
    file_result=inventory.file_record(file);directory_result=inventory.directory_record(directory)
   self.assertFalse(file_result['stable'])
   self.assertFalse(directory_result['stable'])
 def test_comparison_never_calls_unreadable_or_mutating_files_unchanged(self):
  result=comparison.compare({'same':{'sha256':'1'},'changed':{'sha256':'2'},'lost':{'sha256':'3'},'race':{'sha256':'4'},'bad':{'error':'missing'}},{'same':{'sha256':'1'},'changed':{'sha256':'5'},'race':{'sha256':'4','stable':False},'bad':{'sha256':'6'},'new':{'sha256':'7'}})
  self.assertEqual({**result,'metadata_unverifiable':sorted(result['metadata_unverifiable'])},{'unchanged':1,'changed':['changed'],'missing':['lost'],'added':['new'],'unverifiable':['race','bad'],'metadata_changed':[],'metadata_unverifiable':['bad','changed','race','same']})
 def test_content_and_filesystem_metadata_are_reported_separately(self):
  before={'file':{'sha256':'same','mode':0o644,'uid':1,'gid':2,'nlink':1,'acl_sha256':'acl-a'}}
  after={'file':{'sha256':'same','mode':0o600,'uid':1,'gid':2,'nlink':2,'acl_sha256':'acl-b','stable':True}}
  result=comparison.compare(before,after)
  self.assertEqual(result['unchanged'],1);self.assertEqual(result['changed'],[])
  self.assertEqual(result['metadata_changed'],['file']);self.assertEqual(result['metadata_unverifiable'],[])
 def test_missing_historical_metadata_is_unverifiable_even_when_content_matches(self):
  result=comparison.compare({'file':{'sha256':'same'}},{'file':{'sha256':'same','mode':0o644,'uid':1,'gid':2,'nlink':1,'acl_sha256':'acl','stable':True}})
  self.assertEqual(result['unchanged'],1)
  self.assertEqual(result['metadata_changed'],[])
  self.assertEqual(result['metadata_unverifiable'],['file'])
 def test_unstable_old_and_new_snapshots_are_not_reported_as_comparable(self):
  before={'old-file':{'sha256':'old','stable':False,'mode':0o644,'uid':1,'gid':2,'nlink':1,'acl_sha256':'acl'},'new-file':{'sha256':'new','stable':True,'mode':0o644,'uid':1,'gid':2,'nlink':1,'acl_sha256':'acl'}}
  after={'old-file':{'sha256':'old','stable':True,'mode':0o644,'uid':1,'gid':2,'nlink':1,'acl_sha256':'acl'},'new-file':{'sha256':'new','stable':False,'mode':0o644,'uid':1,'gid':2,'nlink':1,'acl_sha256':'acl'}}
  files=comparison.compare(before,after)
  self.assertEqual(files['unchanged'],0);self.assertEqual(files['unverifiable'],['old-file','new-file'])
  self.assertEqual(files['metadata_unverifiable'],['old-file','new-file'])
  dirs=comparison.compare_directories({key:{'kind':'directory','mode':0o755,'uid':1,'gid':2,'acl_sha256':'acl','stable':False} for key in ['old']},{'old':{'kind':'directory','mode':0o755,'uid':1,'gid':2,'acl_sha256':'acl','stable':True}})
  self.assertEqual(dirs['unchanged'],0);self.assertEqual(dirs['unverifiable'],['old']);self.assertEqual(dirs['metadata_unverifiable'],['old'])
 def test_malformed_inventory_records_and_missing_directory_maps_fail_closed(self):
  malformed=comparison.compare({'bad':None},{'bad':{'sha256':'a'*64}})
  self.assertEqual(malformed['unverifiable'],['bad']);self.assertEqual(malformed['metadata_unverifiable'],['bad'])
  dirs=comparison.compare_directories({'bad':None},{'bad':{'kind':'directory','mode':0o755,'uid':1,'gid':2,'acl_sha256':'a'}})
  self.assertEqual(dirs['unverifiable'],['bad']);self.assertEqual(dirs['metadata_unverifiable'],['bad'])
  root=comparison.compare_root({'files':{},'directories':{}},{'files':{}})
  self.assertEqual(root['reason'],'walk_error_inventory_missing')
 def test_unavailable_acl_is_not_reported_as_metadata_verified(self):
  before={'file':{'sha256':'same','mode':0o644,'uid':1,'gid':2,'nlink':1,'acl_sha256':None,'acl_error':'unavailable'}}
  after={'file':{'sha256':'same','mode':0o644,'uid':1,'gid':2,'nlink':1,'acl_sha256':None,'acl_error':'unavailable','stable':True}}
  result=comparison.compare(before,after)
  self.assertEqual(result['unchanged'],1);self.assertEqual(result['metadata_changed'],[])
  self.assertEqual(result['metadata_unverifiable'],['file'])
 def test_directory_metadata_and_message_rows_are_comparable(self):
  before={'directories':{'.':{'mode':0o755,'uid':1,'gid':2,'acl_sha256':'a'}},'files':{}}
  after={'directories':{'.':{'mode':0o750,'uid':1,'gid':2,'acl_sha256':'b','stable':True}},'files':{}}
  result=comparison.compare_directories(before['directories'],after['directories'])
  self.assertEqual(result['metadata_changed'],['.'])
  rows=comparison.compare_rows({'1':'old','2':'same'},{'1':'new','2':'same','3':'added'})
  self.assertEqual(rows['changed'],['1']);self.assertEqual(rows['added'],['3'])
  self.assertEqual(comparison.compare_database_rows({}, {'1':'new'})['status'],'compared')
  self.assertEqual(comparison.compare_database_rows({}, {})['status'],'compared')
  self.assertEqual(comparison.compare_database_rows(None, {})['status'],'unverifiable')
 def test_database_row_comparison_requires_counts_and_complete_valid_hashes(self):
  def db(count,rows):return {'sessions':{'count':count,'row_hashes':rows}}
  self.assertEqual(comparison.compare_table_rows(db(2,{'1':'a'*64}),db(2,{'1':'a'*64,'2':'b'*64}),'sessions')['reason'],'database_row_count_mismatch')
  self.assertEqual(comparison.compare_table_rows(db(1,{'1':'bad'}),db(1,{'1':'a'*64}),'sessions')['reason'],'invalid_database_row_hash')
  self.assertEqual(comparison.compare_table_rows(db(1,{'1':'a'*64}),db(1,{'1':'b'*64}),'sessions')['changed'],['1'])
 def test_echo_comparison_rejects_duplicate_invalid_and_partial_snapshots(self):
  good={'count':1,'records':[{'id':7,'sha256':'a'*64}]}
  self.assertEqual(comparison.compare_echo(good,good)['unchanged'],1)
  cases=[({'records':[]},good,'echo_record_count_mismatch'),({'count':2,'records':[good['records'][0]]},good,'echo_record_count_mismatch'),({'count':2,'records':[good['records'][0],good['records'][0]]},good,'duplicate_echo_id'),({'count':1,'records':[{'id':7,'sha256':'short'}]},good,'invalid_echo_record_hash')]
  for before,after,reason in cases:self.assertEqual(comparison.compare_echo(before,after)['reason'],reason)
 def test_report_distinguishes_missing_row_baseline_from_real_empty_table(self):
  root={'files':{},'directories':{},'hardlink_groups':[],'errors':[]};old={'critical':{},'roots':{'x':{'files':{},'directories':{},'hardlink_groups':[],'errors':[]}},'db':{'sessions':{'count':0},'messages':{'count':0}}}
  extended={};echo={'count':0,'records':[]};roots={'x':root,'profiles':root,'memory':root,'task_state':root,'pending_messages':root};current={'critical':{},'roots':roots,'db':{'sessions':{'count':0,'row_hashes':{}},'messages':{'count':0,'row_hashes':{}}},'echo':{'count':0,'records':[]}}
  result=comparison.report(old,extended,echo,current)
  self.assertEqual(result['database_rows']['sessions']['status'],'unverifiable')
  old['db']['messages']['row_hashes']={}
  result=comparison.report(old,extended,echo,current)
  self.assertEqual(result['database_rows']['messages']['status'],'compared')
  current['roots']['x']['directories']={'sub':{'error':'PermissionError'}}
  current['roots']['x']['errors']=[{'path':'sub','error':'PermissionError'}]
  result=comparison.report(old,extended,echo,current)
  self.assertEqual(result['roots']['x']['reason'],'walk_errors_present')
 def test_report_returns_unverifiable_for_missing_database_and_echo_records(self):
  old={'critical':{},'roots':{},'db':{},'echo':{}}
  current={'critical':{},'roots':{'profiles':{'error':'missing_root'}},'db':{'sessions':{'error':'missing_database'},'messages':{'error':'missing_database'}},'echo':{'error':'invalid_json'}}
  result=comparison.report(old,{}, {},current)
  self.assertEqual(result['echo']['status'],'unverifiable')
  self.assertEqual(result['echo']['reason'],'echo_records_missing')
  self.assertEqual(result['database_rows']['sessions']['status'],'unverifiable')
  self.assertEqual(result['database_rows']['messages']['status'],'unverifiable')
  self.assertEqual(result['roots']['profiles']['status'],'unverifiable')
 def test_report_enforces_required_root_coverage_and_walk_errors(self):
  complete={'files':{},'directories':{},'hardlink_groups':[],'errors':[]}
  partial={'files':{},'directories':{},'hardlink_groups':[],'errors':[{'path':'restricted','error':'PermissionError'}]}
  baseline={'critical':{},'roots':{'skills':complete,'knowledge':complete},'db':{},'hardlinks':{'groups':[]}}
  current={'critical':{},'roots':{'skills':partial},'db':{},'hardlinks':{'groups':[]},'echo':{'count':0,'records':[]}}
  result=comparison.report(baseline,{},current['echo'],current)
  self.assertEqual(result['roots']['skills']['reason'],'walk_errors_present')
  self.assertEqual(result['roots']['knowledge']['reason'],'current_root_missing')
  self.assertIn('panel_sessions',result['root_coverage']['baseline_missing'])
  self.assertIn('panel_state',result['root_coverage']['current_missing'])
  noerrors={**complete,'errors':[]}
  self.assertEqual(comparison.compare_root({'files':{},'directories':{},'hardlink_groups':[],'errors':[]},noerrors)['hardlinks']['status'],'compared')
 def test_compare_root_does_not_infer_empty_walk_error_lists(self):
  root={'files':{},'directories':{},'hardlink_groups':[]}
  result=comparison.compare_root(root,root)
  self.assertEqual(result['reason'],'walk_error_inventory_missing')
 def test_hardlink_groups_are_recorded_without_reading_content_twice(self):
  with tempfile.TemporaryDirectory() as temporary:
   root=Path(temporary);data=root/'data';var=root/'var';app=root/'app';skills=data/'skills';skills.mkdir(parents=True);(skills/'a').write_text('same');os.link(skills/'a',skills/'b');echo=root/'echo.json';echo.write_text('{"tasks":[]}')
   result=inventory.collect(data,var,app,echo)
   groups=result['roots']['skills']['hardlink_groups']
   self.assertIn(['a','b'],groups)
   self.assertIn(['skills/a','skills/b'],result['hardlinks']['groups'])
 def test_hardlink_comparison_distinguishes_topology_change(self):
  same={'groups':[['data/a','data/b']]};changed={'groups':[['data/a','data/c']]}
  self.assertEqual(comparison.compare_hardlinks(same,same)['status'],'compared')
  self.assertEqual(comparison.compare_hardlinks(same,changed)['status'],'changed')
 def test_hardlink_comparison_rejects_malformed_or_overlapping_groups(self):
  for groups in ([['data/a']], [['data/a','data/a']], [['data/a','data/b'],['data/b','data/c']], [None]):
   result=comparison.compare_hardlinks({'groups':groups},{'groups':[]})
   self.assertEqual(result['status'],'unverifiable',groups)
   self.assertEqual(result['reason'],'invalid_hardlink_groups')
unittest.main()
