/* Durable execution transport and per-session drafts. No model request is owned by a tab. */
(function () {
  'use strict';
  const subscriptions = new Map(), localDrafts = new Map(), draftTimers = new Map(), draftRetryTimers = new Map(), draftDurability = new Map(), acceptedOutbox = new Set();
  const terminal = new Set(['done', 'failed', 'cancelled', 'interrupted']);
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
    state.finished = true; state.controller?.abort(); clearTimeout(state.retry);
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
    }
    if(packet.done)finish(state,packet.status,packet.error);
    updateSend();
  }
  async function subscribe(state) {
    if(state.finished)return;
    const controller=new AbortController();state.controller=controller;
    try {
      const r=await fetch(apiUrl('/api/chat/queue/'+state.id+'/events'),{headers:{'X-Monitor-Token':monitorToken||''},cache:'no-store',signal:controller.signal});
      if(!r.ok)throw Object.assign(Error('执行进度连接失败（'+r.status+'）'),{status:r.status});
      const reader=r.body.getReader(),dec=new TextDecoder();let buffer='';state.failures=0;
      try{
        while(!state.finished){const chunk=await reader.read();if(chunk.done)break;buffer+=dec.decode(chunk.value,{stream:true});
          let boundary;while((boundary=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);
            for(const line of frame.split('\n'))if(line.startsWith('data: '))event(state,JSON.parse(line.slice(6)));
          }
        }
      }finally{reader.releaseLock();}
      if(!state.finished)throw Error('连接已断开');
    }catch(e){
      if(state.finished)return;
      state.cb.onInfo?.('连接中断，正在恢复进度。消息已保存在服务端。');
      if(e.status===401)await fetchToken().catch(()=>{});
      state.failures++;state.retry=setTimeout(()=>subscribe(state),Math.min(15000,1000*2**Math.min(state.failures,4)));
    }
  }
  async function submit(payload, cb) {
    const id=payload.request_id,existing=subscriptions.get(id);
    if(existing)return;
    const state={id,sid:payload.session_id,cb,text:'',reasoning:'',seq:0,status:'pending',finished:false,failures:0};
    subscriptions.set(id,state);
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
  function messageText(j){const m=j.message;return typeof m==='string'?m:m?.text||'含附件的消息';}
  function renderQueue(){
    const composer=document.getElementById('chatComposer');if(!composer)return;
    let panel=document.getElementById('durableQueue');
    if(!panel){panel=document.createElement('section');panel.id='durableQueue';panel.className='durable-queue';panel.setAttribute('aria-label','消息执行队列');composer.prepend(panel);}
    const visible=jobs.filter(j=>j.session_id===currentSession),outbox=Object.values(read(outboxKey,{})).filter(p=>p.session_id===currentSession&&!acceptedOutbox.has(p.request_id)&&!visible.some(j=>j.id===p.request_id));
    panel.hidden=!visible.length&&!outbox.length;
    panel.innerHTML=visible.map(j=>'<div class="dq-item"><span class="dq-status '+E(j.status)+'">'+E(labels[j.status])+'</span><span class="dq-text" title="'+E(messageText(j))+'">'+E(messageText(j).slice(0,90))+'</span>'+(j.status==='interrupted'?'<button data-queue-resolve="'+j.id+'">已查看，继续后续消息</button>':'<button data-queue-cancel="'+j.id+'">'+(j.status==='running'?'停止':'取消')+'</button>')+'</div>').join('')+
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
    try{const data=await request('/api/chat/queue');jobs=data.jobs||[];renderQueue();updateSend();
      for(const j of jobs)if(j.session_id===currentSession&&!subscriptions.has(j.id)&&j.status!=='interrupted')watchJob(j);
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
  function setDraftDurability(sid,kind,value){const state=draftDurability.get(sid)||{local:true,server:false};state[kind]=value;draftDurability.set(sid,state);renderDraftDurability(sid);}
  function scheduleDraftRetry(sid){clearTimeout(draftRetryTimers.get(sid));draftRetryTimers.set(sid,setTimeout(()=>{if(navigator.onLine)syncDraft(sid);},5000));}
  function renderDraftDurability(sid){
    const composer=document.getElementById('chatComposer');if(!composer||sid!==currentSession)return;
    let box=document.getElementById('draftDurabilityStatus');if(!box){box=document.createElement('p');box.id='draftDurabilityStatus';box.className='draft-durability-status';box.setAttribute('role','status');box.setAttribute('aria-live','polite');box.hidden=true;composer.prepend(box);}
    const state=draftDurability.get(sid)||{local:true,server:false};
    const d=localDrafts.get(sid);const changed=!!d?.dirty;
    const protectedCopy=state.local||state.server;
    box.textContent=changed&&!protectedCopy?'草稿尚未保存到设备或服务器。请保持此页面打开；恢复连接后会自动重试。':
      !state.local&&state.server?'草稿已同步到服务器，本机存储不可用。':
      changed&&state.local&&!state.server?'草稿已保存在此设备，正在同步到服务器…':
      changed?'草稿已保存在此设备和服务器。':'';
    box.hidden=!box.textContent;
  }
  function draftOptions(){return {model:typeof _getSessionModel==='function'?_getSessionModel(currentSession):null,skills:typeof _activeSkills!=='undefined'?_activeSkills:[],connector:typeof _selectedConnector!=='undefined'?_selectedConnector:null};}
  function captureDraft(sid){
    if(applyingDraft)return;
    sid=sid||'new';const ta=document.getElementById('chatInput');if(!ta)return;
    const d=getDraft(sid);const text=ta.value,attachments=JSON.parse(JSON.stringify(_pendingAttachments||[])),options=draftOptions();
    if(d.text===text&&JSON.stringify(d.attachments)===JSON.stringify(attachments)&&JSON.stringify(d.options)===JSON.stringify(options))return;
    const next={...d,text,attachments,options,dirty:true,local_updated_at:Date.now()};
    setDraftDurability(sid,'server',false);if(!saveLocal(sid,next))toast('草稿本机保存失败，正在尝试同步。');
    clearTimeout(draftTimers.get(sid));draftTimers.set(sid,setTimeout(()=>syncDraft(sid),600));
  }
  async function syncDraft(sid){
    const d=getDraft(sid);if(d.saving){if(d.dirty)scheduleDraftRetry(sid);return;}d.saving=true;
    const stamp=d.local_updated_at;
    try{
      if(d.dirty){
        const result=await request('/api/workspace-ui/draft?session_id='+encodeURIComponent(sid),'PUT',{...d,client_id:clientId});
        const latest=getDraft(sid);
        setDraftDurability(sid,'server',true);
        if(latest.local_updated_at===stamp){saveLocal(sid,{...result.draft,dirty:false});setDraftDurability(sid,'server',true);clearTimeout(draftRetryTimers.get(sid));}
        else{latest.revision=result.draft.revision;saveLocal(sid,latest);setDraftDurability(sid,'server',false);scheduleDraftRetry(sid);}
      }else{
        const remote=await request('/api/workspace-ui/draft?session_id='+encodeURIComponent(sid));
        if(!getDraft(sid).dirty){saveLocal(sid,{...remote,dirty:false});if(currentDraft===sid)applyDraft(sid);}
      }
    }catch(e){
      if(d.dirty)setDraftDurability(sid,'server',false);
      if(e.status===409&&e.result?.draft){setDraftDurability(sid,'server',true);const latest=getDraft(sid);latest.revision=e.result.draft.revision;latest.conflicts=e.result.draft.conflicts;latest.conflict_remote=e.result.draft;latest.dirty=false;saveLocal(sid,latest);setDraftDurability(sid,'server',true);renderDraftConflict(sid);}
      else if(d.dirty)scheduleDraftRetry(sid);
    }finally{const latest=getDraft(sid);latest.saving=false;renderDraftDurability(sid);if(latest.dirty&&latest.local_updated_at!==stamp)setTimeout(()=>syncDraft(sid),0);}
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
    const d=getDraft(sid);box.hidden=!d.conflict_remote;
    if(d.conflict_remote)box.innerHTML='<span>其他设备也修改了草稿，两份内容都已保存。</span><button id="draftCompare">查看两份草稿</button>';
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
  const previousRenderAttachments=renderAttachChips;
  window.renderAttachChips=function(){const value=previousRenderAttachments();if(!applyingDraft)setTimeout(()=>captureDraft(currentSession||'new'),0);return value;};
  const previousSetModel=_setSessionModel;
  window._setSessionModel=function(sid,model){const result=previousSetModel(sid,model);if(!applyingDraft&&sid===currentSession)setTimeout(()=>captureDraft(sid),0);return result;};
  // Render by stable request ID, never through a closure that holds another tab's DOM.
  const views=new Map();
  function renderTurn(view){
    if(view.sid!==currentSession||_channelViewActive)return;
    const body=document.getElementById('chatBody');if(!body)return;
    let node=body.querySelector('.msg.assistant[data-request-id="'+view.id+'"]');
    if(!node){
      if(!body.querySelector('.msg'))body.innerHTML='';
      if(!body.querySelector('.msg.user[data-request-id="'+view.id+'"]'))body.insertAdjacentHTML('beforeend',msgHTML({role:'user',content:view.message,ts:view.created_at,request_id:view.id,...view.user_identity}));
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
    if(signature!==view.toolSignature){
      const area=bubble.querySelector('.durable-tools'),old=area.querySelector('.tool-calls');
      const collapsed=old?.getAttribute('data-collapsed');const opened=[...area.querySelectorAll('.tool-call')].map((e,i)=>e.classList.contains('open')?i:-1).filter(i=>i>=0);
      area.innerHTML=toolCallsHTML(view.tools||[]);const box=area.querySelector('.tool-calls');if(box&&collapsed)box.setAttribute('data-collapsed',collapsed);
      area.querySelectorAll('.tool-call').forEach((e,i)=>{if(opened.includes(i))e.classList.add('open');});view.toolSignature=signature;
    }
    const info=bubble.querySelector('.chat-info');info.textContent=view.error||(!terminal.has(view.status)?view.info||labels[view.status]:'');info.style.display=info.textContent?'flex':'none';
    node.dataset.content=view.text||'';node.querySelector('.msg-actions').hidden=!terminal.has(view.status);
    if(view.usage){const meta=node.querySelector('.msg-meta');meta.textContent=(view.identity?.sender||'Hermes')+' · '+fmtDateTime(view.created_at)+' · '+(view.usage.total_tokens??(view.usage.prompt_tokens||0)+(view.usage.completion_tokens||0))+' tokens';}
    if(autoScrollActive())followChatBottom();_chatHTML[view.sid]=body.innerHTML;
  }
  document.addEventListener('hermes:display',function(){views.forEach(view=>{view.toolSignature=null;var node=document.querySelector('.msg.assistant[data-request-id="'+view.id+'"] .durable-tools');if(node)node.replaceChildren();renderTurn(view);});});
  function callbacks(view){const paint=()=>_throttledRender('queue:'+view.id,()=>renderTurn(view),100);return {
    onAccepted:j=>{Object.assign(view,{identity:j.identity,user_identity:j.user_identity,status:j.status});paint();},
    onSnapshot:j=>{Object.assign(view,{identity:j.identity,user_identity:j.user_identity,status:j.status});},
    onDelta:d=>{view.text+=d;view.status='running';paint();},onReplace:t=>{view.text=t;paint();},
    onReasoning:d=>{view.reasoning+=d;paint();},
    onTool:t=>{const key=t.toolCallId||t.tool,index=view.tools.findIndex(x=>(x.toolCallId||x.tool)===key);if(index<0)view.tools.push(t);else view.tools[index]={...view.tools[index],...t};paint();},
    onUsage:u=>{view.usage=u;paint();},onInfo:i=>{view.info=i;paint();},
    onError:e=>{view.error=e;view.status='failed';paint();},
    onDone:stopped=>{view.status=stopped?'interrupted':'done';_flushStreamRender('queue:'+view.id);renderTurn(view);loadSessions();
      // Reload committed message identities/result after the runner finished, without touching other tabs.
      if(view.sid===currentSession)setTimeout(()=>loadSessionMessages(view.sid,false,true),100);
      if(!stopped&&view.text&&localStorage.getItem('fnos-voice-autoplay')==='1'&&view.sid===currentSession)setTimeout(()=>{const button=document.querySelector('.msg.assistant[data-request-id="'+view.id+'"] [onclick="speakMsg(this)"]');if(button)speakMsg(button);},250);
    },
  };}
  function watchJob(job){
    let view=views.get(job.id);if(!view){view={id:job.id,sid:job.session_id,message:job.message,created_at:job.created_at,identity:job.identity,user_identity:job.user_identity,text:'',reasoning:'',tools:[],status:job.status};views.set(job.id,view);}
    const state={id:job.id,sid:job.session_id,cb:callbacks(view),text:view.text,reasoning:view.reasoning,seq:0,status:job.status,finished:false,failures:0};subscriptions.set(job.id,state);subscribe(state);
  }
  window.sendRaw=async function(text){
    if(_channelViewActive){toast('当前是渠道记录预览，请先返回面板会话');return;}
    const attachments=JSON.parse(JSON.stringify(_pendingAttachments||[])),selectedSkills=_activeSkills.slice(),selectedConnector=_selectedConnector,selectedModel=_getSessionModel(currentSession);
    if(_currentQuote){text='【引用上下文】\n'+_currentQuote+'\n\n【用户追问】\n'+text;clearQuote();}
    // Keep a recovery copy before any asynchronous session creation or network request.
    const recovery={text,attachments,at:Date.now()};
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
      const view={id:payload.request_id,sid,message:buildMessageContent(text,attachments),created_at:Date.now(),...context,text:'',reasoning:'',tools:[],status:'pending'};views.set(view.id,view);renderTurn(view);clearSentDraft(sid);submit(payload,callbacks(view));
    }catch(e){
      const d=getDraft(sid);if(!d.text)saveLocal(sid,{...d,text,attachments,dirty:true,local_updated_at:Date.now()});
      if(sid===currentSession){const ta=document.getElementById('chatInput');if(!ta.value){ta.value=text;_pendingAttachments=attachments;renderAttachChips();autoResize(ta);}captureDraft(sid);}
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
