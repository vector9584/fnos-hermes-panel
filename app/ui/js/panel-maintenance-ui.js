(function(){
  'use strict';
  var selected='',ref='',next=null,busy=false,generation=0;
  function el(tag,text,cls){var node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node;}
  async function request(path){var response=await fetch(apiUrl(path),{headers:{'X-Monitor-Token':monitorToken||''}});var body=await response.json();if(!response.ok||!body.ok)throw Error(body.error||'读取版本记录失败');return body;}
  function feedback(message){document.getElementById('maintenanceFeedback').textContent=message;}
  function controls(){document.getElementById('maintenanceRefresh').disabled=busy;document.getElementById('maintenanceMore').disabled=busy;}
  async function history(append){
    if(busy)return;busy=true;controls();var ticket=++generation;
    var list=document.getElementById('maintenanceHistory'),more=document.getElementById('maintenanceMore');
    if(!append){list.replaceChildren();ref='';next=null;more.hidden=true;}feedback('正在读取提交记录…');
    try{
      var data=await request('/api/maintenance/history?repo='+encodeURIComponent(selected)+(append?'&ref='+ref+'&offset='+next:''));
      if(ticket!==generation)return;ref=data.ref;next=data.next;
      data.commits.forEach(function(commit){
        var item=el('article',undefined,'maintenance-commit');item.append(el('h2',commit.subject));
        var meta=el('div',undefined,'maintenance-meta');meta.append(el('code',commit.hash.slice(0,12)),el('span',commit.author),el('time',new Date(commit.date).toLocaleString()));item.append(meta);
        if(commit.body){var details=el('details');details.append(el('summary','查看提交说明'),el('pre',commit.body));item.append(details);}list.append(item);
      });
      if(!list.children.length)list.append(el('p','此仓库没有提交记录。'));
      more.hidden=next===null;feedback('已显示 '+list.children.length+' 条提交 · 快照 '+ref.slice(0,12));
    }catch(error){feedback(error.message);}
    finally{busy=false;controls();}
  }
  window.renderMaintenancePage=async function(){
    if(busy)return;busy=true;controls();feedback('正在读取本地仓库状态…');
    try{
      var data=await request('/api/maintenance/repositories'),tabs=document.getElementById('maintenanceRepositories');tabs.replaceChildren();
      if(!data.repositories.some(function(repo){return repo.id===selected&&repo.available;}))selected=(data.repositories.find(function(repo){return repo.available;})||{}).id||'';
      data.repositories.forEach(function(repo){
        var card=el('button',undefined,'maintenance-repository');card.type='button';card.disabled=!repo.available;card.setAttribute('aria-pressed',String(repo.id===selected));
        card.append(el('strong',repo.name),el('span',repo.available?(repo.changes?repo.changes+' 项未提交变更':'工作区无未提交变更'):repo.error));
        if(repo.available)card.append(el('code',repo.head.slice(0,12)));
        card.onclick=function(){if(busy)return;selected=repo.id;try{localStorage.setItem('panel-maintenance-repository',selected);}catch(_){}tabs.querySelectorAll('button').forEach(function(button){button.setAttribute('aria-pressed',String(button===card));});history(false);};tabs.append(card);
      });
      if(!selected){document.getElementById('maintenanceHistory').replaceChildren();document.getElementById('maintenanceMore').hidden=true;feedback('未能读取代码仓库，请检查上方状态后重试。');}
    }catch(error){feedback(error.message);selected='';}
    finally{busy=false;controls();}
    if(selected)await history(false);
  };
  try{selected=localStorage.getItem('panel-maintenance-repository')||'';}catch(_){}
  document.getElementById('maintenanceRefresh').onclick=window.renderMaintenancePage;
  document.getElementById('maintenanceMore').onclick=function(){history(true);};
}());
