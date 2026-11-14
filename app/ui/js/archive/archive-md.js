/* 档案 · Markdown 渲染与目录大纲
 * 走面板已经在用的 marked + DOMPurify（不另造一套解析器），在这之上补三件案例里做的事：
 *   1. [[双链]] 变成可点链接
 *   2. 标题生成稳定 id，右侧目录能跳
 *   3. 代码块标语言、外链新窗口
 * 渲染完之后再做 DOM 后处理，不改全局 marked 配置，避免影响聊天区的渲染。 */
window.Archive.register('md', (function () {
  'use strict';

  function slug(text, used) {
    var base = String(text || '').trim().toLowerCase()
      .replace(/[\s\u3000]+/g, '-')
      .replace(/[^\w\u4e00-\u9fa5-]/g, '')
      .replace(/^-+|-+$/g, '') || 'section';
    var id = base, n = 1;
    while (used[id]) id = base + '-' + (++n);
    used[id] = true;
    return 'h-' + id;
  }

  /* [[目标]] / [[目标|显示名]] → <a class="arc-wiki" data-wiki="目标"> */
  function wikilinks(text) {
    return String(text || '').replace(/\[\[([^\[\]|]{1,200})(?:\|([^\[\]]{1,200}))?\]\]/g, function (all, target, label) {
      var name = String(target || '').trim();
      var shown = String(label || name).trim();
      return '<a class="arc-wiki" data-wiki="' + name.replace(/"/g, '&quot;') + '" href="#wiki">' + shown + '</a>';
    });
  }

  function sanitize(html) {
    if (!window.DOMPurify) return html;
    return window.DOMPurify.sanitize(html, {
      ADD_ATTR: ['data-lang', 'data-wiki', 'target', 'rel', 'id'],
      ADD_TAGS: ['mark']
    });
  }

  var LANG_LABEL = {
    yaml: 'YAML', yml: 'YAML', json: 'JSON', js: 'JavaScript', ts: 'TypeScript',
    py: 'Python', text: 'TEXT', log: 'LOG', bash: 'BASH', sh: 'SHELL', shell: 'SHELL',
    css: 'CSS', html: 'HTML', md: 'MARKDOWN', sql: 'SQL', diff: 'DIFF', jsx: 'JSX'
  };

  /* 复制代码：navigator.clipboard 在非 https 的内网地址上会被禁，必须留 execCommand 兜底 */
  function copyCode(text, btn) {
    var done = function (ok) {
      var label = btn.querySelector('span');
      var old = label ? label.textContent : btn.textContent;
      if (label) label.textContent = ok ? '已复制' : '复制失败';
      else btn.textContent = ok ? '已复制' : '复制失败';
      btn.classList.toggle('is-ok', ok);
      setTimeout(function () {
        if (label) label.textContent = old; else btn.textContent = old;
        btn.classList.remove('is-ok');
      }, 1400);
    };
    var fallback = function () {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.append(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (_) {}
      ta.remove();
      done(ok);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, fallback);
      return;
    }
    fallback();
  }

  function decorate(root) {
    var used = Object.create(null);
    root.querySelectorAll('h1,h2,h3,h4').forEach(function (h) {
      if (!h.id) h.id = slug(h.textContent, used);
      else used[h.id] = true;
    });
    /* 代码块照案例重做：三圆点 + 语言标签 + 复制 + 行号槽 + 空态。
       原来只给 pre 挂一个 data-lang，CSS 用 ::before 贴在右上角，看着像没做完的工具。 */
    root.querySelectorAll('pre').forEach(function (pre) {
      if (pre.closest('.arc-code')) return;
      var code = pre.querySelector('code');
      var m = /language-([\w+#-]+)/.exec((code && code.className) || '');
      var lang = m ? m[1] : 'text';
      var raw = (code ? code.textContent : pre.textContent) || '';
      var empty = raw.trim() === '';
      var lines = raw.replace(/\n$/, '').split('\n');

      var box = document.createElement('div');
      box.className = 'arc-code' + (empty ? ' is-empty' : '');

      var head = document.createElement('div');
      head.className = 'arc-code-head';
      var dots = document.createElement('span');
      dots.className = 'arc-code-dots';
      dots.innerHTML = '<i></i><i></i><i></i>';
      var lb = document.createElement('span');
      lb.className = 'arc-code-lang';
      lb.textContent = LANG_LABEL[lang] || String(lang).toUpperCase();
      var cp = document.createElement('button');
      cp.type = 'button';
      cp.className = 'arc-code-copy';
      cp.append(window.Archive.svgIcon('copy', 13), window.Archive.el('span', '复制'));
      cp.addEventListener('click', function () { copyCode(raw, cp); });
      head.append(dots, lb, cp);
      box.append(head);

      if (empty) {
        var e = document.createElement('div');
        e.className = 'arc-code-empty';
        e.textContent = '空代码块 · 暂无内容';
        box.append(e);
      } else {
        var body = document.createElement('div');
        body.className = 'arc-code-body';
        var gut = document.createElement('div');
        gut.className = 'arc-code-gutter';
        for (var li = 1; li <= lines.length; li++) {
          var sn = document.createElement('span');
          sn.textContent = String(li);
          gut.append(sn);
        }
        var pre2 = document.createElement('pre');
        pre2.className = 'arc-code-pre';
        var code2 = document.createElement('code');
        code2.textContent = lines.join('\n');
        pre2.append(code2);
        body.append(gut, pre2);
        box.append(body);
      }
      pre.replaceWith(box);
    });
    root.querySelectorAll('table').forEach(function (t) {
      if (t.parentElement.classList.contains('arc-table-wrap')) return;
      var wrap = document.createElement('div');
      wrap.className = 'arc-table-wrap';
      t.replaceWith(wrap);
      wrap.append(t);
    });
    root.querySelectorAll('a[href]').forEach(function (a) {
      if (a.classList.contains('arc-wiki')) return;
      var href = a.getAttribute('href') || '';
      if (/^https?:/i.test(href)) {
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      }
    });
    root.querySelectorAll('input[type="checkbox"]').forEach(function (box) {
      box.disabled = true;
    });
    /* 文档里经常把图片路径当示例写（如 ![](.../<名字>.gif)），markdown 会当图片请求，必然 403。
       加载不到就收起来，别在正文里留一排破图图标。 */
    root.querySelectorAll('img').forEach(function (img) {
      img.loading = 'lazy';
      var hide = function () { img.style.display = 'none'; };
      img.addEventListener('error', hide);
      if (img.complete && img.naturalWidth === 0) hide();
    });
  }

  function render(text) {
    /* frontmatter 不渲染：以前 `--- created: ... tags: - 概念 ---` 被当成水平线 + 段落 + 列表
       直接铺在正文最上方（用户看到的"裸显 ---"就是这个）。元信息归「信息」面板管。 */
    var body = String(text || '');
    if (body.slice(0, 3) === '---' && window.Archive && window.Archive.fm) {
      body = window.Archive.fm.split(body).body;
    }
    var src = wikilinks(body);
    var html;
    try {
      html = (window.marked && window.marked.parse)
        ? window.marked.parse(src, { gfm: true, breaks: false })
        : '<pre>' + String(src).replace(/[<>&]/g, function (c) { return { '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]; }) + '</pre>';
    } catch (err) {
      html = '<pre>' + String(src).replace(/[<>&]/g, function (c) { return { '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]; }) + '</pre>';
    }
    return sanitize(html);
  }

  /* 正文渲染：返回根节点，附带 ARC: 大纲交给调用方取 */
  function paint(host, text) {
    host.innerHTML = render(text);
    decorate(host);
    return outline(host);
  }

  function outline(host) {
    var heads = [].slice.call(host.querySelectorAll('h1,h2,h3,h4'));
    return heads.filter(function (h) { return h.textContent.trim(); }).map(function (h) {
      return { id: h.id, text: h.textContent.trim(), level: Number(h.tagName.slice(1)) };
    });
  }

  /* 目录：h1/h2/h3 三级，点击滚动并高亮；滚动时自动跟随当前章节（scroll-spy）。
     旧版只有点击才高亮，滚到哪都看不出在哪一节；截断的长标题也没有 title 可悬停。 */
  function mountOutline(host, items, scroller) {
    var box = document.createElement('aside');
    box.className = 'arc-outline';
    box.setAttribute('aria-label', '目录');
    if (!items.length) { box.hidden = true; return box; }
    var title = document.createElement('p');
    title.className = 'arc-outline-title';
    title.append(document.createTextNode('目录'));
    var count = document.createElement('span');
    count.className = 'arc-outline-n';
    count.textContent = String(items.filter(function (i) { return i.level <= 3; }).length);
    title.append(count);
    box.append(title);

    var nav = document.createElement('nav');
    var rows = [];
    /* 阅读区上沿：文档头 sticky 高度 + 一点余量。跳转和「当前章节」判定共用同一个值。 */
    function topEdge() {
      var page = host.closest('.arc-page') || document;
      var dh = page.querySelector('.arc-doc-head');
      return (dh ? dh.getBoundingClientRect().height : 0) + 12;
    }
    function jump(item, btn) {
      var target = host.querySelector('#' + CSS.escape(item.id));
      if (!target) return;
      /* 不用 scrollIntoView：标题带 scroll-margin-top:96px，嵌套滚动容器会被一层层各滚一次，
         实测多滚 191px，标题直接跑到视口上方（2026-11-14 抓到的）。只滚 .arc-main 一条。 */
      var main = host.closest('.arc-main');
      if (main && main.scrollTo) {
        /* 落点比判定线再往里 14px：正好压在线上时，0.4px 的亚像素误差就会让
           「当前章节」判定拿不到这一项，高亮停在上一节（2026-11-14 实测踩到）。 */
        var top = target.getBoundingClientRect().top - main.getBoundingClientRect().top
                + main.scrollTop - topEdge() + 14;
        main.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      } else {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      paint(btn);
    }
    items.forEach(function (item) {
      if (item.level > 3) return;
      var b = Object.assign(document.createElement('button'), {
        className: 'arc-outline-item lv' + item.level, textContent: item.text, type: 'button',
        title: item.text
      });
      b.onclick = function () { jump(item, b); };
      rows.push({ item: item, btn: b });
      nav.append(b);
    });
    box.append(nav);

    function paint(active) {
      for (var i = 0; i < rows.length; i++) rows[i].btn.classList.toggle('on', rows[i].btn === active);
    }

    /* 当前章节 = 最后一个顶边已越过阅读区上沿的标题。
       比 IntersectionObserver 好判，也好收拾（换文档时能干净摘掉）。 */
    var main = (host.closest && host.closest('.arc-main')) || document.scrollingElement || document.body;
    var frame = 0;
    function follow() {
      frame = 0;
      var base = main === document.body ? 0 : main.getBoundingClientRect().top;
      var edge = topEdge();
      var active = null;
      for (var i = 0; i < rows.length; i++) {
        var head = host.querySelector('#' + CSS.escape(rows[i].item.id));
        if (!head) continue;
        if (head.getBoundingClientRect().top - base <= edge) active = rows[i].btn;
        else break;
      }
      paint(active || (rows.length ? rows[0].btn : null));
    }
    function onScroll() { if (!frame) frame = requestAnimationFrame(follow); }
    if (main && main.addEventListener) main.addEventListener('scroll', onScroll, { passive: true });
    box.__cleanup = function () {
      if (main && main.removeEventListener) main.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    };
    follow();
    return box;
  }

  /* 双链解析：在当前资料的同一来源里找一个同名或同路径的笔记 */
  function wireWiki(root, st, api) {
    root.addEventListener('click', function (ev) {
      var a = ev.target.closest('.arc-wiki');
      if (!a) return;
      ev.preventDefault();
      var name = a.dataset.wiki || '';
      if (!name) return;
      /* 用完整目录找，不用 rowsOf：rowsOf 会带上左栏筛选词，筛选状态下点引用就找不到目标了 */
      var items = (st.catalog && st.catalog.items) || [];
      var bare = name.replace(/\.md$/i, '').toLowerCase();
      var hit = items.find(function (item) {
        return item.path === name || item.path === name + '.md';
      }) || items.find(function (item) {
        return (item.path || '').replace(/\.md$/i, '').toLowerCase().endsWith('/' + bare);
      }) || items.find(function (item) {
        return (item.title || '').replace(/\.md$/i, '').toLowerCase() === bare;
      });
      if (hit) api.open(hit.source, hit.path);
      else api.toast('没找到「' + name + '」对应的笔记', 'warn');
    });
  }

  return { render: render, paint: paint, outline: outline, mountOutline: mountOutline, wireWiki: wireWiki, decorate: decorate };
})());
