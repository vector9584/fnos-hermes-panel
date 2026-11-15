/* 模型页 · 六个域的渲染（2026-11-15 第二轮：严格对齐参考稿）
 *
 * 参考稿 DOM（/tmp/cmp/ref/skel/*.txt 是实测导出的骨架）：
 *   home      wrap > hero + sec + quick(qcard×4) + sec + cards(pcard×3)
 *   select    wrap > ph + hero + slots(slotbox×N) + chips
 *   providers wrap > ph + cards(pcard×N + pcard.add) + chips
 *   backends  wrap > ph + 类型筛选 + cards(pcard×N) + sec + chips + panel
 *   toolsets  wrap > ph + split(左 tsgrid + Tool Gateway / 右 安全边界 + 生效)
 *   config    wrap > ph + panel(code)
 *
 * 与第一轮的差别：不再用 mv2-* 类名和分段胶囊页签，全部换成参考稿那套；
 * 每个渲染器返回 DocumentFragment，#mv2Root 本身就是 .wrap。
 */
(function () {
  'use strict';
  var M = window.MV2;
  if (!M) return;
  var el = M.el, btn = M.btn, badge = M.badge, chip = M.chip, dot = M.dot,
      sec = M.sec, ph = M.ph, kv = M.kv, panel = M.panel, code = M.code;

  /* ── 小工具 ─────────────────────────────────────────── */
  function frag() { return document.createDocumentFragment(); }

  function svg(paths, size) {
    var node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    node.setAttribute('viewBox', '0 0 24 24');
    node.setAttribute('fill', 'none');
    node.setAttribute('stroke', 'currentColor');
    node.setAttribute('stroke-width', '1.6');
    node.setAttribute('stroke-linecap', 'round');
    node.setAttribute('stroke-linejoin', 'round');
    node.setAttribute('width', size || 16);
    node.setAttribute('height', size || 16);
    (paths || []).forEach(function (d) {
      var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', d);
      node.append(p);
    });
    return node;
  }

  /* 参考稿图标库：完整 SVG 内层（path/rect/circle），stroke 风格，viewBox 0 0 24 24 */
  function svgIcon(inner, size) {
    var node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    node.setAttribute('viewBox', '0 0 24 24');
    node.setAttribute('fill', 'none');
    node.setAttribute('stroke', 'currentColor');
    node.setAttribute('stroke-width', '1.8');
    node.setAttribute('stroke-linecap', 'round');
    node.setAttribute('stroke-linejoin', 'round');
    node.setAttribute('width', size || 15);
    node.setAttribute('height', size || 15);
    node.innerHTML = inner;
    return node;
  }

  var ICONS = {
    slots:   '<rect x="3" y="3" width="18" height="6" rx="1.5"/><rect x="3" y="10" width="8" height="11" rx="1.5"/><rect x="13" y="10" width="8" height="5" rx="1.5"/><rect x="13" y="16" width="8" height="5" rx="1.5"/>',
    plug:    '<path d="M9 3v6M15 3v6M6 9h12v3a6 6 0 0 1-12 0z"/><path d="M12 18v3"/>',
    cap:     '<path d="M4 5h16v14H4z"/><path d="m8 12 3 3 5-6"/>',
    wrench:  '<path d="M14 6a4 4 0 0 0-5 5L3 17l4 4 6-6a4 4 0 0 0 5-5l-3 3-3-3z"/>',
    mic:     '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
    globe:   '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/>',
    star:    '<path d="m12 3 2.6 5.6 6.1.8-4.5 4.3 1.1 6.1L12 17l-5.3 2.8 1.1-6.1L3.3 9.4l6.1-.8z"/>',
    file:    '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/>',
    volume:  '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>',
    search:  '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>',
    eye:     '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
    image:   '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
    monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>'
  };

  var BACKEND_ICON = {
    stt: 'mic', tts: 'volume', web_search: 'search', web_extract: 'globe',
    vision: 'eye', ocr: 'file', image_gen: 'image', browser: 'monitor'
  };

  var ICON = {
    grid: ['M4 4h7v7H4z', 'M13 4h7v7h-7z', 'M4 13h7v7H4z', 'M13 13h7v7h-7z'],
    server: ['M4 6h16v5H4z', 'M4 13h16v5H4z', 'M7 8.5h.01', 'M7 15.5h.01'],
    cube: ['M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z', 'M12 12l8-4.5', 'M12 12v9', 'M12 12L4 7.5'],
    toggle: ['M8 7h8a5 5 0 010 10H8A5 5 0 018 7z', 'M16 12a3 3 0 11-6 0 3 3 0 016 0'],
    arrows: ['M4 8h11l-3-3', 'M20 16H9l3 3'],
    plug: ['M9 3v6', 'M15 3v6', 'M6 9h12v3a6 6 0 01-12 0V9z', 'M12 18v3']
  };

  function providerName(S, id) {
    var hit = (S.catalog.providers || []).filter(function (p) { return p.id === id; })[0];
    return hit ? hit.name : (id || '');
  }

  function providerOf(S, id) {
    return (S.catalog.providers || []).filter(function (p) { return p.id === id; })[0] || null;
  }

  function emblemOf(name) {
    var text = String(name || '?').replace(/[^A-Za-z0-9\u4e00-\u9fa5]/g, '');
    return (text.slice(0, 2) || '??').toUpperCase();
  }

  function auxTasks(S) {
    return (S.aux && S.aux.tasks) || [];
  }

  function inheritedCount(S) {
    return auxTasks(S).filter(function (t) { return !t.provider || t.provider === 'auto'; }).length;
  }

  function customCount(S) {
    return auxTasks(S).filter(function (t) { return t.provider && t.provider !== 'auto'; }).length;
  }

  function toolsetLabel(name) {
    var map = {
      web: '网页', terminal: '终端', file: '文件', vision: '视觉', memory: '记忆',
      skills: '技能', browser: '浏览器', image_gen: '图像生成', tts: '语音',
      delegation: '委派', cronjob: '定时', messaging: '消息', code_execution: '代码执行',
      clarify: '追问', computer_use: '电脑操作', context_engine: '上下文引擎',
      discord: 'Discord', discord_admin: 'Discord 管理', bfl: 'BFL 图像',
      mcp: 'MCP', kanban: '看板', todo: '待办', session_search: '会话检索',
      stt: '语音转写', video: '视频', audio: '音频', files: '文件管理',
      git: 'Git', shell: 'Shell', http: 'HTTP', sqlite: 'SQLite'
    };
    return map[name] || name;
  }

  /* ── 概览 ───────────────────────────────────────────── */
  M.pages.home = function (S) {
    var out = frag();
    var cat = S.catalog || {};
    var providers = cat.providers || [];
    var primary = cat.primary || {};
    var enabled = providers.filter(function (p) { return p.enabled !== false; }).length;
    var domains = (S.backends && S.backends.domains) || [];
    var writable = domains.filter(function (d) { return d.writable; }).length;
    var toolsets = S.toolsets || {};
    var native = domains.filter(function (d) { return d.write_via === 'config'; }).length;
    var custom = domains.filter(function (d) { return d.write_via === 'none'; }).length;

    /* hero */
    var hero = el('div', 'hero');
    hero.append(el('div', 'lead', '当前'));
    var h2 = el('h2');
    var em = el('em', null, providerName(S, primary.provider) + ' · ' + (primary.model || '—'));
    h2.append(em);
    h2.append(document.createTextNode(' 承担主推理，' + inheritedCount(S) + ' 个辅助槽位继承它。'));
    hero.append(h2);
    var stats = el('div', 'stats');
    [['LLM 服务商', enabled + ' / ' + providers.length],
     ['能力后端', writable + ' / ' + domains.length],
     ['工具集', (toolsets.count_enabled || 0) + ' / ' + (toolsets.count_all || 0)],
     ['原生可配', native + ' 直写 · ' + custom + ' 二改']
    ].forEach(function (pair) {
      var box = el('div');
      box.append(el('small', null, pair[0]));
      box.append(el('b', null, pair[1]));
      stats.append(box);
    });
    hero.append(stats);
    out.append(hero);

    /* 四个配置对象 */
    out.append(sec('四个配置对象'));
    var quick = el('div', 'quick');
    [
      ['slots', '模型选择', '主 / 辅助 / 回退 / 组合', 'select'],
      ['plug', 'LLM 服务商', '推理端点 · 对话内能力', 'providers'],
      ['cap', '能力后端', '语音 / 网页 / 视觉 / OCR', 'backends'],
      ['wrench', '工具集', '开关 · 安全边界', 'toolsets']
    ].forEach(function (row) {
      var card = btn('', 'qcard', function () { M.go(row[3]); });
      var ic = el('span', 'ic');
      ic.append(svgIcon(ICONS[row[0]], 18));
      card.append(ic, el('span', 't', row[1]), el('span', 'd', row[2]), el('span', 'go', '进入 ›'));
      quick.append(card);
    });
    out.append(quick);

    /* 三条链路 */
    var head = sec('链路', '方向不同，不并列');
    out.append(head);
    var cards = el('div', 'cards');
    [
      ['plug', 'independent', 'outbound · 推理', 'Hermes 调别人的模型', 'model / auxiliary / fallback / moa'],
      ['cap', 'independent', 'outbound · 能力', '工具域各自的后端注册', 'stt / tts / web.backend / vision'],
      ['globe', 'independent', 'inbound · 入口', '外部把 Hermes 当模型调', 'API server · API_SERVER_KEY']
    ].forEach(function (row) {
      var card = el('div', 'pcard');
      var top = el('div', 'top');
      var em2 = el('span', 'emblem');
      em2.append(svgIcon(ICONS[row[0]], 15));
      top.append(em2, badge('独立配置段', 'info'));
      card.append(top, el('div', 'nm', row[2]), el('div', 'url', row[3]));
      var meta = el('div', 'meta');
      meta.append(chip(row[4], true));
      card.append(meta);
      cards.append(card);
    });
    out.append(cards);
    return out;
  };

  /* ── 模型选择 · 主与辅助 ────────────────────────────── */
  function selectMain(S) {
    var out = frag();
    var primary = (S.catalog && S.catalog.primary) || {};
    var tasks = auxTasks(S);

    out.append(ph('主与辅助', 'auto = 继承主模型', [
      btn('批量分配', 'btn sm', function () { M.sheets.assignAll && M.sheets.assignAll(S); }),
      btn('换主模型', 'btn sm primary', function () { M.sheets.changePrimary && M.sheets.changePrimary(S); })
    ]));

    var hero = el('div', 'hero');
    hero.append(el('div', 'lead', 'model.default'));
    var h2 = el('h2');
    h2.append(el('em', null, providerName(S, primary.provider) + ' / ' + (primary.model || '—')));
    h2.append(document.createTextNode(' · ' + inheritedCount(S) + ' 个继承 · ' + customCount(S) + ' 个单独指定'));
    hero.append(h2);
    out.append(hero);

    var slots = el('div', 'slots');
    tasks.forEach(function (task) {
      var own = task.provider && task.provider !== 'auto';
      var box = btn('', 'slotbox' + (own ? ' custom' : ''), function () {
        M.sheets.slot && M.sheets.slot(S, task);
      });
      var sn = el('span', 'sn', task.label || task.key);
      sn.append(dot(own ? 'warn' : 'ok'));
      box.append(sn);
      box.append(el('span', 'sw', own ? '单独用 ' + (task.model || task.provider) : '跟随主模型'));
      box.append(el('span', 'sm', 'auxiliary.' + task.key));
      box.append(el('span', 'sx', '›'));
      slots.append(box);
    });
    out.append(slots);

    var chips = el('div', 'chips');
    chips.append(chip('单独指定可带 base_url / api_key / timeout / fallback_chain'));
    chips.append(chip('回退链与 MOA 在右侧「回退链」「组合回答」子页里配'));
    out.append(chips);
    return out;
  };

  /* ── 模型选择 · 回退链 ──────────────────────────────── */
  function chainOf(S) { return ((S.catalog && S.catalog.fallbacks) || []); }

  function saveChain(S, chain, doneMsg) {
    var entries = chain.map(function (f) { return { key: f.key }; });
    M.mutate({ action: 'fallback', entries: entries, revision: (S.catalog || {}).revision },
      { done: doneMsg || '回退链已更新', body: '写入 fallback_providers' });
  }

  function moveChain(S, index, dir) {
    var chain = chainOf(S).slice();
    var target = index + dir;
    if (target < 0 || target >= chain.length) return;
    var tmp = chain[index]; chain[index] = chain[target]; chain[target] = tmp;
    saveChain(S, chain, '候选顺序已调整');
  }

  function removeChain(S, index) {
    var chain = chainOf(S).slice();
    chain.splice(index, 1);
    saveChain(S, chain, '已移除一个回退候选');
  }

  function selectFallback(S) {
    var out = frag();
    var chain = chainOf(S);
    out.append(ph('回退链', 'fallback_providers · 主模型失败时按顺序降级', [
      btn('+ 备用', 'btn sm primary', function () { M.sheets.fallbackAdd && M.sheets.fallbackAdd(S); })
    ]));
    if (!chain.length) {
      out.append(el('div', 'empty', '还没有备用候选，主模型失败会直接报错'));
    } else {
      var list = el('div', 'chain');
      chain.forEach(function (f, index) {
        var row = el('div', 'ci');
        row.append(el('span', 'idx', String(index + 1)));
        var body = el('div', 'body');
        body.append(el('div', 'tt', providerName(S, f.provider) + ' / ' + f.model));
        body.append(el('div', 'dd', f.has_overrides ? '带独立端点 / 密钥覆盖' : '跟随服务商配置'));
        row.append(body);
        var ops = el('div', 'ops');
        var up = btn('↑', 'iconmini', function () { moveChain(S, index, -1); });
        var down = btn('↓', 'iconmini', function () { moveChain(S, index, +1); });
        var del = btn('×', 'iconmini', function () { removeChain(S, index); });
        if (index === 0) up.disabled = true;
        if (index === chain.length - 1) down.disabled = true;
        ops.append(up, down, del);
        row.append(ops);
        list.append(row);
      });
      out.append(list);
    }
    out.append(panel('三层韧性', [
      kv('① 主模型', 'model.default 承担主推理'),
      kv('② 回退链', 'fallback_providers 按顺序降级'),
      kv('③ 辅助任务', '各槽位自带 fallback_chain')
    ]));
    out.append(panel('auto 的回退', [
      el('p', 'mini', '槽位没有单独指定时跟随主模型；主模型失败会走这条回退链，一轮最多切换一次。')
    ]));
    return out;
  }

  /* ── 模型选择 · 组合回答（MOA） ─────────────────────── */
  function toggleMoa(S, on, preset) {
    var p = preset || {};
    if (on && (!p.reference_models || !p.reference_models.length || !p.aggregator || !p.aggregator.model)) {
      M.sheets.moaEdit && M.sheets.moaEdit(S, p);
      return;
    }
    M.mutate({
      action: 'moa_save', revision: (S.moa || {}).moa_revision,
      preset: p.name || (S.moa && S.moa.default_preset) || 'default',
      enabled: on,
      reference_models: (p.reference_models || []).map(function (r) { return { provider: r.provider, model: r.model }; }),
      aggregator: p.aggregator || { provider: '', model: '' }
    }, { done: on ? 'MOA 已开启' : 'MOA 已关闭',
         body: on ? '主模型切到聚合模型 ' + ((p.aggregator && p.aggregator.model) || '') : '主模型回到原值' });
  }

  function selectMoa(S) {
    var out = frag();
    var moa = S.moa || {};
    var presets = moa.presets || [];
    var enabled = !!moa.enabled;
    var active = moa.active_preset || '';
    out.append(ph('组合回答', 'moa.presets · 虚拟 provider', [
      btn('配置', 'btn sm', function () {
        var p = presets.filter(function (x) { return x.name === active; })[0] || presets[0];
        M.sheets.moaEdit && M.sheets.moaEdit(S, p || { name: (moa.default_preset || 'default') });
      })
    ]));
    var hero = el('div', 'hero');
    hero.append(el('div', 'lead', enabled ? 'MOA 已开启' : 'MOA 已关闭'));
    var h2 = el('h2');
    if (enabled) {
      var act = presets.filter(function (p) { return p.name === active; })[0] || {};
      h2.append(el('em', null, active));
      h2.append(document.createTextNode(' 承担聚合，' + ((act.reference_models) || []).length + ' 个参考模型并行。'));
    } else {
      var cp = moa.current_primary || {};
      h2.append(el('em', null, providerName(S, cp.provider) + ' / ' + (cp.model || '—')));
      h2.append(document.createTextNode(' 当前走主模型，开启 MOA 后切到聚合模型。'));
    }
    hero.append(h2);
    out.append(hero);
    if (!presets.length) {
      out.append(el('div', 'empty', '还没有预设，点「配置」建第一个'));
    } else {
      var cards = el('div', 'cards');
      presets.forEach(function (p) {
        var isActive = enabled && p.name === active;
        var card = el('div', 'pcard' + (isActive ? ' on' : ''));
        var top = el('div', 'top');
        top.append(el('span', 'emblem', emblemOf(p.name)));
        top.append(isActive ? badge('启用中', 'ok') : badge('预设'));
        card.append(top);
        card.append(el('div', 'nm', p.name));
        var meta = el('div', 'meta');
        meta.append(chip((p.reference_models || []).length + ' 参考'));
        meta.append(chip('聚合 ' + ((p.aggregator && p.aggregator.model) || '—')));
        if (p.fanout) meta.append(chip(p.fanout, true));
        card.append(meta);
        var foot = el('div', 'foot');
        foot.append(btn('配置', 'btn sm', function () { M.sheets.moaEdit && M.sheets.moaEdit(S, p); }));
        if (isActive) foot.append(btn('关闭', 'btn sm danger', function () { toggleMoa(S, false, p); }));
        else foot.append(btn('启用', 'btn sm primary', function () { toggleMoa(S, true, p); }));
        card.append(foot);
        cards.append(card);
      });
      out.append(cards);
    }
    out.append(panel('成本落点', [
      el('p', 'mini', '开启后每个请求并行打 N 个参考模型，再加一次聚合调用，token 约为 (N+1) 倍；参考模型只给聚合模型供上下文，不直接回给用户。')
    ]));
    return out;
  }

  /* 模型选择分派器 */
  M.pages.select = function (S) {
    var tab = (S.tab && S.tab.select) || 'main';
    if (tab === 'fallback') return selectFallback(S);
    if (tab === 'moa') return selectMoa(S);
    return selectMain(S);
  };

  /* ── 服务商 · LLM 服务 ──────────────────────────────── */
  function providersLlm(S) {
    var out = frag();
    var cat = S.catalog || {};
    var providers = cat.providers || [];

    out.append(ph('LLM 服务商', 'providers: 注册表 · 只放推理端点', [
      btn('+ 添加服务', 'btn sm primary', function () { M.sheets.providerAdd && M.sheets.providerAdd(S); })
    ]));

    var cards = el('div', 'cards');
    providers.forEach(function (p) {
      var off = p.enabled === false;
      var card = el('div', 'pcard' + (off ? ' off' : ''));
      var top = el('div', 'top');
      top.append(el('span', 'emblem', emblemOf(p.name)));
      top.append(off ? badge('停用') : badge('正常', 'ok'));
      card.append(top);
      card.append(el('div', 'nm', p.name || p.id));
      card.append(el('div', 'url mono', p.base_url || '—'));
      var meta = el('div', 'meta');
      meta.append(chip(p.id, true));
      meta.append(chip((p.models || []).length + ' 模型'));
      meta.append(chip(p.api_mode || 'chat_completions'));
      meta.append(chip(p.credential_pool && p.credential_pool.length ? '密钥 ' + p.credential_pool.length + ' 份' : '无密钥'));
      card.append(meta);
      var foot = el('div', 'foot');
      foot.append(btn('模型', 'btn sm', function () { M.sheets.providerModels && M.sheets.providerModels(S, p); }));
      foot.append(btn('编辑', 'btn sm', function () { M.sheets.providerEdit && M.sheets.providerEdit(S, p); }));
      foot.append(btn(off ? '启用' : '停用', 'btn sm', function () {
        M.mutate({ action: 'toggle', id: p.id, enabled: off, revision: (S.catalog || {}).revision },
          { done: (off ? '已启用 ' : '已停用 ') + p.name });
      }));
      foot.append(btn('删除', 'btn sm danger', function () { M.sheets.providerDelete && M.sheets.providerDelete(S, p); }));
      card.append(foot);
      cards.append(card);
    });

    var add = btn('', 'pcard add', function () { M.sheets.providerAdd && M.sheets.providerAdd(S); });
    add.append(el('span', 'plus', '+'), el('span', 't', '添加 LLM 服务'), el('span', 'url', '自定义 providers.<name>'));
    cards.append(add);
    out.append(cards);

    var chips = el('div', 'chips');
    chips.append(chip('语音 / OCR / 搜索不在这里配'));
    chips.append(chip('密钥与对话内能力在右侧「密钥」「对话内能力」子页'));
    chips.append(chip('providers.<name>: base_url · api_mode · extra_headers · discover_models', true));
    out.append(chips);
    return out;
  };

  /* ── 服务商 · 密钥 ──────────────────────────────────── */
  function providersKeys(S) {
    var out = frag();
    var keys = (S.keys && S.keys.keys) || [];
    out.append(ph('密钥', '环境变量 · 只显示名字和指纹', [
      btn('+ 添加密钥', 'btn sm primary', function () { M.sheets.keyAdd && M.sheets.keyAdd(S); })
    ]));
    if (!keys.length) {
      out.append(el('div', 'empty', 'config 里没有引用任何环境变量'));
    } else {
      var rows = [];
      keys.forEach(function (k) {
        var row = el('div', 'kv');
        row.append(el('span', 'mono', k.name));
        var holder = el('b');
        holder.append(k.configured ? badge('已配置', 'ok') : badge('缺失', 'err'));
        holder.append(el('span', 'mini', ' ' + (k.hint || '') + (k.used_by && k.used_by.length ? ' · ' + k.used_by.length + ' 处引用' : '')));
        row.append(holder);
        rows.push(row);
      });
      out.append(panel('环境变量（' + ((S.keys && S.keys.env_count) || 0) + ' 个）', rows));
    }
    out.append(el('p', 'mini', '值写进 ' + ((S.keys && S.keys.env_file) || 'config 同目录 .env') + '，config.yaml 里用 ${KEY} 引用，不落明文。'));
    return out;
  }

  /* ── 服务商 · 对话内能力 ────────────────────────────── */
  function dsProvider(S) {
    var providers = (S.catalog && S.catalog.providers) || [];
    return providers.filter(function (p) {
      return p.enabled !== false && p.request_extra && Object.keys(p.request_extra).length;
    })[0] || null;
  }

  function chatToolState(ds, key) {
    var extra = ds.request_extra || {};
    if (key === 'thinking') return !!(extra.thinking && extra.thinking.type !== 'disabled');
    if (key === 'title') return !!(extra.title && extra.title.enabled !== false);
    if (key === 'safety') return !!extra.safety_check;
    return false;
  }

  function toggleChatTool(S, ds, key) {
    var extra = JSON.parse(JSON.stringify(ds.request_extra || {}));
    var on = !chatToolState(ds, key);
    if (key === 'thinking') { if (on) extra.thinking = { type: 'enabled' }; else delete extra.thinking; }
    else if (key === 'title') { if (on) extra.title = { enabled: true }; else delete extra.title; }
    else if (key === 'safety') { if (on) extra.safety_check = { level: 'high' }; else delete extra.safety_check; }
    M.mutate({ action: 'update', id: ds.id, changes: { request_extra: extra }, revision: (S.catalog || {}).revision },
      { done: (on ? '已开启 ' : '已关闭 ') + key, body: '写入 providers.<id>.extra_body' });
  }

  function providersChat(S) {
    var out = frag();
    var ds = dsProvider(S);
    out.append(ph('对话内能力', '服务端托管工具 · 请求参数', [chip('DeepSeek 官方', true)]));
    if (!ds) {
      out.append(el('div', 'empty', '没有服务配置 extra_body，无法编辑对话内能力'));
      return out;
    }
    out.append(panel('DeepSeek 官方', [
      kv('服务商', ds.name + ' · ' + ds.id),
      kv('地址', ds.base_url || '—'),
      kv('启用模型', (ds.models || []).filter(function (m) { return m.enabled; }).map(function (m) { return m.id; }).join(', ') || '—')
    ], badge('extra_body 明确支持', 'info')));
    out.append(sec('参数开关', '写入 provider 请求参数 extra_body'));
    var grid = el('div', 'capgrid');
    [
      ['thinking', '深度思考', 'extra_body.thinking'],
      ['title', '服务端标题', 'extra_body.title'],
      ['safety', '安全校验', 'extra_body.safety_check']
    ].forEach(function (row) {
      var on = chatToolState(ds, row[0]);
      var card = el('div', 'capcard' + (on ? ' on' : ''));
      var ch = el('div', 'ch');
      ch.append(el('span', 'ci', row[0].slice(0, 1).toUpperCase()));
      ch.append(el('span', 'cn', row[1]));
      card.append(ch);
      card.append(el('div', 'ca mono', row[2]));
      var cf = el('div', 'cf');
      cf.append(on ? badge('已开启', 'ok') : badge('关闭'));
      cf.append(btn(on ? '关闭' : '开启', 'btn sm' + (on ? '' : ' primary'), function () { toggleChatTool(S, ds, row[0]); }));
      card.append(cf);
      grid.append(card);
    });
    out.append(grid);
    out.append(el('p', 'mini', 'web_search / read_url / file 是 DeepSeek 服务端工具，不做成 config 开关；下方可实测。'));
    var caps = (S.caps && S.caps.caps) || [];
    var chatCaps = caps.filter(function (c) { return (c.id || '').indexOf('chat_') === 0; });
    if (chatCaps.length) {
      out.append(sec('对话内能力实测', 'cap_run 真发一次请求'));
      var g2 = el('div', 'capgrid');
      chatCaps.forEach(function (c) {
        var card = el('div', 'capcard');
        var ch = el('div', 'ch');
        ch.append(el('span', 'ci', (c.id || '').slice(5, 7).toUpperCase()));
        ch.append(el('span', 'cn', c.label || c.id));
        card.append(ch);
        card.append(el('div', 'ca mono', c.desc || ''));
        var cf = el('div', 'cf');
        cf.append(btn('实测', 'btn sm', function () { M.sheets.capRun && M.sheets.capRun(S, c); }));
        card.append(cf);
        g2.append(card);
      });
      out.append(g2);
    }
    return out;
  }

  /* 服务商分派器 */
  M.pages.providers = function (S) {
    var tab = (S.tab && S.tab.providers) || 'llm';
    if (tab === 'keys') return providersKeys(S);
    if (tab === 'chat') return providersChat(S);
    return providersLlm(S);
  };

  /* ── 能力后端 ───────────────────────────────────────── */
  var backendFilter = 'all';

  /* ── 能力后端 · 全部域 ──────────────────────────────── */
  function backendsAll(S) {
    var out = frag();
    var domains = (S.backends && S.backends.domains) || [];

    out.append(ph('能力后端', '按工具域注册 · 与 LLM provider 独立', [
      btn('+ 自定义来源', 'btn sm primary', function () { M.sheets.backendCustom && M.sheets.backendCustom(S); })
    ]));

    /* 类型筛选：用真实的三类状态，不硬造分类 */
    var filters = el('div', 'chips');
    [['all', '全部'], ['本页可配', '本页可配'], ['需二改', '需二改']].forEach(function (row) {
      var chipBtn = btn(row[1], 'chip' + (backendFilter === row[0] ? ' pri' : ''), function () {
        backendFilter = row[0];
        M.render();
      });
      chipBtn.style.cursor = 'pointer';
      filters.append(chipBtn);
    });
    out.append(filters);

    var shown = domains.filter(function (d) {
      if (backendFilter === 'all') return true;
      return d.status === backendFilter;
    });

    var cards = el('div', 'cards');
    shown.forEach(function (d) {
      var card = el('div', 'pcard backend');
      card.style.setProperty('--accent', d.writable ? '#4d7fd6' : '#bc4c3d');
      var top = el('div', 'top');
      var em = el('span', 'emblem');
      em.append(svgIcon(ICONS[BACKEND_ICON[d.key] || 'cap'], 15));
      top.append(em, badge(d.status, d.status_tone));
      card.append(top);
      card.append(el('div', 'nm', d.label));
      card.append(el('div', 'url mono', d.path));
      var meta = el('div', 'meta');
      var currentText = d.provider || (d.detail && d.detail.model) || '未设置';
      meta.append(chip(currentText, true));
      if (d.detail && d.detail.model && d.provider) meta.append(chip(d.detail.model));
      if (d.detail && d.detail.language) meta.append(chip('语言 ' + d.detail.language));
      if (d.detail && d.detail.providers) meta.append(chip(d.detail.providers + ' 个提供方'));
      if (d.note) meta.append(chip(d.note));
      card.append(meta);

      if (d.writable) {
        var inline = M.sheets.backendInlineForm && M.sheets.backendInlineForm(S, d);
        card.append(inline || el('p', 'mini', d.note || ''));
      } else {
        card.append(el('p', 'mini', d.note || '跟随服务商原生能力，没有独立配置项'));
      }
      cards.append(card);
    });
    if (!shown.length) cards.append(el('div', 'empty', '这个筛选下没有卡'));
    out.append(cards);

    /* DS 官方端点：只用实测过的能力矩阵，没有就不显示 */
    var caps = (S.caps && (S.caps.caps || S.caps.rows)) || null;
    if (caps && caps.length) {
      out.append(sec('DS 官方端点', '实测过的接口能力'));
      var chipsRow = el('div', 'chips');
      caps.slice(0, 12).forEach(function (cap) {
        var ok = cap.ok !== false && cap.status !== 'fail';
        chipsRow.append(chip((cap.name || cap.label || cap.key || '') + ' · ' + (ok ? '通过' : '失败')));
      });
      out.append(chipsRow);
    }

    out.append(panel('每个域怎么改', [
      el('p', 'mini', '来源直接在本页选、保存即写入 config.yaml；语音（stt/tts）与视觉（vision）也内联在这里，不再跳专属编辑器。'),
      el('p', 'mini', '文字识别（OCR）可选白描（账密在「密钥」页）或 DeepSeek（复用其 API key）；生图走 image_gen 工具集开关，没有独立 provider。'),
      el('p', 'mini', '入站接口（把本机当模型给别的程序调）不在这里，状态由语音配置服务统一读取，见概览页的「入站接口」链路。')
    ]));
    return out;
  };

  /* ── 能力后端 · DeepSeek 落点 ───────────────────────── */
  var DS_CAP_LANDING = {
    models: 'providers · 服务商',
    chat_basic: 'model.default · 主模型',
    chat_thinking: 'extra_body.thinking',
    chat_title: 'extra_body.title',
    chat_safety: 'extra_body.safety_check',
    chat_search: 'deepseek_web_search 工具',
    chat_readurl: 'deepseek_read_url 工具',
    chat_reminder: 'latest_reminder · 主模型',
    chat_file: 'deepseek /files',
    tool_search: 'web.backend · 搜索',
    tool_fetch: 'web.backend · 抓取',
    tool_ocr: '无独立槽位 · 跟随服务商',
    tool_asr: 'stt.provider',
    tool_tts: 'tts.provider'
  };

  function backendsDs(S) {
    var out = frag();
    var caps = (S.caps && S.caps.caps) || [];
    out.append(ph('DeepSeek 落点', '能力 → 落到哪个配置对象'));
    if (!caps.length) {
      out.append(el('div', 'empty', '能力矩阵未加载'));
    } else {
      var grid = el('div', 'capgrid');
      caps.forEach(function (c) {
        var card = el('div', 'capcard');
        var ch = el('div', 'ch');
        ch.append(el('span', 'ci', (c.id || '').slice(0, 2).toUpperCase()));
        ch.append(el('span', 'cn', c.label || c.id));
        card.append(ch);
        card.append(el('div', 'ca mono', c.id || ''));
        card.append(el('div', 'cft', '→ ' + (DS_CAP_LANDING[c.id] || '—')));
        var cf = el('div', 'cf');
        cf.append(el('span', 'mini', c.desc || ''));
        cf.append(btn('实测', 'btn sm', function () { M.sheets.capRun && M.sheets.capRun(S, c); }));
        card.append(cf);
        grid.append(card);
      });
      out.append(grid);
    }
    out.append(panel('为什么不是都在接入大模型时配', [
      el('p', 'mini', 'chat_* 是对话内能力，落在 DeepSeek 官方 provider 的 extra_body 或服务端工具；tool_* 是独立接口，落在各自后端配置（web/stt/tts）。'),
      el('p', 'mini', '实测（cap_run）真发一次请求到当前服务商，只读不写配置。')
    ]));
    return out;
  }

  /* 能力后端分派器 */
  M.pages.backends = function (S) {
    var tab = (S.tab && S.tab.backends) || 'all';
    if (tab === 'ds') return backendsDs(S);
    return backendsAll(S);
  };

  /* ── 工具集 ─────────────────────────────────────────── */
  M.pages.toolsets = function (S) {
    var out = frag();
    var data = S.toolsets || {};
    var rows = data.toolsets || [];
    var gateway = data.gateway || {};

    out.append(ph('工具集', 'toolsets · platform_toolsets.' + (data.platform || 'api_server'), [
      btn('恢复平台默认', 'btn sm', function () {
        M.mutate({ action: 'save_toolsets', platform: data.platform, follow_default: true, revision: data.revision },
          { done: '已恢复平台默认', body: '删掉 platform_toolsets 里这个平台的自定义清单，回到内核默认组合' });
      })
    ]));

    var split = el('div', 'split');
    var left = el('div');

    var note = data.follow_default
      ? '当前跟随平台默认（' + (data.default_name || '') + '），点卡片会写入显式清单'
      : '写入 platform_toolsets / agent.disabled_toolsets';
    left.append(sec('启用', note));

    var grid = el('div', 'tsgrid');
    rows.forEach(function (row) {
      var card = btn('', 'tscard' + (row.enabled ? ' on' : ''), function () {
        var next = rows.filter(function (r) {
          if (r.name === row.name) return !r.enabled;
          return r.enabled;
        }).map(function (r) { return r.name; });
        M.mutate({ action: 'save_toolsets', platform: data.platform, enabled: next, revision: data.revision },
          { done: (row.enabled ? '已关闭 ' : '已开启 ') + toolsetLabel(row.name) + '（' + row.name + '）',
            body: '对新会话生效；当前会话的助手工具集在下一轮重新装载' });
      });
      card.append(el('span', 'tsn', toolsetLabel(row.name)));
      card.append(el('span', 'mono', row.name));
      card.append(dot(row.enabled ? 'ok' : 'idle'));
      grid.append(card);
    });
    left.append(grid);

    /* Tool Gateway：网关真实开关（不是 Nous Portal 订阅那套，如实标注） */
    left.append(sec('Tool Gateway', 'gateway.* · 网关真实开关'));
    var gwRows = [];
    gwRows.push(kv('gateway.strict', badge(gateway.strict ? '开启' : '关闭', gateway.strict ? 'ok' : '')));
    gwRows.push(kv('gateway.trust_recent_files', badge(gateway.trust_recent_files ? '信任' : '不信任', gateway.trust_recent_files ? 'ok' : '')));
    gwRows.push(kv('gateway.trust_recent_files_seconds', String(gateway.trust_recent_files_seconds == null ? '—' : gateway.trust_recent_files_seconds)));
    gwRows.push(kv('gateway.media_delivery_allow_dirs', (gateway.media_delivery_allow_dirs || []).length + ' 个目录'));
    var toggleStrict = btn(gateway.strict ? '关闭严格模式' : '开启严格模式', 'btn sm', function () {
      M.mutate({ action: 'save_toolsets', platform: data.platform, gateway: { strict: !gateway.strict }, revision: data.revision },
        { done: '网关严格模式已' + (gateway.strict ? '关闭' : '开启'), body: '写入 config.yaml 的 gateway.strict' });
    });
    gwRows.push(toggleStrict);
    left.append(panel('', gwRows));
    split.append(left);

    var aside = el('div', 'aside');
    var secRows = [];
    secRows.push(kv('security.allow_private_urls', badge(data.allow_private_urls ? '已允许' : '默认 false', data.allow_private_urls ? 'warn' : 'ok')));
    secRows.push(el('p', 'mini', '自定义内网地址（Ollama、自建 Whisper、SearXNG、局域网 OCR）必须开启，否则 URL 工具会拦截私网。'));
    secRows.push(btn(data.allow_private_urls ? '禁止私网地址' : '允许私网地址', 'btn sm block', function () {
      M.mutate({ action: 'save_toolsets', platform: data.platform, allow_private_urls: !data.allow_private_urls, revision: data.revision },
        { done: '已' + (data.allow_private_urls ? '禁止' : '允许') + '私网地址', body: '写入 config.yaml 的 security.allow_private_urls' });
    }));
    aside.append(panel('安全边界', secRows));

    aside.append(panel('生效', [
      kv('工具集变更', '/reset 新会话'),
      kv('CLI', '下次启动'),
      kv('Gateway', '下个新会话'),
      kv('安全边界', '立即生效')
    ]));
    split.append(aside);
    out.append(split);
    return out;
  };

  /* ── 配置 · config.yaml ─────────────────────────────── */
  function configYaml(S) {
    var out = frag();
    var preview = S.preview || {};
    var text = preview.text || '（读取失败）';

    out.append(ph('config.yaml', '写入 Hermes 原生字段', [
      btn('复制', 'btn sm', async function () {
        try {
          await navigator.clipboard.writeText(text);
          M.toast('已复制', preview.lines + ' 行 · ' + preview.bytes + ' 字节');
        } catch (error) {
          M.toast('复制失败', '浏览器拒绝了剪贴板访问：' + error.message, 'bad');
        }
      }),
      btn('写入', 'btn sm primary', function () { M.sheets.configWrite && M.sheets.configWrite(S); })
    ]));

    var head = badge(preview.masked ? '已脱敏' : '已同步', preview.masked ? 'warn' : 'ok');
    out.append(panel('文件预览', [
      code(text),
      el('p', 'mini', (preview.lines || 0) + ' 行 · ' + (preview.bytes || 0) + ' 字节 · 密钥值已替换为 ****（已隐藏），写回时不会带上这些掩码')
    ], head));
    return out;
  };

  /* ── 配置 · 生效与写入 ──────────────────────────────── */
  function configApply(S) {
    var out = frag();
    out.append(ph('生效与写入', '每个写操作的属性'));
    var split = el('div', 'split');
    var left = el('div');
    var cat = S.catalog || {};
    var auxTasks = (S.aux && S.aux.tasks) || [];
    var ownCount = auxTasks.filter(function (t) { return t.provider && t.provider !== 'auto'; }).length;
    var domains = (S.backends && S.backends.domains) || [];
    var toolsets = S.toolsets || {};
    left.append(panel('本次改动', [
      kv('model.default', (cat.primary && cat.primary.model) || '—'),
      kv('单独指定槽位', ownCount + ' / ' + auxTasks.length),
      kv('fallback_providers', (cat.fallbacks || []).length + ' 条'),
      kv('能力后端', domains.length + ' 域'),
      kv('工具集', (toolsets.count_enabled || 0) + ' 启用')
    ], badge('已同步', 'ok')));
    var audit = (S.audit && S.audit.snapshots) || [];
    if (audit.length) {
      var rows = audit.slice(0, 15).map(function (item) {
        var when = item.at ? new Date(item.at * 1000).toLocaleString('zh-CN', { hour12: false }) : '';
        var row = el('div', 'kv');
        row.append(el('span', null, (when || '') + ' · ' + item.name.split('-')[0]));
        var right = el('b');
        right.append(el('span', 'mono', item.bytes + ' 字节'));
        row.append(right);
        return row;
      });
      left.append(panel('操作记录', rows));
    }
    split.append(left);
    var aside = el('div', 'aside');
    aside.append(panel('生效边界', [
      kv('CLI', '下次启动'),
      kv('Gateway', '下个新会话'),
      kv('当前会话换模型', '/model'),
      kv('工具集变更', '/reset'),
      el('p', 'mini', '辅助槽位改了没生效：先看是否新会话、是否仍为 auto、目标服务是否缺凭据。')
    ]));
    var chipsRow = el('div', 'chips');
    ['hermes model', 'hermes fallback', 'hermes tools', 'hermes config set'].forEach(function (c) {
      chipsRow.append(chip(c, true));
    });
    aside.append(panel('可复现', [chipsRow]));
    split.append(aside);
    out.append(split);
    return out;
  }

  /* 配置分派器 */
  M.pages.config = function (S) {
    var tab = (S.tab && S.tab.config) || 'yaml';
    if (tab === 'apply') return configApply(S);
    return configYaml(S);
  };
})();
