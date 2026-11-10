"""Exercise the real PHP transaction layer against isolated JSON files."""
import hashlib
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
PHP = os.environ.get('TEST_PHP', 'php')
STORE = ROOT / 'app/echo-web/store.php'


class EchoWebTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.queue = self.root / 'tasks.json'
        self.queue.write_text(json.dumps({'version': 1, 'seq': 1, 'tasks': [{'id': 1, 'status': 'pending', 'title': '原任务', 'star': 3}], 'custom': '保留'}))

    def call(self, op='update', body=None, method='POST', origin=None):
        request = {'queue': str(self.queue), 'backups': str(self.root / 'backups'), 'store': str(STORE), 'op': op,
                   'body': body or {'_request_id': 'fixture-request-123'}, 'method': method, 'origin': origin}
        code = r'''
        $arg=json_decode(stream_get_contents(STDIN),true);
        define('DATA',$arg['queue']); define('ECHO_TEST_BACKUPS',$arg['backups']);
        define('STATUSES',['staged','pending','doing','review','done','failed','dropped']);
        function out(array $d,int $code=200):void {echo json_encode($d);exit;}
        require $arg['store'];
        $_SERVER['REQUEST_METHOD']=$arg['method']; $_SERVER['HTTP_X_ECHO_REQUEST']='1'; $_SERVER['HTTP_HOST']='echo.test';
        if($arg['origin']) $_SERVER['HTTP_ORIGIN']=$arg['origin'];
        $action=$arg['op'];$id=1;$body=$arg['body'];
        if($action==='read'){out(['ok'=>true,'data'=>read_only()]);}
        if(!array_key_exists('_revision',$body)) {
          try {$d=echo_read()[1];$body['_revision']=echo_revision($d['tasks'][0]);} catch(Throwable $e) {}
        }
        $result=mutate(function(array &$d)use($action){
          $d['tasks'][0]['title']='保存修改';
          if($action==='fault')throw new RuntimeException('fault injection');
          return $d['tasks'][0];
        });out(['ok'=>true,'task'=>$result]);
        '''
        result = subprocess.run([PHP, '-r', code], input=json.dumps(request), text=True, capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_write_backup_read_and_immutable_custom_data(self):
        before = self.queue.read_bytes()
        response = self.call()
        self.assertTrue(response['ok'], response)
        backup = self.root / 'backups' / (hashlib.sha256(before).hexdigest() + '.json')
        self.assertEqual(backup.read_bytes(), before)
        self.assertEqual(backup.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.call('read')['data']['custom'], '保留')

    def test_exception_and_corrupt_file_do_not_write_or_rename(self):
        before = self.queue.read_bytes()
        self.assertFalse(self.call('fault')['ok'])
        self.assertEqual(self.queue.read_bytes(), before)
        self.queue.write_text('{broken')
        self.assertFalse(self.call()['ok'])
        self.assertFalse(self.call('read')['ok'])
        self.assertEqual(self.queue.read_text(), '{broken')

    def test_cross_origin_get_stale_and_running_are_rejected(self):
        before = self.queue.read_bytes()
        for arguments in ({'method':'GET'}, {'origin':'https://evil.test'}, {'body':{'_request_id':'stale-fixture-123','_revision':'stale'}}):
            self.assertFalse(self.call(**arguments)['ok'])
            self.assertEqual(self.queue.read_bytes(), before)
        data = json.loads(before);data['tasks'][0]['status']='doing';self.queue.write_text(json.dumps(data))
        before = self.queue.read_bytes()
        self.assertFalse(self.call()['ok'])
        self.assertEqual(self.queue.read_bytes(), before)

    def test_idempotency_survives_retry_but_rejects_changed_body(self):
        # Fetch a stable revision before the first mutation.
        original = self.call('read')['data']['tasks'][0]
        # Match PHP's compact unescaped encoding.
        revision = hashlib.sha256(json.dumps(original, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
        body={'_request_id':'fixture-retry-123','_revision':revision}
        self.assertTrue(self.call(body=body)['ok'])
        before = self.queue.read_bytes()
        self.assertTrue(self.call(body=body)['ok'])
        self.assertFalse(self.call(body={**body,'new':'different'})['ok'])
        self.assertEqual(self.queue.read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
