/* 模型页 · 弹层（2026-11-15 第二轮：严格对齐参考稿）
 *
 * 参考稿弹层结构：overlay > sheet > (sheet-h: .tt h3+st / .sheet-x) + sheet-b + sheet-f
 * 多步向导用 .steps；选择项用 .bigopt；确认输入用 .input + .errline。
 *
 * 每个弹层都对应真实写操作，没有只改内存的：
 *   changePrimary  → panel-models action=routes
 *   slot / assignAll → PATCH /api/panel-models/auxiliary
 *   providerAdd    → action=discover 探模型 + action=create
 *   providerModels → action=update（models）
 *   providerEdit   → action=update
 *   providerDelete → action=delete（先做引用检查）
 *   backendSwap    → action=save_backend（config 类）或转到 voice/auxiliary 编辑器
 *   configWrite    → action=config_write
 */
(function () {
  'use strict';
  var M = window.MV2;
  if (!M) return;
  var el = M.el, btn = M.btn, badge = M.badge, chip = M.chip, sec = M.sec,
      panel = M.panel, steps = M.steps, field = M.field, input = M.input, select = M.select;

  function providerList(S) {
    return ((S.catalog && S.catalog.providers) || []).filter(function (p) { return p.enabled !== false; });
  }

  function fmtCtx(n) {
    n = parseInt(n, 10);
    if (!n || n <= 0) return '';
    if (n >= 1000000) return (n / 1000000).toFixed(n % 1000000 ? 1 : 0).replace(/\.0$/, '') + 'M';
    if (n >= 1000) return Math.round(n / 1000) + 'K';
    return String(n);
  }

  function nameOf(S, id) {
    var hit = providerList(S).filter(function (p) { return p.id === id; })[0];
    return hit ? hit.name : (id || '');
  }

  /* 长说明不占正文：挂一个「?」，鼠标移上去或点一下才展开。
     2026-11-16 起实现搬到 js/core/help-hint.js（window.helpHint），点空白/ESC
     收起也一并收口到那里 —— 这里只留个薄包装，省得改几十处调用点。
     样式仍在 css/panel-model-ref.css 的 .qhint。 */
  function qhint(text) {
    return window.helpHint(text);
  }

  /* 和 field() 一样，但把长说明收进标签旁的「?」，正文不再撑出一行小字。 */
  function fieldQ(label, control, tip, required) {
    var box = el('div', 'field');
    var tag = el('label', 'lb', label);
    if (required) tag.append(el('span', 'req', '*'));
    if (tip) tag.append(qhint(tip));
    box.append(tag, control);
    return box;
  }

  /* 只列内核认的模型：enabled:false 的模型选进去会被后端以
     「所选服务或模型未启用」整笔拒绝，列出来就是骗人。 */
  function modelOptions(S) {
    var rows = [];
    providerList(S).forEach(function (p) {
      (p.models || []).forEach(function (m) {
        var id = m && typeof m === 'object' ? m.id : m;
        if (m && typeof m === 'object' && m.enabled === false) return;
        if (!id) return;
        /* key_label 是用户自己给这把密钥起的名字（如「DeepSeek 0.8x」），
           比内核 id 有用得多，必须一路带到渲染层。
           api_mode 后端没配就是空串 —— 这里不拿 'chat_completions' 兜底，
           否则界面上会出现一个用户从没设过、也改不了的「配置值」。 */
        rows.push({
          provider: p.id, name: p.name, label: p.key_label || '', model: id,
          base: p.base_url || '',
          api_mode: p.api_mode || '',
          context_window: (m && typeof m === 'object' ? m.context_window : 0) || 0
        });
      });
    });
    return rows;
  }

  /* 某个服务下可用的模型名（同样跳过 enabled:false） */
  function usableModels(provider) {
    return ((provider && provider.models) || []).filter(function (m) {
      return !(m && typeof m === 'object' && m.enabled === false);
    }).map(function (m) { return m && typeof m === 'object' ? m.id : m; }).filter(Boolean);
  }

  /* 服务 id → 它下面可用的模型名。slot / assignAll / 能力卡内联表单三处都要，
     以前每处各写一遍（其中一个还叫 modelsFor，跟别处重名），抽成一处。 */
  function modelsOf(providers, id) {
    var hit = providers.filter(function (p) { return p.id === id; })[0];
    return usableModels(hit);
  }

  /* 把「模型」下拉框填成「(用服务默认) + 该服务下的模型」。
     三处调用必须完全一致 —— 以前各写一份，早晚改一处忘一处。 */
  function fillModelSelect(sel, list) {
    sel.replaceChildren();
    var empty = el('option', null, '（用服务默认）');
    empty.value = '';
    sel.append(empty);
    list.forEach(function (m) { var o = el('option', null, m); o.value = m; sel.append(o); });
  }

  /* 同一个源 = 同一个 base_url。同一个中转站上开的两把 key（比如 ZeroAPI 的
     DeepSeek 通道和 Gemini 通道）是同一个服务，只是密钥不同 —— 按 provider 分组
     会并排出现两个「ZeroAPI」，谁也分不清哪个是哪个。
     归一化去掉尾斜杠和 /v1：https://x.cd 和 https://x.cd/v1 是同一个源。
     分组结果是两层：源 → 密钥 → 模型。密钥这一层用用户自己打的标签。 */
  function srcKey(url) {
    return String(url || '').trim().toLowerCase().replace(/\/+$/, '').replace(/\/v1$/, '');
  }
  function srcHost(url) {
    var m = String(url || '').match(/^https?:\/\/([^\/?#]+)/i);
    return m ? m[1] : String(url || '');
  }
  function groupBySource(rows) {
    var out = [], index = {};
    rows.forEach(function (row) {
      var k = srcKey(row.base) || ('?' + row.provider);
      var g = index[k];
      if (!g) { g = index[k] = { source: k, host: srcHost(row.base), keys: [], byKey: {} }; out.push(g); }
      var kb = g.byKey[row.provider];
      if (!kb) {
        kb = g.byKey[row.provider] = { provider: row.provider, name: row.name, label: row.label || '', rows: [] };
        g.keys.push(kb);
      }
      kb.rows.push(row);
    });
    out.forEach(function (g) {
      var names = [];
      g.keys.forEach(function (k) { if (k.name && names.indexOf(k.name) < 0) names.push(k.name); });
      /* 同源几把 key 一般起同一个服务名（都叫 ZeroAPI）→ 拿它当组标题，域名做小字；
         名字不一致就不瞎猜，直接用域名。 */
      g.title = names.length === 1 ? names[0] : (g.host || '未命名服务');
      g.sub = names.length === 1 ? g.host : '';
      g.multi = g.keys.length > 1;
    });
    return out;
  }

  /* 模型行副标题：上下文长度 + 非默认协议。两样都为空就不出这一行。
     换主模型和加备用两个弹层都用，所以放模块级，别在各自作用域里抄一份。 */
  function subOf(row) {
    var bits = [];
    if (fmtCtx(row.context_window)) bits.push(fmtCtx(row.context_window));
    if (row.api_mode && row.api_mode !== 'chat_completions') bits.push(row.api_mode);
    return bits.join(' · ');
  }

  /* 辅助任务要改的那几个字段：来源 / 模型 / 独立端点 / 超时。
     弹层（slot）和能力卡内联表单改的是同一份配置、同一个提交体 —— 以前写了两份，
     连「timeout 空串转 Number」这种细节都各写一遍。抽成一份，两边只负责排版。 */
  function buildAuxEditor(S, task) {
    var providers = providerList(S);
    var providerSel = select([['auto', '跟随主模型（auto）']].concat(
      providers.map(function (p) { return [p.id, p.name]; })
    ), task.provider || 'auto');
    var modelSel = select([['', '（用服务默认）']].concat(
      modelsOf(providers, task.provider).map(function (m) { return [m, m]; })
    ), task.model || '');
    providerSel.onchange = function () {
      fillModelSelect(modelSel, modelsOf(providers, providerSel.value));
    };
    var baseInput = input(task.base_url || '', 'https://…（provider=custom 时必填）');
    var timeoutInput = input(task.timeout || '', '例如 120', 'number');
    return {
      providerSel: providerSel,
      modelSel: modelSel,
      baseInput: baseInput,
      timeoutInput: timeoutInput,
      changes: function () {
        return {
          provider: providerSel.value,
          model: modelSel.value,
          base_url: baseInput.value.trim(),
          timeout: timeoutInput.value.trim() === '' ? '' : Number(timeoutInput.value)
        };
      }
    };
  }

  /* ── 1. 换主模型：一屏到底 ──────────────────────────
     早先是「挑模型 → 看差异 → 确认」三屏，同一件事要点四次按钮。
     现在列表和差异摘要同屏：选中即刷新摘要，底部一个确认键。
     标题行只放用户自己起的东西（服务名 + 密钥标签）；custom_xxx 是内核
     生成的内部标识，用户既没起过也改不了，不上屏。协议只在非默认时露出
     —— 每行都刷一遍 chat_completions 是纯噪音，而且那个值是前端拿
     `|| 'chat_completions'` 编出来的，配置里根本没有。 */
  M.sheets.changePrimary = function (S) {
    var rows = modelOptions(S);
    var primary = (S.catalog && S.catalog.primary) || {};
    var picked = { provider: primary.provider, model: primary.model };

    var sheet = M.sheet({ title: '换主模型', sub: '改的是 model.provider 与 model.default', wide: true });
    if (!rows.length) {
      sheet.body.append(el('div', 'empty', '没有可用的模型服务，先去「服务商」加一个'));
      sheet.foot.append(btn('关闭', 'btn', M.closeSheet));
      return;
    }

    var listWrap = el('div');
    var diffWrap = el('div', 'diffbox');
    sheet.body.append(listWrap);
    sheet.body.append(diffWrap);

    function chain() { return ((S.catalog && S.catalog.fallbacks) || []); }
    function clashRows() {
      return chain().filter(function (f) {
        return f.provider === picked.provider && f.model === picked.model;
      });
    }

    function renderList() {
      listWrap.replaceChildren();
      groupBySource(rows).forEach(function (group) {
        /* 每个源一个实体框。只改标题不套框等于没分组 —— 模型行照样一溜排下来，
           框才是「这几把 key 属于同一个站」的视觉证据。 */
        var wrap = el('div', 'srcgroup');
        var lb = el('div', 'lb', group.title);
        if (group.sub) lb.append(el('span', 'src mono', group.sub));
        if (!group.multi && group.keys[0].label && group.keys[0].label !== group.title) {
          lb.append(el('span', 'ktag', group.keys[0].label));
        }
        if (group.multi) lb.append(el('span', 'kcount', group.keys.length + ' 把密钥'));
        wrap.append(lb);
        group.keys.forEach(function (key) {
          /* 多把 key 才需要组内再分一层，用左竖线挂在框里，说明这堆模型走哪把 key。
             只写标签，组标题已经说了是哪个源。 */
          var kb = group.multi ? el('div', 'keysub') : wrap;
          if (group.multi) kb.append(el('div', 'ksec', key.label || key.name || '未命名密钥'));
          key.rows.forEach(function (row) {
            var on = row.provider === picked.provider && row.model === picked.model;
            var opt = btn('', 'bigopt' + (on ? ' on' : ''), function () {
              picked = { provider: row.provider, model: row.model };
              renderList();
              renderDiff();
            });
            opt.append(el('span', 'bo'));
            var box = el('span');
            box.append(el('span', 'bt mono', row.model));
            var sub = subOf(row);
            if (sub) box.append(el('span', 'bd', sub));
            opt.append(box);
            kb.append(opt);
          });
          if (group.multi) wrap.append(kb);
        });
        listWrap.append(wrap);
      });
    }

    function renderDiff() {
      diffWrap.replaceChildren();
      var clash = clashRows();
      var same = picked.provider === primary.provider && picked.model === primary.model;
      diffWrap.append(panel('要改的字段', [
        kvRow('model.provider', nameOf(S, primary.provider) + ' → ' + nameOf(S, picked.provider)),
        kvRow('model.default', (primary.model || '—') + ' → ' + picked.model),
        kvRow('回退链', (chain().length - clash.length) + ' 项保持原样' +
          (clash.length ? '，' + clash.length + ' 项被摘掉（它成了主模型）' : '')),
        kvRow('辅助槽位', '不动（单独指定的那几个继续用各自的服务）')
      ]));
      if (clash.length) {
        diffWrap.append(el('div', 'errline', '注意：' + picked.model + ' 原本在回退链里，切换后它会从回退链移除，' +
          '否则同一条链里会同时有主模型和它的回退。'));
      }
      diffWrap.append(el('p', 'mini', same
        ? '当前主模型就是它，不需要改。'
        : '切完对新会话生效。当前会话里已经在跑的请求不受影响。'));
      goBtn.disabled = same;
      goBtn.textContent = same ? '当前就是它' : '确认切换';
    }

    renderList();

    sheet.foot.append(btn('取消', 'btn', M.closeSheet));
    var goBtn = btn('确认切换', 'btn primary', async function () {
      var keep = chain().filter(function (f) { return clashRows().indexOf(f) < 0; });
      M.closeSheet();
      /* entries 用 key 复用现有条目，后端会把 key 命中项原样拷回来。
         只传 provider/model 会被后端判成「回退路线格式不正确」并整笔拒绝。 */
      await M.mutate({
        action: 'routes', provider: picked.provider, model: picked.model,
        entries: keep.map(function (f) { return { key: f.key }; }),
        revision: (S.catalog || {}).revision
      }, { done: '主模型已切换到 ' + picked.model, body: '写入 model.provider / model.default，回退链原样保留' });
    });
    sheet.foot.append(goBtn);
    renderDiff();
  };

  /* ── 2. 单个辅助槽位 ──────────────────────────────── */
  M.sheets.slot = function (S, task) {
    var sheet = M.sheet({ title: task.label || task.key, sub: 'auxiliary.' + task.key });

    var ed = buildAuxEditor(S, task);
    sheet.body.append(field('来源', ed.providerSel, 'auto 表示这个任务跟主模型走'));
    sheet.body.append(field('模型', ed.modelSel, '来源服务里登记的模型'));
    sheet.body.append(field('独立端点（可选）', ed.baseInput, '只在来源选 custom 时需要'));
    sheet.body.append(field('超时（秒）', ed.timeoutInput, '留空用内核默认'));

    if (task.fallback_chain && task.fallback_chain.length) {
      var chainRows = task.fallback_chain.map(function (entry, index) {
        var row = el('div', 'kv');
        row.append(el('span', null, '#' + (index + 1) + ' ' + nameOf(S, entry.provider)));
        var b = el('b');
        b.append(el('span', 'mono', entry.model || ''));
        row.append(b);
        return row;
      });
      sheet.body.append(panel('现有回退链（' + task.fallback_chain.length + ' 项）', chainRows));
      sheet.body.append(el('p', 'mini', '回退链的顺序调整在「辅助模型」原编辑器里做，这里只改来源与模型，避免两处写同一份链。'));
    }

    sheet.foot.append(btn('取消', 'btn', M.closeSheet));
    sheet.foot.append(btn('保存', 'btn primary', async function () {
      var changes = ed.changes();
      M.closeSheet();
      await M.auxMutate({ key: task.key, revision: task.revision, changes: changes },
        { done: task.label + ' 已更新' });
    }));
  };

  /* ── 3. 批量分配 ──────────────────────────────────── */
  M.sheets.assignAll = function (S) {
    var providers = providerList(S);
    var tasks = ((S.aux && S.aux.tasks) || []).slice();
    var sheet = M.sheet({ title: '批量分配', sub: '把多个辅助任务一次指到同一个来源', wide: true });

    var providerSel = select([['auto', '跟随主模型（auto）']].concat(
      providers.map(function (p) { return [p.id, p.name]; })
    ), 'auto');
    var modelSel = select([['', '（用服务默认）']], '');
    providerSel.onchange = function () {
      fillModelSelect(modelSel, modelsOf(providers, providerSel.value));
    };

    sheet.body.append(field('目标来源', providerSel));
    sheet.body.append(field('目标模型', modelSel));

    /* 默认一个都不勾 —— 这里「勾上才会写」，全不勾更安全。
       原来写的是 t.provider === 'auto' || !t.provider ? false : false，
       两个分支都是 false，读起来像在判断什么，其实什么都没判断。 */
    var picked = {};
    tasks.forEach(function (t) { picked[t.key] = false; });
    var list = el('div');
    tasks.forEach(function (t) {
      var row = el('label', 'checkline');
      var box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = false;
      box.onchange = function () { picked[t.key] = box.checked; };
      row.append(box);
      row.append(el('span', null, t.label || t.key));
      row.append(el('span', 'mono', 'auxiliary.' + t.key));
      list.append(row);
    });
    sheet.body.append(sec('要改的任务', '勾上才会写'));
    sheet.body.append(list);

    var allBtn = btn('全选', 'btn sm', function () {
      list.querySelectorAll('input[type=checkbox]').forEach(function (box) { box.checked = true; });
      tasks.forEach(function (t) { picked[t.key] = true; });
    });
    var noneBtn = btn('全不选', 'btn sm', function () {
      list.querySelectorAll('input[type=checkbox]').forEach(function (box) { box.checked = false; });
      tasks.forEach(function (t) { picked[t.key] = false; });
    });

    sheet.foot.append(allBtn, noneBtn, btn('取消', 'btn', M.closeSheet));
    sheet.foot.append(btn('批量保存', 'btn primary', async function () {
      var chosen = tasks.filter(function (t) { return picked[t.key]; });
      if (!chosen.length) { M.toast('没有勾任务', '至少勾一个再保存', 'bad'); return; }
      var changes = { provider: providerSel.value, model: modelSel.value };
      if (providerSel.value === 'auto') { changes.model = ''; changes.base_url = ''; }
      M.closeSheet();
      var ok = 0, failed = [];
      for (var i = 0; i < chosen.length; i++) {
        try {
          await M.auxPatch({ key: chosen[i].key, revision: chosen[i].revision, changes: changes });
          ok++;
        } catch (error) {
          failed.push((chosen[i].label || chosen[i].key) + '：' + error.message);
        }
      }
      M.S.aux = await M.auxGet();
      await M.load(['catalog']);
      M.render();
      if (failed.length) M.toast('部分失败', ok + ' 个已改，' + failed.length + ' 个失败：' + failed[0], 'bad');
      else M.toast('批量分配完成', ok + ' 个辅助任务已更新');
    }));
  };

  /* ── 4-5. 服务商表单：新增和编辑是同一张表 ───────────────
     用户明确要求「添加模型和编辑模型的功能应该一致，编辑只不过是代入了写好的信息」。
     所以物理上只有这一份实现：opts.provider 有值 = 编辑态（预填已有配置），
     没值 = 新增态。providerAdd / providerEdit 是两个薄壳，各自只剩一行转发。
     两态共用：官方服务商下拉、地址锁定、密钥多行、模型区、全部保存校验。
     2026-11-18 之后模型区也两态都开（见下方 4-5 的模型段注释）——新增时
     还没有 provider id，但模型区只需要地址 + 明文密钥，这两样新增态就有。
     所以现在两态字段完全一致，新增保存后仍跳编辑页只是为了补测连通。 */
  M.sheets.providerForm = function (S, opts) {
    opts = opts || {};
    var all = (S.catalog || {}).providers || [];
    var editing = !!opts.provider;
    var p = opts.provider || {};
    /* 卡片上点「编辑」传进来的是 group_view 里的一把 key，它没有 group 字段，
       所以一定回扁平 providers 里取真身 —— 否则 members 只剩它自己，
       2 把密钥的服务打开编辑只有 1 行。 */
    var self = editing ? (all.filter(function (x) { return x.id === p.id; })[0] || p) : {};
    var group = String(self.group || p.group || '').trim();
    var members = editing ? all.filter(function (x) {
      if (x.id === p.id) return true;
      return !!(group && String(x.group || '').trim() === group);
    }) : [];
    if (editing && !members.length) members = [p];

    var seed = opts.preset || {};
    var sheet = M.sheet({
      title: editing ? '编辑 ' + (self.name || p.id) : '添加 LLM 服务',
      sub: editing ? (members.length + ' 把密钥 · 共用名称和地址') : '密钥 · 模型 · 一次填完',
      wide: true
    });

    /* ── 官方服务商预设 ──
       数据只来自后端 catalog.presets（panel-models.py:PROVIDER_PRESETS），
       前端一个字都不硬编码。选官方 → 名称/地址/协议一起填好，同时锁住地址；
       选「自定义」→ 解锁，中转站和自建端点照旧手输。
       反查用 normUrl 归一（去尾斜杠、砍末尾 /v1）—— 本机就有一条
       https://api.deepseek.com/v1，直接比字符串会把它认成第三方。 */
    var PRESETS = (S.catalog || {}).presets || [];
    function normUrl(u) {
      var t = String(u || '').trim().replace(/\/+$/, '');
      if (/\/v1$/.test(t)) t = t.slice(0, -3).replace(/\/+$/, '');
      return t;
    }
    var hitPreset = PRESETS.filter(function (x) {
      return normUrl(x.base_url) === normUrl(editing ? self.base_url : seed.base_url);
    })[0];

    var nameI = input(editing ? (self.name || '') : (seed.name || ''), '例如 ZeroAPI');
    var urlI = input(editing ? (self.base_url || '') : (seed.base_url || ''), 'https://api.example.com/v1');
    var modeSel = select([
      ['', '由内核识别'],
      ['chat_completions', 'OpenAI 兼容'],
      ['anthropic_messages', 'Anthropic Messages'],
      ['codex_responses', 'Codex Responses']
    ], editing ? (self.api_mode || '') : (seed.api_mode || ''));

    /* 官方端点地址只读。用 readOnly 不用 disabled —— disabled 的框整格发灰、
       连地址都复制不了，看着像坏了。提示文案跟着一起换，「锁住了」得写出来，
       光靠背景色差在深色主题里几乎看不出来。 */
    function lockUrl(on) {
      urlI.readOnly = !!on;
      urlI.classList.toggle('ro', !!on);
      urlI.title = on ? '官方端点地址固定；要换别的地址，把上面切成「自定义」' : '';
      var fh = urlField && urlField.querySelector('.fh');
      if (fh) {
        fh.textContent = on
          ? '官方端点地址固定，已锁定 —— 要改地址，把上面「官方服务商」切成「自定义」'
          : '不含查询参数的 HTTP/HTTPS 地址';
      }
    }
    var presetSel = select(
      [['', '自定义（手动填写地址）']].concat(PRESETS.map(function (x) { return [x.id, x.name]; })),
      hitPreset ? hitPreset.id : ''
    );
    presetSel.onchange = function () {
      var hit = PRESETS.filter(function (x) { return x.id === presetSel.value; })[0];
      if (!hit) { lockUrl(false); return; }
      nameI.value = hit.name;
      urlI.value = hit.base_url;
      modeSel.value = hit.api_mode || '';
      lockUrl(true);
    };
    var urlField = field('服务地址', urlI, '不含查询参数的 HTTP/HTTPS 地址', true);

    /* 选了「自定义」却手填官方端点的情形：卡片那边照样按地址认成官方（后端
       norm_endpoint 只看地址），但这里刻意不锁 —— 用户明确选了自定义，就是
       他要自己填，这时候把框锁上等于违背他的选择。只把事实说出来，
       要不要切到官方预设由他决定。 */
    urlI.addEventListener('input', function () {
      if (urlI.readOnly) return;
      var hit = PRESETS.filter(function (x) { return normUrl(x.base_url) === normUrl(urlI.value); })[0];
      var fh = urlField && urlField.querySelector('.fh');
      if (!fh) return;
      fh.textContent = hit
        ? '这地址是「' + hit.name + '」的官方端点；切到上面「官方服务商」选中它，地址会锁住'
        : '不含查询参数的 HTTP/HTTPS 地址';
    });

    /* lockUrl 第一句就摸 urlField.querySelector('.fh')，所以必须在这行之后调用 ——
       JS 只提升声明不提升赋值，挪上去就变成给 undefined 挂 querySelector。 */
    lockUrl(!!hitPreset);

    sheet.body.append(field('官方服务商', presetSel, '选官方厂商自动填好地址和协议并锁住地址；中转站 / 自建端点选「自定义」'));
    sheet.body.append(field('服务名称', nameI, '同一服务商的多把密钥共用这个名字', true));
    sheet.body.append(urlField);
    sheet.body.append(field('接口协议', modeSel, '不确定就留「由内核识别」'));

    /* ── 密钥：一行一把，两态同一套 ──
       新增态默认给一行空白，编辑态载入已有密钥。编辑时留空 = 保持原值；
       ✕ 只动草稿，点「保存」那一刻才真删。 */
    /* value 存字符串，不存 DOM 引用：drawKeys() 每次加点新密钥都会把整排 input
       重建，值挂在元素上的话，加第三把就把第二把的明文抹了（2026-11-17 用户报的
       「添加第三个会丢失第二个密钥，不能临时存储」）。 */
    var keyRows = editing
      ? members.map(function (m) { return { id: m.id, label: m.key_label || '', value: '' }; })
      : [{ id: '', label: '', value: '' }];
    var keyBox = el('div', 'keylist');
    var mp = null;   /* 编辑态下方的模型区 */

    function syncModelKeys() {
      if (!mp) return;
      var seen = {};
      keyRows.forEach(function (r) { if (r.id) seen[r.id] = 1; });
      mp.setMembers(members.filter(function (m) { return seen[m.id]; }), keyRows);
      var st = sheet.box.querySelector('.sheet-h .st');
      if (st) st.textContent = keyRows.length + ' 把密钥 · 共用名称和地址';
    }

    /* 草稿行在 keyRows 里的序号（第几个 id 为空的）。模型区拿它当虚拟来源 id
       __draft_<di>：一把草稿一个标签、一次端点发现。原来全折成 __draft_0，
       加两把新密钥只出一个标签。 */
    function draftIndexOf(at) {
      var di = -1;
      for (var i = 0; i < keyRows.length; i++) {
        if (!keyRows[i].id) di++;
        if (i === at) return keyRows[i].id ? -1 : di;
      }
      return -1;
    }

    function drawKeys() {
      /* replaceChildren 会把 input 整个扔掉，值存在元素上就等于没存 ——
         重绘前先把眼下 DOM 里的内容收回 keyRows。 */
      var live = keyBox.querySelectorAll('.keyrow');
      Array.prototype.forEach.call(live, function (row, i) {
        var r = keyRows[i]; if (!r) return;
        var ins = row.querySelectorAll('input');
        if (ins[0]) r.label = ins[0].value;
        if (ins[1]) r.value = ins[1].value;
      });
      keyBox.replaceChildren();
      keyRows.forEach(function (r) {
        var row = el('div', 'keyrow');
        var lab = input(r.label || '', '名称（必填），例如 主用');
        lab.oninput = function () { r.label = lab.value; if (mp) mp.refresh(); };
        var val = input(r.value || '', r.id ? '已配置 · 留空不改' : '填明文密钥', 'password');
        val.oninput = function () { r.value = val.value; };
        var del = btn('✕', 'btn sm danger kdel', function () {
          keyRows = keyRows.filter(function (x) { return x !== r; });
          drawKeys();
          syncModelKeys();
        });
        del.title = r.id
          ? '从草稿里移除：下方模型区立刻只按剩下的密钥算，点「保存」才真正删除'
          : '移除这一行';
        row.append(lab, val, del);
        keyBox.append(row);
      });
    }
    drawKeys();

    var khead = el('div', 'khead');
    khead.append(el('span', 'lb', '密钥'));
    khead.append(qhint('同一个服务的多把 key 都在这里，每把可以配自己的模型。改值时填明文就行，保存时自动写进 .env，config 里只留变量名。密钥值不会回显。'));
    sheet.body.append(khead);
    sheet.body.append(keyBox);
    sheet.body.append(btn('+ 添加一把密钥', 'btn', function () {
      keyRows.push({ id: '', label: '', value: '' });
      drawKeys();
      syncModelKeys();
    }));

    /* ── 模型区：两态都开（2026-11-18）──
       用户报「添加模型的面板功能更少，一点都不方便」。原来这里写着
       `if (editing && p.id)`，理由是「新增时还没有 id，拉不了模型」。但模型区
       从头到尾没读过 p.id —— 它要的是服务地址 + 明文密钥 + 协议，新增态这三样
       已经在输入框里。于是新增只能盲存：先存一把、再自动跳编辑页、再勾模型。
       现在新增态照样能「获取模型 / 勾选 / 测连通」，勾好的清单直接跟着 create
       一次写进去；保存后仍进编辑页，但那是给补测连通用，不是必经步骤。
       p 只在 modelPanel 里当 cur 的兜底用，新增态给一个空壳即可。 */
    {
      var mWrap = el('div', 'mblock');
      var mHost = el('div', 'mhost');
      var mBar = el('div', 'mbar idle');
      mWrap.append(mHost, mBar);
      sheet.body.append(mWrap);
      /* 新增态没有 provider 对象，给 modelPanel 一个空壳：它只拿 p 当 cur 的兜底，
         真正的来源由下面 getCtx 现读输入框（含未保存的草稿行）。 */
      mp = M.sheets.modelPanel(S, editing ? p : null, mHost, mBar, function (wantId) {
        /* wantId 有三种：已存密钥的真实 id、'__draft_<n>'（第 n 个草稿行）、空。
           草稿行 id 是空串，拿真实 id 那套直接比对永远匹配不上 —— 之前
           getCtxSafe('__draft_0') 返回空 key，草稿密钥既测不了连通也拉不了模型。 */
        var dm = /^__draft_(\d+)$/.exec(String(wantId || ''));
        var fresh = '', freshLabel = '';
        for (var i = 0; i < keyRows.length; i++) {
          var kr = keyRows[i];
          if (dm) { if (draftIndexOf(i) !== Number(dm[1])) continue; }
          else if (wantId && kr.id !== wantId) continue;
          var v = String(kr.value || '').trim();
          if (v) { fresh = v; freshLabel = String(kr.label || '').trim(); break; }
        }
        /* rowSnap 带 di：模型区靠它给每个草稿行分配 __draft_<di>，
           原来全挤到 __draft_0 上，三把草稿只出一个来源。 */
        var rowSnap = keyRows.map(function (r, i) {
          return { id: r.id || '', label: String(r.label || '').trim(),
                   di: r.id ? -1 : draftIndexOf(i) };
        });
        return { key: fresh, base_url: urlI.value, api_mode: modeSel.value,
                 label: freshLabel, rows: rowSnap };
      }, editing ? members : []);
    }

    var err = el('div', 'errline');
    sheet.body.append(err);
    function warn(msg) { err.className = 'errline warn'; err.textContent = msg; }
    function clearErr() { err.className = 'errline'; err.textContent = ''; }

    /* 收密钥草稿，两态共用。返回 [{id, label, value}]；value 空但 id 有值 =
       编辑态「留空不改」。校验全挤在这一处：名字必填、不许重名、新明文不许撞。 */
    function collectKeys() {
      var out = [];
      for (var i = 0; i < keyRows.length; i++) {
        var r = keyRows[i];
        var lb = String(r.label || '').trim();
        var v = String(r.value || '').trim();
        if (!lb) { warn('第 ' + (i + 1) + ' 把密钥还没起名字 —— 模型清单靠它标来源'); return null; }
        if (v) out.push({ id: r.id || '', label: lb, value: v });
        else if (r.id) out.push({ id: r.id, label: lb, value: '' });
        else { warn('第 ' + (i + 1) + ' 把密钥还没填值'); return null; }
      }
      var seenLab = {}, seenVal = {};
      for (var j = 0; j < out.length; j++) {
        if (seenLab[out[j].label]) {
          warn('两把密钥都叫「' + out[j].label + '」—— 模型清单上分不清哪个模型来自哪把，改一个名字');
          return null;
        }
        seenLab[out[j].label] = 1;
        if (out[j].value) {
          if (seenVal[out[j].value]) {
            warn('第 ' + seenVal[out[j].value] + ' 把和第 ' + (j + 1) + ' 把填的是同一把密钥 —— 同一个服务里不挂重复的');
            return null;
          }
          seenVal[out[j].value] = j + 1;
        }
      }
      if (!out.length) { warn('这个服务下一把密钥都不剩了 —— 留一把，或者直接用「删除服务」把整张卡去掉'); return null; }
      return out;
    }

    sheet.foot.append(btn('取消', 'btn', M.closeSheet));
    sheet.foot.append(btn('保存', 'btn primary', async function () {
      var name = nameI.value.trim();
      var url = urlI.value.trim();
      if (!name || !url) { warn('服务名称和地址都得填上'); return; }
      clearErr();
      var list = collectKeys();
      if (!list) return;

      if (editing) {
        /* 一次 group_update 全量提交：名称、地址、密钥、模型清单一起走 */
        var draft = mp ? mp.draftKeys() : { keys: [], blank: [] };
        var modelOf = {};
        draft.keys.forEach(function (k) { modelOf[k.id] = k.models; });
        if (draft.blank.length) {
          warn('还没配完：' + draft.blank.join('、') +
            ' 一个模型都没勾。至少各勾一个，或者把不要的密钥删掉。');
          return;
        }
        var pool = M.modelDraftPool ? M.modelDraftPool() : [];
        var keys = [];
        for (var i = 0; i < list.length; i++) {
          var it = list[i];
          var cred = it.value ? { action: 'replace', value: it.value } : { action: 'keep' };
          var item = { id: it.id, key_label: it.label, credential: cred };
          /* 新密钥只认它自己拉回来的那几行，绝不继承别的密钥的清单 */
          if (it.id && modelOf[it.id]) item.models = modelOf[it.id];
          else if (!it.id && pool.length) item.models = pool;
          keys.push(item);
        }
        try {
          var saved = await M.mutate({
            action: 'group_update', id: p.id,
            changes: { name: name, base_url: url, api_mode: modeSel.value },
            keys: keys,
            revision: (M.S.catalog || {}).revision
          }, { done: name + ' 已更新',
               body: keys.length + ' 把密钥 · ' +
                 keys.filter(function (k) { return k.models && k.models.length; }).length + ' 份模型清单' });
          /* 409 时 mutate 返回失败对象而不是抛异常，这里必须拦住 ——
             不然接着 closeSheet，面板自己关掉、草稿全丢。 */
          if (saved && saved.ok === false) { warn('没存上：' + (saved.error || '后端拒了这次保存')); return; }
        } catch (error) {
          warn('没存上：' + (error.message || '后端没给原因')); return;
        }
        M.closeSheet();
        return;
      }

      /* ── 新增态 ──
         逐把密钥问端点要模型（一个模型都没有的 key 不许存，否则卡片上多个
         点进去是空的壳），再 create 建起第一条 provider，剩下的密钥用
         group_update 补齐，最后自动打开编辑页勾模型。 */
      var plan = [];
      /* 模型区在新增态也开着（2026-11-18），所以先看用户在下面勾了什么：
         勾过的直接照勾选结果写，不再重扫端点 —— 他手动取消的模型不能被
         「自动发现」又塞回去。没拉过清单的密钥才退回探测。 */
      var pool = (mp && mp.draftPoolBySource) ? mp.draftPoolBySource() : {};
      var poolOfLabel = {};
      keyRows.forEach(function (r, i) {
        var lb = String(r.label || '').trim();
        if (lb) poolOfLabel[lb] = '__draft_' + draftIndexOf(i);
      });
      for (var k = 0; k < list.length; k++) {
        var one = list[k];
        if (!one.value) { warn('第 ' + (k + 1) + ' 把密钥还没填值'); return; }
        var did = poolOfLabel[one.label];
        var picked = did ? pool[did] : null;
        if (picked) {
          if (!picked.length) {
            warn('「' + one.label + '」下面一个模型都没勾 —— 勾上要用的，或者把这把密钥删掉');
            return;
          }
          plan.push({ label: one.label, value: one.value, models: picked, count: picked.length });
          continue;
        }
        err.className = 'errline';
        err.textContent = '正在探测模型（' + (k + 1) + '/' + list.length + '）…';
        try {
          var res = await M.api({ action: 'discover', base_url: url, api_mode: modeSel.value, api_key: one.value });
          var rows = (res && res.models) || [];
          /* 提交给 create 的 models 必须是 discover 原样返回的对象数组
             （{id, name, enabled}）—— 后端 entries 校验只认这个形状，
             拍平成 ['model-a', ...] 会被打成「模型条目格式不正确」，
             而且这条错误是在 create 那一跳才炸的，探测阶段看不出任何异常。 */
          var names = rows.map(function (m) { return m.id || m; }).filter(Boolean);
          if (!names.length) {
            warn('「' + one.label + '」这把密钥没拿到任何模型，这个服务存不进去。确认地址和密钥是对的再来一次。');
            return;
          }
          plan.push({ label: one.label, value: one.value, models: rows, count: names.length });
        } catch (e) {
          warn('探测失败：' + ((e && e.message) || e));
          return;
        }
      }
      var made;
      try {
        made = await M.mutate({
          action: 'create',
          changes: { name: name, base_url: url, api_mode: modeSel.value,
                     key_label: plan[0].label,
                     credential: { action: 'replace', value: plan[0].value },
                     models: plan[0].models },
          revision: (M.S.catalog || {}).revision
        }, { done: '已添加 ' + name, body: '探测到 ' + plan[0].models.length + ' 个模型' });
        if (made && made.ok === false) { warn('没存上：' + (made.error || '后端拒了这次保存')); return; }
      } catch (e2) {
        warn('没存上：' + ((e2 && e2.message) || e2));
        return;
      }
      var newId = made && (made.id || made.created);
      /* 后端没回 id 就停在列表页，不硬闯编辑页 —— 闯进去也是对着空气勾模型 */
      if (!newId) { M.closeSheet(); return; }
      if (plan.length > 1) {
        err.textContent = '正在写入其余 ' + (plan.length - 1) + ' 把密钥…';
        try {
          var more = await M.mutate({
            action: 'group_update', id: newId,
            changes: { name: name, base_url: url, api_mode: modeSel.value },
            keys: plan.map(function (x, idx) {
              return { id: idx === 0 ? newId : '', key_label: x.label,
                       credential: { action: 'replace', value: x.value }, models: x.models };
            }),
            revision: (M.S.catalog || {}).revision
          }, { done: '已添加 ' + name, body: plan.length + ' 把密钥 · 各自一份模型清单' });
          if (more && more.ok === false) {
            warn('服务建好了，但剩下的密钥没写进去：' + (more.error || '后端拒了'));
            return;
          }
        } catch (e3) {
          warn('服务建好了，但剩下的密钥没写进去：' + ((e3 && e3.message) || e3));
          return;
        }
      }
      M.closeSheet();
      /* 接着打开编辑页：模型勾选只在这里能做。这就是「添加和编辑是同一张表」
         的闭环 —— 加完不用回卡片再点一次「编辑」。 */
      M.sheets.providerEdit(M.S, { id: newId });
    }));
  };

  /* 两个入口都指向同一张表，区别只是传不传已有配置 —— 用户原话：
     「编辑模型只不过是代入了写好的信息而已」。 */
  M.sheets.providerAdd = function (S, preset) {
    return M.sheets.providerForm(S, { preset: preset });
  };

  /* ── 5c. 模型区：编辑页内联，动态刷新 + 状态栏 ─────────
     原来卡片上有「获取模型」「模型」两个按钮，各自开弹层，「手动添加」
     还套第三层弹层。现在全并进编辑页：勾选即存、状态栏一格说清、
     获取结果原地替换列表，不关不弹。 */

  function normModels(list) {
    return (list || []).map(function (m) {
      if (m && typeof m === 'object') {
        return {
          id: m.id || m.name || '',
          name: m.name || m.id || '',
          enabled: m.enabled !== false,
          context_window: m.context_window || 0
        };
      }
      return { id: m, name: m, enabled: true, context_window: 0 };
    }).filter(function (m) { return !!m.id; });
  }

  /* 后端校验：context_window 要么不传，要么是正数。传 0 会以
     「模型条目格式不正确」拒掉整次写入，所以只有真值才带上。 */
  function modelPayload(list) {
    return list.map(function (m) {
      var o = { id: m.id, name: m.name || m.id, enabled: m.enabled !== false };
      if (m.context_window > 0) o.context_window = m.context_window;
      return o;
    });
  }

  /* 一个服务商可以有多把 key，每把 key 在端点上的可见模型是独立的 ——
     实测同一个 direct.saviour.cc.cd，DeepSeek 那把只看得见 4 个文本模型，
     生图那把看得见 15 个（gemini-*-image / nano-banana-*）。
     所以不搞「先选钥匙再拉」那套：一次把全部 key 都问一遍，结果合并进同一张
     列表，每个模型后面挂上它来自哪几把 key。勾选和移出对所有来源 key 生效，
     保存时再按来源拆回每把 key 自己的 models，一次 group_update 写完。 */
  M.sheets.modelPanel = function (S, p, host, bar, getCtx, members) {
    /* 打开弹层：members 是这个服务全部已存密钥（提交时要原样带回去，否则后端
       group_update 是按 keys 全量替换的，少一把就是删一把）。
       cur = 模型展示、拉取、勾选认的那几把 —— 打开时就是全部已存密钥。 */
    /* 新增态（p 为 null）cur 必须是空数组，不能退回 [p]：那个空壳的 id 是 ''，
       会被当成「一把没有 id 的真实密钥」跑一遍 discover，和同一行草稿
       __draft_0 各拉一份 —— 同一把密钥出两组标签、模型表里每个模型挂两份来源。 */
    var cur = (members && members.length) ? members.slice() : (p ? [p] : []);
    var getCtxSafe = getCtx || function () { return {}; };
    var rows = [];     /* 合并视图：{id, name, enabled, context_window, keys:[keyId]} */
    var byId = {};
    var query = '';
    var hidden = {};   /* 后端「移出」是 enabled=false 归档，视图自己记住，否则重绘又回来 */
    var src = {};      /* keyId -> {state:'ok'|'fail'|'empty', msg, n} 这次请求的结果 */
    /* 草稿来源拉回来的模型清单：__draft_<di> -> [{id,name,ctx}]。
       setMembers 一调 rebuild 就从 cur 重铺，而草稿行不在 cur 里 —— 不把这份
       重放回去，用户加完密钥一点模型区，刚拉到的草稿分组整块消失
       （「加第三个密钥下方没有对应的标签」的另一半，2026-11-17）。 */
    var draftModels = {};
    /* 2026-11-16：单条连通测试的结果，modelId -> {state,label,code,ms,detail,busy,at}。
       state 和中文短标签都由后端 classifyProbe 判定（可用/欠费/限流/无此模型/密钥失效/
       超时/连不上/上游异常/被拒绝），前端只负责摆位置，不自己编判断。
       用户原话：「比如 200 404 之类的我不太懂」—— 所以 HTTP 码只进 title，不上脸。 */
    var listHost = null;   /* 行容器：paint() 建，paintRows() 填 */
    var probe = {};
    /* 已落盘的实测能力（2026-11-16 加）。
       原来 kind 只活在 probe{} 内存里，刷新就没 —— 用户测完一轮，第二天打开
       又叫不出哪个模型是生图的。现在后端把每次 test_model 的 kind 写进
       panel-state/model-kinds.json，这里开局先灌一次，标签立刻就在。
       本次会话真测出来的结果优先：saved 只是垫底，probe 里有就不覆盖。 */
    var kindsLoaded = false;
    function applySavedKinds(models, list) {
      (list || []).forEach(function (m) {
        if (probe[m.id]) return;
        var kid = (m.keys || [])[0] || '';
        var rec = models[kid + '|' + m.id];
        if (!rec || !rec.kind) {
          /* 首把密钥没记录时，挨个试它的其它来源，别因为排序不同就当没测过 */
          for (var i = 0; i < (m.keys || []).length; i++) {
            var alt = models[m.keys[i] + '|' + m.id];
            if (alt && alt.kind) { rec = alt; break; }
          }
        }
        if (rec && rec.kind) probe[m.id] = { state: 'ok', label: '可用', kind: rec.kind, at: rec.at, saved: true };
      });
    }
    function loadSavedKinds(list) {
      return M.api({ action: 'kinds' }).then(function (res) {
        applySavedKinds((res && res.models) || {}, list);
      }).catch(function () { /* 读不到就当没存过，不影响测试功能 */ });
    }
    /* 「测全部连通」的运行标志。它同时是门禁（重入直接返回）和按钮状态来源 ——
       只把 disabled 写在按钮上不够：paint() 会重建整块工具条，重新 new 出来的
       按钮默认是可点的，标志一丢就又能连点。状态放在这里，paint 时照着它画。 */
    var probingAll = false;

    function keyOf(id) {
      for (var i = 0; i < cur.length; i++) if (cur[i].id === id) return cur[i];
      return null;
    }

    /* ── 来源密钥：一处定义，处处只读它 ────────────────────────────
       这张表里「谁在提供模型」只有两种：已经存进配置的（cur），和编辑页上刚填、
       还没保存的那一把（草稿行）。以前这两种各写一套判断 —— 渲染数 cur.length、
       状态栏数 keyRows.length、归属挂一个虚拟 id 到处 indexOf 特判 —— 条件彼此
       对不上：明明状态栏在问 2 把密钥，渲染判据却认为只有 1 把，于是标签整片
       不显示（2026-11-16 用户报的「标签怎么没了」）。

       现在渲染、判据、汇总、发现全部只读这一份，名称一律用用户自己填的那个，
       不再由代码编「未保存」「密钥 0」这种它不是它、你也不是你的说法。 */
    var DRAFT_ID = '__draft_0';
    function isDraft(kid) {
      return String(kid == null ? '' : kid).indexOf('__draft_') === 0;
    }

    function sources() {
      /* 名称的唯一真源是编辑页上那几行输入框，不是后端快照。
         cur[i].key_label 是「上次保存时的名字」—— 用户改完输入框它一个字都不会变，
         照它显示，改完上面名字下面标签一动不动（2026-11-16 用户第二次报的）。
         rows 由 getCtxSafe 每次现读，已保存行和草稿行走同一条路，没有任何一条
         需要「等等看后端怎么说」。

         这里故意不留 key_label 兜底：输入框空着就显示「密钥」，不拿旧名冒充现名。
         留着兜底等于同一个人有两个名字来源，正是「临时和正式混为一谈」的根。 */
      var live = getCtxSafe('') || {};
      var list = live.rows || [];
      var out = [], i;
      for (i = 0; i < list.length; i++) {
        var row = list[i];
        if (row.id) {
          out.push({ id: row.id, label: row.label || '密钥', draft: false });
        } else {
          /* 一把草稿一个来源。原来用 seenDraft 把草稿全折成 __draft_0，
             加两把新密钥只出一个标签、端点也只问一把 —— 用户报的
             「模型标签只能有 2 个」「3 把密钥只获取 2 把的模型」都在这里
             （2026-11-17）。di 由编辑页的 rowSnap 算好带进来。 */
          var di = (row.di != null && row.di >= 0) ? row.di : 0;
          var did = '__draft_' + di;
          var got = src[did] || {};
          out.push({ id: did, label: row.label || got.label || '新密钥', draft: true });
        }
      }
      return out;
    }

    /* 按 keyId 取名称。走到「已删」只可能是配置里还有、编辑页刚被删掉的那种。 */
    function labelOfKey(kid) {
      var list = sources(), i, s = String(kid == null ? '' : kid);
      for (i = 0; i < list.length; i++) {
        if (String(list[i].id) === s) return list[i].label;
      }
      return isDraft(kid) ? '新密钥' : '已删';
    }

    /* 这张表有几把来源密钥 —— 只有这一个判据，渲染和汇总共用。 */
    function sourceCount() {
      return sources().length;
    }

    /* 一个模型可能被好几把 key 看见，来源记成数组；名称和长度取第一个有值的。
       2026-11-16：勾选状态从行级单值 r.enabled 改成按密钥存 r.on[keyId]。
       原来一个开关服务所有来源密钥 —— 同名模型在 A 密钥下勾上，B 密钥保存时
       也跟着写进去，用户的「两组 key 同名模型串了」就是这个。现在各勾各的。 */
    function absorb(id, name, ctxw, on, keyId) {
      var r = byId[id];
      if (!r) {
        r = { id: id, name: name || id, on: {}, context_window: ctxw || 0, keys: [] };
        byId[id] = r; rows.push(r);
      } else {
        if ((!r.name || r.name === r.id) && name && name !== id) r.name = name;
        if (!r.context_window && ctxw) r.context_window = ctxw;
      }
      if (r.keys.indexOf(keyId) < 0) r.keys.push(keyId);
      /* 直接赋值，不能写成 if (on) —— 取消勾选要靠它清掉 */
      r.on[keyId] = !!on;
      return r;
    }

    /* 这个模型在任一来源密钥下被勾上 —— 只用于「这个模型还在不在用」这类
       粗判（计数、全选状态），真写进配置看的是 on[keyId]。 */
    function anyOn(r) {
      for (var i = 0; i < r.keys.length; i++) if (r.on[r.keys[i]]) return true;
      return false;
    }

    /* 草稿密钥（刚加进来、还没保存的那把）拉回来的模型清单。
       providerEdit 保存时要拿这个，但 rows 是 providerModels 这个闭包的局部变量，
       外面看不见 —— 2026-11-16 上午那边图省事直接写了 rows.filter(...)，于是每次
       点保存都抛 rows is not defined：界面不提示，看着像点成功了，配置一个字节没写。
       留这一个出口，别再跨闭包摸 rows。 */
    M.modelDraftPool = function () {
      return rows.filter(function (r) {
        return r.keys.some(isDraft);
      }).map(function (r) {
        var on = r.keys.some(function (k) { return isDraft(k) && r.on[k]; });
        return { id: r.id, name: r.name, enabled: on };
      });
    };

    /* 打开弹层：把各把 key 已存的 models 合并成一张表。
       keep 传 true 时保留当前勾选状态 —— 在编辑页删掉一把密钥会触发重算，
       不能顺手把用户刚勾/刚取消的选择抹掉。 */
    function rebuild(keep) {
      var prev = {};
      if (keep) rows.forEach(function (r) {
        r.keys.forEach(function (kid) { prev[r.id + '\u0001' + kid] = !!r.on[kid]; });
      });
      rows = []; byId = {};
      cur.forEach(function (m) {
        normModels(m.models).forEach(function (x) {
          absorb(x.id, x.name, x.context_window, x.enabled !== false, m.id);
        });
      });
      /* 草稿来源重放。cur 里没有这些虚拟 key，光铺 cur 的话，编辑页那边
         「+ 添加一把密钥」→ syncModelKeys → setMembers → 这里，用户刚在端点
         拉到的草稿模型分组就会整块被洗掉。草稿行被删掉时顺手清缓存。 */
      var liveDraft = {};
      sources().forEach(function (o) { if (o.draft) liveDraft[o.id] = 1; });
      Object.keys(draftModels).forEach(function (did) {
        if (!liveDraft[did]) { delete draftModels[did]; return; }
        draftModels[did].forEach(function (x) {
          var pk = x.id + '\u0001' + did;
          var on = Object.prototype.hasOwnProperty.call(prev, pk) ? prev[pk] : true;
          absorb(x.id, x.name, x.ctx, on, did);
        });
      });
      /* 逐 (模型, 密钥) 还原勾选 —— 按模型 id 还原会把 A 密钥的勾泼到 B 密钥上 */
      if (keep) rows.forEach(function (r) {
        r.keys.forEach(function (kid) {
          var pk = r.id + '\u0001' + kid;
          if (Object.prototype.hasOwnProperty.call(prev, pk)) r.on[kid] = prev[pk];
        });
      });
    }

    /* 状态栏：一个节点说清所有情形。后端原文不藏 —— 只给「失败」等于
       让人猜，所以 detail 直接摊在下面，另配一键复制。 */
    function setBar(kind, msg, detail) {
      /* 2026-11-16：消息为空时整条状态栏收起来。原来不管有没有话说，都留着
         「圆点 + 一行空文本」，在模型列表底下压出一截空白。 */
      var text = msg == null ? '' : String(msg);
      bar.className = 'mbar ' + kind + (text ? '' : ' empty');
      bar.replaceChildren();
      if (!text) return;
      bar.append(el('span', 'mdot'));
      var raw = detail && String(detail) !== String(msg) ? String(detail) : '';
      var body = el('span', 'mbody');
      body.append(el('span', 'mtxt', msg));
      if (raw) body.append(el('span', 'mdetail', raw));
      bar.append(body);
      if (raw) {
        bar.append(btn('复制原文', 'mcopy', function () {
          try {
            navigator.clipboard.writeText(raw).then(function () {
              M.toast('已复制', '原文进了剪贴板');
            }, function () { window.prompt('手动复制', raw); });
          } catch (e) { window.prompt('手动复制', raw); }
        }));
      }
    }

    /* 2026-11-16：这里原来还多算一个「N 个生图」，判据是正则猜模型名
       /image|dall-?e|flux|stable-diffusion|midjourney|seedream|imagen|banana/。
       换一家中转站就漏判 —— sora、kolors、hunyuan-image、doubao-seededit 全不在表里，
       而 gpt-4o-image 之类又会误判。猜错比不报更糟，正是用户说的「换了模型和情况
       怎么办」。判生图这件事交给「测试」：拿 chat 端点真打过去，非对话模型会明确
       回错误。所以计数只留模型数和启用数，一个形容词都不加。 */
    function countLine() {
      var live = rows.filter(function (r) { return !hidden[r.id]; });
      var on = live.filter(anyOn).length;
      var t = live.length + ' 个模型';
      /* 「· 0 启用」字面没说错，但对人一点用没有 —— 一个都没启用还报「0」，
         读完不知道该干嘛。全停用就直说全停用，部分启用才报数字并带分母。 */
      if (live.length && on === 0) t += ' · 全部停用';
      else if (on < live.length) t += ' · ' + on + '/' + live.length + ' 启用';
      return t;
    }

    /* 页头那个「N 个模型 · M 启用」只有这一处负责渲染。
       勾选要跟着变，但重绘整块会让勾选框失焦 —— 所以单独一个函数只改文本。
       原来勾选回调里直接 host.querySelector('.mcount') 摸节点，摸不到就静默不更新；
       现在渲染点集中在这儿，paint() 建的节点和这里改的是同一个。 */
    function paintCount() {
      var cnt = host.querySelector('.mcount');
      if (cnt) cnt.textContent = countLine();
    }

    /* 全选用：只算眼前可见的（被搜索过滤掉的不受影响，否则「全选」会顺手
       把没显示的行也改了，看不见的改动最坑人）。 */
    function visibleRows() {
      return rows.filter(function (r) {
        if (hidden[r.id]) return false;
        if (!query) return true;
        return r.id.toLowerCase().indexOf(query) >= 0 ||
               String(r.name || '').toLowerCase().indexOf(query) >= 0;
      });
    }

    function allOn() {
      var live = visibleRows();
      return live.length > 0 && live.every(anyOn);
    }

    /* 每把 key 自己的 models —— 启用状态跟着行上的勾走。
       2026-11-16：原来这里还有一段「把原默认模型塞回清单，否则后端拒写」的
       补丁，配套 defFor() 选默认。后端那条校验和 default_model 一起废掉了，
       这两段一并删除。 */
    function modelsFor(keyId) {
      var out = [];
      rows.forEach(function (r) {
        if (r.keys.indexOf(keyId) < 0) return;
        var o = { id: r.id, name: r.name || r.id, enabled: !!r.on[keyId] };
        if (r.context_window > 0) o.context_window = r.context_window;
        out.push(o);
      });
      return out;
    }

    /* 2026-11-16 改掉的旧逻辑：这里原来叫 saveAll，勾一个模型、移出一个模型、
       手动加一行、拉一次端点，全都立刻 group_update 写 config。用户的原话是
       「只有保存按钮点的时候才会触发配置文件修改」「不要弄的时刻都去改配置文件」。
       现在模型区是纯草稿：所有改动只落在 rows 上，由编辑页底部那个「保存」
       一次提交（draftKeys 负责按来源 key 拆回去）。 */

    /* 草稿脏了：只更新提示，一个字节都不写后端。 */
    function markDirty(msg) {
      setBar('warn', msg || '改动还没保存');
    }

    /* 把草稿按来源密钥拆成 keys 数组，交给「保存」按钮那一次 group_update。
       返回 { keys, blank }：blank 非空表示有某把密钥一个模型都没勾 —— 调用方
       必须拒掉，那就是「模型清单是空的」，不许存。 */
    function draftKeys() {
      var keys = [];
      var blank = [];
      cur.forEach(function (m) {
        var list = modelsFor(m.id);
        if (!list.some(function (x) { return x.enabled; })) { blank.push(labelOfKey(m.id)); return; }
        keys.push({ id: m.id, models: list });
      });
      return { keys: keys, blank: blank };
    }

    /* 单条测试：对这个模型挂的每一把来源密钥都试一次，第一个能用就算可用。
       一个模型可能同时挂在两把 key 下（一把欠费、一把正常），只试一把会误判成不可用。
       不写配置、不 markDirty —— 这是纯读操作，跟「保存」没有一点关系。 */
    async function probeOne(m, silent) {
      var now = probe[m.id];
      if (now && now.busy) return;
      probe[m.id] = { state: 'busy', label: '测试中', busy: true };
      if (!silent) paintRows();
      var failed = null;
      /* 先试勾上的密钥：这个模型在 A 组勾了、B 组没勾时，用户关心的是 A 组那把
         能不能用。同一模型只留一份测试结果（它是不是可用模型属于模型级属性）。 */
      var kids = m.keys.slice().sort(function (a, bid) { return (m.on[bid] ? 1 : 0) - (m.on[a] ? 1 : 0); });
      for (var i = 0; i < kids.length; i++) {
        var kid = kids[i], k = keyOf(kid), ctx = getCtxSafe(kid) || {};
        var base = String(ctx.base_url || (k && k.base_url) || '').trim();
        if (!base) { failed = failed || { state: 'network', label: '没地址', detail: '这把密钥没有服务地址' }; continue; }
        var payload = {
          action: 'test_model', provider_id: kid, base_url: base, model: m.id,
          api_mode: ctx.api_mode || (k && k.api_mode) || ''
        };
        var typed = String(ctx.key || '').trim();
        if (typed) payload.api_key = typed; else payload.use_saved_credential = true;
        try {
          var res = await M.api(payload);
          var out = (res && res.probe) || null;
          if (!out) { failed = failed || { state: 'unknown', label: '没结果', detail: '后端没返回探测结果' }; continue; }
          if (out.state === 'ok') {
            /* kind 是后端测出来的模型类型（image / tools / chat），不是按名字猜的 */
            probe[m.id] = { state: 'ok', label: '可用', code: out.code, ms: out.ms, kind: out.kind || '', at: Date.now() };
            /* 测出来就落盘：下次打开面板、换设备、重启后都直接带能力标签，不用重测。
               写失败不影响这一次的显示 —— 标签已经在 probe 里了。 */
            if (out.kind) M.api({ action: 'save_kind', provider_id: kid, model: m.id, kind: out.kind, code: out.code, ms: out.ms }).catch(function () {});
            if (!silent) paintRows();
            return probe[m.id];
          }
          failed = failed || out;
        } catch (err) {
          failed = failed || { state: 'unknown', label: '测不了', detail: (err && err.message) || '' };
        }
      }
      probe[m.id] = failed
        ? { state: failed.state, label: failed.label, code: failed.code, ms: failed.ms, detail: failed.detail, at: Date.now() }
        : { state: 'unknown', label: '没测成', at: Date.now() };
      if (!silent) paintRows();
      return probe[m.id];
    }

    /* 只测勾选的模型 —— 勾选框就是「这个我要」的声明，没勾的连请求都不该发。
       并发压到 2：一次轰二十个请求，测出来的「限流」是自己造成的，那不叫连通性，叫自残。
       全程上锁 —— 两道门：标志是逻辑门（保证只有一轮队列在跑），按钮 disabled 是
       视觉门（告诉人别再点了）。只做后者的话 paint() 重建一次工具条就把它洗掉。 */
    async function probeAll() {
      if (probingAll) return;
      var live = visibleRows().filter(anyOn);
      if (!live.length) {
        setBar('bad', visibleRows().length ? '没有勾选的模型 —— 先勾上要测的' : '当前搜索里没有模型');
        return;
      }
      probingAll = true;
      paint();     /* 按钮照 probingAll 画成「测试中…」并置灰 */
      setBar('busy', '正在测 ' + live.length + ' 个已勾选模型的连通…');
      try {
        var idx = 0, queue = function () {
          if (idx >= live.length) return Promise.resolve();
          var m = live[idx++];
          return probeOne(m, true).then(queue);
        };
        var workers = [];
        for (var w = 0; w < 2; w++) workers.push(queue());
        await Promise.all(workers);
      } finally {
        probingAll = false;
        paint();   /* 不管成没成都要还原，卡在「测试中」比测不完还难受 */
      }
      var tally = {};
      live.forEach(function (m) { var s = probe[m.id]; if (s) tally[s.state] = (tally[s.state] || 0) + 1; });
      var okN = tally.ok || 0, badN = live.length - okN;
      setBar(okN === live.length ? 'good' : 'idle',
        '测完 ' + live.length + ' 个已勾选：' + okN + ' 个可用' + (badN ? '，' + badN + ' 个有问题' : ''));
    }

    /* 一次问全部 key。凭证在后端各自解，这里只说「问哪把」。
       单把失败不牵连其他把 —— 成功的照常合并，失败的把那行标出来。 */
    async function discoverAll() {
      var jobs = [];
      cur.forEach(function (m) {
        var ctx = getCtxSafe(m.id) || {};
        var base = String(ctx.base_url || m.base_url || '').trim();
        if (!base) { src[m.id] = { state: 'fail', msg: '没有服务地址' }; return; }
        var payload = {
          action: 'discover', provider_id: m.id, base_url: base,
          api_mode: ctx.api_mode || m.api_mode || '',
          model: ''
        };
        var typed = String(ctx.key || '').trim();
        if (typed) payload.api_key = typed;
        else payload.use_saved_credential = true;
        jobs.push(M.api(payload).then(function (res) {
          var ids = ((res && res.models) || []).map(function (x) {
            return typeof x === 'string' ? x : (x && x.id);
          }).filter(Boolean);
          return { id: m.id, ids: ids };
        }, function (err) {
          return { id: m.id, error: (err && err.message) || '获取失败' };
        }));
      });

      /* 每个草稿行各问各的 —— 原来只拿 getCtxSafe('') 挑出来的那一把，
         加几把新密钥都只问第一把，于是「填了 3 把密钥只能获取 2 把的模型」。
         did 在闭包里必须显式捕获：var 循环变量进 .then 时只剩最后一个值。 */
      var allRows = (getCtxSafe('') || {}).rows || [];
      allRows.forEach(function (row) {
        if (row.id) return;
        var di = (row.di != null && row.di >= 0) ? row.di : 0;
        var did = '__draft_' + di;
        var lab = String((row.label || '') ).trim();
        var dctx = getCtxSafe(did) || {};
        (function (did, dctx, lab) {
          var k = String(dctx.key || '').trim();
          var b = String(dctx.base_url || '').trim();
          if (!k || !b) {
            src[did] = { state: 'fail', msg: k ? '没有服务地址' : '还没填明文密钥', label: lab || dctx.label || '' };
            return;
          }
          jobs.push(M.api({
            action: 'discover', provider_id: '', base_url: b,
            api_mode: dctx.api_mode || '', api_key: k, model: ''
          }).then(function (res) {
            var ids = ((res && res.models) || []).map(function (x) {
              return typeof x === 'string' ? x : (x && x.id);
            }).filter(Boolean);
            return { id: did, ids: ids, label: lab || dctx.label || '' };
          }, function (err) {
            return { id: did, error: (err && err.message) || '获取失败', label: lab || dctx.label || '' };
          }));
        })(did, dctx, lab);
      });

      if (!jobs.length) { setBar('bad', '每把密钥都没有服务地址', '先把服务地址填上'); return; }
      setBar('busy', '正在问 ' + jobs.length + ' 把密钥的模型清单…');
      var results = await Promise.all(jobs);
      var got = {}, ok = 0, bad = 0, empty = 0, firstError = '';
      results.forEach(function (r) {
        var lab = r.label || '';
        if (r.error) { src[r.id] = { state: 'fail', msg: r.error, label: lab }; bad++; if (!firstError) firstError = r.error; return; }
        if (!r.ids.length) { src[r.id] = { state: 'empty', msg: '端点返回空清单', label: lab }; empty++; return; }
        src[r.id] = { state: 'ok', n: r.ids.length, label: lab };
        got[r.id] = r.ids; ok++;
      });
      if (!ok) {
        paint();
        setBar('bad', '没有一把密钥拉到模型', firstError || (empty ? '每把都返回空清单' : ''));
        return;
      }
      /* 以端点为准重建：拉到的 key 用新清单，没拉到的保留原清单。
         2026-11-16 用户明确：「我之前选了哪些你不需要记，只看最后状态」——
         所以拉取就是重新开始，端点上有的全部默认启用，不把上次的停用带回来。
         原来这里有一份 wasOff 快照把旧停用状态盖回去，已删除。 */
      /* 端点只回模型 id，不回别名，也不回上下文窗口。清空重建前先把这两个留住，
         否则拉一次「128K」全变成空，看着像模型退化 —— 这是实测出来的坑，不是猜的。 */
      var prevInfo = {};
      rows.forEach(function (r) { prevInfo[r.id] = { name: r.name, ctx: r.context_window }; });
      function infoOf(id) { return prevInfo[id] || {}; }

      rows = []; byId = {};
      cur.forEach(function (m) {
        var ids = got[m.id];
        if (ids) {
          ids.forEach(function (id) {
            var old = infoOf(id);
            absorb(id, old.name || id, old.ctx || 0, true, m.id);
          });
        } else {
          normModels(m.models).forEach(function (x) {
            absorb(x.id, x.name, x.context_window, x.enabled !== false, m.id);
          });
        }
      });
      /* 草稿密钥拉回来的模型并进清单，归属挂它那个虚拟 id。
         它不在 cur 里，所以不进 draftKeys 的 keys —— 保存时走 pool 兜底继承，
         跟「新加密钥继承同服务清单」是同一条路。 */
      Object.keys(got).forEach(function (kid) {
        if (!isDraft(kid)) return;
        /* 记一份给 rebuild 重放用，否则 setMembers 一来分组就没了 */
        draftModels[kid] = got[kid].map(function (id) {
          var old = infoOf(id);
          return { id: id, name: old.name || id, ctx: old.ctx || 0 };
        });
        got[kid].forEach(function (id) {
          var old = infoOf(id);
          absorb(id, old.name || id, old.ctx || 0, true, kid);
        });
      });
      hidden = {}; query = '';
      paint();
      var tail = [];
      if (bad) tail.push(bad + ' 把失败');
      if (empty) tail.push(empty + ' 把空清单');
      /* 拉回来只填草稿表，不写配置 —— 他是拿这个做「过程测试」的，点保存才算数。
         「都还在草稿里，点「保存」才写进配置」这句删了：状态行已经写着「改动还没
         保存」，再加一句只是把按钮上的字换成中文念一遍。 */
      if (tail.length) setBar('warn', '合并出 ' + rows.length + ' 个模型 · ' + tail.join('、'));
      else markDirty('合并出 ' + rows.length + ' 个模型');
    }

    /* 行内状态：一个色点 + 两个字。可用是绿的，问题是红的，还没测就没这个标签。
     HTTP 码、耗时、上游原文全塞 title，鼠标放上去才看得见 —— 不占地方，
     也不拿 200/404 这种数字糊用户的脸。 */
    function stateTag(v) {
      var tag = el('span', 'mtest st-' + v.state, v.label);
      var meta = [];
      if (v.code) meta.push('HTTP ' + v.code);
      if (v.ms) meta.push(v.ms + 'ms');
      if (v.detail) meta.push(String(v.detail).slice(0, 160));
      if (v.at) meta.push(new Date(v.at).toLocaleTimeString());
      if (meta.length) tag.title = meta.join(' · ');
      if (v.state === 'ok' && v.ms) tag.append(el('i', 'mtest-ms', v.ms + 'ms'));
      return tag;
    }

    /* 模型类型标签：它说「这模型是干什么的」，跟旁边的 key 标签说「这模型来自哪把
       钥匙」并列。用户原话：「除了设置的 key 的标签以外，能不能标一下模型本身是
       什么类型」。
       三种都由后端实测得出（kindOf），不按模型名猜 —— 中转站挂什么名字都不奇怪：
         生图 —— 响应里真有图片（data:image/、b64_json）
         工具 —— 响应里真有 tool_calls
         对话 —— 能正常回一句话
       「语音」「嵌入」「重排」测不出来：它们不走 chat/completions 这条路，要另发
       /audio、/embeddings 请求。少一个标签比贴一个错的强，所以这里不标。
       没测过（seen.kind 为空）就不占地方，不拿「未知」糊一行。 */
    var KIND_LABEL = { image: '生图', tools: '工具', chat: '对话' };
    var KIND_HINT = { image: '实测：返回的是图片', tools: '实测：能回 tool_calls', chat: '实测：能正常回话' };
    function kindTag(kind) {
      var text = KIND_LABEL[kind];
      if (!text) return null;
      var tag = el('span', 'mkind kd-' + kind, text);
      tag.title = KIND_HINT[kind] || '';
      return tag;
    }

    function paintRows() {
      /* 开局灌一次已落盘的实测能力，灌完重绘一遍把标签画出来。
         放在这里而不是弹层创建处：rows 要等模型清单拉完才有内容，
         这时候灌才是对的；灌不到（文件还没生成）就静默跳过。 */
      if (!kindsLoaded && rows.length) {
        kindsLoaded = true;
        loadSavedKinds(rows).then(function () { try { paintRows(); } catch (_) {} });
      }
      listHost.replaceChildren();
      /* 可见性判据只有 visibleRows() 一份 —— 全选也用同一份，
         以前这里内联了一段一模一样的 filter，改一处忘一处。 */
      var shown = visibleRows();
      if (!shown.length) {
        listHost.append(el('div', 'mempty', rows.length
          ? '没有匹配「' + query + '」的模型'
          : '还没有模型 —— 拉一次端点，或者手动加一行'));
        return;
      }
      /* 一把密钥时没有来源歧义，不画分组头、不占地方。
         2026-11-16：渲染改成按来源密钥分组。原来一个模型一行、一个勾选框服务它
         所有来源密钥 —— 同名模型在 A 密钥下勾上，B 密钥保存时也被写上同样的
         清单，用户报的「两组 key 同名模型串了」就出在这里。现在每个
         (密钥 × 模型) 一个勾，各勾各的。 */
      var showSource = sourceCount() > 1;
      var groups = [], gmap = {};
      shown.forEach(function (m) {
        m.keys.forEach(function (kid) {
          if (!gmap[kid]) { gmap[kid] = { kid: kid, items: [] }; groups.push(gmap[kid]); }
          gmap[kid].items.push(m);
        });
      });
      groups.forEach(function (g) {
        if (showSource) listHost.append(keyGroupHead(g.kid, g.items));
        g.items.forEach(function (m) { paintRow(m, g.kid); });
      });
    }

    /* 分组头：这把密钥叫什么、这一组勾了几个。一把密钥时不画。 */
    function keyGroupHead(kid, items) {
      var st = src[kid];
      var h = el('div', 'mkeygrp');
      h.dataset.kid = kid;
      h.append(el('span', 'mkgname' + (st && st.state === 'fail' ? ' bad' : ''), labelOfKey(kid)));
      if (isDraft(kid)) h.append(el('span', 'mkgdraft', '新'));
      var n = items.filter(function (m) { return m.on[kid]; }).length;
      h.append(el('span', 'mkgcnt', n + '/' + items.length));
      return h;
    }

    /* 分组头的「勾了几个/共几个」跟着勾走。只改文本不重绘 —— 重绘丢焦点。 */
    function repaintGroupCounts() {
      if (sourceCount() <= 1) return;
      var nodes = listHost.querySelectorAll('.mkeygrp');
      for (var i = 0; i < nodes.length; i++) {
        var h = nodes[i], kid = h.dataset.kid;
        if (!kid) continue;
        var all = rows.filter(function (r) { return r.keys.indexOf(kid) >= 0; });
        var n = all.filter(function (r) { return r.on[kid]; }).length;
        var t = h.querySelector('.mkgcnt');
        if (t) t.textContent = n + '/' + all.length;
      }
    }

    /* 一行 = 一个模型在某一把密钥下的位置。勾选只写 m.on[kid]。 */
    function paintRow(m, kid) {
      var on = !!m.on[kid];
      var row = el('div', 'mrow' + (on ? '' : ' off'));
      var box = document.createElement('input');
      box.type = 'checkbox';
      box.className = 'mchk';
      box.title = labelOfKey(kid);
      box.checked = on;
      /* 只改草稿，不写配置；勾选不报文案（勾选框本身就是状态）。
         off 类跟着勾走，不重绘整块，免得勾选框失焦。 */
      box.onchange = function () {
        m.on[kid] = box.checked;
        row.classList.toggle('off', !box.checked);
        paintCount();
        repaintGroupCounts();
        markDirty();
      };
      row.append(box);
      row.append(el('span', 'mid mono', m.id));
      if (m.name && m.name !== m.id) row.append(el('span', 'mname', m.name));
      if (m.context_window) row.append(el('span', 'mctx', fmtCtx(m.context_window)));
      var macts = el('div', 'macts');
      /* 「移出」换成「测试」：「这个模型现在到底能不能用」才是点保存之前真想知道的 */
      var seen = probe[m.id];
      if (seen && !seen.busy) macts.append(stateTag(seen));
      /* 类型标签紧挨着状态标签：一个说「能不能用」，一个说「它是个什么东西」 */
      if (seen && !seen.busy) { var kt = kindTag(seen.kind); if (kt) macts.append(kt); }
      macts.append(btn(seen && seen.busy ? '测试中' : '测试', 'btn sm mmin mprobe', function () {
        probeOne(m);
      }));
      row.append(macts);
      listHost.append(row);
    }


    function paint() {
      host.replaceChildren();

      var head = el('div', 'mhead');
      head.append(el('span', 'lb', '模型'));
      /* 解释一律收进问号。原来工具栏上还挂了一个，窄屏上问号跟四个按钮抢位置，
         索性并到这里 —— 一处能说清的事不该拆成两处。 */
      head.append(qhint('勾上的模型才会写进配置。模型表按密钥分组，同一个模型在几把密钥下'
        + '能看见就分几组、各勾各的 —— 在 A 组取消勾选不会动到 B 组。'
        + '「测试」发的是真请求（画一张最小的图，生图模型会花十几秒）：欠费、并发超限、密钥失效、'
        + '模型没开通都会标出来，绿色的能用，点开看原因。'));
      head.append(el('span', 'mcount', countLine()));
      host.append(head);

      /* 每把密钥这次的成绩：几个模型 / 什么错。不是切换器，只是交代状态。
         2026-11-16：这里原来先 forEach(cur)、再单独补一段读 src.__draft_0，
         同一种东西写两遍，草稿那句还得自己编「未保存」。现在统一遍历 sources()，
         名称是用户填的那个，草稿只是多一个 draft 类。 */
      /* 密钥把数算一次，整块 paint 都复用它 —— 原来这里和下面按钮各算一次，
         每次都穿过 getCtxSafe 把编辑页全部输入框读一遍。 */
      var nsrc = sourceCount();
      if (nsrc > 1) {
        var sline = el('div', 'msrcs');
        sources().forEach(function (o) {
          var s = src[o.id];
          var txt = o.label;
          if (s && s.state === 'ok') txt += ' · ' + s.n;
          else if (s && s.state === 'empty') txt += ' · 空';
          else if (s && s.state === 'fail') txt += ' · 失败';
          var c = el('span', 'msrc' + (o.draft ? ' draft' : '') + (s && s.state === 'fail' ? ' bad' : ''), txt);
          if (s && s.msg) c.title = s.msg;
          sline.append(c);
        });
        host.append(sline);
      }

      var tools = el('div', 'mtools');
      var search = input(query, '搜索模型 ID');
      search.oninput = function () { query = search.value.trim().toLowerCase(); paintRows(); };
      tools.append(search);
      /* 主色只留给弹层底部那个「保存」，这里用描边按钮，别抢注意力。
         窄屏两列格子塞不下「从端点获取（2 把密钥）」这么长，标签会被撑出格子；
         密钥数量下面来源行里已经写了，所以只在宽屏带上这个计数。 */
      /* 把数用上面那个 nsrc：草稿行也是要问的一把，用 cur.length 会少算。 */
      var manyKeys = nsrc > 1 && window.innerWidth > 640;
      tools.append(btn(manyKeys ? '从端点获取（' + nsrc + ' 把密钥）' : '从端点获取',
        'btn sm', function () { discoverAll(); }));
      /* 2026-11-16：拉清单只证明「这把 key 能读到 /v1/models」，欠费和限流要到真对话
         才报。所以测连通得单独一发，但得能一次点完 —— 19 个模型逐个点没人受得了。
         按钮状态由 probingAll 决定（飞的时候灰掉、字换成「测试中…」），不临时改 DOM：
         paint() 重建工具条时照标志重画，标志没丢按钮就不会复活。 */
      var probeAllBtn = btn(probingAll ? '测试中…' : '测全部连通', 'btn sm', function () { probeAll(); });
      probeAllBtn.disabled = probingAll;
      probeAllBtn.title = '只测已勾选的模型；一轮没跑完之前不能重复点';
      tools.append(probeAllBtn);
      tools.append(btn('+ 手动加一行', 'btn sm', function () { toggleManual(); }));
      /* 全选 / 全不选合成一个按钮，标签跟着当前状态走 —— 多选没有全选是真的没法用，
         尤其一次拉回十几个模型的时候。只作用于眼前可见的行（搜索过滤剩下的）。 */
      tools.append(btn(allOn() ? '全不选' : '全选', 'btn sm', function () {
        var live = visibleRows();
        if (!live.length) return;
        var turnOn = !allOn();
        live.forEach(function (r) { r.keys.forEach(function (kid) { r.on[kid] = turnOn; }); });
        paint();
        markDirty();   /* 同上：全选/全不选也不报数，勾选框自己说明一切 */
      }));
      host.append(tools);

      listHost = el('div', 'mlist');
      host.append(listHost);

      var manual = el('div', 'mmanual');
      manual.style.display = 'none';
      var midI = input('', '模型 ID，如 gpt-image-2');
      var mnameI = input('', '别名（可留空）');
      manual.append(midI, mnameI);
      manual.append(btn('加入', 'btn sm', async function () {
        var id = midI.value.trim();
        if (!id) { setBar('bad', '模型 ID 不能为空'); return; }
        if (byId[id] && !hidden[id]) { setBar('bad', id + ' 已经在清单里'); return; }
        /* 手动加的模型挂到全部密钥上 —— 它本来就是端点没返回、但你知道能用的东西。
           但归属必须有密钥：保存时是按密钥拆回各自 models 的，一把都没有就没地方挂。
           原来这里直接取 cur[0].id，密钥删光后 cur 是空数组，整个「加入」按钮报
           Cannot read properties of undefined —— 改成先看有没有归属，没有就说清楚。 */
        var owners = sources().map(function (s) { return s.id; });
        if (!owners.length) { setBar('bad', '先加一把密钥，模型才有地方挂'); return; }
        if (hidden[id]) { delete hidden[id]; }
        var r = absorb(id, mnameI.value.trim() || id, 0, true, owners[0]);
        owners.forEach(function (kid) { if (r.keys.indexOf(kid) < 0) r.keys.push(kid); });
        midI.value = ''; mnameI.value = '';
        manual.style.display = 'none';
        paint();
        markDirty('已加入 ' + id);
      }));
      host.append(manual);

      function toggleManual() {
        manual.style.display = manual.style.display === 'none' ? 'flex' : 'none';
        if (manual.style.display !== 'none') midI.focus();
      }


      paintRows();
    }

    /* 2026-11-16：状态栏原来是一长句「合并自 2 把密钥，现有 19 个模型 · 16 启用 ·
       6 个生图。勾选、拉取都只改这张表，右边「测试」只报连通 —— 点「保存」才写进
       配置」。用户原话：「这种没有意义的提示词，这种不通用的文字表述换了模型和情况
       怎么办？都删掉」。

       他说得对，那段有三个毛病：一是把界面自己的交互翻译成中文再念一遍（按钮上写着
       「保存」，不需要旁边再用一句话保证「点保存才写进配置」）；二是写死了数量关系
       —— 只有一把密钥时「合并自 2 把密钥」直接是假话；三是换一家服务商、改一次模型
       数量就全过期。状态栏只该说「现在有几个模型」，别的都交给控件自己表达。 */
    function refreshBar() {
      /* 一把来源都不剩 = 已保存的删光了、也没加新的。判据直接用 sources()。
         原来另外维护一个 draftRowCount（由 setMembers 传进来），说的是同一件事，
         两处一旦不同步状态栏就报错话 —— 能现算的就别再存一份。 */
      if (!sourceCount()) return setBar('idle', '密钥一把都不剩了');
      /* 2026-11-16：底部不再重复「N 个模型 · M 启用」—— 页头问号后面那个 .mcount
         说的就是这句话，同一屏出现两遍，用户直接问「这不是重复了吗」。
         计数只留页头一份；底部只报异常和操作态（正在问 / 哪把失败 / 改动没保存），
         空闲时清空收起。 */
      if (!rows.length) return setBar('idle', '还没有模型');
      setBar('idle', '');
    }

    rebuild();
    paint();
    refreshBar();

    return {
      discover: discoverAll,
      /* 改名只影响标签上的文字，模型清单一个字节都没动 —— 所以这里只重画，不 rebuild。
         原来调的是 rebuild()（而且没带 keep）：改个名字就把用户刚勾的全抹了，
         absorb 按配置文件里上次保存的 enabled 重新铺一遍，「勾一下顺手改个名」等于白勾。
         需要重建的只有 setMembers 那条路径（密钥增减了，来源变了）。 */
      refresh: function () { paint(); refreshBar(); },
      /* 「保存」按钮从这里拿最终清单（含空清单校验），落盘只在那一刻发生 */
      draftKeys: draftKeys,
      /* 新增态专用：按草稿来源分组导出勾选结果（__draft_<di> -> 已勾的模型）。
         编辑态走 draftKeys()，它按 cur（已存密钥）遍历，加新服务时 cur 里没有 id，
         刚拉回来的草稿分组一把都拿不到 —— 那正是「添加面板勾不了模型」的根。
         返回的键就是编辑页 rowSnap 里算好的 di，外面按下标取。 */
      draftPoolBySource: function () {
        var out = {};
        sources().forEach(function (o) {
          if (!o.draft) return;
          out[o.id] = rows.filter(function (r) {
            return r.keys.indexOf(o.id) >= 0 && r.on[o.id];
          }).map(function (r) {
            /* 只带三个键：后端 entries 校验写的是 set(m)-{'id','name','enabled'}
               必须为空，多一个 context_window 就整次 create 报「模型条目格式不正确」。 */
            return { id: r.id, name: r.name, enabled: true };
          });
        });
        return out;
      },
      /* 编辑页在草稿里删掉一把密钥时调这个：模型区立刻只认剩下的密钥，不用等
         保存 —— 「我删了就应该实时变化，才能方便下面的测试」。keep 保住用户已经
         勾好的选择，只把消失的那把来源摘掉。 */
      setMembers: function (next) {
        /* 0 把也照实传下去，不回退到 p —— 删光了就是没有来源，模型表跟着空，
           别偷偷拿原来那把顶上（那是兜底，用户明确不要）。 */
        cur = (next || []).slice();
        rebuild(true);
        paint();
        refreshBar();
      }
    };
  };

  /* ── 6. 编辑服务 ─────────────────────────────────────
     实现本体在 4-5 的 providerForm：编辑 = 同一张表 + 预填已有配置。
     这里不留任何自己的字段，避免又一次「添加改好了编辑没改」。 */
  M.sheets.providerEdit = function (S, p) {
    return M.sheets.providerForm(S, { provider: p });
  };

  /* ── 8. 换来源 ────────────────────────────────────── */
  /* 能力后端 · 内联表单（方案 1 完全内联）：每张卡直接展开 provider+model+参数，不弹 sheet */
  /* 把一次实测的结果翻成人话：耗时、音频多长、多大、说了什么、听成什么。
     卡片上这一行就是「实证」的全部证据，所以宁可写具体，也不要说「成功」。 */
  function describeProbe(out) {
    if (!out || typeof out !== 'object') return '实测没有返回结果';
    var parts = [out.ok ? '✓ 通过' : '✗ 不通过'];
    if (out.ms) parts.push('耗时 ' + (out.ms / 1000).toFixed(1) + ' 秒');
    if (out.provider) parts.push('提供方 ' + out.provider);
    if (out.audio_ms) parts.push('音频 ' + (out.audio_ms / 1000).toFixed(1) + ' 秒');
    if (out.bytes) parts.push(Math.max(1, Math.round(out.bytes / 1024)) + ' KB');
    if (out.spoke) parts.push('说「' + out.spoke + '」');
    if (out.heard != null) parts.push('听成「' + (out.heard || '空') + '」');
    if (out.error) parts.push(out.error);
    var line = parts.join(' · ');
    if (out.note) line += '（' + out.note + '）';
    return line;
  }

  M.sheets.backendInlineForm = function (S, d) {
    var voice = S.voice || {};
    var box = el('div', 'backend-form');

    if (d.write_via === 'config') {
      var optLabels = { custom: '自定义中转站（复用 LLM 服务的地址和密钥）' };
      var opts = [['', '不指定（内核默认）']].concat((d.options || []).filter(function (o) { return o !== ''; }).map(function (o) { return [o, optLabels[o] || o]; }));
      var sel = select(opts, d.provider);
      box.append(field('来源', sel));

      // 图像生成走「自定义中转站」时，地址和密钥全部复用 LLM 服务里已经配好的那份 ——
      // 这张卡只负责挑「用哪个服务」和「用哪些图像模型」。
      var linkSel = null;
      if (d.key === 'image_gen') {
        var det = d.detail || {};
        var all = (S.catalog && S.catalog.providers) || [];
        var extraBox = el('div', 'backend-form');

        /* 已勾的候选按顺序存，[0] 就是默认模型。老配置只有单条 model，
           回落到它，否则一打开编辑看着像"一个都没配"。 */
        var picked = (det.targets || []).map(function (t) {
          return { provider_id: t.provider_id || '', model: t.model || '' };
        }).filter(function (t) { return t.model; });
        if (!picked.length && det.model) picked = [{ provider_id: det.provider_id || '', model: det.model }];

        linkSel = select(
          [['', '不用（走插件自己的密钥）']].concat(all.map(function (p) {
            return [p.id, (p.name || '未命名服务') + ' — ' + (p.base_url || '无地址')];
          })),
          det.provider_id || ''
        );
        extraBox.append(field('用哪把密钥', linkSel,
          '地址和密钥都复用这个 LLM 服务，不在这里重填。下面候选已跨服务聚合，这里只决定手填的模型挂到哪个服务'));

        var modelBox = el('div', 'imgmodels');
        var modelField = field('生图模型', modelBox,
          '所有服务保存过的模型都在这里，可以跨服务多选；圆点选中的那个是默认，对话面板的「能力 · 图像生成」用的就是它');
        extraBox.append(modelField);

        function providerModels(pid) {
          var hit = all.filter(function (x) { return x.id === pid; })[0];
          if (!hit) return [];
          var seen = {};
          return ((hit.models || []).map(function (m) {
            return typeof m === 'string' ? m : (m.id || m.name || '');
          })).filter(function (v) {
            if (!v || seen[v]) return false;
            seen[v] = 1;
            return true;
          });
        }
        /* 跨服务聚合候选（2026-11-17 用户要求「多选应该跨供应商也可以」）。
           以前只列 linkSel 选中那一个服务的 models，等于把「多选」锁死在单服务里，
           想同时勾 A 服务的 gpt-image-2 和 B 服务的 nano-banana 根本做不到。
           现在把所有已保存服务商的模型平铺出来，每行标出它来自哪家；
           勾中时记住自己的 provider_id，保存写进 image_gen.targets 就是多服务数组。
           linkSel 退化成「手填的模型归到哪个服务」，不再限制候选范围。 */
        function allCandidates() {
          var out = [];
          var seen = {};
          all.forEach(function (p) {
            providerModels(p.id).forEach(function (mid) {
              var k = (p.id || '') + '\u0000' + mid;
              if (seen[k]) return;
              seen[k] = 1;
              out.push({ provider_id: p.id || '', model: mid,
                         pname: p.name || p.id || '未命名服务' });
            });
          });
          /* 已勾但不在任何服务模型表里的（手填的、或那个服务被删了）
             也得列出来 —— 否则勾上之后就再也取消不掉，只能去改配置文件。 */
          picked.forEach(function (t) {
            var k = (t.provider_id || '') + '\u0000' + t.model;
            if (seen[k]) return;
            seen[k] = 1;
            var hp = all.filter(function (x) { return x.id === t.provider_id; })[0];
            out.push({ provider_id: t.provider_id || '', model: t.model,
                       pname: hp ? (hp.name || hp.id) : (t.provider_id || '手填') });
          });
          return out;
        }
        /* 判重必须带上 provider_id：不同服务可能有同名模型（各家都叫 gpt-image-2），
           只比模型名会把两家当成同一个，勾一个另一个跟着亮。 */
        function isPicked(pid, mid) {
          return picked.some(function (t) {
            return t.model === mid && (t.provider_id || '') === (pid || '');
          });
        }

        /* 勾选区每次整块重画：数量少、状态只有"勾没勾"和"谁是默认"两种，
           用不着精细 diff，重画反而不会留下指向旧节点的闭包。 */
        function renderModels() {
          modelBox.textContent = '';
          var cands = allCandidates();
          if (!cands.length) {
            modelBox.append(el('p', 'mini',
              '还没有任何服务保存过模型。先去「LLM 服务商」加一条，或在下面手动补。'));
            return;
          }
          cands.forEach(function (c) {
            var on = isPicked(c.provider_id, c.model);
            var row = el('div', 'imgmodel-row' + (on ? ' on' : ''));
            var cb = el('input');
            cb.type = 'checkbox';
            cb.className = 'imgmodel-cb';
            cb.checked = on;
            cb.onchange = function () {
              if (cb.checked) {
                if (!isPicked(c.provider_id, c.model)) {
                  picked.push({ provider_id: c.provider_id, model: c.model });
                }
              } else {
                picked = picked.filter(function (t) {
                  return !(t.model === c.model && (t.provider_id || '') === c.provider_id);
                });
              }
              renderModels();
            };
            var name = el('span', 'imgmodel-name', c.model);
            var srcTag = el('span', 'imgmodel-src', c.pname);
            var isDef = on && picked[0] && picked[0].model === c.model &&
                        (picked[0].provider_id || '') === c.provider_id;
            var rd = el('input');
            rd.type = 'radio';
            rd.className = 'imgmodel-rd';
            rd.name = 'img_default_target';
            rd.title = '设为默认';
            rd.disabled = !on;
            rd.checked = isDef;
            rd.onchange = function () {
              if (!on) return;
              // 默认 = 挪到数组第一项，保存时后端照这个顺序写进 custom.model
              picked = [{ provider_id: c.provider_id, model: c.model }].concat(
                picked.filter(function (t) {
                  return !(t.model === c.model && (t.provider_id || '') === c.provider_id);
                }));
              renderModels();
            };
            row.append(cb, name, srcTag, rd);
            /* 「默认」只标在真正是默认的那一行。以前每行都印「默认」，
               未勾的也印 —— 一眼看过去像三个都是默认。 */
            if (isDef) row.append(el('span', 'imgmodel-tag', '默认'));
            else if (on) row.append(el('span', 'imgmodel-tag', '设为默认'));
            modelBox.append(row);
          });
        }

        /* 手动补一个：gpt-image-2 这种模型并不在 provider 的 models 列表里
           （它只借用那个服务的地址和密钥），实测踩过，所以必须留口。 */
        var manualI = input('', '不在上面？手填模型 ID，例如 gpt-image-2');
        var manualBtn = btn('加入', 'btn sm', function () {
          var mid = (manualI.value || '').trim();
          if (!mid) return;
          if (!isPicked(mid)) picked.push({ provider_id: linkSel.value, model: mid });
          manualI.value = '';
          renderModels();
        });
        var manualRow = el('div', 'imgmodel-manual');
        manualRow.append(manualI, manualBtn);
        // 挂在 modelBox 外面：renderModels() 每次都把 modelBox 清空重画，
        // 挂里面的话点一次"加入"自己就被抹掉了（输到一半的文本也一起没）。
        extraBox.append(manualRow);

        linkSel.onchange = renderModels;
        renderModels();
        box.append(extraBox);
        /* 只有来源选了「自定义中转站」才谈得上"用哪把密钥、用哪些模型"。
           别的来源是插件自己带 key，这三行在那种情况下纯属噪音。 */
        var syncCustom = function () {
          extraBox.style.display = sel.value === 'custom' ? '' : 'none';
        };
        sel.onchange = syncCustom;
        syncCustom();
      }

      var saveBtn = btn('保存', 'btn sm primary', async function () {
        saveBtn.disabled = true;
        saveBtn.textContent = '写入中…';
        var payload = { action: 'save_backend', domain: d.key, provider: sel.value, revision: (S.backends || {}).revision };
        if (d.key === 'image_gen' && sel.value === 'custom' && linkSel) {
          /* targets 的顺序就是优先级，第一项是默认模型 —— 后端照这个顺序同时写
             image_gen.targets（画板下拉/新建面板读它）和 custom.provider_id+model
             （内核真正读的那一个）。两边不写齐就会出现「面板勾了 A，实际还在用 B」。
             **每条 target 带自己的 provider_id，不许再统一覆盖成 linkSel 的值**：
             2026-11-17 之前就是那句覆盖，把「勾了跨服务的两个模型」写成了
             两个都指向同一个服务 —— 用户点的跨服务多选等于白点。 */
          var tgt = picked.map(function (t) {
            return { provider_id: t.provider_id || '', model: t.model };
          }).filter(function (t) { return t.model; });
          var head = tgt[0] || { provider_id: linkSel.value || '', model: '' };
          payload.extras = {
            provider_id: head.provider_id,
            model: head.model,
            targets: tgt
          };
        }
        await M.mutate(payload,
          { done: d.label + ' 来源已改为 ' + (sel.value || '默认'), body: '写入 ' + d.path });
        M.closeSheet();
      });
      box.append(saveBtn);

    } else if (d.write_via === 'voice') {
      var section = d.key;
      var v = voice[section] || {};
      var vopts = (v.options || []).map(function (o) { return [o[0], o[1]]; });
      var vsel = select(vopts, v.provider);
      box.append(field('提供方', vsel));
      var langI = null;
      if (d.key === 'stt') {
        langI = input(v.language || '', '识别语言（如 zh，留空自动）');
        box.append(field('识别语言', langI));
      }

      /* command 类提供方（本机声纹克隆那种）的参数就在这张卡上改。
         以前这里只写一句「去语音页的详细编辑里改」，等于把「能力后端能配」说成了空话。 */
      var provBox = null, cmdI = null, fmtSel = null, toI = null, maxI = null;
      function providerRow() {
        var rows = (v.providers || []).filter(function (r) { return r.name === vsel.value; });
        return rows[0] || null;
      }
      function syncProviderFields() {
        if (!provBox) return;
        var row = providerRow();
        var isCommand = !!(row && (row.type || 'command') === 'command');
        provBox.style.display = isCommand ? '' : 'none';
        if (isCommand) {
          cmdI.value = row.command || '';
          fmtSel.value = row.output_format || 'mp3';
          toI.value = row.timeout == null ? '' : String(row.timeout);
          maxI.value = row.max_text_length == null ? '' : String(row.max_text_length);
        }
      }
      if (d.key === 'tts') {
        provBox = el('div', 'backend-form');
        cmdI = input('', '合成命令，{input_path} {output_path} 两个占位符必留');
        fmtSel = select([['mp3', 'mp3'], ['wav', 'wav'], ['opus', 'opus'], ['flac', 'flac'],
                         ['ogg', 'ogg'], ['aac', 'aac'], ['pcm', 'pcm']], 'mp3');
        toI = input('', '超时秒数（5–1800）');
        maxI = input('', '单次文本上限（50–20000）');
        provBox.append(field('合成命令', cmdI, '跑什么程序把文本变成音频'));
        provBox.append(field('输出格式', fmtSel));
        provBox.append(field('超时（秒）', toI));
        provBox.append(field('单次文本上限', maxI));
        box.append(provBox);
        vsel.onchange = syncProviderFields;
        syncProviderFields();
      }

      var vsave = btn('保存', 'btn sm primary', async function () {
        vsave.disabled = true;
        vsave.textContent = '写入中…';
        var changes = { provider: vsel.value };
        if (d.key === 'stt') changes.language = (langI.value || '').trim();
        if (d.key === 'tts') {
          var row = providerRow();
          if (row && (row.type || 'command') === 'command') {
            var entry = { command: (cmdI.value || '').trim(), output_format: fmtSel.value };
            var timeout = parseInt(toI.value, 10);
            if (!isNaN(timeout)) entry.timeout = timeout;
            var maxLen = parseInt(maxI.value, 10);
            if (!isNaN(maxLen)) entry.max_text_length = maxLen;
            changes.providers = {};
            changes.providers[row.name] = entry;
          }
        }
        await M.voiceMutate({ section: section, revision: voice.revision, changes: changes },
          { done: d.label + ' 已保存', body: '写入 ' + d.path });
        M.closeSheet();
      });
      box.append(vsave);

      /* 实测：真合成一句 / 真转写一遍。这就是「只能通过前端实证」那条要求的落点 ——
         配完当场看见耗时和识别结果，不用再跑到别的页面或命令行去验证。 */
      var probeOut = el('p', 'mini', '');
      var probeBtn = btn('实测', 'btn sm', async function () {
        probeBtn.disabled = true;
        probeBtn.textContent = '实测中…';
        probeOut.className = 'mini';
        probeOut.textContent = d.key === 'tts'
          ? '正在真合成一句，约 5–20 秒…'
          : '正在合成一句再转写回来，约 15–40 秒…';
        try {
          var out = await M.voiceTest({ section: section });
          probeOut.textContent = describeProbe(out);
          probeOut.className = 'mini ' + (out.ok ? 'ok' : 'bad');
        } catch (error) {
          probeOut.textContent = '实测没能发起：' + error.message;
          probeOut.className = 'mini bad';
        } finally {
          probeBtn.disabled = false;
          probeBtn.textContent = '实测';
        }
      });
      box.append(probeBtn);
      box.append(probeOut);

      if (d.key === 'tts') {
        var emoModel = (v && v.emo_model) || 'deepseek-chat';
        box.append(el('p', 'mini', 'Windows IndexTTS 的情绪判定模型：' + emoModel + '（WINDOWS_TTS_EMO_MODEL，.env 可改）。'));
      }

    } else if (d.write_via === 'auxiliary') {
      var task = ((S.aux && S.aux.tasks) || []).filter(function (t) { return t.key === 'vision'; })[0];
      if (!task) {
        box.append(el('p', 'mini', '没找到视觉任务'));
      } else {
        /* 字段和提交体都来自 buildAuxEditor —— 跟弹层版 slot 是同一份代码，
           以前这里又抄了一遍（连 timeout 空串规则都抄），改一处漏一处的温床。 */
        var ed = buildAuxEditor(S, task);
        box.append(field('来源', ed.providerSel, 'auto 表示跟主模型走'));
        box.append(field('模型', ed.modelSel));
        box.append(field('独立端点（可选）', ed.baseInput));
        box.append(field('超时（秒）', ed.timeoutInput));
        var asave = btn('保存', 'btn sm primary', async function () {
          asave.disabled = true;
          asave.textContent = '写入中…';
          await M.auxMutate({ key: task.key, revision: task.revision, changes: ed.changes() },
            { done: task.label + ' 已更新' });
          M.closeSheet();
        });
        box.append(asave);
      }
    }
    return box;
  };

  /* ── 能力后端 · 编辑弹层（2026-11-17）────────────────────
     卡片外层只留摘要，能改的东西全收进这里。
     表单本体仍然用 backendInlineForm —— 那套代码没有一条逻辑依赖"内联"，
     只是原先被塞在卡片里；挪进 sheet.body 一行都不用改，voice / auxiliary
     两个分支也就跟着一起搬进来了，不会出现"编辑框只改好了 config 那类"。 */
  M.sheets.backendEdit = function (S, d) {
    var sheet = M.sheet({
      title: d.label || d.key,
      sub: (d.path || '') + (d.kernel === false ? ' · 内核不读这一节，选项只留个记录' : ''),
      wide: true
    });
    /* 「这张卡的选项内核不读」从卡片外层搬进来（2026-11-17 用户原话：
       这个元素把卡片撑开了，放到打开编辑后的面板里去）。
       放在弹层第一屏最显眼的位置 —— 用户点开就是想改它，
       先看到这句才不会以为换个引擎就真换了 OCR。 */
    if (d.kernel === false) {
      var warn = el('div', 'cardwarn');
      warn.append(el('b', null, '这张卡的选项内核不读'));
      warn.append(el('div', 'mini', d.note || ''));
      sheet.body.append(warn);
    }
    if (M.credBlock) {
      var creds = M.credBlock(S, d);
      if (creds) sheet.body.append(creds);
    }
    var form = M.sheets.backendInlineForm(S, d);
    if (form) sheet.body.append(form);
    return sheet;
  };

  M.sheets.backendSwap = function (S, d) {
    /* 有专用编辑器的两个域：直接把人送到那个编辑器，不在这里造第二个写入口 */
    if (d.write_via === 'voice') {
      var vSheet = M.sheet({ title: d.label, sub: '语音配置（stt / tts）· 写入走 /api/panel-models/voice' });
      var voice = S.voice || {};
      var current = d.key === 'stt' ? (voice.stt || {}) : (voice.tts || {});
      vSheet.body.append(panel('当前', [
        kvRow('provider', current.provider || d.provider || '—'),
        kvRow('language', current.language || '—'),
        kvRow('输出格式', current.output_format || '—')
      ]));
      vSheet.body.append(el('p', 'mini', '语音配置有独立的完整编辑器（含 provider 命令、参数、语言），' +
        '这里再放一个下拉框就会有两处写同一份配置。下面是它支持的全部 provider。'));
      var chipRow = el('div', 'chips');
      (d.options || []).forEach(function (name) { chipRow.append(chip(name, true)); });
      vSheet.body.append(chipRow);
      vSheet.foot.append(btn('关闭', 'btn', M.closeSheet));
      vSheet.foot.append(btn('打开语音编辑器', 'btn primary', function () {
        M.closeSheet();
        M.sheets.voiceEditor && M.sheets.voiceEditor(S);
      }));
      return;
    }

    if (d.write_via === 'auxiliary') {
      var task = ((S.aux && S.aux.tasks) || []).filter(function (t) { return t.key === 'vision'; })[0];
      if (task) { M.sheets.slot(S, task); return; }
      M.toast('没找到视觉任务', '辅助模型里没有 vision 这一项', 'bad');
      return;
    }

    if (!d.writable) {
      var ro = M.sheet({ title: d.label, sub: d.path });
      ro.body.append(el('p', 'mini', d.note || '没有独立配置项'));
      ro.body.append(el('p', 'mini', 'OCR 走服务商原生能力，生图走 image_gen 工具集开关。' +
        '硬塞一个下拉框只会让人以为改了有用。'));
      ro.foot.append(btn('知道了', 'btn primary', M.closeSheet));
      return;
    }

    /* config 类：真写 config.yaml */
    var sheet = M.sheet({ title: '换来源 · ' + d.label, sub: '写入 ' + d.path });
    var options = (d.options || []).filter(function (o) { return o !== ''; });
    var picked = d.provider;
    var host = el('div');
    options.forEach(function (name) {
      var opt = btn('', 'bigopt' + (name === picked ? ' on' : ''), function () {
        picked = name;
        host.querySelectorAll('.bigopt').forEach(function (node) { node.classList.remove('on'); });
        opt.classList.add('on');
      });
      opt.append(el('span', 'bo'));
      var box = el('span');
      box.append(el('span', 'bt mono', name));
      box.append(el('span', 'bd', '内核接受的取值'));
      opt.append(box);
      host.append(opt);
    });
    var auto = btn('', 'bigopt' + (picked === '' ? ' on' : ''), function () {
      picked = '';
      host.querySelectorAll('.bigopt').forEach(function (node) { node.classList.remove('on'); });
      auto.classList.add('on');
    });
    auto.append(el('span', 'bo'));
    var abox = el('span');
    abox.append(el('span', 'bt', '不指定'));
    abox.append(el('span', 'bd', '从配置里删掉这个键，回到内核默认'));
    auto.append(abox);
    host.prepend(auto);
    sheet.body.append(host);

    sheet.foot.append(btn('取消', 'btn', M.closeSheet));
    sheet.foot.append(btn('保存', 'btn primary', async function () {
      M.closeSheet();
      await M.mutate({
        action: 'save_backend', domain: d.key, provider: picked, revision: (S.backends || {}).revision
      }, { done: d.label + ' 来源已改为 ' + (picked || '默认'), body: '写入 ' + d.path });
    }));
  };

  /* ── 9. 自定义来源 ────────────────────────────────── */
  M.sheets.backendCustom = function (S) {
    var domains = (S.backends && S.backends.domains) || [];
    var sheet = M.sheet({ title: '来源清单', sub: '每个能力域内核接受哪些来源', wide: true });
    sheet.body.append(el('p', 'mini', '自定义来源不是随便填一个名字：内核只认每个域自己那组取值，' +
      '写别的会被当成未知来源。下面是当前所有域可选的来源，点一个直接切过去。'));
    domains.forEach(function (d) {
      if (!d.writable || !d.options || !d.options.length) return;
      var lb = el('div', 'lb', d.label);
      lb.append(el('span', 'mono', d.path));
      sheet.body.append(lb);
      var row = el('div', 'chips');
      d.options.forEach(function (name) {
        var text = name === '' ? '默认' : name;
        var c = btn(text, 'chip' + (d.provider === name ? ' pri' : ''), async function () {
          M.closeSheet();
          await M.mutate({
            action: 'save_backend', domain: d.key, provider: name, revision: (S.backends || {}).revision
          }, { done: d.label + ' 来源已改为 ' + (name || '默认') });
        });
        c.style.cursor = 'pointer';
        row.append(c);
      });
      sheet.body.append(row);
    });
    sheet.foot.append(btn('关闭', 'btn', M.closeSheet));
  };

  /* ── 10. 能力详情 ─────────────────────────────────── */
  M.sheets.backendDetail = function (S, d) {
    var sheet = M.sheet({ title: d.label, sub: d.path + ' · ' + d.status });
    var rows = [
      kvRow('当前来源', d.provider || '未设置'),
      kvRow('状态', d.status),
      kvRow('写入通道', d.write_via === 'config' ? '本页直写 config.yaml'
        : d.write_via === 'voice' ? '语音编辑器（/api/panel-models/voice）'
        : d.write_via === 'auxiliary' ? '辅助模型编辑器（/api/panel-models/auxiliary）'
        : '没有独立配置项'),
      kvRow('可选来源', (d.options || []).join(' / ') || '—')
    ];
    Object.keys(d.detail || {}).forEach(function (key) {
      var value = d.detail[key];
      if (value === '' || value === null || value === undefined) return;
      rows.push(kvRow(key, typeof value === 'object' ? JSON.stringify(value) : String(value)));
    });
    sheet.body.append(panel('', rows));
    if (d.note) sheet.body.append(el('p', 'mini', d.note));
    sheet.foot.append(btn('关闭', 'btn', M.closeSheet));
    if (d.writable) {
      sheet.foot.append(btn('换来源', 'btn primary', function () {
        M.closeSheet();
        M.sheets.backendSwap(S, d);
      }));
    }
  };

  /* ── 11. 写入 config.yaml ─────────────────────────── */
  M.sheets.configWrite = function (S) {
    var preview = S.preview || {};
    var text = preview.text || '';
    var sheet = M.sheet({ title: '写入 config.yaml', sub: '整份替换 · 三道校验不过就不写', wide: true });

    var area = el('textarea', 'textarea');
    area.value = text;
    area.rows = 22;
    area.spellcheck = false;
    area.style.width = '100%';
    area.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, monospace';
    area.style.fontSize = '12px';

    sheet.body.append(el('p', 'mini', '预览里的密钥是 ****（已隐藏）掩码。原样写回会把掩码当真实值写进配置，' +
      '所以这里要先点「载入全文再编辑」拿到可编辑版本，或者整段替换成你自己写的内容。' +
      '服务里的 api_key 只接受 ${变量名} 这种写法，粘明文会被拒绝——真值一律放 .env。'));
    var hint = el('div', 'errline');
    sheet.body.append(area, hint);

    sheet.foot.append(btn('取消', 'btn', M.closeSheet));
    sheet.foot.append(btn('载入全文', 'btn sm', async function () {
      try {
        var out = await M.api({ action: 'config_preview', raw: true });
        if (out.text && out.text.indexOf('****（已隐藏）') < 0) {
          area.value = out.text;
          M.toast('已载入', '这份是未脱敏原文，写完会原样落盘');
        } else {
          hint.textContent = '服务端仍返回脱敏文本，无法安全编辑；请直接粘贴你自己写的完整 YAML';
        }
      } catch (error) {
        hint.textContent = '载入失败：' + error.message;
      }
    }));
    sheet.foot.append(btn('写入', 'btn primary', async function () {
      var body = area.value;
      if (!body.trim()) { hint.textContent = '内容为空'; return; }
      if (body.indexOf('****（已隐藏）') >= 0) {
        hint.textContent = '还带着掩码，写进去会把密钥变成星号。先删掉掩码行或整段替换。';
        return;
      }
      M.closeSheet();
      await M.mutate({
        action: 'config_write', text: body, revision: (S.preview || {}).revision
      }, { done: 'config.yaml 已写入', body: '已通过解析、映射、model 段三道校验' });
      S.preview = null;
      await M.load(['preview']);
      M.render();
    }));
  };

  /* ── 12. 添加回退候选 ───────────────────────────────── */
  M.sheets.fallbackAdd = function (S) {
    var rows = modelOptions(S);
    var sheet = M.sheet({ title: '加一条备用', sub: 'fallback_providers · 主模型失败时的降级顺序' });
    if (!rows.length) {
      sheet.body.append(el('div', 'empty', '没有可用的模型服务，先去「服务商」加一个'));
      sheet.foot.append(btn('知道了', 'btn primary', M.closeSheet));
      return;
    }
    var picked = null;
    groupBySource(rows).forEach(function (group) {
      var wrap = el('div', 'srcgroup');
      var lb = el('div', 'lb', group.title);
      if (group.sub) lb.append(el('span', 'src mono', group.sub));
      if (!group.multi && group.keys[0].label && group.keys[0].label !== group.title) {
        lb.append(el('span', 'ktag', group.keys[0].label));
      }
      if (group.multi) lb.append(el('span', 'kcount', group.keys.length + ' 把密钥'));
      wrap.append(lb);
      group.keys.forEach(function (key) {
        var kb = group.multi ? el('div', 'keysub') : wrap;
        if (group.multi) kb.append(el('div', 'ksec', key.label || key.name || '未命名密钥'));
        key.rows.forEach(function (row) {
          var opt = btn('', 'bigopt', function () {
            picked = { provider: row.provider, model: row.model };
            sheet.body.querySelectorAll('.bigopt').forEach(function (n) { n.classList.remove('on'); });
            opt.classList.add('on');
          });
          opt.append(el('span', 'bo'));
          var box = el('span');
          box.append(el('span', 'bt mono', row.model));
          var sub = subOf(row);
          if (sub) box.append(el('span', 'bd', sub));
          opt.append(box);
          kb.append(opt);
        });
        if (group.multi) wrap.append(kb);
      });
      sheet.body.append(wrap);
    });
    sheet.foot.append(btn('取消', 'btn', M.closeSheet));
    sheet.foot.append(btn('添加', 'btn primary', function () {
      if (!picked) { M.toast('没选模型', '先挑一个候选', 'bad'); return; }
      var chain = (S.catalog.fallbacks || []).map(function (f) { return { key: f.key }; });
      chain.push({ provider: picked.provider, model: picked.model });
      M.closeSheet();
      M.mutate({ action: 'fallback', entries: chain, revision: (S.catalog || {}).revision },
        { done: '已加备用 ' + picked.model, body: '追加到 fallback_providers 末尾' });
    }));
  };

  /* ── 13. 配置 MOA 预设 ──────────────────────────────── */
  M.sheets.moaEdit = function (S, preset) {
    var moa = S.moa || {};
    var candidates = moa.candidates || [];
    var p = preset || { name: (moa.default_preset || 'default') };
    var sheet = M.sheet({ title: '组合回答配置', sub: 'moa.presets.' + (p.name || ''), wide: true });
    var nameI = input(p.name || '', '预设名（字母数字下划线）');
    var enabled = !!moa.enabled && moa.active_preset === p.name;

    var allModels = [];
    candidates.forEach(function (c) {
      (c.models || []).forEach(function (m) {
        allModels.push({ provider: c.id, providerName: c.name, model: m.id });
      });
    });

    var refPicked = {};
    (p.reference_models || []).forEach(function (r) { refPicked[r.provider + '|' + r.model] = true; });
    var refList = el('div', 'picklist');
    allModels.forEach(function (m) {
      var key = m.provider + '|' + m.model;
      var row = el('label', 'checkline');
      var box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = !!refPicked[key];
      box.onchange = function () { refPicked[key] = box.checked; };
      row.append(box);
      row.append(el('span', null, m.providerName + ' / ' + m.model));
      refList.append(row);
    });

    var aggSel = select([['', '（选聚合模型）']].concat(allModels.map(function (m) {
      return [m.provider + '|' + m.model, m.providerName + ' / ' + m.model];
    })), ((p.aggregator && (p.aggregator.provider + '|' + p.aggregator.model)) || ''));

    var enableBox = document.createElement('input');
    enableBox.type = 'checkbox';
    enableBox.checked = enabled;

    sheet.body.append(field('预设名', nameI, '', true));
    sheet.body.append(field('聚合模型', aggSel, '汇总各参考模型的输出，作为最终回答', true));
    sheet.body.append(sec('参考模型（1-8 个）', '并行打给这些模型，再交给聚合模型汇总'));
    sheet.body.append(refList);
    var toggleLine = el('label', 'checkline');
    toggleLine.append(enableBox);
    toggleLine.append(el('span', null, '立即启用这个预设（不勾则只保存不切换）'));
    sheet.body.append(toggleLine);
    var err = el('div', 'errline');
    sheet.body.append(err);

    sheet.foot.append(btn('取消', 'btn', M.closeSheet));
    sheet.foot.append(btn('保存', 'btn primary', function () {
      var name = nameI.value.trim();
      var agg = aggSel.value;
      if (!name || !/^[A-Za-z0-9_-]{1,40}$/.test(name)) { err.textContent = '预设名只能用字母、数字、下划线，最多 40 字'; return; }
      if (name.toLowerCase() === 'moa') { err.textContent = '预设名不能叫 moa'; return; }
      if (!agg) { err.textContent = '要选聚合模型'; return; }
      var refs = allModels.filter(function (m) { return refPicked[m.provider + '|' + m.model]; }).map(function (m) { return { provider: m.provider, model: m.model }; });
      if (refs.length < 1 || refs.length > 8) { err.textContent = '参考模型要选 1 到 8 个'; return; }
      var aggParts = agg.split('|');
      var aggregator = { provider: aggParts[0], model: aggParts[1] };
      if (refs.some(function (r) { return r.provider === aggregator.provider && r.model === aggregator.model; })) {
        err.textContent = '聚合模型不能同时作为参考模型'; return;
      }
      M.closeSheet();
      M.mutate({
        action: 'moa_save', revision: moa.moa_revision,
        preset: name, enabled: enableBox.checked,
        reference_models: refs, aggregator: aggregator
      }, { done: 'MOA 预设已保存', body: enableBox.checked ? '主模型切到聚合模型' : '只保存预设，不切换' });
    }));
  };

  /* ── 14. 能力实测 ───────────────────────────────────── */
  M.sheets.capRun = function (S, cap) {
    var sheet = M.sheet({ title: '实测 · ' + (cap.label || cap.id), sub: (cap.id || '') + ' · 真发一次请求', wide: true });
    sheet.body.append(el('p', 'mini', '正在请求 ' + (cap.desc || '') + ' …'));
    M.api({ action: 'cap_run', cap: cap.id }).then(function (out) {
      sheet.body.replaceChildren();
      sheet.body.append(panel('结果', [
        kvRow('状态', out.ok ? (out.status || '通过') : '失败'),
        kvRow('耗时', (out.ms || 0) + ' ms'),
        kvRow('标题', out.headline || '—')
      ]));
      (out.lines || []).forEach(function (line) {
        sheet.body.append(el('p', 'mini', String(line)));
      });
      if (out.preview) sheet.body.append(el('div', 'code', String(out.preview).slice(0, 2000)));
    }).catch(function (error) {
      sheet.body.replaceChildren(el('div', 'errline', '实测失败：' + error.message));
    });
    sheet.foot.append(btn('关闭', 'btn primary', M.closeSheet));
  };

  /* ── 15. 添加密钥 ───────────────────────────────────── */
  M.sheets.keyAdd = function (S) {
    var sheet = M.sheet({ title: '添加密钥', sub: '.env · 环境变量' });
    var nameI = input('', '例如 DEEPSEEK_API_KEY');
    var valueI = input('', 'sk-…', 'password');
    sheet.body.append(field('变量名', nameI, '大写字母数字下划线', true));
    sheet.body.append(field('值', valueI, '写入 .env，config 里用 ${变量名} 引用', true));
    var err = el('div', 'errline');
    sheet.body.append(err);
    sheet.foot.append(btn('取消', 'btn', M.closeSheet));
    sheet.foot.append(btn('保存', 'btn primary', function () {
      var name = nameI.value.trim();
      var value = valueI.value.trim();
      if (!name || !/^[A-Z][A-Z0-9_]{2,63}$/.test(name)) { err.textContent = '变量名要大写开头，字母数字下划线，3-64 位'; return; }
      if (!value) { err.textContent = '值不能为空'; return; }
      M.closeSheet();
      M.mutate({ action: 'save_key', name: name, value: value, revision: (S.keys || {}).revision },
        { done: '已写入 ' + name, body: '写入 .env，config 里用 ${' + name + '} 引用' });
    }));
  };

  /* ── 15b. 改一个已有密钥的值 ────────────────────────── */
  // 只改值，不给改变量名：config.yaml 里 ${VAR} 引用着它，改名字得连 config
  // 一起改，改一半就是「面板显示已配置、跑起来 401」。要换名字就走「添加密钥」
  // 建新变量，再去服务商卡里把引用换过去。
  M.sheets.keyEdit = function (S, row) {
    var sheet = M.sheet({ title: row.label || row.name, sub: '只改值 · 变量名不动' });
    var valueI = input('', row.configured ? '已配置，留空则不改' : 'sk-…', 'password');
    // 变量名不给输入框：给了就等于暗示能改，改完 config 里那条 ${} 就悬空了。
    sheet.body.append(field('变量名', el('span', 'mono kfixed', row.name),
      'config 里用 ${' + row.name + '} 引用；要换名字得连 config 一起改，所以这里只读'));
    sheet.body.append(field('值', valueI, '写入 .env，不回显原值', true));
    if (row.used_by && row.used_by.length) {
      sheet.body.append(el('p', 'mini', '这条被 ' + row.used_by.join('、') + ' 引用。'));
    }
    (row.orphans || []).forEach(function (why) {
      sheet.body.append(el('div', 'errline', why));
    });
    var err = el('div', 'errline');
    sheet.body.append(err);
    sheet.foot.append(btn('取消', 'btn', M.closeSheet));
    sheet.foot.append(btn('保存', 'btn primary', function () {
      var value = valueI.value.trim();
      if (!value) { err.textContent = '值不能为空'; return; }
      M.closeSheet();
      M.mutate({ action: 'save_key', name: row.name, value: value, revision: (S.keys || {}).revision },
        { done: '已更新 ' + (row.label || row.name), body: '写入 .env 的 ' + row.name });
    }));
  };

  /* ── 16. 语音编辑器（接 /api/panel-models/voice） ────── */
  M.sheets.voiceEditor = function (S) {
    var voice = S.voice || {};
    var tts = voice.tts || {};
    var stt = voice.stt || {};
    var sheet = M.sheet({ title: '语音编辑器', sub: 'stt / tts · 独立配置段 · 写 config.yaml', wide: true });

    sheet.body.append(sec('TTS 语音合成', 'tts.provider · 下一条消息起生效'));
    var ttsOpts = (tts.options || []).map(function (o) { return [o[0], o[1]]; });
    var ttsSel = select(ttsOpts, tts.provider);
    sheet.body.append(field('当前提供方', ttsSel));
    var ttsProviders = tts.providers || [];
    if (ttsProviders.length) {
      sheet.body.append(panel('已注册提供方（' + ttsProviders.length + '）',
        ttsProviders.map(function (p) {
          return kvRow(p.name + '（' + (p.type || 'command') + '）', (p.command || '').slice(0, 80) || '—');
        })));
    }
    sheet.body.append(el('p', 'mini', '自定义 command 提供方的命令、输出格式、超时在旧语音页编辑；这里切当前 provider。'));

    sheet.body.append(sec('STT 语音转写', 'stt.provider'));
    var sttOpts = (stt.options || []).map(function (o) { return [o[0], o[1]]; });
    var sttSel = select(sttOpts, stt.provider);
    sheet.body.append(field('当前提供方', sttSel));
    var langI = input(stt.language || '', '识别语言（如 zh，留空自动）');
    sheet.body.append(field('识别语言', langI));

    sheet.foot.append(btn('关闭', 'btn', M.closeSheet));
    sheet.foot.append(btn('保存 TTS', 'btn sm primary', function () {
      M.closeSheet();
      M.voiceMutate({ section: 'tts', revision: voice.revision, changes: { provider: ttsSel.value } },
        { done: 'TTS 已切到 ' + ttsSel.value, body: '写入 tts.provider' });
    }));
    sheet.foot.append(btn('保存 STT', 'btn sm primary', function () {
      M.closeSheet();
      M.voiceMutate({ section: 'stt', revision: voice.revision, changes: { provider: sttSel.value, language: langI.value.trim() } },
        { done: 'STT 已保存', body: '写入 stt.provider / stt.language' });
    }));
  };

  function kvRow(k, v) {
    var row = el('div', 'kv');
    row.append(el('span', null, k));
    var b = el('b');
    b.append(el('span', 'mini', String(v)));
    row.append(b);
    return row;
  }
})();
