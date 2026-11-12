(function(){
  'use strict';
  var tasks=[],services=[],loading=false,dialog=null,active=null,busy=false;
  var fields=['provider','model','base_url','key_env'];
  function element(tag,text,cls){var node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node;}
  async function request(method,body){
    var response=await fetch(apiUrl('/api/panel-models/auxiliary'),{method:method||'GET',headers:{'Content-Type':'application/json','X-Monitor-Token':monitorToken||''},body:body?JSON.stringify(body):undefined});
    var data=await response.json();
    if(!response.ok||!data.ok)throw Object.assign(Error(data.error||'辅助模型读取失败'),{status:response.status});
    return data;
  }
  function accept(data){tasks=data.tasks;services=data.services||[];}
  function providerName(value){var p=services.find(function(p){return p.id===value||p.id==='custom:'+value;});return p?p.name:value||'自动选择';}
  function card(task){
    var node=element('article',undefined,'provider-card auxiliary-card');node.dataset.task=task.key;node.append(element('h3',task.label));
    node.append(element('p',providerName(task.provider)+' / '+(task.model||'服务默认模型')));
    if(task.key==='vision')node.append(element('p',task.fallback_chain.length?'回退顺序：'+task.fallback_chain.map(function(item){return providerName(item.provider)+' / '+(item.model||'服务默认模型');}).join(' → '):'未指定额外回退模型'));
    var more=element('button','编辑配置','action');more.onclick=function(){open(task);};node.append(more);
    return node;
  }
  /* 2026-11-12 重组：原来 11 个任务各占一张卡，10 张写「自动选择」，
     翻半天找不到真正改过的那个。现在把「单独指定过模型的」放卡片，
     其余折叠成一行 chip，点名字才进编辑器。 */
  function draw(){
    var list=document.getElementById('auxTaskList');list.replaceChildren();
    var own=tasks.filter(function(t){return t.provider&&t.provider!=='auto';});
    var auto=tasks.filter(function(t){return !t.provider||t.provider==='auto';});
    if(own.length){var grid=element('div',undefined,'provider-grid');own.forEach(function(t){grid.append(card(t));});list.append(grid);}
    else list.append(element('p','目前没有单独指定的辅助模型。','page-subtitle'));
    if(auto.length){
      var box=element('section',undefined,'aux-auto');
      box.append(element('h3','其余 '+auto.length+' 项跟随主模型'));
      box.append(element('p','这些活直接交给主模型跑；哪一个想换成别的模型，点它的名字。','pw-hint'));
      var row=element('div',undefined,'aux-chip-row');
      auto.forEach(function(task){
        var chip=element('button',task.label,'aux-chip');chip.type='button';
        chip.onclick=function(){open(task);};row.append(chip);
      });
      box.append(row);list.append(box);
    }
  }
  window.loadAuxTasks=async function(){
    if(loading)return;loading=true;var status=document.getElementById('auxiliaryStatus');status.textContent='正在读取辅助模型…';
    try{await fetchToken();accept(await request());draw();status.textContent='已读取当前配置';}
    catch(error){status.textContent=error.message;}
    finally{loading=false;}
  };
  function providers(select,value){
    var entries=[['auto','自动选择'],['custom','独立端点']],seen=new Set(entries.map(function(item){return item[0];}));
    services.forEach(function(p){if(!seen.has(p.id)){entries.push([p.id,p.name||p.id]);seen.add(p.id);}});
    if(value&&!seen.has(value))entries.push([value,value+' · 当前配置']);
    entries.forEach(function(item){var option=element('option',item[1]);option.value=item[0];select.append(option);});select.value=value||'auto';
  }
  function input(label,name,value,type){
    var field=element('label',undefined,'auxiliary-field');field.append(element('span',label));var control=element(type==='select'?'select':'input');
    control.name=name;if(type!=='select')control.type=type||'text';control.value=value??'';
    if(type==='number'){control.min='1';control.max='3600';control.placeholder='使用内核默认值';}
    field.append(control);return field;
  }
  function entryFields(container,value,prefix){
    var service=input('模型服务',prefix+'provider','','select'),select=service.querySelector('select');providers(select,value.provider);
    var model=input('模型',prefix+'model',value.model),modelInput=model.querySelector('input'),options=element('datalist');
    options.id='aux-models-'+Math.random().toString(36).slice(2);modelInput.setAttribute('list',options.id);modelInput.placeholder='选择已有模型，或输入模型 ID';model.append(options);
    var details=element('details',undefined,'auxiliary-endpoint');details.append(element('summary','独立端点与凭证覆盖'));
    details.append(input('端点地址',prefix+'base_url',value.base_url),input('密钥环境变量名',prefix+'key_env',value.key_env));
    details.append(element('p','已配置服务会沿用该服务的凭证。只有独立端点需要在这里覆盖。'));
    details.open=value.provider==='custom'||!!value.base_url||!!value.key_env;
    container.append(service,model,details);
    function choices(){
      var p=services.find(function(p){return p.id===select.value;});options.replaceChildren();
      if(p)[...new Set([p.model].concat(p.models||[]).filter(Boolean))].forEach(function(id){var option=element('option');option.value=id;options.append(option);});
      modelInput.disabled=select.value==='auto';
      details.hidden=select.value==='auto'||!!p;
    }
    select.onchange=function(){
      var choice=this.value,p=services.find(function(p){return p.id===choice;});
      modelInput.value=p?p.model||'':'';
      ['base_url','key_env'].forEach(function(key){container.querySelector('[name="'+prefix+key+'"]').value='';});
      details.open=choice==='custom';choices();saveDraft();
    };
    choices();
  }
  function readEntry(container,prefix){var result={};fields.forEach(function(key){result[key]=container.querySelector('[name="'+prefix+key+'"]').value.trim();});return result;}
  function editable(task){
    var result={};fields.forEach(function(key){result[key]=task[key]||(key==='provider'?'auto':'');});
    ['timeout','download_timeout'].forEach(function(key){result[key]=task[key]??null;});
    result.fallback_chain=(task.fallback_chain||[]).map(function(item){var row={};fields.forEach(function(key){row[key]=item[key]||(key==='provider'?'auto':'');});if(item.source_index!==undefined)row.source_index=item.source_index;return row;});
    return result;
  }
  function values(){
    var next=readEntry(dialog.querySelector('.auxiliary-primary'),'main-');
    ['timeout','download_timeout'].forEach(function(key){var control=dialog.querySelector('[name="'+key+'"]');if(control)next[key]=control.value?Number(control.value):null;});
    if(active.key==='vision')next.fallback_chain=[...dialog.querySelectorAll('.auxiliary-fallback')].map(function(row){var item=readEntry(row,'fb-');if(row.dataset.source!=='')item.source_index=Number(row.dataset.source);return item;});
    return next;
  }
  function storageKey(){return 'panel-auxiliary-draft:'+active.key;}
  function saveDraft(){
    if(!dialog||!active)return;
    try{localStorage.setItem(storageKey(),JSON.stringify({revision:active.revision,baseline:active.baseline,values:values()}));}
    catch(_){dialog.querySelector('.auxiliary-feedback').textContent='浏览器无法保存草稿，请保持此窗口打开。';}
  }
  function fallback(value){
    var row=element('fieldset',undefined,'auxiliary-fallback');row.dataset.source=value.source_index??'';row.append(element('legend','回退模型'));entryFields(row,value,'fb-');
    var remove=element('button','移除此回退','action');remove.type='button';
    remove.onclick=function(){
      var next=row.nextSibling;row.remove();saveDraft();var status=dialog.querySelector('.auxiliary-feedback');status.replaceChildren(element('span','已移除回退项。'));
      var undo=element('button','撤销','action');undo.type='button';undo.onclick=function(){dialog.querySelector('.auxiliary-chain').insertBefore(row,next?.isConnected?next:null);saveDraft();status.textContent='已恢复回退项';};status.append(undo);
    };
    row.append(remove);return row;
  }
  function close(){if(!dialog||busy)return;saveDraft();dialog.close();dialog.remove();dialog=null;active=null;}
  function setBusy(value){busy=value;dialog.querySelectorAll('button,input,select').forEach(function(node){if(value)node.dataset.wasDisabled=String(node.disabled);node.disabled=value||node.dataset.wasDisabled==='true';});}
  function open(task,discard){
    if(busy)return;if(dialog)close();active={key:task.key,revision:task.revision,baseline:editable(task)};var stored=null;
    if(discard)localStorage.removeItem(storageKey());else try{stored=JSON.parse(localStorage.getItem(storageKey())||'null');}catch(_){}
    if(stored){active.revision=stored.revision;active.baseline=stored.baseline||editable(task);}
    var initial=stored?.values||task;
    dialog=element('dialog',undefined,'panel-connector-dialog auxiliary-dialog');dialog.setAttribute('aria-label','编辑'+task.label);
    var head=element('div',undefined,'modal-head');head.append(element('h3',task.label));var cancel=element('button','×','modal-close');cancel.setAttribute('aria-label','关闭');cancel.onclick=close;head.append(cancel);
    var body=element('div',undefined,'modal-body'),form=element('form'),primary=element('div',undefined,'auxiliary-primary');entryFields(primary,initial,'main-');body.append(primary);
    if(task.credential_set)body.append(element('p','当前独立凭证已设置。保持配置不变会保留凭证；切换服务将使用新服务的凭证。'));
    body.append(input('调用超时（秒）','timeout',initial.timeout,'number'));
    if(task.key==='vision'){
      body.append(input('图片下载超时（秒）','download_timeout',initial.download_timeout,'number'),element('h4','回退顺序'));
      var chain=element('div',undefined,'auxiliary-chain');(initial.fallback_chain||[]).forEach(function(value){chain.append(fallback(value));});body.append(chain);
      var add=element('button','添加回退模型','action');add.type='button';add.onclick=function(){chain.append(fallback({provider:'custom'}));saveDraft();};body.append(add);
    }
    var feedback=element('div',stored?'已恢复未保存的草稿':'','auxiliary-feedback');feedback.setAttribute('role','status');body.append(feedback);
    var foot=element('div',undefined,'modal-foot'),reset=element('button','丢弃草稿并读取最新','action'),save=element('button','保存配置','action primary');reset.type='button';
    reset.onclick=async function(){
      if(!confirm('丢弃本次未保存输入，读取最新配置？'))return;setBusy(true);
      try{accept(await request());var selected=tasks.find(function(item){return item.key===task.key;});setBusy(false);close();open(selected,true);draw();}
      catch(error){feedback.textContent=error.message;setBusy(false);}
    };
    save.type='submit';foot.append(reset,save);form.append(body,foot);dialog.append(head,form);document.body.append(dialog);
    dialog.addEventListener('cancel',function(event){event.preventDefault();close();});form.oninput=saveDraft;form.onchange=saveDraft;
    form.onsubmit=async function(event){
      event.preventDefault();if(busy)return;saveDraft();var edits=values(),changes={};
      Object.keys(edits).forEach(function(key){if(JSON.stringify(edits[key])!==JSON.stringify(active.baseline[key]))changes[key]=edits[key];});
      setBusy(true);feedback.textContent='正在保存…';
      try{
        var result=await request('PATCH',{key:task.key,revision:active.revision,changes:changes});accept(result);localStorage.removeItem(storageKey());
        dialog.close();dialog.remove();dialog=null;active=null;draw();document.getElementById('auxiliaryStatus').textContent='已保存'+task.label+'配置';
      }catch(error){feedback.textContent=error.message+'；输入已保留。';}
      finally{if(dialog)setBusy(false);else busy=false;}
    };
    dialog.showModal();
  }
  document.getElementById('auxiliaryRefresh').onclick=window.loadAuxTasks;
}());
