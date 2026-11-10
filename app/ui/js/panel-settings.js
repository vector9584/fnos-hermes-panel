(function(){
  'use strict';
  var mode='collapsed',loading=false;
  try{var saved=localStorage.getItem('panel-tools-mode'),old=(PV.Store.load().chat||{});mode=saved|| (old.tools_hidden?'hidden':old.tools_collapse===false?'expanded':'collapsed');}catch(_){}
  if(!['collapsed','expanded','hidden'].includes(mode))mode='collapsed';
  window.panelToolsMode=function(){return mode;};
  var select=document.getElementById('settingsToolsMode'),feedback=document.getElementById('settingsFeedback'),retry=document.getElementById('settingsRetry');
  function apply(value){var changed=mode!==value;mode=value;select.value=value;try{localStorage.setItem('panel-tools-mode',value);var stored=PV.Store.load();stored.chat=stored.chat||{};stored.chat.tools_hidden=value==='hidden';stored.chat.tools_collapse=value==='collapsed';PV.Store.save(stored);}catch(_){}
    if(changed){if(typeof _chatHTML==='object')Object.keys(_chatHTML).forEach(function(key){delete _chatHTML[key];});document.dispatchEvent(new CustomEvent('hermes:display'));if(currentSession&&!_tabStreaming[currentSession]&&!_channelViewActive)loadSessionMessages(currentSession,false,true);}
  }
  async function request(method,body){var response=await fetch(apiUrl('/api/workspace-ui'+(method==='PUT'?'/preferences':'')),{method:method,headers:{'Content-Type':'application/json','X-Monitor-Token':monitorToken||''},body:body?JSON.stringify(body):undefined});var data=await response.json();if(!response.ok||data.error)throw Error(data.error||'设置读取失败');return data;}
  window.renderPanelSettings=async function(){if(loading)return;loading=true;select.disabled=true;retry.hidden=true;feedback.textContent='正在读取设置…';try{await fetchToken();var data=await request('GET');if(!data.display){var result=await request('PUT',{display:{tools_mode:mode}});data=result.state;}apply(data.display.tools_mode);feedback.textContent='设置已同步';select.disabled=false;}catch(error){feedback.textContent=error.message;retry.hidden=false;}finally{loading=false;}};
  select.onchange=async function(){var previous=mode;select.disabled=true;feedback.textContent='正在保存…';try{var result=await request('PUT',{display:{tools_mode:select.value}});apply(result.state.display.tools_mode);feedback.textContent='已保存，当前会话显示已更新';}catch(error){select.value=previous;feedback.textContent='未保存：'+error.message;}finally{select.disabled=false;}};
  retry.onclick=window.renderPanelSettings;
  apply(mode);
  window.renderPanelSettings();
}());
