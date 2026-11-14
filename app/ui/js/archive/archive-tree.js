/* 档案 · 左侧资料树
 * 按资料来源分组（人格/长期记忆/项目指令/技能/知识库/笔记/日记…）。
 *
 * 结构照案例的递归树（2026-11-14 用户第 4 次驳回后重写）：
 *   分组头 → .arc-kids 容器 → 目录行 / 文件行 → 再套 .arc-kids
 * 每一层 .arc-kids 自带 margin-left + border-left 虚线 + padding-left，
 * 层级是顺着虚线读出来的，不是靠 inline padding 假装缩进（旧版的错）。
 * 目录永远排在文件前面，同级按拼音：zh 排序（旧版按 mtime，看着毫无规律）。
 * 图标一律内联 SVG，不用 emoji（客户端字体一缺就是豆腐块）。
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

  function render(st, host, open) {
    host.replaceChildren();
    var rows = A.rowsOf(st);
    var total = rows.length;

    var head = A.el('div', null, 'arc-rail-head');
    var filter = document.createElement('input');
    filter.type = 'search';
    filter.className = 'arc-filter';
    filter.placeholder = '筛选资料';
    filter.value = st.q;
    filter.setAttribute('aria-label', '筛选资料');
    filter.oninput = function () {
      st.q = filter.value;
      st.remoteHits = null;
      render(st, host, open);
      var again = host.querySelector('.arc-filter');
      if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
    };
    filter.onkeydown = function (ev) {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      if (window.Archive.modules && window.Archive.modules.search) window.Archive.modules.search.open(st, filter.value);
    };
    var expandBtn = A.el('button', '展开', 'arc-rail-btn');
    expandBtn.type = 'button';
    expandBtn.title = '全部展开';
    expandBtn.setAttribute('aria-label', '全部展开');
    expandBtn.onclick = function () { setAllFolded(st, false); render(st, host, open); };
    var foldBtn = A.el('button', '收起', 'arc-rail-btn');
    foldBtn.type = 'button';
    foldBtn.title = '全部收起';
    foldBtn.setAttribute('aria-label', '全部收起');
    foldBtn.onclick = function () { setAllFolded(st, true); render(st, host, open); };
    head.append(filter, expandBtn, foldBtn);
    host.append(head);

    var scroller = A.el('div', null, 'arc-rail-scroll');

    var footbar = A.el('div', null, 'arc-rail-foot');
    var footLeft = A.el('span', total + ' 份', '');
    var mode = '';
    st.cfg.sources.forEach(function (id) {
      var s = A.sourceOf(st, id);
      if (!s) return;
      var label = injectLabel(s);
      if (!mode) mode = label;
      else if (mode !== label) mode = '混合';
    });
    footbar.append(footLeft, A.el('span', mode, ''));
    host.append(scroller, footbar);

    if (st.loading && !st.catalog) {
      scroller.append(A.el('p', '正在读取…', 'arc-empty'));
      return;
    }

    var nav = A.el('nav', null, 'arc-tree');
    st.cfg.sources.forEach(function (id) {
      var source = A.sourceOf(st, id);
      var items = rows.filter(function (item) { return item.source === id; });
      if (!source) return;
      if (!items.length && st.q) return;

      var group = A.el('section', null, 'arc-group');
      var folded = !!st.folded[id] && !st.q;
      var groupHead = A.el('button', null, 'arc-row arc-group-head');
      groupHead.type = 'button';
      groupHead.setAttribute('aria-expanded', folded ? 'false' : 'true');
      groupHead.append(
        caretNode(!folded),
        ico(folded ? 'folder' : 'folderOpen'),
        A.el('span', source.name, 'arc-group-name'),
        A.el('span', injectLabel(source), 'arc-badge' + (source.injected === 'full' ? ' is-full' : '')),
        A.el('span', String(items.length), 'arc-cnt')
      );
      groupHead.onclick = function () {
        st.folded[id] = !st.folded[id];
        A.writeFold(st);
        render(st, host, open);
      };
      group.append(groupHead);

      if (!folded) group.append(walk(buildBranch(items), st, host, open, id, 1, ''));
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
        st.nodes.shell.classList.remove('rail-open');
        A.setView(st, sp.view);
      };
      group.append(row);
      nav.append(group);
    });

    if (!nav.children.length) {
      scroller.append(A.el('p', st.q ? '没有匹配的资料。' : '这个栏目下还没有资料文件。', 'arc-empty'));
      return;
    }
    scroller.append(nav);
  }

  /* 递归：一层目录 = 一行 .arc-row.dir + 一个 .arc-kids 容器 */
  function walk(node, st, host, open, srcId, depth, prefix) {
    var box = A.el('div', null, 'arc-kids');
    sortedKeys(node).forEach(function (key) {
      var child = node.kids[key];
      var path = prefix ? prefix + '/' + key : key;

      if (child.doc) {
        box.append(leafRow(st, child.doc, open, depth));
        return;
      }

      var fk = foldKey(srcId, path);
      var dflt = HEAVY[srcId] ? true : false;
      var folded = (st.folded[fk] !== undefined ? st.folded[fk] : dflt) && !st.q;
      var row = A.el('button', null, 'arc-row arc-dir');
      row.type = 'button';
      row.setAttribute('aria-expanded', folded ? 'false' : 'true');
      row.title = path;
      row.append(
        caretNode(!folded),
        ico(folded ? 'folder' : 'folderOpen'),
        A.el('span', key, 'arc-leaf-name'),
        A.el('span', String(countLeaves(child)), 'arc-cnt')
      );
      row.onclick = function () {
        st.folded[fk] = !folded;
        A.writeFold(st);
        render(st, host, open);
      };
      box.append(row);
      if (!folded) box.append(walk(child, st, host, open, srcId, depth + 1, path));
    });
    return box;
  }

  function leafRow(st, item, open, depth) {
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
    b.append(A.el('span', null, 'arc-caret'), ico('file'), A.el('span', name, 'arc-leaf-name'));
    var meta = item.missing ? '未建立' : kb(item.bytes);
    if (meta) b.append(A.el('span', meta, 'arc-leaf-meta'));
    b.onclick = function () {
      st.nodes.shell.classList.remove('rail-open');
      open(st, item.source, item.path);
    };
    return b;
  }

  return { render: render };
})());
