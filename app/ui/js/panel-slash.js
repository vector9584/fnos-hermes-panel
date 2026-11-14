/* panel-slash.js — 斜杠命令：注册表 + 自动补全 + 命令 chip
 *
 * 设计要点：
 * 1. 一张表驱动三处：自动补全候选、快捷指令面板、/help。
 * 2. 执行仍走 window.handleSlashCommand（panel-workspace-ui.js），本文件只负责
 *    「把命令送到它手上」和「参数填写的交互」，不重复实现业务分支。
 * 3. 带参命令选中后不弹框：命令收进 chip，光标落进 textarea，用户只打参数。
 *    发送时 sendChat 把 chip 拼回 `/cmd 参数`。
 */
(function () {
  'use strict';
  if (window.__slashInit) return;
  window.__slashInit = 1;

  /* kind: none=选中即执行（不收参数）
   *       chip=必须填参数，选中后进 chip
   *       opt =参数可选，选中后也进 chip，但 chip 里直接回车就是只发命令本身
   *       pick=就地选单
   * 注意 opt 也会进 chip（历史如此）。要「选了就跑、不问参数」只能用 none。 */
  var CMDS = [
    { n: 'new',         d: '新建会话',                 a: '[标题]',    k: 'opt'  },
    { n: 'title',       d: '重命名当前会话',            a: '新标题',     k: 'chip' },
    { n: 'model',       d: '切换模型（就地选）',         a: '',          k: 'pick' },
    { n: 'personality', d: '换表达风格（就地选）',       a: '',          k: 'pick' },
    { n: 'plan',        d: '让 AI 先出计划',            a: '要规划什么',  k: 'chip' },
    { n: 'queue',       d: '排一条消息进队列',           a: '消息内容',    k: 'chip' },
    { n: 'steer',       d: '补充要求，插到队首',          a: '补充要求',    k: 'chip' },
    { n: 'goal',        d: '设定跨回合目标',            a: '目标',       k: 'chip' },
    { n: 'compress',    d: '压缩上下文（真压缩，可加「预览」先看收益）', a: '', k: 'none' },
    { n: 'stop',        d: '停止当前回合',              a: '',          k: 'none' },
    { n: 'interrupt',   d: '同 /stop',                 a: '',          k: 'none' },
    { n: 'usage',       d: '用量与花费',                a: '',          k: 'none' },
    { n: 'status',      d: '总览',                     a: '',          k: 'none' },
    { n: 'help',        d: '命令帮助',                  a: '',          k: 'none' }
  ];
  window.SLASH_COMMANDS = CMDS;
  function byName(n) { for (var i = 0; i < CMDS.length; i++) if (CMDS[i].n === n) return CMDS[i]; return null; }

  var pop = null, items = [], sel = 0, chipBar = null, chipEl = null;
  window.__slashPending = null;

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function ta() { return document.getElementById('chatInput'); }

  /* ── 候选浮层 ───────────────────────────────────────────── */
  function ensurePop() {
    if (pop && pop.isConnected) return pop;
    pop = el('div', 'slash-pop');
    pop.id = 'slashPop';
    pop.setAttribute('role', 'listbox');
    pop.hidden = true;
    document.body.appendChild(pop);
    return pop;
  }

  function place() {
    var t = ta(); if (!t || !pop || pop.hidden) return;
    var r = t.getBoundingClientRect();
    var h = pop.offsetHeight || 0;
    var top = r.top - h - 6;
    if (top < 8) top = r.bottom + 6;              // 上方不够就翻到下面
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)) + 'px';
    pop.style.top = top + 'px';
    pop.style.minWidth = Math.min(Math.max(r.width, 260), 520) + 'px';
  }

  function filter(cmds, q) {
    q = q.toLowerCase();
    if (!q) return cmds;
    var starts = [], has = [];
    for (var i = 0; i < cmds.length; i++) {
      var c = cmds[i];
      if (c.n.indexOf(q) === 0) starts.push(c);
      else if (c.n.indexOf(q) > 0 || c.d.indexOf(q) >= 0) has.push(c);
    }
    return starts.concat(has);
  }

  function render(q) {
    ensurePop();
    items = filter(CMDS, q);
    sel = 0;
    if (!items.length) { pop.hidden = true; return; }
    pop.innerHTML = '';
    items.forEach(function (c, i) {
      var row = el('div', 'slash-item' + (i === 0 ? ' on' : ''));
      row.setAttribute('role', 'option');
      row.dataset.name = c.n;
      row.innerHTML = '<span class="slash-name">/' + c.n + (c.a ? ' <i>' + c.a + '</i>' : '') + '</span>' +
                      '<span class="slash-desc">' + c.d + '</span>';
      row.addEventListener('mousedown', function (ev) { ev.preventDefault(); pick(i); });
      pop.appendChild(row);
    });
    pop.hidden = false;
    place();
  }

  function move(d) {
    if (!pop || pop.hidden) return;
    var rows = pop.querySelectorAll('.slash-item');
    if (!rows.length) return;
    rows[sel] && rows[sel].classList.remove('on');
    sel = (sel + d + rows.length) % rows.length;
    rows[sel].classList.add('on');
    if (rows[sel].scrollIntoView) rows[sel].scrollIntoView({ block: 'nearest' });
  }

  function hidePop() { if (pop) pop.hidden = true; }

  /* ── chip ──────────────────────────────────────────────── */
  function ensureChipBar() {
    if (chipBar && chipBar.isConnected) return chipBar;
    chipBar = el('div', 'slash-chips');
    chipBar.id = 'slashChipBar';
    var anchor = document.getElementById('skillChips');
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(chipBar, anchor.nextSibling);
    else document.getElementById('chatComposer').prepend(chipBar);
    return chipBar;
  }

  function setChip(name) {
    window.__slashPending = byName(name) || { n: name, k: 'chip', a: '' };
    ensureChipBar();
    chipBar.innerHTML = '';
    chipEl = el('span', 'slash-chip');
    chipEl.innerHTML = '<b>/' + name + '</b>' +
      (window.__slashPending.a ? '<em>' + window.__slashPending.a + '</em>' : '') +
      '<button type="button" aria-label="取消命令" title="取消">×</button>';
    chipEl.querySelector('button').addEventListener('click', function (e) { e.preventDefault(); clearChip(); });
    chipBar.appendChild(chipEl);
    chipBar.hidden = false;
    var t = ta(); if (t) { t.focus(); t.placeholder = window.__slashPending.a || '输入参数…'; }
  }

  window.slashClearChip = function () { clearChip(); };
  function clearChip() {
    window.__slashPending = null;
    if (chipBar) { chipBar.innerHTML = ''; chipBar.hidden = true; }
    var t = ta(); if (t) { t.placeholder = '输入消息…'; }
  }

  /* ── 选中一条命令 ───────────────────────────────────────── */
  function pick(i) {
    var c = items[i]; if (!c) return;
    hidePop();
    var t = ta();

    if (c.k === 'pick') {
      if (t) { t.value = ''; t.style.height = 'auto'; }
      if (c.n === 'model') { window.openMini && window.openMini(document.getElementById('btnModel'), 'model'); return; }
      window.handleSlashCommand('/' + c.n);
      return;
    }
    if (c.k === 'none') {
      if (t) { t.value = ''; t.style.height = 'auto'; }
      window.handleSlashCommand('/' + c.n);
      return;
    }
    if (c.k === 'chip') {
      if (t) { t.value = ''; t.style.height = 'auto'; }
      setChip(c.n);
      return;
    }
    /* opt：选中后进 chip，参数可留空（chip 里直接回车 = 只发命令本身） */
    if (t) { t.value = ''; t.style.height = 'auto'; }
    setChip(c.n);
  }

  /* ── 输入联动 ───────────────────────────────────────────── */
  function onInput() {
    var t = ta(); if (!t) return;
    var v = t.value;
    if (window.__slashPending) { hidePop(); return; }     // chip 模式不再弹候选
    /* 只要行首是 /，就弹候选。
       旧版正则 /^\/([a-z]*)$/ 要求整框只有一个 /词，用户「先打了一堆字、再把光标
       挪到最前面补 /」时 value 变成 "/一堆中文"，正则不匹配 → 浮层不弹（2026-11-11 报的）。
       现在只认行首 /，后面第一个词若全是字母数字就当过滤词，否则当空查询列全量。 */
    if (v.charAt(0) === '/') {
      var w = v.slice(1).split(/\s/)[0];
      render(/^[a-z0-9]*$/i.test(w) ? w : '');
      return;
    }
    hidePop();
  }

  function onKeyDown(e) {
    if (window.__slashPending) {
      if (e.key === 'Escape') { e.preventDefault(); clearChip(); return; }
      if (e.key === 'Backspace' && !ta().value) { e.preventDefault(); clearChip(); return; }
      if (e.key === 'Enter' && !e.shiftKey) { window.__slashEnter = true; }
      return;
    }
    if (!pop || pop.hidden) {
      /* 空输入框按 / 立刻弹全量 */
      if (e.key === '/' && !ta().value) { setTimeout(function () { render(''); }, 0); }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); pick(sel); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); hidePop(); }
  }

  /* Enter 发送时若浮层开着，先收浮层不发送（onKey 在冒泡阶段，这里已 stopPropagation） */

  function bind() {
    var t = ta(); if (!t || t.__slashBound) return;
    t.__slashBound = 1;
    t.addEventListener('input', onInput);
    t.addEventListener('keydown', onKeyDown, true);      // 捕获阶段，抢在 onKey 之前
    t.addEventListener('blur', function () { setTimeout(hidePop, 120); });
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    document.addEventListener('click', function (e) {
      if (pop && !pop.hidden && !pop.contains(e.target) && e.target !== t) hidePop();
    });
  }

  /* ── 快捷指令面板（喂给 index.html 的 buildMiniPopupBody('quick')）─────
   * 结构必须是 {title, commands:[{ico,title,sub,cmd}]}：
   * 消费方 6181 行写的是 g.title + g.commands.forEach + c.title/c.cmd/c.ico。
   * 旧版这里返回的是 {name, items:[{label,desc,run}]}，g.commands 为 undefined，
   * forEach 直接抛 TypeError → 弹窗根本不渲染 → 用户看到的就是「快捷指令按钮点不动」
   * （2026-11-11 报的）。cmd 里存 '/'+名字，pickQuick 会转给 slashInsert。 */
  function quickGroups() {
    return [{
      title: '斜杠命令',
      commands: CMDS.map(function (c) {
        return {
          ico: c.k === 'pick' ? '◧' : (c.k === 'none' ? '⚡' : '⌘'),
          title: '/' + c.n + (c.a ? ' ' + c.a : ''),
          sub: c.d,
          cmd: '/' + c.n
        };
      })
    }];
  }

  /* 供 index.html 的 pickQuick() 调用：按命令种类走和候选浮层完全一样的分支，
     不再直接 handleSlashCommand('/model')（那条会跳模型配置页）。 */
  window.slashInsert = function (name) {
    name = String(name || '').replace(/^\//, '').split(/\s/)[0];
    var c = byName(name);
    if (!c) return false;
    var t = ta();
    if (c.k === 'pick') {
      if (t) { t.value = ''; t.style.height = 'auto'; }
      if (c.n === 'model') { window.openMini && window.openMini(document.getElementById('btnModel'), 'model'); return true; }
      window.handleSlashCommand('/' + c.n);
      return true;
    }
    if (c.k === 'none') {
      if (t) { t.value = ''; t.style.height = 'auto'; }
      window.handleSlashCommand('/' + c.n);
      return true;
    }
    if (t) { t.value = ''; t.style.height = 'auto'; }
    setChip(c.n);
    return true;
  };

  function boot() {
    bind();
    if (!window.PV || !Array.isArray(window.PV.quickGroups)) return;
    /* 幂等：boot 会被调用两次（DOMContentLoaded + 1500ms 兜底），
       旧版每次都 concat 一份，组数越滚越多。现在先剔掉旧的那组再放新的。 */
    var rest = window.PV.quickGroups.filter(function (x) {
      return x && x.title !== '斜杠命令' && x.name !== '斜杠命令';
    });
    window.PV.quickGroups = quickGroups().concat(rest);
  }
  window.slashBoot = boot;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 300); });
  else setTimeout(boot, 300);
  setTimeout(boot, 1500);   // PV.quickGroups 由 panel-workspace-ui.js 后置填充，补一次
})();


/* ══════════════════════════════════════════════════════════════════
 * 真实命令实现：/status、/queue、/steer、/goal
 * 这一层只做「取真数据 → 渲染 → 调真接口」，没有数据就直说没有。
 * 由 panel-workspace-ui.js 的 handleSlashCommand 分发进来。
 * ══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  function $id(id) { return document.getElementById(id); }
  function esc(s) { return DOM.escAttr(s); }  /* 唯一实现在 core/dom.js */
  function toast(msg, kind) {
    if (window.ui && ui.toast) return ui.toast(msg, kind);
    if (typeof window.toast === 'function') return window.toast(msg);
    console.log('[slash]', msg);
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function api(path, method, body) {
    if (typeof window.api === 'function') return window.api(path, method || 'GET', body);
    var opt = { method: method || 'GET', credentials: 'same-origin', headers: {} };
    if (body) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    return fetch(path, opt).then(function (r) { return r.json(); });
  }

  function sid() { return window.currentSession || ''; }

  /* ─────────────── /status：真数字，不切页 ─────────────── */
  function status() {
    var m = $id('miniPopup');
    var ctxTxt = '';
    var ctxEl = $id('statCtx') || $id('ctxBadge');
    if (ctxEl) ctxTxt = (ctxEl.textContent || '').trim();
    var msgEl = $id('statMsgs');
    var msgTxt = msgEl ? (msgEl.textContent || '').trim() : '';

    var model = (typeof window._getSessionModel === 'function' && window._getSessionModel()) || '';
    var prov = '';
    try {
      var c = window._cfg || {};
      if (!model) model = c.default_model || c.model || '';
      prov = c.active_provider || '';
    } catch (e) {}

    api('/api/status').then(function (st) {
      st = st || {};
      var g = st.gateway || {}, d = st.dashboard || {};
      var act = g.active || {};
      var rows = [
        ['模型', model ? (model + (prov ? ' · ' + prov : '')) : '（跟随默认）'],
        ['会话', (sid() ? sid().slice(0, 8) : '—') + (msgTxt ? ' · ' + msgTxt : '')],
        ['上下文', ctxTxt || '—'],
        ['Gateway', (g.running ? '运行中' : '未运行') + (g.healthy === false ? ' · 不健康' : '') + (g.pid ? ' · pid ' + g.pid : '') + (g.port ? ' · :' + g.port : '')],
        ['在跑', act.agents != null ? ('agent ' + act.agents + ' · api ' + (act.api || 0) + ' · 委派 ' + (act.delegations || 0)) : '—'],
        ['版本', (g.version || st.version || '—') + (st.uptime ? ' · 已运行 ' + st.uptime : '')],
        ['Dashboard', (d.running ? '运行中' : '未运行') + (d.port ? ' · :' + d.port : '')],
        ['内存', st.mem_kb ? (st.mem_kb / 1024).toFixed(0) + ' MB' : '—']
      ];
      var html = '<div class="stt-wrap">';
      rows.forEach(function (r) {
        html += '<div class="stt-row"><span class="stt-k">' + esc(r[0]) + '</span><span class="stt-v">' + esc(r[1]) + '</span></div>';
      });
      html += '</div>';
      html += '<div class="stt-actions">'
            + '<button type="button" class="btn sm" onclick="slashRun.queue()">查看队列</button>'
            + '<button type="button" class="btn sm" onclick="slashRun.modelPick()">切换模型</button></div>';
      if (window.ui && ui.modal) ui.modal({ title: '运行状态', body: html, width: 460 });
      else toast(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    }).catch(function (e) {
      toast('取状态失败：' + (e && e.message ? e.message : e));
    });
  }

  /* ─────────────── /queue：真队列，可取消/重试/标已阅 ─────────────── */
  var Q_STATUS = {
    pending: ['等待', '#c99a2e'], running: ['执行中', '#3b82f6'],
    done: ['完成', '#2ea36b'], failed: ['失败', '#d94a4a'],
    interrupted: ['被打断', '#c9722e'], cancelled: ['已取消', '#8a8a8a']
  };

  function queue(arg) {
    var all = arg === 'all' || arg === '全部';
    var q = '/api/chat/queue?limit=20' + (all ? '&all=1' : '&session_id=' + encodeURIComponent(sid()));
    api(q).then(function (r) {
      var jobs = (r && r.jobs) || [];
      if (!jobs.length) {
        toast(all ? '队列是空的' : '当前会话没有排队消息');
        return;
      }
      jobs.sort(function (a, b) { return (b.created_at || 0) - (a.created_at || 0); });
      var html = '<div class="q-list">';
      jobs.forEach(function (j) {
        var s = Q_STATUS[j.status] || [j.status, '#888'];
        var head = '';
        try { head = (j.payload && j.payload.message) || ''; } catch (e) {}
        head = String(head).replace(/\s+/g, ' ').slice(0, 70);
        var when = j.created_at ? new Date(j.created_at).toLocaleTimeString('zh-CN', { hour12: false }) : '';
        var acts = '';
        if (j.status === 'pending' || j.status === 'running') {
          acts += '<button type="button" class="q-btn" onclick="slashRun.queueAct(\'' + esc(j.id) + '\',\'cancel\')">取消</button>';
        }
        if (j.status === 'failed' || j.status === 'interrupted') {
          acts += '<button type="button" class="q-btn" onclick="slashRun.queueAct(\'' + esc(j.id) + '\',\'retry\')">重试</button>';
          acts += '<button type="button" class="q-btn" onclick="slashRun.queueAct(\'' + esc(j.id) + '\',\'resolve\')">已阅</button>';
        }
        if (j.status === 'done') {
          acts += '<button type="button" class="q-btn" onclick="slashRun.queueAct(\'' + esc(j.id) + '\',\'retry\')">再发一次</button>';
        }
        html += '<div class="q-row">'
              + '<span class="q-dot" style="background:' + s[1] + '"></span>'
              + '<div class="q-main"><div class="q-t">' + esc(head || '(空)') + '</div>'
              + '<div class="q-m">' + esc(s[0]) + (when ? ' · ' + when : '')
              + (all && j.session_id ? ' · ' + esc(String(j.session_id).slice(0, 8)) : '') + '</div></div>'
              + '<div class="q-acts">' + acts + '</div></div>';
      });
      html += '</div>';
      html += '<div class="q-foot">'
            + '<button type="button" class="btn sm" onclick="slashRun.queue(\'' + (all ? '' : 'all') + '\')">'
            + (all ? '只看当前会话' : '看全部会话') + '</button></div>';
      if (window.ui && ui.modal) ui.modal({ title: '消息队列（' + jobs.length + '）', body: html, width: 560 });
    }).catch(function (e) {
      toast('取队列失败：' + (e && e.message ? e.message : e));
    });
  }

  function queueAct(id, action) {
    var p;
    if (action === 'retry') {
      api('/api/chat/queue/' + id).then(function (j) {
        if (!j || !j.payload) throw new Error('取不到原消息');
        return api('/api/chat/queue', 'POST', {
          session_id: j.session_id, request_id: 'r-' + Date.now().toString(36),
          message: j.payload.message
        });
      }).then(function () { toast('已重新入队'); closeModal(); queue(); })
        .catch(function (e) { toast('重试失败：' + (e && e.message ? e.message : e)); });
      return;
    }
    p = api('/api/chat/queue/' + id + '/' + action, 'POST', {});
    p.then(function () {
      toast(action === 'cancel' ? '已取消' : '已标记已阅');
      closeModal(); queue();
    }).catch(function (e) { toast('操作失败：' + (e && e.message ? e.message : e)); });
  }

  function closeModal() {
    var b = document.querySelectorAll('.uikit-backdrop');
    if (b.length) {
      var x = b[b.length - 1].querySelector('.modal-close');
      if (x) { x.click(); return; }
    }
    if (window.ui && ui.closeTop) ui.closeTop();
    var m = document.getElementById('miniPopup');
    if (m && !m.hidden && typeof window.closeMini === 'function') window.closeMini();
  }

  /* ─────────────── /steer：能做的极限，说清楚 ─────────────── */
  function steer(arg) {
    if (!arg) throw new Error('用法：/steer <补充要求>（中止当前回合并按这条重来）');
    var streaming = !!(window._msgState && window._msgState.streaming);
    var lastQ = '';
    var nodes = document.querySelectorAll('#chatBody .msg.user .msg-bubble');
    if (nodes.length) lastQ = (nodes[nodes.length - 1].innerText || '').replace(/^你\s*/, '').trim();
    if (streaming && typeof window.chatStop === 'function') {
      window.chatStop();
      sleep(200).then(function () {
        window.sendRaw(lastQ ? (lastQ + '\n\n【中途补充】' + arg) : arg);
        toast('已中止并用补充要求重发');
      });
    } else {
      window.sendRaw(lastQ ? (lastQ + '\n\n【中途补充】' + arg) : arg);
      toast('当前没有在跑的回合，已按补充要求直接发送');
    }
  }

  /* ─────────────── /goal：持久目标，气泡不脏 ─────────────── */
  var GKEY = 'panel_goal';
  function goalGet() { try { return localStorage.getItem(GKEY) || ''; } catch (e) { return ''; } }
  function goalSet(v) { try { localStorage.setItem(GKEY, v); } catch (e) {} }

  function goal(arg) {
    var a = (arg || '').trim();
    if (!a || a === 'status' || a === '查看') {
      var g = goalGet();
      var html = g
        ? '<div class="goal-box"><div class="goal-lab">当前长期目标</div><div class="goal-txt">' + esc(g) + '</div>'
          + '<div class="goal-hint">之后的每条消息都会自动带上这个目标（气泡里不显示）。</div></div>'
          + '<div class="stt-actions"><button type="button" class="btn sm danger" onclick="slashRun.goal(\'clear\')">清除目标</button></div>'
        : '<div class="goal-box empty">还没有设目标。<br>用法：<code>/goal 三周内把面板命令体系做完</code></div>';
      if (window.ui && ui.modal) ui.modal({ title: '长期目标', body: html, width: 440 });
      return;
    }
    if (a === 'clear' || a === '清除') {
      goalSet('');
      closeModal();
      toast('已清除长期目标');
      return;
    }
    goalSet(a);
    toast('目标已设定，后续每轮自动带上');
  }

  function modelPick() {
    var btn = $id('btnModel');
    if (btn && typeof window.openMini === 'function') { window.openMini(btn, 'model'); return; }
    if (typeof window.switchPage === 'function') window.switchPage('models');
  }

  window.slashRun = {
    status: status, queue: queue, queueAct: queueAct,
    steer: steer, goal: goal, modelPick: modelPick,
    goalGet: goalGet
  };
})();
