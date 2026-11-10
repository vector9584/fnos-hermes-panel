"""Compare saved source fields against installed native resolution, no HTTP."""
import importlib.util,os,sys,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
spec=importlib.util.spec_from_file_location('native_fixture',Path(__file__).with_name('native-config-integration.test.py'));fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)
sys.path.insert(0,str(ROOT/'app/server'))
spec=importlib.util.spec_from_file_location('source',ROOT/'app/server/panel-model-source.py');source=importlib.util.module_from_spec(spec);spec.loader.exec_module(source)
from hermes_cli import config,runtime_provider
class ModelSourceNative(unittest.TestCase):
 def setUp(self):
  self.home=config.get_config_path().parent;self.home.mkdir(exist_ok=True);self.var=fixture.FIXTURE/'var';self.var.mkdir(exist_ok=True);self.path=self.home/'config.yaml';self.old=dict(os.environ);self.addCleanup(lambda:(os.environ.clear(),os.environ.update(self.old)))
 def test_new_and_legacy_field_precedence_matches_native_named_resolution(self):
  for origin in ['providers','custom_providers']:
   for key_env in ['KEY','']:
    with self.subTest(origin=origin,key_env=key_env):
     entry='{name: fixture, base_url: https://fixture.invalid/v1, model: a, default_model: a, models: [a], key_env: "'+key_env+'", api_key: inline-key}'
     self.path.write_text(('providers: {fixture: '+entry+'}' if origin=='providers' else 'custom_providers: ['+entry+']')+'\n');(self.var/'.env.providers').write_text('KEY=provider-key\n');(self.home/'.env').write_text('KEY=home-key\n');os.environ['KEY']='home-key';config.invalidate_env_cache()
     native=runtime_provider._get_named_custom_provider('custom:fixture');expected=native['api_key'] or runtime_provider._getenv(native.get('key_env',''),'')
     actual=source.read_source(self.path,self.var,{'provider':'fixture','model':'a'})['target'];self.assertEqual(actual['api_key'],expected);self.assertEqual(actual['base_url'],native['base_url'])
 def test_legacy_alias_credentials_match_native_and_clear_removes_them(self):
  import yaml
  spec=importlib.util.spec_from_file_location('models_alias',ROOT/'app/server/panel-models.py');models=importlib.util.module_from_spec(spec);spec.loader.exec_module(models)
  for fields in [{'api_key_env':'ALIAS_KEY'},{'apiKeyEnv':'ALIAS_KEY'},{'keyEnv':'ALIAS_KEY'},{'apiKey':'inline-alias-secret'},{'api_key':'canonical','apiKey':'ignored','key_env':'ALIAS_KEY'},{'api_key_env':'ALIAS_KEY','keyEnv':'IGNORED_KEY'},{'key_env':'','apiKeyEnv':'IGNORED_KEY','api_key':'fallback'}]:
   with self.subTest(fields=list(fields)):
    entry={'name':'legacy','base_url':'https://fixture.invalid/v1','model':'a',**fields};self.path.write_text(yaml.safe_dump({'custom_providers':[entry]}));(self.home/'.env').write_text('ALIAS_KEY=environment-alias-secret\n');os.environ['ALIAS_KEY']='environment-alias-secret';config.invalidate_env_cache()
    native=runtime_provider._get_named_custom_provider('custom:legacy');expected=native.get('api_key') or runtime_provider._getenv(native.get('key_env',''),'')
    actual=source.read_source(self.path,self.var,{'provider':'legacy','model':'a'})['target'];self.assertEqual(actual['api_key'],expected)
    view=models.execute({'action':'read'},self.path,self.var/'panel-state',self.var);self.assertTrue(view['providers'][0]['api_key_configured'])
    models.execute({'action':'update','id':'legacy','revision':view['revision'],'changes':{'credential':{'action':'clear'}}},self.path,self.var/'panel-state',self.var)
    config.invalidate_env_cache();native=runtime_provider._get_named_custom_provider('custom:legacy');self.assertFalse(native.get('api_key') or native.get('key_env'));self.assertFalse(source.read_source(self.path,self.var,{'provider':'legacy','model':'a'})['target']['api_key'])
 def test_endpoint_model_protocol_views_and_edits_match_native(self):
  import yaml
  spec=importlib.util.spec_from_file_location('models_fields',ROOT/'app/server/panel-models.py');models=importlib.util.module_from_spec(spec);spec.loader.exec_module(models)
  cases=[
   ('custom_providers',{'baseUrl':'https://alias.invalid/v1','defaultModel':'a','apiMode':'anthropic_messages'}),
   ('custom_providers',{'base_url':'https://canonical.invalid/v1','api':'https://ignored.invalid/v1','model':'a','default_model':'ignored','api_mode':' CODEX_RESPONSES '}),
   ('custom_providers',{'base_url':'invalid','url':'https://fallback.invalid/v1','model':'a','transport':'responses'}),
   ('custom_providers',{'base_url':'','baseUrl':'https://ignored.invalid/v1','url':'https://fallback.invalid/v1','default_model':'a','api_mode':'','apiMode':'anthropic_messages'}),
   ('providers',{'api':'https://first.invalid/v1','base_url':'https://ignored.invalid/v1','default_model':'a','model':'ignored','api_mode':' CHAT_COMPLETIONS '}),
   ('providers',{'base_url':'https://api.anthropic.com/v1','default_model':'a','transport':'responses'}),
  ]
  for origin,fields in cases:
   with self.subTest(origin=origin,fields=fields):
    entry={'name':'fixture','models':[{'name':'a',**({'id':'a'} if origin=='providers' else {}),'context_length':12345}],'api_key':'fixture-secret',**fields}
    self.path.write_text(yaml.safe_dump({origin:[entry] if origin=='custom_providers' else {'fixture':entry}}));config.invalidate_env_cache()
    before=self.path.read_bytes();native=runtime_provider._get_named_custom_provider('custom:fixture');view=models.execute({'action':'read'},self.path,self.var/'panel-state',self.var)['providers'][0]
    actual=source.read_source(self.path,self.var,{'provider':'fixture','model':'a'})['target']
    self.assertEqual(actual['base_url'],native['base_url']);self.assertEqual(view['base_url'],native['base_url']);self.assertEqual(view['model'],native.get('model',''));self.assertEqual(view['api_mode'],native.get('api_mode',''));self.assertEqual(actual['api_mode'],native.get('api_mode') or runtime_provider._detect_api_mode_for_url(native['base_url']) or 'chat_completions');self.assertEqual(self.path.read_bytes(),before)
    current=models.execute({'action':'read'},self.path,self.var/'panel-state',self.var)
    models.execute({'action':'update','id':'fixture','revision':current['revision'],'changes':{'base_url':'https://changed.invalid/v1','api_mode':'','default_model':'b','models':[{'id':'a','name':'A'},{'id':'b','name':'B'}]}},self.path,self.var/'panel-state',self.var)
    config.invalidate_env_cache();native=runtime_provider._get_named_custom_provider('custom:fixture');self.assertEqual(native['base_url'],'https://changed.invalid/v1');self.assertEqual(native['model'],'b');self.assertNotIn('api_mode',native);self.assertFalse(native['api_key'])
    view=models.execute({'action':'read'},self.path,self.var/'panel-state',self.var)['providers'][0];self.assertEqual(view['model'],'b');self.assertEqual(view['api_mode'],'')
    if origin=='custom_providers':
     saved=config.read_raw_config()[origin][0];self.assertEqual(saved['models'][0]['context_length'],12345)
 def test_provider_mirror_rotation_reaches_native_resolver(self):
  from hermes_cli.credential_lifecycle import save_provider_env_credential
  self.path.write_text('providers: {fixture: {name: fixture, base_url: https://fixture.invalid/v1, default_model: a, models: [a], api_key: old-key}}\n');(self.home/'.env').write_text('OPENAI_API_KEY=old-key\n');config.invalidate_env_cache();save_provider_env_credential('OPENAI_API_KEY','new-key');self.assertEqual(runtime_provider._get_named_custom_provider('custom:fixture')['api_key'],'new-key');self.assertEqual(source.read_source(self.path,self.var,{'provider':'fixture','model':'a'})['target']['api_key'],'new-key')
if __name__=='__main__':
 try:unittest.main()
 finally:fixture.temporary.cleanup()
