"""Exact-owner ECHO execution lease; the native cron scheduler remains the runner."""
import contextvars
import copy
import functools
import json
import os
import re
import threading
import uuid
from pathlib import Path

from .store import owner_alive, panel, process_identity, read, transaction

CURRENT = contextvars.ContextVar('panel_echo_run', default=None)
DATA = Path('/vol1/@apphome/hermes-agent/data')
QUEUE = Path('/vol1/1000/飞牛文件/html/.acl/tasks/tasks.json')
BACKUPS = Path('/vol1/@appdata/hermes-agent/panel-state/echo-backups')
LEGACY = str(DATA / 'scripts/taskq.py')
CLI = str(Path(__file__).with_name('taskq.py'))


def matches(job):
    script = str(job.get('script') or '')
    return script in ('taskq_tick.sh', str(DATA / 'scripts/taskq_tick.sh')) and not job.get('no_agent')


def reserve(queue, backups, job, policy, now=None):
    now = now or policy.datetime.now(policy.TZ)
    with transaction(queue, backups) as data:
        # Recover only a provably dead owner. Time without a card edit proves nothing.
        for task in data['tasks']:
            run = task.get('panel_run') or {}
            if run.get('state') == 'running' and owner_alive(run.get('owner')) is False:
                run.update(state='interrupted', finished_at=panel.timestamp())
                task.pop('panel_cancel_requested', None)
                if task['status'] == 'doing':
                    task.update(status='failed', error='执行进程已退出；保留结果和历史，请核对后重试')
                panel.event(task, 'interrupted', '执行进程已退出，未自动重新派发')
        if any((t.get('panel_run') or {}).get('state') == 'running' or t['status'] == 'doing' for t in data['tasks']):
            return None, '已有执行占用；未重复派发'
        peak, reason = policy.peak_status(now)
        if peak:
            return None, reason
        pending = policy.pending_of(data)
        if not pending:
            return None, '没有待回信任务'
        task = pending[0]
        if task.get('attempts'):
            try:
                gap = now - policy.datetime.fromisoformat(task.get('claimed_at') or task['updated'])
                if gap.total_seconds() < 40 * 60:
                    return None, '本任务仍在 40 分钟冷却期'
            except (ValueError, KeyError):
                pass
        if not process_identity():
            raise RuntimeError('无法确定执行进程身份，未派发任务')
        if task.get('panel_run'):
            task.setdefault('panel_runs', []).append(copy.deepcopy(task['panel_run']))
        run = {'id': uuid.uuid4().hex, 'job_id': job['id'], 'owner': process_identity(),
               'state': 'running', 'started_at': panel.timestamp(), 'session_id': None,
               'model_requested': (task.get('exec') or {}).get('model') or job.get('model') or '',
               'task_snapshot': {key: copy.deepcopy(task.get(key)) for key in ('title', 'detail', 'exec', 'star', 'track')}}
        task.update(panel_run=run, status='doing', claimed_at=panel.timestamp(), picked_at=panel.timestamp(),
                    attempts=task.get('attempts', 0) + 1, error='')
        data['last_run'] = panel.timestamp()
        panel.event(task, 'claim', '定时执行器已接住；本次执行 ' + run['id'][:8])
        return copy.deepcopy(task), reason


class Run:
    def __init__(self, task, queue, backups):
        self.task = task
        self.queue, self.backups = Path(queue), Path(backups)
        self.id = task['panel_run']['id']
        self.agent = self.future = None
        self.cancelled = False
        self.error = ''
        self.finalizing = False
        self.outcome = None

    def change(self, change):
        with transaction(self.queue, self.backups) as data:
            task = next(t for t in data['tasks'] if t['id'] == self.task['id'])
            if (task.get('panel_run') or {}).get('id') != self.id:
                raise RuntimeError('执行记录已改变，拒绝写回过期结果')
            return change(task)

    def bind(self, session_id):
        def update(task):
            if task.get('panel_cancel_requested'):
                raise RuntimeError('用户已取消任务，未开始模型请求')
            task['panel_run'].update(session_id=session_id, session_ids=[session_id])
        self.change(update)

    def poll(self):
        if self.agent:
            current = getattr(self.agent, 'session_id', None)
            if current and current != getattr(self, 'last_session', None):
                def record(task):
                    run = task['panel_run']
                    if run.get('state') != 'running':
                        return
                    run['session_id'] = current
                    ids = run.setdefault('session_ids', [])
                    if current not in ids:
                        ids.append(current)
                self.change(record)
                self.last_session = current
        with panel.locked(self.queue, False):
            _, data = read(self.queue)
        task = next(t for t in data['tasks'] if t['id'] == self.task['id'])
        if (task.get('panel_run') or {}).get('state') != 'running':
            return
        if task.get('panel_cancel_requested') and self.agent and not self.cancelled:
            from agent.interrupt_compat import request_hard_interrupt
            request_hard_interrupt(self.agent, '用户取消回声站任务')
            self.cancelled = True
            self.change(lambda t: panel.event(t, 'cancel_signal', '取消信号已交给执行器，等待本次调用退出'))

    def finish(self, outcome):
        def commit(task):
            run = task['panel_run']
            if run.get('state') != 'running':
                return
            cancelled = bool(task.get('panel_cancel_requested'))
            run.update(state='cancelled' if cancelled else ('completed' if task['status'] in ('done', 'review') else 'interrupted'),
                       finished_at=panel.timestamp())
            if self.agent:
                run['session_id'] = getattr(self.agent, 'session_id', None) or run.get('session_id')
                run['model'] = getattr(self.agent, 'model', None)
                ids = run.setdefault('session_ids', [])
                if run['session_id'] and run['session_id'] not in ids:
                    ids.append(run['session_id'])
            from . import taskq
            rounds = taskq.exact_rounds(task)
            if rounds is not None:
                task.update(rounds=rounds, rounds_src='gateway')
            usage = [taskq.usage_of(sid) for sid in run.get('session_ids') or [run.get('session_id') or '']]
            usage = [item for item in usage if item]
            if usage:
                task['usage'] = {key: sum(item.get(key) or 0 for item in usage) for key in ('hit','miss','out','calls','recorded_cost_usd')}
                task['usage'].update(sessions=usage, sess=run.get('session_id'), model=run.get('model'))
            if task['status'] == 'doing' or cancelled:
                task['status'] = 'failed'
                task['error'] = '已取消；已发生的工具操作不会自动撤销' if cancelled else '执行结束但未提交交付；请核对执行记录后重试'
                panel.event(task, run['state'], task['error'])
            task.pop('panel_cancel_requested', None)
        self.change(commit)

    def finalize(self, outcome):
        # A transient disk/lock error must not leave a live-PID lease wedged.
        # Keep the monitor until the terminal write succeeds; never rerun tools.
        self.outcome, self.finalizing = outcome, True
        self.finish(outcome)
        self.finalizing = False

    def prompt(self, policy):
        # The old formatter silently sliced requirements into at most 20×200
        # characters. Execution receives the full frozen task text instead.
        detail = json.dumps({key: self.task.get(key) for key in ('id','title','detail','exec','todos','result','deliver','decide')}, ensure_ascii=False, indent=2)
        return '\n'.join([detail, policy.TODO_LEAD, policy.RESULT_LEAD.replace(LEGACY, CLI),
            '当前任务 ID: ' + str(self.task['id']),
            '本次已经认领。所有 taskq 命令使用 ' + CLI + '。旧 DATA/scripts/taskq.py 不再用于执行。',
            '实际模型由调度器设置；深入模式是任务自检要求，不代表已执行轮数。', '{"wakeAgent": true}'])


def script_result(path):
    run = CURRENT.get()
    if run and str(path) in ('taskq_tick.sh', str(DATA / 'scripts/taskq_tick.sh')):
        from . import taskq
        return True, run.prompt(taskq)
    if str(path) in ('taskq_tick.sh', str(DATA / 'scripts/taskq_tick.sh')):
        return True, '未取得回声站执行租约\n{"wakeAgent": false}'
    if str(path) in ('taskq_sediment.sh', str(DATA / 'scripts/taskq_sediment.sh')):
        # Avoid executing the unchanged DATA shell wrapper's old Python writer.
        # Capture locally, not redirect_stdout (process-global across cron jobs).
        import subprocess
        from tools.environments.local import build_subprocess_env
        result = subprocess.run([os.sys.executable, '-B', CLI, 'sediment'], capture_output=True, text=True, timeout=20, env=build_subprocess_env())
        return result.returncode == 0, result.stdout if result.returncode == 0 else result.stderr
    return None


def session_started(session_id):
    run = CURRENT.get()
    if run:
        run.bind(session_id)


def session_finishing(database, session_id):
    run = CURRENT.get()
    if run:
        ids = database.get_compression_lineage(session_id)
        def commit(task):
            record = task['panel_run']
            # Native lineage can include only compression continuations, not
            # delegated agents. Keep the exact bound root as an invariant.
            root = (record.get('session_ids') or [record.get('session_id')])[0]
            if root not in ids:
                raise RuntimeError('执行会话续接记录不匹配')
            record.update(session_id=session_id, session_ids=ids)
        run.change(commit)


def agent_started(agent, future):
    run = CURRENT.get()
    if run:
        run.agent, run.future = agent, future


def child_env(env):
    run = CURRENT.get()
    for key in ('ECHO_RUN_ID', 'ECHO_TASK_ID'):
        env.pop(key, None)
    if run:
        env.update(ECHO_RUN_ID=run.id, ECHO_TASK_ID=str(run.task['id']))
    return env


def rewrite_command(command):
    # Compatibility for saved skills/prompts. Only exact script path tokens,
    # never bare "taskq", similarly named files, or arbitrary path fragments.
    return re.sub(r'(?<![\w/.-])' + re.escape(LEGACY) + r'(?![\w/.-])', lambda _: CLI, command)


def guarded(function):
    @functools.wraps(function)
    def wrapper(job, *args, **kwargs):
        if not matches(job):
            return function(job, *args, **kwargs)
        from . import taskq
        taskq.refresh_balance()
        task, reason = reserve(QUEUE, BACKUPS, job, taskq)
        if not task:
            return True, '回声站：' + reason, '[SILENT]', None
        run = Run(task, QUEUE, BACKUPS)
        context = CURRENT.set(run)
        stop = threading.Event()
        outcome = None
        def monitor():
            while not stop.wait(1):
                try:
                    if run.finalizing:
                        run.finalize(run.outcome)
                        stop.set()
                    else:
                        run.poll()
                except Exception as error:
                    run.error = str(error)
        worker = threading.Thread(target=monitor, name='echo-cancel', daemon=True)
        worker.start()
        try:
            if task.get('track'):
                # Honor the existing user's notification setting, never enabled by tests.
                from tools.environments.local import build_subprocess_env
                with_context = build_subprocess_env()
                with_context.update(ECHO_RUN_ID=run.id, ECHO_TASK_ID=str(task['id']))
                # notify() writes its audit through tx(); context is passed explicitly
                # through a separate process to avoid process-global env races.
                import subprocess
                try:
                    subprocess.run([os.sys.executable, '-B', CLI, 'notify-claim', str(task['id'])], env=with_context,
                                   capture_output=True, text=True, timeout=30, check=True)
                except Exception:
                    run.change(lambda t: panel.event(t, 'bark', '手机推送未成功，本次任务继续执行'))
            job = copy.deepcopy(job)
            job['prompt'] = str(job.get('prompt') or '').replace(LEGACY, CLI)
            model = (task.get('exec') or {}).get('model')
            if model:
                job['model'] = model
            outcome = function(job, *args, **kwargs)
            return outcome
        finally:
            CURRENT.reset(context)
            # A timed-out worker may still be unwinding a tool. Keep its lease
            # until its future settles; a new cron run must not replay it.
            if run.future and not run.future.done():
                def settled(_):
                    try:
                        run.finalize(outcome)
                        stop.set()
                    except Exception as error:
                        run.error = str(error)
                run.future.add_done_callback(settled)
            else:
                try:
                    run.finalize(outcome)
                    stop.set()
                except Exception as error:
                    run.error = str(error)
    return wrapper
