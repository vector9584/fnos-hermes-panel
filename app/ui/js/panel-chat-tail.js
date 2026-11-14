/*! panel-chat-tail.js — 气泡单一闭合轮廓 + 彩色跑马灯框 + 呼吸灯（v9，2026-11-14 按设计稿重做）
 *
 * 设计稿：/vol1/1000/飞牛文件/Code_20261114025153.html（用户让别的 AI 出的两套配色 + 动效规格）
 *
 * 一条闭合 path 同时承担四件事：
 *   svg.hp-frame > path.hp-shape   气泡填充（含三角）
 *   svg.hp-frame > path.hp-halo    呼吸灯柔光晕（stroke 2→6px + feGaussianBlur）
 *   svg.hp-frame > path.hp-line    静态细描边（呼吸时 1.5→1.9px 且换色）
 *   span.hp-ring                   七色 conic-gradient 环带，mask 用同一条 d 描 4px
 *
 * 几何（设计稿原值）：
 *   TAIL=14 三角高、伸出 0.58×14=8.12px、三角中线对准头像垂直中线
 *   RO=18  三角对侧的三个大圆角 / RT=5 靠三角那两个小圆角
 *   PADX=16 / PADY=4  环带层四边外扩（4px 居中描边外溢 2px，上下不外扩会把弧线削平）
 */
(function () {
  var NS = 'http://www.w3.org/2000/svg';
  var PADX = 16, PADY = 4;
  var RING_W = 4;      /* 环带宽度：设计稿写死 4px 居中描边 */
  var TAIL = 14;       /* 三角高度 */
  var RO = 18;         /* 大圆角 */
  var RT = 5;          /* 三角侧小圆角 */

  /* 生成闭合 path 的 d。
     W,H   气泡 content-box 尺寸
     side  'them' 尾巴朝左 / 'me' 尾巴朝右（x 镜像 + 反向遍历段序列）
     ox    整体 x 平移（frame 用 PADX，mask 用 0 再靠 SVG transform 平移）
     tt    三角上沿 y（三角占 [tt, tt+TAIL]，尖端在 tt+TAIL/2） */
  function buildPath(W, H, side, ox, tt) {
    ox = ox || 0;
    var d = TAIL * 0.58;
    var t1 = tt, t2 = tt + TAIL, ty = tt + TAIL / 2;

    var mx = function (x) { return +(ox + (side === 'them' ? x : W - x)).toFixed(2); };
    var A = [mx(RT), 0], segs = [];
    var L = function (x, y) { segs.push({ t: 'L', p: [mx(x), y] }); };
    var Q = function (cx, cy, x, y) { segs.push({ t: 'Q', p: [mx(cx), cy, mx(x), y] }); };

    L(W - RO, 0); Q(W, 0, W, RO);          /* 顶边 → 右上大圆角 */
    L(W, H - RO); Q(W, H, W - RO, H);      /* 右边 → 右下大圆角 */
    L(RO, H);     Q(0, H, 0, H - RO);      /* 底边 → 左下大圆角 */
    L(0, t2); L(-d, ty); L(0, t1); L(0, RT);  /* 三角：下沿 → 尖端 → 上沿 → 小圆角起点 */
    Q(0, 0, RT, 0);                        /* 回到 A */

    /* pts[i] = segs[i] 的起点；x 镜像会翻转绕向，倒序遍历段序列即可抵消 */
    var pts = [A].concat(segs.map(function (s) {
      return s.t === 'L' ? [s.p[0], s.p[1]] : [s.p[2], s.p[3]];
    }));
    var out = ['M ' + A[0] + ' ' + A[1]];
    if (side === 'them') {
      segs.forEach(function (s) { out.push(s.t + ' ' + s.p.join(' ')); });
    } else {
      for (var i = segs.length - 1; i >= 0; i--) {
        var s = segs[i], end = pts[i];   /* 反向段：起点变终点，Q 控制点不变 */
        out.push(s.t === 'L'
          ? 'L ' + end[0] + ' ' + end[1]
          : 'Q ' + s.p[0] + ' ' + s.p[1] + ' ' + end[0] + ' ' + end[1]);
      }
    }
    out.push('Z');
    return out.join(' ');
  }

  /* 三角上沿：让三角中线对准头像垂直中线；短气泡里夹在上下圆角之间 */
  function tailTop(H, center) {
    var tt = center - TAIL / 2;
    var lo = RT;                        /* 上边小圆角之后 */
    var hi = H - RO - TAIL;             /* 下边大圆角之前 */
    if (hi < lo) return Math.max(0, Math.round((H - TAIL) / 2));
    return Math.max(lo, Math.min(hi, tt));
  }

  /* 呼吸灯的柔光晕滤镜：整页只建一次 */
  function ensureDefs() {
    if (document.getElementById('hpSoftGlowSVG')) return;
    var host = document.createElement('div');
    host.id = 'hpSoftGlowSVG';
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
    host.innerHTML = '<svg xmlns="' + NS + '"><defs><filter id="hpSoftGlow" x="-60%" y="-60%" ' +
      'width="220%" height="220%" color-interpolation-filters="sRGB">' +
      '<feGaussianBlur id="hpSoftGlowBlur" stdDeviation="3"/></filter></defs></svg>';
    document.body.appendChild(host);
  }

  function ensureLayers(bub) {
    ensureDefs();
    var svg = bub.querySelector('svg.hp-frame');
    if (!svg) {
      svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('class', 'hp-frame');
      svg.setAttribute('aria-hidden', 'true');
      ['hp-shape', 'hp-halo', 'hp-line'].forEach(function (cls) {
        var p = document.createElementNS(NS, 'path');
        p.setAttribute('class', cls);
        if (cls === 'hp-halo') p.setAttribute('filter', 'url(#hpSoftGlow)');
        svg.appendChild(p);
      });
      bub.insertBefore(svg, bub.firstChild);
    }
    var ring = bub.querySelector('.hp-ring');
    if (!ring) {
      ring = document.createElement('span');
      ring.className = 'hp-ring';
      ring.setAttribute('aria-hidden', 'true');
      bub.insertBefore(ring, svg.nextSibling);
    }
    return { svg: svg, ring: ring };
  }

  /* 按实际尺寸重算一条消息的轮廓 */
  function draw(m) {
    if (!m || !m.querySelector) return;
    var bub = m.querySelector('.msg-bubble');
    if (!bub) return;
    var W = bub.offsetWidth, H = bub.offsetHeight;
    if (!W || !H) return;
    var layers = ensureLayers(bub), svg = layers.svg, ring = layers.ring;

    var side = m.classList.contains('user') ? 'me' : 'them';

    /* 三角中线 = 头像垂直中线（设计稿 12+14/2=19 ≈ 38/2，本面板头像 40 ⇒ 20） */
    var center = 20;
    var av = m.querySelector('.msg-avatar');
    if (av) {
      var ab = av.getBoundingClientRect(), bb = bub.getBoundingClientRect();
      if (ab.height) center = ab.top + ab.height / 2 - bb.top;
    }
    var tt = tailTop(H, center);

    /* 三层共用的 d（frame 里带 PADX 平移） */
    var dPad = buildPath(W, H, side, PADX, tt);
    svg.querySelectorAll('path').forEach(function (p) { p.setAttribute('d', dPad); });
    var boxW = W + 2 * PADX;
    svg.setAttribute('width', boxW);
    svg.setAttribute('height', H);
    svg.setAttribute('viewBox', '0 0 ' + boxW + ' ' + H);

    /* 环带遮罩：d 与 .hp-line 完全相同，只靠 SVG transform 整体平移 (PADX,PADY)；
       画布四边都留余量 ⇒ 居中描边外溢的 2px 不被 viewBox 裁掉，上下弧线完整。 */
    var CW = W + 2 * PADX, CH = H + 2 * PADY;
    var dCore = buildPath(W, H, side, 0, tt);
    var maskSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + CW + '" height="' + CH +
      '" viewBox="0 0 ' + CW + ' ' + CH + '"><g transform="translate(' + PADX + ',' + PADY + ')">' +
      '<path d="' + dCore + '" fill="none" stroke="#fff" stroke-width="' + RING_W +
      '" stroke-linejoin="round" stroke-linecap="round"/></g></svg>';
    ring.style.setProperty('--hp-mask', 'url("data:image/svg+xml,' + encodeURIComponent(maskSvg) + '")');

    /* 呼吸灯模糊量跟主题走（浅 3 / 深 3.5） */
    var blur = document.getElementById('hpSoftGlowBlur');
    if (blur) {
      var cs = getComputedStyle(m), v = parseFloat(cs.getPropertyValue('--hp-glow-blur'));
      blur.setAttribute('stdDeviation', (isNaN(v) ? 3 : v).toString());
    }

    m.dataset.hpW = W; m.dataset.hpH = H; m.dataset.hpTT = tt;
  }

  function drawAll(root) {
    (root || document).querySelectorAll('.chat-body .msg').forEach(draw);
  }

  var ro = null;
  function observe() {
    var body = document.querySelector('.chat-body');
    if (!body || !window.ResizeObserver) return;
    if (ro) ro.disconnect();
    var pending = new Set(), raf = 0;
    ro = new ResizeObserver(function (entries) {
      entries.forEach(function (e) { pending.add(e.target); });
      if (raf) return;
      raf = requestAnimationFrame(function () {
        raf = 0;
        pending.forEach(function (el) {
          var m = el.closest ? el.closest('.msg') : null;
          if (m) draw(m);
        });
        pending.clear();
      });
    });
    body.querySelectorAll('.msg .msg-bubble').forEach(function (b) { ro.observe(b); });
  }

  /* 新消息由 panel 渲染流程 mutate 后触发；MutationObserver 兜住所有路径 */
  function watch() {
    var body = document.querySelector('.chat-body');
    if (!body || body.dataset.hpWatched === '1') return;
    body.dataset.hpWatched = '1';
    new MutationObserver(function (muts) {
      var hit = new Set();
      muts.forEach(function (mu) {
        mu.addedNodes.forEach(function (n) {
          if (n.nodeType !== 1) return;
          if (n.classList && n.classList.contains('msg')) hit.add(n);
          n.querySelectorAll && n.querySelectorAll('.msg').forEach(function (x) { hit.add(x); });
        });
        if (mu.type === 'attributes' && mu.target.classList && mu.target.classList.contains('msg')) hit.add(mu.target);
      });
      if (!hit.size) return;
      hit.forEach(draw);
      observe();
    }).observe(body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  }

  window.hpDrawTail = draw;
  window.hpDrawTails = drawAll;
  window.hpTailWatch = function () { watch(); observe(); };
  window.hpBuildTailPath = buildPath;
  window.hpTailGeometry = { TAIL: TAIL, RO: RO, RT: RT, RING_W: RING_W, PADX: PADX, PADY: PADY };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { watch(); drawAll(); observe(); });
  } else {
    watch(); drawAll(); observe();
  }
})();
