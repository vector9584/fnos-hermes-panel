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
      state.cb.onInfo?.(j.status==='pending'?'消息已保存，轮到时会自动执行。':r.info||'已恢复执行进度');
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
    clearSentDraft(payload.session_id);
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
        if(runJob||pendJobs.length){
          try{window._markRunningMsg&&window._markRunningMsg(true,runJob?'running':'queued',runJob?runJob.id:null,qids);}catch{}
        }
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
      if(!live.has(currentSession)) { try{window._markRunningMsg&&window._markRunningMsg(false);}catch{} }
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
          latest.revision=remote.revision;latest.conflicts=remote.conflicts||latest.conflicts;
          latest.conflict_remote=null;latest.dirty=!(remoteText===latest.text)?latest.dirty:false;
          saveLocal(sid,latest);setDraftDurability(sid,'server',true);
          if(latest.dirty)setTimeout(()=>syncDraft(sid),0);
        }else{
          setDraftDurability(sid,'server',true);latest.revision=remote.revision;latest.conflicts=remote.conflicts;
          latest.conflict_remote=remote;latest.dirty=false;saveLocal(sid,latest);renderDraftConflict(sid);
        }
      }
      else if(d.dirty)scheduleDraftRetry(sid);
    }finally{setDraftDurability(sid,'pending',false);const latest=getDraft(sid);latest.saving=false;renderDraftDurability(sid);if(latest.dirty&&latest.local_updated_at!==stamp)setTimeout(()=>syncDraft(sid),0);}
  }
  function applyDraft(sid){
    const d=getDraft(sid),ta=document.getElementById('chatInput');if(!ta)return;
    applyingDraft=true;
    ta.value=d.text||'';_pendingAttachments=d.attachments||[];renderAttachChips();
    if(d.options&&'model'in d.options&&sid!=='new'){_setSessionModel(sid,d.options.model||'');if(typeof _syncModelBtn==='function')_syncModelBtn();}
    if(d.options?.skills)_activeSkills=d.options.skills.slice();
    if(d.options&&'connector'in d.options)_selectedConnector=d.options.connector;
    if(window.panelConnectorRestore)panelConnectorRestore();
    autoResize(ta);renderDraftConflict(sid);renderDraftDurability(sid);applyingDraft=false;
  }
  function renderDraftConflict(sid){
    let box=document.getElementById('draftConflict');
    if(!box){box=document.createElement('div');box.id='draftConflict';box.className='draft-conflict';document.getElementById('chatComposer')?.prepend(box);}
    const d=getDraft(sid);const cr=d.conflict_remote;
    const meaningful=!!cr&&((cr.text||'').trim()!==''||(cr.attachments||[]).length>0);
    if(!meaningful&&cr){d.conflict_remote=null;saveLocal(sid,d);}
    box.hidden=!meaningful;
    if(meaningful)box.innerHTML='<span>其他设备也修改了草稿，两份内容都已保存。</span><button id="draftCompare">查看两份草稿</button>';
    const button=document.getElementById('draftCompare');if(button)button.onclick=()=>{
      const dialog=document.createElement('dialog');dialog.className='durable-draft-dialog';
      dialog.innerHTML='<h3>选择要继续编辑的草稿</h3><label>本机草稿<textarea readonly></textarea></label><label>另一份草稿<textarea readonly></textarea></label><div><button data-keep="local">继续本机草稿</button><button data-keep="remote">继续另一份</button><button data-close>稍后处理</button></div>';
      const fields=dialog.querySelectorAll('textarea');fields[0].value=d.text;fields[1].value=d.conflict_remote.text;
      dialog.onclick=async ev=>{if(ev.target.closest('[data-close]')){dialog.close();dialog.remove();return;}const pick=ev.target.closest('[data-keep]');if(!pick)return;
        const chosen=pick.dataset.keep==='local'?d:d.conflict_remote,other=pick.dataset.keep==='local'?d.conflict_remote:d;
        // Keep an explicit local recovery copy even after selecting a version.
        write('panel-draft-recovery:'+sid+':'+Date.now(),other);
        const next={...chosen,revision:d.revision,conflict_remote:null,dirty:true,local_updated_at:Date.now()};saveLocal(sid,next);applyDraft(sid);await syncDraft(sid);dialog.close();dialog.remove();};
      document.body.append(dialog);dialog.showModal();
    };
  }
  function clearSentDraft(sid){
    const d=getDraft(sid);saveLocal(sid,{...d,text:'',attachments:[],dirty:true,local_updated_at:Date.now()});syncDraft(sid);
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
  // ── 工具看板：增量渲染 + 折叠状态记忆（2026-11-11 用户第 8 条）
  // 旧实现每次工具进度都 innerHTML 整块重建：正在看的内容被整块换掉，观感就是"又折叠了"，
  // 整块替换还会闪一下。现在只补新增卡片、只替换内容真变了的那张卡；
  // 面板折叠态和已展开的卡片按 toolCallId 记住，重建（历史刷新 / 切 tab）后原样还原。
  const toolUI=new Map();
  function toolState(id){let st=toolUI.get(id);if(!st){st={collapsed:null,open:new Set()};toolUI.set(id,st);}return st;}
  function toolKey(el,i){return el.getAttribute('data-tid')||('#'+i);}
  function patchToolBox(area,tools,viewId){
    if(!area)return;
    const st=toolState(viewId);
    const tpl=document.createElement('div');tpl.innerHTML=toolCallsHTML(tools);
    const fresh=tpl.firstElementChild;
    if(!fresh){area.replaceChildren();return;}
    let box=area.firstElementChild;
    if(!box||!box.classList.contains('tool-calls')){area.replaceChildren(fresh);box=fresh;}
    else{
      const freshCount=fresh.querySelector('.tc-text'),countEl=box.querySelector('.tc-text');
      if(freshCount&&countEl&&countEl.textContent!==freshCount.textContent)countEl.textContent=freshCount.textContent;
      const list=box.querySelector('.tool-list');
      [...fresh.querySelectorAll('.tool-call')].forEach((el,i)=>{
        const cur=[...box.querySelectorAll('.tool-call')][i];
        if(!cur){list&&list.appendChild(el);return;}
        if(cur.className===el.className&&cur.innerHTML===el.innerHTML)return;
        if(cur.classList.contains('open'))el.classList.add('open');
        cur.replaceWith(el);
      });
    }
    if(st.collapsed!=null)box.setAttribute('data-collapsed',st.collapsed?'true':'false');
    if(st.open.size)box.querySelectorAll('.tool-call').forEach((el,i)=>{if(st.open.has(toolKey(el,i)))el.classList.add('open');});
    const tog=box.querySelector('.tc-toggle');
    if(tog)tog.textContent=box.getAttribute('data-collapsed')==='true'?'展开 ▾':'收起 ▴';
    if(st.collapsed!=null){const sum=box.querySelector('.tool-summary');if(sum)sum.setAttribute('aria-expanded',st.collapsed?'false':'true');}
  }
  window.__durableToolState={save(box){
    if(!box)return;const msg=box.closest('.msg');const id=msg&&msg.getAttribute('data-request-id');if(!id)return;
    const st=toolState(id);st.collapsed=box.getAttribute('data-collapsed')==='true';st.open=new Set();
    box.querySelectorAll('.tool-call').forEach((el,i)=>{if(el.classList.contains('open'))st.open.add(toolKey(el,i));});
  }};
  // 单张卡片展开/收起也记一下（卡片点击由渲染器自己的 onclick 处理，这里只旁听）
  document.addEventListener('click',e=>{const card=e.target.closest&&e.target.closest('.tool-call');if(!card)return;
    const box=card.closest('.tool-calls');if(box)setTimeout(()=>window.__durableToolState.save(box),0);},true);
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
    if(!text){view.toolSignature=null;bubble.innerHTML='<div class="durable-reply md-text"></div><div class="durable-reasoning"></div><div class="durable-tools"></div><div class="chat-info"></div>';text=bubble.querySelector('.durable-reply');}
    text.innerHTML=renderMarkdown(view.text||'',!terminal.has(view.status));
    if(view.reasoning){const reasoning=bubble.querySelector('.durable-reasoning');let details=reasoning.querySelector('details');if(!details){reasoning.innerHTML='<details><summary>思考过程</summary><div></div></details>';details=reasoning.querySelector('details');}details.querySelector('div').textContent=view.reasoning;}
    const signature=JSON.stringify(view.tools||[]);
    if(signature!==view.toolSignature){patchToolBox(bubble.querySelector('.durable-tools'),view.tools||[],view.id);view.toolSignature=signature;}
    const info=bubble.querySelector('.chat-info');info.textContent=view.error||(!terminal.has(view.status)?view.info||labels[view.status]:'');info.style.display=info.textContent?'flex':'none';
    node.dataset.content=view.text||'';node.querySelector('.msg-actions').hidden=!terminal.has(view.status);
    if(view.usage){const meta=node.querySelector('.msg-meta');meta.textContent=(view.identity?.sender||'Hermes')+' · '+fmtDateTime(view.created_at)+' · '+(view.usage.total_tokens??(view.usage.prompt_tokens||0)+(view.usage.completion_tokens||0))+' tokens';}
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
    const say=(mode,text,icon)=>{try{genBarShow(mode,text,view.sid,icon);}catch{}};
    const finishBar=(mode,text)=>{try{genBarDone(mode,text,2200,view.sid);}catch{}};
    _tabStreaming[view.sid]=true;try{renderSessionTabs();}catch{}
    return {
    onAccepted:j=>{Object.assign(view,{identity:j.identity,user_identity:j.user_identity,status:j.status});say(j.status==='pending'?'queued':'thinking',j.status==='pending'?'排队中，轮到会自动执行':'正在思考');paint();},
    onSnapshot:j=>{const was=view.status;Object.assign(view,{identity:j.identity,user_identity:j.user_identity,status:j.status});
      /* 快照就是「服务端现在到底在干嘛」：状态从 pending 翻到 running 时顶栏必须跟着翻。
         以前只 Object.assign 不 say()，于是 POST 那一刻写的「排队中，轮到会自动执行」再没人改，
         任务早跑起来了顶栏还在排队（2026-11-12 用户手机实测：排队中一直挂到 clarify 卡刷出来）。 */
      if(j.status!==was&&j.status==='running')say('thinking','正在思考');paint();},
    onDelta:d=>{view.text+=d;view.status='running';if(!view._sawText){view._sawText=true;}say('generating','撰写回复');paint();},onReplace:t=>{view.text=t;paint();},
    onReasoning:d=>{view.reasoning+=d;say('reasoning','正在思考');paint();},
    onTool:t=>{const key=t.toolCallId||t.tool,index=view.tools.findIndex(x=>(x.toolCallId||x.tool)===key);if(index<0)view.tools.push(t);else view.tools[index]={...view.tools[index],...t};
      // 「图标 + 动作 + 目标 ×N」：图标用工具自己的 emoji（🐍/📖/🔧/💻/✍️…），和 Discord 那套一致
      const zh=TOOL_VERB[t.tool]||t.toolZh||t.tool||'工具';
      const lbl=String(t.label||'').replace(/\s+/g,' ').trim();
      const sig=zh+'\u0000'+lbl;
      seenTools.set(sig,(seenTools.get(sig)||0)+1);
      const nth=seenTools.get(sig);
      const txt=(lbl?zh+' '+lbl.slice(0,44):zh)+(nth>1?' (×'+nth+')':'');
      say('tool',txt,t.emoji||'🛠');paint();},
    onUsage:u=>{view.usage=u;paint();},onInfo:i=>{view.info=i;paint();},
    onError:e=>{view.error=e;view.status='failed';finishBar('error','出错');paint();},
    onDone:stopped=>{view.status=stopped?'interrupted':'done';_tabStreaming[view.sid]=false;finishBar(stopped?'stopped':'done',stopped?'已停止':'完成');_flushStreamRender('queue:'+view.id);renderTurn(view);loadSessions();
      // Reload committed message identities/result after the runner finished, without touching other tabs.
      if(view.sid===currentSession)setTimeout(()=>loadSessionMessages(view.sid,false,true),100);
      if(!stopped&&view.text&&localStorage.getItem('fnos-voice-autoplay')==='1'&&view.sid===currentSession)setTimeout(()=>{const button=document.querySelector('.msg.assistant[data-request-id="'+view.id+'"] [onclick="speakMsg(this)"]');if(button)speakMsg(button);},250);
    },
  };}
  function watchJob(job){
    let view=views.get(job.id);if(!view){view={id:job.id,sid:job.session_id,message:job.message,created_at:job.created_at,identity:job.identity,user_identity:job.user_identity,text:'',reasoning:'',tools:[],status:job.status};views.set(job.id,view);}
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
      const view={id:payload.request_id,sid,message:buildMessageContent(text,attachments),ask:askText,quote:quoteForView,created_at:Date.now(),...context,text:'',reasoning:'',tools:[],status:'pending'};views.set(view.id,view);renderTurn(view);clearSentDraft(sid);submit(payload,callbacks(view));
    }catch(e){
      const d=getDraft(sid);if(!d.text)saveLocal(sid,{...d,text:askText,attachments,dirty:true,local_updated_at:Date.now()});
      if(sid===currentSession){const ta=document.getElementById('chatInput');if(!ta.value){ta.value=askText;_pendingAttachments=attachments;renderAttachChips();autoResize(ta);}captureDraft(sid);}
      toast('消息未发送，输入已保留：'+e.message);
    }
  };
  document.addEventListener('input',e=>{if(e.target.id==='chatInput')captureDraft(currentSession||'new');});
  window.addEventListener('beforeunload',e=>{for(const [sid,d] of localDrafts){const state=draftDurability.get(sid)||{local:true,server:false};if(d.dirty&&!state.local&&!state.server){e.preventDefault();e.returnValue='';return;}}});
  window.addEventListener('pagehide',()=>captureDraft(currentSession||'new'));
  window.addEventListener('online',()=>{fetchToken().then(()=>{resumeOutbox();refreshQueue();for(const [sid,d] of localDrafts)if(d.dirty)syncDraft(sid);});});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)captureDraft(currentSession||'new');else{refreshQueue();resumeOutbox();}});
  async function init(){await fetchToken();await refreshQueue();restoreDraft(currentSession||'new');resumeOutbox();queueTimer=setInterval(()=>{refreshQueue();if(navigator.onLine)resumeOutbox();},4000);}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>init().catch(()=>{}));else init().catch(()=>{});
})();
