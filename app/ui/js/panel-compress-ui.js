/* panel-compress-ui.js — /compress 真压缩入口（2026-11-13）
 *
 * 之前 /compress 是假命令：只是往对话里塞一句「请把当前会话压缩成摘要」，
 * 内核根本不知道你在压缩上下文，白烧一次模型调用还什么都没变。
 *
 * 现在：POST /api/chat/compress → 后端 panel-chat-compress.py 把会话 JSON 的早段
 * messages 换成语义摘要并写回同一个文件（session_id 不变），前端重载消息、
 * 刷新上下文百分比。预览模式只算不写。
 *
 * 用法：
 *   /compress                  直接压缩，保留最近约 15%
 *   /compress 预览              只看会压掉多少，不写
 *   /compress here 20          保留最近 20 条
 *   /compress 只看部署相关       带聚焦要求
 */
(function () {
  'use strict';
  if (window.__compressInit) return;
  window.__compressInit = 1;

  function parseArgs(raw) {
    var out = { preview: false, keepLast: 0, focus: '', detail: false };
    var s = String(raw || '').trim();
    if (!s) return out;
    var words = s.split(/\s+/);
    var rest = [];
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (w === '--preview' || w === '-p' || w === '预览') { out.preview = true; continue; }
      if (w === '详情' || w === '--detail' || w === 'detail') { out.detail = true; continue; }
      if (w === 'here' || w === '--keep' || w === '保留') {
        var n = parseInt(words[i + 1], 10);
        if (n > 0) { out.keepLast = n; i++; continue; }
      }
      rest.push(w);
    }
    out.focus = rest.join(' ').trim();
    return out;
  }

  function tok(n) {
    n = Math.round(n || 0);
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(n);
  }

  function post(body) {
    var headers = { 'Content-Type': 'application/json' };
    if (typeof monitorToken !== 'undefined' && monitorToken) headers['X-Monitor-Token'] = monitorToken;
    var url = (typeof apiUrl === 'function') ? apiUrl('/api/chat/compress') : '/api/chat/compress';
    return fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body), cache: 'no-store' })
      .then(function (r) {
        return r.json().catch(function () { return null; }).then(function (d) {
          if (!r.ok || !d || d.ok === false) {
            throw Error((d && d.error) || ('压缩失败 HTTP ' + r.status));
          }
          return d;
        });
      });
  }

  function say(msg) {
    try { if (typeof ui !== 'undefined' && ui.toast) { ui.toast(msg); return; } } catch (_) {}
    if (typeof toast === 'function') toast(msg);
  }

  function modalBox(title, html, buttons) {
    if (typeof ui !== 'undefined' && ui.modal) return ui.modal({ title: title, body: html, actions: buttons || [] });
    var d = document.createElement('div');
    d.className = 'modal-overlay';
    d.innerHTML = '<div class="modal"><h3>' + title + '</h3><div class="modal-body">' + html + '</div></div>';
    document.body.appendChild(d);
    return d;
  }

  function refreshAfterCompress(sid) {
    try {
      if (typeof loadSessionMessages === 'function') loadSessionMessages(sid, true);
    } catch (_) {}
    try {
      if (typeof _hdrMetricCache === 'object' && _hdrMetricCache) delete _hdrMetricCache[sid];
      if (typeof updateHeader === 'function') updateHeader();
    } catch (_) {}
  }

  function showPreview(d, sid) {
    var willRemove = d.removed, willKeep = d.kept;
    var saved = d.estimate_saved || 0;
    var pct = d.before_tokens ? Math.round((saved / d.before_tokens) * 100) : 0;
    var html =
      '<p>将把 <b>' + willRemove + '</b> 条早期消息换成一份摘要，保留最近 <b>' + willKeep + '</b> 条。</p>' +
      '<p>上下文估算：<b>' + tok(d.before_tokens) + '</b> tokens → 约 <b>' + tok(d.estimate_after_tokens) +
      '</b> tokens（省 ' + tok(saved) + '，约 ' + pct + '%）</p>' +
      '<p class="muted">摘要本身要花一次模型调用，通常 1 分钟左右。原会话会先备份再改。</p>';
    var buttons = [
      { text: '取消', kind: 'ghost' },
      {
        text: '执行压缩', kind: 'primary', onClick: function () {
          runCompress('', sid, { keepLast: d.kept });
          return true;
        }
      }
    ];
    modalBox('压缩预览', html, buttons);
  }

  /* 压缩完只弹一行不挡手的气泡提示，不再弹模态框。
   * 会话里已经由后端写进「📦 本会话已自动压缩」标记，刷新也在，那才是真状态；
   * 模态框只是噪音 —— 2026-11-13 用户原话「为什么最后还要弹框啊」。 */
  function notifyResult(d, secs, sid) {
    var pct = d.before_tokens ? Math.round(((d.saved || 0) / d.before_tokens) * 100) : 0;
    window.__lastCompress = { d: d, secs: secs, sid: sid };
    say('已压缩 ' + tok(d.before_tokens) + ' → ' + tok(d.after_tokens) + ' tokens（省 ' + pct +
        '%）· ' + d.messages_before + ' → ' + d.messages_after + ' 条 · ' + secs + 's　详情：/compress 详情');
  }

  function showResult(d, secs) {
    var pct = d.before_tokens ? Math.round(((d.saved || 0) / d.before_tokens) * 100) : 0;
    var head = '上下文压缩完成：' + tok(d.before_tokens) + ' → ' + tok(d.after_tokens) +
      ' tokens（省 ' + pct + '%）· ' + d.messages_before + ' → ' + d.messages_after + ' 条 · ' + secs + 's';
    var body = '<p>' + head + '</p>' +
      '<p class="muted">摘要模型：' + (d.model_used || '未知') + '　备份：' + (d.backup ? d.backup.split('/').pop() : '无') + '</p>' +
      '<details><summary>查看摘要</summary><pre class="compress-summary">' +
      String(d.summary || '').replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }) +
      '</pre></details>';
    modalBox('压缩完成', body, [{ text: '好', kind: 'primary' }]);
  }

  window.compressDetail = function () {
    var last = window.__lastCompress;
    if (!last) { say('这次打开页面还没压缩过，先发 /compress'); return; }
    showResult(last.d, last.secs);
  };

  window.runCompress = async function (raw, sessionId, override) {
    var sid = sessionId || (typeof currentSession !== 'undefined' ? currentSession : null);
    if (!sid) throw Error('请先打开会话');
    var a = parseArgs(raw);
    if (a.detail) { window.compressDetail(); return null; }
    if (override && override.keepLast) a.keepLast = override.keepLast;
    say(a.preview ? '正在估算压缩收益…' : '正在压缩上下文，约 1 分钟，别关这个页面');
    var t0 = Date.now();
    var d = await post({ session_id: sid, focus: a.focus, keep_last: a.keepLast, preview: a.preview });
    var secs = Math.round((d.duration_ms || (Date.now() - t0)) / 1000);
    if (a.preview) { showPreview(d, sid); return d; }
    refreshAfterCompress(sid);
    notifyResult(d, secs, sid);
    return d;
  };

  window.compressPreviewHtml = function (d) { return d; };
})();
