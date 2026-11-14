/* 对话输入 / 发送
 * 来源：index.html 内联 app.js 第 3907-4889 行（共 983 行）
 * 2026-11-13 按原分区纯搬运外移，逻辑零改动。全局作用域与执行顺序与原内联块一致。 */

/* ============================ 对话输入 / 发送 ============================ */
/* ── 千问式生成状态条 ────────────────────────────────────────────────
 * genBar：AI 工作时出现的状态条，半嵌入输入框上方（空闲时完全隐藏）。
 * 左侧状态文案（🤔 正在思考 → ✍️ 正在回复 → 🛠 工具执行中）+ 右侧实时计时器。
 * 麦克风/发送按钮位于输入框内右侧（.input-btns）；生成中 sendBtn 变红色
 * 「停止」按钮，点击 onSendOrStop → chatStop()
 * （POST /api/chat/stop 通知网关中断 + ws.close + AbortController.abort 全链路停止）。 */
var _genTimerInt = null, _genTimerStart = 0, _genLastEventTs = 0; // 长静默「仍在工作」提示：最后一次内容/工具事件时间
var _tabGenState = {};   // 按会话区分 genBar 状态：sid -> {mode,text,icon,ts,done}，切 tab 恢复 / 多会话并行互不覆盖
var _tabGenDoneAt = {};  // sid -> 完成时刻：完成后的迟到事件不许把状态复活（「任务结束了还写正在输入」的根因）
/* 发送/停止按钮模式切换：send=发送（含纠偏发送），stop=停止生成 */
function _setSendBtnMode(btn, mode){
  if(!btn) return;
  if(mode==='send'){
    btn.classList.remove('stop');
    btn.title='发送纠偏（redirect）';
    btn.disabled=false;
    btn.innerHTML='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22 11 13 2 9z"/></svg>';
  } else {
    btn.classList.add('stop');
    btn.title='停止生成（直接中断当前进度）';
    btn.disabled=false;
    btn.innerHTML='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2.5"/></svg>';
  }
}
function onSendOrStop(){
  if(_msgState.streaming){
    // 流式回复中：已输入内容 = 发送纠偏（redirect）；未输入 = 停止生成
    var ta=document.getElementById('chatInput');
    if(ta && ta.value.trim()){ sendChat(); return; }
    chatStop();
    return;
  }
  sendChat();
}
function setSendState(streaming){
  var btn=document.getElementById('sendBtn'); if(!btn) return;
  var ta=document.getElementById('chatInput');
  if(streaming){
    if(btn.classList.contains('stop') && !(ta && ta.value.trim())) return;
    if(ta && ta.value.trim()){
      _setSendBtnMode(btn, 'send');   // 已有输入 → 发送纠偏
    } else {
      _setSendBtnMode(btn, 'stop');   // 未输入 → 停止
    }
    if(ta && ta.placeholder.indexOf('纠偏')<0){ ta.setAttribute('data-ph', ta.placeholder); ta.placeholder='回复中，可输入消息纠偏'; }
  } else {
    btn.classList.remove('stop');
    btn.title='发送';
    btn.innerHTML='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22 11 13 2 9z"/></svg>';
    if(ta && ta.getAttribute('data-ph')){ ta.placeholder = ta.getAttribute('data-ph'); ta.removeAttribute('data-ph'); }
    btn.disabled=!((ta && ta.value.trim()) || _pendingAttachments.length);
  }
}
function genBarShow(mode, text, sid, icon){
  sid = sid || currentSession;
  /* ④ 结束即终态（2026-11-11）：之前用「结束 4 秒内不许复活」的窗口挡迟到事件，
   * 治不了 PC 端——那边的 WebSocket 一直挂着，几秒后重连回放一批旧 delta，窗口早过了，
   * 状态就重新点亮成「正在输入」，永远不灭。现在改成单调状态：done 之后任何 show 都不生效，
   * 只有显式 genBarReset(sid)（发新消息 / 起新流）才清掉 done。 */
  if(sid && _tabGenState[sid] && _tabGenState[sid].done && mode !== 'done' && mode !== 'idle') return;
  if(sid){ var _pv=_tabGenState[sid]; _tabGenState[sid] = { mode: mode, text: text || _ST_PHRASE[mode] || '', icon: icon || '', ts: Date.now(), start: (_pv&&!_pv.done&&_pv.start)?_pv.start:Date.now(), done: false }; }
  _paintStateBadge(); _paintRailState();
  if(sid && sid !== currentSession) return;  // 后台会话：只记状态，不碰前台 DOM（多会话并行互不覆盖）
  /* 气泡状态环不归这里管（2026-11-13 用户第 39 条）。本函数是**会话级**状态条，
     手上没有消息 id，以前 _markRunningMsg(true, mode) 只能靠「最后一条」兜底，
     连发三条时最后那条还没执行的排队消息被标成彩色跑马灯、呼吸灯还被清理逻辑一起抹掉。
     环的唯一入口 = js/panel-durable.js 的 refreshQueue（它有 runJob.id 和 qids，是真源）。 */
  var bar=document.getElementById('genBar'); if(!bar) return;
  bar.classList.add('streaming');
  var ic=document.getElementById('genIcon'), tx=document.getElementById('genText'), tm=document.getElementById('genTimer');
  var icons={thinking:'🤔',generating:'✍️',reasoning:'💭',tool:'🛠',writing:'💻',done:'✅',error:'⚠️',stopped:'⏹',queued:'⏳',blocked:'⛔',
    agent:'🤖',search:'🔍',browse:'🌐',extract:'📄',file:'📝',image:'🎨',video:'🎬',media:'🎤',memory:'🧠',skill:'🧩',task:'📋',chat:'💬',home:'🏠',pc:'🖥',ask:'❓',retry:'🔄'};
  if(ic) ic.textContent=icons[mode]||'🤔';
  if(tx){ tx.innerHTML=escapeHtml(text||'')+'<span class="gen-dots"><i></i><i></i><i></i></span>'; tx.dataset.base=text||''; tx.dataset.silent='0'; }
  if(tm) tm.style.display='';
  _genLastEventTs = Date.now(); // 有事件活动：重置长静默计时
  if(!_genTimerInt){
    _genTimerStart=Date.now();
    _genTimerInt=setInterval(function(){
      var el=document.getElementById('genTimer');
      if(el) el.textContent=((Date.now()-_genTimerStart)/1000).toFixed(1)+'s';
      // 长静默提示：45 秒无任何内容/工具事件时，追加「仍在思考 · 已持续 Xs」，
      // 让用户明确知道连接未断、模型仍在工作（防误判为断流）
      var txEl=document.getElementById('genText');
      if(txEl && txEl.dataset && _genLastEventTs){
        var silent=Date.now()-_genLastEventTs;
        var note=txEl.querySelector('.gen-silent-note');
        if(silent>45000 && txEl.dataset.silent==='0'){
          txEl.dataset.silent='1';
          txEl.innerHTML=escapeHtml(txEl.dataset.base||'')+'<span class="gen-dots"><i></i><i></i><i></i></span><span class="gen-silent-note">仍在思考 · 已持续 '+Math.round(silent/1000)+'s</span>';
        } else if(silent>45000 && txEl.dataset.silent==='1' && note){
          var sec=Math.round(silent/1000);
          if(txEl.dataset.sec !== String(sec)){ txEl.dataset.sec=String(sec); note.textContent='仍在思考 · 已持续 '+sec+'s'; }
        } else if(silent<=45000 && txEl.dataset.silent==='1'){
          txEl.dataset.silent='0';
          txEl.innerHTML=escapeHtml(txEl.dataset.base||'')+'<span class="gen-dots"><i></i><i></i><i></i></span>';
        }
      }
    },100);
  }
}
/* 显式复位：只有「用户又发了一条 / 新的一轮流开始了」才允许状态重新点亮。
 * 4 秒窗口是时间猜测，这个是状态机，不靠猜。 */
function genBarReset(sid){
  sid = sid || currentSession;
  if(!sid) return;
  delete _tabGenState[sid];
  delete _tabGenDoneAt[sid];
  _paintStateBadge(); _paintRailState();
}
/* 2026-11-11：按"真实还活着"的会话列表对账。队列里没有活任务的会话，状态一律清掉。
   只进不出的状态是 iPad 上「任务停了还显示正在思考」的另一半原因（另一半是 CSS 把 [hidden] 压掉了）。 */
function genBarReconcile(liveSids){
  var live = {};
  (liveSids||[]).forEach(function(s){ if(s) live[s]=1; });
  var changed = false;
  Object.keys(_tabGenState||{}).forEach(function(sid){
    if(!live[sid]){ delete _tabGenState[sid]; delete _tabGenDoneAt[sid]; changed = true; }
  });
  if(changed){ _paintStateBadge(); _paintRailState(); }
}
function genBarDone(mode, text, holdMs, sid){
  sid = sid || currentSession;
  if(sid){ _tabGenState[sid] = { mode: mode, text: text || '', ts: Date.now(), done: true }; _tabGenDoneAt[sid] = Date.now(); }
  if(sid) _hdrMetricCache[sid] = null;   // 一轮结束：下次刷新副标题拿到最新的上下文占用
  _paintStateBadge(); _paintRailState();
  if(sid && sid !== currentSession) return;  // 后台会话：只记状态，前台 DOM/按钮不受影响
  /* 同理不再清环（2026-11-13）：这里一清会把还没执行的 queue 呼吸灯一起抹掉。
     本轮结束由 durable 的 finishBar → refreshQueue() 按队列真源摘环。 */
  var bar=document.getElementById('genBar'); if(!bar) return;
  var ic=document.getElementById('genIcon'), tx=document.getElementById('genText');
  var icons={done:'✅',error:'⚠️',stopped:'⏹'};
  if(ic) ic.textContent=icons[mode]||'✅';
  if(tx) tx.textContent=text||'';
  if(_genTimerInt){ clearInterval(_genTimerInt); _genTimerInt=null; }
  _genLastEventTs = 0; // 完成/停止：结束长静默提示
  setSendState(false);
  // 完成状态停留 holdMs 后整条隐藏（AI 空闲时状态条不出现）
  setTimeout(function(){
    if(_msgState.streaming) return;
    var b2=document.getElementById('genBar'); if(!b2) return;
    b2.classList.remove('streaming');
    var tm2=document.getElementById('genTimer'); if(tm2) tm2.style.display='none';
    var ic2=document.getElementById('genIcon'), tx2=document.getElementById('genText');
    if(ic2) ic2.textContent='🤖';
    if(tx2) tx2.textContent='';
  }, holdMs!=null?holdMs:2200);
}
/* ── genBar 按会话恢复：切 tab / 刷新后，把状态条对齐到当前前台会话 ── */
function _syncGenBarToTab(sid){
  var bar = document.getElementById('genBar');
  if(!bar) return;
  var st = _tabGenState[sid];
  if(st && !st.done){
    // 该会话仍在流式（running 态）→ 恢复状态条（此时 sid===currentSession，会真正更新 DOM）
    genBarShow(st.mode, st.text, sid);
  } else {
    // done 或无状态 → 隐藏状态条，清掉上一个会话残留的 running 显示
    bar.classList.remove('streaming');
    var tm = document.getElementById('genTimer'); if(tm) tm.style.display='none';
    var ic = document.getElementById('genIcon'), tx = document.getElementById('genText');
    if(ic) ic.textContent='🤖';
    if(tx) tx.textContent='';
    if(_genTimerInt){ clearInterval(_genTimerInt); _genTimerInt=null; _genTimerStart=0; _genLastEventTs=0; }
  }
  _paintStateBadge(); _paintRailState();
}
/* ── 查询后端某会话是否仍在生成：刷新/切 tab 后恢复「正在继续生成…」提示 ── */
function _checkActiveGen(sid){
  if(!sid) return;
  fetch(apiUrl('/api/chat/active?session_id='+encodeURIComponent(sid)), { cache:'no-store', headers: monitorToken?{'X-Monitor-Token':monitorToken}:{} })
    .then(function(r){ return r.ok ? r.json() : null; })
    .then(function(d){
      if(!d || !d.active) return;
      // 后端仍在生成，但本地无流式状态（刷新/切 tab 丢失）→ 恢复提示；内容滚动由 pollSessionSync 轮询兜底
      if(!_tabStreaming[sid] && !(_tabGenState[sid] && !_tabGenState[sid].done)){
        genBarShow('thinking', '正在继续生成…', sid);
      }
    })
    .catch(function(){});
}
/* ── 状态条自愈（2026-11-12）────────────────────────────────────────
 * 任务在别处被取消（另一台设备点了停止、后台巡检清队、进程重启丢事件）时，
 * 生成状态条收不到终态事件，会永远挂在输入框上方——用户看到的就是「输入框顶上
 * 多一条绿线，怎么也消不掉」。这里每 15 秒对一次账：
 *   后端 /api/chat/active 说没在跑，队列里也没有该会话的 pending/running
 *   → 收掉条子（把该会话状态置成 done，避免迟到的旧事件又点亮）。
 * 真流式（_msgState.streaming 为真）一律不动，避免把正在跑的轮次误杀。
 */
function _genBarSweep(){
  var sid = currentSession; if(!sid) return;
  if(_msgState.streaming) return;
  var bar = document.getElementById('genBar');
  var st = _tabGenState[sid];
  var spinning = (bar && bar.classList.contains('streaming')) || (st && !st.done);
  if(!spinning) return;                       // 本来没亮，不用查网
  function hdr(){ return monitorToken ? {'X-Monitor-Token':monitorToken} : {}; }
  Promise.all([
    fetch(apiUrl('/api/chat/active?session_id='+encodeURIComponent(sid)), {cache:'no-store', headers:hdr()})
      .then(function(r){ return r.ok ? r.json() : null; }).catch(function(){ return null; }),
    fetch(apiUrl('/api/chat/queue'), {cache:'no-store', headers:hdr()})
      .then(function(r){ return r.ok ? r.json() : null; }).catch(function(){ return null; })
  ]).then(function(res){
    var act = res[0], q = res[1];
    if(act === null && q === null) return;    // 两端都拿不到：不做判断，宁可留着
    var live = !!(act && act.active);
    var jobs = (q && q.jobs) || [];
    if(!live && jobs.some(function(j){ return j && j.session_id===sid && (j.status==='pending' || j.status==='running'); })) live = true;
    if(live) return;
    if(_msgState.streaming) return;
    _genBarHideStale(sid);
  }).catch(function(){});
}
function _genBarHideStale(sid){
  sid = sid || currentSession; if(!sid) return;
  _tabGenState[sid] = { mode:'done', text:'', ts:Date.now(), done:true };
  _paintStateBadge(); _paintRailState();
  /* 陈旧自清也只管状态条，不碰气泡环（2026-11-13）：环归队列真源，
     这里清会把仍排在队里的 pending 呼吸灯一起抹掉。下一轮 refreshQueue 会按真相重标。 */
  if(_genTimerInt){ clearInterval(_genTimerInt); _genTimerInt=null; }
  _genLastEventTs = 0; _genTimerStart = 0;
  var bar=document.getElementById('genBar'); if(bar) bar.classList.remove('streaming');
  var tm=document.getElementById('genTimer'); if(tm) tm.style.display='none';
  var ic=document.getElementById('genIcon'), tx=document.getElementById('genText');
  if(ic) ic.textContent='🤖';
  if(tx) tx.textContent='';
  try{ setSendState(false); }catch(e){}
}
function autoResize(t){
  t.style.height='auto'; t.style.height=t.scrollHeight+'px';
  var btn=document.getElementById('sendBtn'); if(!btn) return;
  if(_msgState.streaming){
    _setSendBtnMode(btn, t.value.trim() ? 'send' : 'stop');   // 流式：有输入=发送纠偏，无输入=停止
  } else {
    btn.disabled=!t.value.trim() && _pendingAttachments.length===0;
  }
}
/* 手机端工具条加号折叠：＋ 展开 / − 收起（桌面端隐藏按钮不受影响） */
function toggleToolbar(){
  var tb=document.getElementById('toolbar'), tg=document.getElementById('toolbarToggle');
  if(!tb) return;
  var show=tb.classList.toggle('visible');
  if(tg){tg.textContent=show?'−':'＋';tg.setAttribute('aria-expanded',String(show));tg.setAttribute('aria-label',show?'收起输入工具':'展开输入工具');}
}
/* 回车行为：桌面回车=发送；手机（触屏/窄屏）回车=换行，发送只交给小飞机按钮 */
/* 触屏判定只管「UI 要不要放大」；回车键行为必须只按屏幕宽度分 —— 带触摸屏的笔记本
 * (pointer:coarse 为真) 曾被当成手机，于是 PC 上回车换行不发送。 */
function _isTouchNarrow(){ return window.matchMedia('(pointer:coarse)').matches || window.innerWidth<=820; }
function _isNarrowScreen(){ return window.innerWidth<=820; }
function onKey(e){
  if(e.key!=='Enter' || e.isComposing || e.keyCode===229) return;
  if(window.__forceNewlineOnEnter) { return; }          // 调试/特殊场景强制换行
  if(_isNarrowScreen()){ return; }                       // 窄屏（手机）：默认插入换行，发送交给小飞机
  // PC：Enter 发送，Shift+Enter 换行（走浏览器默认）
  if(!e.shiftKey){ e.preventDefault(); sendChat(); }
}
/* ── 联网开关（webnet）───────────────────────────────────────────────
 * 控制「本轮是否允许调用联网工具」。
 * 默认开；状态存 localStorage `fnos_webnet`（'0' = 关，其余 = 开）。
 * 微信等通道侧无此开关 → 始终联网（hermes-weixin 核心工具集自带 web_search/web_extract）。
 *
 * 实现说明：面板聊天走网关 /v1/chat/completions，该端点按 config.yaml 的
 * platform_toolsets 统一装配工具集，**不支持按请求禁用某个工具集**。因此关闭
 * 联网时用 system 注入硬约束实现 —— 与面板现有的 persona / 技能 / 连接器注入
 * 由各自会话快照和后端能力承载；这里不再拼接全局团队/工作流提示词。
 */
var _webNetOn = (localStorage.getItem('fnos_webnet') !== '0');
var WEB_OFF_RULE = '\n\n【联网已关闭 · 用户手动关闭，硬约束】本轮禁止调用任何联网能力，包括 web_search、web_extract、browser_* 系列网页操作，以及用 terminal 里的 curl/wget/python requests 抓取外部网页。只能使用本地文件、记忆、技能和自身知识作答。若判断必须联网才能准确回答，直接回复「联网已关闭，需要我开启联网吗？」然后停止，不要尝试绕过。严禁编造搜索结果、严禁声称已检索网络、严禁虚构 URL 或引用来源。';

function webNetOn(){ return _webNetOn; }
function renderWebNet(){
  var b = document.getElementById('btnWebNet');
  if(!b) return;
  b.style.color = _webNetOn ? 'var(--accent,#4f8cff)' : 'var(--muted,#999)';
  b.style.opacity = _webNetOn ? '1' : '0.4';
  var label = _webNetOn ? '联网：开（点击关闭）' : '联网：关（点击开启）';
  b.setAttribute('data-tip', label);
  b.setAttribute('aria-label', label);
  b.title = label;
}
function toggleWebNet(){
  _webNetOn = !_webNetOn;
  try { localStorage.setItem('fnos_webnet', _webNetOn ? '1' : '0'); } catch(e){}
  renderWebNet();
  toast(_webNetOn ? '🌐 联网已开启：本轮可检索网络' : '🚫 联网已关闭：本轮只用本地知识');
}

function sendChat(){
  var ta=document.getElementById('chatInput');
  var text=ta.value.trim();
  // 命令 chip：带上 /cmd 前缀再走分发
  if(window.__slashPending && window.__slashPending.n){
    text='/'+window.__slashPending.n+(text?' '+text:'');
    if(window.slashClearChip) window.slashClearChip();
  }
  if(!text && _pendingAttachments.length===0) return;
  genBarReset(currentSession);   // 新的一轮：清掉上一轮 done 终态，状态条重新可用
  ta.value=''; ta.style.height='auto';
  if(currentSession) delete _tabDrafts[currentSession];   // 发送成功：清空该会话草稿
  var btn=document.getElementById('sendBtn'); if(btn && !_msgState.streaming) btn.disabled=true;
  if(text.charAt(0)==='/'){ handleSlashCommand(text); return; }
  // 圆桌讨论模式
  if(_rtState.active && currentSession===_rtState.sessionId){ rtSend(text); return; }
  // The durable queue accepts follow-up turns; only its persisted response confirms receipt.
  sendRaw(text);
}

/* 真实发送：流式对话（SSE / XHR 降级） */
/* Compatibility hook retained for older extensions; session roles and plans are server-owned. */
function injectExpertSystem(sys){ return sys||''; }

function sendRaw(text){
  var attachments = _pendingAttachments.slice();
  _pendingAttachments = [];
  renderAttachChips();
  var body = document.getElementById('chatBody');
  if(!body) return;

  // 注入引用上下文
  var quoteHtml = '';
  var askText = text;   // 气泡只显示用户自己打的话；带【引用上下文】的那份只发给模型
  if(_currentQuote){
    quoteHtml = '<div class="quote-block"><div class="quote-label">引用</div>' + escapeHtml(_currentQuote) + '</div>';
    text = '【引用上下文】\n' + _currentQuote + '\n\n【用户追问】\n' + text;
    clearQuote();
  }

  var userDiv = document.createElement('div'); userDiv.className='msg user';
  var chips = attachments.map(function(a){
    if(a.type && /^audio\//.test(a.type)){
      return voicePlayerHTML(chatImgSrc(a.url), '');
    }
    return '<span class="attach-chip">📎 '+esc(a.name||'附件')+'</span>';
  }).join(' ');
  var redirectTag = _pendingRedirect ? '<span style="display:inline-block;background:var(--accent);color:#fff;font-size:10px;border-radius:4px;padding:1px 6px;margin-right:6px">🎯 纠偏</span>' : '';
  var liveUserName=typeof chatUserName==='function'?chatUserName():'你';
  userDiv.innerHTML = '<div class="chat-sender">'+liveUserName+'</div><div class="msg-bubble">'+quoteHtml+redirectTag+escapeHtml(askText).replace(/\n/g,'<br>')+(chips?'<div style="margin-top:6px">'+chips+'</div>':'')+'</div><div class="msg-actions"><button class="msg-act-btn" onclick="copyMsg(this)" title="复制"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 0-2-2V4a2 2 0 0 0 2-2h9a2 2 0 0 0 2 2v1"/></svg>复制</button><button class="msg-act-btn" onclick="quoteMsg(this)" title="引用回复"><svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>引用</button></div><div class="msg-meta">'+liveUserName+' · '+fmtDateTime(Date.now())+'</div>';
  body.appendChild(userDiv); followChatBottom();
  condenseChatBody();

  var asst = document.createElement('div'); asst.className='msg assistant';
  var _tcHidden = (PV.Store.load().chat || {}).tools_hidden;
  var _tcStyle = _tcHidden ? ' style="display:none"' : '';
  asst.innerHTML = '<div class="chat-sender">'+chatSenderName()+'</div>'+
    '<div class="msg-bubble">'+
      '<div class="md-text"><span class="cursor-blink">|</span></div>'+
      /* 状态条：正文之下、工具调用之上（2026-11-13 第 40 条） */
      '<div class="msg-statusbar" hidden></div>'+
      '<details class="tool-calls" data-box="live-'+Date.now().toString(36)+'"'+_tcStyle+'>'+
        (window.ToolCard ? ToolCard.summaryHTML('工具调用')
                         : '<summary class="tool-summary"><span class="tc-ico">🛠</span><span class="tc-text">工具调用</span></summary>')+
        '<div class="tool-list"></div></details>'+
      '<div class="chat-info"></div>'+
    '</div>'+
    '<div class="msg-meta">'+chatSenderName()+' · '+fmtDateTime(Date.now())+'</div>';
  body.appendChild(asst); followChatBottom();
  var mdEl = asst.querySelector('.md-text');
  var toolBox = asst.querySelector('.tool-calls');
  var toolList = asst.querySelector('.tool-list');
  var toolSummary = asst.querySelector('.tool-summary');
  var infoEl = asst.querySelector('.chat-info');
  var fullText = '';
  var _genToolUsed = [];   // 本轮使用的工具/技能（自动沉淀到知识库）
  var _genDeltaSeen = false;   // 首个内容块标记（状态条 thinking→generating 只切一次）
  var _genToolRunningIds = {}; // 运行中的工具集合：状态条与工具执行实时同步（调用中/写代码）
  var _genToolResumeTimer = null; // 工具全部结束后延迟恢复“思考/回复”状态，避免连发工具时闪烁
  var toolCards = {};
  var toolCount = 0;
  function updateToolSummary(){
    if(!toolSummary) return;
    var txt = toolSummary.querySelector('.tc-text');
    if(txt) txt.textContent = '已调用 '+toolCount+' 个工具';
    /* 开合状态完全交给 <details>（2026-11-13 第 39 条），这里不再维护第二份 */
  }

  if(!currentSession){
    // 团队模式或工作流启用时，自动创建的会话归入 team 分组
    var _ext = _cfg.extensions || {};
    var _aid = currentAgent || 'default';
    fetch(apiUrl('/api/sessions'), { method:'POST', headers: monitorToken?{'X-Monitor-Token':monitorToken}:{} })
      .then(function(r){ return r.json(); })
      .then(function(s){ _sessions.unshift(s); currentSession=s.id; _applyPendingModel(s.id); _openTabs.push(s.id); persistTabs(); renderSessionTabs(); renderRail(); updateHeader(); doStream(); })
      .catch(function(){ toast('创建会话失败'); mdEl.textContent='⚠ 无法创建会话'; });
  } else {
    doStream();
  }

  function doStream(){
    var sid = currentSession;  // 捕获：本会话的 sid（后台流式继续时切换不影响这里的 sid）
    _chatHTML[sid] = _chatHTML[sid] || '';  // 初始化缓存（防止首次流式就被清空）
    _tabStreaming[sid] = true; renderSessionTabs();
    genBarShow('thinking','正在思考', sid);
    setBubbleStatus(asst,'thinking','正在思考');
    // Expert and expression snapshots come from the server. Turn-specific context
    // belongs to the current user message, preserving the stable system prefix.
    var sys = '';
    var turnContext = [];
    if(_activeSkills.length)turnContext.push('本轮希望参考的已安装技能：'+_activeSkills.join('、')+'。请先确认实际可用。');

    if(_selectedConnector){var selectedConnection=(_connState.list||[]).find(c=>c.kind===_selectedConnector&&c.configured);if(selectedConnection)turnContext.push('本轮涉及已配置的连接器：'+selectedConnection.name+'。只使用实际工具定义里存在的对应能力。');}
    var messageText=text+(turnContext.length?'\n\n【本轮参考上下文】\n'+turnContext.join('\n'):'');
    var payload = {
      session_id: sid,
      message: buildMessageContent(messageText, attachments),
      system: sys
    };
    var _sessModel = _getSessionModel(sid);
    if(_sessModel){
      if(typeof _sessModel === 'object' && _sessModel.model){
        payload.model = _sessModel.model;
        if(_sessModel.provider) payload.provider = _sessModel.provider;
      } else {
        payload.model = _sessModel;
      }
    }
    streamChat(payload, {
      onDelta: function(d){
        fullText += d;
        _genLastEventTs = Date.now();
        // 第一次收到内容：若无运行中工具则状态条切到“正在回复”（工具执行中保持工具状态）
        if(!_genDeltaSeen && !Object.keys(_genToolRunningIds).length){ _genDeltaSeen=true; genBarShow('generating','正在回复', sid); }
        else _genDeltaSeen = true;
        /* 气泡状态栏与标题旁徽标同源：工具在跑就别抢，正文一到就换成「正在回复」 */
        if(!Object.keys(_genToolRunningIds).length) setBubbleStatus(asst,'generating','正在回复');
        /* 流式期间就把标记抽掉，别等 onDone —— 流被硬掐断时 onDone 根本不来，
           标记会原样留在正文底部（2026-11-13 用户实测）。chip 同步补上。 */
        _throttledRender(sid, function(){ var _sg = splitSysMarkers(fullText); mdEl.innerHTML = renderMarkdown(_sg.text, true); setBubbleFlags(asst, _sg.flags); if(autoScrollActive()) followChatBottom(); _chatHTML[sid] = body.innerHTML; }, 100);
        // 流式语音朗读：自动朗读开启时边生成边逐句朗读（首个 delta 打开 WS，增量持续喂给服务端按句合成）
        if(localStorage.getItem('fnos-voice-autoplay') === '1'){
          if(!_voiceStream.active){ _voiceStreamOpen(); }
          _voiceStreamFeed(d);
        }
      },
      onReasoning: function(r){
        _genLastEventTs = Date.now();
        // 推理模型思考过程：无运行中工具时显示思考中（工具执行中保持工具状态）
        if(!Object.keys(_genToolRunningIds).length) genBarShow('reasoning','正在思考', sid);
        if(!Object.keys(_genToolRunningIds).length) setBubbleStatus(asst,'reasoning','正在思考');
        var rb = asst.querySelector('.reasoning-block');
        if(!rb){
          rb = document.createElement('div');
          rb.className = 'reasoning-block';
          rb.innerHTML = '<div class="reasoning-head">💭 思考过程</div><div class="reasoning-text"></div>';
          mdEl.parentNode.insertBefore(rb, mdEl);
        }
        rb.querySelector('.reasoning-text').textContent += r;
        rb.scrollTop = rb.scrollHeight;
        _throttledRender(sid + '::reason', function(){ if(autoScrollActive()) followChatBottom(); _chatHTML[sid] = body.innerHTML; }, 150);
      },
      onTool: function(tp){
        // 状态条与工具执行实时同步：按工具类型显示（Agent/写代码/搜索/浏览…），全部完成→恢复思考/回复
        _genLastEventTs = Date.now();
        if(tp.tool && _genToolUsed.indexOf(tp.tool) < 0) _genToolUsed.push(tp.tool);   // 收集技能/工具（自动沉淀）
        var _running = !(tp.status==='done'||tp.status==='completed'||tp.status==='finish'||tp.status==='finished');
        var _tid = tp.toolCallId || tp.tool || 'tool';
        if(_running){
          if(_genToolResumeTimer){ clearTimeout(_genToolResumeTimer); _genToolResumeTimer=null; }
          _genToolRunningIds[_tid] = true;
          var _gs = genToolState(tp.tool);
          genBarShow(_gs.icon, _gs.text, sid);
          setBubbleStatus(asst,'tool', _gs.text, (typeof _ST_ICON!=='undefined' && _ST_ICON[_gs.icon]) || '🛠');
        } else {
          delete _genToolRunningIds[_tid];
          if(!Object.keys(_genToolRunningIds).length && !_genToolResumeTimer){
            // 全部工具完成：延迟恢复，避免连续工具间闪烁
            _genToolResumeTimer = setTimeout(function(){
              _genToolResumeTimer = null;
              if(!_msgState.streaming) return;  // 已停止/结束：不重新显示
              if(Object.keys(_genToolRunningIds).length) return;  // 期间又有新工具启动
              if(_genDeltaSeen) genBarShow('generating','正在回复', sid);
              else genBarShow('thinking','正在思考', sid);
              if(_genDeltaSeen) setBubbleStatus(asst,'generating','正在回复');
              else setBubbleStatus(asst,'thinking','正在思考');
            }, 300);
          }
        }
        // 技能调用渲染为 chip（Issue #9），不占完整工具卡片
        if(tp.skill || (tp.tool && /skill/i.test(tp.tool))){
          var sName = tp.toolZh || tp.name || tp.tool || '技能';
          var chip = document.createElement('span');
          chip.className = 'skill-invoke-chip';
          chip.textContent = '🧩 ' + sName;
          toolList.appendChild(chip);
          updateToolSummary();
          if(autoScrollActive()) followChatBottom();
          _chatHTML[sid] = body.innerHTML;
          return;
        }
        var id = tp.toolCallId || tp.tool || 'tool';
        var card = toolCards[id];
        if(!card){
          /* 原生 <details>：开合由浏览器负责，一次点击就切，不存在双写反转 */
          card = document.createElement('details');
          card.className = 'tool-call';
          card.setAttribute('data-tk', id);
          if(tp.toolCallId) card.setAttribute('data-tid', tp.toolCallId);
          card.innerHTML = '<summary class="tool-head"></summary><div class="tool-body"></div>';
          toolList.appendChild(card);
          toolCards[id] = card;
          toolCount++;
        }
        /* 同一工具会多次推送事件（start → done → result）：原地改内容，不重建元素，
           否则用户刚点开的卡片会被重建回默认收起。markup 全站唯一实现见 js/chat/toolcard.js */
        if(window.ToolCard) ToolCard.upsert(card, tp);
        if(window.ToolUI) ToolUI.paint(toolBox);
        updateToolSummary();
        // 流式进行中（有运行中的工具）保持展开；全部完成后折叠
        // 尊重设置：tools_collapse 开启时始终折叠，tools_hidden 开启时保持隐藏
        var _chat = (PV.Store.load().chat) || {};
        if(_chat.tools_collapse && window.ToolUI) ToolUI.defaultClosed(toolBox); // 强制折叠只在用户没点过时生效
        if(_chat.tools_hidden) toolBox.style.display='none';
        if(autoScrollActive()) followChatBottom();
        _chatHTML[sid] = body.innerHTML;
      },
      onInfo: function(i){
        if(!i) return;
        _genLastEventTs = Date.now();
        // 重连等信息同步到状态条（图标 🔄）
        if(/重连/i.test(String(i)) && !Object.keys(_genToolRunningIds).length) genBarShow('retry','正在重连…', sid);
        /* 「连接中断，正在重连(1/5)…」这类真提示归状态栏 alert 档：气泡里只出现一次 */
        if(/重连|连接中断|恢复进度/i.test(String(i))){
          setBubbleStatus(asst,'alert',String(i),'🔄');
          infoEl.style.display = 'none'; infoEl.innerHTML = '';
        } else {
          /* 纯进度类 info（正在思考 / 正在执行 / 正在等待…）气泡顶部状态栏已经在写，
             底部 .chat-info 再写一遍就是两个「正在思考」（2026-11-13 用户截图）。
             这里只放状态栏表达不了的提示。 */
          var _prog = /^(正在思考|正在执行|正在调用|正在等待|正在生成|正在回复|正在重连|正在加载)/.test(String(i).trim());
          if(_prog){
            infoEl.style.display = 'none'; infoEl.innerHTML = '';
          } else {
            infoEl.innerHTML = '<span class="info-dot"></span>'+escapeHtml(i);
            infoEl.style.display = 'flex';
          }
        }
        followChatBottom();
        _chatHTML[sid] = body.innerHTML;
      },
      onUsage: function(u){
        if(!u) return;
        var meta = asst.querySelector('.msg-meta');
        if(meta){
          var t = (u.total_tokens!=null) ? u.total_tokens
                : ((u.prompt_tokens||0) + (u.completion_tokens||0));
          meta.textContent = chatSenderName()+' · '+fmtDateTime(Date.now())+' · ' + t + ' tokens';
        }
      },
      onError: function(err){ var _raw = String(err||''); var _needCfg = /No inference provider configured/i.test(_raw); var _html = _needCfg ? '⚠ 尚未配置模型服务：请先到「模型」页添加模型供应商并填写 API Key。<br><span style="font-size:11px;opacity:.8">（网关返回：'+esc(_raw)+'）</span>' : '⚠ '+esc(_raw); mdEl.innerHTML = '<span class="error-text">'+_html+'</span>' + (_needCfg ? '<div style="margin-top:8px"><button onclick="switchPage(\'models\')" style="padding:5px 12px;border-radius:8px;border:1px solid var(--red);background:transparent;color:var(--red);cursor:pointer;font-size:12px">去配置模型 →</button></div>' : ''); if(_needCfg) renderConfigBanner(); genBarDone('error','回复出错', null, sid); _tabStreaming[sid]=false; renderSessionTabs(); clearBubbleStatus(asst,0); _chatHTML[sid] = body.innerHTML; _voiceStreamStop(); },
      onDone: function(aborted){
        _flushStreamRender(sid); _flushStreamRender(sid + '::reason');
        _tabStreaming[sid]=false; renderSessionTabs();
        if(aborted) _voiceStreamStop();
        /* 收尾：正文里的「（执行已中断）」「📦 已自动压缩」抽成 chip，手动停止也折成 chip，
           气泡状态栏同时退场 —— 不留一行活的状态挂在最底下。 */
        var _fin = splitSysMarkers(fullText), _finalText = _fin.text;
        mdEl.innerHTML = renderMarkdown(_finalText);
        /* 正文空、工具跑过：别把气泡留成一条光秃秃的「已调用 N 个工具」（2026-11-13）。 */
        /* 2026-11-13 用户第 45 条：这句并进下面那枚「已停止」标记，不再单独占一行。
           以前气泡里上头「⏹已停止」、底下「这一轮没有产出正文…」，同一件事说两遍。 */
        var _en = asst.querySelector('.msg-empty-note');
        if(_en) _en.remove();
        clearBubbleStatus(asst, 120);
        var _flags = _fin.flags.slice();
        /* 长句只进状态条（历史渲染那一版），live 阶段这句「已停止」就够——
           正文空不空用户一眼看得见，别再拿一整句话去解释一次。 */
        if(aborted) _flags.push({type:'muted',icon:'⏹',label:'已停止',hint:'这一轮由你手动停止',count:0});
        setBubbleFlags(asst, _flags);
        fullText = _finalText;
        infoEl.style.display = 'none';
        // 生成状态条：显示“回答完成 / 已停止”，短暂停留后恢复默认
        genBarDone(aborted?'stopped':'done', aborted?'已停止':'回答完成', null, sid);
        // 完成后折叠工具区（Issue #8）；若仍有运行中的工具则保持展开（除非「始终折叠」开启）
        if(toolBox){
          /* 收尾时把还挂着「执行中…」的卡片结清（2026-11-13）：流被掐断后
             done 事件不会再来，那些卡片会永远展开、永远印「执行中…」，
             同一屏里就成了有的开着有的闭着。 */
          var _stale = toolList.querySelectorAll('.tool-call.running');
          for(var _si=0;_si<_stale.length;_si++){
            var _sc=_stale[_si];
            _sc.classList.remove('running');
            /* 用户没手动开过才收起来；开过的保留（意愿记在 ToolCard.state） */
            if(_sc.tagName==='DETAILS' && !(window.ToolCard && ToolCard.state.card[_sc.getAttribute('data-tk')]!==undefined)) _sc.open=false;
            /* 第 43 条：完成态的「已完成」绿字删掉，只留标题变绿（data-state 驱动）。
               第 49 条（2026-11-13）：「已中断」这三个字也删了——中断靠标题变橙表达，
               文字与颜色是同一件事，印两遍就是啰嗦。 */
            var _ss=_sc.querySelector('.tool-status');
            if(_ss) _ss.remove();
            _sc.setAttribute('data-state', aborted ? 'interrupted' : 'done');
          }
          var anyRunning = toolList.querySelector('.tool-call.running');
          var _ch2 = (PV.Store.load().chat) || {};
          if(_ch2.tools_collapse && window.ToolUI) ToolUI.defaultClosed(toolBox);
          if(window.ToolUI) ToolUI.paint(toolBox);   // 收尾重绘：折叠态以用户意愿为准
          updateToolSummary();
        }
        scheduleChatFollow();
        _msgState.streaming=false; _msgState.abortCtrl=null;
        // 添加操作按钮（播放/引用/Fork）
        asst.setAttribute('data-content', fullText.replace(/\n/g,'&#10;').replace(/"/g,'&quot;'));
        var actBar=document.createElement('div'); actBar.className='msg-actions';
        actBar.innerHTML='<button class="msg-act-btn" onclick="speakMsg(this)" title="语音播放"><svg viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>播放</button>' +
          '<button class="msg-act-btn" onclick="quoteMsg(this)" title="引用回复"><svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>引用</button>' +
          '<button class="msg-act-btn" onclick="forkMsg(this)" title="Fork 新话题"><svg viewBox="0 0 24 24"><circle cx="12" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9v1a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V9"/><path d="M12 12v3"/></svg>Fork</button>';
        asst.insertBefore(actBar, asst.querySelector('.msg-meta'));
        // 自动朗读：流式朗读已激活则发 done 收尾（边生成已边朗读完，不重复整段）；未激活回退整段朗读
        if(!aborted && fullText && localStorage.getItem('fnos-voice-autoplay') === '1'){
          if(_voiceStream.active){ _voiceStreamDone(); }
          else {
            var _spkBtn = actBar.querySelector('.msg-act-btn');
            if(_spkBtn){ setTimeout(function(){ try{ speakMsg(_spkBtn); }catch(e){} }, 350); }
          }
        }
        _chatHTML[sid] = body.innerHTML;  // 完成后同步缓存
        condenseChatBody();
        loadSessions();

      }
    });
  }
}
function buildMessageContent(text, attachments){
  var imgs=[], files=[], fileNames=[];
  (attachments||[]).forEach(function(a){ if(a.type && a.type.indexOf('image/')===0) imgs.push(a.url); else {files.push(a.url);fileNames.push(a.name||'附件');} });
  return { text: text||'', images: imgs, files: files, file_names:fileNames };
}

/* 流式聊天：WebSocket 主通道（抗代理超时 + 自动重连），SSE/XHR 降级 */
function wsChatUrl(sid){
  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return proto + '//' + location.host + apiUrl('/api/chat/ws') + '?session_id=' + encodeURIComponent(sid) + '&token=' + encodeURIComponent(monitorToken || '');
}
function streamChat(payload, cb){
  genBarReset((payload && (payload.session_id||payload.session)) || currentSession);
  _msgState.streaming = true;
  setSendState(true);   // 发送按钮 → 红色「停止」按钮（点击 onSendOrStop → chatStop 全链路中断）
  var done = false;
  var ws = null;
  var fallbackTimer = null;
  var wsOpened = false;
  var reconnectAttempts = 0;
  var maxReconnects = 3;  // 最多自动重连 3 次
  var reconnectDelay = 2000; // 首次重连延迟 2s

  function finish(){
    if(done) return; done = true;
    clearTimeout(fallbackTimer);
    _msgState.streaming = false; _msgState.abortCtrl = null; _msgState.ws = null;
    setSendState(false);   // 无论何种路径收尾，按钮都复位为发送态（幂等）
  }
  function handleMsg(p){
    if(p.keepalive) return;
    if(p.delta) cb.onDelta(p.delta);
    else if(p.reasoning && cb.onReasoning) cb.onReasoning(p.reasoning);
    else if(p.tool_progress) cb.onTool(p.tool_progress);
    else if(p.clarify){ if(window.pwClarifyAsk) window.pwClarifyAsk(p.clarify); }
    else if(p.error) cb.onError(p.error);
    else if(p.info) cb.onInfo(p.info);
    else if(p.usage && cb.onUsage) cb.onUsage(p.usage);
  }
  function doFallback(){
    if(done) return;
    console.warn('[Chat] WS fallback to SSE after ' + reconnectAttempts + ' reconnect attempts');
    streamChatSSE(payload, cb);
    finish();
  }

  function tryReconnect(){
    if(done || reconnectAttempts >= maxReconnects){ doFallback(); return; }
    reconnectAttempts++;
    var delay = reconnectDelay * Math.pow(2, reconnectAttempts - 1); // 2s, 4s, 8s
    console.log('[Chat] WS reconnect attempt ' + reconnectAttempts + '/' + maxReconnects + ' in ' + delay + 'ms');
    cb.onInfo && cb.onInfo('连接中断，正在重连(' + reconnectAttempts + '/' + maxReconnects + ')…');
    setTimeout(function(){
      if(done) return;
      try { ws = new WebSocket(wsChatUrl(payload.session_id)); } catch(e){ doFallback(); return; }
      _msgState.ws = ws;
      var reconnectTimer = setTimeout(function(){
        if(ws && ws.readyState !== WebSocket.OPEN){ try{ ws.close(); }catch(e){} tryReconnect(); }
      }, 10000);
      ws.onopen = function(){
        clearTimeout(reconnectTimer);
        console.log('[Chat] WS reconnected successfully');
        cb.onInfo && cb.onInfo('重连成功，继续接收回复…');
        // 重连后服务器会从缓存返回完整结果
      };
      ws.onmessage = function(e){
        try {
          var p = JSON.parse(e.data);
          if(p.done){ finish(); cb.onDone(false); try{ ws.close(); }catch(ex){} return; }
          handleMsg(p);
        } catch(ex){}
      };
      ws.onerror = function(){
        if(done) return;
        clearTimeout(reconnectTimer);
        tryReconnect();
      };
      ws.onclose = function(ev){
        if(done) return;
        clearTimeout(reconnectTimer);
        if(ev.code !== 1000){ tryReconnect(); }
        else { finish(); cb.onDone(ev.reason === 'user stop'); }
      };
    }, delay);
  }

  // 1) POST 消息入队
  fetch(apiUrl('/api/chat/ws-send'), {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'X-Monitor-Token': monitorToken||'' },
    body: JSON.stringify(payload)
  }).then(function(r){
    if(!r.ok){
      // 403 = 安全网关拦截（tool_guard）→ 携带 blocked 标记走专门兜底
      return r.json().catch(function(){ return {}; }).then(function(j){
        if(j && j.blocked){ var e = new Error(j.error || '消息被安全网关拦截'); e.noFallback = true; throw e; }
        throw new Error('ws-send ' + r.status);
      });
    }
    return r.json();
  }).then(function(j){
    if(done) return;
    // ②治中断（2026-09-22）：后端返回 queued（旧流在跑）→ 轮询 active 直到旧流完成再重发本条消息
    if(j && j.queued){
      cb.onInfo && cb.onInfo('上一轮还在跑，你的消息已排队，它跑完会自动接上…');
      var _retries = 0, _errs = 0;
      var _poll = setInterval(function(){
        fetch(apiUrl('/api/chat/active?session_id='+encodeURIComponent(payload.session_id)), { cache:'no-store', headers:{'X-Monitor-Token':monitorToken||''} })
          .then(function(r){ return r.json(); })
          .then(function(a){
            _errs = 0;
            _retries++;
            if(!a.active){ clearInterval(_poll); streamChat(payload, cb); return; }
            if(_retries > 3600){
              clearInterval(_poll);
              // 故意不 doFallback()：SSE 路径 monitor.js:10733-10736 对 running 流仍会
              // _prevCtrl2.abort() 硬中断，会把 ② 修掉的 bug 从后门引回来。改为提示用户手动重发。
              cb.onInfo && cb.onInfo('上一轮仍在运行，已等待 30 分钟，请稍后手动重发本条消息。');
            }
          })
          .catch(function(){
            _errs++;
            if(_errs > 10){
              clearInterval(_poll);
              cb.onInfo && cb.onInfo('无法确认上一轮状态（网络异常），请稍后手动重发本条消息。');
            }
          });
      }, 500);
      return;
    }
    // 2) 建立 WS 连接取流
    try { ws = new WebSocket(wsChatUrl(payload.session_id)); } catch(e){ doFallback(); return; }
    _msgState.ws = ws;
    _msgState.abortCtrl = { abort: function(){ try{ ws.close(1000, 'user stop'); }catch(e){} } };

    // 30 秒内未 open 则降级（从 15s 延长到 30s，给慢网络更多时间）
    fallbackTimer = setTimeout(function(){
      if(ws && ws.readyState !== WebSocket.OPEN){ try{ ws.close(); }catch(e){} doFallback(); }
    }, 30000);

    ws.onopen = function(){ wsOpened = true; clearTimeout(fallbackTimer); };
    ws.onmessage = function(e){
      try {
        var p = JSON.parse(e.data);
        if(p.done){ finish(); cb.onDone(false); try{ ws.close(); }catch(ex){} return; }
        handleMsg(p);
      } catch(ex){}
    };
    ws.onerror = function(){
      if(done) return;
      clearTimeout(fallbackTimer);
      // 如果 WS 曾连接成功后断开，尝试重连而非直接降级
      if(wsOpened){ tryReconnect(); }
      else { doFallback(); }
    };
    ws.onclose = function(ev){
      if(done) return;
      clearTimeout(fallbackTimer);
      if(ev.code !== 1000){
        console.warn('[Chat] WS closed abnormally code=' + ev.code);
        // 如果 WS 曾连接成功后断开，尝试重连
        if(wsOpened){ tryReconnect(); }
        else { doFallback(); }
      } else {
        // 用户点停止按钮 → chatStop 发 ws.close(1000,'user stop') → 识别为主动停止
        finish(); cb.onDone(ev.reason === 'user stop');
      }
    };
  }).catch(function(err){
    // 安全网关拦截（tool_guard）：还原输入并提示，不降级 SSE 重发
    if(err && err.noFallback){
      try{
        var _body=document.getElementById('chatBody');
        var _ul=_body?_body.querySelector('.msg.user:last-child'):null;
        if(_ul) _ul.remove();
        var _restore = (typeof payload.message==='string') ? payload.message : ((payload.message && payload.message.text)||'');
        if(_restore){
          var ta=document.getElementById('chatInput');
          if(ta){ ta.value=_restore; autoResize(ta); try{ ta.focus(); }catch(e){} }
        }
      }catch(e){}
      toast(err.message || '消息被安全网关拦截');
      return;
    }
    // ws-send 失败 → 直接走 SSE
    doFallback();
  });
}

/* SSE 降级路径（fetch 优先，再降 XHR） */
function streamChatSSE(payload, cb){
  _msgState.streaming = true;
  var controller = new AbortController();
  _msgState.abortCtrl = { abort: function(){ try{ controller.abort(); }catch(e){} } };

  function handleEvent(p){
    if(p.tool_progress) cb.onTool(p.tool_progress);
    else if(p.clarify){ if(window.pwClarifyAsk) window.pwClarifyAsk(p.clarify); }
    else if(p.delta) cb.onDelta(p.delta);
    else if(p.reasoning && cb.onReasoning) cb.onReasoning(p.reasoning);
    else if(p.error) cb.onError(p.error);
    else if(p.info) cb.onInfo(p.info);
    else if(p.usage) cb.onUsage && cb.onUsage(p.usage);
  }

  fetch(apiUrl('/api/chat/stream'), {
    method:'POST',
    headers: { 'Content-Type':'application/json', 'X-Monitor-Token': monitorToken||'' },
    body: JSON.stringify(payload),
    signal: controller.signal
  }).then(function(r){
    if(!r.ok){ cb.onError('HTTP '+r.status); cb.onDone(false); return; }
    var reader = r.body.getReader();
    var dec = new TextDecoder();
    var buf = '';
    function pump(){
      reader.read().then(function(res){
        if(res.done){ cb.onDone(false); return; }
        buf += dec.decode(res.value, { stream:true });
        var events = buf.split('\n\n'); buf = events.pop() || '';
        events.forEach(function(ev){
          ev.split('\n').forEach(function(line){
            if(line.indexOf('data:')===0){
              var data = line.slice(5).trim();
              if(data==='[DONE]') return;
              try { handleEvent(JSON.parse(data)); } catch(e){}
            }
          });
        });
        pump();
      }).catch(function(){ cb.onDone(false); });
    }
    pump();
  }).catch(function(e){
    if(e && e.name==='AbortError'){ cb.onDone(true); return; }
    streamChatXhr(payload, cb);
  });
}
function streamChatXhr(payload, cb){
  var xhr = new XMLHttpRequest();
  _msgState.abortCtrl = { abort: function(){ try{ xhr.abort(); }catch(e){} } };
  var buf='', pos=0, done=false;
  function process(){
    var chunk = buf.slice(pos); pos = buf.length; buf += '';
    var rest = chunk; var events = rest.split('\n\n'); buf = events.pop() || '';
    events.forEach(function(ev){
      ev.split('\n').forEach(function(line){
        if(line.indexOf('data:')===0){
          var data = line.slice(5).trim();
          if(data==='[DONE]') return;
          try { var p=JSON.parse(data); handleXhr(p); } catch(e){}
        }
      });
    });
    function handleXhr(p){
      if(p.tool_progress) cb.onTool(p.tool_progress);
      else if(p.clarify){ if(window.pwClarifyAsk) window.pwClarifyAsk(p.clarify); }
      else if(p.delta) cb.onDelta(p.delta);
      else if(p.reasoning && cb.onReasoning) cb.onReasoning(p.reasoning);
      else if(p.error) cb.onError(p.error);
      else if(p.info) cb.onInfo(p.info);
    }
  }
  xhr.open('POST', apiUrl('/api/chat/stream'), true);
  xhr.setRequestHeader('Content-Type','application/json');
  if(monitorToken) xhr.setRequestHeader('X-Monitor-Token', monitorToken);
  xhr.onprogress = function(){ var t=xhr.responseText; var evs=t.slice(pos).split('\n\n'); buf = t; process(); };
  xhr.onload = function(){ if(done) return; done=true; process(); if(xhr.status>=400) cb.onError('HTTP '+xhr.status); cb.onDone(false); };
  xhr.onerror = function(){ if(done) return; done=true; cb.onError('网络错误'); cb.onDone(false); };
  xhr.onabort = function(){ if(done) return; done=true; cb.onDone(true); };
  xhr.send(JSON.stringify(payload));
}
function chatStop(){
  if(currentSession){
    fetch(apiUrl('/api/chat/stop'), { method:'POST', headers:{'Content-Type':'application/json','X-Monitor-Token':monitorToken||''}, body: JSON.stringify({ session_id: currentSession }) }).catch(function(){});
  }
  if(_msgState.ws){ try{ _msgState.ws.close(1000, 'user stop'); }catch(e){} _msgState.ws=null; }
  if(_msgState.abortCtrl) _msgState.abortCtrl.abort();
}

/* 附件上传（Profile 隔离：profile=当前 Agent，存 profiles/<agent>/uploads/） */
function uploadAttachment(f, url){
  var imageUpload=url==='/api/chat/upload-image',maxBytes=(imageUpload?16:64)*1024*1024;
  if(f.size>maxBytes){toast(imageUpload?'图片超过16MB，请压缩后上传':'文件超过64MB，请放入工作区后附加到对话','error');return Promise.resolve(false);}
  var fd = new FormData();
  fd.append('file', f);
  fd.append('profile', _activeProfileId());
  var hdrs = {}; if(monitorToken) hdrs['X-Monitor-Token']=monitorToken;
  return fetch(apiUrl(url), { method:'POST', body:fd, headers:hdrs })
    .then(function(r){ return r.json(); })
    .then(function(out){
      if(out && !out.error && out.url){
        _pendingAttachments.push({ url:out.url, type:f.type, name:(f.name || 'file') });
        renderAttachChips();
        autoResize(document.getElementById('chatInput'));
        return true;
      }
      toast('上传失败：'+(out && out.error || '服务器没有返回上传原因'));
      return false;
    })
    .catch(function(){ toast('上传失败，无法连接后端'); return false; });
}
function attachFile(){
  var inp = document.createElement('input'); inp.type='file'; inp.style.display='none';
  document.body.appendChild(inp);
  inp.onchange = function(){
    var f = inp.files[0];
    if(!f){ document.body.removeChild(inp); return; }
    var isImg = /^image\//.test(f.type);
    uploadAttachment(f, isImg ? '/api/chat/upload-image' : '/api/chat/upload-file').then(function(ok){
      if(ok) toast('附件已添加：'+f.name);
    });
    document.body.removeChild(inp);
  };
  inp.click();
}
function renderAttachChips(){
  var comp = document.getElementById('chatComposer');
  if(!comp) return;
  var box = document.getElementById('attachChips');
  if(!box){ box=document.createElement('div'); box.id='attachChips'; box.className='attach-chips'; comp.insertBefore(box, comp.firstChild); }
  if(!_pendingAttachments.length){ box.style.display='none'; box.innerHTML=''; return; }
  box.style.display='flex';
  box.innerHTML = _pendingAttachments.map(function(a,i){
    var isImg = a.type && /^image\//.test(a.type);
    var icon = isImg ? '🖼️' : '📎';
    var name = esc(a.name || (isImg ? '图片' : '附件'));
    return '<span class="attach-chip"><span class="file-icon">'+icon+'</span><span class="file-name" title="'+name+'">'+name+'</span><span class="x" onclick="removeAttach('+i+')" title="移除">×</span></span>';
  }).join('');
}
function removeAttach(i){
  _pendingAttachments.splice(i,1);
  renderAttachChips();
  autoResize(document.getElementById('chatInput'));
}

/* 聊天输入框粘贴图片/文件（Ctrl+V）
 * - 图片 → upload-image（Profile 隔离）
 * - 其他文件（如剪贴板文件复制）→ upload-file
 * - 纯文本不拦截，保持原样 */
function onChatPaste(e){
  var cd = (e && e.clipboardData) || window.clipboardData || null;
  if(!cd || !cd.items) return;            // 无剪贴板数据：交给浏览器默认行为
  // 先同步收集所有文件，避免 items 在异步回调中失效
  var files = [];
  for(var i=0;i<cd.items.length;i++){
    var it = cd.items[i];
    if(it.kind === 'file'){
      var f = it.getAsFile();
      if(f) files.push(f);
    }
  }
  if(!files.length) return;              // 纯文本：不拦截，允许默认粘贴
  e.preventDefault();                     // 检测到文件：阻止文本域写入原始数据
  files.forEach(function(f){
    var isImg = /^image\//.test(f.type || '');
    uploadAttachment(f, isImg ? '/api/chat/upload-image' : '/api/chat/upload-file');
  });
}