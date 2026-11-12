(function(){
 'use strict';
 var fails=0;   // 连续失败计数：单次失败不打扰用户
 var bar=document.createElement('section');bar.className='panel-runtime-bar';bar.hidden=true;bar.setAttribute('role','status');var label=document.createElement('span'),button=document.createElement('button');button.className='action';button.textContent='重启应用并生效';bar.append(label,button);document.body.append(bar);new ResizeObserver(()=>document.documentElement.style.setProperty('--runtime-banner-space',bar.hidden?'0px':(bar.getBoundingClientRect().height+20)+'px')).observe(bar);var latest,polling=false;
 // WebKit(Safari/iOS) 对空响应体调 response.json() 会抛 "The string did not match the expected pattern."，
 // 304、网关空回包、被中间层吞掉响应都会命中，桌面 Chrome 只是报 "Unexpected end of JSON input" 所以看不出来。
 // 这里改成：先按 document.baseURI 算绝对地址（脚本在 DOMContentLoaded 之前就跑，apiUrl 的 BASE 那时还是空串），
 // 再取 text 自己解析，空响应换下一个地址并带时间戳重试，最后把 HTTP 状态和字节数写进提示里。
 function endpointList(action){
  var path='/api/panel-runtime/'+action,list=[],add=function(u){if(u&&list.indexOf(u)<0)list.push(u);};
  // 脚本在 DOMContentLoaded 之前执行，此刻全局 BASE 还是空串；<base href> 已经在 head 里解析过了，
  // 直接读它才能拼出真正的 /app/<应用>/api/... 地址。根路径 '/api/...' 会绕开 base，落到站点根上的别的服务。
  try{var tag=document.querySelector('base'),href=tag&&tag.getAttribute('href');if(href){var abs=new URL(href,document.baseURI).pathname.replace(/\/+$/,'');if(abs)add(abs+path);}}catch(e){}
  if(BASE)add(String(BASE).replace(/\/+$/,'')+path);
  try{add(new URL(path,document.baseURI).pathname);}catch(e){}
  try{add(apiUrl(path));}catch(e){}
  add(path);
  return list;
 }
 async function once(url,body){var response=await fetch(url,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Monitor-Token':monitorToken||'','Cache-Control':'no-cache'},body:body?JSON.stringify(body):undefined,cache:'no-store'});var text='';try{text=await response.text();}catch(e){text='';}if(!text)return {status:response.status,empty:true};try{return {status:response.status,ok:response.ok,data:JSON.parse(text)};}catch(e){return {status:response.status,text:text,badJson:true};}}
 async function request(action,body){
  var urls=endpointList(action),tries=body?1:2,last='运行状态接口没有响应';
  for(var i=0;i<urls.length;i++){
   for(var n=0;n<tries;n++){
    var url=urls[i]+(n?((urls[i].indexOf('?')<0?'?':'&')+'t='+Date.now()):''),out;
    try{out=await once(url,body);}catch(e){out={error:(e&&e.message)||String(e)};}
    if(out.data){if(!out.ok||!out.data.ok)throw Error(out.data.error||('运行状态读取失败（HTTP '+out.status+'）'));return out.data;}
    if(out.error){last='网络不可达：'+out.error;continue;}
    last=out.empty?('接口返回空响应（HTTP '+out.status+'）'):('接口返回非 JSON（HTTP '+out.status+'，'+out.text.length+' 字节）');
    if(!out.empty)break;
   }
  }
  throw Error(last+'［已试 '+urls.length+' 个地址］');
 }
 async function load(){if(polling||!monitorToken)return;polling=true;try{var data=await request('status');latest=data;fails=0;var recovery=data.config_recovery,needsRecovery=recovery&&(!recovery.ok||recovery.pending);bar.hidden=!needsRecovery&&!data.changes.length&&!data.restart_pending&&!data.restart_blocked&&data.restart?.status!=='failed';if(needsRecovery){label.textContent=recovery.ok?'有一次配置保存尚未完成，请核对并恢复':recovery.error;button.textContent='处理配置恢复';button.hidden=false;button.disabled=false;}else if(data.restart_blocked){label.textContent=data.restart_block_reason||data.restart.drain_cleanup?.error||'正在核实重启结果';button.textContent='重新检查恢复状态';button.hidden=false;button.disabled=false;}else if(data.restart_pending){label.textContent='正在重启应用，等待连接恢复…';button.hidden=true;}else{button.textContent='重启应用并生效';button.hidden=false;button.disabled=false;label.textContent=data.restart?.status==='failed'?data.restart.error:(data.changes.length+' 项配置已保存，重启应用后生效');if(data.restart?.status!=='failed'){if(data.busy)label.textContent+='；当前仍有任务在执行';else if(data.observation?.gateway?.work_known===false)label.textContent+='；暂时无法核实外部任务状态';}}
   /* 重启中的那一条只留一个出口：蒙版在说「正在启动」，横条就别再来一句「正在等待连接恢复」 */
   if(window.__bootMaskActive&&data.restart_pending&&!needsRecovery&&!data.changes.length&&!data.restart_blocked&&data.restart?.status!=='failed')bar.hidden=true;
   delete button.dataset.mode;}catch(error){fails++;
  // 单次失败不弹：iOS 回前台、切网、代理重连都会丢一两包。连续 2 次（≥10s）才让人看见，
  // 而且只说人话，不把「网络不可达：...［已试 N 个地址］」这种内部排查信息甩到用户脸上。
  /* 2026-11-12：顶栏圆点和启动蒙版已经能表达断线，这里不再抢着说话。
     10s 断言太少（iOS 回前台切网必然丢一包），30s 还没回来才升级成横条，并且给一个真能点的动作。 */
  if(window.__bootMaskActive){
   bar.hidden=true;                                   /* 蒙版占着输入区，它说得更清楚 */
  }else if(latest?.restart_pending){
   bar.hidden=false;label.textContent='应用正在重新连接，草稿与排队记录会恢复…';button.hidden=true;
  }else if(fails>=6){
   bar.hidden=false;label.textContent='连接已中断 '+(fails*5)+' 秒，仍在重试';
   button.hidden=false;button.disabled=false;button.dataset.mode='reload';button.textContent='刷新页面';
  }
  else if(window.console)console.warn('[panel-runtime] 读取失败，静默重试：',(error&&error.message)||error);
 }finally{polling=false;}}
 button.onclick=async function(){if(button.dataset.mode==='reload'){location.reload();return;}if(latest?.restart_blocked){button.disabled=true;await load();button.disabled=false;return;}if(latest?.config_recovery&&(!latest.config_recovery.ok||latest.config_recovery.pending)){switchPage('updates');window.renderConfigRecovery?.();document.getElementById('configRecovery')?.scrollIntoView({block:'start'});return;}await load();var detail=latest?.busy?'当前仍有任务在执行。':latest?.observation?.gateway?.work_known===false?'暂时无法核实外部渠道和定时任务状态。':'';if(!confirm(detail+'重启整个Hermes应用以应用配置？正在运行的回复和任务会中断，草稿与已保存的执行记录会保留。'))return;button.disabled=true;try{var data=await request('restart',{interrupt:true});latest={...latest,restart_pending:true};label.textContent='已请求应用重启，正在等待重新连接…';button.hidden=true;load();}catch(e){label.textContent=e.message;button.disabled=false;}};
 window.panelRuntimeRefresh=load;
 setInterval(function(){if(!document.hidden)load();},5000);
 document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible')setTimeout(load,800);});
 load();
})();
