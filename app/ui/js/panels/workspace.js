/* 工作区面板 + 文件管理器
 * 来源：index.html 内联 app.js 第 2092-2196 行（共 105 行）
 * 2026-11-13 按原分区纯搬运外移，逻辑零改动。全局作用域与执行顺序与原内联块一致。 */

/* ============================ 工作区面板 ============================ */
function toggleWorkspace(){
  var panel=document.getElementById('workspacePanel');
  if(!panel) return;
  panel.classList.toggle('open');
  var btn=document.getElementById('wsPanelToggle');
  if(btn) btn.classList.toggle('active', panel.classList.contains('open'));
  if(panel.classList.contains('open')){
    var activeTab=panel.querySelector('.ws-tab.active');
    if(activeTab && activeTab.textContent.includes('文件')) fmRefresh();
    else if(activeTab && activeTab.textContent.includes('大纲')) loadOutline();
  }
}
function wsSwitchTab(btn, key){
  document.querySelectorAll('.ws-tab').forEach(function(t){ t.classList.remove('active'); });
  btn.classList.add('active');
  document.querySelectorAll('.ws-pane').forEach(function(p){ p.classList.remove('active'); });
  var pane=document.getElementById('ws-'+key); if(pane) pane.classList.add('active');
  if(key==='files') fmRefresh();
  if(key==='outline') loadOutline();
}

/* ── 会话大纲 + 记忆面板（右侧工作区）──
   拉取当前会话全部消息，提取用户问题为大纲要点；点击要点滚动定位到聊天区对应消息。
   记忆区展示当前 MEMORY/USER 摘要（截断预览）。 */
function loadOutline(){
  var wrap = document.getElementById('wsOutlineContent');
  if(!wrap) return;
  var sid = currentSession;
  if(!sid){ wrap.innerHTML = '<div class="empty-state">暂无会话</div>'; return; }
  wrap.innerHTML = '<div class="empty-state" style="opacity:.6">加载大纲…</div>';
  return fetch(apiUrl('/api/sessions/'+encodeURIComponent(sid)), { cache:'no-store', headers: monitorToken?{'X-Monitor-Token':monitorToken}:{} })
    .then(function(r){ return r.ok ? r.json() : null; })
    .then(function(s){
      var msgs = (s && s.messages) || [];
      if(!msgs.length){ wrap.innerHTML = '<div class="empty-state">发送消息后自动生成大纲</div>'; return; }
      var html = '';
      var uMsgs = msgs.filter(function(m){ return m.role==='user'; });
      var aMsgs = msgs.filter(function(m){ return m.role==='assistant'; });
      var toolN = 0;
      msgs.forEach(function(m){ if(m.tools && m.tools.length) toolN += m.tools.length; });
      html += '<div class="ws-outline-summary" style="padding:10px 4px 8px;border-bottom:1px solid var(--border);margin-bottom:8px;font-size:12px;color:var(--text3);line-height:1.7">' +
        '<div>💬 用户提问 <b>'+uMsgs.length+'</b> 条 · 回复 <b>'+aMsgs.length+'</b> 条 · 工具调用 <b>'+toolN+'</b> 次</div></div>';
      var idx = 0;
      msgs.forEach(function(m){
        if(m.role !== 'user') return;
        var text = '';
        if(typeof m.content === 'string') text = m.content;
        else if(Array.isArray(m.content)) text = m.content.map(function(p){ return (p&&p.text)||''; }).join(' ');
        text = (text||'').replace(/\s+/g,' ').trim();
        if(!text) return;
        var title = text.length > 48 ? text.slice(0,48)+'…' : text;
        var ts = fmtDateTime(m.ts||m.created_at||Date.now());
        html += '<div class="ws-outline-item" data-msgidx="'+idx+'" style="padding:7px 8px;border-radius:var(--radius-sm);cursor:pointer;font-size:12px;line-height:1.55;color:var(--text2);border-left:2px solid transparent;margin-bottom:2px" onclick="outlineJump(this)">' +
          '<div style="color:var(--text)">'+esc(title)+'</div>' +
          '<div style="font-size:11px;color:var(--text3);margin-top:2px">'+ts+'</div></div>';
        idx++;
      });
      html += '<div class="ws-section-title" style="margin-top:14px;padding-top:10px;border-top:1px solid var(--border);font-size:11px;color:var(--muted);letter-spacing:1px">记忆 MEMORY</div>';
      html += '<div id="wsOutlineMemory" style="padding:6px 4px;font-size:11px;color:var(--text3);line-height:1.6;white-space:pre-wrap">加载中…</div>';
      wrap.innerHTML = html;
      try{
        apiGet('/api/memory?profile='+encodeURIComponent(_activeProfileId())).then(function(res){
          var memEl = document.getElementById('wsOutlineMemory');
          if(!memEl) return;
          if(!res || !res.ok){ memEl.textContent = '记忆不可用'; return; }
          var mem = (res.memory||'').trim();
          var usr = (res.soul||'').trim();
          var parts = [];
          if(mem) parts.push('MEMORY: ' + mem.slice(0,400) + (mem.length>400?'…':''));
          if(usr) parts.push('USER: ' + usr.slice(0,200) + (usr.length>200?'…':''));
          memEl.textContent = parts.length ? parts.join('\n\n') : '（暂无记忆内容）';
        }).catch(function(){ var m=document.getElementById('wsOutlineMemory'); if(m) m.textContent='记忆加载失败'; });
      }catch(e){}
    })
    .catch(function(){ wrap.innerHTML = '<div class="empty-state">大纲加载失败</div>'; });
}
/* 大纲要点点击 → 滚动到聊天区对应消息 */
function outlineJump(item){
  var idx = parseInt(item.getAttribute('data-msgidx')||'0', 10);
  var body = document.getElementById('chatBody');
  if(!body) return;
  var targets = body.querySelectorAll('.msg.user');
  var el = targets[idx];
  if(!el){ toast('未找到对应消息'); return; }
  pauseChatFollow();
  el.scrollIntoView({ behavior:'smooth', block:'center' });
  el.style.outline = '2px solid var(--accent)';
  setTimeout(function(){ el.style.outline = ''; }, 1500);
}

/* ============================ 文件管理器 ============================ */
var _fmCwd = '';
var _fmEditPath = '';
// 文件列表、编辑与版本恢复由 panel-files-ui.js 提供。
function fmAttachPath(path){
  var name=path.split('/').pop()||'file';
  // 以 /api/download?path= 形式引用，后端 normalizeMessage 时解析回真实路径，Agent 可直接读取分析
  _pendingAttachments.push({ url:'/api/download?path='+encodeURIComponent(path)+'&name='+encodeURIComponent(name), type:'application/octet-stream', name:name });
  toast('📎 已附加到对话：'+name);
  renderAttachChips();
  autoResize(document.getElementById('chatInput'));
}
function fmAttach(){ fmAttachPath(_fmEditPath); }