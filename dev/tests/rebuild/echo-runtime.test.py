import copy
import importlib.util
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import Future
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace, ModuleType
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'app/server'))
from echo import runtime, store, taskq


class EchoRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.queue = self.root / 'tasks.json'
        self.backups = self.root / 'backups'
        self.task = {'id': 1, 'title': '隔离验收', 'detail': '不执行真实工具', 'star': 3, 'status': 'pending',
                     'attempts': 0, 'events': [], 'entries': [], 'todos': [{'c': '应保留未完成', 's': 'todo'}], 'exec': {}}
        self.queue.write_text(json.dumps({'seq': 1, 'version': 1, 'tasks': [self.task], 'custom': '保留'}))
        self.owner = {'pid': os.getpid(), 'start': 'fixture', 'boot': 'fixture'}
        self.job = {'id': 'fixture-job', 'script': 'taskq_tick.sh', 'model': 'default-model'}
        self.policy = SimpleNamespace(datetime=taskq.datetime, TZ=taskq.TZ, pending_of=taskq.pending_of,
                                      peak_status=lambda now: (False, '隔离空闲时间'))
        for module, attr, value in [(runtime, 'QUEUE', self.queue), (runtime, 'BACKUPS', self.backups),
                                    (taskq, 'QUEUE', self.queue), (taskq, 'BACKUPS', self.backups), (taskq, 'DATA', self.root)]:
            binding = patch.object(module, attr, value); binding.start(); self.addCleanup(binding.stop)
        binding = patch.object(runtime, 'process_identity', lambda: self.owner); binding.start(); self.addCleanup(binding.stop)
        binding = patch.object(taskq, 'refresh_balance', lambda: None); binding.start(); self.addCleanup(binding.stop)
        binding = patch.object(taskq, 'peak_status', self.policy.peak_status); binding.start(); self.addCleanup(binding.stop)

    def data(self):
        return json.loads(self.queue.read_text())

    def reserve(self):
        return runtime.reserve(self.queue, self.backups, self.job, self.policy)[0]

    def test_lease_blocks_duplicate_and_never_recycles_by_age(self):
        first = self.reserve()
        with store.transaction(self.queue, self.backups) as data:
            data['tasks'][0]['updated'] = '2000-01-01T00:00:00+08:00'
        with patch.object(runtime, 'owner_alive', lambda _: True):
            self.assertIsNone(self.reserve())
        self.assertEqual(self.data()['tasks'][0]['panel_run']['id'], first['panel_run']['id'])
        self.assertEqual(self.data()['custom'], '保留')

    def test_dead_owner_pauses_without_replay_and_retains_result(self):
        self.reserve()
        with store.transaction(self.queue, self.backups) as data:
            data['tasks'][0]['result'] = '中断前的产出'
        with patch.object(runtime, 'owner_alive', lambda _: False):
            self.assertIsNone(self.reserve())
        task = self.data()['tasks'][0]
        self.assertEqual(task['status'], 'failed')
        self.assertEqual(task['result'], '中断前的产出')
        self.assertEqual(task['panel_run']['state'], 'interrupted')
        self.assertEqual(task['attempts'], 1)

    def test_unknown_owner_does_not_recover(self):
        self.reserve()
        with patch.object(runtime, 'owner_alive', lambda _: None):
            self.assertIsNone(self.reserve())
        self.assertEqual(self.data()['tasks'][0]['status'], 'doing')

    def test_transaction_exception_and_corruption_preserve_original(self):
        original = self.queue.read_bytes()
        with self.assertRaises(RuntimeError):
            with store.transaction(self.queue, self.backups) as data:
                data['tasks'].clear()
                raise RuntimeError('fault injection')
        self.assertEqual(self.queue.read_bytes(), original)
        self.queue.write_bytes(b'{broken')
        with self.assertRaises(ValueError):
            self.reserve()
        self.assertEqual(self.queue.read_bytes(), b'{broken')

    def test_cli_result_requires_current_run_and_does_not_complete_todos(self):
        task = self.reserve(); run = runtime.Run(task, self.queue, self.backups); run.bind('cron_fixture_exact')
        arguments = SimpleNamespace(id=1, result='交付', deliver='', decide='', json='', rounds=0, review=False)
        before = self.queue.read_bytes()
        with patch.dict(os.environ, {'ECHO_RUN_ID': 'old-run', 'ECHO_TASK_ID': '1'}):
            with self.assertRaisesRegex(ValueError, '其他执行'):
                taskq.cmd_done(arguments)
        self.assertEqual(self.queue.read_bytes(), before)
        with patch.dict(os.environ, {'ECHO_RUN_ID': run.id, 'ECHO_TASK_ID': '1'}):
            self.assertEqual(taskq.cmd_done(arguments), 0)
            before = self.queue.read_bytes()
            self.assertEqual(taskq.cmd_done(arguments), 0)
            self.assertEqual(self.queue.read_bytes(), before)
            arguments.result='不同的重复交付'
            with self.assertRaisesRegex(ValueError, '交付已保存'):
                taskq.cmd_done(arguments)
        saved = self.data()['tasks'][0]
        self.assertEqual(saved['todos'][0]['s'], 'todo')
        self.assertEqual(saved['status'], 'done')
        self.assertEqual(saved['panel_run']['state'], 'running')
        run.finish((True, '', 'result', None))
        self.assertEqual(self.data()['tasks'][0]['panel_run']['state'], 'completed')

    def test_invalid_result_does_not_consume_submission(self):
        task = self.reserve();run=runtime.Run(task,self.queue,self.backups)
        arguments=SimpleNamespace(id=1,result='',deliver='',decide='',json='{broken',rounds=0,review=False)
        before=self.queue.read_bytes()
        with patch.dict(os.environ, {'ECHO_RUN_ID':run.id,'ECHO_TASK_ID':'1'}):
            self.assertEqual(taskq.cmd_done(arguments),1)
        self.assertEqual(self.queue.read_bytes(),before)

    def test_frozen_requirements_are_not_truncated(self):
        with store.transaction(self.queue,self.backups) as data:
            data['tasks'][0]['detail']='长任务条件' * 700 + '末尾验收条件'
        task=self.reserve();prompt=runtime.Run(task,self.queue,self.backups).prompt(taskq)
        self.assertIn('末尾验收条件',prompt)
        self.assertIn(task['detail'],prompt)

    def test_finalize_can_retry_storage_failure_without_reexecution(self):
        task=self.reserve();run=runtime.Run(task,self.queue,self.backups)
        original=run.finish
        with patch.object(run,'finish',side_effect=OSError('disk fault')):
            with self.assertRaises(OSError):run.finalize((False,'','','interrupted'))
        self.assertTrue(run.finalizing)
        run.finalize(run.outcome)
        self.assertFalse(run.finalizing)
        self.assertEqual(self.data()['tasks'][0]['attempts'],1)
        self.assertEqual(self.data()['tasks'][0]['panel_run']['state'],'interrupted')

    def test_cancel_is_request_then_execution_ack(self):
        task = self.reserve(); run = runtime.Run(task, self.queue, self.backups)
        current = store.panel.execute({'action': 'list'}, self.queue, self.backups)['tasks'][0]
        result = store.panel.execute({'action': 'cancel', 'id': 1, 'revision': current['panel_revision'],
                                      'request_id': 'cancel-fixture-123'}, self.queue, self.backups)
        self.assertEqual(result['task']['status'], 'doing')
        with patch.dict(os.environ, {'ECHO_RUN_ID': run.id, 'ECHO_TASK_ID': '1'}):
            with self.assertRaisesRegex(ValueError, '已请求取消'):
                with taskq.tx() as data:
                    data['tasks'][0]['result'] = '过期回写'
        run.finish((False, '', '', 'cancelled'))
        saved = self.data()['tasks'][0]
        self.assertEqual(saved['panel_run']['state'], 'cancelled')
        self.assertEqual(saved['status'], 'failed')

    def test_native_decorator_preserves_other_jobs_and_task_model(self):
        with store.transaction(self.queue, self.backups) as data:
            data['tasks'][0]['exec'] = {'mode': 'deep', 'iters': 3, 'model': 'specific-model'}
        calls = []
        @runtime.guarded
        def execute(job):
            calls.append(job)
            run = runtime.CURRENT.get()
            self.assertEqual(runtime.script_result(job['script'])[0], True)
            self.assertIn('当前任务 ID: 1', runtime.script_result(job['script'])[1])
            runtime.session_started('cron_exact')
            run.change(lambda task: task.update(status='done'))
            return True, '', '交付', None
        execute(self.job)
        self.assertEqual(calls[0]['model'], 'specific-model')
        self.assertEqual(self.job['model'], 'default-model')
        self.assertIsNone(runtime.CURRENT.get())
        self.assertEqual(self.data()['tasks'][0]['panel_run']['session_id'], 'cron_exact')
        marker = object()
        self.assertIs(runtime.guarded(lambda job: marker)({'id': 'other', 'script': 'backup.sh'}), marker)

    def test_unwinding_worker_keeps_lease_until_future_finishes(self):
        future = Future()
        @runtime.guarded
        def execute(job):
            runtime.agent_started(SimpleNamespace(session_id='cron_future', model='model'), future)
            return False, '', '', 'timeout'
        execute(self.job)
        self.assertEqual(self.data()['tasks'][0]['panel_run']['state'], 'running')
        with patch.object(runtime, 'owner_alive', lambda _: True):
            self.assertIsNone(self.reserve())
        future.set_result({'failed': True})
        self.assertEqual(self.data()['tasks'][0]['panel_run']['state'], 'interrupted')

    def test_exact_session_usage_not_time_guess_or_fixed_price(self):
        self.reserve(); run = runtime.Run(self.data()['tasks'][0], self.queue, self.backups); run.bind('cron_exact')
        with sqlite3.connect(self.root / 'state.db') as db:
            db.executescript("CREATE TABLE sessions(id TEXT, input_tokens INT, output_tokens INT, cache_read_tokens INT, api_call_count INT, started_at REAL, model TEXT, estimated_cost_usd REAL); INSERT INTO sessions VALUES ('cron_exact',100,20,60,3,1700000000,'non-flash',0.2); INSERT INTO sessions VALUES ('wrong',900,900,0,99,1700000001,'wrong',5);")
        self.assertEqual(taskq.exact_rounds(self.data()['tasks'][0]), 3)
        usage = taskq.usage_of(taskq.session_of(self.data()['tasks'][0]))
        self.assertEqual(usage['model'], 'non-flash')
        self.assertNotIn('cny', usage)
        self.assertEqual(taskq.session_of({'claimed_at': '2026-11-04'}), '')

    def test_environment_no_cross_run_leak_and_exact_path_compatibility(self):
        self.assertNotIn('ECHO_RUN_ID', runtime.child_env({'ECHO_RUN_ID': 'other'}))
        original = 'python3 "' + runtime.LEGACY + '" done 1'
        self.assertIn(runtime.CLI, runtime.rewrite_command(original))
        self.assertEqual(runtime.rewrite_command(runtime.LEGACY + '.bak'), runtime.LEGACY + '.bak')
        self.assertEqual(runtime.rewrite_command('echo /different/scripts/taskq.py'), 'echo /different/scripts/taskq.py')

    def test_cancel_reaches_bound_agent_once_and_waits_for_ack(self):
        task=self.reserve();run=runtime.Run(task,self.queue,self.backups)
        run.agent=SimpleNamespace(session_id='cron_bound')
        with store.transaction(self.queue,self.backups) as data:data['tasks'][0]['panel_cancel_requested']='requested'
        calls=[];compat=ModuleType('agent.interrupt_compat');compat.request_hard_interrupt=lambda agent,reason:calls.append((agent,reason))
        with patch.dict(sys.modules,{'agent.interrupt_compat':compat}):
            run.poll();run.poll()
        self.assertEqual(len(calls),1)
        self.assertIs(calls[0][0],run.agent)
        self.assertEqual(self.data()['tasks'][0]['panel_run']['state'],'running')

    def test_compression_lineage_keeps_original_root_and_excludes_foreign_chain(self):
        task=self.reserve();run=runtime.Run(task,self.queue,self.backups);run.bind('cron_root')
        token=runtime.CURRENT.set(run)
        try:
            runtime.session_finishing(SimpleNamespace(get_compression_lineage=lambda sid:['cron_root','cron_middle','cron_tip']),'cron_tip')
            self.assertEqual(self.data()['tasks'][0]['panel_run']['session_ids'],['cron_root','cron_middle','cron_tip'])
            with self.assertRaisesRegex(RuntimeError,'不匹配'):
                runtime.session_finishing(SimpleNamespace(get_compression_lineage=lambda sid:['other','other-tip']),'other-tip')
        finally:runtime.CURRENT.reset(token)

    @unittest.skipUnless(Path('/proc/self/stat').exists(), 'Linux exact process identity')
    def test_real_processes_only_one_claim_and_dead_owner_recovery(self):
        code = '''import sys,json
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from echo import runtime,taskq
taskq.peak_status=lambda now:(False,'fixture')
task,reason=runtime.reserve(Path(sys.argv[2]),Path(sys.argv[3]),{'id':'fixture-job'},taskq)
print(json.dumps({'claimed':bool(task)}),flush=True)
sys.stdin.readline()
'''
        workers = [subprocess.Popen([sys.executable, '-B', '-c', code, str(ROOT / 'app/server'), str(self.queue), str(self.backups)],
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(8)]
        try:
            outputs = [json.loads(worker.stdout.readline()) for worker in workers]
            self.assertEqual(sum(item['claimed'] for item in outputs), 1)
            self.assertEqual(self.data()['tasks'][0]['attempts'], 1)
        finally:
            for worker in workers:
                worker.communicate('\n', timeout=10)
        self.assertIsNone(self.reserve())
        self.assertEqual(self.data()['tasks'][0]['status'], 'failed')


if __name__ == '__main__':
    unittest.main()
