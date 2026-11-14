/* 档案 · 架构体系（提示词页第二个视图）
 * 内容：用户给的《Hermes 的文件即思维：谁写、谁读、什么时候生效》全图。
 *   SOUL 是常量（你写）／MEMORY·USER 是变量（Agent 写）／notes 与 AGENT.md 是索引—详情变体。
 * 交互：滚轮缩放（跟鼠标位置对齐）、按住拖动平移、适应宽度 / 原始大小、下载原图。
 * 说明：图是静态资源（app/ui/images/arch-hermes-files.png），不走接口，也不参与搜索索引——
 *   它讲的是「文件分工」，不是知识库的一部分。
 */
window.Archive.register('arch', (function () {
  'use strict';

  var A = window.Archive;
  var IMG_PATH = '/images/arch-hermes-files.png';
  var NATIVE = { w: 1920, h: 1300 };   /* 原图尺寸；onload 会再按实际值校正 */

  function el(tag, text, cls) { return A.el(tag, text, cls); }

  function render(st, host) {
    var wrap = el('div', null, 'arc-arch');

    var bar = el('div', null, 'arc-arch-bar');
    /* 手机没有滚轮：提示要换成能照做的动作（双击放大 / 拖动看细节），
       并且默认缩放给到"看得清标题"的档位——1920 原图铺满 375 只有 20%，满屏都是糊字。 */
    var mobile = window.matchMedia('(max-width: 900px)').matches;
    var tip = el('span', mobile ? '双击放大，拖看细节' : '谁写、谁读、什么时候生效——滚轮缩放，按住拖', 'arc-arch-tip');

    var tools = el('div', null, 'arc-arch-tools');
    var outBtn = el('button', '−', 'arc-arch-btn');
    outBtn.title = '缩小';
    var pctBtn = el('button', '100%', 'arc-arch-btn arc-arch-pct');
    pctBtn.title = '回到原始大小';
    var inBtn = el('button', '+', 'arc-arch-btn');
    inBtn.title = '放大';
    var fitBtn = el('button', '适应宽度', 'arc-arch-btn');
    var dlBtn = el('a', '下载原图', 'arc-arch-btn');
    dlBtn.href = apiUrl(IMG_PATH);
    dlBtn.download = 'hermes-files-architecture.png';
    tools.append(outBtn, pctBtn, inBtn, fitBtn, dlBtn);
    bar.append(tip, tools);

    var stage = el('div', null, 'arc-arch-stage');
    var img = document.createElement('img');
    img.className = 'arc-arch-img';
    img.src = apiUrl(IMG_PATH);
    img.alt = 'Hermes 的文件即思维：SOUL / AGENTS / MEMORY / USER / notes / SKILL 的分工与生效时机';
    img.draggable = false;
    stage.append(img);
    wrap.append(bar, stage);
    host.append(wrap);

    var scale = 1, tx = 0, ty = 0, fitScale = 1;
    var dragging = false, lastX = 0, lastY = 0;

    function apply() {
      img.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')';
      pctBtn.textContent = Math.round(scale * 100) + '%';
    }
    /* 居中摆放：图比视口小的时候居中，大的时候从左上角起（跟看图软件一致） */
    function center() {
      var sw = stage.clientWidth, sh = stage.clientHeight;
      var w = NATIVE.w * scale, h = NATIVE.h * scale;
      tx = w <= sw ? (sw - w) / 2 : 0;
      ty = h <= sh ? (sh - h) / 2 : 0;
      apply();
    }
    function fit() {
      var sw = stage.clientWidth;
      if (!sw) return;
      fitScale = Math.min(1.6, sw / NATIVE.w);
      /* 手机：铺满宽度等于把 1920 压到 375（20%），一个字都看不清。
         默认给 fitScale 的 2.2 倍（≈44%，标题和分栏能认出来），双击再放大到 100%。 */
      scale = mobile ? Math.min(1, fitScale * 2.2) : fitScale;
      center();
    }
    function zoomAt(next, cx, cy) {
      next = Math.max(0.15, Math.min(4, next));
      var sw = stage.clientWidth, sh = stage.clientHeight;
      var px = cx == null ? sw / 2 : cx, py = cy == null ? sh / 2 : cy;
      /* 让光标下的那个点缩放前后不动 */
      tx = px - (px - tx) * (next / scale);
      ty = py - (py - ty) * (next / scale);
      scale = next;
      apply();
    }

    img.onload = function () {
      NATIVE.w = img.naturalWidth || NATIVE.w;
      NATIVE.h = img.naturalHeight || NATIVE.h;
      fit();
    };
    /* 图已经在缓存里时 onload 可能不触发（complete 为真），补一次 */
    if (img.complete && img.naturalWidth) {
      NATIVE.w = img.naturalWidth; NATIVE.h = img.naturalHeight; fit();
    } else {
      setTimeout(fit, 60);
    }

    outBtn.onclick = function () { zoomAt(scale / 1.25); };
    inBtn.onclick = function () { zoomAt(scale * 1.25); };
    pctBtn.onclick = function () { scale = 1; center(); };
    fitBtn.onclick = function () { fit(); };

    stage.addEventListener('wheel', function (ev) {
      ev.preventDefault();
      var r = stage.getBoundingClientRect();
      zoomAt(scale * Math.exp(-ev.deltaY * 0.0016), ev.clientX - r.left, ev.clientY - r.top);
    }, { passive: false });

    stage.addEventListener('pointerdown', function (ev) {
      dragging = true; lastX = ev.clientX; lastY = ev.clientY;
      stage.setPointerCapture(ev.pointerId);
      stage.classList.add('is-drag');
    });
    stage.addEventListener('pointermove', function (ev) {
      if (!dragging) return;
      tx += ev.clientX - lastX; ty += ev.clientY - lastY;
      lastX = ev.clientX; lastY = ev.clientY;
      apply();
    });
    function release(ev) {
      dragging = false;
      stage.classList.remove('is-drag');
      try { stage.releasePointerCapture(ev.pointerId); } catch (_) {}
    }
    stage.addEventListener('pointerup', release);
    stage.addEventListener('pointercancel', release);

    /* 手机双击放大/还原：触屏上没有滚轮，给一个能用双指之外的办法 */
    var lastTap = 0;
    stage.addEventListener('click', function () {
      var now = Date.now();
      if (now - lastTap < 320) {
        if (Math.abs(scale - fitScale) < 0.02) zoomAt(Math.min(2, fitScale * 2.2));
        else fit();
      }
      lastTap = now;
    });

    st.archFit = fit;
  }

  return {
    render: render,
    unmount: function (st) { st.archFit = null; }
  };
})());
