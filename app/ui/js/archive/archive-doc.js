/* 档案 · 文档视图（2026-11-14 对照案例重排）
 *
 * 结构照案例的三段式：
 *   通栏文档头  图标块 / 路径+大标题+标签行 / 动作区（编辑·下载·复制·修改记录）
 *   居中正文栏  最大 940，14.5px / 1.85，右侧固定目录 172px
 *   编辑器      一块 textarea（不再做行号槽），上面一条说明+操作栏
 *
 * 写入统一走 /api/panel-library/document（B 通道）：root_revision + revision 双重校验、
 * 写前 base64 备份、原子 rename、可撤销记录。不要绕到 /api/memory 去直接覆盖文件。
 */
window.Archive.register('doc', (function () {
  'use strict';

  var A = window.Archive;
  var state = { editing: false, saving: false, dirty: false, draftTimer: null };

  function kb(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(2) + ' MB';
  }
  function when(ts) {
    if (!ts) return '';
    var d = new Date(ts), p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function draftKey(doc) { return 'archive-draft:' + doc.source + ':' + doc.path; }
  function readDraft(doc) {
    try { return JSON.parse(localStorage.getItem(draftKey(doc)) || 'null'); } catch (_) { return null; }
  }
  function writeDraft(doc, text) {
    try {
      if (text === doc.content) localStorage.removeItem(draftKey(doc));
      else localStorage.setItem(draftKey(doc), JSON.stringify({ text: text, base: doc.revision, at: Date.now() }));
    } catch (_) {}
  }
  function clearDraft(doc) {
    try { localStorage.removeItem(draftKey(doc)); } catch (_) {}
  }

  /* icon 可以传字符串，也可以直接传一个 SVG 节点（2026-11-14 起图标统一走 SVG） */
  function emptyBlock(icon, title, desc) {
    var box = A.el('div', null, 'arc-empty-block');
    var ic = A.el('div', null, 'arc-empty-icon');
    if (icon && typeof icon === 'object') ic.append(icon);
    else if (icon) ic.textContent = icon;
    box.append(ic, A.el('h3', title));
    if (desc) box.append(A.el('p', desc));
    return box;
  }

  function render(st, host, api) {
    var doc = st.doc;
    if (!doc) {
      host.replaceChildren(emptyBlock(A.svgIcon('file', 30), '选择一份资料', '从左边选一份，或按 ⌘K 搜索标题与正文。'));
      A.foot(st, { left: '', mid: '', right: '' });
      return;
    }
    host.replaceChildren();

    var wrap = A.el('div', null, 'arc-doc');
    var head = A.el('div', null, 'arc-doc-head');

    var source = A.sourceOf(st, doc.source);
    var segments = String(doc.path || '').split('/');
    var fileName = segments.pop() || '';
    var folder = segments.join('/');
    var category = segments[0] || '根目录';
    /* frontmatter 单独拆出来：正文渲染和编辑器都只碰 body，
       用户不再需要在内容编辑区里手改 YAML（2026-11-14 用户要求）。 */
    var parts = A.fm.split(doc.content || '');
    var fmData = parts.data || {};
    var bodyText = parts.body;
    var lineCount = bodyText ? String(bodyText).split('\n').length : 0;

    var iconBox = A.el('div', null, 'arc-dh-icon');
    iconBox.append(A.svgIcon('file', 18));

    var mainBox = A.el('div', null, 'arc-dh-main');
    /* 路径：来源名 + 完整相对路径，单行等宽。原来只在路径行里放「目录」，文件名丢了，
       看上去不像案例那种「我在哪 / 打开的是谁」两段式。 */
    var pathLine = A.el('div', null, 'arc-dh-path');
    pathLine.textContent = (source ? source.name + ' / ' : '') + (doc.path || '');
    pathLine.title = (source ? source.name + ' / ' : '') + (doc.path || '');
    var bigTitle = A.el('h2', fileName.replace(/\.(md|txt|json)$/i, '') || doc.path, 'arc-dh-title');

    /* 标签行对齐案例 dh-meta：分类 badge + 「更新 X · N 行」一条元数据，不再铺体积/可编辑等
       散碎字段——那些叠在标题下就像一段「解释」，案例没有（2026-11-14 用户点名）。 */
    var meta = A.el('div', null, 'arc-dh-meta');
    if (source) meta.append(A.el('span', source.name, 'arc-badge'));
    /* 目录不是标签。原来这里写的是 `#生活`，和 frontmatter 的 tags 长得一模一样，
       用户自然以为标签是从路径里来的（2026-11-14 问「知识库 #生活 这些标签怎么来的」）。
       加文件夹图标 + 「目录 · 」前缀，和真标签在视觉上分开。 */
    var dirBadge = A.el('span', null, 'arc-badge is-dir');
    dirBadge.append(A.svgIcon('folder', 12), A.el('span', '目录 · ' + category));
    dirBadge.title = folder ? '所在目录：' + folder : '根目录';
    meta.append(dirBadge);

    /* 真标签来自 frontmatter.tags；没有就不占位，免得每篇都挂一排空 # */
    A.fm.uniqTags(fmData.tags).forEach(function (tag) {
      var chip = A.el('button', null, 'arc-tag');
      chip.type = 'button';
      chip.textContent = '#' + tag;
      chip.title = '搜索这个标签';
      chip.onclick = function () { if (A.modules.search) A.modules.search.open(st, tag); };
      meta.append(chip);
    });

    var createdRaw = fmData.created || fmData.date || fmData.Created;
    var created = createdRaw ? String(createdRaw).slice(0, 10) : '';
    meta.append(A.el('span', (created ? '创建 ' + created + ' · ' : '') + '更新 ' + (doc.mtime ? when(doc.mtime) : '—') + ' · ' + lineCount + ' 行', 'arc-dim'));
    if (!doc.exists) meta.append(A.el('span', '未建立', 'arc-pill is-warn'));
    mainBox.append(pathLine, bigTitle, meta);

    var actions = A.el('div', null, 'arc-doc-actions');
    var editBtn = A.el('button', null, 'arc-btn');
    editBtn.type = 'button';
    editBtn.dataset.act = 'edit';
    editBtn.append(A.svgIcon('edit'), A.el('span', '编辑'));
    editBtn.title = '编辑（⌘E）';
    editBtn.hidden = !doc.editable;
    editBtn.onclick = function () { toggleEdit(st); };

    /* 信息：键值对编辑（created / tags / 自定义字段），单独一块面板，
       不让用户在正文里手写 YAML（2026-11-14 用户明确要求）。 */
    var infoBtn = A.el('button', null, 'arc-btn');
    infoBtn.type = 'button';
    infoBtn.dataset.act = 'info';
    infoBtn.append(A.svgIcon('info', 14), A.el('span', '信息', 'arc-label'));
    infoBtn.title = '编辑基本信息（frontmatter）';
    infoBtn.disabled = !doc.editable;
    infoBtn.onclick = function () { if (A.modules.info) A.modules.info.openInfo(st, A.apiBag(st)); };

    /* 引用：给正文插一条 [[笔记名]]，带自动补全 */
    var citeBtn = A.el('button', null, 'arc-btn');
    citeBtn.type = 'button';
    citeBtn.dataset.act = 'cite';
    citeBtn.append(A.svgIcon('link', 14), A.el('span', '引用', 'arc-label'));
    citeBtn.title = '插入引用（[[笔记名]]）';
    citeBtn.disabled = !doc.editable;
    citeBtn.onclick = function () { if (A.modules.info) A.modules.info.openCite(st, A.apiBag(st)); };

    var saveBtn = A.el('button', null, 'arc-btn is-primary');
    saveBtn.type = 'button';
    saveBtn.dataset.act = 'save';
    saveBtn.append(A.svgIcon('save'), A.el('span', '保存'));
    saveBtn.title = '保存（⌘S）';
    saveBtn.hidden = true;
    saveBtn.onclick = function () { save(st); };

    var cancelBtn = A.el('button', '取消', 'arc-btn');
    cancelBtn.type = 'button';
    cancelBtn.dataset.act = 'cancel';
    cancelBtn.hidden = true;
    cancelBtn.onclick = function () { discard(st); };

    /* 下载 / 复制：图标走内联 SVG（↓ / ⧉ 是字体字形，换机器可能不出现），复制的是 Markdown 源码本身 */
    var downloadBtn = A.el('button', null, 'arc-btn');
    downloadBtn.type = 'button';
    downloadBtn.dataset.act = 'download';
    downloadBtn.append(A.svgIcon('down', 14), A.el('span', '下载', 'arc-label'));
    downloadBtn.disabled = !doc.exists;
    downloadBtn.title = '下载原文';
    downloadBtn.onclick = function () { download(st); };

    var copyBtn = A.el('button', null, 'arc-btn');
    copyBtn.type = 'button';
    copyBtn.dataset.act = 'copy';
    copyBtn.append(A.svgIcon('copy', 14), A.el('span', '复制', 'arc-label'));
    copyBtn.disabled = !doc.exists;
    copyBtn.title = '复制 Markdown 源码';
    copyBtn.onclick = function () { copySource(st); };

    /* 修改记录 → 「历史」：手机端四个字的按钮会把工具区挤爆，缩成两个字加时钟图标；
       title 保留全称，桌面 hover 仍看得懂是什么。 */
    var historyBtn = A.el('button', null, 'arc-btn is-quiet');
    historyBtn.append(A.svgIcon('history', 14), A.el('span', '历史', 'arc-label'));
    historyBtn.type = 'button';
    historyBtn.title = '修改记录';
    historyBtn.disabled = !st.history.length;
    historyBtn.onclick = function () { showHistory(st, historyBtn); };

    actions.append(editBtn, infoBtn, citeBtn, saveBtn, cancelBtn, downloadBtn, copyBtn, historyBtn);
    head.append(iconBox, mainBox, actions);

    var body = A.el('div', null, 'arc-doc-body');
    var article = A.el('article', null, 'arc-md');

    var editor = A.el('div', null, 'arc-editor');
    var bar = A.el('div', null, 'arc-editor-bar');
    var barHint = A.el('span', 'Markdown 源码 · ⌘S 保存 · Esc 放弃', 'arc-grow');
    var area = document.createElement('textarea');
    area.className = 'arc-area';
    area.spellcheck = false;
    area.setAttribute('aria-label', '资料正文');
    bar.append(barHint);
    editor.append(bar, area);
    editor.hidden = true;

    body.append(article, editor);

    var foot = A.el('div', null, 'arc-doc-foot');
    var footText = A.el('span', '', 'arc-foot-text');
    var footState = A.el('span', '', 'arc-foot-state');
    foot.append(footText, footState);

    wrap.append(head, body, foot);
    host.append(wrap);

    paintRead();
    state.editing = false;

    function lines() {
      var n = String(area.value || '').split('\n').length;
      footText.textContent = n + ' 行 · ' + String(area.value || '').length + ' 字符 · 编辑中';
    }
    function paintRead() {
      var outline = A.modules.md.paint(article, bodyText);
      A.modules.md.wireWiki(article, st, api);
      var old = document.querySelector('.arc-outline');
      /* 目录的 scroll-spy 监听挂在 .arc-main 上，换文档时必须摘掉，否则每开一篇就多一个滚动监听 */
      if (old) { if (old.__cleanup) old.__cleanup(); old.remove(); }
      var box = A.modules.md.mountOutline(article, outline, null);
      /* 目录是 fixed 挂在视口右侧的，会压到正文上。主区够宽才显示，
         同时给正文栏加 has-outline 把右侧留出来（实测 1440 下不留就是文字跑到目录底下）。 */
      /* 用视口宽度判，不用 main.clientWidth：三个档案页在 boot() 里全部挂载，
         非当前页是 display:none，clientWidth 读出来是 0，目录就永远不出现（2026-11-14 实测）。
         面板左侧固定占用 456px：视口 ≥1600 时主区 ≥1144，正文能保住 880 再加目录 172；
         1440 这种尺寸放不下两者，宁可不要目录也不压窄正文（案例本身在 1440 下目录是压字的）。 */
      var wide = window.innerWidth >= 1600;
      var shown = !box.hidden && wide;
      if (shown) {
        document.body.append(box);
        var rect = head.getBoundingClientRect();
        box.style.top = Math.max(16, Math.round(rect.bottom + 14)) + 'px';
      }
      body.classList.toggle('has-outline', shown);
      controls();
    }
    function controls() {
      var dirty = state.editing && area.value !== bodyText;
      state.dirty = dirty;
      editBtn.hidden = state.editing || !doc.editable;
      saveBtn.hidden = !state.editing;
      cancelBtn.hidden = !state.editing;
      saveBtn.disabled = state.saving || !dirty;
      area.readOnly = state.saving;
      /* 「已与文件一致」只在缓冲区真的要跟磁盘对账时才有意义，但那是内部状态：
         用户看到它反复出现只会疑惑（2026-11-14 点名问）。干净时清空，只在
         正在保存/有改动时说话。 */
      footState.textContent = state.saving ? '正在保存…' : dirty ? '有未保存的修改（⌘S 保存）' : '';
      footState.className = 'arc-foot-state' + (dirty ? ' is-dirty' : '');
      footText.textContent = state.editing
        ? (String(area.value || '').split('\n').length + ' 行 · ' + String(area.value || '').length + ' 字符 · 编辑中')
        : (lineCount + ' 行 · ' + (doc.bytes ? kb(doc.bytes) : '空文件'));
      /* 页面底部状态条：左来源 · 中路径 · 右可编辑状态 */
      A.foot(st, {
        left: source ? source.name : doc.source,
        mid: doc.path,
        right: state.editing ? '编辑中' : (doc.exists ? (doc.editable ? '可编辑' : '只读') : '未建立')
      });
    }

    area.addEventListener('input', function () {
      controls();
      clearTimeout(state.draftTimer);
      state.draftTimer = setTimeout(function () { writeDraft(doc, area.value); }, 300);
    });
    area.addEventListener('keydown', function (ev) {
      if (ev.key === 'Tab') {
        ev.preventDefault();
        var start = area.selectionStart, end = area.selectionEnd;
        area.setRangeText('  ', start, end, 'end');
        area.dispatchEvent(new Event('input'));
      }
      if (ev.key === 'Escape' && state.editing) {
        ev.preventDefault();
        discard(st);
      }
    });

    function toggle() {
      if (!doc.editable) return;
      state.editing = !state.editing;
      article.hidden = state.editing;
      var box = document.querySelector('.arc-outline');
      if (box) box.hidden = state.editing;
      if (state.editing) body.classList.remove('has-outline');
      editor.hidden = !state.editing;
      if (state.editing) {
        var draft = readDraft(doc);
        if (draft && draft.base !== doc.revision) {
          api.toast('原文已更新，本地草稿基于旧版本，保存前请核对', 'warn');
        }
        /* 草稿与编辑区都只存正文：frontmatter 由「信息」面板管，正文编辑器不碰它 */
        area.value = (draft && typeof draft.text === 'string') ? draft.text : bodyText;
        if (A.modules.info) A.modules.info.wireCite(area, st);
        area.focus();
        area.setSelectionRange(0, 0);
      } else {
        paintRead();
      }
      controls();
    }
    state.toggle = toggle;
    state.area = area;
    state.doc = doc;
    controls();
  }

  function toggleEdit(st) {
    if (state.toggle && state.doc === st.doc) state.toggle();
  }

  function save(st) {
    if (!state.editing || !st.doc) { A.toast('当前没有正在编辑的内容'); return Promise.resolve(); }
    var doc = st.doc;
    var parts = A.fm.split(doc.content || '');
    /* 编辑区只有正文，保存时把原 frontmatter 逐字接回去——用户在「信息」面板改的
       字段已经写进 doc.content，所以这里重新拆一次拿最新的头，不用启动时的旧值。 */
    var text = (parts.raw || '') + (state.area ? state.area.value : '');
    if (text === doc.content) { A.toast('没有改动'); return Promise.resolve(); }
    state.saving = true;
    var requestId = 'arc-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2));
    A.paintStatus(st, '正在保存 ' + doc.path + '…');
    return A.call('/api/panel-library/document', {
      method: 'PUT',
      body: {
        source: doc.source, path: doc.path, root_revision: doc.root_revision,
        revision: doc.revision, exists: doc.exists, request_id: requestId,
        content: text, reason: '面板档案编辑'
      }
    }).then(function (data) {
      var saved = data.document;
      st.doc = saved;
      clearDraft(doc);
      A.paintStatus(st, '');
      A.toast('已保存 ' + doc.path);
      state.saving = false; state.editing = false;
      render(st, st.nodes.main, A.apiBag(st));
      if (st.nodes.rail) A.modules.tree.render(st, st.nodes.rail, function (source, path) { A.openDoc(st, source, path); });
      return A.loadCatalog(st.page, true);
    }).catch(function (err) {
      state.saving = false;
      A.paintStatus(st, '保存失败：' + err.message, 'err');
      if (err.status === 409) {
        A.toast('文件在别处被改过了，草稿还在，可先下载再合并', 'warn');
        var box = st.nodes.main.querySelector('.arc-doc-foot');
        if (box) {
          var fix = A.el('button', '重新读取原文', 'arc-btn is-quiet');
          fix.onclick = function () { A.openDoc(st, doc.source, doc.path); };
          box.append(fix);
        }
      } else {
        A.toast('保存失败：' + err.message, 'err');
      }
    });
  }

  function discard(st) {
    if (!st.doc) return;
    clearDraft(st.doc);
    state.editing = false;
    state.dirty = false;
    render(st, st.nodes.main, A.apiBag(st));
    A.toast('已放弃本次修改');
  }

  /* 复制 Markdown 源码（对应案例的 ⧉ 按钮）。
     clipboard API 只在安全上下文可用，面板挂在内网 http 时会被拒——降级到 execCommand，
     两条路都走不通才提示去下载原文。编辑态复制的是当前编辑区内容，不是磁盘上的旧版本。 */
  function copySource(st) {
    var doc = st.doc;
    if (!doc || !doc.exists) { A.toast('这份资料还没有内容可复制', 'warn'); return; }
    var text = (state.editing && state.area) ? String(state.area.value || '') : String(doc.content || '');
    function done() { A.toast('已复制 ' + String(doc.path).split('/').pop() + ' 的 Markdown 源码'); }
    function fallback() {
      var box = document.createElement('textarea');
      box.value = text;
      box.setAttribute('readonly', '');
      box.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0';
      document.body.append(box);
      box.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (_) {}
      box.remove();
      if (ok) done();
      else A.toast('浏览器不允许写剪贴板，请用「下载」取原文', 'err');
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(fallback);
    } else fallback();
  }

  function download(st) {
    var doc = st.doc;
    if (!doc) return;
    var query = '?source=' + encodeURIComponent(doc.source) + '&path=' + encodeURIComponent(doc.path);
    Promise.resolve(monitorToken ? null : fetchToken()).then(function () {
      return fetch(apiUrl('/api/panel-library/download' + query), {
        headers: monitorToken ? { 'X-Monitor-Token': monitorToken } : {}
      });
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.blob();
    }).then(function (blob) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = doc.path.split('/').pop();
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    }).catch(function (err) { A.toast('下载失败：' + err.message, 'err'); });
  }

  function showHistory(st, opener) {
    var rows = st.history || [];
    var dialog = document.createElement('dialog');
    dialog.className = 'arc-dialog';
    var head = A.el('div', null, 'arc-dialog-head');
    head.append(A.el('h3', '修改记录 · ' + st.doc.path));
    var close = A.el('button', '×', 'arc-icon-btn');
    close.setAttribute('aria-label', '关闭');
    close.onclick = function () { dialog.close(); };
    head.append(close);
    var list = A.el('div', null, 'arc-history');
    if (!rows.length) list.append(A.el('p', '还没有通过面板保存过的记录。', 'arc-empty'));
    rows.forEach(function (row) {
      var item = A.el('div', null, 'arc-history-row');
      var top = A.el('div', null, 'arc-history-top');
      top.append(A.el('strong', when(row.created_at), ''), A.el('span', row.reason || '手动编辑', 'arc-dim'));
      item.append(top);
      if (row.can_undo) {
        var undo = A.el('button', '撤销这一版', 'arc-btn is-quiet');
        undo.onclick = function () {
          undo.disabled = true;
          var requestId = 'undo-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now());
          A.call('/api/panel-library/undo', { method: 'POST', body: { change_id: row.id, request_id: requestId, revision: st.doc.revision } })
            .then(function () { dialog.close(); A.toast('已撤销'); A.openDoc(st, st.doc.source, st.doc.path); })
            .catch(function (err) { undo.disabled = false; A.toast('撤销失败：' + err.message, 'err'); });
        };
        item.append(undo);
      }
      list.append(item);
    });
    dialog.append(head, list);
    document.body.append(dialog);
    dialog.addEventListener('close', function () { dialog.remove(); });
    dialog.showModal();
    if (opener) opener.focus();
  }

  function error(st, host, err) {
    host.replaceChildren(emptyBlock(A.svgIcon('alert', 30), '打开失败', err.message));
    A.foot(st, { left: '', mid: '', right: '打开失败' });
  }

  /* 离开文档前：草稿已经随手存了，这里只做提示，不拦人 */
  function beforeLeave(st) {
    if (state.dirty && state.doc) A.toast('未保存的修改已存为本地草稿', 'warn');
  }

  /* 「信息」面板写回时要用"此刻的正文"：用户可能正在编辑器里改着，编辑区的
     内容比磁盘上的新。这里只回答正文，不动 frontmatter。 */
  function bodyNow(st) {
    var doc = st && st.doc;
    if (!doc) return '';
    if (state.editing && state.area && state.doc === doc) return state.area.value;
    return A.fm.split(doc.content || '').body;
  }

  return { render: render, save: save, toggleEdit: toggleEdit, error: error, beforeLeave: beforeLeave, bodyNow: bodyNow };
})());
