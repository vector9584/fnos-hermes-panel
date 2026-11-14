/* 档案 · 关系图
 * 数据：GET /api/panel-library/graph?source=knowledge（后端解析 [[双链]] 生成节点与边）
 * 渲染：Canvas 2D；布局交给 archive-sim.js 的 Worker（Barnes-Hut），主线程只画。
 * 交互：滚轮缩放、空白拖拽平移、拖节点固定、悬停高亮邻居、点击打开文档。
 * mountForce() 只被提示词页的「技能轨迹」用（留痕录那页是排行统计，不画图），
 * 所以这里不写死任何页面的字段。 */
window.Archive.register('graph', (function () {
  'use strict';

  /* 力导向物理引擎的坐标缓存版本，力学模型一改就 +1 */
  var SIM_VER = 2;
  var A = window.Archive;
  var SIM_ASSET_V = 'g2';   /* 引力模型 v2（2026-11-14）：缩放斥力 + 软边界 + 分类锚点 */
  var simCode = null;

  function loadSim() {
    if (simCode) return Promise.resolve(simCode);
    /* sim 是运行时 fetch 的、不经过 index.html 的 ?v=（deploy 只给 index 里列出的脚本改哈希），
       不带版本就会吃到浏览器缓存里的旧力学——改引擎忘了改这里 = 用户刷新了还是老图。
       所以显式带一个版本号，改 archive-sim.js 时必须一起改它。 */
    return fetch(apiUrl('/js/archive/archive-sim.js?v=' + SIM_ASSET_V)).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    }).then(function (code) { simCode = code; return code; });
  }

  /* 启动物理：优先 Worker，不可用时用同一份源码在主线程跑（假 self） */
  function spawn(onFrame) {
    return loadSim().then(function (code) {
      try {
        var url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
        var worker = new Worker(url);
        worker.onmessage = function (ev) { onFrame(ev.data); };
        return {
          post: function (msg) { worker.postMessage(msg); },
          dispose: function () { try { worker.postMessage({ type: 'dispose' }); worker.terminate(); } catch (_) {} URL.revokeObjectURL(url); }
        };
      } catch (err) {
        var fake = {
          postMessage: function (data) { onFrame(data); },
          onmessage: null
        };
        new Function('self', code)(fake);
        return {
          post: function (msg) { if (fake.onmessage) fake.onmessage({ data: msg }); },
          dispose: function () { fake.onmessage = null; }
        };
      }
    });
  }

  function render(st, host, api) {
    return loadData(st).then(function (data) {
      if (!data.nodes.length) {
        host.replaceChildren(A.el('p', '知识库里还没有互相引用的笔记。用 [[笔记名]] 在正文里建立链接，这里就会长出图。', 'arc-empty'));
        return;
      }
      renderGraphPage(st, host, api, data);
    });
  }

  /* ── 后端 graph() 只返回「有双链的笔记 + 双链边」，没有分类锚点节点。
     案例的图谱好看，一半靠视觉细节，另一半靠「分类锚点」——每个顶层目录一个
     大圆点，笔记围着它，一眼看出分组。这里把后端数据补成案例的 kbGraphData 形状：
     cat 节点 + doc 节点 + 归属边 + 双链边。 ── */
  function buildKbGraph(data) {
    var cats = {};
    var docs = (data.nodes || []).map(function (node) {
      var group = groupOf(node.path);
      cats[group] = (cats[group] || 0) + 1;
      return {
        id: node.path, label: shortLabel(node.title || node.path || ''), group: group,
        kind: 'doc', tip: node.path + ' · ' + Math.round((node.bytes || 0) / 1024) + ' KB'
      };
    });
    var catList = Object.keys(cats).sort();
    var nodes = [];
    var catIndex = {};
    catList.forEach(function (name, i) {
      catIndex[name] = i;
      nodes.push({ id: 'cat:' + name, label: name, group: name, kind: 'cat', value: cats[name] });
    });
    var parent = new Int32Array(catList.length + docs.length);
    docs.forEach(function (doc, i) {
      parent[catList.length + i] = catIndex[doc.group];
      nodes.push(doc);
    });
    var byPath = {};
    docs.forEach(function (doc) { byPath[doc.id] = true; });
    var edges = [];
    docs.forEach(function (doc) { edges.push({ from: doc.id, to: 'cat:' + doc.group }); });
    var seen = {};
    (data.edges || []).forEach(function (edge) {
      if (!byPath[edge.from] || !byPath[edge.to]) return;
      var key = edge.from < edge.to ? edge.from + '\u0000' + edge.to : edge.to + '\u0000' + edge.from;
      if (seen[key]) return;
      seen[key] = true;
      edges.push(edge);
    });
    return { nodes: nodes, edges: edges, parent: parent, catList: catList, docCount: docs.length, catCounts: cats };
  }

  function renderGraphPage(st, host, api, data) {
    var built = buildKbGraph(data);
    var page = A.el('div', null, 'arc-gpage');
    var top = A.el('div', null, 'arc-gtop');
    var line = A.el('div', null, 'arc-gline');
    var title = A.el('div', null, 'arc-gtitle');
    title.append(
      A.el('span', '知识图谱'),
      A.el('span', built.docCount + ' 笔记 · ' + built.edges.length + ' 连线', 'arc-gbadge')
    );
    line.append(title);
    var desc = A.el('p', '圆点 = 笔记或分类，连线 = 归属关系或 [[双链]]；点分类 chip 只看那一类，点节点打开笔记，拖拽摆放、双击解除固定。', 'arc-gdesc');
    top.append(line, desc);

    /* 分类 chips：点一下就只看那一类，其余节点真正移除（案例行为） */
    var chips = A.el('div', null, 'arc-chips');
    var filterCat = '全部';
    var chipAll = A.el('button', null, 'arc-chip on');
    chipAll.type = 'button';
    chipAll.append(A.el('span', '全部'));
    chips.append(chipAll);
    var chipByCat = {};
    built.catList.forEach(function (name) {
      var b = A.el('button', null, 'arc-chip');
      b.type = 'button';
      var dot = A.el('i', null, 'arc-chip-dot');
      dot.style.background = A.catColor(name);
      b.append(dot, A.el('span', name + ' ' + built.catCounts[name]));
      chips.append(b);
      chipByCat[name] = b;
    });

    /* 工具条：连线模式 seg + 重置 + 统计开关（照案例 graph-tools） */
    var tools = A.el('div', null, 'arc-gtools');
    var seg = A.el('div', null, 'arc-seg');
    var segBh = A.el('button', '力导向', 'on');
    var segLay = A.el('button', '分层');
    segBh.type = 'button'; segLay.type = 'button';
    segBh.dataset.mode = 'bh'; segLay.dataset.mode = 'layered';
    seg.append(segBh, segLay);
    var resetBtn = A.el('button', null, 'arc-btn is-quiet');
    resetBtn.type = 'button';
    resetBtn.append(A.svgIcon('refresh', 14), A.el('span', '重排', 'arc-label'));
    var sideBtn = A.el('button', null, 'arc-btn is-quiet');
    sideBtn.type = 'button';
    sideBtn.append(A.svgIcon('tree', 14), A.el('span', '统计', 'arc-label'));
    tools.append(seg, resetBtn, sideBtn);
    top.append(chips, tools);

    var main = A.el('div', null, 'arc-gmain');
    var canvasBox = A.el('div', null, 'arc-gmain-canvas');
    var side = A.el('aside', null, 'arc-stat-side');
    main.append(canvasBox, side);
    page.append(top, main);
    host.append(page);

    var handle = null;
    function setCat(name) {
      filterCat = name || '全部';
      chipAll.classList.toggle('on', filterCat === '全部');
      Object.keys(chipByCat).forEach(function (k) {
        chipByCat[k].classList.toggle('on', k === filterCat);
      });
      if (handle && handle.setFilter) handle.setFilter(filterCat);
      renderSide();
    }
    function syncMode(mode) {
      segBh.classList.toggle('on', mode !== 'layered');
      segLay.classList.toggle('on', mode === 'layered');
    }
    chipAll.onclick = function () { setCat('全部'); };
    built.catList.forEach(function (name) {
      chipByCat[name].onclick = function () { setCat(filterCat === name ? '全部' : name); };
    });
    segBh.onclick = function () { if (handle) handle.setMode('bh'); syncMode('bh'); };
    segLay.onclick = function () { if (handle) handle.setMode('layered'); syncMode('layered'); };
    resetBtn.onclick = function () { if (handle) handle.reset(); };
    function isMobile() { return window.matchMedia('(max-width: 900px)').matches; }
    sideBtn.onclick = function () {
      if (isMobile()) {
        var open = side.classList.toggle('open');
        sideBtn.classList.toggle('on', open);
      } else {
        var off = side.classList.toggle('is-off');
        sideBtn.classList.toggle('on', !off);
      }
    };
    if (!isMobile()) sideBtn.classList.add('on');

    /* 右侧统计栏：真实数据（照案例 kbStatHtml：图谱说明 + 分类色板 + 交互） */
    function renderSide() {
      side.replaceChildren();
      side.append(A.el('div', '图谱说明', 'arc-h'));
      var n1 = A.el('div', null, 'arc-bignum');
      n1.append(A.el('b', String(built.docCount)), A.el('span', '篇笔记已入图'));
      side.append(n1);
      var n2 = A.el('div', null, 'arc-bignum');
      n2.append(A.el('b', String(built.edges.length)), A.el('span', '条关系连线'));
      side.append(n2);

      side.append(A.el('div', '分类色板', 'arc-h'));
      var bars = A.el('div', null, 'arc-bars');
      built.catList.forEach(function (name) {
        var cnt = built.catCounts[name];
        var row = A.el('div', null, 'arc-bar-row');
        var topRow = A.el('div', null, 'arc-bar-top');
        topRow.append(A.el('span', name), A.el('span', cnt + ' 篇'));
        var bg = A.el('div', null, 'arc-bar-bg');
        var fill = A.el('div', null, 'arc-bar-fill');
        fill.style.width = Math.min(100, cnt * 16) + '%';
        fill.style.background = A.catColor(name);
        bg.append(fill);
        row.append(topRow, bg);
        if (filterCat === name) row.classList.add('on');
        row.onclick = function () { setCat(filterCat === name ? '全部' : name); };
        bars.append(row);
      });
      side.append(bars);

      side.append(A.el('div', '交互', 'arc-h'));
      side.append(A.el('p', '滚轮 / 双指缩放 · 空白拖拽平移\n节点拖拽后固定，双击解除\n点分类 chip 或分类节点筛选', 'arc-detail-desc'));
    }

    /* 挂画布：分类锚点节点走 parent 数组，sim 会把 cat 节点铺圆周、笔记围在周围 */
    if (st.graphDispose) { try { st.graphDispose(); } catch (_) {} }
    handle = mountForce(canvasBox, {
      nodes: built.nodes, edges: built.edges, title: '知识图谱',
      parent: built.parent, noBar: true,
      state: st.graphView || (st.graphView = { scale: 1, tx: 0, ty: 0, mode: 'bh', pos: null }),
      groupColor: function (g) { return A.catColor(g); },
      onSelect: function (node) {
        /* 点分类节点 = 点对应的分类 chip */
        if (node && node.kind === 'cat') setCat(node.group);
      },
      onPick: function (node) {
        if (!node || node.kind === 'cat') return;
        var hit = (data.nodes || []).find(function (item) { return item.path === node.id; });
        if (hit) api.open('knowledge', hit.path);
      }
    });
    st.graphDispose = handle;
    if (st.graphView.mode === 'layered') { handle.setMode('layered'); syncMode('layered'); }
    renderSide();
  }

  function loadData(st) {
    if (st.graphData && Date.now() - (st.graphAt || 0) < 60000) return Promise.resolve(st.graphData);
    if (st.graphPending) return st.graphPending;
    st.graphPending = A.call('/api/panel-library/graph?source=knowledge').then(function (data) {
      st.graphData = data; st.graphAt = Date.now(); st.graphPending = null;
      return data;
    }).catch(function (err) {
      st.graphPending = null;
      st.graphData = { nodes: [], edges: [], error: err.message };
      return st.graphData;
    });
    return st.graphPending;
  }

  /* 通用力导向视图：nodes=[{id,label,group,size}] edges=[{from,to}] */
  function mountForce(host, options) {
    var nodes = options.nodes, edges = options.edges;
    var indexOf = {};
    nodes.forEach(function (node, i) { indexOf[node.id] = i; });

    var wrap = A.el('div', null, options.noBar ? 'arc-force is-graph' : 'arc-force');
    var bar = A.el('div', null, 'arc-force-bar');
    var stats = A.el('span', nodes.length + ' 节点 · ' + edges.length + ' 连线', 'arc-dim');
    var relayout = A.el('button', '重新布局', 'arc-btn is-quiet');
    var modeBtn = A.el('button', '分组布局', 'arc-btn is-quiet');
    bar.append(stats, relayout, modeBtn);
    /* noBar：工具条搬到页面顶部（案例 .graph-tools 的做法），这里只留画布。
       bar 仍创建但不下 DOM，offsetHeight=0，resize 的减法自然不受影响；
       外部通过返回句柄的 reset()/setMode() 调这两个按钮的逻辑。 */
    var externalBar = !!options.noBar;

    var canvas = document.createElement('canvas');
    canvas.className = 'arc-canvas';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', options.title || '关系图');
    var tip = A.el('div', null, 'arc-tip');
    tip.hidden = true;
    /* 图例容器（案例 .graph-legend：左下角分类圆点 + 名称），内容等 groupIndex 建好再填 */
    var legend = A.el('div', null, 'arc-legend');

    var view = options.state || { pos: null, scale: 1, tx: 0, ty: 0, mode: 'bh' };
    /* 坐标缓存版本：力学模型换代后旧坐标（四角挤成一团的那批）必须作废，
       否则切页回来复用 view.pos，新版引擎再准也从错的起点出发。 */
    if (view.simVer !== SIM_VER) { view.pos = null; view.simVer = SIM_VER; }
    var edgePairs = [];
    edges.forEach(function (edge) {
      var a = indexOf[edge.from], b = indexOf[edge.to];
      if (a == null || b == null) return;
      edgePairs.push(a, b);
    });
    var degree = new Float32Array(nodes.length);
    for (var e = 0; e < edgePairs.length; e += 2) { degree[edgePairs[e]]++; degree[edgePairs[e + 1]]++; }
    var radius = new Float32Array(nodes.length);
    nodes.forEach(function (node, i) {
      if (options.radius) { radius[i] = options.radius(node, i); return; }
      if (node.kind === 'cat') { radius[i] = 11 + Math.min(7, (node.value || 0) * 1.2); return; }
      radius[i] = Math.max(4.5, Math.min(16, 4.5 + Math.sqrt(degree[i] + 1) * 2.4)) * (node.size || 1);
    });
    var parentOf = new Int32Array(nodes.length);
    var groupIndex = {};
    nodes.forEach(function (node, i) {
      var g = node.group || '';
      if (!(g in groupIndex)) groupIndex[g] = Object.keys(groupIndex).length;
    });
    /* 分类锚点节点（kind==='cat'）的 parent 固定 -1（自己是锚点，不吸附到别的分组），
       文档节点按 options.parent 归属到对应分类锚点；没传 parent 时退回 groupIndex 推导。 */
    nodes.forEach(function (node, i) {
      if (node.kind === 'cat') parentOf[i] = -1;
      else if (options.parent) parentOf[i] = options.parent[i];
      else parentOf[i] = groupIndex[node.group || ''];
    });

    /* 组名 → 颜色。默认走 A.catColor：案例的 DARK_COLORS/LIGHT_COLORS 按分类名查表，
       对话沉淀/项目/家人这些知识库顶层目录各自锁一个色，深浅两套自动翻；
       查不到的名字（根目录/年月）按哈希落盘，同名恒同色。调用方传 groupColor 就覆盖。 */
    function groupColor(g) {
      if (options.groupColor) return options.groupColor(g || '');
      return A.catColor(g || '');
    }
    /* 分类筛选：'全部'/空 不筛。案例是「真正移除」——非本分类的节点和边彻底不画、
       也退出物理模拟（visible=0），不是降透明度留个半透明的残影。
       布局不重排：sim 里 vis=0 的节点只是不再受力，坐标停在原地，切换 chip 不闪不卡。 */
    var activeFilter = options.filterGroup || '';
    var visible = new Uint8Array(nodes.length); visible.fill(1);
    function recomputeVisible() {
      for (var i = 0; i < nodes.length; i++) {
        visible[i] = (!activeFilter || activeFilter === '全部' || (nodes[i].group || '') === activeFilter) ? 1 : 0;
      }
    }
    recomputeVisible();
    function passes(i) { return visible[i] !== 0; }

    /* 图例置底：色点取节点同一套 palette，最多 8 类，多的折成「另 N 类」 */
    var groupNames = Object.keys(groupIndex);
    groupNames.slice(0, 8).forEach(function (g) {
      var item = A.el('span', null, 'arc-legend-item');
      var dot = A.el('i', null, 'arc-legend-dot');
      dot.style.background = groupColor(g);
      item.append(dot, document.createTextNode(g || '未分组'));
      legend.append(item);
    });
    if (groupNames.length > 8) legend.append(A.el('span', '另 ' + (groupNames.length - 8) + ' 类', 'arc-dim'));
    if (externalBar) wrap.append(canvas, tip, legend);
    else wrap.append(bar, canvas, tip, legend);
    host.append(wrap);

    var dpr = Math.max(1, window.devicePixelRatio || 1);
    var ctx = canvas.getContext('2d');
    var cssW = 0, cssH = 0, pos = view.pos, frameNo = 0, alpha = 1;
    var hover = -1, selected = -1, dragging = -1, panning = false;
    var last = { x: 0, y: 0 };
    var sim = null;
    /* 画布底色 + 描边色 + 文字色：节点描圈和标签 halo 都吃 bg，连线高亮吃 accent，
       标签字吃 text——这些都要跟着 body.theme-dark 翻，不然浅色主题下白字写白底直接看不见。
       ⚠️ 必须读 document.body：--bg0/--accent 的深色值是挂在 body.theme-dark 上的，
       读 document.documentElement（html）拿到的是 :root 的浅色值，深色主题下永远取错
       （2026-11-14 真机实测：读 html 得 --accent=#5e64f3、--bg0=#eef0f4，即便 body 已 theme-dark）。 */
    var cs = getComputedStyle(document.body);
    var bgFill = (cs.getPropertyValue('--bg0') || '#12171d').trim() || '#12171d';
    var accent = (cs.getPropertyValue('--accent') || '#71dbc0').trim() || '#71dbc0';
    var textFill = (cs.getPropertyValue('--text') || '#e5ebf0').trim() || '#e5ebf0';
    var textDim = (cs.getPropertyValue('--text2') || '#c0ccd7').trim() || '#c0ccd7';

    function resize() {
      var rect = wrap.getBoundingClientRect();
      cssW = Math.max(280, Math.floor(rect.width));
      cssH = Math.max(240, Math.floor(wrap.clientHeight - bar.offsetHeight - 2) || 420);
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      canvas.style.width = cssW + 'px';
      canvas.style.height = cssH + 'px';
      if (sim) sim.post({ type: 'resize', W: cssW, H: cssH });
    }

    function world(sx, sy) { return { x: (sx - view.tx) / view.scale, y: (sy - view.ty) / view.scale }; }
    function localPoint(ev) {
      var rect = canvas.getBoundingClientRect();
      return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    }

    function paintFrame() {
      if (!pos) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);
      ctx.save();
      ctx.translate(view.tx, view.ty);
      ctx.scale(view.scale, view.scale);

      var neighbors = null;
      if (hover >= 0) {
        neighbors = Object.create(null);
        neighbors[hover] = true;
        for (var e2 = 0; e2 < edgePairs.length; e2 += 2) {
          if (edgePairs[e2] === hover) neighbors[edgePairs[e2 + 1]] = true;
          if (edgePairs[e2 + 1] === hover) neighbors[edgePairs[e2]] = true;
        }
      }

      /* ── 边分三遍画（案例做法）。原来一条边一次 strokeStyle，且只有一种粗细，
         悬停时看不出"从哪个节点连出去"，整张图就是一团毛线。── */
      var a, b, k;
      ctx.lineCap = 'round';

      /* ① 正文边：细、低对比，只管托住结构（颜色跟着主题走：暗色浅灰、浅色深灰） */
      ctx.lineWidth = 1 / view.scale;
      ctx.strokeStyle = textDim;
      ctx.globalAlpha = .22;
      ctx.beginPath();
      for (k = 0; k < edgePairs.length; k += 2) {
        a = edgePairs[k]; b = edgePairs[k + 1];
        if (!passes(a) || !passes(b)) continue;
        ctx.moveTo(pos[a * 2], pos[a * 2 + 1]);
        ctx.lineTo(pos[b * 2], pos[b * 2 + 1]);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;

      /* ② 被筛掉的节点之间：留一层极淡的底，图不至于塌成空白 */
      ctx.strokeStyle = textDim;
      ctx.globalAlpha = .07;
      ctx.beginPath();
      for (k = 0; k < edgePairs.length; k += 2) {
        a = edgePairs[k]; b = edgePairs[k + 1];
        if (passes(a) && passes(b)) continue;
        ctx.moveTo(pos[a * 2], pos[a * 2 + 1]);
        ctx.lineTo(pos[b * 2], pos[b * 2 + 1]);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;

      /* ③ 悬停/选中节点的邻居边：accent 加粗，这是能顺着看出去的关键 */
      if (neighbors) {
        ctx.lineWidth = 1.9 / view.scale;
        ctx.strokeStyle = accent;
        ctx.globalAlpha = .85;
        ctx.beginPath();
        for (k = 0; k < edgePairs.length; k += 2) {
          a = edgePairs[k]; b = edgePairs[k + 1];
          if (!(neighbors[a] && neighbors[b])) continue;
          ctx.moveTo(pos[a * 2], pos[a * 2 + 1]);
          ctx.lineTo(pos[b * 2], pos[b * 2 + 1]);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      /* 2026-11-14 对齐墨档全端性能版：标签按密度分级显示。
         原来只要 scale>0.55 就全画，504 节点的技能轨迹图一进来就是一片糊字。
         现在的口径：节点少（≤140）全画；节点多则要放大到 1.25 倍以上才画；
         悬停/选中的那个永远画，大节点（半径>10）也永远画——保证图里始终有可读的锚点。 */
      var showLabels = nodes.length <= 140 || view.scale > 1.25;
      /* 字体/对齐/描角提到循环外——原来每个节点设一次 font，纯属白烧 CPU */
      ctx.font = '600 ' + (10 / view.scale) + 'px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.lineJoin = 'round';
      for (var i = 0; i < nodes.length; i++) {
        var nx = pos[i * 2], ny = pos[i * 2 + 1], r = radius[i];
        var off = !passes(i);
        var dim = off || (neighbors && !neighbors[i]);
        var ga = off ? 0.1 : dim ? 0.28 : 1;
        ctx.beginPath();
        ctx.arc(nx, ny, r, 0, Math.PI * 2);
        ctx.fillStyle = groupColor(nodes[i].group);
        ctx.globalAlpha = ga;
        ctx.fill();
        /* 描一圈画布底色：不描这一圈，连线会从圆里穿过去，整张图就是一坨毛线。
           案例这一圈 1.4/k，略粗于线宽，圆才有实体感。 */
        ctx.lineWidth = 1.4 / view.scale;
        ctx.strokeStyle = bgFill;
        ctx.stroke();
        ctx.globalAlpha = 1;
        if (i === selected || i === hover) {
          ctx.beginPath();
          ctx.arc(nx, ny, r + 3 / view.scale, 0, Math.PI * 2);
          ctx.strokeStyle = accent;
          ctx.lineWidth = 2.2 / view.scale;
          ctx.stroke();
        }
        if (!off && (showLabels || i === hover || i === selected || r > 10)) {
          var text = nodes[i].label;
          if (text && text.length > 18) text = text.slice(0, 17) + '…';
          /* 标签先拿底色描 3px 再写字：压在连线上的字不描边就是糊的（案例做法） */
          var lx = Math.max(r + 8, Math.min(cssW - r - 8, nx));
          var ly = ny + r + 4 / view.scale;
          ctx.lineWidth = 3 / view.scale;
          ctx.strokeStyle = bgFill;
          ctx.strokeText(text, lx, ly);
          ctx.fillStyle = textFill;
          ctx.globalAlpha = dim ? .35 : .92;
          ctx.fillText(text, lx, ly);
          ctx.globalAlpha = 1;
        }
      }
      ctx.restore();
    }

    function pick(sx, sy) {
      if (!pos) return -1;
      var p = world(sx, sy), best = -1, bestD = 1e9;
      for (var i = 0; i < nodes.length; i++) {
        var dx = pos[i * 2] - p.x, dy = pos[i * 2 + 1] - p.y;
        var d = Math.sqrt(dx * dx + dy * dy);
        var hit = Math.max(radius[i] + 6, 12);
        if (d < hit && d < bestD) { bestD = d; best = i; }
      }
      return best;
    }

    canvas.addEventListener('wheel', function (ev) {
      ev.preventDefault();
      var p = localPoint(ev);
      var before = world(p.x, p.y);
      var factor = Math.exp(-ev.deltaY * 0.0016);
      view.scale = Math.max(0.25, Math.min(3.2, view.scale * factor));
      view.tx = p.x - before.x * view.scale;
      view.ty = p.y - before.y * view.scale;
      paintFrame();
    }, { passive: false });

    canvas.addEventListener('pointerdown', function (ev) {
      var p = localPoint(ev);
      var hit = pick(p.x, p.y);
      last = p;
      canvas.setPointerCapture(ev.pointerId);
      if (hit >= 0) {
        dragging = hit;
        if (sim) { var w = world(p.x, p.y); sim.post({ type: 'drag', i: hit, x: w.x, y: w.y }); }
      } else panning = true;
    });

    canvas.addEventListener('pointermove', function (ev) {
      var p = localPoint(ev);
      if (dragging >= 0) {
        var w = world(p.x, p.y);
        if (sim) sim.post({ type: 'drag', i: dragging, x: w.x, y: w.y });
        if (pos) { pos[dragging * 2] = w.x; pos[dragging * 2 + 1] = w.y; paintFrame(); }
        return;
      }
      if (panning) {
        view.tx += p.x - last.x; view.ty += p.y - last.y;
        last = p; paintFrame(); return;
      }
      var hit = pick(p.x, p.y);
      if (hit !== hover) {
        hover = hit;
        paintFrame();
        if (hit >= 0) {
          tip.textContent = nodes[hit].tip || nodes[hit].label;
          tip.hidden = false;
          tip.style.left = Math.min(cssW - 200, p.x + 12) + 'px';
          tip.style.top = Math.max(6, p.y - 30) + 'px';
        } else tip.hidden = true;
      }
    });

    function release(ev) {
      if (dragging >= 0 && sim) sim.post({ type: 'unfix', i: dragging });
      dragging = -1; panning = false;
      try { canvas.releasePointerCapture(ev.pointerId); } catch (_) {}
    }
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);

    canvas.addEventListener('click', function (ev) {
      if (panning) return;
      var p = localPoint(ev);
      var hit = pick(p.x, p.y);
      if (hit < 0) {
        selected = -1; paintFrame();
        if (options.onSelect) options.onSelect(null, -1);
        return;
      }
      selected = hit;
      paintFrame();
      /* onSelect 只选中（右侧统计栏跟着变），onPick 才跳转。
         两者可同时给：先选再看详情，跳不跳由调用方决定。 */
      if (options.onSelect) options.onSelect(nodes[hit], hit);
      if (options.onPick) options.onPick(nodes[hit]);
    });

    relayout.onclick = function () {
      view.pos = null; pos = null;
      if (sim) sim.post({ type: 'reset' });
      else start();
    };
    modeBtn.onclick = function () {
      view.mode = view.mode === 'layered' ? 'bh' : 'layered';
      modeBtn.textContent = view.mode === 'layered' ? '力导向布局' : '分组布局';
      if (sim) sim.post({ type: 'mode', mode: view.mode });
    };
    modeBtn.textContent = view.mode === 'layered' ? '力导向布局' : '分组布局';

    function start() {
      resize();
      spawn(function (msg) {
        if (msg.type !== 'frame') return;
        pos = msg.pos; view.pos = pos; alpha = msg.alpha; frameNo = msg.frame;
        if (msg.converged) stats.textContent = nodes.length + ' 节点 · ' + edges.length + ' 连线';
        paintFrame();
      }).then(function (instance) {
        sim = instance;
        var catCount = 0;
        for (var ci = 0; ci < nodes.length; ci++) if (nodes[ci].kind === 'cat') catCount++;
        if (catCount === 0) catCount = Object.keys(groupIndex).length;
        sim.post({
          type: 'init', n: nodes.length, W: cssW, H: cssH, mode: view.mode,
          theta: 0.9, linkLen: 100, catCount: catCount,
          parent: parentOf, edges: new Int32Array(edgePairs), radius: radius,
          visible: visible, pos: view.pos || null
        });
        if (view.pos) paintFrame();
      }).catch(function (err) {
        canvas.replaceWith(A.el('p', '图形引擎加载失败：' + err.message, 'arc-empty'));
      });
    }

    var observer = window.ResizeObserver ? new ResizeObserver(function () {
      var w = Math.floor(wrap.getBoundingClientRect().width);
      if (Math.abs(w - cssW) < 8) return;
      resize();
      if (view.pos) paintFrame();
    }) : null;
    if (observer) observer.observe(wrap);

    start();
    var dispose = function dispose() {
      if (observer) observer.disconnect();
      if (sim) sim.dispose();
      view.pos = pos; view.simVer = SIM_VER;
      /* 必须删 DOM：render 可能被 loadCatalog 完成 + hermes:page 各触发一次，
         dispose 只停 worker 不摘节点的话，第二次 mountForce 的 wrap 会叠在
         第一次的残影上，就是用户看到的「画两遍」。 */
      if (wrap && wrap.parentNode) wrap.remove();
    };
    /* 控制句柄：函数本体保持「调用即销毁」，属性给外部工具条用。
       这样老的 st.xxxDispose() 调用一行都不用改。 */
    dispose.setFilter = function (g) {
      activeFilter = g || '';
      recomputeVisible();
      if (sim) sim.post({ type: 'filter', visible: visible });
      paintFrame();
    };
    dispose.filter = function () { return activeFilter; };
    dispose.select = function (id) {
      var i = indexOf[id];
      selected = (i == null ? -1 : i);
      paintFrame();
      return i != null ? nodes[i] : null;
    };
    dispose.reset = function () {
      view.pos = null; pos = null;
      if (sim) sim.post({ type: 'reset' }); else start();
    };
    dispose.setMode = function (mode) {
      view.mode = mode === 'layered' ? 'layered' : 'bh';
      if (sim) sim.post({ type: 'mode', mode: view.mode });
    };
    dispose.mode = function () { return view.mode; };
    dispose.counts = function () { return { nodes: nodes.length, edges: edges.length }; };
    return dispose;
  }

  /* 去掉日期前缀：知识库文件名基本都是 2026-11-01-主题，原样上图等于一片数字。
     日期进 tip，标题栏只留能认人的部分。 */
  function shortLabel(raw) {
    var t = String(raw || '').replace(/\.md$/i, '');
    var stripped = t.replace(/^\d{4}-\d{2}-\d{2}[-_ ]*/, '').replace(/^\d{4}[-_ ]*/, '');
    return stripped || t;
  }

  /* 分组决定颜色。原来对根目录文件 path.split('/')[0] 拿到的是文件名本身，
     703 个节点 703 种颜色 —— 颜色不再是信息，只是噪点。 */
  function groupOf(path) {
    var seg = String(path || '').split('/');
    if (seg.length > 1 && seg[0]) return seg[0];
    var m = /^(\d{4})-(\d{2})/.exec(String(path || ''));
    return m ? m[1] + '-' + m[2] : '根目录';
  }

  return {
    render: render,
    mountForce: mountForce,
    unmount: function (st) {
      if (st && st.graphDispose) {
        try { st.graphDispose(); } catch (_) {}
        st.graphDispose = null;
      }
    }
  };
})());
