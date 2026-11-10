import importlib.util,json,os,subprocess,sys,tempfile,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3];sys.path.insert(0,str(ROOT/'app/server'))
from panel_restart_receipt import capture,finish,observe,read_receipt,receipt_path
class Receipt(unittest.TestCase):
 def test_process_change_and_health_are_both_required(self):
  class Service:
   record=(42,'old','monitor');healthy=True
   def stored(self):return self.record
   def health(self,pid):return self.healthy and pid==self.record[0]
  service=Service();before=capture(service);self.assertFalse(observe(service,before));service.record=(42,'new','monitor');self.assertTrue(observe(service,before));service.healthy=False;self.assertFalse(observe(service,before));service.record=None;self.assertFalse(observe(service,before))
 def test_real_shell_wrapper_preserves_cli_failure_and_requires_receipt(self):
  source=(ROOT/'dev/hermes-dev.sh').read_text();function=source[source.index('restart_app() {'):source.index('\nproc_start()')]
  with tempfile.TemporaryDirectory(dir='/tmp') as folder:
   root=Path(folder);script=root/'test.sh';calls=root/'calls'
   script.write_text('set -uo pipefail\nPY_BIN=python\nAPP_DIR=/fixture/app\nHERMES_HOME=/fixture/home\nLOGDIR=/fixture/var\nNODE_BIN=node\nFNOS_CLI=fnos\n'+'''as_agent(){
 if [ "$1" = fnos ]; then echo cli >> "$CALLS"; return "$CLI_RESULT"; fi
 if [ "$4" = capture ]; then echo '{"pid":42,"start":"old"}'; return 0; fi
 echo receipt >> "$CALLS"; return "$RECEIPT_RESULT"
}
'''+function+'\nrestart_app\n')
   for cli,receipt,expected,expected_calls in [(1,0,1,['cli']),(0,1,1,['cli','receipt']),(0,0,0,['cli','receipt'])]:
    calls.write_text('');result=subprocess.run(['bash',str(script)],env={'PATH':'/usr/bin:/bin','CALLS':str(calls),'CLI_RESULT':str(cli),'RECEIPT_RESULT':str(receipt)},capture_output=True,text=True);self.assertEqual(result.returncode,expected,result.stdout+result.stderr);self.assertEqual(calls.read_text().splitlines(),expected_calls)
 def test_finish_persists_request_bound_worker_identity_and_exit(self):
  with tempfile.TemporaryDirectory(dir='/tmp') as folder:
   proc=Path(folder)/'proc';worker_pid=os.getpid();start='987654321';stat_dir=proc/str(worker_pid);stat_dir.mkdir(parents=True);(stat_dir/'stat').write_text('123 (fixture process) S '+' '.join(['0']*18+[start]))
   request='11111111-1111-4111-8111-111111111111';saved=finish(folder,request,worker_pid,start,0,proc)
   path=receipt_path(folder,request);record=read_receipt(folder,request)
   self.assertEqual(record['request_id'],request);self.assertEqual(record['worker'],{'pid':worker_pid,'start':start});self.assertEqual(record['exit_code'],0);self.assertEqual(path.stat().st_mode&0o777,0o600);self.assertEqual(saved['request_id'],request)
   with self.assertRaises(ValueError):finish(folder,request,worker_pid,'wrong-start',0,proc)
 def test_receipt_path_rejects_invalid_id_and_symlinks(self):
  with tempfile.TemporaryDirectory(dir='/tmp') as folder:
   with self.assertRaises(ValueError):receipt_path(folder,'../outside')
   request='22222222-2222-4222-8222-222222222222';path=receipt_path(folder,request);target=Path(folder)/'outside';target.write_text('keep');path.parent.mkdir(parents=True);path.symlink_to(target)
   with self.assertRaises(OSError):read_receipt(folder,request)
   self.assertEqual(target.read_text(),'keep')
 def test_receipt_rejects_symlinked_parent_components_and_file_targets(self):
  with tempfile.TemporaryDirectory(dir='/tmp') as folder, tempfile.TemporaryDirectory(dir='/tmp') as outside:
   root=Path(folder);external=Path(outside);request='33333333-3333-4333-8333-333333333333';(root/'panel-state').symlink_to(external,target_is_directory=True)
   with self.assertRaises(OSError):read_receipt(folder,request)
   self.assertEqual(list(external.iterdir()),[])
  with tempfile.TemporaryDirectory(dir='/tmp') as folder:
   root=Path(folder);worker_pid=os.getpid();proc=root/'proc';record=proc/str(worker_pid);record.mkdir(parents=True);start='123456789';(record/'stat').write_text('123 (fixture process) S '+' '.join(['0']*18+[start]))
   request='44444444-4444-4444-8444-444444444444';path=receipt_path(folder,request);path.parent.mkdir(parents=True);target=root/'outside';target.write_text('preserve');path.symlink_to(target)
   with self.assertRaises(OSError):finish(folder,request,worker_pid,start,0,proc)
   self.assertEqual(target.read_text(),'preserve')
if __name__=='__main__':unittest.main()
