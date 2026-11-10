(function () {
  'use strict';
  function scheduleText(schedule) {
    if (typeof schedule === 'string') return schedule;
    if (!schedule) return '';
    if (schedule.kind === 'interval') return 'every ' + schedule.minutes + 'm';
    if (schedule.kind === 'cron') return schedule.expr || '';
    return schedule.run_at || schedule.at || '';
  }
  window.openCronEditor = function (job) {
    var creating = !job || !job.id;
    job = job || {schedule: 'every 1h', deliver: 'local'};
    var draftKey = 'hermes-cron-draft:' + (creating ? 'new' : job.id);
    var requestId = crypto.randomUUID();
    var baseRevision = job.panel_revision;
    var draft;
    try { draft = JSON.parse(localStorage.getItem(draftKey) || 'null'); } catch (_) {}
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'cronModalOverlay';
    overlay.innerHTML = '<form class="modal cron-native-editor" role="dialog" aria-modal="true" aria-labelledby="cronEditorTitle">' +
      '<div class="modal-head"><h3 id="cronEditorTitle">编辑定时任务</h3><button type="button" class="modal-close" aria-label="关闭">×</button></div>' +
      '<div class="modal-body"><p class="cron-editor-state"></p><div class="cron-editor-fields"></div>' +
      '<p class="cron-editor-feedback" role="status" aria-live="polite"></p></div>' +
      '<div class="modal-foot"><button type="button" class="action cron-editor-discard">丢弃草稿</button><button type="button" class="action cron-editor-cancel">关闭</button><button type="submit" class="action primary">保存修改</button></div></form>';
    var form = overlay.querySelector('form');
    var fields = overlay.querySelector('.cron-editor-fields');
    var feedback = overlay.querySelector('.cron-editor-feedback');
    overlay.querySelector('#cronEditorTitle').textContent = creating ? '创建定时任务' : '编辑定时任务';
    overlay.querySelector('button[type=submit]').textContent = creating ? '创建任务' : '保存修改';
    var inputs = {};
    var definitions = [
      ['name', '任务名称', 'text'], ['prompt', '任务指令', 'textarea'],
      ['schedule', '执行时间或频率', 'text'], ['deliver', '结果投递目标', 'text'],
      ['skills', '技能（每行一项）', 'textarea'], ['repeat', '总执行次数（留空为不限）', 'number'],
      ['script', '脚本路径', 'text'], ['no_agent', '仅执行脚本，不调用模型', 'checkbox'],
      ['workdir', '执行目录', 'text'], ['model', '指定模型（留空使用默认）', 'text'],
      ['provider', '指定服务商（留空使用默认）', 'text'], ['base_url', '指定 API 地址（留空使用默认）', 'text'],
      ['context_from', '引用任务结果（每行一个任务 ID）', 'textarea'],
      ['enabled_toolsets', '启用工具集（每行一项，留空使用默认）', 'textarea'],
      ['attach_to_session', '关联来源会话', 'checkbox'],
    ];
    var initial = {};
    definitions.forEach(function (definition) {
      var key = definition[0], kind = definition[2];
      var label = document.createElement('label');
      label.className = 'field';
      var title = document.createElement('span');
      title.textContent = definition[1];
      var input = document.createElement(kind === 'textarea' ? 'textarea' : 'input');
      if (kind !== 'textarea') input.type = kind;
      else input.rows = key === 'prompt' ? 5 : 2;
      input.name = key;
      var value = job[key];
      if (key === 'schedule') value = scheduleText(value);
      if (key === 'repeat') value = value && value.times;
      if (Array.isArray(value)) value = value.join('\n');
      if (kind === 'checkbox') input.checked = !!value;
      else input.value = value == null ? '' : String(value);
      if (kind === 'number') { input.min = '1'; input.step = '1'; }
      if (key === 'schedule') input.required = true;
      initial[key] = kind === 'checkbox' ? input.checked : input.value;
      inputs[key] = input;
      label.append(title, input);
      fields.append(label);
    });
    var help = document.createElement('p');
    help.className = 'pw-hint';
    help.textContent = '频率示例：every 30m（每 30 分钟）、0 9 * * *（每天 9 点）、2026-12-01T09:00:00+08:00（指定时间）。投递填 local 保存本地，或渠道:会话ID；多个目标用逗号分隔。';
    fields.insertBefore(help, inputs.schedule.parentNode);
    if (draft && draft.values) {
      requestId = draft.requestId || requestId;
      baseRevision = draft.revision;
      definitions.forEach(function (definition) {
        var key = definition[0], input = inputs[key];
        if (!Object.prototype.hasOwnProperty.call(draft.values, key)) return;
        if (input.type === 'checkbox') input.checked = !!draft.values[key];
        else input.value = draft.values[key];
        if (draft.initial && Object.prototype.hasOwnProperty.call(draft.initial, key)) initial[key] = draft.initial[key];
      });
      feedback.textContent = '已恢复未保存的草稿';
    }
    function saveDraft() {
      var values = {};
      definitions.forEach(function (definition) {
        var key = definition[0], input = inputs[key];
        values[key] = input.type === 'checkbox' ? input.checked : input.value;
      });
      try {
        localStorage.setItem(draftKey, JSON.stringify({values: values, initial: initial, revision: baseRevision, requestId: requestId}));
        return true;
      } catch (_) { feedback.textContent = '浏览器无法保存草稿，请保持页面打开'; return false; }
    }
    form.addEventListener('input', saveDraft);
    var state = job.state === 'paused' || job.enabled === false ? '已暂停' : '已启用';
    overlay.querySelector('.cron-editor-state').textContent = creating ? '任务由 Hermes 定时执行。关闭面板不影响已创建的任务。' : state + ' · 已执行 ' + Number(job.repeat && job.repeat.completed || 0) + ' 次。保存保留执行记录与已有投递设定。';
    var active = document.activeElement;
    var saving = false;
    function dirty() {
      return definitions.some(function (definition) {
        var input = inputs[definition[0]];
        return initial[definition[0]] !== (input.type === 'checkbox' ? input.checked : input.value);
      });
    }
    function close() {
      if (saving) return;
      if (dirty() && !saveDraft() && !window.confirm('草稿保存失败，仍要关闭？')) return;
      overlay.remove();
      if (active && active.isConnected) active.focus();
    }
    overlay.querySelector('.modal-close').onclick = close;
    overlay.querySelector('.cron-editor-cancel').onclick = close;
    overlay.querySelector('.cron-editor-discard').onclick = async function () {
      if (saving || !window.confirm('丢弃本地草稿并重新读取已保存设定？')) return;
      try { localStorage.removeItem(draftKey); } catch (_) { feedback.textContent = '无法清除本地草稿，请检查浏览器存储'; return; }
      if (creating) { overlay.remove(); window.openCronEditor(); return; }
      saving = true;
      try {
        var response = await fetch(apiUrl('/api/cron-jobs'), {headers: {'X-Monitor-Token': monitorToken || ''}});
        var result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.error || '读取任务失败');
        var fresh = result.jobs.find(function (item) { return item.id === job.id; });
        if (!fresh) throw new Error('任务已不存在');
        overlay.remove(); window.openCronEditor(fresh);
      } catch (error) { feedback.textContent = error.message; }
      finally { saving = false; }
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
    form.onsubmit = async function (event) {
      event.preventDefault();
      if (saving) return;
      var payload = creating ? {request_id: requestId} : {revision: baseRevision};
      definitions.forEach(function (definition) {
        var key = definition[0], input = inputs[key];
        var value = input.type === 'checkbox' ? input.checked : input.value;
        if (!creating && value === initial[key]) return;
        if (creating && (value === '' || value === false) && !['prompt', 'no_agent'].includes(key)) return;
        if (['skills', 'context_from', 'enabled_toolsets'].includes(key)) value = value.split('\n').map(function (line) { return line.trim(); }).filter(Boolean);
        if (key === 'repeat') value = value ? Number(value) : 0;
        payload[key] = value;
      });
      if (Object.keys(payload).length === 1) { feedback.textContent = '没有需要保存的修改'; return; }
      if (inputs.no_agent.checked && !inputs.script.value.trim()) { feedback.textContent = '仅执行脚本时必须填写脚本路径'; inputs.script.focus(); return; }
      if (!inputs.no_agent.checked && !inputs.prompt.value.trim() && !inputs.skills.value.trim()) { feedback.textContent = '请填写任务指令或至少一个技能'; inputs.prompt.focus(); return; }
      saveDraft();
      saving = true;
      Array.from(form.elements).forEach(function (input) { input.disabled = true; });
      feedback.textContent = '正在保存…';
      try {
        var response = await fetch(apiUrl('/api/cron-jobs' + (creating ? '' : '/' + encodeURIComponent(job.id))), {
          method: creating ? 'POST' : 'PATCH', headers: {'Content-Type': 'application/json', 'X-Monitor-Token': monitorToken || ''}, body: JSON.stringify(payload),
        });
        var result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.error || '保存失败');
        try { localStorage.removeItem(draftKey); } catch (_) {}
        overlay.remove();
        if (active && active.isConnected) active.focus();
        toast(creating ? '定时任务已创建' : '任务已保存，执行记录已保留');
        renderCronJobs();
      } catch (error) {
        feedback.textContent = error.message;
      } finally {
        saving = false;
        Array.from(form.elements).forEach(function (input) { input.disabled = false; });
      }
    };
    document.body.append(overlay);
    inputs.name.focus();
  };
}());
