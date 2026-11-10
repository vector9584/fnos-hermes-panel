import copy,importlib.util,json,multiprocessing,os,sys,tempfile,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
spec=importlib.util.spec_from_file_location('native_config',ROOT/'app/server/panel_native_config.py');module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module)
def child(path,state,index):
 value=module.capture(path,lambda:module.raw_at(path)[1]);value['workers'][str(index)]=index;module.write(path,value,state=state)
class NativeConfigTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(dir='/tmp');self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name).resolve();self.path=self.root/'config.yaml';self.old_config_root=os.environ.get('HERMES_PANEL_CONFIG_ROOT');os.environ['HERMES_PANEL_CONFIG_ROOT']=str(self.root);self.addCleanup(lambda:os.environ.pop('HERMES_PANEL_CONFIG_ROOT',None) if self.old_config_root is None else os.environ.__setitem__('HERMES_PANEL_CONFIG_ROOT',self.old_config_root));self.state=self.root/'state';self.path.write_text('# keep\nmodel: {provider: one, default: a, api_key: "${KEY}"}\nworkers: {}\nmemory: {enabled: true}\n')
 def read(self):return module.capture(self.path,lambda:module.raw_at(self.path)[1])
 def test_independent_updates_merge_but_same_field_conflicts(self):
  first=self.read();second=self.read();first['model']['default']='b';module.write(self.path,first,state=self.state);second['memory']['enabled']=False;module.write(self.path,second,state=self.state);out=module.raw_at(self.path)[1];self.assertEqual(out['model']['default'],'b');self.assertFalse(out['memory']['enabled']);self.assertIn('# keep',self.path.read_text())
  first['memory']['enabled']='stale'
  with self.assertRaises(module.txn.ConfigError) as error:module.write(self.path,first,state=self.state)
  self.assertEqual(error.exception.status,409)
 def test_snapshots_are_per_object_and_survive_copies(self):
  first=self.read();later=self.read();self.assertIsNot(first._panel_snapshot,later._panel_snapshot);cloned=copy.deepcopy(first);cloned['model']['default']='copy';module.write(self.path,cloned,state=self.state);self.assertEqual(first['model']['default'],'a')
  first.copy()['memory']['enabled']=False
  with self.assertRaises(module.txn.ConfigError):module.write(self.path,dict(first),state=self.state)
 def test_normalized_baseline_does_not_persist_defaults_or_expanded_secrets(self):
  def effective():
   value=module.raw_at(self.path)[1];value['model']['api_key']='expanded-secret';value['schema-default']={'x':1};return value
  loaded=module.capture(self.path,effective);snap=loaded._panel_snapshot;loaded['memory']['enabled']=False
  # Native normalization preserves raw templates and strips schema defaults.
  baseline=copy.deepcopy(snap['value']);baseline['model']['api_key']='${KEY}';baseline.pop('schema-default');after=copy.deepcopy(dict(loaded));after['model']['api_key']='${KEY}';after.pop('schema-default')
  module.write(self.path,after,snapshot=snap,baseline=baseline,state=self.state);raw=self.path.read_text();self.assertNotIn('expanded-secret',raw);self.assertNotIn('schema-default',raw);self.assertIn('${KEY}',raw)
 def test_parallel_native_and_panel_share_same_lock_and_merge(self):
  processes=[multiprocessing.Process(target=child,args=(self.path,self.state,index)) for index in range(8)]
  for process in processes:process.start()
  module.txn.execute({'action':'patch','operations':[{'path':['workers','panel'],'value':99}]},self.path,self.state)
  for process in processes:process.join(15);self.assertEqual(process.exitcode,0)
  self.assertEqual(module.raw_at(self.path)[1]['workers'],{**{str(i):i for i in range(8)},'panel':99})
 def test_untracked_write_broken_yaml_and_source_race_fail_closed(self):
  before=self.path.read_bytes()
  with self.assertRaises(module.txn.ConfigError):module.write(self.path,{'model':{}},state=self.state)
  self.assertEqual(self.path.read_bytes(),before)
  self.path.write_text('model: [broken')
  with self.assertRaises(module.txn.ConfigError):self.read()
  self.assertEqual(self.path.read_text(),'model: [broken')
 def test_dotted_change_preserves_alias_sibling_and_other_yaml_is_not_intercepted(self):
  self.path.write_text('shared: &same {value: old}\nselected: *same\n');module.dotted_update(self.path,'selected.value','new',state=self.state);value=module.raw_at(self.path)[1];self.assertEqual(value['shared']['value'],'old');self.assertEqual(value['selected']['value'],'new');self.assertFalse(module.write(self.root/'other.yaml',{},state=self.state))
if __name__=='__main__':unittest.main()
