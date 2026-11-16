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

    /* 2026-11-16：模型清单为空的服务商 —— 配了一半的状态，必须一眼看见。
       这类服务在对话页能被选中，但二级模型列表里一个模型都没有。
       数据来自后端 catalog.alerts（needs_models 汇总）。 */
    if ((cat.alerts || []).length) {
      var alert = el('div', 'alertbar');
      var abody = el('div', 'abody');
      abody.append(el('b', null, '这些服务还没有可用模型'));
      var aul = el('ul');
      cat.alerts.forEach(function (a) { aul.append(el('li', null, a.text || a.name)); });
      abody.append(aul);
      alert.append(abody);
      alert.append(btn('去补模型', 'btn sm', function () { M.go('providers'); }));
      out.append(alert);
    }

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

  /* 2026-11-16：点 ↑↓ 之后不能「什么都不动」干等服务器回话。
     以前这里发了请求既不 await 也不看返回，mutate 撞上 409 会在内部 load()+render()
     重绘回原顺序 —— 用户眼里就是「点了没效果」，那两秒里的 toast 一闪而过根本没看见。
     现在先把新顺序画上去（乐观），失败时 mutate 内部的重绘会把真实顺序放回来，
     再补一句「顺序没保存」，别让人以为是按钮坏了。 */
  async function saveChain(S, chain, doneMsg) {
    if (S.chainBusy) return;              /* 连点会并发写同一个 revision，第二个必 409 */
    S.chainBusy = true;
    var entries = chain.map(function (f) { return { key: f.key }; });
    var revision = (S.catalog || {}).revision;
    if (S.catalog) S.catalog.fallbacks = chain.slice();
    if (M.render) M.render();
    try {
      var out = await M.mutate({ action: 'fallback', entries: entries, revision: revision },
        { done: doneMsg || '回退链已更新', body: '写入 fallback_providers' });
      if (out && out.ok === false) M.toast('顺序没保存', out.error || '后端拒绝了这次调整', 'bad');
    } catch (e) {
      M.toast('顺序没保存', (e && e.message) || '保存失败', 'bad');
      if (M.load) await M.load();
      if (M.render) M.render();
    } finally {
      S.chainBusy = false;
    }
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

  /* 一张服务商卡里的一把密钥：只是「有一把 key，它管着几个模型」的一行状态。
     2026-11-16 用户明确：卡片上只允许三个服务商级按钮（编辑/停用/删除），
     key 级的编辑、启停、删除全部搬进编辑面板 —— 所以这里一个按钮都不放，
     否则每加一把 key 就多出一组按钮。 */
  /* 2026-11-16：原名也叫 keyRow，跟下面密钥子页那个函数重名 —— JS 后定义覆盖
     前定义，于是服务商卡片实际跑的是「密钥子页」那套逻辑：它读 k.configured，
     而卡片喂进来的数据结构里只有 api_key_configured，全是 undefined，
     整页每一行都判成缺密钥。卡片和子页的行长得不一样（这边是 kdot+kcount，
     那边是 kname+hint+改值按钮），本来就不该共用一个函数名。改名分开。 */
  function svcKeyRow(S, k) {
    var off = k.enabled === false;
    var row = el('div', 'keyrow' + (off ? ' off' : ''));
    var head = el('div', 'krow');
    head.append(el('span', 'kdot' + (off ? ' off' : '')));
    /* 兜底不再是 k.id：custom_xxx 是内核生成的，用户既没起过也改不了，
       显示它等于把实现细节当名字。 */
    head.append(el('span', 'klabel', k.key_label || k.name || '未命名密钥'));
    /* 2026-11-16：模型数只算启用的。取消勾选的模型会归档成 enabled:false
       留在数组里（不丢历史元数据），所以数 length 永远显示全量 —— 用户取消
       了一个还显示 4 个，会以为保存没生效。 */
    var live = (k.models || []).filter(function (m) { return typeof m === 'string' || m.enabled !== false; });
    head.append(el('span', 'kcount', live.length + ' 模型'));
    if (k.api_key_configured === false) head.append(badge('缺密钥'));
    row.append(head);
    return row;
  }

  /* ── 服务商级批量动作（2026-11-16）─────────────────────────
     卡片上的「停用/删除」是服务商级：一个服务商 = 一个 group = N 条 provider，
     也就是 N 把 key。后端 toggle/delete 都是单条 mv 语义，且每次写都会换
     revision，所以必须串行、每步重新取最新 revision，不能 Promise.all。
     逐把执行 → 汇总成功几把、哪把为什么失败，比「失败」两个字有用。 */
  async function svcToggle(S, keys, turnOff, label) {
    var target = !turnOff;
    var todo = keys.filter(function (k) { return (k.enabled !== false) !== target; });
    if (!todo.length) {
      M.toast('没有变化', label + ' 已经是' + (target ? '全部启用' : '全部停用') + '状态', 'ok');
      return;
    }
    var ok = 0, fails = [];
    for (var i = 0; i < todo.length; i++) {
      var k = todo[i];
      try {
        await M.api({ action: 'toggle', id: k.id, enabled: target, revision: (S.catalog || {}).revision });
        ok++;
      } catch (e) {
        fails.push((k.key_label || k.id) + '：' + ((e && e.message) || e));
      }
    }
    M.toast((fails.length ? '部分' : '') + (target ? '已启用' : '已停用'),
      label + ' · ' + ok + '/' + todo.length + ' 把密钥' + (fails.length ? '\n' + fails.join('\n') : ''),
      fails.length ? 'bad' : 'ok');
    /* 2026-11-16：只 load 不 render，卡片就还是旧样子 —— 用户点完停用，toast
       说「已停用」，卡片却依旧亮着、徽标依旧写「正常」，非要刷新才变。
       load() 只把数据拉进 S，落到 DOM 必须紧跟一次 render()。 */
    if (M.load) await M.load();
    if (M.render) M.render();
  }

  async function svcDelete(S, keys, label) {
    if (!keys || !keys.length) return;
    var ids = keys.map(function (k) { return k.id; });
    /* 2026-11-16 血泪（用户实测踩出来的）：这里原来是逐把发 delete，成功一把
       算一把。第一把没被引用就真的删掉了，第二把被 MOA 引用才报 409 —— 弹窗
       上写着「还有引用，删不了」，回来一看组里少了一半，报错和事实对不上。
       整组删除必须一次发出去，后端要么全删要么一把不动。 */
    try {
      var out = await M.api({ action: 'group_delete', id: ids[0], ids: ids, revision: (S.catalog || {}).revision });
      /* 2026-11-16：删服务商时后端会把「少了还能跑」的引用顺手摘掉（频道覆盖、
         回退链里的一项、MOA 参考模型、回滚记录、会话 /model 覆盖）。这些是静默
         改动，必须打出来 —— 用户得知道自己少配了什么，而不是过两天发现某个频道
         悄悄换了模型。 */
      var swept = (out && out.auto_cleaned) || [];
      var sess = (out && out.sessions_reset) || [];
      /* 会话覆盖也逐条列出来。原来这里折成「N 个会话的模型覆盖」，用户只知道
         数量、不知道哪个群哪个对话被改了 —— 而这两个地方正是他下次打开会看到
         模型变了的地方，必须点名。多了折成「等 N 处」。 */
      var extra = swept.concat(sess);
      var shown = extra.slice(0, 4).join('、');
      if (extra.length > 4) shown += ' 等 ' + extra.length + ' 处';
      M.toast('已删除', label + ' · ' + ids.length + ' 把密钥' + (extra.length ? '；顺手清了 ' + shown : ''), 'ok');
    } catch (e) {
      M.toast('一把都没删', label + ' · ' + ((e && e.message) || e), 'bad');
    }
    if (M.load) await M.load();
    if (M.render) M.render();
  }

  /* 删除整个服务商是不可逆的，先让用户看清要删几把 key。
     引用检查是从弹层那版（M.sheets.providerDelete）搬过来的 —— 卡片这条路径
     原来一个检查都没有，删掉正在当主模型、或者被回退链/辅助任务引用的服务也照删，
     配置里就留下一根悬空的引用。那版从来没被调用过（纯死代码），检查搬完就删掉了。 */
  function svcDeleteConfirm(S, keys, label) {
    var cat = S.catalog || {};
    var primary = cat.primary || {};
    var ids = keys.map(function (k) { return k.id; });
    var blockers = [];
    /* 会被后端顺手清掉的引用（摘掉之后配置照样成立），跟 blockers 分开展示。 */
    var tidy = [];
    if (primary.provider && ids.indexOf(primary.provider) >= 0) {
      blockers.push('它是当前主模型（' + primary.model + '）');
    }
    /* 2026-11-16：回退链里的一项不拦了。用户原话「只要有一个频道在用就不能删，
       这得多麻烦」—— 少一项回退照样能跑，后端 auto_clean 会摘掉它并回报。
       只有「少了就跑不动」的才留在 blockers 里。 */
    ((cat.fallbacks) || []).forEach(function (f) {
      if (ids.indexOf(f.provider) >= 0) tidy.push('回退链里的 ' + f.model);
    });
    ((S.aux && S.aux.tasks) || []).forEach(function (t) {
      var who = '辅助任务「' + (t.label || t.key) + '」';
      if (ids.indexOf(t.provider) >= 0) blockers.push(who + '在用');
      /* 回退链也是引用：主用 auto、备用挂在这条服务上的情况，只查 provider 会漏。 */
      (t.fallback_chain || []).forEach(function (f, i) {
        if (ids.indexOf(f.provider) >= 0) tidy.push(who + '回退链第 ' + (i + 1) + ' 项');
      });
    });
    /* MOA 预设的聚合模型和参考模型同样是引用，原来这里一个都没查。
       S.moa 只在打开过「组合回答」页时才加载，取不到就跳过 —— 后端还有一道闸。 */
    ((S.moa && S.moa.presets) || []).forEach(function (p) {
      var agg = p.aggregator || {};
      if (ids.indexOf(agg.provider) >= 0) blockers.push('MOA 预设「' + p.name + '」的聚合模型');
      (p.reference_models || []).forEach(function (r, i) {
        if (ids.indexOf(r.provider) >= 0) tidy.push('MOA 预设「' + p.name + '」参考模型第 ' + (i + 1) + ' 个');
      });
    });
    if (blockers.length) {
      var blocked = M.sheet({ title: '删不了 ' + label, sub: '还有 ' + blockers.length + ' 处在引用它' });
      blocked.body.append(el('div', 'errline', '先把这些引用改到别的服务，再回来删：'));
      var deps = el('div', 'deps');
      blockers.forEach(function (line) { deps.append(el('div', 'dh', '· ' + line)); });
      blocked.body.append(deps);
      blocked.foot.append(btn('知道了', 'btn primary', function () { blocked.close(); }));
      return;
    }
    var sheet = M.sheet({
      title: '删除 ' + label,
      sub: keys.length > 1 ? '这个服务商下的 ' + keys.length + ' 把密钥会全部删除' : '这把密钥会被删除'
    });
    var body = el('div', 'mblock');
    body.append(el('div', 'mbar bad', '删掉后这个服务商的配置和 .env 里的密钥变量一起清掉，不能撤销'));
    var list = el('div', 'mlist');
    keys.forEach(function (k, i) {
      var r = el('div', 'mrow');
      /* 这里原来显示 k.id —— 也就是 custom_umw4fn6uw5d42。那个字符串是内核
         生成的内部标识，用户没起过、也改不了，拿它当名字显示等于把实现细节
         丢到脸上。改成序号 + 密钥名。 */
      r.append(el('span', 'mid mono', '#' + (i + 1)));
      r.append(el('span', 'mname', k.key_label || '未命名密钥'));
      r.append(el('span', 'mctx', (k.models || []).length + ' 模型'));
      list.append(r);
    });
    body.append(list);
    /* 会被顺手清掉的引用：不拦，但必须在确认删之前说清楚。用户要的是
       「别拿一个频道拦我」，不是「悄悄替我改配置」。 */
    if (tidy.length) {
      body.append(el('div', 'mbar', '下面 ' + tidy.length + ' 处引用会跟着摘掉，摘完回落全局默认，其余配置不受影响'));
      var tlist = el('div', 'deps');
      tidy.forEach(function (line) { tlist.append(el('div', 'dh', '· ' + line)); });
      body.append(tlist);
    }
    sheet.body.append(body);
    sheet.foot.append(btn('取消', 'btn', function () { sheet.close(); }));
    sheet.foot.append(btn('确认删除', 'btn danger', function () {
      sheet.close();
      svcDelete(S, keys, label);
    }));
  }

  /* 用这把密钥向它自己的端点拉真实模型清单。走 monitor 已有的 discover：
     传 provider_id + model + use_saved_credential，它自己从 .env 取密钥，
     明文 key 不出后端。拉不到就一个字都不动，免得把手工维护的清单清空。 */
  /* ── 服务商 · LLM 服务 ──────────────────────────────── */
  function providersLlm(S) {
    var out = frag();
    var cat = S.catalog || {};
    var providers = cat.providers || [];

    out.append(ph('LLM 服务商', 'providers: 注册表 · 只放推理端点', [
      btn('+ 添加服务', 'btn sm primary', function () { M.sheets.providerAdd && M.sheets.providerAdd(S); })
    ]));

    // 后端给 groups：同一个中转站的多把 key 收成一张卡。老后端没有 groups 就按
    // providers 一对一渲染 —— 没有 group 的服务，行为跟以前完全一样。
    var groups = (cat.groups && cat.groups.length) ? cat.groups
      : providers.map(function (p) { return { group: '', name: p.name || p.id, base_url: p.base_url || '', keys: [p] }; });

    var cards = el('div', 'cards');
    groups.forEach(function (g) {
      var keys = g.keys || [];
      var anyOn = keys.some(function (k) { return k.enabled !== false; });
      /* 2026-11-16：有密钥但一个模型都没拉到的服务商，卡上直接挂红标 —— 它
         在对话页选得中，点进去二级列表却是空的。 */
      var needModels = keys.some(function (k) { return k.needs_models; });
      var card = el('div', 'pcard' + (anyOn ? '' : ' off'));
      var top = el('div', 'top');
      top.append(el('span', 'emblem', emblemOf(g.name)));
      /* 2026-11-16：官方 / 第三方标识。判据是地址落没落在官方预设表里（后端
         group_view 算好 official 一起下发），不看名字 —— 叫「DeepSeek 官方」
         却指向中转站的，照样算第三方。 */
      top.append(g.official ? badge('官方', 'pri') : badge('第三方'));
      top.append(!anyOn ? badge('停用') : (needModels ? badge('缺模型', 'warn') : badge('正常', 'ok')));
      card.append(top);
      card.append(el('div', 'nm', g.name || '未命名服务'));
      /* 2026-11-16：卡片上不再显示服务商地址。用户原话「保存完的卡片上不要显示
         服务商地址了」。卡片要回答的是「这服务能用吗、几把密钥、几个模型」，
         地址是配置细节，编辑面板里看得到，铺在首页只是噪音。 */
      var meta = el('div', 'meta');
      /* 不再显示「服务商 <group>」：group 是后端内部聚合键（值是第一条
         provider 的 id），别的卡片没有，露出来就成了一张卡比别人多一个标签。 */
      meta.append(chip(keys.length + ' 把密钥'));
      /* 2026-11-16：模型数只数启用的。取消勾选的模型会归档成 enabled:false 留在
         数组里（不丢历史元数据），数 length 会让「取消了还显示 4 个」——用户会以为
         保存没生效。总数不丢，有停用的补一句「共 N」。 */
      var allM = keys.reduce(function (n, k) { return n + (k.models || []).length; }, 0);
      var onM = keys.reduce(function (n, k) {
        return n + (k.models || []).filter(function (m) { return typeof m === 'string' || m.enabled !== false; }).length;
      }, 0);
      meta.append(chip(onM + ' 模型' + (allM > onM ? '（共 ' + allM + '）' : '')));
      card.append(meta);
      var list = el('div', 'keylist');
      keys.forEach(function (k) { list.append(svcKeyRow(S, k)); });
      card.append(list);
      /* 服务商级三个按钮：卡片最底部一行（.foot 有 margin-top:auto + 顶部
         分隔线 + flex:1 等宽），作用于整个服务商；key 级的编辑/启停/删除
         全在编辑面板里，卡片上不出现。
         2026-11-16：原来用的是 .cacts，它既没有 margin-top:auto 也没分隔线、
         还把它放在 keylist 前面，于是三个按钮浮在卡片中间、小得像标签。 */
      var foot = el('div', 'foot');
      foot.append(btn('编辑', 'btn', function () {
        M.sheets.providerEdit && M.sheets.providerEdit(S, keys[0]);
      }));
      foot.append(btn(anyOn ? '停用' : '启用', 'btn', function () {
        svcToggle(S, keys, anyOn, g.name || '未命名服务');
      }));
      foot.append(btn('删除', 'btn danger', function () {
        svcDeleteConfirm(S, keys, g.name || '未命名服务');
      }));
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
  /* 一行密钥：主显人读的名字，变量名降到小字。
     以前直接把 CUSTOM_UMU5G7PYGOZES_API_KEY 顶在最前面，用户根本认不出
     它是 DeepSeek 官方那条服务的 key —— 同一个东西在服务商页叫名字，到这里
     变成内部 id，两页对不上号，看着就像两块功能在重复。 */
  function keyRow(S, k) {
    var tone = k.orphan ? ' bad' : (k.configured ? (k.active ? '' : ' off') : ' miss');
    var row = el('div', 'krow' + tone);
    var main = el('div', 'kmain');
    var title = el('div', 'ktitle');
    title.append(el('span', 'kname', k.label || k.name));
    if (k.orphan) title.append(badge('引用失效', 'err'));
    else if (!k.configured) title.append(badge('缺密钥', 'err'));
    else if (!k.active) title.append(badge('备着'));
    else title.append(badge('在用', 'ok'));
    main.append(title);
    var sub = el('div', 'ksub');
    sub.append(el('span', 'mono kvar', k.name));
    if (k.hint) sub.append(el('span', 'mini', ' ' + k.hint));
    main.append(sub);
    if (k.used_by && k.used_by.length) main.append(el('div', 'mini kuse', '用于 ' + k.used_by.join('、')));
    // 真孤儿（这条变量没有任何有效使用者）才在行里铺原因；只是「另有引用失效」
    // 的话给一句短的 —— 把整段原因抄到每行，等于同一句话在页面上喊两遍。
    if (k.orphan) {
      (k.orphans || []).forEach(function (why) { main.append(el('div', 'mini kbad', why)); });
    } else if ((k.orphans || []).length) {
      main.append(el('div', 'mini knote', '另有 ' + k.orphans.length + ' 处引用已失效，见上方提示'));
    }
    row.append(main);
    var act = el('div', 'kact');
    act.append(btn(k.configured ? '改值' : '填值', 'btn sm' + (k.configured ? '' : ' primary'),
      function () { M.sheets.keyEdit && M.sheets.keyEdit(S, k); }));
    row.append(act);
    return row;
  }

  function providersKeys(S) {
    var out = frag();
    var K = S.keys || {};
    var groups = K.groups || [];
    var orphans = K.orphans || [];
    out.append(ph('密钥', '凭据仓库 · 主显服务名，变量名在下面', [
      btn('+ 添加密钥', 'btn sm primary', function () { M.sheets.keyAdd && M.sheets.keyAdd(S); })
    ]));
    // 三块面板各管一件事，用户分不清就会觉得在重复做。摆在一句话里。
    out.append(el('div', 'keylead',
      '这一页只管「钥匙是什么」。连哪个地址、有哪些模型在服务商页；用谁干活在能力后端页。'));

    if (orphans.length) {
      var warn = el('div', 'keywarn');
      warn.append(el('b', null, '有引用指不到东西'));
      orphans.forEach(function (o) { warn.append(el('div', 'mini', o.reason)); });
      out.append(warn);
    }

    if (!groups.length) {
      out.append(el('div', 'empty', 'config 里没有引用任何环境变量'));
    } else {
      groups.forEach(function (g) {
        out.append(panel(g.label + '（' + g.keys.length + '）',
          g.keys.map(function (k) { return keyRow(S, k); })));
      });
    }
    out.append(el('p', 'mini', '值写进 ' + (K.env_file || 'config 同目录 .env') +
      '（现有 ' + (K.env_count || 0) + ' 个变量），config.yaml 里用 ${KEY} 引用，不落明文。变量名不能在这里改：config 引用着它，改名要连 config 一起改。'));
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
      kv('服务商', ds.name || ds.id),
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
  /* 能力卡上的凭据区：这张卡当前选的来源要哪把钥匙、配了没有、去哪儿填。
     以前只有生图卡在 meta 里塞一句「FAL_KEY · 未配置」，别的卡什么都没有，
     用户得自己猜到「密钥」页去找 —— 而现在密钥页显示的是变量名，对不上号。 */
  function credBlock(S, d) {
    var creds = d.creds || [];
    var wrap = el('div', 'cardcred');
    // 「密钥」提成整块的小标题：有凭据的卡和没凭据的卡否则长得不一样，
    // 用户扫一排卡片时会觉得有的卡少了点东西。
    wrap.append(el('div', 'credhead', '密钥'));
    if (!creds.length) {
      // 空着最误导：一张卡什么都不提，会被当成「漏了没配」。
      var plain = el('div', 'credrow');
      var text = d.cred_state === 'inherit' ? '继承主模型，无需单独密钥'
        : d.cred_state === 'unset' ? '还没选来源'
        : '无需密钥（本机运行）';
      plain.append(el('span', 'mini credreuse', text));
      wrap.append(plain);
      return wrap;
    }
    creds.forEach(function (c) {
      var line = el('div', 'credrow' + (c.configured ? '' : ' miss'));
      line.append(el('span', 'credname', c.label));
      if (c.reuse) {
        line.append(el('span', 'mini credreuse', c.hint || '用服务商页配好的那条'));
      } else {
        line.append(el('span', 'mono credvar', c.name));
        line.append(c.configured ? badge('已配', 'ok') : badge('缺', 'err'));
        line.append(btn(c.configured ? '改值' : '填值', 'btn sm' + (c.configured ? '' : ' primary'),
          function () {
            if (!M.sheets.keyEdit) return;
            M.sheets.keyEdit(S, { name: c.name, label: c.label, configured: c.configured,
                                   hint: c.hint, used_by: [d.label], orphans: [] });
          }));
      }
      wrap.append(line);
    });
    return wrap;
  }

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
      if (d.note && d.kernel !== false) meta.append(chip(d.note));
      card.append(meta);

      // 内核不读这张卡的键（目前只有 ocr）就先说清楚，别让用户以为换一下引擎就换了。
      if (d.kernel === false) {
        var warn = el('div', 'cardwarn');
        warn.append(el('b', null, '这张卡的选项内核不读'));
        warn.append(el('div', 'mini', d.note || ''));
        card.append(warn);
      }
      var cb = credBlock(S, d);
      if (cb) card.append(cb);

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
      el('p', 'mini', '凭据就在卡片上：选完来源，卡里会列出它要的变量、显示配了没有，点「填值」直接写 .env。不用自己记变量名。'),
      el('p', 'mini', '文字识别这张卡特殊：内核没有 ocr 配置段（hermes-src 里 grep baimiao 是 0 命中），真干活的是 baimiao-ocr 技能，它只读 .env 的 BAIMIAO_USER / BAIMIAO_PASS。所以这张卡的选项只当备忘。'),
      el('p', 'mini', '生图选「自定义中转站」时没有独立凭据，直接复用你选的那条 LLM 服务的地址和密钥。三套端点自动依次尝试：/v1/images/generations → /v1/chat/completions → /v1beta/models/<模型>:generateContent，哪套通就用哪套。'),
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
