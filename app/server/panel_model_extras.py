"""Read-only views and narrow writes for the model page's remaining domains.

The model page used to stop at providers and routes. Everything below is read
from the same config.yaml the kernel reads — nothing here invents a setting. A
domain the kernel really has no independent switch for is reported as following
the provider instead of getting a decorative control that would silently do
nothing.

注意：图像生成**不属于**这一类。内核的 agent/image_gen_registry.py 明确读
`image_gen.provider`，所以它在本文件里有真实的读写路径（下面 DOMAINS 那行）。
之前把它写成「跟随服务商」是误判，已纠正。
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
# 参考稿的能力后端页有 8 张卡（语音转写/语音合成/网页搜索/网页提取/视觉理解/文字识别/图像生成/浏览器）。
# 语音与视觉确实有独立后端，但它们的写入口已经在 /api/panel-models/voice 和
# /api/panel-models/auxiliary 上；这里只做投影（write_via 指路），不再开第二条写路径，
# 否则两处会互相覆盖。write_via='config' 的才由 save_backend 写回 config.yaml。
# field  : dotted path 只用于读现值
# options: 内核接受的取值
# write  : False 表示没有独立后端配置项
# write_via: 'config' | 'voice' | 'auxiliary'
DOMAINS = (
    ('stt', '语音转写', 'stt.provider', ('', 'local', 'openai', 'mistral', 'elevenlabs'), True, 'voice'),
    ('tts', '语音合成', 'tts.provider', ('', 'windows-indextts', 'edge', 'openai', 'elevenlabs'), True, 'voice'),
    ('web_search', '联网搜索', 'web.search_backend', ('', 'tavily', 'brave', 'searxng', 'deepseek', 'exa'), True, 'config'),
    ('web_extract', '网页提取', 'web.extract_backend', ('', 'tavily', 'exa', 'deepseek', 'firecrawl'), True, 'config'),
    ('vision', '视觉理解', 'auxiliary.vision.provider', ('',), True, 'auxiliary'),
    ('ocr', '文字识别', 'ocr.provider', ('', 'baimiao', 'deepseek'), True, 'config'),
    # 生图内核确有独立开关：agent/image_gen_registry.py 的 get_active_provider()
    # 明确读 config.yaml 的 image_gen.provider。之前这行标 False/'none' 是误判
    # （写成「跟随服务商原生能力」），导致面板只显示一张红卡、没法配。
    ('image_gen', '图像生成', 'image_gen.provider',
     ('', 'custom', 'openai', 'fal', 'krea', 'deepinfra', 'openrouter', 'xai', 'openai-codex'), True, 'config'),
    ('browser', '浏览器', 'browser.engine', ('auto', 'chromium', 'camofox'), True, 'config'),
)

# 每个生图 provider 在 .env 里认的凭据名（openai-codex 走 Codex OAuth，无独立 key）。
# 只用于在面板上标「key 已配 / 未配」，绝不回传值。
IMAGE_GEN_KEYS = {
    'openai': 'OPENAI_API_KEY',
    'fal': 'FAL_KEY',
    'krea': 'KREA_API_KEY',
    'deepinfra': 'DEEPINFRA_API_KEY',
    'openrouter': 'OPENROUTER_API_KEY',
    'xai': 'XAI_API_KEY',
    'openai-codex': '',
    'custom': 'IMAGE_GEN_CUSTOM_API_KEY',
}

STT_MODELS = {'local': ('model',), 'openai': ('model',), 'mistral': ('model',), 'elevenlabs': ('model_id',)}


# 每张能力卡自己的凭据。变量名逐个在 hermes-src 里核过（web_search_provider.py /
# nous_subscription.py / dump.py / status.py），不靠猜：
#   openai OPENAI_API_KEY · mistral MISTRAL_API_KEY · elevenlabs ELEVENLABS_API_KEY
#   tavily TAVILY_API_KEY · brave BRAVE_SEARCH_API_KEY（不是 BRAVE_API_KEY）
#   searxng SEARXNG_URL · exa EXA_API_KEY · firecrawl FIRECRAWL_API_KEY
# 值为 () 表示这个来源不需要独立 key；'reuse' 表示没有独立凭据，直接用服务商页
# 配好的那条 —— 「复用」和「不用配」是两件事，混成一句用户就分不清了。
BACKEND_CREDS = {
    'stt': {'local': (), 'openai': (('OPENAI_API_KEY', 'OpenAI 密钥'),),
            'mistral': (('MISTRAL_API_KEY', 'Mistral 密钥'),),
            'elevenlabs': (('ELEVENLABS_API_KEY', 'ElevenLabs 密钥'),)},
    'tts': {'edge': (), 'windows-indextts': (), 'piper': (), 'openai': (('OPENAI_API_KEY', 'OpenAI 密钥'),),
            'mistral': (('MISTRAL_API_KEY', 'Mistral 密钥'),),
            'elevenlabs': (('ELEVENLABS_API_KEY', 'ElevenLabs 密钥'),)},
    'web_search': {'tavily': (('TAVILY_API_KEY', 'Tavily 密钥'),),
                   'brave': (('BRAVE_SEARCH_API_KEY', 'Brave 密钥'),),
                   'searxng': (('SEARXNG_URL', 'SearXNG 实例地址'),),
                   'exa': (('EXA_API_KEY', 'Exa 密钥'),),
                   'deepseek': 'reuse'},
    'web_extract': {'tavily': (('TAVILY_API_KEY', 'Tavily 密钥'),),
                    'exa': (('EXA_API_KEY', 'Exa 密钥'),),
                    'firecrawl': (('FIRECRAWL_API_KEY', 'Firecrawl 密钥'),),
                    'deepseek': 'reuse'},
    # 白描不是内核 OCR provider —— hermes-src 里 grep baimiao 是 0 命中。
    # 真干活的是 skills/productivity/baimiao-ocr/scripts/baimiao_ocr.py，
    # 它自己读 .env 的 BAIMIAO_USER / BAIMIAO_PASS。所以这张卡写 ocr.provider
    # 内核不会读，只有技能把它当参考。
    'ocr': {'baimiao': (('BAIMIAO_USER', '白描账号'), ('BAIMIAO_PASS', '白描密码')),
            'deepseek': 'reuse'},
    'browser': {'auto': (), 'chromium': (), 'camofox': ()},
}

# 内核真正读取的配置段。ocr 不在这里：config 里写 ocr.provider 也没有代码读它，
# 面板上照实标出来，免得用户以为选一下就能换识别引擎。
KERNEL_READS = {'stt': True, 'tts': True, 'web_search': True, 'web_extract': True,
                'vision': True, 'image_gen': True, 'browser': True, 'ocr': False}


def _image_gen_creds():
    """生图各来源的凭据，复用模块上方 IMAGE_GEN_KEYS 那张表，不另存一份。"""
    table = {}
    for name, env_name in IMAGE_GEN_KEYS.items():
        if name == 'custom':
            table[name] = 'reuse'
        elif not env_name:
            table[name] = ()
        else:
            table[name] = ((env_name, name + ' 密钥'),)
    return table


BACKEND_CREDS['image_gen'] = _image_gen_creds()


def _reuse_note(data, kind):
    """「复用」到底复用哪条服务商 —— 只说复用不说复用谁，等于让用户自己猜。"""
    providers = data.get('providers') if isinstance(data.get('providers'), dict) else {}
    # 生图选 custom 时，复用哪条服务商明写在 image_gen.custom.provider_id 里，
    # 直接读它，比按名字里有没有 image 猜可靠。
    if kind == 'image_gen':
        section = data.get('image_gen') if isinstance(data.get('image_gen'), dict) else {}
        scoped = section.get('custom') if isinstance(section.get('custom'), dict) else {}
        target = str(scoped.get('provider_id') or '')
        if target in providers and isinstance(providers[target], dict):
            return provider_display(providers[target]) or str(target)
    wanted = ('deepseek',) if kind in ('web_search', 'web_extract', 'ocr') else ()
    for pid, item in providers.items():
        if not isinstance(item, dict):
            continue
        base = str(item.get('base_url') or '')
        if any(word in base for word in wanted) or (kind == 'image_gen' and 'image' in str(item.get('name') or '')):
            return provider_display(item) or str(pid)
    return ''


def cred_state(kind, current, rows):
    """这张卡的凭据处境，好让前端每张卡都有话说，不留空白。

    空白最误导：用户看到一张卡什么凭据都不提，会以为漏了没配。
    """
    if rows:
        return 'reuse' if any(row.get('reuse') for row in rows) else 'env'
    if not current:
        return 'unset'
    if kind == 'vision' and current == 'auto':
        return 'inherit'
    return 'local'


def cred_rows(kind, current, env, data=None):
    """一张能力卡当前这个来源要哪些凭据、配了没有。值不出这个模块。"""
    spec = BACKEND_CREDS.get(kind, {}).get(current)
    if spec is None:
        # 文字识别没选也等于白描在用：baimiao-ocr 技能不看 ocr.provider，
        # 只看 .env 里有没有账密。这里照实显示，别让「未选」看起来像没有凭据。
        if kind == 'ocr' and not current:
            spec = BACKEND_CREDS['ocr']['baimiao']
        else:
            return []
    if spec == 'reuse':
        target = _reuse_note(data or {}, kind)
        return [{'name': '', 'label': '复用服务商的密钥', 'configured': True,
                 'hint': ('复用 ' + target) if target else '用服务商页配好的那条',
                 'reuse': True, 'reuse_of': target}]
    rows = []
    for name, label in spec:
        value = env.get(name) or ''
        rows.append({'name': name, 'label': label, 'configured': bool(value),
                     'hint': hint(value) if value else '', 'reuse': False})
    return rows




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


AUX_LABELS = {
    'vision': '视觉理解', 'web_extract': '网页提取', 'compression': '上下文压缩',
    'skills_hub': '技能库', 'approval': '审批', 'mcp': 'MCP', 'title_generation': '标题生成',
    'triage_specifier': '分诊', 'kanban_decomposer': '看板拆解',
    'profile_describer': '档案描述', 'curator': '记忆整理',
}

# 白描账密不进 providers（它不是 OpenAI 兼容服务，没有 base_url / models），
# 只能放 .env。这两行登记必须跟着 ocr.provider 走：选了白描才算「在用」，
# 没选就只是「备着」，否则面板会永远挂着两条跟当前能力无关的变量。
BAIMIAO_KEYS = (('BAIMIAO_USER', '账号'), ('BAIMIAO_PASS', '密码'))

KIND_ORDER = ('provider', 'backend', 'aux', 'other')
KIND_LABELS = {'provider': '服务商密钥', 'backend': '能力后端密钥',
               'aux': '辅助模型密钥', 'other': '其他变量'}


def provider_display(item):
    """一条服务商在人眼里的名字：有 key_label 就是「服务名 · key 标签」。"""
    label = str(item.get('key_label') or '').strip()
    name = str(item.get('name') or '').strip()
    if label and name and label != name:
        return name + ' · ' + label
    return label or name or ''


def keys_view(data, path):
    """Every credential variable the loaded config actually refers to.

    2026-11-16 重构：这一页以前直接打印 .env 变量名（CUSTOM_UMU5G7PYGOZES_API_KEY
    这种），用户根本认不出它属于哪个服务。同一个东西在服务商页叫「DeepSeek 官方」，
    到这里变成一串内部 id，两页对不上号，看着就像两个功能在重复。

    所以每行都带三样东西：人读的名字（label）、归属类别（kind）、变量名（name，
    降级成小字）。变量名不改——config 里 ${VAR} 引用着它，改名要同步改 config，
    风险全在用户看不见的地方，收益只是好看。
    """
    env = env_file(path)
    providers = data.get('providers') if isinstance(data.get('providers'), dict) else {}
    rows = {}

    def note(name, who='', kind='other', label='', inline='', active=True, orphan='', valid=True):
        name = (name or '').strip()
        if not name or not ENV_NAME.fullmatch(name):
            return
        row = rows.setdefault(name, {'name': name, 'label': '', 'kind': 'other',
                                     'configured': False, 'source': 'missing',
                                     'hint': '', 'used_by': [], 'active': False,
                                     'orphans': [], 'valid_used': 0})
        # 类别的展示优先级：服务商 > 能力后端 > 辅助模型 > 其他。
        # 一条变量可能被多处引用（比如同时被服务商和 fallback 链用），
        # 用权重而不是「谁先到谁赢」，免得结果取决于字典遍历顺序。
        if KIND_ORDER.index(kind) < KIND_ORDER.index(row['kind'] or 'other'):
            row['kind'] = kind
        if label and (not row['label'] or KIND_ORDER.index(kind) < KIND_ORDER.index(row['kind'])):
            row['label'] = label
        if who and who not in row['used_by']:
            row['used_by'].append(who)
        # 有效引用和失效引用分开数：一个变量可能同时被正经服务商和一条坏掉的
        # 备用链引用，这时候不能把整个变量标红——那会把好服务也打成故障。
        if valid:
            row['valid_used'] = row.get('valid_used', 0) + 1
        if active:
            row['active'] = True
        if orphan and orphan not in row['orphans']:
            row['orphans'].append(orphan)
        if name in env and env[name]:
            row['configured'] = True
            if row['source'] != 'inline':
                row['source'] = 'env'
            row['hint'] = hint(env[name])
        elif inline and not inline.startswith('${'):
            row['configured'] = True
            row['source'] = 'inline'
            row['hint'] = '配置内密钥'

    for pid, (origin, _idx, item) in entries(data).items():
        cred = credential_fields(item, origin)
        inline = cred.get('api_key') or ''
        name = cred.get('key_env') or ''
        label = provider_display(item) or str(pid)
        if not name and inline.startswith('${'):
            name = inline[2:-1].strip()
        elif not name and inline:
            rows.setdefault('inline:' + pid, {
                'name': '（配置内明文）', 'label': label, 'kind': 'provider',
                'configured': True, 'source': 'inline', 'hint': '配置内密钥',
                'used_by': [label], 'active': True, 'orphans': [], 'valid_used': 1})
            continue
        note(name, label, 'provider', label, inline)

    auxiliary = data.get('auxiliary') if isinstance(data.get('auxiliary'), dict) else {}
    for task, item in auxiliary.items():
        if not isinstance(item, dict):
            continue
        guard = '辅助模型 · ' + AUX_LABELS.get(task, task)
        cred = credential_fields(item, 'providers')
        inline = cred.get('api_key') or ''
        name = cred.get('key_env') or ''
        if not name and inline.startswith('${'):
            name = inline[2:-1].strip()
        note(name, guard, 'aux', guard, inline)
        for index, entry in enumerate(item.get('fallback_chain') or []):
            if not isinstance(entry, dict):
                continue
            sub = credential_fields(entry, 'providers')
            target = str(entry.get('provider') or '').strip()
            # 备用链里写的 provider id 必须真的存在，否则这条备用永远取不到
            # 密钥 —— 用户看到「已配置」，真跑起来却 401，最难查的那类。
            orphan = ''
            if target and target not in providers:
                orphan = '%s 的备用链第 %d 条指向不存在的服务商 %s' % (guard, index + 1, target)
            note(sub.get('key_env') or (sub.get('api_key') or '')[2:-1].strip(),
                 guard, 'aux', guard, sub.get('api_key') or '', orphan=orphan,
                 valid=not orphan)

    ocr_choice = ''
    ocr_holder = data.get('ocr')
    if isinstance(ocr_holder, dict):
        ocr_choice = str(ocr_holder.get('provider') or '')

    for key, label, field, options, writable, write_via in DOMAINS:
        if not field:
            continue
        holder = data
        for part in field.split('.')[:-1]:
            holder = holder.get(part) if isinstance(holder, dict) else None
        if isinstance(holder, dict):
            cred = credential_fields(holder, 'providers')
            note(cred.get('key_env') or (cred.get('api_key') or '')[2:-1].strip(),
                 '能力后端 · ' + label, 'backend', '能力后端 · ' + label)

    # 白描账密：只有 ocr.provider 真的选了白描才算在用，否则标成「备着」。
    # 以前无条件登记，导致不管当前文字识别用谁，这两行都跟其他密钥混在一起。
    baimiao_on = ocr_choice == 'baimiao'
    for name, what in BAIMIAO_KEYS:
        note(name, '文字识别 · 白描' + what, 'backend',
             '文字识别 · 白描' + what, active=baimiao_on)

    ordered = []
    for row in rows.values():
        if not row['label']:
            row['label'] = row['name']
        row['orphan'] = bool(row['orphans']) and not row.get('valid_used')
        # 已配置且没被任何地方引用 → 面板上留着没坏处，但要能一眼看出它闲着。
        if not row['used_by'] and row['configured']:
            row['idle'] = True
        else:
            row['idle'] = False
        ordered.append(row)
    ordered.sort(key=lambda row: (KIND_ORDER.index(row['kind']), not row['active'],
                                  row['source'] != 'env', row['label']))

    groups = []
    for kind in KIND_ORDER:
        bucket = [row for row in ordered if row['kind'] == kind]
        if bucket:
            groups.append({'kind': kind, 'label': KIND_LABELS[kind], 'keys': bucket})

    return {'ok': True, 'keys': ordered, 'groups': groups,
            'orphans': [{'name': row['name'], 'label': row['label'], 'reason': reason}
                        for row in ordered for reason in row['orphans']],
            'env_file': str(Path(path).parent / '.env'), 'env_count': len(env)}


def save_key(data, path, body):
    """写一个环境变量到 .env（追加或替换同名行）。只动 .env，不碰 config.yaml。"""
    name = str(body.get('name') or '').strip()
    value = str(body.get('value') or '')
    if not ENV_NAME.fullmatch(name):
        raise ConfigError('变量名只能用字母、数字、下划线')
    if not value.strip():
        raise ConfigError('值不能为空')
    if len(value) > 16000:
        raise ConfigError('值过长')
    env_path = Path(path).parent / '.env'
    lines = env_path.read_text(encoding='utf-8', errors='replace').splitlines() if env_path.is_file() else []
    out = []
    found = False
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith('#') or '=' not in stripped:
            out.append(line)
            continue
        key = stripped.split('=', 1)[0].strip()
        if key.startswith('export '):
            key = key[7:].strip()
        if key == name:
            out.append(name + '=' + value)
            found = True
        else:
            out.append(line)
    if not found:
        out.append(name + '=' + value)
    content = ('\n'.join(out) + '\n').encode('utf-8')
    import os, tempfile, time, hashlib
    original = env_path.read_bytes() if env_path.is_file() else b''
    backup_dir = Path(path).parent / '.env-backups'
    try:
        backup_dir.mkdir(parents=True, exist_ok=True)
        stamp = backup_dir / ('env-' + str(time.time_ns()) + '-' + hashlib.sha256(original).hexdigest()[:12] + '.bak')
        with stamp.open('xb') as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(original)
    except OSError:
        pass
    fd, temp = tempfile.mkstemp(prefix='.env-', dir=env_path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, env_path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)
    return keys_view(data, path)


def _dig(data, field):
    holder = data
    for part in field.split('.')[:-1]:
        holder = holder.get(part) if isinstance(holder, dict) else None
    if not isinstance(holder, dict):
        return None, None
    return holder, field.split('.')[-1]


def backends_view(data, path=None):
    """8 张能力卡：语音两张开到语音编辑器，视觉开到辅助模型编辑器，其余本页直写。

    image_gen 在本页直写 ``image_gen.provider``；它选的 API key 在「密钥」页
    写进 .env，所以这张卡的 detail 会标出该 provider 认哪个变量、是否已经配了。
    """
    env = env_file(path) if path else {}
    tts = data.get('tts') if isinstance(data.get('tts'), dict) else {}
    tts_providers = tts.get('providers') if isinstance(tts.get('providers'), dict) else {}
    stt = data.get('stt') if isinstance(data.get('stt'), dict) else {}
    stt_params = stt.get('params') if isinstance(stt.get('params'), dict) else {}
    aux = data.get('auxiliary') if isinstance(data.get('auxiliary'), dict) else {}
    vision = aux.get('vision') if isinstance(aux.get('vision'), dict) else {}
    rows = []
    for key, label, field, options, writable, write_via in DOMAINS:
        holder, leaf = _dig(data, field) if field else (None, None)
        current = ''
        detail = {}
        if holder is not None:
            current = str(holder.get(leaf) or '')
            detail = {k: plain(v) for k, v in holder.items()
                      if k not in ('api_key', 'key_env', 'api_key_env', 'apiKey') and not isinstance(v, (dict, list))}
        if key == 'stt':
            options = ('local', 'openai', 'mistral', 'elevenlabs')
            detail['language'] = str(stt.get('language') or '')
            detail['model'] = str(((stt_params.get(current) or {}) if isinstance(stt_params.get(current), dict) else {}).get('model') or '')
        if key == 'tts':
            options = tuple(sorted(set(tts_providers) | {'edge', 'openai', 'elevenlabs', 'windows-indextts'}))
            detail['format'] = str(tts.get('output_format') or '')
            detail['providers'] = len(tts_providers)
        if key == 'vision':
            options = ('',)
            detail['model'] = str(vision.get('model') or '')
            detail['base_url'] = str(vision.get('base_url') or '')
            detail['provider'] = str(vision.get('provider') or '')
        if key == 'image_gen':
            section = data.get('image_gen') if isinstance(data.get('image_gen'), dict) else {}
            scoped = section.get(current) if isinstance(section.get(current), dict) else {}
            # custom 的模型名必须来自 image_gen.custom.model；回落到顶层
            # image_gen.model 会把「picker 选的 provider id」误当成模型名显示。
            fallback_model = '' if current == 'custom' else section.get('model')
            detail['model'] = str(scoped.get('model') or fallback_model or '')
            # 地址和密钥不再存在图像卡里：custom 只记「引用哪条 LLM 服务」，
            # 真正的 base_url / api_key 全在 providers.<id> 上。
            detail['provider_id'] = str(scoped.get('provider_id') or '')
            # 候选模型列表（2026-11-17）：面板要回显「勾了哪几个、哪个是默认」，
            # 光有当前生效的那一条不够。targets 在 image_gen 顶层（不在 custom 下面），
            # /api/workspace-ui/image-targets 读的就是它。
            raw_targets = section.get('targets')
            clean_targets = []
            if isinstance(raw_targets, list):
                for item in raw_targets:
                    if isinstance(item, dict) and item.get('model'):
                        clean_targets.append({'provider_id': str(item.get('provider_id') or ''),
                                              'model': str(item.get('model'))})
            # 老配置没有 targets：用当前生效的 provider_id+model 兜一条，
            # 否则面板打开是一片空白，看着像"一个都没配"。
            if not clean_targets and detail['model']:
                clean_targets = [{'provider_id': detail['provider_id'], 'model': detail['model']}]
            detail['targets'] = clean_targets
            key_name = IMAGE_GEN_KEYS.get(current, '')
            detail['key_env'] = key_name
            if key_name:
                # .env 里有没有这个变量；绝不把值传出去。
                detail['key'] = '已配置' if env.get(key_name) else '未配置'
            elif current == 'openai-codex':
                detail['key'] = '走 Codex OAuth，无需单独 key'
            else:
                detail['key'] = '地址和密钥都复用你选的那条 LLM 服务；这张卡只挑服务和模型'
        kernel_reads = KERNEL_READS.get(key, True)
        if not kernel_reads:
            # 不能让这张卡挂着「本页可配」而下面写着「已配」—— 那颗徽章说的是
            # 「这个键内核读」，ocr 不满足，照实标出来。
            status, status_tone = '技能专用', 'warn'
        elif writable:
            status, status_tone = '本页可配', 'ok'
        else:
            status, status_tone = '需二改', 'warn'
        creds = cred_rows(key, current, env, data)
        kernel = KERNEL_READS.get(key, True)
        if not kernel:
            # 照实说：这张卡改的是个没人读的键，别让用户以为换一下引擎就换了。
            note = '内核没有 %s 配置段，这里的选项只是给 baimiao-ocr 技能当参考；真正生效的是 .env 里的白描账密' % (field or key)
        elif not writable:
            note = '跟随服务商原生能力，没有独立配置项'
        else:
            note = ''
        rows.append({'key': key, 'label': label, 'provider': current, 'options': list(options),
                     'cred_state': cred_state(key, current, creds),
                     'writable': writable, 'write_via': write_via,
                     'path': field or '二改工具', 'status': status, 'status_tone': status_tone,
                     'detail': detail, 'creds': creds, 'kernel': kernel, 'note': note})
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
    key, label, field, options, writable, write_via = match
    if not writable:
        raise ConfigError('%s跟随服务商原生能力，没有可写的配置项' % label)
    if write_via != 'config':
        raise ConfigError('%s由%s专用编辑器管理，请在该编辑器里改' %
                          (label, '语音' if write_via == 'voice' else '辅助模型'))
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
    if key == 'image_gen':
        # 图像生成卡的额外字段只有两项：引用哪条 LLM 服务（provider_id）+ 生图模型名。
        # 地址和密钥一律复用 providers.<provider_id>，这里不再另存一份。
        extras = body.get('extras')
        if isinstance(extras, dict):
            section = updated.get('image_gen')
            if not isinstance(section, dict):
                section = {}
                updated['image_gen'] = section
            sub = section.get('custom')
            if not isinstance(sub, dict):
                sub = {}
                section['custom'] = sub
            for fname, flabel in (('provider_id', '引用的 LLM 服务'),
                                  ('model', '生图模型名')):
                if fname in extras:
                    cleaned = _scalar(extras.get(fname), flabel, 200)
                    if cleaned:
                        sub[fname] = cleaned
                    else:
                        sub.pop(fname, None)
            # 候选生图模型（2026-11-17）。用户要的是「在这里能勾多个模型、勾一个默认」，
            # 而画板那张下拉（cvTargetBtn）和新建画板面板读的都是
            # /api/workspace-ui/image-targets —— 那个接口解析的是 image_gen.targets 数组
            # （顶层，不是 custom 下面，别放错层）。真正生效的仍是 custom.model：
            # 内核只认 image_gen.<plugin>.model 这一个值，所以默认模型必须同步写进去，
            # 否则面板上勾的默认和实际生图用的不是同一个。
            if 'targets' in extras:
                raw = extras.get('targets')
                if not isinstance(raw, list):
                    raise ConfigError('候选生图模型格式不正确')
                if len(raw) > 40:
                    raise ConfigError('候选生图模型最多 40 个')
                clean_targets = []
                seen = set()
                for item in raw:
                    if not isinstance(item, dict):
                        continue
                    pid = _scalar(item.get('provider_id') or '', '引用的 LLM 服务', 120)
                    mid = _scalar(item.get('model') or '', '生图模型名', 200)
                    if not mid or (pid, mid) in seen:
                        continue
                    seen.add((pid, mid))
                    clean_targets.append({'provider_id': pid, 'model': mid})
                if clean_targets:
                    section['targets'] = clean_targets
                    sub['provider_id'] = clean_targets[0]['provider_id']
                    sub['model'] = clean_targets[0]['model']
                else:
                    section.pop('targets', None)
            # 旧方案在图像卡里单独存过地址和密钥变量名，现在全部走 provider，
            # 这两项直接清掉 —— 留着只会让人以为还有第二处要配。
            sub.pop('base_url', None)
            sub.pop('api_key_env', None)
            if not sub:
                section.pop('custom', None)
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
    # Tool Gateway 面板：网关的几个真实开关（参考稿那一块的落点）。
    # 只接受这四个键，其它一律拒绝，避免把面板做成任意配置写入器。
    gateway_patch = body.get('gateway')
    if gateway_patch is not None:
        if not isinstance(gateway_patch, dict):
            raise ConfigError('网关设置格式不正确')
        allowed = {'strict', 'trust_recent_files', 'trust_recent_files_seconds', 'media_delivery_allow_dirs'}
        unknown = sorted(set(gateway_patch) - allowed)
        if unknown:
            raise ConfigError('网关不支持这些键：' + '、'.join(unknown))
        gateway = updated.get('gateway')
        if not isinstance(gateway, dict):
            gateway = {}
        for name, value in gateway_patch.items():
            if name in ('strict', 'trust_recent_files'):
                if type(value) is not bool:
                    raise ConfigError('%s 必须是布尔值' % name)
                gateway[name] = value
            elif name == 'trust_recent_files_seconds':
                if type(value) is not int or not 0 <= value <= 86400:
                    raise ConfigError('trust_recent_files_seconds 必须是 0–86400 的整数')
                gateway[name] = value
            else:
                if not isinstance(value, list) or any(not isinstance(item, str) or len(item) > 300 for item in value):
                    raise ConfigError('media_delivery_allow_dirs 必须是路径字符串数组')
                gateway[name] = [item.strip() for item in value if item.strip()]
        if gateway:
            updated['gateway'] = gateway
        else:
            updated.pop('gateway', None)
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
    if action == 'save_key':
        return save_key(data, path, body)
    if action == 'backends':
        return backends_view(data, path)
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
    elif action == 'config_write':
        # 手写整份 YAML 写回。三道闸：能解析、是映射、带 model 段。
        # 少一道就等于给了面板一个把助手写死的机会。
        text_in = body.get('text')
        if not isinstance(text_in, str) or not text_in.strip():
            raise ConfigError('配置内容为空')
        encoded = text_in.encode('utf-8')
        if len(encoded) > 2 * 1024 * 1024:
            raise ConfigError('配置超过 2MB，拒绝写入')
        try:
            _, candidate = load_yaml(encoded)
        except Exception as error:
            raise ConfigError('YAML 解析失败，原文件未改写：' + str(error)[:200])
        if not isinstance(candidate, dict) or not candidate:
            raise ConfigError('配置必须是 YAML 映射，原文件未改写')
        if not isinstance(candidate.get('model'), dict):
            raise ConfigError('新配置缺少 model 段，拒绝写入')
        # 第四道闸（2026-11-16）：这个入口是整份替换，绕过了 patch() 的
        # 「明文进 .env」处理。不拦的话，粘一份带明文 api_key 的 YAML 就把密钥
        # 写回 config 了，前面那些改动白做。拒绝而不是静默改写：这里是手写入口，
        # 替用户猜意图不如直接告诉他该写成什么。
        leaked = []
        for section in ('providers', 'custom_providers'):
            block = candidate.get(section)
            if not isinstance(block, dict):
                continue
            for pid, item in block.items():
                if not isinstance(item, dict):
                    continue
                value = item.get('api_key')
                if isinstance(value, str) and value.strip() and not value.strip().startswith('${'):
                    leaked.append(section + '.' + str(pid))
        if leaked:
            raise ConfigError('这些服务里写的是明文密钥：' + '、'.join(leaked[:5])
                              + ('等 %d 条' % len(leaked) if len(leaked) > 5 else '')
                              + '。改成 ${变量名}（值放 .env），或者去「LLM 服务」卡片里填密钥——那边会自动存进 .env')
        if semantic(candidate) == semantic(data):
            return {'ok': True, 'changed': False, 'revision': config_revision(data)}
        with config_lock(state):
            result = commit(path, state, raw, encoded, '面板：手写配置写入')
        return {**result, 'ok': True, 'changed': True, 'revision': config_revision(candidate),
                'reload_required': True}
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
