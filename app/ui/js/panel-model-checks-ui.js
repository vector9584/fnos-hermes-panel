(function(){
 'use strict';
 var jobs=[],providers=[],loading=false,submitting=false,lastDraw='';
 var target=document.getElementById('modelChecksTarget'),status=document.getElementById('modelChecksStatus'),form=document.getElementById('modelChecksForm'),list=document.getElementById('modelChecksList');
 function el(tag,text,cls){var n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;}
 async function request(path,method,body){var response=await fetch(apiUrl('/api/panel-models/'+path),{method:method||'GET',headers:{'Content-Type':'application/json','X-Monitor-Token':monitorToken||''},body:body?JSON.stringify(body):undefined});var data=await response.json();if(!response.ok||!data.ok)throw Error(data.error||'模型验证请求失败');return data;}
 function chosen(){try{return localStorage.getItem('panel-model-check-target')||'';}catch(_){return '';}}
 function fill(){
  var selected=target.value||chosen();target.replaceChildren();
  providers.forEach(function(p){p.models.forEach(function(model){var option=el('option',p.name+' / '+model);option.value=JSON.stringify({provider:p.id,model:model});target.append(option);});});
  if([...target.options].some(function(option){return option.value===selected;}))target.value=selected;
  if(!target.options.length){var empty=el('option','请先添加模型服务并选择模型');empty.value='';target.append(empty);}
 }
 function controls(){form.querySelector('button').disabled=submitting||jobs.some(function(j){return j.status==='running';})||!target.value;target.disabled=submitting;}
 function draw(){
  var signature=JSON.stringify(jobs);if(signature===lastDraw){controls();return;}lastDraw=signature;
  var opened=new Set([...list.querySelectorAll('details[open]')].map(function(n){return n.dataset.id;}));list.replaceChildren();
  if(!jobs.length)list.append(el('p','还没有验证记录。选择服务与模型后开始验证。','page-subtitle'));
  var states={running:'正在验证',done:'已收到回复',failed:'验证失败',cancelled:'已取消',interrupted:'重启中断'};
  jobs.forEach(function(job){
   var row=el('details',undefined,'model-check-record');row.dataset.id=job.id;row.open=opened.has(job.id)||job.status==='running';
   var summary=el('summary');summary.append(el('strong',job.provider_name+' / '+job.model),el('span',states[job.status]||'需要重新读取状态'),el('time',new Date(job.created_at).toLocaleString('zh-CN',{hour12:false})));row.append(summary);
   if(job.result){
    row.append(el('p',job.result.exact_match?'回复与验证指令一致。':'已收到有效回复，内容未完全遵循验证指令。'));
    row.append(el('p','耗时 '+(job.result.latency_ms/1000).toFixed(1)+' 秒'+(job.result.response_model?' · 服务报告模型：'+job.result.response_model:'')));
    row.append(el('pre',job.result.output));if(job.result.truncated)row.append(el('p','显示前 16000 字。'));
   }
   if(job.error)row.append(el('p',job.error,'model-check-error'));
   if(job.status==='running'){
    var cancel=el('button',job.cancel_requested_at?'正在取消…':'取消验证','btn');cancel.disabled=!!job.cancel_requested_at;
    cancel.onclick=async function(){cancel.disabled=true;try{await request('checks/'+encodeURIComponent(job.id)+'/cancel','POST',{});await refresh(false);}catch(error){status.textContent=error.message;cancel.disabled=false;}};row.append(cancel);
   }
   list.append(row);
  });controls();
 }
 async function refresh(catalog){
  if(loading)return;loading=true;
  try{await fetchToken();if(catalog){providers=(await request('catalog')).providers;fill();}jobs=(await request('checks')).checks;draw();if(catalog)status.textContent='已读取模型与验证记录';}
  catch(error){status.textContent=error.message;}
  finally{loading=false;controls();}
 }
 window.loadModelChecks=function(){return refresh(true);};
 document.getElementById('modelChecksRefresh').onclick=window.loadModelChecks;
 target.onchange=function(){try{localStorage.setItem('panel-model-check-target',target.value);}catch(_){}controls();};
 form.onsubmit=async function(event){
  event.preventDefault();if(submitting||!target.value)return;submitting=true;controls();status.textContent='正在提交验证…';
  var payload=JSON.parse(target.value),key='panel-model-check-pending';
  try{
   var pending;try{pending=JSON.parse(localStorage.getItem(key)||'null');}catch(_){}
   if(!pending||pending.provider!==payload.provider||pending.model!==payload.model)pending={...payload,request_id:'check-'+(crypto.randomUUID?crypto.randomUUID():Date.now()+'-'+Math.random().toString(36).slice(2))};
   try{localStorage.setItem(key,JSON.stringify(pending));}catch(_){}
   await request('checks','POST',pending);try{localStorage.removeItem(key);localStorage.setItem('panel-model-check-target',target.value);}catch(_){}
   status.textContent='验证已开始，关闭面板后仍可查看结果。';await refresh(false);
  }catch(error){status.textContent=error.message+'；可重试提交，重复请求不会重复执行。';}
  finally{submitting=false;controls();}
 };
 setInterval(function(){if(document.getElementById('page-models-checks').classList.contains('active'))refresh(false);},2000);
}());
