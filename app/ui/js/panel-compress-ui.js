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
      if (typeof _hdrArchiveCache === 'object' && _hdrArchiveCache) delete _hdrArchiveCache[sid];
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
        '%）· ' + d.messages_before + ' → ' + d.messages_after + ' 条 · ' + secs + 's' +
        '　压掉的 ' + d.removed + ' 条原文已归档，点会话头「📦 归档」可翻');
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

  /* ══════════════════ 压缩归档查看器（2026-11-15，2026-11-15 二次改：并入「已归档」）═
   * 为什么要有这个：压缩不是删消息，是把早段换成摘要。但面板以前没有任何
   * 「原话在哪」的入口，用户体感就是「消息被删没了」，于是不敢再用 /compress。
   *
   * 不另造一套归档（用户明确要求）：原文落到 chat/compressed/<sid>/<ts>.json，
   * 和「已归档会话」(chat/archived-sessions/) 同一棵归档树，面板上同一个
   * 「已归档」弹窗里统一列、统一彻底删除；会话被彻底删除时连带清掉。
   * 数据只走 monitor API（带 token），不做静态文件暴露——原文里有私密对话。
   * ══════════════════════════════════════════════════════════════════ */
  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function archApi(path, method, body) {
    if (typeof api !== 'function') return Promise.reject(new Error('面板接口未就绪'));
    return Promise.resolve(api(path, method || 'GET', body));
  }

  function archList() { return archApi('/api/sessions/compressed', 'GET'); }
  function archBatch(sid, file) {
    return archApi('/api/sessions/compressed/batch?id=' + encodeURIComponent(sid) + '&file=' + encodeURIComponent(file), 'GET');
  }
  function archDel(sid, file) { return archApi('/api/sessions/compressed/delete', 'POST', { id: sid, file: file }); }
  function archPurge(sid) { return archApi('/api/sessions/compressed/purge', 'POST', { id: sid }); }

  /* 删原文这事只有这里能做，误点一次就没了 —— 所以要点两下：
     第一下把按钮变成「确认删除」，第二下才真删，5 秒不点自己缩回去。 */
  function armDanger(btn, run) {
    var armed = false, timer = null;
    var label = btn.textContent;
    btn.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      if (!armed) {
        armed = true; btn.classList.add('is-armed'); btn.textContent = '再点一次确认删除';
        timer = setTimeout(function () { armed = false; btn.classList.remove('is-armed'); btn.textContent = label; }, 5000);
        return;
      }
      clearTimeout(timer); btn.disabled = true; btn.textContent = '删除中…';
      Promise.resolve().then(run).catch(function (err) {
        armed = false; btn.disabled = false; btn.classList.remove('is-armed'); btn.textContent = label;
        say('删除失败：' + (err && err.message ? err.message : err));
      });
    });
  }

  function tsText(ms) {
    if (!ms) return '';
    try {
      var d = new Date(ms);
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0') + ' ' + String(d.getHours()).padStart(2, '0') + ':' +
        String(d.getMinutes()).padStart(2, '0');
    } catch (_) { return ''; }
  }

  function overlay(titleText, bodyHtml) {
    var old = document.querySelector('.arch-overlay');
    if (old) old.remove();
    var d = document.createElement('div');
    d.className = 'modal-overlay arch-overlay';
    d.innerHTML = '<div class="modal arch-modal">' +
      '<div class="arch-head"><b>' + escHtml(titleText) + '</b>' +
      '<button type="button" class="arch-close" aria-label="关闭">×</button></div>' +
      '<div class="arch-body">' + bodyHtml + '</div></div>';
    d.addEventListener('click', function (e) {
      if (e.target === d || e.target.classList.contains('arch-close')) d.remove();
    });
    document.body.appendChild(d);
    return d;
  }

  function dropChipCache(sid) {
    try { if (typeof _hdrArchiveCache === 'object' && _hdrArchiveCache) delete _hdrArchiveCache[sid]; } catch (_) {}
    try { if (typeof _hdrMetricCache === 'object' && _hdrMetricCache) delete _hdrMetricCache[sid]; } catch (_) {}
  }

  /* ── 第三层：一批被压掉的原文 ───────────────────────────────────── */
  function renderBatch(sid, entry) {
    archBatch(sid, entry.file).then(function (out) {
      var data = out && out.batch;
      if (!data) { say('这一批原文取不到，可能已被清理'); return; }
      var msgs = data.messages || [];
      var html = '<div class="arch-note">' + escHtml(tsText(data.at)) + ' · 压掉 <b>' + msgs.length +
        '</b> 条 · ' + tok(data.before_tokens) + ' → ' + tok(data.after_tokens) + ' tokens' +
        (data.model ? ' · 摘要模型 ' + escHtml(data.model) : '') + '</div>';
      if (data.summary) {
        html += '<details class="arch-sum"><summary>这一批换出的摘要</summary><pre>' + escHtml(data.summary) + '</pre></details>';
      }
      html += '<div class="arch-msgs">' + msgs.map(function (m, i) {
        var role = (m && m.role) || 'unknown';
        var who = (m && (m.sender || m.persona_name)) || '';
        var body = '';
        var c = m && m.content;
        if (typeof c === 'string') body = c;
        else if (c && typeof c === 'object') {
          try { body = JSON.stringify(c, null, 1); } catch (_) { body = String(c); }
        }
        var long = body.length > 1200;
        var pre = '<pre class="arch-pre">' + escHtml(long ? body.slice(0, 1200) : body) + '</pre>';
        if (long) pre += '<details><summary>展开全文（' + body.length + ' 字）</summary><pre class="arch-pre">' + escHtml(body) + '</pre></details>';
        return '<div class="arch-msg"><div class="arch-meta"><span class="arch-role r-' + escHtml(role) + '">' +
          escHtml(role) + (who && who !== role ? ' · ' + escHtml(who) : '') + '</span>' +
          (m && m.ts ? '<span class="arch-ts">' + escHtml(tsText(m.ts)) + '</span>' : '') +
          '<span class="arch-idx">#' + (i + 1) + '</span></div>' + pre + '</div>';
      }).join('') + '</div>';
      var box = overlay('归档原文 · ' + tsText(data.at), html);
      var body = box.querySelector('.arch-body');
      var bar = document.createElement('div');
      bar.className = 'arch-bar';
      var back = document.createElement('button');
      back.type = 'button'; back.className = 'arch-back'; back.textContent = '← 返回批次列表';
      back.addEventListener('click', function () { window.openCompressArchive(sid); });
      var del = document.createElement('button');
      del.type = 'button'; del.className = 'arch-del';
      del.textContent = '彻底删除这一批';
      armDanger(del, function () {
        return archDel(sid, entry.file).then(function () {
          dropChipCache(sid);
          say('这一批原文已彻底删除');
          window.openCompressArchive(sid);
        });
      });
      bar.appendChild(back); bar.appendChild(del);
      body.insertBefore(bar, body.firstChild);
      body.scrollTop = 0;
    }).catch(function (err) { say('读取失败：' + (err && err.message ? err.message : err)); });
  }

  /* ── 第二层：某个会话的批次列表 ─────────────────────────────────── */
  function renderSession(sid, title) {
    archList().then(function (out) {
      var rows = (out && out.sessions) || [];
      var s = null;
      for (var i = 0; i < rows.length; i++) if (rows[i].id === sid) { s = rows[i]; break; }
      var name = escHtml((s && s.title) || title || sid);
      if (!s) {
        overlay('压缩归档 · ' + (title || sid), '<div class="arch-note">这个会话还没有压缩归档。<br>' +
          '压缩过之后，被摘要替换掉的原文会一直留在这里，随时能翻、也能彻底删。</div>');
        return;
      }
      var html = '<div class="arch-note">' + name + ' · 共 <b>' + s.batches.length + '</b> 批 · 累计压掉 <b>' +
        (s.total_removed || 0) + '</b> 条原文' + (s.archived ? ' · <i>会话本身已归档</i>' : '') +
        '。点任意一批查看当时被换成摘要的完整消息。</div><div class="arch-list">' +
        s.batches.map(function (e, i) {
          return '<div class="arch-row"><button type="button" class="arch-item" data-i="' + i + '">' +
            '<span class="ai-when">' + escHtml(tsText(e.at)) + '</span>' +
            '<span class="ai-main">压掉 ' + (e.removed || 0) + ' 条 · ' + tok(e.before_tokens) +
            ' → ' + tok(e.after_tokens) + ' tokens</span>' +
            (e.focus ? '<span class="ai-focus">聚焦：' + escHtml(e.focus) + '</span>' : '') +
            '</button><button type="button" class="arch-del arch-del-sm" data-file="' + escHtml(e.file) + '">彻底删除</button></div>';
        }).join('') + '</div>' +
        '<div class="arch-foot"><button type="button" class="arch-del" id="archPurgeAll">彻底删除这个会话的全部压缩原文（' +
        s.batches.length + ' 批）</button></div>';
      var box = overlay('压缩归档 · ' + (s.title || title || sid), html);
      box.querySelectorAll('.arch-item').forEach(function (btn) {
        btn.addEventListener('click', function () { renderBatch(sid, s.batches[Number(btn.dataset.i)]); });
      });
      box.querySelectorAll('.arch-del-sm').forEach(function (btn) {
        var file = btn.dataset.file;
        armDanger(btn, function () {
          return archDel(sid, file).then(function () { dropChipCache(sid); window.openCompressArchive(sid); });
        });
      });
      var all = box.querySelector('#archPurgeAll');
      if (all) armDanger(all, function () {
        return archPurge(sid).then(function () {
          dropChipCache(sid);
          say('这个会话的压缩原文已全部彻底删除');
          window.openCompressArchive();
        });
      });
    }).catch(function (err) { say('读取失败：' + (err && err.message ? err.message : err)); });
  }

  /* ── 第一层：所有有压缩原文的会话（「已归档」弹窗的总入口）───────── */
  window.openCompressArchive = function (sidIn) {
    var sid = sidIn || null;
    if (!sid && typeof currentSession !== 'undefined' && currentSession) sid = currentSession;
    archList().then(function (out) {
      var rows = (out && out.sessions) || [];
      if (sid) { renderSession(sid); return; }
      if (!rows.length) {
        overlay('归档 · 压缩原文', '<div class="arch-note">还没有压缩原文。<br>' +
          '任何会话被压缩时，被摘要替换掉的原始消息都会落到这里，和已归档会话放在同一个地方，' +
          '随时能翻，也能彻底删。</div>');
        return;
      }
      var totalB = rows.reduce(function (n, s) { return n + s.batches.length; }, 0);
      var totalM = rows.reduce(function (n, s) { return n + (s.total_removed || 0); }, 0);
      var html = '<div class="arch-note">共 <b>' + rows.length + '</b> 个会话 · <b>' + totalB +
        '</b> 批 · 累计压掉 <b>' + totalM + '</b> 条原文。点会话看批次，点「彻底删除」才会真删。</div>' +
        '<div class="arch-list">' + rows.map(function (s) {
          return '<div class="arch-row"><button type="button" class="arch-item arch-item-sess" data-id="' + escHtml(s.id) + '">' +
            '<span class="ai-when">' + escHtml(tsText(s.latest_at)) + '</span>' +
            '<span class="ai-main">' + escHtml(s.title || s.id) + '</span>' +
            '<span class="ai-focus">' + s.batches.length + ' 批 · 压掉 ' + (s.total_removed || 0) + ' 条' +
            (s.archived ? ' · 会话已归档' : '') + '</span></button>' +
            '<button type="button" class="arch-del arch-del-sm" data-sid="' + escHtml(s.id) + '">彻底删除</button></div>';
        }).join('') + '</div>';
      var box = overlay('归档 · 压缩原文（' + totalB + ' 批）', html);
      box.querySelectorAll('.arch-item-sess').forEach(function (btn) {
        btn.addEventListener('click', function () { renderSession(btn.dataset.id); });
      });
      box.querySelectorAll('.arch-del-sm').forEach(function (btn) {
        var id = btn.dataset.sid;
        armDanger(btn, function () {
          return archPurge(id).then(function () {
            dropChipCache(id);
            window.openCompressArchive();
          });
        });
      });
    }).catch(function (err) { say('读取失败：' + (err && err.message ? err.message : err)); });
  };

  /* 会话头的小入口：批数 */
  window.compressArchiveChip = function (sidIn) {
    var sid = sidIn || (typeof currentSession !== 'undefined' ? currentSession : null);
    if (!sid) return Promise.resolve(0);
    return archList().then(function (out) {
      var rows = (out && out.sessions) || [];
      for (var i = 0; i < rows.length; i++) if (rows[i].id === sid) return rows[i].batches.length;
      return 0;
    }).catch(function () { return 0; });
  };
})();
