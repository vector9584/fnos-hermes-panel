/* 能力面板（2026-11-16 新建）
 * ───────────────────────────────────────────────────────────────
 * 起因：输入框右侧那个「联网小球」(#btnWebNet) 是个假开关 —— 它把「禁止联网」
 * 硬约束写进 WEB_OFF_RULE 常量，然后那个常量全仓库零引用，点半天请求里一个字
 * 都没带。同时面板「模型 → 能力后端」里真金白银配着 8 个能力域（语音转写、
 * 语音合成、联网搜索、网页提取、视觉理解、文字识别、图像生成、浏览器），
 * 会话里却一个都摸不到 —— 用户在后台配好了生图，到了对话里不知道怎么说。
 *
 * 所以这个面板做两件事：
 *   1. 把那 8 个域搬到会话输入框，一轮一选，以 chip 形式贴出来；
 *   2. 联网单独做成真开关：关掉时往 system prompt 注入硬约束（compose.js 里
 *      _webNetOn 那段），而不是像以前那样只在 localStorage 里躺着。
 *
 * 语义边界必须说清：这些 chip 是「本轮告诉模型可以做什么」，不是工具级禁用
 * （内核 /v1/chat/completions 按 platform_toolsets 统一装配，不支持按请求
 * 裁剪工具集）。例外是联网 —— 那个走 system 注入，是真约束。
 */
(function () {
  var STORE = 'fnos_capabilities';
  /* 2026-11-16：原来是单一全局 key，切会话还挂着上一个会话选的能力（用户实测发现）。
     按会话隔离：同一会话内保留、换会话清空。老 key 的数据不再读取（那是 bug 残留）。 */
  function storeKey(){
    var sid = (typeof currentSession !== 'undefined' && currentSession) ? currentSession : 'default';
    return STORE + ':' + sid;
  }
  var _domains = null;      /* 后端 backends 原始返回，缓存一次 */
  var _toolsets = null;     /* api_server 平台各工具集的启用状态 */
  var _loading = false;

  /* 能力域 → 承载它的工具集。后端配了 provider，不等于会话里真有这个工具：
     image_gen 域配好了，但 platform_toolsets.api_server 不含 image_gen 时，
     模型手上就没有 image_generate（2026-11-16 用户「选了生图不出图」就是这个）。
     null 表示它不是会话工具 —— 语音转写走的是 QQ/微信入站 adapter 的
     config 键 stt.enabled，会话内没有任何对应工具，勾了也不会多出能力。 */
  var TOOLSET_OF = { web: 'web', image_gen: 'image_gen', vision: 'vision',
                     tts: 'tts', browser: 'browser', stt: null, ocr: 'skills' };
  function toolState(id) {
    if (TOOLSET_OF[id] === null) return 'channel';
    if (!_toolsets) return 'unknown';
    return _toolsets[TOOLSET_OF[id]] ? 'on' : 'off';
  }

  /* 合成项：联网搜索 + 网页提取在用户眼里就是一件事「能不能上网」，
     列表里拆成两条只会让人不知道该点哪个。 */
  var MERGE_WEB = ['web_search', 'web_extract'];

  function activeKeys() {
    try {
      var raw = localStorage.getItem(storeKey());
      var arr = raw ? JSON.parse(raw) : [];
      return Object.prototype.toString.call(arr) === '[object Array]' ? arr : [];
    } catch (e) { return []; }
  }
  function setActiveKeys(arr) {
    try { localStorage.setItem(storeKey(), JSON.stringify(arr || [])); } catch (e) {}
    renderChips();
  }
  function isOn(key) { return activeKeys().indexOf(key) >= 0; }

  /* 弹层一行放不下太多字，超过 30 字就截断 —— 让人看得完比说得全更重要，
     完整解释放 title 里，鼠标停一下还能看到。 */
  function clip(s, n) {
    s = String(s || '');
    n = n || 30;
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  function toneClass(tone) {
    if (tone === 'warn') return 'cap-warn';
    if (tone === 'bad') return 'cap-bad';
    return 'cap-ok';
  }

  /* 把 backends 的 8 个域整理成面板条目。没有后端数据时给一份静态兜底，
     至少不会让面板空着 —— 但描述会明说「还没读到配置」。 */
  function buildItems() {
    var list = [];
    var byKey = {};
    (_domains || []).forEach(function (d) { byKey[d.key] = d; });

    var web = byKey['web_search'] || byKey['web_extract'] || null;
    list.push({
      id: 'web',
      ico: '🌐',
      t: '联网搜索',
      d: web
        ? clip((web.detail && web.detail.search_backend || web.provider || '未配') + ' · 关掉不搜网')
        : '还没读到联网配置',
      tip: web ? '搜索与网页提取都走 ' + (web.detail && web.detail.search_backend || web.provider || '未配') + '；关掉后本轮不去网上搜和抓，其他工具照常用（真拦，不是摆设）' : '',
      tone: web ? toneClass(web.status_tone) : 'cap-bad',
      status: web ? web.status : '未知'
    });

    ['image_gen', 'vision', 'stt', 'tts', 'ocr', 'browser'].forEach(function (key) {
      var d = byKey[key];
      if (!d) return;
      var bits = [];
      if (d.provider) bits.push(d.provider);
      if (d.detail) {
        if (d.detail.model) bits.push(d.detail.model);
        if (d.detail.engine) bits.push('engine ' + d.detail.engine);
        if (d.detail.provider && !d.provider) bits.push(d.detail.provider);
      }
      list.push({
        id: key,
        ico: ({ image_gen: '🎨', vision: '👁', stt: '🎙', tts: '🔊', ocr: '📄', browser: '🧭' })[key],
        t: d.label,
        d: clip(bits.length ? bits.join(' · ') : (d.note || ''), 30),
        tip: d.note || '',
        tone: toneClass(d.status_tone),
        status: d.status
      });
    });

    /* 后端配好了 ≠ 会话里真能用。没装配的必须显式标出来，否则又是一张空头支票。 */
    list.forEach(function (it) {
      var st = toolState(it.id);
      it.toolState = st;
      if (st === 'channel') {
        it.d = clip(it.d + ' · 渠道级', 30);
        it.tone = 'cap-warn';
        it.tip = (it.tip ? it.tip + '；' : '') + '语音转写是渠道级配置（QQ/微信入站消息的 adapter 开关），会话里没有对应工具，在这里勾选不会多出任何能力。';
      } else if (st === 'off') {
        it.d = clip(it.d + ' · 未装配', 30);
        it.tone = 'cap-warn';
        it.tip = (it.tip ? it.tip + '；' : '') + '工具集未启用，会话里用不了：去「模型 → 工具集」勾上 ' + TOOLSET_OF[it.id];
      } else if (st === 'on') {
        it.d = clip(it.d + ' · 已装配', 30);
      }
    });
    return list;
  }

  /* 供 mini-popup 的 buildMiniData 调用 */
  window.capabilityItems = function () {
    return buildItems().map(function (it) {
      var on = it.id === 'web' ? webNetOn() : isOn(it.id);
      return { id: it.id, ico: it.ico, t: it.t, d: it.d, tip: it.tip || '', active: on };
    });
  };

  window.capabilityFoot = function () {
    return _domains ? '管理能力后端（共 ' + (_domains.length) + ' 项）' : '去看看能力后端';
  };

  /* 点一下切换。联网走原来的 _webNetOn（localStorage 'fnos_webnet'），
     和其它能力分开存 —— 它需要给 compose.js 的 system 注入读取。 */
  window.capabilityTap = function (el) {
    if (!el) return;
    var id = el.getAttribute('data-cap');
    if (!id) return;
    if (id === 'web') {
      if (typeof toggleWebNet === 'function') toggleWebNet();
    } else {
      var arr = activeKeys();
      var i = arr.indexOf(id);
      if (i >= 0) arr.splice(i, 1); else arr.push(id);
      setActiveKeys(arr);
    }
    /* 就地翻状态，不整块重绘：重绘会让弹层闪一下、焦点掉走 */
    var on = id === 'web' ? webNetOn() : isOn(id);
    el.classList.toggle('active', on);
    el.setAttribute('aria-pressed', String(on));
    renderChips();
  };

  /* chip 渲染到输入框上方。样式复用 skill-chips，不新造一套。 */
  function renderChips() {
    var host = document.getElementById('capabilityChips');
    if (!host) return;
    var items = buildItems().filter(function (it) {
      return it.id === 'web' ? !webNetOn() : isOn(it.id);
    });
    host.replaceChildren();
    if (!items.length) {
      host.style.display = 'none';
      if (typeof window.__recalcComposerH === 'function') window.__recalcComposerH();
      return;
    }
    host.style.display = 'flex';
    /* 联网关掉时排第一，因为它是唯一真拦人的那条，别让人漏看 */
    items.sort(function (a, b) { return (a.id === 'web' ? -1 : 0) - (b.id === 'web' ? -1 : 0); });
    items.forEach(function (it) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'cap-chip' + (it.id === 'web' ? ' cap-chip-off' : '');
      chip.title = (it.id === 'web' ? '联网搜索已关闭，点击开启' : it.t + '：本轮可用，点击取消');
      chip.textContent = it.ico + ' ' + (it.id === 'web' ? '联网搜索已关' : it.t);
      chip.onclick = function () { window.capabilityTap(chip); };
      chip.setAttribute('data-cap', it.id);
      host.appendChild(chip);
    });
    /* chip 高度要算进消息区留白，否则会压住最后一条气泡里的按钮。
       chip 是绝对定位，撑不动父节点，只能重建完主动叫一次重算。 */
    if (typeof window.__recalcComposerH === 'function') window.__recalcComposerH();
  }

  /* 直接打 /api/panel-models，不依赖 M.api —— M 是模型页的对象，它在脚本末尾
     才挂上 api 方法，而本文件在页面早期就初始化了，那时候 M.api 还不存在，
     拿它去读 backends 必然落空（2026-11-16 第一次实测就是这么只捞到「联网」一项的）。 */
  function postPanel(body) {
    var u = (typeof window.apiUrl === 'function') ? window.apiUrl('/api/panel-models') : '/api/panel-models';
    return fetch(u, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Monitor-Token': window.monitorToken || '' },
      body: JSON.stringify(body),
      cache: 'no-store'
    }).then(function (r) { return r.json(); }).then(function (o) {
      if (!o || !o.ok) throw new Error((o && o.error) || '读取能力后端失败');
      return o;
    });
  }

  /* 拉后端配置。失败不吵人：面板照常能开，只是描述退化成「还没读到配置」。 */
  window.loadCapabilities = function () {
    if (_loading) return;
    _loading = true;
    var jobs = [
      postPanel({ action: 'backends' }).then(function (res) {
        _domains = (res && res.domains) || [];
      }).catch(function () { _domains = null; }),
      postPanel({ action: 'toolsets', platform: 'api_server' }).then(function (res) {
        var map = {};
        ((res && res.toolsets) || []).forEach(function (r) { map[r.name] = !!r.enabled; });
        _toolsets = map;
      }).catch(function () { _toolsets = null; })
    ];
    Promise.all(jobs).then(function () { renderChips(); }).then(function () { _loading = false; });
  };

  /* 每个能力 → 真工具名 + 一句边界说明。
     光写「需要时直接用对应工具」等于没说：模型知道本轮有生图能力，但不知道
     1) 工具到底叫什么，2) 这件事到此为止、不需要再加工。2026-11-16 用户勾了
     图像生成，image_generate 其实调成功了，可 agent 随后又去 tool_search 找
     「run shell command」并借了 Windows 的 PowerShell —— 两个原因叠在一起：
     文案没给工具名，且 api_server 平台没装配 terminal。 */
  var TOOL_OF = {
    web: 'web_search、web_extract',
    image_gen: 'image_generate',
    vision: 'vision_analyze',
    tts: 'text_to_speech',
    ocr: 'ocr 系列',
    browser: 'browser 系列'
  };
  var RULE_OF = {
    image_gen: '要画图就直接调 image_generate，它返回的就是最终图片文件；不需要再用别的工具加工、拼接、导出或截图。',
    vision: '看图、看截图都用 vision_analyze，不要凭文件名或体积猜内容。',
    web: '需要网上信息就调 web_search 或 web_extract，不要凭记忆作答。',
    tts: '要出声就调 text_to_speech，不要用命令行调外部服务。'
  };

  /* 给 compose.js 用：本轮声明了哪些能力 */
  window.capabilityTurnContext = function () {
    var arr = activeKeys();
    if (!arr.length) return '';
    var lines = [];
    buildItems().forEach(function (it) {
      if (arr.indexOf(it.id) < 0) return;
      var name = TOOL_OF[it.id] ? it.t + ' → ' + TOOL_OF[it.id] : it.t;
      var rule = RULE_OF[it.id];
      lines.push('- ' + name + (rule ? '：' + rule : ''));
    });
    if (!lines.length) return '';
    return '本轮可用的本机能力：\n' + lines.join('\n') + '\n这些能力已在后台配好，直接用，不用先问。';
  };

  window.capabilityChipRefresh = renderChips;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { renderChips(); window.loadCapabilities(); });
  } else {
    renderChips();
    window.loadCapabilities();
  }
})();
