(function(){
 'use strict';
 var grid=document.getElementById('providerGrid');if(!grid)return;
 var data=null,last=null;try{last=JSON.parse(localStorage.getItem('panel-model-change')||'null');}catch(_){}
 function n(tag,text,cls){var e=document.createElement(tag);if(text!=null)e.textContent=text;if(cls)e.className=cls;return e;}
 function button(text,run,cls){var e=n('button',text,cls||'btn');e.type='button';e.onclick=run;return e;}
 var feedback=n('p','','maintenance-feedback'),routes=n('section',null,'panel-model-routes'),moaState=null,moaRead=null;feedback.setAttribute('role','status');var fbSlot=document.getElementById('providerFeedbackSlot'),rtSlot=document.getElementById('modelRoutesSlot');(fbSlot||grid).append(feedback);(rtSlot||grid).append(routes);
 async function api(body){var r=await fetch(apiUrl('/api/panel-models'),{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Monitor-Token':monitorToken||''},body:body?JSON.stringify(body):undefined,cache:'no-store'}),out=await r.json();if(!r.ok||!out.ok){var error=Error(out.error||'模型配置操作失败');error.status=r.status;throw error;}return out;}
 function accept(out){data=out;_cfg.providers=out.providers.filter(p=>p.enabled);_cfg.primary=out.primary;_cfg.active_provider=out.active_provider;_cfg.fallback_providers=out.fallback_providers;window.__hermesConfigured=out.hermes_configured;renderConfigBanner();_syncModelBtn();}
 function remember(out){if(out.change_id){last={id:out.change_id,revision:out.revision};try{localStorage.setItem('panel-model-change',JSON.stringify(last));}catch(_){}}window.panelRuntimeRefresh?.();}
 async function mutate(body){var out=await api({...body,revision:data.revision});remember(out);accept(out);render();feedback.textContent=out.changed?'配置已保存，待重启应用生效':'配置没有变化';return out;}
 function primaryNow(){var p=data.primary||{};return [String(p.provider||'').replace(/^custom:/,''),String(p.model||'')];}
 function sameTarget(item,pair){return String(item.provider||'').replace(/^custom:/,'')===pair[0]&&String(item.model||'')===pair[1];}
 function routeEntries(list){return (list||[]).map(function(x){return {key:x.key,provider:x.provider,model:x.model};});}
 async function saveRoutes(provider,model,entries,okText){
  feedback.textContent='正在保存路线…';
  try{
   var out=await api({action:'routes',provider:provider,model:model,entries:entries,revision:data.revision});
   remember(out);accept(out);render();
   feedback.textContent=out.changed?((okText||'路线已保存')+'；待重启应用生效'):(okText||'路线没有变化');
  }catch(e){
   if(e.status===409){feedback.textContent='模型配置刚在别处被改过，已刷新成最新版本；请再操作一次';await load();return;}
   feedback.textContent=e.message;try{render();}catch(_){}
  }
 }
 function commitOrder(list){var pr=primaryNow();saveRoutes(pr[0],pr[1],routeEntries(list),'回退顺序已调整');}
 function bindDrag(chain){
  var dragging=null,startOrder=[];
  function rows(){return [...chain.querySelectorAll('li')];}
  function rowAt(y){var hit=null;rows().forEach(function(li){var r=li.getBoundingClientRect();if(y>=r.top&&y<=r.bottom)hit=li;});return hit;}
  function onMove(e){
   if(!dragging)return;
   e.preventDefault();
   var over=rowAt(e.clientY);
   if(!over||over===dragging)return;
   var r=over.getBoundingClientRect();
   if(e.clientY>r.top+r.height/2)over.after(dragging);else over.before(dragging);
  }
  function finish(){
   if(!dragging)return;
   var el=dragging;dragging=null;
   el.classList.remove('is-dragging');
   document.removeEventListener('pointermove',onMove);
   document.removeEventListener('pointerup',finish);
   document.removeEventListener('pointercancel',finish);
   var list=rows(),order=list.map(function(li){return li.dataset.key;});
   if(order.join('|')===startOrder.join('|'))return;
   commitOrder(list.map(function(li){return JSON.parse(li.dataset.item);}));
  }
  chain.querySelectorAll('.route-handle').forEach(function(handle){
   handle.addEventListener('pointerdown',function(e){
    if(e.button&&e.button!==0)return;
    e.preventDefault();
    dragging=handle.closest('li');
    startOrder=rows().map(function(li){return li.dataset.key;});
    dragging.classList.add('is-dragging');
    if(handle.setPointerCapture)try{handle.setPointerCapture(e.pointerId);}catch(_){}
    document.addEventListener('pointermove',onMove,{passive:false});
    document.addEventListener('pointerup',finish);
    document.addEventListener('pointercancel',finish);
   });
   handle.addEventListener('keydown',function(e){
    if(e.key!=='ArrowUp'&&e.key!=='ArrowDown')return;
    e.preventDefault();
    var li=handle.closest('li'),list=rows(),i=list.indexOf(li),j=i+(e.key==='ArrowUp'?-1:1);
    if(j<0||j>=list.length)return;
    if(e.key==='ArrowUp')list[j].before(li);else list[j].after(li);
    handle.focus();
    commitOrder(rows().map(function(x){return JSON.parse(x.dataset.item);}));
   });
  });
 }
 function removeChain(index){
  var list=data.fallbacks.slice(),gone=data.fallbacks[index];
  list.splice(index,1);
  var pr=primaryNow();
  saveRoutes(pr[0],pr[1],routeEntries(list),'已把 '+gone.model+' 移出回退');
 }
 function addChain(provider,model){
  var pr=primaryNow();
  if(provider===pr[0]&&model===pr[1]){feedback.textContent='主模型不能同时当回退';return;}
  var list=data.fallbacks.slice();list.push({provider:provider,model:model});
  saveRoutes(pr[0],pr[1],routeEntries(list),'已把 '+model+' 加到回退末尾');
 }
 async function load(){feedback.textContent='正在读取模型服务…';try{accept(await api());render();feedback.textContent='已读取 '+data.providers.length+' 个模型服务';}catch(e){feedback.textContent=e.message;grid.replaceChildren(button('重新读取',load));}}
 /* 模型卡片测试：复用 /api/panel-models/checks 验证作业，落到单个模型粒度 */
 async function checkReq(path,method,body){var r=await fetch(apiUrl('/api/panel-models/'+path),{method:method||'GET',headers:{'Content-Type':'application/json','X-Monitor-Token':monitorToken||''},body:body?JSON.stringify(body):undefined,cache:'no-store'}),out=await r.json();if(!r.ok||!out.ok)throw Error(out.error||'验证请求失败');return out;}
 async function runCheck(provider,model,res,btn){
  btn.disabled=true;res.className='model-chip-result pending';res.textContent='测试中…';
  try{
   if(typeof fetchToken==='function')await fetchToken();
   var request_id='chip-'+Date.now()+'-'+Math.random().toString(36).slice(2),out=await checkReq('checks','POST',{provider:provider,model:model,request_id:request_id});
   var id=(out.check&&out.check.id)||out.id;if(!id)throw Error('验证作业没有返回编号');
   var deadline=Date.now()+120000,job=null;
   while(Date.now()<deadline){
    await new Promise(function(done){setTimeout(done,1200);});
    var list=await checkReq('checks'),all=(list.checks||[]);
    job=all.find(function(item){return item.id===id;});
    if(job&&job.status!=='running')break;
   }
   if(!job)throw Error('验证结果读取超时，稍后可在验证记录里查看');
   if(job.status==='done'&&job.result){res.className='model-chip-result ok';res.textContent='✓ '+(job.result.latency_ms/1000).toFixed(1)+'s';res.title=(job.result.output||'').slice(0,300);}
   else{res.className='model-chip-result fail';res.textContent='✗ '+(job.status==='done'?'未通过':(job.error||'验证失败')).slice(0,40);res.title=job.error||'';}
  }catch(error){res.className='model-chip-result fail';res.textContent='✗ '+String(error.message||error).slice(0,40);res.title=String(error.message||error);}
  finally{btn.disabled=false;}
 }
 function modelChips(p){
  var picked=p.models.filter(function(m){return m.enabled;}),box=n('div',null,'model-chip-list');
  if(!picked.length){box.append(n('p','这个服务还没有启用的模型，点“编辑服务”添加','pw-hint'));return box;}
  var limit=12,more=picked.length>limit,shown=more?picked.slice(0,limit):picked;
  shown.forEach(function(m){
   var chip=n('div',null,'model-chip'),res=n('span',null,'model-chip-result'),btn=button('测试',null,'model-chip-test');
   btn.onclick=function(){runCheck(p.id,m.id,res,btn);};
   chip.append(n('span',m.id,'model-chip-id'),res,btn);box.append(chip);
  });
  if(more)box.append(n('p','另有 '+(picked.length-limit)+' 个模型未列出，可在“验证记录”里逐个选择','pw-hint'));
  return box;
 }
 function label(provider){return data.providers.find(p=>p.id===provider.replace(/^custom:/,''))?.name||provider;}
 function routeFor(provider,model){
  var id=String(provider||'').replace(/^custom:/,'');
  if(data.primary&&String(data.primary.provider||'').replace(/^custom:/,'')===id&&data.primary.model===model)return '全局主模型';
  var index=(data.fallbacks||[]).findIndex(item=>String(item.provider||'').replace(/^custom:/,'')===id&&item.model===model);
  return index<0?'':('失败回退第 '+(index+1)+' 项');
 }
 async function loadMoa(){
  if(!moaState)return;
  try{moaRead=await api({action:'moa_read'});}catch(e){moaState.textContent='MOA 状态读取失败：'+e.message;return;}
  var presets=moaRead.presets||[],preset=presets.find(p=>p.name===(moaRead.enabled?moaRead.active_preset:moaRead.default_preset))||presets[0]||null;
  moaState.replaceChildren();
  if(moaRead.enabled)moaState.append(n('p','已开启 · 预设 '+(moaRead.active_preset||'?')+' · 参考 '+(preset?preset.reference_models.length:0)+' 个模型 · 聚合 '+(preset?label(preset.aggregator.provider)+' / '+preset.aggregator.model:'未设置'),'model-primary'));
  else moaState.append(n('p',presets.length?'未开启（已存 '+presets.length+' 个预设，随时能开）':'未开启，也还没有预设 —— 现在只走①里的单个主模型','model-primary'));
  if(preset&&preset.reference_models.length)moaState.append(n('p','参考模型：'+preset.reference_models.map(r=>label(r.provider)+' / '+r.model).join('；'),'pw-hint'));
  if(preset&&preset.aggregator.provider)moaState.append(n('p','聚合模型：'+label(preset.aggregator.provider)+' / '+preset.aggregator.model,'pw-hint'));
  if(moaRead.previous_primary&&moaRead.previous_primary.provider)moaState.append(n('p','关掉后回到：'+label(moaRead.previous_primary.provider)+' / '+moaRead.previous_primary.model,'pw-hint'));
  if(preset)moaState.append(button(moaRead.enabled?'关闭 MOA':'开启这个预设',async function(){this.disabled=true;try{await api({action:'moa_save',revision:moaRead.moa_revision,enabled:!moaRead.enabled,preset:preset.name,reference_models:preset.reference_models.map(r=>({provider:r.provider,model:r.model})),aggregator:{provider:preset.aggregator.provider,model:preset.aggregator.model}});await load();}catch(e){feedback.textContent=e.message;this.disabled=false;}}));
  else moaState.append(button('配置 MOA',()=>moaDialog()));
 }
 function moaDialog(){
  if(!moaRead||!moaRead.candidates){feedback.textContent='MOA 数据还没读回来，稍等一下再点';return;}
  var d=dialog('配置 MOA 混合'),presets=moaRead.presets||[],target=presets.find(p=>p.name===(moaRead.enabled?moaRead.active_preset:moaRead.default_preset))||presets[0]||null;
  var nameField=n('label',null,'field'),nameInput=n('input');nameInput.type='text';nameInput.maxLength=40;nameInput.value=target?target.name:(moaRead.default_preset||'default');nameField.append(n('span','预设名称（字母、数字、下划线）'),nameInput);
  var picked={};if(target)(target.reference_models||[]).forEach(r=>{picked[r.provider+'|'+r.model]=true;});
  var refBox=n('div',null,'moa-refs');
  moaRead.candidates.forEach(function(provider){
   var group=n('div',null,'moa-ref-group');group.append(n('strong',provider.name));
   provider.models.forEach(function(model){
    var row=n('label',null,'moa-ref-row'),box=n('input');box.type='checkbox';box.value=JSON.stringify([provider.id,model.id]);box.checked=!!picked[provider.id+'|'+model.id];
    box.onchange=function(){var total=refBox.querySelectorAll('input:checked').length;if(box.checked&&total>8){box.checked=false;d.status.textContent='参考模型最多 8 个';}else d.status.textContent='';};
    row.append(box,n('span',model.name));group.append(row);
   });
   refBox.append(group);
  });
  var aggOptions=[];moaRead.candidates.forEach(p=>p.models.forEach(m=>aggOptions.push([JSON.stringify([p.id,m.id]),p.name+' / '+m.name])));
  var aggValue=target&&target.aggregator.provider?JSON.stringify([target.aggregator.provider,target.aggregator.model]):'';
  d.body.append(nameField,n('p','参考模型：1 到 8 个，每个都会独立答一遍，会多花几倍 token。','pw-hint'),refBox);
  var agg=select(d.body,'聚合模型（最后把这些答案合成一个）',aggOptions,aggValue);
  var onRow=n('label',null,'moa-ref-row'),onBox=n('input');onBox.type='checkbox';onBox.checked=!!moaRead.enabled;onRow.append(onBox,n('span','保存后立即启用（主模型切成 moa / 这个预设名）'));d.body.append(onRow);
  var save=button('保存 MOA 设置',async function(){
   save.disabled=true;d.status.textContent='';
   try{
    var refs=[...refBox.querySelectorAll('input:checked')].map(b=>{var q=JSON.parse(b.value);return {provider:q[0],model:q[1]};});
    if(!refs.length)throw Error('至少选一个参考模型');
    if(!agg.value)throw Error('请选择聚合模型');
    var chosen=JSON.parse(agg.value);
    var out=await api({action:'moa_save',revision:moaRead.moa_revision,enabled:onBox.checked,preset:nameInput.value.trim(),reference_models:refs,aggregator:{provider:chosen[0],model:chosen[1]}});
    d.status.textContent=out.changed?'已保存，重启应用后新配置才生效':'没有变化';await load();if(out.changed)setTimeout(()=>d.close(),700);
   }catch(e){d.status.textContent=e.message;}finally{save.disabled=false;}
  });
  d.actions.append(save);
 }
 var deckState=null;
 function render(){
  routes.replaceChildren();
  var modelChoices=[];
  data.providers.forEach(function(p){if(!p.enabled)return;p.models.forEach(function(m){if(m.enabled)modelChoices.push([JSON.stringify([p.id,m.id]),m.id+'（'+p.name+'）']);});});
  var primaryPair=primaryNow(),primaryValue=primaryPair[1]?JSON.stringify(primaryPair):'';

  function deckAccent(seed){
   var palette=[[226,193,132],[122,162,247],[120,200,160],[180,150,245],[235,145,120],[110,200,225]];
   var h=0;String(seed||'').split('').forEach(function(c){h=(h*31+c.charCodeAt(0))%9973;});
   return palette[h%palette.length].join(' ');
  }
  function deckBrand(seed){
   var palette=[[186,156,255],[126,214,240],[244,176,140],[150,196,250],[224,160,240],[132,214,180]];
   var h=0;String(seed||'').split('').forEach(function(c){h=(h*37+c.charCodeAt(0))%7919;});
   return palette[h%palette.length].join(' ');
  }
  function deckEmblemWrap(name){
   var wrap=n('span',null,'mdeck-emblem'),svg=document.createElementNS('http://www.w3.org/2000/svg','svg'),txt=document.createElementNS('http://www.w3.org/2000/svg','text');
   svg.setAttribute('viewBox','0 0 100 100');
   txt.setAttribute('x','50');txt.setAttribute('y','52');txt.setAttribute('text-anchor','middle');txt.setAttribute('dominant-baseline','middle');
   txt.setAttribute('font-size','36');txt.setAttribute('font-weight','700');txt.setAttribute('fill','currentColor');
   txt.textContent=String(name||'?').trim().slice(0,2).toUpperCase();
   svg.append(txt);wrap.append(n('span',null,'mdeck-emblem-glow'),svg);return wrap;
  }
  function deckTags(list){
   var box=n('span',null,'mdeck-tags');
   (list||[]).forEach(function(t){if(t)box.append(n('span',t));});
   return box;
  }

  /* —— 抽卡：卡片只留卡面，点一下长成配置页 —— */
  function deckClose(){
   if(!deckState)return;
   var st=deckState;deckState=null;
   document.removeEventListener('keydown',st.esc);
   if(st.card)st.card.style.visibility='';
   st.veil.style.transition='opacity .16s ease';
   st.veil.style.opacity='0';
   st.sheet.style.transition='opacity .16s ease,transform .2s ease';
   st.sheet.style.transform='translateY(8px) scale(.99)';
   setTimeout(function(){st.veil.remove();},190);
  }
  /* 飞行卡就是那张卡本身 —— 同一份卡面内容、同一个样式作用域。
     2026-11-13 修：旧版把 .mdeck-emblem/.mdeck-name… 全设 opacity:0 再挂到 body 下，
     既丢了 #providerGrid 选择器作用域、又掏空了卡面，飞行期间只剩一个灰矩形；
     配上第一帧就压满的幕布，观感就是「先灰一片、再一坨东西闪出来」。
     现在：只做位移 + 末段淡出，卡面完整地飞过去，配置页在它身下同时淡入。 */
  function deckMorph(cardEl,sheet,toRect){
   var from=cardEl.getBoundingClientRect();
   var to=toRect||sheet.getBoundingClientRect();
   var ghost=cardEl.cloneNode(true);
   ghost.removeAttribute('tabindex');ghost.setAttribute('aria-hidden','true');
   ghost.classList.add('mdeck-ghost');
   var g=ghost.style;
   g.position='fixed';g.margin='0';g.pointerEvents='none';g.zIndex='1002';
   g.left=from.left+'px';g.top=from.top+'px';g.width=from.width+'px';g.height=from.height+'px';
   g.borderRadius='18px';g.transformOrigin='center center';
   g.transition='transform .44s cubic-bezier(.22,.75,.2,1),opacity .2s ease .24s';
   document.body.append(ghost);   /* 挂 body：网格会被重绘清空（实测 232ms 连根拔掉），veil 渐入会把卡面压暗 */
   cardEl.style.visibility='hidden';   /* 飞行卡顶替原卡，避免分身重影 */
   var dx=(to.left+to.width/2)-(from.left+from.width/2);
   var dy=(to.top+to.height/2)-(from.top+from.height/2);
   requestAnimationFrame(function(){
    g.transform='translate('+dx.toFixed(1)+'px,'+dy.toFixed(1)+'px)';g.opacity='0';
    setTimeout(function(){ghost.remove();cardEl.style.visibility='';},620);
   });
  }
  function deckFoot(st){
   var foot=st.foot;if(!foot)return;
   foot.replaceChildren(n('span','关掉这一页不会丢已保存的配置','mdeck-foot-label'));
  }
  function deckPaint(){if(!deckState)return;deckState.bodyWrap.replaceChildren(deckState.spec.build());deckFoot(deckState);}
  function deckOpen(cardEl,spec){
   deckClose();
   var veil=n('div',null,'mdeck-veil'),sheet=n('article',null,'mdeck-sheet');
   sheet.style.setProperty('--accent',spec.accent);
   sheet.setAttribute('role','dialog');sheet.setAttribute('aria-modal','true');sheet.setAttribute('aria-label',spec.title);
   var head=n('div',null,'mdeck-sheet-head'),ident=n('div',null,'mdeck-sheet-ident');
   var closeBtn=button('✕',function(){deckClose();},'mdeck-sheet-close');closeBtn.setAttribute('aria-label','关闭配置页');
   var titleBox=n('div',null,'mdeck-sheet-title');
   titleBox.append(n('span',spec.title,'mdeck-sheet-name'),n('span',spec.sheetSub||spec.sub,'mdeck-sheet-sub'),deckTags(spec.tags));
   ident.append(deckEmblemWrap(spec.emblem),titleBox);
   head.append(ident,closeBtn);
   var bodyWrap=n('div',null,'mdeck-sheet-body');bodyWrap.append(spec.build());
   var foot=n('div',null,'mdeck-sheet-foot');
   foot.append(n('span','配置工具','mdeck-foot-label'));
   var reloadBtn=button('重新读取配置',function(){deckClose();load();},'btn');
   reloadBtn.title='从磁盘重读当前配置；页面里没保存的改动会被丢弃';
   foot.append(reloadBtn);
   if(last){
    var undoBtn=button('撤销上次修改',function(){var b=this;b.disabled=true;mutate({action:'restore',change_id:last.id}).then(function(){deckClose();}).catch(function(e){feedback.textContent=e.message;b.disabled=false;});},'btn');
    undoBtn.title='把上一次保存的改动整体还原';
    foot.append(undoBtn);
   }
   sheet.append(head,bodyWrap,foot);
   veil.append(sheet);document.body.append(veil);
   /* 先拿干净几何（transform 会污染 getBoundingClientRect），再设起始态 */
   var toRect=sheet.getBoundingClientRect();
   sheet.style.opacity='0';sheet.style.transform='translateY(10px) scale(.985)';
   veil.style.opacity='0';
   deckMorph(cardEl,sheet,toRect);
   requestAnimationFrame(function(){
    veil.style.opacity='1';
    sheet.style.transition='opacity .3s ease .06s,transform .44s cubic-bezier(.22,.75,.2,1)';
    sheet.style.opacity='1';sheet.style.transform='none';
    sheet.classList.add('mdeck-in');
   });
   var esc=function(e){if(e.key==='Escape'){e.preventDefault();deckClose();}};
   document.addEventListener('keydown',esc);
   veil.addEventListener('click',function(e){if(e.target===veil)deckClose();});
   deckState={veil:veil,sheet:sheet,bodyWrap:bodyWrap,foot:foot,spec:spec,card:cardEl,esc:esc};
  deckFoot(deckState);
   setTimeout(function(){var f=sheet.querySelector('select,.mdeck-sheet-body button');f&&f.focus();},520);
  }
  function deckCard(spec){
   var el=n('section',null,'provider-card mdeck-card');
   el.style.setProperty('--accent',spec.accent);
   el.style.setProperty('--brand',spec.brand||spec.accent);
   if(spec.disabled)el.classList.add('model-disabled');
   el.tabIndex=0;el.setAttribute('role','button');
   el.setAttribute('aria-label',spec.title+' · 打开配置页');
   var ring=n('span',null,'mdeck-ring'),face=n('div',null,'mdeck-face');
   face.append(n('span',null,'mdeck-stripes'),n('span',null,'mdeck-vignette'),n('span',null,'mdeck-sheen'));
   face.append(
    n('span',spec.rarityText,'mdeck-rarity'+(spec.rarityClass||'')),
    deckEmblemWrap(spec.emblem),
    n('span',spec.title,'mdeck-name'),
    n('span',spec.sub,'mdeck-sub'),
    deckTags(spec.tags),
    n('span','打开配置','mdeck-open-hint')
   );
   el.append(ring,face);
   el.addEventListener('click',function(){deckOpen(el,spec);});
   el.addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();deckOpen(el,spec);}});
   return el;
  }

  /* 主模型 + 失败回退：卡面只写状态，全部操作在抽出来的配置页 */
  function routeBody(){
  var box=n('div',null,'mdeck-sheet-form');
  var primaryPick=select(box,'主模型',modelChoices,primaryValue,true);
  primaryPick.setAttribute('aria-label','主模型');
  primaryPick.onchange=function(){
   var picked;try{picked=JSON.parse(primaryPick.value);}catch(_){return;}
   if(!picked||picked.length!==2)return;
   var duplicate=data.fallbacks.find(function(x){return sameTarget(x,picked);});
   if(duplicate&&duplicate.has_overrides){primaryPick.value=primaryValue;feedback.textContent='该模型带有独立回退参数；先在下面把它移出回退，再设为主模型';return;}
   var entries=routeEntries(data.fallbacks.filter(function(x){return !sameTarget(x,picked);}));
   saveRoutes(picked[0],picked[1],entries,'主模型已切到 '+picked[1]);
  };
  box.append(n('span','失败回退','route-sub'));
  var chain=n('ol',null,'model-fallback-list');
  data.fallbacks.forEach(function(item,index){
   var li=n('li',null,'model-route-row');
   li.dataset.key=item.key||item.provider+'|'+item.model;
   li.dataset.item=JSON.stringify({key:item.key,provider:item.provider,model:item.model});
   var handle=n('button','⠿','route-handle');handle.type='button';
   handle.setAttribute('aria-label','拖动调整顺序，或按上下方向键移动');
   li.append(handle,n('span',item.model+'（'+label(item.provider)+'）','route-name'));
   if(item.has_overrides)li.append(n('span','独立参数','route-tag'));
   li.append(button('移出',function(){removeChain(index);},'btn route-del'));
   chain.append(li);
  });
  box.append(chain);
  if(!data.fallbacks.length)box.append(n('p','没有回退，主模型报错这一轮就直接失败。','pw-hint'));
  bindDrag(chain);
  var spareModels=modelChoices.filter(function(choice){var pair=JSON.parse(choice[0]);return !(pair[0]===primaryPair[0]&&pair[1]===primaryPair[1])&&!data.fallbacks.some(function(x){return sameTarget(x,pair);});});
  if(spareModels.length){var adder=select(box,'',spareModels,'',true,'加入回退');adder.setAttribute('aria-label','加入回退');adder.onchange=function(){var pair;try{pair=JSON.parse(adder.value);}catch(_){return;}if(!pair||pair.length!==2)return;addChain(pair[0],pair[1]);};}
  else box.append(n('p','没有可加入回退的模型：先把别的模型启用起来。','pw-hint'));
  return box;
  }
  var routeCard=deckCard({
   accent:'226 193 132',emblem:'主路',title:'主模型与失败回退',
   rarityText:'✦ 主线路',rarityClass:' ssr',
   sub:primaryPair[1]?'当前 '+primaryPair[1]+'（'+label(primaryPair[0])+'）':'还没选主模型',
   tags:['回退 '+data.fallbacks.length+' 个',primaryPair[1]?'主模型已选':'未选主模型'],
   build:routeBody
  });
  routeCard.classList.add('model-route-card','featured');

  grid.replaceChildren();
  grid.append(routeCard);
  data.providers.forEach(function(p){
   var protocol=({'chat_completions':'CHAT','codex_responses':'RESP','anthropic_messages':'CLAUDE','bedrock_converse':'BEDROCK','codex_app_server':'APP'}[p.api_mode]||'自动');
   var liveModels=p.models.filter(function(m){return m.enabled;});
   function providerBody(){
   /* 2026-11-13（用户第 9 条）：卡片点开只有保存，没有删除，想删只能改 config.yaml。
      这里在配置页底部补一个删除动作；被主模型/回退引用时后端会拒绝，前端只负责说清原因。 */
   var box=n('div',null,'mdeck-sheet-form');
   box.append(PanelModelEditor.build({
    provider:p,
    revision:data&&data.revision,
    close:deckClose,
    onSaved:function(out){accept(out);render();feedback.textContent='服务已保存，待应用';}
   }));
   var zone=n('section',null,'model-danger-zone');
   zone.append(n('h3','删除这个服务'),n('p','只删这条服务的地址、密钥与模型清单；如果它还在主模型或回退路线里，会先被拦下来。','pw-hint'));
   var del=button('删除「'+p.name+'」',async function(){
    if(!confirm('确定删除模型服务「'+p.name+'」？删除后它的地址、密钥和模型清单都不再保留。'))return;
    del.disabled=true;del.textContent='正在删除…';
    try{
     var out=await mutate({action:'delete',id:p.id});
     deckClose();feedback.textContent=out.changed?'已删除「'+p.name+'」，待重启应用生效':'没有变化';
    }catch(e){
     del.disabled=false;del.textContent='删除「'+p.name+'」';
     zone.querySelector('.model-danger-error')?.remove();
     var err=n('p',e.message,'model-danger-error');zone.append(err);
    }
   },'btn danger');
   zone.append(del);
   box.append(zone);
   return box;
   }
   grid.append(deckCard({
    accent:deckAccent(p.id),brand:deckBrand(p.id+'b'),emblem:p.name,title:p.name,
    rarityText:(p.enabled?'✦ ':'○ ')+(p.enabled?'启用':'停用'),
    rarityClass:p.enabled&&p.api_key_configured?' ssr':'',
    sub:p.base_url||'未设置服务地址',
    sheetSub:(p.enabled?'启用中':'已停用')+' · '+(p.api_key_configured?'密钥已配':'未配密钥')+' · '+protocol,
    tags:[liveModels.length+' 个模型',p.api_key_configured?'密钥已配':'未配密钥',protocol],
    build:providerBody,disabled:p.enabled?false:true
   }));
  });
  var addCard=n('section',null,'provider-card mdeck-card mdeck-card-add');
  addCard.tabIndex=0;addCard.setAttribute('role','button');addCard.setAttribute('aria-label','添加模型服务');
  addCard.style.setProperty('--accent','122 162 247');addCard.style.setProperty('--brand','186 156 255');
  var addFace=n('div',null,'mdeck-face');
  addFace.append(n('span',null,'mdeck-stripes'),n('span',null,'mdeck-vignette'),
   n('span','+','mdeck-emblem mdeck-emblem-add'),n('span','添加模型服务','mdeck-name'),
   n('span','选预设厂商，或自己填地址','mdeck-sub'),n('span','新服务','mdeck-open-hint'));
  addCard.append(n('span',null,'mdeck-ring'),addFace);
  function addSheet(){deckOpen(addCard,{title:'添加模型服务',sub:'预设厂商 · 只填 API Key；自定义 · 地址与高级项自己定',
   tags:['未保存'],emblem:'+',accent:'122 162 247',brand:'186 156 255',
   build:function(){return PanelModelEditor.build({isNew:true,revision:data.revision,close:deckClose,
    onSaved:function(out){accept(out);render();feedback.textContent='服务已添加，待应用';}});}});}
  addCard.addEventListener('click',addSheet);
  addCard.addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();addSheet();}});
  grid.append(addCard);
  if(!data.providers.length)grid.append(n('p','添加模型服务后，设置默认模型即可开始对话。','empty-state'));
  deckPaint();

  function frame(){var pr=primaryNow();return pr[1]?pr[1]:'未配置';}
  var moaBlock=n('details',null,'model-block model-advanced'),moaSum=n('summary');
  moaSum.append(n('span','高级：MOA 混合','model-fold-title'),n('span','几个模型各答一遍再合成，比回退贵得多，默认不开','model-fold-hint'));
  var moaBody=n('div',null,'model-fold-body'),moaFoot=n('div',null,'mcp-actions');
  moaState=n('div','正在读取 MOA 状态…','moa-state');
  moaFoot.append(button('配置 MOA',()=>moaDialog()));
  moaBody.append(n('p','和回退不是一回事：回退是一个模型挂了换下一个；MOA 是几个模型各答一遍，再让聚合模型挑或合成。开着时主模型显示成 moa / 预设名，属于正常现象。','pw-hint'),moaState,moaFoot);
  moaBlock.append(moaSum,moaBody);
  var moaHost=document.getElementById('moaSlot');
  if(moaHost){moaBlock.open=true;moaHost.append(moaBlock);}else routes.append(moaBlock);
  loadMoa();

  grid.onmousemove=function(ev){
   var card=ev.target&&ev.target.closest?ev.target.closest('.mdeck-card'):null;
   if(!card)return;
   var rect=card.getBoundingClientRect();
   card.style.setProperty('--mx',(((ev.clientX-rect.left)/rect.width)*100).toFixed(1)+'%');
   card.style.setProperty('--my',(((ev.clientY-rect.top)/rect.height)*100).toFixed(1)+'%');
  };
 }
 function revisionCheck(d,base,set){var check=button('核对最新配置',async()=>{try{var latest=await api(),summary=n('pre',JSON.stringify({primary:latest.primary,fallbacks:latest.fallbacks,providers:latest.providers},null,2),'pmcp-compare');d.body.append(summary);var use=button('保留输入，使用此版本',()=>{base.revision=latest.revision;set?.(latest);summary.remove();use.remove();d.status.textContent='已读取最新版本，请核对差异后保存';});d.actions.append(use);}catch(e){d.status.textContent=e.message;}});d.actions.append(check);}
 function dialog(title){var previous=document.activeElement,overlay=n('div',null,'modal-overlay'),box=n('section',null,'modal panel-model-modal'),body=n('div'),status=n('p','','maintenance-feedback'),actions=n('div',null,'mcp-actions');box.setAttribute('role','dialog');box.setAttribute('aria-modal','true');box.setAttribute('aria-label',title);status.setAttribute('role','status');box.append(n('h2',title),body,status,actions);overlay.append(box);document.body.append(overlay);window.ui.adoptOverlay(overlay,{esc:false,trap:false,backdrop:false});function close(){overlay.remove();previous?.focus();}function requestClose(){if(box.beforeClose&&!box.beforeClose())return;close();}box.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();requestClose();}if(e.key==='Tab'){var items=[...box.querySelectorAll('button,input,select,textarea')].filter(e=>!e.disabled&&!e.hidden&&e.getClientRects().length);if(e.shiftKey&&document.activeElement===items[0]){e.preventDefault();items.at(-1)?.focus();}else if(!e.shiftKey&&document.activeElement===items.at(-1)){e.preventDefault();items[0]?.focus();}}});return {box,body,status,actions,close,requestClose};}
 function credentialDialog(provider){var d=dialog('凭证来源 · '+provider.name),pool=provider.credential_pool;d.body.append(n('p',provider.api_key_configured?'配置密钥已设置，来源：'+provider.credential_source:'配置密钥未设置。','pw-hint'),n('p','以下为当前应用环境保存的独立凭证记录。它们可能优先于配置密钥；清除配置密钥不会删除这些记录。','pw-hint'));var list=n('ul');pool.entries.forEach((entry,i)=>list.append(n('li',(i+1)+' · '+entry.kind+' · 记录状态：'+entry.status+' · '+(entry.endpoint_bound?'绑定当前服务地址':'唯一名称匹配'))));d.body.append(list);if(pool.excluded_count)d.body.append(n('p',pool.excluded_count+' 个条目因地址不符或归属不明确未参与当前服务选择；原记录保留。','pw-hint'));d.body.append(n('p','这里展示保存记录，未进行联网验证。实际调用还受额度、冷却及原生凭证选择策略影响。','pw-hint'));var close=button('关闭',d.close);d.actions.append(close);close.focus();}
 function field(body,title,value,type='text'){var wrapper=n('label',null,'field'),input=n(type==='textarea'?'textarea':'input');input.setAttribute('aria-label',title);if(type!=='textarea')input.type=type;input.value=value??'';if(title)wrapper.append(n('span',title));wrapper.append(input);body.append(wrapper);return input;}
 function select(body,title,options,value,strict=false,placeholder){var wrapper=n('label',null,'field'),input=n('select'),hasValue=options.some(o=>o[0]===value);input.setAttribute('aria-label',title);if(value&&!hasValue&&!strict)options=options.concat([[value,value+' · 当前值']]);if(strict&&!hasValue)options=[[ '', placeholder||'请选择主模型' ],...options];options.forEach(([key,text])=>{var o=n('option',text);o.value=key;if(strict&&!key)o.disabled=true;input.append(o);});input.value=value;if(!hasValue)input.selectedIndex=0;if(title)wrapper.append(n('span',title));wrapper.append(input);body.append(wrapper);return input;}
 function edit(provider){if(!data)return load().then(()=>{if(data)edit(provider);});var d=dialog(provider?'编辑模型服务':'添加模型服务'),base={revision:data.revision},draftKey='panel-model-draft:'+(provider?.id||'new');
  var name=field(d.body,'服务名称',provider?.name),url=field(d.body,'服务地址',provider?.base_url,'url'),mode=select(d.body,'接口协议',[['','由内核识别'],['chat_completions','Chat Completions'],['codex_responses','Responses'],['anthropic_messages','Anthropic Messages']],provider?.api_mode||''),note=field(d.body,'备注',provider?.note,'textarea');
  var credentials=n('section');d.body.append(credentials);credentials.append(n('h3','配置密钥与请求头'),n('p','已保存的凭证不回显。更换服务主机会清除旧配置密钥和请求头，请为新服务重新填写。','pw-hint'));if(provider?.credential_pool?.independent_count)credentials.append(n('p','此服务另有 '+provider.credential_pool.independent_count+' 个独立池凭证。替换或清除下面的配置密钥不会删除它们，实际调用仍可能选择独立凭证。','pw-hint'),button('查看凭证来源',()=>credentialDialog(provider)));
  var keyAction=select(credentials,'API密钥操作',[['keep','保留现有密钥'],['replace','替换密钥'],['clear','清除配置密钥']],provider?.api_key_configured?'keep':'replace'),key=field(credentials,'新的API密钥','','password');key.autocomplete='new-password';key.parentElement.hidden=keyAction.value!=='replace';keyAction.onchange=()=>key.parentElement.hidden=keyAction.value!=='replace';
  var headers=[];function headerRow(name=''){var row=n('div',null,'model-header-row'),h=field(row,'请求头名称',name),a=select(row,'请求头操作',[['keep','保留'],['replace','替换'],['clear','清除']],name?'keep':'replace'),v=field(row,'新的请求头值','','password');v.autocomplete='new-password';v.parentElement.hidden=a.value!=='replace';a.onchange=()=>v.parentElement.hidden=a.value!=='replace';headers.push({h,a,v});credentials.append(row);}(provider?.header_keys||[]).forEach(headerRow);credentials.append(button('添加请求头',()=>headerRow()));
  var modelHead=n('div',null,'section-head'),models=n('div',null,'model-edit-rows'),modelData=(provider?.models||[]).map(m=>({...m}));d.body.append(modelHead,models);modelHead.append(n('h3','模型清单'));var defaultModel=field(d.body,'此服务默认模型ID（供未指定模型时使用）',provider?.model||'');
  var discovery=n('section',null,'model-discovery'),discoveryActions=n('div',null,'mcp-actions'),discoveryList=n('div',null,'model-discovery-list'),discovered=[];discovery.append(n('h3','从服务获取模型'),n('p','使用上面的服务地址和本次填写的密钥查询模型。结果只在此表单中暂存；勾选后加入清单，不会自动改变服务默认模型或全局主备路线。','pw-hint'));var discoveryTransportNotice=n('p','','maintenance-feedback');discoveryTransportNotice.setAttribute('role','status');discoveryTransportNotice.setAttribute('aria-live','polite');discovery.append(discoveryTransportNotice,discoveryActions,discoveryList);d.body.insertBefore(discovery,modelHead);
  function updateDiscoveryTransportNotice(){try{var parsed=new URL(url.value.trim()),ip=parsed.hostname.replace(/^\[|\]$/g,''),parts=ip.split('.').map(Number),privateIp=parts.length===4&&(parts[0]===10||parts[0]===127||parts[0]===192&&parts[1]===168||parts[0]===172&&parts[1]>=16&&parts[1]<=31);discoveryTransportNotice.textContent=parsed.protocol==='http:'&&privateIp?'安全提示：此内网地址使用 HTTP，API 密钥会以明文在网络中传输。请只在可信的本机或局域网使用；公网服务请使用 HTTPS。':'';}catch(_){discoveryTransportNotice.textContent='';}}
  url.addEventListener('input',updateDiscoveryTransportNotice);updateDiscoveryTransportNotice();
  function drawDiscovery(){discoveryList.replaceChildren();discovered.forEach(item=>{var label=n('label',null,'model-discovery-item'),check=n('input');check.type='checkbox';check.checked=item.selected===true;check.onchange=()=>{item.selected=check.checked;};label.append(check,n('code',item.id));if(item.name!==item.id)label.append(n('span',item.name));discoveryList.append(label);});}
  var fetchModels=button('获取模型',async()=>{fetchModels.disabled=true;d.status.textContent='正在查询服务模型列表…';try{var request={action:'discover',base_url:url.value,api_mode:mode.value};if(keyAction.value==='replace'&&key.value.trim())request.api_key=key.value;else if(provider&&keyAction.value==='keep'&&provider.api_key_configured){request.provider_id=provider.id;request.model=provider.model;request.use_saved_credential=true;}else throw Error('请填写 API 密钥，或保留此服务已保存的密钥');var out=await api(request),known=new Set(modelData.filter(item=>item.enabled!==false).map(item=>String(item.id)));discovered=out.models.map(m=>({...m,selected:!known.has(String(m.id))}));drawDiscovery();d.status.textContent='获取到 '+discovered.length+' 个模型；未启用项已勾选，核对后加入清单';}catch(e){d.status.textContent=e.message;}finally{fetchModels.disabled=false;}}),addDiscovered=button('加入已勾选模型',()=>{var selected=discovered.filter(m=>m.selected===true);if(!selected.length){d.status.textContent='请先勾选要加入的模型';return;}var added=0;selected.forEach(found=>{var existing=modelData.find(m=>String(m.id)===String(found.id));if(existing){existing.enabled=true;if(!existing.name||existing.name===existing.id)existing.name=found.name;}else{modelData.push({id:found.id,name:found.name||found.id,enabled:true});added++;}});discovered=discovered.filter(m=>!m.selected);persist();renderRows();drawDiscovery();d.status.textContent='已加入 '+selected.length+' 个模型（新增 '+added+' 个）；请按需单独设置服务默认模型';});discoveryActions.append(fetchModels,addDiscovered);
  var filter=field(d.body,'筛选模型','','search'),page=0;filter.oninput=()=>{page=0;renderRows();};
  function renderRows(){models.replaceChildren();var visible=modelData.filter(m=>(m.id+' '+m.name).toLowerCase().includes(filter.value.toLowerCase())),start=page*30;visible.slice(start,start+30).forEach(m=>{var row=n('div',null,'model-edit-row'),id=n('code',m.id),nameInput=n('input');nameInput.value=m.name;nameInput.setAttribute('aria-label',m.id+'显示名称');nameInput.oninput=()=>{m.name=nameInput.value;persist();};var route=provider?routeFor(provider.id,m.id):'';if(route)row.append(n('span',route,'model-route-badge'));var toggle=button(m.enabled?'在列表中隐藏':'在列表中显示',()=>{m.enabled=!m.enabled;persist();renderRows();});row.append(id,nameInput,toggle,button('设为服务默认',()=>{defaultModel.value=m.id;m.enabled=true;persist();renderRows();}));models.append(row);});if(visible.length>30){var controls=n('div',null,'mcp-actions'),back=button('上一页',()=>{page--;renderRows();}),next=button('下一页',()=>{page++;renderRows();});back.disabled=page===0;next.disabled=start+30>=visible.length;controls.append(back,n('span',(start+1)+'–'+Math.min(start+30,visible.length)+' / '+visible.length),next);models.append(controls);}}
  var addRow=n('div',null,'model-add-row'),newId=field(addRow,'新增模型ID','');addRow.append(button('添加模型',()=>{var id=newId.value.trim();if(!id||modelData.some(m=>m.id===id)){d.status.textContent='请填写新的模型ID';return;}modelData.push({id,name:id,enabled:true});newId.value='';persist();renderRows();}));d.body.append(addRow);
  function snapshot(){return {name:name.value,base_url:url.value,api_mode:mode.value,note:note.value,default_model:defaultModel.value,models:modelData.map(m=>({id:m.id,name:m.name,enabled:m.enabled}))};}
  var baseline=snapshot();
  var draftDurable=true;function persist(){try{localStorage.setItem(draftKey,JSON.stringify({...snapshot(),revision:base.revision,baseline}));draftDurable=true;d.status.textContent='未保存的表单已保存到此浏览器；凭证不写入浏览器存储';}catch(_){draftDurable=false;d.status.textContent='浏览器无法保存草稿；当前修改仅在此窗口保留，关闭前请先保存配置';}return draftDurable;}
  try{var draft=JSON.parse(localStorage.getItem(draftKey)||'null');if(draft){name.value=draft.name;url.value=draft.base_url;mode.value=draft.api_mode;note.value=draft.note;defaultModel.value=draft.default_model;modelData=draft.models;base.revision=draft.revision||base.revision;baseline=draft.baseline||baseline;d.status.textContent='已恢复未保存的表单';}}catch(_){}
  d.body.addEventListener('input',e=>{if(!credentials.contains(e.target))persist();});mode.addEventListener('change',persist);renderRows();
  function credentialEditsPending(){return keyAction.value==='clear'||(keyAction.value==='replace'&&!!key.value.trim())||headers.some(function(item){return !!item.h.value.trim()&&(item.a.value==='clear'||(item.a.value==='replace'&&!!item.v.value));});}
  d.box.beforeClose=function(){var warnings=[];if(!persist())warnings.push('草稿未能保存到浏览器，关闭会丢失非凭证修改');if(credentialEditsPending())warnings.push('API 密钥或请求头有未保存输入，凭证不会储存在浏览器');if(warnings.length&&!confirm(warnings.join('；')+'。仍要关闭吗？'))return false;if(!draftDurable){try{localStorage.removeItem(draftKey);}catch(_){d.status.textContent='旧草稿无法从浏览器存储清除，弹窗保持打开；请恢复存储后再保存或丢弃。';return false;}}return true;};var save=button('保存配置',async()=>{save.disabled=true;try{var values=snapshot();if(!values.default_model||!values.models.some(m=>m.id===values.default_model&&m.enabled)){throw Error('请选择一个已启用的服务默认模型；模型发现不会替你决定默认项');}var changes={};Object.keys(values).forEach(k=>{if(!provider||JSON.stringify(values[k])!==JSON.stringify(baseline[k]))changes[k]=values[k];});changes.credential={action:keyAction.value,...(keyAction.value==='replace'?{value:key.value}:{})};changes.headers={};headers.forEach(({h,a,v})=>{if(h.value.trim())changes.headers[h.value.trim()]={action:a.value,...(a.value==='replace'?{value:v.value}:{})};});var out=await api({action:provider?'update':'create',id:provider?.id,revision:base.revision,changes});remember(out);accept(out);render();try{localStorage.removeItem(draftKey);}catch(_){}d.close();feedback.textContent='模型配置已保存，待重启应用生效';window.loadModelChecks?.();}catch(e){d.status.textContent=e.message;save.disabled=false;}});d.actions.append(save);revisionCheck(d,base);d.actions.append(button('关闭',d.requestClose));name.focus();
 }
 window.addProvider=()=>edit(null);window.renderProviders=function(){load();window.loadAuxTasks?.();window.loadModelChecks?.();};
})();
