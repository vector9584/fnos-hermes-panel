/* 模型服务编辑器：卡片抽出来的配置页 / 添加服务，同一套表单。
   预设 = 主流厂商 + Base URL 跟随 + 只填 API Key；自定义 = 自己填地址 + 高级选项。 */
(function(){
 'use strict';

 var PRESETS=[
  {id:'deepseek',name:'DeepSeek',url:'https://api.deepseek.com/v1',mode:'chat_completions',hint:'官方直连，deepseek-chat / deepseek-reasoner'},
  {id:'openai',name:'OpenAI',url:'https://api.openai.com/v1',mode:'chat_completions',hint:'gpt / o 系列'},
  {id:'anthropic',name:'Anthropic',url:'https://api.anthropic.com',mode:'anthropic_messages',hint:'Claude 系列，走 Messages 协议'},
  {id:'openrouter',name:'OpenRouter',url:'https://openrouter.ai/api/v1',mode:'chat_completions',hint:'聚合站，一家 Key 通吃'},
  {id:'moonshot',name:'Moonshot 月之暗面',url:'https://api.moonshot.cn/v1',mode:'chat_completions',hint:'kimi 系列'},
  {id:'zhipu',name:'智谱 GLM',url:'https://open.bigmodel.cn/api/paas/v4',mode:'chat_completions',hint:'glm-4 系列'},
  {id:'qwen',name:'通义千问 DashScope',url:'https://dashscope.aliyuncs.com/compatible-mode/v1',mode:'chat_completions',hint:'qwen 系列，兼容模式'},
  {id:'gemini',name:'Google Gemini',url:'https://generativelanguage.googleapis.com/v1beta/openai',mode:'chat_completions',hint:'OpenAI 兼容端点'},
  {id:'xai',name:'xAI Grok',url:'https://api.x.ai/v1',mode:'chat_completions',hint:'grok 系列'},
  {id:'mistral',name:'Mistral',url:'https://api.mistral.ai/v1',mode:'chat_completions',hint:'mistral / codestral'},
  {id:'siliconflow',name:'硅基流动',url:'https://api.siliconflow.cn/v1',mode:'chat_completions',hint:'国内聚合，开源模型多'},
  {id:'volcengine',name:'火山方舟',url:'https://ark.cn-beijing.volces.com/api/v3',mode:'chat_completions',hint:'豆包系列，需填接入点 ID 作模型名'},
  {id:'custom',name:'自定义服务',url:'',mode:'chat_completions',hint:'自己填地址，可配代理超时等高级项'}
 ];

 var MODES=[['','由内核识别'],['chat_completions','Chat Completions'],['codex_responses','Responses'],['anthropic_messages','Anthropic Messages']];

 function n(tag,text,cls){var e=document.createElement(tag);if(text!=null)e.textContent=text;if(cls)e.className=cls;return e;}
 function btn(text,run,cls){var b=n('button',text,cls||'pme-btn');b.type='button';b.onclick=run;return b;}
 function row(cls){return n('div',null,cls||'pme-row');}
 function label(text,control,cls){var l=n('label',null,'pme-field'+(cls?' '+cls:''));l.append(n('span',text,'pme-label'),control);return l;}
 function input(value,type,placeholder){var i=n('input');i.type=type||'text';i.value=value==null?'':value;if(placeholder)i.placeholder=placeholder;return i;}
 function pick(options,value){var s=n('select');options.forEach(function(pair){var o=n('option',pair[1]);o.value=pair[0];s.append(o);});if(value!=null)s.value=value;return s;}

 async function post(path,body){
  var r=await fetch(apiUrl(path),{method:'POST',headers:{'Content-Type':'application/json','X-Monitor-Token':monitorToken||''},body:JSON.stringify(body),cache:'no-store'});
  var out=await r.json().catch(function(){return {};});
  if(!r.ok||out.ok===false)throw Error(out.error||('请求失败 '+r.status));
  return out;
 }

 function build(opts){
  opts=opts||{};
  var provider=opts.provider||null,isNew=!provider;
  var revision=opts.revision||'';
  var models=(provider&&provider.models?provider.models:[]).map(function(m){return {id:String(m.id),name:m.name||m.id,enabled:m.enabled!==false};});
  var form=n('form',null,'pme-form');form.noValidate=true;
  var status=n('p','','pme-status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');

  /* ---- 预设 / 自定义 ---- */
  var mode='preset',tabs=null;
  if(isNew){
   tabs=row('pme-tabs');
   var tabPreset=btn('预设服务商',function(){setMode('preset');},'pme-tab active');
   var tabCustom=btn('自定义服务',function(){setMode('custom');},'pme-tab');
   tabs.append(tabPreset,tabCustom);
   form.append(tabs);
  }

  var presetWrap=row('pme-row-split');
  var presetSelect=pick([['','请选择服务商']].concat(PRESETS.map(function(p){return [p.id,p.name];})),provider?'':(opts.presetId||''));
  var presetField=label('服务商',presetSelect);
  var nameInput=input(provider?provider.name:'',null,'例如 DeepSeek 官方');
  var nameField=label('名称',nameInput);
  presetWrap.append(presetField,nameField);
  form.append(presetWrap);

  var urlWrap=row('pme-row-split');
  var urlInput=input(provider?provider.base_url:'',null,'https://api.example.com/v1');
  var urlField=label('Base URL',urlInput);
  var modeSelect=pick(MODES,provider?(provider.api_mode||''):'chat_completions');
  var modeField=label('接口协议',modeSelect);
  urlWrap.append(urlField,modeField);
  form.append(urlWrap);

  var keyWrap=row('pme-row-split');
  var keyInput=input('','password',provider&&provider.api_key_configured?'已保存密钥，留空即不修改':'sk-...');
  keyInput.autocomplete='new-password';
  var keyField=label('API Key',keyInput);
  var fetchBtn=btn('获取模型',function(){fetchModels();},'pme-btn primary');
  var fetchWrap=row('pme-fetch');fetchWrap.append(fetchBtn);
  keyWrap.append(keyField,fetchWrap);
  form.append(keyWrap);

  var presetHint=n('p','','pme-hint');
  form.append(presetHint);
  if(!isNew){presetField.style.display='none';presetHint.style.display='none';}

  function applyPreset(){
   var found=PRESETS.filter(function(x){return x.id===presetSelect.value;})[0];
   if(!found)return;
   presetHint.textContent=found.hint||'';
   if(found.url)urlInput.value=found.url;
   if(found.mode)modeSelect.value=found.mode;
   if(!nameInput.value.trim())nameInput.value=found.name==='自定义服务'?'':found.name;
   if(found.id==='custom'){setMode('custom');}
   urlInput.placeholder=found.url||'https://api.example.com/v1';
  }
  presetSelect.onchange=applyPreset;
  if(isNew)applyPreset();

  function setMode(next){
   mode=next;
   if(tabs){
    tabs.children[0].classList.toggle('active',next==='preset');
    tabs.children[1].classList.toggle('active',next==='custom');
   }
   presetField.style.display=next==='preset'?'':'none';
   presetHint.style.display=next==='preset'?'':'none';
   advanced.open=next==='custom';
   urlField.classList.toggle('pme-strong',next==='custom');
   if(next==='custom'&&presetSelect.value&&presetSelect.value!=='custom'){presetSelect.value='';presetHint.textContent='自定义：地址与协议都由你决定';}
  }

  /* ---- 获取模型 ---- */
  var discovered=[];
  var discoverBox=n('div',null,'pme-discover');discoverBox.hidden=true;
  var discoverList=n('div',null,'pme-discover-list');
  var discoverBar=row('pme-discover-bar');
  var addPicked=btn('加入已勾选',function(){addDiscovered();},'pme-btn primary');
  var clearPicked=btn('全不选',function(){discovered.forEach(function(x){x.picked=false;});drawDiscover();});
  discoverBar.append(n('span','','pme-discover-count'),clearPicked,addPicked);
  discoverBox.append(discoverList,discoverBar);
  form.append(discoverBox);

  async function fetchModels(){
   fetchBtn.disabled=true;status.textContent='正在查询服务模型列表…';
   try{
    var body={action:'discover',base_url:urlInput.value.trim(),api_mode:modeSelect.value};
    var key=keyInput.value.trim();
    if(key)body.api_key=key;
    else if(provider&&provider.api_key_configured){body.provider_id=provider.id;body.model=provider.model||'';body.use_saved_credential=true;}
    else throw Error('先填 API Key 再获取模型');
    var out=await post('/api/panel-models',body);
    var known={};models.forEach(function(m){known[m.id]=true;});
    discovered=(out.models||[]).map(function(m){return {id:String(m.id),name:m.name||String(m.id),picked:!known[String(m.id)]};});
    discoverBox.hidden=!discovered.length;
    drawDiscover();
    status.textContent=discovered.length?'获取到 '+discovered.length+' 个模型，勾选后加入清单':(out.error||'该服务没有返回可用模型');
   }catch(e){status.textContent=e.message;}
   finally{fetchBtn.disabled=false;}
  }
  function drawDiscover(){
   discoverList.replaceChildren();
   discovered.forEach(function(item){
    var lab=n('label',null,'pme-discover-item');
    var box=n('input');box.type='checkbox';box.checked=!!item.picked;
    box.onchange=function(){item.picked=box.checked;countPicked();};
    lab.append(box,n('code',item.id),n('span',item.name&&item.name!==item.id?item.name:'','pme-discover-name'));
    lab.append(btn('测试',function(ev){ev.preventDefault();testModel(item.id,lab);},'pme-btn tiny'));
    discoverList.append(lab);
   });
   countPicked();
  }
  function countPicked(){
   var c=discovered.filter(function(x){return x.picked;}).length;
   discoverBar.querySelector('.pme-discover-count').textContent='已勾选 '+c+' 个';
   addPicked.disabled=!c;
  }
  function addDiscovered(){
   var picked=discovered.filter(function(x){return x.picked;});
   if(!picked.length)return;
   picked.forEach(function(found){
    var exist=models.filter(function(m){return m.id===found.id;})[0];
    if(exist){exist.enabled=true;if(!exist.name||exist.name===exist.id)exist.name=found.name;}
    else models.push({id:found.id,name:found.name||found.id,enabled:true});
   });
   discovered=discovered.filter(function(x){return !x.picked;});
   drawDiscover();drawModels();
   status.textContent='已加入 '+picked.length+' 个模型；记得在清单里核对要启用的项';
  }

  /* ---- 模型清单 ---- */
  var listHead=row('pme-section-head');
  listHead.append(n('h3','模型清单','pme-h3'),n('span','勾选=启用；点「测试」真发一条请求','pme-hint inline'));
  form.append(listHead);
  var modelList=n('div',null,'pme-models');
  form.append(modelList);
  var addRow=row('pme-add-row');
  var newId=input('',null,'手动添加模型 ID');
  addRow.append(label('模型 ID',newId),btn('添加',function(){
   var id=newId.value.trim();
   if(!id)return;
   if(models.some(function(m){return m.id===id;})){status.textContent='这个模型已在清单里';return;}
   models.push({id:id,name:id,enabled:true});newId.value='';drawModels();
  }));
  form.append(addRow);

  function drawModels(){
   modelList.replaceChildren();
   if(!models.length){modelList.append(n('p','还没有模型。先「获取模型」，或手动填一个 ID。','pme-empty'));return;}
   models.forEach(function(m,index){
    var r=row('pme-model');
    var on=n('input');on.type='checkbox';on.checked=m.enabled!==false;
    on.onchange=function(){m.enabled=on.checked;};
    var nameBox=input(m.name===m.id?'':m.name,null,'显示名（留空就用 ID）');
    nameBox.oninput=function(){m.name=nameBox.value.trim()||m.id;};
    var testState=n('span','','pme-test-state');
    r.append(label('',on,'pme-check'),n('code',m.id,'pme-model-id'),nameBox,testState,
      btn('测试',function(){testModel(m.id,r);},'pme-btn tiny'),
      btn('移出',function(){models.splice(index,1);drawModels();},'pme-btn tiny danger'));
    modelList.append(r);
   });
  }
  drawModels();

  async function testModel(id,host){
   var state=host.querySelector('.pme-test-state')||status;
   state.textContent='测试中…';state.className='pme-test-state running';
   try{
    var body={base_url:urlInput.value.trim(),model:id,api_mode:modeSelect.value};
    var key=keyInput.value.trim();
    if(key)body.api_key=key;
    else if(provider){body.provider_id=provider.id;}
    var out=await post('/api/panel-models/probe',body);
    state.textContent='通 · '+(out.latency_ms/1000).toFixed(1)+'s';
    state.className='pme-test-state ok';
   }catch(e){state.textContent='失败：'+e.message;state.className='pme-test-state bad';}
  }

  /* ---- 高级选项 ---- */
  var advanced=n('details',null,'pme-advanced');
  advanced.append(n('summary','高级选项（上下文、超时、请求头）'));
  var advGrid=n('div',null,'pme-grid');
  function numField(title,value,placeholder,hint){
   var i=input(value==null?'':value,'number',placeholder);i.min='0';i.step='any';
   var f=label(title,i);if(hint)f.append(n('span',hint,'pme-hint'));
   advGrid.append(f);return i;
  }
  var ctxLength=numField('上下文长度',''  ,'128000','模型能吃多少 token，只作记录与预算');
  var maxOut=numField('单次输出上限','','8192','写进 max_output_tokens');
  var timeout=numField('请求超时（秒）','','120','超过就断开，避免挂死');
  var gap=numField('请求间隔（秒）','','0','两次调用最小间隔，相当于限速');
  var sslField=label('SSL 校验',pick([['','默认校验'],['1','强制校验'],['0','跳过校验（自签证书）']],''));
  advGrid.append(sslField);
  var headerInput=input('',null,'{"X-Api-Version":"2024-01"}');
  var headerField=label('额外请求头 JSON',headerInput,'pme-wide');
  advGrid.append(headerField);
  advanced.append(advGrid,n('p','代理与全局并发是网关级设置，不是每家服务一份，这里不造假字段。','pme-hint'));
  form.append(advanced);

  /* 预填已有服务的字段 */
  if(provider){
   var extra=provider.extra||{};
   if(extra.context_length!=null)ctxLength.value=extra.context_length;
   if(extra.max_output_tokens!=null)maxOut.value=extra.max_output_tokens;
   if(extra.request_timeout_seconds!=null)timeout.value=extra.request_timeout_seconds;
   if(extra.rate_limit_delay!=null)gap.value=extra.rate_limit_delay;
   if(extra.ssl_verify===false)sslField.querySelector('select').value='0';
   else if(extra.ssl_verify===true)sslField.querySelector('select').value='1';
   if(provider.header_keys&&provider.header_keys.length)headerInput.placeholder='已配置 '+provider.header_keys.join('、')+'（留空不修改）';
  }

  form.append(status);

  /* ---- 底部按钮 ---- */
  var actions=row('pme-actions');
  var saveBtn=btn(isNew?'保存并添加服务':'保存配置',function(){submit();},'pme-btn primary');
  actions.append(saveBtn);
  if(!isNew){
   actions.append(btn(provider.enabled?'停用服务':'启用服务',function(){toggleProvider();},'pme-btn'));
  }
  actions.append(btn('取消',function(){opts.close&&opts.close();},'pme-btn ghost'));
  form.append(actions);

  form.addEventListener('submit',function(e){e.preventDefault();submit();});

  function readAdvanced(){
   var out={};
   if(ctxLength.value)out.context_length=Number(ctxLength.value);
   if(maxOut.value)out.max_output_tokens=Number(maxOut.value);
   if(timeout.value)out.request_timeout_seconds=Number(timeout.value);
   if(gap.value)out.rate_limit_delay=Number(gap.value);
   var ssl=sslField.querySelector('select').value;
   if(ssl==='0')out.ssl_verify=false;else if(ssl==='1')out.ssl_verify=true;
   var raw=headerInput.value.trim();
   if(raw){try{out.headers_json=JSON.parse(raw);}catch(_){throw Error('额外请求头不是合法 JSON');}}
   return out;
  }

  async function submit(){
   saveBtn.disabled=true;status.textContent='正在保存…';
   try{
    var changes={name:nameInput.value.trim(),base_url:urlInput.value.trim(),api_mode:modeSelect.value,
      models:models.map(function(m){return {id:m.id,name:m.name||m.id,enabled:m.enabled!==false};})};
    if(!changes.name)throw Error('填个名称');
    if(!changes.base_url)throw Error('填 Base URL');
    var key=keyInput.value.trim();
    changes.credential=key?{action:'replace',value:key}:{action:'keep'};
    var enabled=changes.models.filter(function(m){return m.enabled;});
    if(enabled.length)changes.default_model=(provider&&provider.model&&enabled.some(function(m){return m.id===provider.model;}))?provider.model:enabled[0].id;
    Object.assign(changes,readAdvanced());
    var body=isNew?{action:'create',revision:revision,changes:changes}
                  :{action:'update',id:provider.id,revision:revision,changes:changes};
    var out=await post('/api/panel-models',body);
    status.textContent='已保存'+(out.changed===false?'（内容没有变化）':'');
    opts.onSaved&&opts.onSaved(out);
    if(out.changed!==false)opts.close&&opts.close();
   }catch(e){status.textContent=e.message;saveBtn.disabled=false;}
  }
  async function toggleProvider(){
   try{
    var out=await post('/api/panel-models',{action:'toggle',id:provider.id,enabled:!provider.enabled,revision:revision});
    opts.onSaved&&opts.onSaved(out);opts.close&&opts.close();
   }catch(e){status.textContent=e.message;}
  }

  return form;
 }

 window.PanelModelEditor={PRESETS:PRESETS,build:build};
})();
