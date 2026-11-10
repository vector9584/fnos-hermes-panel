(function () {
  'use strict';
  var groups = [
    {id:'chat',title:'对话',icon:'chat',pages:[['chat','会话']]},
    {id:'collaboration',title:'协作',icon:'experts',pages:[['experts','专家库'],['rooms','专家讨论'],['plans','任务方案']]},
    {id:'tasks',title:'任务',icon:'cron',pages:[['echo','回声站 ECHO'],['cron','定时任务']]},
    {id:'materials',title:'资料',icon:'kb',pages:[['kb','知识库'],['memory','记忆与记录']]},
    {id:'capabilities',title:'能力',icon:'extensions',pages:[['extensions','技能与工具'],['comm','渠道与连接器']]},
    {id:'models',title:'模型',icon:'models',pages:[['models','模型服务']]},
    {id:'maintenance',title:'维护',icon:'overview',pages:[['overview','运行状态'],['usage','用量统计'],['updates','本地版本']]},
    {id:'settings',title:'设置',icon:'settings',pages:[['settings','偏好设置']]},
  ];
  var activePage='chat',sidebar,secondary,mobile,moreDialog,last={};
  var aliases={connectors:'comm',tunnel:'comm',learning:'kb',flows:'plans'};
  function groupFor(page){return groups.find(function(group){return group.pages.some(function(item){return item[0]===page;});})||groups[0];}
  function navigate(page){window.switchPage(page);}
  function groupTarget(group){return group.pages.some(function(item){return item[0]===last[group.id];})?last[group.id]:group.pages[0][0];}
  function navButton(group,icons){
    var button=document.createElement('button');button.type='button';button.className='nav-btn';button.dataset.group=group.id;button.title=group.title;button.setAttribute('aria-label',group.title);
    if(icons[group.icon])button.append(icons[group.icon].cloneNode(true));
    var label=document.createElement('span');label.textContent=group.title;button.append(label);
    button.onclick=function(){navigate(groupTarget(group));};return button;
  }
  function select(page){
    page=aliases[page]||page;activePage=page;var group=groupFor(page);last[group.id]=page;
    try{localStorage.setItem('panel-navigation',JSON.stringify(last));}catch(_){}
    document.querySelectorAll('[data-group]').forEach(function(button){var active=button.dataset.group===group.id;button.classList.toggle('active',active);if(active)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');});
    var more=mobile.querySelector('.mobile-more');
    var inMore=!['chat','tasks','materials','collaboration'].includes(group.id);
    more.classList.toggle('active',inMore);
    more.textContent=inMore?group.title:'更多';
    more.setAttribute('aria-label',inMore?'更多页面，当前为'+group.title:'更多页面');
    secondary.replaceChildren();secondary.hidden=group.pages.length<2;
    group.pages.forEach(function(item){
      var button=document.createElement('button');button.type='button';button.textContent=item[1];button.className='section-tab';
      if(item[0]===page){button.classList.add('active');button.setAttribute('aria-current','page');}
      button.onclick=function(){navigate(item[0]);};secondary.append(button);
    });
    var toggle=document.getElementById('sidebarToggle');if(toggle)toggle.hidden=page!=='chat';
    if(page!=='chat')sidebar.classList.remove('collapsed');
    if(moreDialog&&moreDialog.open)moreDialog.close();
  }
  function boot(){
    sidebar=document.querySelector('.global-sidebar');if(!sidebar)return;
    var icons={};sidebar.querySelectorAll('button').forEach(function(button){var match=(button.getAttribute('onclick')||'').match(/switchPage\('([^']+)'\)/);if(match&&button.querySelector('svg'))icons[match[1]]=button.querySelector('svg').cloneNode(true);});
    try{last=JSON.parse(localStorage.getItem('panel-navigation')||'{}')||{};}catch(_){}
    sidebar.replaceChildren();sidebar.classList.add('workbench-sidebar');sidebar.setAttribute('aria-label','主要导航');
    var brand=document.createElement('div');brand.className='workbench-wordmark';brand.textContent='H / 工作台';sidebar.append(brand);
    groups.forEach(function(group){var button=navButton(group,icons);if(group.id==='settings')button.classList.add('nav-settings');sidebar.append(button);});
    secondary=document.createElement('nav');secondary.className='section-navigation';secondary.setAttribute('aria-label','分区页面');
    document.querySelector('.global-topbar').insertAdjacentElement('afterend',secondary);
    mobile=document.createElement('nav');mobile.className='mobile-navigation';mobile.setAttribute('aria-label','手机主要导航');
    ['chat','tasks','materials','collaboration'].forEach(function(id){mobile.append(navButton(groups.find(function(group){return group.id===id;}),icons));});
    var more=document.createElement('button');more.type='button';more.className='nav-btn mobile-more';more.textContent='更多';more.setAttribute('aria-haspopup','dialog');
    moreDialog=document.createElement('dialog');moreDialog.className='navigation-dialog';moreDialog.setAttribute('aria-label','全部页面');
    var heading=document.createElement('h2');heading.textContent='前往';moreDialog.append(heading);
    groups.forEach(function(group){var section=document.createElement('section');var title=document.createElement('h3');title.textContent=group.title;section.append(title);group.pages.forEach(function(item){var button=document.createElement('button');button.type='button';button.textContent=item[1];button.onclick=function(){navigate(item[0]);};section.append(button);});moreDialog.append(section);});
    var close=document.createElement('button');close.className='navigation-close';close.textContent='关闭';close.onclick=function(){moreDialog.close();};moreDialog.append(close);
    more.onclick=function(){moreDialog.showModal();};moreDialog.addEventListener('close',function(){more.focus();});
    mobile.append(more);document.body.append(mobile,moreDialog);document.body.classList.add('workbench-navigation');
    document.addEventListener('hermes:page',function(event){select(event.detail.page);});
    window.addEventListener('hashchange',function(){var page=(location.hash.replace(/^#\/?/,'').split('/')[0]||'chat');page=aliases[page]||page;if(page!==activePage&&document.getElementById('page-'+page))navigate(page);});
    function viewportChanged(){
      var viewport=window.visualViewport;
      var focused=document.activeElement;
      var editing=focused&&focused.matches('input,textarea,[contenteditable=true]');
      var keyboard=innerWidth<=768&&viewport&&editing&&innerHeight-viewport.height>140;
      document.body.classList.toggle('mobile-keyboard-open',!!keyboard);
      if(keyboard)document.documentElement.style.setProperty('--visible-height',viewport.height+'px');
      else document.documentElement.style.removeProperty('--visible-height');
    }
    if(window.visualViewport)window.visualViewport.addEventListener('resize',viewportChanged);
    document.addEventListener('focusin',viewportChanged);
    document.addEventListener('focusout',function(){requestAnimationFrame(viewportChanged);});
    var initial=(location.hash.replace(/^#\/?/,'').split('/')[0]||'chat');select(initial);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
}());
