/* 基础工具（toast、esc、DOM 小工具）
 * 来源：index.html 内联 app.js 第 96-117 行（共 22 行）
 * 2026-11-13 按原分区纯搬运外移，逻辑零改动。全局作用域与执行顺序与原内联块一致。 */

/* ============================ 基础工具 ============================ */
function $(s){ return document.querySelector(s); }
function $$(s){ return document.querySelectorAll(s); }
function esc(s){ return DOM.esc(s); }   /* 唯一实现在 core/dom.js */
function uid(){ return 'u'+Date.now().toString(36)+Math.random().toString(36).slice(2,6); }
function escapeHtml(s){ return DOM.escAttr(s); }   /* 唯一实现在 core/dom.js */

/* ============================ 通知（唯一实现） ============================
 * 2026-11-14 第二轮重写（用户：把「直塞 DOM 的提醒」统一成档案页那种左下角通知）。
 *
 * 之前面板里同时存在四套提醒，长相、位置、关闭方式各不相同：
 *   ① panel-runtime-ui.js 自己 createElement 一个 <section class="panel-runtime-bar">，
 *      底部居中固定条 + ResizeObserver 往文档根写 --runtime-banner-space 占位，正文流会让位；
 *   ② panels/models.js 造 #modelConfigBanner 插进聊天页 DOM（未配置模型时的黄色警告）；
 *   ③ 档案页自带一套 .arc-toast（右下角、2.6s）；
 *   ④ 本文件这套 Element 风格 toast（右上角）。
 * 现在全部收口到本函数，位置默认左下角，能力补齐：
 *   按位置分容器 · 纵向堆叠 · 类型图标+左侧色条 · 标题+正文 · 动作按钮 · 可关闭
 *   去重键（同 key 原位更新，不重放动画、不刷屏）· duration=0 常驻 · 悬停暂停 · 最多 4 条。
 *
 *   toast('已保存')                                        // info，3s 自动消失
 *   toast('保存失败', 'error')                              // 老签名兼容（第二个参数是类型）
 *   toast({message:'...', type:'warning', duration:0})      // 常驻，需自己关
 *   toast({key:'runtime', title:'1 项配置待重启', message:'涉及：模型与供应商',
 *          type:'warning', duration:0,
 *          actions:[{label:'重启应用并生效', primary:true, onClick:fn},
 *                   {label:'稍后', onClick:'close'}]})
 *   toast.dismiss('runtime')                                // 按 key 关
 *   toast.closeAll()
 * 位置：bottom-right（默认，用户 2026-11-14 定）/ bottom-left / top-right / top-center / top-left / bottom-center
 */
(function(){
  var CFG = { position:'bottom-right', duration:3000, max:4 };
  var POS = {
    /* 左下角：left 让开 164px 的左侧导航栏（实测 1440 宽时 rail=164），
       bottom 抬高到 130px —— 聊天页的输入框贴着底边（1440x900 实测 y≈801），
       压在输入框上会挡点击。手机端由 CSS 覆盖成整行贴底。 */
    'bottom-left':  'bottom:130px;left:180px;align-items:flex-start;',
    /* 右下角（默认）：right 让开 24px 滚动条边距；bottom 同样抬到 130px，
       聊天页输入框贴底（1440x900 实测 y≈801），压上去会挡发送按钮。
       手机端由 CSS 覆盖成整行贴底。 */
    'bottom-right': 'bottom:118px;right:24px;align-items:flex-end;',
    'bottom-center':'bottom:16px;left:50%;transform:translateX(-50%);align-items:center;',
    'top-right':    'top:16px;right:16px;align-items:flex-end;',
    'top-center':   'top:16px;left:50%;transform:translateX(-50%);align-items:center;',
    'top-left':     'top:16px;left:88px;align-items:flex-start;'
  };
  var SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">';
  var ICON = {
    success: SVG + '<circle cx="12" cy="12" r="9"/><path d="M8 12.4l2.7 2.7L16.2 9.6"/></svg>',
    warning: SVG + '<circle cx="12" cy="12" r="9"/><path d="M12 7.8v5"/><path d="M12 16.2v.2"/></svg>',
    /* 错误态原来是"圆圈里一个叉"——卡片右上角还有个关闭叉，两个叉并排，用户直接问"看不懂"。
       类型图标不许长得像关闭控件：改成八边形 + 感叹号，全卡只留右上角一个叉。 */
    error:   SVG + '<path d="M8.6 3h6.8L21 8.6v6.8L15.4 21H8.6L3 15.4V8.6z"/><path d="M12 8v5.2"/><path d="M12 16.4v.2"/></svg>',
    info:    SVG + '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.2"/><path d="M12 7.8v.2"/></svg>'
  };
  /* 老代码里 type 用得五花八门，统一收口到这四类 */
  var ALIAS = { ok:'success', done:'success', success:'success', warn:'warning', warning:'warning',
    danger:'error', err:'error', error:'error', failed:'error', fail:'error', tip:'info', info:'info', notice:'info', loading:'info' };
  var boxes = {};   /* pos -> 容器 */
  var live  = {};   /* key -> handle（去重键） */

  /* 左下/左上的左边界要跟着「内容区」走：聊天页左边是图标栏 + 会话列表两列，
     写死一个 left 不是压会话列表就是飘在图标栏上。实测 1440 宽：图标栏 0-164、
     会话列表 164-423、聊天区 424-1440。取最右那列的右缘 +16 才不会压人。 */
  function leftAnchor(){
    var edge = 12;
    ['.global-sidebar','#railScroll','.session-rail'].forEach(function(sel){
      var el = document.querySelector(sel);
      if(!el) return;
      var r = el.getBoundingClientRect();
      if(r.width > 0 && r.right > edge) edge = r.right;
    });
    return Math.max(12, Math.min(Math.round(edge + 16), Math.round(window.innerWidth * 0.5)));
  }
  /* 右下/右上的右边界同理：聊天列有内边距，输入框右缘实测 1347（1440 视口），
     贴着视口右边 (1416) 会跟输入框差 69px，看着像"没靠到边"。取输入框/消息列的右缘对齐。 */
  function rightAnchor(){
    /* 取"最内层"的内容右缘：候选里挑最小的那个仍在中线右侧的 right。
       取最大会命中 .workspace（右缘=1440），算出来 right:0，卡片贴死视口边。 */
    var mid = window.innerWidth * 0.55, edge = 0;
    ['#chatInput','.composer','.msg-list','.workspace'].forEach(function(sel){
      var el = document.querySelector(sel);
      if(!el) return;
      var r = el.getBoundingClientRect();
      if(r.width > 0 && r.right > mid && (edge === 0 || r.right < edge)) edge = r.right;
    });
    if(!edge) edge = window.innerWidth - 16;
    return Math.max(12, Math.min(Math.round(window.innerWidth - edge), Math.round(window.innerWidth * 0.5)));
  }
  function place(b, pos){
    b.style.cssText = POS[pos];
    if(pos === 'bottom-left' || pos === 'top-left') b.style.left = leftAnchor() + 'px';
    if(pos === 'bottom-right' || pos === 'top-right') b.style.right = rightAnchor() + 'px';
  }
  function box(pos){
    if(!POS[pos]) pos = CFG.position;
    if(boxes[pos] && document.body.contains(boxes[pos])) return boxes[pos];
    var b = document.createElement('div');
    b.className = 'hz-toast-stack';
    b.dataset.pos = pos;
    place(b, pos);
    b.setAttribute('role','status');
    b.setAttribute('aria-live','polite');
    document.body.appendChild(b);
    boxes[pos] = b;
    return b;
  }
  /* 超限淘汰：常驻条（duration=0 / sticky）不该被瞬时提示挤掉，先淘汰最老的瞬时条。
     注意必须同步摘除节点：close() 是 220ms 后再移除（为了播退场动画），
     如果这里调 close() 等它自己走，children.length 不会变小 → while 死循环把渲染线程锁死
     （2026-11-14 实测：连打 6 条 toast 直接把面板卡死）。 */
  function trim(b){
    var max = CFG.max > 0 ? CFG.max : 4, guard = 0;
    while(b.children.length > max && guard++ < 40){
      var victim = null;
      for(var i=0;i<b.children.length;i++){ if(b.children[i].dataset.sticky!=='1'){ victim = b.children[i]; break; } }
      if(!victim) victim = b.firstElementChild;
      if(!victim) break;
      if(victim._hzKill) victim._hzKill(); else b.removeChild(victim);
    }
  }
  function paintActions(host, actions, close){
    host.innerHTML = '';
    if(!actions || !actions.length) return;
    actions.forEach(function(a){
      if(!a || !a.label) return;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'hz-toast__btn' + (a.primary ? ' is-primary' : '');
      btn.textContent = a.label;
      if(a.disabled) btn.disabled = true;
      btn.addEventListener('click', function(){
        if(a.onClick === 'close'){ close(); return; }
        if(typeof a.onClick === 'function'){
          var keep = a.onClick(btn);
          if(!keep && a.keepOpen !== true) close();
        } else close();
      });
      host.appendChild(btn);
    });
  }
  function hzToast(msg, opt){
    if(msg && typeof msg === 'object' && !(msg instanceof Node)){ opt = msg; msg = opt.message; }
    if(typeof opt === 'string') opt = { type: opt };
    opt = opt || {};
    var type = ALIAS[String(opt.type||'').toLowerCase()] || 'info';
    var text = String(msg == null ? '' : msg);
    var title = opt.title ? String(opt.title) : '';
    var key = opt.key ? String(opt.key) : '';
    if(!text && !title) return null;

    /* ── 去重键：同 key 已存在就原位改，不新建、不重放进场动画 ── */
    if(key && live[key] && live[key].item && document.body.contains(live[key].item)){
      live[key].update({ type:type, title:title, message:text, actions:opt.actions, duration:opt.duration, dismissible:opt.closable });
      return live[key];
    }

    var b = box(opt.position || CFG.position);
    var item = document.createElement('div');
    item.className = 'hz-toast is-' + type;
    if(key) item.dataset.key = key;
    item.innerHTML =
      '<span class="hz-toast__ico">' + ICON[type] + '</span>' +
      '<div class="hz-toast__body">' +
        '<p class="hz-toast__title" hidden></p>' +
        '<p class="hz-toast__text"></p>' +
        '<div class="hz-toast__acts" hidden></div>' +
      '</div>' +
      (opt.closable === false ? '' : '<button class="hz-toast__x" type="button" aria-label="关闭">&#215;</button>');
    var titleEl = item.querySelector('.hz-toast__title');
    var textEl  = item.querySelector('.hz-toast__text');
    var actsEl  = item.querySelector('.hz-toast__acts');
    if(title){ titleEl.textContent = title; titleEl.hidden = false; }
    textEl.textContent = text;
    /* 先标 sticky 再入栈：否则刚建好的常驻条可能在 trim 时把自己淘汰掉 */
    if((opt.duration != null ? opt.duration : CFG.duration) === 0) item.dataset.sticky = '1';
    b.appendChild(item);
    trim(b);
    requestAnimationFrame(function(){ item.classList.add('in'); });

    var closed = false, timer = null;
    function close(){
      if(closed) return; closed = true;
      clearTimeout(timer);
      item.classList.remove('in'); item.classList.add('out');
      setTimeout(function(){ if(item.parentNode) item.parentNode.removeChild(item); }, 220);
      if(key && live[key] === handle) delete live[key];
    }
    function arm(life){
      clearTimeout(timer);
      if(life == null) life = opt.duration != null ? opt.duration : CFG.duration;
      life = Math.max(0, +life || 0);
      item.dataset.sticky = life ? '0' : '1';
      if(life) timer = setTimeout(close, life);
    }
    function update(patch){
      patch = patch || {};
      if(patch.type){
        var t2 = ALIAS[String(patch.type).toLowerCase()] || 'info';
        item.className = 'hz-toast is-' + t2 + (item.classList.contains('in') ? ' in' : '');
        item.querySelector('.hz-toast__ico').innerHTML = ICON[t2];
      }
      if(patch.title != null){ titleEl.textContent = patch.title; titleEl.hidden = !patch.title; }
      if(patch.message != null) textEl.textContent = patch.message;
      if(patch.actions !== undefined){
        paintActions(actsEl, patch.actions, close);
        actsEl.hidden = !actsEl.children.length;
      }
      if(patch.dismissible != null){ item.classList.toggle('no-x', patch.dismissible === false); }
      if(patch.duration !== undefined){ opt.duration = patch.duration; }
      arm(patch.duration);
    }
    var handle = function(){ close(); };
    handle.close = close;
    handle.update = update;
    handle.item = item;
    item._hzClose = close;
    /* 同步摘除（不带退场动画）：给 trim 用，别让它等 220ms */
    item._hzKill = function(){
      closed = true; clearTimeout(timer);
      if(item.parentNode) item.parentNode.removeChild(item);
      if(key && live[key] === handle) delete live[key];
    };

    paintActions(actsEl, opt.actions, close);
    actsEl.hidden = !actsEl.children.length;
    arm();
    /* 悬停暂停：鼠标停在上面说明正在读，不能一边读一边消失；移开重新计时 */
    item.addEventListener('mouseenter', function(){ clearTimeout(timer); });
    item.addEventListener('mouseleave', function(){ if(!closed) arm(); });
    var x = item.querySelector('.hz-toast__x');
    if(x) x.addEventListener('click', close);
    if(key) live[key] = handle;
    return handle;
  }
  hzToast.config = function(o){
    if(!o) return { position:CFG.position, duration:CFG.duration, max:CFG.max };
    if(o.position && POS[o.position]) CFG.position = o.position;
    if(o.duration != null) CFG.duration = Math.max(0, +o.duration || 0);
    if(o.max != null) CFG.max = Math.max(1, +o.max || 4);
    return { position:CFG.position, duration:CFG.duration, max:CFG.max };
  };
  /* 按 key 关：常驻状态消解时用（例如重启完成后待生效配置清零） */
  hzToast.dismiss = function(key){ if(key && live[key]){ live[key].close(); return true; } return false; };
  /* 幂等：key 存在就不做事，避免轮询反复重绘 */
  hzToast.has = function(key){ return !!(key && live[key] && live[key].item && document.body.contains(live[key].item)); };
  hzToast.closeAll = function(){
    Object.keys(boxes).forEach(function(k){
      var b = boxes[k]; if(!b || !b.parentNode) return;
      Array.prototype.slice.call(b.children).forEach(function(c){ if(c._hzClose) c._hzClose(); else c.remove(); });
    });
    live = {};
  };
  /* 窗口变化 / 切页面后左边界会变，横竖屏切换也别让通知骑在侧栏上 */
  window.addEventListener('resize', function(){
    Object.keys(boxes).forEach(function(k){ if(boxes[k] && boxes[k].parentNode) place(boxes[k], k); });
  });
  window.__hzToast = hzToast;
  window.toast = hzToast;
})();

