/* 模型 · 能力实验室（子页面 9/9）
   2026-11-15：用户「配了我看不到功能」——配置项不等于能力。这里把 provider 支持的
   每一类服务端能力做成一张可点的卡：选服务、填一句输入、点运行、当场看真实返回。
   数据全部来自 /api/panel-models 的 cap_matrix / cap_run，服务端发真实请求，
   密钥只在服务端解析，前端拿不到。 */
(function () {
  'use strict';
  var host = document.getElementById('modelCapsSlot');
  if (!host) return;

  var state = { caps: [], providers: [], provider: '', defaults: {}, files: {}, audio: '' };
  var PROMPT_CAPS = { chat_basic: 1, chat_title: 1, chat_safety: 1, chat_search: 1, chat_reminder: 1, chat_file: 1 };
  var URL_CAPS = { chat_readurl: 1, tool_fetch: 1 };
  var FILE_CAPS = { chat_file: '图片或 PDF', tool_ocr: '图片（PNG/JPG）', tool_asr: '音频（WAV/OGG，≤2 分钟）' };

  function api(body) {
    return fetch(apiUrl('/api/panel-models'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Monitor-Token': monitorToken || '' },
      body: JSON.stringify(body), cache: 'no-store'
    }).then(function (r) {
      return r.json().then(function (out) {
        if (!r.ok || !out.ok) throw Error(out.error || '能力请求失败');
        return out;
      });
    });
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function providerSelect() {
    var options = state.providers.map(function (p) {
      return '<option value="' + esc(p.id) + '"' + (p.id === state.provider ? ' selected' : '') + '>'
        + esc(p.name) + ' · ' + esc(p.base_url) + (p.enabled ? '' : '（已停用）') + '</option>';
    }).join('');
    return '<div class="cap-bar">'
      + '<label class="cap-pick">服务<select id="capProvider">' + options + '</select></label>'
      + '<button type="button" class="btn primary" id="capRunAll">全部跑一遍</button>'
      + '<span class="cap-hint">选中的服务必须自己支持这些接口；中转站通常只支持前几项。</span>'
      + '</div>';
  }

  function cardHtml(cap) {
    var parts = ['<article class="cap-card" data-cap="' + esc(cap.id) + '">',
      '<header class="cap-head"><h3>' + esc(cap.label) + '</h3>',
      '<span class="cap-tag">' + (cap.needs === 'file' ? '需文件' : '直接可跑') + '</span></header>',
      '<p class="cap-desc">' + esc(cap.desc) + '</p>'];

    if (PROMPT_CAPS[cap.id]) {
      parts.push('<label class="cap-field">提问<input class="cap-arg" data-arg="prompt" value="'
        + esc(state.defaults.prompt || '') + '"></label>');
    }
    if (cap.id === 'tool_search') {
      parts.push('<label class="cap-field">关键词<input class="cap-arg" data-arg="query" value="'
        + esc(state.defaults.query || '') + '"></label>');
    }
    if (URL_CAPS[cap.id]) {
      parts.push('<label class="cap-field">链接<input class="cap-arg" data-arg="url" value="'
        + esc(state.defaults.url || '') + '"></label>');
    }
    if (cap.id === 'tool_tts') {
      parts.push('<label class="cap-field">朗读文本<textarea class="cap-arg" data-arg="text" rows="2">'
        + esc(state.defaults.text || '') + '</textarea></label>');
      parts.push('<label class="cap-field">音色<select class="cap-arg" data-arg="voice">'
        + '<option value="stella">stella（女声）</option><option value="tide">tide（男声）</option></select></label>');
    }
    if (cap.id === 'chat_thinking') {
      parts.push('<label class="cap-field">思考强度<select class="cap-arg" data-arg="effort">'
        + '<option value="low">low</option><option value="high" selected>high</option>'
        + '<option value="max">max</option></select></label>');
    }
    if (FILE_CAPS[cap.id]) {
      parts.push('<label class="cap-field">文件（' + esc(FILE_CAPS[cap.id]) + '）'
        + '<input type="file" class="cap-file"></label>');
    }
    parts.push('<div class="cap-foot"><button type="button" class="btn cap-run">运行</button>'
      + '<span class="cap-status"></span></div>',
      '<div class="cap-result" hidden></div></article>');
    return parts.join('');
  }

  function render() {
    if (!state.providers.length) {
      host.innerHTML = '<div class="settings-section"><p class="page-subtitle">还没有可测试的模型服务，先去「通用模型」加一条。</p></div>';
      return;
    }
    host.innerHTML = '<div class="settings-section">' + providerSelect()
      + '<div class="cap-grid">' + state.caps.map(cardHtml).join('') + '</div></div>';
    bind();
  }

  function card(cap) { return host.querySelector('.cap-card[data-cap="' + cap + '"]'); }

  function payload(cap) {
    var node = card(cap), body = { action: 'cap_run', provider: state.provider, cap: cap };
    node.querySelectorAll('.cap-arg').forEach(function (input) {
      var value = String(input.value || '').trim();
      if (value) body[input.dataset.arg] = value;
    });
    var file = state.files[cap];
    if (file) { body.file_b64 = file.b64; body.filename = file.name; }
    return body;
  }

  function paint(cap, out, ms) {
    var node = card(cap), box = node.querySelector('.cap-result'), status = node.querySelector('.cap-status');
    node.classList.toggle('is-ok', !!out.ok);
    node.classList.toggle('is-fail', !out.ok);
    status.textContent = (out.ok ? '通过' : '失败') + ' · ' + (out.ms || ms) + ' ms';
    var html = '<div class="cap-line-head">' + esc(out.headline || '') + '</div>';
    if (out.lines && out.lines.length) {
      html += '<ul class="cap-lines">' + out.lines.map(function (line) {
        return '<li>' + esc(line) + '</li>';
      }).join('') + '</ul>';
    }
    if (out.preview) html += '<pre class="cap-preview">' + esc(String(out.preview).slice(0, 1200)) + '</pre>';
    if (out.audio) {
      state.audio = out.audio;
      html += '<audio class="cap-audio" controls src="data:' + esc(out.audio_mime || 'audio/wav') + ';base64,' + out.audio + '"></audio>'
        + '<div class="cap-tip">这段音频可以直接当「语音识别」的输入，点那张卡的「用上一段音频」。</div>';
    }
    box.hidden = false;
    box.innerHTML = html;
  }

  function runOne(cap, silent) {
    var node = card(cap), button = node.querySelector('.cap-run'), status = node.querySelector('.cap-status');
    /* 2026-11-15 修：这两段的顺序原来反了 —— 先 `if(!state.files[cap]) return '先选一个文件'`，
       后面那段「用 TTS 刚合成的音频喂 ASR」永远执行不到，等于白写。
       语音合成那张卡生成完会存进 state.audio，这里必须先拿它兜底，再判缺文件。 */
    if (cap === 'tool_asr' && !state.files[cap] && state.audio) {
      state.files[cap] = { b64: state.audio, name: 'tts-sample.wav' };
      status.textContent = '用上一步合成的音频';
    }
    if (FILE_CAPS[cap] && !state.files[cap]) {
      status.textContent = '先选一个文件';
      return Promise.resolve(false);
    }
    button.disabled = true;
    if (!silent) status.textContent = '请求中…';
    var started = Date.now();
    return api(payload(cap)).then(function (out) {
      paint(cap, out, Date.now() - started);
      return !!out.ok;
    }).catch(function (error) {
      paint(cap, { ok: false, headline: error.message || '请求失败', lines: [] }, Date.now() - started);
      return false;
    }).then(function (ok) {
      button.disabled = false;
      return ok;
    });
  }

  function readFile(cap, input) {
    var file = input.files && input.files[0];
    if (!file) { delete state.files[cap]; return; }
    if (file.size > 4 * 1024 * 1024) {
      card(cap).querySelector('.cap-status').textContent = '文件超过 4MB，后端会拒';
      delete state.files[cap];
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      var raw = String(reader.result || '');
      state.files[cap] = { b64: raw.slice(raw.indexOf(',') + 1), name: file.name };
      card(cap).querySelector('.cap-status').textContent = '已选 ' + file.name + ' · ' + Math.round(file.size / 1024) + 'KB';
    };
    reader.readAsDataURL(file);
  }

  /* 2026-11-15：文件解析 / OCR 这两张卡以前在「全部跑一遍」里被跳过，用户看到的是
     「11 通过」——剩下 3 张其实一动没动。这里现场用 canvas 画一张带字的样例图当输入，
     让全量真的覆盖到，同时不往仓库里塞一大段 base64 常量。
     单卡「运行」仍然要求用户自己选文件，不会被这张样例冒名顶替。 */
  function makeSamplePng() {
    try {
      var cv = document.createElement('canvas');
      cv.width = 720; cv.height = 240;
      var g = cv.getContext('2d');
      g.fillStyle = '#ffffff'; g.fillRect(0, 0, cv.width, cv.height);
      g.fillStyle = '#111111';
      g.font = 'bold 44px sans-serif';
      g.fillText('HERMES CAP TEST', 36, 84);
      g.font = '36px sans-serif';
      g.fillText('鲸鱼娘 能力实验室 2026-11-15', 36, 146);
      g.font = '28px sans-serif';
      g.fillStyle = '#444444';
      g.fillText('sample png for ocr / file parse', 36, 200);
      var url = cv.toDataURL('image/png');
      return url.slice(url.indexOf(',') + 1);
    } catch (e) { return ''; }
  }

  function bind() {
    var picker = host.querySelector('#capProvider');
    if (picker) {
      picker.onchange = function () { state.provider = picker.value; };
    }
    host.querySelectorAll('.cap-card').forEach(function (node) {
      var cap = node.dataset.cap;
      node.querySelector('.cap-run').onclick = function () { runOne(cap); };
      var input = node.querySelector('.cap-file');
      if (input) input.onchange = function () { readFile(cap, input); };
    });
    var all = host.querySelector('#capRunAll');
    if (all) all.onclick = function () {
      all.disabled = true;
      /* 2026-11-15：
         1) 语音识别要用语音合成的产物，原顺序里 ASR 排在 TTS 前面，跑全量时必然「先选文件」。
            这里把 TTS 提到 ASR 之前，让 全部跑一遍 能把这条链路自己串起来。
         2) 原摘要只报通过数，需要文件的卡被静默跳过 —— 看着像「11 通过」，实际有 3 张根本没跑。
            现在把跳过项点名报出来，不装作跑过。
         3) 开跑前清掉上一轮的 is-ok/is-fail，避免旧结果被算进这次统计。 */
      host.querySelectorAll('.cap-card').forEach(function (n) {
        n.classList.remove('is-ok', 'is-fail');
        var s = n.querySelector('.cap-status'); if (s) s.textContent = '';
        var r = n.querySelector('.cap-result'); if (r) { r.hidden = true; r.innerHTML = ''; }
      });
      /* 需要图片的两张卡：没手动选文件就用现场生成的样例图，全量才有意义 */
      var sample = '';
      ['chat_file', 'tool_ocr'].forEach(function (cap) {
        if (!FILE_CAPS[cap] || state.files[cap]) return;
        if (!sample) sample = makeSamplePng();
        if (sample) {
          state.files[cap] = { b64: sample, name: 'hermes-cap-sample.png' };
          var st0 = card(cap).querySelector('.cap-status');
          if (st0) st0.textContent = '用内置样例图';
        }
      });
      var ordered = state.caps.slice().sort(function (a, b) {
        var rank = function (id) { return id === 'tool_tts' ? 0 : (id === 'tool_asr' ? 2 : 1); };
        return rank(a.id) - rank(b.id);
      });
      var queue = ordered, failed = [], skipped = [];
      function next() {
        if (!queue.length) {
          all.disabled = false;
          var ok = host.querySelectorAll('.cap-card.is-ok').length;
          var bad = host.querySelectorAll('.cap-card.is-fail').length;
          all.textContent = '全部跑一遍 · ' + ok + ' 通过'
            + (bad ? ' / ' + bad + ' 失败' : '')
            + (skipped.length ? ' · ' + skipped.length + ' 待文件（' + skipped.join('、') + '）' : '');
          return;
        }
        var cap = queue.shift().id;
        if (FILE_CAPS[cap] && !state.files[cap]) {
          /* tool_asr 能自己从 state.audio 取音频，交给 runOne 判；其余确实缺文件 */
          if (!(cap === 'tool_asr' && state.audio)) {
            var label = (state.caps.filter(function (c) { return c.id === cap; })[0] || {}).label || cap;
            skipped.push(label);
            var st = card(cap).querySelector('.cap-status');
            if (st) st.textContent = '未跑：需要先选文件';
            next(); return;
          }
        }
        runOne(cap, true).then(function (ok) {
          if (!ok) failed.push(cap);
          next();
        });
      }
      next();
    };
  }

  function load() {
    host.innerHTML = '<div class="settings-section"><p class="page-subtitle">正在读取服务清单…</p></div>';
    api({ action: 'cap_matrix' }).then(function (out) {
      state.caps = out.caps || [];
      state.providers = out.providers || [];
      state.defaults = out.defaults || {};
      var official = state.providers.filter(function (p) { return /deepseek\.com/i.test(p.base_url || ''); })[0];
      state.provider = (official || state.providers.filter(function (p) { return p.enabled; })[0] || {}).id || '';
      render();
    }).catch(function (error) {
      host.innerHTML = '<div class="settings-section"><p class="page-subtitle">读取失败：' + esc(error.message) + '</p></div>';
    });
  }

  var refresh = document.getElementById('modelCapsRefresh');
  if (refresh) refresh.onclick = function () { load(); };

  load();
  window.reloadModelCaps = load;
})();
