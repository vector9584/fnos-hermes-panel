/* 定时任务管理
 * 来源：index.html 内联 app.js 第 7548-7655 行（共 108 行）
 * 2026-11-13 按原分区纯搬运外移，逻辑零改动。全局作用域与执行顺序与原内联块一致。 */
/* ============================ 定时任务管理 ============================ */
var _cronJobs = [];
function renderCronJobs(){
  var el = document.getElementById('cronJobList'); if(!el) return;
  apiGet('/api/cron-jobs').then(function(res){
    if(!res || !res.ok){ el.innerHTML='<div class="empty-state" role="alert" aria-live="assertive">加载失败</div>'; return; }
    var _allJobs = res.jobs || [];
    var cronWebhooks = res.webhooks || {};
    // 一次性任务跑完自动收起：定时页只显示待执行的 + 周期任务
    // （2026-11-04 用户反馈：定时页被历史 once 卡片刷满）
    _cronJobs = _allJobs.filter(function(j){
      if(j.panel_archived) return !!window._cronShowArchived;
      if(window._cronShowDone) return true;
      var once = (j.schedule && j.schedule.kind === 'once')
              || String(j.repeat || '').indexOf('once') >= 0
              || (j.repeat && j.repeat.times === 1);
      var done = (j.state === 'completed') || (j.enabled === false && j.last_run_at);
      return !(once && done);
    });
    var _hiddenDone = _allJobs.filter(function(job){ return !job.panel_archived && _cronJobs.indexOf(job)<0; }).length;
    var _doneBar = _hiddenDone
      ? '<div style="font-size:11px;color:var(--text3);margin-bottom:8px">已收起 '+_hiddenDone+' 条已完成的一次性任务 · <a href="javascript:void 0" onclick="window._cronShowDone=true;renderCronJobs()" style="color:#22c55e">查看</a></div>'
      : '';
    if(!_cronJobs.length){ el.innerHTML = _doneBar + '<div class="empty-state">尚无待执行的定时任务。点右上角「+ 创建任务」开始配置。</div>'; return; }
    var delIcons = { local:'💾', origin:'💬', weixin:'💬', telegram:'✈️', discord:'🎮', feishu:'📘', dingtalk:'📱', wecom:'💼' };
    el.innerHTML = _doneBar + _cronJobs.map(function(j){
      var id = j.id || j.job_id || '';
      var name = j.name || j.prompt || '未命名任务';
      if(name.length > 60) name = name.slice(0,60) + '…';
      var schedule = j.schedule || j.cron || '';
      // schedule 可能为对象（{kind,expr/at}）或异常值（"[object Object]"），统一提取为可读字符串
      if(schedule && typeof schedule === 'object'){ schedule = schedule.kind === 'interval' ? '每 '+schedule.minutes+' 分钟' : schedule.expr || schedule.run_at || schedule.at || ''; }
      if(typeof schedule !== 'string' || !schedule || schedule === '[object Object]' || schedule === 'undefined' || schedule === 'null') schedule = '';
      var paused = j.state === 'paused' || j.enabled === false || j.paused || j.status === 'paused';
      var skills = j.skills || j.attached_skills || [];
      var _dv = j.deliver != null ? j.deliver : j.deliver_to != null ? j.deliver_to : j.delivery;
      var deliver = (typeof _dv === 'string') ? (_dv || 'local')
        : (_dv && typeof _dv === 'object') ? String(_dv.channel || _dv.name || _dv.type || _dv.kind || 'local')
        : 'local';
      if(deliver === '[object Object]' || deliver === 'undefined' || deliver === 'null') deliver = 'local';
      var nextRun = j.next_run_at ? new Date(j.next_run_at).toLocaleString('zh-CN') : '';
      var lastRun = j.last_run_at ? new Date(j.last_run_at).toLocaleString('zh-CN') : '';
      var lastStatus = j.last_status || '';
      var lastError = j.last_error || '';
      var completed = j.state === 'completed';
      var accent = completed ? 'var(--text3)' : paused ? '#f59e0b' : '#22c55e';
      if(j.panel_archived){
        return '<div class="mcp-card disabled"><div class="mcp-card-head"><div class="mcp-name">'+esc(name)+'</div><span>已归档</span></div><p>任务与执行记录已保留，当前不会自动运行。</p><button class="ov-actbtn" onclick="openCronHistory(\''+esc(id)+'\')">执行记录</button><button class="ov-actbtn" onclick="cronAction(\''+esc(id)+'\',\'restore\')">恢复归档</button></div>';
      }
      // 状态 pill（参考 Octop CronJobCard：圆点 + 状态色）
      var statusPill = '<span style="display:inline-flex;align-items:center;gap:5px;font-size:10px;padding:2px 9px;border-radius:10px;color:'+accent+';background:'+accent+'1a;font-weight:600;letter-spacing:.2px">'+
        '<span style="width:6px;height:6px;border-radius:50%;background:'+accent+'"></span>'+(completed?'已完成':paused?'已暂停':'等待调度')+'</span>';
      // Webhook 投递通道状态（monitor 轮询转发）
      var hooks = (cronWebhooks[id] || []).filter(function(h){ return h && h.url; });
      var hookHtml = '';
      if(hooks.length){
        hookHtml = hooks.map(function(h){
          var hok = h.last_status === 'ok', herr = h.last_status === 'error';
          var color = herr ? '#ef4444' : (hok ? '#22c55e' : 'var(--text3)');
          var state = herr ? '失败' : (hok ? '已投递' : '等待');
          return '<span style="font-size:11px;color:var(--text3)">🔗 '+esc(h.label || 'Webhook')+' <b style="color:'+color+'">'+state+'</b>'+
            (herr && h.last_error ? ' <span title="'+DOM.escAttr(h.last_error)+'" style="cursor:help;color:#ef4444">⚠️</span>' : '')+'</span>';
        }).join('<span style="color:var(--border)">|</span>');
      }
      return '<div class="mcp-card'+(paused?' disabled':'')+'" style="border-left:3px solid '+accent+'">' +
        '<div class="mcp-card-head"><div class="mcp-name">⏰ '+esc(name)+'</div><div class="mcp-badges">'+statusPill+'</div></div>' +
        '<div class="mcp-detail" style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-top:6px;min-width:0">'+
          '<code style="font-size:11px;background:var(--bg1);border:1px solid var(--border);border-radius:4px;padding:2px 7px;font-family:monospace;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle">'+esc(schedule)+'</code>'+
          '<span style="font-size:11px;color:var(--text3)">'+(delIcons[deliver]||'📨')+' 投递: '+esc(deliver)+'</span>'+
        '</div>' +
        (skills.length ? '<div class="mcp-tools-info" style="margin-top:4px">📚 技能: '+esc(skills.join(', '))+'</div>' : '') +
        (hookHtml ? '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:4px">'+hookHtml+'</div>' : '') +
        '<div style="font-size:11px;color:var(--text3);display:flex;gap:14px;flex-wrap:wrap;margin-top:4px">' +
          (nextRun ? '<span>⏭ 下次: '+esc(nextRun)+'</span>' : '') +
          (lastRun ? '<span>⏮ 上次: '+esc(lastRun)+'</span>' : '') +
          (lastStatus ? '<span>执行: <b style="color:'+(lastStatus==='ok'?'#22c55e':(lastStatus==='error'?'#ef4444':'var(--text3)'))+'">'+esc(({ok:'成功',success:'成功',error:'失败'})[lastStatus]||lastStatus)+'</b></span>' : '') +
        '</div>' +
        (lastStatus==='error' && lastError ? '<div style="font-size:11px;color:#ef4444;background:#ef44441a;border-radius:6px;padding:5px 9px;margin-top:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+DOM.escAttr(lastError)+'">⚠️ '+esc(lastError)+'</div>' : '') +
        (j.last_delivery_error ? '<div style="font-size:12px;color:var(--warning);overflow-wrap:anywhere;margin-top:8px">渠道投递失败：'+esc(j.last_delivery_error)+'</div>' : '') +
        '<div class="mcp-actions cron-actions">' +
          '<button class="ov-actbtn" onclick="openCronHistory(\''+esc(id)+'\')">执行记录</button>' +
          '<button class="ov-actbtn" onclick="openCronModalById(\''+esc(id)+'\')">编辑</button>' +
          '<button class="ov-actbtn" onclick="openCronHooks(\''+esc(id)+'\')">Webhook 投递</button>' +
          (completed ? '' : paused ? '<button class="ov-actbtn start" onclick="cronAction(\''+esc(id)+'\',\'resume\')">恢复</button>' : '<button class="ov-actbtn" onclick="cronAction(\''+esc(id)+'\',\'pause\')">暂停</button>') +
          '<button class="ov-actbtn" onclick="cronAction(\''+esc(id)+'\',\'run\')">安排执行</button>' +
          '<button class="ov-actbtn" onclick="cronAction(\''+esc(id)+'\',\'archive\')">归档</button>' +
        '</div></div>';
    }).join('');
  }).catch(function(){ el.innerHTML='<div class="empty-state">加载失败</div>'; });
}
async function cronAction(jobId, action){
  if(action==='archive' && !(await ui.confirm('归档后停止后续调度，任务与执行记录会保留，可以恢复。已开始的执行不会被终止。'))) return;
  if(action==='restore' && !(await ui.confirm('恢复归档前的调度状态？已到期的任务可能在下一次调度时执行。'))) return;
  if(window._cronActionBusy) return;
  window._cronActionBusy=true;
  toast('正在处理任务…');
  fetch(apiUrl('/api/cron-jobs/'+encodeURIComponent(jobId)+'/action'), {
    method:'POST', headers:{'Content-Type':'application/json','X-Monitor-Token':monitorToken||''}, body: JSON.stringify({action:action})
  }).then(function(r){ return r.json(); }).then(function(res){
    if(res.ok){ toast({pause:'已暂停后续调度',resume:'已恢复调度',run:'已安排在下一次调度检查时执行',archive:'已归档，可在归档列表中恢复',restore:'已恢复归档前的调度状态'}[action]||'操作成功'); renderCronJobs(); } else toast(res.error||'操作失败','error');
  }).catch(function(e){ toast('连接中断，请刷新核对任务状态','error'); }).finally(function(){window._cronActionBusy=false;});
}
function openCronModalById(id){
  var job = (_cronJobs||[]).find(function(j){ return (j.id||j.job_id)===id; });
  if(job) openCronModal(job);
  else toast('未找到任务','error');
}
function openCronModal(job){ return window.openCronEditor(job); }