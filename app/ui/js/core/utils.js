/* 基础工具（toast、esc、DOM 小工具）
 * 来源：index.html 内联 app.js 第 96-117 行（共 22 行）
 * 2026-11-13 按原分区纯搬运外移，逻辑零改动。全局作用域与执行顺序与原内联块一致。 */

/* ============================ 基础工具 ============================ */
function $(s){ return document.querySelector(s); }
function $$(s){ return document.querySelectorAll(s); }
function esc(s){ return DOM.esc(s); }   /* 唯一实现在 core/dom.js */
function uid(){ return 'u'+Date.now().toString(36)+Math.random().toString(36).slice(2,6); }
function escapeHtml(s){ return DOM.escAttr(s); }   /* 唯一实现在 core/dom.js */

/* ============================ 提示条 ============================
 * 2026-11-13（用户第 41 条）重写。旧实现是一个 #__toast 单例：位置写死底部居中、
 * 没有关闭按钮、不能堆叠、样式内联手搓；同时 ui-kit 里还有一套 .uikit-toast 栈，
 * 两套长相不同 —— 用户说的「每个都像手搓的、风格不统一、触发条件不清楚」就是这两套。
 * 现在唯一实现 = 本函数，形状按 Element Plus 的通知：
 *   按位置分容器 · 纵向堆叠 · 类型图标+左侧色 · 可关闭 · 默认 3s 自动消失 · 悬停暂停 · 最多 4 条。
 *
 *   toast('已保存')                                       // info
 *   toast('保存失败', 'error')                             // 老签名兼容
 *   toast({message:'...', type:'warning', duration:0})     // duration=0 不自动消失
 *   toast.config({position:'top-right', duration:3000, max:4})
 *   toast.closeAll()
 * 位置：top-right（默认）/ top-center / top-left / bottom-right / bottom-center / bottom-left
 */
(function(){
  var CFG = { position:'top-right', duration:3000, max:4 };
  var POS = {
    'top-right':    'top:16px;right:16px;align-items:flex-end;',
    'top-center':   'top:16px;left:50%;transform:translateX(-50%);align-items:center;',
    'top-left':     'top:16px;left:16px;align-items:flex-start;',
    'bottom-right': 'bottom:16px;right:16px;align-items:flex-end;',
    'bottom-center':'bottom:16px;left:50%;transform:translateX(-50%);align-items:center;',
    'bottom-left':  'bottom:16px;left:16px;align-items:flex-start;'
  };
  var SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">';
  var ICON = {
    success: SVG + '<circle cx="12" cy="12" r="9"/><path d="M8 12.4l2.7 2.7L16.2 9.6"/></svg>',
    warning: SVG + '<circle cx="12" cy="12" r="9"/><path d="M12 7.8v5"/><path d="M12 16.2v.2"/></svg>',
    error:   SVG + '<circle cx="12" cy="12" r="9"/><path d="M9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6"/></svg>',
    info:    SVG + '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.2"/><path d="M12 7.8v.2"/></svg>'
  };
  /* 老代码里 type 用得五花八门，统一收口到这四类 */
  var ALIAS = { ok:'success', done:'success', success:'success', warn:'warning', warning:'warning',
    danger:'error', err:'error', error:'error', failed:'error', fail:'error', tip:'info', info:'info', notice:'info' };
  var boxes = {};
  function box(pos){
    if(!POS[pos]) pos = CFG.position;
    if(boxes[pos] && document.body.contains(boxes[pos])) return boxes[pos];
    var b = document.createElement('div');
    b.className = 'hz-toast-stack';
    b.dataset.pos = pos;
    b.style.cssText = POS[pos];
    b.setAttribute('role','status');
    b.setAttribute('aria-live','polite');
    document.body.appendChild(b);
    boxes[pos] = b;
    return b;
  }
  function trim(b){
    var max = CFG.max > 0 ? CFG.max : 4;
    while(b.children.length > max) b.removeChild(b.firstElementChild);
  }
  function hzToast(msg, opt){
    if(msg && typeof msg === 'object' && !(msg instanceof Node)){ opt = msg; msg = opt.message; }
    if(typeof opt === 'string') opt = { type: opt };
    opt = opt || {};
    var type = ALIAS[String(opt.type||'').toLowerCase()] || 'info';
    var text = String(msg == null ? '' : msg);
    if(!text) return null;
    var b = box(opt.position || CFG.position);
    var item = document.createElement('div');
    item.className = 'hz-toast is-' + type;
    item.innerHTML = '<span class="hz-toast__ico">' + ICON[type] + '</span>' +
      '<div class="hz-toast__body"><p class="hz-toast__text"></p></div>' +
      (opt.closable === false ? '' : '<button class="hz-toast__x" type="button" aria-label="关闭">&#215;</button>');
    item.querySelector('.hz-toast__text').textContent = text;
    b.appendChild(item);
    trim(b);
    requestAnimationFrame(function(){ item.classList.add('in'); });
    /* duration=0 → 不自动消失，必须自己关。默认值走 CFG（3s）。 */
    var life = opt.duration == null ? CFG.duration : opt.duration;
    var timer = null, closed = false;
    function close(){
      if(closed) return; closed = true; clearTimeout(timer);
      item.classList.remove('in'); item.classList.add('out');
      setTimeout(function(){ if(item.parentNode) item.parentNode.removeChild(item); }, 220);
    }
    function arm(){ if(!life) return; clearTimeout(timer); timer = setTimeout(close, life); }
    arm();
    /* 悬停暂停：鼠标停在上面说明正在读，不能一边读一边消失 */
    item.addEventListener('mouseenter', function(){ clearTimeout(timer); });
    item.addEventListener('mouseleave', arm);
    var x = item.querySelector('.hz-toast__x');
    if(x) x.addEventListener('click', close);
    return close;
  }
  hzToast.config = function(o){
    if(!o) return { position:CFG.position, duration:CFG.duration, max:CFG.max };
    if(o.position && POS[o.position]) CFG.position = o.position;
    if(o.duration != null) CFG.duration = Math.max(0, +o.duration || 0);
    if(o.max != null) CFG.max = Math.max(1, +o.max || 4);
    return { position:CFG.position, duration:CFG.duration, max:CFG.max };
  };
  hzToast.closeAll = function(){
    Object.keys(boxes).forEach(function(k){ var b = boxes[k]; if(b && b.parentNode) b.innerHTML = ''; });
  };
  window.__hzToast = hzToast;
  window.toast = hzToast;
})();
