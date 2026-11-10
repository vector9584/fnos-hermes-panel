import importlib.util,json,multiprocessing,os,tempfile,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
spec=importlib.util.spec_from_file_location('model_source',ROOT/'app/server/panel-model-source.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
def crash_bundle(config,var):
 from panel_config_bundle import commit_bundle
 from panel_config_txn import config_lock
 config=Path(config);root=Path(var)/'panel-state';before=config.read_bytes();env=config.parent/'.env';old=env.read_bytes()
 with config_lock(root):commit_bundle(root,[(config,before,before.replace(b'one.invalid',b'updated.invalid')),(env,old,b'ONE_KEY=updated-key\n')],'fixture',after_publish=lambda i:os._exit(71))
class SourceTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(prefix='model-source-',dir='/tmp');self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name).resolve();self.config=self.root/'config.yaml';self.var=self.root/'var';self.var.mkdir()
  self.config.write_text('''providers:
  one:
    name: 服务甲
    base_url: https://one.invalid/v1
    api_key: ${ONE_KEY}
    default_model: same
    models: [same, alternate]
    extra_headers: {x-fixture: "${ONE_KEY}"}
    extra_body: {reasoning: {enabled: false}}
  two:
    name: 服务乙
    base_url: https://two.invalid/v1
    key_env: TWO_KEY
    default_model: same
    transport: codex_responses
  disabled:
    enabled: false
    default_model: same
''');(self.root/'.env').write_text("ONE_KEY='first-secret'\n");(self.var/'.env.providers').write_text('TWO_KEY="second-secret"\n')
 def test_public_catalog_preserves_same_model_providers_without_secrets(self):
  before=self.config.read_bytes();result=module.read_source(self.config,self.var,{'action':'catalog'});self.assertEqual([p['id'] for p in result['providers']],['one','two']);self.assertNotIn('secret',json.dumps(result));self.assertEqual(self.config.read_bytes(),before)
 def test_selected_credentials_transport_and_fields(self):
  first=module.read_source(self.config,self.var,{'provider':'one','model':'same'})['target'];self.assertEqual(first['api_key'],'first-secret');self.assertEqual(first['headers']['x-fixture'],'first-secret');self.assertEqual(first['extra_body'],{'reasoning':{'enabled':False}})
  second=module.read_source(self.config,self.var,{'provider':'two','model':'same'})['target'];self.assertEqual(second['api_key'],'second-secret');self.assertEqual(second['api_mode'],'codex_responses');self.assertEqual(second['base_url'],'https://two.invalid/v1')
 def test_unconfigured_model_provider_and_missing_secret_rejected(self):
  for req in [{'provider':'three','model':'same'},{'provider':'one','model':'absent'},{'provider':'disabled','model':'same'}]:
   with self.assertRaises(module.Failure):module.read_source(self.config,self.var,req)
  (self.root/'.env').write_text('')
  with self.assertRaises(module.Failure):module.read_source(self.config,self.var,{'provider':'one','model':'same'})
 def test_model_mapping_and_protocol_detection(self):
  self.config.write_text('providers: {one: {name: one, base_url: https://api.anthropic.com/v1, default_model: a, models: {a: {}, b: {enabled: false}}}}\n')
  result=module.read_source(self.config,self.var,{'action':'catalog'});self.assertEqual(result['providers'][0]['models'],['a'])
  self.assertEqual(module.read_source(self.config,self.var,{'provider':'one','model':'a'})['target']['api_mode'],'anthropic_messages')
 def test_broken_yaml_preserved(self):
  self.config.write_text('providers: [broken')
  with self.assertRaises(module.Failure):module.read_source(self.config,self.var,{'action':'catalog'})
  self.assertEqual(self.config.read_text(),'providers: [broken')
 def test_home_env_wins_provider_env_and_explicit_empty_is_not_missing(self):
  (self.var/'.env.providers').write_text('ONE_KEY=wrong-key\nTWO_KEY=old-provider-key\n')
  (self.root/'.env').write_text('ONE_KEY=correct-key\nTWO_KEY=\n')
  first=module.read_source(self.config,self.var,{'provider':'one','model':'same'})['target'];self.assertEqual(first['api_key'],'correct-key');self.assertEqual(first['headers']['x-fixture'],'correct-key')
  with self.assertRaises(module.Failure):module.read_source(self.config,self.var,{'provider':'two','model':'same'})
 def test_valid_key_env_does_not_require_unused_inline_reference(self):
  self.config.write_text('providers: {one: {name: one, base_url: https://one.invalid/v1, default_model: a, key_env: ONE_KEY, api_key: "${UNUSED_MISSING_KEY}"}}\n')
  result=module.read_source(self.config,self.var,{'provider':'one','model':'a'})['target'];self.assertEqual(result['api_key'],'first-secret')
 def test_malformed_and_linked_env_are_rejected_without_exposing_secret(self):
  path=self.root/'.env';path.write_text('ONE_KEY="unterminated-secret\n')
  with self.assertRaises(module.Failure) as error:module.read_source(self.config,self.var,{'provider':'one','model':'same'})
  self.assertNotIn('unterminated-secret',str(error.exception));self.assertIn('无法解析',str(error.exception))
  path.unlink();target=self.root/'secret-copy';target.write_text('ONE_KEY=private\n');path.symlink_to(target)
  with self.assertRaises(module.Failure):module.read_source(self.config,self.var,{'provider':'one','model':'same'})
 def test_interrupted_bundle_is_completed_before_target_is_selected(self):
  from panel_config_bundle import commit_bundle
  from panel_config_txn import config_lock
  state=self.var/'panel-state';before=self.config.read_bytes();env=self.root/'.env';old=env.read_bytes()
  child=multiprocessing.Process(target=crash_bundle,args=(self.config,self.var));child.start();child.join(10);self.assertEqual(child.exitcode,71)
  target=module.read_source(self.config,self.var,{'provider':'one','model':'same'})['target'];self.assertEqual(target['api_key'],'updated-key');self.assertEqual(target['base_url'],'https://updated.invalid/v1');self.assertFalse((state/'config-bundle-pending.json').exists())
if __name__=='__main__':unittest.main()
