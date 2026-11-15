/* 档案 · 左侧资料树
 * 按资料来源分组（人格/长期记忆/项目指令/技能/知识库/笔记/日记…）。
 *
 * 结构照案例的递归树（2026-11-14 用户第 4 次驳回后重写）：
 *   分组头 → .arc-kids 容器 → 目录行 / 文件行 → 再套 .arc-kids
 * 每一层 .arc-kids 自带 margin-left + border-left 虚线 + padding-left，
 * 层级是顺着虚线读出来的，不是靠 inline padding 假装缩进（旧版的错）。
 * 目录永远排在文件前面，同级按拼音：zh 排序（旧版按 mtime，看着毫无规律）。
 * 图标一律内联 SVG，不用 emoji（客户端字体一缺就是豆腐块）。
 *
 * 2026-11-14 第二次重写：
 *   ① 外壳（筛选框/展开收起/底栏）只建一次，输入时只重画树本体。
 *      旧版每次 oninput 都 replaceChildren 整个左栏，连正在组字的输入框一起换掉——
 *      中文输入法一被打断就只能出英文，粘贴能进去但打不出来。这是"中文变英文"的真根因。
 *   ② 组字期间（isComposing / compositionstart..end）不重绘，组完再画。
 *   ③ 重绘压到 90ms 防抖：707 篇的树每敲一个字母重建一遍，打字会一顿一顿。
 *   ④ 筛选命中不再只看叶子名：目录名单独判定并高亮，命中目录就保留它底下所有文件
 *      （path 里本来就带目录名，这里把它写成显式规则，行为可预期）。
 */
window.Archive.register('tree', (function () {
  'use strict';

  var A = window.Archive;
  /* 这两个来源动辄几百上千篇，目录默认折叠；其余来源默认全展开 */
  var HEAVY = { knowledge: 1, skills: 1 };

  function kb(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(bytes < 10240 ? 1 : 0) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  function injectLabel(source) {
    if (!source) return '';
    if (source.injected === 'full') return '全文注入';
    if (source.injected === 'index') return '索引';
    return '不注入';
  }

  /* ---------- 扁平行 → 嵌套树 ----------
     行是 {source, path, title, bytes}，path 形如 "01-项目/2026-11-14-xxx.md"。
     按 / 拆开逐级挂 kids，父目录自动出现（被筛选剩一个叶子时祖先也还在）。 */
  function buildBranch(items) {
    var root = { kids: {}, name: '' };
    items.forEach(function (item) {
      var parts = String(item.path || '').split('/');
      var leafName = parts.pop();
      var node = root;
      parts.forEach(function (dir) {
        if (!node.kids[dir]) node.kids[dir] = { kids: {}, name: dir, dir: true };
        node = node.kids[dir];
      });
      node.kids[leafName] = { doc: item, name: leafName, kids: {} };
    });
    return root;
  }

  /* 目录优先，同级按拼音。案例用 zh collation，默认 sort() 是码点序，中文全乱。 */
  function sortedKeys(node) {
    return Object.keys(node.kids).sort(function (a, b) {
      var na = node.kids[a], nb = node.kids[b];
      var da = na.doc ? 1 : 0, db = nb.doc ? 1 : 0;
      if (da !== db) return da - db;
      return a.localeCompare(b, 'zh');
    });
  }

  function countLeaves(node) {
    if (node.doc) return 1;
    var n = 0;
    Object.keys(node.kids).forEach(function (k) { n += countLeaves(node.kids[k]); });
    return n;
  }

  function foldKey(srcId, path) { return srcId + ':' + path; }

  /* 全部展开 / 全部收起：先清空再按树里出现的每个目录写入显式值。
     删键不等于收起——默认值可能正好是展开，2026-11-14 踩过。 */
  function setAllFolded(st, folded) {
    var next = {};
    st.cfg.sources.forEach(function (id) { next[id] = folded; });
    A.rowsOf(st).forEach(function (item) {
      var parts = String(item.path || '').split('/');
      parts.pop();
      var acc = [];
      parts.forEach(function (p) {
        acc.push(p);
        next[foldKey(item.source, acc.join('/'))] = folded;
      });
    });
    st.folded = next;
    A.writeFold(st);
  }

  function ico(name, size) {
    var s = A.el('span', null, 'arc-ti');
    s.append(A.svgIcon(name, size || 14));
    return s;
  }
  function caretNode(open) {
    var s = A.el('span', null, 'arc-caret' + (open ? ' is-open' : ''));
    s.append(A.svgIcon('chevron', 12));
    return s;
  }

  /* 命中的那一段套 <mark>，让人一眼看出是名字命中还是目录命中 */
  function markText(text, q) {
    var raw = String(text == null ? '' : text);
    if (!q) return document.createTextNode(raw);
    var i = raw.toLowerCase().indexOf(q);
    if (i < 0) return document.createTextNode(raw);
    var frag = document.createDocumentFragment();
    frag.append(document.createTextNode(raw.slice(0, i)));
    var m = document.createElement('mark');
    m.className = 'arc-hit-mark';
    m.textContent = raw.slice(i, i + q.length);
    frag.append(m, document.createTextNode(raw.slice(i + q.length)));
    return frag;
  }

  /* ---------- 外壳：只建一次 ---------- */
  function ensureShell(st, host, open) {
    if (host.dataset.arcShell === '1' && host._arcParts) return host._arcParts;
    host.replaceChildren();

    var p = {};
    var head = A.el('div', null, 'arc-rail-head');
    var filter = document.createElement('input');
    filter.type = 'search';
    filter.className = 'arc-filter';
    filter.placeholder = '筛选文件夹或文件名…';
    filter.value = st.q;
    filter.setAttribute('aria-label', '按文件夹名或文件名筛选');
    p.filter = filter;

    /* 组字标记放在闭包里，不塞 st（切页后状态还在，会卡住下一次输入） */
    var composing = false;
    function apply() {
      st.q = filter.value;
      st.remoteHits = null;
      clearTimeout(p.timer);
      p.timer = setTimeout(function () { paint(st, p, host, open); }, 90);
    }
    filter.addEventListener('compositionstart', function () { composing = true; });
    filter.addEventListener('compositionend', function () {
      composing = false;
      apply();
    });
    filter.addEventListener('input', function (ev) {
      /* 组字中不重绘：重绘会把输入框里正在组的那串字打断，之后只能出英文 */
      if (composing || ev.isComposing) return;
      apply();
    });
    filter.onkeydown = function (ev) {
      if (ev.isComposing) return;
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      /* 回车等同点放大镜：把词带进全文搜索面板并直接搜正文 */
      var term = filter.value.trim();
      if (!term) { filter.focus(); return; }
      if (A.modules && A.modules.search && A.modules.search.openRemote) A.modules.search.openRemote(st, term);
    };

    /* 筛选条照会话左栏的 #railFilterInput + #railFilterBtn：输入框在左，
       放大镜是右侧一颗独立方按钮（2026-11-15 用户第三次点明：放大镜是分开的、在右）。
       样式整段复用 base.css 的 .rail-filter，档案页不再自造外壳。
       分工：输入 = 就地筛文件夹和文件名；点放大镜 = 弹全文搜索面板并带词；回车同放大镜。 */
    var filterBox = A.el('div', null, 'rail-filter arc-rail-filter');
    var goBtn = A.el('button', null, '');
    goBtn.type = 'button';
    goBtn.id = 'arcFilterBtn';
    goBtn.title = '在所有资料中搜索';
    goBtn.setAttribute('aria-label', '在所有资料中搜索');
    goBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><line x1="16.4" y1="16.4" x2="21" y2="21"/></svg>';
    goBtn.onclick = function (ev) {
      ev.preventDefault();
      var term = filter.value.trim();
      if (!term) { filter.focus(); return; }
      if (A.modules && A.modules.search && A.modules.search.openRemote) A.modules.search.openRemote(st, term);
    };
    filterBox.append(filter, goBtn);

    /* 「展开」「收起」两个按钮 2026-11-15 去掉：档案页只留顶栏那一颗抽屉按钮，
       树内单个文件夹的折叠箭头保留（那是树本身，不是重复入口）。 */
    head.append(filterBox);
    host.append(head);

    p.scroller = A.el('div', null, 'arc-rail-scroll');

    var footbar = A.el('div', null, 'arc-rail-foot');
    p.count = A.el('span', '0 份', '');
    p.mode = A.el('span', '', '');
    footbar.append(p.count, p.mode);
    host.append(p.scroller, footbar);

    host.dataset.arcShell = '1';
    host._arcParts = p;
    return p;
  }

  function render(st, host, open) {
    var p = ensureShell(st, host, open);
    paint(st, p, host, open);
  }

  /* ---------- 树本体：输入时只重画这里 ---------- */
  /* 重绘第一句是 scroller.replaceChildren()：整棵子树连同滚动位置一起被扔掉，
     位置能不能自己活下来全看引擎（本机 Chromium 实测能活，用户那台会归零 →
     「滚到下面展开一个文件夹，列表一下跳回最上面」）。另外每重建一次，
     700+ 行 DOM 都要重新构造。所以：画之前记位置、画完放回去；
     换了筛选词才回顶部——那是换了一批结果，留着位置没意义。 */
  function paint(st, p, host, open) {
    var q = String(st.q || '').trim().toLowerCase();
    var prevTop = p.scroller.scrollTop;
    var keepScroll = q === p.lastQ && prevTop > 0;
    p.lastQ = q;
    try {
      paintTree(st, p, host, open, q);
    } finally {
      if (keepScroll) {
        p.scroller.scrollTop = prevTop;
        /* 新内容要等一次重排才定高，下一帧再兜一次；超出可滚范围就贴底 */
        requestAnimationFrame(function () {
          var max = p.scroller.scrollHeight - p.scroller.clientHeight;
          var want = Math.min(prevTop, max > 0 ? max : 0);
          if (Math.abs(p.scroller.scrollTop - want) > 0.5) p.scroller.scrollTop = want;
        });
      } else if (prevTop > 0) {
        /* 换筛选词：结果集变了，显式回顶部，别指望浏览器替我们钳 */
        p.scroller.scrollTop = 0;
      }
    }
  }

  function paintTree(st, p, host, open, q) {
    var scroller = p.scroller;
    var rows = A.rowsOf(st);
    p.count.textContent = rows.length + ' 份';

    var mode = '';
    st.cfg.sources.forEach(function (id) {
      var s = A.sourceOf(st, id);
      if (!s) return;
      var label = injectLabel(s);
      if (!mode) mode = label;
      else if (mode !== label) mode = '混合';
    });
    p.mode.textContent = mode;

    scroller.replaceChildren();

    if (st.loading && !st.catalog) {
      scroller.append(A.el('p', '正在读取…', 'arc-empty'));
      return;
    }

    /* 名字一个都没筛到：原来只剩一个空左栏，看着像崩了。
       这里给一句话 + 一个「搜正文」的出口——名字没有不代表正文没有。 */
    if (q && !rows.length) {
      var none = A.el('div', null, 'arc-empty arc-empty-q');
      none.append(A.el('p', '没有名字含「' + String(st.q).trim() + '」的文件夹或文件', 'arc-empty-t'));
      var go = A.el('button', '搜正文试试', 'arc-empty-btn');
      go.type = 'button';
      go.onclick = function () {
        if (A.modules && A.modules.search && A.modules.search.openRemote) A.modules.search.openRemote(st, st.q);
      };
      none.append(go);
      scroller.append(none);
      return;
    }

    var nav = A.el('nav', null, 'arc-tree');
    st.cfg.sources.forEach(function (id) {
      var source = A.sourceOf(st, id);
      var items = rows.filter(function (item) { return item.source === id; });
      if (!source) return;
      if (!items.length && q) return;

      var group = A.el('section', null, 'arc-group');
      var folded = !!st.folded[id] && !q;
      var groupHead = A.el('button', null, 'arc-row arc-group-head');
      groupHead.type = 'button';
      groupHead.dataset.depth = '0';
      groupHead.setAttribute('aria-expanded', folded ? 'false' : 'true');
      groupHead.append(
        caretNode(!folded),
        ico('folderFill'),
        A.el('span', source.name, 'arc-group-name'),
        A.el('span', injectLabel(source), 'arc-badge' + (source.injected === 'full' ? ' is-full' : '')),
        A.el('span', String(items.length), 'arc-cnt')
      );
      groupHead.onclick = function () {
        st.folded[id] = !st.folded[id];
        A.writeFold(st);
        paint(st, p, host, open);
      };
      group.append(groupHead);

      if (!folded) group.append(walk(buildBranch(items), st, p, host, open, id, q, ''));
      nav.append(group);
    });

    /* 左栏底部特殊入口（案例 tree-group）：密码本不是页签，是这里的独立一行。 */
    (st.cfg.specials || []).forEach(function (sp) {
      var group = A.el('section', null, 'arc-group arc-group-special');
      var on = st.view === sp.view;
      var row = A.el('button', null, 'arc-row arc-special' + (on ? ' on' : ''));
      row.type = 'button';
      row.dataset.special = sp.view;
      row.title = sp.label;
      row.append(ico(sp.icon || 'lock'), A.el('span', sp.label, 'arc-special-name'));
      if (typeof st.vaultCount === 'number') row.append(A.el('span', String(st.vaultCount), 'arc-cnt'));
      row.onclick = function () {
        A.closeRailDrawer();
        A.setView(st, sp.view);
      };
      group.append(row);
      nav.append(group);
    });

    if (!nav.children.length) {
      scroller.append(A.el('p', q ? '没有匹配的资料。' : '这个栏目下还没有资料文件。', 'arc-empty'));
      return;
    }
    scroller.append(nav);
  }

  /* 单个目录的展开/收起：就地增删那一段 .arc-kids，不碰整棵树。
     整棵重画会把旧节点全扔掉，滚动位置在有些引擎上直接归零（用户那台就是）；
     就地换子树则一行不动，滚动位置根本没机会丢。
     只有 .arc-kids 是展开着的目录、且它紧接着这一行才算命中结构（walk 里就是这么 append 的）。 */
  function toggleKids(row, child, nowFolded, st, p, host, open, srcId, q, path) {
    row.setAttribute('aria-expanded', nowFolded ? 'false' : 'true');
    var caret = row.querySelector('.arc-caret');
    if (caret) caret.classList.toggle('is-open', !nowFolded);
    var ti = row.querySelector('.arc-ti');
    if (ti) ti.replaceChildren(A.svgIcon('folderFill', 14));
    var sib = row.nextElementSibling;
    var hasKids = !!(sib && sib.classList && sib.classList.contains('arc-kids'));
    if (nowFolded) {
      if (hasKids) sib.remove();
      return;
    }
    if (!hasKids) row.after(walk(child, st, p, host, open, srcId, q, path));
  }

  /* 递归：一层目录 = 一行 .arc-row.dir + 一个 .arc-kids 容器 */
  function walk(node, st, p, host, open, srcId, q, prefix) {
    var box = A.el('div', null, 'arc-kids');
    sortedKeys(node).forEach(function (key) {
      var child = node.kids[key];
      var path = prefix ? prefix + '/' + key : key;

      if (child.doc) {
        box.append(leafRow(st, child.doc, open, q));
        return;
      }

      var fk = foldKey(srcId, path);
      var dflt = HEAVY[srcId] ? true : false;
      var folded = (st.folded[fk] !== undefined ? st.folded[fk] : dflt) && !q;
      var row = A.el('button', null, 'arc-row arc-dir');
      row.type = 'button';
      /* 层级写进 DOM：CSS 按 data-depth 上四档色块和逐层字号（会话树的 data-depth 同款做法） */
      row.dataset.depth = String(prefix ? prefix.split('/').length : 0);
      row.setAttribute('aria-expanded', folded ? 'false' : 'true');
      row.title = path;
      var name = A.el('span', null, 'arc-leaf-name');
      /* 目录名也参与高亮：搜索"项目"时能看见自己命中的是哪一层 */
      name.append(markText(key, q));
      row.append(
        caretNode(!folded),
        ico('folderFill'),
        name,
        A.el('span', String(countLeaves(child)), 'arc-cnt')
      );
      row.onclick = function () {
        /* 状态从 DOM 读，不用闭包里那个渲染时的 folded：
           就地切换后闭包还停在旧值，第二次点会把"已收起"再收一次，看着像点不动。 */
        var nowFolded = row.getAttribute('aria-expanded') === 'true';
        st.folded[fk] = nowFolded;
        A.writeFold(st);
        /* 有筛选词时保持老行为（搜索态一律展开，重画才一致）；
           没有筛选词就地换子树，整棵重画会把滚动位置打到顶部 */
        if (!q) { toggleKids(row, child, nowFolded, st, p, host, open, srcId, q, path); return; }
        paint(st, p, host, open);
      };
      box.append(row);
      if (!folded) box.append(walk(child, st, p, host, open, srcId, q, path));
    });
    return box;
  }

  function leafRow(st, item, open, q) {
    /* 只在文档视图里高亮选中的文件：停在密码本/图谱时左边还亮着一个文件，
       会让人以为主区显示的还是那份文档。 */
    var on = st.view === 'doc' && st.doc && st.doc.source === item.source && st.doc.path === item.path;
    var b = A.el('button', null, 'arc-row arc-leaf' + (on ? ' on' : '') + (item.missing ? ' is-missing' : ''));
    b.type = 'button';
    b.dataset.source = item.source;
    b.dataset.path = item.path;
    b.title = item.path;
    var name = String(item.title || item.path).replace(/\.md$/i, '');
    /* 文件行补一个和折叠箭头同宽的占位：目录行有 caret(12)+gap(7) 才到图标，
       文件行不补就会顶到父级箭头那一列，名字看着比父级还靠左，像退了一级。 */
    b.append(A.el('span', null, 'arc-caret'), ico('fileFill'));
    var label = A.el('span', null, 'arc-leaf-name');
    label.append(markText(name, q));
    b.append(label);
    var meta = item.missing ? '未建立' : kb(item.bytes);
    if (meta) b.append(A.el('span', meta, 'arc-leaf-meta'));
    b.onclick = function () {
      A.closeRailDrawer();
      open(st, item.source, item.path);
    };
    return b;
  }

  return { render: render };
})());
