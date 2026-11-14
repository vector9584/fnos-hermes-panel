/* 概览页
 * 来源：index.html 内联 app.js 第 5694-6152 行（共 459 行）
 * 2026-11-13 按原分区纯搬运外移，逻辑零改动。全局作用域与执行顺序与原内联块一致。 */

/* ============================ 概览 ============================ */
var _connecting = false;  // 重启/启动/停止进行中，保持「连接中」琥珀态，避免闪烁离线
function setBrandConnection(state,label){
  /* 绿 = 真的能发消息。网关进程在跑（/api/status 报 running）但端口还没应答时
     不能亮绿——那 30~70 秒正是启动蒙版挡着的时候，点绿着、输入区却挡着，
     自相矛盾（用户 2026-11-12：出现时机要和标题三色状态统一）。
     __gwPortOk 由启动蒙版模块探测 /api/gateway/health 写入；null=还没探过，放行。 */
  /* 绿的唯一含义：网关端口真的应答了、并且启动蒙版已经撤走。__bootMaskHold 没清之前，
     概览轮询看见「进程 running」就点绿也没用——输入区还挡着，点了就是骗人。 */
  if(state==='online' && (window.__gwPortOk===false || window.__bootMaskHold)){ state='connecting'; label='连接中'; }
  var dot=document.getElementById('brandDot');
  var text=document.getElementById('brandConnectionText');
  var logo=document.getElementById('brandLogo');
  if(dot&&dot.className!=='brand-dot '+state)dot.className='brand-dot '+state;
  /* 词标颜色跟着状态走：绿=原墨色，橙/红/灰同步；连不上的未知态归 idle（灰） */
  if(logo){
    var conn=(state==='online'||state==='connecting'||state==='offline')?state:'idle';
    if(logo.dataset.conn!==conn) logo.dataset.conn=conn;
  }
  if(text){
    var className='brand-connection '+state;
    if(text.className!==className)text.className=className;
    if(text.textContent!==label)text.textContent=label;
  }
  /* 广播给启动蒙版：一个状态机，两处显示，谁也不是自己臆测的 */
  try{ window.dispatchEvent(new CustomEvent('hermes:conn',{detail:{state:state,label:label}})); }catch(e){}
}
/* 顶栏版本号：显示「你自己提交的那个提交」——面板源码仓库 HEAD 的 7 位短 sha。
   数据走本机 /api/maintenance/*（git rev-parse，无外网、不烧 GitHub 配额）；
   有未提交改动时药丸带一个 * ；标题里给全 sha / 时间 / 提交说明；点一下复制全号。
   为什么不用匿名 GitHub API：NAS 出口 IP 是共享的，60 次/小时早被别的活吃光——今天实测就撞了 403，
   药丸一直挂在「--」上，比不显示还糟。 */
function applyPanelVer(d){
  var el=document.getElementById('brandVer'); if(!el) return;
  el.textContent=(d.sha||'--')+(d.changes?'*':'');
  var full='面板源码仓库 '+(d.full||d.sha||'');
  if(d.changes) full+='（'+d.changes+' 处未提交改动，未算进这版）';
  if(d.date) full+='\n'+String(d.date).replace('T',' ').slice(0,16)+' · '+(d.subject||'');
  if(window.__APP_VER__) full+='\nfnOS 包 v'+window.__APP_VER__;
  el.title=full;
  el.onclick=function(){
    var txt=d.full||d.sha||'';
    if(!txt) return;
    try{ navigator.clipboard.writeText(txt); if(window.ui&&ui.toast) ui.toast('已复制提交号 '+d.sha); }
    catch(e){ if(window.ui&&ui.toast) ui.toast('提交号 '+txt); }
  };
}
function loadPanelVersion(){
  var el=document.getElementById('brandVer'); if(!el) return;
  fetch('api/maintenance/repositories',{cache:'no-store'}).then(function(r){
    if(!r.ok) throw new Error('HTTP '+r.status);
    return r.json();
  }).then(function(j){
    var repo=((j&&j.repositories)||[]).filter(function(x){return x.id==='panel';})[0];
    if(!repo||!repo.available||!repo.head) throw new Error('no head');
    var d={sha:repo.head.slice(0,7),full:repo.head,changes:repo.changes||0,date:'',subject:''};
    applyPanelVer(d);
    return fetch('api/maintenance/history?repo=panel',{cache:'no-store'}).then(function(r){
      return r.ok?r.json():null;
    }).then(function(h){
      var c=((h&&h.commits)||[])[0];
      if(c&&c.hash===repo.head){ d.date=c.date; d.subject=c.subject||''; applyPanelVer(d); }
    }).catch(function(){});
  }).catch(function(){ /* 未登录或接口不可用：留「--」，不拿 fnOS 包 build 号冒充版本 */ });
}
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',function(){ setTimeout(loadPanelVersion,900); });
else setTimeout(loadPanelVersion,900);

function applyServiceState(s){
  var gw = !!(s.gateway && s.gateway.running);
  var db = !!(s.dashboard && s.dashboard.running);
  _services = { gateway:gw, dashboard:db };
  // 动作进行中且服务尚未就绪：保持连接中（琥珀），不要闪离线
  if(_connecting && !(gw||db)){
    var b0=document.getElementById('ovStatusBadge'); var t0=document.getElementById('ovStatusText');
    if(b0) b0.className='ov-status connecting';
    if(t0) t0.textContent='连接中…';
    var f0=document.getElementById('overviewStatusFeedback');
    if(f0) f0.textContent='正在等待服务恢复';
    setBrandConnection('connecting','连接中');
    return;
  }
  _connecting = false;
  var badge=document.getElementById('ovStatusBadge');
  var txt=document.getElementById('ovStatusText');
  if(badge) badge.className='ov-status '+(gw||db?'on':'off');
  if(txt) txt.textContent=(gw||db)?'运行中':'已停止';
  var feedback=document.getElementById('overviewStatusFeedback');
  if(feedback) feedback.textContent=(gw||db)?'服务运行中：'+(gw?'Gateway':'')+(gw&&db?'、':'')+(db?'Dashboard':''):( '服务未启动');
  setBrandConnection(gw?'online':'offline',gw?'已连接':(db?'网关未连接':'已停止'));
  setToggle('gwToggle', gw); setToggle('dbToggle', db);
  var gsp=document.getElementById('gwStateText'); if(gsp) gsp.textContent= gw?'运行中':'未启动';
  var dsp=document.getElementById('dbStateText'); if(dsp) dsp.textContent= db?'运行中':'未启动';
  // 端口随服务端配置动态显示（v0.20.65 端口迁移到 8742/9219，避免与同机 hermes-studio 的 8642 冲突）
  var gport = (s.gateway && s.gateway.port) || 8742;
  var dport = (s.dashboard && s.dashboard.port) || 9219;
  var gpe=document.getElementById('gwPort'); if(gpe) gpe.textContent=gport;
  var dpe=document.getElementById('dbPort'); if(dpe) dpe.textContent=dport;
  // 系统信息：统一走 ID，避免 querySelectorAll 索引错位；优先使用服务端已格式化的 s.uptime
  var upEl=document.getElementById('sysUptime');
  if(upEl){
    if(s.uptime!=null){ upEl.textContent=s.uptime; }
    else if(s.uptimeMs!=null){ upEl.textContent=fmtUptime(s.uptimeMs); }
  }
  var memEl=document.getElementById('sysMem');
  if(memEl && s.memoryKB!=null){ memEl.textContent=Math.round(s.memoryKB/1024)+' MB'; }
  var hvEl=document.getElementById('sysHermesVer');
  if(hvEl && s.gateway && s.gateway.version){ hvEl.textContent=fmtHermesVer(s.gateway.version, s.hermes_version_date); }
  var avEl=document.getElementById('sysAppVer');
  if(avEl && s.app_version){ avEl.textContent=s.app_version; }
  if(s.app_version){ window.__APP_VER__ = s.app_version; }
  // 顶栏版本只认「仓库最新提交 sha」；不拿 fnOS 包 build 号顶位置（那是另一个东西，混着显示必然看不懂）
  var hermCur=document.getElementById('hermesCurrent');
  if(hermCur && s.gateway && s.gateway.version){ hermCur.textContent=fmtHermesVer(s.gateway.version, s.hermes_version_date); }
  var appCur=document.getElementById('appCurrent');
  if(appCur && s.app_version){ appCur.textContent='v'+s.app_version; }
}
/* 状态抖动闸门：单次探测失败不等于离线——iOS 从后台回前台、切网、代理重连都会丢一两包，
   一次失败就点亮「离线」会在 3 秒后自己变回「已连接」，纯粹吓人。
   规则：第一次失败回落成琥珀「连接中」，连续两次失败（≥6s）才判离线；任一成功清零。 */
var _statusFails = 0;
function statusAlive(){ _statusFails = 0; }
function statusMissed(){
  _statusFails++;
  if(_statusFails >= 2){
    /* 2026-11-13 第 50 条：蒙版在位时它是断连这条线唯一的出口。这里再把徽标打成「离线」，
       就是同一件事两个出口各说一套（用户原话：整个面板的状态要统一出口，不要各做一套）。
       蒙版收走（__bootMaskActive=false）之后，才轮到这里判离线。 */
    if(window.__bootMaskActive){ setBrandConnection('connecting','连接中'); return; }
    if(!_connecting) setStatusOffline();
  }
  else { setBrandConnection('connecting','连接中'); }
}
function renderOverview(){
  apiGet('/api/status').then(function(s){
    if(!s || s.error){ statusMissed(); return; }
    statusAlive();
    applyServiceState(s);
    // 初始化日志过滤区折叠状态（手机端默认收起，电脑端始终展开）
    initLogFilterToggle();
    // 同步多会话标签栏可见性（仅左侧折叠时显示）
    syncSessionTabsVisibility();
    // 默认加载 Monitor 日志（仅首次）
    if(!_logInited){ _logInited=true; setTimeout(function(){ appendLog('monitor','Monitor 日志'); }, 100); }
  }).catch(function(){ statusMissed(); });
}
// 轻量级状态轮询：只更新顶栏状态点与服务卡片，不重渲染日志/系统信息区块（避免打断日志查看）
function tickStatus(){
  apiGet('/api/status').then(function(s){
    if(!s || s.error){ statusMissed(); return; }
    statusAlive();
    applyServiceState(s);
  }).catch(function(){ statusMissed(); });
}
function setStatusOffline(){
  var badge=document.getElementById('ovStatusBadge'); var txt=document.getElementById('ovStatusText');
  if(badge) badge.className='ov-status off';
  if(txt) txt.textContent='离线';
  var feedback=document.getElementById('overviewStatusFeedback');
  if(feedback) feedback.textContent='服务离线，暂时无法读取运行状态';
  setBrandConnection('offline','离线');
  setToggle('gwToggle',false); setToggle('dbToggle',false);
  var gsp=document.getElementById('gwStateText'); if(gsp) gsp.textContent='未启动';
  var dsp=document.getElementById('dbStateText'); if(dsp) dsp.textContent='未启动';
}
function fmtHermesVer(ver, date){
  if(!ver || ver==='--') return ver;
  if(/\(\d{4}\.\d{1,2}\.\d{1,2}\)/.test(ver)) return ver;
  if(date && ver.indexOf(date)===-1) return ver+' ('+date+')';
  return ver;
}
function fmtUptime(ms){
  // 服务端 uptimeMs 为毫秒；统一转换为秒再格式化
  var sec = Math.floor((Number(ms)||0)/1000);
  var d=Math.floor(sec/86400); sec%=86400;
  var h=Math.floor(sec/3600); sec%=3600;
  var m=Math.floor(sec/60);
  var parts=[];
  if(d>0) parts.push(d+'天');
  if(h>0) parts.push(h+'小时');
  parts.push(m+'分钟');
  return parts.join(' ');
}
function setToggle(id, on){ var t=document.getElementById(id); if(t){t.classList.toggle('on', !!on);t.setAttribute('aria-checked',String(!!on));} }
function toggleService(name){
  var running = name==='dashboard' ? _services.dashboard : _services.gateway;
  if(running){ stopServices(name); } else { startServices(name); }
}
function serviceActionError(result, which){
  if(!result) return '服务没有返回结果';
  if(result.error || result.ok===false) return result.error || '服务操作失败';
  var names=which?[which]:['gateway','dashboard'];
  for(var i=0;i<names.length;i++){
    var child=result[names[i]];
    if(child && (child.ok===false || child.error)) return child.error || (names[i]==='gateway'?'Gateway':'Dashboard')+' 操作失败';
  }
  return '';
}
function waitForServiceState(desired, which, actionLabel){
  var attempts=0,maxAttempts=15,lastStatus=null;
  return new Promise(function(resolve){
    function check(){
      attempts++;
      apiGet('/api/status').then(function(s){
        if(s&&!s.error){
          lastStatus=s;
          var names=which?[which]:['gateway','dashboard'];
          var matched=names.every(function(name){return !!(s[name]&&s[name].running)===desired;});
          if(matched){applyServiceState(s);toast((which==='dashboard'?'Dashboard':which==='gateway'?'Gateway':'服务')+(desired?'已启动':'已停止'));resolve(true);return;}
        }
        if(attempts>=maxAttempts){if(lastStatus)applyServiceState(lastStatus);_connecting=false;toast(actionLabel+'请求已提交，但状态仍未确认，请刷新状态后核对');resolve(false);return;}
        setTimeout(check,1000);
      }).catch(function(){
        if(attempts>=maxAttempts){if(lastStatus)applyServiceState(lastStatus);_connecting=false;toast(actionLabel+'请求已提交，但暂时无法读取服务状态');resolve(false);return;}
        setTimeout(check,1000);
      });
    }
    check();
  });
}
function waitForApplicationRestart(){
  var attempts=0,maxAttempts=45;
  function check(){
    attempts++;
    apiGet('/api/panel-runtime/status').then(function(state){
      if(state&&!state.error){
        if(state.restart?.status==='failed'){_connecting=false;toast(state.restart.error||'应用重启未完成，请检查运行状态');return;}
        if(state.ready){_connecting=false;toast('应用已恢复运行');tickStatus();return;}
      }
      if(attempts>=maxAttempts){_connecting=false;toast('已提交应用重启，但尚未确认恢复；请刷新查看运行状态');return;}
      setTimeout(check,2000);
    }).catch(function(){
      if(attempts>=maxAttempts){_connecting=false;toast('应用重启恢复状态暂不可用，请刷新查看运行状态');return;}
      setTimeout(check,2000);
    });
  }
  setTimeout(check,1000);
}
function startServices(which){
  var path = which==='dashboard' ? '/api/dashboard/start' : '/api/start';
  _connecting = true;
  apiPost(path, {}).then(function(r){
    var error=serviceActionError(r,which);
    if(error){ toast('启动失败：'+error); _connecting=false; return; }
    toast('正在启动'+(which?(' '+which):'服务'));
    waitForServiceState(true,which,'启动');
  }).catch(function(e){ toast('启动请求失败：'+e.message); _connecting=false; });
}
function stopServices(which){
  var path = which==='dashboard' ? '/api/dashboard/stop' : '/api/stop';
  _connecting = true;
  apiPost(path, {}).then(function(r){
    var error=serviceActionError(r,which);
    if(error){ toast('停止失败：'+error); _connecting=false; return; }
    toast('正在停止'+(which?(' '+which):'服务'));
    waitForServiceState(false,which,'停止');
  }).catch(function(e){ toast('停止请求失败：'+e.message); _connecting=false; });
}
function restartServices(){
  _connecting = true;
  apiPost('/api/restart', {}).then(function(r){ if(r && (r.error||r.ok===false)){ toast('重启失败：'+(r.error||'服务操作失败')); _connecting=false; } else {toast('重启已提交，正在等待服务恢复');waitForApplicationRestart();} }).catch(function(e){ toast('重启请求失败：'+e.message); _connecting=false; });
}
function pollStatus(){
  var tries=0;
  (function check(){
    tries++;
    apiGet('/api/status').then(function(s){
      if(s && !s.error){
        var gw=!!(s.gateway&&s.gateway.running), db=!!(s.dashboard&&s.dashboard.running);
        if(gw||db||tries>=15){ _services={gateway:gw,dashboard:db}; renderOverview(); }
        else setTimeout(check, 1000);
      } else if(tries<15){ setTimeout(check,1000); }
    }).catch(function(){ if(tries<15) setTimeout(check,1000); });
  })();
}
function openDashboard(){ window.open(BASE + '/proxy/dashboard/', '_blank'); }
function refreshSysInfo(){
  apiGet('/api/status').then(function(s){
    if(!s || s.error) return;
    var upEl=document.getElementById('sysUptime');
    if(upEl){
      if(s.uptime!=null){ upEl.textContent=s.uptime; }
      else if(s.uptimeMs!=null){ upEl.textContent=fmtUptime(s.uptimeMs); }
    }
    var memEl=document.getElementById('sysMem');
    if(memEl && s.memoryKB!=null){ memEl.textContent=Math.round(s.memoryKB/1024)+' MB'; }
  }).catch(function(){});
}
// 日志查看器状态：与 dashboard/logs 对齐（来源、级别、组件、行数、关键词）
var _logState = {
  source: 'monitor',
  level: 'all',
  component: 'all',
  lines: 100,
  keyword: '',
  rawLines: [],
  titleMap: { monitor:'Monitor 日志', agent:'Agent 日志', gui:'GUI 日志', error:'错误日志', gateway:'Gateway 日志', gateway_restart:'Gateway 重启记录', gateway_close:'Gateway 关闭诊断', gateway_exit:'Gateway 退出诊断', all:'全部日志' },
  fileMap: { monitor:'hermes.log', agent:'agent.log', gui:'gui.log', error:'errors.log', gateway:'gateway.log', gateway_restart:'gateway-restart.log', gateway_close:'gateway-shutdown-diag.log', gateway_exit:'gateway-exit-diag.log' },
  sourceFiles: {
    monitor: ['monitor'], agent: ['agent'], gateway: ['gateway'], error: ['error'], gui: ['gui'],
    gateway_restart: ['gateway_restart'], gateway_close: ['gateway_close'], gateway_exit: ['gateway_exit'],
    all: ['monitor','agent','gateway','error','gui','gateway_restart','gateway_close','gateway_exit']
  }
};
function setLogSource(s){ _logState.source=s||'monitor'; applyLogFilters(true); }
function setLogLevel(l){ _logState.level=l||'all'; applyLogFilters(false); }
function setLogComponent(c){ _logState.component=c||'all'; applyLogFilters(false); }
function setLogLines(n){ _logState.lines=parseInt(n)||100; applyLogFilters(true); }
function clearLogKeyword(){ var k=document.getElementById('logKeyword'); if(k) k.value=''; _logState.keyword=''; applyLogFilters(false); }

// 手机端折叠/展开日志过滤区（电脑端无按钮，过滤区始终可见）
function toggleLogFilters(){
  var bar=document.getElementById('ovLogBar');
  var btn=document.getElementById('ovLogFilterToggle');
  var lbl=document.getElementById('ovLogFilterToggleLabel');
  if(!bar||!btn) return;
  var open=!bar.classList.contains('open');
  bar.classList.toggle('open', open);
  btn.classList.toggle('on', open);
  btn.setAttribute('aria-expanded', String(open));
  if(lbl) lbl.textContent = open ? '收起日志过滤' : '显示日志过滤';
  try { localStorage.setItem('hermes_log_filter_open', open?'true':'false'); } catch(e){}
}
// 启动时根据 localStorage + 屏幕宽度决定初始状态
function initLogFilterToggle(){
  var bar=document.getElementById('ovLogBar');
  var btn=document.getElementById('ovLogFilterToggle');
  var lbl=document.getElementById('ovLogFilterToggleLabel');
  if(!bar||!btn) return;
  var open=false;
  try { open = localStorage.getItem('hermes_log_filter_open')==='true'; } catch(e){}
  bar.classList.toggle('open', open);
  btn.classList.toggle('on', open);
  btn.setAttribute('aria-expanded', String(open));
  if(lbl) lbl.textContent = open ? '收起日志过滤' : '显示日志过滤';
}
function applyLogFilters(refetch){
  var k=document.getElementById('logKeyword');
  _logState.keyword = k ? k.value : '';
  updateLogFilterUI();
  if(refetch){ fetchLogLines(); return; }
  renderLogLines();
}
function updateLogFilterUI(){
  document.querySelectorAll('[data-log-source]').forEach(function(b){ b.classList.toggle('active', b.getAttribute('data-log-source')===_logState.source); });
  document.querySelectorAll('[data-log-level]').forEach(function(b){ b.classList.toggle('active', b.getAttribute('data-log-level')===_logState.level); });
  document.querySelectorAll('[data-log-comp]').forEach(function(b){ b.classList.toggle('active', b.getAttribute('data-log-comp')===_logState.component); });
  document.querySelectorAll('[data-log-lines]').forEach(function(b){ b.classList.toggle('active', parseInt(b.getAttribute('data-log-lines'))===_logState.lines); });
}
function fetchLogLines(){
  var pre=document.getElementById('logPre'); if(!pre) return;
  pre.innerHTML='[ 加载日志中… ]';
  var files = _logState.sourceFiles[_logState.source] || [_logState.source];
  var pending = files.length;
  var all = [];
  files.forEach(function(tag){
    var file = _logState.fileMap[tag] || 'hermes.log';
    fetch(apiUrl('/api/logs/read?file='+encodeURIComponent(file)+'&lines='+encodeURIComponent(_logState.lines)), { cache:'no-store', headers: monitorToken?{'X-Monitor-Token':monitorToken}:{} })
      .then(function(r){ return r.json(); })
      .then(function(d){ (d && d.lines||[]).forEach(function(l){ all.push({tag:tag, line:l}); }); })
      .catch(function(){})
      .finally(function(){ pending--; if(pending===0){ _logState.rawLines=all; renderLogLines(); } });
  });
}
function detectLogLevel(line){
  var m = String(line).match(/\b(DEBUG|INFO|WARNING|WARN|ERROR|CRITICAL|FATAL)\b/i);
  if(!m) return '';
  var lvl = m[1].toLowerCase();
  if(lvl==='warn') return 'warning';
  if(lvl==='critical' || lvl==='fatal') return 'error';
  return lvl;
}
function detectLogComponent(line){
  var s = String(line);
  var m = s.match(/\b(?:DEBUG|INFO|WARNING|WARN|ERROR|CRITICAL|FATAL)\s+([a-zA-Z0-9_\.]+)/i);
  var logger = m ? m[1].toLowerCase() : '';
  if(logger.indexOf('gateway')>=0) return 'gateway';
  if(logger.indexOf('agent')>=0) return 'agent';
  if(logger.indexOf('cron')>=0) return 'cron';
  if(logger.indexOf('cli')>=0 || logger.indexOf('hermes_cli')>=0) return 'cli';
  if(logger.indexOf('tool')>=0 || /\b(tool_|plugin|mcp)\b/i.test(s)) return 'tools';
  return '';
}
function renderLogLines(){
  var pre=document.getElementById('logPre'); if(!pre) return;
  var titleEl=document.getElementById('logBoxTitle'); if(titleEl) titleEl.textContent = _logState.titleMap[_logState.source] || '日志';
  var kwLower = (_logState.keyword||'').toLowerCase();
  var filtered = _logState.rawLines.filter(function(item){
    var lvl = detectLogLevel(item.line);
    var comp = detectLogComponent(item.line) || item.tag;
    if(_logState.level!=='all' && lvl!==_logState.level) return false;
    if(_logState.component!=='all' && comp!==_logState.component) return false;
    if(kwLower && String(item.line).toLowerCase().indexOf(kwLower)<0) return false;
    return true;
  });
  if(!filtered.length){ pre.innerHTML = '[ 无匹配日志 ]'; pre.scrollTop = 0; return; }
  // 倒序：最新日志排在最上方（Issue：日志排版用倒序）
  pre.innerHTML = filtered.slice().reverse().map(function(item){
    var lvl = detectLogLevel(item.line);
    return lvl ? '<span class="log-'+lvl+'">'+esc(item.line)+'</span>' : esc(item.line);
  }).join('\n');
  pre.scrollTop = 0;
}
function appendLog(tag, msg){
  // 兼容旧入口：设置来源并重新拉取
  _logState.source = tag || 'monitor';
  var k=document.getElementById('logKeyword'); if(k) k.value='';
  _logState.keyword='';
  applyLogFilters(true);
}
var _logClearUndo=[];
function refreshLogClearUndo(){return api('/api/logs/clear/undo').then(function(result){_logClearUndo=Array.isArray(result.items)?result.items:[];renderLogClearUndo();return _logClearUndo;}).catch(function(error){var button=document.getElementById('logUndoBtn');if(button){button.hidden=false;button.textContent='撤销记录暂不可用';button.title=error.message;}return _logClearUndo;});}
function renderLogClearUndo(){var button=document.getElementById('logUndoBtn');if(!button)return;button.hidden=!_logClearUndo.length;button.textContent=_logClearUndo.length?'撤销清空 ('+_logClearUndo.length+')':'撤销清空';button.title=_logClearUndo.map(function(item){return item.file;}).join('、');}
async function restoreClearedLogs(){
  var items=_logClearUndo.slice();if(!items.length){await refreshLogClearUndo();items=_logClearUndo.slice();if(!items.length)return;}
  var button=document.getElementById('logUndoBtn');if(button)button.disabled=true;
  var results=await Promise.all(items.map(async function(item){try{var result=await api('/api/logs/restore','POST',{id:item.id});if(!result||result.ok!==true)throw Error(result&&result.error||'服务端未确认恢复');return {item:item,ok:true};}catch(error){return {item:item,ok:false,error:error&&error.message?error.message:String(error)};}}));
  var failed=results.filter(function(result){return !result.ok;});
  _logClearUndo=failed.map(function(result){return result.item;});
  if(failed.length)toast('恢复失败 '+failed.length+' 条：'+failed.map(function(result){return result.item.file;}).join('、')+'；请查看日志状态后重试');else toast('已恢复 '+results.length+' 个日志文件');
  await refreshLogClearUndo();fetchLogLines();if(button)button.disabled=false;
}
async function clearLog(){
  var tags = _logState.sourceFiles[_logState.source] || [_logState.source];
  var files = tags.map(function(tag){ return _logState.fileMap[tag] || 'hermes.log'; });
  var uniqueFiles = Array.from(new Set(files));
  if(!uniqueFiles.length) return;
  var label = uniqueFiles.length===1 ? uniqueFiles[0] : uniqueFiles.length+' 个日志文件';
  if(!(await ui.confirm('确定清空 '+label+'？成功后可在日志栏撤销。', {danger:true}))) return;
  var results = await Promise.all(uniqueFiles.map(async function(file){
    try{
      var result = await api('/api/logs/clear','POST',{file:file});
      if(!result || result.ok!==true) throw new Error((result&&result.error)||'服务端未确认清空');
      return {file:file,ok:true,undo_id:result.undo_id};
    }catch(error){ return {file:file,ok:false,error:error&&error.message?error.message:String(error),undo_id:error&&error.undo_id||null}; }
  }));
  var changed=results.filter(function(result){return result.undo_id;});
  if(changed.length)await refreshLogClearUndo();
  var failed = results.filter(function(result){ return !result.ok; });
  if(failed.length){
    var detail=failed.map(function(result){return result.file+(result.undo_id?'（内容可能已改变，撤销项已保留）':'');}).join('、');
    toast('清空失败 '+failed.length+'/'+results.length+' 个文件：'+detail);
  }else{
    toast('已清空 '+label+'，可撤销');
  }
  fetchLogLines();
}
function toggleLogRefresh(){
  var t=document.getElementById('logRefreshToggle');
  if(!t) return;
  t.classList.toggle('on');t.setAttribute('aria-checked',String(t.classList.contains('on')));
  if(t.classList.contains('on')){
    startLogStream();
  } else {
    stopLogStream();
  }
}
function startLogStream(){
  stopLogStream();
  try {
    _logStream = new EventSource(apiUrl('/api/logs'));
    _logStream.addEventListener('log', function(e){ if(e.data){ var pre=document.getElementById('logPre'); if(pre){ pre.textContent = (pre.textContent?pre.textContent+'\n':'')+e.data; pre.scrollTop=pre.scrollHeight; } } });
    _logStream.onerror = function(){ stopLogStream(); };
  } catch(e){ toast('日志流不可用'); }
}
function stopLogStream(){ if(_logStream){ try{_logStream.close();}catch(e){} _logStream=null; } }