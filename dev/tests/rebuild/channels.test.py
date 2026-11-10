import importlib.util,json,sys,tempfile,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3];sys.path.insert(0,str(ROOT/'app/server'))
from panel_config_txn import ConfigError,load_yaml
from panel_env_txn import parse
spec=importlib.util.spec_from_file_location('channels',ROOT/'app/server/panel-channels.py');channels=importlib.util.module_from_spec(spec);spec.loader.exec_module(channels)
class Channels(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(dir='/tmp');self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name).resolve();self.path=self.root/'config.yaml';self.env=self.root/'.env';self.state=self.root/'state'
  self.path.write_text('# preserved\nmodel: keep\nplatforms:\n  qqbot:\n    enabled: true\n    extra:\n      app_id: original\n      client_secret: yaml-secret\n      stt: {provider: custom, model: old, other: keep}\n      dm_policy: allowlist\n      group_policy: disabled\n    channel_overrides: {chat1: {model: keep}}\nlegacy_assets: {skills: [one, two]}\n')
  self.env.write_text('# private\nQQ_APP_ID="fixture"\nQQ_CLIENT_SECRET="env-secret"\nOTHER="untouched"\n')
 def call(self,body):return channels.execute(body,self.path,self.state)
 def read(self):return self.call({'action':'read'})
 def save(self,changes,**extra):return self.call({'action':'save','id':'qqbot','revision':self.read()['revision'],'changes':changes,**extra})
 def test_read_masks_secrets_and_corrects_actual_names(self):
  data=self.read();encoded=json.dumps(data);self.assertNotIn('env-secret',encoded);self.assertNotIn('yaml-secret',encoded);qq=next(c for c in data['channels'] if c['id']=='qqbot');self.assertEqual(qq['values']['app_id'],'fixture');self.assertTrue(qq['secrets']['client_secret']['configured']);self.assertEqual(qq['values']['dm_policy'],'allowlist')
  fields={c['id']:{f['env'] for f in c['fields']} for c in data['channels']};self.assertIn('EMAIL_PASSWORD',fields['email']);self.assertNotIn('EMAIL_IMAP_PASSWORD',fields['email']);self.assertIn('TEAMS_CLIENT_ID',fields['teams']);self.assertIn('TWILIO_PHONE_NUMBER',fields['sms']);self.assertIn('SLACK_APP_TOKEN',fields['slack']);self.assertNotIn('QQ_APP_ID_2',fields['qqbot'])
 def test_structured_save_preserves_nested_unknowns_policies_comments_and_secrets(self):
  result=self.save({'stt_model':'new-model','client_secret':{'action':'keep'}},enabled=False);self.assertTrue(result['changed']);raw=self.path.read_bytes();_,data=load_yaml(raw);cfg=data['platforms']['qqbot'];self.assertEqual(cfg['extra']['stt'],{'provider':'custom','model':'new-model','other':'keep'});self.assertEqual(cfg['extra']['group_policy'],'disabled');self.assertEqual(cfg['channel_overrides']['chat1']['model'],'keep');self.assertFalse(cfg['enabled']);self.assertTrue(raw.startswith(b'# preserved'));self.assertEqual(parse(self.env.read_bytes())[1]['QQ_CLIENT_SECRET'],'env-secret');self.assertEqual(parse(self.env.read_bytes())[1]['OTHER'],'untouched')
 def test_secret_clear_updates_existing_yaml_and_env_no_returned_value(self):
  result=self.save({'client_secret':{'action':'clear'}});self.assertNotIn('secret',json.dumps(result['channel']['values']));self.assertFalse(result['channel']['secrets']['client_secret']['configured']);self.assertNotIn('yaml-secret',self.path.read_text());self.assertEqual(parse(self.env.read_bytes())[1]['QQ_CLIENT_SECRET'],'')
 def test_secret_replacement_creates_no_new_yaml_copy_and_undo_restores_exact_files(self):
  before=(self.path.read_bytes(),self.env.read_bytes());result=self.save({'stt_key':{'action':'replace','value':'new-secret'}});self.assertNotIn('new-secret',self.path.read_text());self.assertNotIn('new-secret',json.dumps(result));self.assertEqual(parse(self.env.read_bytes())[1]['QQ_STT_API_KEY'],'new-secret');self.call({'action':'restore','id':'qqbot','revision':self.read()['revision'],'change_id':result['change_id']});self.assertEqual((self.path.read_bytes(),self.env.read_bytes()),before)
 def test_stale_read_and_invalid_edit_do_not_publish_either_file(self):
  revision=self.read()['revision'];self.env.write_text(self.env.read_text()+'LATER=preserve\n');before=(self.path.read_bytes(),self.env.read_bytes())
  for body in [{'action':'save','id':'qqbot','revision':revision,'changes':{'app_id':'stale'}},{'action':'save','id':'qqbot','revision':self.read()['revision'],'changes':{'app_id':'first','extra.fake':'bad'}},{'action':'save','id':'qqbot','revision':self.read()['revision'],'changes':{'client_secret':{'action':'replace','value':'newline\nINJECT=1'}}}]:
   with self.assertRaises(ConfigError):self.call(body)
   self.assertEqual((self.path.read_bytes(),self.env.read_bytes()),before)
 def test_toggle_updates_winning_layers_without_changing_credentials(self):
  self.path.write_text(self.path.read_text()+'gateway:\n  platforms:\n    qqbot: {enabled: true}\n  qqbot: {enabled: true, extra: {foreign: keep}}\nqqbot: {enabled: true}\n');env=self.env.read_bytes();self.call({'action':'toggle','id':'qqbot','revision':self.read()['revision'],'enabled':False});_,data=load_yaml(self.path.read_bytes());self.assertFalse(channels.effective(data,{},'qqbot')['enabled']);self.assertEqual(data['gateway']['qqbot']['extra']['foreign'],'keep');self.assertEqual(self.env.read_bytes(),env)
 def test_enable_rejects_incomplete_credentials_and_unknown_settings(self):
  revision=self.read()['revision'];before=(self.path.read_bytes(),self.env.read_bytes())
  with self.assertRaises(ConfigError):self.call({'action':'toggle','id':'email','revision':revision,'enabled':True})
  with self.assertRaises(ConfigError):self.save({'skills':['fake-tool']})
  self.assertEqual((self.path.read_bytes(),self.env.read_bytes()),before)
 def test_noop_keeps_exact_bytes_and_unknown_old_assets(self):
  before=(self.path.read_bytes(),self.env.read_bytes());self.assertFalse(self.save({'client_secret':{'action':'keep'}})['changed']);self.assertEqual((self.path.read_bytes(),self.env.read_bytes()),before)
 def test_access_defaults_save_and_exact_undo_preserve_credentials(self):
  initial=self.read();self.assertTrue(initial['access']['values']['global_allow_all']);self.assertEqual(initial['access']['source'],'application_default')
  before=(self.path.read_bytes(),self.env.read_bytes());result=self.call({'action':'save','id':'gateway-access','revision':initial['revision'],'changes':{'global_allow_all':False}})
  self.assertFalse(self.read()['access']['values']['global_allow_all']);self.assertEqual(self.path.read_bytes(),before[0]);self.assertEqual(parse(self.env.read_bytes())[1]['QQ_CLIENT_SECRET'],'env-secret')
  self.call({'action':'restore','id':'gateway-access','revision':self.read()['revision'],'change_id':result['change_id']});self.assertEqual((self.path.read_bytes(),self.env.read_bytes()),before)
 def test_access_provider_precedence_empty_override_and_revision_conflict(self):
  provider=self.state.parent/'.env.providers';provider.write_text('GATEWAY_ALLOW_ALL_USERS=false\nQQ_ALLOW_ALL_USERS=true\nPRIVATE=provider-secret\n')
  initial=self.read();self.assertFalse(initial['access']['values']['global_allow_all']);self.assertEqual(initial['access']['source'],'providers');qq=next(c for c in initial['channels'] if c['id']=='qqbot');self.assertTrue(qq['values']['allow_all_users']);self.assertNotIn('provider-secret',json.dumps(initial))
  provider.write_text('GATEWAY_ALLOW_ALL_USERS=true\n')
  with self.assertRaises(ConfigError):self.call({'action':'save','id':'gateway-access','revision':initial['revision'],'changes':{'global_allow_all':False}})
  self.env.write_text(self.env.read_text()+'GATEWAY_ALLOW_ALL_USERS=\nQQ_ALLOW_ALL_USERS=\n');self.assertFalse(self.read()['access']['values']['global_allow_all']);self.assertFalse(next(c for c in self.read()['channels'] if c['id']=='qqbot')['values']['allow_all_users'])
 def test_six_platform_auth_flags_are_env_only_and_boolean(self):
  before=self.path.read_bytes()
  for name,prefix in channels.AUTH_PREFIXES.items():
   result=self.call({'action':'save','id':name,'revision':self.read()['revision'],'changes':{'allow_all_users':True}});self.assertTrue(result['channel']['values']['allow_all_users']);self.assertEqual(parse(self.env.read_bytes())[1][prefix+'_ALLOW_ALL_USERS'],'true')
  self.assertEqual(self.path.read_bytes(),before)
  with self.assertRaises(ConfigError):self.save({'allow_all_users':'false'})
  with self.assertRaises(ConfigError):self.call({'action':'save','id':'gateway-access','revision':self.read()['revision'],'enabled':True,'changes':{}})
if __name__=='__main__':unittest.main()
