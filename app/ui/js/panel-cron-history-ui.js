(function () {
  'use strict';
  window.openCronHistory = function (id) {
    var active = document.activeElement;
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = '<section class="modal cron-native-editor cron-history" role="dialog" aria-modal="true" aria-label="任务执行记录">' +
      '<div class="modal-head"><h3>执行记录</h3><button class="modal-close" aria-label="关闭">×</button></div>' +
      '<div class="modal-body"><p class="cron-history-summary"></p><p class="cron-history-status" role="status"></p>' +
      '<div class="cron-history-list"></div><button class="action cron-history-more" hidden>加载更多</button>' +
      '<p class="cron-history-detail-status" role="status"></p><button class="action cron-history-retry" hidden>重试读取结果</button><article class="cron-history-result" hidden><h4></h4><pre tabindex="0"></pre><button class="action cron-history-download">下载原始记录</button></article></div>' +
      '<div class="modal-foot"><button class="action cron-history-refresh">刷新记录</button></div></section>';
    document.body.append(overlay);
    var base = '/api/cron-jobs/' + encodeURIComponent(id) + '/history';
    var selectionKey='panel-cron-history:'+id,selectedRecord=null;try{selectedRecord=JSON.parse(localStorage.getItem(selectionKey)||'null');}catch(_){}
    var list = overlay.querySelector('.cron-history-list'), status = overlay.querySelector('[role=status]');
    var more = overlay.querySelector('.cron-history-more'), article = overlay.querySelector('article');
    var current, cursor = null, busy = false, sequence = 0,detailBusy=false;
    var detailStatus=overlay.querySelector('.cron-history-detail-status'),retry=overlay.querySelector('.cron-history-retry');
    function remember(record){selectedRecord=record;try{localStorage.setItem(selectionKey,JSON.stringify(record));}catch(_){}}
    function markSelection(){list.querySelectorAll('button').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.recordId===selectedRecord?.id)));}
    retry.onclick=function(){if(selectedRecord)open(selectedRecord);};
    function close() { sequence++; overlay.remove(); if (active && active.isConnected) active.focus(); }
    overlay.querySelector('.modal-close').onclick = close;
    overlay.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key === 'Tab') {
        var nodes = Array.from(overlay.querySelectorAll('button,[tabindex]')).filter(function (node) { return !node.disabled && node.getClientRects().length; });
        if (event.shiftKey && document.activeElement === nodes[0]) { event.preventDefault(); nodes[nodes.length - 1].focus(); }
        if (!event.shiftKey && document.activeElement === nodes[nodes.length - 1]) { event.preventDefault(); nodes[0].focus(); }
      }
    });
    async function request(path) {
      await fetchToken();var response = await fetch(apiUrl(path), {headers: {'X-Monitor-Token': monitorToken || ''}});
      var body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.error || '执行记录读取失败');
      return body;
    }
    async function open(record,focus=true) {
      var ticket = ++sequence;remember({id:record.id,name:record.name});markSelection();detailBusy=true;current=null;retry.hidden=true;
      detailStatus.textContent = '正在读取执行结果…'; article.hidden = true;
      try {
        var result = await request(base + '/' + encodeURIComponent(record.id));
        if (!overlay.isConnected || ticket !== sequence) return;
        current = result;
        article.querySelector('h4').textContent = result.name;
        article.querySelector('pre').textContent = result.content;
        article.hidden = false; detailStatus.textContent = '';
        if(focus){article.scrollIntoView({block: 'nearest'}); article.querySelector('pre').focus();}
      } catch (error) { if (overlay.isConnected&&ticket === sequence){detailStatus.textContent = error.message;retry.hidden=false;} }
      finally{if(ticket===sequence)detailBusy=false;}
    }
    async function load(reset) {
      if (busy) return;
      busy = true; more.disabled = true;if(reset){list.querySelectorAll('button').forEach(button=>button.disabled=true);sequence++;detailBusy=false;current=null;article.hidden=true;retry.hidden=true;detailStatus.textContent='';}status.textContent = '正在读取执行记录…';
      try {
        var result = await request(base + (reset || !cursor ? '' : '?after=' + encodeURIComponent(cursor)));
        if (!overlay.isConnected) return;
        if (reset) list.replaceChildren();
        var job = result.job;
        overlay.querySelector('.cron-history-summary').textContent = (job.name || '定时任务') + ' · ' +
          (job.last_run_at ? '最近执行：' + new Date(job.last_run_at).toLocaleString('zh-CN') : '尚无执行时间记录') +
          (job.last_status === 'ok' ? ' · 执行成功' : job.last_status === 'error' ? ' · 执行失败：' + (job.last_error || '未保存失败详情') : '') +
          (job.last_delivery_error ? '\n渠道投递失败：' + job.last_delivery_error : '');
        result.records.forEach(function (record) {
          var button = document.createElement('button'); button.className = 'action cron-history-record';
          button.textContent = record.name + ' · ' + Math.max(1, Math.ceil(record.size / 1024)) + ' KB';
          button.dataset.recordId=record.id;button.onclick = function () { open(record); }; list.append(button);
        });
        cursor = result.next; more.hidden = !cursor;markSelection();
        status.textContent = result.total ? '磁盘保留 ' + result.total + ' 份执行产物' : '尚无保留的执行产物';
        if(reset&&selectedRecord&&!detailBusy)open(selectedRecord,false);
      } catch (error) { if(overlay.isConnected){status.textContent = error.message;if(reset&&selectedRecord)detailStatus.textContent='列表尚未刷新，重新读取成功后再恢复所选结果。';} }
      finally { busy = false; more.disabled = false;list.querySelectorAll('button').forEach(button=>button.disabled=false); }
    }
    more.onclick = function () { load(false); };
    overlay.querySelector('.cron-history-refresh').onclick = function () { load(true); };
    overlay.querySelector('.cron-history-download').onclick = function () {
      if (!current) return;
      var url = URL.createObjectURL(new Blob([current.content], {type: 'text/markdown;charset=utf-8'}));
      var link = document.createElement('a'); link.href = url; link.download = current.name; link.click();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    };
    overlay.querySelector('.modal-close').focus(); load(true);
  };
}());
