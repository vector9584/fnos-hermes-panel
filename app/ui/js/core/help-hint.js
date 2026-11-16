/* 面板通用「?」帮助：一个圆点 + 点开/移上去才展开的小气泡。
 *
 * 2026-11-16 抽成公共件。原来这段是 panel-model-v2-sheets.js 里的局部函数，
 * 模型页之外想用只能复制一遍 —— 用户点名「这个问号反复在用，你封装一下」。
 *
 * 用法：label.append(helpHint('这里放解释'))
 *       helpHint(window.HELP_TEXTS.model_test)
 * 样式：css/panel-model-ref.css 的 .qhint / .qmark / .qtip
 *
 * 交互约定（2026-11-16 用户要求）：点圆点展开、再点收起；点空白/别处/按 ESC
 * 也收起 —— 移动端没有 hover，只能点自己才关等于关不掉。
 *
 * 2026-11-16 补定位：气泡改成 position:fixed 之后，坐标必须现算 ——
 * 原来 absolute + left:50% 的写法，靠左的问号（「模型」「密钥」这两个都在左边）
 * 必有一半伸到滚动容器外被 overflow 裁掉，用户看到的就是「弹出来被截断」。
 * 现在展开前量一次气泡尺寸，再把 left/top 钳制在视口内：左右各留 12px，
 * 上方空间不够就翻到圆点下方，最后还是放不下就贴底。滚动或改窗口大小直接收起，
 * 免得气泡钉在旧坐标上跟内容脱节。
 */
(function () {
  'use strict';

  var PAD = 12;    /* 视口边缘留白 */
  var GAP = 8;     /* 气泡与圆点的间距 */

  /* 把气泡摆到圆点上方居中；左右钳制，上方不够翻到下方。 */
  function place(w) {
    var tip = w.querySelector('.qtip');
    if (!tip) return;
    var r = w.getBoundingClientRect();
    /* visibility:hidden 仍然参与布局，所以这里量得到真实尺寸，不用先显示再量。 */
    var tw = tip.offsetWidth || 300;
    var th = tip.offsetHeight || 0;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var left = r.left + r.width / 2 - tw / 2;
    left = Math.max(PAD, Math.min(left, vw - tw - PAD));
    var top = r.top - th - GAP;
    if (top < PAD) top = r.bottom + GAP;                        /* 上面放不下 */
    if (top + th > vh - PAD) top = Math.max(PAD, vh - th - PAD); /* 下面也放不下 */
    tip.style.left = Math.round(left) + 'px';
    tip.style.top = Math.round(top) + 'px';
  }

  function helpHint(text) {
    var w = document.createElement('span');
    w.className = 'qhint';
    var dot = document.createElement('i');
    dot.className = 'qmark';
    dot.textContent = '?';
    var tip = document.createElement('span');
    tip.className = 'qtip';
    tip.textContent = text == null ? '' : String(text);
    w.appendChild(dot);
    w.appendChild(tip);
    w.onclick = function (ev) {
      ev.stopPropagation();
      var on = w.classList.toggle('on');
      if (on) place(w);        /* 先加 .on 再量，样式已生效、尺寸是准的 */
    };
    /* hover 也能展开（桌面端习惯），但同样得先摆位置，否则会闪在 (0,0) */
    w.addEventListener('mouseenter', function () { place(w); });
    return w;
  }

  /* 全局收起：绑一次就够，走捕获阶段，免得被别处 stopPropagation 吞掉。 */
  if (!window.__qhintDismiss) {
    window.__qhintDismiss = true;
    document.addEventListener('pointerdown', function (ev) {
      var on = document.querySelectorAll('.qhint.on');
      if (!on.length) return;
      var t = ev.target;
      for (var i = 0; i < on.length; i++) {
        if (on[i] === t || on[i].contains(t)) return;   /* 点自己：交给 onclick 去 toggle */
      }
      for (var j = 0; j < on.length; j++) on[j].classList.remove('on');
    }, true);
    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape' && ev.keyCode !== 27) return;
      var on = document.querySelectorAll('.qhint.on');
      for (var i = 0; i < on.length; i++) on[i].classList.remove('on');
    });
    /* 气泡用的是视口坐标，容器一滚它就错位了 —— 直接收掉，比钉在原地看着像 bug 好。 */
    var dismissOnMove = function () {
      var on = document.querySelectorAll('.qhint.on');
      for (var i = 0; i < on.length; i++) on[i].classList.remove('on');
    };
    window.addEventListener('scroll', dismissOnMove, true);
    window.addEventListener('resize', dismissOnMove);
  }

  window.helpHint = helpHint;
  /* 文案表：同一句话别在几个页面各写一遍，改口只改这里。 */
  window.HELP_TEXTS = window.HELP_TEXTS || {};
})();
