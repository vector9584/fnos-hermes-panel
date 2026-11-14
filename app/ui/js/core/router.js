/* 前端路由
 * 来源：index.html 内联 app.js 第 5421-5483 行（共 63 行）
 * 2026-11-13 按原分区纯搬运外移，逻辑零改动。全局作用域与执行顺序与原内联块一致。 */

/* ============================ Router ============================ */
/* URL 直达路由：hash 形式（#/sessions #/files #/models），由 monitor 把子路径 302 到 #/路径。
   子路径下相对资源会解析错位，故页面目标一律走 hash（根路径加载）。 */
function pageFromPath(p){
  p = String(p||'/').split('?')[0].replace(/\/+$/,'') || '/';
  var seg = (p.split('/').filter(Boolean)[0] || 'chat').toLowerCase();
  /* 每加一个 #page-xxx 都要在这里登记，否则 hash 直达会被当成未知路径弹回 chat。
     2026-11-13 之前 rooms 和 8 个 models-* 页就是这样「页面存在但打不开」的。 */
  var map = {
    overview:'overview', chat:'chat', sessions:'chat', files:'chat', dashboard:'chat',
    experts:'experts', extensions:'extensions', comm:'comm', tunnel:'tunnel', kb:'kb',
    /* 2026-11-14：提示词页的页面 id 一直是 assistant，但白名单漏了它，
       #/assistant 直达会被当成未知路径弹回 chat。 */
    assistant:'assistant',
    connectors:'connectors', cron:'cron', memory:'memory', learning:'learning',
    usage:'usage', updates:'updates', settings:'settings', rooms:'rooms',
    models:'models-general',
    'models-general':'models-general', 'models-api':'models-api', 'models-aux':'models-aux',
    'models-checks':'models-checks', 'models-jev':'models-jev', 'models-moa':'models-moa',
    'models-stt':'models-stt', 'models-tts':'models-tts'
  };
  return map[seg] || 'chat';
}
function pageFromHash(){
  var h = (location.hash||'').replace(/^#\/?/, '').split('/')[0].toLowerCase();
  if(h==='echo') return 'echo';
  return h ? pageFromPath('/'+h) : 'chat';
}
function switchPage(name){
  // 2026-11-12：模型服务拆成八个真页面后，老的 'models' 入口（#/models、斜杠命令、工作台按钮）
  // 一律落到通用模型，不再有 #page-models 这个元素。
  if (name === 'models') name = 'models-general';
  // 八个模型页共用同一份数据（renderProviders 一次填满所有槽位）。原来进一次模型页拉一次，
  // 拆成八页后每切一个页签都要重拉 panel-models/auxiliary/catalog/checks 四五个接口，
  // 实测连点 8 个页签打出 42 次请求。这里加 60 秒节流：一分钟内换页签不重拉，
  // 页内的「刷新 / 重新探测」按钮仍然是直接调 renderProviders，不受影响。
  var needProviders = String(name).indexOf('models-')===0 && (Date.now() - (window.__provLoadedAt||0) > 60000);
  if (needProviders) window.__provLoadedAt = Date.now();
  // URL 同步：hash 路由（chat 为默认 → #/），刷新/直达保持页面
  try { location.hash = (name==='chat') ? '#/' : '#/' + name; } catch(e){}
  document.querySelectorAll('.nav-btn').forEach(function(b){ b.classList.remove('active'); });
  var btn=Array.from(document.querySelectorAll('.nav-btn')).find(function(b){ return b.getAttribute('onclick') && b.getAttribute('onclick').includes("'"+name+"'"); });
  if(btn) btn.classList.add('active');
  document.querySelectorAll('.page').forEach(function(p){ p.classList.remove('active'); });
  var p=document.getElementById('page-'+name); if(p) p.classList.add('active');
  var rail=document.getElementById('chatRail');
  if(rail) rail.classList.toggle('hidden', name!=='chat');
  if(name==='connectors') renderConnectors();
  if(name==='comm') renderChannels();
  if(name==='tunnel') renderTunnelPage();
  if(name==='cron') renderCronJobs();
  if(name==='echo') renderEchoPage();
  /* 2026-11-14：留痕录与知识库改由 js/archive/* 接管，页面切换靠下面派发的
     hermes:page 事件驱动，这里不再调旧的 renderMemoryPage / kbLoadTree。 */
  if(name==='learning') renderLearning();
  if(name==='usage') renderUsagePage();
  if(name==='overview') renderOverview();
  if(needProviders) renderProviders();
  if(name==='extensions') renderExtensions();
  if(name==='experts') renderExpertsPage();
  if(name==='rooms'){ ensurePersonasLibrary(mbtiInject); renderRoomsPage(); }
  if(name==='updates' && window.renderMaintenancePage){ renderMaintenancePage(); }
  if(name==='settings') renderSettings();

  document.dispatchEvent(new CustomEvent('hermes:page',{detail:{page:name}}));
  if(name!=='chat'){ hideScrollBtn(); if(_channelViewActive){ _channelViewActive=false; var _rb=document.getElementById('chReturnBtn'); if(_rb) _rb.style.display='none'; } }
}

/* ============================ 知识库 ============================
   旧的 Obsidian 风格多级树实现已于 2026-11-11 移除：
   1) 静态挂载点 #kbTree / #kbViewer 在 js/panel-library-ui.js 的 mount() 里
      被 [...page.children].filter(n=>n!==header).forEach(n=>n.remove()) 清掉；
   2) 入口 kbLoadTree / kbOpenNote / kbNewNote 三个被该模块重新赋值到新视图；
   3) 其余 kbRenderTree/kbToggleDir/kbViewNote/kbFindNotePath/kbEditNote/kbSaveNote/
      kbCancelEdit/kbDeleteNote/kbLoadBacklinks 仅被上面这些死函数互相调用。
   旧代码 12 个函数 + 4 个全局变量共 8,955 字节，实际不可达，已删除。
   现行实现：panel-library-ui.js（来源下拉 + 文件夹列表 + 文档编辑 + 关系图）。 */