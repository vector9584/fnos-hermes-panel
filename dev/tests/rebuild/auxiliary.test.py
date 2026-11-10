import importlib.util,json,tempfile,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
spec=importlib.util.spec_from_file_location('auxiliary',ROOT/'app/server/panel-auxiliary.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
SOURCE='''# keep this header
providers:
  openai-api:
    name: OpenAI
    api_key: ${SERVICE_SECRET}
    default_model: vision-new
    models: [vision-new, vision-alt]
model:
  provider: original
  default: main-model
auxiliary:
  vision:
    provider: custom
    model: vision-old
    base_url: https://fixture.invalid/v1
    api_key: ${FIXTURE_KEY}
    timeout: 111
    extra_body:
      reasoning:
        enabled: false
      nested: [one, two]
    fallback_chain:
      - provider: backup
        model: backup-model
        api_key: ${BACKUP_KEY}
        extra_body: {preserve: true}
  compression:
    provider: custom
    model: compress-old
    api_key: ${COMPRESS_KEY}
    extra_body:
      nested:
        value: retain
    timeout: 80
  free_only: true
mcp_servers:
  fixture:
    command: fixture
    env:
      TOKEN: ${MCP_TOKEN}
'''
class AuxiliaryTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(prefix='hermes-aux-',dir='/tmp');self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name).resolve();self.path=self.root/'config.yaml';self.path.write_text(SOURCE);self.backups=self.root/'backups'
 def read(self):return module.execute({'action':'read'},self.path,self.backups)['tasks']
 def update(self,key,changes,revision=None):
  task=next(t for t in self.read() if t['key']==key)
  return module.execute({'key':key,'revision':revision or task['revision'],'changes':changes},self.path,self.backups)
 def test_nested_and_unrelated_values_survive_and_secrets_never_return(self):
  before=module.document(self.path)[2];result=self.update('compression',{'model':'new-model'});after=module.document(self.path)[2]
  self.assertEqual(after['auxiliary']['compression']['extra_body'],before['auxiliary']['compression']['extra_body']);self.assertEqual(after['mcp_servers'],before['mcp_servers']);self.assertEqual(after['model'],before['model']);self.assertEqual(after['auxiliary']['vision'],before['auxiliary']['vision']);self.assertTrue(self.path.read_text().startswith('# keep this header'))
  self.assertNotIn('COMPRESS_KEY',json.dumps(result));self.assertNotIn('FIXTURE_KEY',json.dumps(result))
  files=list(self.backups.glob('*.yaml'));self.assertEqual(len(files),1);self.assertEqual(files[0].read_text(),SOURCE);self.assertEqual(files[0].stat().st_mode&0o777,0o600)
 def test_fallback_reorder_preserves_private_and_extra_fields(self):
  self.update('vision',{'fallback_chain':[{'provider':'another','model':'new'},{'source_index':0,'provider':'backup','model':'backup-model'}]})
  chain=module.document(self.path)[2]['auxiliary']['vision']['fallback_chain'];self.assertEqual(chain[1]['api_key'],'${BACKUP_KEY}');self.assertEqual(chain[1]['extra_body'],{'preserve':True})
 def test_endpoint_change_does_not_forward_old_credentials(self):
  self.update('vision',{'provider':'different','base_url':'https://other.invalid/v1','key_env':'OTHER_KEY'})
  vision=module.document(self.path)[2]['auxiliary']['vision'];self.assertNotIn('api_key',vision);self.assertEqual(vision['key_env'],'OTHER_KEY');self.assertIn('extra_body',vision)
 def test_auto_clears_only_endpoint_overrides(self):
  self.update('compression',{'provider':'auto'})
  task=module.document(self.path)[2]['auxiliary']['compression'];self.assertNotIn('model',task);self.assertNotIn('api_key',task);self.assertEqual(task['timeout'],80);self.assertIn('extra_body',task)
 def test_stale_revision_invalid_input_and_corrupt_file_do_not_write(self):
  before=self.path.read_bytes()
  for changes in [{'timeout':0},{'extra_body':{}},{'base_url':'https://user:pass@host/v1'}]:
   with self.assertRaises(module.Failure):self.update('vision',changes)
   self.assertEqual(self.path.read_bytes(),before)
  with self.assertRaises(module.Failure) as error:self.update('vision',{'model':'other'},'bad')
  self.assertEqual(error.exception.status,409);self.assertEqual(self.path.read_bytes(),before)
  self.path.write_text('auxiliary: [broken');broken=self.path.read_bytes()
  with self.assertRaises(module.Failure):self.read()
  self.assertEqual(self.path.read_bytes(),broken)
 def test_shared_yaml_alias_cannot_mutate_another_task(self):
  self.path.write_text('auxiliary: &shared\n  compression: {model: old}\ncopy: *shared\n');before=self.path.read_bytes()
  with self.assertRaises(module.Failure):self.update('compression',{'model':'changed'})
  self.assertEqual(self.path.read_bytes(),before)
 def test_services_use_canonical_ids_without_exposing_credentials(self):
  result=module.execute({'action':'read'},self.path,self.backups)
  self.assertEqual(result['services'][0],{'id':'custom:openai-api','name':'OpenAI','model':'vision-new','models':['vision-new','vision-alt']})
  self.assertNotIn('SERVICE_SECRET',json.dumps(result))
 def test_unchanged_save_is_byte_identical_and_does_not_add_defaults(self):
  self.update('vision',{})
  self.assertEqual(self.path.read_text(),SOURCE);self.assertFalse(list(self.backups.glob('*.yaml')))
 def test_replacing_key_reference_removes_precedent_inline_key(self):
  self.update('vision',{'key_env':'NEW_REFERENCE'})
  task=module.document(self.path)[2]['auxiliary']['vision'];self.assertNotIn('api_key',task);self.assertEqual(task['key_env'],'NEW_REFERENCE')
 def test_blank_timeout_restores_native_default_and_fallback_model_is_optional(self):
  self.update('vision',{'timeout':None,'fallback_chain':[{'provider':'openai-api'}]})
  task=module.document(self.path)[2]['auxiliary']['vision'];self.assertNotIn('timeout',task);self.assertEqual(task['fallback_chain'],[{'provider':'openai-api'}])
if __name__=='__main__':unittest.main()
