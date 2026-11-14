/* ui-kit.js — 面板基础 UI 封装（2026-11-11）
 *
 * 为什么要有这层：面板里 15 个弹窗每个都是手拼 HTML 字符串，28 组 open/close
 * 各自管显示隐藏，toast 用内联样式硬编码了 4 个颜色。同一件事写了很多遍，
 * 每次写法都不一样，视觉不统一有一半是这么来的。
 *
 * 这里只封装 5 件重复度最高的事：modal / confirm / toast / field / table。
 * 不引框架、不要构建链，一个 script 标签加载，window.ui 直接用。
 *
 * 约定：
 *   1. 只复用面板已有的 CSS 类（.modal-*、.action），不另造一套视觉
 *   2. 颜色一律走 var(--token)，不写死 hex
 *   3. 用户数据走 textContent，不用 innerHTML 拼接（除非显式传 html:true）
 */
(function () {
  'use strict';

  var Z_BASE = 6000;
  var stack = [];
  var lastFocus = null;

  function el(tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  }

  function fill(host, body) {
    if (body == null) return;
    if (typeof body === 'string') {
      host.innerHTML = body;
    } else if (body.nodeType === 1) {
      host.appendChild(body);
    } else if (Array.isArray(body)) {
      body.forEach(function (b) {
        if (b == null) return;
        host.appendChild(typeof b === 'string' ? document.createTextNode(b) : b);
      });
    }
  }

  function lockScroll(on) {
    if (on) {
      document.body.dataset.uikitLock = '1';
      document.body.style.overflow = 'hidden';
    } else if (stack.length === 0) {
      delete document.body.dataset.uikitLock;
      document.body.style.overflow = '';
    }
  }

  function focusables(root) {
    return Array.prototype.filter.call(
      root.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
      function (n) { return !n.disabled && n.offsetParent !== null; }
    );
  }

  // ─────────────────────────────── modal ───────────────────────────────
  /* opt = {
   *   title, body, width, closable=true, className,
   *   actions: [{ text, primary, danger, disabled, onClick(close, e) }],
   *   onClose(reason)
   * }
   * 返回 { el, bodyEl, close(reason) }
   */
  function modal(opt) {
    opt = opt || {};
    var closable = opt.closable !== false;

    var backdrop = el('div', 'modal-backdrop uikit-backdrop' + (opt.overlayClass ? ' ' + opt.overlayClass : ''));
    if (opt.id) backdrop.id = opt.id;
    var panel = el('div', 'modal-panel uikit-panel' + (opt.className ? ' ' + opt.className : ''));
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    if (opt.title) panel.setAttribute('aria-label', String(opt.title));
    if (opt.width) panel.style.maxWidth = (typeof opt.width === 'number' ? opt.width + 'px' : opt.width);

    var head = el('div', 'modal-head');
    head.appendChild(el('h3', null, opt.title || ''));
    if (closable) {
      var x = el('button', 'modal-close', '×');
      x.type = 'button';
      x.setAttribute('aria-label', '关闭');
      x.addEventListener('click', function () { api.close('close-btn'); });
      head.appendChild(x);
    }
    panel.appendChild(head);

    var bodyEl = el('div', 'modal-body');
    if (opt.bodyHTML != null) bodyEl.innerHTML = String(opt.bodyHTML);
    else fill(bodyEl, opt.body);
    panel.appendChild(bodyEl);

    var actEl = null;
    if (opt.footerHTML != null && opt.footerHTML !== '') {
      /* 老的 title/body/foot 三参弹窗（workspace / fusion）直接塞 HTML 页脚，
         actions 数组是更结构化的写法；两者只走这一条渲染路径。 */
      actEl = el('div', 'modal-foot');
      actEl.innerHTML = String(opt.footerHTML);
      panel.appendChild(actEl);
    } else if (opt.actions && opt.actions.length) {
      actEl = el('div', 'modal-foot');
      opt.actions.forEach(function (a) {
        var b = el('button', 'btn' + (a.primary ? ' primary' : '') + (a.danger ? ' danger' : ''), a.text || '确定');
        b.type = 'button';
        if (a.disabled) b.disabled = true;
        if (a.id) b.dataset.act = a.id;
        b.addEventListener('click', function (e) {
          if (a.onClick) { a.onClick(function (r) { api.close(r || 'action'); }, e); }
          else api.close('action');
        });
        actEl.appendChild(b);
      });
      panel.appendChild(actEl);
    }

    backdrop.appendChild(panel);
    document.body.appendChild(backdrop);

    if (!lastFocus) lastFocus = document.activeElement;
    stack.push(backdrop);
    backdrop.style.zIndex = String(Z_BASE + stack.length * 10);
    lockScroll(true);

    function onKey(e) {
      if (e.key === 'Escape' && closable) { api.close('esc'); return; }
      if (e.key !== 'Tab') return;
      var f = focusables(panel);
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKey);

    backdrop.addEventListener('mousedown', function (e) {
      if (e.target === backdrop && closable) api.close('backdrop');
    });

    var closed = false;
    var api = {
      el: panel,
      backdropEl: backdrop,
      bodyEl: bodyEl,
      footEl: actEl,
      close: function (reason) {
        if (closed) return;
        closed = true;
        if (mo) mo.disconnect();
        document.removeEventListener('keydown', onKey);
        var i = stack.indexOf(backdrop);
        if (i >= 0) stack.splice(i, 1);
        backdrop.remove();
        lockScroll(false);
        if (stack.length === 0 && lastFocus && lastFocus.focus) {
          try { lastFocus.focus(); } catch (_) {}
          lastFocus = null;
        }
        if (opt.onClose) opt.onClose(reason);
      }
    };

    /* 老弹窗代码常这么关：this.closest('.modal-overlay').remove()。
       直接摘节点会跳过 close()，z-index 栈和 lockScroll 就泄漏了——页面再也滚不动。
       盯住节点被移除这件事，把清理补上。 */
    var mo = new MutationObserver(function () {
      if (!backdrop.isConnected) api.close('removed');
    });
    mo.observe(document.body, { childList: true });

    var auto = panel.querySelector('input,select,textarea,button.btn');
    if (auto && auto.focus) setTimeout(function () { try { auto.focus(); } catch (_) {} }, 30);
    return api;
  }

  // ───────────────────────────── adoptOverlay ─────────────────────────────
  /* 还有一批老弹窗是自己拼 DOM 的（cron 编辑器、MCP、模型、群聊房间、扩展…）。
     业务 HTML 各不相同，但行为不该各不相同：Esc 关、点遮罩关、Tab 别跑出去、
     打开锁滚动、关掉还焦点、多层时谁在上谁收键盘。
     这个函数只接管行为，不动它们的 DOM 和业务函数。关闭仍由调用方 remove()，
     我们用 MutationObserver 感知节点消失后补齐清理——直接 remove() 不再漏掉滚动锁。 */
  var adoptSeq = 0;

  function adoptOverlay(overlay, opt) {
    opt = opt || {};
    if (!overlay || overlay.__uikitAdopted) return overlay;
    overlay.__uikitAdopted = true;

    var panel = overlay.querySelector('.modal, .modal-panel, .uikit-panel') || overlay.firstElementChild || overlay;
    var lastFocus = document.activeElement;
    var closed = false;

    overlay.style.zIndex = String(6000 + (++adoptSeq));
    stack.push(overlay);
    lockScroll(true);

    function cleanup(reason) {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey, true);
      mo.disconnect();
      var i = stack.indexOf(overlay);
      if (i >= 0) stack.splice(i, 1);
      if (overlay.isConnected) overlay.remove();
      lockScroll(false);
      if (stack.length === 0 && lastFocus && lastFocus.focus) {
        try { lastFocus.focus(); } catch (_) {}
      }
      if (opt.onClose) opt.onClose(reason);
    }

    /* Esc / 点遮罩时，如果调用方有"未保存就拦一下"的关闭函数，必须先让它说话，
       不能直接摘节点——模型编辑器的草稿就是这么丢的。它放行后 remove()，
       MutationObserver 再把清理补齐。 */
    function dismiss(reason) {
      if (closed) return;
      if (opt.close && reason !== 'removed') {
        try { opt.close(); } catch (_) {}
        return;
      }
      /* 优先点它自己的关闭按钮：草稿保存、脏数据确认这些逻辑都挂在那个按钮上，
         直接摘节点会跳过它们。点完没关掉，再兜底 remove。 */
      if (reason !== 'removed') {
        var closer = overlay.querySelector('.modal-close');
        if (closer && closer.click) {
          try { closer.click(); } catch (_) {}
          if (!overlay.isConnected) return;
        }
      }
      if (overlay.isConnected) overlay.remove();
      cleanup(reason);
    }

    function onKey(e) {
      if (e.key === 'Escape' && opt.esc !== false) { e.preventDefault(); dismiss('esc'); return; }
      if (e.key !== 'Tab' || opt.trap === false) return;
      var items = Array.prototype.slice.call(panel.querySelectorAll(
        'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])'
      )).filter(function (n) { return !n.hidden && n.getClientRects().length; });
      if (!items.length) return;
      var first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }

    document.addEventListener('keydown', onKey, true);
    if (opt.backdrop !== false) {
      overlay.addEventListener('click', function (e) {
        if (e.target === overlay) dismiss('backdrop');
      });
    }

    var mo = new MutationObserver(function () { if (!overlay.isConnected) cleanup('removed'); });
    mo.observe(document.body, { childList: true });

    overlay.__uikitDismiss = dismiss;
    return overlay;
  }

  // ─────────────────────────────── confirm ───────────────────────────────
  /* confirm('确定删除？', { title, okText, cancelText, danger }) -> Promise<boolean>
   * 顺手把 keys 记下来：这版以前只能 window.confirm，样式和面板完全不搭。
   */
  function confirm(msg, opt) {
    opt = opt || {};
    return new Promise(function (resolve) {
      var done = false;
      function settle(v) { if (!done) { done = true; resolve(v); } }
      var m = modal({
        title: opt.title || '确认',
        width: opt.width || 420,
        className: 'uikit-confirm',
        body: (function () {
          var p = el('p', 'uikit-confirm-msg');
          fill(p, msg);
          return p;
        })(),
        actions: [
          { text: opt.cancelText || '取消', onClick: function (close) { settle(false); close(); } },
          { text: opt.okText || '确定', primary: !opt.danger, danger: !!opt.danger,
            onClick: function (close) { settle(true); close(); } }
        ],
        onClose: function () { settle(false); }
      });
      return m;
    });
  }

  // ─────────────────────────────── toast ───────────────────────────────
  /* toast(msg, { type:'info'|'ok'|'warn'|'error', duration=2400 })
   * 兼容老调用 toast(msg) —— 直接覆盖 window.toast。
   */
  var toastBox = null;
  var toastSeq = 0;

  function ensureToastBox() {
    if (toastBox && document.body.contains(toastBox)) return toastBox;
    toastBox = el('div', 'uikit-toasts');
    toastBox.setAttribute('role', 'status');
    toastBox.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastBox);
    return toastBox;
  }

  function toast(msg, opt) {
    /* 唯一实现在 core/utils.js（Element 风格通知栈，2026-11-13 重写）。
       这里只做转发，不再自建 .uikit-toast —— 两套长相就是用户说的「风格不统一」。
       只有组件库被单独加载（没有 utils）时才退回下面那套兜底。 */
    if (typeof window.__hzToast === 'function') return window.__hzToast(msg, opt);
    if (typeof opt === 'string') opt = { type: opt };
    opt = opt || {};
    var box = ensureToastBox();
    var id = ++toastSeq;
    var t = el('div', 'uikit-toast' + (opt.type ? ' is-' + opt.type : ''), String(msg == null ? '' : msg));
    t.dataset.id = String(id);
    box.appendChild(t);
    requestAnimationFrame(function () { t.classList.add('in'); });
    var life = opt.duration == null ? 2400 : opt.duration;
    setTimeout(function () {
      t.classList.remove('in');
      setTimeout(function () { t.remove(); }, 200);
    }, life);
    return t;
  }

  // ─────────────────────────────── field ───────────────────────────────
  /* field({ label, type='text', name, value, options, placeholder, hint,
   *         required, rows, min, max, step, disabled })
   * type: text|number|password|email|url|tel|search|textarea|select|checkbox
   * 返回 { el, get(), set(v), input }
   */
  function field(opt) {
    opt = opt || {};
    var type = opt.type || 'text';
    var wrap = el('label', 'uikit-field' + (opt.inline ? ' is-inline' : ''));
    if (opt.label) {
      var lab = el('span', 'uikit-field-label', opt.label);
      if (opt.required) lab.appendChild(el('i', 'uikit-req', '*'));
      wrap.appendChild(lab);
    }

    var input;
    if (type === 'textarea') {
      input = el('textarea', 'uikit-input');
      input.rows = opt.rows || 3;
    } else if (type === 'select') {
      input = el('select', 'uikit-input');
      (opt.options || []).forEach(function (o) {
        var v = typeof o === 'object' ? o.value : o;
        var t = typeof o === 'object' ? o.text : o;
        var op = el('option', null, t);
        op.value = v;
        input.appendChild(op);
      });
    } else if (type === 'checkbox') {
      input = el('input', 'uikit-check');
      input.type = 'checkbox';
    } else {
      input = el('input', 'uikit-input');
      input.type = type;
    }

    if (opt.name) input.name = opt.name;
    if (opt.placeholder && type !== 'checkbox' && type !== 'select') input.placeholder = opt.placeholder;
    if (opt.required) input.required = true;
    if (opt.disabled) input.disabled = true;
    if (opt.min != null) input.min = opt.min;
    if (opt.max != null) input.max = opt.max;
    if (opt.step != null) input.step = opt.step;
    if (opt.pattern) input.pattern = opt.pattern;
    if (opt.value != null) {
      if (type === 'checkbox') input.checked = !!opt.value;
      else input.value = opt.value;
    }
    if (opt.inline && type === 'checkbox') {
      wrap.appendChild(input);
      wrap.appendChild(el('span', 'uikit-field-label', opt.label || ''));
    } else {
      wrap.appendChild(input);
    }
    if (opt.hint) wrap.appendChild(el('span', 'uikit-field-hint', opt.hint));

    return {
      el: wrap,
      input: input,
      name: opt.name,
      get: function () { return type === 'checkbox' ? input.checked : input.value; },
      set: function (v) { if (type === 'checkbox') input.checked = !!v; else input.value = v; },
      focus: function () { try { input.focus(); } catch (_) {} }
    };
  }

  // ─────────────────────────────── table ───────────────────────────────
  /* table({ cols:[{key,title,width,align,render(row)}], rows:[], empty, onRowClick })
   * render 返回 string 时按 textContent 处理（默认），返回 Node 时直接插入。
   * 返回 { el, setRows(rows) }
   */
  function table(opt) {
    opt = opt || {};
    var cols = opt.cols || [];
    var wrap = el('div', 'uikit-table-wrap');
    var t = el('table', 'uikit-table' + (opt.className ? ' ' + opt.className : ''));

    var thead = el('thead');
    var trh = el('tr');
    cols.forEach(function (c) {
      var th = el('th', null, c.title == null ? '' : c.title);
      if (c.width) th.style.width = typeof c.width === 'number' ? c.width + 'px' : c.width;
      if (c.align) th.style.textAlign = c.align;
      trh.appendChild(th);
    });
    thead.appendChild(trh);
    t.appendChild(thead);

    var tbody = el('tbody');
    t.appendChild(tbody);
    wrap.appendChild(t);

    var emptyEl = null;
    function render(rows) {
      tbody.textContent = '';
      rows = rows || [];
      if (!rows.length) {
        if (!emptyEl) {
          emptyEl = el('div', 'uikit-table-empty', opt.empty || '暂无数据');
          wrap.appendChild(emptyEl);
        }
        emptyEl.style.display = '';
        t.style.display = 'none';
        return;
      }
      if (emptyEl) emptyEl.style.display = 'none';
      t.style.display = '';
      rows.forEach(function (row, i) {
        var tr = el('tr');
        cols.forEach(function (c) {
          var td = el('td');
          if (c.align) td.style.textAlign = c.align;
          var v = c.render ? c.render(row, i) : row[c.key];
          if (v && v.nodeType === 1) td.appendChild(v);
          else td.textContent = v == null ? '' : String(v);
          tr.appendChild(td);
        });
        if (opt.onRowClick) {
          tr.classList.add('is-clickable');
          tr.addEventListener('click', function () { opt.onRowClick(row, i); });
        }
        tbody.appendChild(tr);
      });
    }
    render(opt.rows);
    return { el: wrap, setRows: render };
  }

  window.ui = {
    version: '1.0.0',
    modal: modal,
    adoptOverlay: adoptOverlay,
    confirm: confirm,
    toast: toast,
    field: field,
    table: table
  };

  // 老代码里大量直接调 toast(...)：接到新实现上，视觉统一，签名兼容
  /* utils 已经装了唯一实现（window.__hzToast）时不要覆盖 window.toast：
     一覆盖 toast.config / toast.closeAll 就丢了，调用还得多绕一层转发。 */
  if (typeof window.__hzToast === 'function') {
    /* 什么都不做 */
  } else if (typeof window.toast !== 'function') window.toast = toast;
  else {
    window.__legacyToast = window.toast;
    window.toast = toast;
  }
})();
