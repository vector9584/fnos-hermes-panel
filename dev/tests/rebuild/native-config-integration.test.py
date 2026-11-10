"""Real native module under a /tmp HOME; production libs only read, no services."""
import asyncio,ast,contextlib,copy,importlib,json,os,sys,tempfile,time,typing,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
temporary=tempfile.TemporaryDirectory(prefix='hermes-native-integration-',dir='/tmp')
FIXTURE=Path(temporary.name)
os.environ.update(HOME=str(FIXTURE),HERMES_HOME=str(FIXTURE/'home'),HERMES_PANEL_CONFIG_ROOT=str(FIXTURE/'home'),HERMES_PANEL_STATE_DIR=str(FIXTURE/'state'),HERMES_MANAGED_DIR=str(FIXTURE/'no-managed'),TEST_NATIVE_KEY='fixture-expanded-secret')
sys.dont_write_bytecode=True
sys.path.insert(0,'/vol1/@appcenter/hermes-agent/hermes-src')
sys.path.insert(0,str(ROOT/'app/python'))
# Resolve unchanged package files from the installed read-only source, while
# loading the actual candidate config module (not an AST mock).
import hermes_cli
hermes_cli.__path__=[str(ROOT/'app/python/hermes_cli'),*hermes_cli.__path__]
from hermes_cli import config
import panel_config_bridge as bridge
from hermes_constants import get_hermes_home_override,set_hermes_home_override,reset_hermes_home_override

def extract(path,names,scope):
 tree=ast.parse(path.read_text());selected=[n for n in tree.body if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef)) and n.name in names]
 assert {n.name for n in selected}==set(names)
 for item in selected:item.decorator_list=[]
 exec(compile(ast.fix_missing_locations(ast.Module(body=selected,type_ignores=[])),str(path),'exec'),scope)

class NativeIntegration(unittest.TestCase):
 def setUp(self):
  self.path=config.get_config_path();self.path.parent.mkdir(exist_ok=True);self.path.write_text('# integration header\nmodel: {provider: one, default: a, api_key: "${TEST_NATIVE_KEY}"}\nmemory: {enabled: true}\nworkers: {}\n')
  from fastapi import HTTPException
  from hermes_cli.web_models import ConfigUpdate,RawConfigUpdate
  self.ConfigUpdate=ConfigUpdate;self.RawConfigUpdate=RawConfigUpdate;self.HTTPException=HTTPException
  @contextlib.contextmanager
  def profile_scope(profile):
   token=set_hermes_home_override(str(self.path.parent/'profiles'/profile)) if profile else None
   try:yield
   finally:
    if token is not None:reset_hermes_home_override(token)
  self.scope={**vars(typing),'Dict':dict,'Any':typing.Any,'ConfigUpdate':ConfigUpdate,'RawConfigUpdate':RawConfigUpdate,'HTTPException':HTTPException,'_profile_scope':profile_scope,'load_config':config.load_config,'read_raw_config':config.read_raw_config,'save_config':config.save_config,'get_config_path':config.get_config_path,'_deep_merge':config._deep_merge,'_log':__import__('logging').getLogger('native-fixture')}
  extract(ROOT/'app/python/hermes_cli/web_server.py',['get_config','update_config','get_config_raw','update_config_raw','_normalize_config_for_web','_denormalize_config_from_web'],self.scope)
 def call(self,name,*args,**kwargs):return asyncio.run(self.scope[name](*args,**kwargs))
 def test_real_native_cached_load_and_repeated_save(self):
  first=config.load_config();cached=config.load_config();self.assertEqual(bridge.revision_of(first),bridge.revision_of(cached));first['memory']['enabled']=False;config.save_config(first);first['model']['default']='b';config.save_config(first);raw=config.read_raw_config();self.assertFalse(raw['memory']['enabled']);self.assertEqual(raw['model']['default'],'b');self.assertEqual(raw['model']['api_key'],'${TEST_NATIVE_KEY}');self.assertNotIn('fixture-expanded-secret',self.path.read_text());self.assertNotIn('terminal',raw);self.assertIn('# integration header',self.path.read_text())
 def test_repeat_save_does_not_claim_concurrent_fields(self):
  one=config.load_config();two=config.load_config();one['workers']['remote']=1;config.save_config(one);two['workers']['local']=2;config.save_config(two);two['workers']['local']=3;config.save_config(two);two['workers']['remote']=4
  with self.assertRaises(bridge.ConfigError):config.save_config(two)
  self.assertEqual(config.read_raw_config()['workers'],{'remote':1,'local':3})
 def test_dashboard_form_revision_defaults_secrets_and_conflict(self):
  form=self.call('get_config');old=copy.deepcopy(form);form['memory']['enabled']=False;result=self.call('update_config',self.ConfigUpdate(config=form,revision=form['_panel_revision']));self.assertTrue(result['ok']);self.assertNotIn('_panel_revision',config.read_raw_config());self.assertNotIn('terminal',config.read_raw_config());self.assertEqual(config.read_raw_config()['model']['api_key'],'${TEST_NATIVE_KEY}')
  old['memory']['enabled']='stale'
  with self.assertRaises(self.HTTPException) as error:self.call('update_config',self.ConfigUpdate(config=old,revision=old['_panel_revision']))
  self.assertEqual(error.exception.status_code,409)
  with self.assertRaises(self.HTTPException) as error:self.call('update_config',self.ConfigUpdate(config=form))
  self.assertEqual(error.exception.status_code,409)
 def test_dashboard_yaml_exact_text_comments_removal_and_repeated_save(self):
  raw=self.call('get_config_raw');text='# user comment\nmodel: {default: test, provider: one}\n'
  result=self.call('update_config_raw',self.RawConfigUpdate(yaml_text=text,revision=raw['revision']));self.assertEqual(self.path.read_text(),text);self.assertNotIn('memory',config.read_raw_config())
  with self.assertRaises(self.HTTPException) as error:self.call('update_config_raw',self.RawConfigUpdate(yaml_text=text+'new: stale\n',revision=raw['revision']))
  self.assertEqual(error.exception.status_code,409);self.assertEqual(self.path.read_text(),text)
  self.call('update_config_raw',self.RawConfigUpdate(yaml_text=text+'new: true\n',revision=result['revision']));self.assertTrue(config.read_raw_config()['new'])
 def test_profile_versions_cannot_cross_and_native_importer_utils(self):
  other=self.path.parent/'profiles/other';other.mkdir(parents=True,exist_ok=True);(other/'config.yaml').write_text('model: other\n')
  raw=self.call('get_config_raw','other');self.assertEqual(raw['path'],str(other/'config.yaml'))
  with self.assertRaises(self.HTTPException):self.call('update_config_raw',self.RawConfigUpdate(yaml_text='model: incorrect\n',revision=raw['revision']))
  self.call('update_config_raw',self.RawConfigUpdate(yaml_text='# profile\nmodel: correct\n',revision=raw['revision'],profile='other'));self.assertEqual((other/'config.yaml').read_text(),'# profile\nmodel: correct\n')
  from hermes_cli.agent_import import load_yaml_file,dump_yaml_file
  loaded=load_yaml_file(self.path);loaded['workers']['importer']=1;dump_yaml_file(self.path,loaded);self.assertEqual(config.read_raw_config()['workers']['importer'],1)
 def test_managed_raw_refuses_changed_managed_field(self):
  from hermes_cli import managed_scope
  directory=FIXTURE/'managed';directory.mkdir(exist_ok=True);(directory/'config.yaml').write_text('model: {provider: managed}\n');os.environ['HERMES_MANAGED_DIR']=str(directory)
  try:
   raw=self.call('get_config_raw')
   with self.assertRaises(self.HTTPException) as error:self.call('update_config_raw',self.RawConfigUpdate(yaml_text=raw['yaml'].replace('provider: one','provider: other'),revision=raw['revision']))
   self.assertEqual(error.exception.status_code,403)
  finally:os.environ['HERMES_MANAGED_DIR']=str(FIXTURE/'no-managed');managed_scope.invalidate_managed_cache()
 def test_read_performance_is_measured(self):
  config.load_config();start=time.perf_counter()
  for _ in range(100):config.load_config()
  print(json.dumps({'native_cached_load_ms':round((time.perf_counter()-start)*10,3)}))
 def test_broken_yaml_preserves_last_known_good_and_raw_editor_can_repair(self):
  config.load_config();self.path.write_text('model: [broken')
  loaded=config.load_config();self.assertEqual(loaded['model']['default'],'a')
  with self.assertRaises(Exception):config.save_config(loaded)
  raw=self.call('get_config_raw');self.assertEqual(raw['yaml'],'model: [broken');form=self.call('get_config');self.assertTrue(form['_panel_revision'])
  self.call('update_config_raw',self.RawConfigUpdate(yaml_text='model: repaired\n',revision=raw['revision']));self.assertEqual(config.load_config()['model'],'repaired')
 def test_empty_config_native_cli_creation_preserves_snapshot(self):
  self.path.write_text('# empty config\n')
  loaded=config.load_config();loaded['memory']['enabled']=False;config.save_config(loaded);self.assertFalse(config.read_raw_config()['memory']['enabled'])
  from hermes_cli.agent_import import load_yaml_file,dump_yaml_file
  self.path.write_text('');loaded=load_yaml_file(self.path);loaded['memory']={'enabled':True};dump_yaml_file(self.path,loaded);self.assertTrue(config.read_raw_config()['memory']['enabled'])
 def test_native_env_set_remove_and_format_read_never_rewrite(self):
  path=config.get_env_path();path.write_bytes(b'# keep\r\nexport TEST_PANEL_SECRET=old\r\nTEST_PANEL_SECRET=duplicate\r\n');original=path.read_bytes();self.assertEqual(config.sanitize_env_file(),0);self.assertEqual(path.read_bytes(),original)
  value='a # quote " slash \\ ${REF}';config.save_env_value('TEST_PANEL_SECRET',value);self.assertEqual(config.load_env()['TEST_PANEL_SECRET'],value);self.assertEqual(path.read_text().count('TEST_PANEL_SECRET='),1);self.assertEqual(os.environ['TEST_PANEL_SECRET'],value);self.assertTrue(config.remove_env_value('TEST_PANEL_SECRET'));self.assertNotIn('TEST_PANEL_SECRET',config.load_env());self.assertNotIn('TEST_PANEL_SECRET',os.environ)
  path.write_text('COMMENTED=one # note\nMULTI="first\nsecond"\n');self.assertEqual(config.load_env(),{'COMMENTED':'one','MULTI':'first\nsecond'})
 def test_native_read_completes_interrupted_configuration_before_using_it(self):
  from panel_config_bundle import commit_bundle
  path=config.get_env_path();path.write_bytes(b'KEY=before\n');before=self.path.read_bytes();after=before.replace(b'default: a',b'default: recovered')
  def stop(index):raise RuntimeError('fixture interruption')
  with bridge.txn.config_lock(Path(os.environ['HERMES_PANEL_STATE_DIR'])):
   with self.assertRaises(RuntimeError):commit_bundle(Path(os.environ['HERMES_PANEL_STATE_DIR']),[(self.path,before,after),(path,b'KEY=before\n',b'KEY=after\n')],'fixture',after_publish=stop)
  self.assertEqual(path.read_bytes(),b'KEY=before\n');self.assertEqual(config.load_config()['model']['default'],'recovered');self.assertEqual(config.load_env()['KEY'],'after')

if __name__=='__main__':
 try:unittest.main()
 finally:temporary.cleanup()
