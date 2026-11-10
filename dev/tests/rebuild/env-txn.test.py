import importlib.util,json,multiprocessing,os,sys,tempfile,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3];sys.path.insert(0,str(ROOT/'app/server'))
import panel_env_txn as module
def worker(path,state,index):module.execute({'action':'set','key':'WORKER_'+str(index),'value':str(index)},path,state)
class EnvTransactions(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(dir='/tmp');self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name).resolve();self.path=self.root/'.env';self.state=self.root/'state';self.path.write_text('# keep\nexport TOKEN="old # value"\nOTHER=keep\n')
 def execute(self,body):return module.execute(body,self.path,self.state)
 def values(self):return module.parse(self.path.read_bytes())[1]
 def test_parallel_native_operations_preserve_every_key(self):
  processes=[multiprocessing.Process(target=worker,args=(self.path,self.state,i)) for i in range(8)]
  for process in processes:process.start()
  for process in processes:process.join(10);self.assertEqual(process.exitcode,0)
  for i in range(8):self.assertEqual(self.values()['WORKER_'+str(i)],str(i))
  self.assertIn('# keep',self.path.read_text());self.assertEqual(self.values()['TOKEN'],'old # value')
 def test_request_diffs_merge_and_same_key_conflicts_without_secret_errors(self):
  before=self.path.read_text();self.execute({'action':'set','key':'OTHER','value':'new'})
  self.execute({'action':'replace_changes','before':before,'after':before.replace('old # value','next')});self.assertEqual(self.values(),{'TOKEN':'next','OTHER':'new'})
  with self.assertRaises(module.ConfigError) as error:self.execute({'action':'replace_changes','before':before,'after':before.replace('old # value','secret-stale')})
  self.assertEqual(error.exception.status,409);self.assertNotIn('secret',str(error.exception))
 def test_duplicate_export_entries_are_removed_and_values_quoted(self):
  self.path.write_text('export TOKEN=one\nTOKEN=two\n# keep\n');value='a # b " q \\ $x ${REF}'
  result=self.execute({'action':'set','key':'TOKEN','value':value});self.assertEqual(self.values()['TOKEN'],value);self.assertEqual(self.path.read_text().count('TOKEN='),1);self.assertNotIn(value,json.dumps(result));self.assertTrue(self.execute({'action':'remove','key':'TOKEN'})['found']);self.assertNotIn('TOKEN',self.values());self.assertFalse(self.execute({'action':'remove','key':'TOKEN'})['found'])
 def test_malformed_and_links_fail_closed(self):
  self.path.write_text('TOKEN="unterminated\n');before=self.path.read_bytes()
  with self.assertRaises(module.ConfigError):self.execute({'action':'set','key':'NEW','value':'test'})
  self.assertEqual(self.path.read_bytes(),before);self.path.unlink();target=self.root/'target';target.write_text('TOKEN=one\n');self.path.symlink_to(target)
  with self.assertRaises(module.ConfigError):self.execute({'action':'set','key':'NEW','value':'test'})
  self.assertEqual(target.read_text(),'TOKEN=one\n')
 def test_bundle_unchanged_env_preserves_bom_and_exact_bytes(self):
  raw=b'\xef\xbb\xbf# keep\r\nexport KEY="value"\r\n';self.assertEqual(module.prepare_changes(raw,raw.decode('utf-8'),raw.decode('utf-8')),raw)
 def test_new_file_revision_and_permissions(self):
  self.path.unlink();result=self.execute({'action':'set','key':'NEW','value':'one'});self.assertEqual(self.path.stat().st_mode&0o777,0o600)
  with self.assertRaises(module.ConfigError):self.execute({'action':'set','key':'NEW','value':'two','revision':'stale'})
  self.execute({'action':'set','key':'NEW','value':'two','revision':result['revision']});self.assertEqual(self.values()['NEW'],'two')
if __name__=='__main__':unittest.main()
