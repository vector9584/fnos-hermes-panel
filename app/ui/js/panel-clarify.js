/* panel-clarify.js — 交互式确认卡片（clarify 工具在面板里的落地面）
 *
 * 链路：agent 调 clarify → 网关 SSE `event: clarify.request`
 *       → monitor.js createSSEParser → ws {clarify:{...}}
 *       → 这里渲染单选/多选/开放三种卡片
 *       → 用户点选/输入 → POST /api/clarify/respond
 *       → clarify_gateway 唤醒被阻塞的 agent 线程
 *
 * 约定：
 *  - 多选必须有「其他」入口（勾选 + 输入框），单选同理；开放问答只给输入框
 *  - 提交后卡片原地变成「已回复」摘要，输入全部禁用，防重复提交
 *  - 手机端一行一个选项、按钮满宽；PC 也不做多列，避免长选项换行错位
 */
(function () {
  var SEQ = 0;

  function esc(s) { return DOM.escAttr(s); }  /* 唯一实现在 core/dom.js */

  function respondUrl() {
    try {
      if (typeof apiUrl === 'function') return apiUrl('/api/clarify/respond');
    } catch (e) {}
    return '/api/clarify/respond';
  }

  function scrollToBottom() {
    try {
      if (typeof scrollChatToBottom === 'function') scrollChatToBottom();
      else if (typeof followChatBottom === 'function') followChatBottom();
    } catch (e) {}
  }

  function finishCard(card, summary) {
    var wrap = card.querySelector('.pw-clarify-form');
    if (wrap) wrap.remove();
    var foot = card.querySelector('.pw-clarify-foot');
    if (foot) foot.remove();
    card.classList.add('is-done');
    var done = document.createElement('div');
    done.className = 'pw-clarify-done';
    done.innerHTML = '<span class="pw-clarify-done-mark">✓</span>' + esc(summary);
    card.appendChild(done);
  }

  function submit(card, body) {
    var btn = card.querySelector('.pw-clarify-submit');
    if (btn) { btn.disabled = true; btn.textContent = '提交中…'; }
    var headers = { 'Content-Type': 'application/json' };
    try { if (typeof monitorToken !== 'undefined' && monitorToken) headers['X-Monitor-Token'] = monitorToken; } catch (e) {}
    fetch(respondUrl(), {
      method: 'POST',
      headers: headers,
      credentials: 'same-origin',
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, body: j }; });
    }).then(function (res) {
      if (res.ok && res.body && res.body.ok !== false) {
        var shown = Array.isArray(body.response) ? body.response.join('、') : String(body.response || '');
        finishCard(card, shown);
        scrollToBottom();
      } else {
        var msg = (res.body && (res.body.error && (res.body.error.message || res.body.error))) || ('HTTP ' + res.status);
        if (btn) { btn.disabled = false; btn.textContent = '重新提交'; }
        var hint = card.querySelector('.pw-clarify-hint');
        if (hint) { hint.textContent = '提交失败：' + msg; hint.classList.add('is-error'); }
      }
    }).catch(function (e) {
      if (btn) { btn.disabled = false; btn.textContent = '重新提交'; }
      var hint = card.querySelector('.pw-clarify-hint');
      if (hint) { hint.textContent = '提交失败：' + (e && e.message ? e.message : e); hint.classList.add('is-error'); }
    });
  }

  function buildOtherRow(kind, id) {
    var type = kind === 'multi' ? 'checkbox' : 'radio';
    return '<label class="pw-clarify-opt pw-clarify-other">' +
      '<input type="' + type + '" name="pwc-' + id + '" value="__other__">' +
      '<span class="pw-clarify-mark"></span>' +
      '<input class="pw-clarify-other-input" type="text" placeholder="其他（自己填）" autocomplete="off" enterkeyhint="done">' +
      '</label>';
  }

  function ask(clarify) {
    if (!clarify || !clarify.clarify_id) return;
    var body = document.getElementById('chatBody');
    if (!body) return;
    // 同一个 clarify 重复推送（重连/回放）只渲染一次
    if (body.querySelector('.pw-clarify[data-clarify-id="' + clarify.clarify_id + '"]')) return;

    var id = 'c' + (++SEQ);
    var choices = Array.isArray(clarify.choices) ? clarify.choices.map(function (c) { return String(c); }).filter(function (c) { return c.trim(); }) : [];
    var multi = !!clarify.multi_select && choices.length > 0;
    var kind = choices.length ? (multi ? 'multi' : 'single') : 'open';

    var card = document.createElement('div');
    card.className = 'pw-clarify pw-clarify-' + kind;
    card.setAttribute('data-clarify-id', clarify.clarify_id);
    card.setAttribute('role', 'group');
    card.setAttribute('aria-label', '需要你确认的问题');

    var html = '<div class="pw-clarify-head"><span class="pw-clarify-badge">需要你确认</span>' +
      (kind === 'multi' ? '<span class="pw-clarify-mode">可多选</span>' : '') + '</div>' +
      '<div class="pw-clarify-q">' + esc(clarify.question || '') + '</div>';

    html += '<div class="pw-clarify-form">';
    if (kind === 'open') {
      html += '<textarea class="pw-clarify-text" rows="3" placeholder="输入你的回答…" enterkeyhint="done"></textarea>';
    } else {
      html += '<div class="pw-clarify-opts">';
      choices.forEach(function (c) {
        html += '<label class="pw-clarify-opt">' +
          '<input type="' + (multi ? 'checkbox' : 'radio') + '" name="pwc-' + id + '" value="' + DOM.escAttr(c) + '">' +
          '<span class="pw-clarify-mark"></span>' +
          '<span class="pw-clarify-label">' + esc(c) + '</span>' +
          '</label>';
      });
      html += buildOtherRow(kind, id);
      html += '</div>';
    }
    html += '<div class="pw-clarify-foot">' +
      '<button type="button" class="pw-clarify-submit">提交</button>' +
      '<span class="pw-clarify-hint">' + (kind === 'multi' ? '可勾选多个，也可自己填' : kind === 'single' ? '选一个，或者自己填' : '直接输入') + '</span>' +
      '</div></div>';

    card.innerHTML = html;

    // 「其他」输入框获得焦点即自动勾选，省一次点击
    var otherInput = card.querySelector('.pw-clarify-other-input');
    if (otherInput) {
      otherInput.addEventListener('focus', function () {
        var box = card.querySelector('.pw-clarify-other input[type="' + (multi ? 'checkbox' : 'radio') + '"]');
        if (box) box.checked = true;
      });
    }

    // 单选：点选项直接提交，少一次点击（多选/开放仍需点提交）
    if (kind === 'single') {
      card.querySelectorAll('.pw-clarify-opts > .pw-clarify-opt > input[type="radio"]').forEach(function (r) {
        r.addEventListener('change', function () {
          if (!r.checked) return;
          submit(card, { clarify_id: clarify.clarify_id, response: r.value });
        });
      });
    }

    var btn = card.querySelector('.pw-clarify-submit');
    if (btn) {
      btn.addEventListener('click', function () {
        if (kind === 'open') {
          var ta = card.querySelector('.pw-clarify-text');
          var text = ta ? String(ta.value || '').trim() : '';
          if (!text) { var h0 = card.querySelector('.pw-clarify-hint'); if (h0) h0.textContent = '先写点什么再提交'; return; }
          submit(card, { clarify_id: clarify.clarify_id, response: text });
          return;
        }
        var picked = [];
        card.querySelectorAll('.pw-clarify-opts > .pw-clarify-opt > input').forEach(function (box) {
          if (!box.checked) return;
          if (box.value === '__other__') {
            var t = otherInput ? String(otherInput.value || '').trim() : '';
            if (t) picked.push(t);
          } else {
            picked.push(box.value);
          }
        });
        if (!picked.length) {
          var h1 = card.querySelector('.pw-clarify-hint');
          if (h1) h1.textContent = multi ? '至少勾一项' : '先选一项';
          return;
        }
        submit(card, { clarify_id: clarify.clarify_id, response: multi ? picked : picked[0] });
      });
    }

    // 「其他」里按回车 = 提交
    if (otherInput) {
      otherInput.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); if (btn) btn.click(); }
      });
    }
    var taEl = card.querySelector('.pw-clarify-text');
    if (taEl) {
      taEl.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); if (btn) btn.click(); }
      });
      setTimeout(function () { try { taEl.focus(); } catch (e) {} }, 30);
    }

    body.appendChild(card);
    scrollToBottom();
    /* 卡片在等人，不是模型在算：把状态条从「正在回复 Ns」换成「等你选一个」，
       否则用户看着计时器一直涨，以为我卡死了。选完/超时后正常的工具事件会覆盖它。 */
    try { if (window.genBarShow) window.genBarShow('ask', '等你选一个'); } catch (e) {}
    try {
      if (window.matchMedia && window.matchMedia('(max-width: 760px)').matches && taEl) taEl.focus();
    } catch (e) {}
  }

  window.pwClarifyAsk = ask;
  // 2026-11-12：新消息抢占。会话里那张卡片没人答时，队列 worker 会一直等它（默认 600s），
  // 后面所有消息都排在后面发不出去。用户既然改说别的了，就把挂着的提问按「跳过」结掉。
  window.pwClarifyDismissPending = function (reason) {
    var cards = Array.prototype.slice.call(document.querySelectorAll('.pw-clarify:not(.is-done)'));
    if (!cards.length) return 0;
    var text = String(reason || '（跳过：用户没有回答，改为发送了新消息）');
    cards.forEach(function (card) {
      var id = card.getAttribute('data-clarify-id');
      if (!id) return;
      var headers = { 'Content-Type': 'application/json' };
      try { if (typeof monitorToken !== 'undefined' && monitorToken) headers['X-Monitor-Token'] = monitorToken; } catch (e) {}
      fetch(respondUrl(), {
        method: 'POST',
        headers: headers,
        credentials: 'same-origin',
        body: JSON.stringify({ clarify_id: id, response: text })
      }).then(function () {
        if (!card.classList.contains('is-done')) finishCard(card, '已跳过（你改说了别的）');
      }).catch(function () {
        if (!card.classList.contains('is-done')) finishCard(card, '已跳过（你改说了别的）');
      });
    });
    return cards.length;
  };
  window.pwClarifyRespond = function (clarifyId, response) {
    var card = document.querySelector('.pw-clarify[data-clarify-id="' + clarifyId + '"]');
    if (!card) return;
    submit(card, { clarify_id: clarifyId, response: response });
  };
})();
