"""Real custom credential pool + model editor; /tmp only, no Agent or HTTP."""
import importlib.util,json,os,sys,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
spec=importlib.util.spec_from_file_location('native_fixture',Path(__file__).with_name('native-config-integration.test.py'));fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)
sys.path.insert(0,str(ROOT/'app/server'));spec=importlib.util.spec_from_file_location('model_editor',ROOT/'app/server/panel-models.py');editor=importlib.util.module_from_spec(spec);spec.loader.exec_module(editor)
from hermes_cli import config,auth,runtime_provider
class ModelPool(unittest.TestCase):
 def setUp(self):
  self.home=config.get_config_path().parent;self.home.mkdir(exist_ok=True);self.path=self.home/'config.yaml';self.state=fixture.FIXTURE/'state';self.path.write_text('providers: {one: {name: first, base_url: https://fixture.invalid/v1, default_model: a, models: [a], api_key: old-key}}\n');(self.home/'.env').write_text('');(self.home/'auth.json').write_text('{"version":1,"providers":{}}');config.invalidate_env_cache()
 def call(self,**body):
  body['revision']=editor.execute({'action':'read'},self.path,self.state)['revision'];return editor.execute(body,self.path,self.state)
 def resolve(self,name='one'):return runtime_provider._resolve_named_custom_runtime(requested_provider='custom:'+name)
 def test_rotation_clear_and_undo_follow_config(self):
  self.assertEqual(self.resolve()['api_key'],'old-key');result=self.call(action='update',id='one',changes={'credential':{'action':'replace','value':'new-key'}});self.assertEqual(self.resolve()['api_key'],'new-key');self.call(action='restore',change_id=result['change_id']);self.assertEqual(self.resolve()['api_key'],'old-key');self.call(action='update',id='one',changes={'credential':{'action':'clear'}});self.assertEqual(self.resolve()['api_key'],'no-key-required')
 def test_env_reference_wins_inline_through_actual_pool(self):
  self.path.write_text(self.path.read_text().replace('api_key: old-key','api_key: old-key, key_env: FIXTURE_KEY'));os.environ['FIXTURE_KEY']='env-key';self.addCleanup(lambda:os.environ.pop('FIXTURE_KEY',None));self.assertEqual(self.resolve()['api_key'],'env-key')
 def test_same_display_name_different_provider_keys_do_not_share_pool(self):
  self.path.write_text('providers: {one: {name: same, base_url: https://one.invalid/v1, default_model: a, models: [a], api_key: first-key}, two: {name: same, base_url: https://two.invalid/v1, default_model: a, models: [a], api_key: second-key}}\n');self.assertEqual(self.resolve('one')['api_key'],'first-key');self.assertEqual(self.resolve('two')['api_key'],'second-key')
 def test_manual_pool_credential_is_preserved_and_runtime_precedence_is_observable(self):
  auth.write_credential_pool('custom:first',[{'id':'manual','source':'manual','access_token':'independent-key','priority':-1,'auth_type':'api_key','base_url':'https://fixture.invalid/v1'}]);self.assertEqual(self.resolve()['api_key'],'independent-key');self.call(action='update',id='one',changes={'credential':{'action':'clear'}});self.assertEqual(self.resolve()['api_key'],'independent-key');self.assertTrue(any(e['id']=='manual' for e in auth.read_credential_pool('custom:first')))
 def test_same_name_and_endpoint_still_selects_each_config_key(self):
  self.path.write_text('providers: {one: {name: same, base_url: https://fixture.invalid/v1, default_model: a, models: [a], api_key: first-key}, two: {name: same, base_url: https://fixture.invalid/v1, default_model: a, models: [a], api_key: second-key}}\n');before=(self.home/'auth.json').read_bytes();self.assertEqual(self.resolve('one')['api_key'],'first-key');self.assertEqual(self.resolve('two')['api_key'],'second-key');self.assertEqual((self.home/'auth.json').read_bytes(),before)
 def test_foreign_endpoint_manual_key_is_not_forwarded(self):
  auth.write_credential_pool('custom:first',[{'id':'foreign','source':'manual','access_token':'foreign-key','priority':-1,'auth_type':'api_key','base_url':'https://other.invalid/v1'}]);self.assertEqual(self.resolve()['api_key'],'old-key');self.assertTrue(any(e['id']=='foreign' for e in auth.read_credential_pool('custom:first')))
 def test_matching_config_cooldown_is_preserved_and_new_key_clears_it(self):
  import hashlib,time
  auth.write_credential_pool('custom:first',[{'id':'blocked','source':'panel_config:custom:one','secret_fingerprint':'sha256:'+hashlib.sha256(b'old-key').hexdigest()[:16],'priority':0,'auth_type':'api_key','base_url':'https://fixture.invalid/v1','last_status':'exhausted','last_status_at':time.time(),'last_error_reset_at':time.time()+600}])
  with self.assertRaises(auth.AuthError):self.resolve()
  self.call(action='update',id='one',changes={'credential':{'action':'replace','value':'new-key'}});self.assertEqual(self.resolve()['api_key'],'new-key')
 def test_stale_pool_persist_cannot_change_next_resolution_or_remove_manual_key(self):
  auth.write_credential_pool('custom:first',[{'id':'manual','source':'manual','access_token':'manual-key','priority':20,'auth_type':'api_key','base_url':'https://fixture.invalid/v1'}]);old=self.resolve()['credential_pool'];self.call(action='update',id='one',changes={'credential':{'action':'replace','value':'fresh-key'}});old._persist();new=self.resolve();self.assertTrue(any(e.runtime_api_key=='fresh-key' for e in new['credential_pool'].entries()));self.assertFalse(any(e.runtime_api_key=='old-key' for e in new['credential_pool'].entries()));self.assertTrue(any(e['id']=='manual' for e in auth.read_credential_pool('custom:first')))
if __name__=='__main__':
 try:unittest.main()
 finally:fixture.temporary.cleanup()
