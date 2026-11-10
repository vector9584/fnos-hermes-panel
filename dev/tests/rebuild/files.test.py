import hashlib
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path

spec=importlib.util.spec_from_file_location('panel_files',Path(__file__).resolve().parents[3]/'app/server/panel-files.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class FileTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.base=Path(self.tmp.name).resolve();self.root=self.base/'workspace';self.root.mkdir();self.state=self.base/'state';self.file=self.root/'笔记.md';self.file.write_text('初稿\n');self.files=module.Files([{'id':'workspace','path':str(self.root),'editable':True},{'id':'read-only','path':str(self.root),'editable':False}],str(self.state))
 def tearDown(self):self.tmp.cleanup()
 def run_action(self,action,**body):return self.files.run({'action':action,'root':'workspace',**body})
 def save(self,content='修改',request_id='save-1',**extra):
  doc=self.run_action('read',path='笔记.md');return self.run_action('write',**{**doc,'content':content,'exists':True,'request_id':request_id,**extra})
 def test_versioned_save_undo_permissions(self):
  self.file.chmod(0o640);result=self.save();self.assertEqual(self.file.read_text(),'修改');self.assertEqual(self.file.stat().st_mode&0o777,0o640)
  history=self.run_action('history',path='笔记.md');self.assertEqual(history['total'],1);self.assertNotIn('before',history['items'][0]);self.assertEqual(self.run_action('version',change_id=result['change_id'])['content'],'初稿\n')
  self.run_action('undo',change_id=result['change_id'],request_id='undo-1');self.assertEqual(self.file.read_text(),'初稿\n')
 def test_conflict_and_request_dedupe(self):
  doc=self.run_action('read',path='笔记.md');body={**doc,'content':'修改','exists':True,'request_id':'save-1'};first=self.run_action('write',**body);self.assertTrue(self.run_action('write',**body)['duplicate']);self.file.write_text('内核的更新')
  with self.assertRaises(module.FileError):self.run_action('write',**{**body,'request_id':'save-2'})
  with self.assertRaises(module.FileError):self.run_action('undo',change_id=first['change_id'],request_id='undo-1')
  self.assertEqual(self.file.read_text(),'内核的更新')
 def test_new_file_does_not_overwrite(self):
  listing=self.run_action('list');body={'path':'笔记.md','content':'','exists':False,'revision':hashlib.sha256(b'').hexdigest(),'root_revision':listing['root_revision'],'request_id':'new-1'}
  with self.assertRaises(module.FileError):self.run_action('write',**body)
  self.run_action('write',**{**body,'path':'new.txt'});self.assertEqual((self.root/'new.txt').read_text(),'')
 def test_directory_archive_restore_conflict_and_restart(self):
  directory=self.root/'项目';directory.mkdir();(directory/'结果.txt').write_text('成果');listing=self.run_action('list');item=next(i for i in listing['items'] if i['name']=='项目');body={'path':item['path'],'entry_revision':item['entry_revision'],'root_revision':listing['root_revision'],'request_id':'archive-1'}
  self.run_action('archive',**body);self.assertFalse(directory.exists());self.assertTrue(self.run_action('archive',**body)['duplicate']);self.assertEqual(self.run_action('history',archived=True)['items'][0]['status'],'archived')
  directory.mkdir();(directory/'新文件').write_text('新数据')
  with self.assertRaises(module.FileError):self.run_action('restore',change_id='archive-1')
  self.assertEqual((directory/'新文件').read_text(),'新数据');(directory/'新文件').unlink();directory.rmdir();self.run_action('restore',change_id='archive-1');self.assertEqual((directory/'结果.txt').read_text(),'成果');self.assertTrue(self.run_action('restore',change_id='archive-1')['duplicate'])
 def test_symlink_hardlink_traversal_and_special_files(self):
  secret=self.base/'secret';secret.write_text('private');(self.root/'link.txt').symlink_to(secret);(self.root/'outside').symlink_to(self.base,target_is_directory=True);os.link(secret,self.root/'hard.txt');os.mkfifo(self.root/'pipe')
  for path in ['../secret','/secret','outside/secret','link.txt','hard.txt','pipe','.env']:
   with self.assertRaises((module.FileError,OSError)):self.run_action('read',path=path)
  result=self.run_action('list');self.assertEqual(result['skipped'],4);self.assertEqual([i['name'] for i in result['items']],['笔记.md'])
 def test_pagination_and_drafts_conflict(self):
  for i in range(180):(self.root/f'file-{i:03}.txt').write_text(str(i))
  page=self.run_action('list');self.assertEqual(len(page['items']),80);self.assertEqual(page['total'],181);self.assertEqual(self.run_action('list',offset=160)['next'],None)
  self.assertEqual(self.run_action('list',query='file-00')['total'],10)
  draft=self.run_action('draft',path='笔记.md')['draft'];self.run_action('draft',path='笔记.md',revision=draft['revision'],text='设备一',base_revision='base')
  with self.assertRaises(module.FileError):self.run_action('draft',path='笔记.md',revision=0,text='设备二',base_revision='base')
  self.assertEqual(self.run_action('draft',path='笔记.md')['draft']['text'],'设备一')
 def test_readonly_and_binary_and_corrupt_history_fail_closed(self):
  with self.assertRaises(module.FileError):self.files.run({'action':'mkdir','root':'read-only','path':'no'})
  (self.root/'binary').write_bytes(b'\x00\xff');self.assertEqual(self.run_action('inspect',path='binary')['bytes'],2)
  with self.assertRaises(module.FileError):self.run_action('read',path='binary')
  self.save();(self.state/'file-history/save-1.json').write_text('{broken')
  with self.assertRaises(ValueError):self.run_action('history')
  self.assertEqual(self.file.read_text(),'修改')
 def test_durable_intent_failure_preserves_original(self):
  original=module.json_file
  def failing(*args):raise OSError('disk full')
  module.json_file=failing
  try:
   with self.assertRaises(OSError):self.save()
  finally:module.json_file=original
  self.assertEqual(self.file.read_text(),'初稿\n')
 def test_parent_descriptor_does_not_follow_replaced_symlink(self):
  directory=self.root/'dir';directory.mkdir();outside=self.base/'outside';outside.mkdir()
  with self.files.location('workspace','dir/new.txt',write=True) as (_,root,parent,name,revision):
   directory.rename(self.root/'old');directory.symlink_to(outside,target_is_directory=True)
   fd=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600,dir_fd=parent);os.write(fd,b'inside');os.close(fd)
  self.assertFalse((outside/'new.txt').exists());self.assertEqual((self.root/'old/new.txt').read_bytes(),b'inside')

if __name__=='__main__':unittest.main()
