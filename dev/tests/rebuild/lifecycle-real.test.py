"""Actual cmd/main in /tmp, fake Monitor only; never imports production Monitor."""
import fcntl,importlib.util,json,os,shutil,socket,subprocess,sys,tempfile,time,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3];sys.path.insert(0,str(ROOT/'app/server'))
NODE=os.environ.get('HERMES_PREVIEW_NODE') or shutil.which('node') or '/vol1/@apphome/hermes-agent/data/node/bin/node'
class LifecycleReal(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(prefix='hermes-lifecycle-',dir='/tmp');self.root=Path(self.temp.name);self.app=self.root/'app';self.home=self.root/'home';self.var=self.root/'var';(self.app/'server').mkdir(parents=True);(self.home/'data/venv/bin').mkdir(parents=True);self.var.mkdir();os.symlink(sys.executable,self.home/'data/venv/bin/python3');shutil.copy(ROOT/'app/server/panel_lifecycle.py',self.app/'server/panel_lifecycle.py');shutil.copy(ROOT/'app/server/panel_drain_store.py',self.app/'server/panel_drain_store.py');shutil.copy(ROOT/'app/server/panel_restart_receipt.py',self.app/'server/panel_restart_receipt.py');self.node_dir=self.root/'bin';self.node_dir.mkdir();os.symlink(NODE,self.node_dir/'node');self.env={**os.environ,'TRIM_APPDEST':str(self.app),'TRIM_PKGHOME':str(self.home),'TRIM_PKGVAR':str(self.var),'PATH':str(self.node_dir)+':'+os.environ['PATH']};self.cmd=['bash',str(ROOT/'cmd/main')];self.script=self.app/'server/monitor.js';self.script.write_text("const http=require('http'),fs=require('fs');const server=http.createServer((q,r)=>{r.setHeader('Content-Type','application/json');r.end(JSON.stringify({ok:true}));});server.listen(process.env.MONITOR_SOCKET_PATH,()=>fs.chmodSync(process.env.MONITOR_SOCKET_PATH,0o600));process.on('SIGTERM',()=>server.close(()=>process.exit(0)));\n")
 def tearDown(self):
  subprocess.run(self.cmd+['stop'],env=self.env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30);self.temp.cleanup()
 def run_action(self,action):return subprocess.run(self.cmd+[action],env=self.env,capture_output=True,text=True,timeout=45)
 def test_start_duplicate_status_stop_preserves_assets_permissions_and_other_process(self):
  asset=self.home/'data/keep';asset.write_text('asset');asset.chmod(0o640);other=subprocess.Popen([NODE,'-e','setInterval(()=>{},1000)']);self.addCleanup(lambda:(other.terminate(),other.wait(timeout=5)) if other.poll() is None else None)
  first=self.run_action('start');self.assertEqual(first.returncode,0,first.stdout+first.stderr);pid=json.loads(first.stdout)['pid'];self.assertEqual(self.run_action('status').returncode,0);self.assertEqual(json.loads(self.run_action('start').stdout)['pid'],pid);self.assertEqual((self.app/'hermes-agent.sock').stat().st_mode&0o777,0o600);self.assertEqual(self.run_action('stop').returncode,0);self.assertEqual(self.run_action('status').returncode,3);self.assertIsNone(other.poll());self.assertEqual(asset.read_text(),'asset');self.assertEqual(asset.stat().st_mode&0o777,0o640)
 def test_concurrent_start_serializes_to_one_monitor(self):
  processes=[subprocess.Popen(self.cmd+['start'],env=self.env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True) for _ in range(2)];results=[p.communicate(timeout=45) for p in processes];self.assertTrue(all(p.returncode==0 for p in processes),results);self.assertEqual(len({json.loads(out)['pid'] for out,err in results}),1)
 def test_early_exit_reports_failure_and_does_not_claim_healthy(self):
  self.script.write_text('process.exit(7)');result=self.run_action('start');self.assertNotEqual(result.returncode,0);self.assertIn('退出',result.stdout);self.assertEqual(self.run_action('status').returncode,3);self.assertFalse((self.var/'app.pid').exists())
 def test_foreign_pid_cannot_be_status_or_stop_target(self):
  other=subprocess.Popen([NODE,'-e','setInterval(()=>{},1000)']);self.addCleanup(lambda:(other.terminate(),other.wait(timeout=5)) if other.poll() is None else None);(self.var/'app.pid').write_text(str(other.pid));self.assertEqual(self.run_action('status').returncode,3);self.assertEqual(self.run_action('stop').returncode,0);self.assertIsNone(other.poll())
 def test_existing_non_socket_file_and_pid_symlink_preserved(self):
  sock=self.app/'hermes-agent.sock';sock.write_text('original');self.assertNotEqual(self.run_action('start').returncode,0);self.assertEqual(sock.read_text(),'original');sock.unlink();target=self.root/'private';target.write_text('original');os.symlink(target,self.var/'app.pid');result=self.run_action('start');self.assertNotEqual(result.returncode,0);self.assertEqual(target.read_text(),'original')
 def test_foreign_socket_is_not_unlinked_or_accepted(self):
  listener=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);listener.bind(str(self.app/'hermes-agent.sock'));listener.listen(1);self.addCleanup(listener.close);inode=(self.app/'hermes-agent.sock').stat().st_ino;result=self.run_action('start');self.assertNotEqual(result.returncode,0);self.assertIn('其他进程',result.stdout);self.assertEqual((self.app/'hermes-agent.sock').stat().st_ino,inode)
 def test_stop_cleans_exact_orphan_service_without_monitor(self):
  hermes=self.home/'data/venv/bin/hermes';hermes.write_text('import time\nwhile True: time.sleep(.1)\n');orphan=subprocess.Popen([str(self.home/'data/venv/bin/python3'),str(hermes),'gateway','run']);self.addCleanup(lambda:(orphan.terminate(),orphan.wait(timeout=5)) if orphan.poll() is None else None);time.sleep(.1);self.assertEqual(self.run_action('stop').returncode,0);orphan.wait(timeout=5);self.assertIsNotNone(orphan.returncode)
 def test_pidfd_escalation_targets_only_noncooperative_fixture(self):
  spec=importlib.util.spec_from_file_location('lifecycle_fixture',self.app/'server/panel_lifecycle.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);self.script.write_text("process.on('SIGTERM',()=>{});setInterval(()=>{},1000);");child=subprocess.Popen([NODE,str(self.script)]);self.addCleanup(lambda:(child.kill(),child.wait(timeout=5)) if child.poll() is None else None);time.sleep(.2);lifecycle=module.Lifecycle(self.app,self.home/'data',self.var,NODE);record=lifecycle.identity(child.pid);self.assertIsNotNone(record);lifecycle.terminate(record,timeout=.2);child.wait(timeout=5);self.assertEqual(child.returncode,-9)
 def test_start_timeout_is_failure_and_owned_child_is_stopped(self):
  self.script.write_text('setInterval(()=>{},1000);');result=self.run_action('start');self.assertNotEqual(result.returncode,0);self.assertIn('30秒',result.stdout);self.assertEqual(self.run_action('status').returncode,3);self.assertFalse((self.var/'app.pid').exists())
 def test_waiting_stop_cannot_adopt_replacement_monitor(self):
  from panel_lifecycle import Lifecycle
  self.assertEqual(self.run_action('start').returncode,0)
  old=int((self.var/'app.pid').read_text());node=os.readlink('/proc/'+str(old)+'/exe')
  life=Lifecycle(self.app,self.home/'data',self.var,node)
  with open(self.var/'lifecycle.lock','a+') as lock:
   fcntl.flock(lock,fcntl.LOCK_EX)
   worker=subprocess.Popen(self.cmd+['stop'],env=self.env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
   try:
    deadline=time.monotonic()+5
    while time.monotonic()<deadline:
     if worker.poll() is not None:self.fail('stop exited before lock release')
     try:waiting='locks_lock' in Path('/proc',str(worker.pid),'wchan').read_text()
     except OSError:waiting=False
     if waiting:break
     time.sleep(.02)
    else:self.fail('stop worker never waited on lifecycle lock')
    life.terminate(life.identity(old))
    replacement=subprocess.Popen([node,str(self.script)],env={**self.env,'MONITOR_SOCKET_PATH':str(life.sock)})
    self.addCleanup(lambda:(replacement.terminate(),replacement.wait(timeout=5)) if replacement.poll() is None else replacement.wait())
    new=replacement.pid;life.write_pid(new);self.assertNotEqual(old,new)
    deadline=time.monotonic()+5
    while not life.health(new) and time.monotonic()<deadline:time.sleep(.02)
    self.assertTrue(life.health(new))
    fcntl.flock(lock,fcntl.LOCK_UN)
    out,err=worker.communicate(timeout=10);self.assertNotEqual(worker.returncode,0,out+err);self.assertIn('进程已改变',out)
    self.assertTrue(life.health(new));self.assertEqual(int((self.var/'app.pid').read_text()),new)
   finally:
    if worker.poll() is None:worker.terminate();worker.communicate(timeout=5)
 def test_stop_snapshot_does_not_signal_service_born_during_stop(self):
  from panel_lifecycle import Lifecycle,LifecycleError
  life=Lifecycle(self.app,self.home/'data',self.var,NODE)
  snapshot={'monitors':[(1,'old','monitor')],'services':[],'drain_id':None};signals=[];calls={'service':0}
  def discover(kind='monitor'):
   if kind=='monitor':return []
   calls['service']+=1
   return [] if calls['service']==1 else [(2,'new','service')]
  life.discover=discover;life.terminate=lambda record,*args:signals.append(record)
  with self.assertRaises(LifecycleError):life.stop(snapshot)
  self.assertEqual(signals,[(1,'old','monitor')])
 def test_receipt_requires_new_real_monitor_and_healthy_peer(self):
  sys.path.insert(0,str(self.app/'server'));from panel_lifecycle import Lifecycle
  from panel_restart_receipt import capture,observe
  # Execute the actual wrapper's Node resolver: fixtures must exercise the same
  # executable priority as fnOS, including hosts with a separate nodejs app.
  wrapper=(ROOT/'dev/hermes-dev.sh').read_text()
  resolver='\n'.join(line for line in wrapper.splitlines() if line.startswith(('export PATH=','NODE_BIN=')))
  node=subprocess.check_output(['bash','-c',resolver+'\nprintf "%s" "$NODE_BIN"'],env=self.env,text=True)
  self.assertEqual(self.run_action('start').returncode,0)
  lifecycle=Lifecycle(self.app,self.home/'data',self.var,node);before=capture(lifecycle)
  self.assertIsNotNone(before,'wrapper must recognize the Monitor started by cmd/main')
  self.assertFalse(observe(lifecycle,before))
  request_id='11111111-1111-4111-8111-111111111111';worker_pid=os.getpid();worker_start=Path('/proc',str(worker_pid),'stat').read_text().rsplit(')',1)[1].split()[19]
  finish_helper=[sys.executable,'-B',str(self.app/'server/panel_restart_receipt.py'),'finish',str(self.app),str(self.home/'data'),str(self.var),node,request_id,str(worker_pid),worker_start,'0','/proc']
  finished=subprocess.run(finish_helper,env=self.env,capture_output=True,text=True,timeout=10);self.assertEqual(finished.returncode,0,finished.stdout+finished.stderr)
  helper=[sys.executable,'-B',str(self.app/'server/panel_restart_receipt.py'),'verify',str(self.app),str(self.home/'data'),str(self.var),node,json.dumps(before)]
  verify_args=[request_id,json.dumps({'pid':worker_pid,'start':worker_start})]
  initial=subprocess.run(helper+[str(before['pid']),*verify_args],env=self.env,capture_output=True,text=True,timeout=10);self.assertEqual(initial.returncode,0,initial.stdout+initial.stderr);self.assertFalse(json.loads(initial.stdout)['verified'])
  self.assertEqual(self.run_action('stop').returncode,0)
  self.assertEqual(self.run_action('start').returncode,0)
  self.assertTrue(observe(lifecycle,before))
  current=capture(lifecycle)
  verified=subprocess.run(helper+[str(current['pid']),*verify_args],env=self.env,capture_output=True,text=True,timeout=10);self.assertEqual(verified.returncode,0,verified.stdout+verified.stderr);self.assertTrue(json.loads(verified.stdout)['verified'])
  stale=subprocess.run(helper+[str(before['pid']),*verify_args],env=self.env,capture_output=True,text=True,timeout=10);self.assertEqual(stale.returncode,0,stale.stdout+stale.stderr);self.assertFalse(json.loads(stale.stdout)['verified'])
if __name__=='__main__':unittest.main()
