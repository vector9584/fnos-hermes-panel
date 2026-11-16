/* 新建会话弹窗
 * 来源：index.html 内联 app.js 第 3559-3906 行（共 348 行）
 * 2026-11-13 按原分区纯搬运外移，逻辑零改动。全局作用域与执行顺序与原内联块一致。 */

/* ============================ 新建会话弹窗 ============================ */
function openNewSessionModal(){
  // 获取 profiles 和 models 列表
  var html='<div class="modal-overlay new-session-modal" id="newSessionOverlay" onclick="if(event.target===this)closeNewSessionModal()">' +
    '<div class="modal" style="max-width:440px">' +
    '<div class="modal-head"><h3>新建会话</h3><button class="modal-close" aria-label="关闭" title="关闭" onclick="closeNewSessionModal()">\u00d7</button></div>' +
    '<div class="modal-body">' +
    '<div class="field"><label for="nsTitle">会话名称</label><input type="text" id="nsTitle" placeholder="留空自动命名，之后双击标题也能改"></div>' +
    '<div class="field"><label for="nsFolder">归类</label><select id="nsFolder">' + (window.pwFolderOptions ? window.pwFolderOptions('') : '<option value="">未分类</option>') + '</select></div>' +
    '<div class="field"><label for="nsSessionType">会话类型</label><select id="nsSessionType" onchange="_ndRenderModels()"><option value="chat">对话</option><option value="canvas">画板</option></select><div id="nsTypeHint" style="font-size:11px;color:var(--text3);margin-top:4px">对话：普通聊天，可选任意对话模型。</div></div>' +
    '<div class="field"><label>模型</label><select id="nsModel"><option value="">默认模型</option></select></div>' +
    '<div class="field"><label>工作区文件夹</label><div style="display:flex;gap:6px"><input type="text" id="nsWorkspace" placeholder="留空使用默认工作区（可浏览选择或输入新名称）" value="" style="flex:1"><button class="ov-actbtn" onclick="openWsPicker()" title="浏览选择工作区文件夹">📂 浏览</button></div></div>' +
    '<div style="font-size:11.5px;color:var(--text3);line-height:1.5;margin-top:2px">留空直接点「创建」= 对话类型 + 默认模型 + 默认工作区。</div>' +
    '</div>' +
    '<div class="modal-foot" style="padding:12px 16px;display:flex;justify-content:flex-end;gap:8px">' +
    '<button class="ov-actbtn" onclick="closeNewSessionModal()">取消</button>' +
    '<button class="ov-actbtn primary" onclick="createNewSession()">创建</button>' +
    '</div></div></div>';
  document.body.insertAdjacentHTML('beforeend', html);
  var _ndOv=document.getElementById('newSessionOverlay');
  if(_ndOv&&window.ui)window.ui.adoptOverlay(_ndOv);
  /* 会话类型与模型联动（2026-11-16）：
   * - 对话：列全部对话模型，排除生图专用模型（避免拿画图模型聊天）
   * - 画板：只列 image_gen 配置里真实可用的生图模型
   * 生图模型名不写死 —— 唯一真源是 config.yaml 的 image_gen 段，
   * 后端 /api/workspace-ui/image-targets 已解析好（实测 gpt-image-2 并不在
   * provider 的 models 列表里，从 models 反推会漏）。 */
  Promise.all([
    apiGet('/api/config').catch(function(){ return null; }),
    apiGet('/api/workspace-ui/image-targets').catch(function(){ return null; })
  ]).then(function(r){
    _ndData.config = r[0]; _ndData.targets = r[1];
    _ndRenderModels();
  });
}
/* 新建面板的数据缓存：模型列表与生图目标只取一次，切换类型时本地重算。 */
var _ndData = { config: null, targets: null };
function _ndImageTargets(){
  return (_ndData.targets && Array.isArray(_ndData.targets.targets)) ? _ndData.targets.targets : [];
}
function _ndRenderModels(){
  var sel = document.getElementById('nsModel');
  if(!sel) return;
  var typeEl = document.getElementById('nsSessionType');
  var hintEl = document.getElementById('nsTypeHint');
  var type = (typeEl && typeEl.value) || 'chat';
  var isCanvas = (type === 'canvas');
  var targets = _ndImageTargets();
  if(hintEl){
    hintEl.textContent = isCanvas
      ? '画板：无限画布，模型限定为可生图的模型；每张图连到它的来源图上。'
      : '对话：普通聊天，可选任意对话模型。';
  }
  var html = '';
  if(isCanvas){
    if(!targets.length){
      html = '<option value="">未配置生图模型</option>';
    }else{
      html += '<optgroup label="可生图模型">';
      targets.forEach(function(t){
        html += '<option value="'+DOM.escAttr(t.model)+'" data-provider="'+DOM.escAttr(t.provider_id||'')+'">'+esc(t.label||t.model)+'</option>';
      });
      html += '</optgroup>';
    }
    sel.innerHTML = html;
    return;
  }
  html = '<option value="">默认模型</option>';
  var cfg = _ndData.config;
  if(cfg && Array.isArray(cfg.providers)){
    cfg.providers.forEach(function(p){
      var provName = p.name || p.id;
      var models = (p.models && p.models.length) ? p.models : [{ id:p.model||'auto', name:p.model||'auto', enabled:true }];
      var opts = '';
      models.forEach(function(m){
        if(m.enabled === false) return;
        var modelId = m.id || m.name || 'auto';
        var modelName = m.name || m.id || 'auto';
        // 生图专用模型不进对话列表：它的接口不是 chat/completions 口径
        if(targets.some(function(t){ return t.model === modelId; })) return;
        opts += '<option value="'+DOM.escAttr(modelId)+'">'+esc(modelName)+'</option>';
      });
      if(opts) html += '<optgroup label="'+DOM.escAttr(provName)+'">'+opts+'</optgroup>';
    });
  }
  sel.innerHTML = html;
}
/* ── 工作区目录选择器（浏览/新建，选择后回填工作区字段） ── */
var _wsPicker = { cwd: 'workspace' };  // 相对 DATA_DIR 的当前目录（workspace = 工作区根）
function openWsPicker(){
  _wsPicker.cwd = 'workspace';
  if(document.getElementById('wsPickerOverlay')) return;
  var html = '<div class="modal-overlay" id="wsPickerOverlay" onclick="if(event.target===this)closeWsPicker()">' +
    '<div class="modal" style="max-width:460px">' +
    '<div class="modal-head"><h3>📂 选择工作区文件夹</h3><button class="modal-close" aria-label="关闭" title="关闭" onclick="closeWsPicker()">\u00d7</button></div>' +
    '<div class="modal-body" style="padding:12px 14px">' +
    '<div style="display:flex;gap:6px;align-items:center;margin-bottom:8px">' +
    '<button class="ov-actbtn" onclick="wsPickerUp()" title="上级目录">⬆</button>' +
    '<button class="ov-actbtn" onclick="wsPickerRefresh()" title="刷新">\u21bb</button>' +
    '<button class="ov-actbtn" onclick="wsPickerNewDir()" title="在当前目录新建子文件夹">+目录</button>' +
    '<span id="wsPickerPath" style="font-size:12px;color:var(--text2);flex:1;text-align:right;word-break:break-all"></span>' +
    '</div>' +
    '<div id="wsPickerList" style="max-height:320px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;padding:6px"></div>' +
    '</div>' +
    '<div class="modal-foot" style="padding:10px 14px;display:flex;justify-content:flex-end;gap:8px">' +
    '<button class="btn" onclick="closeWsPicker()">取消</button>' +
    '<button class="btn primary" onclick="wsPickerSelect()">选择当前目录</button>' +
    '</div></div></div>';
  document.body.insertAdjacentHTML('beforeend', html);
  var _ndOv=document.getElementById('wsPickerOverlay');
  if(_ndOv&&window.ui)window.ui.adoptOverlay(_ndOv);
  wsPickerRefresh();
}
function wsPickerRefresh(){
  apiGet('/api/files?path='+encodeURIComponent(_wsPicker.cwd)).then(function(res){
    var pathEl=document.getElementById('wsPickerPath');
    var listEl=document.getElementById('wsPickerList');
    if(!res || !res.ok){ if(listEl) listEl.innerHTML='<div class="empty-state">加载失败</div>'; return; }
    var rel = _wsPicker.cwd.replace(/^workspace\/?/,'') || '（工作区根目录）';
    if(pathEl) pathEl.textContent = rel;
    if(!listEl) return;
    var dirs = (res.items||[]).filter(function(i){ return i.type==='dir'; });
    if(!dirs.length){ listEl.innerHTML='<div class="empty-state">暂无子目录（可点「+目录」新建）</div>'; return; }
    listEl.innerHTML = dirs.map(function(d){
      return '<div class="ws-file-item" onclick="wsPickerOpen(\''+esc(d.name).replace(/'/g,"\\'")+'\')" style="cursor:pointer">' +
        '<span class="ws-file-icon">📁</span><span class="ws-file-name">'+esc(d.name)+'</span></div>';
    }).join('');
  });
}
function wsPickerOpen(name){ _wsPicker.cwd = _wsPicker.cwd.replace(/\/$/,'') + '/' + name; wsPickerRefresh(); }
function wsPickerUp(){
  var c = _wsPicker.cwd.replace(/\/$/,'');
  if(c === 'workspace') return;
  _wsPicker.cwd = c.substring(0, c.lastIndexOf('/')) || 'workspace';
  wsPickerRefresh();
}
function wsPickerNewDir(){
  var name=prompt('新建目录名：');
  if(!name || !name.trim()) return;
  fetch(apiUrl('/api/files/mkdir'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path: _wsPicker.cwd.replace(/\/$/,'') + '/' + name.trim()})})
    .then(function(r){return r.json();}).then(function(res){ if(res.ok){ toast('✅ 目录已创建'); wsPickerRefresh(); } else toast(res.error||'创建失败','error'); });
}
function wsPickerSelect(){
  var rel = _wsPicker.cwd.replace(/^workspace\/?/,'') || '';
  var inp=document.getElementById('nsWorkspace');
  if(inp){ inp.value = rel; }
  closeWsPicker();
  toast(rel ? ('已选择工作区：'+rel) : '已选择默认工作区（根目录）');
}
function closeWsPicker(){ var o=document.getElementById('wsPickerOverlay'); if(o) o.remove(); }
function closeNewSessionModal(){ var o=document.getElementById('newSessionOverlay'); if(o) o.remove(); }
function createNewSession(){
  var sessionType=(document.getElementById('nsSessionType')||{}).value||'chat';
  var model=document.getElementById('nsModel').value;
  var workspace=document.getElementById('nsWorkspace').value.trim();
  var wantTitle=((document.getElementById('nsTitle')||{}).value||'').trim();
  var wantFolder=(document.getElementById('nsFolder')||{}).value||'';
  closeNewSessionModal();
  fetch(apiUrl('/api/sessions'), { method:'POST', headers:monitorToken?{'X-Monitor-Token':monitorToken}:{}, body:JSON.stringify({model:model,workspace:workspace}) })
    .then(function(r){return r.json();})
    .then(function(s){
      /* 名称与归类原本只在 pwCreateChat 那个弹窗里能设，两个入口并成一个后必须一起搬过来，
         否则从侧栏进来的用户想命名就没地方填。两件事都不该挡住创建本身，失败只提示。 */
      var chain = Promise.resolve(s);
      if(wantTitle){
        chain = chain.then(function(x){
          return fetch(apiUrl('/api/sessions/rename'), {method:'POST', headers:Object.assign({'Content-Type':'application/json'}, monitorToken?{'X-Monitor-Token':monitorToken}:{}), body:JSON.stringify({id:x.id,title:wantTitle})})
            .then(function(r){return r.json();})
            .then(function(j){ if(j && j.title) x.title=j.title; else x.title=wantTitle; return x; })
            .catch(function(){ x.title=wantTitle; return x; });
        });
      }
      if(wantFolder){ chain = chain.then(function(x){ return request('/session','PUT',{id:x.id,folder_id:wantFolder}).then(function(){return x;}).catch(function(){return x;}); }); }
      chain = chain.then(function(x){
        return api('/api/workspace-ui/session','PUT',{id:x.id,type:sessionType}).then(function(){ return x; }).catch(function(e){
          toast('会话已创建，但会话类型保存失败：'+e.message,'error');
          return x;
        });
      });
      /* 工作区隔离（2026-11-16）：新会话按归类在 data/sessions/<归类>/<会话ID>/uploads
       * 单独建目录，附件与生图产物各归各家；表情包等公共资源仍走 assets，不受影响。
       * 失败不挡创建 —— 目录只是存放位置，没有它也能聊天。 */
      chain = chain.then(function(x){
        return api('/api/workspace-ui/session-dir','POST',{id:x.id}).then(function(r){ x._dir=r||null; return x; }).catch(function(){ return x; });
      });
      return chain;
    })
    .then(function(s){
      _sessions.unshift(s);
      currentSession=s.id;
      _applyPendingModel(s.id);
      _openTabs.push(s.id); persistTabs();
      saveDraft(currentSession);   // 新建前保存当前会话草稿
      var ta=document.getElementById('chatInput'); if(ta) ta.value='';
      renderSessionTabs(); renderRail(); updateHeader();
      var body=document.getElementById('chatBody');
      if(body) body.innerHTML='<div class="system-tip">新会话已创建'+(sessionType==='canvas'?' · 画板':'')+(model?' · 模型: '+esc(model):'')+'</div>';
      if(workspace) _fmCwd=workspace;
      /* 画板会话（2026-11-16）：先把 workspace state 刷一遍再进画板，
         这样后续 switchTab 走 window.pwSessionType 就能查到 canvas。
         pwReload 是 panel-workspace-ui IIFE 暴露的入口（reload 本身是私有的）。 */
      if(sessionType==='canvas'){
        var goCanvas=function(){ if(window.CanvasMode){ try{ CanvasMode.enter(s.id); }catch(e){} } };
        if(typeof window.pwReload==='function'){ Promise.resolve(window.pwReload()).then(goCanvas).catch(goCanvas); } else { goCanvas(); }
      }
      toast('✅ 新会话已创建');
    }).catch(function(){ toast('创建会话失败','error'); });
}
function updateHeader(){
  var s = _sessions.find(function(x){ return x.id===currentSession; });
  var title = document.getElementById('chatTitle');
  var sub = document.getElementById('chatSubtitle');
  if(title) title.textContent = s ? (s.title||'未命名会话') : '新对话';
  // 副标题只写「这个会话自己」的量：条数 + 上下文占用（和自动压缩同一个口径）
  _updateHeaderMetric(s);
  renderSessionTabs();
}
/* ── 副标题：当前会话自己的量（消息条数 + 上下文占用%）
 * 「上下文%」与自动压缩同一个口径（usage.pct = 估算 token / 上下文窗口），
 * 所以副标题上的百分比涨到压缩阈值附近，就是下一次压缩要触发的时候。 */
var _hdrMetricCache = {};
/* 归档批数缓存：只在会话切换/压缩后重取，别每轮 updateHeader 都打一次网络 */
var _hdrArchiveCache = {};
function _updateHeaderMetric(s){
  var sub = document.getElementById('chatSubtitle');
  if(!sub) return;
  if(!s){ sub.textContent = '新对话 · 还没有消息'; return; }
  var count = (typeof s.message_count === 'number') ? s.message_count : null;
  var c = _hdrMetricCache[s.id];
  var parts = [];
  var narrow = window.innerWidth <= 768;
  if(count != null) parts.push(count + (narrow ? ' 条' : ' 条消息'));
  if(c){
    /* 2026-11-13：后端 pct 被夹在 100，超窗看不出来。这里优先显示 pctRaw 真值并标「超窗」，
       分子分母都还是同一个口径（估算 token / 上下文窗口），只是不再假装最高只有 100%。
       2026-11-15：加阈值配色（75% 黄 / 90% 红）并让百分比可点 —— 能看见「快到线了」，
       且点一下就出压缩预览，不用先记住 /compress 这条命令。 */
    var _over = (c.over || c.pctRaw > 100);
    var _p = _over && c.pctRaw ? c.pctRaw : c.pct;
    var _tok = Math.round((c.total||0)/1000) + 'k tokens';
    var _win = c.window ? Math.round(c.window/1000) + 'k' : '';
    var _lvl = _over ? ' pct-crit' : (_p >= 90 ? ' pct-crit' : (_p >= 75 ? ' pct-warn' : ''));
    var _tip = _over ? ('上下文已超出窗口 ' + _tok + (c.window?(' / 窗口 '+Math.round(c.window/1000)+'k'):'') + '，下一轮会触发压缩')
                     : ('上下文占用 ' + _p + '%，点一下看压缩预览');
    parts.push('<span class="sub-ctx' + _lvl + '" role="button" tabindex="0" data-sid="' + DOM.escAttr(s.id) + '" title="' + _tip + '">' +
      '上下文 ' + _p + '%' + (_over ? '<span class="sub-over">超窗</span>' : '') +
      '<span class="sub-tok">（' + _tok + (_win?' / '+_win:'') + '）</span></span>');
  }
  var arch = _hdrArchiveCache[s.id];
  if(arch && arch.n > 0){
    parts.push('<button type="button" class="sub-arch" data-sid="' + DOM.escAttr(s.id) + '" title="压缩时被换成摘要的原文都留着，点开翻">📦 归档 ' + arch.n + ' 批</button>');
  }
  sub.innerHTML = parts.length ? parts.join(' · ') : '—';
  if(c && (Date.now() - c.ts) < 30000) return;
  var base = (typeof apiUrl === 'function') ? apiUrl('/api/sessions/' + encodeURIComponent(s.id) + '/usage')
                                            : ('/api/sessions/' + encodeURIComponent(s.id) + '/usage');
  fetch(base, { cache:'no-store', headers: (typeof monitorToken !== 'undefined' && monitorToken) ? {'X-Monitor-Token':monitorToken} : {} })
    .then(function(r){ return r.ok ? r.json() : null; })
    .then(function(d){
      if(!d || !d.usage) return;
      _hdrMetricCache[s.id] = { ts:Date.now(), pct:d.usage.pct||0, pctRaw:d.usage.pctRaw||d.usage.pct||0, over:!!d.usage.over, window:d.usage.window||0, total:d.usage.total||0 };
      if(currentSession === s.id) _updateHeaderMetric(_sessions.find(function(x){ return x.id === currentSession; }));
    })
    .catch(function(){});
  /* 归档批数：跟 usage 一起刷，但按会话缓存 60s */
  var ac = _hdrArchiveCache[s.id];
  if(!ac || (Date.now() - ac.ts) > 60000){
    if(typeof compressArchiveChip === 'function'){
      compressArchiveChip(s.id).then(function(n){
        _hdrArchiveCache[s.id] = { ts:Date.now(), n:n||0 };
        if(currentSession === s.id) _updateHeaderMetric(_sessions.find(function(x){ return x.id === currentSession; }));
      }).catch(function(){});
    }
  }
}
/* 会话头里两个可点元素：百分比 → 压缩预览；归档 → 原文查看器 */
document.addEventListener('click', function(e){
  var ctx = e.target.closest && e.target.closest('.sub-ctx');
  if(ctx && typeof runCompress === 'function'){
    e.preventDefault();
    runCompress('预览', ctx.getAttribute('data-sid'));
    return;
  }
  var arch = e.target.closest && e.target.closest('.sub-arch');
  if(arch && typeof openCompressArchive === 'function'){
    e.preventDefault();
    openCompressArchive(arch.getAttribute('data-sid'));
  }
});
/* ── 生成状态：会话标题旁的徽标 + 左侧会话列表同步
 * 复用 genBar 的 _tabGenState（按会话记 mode/text/ts/done），不新造事件源。 */
var _ST_ICON = {thinking:'🤔',generating:'✍️',reasoning:'💭',tool:'🛠',writing:'💻',queued:'⏳',agent:'🤖',
  search:'🔍',browse:'🌐',extract:'📄',file:'📝',image:'🎨',video:'🎬',media:'🎤',memory:'🧠',skill:'🧩',
  task:'📋',chat:'💬',done:'✅',error:'⚠️',stopped:'⏹'};
var _stateBadgeInt = null;
/* 标题旁只显示一句微信式短话，不搬 genBar 的长文案（"正在执行终端命令 …" 太长） */
var _ST_PHRASE = {thinking:'正在思考',reasoning:'正在想',generating:'正在回复',writing:'正在写',tool:'正在用工具',
  queued:'排队中',agent:'正在调度',search:'正在搜索',browse:'正在浏览',extract:'正在读页面',file:'正在读文件',
  image:'正在画图',video:'正在生成视频',media:'正在转语音',memory:'正在翻记忆',skill:'正在找技能',
  task:'正在排任务',chat:'正在回复'};
/* 跑马灯描边：只挂在「正在执行的那条消息」上，替代输入框上方的状态条
 * 2026-11-11 扩展（用户第 29 条）：排队中的每一条也要能看见、也要能撤。
 *   runningId → 正在执行的那条：彩色跑马灯
 *   queuedIds → 还没执行的每一条：呼吸灯 + 气泡下方「取消」按钮
 * 都按 data-request-id 找。**没有兜底**（2026-11-13 用户第 39 条，见下）。
 *
 * 增量更新，不是全量重建：refreshQueue 每 4s 跑一次，如果每次都把环删掉再插回去，
 * CSS 动画会被重置成第一帧，跑马灯看上去一顿一顿的。所以只摘「不该有」的。 */
function _markRunningMsg(on, mode, runningId, queuedIds){
  var body=document.getElementById('chatBody'); if(!body) return;
  function byId(id){ return id ? body.querySelector('.msg.user[data-request-id="'+id+'"]') : null; }

  /* 没有精确 id 的调用直接退场（2026-11-13 用户第 39 条）：既不改也不清。
     以前这种调用会走兜底误标，删了兜底之后如果不 return，清理逻辑仍会把
     队列真源刚标好的呼吸灯全擦掉——从「标错」变成「擦掉」，一样是坏的。 */
  if(on && !runningId && !(queuedIds && queuedIds.length)) return;

  var runEl=null;
  if(on && mode!=='queued'){
    /* 只认调用方给的 id，**删掉「找不到就退回最后一条」兜底**（2026-11-13 用户第 39 条）。
       兜底是这次「排队消息也转跑马灯」的真凶：连发三条时最后一条往往还在 pending，
       兜底把它标成 running，同时 qEls 为空又让清理逻辑把所有 .queued 摘光，
       于是呼吸灯一条都看不见、全变成彩色跑马灯。宁可不标，也不能标错。 */
    runEl = byId(runningId);
  }
  var qEls=[];
  /* m!==runEl：running 和 queued 必须互斥。服务端理论上不会把同一条同时给两边，
     但旧版兜底就制造过「同一条既转跑马灯又挂取消按钮」，这里加一道硬防线。 */
  if(on) (queuedIds||[]).forEach(function(id){ var m=byId(id); if(m && m!==runEl) qEls.push([id,m]); });
  function isQueued(el){ return qEls.some(function(p){ return p[1]===el; }); }

  /* 清理：只摘不在目标集合里的 */
  body.querySelectorAll('.msg.running').forEach(function(m){ if(m!==runEl) m.classList.remove('running'); });
  body.querySelectorAll('.msg.queued').forEach(function(m){ if(!isQueued(m)) m.classList.remove('queued'); });
  body.querySelectorAll('.msg-q-cancel').forEach(function(x){
    var host=x.closest('.msg');
    if(!isQueued(host)) x.remove();
  });
  if(!on) return;

  function ring(m,cls){
    if(!m) return;
    m.classList.add(cls);
    /* 轮廓 + 环带由 panel-chat-tail.js 按实际尺寸现算，
       跑马灯/呼吸灯只靠 .running / .queued 切 CSS，不另建 DOM */
    if(window.hpDrawTail) window.hpDrawTail(m);
  }
  ring(runEl,'running');
  qEls.forEach(function(p){
    var id=p[0], m=p[1];
    ring(m,'queued');
    /* 取消按钮只挂在「还没执行」的气泡上；跑完/失败时上面那段清理会摘掉它 */
    var acts=m.querySelector('.msg-actions');
    if(!acts){
      acts=document.createElement('div'); acts.className='msg-actions';
      var meta=m.querySelector('.msg-meta');
      if(meta) m.insertBefore(acts,meta); else m.appendChild(acts);
    }
    if(acts.querySelector('.msg-q-cancel')) return;
    var b=document.createElement('button');
    b.type='button'; b.className='msg-act-btn msg-q-cancel';
    b.title='取消这条还没执行的';
    b.textContent='取消';
    b.onclick=function(){ if(window.cancelQueueJob) window.cancelQueueJob(id); setTimeout(_genBarSweep, 1500); };
    acts.appendChild(b);
  });
}
function _paintStateBadge(){
  /* 会话标题旁的状态徽标已下线（2026-11-13 用户第 36 条）：状态只写在气泡内的 .msg-statusbar。
     保留函数名是为了不动那 6 个调用点；现在它只做陈旧状态自清，一个 DOM 都不碰。 */
  var st = _tabGenState[currentSession];
  /* 陈旧状态自清：真在跑的话每收一个 delta/工具事件都会刷新 ts（>25s 没动静＝这条状态已经没人维护） */
  if(st && !st.done){
    /* 排队态给 90s：真排队可以等，但「没人认领」的 pending 必须在 90s 后自然熄灭，
       否则服务重启后界面会永远停在「排队中/正在思考」（2026-11-11 用户实测）。 */
    var _lim = (st.mode === 'queued') ? 90000 : 25000;
    if((Date.now() - (st.ts || 0)) > _lim){ st.done = true; }
  }
  var running = !!(st && !st.done);
  /* 没有周期调用点的话，一轮里长时间没事件就永远判不到「陈旧」——心跳只判定，不渲染。 */
  if(running && !_stateBadgeInt){
    _stateBadgeInt = setInterval(function(){
      var s2 = _tabGenState[currentSession];
      if(!s2 || s2.done){ clearInterval(_stateBadgeInt); _stateBadgeInt = null; return; }
      var lim2 = (s2.mode === 'queued') ? 90000 : 25000;
      if((Date.now() - (s2.ts || 0)) > lim2){ s2.done = true; clearInterval(_stateBadgeInt); _stateBadgeInt = null; }
    }, 500);
  }
  if(!running && _stateBadgeInt){ clearInterval(_stateBadgeInt); _stateBadgeInt = null; }
}
/* 左侧会话列表：状态只写在会话气泡里，这里不再写任何字（2026-11-13 用户第 36 条）。
 * 曾经把「🛠 运行代码 (×3) · 111s」覆写进该行的 meta，把「今天 01:20 · 30 条」顶掉，
 * 左栏一整列变成工具状态。现在这个函数只干一件事：把历史污染还原回去。
 * 没有残留就直接返回，别让 500ms 心跳白扫一遍 DOM。 */
function _paintRailState(){
  var dirty = document.querySelectorAll('#railScroll .session-item[data-sid] .si-body .meta[data-meta-orig]');
  for(var i=0;i<dirty.length;i++){
    var meta = dirty[i];
    meta.textContent = meta.getAttribute('data-meta-orig');
    meta.removeAttribute('data-meta-orig');
    var row = meta.closest && meta.closest('.session-item');
    if(row) row.classList.remove('running');
  }
}
function openRailDrawer(){
  var r=document.getElementById('chatRail'); if(r){ r.classList.remove('hidden'); r.classList.add('open'); }
  var o=document.getElementById('chatRailOverlay'); if(o) o.classList.add('open');
  syncRailIcons();
}
function closeRailDrawer(){
  var r=document.getElementById('chatRail'); if(r) r.classList.remove('open');
  var o=document.getElementById('chatRailOverlay'); if(o) o.classList.remove('open');
  syncRailIcons();
}
/* 这颗按钮的图标必须跟「抽屉现在开没开」一致。
   原来只有窗口 resize 时才重算，手机上点开抽屉图标还是"展开"，看着像点了没反应。
   档案三页的图标归 archive-core 的 syncRailButton 管，这里发现不在对话页就直接交出去。 */
function syncRailIcons(){
  var cur = document.querySelector('.workbench-page.active, .page.active');
  if(cur && cur.id !== 'page-chat') return;
  var mobile = isMobileRail();
  var r = document.getElementById('chatRail');
  var drawerOpen = !!(r && r.classList.contains('open'));
  var collapsed = mobile ? !drawerOpen : (_railState === 2);
  var siO = document.getElementById('sidebarIconOpen'), siC = document.getElementById('sidebarIconClose');
  if(siO) siO.style.display = collapsed ? 'block' : 'none';
  if(siC) siC.style.display = collapsed ? 'none' : 'block';
  var st = document.getElementById('sidebarToggle');
  if(st) st.title = mobile ? (drawerOpen ? '收起会话树' : '展开会话树')
                           : (_railState === 2 ? '展开面板' : (_railState === 0 ? '折叠会话树' : '折叠菜单栏'));
}
/* 两级折叠：0=全部展开；1=会话树折叠；2=会话树+左侧菜单栏全折叠（类似 Octop） */
var _railState = 0;
function applyRailState(){
  var mobile = (window.matchMedia && window.matchMedia('(max-width:768px)').matches) || window.innerWidth<=768;
  var rail=document.getElementById('chatRail');
  var sb=document.querySelector('.global-sidebar');
  // 移动端：会话树强制折叠（抽屉模式，用户点「打开会话树」按钮才显示），忽略桌面持久化展开状态
  var railState = mobile ? 1 : _railState;
  var collapsed = _railState===2;
  if(rail) rail.classList.toggle('hidden', railState>=1);
  if(sb) sb.classList.toggle('collapsed', collapsed);
  syncRailIcons();
  syncSessionTabsVisibility();
  try { localStorage.setItem('fnos-rail-state', String(_railState)); } catch(e){}
}
function isMobileRail(){
  return (window.matchMedia && window.matchMedia('(max-width:768px)').matches) || window.innerWidth<=768;
}
function toggleRail(){
  /* 档案三页（提示词/知识库/留痕录）共用这一颗顶栏按钮：它开的是资料树抽屉。
     先问档案页、再判宽度——档案页的抽屉只跟「当前是哪一页」有关，跟窗口多宽无关；
     原来档案页自己造了个 ☰ + 「目录」小按钮，同一个位置两个入口，2026-11-15 用户驳回。 */
  if(window.Archive && window.Archive.toggleRailDrawer && window.Archive.toggleRailDrawer()) return;
  // 移动端是抽屉模式：会话树固定 hidden、靠 .open 滑出，桌面那套三级折叠在这里
  // 完全没有落点 —— 点一下改 _railState 却什么都看不见，按钮就等于失效。
  if(isMobileRail()){
    var r=document.getElementById('chatRail');
    if(r && r.classList.contains('open')) closeRailDrawer(); else openRailDrawer();
    var st=document.getElementById('sidebarToggle');
    if(st){ var isOpen=!!(r && r.classList.contains('open')); st.title=isOpen?'收起会话树':'展开会话树'; }
    return;
  }
  _railState = (_railState+1)%3;
  applyRailState();
}