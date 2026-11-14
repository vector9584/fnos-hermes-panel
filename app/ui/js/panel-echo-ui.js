(function(){
 'use strict';
 // 回声站（任务队列）已从面板移出，独立成站。
 // 面板里只保留一个入口页，说明去处，不再承载任务列表/提交/状态轮询。
 var page=document.getElementById('page-echo');if(!page)return;
 var head=document.createElement('div');head.className='page-header';
 var title=document.createElement('h1');title.textContent='任务队列';
 head.append(title);
 var body=document.createElement('div');body.className='page-body';
 var card=document.createElement('section');card.className='settings-card';
 var h2=document.createElement('h2');h2.textContent='回声站已移出面板';
 var p=document.createElement('p');p.className='pw-hint';
 p.textContent='任务队列有自己的站点，面板不再重复实现一套列表、提交和状态刷新。面板里只留“定时任务”，那是真正按时间自动跑的那批活。';
 var a=document.createElement('a');a.className='btn primary';a.href='https://example.com/task/';a.target='_blank';a.rel='noopener';a.textContent='打开任务站';
 var foot=document.createElement('p');foot.className='pw-hint';
 foot.textContent='这里的地址只在本机/内网可达时才能打开；外网走你自己的域名。';
 card.append(h2,p,a,foot);body.append(card);
 page.replaceChildren(head,body);
 window.renderEchoPage=function(){};
}());
