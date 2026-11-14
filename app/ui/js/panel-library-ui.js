(function(){
 'use strict';
 function el(tag,text,cls){var n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;}
 function uuid(){return crypto.randomUUID?crypto.randomUUID():'d-'+Date.now()+'-'+Math.random().toString(36).slice(2);}
 function cached(key,fallback){try{return JSON.parse(localStorage.getItem(key)||'null')||fallback;}catch(_){return fallback;}}
 function remember(key,value){try{localStorage.setItem(key,JSON.stringify(value));return true;}catch(_){return false;}}
 function trackDialog(dialog,opener,restore){dialog._libraryFocus={opener,restore:restore!==false};if(dialog._libraryTracked)return;dialog._libraryTracked=true;dialog.addEventListener('close',function(){dialog.remove();var focus=dialog._libraryFocus;if(focus?.restore&&focus.opener?.isConnected)focus.opener.focus();});}
 async function api(path,method,value){await fetchToken();var r=await fetch(apiUrl('/api/panel-library'+path),{method:method||'GET',headers:{'Content-Type':'application/json','X-Monitor-Token':monitorToken||''},body:value?JSON.stringify(value):undefined}),d=await r.json();if(!r.ok||d.error||d.ok===false)throw Object.assign(Error(d.error||'资料操作失败'),{status:r.status,data:d});return d;}
 var views={},drafts=window.PanelLibraryDrafts;
 function mount(pageId){
  var page=document.getElementById('page-'+pageId),header=page.querySelector('.page-header');header.replaceChildren();header.classList.add('library-page-header');header.append(el('h1',pageId==='kb'?'知识库':'留痕录'));var refresh=el('button','刷新','ov-actbtn'),create=el('button','新建笔记','ov-actbtn'),headerActions=el('div',undefined,'library-header-actions');headerActions.append(refresh);if(pageId==='kb')headerActions.append(create);header.append(headerActions);
  var old=page.querySelector('.page-body');if(old)old.remove();[...page.children].filter(n=>n!==header).forEach(n=>n.remove());var root=el('div',undefined,'page-body library-body');page.append(root);
  var state={sources:[],rows:[],folders:[],folder:'',offset:0,seq:0,docSeq:0,doc:null,history:[],draftRevision:0,timer:null,saving:false,loading:false,editing:false,pending:null,conflicts:[],acceptedConflicts:[],unresolved:false,remoteDraft:null,draftQueue:Promise.resolve()},saved=cached('panel-library-view:'+pageId,{});
  var toolbar=el('div',undefined,'library-toolbar'),source=el('select'),q=el('input'),searchButton=el('button','搜索','btn'),hint=el('p','','library-hint'),feedback=el('div','','maintenance-feedback');feedback.setAttribute('role','status');source.setAttribute('aria-label',pageId==='kb'?'知识来源':'记忆来源');q.type='search';q.placeholder='搜索文件名与正文';q.setAttribute('aria-label','搜索资料');q.value=saved.q||'';toolbar.append(source,q,searchButton);source.hidden=true;
  var groupsNav=el('nav',undefined,'library-groups'),overview=el('p','','library-overview'),chips=el('div',undefined,'library-chips'),layout=el('div',undefined,'library-layout'),side=el('aside',undefined,'library-side'),main=el('section',undefined,'library-document'),heading=el('h2','选择资料查看全文'),pathLine=el('p','','library-path'),docMeta=el('div',undefined,'library-doc-meta'),docScroll=el('div',undefined,'library-doc-scroll'),outlineWrap=el('aside',undefined,'library-outline'),outlineInner=el('div',undefined,'library-outline-inner'),actions=el('div',undefined,'library-actions'),back=el('button','资料列表','btn library-back'),edit=el('button','编辑','btn'),previewButton=el('button','预览','btn'),save=el('button','保存修改','btn primary'),discard=el('button','丢弃草稿','btn'),download=el('button','下载原文','btn'),version=el('button','修改记录','btn'),links=el('div',undefined,'library-links'),content=el('div',undefined,'library-content md-text'),input=el('textarea',undefined,'library-editor');input.setAttribute('aria-label','资料内容');input.spellcheck=false;var draftStatus=el('p','','library-draft-status'),exportDraft=el('button','下载草稿','btn');draftStatus.setAttribute('role','status');actions.append(exportDraft);actions.append(back,edit,previewButton,save,discard,download,version);outlineWrap.append(outlineInner);docScroll.append(content,outlineWrap);var searchPanel=el('div',undefined,'library-search-panel');searchPanel.hidden=true;searchPanel.setAttribute('role','listbox');main.append(heading,docMeta,pathLine,actions,draftStatus,links,docScroll,input);side.append(groupsNav);layout.append(side,main);root.append(toolbar,searchPanel,chips,overview,hint,feedback,layout);
  function parameters(doc){return '?source='+encodeURIComponent(doc.source)+'&path='+encodeURIComponent(doc.path);}
  function key(doc){return 'panel-library-document:'+doc.source+':'+doc.root_revision+':'+doc.path;}
  function viewState(){remember('panel-library-view:'+pageId,{source:source.value,q:q.value,path:state.doc?.path,doc_source:state.doc?.source,doc_new:state.doc?state.doc.exists===false:false});}
  function draft(){if(!state.doc)return;return {text:input.value,base:state.doc,revision:state.draftRevision,dirty:input.value!==state.doc.content};}
  function retain(doc,value){
   var storageKey=key(doc);drafts.write(storageKey,value).then(ok=>{
    if(state.doc===doc&&drafts.peek(storageKey)?.text===value?.text)draftStatus.textContent=state.remoteDraft?.text===value?.text?'草稿已同步':ok?'草稿已保存在此设备':'此设备暂时无法保存草稿，正在尝试同步；离开前请下载草稿。';
   });
  }
  function keep(){if(!state.doc||!state.editing)return;var doc=state.doc;retain(doc,draft());clearTimeout(state.timer);state.timer=setTimeout(()=>pushDraft(doc),400);controls();}
  function pushDraft(doc){
   const task=state.draftQueue.then(async()=>{
    var cachedDraft=drafts.peek(key(doc));if(!cachedDraft||!cachedDraft.dirty||state.unresolved)return;
    try{var result=await api('/draft'+parameters(doc),'PUT',{revision:cachedDraft.revision,text:cachedDraft.text,options:{base:cachedDraft.base}});
     cachedDraft.revision=result.draft.revision;var current=drafts.peek(key(doc));if(current){current.revision=result.draft.revision;retain(doc,current);}
     if(state.doc===doc){state.draftRevision=result.draft.revision;state.remoteDraft=result.draft;state.conflicts=result.draft.conflicts||[];if(current?.text===cachedDraft.text){drafts.ack(key(doc),cachedDraft.text);draftStatus.textContent='草稿已同步';}}
    }catch(error){if(state.doc===doc){if(error.data?.conflict){state.unresolved=true;feedback.replaceChildren(el('span','检测到其他设备的新草稿，本地修改已保留。'));var reopen=el('button','读取并合并草稿','btn');reopen.onclick=()=>open(doc.source,doc.path);feedback.append(reopen);controls();}else{draftStatus.textContent=error.message+(drafts.durable(key(doc))?'；草稿保留在此设备，联网后会重试。':'；草稿目前只在此页面，请下载草稿后再离开。');}}}
   });state.draftQueue=task.catch(()=>{});return task;
  }
  async function consumeDraft(doc,snapshot,conflicts){
   if(!snapshot)return {remaining:true};
   return api('/draft/consume'+parameters(doc),'POST',{root_revision:doc.root_revision,expected:snapshot,conflicts:conflicts||[]});
  }
  /* 搜索下拉面板：命中徽章 + 高亮片段（对齐墨档 searchPanel） */
  function markTerm(text,term,host){
    var lo=String(text).toLowerCase(),t=String(term).toLowerCase(),at=lo.indexOf(t);
    if(at<0){host.textContent=text;return;}
    host.append(document.createTextNode((at>0?'…':'')+String(text).slice(0,at)));
    host.append(el('mark',String(text).slice(at,at+term.length)));
    host.append(document.createTextNode(String(text).slice(at+term.length)+'…'));
  }
  function renderSearchPanel(){
    var term=q.value.trim();
    if(!term){searchPanel.hidden=true;searchPanel.replaceChildren();return;}
    searchPanel.replaceChildren();
    var head=el('div',undefined,'library-sp-head');
    head.append(el('span','「'+term+'」命中 '+state.rows.length+' 条'));
    var close=el('button','×','library-sp-close');close.setAttribute('aria-label','关闭搜索面板');
    close.onclick=function(){searchPanel.hidden=true;};
    head.append(close);searchPanel.append(head);
    if(!state.rows.length){
      searchPanel.append(el('div','没有命中。换个关键词，或清空搜索浏览左侧文件树。','library-sp-empty'));
      searchPanel.hidden=false;return;
    }
    state.rows.slice(0,24).forEach(function(item){
      var b=el('button',undefined,'library-sp-item');
      var top=el('div',undefined,'library-sp-top');
      top.append(el('span',String(item.title||'').replace(/\.md$/i,''),'library-sp-name'));
      var body=!!item.snippet;
      top.append(el('span',body?'内容命中':'文件名命中','library-sp-badge'+(body?' is-body':'')));
      top.append(el('span',item.path,'library-sp-path'));
      b.append(top);
      var snip=el('div',undefined,'library-sp-snip');
      if(body)markTerm(item.snippet,term,snip);
      else snip.textContent='文件名或路径匹配';
      b.append(snip);
      b.onclick=async function(){searchPanel.hidden=true;await open(item.source,item.path);};
      searchPanel.append(b);
    });
    searchPanel.hidden=false;
  }
  /* 一级分类 chips：按 path 首段聚合，点击筛选左侧树 */
  function renderChips(){
    chips.replaceChildren();
    if(pageId!=='kb'){chips.hidden=true;return;}
    var counts={},order=[];
    state.rows.forEach(function(item){
      var p=String(item.path||'').split('/');
      if(p.length<2)return;
      if(!counts[p[0]]){counts[p[0]]=0;order.push(p[0]);}
      counts[p[0]]+=1;
    });
    if(!order.length){chips.hidden=true;return;}
    chips.hidden=false;
    var all=el('button','全部 '+state.rows.length,'library-chip'+(state.folder?'':' on'));
    all.onclick=function(){state.folder='';renderChips();renderTree();};
    chips.append(all);
    order.sort(function(a,b){return counts[b]-counts[a];}).forEach(function(name){
      var on=state.folder===name;
      var b=el('button',undefined,'library-chip'+(on?' on':''));
      b.append(document.createTextNode(name+' '));
      b.append(el('span',String(counts[name]),'library-chip-n'));
      b.onclick=function(){keep();state.folder=on?'':name;renderChips();renderTree();};
      chips.append(b);
    });
  }
  function controls(){var doc=state.doc,busy=state.saving||state.loading;actions.hidden=!doc;input.hidden=!state.editing;content.hidden=state.editing;edit.hidden=!doc?.editable||state.editing||!!(doc&&input.value!==doc.content);save.hidden=!state.editing;discard.hidden=!state.editing;previewButton.hidden=!doc?.editable||(!state.editing&&input.value===doc.content);previewButton.textContent=state.editing?'预览':'继续编辑';save.disabled=busy||state.unresolved||!doc||input.value===doc.content;input.readOnly=busy;source.disabled=busy;create.disabled=busy;discard.disabled=busy;previewButton.disabled=busy;edit.disabled=busy;back.disabled=busy;groupsNav.inert=busy;version.disabled=busy||!state.history.length;download.disabled=!doc?.exists;exportDraft.hidden=!doc||input.value===doc.content;}
  /* 文档信息条：路径 / 分类 / 体积 / 行数 / 更新时间（对齐墨档 doc-head） */
  function docCategory(doc){if(!doc||!doc.path)return '';var parts=String(doc.path).split('/');return parts.length>1?parts[0]:'';}
  function fmtTime(v){if(!v)return '';var t=typeof v==='number'?(v<1e12?v*1000:v):Date.parse(v);if(!t||isNaN(t))return String(v);var d=new Date(t),p=n=>String(n).padStart(2,'0');return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes());}
  function renderDocMeta(){
    docMeta.replaceChildren();
    if(!state.doc){docMeta.hidden=true;return;}
    var cat=docCategory(state.doc),lines=String(input.value||'').split('\n').length;
    docMeta.hidden=false;
    if(cat){var b=el('span',cat,'library-meta-badge');docMeta.append(b);}
    docMeta.append(el('span',Math.max(1,Math.ceil((state.doc.bytes||0)/1024))+' KB','library-meta-dim'));
    docMeta.append(el('span',lines+' 行','library-meta-dim'));
    var t=fmtTime(state.doc.mtime);if(t)docMeta.append(el('span','更新 '+t,'library-meta-dim'));
  }
  /* 右侧目录大纲：h1~h4 加锚点，h2/h3 进目录（对齐墨档 outline） */
  var _outlineSlug=0;
  function buildOutline(){
    outlineInner.replaceChildren();
    var heads=[...content.querySelectorAll('h1,h2,h3,h4')];
    if(heads.length<2){outlineWrap.hidden=true;return;}
    outlineWrap.hidden=false;
    var title=el('div','本页目录','library-outline-title');outlineInner.append(title);
    var shown=0;
    heads.forEach(function(h){
      var lv=+h.tagName.slice(1);
      if(!h.id){_outlineSlug+=1;h.id='lh-'+_outlineSlug;}
      if(lv<2)return;
      var a=el('a',(h.textContent||'').trim(),'library-outline-link'+(lv>=3?' lv3':''));
      a.href='#'+h.id;
      a.onclick=function(ev){ev.preventDefault();h.scrollIntoView({behavior:'smooth',block:'start'});};
      outlineInner.append(a);shown++;
    });
    if(!shown)outlineWrap.hidden=true;
  }
  function render(){markActive();if(!state.doc){heading.textContent='选择资料查看全文';pathLine.textContent='';renderDocMeta();outlineWrap.hidden=true;content.textContent='搜索文件名或正文，选择一条资料。';controls();return;}heading.textContent=String(state.doc.title||'').replace(/\.md$/i,'');pathLine.textContent=state.doc.path;renderDocMeta();if(!state.editing){if(input.value.length>100000){content.textContent=input.value;content.style.whiteSpace='pre-wrap';outlineWrap.hidden=true;}else{content.style.whiteSpace='';content.innerHTML=renderMarkdown(input.value||'');buildOutline();}}else{outlineWrap.hidden=true;}renderLinks();controls();}
  async function renderLinks(){links.replaceChildren();if(state.doc?.source!=='knowledge')return;var doc=state.doc,targets=[...new Set([...input.value.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)].map(m=>m[1].trim()))].slice(0,30);if(!targets.length)return;links.append(el('small','文档链接'));targets.forEach(target=>{var b=el('button',target,'btn');b.onclick=async()=>{try{var data=await api('?source=knowledge&q='+encodeURIComponent(target.replace(/\.md$/i,''))),matches=data.items.filter(i=>i.path===target||i.path===target+'.md'||i.title===target||i.title===target+'.md');if(matches.length===1){await open('knowledge',matches[0].path);return;}if(!matches.length){feedback.textContent='没有找到链接资料：'+target;return;}var d=el('dialog',undefined,'navigation-dialog'),opener=document.activeElement;trackDialog(d,opener);d.setAttribute('aria-label','选择链接资料');d.append(el('h2','同名资料'));matches.forEach(item=>{var button=el('button',item.path);button.onclick=()=>{d.close();open('knowledge',item.path);};d.append(button);});var close=el('button','关闭');close.onclick=()=>d.close();d.append(close);document.body.append(d);d.showModal();}catch(error){feedback.textContent=error.message;}};links.append(b);});}
  function badgeText(v){return v==='full'?'每轮注入':v==='index'?'只注入索引':'不注入';}
 function renderOverview(){
  if(pageId==='kb'){overview.textContent='知识库不进上下文：这里是资料柜，需要时由助手主动检索阅读。';return;}
  var full=state.sources.filter(function(s){return s.injected==='full';});
  var total=full.reduce(function(a,s){return a+(s.volume||0);},0);
  overview.textContent='每轮自动带上 '+full.length+' 份 · '+(total/1024).toFixed(1)+' KB · 改完在新会话生效';
 }
 // 三档：助手是什么 / 知识库知道什么 / 足迹做过什么
var GROUP_ORDER=[['assistant','提示词'],['material','知识库'],['records','留痕录 · 只读']];
 var openState=cached('panel-library-open:'+pageId,null)||{};
 function rememberOpen(){remember('panel-library-open:'+pageId,openState);}
 function docKey(source,path){return source+'::'+path;}
 function markActive(){
  var wanted=state.doc?docKey(state.doc.source,state.doc.path):'';
  Array.prototype.forEach.call(groupsNav.querySelectorAll('.library-file'),function(b){
   var on=b.getAttribute('data-k')===wanted;b.classList.toggle('active',on);b.setAttribute('aria-current',on?'true':'false');
  });
 }
 function treeFile(item,depth,host){
  var b=el('button',undefined,'library-file');
  b.type='button';b.title=item.path;b.setAttribute('data-k',docKey(item.source,item.path));
  b.style.setProperty('--folder-depth',String(Math.min(depth,6)));
  b.append(el('span',item.title,'library-file-name'));
  b.append(el('span',item.bytes?Math.max(1,Math.round(item.bytes/1024))+' KB':'—','library-file-size'));
  b.onclick=function(){open(item.source,item.path,item.missing);};
  host.append(b);
 }
 function buildTree(items){
  var root={name:'',path:'',children:{},files:[]};
  items.forEach(function(item){
   var parts=String(item.path).split('/').filter(Boolean),cursor=root,acc=[];
   parts.slice(0,-1).forEach(function(part){acc.push(part);var k=acc.join('/');if(!cursor.children[k])cursor.children[k]={name:part,path:k,children:{},files:[]};cursor=cursor.children[k];});
   cursor.files.push(item);
  });
  return root;
 }
 function drawFolders(node,depth,host,forceOpen){
  Object.keys(node.children).sort(function(a,b){return a.localeCompare(b,'zh');}).forEach(function(k){
   var child=node.children[k],open=forceOpen||openState[child.path]!==false;
   var wrap=el('div',undefined,'library-tree-node'),row=el('div',undefined,'library-folder-row');
   var caret=el('button',open?'▾':'▸','library-tree-caret');
   caret.type='button';caret.setAttribute('aria-expanded',String(!!open));caret.setAttribute('aria-label',(open?'收起 ':'展开 ')+child.name);
   var toggle=function(){openState[child.path]=!open;rememberOpen();renderTree();};
   caret.onclick=toggle;
   var name=el('button',child.name,'library-folder');
   name.type='button';name.title=child.path;name.style.setProperty('--folder-depth',String(Math.min(depth,6)));
   name.onclick=toggle;
   row.append(caret,name);wrap.append(row);
   if(open){
    drawFolders(child,depth+1,wrap,forceOpen);
    child.files.slice().sort(function(x,y){return (y.mtime||0)-(x.mtime||0);}).forEach(function(item){treeFile(item,depth+1,wrap);});
   }
   host.append(wrap);
  });
  if(depth===0)node.files.slice().sort(function(x,y){return (y.mtime||0)-(x.mtime||0);}).forEach(function(item){treeFile(item,0,host);});
 }
 function renderTree(){
  groupsNav.replaceChildren();
  var searching=!!q.value.trim();
  if(pageId==='kb'){
   var treeRows=state.folder?state.rows.filter(function(item){return String(item.path||'').indexOf(state.folder+'/')===0;}):state.rows;
   if(!treeRows.length){groupsNav.append(el('p',searching?'没有匹配笔记，换个关键词试试。':(state.folder?'这个分类下还没有笔记。':'这个知识库还没有笔记。'),'page-subtitle'));return;}
   drawFolders(buildTree(treeRows),0,groupsNav,searching);
   return;
  }
  var kbCount=state.rows.filter(function(i){return i.source==='knowledge';}).length;
  GROUP_ORDER.forEach(function(pair){
   var items=state.sources.filter(function(s){return s.group===pair[0]&&s.id!=='knowledge';});
   var linked=pair[0]==='material';
   if(!items.length&&!linked)return;
   groupsNav.append(el('p',pair[1],'library-group-title'));
   if(linked){
    var known=el('button',undefined,'library-source is-link'),kh=el('span',undefined,'library-source-head');
    kh.append(el('strong','知识库'),el('span',badgeText('none'),'library-badge is-none'));
    known.type='button';known.append(kh,el('small',kbCount?kbCount+' 篇笔记 · 点开进知识库页':'点开进知识库页'));
    known.onclick=function(){switchPage('kb');};
    groupsNav.append(known);
   }
   items.forEach(function(s){
    var rows=state.rows.filter(function(item){return item.source===s.id;});
    var button=el('button',undefined,'library-source'),head=el('span',undefined,'library-source-head');
    head.append(el('strong',s.name),el('span',badgeText(s.injected),'library-badge is-'+(s.injected||'none')));
    button.type='button';button.append(head);
    var meta=[];if(s.volume)meta.push(Math.round(s.volume/1024)+' KB');if(s.editable===false)meta.push('只读');if(rows.length>1)meta.push(rows.length+' 个文件');
    button.append(el('small',meta.join(' · ')));
    if(rows.length===1&&rows[0].path.indexOf('/')<0){button.onclick=function(){open(s.id,rows[0].path,rows[0].missing);};}
    else{button.onclick=function(){openState['src:'+s.id]=openState['src:'+s.id]===false;rememberOpen();renderTree();};}
    groupsNav.append(button);
    if(rows.length>1&&(searching||openState['src:'+s.id]!==false))drawFolders(buildTree(rows),1,groupsNav,searching);
   });
   // 技能归「提示词」大类（2026-11-13 三分法：提示词=它怎么被指挥，含人格/记忆/指令/能力）
   if(pair[0]==='assistant'){
    var skills=el('button',undefined,'library-source is-link'),sh=el('span',undefined,'library-source-head');
    sh.append(el('strong','技能库'),el('span','只注入索引','library-badge is-index'));
    skills.type='button';skills.append(sh,el('small','索引进上下文，正文按需读取'));
    skills.onclick=function(){switchPage('skills');};
    groupsNav.append(skills);
   }
  });
 }
 async function load(append,quiet){
  var n=++state.seq;if(!quiet)feedback.textContent='正在读取资料…';viewState();
  try{
   var sourceId=pageId==='kb'?'knowledge':(source.value||saved.source||'');
   var data=await api('?source='+encodeURIComponent(sourceId)+'&q='+encodeURIComponent(q.value)+'&limit=5000');
   if(n!==state.seq)return;
   state.sources=data.sources;state.folders=data.folders||[];state.rows=data.items||[];
   source.replaceChildren();
   state.sources.forEach(function(item){var o=el('option',item.name);o.value=item.id;source.append(o);});
   if(pageId==='kb')source.value='knowledge';
   else if(!source.value)source.value=(state.sources.find(function(item){return item.group==='assistant';})||{}).id||'';
   hint.textContent=(state.sources.find(function(item){return item.id===source.value;})||{}).description||'';
   renderOverview();renderTree();renderChips();renderSearchPanel();
if(!quiet)feedback.textContent='共 '+data.total+' 份资料'+(q.value?' · 关键词「'+q.value+'」':'')+(data.partial?' · 部分文件未完成检索，请缩小范围':'');
  }catch(error){if(!quiet)feedback.textContent=error.message;return error.message;}
 }
  async function open(sourceId,path,newFile){
   if(state.saving)return false;
   keep();clearTimeout(state.timer);var n=++state.docSeq;state.loading=true;controls();
   feedback.textContent='正在读取 '+path+'…';
   try{
    await state.draftQueue;if(n!==state.docSeq)return false;
    var data=await api('/document?source='+encodeURIComponent(sourceId)+'&path='+encodeURIComponent(path)+(newFile?'&new=1':''));
    if(n!==state.docSeq)return false;
    var remote=await api('/draft'+parameters(data.document));if(n!==state.docSeq)return false;
    var local=await drafts.read(key(data.document));if(n!==state.docSeq)return false;
    // Commit the document and its draft together; a failed read leaves the old editor intact.
    state.doc=data.document;state.history=data.history;state.editing=!!newFile;state.pending=null;state.unresolved=false;state.acceptedConflicts=[];
    state.remoteDraft=remote.draft;state.draftRevision=remote.draft.revision;state.conflicts=remote.draft.conflicts||[];
    input.value=state.doc.content;draftStatus.textContent='';
    if(local?.dirty){state.doc=local.base;input.value=local.text;state.editing=true;}
    var choices=[...state.conflicts];
    if(remote.draft.options?.base&&remote.draft.text!==data.document.content)choices.unshift(remote.draft);
    if(!local?.dirty&&choices.length){var d=choices.shift();state.doc=d.options.base||data.document;input.value=d.text;state.editing=true;retain(state.doc,{text:d.text,base:state.doc,revision:remote.draft.revision,dirty:true});}
    if(choices.some(d=>d.text!==input.value)){
     state.unresolved=true;feedback.replaceChildren(el('span','检测到不同设备的草稿。'));var merge=el('button','合并草稿','btn');
     merge.onclick=()=>{state.unresolved=false;state.acceptedConflicts=state.conflicts.slice();input.value=[...new Set([input.value,...choices.map(d=>d.text)])].join('\n\n');state.editing=true;keep();render();feedback.textContent='不同草稿已保留在编辑区，请核对后保存。';};feedback.append(merge);
    }else{state.acceptedConflicts=state.conflicts.filter(d=>d.text===input.value);feedback.textContent=state.editing?'已恢复未保存草稿':'已读取完整内容';}
    if(source.value!==sourceId){saved.source=sourceId;source.value=sourceId;q.value='';load(false,true);}
    root.classList.add('reading');viewState();render();
    if(local?.dirty){var latestLocal=drafts.peek(key(state.doc));if(latestLocal){latestLocal.revision=state.draftRevision;retain(state.doc,latestLocal);}if(!state.unresolved)pushDraft(state.doc);}
    return true;
   }catch(error){if(n===state.docSeq){feedback.replaceChildren(el('span','未能打开 '+path+'：'+error.message+(state.doc?'；当前资料与草稿保持不变。':'')));var retry=el('button','重试打开资料','btn');retry.onclick=()=>open(sourceId,path,newFile);feedback.append(retry);}return false;
   }finally{if(n===state.docSeq){state.loading=false;controls();}}
  }
  edit.onclick=()=>{state.editing=true;render();input.focus();};previewButton.onclick=()=>{keep();state.editing=!state.editing;render();};input.oninput=keep;
  save.onclick=async()=>{if(!state.doc||state.saving||state.loading||state.unresolved)return;keep();clearTimeout(state.timer);state.saving=true;controls();var doc=state.doc,text=input.value,signature=JSON.stringify([doc.revision,text]);if(state.pending?.signature!==signature)state.pending={id:'document-'+uuid(),signature};feedback.textContent='正在备份并保存…';try{
    await pushDraft(doc);if(state.unresolved)return;
    var snapshot=state.remoteDraft?.text===text?state.remoteDraft:null,consumed=state.acceptedConflicts.slice();
    var result=await api('/document','PUT',{...doc,content:text,request_id:state.pending.id});
    await drafts.write(key(doc),null);state.doc=result.document;input.value=result.document.content;state.editing=false;state.pending=null;state.history=[];viewState();render();
    var warnings=[];
    try{var cleanup=await consumeDraft(doc,snapshot,consumed);state.remoteDraft=cleanup.draft||null;state.draftRevision=cleanup.draft?.revision||0;state.conflicts=cleanup.draft?.conflicts||[];state.acceptedConflicts=[];if(cleanup.remaining)warnings.push('其他草稿仍保留，重新打开资料可查看');}catch(error){warnings.push('草稿清理未完成：'+error.message);}
    try{state.history=(await api('/document'+parameters(state.doc))).history;}catch(error){warnings.push('修改记录暂时无法读取：'+error.message);}
    var listError=await load(false,true);if(listError)warnings.push('资料列表暂时无法刷新：'+listError);
    feedback.replaceChildren(el('span','文件已保存'+(warnings.length?'；'+warnings.join('；'):'，原文备份可在修改记录中撤销')));
    if(warnings.length){var retry=el('button','重新读取资料','btn');retry.onclick=()=>open(result.document.source,result.document.path);feedback.append(retry);}render();
   }catch(error){feedback.replaceChildren(el('span',error.message+'；编辑内容已保留。'));if(error.status===409){var compare=el('button','查看最新原文并合并','btn');compare.onclick=async()=>{try{var latest=(await api('/document'+parameters(doc))).document,d=el('dialog',undefined,'navigation-dialog'),opener=document.activeElement;trackDialog(d,opener);d.setAttribute('aria-label','合并资料修改');d.append(el('h2','最新原文'),el('pre',latest.content));var merged=el('textarea');merged.rows=10;merged.value=input.value;merged.setAttribute('aria-label','合并后的资料');var adopt=el('button','采用合并稿'),close=el('button','关闭');adopt.onclick=()=>{state.doc=latest;input.value=merged.value;state.pending=null;keep();render();d.close();feedback.textContent='已采用最新版本作为基线，请核对后保存';};close.onclick=()=>d.close();d.append(el('h3','保留的草稿'),merged,adopt,close);document.body.append(d);d.showModal();}catch(error){feedback.textContent=error.message;}};feedback.append(compare);}}finally{state.saving=false;controls();}};
  discard.onclick=async()=>{if(state.saving||!(await ui.confirm('丢弃此设备未保存的修改并读取最新原文？其他设备的草稿会保留。')))return;clearTimeout(state.timer);await state.draftQueue;var doc=state.doc,snapshot=state.remoteDraft;try{
   if(snapshot?.text===input.value)await consumeDraft(doc,snapshot,[]);
   state.editing=false;await drafts.write(key(doc),null);await open(doc.source,doc.path);
  }catch(error){feedback.textContent=error.message+'；草稿仍保留。';}};
  version.onclick=()=>{var d=el('dialog',undefined,'navigation-dialog'),opener=document.activeElement;trackDialog(d,opener);d.setAttribute('aria-label','资料修改记录');d.append(el('h2','修改记录'));state.history.forEach(change=>{var row=el('div',undefined,'library-version');row.append(el('p',new Date(change.created_at).toLocaleString('zh-CN')+' · '+change.reason+' · '+(change.status==='committed'?'已保存':'保存中断，请核对原文')));if(change.can_undo&&change.after_hash===state.doc.revision){var undo=el('button','撤销这次修改');undo.onclick=async()=>{undo.disabled=true;try{await api('/undo','POST',{change_id:change.id,revision:state.doc.revision,request_id:'undo-'+uuid()});d.close();await drafts.write(key(state.doc),null);state.editing=false;await open(state.doc.source,state.doc.path);}catch(error){row.append(el('p',error.message));undo.disabled=false;}};row.append(undo);}d.append(row);});var close=el('button','关闭');close.onclick=()=>d.close();d.append(close);document.body.append(d);d.showModal();};
  exportDraft.onclick=()=>{var url=URL.createObjectURL(new Blob([input.value],{type:'text/plain;charset=utf-8'})),a=el('a');a.href=url;a.download=(state.doc?.title||'资料')+'.draft.md';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  download.onclick=async()=>{try{var r=await fetch(apiUrl('/api/panel-library/download'+parameters(state.doc)),{headers:{'X-Monitor-Token':monitorToken||''}});if(!r.ok)throw Error('原文下载失败');var url=URL.createObjectURL(await r.blob()),a=el('a');a.href=url;a.download=state.doc.title;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(error){feedback.textContent=error.message;}};
  create.onclick=()=>{
    var d=el('dialog',undefined,'navigation-dialog'),opener=document.activeElement;trackDialog(d,opener);d.setAttribute('aria-label','新建知识笔记');
    var title=el('input'),catSel=el('select'),sub=el('input'),body=el('textarea'),status=el('p','','library-create-status'),preview=el('p','','library-create-path');
    var button=el('button','创建并编辑','btn primary'),close=el('button','关闭','btn');
    title.placeholder='笔记标题';title.setAttribute('aria-label','笔记标题');
    sub.placeholder='子目录，可留空';sub.setAttribute('aria-label','子目录');
    body.placeholder='Markdown 正文，留空则自动写入一级标题';body.setAttribute('aria-label','笔记正文');body.rows=8;
    catSel.setAttribute('aria-label','一级分类');
    var cats={};state.rows.forEach(function(item){var p=String(item.path||'').split('/');if(p.length>1)cats[p[0]]=(cats[p[0]]||0)+1;});
    var catKeys=Object.keys(cats).sort(function(a,b){return cats[b]-cats[a];});
    if(!catKeys.length)catKeys=['项目'];
    catKeys.forEach(function(c){var o=el('option',cats[c]?c+' · '+cats[c]:c);o.value=c;catSel.append(o);});
    function rebuild(){
      var t=(title.value||'').trim().replace(/\.md$/i,''),c=catSel.value,s=(sub.value||'').trim().replace(/^\/+|\/+$/g,'');
      var path=[c,s,t?t+'.md':''].filter(Boolean).join('/');
      preview.textContent=path?'路径：knowledge/'+path:'路径：填好标题后自动生成';
      return path;
    }
    [title,sub].forEach(function(node){node.oninput=rebuild;});
    catSel.onchange=rebuild;
    button.onclick=async()=>{
      var path=rebuild();
      if(!(title.value||'').trim()){status.textContent='请先填写标题';title.focus();return;}
      if(!path){status.textContent='请选择一级分类';return;}
      try{
        var doc=(await api('/document?source=knowledge&new=1&path='+encodeURIComponent(path))).document;
        if(doc.exists)throw Error('同名资料已经存在：'+path);
        trackDialog(d,opener,false);d.close();
        if(!await open('knowledge',path,true))return;
        input.value=body.value.trim()||('# '+(title.value||'').trim().replace(/\.md$/i,'')+'\n\n');
        keep();render();input.focus();
      }catch(error){status.textContent=error.message;}
    };
    close.onclick=()=>d.close();
    d.append(el('h2','新建知识笔记'),el('label','标题'),title,el('label','分类'),catSel,el('label','子目录'),sub,el('label','正文'),body,preview,status,button,close);
    rebuild();document.body.append(d);d.showModal();title.focus();
  };
  back.onclick=()=>{keep();root.classList.remove('reading');};source.onchange=()=>{keep();saved={};state.docSeq++;state.doc=null;state.history=[];state.editing=false;state.pending=null;state.conflicts=[];root.classList.remove('reading');links.replaceChildren();render();viewState();load(false);};q.oninput=()=>{clearTimeout(timer);timer=setTimeout(()=>load(false),350);};var timer;searchButton.onclick=refresh.onclick=()=>load(false);
  window.addEventListener('pagehide',keep);window.addEventListener('online',()=>{if(state.doc&&drafts.peek(key(state.doc))?.dirty)pushDraft(state.doc);});render();return {load:async()=>{await load(false);if(!state.doc&&saved.path&&saved.doc_source)await open(saved.doc_source,saved.path,saved.doc_new);},open,root};
 }
 views.kb=mount('kb');views.memory=mount('memory');
 var kbPage=document.getElementById('page-kb'),kbHeader=kbPage.querySelector('.page-header'),kbBody=views.kb.root,learning=document.querySelector('#page-learning .page-body'),trajectory=el('section',undefined,'library-trajectory-view');
 trajectory.hidden=true;
 if(learning){Array.from(learning.children).forEach(function(child){trajectory.append(child);});kbPage.append(trajectory);}
 var viewButtons=el('div',undefined,'library-view-switch'),filesButton=el('button','全部资料','btn'),trajectoryButton=el('button','技能轨迹','btn');
 var graphButton=el('button','笔记关系','btn');
 viewButtons.setAttribute('role','group');viewButtons.setAttribute('aria-label','知识库视图');filesButton.type=trajectoryButton.type=graphButton.type='button';graphButton.setAttribute('aria-expanded','false');
 var graphView=el('section',undefined,'library-graph-panel'),graphHead=el('div',undefined,'library-graph-head'),graphTitle=el('h2','笔记关系'),graphClose=el('button','关闭','btn'),graphStatus=el('p','笔记关系来自正文中的 [[笔记名]] 链接。','library-graph-status'),graphCanvas=el('div',undefined,'library-graph-canvas'),graphRefresh=el('button','刷新关系','btn'),graphTools=el('div',undefined,'library-graph-tools'),graphChips=el('div',undefined,'library-chips library-graph-chips');graphView.hidden=true;graphRefresh.onclick=()=>renderNoteGraph(true);graphClose.onclick=function(){graphView.hidden=true;graphButton.setAttribute('aria-expanded','false');};graphTools.append(graphRefresh,graphClose);graphHead.append(graphTitle,graphTools);graphView.append(graphHead,el('p','正文里写了 [[笔记名]] 就有一条线；点节点直接打开那篇笔记。','pw-hint'),graphChips,graphStatus,graphCanvas);kbPage.append(graphView);
  var _graphSim=null;
  async function renderNoteGraph(refresh){
    graphStatus.textContent='正在读取笔记关系…';graphCanvas.replaceChildren();
    try{
      var result=await api('/graph?source=knowledge');
      if(!result.nodes.length){graphStatus.textContent='知识库中还没有 Markdown 笔记。';return;}
      buildForceGraph(result);
    }catch(error){graphStatus.textContent='笔记关系读取失败：'+error.message;}
  }
  /* 力导向笔记关系图：斥力+弹簧+向心，支持拖拽/滚轮缩放/空白平移/悬停高亮/分类筛选 */
  function buildForceGraph(result){
    var W=1000,H=680,SVGNS='http://www.w3.org/2000/svg';
    if(_graphSim&&_graphSim.stop)_graphSim.stop();
    var palette=['#5b8def','#e5734a','#3fb98a','#b56fd6','#e0a03c','#4aa8c8','#d6607f','#7a8c3f','#8a7fd6','#4fbfb0','#c86a9a'];
    function catOf(path){var parts=String(path||'').split('/');return parts.length>1?parts[0]:'未分类';}
    var counts={},order=[];
    result.nodes.forEach(function(n){var c=catOf(n.path);if(!(c in counts)){counts[c]=0;order.push(c);}counts[c]+=1;});
    order.sort(function(a,b){return counts[b]-counts[a];});
    var colorOf={};order.forEach(function(c,i){colorOf[c]=palette[i%palette.length];});

    var GOLDEN=2.399963229728653;
    var nodes=result.nodes.map(function(n,i){
      var ang=i*GOLDEN,rad=46+Math.sqrt(i)*34;
      return {id:n.path,label:String(n.title||n.path).replace(/\.md$/i,''),cat:catOf(n.path),
        x:W/2+Math.cos(ang)*rad,y:H/2+Math.sin(ang)*rad*0.66,vx:0,vy:0,deg:0,adj:{}};
    });
    var byId={};nodes.forEach(function(n){byId[n.id]=n;});
    var edges=result.edges.map(function(e){return {a:byId[e.from],b:byId[e.to]};}).filter(function(e){return e.a&&e.b;});
    edges.forEach(function(e){if(e.a===e.b)return;e.a.deg+=1;e.b.deg+=1;e.a.adj[e.b.id]=1;e.b.adj[e.a.id]=1;});

    var svg=document.createElementNS(SVGNS,'svg');
    svg.setAttribute('viewBox','0 0 '+W+' '+H);
    svg.setAttribute('role','img');svg.setAttribute('aria-label','知识笔记关系图');
    var world=document.createElementNS(SVGNS,'g');svg.append(world);
    var edgeEls=edges.map(function(){
      var l=document.createElementNS(SVGNS,'line');l.setAttribute('class','library-graph-edge');world.append(l);return l;
    });
    nodes.forEach(function(n){
      var r=7+Math.min(15,Math.sqrt(n.deg)*3.4);
      var g=document.createElementNS(SVGNS,'g');
      g.setAttribute('class','library-graph-node');g.setAttribute('tabindex','0');g.setAttribute('role','button');
      g.setAttribute('aria-label','打开笔记：'+n.path);
      var c=document.createElementNS(SVGNS,'circle');
      c.setAttribute('r',String(r));c.setAttribute('fill',colorOf[n.cat]);
      var t=document.createElementNS(SVGNS,'text');
      var label=n.label.length>20?n.label.slice(0,19)+'…':n.label;
      t.textContent=label;t.setAttribute('y',String(r+12));t.setAttribute('text-anchor','middle');
      g.append(c,t);world.append(g);n.el=g;n.circle=c;
    });

    /* 视图变换 */
    var k=1,tx=0,ty=0;
    function applyView(){world.setAttribute('transform','translate('+tx.toFixed(2)+' '+ty.toFixed(2)+') scale('+k.toFixed(3)+')');}
    function svgPoint(ev){
      var pt=svg.createSVGPoint();pt.x=ev.clientX;pt.y=ev.clientY;
      var m=svg.getScreenCTM();if(!m)return {x:0,y:0};
      return pt.matrixTransform(m.inverse());
    }
    function worldPoint(ev){var u=svgPoint(ev);return {x:(u.x-tx)/k,y:(u.y-ty)/k};}

    /* 物理 */
    var alpha=1,raf=0,dragNode=null,panning=null;
    function physics(){
      var i,j,n,m,dx,dy,d2,d,f,ux,uy;
      for(i=0;i<nodes.length;i+=1){
        n=nodes[i];
        for(j=i+1;j<nodes.length;j+=1){
          m=nodes[j];dx=m.x-n.x;dy=m.y-n.y;d2=dx*dx+dy*dy;
          if(d2>200000)continue;
          if(d2<1)d2=1;
          d=Math.sqrt(d2);f=2600/d2;ux=dx/d;uy=dy/d;
          n.vx-=ux*f;n.vy-=uy*f;m.vx+=ux*f;m.vy+=uy*f;
        }
      }
      edges.forEach(function(e){
        var ex=e.b.x-e.a.x,ey=e.b.y-e.a.y,ed=Math.sqrt(ex*ex+ey*ey)||1,ef=(ed-120)*0.012,exu=ex/ed,eyu=ey/ed;
        e.a.vx+=exu*ef;e.a.vy+=eyu*ef;e.b.vx-=exu*ef;e.b.vy-=eyu*ef;
      });
      nodes.forEach(function(p){
        p.vx+=(W/2-p.x)*0.0016;p.vy+=(H/2-p.y)*0.0016;
        if(p===dragNode){p.vx=0;p.vy=0;return;}
        var sp=Math.sqrt(p.vx*p.vx+p.vy*p.vy);
        if(sp>9){var sc=9/sp;p.vx*=sc;p.vy*=sc;}
        p.x+=p.vx;p.y+=p.vy;p.vx*=0.85;p.vy*=0.85;
        if(p.x<44){p.x=44;p.vx=Math.abs(p.vx)*0.4;}
        if(p.x>W-44){p.x=W-44;p.vx=-Math.abs(p.vx)*0.4;}
        if(p.y<44){p.y=44;p.vy=Math.abs(p.vy)*0.4;}
        if(p.y>H-44){p.y=H-44;p.vy=-Math.abs(p.vy)*0.4;}
      });
    }
    function paint(){
      edgeEls.forEach(function(el,i){
        var e=edges[i];if(!e)return;
        el.setAttribute('x1',e.a.x.toFixed(1));el.setAttribute('y1',e.a.y.toFixed(1));
        el.setAttribute('x2',e.b.x.toFixed(1));el.setAttribute('y2',e.b.y.toFixed(1));
      });
      nodes.forEach(function(n){n.el.setAttribute('transform','translate('+n.x.toFixed(1)+' '+n.y.toFixed(1)+')');});
    }
    function loop(){
      raf=0;
      if(alpha>0.004){physics();alpha*=0.972;paint();raf=requestAnimationFrame(loop);}
      else paint();
    }
    function kick(v){alpha=Math.max(alpha,v||0.35);if(!raf)raf=requestAnimationFrame(loop);}

    /* 节点拖拽 + 点击 */
    nodes.forEach(function(n){
      n.el.addEventListener('pointerdown',function(ev){
        ev.stopPropagation();ev.preventDefault();
        dragNode=n;n.el.setPointerCapture(ev.pointerId);
        n.el.classList.add('dragging');kick(0.5);
        var move=function(e2){
          var w=worldPoint(e2);
          n.x=Math.max(16,Math.min(W-16,w.x));n.y=Math.max(16,Math.min(H-16,w.y));
          paint();
        };
        var up=function(e2){
          n.el.releasePointerCapture&&n.el.releasePointerCapture(e2.pointerId);
          n.el.removeEventListener('pointermove',move);n.el.removeEventListener('pointerup',up);
          n.el.removeEventListener('pointercancel',up);
          n.el.classList.remove('dragging');dragNode=null;kick(0.4);
        };
        n.el.addEventListener('pointermove',move);n.el.addEventListener('pointerup',up);n.el.addEventListener('pointercancel',up);
      });
      var activate=function(){if(window.kbOpenNote)window.kbOpenNote(n.path);};
      n.el.addEventListener('click',function(ev){if(ev.detail===0)activate();});
      n.el.addEventListener('dblclick',activate);
      n.el.addEventListener('keydown',function(ev){if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();activate();}});
      n.el.addEventListener('pointerenter',function(){hover(n);});
      n.el.addEventListener('pointerleave',function(){hover(null);});
    });

    /* 悬停高亮邻居 */
    function hover(n){
      if(!n){svg.classList.remove('has-hover');
        nodes.forEach(function(p){p.el.classList.remove('is-near','is-dim');p.el.classList.remove('is-hub');});
        edgeEls.forEach(function(el){el.classList.remove('is-near');});return;}
      svg.classList.add('has-hover');
      nodes.forEach(function(p){
        var near=p===n||n.adj[p.id];
        p.el.classList.toggle('is-near',!!near);p.el.classList.toggle('is-dim',!near);
      });
      edgeEls.forEach(function(el,i){
        var e=edges[i];el.classList.toggle('is-near',!!(e&&(e.a===n||e.b===n)));
      });
    }

    /* 空白拖拽平移 */
    svg.addEventListener('pointerdown',function(ev){
      if(ev.target.closest('.library-graph-node'))return;
      panning={x:ev.clientX,y:ev.clientY,tx:tx,ty:ty};
      svg.setPointerCapture(ev.pointerId);svg.classList.add('panning');
    });
    svg.addEventListener('pointermove',function(ev){
      if(!panning)return;
      var rect=svg.getBoundingClientRect(),sx=W/(rect.width||W);
      tx=panning.tx+(ev.clientX-panning.x)*sx;ty=panning.ty+(ev.clientY-panning.y)*sx;
      applyView();
    });
    function endPan(ev){if(!panning)return;panning=null;svg.classList.remove('panning');try{svg.releasePointerCapture(ev.pointerId);}catch(e){}}
    svg.addEventListener('pointerup',endPan);svg.addEventListener('pointercancel',endPan);

    /* 滚轮以指针为锚缩放 */
    svg.addEventListener('wheel',function(ev){
      ev.preventDefault();
      var u=svgPoint(ev),k2=Math.max(0.3,Math.min(3.5,k*Math.exp(-ev.deltaY*0.0012)));
      var wx=(u.x-tx)/k,wy=(u.y-ty)/k;
      tx=u.x-wx*k2;ty=u.y-wy*k2;k=k2;applyView();
    },{passive:false});

    /* 分类筛选 chips */
    graphChips.replaceChildren();
    var activeCat='';
    var allChip=el('button','全部 '+nodes.length,'library-chip on');
    allChip.onclick=function(){activeCat='';paintChips();applyFilter();};
    graphChips.append(allChip);
    order.forEach(function(c){
      var b=el('button',undefined,'library-chip');
      b.append(document.createTextNode(c+' '));
      b.append(el('span',String(counts[c]),'library-chip-n'));
      b.style.setProperty('--chip-color',colorOf[c]);
      b.onclick=function(){activeCat=(activeCat===c?'':c);paintChips();applyFilter();};
      graphChips.append(b);
    });
    function paintChips(){
      [...graphChips.children].forEach(function(node){node.classList.remove('on');});
      if(!activeCat){allChip.classList.add('on');return;}
      [...graphChips.children].forEach(function(node){if(node.textContent.indexOf(activeCat)===0)node.classList.add('on');});
    }
    function applyFilter(){
      nodes.forEach(function(n){
        var hide=!!activeCat&&n.cat!==activeCat;
        n.el.style.display=hide?'none':'';
      });
      edges.forEach(function(e,i){
        var el=edgeEls[i];if(!el)return;
        el.style.display=(!!activeCat&&(e.a.cat!==activeCat||e.b.cat!==activeCat))?'none':'';
      });
    }

    applyView();paint();graphCanvas.append(svg);kick(1);
    var isolated=nodes.filter(function(n){return !n.deg;}).length;
    graphStatus.textContent=nodes.length+' 篇笔记 · '+edges.length+' 条链接'+(isolated?' · '+isolated+' 篇孤立':'')+' · 拖拽节点 · 滚轮缩放 · 双击打开';
    _graphSim={stop:function(){if(raf)cancelAnimationFrame(raf);raf=0;}};
  }
 function setKbView(view){var showTrajectory=view==='trajectory';kbBody.hidden=showTrajectory;trajectory.hidden=!showTrajectory;filesButton.setAttribute('aria-pressed',String(!showTrajectory));trajectoryButton.setAttribute('aria-pressed',String(showTrajectory));if(showTrajectory)window.renderLearning();}
 function openGraph(){graphView.hidden=false;graphButton.setAttribute('aria-expanded','true');setKbView('files');renderNoteGraph();}
 filesButton.onclick=function(){setKbView('files');};trajectoryButton.onclick=function(){setKbView('trajectory');};graphButton.onclick=openGraph;viewButtons.append(trajectoryButton,graphButton);var kbActions=kbHeader.querySelector('.library-header-actions');if(kbActions)kbActions.insertBefore(viewButtons,kbActions.firstChild);setKbView('files');window.panelLibraryTrajectory=()=>setKbView('trajectory');
 window.kbLoadTree=()=>views.kb.load();window.renderMemoryPage=()=>views.memory.load();window.panelOpenLibrary=async function(source,path){var page=source==='knowledge'?'kb':'memory';switchPage(page);if(page==='kb')setKbView('files');return views[page].open(source,path);};window.kbOpenNote=path=>{switchPage('kb');setKbView('files');return views.kb.open('knowledge',path);};window.kbNewNote=()=>{var b=[].slice.call(document.querySelectorAll('#page-kb .page-header button')).find(function(x){return x.textContent.indexOf('新建笔记')>=0;});if(b)b.click();};
 ['memDistill','memLoadDaily','memLoadEvolution'].forEach(name=>window[name]=()=>switchPage('memory'));
}());
