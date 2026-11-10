"""Actual native config code; no Gateway import, plugins or external traffic."""
import ast,contextlib,copy,importlib.util,os,sys,tempfile,types,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
sys.dont_write_bytecode=True
temporary=tempfile.TemporaryDirectory(prefix='hermes-channels-',dir='/tmp');HOME=Path(temporary.name)
os.environ.update(HOME=str(HOME),HERMES_HOME=str(HOME),HERMES_PANEL_CONFIG_ROOT=str(HOME),HERMES_PANEL_STATE_DIR=str(HOME/'state'),HERMES_MANAGED_DIR=str(HOME/'no-managed'))
sys.path.insert(0,'/vol1/@appcenter/hermes-agent/hermes-src');sys.path.insert(0,str(ROOT/'app/python'))
import hermes_cli
hermes_cli.__path__=[str(ROOT/'app/python/hermes_cli'),*hermes_cli.__path__]
plugins=types.ModuleType('hermes_cli.plugins');plugins.discover_plugins=lambda:None;sys.modules['hermes_cli.plugins']=plugins
registry=types.ModuleType('gateway.platform_registry');registry.platform_registry=types.SimpleNamespace(plugin_entries=lambda:[],all_entries=lambda:[]);sys.modules['gateway.platform_registry']=registry
spec=importlib.util.spec_from_file_location('native_gateway_config_candidate',ROOT/'app/python/gateway/config.py');module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module)
class EnabledState(unittest.TestCase):
 def setUp(self):
  self.old=dict(os.environ);os.environ.clear();os.environ.update(HOME=str(HOME),HERMES_HOME=str(HOME),HERMES_PANEL_CONFIG_ROOT=str(HOME),HERMES_PANEL_STATE_DIR=str(HOME/'state'),HERMES_MANAGED_DIR=str(HOME/'no-managed'))
  self.addCleanup(lambda:(os.environ.clear(),os.environ.update(self.old)))
 def test_credentials_do_not_override_explicit_disabled_platforms(self):
  cases={'telegram':{'TELEGRAM_BOT_TOKEN':'fixture'},'discord':{'DISCORD_BOT_TOKEN':'fixture'},'qqbot':{'QQ_APP_ID':'fixture','QQ_CLIENT_SECRET':'fixture'},'weixin':{'WEIXIN_TOKEN':'fixture'},'feishu':{'FEISHU_APP_ID':'fixture','FEISHU_APP_SECRET':'fixture'},'dingtalk':{'DINGTALK_CLIENT_ID':'fixture','DINGTALK_CLIENT_SECRET':'fixture'},'whatsapp':{'WHATSAPP_ENABLED':'true'},'wecom':{'WECOM_BOT_ID':'fixture','WECOM_SECRET':'fixture'}}
  for name,values in cases.items():
   with self.subTest(platform=name):
    os.environ.update(values);platform=module.Platform(name);config=module.GatewayConfig();config.platforms[platform]=module.PlatformConfig(enabled=False,extra={'_enabled_explicit':True,'keep':'yes'});module._apply_env_overrides(config);self.assertFalse(config.platforms[platform].enabled);self.assertEqual(config.platforms[platform].extra['keep'],'yes');self.assertNotIn('_enabled_explicit',config.platforms[platform].extra)
    for key in values:os.environ.pop(key)
 def test_env_only_setup_remains_enabled(self):
  os.environ.update(QQ_APP_ID='fixture',QQ_CLIENT_SECRET='fixture');config=module.GatewayConfig();module._apply_env_overrides(config);self.assertTrue(config.platforms[module.Platform.QQBOT].enabled);self.assertEqual(config.platforms[module.Platform.QQBOT].extra['client_secret'],'fixture')
 def test_real_loader_respects_legacy_json_and_yaml_precedence(self):
  os.environ.update(QQ_APP_ID='fixture',QQ_CLIENT_SECRET='fixture')
  (HOME/'gateway.json').write_text('{"platforms":{"qqbot":{"enabled":false}}}');(HOME/'config.yaml').write_text('model: test\n')
  self.assertFalse(module.load_gateway_config().platforms[module.Platform.QQBOT].enabled)
  (HOME/'config.yaml').write_text('platforms: {qqbot: {enabled: true}}\ngateway: {qqbot: {enabled: false}}\n');self.assertFalse(module.load_gateway_config().platforms[module.Platform.QQBOT].enabled)
  (HOME/'config.yaml').write_text('platforms: {qqbot: {enabled: false}}\nqqbot: {enabled: true}\n');self.assertTrue(module.load_gateway_config().platforms[module.Platform.QQBOT].enabled)
if __name__=='__main__':
 try:unittest.main()
 finally:temporary.cleanup()
