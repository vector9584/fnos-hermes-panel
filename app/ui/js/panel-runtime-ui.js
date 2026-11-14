/* 运行状态提示（配置待生效 / 重启进行中 / 连接中断 / 配置恢复）
 *
 * 2026-11-14 改造一：原来是自己 createElement 一个 <section class="panel-runtime-bar"> 直塞 body，
 * 并且用 ResizeObserver 往文档根写 --runtime-banner-space 给页面让位 —— 用户看到的就是
 * 「面板底下常驻一条黄色横条，还占着布局」。现在统一走 js/core/utils.js 的通知组件
 * （window.toast / __hzToast），带 key='runtime' 去重：状态没变就原位改字，不变位置、不重放动画。
 *
 * 2026-11-14 改造二（文案）：用户嫌「下一轮生效」含糊。改成分两类说清楚——
 *   热生效（模型/路线/配置恢复）：标题「X 已保存」，正文「下一条消息起生效，不用重启」，
 *     只给一个「知道了」，点了记住这条不再弹（localStorage 按内容签名去重）。
 *     依据：gateway 每轮重新读 config.yaml，模型元数据走 load_config()，(mtime,size) 失效。
 *   需重启（消息渠道 / 输入状态 / MCP）：adapter 在启动时构建，改的是进程内对象，必须重启。
 *   分类只看 reason 前缀，前端算，后端不落字段——改 server JS 要重启，为一个展示字段不值。
 *
 * 语义一条不少：
 *   配置恢复待处理 → 错误级 + 「去核对」
 *   重启结果待核实 → 警告级 + 「再查一次」
 *   正在重启       → 信息级常驻，无按钮
 *   热生效改动     → 信息级 + 「知道了」（可记住）
 *   需重启改动     → 警告级 + 「重启应用」「稍后」（任务在跑时正文点明会中断）
 *   上次重启失败   → 错误级 + 原因 + 「再试一次」
 *   连接连续中断   → 错误级 + 「刷新页面」
 */
(function(){
 'use strict';
 var fails=0;            /* 连续失败计数：单次失败不打扰用户 */
 var latest=null, polling=false;
 var KEY='runtime', snooze=null;   /* snooze={sig,until}：用户点过「稍后」就别每 5 秒再弹 */
 /* 哪些改动下一轮就生效、哪些必须重启：只认 reason 前缀。
    模型与路线、配置保存恢复 = 热生效（gateway 每轮重读 config.yaml）；
    消息渠道 / 输入状态 / MCP = adapter 与进程内连接，重启才换得掉。 */
 var HOT=/^(模型服务与路线|配置保存恢复)/;
 function isHot(c){ return HOT.test(String((c&&c.reason)||'')); }
 /* 后端错误串是给维护记录看的（「应用未在预期时间内恢复健康，仍在核实恢复结果；请检查维护记录」），
    卡片上只留第一句人话；已知的 timeout 直接翻译，别让人读诊断术语。 */
 function shortErr(raw){
  var e=String(raw||'').trim(); if(!e) return '原因没记录';
  if(/未在预期时间内恢复健康/.test(e)) return '超时没等到健康回应';
  e=e.split('；')[0].split(';')[0];
  return e.length>26?e.slice(0,26)+'…':e;
 }
 /* 「知道了」按内容签名记住：热生效的卡片不该每 5 秒轮询又冒出来 */
 var ACK='panel-runtime-ack-v1';
 function acked(s){ try{ return localStorage.getItem(ACK)===s; }catch(e){ return false; } }
 function ack(s){ try{ localStorage.setItem(ACK,s); }catch(e){} }

 /* 配置变更项的人话：后端只给 'models:update' 这种，直接摆给用户看不懂 */
 var REASON={models:'模型与供应商',model:'模型与供应商',channels:'消息渠道',channel:'消息渠道',
  agents:'助手与提示词',agent:'助手与提示词',mcp:'MCP',tools:'工具集',cron:'定时任务',
  ui:'界面设置',tts:'语音',voice:'语音',plugins:'插件',memory:'记忆',providers:'模型供应商',
  gateway:'网关',security:'安全',workspace:'工作区',
  /* 后端 changed() 传的是中文短语，也得翻成人话，否则卡片标题直接摆一句「模型服务与路线已保存」 */
  '模型服务与路线':'模型与供应商','通讯渠道配置':'消息渠道','配置保存恢复':'配置恢复',
  '输入状态':'输入状态'};
 function reasons(changes){
  var seen={},out=[];
  (changes||[]).forEach(function(c){
   var raw=String((c&&c.reason)||'其他配置').trim();
   /* '输入状态 · qqbot' / 'MCP · zotero' 这种带实例名的，卡片上只留类别，别把服务器名一起喊 */
   var cat=raw.split(' · ')[0], head=cat.split(':')[0];
   var name=REASON[cat]||REASON[head]||REASON[raw]||cat;
   if(!seen[name]){ seen[name]=1; out.push(name); }
  });
  return out.join('、');
 }
 function sig(o){ return o.type+'|'+o.title+'|'+o.message; }
 function show(o){
  var s=sig(o);
  if(o.persist && acked(s)) return;                  /* 热生效卡：点过「知道了」就别再冒出来 */
  if(snooze && snooze.sig===s && Date.now()<snooze.until) return;
  if(snooze && snooze.sig!==s) snooze=null;
  var t=window.__hzToast; if(!t) return;
  var actions=(o.actions||[]).slice();
  /* 主操作放最右（中文界面习惯：次要左、主要右） */
  if(o.snoozable!==false) actions.unshift({label:'稍后',onClick:function(){ snooze={sig:s,until:Date.now()+30*60*1000}; }});
  t({key:KEY,type:o.type,title:o.title,message:o.message,duration:0,closable:o.closable!==false,actions:actions});
 }
 function hide(){ if(window.__hzToast && window.__hzToast.dismiss) window.__hzToast.dismiss(KEY); }

 /* WebKit(Safari/iOS) 对空响应体调 response.json() 会抛 "The string did not match the expected pattern."，
    304、网关空回包、被中间层吞掉响应都会命中，桌面 Chrome 只是报 "Unexpected end of JSON input" 所以看不出来。
    这里改成：先按 document.baseURI 算绝对地址（脚本在 DOMContentLoaded 之前就跑，apiUrl 的 BASE 那时还是空串），
    再取 text 自己解析，空响应换下一个地址并带时间戳重试，最后把 HTTP 状态和字节数写进提示里。 */
 function endpointList(action){
  var path='/api/panel-runtime/'+action,list=[],add=function(u){if(u&&list.indexOf(u)<0)list.push(u);};
  /* 脚本在 DOMContentLoaded 之前执行，此刻全局 BASE 还是空串；<base href> 已经在 head 里解析过了，
     直接读它才能拼出真正的 /app/<应用>/api/... 地址。根路径 '/api/...' 会绕开 base，落到站点根上的别的服务。 */
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
 async function restart(onBusy, workUnknown){
  /* 先拉一次最新状态：用户点按钮到真正问「要不要重启」之间，任务可能已经跑完了 */
  await load();
  var detail=onBusy?'有任务在跑，重启会打断它。':(workUnknown?'外部渠道与定时任务暂时核实不了。':'');
  var ask=detail+'重启整个应用？正在回复的那条会中断，草稿和执行记录保留。';
  var ok=true;
  try{ ok=(window.ui&&typeof ui.confirm==='function')?await ui.confirm(ask):confirm(ask); }catch(e){ ok=false; }
  if(!ok)return;
  show({type:'info',title:'已请求重启',message:'正在等它重新连上来',closable:false,snoozable:false});
  request('restart',{interrupt:true}).then(function(){latest=Object.assign({},latest,{restart_pending:true});load();})
   .catch(function(e){show({type:'error',title:'重启请求没有发出去',message:e.message,actions:[{label:'重试',primary:true,onClick:function(){restart(onBusy,workUnknown);}}]});});
 }
 function render(data){
  var recovery=data.config_recovery, needsRecovery=recovery&&(!recovery.ok||recovery.pending);
  if(needsRecovery){
   show({type:'error',title:recovery.ok?'上次配置没保存完':'配置保存出错',message:String(recovery.ok?'点开核对后恢复，已存的数据不会丢':recovery.error||''),
    snoozable:false,actions:[{label:'去核对',primary:true,onClick:function(){switchPage('updates');window.renderConfigRecovery?.();document.getElementById('configRecovery')?.scrollIntoView({block:'start'});return true;}}]});
   return;
  }
  if(data.restart_blocked){
   var rs=data.restart||{};
   show({type:'warning',title:'重启结果还在确认',message:String(data.restart_block_reason||(rs.drain_cleanup&&rs.drain_cleanup.error)||'几秒后会自动更新'),snoozable:false,
    actions:[{label:'再查一次',primary:true,onClick:function(){load();return true;}}]});
   return;
  }
  if(data.restart_pending){
   /* 重启中的那一条只留一个出口：蒙版在说「正在启动」，通知就别再来一句 */
   if(window.__bootMaskActive){hide();return;}
   show({type:'info',title:'正在重启…',message:'连上后自动继续，草稿不会丢',closable:false,snoozable:false});
   return;
  }
  var failed=data.restart&&data.restart.status==='failed';
  /* 失败卡只在 10 分钟内算「现状」。后端只有重启成功才清记录，几小时前的一次失败
     会永远挂着红卡——那是在跟用户讲历史，不是讲现在。过了窗口就落到下面的改动卡。 */
  if(failed && Date.now()-Number(data.restart.requested_at||0) < 10*60*1000){
   show({type:'error',title:'重启没成功',message:shortErr(data.restart.error),
    actions:[{label:'再试一次',primary:true,onClick:function(){restart(!!data.busy,false);}}]});
   return;
  }
  var changes=data.changes||[], n=changes.length;
  if(n<1){hide();return;}

  var hotList=changes.filter(isHot), coldList=changes.filter(function(c){return !isHot(c);});
  var workUnknown=!!(data.observation&&data.observation.gateway&&data.observation.gateway.work_known===false);

  /* 一、全是热生效的：下一条消息就用新的。别挂重启按钮，也别再提「重启」两个字 */
  if(!coldList.length){
   var hot={type:'info',persist:true,snoozable:false,
    title:reasons(hotList||changes)+'已保存',
    message:'下一条消息起生效，不用重启'};
   hot.actions=[{label:'知道了',primary:true,onClick:function(){ack(sig(hot));hide();return true;}}];
   show(hot);
   return;
  }
  /* 二、有必须重启的：只点名这些；热生效的会跟着一起过去，不重复念叨 */
  var line=data.busy?'有任务在跑，重启会打断它；草稿和执行记录不会丢'
   :('重启后才会重新装载，只打断正在回复的那条'+(workUnknown?'；外部渠道与定时任务暂时核实不了':''));
  var cnames=reasons(coldList);
  show({type:'warning',title:cnames+(coldList.length>1?' 等 '+coldList.length+' 项':'')+'需要重启',message:line,
   actions:[{label:'重启应用',primary:true,onClick:function(){restart(!!data.busy,workUnknown);}}]});
 }
 async function load(){
  if(polling||!monitorToken)return;
  polling=true;
  try{var data=await request('status');latest=data;fails=0;render(data);}
  catch(error){fails++;
   /* 单次失败不弹：iOS 回前台、切网、代理重连都会丢一两包。连续 6 次（30s）还不回来才升级成通知，
      而且只说人话，不把「网络不可达：...［已试 N 个地址］」这种内部排查信息甩到用户脸上。 */
   if(window.__bootMaskActive){hide();}
   else if(latest&&latest.restart_pending){
    show({type:'info',title:'正在重新连接…',message:'草稿和排队记录会自己回来',closable:false,snoozable:false});
   }else if(fails>=6){
    show({type:'error',title:'连接已中断 '+(fails*5)+' 秒，仍在重试',message:'网络恢复后会自动连上；也可以手动刷新',snoozable:false,
     actions:[{label:'刷新页面',primary:true,onClick:function(){location.reload();return true;}}]});
   }else if(window.console)console.warn('[panel-runtime] 读取失败，静默重试：',(error&&error.message)||error);
  }finally{polling=false;}
 }
 window.panelRuntimeRefresh=load;
 load();
/* monitorToken 由 index 内联脚本赋值，本文件可能先执行 → 补两次近距重试，别让用户干等 5 秒才看到通知 */
setTimeout(load,700);setTimeout(load,1800);
setInterval(function(){if(!document.hidden)load();},5000);
 document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible')setTimeout(load,800);});
})();
