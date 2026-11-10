import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[3] / 'app/server/panel-echo.py'
SPEC = importlib.util.spec_from_file_location('echo', SCRIPT)
ECHO = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ECHO)


class EchoTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.file = self.root / 'tasks.json'
        self.file.write_text(json.dumps({'version': 1, 'seq': 0, 'tasks': [], 'custom_metadata': {'keep': True}}))
        self.backups = self.root / 'backups'

    def run_request(self, request):
        return ECHO.execute(request, self.file, self.backups)

    def create(self, request_id='create-fixture-123', **fields):
        return self.run_request({'action': 'create', 'request_id': request_id, 'body': {
            'title': '任务', 'detail': '验证队列', 'type': '开发', 'star': 3, **fields}})['task']

    def mutate(self, task, action, **body):
        return self.run_request({'action': action, 'id': task['id'], 'revision': task['panel_revision'],
                                 'request_id': action + '-fixture-123', 'body': body})['task']

    def test_create_gate_idempotency_backup_and_metadata(self):
        original = self.file.read_bytes()
        task = self.create(star=0.5)
        self.assertEqual(task['status'], 'staged')
        self.assertEqual(next(self.backups.glob('*.json')).read_bytes(), original)
        response = self.run_request({'action': 'create', 'request_id': 'create-fixture-123', 'body': {
            'title': '任务', 'detail': '验证队列', 'type': '开发', 'star': 0.5}})
        self.assertTrue(response['duplicate'])
        data = json.loads(self.file.read_text())
        self.assertEqual(len(data['tasks']), 1)
        self.assertEqual(data['custom_metadata'], {'keep': True})
        self.assertEqual(next(self.backups.glob('*.json')).stat().st_mode & 0o777, 0o600)

    def test_conflict_and_running_state_never_overwrite(self):
        task = self.create()
        data = json.loads(self.file.read_text())
        data['tasks'][0]['status'] = 'doing'
        data['tasks'][0]['result'] = '执行器进度'
        self.file.write_text(json.dumps(data))
        before = self.file.read_bytes()
        with self.assertRaisesRegex(ValueError, '已被执行器'):
            self.mutate(task, 'update', title='过期修改')
        current = self.run_request({'action': 'list'})['tasks'][0]
        with self.assertRaisesRegex(ValueError, '正在执行'):
            self.mutate(current, 'archive')
        self.assertEqual(self.file.read_bytes(), before)

    def test_corruption_and_invalid_input_are_not_replaced(self):
        for payload in ('{broken', '{"tasks":[],"seq":"invalid"}'):
            self.file.write_text(payload)
            with self.assertRaises((ValueError, json.JSONDecodeError)):
                self.create()
            self.assertEqual(self.file.read_text(), payload)
        self.file.write_text('{"tasks":[],"seq":0}')
        before = self.file.read_bytes()
        for star in (-1, True, 9, 0.7):
            with self.assertRaises(ValueError):
                self.create(star=star)
        self.assertEqual(self.file.read_bytes(), before)

    def test_archive_restore_and_half_star_cannot_enqueue(self):
        task = self.create(star=0.5)
        with self.assertRaises(ValueError):
            self.mutate(task, 'enqueue')
        archived = self.mutate(task, 'archive')
        self.assertEqual(archived['status'], 'dropped')
        restored = self.mutate(archived, 'restore')
        self.assertEqual(restored['status'], 'staged')
        self.assertGreaterEqual(len(restored['events']), 3)

    def test_child_keeps_parent_history_and_prevents_parent_archive(self):
        task = self.create()
        child = self.mutate(task, 'spawn', detail='继续完善验收')
        self.assertEqual(child['parent'], task['id'])
        self.assertIn('目标：任务', child['detail'])
        parent = self.run_request({'action': 'list'})['tasks'][0]
        self.assertEqual(parent['entries'], [])
        with self.assertRaisesRegex(ValueError, '未结束的子任务'):
            self.mutate(parent, 'archive')

    def test_cross_device_drafts_have_revision_and_never_mutate_queue(self):
        task = self.create()
        queue_before = self.file.read_bytes()
        draft_path = self.root / 'var' / 'panel-state' / 'echo-drafts.json'
        draft = self.run_draft({'action': 'draft_save', 'key': 'update:1', 'values': {'title': '远端修改', 'detail': '保留未保存'},
                                'source_revision': task['panel_revision'], 'request_id': 'draft-request-123', 'client_id': 'device-one'})['draft']
        self.assertEqual(self.run_draft({'action': 'draft_get', 'key': 'update:1'})['draft']['values']['detail'], '保留未保存')
        self.assertEqual(self.file.read_bytes(), queue_before)
        with self.assertRaisesRegex(ValueError, '其他页面更新'):
            self.run_draft({'action': 'draft_save', 'key': 'update:1', 'draft_revision': 'stale', 'values': {'detail': '覆盖'}, 'client_id': 'device-two'})
        self.assertEqual(self.run_draft({'action': 'draft_get', 'key': 'update:1'})['draft']['draft_revision'], draft['draft_revision'])
        self.run_draft({'action': 'draft_delete', 'key': 'update:1', 'draft_revision': draft['draft_revision']})
        self.assertIsNone(self.run_draft({'action': 'draft_get', 'key': 'update:1'})['draft'])
        self.assertEqual(self.file.read_bytes(), queue_before)
        self.assertEqual(draft_path.stat().st_mode & 0o777, 0o600)

    def run_draft(self, request):
        return ECHO.execute_draft(request, self.root / 'var' / 'panel-state' / 'echo-drafts.json')

    def test_concurrent_processes_preserve_all_creates(self):
        workers = []
        for index in range(10):
            request = {'action': 'create', 'request_id': 'parallel-fixture-' + str(index), 'body': {
                'title': '任务' + str(index), 'detail': '并发写入', 'type': '开发', 'star': 3}}
            process = subprocess.Popen([sys.executable, '-B', str(SCRIPT), str(self.file), str(self.backups)],
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            process.stdin.write(json.dumps(request))
            process.stdin.close()
            workers.append(process)
        for process in workers:
            process.wait(timeout=10)
            self.assertEqual(process.returncode, 0, process.stdout.read() + process.stderr.read())
            process.stdout.close()
            process.stderr.close()
        data = json.loads(self.file.read_text())
        self.assertEqual(len(data['tasks']), 10)
        self.assertEqual(len({task['id'] for task in data['tasks']}), 10)

    def test_archive_checks_grandchildren_and_preserves_hierarchy(self):
        parent = self.create()
        child = self.mutate(parent, 'spawn', detail='第一层')
        data = json.loads(self.file.read_text())
        data['tasks'][1]['status'] = 'done'
        data['seq'] = 3
        data['tasks'].append({'id': 3, 'parent': child['id'], 'status': 'pending', 'title': '孙任务'})
        self.file.write_text(json.dumps(data))
        current = self.run_request({'action': 'list'})['tasks'][0]
        before = self.file.read_bytes()
        with self.assertRaisesRegex(ValueError, '未结束的子任务'):
            self.mutate(current, 'archive')
        self.assertEqual(self.file.read_bytes(), before)

    def test_root_pagination_searches_complete_families_and_filters_effective_state(self):
        tasks = []
        for identifier in range(1, 36):
            tasks.append({'id': identifier, 'title': '根任务 ' + str(identifier), 'detail': '根要求',
                          'status': 'done', 'star': 3})
        tasks.extend([
            {'id': 36, 'parent': 35, 'title': '最终子任务', 'detail': '跨页唯一命中词', 'status': 'pending'},
            {'id': 37, 'parent': 35, 'title': '更新中的最后子任务', 'detail': '状态由最后一个子任务决定', 'status': 'doing'},
        ])
        self.file.write_text(json.dumps({'version': 1, 'seq': 37, 'tasks': tasks, 'last_run': 'fixture'}))

        first = self.run_request({'action': 'list', 'limit': 30, 'offset': 0})
        second = self.run_request({'action': 'list', 'limit': 30, 'before_id': 6})
        self.assertEqual((first['total'], first['has_more']), (35, True))
        self.assertEqual(len([task for task in first['tasks'] if not task.get('parent')]), 30)
        self.assertEqual((first['next_before_id'], second['total'], second['has_more']), (6, 35, False))
        self.assertEqual([task['id'] for task in second['tasks']], [5, 4, 3, 2, 1])
        self.assertEqual(first['last_run'], 'fixture')

        match = self.run_request({'action': 'list', 'limit': 30, 'offset': 0, 'query': '跨页唯一命中词'})
        self.assertEqual(match['total'], 1)
        self.assertEqual([task['id'] for task in match['tasks']], [35, 36, 37])
        state_match = self.run_request({'action': 'list', 'limit': 30, 'status': 'doing'})
        self.assertEqual(state_match['total'], 1)
        self.assertEqual(state_match['tasks'][0]['id'], 35)

    def test_root_pagination_validates_inputs_without_changing_queue(self):
        self.create()
        original = self.file.read_bytes()
        for request in (
            {'action': 'list', 'limit': 0}, {'action': 'list', 'limit': 101},
            {'action': 'list', 'offset': -1}, {'action': 'list', 'query': 'x' * 201},
            {'action': 'list', 'status': 'unknown'}, {'action': 'list', 'before_id': 0},
        ):
            with self.subTest(request=request), self.assertRaises(ValueError):
                self.run_request(request)
        self.assertEqual(self.file.read_bytes(), original)

    def test_root_cursor_does_not_repeat_or_skip_when_new_root_arrives(self):
        tasks = [{'id': identifier, 'title': f'任务 {identifier}', 'detail': '游标测试',
                  'status': 'done', 'star': 3} for identifier in range(1, 36)]
        self.file.write_text(json.dumps({'version': 1, 'seq': 35, 'tasks': tasks}))
        first = self.run_request({'action': 'list', 'limit': 30})
        data = json.loads(self.file.read_text())
        data['seq'] = 36
        data['tasks'].append({'id': 36, 'title': '新任务', 'detail': '并发新增', 'status': 'pending', 'star': 3})
        self.file.write_text(json.dumps(data))
        second = self.run_request({'action': 'list', 'limit': 30, 'before_id': first['next_before_id']})
        self.assertEqual([task['id'] for task in second['tasks']], [5, 4, 3, 2, 1])


if __name__ == '__main__':
    unittest.main()
