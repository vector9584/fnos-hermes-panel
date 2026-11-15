"""Read-only views and narrow writes for the model page's remaining domains.

The model page used to stop at providers and routes. Everything below is read
from the same config.yaml the kernel reads — nothing here invents a setting. A
domain the kernel has no independent switch for (OCR, image generation) is
reported as following the provider instead of getting a decorative control that
would silently do nothing.
"""
import json
import re
from pathlib import Path

from panel_config_txn import ConfigError, commit, load_yaml, plain, read_file
from panel_model_catalog import credential_fields, entries

ENV_NAME = re.compile(r'[A-Za-z_][A-Za-z0-9_]*\Z')

# The capability domains the model page presents. Everything here has a real
# read/write path in this file. Speech (STT/TTS), vision and the inbound API are
# NOT duplicated here — they already have full editors behind
# /api/panel-models/voice and /api/panel-models/auxiliary, and a second write
# path would let the two disagree.
# field  : dotted path actually written back into config.yaml
# options: what the kernel accepts for that field
# write  : False marks a domain with no independent backend of its own
DOMAINS = (
    ('web_search', '联网搜索', 'web.search_backend', ('', 'tavily', 'brave', 'searxng', 'deepseek', 'exa'), True),
    ('web_extract', '网页提取', 'web.extract_backend', ('', 'tavily', 'exa', 'deepseek', 'firecrawl'), True),
    ('browser', '浏览器', 'browser.engine', ('auto', 'chromium', 'camofox'), True),
    ('ocr', '文字识别', '', (), False),
    ('image_gen', '图像生成', '', (), False),
)

STT_MODELS = {'local': ('model',), 'openai': ('model',), 'mistral': ('model',), 'elevenlabs': ('model_id',)}


def env_file(path):
    """Parse the .env sitting next to config.yaml. Values never leave this module."""
    target = Path(path).parent / '.env'
    result = {}
    if not target.is_file():
        return result
    try:
        text = target.read_text(encoding='utf-8', errors='replace')
    except Exception:
        return result
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, _, value = line.partition('=')
        key = key.strip()
        if key.startswith('export '):
            key = key[7:].strip()
        if not ENV_NAME.fullmatch(key):
            continue
        result[key] = value.strip().strip('"').strip("'")
    return result


def hint(value):
    if not value:
        return ''
    if value.startswith('${'):
        return '引用变量'
    if len(value) <= 8:
        return '已设置'
    return '****' + value[-4:]


def keys_view(data, path):
    """Every credential variable the loaded config actually refers to."""
    env = env_file(path)
    rows = {}

    def note(name, who, inline=''):
        name = (name or '').strip()
        if not name or not ENV_NAME.fullmatch(name):
            return
        row = rows.setdefault(name, {'name': name, 'configured': False, 'source': 'missing',
                                     'hint': '', 'used_by': []})
        if who not in row['used_by']:
            row['used_by'].append(who)
        if name in env and env[name]:
            row['configured'] = True
            if row['source'] != 'inline':
                row['source'] = 'env'
            row['hint'] = hint(env[name])
        elif inline and not inline.startswith('${'):
            row['configured'] = True
            row['source'] = 'inline'
            row['hint'] = '配置内密钥'

    for key, (_origin, _idx, item) in entries(data).items():
        cred = credential_fields(item, _origin)
        inline = cred.get('api_key') or ''
        name = cred.get('key_env') or ''
        if not name and inline.startswith('${'):
            name = inline[2:-1].strip()
        elif not name and inline:
            name = ''
            rows.setdefault('inline:' + key, {'name': '（配置内明文）', 'configured': True,
                                              'source': 'inline', 'hint': '配置内密钥',
                                              'used_by': [key]})
        note(name, key, inline)

    auxiliary = data.get('auxiliary') if isinstance(data.get('auxiliary'), dict) else {}
    for task, item in auxiliary.items():
        if not isinstance(item, dict):
            continue
        cred = credential_fields(item, 'providers')
        inline = cred.get('api_key') or ''
        name = cred.get('key_env') or ''
        if not name and inline.startswith('${'):
            name = inline[2:-1].strip()
        note(name, 'auxiliary.' + task, inline)
        for entry in item.get('fallback_chain') or []:
            if isinstance(entry, dict):
                sub = credential_fields(entry, 'providers')
                note(sub.get('key_env'), 'auxiliary.' + task, sub.get('api_key') or '')

    for key, label, field, options, writable in DOMAINS:
        if not field:
            continue
        holder = data
        for part in field.split('.')[:-1]:
            holder = holder.get(part) if isinstance(holder, dict) else None
        if isinstance(holder, dict):
            cred = credential_fields(holder, 'providers')
            note(cred.get('key_env'), label)

    return {'ok': True, 'keys': sorted(rows.values(), key=lambda row: (row['source'] != 'env', row['name'])),
            'env_file': str(Path(path).parent / '.env'), 'env_count': len(env)}


def _dig(data, field):
    holder = data
    for part in field.split('.')[:-1]:
        holder = holder.get(part) if isinstance(holder, dict) else None
    if not isinstance(holder, dict):
        return None, None
    return holder, field.split('.')[-1]


def backends_view(data):
    tts = data.get('tts') if isinstance(data.get('tts'), dict) else {}
    tts_providers = tts.get('providers') if isinstance(tts.get('providers'), dict) else {}
    rows = []
    for key, label, field, options, writable in DOMAINS:
        holder, leaf = _dig(data, field) if field else (None, None)
        current = ''
        detail = {}
        if holder is not None:
            current = str(holder.get(leaf) or '')
            detail = {k: plain(v) for k, v in holder.items()
                      if k not in ('api_key', 'key_env', 'api_key_env', 'apiKey') and not isinstance(v, (dict, list))}
        if key == 'tts':
            options = tuple(sorted(set(tts_providers) | {'edge', 'openai', 'elevenlabs', 'windows-indextts'}))
        if key == 'vision':
            detail['model'] = str((data.get('auxiliary', {}).get('vision', {}) or {}).get('model') or '')
        rows.append({'key': key, 'label': label, 'provider': current, 'options': list(options),
                     'writable': writable, 'detail': detail,
                     'note': '' if writable else '跟随服务商原生能力，没有独立配置项'})
    return {'ok': True, 'domains': rows, 'revision': config_revision(data)}


def config_revision(data):
    from panel_config_txn import checksum, semantic
    return checksum(semantic(plain(data)).encode())


def toolsets_view(data, platform='api_server'):
    """Toolset truth is platform_toolsets.<platform>, not the legacy top-level key.

    The kernel resolves each platform through _get_platform_tools(); a missing or
    non-list entry falls back to the platform's composite default. Anything else
    shown as "on" would be a lie, so an unset platform reports following=True
    instead of pretending every toolset is individually enabled.
    """
    builtin = data.get('known_builtin_toolsets') if isinstance(data.get('known_builtin_toolsets'), dict) else {}
    plugin = data.get('known_plugin_toolsets') if isinstance(data.get('known_plugin_toolsets'), dict) else {}
    platform_map = data.get('platform_toolsets') if isinstance(data.get('platform_toolsets'), dict) else {}
    explicit = platform_map.get(platform)
    explicit = explicit if isinstance(explicit, list) else None
    candidates = []
    for source in (builtin.get('cli'), plugin.get('cli'), explicit, platform_map.get('cli')):
        for name in source or []:
            if isinstance(name, str) and name not in candidates:
                candidates.append(name)
    agent = data.get('agent') if isinstance(data.get('agent'), dict) else {}
    disabled = agent.get('disabled_toolsets') if isinstance(agent.get('disabled_toolsets'), list) else []
    enabled = set(explicit) if explicit is not None else set()
    security = data.get('security') if isinstance(data.get('security'), dict) else {}
    gateway = data.get('gateway') if isinstance(data.get('gateway'), dict) else {}
    return {'ok': True, 'revision': config_revision(data), 'platform': platform,
            'platforms': [name for name in ('api_server', 'cli', 'qqbot', 'weixin', 'telegram', 'discord')
                          if name in platform_map or name in ('api_server', 'cli')],
            'follow_default': explicit is None,
            'default_name': 'hermes-' + platform,
            'toolsets': [{'name': name, 'enabled': name in enabled,
                          'plugin': name in (plugin.get('cli') or []),
                          'disabled': name in disabled}
                         for name in candidates],
            'count_enabled': len(enabled), 'count_all': len(candidates),
            'disabled_toolsets': disabled,
            'gateway': {k: plain(v) for k, v in gateway.items()},
            'allow_private_urls': bool(security.get('allow_private_urls')),
            'redact_secrets': bool(security.get('redact_secrets', True))}


def preview_view(raw, data):
    """The file as it sits on disk, with secret values masked but names intact."""
    text = raw.decode('utf-8', 'replace')
    lines = []
    for line in text.splitlines():
        match = re.match(r'^(\s*)(api_key|apiKey):\s*(.+?)\s*$', line)
        if match and match.group(3) not in ("''", '""'):
            value = match.group(3).strip('\'"')
            line = '%s%s: %s' % (match.group(1), match.group(2),
                                 value if value.startswith('${') else "'****（已隐藏）'")
        lines.append(line)
    body = '\n'.join(lines)
    return {'ok': True, 'text': body, 'lines': len(lines),
            'bytes': len(raw), 'revision': config_revision(data),
            'path': '', 'masked': True}


def audit_view(state):
    directory = Path(state) / 'config-history'
    rows = []
    if directory.is_dir():
        for item in sorted(directory.glob('*.yaml'), reverse=True)[:60]:
            try:
                stat = item.stat()
            except OSError:
                continue
            rows.append({'id': item.stem, 'bytes': stat.st_size,
                         'at': int(stat.st_mtime), 'name': item.name})
    return {'ok': True, 'snapshots': rows, 'directory': str(directory)}


def _scalar(value, label, limit=200):
    if not isinstance(value, str) or len(value) > limit or '\n' in value or '\r' in value:
        raise ConfigError('%s格式不正确' % label)
    return value.strip()


def save_backend(data, body):
    domain = body.get('domain')
    match = next((row for row in DOMAINS if row[0] == domain), None)
    if not match:
        raise ConfigError('没有这个能力后端')
    key, label, field, options, writable = match
    if not writable:
        raise ConfigError('%s跟随服务商原生能力，没有可写的配置项' % label)
    value = _scalar(body.get('provider'), label, 120)
    if options and value not in options:
        raise ConfigError('%s不支持这个来源' % label)
    updated = json.loads(json.dumps(plain(data)))
    holder = updated
    parts = field.split('.')
    for part in parts[:-1]:
        if not isinstance(holder.get(part), dict):
            holder[part] = {}
        holder = holder[part]
    if value:
        holder[parts[-1]] = value
    else:
        holder.pop(parts[-1], None)
    if key == 'stt' and value:
        stt = updated.setdefault('stt', {})
        if not isinstance(stt.get(value), dict):
            stt[value] = {}
    return updated


def save_toolsets(data, body):
    updated = json.loads(json.dumps(plain(data)))
    platform = body.get('platform') or 'api_server'
    if not isinstance(platform, str) or not re.fullmatch(r'[a-z_]{2,40}', platform):
        raise ConfigError('平台名称不正确')
    if body.get('follow_default'):
        # Deleting the key is what "follow the platform default" means to the
        # kernel; writing the default's expansion back would freeze it.
        platform_map = updated.get('platform_toolsets')
        if isinstance(platform_map, dict):
            platform_map.pop(platform, None)
    elif body.get('enabled') is not None:
        enabled = body['enabled']
        if not isinstance(enabled, list) or any(not isinstance(name, str) for name in enabled):
            raise ConfigError('工具集清单格式不正确')
        if len(enabled) > 200:
            raise ConfigError('工具集最多 200 项')
        known = {row['name'] for row in toolsets_view(data, platform)['toolsets']}
        unknown = [name for name in enabled if name not in known]
        if unknown:
            raise ConfigError('未知工具集：' + '、'.join(unknown[:5]))
        platform_map = updated.get('platform_toolsets')
        if not isinstance(platform_map, dict):
            platform_map = updated['platform_toolsets'] = {}
        # 保持原有顺序：先按当前顺序保留仍在清单里的，再把新增的追加到末尾。
        # 用 sorted() 重排会让「关掉一个再打开」产生顺序漂移，配置字节和原来对不上，
        # 用户对着 git diff 会以为改了很多东西。
        current = platform_map.get(platform)
        current = current if isinstance(current, list) else []
        keep = set(enabled)
        ordered = [name for name in current if name in keep]
        for name in sorted(keep - set(current)):
            ordered.append(name)
        platform_map[platform] = ordered
    if 'allow_private_urls' in body:
        flag = body['allow_private_urls']
        if type(flag) is not bool:
            raise ConfigError('私网地址开关不正确')
        security = updated.get('security')
        if not isinstance(security, dict):
            security = updated['security'] = {}
        if flag:
            security['allow_private_urls'] = True
        else:
            security.pop('allow_private_urls', None)
    return updated


def execute(body, path, state, raw=None):
    """Serve both read and write extras. `raw` is the config file bytes."""
    action = body.get('action')
    path = Path(path)
    if raw is None:
        raw, _stat = read_file(path)
    yaml, data = load_yaml(raw)
    if action == 'keys':
        return keys_view(data, path)
    if action == 'backends':
        return backends_view(data)
    if action == 'toolsets':
        return toolsets_view(data, body.get('platform') or 'api_server')
    if action == 'config_preview':
        return preview_view(raw, data)
    if action == 'audit':
        return audit_view(state)

    from panel_config_txn import config_lock, semantic
    if body.get('revision') != config_revision(data):
        raise ConfigError('配置已被其他页面修改，请重新读取', 409)
    if action == 'save_backend':
        updated = save_backend(data, body)
        reason = '能力后端：' + str(body.get('domain'))
    elif action == 'save_toolsets':
        updated = save_toolsets(data, body)
        reason = '工具集与安全边界'
    else:
        raise ConfigError('未知动作')
    if semantic(updated) == semantic(data):
        return {'ok': True, 'changed': False, 'revision': config_revision(data)}
    import io as _io
    output = _io.StringIO()
    yaml.dump(updated, output)
    encoded = output.getvalue().encode()
    _, verified = load_yaml(encoded)
    if semantic(verified) != semantic(updated):
        raise ConfigError('配置序列化不一致，原文件已保留', 503)
    with config_lock(state):
        result = commit(path, state, raw, encoded, reason)
    return {**result, 'ok': True, 'changed': True, 'revision': config_revision(updated),
            'reload_required': True}
