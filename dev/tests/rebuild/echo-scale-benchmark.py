"""Measure ECHO list latency with a synthetic queue; writes only under /tmp."""
import importlib.util
import json
import statistics
import tempfile
import time
import tracemalloc
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location('panel_echo', ROOT / 'app/server/panel-echo.py')
ECHO = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ECHO)


def percentile(values, fraction):
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int((len(ordered) - 1) * fraction))]


def run():
    root_count = 3000
    children_per_root = 1
    tasks = []
    identifier = 0
    for root_index in range(root_count):
        identifier += 1
        root_id = identifier
        tasks.append({
            'id': root_id, 'title': '合成队列根任务 {}'.format(root_index),
            'detail': '规模测试使用的合成内容', 'status': 'done' if root_index % 4 else 'pending',
            'star': 3, 'entries': [], 'events': [],
        })
        for child_index in range(children_per_root):
            identifier += 1
            tasks.append({
                'id': identifier, 'parent': root_id,
                'title': '合成子任务 {}'.format(child_index),
                'detail': '规模搜索标记 scale-hit-{}'.format(root_index),
                'status': 'done' if root_index % 4 else 'pending',
                'entries': [{'text': '合成事件内容'}], 'events': [],
            })

    data = {'version': 1, 'seq': identifier, 'tasks': tasks, 'panel_operations': {}}
    ECHO.validate(data)
    serialized = json.dumps(data, ensure_ascii=False, separators=(',', ':')).encode()
    scenarios = {
        'first_page': {'limit': 30},
        'middle_page': {'limit': 30, 'before_id': root_count // 2},
        'status_filter': {'limit': 30, 'status': 'pending'},
        'deep_search': {'limit': 30, 'query': 'scale-hit-1200'},
    }
    runs = 25
    results = {}
    with tempfile.TemporaryDirectory(prefix='hermes-echo-scale-', dir='/tmp') as directory:
        path = Path(directory) / 'tasks.json'
        path.write_bytes(serialized)
        path.with_name('tasks.json.lock').touch()
        tracemalloc.start()
        for name, request in scenarios.items():
            timings = []
            response_bytes = 0
            for _ in range(runs):
                started = time.perf_counter()
                response = ECHO.execute({'action': 'list', **request}, path, Path(directory) / 'backups')
                timings.append((time.perf_counter() - started) * 1000)
                response_bytes = len(json.dumps(response, ensure_ascii=False, separators=(',', ':')).encode())
                expected_roots = {
                    'first_page': root_count,
                    'middle_page': root_count,
                    'status_filter': root_count // 4,
                    'deep_search': 1,
                }[name]
                if response['total'] != expected_roots or len(response['tasks']) > 2 * 30:
                    raise AssertionError('{} returned unexpected pagination/search results'.format(name))
                if name == 'deep_search' and response['tasks'][1]['detail'] != '规模搜索标记 scale-hit-1200':
                    raise AssertionError('deep search did not find the nested task content')
            results[name] = {
                'p50_ms': round(statistics.median(timings), 2),
                'p95_ms': round(percentile(timings, 0.95), 2),
                'response_bytes': response_bytes,
                'total_roots': response['total'],
                'returned_tasks': len(response['tasks']),
            }
        _, peak_bytes = tracemalloc.get_traced_memory()
        tracemalloc.stop()
    print(json.dumps({
        'queue_roots': root_count,
        'queue_tasks': len(tasks),
        'children_per_root': children_per_root,
        'queue_json_bytes': len(serialized),
        'runs_per_scenario': runs,
        'python_peak_traced_bytes': peak_bytes,
        'scope': 'synthetic local fixture; temporary files only; no production data or model calls',
        'scenarios': results,
    }, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    run()
