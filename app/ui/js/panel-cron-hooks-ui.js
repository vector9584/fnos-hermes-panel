(function () {
  'use strict';
  window.openCronHooks = async function (id) {
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = '<form class="modal cron-native-editor" role="dialog" aria-modal="true" aria-label="Webhook 投递">' +
      '<div class="modal-head"><h3>Webhook 投递</h3><button type="button" class="modal-close" aria-label="关闭">×</button></div>' +
      '<div class="modal-body"><p>任务产生结果后投递到以下地址。消息模板中的 {output} 会替换成任务输出。</p>' +
      '<div class="cron-hooks-list"></div><button type="button" class="action cron-hook-add">添加投递目标</button>' +
      '<p role="status" class="cron-editor-feedback">正在读取…</p></div>' +
      '<div class="modal-foot"><button type="button" class="action cron-hooks-discard">丢弃草稿</button><button type="submit" class="action primary" disabled>保存投递配置</button></div></form>';
    document.body.append(overlay);
    var form = overlay.querySelector('form'), list = overlay.querySelector('.cron-hooks-list');
    var feedback = overlay.querySelector('[role=status]'), save = overlay.querySelector('[type=submit]');
    var add = overlay.querySelector('.cron-hook-add');
    var revision, rows = [], busy = false, loaded = false, changed = false;
    var previousFocus = document.activeElement;
    var draftKey = 'hermes-cron-hooks-draft:' + id;
    function persist() {
      changed = true;
      try { localStorage.setItem(draftKey, JSON.stringify({revision: revision, rows: rows})); }
      catch (_) { feedback.textContent = '无法保存本地草稿，请保持页面打开'; }
    }
    function close() {
      if (busy) return;
      if (changed) persist();
      overlay.remove();
      if (previousFocus && previousFocus.isConnected) previousFocus.focus();
    }
    overlay.querySelector('.modal-close').onclick = close;
    overlay.querySelector('.cron-hooks-discard').onclick = function () {
      if (busy || !window.confirm('丢弃本地草稿并重新读取投递配置？')) return;
      try { localStorage.removeItem(draftKey); } catch (_) { feedback.textContent = '无法清除本地草稿，请检查浏览器存储'; return; }
      overlay.remove(); window.openCronHooks(id);
    };
    overlay.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key === 'Tab') {
        var focusable = Array.from(form.querySelectorAll('button,input,textarea')).filter(function (node) { return !node.disabled; });
        var first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    });
    function render() {
      list.replaceChildren();
      rows.forEach(function (row, index) {
        var section = document.createElement('fieldset');
        section.className = 'cron-hook-card';
        var legend = document.createElement('legend'); legend.textContent = '投递目标 ' + (index + 1); section.append(legend);
        [['label', '名称'], ['url', 'Webhook 地址'], ['message', '消息模板']].forEach(function (field) {
          var label = document.createElement('label'); label.className = 'field';
          var span = document.createElement('span'); span.textContent = field[1];
          var input = document.createElement(field[0] === 'message' ? 'textarea' : 'input');
          if (field[0] === 'url') { input.type = 'url'; input.required = true; }
          input.value = row[field[0]] || '';
          input.name = field[0];
          input.oninput = function () { row[field[0]] = input.value; persist(); };
          label.append(span, input); section.append(label);
        });
        var status = document.createElement('p');
        status.textContent = row.last_status === 'ok' ? '上次投递成功' : row.last_status === 'error' ? '上次投递失败：' + row.last_error : '等待任务产生新结果';
        section.append(status);
        var remove = document.createElement('button'); remove.type = 'button'; remove.className = 'action'; remove.textContent = '移除此目标';
        remove.onclick = function () {
          rows.splice(index, 1); persist(); render();
          feedback.replaceChildren(document.createTextNode('已移出表单，保存后生效。'));
          var undo = document.createElement('button'); undo.type = 'button'; undo.className = 'action'; undo.textContent = '撤销';
          undo.onclick = function () { rows.splice(index, 0, row); persist(); render(); feedback.textContent = '已恢复投递目标'; };
          feedback.append(undo);
        };
        section.append(remove); list.append(section);
      });
      add.disabled = !loaded || rows.length >= 12;
    }
    add.disabled = true;
    add.onclick = function () { rows.push({id: crypto.randomUUID(), url: '', label: '', message: '{output}'}); persist(); render(); list.lastElementChild.querySelector('input').focus(); };
    var headers = {'Content-Type': 'application/json', 'X-Monitor-Token': monitorToken || ''};
    try {
      var response = await fetch(apiUrl('/api/cron-jobs/' + encodeURIComponent(id) + '/webhooks'), {headers: headers});
      var result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || '读取投递配置失败');
      rows = result.hooks; revision = result.revision; loaded = true;
      var draft;
      try { draft = JSON.parse(localStorage.getItem(draftKey) || 'null'); } catch (_) {}
      if (draft && Array.isArray(draft.rows)) { rows = draft.rows; revision = draft.revision; changed = true; }
      feedback.textContent = draft ? '已恢复未保存的投递草稿' : rows.length ? '修改后保存生效' : '尚未添加 Webhook 投递目标';
      save.disabled = false; render();
      overlay.querySelector('.modal-close').focus();
    } catch (error) { feedback.textContent = error.message; }
    form.onsubmit = async function (event) {
      event.preventDefault(); if (busy || !loaded) return;
      busy = true; persist(); save.disabled = true; feedback.textContent = '正在保存…';
      Array.from(form.elements).forEach(function (input) { input.disabled = true; });
      try {
        var response = await fetch(apiUrl('/api/cron-jobs/' + encodeURIComponent(id) + '/webhooks'), {
          method: 'PUT', headers: headers, body: JSON.stringify({revision: revision, hooks: rows}),
        });
        var result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.error || '保存失败');
        try { localStorage.removeItem(draftKey); } catch (_) {}
        changed = false; overlay.remove(); renderCronJobs(); toast('投递配置已保存');
        if (previousFocus && previousFocus.isConnected) previousFocus.focus();
      } catch (error) { feedback.textContent = error.message; }
      finally { busy = false; Array.from(form.elements).forEach(function (input) { input.disabled = false; }); add.disabled = rows.length >= 12; }
    };
  };
}());
