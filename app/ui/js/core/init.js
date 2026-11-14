/* 设置页、初始化、飞牛桌面会话保活
 * 来源：index.html 内联 app.js 第 8699-9069 行（共 371 行）
 * 2026-11-13 按原分区纯搬运外移，逻辑零改动。全局作用域与执行顺序与原内联块一致。 */
/* ============================ 设置页 ============================ */
function renderSettings(){ if(window.renderPanelSettings)renderPanelSettings(); }

/* ============================ 初始化 ============================ */
document.addEventListener('click', function(e){
  /* 弹窗内部按钮常有「点完就 innerHTML 重渲染」的：那一刻 e.target 已脱离文档，
     popup.contains() 会返回 false，把刚刷新的二级列表当成「点了外面」直接关掉。
     典型：/model 点来源卡片 → 二级模型列表一闪就没（2026-11-11 用户报的选不了模型）。 */
  if(!e.target || !e.target.isConnected) return;
  if(popup && !popup.contains(e.target) && !(e.target.closest && e.target.closest('.tool-btn'))) closeMini(false);
});

/* ============================ 飞牛桌面会话保活 ============================ */
// Hermes 以同源 iframe 嵌入飞牛（fnOS）桌面（经 fnOS gateway 反向代理，带 BASE_PATH 前缀）。
// 用户在 iframe 内的鼠标/键盘操作不会冒泡到飞牛顶层文档的活动监听器，飞牛空闲计时器
// 会误判为「无操作」，超时后把整个桌面登出（弹「您已被登出」）。
// 这里在嵌入环境下周期性向顶层文档派发合成 mousemove 事件，重置飞牛空闲计时器，
// 恢复「打开 Hermes 聊天界面期间飞牛不被登出」的旧版行为。独立端口（顶层窗口）访问时自动跳过。
function setupFnosKeepAlive(){
  try {
    if(window.self === window.top) return;            // 独立窗口访问，无需保活
    var topWin = window.top;
    var topDoc = topWin && topWin.document;
    if(!topDoc) return;
    try { void topDoc.body; } catch(e){ return; }     // 跨域（不同源）无法访问顶层文档，跳过
    // 向顶层文档/窗口派发「无害活动事件」（mousemove/pointermove），重置飞牛桌面空闲计时器。
    // 只用鼠标移动类事件，避免 keydown/wheel 误触飞牛快捷键或滚动桌面。
    var fire = function(){
      try {
        if(document.hidden) return;                   // 切到其他飞牛应用时停止保活，交还飞牛空闲计时
        ['mousemove','pointermove'].forEach(function(t){
          try { topDoc.dispatchEvent(new topWin.MouseEvent(t, { bubbles:true, cancelable:true, view:topWin })); } catch(e){}
          try { topWin.dispatchEvent(new topWin.MouseEvent(t, { bubbles:true, cancelable:true, view:topWin })); } catch(e){}
        });
      } catch(e){}
    };
    setInterval(fire, 30000);                         // 周期保活，远短于飞牛空闲超时
    setTimeout(fire, 1500);                           // 载入后先打一次，避免首分钟内被判定空闲
    // 用户在 iframe 内真实操作鼠标时，同步向顶层文档转发活动事件，使活跃期间持续重置飞牛空闲计时。
    ['mousemove','pointermove','mousedown'].forEach(function(t){
      try {
        document.addEventListener(t, function(){
          try { if(!document.hidden) topDoc.dispatchEvent(new topWin.MouseEvent(t, { bubbles:true, cancelable:true, view:topWin })); } catch(e){}
        }, { passive:true, capture:true });
      } catch(e){}
    });
  } catch(e){}
}

document.addEventListener('DOMContentLoaded', function(){
  BASE = _resolveBase();
  setTheme(localStorage.getItem('fnos-theme-mode')||'dark');
  renderWebNet();   // 恢复联网开关状态（默认开）
  setupFnosKeepAlive();
  var inp=document.getElementById('chatInput');
  if(inp){ inp.addEventListener('input', function(){ autoResize(this); }); autoResize(inp);
    inp.addEventListener('focus', function(){ setTimeout(function(){ try{ inp.scrollIntoView({block:'nearest'}); }catch(e){} }, 320); });
  }
  switchPage(pageFromHash());
  // URL 直达：/files 打开工作区面板（文件功能在工作区）
  if(/\/files\/?(\?|$)/.test(location.hash) || /^\/files\/?(\?|$)/.test(location.pathname)){ try{ setTimeout(toggleWorkspace, 600); }catch(e){} }
  // 恢复菜单栏/会话树折叠状态（两级折叠持久化）
  try { var _rs = parseInt(localStorage.getItem('fnos-rail-state')||'0',10); _railState = (_rs===1||_rs===2)?_rs:0; } catch(e){ _railState = 0; }
  applyRailState();
  // 专家库改为按需懒加载：进入「扩展→专家库/专家团」或打开专家胶囊时由 ensurePersonasLibrary 注入（版本号缓存键，不再启动即下载 3.4MB）
  window.__personasOpenMini = function(){
    if(activePanel==='expert'){ var b=document.getElementById('btnExpert'); if(b){ closeMini(); openMini(b,'expert'); } }
    var ec=document.getElementById('expCount'); if(ec) ec.textContent='共 '+expertsList().length+' 位专家';
  };
  // 拉取 token 后加载所有真实数据
  fetchToken().then(function(){
    // 并行发起：profiles / 通道会话不依赖 _cfg，与 loadConfig 同时进行，避免串行请求链拖慢首屏
    fetchProfiles();  // 初始化加载 profiles（智能体/角色）
    fetchChannelSessions();  // 初始化加载通道会话（微信等）
    setInterval(fetchChannelSessions, 30000);  // 每30秒刷新通道会话
    startSessionSync();  // 多窗口消息同步：轮询会话签名，远端变化自动拉取渲染
    loadConfig().then(function(){
      renderProviders();
      renderExtensions();
      renderConnectors();
      renderChannels();
      renderWorkflowBar();
      renderTeamBar();
      // 恢复上次选择的模型按钮状态（per-session）
      var _initModel = _getSessionModel();
      if(_initModel){
        var mName = (typeof _initModel==='object'&&_initModel.model) ? _initModel.model : _initModel;
        var bm=document.getElementById('btnModel');
        if(bm){
          bm.setAttribute('data-tip','本会话模型：'+mName+'（点击更换）'); bm.classList.add('active');
          var badge=document.createElement('span');
          badge.className='model-badge';
          badge.textContent=mName.length>8?mName.slice(0,8)+'…':mName;
          bm.appendChild(badge);
        }
      }
      // 必须在配置（含 agents 分组与 session→分组映射）恢复之后再加载会话并渲染侧栏，
      // 否则 loadSessions 的 renderRail 会先用空映射把所有会话归入「默认主力助手」分组
      loadSessions();
    }).catch(function(){ loadSessions(); });
    renderOverview();
    tickStatus();
    setInterval(tickStatus, 3000);   // 轻量周期轮询：状态变化（重启/启动/停止后）自动反映，无需阻塞等待
  }).catch(function(){
    toast('无法连接后端，已进入本地预览（数据不可用）。');
    renderRail();
  });
  initChatScroll();
});

/* ───────────── v0.25 融合：群聊房间 + MBTI（Octop/CowAgent 理念，全部以 Hermes 为底子） ───────────── */

/* ── MBTI 16 人格（Octop 亮点融合，注入专家库） ── */
var MBTI_PERSONAS=[
  {id:"mbti_intj",type:"INTJ",label:"建筑师",emoji:"🧠",desc:"独立自主的战略思想家，擅长长期规划与系统性架构",prompt:"你是 INTJ「建筑师」人格。特点：理性、独立、战略性强，擅长长期规划与复杂系统架构。沟通直接、注重效率，讨厌空谈，习惯用框架拆解问题。请以建筑师人格回应。"},
  {id:"mbti_intp",type:"INTP",label:"逻辑学家",emoji:"🔬",desc:"求知欲旺盛的发明家，热衷分析、理论与创新",prompt:"你是 INTP「逻辑学家」人格。特点：求知欲强、思维发散、热爱理论与创新，善于发现系统中的矛盾与漏洞。表达偏冷静分析，喜欢探讨可能性。请以逻辑学家人格回应。"},
  {id:"mbti_entj",type:"ENTJ",label:"指挥官",emoji:"👑",desc:"天生的领导者，果断高效，擅长组织与执行",prompt:"你是 ENTJ「指挥官」人格。特点：目标导向、果断自信、天然领袖气质，善于组织资源推动执行。沟通强势直接，关注结果与效率。请以指挥官人格回应。"},
  {id:"mbti_entp",type:"ENTP",label:"辩论家",emoji:"⚡",desc:"机敏的思想者，热爱挑战常规与智力交锋",prompt:"你是 ENTP「辩论家」人格。特点：机智敏捷、热爱辩论与头脑风暴，善于提出反直觉的洞见，享受挑战常规。请以辩论家人格回应。"},
  {id:"mbti_infj",type:"INFJ",label:"提倡者",emoji:"🕊️",desc:"安静而富有洞察力的理想主义者",prompt:"你是 INFJ「提倡者」人格。特点：安静深沉、富有洞察力与同理心，坚持原则与理想，善于倾听并给出富有远见的建议。请以提倡者人格回应。"},
  {id:"mbti_infp",type:"INFP",label:"调停者",emoji:"🌱",desc:"理想主义诗人，重视价值观与内心真实",prompt:"你是 INFP「调停者」人格。特点：理想主义、敏感细腻，重视价值观与真实性，表达温和富有诗意。请以调停者人格回应。"},
  {id:"mbti_enfj",type:"ENFJ",label:"主人公",emoji:"🌟",desc:"富有感召力的导师型领导者",prompt:"你是 ENFJ「主人公」人格。特点：热情、有号召力、善于激励他人，天生导师气质，关注他人成长。请以主人公人格回应。"},
  {id:"mbti_enfp",type:"ENFP",label:"竞选者",emoji:"🎈",desc:"热情洋溢的探索者，充满创意与活力",prompt:"你是 ENFP「竞选者」人格。特点：热情开朗、创意无限、好奇心强，善于点燃他人热情，思维跳跃而富有感染力。请以竞选者人格回应。"},
  {id:"mbti_istj",type:"ISTJ",label:"物流师",emoji:"📋",desc:"务实可靠的事实核查者，注重秩序与责任",prompt:"你是 ISTJ「物流师」人格。特点：务实、可靠、重秩序，讲求事实与流程，责任感强。表达严谨、按部就班。请以物流师人格回应。"},
  {id:"mbti_isfj",type:"ISFJ",label:"守卫者",emoji:"🛡️",desc:"温暖尽责的守护者，默默付出",prompt:"你是 ISFJ「守卫者」人格。特点：温暖、尽责、注重细节，默默支持他人，重视稳定与和谐。请以守卫者人格回应。"},
  {id:"mbti_estj",type:"ESTJ",label:"总经理",emoji:"🏢",desc:"高效务实的管理者，重视规则与秩序",prompt:"你是 ESTJ「总经理」人格。特点：高效务实、重视规则与秩序，天生的管理者，强调执行与纪律。请以总经理人格回应。"},
  {id:"mbti_esfj",type:"ESFJ",label:"执政官",emoji:"🤝",desc:"热心友善的社区组织者",prompt:"你是 ESFJ「执政官」人格。特点：热心、友善、善于组织，重视人际关系与和谐氛围，乐于助人。请以执政官人格回应。"},
  {id:"mbti_istp",type:"ISTP",label:"鉴赏家",emoji:"🔧",desc:"冷静机敏的实践者，动手能力极强",prompt:"你是 ISTP「鉴赏家」人格。特点：冷静、机敏、动手能力强，喜欢探索事物运作原理，独立务实。请以鉴赏家人格回应。"},
  {id:"mbti_isfp",type:"ISFP",label:"探险家",emoji:"🎨",desc:"随性自由的艺术家，感受当下美好",prompt:"你是 ISFP「探险家」人格。特点：随性、自由、富有艺术气质，注重当下体验与美感，低调而真诚。请以探险家人格回应。"},
  {id:"mbti_estp",type:"ESTP",label:"企业家",emoji:"🚀",desc:"精力充沛的行动派，临场应变大师",prompt:"你是 ESTP「企业家」人格。特点：精力充沛、行动力强、临场应变出色，喜欢冒险与实战。请以企业家人格回应。"},
  {id:"mbti_esfp",type:"ESFP",label:"表演者",emoji:"🎭",desc:"热情外向的表演者，把快乐带给所有人",prompt:"你是 ESFP「表演者」人格。特点：热情外向、感染力强、享受当下，擅长营造轻松氛围。请以表演者人格回应。"}
];
function mbtiInject(){
  try{
    if(!window.AGENCY_PERSONAS || !window.AGENCY_PERSONAS.length) return;
    if(window.AGENCY_PERSONAS.some(function(x){ return x.id==='mbti_intj'; })) return;
    MBTI_PERSONAS.forEach(function(x){
      AGENCY_PERSONAS.push({ id:x.id, dept:'mbti', dept_label:'MBTI 人格', emoji:x.emoji, label:x.type+' · '+x.label, desc:x.desc, prompt:x.prompt });
    });
    if(window.AGENCY_DEPTS && !AGENCY_DEPTS.some(function(d){ return d.id==='mbti'; })){
      AGENCY_DEPTS.push({ id:'mbti', label:'MBTI 人格', count:16 });
    }
  }catch(e){}
}

/* ── 群聊房间（多 Agent 协作；成员回复 = 独立 Hermes 会话，SSE 实时广播） ── */
var roomsStore=[]; var currentRoom=null; var roomAt=new Set(); var roomEventSrc=null; var roomLive={};
function renderRoomsPage(){ loadRoomsList(); }
function loadRoomsList(){
  return api('/api/rooms','GET').then(function(r){
    roomsStore=(r&&r.rooms)||[];
    renderRoomList();
    if(currentRoom && !roomsStore.find(function(x){ return String(x.id)===String(currentRoom); })){ currentRoom=null; roomResetView(); }
    if(!currentRoom && roomsStore.length) selectRoom(roomsStore[0].id);
    return roomsStore;
  }).catch(function(){});
}
function renderRoomList(){
  var box=document.getElementById('roomList'); if(!box) return;
  box.innerHTML='';
  if(!roomsStore.length){ box.innerHTML='<div style="padding:20px;text-align:center;color:var(--muted);font-size:12px">暂无房间<br>点击「＋ 新建房间」创建</div>'; return; }
  roomsStore.forEach(function(r){
    var it=document.createElement('div'); it.className='room-item'+(String(r.id)===String(currentRoom)?' active':'');
    var mems=(r.members||[]).map(function(m){ return (m.emoji||'')+m.label; }).join(' ');
    it.innerHTML='<div class="t1"><span>'+escapeHtml(r.title||'群聊')+'</span><span class="del" onclick="event.stopPropagation();roomDelete(\''+r.id+'\')">✕</span></div>'+
      '<div class="t2"><span>'+((r.members||[]).length+1)+' 成员</span><span>'+(r.message_count||0)+' 条</span>'+(mems?'<span style="color:var(--accent)">'+escapeHtml(mems)+'</span>':'')+'</div>';
    it.onclick=function(){ selectRoom(r.id); };
    box.appendChild(it);
  });
}
function selectRoom(id){
  currentRoom=id;
  // v0.21.147：移动端选中房间后自动收起房间列表浮层（腾出聊天区域）
  try{
    var _sd=document.querySelector('.rooms-layout .rooms-side');
    if(_sd&&_sd.classList.contains('m-open')){ _sd.classList.remove('m-open'); var _b=document.getElementById('roomListToggle'); if(_b) _b.textContent='☰ 房间'; }
  }catch(e){}
  renderRoomList();
  return api('/api/rooms/'+encodeURIComponent(id),'GET').then(function(r){
    if(currentRoom!==id||!r||!r.room) return;
    var room=r.room;
    var t=document.getElementById('roomTitle'); if(t) t.textContent=room.title||'群聊';
    renderRoomMembers(room.members||[]);
    renderRoomMessages(room.messages||[]);
    connectRoomStream(id);
  }).catch(function(){});
}
function roomResetView(){
  var t=document.getElementById('roomTitle'); if(t) t.textContent='选择或创建群聊房间';
  var mm=document.getElementById('roomMembers'); if(mm) mm.innerHTML='';
  var ms=document.getElementById('roomMsgs'); if(ms) ms.innerHTML='<div class="rooms-empty">👥 多 Agent 协作房间</div>';
  var ab=document.getElementById('roomAtBar'); if(ab) ab.innerHTML='';
  roomAt.clear();
}
function renderRoomMembers(members){
  var box=document.getElementById('roomMembers'); if(!box) return;
  box.innerHTML='';
  members.forEach(function(m){
    var c=document.createElement('span'); c.className='room-member';
    c.innerHTML=(m.emoji||'🧠')+' '+escapeHtml(m.label);
    box.appendChild(c);
  });
}
function renderRoomMessages(msgs){
  var box=document.getElementById('roomMsgs'); if(!box) return;
  box.innerHTML='';
  if(!msgs.length){ box.innerHTML='<div class="rooms-empty">成员已就位。输入任务后由主持人组织讨论，也可以 @ 指定专家。</div>'; return; }
  msgs.forEach(function(m){ roomMsgAppend(m.kind==='user'?'me':'member', m.label, m.text, m.from==='me'); });
  box.scrollTop=box.scrollHeight;
}
function roomMsgAppend(kind,label,text,isMe,key){
  var box=document.getElementById('roomMsgs'); if(!box) return;
  var empty=box.querySelector('.rooms-empty'); if(empty) empty.remove();
  var el=document.createElement('div'); el.className='rm'+(isMe?' me':'');
  var av=isMe?'你':(label||'成员').slice(0,1);
  el.innerHTML='<div class="av">'+escapeHtml(av)+'</div><div class="bd"><div class="meta"><b>'+escapeHtml(label||'成员')+'</b> <span>'+new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})+'</span></div><div class="tx">'+escapeHtml(text||'')+'</div></div>';
  box.appendChild(el); box.scrollTop=box.scrollHeight;
  return el;
}
function roomStreamEl(label){
  var box=document.getElementById('roomMsgs'); if(!box) return null;
  var empty=box.querySelector('.rooms-empty'); if(empty) empty.remove();
  var el=document.createElement('div'); el.className='rm';
  el.innerHTML='<div class="av">'+escapeHtml((label||'成员').slice(0,1))+'</div><div class="bd"><div class="meta"><b>'+escapeHtml(label)+'</b> <span>'+new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})+'</span></div><div class="tx"></div></div>';
  box.appendChild(el); box.scrollTop=box.scrollHeight;
  return el;
}
function connectRoomStream(id){
  if(roomEventSrc){ try{ roomEventSrc.close(); }catch(e){} roomEventSrc=null; }
  roomLive={};
  var es=new EventSource(apiUrl('/api/rooms/'+encodeURIComponent(id)+'/events'));
  roomEventSrc=es;
  es.onmessage=function(ev){
    var p; try{ p=JSON.parse(ev.data); }catch(e){ return; }
    if(p.type==='user'){ roomMsgAppend('me','我',p.text,true); }
    else if(p.type==='start'){
      roomLive[p.key]={ el:roomStreamEl(p.label), text:'', reason:'' };
    }else if(p.type==='delta'){
      var l=roomLive[p.key]; if(!l||!l.el) return;
      l.text+=p.delta;
      var tx=l.el.querySelector('.tx'); if(tx) tx.textContent=l.text;
      var box=document.getElementById('roomMsgs'); if(box) box.scrollTop=box.scrollHeight;
    }else if(p.type==='reasoning'){
      var l2=roomLive[p.key]; if(!l2||!l2.el) return;
      l2.reason+=p.reasoning;
      var th=l2.el.querySelector('.thinking');
      if(!th){
        var d=document.createElement('div'); d.className='thinking';
        d.innerHTML='<span class="rt-ttl" onclick="this.parentElement.classList.toggle(\'open\')">🧠 思考过程</span><div style="display:none"></div>';
        l2.el.querySelector('.tx').before(d);
      }
      var rcd=l2.el.querySelector('.thinking div'); if(rcd) rcd.textContent=l2.reason;
    }else if(p.type==='tool'){
      var l3=roomLive[p.key]; if(!l3||!l3.el) return;
      var tl=document.createElement('div'); tl.className='tool-line'; tl.textContent='🛠 '+p.tool;
      l3.el.querySelector('.bd').appendChild(tl);
    }else if(p.type==='done'){
      var l4=roomLive[p.key];
      if(l4&&l4.el&&!l4.text){ var tx2=l4.el.querySelector('.tx'); if(tx2) tx2.textContent=p.text||'(空)'; }
      delete roomLive[p.key];
    }else if(p.type==='err'){
      var l5=roomLive[p.key]; if(l5&&l5.el){ var tx3=l5.el.querySelector('.tx'); if(tx3) tx3.textContent='⚠️ '+p.error; }
    }
  };
  es.onerror=function(){ /* EventSource 自动重连 */ };
}
function roomCreateDialog(){
  var exps=(window.AGENCY_PERSONAS||[]);
  if(!exps.length){ toast('专家库未加载，请稍后重试','error'); return; }
  var opts=exps.slice(0,140).map(function(x){
    return '<label class="room-ck"><input type="checkbox" value="'+x.id+'" data-label="'+escapeHtml(x.label)+'" data-emoji="'+escapeHtml(x.emoji||'🧠')+'" data-prompt="'+escapeHtml(x.prompt||'')+'" style="accent-color:var(--accent)"><span>'+escapeHtml(x.emoji||'🧠')+' '+escapeHtml(x.label)+' <span style="color:var(--muted);font-size:11px">'+escapeHtml(x.dept_label||'')+'</span></span></label>';
  }).join('');
  var html='<div class="modal-overlay" id="roomCreateOverlay" onclick="if(event.target===this)this.remove()">'+
    '<div class="modal" style="max-width:560px">'+
    '<div class="modal-head"><h3>＋ 创建群聊房间</h3><button class="modal-close" aria-label="关闭" title="关闭" onclick="this.closest(\'.modal-overlay\').remove()">×</button></div>'+
    '<div class="modal-body" style="padding:16px;max-height:60vh;overflow-y:auto">'+
    '<p style="font-size:12.5px;color:var(--text2);margin-bottom:12px;line-height:1.5">邀请专家成员（可多选，0 个则仅主 Hermes）。每位成员 = 独立 Hermes 会话 + 人格注入，发消息时 @ 成员并行回复。</p>'+
    '<input type="text" id="roomCreateTitle" placeholder="房间名称（默认：群聊）" style="width:100%;padding:8px 11px;border:1px solid var(--border);border-radius:8px;background:var(--bg1);color:var(--text);margin-bottom:12px">'+
    '<div style="font-size:12.5px;font-weight:600;margin-bottom:8px;color:var(--text)">选择专家成员：</div>'+
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:2px;border:1px solid var(--border);border-radius:10px;padding:8px;max-height:300px;overflow-y:auto">'+opts+'</div>'+
    '</div>'+
    '<div class="modal-foot" style="padding:12px 16px;display:flex;justify-content:flex-end;gap:8px">'+
    '<button class="btn" onclick="this.closest(\'.modal-overlay\').remove()">取消</button>'+
    '<button class="btn primary" onclick="roomCreateConfirm()">创建房间</button>'+
    '</div></div></div>';
  var div=document.createElement('div'); div.innerHTML=html; window.ui.adoptOverlay(document.body.appendChild(div.firstChild));
}
function roomCreateConfirm(){
  var title=(document.getElementById('roomCreateTitle').value||'').trim()||('群聊 '+new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}));
  var members=[];
  document.querySelectorAll('#roomCreateOverlay input:checked').forEach(function(cb){
    members.push({ key:'exp_'+cb.value, label:cb.getAttribute('data-label'), emoji:cb.getAttribute('data-emoji'), persona_id:cb.value, system:cb.getAttribute('data-prompt') });
  });
  var ov=document.getElementById('roomCreateOverlay'); if(ov) ov.remove();
  api('/api/rooms','POST',{title:title,members:members}).then(function(r){
    if(r&&r.ok!==false){
      roomsStore.unshift(r.room); renderRoomList(); selectRoom(r.room.id);
      toast('房间已创建','success');
    } else toast('创建失败: '+((r&&r.error)||''),'error');
  }).catch(function(e){ toast('创建失败: '+e.message,'error'); });
}
async function roomDelete(id){
  if(!(await ui.confirm('删除该群聊房间？', {danger:true}))) return;
  api('/api/rooms/'+encodeURIComponent(id),'DELETE').then(function(r){
    if(r&&r.ok!==false){ roomsStore=roomsStore.filter(function(x){ return x.id!==id; }); renderRoomList(); roomResetView(); toast('已删除','success'); }
  }).catch(function(){});
}
function roomAtDialog(){
  if(!currentRoom) return;
  var room=roomsStore.find(function(x){ return String(x.id)===String(currentRoom); });
  if(!room||!(room.members||[]).length){ toast('该房间暂无成员，请先创建带专家的房间','error'); return; }
  var html='<div class="modal-overlay" id="roomAtOverlay" onclick="if(event.target===this)this.remove()">'+
    '<div class="modal" style="max-width:380px">'+
    '<div class="modal-head"><h3>@ 成员（可多选，并行回复）</h3><button class="modal-close" aria-label="关闭" title="关闭" onclick="this.closest(\'.modal-overlay\').remove()">×</button></div>'+
    '<div class="modal-body" style="padding:16px">'+
    room.members.map(function(m){
      var on=roomAt.has(m.key);
      return '<label class="room-ck"><input type="checkbox" value="'+m.key+'"'+(on?' checked':'')+' style="accent-color:var(--accent)"><span>'+(m.emoji||'🧠')+' '+escapeHtml(m.label)+'</span></label>';
    }).join('')+
    '<div style="font-size:11.5px;color:var(--muted);margin-top:8px">不选择成员 = 主持人按任务组织专家讨论</div>'+
    '</div>'+
    '<div class="modal-foot" style="padding:12px 16px;display:flex;justify-content:flex-end;gap:8px">'+
    '<button class="btn" onclick="this.closest(\'.modal-overlay\').remove()">取消</button>'+
    '<button class="btn primary" onclick="roomAtConfirm()">确定</button>'+
    '</div></div></div>';
  var div=document.createElement('div'); div.innerHTML=html; window.ui.adoptOverlay(document.body.appendChild(div.firstChild));
}
function roomAtConfirm(){
  roomAt.clear();
  document.querySelectorAll('#roomAtOverlay input:checked').forEach(function(cb){ roomAt.add(cb.value); });
  var ov=document.getElementById('roomAtOverlay'); if(ov) ov.remove();
  roomRenderAtBar();
}
function roomRenderAtBar(){
  var bar=document.getElementById('roomAtBar'); if(!bar) return;
  bar.innerHTML='';
  var room=roomsStore.find(function(x){ return String(x.id)===String(currentRoom); });
  roomAt.forEach(function(k){
    var m=(room&&room.members||[]).find(function(x){ return x.key===k; });
    if(!m) return;
    var c=document.createElement('span'); c.className='at-chip';
    c.innerHTML=(m.emoji||'🧠')+' '+escapeHtml(m.label)+' <span class="x" onclick="roomAt.delete(\''+k+'\');roomRenderAtBar();">✕</span>';
    bar.appendChild(c);
  });
}
function roomSend(){
  if(!currentRoom) return;
  var ta=document.getElementById('roomCompose'); if(!ta) return;
  var text=(ta.value||'').trim();
  if(!text) return;
  ta.value='';
  var room=roomsStore.find(function(x){ return String(x.id)===String(currentRoom); });
  var at=[];
  if(roomAt.size){
    roomAt.forEach(function(k){
      var m=(room&&room.members||[]).find(function(x){ return x.key===k; });
      if(m) at.push({ key:m.key, label:m.label, system:m.system||'', model:m.model||'', provider:'' });
    });
  }
  api('/api/rooms/'+encodeURIComponent(currentRoom)+'/send','POST',{text:text,at:at}).then(function(r){
    if(!r||r.ok===false) toast('发送失败: '+((r&&r.error)||''),'error');
  }).catch(function(){});
  // Host/member streaming events render progress; do not leave a fake Hermes message.
}
var _roomComposeEl=document.getElementById('roomCompose');
if(_roomComposeEl){
  _roomComposeEl.addEventListener('keydown',function(e){
    if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){ e.preventDefault(); roomSend(); }
  });
}

