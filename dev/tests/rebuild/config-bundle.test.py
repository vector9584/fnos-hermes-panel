import json,multiprocessing,os,sys,tempfile,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3];sys.path.insert(0,str(ROOT/'app/server'))
import panel_config_txn as txn
from panel_config_bundle import commit_bundle,inspect_pending,resolve_pending
def interrupted(root,home):
 root=Path(root);home=Path(home)
 with txn.config_lock(root):commit_bundle(root,[(home/'config.yaml',b'model: old\n',b'model: new\n'),(home/'.env',b'KEY=old\n',b'KEY=new\n')],'fixture',after_publish=lambda index:os._exit(71))
def rollback_interrupted(root,home,view):
 with txn.config_lock(root,recover=False):resolve_pending(root,[home],{'id':view['id'],'revision':view['revision'],'choice':'rollback'},after_publish=lambda index:os._exit(72))
def create_interrupted(root,home):
 with txn.config_lock(root):commit_bundle(root,[(home/'.env',None,b'NEW=secret\n'),(home/'config.yaml',b'model: old\n',b'model: new\n')],'fixture',after_publish=lambda index:os._exit(73))
class BundleTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(dir='/tmp');self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name).resolve();self.state=self.root/'state';self.yaml=self.root/'config.yaml';self.env=self.root/'.env';self.yaml.write_bytes(b'model: old\n');self.env.write_bytes(b'KEY=old\n')
 def crash(self):
  child=multiprocessing.Process(target=interrupted,args=(self.state,self.root));child.start();child.join(10);self.assertEqual(child.exitcode,71)
 def test_process_crash_recovers_before_next_single_file_change(self):
  self.crash();self.assertEqual(self.yaml.read_bytes(),b'model: new\n');self.assertEqual(self.env.read_bytes(),b'KEY=old\n')
  txn.execute({'action':'patch','operations':[{'path':['later'],'value':True}]},self.yaml,self.state);self.assertEqual(self.env.read_bytes(),b'KEY=new\n');self.assertIn(b'later: true',self.yaml.read_bytes())
  record=json.loads(next((self.state/'config-bundles').glob('*/journal.json')).read_text());self.assertEqual(record['status'],'committed');self.assertTrue(record['recovering'])
 def test_external_edit_blocks_recovery_without_overwrite(self):
  self.crash();self.env.write_bytes(b'KEY=external\n')
  with self.assertRaises(txn.ConfigError) as error:
   with txn.config_lock(self.state):pass
  self.assertEqual(error.exception.status,409);self.assertEqual(self.env.read_bytes(),b'KEY=external\n');self.assertEqual(self.yaml.read_bytes(),b'model: new\n')
 def test_success_backups_modes_and_noop(self):
  self.env.chmod(0o640)
  with txn.config_lock(self.state):result=commit_bundle(self.state,[(self.yaml,b'model: old\n',b'model: final\n'),(self.env,b'KEY=old\n',b'KEY=final\n')],'fixture')
  self.assertEqual(self.env.stat().st_mode&0o777,0o640);directory=self.state/'config-bundles'/result['change_id'];self.assertEqual((directory/'1.before').read_bytes(),b'KEY=old\n');self.assertEqual((directory/'1.before').stat().st_mode&0o777,0o600);self.assertNotIn('KEY=final',json.dumps(result))
  with txn.config_lock(self.state):self.assertFalse(commit_bundle(self.state,[(self.env,b'KEY=final\n',b'KEY=final\n')],'noop')['changed'])
 def test_conflict_or_bad_path_before_publication_preserves_files(self):
  with txn.config_lock(self.state):
   with self.assertRaises(txn.ConfigError):commit_bundle(self.state,[(self.yaml,b'wrong',b'model: final\n'),(self.env,b'KEY=old\n',b'KEY=final\n')],'fixture')
   with self.assertRaises(txn.ConfigError):commit_bundle(self.state,[(self.root/'other',None,b'bad')],'fixture')
  self.assertEqual(self.yaml.read_bytes(),b'model: old\n');self.assertEqual(self.env.read_bytes(),b'KEY=old\n')
 def test_channel_bundle_merges_both_files_and_rejects_either_conflict_before_writing(self):
  self.yaml.write_bytes(b'model: old\nseparate: keep\n');self.env.write_bytes(b'KEY=old\nOTHER=keep\n')
  body={'action':'bundle_changes','before':'model: old\n','after':'model: channel\n','env_before':'KEY=old\n','env_after':'KEY=channel\n'}
  self.assertTrue(txn.execute(body,self.yaml,self.state)['changed']);self.assertIn(b'separate: keep',self.yaml.read_bytes());self.assertIn(b'OTHER=keep',self.env.read_bytes());before=(self.yaml.read_bytes(),self.env.read_bytes())
  body.update(after='model: stale\n',env_after='KEY=stale\n')
  with self.assertRaises(txn.ConfigError):txn.execute(body,self.yaml,self.state)
  self.assertEqual((self.yaml.read_bytes(),self.env.read_bytes()),before)
 def inspect(self):
  with txn.config_lock(self.state,recover=False):return inspect_pending(self.state,[self.root])['pending']
 def resolve(self,choice,view=None):
  view=view or self.inspect()
  with txn.config_lock(self.state,recover=False):return resolve_pending(self.state,[self.root],{'id':view['id'],'revision':view['revision'],'choice':choice})
 def test_inspection_no_replay_or_secrets_then_finish(self):
  self.crash();view=self.inspect();self.assertEqual([x['state'] for x in view['files']],['after','before']);self.assertNotIn('KEY=',json.dumps(view));self.assertEqual(self.env.read_bytes(),b'KEY=old\n')
  self.resolve('finish',view);self.assertIsNone(self.inspect());self.assertEqual(self.env.read_bytes(),b'KEY=new\n')
 def test_rollback_and_interrupted_rollback_are_recoverable(self):
  self.crash();view=self.inspect()
  def rollback_crash():
   with txn.config_lock(self.state,recover=False):resolve_pending(self.state,[self.root],{'id':view['id'],'revision':view['revision'],'choice':'rollback'},after_publish=lambda index:os._exit(72))
  child=multiprocessing.Process(target=rollback_interrupted,args=(self.state,self.root,view));child.start();child.join(10);self.assertEqual(child.exitcode,72)
  with txn.config_lock(self.state):pass
  self.assertEqual(self.yaml.read_bytes(),b'model: old\n');self.assertEqual(self.env.read_bytes(),b'KEY=old\n');self.assertIsNone(self.inspect())
 def test_stale_and_external_changes_preserved_and_can_release_with_snapshot(self):
  self.crash();view=self.inspect();self.env.write_bytes(b'KEY=external-secret\n')
  with self.assertRaises(txn.ConfigError):self.resolve('keep',view)
  view=self.inspect();self.assertTrue(view['has_external_changes']);self.assertNotIn('external-secret',json.dumps(view))
  for choice in ['finish','rollback']:
   with self.assertRaises(txn.ConfigError):self.resolve(choice,view)
  self.resolve('keep',view);self.assertEqual(self.env.read_bytes(),b'KEY=external-secret\n');self.assertEqual(self.yaml.read_bytes(),b'model: new\n')
  self.assertTrue(any(p.read_bytes()==b'KEY=external-secret\n' for p in (self.state/'config-bundles').glob('*/resolution-*.before')))
  with txn.config_lock(self.state):pass
 def test_new_file_rollback_removes_only_matching_created_file(self):
  self.env.unlink()
  child=multiprocessing.Process(target=create_interrupted,args=(self.state,self.root));child.start();child.join(10);self.assertEqual(child.exitcode,73);self.assertTrue(self.env.exists());self.resolve('rollback');self.assertFalse(self.env.exists());self.assertEqual(self.yaml.read_bytes(),b'model: old\n')
 def test_missing_or_tampered_payload_blocks_all_actions(self):
  self.crash();target=next((self.state/'config-bundles').glob('*/0.before'));target.write_bytes(b'wrong')
  with self.assertRaises(txn.ConfigError):self.inspect()
  self.assertEqual(self.yaml.read_bytes(),b'model: new\n')
if __name__=='__main__':unittest.main()
