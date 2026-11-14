"""Provider capability lab: real outbound requests for one configured provider.

Read-only with respect to config.yaml: never writes, never mutates credentials.
Every capability returns a normalized shape so the panel can render it generically:

    {ok, cap, ms, status, headline, lines[], preview, audio}

Secrets stay server-side: only booleans/paths/sizes leave this module.
"""
import base64, io, json, os, time, urllib.error, urllib.request, uuid
from pathlib import Path
from urllib.parse import urlsplit

from panel_config_txn import ConfigError
from panel_model_catalog import enabled, entries, provider_fields

CAPS = (
    ('models', '模型清单', 'GET /models，确认地址与密钥可用', 'net'),
    ('chat_basic', '基础对话', '普通 chat/completions 往返', 'net'),
    ('chat_thinking', '深度思考', 'thinking + reasoning_effort，返回思维链长度', 'net'),
    ('chat_title', '会话标题', 'title 参数，服务端生成标题', 'net'),
    ('chat_safety', '内容安全', 'safety_check 等级，风险输入应被拦', 'net'),
    ('chat_search', '联网搜索（对话内）', 'tools: deepseek_web_search 服务端工具', 'net'),
    ('chat_readurl', '阅读链接（对话内）', 'tools: deepseek_read_url 服务端工具', 'net'),
    ('chat_reminder', '用户元信息', 'latest_reminder 角色注入日期/地点/语言', 'net'),
    ('chat_file', '文件解析', '上传 /files 后在对话里引用 file_id', 'file'),
    ('tool_search', '独立搜索接口', 'POST /v1/tools/search', 'net'),
    ('tool_fetch', '独立抓取接口', 'POST /v1/tools/fetch', 'net'),
    ('tool_ocr', 'OCR 接口', 'POST /v1/tools/ocr（需图片）', 'file'),
    ('tool_asr', '语音识别', 'POST /v1/tools/asr（需音频）', 'file'),
    ('tool_tts', '语音合成', 'POST /v1/tools/tts，返回音频', 'net'),
)

DEFAULT_PROMPT = '用一句话说明你是谁'
SEARCH_QUERY = 'DeepSeek 最新模型'
FETCH_URL = 'https://api-docs.deepseek.com/zh-cn/'
TTS_TEXT = '你好，我是鲸鱼娘。这是一段语音合成测试。'


def _endpoints(base_url):
    base = str(base_url or '').strip().rstrip('/')
    if not base:
        raise ConfigError('该服务没有配置地址')
    if not urlsplit(base).scheme:
        raise ConfigError('服务地址缺少协议')
    root = base[:-3] if base.endswith('/v1') else base
    return {'chat': base + '/chat/completions', 'files': root + '/files',
            'tool': lambda name: root + '/v1/tools/' + name, 'models': base + '/models'}


def _env_file(home):
    values = {}
    for name in ('.env',):
        path = Path(home) / name
        if not path.exists():
            continue
        try:
            for line in path.read_text('utf-8', 'replace').splitlines():
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                key, _, value = line.partition('=')
                values[key.strip()] = value.strip().strip('"').strip("'")
        except OSError:
            pass
    return values


def resolve_target(data, provider_id, home):
    """Pick one enabled provider and resolve its base_url + real secret server-side."""
    catalog = entries(data)
    entry = catalog.get(provider_id)
    if not entry:
        raise ConfigError('模型服务不存在，请刷新', 404)
    fields = provider_fields(entry[2], entry[0])
    base = str(fields.get('base_url') or '').strip()
    item = entry[2]
    raw_key = str(item.get('api_key') or item.get('apiKey') or '').strip()
    env_name = ''
    for key in ('key_env', 'api_key_env', 'keyEnv', 'apiKeyEnv'):
        if item.get(key):
            env_name = str(item[key]).strip()
            break
    envs = _env_file(home)
    secret = ''
    if raw_key.startswith('${') and raw_key.endswith('}'):
        env_name = env_name or raw_key[2:-1]
        raw_key = ''
    if raw_key.startswith('$') and len(raw_key) > 1 and '/' not in raw_key:
        env_name = env_name or raw_key[1:]
        raw_key = ''
    if raw_key and not raw_key.startswith(('${', '$')):
        secret = raw_key
    if not secret and env_name:
        secret = os.environ.get(env_name) or envs.get(env_name) or ''
    if not secret:
        raise ConfigError('该服务没有可用的密钥，先在服务卡片里填好再试', 409)
    return {'id': provider_id, 'name': str(item.get('name') or provider_id),
            'base_url': base, 'api_mode': str(fields.get('api_mode') or 'chat_completions'),
            'secret': secret, 'urls': _endpoints(base)}


def _request(url, secret, payload=None, raw=None, ctype=None, timeout=25, headers=None):
    body = raw if raw is not None else (json.dumps(payload).encode() if payload is not None else None)
    req = urllib.request.Request(url, data=body, method='POST' if body is not None else 'GET')
    req.add_header('Authorization', 'Bearer ' + secret)
    if payload is not None:
        req.add_header('Content-Type', 'application/json')
    elif ctype:
        req.add_header('Content-Type', ctype)
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    started = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read(), int((time.time() - started) * 1000)
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read(), int((time.time() - started) * 1000)
    except Exception as exc:  # noqa: BLE001 - network errors must surface to the panel
        return -1, str(exc).encode(), int((time.time() - started) * 1000)


def _json(raw):
    try:
        return json.loads(raw.decode('utf-8', 'replace').lstrip())
    except Exception:  # noqa: BLE001
        return None


def _multipart(fields, files):
    boundary = '----cap' + uuid.uuid4().hex
    buf = io.BytesIO()
    for key, value in fields:
        buf.write(('--%s\r\nContent-Disposition: form-data; name="%s"\r\n\r\n%s\r\n' % (boundary, key, value)).encode())
    for key, filename, content in files:
        buf.write(('--%s\r\nContent-Disposition: form-data; name="%s"; filename="%s"\r\n' % (boundary, key, filename)).encode())
        buf.write(b'Content-Type: application/octet-stream\r\n\r\n')
        buf.write(content)
        buf.write(b'\r\n')
    buf.write(('--%s--\r\n' % boundary).encode())
    return buf.getvalue(), 'multipart/form-data; boundary=' + boundary


def _err(status, raw, ms, cap):
    parsed = _json(raw) or {}
    message = ''
    if isinstance(parsed, dict):
        error = parsed.get('error')
        message = (error.get('message') if isinstance(error, dict) else error) or parsed.get('message') or ''
    if not message:
        message = raw.decode('utf-8', 'replace')[:300].strip() or '无响应内容'
    return {'ok': False, 'cap': cap, 'status': status, 'ms': ms,
            'headline': 'HTTP %s · %s' % (status, message[:180]), 'lines': [message], 'preview': ''}


def _text_of(message):
    content = message.get('content')
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return ''.join(str(part.get('text') or '') for part in content if isinstance(part, dict))
    return ''


def _chat(target, payload, cap):
    status, raw, ms = _request(target['urls']['chat'], target['secret'], payload)
    if status != 200:
        return _err(status, raw, ms, cap)
    data = _json(raw) or {}
    choice = (data.get('choices') or [{}])[0]
    message = choice.get('message') or {}
    text = _text_of(message)
    reasoning = message.get('reasoning_content') or ''
    title = message.get('title') or data.get('title') or ''
    lines = ['finish_reason = %s' % choice.get('finish_reason')]
    if reasoning:
        lines.append('思维链 %d 字' % len(reasoning))
    usage = data.get('usage') or {}
    if usage:
        lines.append('tokens = %s' % usage.get('total_tokens'))
    headline = (title or text or reasoning or '（空响应）').replace('\n', ' ')[:180]
    return {'ok': True, 'cap': cap, 'status': status, 'ms': ms, 'headline': headline,
            'lines': lines, 'preview': text or reasoning,
            'reasoning': reasoning[:2000], 'title': title}


def run(body, data, home):
    cap = str(body.get('cap') or '')
    if cap == 'matrix':
        rows = []
        catalog = entries(data)
        for identifier, entry in catalog.items():
            fields = provider_fields(entry[2], entry[0])
            rows.append({'id': identifier, 'name': str(entry[2].get('name') or identifier),
                         'base_url': str(fields.get('base_url') or ''), 'enabled': enabled(entry[2])})
        return {'ok': True, 'cap': 'matrix',
                'caps': [{'id': c[0], 'label': c[1], 'desc': c[2], 'needs': c[3]} for c in CAPS],
                'providers': rows,
                'defaults': {'prompt': DEFAULT_PROMPT, 'query': SEARCH_QUERY,
                             'url': FETCH_URL, 'text': TTS_TEXT}}
    provider_id = str(body.get('provider') or '').strip()
    target = resolve_target(data, provider_id, home)
    urls, secret = target['urls'], target['secret']
    prompt = str(body.get('prompt') or DEFAULT_PROMPT)[:2000]
    model = str(body.get('model') or '').strip()

    if cap == 'models':
        status, raw, ms = _request(urls['models'], secret)
        if status != 200:
            return _err(status, raw, ms, cap)
        rows = (_json(raw) or {}).get('data') or []
        names = [str(row.get('id')) for row in rows if isinstance(row, dict) and row.get('id')]
        return {'ok': True, 'cap': cap, 'status': status, 'ms': ms,
                'headline': '发现 %d 个模型' % len(names), 'lines': names[:20], 'preview': ''}

    if cap in ('chat_basic', 'chat_thinking', 'chat_title', 'chat_safety', 'chat_search', 'chat_readurl', 'chat_reminder'):
        payload = {'model': model or 'deepseek-flash', 'messages': [{'role': 'user', 'content': prompt}]}
        if cap == 'chat_basic':
            payload['thinking'] = {'type': 'disabled'}
        elif cap == 'chat_thinking':
            payload['thinking'] = {'type': 'enabled'}
            effort = str(body.get('effort') or 'high')
            payload['reasoning_effort'] = effort if effort in ('low', 'high', 'max') else 'high'
        elif cap == 'chat_title':
            payload['thinking'] = {'type': 'disabled'}
            payload['title'] = {'enabled': True}
        elif cap == 'chat_safety':
            payload['thinking'] = {'type': 'disabled'}
            payload['safety_check'] = {'level': str(body.get('level') or 'high')}
        elif cap == 'chat_search':
            payload['thinking'] = {'type': 'disabled'}
            payload['tools'] = [{'type': 'deepseek_web_search'}]
        elif cap == 'chat_readurl':
            # 2026-11-15 实测：关思考时模型偶尔直接答"无法访问链接"，开思考后稳定调用工具
            payload['thinking'] = {'type': 'enabled'}
            payload['tools'] = [{'type': 'deepseek_read_url'}]
            url = str(body.get('url') or FETCH_URL)[:500]
            payload['messages'] = [{'role': 'user', 'content': '读一下这个链接并概括三句：' + url}]
        elif cap == 'chat_reminder':
            payload['thinking'] = {'type': 'disabled'}
            payload['messages'] = [
                {'role': 'latest_reminder', 'content': str(body.get('reminder') or '2026-11-15,星期日,北京,Web,中文')},
                {'role': 'user', 'content': prompt},
            ]
        return _chat(target, payload, cap)

    if cap == 'chat_file':
        blob = body.get('file_b64') or ''
        if not blob:
            return {'ok': False, 'cap': cap, 'status': 0, 'ms': 0, 'headline': '需要先选一个文件', 'lines': [], 'preview': ''}
        content = base64.b64decode(blob)
        if len(content) > 4 * 1024 * 1024:
            return {'ok': False, 'cap': cap, 'status': 0, 'ms': 0, 'headline': '文件超过 4MB，先压缩再试', 'lines': [], 'preview': ''}
        purpose = str(body.get('purpose') or 'text_recognition')
        raw, ctype = _multipart([('purpose', purpose)], [('file', str(body.get('filename') or 'upload.png'), content)])
        status, resp, ms = _request(urls['files'], secret, raw=raw, ctype=ctype, timeout=120)
        if status != 200:
            return _err(status, resp, ms, cap)
        info = _json(resp) or {}
        file_id = info.get('id')
        if not file_id:
            return _err(status, resp, ms, cap)
        payload = {'model': model or 'deepseek-flash', 'thinking': {'type': 'disabled'},
                   'messages': [{'role': 'user', 'content': [
                       {'type': 'file', 'file_id': file_id},
                       {'type': 'text', 'text': prompt}]}]}
        result = _chat(target, payload, cap)
        if result.get('ok'):
            result['lines'].insert(0, 'file_id = %s · %s 字节' % (file_id, info.get('bytes')))
        return result

    if cap in ('tool_search', 'tool_fetch'):
        if cap == 'tool_search':
            payload = {'query': str(body.get('query') or SEARCH_QUERY)[:300]}
            payload['count'] = min(int(body.get('count') or 3), 10)
            if str(body.get('ori_question') or '').strip():
                payload['ori_question'] = str(body['ori_question'])[:300]
        else:
            payload = {'url': str(body.get('url') or FETCH_URL)[:500]}
        status, raw, ms = _request(urls['tool']('search' if cap == 'tool_search' else 'fetch'), secret, payload, timeout=30)
        if status != 200:
            return _err(status, raw, ms, cap)
        info = _json(raw) or {}
        lines, preview = [], ''
        if cap == 'tool_search':
            results = info.get('results') or info.get('search_results') or []
            lines = ['%s. %s' % (index + 1, str(row.get('title') or '')[:80]) + ' · ' + str(row.get('url') or '')[:80]
                     for index, row in enumerate(results[:10]) if isinstance(row, dict)]
            first = results[0] if results and isinstance(results[0], dict) else {}
            preview = str(first.get('content') or first.get('snippet') or '')[:1500]
            headline = '命中 %d 条搜索结果' % len(results)
        else:
            lines = ['title = %s' % str(info.get('title') or '')[:80],
                     'content = %d 字符 · %s' % (len(str(info.get('content') or '')), info.get('type') or '')]
            preview = str(info.get('content') or '')[:1500]
            headline = str(info.get('title') or info.get('url') or '已抓取')[:180]
        return {'ok': True, 'cap': cap, 'status': status, 'ms': ms, 'headline': headline, 'lines': lines, 'preview': preview}

    if cap in ('tool_ocr', 'tool_asr'):
        blob = body.get('file_b64') or ''
        if not blob:
            return {'ok': False, 'cap': cap, 'status': 0, 'ms': 0,
                    'headline': '先选一个%s文件' % ('图片' if cap == 'tool_ocr' else '音频'), 'lines': [], 'preview': ''}
        content = base64.b64decode(blob)
        if len(content) > 4 * 1024 * 1024:
            return {'ok': False, 'cap': cap, 'status': 0, 'ms': 0, 'headline': '文件超过 4MB', 'lines': [], 'preview': ''}
        purpose = str(body.get('purpose') or ('text_recognition' if cap == 'tool_ocr' else 'asr'))
        raw, ctype = _multipart([('purpose', purpose)], [('file', str(body.get('filename') or 'upload.bin'), content)])
        status, resp, ms = _request(urls['tool']('ocr' if cap == 'tool_ocr' else 'asr'), secret, raw=raw, ctype=ctype, timeout=60)
        if status != 200:
            return _err(status, resp, ms, cap)
        info = _json(resp) or {}
        if cap == 'tool_ocr':
            pages = info.get('pages') or []
            texts = [str(page.get('text') or '') for page in pages if isinstance(page, dict)]
            usage = info.get('usage') or {}
            lines = ['page_count = %s · tokens = %s' % (info.get('page_count'), usage.get('total_tokens'))]
            return {'ok': True, 'cap': cap, 'status': status, 'ms': ms,
                    'headline': '识别 %d 页' % len(pages), 'lines': lines,
                    'preview': '\n'.join(texts)[:3000]}
        text = str(info.get('text') or info.get('transcript') or '')
        return {'ok': True, 'cap': cap, 'status': status, 'ms': ms,
                'headline': text[:180] or '（无转写结果）', 'lines': ['duration = %s' % info.get('duration', '?')],
                'preview': text}

    if cap == 'tool_tts':
        text = str(body.get('text') or TTS_TEXT)[:600]
        voice = str(body.get('voice') or 'stella')
        if voice not in ('stella', 'tide'):
            raise ConfigError('音色只有 stella（女声）和 tide（男声）', 400)
        payload = {'text': text, 'voice_id': voice, 'format': 'wav'}
        status, resp, ms = _request(urls['tool']('tts'), secret, payload, timeout=60)
        if status != 200:
            return _err(status, resp, ms, cap)
        if len(resp) > 3 * 1024 * 1024:
            return {'ok': False, 'cap': cap, 'status': status, 'ms': ms,
                    'headline': '音频过大（%d 字节）' % len(resp), 'lines': [], 'preview': ''}
        return {'ok': True, 'cap': cap, 'status': status, 'ms': ms,
                'headline': '合成 %d 字节音频' % len(resp),
                'lines': ['文本 %d 字' % len(text)], 'preview': '',
                'audio': base64.b64encode(resp).decode(), 'audio_mime': 'audio/wav'}

    raise ConfigError('未知的能力：%s' % cap, 400)
