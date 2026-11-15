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
    models:'models-home',
    'models-home':'models-home', 'models-select':'models-select', 'models-providers':'models-providers',
    'models-backends':'models-backends', 'models-toolsets':'models-toolsets', 'models-config':'models-config',
    'models-general':'models-home', 'models-api':'models-home', 'models-aux':'models-home',
    'models-checks':'models-home', 'models-jev':'models-home', 'models-moa':'models-home',
    'models-stt':'models-home', 'models-tts':'models-home'
  };
  return map[seg] || 'chat';
}
function pageFromHash(){
  var h = (location.hash||'').replace(/^#\/?/, '').split('/')[0].toLowerCase();
  if(h==='echo') return 'echo';
  return h ? pageFromPath('/'+h) : 'chat';
}
function switchPage(name){
  // 2026-11-15 二改：模型板块六个域是一级路由（#page-models-home ~ -config），
  // 老入口 'models' 与九个旧 id 统一归一化到 'models-home'，再由 panel-navigation.js
  // 的页签条驱动切换。数据刷新（>60s 重拉）交给 panel-model-v2.js 的 boot()，这里不再兜。
  name = ({models:'models-home','models-general':'models-home','models-api':'models-home',
    'models-aux':'models-home','models-moa':'models-home','models-jev':'models-home',
    'models-stt':'models-home','models-tts':'models-home','models-checks':'models-home',
    'models-caps':'models-home'})[name] || name;
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