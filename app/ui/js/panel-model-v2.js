/* 模型页 · 六域工作台 — 骨架
 * 2026-11-15 整页重构。本文件只管：数据加载、域路由、弹层容器、toast、写操作。
 * 六个域的渲染在 panel-model-v2-pages.js，十二种弹层在 panel-model-v2-sheets.js。
 * 三者通过 window.MV2 共享命名空间，加载顺序由 index.html 的 script 顺序保证。
 */
(function () {
  'use strict';

  var DOMAINS = [
    ['home', '概览'],
    ['select', '模型选择'],
    ['providers', '服务商'],
    ['backends', '能力后端'],
    ['toolsets', '工具集'],
    ['config', '配置']
  ];

  var S = {
    domain: 'home',
    tab: {},
    catalog: null,
    keys: null,
    backends: null,
    toolsets: null,
    preview: null,
    audit: null,
    moa: null,
    aux: null,
    caps: null,
    loaded: false,
    error: ''
  };

  function url(path) {
    return typeof window.apiUrl === 'function' ? window.apiUrl(path) : path;
  }

  function headers() {
    return { 'Content-Type': 'application/json', 'X-Monitor-Token': window.monitorToken || '' };
  }

  async function post(body) {
    var response = await fetch(url('/api/panel-models'), {
      method: 'POST', headers: headers(), body: JSON.stringify(body), cache: 'no-store'
    });
    var out = await response.json().catch(function () { return {}; });
    if (!response.ok || !out.ok) {
      var error = Error(out.error || '模型配置操作失败');
      error.status = response.status;
      throw error;
    }
    return out;
  }

  async function auxGet() {
    var response = await fetch(url('/api/panel-models/auxiliary'), {
      method: 'GET', headers: headers(), cache: 'no-store'
    });
    var out = await response.json().catch(function () { return {}; });
    if (!response.ok || !out.ok) {
      var error = Error(out.error || '辅助模型读取失败');
      error.status = response.status;
      throw error;
    }
    return out;
  }

  async function auxPatch(body) {
    var response = await fetch(url('/api/panel-models/auxiliary'), {
      method: 'PATCH', headers: headers(), body: JSON.stringify(body), cache: 'no-store'
    });
    var out = await response.json().catch(function () { return {}; });
    if (!response.ok || !out.ok) {
      var error = Error(out.error || '辅助模型保存失败');
      error.status = response.status;
      throw error;
    }
    return out;
  }

  async function voiceGet() {
    var response = await fetch(url('/api/panel-models/voice'), {
      method: 'GET', headers: headers(), cache: 'no-store'
    });
    var out = await response.json().catch(function () { return {}; });
    if (!response.ok || !out.ok) {
      var error = Error(out.error || '语音配置读取失败');
      error.status = response.status;
      throw error;
    }
    return out;
  }

  async function voicePatch(body) {
    var response = await fetch(url('/api/panel-models/voice'), {
      method: 'PATCH', headers: headers(), body: JSON.stringify(body), cache: 'no-store'
    });
    var out = await response.json().catch(function () { return {}; });
    if (!response.ok || !out.ok) {
      var error = Error(out.error || '语音配置保存失败');
      error.status = response.status;
      throw error;
    }
    return out;
  }

  /* ── DOM 小工具 ─────────────────────────────────────── */
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function btn(text, cls, run) {
    var node = el('button', cls || 'mv2-btn', text);
    node.type = 'button';
    if (run) node.onclick = run;
    return node;
  }

  function badge(text, tone) {
    return el('span', 'mv2-badge' + (tone ? ' ' + tone : ''), text);
  }

  function chip(text, tone) {
    return el('span', 'mv2-chip' + (tone ? ' ' + tone : ''), text);
  }

  function sec(title, sub) {
    var box = el('div', 'mv2-sec');
    if (title || sub) {
      var head = el('div', 'mv2-sec-head');
      if (title) head.append(el('h3', 'mv2-sec-title', title));
      head.append(el('div', 'mv2-right'));
      box.append(head);
      if (sub) box.append(el('p', 'mv2-sec-sub', sub));
    }
    return box;
  }

  function field(label, control, hint, required) {
    var box = el('div', 'mv2-field');
    var tag = el('label', 'mv2-label', label);
    if (required) tag.append(el('span', 'mv2-req', '*'));
    box.append(tag, control);
    if (hint) box.append(el('span', 'mv2-hint', hint));
    return box;
  }

  function input(value, placeholder) {
    var node = el('input', 'mv2-input');
    node.type = 'text';
    node.value = value == null ? '' : String(value);
    if (placeholder) node.placeholder = placeholder;
    return node;
  }

  function select(options, value) {
    var node = el('select', 'mv2-select');
    (options || []).forEach(function (option) {
      var item = Array.isArray(option) ? option : [option, option];
      var opt = el('option', null, item[1] === '' ? '（不指定，自动）' : item[1]);
      opt.value = item[0];
      if (String(item[0]) === String(value)) opt.selected = true;
      node.append(opt);
    });
    return node;
  }

  function toast(message, bad) {
    var node = document.getElementById('mv2Toast');
    if (!node) {
      node = el('div', 'mv2-toast');
      node.id = 'mv2Toast';
      document.body.append(node);
    }
    node.textContent = message;
    node.className = 'mv2-toast show' + (bad ? ' bad' : '');
    clearTimeout(node._timer);
    node._timer = setTimeout(function () { node.className = 'mv2-toast' + (bad ? ' bad' : ''); }, bad ? 4200 : 2400);
  }

  /* ── 弹层 ───────────────────────────────────────────── */
  var sheetNode = null;

  function sheet(options) {
    closeSheet();
    var overlay = el('div', 'mv2-overlay');
    var box = el('div', 'mv2-sheet' + (options.wide ? ' wide' : ''));

    var head = el('div', 'mv2-sheet-head');
    var titles = el('div');
    titles.append(el('h2', null, options.title || ''));
    if (options.sub) titles.append(el('p', null, options.sub));
    head.append(titles);
    var x = btn('×', 'mv2-sheet-x', closeSheet);
    x.setAttribute('aria-label', '关闭');
    head.append(x);

    var body = el('div', 'mv2-sheet-body');
    if (options.body) body.append(options.body);

    var foot = el('div', 'mv2-sheet-foot');
    (options.foot || []).forEach(function (item) {
      if (!item) return;
      if (item === 'left') { foot.append(el('span', 'mv2-left')); return; }
      foot.append(item);
    });

    // foot 一定要挂进 DOM：多步向导（换主模型 / 添加服务）会在这个容器上
    // replaceChildren() 重建按钮，不挂进来按钮就永远点不到。
    box.append(head, body, foot);
    overlay.append(box);
    overlay.onclick = function (event) { if (event.target === overlay) closeSheet(); };
    document.body.append(overlay);
    sheetNode = overlay;

    var first = body.querySelector('input,select,textarea,button');
    if (first) setTimeout(function () { try { first.focus(); } catch (_) {} }, 60);
    return { overlay: overlay, box: box, body: body, foot: foot, close: closeSheet };
  }

  function closeSheet() {
    if (sheetNode && sheetNode.parentNode) sheetNode.parentNode.removeChild(sheetNode);
    sheetNode = null;
  }

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && sheetNode) closeSheet();
  });

  /* ── 写操作 ─────────────────────────────────────────── */
  function pending() {
    try { window.panelRuntimeRefresh?.(); } catch (_) {}
  }

  /* 写操作统一走这里：revision 冲突自动重读，不让用户对着旧表单反复失败。 */
  async function mutate(body, options) {
    options = options || {};
    try {
      var out = await post(body);
      if (out.changed === false) toast(options.unchanged || '没有变化');
      else toast(options.done || '已保存');
      if (out.changed !== false) pending();
      await load(options.reload || null);
      return out;
    } catch (error) {
      if (error.status === 409) {
        toast('配置刚在别处改过，已刷新，请再操作一次', true);
        await load();
        return null;
      }
      toast(error.message, true);
      throw error;
    }
  }

  async function auxMutate(body, options) {
    options = options || {};
    try {
      var out = await auxPatch(body);
      toast(options.done || '已保存');
      pending();
      S.aux = await auxGet();
      await load(['catalog']);
      render();
      return out;
    } catch (error) {
      if (error.status === 409) {
        toast('辅助模型刚在别处改过，已刷新', true);
        S.aux = await auxGet();
        render();
        return null;
      }
      toast(error.message, true);
      throw error;
    }
  }

  /* ── 数据加载 ───────────────────────────────────────── */
  async function load(parts) {
    var want = function (name) { return !parts || parts.indexOf(name) >= 0; };
    var jobs = [];
    if (want('catalog')) jobs.push(post({ action: 'read' }).then(function (out) { S.catalog = out; }));
    if (want('aux')) jobs.push(auxGet().then(function (out) { S.aux = out; }).catch(function () { S.aux = S.aux || { tasks: [], services: [] }; }));
    if (want('moa')) jobs.push(post({ action: 'moa_read' }).then(function (out) { S.moa = out; }).catch(function () { S.moa = S.moa || null; }));
    if (want('keys')) jobs.push(post({ action: 'keys' }).then(function (out) { S.keys = out; }).catch(function () { S.keys = S.keys || { keys: [] }; }));
    if (want('backends')) jobs.push(post({ action: 'backends' }).then(function (out) { S.backends = out; }).catch(function () { S.backends = S.backends || { domains: [] }; }));
    if (want('toolsets')) jobs.push(post({ action: 'toolsets' }).then(function (out) { S.toolsets = out; }).catch(function () { S.toolsets = S.toolsets || { toolsets: [] }; }));
    if (want('preview')) jobs.push(post({ action: 'config_preview' }).then(function (out) { S.preview = out; }).catch(function () { S.preview = S.preview || null; }));
    if (want('audit')) jobs.push(post({ action: 'audit' }).then(function (out) { S.audit = out; }).catch(function () { S.audit = S.audit || { snapshots: [] }; }));
    if (want('caps')) jobs.push(post({ action: 'cap_matrix' }).then(function (out) { S.caps = out; }).catch(function () { S.caps = S.caps || null; }));
    if (want('voice')) jobs.push(voiceGet().then(function (out) { S.voice = out; }).catch(function () { S.voice = S.voice || null; }));
    var results = await Promise.allSettled(jobs);
    var failed = results.filter(function (row) { return row.status === 'rejected'; });
    S.loaded = true;
    S.error = failed.length ? '部分数据读取失败，可点右上角刷新重试' : '';
    return S;
  }

  /* ── 路由与渲染 ─────────────────────────────────────── */
  function go(domain, tab) {
    if (domain) S.domain = domain;
    if (tab) S.tab[S.domain] = tab;
    closeSheet();
    render();
    try { history.replaceState(null, '', '#' + S.domain + (S.tab[S.domain] ? '/' + S.tab[S.domain] : '')); } catch (_) {}
  }

  function render() {
    var root = document.getElementById('mv2Root');
    if (!root) return;
    /* 页头标题由 panel-navigation 的 applyTitle 负责，这里不抢。 */
    document.querySelectorAll('#mv2DomainBar .mv2-tab').forEach(function (node) {
      node.classList.toggle('on', node.dataset.domain === S.domain);
    });
    root.replaceChildren();
    if (S.error) root.append(el('div', 'mv2-empty', S.error));
    if (!S.loaded) {
      root.append(el('div', 'mv2-empty', '正在读取配置…'));
      return;
    }
    var page = (window.MV2 && MV2.pages && MV2.pages[S.domain]) || null;
    if (!page) {
      root.append(el('div', 'mv2-empty', '这个域还没有渲染器'));
      return;
    }
    try {
      root.append(page(S));
    } catch (error) {
      var box = el('div', 'mv2-empty', '渲染失败：' + (error && error.message ? error.message : String(error)));
      root.append(box);
      if (window.console) console.error(error);
    }
  }

  /* ── 启动 ───────────────────────────────────────────── */
  function buildShell() {
    var host = document.getElementById('page-models');
    if (!host) return false;
    var body = host.querySelector('.page-body') || host;
    var existingRoot = document.getElementById('mv2Root');
    var existingBar = document.getElementById('mv2DomainBar');
    if (existingRoot && existingBar) return true;

    var bar = existingBar || el('div', 'mv2-tabs');
    bar.id = 'mv2DomainBar';
    bar.style.marginBottom = '14px';
    if (!bar.children.length) {
      DOMAINS.forEach(function (row) {
        var tab = btn(row[1], 'mv2-tab', function () { go(row[0]); });
        tab.dataset.domain = row[0];
        bar.append(tab);
      });
    }
    var root = existingRoot || el('div', 'mv2-shell');
    root.id = 'mv2Root';
    root.className = 'mv2-shell';
    body.replaceChildren(bar, root);
    var acts = document.getElementById('mv2HeadActs');
    if (acts && !acts.children.length) {
      acts.append(btn('刷新', 'ov-actbtn', async function () {
        S.loaded = false;
        render();
        try { await load(); toast('已刷新'); } catch (error) { toast(error.message, true); }
        render();
      }));
    }
    return true;
  }

  async function boot() {
    if (!buildShell()) return;
    var hash = (location.hash || '').replace(/^#/, '');
    if (hash) {
      var parts = hash.split('/');
      if (DOMAINS.some(function (row) { return row[0] === parts[0]; })) {
        S.domain = parts[0];
        if (parts[1]) S.tab[S.domain] = parts[1];
      }
    }
    render();
    try { await load(); } catch (error) { S.error = error.message; }
    render();
  }

  window.MV2 = {
    S: S, DOMAINS: DOMAINS,
    api: post, auxGet: auxGet, auxPatch: auxPatch, voiceGet: voiceGet, voicePatch: voicePatch,
    el: el, btn: btn, badge: badge, chip: chip, sec: sec, field: field, input: input, select: select,
    toast: toast, sheet: sheet, closeSheet: closeSheet,
    load: load, render: render, go: go, mutate: mutate, auxMutate: auxMutate,
    pending: pending, boot: boot,
    pages: {}, sheets: {}
  };

  /* 兼容：旧面板里的「刷新配置」等入口可能调 window.renderProviders */
  window.renderProviders = function () { S.loaded = false; render(); load().then(render).catch(function () {}); };
})();
