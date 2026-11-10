"""Execute extracted real native functions; no top-level agent/service imports."""
import ast,copy,importlib.util,logging,os,re,sys,tempfile,threading,types,typing,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT/'app/python'))
import panel_config_bridge as bridge

def functions(path,names,scope):
 tree=ast.parse(path.read_text());selected=[n for n in tree.body if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef)) and n.name in names]
 assert {n.name for n in selected}==set(names)
 exec(compile(ast.fix_missing_locations(ast.Module(body=selected,type_ignores=[])),str(path),'exec'),scope)

class PipelineTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(dir='/tmp');self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name).resolve();self.path=self.root/'config.yaml';self.old_config_root=os.environ.get('HERMES_PANEL_CONFIG_ROOT');os.environ['HERMES_PANEL_CONFIG_ROOT']=str(self.root);self.addCleanup(lambda:os.environ.pop('HERMES_PANEL_CONFIG_ROOT',None) if self.old_config_root is None else os.environ.__setitem__('HERMES_PANEL_CONFIG_ROOT',self.old_config_root));self.path.write_text('# header\nmodel: {provider: one, default: a, api_key: "${TEST_NATIVE_KEY}"}\nmemory: {enabled: true}\n')
  self.previous=os.environ.get('HERMES_PANEL_STATE_DIR');os.environ['HERMES_PANEL_STATE_DIR']=str(self.root/'state');self.addCleanup(self.restore_env);os.environ['TEST_NATIVE_KEY']='fixture-expanded-secret'
  package=types.ModuleType('hermes_cli');managed=types.SimpleNamespace(managed_config_keys=lambda:set());package.managed_scope=managed
  self.old=sys.modules.get('hermes_cli');sys.modules['hermes_cli']=package;self.addCleanup(self.restore_module)
  self.scope={**vars(typing),'copy':copy,'re':re,'os':os,'sys':sys,'Path':Path,'logger':logging.getLogger('fixture'),'_CONFIG_LOCK':threading.RLock(),'is_managed':lambda:False,'managed_error':lambda text:None,'ensure_hermes_home':lambda:None,'get_config_path':lambda:self.path,'require_readable_config_before_write':lambda path:None,'_secure_file':lambda path:None,'DEFAULT_CONFIG':{'model':{'provider':'auto','default':'default'},'memory':{'enabled':True},'agent':{'max_turns':90}},'_RAW_CONFIG_CACHE':{},'_LOAD_CONFIG_CACHE':{},'_LAST_EXPANDED_CONFIG_BY_PATH':{}}
  functions(ROOT/'app/python/hermes_cli/config.py',['save_config','_merge_partial_save','_deep_merge','_strip_dotted_keys','_items_by_unique_name','_env_expand_match','_expand_env_vars','_preserve_env_ref_templates','_explicit_config_paths','_strip_default_values','_normalize_root_model_keys','_normalize_max_turns_config'],self.scope)
  self.managed=managed
 def restore_env(self):
  if self.previous is None:os.environ.pop('HERMES_PANEL_STATE_DIR',None)
  else:os.environ['HERMES_PANEL_STATE_DIR']=self.previous
 def restore_module(self):
  if self.old is None:sys.modules.pop('hermes_cli',None)
  else:sys.modules['hermes_cli']=self.old
 def raw(self):
  from _hermes_panel_native_config import raw_at
  return raw_at(self.path)[1]
 def loaded(self):
  def reader():return self.scope['_expand_env_vars'](self.scope['_deep_merge'](copy.deepcopy(self.scope['DEFAULT_CONFIG']),self.raw()))
  return bridge.capture(self.path,reader)
 def test_native_save_preserves_env_templates_comment_defaults_and_disjoint_changes(self):
  first=self.loaded();second=self.loaded();first['model']['default']='b';self.scope['save_config'](first);second['memory']['enabled']=False;self.scope['save_config'](second)
  raw=self.raw();self.assertEqual(raw['model']['default'],'b');self.assertFalse(raw['memory']['enabled']);self.assertEqual(raw['model']['api_key'],'${TEST_NATIVE_KEY}');self.assertNotIn('agent',raw);self.assertIn('# header',self.path.read_text());self.assertNotIn('fixture-expanded-secret',self.path.read_text())
 def test_native_same_field_conflict_plain_snapshot_and_managed_strip(self):
  first=self.loaded();second=self.loaded();first['model']['default']='b';self.scope['save_config'](first);second['model']['default']='c'
  with self.assertRaises(Exception):self.scope['save_config'](second)
  with self.assertRaises(Exception):self.scope['save_config'](dict(first))
  current=self.loaded();self.managed.managed_config_keys=lambda:{'model.api_key'};current['memory']['enabled']=False;self.scope['save_config'](current);self.assertNotIn('api_key',self.raw()['model'])
 def test_native_creation_and_dotted_update_are_no_replace(self):
  self.path.unlink();self.scope['save_config']({'model':{'provider':'new','default':'new-model'}},strip_defaults=False);self.assertEqual(self.raw()['model']['default'],'new-model');bridge.dotted_update(self.path,'memory.enabled',False);self.assertFalse(self.raw()['memory']['enabled'])
 def test_raw_utils_write_uses_file_snapshot_and_keeps_other_writes_native(self):
  import yaml
  scope={'Path':Path,'Union':typing.Union,'Any':typing.Any,'yaml':yaml,'_get_fast_yaml_loader':lambda:yaml.SafeLoader}
  functions(ROOT/'app/python/utils.py',['fast_safe_load','atomic_yaml_write'],scope)
  with self.path.open() as stream:raw=scope['fast_safe_load'](stream)
  raw['memory']['enabled']=False;scope['atomic_yaml_write'](self.path,raw);self.assertFalse(self.raw()['memory']['enabled'])
  self.assertEqual(scope['fast_safe_load']('fixture: true'),{'fixture':True})
if __name__=='__main__':unittest.main()
