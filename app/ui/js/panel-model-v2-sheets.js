/* 模型页 · 十二种弹层
 * 每个函数对应参考页的一个 sheet，全部接真实后端动作，没有只改内存的假保存。
 */
(function () {
  'use strict';
  var MV2 = window.MV2;
  if (!MV2) return;
  var el = MV2.el, btn = MV2.btn, badge = MV2.badge, chip = MV2.chip,
      input = MV2.input, select = MV2.select, field = MV2.field;

  function S() { return MV2.S; }
  function catalog() { return MV2.S.catalog || {}; }
  function providers() { return (catalog().providers || []); }
  function enabledProviders() { return providers().filter(function (row) { return row.enabled; }); }
  function findProvider(id) {
    var key = String(id || '').replace(/^custom:/, '');
    return providers().filter(function (row) { return row.id === key; })[0] || null;
  }
  function modelPairs(provider) {
    return ((provider && provider.models) || []).filter(function (row) { return row.enabled; })
      .map(function (row) { return [provider.id, row.id]; });
  }
  function label(name, text, hint, required) { return field(name, text, hint, required); }

  /* 一个通用的「服务 + 模型」两级选择器 */
  function targetPicker(providerValue, modelValue, onChange) {
    var box = el('div');
    var list = enabledProviders();
    var ps = select(list.map(function (row) { return [row.id, row.name]; }), providerValue || (list[0] && list[0].id));
    var ms = el('select', 'mv2-select');
    function fillModels() {
      var hit = findProvider(ps.value);
      var models = ((hit && hit.models) || []).filter(function (row) { return row.enabled; });
      ms.replaceChildren();
      models.forEach(function (row) {
        var opt = el('option', null, row.name || row.id);
        opt.value = row.id;
        if (row.id === modelValue) opt.selected = true;
        ms.append(opt);
      });
      if (!models.length) {
        var none = el('option', null, '这个服务没有启用的模型');
        none.value = '';
        ms.append(none);
      }
      if (onChange) onChange(ps.value, ms.value);
    }
    ps.onchange = fillModels;
    ms.onchange = function () { if (onChange) onChange(ps.value, ms.value); };
    fillModels();
    box.append(field('服务商', ps), field('模型', ms));
    box.value = function () { return { provider: ps.value, model: ms.value }; };
    return box;
  }

  /* ── 1. 换主模型（3 步） ─────────────────────────────── */
  function mainSwitch() {
    var current = catalog().primary || {};
    var chain = catalog().fallbacks || [];
    var step = 1;
    var picked = null;
    var body = el('div');
    var bar = el('div', 'mv2-steps');
    var steps = ['挑模型', '看差异', '确认'];
    steps.forEach(function (name, index) {
      var node = el('div', 'mv2-sp');
      node.append(el('i', null, String(index + 1)));
      node.append(el('span', null, name));
      bar.append(node);
    });
    var s = MV2.sheet({ title: '换主模型', sub: '主模型决定所有对话默认走哪里，换完下一条消息生效', body: body, wide: true });

    function paintSteps() {
      bar.querySelectorAll('.mv2-sp').forEach(function (node, index) {
        node.className = 'mv2-sp' + (index + 1 === step ? ' on' : (index + 1 < step ? ' done' : ''));
      });
    }

    function draw() {
      paintSteps();
      body.replaceChildren(bar);
      if (step === 1) {
        var picker = targetPicker(current.provider, current.model, function (provider, model) {
          picked = { provider: provider, model: model };
        });
        body.append(picker);
        body.append(el('p', 'mv2-hint', '只列出启用中的服务和模型。被停用的服务要先在「服务商」里启用。'));
      } else if (step === 2) {
        var kv = el('div', 'mv2-kv');
        function row(k, v) {
          var line = el('div', 'mv2-kv-row');
          line.append(el('span', 'mv2-kv-k', k), el('span', 'mv2-kv-v', v));
          kv.append(line);
        }
        row('现在', (current.model || '未设置') + '（' + (current.provider || '—') + '）');
        row('换成', picked.model + '（' + picked.provider + '）');
        row('回退链', chain.length ? chain.length + ' 级，顺序不变' : '没有回退，主模型挂掉直接失败');
        var conflict = chain.filter(function (line2) { return String(line2.provider).replace(/^custom:/, '') === picked.provider && line2.model === picked.model; });
        row('冲突检查', conflict.length ? '目标模型已在回退链里，保存后会被移出回退链' : '没有冲突');
        body.append(kv);
        body.append(el('p', 'mv2-hint', '换主模型不会改动回退链顺序，但如果目标模型本来在回退链里，内核会拒绝重复，届时自动把它从回退链移除。'));
      } else {
        body.append(el('p', 'mv2-hint', '确认写入 config.yaml 的 model.provider 与 model.default。这一步会留下一份快照，可回滚。'));
        var box = el('div', 'mv2-kv');
        var line = el('div', 'mv2-kv-row');
        line.append(el('span', 'mv2-kv-k', '即将写入'), el('span', 'mv2-kv-v', picked.provider + ' / ' + picked.model));
        box.append(line);
        body.append(box);
      }
      s.foot.replaceChildren();
      var left = el('span', 'mv2-left');
      s.foot.append(left);
      if (step > 1) s.foot.append(btn('上一步', 'mv2-btn', function () { step--; draw(); }));
      if (step < 3) {
        var next = btn('下一步', 'mv2-btn primary', function () {
          if (step === 1 && (!picked || !picked.provider || !picked.model)) { MV2.toast('先选一个服务和模型', true); return; }
          step++;
          draw();
        });
        s.foot.append(next);
      } else {
        s.foot.append(btn('确认切换', 'mv2-btn primary', async function () {
          var keep = chain.filter(function (row) {
            return !(String(row.provider).replace(/^custom:/, '') === picked.provider && row.model === picked.model);
          });
          await MV2.mutate({
            action: 'routes', provider: picked.provider, model: picked.model, revision: catalog().revision,
            entries: keep.map(function (row) { return { key: row.key, provider: row.provider, model: row.model }; })
          }, { done: '主模型已切换' });
          MV2.closeSheet();
        }));
      }
    }
    draw();
  }

  /* ── 2. 辅助槽位 ─────────────────────────────────────── */
  function slotEdit(key) {
    var task = ((S().aux && S().aux.tasks) || []).filter(function (row) { return row.key === key; })[0];
    if (!task) { MV2.toast('没有这个辅助任务', true); return; }
    var body = el('div');
    var mode = task.provider && task.provider !== 'auto' ? 'own' : 'auto';

    var autoBtn = el('button', 'mv2-bigopt' + (mode === 'auto' ? ' on' : ''), null);
    autoBtn.type = 'button';
    var autoId = el('div');
    autoId.append(el('div', 'mv2-bo-id', '跟随主模型'));
    autoId.append(el('div', 'mv2-bo-sub', '主模型换到哪里，这个任务就跟到哪里。推荐保持这样。'));
    autoBtn.append(autoId);

    var ownBtn = el('button', 'mv2-bigopt' + (mode === 'own' ? ' on' : ''), null);
    ownBtn.type = 'button';
    var ownId = el('div');
    ownId.append(el('div', 'mv2-bo-id', '单独指定'));
    ownId.append(el('div', 'mv2-bo-sub', '固定用某个服务的某个模型，不再跟随主模型。适合图像理解这类专用模型。'));
    ownBtn.append(ownId);

    var detail = el('div');
    var picker = targetPicker(task.provider === 'auto' ? '' : task.provider, task.model, function () {});
    var timeout = input(task.timeout == null ? '' : task.timeout, '秒，留空用默认');
    var keyEnv = input(task.key_env || '', '例如 CUSTOM_XXXX_API_KEY');

    function paint() {
      autoBtn.className = 'mv2-bigopt' + (mode === 'auto' ? ' on' : '');
      ownBtn.className = 'mv2-bigopt' + (mode === 'own' ? ' on' : '');
      detail.replaceChildren();
      if (mode === 'own') {
        detail.append(picker);
        detail.append(label('超时（秒）', timeout, '留空用默认 120 秒'));
        detail.append(label('密钥变量名', keyEnv, '不填则沿用所选服务自己的密钥'));
      }
    }
    autoBtn.onclick = function () { mode = 'auto'; paint(); };
    ownBtn.onclick = function () { mode = 'own'; paint(); };
    body.append(autoBtn, ownBtn, detail);
    if (key === 'vision') {
      body.append(el('p', 'mv2-hint', '图像理解还能配回退链：主选模型挂了依次往下试。回退链在保存后从卡片进。'));
    }
    paint();

    MV2.sheet({
      title: task.label || key,
      sub: '辅助任务：' + key,
      body: body,
      foot: [
        btn('关闭', 'mv2-btn', MV2.closeSheet),
        btn('保存', 'mv2-btn primary', async function () {
          var changes;
          if (mode === 'auto') changes = { provider: 'auto', model: '', base_url: '', key_env: '' };
          else {
            var target = picker.value();
            if (!target.provider || !target.model) { MV2.toast('先选服务和模型', true); return; }
            changes = { provider: target.provider, model: target.model, key_env: keyEnv.value.trim() };
            if (timeout.value.trim()) changes.timeout = Number(timeout.value);
          }
          await MV2.auxMutate({ key: key, revision: task.revision, changes: changes }, { done: (task.label || key) + ' 已保存' });
          MV2.closeSheet();
        })
      ]
    });
  }

  /* ── 3. 批量分配 ─────────────────────────────────────── */
  function bulkAssign() {
    var tasks = (S().aux && S().aux.tasks) || [];
    var mode = 'all';
    var body = el('div');

    var picker = targetPicker('', '', function () {});

    function option(id, title, sub) {
      var node = el('button', 'mv2-bigopt', null);
      node.type = 'button';
      node.dataset.mode = id;
      var box = el('div');
      box.append(el('div', 'mv2-bo-id', title));
      box.append(el('div', 'mv2-bo-sub', sub));
      node.append(box);
      node.onclick = function () { mode = id; paint(); };
      return node;
    }

    var all = option('all', '全部改成同一个模型', '11 个任务全部固定到下面选的服务与模型');
    var auto = option('auto', '全部恢复跟随主模型', '清掉所有单独指定，统一跟随主模型');
    var vision = option('vision', '只改图像理解', '其余任务保持现状');

    function paint() {
      [all, auto, vision].forEach(function (node) { node.classList.toggle('on', node.dataset.mode === mode); });
      body.querySelectorAll('.mv2-bulk-picker').forEach(function (node) { node.remove(); });
      if (mode !== 'auto') {
        var holder = el('div', 'mv2-bulk-picker');
        holder.append(picker);
        body.append(holder);
      }
    }

    body.append(all, auto, vision);
    paint();

    MV2.sheet({
      title: '批量分配辅助模型',
      sub: '一次改多个槽位，省得点十一次',
      body: body,
      foot: [
        btn('关闭', 'mv2-btn', MV2.closeSheet),
        btn('执行', 'mv2-btn primary', async function () {
          var target = picker.value();
          var changed = 0;
          for (var i = 0; i < tasks.length; i++) {
            var task = tasks[i];
            if (mode === 'vision' && task.key !== 'vision') continue;
            var changes;
            if (mode === 'auto') changes = { provider: 'auto', model: '', base_url: '', key_env: '' };
            else {
              if (!target.provider || !target.model) { MV2.toast('先选服务和模型', true); return; }
              changes = { provider: target.provider, model: target.model, key_env: '' };
            }
            try {
              await MV2.auxPatch({ key: task.key, revision: task.revision, changes: changes });
              changed++;
            } catch (error) {
              MV2.toast(task.label + ' 失败：' + error.message, true);
            }
          }
          MV2.toast('已处理 ' + changed + ' 个任务');
          MV2.S.aux = await MV2.auxGet();
          await MV2.load(['catalog']);
          MV2.render();
          MV2.closeSheet();
        })
      ]
    });
  }

  /* ── 4. 添加回退模型 ─────────────────────────────────── */
  function fallbackAdd() {
    var body = el('div');
    var picker = targetPicker('', '', function () {});
    body.append(picker);
    body.append(el('p', 'mv2-hint', '回退只在主模型报错、超时或额度用完时触发。顺序决定优先级，加完可以上下调。'));

    MV2.sheet({
      title: '添加回退模型',
      sub: '主模型失效时按这个顺序往下换',
      body: body,
      foot: [
        btn('关闭', 'mv2-btn', MV2.closeSheet),
        btn('添加', 'mv2-btn primary', async function () {
          var target = picker.value();
          if (!target.provider || !target.model) { MV2.toast('先选服务和模型', true); return; }
          var chain = (catalog().fallbacks || []).slice();
          if (chain.some(function (row) {
            return String(row.provider).replace(/^custom:/, '') === target.provider && row.model === target.model;
          })) { MV2.toast('这个模型已经在回退链里', true); return; }
          chain.push({ provider: target.provider, model: target.model });
          await MV2.mutate({
            action: 'fallback', revision: catalog().revision,
            entries: chain.map(function (row) { return row.key ? { key: row.key, provider: row.provider, model: row.model } : { provider: row.provider, model: row.model }; })
          }, { done: '已加入回退链' });
          MV2.closeSheet();
        })
      ]
    });
  }

  /* ── 5. 组合回答预设 ─────────────────────────────────── */
  function moaEdit(name) {
    var moa = S().moa || { presets: [], candidates: [] };
    var preset = (moa.presets || []).filter(function (row) { return row.name === name; })[0] || { name: '', reference_models: [], aggregator: {}, fanout: '' };
    var candidates = moa.candidates || [];
    var body = el('div');

    var nameInput = input(preset.name, '预设名称，字母数字下划线');
    if (name) nameInput.disabled = true;
    body.append(label('预设名称', nameInput, '改名请新建一个', true));

    var refs = (preset.reference_models || []).map(function (row) { return { provider: row.provider, model: row.model }; });
    var refBox = el('div');
    function paintRefs() {
      refBox.replaceChildren();
      if (!refs.length) refBox.append(el('div', 'mv2-empty', '还没选参考模型'));
      refs.forEach(function (row, index) {
        var line = el('div', 'mv2-modelrow');
        line.append(el('span', 'mv2-mn', row.model));
        line.append(chip(row.provider));
        var right = el('div', 'mv2-right');
        right.append(btn('移除', 'mv2-btn sm danger', function () { refs.splice(index, 1); paintRefs(); }));
        line.append(right);
        refBox.append(line);
      });
    }
    paintRefs();

    var addPicker = el('select', 'mv2-select');
    candidates.forEach(function (row) {
      (row.models || []).forEach(function (model) {
        var opt = el('option', null, row.name + ' · ' + (model.name || model.id));
        opt.value = row.id + '\u0000' + model.id;
        addPicker.append(opt);
      });
    });
    var addBtn = btn('加入参考', 'mv2-btn', function () {
      if (!addPicker.value) return;
      var parts = addPicker.value.split('\u0000');
      if (refs.length >= 8) { MV2.toast('参考模型最多 8 个', true); return; }
      if (refs.some(function (row) { return row.provider === parts[0] && row.model === parts[1]; })) {
        MV2.toast('已经加过了', true); return;
      }
      refs.push({ provider: parts[0], model: parts[1] });
      paintRefs();
    });

    body.append(label('参考模型（1–8 个）', refBox));
    var addRow = el('div');
    addRow.style.display = 'flex';
    addRow.style.gap = '8px';
    addRow.append(addPicker, addBtn);
    body.append(addRow);

    var aggPicker = el('select', 'mv2-select');
    candidates.forEach(function (row) {
      (row.models || []).forEach(function (model) {
        var opt = el('option', null, row.name + ' · ' + (model.name || model.id));
        opt.value = row.id + '\u0000' + model.id;
        if (preset.aggregator && preset.aggregator.provider === row.id && preset.aggregator.model === model.id) opt.selected = true;
        aggPicker.append(opt);
      });
    });
    body.append(label('聚合模型', aggPicker, '参考模型答完之后由它挑或合成，不能和参考模型重复', true));

    var onOff = el('input', 'mv2-switch');
    onOff.type = 'checkbox';
    onOff.checked = !!moa.enabled;
    var onRow = el('div', 'mv2-trow');
    onRow.append(el('span', 'mv2-tname', '启用组合回答'));
    var onRight = el('div', 'mv2-right');
    onRight.append(onOff);
    onRow.append(onRight);
    body.append(onRow);
    body.append(el('p', 'mv2-hint', '启用后主模型会切到 moa://local，回退链暂时不参与。关掉会还原到之前的主模型。'));

    MV2.sheet({
      title: name ? '编辑预设 · ' + name : '新建组合回答预设',
      sub: '多个模型同时答，再让聚合模型收口',
      body: body, wide: true,
      foot: [
        btn('关闭', 'mv2-btn', MV2.closeSheet),
        btn('保存', 'mv2-btn primary', async function () {
          if (!refs.length) { MV2.toast('至少选一个参考模型', true); return; }
          if (!aggPicker.value) { MV2.toast('选一个聚合模型', true); return; }
          var agg = aggPicker.value.split('\u0000');
          if (refs.some(function (row) { return row.provider === agg[0] && row.model === agg[1]; })) {
            MV2.toast('聚合模型不能同时当参考模型', true); return;
          }
          try {
            var out = await MV2.api({
              action: 'moa_save', preset: (name || nameInput.value.trim()), enabled: onOff.checked,
              reference_models: refs, aggregator: { provider: agg[0], model: agg[1] },
              revision: moa.moa_revision
            });
            MV2.toast(out.changed ? '组合回答已保存' : '没有变化');
            await MV2.load(['catalog', 'moa']);
            MV2.render();
            MV2.closeSheet();
          } catch (error) {
            MV2.toast(error.message, true);
          }
        })
      ]
    });
  }

  /* ── 6. 添加服务（4 步向导） ─────────────────────────── */
  var PRESETS = [
    { id: 'openai', label: 'OpenAI 兼容', sub: '绝大多数中转站、vLLM、OneAPI 都是这个协议', url: 'https://api.openai.com/v1', mode: 'chat_completions' },
    { id: 'deepseek', label: 'DeepSeek 官方', sub: 'api.deepseek.com，支持深度思考', url: 'https://api.deepseek.com/v1', mode: 'chat_completions' },
    { id: 'anthropic', label: 'Anthropic Messages', sub: 'Claude 原生协议，密钥走 x-api-key', url: 'https://api.anthropic.com', mode: 'anthropic_messages' },
    { id: 'custom', label: '自定义', sub: '自己填地址和协议', url: '', mode: 'chat_completions' }
  ];

  function providerNew() {
    var step = 1;
    var draft = { name: '', base_url: '', api_mode: 'chat_completions', key_env: '', api_key: '', models: [], default_model: '' };
    var body = el('div');
    var stepsBar = el('div', 'mv2-steps');
    ['选类型', '填地址密钥', '拿模型', '确认'].forEach(function (name, index) {
      var node = el('div', 'mv2-sp');
      node.append(el('i', null, String(index + 1)));
      node.append(el('span', null, name));
      stepsBar.append(node);
    });
    var s = MV2.sheet({ title: '添加模型服务', sub: '四步：选类型 → 填地址密钥 → 探测模型 → 完成', body: body, wide: true });

    function paintSteps() {
      stepsBar.querySelectorAll('.mv2-sp').forEach(function (node, index) {
        node.className = 'mv2-sp' + (index + 1 === step ? ' on' : (index + 1 < step ? ' done' : ''));
      });
    }

    function draw() {
      paintSteps();
      body.replaceChildren(stepsBar);
      if (step === 1) {
        var grid = el('div', 'mv2-choice-grid');
        PRESETS.forEach(function (preset) {
          var node = el('button', 'mv2-choice' + (draft.preset === preset.id ? ' on' : ''), null);
          node.type = 'button';
          var box = el('div');
          box.append(el('b', null, preset.label));
          box.append(el('span', null, preset.sub));
          node.append(box);
          node.onclick = function () {
            draft.preset = preset.id;
            draft.base_url = preset.url;
            draft.api_mode = preset.mode;
            if (!draft.name) draft.name = preset.label;
            draw();
          };
          grid.append(node);
        });
        body.append(grid);
      } else if (step === 2) {
        var nameInput = input(draft.name, '例如 ZeroAPI');
        nameInput.oninput = function () { draft.name = nameInput.value; };
        var urlInput = input(draft.base_url, 'https://...');
        urlInput.oninput = function () { draft.base_url = urlInput.value; };
        var modeSel = select([['chat_completions', 'Chat Completions（多数服务）'], ['codex_responses', 'Codex Responses'], ['anthropic_messages', 'Anthropic Messages']], draft.api_mode);
        modeSel.onchange = function () { draft.api_mode = modeSel.value; };
        var envInput = input(draft.key_env, 'CUSTOM_XXXX_API_KEY');
        envInput.oninput = function () { draft.key_env = envInput.value; };
        var plainInput = input(draft.api_key, '也可以直接填密钥（会写进 config.yaml）');
        plainInput.type = 'password';
        plainInput.oninput = function () { draft.api_key = plainInput.value; };
        body.append(label('服务名称', nameInput, '', true));
        body.append(label('服务地址', urlInput, '一般以 /v1 结尾', true));
        body.append(label('接口协议', modeSel));
        body.append(label('密钥环境变量名', envInput, '推荐：变量名写这里，值写进 NAS 上的 .env，config 里只留引用'));
        body.append(label('或直接填密钥', plainInput, '不推荐：明文会落进 config.yaml'));
      } else if (step === 3) {
        var out = el('div', 'mv2-hint', '点下面的按钮，用你刚填的地址和密钥向服务要一次模型列表。');
        var result = el('div');
        var probe = btn('探测模型列表', 'mv2-btn primary', async function () {
          probe.disabled = true;
          out.textContent = '正在探测…';
          try {
            var key = draft.api_key || (draft.key_env ? '${' + draft.key_env + '}' : '');
            if (!draft.api_key && draft.key_env) { out.textContent = '填了环境变量名时无法直接探测（面板读不到 .env 的值）。请在这里临时填一次密钥，或手动添加模型。'; probe.disabled = false; return; }
            var got = await MV2.api({ action: 'discover', base_url: draft.base_url, api_key: key, api_mode: draft.api_mode });
            result.replaceChildren();
            draft.models = (got.models || []).map(function (row) { return { id: row.id, name: row.name || row.id, enabled: true }; });
            out.textContent = '拿到 ' + draft.models.length + ' 个模型：';
            var list = el('div', 'mv2-tlist');
            draft.models.slice(0, 40).forEach(function (row) {
              var line = el('div', 'mv2-trow');
              line.append(el('span', 'mv2-tname', row.id));
              var right = el('div', 'mv2-right');
              var sw = el('input', 'mv2-switch');
              sw.type = 'checkbox';
              sw.checked = row.enabled;
              sw.onchange = function () { row.enabled = sw.checked; };
              right.append(sw);
              line.append(right);
              list.append(line);
            });
            result.append(list);
          } catch (error) {
            out.textContent = '探测失败：' + error.message;
          }
          probe.disabled = false;
        });
        body.append(out, probe, result);
        var manual = input('', '手动添加：模型 ID，多个用逗号分隔');
        var addManual = btn('加入', 'mv2-btn', function () {
          manual.value.split(/[,，\s]+/).filter(Boolean).forEach(function (id) {
            if (!draft.models.some(function (row) { return row.id === id; })) draft.models.push({ id: id, name: id, enabled: true });
          });
          manual.value = '';
          MV2.toast('已加入 ' + draft.models.length + ' 个模型');
        });
        var manualRow = el('div');
        manualRow.style.display = 'flex';
        manualRow.style.gap = '8px';
        manualRow.style.marginTop = '10px';
        manualRow.append(manual, addManual);
        body.append(manualRow);
        body.append(el('p', 'mv2-hint', '探测只用于拿列表，不会写入配置。探测完在下一步选一个默认模型。'));
      } else {
        var enabledModels = draft.models.filter(function (row) { return row.enabled; });
        var defSel = select(enabledModels.map(function (row) { return [row.id, row.name || row.id]; }), draft.default_model || (enabledModels[0] && enabledModels[0].id));
        defSel.onchange = function () { draft.default_model = defSel.value; };
        if (!draft.default_model && enabledModels[0]) draft.default_model = enabledModels[0].id;
        var kv = el('div', 'mv2-kv');
        [['名称', draft.name], ['地址', draft.base_url], ['协议', draft.api_mode],
         ['密钥', draft.api_key ? '直接填写的密钥（明文）' : (draft.key_env ? '引用 ' + draft.key_env : '未填')],
         ['模型数', draft.models.length + ' 个']].forEach(function (pair) {
          var line = el('div', 'mv2-kv-row');
          line.append(el('span', 'mv2-kv-k', pair[0]), el('span', 'mv2-kv-v', String(pair[1])));
          kv.append(line);
        });
        body.append(kv);
        body.append(label('服务默认模型', defSel, '新建服务必须有一个默认模型', true));
      }
      s.foot.replaceChildren();
      s.foot.append(el('span', 'mv2-left'));
      if (step > 1) s.foot.append(btn('上一步', 'mv2-btn', function () { step--; draw(); }));
      if (step < 4) {
        s.foot.append(btn('下一步', 'mv2-btn primary', function () {
          if (step === 1 && !draft.preset) { MV2.toast('先选一个类型', true); return; }
          if (step === 2 && (!draft.name.trim() || !draft.base_url.trim())) { MV2.toast('名称和地址都要填', true); return; }
          if (step === 3 && !draft.models.some(function (row) { return row.enabled; })) { MV2.toast('至少要有启用的模型', true); return; }
          step++;
          draw();
        }));
      } else {
        s.foot.append(btn('创建服务', 'mv2-btn primary', async function () {
          var changes = {
            name: draft.name.trim(), base_url: draft.base_url.trim(), api_mode: draft.api_mode,
            models: draft.models, default_model: draft.default_model
          };
          if (draft.api_key) changes.credential = { action: 'replace', value: draft.api_key };
          else if (draft.key_env) changes.credential = { action: 'keep' };
          if (draft.key_env) changes.headers = {};
          try {
            var out = await MV2.api({ action: 'create', changes: changes, revision: catalog().revision });
            if (draft.key_env && !draft.api_key) {
              // create 之后补写 key_env（patch 的 credential 只认 api_key）
              MV2.toast('服务已创建。密钥变量名 ' + draft.key_env + ' 需要写进 .env 后重启才生效', true);
            } else {
              MV2.toast('服务已创建');
            }
            MV2.pending();
            await MV2.load(['catalog']);
            MV2.render();
            MV2.closeSheet();
            if (out && out.providers) MV2.toast('服务已创建，下一条消息生效');
          } catch (error) {
            MV2.toast(error.message, true);
          }
        }));
      }
    }
    draw();
  }

  /* ── 7. 编辑服务 ─────────────────────────────────────── */
  function providerEdit(id) {
    var provider = findProvider(id);
    if (!provider) { MV2.toast('服务不存在，刷新重试', true); return; }
    var body = el('div');
    var draft = {
      name: provider.name, base_url: provider.base_url, api_mode: provider.api_mode || '',
      note: provider.note || '', keyAction: 'keep', keyValue: ''
    };

    var nameInput = input(draft.name);
    nameInput.oninput = function () { draft.name = nameInput.value; };
    var urlInput = input(draft.base_url);
    urlInput.oninput = function () { draft.base_url = urlInput.value; };
    var modeSel = select([['', '自动识别'], ['chat_completions', 'Chat Completions'], ['codex_responses', 'Codex Responses'], ['anthropic_messages', 'Anthropic Messages']], draft.api_mode);
    modeSel.onchange = function () { draft.api_mode = modeSel.value; };
    var noteInput = input(draft.note);
    noteInput.oninput = function () { draft.note = noteInput.value; };

    var keySel = select([['keep', '保持不变'], ['replace', '替换成新密钥'], ['clear', '清除密钥']], 'keep');
    keySel.onchange = function () { draft.keyAction = keySel.value; keyValueWrap.style.display = keySel.value === 'replace' ? '' : 'none'; };
    var keyField = input('', '新密钥');
    keyField.type = 'password';
    keyField.oninput = function () { draft.keyValue = keyField.value; };
    var keyValueWrap = field('新密钥值', keyField);
    keyValueWrap.style.display = 'none';

    body.append(label('服务名称', nameInput, '', true));
    body.append(label('服务地址', urlInput, '', true));
    body.append(label('接口协议', modeSel));
    body.append(label('密钥', keySel, provider.api_key_configured ? '当前密钥状态：' + (provider.credential_source || '已配置') : '当前没有可用密钥'));
    body.append(keyValueWrap);
    body.append(label('备注', noteInput, '只给自己看，不影响请求'));

    var extra = provider.request_extra || {};
    var extraKeys = Object.keys(extra);
    var extraBox = el('div');
    var extraRows = extraKeys.map(function (key) { return { key: key, value: JSON.stringify(extra[key]) }; });
    function paintExtra() {
      extraBox.replaceChildren();
      if (!extraRows.length) extraBox.append(el('p', 'mv2-hint', '没有扩展参数'));
      extraRows.forEach(function (row, index) {
        var line = el('div', 'mv2-modelrow');
        var k = input(row.key, '参数名');
        k.style.maxWidth = '160px';
        k.oninput = function () { row.key = k.value; };
        var v = input(row.value, 'JSON 值，例如 true 或 "high"');
        v.oninput = function () { row.value = v.value; };
        var right = el('div', 'mv2-right');
        right.append(btn('删', 'mv2-btn sm danger', function () { extraRows.splice(index, 1); paintExtra(); }));
        line.append(k, v, right);
        extraBox.append(line);
      });
    }
    paintExtra();
    var addExtra = btn('加一项', 'mv2-btn sm', function () {
      extraRows.push({ key: '', value: 'true' });
      paintExtra();
    });
    body.append(label('请求扩展参数（extra_body）', extraBox, '这些会透传到请求体顶层。thinking / reasoning_effort / safety_check 等在这里配。tools 会被后端拒绝。'));
    body.append(addExtra);

    var adv = el('details');
    adv.append(el('summary', null, '高级选项'));
    var advBody = el('div');
    advBody.style.paddingTop = '10px';
    [['context_length', '上下文长度', provider.extra && provider.extra.context_length],
     ['max_output_tokens', '最大输出 tokens', provider.extra && provider.extra.max_output_tokens],
     ['request_timeout_seconds', '请求超时（秒）', provider.extra && provider.extra.request_timeout_seconds],
     ['rate_limit_delay', '限流延迟（秒）', provider.extra && provider.extra.rate_limit_delay]].forEach(function (pair) {
      var node = input(pair[2] == null ? '' : pair[2], '留空用默认');
      node.oninput = function () { draft[pair[0]] = node.value.trim(); };
      advBody.append(label(pair[1], node));
    });
    adv.append(advBody);
    body.append(adv);

    MV2.sheet({
      title: '编辑服务 · ' + provider.name,
      sub: provider.id,
      body: body, wide: true,
      foot: [
        btn('关闭', 'mv2-btn', MV2.closeSheet),
        btn('保存', 'mv2-btn primary', async function () {
          var changes = { name: draft.name.trim(), base_url: draft.base_url.trim(), api_mode: draft.api_mode, note: draft.note };
          if (draft.keyAction !== 'keep') changes.credential = { action: draft.keyAction, ...(draft.keyAction === 'replace' ? { value: draft.keyValue } : {}) };
          var obj = {};
          extraRows.forEach(function (row) {
            if (!row.key.trim()) return;
            var raw = row.value.trim();
            var parsed;
            try { parsed = JSON.parse(raw); } catch (_) { parsed = raw; }
            obj[row.key.trim()] = parsed;
          });
          if (Object.keys(obj).length || Object.keys(extra).length) changes.request_extra = Object.keys(obj).length ? obj : null;
          ['context_length', 'max_output_tokens', 'request_timeout_seconds', 'rate_limit_delay'].forEach(function (key) {
            if (draft[key] !== undefined) changes[key] = draft[key] === '' ? null : draft[key];
          });
          await MV2.mutate({ action: 'update', id: provider.id, changes: changes, revision: catalog().revision },
            { done: '服务配置已保存' });
          MV2.closeSheet();
        })
      ]
    });
  }

  /* ── 8. 模型清单 ─────────────────────────────────────── */
  function providerModels(id) {
    var provider = findProvider(id);
    if (!provider) return;
    var rows = (provider.models || []).map(function (row) { return { id: row.id, name: row.name || row.id, enabled: !!row.enabled }; });
    var defaultModel = provider.model || '';
    var body = el('div');
    var listBox = el('div');

    function paint() {
      listBox.replaceChildren();
      if (!rows.length) listBox.append(el('div', 'mv2-empty', '这家服务还没有模型，先探测或手动加'));
      rows.forEach(function (row, index) {
        var line = el('div', 'mv2-modelrow');
        line.append(el('span', 'mv2-mn', row.id));
        if (row.id === defaultModel) line.append(badge('默认', 'ok'));
        var right = el('div', 'mv2-right');
        var sw = el('input', 'mv2-switch');
        sw.type = 'checkbox';
        sw.checked = row.enabled;
        sw.onchange = function () {
          row.enabled = sw.checked;
          if (!sw.checked && row.id === defaultModel) { defaultModel = ''; }
          paint();
        };
        right.append(sw);
        right.append(btn('设为默认', 'mv2-btn sm', function () { defaultModel = row.id; row.enabled = true; paint(); }));
        right.append(btn('删', 'mv2-btn sm danger', function () { rows.splice(index, 1); paint(); }));
        line.append(right);
        listBox.append(line);
      });
    }
    paint();

    var newId = input('', '新模型 ID');
    var addBtn = btn('添加', 'mv2-btn', function () {
      var id = newId.value.trim();
      if (!id) return;
      if (rows.some(function (row) { return row.id === id; })) { MV2.toast('已经有这个模型', true); return; }
      rows.push({ id: id, name: id, enabled: true });
      newId.value = '';
      paint();
    });
    var addRow = el('div');
    addRow.style.display = 'flex';
    addRow.style.gap = '8px';
    addRow.style.marginTop = '10px';
    addRow.append(newId, addBtn);

    var probe = btn('从服务获取列表', 'mv2-btn', async function () {
      probe.disabled = true;
      try {
        var got = await MV2.api({
          action: 'discover', base_url: provider.base_url, api_mode: provider.api_mode,
          provider_id: provider.id, model: provider.model, use_saved_credential: true
        });
        var added = 0;
        (got.models || []).forEach(function (row) {
          if (!rows.some(function (have) { return have.id === row.id; })) { rows.push({ id: row.id, name: row.name, enabled: true }); added++; }
        });
        paint();
        MV2.toast('新增 ' + added + ' 个模型');
      } catch (error) {
        MV2.toast(error.message, true);
      }
      probe.disabled = false;
    });

    body.append(listBox, addRow);
    var probeRow = el('div');
    probeRow.style.marginTop = '10px';
    probeRow.append(probe);
    body.append(probeRow);

    MV2.sheet({
      title: '模型清单 · ' + provider.name,
      sub: '停用只是从可选列表里拿掉，不删记录',
      body: body, wide: true,
      foot: [
        btn('关闭', 'mv2-btn', MV2.closeSheet),
        btn('保存清单', 'mv2-btn primary', async function () {
          var enabled = rows.filter(function (row) { return row.enabled; });
          if (!enabled.length) { MV2.toast('至少要留一个启用的模型', true); return; }
          var target = defaultModel && enabled.some(function (row) { return row.id === defaultModel; })
            ? defaultModel : enabled[0].id;
          var changes = { models: rows, default_model: target };
          await MV2.mutate({ action: 'update', id: provider.id, changes: changes, revision: catalog().revision },
            { done: '模型清单已保存' });
          MV2.closeSheet();
        })
      ]
    });
  }

  /* ── 9. 删除服务 ─────────────────────────────────────── */
  function providerDelete(id) {
    var provider = findProvider(id);
    if (!provider) return;
    var catalogNow = catalog();
    var usedByPrimary = String(catalogNow.primary && catalogNow.primary.provider || '').replace(/^custom:/, '') === provider.id;
    var usedByChain = (catalogNow.fallbacks || []).filter(function (row) {
      return String(row.provider).replace(/^custom:/, '') === provider.id;
    });
    var body = el('div');
    if (usedByPrimary || usedByChain.length) {
      var warn = el('div', 'mv2-danger-zone');
      warn.append(el('b', null, '这个服务还在被使用，不能直接删'));
      if (usedByPrimary) warn.append(el('p', null, '· 它正是当前主模型'));
      usedByChain.forEach(function (row) { warn.append(el('p', null, '· 回退链里有 ' + row.model)); });
      warn.append(el('p', null, '先把主模型和回退链换掉，或者改用「停用」。'));
      body.append(warn);
    }
    var confirmInput = input('', '输入服务名称以确认');
    body.append(label('确认删除', confirmInput, '删除不可撤销，但每次写入都会留快照', true));

    MV2.sheet({
      title: '删除服务 · ' + provider.name,
      sub: provider.base_url,
      body: body,
      foot: [
        btn('关闭', 'mv2-btn', MV2.closeSheet),
        btn('删除', 'mv2-btn danger', async function () {
          if (confirmInput.value.trim() !== provider.name) { MV2.toast('名称不一致，没有删除', true); return; }
          await MV2.mutate({ action: 'delete', id: provider.id, revision: catalog().revision }, { done: '服务已删除' });
          MV2.closeSheet();
        })
      ]
    });
  }

  /* ── 10. 能力后端换来源 ──────────────────────────────── */
  function backendCfg(key) {
    var data = S().backends || { domains: [] };
    var domain = (data.domains || []).filter(function (row) { return row.key === key; })[0];
    if (!domain) { MV2.toast('没有这个能力后端', true); return; }
    var body = el('div');
    if (!domain.writable) {
      body.append(el('div', 'mv2-empty', domain.label + ' 跟随服务商原生能力，内核里没有独立配置项。硬加一个下拉框只会让人以为改了就生效。'));
      MV2.sheet({ title: domain.label, body: body, foot: [btn('关闭', 'mv2-btn', MV2.closeSheet)] });
      return;
    }
    var options = (domain.options || []).map(function (value) { return [value, value === '' ? '（不指定，自动）' : value]; });
    if (domain.provider && !(domain.options || []).some(function (value) { return value === domain.provider; })) {
      options.push([domain.provider, domain.provider + ' · 当前值']);
    }
    var picker = select(options, domain.provider);
    body.append(label('来源', picker, '写入 config.yaml 的 ' + key + ' 字段，下一条消息生效', true));
    if (Object.keys(domain.detail || {}).length) {
      var kv = el('div', 'mv2-kv');
      Object.keys(domain.detail || {}).forEach(function (name) {
        var line = el('div', 'mv2-kv-row');
        line.append(el('span', 'mv2-kv-k', name), el('span', 'mv2-kv-v', JSON.stringify(domain.detail[name])));
        kv.append(line);
      });
      body.append(label('当前配置', kv));
    }
    MV2.sheet({
      title: domain.label,
      sub: '能力后端 · ' + key,
      body: body,
      foot: [
        btn('关闭', 'mv2-btn', MV2.closeSheet),
        btn('保存', 'mv2-btn primary', async function () {
          await MV2.mutate({ action: 'save_backend', domain: key, provider: picker.value, revision: data.revision },
            { done: domain.label + ' 已切换' });
          MV2.closeSheet();
        })
      ]
    });
  }

  /* ── 11. 语音详情（复用 voice API） ──────────────────── */
  function backendVoice(key) {
    var voice = S().voice || {};
    var body = el('div');
    if (key === 'stt') {
      var stt = voice.stt || {};
      var enabled = el('input');
      enabled.type = 'checkbox';
      enabled.checked = !!stt.enabled;
      var enabledRow = el('label');
      enabledRow.style.display = 'flex';
      enabledRow.style.alignItems = 'center';
      enabledRow.style.gap = '8px';
      enabledRow.append(enabled, el('span', null, '启用语音转写'));
      var picker = select((stt.options || []).map(function (pair) { return [pair[0], pair[1]]; }), stt.provider);
      var lang = input(stt.language || '');
      body.append(enabledRow);
      body.append(label('提供方', picker, '本地 Whisper 不上传音频，云端更快'));
      body.append(label('识别语言', lang, '留空自动判断'));
      MV2.sheet({
        title: '语音转写', sub: 'STT 提供方', body: body,
        foot: [
          btn('关闭', 'mv2-btn', MV2.closeSheet),
          btn('保存', 'mv2-btn primary', async function () {
            try {
              await MV2.voicePatch({ target: 'stt', enabled: enabled.checked, provider: picker.value, language: lang.value.trim() });
              MV2.toast('语音转写已保存');
              await MV2.load(['voice']);
              MV2.render();
              MV2.closeSheet();
            } catch (error) { MV2.toast(error.message, true); }
          })
        ]
      });
    } else {
      var tts = voice.tts || {};
      var tpicker = select((tts.options || []).map(function (pair) { return [pair[0], pair[1]]; }), tts.provider);
      body.append(label('提供方', tpicker, '换提供方只影响之后的合成，已经发出去的语音不变'));
      var cards = el('div');
      (tts.providers || []).forEach(function (row) {
        var card = el('div', 'mv2-modelrow');
        card.append(el('span', 'mv2-mn', row.name));
        card.append(chip(row.type || '内置'));
        cards.append(card);
      });
      body.append(label('已配置的提供方', cards));
      MV2.sheet({
        title: '语音合成', sub: 'TTS 提供方', body: body,
        foot: [
          btn('关闭', 'mv2-btn', MV2.closeSheet),
          btn('保存', 'mv2-btn primary', async function () {
            try {
              await MV2.voicePatch({ target: 'tts', provider: tpicker.value });
              MV2.toast('语音合成已保存');
              await MV2.load(['voice']);
              MV2.render();
              MV2.closeSheet();
            } catch (error) { MV2.toast(error.message, true); }
          })
        ]
      });
    }
  }

  MV2.sheets = {
    mainSwitch: mainSwitch, slotEdit: slotEdit, bulkAssign: bulkAssign, fallbackAdd: fallbackAdd,
    moaEdit: moaEdit, providerNew: providerNew, providerEdit: providerEdit, providerDelete: providerDelete,
    providerModels: providerModels, backendCfg: backendCfg, backendVoice: backendVoice,
    backendDetail: backendCfg
  };

  /* 三个文件都就位之后再启动，保证 render 时 MV2.pages 已经有内容。 */
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { MV2.boot(); });
  else MV2.boot();
})();
