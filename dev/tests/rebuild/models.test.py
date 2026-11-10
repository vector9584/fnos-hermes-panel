import importlib.util,json,sys,tempfile,unittest
from pathlib import Path
TMP='/private/tmp' if sys.platform=='darwin' else '/tmp'
ROOT=Path(__file__).resolve().parents[3];sys.path.insert(0,str(ROOT/'app/server'))
spec=importlib.util.spec_from_file_location('models',ROOT/'app/server/panel-models.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class ModelsTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(dir=TMP);self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name);self.path=self.root/'config.yaml';self.state=self.root/'state'
  self.path.write_text('''# keep-comment
model: {provider: one, default: a, temperature: 0.33, max_tokens: 6000}
providers:
  one:
    name: 同名
    base_url: https://one.invalid/v1
    api_key: ${ONE_KEY}
    default_model: a
    extra_headers: {Authorization: secret-header}
    extra_body: {reasoning: {enabled: false}}
    models: [a, {id: b, context_length: 123456, capabilities: [text, image]}]
  two: {name: 同名, base_url: https://two.invalid/v1, default_model: c, models: [c], api_key: second-secret}
fallback_providers: [{provider: two, model: c, base_url: https://two.invalid/special, api_key: route-secret, extra: {keep: yes}}]
fallback_model: {provider: one, model: b}
memory: {enabled: true}
''')
 def call(self,**body):
  body.setdefault('revision',self.read()['revision']);return m.execute(body,self.path,self.state)
 def read(self):return m.execute({'action':'read'},self.path,self.state)
 def data(self):return m.load_yaml(self.path.read_bytes())[1]
 def test_read_only_redaction_stable_ids_and_native_chain(self):
  raw=self.path.read_bytes();out=self.read();self.assertEqual([p['id'] for p in out['providers']],['one','two']);self.assertEqual(len(out['fallbacks']),2);self.assertNotIn('secret',json.dumps(out));self.assertNotIn('ONE_KEY',json.dumps(out));self.assertEqual(raw,self.path.read_bytes())
  spec=importlib.util.spec_from_file_location('native',ROOT.parent/'full-audit/python/hermes_cli/fallback_config.py') if (ROOT.parent/'full-audit/python/hermes_cli/fallback_config.py').exists() else None
  if spec:
   native=importlib.util.module_from_spec(spec);spec.loader.exec_module(native);self.assertEqual([v for _,_,v in m.effective_chain(self.data())],native.get_fallback_chain(self.data()))
 def test_edit_preserves_credentials_models_unknown_fields_and_primary(self):
  before=self.data();result=self.call(action='update',id='one',changes={'name':'改名','models':[{'id':'a','name':'A','enabled':True},{'id':'b','name':'B','enabled':True}]});data=self.data()
  self.assertEqual(data['model'],before['model']);self.assertEqual(data['providers']['one']['api_key'],'${ONE_KEY}');self.assertEqual(data['providers']['one']['models'][1]['context_length'],123456);self.assertEqual(data['providers']['one']['extra_body'],before['providers']['one']['extra_body']);self.assertIn('# keep-comment',self.path.read_text());self.assertTrue(result['changed'])
 def test_version_conflicts_but_unrelated_fields_merge(self):
  rev=self.read()['revision'];self.path.write_text(self.path.read_text().replace('memory: {enabled: true}','memory: {enabled: false}'));self.call(action='update',id='one',revision=rev,changes={'name':'changed'});self.assertFalse(self.data()['memory']['enabled'])
  with self.assertRaises(m.ConfigError) as error:self.call(action='update',id='two',revision=rev,changes={'name':'stale'})
  self.assertEqual(error.exception.status,409)
 def test_host_change_does_not_forward_keys_or_headers(self):
  self.call(action='update',id='one',changes={'base_url':'https://other.invalid/v1','credential':{'action':'keep'}});entry=self.data()['providers']['one'];self.assertNotIn('api_key',entry);self.assertNotIn('extra_headers',entry)
  self.call(action='update',id='one',changes={'credential':{'action':'replace','value':'new-secret'}});self.assertEqual(self.data()['providers']['one']['api_key'],'new-secret');self.assertNotIn('new-secret',json.dumps(self.read()))
 def test_route_guard_and_reorder_keep_private_overrides(self):
  with self.assertRaises(m.ConfigError):self.call(action='toggle',id='two',enabled=False)
  chain=self.read()['fallbacks'];self.call(action='fallback',entries=list(reversed(chain)));data=self.data();self.assertNotIn('fallback_model',data);self.assertEqual(data['fallback_providers'][1]['api_key'],'route-secret');self.assertEqual(data['fallback_providers'][1]['extra'],{'keep':'yes'})
  self.call(action='fallback',entries=[]);self.call(action='toggle',id='two',enabled=False);self.assertFalse(self.data()['providers']['two']['enabled']);self.assertEqual(self.data()['providers']['two']['api_key'],'second-secret')
 def test_primary_is_explicit_and_restore_preserves_other_settings(self):
  before=m.subset(self.data());result=self.call(action='primary',provider='two',model='c');self.assertEqual(self.data()['model']['temperature'],.33);self.path.write_text(self.path.read_text().replace('memory: {enabled: true}','memory: {enabled: false}'));self.call(action='restore',change_id=result['change_id']);self.assertEqual(m.subset(self.data()),before);self.assertFalse(self.data()['memory']['enabled'])
 def test_primary_and_fallback_models_save_atomically_and_allow_same_provider(self):
  result=self.call(action='routes',provider='one',model='b',entries=[{'provider':'one','model':'a'},{'provider':'two','model':'c'}]);data=self.data()
  self.assertEqual(data['model']['default'],'b');self.assertEqual([(x['provider'],x['model']) for x in data['fallback_providers']],[('one','a'),('two','c')]);self.assertEqual(len(result['fallbacks']),2)
  before=self.path.read_bytes()
  with self.assertRaises(m.ConfigError):self.call(action='routes',provider='one',model='a',entries=[{'key':result['fallbacks'][0]['key']},{'provider':'two','model':'c'}])
  self.assertEqual(self.path.read_bytes(),before)
  with self.assertRaises(m.ConfigError):self.call(action='fallback',entries=[{'provider':'one','model':'b'}])
  self.assertEqual(self.path.read_bytes(),before)
 def test_switching_same_provider_primary_keeps_service_default_explicit(self):
  # The provider's own default is independent from the global route. Switching
  # A/B must never silently select the first model or erase the old model's
  # ability to be a fallback.
  self.call(action='routes',provider='one',model='b',entries=[{'provider':'one','model':'a'}])
  first=self.data();self.assertEqual(first['providers']['one']['default_model'],'a')
  self.assertEqual(first['model']['default'],'b');self.assertEqual(first['fallback_providers'][0]['model'],'a')
  self.call(action='routes',provider='one',model='a',entries=[{'provider':'one','model':'b'}])
  second=self.data();self.assertEqual(second['providers']['one']['default_model'],'a')
  self.assertEqual(second['model']['default'],'a');self.assertEqual(second['fallback_providers'][0]['model'],'b')
  before=self.path.read_bytes()
  with self.assertRaises(m.ConfigError):self.call(action='routes',provider='one',model='a',entries=[{'provider':'one','model':'a'}])
  self.assertEqual(self.path.read_bytes(),before)
 def test_create_and_invalid_input_never_corrupt_original(self):
  before=self.path.read_bytes()
  for changes in [{'base_url':'https://user:password@example.invalid','default_model':'a'},{'default_model':'a','models':[{'id':'a'},{'id':'a'}]}]:
   with self.assertRaises(m.ConfigError):self.call(action='create',changes=changes)
   self.assertEqual(before,self.path.read_bytes())
  out=self.call(action='create',changes={'name':'新服务','base_url':'https://new.invalid/v1','default_model':'x','models':[{'id':'x'}],'api_mode':'codex_responses'});self.assertTrue(out['id'].startswith('custom_'));self.assertEqual(self.data()['model']['provider'],'one')
 def test_hidden_historical_models_and_metadata_preserved(self):
  legacy={'one':[{'id':'historical','name':'保留模型','enabled':False,'context_window':12345,'supports_reasoning':True}]};sidecar=self.root/'provider-models.json';sidecar.write_text(json.dumps(legacy));before=sidecar.read_bytes()
  catalog=m.execute({'action':'read'},self.path,self.state,self.root);one=catalog['providers'][0];self.assertEqual(one['models'][-1]['id'],'historical');self.assertFalse(one['models'][-1]['enabled'])
  one['models'][-1]['enabled']=True;m.execute({'action':'update','id':'one','revision':catalog['revision'],'changes':{'models':one['models']}},self.path,self.state,self.root)
  row=self.data()['providers']['one']['models'][-1];self.assertEqual(row['context_window'],12345);self.assertTrue(row['supports_reasoning']);self.assertEqual(sidecar.read_bytes(),before)
 def test_alias_routes_cannot_be_disabled(self):
  self.path.write_text(self.path.read_text().replace('provider: one, default: a','provider: custom:one, default: a'))
  with self.assertRaises(m.ConfigError):self.call(action='toggle',id='one',enabled=False)
 def test_mapping_models_and_undo_cannot_erase_later_changes(self):
  self.path.write_text('providers: {one: {name: one, base_url: https://one.invalid, default_model: a, models: {a: {context_length: 123}}}}\n')
  first=self.call(action='update',id='one',changes={'models':[{'id':'a','name':'A','enabled':True}]});self.assertEqual(self.data()['providers']['one']['models']['a']['context_length'],123)
  self.call(action='update',id='one',changes={'name':'later'})
  with self.assertRaises(m.ConfigError):self.call(action='restore',change_id=first['change_id'])
 def test_broken_yaml_and_legacy_service_preserved(self):
  self.path.write_text('providers: [broken');before=self.path.read_bytes()
  with self.assertRaises(m.ConfigError):self.read()
  self.assertEqual(before,self.path.read_bytes());self.path.write_text('custom_providers: [{name: legacy, base_url: https://old.invalid/v1, model: a, api_key: legacy-secret}]\n')
  self.call(action='update',id='legacy',changes={'note':'保留旧条目'});data=self.data();self.assertNotIn('providers',data);self.assertEqual(data['custom_providers'][0]['api_key'],'legacy-secret')
 def test_independent_pool_view_is_redacted_scoped_and_read_only(self):
  auth=self.root/'auth.json';auth.write_text(json.dumps({'credential_pool':{'custom:同名':[{'id':'secret-id','label':'private-label','source':'manual:secret-source','access_token':'private-token','base_url':'https://one.invalid/v1','last_status':'exhausted'},{'source':'manual','access_token':'ambiguous-key'},{'source':'config:同名','access_token':'configured-secret','base_url':'https://one.invalid/v1'}]}}));before=auth.read_bytes();view=self.read();one=view['providers'][0]['credential_pool'];two=view['providers'][1]['credential_pool'];self.assertEqual(one['independent_count'],1);self.assertEqual(one['entries'][0]['status'],'等待额度恢复');self.assertEqual(one['excluded_count'],1);self.assertEqual(two['independent_count'],0);self.assertEqual(two['excluded_count'],2)
  public=json.dumps(view)
  for secret in ['private-token','private-label','secret-source','secret-id','configured-secret','ambiguous-key']:self.assertNotIn(secret,public)
  self.assertEqual(auth.read_bytes(),before)
 def test_clear_config_key_keeps_independent_pool_and_reports_it(self):
  auth=self.root/'auth.json';auth.write_text(json.dumps({'credential_pool':{'custom:同名':[{'source':'manual','access_token':'independent-key','base_url':'https://one.invalid/v1'}]}}));before=auth.read_bytes();result=self.call(action='update',id='one',changes={'credential':{'action':'clear'}});self.assertFalse(result['providers'][0]['api_key_configured']);self.assertEqual(result['providers'][0]['credential_pool']['independent_count'],1);self.assertEqual(auth.read_bytes(),before)
 def test_alias_keys_removed_on_endpoint_change_and_replace_without_changing_unrelated_fields(self):
  self.path.write_text('custom_providers: [{name: legacy, base_url: https://old.invalid/v1, model: a, apiKey: alias-secret, apiKeyEnv: SOME_KEY, api_key_env: OTHER_KEY, note: keep}]\n')
  view=self.read();self.assertTrue(view['providers'][0]['api_key_configured'])
  self.call(action='update',id='legacy',changes={'base_url':'https://new.invalid/v1'})
  entry=self.data()['custom_providers'][0];self.assertFalse(any(k in entry for k in m.CREDENTIAL_FIELDS));self.assertEqual(entry['note'],'keep')
  self.path.write_text('custom_providers: [{name: legacy, base_url: https://old.invalid/v1, model: a, apiKey: alias-secret, keyEnv: SOME_KEY}]\n')
  self.call(action='update',id='legacy',changes={'credential':{'action':'replace','value':'replacement'}})
  entry=self.data()['custom_providers'][0];self.assertEqual(entry['api_key'],'replacement');self.assertNotIn('apiKey',entry);self.assertNotIn('keyEnv',entry)
 def test_new_provider_ignored_alias_is_not_reported_as_a_working_config_key(self):
  self.path.write_text('providers: {one: {base_url: https://one.invalid/v1, default_model: a, api_key_env: IGNORED_KEY}}\n')
  self.assertFalse(self.read()['providers'][0]['api_key_configured'])
 def test_legacy_endpoint_scope_defaults_and_alias_edits(self):
  self.path.write_text('custom_providers: [{name: legacy, baseUrl: https://actual.invalid/v1, api: https://ignored.invalid/v1, defaultModel: a, apiMode: anthropic_messages, apiKey: secret, models: [{name: a, context_length: 9876}]}]\n')
  auth=self.root/'auth.json';auth.write_text(json.dumps({'credential_pool':{'custom:legacy':[{'source':'manual','access_token':'independent','base_url':'https://actual.invalid/v1'}]}}));auth_before=auth.read_bytes()
  view=self.read()['providers'][0];self.assertEqual(view['base_url'],'https://actual.invalid/v1');self.assertEqual(view['model'],'a');self.assertEqual(view['credential_pool']['independent_count'],1)
  self.call(action='update',id='legacy',changes={'base_url':'https://actual.invalid/v2','api_mode':''});entry=self.data()['custom_providers'][0];self.assertEqual(entry['apiKey'],'secret');self.assertNotIn('baseUrl',entry);self.assertNotIn('apiMode',entry)
  self.call(action='update',id='legacy',changes={'base_url':'https://ignored.invalid/v1'});self.assertFalse(self.read()['providers'][0]['api_key_configured']);self.assertEqual(auth.read_bytes(),auth_before)
 def test_legacy_name_model_can_be_disabled_without_losing_metadata(self):
  self.path.write_text('custom_providers: [{name: legacy, base_url: https://actual.invalid/v1, model: a, models: [{name: a, context_length: 9876}, {name: b, context_length: 1234}]}]\n')
  self.call(action='update',id='legacy',changes={'models':[{'id':'a','name':'A'}]})
  rows=self.data()['custom_providers'][0]['models'];self.assertEqual(rows[1]['id'],'b');self.assertEqual(rows[1]['context_length'],1234);self.assertFalse(rows[1]['enabled'])
 def test_broken_pool_cannot_turn_save_into_false_success(self):
  auth=self.root/'auth.json';auth.write_text('broken');before=self.path.read_bytes()
  with self.assertRaises(m.ConfigError):self.read()
  revision=m.revision(m.subset(self.data()))
  with self.assertRaises(m.ConfigError):m.execute({'action':'update','id':'one','revision':revision,'changes':{'name':'new'}},self.path,self.state)
  self.assertEqual(before,self.path.read_bytes());self.assertEqual(auth.read_text(),'broken')
if __name__=='__main__':unittest.main()
