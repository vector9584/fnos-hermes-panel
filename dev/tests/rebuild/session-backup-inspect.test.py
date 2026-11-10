import importlib.util,io,json,tarfile,tempfile,unittest,hashlib
from pathlib import Path
spec=importlib.util.spec_from_file_location('backup',Path(__file__).with_name('session-backup-inspect.py'));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class Backup(unittest.TestCase):
 def test_inspection_never_extracts_or_reports_body_and_does_not_follow_links(self):
  with tempfile.TemporaryDirectory() as temporary:
   root=Path(temporary);archive=root/'backup.tar.gz';raw=json.dumps({'id':'wanted','messages':[{'content':'private-secret'}]}).encode()
   with tarfile.open(archive,'w:gz') as tar:
    entry=tarfile.TarInfo('../../outside/wanted.json');entry.size=len(raw);tar.addfile(entry,io.BytesIO(raw))
    link=tarfile.TarInfo('links/wanted.json');link.type=tarfile.SYMTYPE;link.linkname='/etc/passwd';tar.addfile(link)
    wrong=tarfile.TarInfo('sessions/other.json');wrong.size=2;tar.addfile(wrong,io.BytesIO(b'{}'))
   report=module.inspect(archive,['wanted']);self.assertEqual(len(report['matches']),1);self.assertEqual(report['matches'][0]['sha256'],hashlib.sha256(raw).hexdigest());self.assertEqual(report['matches'][0]['messages'],1);self.assertNotIn('private-secret',json.dumps(report));self.assertEqual(list(root.iterdir()),[archive])
 def test_bad_json_reported_as_unverified_not_valid_copy(self):
  with tempfile.TemporaryDirectory() as temporary:
   archive=Path(temporary)/'b.tar'
   with tarfile.open(archive,'w') as tar:
    entry=tarfile.TarInfo('wanted.json');entry.size=6;tar.addfile(entry,io.BytesIO(b'broken'))
   report=module.inspect(archive,['wanted']);self.assertEqual(report['matches'][0]['error'],'JSONDecodeError');self.assertNotIn('messages',report['matches'][0])
unittest.main()
