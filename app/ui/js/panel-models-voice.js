/* 模型页 · 语音栈与 JEV 区块：STT 提供方 / TTS 提供方 / JEV 状态。
   读写 /api/panel-models/voice（panel-speech-config.py），带 revision 冲突检测。
   与 panel-models-ui.js 共享 apiUrl()/monitorToken 全局，不重复定义工具函数名。 */
(function () {
  'use strict';
  var state = null;

  function el(tag, text, cls) { var e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
  function btn(text, run, cls) { var b = el('button', text, cls || 'btn'); b.type = 'button'; b.onclick = run; return b; }
  function hint(text) { return el('p', text, 'pw-hint'); }
  function labelBox(text, control) { var w = el('label', null, 'field'); w.append(el('span', text), control); return w; }
  function input(value, type) { var i = document.createElement('input'); if (type && type !== 'text') i.type = type; i.value = value == null ? '' : value; return i; }
  function picker(pairs, value, extra) {
    var s = document.createElement('select');
    (extra || []).forEach(function (pair) { s.append(option(pair[0], pair[1])); });
    (pairs || []).forEach(function (pair) { s.append(option(pair[0], pair[1])); });
    if (value && !(pairs || []).concat(extra || []).some(function (p) { return p[0] === value; })) s.append(option(value, value + ' · 当前值'));
    s.value = value || '';
    return s;
  }
  function option(value, text) { var o = document.createElement('option'); o.value = value; o.textContent = text; if (value === '') o.disabled = true; return o; }

  function voiceApi(body) {
    var url = typeof apiUrl === 'function' ? apiUrl('/api/panel-models/voice') : '/api/panel-models/voice';
    return fetch(url, {
      method: body ? 'PATCH' : 'GET',
      headers: { 'Content-Type': 'application/json', 'X-Monitor-Token': (typeof monitorToken === 'string' ? monitorToken : '') },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store'
    }).then(function (r) { return r.json().then(function (out) { if (!r.ok || !out.ok) { var e = Error(out.error || '语音配置操作失败'); e.status = r.status; throw e; } return out; }); });
  }

  function status() { return document.getElementById('voiceStackStatus'); }
  function say(text) { var s = status(); if (s) s.textContent = text || ''; }

  function drawJev(host, jev) {
    host.replaceChildren();
    if (!jev) { host.append(hint('JEV 状态未返回。')); return; }
    var badge = el('span', jev.ready ? '可用' : (jev.installed ? '已安装 · 缺密钥' : '未安装'), 'pmv-badge ' + (jev.ready ? 'ok' : 'off'));
    var head = el('div', null, 'pmv-head'); head.append(el('strong', '判断副驾（可选）'), badge);
    host.append(head, el('p', jev.note, 'pmv-note'));
    var keys = Object.keys(jev.credentials || {});
    host.append(el('p', '判定后端密钥：' + keys.map(function (k) { return k + (jev.credentials[k] ? ' 已配置' : ' 未配置'); }).join(' · '), 'pw-hint'));
    if (jev.path) host.append(el('p', '插件目录：' + jev.path, 'pw-hint'));
    host.append(el('p', '它不是对话模型，装上也顶替不了主模型；没有密钥就只能保持未启用，面板不代填。', 'pw-hint'));
    var link = el('a', '看官方 JEV 说明', 'pmv-link'); link.href = jev.doc; link.target = '_blank'; link.rel = 'noopener';
    host.append(link);
  }

  function drawTts(host, tts) {
    host.replaceChildren();
    var configured = (tts.providers || []).map(function (p) { return [p.name, p.name + '（' + (p.type === 'command' ? '自定义命令' : p.type) + '）']; });
    var select = picker(tts.options, tts.provider, configured);
    var edgeVoice = input(tts.edge_voice);
    var draft = { provider: select.value, edge_voice: edgeVoice.value, providers: {}, remove_provider: null };

    host.append(labelBox('当前 TTS 提供方', select), labelBox('Edge 音色（仅 Edge 用）', edgeVoice));
    host.append(hint('语音条就是这里这副嗓子。换提供方只影响之后的合成；已经发出的语音不会变。'));

    var list = el('div', null, 'pmv-cards');
    (tts.providers || []).forEach(function (p) {
      var card = el('div', null, 'pmv-card');
      card.append(el('div', p.name, 'pmv-card-title'));
      if (p.type !== 'command') { card.append(hint('这个提供方由内核固定实现，面板只读。')); list.append(card); return; }
      var cmd = input(p.command), timeout = input(p.timeout, 'number'), maxLen = input(p.max_text_length, 'number');
      var fields = el('div', null, 'pmv-grid');
      fields.append(labelBox('合成命令', cmd), labelBox('输出格式', picker(tts.formats.map(function (f) { return [f, f]; }), p.output_format)), labelBox('超时（秒）', timeout), labelBox('单次文本上限（字）', maxLen));
      var fmtSelect = fields.children[1].querySelector('select');
      var edits = function () {
        draft.providers[p.name] = { command: cmd.value, output_format: fmtSelect.value, timeout: Number(timeout.value) || 0, max_text_length: Number(maxLen.value) || 0 };
      };
      [cmd, timeout, maxLen].forEach(function (i) { i.addEventListener('input', edits); });
      fmtSelect.addEventListener('change', edits);
      edits();
      var actions = el('div', null, 'mcp-actions');
      actions.append(btn('删除这个提供方', function () { draft.remove_provider = p.name; save('tts', { provider: select.value, providers: draft.providers, remove_provider: p.name }, 'TTS'); }));
      card.append(fields, actions);
      list.append(card);
    });
    host.append(list);

    var newName = input('', 'text'), newCmd = input('', 'text');
    var addRow = el('div', null, 'pmv-grid');
    addRow.append(labelBox('新增提供方名称', newName), labelBox('合成命令（{input_path} {output_path}）', newCmd));
    host.append(addRow, el('p', '名称只能用小写字母、数字、下划线或短横线；命令里必须给输入、输出路径留位置。', 'pw-hint'));

    var footer = el('div', null, 'mcp-actions');
    footer.append(btn('保存 TTS 设置', function () {
      var payload = { provider: select.value, edge_voice: edgeVoice.value, providers: draft.providers };
      if (newName.value.trim() && newCmd.value.trim()) {
        payload.providers = Object.assign({}, draft.providers); payload.providers[newName.value.trim()] = { command: newCmd.value.trim(), output_format: 'mp3' };
        payload.provider = newName.value.trim();
      }
      save('tts', payload, 'TTS');
    }, 'btn primary'));
    host.append(footer);
  }

  function drawStt(host, stt) {
    host.replaceChildren();
    var enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.checked = !!stt.enabled;
    var provider = picker(stt.options, stt.provider);
    var language = input(stt.language);
    var enabledWrap = el('label', null, 'field pmv-check'); enabledWrap.append(enabled, el('span', '启用语音转写'));
    host.append(enabledWrap, labelBox('当前 STT 提供方', provider), labelBox('识别语言', language));
    host.append(hint('发语音条给 AI 时，先在本地或云端转成文字。本地 Whisper 不上传音频，云端更快。'));

    var params = {};
    Object.keys(stt.params || {}).forEach(function (name) {
      var card = el('div', null, 'pmv-card');
      card.append(el('div', name, 'pmv-card-title'));
      var grid = el('div', null, 'pmv-grid');
      params[name] = {};
      Object.keys(stt.params[name]).forEach(function (key) {
        var value = stt.params[name][key];
        if (typeof value === 'boolean') {
          var box = document.createElement('input'); box.type = 'checkbox'; box.checked = value;
          var wrap = el('label', null, 'field pmv-check'); wrap.append(box, el('span', key));
          box.addEventListener('change', function () { params[name][key] = box.checked; });
          grid.append(wrap);
        } else {
          var text = input(value, key === 'initial_prompt' ? 'text' : 'text');
          if (key === 'initial_prompt') { text = document.createElement('textarea'); text.value = value || ''; }
          text.addEventListener('input', function () { params[name][key] = text.value; });
          params[name][key] = value;
          grid.append(labelBox(key, text));
        }
      });
      card.append(grid);
      host.append(card);
    });

    var footer = el('div', null, 'mcp-actions');
    footer.append(btn('保存 STT 设置', function () {
      save('stt', { enabled: enabled.checked, provider: provider.value, language: language.value, params: params }, 'STT');
    }, 'btn primary'));
    host.append(footer);
  }

  function drawOpenAi(host, api) {
    host.replaceChildren();
    if (!api) { host.append(hint('网关探测结果未返回。')); return; }
    var badgeText = api.needs_key ? '在线 · 需密钥' : (api.reachable ? '在线' : '连不上');
    var head = el('div', null, 'pmv-head');
    head.append(el('strong', '本机网关 · OpenAI 兼容'), el('span', badgeText, 'pmv-badge ' + (api.reachable && !api.needs_key ? 'ok' : 'off')));
    host.append(head);

    var card = el('div', null, 'pmv-card');
    card.append(el('div', '接口基址', 'pmv-card-title'));
    var row = el('div', null, 'pmv-urlrow');
    var code = el('code', api.base_url);
    var copy = btn('复制', function () {
      var done = function () { copy.textContent = '已复制'; setTimeout(function () { copy.textContent = '复制'; }, 1500); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(api.base_url).then(done, done);
      else done();
    });
    row.append(code, copy);
    card.append(row);
    card.append(hint('本机自测地址 ' + api.local_url + '，端口 ' + api.port + '。手机/电脑同网段直接用上面那条。'));
    host.append(card);

    var ep = el('div', null, 'pmv-card');
    ep.append(el('div', '对外端点', 'pmv-card-title'));
    (api.endpoints || []).forEach(function (item) {
      var line = el('div', null, 'pmv-check');
      line.append(el('code', item[0] + ' ' + item[1]), el('span', item[2], 'pmv-note'));
      ep.append(line);
    });
    host.append(ep);

    var auth = el('div', null, 'pmv-card');
    auth.append(el('div', '鉴权与模型', 'pmv-card-title'));
    auth.append(hint('.env 里的 API_SERVER_KEY：' + (api.key_configured ? '已登记' : '未登记（面板不回显、不代填）')));
    if (api.status) auth.append(hint('实测 GET /v1/models → ' + api.status + (api.error ? ' · ' + api.error : '')));
    else auth.append(hint('实测 GET /v1/models → 请求没发出去' + (api.error ? ' · ' + api.error : '')));
    if (api.models && api.models.length) {
      var list = el('div', 'mcp-actions');
      api.models.forEach(function (id) { list.append(el('code', id)); });
      auth.append(list);
    } else {
      auth.append(hint('模型清单要带密钥才列得出来。'));
    }
    host.append(auth);
    if (api.note) host.append(hint(api.note));
  }

  async function save(section, changes, name) {
    if (!state) return;
    say('正在保存 ' + name + ' 设置…');
    try {
      var out = await voiceApi({ section: section, revision: state.revision, changes: changes });
      state = out; render();
      say(name + ' 设置已保存' + (out.changed ? '，重启应用后生效' : '（没有变化）'));
      if (typeof window.panelRuntimeRefresh === 'function') window.panelRuntimeRefresh();
    } catch (e) {
      say(e.message);
      if (e.status === 409) load();
    }
  }

  function render() {
    if (!state) return;
    var jev = document.getElementById('jevSlot');
    if (jev) drawJev(jev, state.jev);
    var tts = document.getElementById('voiceTtsSlot');
    if (tts) drawTts(tts, state.tts);
    var stt = document.getElementById('voiceSttSlot');
    if (stt) drawStt(stt, state.stt);
    var oa = document.getElementById('openAiApiSlot');
    if (oa) drawOpenAi(oa, state.openai_api);
  }

  async function load() {
    say('正在读取语音配置…');
    try {
      state = await voiceApi(null);
      render();
      say('');
    } catch (e) {
      say(e.message);
      var tts = document.getElementById('voiceTtsSlot');
      if (tts) tts.replaceChildren(btn('重新读取语音配置', load));
    }
  }


  // 2026-11-12：模型页八个分区已提升为真页面（#page-models-general … #page-models-checks），
  // 换页由 panel-navigation.js 的顶部页签负责，这里原来那套 MP_TABS / switchModelTab
  // （切 .mp-pane、写 localStorage hermes.modelsTab）整块删除，避免两套导航同时存在。
  // 兼容：旧书签里 #/models 由 aliases 落到 models-general；switchModelTab 仍保留成一行转发。
  window.switchModelTab = function (key) {
    if (typeof window.switchPage === 'function') window.switchPage('models-' + (key || 'general'));
  };

  window.panelVoiceReload = load;
  var oaRefresh = document.getElementById('openAiApiRefresh');
  if (oaRefresh) oaRefresh.onclick = load;
  if (document.getElementById('voiceTtsSlot') || document.getElementById('jevSlot')) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load);
    else load();
  }
})();
