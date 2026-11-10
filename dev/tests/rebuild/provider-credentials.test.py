import json,multiprocessing,os,sys,tempfile,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3];sys.path.insert(0,str(ROOT/'app/server'))
from panel_provider_credentials import update
from panel_config_txn import config_lock,ConfigError
def crash_update(home,state):update(home,state,'KEY','new-secret',['p'],after_publish=lambda i:os._exit(71))
class Credentials(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(dir='/tmp');self.addCleanup(self.temp.cleanup);self.home=Path(self.temp.name).resolve();self.state=self.home/'state';self.env=self.home/'.env';self.yaml=self.home/'config.yaml';self.auth=self.home/'auth.json'
  self.env.write_text('# keep\nKEY=old-secret\nOTHER=keep\n');self.yaml.write_text('# keep\nmodel: {api_key: old-secret}\nauxiliary: {vision: {api_key: independent}}\ncustom_providers: [{api: old-secret, other: keep}]\n');self.auth.write_text(json.dumps({'providers':{'p':{'oauth':'keep-grant'}},'credential_pool':{'p':[{'id':'env','source':'env:KEY','api_key':'old-secret'},{'id':'manual','source':'manual','api_key':'manual-secret'},{'id':'oauth','source':'oauth','access_token':'keep-token'}]},'suppressed_sources':{'p':['env:KEY','other']},'other':'keep'}))
 def test_rotation_removes_stale_pool_and_reconciles_only_matching_yaml(self):
  result=update(self.home,self.state,'KEY','new-secret',['p']);text=json.dumps(result);self.assertNotIn('secret',text);self.assertIn('new-secret',self.env.read_text());self.assertNotIn('old-secret',self.yaml.read_text());self.assertIn('independent',self.yaml.read_text());auth=json.loads(self.auth.read_text());self.assertEqual([e['id'] for e in auth['credential_pool']['p']],['manual','oauth']);self.assertEqual(auth['providers']['p']['oauth'],'keep-grant');self.assertEqual(auth['suppressed_sources']['p'],['other']);self.assertTrue(self.yaml.read_text().startswith('# keep'))
 def test_remove_suppresses_source_and_preserves_other_grants(self):
  result=update(self.home,self.state,'KEY',None,['p']);self.assertTrue(result['found']);self.assertNotIn('KEY=',self.env.read_text());self.assertNotIn('old-secret',self.yaml.read_text());self.assertIn('env:KEY',json.loads(self.auth.read_text())['suppressed_sources']['p'])
 def test_crash_after_first_file_recovers_all_three_before_next_read(self):
  child=multiprocessing.Process(target=crash_update,args=(self.home,self.state));child.start();child.join(10);self.assertEqual(child.exitcode,71);self.assertIn('old-secret',self.env.read_text())
  with config_lock(self.state):pass
  self.assertIn('new-secret',self.env.read_text());self.assertNotIn('old-secret',self.auth.read_text());self.assertFalse((self.state/'config-bundle-pending.json').exists())
 def test_malformed_auth_or_yaml_never_changes_any_file(self):
  for path,value in [(self.auth,'broken'),(self.yaml,'[')]:
   old=path.read_text();path.write_text(value);before=[p.read_bytes() for p in [self.env,self.yaml,self.auth]]
   with self.assertRaises(ConfigError):update(self.home,self.state,'KEY','new-secret',['p'])
   self.assertEqual(before,[p.read_bytes() for p in [self.env,self.yaml,self.auth]]);path.write_text(old)
 def test_nested_lock_and_missing_stores(self):
  self.env.unlink();self.yaml.unlink();self.auth.unlink()
  with config_lock(self.state):result=update(self.home,self.state,'KEY','new-secret',['p'])
  self.assertTrue(result['changed']);self.assertTrue(self.auth.exists());self.assertFalse(self.yaml.exists());self.assertEqual(self.env.stat().st_mode&0o777,0o600)
 def test_new_style_provider_mirrors_rotate_but_endpoint_and_independent_keys_do_not(self):
  self.yaml.write_text(self.yaml.read_text()+'providers: {same: {api_key: old-secret, api: old-secret, note: keep}, separate: {api_key: independent}, reference: {api_key: "${KEY}"}}\n')
  result=update(self.home,self.state,'KEY','new-secret',['p'])
  from panel_config_txn import load_yaml
  data=load_yaml(self.yaml.read_bytes())[1];self.assertEqual(data['providers']['same']['api_key'],'new-secret');self.assertEqual(data['providers']['same']['api'],'old-secret');self.assertEqual(data['providers']['separate']['api_key'],'independent');self.assertEqual(data['providers']['reference']['api_key'],'${KEY}');self.assertIn('providers.same.api_key',result['config_updates'])
  update(self.home,self.state,'KEY',None,['p']);data=load_yaml(self.yaml.read_bytes())[1];self.assertNotIn('api_key',data['providers']['same']);self.assertEqual(data['providers']['same']['api'],'old-secret')
if __name__=='__main__':unittest.main()
