"""Read and edit the voice stack (TTS 提供方 / STT 提供方) with round-trip YAML,
an optimistic revision and an atomic, backup-first write. Also reports whether
the optional JEV judgment plugin is present, read-only.

The section names mirror the official Hermes settings: 通用模型 / 模型 API /
辅助模型 / 组合模型 / JEV / STT 提供方 / TTS 提供方.
"""
import copy
import hashlib
import io
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from panel_config_txn import config_lock
from ruamel.yaml import YAML
from ruamel.yaml.comments import CommentedMap

TTS_KNOWN = [
    ('windows-indextts', 'Windows IndexTTS（本机声纹克隆）'),
    ('edge', 'Edge TTS（微软在线音色）'),
    ('openai', 'OpenAI'),
    ('elevenlabs', 'ElevenLabs'),
    ('minimax', 'MiniMax'),
    ('xai', 'xAI'),
    ('mistral', 'Mistral'),
    ('gemini', 'Gemini'),
    ('neutts', 'NeuTTS（本地）'),
    ('kittentts', 'KittenTTS（本地）'),
    ('piper', 'Piper（本地）'),
]
STT_KNOWN = [
    ('local', '本地 Whisper（离线）'),
    ('auto', '自动选择'),
    ('groq', 'Groq'),
    ('openai', 'OpenAI'),
    ('mistral', 'Mistral'),
    ('elevenlabs', 'ElevenLabs'),
    ('xai', 'xAI'),
    ('local-cli', '本地命令行'),
]
TTS_FIELDS = ('command', 'output_format', 'timeout', 'max_text_length', 'voice')
FORMATS = ('mp3', 'wav', 'opus', 'flac', 'ogg', 'aac', 'pcm')
STT_PARAMS = {
    'local': ('model', 'language', 'initial_prompt'),
    'openai': ('model',),
    'mistral': ('model',),
    'groq': ('model',),
    'xai': ('model',),
    'elevenlabs': ('model_id', 'language_code', 'tag_audio_events', 'diarize'),
}
JEV_KEYS = ('TYPESAFE_API_KEY', 'CLOUDFLARE_JEV_API_TOKEN')


class Failure(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def plain(value):
    if isinstance(value, dict):
        return {str(k): plain(v) for k, v in value.items()}
    if isinstance(value, list):
        return [plain(v) for v in value]
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def revision(tts, stt):
    payload = json.dumps({'tts': plain(tts), 'stt': plain(stt)}, ensure_ascii=False,
                         sort_keys=True, separators=(',', ':'))
    return hashlib.sha256(payload.encode()).hexdigest()


def text(value, label, limit=500, empty=False):
    if not isinstance(value, str):
        raise Failure(label + '必须是文本')
    out = value.strip()
    if not out and not empty:
        raise Failure(label + '不能为空')
    if len(out) > limit:
        raise Failure(label + '超过 ' + str(limit) + ' 个字符')
    return out


def whole(value, label, low, high):
    if type(value) is not int or value < low or value > high:
        raise Failure(label + '必须是 ' + str(low) + '–' + str(high) + ' 之间的整数')
    return value


def document(path):
    if not path.is_file() or path.is_symlink():
        raise Failure('模型配置文件不存在或使用了符号链接', 503)
    raw = path.read_bytes()
    yaml = YAML(typ='rt')
    yaml.preserve_quotes = True
    yaml.allow_duplicate_keys = False
    yaml.width = 4096
    try:
        data = yaml.load(raw.decode())
    except Exception:
        raise Failure('模型配置无法解析，原文件已保留', 503)
    if not isinstance(data, dict):
        raise Failure('模型配置结构不完整，原文件已保留', 503)
    return raw, yaml, data


def env_keys(home):
    seen = {}
    for name in ('.env',):
        path = home / name
        if not path.is_file():
            continue
        try:
            for line in path.read_text(encoding='utf-8', errors='replace').splitlines():
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                key, value = line.split('=', 1)
                seen[key.strip()] = bool(value.strip())
        except Exception:
            continue
    return seen


def jev_status(home, data):
    roots = [home / 'plugins', home.parent / 'plugins', home / 'skills' / 'plugins']
    found = None
    for root in roots:
        candidate = root / 'jev'
        if candidate.is_dir():
            found = str(candidate)
            break
    keys = env_keys(home)
    credentials = {name: bool(keys.get(name)) for name in JEV_KEYS}
    enabled = False
    plugins = data.get('plugins')
    if isinstance(plugins, dict):
        entry = plugins.get('jev')
        enabled = bool(entry.get('enabled', True)) if isinstance(entry, dict) else bool(entry)
    elif isinstance(plugins, list):
        enabled = 'jev' in [str(item) for item in plugins]
    return {
        'installed': bool(found),
        'path': found,
        'credentials': credentials,
        'ready': bool(found) and any(credentials.values()),
        'config_enabled': enabled,
        'backends': [['typesafe', 'TypeSafe（TYPESAFE_API_KEY）'],
                     ['cloudflare', 'Cloudflare Workers AI（CLOUDFLARE_JEV_API_TOKEN）']],
        'doc': 'https://hermes-agent.nousresearch.com/docs/zh-Hans/plugins/jev',
        'note': 'JEV 是有界的判断插件，用外部判定后端回答「这句是否合规/该不该拦」这类问题；'
                '它不是对话模型，装上也顶替不了主模型。没有密钥就只能保持未启用。',
    }


def _lan_ip():
    """Pick the address a phone on the LAN would actually use.

    The UDP-connect trick answers with Clash TUN's 198.18.x fake-ip on this
    host, so read real interface addresses and skip tunnels / docker bridges.
    """
    try:
        out = subprocess.run(['ip', '-4', '-o', 'addr', 'show', 'scope', 'global'],
                             capture_output=True, text=True, timeout=3).stdout
    except Exception:
        out = ''
    candidates = []
    for line in out.splitlines():
        parts = line.split()
        if len(parts) < 4:
            continue
        iface, addr = parts[1], parts[3].split('/')[0]
        if iface.startswith(('docker', 'br-', 'veth', 'virbr', 'tun', 'tap', 'clash', 'wg')):
            continue
        if addr.startswith(('198.18.', '198.19.', '127.', '169.254.', '100.64.')):
            continue
        candidates.append((0 if addr.startswith('192.168.') else 1, addr))
    if candidates:
        return sorted(candidates)[0][1]
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe.settimeout(1.0)
        probe.connect(('223.5.5.5', 53))
        ip = probe.getsockname()[0]
        probe.close()
        return ip
    except Exception:
        return '127.0.0.1'


def gateway_api(home, data):
    """Probe the built-in OpenAI-compatible endpoint (gateway api_server).

    The panel never invents a key: it reports whether API_SERVER_KEY is
    registered in .env and what the endpoint answers without one.
    """
    port = 8742
    gw = data.get('gateway') if isinstance(data.get('gateway'), dict) else {}
    for key in ('api_port', 'port'):
        value = gw.get(key)
        if isinstance(value, int) and 0 < value < 65536:
            port = value
            break
    root = 'http://127.0.0.1:%d' % port
    status = None
    models = []
    error = ''
    try:
        with urllib.request.urlopen(root + '/v1/models', timeout=4) as resp:
            status = resp.status
            body = resp.read(65536)
        try:
            parsed = json.loads(body.decode('utf-8', 'replace'))
            for item in parsed.get('data') or []:
                if isinstance(item, dict) and item.get('id'):
                    models.append(str(item['id']))
        except Exception:
            pass
    except urllib.error.HTTPError as exc:
        status = exc.code
        try:
            error = json.loads(exc.read(4096).decode('utf-8', 'replace')).get('error', {}).get('message', '')
        except Exception:
            error = ''
    except Exception as exc:
        error = type(exc).__name__
    keys = env_keys(home)
    return {
        'port': port,
        'reachable': status is not None,
        'status': status,
        'needs_key': status == 401,
        'key_configured': bool(keys.get('API_SERVER_KEY')),
        'base_url': 'http://%s:%d/v1' % (_lan_ip(), port),
        'local_url': root + '/v1',
        'models': models,
        'error': error,
        'endpoints': [
            ['GET', '/v1/models', '列出这个网关对外宣称的模型名'],
            ['POST', '/v1/chat/completions', 'OpenAI Chat Completions（无状态，可用 X-Hermes-Session-Id 续会话）'],
            ['POST', '/v1/responses', 'OpenAI Responses（有状态，靠 previous_response_id 接续）'],
            ['GET', '/v1/responses/{id}', '取回一条已存响应'],
        ],
        'note': '这是本机 Hermes 网关自己对外提供的 OpenAI 兼容接口，跟上面「服务商地址」相反：'
                '那边是我们去调别人的模型，这里是把本机 agent 当模型给别的程序调。'
                '密钥由 API_SERVER_KEY 决定；面板只报状态，不回显、不代填。',
    }


def tts_view(data):
    section = data.get('tts') if isinstance(data.get('tts'), dict) else {}
    providers = section.get('providers') if isinstance(section.get('providers'), dict) else {}
    rows = []
    for name, entry in providers.items():
        if not isinstance(entry, dict):
            continue
        rows.append({
            'name': str(name),
            'type': plain(entry.get('type')) or 'command',
            **{key: plain(entry[key]) for key in TTS_FIELDS if key in entry},
        })
    return {
        'provider': plain(section.get('provider')) or '',
        'providers': rows,
        'edge_voice': plain((section.get('edge') or {}).get('voice')) if isinstance(section.get('edge'), dict) else '',
        'options': [list(pair) for pair in TTS_KNOWN],
        'formats': list(FORMATS),
    }


def stt_view(data):
    section = data.get('stt') if isinstance(data.get('stt'), dict) else {}
    params = {}
    for name, fields in STT_PARAMS.items():
        entry = section.get(name)
        if isinstance(entry, dict):
            params[name] = {key: plain(entry[key]) for key in fields if key in entry}
    return {
        'enabled': bool(section.get('enabled', False)),
        'provider': plain(section.get('provider')) or '',
        'language': plain(section.get('language')) or '',
        'params': params,
        'options': [list(pair) for pair in STT_KNOWN],
    }


def response(data, home):
    tts = tts_view(data)
    stt = stt_view(data)
    return {
        'ok': True,
        'revision': revision(data.get('tts'), data.get('stt')),
        'tts': tts,
        'stt': stt,
        'jev': jev_status(home, data),
        'openai_api': gateway_api(home, data),
        'openai_responses_note': 'OpenAI Responses API（服务协议里叫 Responses / codex_responses）'
                                 '只影响「这家服务用哪个接口说话」，跟 STT/TTS 无关；'
                                 '没有只支持 Responses 的服务就保持「由内核识别」即可。',
    }


def patch_tts(section, changes):
    if not isinstance(changes, dict):
        raise Failure('修改字段格式不正确')
    unknown = set(changes) - {'provider', 'providers', 'remove_provider', 'edge_voice'}
    if unknown:
        raise Failure('TTS 修改包含不支持的字段：' + '、'.join(sorted(unknown)))
    providers = section.get('providers')
    if not isinstance(providers, CommentedMap):
        providers = CommentedMap()
        section['providers'] = providers
    for name, entry in (changes.get('providers') or {}).items():
        if not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,30}', str(name)):
            raise Failure('自定义提供方名称只能用小写字母、数字、下划线或短横线')
        if not isinstance(entry, dict):
            raise Failure('自定义提供方配置格式不正确')
        target = providers.get(name)
        if not isinstance(target, dict):
            target = CommentedMap()
            target['type'] = 'command'
            providers[name] = target
        if str(target.get('type') or 'command') != 'command':
            raise Failure('只有 command 类型的提供方能在面板里编辑')
        if 'command' in entry:
            target['command'] = text(entry['command'], '合成命令', 2000)
        if 'output_format' in entry:
            fmt = text(entry['output_format'], '输出格式', 16).lower()
            if fmt not in FORMATS:
                raise Failure('输出格式必须是 ' + '、'.join(FORMATS))
            target['output_format'] = fmt
        if 'timeout' in entry:
            target['timeout'] = whole(entry['timeout'], '超时秒数', 5, 1800)
        if 'max_text_length' in entry:
            target['max_text_length'] = whole(entry['max_text_length'], '单次文本上限', 50, 20000)
        if 'voice' in entry:
            target['voice'] = text(entry['voice'], '音色', 120, empty=True)
    removed = changes.get('remove_provider')
    if removed:
        name = text(removed, '要删除的提供方', 40)
        if name not in providers:
            raise Failure('没有这个自定义提供方')
        if section.get('provider') == name:
            raise Failure('正在使用的提供方不能删除，请先切换 TTS 提供方')
        providers.pop(name)
    if 'provider' in changes:
        name = text(changes['provider'], 'TTS 提供方', 80)
        known = {key for key, _ in TTS_KNOWN} | {str(k) for k in providers}
        if name not in known:
            raise Failure('没有这个 TTS 提供方：' + name)
        section['provider'] = name
    if 'edge_voice' in changes:
        edge = section.get('edge')
        if not isinstance(edge, dict):
            edge = CommentedMap()
            section['edge'] = edge
        edge['voice'] = text(changes['edge_voice'], 'Edge 音色', 120, empty=True)


def patch_stt(section, changes):
    if not isinstance(changes, dict):
        raise Failure('修改字段格式不正确')
    unknown = set(changes) - {'enabled', 'provider', 'language', 'params'}
    if unknown:
        raise Failure('STT 修改包含不支持的字段：' + '、'.join(sorted(unknown)))
    if 'enabled' in changes:
        if not isinstance(changes['enabled'], bool):
            raise Failure('启用开关必须是布尔值')
        section['enabled'] = changes['enabled']
    if 'provider' in changes:
        name = text(changes['provider'], 'STT 提供方', 40)
        if name not in {key for key, _ in STT_KNOWN}:
            raise Failure('没有这个 STT 提供方：' + name)
        section['provider'] = name
    if 'language' in changes:
        section['language'] = text(changes['language'], '识别语言', 20, empty=True)
    params = changes.get('params') or {}
    if not isinstance(params, dict):
        raise Failure('提供方参数格式不正确')
    for name, fields in params.items():
        allowed = STT_PARAMS.get(str(name))
        if not allowed:
            raise Failure('这个提供方没有可编辑参数：' + str(name))
        if not isinstance(fields, dict):
            raise Failure('提供方参数格式不正确')
        entry = section.get(name)
        if not isinstance(entry, dict):
            entry = CommentedMap()
            section[name] = entry
        for key, value in fields.items():
            if key not in allowed:
                raise Failure('参数 ' + str(key) + ' 不属于 ' + str(name))
            if isinstance(value, bool):
                entry[key] = value
            elif key == 'language_code':
                entry[key] = text(value, '语言代码', 20, empty=True)
            else:
                entry[key] = text(value, '参数 ' + key, 400, empty=True)


def execute(request, path, lock_root=None):
    home = path.parent
    lock_dir = Path(lock_root) if lock_root else (home / 'panel-state')
    raw, yaml, data = document(path)
    if request.get('action') == 'read':
        return response(data, home)
    section = request.get('section')
    if section not in ('tts', 'stt'):
        raise Failure('只能修改 TTS 或 STT 配置')
    if request.get('revision') != revision(data.get('tts'), data.get('stt')):
        raise Failure('语音配置已在其他页面修改，请重新读取后再保存', 409)
    with config_lock(lock_dir):
        raw, yaml, data = document(path)
        if request.get('revision') != revision(data.get('tts'), data.get('stt')):
            raise Failure('语音配置刚被其他进程修改，请重新读取后再保存', 409)
        original = copy.deepcopy(plain(data))
        target = data.get(section)
        if target is None:
            target = CommentedMap()
            data[section] = target
        if not isinstance(target, dict):
            raise Failure('语音配置结构不正确，原文件已保留', 503)
        if section == 'tts':
            patch_tts(target, request.get('changes'))
        else:
            patch_stt(target, request.get('changes'))
        expected = copy.deepcopy(original)
        expected[section] = plain(data.get(section))
        output = io.StringIO()
        yaml.dump(data, output)
        encoded = output.getvalue().encode()
        if plain(yaml.load(encoded.decode())) != expected:
            raise Failure('配置包含共享引用，无法独立修改语音设置，原文件未改写', 409)
        if plain(data) == original:
            return response(data, home)
        root = lock_dir / 'voice-backups'
        root.mkdir(parents=True, exist_ok=True)
        stamp = root / ('voice-' + str(time.time_ns()) + '-' + hashlib.sha256(raw).hexdigest()[:12] + '.yaml')
        with stamp.open('xb') as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        fd, temp = tempfile.mkstemp(prefix='.voice-', dir=path.parent)
        try:
            with os.fdopen(fd, 'wb') as stream:
                os.fchmod(stream.fileno(), path.stat().st_mode & 0o777)
                stream.write(encoded)
                stream.flush()
                os.fsync(stream.fileno())
            if path.read_bytes() != raw:
                raise Failure('语音配置刚被其他进程修改，请重试', 409)
            os.replace(temp, path)
            directory = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            if os.path.exists(temp):
                os.unlink(temp)
    result = response(data, home)
    result['changed'] = True
    return result


if __name__ == '__main__':
    try:
        print(json.dumps(execute(json.load(sys.stdin), Path(sys.argv[1]), sys.argv[2] if len(sys.argv) > 2 else None), ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'ok': False,
                          'error': str(error) if isinstance(error, Failure) else '语音配置保存失败，未收到成功确认，请重新读取核对',
                          'status': getattr(error, 'status', 500)}, ensure_ascii=False))
        sys.exit(1)
