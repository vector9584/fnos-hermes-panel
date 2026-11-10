(function () {
  'use strict';
  var tasks = [], pageSize = 30, total = 0, hasMore = false, nextBeforeId = null, loading = false, loadVersion = 0, searchTimer;
  var names = {staged:'暂存',pending:'待回信',doing:'在途中',review:'已回信 · 待定',done:'已回信',failed:'没收到',dropped:'已沉寂'};
  function element(tag, text, className) {
    var result = document.createElement(tag);
    if (text != null) result.textContent = text;
    if (className) result.className = className;
    return result;
  }
  function button(text, action) {
    var result = element('button', text, 'action'); result.type = 'button'; result.onclick = action; return result;
  }
  async function api(body) {
    var response = await fetch(apiUrl('/api/echo'), {method: body ? 'POST' : 'GET',
      headers: {'Content-Type':'application/json','X-Monitor-Token':monitorToken || ''}, body: body ? JSON.stringify(body) : undefined});
    var result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || '回声站连接失败');
    return result;
  }
  function children(task) { return tasks.filter(function (item) { return item.parent === task.id; }); }
  function family(task) {
    var result = [], queue = [task], seen = new Set();
    while (queue.length) { var item = queue.shift(); if (seen.has(item.id)) continue; seen.add(item.id); result.push(item); queue.push.apply(queue,children(item)); }
    return result;
  }
  function effective(task) {
    var seen = new Set();
    while (task && !seen.has(task.id)) {
      seen.add(task.id); var nested = children(task).sort(function (left,right) { return right.id-left.id; });
      if (!nested.length) return task.status; task = nested[0];
    }
    return 'failed';
  }
  function render() {
    var list = document.getElementById('echoList'), query = document.getElementById('echoSearch').value.trim().toLowerCase();
    var roots = tasks.filter(function (task) { return !task.parent; }).sort(function (left,right) { return right.id-left.id; });
    list.replaceChildren();
    roots.forEach(function (task) {
      var card = element('article', null, 'echo-card');
      card.append(element('p','#'+task.id+' · '+names[effective(task)],'echo-status'),element('h3',task.title),
        element('p',task.detail,'echo-excerpt'),element('p',task.type+' · '+task.star+' 星 · '+(family(task).length-1)+' 个子任务','pw-hint'),
        button('查看任务与回信',function () { detail(task.id); })); list.append(card);
    });
    if (!roots.length) list.append(element('p',total?'没有匹配的任务，可调整筛选或搜索。':'还没有任务，点击“递一句话”记录想法。','empty-state'));
    document.getElementById('echoMore').hidden = !hasMore;
    document.getElementById('echoFeedback').textContent = query || document.getElementById('echoFilter').value !== 'all'
      ? '匹配 '+total+' 组任务，已显示 '+roots.length+' 组'
      : '共 '+total+' 组任务，已显示 '+roots.length+' 组';
  }
  async function load(append) {
    if (loading) return;
    loading = true; var version = ++loadVersion;
    var status = document.getElementById('echoFeedback'); if (!append) status.textContent = '正在读取队列…';
    try {
      var queryValue=document.getElementById('echoSearch').value.trim(),statusValue=document.getElementById('echoFilter').value;
      var targetRoots=append?0:tasks.filter(function(task){return !task.parent;}).length;
      var cursor=append?nextBeforeId:null,loaded=[],result,rootCount=0;
      do {
        var parameters={limit:String(pageSize),status:statusValue,query:queryValue};if(cursor)parameters.before_id=String(cursor);
        var response=await fetch(apiUrl('/api/echo?'+new URLSearchParams(parameters).toString()),{headers:{'X-Monitor-Token':monitorToken||''}});result=await response.json();
        if(!response.ok||!result.ok)throw new Error(result.error||'回声站连接失败');
        if(version!==loadVersion)return;
        loaded=loaded.concat(result.tasks);rootCount+=result.tasks.filter(function(task){return !task.parent;}).length;cursor=result.next_before_id;
      } while(!append&&rootCount<targetRoots&&cursor);
      tasks=append?tasks.concat(loaded):loaded;total=result.total;hasMore=result.has_more;nextBeforeId=result.next_before_id;render();
    }
    catch (error) { if(version===loadVersion)status.textContent = error.message + (tasks.length?'；保留上次列表':''); }
    finally { if(version===loadVersion)loading = false; }
  }
  function dialog(title) {
    var previous = document.activeElement, overlay = element('div',null,'modal-overlay');
    overlay.innerHTML = '<section class="modal cron-native-editor echo-dialog" role="dialog" aria-modal="true"><div class="modal-head"><h3></h3><button class="modal-close" aria-label="关闭">×</button></div><div class="modal-body"></div><div class="modal-foot"></div></section>';
    overlay.querySelector('h3').textContent = title; overlay.querySelector('section').setAttribute('aria-label',title);
    function close() { overlay.remove(); if (previous && previous.isConnected) previous.focus(); }
    overlay.querySelector('.modal-close').onclick = close;
    overlay.onkeydown = function (event) {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key === 'Tab') {
        var targets = Array.from(overlay.querySelectorAll('button,input,textarea,select,summary')).filter(function (item) { return !item.disabled && item.getClientRects().length; });
        if (event.shiftKey && document.activeElement === targets[0]) { event.preventDefault(); targets[targets.length-1].focus(); }
        if (!event.shiftKey && document.activeElement === targets[targets.length-1]) { event.preventDefault(); targets[0].focus(); }
      }
    };
    document.body.append(overlay); overlay.querySelector('.modal-close').focus();
    return {body:overlay.querySelector('.modal-body'),foot:overlay.querySelector('.modal-foot'),close:close};
  }
  async function action(task, kind, view) {
    if (['archive','restore','cancel'].includes(kind) && !confirm(kind==='archive'?'归档并保留任务与全部历史？':kind==='cancel'?'请求停止这次执行？已经完成的工具操作不会自动撤销。':'恢复归档前状态？待回信任务可能被执行器接手。')) return;
    var status = element('p','正在保存…'); view.foot.replaceChildren(status);
    try {
      await api({action:kind,id:task.id,revision:task.panel_revision,request_id:crypto.randomUUID()});
      while(loading) await new Promise(function(resolve){setTimeout(resolve,20);});
      await load(false);
      while(loading) await new Promise(function(resolve){setTimeout(resolve,20);});
      view.close(); detail(task.id);
    }
    catch (error) { status.textContent = error.message; view.foot.append(button('重新读取',async function () { await load(); view.close(); detail(task.id); })); }
  }
  function detail(id) {
    var task = tasks.find(function (item) { return item.id===id; }); if (!task) return;
    var view = dialog('#'+id+' '+task.title);
    view.body.append(element('p',names[task.status]+' · '+task.star+' 星','echo-status'));
    [['任务要求',task.detail],['失败详情',task.error]].forEach(function (item) {
      if (item[1]) view.body.append(element('h4',item[0]),element('pre',item[1],'echo-text'));
    });
    (task.todos || []).forEach(function (item) { view.body.append(element('p',(item.s==='done'?'✓ ':'○ ')+item.c)); });
    var entries=(task.entries||[]).slice(),kinds=new Set(entries.map(function(e){return e.kind;}));
    [['reply',task.result],['deliver',task.deliver],['pending',task.decide]].forEach(function(item){if(item[1]&&!kinds.has(item[0]))entries.push({kind:item[0],text:item[1]});});
    entries.forEach(function(entry,index){
      view.body.append(element('h4',({deliver:'交付',reply:'回信',pending:'待定',drop:'沉寂',silent:'沉寂',sediment:'沉淀'})[entry.kind]||'记录'));
      if(entry.at)view.body.append(element('p',new Date(entry.at).toLocaleString('zh-CN'),'pw-hint'));
      if(task.report&&entry.kind==='deliver'&&!entries.slice(index+1).some(function(e){return e.kind==='deliver';})){
        var report=task.report;
        if(report.detail)view.body.append(element('pre',report.detail,'echo-text'));
        (report.numbers||[]).forEach(function(number){view.body.append(element('p',number.k+'：'+number.v,'echo-metric'));});
        (report.files||[]).forEach(function(file){view.body.append(element('pre',file,'echo-text'));});
      }else view.body.append(element('pre',entry.text||'','echo-text'));
    });
    var execution=task.exec||{};
    view.body.append(element('p',(execution.mode==='deep'?'深入执行 · 要求自检 '+execution.iters+' 轮':'标准执行')+' · '+(execution.model||'沿用定时任务模型'),'pw-hint'));
    if(task.rounds)view.body.append(element('p','模型调用 '+task.rounds+' 次'+(task.rounds_src==='flag'?'（历史手填记录）':'（执行会话记录）'),'pw-hint'));
    var sediment=task.sediment||{};
    if(sediment.status)view.body.append(element('h4','对话沉淀'),element('p',sediment.status==='done'?'已生成知识笔记':sediment.status==='pending'?'等待归档沉淀定时任务接手':'沉淀状态：'+sediment.status),element('pre',sediment.file||'','echo-text'));
    var runs=(task.panel_runs||[]).concat(task.panel_run?[task.panel_run]:[]);
    if(runs.length){var runHistory=element('details');runHistory.append(element('summary','执行记录（'+runs.length+'）'));runs.slice().reverse().forEach(function(run){runHistory.append(element('h4',({running:'正在执行',completed:'已交付',interrupted:'执行中断',cancelled:'已取消'})[run.state]||'已记录执行'),element('p',new Date(run.started_at).toLocaleString('zh-CN')+' · '+(run.model||run.model_requested||'沿用定时任务模型'),'pw-hint'));if(run.session_id)runHistory.append(element('pre','会话 '+run.session_id,'echo-text'));});view.body.append(runHistory);}
    children(task).forEach(function (item) { view.body.append(button('子任务 #'+item.id+' · '+names[effective(item)],function () { view.close(); detail(item.id); })); });
    if (task.parent) view.body.append(button('返回父任务 #'+task.parent,function () { view.close(); detail(task.parent); }));
    var timeline = element('details'); timeline.append(element('summary','往来记录（'+(task.events || []).length+'）'));
    (task.events || []).forEach(function (event) { timeline.append(element('p',new Date(event.t).toLocaleString('zh-CN')+' · '+(event.text || event.note || event.k))); }); view.body.append(timeline);
    view.foot.append(button('刷新状态',async function () { await load(); view.close(); detail(id); }));
    if (task.status==='doing'||(task.panel_run||{}).state==='running') {
      view.body.append(element('p',task.panel_cancel_requested?'已请求取消，等待执行器停止。':'执行器正在处理，关闭面板不会终止任务。','pw-hint'));
      if((task.panel_run||{}).state==='running'){
        if(!task.panel_cancel_requested)view.foot.append(button('取消执行',function(){action(task,'cancel',view);}));
        view.foot.append(button('核对中断状态',function(){action(task,'recover',view);}));
      }
      return;
    }
    view.foot.append(button('编辑',function () {view.close();edit(task);}));
    if (['pending','staged'].includes(task.status)) view.foot.append(button(task.status==='staged'?'加入待回信':'暂存',function () {action(task,task.status==='staged'?'enqueue':'stage',view);}));
    if (task.status==='failed') view.foot.append(button('重试',function () {action(task,'retry',view);}));
    if (task.status==='review') view.foot.append(button('处理待定',function () {view.close();edit(task,'answer');}));
    if (['done','review','failed'].includes(task.status)) view.foot.append(button('追加子任务',function () {view.close();edit(task,'spawn');}));
    view.foot.append(button(task.status==='dropped'?'恢复归档':'归档',function () {action(task,task.status==='dropped'?'restore':'archive',view);}));
  }
  function edit(task, kind) {
    kind = kind || (task?'update':'create'); var fork = ['answer','spawn'].includes(kind);
    var key = 'echo-draft:'+kind+':'+(task?task.id:'new'), view = dialog(fork?'子任务要求':task?'编辑任务':'递一句话');
    var form = element('form'), feedback = element('p','','echo-form-feedback'); feedback.setAttribute('role','status'); view.body.append(form,feedback);
    var savedClientId='';try{savedClientId=localStorage.getItem('echo-client-id')||'';}catch(_){}
    var inputs={},initial={},revision=task && task.panel_revision,requestId=crypto.randomUUID(),draftRevision=null,clientId='echo-web-'+(savedClientId||crypto.randomUUID()),busy=false;
    try{localStorage.setItem('echo-client-id',clientId.slice('echo-web-'.length));}catch(_){}
    var fields = fork ? [['detail',kind==='answer'?'我的要求（留空按建议执行）':'追加要求','textarea']] : [['title','任务名称','text'],['detail','任务要求','textarea'],['type','类型','select'],['star','优先级（半星暂存，一星起入队）','number'],['deep','深入执行','checkbox'],['iters','要求自检轮数','number'],['model','执行模型（留空沿用定时任务设置）','text'],['track','沿用手机状态推送','checkbox']];
    if(kind==='create') fields.push(['staged','先暂存，暂不执行','checkbox']);
    fields.forEach(function(field){
      var label=element('label',null,'field'),input=element(field[2]==='textarea'?'textarea':field[2]==='select'?'select':'input');
      if(field[2]==='select') ['开发','研究','运维','内容','生活','其他'].forEach(function(type){var option=element('option',type);option.value=type;input.append(option);});
      else if(field[2]!=='textarea') input.type=field[2]; input.name=field[0];
      if(field[0]==='star'){input.min='0.5';input.max='5';input.step='0.5';}
      if(field[0]==='iters'){input.min='1';input.max='10';input.step='1';}
      var execution=task&&task.exec||{},defaults={type:'开发',star:3,iters:3};
      var value=fork?'':field[0]==='deep'?execution.mode==='deep':['iters','model'].includes(field[0])?execution[field[0]]==null?defaults[field[0]]:execution[field[0]]:task?task[field[0]]:defaults[field[0]];
      if(field[2]!=='checkbox') input.value=value==null?'':value;else input.checked=!!value;
      if(field[0]==='title'||field[0]==='detail'&&kind!=='answer') input.required=true;
      inputs[field[0]]=input;initial[field[0]]=input.type==='checkbox'?input.checked:input.value;label.append(element('span',field[1]),input);form.append(label);
    });
    var draft;try{draft=JSON.parse(localStorage.getItem(key)||'null');}catch(_){}
    if(draft){revision=draft.revision;requestId=draft.requestId;draftRevision=draft.draftRevision||null;initial=draft.initial||initial;Object.keys(inputs).forEach(function(name){if(inputs[name].type==='checkbox')inputs[name].checked=!!draft.values[name];else if(draft.values[name]!=null)inputs[name].value=draft.values[name];});feedback.textContent='已恢复本机草稿';}
    function values(){var result={};Object.keys(inputs).forEach(function(name){result[name]=inputs[name].type==='checkbox'?inputs[name].checked:inputs[name].value;});return result;}
    var draftTimer,draftWrite=Promise.resolve();
    var serverKey=key.replace(/^echo-draft:/,'');
    function saveDraft(value){draftWrite=draftWrite.catch(function(){}).then(async function(){var result=await api({action:'draft_save',key:serverKey,values:value,initial:initial,source_revision:revision,request_id:requestId,draft_revision:draftRevision,client_id:clientId});draftRevision=result.draft.draft_revision;try{localStorage.setItem(key,JSON.stringify({values:value,initial:initial,revision:revision,requestId:requestId,draftRevision:draftRevision}));}catch(_){}feedback.textContent='草稿已同步，可在其他设备继续编辑';});return draftWrite;}
    async function flushDraft(){clearTimeout(draftTimer);await draftWrite;await saveDraft(values());}
    async function persist(){if(busy)return;var value=values();try{localStorage.setItem(key,JSON.stringify({values:value,initial:initial,revision:revision,requestId:requestId,draftRevision:draftRevision}));}catch(_){feedback.textContent='本机草稿无法保存，正在同步服务端…';}clearTimeout(draftTimer);draftTimer=setTimeout(function(){saveDraft(value).catch(function(error){feedback.textContent=error.message+'；本机输入仍保留';});},450);}
    async function loadServerDraft(){try{var result=await api({action:'draft_get',key:serverKey});var remote=result.draft;if(!remote)return;if(draft&&JSON.stringify(draft.values)!==JSON.stringify(remote.values)){feedback.textContent='此设备与其他设备各有草稿，请选择保留内容';var useRemote=button('载入服务端草稿',function(){Object.keys(inputs).forEach(function(name){if(inputs[name].type==='checkbox')inputs[name].checked=!!remote.values[name];else if(remote.values[name]!=null)inputs[name].value=remote.values[name];});draftRevision=remote.draft_revision;requestId=remote.request_id||requestId;initial=remote.initial||initial;revision=remote.source_revision||revision;feedback.textContent='已载入其他设备的草稿';});view.foot.prepend(useRemote);return;}if(!draft){Object.keys(inputs).forEach(function(name){if(inputs[name].type==='checkbox')inputs[name].checked=!!remote.values[name];else if(remote.values[name]!=null)inputs[name].value=remote.values[name];});draftRevision=remote.draft_revision;requestId=remote.request_id||requestId;initial=remote.initial||initial;revision=remote.source_revision||revision;feedback.textContent='已恢复跨设备草稿';}}catch(error){feedback.textContent='跨设备草稿读取失败：'+error.message;}}
    loadServerDraft();
    async function mergeLatest(){
      try{
        var result=await api(),latest=result.tasks.find(function(item){return item.id===task.id;});
        if(!latest)throw new Error('任务不存在，当前草稿仍保留');
        if(latest.status==='doing'||(latest.panel_run||{}).state==='running')throw new Error('任务正在执行，草稿保留，执行结束后可继续合并');
        var merge=dialog('合并任务修改');merge.body.append(element('h4','最新已保存要求'),element('pre',latest.detail,'echo-text'));
        var label=element('label','合并后的要求','field'),text=element('textarea');text.value=inputs.detail.value;label.append(text);merge.body.append(label,element('p','名称、星级和执行选项沿用当前草稿，保存前可继续修改。','pw-hint'));
        merge.foot.append(button('采用合并稿',function(){inputs.detail.value=text.value;revision=latest.panel_revision;requestId=crypto.randomUUID();Object.keys(initial).forEach(function(name){var ex=latest.exec||{};initial[name]=name==='deep'?ex.mode==='deep':['iters','model'].includes(name)?ex[name]||({iters:3,model:''})[name]:latest[name];});persist();feedback.textContent='已采用最新任务版本，请检查后保存';merge.close();}));
      }catch(error){feedback.textContent=error.message;}
    }
    form.oninput=persist;var submit=button('保存',function(){form.requestSubmit();});submit.classList.add('primary');
    view.foot.append(button('丢弃草稿',async function(){if(busy||!confirm('丢弃草稿并重新读取？'))return;clearTimeout(draftTimer);try{localStorage.removeItem(key);await api({action:'draft_delete',key:serverKey,draft_revision:draftRevision});}catch(error){feedback.textContent='服务端草稿未能丢弃：'+error.message;return;}await load();view.close();edit(task?tasks.find(function(item){return item.id===task.id;}):null,kind);}),submit);
    form.onsubmit=async function(event){
      event.preventDefault();if(busy)return;var body=values();if(body.star!=null)body.star=Number(body.star);
      var executionChanged=['deep','iters','model'].some(function(name){return String(body[name])!==String(initial[name]);});
      var execution=!fork?{mode:body.deep?'deep':'normal',iters:Number(body.iters),model:body.model}:null;
      if(kind==='update')Object.keys(body).forEach(function(name){if(String(body[name])===String(initial[name]))delete body[name];});
      ['deep','iters','model'].forEach(function(name){delete body[name];});if(execution&&(kind!=='update'||executionChanged))body.exec=execution;
      var request={action:kind,body:body,request_id:requestId};if(task){request.id=task.id;request.revision=revision;}
      clearTimeout(draftTimer);busy=true;submit.disabled=true;feedback.textContent='正在保存…';
      try{
        await draftWrite;
        await api(request);
      }catch(error){
        feedback.textContent=error.message;
        if(task&&!view.foot.querySelector('.echo-merge')){var mergeButton=button('查看最新并合并',mergeLatest);mergeButton.classList.add('echo-merge');view.foot.prepend(mergeButton);}
        busy=false;submit.disabled=false;return;
      }
      try{localStorage.removeItem(key);}catch(_){}
      var cleanupError=null;
      try{await api({action:'draft_delete',key:serverKey,draft_revision:draftRevision});}
      catch(error){
        cleanupError=error;
        try{
          var latestDraft=await api({action:'draft_get',key:serverKey});
          if(latestDraft.draft&&latestDraft.draft.client_id===clientId&&latestDraft.draft.request_id===requestId)
            await api({action:'draft_delete',key:serverKey,draft_revision:latestDraft.draft.draft_revision});
          else if(latestDraft.draft)throw new Error('另一设备的草稿已保留');
          cleanupError=null;
        }catch(retryError){cleanupError=retryError;}
      }
      view.close();
      await load();
      if(cleanupError)document.getElementById('echoFeedback').textContent='任务已保存；草稿清理稍后重试：'+cleanupError.message;
      busy=false;submit.disabled=false;
    };(inputs.title||inputs.detail).focus();
  }
  var page=element('section',null,'page');page.id='page-echo';
  page.innerHTML='<div class="page-header"><h1>回声站 ECHO</h1><button class="ov-actbtn echo-new" style="margin-left:auto">递一句话</button></div><div class="page-body"><p class="pw-hint">丢下来，等回声。任务由现有执行器接手，关闭面板不影响队列。</p><div class="echo-toolbar"><label>查看<select id="echoFilter"><option value="all">全部</option></select></label><label>搜索<input id="echoSearch" type="search" placeholder="任务、要求、回信或 #编号"></label><button class="action echo-refresh">刷新</button></div><p id="echoFeedback" role="status"></p><div id="echoList" class="echo-grid"></div><button id="echoMore" class="action" hidden>加载更多</button></div>';
  document.getElementById('page-cron').insertAdjacentElement('afterend',page);
  Object.keys(names).forEach(function(key){var option=element('option',names[key]);option.value=key;page.querySelector('#echoFilter').append(option);});
  var filter=page.querySelector('#echoFilter'),search=page.querySelector('#echoSearch');
  try{filter.value=localStorage.getItem('echo-filter')||'all';search.value=localStorage.getItem('echo-search')||'';}catch(_){}
  function changed(){++loadVersion;loading=false;tasks=[];total=0;hasMore=false;nextBeforeId=null;try{localStorage.setItem('echo-filter',filter.value);localStorage.setItem('echo-search',search.value);}catch(_){}load(false);}
  filter.onchange=changed;search.oninput=function(){clearTimeout(searchTimer);searchTimer=setTimeout(changed,250);};page.querySelector('.echo-new').onclick=function(){edit();};page.querySelector('.echo-refresh').onclick=function(){load(false);};
  page.querySelector('#echoMore').onclick=function(){load(true);};
  window.renderEchoPage=load;
  setInterval(function () {
    if (!document.hidden && page.classList.contains('active') && !document.querySelector('.echo-dialog')) load();
  },15000);
}());
