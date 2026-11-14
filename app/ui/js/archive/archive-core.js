/* 档案 · 三页统一外壳（2026-11-14）
 *
 * 替换旧的 panel-library-ui.js + panels/assistant.js 两套渲染。三个页面
 * （提示词 / 知识库 / 留痕录）共用这一个外壳，差异全在 PAGES 配置里：
 * 接哪几个资料来源、有哪几个视图、默认打开哪份文档。
 *
 * 分工（每个模块自己一个文件，别再往这里堆）：
 *   archive-core.js        外壳 / 状态 / API / 快捷键 / 视图调度
 *   archive-tree.js        左侧资料树
 *   archive-search.js      ⌘K 搜索面板
 *   archive-md.js          markdown 渲染 + 目录大纲
 *   archive-doc.js         文档视图：阅读 / 编辑 / 草稿 / 冲突 / 修改记录
 *   archive-graph.js       关系图（知识库与技能共用同一套力导向引擎）
 *   archive-trajectory.js  留痕录：技能使用统计与运行轨迹
 *   archive-vault.js       密码本：二级口令 + 查看 + 编辑
 */
window.Archive = (function () {
  'use strict';

  var PAGES = {
    assistant: {
      id: 'assistant', title: '提示词', sub: '改这里 = 改它是什么',
      note: '人格、记忆、指令、技能，都是每轮直接喂给它的东西。保存后按各自的生效时机加载。',
      sources: ['soul', 'memory', 'agents', 'skills'],
      /* 2026-11-14 用户要求：提示词下面挂「文档 / 架构体系」两个按钮，
         架构体系放他给的那张《Hermes 的文件即思维》全图。 */
      views: [['doc', '文档'], ['arch', '架构体系']],
      home: { source: 'soul', path: 'SOUL.md' }
    },
    kb: {
      id: 'kb', title: '知识库', sub: '改这里 ≠ 它就会知道',
      note: '知识库要它主动去翻才生效；共享笔记既不注入也不索引。想让它记住，得写进记忆。',
      sources: ['knowledge', 'notes'],
      /* 知识库页签只有「文档 / 知识图谱」两个（2026-11-14 用户对照案例驳回）：
         密码本不是页签，是左栏底部的独立入口（specials），点进去是一级口令锁卡。 */
      views: [['doc', '文档'], ['graph', '知识图谱']],
      specials: [{ view: 'vault', label: '密码本', icon: 'lock' }],
      home: { source: 'notes', path: 'notes.md' },
      createSource: 'knowledge'
    },
    memory: {
      id: 'memory', title: '留痕录', sub: '它做过什么，只读',
      note: '运行日记、整理草稿、维护报告都只读；技能轨迹统计来自真实的技能调用记录。',
      sources: ['daily', 'organize', 'curator'],
      views: [['doc', '文档'], ['trajectory', '技能轨迹']],
      home: null
    }
  };

  var states = {};
  var modules = {};
  var mounted = {};
  var keysBound = false;
  /* 三个页面读的是同一份 catalog（一次接口就返回全部来源），所以缓存提到模块级：
     否则每页各发一次 limit=5000 的扫描，服务端要把 knowledge + 357 个 SKILL.md 扫三遍。 */
  var catalogCache = { data: null, at: 0, pending: null };

  /* ── 两套分类色（案例 DARK_COLORS / LIGHT_COLORS 全量对齐，2026-11-14）──
     深色用亮青系、浅色用靛蓝系，跟着 body.theme-dark 翻转——这不是装饰，是案例专门做的两套配色。
     catColor(name) 先按分类名查表；查不到（比如知识库顶层目录是任意名）就按名字哈希落到 10 色盘，
     保证同名恒同色，不会因为排序变了颜色就跳。 */
  var DARK_COLORS = {
    '创作': '#71dbc0', '分析': '#7aa7f7', '检索': '#b98ae8', '开发': '#e8b268', '效率': '#e7859b',
    '分类': '#71dbc0', '笔记': '#71dbc0',
    '对话沉淀': '#71dbc0', '概念': '#7aa7f7', '技能使用': '#b98ae8', '技术': '#e8b268',
    '家人': '#e7859b', '生活': '#8fd36c', '系统': '#6fc9d6', '项目': '#d9a1e8', '协作': '#f0a878', '学业': '#9aa8f0'
  };
  var LIGHT_COLORS = {
    '创作': '#5e64f3', '分析': '#2f6fd0', '检索': '#8b4fc0', '开发': '#c07a1e', '效率': '#c25170',
    '分类': '#5e64f3', '笔记': '#5e64f3',
    '对话沉淀': '#2f6fd0', '概念': '#8b4fc0', '技能使用': '#c07a1e', '技术': '#c25170',
    '家人': '#4a9a2e', '生活': '#1f8e9e', '系统': '#9a55b8', '项目': '#d1732a', '协作': '#5a68c0', '学业': '#2f8f76'
  };
  var DARK_PALETTE = ['#71dbc0', '#7aa7f7', '#b98ae8', '#e8b268', '#e7859b', '#8fd36c', '#6fc9d6', '#d9a1e8', '#f0a878', '#9aa8f0'];
  var LIGHT_PALETTE = ['#5e64f3', '#2f6fd0', '#8b4fc0', '#c07a1e', '#c25170', '#4a9a2e', '#1f8e9e', '#9a55b8', '#d1732a', '#5a68c0'];
  function isLight() { return !document.body.classList.contains('theme-dark'); }
  function catColor(name) {
    var key = String(name == null ? '' : name);
    var table = isLight() ? LIGHT_COLORS : DARK_COLORS;
    if (Object.prototype.hasOwnProperty.call(table, key)) return table[key];
    var pal = isLight() ? LIGHT_PALETTE : DARK_PALETTE;
    var h = 0, i;
    for (i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
    return pal[h % pal.length];
  }
  function colorOf(index) {
    var pal = isLight() ? LIGHT_PALETTE : DARK_PALETTE;
    var i = (Number(index) || 0) % pal.length;
    return pal[i < 0 ? i + pal.length : i];
  }

  function el(tag, text, cls) {
    var node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (cls) node.className = cls;
    return node;
  }
  /* 图标一律内联 SVG，不用 emoji。原因（2026-11-14 用户驳回）：
     emoji 走的是客户端字体，同一份代码在 macOS 上是彩色、在缺 Noto Color Emoji 的机器上
     就是豆腐块或单色小点，用户看到的就是「很多图标都不见了」。SVG 用 currentColor，
     字体换什么都不会变，也能跟着主题变色。
     name 支持 d 传数组（多条 path 叠一个图标），size 默认 15，小尺寸自动加粗描边。 */
  function svgIcon(name, size) {
    var icons = {
      search: { d: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M16.2 16.2 21 21'] },
      menu: { d: ['M4 7h16', 'M4 12h16', 'M4 17h16'] },
      plus: { d: ['M12 5v14', 'M5 12h14'] },
      down: { d: ['M12 4v11', 'M7 11l5 5 5-5', 'M5 20h14'] },
      copy: { d: ['M9 9h10v10H9z', 'M15 9V5H5v10h4'] },
      history: { d: ['M12 8v5l3 2', 'M3.5 12a8.5 8.5 0 1 0 2.6-6.1', 'M3 4v4h4'] },
      tree: { d: ['M4 5h6', 'M4 12h6', 'M4 19h6', 'M14 5h6', 'M14 12h6'] },
      refresh: { d: ['M20 12a8 8 0 1 1-2.34-5.66', 'M20 4v4h-4'] },
      edit: { d: ['M4 20h4L20 8l-4-4L4 16v4z'] },
      save: { d: ['M5 4h11l3 3v13H5z', 'M8 4v6h8V4', 'M8 15h8'] },
      back: { d: ['M15 5l-7 7 7 7'] },
      lock: { d: ['M6 11h12v9H6z', 'M9 11V8a3 3 0 0 1 6 0v3'] },
      /* 树：文件夹闭合 / 展开 / 文件 / 折叠箭头 */
      folder: { d: ['M3 8a2 2 0 0 1 2-2h3.4l1.8 2H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'] },
      folderOpen: { d: ['M3 10V8a2 2 0 0 1 2-2h3.4l1.8 2H19a2 2 0 0 1 2 2v1',
                        'M3 10h18l-2.1 7.4A2 2 0 0 1 17 19H5.1a2 2 0 0 1-2-1.7z'] },
      file: { d: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5'] },
      chevron: { d: ['M9.5 6.5 15 12l-5.5 5.5'] },
      info: { d: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 11v5.4', 'M12 7.6h.01'] },
      tag: { d: ['M3 12.4V4h8.4L21 13.6 12.6 22z', 'M7.2 7.2h.01'] },
      link: { d: ['M10.5 13.5a4 4 0 0 0 5.66 0l2.83-2.83a4 4 0 0 0-5.66-5.66L11.5 6.8', 'M13.5 10.5a4 4 0 0 0-5.66 0L5.01 13.3a4 4 0 0 0 5.66 5.66l1.83-1.83'] },
      alert: { d: ['M12 4.5 2.8 20h18.4z', 'M12 10v4.2', 'M12 17.3h.01'] }
    };
    var def = icons[name] || { d: [] };
    var list = Array.isArray(def.d) ? def.d : [def.d];
    var px = size || 15;
    var ns = 'http://www.w3.org/2000/svg';
    var s = document.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', String(px)); s.setAttribute('height', String(px));
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', px <= 14 ? '1.8' : '1.7');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true');
    s.classList.add('arc-svg');
    list.forEach(function (d) {
      var p = document.createElementNS(ns, 'path');
      p.setAttribute('d', d);
      s.append(p);
    });
    return s;
  }

  /* ── 网络：统一带 token，密码本额外带解锁票据 ── */
  function call(path, options) {
    var opts = options || {};
    return Promise.resolve(monitorToken ? null : fetchToken()).then(function () {
      var headers = { 'Content-Type': 'application/json' };
      if (monitorToken) headers['X-Monitor-Token'] = monitorToken;
      if (opts.ticket) headers['X-Vault-Ticket'] = opts.ticket;
      /* 二级授权：只对「刚看过明文的那一个键」有效，5 分钟。写操作必须带它。 */
      if (opts.grant) headers['X-Vault-Grant'] = opts.grant;
      return fetch(apiUrl(path), {
        method: opts.method || 'GET', headers: headers, cache: 'no-store',
        body: opts.body ? JSON.stringify(opts.body) : undefined
      });
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok || data.ok === false) {
          var err = new Error(data.error || ('HTTP ' + res.status));
          err.status = res.status; err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  function stateOf(pageId) {
    if (states[pageId]) return states[pageId];
    var st = {
      page: pageId, cfg: PAGES[pageId], catalog: null, loadedAt: 0,
      loading: false, error: '', q: '', remoteHits: null,
      view: 'doc', doc: null, history: [], ticket: '', vault: null,
      folded: readFold(pageId), nodes: {}
    };
    states[pageId] = st;
    return st;
  }
  function readFold(pageId) {
    try { return JSON.parse(localStorage.getItem('archive-fold:' + pageId) || '{}') || {}; }
    catch (_) { return {}; }
  }
  function writeFold(st) {
    try { localStorage.setItem('archive-fold:' + st.page, JSON.stringify(st.folded)); } catch (_) {}
  }
  function readView(pageId) {
    try { return localStorage.getItem('archive-view:' + pageId) || ''; } catch (_) { return ''; }
  }
  function writeView(st) {
    try { localStorage.setItem('archive-view:' + st.page, st.view); } catch (_) {}
  }

  /* ── 资料行：按本页声明的 sources 过滤 + 本地搜索 ── */
  function rowsOf(st) {
    var items = (st.catalog && st.catalog.items) || [];
    var allowed = st.cfg.sources;
    var rows = items.filter(function (item) { return allowed.indexOf(item.source) >= 0; });
    if (st.remoteHits) rows = st.remoteHits.filter(function (item) { return allowed.indexOf(item.source) >= 0; });
    var q = st.q.trim().toLowerCase();
    if (q && !st.remoteHits) {
      rows = rows.filter(function (item) {
        return (item.title || '').toLowerCase().indexOf(q) >= 0 || (item.path || '').toLowerCase().indexOf(q) >= 0;
      });
    }
    return rows;
  }
  function sourceOf(st, id) {
    var list = (st.catalog && st.catalog.sources) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function loadCatalog(pageId, force) {
    var st = stateOf(pageId);
    if (catalogCache.data && !force && Date.now() - catalogCache.at < 60000) {
      st.catalog = catalogCache.data; st.loadedAt = catalogCache.at;
      return Promise.resolve();
    }
    if (catalogCache.pending) {
      return catalogCache.pending.then(function () {
        if (catalogCache.data) { st.catalog = catalogCache.data; st.loadedAt = catalogCache.at; render(st); }
      });
    }
    st.loading = true; st.error = '';
    /* 首屏目录也要防闪：真慢过 320ms 才把状态行挂出来 */
    var slowTimer = setTimeout(function () { if (st.loading) paintStatus(st, '正在读取资料…'); }, 320);
    catalogCache.pending = call('/api/panel-library?limit=5000').then(function (data) {
      catalogCache.data = data; catalogCache.at = Date.now();
      Object.keys(states).forEach(function (id) {
        states[id].catalog = data; states[id].loadedAt = catalogCache.at;
      });
    }).catch(function (err) {
      st.error = err.message;
    }).then(function () {
      clearTimeout(slowTimer);
      catalogCache.pending = null;
      Object.keys(states).forEach(function (id) {
        var each = states[id];
        each.loading = false;
        if (each.error) paintStatus(each, '读取失败：' + each.error, 'err');
        else paintStatus(each, '');
        if (!each.nodes.shell) return;
        render(each);
        if (!each.doc && !each.error) openDefault(each);
      });
    });
    return catalogCache.pending;
  }

  /* ── 外壳 ── */
  function mount(pageId) {
    var cfg = PAGES[pageId];
    var page = document.getElementById('page-' + pageId);
    if (!cfg || !page) return;
    var st = stateOf(pageId);
    if (mounted[pageId]) { render(st); return; }
    mounted[pageId] = true;

    page.classList.add('arc-page');
    page.replaceChildren();

    /* 页头一行放三样：标题 / 视图页签 / 工具（照案例 toolbar 的构成，不再把页签单独占一行） */
    var head = el('div', null, 'page-header arc-head');
    var titleWrap = el('div', null, 'arc-title');
    titleWrap.append(el('h1', cfg.title), el('span', cfg.sub, 'arc-sub'));

    /* 页签名只在两个以上视图时才出现：只有一个视图的页面（提示词）挂一排
       只有一个按钮的分段控件，纯属占地方（2026-11-14 用户要求去掉）。 */
    var views = null;
    if (cfg.views.length > 1) {
      views = el('div', null, 'arc-views');
      cfg.views.forEach(function (pair) {
        var b = el('button', pair[1], 'arc-view-btn');
        b.dataset.view = pair[0];
        b.onclick = function () { setView(st, pair[0]); };
        views.append(b);
      });
    } else {
      head.classList.add('arc-no-views');
    }

    /* 工具条搜索框：回车/点「搜索」进正文检索（案例的 search-wrap） */
    var box = el('div', null, 'arc-searchbox');
    box.append(svgIcon('search'));
    var sInput = document.createElement('input');
    sInput.type = 'search';
    sInput.placeholder = '搜索标题与正文';
    sInput.setAttribute('aria-label', '搜索标题与正文');
    sInput.onkeydown = function (ev) {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      if (modules.search) modules.search.open(st, sInput.value, box);
    };
    /* 案例里点搜索框就地出结果，不用先点按钮 */
    sInput.onfocus = function () { if (modules.search) modules.search.open(st, sInput.value, box); };
    var goBtn = el('button', '搜索', 'arc-search-go');
    goBtn.onclick = function () { if (modules.search) modules.search.open(st, sInput.value, box); };
    box.append(sInput, el('span', '⌘K', 'arc-kbd'), goBtn);
    st.searchAnchor = box;

    var tools = el('div', null, 'arc-tools');
    if (cfg.createSource) {
      /* 案例的新增笔记是 primary 实心按钮，紧挨着视图页签（不是角落里的图标钮） */
      var newBtn = el('button', null, 'arc-btn is-primary');
      newBtn.append(svgIcon('plus', 14), el('span', '新增笔记', 'arc-label'));
      newBtn.title = '新建资料';
      newBtn.dataset.arc = 'new';
      newBtn.onclick = function () { askNew(st); };
      tools.append(newBtn);
    }
    /* 目录开关单独一个节点，不塞进 tools：手机上它要排在搜索框左边 */
    var railBtn = el('button', null, 'arc-icon-btn arc-rail-toggle');
    railBtn.append(svgIcon('menu'), el('span', '目录', 'arc-label'));
    railBtn.title = '展开/收起资料目录';
    railBtn.dataset.arc = 'rail';

    /* 顺序对齐案例 toolbar：标题 → 视图页签 → 新增笔记 → 目录 → 搜索框（margin-left:auto 居右） */
    head.append(titleWrap);
    if (views) head.append(views);
    head.append(tools, railBtn, box);

    var shell = el('div', null, 'arc-shell');
    var rail = el('aside', null, 'arc-rail');
    rail.setAttribute('aria-label', '资料来源');
    var main = el('section', null, 'arc-main');
    /* 遮罩放进 shell 里：手机上它只该盖住文档区，不能连页头一起盖（先前是 fixed inset:0，整页发黑） */
    var scrim = el('div', null, 'arc-scrim');
    scrim.onclick = function () { shell.classList.remove('rail-open'); };
    shell.append(rail, scrim, main);

    /* 页面底部状态条（案例 statusbar）：左来源 / 中路径 / 右生效状态 */
    var footbar = el('div', null, 'arc-footbar');
    var fbLeft = el('span', '', 'arc-fb');
    var fbMid = el('span', '', 'arc-fb-grow arc-fb-mono');
    var fbRight = el('span', '', 'arc-fb');
    footbar.append(fbLeft, fbMid, fbRight);

    st.nodes = {
      head: head, views: views, shell: shell, rail: rail, main: main, scrim: scrim,
      status: el('p', '', 'arc-status'), foot: { left: fbLeft, mid: fbMid, right: fbRight }
    };

    page.append(head, st.nodes.status, shell, footbar);

    railBtn.onclick = function () { shell.classList.toggle('rail-open'); };

    var saved = readView(pageId);
    if (saved && cfg.views.some(function (v) { return v[0] === saved; })) st.view = saved;
    bindKeys();
    render(st);
    loadCatalog(pageId);
  }

  function paintStatus(st, text, kind) {
    var node = st.nodes.status;
    if (!node) return;
    node.textContent = text || '';
    node.className = 'arc-status' + (kind ? ' is-' + kind : '');
    node.hidden = !text;
  }

  /* 页面底部状态条：{left, mid, right}，传空串即清空 */
  function foot(st, parts) {
    var box = st.nodes && st.nodes.foot;
    if (!box) return;
    box.left.textContent = (parts && parts.left) || '';
    box.mid.textContent = (parts && parts.mid) || '';
    box.right.textContent = (parts && parts.right) || '';
  }

  /* 新建资料：面板内对话框（不弹 window.prompt），路径留空就只提示不建 */
  function askNew(st) {
    if (!st.cfg.createSource) { toast('这个栏目不支持新建', 'warn'); return; }
    var dialog = document.createElement('dialog');
    dialog.className = 'arc-dialog arc-dialog-narrow';
    var head = el('div', null, 'arc-dialog-head');
    head.append(el('h3', '新建资料'));
    var close = el('button', '×', 'arc-icon-btn');
    close.setAttribute('aria-label', '关闭');
    close.onclick = function () { dialog.close(); };
    head.append(close);

    var form = el('form', null, 'arc-pass-form');
    var tip = el('p', '路径相对资料来源根目录，例如 项目/新想法.md —— 不写 .md 会自动补。', 'arc-dim');
    var input = document.createElement('input');
    input.className = 'arc-vault-input';
    input.placeholder = '项目/新想法.md';
    input.setAttribute('aria-label', '新资料路径');
    var feedback = el('p', '', 'arc-pass-feedback');
    var acts = el('div', null, 'arc-dialog-actions');
    var cancel = el('button', '取消', 'arc-btn');
    cancel.type = 'button';
    cancel.onclick = function () { dialog.close(); };
    var ok = el('button', '创建', 'arc-btn is-primary');
    ok.type = 'submit';
    acts.append(cancel, ok);
    form.append(tip, input, feedback, acts);
    form.onsubmit = function (ev) {
      ev.preventDefault();
      var path = String(input.value || '').trim();
      if (!path) { feedback.textContent = '路径不能为空'; input.focus(); return; }
      dialog.close();
      openNew(st, path);
    };
    dialog.append(head, form);
    document.body.append(dialog);
    dialog.addEventListener('close', function () { dialog.remove(); });
    dialog.showModal();
    input.focus();
  }

  function render(st) {
    if (!st.nodes.shell) return;
    /* 特殊入口（密码本）不是页签：开着它的时候，页签仍停在「文档」上——
       案例就是这个行为，否则用户会看到两个按钮全灭，像点了没反应。 */
    var navView = isSpecial(st, st.view) ? 'doc' : st.view;
    if (st.nodes.views) {
      st.nodes.views.querySelectorAll('.arc-view-btn').forEach(function (b) {
        b.classList.toggle('on', b.dataset.view === navView);
      });
    }
    if (modules.tree) modules.tree.render(st, st.nodes.rail, openDoc);
    renderView(st);
  }

  /* 左栏底部的非文档入口（目前只有密码本）。配置在 PAGES[*].specials 里，
     页签不建按钮、但 setView 必须放行，否则点了没反应。 */
  function isSpecial(st, view) {
    var cfg = PAGES[st.id] || {};
    var list = cfg.specials || [];
    for (var i = 0; i < list.length; i++) if (list[i].view === view) return list[i];
    return null;
  }

  function renderView(st) {
    var host = st.nodes.main;
    if (!host) return;
    /* 右目录是挂在 body 上的 fixed 元素，换视图/换文档时必须自己收走，否则会浮在关系图上 */
    var stale = document.querySelector('.arc-outline');
    if (stale) stale.remove();
    var view = modules[st.view];
    /* 上一个视图必须收摊：关系图和技能轨迹图起的都是 Worker + rAF，切走之后没人叫停，
       物理模拟会一直跑、主线程被占满，下一个视图的 fetch 回调排不上队
       （2026-11-14 实测：从技能轨迹图切到知识库关系图，canvas 二十秒不出来，
       后端 /api/panel-library/graph 其实 0.18s 就返回了）。 */
    if (st.mounted && st.mounted !== view && st.mounted.unmount) {
      try { st.mounted.unmount(st); } catch (_) {}
    }
    st.mounted = view || null;
    host.replaceChildren();
    if (!view) { host.append(el('p', '这个视图还没加载。', 'arc-empty')); return; }
    Promise.resolve(view.render(st, host, apiBag(st))).catch(function (err) {
      host.replaceChildren(el('p', '渲染失败：' + err.message, 'arc-empty'));
    });
  }

  function setView(st, view) {
    if (st.view === view) return;
    if (modules.doc && modules.doc.beforeLeave) modules.doc.beforeLeave(st);
    st.view = view; writeView(st);
    /* 手机端切了视图就把抽屉收回去，否则图还没看到先挡着半个屏（案例 switchTab 同款） */
    if (st.nodes.shell) st.nodes.shell.classList.remove('rail-open');
    /* 2026-11-14：原来这里只换主区内容，页签的 .on 类留在旧按钮上——
       点了「技能轨迹」图都画出来了，高亮还停在「文档」，看着像点了没反应。
       视图切换必须同时同步页签状态。 */
    var navView = isSpecial(st, view) ? 'doc' : view;
    if (st.nodes.views) {
      st.nodes.views.querySelectorAll('.arc-view-btn').forEach(function (b) {
        b.classList.toggle('on', b.dataset.view === navView);
      });
    }
    /* 左栏也要跟着变：特殊的密码本入口有选中态、文档行要取消高亮，
       不重绘树的话点了密码本，左栏还亮着「notes.md」，看着像没点动。 */
    if (modules.tree) modules.tree.render(st, st.nodes.rail, openDoc);
    renderView(st);
  }

  function apiBag(st) {
    return {
      call: call,
      open: function (source, path) { return openDoc(st, source, path); },
      setView: function (v) { setView(st, v); },
      rerender: function () { renderView(st); },
      toast: toast,
      ticket: function () { return st.ticket; },
      setTicket: function (t) { st.ticket = t || ''; },
      /* 左栏重绘：密码本拿到条目数之后要更新左侧入口的数字 */
      rail: function () { if (modules.tree) modules.tree.render(st, st.nodes.rail, openDoc); }
    };
  }

  function openDoc(st, source, path) {
    if (modules.doc && modules.doc.beforeLeave) modules.doc.beforeLeave(st);
    if (st.view !== 'doc') { st.view = 'doc'; writeView(st); render(st); }
    elsActive(st, source, path);
    return loadDoc(st, source, path);
  }

  function elsActive(st, source, path) {
    if (!st.nodes.rail) return;
    st.nodes.rail.querySelectorAll('[data-path]').forEach(function (b) {
      b.classList.toggle('on', b.dataset.source === source && b.dataset.path === path);
    });
  }

  function loadDoc(st, source, path, force) {
    /* 本地读文件通常几十毫秒：快就一点都不提示，超过 320ms 才在右下角出「正在打开」，
       拿到结果自己把那条撤掉——这就是「一点页面就闪」的根治办法。 */
    var notice = slowNotice('正在打开 ' + path);
    var query = '?source=' + encodeURIComponent(source) + '&path=' + encodeURIComponent(path);
    return call('/api/panel-library/document' + query).catch(function (err) {
      /* 新建：后端 GET 允许 new=1 返回一个 exists:false 的空壳，保存时走 create */
      if (err.status !== 404) throw err;
      return call('/api/panel-library/document' + query + '&new=1');
    }).then(function (data) {
      st.doc = data.document;
      st.history = data.history || [];
      notice.done();
      paintStatus(st, '');
      if (modules.doc) modules.doc.render(st, st.nodes.main, apiBag(st), force);
    }).catch(function (err) {
      notice.done();
      paintStatus(st, '打开失败：' + err.message, 'err');
      if (modules.doc) modules.doc.error(st, st.nodes.main, err);
    });
  }

  /* 新建资料：只允许配置里声明的来源，路径不许空、不许以点开头 */
  function openNew(st, path) {
    var source = st.cfg.createSource;
    if (!source) { toast('这个栏目不支持新建', 'warn'); return; }
    var clean = String(path || '').trim().replace(/^\/+/, '');
    if (!clean) return;
    if (clean.split('/').some(function (part) { return !part || part === '.' || part === '..' || part.startsWith('.'); })) {
      toast('路径不能有空段或隐藏文件', 'warn');
      return;
    }
    if (!/\.md$/i.test(clean)) clean += '.md';
    openDoc(st, source, clean);
  }

  /* 首屏默认文档：配置里指定的，或最近改过的那一份 */
  function openDefault(st) {
    var home = st.cfg.home;
    if (home) return openDoc(st, home.source, home.path);
    /* 按本页声明的来源顺序找第一份存在的资料：留痕录先给运行日记，
       而不是「全库最新改动」——维护报告天天自动生成，会把日记挤下去。 */
    var rows = rowsOf(st);
    for (var i = 0; i < st.cfg.sources.length; i++) {
      var hit = rows.filter(function (item) { return item.source === st.cfg.sources[i] && !item.missing; })[0];
      if (hit) return openDoc(st, hit.source, hit.path);
    }
    if (rows[0]) return openDoc(st, rows[0].source, rows[0].path);
    var empty = el('div', null, 'arc-empty-block');
    var emptyIcon = el('div', null, 'arc-empty-icon');
    emptyIcon.append(svgIcon('folderOpen', 30));
    empty.append(emptyIcon, el('h3', '这个栏目下还没有资料文件'));
    st.nodes.main.replaceChildren(empty);
    foot(st, { left: '', mid: '', right: '0 份' });
  }

  /* ── 提示条：2026-11-14 收口到全站统一通知组件（js/core/utils.js 的 window.toast）
     档案页原来自己一套 .arc-toast（右下角、2.6s、最多 4 条），和面板别处的提示条长相、
     位置都不一样。现在这里只做一层薄封装，位置/堆叠/去重全交给统一组件，
     调用签名 toast(text, kind) 与 slowNotice 的语义原样保留。 */
  var TYPES = { ok: 'success', success: 'success', warn: 'warning', warning: 'warning',
    err: 'error', error: 'error', info: 'info', null: 'info' };

  function toast(text, kind) {
    if (typeof window.__hzToast !== 'function') {
      /* 兜底：万一 utils 没加载（老缓存），仍要能提示，别静默吞掉 */
      var host = document.getElementById('arcToast');
      if (!host) {
        host = el('div', null, 'arc-toast-host');
        host.id = 'arcToast';
        host.setAttribute('role', 'status');
        document.body.append(host);
      }
      var item = el('div', text, 'arc-toast is-' + (kind || 'info'));
      host.append(item);
      requestAnimationFrame(function () { item.classList.add('show'); });
      setTimeout(function () { dismissToast(item); }, 2600);
      return item;
    }
    return window.__hzToast({
      message: String(text == null ? '' : text),
      type: TYPES[kind || 'info'] || 'info',
      /* 案例的 toast 在右下角（right 18 / bottom 22），统一组件按这个放 */
      position: 'bottom-right',
      duration: 2600
    });
  }

  /* 接受统一组件的句柄（函数）、或老式的元素 */
  function dismissToast(item) {
    if (!item) return;
    if (typeof item === 'function') { item(); return; }
    if (item.close) { item.close(); return; }
    if (!item.parentNode) return;
    clearTimeout(item._timer);
    item.classList.remove('show');
    setTimeout(function () { item.remove(); }, 220);
  }

  /* 慢操作披露：本地读文件通常几十毫秒，立刻弹「正在打开」只会闪一下。
     超过 320ms 还没回来才提示，回来时把这条自己撤掉。 */
  function slowNotice(text, kind) {
    var timer = setTimeout(function () { handle.item = toast(text, kind); }, 320);
    var handle = {
      item: null,
      done: function () {
        clearTimeout(timer);
        if (handle.item) { dismissToast(handle.item); handle.item = null; }
      }
    };
    return handle;
  }

  /* ── 快捷键：只在档案页可见时响应，别抢聊天输入框 ── */
  function activeState() {
    /* 页面切换走的是 router 的 .active 类，不是 hidden 属性（router.js:49）。
       原来判 !page.hidden 永远为真，⌘E/⌘S/⌘B 一律落到第一个挂载的「提示词」页，
       在知识库/留痕录按快捷键等于没反应（2026-11-14 实测）。 */
    for (var id in states) {
      var page = document.getElementById('page-' + id);
      if (page && page.classList.contains('active') && states[id].nodes.shell) return states[id];
    }
    return null;
  }
  function bindKeys() {
    if (keysBound) return;
    keysBound = true;
    document.addEventListener('keydown', function (ev) {
      var st = activeState();
      if (!st) return;
      var meta = ev.metaKey || ev.ctrlKey;
      var key = String(ev.key || '').toLowerCase();
      if (meta && key === 'k') {
        ev.preventDefault();
        if (modules.search) modules.search.open(st, st.searchQ || '', st.searchAnchor);
        return;
      }
      if (ev.key === 'Escape') {
        var open = document.querySelector('.arc-search.show');
        if (open) { ev.preventDefault(); if (modules.search) modules.search.close(st); return; }
      }
      if (st.view !== 'doc' || !modules.doc) return;
      if (meta && key === 's') {
        ev.preventDefault();
        modules.doc.save(st);
      } else if (meta && key === 'e') {
        ev.preventDefault();
        modules.doc.toggleEdit(st);
      } else if (meta && key === 'b') {
        ev.preventDefault();
        st.nodes.shell.classList.toggle('rail-open');
      }
    });
  }

  /* ── frontmatter（Obsidian 兼容 YAML 头）──
     知识库笔记的头里就两种形态：单值（created）和列表（tags）。
     只认这两种，其余原始行塞进 unknown，回写时原样带回去——面板认不出不代表
     用户写的字段可以丢。raw 是逐字原文，回写内容时用它拼回去，不重新格式化用户的手写内容。 */
  function unquote(v) {
    var s = String(v == null ? '' : v).trim();
    if (s.length > 1 && ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'"))) {
      return s.slice(1, -1);
    }
    return s;
  }
  function fmSplit(text) {
    var src = String(text == null ? '' : text);
    var m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
    if (!m) return { raw: '', data: {}, order: [], unknown: [], body: src, has: false };
    var data = {}, order = [], unknown = [], key = null;
    m[1].split(/\r?\n/).forEach(function (line) {
      var item = /^\s*-\s+(.*\S)\s*$/.exec(line);
      if (item) {
        if (key && Array.isArray(data[key])) data[key].push(unquote(item[1]));
        else if (line.trim()) unknown.push(line);
        return;
      }
      var kv = /^([A-Za-z0-9_\u4e00-\u9fa5.-]+)\s*:\s*(.*)$/.exec(line);
      if (!kv) { if (line.trim()) unknown.push(line); return; }
      key = kv[1];
      if (order.indexOf(key) < 0) order.push(key);
      var val = kv[2].trim();
      /* 空值后面跟 - 列表，先占位成数组；没有列表项就是一个空数组，序列化回 `key:` */
      data[key] = val ? unquote(val) : [];
    });
    return { raw: m[0], data: data, order: order, unknown: unknown, body: src.slice(m[0].length), has: true };
  }
  function fmJoin(data, order, unknown) {
    var keys = (order || []).slice();
    Object.keys(data || {}).forEach(function (k) { if (keys.indexOf(k) < 0) keys.push(k); });
    var lines = [];
    keys.forEach(function (k) {
      if (!(k in data)) return;
      var v = data[k];
      if (Array.isArray(v)) {
        if (!v.length) { lines.push(k + ':'); return; }
        lines.push(k + ':');
        v.forEach(function (item) { lines.push('  - ' + item); });
      } else {
        lines.push(k + ': ' + v);
      }
    });
    (unknown || []).forEach(function (line) { lines.push(line); });
    if (!lines.length) return '';
    return '---\n' + lines.join('\n') + '\n---\n';
  }
  /* 标签去重（保留原顺序、大小写不敏感判重） */
  function uniqTags(list) {
    var seen = {}, out = [];
    (list || []).forEach(function (t) {
      var v = String(t == null ? '' : t).trim().replace(/^#/, '');
      if (!v) return;
      var k = v.toLowerCase();
      if (seen[k]) return;
      seen[k] = 1; out.push(v);
    });
    return out;
  }

  function register(name, module) { modules[name] = module; }

  /* 切换到本页时：刷新一次目录（60 秒节流在 loadCatalog 里） */
  document.addEventListener('hermes:page', function (ev) {
    var page = ev.detail && ev.detail.page;
    if (!PAGES[page]) return;
    mount(page);
    var st = states[page];
    if (st) { renderView(st); loadCatalog(page, false); }
  });
  /* 挂载由 archive-boot.js 在脚本末尾同步触发：这样紧随其后的
     panel-library-reviews-ui.js 才能把「整理草稿」按钮塞进新建的页头。 */
  function boot() {
    Object.keys(PAGES).forEach(function (id) { mount(id); });
  }

  /* ── 切主题重绘（案例 setTheme → renderAll 的等价物）──
     面板主题是 body.theme-dark class 翻转（theme.js），不改 data-theme 也不派事件。
     图是 Canvas，画的时候把背景色/描边色/分类色都读死了；切浅色不重画，就会
     黑底图上留一堆浅色描边节点。这里盯 body class，变了就把挂着图谱/轨迹的页面
     重画一遍，分类色 catColor 也跟着重新取（2026-11-14）。 */
  if (typeof MutationObserver !== 'undefined') {
    /* 只认「深色/浅色真的翻了」这一件事。原来 body 上任何 class 变化（手机抽屉、
       弹窗遮罩、键盘态都给 body 加类）都会触发全页重画——2026-11-14 实测：
       手机上点「更多标签」chip，body 被加了别的类，图谱整页被重建，
       浮层刚插进 DOM 就被换掉，看着像按钮没反应。 */
    var themeWasDark = document.body.classList.contains('theme-dark');
    new MutationObserver(function () {
      var isDark = document.body.classList.contains('theme-dark');
      if (isDark === themeWasDark) return;
      themeWasDark = isDark;
      Object.keys(states).forEach(function (id) {
        var st = states[id];
        if (!st || !st.nodes || !st.nodes.shell) return;
        if (st.view === 'graph' || st.view === 'trajectory') {
          /* 先收摊再重画：renderView 里 st.mounted===view 时会跳过 unmount，
             不手动收，旧 Worker + rAF 会漏着一直跑。 */
          if (st.mounted && st.mounted.unmount) { try { st.mounted.unmount(st); } catch (_) {} }
          renderView(st);
        }
      });
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }

  /* ── 旧入口兼容：其他模块（整理草稿、斜杠命令、深链）还在调这几个全局函数 ── */
  window.panelOpenLibrary = function (source, path) {
    var page = PAGES[source] ? source : (source === 'knowledge' || source === 'notes' ? 'kb' : 'memory');
    if (typeof switchPage === 'function') switchPage(page);
    var st = stateOf(page);
    mount(page);
    return openDoc(st, source, path);
  };
  window.kbOpenNote = function (path) {
    if (typeof switchPage === 'function') switchPage('kb');
    return openDoc(stateOf('kb'), 'knowledge', path);
  };
  window.kbNewNote = function () {
    var st = stateOf('kb');
    if (typeof switchPage === 'function') switchPage('kb');
    askNew(st);
  };
  window.kbLoadTree = function () { return loadCatalog('kb', true); };
  window.renderMemoryPage = function () { mount('memory'); return render(stateOf('memory')); };

  return {
    PAGES: PAGES, mount: mount, register: register, states: states, modules: modules,
    boot: boot,
    call: call, stateOf: stateOf, render: render, renderView: renderView,
    setView: setView, openDoc: openDoc, loadCatalog: loadCatalog, toast: toast,
    dismissToast: dismissToast, slowNotice: slowNotice,
    el: el, svgIcon: svgIcon, rowsOf: rowsOf, sourceOf: sourceOf,
    paintStatus: paintStatus, foot: foot, apiBag: apiBag, writeFold: writeFold,
    catColor: catColor, colorOf: colorOf, isLight: isLight,
    fm: { split: fmSplit, join: fmJoin, uniqTags: uniqTags }
  };
})();
