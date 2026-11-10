import contextlib
import fcntl
import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path

EDITABLE = ('name', 'prompt', 'schedule', 'deliver', 'skills', 'repeat', 'script', 'workdir', 'model', 'provider', 'base_url', 'no_agent', 'context_from', 'enabled_toolsets', 'attach_to_session')


def revision(job):
    configuration = {key: job.get(key) for key in EDITABLE}
    repeat = configuration.get('repeat')
    if isinstance(repeat, dict):
        configuration['repeat'] = repeat.get('times')
    return hashlib.sha256(json.dumps(configuration, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def execute(request, home, native_root, backup_root):
    os.environ['HERMES_HOME'] = str(home)
    os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
    sys.path.insert(0, str(native_root))
    import cron.jobs as native
    from tools.cronjob_tools import cronjob

    depth = 0

    @contextlib.contextmanager
    def strict_lock():
        nonlocal depth
        if depth:
            depth += 1
            try:
                yield
            finally:
                depth -= 1
            return
        lock_path = Path(home) / 'cron' / '.jobs.lock'
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        with lock_path.open('a+') as handle:
            deadline = time.monotonic() + 8
            while True:
                try:
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise TimeoutError('任务正在更新，原任务未修改，请稍后重试')
                    time.sleep(0.05)
            depth = 1
            try:
                yield
            finally:
                depth = 0
                fcntl.flock(handle, fcntl.LOCK_UN)

    native._jobs_lock = strict_lock
    action = request.get('action')
    if action not in ('create', 'update', 'pause', 'resume', 'run', 'archive', 'restore'):
        raise ValueError('不支持的任务操作')
    with strict_lock():
        jobs_file = Path(home) / 'cron' / 'jobs.json'
        raw_store = json.loads(jobs_file.read_text(encoding='utf-8-sig')) if jobs_file.exists() else {'jobs': []}
        raw_jobs = raw_store if isinstance(raw_store, list) else raw_store['jobs']
        existing = None
        if action == 'create':
            request_id = request.get('request_id', '')
            if not isinstance(request_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{8,128}', request_id):
                raise ValueError('缺少有效的创建标识')
            fingerprint = revision(request)
            previous = next((job for job in raw_jobs if job.get('panel_request_id') == request_id), None)
            if previous:
                if previous.get('panel_request_fingerprint') != fingerprint:
                    raise ValueError('该创建请求已保存；请刷新任务列表后编辑')
                return {'ok': True, 'job': {**previous, 'panel_revision': revision(previous)}, 'duplicate': True}
            original_save = native.save_jobs
            original_ids = {job['id'] for job in raw_jobs}

            def save_created(jobs):
                for job in jobs:
                    if job['id'] not in original_ids:
                        job['panel_request_id'] = request_id
                        job['panel_request_fingerprint'] = fingerprint
                original_save(jobs)

            native.save_jobs = save_created
        if action != 'create':
            job_id = request.get('job_id', '')
            if not job_id or any(char in job_id for char in '/\\\0'):
                raise ValueError('无效的任务标识')
            stored = next((job for job in raw_jobs if job.get('id') == job_id), None)
            existing = stored
            if not existing:
                raise ValueError('任务不存在')
            if action == 'update' and not request.get('revision'):
                raise ValueError('缺少任务版本，请重新打开任务后编辑')
            if request.get('revision') and request['revision'] != revision(existing):
                raise ValueError('任务设定已被其他页面修改，请刷新后合并')
            backup_root.mkdir(parents=True, exist_ok=True)
            backup = backup_root / (job_id + '-' + str(time.time_ns()) + '.json')
            content = json.dumps(existing, ensure_ascii=False, indent=2).encode()
            with backup.open('xb') as handle:
                os.chmod(backup, 0o600)
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
        if action == 'update' and 'schedule' in request:
            parsed = native.parse_schedule(request['schedule'])
            current = existing.get('schedule') or {}
            fields = ('kind', 'expr', 'minutes', 'run_at')
            if all(parsed.get(key) == current.get(key) for key in fields):
                request = {key: value for key, value in request.items() if key != 'schedule'}
        if action == 'archive':
            if existing.get('panel_archived'):
                result = {'success': True}
            else:
                previous_state = {key: existing.get(key) for key in ('state', 'enabled', 'paused_at', 'paused_reason', 'next_run_at')}
                updated = native.update_job(request['job_id'], {'panel_archived': True, 'panel_archive_state': previous_state,
                    'enabled': False, 'state': 'paused', 'paused_reason': '面板归档', 'paused_at': native._hermes_now().isoformat()})
                result = {'success': bool(updated)}
        elif action == 'restore':
            if not existing.get('panel_archived'):
                raise ValueError('任务未归档')
            updated = native.update_job(request['job_id'], {**existing.get('panel_archive_state', {}),
                'panel_archived': False, 'panel_archive_state': None})
            result = {'success': bool(updated)}
        elif existing and existing.get('panel_archived'):
            raise ValueError('任务已归档，请先恢复再操作')
        elif action == 'run':
            updated = native.trigger_job(request['job_id'])
            result = {'success': bool(updated), 'queued': True}
        else:
            arguments = {key: value for key, value in request.items() if key in EDITABLE or key == 'job_id'}
            result = json.loads(cronjob(action=action, **arguments))
        if not result.get('success'):
            raise ValueError(result.get('error') or '任务操作失败')
        job_id = result.get('job_id') or request.get('job_id')
        updated = native.get_job(job_id)
        if updated:
            saved_store = json.loads(jobs_file.read_text(encoding='utf-8-sig'))
            saved_jobs = saved_store if isinstance(saved_store, list) else saved_store['jobs']
            updated['panel_revision'] = revision(next(job for job in saved_jobs if job['id'] == job_id))
        return {'ok': True, 'job': updated, 'queued': result.get('queued', False), 'backup': backup.name if existing else None}


if __name__ == '__main__':
    try:
        result = execute(json.load(sys.stdin), Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]))
        print(json.dumps(result, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=False))
        sys.exit(1)
