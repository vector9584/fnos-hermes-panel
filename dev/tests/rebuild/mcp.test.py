import importlib.util,json,sys,tempfile,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3];sys.path.insert(0,str(ROOT/'app/server'))
spec=importlib.util.spec_from_file_location('mcp_panel',ROOT/'app/server/panel-mcp.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
SOURCE='''mcp_servers:
  manual:
    url: https://fixture.invalid/mcp
    transport: streamable-http
    timeout: 13.5
    headers: {Authorization: fixture-secret}
    env: {OTHER: another-secret}
    custom: {nested: [one, two]}
    tools: {include: [read_file], other: preserve}
  conn-managed: {command: node}
'''
class McpTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(prefix='mcp-',dir='/tmp');self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name).resolve();self.path=self.root/'config.yaml';self.path.write_text(SOURCE);self.state=self.root/'state'
 def call(self,action='read',**kw):return module.execute({'action':action,**kw},self.path,self.state)
 def current(self):return next(s for s in self.call()['servers'] if s['name']=='manual')
 def test_listing_redacts_secrets_and_edits_preserve_unrecognized_fields(self):
  first=self.current();self.assertNotIn('fixture-secret',json.dumps(first));self.assertNotIn('another-secret',json.dumps(first));self.assertEqual(first['header_keys'],['Authorization']);out=self.call('update',name='manual',revision=first['revision'],changes={'timeout':60,'tools':{'include':['new']}});raw=module.load_yaml(self.path.read_bytes())[1]['mcp_servers']['manual'];self.assertEqual(raw['custom'],{'nested':['one','two']});self.assertEqual(raw['headers']['Authorization'],'fixture-secret');self.assertEqual(raw['tools']['other'],'preserve');self.assertEqual(out['server']['timeout'],60)
 def test_credential_keep_replace_clear_and_conflict(self):
  first=self.current();out=self.call('update',name='manual',revision=first['revision'],changes={'headers':{'Authorization':{'action':'replace','value':'new-secret'}}});self.assertNotIn('new-secret',json.dumps(out));
  with self.assertRaises(module.ConfigError):self.call('update',name='manual',revision=first['revision'],changes={'timeout':120})
  self.call('update',name='manual',revision=out['server']['revision'],changes={'headers':{'Authorization':{'action':'clear'}}});self.assertEqual(self.current()['header_keys'],[])
 def test_disable_and_restore_preserve_original(self):
  before=self.current();out=self.call('toggle',name='manual',revision=before['revision'],enabled=False);self.assertFalse(out['server']['enabled']);restored=self.call('restore',name='manual',revision=out['server']['revision'],change_id=out['change_id']);self.assertTrue(restored['server']['enabled']);self.assertEqual(self.current()['revision'],before['revision'])
 def test_credentials_do_not_follow_new_host_or_command(self):
  first=self.current();self.call('update',name='manual',revision=first['revision'],changes={'url':'https://another.invalid/mcp'})
  current=self.current();self.assertEqual(current['header_keys'],[]);self.assertEqual(current['env_keys'],[])
 def test_managed_duplicate_and_invalid_fields_never_write(self):
  for body in [{'action':'create','name':'manual','changes':{'command':'node'}},{'action':'create','name':'conn-test','changes':{'command':'node'}},{'action':'update','name':'manual','revision':self.current()['revision'],'changes':{'timeout':-2}},{'action':'update','name':'manual','revision':self.current()['revision'],'changes':{'url':'https://user:password@example.com'}}]:
   with self.assertRaises(module.ConfigError):module.execute(body,self.path,self.state)
  self.assertEqual(self.path.read_text(),SOURCE)
if __name__=='__main__':unittest.main()
