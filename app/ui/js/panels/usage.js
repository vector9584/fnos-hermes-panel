/* Token 用量 + 用量统计
 * 来源：index.html 内联 app.js 第 7689-7780 行（共 92 行）
 * 2026-11-13 按原分区纯搬运外移，逻辑零改动。全局作用域与执行顺序与原内联块一致。 */

/* ============================ Token 用量 ============================ */
function renderUsageCard(){
  apiGet('/api/usage').then(function(res){
    if(!res || !res.ok || !res.usage){ return; }
    var u = res.usage;
    var el;
    el=document.getElementById('usageSessions'); if(el) el.textContent = u.total_sessions||0;
    el=document.getElementById('usageMessages'); if(el) el.textContent = u.total_messages||0;
    var models = u.by_model || [];
    el=document.getElementById('usageModels'); if(el) el.textContent = new Set(models.filter(function(row){return row.model;}).map(function(row){return row.model;})).size;
    el=document.getElementById('usageByModel');
    if(el && models.length){
      el.innerHTML = models.map(function(info){
        return '<div style="display:flex;justify-content:space-between;padding:2px 0"><span>'+esc(info.model || (info.historical?'历史汇总未分配模型':'执行记录未保存模型'))+'</span><span>'+Number(info.total_tokens).toLocaleString()+' tokens</span></div>';
      }).join('');
    }
  }).catch(function(){});
}

/* ============================ 用量统计页 ============================ */
function renderUsagePage(){
  var cardsEl = document.getElementById('usageSummaryCards');
  var modelSection = document.getElementById('usageByModelSection');
  var modelList = document.getElementById('usageByModelList');
  var dailySection = document.getElementById('usageDailySection');
  var dailyBody = document.getElementById('usageDailyBody');
  var emptyEl = document.getElementById('usageEmpty');
  
  cardsEl.innerHTML = '<div class="usage-card"><div class="usage-card-label">加载中...</div></div>';
  modelSection.style.display = 'none';
  dailySection.style.display = 'none';
  emptyEl.style.display = 'none';
  
  apiGet('/api/usage').then(function(res){
    if(!res || !res.ok || !res.usage){
      cardsEl.innerHTML = '';
      emptyEl.textContent = res && res.error || '执行记录暂时无法读取，请重试';
      emptyEl.style.display = '';
      return;
    }
    var u = res.usage;
    var totalSessions = u.total_sessions || 0;
    var totalMessages = u.total_messages || 0;
    var models = u.by_model || [];
    var totals = u.totals || {};
    var coverage = u.coverage || {};
    function money(value){return value==null?'未记录金额':'$'+Number(value).toFixed(4);}
    
    // 汇总卡片
    cardsEl.innerHTML = 
      '<div class="usage-card"><div class="usage-card-label">总会话数</div><div class="usage-card-value">'+totalSessions+'</div></div>' +
      '<div class="usage-card"><div class="usage-card-label">总消息数</div><div class="usage-card-value">'+totalMessages+'</div></div>' +
      '<div class="usage-card"><div class="usage-card-label">输入 tokens</div><div class="usage-card-value">'+Number(totals.input_tokens || 0).toLocaleString()+'</div></div>' +
      '<div class="usage-card"><div class="usage-card-label">输出 tokens</div><div class="usage-card-value">'+Number(totals.output_tokens || 0).toLocaleString()+'</div></div>' +
      '<div class="usage-card"><div class="usage-card-label">模型调用次数</div><div class="usage-card-value">'+Number(totals.api_call_count || 0).toLocaleString()+'</div></div>' +
      '<div class="usage-card"><div class="usage-card-label">已记录估算费用（部分）</div><div class="usage-card-value">'+money(totals.estimated_cost_usd)+'</div></div>' +
      '<div class="usage-card"><div class="usage-card-label">已记录账单费用（部分）</div><div class="usage-card-value">'+money(totals.actual_cost_usd)+'</div></div>' +
      '<p class="usage-coverage" style="grid-column:1/-1;color:var(--text3)">'+Number(coverage.ledger_rows||0)+' 条模型任务汇总记录，其中 '+Number(coverage.auxiliary_rows||0)+' 条辅助任务记录；'+Number(coverage.priced_rows||0)+' 条有估算金额，'+Number(coverage.billed_rows||0)+' 条有账单金额。<br>历史汇总未分配到模型：'+Number(coverage.historical_tokens||0).toLocaleString()+' tokens；执行明细未记录模型：'+Number(coverage.ledger_unattributed_tokens||0).toLocaleString()+' tokens。</p>' +
      '<p style="grid-column:1/-1;color:var(--text3)">'+esc(u.source)+' · '+esc(u.period)+'<br>'+(u.notes || []).map(esc).join('<br>')+'</p>';
    
    var extra=u.panel_requests;
    if(extra){cardsEl.innerHTML+='<div class="usage-card" style="grid-column:1/-1"><div class="usage-card-label">面板直接请求 · 单独统计</div><p>'+esc(extra.note)+'</p><p>'+Number(extra.reported_records)+' / '+Number(extra.records)+' 条记录返回用量；输入 '+Number(extra.input_tokens).toLocaleString()+'，输出 '+Number(extra.output_tokens).toLocaleString()+' tokens。</p>'+(extra.unreadable_records?'<p>有 '+Number(extra.unreadable_records)+' 份记录无法读取，以上为可读取部分。</p>':'')+(extra.by_model||[]).map(function(row){return '<p>'+esc(row.task==='model_check'?'模型验证':'记忆整理')+' · '+esc(row.model||'服务未返回模型名')+' · '+esc(row.provider||'未记录服务名')+'：输入 '+Number(row.input_tokens).toLocaleString()+' / 输出 '+Number(row.output_tokens).toLocaleString()+' tokens'+(row.missing_input||row.missing_output?'（部分字段未返回）':'')+'</p>';}).join('')+'</div>';}

    // 模型分布
    if(models.length){
      var maxTokens = Math.max.apply(null, models.map(function(info){return info.total_tokens;}));
      var taskNames = {main:'主对话',vision:'图像理解',compression:'上下文压缩',title_generation:'标题生成'};
      modelList.innerHTML = models.map(function(info){
        var pct = maxTokens > 0 ? Math.round(info.total_tokens / maxTokens * 100) : 0;
        return '<div class="usage-model-row">' +
          '<div class="usage-model-name">'+esc(info.model || (info.historical?'历史汇总未分配模型':'执行记录未保存模型'))+'<small style="display:block;color:var(--text3)">'+esc(taskNames[info.task] || info.task)+(info.provider?' · '+esc(info.provider):'')+'</small></div>' +
          '<div class="usage-model-bar"><div class="usage-model-bar-fill" style="width:'+pct+'%"></div></div>' +
          '<div class="usage-model-stats">'+Number(info.total_tokens).toLocaleString()+' tokens · '+info.api_call_count+' 次调用</div>' +
          '</div>';
      }).join('');
      modelSection.style.display = '';
    }
    
    // 每日用量（从会话数据推算）
    if(u.activity && u.activity.length){
      dailyBody.innerHTML = u.activity.map(function(d){
        return '<tr><td>'+esc(d.date)+'</td><td>'+d.sessions+'</td><td>'+d.messages+'</td></tr>';
      }).join('');
      dailySection.style.display = '';
    }
  }).catch(function(){
    cardsEl.innerHTML = '';
    emptyEl.textContent = '读取失败，请检查连接后重试';
    emptyEl.style.display = '';
  });
}