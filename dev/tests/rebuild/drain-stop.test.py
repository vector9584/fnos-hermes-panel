"""Linux real process identities, lifecycle stop gate; no production processes."""
import importlib.util,json,os,subprocess,sys,tempfile,time,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3];sys.path.insert(0,str(ROOT/'app/server'));sys.path.insert(0,str(ROOT/'app/python'))
from panel_lifecycle import Lifecycle,LifecycleError
from panel_drain_bridge import panel_drain_requested,_live_stop_owner
class StopGate(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(dir='/tmp');self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name);self.home=self.root/'home';self.var=self.root/'var';self.app=ROOT/'app';(self.home/'venv/bin').mkdir(parents=True);(self.var/'panel-state').mkdir(parents=True);(self.home/'venv/bin/python3').symlink_to(sys.executable);script=self.home/'venv/bin/hermes';script.write_text('import time\ntime.sleep(120)\n');self.child=subprocess.Popen([str(self.home/'venv/bin/python3'),str(script),'gateway','run']);self.addCleanup(self.cleanup);time.sleep(.05);self.life=Lifecycle(self.app,self.home,self.var,'/fixture/node');self.path=self.var/'panel-state/gateway-drain.json';identity=self.life.identity(self.child.pid,'service');self.assertIsNotNone(identity);now=time.time()*1000;self.lease={'version':1,'action':'drain','phase':'dispatched','id':'fixture','pid':identity[0],'start':identity[1],'created_at':now,'expires_at':now+60000};self.signals=[];self.life.terminate=lambda *a:self.signals.append(a)
 def cleanup(self):
  if self.child.poll() is None:self.child.terminate()
  self.child.wait(timeout=5)
 def write(self):self.path.write_text(json.dumps(self.lease))
 def test_expired_or_unacknowledged_stop_never_signals(self):
  for phase in ['preparing','cancelled','dispatched']:
   self.lease['phase']=phase
   if phase=='dispatched':self.lease['expires_at']=time.time()*1000-1
   self.write()
   with self.assertRaises(LifecycleError):self.life.stop()
   self.assertEqual(self.signals,[]);self.assertIsNone(self.child.poll())
 def test_valid_stop_claim_pins_worker_identity(self):
  self.write();self.life.claim_panel_drain();record=json.loads(self.path.read_text());self.assertEqual(record['stop_owner']['pid'],os.getpid());self.assertEqual(record['stop_owner']['script'],str(self.app/'server/panel_lifecycle.py'))
 def test_foreign_owner_cannot_extend_lease(self):
  old=os.environ.get('HERMES_PANEL_DRAIN_LEASE');os.environ['HERMES_PANEL_DRAIN_LEASE']=str(self.path)
  try:
   self.lease.update(pid=os.getpid(),start=Path('/proc/self/stat').read_text().rsplit(')',1)[1].split()[19],expires_at=time.time()*1000-1,stop_owner={'pid':os.getpid(),'start':Path('/proc/self/stat').read_text().rsplit(')',1)[1].split()[19],'script':str(self.app/'server/panel_lifecycle.py')});self.write();self.assertFalse(panel_drain_requested())
  finally:
   if old is None:os.environ.pop('HERMES_PANEL_DRAIN_LEASE',None)
   else:os.environ['HERMES_PANEL_DRAIN_LEASE']=old
 def test_real_stop_worker_identity_rejected_after_exit(self):
  # Launch actual helper as stop while holding its lifecycle lock. No service in this fixture home is signalled.
  import fcntl
  lock=open(self.var/'lifecycle.lock','w');fcntl.flock(lock,fcntl.LOCK_EX)
  worker=subprocess.Popen([sys.executable,'-B',str(self.app/'server/panel_lifecycle.py'),'stop',str(self.app),str(self.home),str(self.var),'/fixture/node'],stdout=subprocess.DEVNULL)
  try:
   start=Path('/proc')/str(worker.pid)/'stat';deadline=time.monotonic()+5;owner=None
   while time.monotonic()<deadline:
    if worker.poll() is not None:break
    try:
     fields=start.read_text().rsplit(')',1)[1].split();candidate={'pid':worker.pid,'start':fields[19],'script':str(self.app/'server/panel_lifecycle.py')}
     if _live_stop_owner(candidate):owner=candidate;break
    except (OSError,IndexError):pass
    time.sleep(.02)
   self.assertIsNotNone(owner,'stop worker did not become a verified live lock waiter')
   self.assertIsNone(worker.poll())
   old=os.environ.get('HERMES_PANEL_DRAIN_LEASE');os.environ['HERMES_PANEL_DRAIN_LEASE']=str(self.path)
   try:
    self.lease.update(pid=os.getpid(),start=Path('/proc/self/stat').read_text().rsplit(')',1)[1].split()[19],expires_at=time.time()*1000-1,stop_owner=owner);self.write();self.assertTrue(panel_drain_requested());self.lease['phase']='cancelled';self.write();self.assertTrue(panel_drain_requested())
   finally:
    if old is None:os.environ.pop('HERMES_PANEL_DRAIN_LEASE',None)
    else:os.environ['HERMES_PANEL_DRAIN_LEASE']=old
   worker.terminate();worker.wait(timeout=5);self.assertFalse(_live_stop_owner(owner))
  finally:
   if worker.poll() is None:worker.kill();worker.wait(timeout=5)
   lock.close()
if __name__=='__main__':unittest.main()
