/* 会话树（Rail）+ 浏览器式多会话标签 + 流式渲染节流
 * 来源：index.html 内联 app.js 第 579-2091 行（共 1513 行）
 * 2026-11-13 按原分区纯搬运外移，逻辑零改动。全局作用域与执行顺序与原内联块一致。 */

/* ============================ 会话树（Rail） ============================ */
/* ============================ 多会话标签（浏览器式多开） ============================ */
/* _openTabs：已打开的会话标签 id 数组（有序）；_tabDrafts：各标签输入框草稿；_tabStreaming：流式状态 */
var _openTabs = [];
var _tabDrafts = {};
var _tabStreaming = {};
var _chatHTML = {};
/* 【2026-10-09 修复】流式渲染节流。
   根因：onDelta 每收到一个 delta 就执行「全量 renderMarkdown + mdEl.innerHTML 重建 +
   强制 reflow 滚动 + body.innerHTML 全序列化」，回复越长单次开销越大；长回复时浏览器
   主线程饱和 → 视觉上「不出字 / 看不到连续输出」，等生成结束后才一次性显示完整。
   方案：合并高频 delta（默认最多约 10 次/秒渲染），收尾时 onDone 仍做全量渲染兜底。 */
var _streamRenderSt = {};
function _throttledRender(key, fn, minGap){
  minGap = minGap || 100;
  var st = _streamRenderSt[key] || (_streamRenderSt[key] = {timer:null, last:0, pending:null});
  st.pending = fn;
  if(st.timer) return;
  var wait = Math.max(0, minGap - (Date.now() - st.last));
  if(wait === 0){
    st.last = Date.now();
    var f0 = st.pending; st.pending = null;
    try{ f0(); }catch(e){}
    return;
  }
  st.timer = setTimeout(function(){
    st.timer = null; st.last = Date.now();
    var f = st.pending; st.pending = null;
    if(f){ try{ f(); }catch(e){} }
  }, wait);
}
function _flushStreamRender(key){
  var st = _streamRenderSt[key];
  if(!st) return;
  if(st.timer){ clearTimeout(st.timer); st.timer = null; }
  var f = st.pending; st.pending = null;
  if(f){ try{ f(); }catch(e){} }
}  // sid → chatBody.innerHTML 快照（流式后台继续时保留最新内容，切回时从缓存恢复）
try { _openTabs = JSON.parse(localStorage.getItem('hermes_open_tabs') || '[]'); } catch (e) { _openTabs = []; }
function persistTabs() { try { localStorage.setItem('hermes_open_tabs', JSON.stringify(_openTabs)); } catch (e) {} }

/* 渲染顶部标签栏 */
function renderSessionTabs() {
  var scroll = document.getElementById('tabsScroll');
  if (!scroll) return;
  var html = '';
  _openTabs.forEach(function (sid) {
    var s = _sessions.find(function (x) { return x.id === sid; });
    if (!s) return;
    var active = (sid === currentSession);
    var rawTitle = (s.title && s.title !== 'New Chat' && s.title !== '未命名会话') ? s.title : '新会话';
    var streaming = !!_tabStreaming[sid];
    html += '<div class="session-tab' + (active ? ' active' : '') + (streaming ? ' streaming' : '') + '" title="' + DOM.escAttr(rawTitle) + '">' +
      '<button type="button" class="tab-select" data-session-id="' + DOM.escAttr(sid) + '" aria-current="' + (active?'page':'false') + '" aria-label="切换到会话：' + esc(rawTitle) + '" title="双击可编辑名称与归类" onclick="switchTab(\'' + esc(sid) + '\')" ondblclick="renameSession(\'' + esc(sid) + '\',event)"><span class="tab-dot"></span><span class="tab-title">' + esc(rawTitle) + '</span></button>' +
      '<button type="button" class="tab-action tab-close" title="关闭标签" aria-label="关闭会话标签：' + esc(rawTitle) + '" onclick="closeTab(\'' + esc(sid) + '\')">×</button>' +
      '</div>';
  });
  scroll.innerHTML = html;
  var activeEl = scroll.querySelector('.session-tab.active');
  if (activeEl && activeEl.scrollIntoView) { try { activeEl.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) {} }
  var btn = document.getElementById('tabNewBtn');
  if (btn) btn.style.display = 'inline-flex';
  syncSessionTabsVisibility();
}

/* 保存/恢复指定标签的输入框草稿 */
function saveDraft(sid) {
  var ta = document.getElementById('chatInput');
  if (ta && sid) _tabDrafts[sid] = ta.value;
}
function restoreDraft(sid) {
  var ta = document.getElementById('chatInput');
  if (!ta) return;
  ta.value = _tabDrafts[sid] || '';
  try { autoResize(ta); } catch (e) {}
  var send = document.getElementById('sendBtn');
  if (send && !_msgState.streaming) send.disabled = !ta.value.trim();
}

/* 打开（或激活）一个会话标签 */
function openTabCore(sid) {
  if (!sid) return;
  if (_openTabs.indexOf(sid) === -1) { _openTabs.push(sid); persistTabs(); }
  switchTab(sid);
}

/* 切换激活标签：流式后台继续（并行多会话）。切换前保存当前 chatBody → _chatHTML[currentSession]，切回时仍优先用缓存（流式最新） */
function switchTabCore(sid) {
  if (!sid) return;
  if (sid === currentSession) {
    // 点击当前激活标签：收起标签栏（省出聊天空间），再点按钮可重新展开
    var _tabs = document.querySelector('.page-container .session-tabs');
    if (_tabs && _tabs.classList.contains('visible')) {
      _tabsManuallyHidden = true;
      _multiTabsForced = false;
      _saveTabsPref();
      syncSessionTabsVisibility();
    }
    return;
  }
  var body = document.getElementById('chatBody');
  if (body && currentSession) _chatHTML[currentSession] = body.innerHTML;
  saveDraft(currentSession);   // 保存当前会话草稿（含首次切换时 sid 为空，saveDraft 内部兜底）
  currentSession = sid;
  scrollChatToBottom();
  renderSessionTabs();
  renderRail(); updateHeader();
  restoreDraft(sid);
  _syncModelBtn();
  _syncGenBarToTab(sid);   // 按当前会话恢复 genBar 状态（多会话并行不互相覆盖）
  _checkActiveGen(sid);    // 后端仍在生成 → 恢复「正在继续生成…」提示
  // 工作区大纲 tab 激活时，切换会话后同步刷新大纲
  var _ws = document.getElementById('workspacePanel');
  if (_ws && _ws.classList.contains('open')) {
    var _wt = _ws.querySelector('.ws-tab.active');
    if (_wt && _wt.textContent.indexOf('大纲') !== -1) loadOutline();
  }
  if (body) {
    var cached = _chatHTML[sid];
    if (cached) {
      // 命中内存快照：立即恢复渲染（0 延迟），后台静默拉取最新消息覆盖，避免显示过期内容
      body.innerHTML = cached;
      if(window.ToolUI) ToolUI.paintAll(body);
      followChatBottom();
      loadSessionMessages(sid, true);
    } else {
      body.innerHTML = '<div class="system-tip">加载中…</div>';
      loadSessionMessages(sid);
    }
  }
}
document.addEventListener('keydown', function(event){
  if(event.key!=='Enter'&&event.key!==' ')return;
  var button=event.target&&event.target.closest&&event.target.closest('.session-tab .tab-select');
  if(!button)return;
  event.preventDefault();
  event.stopImmediatePropagation();
  window.switchTab(button.getAttribute('data-session-id'));
}, true);
// 从 _cfg 中查找当前 active provider 的默认模型名（/status 与模型按钮兜底共用）
function _getActiveModelName(){
  var ap = _cfg.active_provider;
  if(!ap) return '自动';
  var p = (_cfg.providers||[]).find(function(p){ return (p.name||p.id)===ap; });
  if(!p) return '自动';
  var model = p.model || '';
  if(model) return model;
  var models = p.models || [];
  var def = models.find(function(m){ return m.default===true; });
  if(def) return def.id || def.name || '';
  var en = models.find(function(m){ return m.enabled!==false; });
  return en ? (en.id || en.name || '') : '自动';
}
function _syncModelBtn(){
  var bm=document.getElementById('btnModel'); if(!bm) return;
  // 移除旧徽章
  var oldBadge = bm.querySelector('.model-badge'); if(oldBadge) oldBadge.remove();
  var sm=_getSessionModel();
  if(sm){
    var mName=(typeof sm==='object'&&sm.model)?sm.model:sm;
    bm.setAttribute('data-tip','本会话模型：'+mName+'（点击更换）'); bm.classList.add('active');
    // 添加小徽章显示模型名
    var badge=document.createElement('span');
    badge.className='model-badge';
    badge.textContent=mName.length>8?mName.slice(0,8)+'…':mName;
    bm.appendChild(badge);
  } else {
    // 无会话级选择时，兜底显示全局默认模型（修复：切换 Provider/模型后首页与按钮无反映）
    var globalModel = _getActiveModelName();
    var globalProv = _cfg.active_provider || '';
    if(globalModel && globalModel !== '自动'){
      bm.setAttribute('data-tip','默认模型：'+(globalProv?globalProv+' · ':'')+globalModel+'（点击更换）');
      bm.classList.add('active');
      var label = globalProv ? globalProv.slice(0,4)+'…' : globalModel;
      var badge2 = document.createElement('span');
      badge2.className='model-badge';
      badge2.textContent = label.length>8 ? label.slice(0,8)+'…' : label;
      bm.appendChild(badge2);
    } else {
      bm.setAttribute('data-tip','选择模型（尚未指定）'); bm.classList.remove('active');
    }
  }
}

/* 关闭一个会话标签（会话本身保留在左侧树）；流式中允许关闭（后台流式继续，不影响其他会话） */
function closeTab(sid) {
  var i = _openTabs.indexOf(sid);
  if (i === -1) return;
  // Closing a view does not cancel a server-owned task or erase its draft.
  if (currentSession === sid) saveDraft(sid);
  _openTabs.splice(i, 1); persistTabs();
  if (currentSession === sid) {
    currentSession = _openTabs.length ? _openTabs[Math.min(i, _openTabs.length - 1)] : '';
    if (currentSession) {
      renderRail(); updateHeader();
      restoreDraft(currentSession);
      loadSessionMessages(currentSession);
      _syncModelBtn();
    } else {
      var body = document.getElementById('chatBody');
      if (body) body.innerHTML = '<div class="system-tip">没有打开的会话，点击右上角 + 新建</div>';
      updateHeader();
      _syncModelBtn();
    }
  }
  renderSessionTabs(); renderRail();
}

/* 新建会话并打开为标签 */
function newTabCore() {
  // profilefix v4（模型 A）：会话不分 agent 分组，新建会话直接入全局树
  fetch(apiUrl('/api/sessions'), { method: 'POST', headers: monitorToken ? { 'X-Monitor-Token': monitorToken } : {} })
    .then(function (r) { return r.json(); })
    .then(function (s) {
      _sessions.unshift(s);
      currentSession = s.id;
      _applyPendingModel(s.id);
      _openTabs.push(s.id); persistTabs();
      saveDraft(currentSession);   // 新建前保存当前会话草稿
      var ta = document.getElementById('chatInput'); if (ta) ta.value = '';
      renderSessionTabs(); renderRail(); updateHeader();
      if (window.innerWidth <= 768) closeRailDrawer();
      var body = document.getElementById('chatBody');
      if (body) body.innerHTML = '<div class="system-tip">新会话已创建</div>';
    })
    .catch(function () { toast('创建会话失败'); });
}

/* 与后端会话列表同步标签（删除会话后清理、首次加载默认打开一个） */
function syncTabs() {
  var valid = _sessions.map(function (s) { return s.id; });
  _openTabs = _openTabs.filter(function (sid) { return valid.indexOf(sid) !== -1; });
  if (!_openTabs.length && _sessions.length) { _openTabs.push(_sessions[0].id); }
  persistTabs();
  if (currentSession && valid.indexOf(currentSession) === -1) {
    currentSession = _openTabs.length ? _openTabs[0] : '';
  }
  renderSessionTabs();
}

/* 同步标签栏可见性：多会话按钮强制开启 > 移动端始终显示 > 桌面端仅 rail 折叠时显示 */
var _TABS_PREF_KEY = 'hermes_multi_tabs_pref';
function _loadTabsPref(){ try{ var v=JSON.parse(localStorage.getItem(_TABS_PREF_KEY)||'null'); if(v){ _multiTabsForced=!!v.forced; _tabsManuallyHidden=!!v.hidden; } }catch(e){} }
function _saveTabsPref(){ try{ localStorage.setItem(_TABS_PREF_KEY, JSON.stringify({forced:!!_multiTabsForced,hidden:!!_tabsManuallyHidden})); }catch(e){} }
var _multiTabsForced = false;
var _tabsManuallyHidden = false;   // 用户手动收起过标签栏（刷新后保持，直到再次点击按钮）
_loadTabsPref();
function toggleSessionTabsBar(){
  // 以"当前实际可见"为真相：可见 → 收起；不可见 → 展开。状态立即落盘，刷新后保持。
  var tabs = document.querySelector('.page-container .session-tabs');
  var visible = !!(tabs && tabs.classList.contains('visible'));
  if(visible){ _multiTabsForced=false; _tabsManuallyHidden=true; }
  else { _multiTabsForced=true; _tabsManuallyHidden=false; }
  _saveTabsPref();
  syncSessionTabsVisibility();
}
function updateSessionTabsToggle(){
  var tabs=document.querySelector('.page-container .session-tabs');
  var btn=document.getElementById('multiTabsBtn');
  if(!tabs||!btn) return;
  var visible=tabs.classList.contains('visible');
  var label=visible?'隐藏多会话标签':'显示多会话标签';
  btn.classList.toggle('active', visible);      // 图标点亮 = 标签栏真的在显示
  btn.setAttribute('aria-pressed', String(visible));
  btn.setAttribute('aria-expanded',String(visible));
  btn.setAttribute('aria-label',label);
  btn.title=label;
}
function syncSessionTabsVisibility() {
  var tabs = document.querySelector('.page-container .session-tabs');
  if (!tabs) return;
  var rail = document.getElementById('chatRail');
  if (!rail) return;
  if (_multiTabsForced) {
    tabs.classList.add('visible');  // 多会话按钮强制开启
  } else if (_tabsManuallyHidden) {
    tabs.classList.remove('visible');  // 用户手动收起后保持收起（移动端与桌面端一致）
  } else if (window.innerWidth <= 768) {
    tabs.classList.toggle('visible', _openTabs.length > 1);  // 单会话时收起冗余标签，多会话时直接切换
  } else if (rail.classList.contains('hidden')) {
    tabs.classList.add('visible');  // 桌面端：仅 rail 折叠时显示
  } else {
    tabs.classList.remove('visible');
  }
  updateSessionTabsToggle();
}

function loadSessions(){
  return fetch(apiUrl('/api/sessions'), { cache:'no-store', headers: monitorToken?{'X-Monitor-Token':monitorToken}:{} })
    .then(function(r){ return r.json(); })
    .then(function(d){
      _sessions = (d && d.sessions) || [];
      if(!currentSession && _sessions.length){ currentSession = _sessions[0].id; }
      else if(currentSession && !_sessions.some(function(s){ return s.id===currentSession; })){ currentSession = _sessions.length?_sessions[0].id:''; }
      syncTabs();
      // profilefix v3（模型 A）：rail 高亮跟随全局 active profile，
      // 不从会话归属恢复（角色是全局单激活的，与会话无关）
      try {
        currentAgent = _activeRailAgentId();
      } catch(e){ currentAgent = 'default'; }
      renderRail(); updateHeader();
      _syncModelBtn();
      if(currentSession) loadSessionMessages(currentSession);
    })
    .catch(function(){ toast('加载会话失败，无法连接后端'); renderRail(); });
}
function fmtDateTime(ts){
  if(!ts) return '';
  var n = Number(ts);
  if(isNaN(n)) return '';
  // 秒级时间戳（10位）自动转毫秒；毫秒级（13位）直接用（升级 0.21.149 后重打 2026-08-24）
  if(n > 0 && n < 1e12) n = n * 1000;
  var d = new Date(n);
  if(isNaN(d.getTime())) return '';
  var pad = function(n){ return (n<10?'0':'')+n; };
  var now = new Date();
  var hm = pad(d.getHours())+':'+pad(d.getMinutes());
  var sameDay = d.getFullYear()===now.getFullYear() && d.getMonth()===now.getMonth() && d.getDate()===now.getDate();
  if(sameDay) return '今天 '+hm;
  var y = new Date(now); y.setDate(now.getDate()-1);
  var isYest = d.getFullYear()===y.getFullYear() && d.getMonth()===y.getMonth() && d.getDate()===y.getDate();
  if(isYest) return '昨天 '+hm;
  return (d.getMonth()+1)+'月'+d.getDate()+'日 '+hm;
}
function renderRail(){
  var el = document.getElementById('railScroll');
  if(!el) return;
  // 一次性清理 v0.20.66 期间 localStorage 存的旧 'true' 值（让默认折叠生效）
  if (!_state._railOpenCleaned) {
    try {
      var keys = Object.keys(localStorage);
      for (var i = 0; i < keys.length; i++) {
        if (keys[i].indexOf('hermes_rail_open_') === 0) localStorage.removeItem(keys[i]);
      }
      _state._railOpenCleaned = true;
      try { localStorage.setItem('hermes_ui_flags', JSON.stringify({ railOpenCleaned: true })); } catch(e){}
    } catch(e){ _state._railOpenCleaned = true; }
  }
  var html = typeof pwRailHTML === 'function' ? pwRailHTML() : '';
  el.innerHTML = html;
  var cnt = document.getElementById('railCount');
  if (cnt) cnt.textContent = ((_sessions && _sessions.length) || 0) + ' 个';
  renderRailChannels();
  _paintRailState();   // 列表重建后把在跑的会话状态补回去
}
/* 通道会话：独立容器，固定在侧栏底部，不随会话列表滚动 */
function renderRailChannels(){
  var box = document.getElementById('railChannels');
  if(!box) return;
  var chGroups = _channelSessions || {};
  var chIds = Object.keys(chGroups).filter(function(k){ return k !== 'api_server'; });
  if(!chIds.length){ box.innerHTML = ''; box.classList.remove('has'); return; }
  var html = '';
  chIds.forEach(function(chId){
    var sessions = chGroups[chId];
    var def = (_chState.defs && _chState.defs[chId]) || {};
    var chName = def.name || chId;
    var chIcon = def.icon || '📨';
    // 树目录统一模板：与文件夹组共用同一套箭头/动画/热区/缩进/记忆
    var kids = sessions.length ? sessions.slice(0,20).map(function(s){
      var title = (s.title && s.title!=='未命名会话') ? s.title : '新会话';
      var meta = s.model ? esc(s.model) : '';
      return '<div class="session-item" onclick="openChannelSession(\''+esc(chId)+'\',\''+esc(s.id)+'\')">' +
        '<span class="dot"></span>'+
        '<span class="si-body"><span class="title">'+esc(title)+'</span>'+(meta?'<span class="meta">'+meta+'</span>':'')+'</span>'+
        '<span class="del" title="删除该通道会话" onclick="delChannelSession(\''+esc(chId)+'\',\''+esc(s.id)+'\',event)">×</span></div>';
    }).join('') : '<div class="empty-sess">暂无会话</div>';
    html += PwTree.node({ key:'ch:'+chId, def:false, icon:esc(chIcon), label:chName,
      meta:sessions.length+' 个', body:kids });
  });
  box.innerHTML = html;
  box.classList.add('has');
}
var _channelSessions = null;
/* 侧栏内联筛选：只动 display，不重建 DOM，所以输入框不丢焦点。
   文件夹名命中时，其下所有会话一并放行。 */
window.pwRailFilter = function(q){
  q = (q || '').trim().toLowerCase();
  var el = document.getElementById('railScroll');
  if(!el) return;
  var hadHit = false;
  // 树结构（pw-tree-node）：文件夹比名称、会话比标题；子项命中则保留祖先并临时展开，
  // 清空后按 data-f-old 还原用户原来的开合状态。
  function walk(node){
    var key = node.getAttribute('data-tree-key') || '';
    var isFolder = key.indexOf('folder:') === 0;
    var head = node.querySelector(':scope > .pw-tree-head');
    var lab = head ? head.querySelector('.pw-tree-label') : null;
    var name = (lab ? lab.textContent : '').toLowerCase();
    var selfHit = !!q && isFolder && name.indexOf(q) >= 0;
    var kidHit = false;
    node.querySelectorAll(':scope > .pw-tree-body > .pw-tree-inner > .pw-tree-kids > .pw-tree-node').forEach(function(k){
      if(walk(k)) kidHit = true;
    });
    node.querySelectorAll(':scope > .pw-tree-body > .pw-tree-inner > .pw-tree-kids > .session-item').forEach(function(it){
      var tn = it.querySelector('.title');
      var txt = (tn ? tn.textContent : it.textContent).toLowerCase();
      var hit = !q || selfHit || txt.indexOf(q) >= 0;
      it.style.display = hit ? '' : 'none';
      if(hit) kidHit = true;
    });
    var show = !q || selfHit || kidHit;
    node.style.display = show ? '' : 'none';
    if(q && show) hadHit = true;
    var toggle = head ? head.querySelector('.pw-tree-toggle') : null;
    if(q && show){
      if(node.getAttribute('data-f-old') === null) node.setAttribute('data-f-old', node.classList.contains('is-open') ? '1' : '0');
      node.classList.add('is-open');
      if(toggle) toggle.setAttribute('aria-expanded', 'true');
    } else if(!q && node.getAttribute('data-f-old') !== null){
      var old = node.getAttribute('data-f-old') === '1';
      node.classList.toggle('is-open', old);
      if(toggle) toggle.setAttribute('aria-expanded', old ? 'true' : 'false');
      node.removeAttribute('data-f-old');
    }
    return show;
  }
  var tops = el.querySelectorAll(':scope > .pw-tree-node');
  if(tops.length){
    tops.forEach(walk);
  } else {
    el.querySelectorAll('.session-item').forEach(function(it){
      var tn = it.querySelector('.title');
      var txt = (tn ? tn.textContent : it.textContent).toLowerCase();
      var hit = !q || txt.indexOf(q) >= 0;
      it.style.display = hit ? '' : 'none';
      if(hit) hadHit = true;
    });
  }
  var empty = document.getElementById('railFilterEmpty');
  if(!empty){
    empty = document.createElement('div');
    empty.id = 'railFilterEmpty';
    empty.className = 'pw-hint';
    empty.style.cssText = 'padding:12px 14px;font-size:12px;color:var(--muted)';
    empty.textContent = '没有匹配的会话或文件夹';
    el.appendChild(empty);
  }
  empty.style.display = (q && !hadHit) ? '' : 'none';
};
function railGlobalSearchGo(){
  var inp = document.getElementById('railFilterInput');
  var v = inp ? inp.value.trim() : '';
  if(window.pwSearch) window.pwSearch(v);
}
var _channelViewActive = false;   // 通道会话只读视图状态（聊天页标题显示返回按钮，切页自动退出）
function exitChannelView(){
  _channelViewActive = false;
  /* 退出渠道预览要把输入框放回来——以前这一步是 panel-workspace 覆盖这里补的 */
  var composer = document.getElementById('chatComposer'); if(composer) composer.hidden = false;
  var rb = document.getElementById('chReturnBtn'); if(rb) rb.style.display='none';
  var body = document.getElementById('chatBody');
  if(body) body.innerHTML = '<div class="system-tip">已退出通道会话。在左侧选择会话继续。</div>';
  updateHeader();
  loadSessions();
}
function fetchChannelSessions(){
  if(_authWallShown) return;   // 授权失效后停掉 30 秒轮询，别对着 401 空转
  apiGet('/api/channel-sessions').then(function(res){
    if(res && res.ok && res.groups){ _channelSessions = res.groups; renderRail(); }
  }).catch(function(){});
}
function toggleChannelGroup(chId){
  // 兼容入口：外部若还按旧函数名调用，转交给统一树模板
  var btn = document.querySelector('.pw-tree-node[data-tree-key="ch:'+chId+'"] .pw-tree-toggle');
  if(btn) PwTree.toggle(btn);
}
function openChannelSession(chId, sessionId){
  scrollChatToBottom();
  // 通道会话：直接在 WEBUI 聊天窗口加载消息（从 Dashboard API 拉取）
  var def = (_chState.defs && _chState.defs[chId]) || {};
  var chName = def.name || chId;
  _channelViewActive = true;
  var rb = document.getElementById('chReturnBtn'); if(rb) rb.style.display='inline-flex';
  // 切换到聊天页
  switchPage('chat');
  // 更新标题
  var titleEl = document.getElementById('chatTitle');
  var subEl = document.getElementById('chatSubtitle');
  if(titleEl) titleEl.textContent = chName + ' 通道会话';
  if(subEl) subEl.textContent = '加载中…';
  // 显示 loading
  var body = document.getElementById('chatBody');
  if(body) body.innerHTML = '<div class="system-tip">正在加载 '+esc(chName)+' 通道会话消息…</div>';
  // 拉取消息
  apiGet('/api/channel-sessions/'+encodeURIComponent(sessionId)+'/messages').then(function(res){
    if(!res || !res.ok || !res.messages || !res.messages.length){
      if(body) body.innerHTML = '<div class="system-tip">该通道会话暂无消息记录'+(res&&res.error&&!/fetch|Failed/i.test(res.error)?' ('+esc(res.error)+')':'')+'</div>';
      if(subEl) subEl.textContent = chName + ' · 0 条消息';
      return;
    }
    var msgs = res.messages;
    if(subEl) subEl.textContent = chName + ' · ' + msgs.length + ' 条消息' + (res.title ? ' · ' + res.title : '');
    // 渲染消息到聊天区域
    var html = '<div class="system-tip" style="background:var(--accent);color:#fff;opacity:.9">📨 '+esc(chName)+' 通道会话（只读） · '+msgs.length+' 条消息</div>';
    msgs.forEach(function(m){
      var isUser = (m.role === 'user' || m.role === 'human');
      var cls = isUser ? 'user' : 'assistant';
      var label = isUser ? '你' : ('Hermes' + (m.model ? ' · '+m.model : ''));
      var time = m.timestamp ? fmtDateTime(m.timestamp) : '';
      var content = m.content || '';
      // 简单 Markdown 渲染（代码块 + 换行）
      var rendered = esc(content).replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>').replace(/\n/g, '<br>');
      html += '<div class="msg '+cls+'"><div class="msg-bubble"><div class="md-text">'+rendered+'</div></div><div class="msg-meta">'+esc(label)+' · '+esc(time)+'</div></div>';
    });
    if(body){ body.innerHTML = html; followChatBottom(); }
  }).catch(function(e){
    if(body) body.innerHTML = '<div class="system-tip">通道会话服务暂不可用（网关/仪表盘未就绪），请稍后刷新重试</div>';
  });
}
function toggleAgent(id){
  currentAgent = id;
  var list = document.getElementById('sess-'+id);
  if(list){ var open = list.classList.toggle('open');
    // 折叠三角方向同步：expanded 类必须加到 agent-row，chevron 才会旋转（▶→▼）
    var row = list.parentNode.querySelector('.agent-row'); if(row) row.classList.toggle('expanded', open);
    localStorage.setItem('hermes_rail_open_'+id, open ? 'true' : 'false'); }
}
function switchSession(aid, sid, e){
  if(e) e.stopPropagation();
  openTab(sid);
  if(window.innerWidth<=768) closeRailDrawer();
}
/* profilefix v4：agent 分组概念已移除（会话树单一平铺），deleteAgentGroup 不再需要 */
async function delSession(sid, e){
  if(e) e.stopPropagation();
  if(!(await ui.confirm('归档该会话？正文和分类会保留，可从“已归档”恢复。'))) return;
  fetch(apiUrl('/api/sessions/'+encodeURIComponent(sid)), { method:'DELETE', headers: monitorToken?{'X-Monitor-Token':monitorToken}:{} })
    .then(function(r){
      if(!r.ok) return r.json().catch(function(){return {};}).then(function(j){ throw new Error(j.error||'归档失败'); });
      _sessions = _sessions.filter(function(s){ return s.id!==sid; });
      var ti = _openTabs.indexOf(sid);
      if(ti!==-1){ _openTabs.splice(ti,1); persistTabs(); }
      delete _tabDrafts[sid]; delete _tabStreaming[sid]; delete _chatHTML[sid]; delete _syncSigCache[sid];
      if(currentSession===sid) currentSession = _openTabs.length?_openTabs[0]:(_sessions.length?_sessions[0].id:'');
      renderSessionTabs(); renderRail(); updateHeader();
      if(currentSession) loadSessionMessages(currentSession);
      // 工作区大纲 tab 激活时，删除会话后同步刷新大纲
      var _ws2 = document.getElementById('workspacePanel');
      if (_ws2 && _ws2.classList.contains('open')) {
        var _wt2 = _ws2.querySelector('.ws-tab.active');
        if (_wt2 && _wt2.textContent.indexOf('大纲') !== -1) loadOutline();
      }
      else { var b = document.getElementById('chatBody'); if(b) b.innerHTML = '<div class="system-tip">没有打开的会话，点击右上角 + 新建</div>'; }
    })
    .catch(function(e){ toast(e.message||'归档失败'); });
}
/* 删除通道会话（cron/微信/QQ 等）：调 monitor 删除 API（gateway 优先，dashboard 兜底），成功后本地移除 */
async function delChannelSession(chId, sid, e){
  if(e && e.stopPropagation) e.stopPropagation();
  if(!(await ui.confirm('确定删除该通道会话？将删除 Hermes 中的该会话记录。', {danger:true}))) return;
  var hd = monitorToken ? { 'X-Monitor-Token': monitorToken } : {};
  fetch(apiUrl('/api/channel-sessions/'+encodeURIComponent(sid)), { method:'DELETE', headers:hd })
    .then(function(r){ return r.json().catch(function(){ return {}; }); })
    .then(function(j){
      if(j && j.ok){
        toast('已删除通道会话');
        if(_channelSessions && _channelSessions[chId]){
          _channelSessions[chId] = _channelSessions[chId].filter(function(s){ return String(s.id)!==String(sid); });
          renderRail();
        }
      } else {
        toast('删除失败: '+((j&&j.error)||'服务器没有返回删除原因'),'error');
      }
    })
    .catch(function(){ toast('删除失败','error'); });
}
/* 会话重命名：列表项 ✎ / 标签页 ✎ → prompt → POST /api/sessions/rename → 刷新列表与标签 */
/* 会话列表点击：单击切换会话，420ms 内再点同一项 → 打开「会话名称与归类」面板。
 * 不用 ondblclick：openTab() 里 renderRail() 会重建列表 DOM，双击第二下落在新节点上，
 * 事件配不成一对（实测 dblclick 不触发）。 */
var _railLastClick = { sid: null, t: 0 };
function railSessionClick(sid, e){
  if(e && e.stopPropagation) e.stopPropagation();
  var now = Date.now();
  if(_railLastClick.sid === sid && now - _railLastClick.t < 420){
    _railLastClick.sid = null; _railLastClick.t = 0;
    return renameSession(sid, e);
  }
  _railLastClick.sid = sid; _railLastClick.t = now;
  openTab(sid);
}
function renameSession(sid, e){
  if(e && e.stopPropagation) e.stopPropagation();
  // 真实现是 panel-workspace-ui.js 的「会话名称与归类」弹窗；原生 prompt 只在它没加载时兜底
  if (typeof window.__pwRenameSession === 'function') return window.__pwRenameSession(sid, e);
  var s = _sessions.find(function(x){ return x.id===sid; });
  if(!s) return;
  var old = (s.title && s.title!=='New Chat' && s.title!=='未命名会话') ? s.title : '';
  var title = prompt('重命名会话：', old);
  if(title===null) return;
  title = title.trim();
  if(!title || title===old) return;
  apiPost('/api/sessions/rename', { id: sid, title: title }).then(function(r){
    if(r && r.ok){
      s.title = r.title;
      renderRail(); renderSessionTabs(); updateHeader();
      if(sid===currentSession){ var t=document.getElementById('chatTitle'); if(t) t.textContent=r.title; }
      toast('已重命名为「'+r.title+'」');
    } else {
      toast((r && r.error) || '重命名失败');
    }
  }).catch(function(){ toast('重命名失败'); });
}
/* 两个加号统一走同一个弹窗（2026-11-11 用户第 6 条）：
 * 侧栏「会话」标题旁那个加号原本直接塞一个空会话（newTab），
 * 标签栏那个却是弹窗选表达风格/模型/工作区（openNewSessionModal）——
 * 同一个动作两套行为，用的人根本不知道该按哪个。现在都走弹窗，
 * 不想选就什么都别选，直接点「创建」= 默认风格 + 当前模型 + 默认工作区。 */
function newSession(){
  openNewSessionModal();
}
function loadSessionMessages(sid, silent, keepScroll){
  var body = document.getElementById('chatBody');
  if(!body) return;
  return fetch(apiUrl('/api/sessions/'+encodeURIComponent(sid)), { cache:'no-store', headers: monitorToken?{'X-Monitor-Token':monitorToken}:{} })
    .then(function(r){ if(!r.ok) throw new Error('load'); return r.json(); })
    .then(function(s){
      if(sid!==currentSession) return;
      var prevTop=body.scrollTop;
      var following=autoScrollActive();
      var msgs = dedupeGhostMsgs(s.messages || []);
      if(!msgs.length){ body.innerHTML = welcomeHTML(); return; }
      /* 排队/运行中的气泡连 DOM 一起留住（2026-11-13 用户第 44 条）。
         以前重绘是把它们删掉再让 refreshQueue 画回来：动画从第一帧重来，
         看上去就是「闪一下」；中间那几秒更是空的。这里把旧节点整对搬到新树里，
         CSS 动画不断、计时不归零。 */
      var keepLive=[];
      var _liveIds=(window.pwLiveQueueIds&&window.pwLiveQueueIds())||[];
      body.querySelectorAll('.msg[data-request-id]').forEach(function(el){
        var _id=el.getAttribute('data-request-id');
        if(_liveIds.indexOf(_id)>=0||el.classList.contains('queued')||el.classList.contains('running')) keepLive.push(el);
      });
      /* 整片重绘期间立个牌子（2026-11-13 用户第 56 条）：resyncQueueFx 一看见它就让位。
         以前重绘刚写进 innerHTML、还没把活着的节点搬回来，resync 已经冲进来补占位了 ——
         补出来的占位转眼变成重复节点被删，删完下一轮又补，用户看到的就是气泡抽个不停。 */
      window._pwHistoryRendering = true;
      try{
        body.innerHTML = msgs.map(function(m){ return msgHTML(m); }).join('');
        /* 搬回来的顺序必须成对（2026-11-13 用户第 56 条）：以前照捕获时的 DOM 顺序逐个 append，
           只要捕获那一刻用户气泡还没画出来（占位是后补的），搬回来就先出现一串「只有助手卡」
           的孤儿节点，过 200ms 用户气泡才补上 —— 用户看到的就是队列卡在抽。 */
        keepLive.sort(function(x,y){
          var ix=_liveIds.indexOf(x.getAttribute('data-request-id'));
          var iy=_liveIds.indexOf(y.getAttribute('data-request-id'));
          if(ix!==iy) return ix-iy;
          var ux=x.classList.contains('user')?0:1, uy=y.classList.contains('user')?0:1;
          return ux-uy;
        });
        keepLive.forEach(function(el){
          var _id = el.getAttribute('data-request-id');
          body.querySelectorAll('.msg[data-request-id="'+_id+'"]').forEach(function(n){ n.remove(); });
          body.appendChild(el);
        });
      } finally { window._pwHistoryRendering = false; }
      if(window.ToolUI) ToolUI.paintAll(body);
      _chatHTML[sid] = body.innerHTML;  // 回写快照缓存，下次切换 0 延迟
      if(!following){ body.scrollTop=prevTop; _chatScroll.lastTop=body.scrollTop; } else followChatBottom();
      scheduleChatFollow();
      condenseChatBody();
      /* 整片重绘会连排队那一层的 DOM 一起换掉：呼吸灯、取消按钮、只在本地的占位气泡、
         正在跑那条的状态栏全没了，只能等下一轮 refreshQueue（4s）才回来——用户看到的
         就是「先一个气泡在处理，过几秒又闪出两条排队」。同一帧补回来（2026-11-13 第 44 条）。 */
      try{ window.pwResyncQueueFx && window.pwResyncQueueFx(); }catch(e){}
    })
    .catch(function(){ if(sid===currentSession) body.innerHTML = '<div class="chat-load-error"><span role="alert">加载消息失败，请确认后端已连接后重试。</span><button type="button" onclick="loadSessionMessages(currentSession)">重新加载消息</button></div>'; });
}

/* ── 幽灵修复：仅更新会话最后一条消息的 DOM（增量），不整页重渲染 ──
   与 loadSessionMessages 的区别：不清空 body、不重排所有消息，只替换最后一个 .msg 节点。
   用于 pollSessionSync 检测到「消息条数没变但最后一条内容变了」（另一窗口流式 checkpoint）。
   升级 0.21.149 后重打（2026-08-24） */
function patchLastMessage(sid){
  var body = document.getElementById('chatBody');
  if(!body) return;
  return fetch(apiUrl('/api/sessions/'+encodeURIComponent(sid)), { cache:'no-store', headers: monitorToken?{'X-Monitor-Token':monitorToken}:{} })
    .then(function(r){ return r.ok ? r.json() : null; })
    .then(function(s){
      if(sid!==currentSession || !s || !s.messages || !s.messages.length) return;
      var msgs = dedupeGhostMsgs(s.messages || []);
      var last = msgs[msgs.length - 1];
      if(!last) return;
      var all = body.querySelectorAll('.msg');
      var lastEl = all[all.length - 1];
      if(!lastEl) return;
      var html = msgHTML(last);
      if(lastEl.outerHTML === html) return;   // 无变化不重写
      /* 正在排队/正在跑的那条不许被增量替换（2026-11-13 用户第 44 条）：
         历史版没有 data-request-id、没有环、没有状态栏，一换就成了「气泡凭空消失 2 秒」。 */
      var _lastId = lastEl.getAttribute('data-request-id') || '';
      var _live = (window.pwLiveQueueIds && window.pwLiveQueueIds()) || [];
      if(_lastId && _live.indexOf(_lastId) >= 0) return;
      var keepScroll = autoScrollActive();
      lastEl.outerHTML = html;
      if(window.ToolUI) ToolUI.paintAll(body);
      _chatHTML[sid] = body.innerHTML;
      if(keepScroll){ followChatBottom(); }
      scheduleChatFollow();
      condenseChatBody();
    })
    .catch(function(){});
}

/* ── 幽灵消息去重：同一用户消息后的多条完整 assistant 只保留最后一条 ──
   背景：WS 断线降级 SSE + 双流并发时，后端可能把同一条回复写成多条 assistant 消息。
   渲染前按「连续 assistant 之间没有 user 分隔」规则折叠，只留最后一条，消灭幽灵回复。 */
function dedupeGhostMsgs(msgs){
  if(!Array.isArray(msgs) || msgs.length < 2) return msgs;
  var out = [];
  for(var i = 0; i < msgs.length; i++){
    var m = msgs[i];
    if(m && m.role === 'assistant'){
      var prev = out[out.length - 1];
      if(prev && prev.role === 'assistant'){
        // 两条连续 assistant（中间无 user）：保留内容更长/更新的那一条
        var prevLen = (typeof prev.content === 'string' ? prev.content : JSON.stringify(prev.content||'')).length;
        var curLen = (typeof m.content === 'string' ? m.content : JSON.stringify(m.content||'')).length;
        if(curLen >= prevLen) out[out.length - 1] = m;
        continue;
      }
    }
    out.push(m);
  }
  return out;
}

/* ── 聊天 DOM 治理：消息超过阈值自动折叠最早消息，防长会话/圆桌 DOM 膨胀卡死 ──
   DOM 节点数有上限后，即使几百条消息的会话滚动、渲染、markdown 布局都保持流畅。
   折叠条只保留一份 HTML 字符串，不占 DOM；点击展开恢复（60 秒保护期内不自动重折叠）。 */
var MAX_VISIBLE_MSGS = 60;
var _foldedMsgs = null;       // 被折叠消息的 outerHTML 数组
var _foldHoldUntil = 0;       // 用户展开后的保护截止时间
function condenseChatBody(){
  if(!autoScrollActive()) return; // 阅读历史时不移除上方消息，避免位置跳动
  var body = document.getElementById('chatBody');
  if(!body) return;
  if(Date.now() < _foldHoldUntil) return;   // 用户刚展开查看旧记录：不重新折叠
  if(body.querySelector('#rtCondenseBar')) return;
  var msgs = body.querySelectorAll('.msg');
  var extra = msgs.length - MAX_VISIBLE_MSGS;
  if(extra <= 0) return;
  var hidden = [];
  for(var i = 0; i < extra; i++){ hidden.push(msgs[i].outerHTML); msgs[i].remove(); }
  if(!hidden.length) return;
  _foldedMsgs = (_foldedMsgs || []).concat(hidden);
  var bar = document.createElement('div');
  bar.id = 'rtCondenseBar'; bar.className = 'rt-condense';
  bar.innerHTML = '<span>↕ 查看更早的 ' + _foldedMsgs.length + ' 条消息</span>';
  bar.onclick = function(){
    pauseChatFollow();
    var oldHeight=body.scrollHeight, oldTop=body.scrollTop;
    _foldHoldUntil = Date.now() + 60000;
    var tmp = document.createElement('div'); tmp.style.display = 'none';
    tmp.innerHTML = (_foldedMsgs || []).join('');
    _foldedMsgs = null;
    var firstMsg = body.querySelector('.msg');
    while(tmp.firstChild){ body.insertBefore(tmp.firstChild, firstMsg); }
    var b2 = document.getElementById('rtCondenseBar'); if(b2) b2.remove();
    body.scrollTop=oldTop+body.scrollHeight-oldHeight;
    _chatScroll.lastTop=body.scrollTop;
  };
  var firstMsg = body.querySelector('.msg');
  if(firstMsg) body.insertBefore(bar, firstMsg); else body.appendChild(bar);
}

/* ── 多端消息同步：轮询会话签名，另一窗口有新消息/流式进度时自动拉取渲染 ──
   后端 /api/sessions/:id/sync 返回几十字节签名（消息数+最后消息时间/长度/流式标记），
   变化才拉全量消息重渲染；本窗口自己流式或圆桌运行中跳过，防止打断本地实时 DOM。 */
var _syncSigCache = {};   // sid → 上次签名
var _syncTimer = null;
function startSessionSync(){
  if(_syncTimer) return;
  _syncTimer = setInterval(pollSessionSync, 4000);
  /* 状态条自愈：每 15 秒核对一次「条子还该不该亮」（别处取消的任务不会发终态事件）。
     挂在 session sync 启动处，保证只启一次；页面从后台回来时立刻补一次。 */
  if(!window.__genSweepTimer){
    window.__genSweepTimer = setInterval(function(){ if(!document.hidden) _genBarSweep(); }, 15000);
    document.addEventListener('visibilitychange', function(){ if(document.visibilityState==='visible') _genBarSweep(); });
  }
  document.addEventListener('visibilitychange', function(){ if(document.visibilityState==='visible') pollSessionSync(); });
  window.addEventListener('focus', pollSessionSync);
}
function pollSessionSync(){
  if(document.hidden) return;
  /* 渠道记录预览是只读的，别拿当前会话去覆盖它（原来是 panel-workspace 包一层拦） */
  if(_channelViewActive) return;
  var sid = currentSession;
  if(!sid) return;
  // 本窗口正在流式 / 圆桌运行中：DOM 已实时，跳过
  if(_tabStreaming[sid] || (_rtState && _rtState.active && _rtState.sessionId === sid)) return;
  fetch(apiUrl('/api/sessions/'+encodeURIComponent(sid)+'/sync'), { cache:'no-store', headers: monitorToken?{'X-Monitor-Token':monitorToken}:{} })
    .then(function(r){ return r.ok ? r.json() : null; })
    .then(function(d){
      if(!d || !d.sig) return;
      var prevSig = _syncSigCache[sid];
      if(prevSig === undefined){ _syncSigCache[sid] = d.sig; return; }  // 首次：只建基线不重渲染
      if(prevSig === d.sig) return;
      _syncSigCache[sid] = d.sig;
      var prevCount = parseInt(prevSig.split('|')[0], 10) || 0;
      var newCount = parseInt(d.sig.split('|')[0], 10) || 0;
      var prevLast = prevSig.split('|')[1] || '';
      var newLast = d.sig.split('|')[1] || '';
      // 幽灵修复：消息条数没变（仅最后一条内容/流式状态变化）→ 只增量更新最后一条 DOM，不全量重渲染（消灭横跳）
      if(newCount === prevCount){
        patchLastMessage(sid);
      } else {
        loadSessionMessages(sid, false, true);   // 拉最新消息，保持滚动位置
      }
      // 另一窗口刚发来新用户消息且回复尚未落盘 → 显示「正在回复」提示
      var body = document.getElementById('chatBody');
      if(body && newLast.indexOf('user:') === 0 && prevLast.indexOf('user:') !== 0){
        var tip = document.getElementById('rtRemoteTip');
        if(!tip){ tip = document.createElement('div'); tip.id='rtRemoteTip'; tip.className='system-tip'; body.appendChild(tip); }
        tip.textContent = '⏳ 另一窗口正在回复…';
        if(autoScrollActive()) followChatBottom();
      }
    })
    .catch(function(){});
}
function _savedPathToUrl(p){
  /* 历史消息里只存了「已保存到本机路径: /vol1/...」这种盘上路径，
     而聊天气泡要的是能被 nginx 直取的 URL。把 data 前缀剥掉即可：
     /vol1/@apphome/hermes-agent/data/uploads/files/x → /uploads/files/x（再补 BASE）。 */
  if(!p) return '';
  p = String(p).trim();
  if(/^\/vol1\/@apphome\/hermes-agent\/data\//.test(p)) p = p.replace('/vol1/@apphome/hermes-agent/data','');
  if(p.charAt(0) !== '/') return '';
  if(/^\/vol1\//.test(p)) return '';   // 其它卷的裸路径取不到，别给空播放器
  return p;
}
/* 同一条消息里同一张图出现多次时只留第一处（2026-11-13 用户报「表情重复在发送」）。
   实际成因是模型在不同位置贴了同一个文件，两次 alt 文案还不一样，肉眼看着就是同一张图发了两遍。
   比对前先解码 URI：同一文件常一处写成 /data/tmp/a.gif、另一处写成 %E7%89%B9... 编码形式，
   不归一的话会被当成两张。丢掉的只是重复的同一张图，不影响正文。 */
function dedupeMarkdownImages(text){
  if(!text || text.indexOf('![') < 0) return text;
  var seen = {};
  return text.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, function(all, alt, src){
    var key;
    try { key = decodeURIComponent(src); } catch(e){ key = src; }
    key = String(key).replace(/^https?:\/\/[^/]+/i, '');   // 换域名/端口视为同一张
    if(seen[key]) return '';
    seen[key] = 1;
    return all;
  });
}
function splitContent(content){
  if(typeof content === 'string') {
    var files=[], furls=[];
    var filePattern=/\n\n### 文件: ([^\n]+?) \[[^\]]+\]\n已保存到本机路径: ([^\n]+)\n你读取此文件并分析/g;
    var text=content.replace(filePattern,function(_,name,p){
      files.push(name.replace(/^\d+_[0-9a-f]{12}_/i,''));
      furls.push(_savedPathToUrl(p));
      return '';
    }).trimEnd();
    return { text:text, images:[], files:files, fileUrls:furls };
  }
  if(Array.isArray(content)){
    var text = '', images = [];
    content.forEach(function(p){
      if(!p) return;
      if(p.type === 'text' && p.text) text += (text ? '\n' : '') + p.text;
      else if(p.type === 'image_url' && p.image_url && p.image_url.url) images.push(p.image_url.url);
    });
    var parsed=splitContent(text);
    return { text:parsed.text, images:images, files:parsed.files||[], fileUrls:parsed.fileUrls||[] };
  }
  if(content && typeof content === 'object'){
    return { text: content.text || '', images: Array.isArray(content.images) ? content.images : [], files:Array.isArray(content.file_names)?content.file_names:[], fileUrls: Array.isArray(content.files)?content.files:[] };
  }
  return { text: '', images: [], files:[], fileUrls:[] };
}
function toggleCronLead(btn){
  var box = btn.closest('.msg.cron-lead');
  if(!box) return;
  var open = box.classList.toggle('open');
  btn.textContent = open ? '收起' : ('展开全部 ' + (box.querySelector('.cron-lead-body') ? box.querySelector('.cron-lead-body').innerText.length : '') + ' 字');
}
function _audioSrc(u){
  if(!u) return '';
  if(/^\/vol1\//.test(u)) u = _savedPathToUrl(u);
  if(!u) return '';
  if(/^data:|^blob:/i.test(u)) return u;
  /* 绝对地址但换了个域名（比如历史消息里存过的旧域名 /app/hermes-agent/...）
     在本机和外网都取不到 —— 同应用内的音频一律折回相对路径，跟着页面自己的 origin 走。 */
  if(/^https?:/i.test(u)){
    try{
      var abs = new URL(u, location.href);
      if(abs.origin !== location.origin && /^\/(app\/hermes-agent|uploads|tmp|data)\//.test(abs.pathname)){
        return abs.pathname + abs.search;
      }
    }catch(e){}
    return u;
  }
  if(/^\/app\//.test(u)) return u;
  return (typeof chatImgSrc === 'function') ? chatImgSrc(u) : u;
}
/* 附件 → 卡片内容：音频一律给带进度条的播放器，别再只丢一个文件名。
   用户的语音、助手的 TTS、历史消息里的附件块都走这一条。 */
function fileChipsHTML(names, urls){
  names = names || []; urls = urls || [];
  return names.map(function(name, i){
    var u = urls[i] || '';
    if(u && AUDIO_EXT_RE.test(u)) return voicePlayerHTML(u, name);
    return '<span class="chat-file-chip">📎 '+esc(name)+'</span>';
  }).join('');
}
/* MediaRecorder 录出来的 webm 头部没有时长，浏览器算出来是 Infinity：
   进度条就永远是空的、时间显示 ∞。经典做法——先 seek 到极大值把索引逼出来，再回到 0。 */
document.addEventListener('loadedmetadata', function(e){
  var au = e.target;
  if(!au || au.tagName !== 'AUDIO' || !au.classList.contains('voice-attach')) return;
  if(au._durFixed) return;
  if(au.duration === Infinity || isNaN(au.duration)){
    au._durFixed = true;
    try{ au.currentTime = 1e6; }catch(err){}
    var onUpd = function(){
      if(isFinite(au.duration) && au.duration > 0){
        au.removeEventListener('timeupdate', onUpd);
        try{ au.currentTime = 0; }catch(err){}
      }
    };
    au.addEventListener('timeupdate', onUpd);
  }
}, true);
/* ── 气泡内三层信息带（2026-11-12 用户第 32 条）────────────────────────
   ① 状态栏   = 现在进行时。live 事件驱动，这一轮结束就淡出。
   ② flag chip = 已经发生的事实，跟消息一起永久留着。
   ③ .chat-info = 真提示通道（连接中断/正在恢复），不被 transient 过滤吞掉。

   两种标记以前是「正文里的一行字」，所以永远挂在气泡最底下：
     · （执行已中断）              monitor.js:2546 / 8743 拼进回复正文
     · 📦 **本会话已自动压缩**…     conversation_loop.py:2232、6641 拼进正文
   现在渲染前把它们抽出来收成 chip，正文只留真正的内容。两类都算「已发生」，
   同归 chip 层；差别是压缩属于会话级、可能重复多次，所以带 ×N，原句放 title。 */
var SYS_MARKER_PATTERNS = [
  /* 逐字对齐服务端原文，别凭印象写 —— 压缩那条必须带「（更早对话已归档…」整段才算数，
     否则回复里聊到这句话也会被折成 chip。 */
  /* 只能整行独立命中：服务端是「正文 + \n\n + 标记」拼进回复的，真标记永远独占一行。
     2026-11-13 的误伤：回复正文里引用「（执行已中断）」解释这个 bug，被裸正则当场抽成
     chip，一条完整回复凭空挂上「已中断」。所以下面三条必须锚 ^…$（/m），
     跟压缩那两条一个标准。 */
  { type:'warn',  icon:'⚠', label:'执行已中断', hint:'这一轮回复被中断，正文可能不完整',
    re:/^[ \t]*[（(]执行已中断[）)][ \t]*$/gm },
  { type:'muted', icon:'⏹', label:'已中断', hint:'这一轮被中断，正文可能不完整',
    re:/^[ \t]*[（(]已中断[）)][ \t]*$/gm },
  { type:'muted', icon:'⏹', label:'已停止', hint:'这一轮由你手动停止',
    re:/^[ \t]*[（(]已停止[）)][ \t]*$/gm },
  /* panel-chat-recovery.js:59 落在正文里的那句「> *（这条回复在生成过程中被打断，内容不完整）*」
     —— 以前不带任何模式，正文留一行斜体、状态条再写一遍，同一条气泡两个「中断」。 */
  { type:'muted', icon:'⏹', label:'已中断', hint:'这一轮回复在生成过程中被打断，内容不完整',
    re:/^[ \t]*>?[ \t]*\*?[（(]这条回复在生成过程中被打断，内容不完整[）)][ \t]*\*?[ \t]*$/gm },
  { type:'info',  icon:'📦', label:'上下文已压缩', hint:'更早的对话已归档为摘要，会话可以继续',
    re:/^[ \t]*>?[ \t]*(?:📦[ \t]*)?\*\*本会话已自动压缩\*\*（更早对话已归档[^）\n]*）[ \t]*$/gm, count:true },
  { type:'info',  icon:'📦', label:'上下文已压缩', hint:'更早的对话已归档为摘要，会话可以继续',
    re:/^[ \t]*>?[ \t]*(?:📦[ \t]*)?本会话已自动压缩（更早对话已归档[^）\n]*）[ \t]*$/gm, count:true }
];
function splitSysMarkers(text){
  var out = { text: String(text==null ? '' : text), flags: [] };
  for(var i=0;i<SYS_MARKER_PATTERNS.length;i++){
    var p = SYS_MARKER_PATTERNS[i], n = 0;
    out.text = out.text.replace(p.re, function(){ n++; return ''; });
    if(!n) continue;
    var same = null;
    for(var j=0;j<out.flags.length;j++) if(out.flags[j].label===p.label) same = out.flags[j];
    if(same) same.count += n;
    else out.flags.push({ type:p.type, icon:p.icon, label:p.label, hint:p.hint, count: p.count?n:0 });
  }
  /* 抽掉标记后可能留下空行；正文内部的单个换行不动 */
  out.text = out.text.replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').replace(/^\s+|\s+$/g,'');
  return out;
}
/* 2026-11-13（用户第 43 条）：一轮是怎么结束的，只在一处说。
   以前「执行已中断」有两个来源各说一遍 —— 状态条读 queue_status，chip 读正文里那句
   （执行已中断）。同一条气泡上下两个一模一样的提示，纯重复。
   现在：结束状态一律由 .msg-statusbar 表达，chip 层只留「上下文已压缩」这种
   跟「这轮怎么结束」无关的事实。定性顺序：结构化字段优先，没有结构化信息才退回正文标记。 */
var TURN_END_LABELS = {'执行已中断':1, '已中断':1, '已停止':1};
function turnEndState(m, flags, rawText){
  if(!m || m.role !== 'assistant') return null;
  var qs = String(m.queue_status || ''), ec = String(m.error_code || '');
  var raw = String(rawText || '');
  var ms = Number(m.duration_ms || 0) || 0;
  /* 正文里服务端写的原因（「请求失败: xxx」/「本轮中断：xxx」）只用来定性，不回显整段 */
  var mm = raw.match(/(?:请求失败|本轮中断)[:：]\s*([^\n）)]{1,160})/);
  var reason = mm ? mm[1].trim() : '';
  var blob = (reason + ' ' + ec).toLowerCase();
  var recovered = /这条回复在生成过程中被打断|服务关闭|进程退出/.test(raw);
  if(qs === 'failed' || /^(provider_|network_|http_5|http_4)/.test(ec)){
    if(ec === 'provider_timeout' || /超时|timeout|timed out/.test(blob))
      return {icon:'⏱', label:'模型超时中断', alert:1, ms:ms, hint:reason || '上游模型长时间没有返回数据，这一轮被中断'};
    if(/余额|额度|欠费|不足|quota|insufficient|credit|402|payment|billing/.test(blob))
      return {icon:'💳', label:'模型额度不足', alert:1, ms:ms, hint:reason || '当前模型额度或余额不足，换模型或充值后重试'};
    if(/econn|enotfound|eai_again|refused|connect|fetch failed|network|socket|reset|网络|断网|连不上|不可达/.test(blob))
      return {icon:'🌐', label:'连接失败', alert:1, ms:ms, hint:reason || '请求没发出去或被断开，检查网络与代理后重试'};
    return {icon:'⚠', label:'本轮失败', alert:1, ms:ms, hint:reason || '这一轮没有正常跑完'};
  }
  if(qs === 'cancelled') return {icon:'⏹', label:'已取消', alert:0, ms:ms, hint:'这一轮在开始前被取消'};
  if(qs === 'interrupted'){
    if(recovered) return {icon:'⏹', label:'执行已中断', alert:1, ms:ms, hint:'服务重启或进程退出，这一轮没跑完'};
    return {icon:'⏹', label:'已停止', alert:1, ms:ms, hint:'这一轮被中途停止（你点了停止，或连接断开），正文可能不完整'};
  }
  if(qs === 'done') return ms ? {icon:'✅', label:'完成', alert:0, ms:ms} : null;
  /* 没有结构化状态：退回正文标记——只有它知道这轮断过 */
  for(var i=0;i<(flags||[]).length;i++){
    var f = flags[i];
    if(!TURN_END_LABELS[f.label]) continue;
    if(f.label === '已停止') return {icon:'⏹', label:'已停止', alert:1, ms:ms, hint:f.hint || '这一轮由你手动停止'};
    return {icon:'⏹', label:'执行已中断', alert:1, ms:ms, hint:f.hint || '这一轮回复被中断，正文可能不完整'};
  }
  return ms ? {icon:'✅', label:'完成', alert:0, ms:ms} : null;
}
function flagsInnerHTML(flags){
  if(!flags || !flags.length) return '';
  return flags.map(function(f){
    return '<span class="flag-chip '+f.type+'" title="'+DOM.escAttr(f.hint||'')+'">'+
      '<span class="fc-ico">'+f.icon+'</span>'+esc(f.label)+(f.count>1 ? ' ×'+f.count : '')+'</span>';
  }).join('');
}
function flagsHTML(flags){
  var inner = flagsInnerHTML(flags);
  return inner ? '<div class="msg-flags">' + inner + '</div>' : '';
}
function setBubbleFlags(root, flags){
  if(!root) return;
  var bub = root.querySelector('.msg-bubble') || root;
  var box = bub.querySelector('.msg-flags');
  var inner = flagsInnerHTML(flags);
  if(!box){
    if(!inner) return;
    /* 容器只建一次，内容单独填 —— flagsHTML 自带 .msg-flags 外壳，
       往容器里塞整块 HTML 会变成「容器套容器」，chip 重复计数（2026-11-13 实测）。 */
    bub.insertAdjacentHTML('beforeend', '<div class="msg-flags" hidden></div>');
    box = bub.querySelector('.msg-flags');
  }
  if(box.innerHTML !== inner) box.innerHTML = inner;
  box.hidden = !inner;
}
function _sbElapsed(start){
  var s = Math.max(0, Math.round((Date.now()-start)/1000));
  return s < 60 ? (s+'s') : (Math.floor(s/60)+'m'+(s%60)+'s');
}
/* 毫秒 → 人话耗时（历史气泡用；流式那条走 _sbElapsed 秒表） */
function fmtDurMs(ms){
  var s = Math.max(0, Math.round(Number(ms||0)/1000));
  return s < 60 ? (s+'s') : (Math.floor(s/60)+'m'+(s%60)+'s');
}
function _sbTickNow(bar){
  if(!bar || bar.hidden) return;
  var st = Number(bar.getAttribute('data-start')||0); if(!st) return;
  var t = bar.querySelector('.sb-time'); if(t) t.textContent = '🕒 '+_sbElapsed(st);
}
/* 状态条落位（2026-11-13 用户第 40 条）：气泡正文之下、工具调用之上。
   历史/流式/durable 三条渲染路径的模板都已按这个顺序拼节点，这里再兜一次——
   旧 DOM 或别处补插的状态条会被拎回去，不用各路径各改一遍。 */
function _sbPlace(root, bar){
  if(!root || !bar) return;
  /* 锚点必须和状态栏挂在同一个父节点下，否则 insertBefore 直接抛 NotFoundError。
     刷新页面后 root 是 .msg，而 .tool-calls 在 .msg-bubble 里面——两者不同父，
     以前一 insertBefore 就抛，异常被 renderTurn 外层的 try 吞掉，状态栏永远停在
     hidden 加空内容：表现就是「跑着的那条没有状态栏，结束了才看到一个完成」（2026-11-13 用户第 55 条）。 */
  /* anchor 可能埋在容器里面（流式路径的 .tool-calls 是 .durable-tools 的子节点），
     而状态栏必须挂在气泡这一层。挂在工具卡内部的话，patchToolBox 每次重建都把它
     连根删掉，要等下一次 setBubbleStatus 才插回来——中间那段状态栏是消失的，
     回来时 sbIn 又从头播一遍。用户看到的「消失又出现、气泡闪一下」就是这个
     （2026-11-14 实测：10550ms 被摘、13433ms 才插回）。 */
  var box = root.querySelector('.msg-bubble') || root;
  var anchor = box.querySelector('.tool-calls') || box.querySelector('.durable-tools')
            || box.querySelector('.chat-info') || box.querySelector('.msg-flags');
  var kid = anchor;
  while(kid && kid.parentNode !== box) kid = kid.parentNode || null;
  if(bar.parentNode !== box){ box.insertBefore(bar, kid); return; }
  if(kid && bar.nextElementSibling !== kid) box.insertBefore(bar, kid);
}
/* 状态栏：一个气泡只留一条，再调就是更新；不传 icon 时按 mode 取顶栏那套图标 */
/* 哪些状态不该走秒表：排队/等待态还没轮到，计时会骗人（2026-11-13 用户第 44 条：
   「队列里的消息怎么能上来就开始计时呢？明明都还没有轮到他」）。 */
var _SB_NOTIMED = { queued:1, pending:1, waiting:1, idle:1 };
/* 开始时间按 data-request-id 记一份：历史重绘会整片重建气泡 DOM，
   只靠 data-start 会被清零，于是「下一秒计时又从 0s 开始」。 */
function _sbStamp(root, bar, mode){
  var timed = !_SB_NOTIMED[mode];
  if(!timed){ bar.removeAttribute('data-start'); return false; }
  var k = ''; try{ k = root.getAttribute('data-request-id') || ''; }catch(e){}
  var m = (window._sbStarts = window._sbStarts || {});
  var s0 = bar.getAttribute('data-start') || (k && m[k] ? String(m[k]) : '');
  if(!s0) s0 = String(Date.now());
  bar.setAttribute('data-start', s0);
  if(k){ if(Object.keys(m).length > 400) window._sbStarts = m = {}; m[k] = Number(s0); }
  return true;
}
function setBubbleStatus(root, mode, text, icon){
  if(!root) return;
  var bar = root.querySelector('.msg-statusbar');
  if(!bar) return;
  _sbPlace(root, bar);
  var cls = 'msg-statusbar' + (mode==='alert' ? ' sb-alert' : (mode==='tool' ? ' sb-tool' : ''));
  if(bar.className !== cls) bar.className = cls;
  /* 新动作到了 → 撤销排队中的淡出。以前 clearBubbleStatus 的定时器没有撤销机制，
     190ms 后照样把刚写进去的新文案 hidden 掉，下一次事件再点亮 = 又闪一次。 */
  bar._sbGen = (bar._sbGen||0) + 1;
  if(bar.classList.contains('sb-out')) bar.classList.remove('sb-out');
  var wasHidden = bar.hidden;
  bar.hidden = false;
  /* 排队态不盖时间戳：轮到它开始跑（thinking/generating/tool）时才起表 */
  var _timed = _sbStamp(root, bar, mode);
  var _ico = icon || (typeof _ST_ICON!=='undefined' && _ST_ICON[mode]) || '💭';
  /* 原地改文本，不重建 innerHTML：动作一模一样也要重建的话，子节点全是新的，
     状态栏每次更新都在"换人"，字宽/省略号重算，重插还会连带重放 sbIn。 */
  var ic = bar.querySelector('.sb-icon'), tx = bar.querySelector('.sb-text'), tm = bar.querySelector('.sb-time');
  if(!ic || !tx || !tm){
    bar.innerHTML = '<span class="sb-icon"></span><span class="sb-text"></span><span class="sb-time"></span>';
    ic = bar.querySelector('.sb-icon'); tx = bar.querySelector('.sb-text'); tm = bar.querySelector('.sb-time');
  }
  if(ic.textContent !== _ico) ic.textContent = _ico;
  var _txt = String(text||'');
  if(tx.textContent !== _txt) tx.textContent = _txt;
  /* 进场动画只在"从隐到显"时放一次；文案更新不播，否则每次换动作都淡入一次 */
  if(wasHidden){ bar.classList.remove('sb-enter'); void bar.offsetWidth; bar.classList.add('sb-enter'); }
  if(_timed) _sbTickNow(bar);
}
function clearBubbleStatus(root, delay){
  if(!root) return;
  var bar = root.querySelector('.msg-statusbar');
  if(!bar || bar.hidden) return;
  /* 代次令牌：淡出过程中来了新动作，旧定时器必须自己作废。
     没有这道闸，clear(190ms) 与 set 相邻触发时会出现「新文案刚出来就被隐藏、
     下一个事件又点亮」的闪动（2026-11-14 实测量到 clear 后 5ms 又来一次 clear）。 */
  var gen = (bar._sbGen = (bar._sbGen||0) + 1);
  setTimeout(function(){
    if(gen !== bar._sbGen) return;
    if(!bar.isConnected || bar.hidden) return;
    bar.classList.add('sb-out');
    setTimeout(function(){
      if(gen !== bar._sbGen){ bar.classList.remove('sb-out'); return; }
      bar.hidden = true; bar.innerHTML = ''; bar.className = 'msg-statusbar';
      bar.removeAttribute('data-start');
      bar.classList.remove('sb-out');
    }, 190);
  }, delay==null ? 0 : delay);
}
/* 1s 心跳：一个工具跑很久、期间没有事件时，耗时也要继续走 */
if(!window._sbTickTimer){
  window._sbTickTimer = setInterval(function(){
    var list = document.querySelectorAll('.msg-statusbar:not([hidden])');
    for(var i=0;i<list.length;i++) _sbTickNow(list[i]);
  }, 1000);
}
function msgHTMLBase(m){
  var parts = splitContent(m.content);
  var text = parts.text, imgs = parts.images;
  /* 引用消息在服务端存的是一整段「【引用上下文】…【用户追问】…」。
     历史渲染时拆回「引用卡片 + 用户原话」，否则刷新后气泡里会把引用全文再复述一遍。 */
  var quoteHtmlHist = '';
  if(m.role === 'user' && text.indexOf('【引用上下文】') === 0){
    var _qi = text.indexOf('【用户追问】');
    if(_qi > 0){
      var _q = text.slice('【引用上下文】'.length, _qi).trim();
      var _a = text.slice(_qi + '【用户追问】'.length).trim();
      if(_q){ quoteHtmlHist = '<div class="quote-block"><div class="quote-label">引用</div>' + escapeHtml(_q) + '</div>'; text = _a; }
    }
  }
  var imgHtml = imgStackHTML(imgs);
  if(m.role === 'user'){
    var fileHtml = fileChipsHTML(parts.files, parts.fileUrls);
    /* 定时任务会话的第一条 user 消息是调度器注入的任务说明（2000+ 字），
       按普通气泡渲染就是整屏紫色、什么都看不见。折叠成灰色小字，点开才看全文。 */
    var _isCronLead = text.indexOf('[IMPORTANT: You are running as a scheduled cron job') === 0;
    if(_isCronLead){
      return '<div class="msg user cron-lead" data-content="'+DOM.escAttr(text).replace(/\"/g,'&quot;').replace(/\n/g,'&#10;')+'"><div class="chat-sender">调度器注入</div><div class="msg-bubble"><div class="cron-lead-body">'+escapeHtml(text).replace(/\n/g,'<br>')+'</div><button class="cron-lead-toggle" onclick="toggleCronLead(this)">展开全部 '+text.length+' 字</button></div><div class="msg-actions"><button class="msg-act-btn" onclick="copyMsg(this)" title="复制"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>复制</button></div><div class="msg-meta">定时任务注入 · '+fmtDateTime(m.ts||m.created_at||Date.now())+'</div></div>';
    }
    /* 2026-11-13：气泡必须带 request_id——跑马灯/呼吸灯/取消按钮全靠 data-request-id 定位，
       以前渲染时把它吞了，于是「排队中的那条」永远找不到自己的气泡。 */
    /* 2026-11-13：user 气泡以前不抽系统标记，压缩摘要尾部那行「📦 本会话已自动压缩」
       原样怼在正文里，chip 永远出不来（/compress 只能靠弹框提示，刷新即失忆）。
       现在和 assistant 同一条路：抽标记 → 弹 chip，正文只剩真内容。 */
    var _umk = splitSysMarkers(text), _uText = dedupeMarkdownImages(_umk.text);
    return '<div class="msg user"'+(m.request_id?' data-request-id="'+DOM.escAttr(m.request_id)+'"':'')+' data-content="'+DOM.escAttr(_uText).replace(/\"/g,'&quot;').replace(/\n/g,'&#10;')+'"><div class="chat-sender">你</div><div class="msg-bubble">'+quoteHtmlHist+escapeHtml(_uText).replace(/\n/g,'<br>')+imgHtml+(fileHtml?'<div class="chat-file-list">'+fileHtml+'</div>':'')+flagsHTML(_umk.flags)+'</div><div class="msg-actions"><button class="msg-act-btn" onclick="copyMsg(this)" title="复制"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 0-2-2V4a2 2 0 0 0 2-2h9a2 2 0 0 0 2 2v1"/></svg>复制</button><button class="msg-act-btn" onclick="quoteMsg(this)" title="引用回复"><svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>引用</button></div><div class="msg-meta">你 · '+fmtDateTime(m.ts||m.created_at||Date.now())+'</div></div>';
  }
  var aFileHtml = fileChipsHTML(parts.files, parts.fileUrls);
  /* 历史渲染走三层：标记抽成 chip，正文只剩真正的内容。
    结束状态（完成/中断/失败/超时/额度/连接）一律进状态条，中断类标记不再进 chip——见 turnEndState。 */
  var _mk = splitSysMarkers(text), _mkText = dedupeMarkdownImages(_mk.text);
  var _flags = _mk.flags.filter(function(f){ return !TURN_END_LABELS[f.label]; });
  /* 2026-11-13：刷新后气泡顶部原本什么都没有——流式那条状态条只在内存里，重载即失。
     现在把「怎么结束的 + 真实耗时」随消息一起渲染回来，时间来自落盘的 duration_ms。 */
  var _endState = turnEndState(m, _mk.flags, text);
  /* 早先这里是 toolsHtml 先算、_endState 后算，于是工具卡拿不到「这一轮被停了」这个事实，
     刷新后一律按 done 染绿。现在把结束态传下去，中断轮的卡才变橙。 */
  var toolsHtml = toolCallsHTML(m.tools, true, _endState ? _endState.label : '');
  /* 正文被中断吃掉、只剩执行记录时，这句不再单独占一行（2026-11-13 用户第 45 条）：
     气泡里上头写「已停止 🕒13s」、底下再写「这一轮没有产出正文（生成被中断），下面只剩执行记录」，
     两处说的是一件事。合并进状态条一句话说完。 */
  var _noBody = !_mkText && !!(toolsHtml || _flags.length);
  if(_noBody && _endState){
    _endState = Object.assign({}, _endState, {label: _endState.label + ' · 这一轮没有产出正文，下面只剩执行记录'});
  }
  var _sbHtml = '';
  if(_endState){
    var _dur = _endState.ms ? '<span class="sb-time">🕒 '+fmtDurMs(_endState.ms)+'</span>' : '';
    _sbHtml = '<div class="msg-statusbar sb-done'+(_endState.alert?' sb-alert':'')+'"'+
      (_endState.hint ? ' title="'+DOM.escAttr(_endState.hint)+'"' : '')+'>'+
      '<span class="sb-icon">'+_endState.icon+'</span>'+
      '<span class="sb-text">'+esc(_endState.label)+'</span>'+_dur+'</div>';
  }
  var msgText = esc(text).replace(/'/g,"\\'").replace(/\n/g,' ');
  var actionsHtml = '<div class="msg-actions">' +
    '<button class="msg-act-btn" onclick="copyMsg(this)" title="复制"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>复制</button>' +
    '<button class="msg-act-btn" onclick="speakMsg(this)" title="语音播放"><svg viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>播放</button>' +
    '<button class="msg-act-btn" onclick="quoteMsg(this)" title="引用回复"><svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>引用</button>' +
    '<button class="msg-act-btn" onclick="forkMsg(this)" title="Fork 新话题"><svg viewBox="0 0 24 24"><circle cx="12" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9v1a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V9"/><path d="M12 12v3"/></svg>Fork</button>' +
    '</div>';
  /* 正文被中断吃掉时别装哑巴（2026-11-13 用户第 33 条）：只剩一排工具卡的气泡，
     看起来就像「你说你干了，可我什么都没看到」。历史渲染能看到 tools/flags
     就说明这一轮真跑过东西，正文空就补一行说明，别让气泡变成空壳。 */
  var _emptyNote = '';
  if(_noBody && !_endState){
    _emptyNote = '<div class="msg-empty-note">这一轮没有产出正文（生成被中断），下面只剩执行记录。</div>';
  }
  /* 2026-11-13 修正：.msg-actions / .msg-meta 必须是 .msg 的直接子节点。
     panel-chat-avatar.css 用 grid 给四个子节点指派格子（bubble=row1 / meta=row2 / actions=row3），
     上一版把两者写进了 .msg-bubble 里，结果 grid-row 全落空、footer 被当成气泡正文的一部分，
     表现为「顺序不对、被包在气泡里面」。结构必须与 user 分支一致。 */
  return '<div class="msg assistant"'+(m.request_id?' data-request-id="'+DOM.escAttr(m.request_id)+'"':'')+' data-content="'+DOM.escAttr(_mkText).replace(/\n/g,'&#10;')+'"><div class="chat-sender">'+(m.sender||m.persona_name||chatSenderName())+'</div><div class="msg-bubble">'+renderMarkdown(_mkText)+_emptyNote+imgHtml+aFileHtml+_sbHtml+toolsHtml+flagsHTML(_flags)+'</div>'+actionsHtml+'<div class="msg-meta">'+(m.sender||m.persona_name||chatSenderName())+' · '+fmtDateTime(m.ts||m.created_at||Date.now())+'</div></div>';
}

/* 唯一入口。以前这里被 panel-workspace 用 window.msgHTML=... 整个替换掉，
   「谁最后加载谁赢」，改个气泡要翻三个文件才知道哪份在跑。
   现在固定成两步：本文件负责渲染，pwDecorateMsg 只做后处理（头像/身份/时间），
   拿不到就不挂，渲染照样出。 */
function msgHTML(m){
  var html = msgHTMLBase(m);
  if (typeof window.pwDecorateMsg === 'function') {
    try { html = window.pwDecorateMsg(html, m) || html; } catch (e) {}
  }
  return html;
}

/* ── 聊天图片：卡片式堆叠 + 灯箱大图（点击任意卡片查看，←/→ 上下页切换，Esc 关闭）── */
var _lbImgs = [], _lbIdx = 0;
function chatImgSrc(u){
  if(!u) return '';
  if(/^(https?:|data:|blob:)/i.test(u)) return u;
  return BASE + u; // 相对路径（/tmp /uploads /workspace /data）补 BASE 前缀
}
function imgStackHTML(imgs){
  if(!imgs || !imgs.length) return '';
  var list = imgs.map(chatImgSrc);
  var arg = esc(JSON.stringify(list));
  if(list.length === 1){
    return '<img src="'+DOM.escAttr(list[0])+'" alt="图片" loading="lazy" style="max-width:220px;max-height:220px;border-radius:var(--radius-md);display:block;margin-top:6px;cursor:zoom-in;object-fit:cover" onclick="openImgLightbox(\''+arg+'\',0)">';
  }
  var n = Math.min(list.length, 5);
  var off = 9;
  var html = '<div class="img-stack" style="width:'+(150+(n-1)*off)+'px;height:'+(150+(n-1)*off)+'px" onclick="openImgLightbox(\''+arg+'\',0)" title="点击查看 '+list.length+' 张图片">';
  for(var i=0;i<n;i++){
    html += '<img class="img-stack-item" src="'+DOM.escAttr(list[i])+'" alt="图片'+(i+1)+'" loading="lazy" style="left:'+(i*off)+'px;top:'+(i*off)+'px;z-index:'+(i+1)+'">';
  }
  html += '<span style="position:absolute;left:'+((n-1)*off+156)+'px;top:'+((n-1)*off+60)+'px;font-size:11px;color:var(--text);background:var(--accent);border-radius:12px;padding:3px 10px;font-weight:600;z-index:'+(n+1)+'">'+list.length+' 张 ▸</span></div>';
  return html;
}
function openImgLightbox(jsonList, idx){
  var arr = [];
  try { arr = JSON.parse(jsonList); } catch(e){ return; }
  if(!arr.length) return;
  _lbImgs = arr;
  _lbIdx = Math.max(0, Math.min(idx||0, arr.length-1));
  renderImgLightbox();
}
function renderImgLightbox(){
  var o = document.getElementById('imgLightbox');
  if(!o){
    o = document.createElement('div');
    o.id = 'imgLightbox';
    o.innerHTML = '<div class="lb-bg" onclick="closeImgLightbox()"></div>' +
      '<button class="lb-btn lb-close" onclick="closeImgLightbox()" title="关闭 (Esc)">✕</button>' +
      '<button class="lb-btn lb-prev" onclick="imgLbNav(-1)" title="上一张 (←)">‹</button>' +
      '<button class="lb-btn lb-next" onclick="imgLbNav(1)" title="下一张 (→)">›</button>' +
      '<div class="lb-count"></div>' +
      '<img class="lb-img" alt="大图预览">';
    document.body.appendChild(o);
  }
  o.querySelector('.lb-img').src = _lbImgs[_lbIdx];
  o.querySelector('.lb-count').textContent = (_lbIdx+1) + ' / ' + _lbImgs.length;
  o.style.display = 'flex';
  // 预载相邻图片，翻页不闪烁
  [1,-1].forEach(function(d){
    var i = _lbIdx + d;
    if(i>=0 && i<_lbImgs.length){ var im = new Image(); im.src = _lbImgs[i]; }
  });
}
function imgLbNav(d){
  if(!_lbImgs.length) return;
  _lbIdx = (_lbIdx + d + _lbImgs.length) % _lbImgs.length;
  renderImgLightbox();
}
function closeImgLightbox(){
  var o = document.getElementById('imgLightbox');
  if(o) o.style.display = 'none';
}
/* 消息内 Markdown 图片点击放大：复用 imgLightbox，同一条消息里的图可左右翻 */
document.addEventListener('click', function(e){
  var t = e.target;
  if(!t || t.tagName !== 'IMG') return;
  var bubble = t.closest && t.closest('.msg-bubble');
  if(!bubble) return;
  var imgs = Array.prototype.slice.call(bubble.querySelectorAll('img'));
  if(!imgs.length) return;
  var srcs = imgs.map(function(im){ return im.getAttribute('src'); });
  var idx = imgs.indexOf(t);
  openImgLightbox(JSON.stringify(srcs), idx < 0 ? 0 : idx);
});
document.addEventListener('keydown', function(e){
  var o = document.getElementById('imgLightbox');
  if(!o || o.style.display==='none') return;
  if(e.key==='Escape') closeImgLightbox();
  else if(e.key==='ArrowLeft'||e.key==='ArrowUp') imgLbNav(-1);
  else if(e.key==='ArrowRight'||e.key==='ArrowDown') imgLbNav(1);
});

/* 工具调用映射（对齐 Hermes 消息网关规范：terminal=💻 / web=🔍 / execute_code=🐍 等） */
var TOOL_EMOJI = {
  terminal: '💻', execute_code: '🐍', run_code: '🐍',
  read_file: '📄', write_file: '📝', edit_file: '✏️',
  search_files: '🔎', web: '🔍', web_search: '🔍', web_extract: '📄',
  delegate_task: '🤖', delegation: '🤖', session_search: '💬',
  browser: '🌐', image_gen: '🎨', file_ops: '📂', memory: '🧠',
  shell: '💻', bash: '💻', cmd: '💻',
};
var TOOL_NAME_ZH = {
  terminal: '终端命令', execute_code: '执行代码', run_code: '执行代码',
  read_file: '读取文件', write_file: '写入文件', edit_file: '编辑文件',
  search_files: '搜索文件', web: '网页搜索', web_search: '网页搜索', web_extract: '网页提取',
  delegate_task: '委派任务', delegation: '委派任务', session_search: '会话搜索',
  browser: '浏览器', image_gen: '图像生成', file_ops: '文件操作', memory: '记忆',
  shell: '终端命令', bash: '终端命令', cmd: '终端命令',
};
/* 工具类型 → 生成状态条（图标 mode / 文案）映射：对齐 hermes 0.20 全部内置工具
 * 规则按顺序匹配，先具体后宽泛；未知工具回退「正在调用 XX…」 */
var GEN_TOOL_STATES = [
  { re: /delegate_task|delegation|agent/i,            icon: 'agent',  text: '正在调用 Agent…' },
  { re: /execute_code|run_code|terminal|shell|bash|cmd|patch|python|jupyter|process|close_terminal|read_terminal|computer_use/i, icon: 'writing', text: '正在写代码…' },
  { re: /image_generate|image_gen/i,                  icon: 'image',  text: '正在生成图片…' },
  { re: /video_generate|video_edit|video_extend|flux/i, icon: 'video', text: '正在生成视频…' },
  { re: /vision_analyze|video_analyze|text_to_speech|tts|transcrib/i, icon: 'media', text: '正在处理媒体…' },
  { re: /web_search|^web$|search_files|session_search|search/i, icon: 'search', text: '正在搜索…' },
  { re: /web_extract|read_file|read_extract/i,        icon: 'extract', text: '正在读取内容…' },
  { re: /browser/i,                                   icon: 'browse', text: '正在浏览网页…' },
  { re: /write_file|edit_file|file_ops|file/i,        icon: 'file',   text: '正在处理文件…' },
  { re: /memory/i,                                    icon: 'memory', text: '正在读写记忆…' },
  { re: /skill/i,                                     icon: 'skill',  text: '正在调用技能…' },
  { re: /cronjob|todo|kanban/i,                       icon: 'task',   text: '正在处理任务…' },
  { re: /^ha_/i,                                      icon: 'home',   text: '正在控制设备…' },
  { re: /clarify/i,                                   icon: 'ask',    text: '正在向你确认…' },
  { re: /feishu|discord|react_to_message|send_message|remove_reaction|yuanbao|^yb_/i, icon: 'chat', text: '正在处理消息…' },
];
function genToolState(tool){
  var t = String(tool || '');
  for(var i=0;i<GEN_TOOL_STATES.length;i++){
    var m = GEN_TOOL_STATES[i];
    if(m.re.test(t)) return m;
  }
  return { icon:'tool', text:'正在调用 '+(TOOL_NAME_ZH[tool] || tool || '工具')+'…' };
}
function isToolDone(status){
  return status==='done'||status==='completed'||status==='finish'||status==='finished';
}

/* ── 折叠门面（2026-11-13 第 39 条）：真实实现已迁到 js/chat/toolcard.js
   ────────────────────────────────────────────────────────────────────────
   旧版在这里维护「盒子开着没 / 每张卡开着没」的一套私有状态，另在 document 上
   挂 capture 监听、durable 侧再存一份，一次点击被两次翻转抵掉 —— 用户实测
   「展开要点两下才能关闭」「三角小」。现在开合交给浏览器原生 <details>，
   这里只留旧调用点（compose.js / panel-durable.js）还能用的门面。 */
var ToolUI = (function(){
  function paint(box){ if(window.ToolCard) ToolCard.paint(box); }
  function paintAll(root){ if(window.ToolCard && root) ToolCard.paint(root); }
  function toggleBox(box){ if(box) box.open = !box.open; }
  function toggleCard(head){
    var box = head && head.parentNode;
    if(box && box.tagName==='DETAILS') box.open = !box.open;
  }
  function forget(){}
  function defaultClosed(box){
    if(!box || !window.ToolCard) return;
    var k = box.getAttribute && box.getAttribute('data-box');
    if(k && ToolCard.state.box[k]===undefined) box.open = false;
  }
  return { paint:paint, paintAll:paintAll, toggleBox:toggleBox, toggleCard:toggleCard, forget:forget, defaultClosed:defaultClosed };
})();
window.ToolUI = ToolUI;

function toolCardHTML(tp, hist){
  /* 2026-11-13 第 39 条：markup 全部迁到 js/chat/toolcard.js（原生 <details>），
     这里只做转发，「历史」与「流式」从此共用一份实现。 */
  return (window.ToolCard ? ToolCard.cardHTML(tp, hist) : '');
}
function toolCallsHTML(tools, hist, turn){
  if(!tools || !tools.length) return '';
  if(window.panelToolsMode && panelToolsMode()==='hidden') return '';   // 设置：隐藏工具调用区
  return (window.ToolCard ? ToolCard.groupHTML(tools, hist, null, turn) : '');
}
function toggleToolCalls(box){ if(window.ToolUI) ToolUI.toggleBox(box); }
/* 单张工具卡的开关（2026-11-13 重写）
   以前这里既写 class 又写 data-user-collapse，body 上还有一个 capture 监听也在写，
   durable 侧再存一份 open Set —— 三处各记一份，谁后写谁赢。
   现在只调 ToolUI：状态挂在盒子上，paint 是唯一出口。 */
function toolHeadToggle(head){ if(window.ToolUI) ToolUI.toggleCard(head); }
window.toolHeadToggle = toolHeadToggle;
/* 回到底部按钮（Issue #10） */
function copyMsg(btn){
  var msg = btn.closest('.msg');
  if(!msg) return;
  var text = msg.getAttribute('data-content') || msg.textContent || '';
  text = text.replace(/&#10;/g,'\n').replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/<br\s*\/?>/gi,'\n');
  function done(){ var old=btn.innerHTML; btn.innerHTML='✓'; setTimeout(function(){ btn.innerHTML=old; }, 1200); }
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(done).catch(function(){
      try{ var ta=document.createElement('textarea'); ta.value=text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); done(); }catch(e){}
    });
  } else {
    try{ var ta=document.createElement('textarea'); ta.value=text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); done(); }catch(e){}
  }
}
/* ── 滚动跟随：唯一判据「现在是不是贴着底部」（2026-11-13 第 39 条整体重写）
   ─────────────────────────────────────────────────────────────────────────
   用户原话：只有滚动到底部才触发自动跟随；消息已经停止、没有变化，不该自己跳。

   旧实现违反这条：它维护 inputAt 时间窗、downSince 像素阈值、suppressUntil 抑制窗口，
   还在 MutationObserver 里监听 class/style 变化 —— 于是「点开一张工具卡」这种不改文字、
   只改属性的动作也会触发 followChatBottom()，画面被拽到底部，用户看到的就是
   「消息明明静止，自己往下跳」。

   新逻辑只有一条式子：
     _follow ← 用户最后一次滚动之后，是否还有 ≤8px 就到底
     内容长高时 _follow 为真才跟，否则一个像素都不动；属性变化一律不跟。
   scroll 事件每次都按几何位置重算 _follow，所以程序自己拉到底部不会误判成「用户意图」：
   拉完就在底部 → _follow 自然还是 true。没有必要再设抑制窗口。 */
var _follow = true;
var _chatScroll = { body:null, lastTop:0, frame:0 };
function autoScrollActive(){ return _follow; }
function chatAtBottom(body){ return body.scrollHeight - body.clientHeight - body.scrollTop <= 8; }
function hideScrollBtn(){ var b=document.getElementById('chatJumpBottom'); if(b) b.hidden=true; }
function positionChatJump(){
  var body=_chatScroll.body, button=document.getElementById('chatJumpBottom');
  if(!body || !button) return;
  button.style.top=(body.offsetTop + body.clientHeight - 52)+'px';
}
function showScrollBtn(){
  var body=_chatScroll.body, b=document.getElementById('chatJumpBottom');
  if(!body || !b) return;
  positionChatJump(); b.hidden=false;
}
function followChatBottom(){
  var body=document.getElementById('chatBody');
  if(!body || !_follow) return;
  body.scrollTop=body.scrollHeight;
  _chatScroll.lastTop=body.scrollTop;
  hideScrollBtn();
}
function scheduleChatFollow(){
  if(_chatScroll.frame) return;
  _chatScroll.frame=requestAnimationFrame(function(){
    _chatScroll.frame=0;
    positionChatJump();
    followChatBottom();
  });
}
function scrollChatToBottom(){
  _follow=true;
  followChatBottom();
}
function pauseChatFollow(){ _follow=false; }
function initChatScroll(){
  var body=document.getElementById('chatBody');
  if(!body || _chatScroll.body===body) return;
  _chatScroll.body=body;
  _chatScroll.lastTop=body.scrollTop;
  _follow=chatAtBottom(body);
  /* 唯一的「用户意图」来源：主容器自己的 scroll 事件。内层滚动（工具结果、代码块）
     的 scroll 不会冒泡到 body 的 target 判定里，因此天然不影响跟随。 */
  body.addEventListener('scroll',function(e){
    if(e.target!==body) return;
    _chatScroll.lastTop=body.scrollTop;
    var at=chatAtBottom(body);
    _follow=at;
    if(at) hideScrollBtn(); else showScrollBtn();
  },{passive:true});
  /* 只有「内容真的长出来」才跟：流式追加的文字、新挂上去的节点。
     展开一张工具卡改的是几何、不是内容，但 ResizeObserver 分不出来，
     于是你点开的那张卡被自己撑高的 199px 顶出视口 —— 你看到的「闪一下」就是它。
     （2026-11-13 第 41 条实测：贴底 scrollTop 2014 → 点开 → 2213，卡顶 -1670 → -1869。）
     所以 ResizeObserver 整个删掉，跟随只看 childList 的新增节点与 characterData。 */
  new MutationObserver(function(records){
    for(var i=0;i<records.length;i++){
      var r=records[i];
      if(r.type==='characterData'){ scheduleChatFollow(); return; }
      if(r.addedNodes && r.addedNodes.length){ scheduleChatFollow(); return; }
    }
  }).observe(body,{childList:true,subtree:true,characterData:true});
  body.addEventListener('load',scheduleChatFollow,true);
  window.addEventListener('resize',scheduleChatFollow);
  scheduleChatFollow();
}

/* ── 侧边栏搜索过滤：按关键词实时过滤专家分组与会话（不重建 DOM，仅显隐）── */
function filterRail(kw){
  kw = (kw||'').trim().toLowerCase();
  var rail = document.getElementById('railScroll');
  if(!rail) return;
  if(!kw){
    rail.querySelectorAll('.agent-group').forEach(function(g){ g.style.display=''; });
    rail.querySelectorAll('.session-item').forEach(function(s){ s.style.display=''; });
    rail.querySelectorAll('.rail-divider').forEach(function(d){ d.style.display=''; });
    return;
  }
  var any = false;
  rail.querySelectorAll('.agent-group').forEach(function(g){
    var nameEl = g.querySelector('.agent-row .name');
    var groupMatch = nameEl && nameEl.textContent && nameEl.textContent.toLowerCase().indexOf(kw) >= 0;
    var sessMatch = false;
    g.querySelectorAll('.session-item').forEach(function(s){
      var t = ((s.querySelector('.title')||{}).textContent || '') + ' ' + ((s.querySelector('.sess-preview')||{}).textContent || '') + ' ' + ((s.querySelector('.sess-time')||{}).textContent || '');
      var m = t.toLowerCase().indexOf(kw) >= 0;
      s.style.display = m ? '' : 'none';
      if(m) sessMatch = true;
    });
    g.style.display = (groupMatch || sessMatch) ? '' : 'none';
    if(g.style.display !== 'none') any = true;
  });
  rail.querySelectorAll('.rail-divider').forEach(function(d){ d.style.display = any ? '' : 'none'; });
}

/* ── 会话切换单层收口 ────────────────────────────────────────────────
   渠道记录预览态是 panel-workspace 的功能，它以前用 window.switchTab=…
   /window.openTab=… /window.newTab=… 三个覆盖去拦，加上 sendRaw 共四处。
   覆盖谁后加载谁赢，排查时得先数加载顺序。
   现在基础实现改成 *Core，这里只留一层外壳，接口是 window.chatChannel：
   { active, leave(), afterSwitch(id) }。没有这个对象时行为与原来完全一致。 */
function switchTab(sid){
  var ch = window.chatChannel, was = ch ? !!ch.active : false;
  if (ch) ch.leave();
  var r = switchTabCore(sid);
  if (was && ch) ch.afterSwitch(sid);
  return r;
}
function openTab(sid){
  var ch = window.chatChannel, was = ch ? !!ch.active : false;
  if (ch) ch.leave();
  var r = openTabCore(sid);
  if (was && ch) ch.afterSwitch(sid);
  return r;
}
function newTab(){
  var ch = window.chatChannel;
  if (ch) ch.leave();
  return newTabCore();
}
