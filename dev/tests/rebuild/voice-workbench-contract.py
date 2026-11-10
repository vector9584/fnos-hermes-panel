"""Execute AST-selected existing workbench routes against in-memory state only.
Pass the read-only tts_console_api.py source path; never import/start its server.
"""
import ast,copy,hashlib,json,os,sys,time,unittest
from pathlib import Path
source=Path(sys.argv.pop(1)).read_text();tree=ast.parse(source)
def route(endpoint,method):
 methods=[n for n in ast.walk(tree) if isinstance(n,ast.FunctionDef) and n.name==method]
 for n in ast.walk(methods[0]):
  if isinstance(n,ast.If) and ast.dump(n.test)==ast.dump(ast.parse('p == '+repr(endpoint),mode='eval').body):
   fn=ast.FunctionDef(name='invoke',args=ast.arguments(posonlyargs=[],args=[ast.arg(arg=x) for x in ['self','c','d']],kwonlyargs=[],kw_defaults=[],defaults=[]),body=n.body,decorator_list=[])
   return compile(ast.fix_missing_locations(ast.Module(body=[fn],type_ignores=[])),'workbench-selected-route','exec')
 raise AssertionError(endpoint)
class Reply:
 def _send(self,status,data):return status,data
class Contract(unittest.TestCase):
 def setUp(self):
  self.store={'current':{'id':'old','emo_auto':False,'emo_text':'old mood'},'profiles':{'neutral':{'speed':0.88}}}
  self.ns={'read_json':lambda *a:copy.deepcopy(self.store),'write_json':self.write,'load_voices':lambda:{'voices':[{'id':'new','slug':'fixture','emotion':'neutral','wav':'/fixture.wav'}]},'ref_id_for':lambda *a:'fixture-ref','push_ref_to_win':lambda *a:(False,'fixture unavailable'),'time':time,'os':os,'hashlib':hashlib,'_FALLBACK':{'emo_vector':[0]*8,'emo_alpha':0.7,'speed':0.86}}
 def write(self,path,data):self.store=copy.deepcopy(data)
 def run_route(self,path,data,method='do_POST'):
  exec(route(path,method),self.ns);return self.ns['invoke'](Reply(),{'voice':'fixture'},data)
 def test_voice_switch_http_success_can_have_failed_push(self):
  status,data=self.run_route('/voice/current',{'id':'new'})
  self.assertEqual(status,200);self.assertTrue(data['ok']);self.assertFalse(data['current']['pushed']);self.assertFalse(data['current']['emo_auto']);self.assertEqual(data['current']['speed'],0.88);self.assertEqual(self.store['current']['id'],'new')
 def test_emotion_toggle_preserves_other_parameters(self):
  before=copy.deepcopy(self.store);status,data=self.run_route('/emo/auto',{'on':True});self.assertEqual(status,200);before['current']['emo_auto']=True;self.assertEqual(self.store,before)
 def test_current_read_has_no_write(self):
  self.ns['write_json']=lambda *a: self.fail('read wrote state')
  status,data=self.run_route('/voice/current',{},'do_GET');self.assertEqual(status,200);self.assertEqual(data['current'],self.store['current'])
unittest.main()
