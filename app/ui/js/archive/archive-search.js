/* 档案 · 搜索面板（⌘K）
 * 先本地过滤文件名与路径（零延迟），回车再向服务端要正文命中（带 snippet 高亮）。
 * 键盘：↑↓ 选，Enter 打开，Esc 关。 */
window.Archive.register('search', (function () {
  'use strict';

  var A = window.Archive;
  var box = null, input = null, list = null, foot = null;
  var hits = [], cursor = 0, seq = 0, current = null, remoteTerm = '';
  var anchorEl = null, debounce = null;

  /* 位置跟着页头搜索框走（案例的 .search-panel 是 top:48 right:18 的下拉浮层）。
     窗口滚动/缩放时重算，锚点没了就关掉，不留孤儿浮层。 */
  function place() {
    if (!anchorEl || !anchorEl.isConnected) { close(); return; }
    var rect = anchorEl.getBoundingClientRect();
    var vw = window.innerWidth;
    if (vw > 900) {
      var width = Math.min(460, vw - 24);
      box.style.width = width + 'px';
      box.style.left = Math.max(12, Math.min(rect.left, vw - width - 14)) + 'px';
      box.style.right = 'auto';
    } else {
      box.style.width = 'auto';
      box.style.left = '8px';
      box.style.right = '8px';
    }
    box.style.top = Math.round(rect.bottom + 6) + 'px';
  }

  function build() {
    if (box) return;
    box = A.el('div', null, 'arc-search');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', '搜索资料');
    var panel = A.el('div', null, 'arc-search-panel');
    var top = A.el('div', null, 'arc-search-top');
    input = document.createElement('input');
    input.type = 'search';
    input.className = 'arc-search-input';
    input.placeholder = '搜资料：文件名、路径，回车搜正文';
    input.setAttribute('aria-label', '搜索资料');
    var hint = A.el('kbd', 'Esc', 'arc-kbd');
    top.append(input, hint);
    list = A.el('div', null, 'arc-search-list');
    list.setAttribute('role', 'listbox');
    foot = A.el('div', null, 'arc-search-foot');
    panel.append(top, list, foot);
    box.append(panel);
    document.body.append(box);
    /* 下拉浮层没有全屏遮罩，所以点外面要自己关（案例用的是整块 mask） */
    document.addEventListener('pointerdown', function (ev) {
      if (!box.classList.contains('show')) return;
      if (box.contains(ev.target) || (anchorEl && anchorEl.contains(ev.target))) return;
      close();
    }, true);
    window.addEventListener('resize', function () { if (box.classList.contains('show')) place(); });
    window.addEventListener('scroll', function () { if (box.classList.contains('show')) place(); }, true);
    input.addEventListener('input', function () {
      remoteTerm = '';
      if (current) current.searchQ = input.value;
      paint();
      /* 案例是「输入即搜」，本地正文在内存里所以同步；我们正文在服务端，
         给 320ms 防抖后自动补一次正文命中，不用用户再按 ⌘Enter。 */
      clearTimeout(debounce);
      var term = input.value.trim();
      if (term.length < 2) return;
      debounce = setTimeout(function () { if (input.value.trim() === term) searchRemote(term); }, 320);
    });
    input.addEventListener('keydown', onKey);
  }

  function onKey(ev) {
    if (ev.key === 'ArrowDown') { ev.preventDefault(); move(1); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); move(-1); }
    else if (ev.key === 'Enter') {
      ev.preventDefault();
      /* 2026-11-14：原来有本地命中时 Enter 直接 openDoc，正文搜索永远走不到，
         foot 写着「回车搜正文」却是死路。改成 ⌘/Ctrl+Enter 强制搜正文。 */
      if (ev.metaKey || ev.ctrlKey) { searchRemote(input.value.trim()); return; }
      if (hits[cursor]) { pick(hits[cursor]); return; }
      searchRemote(input.value.trim());
    }
  }

  function move(step) {
    if (!hits.length) return;
    cursor = Math.max(0, Math.min(hits.length - 1, cursor + step));
    paintSelection();
  }

  function paintSelection() {
    if (!list) return;
    [].slice.call(list.children).forEach(function (node, index) {
      node.classList.toggle('on', index === cursor);
      if (index === cursor) node.scrollIntoView({ block: 'nearest' });
    });
  }

  function localRows() {
    if (!current) return [];
    var q = input.value.trim().toLowerCase();
    var allowed = current.cfg.sources;
    var items = (current.catalog && current.catalog.items) || [];
    var rows = items.filter(function (item) { return allowed.indexOf(item.source) >= 0; });
    if (!q) return rows.slice(0, 30);
    return rows.filter(function (item) {
      return (item.title || '').toLowerCase().indexOf(q) >= 0
        || (item.path || '').toLowerCase().indexOf(q) >= 0
        || (item.source_name || '').toLowerCase().indexOf(q) >= 0;
    }).slice(0, 40);
  }

  function paint() {
    if (!list) return;
    hits = localRows().slice();
    if (remoteTerm && remoteTerm === input.value.trim()) {
      var seen = {};
      hits.forEach(function (item) { seen[item.source + ':' + item.path] = true; });
      (current.remoteHits || []).forEach(function (item) {
        if (!seen[item.source + ':' + item.path]) hits.push(item);
      });
    }
    if (cursor >= hits.length) cursor = 0;
    renderList();
  }

  function mark(text, term, host) {
    var raw = String(text || ''), lower = raw.toLowerCase(), needle = String(term || '').toLowerCase();
    var at = needle ? lower.indexOf(needle) : -1;
    if (at < 0) { host.textContent = raw; return; }
    host.append(document.createTextNode((at > 0 ? '…' : '') + raw.slice(0, at)));
    host.append(A.el('mark', raw.slice(at, at + needle.length)));
    var rest = raw.slice(at + needle.length);
    if (rest) host.append(document.createTextNode(rest.length > 60 ? rest.slice(0, 60) + '…' : rest));
  }

  function renderList() {
    list.replaceChildren();
    var term = input.value.trim();
    if (!hits.length) {
      list.append(A.el('p', term && remoteTerm !== term ? '本地没命中，按回车搜正文' : '没有匹配的资料。', 'arc-empty'));
      return;
    }
    hits.forEach(function (item, index) {
      var row = A.el('button', null, 'arc-hit' + (index === cursor ? ' on' : ''));
      row.type = 'button';
      row.setAttribute('role', 'option');
      var top = A.el('div', null, 'arc-hit-top');
      top.append(A.el('span', String(item.title || '').replace(/\.md$/i, ''), 'arc-hit-name'));
      top.append(A.el('span', item.snippet ? '正文命中' : '文件名命中', 'arc-hit-badge' + (item.snippet ? ' is-body' : '')));
      var source = A.sourceOf(current, item.source);
      top.append(A.el('span', (source ? source.name + ' · ' : '') + item.path, 'arc-hit-path'));
      row.append(top);
      var snip = A.el('div', null, 'arc-hit-snip');
      if (item.snippet) mark(item.snippet, term, snip);
      else snip.textContent = item.missing ? '尚未建立，打开后可新建' : '文件名或路径匹配';
      row.append(snip);
      row.onmouseenter = function () { cursor = index; paintSelection(); };
      row.onclick = function () { pick(item); };
      list.append(row);
    });
  }

  function searchRemote(term) {
    if (!current || !term) return;
    var mine = ++seq;
    foot.textContent = '正在搜正文…';
    A.call('/api/panel-library?limit=200&q=' + encodeURIComponent(term)).then(function (data) {
      if (mine !== seq || !current) return;
      current.remoteHits = data.items || [];
      remoteTerm = term;
      hits = current.remoteHits.filter(function (item) { return current.cfg.sources.indexOf(item.source) >= 0; });
      cursor = 0;
      if (data.partial) foot.textContent = '命中 ' + hits.length + ' 条（部分文件超大未展开正文）';
      else foot.textContent = '命中 ' + hits.length + ' 条';
      renderList();
    }).catch(function (err) {
      if (mine !== seq) return;
      foot.textContent = '正文搜索失败：' + err.message;
    });
  }

  function pick(item) {
    var st = current;
    close();
    A.openDoc(st, item.source, item.path);
  }

  function open(st, initial, anchor) {
    build();
    current = st;
    cursor = 0;
    seq++;
    /* 每个面板各留各的关键词（案例是 state.query[t]）：切页回来还是上次那句 */
    input.value = initial != null && initial !== '' ? initial : (st.searchQ || '');
    st.searchQ = input.value;
    remoteTerm = '';
    anchorEl = anchor || anchorEl;
    foot.textContent = '上下键选择 · Enter 打开 · Esc 关闭';
    box.classList.add('show');
    place();
    paint();
    setTimeout(function () { input.focus(); input.select(); }, 0);
  }

  function close() {
    if (box) box.classList.remove('show');
    clearTimeout(debounce);
    if (current) { current.searchQ = input.value; current.remoteHits = null; }
    current = null;
    remoteTerm = '';
  }

  return { open: open, close: close };
})());
