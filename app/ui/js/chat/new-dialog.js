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
    '<div class="field"><label for="nsPersonality">表达风格</label><select id="nsPersonality"><option value="default">默认</option></select><div style="font-size:11px;color:var(--text3);margin-top:4px">只调整本会话的回答方式，不切换全局 SOUL、记忆、渠道或模型环境。</div></div>' +
    '<div class="field"><label>模型</label><select id="nsModel"><option value="">默认模型</option></select></div>' +
    '<div class="field"><label>工作区文件夹</label><div style="display:flex;gap:6px"><input type="text" id="nsWorkspace" placeholder="留空使用默认工作区（可浏览选择或输入新名称）" value="" style="flex:1"><button class="ov-actbtn" onclick="openWsPicker()" title="浏览选择工作区文件夹">📂 浏览</button></div></div>' +
    '<div style="font-size:11.5px;color:var(--text3);line-height:1.5;margin-top:2px">不想选就都不选，直接点「创建」，等于：默认表达风格 + 当前模型 + 默认工作区。</div>' +
    '</div>' +
    '<div class="modal-foot" style="padding:12px 16px;display:flex;justify-content:flex-end;gap:8px">' +
    '<button class="ov-actbtn" onclick="closeNewSessionModal()">取消</button>' +
    '<button class="ov-actbtn primary" onclick="createNewSession()">创建</button>' +
    '</div></div></div>';
  document.body.insertAdjacentHTML('beforeend', html);
  var _ndOv=document.getElementById('newSessionOverlay');
  if(_ndOv&&window.ui)window.ui.adoptOverlay(_ndOv);
  // 新会话只选择会话级表达风格；Profile 仍由独立的配置/渠道页面管理。
  apiGet('/api/workspace-ui/personalities').then(function(res){
    if(res && Array.isArray(res.personalities)){
      var sel=document.getElementById('nsPersonality');
      if(!sel)return;
      sel.innerHTML=res.personalities.map(function(p){return '<option value="'+DOM.escAttr(p.id)+'">'+esc(p.name||p.id)+'</option>';}).join('');
    }
  });
  // 加载模型
  apiGet('/api/config').then(function(res){
    if(res && res.providers){
      var sel=document.getElementById('nsModel');
      if(!sel)return;
      res.providers.forEach(function(p){
        var provName = p.name || p.id;
        var models = (p.models && p.models.length) ? p.models : [{ id:p.model||'auto', name:p.model||'auto', enabled:true }];
        var opts='';
        models.forEach(function(m){
          if(m.enabled === false) return;
          var modelId = m.id || m.name || 'auto';
          var modelName = m.name || m.id || 'auto';
          opts += '<option value="'+DOM.escAttr(modelId)+'">'+esc(modelName)+'</option>';
        });
        if(opts) sel.innerHTML += '<optgroup label="'+DOM.escAttr(provName)+'">'+opts+'</optgroup>';
      });
    }
  });
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
  var personality=(document.getElementById('nsPersonality')||{}).value||'default';
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
        return api('/api/workspace-ui/session','PUT',{id:x.id,personality:personality}).then(function(){ return x; }).catch(function(e){
          toast('会话已创建，但表达风格保存失败：'+e.message,'error');
          return x;
        });
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
      if(body) body.innerHTML='<div class="system-tip">新会话已创建'+(personality!=='default'?' · '+esc(personality):'')+(model?' · 模型: '+esc(model):'')+'</div>';
      if(workspace) _fmCwd=workspace;
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
       分子分母都还是同一个口径（估算 token / 上下文窗口），只是不再假装最高只有 100%。 */
    var _over = (c.over || c.pctRaw > 100);
    var _p = _over && c.pctRaw ? c.pctRaw : c.pct;
    var _tok = Math.round((c.total||0)/1000) + 'k tokens';
    var _win = c.window ? Math.round(c.window/1000) + 'k' : '';
    parts.push('上下文 ' + _p + '%' + (_over ? '<span class="sub-over" title="上下文已超出窗口 ' + _tok + (c.window?(' / 窗口 '+Math.round(c.window/1000)+'k'):'') + '，下一轮会触发压缩">超窗</span>' : '') + '<span class="sub-tok">（' + _tok + (_win?' / '+_win:'') + '）</span>');
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
}
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
}
function closeRailDrawer(){
  var r=document.getElementById('chatRail'); if(r) r.classList.remove('open');
  var o=document.getElementById('chatRailOverlay'); if(o) o.classList.remove('open');
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
  var siO=document.getElementById('sidebarIconOpen'), siC=document.getElementById('sidebarIconClose');
  if(siO) siO.style.display = collapsed?'block':'none';
  if(siC) siC.style.display = collapsed?'none':'block';
  var st=document.getElementById('sidebarToggle');
  if(st) st.title = _railState===2 ? '展开面板' : (_railState===0 ? '折叠会话树' : '折叠菜单栏');
  syncSessionTabsVisibility();
  try { localStorage.setItem('fnos-rail-state', String(_railState)); } catch(e){}
}
function isMobileRail(){
  return (window.matchMedia && window.matchMedia('(max-width:768px)').matches) || window.innerWidth<=768;
}
function toggleRail(){
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