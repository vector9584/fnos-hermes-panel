import fcntl
import hashlib
import json
import math
import os
import re
import sys
import tempfile
import time
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

STATUSES = ('staged', 'pending', 'doing', 'review', 'done', 'failed', 'dropped')
TYPES = ('开发', '研究', '运维', '内容', '生活', '其他')


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def timestamp():
    return datetime.now().astimezone().isoformat(timespec='seconds')


def validate(data):
    if not isinstance(data, dict) or not isinstance(data.get('tasks'), list) or not isinstance(data.get('seq'), int):
        raise ValueError('任务文件结构不完整，原文件未修改')
    identifiers = set()
    for task in data['tasks']:
        identifier = task.get('id') if isinstance(task, dict) else None
        if isinstance(identifier, bool) or not isinstance(identifier, int) or identifier <= 0 or identifier in identifiers:
            raise ValueError('任务标识损坏或重复，原文件未修改')
        if task.get('status') not in STATUSES:
            raise ValueError('任务状态无法识别，原文件未修改')
        identifiers.add(identifier)
    if isinstance(data['seq'], bool) or data['seq'] < 0 or identifiers and data['seq'] < max(identifiers):
        raise ValueError('任务序号落后于已存任务，原文件未修改')
    by_id = {task['id']: task for task in data['tasks']}
    for task in data['tasks']:
        visited = {task['id']}
        parent = task.get('parent')
        while parent:
            if parent in visited or parent not in by_id:
                raise ValueError('任务层级存在循环或缺少父任务，原文件未修改')
            visited.add(parent)
            parent = by_id[parent].get('parent')


@contextmanager
def locked(path, exclusive):
    lock = Path(str(path) + '.lock')
    try:
        descriptor = os.open(lock, os.O_RDWR | os.O_CREAT, 0o666)
    except PermissionError:
        descriptor = os.open(lock, os.O_RDONLY)
    try:
        deadline = time.monotonic() + 8
        while True:
            try:
                fcntl.flock(descriptor, (fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH) | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise TimeoutError('队列正被执行器更新，请稍后重试')
                time.sleep(0.05)
        yield
    finally:
        os.close(descriptor)


def save(path, data):
    payload = json.dumps(data, ensure_ascii=False, indent=2).encode()
    mode = path.stat().st_mode & 0o777
    descriptor, temporary = tempfile.mkstemp(prefix='.echo-', suffix='.tmp', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'wb') as handle:
            handle.write(payload)
            handle.flush()
            os.fchmod(handle.fileno(), mode)
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def draft_key(value):
    if not isinstance(value, str) or not re.fullmatch(r'(?:create|update|answer|spawn):(?:new|[0-9]+)', value):
        raise ValueError('草稿标识无效')
    return value


def draft_store(path):
    path = Path(path)
    if not path.exists():
        return {'version': 1, 'drafts': {}}
    value = json.loads(path.read_text())
    if not isinstance(value, dict) or value.get('version') != 1 or not isinstance(value.get('drafts'), dict):
        raise ValueError('草稿记录结构不完整，原文件未修改')
    return value


def execute_draft(request, path):
    action = request.get('action')
    key = draft_key(request.get('key'))
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with locked(path, action != 'draft_get'):
        if action == 'draft_get' and not Path(path).exists():
            return {'ok': True, 'draft': None}
        if not Path(path).exists():
            Path(path).write_text(json.dumps({'version': 1, 'drafts': {}}, ensure_ascii=False))
            os.chmod(path, 0o600)
        data = draft_store(path)
        current = data['drafts'].get(key)
        if action == 'draft_get':
            return {'ok': True, 'draft': current}
        if action == 'draft_delete':
            if current and request.get('draft_revision') != current.get('draft_revision'):
                raise ValueError('草稿已被其他页面更新，请读取最新版本')
            data['drafts'].pop(key, None)
        elif action == 'draft_save':
            if current and request.get('draft_revision') != current.get('draft_revision'):
                raise ValueError('草稿已被其他页面更新，请读取最新版本')
            values = request.get('values')
            if not isinstance(values, dict) or len(json.dumps(values, ensure_ascii=False)) > 64 * 1024:
                raise ValueError('草稿内容过长或格式无效')
            allowed = {'title', 'detail', 'type', 'star', 'deep', 'iters', 'model', 'track', 'staged'}
            if any(name not in allowed for name in values):
                raise ValueError('草稿包含不支持的字段')
            now = int(time.time() * 1000)
            record = {
                'key': key, 'values': values, 'initial': request.get('initial') if isinstance(request.get('initial'), dict) else {},
                'source_revision': request.get('source_revision'), 'request_id': request.get('request_id'),
                'updated_at': now, 'client_id': request.get('client_id', '')
            }
            record['draft_revision'] = digest(record)
            data['drafts'][key] = record
        else:
            raise ValueError('不支持此草稿操作')
        save(path, data)
        return {'ok': True, 'draft': data['drafts'].get(key)}


def clean(body, partial):
    result = {}
    for field, limit in (('title', 120), ('detail', 4000)):
        if partial and field not in body:
            continue
        value = body.get(field)
        if not isinstance(value, str) or not value.strip() or len(value.strip()) > limit:
            raise ValueError(('标题' if field == 'title' else '任务要求') + '不能为空且不能超过 ' + str(limit) + ' 字')
        result[field] = value.strip()
    if not partial or 'type' in body:
        if body.get('type') not in TYPES:
            raise ValueError('请选择任务类型')
        result['type'] = body['type']
    if not partial or 'star' in body:
        value = body.get('star', 3)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0.5 <= value <= 5 or value * 2 != int(value * 2):
            raise ValueError('优先级为 0.5–5 星，步长 0.5')
        result['star'] = value
    for field in ('track',):
        if field in body:
            if not isinstance(body[field], bool):
                raise ValueError('跟踪开关必须为布尔值')
            result[field] = body[field]
    if 'exec' in body:
        execution = body['exec']
        if not isinstance(execution, dict) or execution.get('mode') not in ('normal', 'deep'):
            raise ValueError('执行方式无效')
        iterations = execution.get('iters', 3)
        model = execution.get('model', '')
        if isinstance(iterations, bool) or not isinstance(iterations, int) or not 1 <= iterations <= 10 or not isinstance(model, str) or len(model) > 120:
            raise ValueError('执行次数或模型设定无效')
        result['exec'] = {'mode': execution['mode'], 'iters': iterations, 'model': model.strip()}
    return result


def event(task, kind, text):
    task.setdefault('events', []).append({'t': timestamp(), 'k': kind, 'text': text, 'by': 'panel'})
    task['updated'] = timestamp()


def list_tasks(data, request):
    limit = request.get('limit')
    offset = request.get('offset', 0)
    before_id = request.get('before_id')
    query = request.get('query', '')
    status = request.get('status', 'all')
    if limit is not None and (isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100):
        raise ValueError('每页数量必须在 1 到 100 之间')
    if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
        raise ValueError('任务页码无效')
    if before_id is not None and (isinstance(before_id, bool) or not isinstance(before_id, int) or before_id <= 0):
        raise ValueError('任务游标无效')
    if not isinstance(query, str) or len(query) > 200:
        raise ValueError('搜索内容不能超过 200 字')
    if status not in ('all', *STATUSES):
        raise ValueError('任务状态筛选无效')

    tasks = data['tasks']
    by_id = {task['id']: task for task in tasks}
    children = {}
    for task in tasks:
        children.setdefault(task.get('parent'), []).append(task)
    for nested in children.values():
        nested.sort(key=lambda task: task['id'])

    def family(root):
        result, pending, seen = [], [root], set()
        while pending:
            task = pending.pop()
            if task['id'] in seen:
                continue
            seen.add(task['id'])
            result.append(task)
            pending.extend(reversed(children.get(task['id'], [])))
        return result

    def effective(root):
        current, seen = root, set()
        while current['id'] not in seen:
            seen.add(current['id'])
            nested = children.get(current['id'], [])
            if not nested:
                return current['status']
            current = nested[-1]
        return 'failed'

    needle = query.strip().lower()
    roots = []
    for task in tasks:
        if task.get('parent'):
            continue
        members = family(task)
        if status != 'all' and effective(task) != status:
            continue
        if needle and not any(
            needle == '#' + str(member['id']) or needle in '\n'.join((
                str(member.get('title', '')), str(member.get('detail', '')),
                str(member.get('result', '')), str(member.get('deliver', '')),
                str(member.get('decide', '')), json.dumps(member.get('entries', []), ensure_ascii=False),
            )).lower()
            for member in members
        ):
            continue
        roots.append((task, members))
    roots.sort(key=lambda item: item[0]['id'], reverse=True)
    total = len(roots)
    if before_id is not None:
        roots = [item for item in roots if item[0]['id'] < before_id]
    remaining = len(roots)
    selected = roots[offset:offset + limit if limit is not None else None]
    visible = [member for _, members in selected for member in members]
    return {
        'ok': True,
        'tasks': [{**task, 'panel_revision': digest(task)} for task in visible],
        'last_run': data.get('last_run'), 'revision': digest(data),
        'total': total, 'offset': offset, 'limit': limit, 'before_id': before_id,
        'next_before_id': selected[-1][0]['id'] if selected and offset + len(selected) < remaining else None,
        'has_more': offset + len(selected) < remaining,
    }


def execute(request, path, backups):
    action = request.get('action', 'list')
    if action not in ('list', 'create', 'update', 'stage', 'enqueue', 'archive', 'restore', 'retry', 'answer', 'spawn', 'cancel', 'recover'):
        raise ValueError('不支持此队列操作')
    if not path.is_file():
        raise ValueError('ECHO 任务文件不存在，未新建或替换队列')
    with locked(path, action != 'list'):
        original = path.read_bytes()
        data = json.loads(original)
        validate(data)
        if action == 'list':
            return list_tasks(data, request)
        request_id = request.get('request_id')
        if not isinstance(request_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{8,128}', request_id):
            raise ValueError('缺少操作标识，请重新打开表单')
        fingerprint = digest(request)
        operations = data.setdefault('panel_operations', {})
        previous = operations.get(request_id)
        if previous:
            if previous['fingerprint'] != fingerprint:
                raise ValueError('该操作已保存，请刷新后使用最新任务继续编辑')
            return {'ok': True, 'duplicate': True, 'task_id': previous['task_id']}
        task = next((item for item in data['tasks'] if item['id'] == request.get('id')), None)
        if action != 'create':
            if not task:
                raise ValueError('任务不存在')
            if request.get('revision') != digest(task):
                raise ValueError('任务已被执行器或其他页面更新，请刷新后合并')
            if (task['status'] == 'doing' or (task.get('panel_run') or {}).get('state') == 'running') and action not in ('cancel', 'recover'):
                raise ValueError('任务正在执行，不能覆盖执行器状态；请等待回信后操作')
        body = request.get('body') or {}
        now = timestamp()
        if action in ('create', 'answer', 'spawn'):
            parent = None if action == 'create' else task
            if action == 'create':
                fields = clean(body, False)
            else:
                if action == 'answer' and parent['status'] != 'review':
                    raise ValueError('该任务已不在待定状态')
                want = body.get('detail', '').strip()
                if not want and action == 'answer':
                    want = '\n'.join(re.sub(r'^\s*(建议|方案|对策)\s*[:：]\s*', '', line) for line in str(parent.get('decide', '')).splitlines() if re.match(r'^\s*(建议|方案|对策)\s*[:：]', line))
                if not want or len(want) > 4000:
                    raise ValueError('请写明子任务要求，最多 4000 字')
                completed = [item.get('c', '') for item in parent.get('todos', []) if item.get('s') == 'done']
                unfinished = [item.get('c', '') for item in parent.get('todos', []) if item.get('s') != 'done']
                fields = {'title': parent['title'], 'type': parent.get('type', '其他'), 'star': parent.get('star', 3),
                          'exec': parent.get('exec', {}), 'detail': '目标：' + parent['title'] + '\n任务：' + want + '\n已完成：\n' + ('\n'.join(completed) or '无') + '\n未完成：\n' + '\n'.join([*unfinished, want])}
            data['seq'] += 1
            task = {'id': data['seq'], **fields, 'priority': fields['star'], 'status': 'staged' if fields['star'] < 1 or body.get('staged') else 'pending',
                    'created': now, 'updated': now, 'attempts': 0, 'rounds': 0, 'source': 'panel', 'tags': [fields['type']],
                    'todos': [], 'entries': [], 'events': [], 'result': '', 'deliver': '', 'decide': '', 'error': '',
                    'track': fields.get('track', False)}
            if parent:
                task.update(parent=parent['id'], call=parent.get('call', parent['id']))
                if action == 'answer':
                    parent['status'] = 'done'
                    parent['decide'] = ''
                event(parent, action, '已开出子任务 #' + str(task['id']))
            event(task, 'created', task['detail'])
            data['tasks'].append(task)
        elif action == 'cancel':
            run = task.get('panel_run') or {}
            if run.get('state') != 'running':
                raise ValueError('该任务没有可取消的执行；旧执行需先核对运行状态')
            task['panel_cancel_requested'] = task.get('panel_cancel_requested') or now
            event(task, 'cancel_requested', '已请求取消，等待执行器停止；已有工具操作不会自动撤销')
        elif action == 'recover':
            from echo.store import owner_alive
            run = task.get('panel_run') or {}
            if run.get('state') != 'running' or owner_alive(run.get('owner')) is not False:
                raise ValueError('尚不能证明执行进程已退出，未改变任务状态')
            run.update(state='interrupted', finished_at=now)
            if task['status'] == 'doing':
                task.update(status='failed', error='执行进程已退出；核对已有结果后可手动重试')
            task.pop('panel_cancel_requested', None)
            event(task, 'interrupted', '确认原执行进程已退出，保留历史，未自动重试')
        elif action == 'update':
            fields = clean(body, True)
            if not fields:
                raise ValueError('没有需要保存的修改')
            task.update(fields)
            task['priority'] = task['star']
            if 'type' in fields:
                task['tags'] = list(dict.fromkeys([fields['type'], *task.get('tags', [])]))
            if 'star' in fields and task['status'] in ('pending', 'staged'):
                task['status'] = 'pending' if fields['star'] >= 1 else 'staged'
            event(task, 'edit', '更新任务设定：' + '、'.join(fields))
        elif action == 'archive':
            descendants = {task['id']}
            while True:
                expanded = descendants | {item['id'] for item in data['tasks'] if item.get('parent') in descendants}
                if expanded == descendants:
                    break
                descendants = expanded
            if any(item['id'] != task['id'] and item['id'] in descendants and item['status'] in ('pending', 'doing', 'staged', 'review') for item in data['tasks']):
                raise ValueError('还有未结束的子任务，请先处理子任务')
            if task['status'] == 'dropped':
                raise ValueError('任务已归档')
            task['panel_before_archive'] = task['status']
            task['status'] = 'dropped'
            task['archived_at'] = now
            if not (task.get('sediment') or {}).get('status') == 'done' and task['panel_before_archive'] in ('done', 'review'):
                task['sediment'] = {'at': now, 'status': 'pending'}
            event(task, 'archive', '归档并保留任务与全部历史')
        elif action == 'restore':
            if task['status'] != 'dropped':
                raise ValueError('任务未归档')
            task['status'] = task.pop('panel_before_archive', 'staged')
            task['archived_at'] = None
            event(task, 'restore', '恢复归档前状态')
        elif action in ('stage', 'enqueue', 'retry'):
            allowed = ('failed',) if action == 'retry' else ('pending', 'staged')
            if task['status'] not in allowed:
                raise ValueError('当前任务状态不支持此操作')
            if action != 'stage' and task.get('star', 0) < 1:
                raise ValueError('一星以下为暂存，请先提高星级')
            task['status'] = 'staged' if action == 'stage' else 'pending'
            if action == 'retry':
                task['panel_previous_attempts'] = task.get('attempts', 0)
                task['attempts'] = 0
            event(task, action, '暂存任务' if action == 'stage' else '已加入待回信队列')
        validate(data)
        operations[request_id] = {'fingerprint': fingerprint, 'task_id': task['id'], 'at': now}
        backups.mkdir(parents=True, exist_ok=True)
        backup = backups / (str(time.time_ns()) + '-' + hashlib.sha256(original).hexdigest()[:12] + '.json')
        with backup.open('xb') as handle:
            os.fchmod(handle.fileno(), 0o600)
            handle.write(original)
            handle.flush()
            os.fsync(handle.fileno())
        save(path, data)
        return {'ok': True, 'task_id': task['id'], 'task': {**task, 'panel_revision': digest(task)}}


if __name__ == '__main__':
    try:
        request = json.load(sys.stdin)
        draft_path = Path(sys.argv[3]) if len(sys.argv) > 3 else Path(sys.argv[2]).parent / 'echo-drafts.json'
        if request.get('action') in ('draft_get', 'draft_save', 'draft_delete'):
            result = execute_draft(request, draft_path)
        else:
            result = execute(request, Path(sys.argv[1]), Path(sys.argv[2]))
        print(json.dumps(result, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=False))
        sys.exit(1)
