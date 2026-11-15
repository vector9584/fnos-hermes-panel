/* 模型页 · 六域渲染
 * 每个域一个函数，统一签名 render(S) -> 一个 DOM 元素。
 * 只读 S（状态）并调用 MV2.go / MV2.sheets 里的动作，不直接 fetch。
 */
(function () {
  'use strict';
  var MV2 = window.MV2;
  if (!MV2) return;
  var el = MV2.el, btn = MV2.btn, badge = MV2.badge, chip = MV2.chip,
      sec = MV2.sec, input = MV2.input, select = MV2.select, S_ = MV2.S;

  function sheet(name) { return (MV2.sheets && MV2.sheets[name]) || null; }
  function call(name, a, b) {
    var fn = sheet(name);
    if (!fn) { MV2.toast('这个操作还没接上', true); return; }
    return fn(a, b);
  }

  /* ── 通用小件 ───────────────────────────────────────── */
  function tabs(pairs, active, pick) {
    var bar = el('div', 'mv2-tabs');
    pairs.forEach(function (pair) {
      var node = btn(pair[1], 'mv2-tab' + (pair[0] === active ? ' on' : ''), function () { pick(pair[0]); });
      bar.append(node);
    });
    return bar;
  }

  /* 域内不放 h1：顶部 page-header 的标题由 panel-navigation 的 applyTitle 统一管，
     两处都写会互相覆盖。这里只留一行说明。 */
  function domainHead(title, desc, actions) {
    var box = el('div', 'mv2-domain-head');
    var left = el('div');
    if (desc) left.append(el('p', 'mv2-desc', desc));
    box.append(left);
    if (actions && actions.length) {
      var right = el('div', 'mv2-head-acts');
      actions.forEach(function (node) { if (node) right.append(node); });
      box.append(right);
    }
    return box;
  }

  function sectionHead(node, right) {
    var head = el('div', 'mv2-sec-head');
    var holder = el('div', 'mv2-right');
    (right || []).forEach(function (item) { if (item) holder.append(item); });
    head.append(holder);
    node.prepend(head);
    return head;
  }

  function providerOf(S, id) {
    var key = String(id || '').replace(/^custom:/, '');
    return ((S.catalog && S.catalog.providers) || []).filter(function (row) { return row.id === key; })[0] || null;
  }

  function providerLabel(S, id) {
    var hit = providerOf(S, id);
    return hit ? hit.name : String(id || '').replace(/^custom:/, '') || '—';
  }

  function empty(text) { return el('div', 'mv2-empty', text); }

  function stat(value, label, hint) {
    var box = el('div', 'mv2-stat');
    box.append(el('b', null, String(value)));
    box.append(el('span', null, label));
    if (hint) box.append(el('span', 'mv2-hint', hint));
    return box;
  }

  function quick(title, desc, run) {
    var node = btn('', 'mv2-quick', run);
    node.append(el('b', null, title));
    node.append(el('span', null, desc));
    return node;
  }

  function chainRow(label, rows) {
    var box = el('div', 'mv2-chain');
    box.append(el('div', 'mv2-chain-title', label));
    if (!rows.length) { box.append(el('div', 'mv2-chain-row', '—')); return box; }
    rows.forEach(function (row, index) {
      var line = el('div', 'mv2-chain-row');
      if (index) line.append(el('span', 'mv2-arrow', '↓'));
      line.append(el('b', null, row[0]));
      if (row[1]) line.append(el('span', null, row[1]));
      box.append(line);
    });
    return box;
  }

  /* ── 概览 ───────────────────────────────────────────── */
  function renderHome(S) {
    var catalog = S.catalog || {};
    var providers = catalog.providers || [];
    var primary = catalog.primary || {};
    var fallbacks = catalog.fallbacks || [];
    var aux = (S.aux && S.aux.tasks) || [];
    var auxOwn = aux.filter(function (row) { return row.provider && row.provider !== 'auto'; });
    var voice = S.voice || {};
    var backends = (S.backends && S.backends.domains) || [];
    var toolsets = S.toolsets || {};
    var caps = (S.caps && S.caps.caps) || [];
    var primaryProvider = providerOf(S, primary.provider);
    var wrap = el('div', 'mv2-shell');

    wrap.append(domainHead('模型总览',
      '所有对话默认走主模型，主模型报错或额度用完才按回退链往下换。下面三张链路卡分别是出站推理、出站能力和入站接口。'));

    var hero = el('div', 'mv2-hero');
    var top = el('div', 'mv2-hero-top');
    top.append(el('span', 'mv2-hero-label', '当前主模型'));
    if (primaryProvider) top.append(badge(primaryProvider.enabled ? '启用中' : '已停用', primaryProvider.enabled ? 'ok' : 'bad'));
    if (fallbacks.length) top.append(badge('回退 ' + fallbacks.length + ' 级'));
    if (auxOwn.length) top.append(badge('辅助单独指定 ' + auxOwn.length));
    hero.append(top);
    hero.append(el('div', 'mv2-hero-model', primary.model || '还没有设置主模型'));
    var meta = el('div', 'mv2-hero-meta');
    meta.append(chip(primaryProvider ? primaryProvider.name : (primary.provider || '—')));
    if (primaryProvider && primaryProvider.base_url) meta.append(chip(primaryProvider.base_url));
    if (primaryProvider && primaryProvider.api_mode) meta.append(chip(primaryProvider.api_mode));
    hero.append(meta);
    var foot = el('div', 'mv2-hero-foot');
    foot.append(btn('换主模型', 'mv2-btn primary', function () { call('mainSwitch'); }));
    foot.append(btn('回退链', 'mv2-btn', function () { MV2.go('select', 'fallback'); }));
    foot.append(btn('验证能力', 'mv2-btn', function () { MV2.go('backends', 'caps'); }));
    hero.append(foot);
    wrap.append(hero);

    var stats = el('div', 'mv2-stats');
    stats.append(stat(providers.filter(function (row) { return row.enabled; }).length + ' / ' + providers.length, 'LLM 服务商', '启用 / 全部'));
    stats.append(stat(auxOwn.length + ' / ' + aux.length, '辅助任务单独指定', '其余跟随主模型'));
    stats.append(stat(backends.filter(function (row) { return row.provider; }).length + ' / ' + (backends.length || 5), '能力后端已指定', '语音与视觉走各自的编辑器'));
    stats.append(stat(toolsets.follow_default ? '默认' : (toolsets.count_enabled || 0), '启用工具集', toolsets.follow_default ? '跟随平台默认' : '显式清单'));
    wrap.append(stats);

    var quickGrid = el('div', 'mv2-quick-grid');
    quickGrid.append(quick('换主模型', primary.model || '未设置', function () { call('mainSwitch'); }));
    quickGrid.append(quick('添加模型服务', providers.length + ' 个服务', function () { call('providerNew'); }));
    quickGrid.append(quick('验证能力落点', caps.length ? caps.length + ' 项可测' : '读取中', function () { MV2.go('backends', 'caps'); }));
    quickGrid.append(quick('密钥与工具集', (S.keys && S.keys.keys ? S.keys.keys.length : 0) + ' 个变量', function () { MV2.go('providers', 'keys'); }));
    wrap.append(quickGrid);

    var chains = el('div', 'mv2-chain-grid');
    chains.append(chainRow('出站推理', [[primary.model || '未设置', primaryProvider ? primaryProvider.name : '']].concat(
      fallbacks.map(function (row) { return [row.model, providerLabel(S, row.provider)]; }))));
    var speech = [];
    if (voice.stt) speech.push(['语音转写', voice.stt.provider + (voice.stt.enabled ? '' : '（已关闭）')]);
    if (voice.tts) speech.push(['语音合成', voice.tts.provider]);
    var vision = aux.filter(function (row) { return row.key === 'vision'; })[0];
    if (vision) speech.push(['视觉理解', (vision.model || vision.provider || '跟随主模型')]);
    backends.forEach(function (row) { if (row.provider) speech.push([row.label, row.provider]); });
    chains.append(chainRow('出站能力', speech));
    var inbound = [];
    if (voice.openai_api) {
      inbound.push(['OpenAI 兼容端点', voice.openai_api.base_url || ('端口 ' + voice.openai_api.port)]);
      inbound.push(['状态', voice.openai_api.reachable ? '可访问' : '不可访问']);
    } else {
      inbound.push(['OpenAI 兼容端点', '读取中']);
    }
    chains.append(chainRow('入站接口', inbound));
    wrap.append(chains);
    return wrap;
  }

  /* ── 模型选择 ───────────────────────────────────────── */
  function renderSelect(S) {
    var tab = S.tab.select || 'main';
    var wrap = el('div', 'mv2-shell');
    wrap.append(domainHead('模型选择',
      '主模型只有一个，辅助任务可以各指各的。回退链决定主模型失效时谁来接，组合回答让多个模型同时答再由聚合模型收口。'));
    wrap.append(tabs([['main', '主与辅助'], ['fallback', '回退链'], ['moa', '组合回答']], tab, function (key) { MV2.go('select', key); }));
    var pane = el('div', 'mv2-pane on');
    if (tab === 'fallback') pane.append(paneFallback(S));
    else if (tab === 'moa') pane.append(paneMoa(S));
    else pane.append(paneMain(S));
    wrap.append(pane);
    return wrap;
  }

  function paneMain(S) {
    var catalog = S.catalog || {};
    var primary = catalog.primary || {};
    var tasks = (S.aux && S.aux.tasks) || [];
    var box = el('div');
    box.style.display = 'flex';
    box.style.flexDirection = 'column';
    box.style.gap = '14px';

    var main = sec('主模型', '所有对话默认走这里。换主模型会同时改掉当前服务与模型。');
    var mainBody = el('div', 'mv2-kv');
    var row1 = el('div', 'mv2-kv-row');
    row1.append(el('span', 'mv2-kv-k', '服务商'), el('span', 'mv2-kv-v', providerLabel(S, primary.provider)));
    var row2 = el('div', 'mv2-kv-row');
    row2.append(el('span', 'mv2-kv-k', '模型'), el('span', 'mv2-kv-v', primary.model || '未设置'));
    var row3 = el('div', 'mv2-kv-row');
    row3.append(el('span', 'mv2-kv-k', '回退'), el('span', 'mv2-kv-v', (catalog.fallbacks || []).length + ' 级'));
    mainBody.append(row1, row2, row3);
    main.append(mainBody);
    var mainFoot = el('div', 'mv2-sec-head');
    var mainRight = el('div', 'mv2-right');
    mainRight.append(btn('换主模型', 'mv2-btn primary', function () { call('mainSwitch'); }));
    mainFoot.append(mainRight);
    main.append(mainFoot);
    box.append(main);

    var slots = sec('十一个旁路任务', '不指定就跟着主模型走。选了具体服务与模型之后，这类任务固定用那一个，不再跟随主模型切换。');
    var grid = el('div', 'mv2-slots');
    tasks.forEach(function (task) {
      var node = btn('', 'mv2-slot', function () { call('slotEdit', task.key); });
      node.append(el('div', 'mv2-slot-name', task.label || task.key));
      var own = task.provider && task.provider !== 'auto';
      node.append(el('div', 'mv2-slot-model', own ? (task.model || task.provider) : '跟随主模型'));
      var state = el('div', 'mv2-slot-state');
      state.append(own ? badge('单独指定', 'pri') : badge('继承'));
      if (task.fallback_chain && task.fallback_chain.length) state.append(chip('回退 ' + task.fallback_chain.length));
      if (own && !task.credential_set) state.append(badge('缺密钥', 'warn'));
      node.append(state);
      grid.append(node);
    });
    if (!tasks.length) grid.append(empty('辅助任务还没读出来'));
    slots.append(grid);
    var slotHead = el('div', 'mv2-sec-head');
    var slotRight = el('div', 'mv2-right');
    slotRight.append(btn('批量分配', 'mv2-btn', function () { call('bulkAssign'); }));
    slotHead.append(slotRight);
    slots.append(slotHead);
    box.append(slots);
    return box;
  }

  function paneFallback(S) {
    var catalog = S.catalog || {};
    var chain = catalog.fallbacks || [];
    var box = el('div');
    box.style.display = 'flex';
    box.style.flexDirection = 'column';
    box.style.gap = '14px';

    var list = sec('候选顺序', '主模型报错、超时或额度用完时，从上到下依次尝试。顺序就是优先级。');
    var body = el('div');
    if (!chain.length) body.append(empty('还没有回退模型。主模型一挂，对话就直接失败。'));
    chain.forEach(function (row, index) {
      var line = el('div', 'mv2-modelrow');
      line.append(badge(String(index + 1), 'pri'));
      line.append(el('span', 'mv2-mn', row.model));
      line.append(chip(providerLabel(S, row.provider)));
      if (row.has_overrides) line.append(chip('带覆盖参数'));
      var right = el('div', 'mv2-right');
      right.append(btn('↑', 'mv2-btn sm', function () { moveFallback(S, index, -1); }));
      right.append(btn('↓', 'mv2-btn sm', function () { moveFallback(S, index, 1); }));
      right.append(btn('移除', 'mv2-btn sm danger', function () { removeFallback(S, index); }));
      line.append(right);
      body.append(line);
    });
    list.append(body);
    var head = el('div', 'mv2-sec-head');
    var right = el('div', 'mv2-right');
    right.append(btn('添加备用模型', 'mv2-btn primary', function () { call('fallbackAdd'); }));
    head.append(right);
    list.append(head);
    box.append(list);

    var policy = sec('触发口径与三层韧性', '这三层是内核的真实行为，面板只展示，不提供开关。');
    var kv = el('div', 'mv2-kv');
    [['第 1 层 · 单次重试', '同一个模型临时抖动，按请求超时重试，不换模型'],
     ['第 2 层 · 回退链', '重试仍失败就换下一个模型，整段对话不重放，避免工具重复执行'],
     ['第 3 层 · 全部失败', '回退链走完仍然失败，把最后一次的真实错误返回给你'],
     ['触发条件', '连接失败、超时、限流、服务商报错、额度耗尽'],
     ['不触发', '你在聊天里手动选的模型（会话级覆盖）优先于主模型']].forEach(function (pair) {
      var row = el('div', 'mv2-kv-row');
      row.append(el('span', 'mv2-kv-k', pair[0]), el('span', 'mv2-kv-v', pair[1]));
      kv.append(row);
    });
    policy.append(kv);
    box.append(policy);
    return box;
  }

  function moveFallback(S, index, delta) {
    var chain = ((S.catalog && S.catalog.fallbacks) || []).slice();
    var target = index + delta;
    if (target < 0 || target >= chain.length) return;
    var moved = chain.splice(index, 1)[0];
    chain.splice(target, 0, moved);
    MV2.mutate({
      action: 'fallback', revision: S.catalog.revision,
      entries: chain.map(function (row) { return { key: row.key, provider: row.provider, model: row.model }; })
    }, { done: '回退顺序已保存' });
  }

  function removeFallback(S, index) {
    var chain = ((S.catalog && S.catalog.fallbacks) || []).slice();
    chain.splice(index, 1);
    MV2.mutate({
      action: 'fallback', revision: S.catalog.revision,
      entries: chain.map(function (row) { return { key: row.key, provider: row.provider, model: row.model }; })
    }, { done: '已从回退链移除' });
  }

  function paneMoa(S) {
    var moa = S.moa || { presets: [] };
    var box = el('div');
    box.style.display = 'flex';
    box.style.flexDirection = 'column';
    box.style.gap = '14px';

    var head = sec('组合回答（MOA）',
      '几个模型各答一遍，再让聚合模型挑或合成。成本和延迟都按模型数量翻倍，默认不开。');
    var status = el('div', 'mv2-sec-head');
    status.append(badge(moa.enabled ? '已启用' : '未启用', moa.enabled ? 'ok' : ''));
    if (moa.active_preset) status.append(chip('当前预设 ' + moa.active_preset));
    head.append(status);

    var body = el('div');
    (moa.presets || []).forEach(function (preset) {
      var card = el('div', 'mv2-modelrow');
      card.append(el('span', 'mv2-mn', preset.name));
      card.append(chip('参考 ' + (preset.reference_models || []).length));
      card.append(chip('聚合 ' + (preset.aggregator && preset.aggregator.model ? preset.aggregator.model : '未设置')));
      if (preset.name === moa.active_preset) card.append(badge('生效中', 'ok'));
      var right = el('div', 'mv2-right');
      right.append(btn('编辑', 'mv2-btn sm', function () { call('moaEdit', preset.name); }));
      card.append(right);
      body.append(card);
    });
    if (!(moa.presets || []).length) body.append(empty('还没有组合回答预设'));
    head.append(body);

    var foot = el('div', 'mv2-sec-head');
    var right = el('div', 'mv2-right');
    right.append(btn('新建预设', 'mv2-btn primary', function () { call('moaEdit', null); }));
    foot.append(right);
    head.append(foot);

    var cost = sec('成本落点', '开启后每个请求都会走 N 个参考模型加 1 个聚合模型，token 按 N+1 计。');
    var kv = el('div', 'mv2-kv');
    [['参考模型', (moa.presets || []).map(function (row) { return (row.reference_models || []).length; }).join(' / ') || '—'],
     ['聚合模型', (moa.presets || []).map(function (row) { return row.aggregator ? row.aggregator.model : '—'; }).join(' / ') || '—'],
     ['生效方式', '切换主模型到 moa://local 虚拟服务，回退链不再参与']].forEach(function (pair) {
      var row = el('div', 'mv2-kv-row');
      row.append(el('span', 'mv2-kv-k', pair[0]), el('span', 'mv2-kv-v', pair[1]));
      kv.append(row);
    });
    cost.append(kv);
    box.append(head, cost);
    return box;
  }

  /* ── 服务商 ─────────────────────────────────────────── */
  function renderProviders(S) {
    var tab = S.tab.providers || 'llm';
    var wrap = el('div', 'mv2-shell');
    wrap.append(domainHead('服务商',
      '一家服务一条卡片。地址、密钥、这家能提供哪些模型、接口协议都在卡片里。停用只是暂时不参与选择，不删配置。'));
    wrap.append(tabs([['llm', 'LLM 服务'], ['keys', '密钥'], ['chat', '对话内能力']], tab, function (key) { MV2.go('providers', key); }));
    var pane = el('div', 'mv2-pane on');
    if (tab === 'keys') pane.append(paneKeys(S));
    else if (tab === 'chat') pane.append(paneChatTools(S));
    else pane.append(paneLlm(S));
    wrap.append(pane);
    return wrap;
  }

  function paneLlm(S) {
    var providers = (S.catalog && S.catalog.providers) || [];
    var box = el('div');
    box.style.display = 'flex';
    box.style.flexDirection = 'column';
    box.style.gap = '14px';
    var grid = el('div', 'mv2-pgrid');
    providers.forEach(function (provider) {
      var card = el('div', 'mv2-pcard' + (provider.enabled ? '' : ' off'));
      var top = el('div', 'mv2-pcard-top');
      top.append(el('div', 'mv2-emblem', (provider.name || '?').slice(0, 1).toUpperCase()));
      var idBox = el('div', 'mv2-pcard-id');
      idBox.append(el('div', 'mv2-pcard-name', provider.name || provider.id));
      idBox.append(el('div', 'mv2-pcard-url', provider.base_url || '未填地址'));
      top.append(idBox);
      card.append(top);

      var mid = el('div', 'mv2-pcard-mid');
      mid.append(provider.enabled ? badge('启用', 'ok') : badge('已停用', 'bad'));
      mid.append(chip((provider.models || []).filter(function (m) { return m.enabled; }).length + ' 个模型'));
      if (provider.api_mode) mid.append(chip(provider.api_mode));
      mid.append(provider.api_key_configured ? badge('密钥已配', 'ok') : badge('缺密钥', 'warn'));
      card.append(mid);
      if (provider.origin === 'custom_providers') card.append(chip('旧式配置（只读投影）'));

      var foot = el('div', 'mv2-pcard-foot');
      foot.append(btn('模型', 'mv2-btn sm', function () { call('providerModels', provider.id); }));
      foot.append(btn('编辑', 'mv2-btn sm', function () { call('providerEdit', provider.id); }));
      foot.append(btn(provider.enabled ? '停用' : '启用', 'mv2-btn sm', function () {
        MV2.mutate({ action: 'toggle', id: provider.id, enabled: !provider.enabled, revision: S.catalog.revision },
          { done: provider.enabled ? '已停用' : '已启用' });
      }));
      foot.append(btn('删除', 'mv2-btn sm danger', function () { call('providerDelete', provider.id); }));
      card.append(foot);
      grid.append(card);
    });
    var add = btn('', 'mv2-pcard', function () { call('providerNew'); });
    add.style.alignItems = 'center';
    add.style.justifyContent = 'center';
    add.style.minHeight = '186px';
    add.style.borderStyle = 'dashed';
    var plus = el('div', 'mv2-hero-model', '+');
    plus.style.fontSize = '26px';
    plus.style.color = 'var(--muted)';
    add.append(plus, el('div', 'mv2-pcard-name', '添加模型服务'));
    add.append(el('div', 'mv2-pcard-url', '四步：选类型 → 填地址密钥 → 探测模型 → 完成'));
    grid.append(add);
    box.append(grid);
    return box;
  }

  function paneKeys(S) {
    var data = S.keys || { keys: [] };
    var box = el('div');
    box.style.display = 'flex';
    box.style.flexDirection = 'column';
    box.style.gap = '14px';
    var head = sec('环境变量密钥',
      '密钥只从 .env 读，面板不显示明文、不写明文。这里看的是变量名、是否已设置、末四位，以及被哪些服务引用。');
    var list = el('div', 'mv2-tlist');
    (data.keys || []).forEach(function (row) {
      var line = el('div', 'mv2-trow');
      line.append(el('span', 'mv2-tname', row.name));
      line.append(el('span', 'mv2-tdesc', (row.used_by || []).join('、')));
      var right = el('div', 'mv2-right');
      if (row.configured) {
        right.append(badge(row.source === 'inline' ? '配置内明文' : '已设置', row.source === 'inline' ? 'warn' : 'ok'));
        if (row.hint) right.append(chip(row.hint));
      } else {
        right.append(badge('未设置', 'bad'));
      }
      line.append(right);
      list.append(line);
    });
    if (!(data.keys || []).length) list.append(empty('没有读到密钥引用'));
    head.append(list);
    head.append(el('p', 'mv2-hint', '变量文件：' + (data.env_file || '.env') + '（共 ' + (data.env_count || 0) + ' 个变量）'));
    box.append(head);

    var tip = sec('怎么改', '面板不提供改 .env 的入口，避免密钥经由浏览器或日志落地。');
    tip.append(el('p', 'mv2-hint',
      '新增服务时，地址与模型在「LLM 服务」里配；密钥名填在这里引用的变量名（例如 CUSTOM_XXXX_API_KEY），值由你在 NAS 上写进 .env。'));
    box.append(tip);
    return box;
  }

  function paneChatTools(S) {
    var providers = (S.catalog && S.catalog.providers) || [];
    var box = el('div');
    box.style.display = 'flex';
    box.style.flexDirection = 'column';
    box.style.gap = '14px';
    var head = sec('对话内能力',
      '这些参数透传到每次请求体，属于「这家服务商支持什么」而不是「我们这边开什么」。写进对应服务的 extra_body。');
    var list = el('div', 'mv2-tlist');
    var seen = 0;
    providers.forEach(function (provider) {
      var extra = provider.request_extra || {};
      Object.keys(extra).forEach(function (key) {
        seen++;
        var line = el('div', 'mv2-trow');
        line.append(el('span', 'mv2-tname', provider.name));
        line.append(el('span', 'mv2-tdesc', key + ' = ' + JSON.stringify(extra[key])));
        var right = el('div', 'mv2-right');
        right.append(btn('修改', 'mv2-btn sm', function () { call('providerEdit', provider.id); }));
        line.append(right);
        list.append(line);
      });
    });
    if (!seen) list.append(empty('还没有任何服务设置请求扩展参数。到「LLM 服务 → 编辑 → 请求扩展参数」里加。'));
    head.append(list);

    var known = sec('可以放什么', '以下键在服务商侧有实际语义，写在 extra_body 里会透传到请求体顶层。');
    var kv = el('div', 'mv2-kv');
    [['thinking', '深度思考开关，DeepSeek 系用它控制是否返回 reasoning_content'],
     ['reasoning_effort', '思考强度，一般 low / medium / high'],
     ['safety_check', '内容安全审查开关，部分中转服务支持'],
     ['title', '会话标题相关参数'],
     ['tools', '被面板硬拒绝：它会整体冲掉 agent 自己的工具数组']].forEach(function (pair) {
      var row = el('div', 'mv2-kv-row');
      row.append(el('span', 'mv2-kv-k', pair[0]), el('span', 'mv2-kv-v', pair[1]));
      kv.append(row);
    });
    known.append(kv);
    box.append(head, known);
    return box;
  }

  /* ── 能力后端 ───────────────────────────────────────── */
  function renderBackends(S) {
    var tab = S.tab.backends || 'all';
    var wrap = el('div', 'mv2-shell');
    wrap.append(domainHead('能力后端',
      '模型之外的八种能力各自走谁：语音、视觉、搜索、抓取、浏览器、识别、生图。有些没有独立配置，就如实标成跟随服务商。'));
    wrap.append(tabs([['all', '全部域'], ['caps', 'DeepSeek 落点']], tab, function (key) { MV2.go('backends', key); }));
    var pane = el('div', 'mv2-pane on');
    if (tab === 'caps') pane.append(paneCaps(S));
    else pane.append(paneBackendCards(S));
    wrap.append(pane);
    return wrap;
  }

  function paneBackendCards(S) {
    var voice = S.voice || {};
    var aux = (S.aux && S.aux.tasks) || [];
    var extras = (S.backends && S.backends.domains) || [];
    var byKey = {};
    extras.forEach(function (row) { byKey[row.key] = row; });
    var vision = aux.filter(function (row) { return row.key === 'vision'; })[0];

    var rows = [];
    rows.push({ key: 'stt', label: '语音转写', provider: voice.stt ? (voice.stt.provider + (voice.stt.enabled ? '' : '（已关闭）')) : '读取中',
      detail: voice.stt ? ('语言 ' + (voice.stt.language || '自动')) : '', source: 'voice' });
    rows.push({ key: 'tts', label: '语音合成', provider: voice.tts ? voice.tts.provider : '读取中',
      detail: voice.tts ? (voice.tts.providers || []).length + ' 个提供方' : '', source: 'voice' });
    rows.push({ key: 'vision', label: '视觉理解',
      provider: vision ? (vision.provider === 'auto' ? '跟随主模型' : (vision.model || vision.provider)) : '读取中',
      detail: vision && vision.fallback_chain ? '回退 ' + vision.fallback_chain.length : '', source: 'aux' });
    ['web_search', 'web_extract', 'browser'].forEach(function (key) {
      var row = byKey[key];
      if (row) rows.push({ key: key, label: row.label, provider: row.provider || '自动', detail: '', source: 'extras', writable: row.writable, options: row.options });
    });
    rows.push({ key: 'ocr', label: '文字识别', provider: '跟随服务商原生', detail: '没有独立配置项', source: 'follow' });
    rows.push({ key: 'image_gen', label: '图像生成', provider: '跟随工具集', detail: '由 image_gen 工具集开关控制', source: 'follow' });

    var box = el('div');
    box.style.display = 'flex';
    box.style.flexDirection = 'column';
    box.style.gap = '14px';
    var grid = el('div', 'mv2-bgrid');
    rows.forEach(function (row) {
      var card = el('div', 'mv2-bcard');
      var top = el('div', 'mv2-bcard-top');
      top.append(el('div', 'mv2-bcard-name', row.label));
      if (row.source === 'follow') top.append(badge('跟随', ''));
      card.append(top);
      card.append(el('div', 'mv2-bcard-src', row.provider || '未指定'));
      if (row.detail) card.append(el('div', 'mv2-hint', row.detail));
      var foot = el('div', 'mv2-bcard-foot');
      if (row.source === 'voice') {
        foot.append(btn('换来源', 'mv2-btn sm', function () { MV2.go('providers', 'llm'); MV2.toast('语音来源在下方详情里改'); }));
        foot.append(btn('详情', 'mv2-btn sm', function () { call('backendVoice', row.key); }));
      } else if (row.source === 'aux') {
        foot.append(btn('换来源', 'mv2-btn sm', function () { call('slotEdit', 'vision'); }));
      } else if (row.source === 'extras') {
        foot.append(btn('换来源', 'mv2-btn sm', function () { call('backendCfg', row.key); }));
      } else {
        foot.append(badge('无独立开关', ''));
      }
      card.append(foot);
      grid.append(card);
    });
    box.append(grid);

    var note = sec('为什么只有五张卡能改',
      '语音、视觉、搜索、抓取、浏览器在内核里各有独立配置段，改了立刻生效。文字识别与图像生成没有独立后端配置——它们走服务商原生能力或工具集开关，硬塞一个下拉框只会让人以为改了就生效。');
    note.append(el('p', 'mv2-hint', '入站接口（把本机当模型给别的程序调）在概览页的「入站接口」链路里，状态由语音配置服务统一读取。'));
    box.append(note);
    return box;
  }

  function paneCaps(S) {
    var caps = (S.caps && S.caps.caps) || [];
    var providers = (S.caps && S.caps.providers) || [];
    var box = el('div');
    box.style.display = 'flex';
    box.style.flexDirection = 'column';
    box.style.gap = '14px';
    var head = sec('DeepSeek 落点',
      '这一页不是配置，是验证：每张卡点下去，服务端会用这条服务的密钥真发一次请求，回来的是服务商的真实返回。密钥不出服务端。');
    var bar = el('div', 'mv2-sec-head');
    var picker = select(providers.map(function (row) { return [row.id, row.name + (row.enabled ? '' : '（停用）')]; }), S.capProvider || (providers[0] && providers[0].id));
    picker.id = 'mv2CapProvider';
    picker.style.maxWidth = '240px';
    picker.onchange = function () { S.capProvider = picker.value; };
    bar.append(picker);
    var right = el('div', 'mv2-right');
    var bulk = btn('全部跑一遍', 'mv2-btn primary', function () { runAllCaps(S, picker.value); });
    right.append(bulk);
    bar.append(right);
    head.append(bar);

    var grid = el('div', 'mv2-bgrid');
    caps.forEach(function (cap) {
      var card = el('div', 'mv2-bcard');
      var top = el('div', 'mv2-bcard-top');
      top.append(el('div', 'mv2-bcard-name', cap.label));
      top.append(badge(cap.needs === 'file' ? '需文件' : '联网', ''));
      card.append(top);
      card.append(el('div', 'mv2-hint', cap.desc));
      var out = el('div', 'mv2-hint', '');
      out.id = 'mv2CapOut-' + cap.id;
      var foot = el('div', 'mv2-bcard-foot');
      foot.append(btn('运行', 'mv2-btn sm', function () { runCap(S, picker.value, cap, out); }));
      card.append(out, foot);
      grid.append(card);
    });
    if (!caps.length) grid.append(empty('能力清单还没读出来'));
    head.append(grid);
    box.append(head);
    return box;
  }

  async function runCap(S, providerId, cap, out) {
    if (!providerId) { MV2.toast('先选一个服务商', true); return; }
    out.textContent = '运行中…';
    try {
      var result = await MV2.api({ action: 'cap_run', cap: cap.id, provider: providerId });
      var body = result.result || result;
      var text = typeof body === 'string' ? body : JSON.stringify(body);
      out.textContent = (result.ok === false ? '失败：' : '通过：') + text.slice(0, 220);
      out.style.color = result.ok === false ? 'var(--danger)' : 'var(--success-text)';
    } catch (error) {
      out.textContent = '失败：' + error.message;
      out.style.color = 'var(--danger)';
    }
  }

  async function runAllCaps(S, providerId) {
    if (!providerId) { MV2.toast('先选一个服务商', true); return; }
    var caps = (S.caps && S.caps.caps) || [];
    var pass = 0, fail = 0, skip = 0;
    for (var i = 0; i < caps.length; i++) {
      var cap = caps[i];
      var out = document.getElementById('mv2CapOut-' + cap.id);
      if (!out) continue;
      out.textContent = '运行中…';
      out.style.color = '';
      try {
        var result = await MV2.api({ action: 'cap_run', cap: cap.id, provider: providerId });
        var body = result.result || result;
        var text = typeof body === 'string' ? body : JSON.stringify(body);
        if (result.ok === false && /需要|缺少|跳过/.test(text)) {
          skip++;
          out.textContent = '跳过：' + text.slice(0, 160);
          out.style.color = 'var(--muted)';
        } else if (result.ok === false) {
          fail++;
          out.textContent = '失败：' + text.slice(0, 160);
          out.style.color = 'var(--danger)';
        } else {
          pass++;
          out.textContent = '通过：' + text.slice(0, 160);
          out.style.color = 'var(--success-text)';
        }
      } catch (error) {
        fail++;
        out.textContent = '失败：' + error.message;
        out.style.color = 'var(--danger)';
      }
    }
    MV2.toast(pass + ' 通过 / ' + fail + ' 失败 / ' + skip + ' 跳过', fail > 0);
  }

  /* ── 工具集 ─────────────────────────────────────────── */
  function renderToolsets(S) {
    var data = S.toolsets || { toolsets: [], platforms: [] };
    var box = el('div', 'mv2-shell');
    box.append(domainHead('工具集',
      '工具集决定 agent 手里有什么工具。真源是 platform_toolsets.<平台>，不是顶层的 toolsets 键。没有显式清单时跟随平台默认。'));

    var bar = sec('平台', '每个平台各自一份清单。改哪个平台就只影响哪个平台。');
    var row = el('div', 'mv2-sec-head');
    var picker = select((data.platforms || ['api_server']).map(function (name) { return [name, name]; }), data.platform);
    picker.style.maxWidth = '220px';
    picker.onchange = async function () {
      await MV2.load(['toolsets']);
      var out = await MV2.api({ action: 'toolsets', platform: picker.value });
      S.toolsets = out;
      MV2.render();
    };
    row.append(picker);
    var right = el('div', 'mv2-right');
    if (data.follow_default) right.append(badge('跟随平台默认 · ' + data.default_name, 'pri'));
    else right.append(badge('显式清单 ' + (data.count_enabled || 0) + ' 项', 'ok'));
    row.append(right);
    bar.append(row);
    if (!data.follow_default) {
      bar.append(btn('恢复平台默认', 'mv2-btn sm', function () {
        MV2.mutate({ action: 'save_toolsets', platform: data.platform, follow_default: true, revision: data.revision },
          { done: '已恢复平台默认' });
      }));
    }
    box.append(bar);

    var list = sec('工具集开关', data.follow_default
      ? '当前跟随平台默认，下面的勾选只是参考。改动任意一项会写成显式清单。'
      : '改动即写入 platform_toolsets.' + data.platform + '，下一条消息生效。');
    var tlist = el('div', 'mv2-tlist');
    (data.toolsets || []).forEach(function (row2) {
      var line = el('div', 'mv2-trow');
      line.append(el('span', 'mv2-tname', row2.name));
      line.append(el('span', 'mv2-tdesc', row2.plugin ? '插件工具集' : (row2.disabled ? '在黑名单里' : '')));
      var right2 = el('div', 'mv2-right');
      if (row2.disabled) right2.append(badge('已禁用', 'bad'));
      var toggle = el('input', 'mv2-switch');
      toggle.type = 'checkbox';
      toggle.checked = !!row2.enabled;
      toggle.onchange = function () { toggleToolset(S, row2.name, toggle.checked); };
      right2.append(toggle);
      line.append(right2);
      tlist.append(line);
    });
    list.append(tlist);
    box.append(list);

    var gateway = sec('工具网关与安全边界', '这两项真的会影响行为，改完下一条消息生效。');
    var kv = el('div', 'mv2-kv');
    Object.keys(data.gateway || {}).forEach(function (key) {
      var row3 = el('div', 'mv2-kv-row');
      row3.append(el('span', 'mv2-kv-k', key), el('span', 'mv2-kv-v', JSON.stringify(data.gateway[key])));
      kv.append(row3);
    });
    var priv = el('div', 'mv2-kv-row');
    priv.append(el('span', 'mv2-kv-k', 'allow_private_urls'));
    var privVal = el('span', 'mv2-kv-v', data.allow_private_urls ? '允许访问私网地址' : '禁止访问私网地址');
    priv.append(privVal);
    var privToggle = el('input', 'mv2-switch');
    privToggle.type = 'checkbox';
    privToggle.checked = !!data.allow_private_urls;
    privToggle.onchange = function () {
      MV2.mutate({ action: 'save_toolsets', platform: data.platform, allow_private_urls: privToggle.checked, revision: data.revision },
        { done: privToggle.checked ? '已允许私网地址' : '已禁止私网地址' });
    };
    var privRight = el('div', 'mv2-right');
    privRight.append(privToggle);
    priv.append(privRight);
    kv.append(priv);
    gateway.append(kv);
    box.append(gateway);
    return box;
  }

  function toggleToolset(S, name, on) {
    var data = S.toolsets || {};
    var enabled = (data.toolsets || []).filter(function (row) {
      return row.name === name ? on : row.enabled;
    }).map(function (row) { return row.name; });
    MV2.mutate({ action: 'save_toolsets', platform: data.platform, enabled: enabled, revision: data.revision },
      { done: name + (on ? ' 已启用' : ' 已停用') });
  }

  /* ── 配置 ───────────────────────────────────────────── */
  function renderConfig(S) {
    var tab = S.tab.config || 'yaml';
    var wrap = el('div', 'mv2-shell');
    wrap.append(domainHead('配置',
      'config.yaml 是唯一真源。这里能看文件原文（密钥已脱敏）和每次写入留下的快照，方便核对与回滚。'));
    wrap.append(tabs([['yaml', 'config.yaml'], ['apply', '生效与写入']], tab, function (key) { MV2.go('config', key); }));
    var pane = el('div', 'mv2-pane on');
    pane.append(tab === 'apply' ? paneApply(S) : paneYaml(S));
    wrap.append(pane);
    return wrap;
  }

  function paneYaml(S) {
    var preview = S.preview;
    var box = el('div');
    box.style.display = 'flex';
    box.style.flexDirection = 'column';
    box.style.gap = '14px';
    if (!preview) { box.append(empty('配置文件还没读出来')); return box; }
    var head = sec(null, null);
    var bar = el('div', 'mv2-sec-head');
    bar.append(el('h3', 'mv2-sec-title', 'config.yaml'));
    bar.append(chip(preview.lines + ' 行'));
    bar.append(chip(preview.bytes + ' 字节'));
    bar.append(badge('密钥已脱敏', 'ok'));
    var right = el('div', 'mv2-right');
    right.append(btn('复制全文', 'mv2-btn sm', async function () {
      try {
        await navigator.clipboard.writeText(preview.text);
        MV2.toast('已复制（密钥处是掩码）');
      } catch (_) { MV2.toast('浏览器不允许写剪贴板', true); }
    }));
    right.append(btn('重新读取', 'mv2-btn sm', async function () {
      await MV2.load(['preview']);
      MV2.render();
      MV2.toast('已重新读取');
    }));
    bar.append(right);
    head.append(bar);

    var code = el('div', 'mv2-code');
    var codeHead = el('div', 'mv2-code-head');
    codeHead.append(el('span', null, 'HERMES_HOME/config.yaml'));
    code.append(codeHead);
    var pre = el('pre', 'mv2-code-body', preview.text);
    code.append(pre);
    head.append(code);
    box.append(head);
    return box;
  }

  function paneApply(S) {
    var audit = S.audit || { snapshots: [] };
    var box = el('div');
    box.style.display = 'flex';
    box.style.flexDirection = 'column';
    box.style.gap = '14px';

    var bound = sec('生效边界', '不同改动的生效时机不一样，这里写清楚，免得以为改了没反应。');
    var kv = el('div', 'mv2-kv');
    [['面板页面读取', '每次请求都新起子进程读文件，改完刷新就生效'],
     ['聊天对话（gateway）', 'gateway 启动时读一次配置，改模型或路线后要重启应用才吃新配置'],
     ['会话级手动选模型', '只存在浏览器 localStorage，不写配置文件，换设备就丢'],
     ['工具集 / 私网开关', '下一条消息生效，不需要重启']].forEach(function (pair) {
      var row = el('div', 'mv2-kv-row');
      row.append(el('span', 'mv2-kv-k', pair[0]), el('span', 'mv2-kv-v', pair[1]));
      kv.append(row);
    });
    bound.append(kv);
    box.append(bound);

    var snaps = sec('写入快照', '每次真正改动 config.yaml 都会留一份带时间戳的副本，回滚就是拿其中一份覆盖回去。');
    var list = el('div', 'mv2-log');
    (audit.snapshots || []).slice(0, 20).forEach(function (row) {
      var line = el('div', 'mv2-log-row');
      line.append(el('b', null, row.id));
      line.append(chip(row.bytes + ' 字节'));
      var when = new Date(row.at * 1000);
      line.append(el('span', null, when.toLocaleString()));
      list.append(line);
    });
    if (!(audit.snapshots || []).length) list.append(empty('还没有快照'));
    snaps.append(list);
    snaps.append(el('p', 'mv2-hint', '目录：' + (audit.directory || '')));
    box.append(snaps);

    var cmd = sec('可复现命令', '想手工核对时用这几条，不用打开面板。');
    var code = el('div', 'mv2-code');
    var codeHead = el('div', 'mv2-code-head');
    codeHead.append(el('span', null, 'shell'));
    code.append(codeHead);
    code.append(el('pre', 'mv2-code-body',
      '# 看当前主模型与回退链\n' +
      "python3 -c \"import yaml;d=yaml.safe_load(open('$HERMES_HOME/config.yaml'));print(d.get('model'));print(d.get('fallback_providers'))\"\n\n" +
      '# 看工具集真源\n' +
      "python3 -c \"import yaml;d=yaml.safe_load(open('$HERMES_HOME/config.yaml'));print(d.get('platform_toolsets'))\"\n\n" +
      '# 列出全部写入快照\n' +
      'ls -lt $TRIM_PKGVAR/panel-state/config-history | head'));
    cmd.append(code);
    box.append(cmd);
    return box;
  }

  MV2.pages = {
    home: renderHome,
    select: renderSelect,
    providers: renderProviders,
    backends: renderBackends,
    toolsets: renderToolsets,
    config: renderConfig
  };
})();
