/* Mini Popup
 * 来源：index.html 内联 app.js 第 4890-5420 行（共 531 行）
 * 2026-11-13 按原分区纯搬运外移，逻辑零改动。全局作用域与执行顺序与原内联块一致。 */

/* ============================ Mini Popup ============================ */
/* 构建模型下拉选项（按 Provider 分组、仅含启用模型）；当前值不在列表中时补一个自定义项 */
function buildModelOptionsHtml(currentValue, emptyLabel){
  var cur = String(currentValue||'');
  var html = '<option value="">'+esc(emptyLabel||'（跟随默认配置）')+'</option>';
  var found = !cur;
  (_cfg.providers||[]).filter(function(p){return p.enabled!==false;}).forEach(function(p){
    var provName = p.name || p.id;
    var models = (p.models && p.models.length) ? p.models : [{ id:p.model||'auto', name:p.model||'auto', enabled:true }];
    var opts='';
    models.forEach(function(m){
      if(m.enabled === false) return;
      var modelId = m.id || m.name || 'auto';
      var modelName = m.name || m.id || 'auto';
      if(modelId===cur) found=true;
      opts += '<option value="'+DOM.escAttr(modelId)+'"'+(modelId===cur?' selected':'')+'>'+esc(modelName)+'</option>';
    });
    if(opts) html += '<optgroup label="'+DOM.escAttr(provName)+'">'+opts+'</optgroup>';
  });
  if(!found) html += '<optgroup label="当前配置"><option value="'+DOM.escAttr(cur)+'" selected>'+esc(cur)+'（不在模型列表中）</option></optgroup>';
  return html;
}
function buildMiniData(){
  // 模型选择器：按 Provider 分组展示模型列表（Issue #5），避免全部挤在一起
  var modelGroups = [];
  (_cfg.providers||[]).filter(function(p){return p.enabled!==false;}).forEach(function(p){
    var provName = p.name || p.id;
    var provId = p.id || p.name;
    var models = (p.models && p.models.length) ? p.models : [{ id:p.model||'auto', name:p.model||'auto', enabled:true }];
    var enabledModels = [];
    models.forEach(function(m){
      if(m.enabled === false) return;
      var modelId = m.id || m.name || 'auto';
      var modelName = m.name || m.id || 'auto';
      var isActive = false;
      var _curModel = _getSessionModel();
      if(_curModel && typeof _curModel === 'object' && _curModel.model){
        isActive = (_curModel.provider === provId && _curModel.model === modelId);
      }
      enabledModels.push({ t: modelName, d: modelId, ico:'⚙️', active: isActive, provider: provId, model: modelId });
    });
    if(enabledModels.length) modelGroups.push({ name: provName, base_url: p.base_url||'', items: enabledModels });
  });
  if(!modelGroups.length) modelGroups = [{ name:'未配置', items:[{ t:'未配置模型', d:'请到「模型」页添加', ico:'⚙️' }] }];
  // A connector shortcut is actionable only when its credentials are saved.
  // The dedicated picker applies the same rule; keep this fallback data path
  // aligned so an older/openMini call cannot expose inert choices.
  var connectors = (_connState.list||[]).filter(function(c){return c.configured;}).map(function(c){
    return { t:c.name||c.kind, d:'已启用', ico:(c.icon||'🔌'), active:c.kind===_selectedConnector, kind:c.kind };
  });
  var skills = (_skillLocal.length?_skillLocal:(_state&&_state.skills&&PV.skillsLocal))||[];
  var skillItems = (skills.length?skills:PV.skillsLocal).map(function(sk){
    var nm = sk.name||sk.id||'技能';
    return { t:nm, d:sk.desc||sk.description||'', ico:sk.icon||'📦', active:_activeSkills.indexOf(nm)>=0 };
  });
  return {
    model:{ title:'选择模型', groups:modelGroups },
    connector:{ title:'选择连接器', items:connectors, foot:'管理连接器' },
    skill:{ title:'选择技能', items:skillItems },
    expert:{ title:'选择专家', items: expertsList().map(function(e){ return { id:e.id, t:e.name, d:e.dept||'', ico:e.icon||'🎯', active:false }; }) },
    quick:{ title:'快捷指令', search:false, groups:PV.quickGroups }
  };
}
function expertsList(){
  if(window.AGENCY_PERSONAS && window.AGENCY_PERSONAS.length){
    return window.AGENCY_PERSONAS.map(function(p){
      return { id:p.id, name:(p.label||p.name||'未命名'), dept:(p.dept_label||p.dept||''), deptId:(p.dept||''), icon:(p.emoji||p.icon||'🎯') };
    });
  }
  return PV.experts.map(function(e){ return { id:e.id, name:e.name, dept:(e.dept||''), deptId:(e.dept||''), icon:(e.icon||'🎯') }; });
}
/* 动态加载 agency-agents-zh 专家库（Issue #1）。
   打包后的 app 中 js/personas_library.js 可能因浏览器缓存/加载时序失败，这里兜底注入并回调重渲染。
   采用版本号缓存键（替代 Date.now() 强制每次重下载）+ 多次重试，确保 268 位专家必然加载。 */
function ensurePersonasLibrary(cb, attempt){
  if(window.AGENCY_PERSONAS && window.AGENCY_PERSONAS.length){ mbtiInject(); if(cb) cb(); return; }
  attempt = attempt || 1;
  var s = document.createElement('script');
  s.src = 'js/personas_library.js?v=' + (window.__APP_VER__ || 'app') + '&t=' + attempt;
  s.onload = function(){ mbtiInject(); if(cb) cb(); };
  s.onerror = function(){
    if(attempt < 4){ setTimeout(function(){ ensurePersonasLibrary(cb, attempt + 1); }, 400 * attempt); }
    else if(cb) cb();
  };
  document.head.appendChild(s);
}
/* 启动时强制刷新专家库（即便 index.html 已同步加载，也重新拉取最新版，规避旧缓存导致只剩 8 个） */
function bootstrapPersonasLibrary(){
  ensurePersonasLibrary(function(){
    if(window.AGENCY_PERSONAS && window.AGENCY_PERSONAS.length){
      if(window.__expRendered){ renderExperts(); }
      if(window.__personasOpenMini){ window.__personasOpenMini(); }
    }
  });
}
function openMini(btn, key){
  if(activeBtn===btn){ closeMini(); return; }
  closeMini();
  activeBtn=btn; activePanel=key;
  popup=document.getElementById('miniPopup');
  if(key==='model'){ _modelLevel=1; _modelProvider=null; }
  var d=buildMiniData()[key];
  document.getElementById('popupTitle').textContent=d.title;
  var sw=document.getElementById('popupSearchWrap');
  sw.style.display = d.search===false ? 'none':'block';
  if(d.search!==false){ var _ps=document.getElementById('popupSearch'); _ps.placeholder='搜索'+d.title.replace('选择',''); _ps.value=''; }
  var foot=document.getElementById('popupFoot');
  if(d.foot){ foot.style.display='block'; foot.textContent=d.foot; foot.onclick=function(){ closeMini(); switchPage('connectors'); }; }
  else foot.style.display='none';

  var tabs=document.getElementById('popupTabs');
  if(key==='expert'){
    tabs.style.display='flex';
    tabs.setAttribute('role','tablist');
    tabs.setAttribute('aria-label','选择专家或表达风格');
    tabs.innerHTML='<button type="button" id="popupExpertTab" role="tab" aria-controls="popupBody" aria-selected="'+(_expertPickerTab==='single')+'" tabindex="'+(_expertPickerTab==='single'?'0':'-1')+'" class="mini-popup-tab '+(_expertPickerTab==='single'?'active':'')+'" onclick="switchExpertPickerTab(\'single\')">专家</button>'+
      '<button type="button" id="popupPersonaTab" role="tab" aria-controls="popupBody" aria-selected="'+(_expertPickerTab==='persona')+'" tabindex="'+(_expertPickerTab==='persona'?'0':'-1')+'" class="mini-popup-tab '+(_expertPickerTab==='persona'?'active':'')+'" onclick="switchExpertPickerTab(\'persona\')">表达风格</button>';
    tabs.onkeydown=function(e){
      if(e.key!=='ArrowLeft'&&e.key!=='ArrowRight'&&e.key!=='Home'&&e.key!=='End')return;
      e.preventDefault();
      var next=e.key==='Home'?'single':e.key==='End'?'persona':_expertPickerTab==='single'?'persona':'single';
      switchExpertPickerTab(next);
      tabs.querySelector('[aria-selected="true"]').focus();
    };
  } else {
    tabs.style.display='none'; tabs.innerHTML=''; tabs.onkeydown=null; tabs.removeAttribute('role'); tabs.removeAttribute('aria-label');
  }

  var popupBody=document.getElementById('popupBody');
  popupBody.innerHTML=buildMiniPopupBody(key,d);
  if(key==='expert'){
    popupBody.setAttribute('role','tabpanel');
    popupBody.setAttribute('aria-labelledby',_expertPickerTab==='single'?'popupExpertTab':'popupPersonaTab');
  } else { popupBody.removeAttribute('role'); popupBody.removeAttribute('aria-labelledby'); }
  popup.classList.toggle('wide', key==='quick');
  popup.classList.add('open');
  document.body.classList.add('mini-open');        // 手机端靠这个类显示背板
  watchPopupResize();
  positionPopup(btn);
  var first=key==='expert'?popup.querySelector('[role="tab"][aria-selected="true"]'):key==='quick'||d.search===false?popup.querySelector('#popupBody button'):document.getElementById('popupSearch');
  /* 触屏设备上 focus() 会直接把软键盘顶起来：一开面板键盘就盖住半屏，用户第一眼看到的是键盘不是列表。
     桌面保留自动聚焦（可以直接打字搜索），触屏一律不抢焦点，让用户自己点输入框。 */
  var _touch = (window.matchMedia && window.matchMedia('(pointer:coarse)').matches) || navigator.maxTouchPoints>0;
  if(first && !_touch){ try{ first.focus(); }catch(e){} }
}
function switchExpertPickerTab(tab){
  if(tab!=='single'&&tab!=='persona')return;
  _expertPickerTab=tab;
  var tabNames={single:'专家',persona:'表达风格'};
  var tabs=document.getElementById('popupTabs');
  Array.from(tabs.children).forEach(function(el){
    var active=el.textContent===tabNames[tab];
    el.classList.toggle('active',active); el.setAttribute('aria-selected',String(active)); el.tabIndex=active?0:-1;
  });
  var body=document.getElementById('popupBody');
  body.setAttribute('aria-labelledby',tab==='single'?'popupExpertTab':'popupPersonaTab');
  body.innerHTML=buildMiniPopupBody('expert', buildMiniData().expert);
  positionPopup(activeBtn);
}
var _modelLevel=1, _modelProvider=null;
function modelPickProvider(btn){
  _modelProvider = btn.getAttribute('data-prov');
  _modelLevel = 2;
  var body=document.getElementById('popupBody');
  body.innerHTML = buildMiniPopupBody('model', buildMiniData().model);
  filterMiniPopup();
  positionPopup(activeBtn);
  var back=body.querySelector('.prov-back'); if(back && window.innerWidth>768) back.focus();
}
function modelPickBack(){
  _modelLevel = 1; _modelProvider = null;
  var body=document.getElementById('popupBody');
  body.innerHTML = buildMiniPopupBody('model', buildMiniData().model);
  filterMiniPopup();
  positionPopup(activeBtn);
  var first=body.querySelector('.prov-card'); if(first && window.innerWidth>768) first.focus();
}
function buildMiniPopupBody(key,d){
  var body='';
  if(key==='quick'){
    body='<div class="cmd-grid">';
    (d.groups||[]).forEach(function(g){
      body+='<div class="cmd-group-title">'+esc(g.title)+'</div>';
      g.commands.forEach(function(c){
        body+='<button type="button" class="cmd-cell" aria-label="'+DOM.escAttr(c.title)+': '+esc(c.cmd)+'" onclick="pickQuick(\''+esc(c.cmd).replace(/\\/g,'\\\\').replace(/'/g,"\\'")+'\')">'+
          '<div class="ico">'+c.ico+'</div><div><div class="title">'+esc(c.title)+'</div><div class="sub">'+esc(c.cmd)+'</div></div></button>';
      });
    });
    body+='</div>';
  } else if(key==='model'){
    var _groups = d.groups || [];
    if(_modelLevel === 2 && _modelProvider){
      var g = null;
      for(var gi=0; gi<_groups.length; gi++){ if(_groups[gi].name===_modelProvider){ g=_groups[gi]; break; } }
      var gitems = (g && g.items) || [];
      body = '<div class="pick-list pick-groups">';
      body += '<button type="button" class="prov-back" onclick="modelPickBack()">'
            + '<span class="pb-arrow">\u2190</span><span class="pb-txt">'+esc(_modelProvider)+'</span>'
            + '<span class="pb-n">'+gitems.length+' \u4e2a\u6a21\u578b</span></button>';
      gitems.forEach(function(it){
        var _attrs = ' data-provider="'+DOM.escAttr(it.provider||_modelProvider)+'" data-model="'+DOM.escAttr(it.model||it.t)+'"';
        body += '<button type="button" class="pop-item '+(it.active?'active':'')+'" aria-pressed="'+!!it.active+'"'+_attrs
              + ' onclick="pickItem(\'model\',this)">'
              + '<div class="ico">'+it.ico+'</div><div class="txt"><div class="t">'+esc(it.t)+'</div>'
              + '<div class="d">'+esc(it.d)+'</div></div><div class="check"></div></button>';
      });
      body += '</div>';
    } else {
      var _cur = _getSessionModel();
      /* 「跟随默认配置」只在第一级出现一次，放在最上面。
         以前它被塞进每个 provider 的二级列表里，点开任何一个来源都冒出一条，
         用户以为是重复选项——其实是同一个清除动作被复制了五份。 */
      body = '<div class="pick-list" style="margin-bottom:10px">'
           + '<button type="button" class="pop-item'+(_cur?'':' active')+'" aria-pressed="'+(!_cur)+'" data-clear="1" onclick="clearSessionModel()">'
           + '<div class="ico">\u21bb</div><div class="txt"><div class="t">\u8ddf\u968f\u9ed8\u8ba4\u914d\u7f6e</div>'
           + '<div class="d">'+( _cur ? '\u5f53\u524d\u5df2\u9009 '+esc(_cur)+'\uff0c\u70b9\u6b64\u6539\u56de\u9ed8\u8ba4' : '\u5f53\u524d\u5c31\u662f\u9ed8\u8ba4\u6a21\u578b' )+'</div></div><div class="check"></div></button></div>';
      body += '<div class="prov-cards">';
      _groups.forEach(function(g){
        var items = g.items || [];
        var act = null;
        items.forEach(function(it){ if(it.active) act = it.t; });
        var _srch = g.name + ' ' + items.map(function(it){ return it.t || ''; }).join(' ');
        body += '<button type="button" class="prov-card" data-prov="'+DOM.escAttr(g.name)+'" data-search="'+DOM.escAttr(_srch)+'" onclick="modelPickProvider(this)">'
              + '<div class="pc-top"><span class="pc-name">'+esc(g.name)+'</span>'
              + '<span class="pc-n">'+items.length+'</span></div>'
              + '<div class="pc-sub">'+(act ? '\u5f53\u524d\uff1a'+esc(act) : (items.length ? '\u9009\u4e00\u4e2a\u6a21\u578b' : '\u6682\u65e0\u53ef\u7528\u6a21\u578b'))+'</div>'
              + '</button>';
      });
      body += '</div>';
      body += '<div class="prov-tip">\u5148\u9009\u6765\u6e90\uff0c\u518d\u9009\u6a21\u578b\u00b7\u4ec5\u5f53\u524d\u4f1a\u8bdd\u751f\u6548</div>';
    }
  } else if(key==='expert'){
    if(_expertPickerTab==='persona'){
      body='<div class="pick-list"><div class="empty-state" style="padding:18px;text-align:center">表达风格只影响当前会话的回答方式，不切换全局 SOUL、记忆或渠道环境。<br><button class="btn sm primary" style="margin-top:12px" onclick="openSessionPersonalityFromMini()">设置本会话表达风格</button></div></div>';
    } else {
      body='<div class="pick-list">';
      (d.items||[]).forEach(function(it){
        // 选中态：与「单专家注入对象」_selectedExpert 比对
        var selExpert = (_selectedExpert && _selectedExpert.id===(it.id||''));
        body+='<button type="button" class="pop-item'+(selExpert?' active':'')+'" aria-pressed="'+selExpert+'" data-id="'+DOM.escAttr(it.id||'')+'" onclick="pickItem(\'expert\',this)">'+
          '<div class="ico">'+it.ico+'</div><div class="txt"><div class="t">'+esc(it.t)+'</div><div class="d">'+esc(it.d)+'</div></div><div class="check"></div></button>';
      });
      body+='</div>';
    }
  } else {
    body='<div class="pick-list">';
    (d.items||[]).forEach(function(it){
      body+='<button type="button" class="pop-item '+(it.active?'active':'')+'" aria-pressed="'+!!it.active+'" onclick="pickItem(\''+key+'\',this)">'+
        '<div class="ico">'+it.ico+'</div><div class="txt"><div class="t">'+esc(it.t)+'</div><div class="d">'+esc(it.d)+'</div></div><div class="check"></div></button>';
    });
    body+='</div>';
  }
  return body;
}
/* 迷你弹窗通用搜索过滤：模型/专家/技能/连接器/快捷指令条目按文本实时筛选。
   模型多达上百个时避免逐个翻找；过滤后空分组连同组头一起隐藏。 */
function filterMiniPopup(){
  var ps=document.getElementById('popupSearch'); if(!ps) return;
  var q=(ps.value||'').trim().toLowerCase();
  var body=document.getElementById('popupBody'); if(!body) return;
  /* 一级列表是 .prov-card（来源卡片），二级才是 .pop-item。
     原来只过滤 .pop-item —— 在一级列表里打字，五张来源卡片纹丝不动，
     用户当然说「搜索模型没用」。来源卡片自己带着 data-search（含它名下所有模型名），
     所以搜模型名也能把卡片筛出来。 */
  function hit(el){
    if(!q) return true;
    var t=((el.textContent||'')+' '+(el.getAttribute('data-search')||'')+' '+(el.getAttribute('data-provider')||'')+' '+(el.getAttribute('data-model')||'')).toLowerCase();
    return t.indexOf(q)>=0;
  }
  var shown=0;
  body.querySelectorAll('.pop-item,.prov-card,.cmd-cell').forEach(function(it){
    var ok=hit(it); it.style.display=ok?'':'none'; if(ok) shown++;
  });
  body.querySelectorAll('.pick-group').forEach(function(g){
    var any=false; g.querySelectorAll('.pop-item,.prov-card,.cmd-cell').forEach(function(it){ if(it.style.display!=='none') any=true; });
    g.style.display=any?'':'none';
  });
  var emp=document.getElementById('popupEmpty');
  if(!emp){
    emp=document.createElement('div'); emp.id='popupEmpty'; emp.className='pop-empty';
    emp.style.cssText='padding:18px;text-align:center;font-size:13px;opacity:.6';
    body.appendChild(emp);
  }
  emp.textContent = shown ? '' : '没有匹配项';
  emp.style.display = shown ? 'none' : '';
  var tip=body.querySelector('.prov-tip'); if(tip) tip.style.display = q ? 'none' : '';
  /* 过滤会改高度，位置得跟着重排（不然底部三角又飘走） */
  if(activeBtn) positionPopup(activeBtn);
}
/* 小浮层定位：贴着触发按钮、永远留 10px 缝，上方放不下才翻到下方。
   原来只在 openMini 里定位一次，而 top 是死值 —— 二级菜单（选模型 → 某 Provider）内容更短，
   高度一缩整块就往上飘，底部那个小三角悬在离按钮两百多像素的空中。
   现在：高度变了就重排（ResizeObserver），并且按上下可用空间决定方向。 */
var _popupRO=null, _popupBusy=false, _popupLastH=0;
function positionPopup(btn){
  if(!btn||window.innerWidth<=768) return;
  _popupBusy=true;
  var rect=btn.getBoundingClientRect();
  var width=activePanel==='quick'?560:360;
  var left=rect.left + rect.width/2 - width/2;
  if(left<8) left=8;
  if(left+width>window.innerWidth-8) left=window.innerWidth-width-8;
  popup.style.width=width+'px';
  popup.style.left=left+'px';
  popup.style.maxHeight='';                       // 先清掉上一次的限高，否则量出来的高度是压过的
  var gap=10, edge=12;
  var h=popup.offsetHeight;
  var spaceAbove=rect.top-edge, spaceBelow=window.innerHeight-rect.bottom-edge;
  var up = h<=spaceAbove || spaceAbove>=spaceBelow;
  var avail = up?spaceAbove:spaceBelow;
  if(h>avail){                                    // 两边都放不下：按可用空间压高度，滚动交给 body
    popup.style.maxHeight=Math.max(200,avail)+'px';
    h=popup.offsetHeight;
  }
  popup.classList.toggle('top',up);
  popup.classList.toggle('bottom',!up);
  var top = up ? rect.top-gap-h : rect.bottom+gap;
  if(top<8) top=8;
  popup.style.top=top+'px';
  var arrowLeft=rect.left + rect.width/2 - left;
  popup.style.setProperty('--arrow-left', Math.max(18, Math.min(width-18, arrowLeft))+'px');
  var near = up ? (rect.top-(top+h))<=gap+6 : (top-rect.bottom)<=gap+6;
  popup.classList.toggle('arrow-off',!near);      // 被视口顶开、三角指不到按钮时索性藏掉
  _popupLastH=popup.offsetHeight;
  _popupBusy=false;
}
function watchPopupResize(){
  if(_popupRO||typeof ResizeObserver==='undefined') return;
  _popupRO=new ResizeObserver(function(){
    if(_popupBusy||!popup||!popup.classList.contains('open')||!activeBtn) return;
    if(Math.abs(popup.offsetHeight-_popupLastH)<1) return;
    positionPopup(activeBtn);
  });
  _popupRO.observe(popup);
}
function closeMini(restoreFocus){
  var restore=activeBtn;
  if(popup){ popup.classList.remove('open','wide'); }
  document.body.classList.remove('mini-open');
  /* 焦点还留在弹层里（搜索框）时键盘不会自己退，必须主动 blur */
  try{ var ae=document.activeElement; if(ae&&popup&&popup.contains(ae)) ae.blur(); }catch(e){}
  activeBtn=null; activePanel=null;
  document.querySelectorAll('.tool-btn').forEach(function(b){ b.classList.remove('active'); });
  if(restoreFocus!==false&&restore&&restore.isConnected) restore.focus();
}
document.addEventListener('keydown',function(e){
  if(!popup||!popup.classList.contains('open'))return;
  if(e.key==='Escape'){ e.preventDefault(); closeMini(); }
});
/* 窗口尺寸变了（转屏、拉窄）位置就过期了：桌面端重排一次，别让弹层飘到屏外 */
window.addEventListener('resize',function(){
  if(!popup||!popup.classList.contains('open'))return;
  if(window.innerWidth<=768) return;              // 手机端由 CSS 底部卡片接管
  positionPopup(activeBtn);
});
function pickItem(key, el){
  var name = el.querySelector('.t') ? el.querySelector('.t').textContent : '';
  if(key==='expert'){
    // 工具栏专家选择器：为专家开启独立会话并注入单专家（决策 3，不替换 persona）
    pickItemExpert(el.getAttribute('data-id'), el);
    return;
  } else if(key==='model'){
    var b=document.getElementById('btnModel');
    if(b){
      b.setAttribute('data-tip','模型: '+name); b.classList.add('active');
      // 更新徽章
      var oldBadge = b.querySelector('.model-badge'); if(oldBadge) oldBadge.remove();
      var badge=document.createElement('span');
      badge.className='model-badge';
      badge.textContent=name.length>8?name.slice(0,8)+'…':name;
      b.appendChild(badge);
    }
    var prov = el.getAttribute('data-provider');
    var model = el.getAttribute('data-model');
    if(prov && model){
      _selectedModel = { provider: prov, model: model };
    } else {
      _selectedModel = name;
    }
    _setSessionModel(currentSession, _selectedModel);
    toast('已选择模型：'+name+'（仅当前会话）');
    closeMini();
    return;
  } else if(key==='skill'){
    // 真实切换「已启用技能」：加入/移除 _activeSkills，渲染 chip，并在发送时注入 system 提示
    var idx=_activeSkills.indexOf(name);
    if(idx>=0){ _activeSkills.splice(idx,1); el.classList.remove('active'); el.setAttribute('aria-pressed','false'); toast('已停用技能：'+name); }
    else { _activeSkills.push(name); el.classList.add('active'); el.setAttribute('aria-pressed','true'); toast('已启用技能：'+name); }
    var b2=document.getElementById('btnSkill'); if(b2) b2.classList.toggle('active', _activeSkills.length>0);
    renderSkillChips();
    return; // 保持弹窗打开，可继续勾选多个技能
  }
  closeMini();
}
/* 工具栏专家选择器：为所选专家创建/复用独立会话，并设为单专家注入对象 */
function pickItemExpert(id, el){
  var name = (el && el.querySelector('.t')) ? el.querySelector('.t').textContent : '';
  var prompt=''; var pid=id;
  if(!pid && name){
    var f=(window.AGENCY_PERSONAS||[]).find(function(x){ return (x.label||x.name)===name; });
    if(f) pid=f.id;
  }
  var ap=(window.AGENCY_PERSONAS||[]).find(function(x){ return x.id===pid; });
  if(ap){ prompt=ap.prompt||''; if(!name) name=(ap.label||ap.name||pid); }
  var expertName = name || (pid ? pid : '');
  // Issue #6 修正：选择单个专家时不再自动创建专家团，仅注入该专家的系统提示；
  // 专家团模式需通过「选择专家」弹窗的「专家团」tab 手动启用。
  // 为每个专家创建独立的顶层 agent 分组，会话归入该分组而非 default
  var agentId = 'exp-' + pid;
  var agent = ensureAgent(agentId, { name: expertName, icon: (ap && (ap.emoji||ap.icon)) || '🎯', expertId: pid });
  function afterSwitch(){
    currentAgent = agentId;
    _selectedExpert = { id:pid||'', name:expertName, prompt:prompt };
    var t=document.getElementById('chatTitle'); if(t) t.textContent=expertName;
    renderSelectedExpertBar();
    toast('已为专家「'+expertName+'」开启独立会话（发送时注入系统提示）');
  }
  // profilefix v4（模型 A）：会话不分归属，每次开启专家对话新建一个会话（全局树平铺）。
  var existing = null;
  if(existing){
    switchSession(agentId, existing.id); afterSwitch();
  } else {
    fetch(apiUrl('/api/sessions'), { method:'POST', headers: monitorToken?{'X-Monitor-Token':monitorToken}:{} })
      .then(function(r){ return r.json(); })
      .then(function(s){
        _sessions.unshift(s);
        currentSession=s.id; currentAgent=agentId;
        _openTabs.push(s.id); persistTabs();
        renderSessionTabs(); renderRail(); updateHeader();
        if(window.innerWidth<=768) closeRailDrawer();
        sendRaw('/title '+expertName); afterSwitch();
      })
      .catch(function(){ toast('创建会话失败'); });
  }
  closeMini();
}
function agencyIdByName(name){
  if(!window.AGENCY_PERSONAS) return '';
  var f=window.AGENCY_PERSONAS.find(function(x){ return (x.label||x.name)===name; });
  return f ? f.id : '';
}
/* 兼容旧快捷入口：任务方案是唯一工作流/专家分工入口。 */
function pickWorkflowFromMini(key){
  switchPage('plans');
}
function clearWorkflowFromMini(){
  switchPage('plans');
}
/* Keep expression style session-scoped; never activate a global Hermes profile here. */
function openSessionPersonalityFromMini(){ closeMini(); if(window.pwPersonality) window.pwPersonality(); }
/* 连接器激活卡片（渲染在输入区上方，best-effort 调用首个工具） */
var _selectedModelMap = (function(){ try{ var s=localStorage.getItem('hermes_selected_model_map'); return s?JSON.parse(s):{}; }catch(e){ return {}; } })();
// 无当前会话时选择的模型暂存于此，会话创建后自动绑定（修复：新建会话前选模型被丢弃的问题）
var _pendingModel = '';
function _getSessionModel(sid){ return _selectedModelMap[sid||currentSession] || ''; }
function _setSessionModel(sid, val){ if(!sid) sid=currentSession; if(!sid){ if(val) _pendingModel = val; return; } if(val){ _selectedModelMap[sid]=val; } else { delete _selectedModelMap[sid]; } try{ localStorage.setItem('hermes_selected_model_map', JSON.stringify(_selectedModelMap)); }catch(e){} }
// 会话创建成功后调用：把暂存的模型绑定到新会话（若该会话尚未绑定过模型）
function _applyPendingModel(sid){
  if(_pendingModel && sid && !_selectedModelMap[sid]){
    _selectedModelMap[sid] = _pendingModel;
    _pendingModel = '';
    try{ localStorage.setItem('hermes_selected_model_map', JSON.stringify(_selectedModelMap)); }catch(e){}
    _syncModelBtn();
  }
}
function clearSessionModel(){
  _pendingModel = '';
  _setSessionModel(currentSession, '');
  _selectedModel = '';
  var b=document.getElementById('btnModel');
  if(b){
    b.setAttribute('data-tip','选择模型'); b.classList.remove('active');
    var oldBadge = b.querySelector('.model-badge'); if(oldBadge) oldBadge.remove();
  }
  toast('已清除模型选择，将使用默认配置');
  closeMini();
}
// 兼容旧版全局 key 迁移
var _selectedModel = (function(){ try{ var s=localStorage.getItem('hermes_selected_model'); if(s){ var v=JSON.parse(s); localStorage.removeItem('hermes_selected_model'); return v; } return ''; }catch(e){ return ''; } })();
if(_selectedModel && currentSession){ _setSessionModel(currentSession, _selectedModel); _selectedModel=''; }
function persistSelectedModel(){ _setSessionModel(currentSession, _selectedModel); }
var _activeSkills = [];   // 当前会话已启用的技能（名称列表），发送时注入 system 提示
var _selectedExpert = null;     // 单专家注入对象 {id,name,prompt}（决策 3，随会话）
var _selectedConnector = '';    // 当前选中的连接器 kind（字符串）
var _wfSteps = [];              // 工作流 DAG 编辑中的步骤工作副本
function renderSkillChips(){
  var box=document.getElementById('skillChips'); if(!box) return;
  if(!_activeSkills.length){ box.innerHTML=''; box.style.display='none'; return; }
  box.style.display='flex';
  box.innerHTML = _activeSkills.map(function(n){
    return '<button type="button" class="skill-chip" aria-label="移除技能：'+esc(n)+'" title="移除技能：'+esc(n)+'" onclick="removeSkill(\''+esc(n).replace(/\\/g,'\\\\').replace(/'/g,"\\'")+'\')">'+esc(n)+' <span class="x" aria-hidden="true">×</span></button>';
  }).join('');
}
function removeSkill(n){
  var idx=_activeSkills.indexOf(n); if(idx>=0) _activeSkills.splice(idx,1);
  var b2=document.getElementById('btnSkill'); if(b2) b2.classList.toggle('active', _activeSkills.length>0);
  renderSkillChips();
}
function pickQuick(cmd){
  closeMini();
  /* 交给 panel-slash.js 按命令种类分派：/model 走两级卡片弹窗、带参命令进 chip。
     旧版直接 handleSlashCommand(cmd)，/model 会被判成"切换模型"而跳去配置页。 */
  if(window.slashInsert && window.slashInsert(cmd)) return;
  handleSlashCommand(cmd);
}
function handleSlashCommand(cmd){
  if(!cmd || cmd.charAt(0)!=='/'){ sendRaw(cmd); return; }
  var parts = cmd.split(' ');
  var base = parts[0].toLowerCase();
  var arg = parts.slice(1).join(' ').trim();
  if(base==='/new'){
    if(window.pwCreateChat) window.pwCreateChat(arg);
    else toast('快捷操作暂不可用，请刷新面板后重试');
    return;
  }
  if(base==='/stop'){
    chatStop();
    toast('已停止当前生成');
    return;
  }
  if(window.handlePanelSlashCommand){ window.handlePanelSlashCommand(cmd); return; }
  var ta=document.getElementById('chatInput');
  if(ta){ta.value=cmd;autoResize(ta);if(typeof saveDraft==='function')saveDraft(currentSession);}
  toast('此快捷命令暂不可用，请刷新面板后重试');
}
function appendSystemMessage(text){
  var body=document.getElementById('chatBody'); if(!body) return;
  var div=document.createElement('div'); div.className='system-tip'; div.textContent=text;
  body.appendChild(div); followChatBottom();
}