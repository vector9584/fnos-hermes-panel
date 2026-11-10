import importlib.util,json,sys,tempfile,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3];sys.path.insert(0,str(ROOT/'app/server'));spec=importlib.util.spec_from_file_location('typing_panel',ROOT/'app/server/panel-typing.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class TypingTests(unittest.TestCase):
 def test_native_merge_order_direct_field_wins_extra_and_top_level_bridge(self):
  cases=[({}, {}, True),({'telegram':{'typing_indicator':False}}, {},False),({'platforms':{'telegram':{'typing_indicator':False}},'telegram':{'typing_indicator':True}}, {},False),({'gateway':{'platforms':{'telegram':{'typing_indicator':False}}},'platforms':{'telegram':{'typing_indicator':True}}}, {},True),({'gateway':{'telegram':{'typing_indicator':False}},'platforms':{'telegram':{'typing_indicator':True}}}, {},False),({}, {'platforms':{'telegram':{'extra':{'typing_indicator':'off'}}}},False),({'telegram':{'typing_indicator':False}},{'platforms':{'telegram':{'typing_indicator':True}}},True)]
  for data,legacy,want in cases:self.assertEqual(module.effective(data,legacy,'telegram')['enabled'],want,(data,legacy))
 def test_save_actual_winning_field_and_conflict_preserves_config(self):
  with tempfile.TemporaryDirectory(dir='/tmp') as temp:
   root=Path(temp).resolve();path=root/'config.yaml';path.write_text('# header\ngateway:\n  telegram:\n    typing_indicator: false\n    token: preserve-secret\nplatforms:\n  telegram:\n    typing_indicator: true\n');state=root/'state'
   body={'platforms':['telegram','slack']};first=module.execute({**body,'action':'read'},path,state);self.assertFalse(first['platforms'][0]['enabled']);self.assertTrue(first['platforms'][1]['enabled']);self.assertFalse(first['platforms'][1]['explicit']);self.assertNotIn('preserve-secret',json.dumps(first))
   module.execute({**body,'action':'update','platform':'telegram','enabled':True,'revision':first['revision']},path,state);self.assertIn('token: preserve-secret',path.read_text());second=module.execute({**body,'action':'read'},path,state);self.assertTrue(second['platforms'][0]['enabled'])
   with self.assertRaises(module.ConfigError):module.execute({**body,'action':'update','platform':'slack','enabled':False,'revision':first['revision']},path,state)
 def test_legacy_revision_and_aliases_preserved(self):
  with tempfile.TemporaryDirectory(dir='/tmp') as temp:
   root=Path(temp).resolve();path=root/'config.yaml';path.write_text('platforms:\n  telegram: &alias\n    typing_indicator: true\n  slack: *alias\n');legacy=root/'gateway.json';legacy.write_text('{"platforms":{}}');body={'platforms':['telegram','slack']};first=module.execute({**body,'action':'read'},path,root/'state');legacy.write_text('{"platforms":{"slack":{"typing_indicator":false}}}')
   with self.assertRaises(module.ConfigError):module.execute({**body,'action':'update','platform':'telegram','enabled':False,'revision':first['revision']},path,root/'state')
   first=module.execute({**body,'action':'read'},path,root/'state');module.execute({**body,'action':'update','platform':'telegram','enabled':False,'revision':first['revision']},path,root/'state');out=module.execute({**body,'action':'read'},path,root/'state');self.assertFalse(out['platforms'][0]['enabled']);self.assertTrue(out['platforms'][1]['enabled'])
if __name__=='__main__':unittest.main()
