/* 资料面板 · 助手 / 资料 两个板块（2026-11-13）
 *
 * 用户的目录约定：
 *   助手 · 它是什么  ← 改这里 = 改它的行为和能力
 *       人格 SOUL.md（全文注入）· 记忆 MEMORY.md + USER.md · 指令 AGENTS.md · 能力 skills/
 *   资料 · 它知道什么 ← 改这里 ≠ 它就会知道
 *       知识库 knowledge/**（本页 page-kb 原样保留）· 笔记 notes.md · 密码本 .env
 *   足迹 · 它做过什么 ← 全部只读（page-memory 原样保留）
 *
 * 这个文件只做两件事：渲染 #page-assistant 的四张卡；给资料页补「笔记 / 密码本」入口。
 * 数据全部来自 /api/memory（已扩展 user/agents/skills/env_keys 字段），不另造第二套读法。
 */
(function () {
  'use strict';

  function el(tag, text, cls) {
    var node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (cls) node.className = cls;
    return node;
  }
  function bytes(text) {
    try { return new Blob([text || '']).size; } catch (e) { return (text || '').length; }
  }
  function kb(n) {
    if (!n) return '0 B';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }
  function tokenize() {
    return (typeof monitorToken !== 'undefined' && monitorToken) ? { 'X-Monitor-Token': monitorToken } : {};
  }
  function profileQS() {
    var p = (typeof _activeProfileId === 'function') ? _activeProfileId() : '';
    return p ? ('?profile=' + encodeURIComponent(p)) : '';
  }
  function getMemory() {
    var url = (typeof apiUrl === 'function') ? apiUrl('/api/memory' + profileQS()) : ('/api/memory' + profileQS());
    return fetch(url, { cache: 'no-store', headers: tokenize() }).then(function (r) {
      if (!r.ok) throw new Error('读取失败（HTTP ' + r.status + '）');
      return r.json();
    });
  }
  function saveMemory(payload) {
    var url = (typeof apiUrl === 'function') ? apiUrl('/api/memory') : '/api/memory';
    var p = (typeof _activeProfileId === 'function') ? _activeProfileId() : '';
    if (p) payload.profile = p;
    return fetch(url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, tokenize()),
      body: JSON.stringify(payload)
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j || !j.ok) throw new Error((j && j.error) || '保存失败');
      return j;
    });
  }

  /* ── 通用编辑弹窗：一个 textarea，保存即写回 ── */
  function editor(title, sub, text, onSave) {
    var dlg = el('dialog', null, 'navigation-dialog');
    dlg.setAttribute('aria-label', title);
    dlg.append(el('h2', title));
    if (sub) dlg.append(el('p', sub, 'pw-hint'));
    var ta = el('textarea');
    ta.value = text || '';
    ta.rows = 18;
    ta.spellcheck = false;
    ta.className = 'mem-editor';
    ta.setAttribute('aria-label', title + ' 内容');
    var status = el('p', '', 'pw-hint');
    var foot = el('div', null, 'mcp-actions');
    var save = el('button', '保存', 'btn');
    var close = el('button', '关闭', 'btn');
    save.type = close.type = 'button';
    save.onclick = async function () {
      save.disabled = true; status.textContent = '正在保存…';
      try {
        await onSave(ta.value);
        status.textContent = '已保存 · ' + kb(bytes(ta.value));
        setTimeout(function () { dlg.close(); dlg.remove(); refresh(); }, 500);
      } catch (e) {
        status.textContent = e.message;
        save.disabled = false;
      }
    };
    close.onclick = function () { dlg.close(); dlg.remove(); };
    dlg.append(ta, status, foot);
    foot.append(save, close);
    document.body.append(dlg);
    dlg.showModal();
    ta.focus();
    return dlg;
  }

  /* ── 只读列表弹窗（能力清单 / 密码本键名） ── */
  function listDialog(title, sub, rows) {
    var dlg = el('dialog', null, 'navigation-dialog');
    dlg.setAttribute('aria-label', title);
    dlg.append(el('h2', title));
    if (sub) dlg.append(el('p', sub, 'pw-hint'));
    var wrap = el('div', null, 'asst-list');
    rows.forEach(function (r) { wrap.append(el('div', r, 'asst-list-row')); });
    var foot = el('div', null, 'mcp-actions');
    var close = el('button', '关闭', 'btn');
    close.type = 'button';
    close.onclick = function () { dlg.close(); dlg.remove(); };
    foot.append(close);
    dlg.append(wrap, foot);
    document.body.append(dlg);
    dlg.showModal();
  }

  var cache = null;
  function refresh() {
    var grid = document.getElementById('asstGrid');
    if (!grid) return Promise.resolve();
    grid.replaceChildren(el('div', '正在读取…', 'empty-state'));
    return getMemory().then(function (d) {
      cache = d;
      paint(grid, d);
      paintStrip(d);
    }).catch(function (e) {
      grid.replaceChildren(el('div', '读取失败：' + e.message, 'empty-state'));
    });
  }

  function card(icon, title, file, sizeText, desc, actions) {
    var box = el('div', null, 'mem-card');
    var head = el('div', null, 'mem-card-head');
    head.append(el('span', icon, 'mem-icon'), el('span', title, 'mem-title'), el('span', file, 'mem-file'), el('span', sizeText, 'mem-file'));
    (actions || []).forEach(function (a) {
      var b = el('button', a[0], 'btn');
      b.type = 'button';
      b.onclick = a[1];
      head.append(b);
    });
    box.append(head, el('p', desc, 'pw-hint'));
    return box;
  }

  function paint(grid, d) {
    grid.replaceChildren();
    grid.append(card('👻', '人格', 'SOUL.md', kb(bytes(d.soul)), '全文注入 · 决定它是谁、怎么说话', [
      ['编辑', function () { editor('人格 · SOUL.md', '保存即生效，下一轮对话按新的人格走。', d.soul, function (v) { return saveMemory({ soul: v }); }); }]
    ]));
    grid.append(card('🧠', '记忆', 'MEMORY.md + USER.md', kb(bytes(d.memory)) + ' + ' + kb(bytes(d.user)), '全文注入 · 冻结快照，改动下一轮生效', [
      ['MEMORY', function () { editor('记忆 · MEMORY.md', '长期记忆：环境、约定、踩过的坑。', d.memory, function (v) { return saveMemory({ memory: v }); }); }],
      ['USER', function () { editor('记忆 · USER.md', '用户画像：身份、偏好、日程习惯。', d.user, function (v) { return saveMemory({ user: v }); }); }]
    ]));
    grid.append(card('📜', '指令', 'AGENTS.md', kb(bytes(d.agents)), '全文注入 · 干活时的规矩与流程（保存前自动留 .bak）', [
      ['编辑', function () { editor('指令 · AGENTS.md', '这是执行纪律，不是知识。改完下一次工具调用就按新的来。', d.agents, function (v) { return saveMemory({ agents: v }); }); }]
    ]));
    var skills = d.skills || [];
    var total = skills.reduce(function (a, s) { return a + (s.bytes || 0); }, 0);
    grid.append(card('🧰', '能力', 'skills/', skills.length + ' 个 · ' + kb(total), '按需加载 · 每个技能是一个 SKILL.md，用时才读正文', [
      ['列表', function () {
        listDialog('能力 · 技能清单', '共 ' + skills.length + ' 个。点开任意技能名可去知识库看它的完整内容。', skills.map(function (s) { return s.name + '  ·  ' + kb(s.bytes); }));
      }],
      ['轨迹', function () { if (typeof switchPage === 'function') { switchPage('kb'); setTimeout(function () { var b = [].slice.call(document.querySelectorAll('#page-kb button')).find(function (x) { return x.textContent === '技能轨迹'; }); if (b) b.click(); }, 120); } }]
    ]));
  }

  /* 资料页顶部那条：笔记 + 密码本（知识库本身仍由 library 组件渲染，不动它） */
  function paintStrip(d) {
    var strip = document.getElementById('materialsStrip');
    if (!strip) return;
    strip.replaceChildren();
    strip.append(card('📝', '笔记', 'notes.md', kb(bytes(d.notes)), '不注入 · 靠约定我去翻。临时想法、待办速记都在这。', [
      ['编辑', function () { editor('笔记 · notes.md', '这里是收件箱：写下的事我会在会话收尾时逐条归纳。', d.notes, function (v) { return saveMemory({ notes: v }); }); }]
    ]));
    var keys = d.env_keys || [];
    strip.append(card('🔑', '密码本', '.env', keys.length + ' 项', '不注入 · 只列键名，值不出服务端（要看值请到 NAS 上直接开文件）', [
      ['键名', function () { listDialog('密码本 · 键名清单', '值为避免明文外泄，不通过接口返回。共 ' + keys.length + ' 项。', keys.map(function (k) { return k.key + '  ·  ' + k.hint; })); }]
    ]));
  }

  /* 资料页那条容器由这里创建：panel-library-ui 的 mount() 会把 page-kb 里除 header 外的
     子节点全删掉，所以静态写进 index.html 会被吃掉，只能等它挂完再插。 */
  function ensureStrip() {
    var page = document.getElementById('page-kb');
    if (!page) return null;
    var strip = document.getElementById('materialsStrip');
    if (!strip) {
      strip = el('div', null, 'memory-cards library-extra-cards');
      strip.id = 'materialsStrip';
      var header = page.querySelector('.page-header');
      if (header) page.insertBefore(strip, header); else page.append(strip);
    }
    return strip;
  }
  function paintStripCache() {
    ensureStrip();
    if (cache) { paintStrip(cache); return; }
    getMemory().then(function (d) { cache = d; paintStrip(d); }).catch(function () {});
  }
  document.addEventListener('hermes:page', function (ev) {
    var page = ev.detail && ev.detail.page;
    if (page === 'assistant') refresh();
    if (page === 'kb') paintStripCache();
  });
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(paintStripCache, 0); });
  } else {
    setTimeout(paintStripCache, 0);
  }
  window.pwRefreshAssistant = refresh;
})();
