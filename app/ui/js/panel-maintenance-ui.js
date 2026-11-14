(function(){
  'use strict';
  var selected='',ref='',next=null,busy=false,generation=0,activity=null,pickedDay='',actSeq=0;
  var TYPE_LABEL={feat:'新功能',fix:'修问题',refactor:'重构',docs:'文档',test:'测试',audit:'审计',chore:'杂务',style:'样式',perf:'性能',build:'构建',ci:'流水线',revert:'回滚','其他':'其他'};
  function el(tag,text,cls){var node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node;}
  function pad(n){return n<10?'0'+n:''+n;}
  function ymd(date){return date.getFullYear()+'-'+pad(date.getMonth()+1)+'-'+pad(date.getDate());}
  function addDays(date,offset){return new Date(date.getFullYear(),date.getMonth(),date.getDate()+offset);}
  async function request(path){var response=await fetch(apiUrl(path),{headers:{'X-Monitor-Token':monitorToken||''}});var body=await response.json();if(!response.ok||!body.ok)throw Error(body.error||'读取版本记录失败');return body;}
  function feedback(message){document.getElementById('maintenanceFeedback').textContent=message;}
  function controls(){document.getElementById('maintenanceRefresh').disabled=busy;document.getElementById('maintenanceMore').disabled=busy;}
  async function history(append){
    if(busy)return;busy=true;controls();var ticket=++generation;
    var list=document.getElementById('maintenanceHistory'),more=document.getElementById('maintenanceMore');
    if(!append){list.replaceChildren();ref='';next=null;more.hidden=true;}feedback('正在读取提交记录…');
    try{
      var data=await request('/api/maintenance/history?repo='+encodeURIComponent(selected)+(append?'&ref='+ref+'&offset='+next:''));
      if(ticket!==generation)return;ref=data.ref;next=data.next;
      data.commits.forEach(function(commit){
        var item=el('article',undefined,'maintenance-commit');item.append(el('h2',commit.subject));
        var meta=el('div',undefined,'maintenance-meta');meta.append(el('code',commit.hash.slice(0,12)),el('span',commit.author),el('time',new Date(commit.date).toLocaleString()));item.append(meta);
        if(commit.body){var details=el('details');details.append(el('summary','查看提交说明'),el('pre',commit.body));item.append(details);}list.append(item);
      });
      if(!list.children.length)list.append(el('p','此仓库没有提交记录。'));
      more.hidden=next===null;feedback('已显示 '+list.children.length+' 条提交 · 快照 '+ref.slice(0,12));
    }catch(error){feedback(error.message);}
    finally{busy=false;controls();}
  }

  /* ── 提交活跃度：GitHub 式热力图 + 统计条 + 类型分布 + 点日期看当天提交 ── */
  function chip(label,value,warn){
    var node=el('span','',('maint-chip')+(warn?' is-warn':''));
    node.append(el('b',value),el('em',label));return node;
  }
  function sinceText(day){
    var at=Date.parse(day+'T00:00:00');if(!at)return day;
    var days=Math.round((Date.now()-at)/86400000);
    if(days<=0)return '今天';if(days===1)return '昨天';return days+' 天前';
  }
  function quantiles(values){
    var sorted=values.slice().sort(function(a,b){return a-b;});
    if(!sorted.length)return [1,2,3];
    var pick=function(p){return sorted[Math.min(sorted.length-1,Math.max(0,Math.floor(p*sorted.length)))];};
    return [pick(0.25),pick(0.5),pick(0.75)];
  }
  function level(count,cut){
    if(!count)return 0;
    if(count<=cut[0])return 1;if(count<=cut[1])return 2;if(count<=cut[2])return 3;return 4;
  }
  function renderSummary(){
    var box=document.getElementById('maintActivitySummary');if(!box)return;
    var daily=activity.daily||{},today=activity.today||ymd(new Date());
    var weekStart=addDays(new Date(today+'T00:00:00'),-new Date(today+'T00:00:00').getDay());
    var week=0;for(var i=0;i<7;i++){week+=daily[ymd(addDays(weekStart,i))]||0;}
    box.replaceChildren(
      chip('近一年提交',activity.total),
      chip('今日',daily[today]||0),
      chip('本周',week),
      chip('当前连续',activity.current+' 天',activity.current===0),
      chip('最长连续',activity.longest+' 天'),
      chip('最后提交',activity.last?sinceText(activity.last.day):'无'));
  }
  function renderHeat(){
    var grid=document.getElementById('maintHeatmap'),months=document.getElementById('maintMonths');
    if(!grid)return;
    var daily=activity.daily||{};
    var counts=Object.keys(daily).map(function(key){return daily[key];});
    var cut=quantiles(counts);
    var today=new Date();today.setHours(0,0,0,0);
    var start=addDays(today,-364);start=addDays(start,-start.getDay());
    var weeks=Math.round((today-start)/86400000/7)+1;
    grid.style.setProperty('--weeks',weeks);
    grid.replaceChildren();
    var frag=document.createDocumentFragment(),labelFrag=document.createDocumentFragment(),runs=[],lastKey='';
    for(var w=0;w<weeks;w++){
      var first=addDays(start,w*7),key=first.getFullYear()+'-'+first.getMonth();
      if(key!==lastKey){runs.push({label:(first.getMonth()+1)+'月',span:0});lastKey=key;}
      runs[runs.length-1].span++;
    }
    runs.forEach(function(run){var label=el('span',run.label,'maint-month');label.style.gridColumn='span '+run.span;labelFrag.append(label);});
    for(var w=0;w<weeks;w++){
      for(var d=0;d<7;d++){
        var date=addDays(start,w*7+d),day=ymd(date),count=daily[day]||0;
        var cell=el('i',undefined,'maint-cell');
        if(date>today){cell.className+=' is-future';cell.setAttribute('aria-hidden','true');}
        else{
          cell.dataset.day=day;cell.dataset.count=String(count);
          cell.className+=' lv'+level(count,cut)+(day===pickedDay?' is-picked':'');
          cell.setAttribute('role','button');cell.tabIndex=count||day===pickedDay?0:-1;
          cell.setAttribute('aria-label',day+' '+count+' 次提交');
        }
        frag.append(cell);
      }
    }
    grid.append(frag);
    if(months){months.replaceChildren(labelFrag);months.style.setProperty('--weeks',weeks);}
  }
  function renderTypes(){
    var box=document.getElementById('maintTypeBars');if(!box)return;
    var types=activity.types||[];
    box.replaceChildren();
    if(!types.length){box.append(el('p','暂无提交类型数据。','pw-hint'));return;}
    var max=types.reduce(function(top,item){return Math.max(top,item.count);},1);
    types.forEach(function(item){
      var row=el('div',undefined,'maint-type');
      var bar=el('span',undefined,'maint-type-bar');bar.style.width=Math.max(2,Math.round(item.count/max*100))+'%';
      var track=el('span',undefined,'maint-type-track');track.append(bar);
      row.append(el('b',TYPE_LABEL[item.key]||item.key),track,el('em',String(item.count)));
      box.append(row);
    });
  }
  function renderDayList(){
    var box=document.getElementById('maintDayList');if(!box)return;
    if(!pickedDay){box.hidden=true;box.replaceChildren();return;}
    var rows=(activity.commits||[]).filter(function(item){return item[0]===pickedDay;});
    box.hidden=false;box.replaceChildren();
    var head=el('div',undefined,'maint-day-head');
    head.append(el('strong',pickedDay+' · '+rows.length+' 次提交'));
    var clear=el('button','清除','ov-actbtn');clear.type='button';
    clear.onclick=function(){pickedDay='';renderDayList();renderHeat();};
    head.append(clear);box.append(head);
    if(!rows.length){box.append(el('p','这一天没有提交。','pw-hint'));return;}
    var list=el('div',undefined,'maint-day-list');
    rows.slice(0,40).forEach(function(item){
      var row=el('div',undefined,'maint-day-row');row.append(el('code',item[1]),el('span',item[2]));list.append(row);
    });
    if(rows.length>40)list.append(el('p','仅显示前 40 条。','pw-hint'));
    box.append(list);
  }
  function renderActivity(){
    var root=document.getElementById('maintenanceActivity');
    if(!root)return;
    if(!activity){root.hidden=true;return;}
    root.hidden=false;renderSummary();renderHeat();renderTypes();renderDayList();
  }
  async function loadActivity(){
    if(!selected)return;
    var ticket=++actSeq,root=document.getElementById('maintenanceActivity');
    try{
      var data=await request('/api/maintenance/activity?repo='+encodeURIComponent(selected));
      if(ticket!==actSeq)return;
      activity=data;pickedDay='';renderActivity();
    }catch(error){
      if(ticket!==actSeq)return;
      activity=null;if(root){root.hidden=false;document.getElementById('maintHeatmap').replaceChildren();
        document.getElementById('maintActivitySummary').replaceChildren();
        document.getElementById('maintTypeBars').replaceChildren(el('p',error.message,'pw-hint'));}
    }
  }
  function tip(){
    var node=document.getElementById('maintHeatTip');
    if(!node){node=el('div',undefined,'maint-tip');node.id='maintHeatTip';node.hidden=true;document.body.append(node);}
    return node;
  }
  function bindHeat(){
    var grid=document.getElementById('maintHeatmap');
    if(!grid||grid.dataset.bound)return;
    grid.dataset.bound='1';
    grid.addEventListener('mouseover',function(event){
      var cell=event.target.closest('.maint-cell');if(!cell||!cell.dataset.day)return;
      var box=tip(),day=cell.dataset.day,count=Number(cell.dataset.count)||0;
      box.replaceChildren(el('strong',day+(day===activity.today?' · 今天':'')),el('span',count?count+' 次提交':'没有提交'));
      if(count){
        var rows=(activity.commits||[]).filter(function(item){return item[0]===day;}).slice(0,5);
        rows.forEach(function(item){box.append(el('em',item[1]+' '+item[2]));});
        if(count>rows.length)box.append(el('em','还有 '+(count-rows.length)+' 条…'));
      }
      box.hidden=false;
      var rect=cell.getBoundingClientRect(),width=box.offsetWidth;
      var left=Math.min(window.innerWidth-width-12,Math.max(12,rect.left+rect.width/2-width/2));
      box.style.left=left+'px';
      box.style.top=Math.max(12,rect.top-box.offsetHeight-10)+'px';
    });
    grid.addEventListener('mouseout',function(event){
      if(!event.target.closest('.maint-cell'))return;
      tip().hidden=true;
    });
    grid.addEventListener('click',function(event){
      var cell=event.target.closest('.maint-cell');if(!cell||!cell.dataset.day)return;
      pickedDay=pickedDay===cell.dataset.day?'':cell.dataset.day;
      renderDayList();renderHeat();
    });
    grid.addEventListener('keydown',function(event){
      if(event.key!=='Enter'&&event.key!==' ')return;
      var cell=event.target.closest('.maint-cell');if(!cell||!cell.dataset.day)return;
      event.preventDefault();cell.click();
    });
  }

  window.renderMaintenancePage=async function(){
    if(busy)return;busy=true;controls();feedback('正在读取本地仓库状态…');
    try{
      var data=await request('/api/maintenance/repositories'),tabs=document.getElementById('maintenanceRepositories');tabs.replaceChildren();
      if(!data.repositories.some(function(repo){return repo.id===selected&&repo.available;}))selected=(data.repositories.find(function(repo){return repo.available;})||{}).id||'';
      data.repositories.forEach(function(repo){
        var card=el('button',undefined,'maintenance-repository');card.type='button';card.disabled=!repo.available;card.setAttribute('aria-pressed',String(repo.id===selected));
        card.append(el('strong',repo.name),el('span',repo.available?(repo.changes?repo.changes+' 项未提交变更':'工作区无未提交变更'):repo.error));
        if(repo.available)card.append(el('code',repo.head.slice(0,12)));
        card.onclick=function(){if(busy)return;selected=repo.id;try{localStorage.setItem('panel-maintenance-repository',selected);}catch(_){}tabs.querySelectorAll('button').forEach(function(button){button.setAttribute('aria-pressed',String(button===card));});history(false);loadActivity();};tabs.append(card);
      });
      if(!selected){document.getElementById('maintenanceHistory').replaceChildren();document.getElementById('maintenanceMore').hidden=true;feedback('未能读取代码仓库，请检查上方状态后重试。');}
    }catch(error){feedback(error.message);selected='';}
    finally{busy=false;controls();}
    if(selected){await history(false);await loadActivity();}
  };
  try{selected=localStorage.getItem('panel-maintenance-repository')||'';}catch(_){}
  document.getElementById('maintenanceRefresh').onclick=window.renderMaintenancePage;
  document.getElementById('maintenanceMore').onclick=function(){history(true);};
  bindHeat();
}());
