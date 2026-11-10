import importlib.util
import json
import multiprocessing
import os
import tempfile
import unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
spec=importlib.util.spec_from_file_location('config_txn',ROOT/'app/server/panel_config_txn.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
SOURCE='''# preserve comments
model:
  provider: service-a
  default: model-a
auxiliary:
  vision: {provider: auto}
mcp_servers:
  manual:
    url: https://fixture.invalid/mcp
    timeout: 12.5
    enabled: true
    headers: {Authorization: '${FIXTURE_TOKEN}'}
    args: [one, {nested: two}]
    transport: streamable-http
  conn-old:
    command: old
platforms:
  telegram:
    typing_indicator: true
'''
def patch_child(path,root,index):
 module.execute({'action':'patch','operations':[{'path':['separate',str(index)],'value':index}]},path,root)

class ConfigTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(prefix='config-txn-',dir='/tmp');self.addCleanup(self.tmp.cleanup);self.base=Path(self.tmp.name).resolve();self.path=self.base/'config.yaml';self.path.write_text(SOURCE);self.state=self.base/'state'
 def execute(self,body):return module.execute(body,self.path,self.state)
 def data(self):return module.load_yaml(self.path.read_bytes())[1]
 def test_managed_mcp_preserves_all_manual_types_and_is_noop_when_same(self):
  before=self.data();entries={'conn-new':{'command':'node','args':['bridge','fixture']}}
  result=self.execute({'action':'managed_mcp','entries':entries});self.assertTrue(result['changed']);self.assertEqual(self.data()['mcp_servers']['manual'],before['mcp_servers']['manual']);self.assertNotIn('conn-old',self.data()['mcp_servers']);self.assertTrue(self.path.read_text().startswith('# preserve comments'))
  self.assertFalse(self.execute({'action':'managed_mcp','entries':entries})['changed']);self.assertEqual(len(list((self.state/'config-history').glob('*.yaml'))),1)
 def test_disjoint_changes_merge_and_same_field_conflicts(self):
  current=SOURCE.replace('typing_indicator: true','typing_indicator: false');self.path.write_text(current)
  result=self.execute({'action':'replace_changes','before':SOURCE,'after':SOURCE.replace('model-a','model-new')});self.assertTrue(result['changed']);self.assertFalse(self.data()['platforms']['telegram']['typing_indicator']);self.assertEqual(self.data()['model']['default'],'model-new')
  with self.assertRaises(module.ConfigError) as raised:self.execute({'action':'replace_changes','before':SOURCE,'after':SOURCE.replace('model-a','stale')})
  self.assertEqual(raised.exception.status,409);self.assertEqual(self.data()['model']['default'],'model-new')
 def test_backup_permissions_and_only_selected_server_changes(self):
  self.path.chmod(0o640);result=self.execute({'action':'mcp_entry','name':'conn-test','entry':{'command':'node','env':{'A':'B'}}});self.assertEqual(self.path.stat().st_mode&0o777,0o640)
  backup=self.state/'config-history'/(result['change_id']+'.yaml');self.assertEqual(backup.read_text(),SOURCE);self.assertEqual(backup.stat().st_mode&0o777,0o600)
  self.execute({'action':'mcp_entry','name':'conn-test','entry':None});self.assertNotIn('conn-test',self.data()['mcp_servers'])
 def test_parallel_processes_keep_independent_edits(self):
  jobs=[multiprocessing.Process(target=patch_child,args=(self.path,self.state,i)) for i in range(8)]
  for job in jobs:job.start()
  for job in jobs:job.join(15);self.assertEqual(job.exitcode,0)
  self.assertEqual(dict(self.data()['separate']),{str(i):i for i in range(8)})
 def test_yaml_alias_edit_does_not_mutate_unrelated_section(self):
  self.path.write_text('shared: &shared\n  value: first\nselected: *shared\n')
  self.execute({'action':'patch','operations':[{'path':['selected','value'],'expected':'first','value':'second'}]})
  self.assertEqual(self.data()['shared']['value'],'first');self.assertEqual(self.data()['selected']['value'],'second')
 def test_invalid_yaml_links_and_backup_failure_do_not_replace(self):
  self.path.write_text('model: [broken');
  with self.assertRaises(module.ConfigError):self.execute({'action':'managed_mcp','entries':{}})
  self.assertEqual(self.path.read_text(),'model: [broken');self.path.write_text(SOURCE)
  linked=self.base/'link.yaml';linked.symlink_to(self.path)
  with self.assertRaises(module.ConfigError):module.execute({'action':'managed_mcp','entries':{}},linked,self.state)
  self.state.mkdir(exist_ok=True);(self.state/'config-history').write_text('not directory')
  with self.assertRaises(OSError):self.execute({'action':'managed_mcp','entries':{}})
  self.assertEqual(self.path.read_text(),SOURCE)
 def test_current_hardlink_is_rejected(self):
  other=self.base/'linked-copy.yaml';os.link(self.path,other)
  with self.assertRaises(module.ConfigError) as raised:module.read_file(self.path)
  self.assertEqual(raised.exception.status,403)

if __name__=='__main__':unittest.main()
