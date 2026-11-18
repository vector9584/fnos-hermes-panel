/* 画板模式（Canvas Mode）— 独立文件，2026-11-16
 *
 * 定位：会话的一种呈现方式，不是新页面、不是新会话体系。
 * 左侧会话树、顶部 header、会话管理全部沿用原有实现；
 * 本文件只把右侧正文区换成一张可以无限拖拽的画布，
 * 把「一轮对话」画成「一个节点 + 一条连向下一张图的线」。
 *
 * 复用而非重写（用户原话：「接口什么的我们都有了，但是要换一种呈现方式」）：
 * - 发消息：写 #chatInput + _pendingAttachments，调全局 sendChat()
 * - 上传：全局 uploadAttachment(file, '/api/chat/upload-image')
 * - 模型：/api/workspace-ui/image-targets（唯一真源是 config.yaml 的 image_gen 段）
 * - 持久化：localStorage per session，不碰后端会话库
 *
 * 为什么 #chatBody 保留在 DOM 里只是隐藏：sendRaw / SSE / 工具调用全都挂在它上面，
 * 移除会打断整条发送链路。画布是叠加层，不是替代品。
 */
var CanvasMode = (function () {
  'use strict';

  var MIN_K = 0.25, MAX_K = 2.5;

  var S = {
    sid: null,
    on: false,
    nodes: {},        // id -> {id, kind, x, y, el, parentId, url, text, injected}
    order: [],        // 节点创建顺序，用于连线与重排
    view: { x: 0, y: 0, k: 1 },
    stage: null,
    host: null,       // chatBody 的父节点；视图切换按钮挂这里，不受 stage 显隐影响
    world: null,
    svg: null,
    observer: null,
    busy: false,
    viewMode: 'canvas',   // 'canvas' | 'chat'，同一会话两种呈现（2026-11-16）
    layout: 'vertical',   // 'vertical' 上→下 | 'horizontal' 左→右（2026-11-16 用户要可选）
    activeParent: null,   // 最近一次发消息的节点，新图挂到它下面
    seenImgs: {},         // 已渲染过的图片 src，防重复建节点
    drag: null,
    pan: null
  };

  /* ────────────── 小工具 ────────────── */

  function uid(p) { return (p || 'n') + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7); }

  function mk(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  function storeKey(sid) { return 'hermes_canvas_' + sid; }

  function save() {
    if (!S.sid) return;
    try {
      var data = {
        version: 3,
        view: S.view,
        order: S.order,
        nodes: S.order.map(function (id) {
          var n = S.nodes[id];
          /* injected 也存（2026-11-16）：点连线要看注入原文，
             刷新后丢了就等于这功能只在当轮有效。截到 800 字防 localStorage 爆。 */
          return { id: n.id, kind: n.kind, x: n.x, y: n.y, parentId: n.parentId || '', refId: n.refId || '', url: n.url || '', text: n.text || '', injected: (n.injected || '').slice(0, 800) };
        })
      };
      localStorage.setItem(storeKey(S.sid), JSON.stringify(data));
    } catch (e) { /* 配额满了不该影响画板本身 */ }
  }

  function load() {
    if (!S.sid) return null;
    try {
      var raw = localStorage.getItem(storeKey(S.sid));
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  /* ────────────── 视图变换 ────────────── */

  function applyView() {
    if (!S.world) return;
    S.world.style.transform = 'translate(' + S.view.x + 'px,' + S.view.y + 'px) scale(' + S.view.k + ')';
    syncLinkWidth();
  }

  /* 连线线宽必须跟着缩放反向补偿（2026-11-17 实测根因）
     ────────────────────────────────────────────────────────────
     .cv-link 的 stroke-width:2 是**世界坐标**里的 2px，挂在 #canvasWorld 上，
     会跟着 transform 一起被 scale 缩。fitToNodes 在 15 个节点、总宽 4900px
     的画布上把 k 压到 0.25，屏幕上线只剩 2×0.25 = 0.5px，
     再叠上 a55 的 55% 透明度，抗锯齿一摊就是「一个像素都没有」。
     这就是用户反复说「连接线还是没有」的原因 —— path 一直在，d 也对，
     getBoundingClientRect 也有值，只是画出来淡到看不见。

     修法：stroke-width 取 2.5 / k，屏幕上恒定 2.5px。上限 12px 防止 k 极小时
     世界坐标线宽离谱（k=0.25 → 10px，屏幕正好 2.5px）。
     四档实测（都是 1:1 全图视觉复核）：
       2px + a70  「看不到」  ← 用户反馈的原始状态
       2px + a85  「勉强看到」
       2.5px+a85  「需要留意」
       3px 纯色   「一眼就看到」但略突兀
       2.5px 纯色 ← 定稿，看得见且不抢节点
     线本身只有 50–90px 长（节点世界坐标间距 45–370px），散在大画布上
     视觉权重低，只能靠线宽和纯色补。
     线本身只有 50–90px 长（节点世界坐标间距只有 45–370px），
     散在大画布上视觉权重低，只能靠线宽和纯色补。 */
  function syncLinkWidth() {
    if (!S.svg) return;
    var k = S.view.k || 1;
    var w = Math.min(12, 2.5 / k).toFixed(2);
    /* 必须写内联 style，不能写 presentation attribute（2026-11-17 实测打脸）：
       .cv-link 的 CSS 里写死 stroke-width:2，优先级高于 <path stroke-width="8">，
       setAttribute 写进去 computed 依然是 2px，屏幕上还是 0.5px。
       同一个坑在这个文件里已经踩过第二次（第一次是 stroke 颜色），
       SVG 的 presentation attribute 就是低于 CSS 规则，只有 element.style 能压过。 */
    var dash = (7 / k).toFixed(2) + ' ' + (6 / k).toFixed(2);
    Array.prototype.slice.call(S.svg.querySelectorAll('path[id^="cvlink_"]')).forEach(function (p) {
      p.style.strokeWidth = w;
      /* 虚线段同样得按 k 反向补偿（cv-link-live 的 7 6 在 0.25 下碎成 1.75/1.5，
         屏幕上等于一排气孔，看着还是「没有线」）。非 live 的实线不受影响。 */
      if (p.classList.contains('cv-link-live')) p.style.strokeDasharray = dash;
      else p.style.strokeDasharray = '';
    });
  }

  /* ── 输入框在画板里的位置（2026-11-16 用户第 45 条）──────────────
     「跟随画布那个功能不要了，就和在对话一样就放在下面吧」

     上一版把输入框锚到选中图的正下方，还跟着平移/缩放实时重算。
     用户看完说不要了 —— 那就整段删掉：画板里的输入框和普通对话一模一样，
     固定贴在底部居中（定位交给 #chatComposer 的 CSS，这里一个字都不设）。

     「点图 = 引用这张图」的语义没丢，只是不再用位置表达：
     节点加 .cv-node-active 高亮，placeholder 换成「基于这张图说点什么」。
     引用关系存在 S.activeComposerFor 里，跟输入框画在哪无关。

     删掉 syncComposerAnchor() / resetComposerPos() 两个函数和全部 5 处调用。
     applyView() 里也一并清干净 —— 那两条本来就是为锚点服务的。 */

  function screenToWorld(cx, cy) {
    var r = S.stage.getBoundingClientRect();
    return {
      x: (cx - r.left - S.view.x) / S.view.k,
      y: (cy - r.top - S.view.y) / S.view.k
    };
  }

  function centerWorld() {
    var r = S.stage.getBoundingClientRect();
    return screenToWorld(r.left + r.width / 2, r.top + r.height / 2);
  }

  /* ────────────── 节点 ────────────── */

  function addNode(spec) {
    var n = {
      id: spec.id || uid(spec.kind),
      kind: spec.kind || 'text',
      x: Math.round(spec.x || 0),
      y: Math.round(spec.y || 0),
      parentId: spec.parentId || '',
      /* 引用凭据（2026-11-17）：这张图【真的】引用了哪张图。跟 parentId 分开存，
         因为 parentId 只决定画在哪、连不连线，而 refId 是业务凭据 ——
         「引用是画布分支的基础数据」，没有引用就不该有线。 */
      refId: spec.refId || '',
      url: spec.url || '',
      text: spec.text || '',
      /* 这一轮实际发给 agent 的完整提示词（2026-11-16 加）：
         用户点了连线要看的是「注入的提示词」，不是他敲的那半句。
         注入文由 sendFrom 拼好塞进来，restore 时一并回填。 */
      injected: spec.injected || '',
      el: null
    };
    S.nodes[n.id] = n;
    if (S.order.indexOf(n.id) < 0) S.order.push(n.id);
    n.el = renderNode(n);
    S.world.appendChild(n.el);
    /* 强制一次同步排版（2026-11-17）：下一轮 freeSpot/placeChild 靠 nodeSize()
       读 offsetWidth，不先排版拿到的全是 0，节点会挤成一横排、连线全被压住。
       读一次 offsetWidth 就够了，不要为此加 rAF 打乱现有顺序。 */
    void n.el.offsetWidth;
    if (n.parentId) renderLink(n.parentId, n.id);
    /* 「画布开始了就不要开始节点」：真实节点一落，plus 当场让位。
       不放在 enter() 的 setTimeout 里统一清 —— backfillFromHistory 靠观察器异步补图，
       那次 prune 跑的时候图往往还没落，plus 就一直留在画布上（实测 plus=1、total=4）。 */
    if (n.kind !== 'plus') pruneStartNode();
    save();
    return n;
  }

  function renderNode(n) {
    var e;
    if (n.kind === 'plus') {
      e = mk('div', 'cv-node cv-plus', '<span class="cv-plus-icon">+</span>');
      e.onclick = function (ev) { ev.stopPropagation(); openComposer(n.id); };
    } else if (n.kind === 'image') {
      /* 点图 = 引用这张图（2026-11-16 用户第 43 条）：
         「我注意到你在图片上放了一个加号，不用这么麻烦的交互，
           点击图片，在图片下方弹出输入框，就等于引用了，不要增加没必要的交互。」
         上一版在右上角挂了个「＋」当分支入口 —— 删掉。点图本来就只有一个意思：
         以这张图为起点继续说，新图挂在它下面，兄弟自动并排。
         输入框由 openComposer() 定位到这张图正下方，视觉上就是「在图下面写」。 */
      /* 图片上不再压一行「点击继续编辑」（2026-11-17 用户）：那句话挡住图的一角，
         选中态本来就有发光边框，写着字反而多余。 */
      e = mk('div', 'cv-node cv-image',
        '<img src="' + DOM.escAttr(n.url) + '" alt="">');
      /* 图片下载完尺寸才定型（2026-11-17）：节点刚建时 img 还没加载，
         节点尺寸只有边框的 2px，靠 nodeSize 的后备值算出来的位置只是近似。
         图真出来之后重画一次连线，端点才对得上；父节点同理要跟着修正子节点。
         不重排整张图 —— 用户可能已经手动拖过位置，那样会把他摆的位子打乱。 */
      (function (node) {
        var im = e.querySelector('img');
        if (!im) return;
        var relink = function () {
          if (node.parentId) renderLink(node.parentId, node.id);
          S.order.forEach(function (cid) {
            var c = S.nodes[cid];
            if (c && c.parentId === node.id) renderLink(node.id, cid);
          });
        };
        if (im.complete && im.naturalWidth) { relink(); }
        else { im.addEventListener('load', relink, { once: true }); }
      })(n);
      e.onclick = function (ev) {
        ev.stopPropagation();
        openComposer(n.id);
        /* 点图把提示词浮层钉出来（2026-11-17 用户第 5 条：「点击图片之后顶上的那个
           悬浮提示词框怎么没了，那个要有啊」）。上一轮我把它当成要删的东西，删错了 ——
           要删的是图中间那块 text 节点、和输入框上面那条引用条，浮层本身是用户要看的东西。
           触屏没法 hover，所以点一下就钉住，点空白或点别的图才换/收。 */
        _tipPinned = true;
        showPromptTip(n, e);
      };
      bindPromptTip(n, e);
    } else if (n.kind === 'pending') {
      e = mk('div', 'cv-node cv-pending',
        '<div class="cv-spin"></div><div>正在生成…</div>');
    } else {
      e = mk('div', 'cv-node cv-text',
        '<span class="cv-text-tag">提示</span>' + DOM.escAttr(n.text));
      e.onclick = function (ev) { ev.stopPropagation(); openComposer(n.id); };
      bindPromptTip(n, e);
    }
    e.dataset.nid = n.id;
    e.style.left = n.x + 'px';
    e.style.top = n.y + 'px';
    bindNodeDrag(n, e);
    return e;
  }

  function nodeSize(n) {
    if (!n.el) return { w: 0, h: 0 };
    var w = n.el.offsetWidth, h = n.el.offsetHeight;
    /* 拿不到尺寸时给后备值（2026-11-17 实测）：回填历史时节点刚 appendChild，
       同步 JS 里浏览器还没排版 / 图片还没下载完，offsetWidth 是 0。
       原来返回 {0,0}，freeSpot 里 maxX = n.x + 0，于是每个新节点只比上一个
       前进固定的 160px —— 15 张图排成一串互相重叠的横排，连线全被压在节点下面，
       看着就是「PC 端画板没有连接线」。后备值取 .cv-image img 的 max 尺寸。 */
    /* 阈值 20 而不是 !w（2026-11-17 实测）：.cv-node 有 1px border，
       图片没下载完时 offsetWidth 是 2 而不是 0，!w 判断放过它，
       freeSpot 仍然只前进 2+160px，节点照样叠在一起。 */
    if (w < 20 || h < 20) {
      if (n.kind === 'image') return { w: 300, h: 300 };
      if (n.kind === 'text') return { w: 220, h: 80 };
      if (n.kind === 'pending') return { w: 300, h: 200 };
      return { w: 200, h: 100 };
    }
    return { w: w, h: h };
  }

  function setNodeKind(n, kind, extra) {
    n.kind = kind;
    if (extra) { if (extra.url) n.url = extra.url; if (extra.text) n.text = extra.text; }
    var fresh = renderNode(n);
    if (n.el && n.el.parentNode) n.el.parentNode.replaceChild(fresh, n.el);
    n.el = fresh;
    save();
  }

  /* 子节点落位（2026-11-16 用户要方向可选）：
     竖向 = 父下方，兄弟往右错开；
     横向 = 父右方，兄弟往下错开。
     sibIdx 允许外部显式传入 —— 整图重排时"已有几个孩子"这个数推不出正确位置。 */
  function placeChild(parentId, sibIdx) {
    var p = S.nodes[parentId];
    if (!p) {
      var c = centerWorld();
      return { x: c.x - 100, y: c.y - 50 };
    }
    var ps = nodeSize(p);
    var idx = (typeof sibIdx === 'number')
      ? sibIdx
      : S.order.filter(function (id) { return S.nodes[id] && S.nodes[id].parentId === parentId; }).length;

    if (S.layout === 'horizontal') {
      /* 横向：兄弟沿 y 轴排开，行高按父节点实际高度 + 间距 */
      var rowH = Math.max(150, ps.h || 150) + 56;
      return { x: p.x + ps.w + 120, y: p.y + idx * rowH };
    }
    /* 竖向：兄弟偏移按「节点宽 + 间距」递进。
       原来固定 34px，而图片节点两百多像素宽 —— 第二个孩子直接压在第一个上面。 */
    var step = Math.max(240, ps.w * 0.9) + 48;
    return {
      x: p.x + (ps.w / 2) - 100 + (idx * step),
      y: p.y + ps.h + 76
    };
  }

  /* ────────────── 连线 ────────────── */

  function dropLink(toId) {
    ['cvlink_'].forEach(function (pre) {
      var p = document.getElementById(pre + toId);
      if (p && p.parentNode) p.remove();
    });
  }

  function renderLink(fromId, toId) {
    var a = S.nodes[fromId], b = S.nodes[toId];
    /* 端点已经不存在（父节点被删 / plus 被收走）→ 撤掉旧 path，不能只 return：
       上一次画进去的那条会永远留在 SVG 里，看着就是「一根莫名其妙的悬空线」。 */
    if (!a || !b) { dropLink(toId); return; }
    var as = nodeSize(a), bs = nodeSize(b);
    var x1, y1, x2, y2, d;
    if (S.layout === 'horizontal') {
      /* 横向：父右边中点 → 子左边中点 */
      x1 = a.x + as.w; y1 = a.y + as.h / 2;
      x2 = b.x;        y2 = b.y + bs.h / 2;
      var dx = Math.max(40, Math.abs(x2 - x1) * 0.45);
      d = 'M' + x1 + ',' + y1 + ' C' + (x1 + dx) + ',' + y1 + ' ' + (x2 - dx) + ',' + y2 + ' ' + x2 + ',' + y2;
    } else {
      /* 竖向：父下边中点 → 子上边中点 */
      x1 = a.x + as.w / 2; y1 = a.y + as.h;
      x2 = b.x + bs.w / 2; y2 = b.y;
      var dy = Math.max(28, Math.abs(y2 - y1) * 0.45);
      d = 'M' + x1 + ',' + y1 + ' C' + x1 + ',' + (y1 + dy) + ' ' + x2 + ',' + (y2 - dy) + ' ' + x2 + ',' + y2;
    }
    var path = document.getElementById('cvlink_' + toId);
    if (!path) {
      /* 连线层没了就别硬画：补一层再画，实在补不出来就跳过，
         绝不让一条线把整轮发送打断（2026-11-16 实测就是这里抛的 null）。 */
      if (!S.svg || !S.svg.parentNode) {
        if (!S.world) return;
        S.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        S.svg.setAttribute('id', 'canvasLinks');
        /* 2026-11-17 实测根因：1px 的 SVG 挂在 0x0 的 #canvasWorld 里，
           SVG viewport 塌成 0.362px，所有 path 被裁在 viewport 外，
           overflow:visible 救不回来 —— PC 端连线一个像素都不出。
           给足尺寸；不设 viewBox，用户坐标仍 1:1 映射 CSS px，节点坐标不用动。 */
        S.svg.style.position = 'absolute';
        S.svg.style.left = '0';
        S.svg.style.top = '0';
        S.svg.style.width = '4000px';
        S.svg.style.height = '4000px';
        S.svg.style.overflow = 'visible';
        S.svg.style.pointerEvents = 'none';
        S.world.appendChild(S.svg);
      }
      path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('id', 'cvlink_' + toId);
      path.setAttribute('class', 'cv-link');
      S.svg.appendChild(path);
    }
    path.setAttribute('d', d);
    syncLinkWidth();

    /* 连线不再有任何交互（2026-11-17 用户第 3 条「把原来关于链接线的点击交互删了」）：
       16px 透明热区、pointer-events、hover 高亮全部撤掉。线只表达「这张图从哪来」，
       提示词一律在图片本身上看。留着热区等于留一个看不见的点击面，线一多就误触。 */
  }

  /* 悬停图片/提示节点 → 这张图是用什么提示词生成的（2026-11-16 用户第 46 条）。
     injected 里存的是整段注入模板，原样甩出来用户看不懂，
     正则拆成「提示词」和「目标模型」两段再显示。 */
  /* 发消息时前端会在用户原话后面接一段「【本轮参考上下文】…」「【画板生图】…」。
     引用、浮层、题卡要的是**用户自己写的那句话**，系统段一律在后脑勺切掉。 */
  function stripSysTail(t) {
    t = String(t || '');
    var i = t.search(/\n\s*【[^】]{1,20}】/);
    if (i >= 0) t = t.slice(0, i);
    return t.trim();
  }

  function promptFacts(n) {
    var src = n, guard = 0;
    while (src && !src.injected && src.parentId && guard++ < 8) src = S.nodes[src.parentId];
    var injected = (src && src.injected) || '';
    var said = stripSysTail((src && src.text) || n.text || '');
    var m = /生图目标：([^。\n]+)。提示词：([\s\S]*)$/.exec(injected);
    if (m) return { target: m[1].trim(), prompt: stripSysTail(m[2]), said: said };
    /* 回填来的节点 injected 直接就是那条 user 消息原文，前面还带着
       【画板生图】模板头 —— 有「提示词：」就从它后面取。 */
    var k = injected.indexOf('提示词：');
    var p = k >= 0 ? injected.slice(k + 4) : injected;
    return { target: '', prompt: stripSysTail(p), said: said };
  }

  /* 点节点 = 会话里一条真引用（2026-11-17 用户要求）。
     用户原话：「在画布中点击图片，实际上会话栏要引用生成的这个图片的会话气泡，
     以此建立连线关系」。所以画板连线不能只是内部 parentId —— 它得跟普通聊天
     走同一套引用链路：输入框上方出现引用条 → 发出去的气泡带引用块 → 模型收到的
     message 里带【引用上下文】。连线跟着这条引用走，会话里一眼看得见基于哪张图。 */
  /* 图号辅助函数 imgLabel() 已删除（2026-11-17）：引用条不显示了，
     它唯一的使用者就是「引用: 图 N」那行，留着是死代码。 */

  function quoteAnchorNode(n) {
    var f = promptFacts(n);
    var txt = '';
    if (n.kind === 'image') {
      var p = String(f.prompt || '').trim();
      /* 引用的是「哪张图」+「它当初用的提示词」。提示词拿不到（injected 丢了）
         就老实只写 [图片]，不编一个看着像的上去。 */
      txt = p ? '[图片] 提示词：' + p : '[图片]';
    } else {
      txt = String(f.said || '').trim();
    }
    if (!txt) return;
    if (txt.length > 400) txt = txt.slice(0, 400) + '…';
    window._currentQuote = txt;
    var pv = document.getElementById('quotePreview');
    var pt = document.getElementById('quotePreviewText');
    if (pv && pt) {
      /* 引用条不再弹（2026-11-17 用户第 3 条：「现在点击图片后输入框上面还会有一个提示框，
         是不是有bug…删掉那个提示」）。它确实是点图的副产物，但和节点发光、placeholder 换字
         三重反馈叠在一起，而且贴输入框最显眼的那条恰恰最没用。
         window._currentQuote 照旧写满整段「[图片] 提示词：…」—— 发给后端靠它认父，
         refFromCtx 一个字都不能少；只是屏幕上不再有那条文字。 */
      pt.textContent = '';
      pv.classList.remove('show');
    }
  }

  function unquoteComposer() {
    if (typeof clearQuote === 'function') clearQuote();
    else window._currentQuote = null;
  }

  function ensurePromptTip() {
    var t = document.getElementById('cvPromptTip');
    if (t) return t;
    /* 挂 body：浮层是 position:fixed，只要祖先有任何 transform 就会退化成
       相对那块容器定位；画布的 pan/scale 全在 S.world 上，挂 stage 里是赌运气。 */
    t = mk('div', 'cv-prompt-tip cv-hidden');
    t.id = 'cvPromptTip';
    document.body.appendChild(t);
    return t;
  }

  function hidePromptTip() {
    /* 收起时一并解除钉住（2026-11-17）：点图钉住的浮层要靠点空白/切视图收回，
       否则它就一直挂在画布上，换会话回来还在。 */
    _tipPinned = false;
    var t = document.getElementById('cvPromptTip');
    if (t) t.classList.add('cv-hidden');
  }

  /* 悬停 220ms 才弹、移出 140ms 才收：
     鼠标只是划过图片时不该闪一下，但真停下来看就别让人等。 */
  var _tipIn = null, _tipOut = null;
  /* 钉住的意思：点过图之后浮层不跟鼠标走，一直留着（触屏根本没法 hover）。
     恢复于 2026-11-17 用户第 5 条 —— 上一轮删掉是误判。 */
  var _tipPinned = false;
  function bindPromptTip(n, el) {
    el.addEventListener('mouseenter', function () {
      clearTimeout(_tipOut);
      _tipIn = setTimeout(function () { showPromptTip(n, el); }, 220);
    });
    el.addEventListener('mouseleave', function () {
      clearTimeout(_tipIn);
      if (_tipPinned) return;
      _tipOut = setTimeout(hidePromptTip, 140);
    });
  }

  function showPromptTip(n, el) {
    var f = promptFacts(n);
    var t = ensurePromptTip();
    var html = '<div class="cv-tip-label">生成这张图的提示词</div>';
    html += f.prompt
      ? '<div class="cv-tip-text">' + DOM.escAttr(f.prompt) + '</div>'
      : '<div class="cv-tip-empty">老节点，画板开始记录提示词之前生成的</div>';
    if (f.target) html += '<div class="cv-tip-meta">' + DOM.escAttr(f.target) + '</div>';
    t.innerHTML = html;
    t.classList.remove('cv-hidden');
    /* 贴图片右侧；右边放不下翻到左侧；上下都夹进视口。
       浮层是 position:fixed，用视口坐标，不受画布 pan/scale 影响。 */
    var r = el.getBoundingClientRect();
    var tw = t.offsetWidth, th = t.offsetHeight;
    var x = r.right + 14, y = r.top;
    if (x + tw > window.innerWidth - 12) x = r.left - tw - 14;
    if (x < 12) x = Math.max(12, Math.min(r.left, window.innerWidth - tw - 12));
    if (y + th > window.innerHeight - 12) y = Math.max(12, window.innerHeight - th - 12);
    t.style.left = Math.round(x) + 'px';
    t.style.top = Math.round(y) + 'px';
  }

  /* 切换布局方向后把整张图重排（2026-11-16）：
     只让新节点换方向的话，老图还是原来的走向，切完看着是半吊子。
     从根开始 BFS 重算，用户手动拖过的位置会被覆盖 —— 这是换方向的应有代价。 */
  function relayoutAll() {
    var roots = S.order.filter(function (id) { return S.nodes[id] && !S.nodes[id].parentId; });
    /* 一个 root 都找不到时不能直接 return（2026-11-17 实测）：
       画布上全是「parentId 指向已删节点」的孤儿时，roots 是空的 —— 切布局等于什么都没发生，
       用户看到的就是"线形按钮点了没反应、连接线不刷新"。这种局面把最后一个节点提成 root
       重新起一条链，剩下的孤儿由下面那段兜底接走。 */
    if (!roots.length) {
      var firstReal = S.order.filter(function (id) {
        return S.nodes[id] && S.nodes[id].kind !== 'pending';
      })[0];
      if (!firstReal) return;
      S.nodes[firstReal].parentId = '';
      roots = [firstReal];
    }
    var placed = {};
    var queue = [];
    var gap = 90;
    var cursor = 0;
    roots.forEach(function (rid) {
      var n = S.nodes[rid];
      var sz = nodeSize(n);
      n.x = cursor;
      n.y = 0;
      cursor += Math.max(220, sz.w || 220) + gap;
      placed[rid] = 1;
      queue.push(rid);
      if (n.el) { n.el.style.left = n.x + 'px'; n.el.style.top = n.y + 'px'; }
    });
    while (queue.length) {
      var pid = queue.shift();
      var kids = S.order.filter(function (id) {
        return S.nodes[id] && S.nodes[id].parentId === pid && !placed[id];
      });
      kids.forEach(function (kid, i) {
        var pos = placeChild(pid, i);
        var kn = S.nodes[kid];
        kn.x = pos.x; kn.y = pos.y;
        placed[kid] = 1;
        if (kn.el) { kn.el.style.left = kn.x + 'px'; kn.el.style.top = kn.y + 'px'; }
        queue.push(kid);
      });
    }
    /* 兜底（2026-11-17）：BFS 只收「挂得上的」节点。parentId 指向一个已经不存在的 id 时，
       它既不是 root（有 parentId）也不会被任何父节点认领 —— 坐标永远停在上一次的位置，
       切布局时看着就是"线变了、图没动"。把它们提成 root 重排一遍。 */
    var orphan = S.order.filter(function (id) { return S.nodes[id] && !placed[id]; });
    orphan.forEach(function (id) {
      var n = S.nodes[id];
      n.parentId = '';
      var sz = nodeSize(n);
      n.x = cursor; n.y = 0;
      cursor += Math.max(220, sz.w || 220) + gap;
      if (n.el) { n.el.style.left = n.x + 'px'; n.el.style.top = n.y + 'px'; }
    });
    relinkAll();
    fitToNodes();
    save();
  }

  /* 布局方向：竖向摆不下多分支的并排，横向摆不下长对话的纵深，
     两种都得给，用户自己挑。 */
  function getLayout() {
    try { return localStorage.getItem('hermes_canvas_layout') === 'horizontal' ? 'horizontal' : 'vertical'; }
    catch (e) { return 'vertical'; }
  }

  function setLayout(next) {
    S.layout = next;
    try { localStorage.setItem('hermes_canvas_layout', next); } catch (e) {}
    relayoutAll();
    var btn = document.querySelector('[data-cv="layout"]');
    if (btn) {
      btn.textContent = next === 'horizontal' ? '⇉' : '⇅';
      btn.title = next === 'horizontal' ? '当前：从左到右（点击改竖向）' : '当前：从上到下（点击改横向）';
    }
    toast(next === 'horizontal' ? '布局：从左到右' : '布局：从上到下');
  }

  function relinkAll() {
    S.order.forEach(function (id) {
      var n = S.nodes[id];
      if (n && n.parentId) renderLink(n.parentId, id);
    });
    /* 兜底扫一遍（2026-11-17）：上面只处理「有 parentId 的节点」，
       而线上残留的那根线恰恰相反 —— 它的父节点早没了，节点自己还在 S.order 里，
       parentId 还指着一个不存在的 id，renderLink 判 !a 之后 dropLink 该删，
       可要是这条路径根本没被调到（restore 分支、节点被 replaceChild 换掉），
       path 就永远挂在 SVG 上，看着就是一根从空白处抻出来的线。
       这里以 SVG 里的实际 path 为准反查，谁的端点站不住就删谁。 */
    if (!S.svg) return;
    Array.prototype.slice.call(S.svg.querySelectorAll('path[id^="cvlink_"]')).forEach(function (p) {
      var tid = p.id.replace('cvlink_', '');
      var n = S.nodes[tid];
      if (!n || !n.parentId || !S.nodes[n.parentId]) dropLink(tid);
    });
    /* 父节点没了不代表这张图该跟着消失 —— 它只是失去了来源，
       提成根节点继续留着。不清 parentId 的话它既不是 root 也不在谁的 children 里，
       relayout 会把它彻底漏掉，下次重排直接飞出画面。 */
    S.order.forEach(function (id) {
      var n = S.nodes[id];
      if (n && n.parentId && !S.nodes[n.parentId]) n.parentId = '';
    });
  }

  function removeLink(toId) {
    /* 只剩可见线要清（2026-11-17）：热区那条 path 已经彻底不画了，
       留着这行清理代码只会让人以为还有第二个元素存在。 */
    var p = document.getElementById('cvlink_' + toId);
    if (p) p.remove();
  }

  function setLinkLive(toId, live) {
    var p = document.getElementById('cvlink_' + toId);
    if (p) p.classList[live ? 'add' : 'remove']('cv-link-live');
  }

  /* ────────────── 节点拖动 ────────────── */

  function bindNodeDrag(n, e) {
    e.addEventListener('pointerdown', function (ev) {
      if (ev.button !== 0) return;
      // 输入框、按钮、图片预览这些交互控件不触发拖动
      if (ev.target.closest('.cv-composer')) return;
      ev.stopPropagation();
      var start = screenToWorld(ev.clientX, ev.clientY);
      S.drag = { n: n, dx: n.x - start.x, dy: n.y - start.y, moved: false };
      e.classList.add('cv-node-dragging');
      e.setPointerCapture(ev.pointerId);
    });
    e.addEventListener('pointermove', function (ev) {
      if (!S.drag || S.drag.n !== n) return;
      var w = screenToWorld(ev.clientX, ev.clientY);
      var nx = Math.round(w.x + S.drag.dx), ny = Math.round(w.y + S.drag.dy);
      if (nx !== n.x || ny !== n.y) {
        n.x = nx; n.y = ny;
        e.style.left = nx + 'px';
        e.style.top = ny + 'px';
        S.drag.moved = true;
        relinkAll();
      }
    });
    e.addEventListener('pointerup', function (ev) {
      if (!S.drag || S.drag.n !== n) return;
      e.classList.remove('cv-node-dragging');
      try { e.releasePointerCapture(ev.pointerId); } catch (err) {}
      if (S.drag.moved) { save(); }
      S.drag = null;
    });
    e.addEventListener('pointercancel', function () {
      e.classList.remove('cv-node-dragging');
      S.drag = null;
    });
  }

  /* ────────────── 画布平移 / 缩放 ────────────── */

  function bindCanvas() {
    S.stage.addEventListener('pointerdown', function (ev) {
      if (ev.target !== S.stage) return;         // 点在节点上不算平移
      if (ev.button !== 0 && ev.button !== 1) return;
      S.pan = { sx: ev.clientX, sy: ev.clientY, ox: S.view.x, oy: S.view.y, moved: false };
      S.stage.classList.add('cv-panning');
      S.stage.setPointerCapture(ev.pointerId);
    });
    S.stage.addEventListener('pointermove', function (ev) {
      if (!S.pan) return;
      S.view.x = S.pan.ox + (ev.clientX - S.pan.sx);
      S.view.y = S.pan.oy + (ev.clientY - S.pan.sy);
      if (Math.abs(ev.clientX - S.pan.sx) > 4 || Math.abs(ev.clientY - S.pan.sy) > 4) S.pan.moved = true;
      applyView();
    });
    S.stage.addEventListener('pointerup', function (ev) {
      if (!S.pan) return;
      S.stage.classList.remove('cv-panning');
      try { S.stage.releasePointerCapture(ev.pointerId); } catch (err) {}
      S._panMoved = !!S.pan.moved;
      S.pan = null;
      save();
    });
    S.stage.addEventListener('wheel', function (ev) {
      ev.preventDefault();
      var before = screenToWorld(ev.clientX, ev.clientY);
      var factor = ev.deltaY < 0 ? 1.1 : 1 / 1.1;
      var k = Math.min(MAX_K, Math.max(MIN_K, S.view.k * factor));
      if (k === S.view.k) return;
      S.view.k = k;
      var r = S.stage.getBoundingClientRect();
      // 以鼠标位置为锚点缩放：锚点在世界坐标里保持不动
      S.view.x = ev.clientX - r.left - before.x * k;
      S.view.y = ev.clientY - r.top - before.y * k;
      applyView();
      save();
    }, { passive: false });

    /* ── 双指缩放（2026-11-17）──
       上面只有 wheel，触屏没有轮子，手机上画布根本缩不了（用户原话「移动端画布没办法双指缩放」）。
       CSS 里 #canvasStage 已经是 touch-action:none，浏览器不会自己接管手势，
       所以必须自己算：两指距离比例 → 缩放系数，锚点取两指中点，跟 wheel 的锚点语义一致
       （锚点下的世界坐标保持不动，感觉才像"捏住画面"）。
       两指落下时要把平移和节点拖动都掐掉 —— pointerdown 比 touchstart 先触发，
       不清的话指针捕获还挂在第一根手指上，画面会边缩边飘。 */
    var pinch = null;
    S.stage.addEventListener('touchstart', function (ev) {
      if (ev.touches.length !== 2) return;
      var a = ev.touches[0], b = ev.touches[1];
      var d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (!d) return;
      pinch = {
        d: d, k: S.view.k, vx: S.view.x, vy: S.view.y,
        mx: (a.clientX + b.clientX) / 2, my: (a.clientY + b.clientY) / 2
      };
      S.pan = null;
      S.drag = null;
      S.stage.classList.remove('cv-panning');
    }, { passive: true });
    S.stage.addEventListener('touchmove', function (ev) {
      if (!pinch || ev.touches.length !== 2) return;
      ev.preventDefault();
      var a = ev.touches[0], b = ev.touches[1];
      var d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (!d) return;
      var k = Math.min(MAX_K, Math.max(MIN_K, pinch.k * (d / pinch.d)));
      var r = S.stage.getBoundingClientRect();
      var wx = (pinch.mx - r.left - pinch.vx) / pinch.k;
      var wy = (pinch.my - r.top - pinch.vy) / pinch.k;
      S.view.k = k;
      S.view.x = pinch.mx - r.left - wx * k;
      S.view.y = pinch.my - r.top - wy * k;
      applyView();
    }, { passive: false });
    S.stage.addEventListener('touchend', function (ev) {
      if (!pinch) return;
      if (ev.touches.length < 2) { pinch = null; save(); }
    }, { passive: true });
    S.stage.addEventListener('touchcancel', function () { pinch = null; }, { passive: true });

    // 点击空白处收起悬浮输入框
    S.stage.addEventListener('click', function (ev) {
      /* 点节点交给节点自己的 onclick；画布底色、world 层、连线都算空白。
         原来是 ev.target !== S.stage 才收 —— world 铺满 stage，所以点在
         画布空白上 target 是 world，收不掉，引用条和输入框一起赖着不走。 */
      if (ev.target && ev.target.closest && ev.target.closest('.cv-node')) return;
      /* 2026-11-16：拖动画布之后再松手，浏览器照样派发一次 click，
         于是每拖一下画布引用就被取消、输入框甩回底部 —— 用户要的「跟随」等于白做。
         有位移就不算「点空白」，只消费掉标记。 */
      if (S._panMoved) { S._panMoved = false; return; }
      closeComposer();
      /* 点空白处收掉提示词浮层并解除钉住（2026-11-17）：浮层是 fixed 挂在 body 上，
         画布一动它不会跟着走，留着就飘在别的图上面，看着像标错了对象。 */
      hidePromptTip();
    });
  }

  /* ────────────── 拖拽上传 ────────────── */

  function bindDrop() {
    ['dragenter', 'dragover'].forEach(function (evt) {
      S.stage.addEventListener(evt, function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        S.stage.classList.add('cv-drop-active');
      });
    });
    ['dragleave', 'drop'].forEach(function (evt) {
      S.stage.addEventListener(evt, function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        if (evt === 'dragleave' && ev.relatedTarget && S.stage.contains(ev.relatedTarget)) return;
        S.stage.classList.remove('cv-drop-active');
      });
    });
    S.stage.addEventListener('drop', function (ev) {
      var files = Array.prototype.slice.call((ev.dataTransfer && ev.dataTransfer.files) || []);
      if (!files.length) return;
      var w = screenToWorld(ev.clientX, ev.clientY);
      files.forEach(function (f, i) {
        if (!/^image\//.test(f.type)) {
          toast('画板目前只收图片：' + f.name, 'error');
          return;
        }
        uploadImageAt(f, w.x + i * 40, w.y + i * 40);
      });
    });
  }

  function uploadImageAt(file, x, y) {
    var localUrl = '';
    try { localUrl = URL.createObjectURL(file); } catch (e) {}
    /* 拖进来的图是一次新的输入，不引用任何既有节点（2026-11-16 用户定的语义）。
       所以这里要清掉之前点的选中态 —— 否则用户刚点过 A 图、又拖了 B 图进来，
       下一条提示词会挂到 A 下面，凭空连一根线出去。 */
    if (S.activeComposerFor) {
      var prevSel = S.nodes[S.activeComposerFor];
      if (prevSel && prevSel.el) {
        prevSel.el.classList.remove('cv-node-active');
        prevSel.el.classList.remove('cv-branching');
      }
      S.activeComposerFor = null;
    }
    var node = addNode({ kind: 'image', x: x, y: y, url: localUrl || '' });
    /* 「上传中…」改成纯 CSS 叠字（2026-11-17）：.cv-image-label 那个 span 已经删了，
       这里原来往一个永远不存在的元素写 textContent，写了个寂寞。用 class + ::after。 */
    node.el.classList.add('cv-pending-upload');

    var up = (typeof uploadAttachment === 'function')
      ? uploadAttachment(file, '/api/chat/upload-image')
      : Promise.resolve(false);

    up.then(function (ok) {
      if (!ok) {
        if (node.el && node.el.parentNode) node.el.remove();
        removeLink(node.id);
        delete S.nodes[node.id];
        S.order = S.order.filter(function (id) { return id !== node.id; });
        save();
        return;
      }
      /* uploadAttachment 已经把附件塞进 _pendingAttachments；
         画板自己拿着 url，等这条消息发出去再让它进附件列表，
         否则用户拖了图不发，附件会漏到下一轮对话里。 */
      var att = null;
      if (Array.isArray(window._pendingAttachments)) {
        for (var i = window._pendingAttachments.length - 1; i >= 0; i--) {
          var a = window._pendingAttachments[i];
          if (a && a.name === (file.name || 'file') && /^image\//.test(a.type || '')) { att = a; break; }
        }
        if (att) {
          window._pendingAttachments = window._pendingAttachments.filter(function (x) { return x !== att; });
          if (typeof renderAttachChips === 'function') renderAttachChips();
        }
      }
      node.att = att || { url: '', type: file.type, name: file.name };
      setNodeKind(node, 'image', { url: (att && att.url) || localUrl });
      if (localUrl) { try { URL.revokeObjectURL(localUrl); } catch (e) {} }
      save();
    });
  }

  /* ────────────── 输入区：复用面板原生输入框 ────────────── */

  /* 2026-11-16 用户要求：画板别再自建输入框。
   * 之前这里手搓了一套 <textarea> + 两个 <select>，麦克风、加号工具条、
   * 模型/能力/技能/附件按钮全没有，样式也跟面板对不上（用户原话「太丑了」，
   * 还问「原来那个不是有麦克风吗，你怎么完全重新写了一个」）。
   * 现在的分工：
   *   - 输入框 DOM 一个都不造，直接把 #chatComposer 浮到画布底部（attachOriginalComposer）
   *   - 画板只接管「发送」这一个动作 —— 因为画板发的不是聊天，是作图需求，
   *     得先注入【画板生图】指令再交给原 sendChat()
   *   - 麦克风、加号工具条、模型/能力/技能/专家/快捷指令/附件，
   *     onclick/onpointerdown 全是原装的，一行没改 */

  function closeComposer() {
    if (S.activeComposerFor && S.nodes[S.activeComposerFor] && S.nodes[S.activeComposerFor].el) {
      S.nodes[S.activeComposerFor].el.classList.remove('cv-node-active');
    }
    S.activeComposerFor = null;
    unquoteComposer();
    /* 引用断了，浮层也该跟着收（它显示的是「哪张图的提示词」，
       选中都取消了还留着，用户会以为下一句还接在那张图上）。 */
    hidePromptTip();
    var ta = document.getElementById('chatInput');
    if (ta) ta.placeholder = '输入消息…';
  }

  /* 点节点 = 把这个节点设为下一句话的锚点（父节点），并高亮它。
   * 输入框本身不重建，只换 placeholder 和焦点，所以不会打断用户正在打的内容。 */
  function openComposer(nodeId) {
    var n = S.nodes[nodeId];
    if (!n || n.kind === 'pending') return;
    if (S.activeComposerFor && S.activeComposerFor !== nodeId) {
      var prev = S.nodes[S.activeComposerFor];
      if (prev && prev.el) {
        prev.el.classList.remove('cv-node-active');
        prev.el.classList.remove('cv-branching');
      }
    }
    S.activeComposerFor = nodeId;
    if (n.el) n.el.classList.add('cv-node-active');
    quoteAnchorNode(n);
    var ta = document.getElementById('chatInput');
    if (ta) {
      ta.placeholder = n.kind === 'image'
        ? '基于这张图说点什么，比如「改成夜景」'
        : '描述你想生成的画面';
      /* preventScroll：输入框本身在浮层里，浏览器默认的「聚焦即滚进视野」
         会把画布/消息区带着滚一段，锚点算出来的位置随后就偏了。 */
      setTimeout(function () { try { ta.focus({ preventScroll: true }); } catch (e) {} }, 30);
    }
  }

  /* 原输入框浮到画布上，并接管发送入口（2026-11-16）。
   * 只换 onclick / onkeydown 两个回调，DOM 结构一个都不动。
   * 原来的处理函数存进 S._origSend / S._origKey，leave() 时原样还回去。 */
  function attachOriginalComposer() {
    var wrap = document.getElementById('chatComposer');
    if (!wrap) return;
    wrap.classList.add('cv-floating');
    var btn = document.getElementById('sendBtn');
    var ta = document.getElementById('chatInput');
    if (btn) {
      if (!S._origSend) S._origSend = btn.onclick;
      btn.onclick = function () {
        /* 生成中点按钮 = 打断，交回原逻辑（那时它自己变成停止按钮） */
        if (S.busy) { if (typeof S._origSend === 'function') S._origSend(); else onSendOrStop(); return; }
        submitFromComposer();
      };
    }
    if (ta) {
      if (!S._origKey) S._origKey = ta.onkeydown;
      ta.onkeydown = function (ev) {
        /* isComposing：中文输入法选词时敲 Enter 不能发出去 */
        /* 2026-11-18（用户手机实测）：移动端键盘没有 Shift，`!ev.shiftKey` 这个判据
           等于「一敲回车就发」，永远换不了行。触摸设备一律把 Enter 让给换行，
           发送固定走发送按钮；PC 保持回车发送、Shift+回车换行不变。 */
        var _coarse = false;
        try { _coarse = !!(window.matchMedia && window.matchMedia('(pointer:coarse)').matches); } catch (e) {}
        if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing && !_coarse) {
          ev.preventDefault();
          submitFromComposer();
          return;
        }
        if (typeof S._origKey === 'function') return S._origKey(ev);
        return onKey(ev);
      };
      ta.placeholder = '描述你想生成的画面';
    }
  }

  function detachOriginalComposer() {
    var wrap = document.getElementById('chatComposer');
    if (wrap) wrap.classList.remove('cv-floating');
    var btn = document.getElementById('sendBtn');
    var ta = document.getElementById('chatInput');
    if (btn) btn.onclick = S._origSend || function () { onSendOrStop(); };
    if (ta) {
      ta.onkeydown = S._origKey || function (ev) { onKey(ev); };
      ta.placeholder = '输入消息…';
    }
    S._origSend = null;
    S._origKey = null;
  }

  /* 画板发送：读原输入框的文字（附件早就挂在 _pendingAttachments 上，
   * 原输入框的附件按钮、粘贴、拖拽都会自己往那儿塞），
   * 找到锚点节点后交给 sendFrom → 原 sendChat() 链路。 */
  function submitFromComposer() {
    var ta = document.getElementById('chatInput');
    var text = (ta && ta.value || '').trim();
    var hasAtt = (window._pendingAttachments || []).length > 0;
    if (!text && !hasAtt) return;
    /* 2026-11-16 用户定的语义，跟以前反过来了：
       点了某张图 / 某个节点 = 引用它，生成结果连到它下面；
       什么都没点 = 新发一段话，谁也不引用，不画线。
       原来这里兜底 lastRealNodeId()，等于每一句都悄悄挂到最后一张图上 ——
       用户拖一张新图进来接着说话，线却连到上一张旧图上，看着像是引用错了。 */
    var anchor = S.activeComposerFor;
    if (anchor && !S.nodes[anchor]) anchor = null;
    if (ta) { ta.value = ''; ta.style.height = 'auto'; }
    sendFrom(anchor || null, text);
    /* 投完立刻断引用（2026-11-17 用户第 8 条：「保证新发的是从新的开始，
       而不是又是从上一个图开始」）。之前 activeComposerFor 一直留着，发完第一句、
       不点任何图再发第二句，第二句还挂在那张图上 —— 看着像"怎么又连回去了"。
       要连续基于同一张图就再点一次，一次点击换不会有意外的引用。 */
    if (anchor) {
      var an = S.nodes[anchor];
      if (an && an.el) an.el.classList.remove('cv-node-active');
      S.activeComposerFor = null;
      var t2 = document.getElementById('chatInput');
      if (t2) t2.placeholder = '描述你想生成的画面';
    }
  }

  /* 没点节点时兜底：拿画布上最后一个非占位节点当父节点 */
  function lastRealNodeId() {
    for (var i = S.order.length - 1; i >= 0; i--) {
      var n = S.nodes[S.order[i]];
      if (n && n.kind !== 'pending') return n.id;
    }
    return null;
  }

  /* 生图目标（2026-11-16 从两个丑下拉里搬出来）。
   * 「对话模型」画板不再自选 —— 用输入框左侧工具条里的原生「选择模型」按钮，
   * 跟普通对话完全同一套，选中照样写 _setSessionModel，联网/终端/浏览器一点都不少。
   * 只剩「生图目标」还需要一个入口：做成右上控制条里的一个小 chip，
   * 点开是个按钮列表，不再往输入框上面摞两个 <select>。 */
  /* 进画板自动点亮「本轮能力 → 图像生成」（2026-11-16 用户要求）。
     画板就是来画图的，可这个 chip 默认是空的 —— 空着的时候 compose.js 不会
     注入能力段落，模型手上就没有 image_generate，提示词写得再对也只能回一段
     文字描述。自动勾上之后，用户还能自己取消（存的就是标准 localStorage 键，
     跟手点完全一致，不是旁挂的第二套状态）。 */
  function markCapability(key) {
    try {
      var k = 'fnos_capabilities:' + (S.sid || 'default');
      var arr = [];
      try { arr = JSON.parse(localStorage.getItem(k) || '[]'); } catch (e) { arr = []; }
      if (Object.prototype.toString.call(arr) !== '[object Array]') arr = [];
      if (arr.indexOf(key) < 0) {
        arr.push(key);
        localStorage.setItem(k, JSON.stringify(arr));
      }
      if (typeof window.loadCapabilities === 'function') window.loadCapabilities();
      else if (typeof window.capabilityChipRefresh === 'function') window.capabilityChipRefresh();
    } catch (e) {}
  }

  function initImageTarget() {
    window._cvImageTarget = window._cvImageTarget || {};
    try {
      var saved = localStorage.getItem('hermes_cv_image_target');
      if (saved) {
        var parsed = JSON.parse(saved);
        Object.keys(parsed || {}).forEach(function (k) {
          if (!window._cvImageTarget[k]) window._cvImageTarget[k] = parsed[k];
        });
      }
    } catch (e) {}
    apiGet('/api/workspace-ui/image-targets').then(function (res) {
      S.imageTargets = (res && Array.isArray(res.targets)) ? res.targets : [];
      /* 没选过就给个默认，省得发出去的生图指令里没有目标 */
      if (S.sid && !window._cvImageTarget[S.sid] && S.imageTargets.length) {
        /* 2026-11-18（用户实测）：新建画板时选的 gemini 进来还是 image2。
           原因：新建对话框选的模型只写进 _selectedModelMap（对话模型），画板这个
           生图目标 chip 走的是另一套，兜底永远取 targets[0]。
           现在先拿该会话已选的模型去 imageTargets 里认一次（model 或 label 对上就算），
           认不出才退回 targets[0] —— 老会话没选过模型的行为不变。 */
        var _wantM = (typeof _getSessionModel === 'function') ? _getSessionModel(S.sid) : '';
        var _hitT = null;
        if (_wantM) {
          for (var _ti = 0; _ti < S.imageTargets.length; _ti++) {
            var _t = S.imageTargets[_ti];
            if (_t.model === _wantM || _t.label === _wantM) { _hitT = _t; break; }
          }
        }
        window._cvImageTarget[S.sid] = _hitT ? (_hitT.label || _hitT.model) : (S.imageTargets[0].label || S.imageTargets[0].model);
      }
      syncTargetLabel();
    }).catch(function () {
      S.imageTargets = [];
      syncTargetLabel();
    });
  }

  function currentImageTarget() {
    if (!S.imageTargets || !S.imageTargets.length) return null;
    var want = (S.sid && window._cvImageTarget[S.sid]) || '';
    for (var i = 0; i < S.imageTargets.length; i++) {
      var t = S.imageTargets[i];
      if ((t.label || t.model) === want || t.model === want) return t;
    }
    return S.imageTargets[0];
  }

  function syncTargetLabel() {
    var btn = document.getElementById('cvTargetBtn');
    if (!btn) return;
    var t = currentImageTarget();
    var nameEl = btn.querySelector('.cv-target-name');
    var text = t ? (t.label || t.model) : '未选择';
    if (nameEl) nameEl.textContent = text;
    btn.title = t ? ('生图模型 · ' + text) : '生图模型（未选择）';
    btn.classList.toggle('cv-target-empty', !t);
  }

  function toggleTargetMenu(anchorBtn) {
    var old = document.getElementById('cvTargetMenu');
    if (old) { old.remove(); return; }
    if (!S.imageTargets || !S.imageTargets.length) { toast('没有可用的生图模型', 'error'); return; }
    var cur = currentImageTarget();
    var m = mk('div', 'cv-target-menu');
    m.id = 'cvTargetMenu';
    m.innerHTML = S.imageTargets.map(function (t) {
      var name = t.label || t.model;
      var on = cur && cur.model === t.model;
      return '<button type="button" class="' + (on ? 'on' : '') + '" data-target="' + DOM.escAttr(name) + '">' + DOM.escAttr(name) + '</button>';
    }).join('');
    m.addEventListener('click', function (ev) {
      var b = ev.target && ev.target.closest ? ev.target.closest('button') : null;
      if (!b) return;
      if (S.sid) window._cvImageTarget[S.sid] = b.dataset.target;
      try { localStorage.setItem('hermes_cv_image_target', JSON.stringify(window._cvImageTarget)); } catch (e) {}
      syncTargetLabel();
      m.remove();
      save();
    });
    S.stage.appendChild(m);
    var r = anchorBtn.getBoundingClientRect(), sr = S.stage.getBoundingClientRect();
    /* 按钮在上半部就往下弹，在下半部就往上弹；左半边贴左、右半边贴右。
       生图下拉现在在左上角，固定写死 bottom 会弹到屏幕外。 */
    if (r.top + r.height / 2 < sr.top + sr.height / 2) {
      m.style.top = Math.round(r.bottom - sr.top + 8) + 'px';
    } else {
      m.style.bottom = Math.round(sr.bottom - r.top + 8) + 'px';
    }
    if (r.left + r.width / 2 < sr.left + sr.width / 2) {
      m.style.left = Math.max(8, Math.round(r.left - sr.left)) + 'px';
    } else {
      m.style.right = Math.max(8, Math.round(sr.right - r.right)) + 'px';
    }
    setTimeout(function () {
      function h(e) {
        /* 2026-11-17：按钮自己不能被这里关掉。document 用的是捕获阶段，
           比按钮上的冒泡监听先跑 —— 若这里把菜单 remove 了，冒泡到按钮时
           toggleTargetMenu 又建一个新的，「点按钮关菜单」就变成闪一下关不掉，
           表现为时灵时不灵。按钮交给 toggleTargetMenu 自己判断（有就关）。 */
        if (anchorBtn.contains(e.target)) return;
        if (!m.contains(e.target)) { m.remove(); document.removeEventListener('click', h, true); }
      }
      document.addEventListener('click', h, true);
    }, 0);
  }

  /* ────────────── 发送（复用全局链路） ────────────── */

  /* 新话题落点（2026-11-16）：没有引用父节点时不该压在旧图上。
     取所有节点包围盒的右边界再往右 160，纵向跟画布视口中心对齐 ——
     新链跟旧图并排，一眼能看出「这条跟那条没关系」。 */
  function freeSpot() {
    var maxX = 0, minY = null, maxY = 0;
    S.order.forEach(function (id) {
      var n = S.nodes[id];
      if (!n || n.kind === 'pending') return;
      var sz = nodeSize(n);
      maxX = Math.max(maxX, n.x + sz.w);
      maxY = Math.max(maxY, n.y + sz.h);
      if (minY === null || n.y < minY) minY = n.y;
    });
    if (minY === null) { var c = centerWorld(); return { x: c.x - 100, y: c.y - 40 }; }
    return { x: Math.round(maxX + 160), y: Math.round((minY + maxY) / 2) };
  }

  function sendFrom(parentId, text) {
    if (S.busy) { toast('上一轮还在生成，稍等', 'error'); return; }
    var parent = parentId ? S.nodes[parentId] : null;
    if (parentId && !parent) return;

    /* 1. 不再把用户这句话造成画布节点（2026-11-17 用户第 4 条原话：
       「引用图片导致提示词也变成了元素建到了图里」—— 要删的就是这一处）。
       原来这里建一个 kind:'text' 的节点显示「提示 / 改成黑猫」，用户指着截图说
       「两个图中间有提示词元素是真的…你把那个给我找回来」时我先误判成悬停浮层，
       实际是这个实打实的画布节点。连线只该表达「谁派生自谁」，提示词放浮层里看，
       不该在图之间插一块方框占位。
       提示词本身一个字都没丢：下面照样写进 pend.injected，浮层和认父都靠它。 */
    /* 首图的落位（2026-11-18）：画布上只剩一颗 plus「开始」时，parent 是 null，
       原来走 freeSpot() —— 包围盒右侧 +160，等于把第一张图丢到 plus 右边老远，
       用户点完「开始」眼睛盯着的那个位置反而什么都没长出来。
       有 plus 就直接占用它的坐标：他点的哪儿，图就从哪儿出现。 */
    var plusNode = null;
    if (!parent) {
      for (var pi = 0; pi < S.order.length; pi++) {
        var pn = S.nodes[S.order[pi]];
        if (pn && pn.kind === 'plus') { plusNode = pn; break; }
      }
    }
    var pos = parent ? placeChild(parentId)
      : (plusNode ? { x: plusNode.x, y: plusNode.y } : freeSpot());
    var pend = addNode({
      kind: 'pending',
      x: pos.x,
      y: pos.y,
      parentId: parentId || '',
      /* 凭据记在这张图上（2026-11-17）：占位节点后来 setNodeKind 变成 image，
         它才是画布上那张图，分支判断看它有没有真的引用过谁。
         没引用 → 空 → 迁移/重排时它就是根。 */
      refId: parentId || ''
    });
    setLinkLive(pend.id, true);
    S.activeParent = parentId || '';
    S.busy = true;

    // 3. 交给原来的发送链路，一个字符都不改
    var ta = document.getElementById('chatInput');
    if (!ta) { setNodeKind(pend, 'text', { text: '发送失败：输入框不存在' }); S.busy = false; return; }
    /* 画板发的不是聊天，是作图需求。不显式点名，模型会拿一段文字描述糊过去 ——
       2026-11-16 实测连发三轮，回到画板的全是「开始处理…」，一张图都没有。 */
    var target = (window._cvImageTarget && window._cvImageTarget[S.sid]) || '';
    /* 注入文既发给 agent，也原样存到节点上 —— 点连线时要能把它完整显示出来
       （2026-11-16 用户需求）。存的是「实际发出去的全部内容」，不是用户那半句。 */
    var injected = '【画板生图】请直接调用 image_generate 生成图片，不要用文字描述代替。' +
               (target ? '生图目标：' + target + '。' : '') +
               '提示词：' + (text || '基于上面这张图继续');
    ta.value = injected;
    /* 提示词只落在占位节点上（2026-11-17）：中间那个 text 节点已经删了，
       它是唯一另一处副本。pend 出图时被 setNodeKind 改成 image，injected 跟着走，
       浮层显示和 refFromCtx 认父都读它。 */
    pend.injected = injected;

    // 4. 父节点若带图片，把它塞回附件列表（无引用时 parent 是 null）
    if (parent && parent.att) {
      window._pendingAttachments = window._pendingAttachments || [];
      window._pendingAttachments.push(parent.att);
      parent.attUsed = true;
      if (typeof renderAttachChips === 'function') renderAttachChips();
    }

    try {
      sendChat();
    } catch (e) {
      setNodeKind(pend, 'text', { text: '发送失败：' + (e && e.message || e) });
      setLinkLive(pend.id, false);
      S.busy = false;
    }
  }

  /* ────────────── 监听新图，把生成结果接上 ────────────── */

  /* 返回 [{src, ctx}]。ctx = 这条消息的原文（user 消息就是当初发给 agent 的
     那份【画板生图】注入文）。回填时把它写进节点 injected —— 不回填的话，
     画布上重建出来的图一个提示词都没有，点图弹出来的引用只能是光秃秃的
     「[图片]」，用户 2026-11-17 问的「提示词怎么是老节点」就是这条路径。 */
  /* 图片去重键（2026-11-17 实测根因）──────────────────────────────
     同一张图在不同消息里会渲染成两种路径：
       /app/hermes-agent/data/assets/generated/custom_x.png   （磁盘上真有）
       /app/hermes-agent/data/assets/custom_x.png             （少一层，404）
     按完整 src 排重等于把同一张图算成两张，画布上就多出一个裂图节点，
     还和好节点挤在同一层 —— 用户报「最后多了一个节点和铅笔画平级，图是裂的」。
     键只取文件名：时间戳 + hash 已经是唯一的，目录不参与比较。 */
  function imgKey(src) {
    if (!src) return '';
    var t = String(src).split('?')[0].split('#')[0];
    return t.substring(t.lastIndexOf('/') + 1) || t;
  }

  function extractImages(root) {
    var out = [];
    var scopes = root.querySelectorAll('.msg');
    if (!scopes.length) scopes = [root];
    var lastUserCtx = '';
    for (var mi = 0; mi < scopes.length; mi++) {
      var msg = scopes[mi];
      var ctx = '';
      try {
        ctx = msg.getAttribute('data-content') || '';
        if (!ctx) { var md = msg.querySelector('.md-text'); ctx = md ? (md.textContent || '') : ''; }
        /* 引用块被 tabs.js 拆成独立的 .quote-block 渲染（tabs.js:1187），
           data-content 里只剩【用户追问】之后那段正文。
           不把它拼回去，refFromCtx 就永远找不到【引用上下文】——
           实测代价：__canvas_probe__ 回填出 10 张图全是散装根、0 条连线。
           这里按服务端存的原始格式还原，后面认父才有一致的输入。 */
        var qb = msg.querySelector('.quote-block');
        if (qb) {
          var qt = (qb.textContent || '').replace(/^\s*引用\s*/, '').trim();
          if (qt) ctx = '【引用上下文】\n' + qt + '\n\n【用户追问】\n' + ctx;
        }
      } catch (e) { ctx = ''; }
      /* 图在 assistant 的气泡里，提示词却在**上一条** user 消息里。
         直接拿本条的 data-content 会得到整段助手回复（含 markdown 链接、
         一段描述，259 字体感全无）。所以 user 消息先把源文记下来，
         后面 assistant 里的图标就用这份。 */
      var isUser = !!(msg.classList && msg.classList.contains('user'));
      if (isUser && ctx) lastUserCtx = ctx;
      if (!isUser && lastUserCtx) ctx = lastUserCtx;
    var imgs = msg.querySelectorAll('img');
    for (var i = 0; i < imgs.length; i++) {
      var src = imgs[i].getAttribute('src') || '';
      if (!src) continue;
      /* 生图产物的唯一存放位置是 /data/assets/generated/（2026-11-17 磁盘实测）。
         但消息里同一张图有时渲染成 /data/assets/custom_xxx.png —— 少一层 generated，
         浏览器 403，按它建节点就是一个裂图块，还和正常那张挤在同一层。
         文件名是 custom_<model>_<时间戳>_<hash>.png，补回 generated/ 就是真实位置。
         （正常路径 assets/generated/custom_… 不会被这条正则命中。） */
      src = src.replace(/\/data\/assets\/(custom_[^\/]+\.(?:png|jpe?g|webp))(\?|$)/i,
                        '/data/assets/generated/$1$2');
      var _k = imgKey(src);
      if (S.seenImgs[_k]) continue;
      /* 认两类产物（2026-11-16 实测）：
         上传件在 /uploads/；生图结果落在 /app/hermes-agent/data/tmp/ 这类路径，
         原来只认 /uploads/，生成图一个都接不上。头像/表情/图标一律排掉。 */
      var isUpload = /\/uploads\//.test(src);
      var isGen = /\/data\/(tmp|assets|generated|images|output)\//.test(src) &&
                  /\.(png|jpe?g|webp|gif)(\?|$)/i.test(src);
      var isInline = /^data:image\//.test(src);
      if (!(isUpload || isGen || isInline)) continue;
      if (/avatar|emoji|icon/i.test(src)) continue;
      S.seenImgs[_k] = true;
      out.push({ src: src, ctx: (ctx || '').slice(0, 800) });
    }
    }
    return out;
  }

  /* 从历史消息原文里认出「这张图引用了谁」（2026-11-17）。
     回填历史时节点上没有 parentId / refId 可继承，但 user 消息原文里留着证据：
     基于某张图发的那条会带【引用上下文】+ 那张图的提示词。
     把引用块里的提示词拿去跟已建节点的 injected 比，命中就是引用目标 ——
     这样刷新之后分支还能重建出来，不会塌成一排散装根。
     没有引用块（或者对不上任何节点）→ 返空 = 这张图是从新节点开始的，
     跟用户定的规矩一致：没有引用凭据就不连线。 */
  /* 从一段消息原文里剥出「纯提示词」（2026-11-17 提取成公共函数）。
     提示词有两种落盘格式，实测都出现过（2026-11-17 从 state.db 真实消息里抠的）：
       生成时注入：  【画板生图】…生图目标：fan · gpt-image-2。提示词：请绘制 xxx
       引用块里：    [图片] 提示词：请绘制 xxx
     只认前一种的话，回填时引用块永远 strip 不干净、一个字都对不上，
     四张图全散成独立根 —— 用户刷新后看到的还是「没有分支」。
     两种都剥掉，剩下的纯提示词才好比。 */
  function promptOf(s) {
    var t = String(s || '');
    /* 一条 user 消息里其实有两段提示词，含义完全不同（2026-11-17 实测）：
         【引用上下文】[图片] 提示词：请绘制技术架构图   ← 被引用的那张（父）
         【画板生图】… 提示词：风格改成抽象画风          ← 这张图自己要画的（子）
       老写法只做「删前缀」，两段拼在一起存成一个字符串，于是
       ① 画板悬停弹出来的提示词一坨两段的怪东西；
       ② 拿它去跟别人比字面，永远差着另一半。
       改成按优先级取整段：有自己的生图提示词就用它，没有才退回引用块。 */
    var paint = /【画板生图】[\s\S]*?提示词：([\s\S]*)$/.exec(t);
    if (paint) {
      var v = paint[1].replace(/【本轮参考上下文】[\s\S]*$/, '').trim();
      if (v) return v;
    }
    var ref = /\[图片\]\s*提示词：([^\n]*)/.exec(t);
    if (ref && ref[1].trim()) return ref[1].trim();
    return t
      .replace(/【引用上下文】/g, '')
      .replace(/\[图片\]\s*提示词：/g, '')
      .replace(/【用户追问】[\s\S]*$/, '')
      .replace(/【本轮参考上下文】[\s\S]*$/, '')
      /* 语音转写失败时服务端会在正文里留这一句提示，它跟"这张图画了什么"无关。
         不剥的话画板悬停弹出来就是这句话，看着像个没标题的节点。 */
      .replace(/[（(]语音消息，转写没成功，请直接听附件[）)]/g, '')
      .trim();
  }

  function refFromCtx(ctx, nodes) {
    var m = /【引用上下文】([\s\S]*?)(?:【用户追问】|$)/.exec(ctx || '');
    if (!m) return '';
    var want = promptOf(m[1]);
    if (!want) return '';
    var hit = '';
    (nodes || []).forEach(function (n) {
      /* 取「最近一张」而不是「第一张」（2026-11-17）：同一 prompt 迭代出来的
         七八张图提示词一字不差，取第一个匹配会把后续全挂到最早那张上，
         画板上就是一根棍子扇出七八条线（实测 maxFanout=3）。
         用户真实动作是「在最新那张上继续改」，所以后出现的覆盖前者。 */
      if (!n || !n.injected) return;
      var have = promptOf(n.injected);
      if (have && (have === want || want.indexOf(have) >= 0 || have.indexOf(want) >= 0)) hit = n.id;
    });
    return hit;
  }

  /* 同 prompt 迭代认父（2026-11-17，用户第 4 次报「看不到连接线」的根因）
     ──────────────────────────────────────────────────────────────
     实况：__canvas_probe__ 会话里连着 8 次发同一个「请绘制 Hermes 技术架构概念图」，
     一次都没点图片引用 → 消息里没有【引用上下文】块 → refFromCtx 只返回 ''，
     8 张图全落成孤立根，画板上一条线都没有。
     用户每次报「还是看不到连接线」，前几轮我都去修渲染（线宽、viewport 塌陷），
     但拿同一份 7 张图做 A/B 实测：全独立根 = 0 条线，串成链 = 6 条线、
     每条屏幕上 2.5px 薄荷绿可见 —— 渲染是好的，缺的是父子关系。
     所以补一条不撒谎的判据：**提示词完全相同 = 同一系列在迭代**，挂到最近那张
     同 prompt 的图下面。提示词不同就仍然不连线，绝不凭出现顺序硬串。 */
  function samePromptParent(ctx, nodes) {
    var want = promptOf(ctx);
    if (!want || want.length < 4) return '';   // 太短（"-"、"继续"）不足以判定同系列
    var hit = '';
    (nodes || []).forEach(function (n) {
      if (!n || !n.injected) return;
      if (promptOf(n.injected) === want) hit = n.id;   // order 升序遍历，后者覆盖 = 取最近一张
    });
    return hit;
  }

  /* opts.chain = 回填历史时才用（历史消息里的图没有 parentId 信息，
     只能按出现顺序串成一条链）；真实生成结果一律挂 S.activeParent。 */
  function attachNewImages(srcs, opts) {
    if (!srcs.length) return;
    /* 兼容两种入参：老的纯 src 数组（watchChatBody 那条路）和
       extractImages 现在返回的 {src, ctx}。 */
    srcs = srcs.map(function (it) {
      return (typeof it === 'string') ? { src: it, ctx: '' } : it;
    });
    var chain = !!(opts && opts.chain);
    /* 本轮该挂在谁下面（2026-11-17 用户第 1 条：图怎么连到之前的鲸鱼娘图上）：
       原来兜底 S.order[0]，而下面又用「S.order 最后一个节点」当 parent ——
       画布上只要躺着一张旧图（换会话残留、回填残留），新生成的第一张图就挂到它下面，
       连线自然指向那张旧图。现在只认 S.activeParent，没有就是新链起点，一根线都不画。 */
    var live = S.activeParent && S.nodes[S.activeParent] ? S.activeParent : '';
    /* 已经挂上画布的图不再重复建（2026-11-16）：排重原来只看 S.seenImgs，
       那是内存态，刷新就清空 —— 每次进画板都会把历史图再挂一遍，
       变成一摞重复节点。改成按 url 查真实节点。 */
    var alive = {};
    S.order.forEach(function (id) {
      if (!S.nodes[id] || !S.nodes[id].url) return;
      var k = imgKey(S.nodes[id].url);
      /* 同键已在册就留着先出现的那个（通常是路径正确的），
         后面那个裂图节点不再登记，也不参与建节点。 */
      if (!alive[k]) alive[k] = id;
    });
    var lastId = S.order.length ? S.order[S.order.length - 1] : '';

    /* 同一张图的两条路径先归并（2026-11-17 实测）────────────────────
       消息里同一个文件会渲染出两份 src：
         /app/hermes-agent/data/assets/generated/custom_x.png   磁盘上真有
         /app/hermes-agent/data/assets/custom_x.png             少一层，403
       直接遍历就建两个节点：一个能显示、一个裂，两个还挂在同一父下平级 ——
       用户原话「最后多了一个节点和配了插图的铅笔画平级，但是图是裂的」。
       按 imgKey 分组，优先留带 /generated/ 的那条。 */
    var byKey = {};
    srcs.forEach(function (item) {
      var k = imgKey(item.src);
      var cur = byKey[k];
      if (!cur) { byKey[k] = item; return; }
      if (/\/generated\//.test(item.src) && !/\/generated\//.test(cur.src)) byKey[k] = item;
    });
    srcs = Object.keys(byKey).map(function (k) { return byKey[k]; });

    srcs.forEach(function (item) {
      var src = item.src, ctx = item.ctx || '';
      var key = imgKey(src);
      if (alive[key]) {
        lastId = alive[key];
        /* 老节点补提示词（2026-11-17 用户报「提示词写的是老节点」）。
           节点已经按 url 在册，这里直接 return 的话永远补不上 injected ——
           早期存档 / 早一轮回填建出来的节点没有这个字段，点图只弹
           「老节点，画板开始记录提示词之前生成的」。
           这次回填手里就有 ctx，缺了补上；已经有的一字不动。 */
        var av = S.nodes[alive[key]];
        if (av) {
          var changed = false;
          if (!av.injected && ctx) { av.injected = ctx; changed = true; }
          /* 老节点补父（2026-11-17 第 5 次修 —— 用户说「不对啊，我引用了的啊」）。
             前一轮只改了判据没用，因为判据上线前画板已经按旧逻辑回填过一轮，
             节点落在 localStorage 里、parentId 全是空。这次回填撞上 alive[key]
             就 return，父永远补不上 —— 用户看到的现象就是「代码改了，线还是不出现」，
             而我拿自己造的探针会话（0 条引用）当证据，还反过来怪他没引用。
             这里用同一套判据补：有引用块按 refFromCtx 认，没有按同 prompt 认。
             **已经有 parentId 的一字不动**（用户可能手动连过，不能覆盖他的选择）。 */
          if (chain && !av.parentId && ctx) {
            var sib = S.order.map(function (id) { return S.nodes[id]; })
                             .filter(function (x) { return x && x.url && x.id !== av.id; });
            var rid = refFromCtx(ctx, sib) || samePromptParent(ctx, sib);
            if (rid && rid !== av.id) {
              /* 防环：顺着 rid 往上追，碰到自己就是接成闭环，放弃 */
              var g = rid, guard = 0, cyc = false;
              while (g && guard++ < 64) {
                if (g === av.id) { cyc = true; break; }
                g = (S.nodes[g] && S.nodes[g].parentId) || '';
              }
              if (!cyc) {
                av.parentId = rid;
                av.refId = rid;
                renderLink(rid, av.id);   /* 立刻补线，不等下一帧 */
                changed = true;
              }
            }
          }
          if (changed) save();
        }
        return;
      }
      // 有占位节点就把它变成图，没有就新建
      var pendId = Object.keys(S.nodes).filter(function (id) { return S.nodes[id].kind === 'pending'; })[0];
      if (pendId) {
        var p = S.nodes[pendId];
        setNodeKind(p, 'image', { url: src });
        setLinkLive(p.id, false);
        lastId = p.id;
        alive[key] = p.id;
      } else {
        /* 父节点怎么定（2026-11-17 重写）：
           回填历史时按消息里的引用证据认父（refFromCtx），
           没有证据 = 这张图是从新节点开始的，落成独立根。
           原来这里 chain 分支用 `lastId || live` 一路串下去，
           等于凭出现顺序硬造一条到底的线 —— 用户报「还是一条线」的根源之一。
           真实生成照旧只认本轮引用 S.activeParent，没有就是根。 */
        var refId = '';
        if (chain) {
          var existing = S.order.map(function (id) { return S.nodes[id]; })
                                 .filter(function (x) { return x && x.url; });
          refId = refFromCtx(ctx, existing);
          /* 没有引用证据时，看提示词是不是同一个（2026-11-17）：
             用户在同一张图上反复迭代同一个 prompt，消息里压根没有引用块，
             按旧逻辑全散成根、一条线没有。同 prompt 挂最近那张下面，
             prompt 不同就还是根 —— 不凭出现顺序硬串。 */
          if (!refId) refId = samePromptParent(ctx, existing);
        } else {
          refId = live;
        }
        var parent = refId;
        var pos = parent ? placeChild(parent) : freeSpot();
        var n = addNode({ kind: 'image', x: pos.x, y: pos.y, parentId: parent, refId: refId, url: src, injected: ctx });
        if (n && n.id) { lastId = n.id; alive[key] = n.id; }
      }
    });
    S.busy = false;
    /* activeParent 用完即清（2026-11-17）：这个变量表示「这一轮的图该挂谁下面」，
       图已经挂完了它就该失效。留着的话下一张图（或下一条旁路发送）会继续认同一个父，
       表现就是"怎么永远接在同一张图后面"。回填走 chain 分支，不依赖它。 */
    if (!chain) S.activeParent = '';
    save();
    // 新图出来就把视口带过去，不然用户得自己找
    var last = S.order[S.order.length - 1];
    if (last && S.nodes[last]) centerOn(S.nodes[last]);
  }

  /* 从会话历史回填节点（2026-11-16）：
     localStorage 只记画板里发生过的事。手动进画板、换浏览器、清缓存之后，
     历史消息里明明有图，画布上却只剩一个空加号 —— 用户 2026-11-16 报的就是这个。
     进画板时把 chatBody 里已渲染的图扫一遍，没建过节点的补上。 */
  function backfillFromHistory() {
    var body = document.getElementById('chatBody');
    if (!body) return 0;
    /* 会话一致性守卫（2026-11-17 实测踩到）：
       enter(sid) 只换了 S.sid，chatBody 里的消息是「当前激活会话」的，
       两者的切换不同步。只要 chatBody 还没轮到 sid，写进去的图就是从别的会话搬来的
       —— 表现是新开一个空画板，一进去就冒出七八张「点击继续编辑」的旧图。
       这里宁可少回填一次（observer 会在渲染完成后自己再触发），也不能搬错。 */
    var cur = (typeof window.currentSession !== 'undefined') ? window.currentSession : null;
    if (cur && S.sid && cur !== S.sid) return 0;
    var before = S.order.length;
    var imgs = extractImages(body);
    /* 回填必须传 chain:true（2026-11-17 修正）。
       chain 的语义已经换了：以前是「按出现顺序接上一张图」硬串一条线，
       现在是把 ctx 交给 refFromCtx，**只认消息里的引用证据**认父；
       没有证据就落成独立根。所以传 true 不会再造长链，反而是唯一能
       还原分支的路径。传 {} 会走 live（本期没点任何图 → 空）→ 全散成根。 */
    if (imgs.length) attachNewImages(imgs, { chain: true });
    return S.order.length - before;
  }

  function centerOn(n) {
    var r = S.stage.getBoundingClientRect();
    var size = nodeSize(n);
    S.view.x = r.width / 2 - (n.x + size.w / 2) * S.view.k;
    S.view.y = r.height / 2 - (n.y + size.h / 2) * S.view.k;
    applyView();
  }

  function watchChatBody() {
    var body = document.getElementById('chatBody');
    if (!body || typeof MutationObserver !== 'function') return;
    /* 这里原来有一句 extractImages(body) 预扫，注释写的是「避免进入画板时把历史图全画一遍」。
       恰恰是它把历史图全吞了：预扫把它们塞进 S.seenImgs，之后 observer 每次都判重跳过，
       节点永远建不出来 —— 用户 2026-11-16 报的「进画板看不到图、目录里却有」就是这。
       改成进画板时显式回填（backfillFromHistory），排重交给真实节点（按 url 查）。 */
    S.observer = new MutationObserver(function () {
      if (!S.on) return;
      backfillFromHistory();
    });
    S.observer.observe(body, { childList: true, subtree: true, characterData: true });
  }

  /* 发送结束后清 pending 与 busy（2026-11-16 重写）
     原来只看 window._msgState.streaming，但 durable queue 模式下这个标志
     开局就是 false —— 实测消息刚入队 2.5 秒画板就判定「本轮已结束（未产出图片）」，
     可后端那会儿正在生图，图出来时占位节点早被改写,再也接不上。
     现在以 genBar 的 _tabGenState[sid].done 为准（ts 必须晚于本轮开始，避免读到上一轮残留），
     外加 240 秒硬兜底 —— 生图本来就慢，不能按聊天节奏收尾。 */
  function watchBusy() {
    var started = Date.now();
    var timer = setInterval(function () {
      if (!S.on) { clearInterval(timer); return; }
      if (!S.busy) { clearInterval(timer); return; }   // 图已接上，attachNewImages 清了 busy
      var sid = window.currentSession;
      var gs = (window._tabGenState || {})[sid];
      var finished = !!(gs && gs.done && (gs.ts || 0) >= started);
      var timeout = Date.now() - started > 240000;
      if (!finished && !timeout) return;
      clearInterval(timer);
      Object.keys(S.nodes).forEach(function (id) {
        var n = S.nodes[id];
        if (n.kind === 'pending') {
          setNodeKind(n, 'text', { text: timeout ? '等待超时，图可能还在生成' : '本轮已结束（未产出图片）' });
          setLinkLive(n.id, false);
        }
      });
      S.busy = false;
      save();
    }, 1200);
  }

  /* ══════════════════════════════════════════════════════
     生成图目录（2026-11-16 用户需求）：右侧抽屉，列本机全部生成图
     ══════════════════════════════════════════════════════ */

  /* ── 起始节点清理（2026-11-16 用户第 45 条）──────────────────────
     「一个画布开始了就不要有那个开始的节点了」

     那个带「开始」标签的虚线圆是空画布的入口。问题出在加载顺序：
     enter() 先看 localStorage 有没有存档，没有就摆一个 plus 圆；
     紧接着 backfillFromHistory() 从消息记录把历史图灌进来 ——
     于是有图的画布上，那个 plus 圆孤零零留在中间，谁也没连。

     这里在每次回填之后扫一遍：只要画布上有任何真实节点，就把 plus 全收掉。
     空画布仍然保留它，否则第一轮没有落点。 */
  function pruneStartNode() {
    var hasReal = S.order.some(function (id) {
      var n = S.nodes[id];
      return n && n.kind !== 'plus';
    });
    if (!hasReal) return;
    var removed = false;
    S.order.slice().forEach(function (id) {
      var n = S.nodes[id];
      if (n && n.kind === 'plus') {
        /* 收 plus 的时候有两件连带的事，漏一件就留疤（2026-11-16 用户第 46 条）：
           1. 挂在它下面的图 parentId 悬空 —— renderLink 里 `!a` 直接 return，
              可是**上一条已经画进 SVG 的 path 没人撤**，于是「开始节点没了、
              指向第一张图的那根线还扥在空中」。
           2. 悬空的 parentId 既不是 root 也匹配不上任何父节点，relayoutAll 的
              BFS 永远遍历不到它 —— 排版时这些图会被整块漏掉。
           所以先提升成 root，再删 plus，再把指向它的 path 和热区一起摘掉。 */
        S.order.forEach(function (cid) {
          var c = S.nodes[cid];
          if (c && c.parentId === id) {
            c.parentId = '';
            /* 这根线的 id 是 cvlink_<子节点 id>，不是 cvlink_<plus id> ——
               按 plus 的 id 去删只会扑空，线照样留在 SVG 里。
               2026-11-17 实测：用户截图里那根从空白处抻出来的线就是这里漏的。 */
            dropLink(cid);
          }
        });
        dropLink(id);
        if (n.el && n.el.parentNode) n.el.remove();
        delete S.nodes[id];
        var i = S.order.indexOf(id);
        if (i >= 0) S.order.splice(i, 1);
        removed = true;
      }
    });
    /* 删 plus 不重排（2026-11-18 实测根因，别再改回去）：
       原来这里调 relayoutAll()，而 relayoutAll 给每个 root 无条件写 n.x=cursor、n.y=0。
       首图刚在 sendFrom 里按 plus 坐标算好位置，紧接着 addNode 触发本函数，
       pending 被提成唯一 root 后一把拉去世界原点 (0,0) —— 用户在画布中心
       只看到空白，占位框孤零零挂在左上角，才会说「点了开始没反应，得去对话里看」。
       删 plus 的连带责任只有三件：子节点提成 root、摘连线、删 DOM，上面都做完了。
       重排会把用户手拖过的位置一起覆盖掉，本就不该在这个时机发生。 */
    if (removed) save();
  }

  function removeNode(id) {
    var n = S.nodes[id];
    if (!n) return;
    /* 连带把挂在它下面的节点收掉，否则留下一堆指向空节点的连线 */
    S.order.slice().forEach(function (cid) {
      if (S.nodes[cid] && S.nodes[cid].parentId === id) removeNode(cid);
    });
    if (n.el && n.el.parentNode) n.el.remove();
    removeLink(id);
    delete S.nodes[id];
    var idx = S.order.indexOf(id);
    if (idx >= 0) S.order.splice(idx, 1);
    save();
  }

  function buildDrawer() {
    if (document.getElementById('cvDrawer')) return document.getElementById('cvDrawer');
    if (!S.stage) return null;
    var d = mk('div', 'cv-drawer');
    d.id = 'cvDrawer';
    d.innerHTML =
      '<div class="cv-drawer-head">' +
        '<div class="cv-drawer-title">生成图<span class="cv-drawer-count" id="cvDrawerCount"></span></div>' +
        '<button class="cv-drawer-close" id="cvDrawerClose" title="收起">✕</button>' +
      '</div>' +
      '<div class="cv-drawer-list" id="cvDrawerList"></div>';
    S.stage.appendChild(d);
    var close = d.querySelector('#cvDrawerClose');
    if (close) close.onclick = function () { toggleDrawer(false); };
    bindDrawer();
    return d;
  }

  function toggleDrawer(force) {
    var d = buildDrawer();
    if (!d) return;
    var open = (typeof force === 'boolean') ? force : !d.classList.contains('cv-open');
    d.classList[open ? 'add' : 'remove']('cv-open');
    if (open) refreshDrawer();
  }

  function fmtSize(n) {
    if (!n) return '0 B';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return Math.round(n / 1024) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  function fmtTime(ms) {
    try {
      var diff = Date.now() - ms, dt = new Date(ms);
      if (diff < 60000) return '刚刚';
      if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
      if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
      return (dt.getMonth() + 1) + '/' + dt.getDate() + ' ' + dt.getHours() + ':' + ('0' + dt.getMinutes()).slice(-2);
    } catch (e) { return ''; }
  }

  var _drawerItems = [];

  function refreshDrawer() {
    var list = document.getElementById('cvDrawerList');
    var cnt = document.getElementById('cvDrawerCount');
    if (!list) return;
    list.innerHTML = '<div class="cv-drawer-empty">读取中…</div>';
    apiGet('/api/workspace-ui/generated-images').then(function (res) {
      var imgs = (res && Array.isArray(res.images)) ? res.images : [];
      _drawerItems = imgs;
      if (cnt) cnt.textContent = imgs.length ? '（' + imgs.length + '）' : '';
      if (!imgs.length) {
        list.innerHTML = '<div class="cv-drawer-empty">还没有生成过图片。<br>在画布上发一条作图需求试试。</div>';
        return;
      }
      list.innerHTML = imgs.map(function (im, i) {
        return '<div class="cv-drawer-item" data-i="' + i + '">' +
          '<div class="cv-drawer-thumb"><img src="' + DOM.escAttr(im.url) + '" loading="lazy" alt=""></div>' +
          '<div class="cv-drawer-meta">' +
            '<div class="cv-drawer-name" title="' + DOM.escAttr(im.name) + '">' + DOM.escAttr(im.name) + '</div>' +
            '<div class="cv-drawer-sub">' + fmtSize(im.size) + ' · ' + fmtTime(im.mtime) + '</div>' +
          '</div>' +
          '<div class="cv-drawer-acts">' +
            '<button class="cv-icon-btn" data-act="dl" title="下载">⤓</button>' +
            '<button class="cv-icon-btn cv-danger" data-act="del" title="删除">✕</button>' +
          '</div>' +
        '</div>';
      }).join('');
    });
  }

  function bindDrawer() {
    var d = document.getElementById('cvDrawer');
    if (!d || d.dataset.cvBound) return;
    d.dataset.cvBound = '1';
    d.addEventListener('click', function (ev) {
      var item = ev.target.closest ? ev.target.closest('.cv-drawer-item') : null;
      if (!item) return;
      var im = _drawerItems[Number(item.dataset.i)];
      if (!im) return;
      var act = (ev.target.dataset && ev.target.dataset.act) || '';

      if (act === 'dl') {
        ev.stopPropagation();
        /* 同源直链 + download 属性，浏览器直接存盘，不绕 base64 */
        var a = document.createElement('a');
        a.href = im.url;
        a.download = im.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        return;
      }

      if (act === 'del') {
        ev.stopPropagation();
        if (!confirm('删掉这张图？文件从磁盘直接移除，不能撤销。\n' + im.name)) return;
        api('/api/workspace-ui/generated-images', 'DELETE', { path: im.path }).then(function () {
          /* 画布上挂着这张图的节点一起收，否则点开是空壳 */
          S.order.slice().forEach(function (id) {
            var n = S.nodes[id];
            if (n && n.url && n.url.indexOf(im.name) >= 0) removeNode(id);
          });
          refreshDrawer();
        }).catch(function (e) {
          toast('删除失败：' + ((e && e.message) || e), 'error');
        });
        return;
      }

      /* 点条目本身：画布上有这张图就飞过去，没有就光下载入口 */
      var hitId = null;
      S.order.forEach(function (id) {
        var n = S.nodes[id];
        if (n && n.url && n.url.indexOf(im.name) >= 0) hitId = id;
      });
      if (hitId && S.nodes[hitId]) centerOn(S.nodes[hitId]);
    });
  }

  /* 提示词改到图片悬停浮层（#cvPromptTip），不再有模态框。 */

  /* ══════════ 视图切换：画布 / 对话（同一个会话两种看法） ══════════ */

  function buildViewSwitch() {
    /* 2026-11-16 用户报「画布、对话按钮遮盖了现在的元素」：
       这按钮原来挂在 host 上做绝对定位，靠 syncViewSwitchTop() 量 header 底边往下推 ——
       推来推去始终是在和别的东西抢同一块地皮，量错了就压住放大镜。
       它其实是「这个会话怎么显示」，本来就该跟放大镜 / 工作区 / 多标签排在一行，
       是 header 的第四个图标，不是一个浮层。挪进 .chat-header .right 之后就归 flex 管，
       既不会遮挡任何元素，也不用每次 resize 重新算 top。
       切到对话模式时 stage 会整体隐藏，所以按钮必须留在 stage 外面 —— header 正好。 */
    var old = document.getElementById('cvViewSwitch');
    if (old) old.remove();
    var right = document.querySelector('.chat-header .right');
    if (!right) return;
    var b = mk('button', 'tool-btn');
    b.id = 'cvViewSwitch';
    b.type = 'button';
    b.style.width = '32px';
    b.style.height = '32px';
    right.appendChild(b);
    b.addEventListener('click', function () {
      setViewMode(S.viewMode === 'canvas' ? 'chat' : 'canvas');
    });
    syncViewSwitch();
  }

  /* 图标说明的是「点下去会去哪」，不是「现在在哪」：
     现在看画布 → 显示对话气泡（点了去对话）；现在看对话 → 显示网格（点了回画布）。 */
  var ICON_TO_CHAT =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round">' +
    '<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.2a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.8-7.6 8.4 8.4 0 0 1 3.7-.9h.5a8.5 8.5 0 0 1 8 8z"/></svg>';
  var ICON_TO_CANVAS =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
    '<rect x="3" y="3" width="7" height="7" rx="1.4"/><rect x="14" y="3" width="7" height="7" rx="1.4"/>' +
    '<rect x="3" y="14" width="7" height="7" rx="1.4"/><rect x="14" y="14" width="7" height="7" rx="1.4"/></svg>';

  function syncViewSwitch() {
    var b = document.getElementById('cvViewSwitch');
    if (!b) return;
    if (S.viewMode === 'chat') {
      b.innerHTML = ICON_TO_CANVAS;
      b.title = '切换到画布视图';
      b.classList.remove('cv-on');
    } else {
      b.innerHTML = ICON_TO_CHAT;
      b.title = '切换到对话视图';
      b.classList.add('cv-on');
    }
  }

  /* 画板不是另一个会话，只是同一个会话的另一种呈现（2026-11-16 用户需求）。
     切回对话：消息流、模型、工具、底部输入框全部照原样，一个字没动过。 */
  function setViewMode(mode) {
    if (mode !== 'chat' && mode !== 'canvas') return;
    S.viewMode = mode;
    var body = document.getElementById('chatBody');
    if (mode === 'chat') {
      if (body) { body.classList.remove('cv-hidden'); body.style.display = ''; }
      if (S.stage) S.stage.classList.add('cv-hidden');
      closeComposer();
      hidePromptTip();
      var d = document.getElementById('cvDrawer');
      if (d) d.classList.remove('cv-open');
      /* 2026-11-16 用户报「切回对话消息框没恢复原样」，根因在这：
         原来只把 chatBody 放出来、把 stage 藏起来，composer 一个字没动 ——
         它还带着 .cv-floating（position:absolute + bottom:18px + z-index:30 + 固定宽 760），
         于是浮在消息流上面，走文档流的位置空着；placeholder 还是「描述你想生成的画面」；
         sendBtn.onclick 和 chatInput.onkeydown 还是画板的回调 ——
         在普通对话里点发送会走进 submitFromComposer，跟画布抢逻辑。
         切回对话必须把这三样一起还回去，少一样都不算「恢复原样」。 */
      detachOriginalComposer();
      /* 2026-11-16：切换视图 ≠ 离开画板会话，#chatJumpBottom 的隐藏挂的是 body.cv-mode，
         而 cv-mode 原本只在 leave() 里摘。于是「画板→对话」切回来，按钮还是被压着不显示。
         它属于「当前看到的是不是画布」，不属于「这个会话是不是画板类型」，两条路径都得管。 */
      document.body.classList.remove('cv-mode');
    } else {
      if (body) { body.classList.add('cv-hidden'); body.style.display = 'none'; }
      if (S.stage) S.stage.classList.remove('cv-hidden');
      document.body.classList.add('cv-mode');
      attachOriginalComposer();
      initImageTarget();
    }
    try { localStorage.setItem('hermes_cv_view_' + S.sid, mode); } catch (e) {}
    syncViewSwitch();
  }

  function getViewMode() {
    try {
      var v = localStorage.getItem('hermes_cv_view_' + S.sid);
      if (v === 'chat' || v === 'canvas') return v;
    } catch (e) {}
    return 'canvas';
  }

  /* ────────────── 视图按钮 ────────────── */

  /* 左上角工具条（2026-11-16 用户要求）：生图模型下拉放在这里。
     原来它挤在右下角缩放按钮堆里，跟放大缩小做邻居 —— 一个是「用哪个模型」
     一个是「视图怎么缩」，语义差得远。挪到左上，正好在画布起点那一侧。 */
  function buildTopLeft() {
    var old = document.getElementById('cvTopLeft');
    if (old) old.remove();
    var bar = mk('div', 'cv-topleft');
    bar.id = 'cvTopLeft';
    /* 按钮重做（2026-11-16 用户第 45 条：「这个太丑了」）。
       原来是纯文字「生图 · fan · gpt-image-2」，一个字都不省 —— 22 个字符挤在
       200px 里被 ellipsis 切掉尾巴，看着像报错信息。
       现在拆成三段：一个薄荷绿的星芒图标（一眼看出是「生成」类），
       模型名（截断留给它自己），一个极小的下拉箭头表明可点。
       「生图」两个字挪进 title，反正它只需要被 hover 时解释一次。 */
    bar.innerHTML =
      '<button type="button" class="cv-target" id="cvTargetBtn" title="生图模型">' +
        '<svg class="cv-target-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
          'stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<path d="M12 2.5v3.2M12 18.3v3.2M2.5 12h3.2M18.3 12h3.2"/>' +
          '<path d="M12 7.4a4.6 4.6 0 1 0 0 9.2 4.6 4.6 0 0 0 0-9.2z"/>' +
        '</svg>' +
        '<span class="cv-target-name">—</span>' +
        '<span class="cv-target-caret" aria-hidden="true">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" ' +
            'stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>' +
        '</span>' +
      '</button>';
    /* 2026-11-17 修「有的时候点不开」：原来判 ev.target.id === 'cvTargetBtn'，
       但按钮里包着 svg 图标、模型名 span、箭头 span —— 点到这些子元素时
       ev.target 是它们，id 是空串，判定直接不成立。而 span.cv-target-name
       占了按钮九成面积，等于只有戳到边缘留白才弹得出菜单。
       改成 closest('#cvTargetBtn')，按钮任意位置都算命中。 */
    bar.addEventListener('click', function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest('#cvTargetBtn') : null;
      if (btn) { toggleTargetMenu(btn); return; }
    });
    S.stage.appendChild(bar);
    syncTargetLabel();
  }

  function buildControls() {
    var box = document.getElementById('cvControls');
    if (box) { box.remove(); }
    box = mk('div', 'cv-controls');
    box.id = 'cvControls';
    box.innerHTML =
      '<button title="生成图目录" data-cv="dir">▤</button>' +
      '<button title="放大" data-cv="in">+</button>' +
      '<button title="缩小" data-cv="out">−</button>' +
      '<button title="布局方向" data-cv="layout">' + (S.layout === 'horizontal' ? '⇉' : '⇅') + '</button>' +
      '<button title="回到起点" data-cv="reset">⌖</button>';
    box.addEventListener('click', function (ev) {
      var act = ev.target && ev.target.dataset ? ev.target.dataset.cv : '';
      if (!act) return;
      if (act === 'dir') { toggleDrawer(); return; }
      if (act === 'in') { S.view.k = Math.min(MAX_K, S.view.k * 1.2); applyView(); }
      if (act === 'out') { S.view.k = Math.max(MIN_K, S.view.k / 1.2); applyView(); }
      if (act === 'reset') { fitToNodes(); }
      if (act === 'layout') { setLayout(S.layout === 'horizontal' ? 'vertical' : 'horizontal'); return; }
      save();
    });
    S.stage.appendChild(box);
  }

  /* 舞台顶部让出 header + 标签栏（2026-11-16）：标签栏能展能收、窗口能缩放，
     所以不是一次性算完，resize 时要重算。 */
  function syncStageTop() {
    if (!S.stage) return;
    var body = document.getElementById('chatBody');
    var top = S._stageTop || 0;
    /* body 在画板里是 display:none，offsetTop 读不到；这时退回按 header 高度累加 */
    if (!body || body.style.display === 'none') {
      var hdr = document.querySelector('.chat-header');
      var tabs = document.getElementById('sessionTabs');
      top = (hdr ? hdr.offsetHeight : 0);
      if (tabs && tabs.offsetHeight) top += tabs.offsetHeight;
    } else {
      top = body.offsetTop || top;
    }
    S.stage.style.top = top + 'px';
    S._stageTop = top;
  }

  /* 标签栏显隐会改 stage 的起点（2026-11-17 用户反馈「画板下展开多会话标签看不到」）：
     进画板那一刻标签栏若收着，syncStageTop() 只算到 header 底边；此后用户点
     「显示多会话标签」把标签栏撑出 59px，没有任何人再调 syncStageTop，stage 就停在
     旧 top 上——它又是 absolute + DOM 末尾，整条标签栏被蒙在底下。
     onWinResize 只管窗口缩放，管不到标签栏。这里用 ResizeObserver 盯住标签栏本身：
     收起/展开/换会话/窗口缩放都会触发，比在 tabs.js 五处调用点上各挂一次回调稳。 */
  var _tabsRO = null;
  function watchStageTop() {
    if (_tabsRO || typeof ResizeObserver === 'undefined') return;
    var tabs = document.getElementById('sessionTabs');
    if (!tabs) return;
    _tabsRO = new ResizeObserver(function () {
      if (!S.on || !S.stage) return;
      syncStageTop();
    });
    _tabsRO.observe(tabs);
  }

  /* 视图切换按钮已挪进 header（见 buildViewSwitch），位置交给 flex 排，
     不再需要按 header 底边算 top —— syncViewSwitchTop 整段删除。
     留着它只会让人以为还有个浮层要定位。 */

  function onWinResize() { if (S.on) syncStageTop(); }

  function fitToNodes() {
    /* 起始圆也算进框选范围（2026-11-16）：以前把它排除在外，回填历史图后
       视野只框住图片节点，用户进画板根本看不到「开始」在哪。 */
    var ids = S.order.filter(function (id) { return S.nodes[id] && S.nodes[id].kind !== 'pending'; });
    if (!ids.length) {
      var c = centerWorld();
      S.nodes[S.order[0]] && null;
      S.view = { x: 0, y: 0, k: 1 };
      applyView();
      return;
    }
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    ids.forEach(function (id) {
      var n = S.nodes[id], s = nodeSize(n);
      minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + s.w); maxY = Math.max(maxY, n.y + s.h);
    });
    var r = S.stage.getBoundingClientRect();
    var pad = 80;
    var k = Math.min(
      (r.width - pad * 2) / Math.max(1, maxX - minX),
      (r.height - pad * 2) / Math.max(1, maxY - minY),
      1
    );
    k = Math.max(MIN_K, Math.min(MAX_K, k));
    S.view.k = k;
    S.view.x = (r.width - (maxX - minX) * k) / 2 - minX * k;
    S.view.y = (r.height - (maxY - minY) * k) / 2 - minY * k;
    applyView();
  }

  /* ────────────── 持久化回填 ────────────── */

  function restore(saved) {
    if (!saved || !Array.isArray(saved.nodes) || !saved.nodes.length) return false;
    /* ── 老存档迁移（2026-11-17）───────────────────────────────────
       旧代码发消息时无条件把新图接到「上一张图」下面，所以画出来是一条链到底，
       节点上的 parentId 只是布局痕迹，不代表用户真的引用过。
       用户的规矩是「引用才是分支的基础数据」：不引用某张图，就该从新节点开始。
       老存档里没有 refId 这种凭据 —— 一律按「没引用」处理，断开成独立根。
       （用户原话：老的在没有引用的情况下，按新的规矩都应该是断开的节点。）

       幂等：版本号抬到 2 并立刻回写，第二次进来就走新口径，不会反复断。
       断开只是不再连线，节点、坐标、图、提示词一个都不删。 */
    var legacy = (saved.version || 1) < 2;

    /* ── 拆掉提示词节点（2026-11-17 用户第 6 条）─────────────────────
       原话：「引用图片导致提示词也变成了元素建到了图里」。
       旧代码 sendFrom() 里无条件 addNode({kind:'text'})，于是每发一句就在两张图
       中间插一个写着「提示 / 改成黑猫」的方框，pending 再挂在它下面。
       现在这个创建点已经删了，但老存档里那些节点还在 —— 用户打开老画板看到的
       就是截图里两块方框夹一张图。这里把它们拆掉，子节点直接提到祖父上：
       白猫 →(text)→ 黑猫  收成  白猫 → 黑猫，连线不断。
       提示词不丢：老 image 节点常常自己没存 injected，提示词只写在 text 节点上，
       拆之前先把它捞到子节点身上。 */
    var byId = {};
    saved.nodes.forEach(function (sn) { byId[sn.id] = sn; });
    var textIds = {};
    var dropped = 0;
    saved.nodes.forEach(function (sn) {
      if (sn.kind === 'text') { textIds[sn.id] = true; dropped++; }
    });
    function liftParent(pid) {
      var guard = 0;
      while (pid && textIds[pid] && guard++ < 50) {
        var t = byId[pid];
        pid = (t && t.parentId) || '';
      }
      return pid || '';
    }
    /* ── 同图两路径：合并成一个节点（2026-11-17）────────────────────
       老存档里已经躺着成对的「同一张图两路径」节点：一个 /assets/generated/x.png
       能显示，一个 /assets/x.png 是 404 裂图，两个还挂在同一父下平级。
       用户看到的就是「多了一个节点，图是裂的」。这里按 imgKey 认同一张图，
       优先留路径带 /generated/ 的那个，另一个记进 dupMap：不建节点，
       指向它的 parentId/refId 一律改指保留者。 */
    var keyOwner = {}, dupMap = {};
    saved.nodes.forEach(function (sn) {
      if (sn.kind !== 'image' || !sn.url) return;
      var k = imgKey(sn.url);
      var cur = keyOwner[k];
      if (!cur) { keyOwner[k] = sn; return; }
      var snGood = /\/generated\//.test(sn.url), curGood = /\/generated\//.test(cur.url);
      var better = (snGood && !curGood) ? sn : cur;
      var worse = (better === sn) ? cur : sn;
      keyOwner[k] = better;
      dupMap[worse.id] = better.id;
    });
    function resolveDup(id) {
      var guard = 0;
      while (id && dupMap[id] && guard++ < 20) id = dupMap[id];
      return id || '';
    }
    function inheritInjected(sn) {
      var inj = sn.injected || '';
      var p = byId[sn.parentId];
      var guard = 0;
      while (!inj && p && p.kind === 'text' && guard++ < 50) {
        inj = p.injected || '';
        p = byId[p.parentId];
      }
      return inj;
    }

    saved.nodes.forEach(function (sn) {
      if (textIds[sn.id]) return;
      if (dupMap[sn.id]) return;            // 同图的裂图副本，丢掉
      var pid = resolveDup(liftParent(sn.parentId));
      var ref = resolveDup(liftParent(sn.refId || ''));
      addNode({
        id: sn.id, kind: sn.kind, x: sn.x, y: sn.y,
        parentId: (legacy && !ref) ? '' : pid,
        refId: ref,
        url: sn.url, text: sn.text, injected: inheritInjected(sn)
      });
    });
    /* 只有对象才是视口（2026-11-17 实测踩到）：S.view 是 {x,y,k}，
       存档里若混进 'canvas' 这种字符串，centerOn 会往字符串上写 .x 直接抛错，
       进画板当场白屏。类型不对就丢掉，用默认视口。 */
    if (saved.view && typeof saved.view === 'object' && !Array.isArray(saved.view)) {
      S.view = saved.view; applyView();
    }
    /* 版本抬到 3：拆过提示词节点的存档不用再走一遍；老存档则必须回写，
       否则下次打开又按老的 version 判断重复迁移。 */
    if (legacy || dropped || Object.keys(dupMap).length) save();
    return true;
  }

  /* ────────────── 生命周期 ────────────── */

  function enter(sid) {
    if (!sid) return;
    var body = document.getElementById('chatBody');
    if (!body || !body.parentNode) return;

    // 换会话：先把旧的收掉
    if (S.on && S.sid !== sid) leave();

    S.sid = sid;
    S._autoFitted = false;
    S.layout = getLayout();
    S.on = true;
    S.busy = false;

    /* 先量正文区的起点，再隐藏它（2026-11-16 用户发现放大镜被压）：
       host 是整个 .page，chat-header 和多会话标签栏都在里面，而且都是静态定位、
       没有 z-index —— stage 只要 inset:0 就整块蒙上去，放大镜/工作区/多标签全被盖住。
       量 offsetTop 必须在 display:none 之前，隐藏后它恒为 0。 */
    S._stageTop = body.offsetTop || 0;

    // 原消息流隐藏但保留：sendRaw / SSE 都挂在它上面
    body.classList.add('cv-hidden');
    body.style.display = 'none';
    /* 画板态标记（2026-11-16 用户第 45 条）：
       「这个元素在画图下不要有了」——#chatJumpBottom 那个回到底部的箭头。
       不用 el.hidden 是因为 tabs.js 的滚动监听会自己把它 hidden=false 改回来
       （hideScrollBtn / updateScrollBtn 一直在跑），打 class 交给 CSS !important 才压得住。 */
    document.body.classList.add('cv-mode');

    var host = body.parentNode;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';

    var stage = document.getElementById('canvasStage');
    if (!stage) {
      stage = mk('div');
      stage.id = 'canvasStage';
      stage.innerHTML = '<div id="canvasWorld"><svg id="canvasLinks"></svg></div>';
      host.appendChild(stage);
    }
    stage.classList.remove('cv-hidden');
    S.stage = stage;
    syncStageTop();
    watchStageTop();
    if (!S._resizeHooked) { S._resizeHooked = true; window.addEventListener('resize', onWinResize); }
    buildTopLeft();
    /* 画板专用：本轮能力默认勾上图像生成 */
    markCapability('image_gen');
    S.world = document.getElementById('canvasWorld');
    S.svg = document.getElementById('canvasLinks');
    /* svg 连线层可能已被上一次清理误删（2026-11-16 实测：第二次进画板拿到 null，
       后面 S.svg.style 抛错把整个 enter 打断）。缺了就补一层，别假设它一定在。 */
    if (!S.svg && S.world) {
      S.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      S.svg.setAttribute('id', 'canvasLinks');
      S.world.appendChild(S.svg);
    }
    if (S.svg) {
      /* 同上：尺寸给足，否则连线全被裁在 0.36px 的 viewport 外 */
      S.svg.style.position = 'absolute';
      S.svg.style.left = '0';
      S.svg.style.top = '0';
      S.svg.style.width = '4000px';
      S.svg.style.height = '4000px';
      S.svg.style.overflow = 'visible';
      S.svg.style.pointerEvents = 'none';
    }

    bindCanvas();
    bindDrop();
    S.host = host;
    buildControls();
    buildDrawer();
    buildViewSwitch();
    /* 输入框复用 + 生图目标（2026-11-16）：原输入框浮上来，
       回调换成画板自己的；节点一起就绪后才初始化生图目标。 */
    attachOriginalComposer();
    initImageTarget();

    // 回填历史
    S.nodes = {}; S.order = []; S.seenImgs = {};
    /* 先清节点，再清连线：清理 children 时必须放过 canvasLinks，
       否则 svg 连线层被删掉，下一次 enter 拿到 null。 */
    if (S.world) {
      Array.prototype.slice.call(S.world.children).forEach(function (c) {
        if (c.id !== 'cvTargetMenu' && c.id !== 'canvasLinks') c.remove();
      });
    }
    if (S.svg) S.svg.innerHTML = '';
    var saved = load();
    var restored = restore(saved);

    if (!restored) {
      // 全新画板：中间一个圆加号
      var c = centerWorld();
      addNode({ kind: 'plus', x: Math.round(c.x - 46), y: Math.round(c.y - 46) });
      S.view = { x: 0, y: 0, k: 1 };
      applyView();
    } else {
      relinkAll();
    }

    watchChatBody();
    watchBusy();

    /* 历史图回填（2026-11-16）：消息是异步渲染的，进画板这一刻 chatBody 里往往还是空的，
       只扫一次会扑空。先扫一次，再补两次兜底 —— observer 已挂上，后续渲染也会触发。 */
    backfillFromHistory();
    setTimeout(function () { if (S.on && S.sid === sid) backfillFromHistory(); }, 800);
    setTimeout(function () {
      if (!(S.on && S.sid === sid)) return;
      backfillFromHistory();
      /* 回填完自动适配一次视野（2026-11-16）：只在这个会话第一次进来时做，
         之后用户自己拖到哪就停在哪，不硬拽。 */
      if (!S._autoFitted) { S._autoFitted = true; try { fitToNodes(); } catch (e) {} }
      pruneStartNode();
    }, 1600);

    /* 恢复上次的查看方式（2026-11-16）：画板会话也能停在「对话」视图，
       刷新页面或切回来不该被强行拽回画布。 */
    S.viewMode = getViewMode();
    setViewMode(S.viewMode);

    /* 画板会话的对话模型保持原样，不动 _selectedModelMap（2026-11-16 踩坑）：
       生图模型不是对话模型 —— 把 gpt-image-2 塞进 payload.model，agent 拿它当
       聊天模型用，直接卡在「正在思考…」，队列任务全部 failed。
       生图交给 image_generate 工具，它自己读 config.yaml 的 image_gen 段。
       这里只记下当前选中的生图目标，供提示词里点名用。 */
    apiGet('/api/workspace-ui/image-targets').then(function (res) {
      var targets = (res && Array.isArray(res.targets)) ? res.targets : [];
      if (!targets.length || !S.sid) return;
      window._cvImageTarget = window._cvImageTarget || {};
      if (!window._cvImageTarget[S.sid]) {
        /* 与 initImageTarget 同一判据：先认会话已选模型，再退回 targets[0]（2026-11-18） */
        var _wantM2 = (typeof _getSessionModel === 'function') ? _getSessionModel(S.sid) : '';
        var _hitT2 = null;
        if (_wantM2) {
          for (var _tj = 0; _tj < targets.length; _tj++) {
            if (targets[_tj].model === _wantM2 || targets[_tj].label === _wantM2) { _hitT2 = targets[_tj]; break; }
          }
        }
        window._cvImageTarget[S.sid] = _hitT2 ? (_hitT2.label || _hitT2.model) : (targets[0].label || targets[0].model);
      }
    }).catch(function () {});
  }

  function leave() {
    if (S.observer) { S.observer.disconnect(); S.observer = null; }
    S.on = false;
    S.sid = null;
    S.busy = false;
    closeComposer();
    /* 原输入框还回去（2026-11-16）：去掉浮动类、把 onclick / onkeydown
       换回面板原来的处理函数，不然普通对话的发送会走到画板逻辑上。 */
    detachOriginalComposer();
    /* 画板专属浮层跟着收（2026-11-16）：视图切换挂在 stage 外面，
       不删的话切到普通会话它还浮在别人头上。 */
    ['cvViewSwitch', 'cvDrawer', 'cvPromptTip'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.remove();
    });
    var body = document.getElementById('chatBody');
    if (body) { body.classList.remove('cv-hidden'); body.style.display = ''; }
    var stage = document.getElementById('canvasStage');
    if (stage) stage.classList.add('cv-hidden');
    document.body.classList.remove('cv-mode');
  }

  /* 切页面收浮层（2026-11-18 用户报「提示词弹出时切到别的页面就一直留着、关不掉」）：
     #cvPromptTip 是 position:fixed + pointer-events:none 挂在 document.body 上，
     收紧它的三条老路径全在画板内部 —— stage 点空白、setViewMode('chat')、leave()。
     switchPage() 一个都不经过，于是钉住的浮层悬在新页面最上层（z-index 240），
     又因为点不到它自己、新页面也没有画布的点击监听，用户没有任何办法关掉。
     switchPage 末尾本来就派发 hermes:page，接上即可；留在 chat 页时不动。 */
  document.addEventListener('hermes:page', function (ev) {
    var p = ev && ev.detail && ev.detail.page;
    if (p !== 'chat') hidePromptTip();
  });

  return {
    enter: enter,
    leave: leave,
    isOn: function () { return S.on; },
    currentSession: function () { return S.sid; },
    /* 强制切回画布视图（2026-11-16）：左树点当前画板会话时要用，
       否则 localStorage 里存着 'chat' 就永远停在对话视图。 */
    showCanvas: function () { if (S.on) setViewMode('canvas'); },
    showChat: function () { if (S.on) setViewMode('chat'); },
    viewMode: function () { return S.viewMode; },
    openGallery: function () { if (S.on) toggleDrawer(true); },
    /* 供外部在会话切换时判断；顺手把提示词浮层收掉（2026-11-18）：
       左树点同一个画板会话走的是 refresh 而不是 enter，钉住的浮层会跟着跨会话带过去。 */
    refresh: function (sid) { if (S.on) hidePromptTip(); if (S.on && S.sid !== sid) enter(sid); },
    /* 给外部（页面切换 / 会话切换）一个明确入口，省得以后又漏一条路径 */
    hideTip: hidePromptTip,
    /* 只读调试口（2026-11-17）：S 在闭包里，连线出问题时外部连"有几个节点、
       谁是谁的父节点"都看不到，只能靠截图猜。给一个只读快照，
       不含任何写操作，也不改布局。 */
    _debug: function () {
      var nodes = {};
      Object.keys(S.nodes || {}).forEach(function (k) {
        var n = S.nodes[k];
        nodes[k] = { id: n.id, kind: n.kind, parentId: n.parentId || null,
                     x: n.x, y: n.y, w: n.w, h: n.h,
                     /* 提示词截断一段就够了：排查「为什么这张没连上」时，
                        第一件事就是看它和上一张的 prompt 是不是同一个。 */
                     prompt: promptOf(n.injected || '').slice(0, 60) };
      });
      return { on: S.on, sid: S.sid, layout: S.layout, view: S.view,
               order: (S.order || []).slice(), nodeCount: Object.keys(nodes).length,
               nodes: nodes, svgParent: !!(S.svg && S.svg.parentNode) };
    }
  };
})();

/* 页面启动自恢复（2026-11-16）
   刷新后 currentSession 从本地恢复，但 switchTabCore 见到
   sid === currentSession 会直接 return，压根不走画板分流 ——
   表现为「刷新一下画板会话就变回普通对话」。
   这里等 workspace 数据真正就绪（pwSessionType 返回非 null）后补一次判定，
   最多等 20 秒，超时不再纠缠，绝不无限轮询。 */
(function bootSync() {
  var tries = 0;
  var timer = setInterval(function () {
    tries++;
    var sid = window.currentSession;
    var t = null;
    try {
      if (typeof window.pwSessionType === 'function' && sid) t = window.pwSessionType(sid);
    } catch (e) {}
    if (t !== null && t !== undefined) {
      clearInterval(timer);
      if (t === 'canvas' && window.CanvasMode && !CanvasMode.isOn()) {
        try { CanvasMode.enter(sid); } catch (e) {}
      }
      return;
    }
    if (tries > 40) clearInterval(timer);
  }, 500);
})();
