/* 档案 · 全文搜索面板
 *
 * 2026-11-15 用户第三次打回：「触发全文搜索之后，全文搜索面板是弹出来的，现在是遮盖住的，
 * 能复用的样式就用会话里面的，不要重复做弹出框、搜索框」。
 *
 * 改法：不再自造 .arc-search 下拉浮层（它挂在 body 上、靠 place() 跟着锚点走，
 * 层级又低，被左栏抽屉和遮罩压住），直接调 ui.modal() —— 与会话页 pwSearch 同一个弹窗组件，
 * 结果行用同一套 .pw-results / .pw-result 样式。弹窗 z-index 从 6000 起，永远在最上层，
 * Esc / 点遮罩 / 关按钮都由 ui-kit 统一处理。
 *
 * 数据侧照旧：本地文件名 + 路径零延迟，服务端正文命中（带 snippet 高亮）防抖 320ms 补上。
 * 键盘：↑↓ 选，Enter 打开，Esc 关闭。
 */
window.Archive.register('search', (function () {
  'use strict';

  var A = window.Archive;
  var dlg = null, input = null, list = null, status = null;
  var hits = [], cursor = 0, seq = 0, current = null, remoteTerm = '', debounce = null;

  function q(sel) { return dlg ? dlg.bodyEl.querySelector(sel) : null; }

  function build() {
    if (dlg) return;
    dlg = window.ui.modal({
      title: '搜索所有资料',
      width: 560,
      className: 'arc-search-modal',
      bodyHTML:
        '<input id="arcSearchQ" type="search" placeholder="搜索资料：文件名、路径、正文" autocomplete="off" aria-label="搜索资料">' +
        '<div class="pw-hint" id="arcSearchStatus"></div>' +
        '<div class="pw-results" id="arcSearchResults"></div>',
      onClose: function () {
        clearTimeout(debounce);
        dlg = null; input = null; list = null; status = null;
        hits = []; cursor = 0; remoteTerm = '';
        current = null;
      }
    });
    input = q('#arcSearchQ');
    list = q('#arcSearchResults');
    status = q('#arcSearchStatus');
    input.addEventListener('input', function () {
      remoteTerm = '';
      if (current) current.searchQ = input.value;
      paint();
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
    var term = input.value.trim().toLowerCase();
    var allowed = current.cfg.sources;
    var items = (current.catalog && current.catalog.items) || [];
    var rows = items.filter(function (item) { return allowed.indexOf(item.source) >= 0; });
    if (!term) return rows.slice(0, 30);
    return rows.filter(function (item) {
      return (item.title || '').toLowerCase().indexOf(term) >= 0
        || (item.path || '').toLowerCase().indexOf(term) >= 0
        || (item.source_name || '').toLowerCase().indexOf(term) >= 0;
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

  /* 结果行沿用会话页全局搜索的 .pw-result 结构：<b>标题</b> <small>来源 · 路径</small><p>摘要</p> */
  function renderList() {
    list.replaceChildren();
    var term = input.value.trim();
    if (!hits.length) {
      list.append(A.el('p', term && remoteTerm !== term ? '本地没命中，按回车搜正文' : '没有找到匹配内容。', 'pw-hint'));
      return;
    }
    hits.forEach(function (item, index) {
      var row = A.el('button', null, 'pw-result' + (index === cursor ? ' on' : ''));
      row.type = 'button';
      var head = A.el('div');
      head.append(A.el('b', String(item.title || '').replace(/\.md$/i, '')));
      var source = A.sourceOf(current, item.source);
      head.append(A.el('small', ' ' + (source ? source.name + ' · ' : '') + item.path +
        (item.snippet ? ' · 正文命中' : ' · 文件名命中')));
      row.append(head);
      var para = A.el('p');
      if (item.snippet) mark(item.snippet, term, para);
      else para.textContent = item.missing ? '尚未建立，打开后可新建' : '文件名或路径匹配';
      row.append(para);
      row.onmouseenter = function () { cursor = index; paintSelection(); };
      row.onclick = function () { pick(item); };
      list.append(row);
    });
  }

  function searchRemote(term) {
    if (!current || !term) return;
    var mine = ++seq;
    if (status) status.textContent = '正在搜正文…';
    A.call('/api/panel-library?limit=200&q=' + encodeURIComponent(term)).then(function (data) {
      if (mine !== seq || !current || !status) return;
      current.remoteHits = data.items || [];
      remoteTerm = term;
      hits = current.remoteHits.filter(function (item) { return current.cfg.sources.indexOf(item.source) >= 0; });
      cursor = 0;
      status.textContent = '命中 ' + hits.length + ' 条' + (data.partial ? '（部分文件超大未展开正文）' : '') +
        ' · ↑↓ 选择 · Enter 打开';
      renderList();
    }).catch(function (err) {
      if (mine !== seq || !status) return;
      status.textContent = '正文搜索失败：' + err.message;
    });
  }

  function pick(item) {
    var st = current;
    if (dlg) dlg.close('pick');
    A.openDoc(st, item.source, item.path);
  }

  function open(st, initial) {
    build();
    current = st;
    cursor = 0;
    seq++;
    input.value = initial != null && initial !== '' ? initial : (st.searchQ || '');
    st.searchQ = input.value;
    remoteTerm = '';
    status.textContent = '↑↓ 选择 · Enter 打开 · Esc 关闭';
    paint();
    setTimeout(function () { try { input.focus(); input.select(); } catch (e) {} }, 0);
  }

  function close() { if (dlg) dlg.close('api'); }

  /* 点放大镜 = 弹面板 + 直接搜正文，并把框里的词带进去。词为空时退回输入框，不弹空面板。 */
  function openRemote(st, term) {
    var t = String(term == null ? '' : term).trim();
    if (!t) { if (dlg) close(); return; }
    open(st, t);
    searchRemote(t);
  }

  return { open: open, openRemote: openRemote, close: close };
})());
