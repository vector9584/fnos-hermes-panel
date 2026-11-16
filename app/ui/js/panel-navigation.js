(function () {
  'use strict';
  var groups = [
    {id:'chat',title:'对话',icon:'chat',pages:[['chat','会话']]},
    {id:'collaboration',title:'协作',icon:'experts',pages:[['experts','专家库'],['rooms','专家讨论'],['plans','任务方案']]},
    {id:'tasks',title:'任务',icon:'cron',pages:[['cron','定时任务']]},
    /* 2026-11-13 三改（用户定名）：三个大类 = 提示词 / 知识库 / 留痕录。
       一级组叫「档案」统住三者：怎么写、知道什么、做过什么。
       页面 id 保持 kb/memory 不变，深链 #/kb、#/memory 不断。 */
    {id:'materials',title:'档案',icon:'kb',pages:[['assistant','提示词'],['kb','知识库'],['memory','留痕录']]},
    {id:'capabilities',title:'能力',icon:'extensions',pages:[['comm','消息渠道'],['connectors','外接工具'],['toolsets','工具集'],['skills','技能']]},
    // 2026-11-12：模型服务原来是单页 + 页内 .ui-tabs 八分区（两套导航语言，与协作页对不上）。
    // 现在八个分区就是八个真页面，顶部页签直接列八项，页内底槽撤掉。
    /* 2026-11-15 二改（用户定）：模型板块六个域就是六个真页面（一级路由），
       顶部页签条直接列六项，页内按钮切换撤掉。概览/模型选择/服务商/能力后端/工具集/配置
       各自 #page-models-*，由 panel-model-v2.js 按 data-domain 渲染。 */
    {id:'models',title:'模型',icon:'models',pages:[
      ['models-home','概览'],['models-select','模型选择'],['models-providers','服务商'],
      ['models-backends','能力后端'],['models-config','配置']
    ]},
    {id:'maintenance',title:'维护',icon:'overview',pages:[['overview','运行状态'],['usage','用量统计'],['updates','本地版本']]},
    {id:'settings',title:'设置',icon:'settings',pages:[['settings','偏好设置']]},
  ];
  var activePage='chat',sidebar,secondary,mobile,moreDialog,last={},_pressTarget=null;
  // models 是老入口（斜杠命令、工作台按钮、#/models 深链都还这么调），统一落到模型板块第一个子页「概览」；
  // 重构前那九个旧页签 id 也一并落到这里，旧书签不至于 404。
  var aliases={extensions:'connectors',mcp:'connectors','models-toolsets':'toolsets',tunnel:'comm',learning:'kb',flows:'plans',
    models:'models-home','models-general':'models-home','models-api':'models-home','models-aux':'models-home','models-moa':'models-home',
    'models-jev':'models-home','models-stt':'models-home','models-tts':'models-home','models-checks':'models-home','models-caps':'models-home'};
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
    // 2026-11-12 模板统一：页签条不再按"是否多页"决定显不显示。
    // 老逻辑单页组隐藏 → 模型服务/定时任务/偏好设置 顶部没有页签条，H1 直接顶到 y=71；
    // 协作/扩展多页组有页签条，H1 在 y=135。同一套面板两种页头，用户一眼就看出来割裂。
    // 现在恒显示：所有页面都是「页签条 → H1 → 说明 → 内容」同一顺序、同一高度。
    /* 2026-11-13 用户第 40 条：「会话面板顶部那个会话按钮不要了，本来就一个 tab 也不会切换」。
       统一判据——只有一个页面的组不出页签条，空间让给内容（会话树直接顶到顶栏下沿）。
       多页组照旧显示，页签仍是切页入口。 */
    secondary.replaceChildren();secondary.hidden=group.pages.length<2;
    group.pages.forEach(function(item){
      var button=document.createElement('button');button.type='button';button.textContent=item[1];button.className='section-tab';
      if(item[0]===page){button.classList.add('active');button.setAttribute('aria-current','page');}
      button.onclick=function(){navigate(item[0]);};secondary.append(button);
    });
    // 页面 H1 单一真源：直接用上面这排页签的当前项，不再各页手写（扩展/通讯/模型 三个旧标题
    // 就是这么和页签漂开的：页签叫「技能与工具」，标题还写着「扩展」）。
    var label=(group.pages.filter(function(item){return item[0]===page;})[0]||group.pages[0])[1];
    function applyTitle(){
      var pageEl=document.getElementById('page-'+page);if(!pageEl)return;
      var h1=pageEl.querySelector('.page-header h1');
      if(h1&&h1.textContent!==label)h1.textContent=label;
    }
    applyTitle();setTimeout(applyTitle,0);setTimeout(applyTitle,120);
    // 页内分区条不管 HTML 里叫什么容器（ch-filterbar / skill-subtabs / ext-tabs…），
    // 只要有 .ui-tab 就自动套上 .ui-tabs 的底槽，免得下回又漏掉一条、长成裸按钮。
    document.querySelectorAll('.ui-tab').forEach(function(t){var box=t.parentElement;if(box&&!box.classList.contains('ui-tabs'))box.classList.add('ui-tabs');});
    syncRailToggle(page);

    if(page!=='chat')sidebar.classList.remove('collapsed');
    if(moreDialog&&moreDialog.open)moreDialog.close();
  }
  /* 顶栏这颗折叠按钮两个页面共用（2026-11-15 用户驳回档案页自造 ☰ 之后）：
     对话页它开关会话树，档案三页（提示词/知识库/留痕录）它开关资料树。
     档案页桌面端左栏常驻，不需要按钮，只在窄屏（≤900，和 archive.css 同一档）露出来。
     这里只负责显隐；点下去干什么由 toggleRail() 分派。
     ⚠️ 显隐是重点：display:none 的按钮 element.click() 照样触发事件，
     只验"点了有效果"会漏掉"人根本看不见它"——上一版就是这么交付给用户的。 */
  function syncRailToggle(page){
    var toggle=document.getElementById('sidebarToggle');
    if(!toggle)return;
    page=page||activePage;
    var arcPage=page==='assistant'||page==='kb'||page==='memory';
    var narrow=window.matchMedia?window.matchMedia('(max-width:900px)').matches:window.innerWidth<=900;
    toggle.hidden=!(page==='chat'||(arcPage&&narrow));
    var open=arcPage&&window.Archive&&window.Archive.railDrawerOpen?!!window.Archive.railDrawerOpen():false;
    toggle.setAttribute('aria-expanded',String(open));
    if(arcPage&&narrow)toggle.title=open?'收起资料目录':'展开资料目录';
    /* 切回对话页时把档案页留下的标题换掉，否则会出现"对话页按钮写着展开资料目录" */
    else if(page==='chat'){var rail=document.getElementById('chatRail');toggle.title=(rail&&!rail.classList.contains('hidden'))?'折叠会话树':'展开会话树';}
    /* 图标也跟着页走：从档案页切回对话页，档案那边留在按钮上的是「收起」图标，
       对话页抽屉明明是关的，看着就像点了没反应。applyRailState 会按真实开合重算图标。 */
    if(page==='chat'&&typeof applyRailState==='function')applyRailState();
  }
  function boot(){
    sidebar=document.querySelector('.global-sidebar');if(!sidebar)return;
    var icons={};sidebar.querySelectorAll('button').forEach(function(button){var match=(button.getAttribute('onclick')||'').match(/switchPage\('([^']+)'\)/);if(match&&button.querySelector('svg'))icons[match[1]]=button.querySelector('svg').cloneNode(true);});
    try{last=JSON.parse(localStorage.getItem('panel-navigation')||'{}')||{};}catch(_){}
    sidebar.replaceChildren();sidebar.classList.add('workbench-sidebar');sidebar.setAttribute('aria-label','主要导航');
    var brand=document.createElement('div');brand.className='workbench-wordmark';
    brand.setAttribute('aria-label','Hermes');
    brand.innerHTML='<img class="wb-logo wb-logo-dark" src="images/logo-cat-full-dark.png?v=1" alt="Hermès">'
                  + '<img class="wb-logo wb-logo-light" src="images/logo-cat-full-light.png?v=1" alt="Hermès">';
    sidebar.append(brand);
    groups.forEach(function(group){var button=navButton(group,icons);if(group.id==='settings')button.classList.add('nav-settings');sidebar.append(button);});
    secondary=document.createElement('nav');secondary.className='section-navigation';secondary.setAttribute('aria-label','分区页面');
    document.querySelector('.global-topbar').insertAdjacentElement('afterend',secondary);
    mobile=document.createElement('nav');mobile.className='mobile-navigation';mobile.setAttribute('aria-label','手机主要导航');
    ['chat','tasks','materials','collaboration'].forEach(function(id){mobile.append(navButton(groups.find(function(group){return group.id===id;}),icons));});
    var more=document.createElement('button');more.type='button';more.className='nav-btn mobile-more';more.textContent='更多';more.setAttribute('aria-haspopup','dialog');
    moreDialog=document.createElement('dialog');moreDialog.className='navigation-dialog';moreDialog.setAttribute('aria-label','全部页面');
    // 关闭钮必须在头部常驻：之前排在文档流末尾，85dvh 一超就得滚到底才看得见
    var head=document.createElement('div');head.className='navigation-head';
    var heading=document.createElement('h2');heading.textContent='前往';
    var close=document.createElement('button');close.type='button';close.className='navigation-close';close.innerHTML='&times;';close.setAttribute('aria-label','关闭');close.onclick=function(){moreDialog.close();};
    head.append(heading,close);moreDialog.append(head);
    var bodyEl=document.createElement('div');bodyEl.className='navigation-body';moreDialog.append(bodyEl);
    groups.forEach(function(group){
      if(!group.pages||!group.pages.length)return;
      var section=document.createElement('section');
      var title=document.createElement('h3');title.textContent=group.title;section.append(title);
      var grid=document.createElement('div');grid.className='navigation-grid';
      group.pages.forEach(function(item){
        var button=document.createElement('button');button.type='button';button.textContent=item[1];
        button.onclick=function(){moreDialog.close();navigate(item[0]);};
        grid.append(button);
      });
      section.append(grid);bodyEl.append(section);
    });
    more.onclick=function(e){
      // 键盘期硬闸（2026-11-12）：输入中底部导航本就收起，此时任何落到「更多」上的
      // click（合成事件、重排后的误触、回车）一律当误触。用户报的就是「输着字弹前往」。
      if(document.body.classList.contains('mobile-keyboard-open'))return;
      // 幽灵点击防护（2026-11-12）：手机端输完字点发送，键盘收起时页面重排，
      // 这一次 tap 的 click 会落到重排后新占位的元素上 —— 正好是「更多」，
      // 于是「前往」页莫名其妙弹出来。只认真正从「更多」上按下去的点击。
      if(!(e&&e.detail===0)&&_pressTarget&&_pressTarget!==more&&!more.contains(_pressTarget))return;
      moreDialog.showModal();heading.setAttribute('tabindex','-1');heading.focus();};moreDialog.addEventListener('close',function(){more.focus();});
    mobile.append(more);document.body.append(mobile,moreDialog);document.body.classList.add('workbench-navigation');
    // 记录按下位置：onclick 时用它判断这次点击是不是真的落在「更多」上
    document.addEventListener('pointerdown',function(e){_pressTarget=e.target;},true);
    document.addEventListener('touchstart',function(e){_pressTarget=e.target;},{capture:true,passive:true});
    document.addEventListener('hermes:page',function(event){select(event.detail.page);});
    /* 旋转屏幕 / 分屏 / 拉窗口跨过 900px 时，顶栏那颗按钮要跟着出现或消失；
       只在切页时算一次，用户横屏回竖屏就得切页才回来。 */
    var _railTimer=null;
    window.addEventListener('resize',function(){clearTimeout(_railTimer);_railTimer=setTimeout(function(){syncRailToggle(activePage);},150);});
    window.addEventListener('hashchange',function(){var page=(location.hash.replace(/^#\/?/,'').split('/')[0]||'chat');page=aliases[page]||page;if(page!==activePage&&document.getElementById('page-'+page))navigate(page);});
    /* 视口变化（2026-11-17 修「首次点输入框，输入框直接飞到最上面」）
       根因：focusin 在键盘弹出**之前**触发，此刻 visualViewport.height 还是旧值，
       部分 WebView 初始化阶段甚至给 0 —— 于是 --visible-height 被写成 0px，
       .app 高度跟着塌成 79px，composer 是 absolute bottom:0，就贴着 header 站住了。
       第二次再来时 visualViewport 已经稳定，所以「只有第一次坏」。
       两道处理：① focusin 延后一拍再算；② 读到的值先过可信性校验，0 和离谱小值一律不信。 */
    var _vpTimer=null;
    function viewportChanged(delay){
      clearTimeout(_vpTimer);
      if(delay){ _vpTimer=setTimeout(applyViewport,delay); return; }
      applyViewport();
    }
    function applyViewport(){
      var viewport=window.visualViewport;
      var focused=document.activeElement;
      var editing=!!(focused&&focused.matches('input,textarea,[contenteditable=true]'));
      var narrow=innerWidth<=768;
      var vh=viewport?viewport.height:0;
      /* 可信判据：小于 240px，或比 innerHeight 小三成以上，都不是真实视口 */
      var vhOk=vh>240&&vh>=innerHeight*0.35;
      var shrink=vhOk?Math.max(0,innerHeight-vh):0;
      // 输入期间底部导航一律收起（2026-11-12）：原来只认「视口缩了 140px 以上」，
      // 但部分 Android/iOS WebView 的 visualViewport 不跟着键盘缩，
      // 导航条就留在原位置和输入区抢地，敲字时一碰就弹「前往」页。
      var keyboard=narrow&&(editing||shrink>140);
      document.body.classList.toggle('mobile-keyboard-open',keyboard);
      if(keyboard&&vhOk&&shrink>140)document.documentElement.style.setProperty('--visible-height',Math.round(vh)+'px');
      else document.documentElement.style.removeProperty('--visible-height');
    }
    if(window.visualViewport)window.visualViewport.addEventListener('resize',function(){viewportChanged(0);});
    /* 键盘弹出要 100~300ms，focusin 时还是旧视口，等 80ms 再取一次 */
    document.addEventListener('focusin',function(){viewportChanged(80);});
    document.addEventListener('focusout',function(){requestAnimationFrame(function(){viewportChanged(0);});});
    /* 底部导航自动收起（2026-11-17）
       平时收起，输入框沉到底，跟画板模式同一位置。拉到底之后继续往下拉一次，
       导航滑出来 1 秒，app 让出 64px、输入框被顶上去，一秒后缓落回去。
       画板模式由 CSS 直接 display:none，不参与这套。 */
    (function bindNavReveal(){
      var bodyEl=document.getElementById('chatBody');
      if(!bodyEl||!('ontouchstart' in window))return;
      var bottomY=null,timer=null;
      function reveal(){
        document.body.classList.add('nav-revealed');
        clearTimeout(timer);
        timer=setTimeout(function(){document.body.classList.remove('nav-revealed');},2000);
      }
      /* 到底判定必须覆盖两种可能：内容滚在 #chatBody 里，或者 #chatBody 被撑开、
         真正滚动的是页面本身（iOS 上 100dvh 抖动时就会变成后者）。
         只认 #chatBody 一个容器的话，真机上会永远判成「没到底」，怎么拉都不出。 */
      function atBottom(){
        var TOL=24;                       /* iOS 惯性滚动停下常差几像素，8px 太苛刻 */
        var de=document.documentElement;
        /* 短会话兜底（2026-11-17 用户：「对于会话本身短的来说滑动面板没有效果，出不来」）：
           内容撑不满一屏时 scrollHeight≈clientHeight，永远等不到「滚到底」这个事件，
           于是怎么拉都不出。不可滚本身就是「到底」——直接认。 */
        var bodyScrollable=bodyEl.scrollHeight-bodyEl.clientHeight>TOL;
        var pageScrollable=de.scrollHeight-(window.innerHeight||de.clientHeight)>TOL;
        if(!bodyScrollable && !pageScrollable) return true;
        if(bodyScrollable){
          var g1=bodyEl.scrollHeight-bodyEl.scrollTop-bodyEl.clientHeight;
          if(g1<TOL) return true;
        }
        var sy=window.scrollY||de.scrollTop||0;
        var g2=de.scrollHeight-sy-(window.innerHeight||de.clientHeight);
        if(pageScrollable && g2<TOL) return true;
        return false;
      }
      function cvMode(){ return document.body.classList.contains('cv-mode'); }

      /* 触底后「继续向上拉」才唤出 —— 2026-11-17 真机第二轮反馈改的：
         ① 只认向上拉（clientY 减小）。触底之后往下滑是「回看旧消息」的手势，
            弹菜单属于打扰。上一版图省事写成 Math.abs 双向判定，
            真机当场就被否了（「触底之后往下滑他也会弹出来」）。
         ② 阈值 110px（先 24、再 70，用户仍说「现在还是敏感，出来的距离再大一点」）。
            24px 是手指打个哆嗦的距离；70px 依然抬手就出。他要的是「多拉一段才出来」，
            不是动画变慢 —— 动的始终是距离，不是时长。
         ③ 删掉了原来的「触底即唤出」那一路。滚到底松手、手指随便一落就弹，
            正是「太敏感」的另一半来源。现在认的是真实的上拉动作。 */
      var PULL_THRESHOLD=110;
      document.addEventListener('touchstart',function(ev){
        if(ev.touches.length!==1||cvMode())return;
        /* 落下时已经贴底就先记基准，省得头一次 touchmove 只用来定基准、白吃一段位移 */
        bottomY = atBottom() ? ev.touches[0].clientY : null;
      },{passive:true,capture:true});

      /* 基准取「贴底那一帧」的 Y：到底时手指早从 700 移到 480 了，
         拿 touchstart 的起点当基准只会算出负位移，永远凑不够阈值（第一轮拉不出的元凶）。 */
      document.addEventListener('touchmove',function(ev){
        if(ev.touches.length!==1||cvMode())return;
        if(!atBottom()){bottomY=null;return;}
        var y=ev.touches[0].clientY;
        if(bottomY===null){bottomY=y;return;}
        if(bottomY-y>PULL_THRESHOLD){reveal();bottomY=y;}
      },{passive:true,capture:true});
      document.addEventListener('touchend',function(){bottomY=null;},{passive:true,capture:true});

      /* 点击顶部 CHATÈS 词标也唤出（2026-11-17 用户要求）。
         滑动是最容易失手的那条路：短会话没得滑、戴手套、列表卡在动画里都拉不出来。
         给一个「想找菜单就点一下顶部」的确定性入口，比调灵敏度靠谱。
         不拦默认事件 —— 词标本身还挂着连接状态文案的点击语义。 */
      var brand=document.getElementById('brandLogo');
      if(brand){
        brand.addEventListener('click',function(){
          if(cvMode()) return;
          if(!('ontouchstart' in window) && window.innerWidth>900) return;
          reveal();
        },false);
      }
    })();
    var initial=(location.hash.replace(/^#\/?/,'').split('/')[0]||'chat');select(initial);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
}());
