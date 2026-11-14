/* 多 Agent 圆桌讨论
 * 来源：index.html 内联 app.js 第 3252-3558 行（共 307 行）
 * 2026-11-13 按原分区纯搬运外移，逻辑零改动。全局作用域与执行顺序与原内联块一致。 */

/* ============================ 多 Agent 圆桌讨论 ============================ */
var _rtState = { active:false, agents:[], rounds:2, currentRound:0, history:[], sessionId:null, stopped:false, ended:false };
var _rtCatalog = [];
var RT_CONSENSUS_RE = /\[达成共识\]|\[共识\]|\[结束讨论\]|\[END\]|讨论已达成共识|达成共识|一致通过|已达成一致|无需继续讨论|无异议，可以结束/i;

function openRoundtable(){
  apiGet('/api/workspace-ui/experts?limit=400&details=1').then(function(result){
    _rtCatalog = (result && Array.isArray(result.experts)) ? result.experts : [];
    if(!_rtCatalog.length){ toast('专家目录为空，请先在专家库中启用专家','error'); return; }
    renderRoundtableDialog(_rtCatalog);
  }).catch(function(){ toast('专家目录加载失败，请重试','error'); });
}
function renderRoundtableDialog(agents){
  var html = '<div class="modal-overlay" id="rtOverlay" onclick="if(event.target===this)closeRoundtable()">' +
    '<div class="modal" style="max-width:500px">' +
    '<div class="modal-head"><h3>🎙️ 多 Agent 圆桌讨论</h3><button class="modal-close" aria-label="关闭" title="关闭" onclick="closeRoundtable()">×</button></div>' +
    '<div class="modal-body" style="padding:16px">' +
    '<p style="font-size:13px;color:var(--text2);margin-bottom:14px;line-height:1.5">选择 2 个或以上的专家快照。它们共享当前环境的技能和工具，不会切换全局 Profile。</p>' +
    '<div style="font-size:13px;font-weight:600;margin-bottom:6px;color:var(--text)">参与讨论的专家（点击选择）</div>' +
    '<div class="rt-agent-pick" id="rtAgentPick">' +
    agents.map(function(p){ var id=p.id||p.slug; return '<div class="rt-agent-chip" data-id="'+DOM.escAttr(id)+'" onclick="this.classList.toggle(\'selected\')"><span class="rt-emoji">'+esc(p.emoji||'🤖')+'</span>'+esc(p.name||p.label||id)+'</div>'; }).join('') +
    '</div>' +
    '<div style="font-size:13px;font-weight:600;margin-bottom:6px;color:var(--text)">讨论轮数</div>' +
    '<div class="rt-round-config"><label>轮数</label><input type="number" id="rtRounds" value="2" min="1" max="20" step="1"><span class="rt-round-hint">每位 Agent 每轮发言一次，可根据需要自由设定</span></div>' +
    '<div style="font-size:12px;color:var(--text3);margin-top:4px;line-height:1.5">💡 每轮中各 Agent 会看到前序 Agent 的发言，并进行回应、补充或反驳。轮数越多讨论越深入。</div>' +
    '</div>' +
    '<div class="modal-foot" style="padding:12px 16px;display:flex;justify-content:flex-end;gap:8px">' +
    '<button class="btn" onclick="closeRoundtable()">取消</button>' +
    '<button class="btn primary" onclick="startRoundtable()">🚀 开始讨论</button>' +
    '</div></div></div>';
  var div=document.createElement('div'); div.innerHTML=html; window.ui.adoptOverlay(document.body.appendChild(div.firstChild));
}
function closeRoundtable(){ var el=document.getElementById('rtOverlay'); if(el) el.remove(); }

function startRoundtable(){
  var chips = document.querySelectorAll('#rtAgentPick .rt-agent-chip.selected');
  if(chips.length < 2){ toast('请至少选择 2 个 Agent','error'); return; }
  var agents = [];
  chips.forEach(function(c){
    var id = c.getAttribute('data-id');
    var p = _rtCatalog.find(function(x){ return (x.id||x.slug)===id; });
    agents.push({ id:id, name:(p&& (p.name||p.label))||id, emoji:(p&&p.emoji)||'🤖', prompt:(p&&p.prompt)||'', model:(p&&p.model)||'' });
  });
  var rounds = parseInt(document.getElementById('rtRounds').value) || 2;
  if(rounds < 1) rounds = 1;
  if(rounds > 20){ rounds = 20; toast('轮数已限制为最大 20 轮'); }
  closeRoundtable();
  // 创建新会话
  fetch(apiUrl('/api/sessions'), { method:'POST', headers:monitorToken?{'X-Monitor-Token':monitorToken}:{} })
    .then(function(r){ return r.json(); })
    .then(function(s){
      _rtState = { active:true, agents:agents, rounds:rounds, currentRound:0, history:[], sessionId:s.id, stopped:false, ended:false };
      _sessions.unshift(s); currentSession = s.id;
      _applyPendingModel(s.id);
      _openTabs.push(s.id); persistTabs();
      renderSessionTabs(); renderRail();
      switchPage('chat');
      var titleEl=document.getElementById('chatTitle'); if(titleEl) titleEl.textContent='🎙️ 圆桌: '+agents.map(function(a){return a.name;}).join(' + ');
      var subEl=document.getElementById('chatSubtitle'); if(subEl) subEl.textContent=agents.length+' 位 Agent · '+rounds+' 轮讨论';
      var body=document.getElementById('chatBody');
      if(body){
        body.innerHTML='<div class="system-tip">🎙️ 圆桌讨论已开启：'+agents.map(function(a){return a.emoji+' '+a.name;}).join('、')+' · 共 '+rounds+' 轮</div>' +
          '<div class="rt-divider">请提出议题，各 Agent 将轮流发言讨论</div>';
      }
      toast('🎙️ 圆桌讨论已就绪，请提出议题');
    }).catch(function(){ toast('创建圆桌会话失败','error'); });
}

/* 圆桌模式下的发送：用户提问后各 Agent 轮流发言 */
function rtSend(userText){
  var body=document.getElementById('chatBody'); if(!body) return;
  // 新一轮议题：重置停止/结束标记
  _rtState.stopped = false; _rtState.ended = false;
  // 显示用户消息
  var userDiv=document.createElement('div'); userDiv.className='msg user';
  var liveUserName=typeof chatUserName==='function'?chatUserName():'你';
  userDiv.innerHTML='<div class="chat-sender">'+liveUserName+'</div><div class="msg-bubble">'+escapeHtml(userText).replace(/\n/g,'<br>')+'</div><div class="msg-meta">'+liveUserName+' · '+fmtDateTime(Date.now())+'</div>';
  body.appendChild(userDiv); if(autoScrollActive()) followChatBottom();
  condenseChatBody();
  _rtState.history.push({ role:'user', name:'用户', content:userText });
  _rtState.currentRound = 0;
  rtNextRound();
}

function rtNextRound(){
  if(_rtState.stopped) return;   // 已手动停止：不再开始新轮次
  _rtState.currentRound++;
  if(_rtState.currentRound > _rtState.rounds){
    // 所有轮次结束，让最后一个 Agent 做总结
    rtSummarize();
    return;
  }
  var body=document.getElementById('chatBody');
  var divider=document.createElement('div'); divider.className='rt-divider';
  divider.textContent='第 '+_rtState.currentRound+' / '+_rtState.rounds+' 轮';
  body.appendChild(divider); followChatBottom();
  rtAgentSpeak(0);
}

function rtAgentSpeak(idx){
  if(_rtState.stopped) return;   // 已手动停止：不再发起新发言
  var agents=_rtState.agents;
  if(idx >= agents.length){
    // 本轮结束，进入下一轮
    setTimeout(rtNextRound, 500);
    return;
  }
  var agent=agents[idx];
  var body=document.getElementById('chatBody');
  // 状态条：Agent 发言中（圆桌长任务期间始终有工作反馈）
  genBarShow('thinking', agent.name + ' 正在发言');
  // 显示“正在发言”状态
  var statusDiv=document.createElement('div'); statusDiv.className='rt-status'; statusDiv.id='rtStatus';
  statusDiv.innerHTML='<span class="rt-pulse"></span>'+agent.emoji+' '+esc(agent.name)+' 正在发言…';
  body.appendChild(statusDiv); followChatBottom();

  // 构建 system prompt
  var sys = '【圆桌讨论模式】\n' +
    '你正在参加一场多智能体圆桌讨论。参与者有：' + agents.map(function(a){return a.emoji+a.name;}).join('、') + '。\n' +
    '你的身份是：' + agent.emoji + ' ' + agent.name + '。\n' +
    (agent.prompt ? '你的角色设定：' + agent.prompt + '\n' : '') +
    '规则：\n' +
    '1. 请基于你的专业角度发言，回应其他人的观点。\n' +
    '2. 可以赞同、补充、反驳其他 Agent 的意见。\n' +
    '3. 发言简洁有力，每次不超过 300 字。\n' +
    '4. 如果是最后一轮，请给出你的最终结论和建议。\n' +
    '5. 如果你认为讨论已经达成共识、无需继续讨论，请在发言末尾单独一行输出「[达成共识]」。\n' +
    '6. 若其他 Agent 已达成共识，请直接表示同意并在发言末尾输出「[达成共识]」。';

  // 构建上下文消息（截断：保留议题 + 最近 50 条，30 万字符硬上限，防止超长导致 400）
  var contextMsg = rtBuildContext(300000);
  contextMsg += '现在请你（' + agent.name + '）发言。';

  // 创建消息气泡
  var asst=document.createElement('div'); asst.className='msg assistant rt-agent';
  asst.innerHTML='<div class="rt-speaker"><span class="rt-sp-emoji">'+agent.emoji+'</span>'+esc(agent.name)+'</div>' +
    '<div class="msg-bubble"><div class="md-text"><span class="cursor-blink">|</span></div></div>' +
    '<div class="msg-meta">'+esc(agent.name)+' · '+fmtDateTime(Date.now())+'</div>';
  body.appendChild(asst); followChatBottom();
  var mdEl=asst.querySelector('.md-text');
  var fullText='';

  streamChat({
    session_id: _rtState.sessionId,
    message: contextMsg,
    system: sys,
    model: agent.model || undefined
  }, {
    onDelta: function(d){ _genLastEventTs=Date.now(); fullText+=d; _throttledRender('rt1', function(){ mdEl.innerHTML=renderMarkdown(fullText,true); followChatBottom(); }, 100); },
    onTool: function(tp){
      // 圆桌同样实时同步状态条：Agent/写代码/搜索等按工具类型显示
      _genLastEventTs=Date.now();
      var _gs = genToolState(tp.tool);
      genBarShow(_gs.icon, _gs.text);
    },
    onReasoning: function(){ _genLastEventTs=Date.now(); genBarShow('reasoning','正在思考'); },
    onInfo: function(){ _genLastEventTs=Date.now(); genBarShow('thinking','正在思考'); },
    onError: function(err){
      genBarDone('error','回复出错');
      mdEl.innerHTML='<span class="error-text">⚠ '+esc(err)+'</span>';
      if(_rtState.stopped) return;
      rtAfterAgent(idx);
    },
    onDone: function(stoppedByUser){
      if(_rtState.stopped){ genBarDone('stopped','已停止'); return; }
      if(stoppedByUser){
        // 用户点击停止按钮：终止整场圆桌，不再轮转下一个 Agent
        rtStopRoundtable('⏹ 已手动停止圆桌讨论');
        return;
      }
      genBarDone('done','回复完成');
      mdEl.innerHTML=renderMarkdown(fullText);
      condenseChatBody();
      _rtState.history.push({ role:'assistant', name:agent.name, emoji:agent.emoji, content:fullText });
      // 共识检测：某 Agent 明确表示达成共识 → 提前结束并自动出总结
      if(rtCheckConsensus(fullText)){
        rtEndEarly();
        return;
      }
      rtAfterAgent(idx);
    }
  });
}

function rtAfterAgent(idx){
  var st=document.getElementById('rtStatus'); if(st) st.remove();
  if(_rtState.stopped) return;   // 已手动停止：不继续轮转
  setTimeout(function(){ rtAgentSpeak(idx+1); }, 600);
}

/* 构建圆桌上下文（截断版）：始终保留议题（首条用户消息）+ 最近 50 条发言，
 * 总长不超过 maxChars 字符（默认 30 万），超出部分用省略标记代替。
 * 防止 20 轮长讨论后 prompt 无限膨胀（曾实测超 420 万字符触发网关 400）。 */
function rtBuildContext(maxChars){
  maxChars = maxChars || 300000;
  var hist = _rtState.history || [];
  var parts = [];
  var used = 0;
  var omitted = 0;
  // 从最新往回构建：优先保留最近的发言
  for(var i = hist.length - 1; i >= 0; i--){
    var h = hist[i];
    if(!h || !h.content) continue;
    if(parts.length >= 50){ omitted++; continue; }   // 最多保留最近 50 条
    var line = '【' + h.name + '】: ' + h.content + '\n\n';
    if(used + line.length > maxChars){ omitted++; continue; }
    parts.unshift(line);
    used += line.length;
  }
  // 议题（首条用户消息）必须保留，避免 Agent 丢失讨论目标
  var firstUser = null;
  for(var j = 0; j < hist.length; j++){
    if(hist[j].role === 'user' && hist[j].name === '用户'){ firstUser = hist[j]; break; }
  }
  var head = '以下是目前的讨论记录：\n';
  if(firstUser && firstUser.content){
    head += '【用户】: ' + String(firstUser.content).slice(0, 2000) + '\n\n';
  }
  if(omitted > 0){
    head += '（较早的 ' + omitted + ' 条记录已省略，上下文保持精简）\n\n';
  }
  return head + parts.join('');
}

/* 共识检测：Agent 发言中带有明确共识/结束标记 → 提前结束讨论 */
function rtCheckConsensus(text){
  return RT_CONSENSUS_RE.test(String(text || ''));
}

/* 用户手动停止：整场圆桌终止，不再轮转，不触发总结 */
function rtStopRoundtable(reason){
  if(_rtState.ended) return;
  _rtState.ended = true; _rtState.stopped = true;
  var st = document.getElementById('rtStatus'); if(st) st.remove();
  var body = document.getElementById('chatBody');
  if(body){
    var d = document.createElement('div'); d.className = 'rt-divider';
    d.textContent = reason || '⏹ 圆桌讨论已停止';
    body.appendChild(d); followChatBottom();
  }
  genBarDone('stopped', '已停止');
}

/* 共识达成：提前结束所有轮次，自动进入主持人总结 */
function rtEndEarly(){
  if(_rtState.ended) return;
  _rtState.ended = true; _rtState.stopped = true;
  var st = document.getElementById('rtStatus'); if(st) st.remove();
  var body = document.getElementById('chatBody');
  if(body){
    var d = document.createElement('div'); d.className = 'rt-divider';
    d.textContent = '✅ 讨论已达成共识，提前结束（共 ' + _rtState.currentRound + ' 轮）';
    body.appendChild(d); followChatBottom();
  }
  setTimeout(rtSummarize, 800);
}

function rtSummarize(){
  var body=document.getElementById('chatBody');
  var divider=document.createElement('div'); divider.className='rt-divider';
  divider.textContent='📝 综合总结';
  body.appendChild(divider); followChatBottom();

  var statusDiv=document.createElement('div'); statusDiv.className='rt-status'; statusDiv.id='rtStatus';
  statusDiv.innerHTML='<span class="rt-pulse"></span>📝 正在生成综合方案…';
  body.appendChild(statusDiv); followChatBottom();
  genBarShow('generating','主持人正在生成综合方案');

  // 同样使用截断上下文（主持人总结容量放宽到 40 万字符，防 400）
  var summaryMsg = rtBuildContext(400000);
  summaryMsg += '请作为主持人，综合以上所有 Agent 的讨论，给出最终的综合方案。包括：\n1. 各方核心观点摘要\n2. 共识与分歧\n3. 最终推荐方案\n4. 注意事项';

  var asst=document.createElement('div'); asst.className='msg assistant rt-agent';
  asst.innerHTML='<div class="rt-speaker"><span class="rt-sp-emoji">📝</span>主持人 · 综合总结</div>' +
    '<div class="msg-bubble" style="border-left-color:#10b981"><div class="md-text"><span class="cursor-blink">|</span></div></div>' +
    '<div class="msg-meta">综合方案 · '+fmtDateTime(Date.now())+'</div>';
  body.appendChild(asst); followChatBottom();
  var mdEl=asst.querySelector('.md-text');
  var fullText='';

  streamChat({
    session_id: _rtState.sessionId,
    message: summaryMsg,
    system: '你是圆桌讨论的主持人，负责综合所有参与者的发言给出最终方案。请客观、全面、结构化地总结。'
  }, {
    onDelta: function(d){ _genLastEventTs=Date.now(); fullText+=d; _throttledRender('rt2', function(){ mdEl.innerHTML=renderMarkdown(fullText,true); followChatBottom(); }, 100); },
    onTool: function(tp){ _genLastEventTs=Date.now(); var _gs=genToolState(tp.tool); genBarShow(_gs.icon,_gs.text); },
    onReasoning: function(){ _genLastEventTs=Date.now(); genBarShow('reasoning','正在思考'); },
    onInfo: function(){ _genLastEventTs=Date.now(); genBarShow('thinking','正在思考'); },
    onError: function(err){ _rtState.ended=true; _rtState.stopped=true; genBarDone('error','回复出错'); mdEl.innerHTML='<span class="error-text">⚠ '+esc(err)+'</span>'; var st=document.getElementById('rtStatus'); if(st) st.remove(); },
    onDone: function(stoppedByUser){
      _rtState.ended=true; _rtState.stopped=true;
      if(stoppedByUser){ genBarDone('stopped','已停止'); var st1=document.getElementById('rtStatus'); if(st1) st1.remove(); return; }
      genBarDone('done','圆桌讨论完成');
      mdEl.innerHTML=renderMarkdown(fullText);
      condenseChatBody();
      var st=document.getElementById('rtStatus'); if(st) st.remove();
      var done=document.createElement('div'); done.className='rt-divider';
      done.textContent='✅ 圆桌讨论结束';
      body.appendChild(done); followChatBottom();
      _rtState.history.push({ role:'assistant', name:'主持人', content:fullText });
      toast('✅ 圆桌讨论完成');
      loadSessions();
    }
  });
}