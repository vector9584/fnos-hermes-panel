/* 模型页 · 六域工作台 — 骨架（2026-11-15 第二轮：严格对齐参考稿）
 *
 * 参考稿：/vol1/1000/飞牛文件/Code_20261115120611.html（CHATES · 模型）
 * 本文件只管：外壳（两行页签 + content/wrap）、数据加载、域路由、弹层、toast、写操作。
 * 六个域的渲染在 panel-model-v2-pages.js，弹层在 panel-model-v2-sheets.js。
 * 三者通过 window.MV2 共享命名空间，加载顺序由 index.html 的 script 顺序保证。
 *
 * 与第一轮的差别：DOM 结构、类名、组件形态全部改用参考稿那一套
 * （.tabbars/.tabrow/.content/.wrap/.ph/.hero/.qcard/.pcard/.slotbox/.tscard/.panel/.sheet），
 * 样式表见 css/panel-model-ref.css（参考 CSS 原样搬入并限定作用域）。
 */
(function () {
  'use strict';

  /* 每个域的第二行子页签（严格对齐参考稿 DOMS） */
  var DOMAINS = [
    ['home', '概览', []],
    ['select', '模型选择', [['main', '主与辅助'], ['fallback', '回退链'], ['moa', '组合回答']]],
    ['providers', '服务商', [['llm', 'LLM 服务'], ['keys', '密钥'], ['chat', '对话内能力']]],
    ['backends', '能力后端', [['all', '全部域'], ['ds', 'DeepSeek 落点']]],
    ['toolsets', '工具集', []],
    ['config', '配置', [['yaml', 'config.yaml'], ['apply', '生效与写入']]]
  ];

  /* 域 → 一级路由页 id 双向映射（2026-11-15 二改：页内按钮切换改成一页一域） */
  var DOMAIN_PAGE = {
    home: 'models-home', select: 'models-select', providers: 'models-providers',
    backends: 'models-backends', toolsets: 'toolsets', config: 'models-config'
  };
  var PAGE_DOMAIN = {};
  DOMAINS.forEach(function (row) { PAGE_DOMAIN[DOMAIN_PAGE[row[0]]] = row[0]; });
  /* 六个域的根节点缓存，buildShell 里一次性建好，renderDomain 按域填内容 */
  var rootsByDomain = null;
  var loading = false;

  var S = {
    domain: 'home',
    tab: {},
    catalog: null,
    keys: null,
    backends: null,
    toolsets: null,
    preview: null,
    audit: null,
    moa: null,
    aux: null,
    caps: null,
    voice: null,
    loaded: false,
    error: ''
  };

  function url(path) {
    return typeof window.apiUrl === 'function' ? window.apiUrl(path) : path;
  }

  function headers() {
    return { 'Content-Type': 'application/json', 'X-Monitor-Token': window.monitorToken || '' };
  }

  async function post(body) {
    var response = await fetch(url('/api/panel-models'), {
      method: 'POST', headers: headers(), body: JSON.stringify(body), cache: 'no-store'
    });
    var out = await response.json().catch(function () { return {}; });
    if (!response.ok || !out.ok) {
      var error = Error(out.error || '模型配置操作失败');
      error.status = response.status;
      throw error;
    }
    return out;
  }

  function makeGet(path, label) {
    return async function () {
      var response = await fetch(url(path), { method: 'GET', headers: headers(), cache: 'no-store' });
      var out = await response.json().catch(function () { return {}; });
      if (!response.ok || !out.ok) {
        var error = Error(out.error || label + '读取失败');
        error.status = response.status;
        throw error;
      }
      return out;
    };
  }

  function makePatch(path, label) {
    return async function (body) {
      var response = await fetch(url(path), {
        method: 'PATCH', headers: headers(), body: JSON.stringify(body), cache: 'no-store'
      });
      var out = await response.json().catch(function () { return {}; });
      if (!response.ok || !out.ok) {
        var error = Error(out.error || label + '保存失败');
        error.status = response.status;
        throw error;
      }
      return out;
    };
  }

  var auxGet = makeGet('/api/panel-models/auxiliary', '辅助模型');
  var auxPatch = makePatch('/api/panel-models/auxiliary', '辅助模型');
  var voiceGet = makeGet('/api/panel-models/voice', '语音配置');
  var voicePatch = makePatch('/api/panel-models/voice', '语音配置');

  /* ── DOM 小工具（类名沿用参考稿）───────────────────── */
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function btn(text, cls, run) {
    var node = el('button', cls || 'btn', text);
    node.type = 'button';
    if (run) node.onclick = run;
    return node;
  }

  function badge(text, tone) {
    return el('span', 'badge' + (tone ? ' ' + tone : ''), text);
  }

  function chip(text, mono) {
    return el('span', 'chip' + (mono ? ' mono' : ''), text);
  }

  function dot(tone) {
    return el('span', 'dot' + (tone ? ' ' + tone : ''));
  }

  /* div.sec：h3 + 说明 + spacer */
  function sec(title, note) {
    var box = el('div', 'sec');
    if (title) box.append(el('h3', null, title));
    if (note) box.append(el('span', 'n', note));
    box.append(el('span', 'spacer'));
    return box;
  }

  /* div.ph：页面头 h1 + sub + acts */
  function ph(title, sub, acts) {
    var box = el('div', 'ph');
    box.append(el('h1', null, title || ''));
    if (sub) box.append(el('span', 'sub', sub));
    if (acts) {
      var wrap = el('div', 'acts');
      [].concat(acts).forEach(function (a) { if (a) wrap.append(a); });
      box.append(wrap);
    }
    return box;
  }

  function kv(label, value) {
    var row = el('div', 'kv');
    row.append(el('span', null, label));
    var right = el('b');
    if (typeof value === 'string') right.textContent = value;
    else if (value) right.append(value);
    row.append(right);
    return row;
  }

  function panel(title, bodyNodes, headExtra) {
    var box = el('div', 'panel');
    if (title) {
      var head = el('div', 'panel-h');
      head.append(el('h3', null, title));
      if (headExtra) head.append(headExtra);
      box.append(head);
    }
    var body = el('div', 'panel-b');
    [].concat(bodyNodes || []).forEach(function (n) { if (n) body.append(n); });
    box.append(body);
    return box;
  }

  function code(text) {
    var box = el('div', 'code');
    box.textContent = text || '';
    return box;
  }

  function input(value, placeholder, type) {
    var node = el('input', 'input');
    node.type = type || 'text';
    node.value = value == null ? '' : String(value);
    if (placeholder) node.placeholder = placeholder;
    return node;
  }

  function select(options, value) {
    var node = el('select', 'select');
    (options || []).forEach(function (option) {
      var item = Array.isArray(option) ? option : [option, option];
      var opt = el('option', null, item[1] === '' ? '（不指定，自动）' : item[1]);
      opt.value = item[0];
      if (String(item[0]) === String(value)) opt.selected = true;
      node.append(opt);
    });
    return node;
  }

  function field(label, control, hint, required) {
    var box = el('div', 'field');
    var tag = el('label', 'lb', label);
    if (required) tag.append(el('span', 'req', '*'));
    box.append(tag, control);
    if (hint) box.append(el('span', 'fh', hint));
    return box;
  }

  /* 参考稿的步骤条 */
  function steps(labels, current) {
    var box = el('div', 'steps');
    (labels || []).forEach(function (label, index) {
      var sp = el('div', 'sp' + (index === current ? ' on' : '') + (index < current ? ' done' : ''));
      sp.append(el('span', 'n', String(index + 1)));
      sp.append(el('span', null, label));
      box.append(sp);
    });
    return box;
  }

  /* ── 通知：复用站内统一通知条（core/utils.js 的 window.toast / hzToast）。
     老调用全是 toast(title, body, tone) 三参，这里统一转成 hzToast 对象签名：
     右下角 + 类型色板 + 「知道了」按钮，跟面板其它通知完全一致，不再自研 createElement。── */
  function toast(title, body, tone) {
    var T = window.toast || window.__hzToast;
    if (!T) return null;
    var bad = tone === 'bad';
    return T({
      type: bad ? 'error' : 'success',
      title: title || '',
      message: body || '',
      duration: bad ? 6000 : 3000,
      actions: [{ label: '知道了', primary: true, onClick: 'close' }]
    });
  }

  /* ── 弹层：参考稿 overlay > sheet > (sheet-h + sheet-b + sheet-f) ── */
  var sheetNode = null;

  function sheet(options) {
    closeSheet();
    var overlay = el('div', 'overlay');
    var box = el('div', 'sheet' + (options.wide ? ' wide' : ''));

    var head = el('div', 'sheet-h');
    var tt = el('div', 'tt');
    tt.append(el('h3', null, options.title || ''));
    if (options.sub) tt.append(el('div', 'st', options.sub));
    head.append(tt);
    var x = btn('×', 'sheet-x', closeSheet);
    x.setAttribute('aria-label', '关闭');
    head.append(x);

    var body = el('div', 'sheet-b');
    [].concat(options.body || []).forEach(function (n) { if (n) body.append(n); });

    var foot = el('div', 'sheet-f');
    (options.foot || []).forEach(function (item) {
      if (!item) return;
      if (item === 'spacer') { foot.append(el('span', 'spacer')); return; }
      foot.append(item);
    });

    // foot 必须始终进 DOM：providerEdit 等调用方是在 sheet() 返回后
    // 才用 sheet.foot.append() 动态加按钮，若按初始 options.foot 判空，
    // 动态加的按钮永远渲染不出来（这正是「编辑面板没有保存按钮」的根因）。
    box.append(head, body, foot);
    overlay.append(box);
    overlay.onclick = function (event) { if (event.target === overlay) closeSheet(); };
    (document.querySelector('.models-page.active') || document.body).append(overlay);
    sheetNode = overlay;

    var first = body.querySelector('input,select,textarea,button');
    if (first) setTimeout(function () { try { first.focus(); } catch (_) {} }, 60);
    return { overlay: overlay, box: box, body: body, foot: foot, close: closeSheet };
  }

  function closeSheet() {
    if (sheetNode && sheetNode.parentNode) sheetNode.parentNode.removeChild(sheetNode);
    sheetNode = null;
  }

  function sheetOpen() { return !!sheetNode; }

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && sheetNode) closeSheet();
  });

  /* ── 写操作 ─────────────────────────────────────────── */
  function pending() {
    try { window.panelRuntimeRefresh?.(); } catch (_) {}
  }

  /* 每种写动作对应哪一份 revision */
  function revisionFor(action) {
    if (action === 'moa_save') return (S.moa || {}).moa_revision || '';
    if (action === 'save_backend') return (S.backends || {}).revision || '';
    if (action === 'save_toolsets') return (S.toolsets || {}).revision || '';
    return (S.catalog || {}).revision || '';
  }

  async function mutate(body, options) {
    options = options || {};
    var attempt = 0;
    while (attempt < 2) {
      try {
        var out = await post(body);
        if (out.changed === false) toast(options.unchanged || '没有变化', '配置与提交内容一致，未写入');
        else toast(options.done || '已保存', options.body || '下一条消息起生效，不用重启');
        if (out.changed !== false) pending();
        await load(options.reload || null);
        render();
        return out;
      } catch (error) {
        // 409 有两种：revision 冲突（配置在别处改过）→ 自动重试一次；
        // 业务校验（如「此服务仍用于回退路线」）→ 直接展示后端原因，不能误报成版本冲突。
        var revisionConflict = error.status === 409 && /已被其他页面修改/.test(error.message || '');
        if (revisionConflict && attempt === 0) {
          attempt++;
          await load();
          body = Object.assign({}, body, { revision: revisionFor(body.action) });
          toast('配置刚在别处变过', '已用最新版本重试一次');
          continue;
        }
        if (error.status === 409) {
          toast('未保存', error.message, 'bad');
          await load();
          render();
          return null;
        }
        toast('保存失败', error.message, 'bad');
        throw error;
      }
    }
    return null;
  }

  async function auxMutate(body, options) {
    options = options || {};
    try {
      var out = await auxPatch(body);
      toast(options.done || '已保存', options.body || '辅助模型配置已写入 config.yaml');
      pending();
      S.aux = await auxGet();
      await load(['catalog']);
      render();
      return out;
    } catch (error) {
      if (error.status === 409) {
        toast('辅助模型刚在别处改过', '已刷新，请重试', 'bad');
        S.aux = await auxGet();
        render();
        return null;
      }
      toast('保存失败', error.message, 'bad');
      throw error;
    }
  }

  async function voiceMutate(body, options) {
    options = options || {};
    try {
      var out = await voicePatch(body);
      toast(options.done || '已保存', options.body || '语音配置已写入 config.yaml');
      pending();
      S.voice = await voiceGet();
      await load(['catalog', 'backends']);
      render();
      return out;
    } catch (error) {
      if (error.status === 409) {
        toast('语音配置刚在别处改过', '已刷新，请重试', 'bad');
        S.voice = await voiceGet();
        render();
        return null;
      }
      toast('保存失败', error.message, 'bad');
      throw error;
    }
  }

  /* ── 数据加载 ───────────────────────────────────────── */
  async function load(parts) {
    var want = function (name) { return !parts || parts.indexOf(name) >= 0; };
    var jobs = [];
    if (want('catalog')) jobs.push(post({ action: 'read' }).then(function (out) { S.catalog = out; }));
    if (want('aux')) jobs.push(auxGet().then(function (out) { S.aux = out; }).catch(function () { S.aux = S.aux || { tasks: [], services: [] }; }));
    if (want('moa')) jobs.push(post({ action: 'moa_read' }).then(function (out) { S.moa = out; }).catch(function () { S.moa = S.moa || null; }));
    if (want('keys')) jobs.push(post({ action: 'keys' }).then(function (out) { S.keys = out; }).catch(function () { S.keys = S.keys || { keys: [] }; }));
    if (want('backends')) jobs.push(post({ action: 'backends' }).then(function (out) { S.backends = out; }).catch(function () { S.backends = S.backends || { domains: [] }; }));
    if (want('toolsets')) jobs.push(post({ action: 'toolsets' }).then(function (out) { S.toolsets = out; }).catch(function () { S.toolsets = S.toolsets || { toolsets: [] }; }));
    if (want('preview')) jobs.push(post({ action: 'config_preview' }).then(function (out) { S.preview = out; }).catch(function () { S.preview = S.preview || null; }));
    if (want('audit')) jobs.push(post({ action: 'audit' }).then(function (out) { S.audit = out; }).catch(function () { S.audit = S.audit || { snapshots: [] }; }));
    if (want('caps')) jobs.push(post({ action: 'cap_matrix' }).then(function (out) { S.caps = out; }).catch(function () { S.caps = S.caps || null; }));
    if (want('voice')) jobs.push(voiceGet().then(function (out) { S.voice = out; }).catch(function () { S.voice = S.voice || null; }));
    var results = await Promise.allSettled(jobs);
    var failed = results.filter(function (row) { return row.status === 'rejected'; });
    S.loaded = true;
    S.error = failed.length ? '部分数据读取失败（' + failed.length + ' 项），可点右上角刷新重试' : '';
    return S;
  }

  /* ── 路由与渲染 ─────────────────────────────────────── */
  function go(domain, tab) {
    if (domain) S.domain = domain;
    if (tab) S.tab[domain] = tab;
    closeSheet();
    /* 域切换 = 一级路由切换，交给面板原生 switchPage，再重渲染目标域 */
    try { window.switchPage(DOMAIN_PAGE[domain] || 'models-home'); } catch (_) {}
    renderDomain(domain);
  }

  function subTabsOf(domain) {
    var row = DOMAINS.filter(function (r) { return r[0] === domain; })[0];
    return (row && row[2]) || [];
  }

  function makeRefreshBtn() {
    return btn('刷新', 'btn sm', async function () {
      S.loaded = false;
      render();
      try { await load(); toast('已刷新', '配置已从 config.yaml 重新读取'); } catch (error) { toast('刷新失败', error.message, 'bad'); }
      render();
    });
  }

  /* 渲染单个域到它自己的 #page-models-* 的 .mv2-root；能力后端的子页签
     （全部域 / DeepSeek 落点）作为该域根节点顶部的 second 页签行渲染。 */
  function renderDomain(domain) {
    var root = rootsByDomain && rootsByDomain[domain];
    if (!root) return;
    root.replaceChildren();
    if (!S.loaded) {
      root.append(el('div', 'empty', '正在读取 config.yaml…'));
      return;
    }
    if (S.error) root.append(el('div', 'empty', S.error));
    var subItems = subTabsOf(domain);
    if (subItems.length) {
      var bar = el('div', 'tabrow second');
      var current = S.tab[domain] || subItems[0][0];
      if (!subItems.some(function (i) { return i[0] === current; })) current = subItems[0][0];
      S.tab[domain] = current;
      subItems.forEach(function (item) {
        var tab = btn(item[1], '', function () { go(domain, item[0]); });
        tab.classList.toggle('on', item[0] === current);
        bar.append(tab);
      });
      root.append(bar);
    }
    var page = (window.MV2 && MV2.pages && MV2.pages[domain]) || null;
    if (!page) {
      root.append(el('div', 'empty', '这个域还没有渲染器'));
      return;
    }
    try {
      root.append(page(S));
    } catch (error) {
      root.append(el('div', 'empty', '渲染失败：' + (error && error.message ? error.message : String(error))));
      if (window.console) console.error(error);
    }
  }

  function render() {
    buildShell();
    DOMAINS.forEach(function (row) { renderDomain(row[0]); });
  }

  /* ── 外壳 ───────────────────────────────────────────── */
  function buildShell() {
    var roots = {};
    DOMAINS.forEach(function (row) {
      var domain = row[0];
      var host = document.getElementById('page-' + DOMAIN_PAGE[domain]);
      if (!host) return;
      var body = host.querySelector('.page-body') || host;
      var root = body.querySelector('.mv2-root');
      if (!root) { root = el('div', 'mv2-root'); root.dataset.domain = domain; body.replaceChildren(root); }
      roots[domain] = root;
      var acts = host.querySelector('.page-header .mv2-acts');
      if (acts && !acts.children.length) acts.append(makeRefreshBtn());
    });
    if (DOMAINS.some(function (row) { return !roots[row[0]]; })) return false;
    rootsByDomain = roots;
    return true;
  }

  var booted = false;

  async function boot(force) {
    if (!buildShell()) return;
    /* 已加载且未过期 → 只重渲染不重拉；首次或 >60s 或 force → 重拉 config.yaml */
    var stale = !booted || (Date.now() - (window.__mv2LoadedAt || 0) > 60000);
    if (booted && !force && !stale) { render(); return; }
    if (loading) return;  /* 已经在拉，别叠第二个 */
    loading = true;
    window.__mv2LoadedAt = Date.now();
    render();
    try { await load(); } catch (error) { S.error = error.message; }
    booted = true;
    loading = false;
    render();
  }

  /* 自动启动：面板切到任意模型页（models-home ~ models-config）时才 boot。
     直接包 switchPage 最稳——首次加载时六个 #page-models-* 可能还没被别处重建。 */
  function autostart() {
    /* 让出一次宏任务：pages.js / sheets.js 是后面的 <script>，本文件执行时
       MV2.pages 还是空的，直接 boot 会渲染出「这个域还没有渲染器」。 */
    setTimeout(function () {
      boot().catch(function (error) { if (window.console) console.error('[MV2]', error); });
    }, 0);
    var orig = window.switchPage;
    if (typeof orig === 'function' && !orig.__mv2Wrapped) {
      var wrapped = function (name) {
        var out = orig.apply(this, arguments);
        if (name === 'models' || /^models-/.test(name) || name === 'toolsets') {
          setTimeout(function () {
            boot().catch(function (error) { if (window.console) console.error('[MV2]', error); });
          }, 0);
        }
        return out;
      };
      wrapped.__mv2Wrapped = true;
      window.switchPage = wrapped;
    }
  }

  window.MV2 = {
    S: S, DOMAINS: DOMAINS,
    api: post, auxGet: auxGet, auxPatch: auxPatch, voiceGet: voiceGet, voicePatch: voicePatch,
    el: el, btn: btn, badge: badge, chip: chip, dot: dot, sec: sec, ph: ph, kv: kv, panel: panel,
    code: code, field: field, input: input, select: select, steps: steps,
    toast: toast, sheet: sheet, closeSheet: closeSheet, sheetOpen: sheetOpen,
    load: load, render: render, go: go, mutate: mutate, auxMutate: auxMutate, voiceMutate: voiceMutate,
    pending: pending, boot: boot,
    pages: {}, sheets: {}
  };

  window.renderProviders = function () { boot().catch(function () {}); };

  /* 自动启动放在 MV2 挂载之后：boot 里 render() 要读 window.MV2.pages。 */
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autostart);
  else autostart();
})();
