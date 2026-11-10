"""Save real panel fields, then load candidate native gateway config in a
fixture secret scope. Extract adapter hooks by AST, never import an adapter."""
import ast,importlib.util,json,os,sys,types,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3];sys.path.insert(0,str(ROOT/'app/server'))
def module_file(name,file):
 spec=importlib.util.spec_from_file_location(name,file);module=importlib.util.module_from_spec(spec);sys.modules[name]=module;spec.loader.exec_module(module);return module
fixture=module_file('channel_native_fixture',Path(__file__).with_name('channel-enabled.test.py'));native=fixture.module;HOME=fixture.HOME
panel=module_file('channels_candidate',ROOT/'app/server/panel-channels.py')
from panel_env_txn import parse
from panel_channel_schema import CATALOG
SOURCE=Path('/vol1/@appcenter/hermes-agent/hermes-src')
class NativeChannels(unittest.TestCase):
 def setUp(self):
  self.old=dict(os.environ);os.environ.clear();os.environ.update(HOME=str(HOME),HERMES_HOME=str(HOME),HERMES_PANEL_CONFIG_ROOT=str(HOME),HERMES_PANEL_STATE_DIR=str(HOME/'state'),HERMES_MANAGED_DIR=str(HOME/'no-managed'));self.addCleanup(lambda:(os.environ.clear(),os.environ.update(self.old)));self.path=HOME/'config.yaml';self.path.write_text('model: test\n');self.env=HOME/'.env';self.env.write_text('');(HOME/'gateway.json').write_text('{}')
 def save(self,name,changes,**options):
  read=panel.execute({'action':'read'},self.path,HOME/'state');return panel.execute({'action':'save','id':name,'revision':read['revision'],'changes':changes,**options},self.path,HOME/'state')
 def load(self):
  os.environ.update({k:v for k,v in parse(self.env.read_bytes())[1].items() if v is not None});return native.load_gateway_config()
 def test_credentials_flow_into_real_config_and_explicit_disable_survives(self):
  cases={
   'telegram':({'token':{'action':'replace','value':'fixture'}},'token','fixture'),
   'discord':({'token':{'action':'replace','value':'fixture'}},'token','fixture'),
   'qqbot':({'app_id':'fixture','client_secret':{'action':'replace','value':'fixture'}},'extra.client_secret','fixture'),
   'weixin':({'account_id':'fixture','token':{'action':'replace','value':'fixture'}},'token','fixture'),
   'wecom':({'bot_id':'fixture','secret':{'action':'replace','value':'fixture'}},'extra.secret','fixture'),
   'feishu':({'app_id':'fixture','app_secret':{'action':'replace','value':'fixture'}},'extra.app_secret','fixture'),
   'dingtalk':({'client_id':'fixture','client_secret':{'action':'replace','value':'fixture'}},'extra.client_secret','fixture'),
   'matrix':({'homeserver':'https://fixture.invalid','token':{'action':'replace','value':'fixture'}},'extra.homeserver','https://fixture.invalid'),
   'mattermost':({'url':'https://fixture.invalid','token':{'action':'replace','value':'fixture'}},'extra.url','https://fixture.invalid'),
   'homeassistant':({'url':'http://127.0.0.1:8123','token':{'action':'replace','value':'fixture'}},'token','fixture'),
   'email':({'address':'fixture@example.invalid','password':{'action':'replace','value':'fixture'},'imap_host':'imap.invalid','smtp_host':'smtp.invalid'},'extra.address','fixture@example.invalid'),
   'sms':({'account_sid':'fixture','auth_token':{'action':'replace','value':'fixture'},'phone_number':'+15555550101'},'api_key','fixture'),
  }
  for name,(changes,path,expected) in cases.items():
   with self.subTest(name=name):
    self.save(name,changes,enabled=False);loaded=self.load().platforms[native.Platform(name)];self.assertFalse(loaded.enabled);actual=loaded
    for part in path.split('.'):actual=actual[part] if isinstance(actual,dict) else getattr(actual,part)
    self.assertEqual(actual,expected)
 def test_shared_settings_and_access_policies_follow_real_merge_order(self):
  self.path.write_text('gateway:\n  platforms:\n    qqbot: {enabled: true, typing_indicator: true, dm_policy: open}\n  qqbot: {typing_indicator: true, extra: {group_policy: open}}\nplatforms:\n  qqbot: {enabled: true, typing_indicator: true, extra: {dm_policy: open}}\nqqbot: {enabled: true, dm_policy: open, group_policy: open}\n')
  self.save('qqbot',{'typing_indicator':False,'dm_policy':'allowlist','group_policy':'disabled','allow_from':['person1','person2']},enabled=False);cfg=self.load().platforms[native.Platform.QQBOT];self.assertFalse(cfg.enabled);self.assertFalse(cfg.typing_indicator);self.assertEqual(cfg.extra['dm_policy'],'allowlist');self.assertEqual(cfg.extra['group_policy'],'disabled');self.assertEqual(cfg.extra['allow_from'],['person1','person2'])
 def test_clear_legacy_yaml_token_does_not_reappear_from_gateway_json(self):
  (HOME/'gateway.json').write_text('{"platforms":{"telegram":{"token":"legacy-secret","enabled":false}}}');self.save('telegram',{'token':{'action':'clear'}});cfg=self.load().platforms[native.Platform.TELEGRAM];self.assertFalse(cfg.token)
 def test_adapter_yaml_precedence_and_display_agree(self):
  self.path.write_text('platforms:\n  telegram: {extra: {require_mention: false, free_response_chats: [room]}}\n');self.env.write_text('TELEGRAM_REQUIRE_MENTION=true\nTELEGRAM_FREE_RESPONSE_CHATS=wrong\n');display=next(c for c in panel.execute({'action':'read'},self.path,HOME/'state')['channels'] if c['id']=='telegram');self.assertFalse(display['values']['require_mention']);self.assertEqual(display['values']['free_response_chats'],['room'])
  config=self.load().platforms[native.Platform.TELEGRAM];tree=ast.parse((SOURCE/'plugins/platforms/telegram/adapter.py').read_text());node=next(n for n in ast.walk(tree) if isinstance(n,ast.FunctionDef) and n.name=='_telegram_require_mention');scope={'os':os};exec(compile(ast.fix_missing_locations(ast.Module(body=[node],type_ignores=[])),'fixture-runtime','exec'),scope);self.assertEqual(scope['_telegram_require_mention'](types.SimpleNamespace(config=config)),display['values']['require_mention'])
 def test_discord_behavior_display_matches_real_adapter_precedence(self):
  self.path.write_text('platforms: {discord: {extra: {require_mention: false, allowed_channels: [room], ignored_channels: [blocked], allow_from: [person]}}}\n');self.env.write_text('DISCORD_REQUIRE_MENTION=true\nDISCORD_ALLOWED_CHANNELS=wrong\nDISCORD_ALLOWED_USERS=wrong\n')
  view=next(c for c in panel.execute({'action':'read'},self.path,HOME/'state')['channels'] if c['id']=='discord');self.assertFalse(view['values']['require_mention']);self.assertEqual(view['values']['allowed_channels'],['room']);self.assertEqual(view['values']['allowed_users'],['person'])
  self.save('discord',{'require_mention':True,'allowed_channels':['new-room'],'allowed_users':['new-person']});cfg=self.load().platforms[native.Platform.DISCORD];self.assertTrue(cfg.extra['require_mention']);self.assertEqual(cfg.extra['allowed_channels'],['new-room']);self.assertEqual(cfg.extra['allow_from'],['new-person']);self.assertEqual(cfg.extra['ignored_channels'],['blocked'])
 def test_feishu_mentions_env_fallback_and_yaml_precedence(self):
  self.path.write_text('platforms: {feishu: {extra: {group_rules: {room: {policy: disabled}}, admins: [keep]}}}\n');self.env.write_text('FEISHU_REQUIRE_MENTION=false\n')
  view=next(c for c in panel.execute({'action':'read'},self.path,HOME/'state')['channels'] if c['id']=='feishu');self.assertFalse(view['values']['require_mention'])
  self.save('feishu',{'require_mention':True,'allowed_users':['person']});cfg=self.load().platforms[native.Platform.FEISHU];self.assertTrue(cfg.extra['require_mention']);self.assertEqual(cfg.extra['group_rules'],{'room':{'policy':'disabled'}});self.assertEqual(cfg.extra['admins'],['keep']);self.assertEqual(os.environ['FEISHU_ALLOWED_USERS'],'person')
 def test_selected_env_schema_names_exist_in_installed_runtime_source(self):
  sources=[SOURCE/'gateway/config.py',*(SOURCE/'gateway/platforms').rglob('*.py'),*(SOURCE/'plugins/platforms').rglob('*.py')];text='\n'.join(path.read_text() for path in sources if not path.name.endswith('.bak'))
  for name,schema in CATALOG.items():
   for field in schema['fields']:
    if field['env']:self.assertIn(field['env'],text,(name,field['env']))
 def test_panel_behavior_reaches_real_adapter_yaml_hooks(self):
  for name,key in [('telegram','reactions'),('discord','auto_thread'),('slack','allow_bots'),('matrix','dm_mention_threads'),('dingtalk','require_mention'),('mattermost','require_mention')]:
   with self.subTest(name=name):
    field=next(f for f in CATALOG[name]['fields'] if f['key']==key);self.save(name,{key:False});_,data=__import__('panel_config_txn').load_yaml(self.path.read_bytes());module=ast.parse((SOURCE/'plugins/platforms'/name/'adapter.py').read_text());node=next(n for n in module.body if isinstance(n,ast.FunctionDef) and n.name=='_apply_yaml_config');scope={'os':os,'_profile_scoped_config_load':lambda:False};exec(compile(ast.fix_missing_locations(ast.Module(body=[node],type_ignores=[])),'fixture-hook','exec'),scope)
    os.environ.pop(field['env'],None);scope['_apply_yaml_config'](data,data['platforms'][name]);self.assertEqual(os.environ[field['env']],'false')
 def test_saved_access_switches_drive_real_gateway_authorization(self):
  # Compile the installed decision method only; never import/start Gateway.
  tree=ast.parse((SOURCE/'gateway/authz_mixin.py').read_text());node=next(n for n in ast.walk(tree) if isinstance(n,ast.FunctionDef) and n.name=='_is_user_authorized')
  scope={'Platform':native.Platform,'SessionSource':object,'_auth_env':lambda k,d='':os.environ.get(k,d).strip(),'_platform_gate_env':lambda k,d='':os.environ.get(k,d).strip()}
  exec(compile(ast.fix_missing_locations(ast.Module(body=[node],type_ignores=[])),'native-authorization-fixture','exec'),scope)
  stub=types.ModuleType('gateway.run');stub.logger=types.SimpleNamespace(warning=lambda *a:None)
  previous=sys.modules.get('gateway.run');sys.modules['gateway.run']=stub
  self.addCleanup(lambda:sys.modules.__setitem__('gateway.run',previous) if previous else sys.modules.pop('gateway.run',None))
  runner=types.SimpleNamespace(_adapter_profile_for_source=lambda s:None,_adapter_authorization_is_upstream=lambda *a,**k:False,_pairing_store_for=lambda s:None,_adapter_enforces_own_access_policy=lambda *a,**k:False,_adapter_for_source=lambda s:None)
  allowed=scope['_is_user_authorized']
  for name,prefix in panel.AUTH_PREFIXES.items():
   with self.subTest(channel=name):
    source=types.SimpleNamespace(platform=native.Platform(name),user_id='outsider',chat_type='dm',chat_id='fixture',delivered_via_upstream_relay=False,is_bot=False,role_authorized=False)
    self.save('gateway-access',{'global_allow_all':False});self.save(name,{'allow_all_users':False});self.load();self.assertFalse(allowed(runner,source))
    self.save('gateway-access',{'global_allow_all':True});self.load();self.assertTrue(allowed(runner,source))
    os.environ[prefix+'_ALLOWED_USERS']='owner';self.assertFalse(allowed(runner,source),'global default does not override an explicit native allowlist')
    self.save(name,{'allow_all_users':True});self.load();self.assertTrue(allowed(runner,source),'platform opt-in precedes native user allowlist')
    os.environ.pop(prefix+'_ALLOWED_USERS',None)
    self.save(name,{'allow_all_users':False});self.load()
if __name__=='__main__':
 try:unittest.main()
 finally:fixture.temporary.cleanup()
