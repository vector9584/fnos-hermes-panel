"""Candidate native auth and credential lifecycle, isolated HOME, no API calls."""
import importlib.util,json,multiprocessing,os,sys,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
spec=importlib.util.spec_from_file_location('native_fixture',Path(__file__).with_name('native-config-integration.test.py'));fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)
from hermes_cli import auth,credential_lifecycle as lifecycle,config,managed_scope
import panel_config_bridge as bridge
class NativeCredentials(unittest.TestCase):
 def setUp(self):
  self.home=config.get_config_path().parent;self.home.mkdir(exist_ok=True);self.env=self.home/'.env';self.yaml=self.home/'config.yaml';self.store=self.home/'auth.json';self.yaml.write_text('# native\nmodel: {api_key: old-key}\n');self.env.write_text('OPENAI_API_KEY=old-key\n');self.store.write_text(json.dumps({'version':1,'providers':{'custom':{'oauth':'keep-grant'}},'credential_pool':{'openai-api':[{'id':'env','source':'env:OPENAI_API_KEY','api_key':'old-key'},{'id':'manual','source':'manual','api_key':'keep'}]}}));config.invalidate_env_cache()
 def test_real_lifecycle_updates_every_store_and_keeps_native_contract(self):
  self.assertEqual(Path(auth.__file__).resolve(),(ROOT/'app/python/hermes_cli/auth.py').resolve());result=lifecycle.save_provider_env_credential('OPENAI_API_KEY','new-key');self.assertTrue(result['ok']);self.assertEqual(config.load_env()['OPENAI_API_KEY'],'new-key');self.assertEqual(config.read_raw_config()['model']['api_key'],'new-key');self.assertEqual([e['id'] for e in auth._load_auth_store()['credential_pool']['openai-api']],['manual']);self.assertEqual(os.environ['OPENAI_API_KEY'],'new-key');self.assertNotIn('new-key',json.dumps(result));removed=lifecycle.remove_provider_env_credential('OPENAI_API_KEY');self.assertTrue(removed['found']);self.assertNotIn('OPENAI_API_KEY',config.load_env());self.assertNotIn('api_key',config.read_raw_config()['model']);self.assertTrue(auth.is_source_suppressed('openai-api','env:OPENAI_API_KEY'));self.assertEqual(auth._load_auth_store()['providers']['custom']['oauth'],'keep-grant')
 def test_native_auth_read_recovers_interrupted_three_file_publication(self):
  bridge.provider_credential('OPENAI_API_KEY','old-key');helper=sys.modules['_hermes_panel_provider_credentials'];state=fixture.FIXTURE/'state'
  def crash():
   with auth._auth_store_lock():helper.update(self.home,state,'OPENAI_API_KEY','recovered-key',['openai-api'],after_publish=lambda i:os._exit(71))
  child=multiprocessing.Process(target=crash);child.start();child.join(12);self.assertEqual(child.exitcode,71)
  auth._load_auth_store();self.assertEqual(config.load_env()['OPENAI_API_KEY'],'recovered-key');self.assertEqual(config.read_raw_config()['model']['api_key'],'recovered-key');self.assertFalse((state/'config-bundle-pending.json').exists())
 def test_concurrent_native_auth_writers_and_credentials_finish_without_lost_fields(self):
  def worker(index):
   for repeat in range(3):
    if index%2:lifecycle.save_provider_env_credential('FIXTURE_'+str(index),'value-'+str(repeat))
    else:
     with auth._auth_store_lock():
      data=auth._load_auth_store();data.setdefault('fixture_workers',{})[str(index)]=repeat;auth._save_auth_store(data)
  children=[multiprocessing.Process(target=worker,args=(i,)) for i in range(6)]
  for child in children:child.start()
  for child in children:
   child.join(20)
   if child.is_alive():child.kill();child.join();self.fail('native config/auth lock deadlock')
   self.assertEqual(child.exitcode,0)
  self.assertEqual(auth._load_auth_store()['fixture_workers'],{'0':2,'2':2,'4':2})
  for i in [1,3,5]:self.assertEqual(config.load_env()['FIXTURE_'+str(i)],'value-2')
 def test_stale_pool_writer_cannot_resurrect_rotated_or_removed_env_key(self):
  lifecycle.save_provider_env_credential('OPENAI_API_KEY','new-key')
  stale={'id':'stale','source':'env:OPENAI_API_KEY','access_token':'old-key','auth_type':'api_key'}
  fresh={**stale,'id':'fresh','access_token':'new-key'}
  auth.write_credential_pool('openai-api',[stale,fresh])
  self.assertEqual([e['id'] for e in auth.read_credential_pool('openai-api')],['fresh','manual'])
  lifecycle.remove_provider_env_credential('OPENAI_API_KEY');auth.write_credential_pool('openai-api',[stale,fresh]);self.assertEqual([e['id'] for e in auth.read_credential_pool('openai-api')],['manual'])
 def test_empty_save_preserves_native_clear_semantics_without_stale_mirrors(self):
  lifecycle.save_provider_env_credential('OPENAI_API_KEY','');self.assertEqual(config.load_env()['OPENAI_API_KEY'],'');self.assertNotIn('api_key',config.read_raw_config()['model']);self.assertTrue(auth.is_source_suppressed('openai-api','env:OPENAI_API_KEY'))
 def test_real_dashboard_env_endpoints_report_config_errors(self):
  import asyncio,contextlib,typing
  from fastapi import HTTPException
  from hermes_cli.web_models import EnvVarUpdate,EnvVarDelete
  scope={**vars(typing),'EnvVarUpdate':EnvVarUpdate,'EnvVarDelete':EnvVarDelete,'HTTPException':HTTPException,'_profile_scope':lambda p:contextlib.nullcontext(),'_log':__import__('logging').getLogger('fixture')}
  fixture.extract(ROOT/'app/python/hermes_cli/web_server.py',['set_env_var','remove_env_var'],scope)
  self.store.write_text('broken')
  with self.assertRaises(HTTPException) as error:asyncio.run(scope['set_env_var'](EnvVarUpdate(key='OPENAI_API_KEY',value='new-key')))
  self.assertEqual(error.exception.status_code,503);self.assertIn('原文件已保留',error.exception.detail);self.assertIn('old-key',self.env.read_text())
 def test_managed_invalid_and_cross_scope_updates_never_mutate(self):
  before=[p.read_bytes() for p in [self.env,self.yaml,self.store]];original=managed_scope.is_env_managed;managed_scope.is_env_managed=lambda key:True
  try:
   with self.assertRaises(bridge.ConfigError):lifecycle.save_provider_env_credential('OPENAI_API_KEY','new-key')
  finally:managed_scope.is_env_managed=original
  for value in ['bad\nkey','nonascii密钥']:
   with self.assertRaises(bridge.ConfigError):lifecycle.save_provider_env_credential('OPENAI_API_KEY',value)
  self.assertEqual([p.read_bytes() for p in [self.env,self.yaml,self.store]],before)
if __name__=='__main__':
 try:unittest.main()
 finally:fixture.temporary.cleanup()
