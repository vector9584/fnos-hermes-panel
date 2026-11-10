import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
NATIVE = Path(os.environ['HERMES_TEST_NATIVE_ROOT'])
SPEC = importlib.util.spec_from_file_location('panel_cron', ROOT / 'app/server/panel-cron.py')
CRON = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CRON)


class NativeCronTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='hermes-cron-test-', dir='/tmp')
        self.addCleanup(self.directory.cleanup)
        self.home = Path(self.directory.name)
        self.store = self.home / 'cron/jobs.json'
        self.store.parent.mkdir()
        self.job = {
            'id': 'fixture-job', 'name': '原任务', 'prompt': '', 'script': 'fixture.py',
            'no_agent': True, 'enabled': False, 'state': 'paused',
            'paused_reason': '用户暂停', 'paused_at': '2026-11-01T00:00:00+08:00',
            'schedule': {'kind': 'interval', 'minutes': 30, 'display': 'every 30m'},
            'repeat': {'times': 10, 'completed': 4}, 'deliver': 'discord:fixture-target',
            'skills': ['fixture-skill'], 'model': 'saved-model', 'provider': None,
            'context_from': None, 'last_run_at': '2026-11-01T00:00:00+08:00',
            'last_status': 'success', 'next_run_at': '2026-11-06T00:00:00+08:00',
        }
        self.store.write_text(json.dumps({'jobs': [self.job]}))

    def call(self, **changes):
        request = {'action': 'update', 'job_id': 'fixture-job', 'revision': CRON.revision(self.job), **changes}
        result = subprocess.run([sys.executable, '-B', str(ROOT / 'app/server/panel-cron.py'),
                                 str(self.home), str(NATIVE), str(self.home / 'backups')],
                                input=json.dumps(request), text=True, capture_output=True, timeout=30,
                                env={**os.environ, 'HOME': str(self.home), 'HERMES_HOME': str(self.home),
                                     'PYTHONDONTWRITEBYTECODE': '1'})
        try:
            return result.returncode, json.loads(result.stdout)
        except ValueError:
            self.fail('Invalid response: ' + result.stdout + result.stderr[-2000:])

    def test_edit_preserves_identity_state_history_and_script(self):
        code, result = self.call(name='新名称')
        self.assertEqual(code, 0, result)
        changed = result['job']
        self.assertEqual(changed['name'], '新名称')
        for key in ('id', 'script', 'no_agent', 'enabled', 'state', 'paused_reason', 'repeat',
                    'deliver', 'model', 'last_run_at', 'last_status', 'next_run_at'):
            self.assertEqual(changed[key], self.job[key], key)
        backups = list((self.home / 'backups').glob('*.json'))
        self.assertEqual(len(backups), 1)
        self.assertEqual(json.loads(backups[0].read_text())['name'], '原任务')
        self.assertEqual(backups[0].stat().st_mode & 0o777, 0o600)

    def test_repeat_edit_keeps_completed_count(self):
        code, result = self.call(repeat=0)
        self.assertEqual(code, 0, result)
        self.assertEqual(result['job']['repeat'], {'times': None, 'completed': 4})

    def test_legacy_missing_skills_does_not_create_false_conflict(self):
        del self.job['skills']
        self.store.write_text(json.dumps({'jobs': [self.job]}))
        code, result = self.call(name='旧任务改名')
        self.assertEqual(code, 0, result)
        self.assertEqual(result['job']['name'], '旧任务改名')

    def test_same_schedule_does_not_reschedule(self):
        code, result = self.call(name='只改名称', schedule='every 30m')
        self.assertEqual(code, 0, result)
        self.assertEqual(result['job']['next_run_at'], self.job['next_run_at'])
        self.assertEqual(result['job']['state'], 'paused')

    def test_invalid_schedule_keeps_bytes(self):
        before = self.store.read_bytes()
        code, result = self.call(schedule='invalid scheduling expression')
        self.assertNotEqual(code, 0)
        self.assertFalse(result['ok'])
        self.assertEqual(self.store.read_bytes(), before)

    def test_conflict_and_missing_revision_keep_bytes(self):
        before = self.store.read_bytes()
        for revision in ('0' * 64, None):
            code, result = self.call(name='不能覆盖', revision=revision)
            self.assertNotEqual(code, 0)
            self.assertFalse(result['ok'])
            self.assertEqual(self.store.read_bytes(), before)

    def test_corrupt_store_is_not_reset(self):
        self.store.write_bytes(b'{broken')
        code, result = self.call(name='不能清空')
        self.assertNotEqual(code, 0)
        self.assertFalse(result['ok'])
        self.assertEqual(self.store.read_bytes(), b'{broken')

    def test_create_retry_is_idempotent_and_changed_retry_conflicts(self):
        arguments = {'action': 'create', 'request_id': 'fixture-request-123', 'name': '新任务',
                     'prompt': '写一段日常问候', 'schedule': 'every 1h', 'deliver': 'local'}
        code, first = self.call(**arguments)
        self.assertEqual(code, 0, first)
        code, retry = self.call(**arguments)
        self.assertEqual(code, 0, retry)
        self.assertTrue(retry['duplicate'])
        self.assertEqual(retry['job']['id'], first['job']['id'])
        before = self.store.read_bytes()
        code, changed = self.call(**{**arguments, 'name': '不同请求内容'})
        self.assertNotEqual(code, 0, changed)
        self.assertEqual(self.store.read_bytes(), before)
        self.assertEqual(len(json.loads(before)['jobs']), 2)

    def test_archive_restore_keeps_task_output_and_paused_state(self):
        output = self.home / 'cron/output/fixture-job/result.md'
        output.parent.mkdir(parents=True)
        output.write_text('历史执行结果')
        code, archived = self.call(action='archive')
        self.assertEqual(code, 0, archived)
        self.assertTrue(archived['job']['panel_archived'])
        self.assertFalse(archived['job']['enabled'])
        code, restored = self.call(action='restore')
        self.assertEqual(code, 0, restored)
        self.assertFalse(restored['job']['panel_archived'])
        self.assertEqual(restored['job']['state'], 'paused')
        self.assertEqual(restored['job']['paused_reason'], '用户暂停')
        self.assertEqual(output.read_text(), '历史执行结果')
        self.assertEqual(restored['job']['repeat']['completed'], 4)

    def test_archived_task_cannot_be_run_until_restored(self):
        code, archived = self.call(action='archive')
        self.assertEqual(code, 0, archived)
        before = self.store.read_bytes()
        code, response = self.call(action='run')
        self.assertNotEqual(code, 0, response)
        self.assertEqual(self.store.read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
