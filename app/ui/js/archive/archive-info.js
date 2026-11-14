/* 档案 · 基本信息（frontmatter）编辑 + 引用（[[双链]]）插入
 *
 * 为什么单独一个模块：
 *   笔记的元信息（created / tags / 自定义字段）是**结构化数据**，不是正文的一部分。
 *   让用户在 Markdown 编辑区里手写 `--- ... ---` 等于让他写代码，
 *   所以正文编辑器只留 body，元信息走这里独立的键值对面板。
 *
 * 写回策略：
 *   面板只重建 frontmatter，正文取「此刻的正文」——用户可能正编辑着，
 *   编辑区里的内容比磁盘上的新（doc.bodyNow 负责这个判断）。
 *   PUT 带 revision，服务端有并发保护，冲突会 409。
 */
window.Archive.register('info', (function () {
  'use strict';

  var A = window.Archive;

  /* 字段值：单值字符串或字符串数组（数组 = 多值，UI 里一个一行 chip） */
  function isList(v) { return Array.isArray(v); }

  /* ---------- 保存：拼回 frontmatter + 正文 ---------- */
  function persist(st, api, data, order, unknown, done) {
    var doc = st.doc;
    if (!doc) return;
    var body = (A.modules.doc && A.modules.doc.bodyNow) ? A.modules.doc.bodyNow(st) : A.fm.split(doc.content || '').body;
    var content = A.fm.join(data, order, unknown) + body;
    if (content === doc.content) { if (done) done(true); return; }
    var requestId = 'frm-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2));
    api.saving = true;
    A.paintStatus(st, '正在保存基本信息…');
    A.call('/api/panel-library/document', {
      method: 'PUT',
      body: {
        source: doc.source, path: doc.path, root_revision: doc.root_revision,
        revision: doc.revision, exists: doc.exists, request_id: requestId,
        content: content, reason: '面板档案·信息编辑'
      }
    }).then(function (res) {
      api.saving = false;
      A.paintStatus(st, '');
      st.doc = res.document;
      A.toast('基本信息已保存');
      api.rerender();
      if (done) done(true);
    }).catch(function (err) {
      api.saving = false;
      A.paintStatus(st, '保存失败：' + err.message, 'err');
      A.toast('保存失败：' + err.message, 'err');
      if (done) done(false);
    });
  }

  /* ---------- 信息面板 ---------- */
  function openInfo(st, api) {
    var doc = st.doc;
    if (!doc) { A.toast('先打开一份资料', 'warn'); return; }
    var parts = A.fm.split(doc.content || '');
    var order = parts.order.slice();
    var data = {};
    order.forEach(function (k) {
      /* 多值字段顺手去重：库里有一批笔记 tags 里同一个词写了两遍（- 项目 / - 项目），
         面板打开时按去重后的样子给用户看，保存时也照这个写回。 */
      data[k] = isList(parts.data[k]) ? A.fm.uniqTags(parts.data[k]) : parts.data[k];
    });
    var unknown = (parts.unknown || []).slice();

    var dlg = document.createElement('dialog');
    dlg.className = 'arc-dialog arc-dialog-wide';

    var head = A.el('div', null, 'arc-dialog-head');
    head.append(A.el('h3', '基本信息'));
    var closeBtn = A.el('button', '关闭', 'arc-btn is-quiet');
    closeBtn.type = 'button';
    closeBtn.onclick = function () { dlg.close(); };
    head.append(closeBtn);

    var body = A.el('div', null, 'arc-fm');

    /* 提示 + 快速补一个常见字段 */
    var tip = A.el('p', '键值对直接对应笔记顶部的 frontmatter。多值字段（如 tags）一行一个，回车添加。', 'arc-fm-tip');
    body.append(tip);

    var rowsBox = A.el('div', null, 'arc-fm-rows');
    body.append(rowsBox);

    function renderRows() {
      rowsBox.replaceChildren();
      order.forEach(function (key) {
        if (!(key in data)) return;
        rowsBox.append(rowOf(key));
      });
    }

    function rowOf(key) {
      var row = A.el('div', null, 'arc-fm-row');
      var k = A.el('input', null, 'arc-fm-key');
      k.value = key;
      k.setAttribute('aria-label', '字段名');
      k.addEventListener('change', function () {
        var next = k.value.trim();
        if (!next || next === key) { k.value = key; return; }
        data[next] = data[key];
        delete data[key];
        var at = order.indexOf(key);
        order.splice(at, 1, next);
        renderRows();
      });
      row.append(k);

      var valBox = A.el('div', null, 'arc-fm-val');

      if (isList(data[key])) {
        var chips = A.el('div', null, 'arc-fm-chips');
        function paintChips() {
          chips.replaceChildren();
          data[key].forEach(function (item, i) {
            var c = A.el('span', null, 'arc-tag is-edit');
            c.append(A.el('span', '#' + item));
            var x = A.el('button', '×', 'arc-tag-x');
            x.type = 'button';
            x.title = '删除「' + item + '」';
            x.onclick = function () { data[key].splice(i, 1); paintChips(); };
            c.append(x);
            chips.append(c);
          });
          var add = document.createElement('input');
          add.type = 'text';
          add.className = 'arc-fm-add';
          add.placeholder = '加一个，回车';
          add.setAttribute('aria-label', '添加 ' + key);
          add.addEventListener('keydown', function (ev) {
            if (ev.key === 'Enter' && !ev.isComposing) {
              ev.preventDefault();
              var v = add.value.trim();
              if (!v) return;
              data[key] = A.fm.uniqTags(data[key].concat([v]));
              paintChips();
              var again = chips.querySelector('.arc-fm-add');
              if (again) again.focus();
            }
          });
          chips.append(add);
        }
        paintChips();
        valBox.append(chips);
      } else {
        var v = A.el('input', null, 'arc-fm-input');
        v.value = data[key] == null ? '' : String(data[key]);
        v.setAttribute('aria-label', key);
        v.addEventListener('input', function () { data[key] = v.value; });
        valBox.append(v);
      }

      var del = A.el('button', '删除字段', 'arc-fm-del');
      del.type = 'button';
      del.title = '删除这个字段';
      del.append(A.svgIcon('alert', 12));
      del.onclick = function () {
        delete data[key];
        var at = order.indexOf(key);
        if (at >= 0) order.splice(at, 1);
        renderRows();
      };
      row.append(valBox, del);
      return row;
    }

    /* 新增字段：给一组常用键的快捷键，也让用户自己填 */
    var addBar = A.el('div', null, 'arc-fm-addbar');
    var newKey = document.createElement('input');
    newKey.type = 'text';
    newKey.className = 'arc-fm-input';
    newKey.placeholder = '新字段名，如 created / tags / status';
    newKey.setAttribute('aria-label', '新字段名');
    var newType = document.createElement('select');
    newType.className = 'arc-fm-select';
    newType.innerHTML = '<option value="single">单值</option><option value="list">多值（列表）</option>';
    var addBtn = A.el('button', '添加字段', 'arc-btn');
    addBtn.type = 'button';
    addBtn.onclick = function () {
      var key = newKey.value.trim().replace(/\s+/g, '');
      if (!key) { newKey.focus(); return; }
      if (key in data) { A.toast('已经有这个字段了', 'warn'); return; }
      data[key] = newType.value === 'list' ? [] : '';
      order.push(key);
      newKey.value = '';
      renderRows();
      var last = rowsBox.querySelector('.arc-fm-row:last-child .arc-fm-input, .arc-fm-row:last-child .arc-fm-key');
      if (last) last.focus();
    };
    newKey.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && !ev.isComposing) { ev.preventDefault(); addBtn.click(); }
    });
    addBar.append(newKey, newType, addBtn);
    body.append(addBar);

    var acts = A.el('div', null, 'arc-dialog-actions');
    var cancel = A.el('button', '取消', 'arc-btn');
    cancel.type = 'button';
    cancel.onclick = function () { dlg.close(); };
    var ok = A.el('button', '保存', 'arc-btn is-primary');
    ok.type = 'button';
    ok.onclick = function () {
      ok.disabled = true;
      persist(st, api, data, order, unknown, function (good) {
        ok.disabled = false;
        if (good) dlg.close();
      });
    };
    acts.append(cancel, ok);
    body.append(acts);

    dlg.append(head, body);
    document.body.append(dlg);
    dlg.addEventListener('close', function () { dlg.remove(); });
    dlg.showModal();
    renderRows();
    var first = rowsBox.querySelector('.arc-fm-input, .arc-fm-key');
    if (first) first.focus();
  }

  /* ---------- 可引用笔记清单 ---------- */
  function candidates(st, q) {
    var rows = A.rowsOf(st);
    var self = st.doc ? st.doc.path : '';
    var seen = {}, out = [];
    var needle = String(q || '').trim().toLowerCase();
    rows.forEach(function (item) {
      if (item.path === self) return;
      var name = String(item.title || item.path).replace(/\.md$/i, '');
      if (seen[name]) return;
      if (needle && name.toLowerCase().indexOf(needle) < 0 && String(item.path).toLowerCase().indexOf(needle) < 0) return;
      seen[name] = 1;
      out.push({ name: name, path: item.path, source: item.source, bytes: item.bytes });
    });
    return out;
  }

  /* 把 [[名字]] 插到光标处；没在编辑就先进编辑态（由调用方保证） */
  function insertWiki(st, name) {
    var area = null;
    var doc = document.querySelector('.arc-area');
    if (!doc) { A.toast('先在编辑器里定位插入位置', 'warn'); return; }
    area = doc;
    var token = '[[' + name + ']]';
    var start = area.selectionStart == null ? area.value.length : area.selectionStart;
    var end = area.selectionEnd == null ? start : area.selectionEnd;
    area.setRangeText(token, start, end, 'end');
    area.dispatchEvent(new Event('input'));
    area.focus();
  }

  /* ---------- 引用选择器（按钮） ---------- */
  function openCite(st, api) {
    if (!st.doc) { A.toast('先打开一份资料', 'warn'); return; }
    if (!st.doc.editable) { A.toast('这份资料不可编辑', 'warn'); return; }
    /* 不在编辑态就先切进去，否则没有插入点 */
    var areaEl = document.querySelector('.arc-area');
    if (areaEl && areaEl.closest('.arc-editor') && areaEl.closest('.arc-editor').hidden) {
      if (A.modules.doc) A.modules.doc.toggleEdit(st);
    }

    var dlg = document.createElement('dialog');
    dlg.className = 'arc-dialog';
    var head = A.el('div', null, 'arc-dialog-head');
    head.append(A.el('h3', '插入引用'));
    var closeBtn = A.el('button', '关闭', 'arc-btn is-quiet');
    closeBtn.type = 'button';
    closeBtn.onclick = function () { dlg.close(); };
    head.append(closeBtn);

    var body = A.el('div', null, 'arc-fm');
    body.append(A.el('p', '选中一篇笔记，会在光标处插入 [[笔记名]]。被引用的笔记会出现在知识图谱里。', 'arc-fm-tip'));

    var box = A.el('div', null, 'arc-searchbox arc-cite-search');
    box.append(A.svgIcon('search', 14));
    var input = document.createElement('input');
    input.type = 'search';
    input.placeholder = '找笔记：名字或路径';
    input.setAttribute('aria-label', '找笔记');
    box.append(input);
    body.append(box);

    var list = A.el('div', null, 'arc-cite-list');
    body.append(list);

    function paint() {
      var q = input.value;
      var items = candidates(st, q).slice(0, 60);
      list.replaceChildren();
      if (!items.length) { list.append(A.el('p', '没有匹配的笔记。', 'arc-empty')); return; }
      items.forEach(function (item) {
        var row = A.el('button', null, 'arc-cite-item');
        row.type = 'button';
        row.append(A.svgIcon('file', 14));
        var nameBox = A.el('span', null, 'arc-cite-name');
        nameBox.textContent = item.name;
        var pathBox = A.el('span', null, 'arc-cite-path');
        pathBox.textContent = item.path;
        row.append(nameBox, pathBox);
        row.onclick = function () {
          insertWiki(st, item.name);
          dlg.close();
          A.toast('已插入 [[' + item.name + ']]');
        };
        list.append(row);
      });
    }
    input.addEventListener('input', paint);
    input.addEventListener('keydown', function (ev) {
      if (ev.isComposing) return;
      if (ev.key === 'Enter') {
        ev.preventDefault();
        var first = list.querySelector('.arc-cite-item');
        if (first) first.click();
      }
    });

    dlg.append(head, body);
    document.body.append(dlg);
    dlg.addEventListener('close', function () { dlg.remove(); });
    dlg.showModal();
    paint();
    input.focus();
  }

  /* ---------- 正文里打 [[ 的自动补全 ----------
     锚在编辑器容器内（absolute），不跟着光标飞——光标位置在 textarea 里算不准，
     跟着飞的浮层一半时间会挡住正在打的字。 */
  function wireCite(area, st) {
    if (!area || area._arcCiteWired) return;
    area._arcCiteWired = true;
    var editor = area.closest('.arc-editor') || area.parentElement;
    var pop = null, items = [], active = 0, tokenStart = -1;

    function close() {
      if (pop) { pop.remove(); pop = null; }
      items = []; active = 0; tokenStart = -1;
    }
    function paintPop() {
      if (!pop) return;
      pop.replaceChildren();
      if (!items.length) { pop.append(A.el('p', '没有匹配的笔记', 'arc-cite-empty')); return; }
      items.forEach(function (item, i) {
        var row = A.el('button', null, 'arc-cite-item' + (i === active ? ' on' : ''));
        row.type = 'button';
        row.append(A.el('span', item.name, 'arc-cite-name'), A.el('span', item.path, 'arc-cite-path'));
        row.addEventListener('mousedown', function (ev) {
          ev.preventDefault();   /* 别让 textarea 失焦，否则插入点丢了 */
          apply(item);
        });
        pop.append(row);
      });
      var on = pop.querySelector('.arc-cite-item.on');
      if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
    }
    function open(list) {
      items = list; active = 0;
      if (!pop) {
        pop = A.el('div', null, 'arc-cite-pop');
        (editor || document.body).append(pop);
      }
      paintPop();
    }
    function apply(item) {
      if (tokenStart < 0) { close(); return; }
      var token = '[[' + item.name + ']]';
      area.setRangeText(token, tokenStart, area.selectionStart, 'end');
      close();
      area.dispatchEvent(new Event('input'));
      area.focus();
    }
    /* 从光标往前找最近的 “[["，中间不许有 ] 或换行 */
    function detect() {
      var pos = area.selectionStart;
      var before = String(area.value).slice(0, pos);
      var i = before.lastIndexOf('[[');
      if (i < 0) return null;
      var between = before.slice(i + 2);
      if (/[\]\n]/.test(between)) return null;
      return { start: i, q: between };
    }
    area.addEventListener('input', function (ev) {
      if (ev.isComposing) return;
      var hit = detect();
      if (!hit) { close(); return; }
      tokenStart = hit.start;
      var list = candidates(st, hit.q).slice(0, 12);
      if (!list.length) { close(); return; }
      open(list);
    });
    area.addEventListener('keydown', function (ev) {
      if (ev.isComposing) return;
      if (!pop) return;
      if (ev.key === 'ArrowDown') { ev.preventDefault(); active = (active + 1) % items.length; paintPop(); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); active = (active - 1 + items.length) % items.length; paintPop(); }
      else if (ev.key === 'Enter' || ev.key === 'Tab') { ev.preventDefault(); apply(items[active]); }
      else if (ev.key === 'Escape') { ev.preventDefault(); close(); }
    });
    area.addEventListener('blur', function () { setTimeout(close, 120); });
  }

  return { openInfo: openInfo, openCite: openCite, wireCite: wireCite };
})());
