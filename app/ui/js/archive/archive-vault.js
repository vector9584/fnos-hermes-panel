/* 档案 · 密码本（2026-11-14 重做，对照案例 /vol1/1000/飞牛文件/墨档文档阅读器_全端性能版.html）
 *
 * 信息架构照案例三段式，不是「一个列表加一排按钮」：
 *   一级  锁卡 → 输入一级口令 → 解锁「列表」（分类筛选 + 卡片网格）
 *   二级  点条目 → 输入二级口令 → 详情页：看明文 / 复制 / 编辑 / 该条目的审计
 * 入口照案例放左栏底部（archive-tree 的 specials），不占页签。
 *
 * 和案例唯一的差别是存储：案例整包密文塞 localStorage、前端 XOR 解密；
 * 这里明文在 data/.env，两级口令 scrypt 哈希在 data/.vault-auth.json，
 * 明文由服务端按「一个键」下发，一次只给一个，浏览器拿不到全量。
 */
window.Archive.register('vault', (function () {
  'use strict';

  var A = window.Archive;

  function vs(st) {
    if (!st.vault || !st.vault.__v2) {
      st.vault = {
        __v2: true, data: null, error: '', loading: false,
        cat: '全部', q: '', key: '', editing: false,
        revealed: {}, grants: {}, audit: []
      };
    }
    return st.vault;
  }

  function hint(text) { return A.el('p', text, 'arc-vault-hint'); }

  function load(st, bag) {
    var v = vs(st);
    if (v.loading) return v.loading;
    v.loading = A.call('/api/archive/vault', { ticket: st.ticket }).then(function (data) {
      v.data = data;
      v.error = '';
      if (data.locked) { st.ticket = ''; v.revealed = {}; v.grants = {}; }
      st.vaultCount = data.count;
      if (bag && bag.rail) bag.rail();
      return data;
    }).catch(function (err) {
      v.data = null;
      v.error = err.message || String(err);
      return null;
    }).then(function (data) {
      v.loading = false;
      return data;
    });
    return v.loading;
  }

  /* ── 一级：锁卡 ── */
  function lockCard(st, bag) {
    var v = vs(st);
    var card = A.el('div', null, 'arc-lock-card');
    var ico = A.el('div', null, 'arc-lock-ico');
    ico.append(A.svgIcon('lock', 24));
    card.append(ico, A.el('h2', '密码本已锁定'));
    card.append(A.el('p', '两级保护：一级口令只解锁列表（键名 / 分类 / 掩码），二级口令才能看和改具体条目。明文由服务端按条下发，不落浏览器存储。', 'arc-lock-desc'));

    var form = A.el('form', null, 'arc-pass-form');
    var label = A.el('label', '一级口令', 'arc-lock-label');
    var input = document.createElement('input');
    input.type = 'password';
    input.className = 'arc-vault-input';
    input.autocomplete = 'off';
    input.placeholder = '输入一级口令';
    input.setAttribute('aria-label', '一级口令');
    var fb = A.el('p', '', 'arc-pass-feedback');
    var btn = A.el('button', '解锁列表', 'arc-btn is-primary is-block');
    btn.type = 'submit';
    form.append(label, input, fb, btn);

    form.onsubmit = function (ev) {
      ev.preventDefault();
      var pw = String(input.value || '');
      if (!pw) { fb.textContent = '请输入一级口令'; input.focus(); return; }
      btn.disabled = true;
      fb.textContent = '校验中…';
      A.call('/api/archive/vault/unlock', { method: 'POST', body: { password: pw } }).then(function (res) {
        st.ticket = res.ticket;
        v.revealed = {};
        v.grants = {};
        return load(st, bag);
      }).then(function () {
        btn.disabled = false;
        bag.rerender();
        A.toast('一级校验通过');
      }).catch(function (err) {
        btn.disabled = false;
        fb.textContent = err.message || '校验失败';
        input.select();
      });
    };

    card.append(form, hint('忘记口令就删掉 data/.vault-auth.json 再刷新，会回到设置流程——老口令救不回来，密码本里的值本身不受影响。'));
    return card;
  }

  /* ── 首次使用：设置两级口令 ── */
  function setupCard(st, bag) {
    var card = A.el('div', null, 'arc-lock-card');
    var ico = A.el('div', null, 'arc-lock-ico');
    ico.append(A.svgIcon('lock', 24));
    card.append(ico, A.el('h2', '设置密码本口令'));
    card.append(A.el('p', '设两道：一级用来解锁列表，二级用来查看和编辑具体条目。二级留空就等于两级同一个口令——能开，但少一层。', 'arc-lock-desc'));

    var form = A.el('form', null, 'arc-pass-form');
    var i1 = document.createElement('input');
    i1.type = 'password'; i1.className = 'arc-vault-input'; i1.autocomplete = 'new-password';
    i1.placeholder = '一级口令（至少 6 位）'; i1.setAttribute('aria-label', '一级口令');
    var i2 = document.createElement('input');
    i2.type = 'password'; i2.className = 'arc-vault-input'; i2.autocomplete = 'new-password';
    i2.placeholder = '二级口令（留空＝同一口令）'; i2.setAttribute('aria-label', '二级口令');
    var fb = A.el('p', '', 'arc-pass-feedback');
    var btn = A.el('button', '设置并解锁', 'arc-btn is-primary is-block');
    btn.type = 'submit';
    form.append(A.el('label', '一级口令', 'arc-lock-label'), i1,
      A.el('label', '二级口令', 'arc-lock-label'), i2, fb, btn);

    form.onsubmit = function (ev) {
      ev.preventDefault();
      var p1 = String(i1.value || ''), p2 = String(i2.value || '');
      if (p1.length < 6) { fb.textContent = '一级口令至少 6 位'; i1.focus(); return; }
      if (p2 && p2.length < 6) { fb.textContent = '二级口令至少 6 位'; i2.focus(); return; }
      btn.disabled = true;
      fb.textContent = '写入中…';
      A.call('/api/archive/vault/setup', { method: 'POST', body: { level1: p1, level2: p2 } }).then(function (res) {
        st.ticket = res.ticket;
        return load(st, bag);
      }).then(function () {
        btn.disabled = false;
        bag.rerender();
        A.toast(p2 && p2 !== p1 ? '两级口令已设置' : '口令已设置（两级相同）');
      }).catch(function (err) {
        btn.disabled = false;
        fb.textContent = err.message || '设置失败';
      });
    };

    card.append(form, hint('口令以 scrypt 哈希存 data/.vault-auth.json（0600），服务端内存里只放 10 分钟票据，重启即失效。'));
    return card;
  }

  /* ── 一级解锁后：列表 ── */
  function listView(st, bag) {
    var v = vs(st);
    var data = v.data;
    var root = A.el('div', null, 'arc-vault-inner');

    var hero = A.el('div', null, 'arc-vault-hero');
    var hico = A.el('div', null, 'arc-vault-hero-ico');
    hico.append(A.svgIcon('lock', 20));
    var htxt = A.el('div', null, 'arc-vault-hero-txt');
    htxt.append(A.el('h2', '密码本'),
      A.el('p', data.count + ' 组键值对 · 一级校验已通过 · 查看与编辑需二级口令', 'arc-vault-sub'));
    hero.append(hico, htxt);

    var tools = A.el('div', null, 'arc-vault-tools');
    var add = A.el('button', null, 'arc-btn is-primary is-sm');
    add.type = 'button';
    add.append(A.svgIcon('plus', 13), A.el('span', '新增条目'));
    add.onclick = function () { askNew(st, bag); };
    var refresh = A.el('button', '刷新', 'arc-btn is-sm');
    refresh.type = 'button';
    refresh.onclick = function () {
      v.data = null; v.error = '';
      load(st, bag).then(function () { bag.rerender(); });
    };
    var relock = A.el('button', '重新锁定', 'arc-btn is-sm');
    relock.type = 'button';
    relock.onclick = function () {
      A.call('/api/archive/vault/lock', { method: 'POST', ticket: st.ticket }).catch(function () {});
      st.ticket = '';
      v.revealed = {}; v.grants = {}; v.key = ''; v.editing = false;
      v.data = null; v.error = '';
      load(st, bag).then(function () { bag.rerender(); A.toast('已重新锁定'); });
    };
    var pill = A.el('span', '一级已解锁', 'arc-vault-pill');
    var search = document.createElement('input');
    search.type = 'search';
    search.className = 'arc-vault-search';
    search.placeholder = '筛选键名 / 分类';
    search.value = v.q;
    search.setAttribute('aria-label', '筛选密码本');
    tools.append(add, refresh, relock, search, pill);

    /* 分类 chips：按服务端分组计数，全部在前 */
    var chips = A.el('div', null, 'arc-vault-chips');
    var grid = A.el('div', null, 'arc-vault-grid');
    var empty = A.el('p', '没有匹配的条目。', 'arc-empty');

    function paint() {
      var q = String(v.q || '').trim().toLowerCase();
      var items = (v.data.items || []).filter(function (it) {
        if (v.cat !== '全部' && it.category !== v.cat) return false;
        if (!q) return true;
        return it.key.toLowerCase().indexOf(q) >= 0 || String(it.category).toLowerCase().indexOf(q) >= 0;
      });
      grid.replaceChildren();
      items.forEach(function (it) { grid.append(card(it)); });
      empty.hidden = items.length > 0;
      chips.querySelectorAll('.arc-vault-chip').forEach(function (c) {
        c.classList.toggle('on', c.dataset.cat === v.cat);
      });
    }

    chips.append(chip('全部', v.data.count));
    Object.keys(v.data.groups || {}).sort(function (a, b) {
      return (v.data.groups[b] - v.data.groups[a]) || a.localeCompare(b, 'zh');
    }).forEach(function (cat) { chips.append(chip(cat, v.data.groups[cat])); });

    function chip(cat, count) {
      var b = A.el('button', null, 'arc-vault-chip' + (v.cat === cat ? ' on' : ''));
      b.type = 'button';
      b.dataset.cat = cat;
      b.append(A.el('span', cat), A.el('span', String(count), 'arc-vault-chip-n'));
      b.onclick = function () { v.cat = cat; paint(); };
      return b;
    }

    function card(it) {
      var b = A.el('button', null, 'arc-vault-card');
      b.type = 'button';
      var top = A.el('div', null, 'vi-top');
      top.append(A.el('span', it.key, 'vi-key'), A.el('span', it.category, 'vi-cat'));
      var val = A.el('div', null, 'vi-val');
      val.textContent = it.masked;
      var foot = A.el('div', null, 'vi-foot');
      foot.append(A.el('span', it.bytes + ' B', 'vi-bytes'), A.el('span', '查看 ›', 'vi-go'));
      b.append(top, val, foot);
      b.title = it.key + ' · 查看需二级口令';
      b.onclick = function () {
        v.key = it.key;
        v.editing = false;
        bag.rerender();
      };
      return b;
    }

    search.oninput = function () { v.q = search.value; paint(); };

    root.append(hero, tools, chips, grid, empty, hint('值只在二级校验通过后按条下发；复制、编辑都要先过二级，编辑后写入 data/.env，并记一条审计。'));
    paint();
    return root;
  }

  /* ── 二级：详情 ── */
  function detailView(st, bag) {
    var v = vs(st);
    var item = (v.data.items || []).filter(function (it) { return it.key === v.key; })[0];
    if (!item) { v.key = ''; return listView(st, bag); }

    var root = A.el('div', null, 'arc-vault-inner arc-vault-detail');
    var back = A.el('button', null, 'arc-btn is-ghost is-sm arc-vault-back');
    back.type = 'button';
    back.append(A.svgIcon('back', 14), A.el('span', '返回列表'));
    back.onclick = function () { v.key = ''; v.editing = false; bag.rerender(); };

    var head = A.el('div', null, 'arc-vault-head');
    var hico = A.el('div', null, 'arc-vault-head-ico');
    hico.append(A.svgIcon('lock', 18));
    var htxt = A.el('div', null, 'arc-vault-head-txt');
    var title = A.el('h2', item.key, 'arc-vault-key');
    var sub = A.el('div', null, 'arc-vault-head-sub');
    sub.append(A.el('span', item.category, 'vi-cat'), A.el('span', item.bytes + ' B', 'vi-bytes'));
    htxt.append(title, sub);
    head.append(hico, htxt);

    root.append(back, head);

    var revealed = Object.prototype.hasOwnProperty.call(v.revealed, item.key);
    var box = A.el('section', null, 'arc-vault-valuebox');

    if (revealed && !v.editing) {
      box.append(A.el('div', '明文', 'arc-vault-valuehead'));
      var pre = A.el('pre', null, 'arc-vault-value');
      pre.textContent = v.revealed[item.key] === '' ? '（空值）' : v.revealed[item.key];
      box.append(pre);
      var acts = A.el('div', null, 'arc-vault-acts');
      var copy = A.el('button', null, 'arc-btn is-sm');
      copy.type = 'button';
      copy.append(A.svgIcon('copy', 13), A.el('span', '复制'));
      copy.onclick = function () { copyText(v.revealed[item.key]); };
      var edit = A.el('button', null, 'arc-btn is-sm is-primary');
      edit.type = 'button';
      edit.append(A.svgIcon('edit', 13), A.el('span', '编辑'));
      edit.onclick = function () { v.editing = true; bag.rerender(); };
      var hide = A.el('button', '隐藏', 'arc-btn is-sm is-ghost');
      hide.type = 'button';
      hide.onclick = function () { delete v.revealed[item.key]; delete v.grants[item.key]; bag.rerender(); };
      acts.append(copy, edit, hide);
      box.append(acts);
    } else if (revealed && v.editing) {
      box.append(A.el('div', '编辑 ' + item.key, 'arc-vault-valuehead'));
      var ta = document.createElement('textarea');
      ta.className = 'arc-vault-editor';
      ta.value = v.revealed[item.key];
      ta.rows = 3;
      ta.setAttribute('aria-label', '编辑值');
      box.append(ta);
      var eacts = A.el('div', null, 'arc-vault-acts');
      var save = A.el('button', null, 'arc-btn is-sm is-primary');
      save.type = 'button';
      save.append(A.svgIcon('save', 13), A.el('span', '保存'));
      var cancel = A.el('button', '取消', 'arc-btn is-sm is-ghost');
      cancel.type = 'button';
      cancel.onclick = function () { v.editing = false; bag.rerender(); };
      var efb = A.el('span', '', 'arc-pass-feedback');
      save.onclick = function () {
        save.disabled = true;
        efb.textContent = '保存中…';
        saveValue(st, bag, item.key, ta.value, {}).then(function (res) {
          v.revealed[item.key] = ta.value;
          v.editing = false;
          bag.rerender();
          A.toast(res && res.unchanged ? '值没有变化' : '已写入 data/.env');
          loadAudit(st, bag);
        }).catch(function (err) {
          save.disabled = false;
          efb.textContent = err.message || '保存失败';
          if (err.status === 403) promptLevel2(st, bag, item.key, function () { bag.rerender(); });
        });
      };
      eacts.append(save, cancel, efb);
      box.append(eacts);
    } else {
      /* 二级校验：口令框直接长在详情里，不弹一个黑框 */
      box.append(A.el('div', '明文', 'arc-vault-valuehead'));
      box.append(A.el('p', '这一条需要二级口令。校验通过后明文只在这一页出现，离开就清掉。', 'arc-vault-gate-desc'));
      var form = A.el('form', null, 'arc-pass-form arc-vault-gate');
      var input = document.createElement('input');
      input.type = 'password';
      input.className = 'arc-vault-input';
      input.placeholder = '输入二级口令';
      input.autocomplete = 'off';
      input.setAttribute('aria-label', '二级口令');
      var fb = A.el('p', '', 'arc-pass-feedback');
      var go = A.el('button', '查看明文', 'arc-btn is-primary is-sm');
      go.type = 'submit';
      form.append(input, go, fb);
      form.onsubmit = function (ev) {
        ev.preventDefault();
        var pw = String(input.value || '');
        if (!pw) { fb.textContent = '请输入二级口令'; input.focus(); return; }
        go.disabled = true;
        fb.textContent = '校验中…';
        reveal(st, bag, item.key, pw).then(function () {
          bag.rerender();
          loadAudit(st, bag);
        }).catch(function (err) {
          go.disabled = false;
          fb.textContent = err.message || '校验失败';
          input.select();
        });
      };
      box.append(form);
    }

    root.append(box);

    var meta = A.el('div', null, 'arc-vault-meta');
    [['键名', item.key], ['分类', item.category], ['体积', item.bytes + ' B'], ['掩码', item.masked]].forEach(function (pair) {
      var cell = A.el('div', null, 'arc-vault-metacell');
      cell.append(A.el('span', pair[0], 'arc-vault-metak'), A.el('span', pair[1], 'arc-vault-metav'));
      meta.append(cell);
    });
    root.append(meta);

    /* 这条键自己的审计：谁在什么时候看过/改过 */
    var auditBox = A.el('section', null, 'arc-vault-audit');
    auditBox.append(A.el('h3', '修改记录', 'arc-vault-audit-title'));
    var rows = v.audit.filter(function (row) { return row.key === item.key; }).slice(0, 8);
    if (!rows.length) auditBox.append(A.el('p', '还没有这条键的记录。', 'arc-vault-hint'));
    rows.forEach(function (row) {
      var line = A.el('div', null, 'arc-vault-audit-row');
      var when = new Date(row.at || Date.now());
      var pad = function (n) { return (n < 10 ? '0' : '') + n; };
      line.append(
        A.el('span', pad(when.getMonth() + 1) + '-' + pad(when.getDate()) + ' ' + pad(when.getHours()) + ':' + pad(when.getMinutes()), 'arc-vault-audit-when'),
        A.el('span', ({ reveal: '查看', edit: '编辑', create: '新增', 'reveal-failed': '验口令失败', 'write-failed': '写失败' })[row.action] || row.action, 'arc-vault-audit-act')
      );
      auditBox.append(line);
    });
    root.append(auditBox);
    loadAudit(st, bag);
    return root;
  }

  function loadAudit(st, bag) {
    var v = vs(st);
    if (!st.ticket) return;
    A.call('/api/archive/vault/audit', { ticket: st.ticket }).then(function (res) {
      v.audit = res.items || [];
      /* 只重绘审计区，整页重绘会把刚输入的口令框冲掉 */
      var host = document.querySelector('.arc-vault-audit');
      if (host && v.key) {
        host.replaceChildren();
        host.append(A.el('h3', '修改记录', 'arc-vault-audit-title'));
        var rows = v.audit.filter(function (row) { return row.key === v.key; }).slice(0, 8);
        if (!rows.length) host.append(A.el('p', '还没有这条键的记录。', 'arc-vault-hint'));
        rows.forEach(function (row) {
          var when = new Date(row.at || Date.now());
          var pad = function (n) { return (n < 10 ? '0' : '') + n; };
          var line = A.el('div', null, 'arc-vault-audit-row');
          line.append(
            A.el('span', pad(when.getMonth() + 1) + '-' + pad(when.getDate()) + ' ' + pad(when.getHours()) + ':' + pad(when.getMinutes()), 'arc-vault-audit-when'),
            A.el('span', ({ reveal: '查看', edit: '编辑', create: '新增', 'reveal-failed': '验口令失败', 'write-failed': '写失败' })[row.action] || row.action, 'arc-vault-audit-act')
          );
          host.append(line);
        });
      }
    }).catch(function () { /* 审计拉不到不影响用 */ });
  }

  function reveal(st, bag, key, password) {
    var v = vs(st);
    return A.call('/api/archive/vault/reveal', { method: 'POST', ticket: st.ticket, body: { key: key, password: password } })
      .then(function (res) {
        v.revealed[key] = res.value;
        v.grants[key] = res.grant;
        return res;
      }).catch(function (err) {
        if (err.status === 401) {
          /* 票据过期（10 分钟）：回锁卡，别让人反复输二级口令 */
          st.ticket = '';
          v.data = null;
          v.revealed = {};
          bag.rerender();
        }
        throw err;
      });
  }

  function saveValue(st, bag, key, value, extra) {
    var v = vs(st);
    var body = { key: key, value: value };
    Object.keys(extra || {}).forEach(function (k) { body[k] = extra[k]; });
    return A.call('/api/archive/vault', {
      method: 'PUT', ticket: st.ticket, grant: v.grants[key] || '', body: body
    }).catch(function (err) {
      if (err.status === 403 && !v.grants[key]) return Promise.reject(err);
      if (err.status === 403) {
        /* 授权过期：清掉再试一次会拿到明确提示，交给上层去问口令 */
        delete v.grants[key];
      }
      throw err;
    });
  }

  function promptLevel2(st, bag, key, onOk) {
    var dialog = document.createElement('dialog');
    dialog.className = 'arc-dialog arc-dialog-narrow';
    var head = A.el('div', null, 'arc-dialog-head');
    head.append(A.el('h3', '二级校验'));
    var close = A.el('button', '×', 'arc-icon-btn');
    close.setAttribute('aria-label', '关闭');
    close.onclick = function () { dialog.close(); };
    head.append(close);
    var form = A.el('form', null, 'arc-pass-form');
    form.append(A.el('p', '保存 `' + key + '` 需要二级口令。', 'arc-dim'));
    var input = document.createElement('input');
    input.type = 'password';
    input.className = 'arc-vault-input';
    input.placeholder = '二级口令';
    input.autocomplete = 'off';
    input.setAttribute('aria-label', '二级口令');
    var fb = A.el('p', '', 'arc-pass-feedback');
    var acts = A.el('div', null, 'arc-dialog-actions');
    var cancel = A.el('button', '取消', 'arc-btn');
    cancel.type = 'button';
    cancel.onclick = function () { dialog.close(); };
    var ok = A.el('button', '校验', 'arc-btn is-primary');
    ok.type = 'submit';
    acts.append(cancel, ok);
    form.append(input, fb, acts);
    form.onsubmit = function (ev) {
      ev.preventDefault();
      var pw = String(input.value || '');
      if (!pw) { fb.textContent = '请输入二级口令'; return; }
      ok.disabled = true;
      reveal(st, bag, key, pw).then(function () {
        dialog.close();
        if (onOk) onOk();
      }).catch(function (err) {
        ok.disabled = false;
        fb.textContent = err.message || '校验失败';
      });
    };
    dialog.append(head, form);
    document.body.append(dialog);
    dialog.addEventListener('close', function () { dialog.remove(); });
    dialog.showModal();
    input.focus();
  }

  /* 新增条目：键名 + 值 + 二级口令。新增的键拿不到 reveal 授权（键还不存在），
     所以这里直接带口令写，服务端允许这条路径。 */
  function askNew(st, bag) {
    var dialog = document.createElement('dialog');
    dialog.className = 'arc-dialog';
    var head = A.el('div', null, 'arc-dialog-head');
    head.append(A.el('h3', '新增条目'));
    var close = A.el('button', '×', 'arc-icon-btn');
    close.setAttribute('aria-label', '关闭');
    close.onclick = function () { dialog.close(); };
    head.append(close);

    var form = A.el('form', null, 'arc-pass-form');
    var kIn = document.createElement('input');
    kIn.className = 'arc-vault-input';
    kIn.placeholder = '键名，如 NOWEN_TOKEN';
    kIn.setAttribute('aria-label', '键名');
    var vIn = document.createElement('textarea');
    vIn.className = 'arc-vault-editor';
    vIn.rows = 2;
    vIn.placeholder = '值（写进 data/.env，不能换行）';
    vIn.setAttribute('aria-label', '值');
    var pIn = document.createElement('input');
    pIn.type = 'password';
    pIn.className = 'arc-vault-input';
    pIn.placeholder = '二级口令';
    pIn.autocomplete = 'off';
    pIn.setAttribute('aria-label', '二级口令');
    var fb = A.el('p', '', 'arc-pass-feedback');
    var acts = A.el('div', null, 'arc-dialog-actions');
    var cancel = A.el('button', '取消', 'arc-btn');
    cancel.type = 'button';
    cancel.onclick = function () { dialog.close(); };
    var ok = A.el('button', '写入 .env', 'arc-btn is-primary');
    ok.type = 'submit';
    acts.append(cancel, ok);
    form.append(A.el('label', '键名', 'arc-lock-label'), kIn,
      A.el('label', '值', 'arc-lock-label'), vIn,
      A.el('label', '二级口令', 'arc-lock-label'), pIn, fb, acts);

    form.onsubmit = function (ev) {
      ev.preventDefault();
      var key = String(kIn.value || '').trim();
      var value = String(vIn.value || '');
      var pw = String(pIn.value || '');
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,120}$/.test(key)) { fb.textContent = '键名只能用字母数字下划线，且不以数字开头'; return; }
      if (!pw) { fb.textContent = '请输入二级口令'; return; }
      ok.disabled = true;
      fb.textContent = '写入中…';
      saveValue(st, bag, key, value, { create: true, password: pw }).then(function () {
        dialog.close();
        var v = vs(st);
        v.data = null;
        load(st, bag).then(function () { bag.rerender(); });
        A.toast('已写入 data/.env');
      }).catch(function (err) {
        ok.disabled = false;
        fb.textContent = err.message || '写入失败';
      });
    };

    dialog.append(head, form);
    document.body.append(dialog);
    dialog.addEventListener('close', function () { dialog.remove(); });
    dialog.showModal();
    kIn.focus();
  }

  function copyText(text) {
    var value = String(text == null ? '' : text);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(function () { A.toast('已复制'); },
        function () { A.toast('复制失败，浏览器没给权限', 'warn'); });
      return;
    }
    var ta = document.createElement('textarea');
    ta.value = value;
    document.body.append(ta);
    ta.select();
    try { document.execCommand('copy'); A.toast('已复制'); }
    catch (_) { A.toast('复制失败', 'warn'); }
    ta.remove();
  }

  function render(st, host, bag) {
    var v = vs(st);
    if (!v.data && !v.error) {
      host.append(A.el('p', '正在读取密码本…', 'arc-empty'));
      load(st, bag).then(function () { if (v.data || v.error) bag.rerender(); });
      return;
    }
    if (!v.data) {
      var box = A.el('div', null, 'arc-vault-inner');
      box.append(A.el('p', '读取失败：' + v.error, 'arc-empty'));
      var retry = A.el('button', '重试', 'arc-btn is-sm');
      retry.type = 'button';
      retry.onclick = function () { v.error = ''; bag.rerender(); };
      box.append(retry);
      host.append(box);
      return;
    }
    A.foot(st, {
      left: v.data.count + ' 项',
      mid: v.data.locked ? '已锁定' : '一级已解锁',
      right: v.data.locked ? '' : '查看 / 编辑需二级口令'
    });
    var root = A.el('div', null, 'arc-vault');
    host.append(root);
    if (v.data.setup) { root.append(setupCard(st, bag)); return; }
    if (v.data.locked) { root.append(lockCard(st, bag)); return; }
    if (v.key) { root.append(detailView(st, bag)); return; }
    root.append(listView(st, bag));
  }

  return { render: render };
})());
