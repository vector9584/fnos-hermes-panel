(function(){
  'use strict';
  var catalog=[],load;
  async function refresh(){
    if(load)return load;
    load=(async function(){var response=await fetch(apiUrl('/api/connectors'),{headers:{'X-Monitor-Token':monitorToken||''},cache:'no-store'});var data=await response.json();if(!response.ok||!data.ok||!Array.isArray(data.connectors))throw Error(data.error||'连接器状态读取失败');catalog=data.connectors;_connState.list=catalog;return catalog;})().finally(function(){load=null;});
    return load;
  }
  function node(tag,text){var e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;}
  window.panelConnectorContext=async function(kind){var list=await refresh();var connector=list.find(function(item){return item.kind===kind&&item.configured;});if(!connector)throw Error('所选连接器已不可用，请重新选择或清除');return connector;};
  window.renderConnectorChip=function(){
    var comp=document.getElementById('chatComposer');if(!comp)return;
    var box=document.getElementById('connectorChip');if(!box){box=node('div');box.id='connectorChip';box.className='connector-chip';comp.prepend(box);}
    box.replaceChildren();box.hidden=!_selectedConnector;box.style.display=_selectedConnector?'flex':'none';if(!_selectedConnector)return;
    var connector=catalog.find(function(c){return c.kind===_selectedConnector;});
    var label=node('span',(connector?connector.name:_selectedConnector)+' · 本轮连接器');label.className='cc-name';box.append(label);
    var settings=node('button','查看配置');settings.type='button';settings.className='cc-btn';settings.onclick=function(){openConnectorModal(_selectedConnector);};box.append(settings);
    var clear=node('button','×');clear.type='button';clear.className='cc-x';clear.setAttribute('aria-label','清除本轮连接器');clear.onclick=window.clearConnectorChip;box.append(clear);
  };
  window.clearConnectorChip=function(){_selectedConnector='';renderConnectorChip();saveDraft(currentSession);};
  window.panelConnectorRestore=function(){renderConnectorChip();if(_selectedConnector)refresh().then(renderConnectorChip).catch(function(){});};
  async function choose(){
    var dialog=node('dialog');dialog.className='navigation-dialog connector-picker';dialog.setAttribute('aria-label','本轮连接器');
    dialog.append(node('h2','本轮连接器'),node('p','选择后将随本轮消息说明连接器意图；实际调用由可用工具决定。'));
    var list=node('div'),status=node('p','正在读取配置…');status.setAttribute('role','status');dialog.append(status,list);
    var manage=node('button','管理连接器');manage.onclick=function(){dialog.close();switchPage('comm');setTimeout(function(){document.getElementById('page-connectors')?.scrollIntoView({block:'start'});},100);};
    var close=node('button','关闭');close.className='navigation-close';close.onclick=function(){dialog.close();};dialog.append(manage,close);dialog.addEventListener('close',function(){dialog.remove();document.getElementById('btnConnector').focus();});document.body.append(dialog);dialog.showModal();
    async function populate(){
      status.textContent='正在读取配置…';list.replaceChildren();
      try{var available=(await refresh()).filter(function(c){return c.configured;});if(!dialog.isConnected)return;status.textContent=available.length?'选择已配置的连接器':'尚未配置连接器，请先在管理页保存凭证。';
        available.forEach(function(c){var button=node('button',c.name);button.type='button';button.setAttribute('aria-pressed',String(c.kind===_selectedConnector));button.onclick=function(){_selectedConnector=c.kind;renderConnectorChip();saveDraft(currentSession);dialog.close();};list.append(button);});
      }catch(error){status.textContent=error.message;var retry=node('button','重试');retry.onclick=populate;list.append(retry);}
    }
    await populate();
  }
  var current=null,dialog=document.getElementById('connectorModal'),loadSequence=0,editing=false,busy=false,opener;
  document.body.append(dialog);
  async function apiRequest(path,method,body){var response=await fetch(apiUrl('/api/connectors'+path),{method:method||'GET',cache:'no-store',headers:{'Content-Type':'application/json','X-Monitor-Token':monitorToken||''},body:body?JSON.stringify(body):undefined});var result=await response.json();if(!response.ok||!result.ok)throw Object.assign(Error(result.error||'连接器操作失败'),{result:result,status:response.status});return result;}
  function stateLabel(c){return !c.configured?'未配置':c.activation==='apply_failed'?'已保存 · 应用失败':c.activation==='pending'?'已保存 · 待应用':c.activation==='pending_restart'?'已保存 · 待重启应用':c.activation==='restart_requested'?'已保存 · 已请求服务重载':'已配置';}
  var filter='all';
  window.renderConnectors=async function(){var grid=document.getElementById('connectorGrid');if(!grid)return;grid.replaceChildren(node('p','正在读取连接器…'));try{var list=await refresh();grid.replaceChildren();list.filter(function(c){return filter==='all'||(filter==='configured'?c.configured:!c.configured);}).forEach(function(c){var card=node('article');card.className='connector-card';card.append(node('h3',c.name),node('p',c.description),node('p',stateLabel(c)));var button=node('button',c.configured?'管理连接器':'配置连接器');button.className='action';button.onclick=function(){openConnectorModal(c.kind);};card.append(button);grid.append(card);});if(!grid.children.length)grid.append(node('p','此分类没有连接器。'));}catch(error){grid.replaceChildren(node('p',error.message));var retry=node('button','重新读取');retry.className='action';retry.onclick=renderConnectors;grid.append(retry);}};
  window.setConnFilter=function(button,value){filter=value;document.querySelectorAll('#page-connectors .ch-filter').forEach(function(item){item.classList.toggle('active',item===button);});renderConnectors();};
  function status(message){document.getElementById('connectorActionStatus').textContent=message;}
  function lock(value){busy=value;dialog.querySelectorAll('button,input,textarea,select').forEach(function(control){control.disabled=value;});}
  function field(label,name,secret,value){var wrapper=node('label');wrapper.className='connector-field';wrapper.append(node('span',label));var input=node('input');input.name=name;input.type=secret?'password':'text';input.value='';input.autocomplete='off';input.placeholder=value||'';wrapper.append(input);return wrapper;}
  function credentials(){var body={revision:current.revision};dialog.querySelectorAll('[data-credential]').forEach(function(input){body[input.name]=input.value;});return body;}
  function renderDetail(c){current=c;editing=false;var body=document.getElementById('connModalBody'),foot=document.getElementById('connModalFoot');body.replaceChildren();foot.replaceChildren();document.getElementById('connModalTitle').textContent=c.name;body.append(node('p',c.description),node('p',c.auth_hint));
    if(/^https:\/\//.test(c.doc_url||'')){var link=node('a','获取凭证与官方文档');link.href=c.doc_url;link.target='_blank';link.rel='noopener noreferrer';body.append(link);}
    (c.fields||[]).forEach(function(item){var f=field(item.label,item.key,item.secret,c.creds_set[item.key]?'已设置，留空保留原值':item.placeholder||'');var input=f.querySelector('input');input.dataset.credential='1';input.oninput=function(){editing=true;};body.append(f);});
    var message=node('p',stateLabel(c));message.id='connectorActionStatus';message.setAttribute('role','status');body.append(message);
    function action(label,fn){var button=node('button',label);button.type='button';button.className='action';button.onclick=fn;foot.append(button);}
    if(c.probe_supported)action('测试连接',function(){operate('probe');});
    action('保存配置',function(){operate('save');});
    if(['apply_failed','pending'].includes(c.activation))action('重试应用',function(){operate('activate');});
    if(c.can_undo)action('撤销上次修改',function(){if(confirm('恢复此连接器的上一个配置版本？'))operate('restore');});
    if(c.configured)action('停用连接器',function(){if(confirm('停用此连接器？可以撤销恢复，已保存的消息不受影响。'))operate('disable');});
    if(c.configured&&c.mcp_mode==='gateway'&&(c.tools||[]).length){var details=node('details');details.className='connector-tools';details.append(node('summary','手动调用工具'));var select=node('select');select.setAttribute('aria-label','选择连接器工具');c.tools.forEach(function(tool,i){var option=node('option',tool.name+' · '+(tool.description||''));option.value=i;select.append(option);});var args=node('div'),result=node('pre');result.className='conn-result';result.hidden=true;var run=node('button','调用工具');run.type='button';run.className='action';details.append(select,args,run,result);body.append(details);
      function fields(){args.replaceChildren();var tool=c.tools[Number(select.value)],schema=tool.inputSchema||{};Object.entries(schema.properties||{}).forEach(function(pair){var required=(schema.required||[]).includes(pair[0]);var f=field((pair[1].description||pair[0])+(required?' *':''),pair[0],false);var input=f.querySelector('input');input.required=required;input.dataset.type=pair[1].type||'string';if(['integer','number'].includes(pair[1].type)){input.type='number';input.step=pair[1].type==='integer'?'1':'any';}args.append(f);});}select.onchange=fields;fields();
      run.onclick=async function(){var values={};for(var input of args.querySelectorAll('input')){if(!input.reportValidity())return;if(input.value.trim())values[input.name]=['integer','number'].includes(input.dataset.type)?Number(input.value):input.value.trim();}lock(true);result.hidden=false;result.textContent='正在调用…';try{var response=await apiRequest('/'+encodeURIComponent(c.kind)+'/call','POST',{tool:c.tools[Number(select.value)].name,args:values});result.textContent=typeof response.result==='string'?response.result:JSON.stringify(response.result,null,2);}catch(error){result.textContent=error.message;}finally{lock(false);}};
    }
  }
  async function operate(action){if(busy||!current)return;var kind=current.kind,body=credentials(),path='/'+encodeURIComponent(kind),method='POST';if(action==='probe')path+='/probe';if(['restore','activate'].includes(action)){path+='/'+action;body={revision:current.revision};}if(action==='disable'){method='DELETE';body={revision:current.revision};}lock(true);status(action==='probe'?'正在测试连接…':'正在保存并应用…');try{var response=await apiRequest(path,method,body);if(action==='probe')status(response.message);else{renderDetail(response);status(response.message);refresh().then(function(){renderConnectorChip();renderConnectors();}).catch(function(){});}}catch(error){
    if(error.result?.saved){current={...current,...error.result};renderDetail(current);status(error.message);}else{status(error.message);if(error.status===409){var reload=node('button','保留输入并读取最新版本');reload.className='action';reload.onclick=async function(){var values=credentials();try{var updated=await apiRequest('/'+encodeURIComponent(kind));renderDetail(updated);dialog.querySelectorAll('[data-credential]').forEach(function(input){input.value=values[input.name]||'';});editing=true;status('已读取最新版本；本次输入保留，请核对后再次保存。');}catch(error){status(error.message);}};document.getElementById('connModalBody').append(reload);}}
  }finally{lock(false);}}
  window.openConnectorModal=async function(kind){if(busy)return;if(dialog.open&&!closeConnectorModal())return;opener=document.activeElement;var ticket=++loadSequence;current=null;editing=false;document.getElementById('connModalTitle').textContent='连接器配置';document.getElementById('connModalBody').replaceChildren(node('p','正在读取配置…'));document.getElementById('connModalFoot').replaceChildren();dialog.showModal();try{var data=await apiRequest('/'+encodeURIComponent(kind));if(ticket!==loadSequence||!dialog.open)return;renderDetail(data);}catch(error){if(ticket!==loadSequence)return;var b=document.getElementById('connModalBody');b.replaceChildren(node('p',error.message));var retry=node('button','重试');retry.className='action';retry.onclick=function(){openConnectorModal(kind);};b.append(retry);}};
  window.closeConnectorModal=function(){if(busy)return false;if(editing&&!confirm('凭证修改尚未保存，确定关闭？'))return false;loadSequence++;dialog.close();return true;};
  dialog.addEventListener('cancel',function(event){event.preventDefault();closeConnectorModal();});dialog.addEventListener('close',function(){current=null;editing=false;if(opener?.isConnected)opener.focus();});dialog.querySelector('.modal-close').onclick=closeConnectorModal;
  var oldOpen=window.openMini;window.openMini=function(button,key){if(key==='connector'){closeMini();choose();return;}return oldOpen(button,key);};
  // The previous shortcut invoked the first tool with empty arguments and fabricated a chat fallback.
  window.invokeSelectedConnector=function(){if(_selectedConnector)openConnectorModal(_selectedConnector);};
}());
