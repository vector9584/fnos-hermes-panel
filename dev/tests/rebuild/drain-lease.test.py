"""Native drain reader + real process fingerprint, isolated lease only."""
import ast,asyncio,importlib.util,json,logging,os,sys,tempfile,time,types,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3];sys.path.insert(0,str(ROOT/'app/python'))
from panel_drain_bridge import panel_drain_requested
class DrainLease(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(dir='/tmp');self.addCleanup(self.temp.cleanup);self.file=Path(self.temp.name)/'lease.json';self.old=os.environ.get('HERMES_PANEL_DRAIN_LEASE');os.environ['HERMES_PANEL_DRAIN_LEASE']=str(self.file);self.addCleanup(lambda:os.environ.pop('HERMES_PANEL_DRAIN_LEASE',None) if self.old is None else os.environ.__setitem__('HERMES_PANEL_DRAIN_LEASE',self.old));now=time.time()*1000;self.lease={'version':1,'action':'drain','pid':os.getpid(),'start':Path('/proc/self/stat').read_text().rsplit(')',1)[1].split()[19],'created_at':now,'expires_at':now+60000}
 def write(self):self.file.write_text(json.dumps(self.lease))
 def test_current_lease_and_expiration(self):
  self.write();self.assertTrue(panel_drain_requested());self.lease['expires_at']=time.time()*1000-1;self.write();self.assertFalse(panel_drain_requested())
 def test_wrong_process_start_and_unbounded_expiry(self):
  for key,value in [('pid',os.getpid()+1),('start','wrong'),('expires_at',time.time()*1000+120000),('action','other')]:
   old=self.lease[key];self.lease[key]=value;self.write();self.assertFalse(panel_drain_requested());self.lease[key]=old
 def test_missing_corrupt_and_symlink_are_not_a_permanent_drain(self):
  self.assertFalse(panel_drain_requested());self.file.write_text('{bad');self.assertFalse(panel_drain_requested());self.file.unlink();target=self.file.with_name('other');target.write_text(json.dumps(self.lease));self.file.symlink_to(target);self.assertFalse(panel_drain_requested())
 def test_actual_native_reader_preserves_legacy_drain_contract(self):
  constants=types.ModuleType('hermes_constants');constants.get_hermes_home=lambda:Path(self.temp.name);utils=types.ModuleType('utils');utils.atomic_json_write=lambda path,value:Path(path).write_text(json.dumps(value));previous={key:sys.modules.get(key) for key in ['hermes_constants','utils']};sys.modules.update(hermes_constants=constants,utils=utils)
  try:
   spec=importlib.util.spec_from_file_location('drain_native_fixture',ROOT/'app/python/gateway/drain_control.py');native=importlib.util.module_from_spec(spec);spec.loader.exec_module(native);self.assertFalse(native.drain_requested());self.write();self.assertTrue(native.drain_requested());self.file.unlink();native.write_drain_request();self.assertTrue(native.drain_requested());native.clear_drain_request();self.assertFalse(native.drain_requested())
  finally:
   for key,value in previous.items():
    if value is None:sys.modules.pop(key,None)
    else:sys.modules[key]=value
 def test_actual_gateway_watcher_enters_and_releases_without_importing_gateway(self):
  source=Path('/vol1/@appcenter/hermes-agent/hermes-src/gateway/run.py').read_text();tree=ast.parse(source);names={'_enter_external_drain','_exit_external_drain','_drain_control_watcher'};methods=[n for n in ast.walk(tree) if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef)) and n.name in names];self.assertEqual(len(methods),3)
  scope={'asyncio':asyncio,'logger':logging.getLogger('fixture')};exec(compile(ast.fix_missing_locations(ast.Module(body=methods,type_ignores=[])),'native-drain-methods','exec'),scope);fake=types.ModuleType('gateway.drain_control');fake.drain_requested=panel_drain_requested;previous=sys.modules.get('gateway.drain_control');sys.modules['gateway.drain_control']=fake
  async def run():
   runner=types.SimpleNamespace(_external_drain_active=False,_draining=False,_running=True,_active_work_count=lambda:0);states=[];runner._update_runtime_status=lambda state:states.append(state);runner._persist_active_agents=lambda:None
   for name in names:setattr(runner,name,types.MethodType(scope[name],runner))
   self.write();watch=asyncio.create_task(runner._drain_control_watcher(.01));await asyncio.sleep(.035);self.assertTrue(runner._external_drain_active);self.file.unlink();await asyncio.sleep(.035);self.assertFalse(runner._external_drain_active);self.assertEqual(states,['draining','running']);runner._running=False;await watch
  try:asyncio.run(run())
  finally:
   if previous is None:sys.modules.pop('gateway.drain_control',None)
   else:sys.modules['gateway.drain_control']=previous
if __name__=='__main__':unittest.main()
