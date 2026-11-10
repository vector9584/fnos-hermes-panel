"""Real process flock and cancel/claim ordering, all state under /tmp."""
import json,os,subprocess,sys,tempfile,time,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3];sys.path.insert(0,str(ROOT/'app/server'))
from panel_drain_store import locked_record,mutate
from panel_lifecycle import Lifecycle,LifecycleError
class Store(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(dir='/tmp');self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name);self.var=self.root/'var';self.path=self.var/'panel-state/gateway-drain.json';now=time.time()*1000;self.lease={'version':1,'action':'drain','phase':'preparing','id':'one','pid':123,'start':'456','created_at':now,'expires_at':now+60000};self.life=Lifecycle(ROOT/'app',self.root/'home',self.var,'/fixture/node');self.life.identity=lambda pid,kind:(123,'456','service')
 def begin(self):mutate(self.path,{'action':'begin','id':'one','lease':self.lease})
 def dispatch(self):mutate(self.path,{'action':'dispatch','id':'one','identity':{'pid':123,'start':'456'}})
 def release(self):mutate(self.path,{'action':'release','id':'one'})
 def test_cancel_before_claim_stops_claim(self):
  self.begin();self.dispatch();self.release()
  with self.assertRaises(LifecycleError):self.life.claim_panel_drain()
  self.assertNotIn('stop_owner',json.loads(self.path.read_text()))
 def test_claim_before_cancel_preserves_pinned_worker(self):
  self.begin();self.dispatch();self.life.claim_panel_drain();before=json.loads(self.path.read_text())['stop_owner'];self.release();after=json.loads(self.path.read_text());self.assertEqual(after['stop_owner'],before);self.assertEqual(after['phase'],'cancelled')
 def test_expired_record_with_live_stop_worker_cannot_be_replaced(self):
  self.begin();self.dispatch();self.life.claim_panel_drain();record=json.loads(self.path.read_text());record['expires_at']=time.time()*1000-1;self.path.write_text(json.dumps(record))
  with self.assertRaises(Exception):mutate(self.path,{'action':'begin','id':'two','lease':{**self.lease,'id':'two'}})
  self.assertEqual(json.loads(self.path.read_text())['id'],'one')
 def test_real_second_process_waits_for_lock_and_reads_latest(self):
  self.begin();self.dispatch()
  with locked_record(self.path):
   child=subprocess.Popen([sys.executable,'-B',str(ROOT/'app/server/panel_drain_store.py'),str(self.path)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
   child.stdin.write(json.dumps({'action':'release','id':'one'}));child.stdin.close();time.sleep(.15);self.assertIsNone(child.poll());self.assertEqual(json.loads(self.path.read_text())['phase'],'dispatched')
  child.wait(timeout=5);self.assertEqual(child.returncode,0,child.stderr.read());self.assertEqual(json.loads(self.path.read_text())['phase'],'cancelled');child.stdout.close();child.stderr.close()
 def test_stop_snapshot_cannot_claim_a_later_drain(self):
  self.begin();self.dispatch();snapshot=self.life.capture_stop();record={**self.lease,'id':'two','phase':'dispatched'};self.path.write_text(json.dumps(record))
  with self.assertRaises(LifecycleError):self.life.claim_panel_drain(snapshot)
  self.assertNotIn('stop_owner',json.loads(self.path.read_text()))
 def test_symlink_lock_or_record_never_changes_target(self):
  self.begin();target=self.root/'original';target.write_text('asset');self.path.unlink();self.path.symlink_to(target)
  with self.assertRaises(Exception):self.release()
  self.assertEqual(target.read_text(),'asset');self.path.unlink();lock=self.path.with_name('gateway-drain.lock');lock.unlink();lock.symlink_to(target)
  with self.assertRaises(Exception):self.begin()
  self.assertEqual(target.read_text(),'asset')
if __name__=='__main__':unittest.main()
