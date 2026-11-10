import datetime
import json
import sqlite3
import sys
from collections import defaultdict
from pathlib import Path

TOKEN_FIELDS = ('input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens', 'api_call_count')


def read_usage(database):
    connection = sqlite3.connect(Path(database).resolve().as_uri() + '?mode=ro', uri=True, timeout=5)
    connection.row_factory = sqlite3.Row
    connection.execute('PRAGMA query_only=ON')
    connection.execute('BEGIN')
    tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if 'sessions' not in tables:
        raise ValueError('用量数据库缺少会话表')
    def select_fields(table, fields):
        columns = {row[1] for row in connection.execute('PRAGMA table_info('+table+')')}
        selected = [field for field in fields if field in columns]
        return [dict(row) for row in connection.execute('SELECT '+','.join(selected)+' FROM '+table)]
    sessions = select_fields('sessions', ('id', *TOKEN_FIELDS))
    ledger = select_fields('session_model_usage', ('session_id','model','billing_provider','task',*TOKEN_FIELDS,'estimated_cost_usd','actual_cost_usd','cost_status')) if 'session_model_usage' in tables else []
    recorded_main = defaultdict(lambda: defaultdict(int))
    groups = {}

    def add(row, historical=False):
        model = row.get('model')
        if not model or model in ('unknown', 'auto'):
            model = None
        provider = row.get('billing_provider') or None
        task = row.get('task') or 'main'
        key = (model, provider, task, historical)
        if key not in groups:
            groups[key] = {'model': model, 'provider': provider, 'task': task, 'historical': historical,
                           'session_ids': set(), 'estimated_cost_usd': 0, 'actual_cost_usd': 0,
                           'priced_records': 0, 'billed_records': 0, 'usage_records': 0, **{field: 0 for field in TOKEN_FIELDS}}
        target = groups[key]
        target['usage_records'] += 1
        target['session_ids'].add(row.get('session_id') or row.get('id'))
        for field in TOKEN_FIELDS:
            target[field] += int(row.get(field) or 0)
        cost_status = row.get('cost_status') or ''
        # Native auxiliary records have no status; a positive stored estimate is still evidence.
        auxiliary_estimate = bool(row.get('task')) and float(row.get('estimated_cost_usd') or 0) > 0
        if row.get('estimated_cost_usd') is not None and (cost_status not in ('unknown', 'unavailable', 'unpriced', '') or auxiliary_estimate):
            target['estimated_cost_usd'] += float(row['estimated_cost_usd'])
            target['priced_records'] += 1
        if row.get('actual_cost_usd') is not None and cost_status in ('actual', 'billed', 'actual_reported'):
            target['actual_cost_usd'] += float(row['actual_cost_usd'])
            target['billed_records'] += 1

    for row in ledger:
        add(row)
        if not row.get('task'):
            for field in TOKEN_FIELDS:
                recorded_main[row['session_id']][field] += int(row.get(field) or 0)
    for session in sessions:
        saved = recorded_main.get(session['id'], {})
        remainder = {field: max(0, int(session.get(field) or 0) - saved.get(field, 0)) for field in TOKEN_FIELDS}
        if any(remainder.values()):
            add({'id': session['id'], 'model': None, 'billing_provider': None, **remainder}, historical=True)
    rows = []
    for group in groups.values():
        group['sessions'] = len(group.pop('session_ids'))
        group['total_tokens'] = group['input_tokens'] + group['output_tokens']
        if not group['priced_records']:
            group['estimated_cost_usd'] = None
        if not group['billed_records']:
            group['actual_cost_usd'] = None
        rows.append(group)
    rows.sort(key=lambda row: row['total_tokens'], reverse=True)
    totals = {field: sum(row[field] for row in rows) for field in TOKEN_FIELDS}
    totals['total_tokens'] = totals['input_tokens'] + totals['output_tokens']
    totals['estimated_cost_usd'] = sum(row['estimated_cost_usd'] or 0 for row in rows) if any(row['priced_records'] for row in rows) else None
    totals['actual_cost_usd'] = sum(row['actual_cost_usd'] or 0 for row in rows) if any(row['billed_records'] for row in rows) else None
    activity = []
    message_count = 0
    if 'messages' in tables:
        columns = {row[1] for row in connection.execute('PRAGMA table_info(messages)')}
        where = 'WHERE active=1' if 'active' in columns else ''
        message_count = connection.execute('SELECT count(*) FROM messages ' + where).fetchone()[0]
        activity = [dict(row) for row in connection.execute(
            "SELECT date(timestamp,'unixepoch','+8 hours') AS date,count(*) AS messages,count(distinct session_id) AS sessions "
            'FROM messages ' + where + ' GROUP BY date ORDER BY date DESC LIMIT 30')]
    connection.close()
    coverage = {'ledger_rows': len(ledger), 'main_rows': sum(not row.get('task') for row in ledger),
                'auxiliary_rows': sum(bool(row.get('task')) for row in ledger),
                'priced_rows': sum(row['priced_records'] for row in rows),
                'billed_rows': sum(row['billed_records'] for row in rows),
                'historical_tokens': sum(row['total_tokens'] for row in rows if row['historical']),
                'ledger_unattributed_tokens': sum(row['total_tokens'] for row in rows if not row['historical'] and row['model'] is None)}
    coverage['unpriced_rows'] = len(ledger) - coverage['priced_rows']
    return {'source': 'Hermes 执行记录', 'timezone': 'Asia/Shanghai', 'period': '全部已记录调用',
            'total_sessions': len(sessions), 'total_messages': message_count, 'totals': totals, 'by_model': rows,
            'activity': activity, 'coverage': coverage, 'unattributed_tokens': sum(row['total_tokens'] for row in rows if row['model'] is None),
            'notes': ['包含主对话与图像理解、压缩、标题等辅助调用；不重复相加会话汇总。',
                      '费用是已保存金额的小计，记录按会话、模型和任务聚合；有金额不代表其中每次调用都已计价。',
                      '每日表只统计消息活动。旧用量按会话累计保存，无法还原每一天的 token 消耗。'],
            'updated_at': datetime.datetime.now(datetime.timezone.utc).isoformat()}


if __name__ == '__main__':
    try:
        print(json.dumps({'ok': True, 'usage': read_usage(sys.argv[1])}, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'ok': False, 'error': '读取用量失败：' + str(error)}, ensure_ascii=False))
        sys.exit(1)
