/* Durable execution transport and per-session drafts. No model request is owned by a tab. */
(function () {
  'use strict';
  const subscriptions = new Map(), localDrafts = new Map(), draftTimers = new Map(), draftRetryTimers = new Map(), draftDurability = new Map(), acceptedOutbox = new Set();
  const terminal = new Set(['done', 'failed', 'cancelled', 'interrupted']);
  /* 判「流死了」的静默窗口。服务端每 15s 发一条 keepalive，取 2.6 倍余量；
     12s 会跟 keepalive 打架，把「模型在思考」误判成断线。 */
  const STALL_MS = 40000;
  const labels = {pending:'等待执行',running:'正在执行',done:'已完成',failed:'执行失败',cancelled:'已取消',interrupted:'等待恢复确认'};
  let jobs = [], refreshing = false, clientId, queueTimer, currentDraft = 'new', applyingDraft = false;
  const E = window.escapeHtml;
  function uuid() { return crypto.randomUUID ? crypto.randomUUID() : 'r'+Date.now().toString(36)+Math.random().toString(36).slice(2); }
  function read(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; } }
  function write(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
  clientId = read('panel-client-id', null) || uuid(); try{write('panel-client-id', clientId);}catch{}
  const outboxKey = 'panel-message-outbox-v2';
  function remember(payload) { const items = read(outboxKey, {}); items[payload.request_id] = payload; write(outboxKey, items); }
  function forget(id) { const items = read(outboxKey, {}); delete items[id]; write(outboxKey, items); }
  function forgetAccepted(id){acceptedOutbox.add(id);try{forget(id);acceptedOutbox.delete(id);}catch{/* Retry local cleanup separately from the acknowledged execution. */}}
  async function request(path, method, body, signal) {
    const response = await fetch(apiUrl(path), {method:method || 'GET',cache:'no-store',signal,
      headers:{'Content-Type':'application/json','X-Monitor-Token':monitorToken || ''},body:body === undefined ? undefined : JSON.stringify(body)});
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error || '操作失败（'+response.status+'）'), {status:response.status, result});
    return result;
  }
  function sessionBusy(sid) { return jobs.some(j => j.session_id === sid && j.status === 'running'); }
  function updateSend() {
    const active = [...subscriptions.values()].some(s => s.sid === currentSession && !s.finished && s.status === 'running') || sessionBusy(currentSession);
    _msgState.streaming = active; setSendState(active);
    const input=document.getElementById('chatInput');if(input)autoResize(input);
  }
  function finish(state, status, error) {
    if (state.finished) return;
    state.finished = true; state.controller?.abort(); clearTimeout(state.retry); clearInterval(state.stall);
    subscriptions.delete(state.id);
    state.cb.onDone?.(status === 'cancelled' || status === 'interrupted');
    if (error && status !== 'cancelled') state.cb.onError?.(error);
    _tabStreaming[state.sid] = [...subscriptions.values()].some(s => s.sid === state.sid && !s.finished);
    renderSessionTabs(); updateSend(); refreshQueue();
  }
  function event(state, packet) {
    if (state.finished || packet.keepalive) return;
    if (packet.storage_error) { state.cb.onInfo?.(packet.storage_error); return; }
    if (packet.seq && packet.seq <= state.seq && !packet.snapshot) return;
    if (packet.seq) state.seq = packet.seq;
    if (packet.snapshot) {
      const j=packet.snapshot,r=j.result||{};state.status=j.status;
      state.cb.onSnapshot?.(j);
      const text=r.reply||'';
      if (text.startsWith(state.text)) { const delta=text.slice(state.text.length);if(delta)state.cb.onDelta?.(delta); }
      else if (state.cb.onReplace) state.cb.onReplace(text);
      state.text=text;
      if (r.reasoning?.startsWith(state.reasoning)) { const d=r.reasoning.slice(state.reasoning.length);if(d)state.cb.onReasoning?.(d); }
      state.reasoning=r.reasoning||'';
      (r.tools||[]).forEach(t=>state.cb.onTool?.(t));
      if(r.usage)state.cb.onUsage?.(r.usage);
      // 2026-11-12：刷新/重连后把还挂着的确认卡补回来（服务端 job.pending_clarify 落盘）。
      // 只在没结束的状态下补，已完结的执行记录里那张卡已经作废。
      if(!terminal.has(j.status)&&j.pending_clarify){try{window.pwClarifyAsk?.(j.pending_clarify);}catch(e){}}
      if(terminal.has(j.status)){finish(state,j.status,r.error);return;}
      /* 排队那句不写正文（2026-11-13 用户第 44 条）：状态条已经写着「⏳排队中，轮到它会自动开始」，
         底下再挂一行「消息已保存，轮到时会自动执行」就是同一句话说两遍。 */
      if(j.status!=='pending') state.cb.onInfo?.(r.info||'已恢复执行进度');
      updateSend();return;
    }
    if(packet.status)state.status=packet.status;
    for(const p of packet.events||[]){
      if(p.delta){state.text+=p.delta;state.cb.onDelta?.(p.delta);}
      if(p.reasoning){state.reasoning+=p.reasoning;state.cb.onReasoning?.(p.reasoning);}
      if(p.tool_progress)state.cb.onTool?.(p.tool_progress);
      if(p.usage)state.cb.onUsage?.(p.usage);
      if(p.info)state.cb.onInfo?.(p.info);
      // clarify：agent 停下来等选择 → 排队链路里也要出卡片（持久化队列是面板的真实通道，
      // 不走 streamChat/streamChatSSE，所以这里必须单独接一次）
      if(p.clarify){try{window.pwClarifyAsk?.(p.clarify);}catch(e){}}
    }
    if(packet.done)finish(state,packet.status,packet.error);
    updateSend();
  }
  async function subscribe(state) {
    if(state.finished)return;
    const controller=new AbortController();state.controller=controller;
    state.lastFrame=Date.now();state.stalled=false;
    /* 手机切网/休眠会把 SSE 的 TCP 挂死：fetch 不抛错，流只是不再来数据。
       不主动掐掉的话 driven 会一直是 true（挡住下面 4s 队列轮询补状态），
       顶栏就永远停在「排队中」，clarify 卡片也永远等不到（2026-11-12 用户手机实测）。 */
    clearInterval(state.stall);
    state.stall=setInterval(function(){
      if(state.finished){clearInterval(state.stall);return;}
      if(Date.now()-(state.lastFrame||0)<=STALL_MS)return;
      clearInterval(state.stall);
      state.stalled=true;state.failures=0;
      /* 静默重连：服务端 queue 事件流每 15s 一条 keepalive，真挂死时重连一帧快照就把状态补齐，
         没必要拿「连接卡住了」吓人（2026-11-12：clarify 选完模型要想十几秒，12s 阈值天天误报）。 */
      try{controller.abort();}catch(e){}
    },5000);
    try {
      const r=await fetch(apiUrl('/api/chat/queue/'+state.id+'/events'),{headers:{'X-Monitor-Token':monitorToken||''},cache:'no-store',signal:controller.signal});
      if(!r.ok)throw Object.assign(Error('执行进度连接失败（'+r.status+'）'),{status:r.status});
      const reader=r.body.getReader(),dec=new TextDecoder();let buffer='';state.failures=0;
      try{
        while(!state.finished){const chunk=await reader.read();if(chunk.done)break;state.lastFrame=Date.now();buffer+=dec.decode(chunk.value,{stream:true});
          let boundary;while((boundary=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);
            for(const line of frame.split('\n'))if(line.startsWith('data: '))event(state,JSON.parse(line.slice(6)));
          }
        }
      }finally{reader.releaseLock();}
      if(!state.finished)throw Error('连接已断开');
    }catch(e){
      if(state.finished)return;
      clearInterval(state.stall);
      const stalled=state.stalled;state.stalled=false;
      if(!stalled)state.cb.onInfo?.('连接中断，正在恢复进度。消息已保存在服务端。');
      if(e.status===401)await fetchToken().catch(()=>{});
      state.failures=stalled?0:state.failures+1;
      state.retry=setTimeout(()=>subscribe(state),stalled?300:Math.min(15000,1000*2**Math.min(state.failures,4)));
    }
  }
  async function submit(payload, cb) {
    // 2026-11-12：前面那条还挂着一张没人答的确认卡时，新消息会排在它后面一直发不出去。
    // 用户既然发了新消息，就把卡片按「跳过」结掉，让阻塞的线程先收尾。
    try{if(typeof window.pwClarifyDismissPending==='function')window.pwClarifyDismissPending();}catch(e){}
    const id=payload.request_id,existing=subscriptions.get(id);
    if(existing)return;
    const state={id,sid:payload.session_id,cb,text:'',reasoning:'',seq:0,status:'pending',finished:false,failures:0};
    subscriptions.set(id,state);
    try{window.genBarReset?.(state.sid);}catch{}
    try{
      const result=await request('/api/chat/queue','POST',payload);
      forgetAccepted(id);state.status=result.job.status;
      cb.onAccepted?.(result.job);
      refreshQueue();subscribe(state);
    }catch(e){
      subscriptions.delete(id);
      _tabStreaming[state.sid]=false;renderSessionTabs();updateSend();
      // Uncertain network result stays in the browser outbox and is retried with the same ID.
      if(!e.status||e.status>=500){cb.onInfo?.('暂时无法确认接收，消息已保存在本机，连接恢复后会继续核对。');pendingCallbacks.set(id,cb);}
      else{try{forget(id);}catch{}cb.onError?.(e.message);cb.onDone?.(false);restoreUnsent(payload);}
      refreshQueue();
    }
  }
  function restoreUnsent(payload){
    const sid=payload.session_id,text=typeof payload.message==='string'?payload.message:payload.message?.text||'';
    const draft=getDraft(sid);if(!draft.text){draft.text=text;draft.dirty=true;saveLocal(sid,draft);if(sid===currentSession)restoreDraft(sid);}
  }
  window.streamChat=function(payload,cb){
    payload={...payload,request_id:payload.request_id||uuid()};
    try{remember(payload);}catch(e){restoreUnsent(payload);cb.onError?.('浏览器存储已满，消息未发送。请保留输入后清理空间。');cb.onDone?.(false);return;}
    clearSentDraft(payload.session_id,typeof payload.message==='string'?payload.message:(payload.message&&payload.message.text)||'');
    submit(payload,cb);
  };
  // Legacy fallback functions used by older integrations now enter the same queue.
  window.streamChatSSE=window.streamChat;window.streamChatXhr=window.streamChat;
  window.chatStop=async function(){
    try{
      const running=jobs.find(j=>j.session_id===currentSession&&j.status==='running')||[...subscriptions.values()].find(s=>s.sid===currentSession&&s.status==='running');
      if(running)await request('/api/chat/queue/'+running.id+'/cancel','POST',{});
      else await request('/api/chat/stop','POST',{session_id:currentSession});
      refreshQueue();
    }catch(e){toast('停止未确认：'+e.message);}
  };
  /* 单条取消：给「还没执行」的气泡下方那个「取消」按钮用（不是全停）。
     /api/chat/queue/:id/cancel 对 pending 是直接从队列摘掉，对 running 才是中断，
     所以这里允许点 running 的也没关系，行为等同 chatStop 的单条版。 */
  window.cancelQueueJob=async function(id){
    if(!id)return;
    try{
      await request('/api/chat/queue/'+id+'/cancel','POST',{});
      toast('已取消这条');
      refreshQueue();
    }catch(e){toast('取消失败：'+e.message);}
  };
  function messageText(j){const m=j.message;return typeof m==='string'?m:m?.text||'含附件的消息';}
  /* 2026-11-13（用户第 5 条后半）：刷新后只看得见「一条在跑 + 一条排队」。
     不是队列丢数据——服务端 jobs 是全的——而是还没执行的消息只存在队列里，
     会话消息文件里根本没有它，重绘历史时自然画不出来。
     这里按队列给还没执行的每条补一个占位气泡（data-request-id = job.id），
     真消息落盘后由 renderTurn/重绘接管，占位自己退出。 */
  function syncPendingBubbles(live){
    const body=document.getElementById('chatBody');if(!body)return;
    const alive={};(live||[]).forEach(j=>{alive[j.id]=j.status==='running'?'running':'queued';});
    [...body.querySelectorAll('.msg.user.pw-queue-ph')].forEach(el=>{
      const id=el.getAttribute('data-request-id');
      const dup=id?body.querySelectorAll('.msg.user[data-request-id="'+id+'"]').length:0;
      if(!alive[id]||dup>1)el.remove();
    });
    (live||[]).forEach((j,i)=>{
      if(body.querySelector('.msg.user[data-request-id="'+j.id+'"]'))return;
      const running=j.status==='running';
      const el=document.createElement('div');
      /* 正在跑那条也可能只剩助手侧（历史里还没写用户消息）：占位要跟着换成"正在处理"，
         不能再挂"排队中"，否则明明是它在跑，文案却说还在等（2026-11-13 第 44 条）。 */
      el.className='msg user pw-queue-ph '+(running?'running':'queued');
      el.setAttribute('data-request-id',j.id);
      /* 2026-11-13（用户第 52 条）：占位气泡以前只有一个「取消」，正常气泡是「复制 / 引用」两个，
         用户看到的就是「队列消息框只剩一个按钮」。这里把复制/引用补齐，取消由 _markRunningMsg
         追加到同一个 .msg-actions 里，最终三个。
         data-content 必须写：copyMsg/quoteMsg 优先读它，读不到会退 textContent，
         那样「排队中，前面还有 N 条」会被一起复制进去。 */
      const _txt=messageText(j);
      el.setAttribute('data-content',escapeHtml(_txt).replace(/"/g,'&quot;').replace(/\n/g,'&#10;'));
      el.innerHTML='<div class="chat-sender">你</div><div class="msg-bubble">'+escapeHtml(_txt).replace(/\n/g,'<br>')+
        '<div class="msg-q-note">'+(running?'正在处理':('排队中'+(i>0?('，前面还有 '+i+' 条'):'')))+'</div></div>'+
        '<div class="msg-actions">'+
          '<button class="msg-act-btn" onclick="copyMsg(this)" title="复制"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 0-2-2V4a2 2 0 0 0 2-2h9a2 2 0 0 0 2 2v1"/></svg>复制</button>'+
          '<button class="msg-act-btn" onclick="quoteMsg(this)" title="引用回复"><svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>引用</button>'+
        '</div>'+
        '<div class="msg-meta">你 · '+fmtDateTime(Date.now())+'</div>';
      /* 助手侧已经在场就贴在它前面插（2026-11-13 用户第 56 条）：append 到末尾再靠
         orderQueuePairs 搬回来是两次「移除+插入」，动画重播、看上去一抽。 */
      const _aSame=body.querySelector('.msg.assistant[data-request-id="'+j.id+'"]');
      if(_aSame && _aSame.parentNode===body) body.insertBefore(el,_aSame); else body.appendChild(el);
      try{window.hpDrawTail&&window.hpDrawTail(el);}catch(e){}
    });
    /* 建完立刻成对重排（2026-11-13 第 54 条）：以前只靠 refreshQueue 每 4s 调一次
       resyncQueueFx 才排，用户连发五条会先看到「我的五条一堆、助手卡一堆」，约 7 秒后才恢复。 */
    try{orderQueuePairs((live||[]).map(j=>j.id));}catch(e){}
  }
  window.pwSyncPendingBubbles=syncPendingBubbles;
  /* 一次把「排队/运行」这一层效果补全（2026-11-13 用户第 44 条）。
     为什么要单独抽一个：refreshQueue 每 4s 才跑一次，而 chatBody 会被整片重绘
     （本轮结束前 100ms 的 loadSessionMessages、切会话、pollSessionSync 都会）。
     重绘后排队气泡、呼吸灯、取消按钮、正在跑那条的状态栏一起消失，用户看到的就是
     「先一个气泡在处理，过几秒又闪出两条排队」。所以重绘完必须同一帧补回来。
     另外一个用途：刚 POST 出去那几条还没进服务端快照，靠本地 views 先标成排队，
     否则「连发三条」的头几秒后两条既没呼吸灯也没取消按钮。 */
  /* 抽搐的源头（2026-11-13 用户第 56 条）：这个函数在「切会话 / 历史重绘 / 每 4s 轮询 /
     每条 accepted 事件」里都会被调，切一次会话能在一个 tick 里连调好几次，
     每次都把排队气泡重画、把成对节点重新 append 到尾部 —— 实测 147 次 childList 抖动。
     对策：同一帧只跑一次（rAF 合并）；历史整片重绘期间直接让位，等画完再来。 */
  let _resyncPending=false,_resyncBusy=false;
  function resyncQueueFx(){
    if(!currentSession) return;
    if(window._pwHistoryRendering) return;
    if(_resyncPending||_resyncBusy) return;
    _resyncPending=true;
    const run=function(){
      _resyncPending=false;
      if(_resyncBusy) return;
      _resyncBusy=true;
      try{_resyncApply();}catch(e){}finally{_resyncBusy=false;}
    };
    if(window.requestAnimationFrame) requestAnimationFrame(run); else setTimeout(run,0);
  }
  function _resyncApply(){
    const body=document.getElementById('chatBody'); if(!body) return;
    /* 服务端 /api/chat/queue 的 list() 按 created_at 倒序返回（panel-queue.js:66），
       直接用就是「最新那条排最前」，用户连发 1~5 看到的是 1 5 4 3 2（2026-11-13 第 54 条）。
       队列顺序在这里统一升序：先按入队序号 order，再退回 created_at。 */
    const mine=jobs.filter(j=>j.session_id===currentSession)
      .sort((a,b)=>((a.order||a.created_at||0)-(b.order||b.created_at||0)));
    const runJob=mine.find(j=>j.status==='running');
    const pend=mine.filter(j=>j.status==='pending');
    const known=new Set(jobs.map(j=>j.id));
    const _locals=[...views.values()].filter(v=>v.sid===currentSession&&!terminal.has(v.status)&&!known.has(v.id));
    const localRun=_locals.find(v=>v.status==='running');
    const localPend=_locals.filter(v=>v.status!=='running');
    const runId=runJob?runJob.id:(localRun?localRun.id:null);
    const allPend=pend.concat(localPend.map(v=>({id:v.id,session_id:v.sid,message:v.message,status:'pending'})));
    if(!runId&&!allPend.length){
      /* 队列真空 = 这一批全跑完了：把环和「取消」收干净。历史重绘保住的是旧节点，
         .running/.queued 类不会自己掉，留着就是完成态还挂着跑马灯（第 44 条）。 */
      try{window._markRunningMsg&&window._markRunningMsg(false);}catch(e){}
      return;
    }
    const runObj=runJob||(localRun?{id:localRun.id,session_id:localRun.sid,message:localRun.message,status:'running'}:null);
    /* 先补订阅气泡，再补占位：顺序反了 renderTurn 只补助手侧，用户侧会停在占位壳上 */
    for(const st of subscriptions.values()){
      if(st.finished||st.sid!==currentSession)continue;
      const v=views.get(st.id);if(!v)continue;
      const node=document.querySelector('.msg.assistant[data-request-id="'+v.id+'"]');
      const unode=document.querySelector('.msg.user[data-request-id="'+v.id+'"]');
      /* 两侧都要在：只剩助手侧的时候，用户那条会在历史重绘后整段消失几秒，
         看上去就是「排队消息闪一下不见了」（2026-11-13 用户第 44 条）。 */
      if(!node||!unode){try{renderTurn(v);}catch(e){}}
    }
    try{syncPendingBubbles(runObj?[runObj].concat(allPend):allPend);}catch(e){}
    /* 状态以服务端队列为真源回填（2026-11-13 用户第 44 条）：那条已经开始跑了，
       气泡上还挂着「⏳排队中」——因为订阅是接手之后才建的，onSnapshot 的翻转没人收。
       这里按 jobs 把 status/live 对齐，再让 renderTurn 重画一次。 */
    for(const j of mine){
      const v=views.get(j.id);if(!v)continue;
      if(j.status==='running'){
        v.status='running';
        if(!v.live||v.live.mode==='queued')v.live={mode:v.text?'generating':'thinking',text:v.text?'正在回复':'正在思考',icon:v.text?'💬':'🤔'};
      }else if(j.status==='pending'){
        v.status='pending';
        if(!v.live||v.live.mode!=='queued')v.live={mode:'queued',text:'排队中，轮到它会自动开始',icon:'⏳'};
      }else continue;
      /* 状态和文案都没变就别重画：resync 每轮都走一遍，无条件 renderTurn 等于把每张卡
         重建一次（innerHTML 重写、动画重播），4s 一次的闪烁/重排就是这么来的。 */
      const _a=document.querySelector('.msg.assistant[data-request-id="'+j.id+'"]');
      const _u=document.querySelector('.msg.user[data-request-id="'+j.id+'"]');
      const _sig=j.status+'|'+(v.live?(v.live.mode+'|'+(v.live.text||'')):'');
      if(_a&&_u&&v._rsSig===_sig) continue;
      v._rsSig=_sig;
      try{renderTurn(v);}catch(e){}
    }
    try{window._markRunningMsg&&window._markRunningMsg(true,runId?'running':'queued',runId,allPend.map(j=>j.id));}catch(e){}
    /* 2026-11-13（用户第 52 条）：连发三条刷新后是「我的三条在最上、助手三张排队卡在最下」。
       原因是占位气泡和助手卡各自 append 到尾部，谁先谁后取决于哪条路径先跑，
       于是两组各自成块。这里按队列顺序把成对的节点重排一遍：u1,a1,u2,a2,u3,a3。
       只搬 id 在活队列里的节点，历史已完成的消息不动。 */
    try{orderQueuePairs([runId].concat(allPend.map(j=>j.id)));}catch(e){}
  }
  /* 按队列顺序把「用户气泡 + 对应助手气泡」成对搬到尾部；缺一侧就只搬有的那一侧，
     后补出来的另一侧自然接在后面（appendChild 不会把已有节点留在旧位置）。 */
  window.pwOrderQueuePairs=orderQueuePairs;   /* 供自检/回归用：输入 id 序列，把成对节点重排 */
  function orderQueuePairs(ids){
    const body=document.getElementById('chatBody'); if(!body||!ids||!ids.length) return;
    const seq=[];
    ids.forEach(id=>{
      if(!id) return;
      const u=body.querySelector('.msg.user[data-request-id="'+id+'"]'); if(u) seq.push(u);
      const a=body.querySelector('.msg.assistant[data-request-id="'+id+'"]'); if(a) seq.push(a);
    });
    if(seq.length<2) return;
    /* 顺序已经对了就一个节点都别动：appendChild 即便位置不变也是一次「移除+插入」，
       节点的 CSS 动画会从头播、秒表跟着跳 —— 每 4s 一次的抽搐就是这么来的。 */
    const kids=[...body.children];
    let prev=-1, ordered=true;
    for(const n of seq){ const i=kids.indexOf(n); if(i<0) continue; if(i<prev){ordered=false;break;} prev=i; }
    if(ordered) return;
    seq.forEach(n=>body.appendChild(n));
  }
  window.pwResyncQueueFx=resyncQueueFx;
  /* 自检出口：刷新后状态栏没画出来时，先看数据层到底有没有这条、status/live 是什么。
     只读，不改任何状态。 */
  window.pwQueueDebug=function(){
    return {
      session: currentSession,
      jobs: jobs.filter(j=>j.session_id===currentSession).map(j=>({id:j.id,status:j.status,order:j.order,created_at:j.created_at})),
      views: [...views.values()].map(v=>({id:v.id,sid:v.sid,status:v.status,live:v.live||null,textLen:(v.text||'').length})),
      subs: [...subscriptions.keys()],
      channel: !!_channelViewActive
    };
  };
  /* 历史重绘前要知道「哪些气泡正活着」，好把它们连 DOM 搬过去（见 tabs.js loadSessionMessages） */
  window.pwLiveQueueIds=function(){
    const out=new Set();
    jobs.forEach(j=>{if(j.session_id===currentSession&&(j.status==='pending'||j.status==='running'))out.add(j.id);});
    views.forEach(v=>{if(v.sid===currentSession&&!terminal.has(v.status))out.add(v.id);});
    return [...out];
  };
  function renderQueue(){
    const composer=document.getElementById('chatComposer');if(!composer)return;
    let panel=document.getElementById('durableQueue');
    if(!panel){panel=document.createElement('section');panel.id='durableQueue';panel.className='durable-queue';panel.setAttribute('aria-label','消息执行队列');composer.prepend(panel);}
    const visible=jobs.filter(j=>j.session_id===currentSession),outbox=Object.values(read(outboxKey,{})).filter(p=>p.session_id===currentSession&&!acceptedOutbox.has(p.request_id)&&!visible.some(j=>j.id===p.request_id));
    /* 只有「真出问题」才允许它露头：failed / interrupted / 未确认的外发消息。
       正常执行中（pending/running）一律不显示——执行状态只由标题行短句 + 消息气泡跑马灯表达，
       用户明确要求底部不许有提示条（2026-11-11 第 28 条）。 */
    const alarms=visible.filter(j=>j.status==='failed'||j.status==='interrupted');
    if(!alarms.length&&!outbox.length){ panel.hidden=true; panel.innerHTML=''; return; }
    panel.hidden=false;
    panel.innerHTML=(alarms.length?alarms:visible).map(j=>'<div class="dq-item"><span class="dq-status '+E(j.status)+'">'+E(labels[j.status])+'</span><span class="dq-text" title="'+E(messageText(j))+'">'+E(messageText(j).slice(0,90))+'</span>'+(j.status==='interrupted'?'<button data-queue-resolve="'+j.id+'">已查看，继续后续消息</button>':'<button data-queue-cancel="'+j.id+'">'+(j.status==='running'?'停止':'取消')+'</button>')+'</div>').join('')+
      outbox.map(p=>'<div class="dq-item"><span class="dq-status">等待连接确认</span><span class="dq-text">'+E(messageText({message:p.message}).slice(0,90))+'</span><button data-outbox-retry="'+p.request_id+'">重试</button></div>').join('');
  }
  const pendingCallbacks=new Map();
  async function resumeOutbox(){
    for(const p of Object.values(read(outboxKey,{}))){
      if(acceptedOutbox.has(p.request_id)){forgetAccepted(p.request_id);continue;}
      if(subscriptions.has(p.request_id))continue;
      // After reload, the normal session sync renders the authoritative messages.
      let view=views.get(p.request_id);if(!view){view={id:p.request_id,sid:p.session_id,message:p.message,created_at:Date.now(),text:'',reasoning:'',tools:[],status:'pending'};views.set(view.id,view);}
      const cb=pendingCallbacks.get(p.request_id)||callbacks(view);
      pendingCallbacks.delete(p.request_id);await submit(p,cb);
    }
  }
  async function refreshQueue(){
    if(refreshing||!monitorToken)return;refreshing=true;
    try{const data=await request('/api/chat/queue');jobs=data.jobs||[];
      /* clarify 卡片兜底（2026-11-12 用户手机实测：刷新后只有「叫了 clarify」的工具卡，
         选择面板根本不出现）。三种失效路径都靠这一步救：
           ① panel-clarify.js 还没加载完，快照先到，window.pwClarifyAsk 是 undefined；
           ② 卡片已经画好，又被某次 chatBody 重绘冲掉；
           ③ 事件流没把 clarify 那帧送到。
         队列每 4 秒就带着 pending_clarify 回来，以它为准补一次，ask() 自己按 clarify_id 去重。 */
      for(const j of jobs){
        if(j.session_id!==currentSession||!j.pending_clarify)continue;
        if(j.status==='done'||j.status==='failed'||j.status==='cancelled')continue;
        try{window.pwClarifyAsk?.(j.pending_clarify);}catch(e){}
      }
      /* 顶栏状态先从队列补，再渲染队列 —— 顺序反过来的话 renderQueue 一抛异常，
         补状态这段就被 catch 吞掉，刷新后顶栏永远是空的。 */
      try{      /* 2026-11-11（用户实测：刷新后「输入框状态还有，顶上的消息状态没了」）：
       * 顶栏状态原来只存在内存 _tabGenState 里，一刷新就归零，而输入框那套是从服务端队列
       * 重新长出来的 —— 所以刷新后两处必然不同步。这里反过来：队列里真有 pending/running，
       * 就按队列把顶栏状态和跑马灯补出来，不需要等下一个 stream 事件。
       * 只在「没有活跃订阅」时补，避免把正在流动的工具文案盖成通用文案。 */
        if(currentSession&&typeof window.genBarShow==='function'){
        var mine=jobs.filter(function(j){return j.session_id===currentSession;});
        var runJob=mine.find(function(j){return j.status==='running';});
        var pendJobs=mine.filter(function(j){return j.status==='pending';});
        var qids=pendJobs.map(function(j){return j.id;});
        var driven=[...subscriptions.values()].some(function(s){return !s.finished&&s.sid===currentSession&&Date.now()-(s.lastFrame||0)<STALL_MS;});
        var st=(window._tabGenState||{})[currentSession];
        if(!driven&&(runJob||pendJobs.length)){
          if(runJob){
            /* 每轮都刷一次 ts：_paintStateBadge 有 25s 陈旧自清，只补一次会被自己清掉。 */
            try{window.genBarShow('generating','正在回复',currentSession);}catch{}
          }else if(pendJobs.length){
            var n=pendJobs.length;
            try{window.genBarShow('queued',n>1?('排队中：前面还有 '+(n-1)+' 条'):'排队中，等前面的任务',currentSession);}catch{}
          }
        }
        /* 气泡特效与顶栏状态分开维护（2026-11-11 用户第 29 条）：
         *   正在执行那条 → 彩色跑马灯；还没执行的每一条 → 呼吸灯 + 「取消」按钮。
         * 不能塞进上面 `!driven` 里：有活跃订阅时也要把排队那几条标出来，
         * 否则「连发三条」只能看见第一条在转，后两条排队完全没提示。 */
        /* 2026-11-13（用户第 41 条）：先把订阅建起来再补占位。顺序反了会先画一个
           没有操作栏的裸气泡，等 renderTurn 再画一个真的，中间这几秒能看见两条。 */
        for(const j of jobs)if(j.session_id===currentSession&&!subscriptions.has(j.id)&&j.status!=='interrupted')watchJob(j);
        /* 刷新后「只剩我的气泡 + 一颗按钮」的真凶在这里：历史重绘（loadSessionMessages
           或切会话）整片换掉 chatBody，队列气泡跟着消失；而订阅还在 subscriptions 里，
           下一轮 refreshQueue 判定「已订阅」直接跳过 watchJob，于是助手侧的「回答窗口」
           再也不会被画回来，占位气泡又只有用户一侧。
           顺序必须是「先补画、再补占位」：反过来的话 renderTurn 看见占位气泡已经占了
           user 这一侧，就只补助手气泡，用户侧永远停在没有复制/引用按钮的占位壳上。 */
        for(const st of subscriptions.values()){
          if(st.finished||st.sid!==currentSession)continue;
          const v=views.get(st.id);if(!v)continue;
          const node=document.querySelector('.msg.assistant[data-request-id="'+v.id+'"]');
          const sb=node&&node.querySelector('.msg-statusbar');
          /* DOM 没了 → 整对重建；DOM 在但状态栏被历史重绘抹平了 → 重画一次状态栏 */
          if(!node||(!terminal.has(v.status)&&(!sb||sb.hidden))){try{renderTurn(v);}catch(e){}}
        }
        try{resyncQueueFx();}catch(e){}
      }
      /* 同会话有未处理的 interrupted 会把后面所有 pending 一直挡在队列里（panel-queue.js:132），
       * 这时显示「正在思考」就是骗人，直接说清楚。 */
      const blocked=[...jobs].some(j=>j.session_id===currentSession&&j.status==='interrupted'&&!j.resolved_at);
      if(blocked&&jobs.some(j=>j.session_id===currentSession&&j.status==='pending')){
        try{window.genBarShow?.('queued','排队卡住：上一轮被中断，先处理',currentSession);}catch{}
      }
      }catch{}
      renderQueue();updateSend();
      for(const j of jobs)if(j.session_id===currentSession&&!subscriptions.has(j.id)&&j.status!=='interrupted')watchJob(j);
      /* 2026-11-11：状态必须以服务端队列为准，不能再只进不出。
       * 之前的毛病：标题行的「正在思考」一旦点亮就没人关；iPad 刷新后本地状态没了，
       * 但队列里留下的 pending 又把它点回来，于是任务早就停了、界面还在思考。
       * 这里每次 refreshQueue（4s）比对一次：本会话既没有活的 queue job、也没有没跑完的本地订阅，
       * 就清状态 + 摘掉气泡跑马灯。 */
      const live=new Set();
      for(const j of jobs) if(j.status==='pending'||j.status==='running') live.add(j.session_id);
      /* 本地订阅不再无限期算「活」：队列里没有它、又超过 12 秒没进队列，
         就当它已经死了。否则一个卡住/被丢掉订阅会永远把顶栏点亮成「正在回复」。 */
      for(const s of subscriptions.values()){
        if(s.finished) continue;
        if(Date.now()-(s.startedAt||0) < STALL_MS) live.add(s.sid);
      }
      if(typeof window.genBarReconcile==='function') window.genBarReconcile([...live]);
      else for(const sid of Object.keys(window._tabGenState||{})) if(!live.has(sid)) { try{window.genBarReset?.(sid);}catch{} }
      /* 队列空了就把环收干净：历史重绘保住的是旧节点，.running/.queued 类不会自己掉。
         只看 jobs+views 的真实活跃 id，不拿订阅 12s 窗口当活——那会让完成态一直带跑马灯。 */
      const _aliveIds=new Set();
      for(const j of jobs) if(j.status==='pending'||j.status==='running') _aliveIds.add(j.id);
      for(const v of views.values()) if(!terminal.has(v.status)) _aliveIds.add(v.id);
      if(!live.has(currentSession) || !_aliveIds.size) { try{window._markRunningMsg&&window._markRunningMsg(false);}catch{} }
    }
    catch{ /* The connection banner owns the offline state. Keep the last durable view. */ }
    finally{refreshing=false;}
  }
  document.addEventListener('click',async e=>{
    const b=e.target.closest('[data-queue-cancel],[data-queue-resolve],[data-outbox-retry]');if(!b)return;b.disabled=true;
    try{if(b.dataset.queueCancel)await request('/api/chat/queue/'+b.dataset.queueCancel+'/cancel','POST',{});
      if(b.dataset.queueResolve)await request('/api/chat/queue/'+b.dataset.queueResolve+'/resolve','POST',{});
      if(b.dataset.outboxRetry)await resumeOutbox();await refreshQueue();
    }catch(err){toast(err.message);}finally{b.disabled=false;}
  });

  function getDraft(sid){sid=sid||'new';if(!localDrafts.has(sid))localDrafts.set(sid,{...read('panel-draft-v2:'+sid,{revision:0,text:'',attachments:[],options:{},conflicts:[],dirty:false}),saving:false});return localDrafts.get(sid);}
  function saveLocal(sid,d){localDrafts.set(sid,d);_tabDrafts[sid]=d.text;try{write('panel-draft-v2:'+sid,{...d,saving:false});setDraftDurability(sid,'local',true);return true;}catch{setDraftDurability(sid,'local',false);return false;}}
  function setDraftDurability(sid,kind,value){const state=draftDurability.get(sid)||{local:true,server:false,pending:false};state[kind]=value;draftDurability.set(sid,state);renderDraftDurability(sid);}
  function scheduleDraftRetry(sid){clearTimeout(draftRetryTimers.get(sid));draftRetryTimers.set(sid,setTimeout(()=>{if(navigator.onLine)syncDraft(sid);},5000));}
  function renderDraftDurability(sid){
    const composer=document.getElementById('chatComposer');if(!composer||sid!==currentSession)return;
    let box=document.getElementById('draftDurabilityStatus');if(!box){box=document.createElement('p');box.id='draftDurabilityStatus';box.className='draft-durability-status';box.setAttribute('role','status');box.setAttribute('aria-live','polite');box.hidden=true;composer.prepend(box);}
    const state=draftDurability.get(sid)||{local:true,server:false,pending:false};
    const d=localDrafts.get(sid);const changed=!!d?.dirty;
    const protectedCopy=state.local||state.server;
    // 2026-11-11：用户明确说这个条「时不时跳出来影响使用」。所以只保留「真的会丢字」这一种情况：
    // 本机和服务器都没存上。其余（正在保存 / 只在服务器 / 服务器稍后重试）全部闭嘴。
    box.textContent=(changed&&!protectedCopy)?'草稿未保存（本机与服务器都失败），别关页面。':'';
    box.hidden=!box.textContent;
  }
  function draftOptions(){return {model:typeof _getSessionModel==='function'?_getSessionModel(currentSession):null,skills:typeof _activeSkills!=='undefined'?_activeSkills:[],connector:typeof _selectedConnector!=='undefined'?_selectedConnector:null};}
  function captureDraft(sid){
    if(applyingDraft)return;
    sid=sid||'new';const ta=document.getElementById('chatInput');if(!ta)return;
    const d=getDraft(sid);const text=ta.value,attachments=JSON.parse(JSON.stringify(_pendingAttachments||[])),options=draftOptions();
    if(d.text===text&&JSON.stringify(d.attachments)===JSON.stringify(attachments)&&JSON.stringify(d.options)===JSON.stringify(options))return;
    const next={...d,text,attachments,options,dirty:true,local_updated_at:Date.now()};
    if(!saveLocal(sid,next))toast('草稿本机保存失败，正在尝试同步。');
    clearTimeout(draftTimers.get(sid));draftTimers.set(sid,setTimeout(()=>syncDraft(sid),600));
  }
  async function syncDraft(sid){
    const d=getDraft(sid);if(d.saving){if(d.dirty)scheduleDraftRetry(sid);return;}d.saving=true;
    const stamp=d.local_updated_at;
    const isEmpty=!(d.text||'').trim()&&!(d.attachments||[]).length;
    try{
      // 空草稿且服务器上还没有任何版本：不是"正在同步"，就是没东西可同步，别制造版本号
      if(d.dirty&&isEmpty&&!d.revision){const local=getDraft(sid);local.dirty=false;saveLocal(sid,local);setDraftDurability(sid,'server',true);return;}
      if(d.dirty){setDraftDurability(sid,'pending',true);
        const result=await request('/api/workspace-ui/draft?session_id='+encodeURIComponent(sid),'PUT',{...d,client_id:clientId});
        const latest=getDraft(sid);
        setDraftDurability(sid,'server',true);
        if(latest.local_updated_at===stamp){saveLocal(sid,{...result.draft,dirty:false});setDraftDurability(sid,'server',true);clearTimeout(draftRetryTimers.get(sid));}
        else{latest.revision=result.draft.revision;saveLocal(sid,latest);setDraftDurability(sid,'server',false);scheduleDraftRetry(sid);}
      }else{
        const remote=await request('/api/workspace-ui/draft?session_id='+encodeURIComponent(sid));
        /* 2026-11-11 草稿根因：这里无条件用服务端草稿覆盖输入框。一旦本地 dirty 标记没来得及置上
         * （切换会话、刚打开页面、autoResize 之外的输入路径），正在打的字就被服务端那份旧草稿冲掉——
         * 用户看到的就是「打字打到一半没了 / 刷新后草稿变回上一次的内容」。
         * 规矩改成：输入框里有字且跟服务端那份不一样，就认定用户正在写，只落本地、不动 DOM。 */
        if(!getDraft(sid).dirty){
          const ta=(currentDraft===sid)?document.getElementById('chatInput'):null;
          const typing=!!(ta&&ta.value.trim()&&ta.value!==(remote.text||''));
          saveLocal(sid,{...remote,dirty:typing,local_updated_at:typing?Date.now():remote.local_updated_at});
          if(currentDraft===sid&&!typing)applyDraft(sid);
        }
      }
    }catch(e){
      if(d.dirty)setDraftDurability(sid,'server',false);
      if(e.status===409&&e.result?.draft){
        const remote=e.result.draft||{};
        const latest=getDraft(sid);
        const remoteText=remote.text||'',remoteEmpty=!remoteText.trim()&&!(remote.attachments||[]).length;
        // 对方那份是空的，或两边内容其实一样 → 不是冲突，只是版本号过期（另一台设备打开过会话、
        // 发过一条空内容，就把 revision 顶上去了）。认领新版本静默重推，不要把空内容摆成"冲突"。
        if(remoteEmpty||remoteText===latest.text){
          /* 2026-11-13 第39条「幽灵草稿」：服务端这份是空的、且版本号比本机高，
             说明这个会话已经发完了。以前这里保留 dirty → 本机那份老字（测试留下的
             CTRL-V / PROBE唯一标记）被反复重推回服务端，清一次回来一次。
             现在以服务端为准：本机残留直接丢掉，不清服务端就是真清。 */
          latest.revision=remote.revision;latest.conflicts=[];
          latest.conflict_remote=null;latest.dirty=false;
          latest.text=remoteText;latest.attachments=remote.attachments||[];
          saveLocal(sid,latest);setDraftDurability(sid,'server',true);
          const ta=document.getElementById('chatInput');
          if(currentDraft===sid&&ta&&!ta.value.trim())applyDraft(sid);
        }else{
          /* 2026-11-13 第39条：草稿不再做「两份对比、你挑一份」——那是在拿用户的时间
             替程序擦屁股。谁正在打字谁赢：认领服务端版本号，把本机内容重新推上去。 */
          setDraftDurability(sid,'server',true);latest.revision=remote.revision;latest.conflicts=[];
          latest.conflict_remote=null;latest.dirty=true;
          saveLocal(sid,latest);setTimeout(()=>syncDraft(sid),0);
        }
      }
      else if(d.dirty)scheduleDraftRetry(sid);
    }finally{setDraftDurability(sid,'pending',false);const latest=getDraft(sid);latest.saving=false;renderDraftDurability(sid);if(latest.dirty&&latest.local_updated_at!==stamp)setTimeout(()=>syncDraft(sid),0);}
  }
  /* 刚发送出去的文本：草稿同步读回「服务端还没清干净」的旧稿时，
     不许把它再塞回输入框。2026-11-13 实测：发送后 600ms 那次 syncDraft
     走 GET 分支，服务端旧稿还在 → applyDraft 回填 → 输入框又出现刚发出去的字。 */
  const _sentGuard = new Map();
  function applyDraft(sid){
    const d=getDraft(sid),ta=document.getElementById('chatInput');if(!ta)return;
    /* 用户正在这个框里打字（有焦点 + 120 秒内敲过键 + 内容和服务端草稿不一样）：
       服务端那份草稿（尤其是「刚发出去所以是空」的那份）不许覆盖他正在写的东西。
       以前只靠 dirty 标记拦，队列一跑、草稿一同步，标记就归零，字照样没。 */
    const _editAt=_composerEditAt[sid]||0;
    const _typingNow=(currentDraft===sid)&&(document.activeElement===ta)&&!!(ta.value||'').trim()&&ta.value!==(d.text||'')&&(Date.now()-_editAt<120000);
    if(_typingNow){
      const keep=getDraft(sid);keep.text=ta.value;keep.dirty=true;keep.local_updated_at=Date.now();saveLocal(sid,keep);
      renderDraftDurability(sid);return;
    }
    /* 发送后的 8 秒窗口：输入框已经空了，任何非空草稿都不许塞回来。
       服务端那份可能是「刚发出去还没清干净」的字，也可能是别的设备留下的旧稿，
       对用户来说都是「我发完了，字又冒出来了」。 */
    const _g=_sentGuard.get(sid);
    if(_g&&Date.now()-_g.at<8000&&!ta.value.trim()&&String(d.text||'').trim()){_sentGuard.delete(sid);return;}
    applyingDraft=true;
    ta.value=d.text||'';_pendingAttachments=d.attachments||[];renderAttachChips();
    if(d.options&&'model'in d.options&&sid!=='new'){_setSessionModel(sid,d.options.model||'');if(typeof _syncModelBtn==='function')_syncModelBtn();}
    if(d.options?.skills)_activeSkills=d.options.skills.slice();
    if(d.options&&'connector'in d.options)_selectedConnector=d.options.connector;
    if(window.panelConnectorRestore)panelConnectorRestore();
    autoResize(ta);renderDraftConflict(sid);renderDraftDurability(sid);applyingDraft=false;
  }
  function renderDraftConflict(sid){
    /* 2026-11-13 第39条：草稿箱改「简洁无感」——没有比对弹窗、没有「查看两份草稿」、
       没有「稍后处理」。旧版本残留在 localStorage 的 conflict_remote 顺手清掉，
       输入框上方那条提示条永久隐藏。 */
    const d=getDraft(sid);
    if(d&&d.conflict_remote){d.conflict_remote=null;saveLocal(sid,d);}
    const box=document.getElementById('draftConflict');
    if(box){box.hidden=true;box.innerHTML='';}
  }
  function clearSentDraft(sid,sentText){
    const d=getDraft(sid);_sentGuard.set(sid,{text:String(sentText||d.text||''),at:Date.now()});saveLocal(sid,{...d,text:'',attachments:[],dirty:true,local_updated_at:Date.now()});syncDraft(sid);
  }
  window.saveDraft=function(sid){captureDraft(sid);};
  window.restoreDraft=function(sid){currentDraft=sid||'new';applyDraft(currentDraft);syncDraft(currentDraft);renderQueue();updateSend();};
  /* 2026-11-11 草稿真凶（用户实测「刷新后草稿没了」）：
   * init() 里只调了一次 restoreDraft(currentSession||'new')，那一刻会话还没加载完，
   * currentSession 是空的 → 把空草稿写进输入框；等会话真的打开，没人再恢复。
   * 本地草稿其实一直躺在 localStorage 里（text 完好），只是没有代码把它放回输入框。
   * 这里盯着 currentSession 变化：换会话先存旧会话的草稿，再恢复新会话的草稿。 */
  let _lastDraftSess=null;
  setInterval(function(){
    const cd=currentSession||'new';
    if(cd===_lastDraftSess)return;
    const prev=_lastDraftSess;_lastDraftSess=cd;
    if(prev)try{captureDraft(prev);}catch{}
    const ta=document.getElementById('chatInput');
    const d=getDraft(cd);
    if(ta&&(ta.value.trim()===''||ta.value===d.text))window.restoreDraft(cd);
    else{currentDraft=cd;renderQueue();updateSend();renderDraftDurability(cd);}
  },800);
  const previousRenderAttachments=renderAttachChips;
  window.renderAttachChips=function(){const value=previousRenderAttachments();if(!applyingDraft)setTimeout(()=>captureDraft(currentSession||'new'),0);return value;};
  const previousSetModel=_setSessionModel;
  window._setSessionModel=function(sid,model){const result=previousSetModel(sid,model);if(!applyingDraft&&sid===currentSession)setTimeout(()=>captureDraft(sid),0);return result;};
  // Render by stable request ID, never through a closure that holds another tab's DOM.
  const views=new Map();
  // ── 工具看板：增量渲染（2026-11-13 重写）
  // 折叠状态不再在这里存第二份：ToolUI 把意愿挂在 .tool-calls 盒子自己身上，
  // 本函数只负责把内容增量补进去，然后调一次 ToolUI.paint 上色。
  // 以前这里存 {collapsed, open:Set}，按 data-tid 或 #索引 还原 —— 索引在卡片增删后
  // 会错位；盒子的折叠态还只写 aria-expanded，而 CSS 根本不看这个属性。
  function patchToolBox(area,tools,viewId){
    if(!area)return;
    const tpl=document.createElement('div');tpl.innerHTML=toolCallsHTML(tools);
    const fresh=tpl.firstElementChild;
    if(!fresh){area.replaceChildren();return;}
    let box=area.firstElementChild;
    if(!box||!box.classList.contains('tool-calls')){
      /* 重建盒体：把原来的 data-box 键带过去，否则 ToolCard 认不出「这个盒子用户开过」 */
      const oldBox=box&&box.getAttribute('data-box');
      if(oldBox)fresh.setAttribute('data-box',oldBox);
      area.replaceChildren(fresh);box=fresh;
    }
    else{
      const freshCount=fresh.querySelector('.tc-text'),countEl=box.querySelector('.tc-text');
      if(freshCount&&countEl&&countEl.textContent!==freshCount.textContent)countEl.textContent=freshCount.textContent;
      const list=box.querySelector('.tool-list');
      [...fresh.querySelectorAll('.tool-call')].forEach((el,i)=>{
        const cur=[...box.querySelectorAll('.tool-call')][i];
        if(!cur){list&&list.appendChild(el);return;}
        if(cur.className===el.className&&cur.innerHTML===el.innerHTML)return;
        cur.replaceWith(el);   /* 开合状态由 ToolCard.paint 按 data-tk 还原 */
      });
    }
    if(window.ToolUI)window.ToolUI.paint(box);   // 折叠态唯一出口
  }
  // 兼容旧调用点：折叠状态已由 ToolUI 自己维护，这里不再收集第二份。
  window.__durableToolState={save(){}};
  function renderTurn(view){
    if(view.sid!==currentSession||_channelViewActive)return;
    const body=document.getElementById('chatBody');if(!body)return;
    let node=body.querySelector('.msg.assistant[data-request-id="'+view.id+'"]');
    if(!node){
      if(!body.querySelector('.msg'))body.innerHTML='';
      if(!body.querySelector('.msg.user[data-request-id="'+view.id+'"]')){
        /* 气泡正文用 ask（用户自己打的话），附件必须从 message 里拿——
           以前只传 ask 字符串，发出去的语音/文件在气泡里根本不显示。 */
        let userContent = view.ask!==undefined ? view.ask : view.message;
        if(view.ask!==undefined && view.message && typeof view.message==='object' && ((view.message.files||[]).length || (view.message.images||[]).length)){
          userContent = {...view.message, text: view.ask};
        }
        body.insertAdjacentHTML('beforeend',msgHTML({role:'user',content:userContent,ts:view.created_at,request_id:view.id,...view.user_identity}));
      }
      if(view.quote){const ub=body.querySelector('.msg.user[data-request-id="'+view.id+'"] .msg-bubble');if(ub&&!ub.querySelector('.quote-block'))ub.insertAdjacentHTML('afterbegin','<div class="quote-block"><div class="quote-label">引用</div>'+escapeHtml(view.quote)+'</div>');}
      body.insertAdjacentHTML('beforeend',msgHTML({role:'assistant',content:'',ts:view.created_at,request_id:view.id,...view.identity}));
      node=body.querySelector('.msg.assistant[data-request-id="'+view.id+'"]');
    }
    const bubble=node.querySelector('.msg-bubble');let text=bubble.querySelector('.durable-reply');
    // History reloads replace the DOM without changing the tool data.
    // A new tool container must always be painted at least once.
    /* 三层信息带（2026-11-12 用户第 32 条）：
       ① .msg-statusbar 在正文之下、工具调用之上 = 现在进行时（2026-11-13 第 40 条从顶部移下来）；② .msg-flags 在底部 = 已发生的事实。
       历史气泡由 msgHTML 渲染、本来就带这两个容器；这里只补缺，不重建。 */
    if(!bubble.querySelector('.msg-statusbar')){
      var _sb=document.createElement('div');_sb.className='msg-statusbar';_sb.hidden=true;
      var _tbox=bubble.querySelector('.durable-tools')||bubble.querySelector('.chat-info');
      if(_tbox)bubble.insertBefore(_sb,_tbox);else bubble.append(_sb);
    }
    if(!bubble.querySelector('.msg-flags'))bubble.insertAdjacentHTML('beforeend','<div class="msg-flags" hidden></div>');
    /* 2026-11-13：重建骨架前先把装饰节点摘下来。以前直接 innerHTML=骨架 会把
       .msg-actions / .msg-meta 一起删掉，下面 535 行再给它们设 hidden 就是
       「给 null 设属性」→ 抛错 → 整轮发送在 renderTurn 里中断、submit 根本没跑，
       用户看到的是：气泡出来了、字回到输入框、弹一句「消息未发送」。 */
    /* 2026-11-13 修正：.msg-actions / .msg-meta 已回到 .msg 直接子节点（与 user 分支、CSS grid 一致），
       重建 bubble.innerHTML 只动气泡自己的子节点，天然碰不到 footer，不再需要「先摘下来再塞回去」。
       以前那段摘挂逻辑基于「footer 在气泡内」的错误结构，现在保留只会把 footer 又拖回气泡里。 */
    if(!text){view.toolSignature=null;bubble.innerHTML='<div class="durable-reply md-text"></div><div class="durable-reasoning"></div><div class="msg-statusbar" hidden></div><div class="durable-tools"></div><div class="chat-info"></div><div class="msg-flags" hidden></div>';text=bubble.querySelector('.durable-reply');}
    /* 服务端拼进正文的「（执行已中断）」「📦 已自动压缩」渲染前抽成 chip：不改后端、不用重启 monitor */
    const _mk=(typeof splitSysMarkers==='function')?splitSysMarkers(view.text||''):{text:view.text||'',flags:[]};
    /* 流式这条路径也要去重：否则同一张图在生成过程中先闪两次，跑完重渲染才变成一次。 */
    const _mkBody=(typeof dedupeMarkdownImages==='function')?dedupeMarkdownImages(_mk.text):_mk.text;
    text.innerHTML=renderMarkdown(_mkBody,!terminal.has(view.status));
    if(view.reasoning){const reasoning=bubble.querySelector('.durable-reasoning');let details=reasoning.querySelector('details');if(!details){reasoning.innerHTML='<details><summary>思考过程</summary><div></div></details>';details=reasoning.querySelector('details');}details.querySelector('div').textContent=view.reasoning;}
    const signature=JSON.stringify(view.tools||[]);
    if(signature!==view.toolSignature){patchToolBox(bubble.querySelector('.durable-tools'),view.tools||[],view.id);view.toolSignature=signature;}
    /* 2026-11-12（用户第 31 条）：服务端流头那句「正在思考…」写进 view.info 后没人清，
       整轮回复里（工具在跑、正文都在写了）气泡底下还一直挂着它。
       现在：纯进度类文案在已经有正文或工具卡时退场；「连接中断，正在恢复进度」
       这类真提示照旧显示，不跟着一起吞掉。 */
    const info=bubble.querySelector('.chat-info');
    const hasBody=!!((view.text||'').trim())||!!((view.tools||[]).length);
    /* labels 兜底一并去掉（2026-11-13 用户第 44 条）：排队态会兜出「等待执行」、
       运行态兜出「正在执行」，而气泡顶上的状态条正在写同一件事。底部只留真提示和报错。 */
    const _info=view.error||(!terminal.has(view.status)?(view.info||''):'');
    const _transient=/^(正在思考|正在执行|正在调用|正在等待|正在生成|正在回复|正在加载)/.test(_info);
    /* 状态栏 alert 档已经把这句放在气泡顶部，底部 .chat-info 不再复读 */
    const _liveAlert=!!(view.live&&view.live.mode==='alert');
    /* 2026-11-13：进度类文案一律不进底部 —— 气泡顶部状态栏（🤔 正在思考 · 6s）已经在写同一件事，
       以前只在「有正文/工具后才藏」，所以在流头那几秒会出现上下两个「正在思考」。 */
    info.textContent=(_transient||_liveAlert)?'':_info;info.style.display=info.textContent?'flex':'none';
    /* 状态栏只活在本轮里，本轮一结束（done/interrupted/failed）就淡出；chip 相反，跟消息留着 */
    const flagsBox=bubble.querySelector('.msg-flags');
    if(flagsBox){
      /* 结束类标记不进 chip 层：历史渲染由 turnEndState 收进状态条，流式这条路径也不能
         先闪一个「⚠ 执行已中断」再被重载换掉（同一句话上下两处，用户第 43 条）。 */
      const _fl=(typeof TURN_END_LABELS!=='undefined')?_mk.flags.filter(f=>!TURN_END_LABELS[f.label]):_mk.flags;
      const fh=(typeof flagsHTML==='function')?flagsHTML(_fl):'';
      if(flagsBox.innerHTML!==fh)flagsBox.innerHTML=fh;
      flagsBox.hidden=!fh;
    }
    /* 刷新回来时 view.live 是空的：onAccepted/onSnapshot 只在状态翻转时写它。
       于是排队中的那条连「排队中」都画不出来，助手气泡就是纯空壳（用户第 41 条）。 */
    if(!terminal.has(view.status)&&!view.live){
      if(view.status==='pending')view.live={mode:'queued',text:'排队中，轮到它会自动开始',icon:'⏳'};
      else if(view.status==='running')view.live={mode:view.text?'generating':'thinking',text:view.text?'正在回复':'正在思考',icon:'💬'};
    }
    if(!terminal.has(view.status)&&view.live&&typeof setBubbleStatus==='function'){
      setBubbleStatus(node,view.live.mode||'',view.live.text||'',view.live.icon||'');
    } else if(typeof clearBubbleStatus==='function'){
      clearBubbleStatus(node,0);
    }
    node.dataset.content=view.text||'';const _actBar=node.querySelector('.msg-actions');if(_actBar)_actBar.hidden=!terminal.has(view.status);
    if(view.usage){const meta=node.querySelector('.msg-meta');if(meta)meta.textContent=(view.identity?.sender||'Hermes')+' · '+fmtDateTime(view.created_at)+' · '+(view.usage.total_tokens??(view.usage.prompt_tokens||0)+(view.usage.completion_tokens||0))+' tokens';}
    if(autoScrollActive())followChatBottom();_chatHTML[view.sid]=body.innerHTML;
  }
  document.addEventListener('hermes:display',function(){views.forEach(view=>{view.toolSignature=null;var node=document.querySelector('.msg.assistant[data-request-id="'+view.id+'"] .durable-tools');if(node)node.replaceChildren();renderTurn(view);});});
  // Discord 式状态文案：动词 + 目标（"读取 index.html" / "运行代码 import subprocess…"）
  const TOOL_VERB={read_file:'读取',write_file:'写入',patch:'编辑',terminal:'运行终端',execute_code:'运行代码',
    vision_analyze:'看图',search_files:'搜索文件',todo:'更新任务',web_search:'搜索网页',web_extract:'抓取网页',
    skill_view:'读技能',delegate_task:'派子代理',memory:'记入记忆',text_to_speech:'合成语音',clarify:'询问',
    browser:'浏览网页',cronjob:'排定时任务',session_search:'翻历史'};
  function callbacks(view){const paint=()=>_throttledRender('queue:'+view.id,()=>renderTurn(view),100);
    const seenTools=new Map();
    // 状态源：genBar 一套（按会话记 mode/text/start）→ 会话标题旁徽标 + 左侧列表同步。
    // 队列这条路以前完全没有接 genBar，只有 .dq-item 的「正在执行」，所以状态提示像是消失了。
    const say=(mode,text,icon)=>{try{genBarShow(mode,text,view.sid,icon);}catch{}
      /* 同一条状态同时写进气泡状态栏：标题旁是会话级，气泡里是「这一轮回复」级 */
      view.live={mode,text,icon:icon||''};};
    /* 本轮一结束立刻同步队列：气泡环只认队列真源，不能等 4s 轮询（2026-11-13 用户第 39 条）。
       以前 genBarDone 里直接 _markRunningMsg(false) 清环，会把同会话还排在队里的
       pending 呼吸灯一起抹掉——所以清环的权限收到这里，按服务端 jobs 说话。 */
    const finishBar=(mode,text)=>{try{genBarDone(mode,text,2200,view.sid);}catch{}try{refreshQueue();}catch{}};
    _tabStreaming[view.sid]=true;try{renderSessionTabs();}catch{}
    return {
    onAccepted:j=>{Object.assign(view,{identity:j.identity,user_identity:j.user_identity,status:j.status});say(j.status==='pending'?'queued':'thinking',j.status==='pending'?'排队中，轮到会自动执行':'正在思考');paint();try{resyncQueueFx();}catch(e){}},
    onSnapshot:j=>{const was=view.status;Object.assign(view,{identity:j.identity,user_identity:j.user_identity,status:j.status});
      /* 快照就是「服务端现在到底在干嘛」：状态从 pending 翻到 running 时顶栏必须跟着翻。
         以前只 Object.assign 不 say()，于是 POST 那一刻写的「排队中，轮到会自动执行」再没人改，
         任务早跑起来了顶栏还在排队（2026-11-12 用户手机实测：排队中一直挂到 clarify 卡刷出来）。 */
      if(j.status!==was&&j.status==='running')say('thinking','正在思考');
      /* 刷新回来接着看：快照说还在跑就把状态栏点起来；说已经完了就清掉 */
      if(terminal.has(j.status))view.live=null;else if(!view.live&&j.status==='running')say('thinking','正在思考');
      paint();
      /* 状态翻转就是环该换位置的时候：排队呼吸灯 → 彩色跑马灯，别等 4s 轮询 */
      if(j.status!==was){try{resyncQueueFx();}catch(e){}}},
    onDelta:d=>{view.text+=d;view.status='running';view.info='';if(!view._sawText){view._sawText=true;}say('generating','撰写回复');paint();},onReplace:t=>{view.text=t;paint();},
    onReasoning:d=>{view.reasoning+=d;view.info='';say('reasoning','正在思考');paint();},
    onTool:t=>{const key=t.toolCallId||t.tool,index=view.tools.findIndex(x=>(x.toolCallId||x.tool)===key);const now=Date.now();
      if(index<0){t._t0=now;t._ms=0;view.tools.push(t);}
      else{const prev=view.tools[index],merged={...prev,...t};
        if(prev._t0)merged._t0=prev._t0;
        /* 记一次耗时：工具再快也留得下「已完成 · 0.4s」，不会只剩「一闪而过」 */
        if(!merged._ms&&merged._t0&&/^(done|completed|finished|ok|error|failed|cancelled|interrupted)$/i.test(merged.status||''))merged._ms=now-merged._t0;
        view.tools[index]=merged;}
      view.info='';
      // 「图标 + 动作 + 目标 ×N」：图标用工具自己的 emoji（🐍/📖/🔧/💻/✍️…），和 Discord 那套一致
      const zh=TOOL_VERB[t.tool]||t.toolZh||t.tool||'工具';
      const lbl=String(t.label||'').replace(/\s+/g,' ').trim();
      const sig=zh+'\u0000'+lbl;
      seenTools.set(sig,(seenTools.get(sig)||0)+1);
      const nth=seenTools.get(sig);
      const txt=(lbl?zh+' '+lbl.slice(0,44):zh)+(nth>1?' (×'+nth+')':'');
      say('tool',txt,t.emoji||'🛠');paint();},
    onUsage:u=>{view.usage=u;paint();},
    onInfo:i=>{view.info=i;
      /* 真提示（连接中断/正在恢复）转成状态栏 alert 档，不再既占状态栏又占底部一行 */
      if(/重连|连接中断|恢复进度/.test(String(i||'')))view.live={mode:'alert',text:String(i),icon:'🔄'};
      paint();},
    onError:e=>{view.error=e;view.status='failed';view.info='';view.live=null;finishBar('error','出错');paint();},
    onDone:stopped=>{view.status=stopped?'interrupted':'done';view.info='';view.live=null;_tabStreaming[view.sid]=false;finishBar(stopped?'stopped':'done',stopped?'已停止':'完成');_flushStreamRender('queue:'+view.id);renderTurn(view);loadSessions();
      // Reload committed message identities/result after the runner finished, without touching other tabs.
      if(view.sid===currentSession)setTimeout(()=>loadSessionMessages(view.sid,false,true),100);
      if(!stopped&&view.text&&localStorage.getItem('fnos-voice-autoplay')==='1'&&view.sid===currentSession)setTimeout(()=>{const button=document.querySelector('.msg.assistant[data-request-id="'+view.id+'"] [onclick="speakMsg(this)"]');if(button)speakMsg(button);},250);
    },
  };}
  function watchJob(job){
    let view=views.get(job.id);if(!view){view={id:job.id,sid:job.session_id,message:job.message,created_at:job.created_at,identity:job.identity,user_identity:job.user_identity,text:String(job.result?.reply||''),reasoning:String(job.result?.reasoning||''),tools:Array.isArray(job.result?.tools)?job.result.tools.slice():[],status:job.status};views.set(job.id,view);}
    const state={id:job.id,sid:job.session_id,cb:callbacks(view),text:view.text,reasoning:view.reasoning,seq:0,status:job.status,finished:false,failures:0,startedAt:Date.now()};subscriptions.set(job.id,state);subscribe(state);
  }
  window.sendRaw=async function(text){
    if(_channelViewActive){toast('当前是渠道记录预览，请先返回面板会话');return;}
    const attachments=JSON.parse(JSON.stringify(_pendingAttachments||[])),selectedSkills=_activeSkills.slice(),selectedConnector=_selectedConnector,selectedModel=_getSessionModel(currentSession);
    // 引用：带【引用上下文】的那份只发给模型；气泡显示用户自己打的话 + 一条 quote-block
    const askText=text;let quoteForView=null;
    if(_currentQuote){quoteForView=_currentQuote;text='【引用上下文】\n'+_currentQuote+'\n\n【用户追问】\n'+text;clearQuote();}
    // 长期目标：追加给模型，气泡仍显示 askText（不脏）
    try{const _g=localStorage.getItem('panel_goal')||'';if(_g&&text.indexOf('【长期目标】')<0)text=text+'\n\n【长期目标】'+_g;}catch(e){}
    // Keep a recovery copy before any asynchronous session creation or network request.
    const recovery={text:askText,attachments,at:Date.now()};
    let sid=currentSession;
    try{
      write('panel-send-recovery',recovery);
      if(!sid){const s=await request('/api/sessions','POST',{});if(!s.id)throw Error('创建会话失败');sid=s.id;currentSession=sid;_sessions.unshift(s);_openTabs.push(sid);persistTabs();renderRail();renderSessionTabs();updateHeader();}
      const context=await pwSessionContext(sid),turn=[];
      if(selectedSkills.length)turn.push('本轮希望参考的已安装技能：'+selectedSkills.join('、')+'。请先确认实际可用。');
      if(selectedConnector){const c=await panelConnectorContext(selectedConnector);turn.push('本轮涉及已配置的连接器：'+c.name+'。只使用实际工具定义中存在的对应能力。');}
      const model=selectedModel,payload={session_id:sid,request_id:uuid(),message:buildMessageContent(text+(turn.length?'\n\n【本轮参考上下文】\n'+turn.join('\n'):''),attachments),system:''};
      if(typeof model==='object'&&model?.model){payload.model=model.model;if(model.provider)payload.provider=model.provider;}else if(model)payload.model=model;
      remember(payload);try{localStorage.removeItem('panel-send-recovery');}catch{}if(currentSession===sid){_pendingAttachments=[];renderAttachChips();}
      const view={id:payload.request_id,sid,message:buildMessageContent(text,attachments),ask:askText,quote:quoteForView,created_at:Date.now(),...context,text:'',reasoning:'',tools:[],status:'pending'};views.set(view.id,view);renderTurn(view);clearSentDraft(sid,askText);submit(payload,callbacks(view));
    }catch(e){
      const d=getDraft(sid);if(!d.text)saveLocal(sid,{...d,text:askText,attachments,dirty:true,local_updated_at:Date.now()});
      if(sid===currentSession){const ta=document.getElementById('chatInput');if(!ta.value){ta.value=askText;_pendingAttachments=attachments;renderAttachChips();autoResize(ta);}captureDraft(sid);}
      toast('消息未发送，输入已保留：'+e.message);
    }
  };
  /* 2026-11-13（用户第 10 条）：队列跑下一条时报文/草稿会重建输入框，用户正在打的字被冲掉。
     这里记一笔「用户最近真敲过键盘」，applyDraft 遇到这种情况就不许回填（只存本地草稿）。 */
  const _composerEditAt={};
  window._pwComposerEditAt=_composerEditAt;
  document.addEventListener('input',e=>{
    if(e.target&&e.target.id==='chatInput'){_composerEditAt[currentSession||'new']=Date.now();captureDraft(currentSession||'new');}
  });
  window.addEventListener('beforeunload',e=>{for(const [sid,d] of localDrafts){const state=draftDurability.get(sid)||{local:true,server:false};if(d.dirty&&!state.local&&!state.server){e.preventDefault();e.returnValue='';return;}}});
  window.addEventListener('pagehide',()=>captureDraft(currentSession||'new'));
  window.addEventListener('online',()=>{fetchToken().then(()=>{resumeOutbox();refreshQueue();for(const [sid,d] of localDrafts)if(d.dirty)syncDraft(sid);});});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)captureDraft(currentSession||'new');else{refreshQueue();resumeOutbox();}});
  async function init(){
    await fetchToken();
    try{await refreshQueue();}catch(e){}
    /* 蒙版第四格：队列回来了（气泡占位、跑马灯都按队列真源画完）再放行 */
    try{window.bootMaskMark&&window.bootMaskMark('queue');}catch(e){}
    try{restoreDraft(currentSession||'new');}catch(e){}
    /* 蒙版第五格：草稿回填完，输入框不再是空的再显影 */
    try{window.bootMaskMark&&window.bootMaskMark('draft');}catch(e){}
    resumeOutbox();
    queueTimer=setInterval(()=>{refreshQueue();if(navigator.onLine)resumeOutbox();},4000);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>init().catch(()=>{}));else init().catch(()=>{});
})();
