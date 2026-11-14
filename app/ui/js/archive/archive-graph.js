/* 档案 · 关系图
 * 数据：GET /api/panel-library/graph?source=knowledge（后端解析 [[双链]] 生成节点与边）
 * 渲染：Canvas 2D；布局交给 archive-sim.js 的 Worker（Barnes-Hut），主线程只画。
 * 交互：滚轮缩放、空白拖拽平移、拖节点固定、悬停高亮邻居、点击打开文档。
 * mountForce() 只被提示词页的「技能轨迹」用（留痕录那页是排行统计，不画图），
 * 所以这里不写死任何页面的字段。 */
window.Archive.register('graph', (function () {
  'use strict';

  /* 力导向物理引擎的坐标缓存版本，力学模型一改就 +1 */
  var SIM_VER = 3;
  var A = window.Archive;
  var SIM_ASSET_V = 'g7';   /* 引力模型 v3：簇半径按节点数分面积 + 圆盘松弛布点 + 近距软化（2026-11-14） */
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

  /* 引擎 ~100KB，首开时才去 fetch 等于白等一轮往返。页面闲下来就预热，
     等用户真点「知识图谱 / 技能轨迹」时 loadSim 直接吃现成的。
     用 requestIdleCallback 而不是立刻 fetch：不要跟首屏抢带宽。 */
  (function warmSim() {
    function run() { loadSim().catch(function () {}); }
    if (window.requestIdleCallback) window.requestIdleCallback(run, { timeout: 2500 });
    else setTimeout(run, 1500);
  })();

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

  /* 面板会在同一域名上维持多条长连接（聊天队列的 SSE），Chrome 单域名上限 6 条，
     占满之后新请求会无限排队、fetch 既不 resolve 也不 reject——表现就是"点知识图谱一直空白"。
     这不是图谱自己的 bug，但不能让它无声卡死：超时就当失败，重试一次，还不行给出可点的重试。 */
  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error('连接排队超时')); }, ms);
      promise.then(function (v) { clearTimeout(timer); resolve(v); },
                   function (e) { clearTimeout(timer); reject(e); });
    });
  }

  function fetchGraph() {
    return withTimeout(A.call('/api/panel-library/graph?source=knowledge'), 5000)
      .catch(function (err) {
        /* 第一次多半是连接池被占，等 1.2s 再试一次；仍失败才认账 */
        return new Promise(function (res) { setTimeout(res, 1000); })
          .then(function () { return withTimeout(A.call('/api/panel-library/graph?source=knowledge'), 8000); })
          .catch(function () { throw err; });
      });
  }

  function render(st, host, api) {
    /* 取数期间先给一句话：连接排队时可能等上十几秒，空白会让人以为知识库空了 */
    var loading = A.el('div', null, 'arc-empty-block');
    loading.append(A.el('p', '正在取图谱数据…', 'arc-dim'));
    host.replaceChildren(loading);
    return loadData(st).then(function (data) {
      if (loading.parentNode) loading.remove();
      if (data.error) {
        /* 连不上/超时：给一个能点的重试，别留一块空白让人以为"知识库空了" */
        var box = A.el('div', null, 'arc-empty-block');
        box.append(A.el('p', '图谱数据没取到：' + data.error, 'arc-dim'));
        var again = A.el('button', '重试', 'arc-btn is-primary');
        again.onclick = function () {
          st.graphData = null; st.graphAt = 0;
          if (api && api.rerender) api.rerender();
        };
        box.append(again);
        host.replaceChildren(box);
        return;
      }
      if (!data.nodes.length) {
        host.replaceChildren(A.el('p', '知识库里还没有互相引用的笔记。用 [[笔记名]] 在正文里建立链接，这里就会长出图。', 'arc-empty'));
        return;
      }
      renderGraphPage(st, host, api, data);
    });
  }

  /* ── 图谱 = 笔记之间的引用网络 ──
     后端 graph() 已经把正文里的 [[双链]] 解析成边了。前端只做两件事：

       ① 只画引用边。旧版按目录给每篇笔记接了一条「归属边」（doc → cat:目录），
          于是整张图其实是目录树，看着就像"照左边文件列表画的"（2026-11-14 用户看出来的）。
          这条边删掉，目录只用来上色和分 chip，不参与拓扑。
       ② 没被任何笔记引用的（孤立笔记）默认不画：几百个悬空点会把真正的关系压成一团。
          需要时点「未连接」chip 把它们加进来。 */
  function buildLinkGraph(data, includeIsolated, catalogRows) {
    var nodes = [], byPath = {};
    /* 标签映射：后端 graph() 回全部笔记的 frontmatter tags（不只入图那批），
       后端没重启时是 undefined —— 那就没有标签维度，chip 不出现，绝不拿目录名假装标签。 */
    var tagMap = (data && data.tags) || null;
    function tagsOf(path) {
      var t = tagMap && tagMap[path];
      return Array.isArray(t) ? t.slice() : [];
    }
    (data.nodes || []).forEach(function (item) {
      var out = item.out || 0, inc = item.in || 0;
      var doc = {
        id: item.path,
        label: shortLabel(item.title || item.path || ''),
        group: groupOf(item.path),
        kind: 'doc',
        deg: out + inc,
        tags: Array.isArray(item.tags) && item.tags.length ? item.tags.slice() : tagsOf(item.path),
        tip: item.path + '\n引用 ' + out + ' 篇 · 被 ' + inc + ' 篇引用'
      };
      if (doc.tags.length) doc.tip += '\n标签 ' + doc.tags.join('、');
      byPath[doc.id] = doc;
      nodes.push(doc);
    });

    var edges = [], seen = {};
    (data.edges || []).forEach(function (edge) {
      if (!byPath[edge.from] || !byPath[edge.to]) return;
      var key = edge.from + '\u0000' + edge.to;
      if (seen[key]) return;
      seen[key] = 1;
      edges.push({ from: edge.from, to: edge.to, kind: 'link' });
    });

    /* 双向互链（A→B 且 B→A）：从画上去的边自己数，不等后端 totals——
       后端没重启时拿不到 totals，回退成 0 就是在统计栏摆一个假数字。 */
    var pairSet = {};
    edges.forEach(function (e) { pairSet[e.from + '\u0000' + e.to] = 1; });
    var reciprocal = edges.filter(function (e) {
      return pairSet[e.to + '\u0000' + e.from] && e.from < e.to;
    }).length;

    /* 孤立笔记：目录里有、但一条引用边都没沾上。名字与路径取自目录，不让后端多回传。 */
    var linkedCount = nodes.length;
    if (includeIsolated && catalogRows) {
      catalogRows.forEach(function (item) {
        if (!/\.md$/i.test(item.path) || item.missing) return;
        if (byPath[item.path]) return;
        var doc = { id: item.path, label: shortLabel(item.title || item.path), group: groupOf(item.path), kind: 'doc', deg: 0, tags: tagsOf(item.path), tip: item.path + '\n没有被引用，也没有引用别人' };
        if (doc.tags.length) doc.tip += '\n标签 ' + doc.tags.join('、');
        byPath[doc.id] = doc;
        nodes.push(doc);
      });
    }

    var catCount = {};
    nodes.forEach(function (n) { catCount[n.group] = (catCount[n.group] || 0) + 1; });
    var catList = Object.keys(catCount).sort(function (a, b) {
      return (catCount[b] - catCount[a]) || a.localeCompare(b, 'zh');
    });

    /* 标签维度：只统计真的写进 frontmatter 的 tags，从节点上收，不从路径推。
       119 个标签里大半只出现一次，chip 只摆前 8 个，其余进「更多标签」浮层。 */
    var tagCount = {}, untagged = 0;
    nodes.forEach(function (n) {
      if (!n.tags || !n.tags.length) { untagged++; return; }
      n.tags.forEach(function (t) { tagCount[t] = (tagCount[t] || 0) + 1; });
    });
    var tagList = Object.keys(tagCount).sort(function (a, b) {
      return (tagCount[b] - tagCount[a]) || a.localeCompare(b, 'zh');
    });
    return {
      nodes: nodes, edges: edges, byPath: byPath,
      catList: catList, catCounts: catCount,
      tagList: tagList, tagCounts: tagCount, untagged: untagged,
      hasTags: tagList.length > 0,
      totals: data.totals || {},
      linked: linkedCount, reciprocal: reciprocal, shown: nodes.length, links: edges.length
    };
  }

  function renderGraphPage(st, host, api, data) {
    var rows = (st.catalog && st.catalog.items || []).filter(function (item) { return item.source === 'knowledge'; });
    var built = buildLinkGraph(data, !!st.showIsolated, rows);
    /* 后端新加的 totals 要重启才生效；没重启时用目录里真实文件数自己算，别把
       「0 篇未连接」当成真数据摆出去。 */
    var totals = built.totals || {};
    var totalNotes = totals.notes;
    if (!totalNotes) {
      totalNotes = rows.filter(function (item) { return /\.md$/i.test(item.path) && !item.missing; }).length;
    }
    var linkedNotes = totals.linked || built.linked;
    var isolatedNotes = totals.isolated != null ? totals.isolated : Math.max(0, totalNotes - linkedNotes);
    var reciprocalPairs = totals.reciprocal != null ? totals.reciprocal : built.reciprocal;

    var page = A.el('div', null, 'arc-gpage');
    var top = A.el('div', null, 'arc-gtop');
    var line = A.el('div', null, 'arc-gline');
    var title = A.el('div', null, 'arc-gtitle');
    title.append(
      A.el('span', '知识图谱'),
      A.el('span', built.shown + ' 篇 · ' + built.links + ' 条引用', 'arc-gbadge')
    );
    line.append(title);
    var UNTAGGED = '\u0000untagged';
    var desc = A.el('p', '圆点 = 笔记，连线 = 正文里的 [[引用]]；颜色只表示所在目录，不参与连接。上面一排 chip 按 frontmatter 的 tags 筛选（多选取并集），目录是第二维。点节点打开笔记，滚轮缩放、拖拽摆位。', 'arc-gdesc');
    top.append(line, desc);

    /* 筛选状态挂在 st 上：切页签、切主题、切未连接再回来，不该把用户选的东西清掉。
       选中但这一轮已经不存在的标签（换了数据源）自动丢掉，免得筛出一个空图。 */
    st.tagSel = (Array.isArray(st.tagSel) ? st.tagSel : []).filter(function (t) {
      return t === UNTAGGED ? built.untagged > 0 : !!built.tagCounts[t];
    });
    st.dirSel = built.catCounts[st.dirSel] ? st.dirSel : '';

    var chips = A.el('div', null, 'arc-chips');
    var chipAll = A.el('button', null, 'arc-chip on');
    chipAll.type = 'button';
    chipAll.append(A.el('span', '全部 ' + built.shown));
    chips.append(chipAll);

    var chipByTag = {}, chipByCat = {}, TAG_CHIP_MAX = 8;
    /* 标签维度只来自 frontmatter。后端没重启时 data.tags 是空的 —— 这时一个 tag chip
       都不画，也不拿目录名冒充标签：宁可少一个维度，不能编一个。 */
    if (built.hasTags) {
      chips.append(A.el('span', '标签', 'arc-chips-label'));
      built.tagList.slice(0, TAG_CHIP_MAX).forEach(function (name) {
        var b = A.el('button', null, 'arc-chip is-tag');
        b.type = 'button';
        b.title = name + ' · ' + built.tagCounts[name] + ' 篇笔记带这个标签';
        var dot = A.el('i', null, 'arc-chip-dot');
        dot.style.background = A.catColor(name);
        b.append(dot, A.el('span', name + ' ' + built.tagCounts[name]));
        chips.append(b);
        chipByTag[name] = b;
      });
      if (built.untagged) {
        var noneChip = A.el('button', null, 'arc-chip is-tag');
        noneChip.type = 'button';
        noneChip.title = 'frontmatter 里没有 tags 的笔记';
        noneChip.append(A.el('span', '无标签 ' + built.untagged));
        chips.append(noneChip);
        chipByTag[UNTAGGED] = noneChip;
      }
      if (built.tagList.length > TAG_CHIP_MAX) {
        var moreChip = A.el('button', null, 'arc-chip is-more');
        moreChip.type = 'button';
        moreChip.title = '全部 ' + built.tagList.length + ' 个标签';
        moreChip.append(A.el('span', '更多标签 ' + (built.tagList.length - TAG_CHIP_MAX)), A.el('span', '\u25be', 'arc-caret'));
        chips.append(moreChip);
        moreChip.onclick = function () { toggleTagPop(moreChip); };
      }
    }

    chips.append(A.el('span', '目录', 'arc-chips-label'));
    built.catList.forEach(function (name) {
      var b = A.el('button', null, 'arc-chip');
      b.type = 'button';
      var dot = A.el('i', null, 'arc-chip-dot');
      dot.style.background = A.catColor(name);
      b.append(dot, A.el('span', name + ' ' + built.catCounts[name]));
      chips.append(b);
      chipByCat[name] = b;
    });

    /* 孤立笔记开关：默认不画，但把数量摆在明面上——不然用户以为笔记丢了 */
    if (isolatedNotes) {
      var ghost = A.el('button', null, 'arc-chip is-ghost' + (st.showIsolated ? ' on' : ''));
      ghost.type = 'button';
      ghost.title = st.showIsolated ? '只看有引用的' : '把没有任何引用的笔记也画上来';
      ghost.append(A.el('span', (st.showIsolated ? '隐藏' : '显示') + '未连接 ' + isolatedNotes));
      ghost.onclick = function () {
        st.showIsolated = !st.showIsolated;
        if (api && api.rerender) api.rerender();
      };
      chips.append(ghost);
    }

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
    var badge = title.querySelector('.arc-gbadge');

    /* ── 筛选：标签是主角，目录是第二维 ──
       标签多选取并集（一篇带「项目」或「前端」的都留下），目录单选。
       两个维度同时生效 = 交集。筛掉的节点在画布上真移除（见 mountForce 的 visible），
       不是降透明度留残影。 */
    function isVisible(node) {
      if (st.dirSel && (node.group || '') !== st.dirSel) return false;
      if (!st.tagSel.length) return true;
      var tags = node.tags || [];
      for (var i = 0; i < st.tagSel.length; i++) {
        if (st.tagSel[i] === UNTAGGED) { if (!tags.length) return true; continue; }
        if (tags.indexOf(st.tagSel[i]) >= 0) return true;
      }
      return false;
    }
    function visibleStats() {
      var set = {}, vn = 0, ve = 0;
      built.nodes.forEach(function (n) { if (isVisible(n)) { set[n.id] = 1; vn++; } });
      built.edges.forEach(function (e) { if (set[e.from] && set[e.to]) ve++; });
      return { nodes: vn, edges: ve };
    }
    function isFiltered() { return st.tagSel.length > 0 || !!st.dirSel; }
    function applyFilter() {
      chipAll.classList.toggle('on', !isFiltered());
      Object.keys(chipByTag).forEach(function (k) { chipByTag[k].classList.toggle('on', st.tagSel.indexOf(k) >= 0); });
      Object.keys(chipByCat).forEach(function (k) { chipByCat[k].classList.toggle('on', k === st.dirSel); });
      var v = visibleStats();
      /* 徽章跟着筛选后的真数字走，别让「全部 116」和「图上只剩 12 个点」并存 */
      if (badge) badge.textContent = v.nodes + ' 篇 · ' + v.edges + ' 条引用';
      if (handle && handle.setVisibleFilter) handle.setVisibleFilter(isVisible);
      renderSide(v);
      syncTagPop();
    }
    function toggleTag(name) {
      var at = st.tagSel.indexOf(name);
      if (at >= 0) st.tagSel.splice(at, 1); else st.tagSel.push(name);
      applyFilter();
    }
    function setDir(name) {
      st.dirSel = st.dirSel === name ? '' : name;
      applyFilter();
    }

    /* 「更多标签」浮层：119 个标签里大半只出现一次，全塞进 chips 会把目录挤到看不见。
       浮层里带搜索（中文输入法组字期间不过滤——不然打「项」只剩拼音字母），点一行多选一次。 */
    var tagPop = null, tagPopAnchor = null, tagPopOutside = null;
    function syncTagPop() {
      if (!tagPop) return;
      var rows = tagPop.querySelectorAll('[data-tag]');
      for (var i = 0; i < rows.length; i++) {
        rows[i].classList.toggle('on', st.tagSel.indexOf(rows[i].dataset.tag) >= 0);
      }
      var clear = tagPop.querySelector('.arc-tagpop-clear');
      if (clear) clear.textContent = st.tagSel.length ? '清空筛选 ' + st.tagSel.length : '清空筛选';
      clear && clear.classList.toggle('is-on', st.tagSel.length > 0);
    }
    function renderTagPopList(query) {
      if (!tagPop) return;
      var list = tagPop.querySelector('.arc-tagpop-list');
      var q = String(query || '').trim().toLowerCase();
      list.replaceChildren();
      var hits = built.tagList.filter(function (t) { return !q || t.toLowerCase().indexOf(q) >= 0; });
      if (!q && built.untagged) hits = hits.concat([UNTAGGED]);
      hits.forEach(function (name) {
        var row = A.el('button', null, 'arc-tagpop-item' + (st.tagSel.indexOf(name) >= 0 ? ' on' : ''));
        row.type = 'button';
        row.dataset.tag = name;
        var dot = A.el('i', null, 'arc-chip-dot');
        dot.style.background = name === UNTAGGED ? 'var(--muted)' : A.catColor(name);
        row.append(dot, A.el('span', name === UNTAGGED ? '无标签' : name, 'arc-tagpop-name'),
          A.el('span', String(name === UNTAGGED ? built.untagged : built.tagCounts[name]), 'arc-cnt'));
        row.onclick = function () { toggleTag(name); };
        list.append(row);
      });
      if (!hits.length) list.append(A.el('p', '没有匹配的标签', 'arc-dim'));
    }
    function closeTagPop() {
      if (!tagPop) return;
      tagPop.remove(); tagPop = null;
      if (tagPopOutside) { document.removeEventListener('mousedown', tagPopOutside, true); tagPopOutside = null; }
      if (tagPopAnchor) { tagPopAnchor.classList.remove('on'); tagPopAnchor = null; }
    }
    function toggleTagPop(btn) {
      if (tagPop) { closeTagPop(); return; }
      tagPop = A.el('div', null, 'arc-tagpop');
      var head = A.el('div', null, 'arc-tagpop-head');
      var input = A.el('input', null, 'arc-tagpop-input');
      input.type = 'search';
      input.placeholder = '搜标签…';
      input.setAttribute('aria-label', '搜索标签');
      input.oninput = function (ev) { if (ev && ev.isComposing) return; renderTagPopList(input.value); };
      input.oncompositionend = function () { renderTagPopList(input.value); };
      var clear = A.el('button', '清空筛选', 'arc-btn is-quiet arc-tagpop-clear');
      clear.type = 'button';
      clear.onclick = function () { st.tagSel = []; applyFilter(); renderTagPopList(input.value); };
      head.append(input, clear);
      var list = A.el('div', null, 'arc-tagpop-list');
      tagPop.append(head, list);
      top.append(tagPop);
      /* 贴在 chips 下沿，left 跟着 chips 走（桌面 20px、手机 14px 不用写死） */
      var box = chips.getBoundingClientRect(), topBox = top.getBoundingClientRect();
      tagPop.style.left = Math.max(8, box.left - topBox.left) + 'px';
      tagPop.style.top = (box.top - topBox.top + box.height + 6) + 'px';
      tagPopAnchor = btn;
      btn.classList.add('on');
      tagPopOutside = function (ev) {
        if (tagPop && tagPop.contains(ev.target)) return;
        if (tagPopAnchor && tagPopAnchor.contains(ev.target)) return;
        closeTagPop();
      };
      document.addEventListener('mousedown', tagPopOutside, true);
      renderTagPopList('');
      syncTagPop();
      setTimeout(function () { try { input.focus(); } catch (_) {} }, 30);
    }

    function syncMode(mode) {
      segBh.classList.toggle('on', mode !== 'layered');
      segLay.classList.toggle('on', mode === 'layered');
    }
    chipAll.onclick = function () { st.tagSel = []; st.dirSel = ''; applyFilter(); };
    Object.keys(chipByTag).forEach(function (k) {
      chipByTag[k].onclick = function () { toggleTag(k); };
    });
    Object.keys(chipByCat).forEach(function (k) {
      chipByCat[k].onclick = function () { setDir(k); };
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

    /* 右侧统计栏：全部来自后端 totals 与真实边，不估算 */
    function renderSide(v) {
      v = v || visibleStats();
      side.replaceChildren();
      side.append(A.el('div', '图谱说明', 'arc-h'));

      var n1 = A.el('div', null, 'arc-bignum');
      n1.append(A.el('b', String(built.shown)), A.el('span', '篇笔记入图'));
      side.append(n1);
      var n2 = A.el('div', null, 'arc-bignum');
      n2.append(A.el('b', String(built.links)), A.el('span', '条引用关系'));
      side.append(n2);

      var kv = A.el('div', null, 'arc-kv');
      function kvRow(k, v2, extra) {
        var row = A.el('div', null, 'arc-kv-row');
        row.append(A.el('span', k), A.el('b', String(v2)), A.el('span', extra || '', 'arc-dim'));
        kv.append(row);
      }
      kvRow('知识库总笔记', totalNotes, '篇');
      kvRow('有引用关系的', linkedNotes, '篇');
      kvRow('没有被引用过', isolatedNotes, '篇');
      kvRow('双向互链', reciprocalPairs, '对');
      if (built.hasTags) kvRow('入图带标签', built.nodes.filter(function (n) { return n.tags && n.tags.length; }).length, '篇（全库 ' + (totals.tagged || '?') + ' 篇）');
      side.append(kv);

      /* 筛选中：把「还剩多少」摆在明面上——图上只剩几个点时要能看出是筛出来了，不是图坏了 */
      if (isFiltered()) {
        var fbox = A.el('div', null, 'arc-filterbox');
        var ftitle = A.el('div', null, 'arc-filterhead');
        ftitle.append(A.el('span', '当前筛选'));
        var clearBtn = A.el('button', '清空', 'arc-btn is-quiet');
        clearBtn.type = 'button';
        clearBtn.onclick = function () { st.tagSel = []; st.dirSel = ''; applyFilter(); };
        ftitle.append(clearBtn);
        fbox.append(ftitle);
        var picks = A.el('div', null, 'arc-filterchips');
        if (st.dirSel) {
          var dchip = A.el('button', null, 'arc-chip on');
          dchip.type = 'button';
          var ddot = A.el('i', null, 'arc-chip-dot');
          ddot.style.background = A.catColor(st.dirSel);
          dchip.append(ddot, A.el('span', '目录 · ' + st.dirSel));
          dchip.onclick = function () { setDir(st.dirSel); };
          picks.append(dchip);
        }
        st.tagSel.forEach(function (t) {
          var tchip = A.el('button', null, 'arc-chip on is-tag');
          tchip.type = 'button';
          var tdot = A.el('i', null, 'arc-chip-dot');
          tdot.style.background = t === UNTAGGED ? 'var(--muted)' : A.catColor(t);
          tchip.append(tdot, A.el('span', t === UNTAGGED ? '无标签' : t), A.el('span', '\u00d7', 'arc-caret'));
          tchip.onclick = function () { toggleTag(t); };
          picks.append(tchip);
        });
        fbox.append(picks);
        var fsum = A.el('div', null, 'arc-kv');
        var frow = A.el('div', null, 'arc-kv-row');
        frow.append(A.el('span', '筛选后可见'), A.el('b', String(v.nodes)), A.el('span', '篇'), A.el('b', String(v.edges)), A.el('span', '条引用', 'arc-dim'));
        fsum.append(frow);
        fbox.append(fsum);
        side.append(fbox);
      }

      /* 被引最多的几篇：这才是"引用网络"里真正的枢纽 */
      var hubs = built.nodes.filter(function (n) { return n.deg > 0; }).sort(function (a, b) { return b.deg - a.deg || a.label.localeCompare(b.label, 'zh'); }).slice(0, 6);
      if (hubs.length) {
        side.append(A.el('div', '被引最多', 'arc-h'));
        var hubBox = A.el('div', null, 'arc-cite-list is-side');
        hubs.forEach(function (n) {
          var row = A.el('button', null, 'arc-cite-item');
          row.type = 'button';
          row.title = n.id;
          row.append(A.el('span', n.label, 'arc-cite-name'), A.el('span', String(n.deg), 'arc-cnt'));
          row.onclick = function () { api.open('knowledge', n.id); };
          hubBox.append(row);
        });
        side.append(hubBox);
      }

      /* 标签分布：和 chips 同一套数字，点一行等于点一次 chip（多选并集） */
      if (built.hasTags) {
        side.append(A.el('div', '标签分布', 'arc-h'));
        var tagsBox = A.el('div', null, 'arc-bars');
        built.tagList.slice(0, 10).forEach(function (name) {
          var cnt = built.tagCounts[name];
          var row = A.el('div', null, 'arc-bar-row');
          var topRow = A.el('div', null, 'arc-bar-top');
          topRow.append(A.el('span', name), A.el('span', cnt + ' 篇'));
          var bg = A.el('div', null, 'arc-bar-bg');
          var fill = A.el('div', null, 'arc-bar-fill');
          fill.style.width = Math.min(100, cnt * 16) + '%';
          fill.style.background = A.catColor(name);
          bg.append(fill);
          row.append(topRow, bg);
          if (st.tagSel.indexOf(name) >= 0) row.classList.add('on');
          row.onclick = function () { toggleTag(name); };
          tagsBox.append(row);
        });
        side.append(tagsBox);
        if (built.tagList.length > 10) {
          var rest = built.tagList.length - 10;
          var moreTags = A.el('button', '全部 ' + built.tagList.length + ' 个标签（还有 ' + rest + '）', 'arc-btn is-quiet arc-wide');
          moreTags.type = 'button';
          moreTags.onclick = function () {
            var chip = chips.querySelector('.arc-chip.is-more');
            toggleTagPop(chip || moreTags);
          };
          side.append(moreTags);
        }
      }

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
        if (st.dirSel === name) row.classList.add('on');
        row.onclick = function () { setDir(name); };
        bars.append(row);
      });
      side.append(bars);

      side.append(A.el('div', '交互', 'arc-h'));
      side.append(A.el('p', '滚轮 / 双指缩放 · 空白拖拽平移\n点节点打开笔记，拖拽后固定，双击解除\n标签 chip 可多选（并集），目录 chip 是第二维\n「更多标签」里带搜索', 'arc-detail-desc'));
    }

    /* 挂画布：不再传 parent（没有分类锚点了），节点按引用度数聚散 */
    if (st.graphDispose) { try { st.graphDispose(); } catch (_) {} }
    handle = mountForce(canvasBox, {
      nodes: built.nodes, edges: built.edges, title: '知识图谱',
      noBar: true,
      filterFn: isVisible,
      state: st.graphView || (st.graphView = { scale: 1, tx: 0, ty: 0, mode: 'bh', pos: null }),
      groupColor: function (g) { return A.catColor(g); },
      onPick: function (node) {
        if (!node) return;
        api.open('knowledge', node.id);
      }
    });
    st.graphDispose = handle;
    /* 让验证脚本能核对"边只来自 [[引用]]"：这里记的是真正画上去的数量，
       旧版会多出 doc→目录 的归属边（docs 条），一比就露。 */
    st.graphBuilt = { nodes: built.nodes.length, edges: built.edges.length, cats: built.catList.length, isolated: isolatedNotes, tags: built.tagList.length, tagged: built.nodes.filter(function (n) { return n.tags && n.tags.length; }).length };
    if (st.graphView.mode === 'layered') { handle.setMode('layered'); syncMode('layered'); }
    applyFilter();
  }

  function loadData(st) {
    if (st.graphData && Date.now() - (st.graphAt || 0) < 60000) return Promise.resolve(st.graphData);
    if (st.graphPending) return st.graphPending;
    st.graphPending = fetchGraph().then(function (data) {
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
    /* 半径按画布密度归一：技能轨迹的 size 最高 2.8 倍，387 个节点里最大的圆直径能到 90px，
       几张网就糊死了。n≤220 不缩放（知识图谱原样），更密才整体收。 */
    var rScale = Math.min(1, Math.sqrt(180 / Math.max(1, nodes.length)));
    nodes.forEach(function (node, i) {
      if (options.radius) { radius[i] = options.radius(node, i); return; }
      if (node.kind === 'cat') { radius[i] = 11 + Math.min(7, (node.value || 0) * 1.2); return; }
      radius[i] = Math.max(4.5, Math.min(16, 4.5 + Math.sqrt(degree[i] + 1) * 2.4)) * (node.size || 1) * rScale;
    });
    /* 节点多（技能轨迹 387 个）时，常驻标签只留给调用最多的 10 个大节点。
       以前是「r>10 就画标签」，387 个里一大半 radius 都过 10，一进去就是一片糊字。 */
    var topLabel = null;
    if (nodes.length > 140) {
      topLabel = new Uint8Array(nodes.length);
      var li, lidx = [];
      for (li = 0; li < nodes.length; li++) lidx.push(li);
      lidx.sort(function (x, y) { return radius[y] - radius[x]; });
      for (li = 0; li < Math.min(10, lidx.length); li++) topLabel[lidx[li]] = 1;
    }
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
        布局不重排：sim 里 vis=0 的节点只是不再受力，坐标停在原地，切换 chip 不闪不卡。
        filterFn 是上层传进来的判定（知识图谱按 frontmatter tags + 目录两维），
        有它就完全接管，setFilter(group) 只是老调用方的兼容入口。 */
    var activeFilter = options.filterGroup || '';
    var filterFn = typeof options.filterFn === 'function' ? options.filterFn : null;
    var visible = new Uint8Array(nodes.length); visible.fill(1);
    function recomputeVisible() {
      for (var i = 0; i < nodes.length; i++) {
        var ok = filterFn ? !!filterFn(nodes[i])
          : (!activeFilter || activeFilter === '全部' || (nodes[i].group || '') === activeFilter);
        visible[i] = ok ? 1 : 0;
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
      /* 页面被切走时容器 display:none，宽度是 0。以前这里照算不误，把 716×544 的图
         压成 280×240 再让物理在 280×240 里重排——切回来就是「图挤成一坨 / 看着像没了」。
         宽度缺失只说明「现在不可见」，不代表画布该变小。 */
      if (rect.width < 40) return false;
      cssW = Math.max(280, Math.floor(rect.width));
      cssH = Math.max(240, Math.floor(wrap.clientHeight - bar.offsetHeight - 2) || 420);
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      canvas.style.width = cssW + 'px';
      canvas.style.height = cssH + 'px';
      if (sim) sim.post({ type: 'resize', W: cssW, H: cssH });
      return true;
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

      /* ② 被筛掉的节点：一条边都不画。
         2026-11-14 用户对照案例驳回——案例点筛选是真移除，我这边还留了 α=.07 的底边、
         节点 α=.1，看着就是「东西都还在，只是变暗了」。删掉这一整段，筛选即移除。 */

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
        if (!passes(i)) continue;   /* 筛选掉的节点：不画圆、不描圈、不出标签——真移除 */
        var dim = neighbors && !neighbors[i];
        var ga = dim ? 0.28 : 1;
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
        if (showLabels || i === hover || i === selected || (topLabel && topLabel[i])) {
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
        if (!passes(i)) continue;   /* 筛掉的节点不参与命中：不然鼠标底下是空的却弹提示 */
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

    var started = false;
    function start() {
      /* 页面还没显示（width=0）就别起 worker：先在 280×240 里算一遍，
         等真正显示出来又要重算，白白多花一次全量布局。 */
      if (!resize()) return;
      started = true;
      spawn(function (msg) {
        if (msg.type !== 'frame') return;
        pos = msg.pos; view.pos = pos; alpha = msg.alpha; frameNo = msg.frame;
        if (msg.converged) stats.textContent = nodes.length + ' 节点 · ' + edges.length + ' 连线';
        paintFrame();
      }).then(function (instance) {
        sim = instance;
        var catCount = 0, catNodes = 0;
        for (var ci = 0; ci < nodes.length; ci++) if (nodes[ci].kind === 'cat') { catCount++; catNodes++; }
        if (catCount === 0) catCount = Object.keys(groupIndex).length;
        sim.post({
          type: 'init', n: nodes.length, W: cssW, H: cssH, mode: view.mode,
          theta: 0.9, linkLen: 100, catCount: catCount, anchors: catNodes,
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
      if (w < 40) return;                    /* 不可见：别拿 0 去 resize */
      if (Math.abs(w - cssW) < 8) return;
      resize();
      if (view.pos) paintFrame();
    }) : null;
    if (observer) observer.observe(wrap);

    /* 可见性开关：面板切 tab 是 display:none，不是卸载。
       以前切走之后 worker 还在按 16ms 空转、ResizeObserver 还把画布压成 280×240，
       两头一起坏：CPU 被隐藏的图吃掉（下一个图首帧排队），布局被压变形（切回来像没了）。
       现在切走即 pause，切回即 resize + resume。 */
    var io = window.IntersectionObserver ? new IntersectionObserver(function (list) {
      var on = list[list.length - 1].isIntersecting;
      if (!on) { if (sim) sim.post({ type: 'pause' }); return; }
      if (!started) { start(); return; }
      resize();
      if (sim) sim.post({ type: 'resume' });
      if (view.pos) paintFrame();
    }) : null;
    if (io) io.observe(wrap);

    start();
    /* 老浏览器没有 IntersectionObserver：不能干等着，按可见处理直接起 */
    if (!io && !started) { start(); }
    var dispose = function dispose() {
      if (observer) observer.disconnect();
      if (io) io.disconnect();
      if (sim) sim.dispose();
      view.pos = pos; view.simVer = SIM_VER;
      /* 必须删 DOM：render 可能被 loadCatalog 完成 + hermes:page 各触发一次，
         dispose 只停 worker 不摘节点的话，第二次 mountForce 的 wrap 会叠在
         第一次的残影上，就是用户看到的「画两遍」。 */
      if (wrap && wrap.parentNode) wrap.remove();
    };
    var savedView = null;
    /* 缩放到只剩筛选后的那一撮：真移除之后如果还留着全图的视野，几个点会散在角落，
       看着像"图空了"而不是"只剩这些"。案例换类是重排+自适应，这里不重排，直接把视野收过去。 */
    function fitVisible() {
      if (!pos) return;
      var minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9, cnt = 0;
      for (var i = 0; i < nodes.length; i++) {
        if (!passes(i)) continue;
        var x = pos[i * 2], y = pos[i * 2 + 1];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        cnt++;
      }
      if (cnt < 1) return;
      var pad = 46, bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
      var s = Math.min((cssW - pad * 2) / bw, (cssH - pad * 2) / bh);
      view.scale = Math.max(0.45, Math.min(2.4, s || 1));
      view.tx = cssW / 2 - ((minX + maxX) / 2) * view.scale;
      view.ty = cssH / 2 - ((minY + maxY) / 2) * view.scale;
    }

    /* 可见性变了之后要做的四件事，集合在一处：让 sim 里那批节点彻底不受力、
       视野收到剩下的这一撮（清筛选时再还原），把悬停/选中落在被筛掉节点上的状态清掉，
       最后重画一帧。 */
    function applyVisible(on) {
      recomputeVisible();
      if (sim) sim.post({ type: 'filter', visible: visible });
      if (on) {
        if (!savedView) savedView = { scale: view.scale, tx: view.tx, ty: view.ty };
        fitVisible();
      } else if (savedView) {
        view.scale = savedView.scale; view.tx = savedView.tx; view.ty = savedView.ty; savedView = null;
      }
      if (hover >= 0 && !passes(hover)) { hover = -1; tip.hidden = true; }
      if (selected >= 0 && !passes(selected)) {
        selected = -1;
        if (options.onSelect) options.onSelect(null, -1);
      }
      paintFrame();
    }

    /* 控制句柄：函数本体保持「调用即销毁」，属性给外部工具条用。
       这样老的 st.xxxDispose() 调用一行都不用改。 */
    dispose.setFilter = function (g) {
      activeFilter = g || '';
      filterFn = null;
      applyVisible(!!activeFilter && activeFilter !== '全部');
    };
    /* 上层用判定函数接管可见性（标签/目录两维筛选）。返回筛选后的真实数量，
       验证脚本拿它跟画布上画出来的点对账，不靠数像素。 */
    dispose.setVisibleFilter = function (fn) {
      filterFn = typeof fn === 'function' ? fn : null;
      activeFilter = '';
      var on = false;
      if (filterFn) { for (var i = 0; i < nodes.length; i++) { if (!filterFn(nodes[i])) { on = true; break; } } }
      applyVisible(on);
      return dispose.visibleCounts();
    };
    dispose.visibleCounts = function () {
      var vn = 0, ve = 0;
      for (var i = 0; i < nodes.length; i++) if (visible[i]) vn++;
      for (var k = 0; k < edgePairs.length; k += 2) if (visible[edgePairs[k]] && visible[edgePairs[k + 1]]) ve++;
      return { nodes: vn, edges: ve, total: nodes.length };
    };
    dispose.filter = function () { return filterFn ? '__fn__' : activeFilter; };
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
