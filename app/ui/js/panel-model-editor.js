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
  /* 2026-11-15：用户什么都没改就点保存，模型清单也会被整段重写 —— 有些服务的模型是
     纯字符串列表（`- deepseek-flash`），后端会把它展开成带 capabilities/context_window
     的完整字典，config.yaml 白白膨胀一大段。这里记住初始快照，没变就不提交这一项。 */
  var modelsSnapshot=JSON.stringify(models);
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
  advanced.append(n('summary','高级选项（上下文、超时、请求头、请求扩展参数）'));
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
  /* 请求扩展参数：内核把 providers.<id>.extra_body 原样并进请求体顶层，
     没有键名白名单，所以这里不提供"能力清单"式的假开关，只给一个 JSON 框 +
     几条把参数拼进去的快捷模板。能力属于哪家服务由参数本身决定，面板不认识厂商。 */
  var extraInput=document.createElement('textarea');extraInput.rows=6;extraInput.spellcheck=false;
  extraInput.placeholder='{"thinking":{"type":"enabled"}}';
  var extraField=label('请求扩展参数 JSON',extraInput,'pme-wide');
  extraField.append(n('span','原样并入请求体顶层（extra_body）。会覆盖请求结构的键（tools/messages/model/stream 等）被拒绝，其余不限厂商。','pme-hint'));
  advGrid.append(extraField);
  var presets=n('div',null,'pme-presets');
  presets.append(n('span','快捷并入：','pme-hint'));
  [['思考模式',{thinking:{type:'enabled'},reasoning_effort:'high'}],
   ['内容安全',{safety_check:{level:'high'}}],
   ['会话标题',{title:{enabled:true}}]].forEach(function(pair){
   presets.append(btn(pair[0],function(){
    var merged={};
    try{merged=extraInput.value.trim()?JSON.parse(extraInput.value):{};}catch(_){merged={};}
    Object.assign(merged,pair[1]);extraInput.value=JSON.stringify(merged,null,2);
    status.textContent='已并入「'+pair[0]+'」，点保存才写进配置。';
   },'pme-chip'));
  });
  advGrid.append(presets);
  advanced.append(advGrid,n('p','代理与全局并发是网关级设置，不是每家服务一份，这里不造假字段。','pme-hint'));
  form.append(advanced);

  /* ---- 推理参数（可见，不折叠）----
     2026-11-15：对着参考设计（模型卡组）看，每张卡都有 Temperature / 最大输出 / Top P
     滑块和「深度思考」开关，我们这边只把它埋在高级选项的 JSON 框里，等于没做。
     内核确实把 providers.<id>.extra_body 原样并进请求体顶层，这几个都是真参数，
     所以做成可见控件；但只有用户真动过（或配置里本来就有）才写盘，
     免得一保存就悄悄改掉生成行为。 */
  var TUNE_KEYS=['temperature','max_tokens','top_p','thinking'];
  var tuneDirty={temperature:false,max_tokens:false,top_p:false,thinking:false};
  var tuneCleared={temperature:false,max_tokens:false,top_p:false,thinking:false};
  var tuneSec=n('section',null,'pme-tune');
  tuneSec.append(n('h3','推理参数','pme-h3'),
    n('span','写进请求体，对这条服务下所有模型生效；不动就保持服务端默认','pme-hint inline'));
  var tuneGrid=n('div',null,'pme-grid');
  function tuneClearBtn(key,onClear){
   var b=btn('清除',function(){
    tuneCleared[key]=true;tuneDirty[key]=false;onClear();
    status.textContent='已标记清除「'+key+'」，点保存才写进配置。';
   },'pme-btn tiny ghost pme-tune-clear');
   b.type='button';b.setAttribute('aria-label','清除 '+key);
   return b;
  }
  function tuneSlider(title,key,min,max,step,defVal){
   var wrap=n('div',null,'pme-field pme-tune-item'),head=n('span',null,'pme-tune-head');
   var out=n('span','未设置','pme-tune-val');
   var hbox=n('span',null,'pme-tune-hbox');
   hbox.append(n('span',title,'pme-label'),out);
   head.append(hbox);
   var r=n('input');r.type='range';r.min=String(min);r.max=String(max);
   r.step=String(step);r.value=String(defVal);r.setAttribute('aria-label',title);
   r.oninput=function(){tuneDirty[key]=true;tuneCleared[key]=false;out.textContent=r.value;};
   head.append(tuneClearBtn(key,function(){out.textContent='未设置';}));
   wrap.append(head,r);tuneGrid.append(wrap);
   return {input:r,out:out};
  }
  var tempCtl=tuneSlider('Temperature','temperature',0,2,0.05,0.7);
  var topPCtl=tuneSlider('Top P','top_p',0,1,0.05,1);
  var maxWrap=n('div',null,'pme-field pme-tune-item');
  var maxHead=n('span',null,'pme-tune-head');
  var maxOut2=input('','number','8192');
  maxOut2.setAttribute('aria-label','最大输出 token');
  maxOut2.min='1';maxOut2.step='1';
  maxOut2.oninput=function(){tuneDirty.max_tokens=true;tuneCleared.max_tokens=false;};
  maxHead.append(n('span','最大输出 token','pme-label'),
    tuneClearBtn('max_tokens',function(){maxOut2.value='';}));
  maxWrap.append(maxHead,maxOut2);
  var thinkWrap=n('div',null,'pme-field pme-tune-item');
  var thinkSel=pick([['','不设置'],['enabled','开启'],['disabled','关闭']],'');
  thinkSel.setAttribute('aria-label','深度思考');
  thinkSel.onchange=function(){tuneDirty.thinking=true;tuneCleared.thinking=false;};
  thinkWrap.append(n('span','深度思考','pme-label'),thinkSel);
  tuneGrid.append(maxWrap,thinkWrap);
  tuneSec.append(tuneGrid);
  form.append(tuneSec);

  /* 已存的值回填：这几个键从 JSON 框里摘出来，交给控件，避免一处显示两处打架 */
  var extraRest={};
  if(provider&&provider.request_extra){
   Object.keys(provider.request_extra).forEach(function(k){
    if(TUNE_KEYS.indexOf(k)<0)extraRest[k]=provider.request_extra[k];
   });
   var re0=provider.request_extra;
   if(re0.temperature!=null){tempCtl.input.value=String(re0.temperature);tempCtl.out.textContent=String(re0.temperature);}
   if(re0.top_p!=null){topPCtl.input.value=String(re0.top_p);topPCtl.out.textContent=String(re0.top_p);}
   if(re0.max_tokens!=null){maxOut2.value=String(re0.max_tokens);}
   if(re0.thinking&&typeof re0.thinking==='object'&&re0.thinking.type)thinkSel.value=re0.thinking.type;
  }

  function tuneValues(){
   var out={};
   function on(key){
    if(tuneCleared[key])return false;
    return tuneDirty[key]||!!(provider&&provider.request_extra&&provider.request_extra[key]!=null);
   }
   if(on('temperature'))out.temperature=Number(tempCtl.input.value);
   if(on('top_p'))out.top_p=Number(topPCtl.input.value);
   if(on('max_tokens')&&maxOut2.value)out.max_tokens=Number(maxOut2.value);
   if(on('thinking')&&thinkSel.value)out.thinking={type:thinkSel.value};
   return out;
  }

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
   if(provider.request_extra&&Object.keys(provider.request_extra).length){
    /* 推理参数那四个键已经搬到可见控件，JSON 框只放剩下的，避免同一项两处显示 */
    if(Object.keys(extraRest).length){
     extraInput.value=JSON.stringify(extraRest,null,2);
     advanced.open=true;
    }
   }
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
   var extraRaw=extraInput.value.trim();
   var merged={};
   if(extraRaw){try{merged=JSON.parse(extraRaw);}catch(_){throw Error('请求扩展参数不是合法 JSON');}}
   /* 可见控件的值覆盖同名键；没动过的键不写，保持服务端默认 */
   var tv=tuneValues();
   Object.keys(tv).forEach(function(k){merged[k]=tv[k];});
   /* 推理参数这几个键是从 JSON 框里摘出去再补回来的，直接合并会把它们挪到末尾，
      看起来像改了一堆其实没改。按原有键序重排：老键保持原位，新键追加在后面。 */
   if(provider&&provider.request_extra){
    var base0=provider.request_extra,ordered={};
    Object.keys(base0).forEach(function(k){if(Object.prototype.hasOwnProperty.call(merged,k))ordered[k]=merged[k];});
    Object.keys(merged).forEach(function(k){if(!Object.prototype.hasOwnProperty.call(ordered,k))ordered[k]=merged[k];});
    merged=ordered;
   }
   var hadExtra=!!(provider&&provider.request_extra&&Object.keys(provider.request_extra).length);
   if(Object.keys(merged).length)out.request_extra=merged;
   else if(hadExtra)out.request_extra=null;
   return out;
  }

  async function submit(){
   saveBtn.disabled=true;status.textContent='正在保存…';
   try{
    var changes={name:nameInput.value.trim(),base_url:urlInput.value.trim(),api_mode:modeSelect.value};
    if(!changes.name)throw Error('填个名称');
    if(!changes.base_url)throw Error('填 Base URL');
    var key=keyInput.value.trim();
    changes.credential=key?{action:'replace',value:key}:{action:'keep'};
    var normalized=models.map(function(m){return {id:m.id,name:m.name||m.id,enabled:m.enabled!==false};});
    var modelsChanged=JSON.stringify(normalized)!==modelsSnapshot;
    /* 模型清单没动就不提交，避免把字符串列表膨胀成完整字典；默认模型跟着一起跳过 */
    if(isNew||modelsChanged){
     changes.models=normalized;
     var enabled=normalized.filter(function(m){return m.enabled;});
     if(enabled.length)changes.default_model=(provider&&provider.model&&enabled.some(function(m){return m.id===provider.model;}))?provider.model:enabled[0].id;
    }
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
