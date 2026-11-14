/* 隧道（Cloudflare Tunnel 外网访问）
 * 来源：index.html 内联 app.js 第 5484-5669 行（共 186 行）
 * 2026-11-13 按原分区纯搬运外移，逻辑零改动。全局作用域与执行顺序与原内联块一致。 */

/* ============================ 隧道（Cloudflare Tunnel 外网访问） ============================ */
var _tunPollTimer = null;
function tunnelModeChanged(){
  var mode=document.getElementById('tunMode');
  if(!mode) return;
  var tw=document.getElementById('tunTokenWrap');
  if(tw) tw.style.display=(mode.value==='named')?'block':'none';
}
function tunnelTargetChanged(){
  var t=document.getElementById('tunTarget');
  if(!t) return;
  var cw=document.getElementById('tunCustomWrap');
  if(cw) cw.style.display=(t.value==='custom')?'block':'none';
}
function tunnelGetTarget(){
  var t=document.getElementById('tunTarget');
  if(!t) return null;
  if(t.value==='custom'){
    var cp=document.getElementById('tunCustomPort');
    var v=cp?cp.value.trim():'';
    return /^\d+$/.test(v)?v:null;
  }
  return t.value;
}
function renderTunnelPage(){
  apiGet('/api/tunnel/status').then(function(res){
    if(!res || res.error){ var st=document.getElementById('tunStatusText'); if(st) st.textContent='状态获取失败'; return; }
    var running=!!res.running;
    var badge=document.getElementById('tunStatusBadge');
    var txt=document.getElementById('tunStatusText');
    if(badge) badge.className='ov-status '+(running?'on':'off');
    if(txt) txt.textContent=running?'运行中':'已停止';
    var meta=document.getElementById('tunMeta');
    if(meta){
      var parts=[];
      parts.push('模式：'+(res.mode==='named'?'Named 固定域名':'Quick 临时链接'));
      parts.push('回源：127.0.0.1:'+(res.target||res.ui_port||'8650')+'（NAS 本机）');
      if(res.pid) parts.push('PID：'+res.pid);
      if(res.started_at) parts.push('启动：'+new Date(res.started_at).toLocaleString());
      parts.push(res.cloudflared?('cloudflared：'+res.cloudflared):'cloudflared：未安装（启动时自动下载）');
      meta.innerHTML=parts.join(' · ');
    }
    var urlRow=document.getElementById('tunUrlRow');
    var urlIn=document.getElementById('tunUrl');
    if(urlRow && urlIn){
      if(running && res.url){
        urlIn.value=res.url;
        urlRow.style.display='block';
      } else if(running && res.mode==='named'){
        urlIn.value=res.name||'已连接固定域名（请在 Cloudflare 面板为该 Tunnel 配置 Hostname 映射）';
        urlRow.style.display='block';
      } else {
        urlRow.style.display='none';
      }
    }
    var modeSel=document.getElementById('tunMode');
    if(modeSel && res.mode) modeSel.value=(res.mode==='named')?'named':'quick';
    tunnelModeChanged();
    var targetSel=document.getElementById('tunTarget');
    if(targetSel && res.target){
      var matched=false;
      for(var i=0;i<targetSel.options.length;i++){ if(targetSel.options[i].value===String(res.target)){ targetSel.selectedIndex=i; matched=true; break; } }
      if(!matched){ targetSel.value='custom'; var cp=document.getElementById('tunCustomPort'); if(cp) cp.value=res.target; }
    }
    tunnelTargetChanged();
    var logEl=document.getElementById('tunLog');
    if(logEl && res.log_tail) logEl.textContent=res.log_tail;
    var btn=document.getElementById('tunStartBtn');
    if(btn) btn.textContent=running?'重启隧道':'启动隧道';
    var stopBtn=document.getElementById('tunStopBtn');
    if(stopBtn) stopBtn.disabled=!running;
    var hint=document.getElementById('tunActHint');
    if(hint && running) hint.textContent='隧道运行中，公网地址见左侧卡片。Quick 链接重启后地址会变化。';
  }).catch(function(e){
    var txt=document.getElementById('tunStatusText'); if(txt) txt.textContent='获取状态失败';
    var meta=document.getElementById('tunMeta'); if(meta) meta.textContent=(e&&e.message)||String(e);
  });
}
function tunnelStart(){
  var btn=document.getElementById('tunStartBtn');
  var hint=document.getElementById('tunActHint');
  var mode=document.getElementById('tunMode');
  var target=tunnelGetTarget();
  if(!target){ toast('请填写自定义端口'); return; }
  var body={ mode:mode?mode.value:'quick', target:target };
  if(body.mode==='named'){
    var tk=document.getElementById('tunToken');
    var token=tk?tk.value.trim():'';
    if(!token){ toast('请填写 Cloudflare Tunnel Token'); return; }
    body.token=token;
  }
  if(btn){ btn.disabled=true; btn.textContent='启动中…'; }
  if(hint) hint.textContent='正在启动 cloudflared（首次使用会自动下载约 50MB 二进制），请稍候…';
  apiPost('/api/tunnel/start', body).then(function(r){
    if(btn){ btn.disabled=false; btn.textContent='重启隧道'; }
    if(r && r.ok){
      toast('隧道已启动'+(r.url?('：'+r.url):''));
      renderTunnelPage();
      startTunnelPolling();
    } else {
      var msg=(r&&r.error)||'服务器没有返回停止原因';
      toast('启动失败：'+msg);
      if(hint) hint.textContent=msg;
    }
  }).catch(function(e){
    if(btn){ btn.disabled=false; btn.textContent='启动隧道'; }
    toast('启动失败：'+((e&&e.message)||e));
    if(hint) hint.textContent=(e&&e.message)||String(e);
  });
}
function tunnelStop(){
  var btn=document.getElementById('tunStopBtn');
  if(btn) btn.disabled=true;
  apiPost('/api/tunnel/stop', {}).then(function(r){
    if(r && r.ok){ toast('隧道已停止'); }
    else { toast('停止失败：'+((r&&r.error)||'服务器没有返回停止原因')); }
    stopTunnelPolling();
    renderTunnelPage();
  }).catch(function(e){ toast('停止失败：'+((e&&e.message)||e)); renderTunnelPage(); });
}
function tunnelCopyUrl(){
  var el=document.getElementById('tunUrl');
  if(!el||!el.value) return;
  var v=el.value;
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(v).then(function(){ toast('已复制公网地址'); }, function(){ toast('复制失败，请手动选择复制'); });
  } else {
    var ta=document.createElement('textarea');
    ta.value=v; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('已复制公网地址'); } catch(e){ toast('复制失败，请手动选择复制'); }
    document.body.removeChild(ta);
  }
}
function tunnelOpenUrl(){
  var el=document.getElementById('tunUrl');
  if(!el||!el.value) return;
  var v=el.value;
  if(v.indexOf('http')!==0) v='https://'+v;
  window.open(v,'_blank');
}
function tunnelShowQr(){
  var el=document.getElementById('tunUrl');
  if(!el||!el.value){ toast('暂无公网地址'); return; }
  var v=el.value;
  if(v.indexOf('http')!==0) v='https://'+v;
  var m=document.getElementById('tunQrModal');
  if(!m){ m=document.createElement('div'); m.id='tunQrModal'; m.className='modal-backdrop'; m.style.cssText='position:fixed;inset:0;z-index:3000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45)';
    m.innerHTML='<div style="background:var(--card,#fff);border-radius:14px;padding:20px;max-width:300px;width:90%;text-align:center;box-shadow:0 8px 40px rgba(0,0,0,.25)">'+
      '<div style="font-weight:600;margin-bottom:10px">手机扫码访问</div>'+
      '<canvas id="tunQrCanvas" width="240" height="240" style="width:240px;height:240px;background:#fff;border-radius:10px;margin:0 auto;display:block"></canvas>'+
      '<div style="font-size:11px;color:var(--text2,#888);word-break:break-all;margin-top:10px" id="tunQrUrlText"></div>'+
      '<button class="ov-actbtn" style="margin-top:14px;width:100%;padding:8px" onclick="tunnelCloseQr()">关闭</button></div>';
    m.addEventListener('click',function(e){ if(e.target===m) tunnelCloseQr(); });
    /* 补 Esc：这个弹窗是复用单例（display 切换），不能走 adoptOverlay 的 remove 路径 */
    document.addEventListener('keydown',function(e){ if(e.key==='Escape' && m.style.display!=='none') tunnelCloseQr(); });
    document.body.appendChild(m);
  }
  m.style.display='flex';
  var cv=document.getElementById('tunQrCanvas');
  var txt=document.getElementById('tunQrUrlText'); if(txt) txt.textContent=v;
  if(window.QRCode && typeof window.QRCode.toCanvas==='function'){
    window.QRCode.toCanvas(cv, v, { errorCorrectionLevel:'M', margin:2, width:240, color:{ dark:'#000000', light:'#ffffff' } }, function(err){ if(err && txt) txt.textContent='二维码生成失败，请复制地址'; });
  } else {
    if(txt) txt.textContent='二维码组件不可用，请复制地址：'+v;
  }
}
function tunnelCloseQr(){
  var m=document.getElementById('tunQrModal'); if(m) m.style.display='none';
}
function tunnelRefreshLog(){
  apiGet('/api/tunnel/status').then(function(res){
    var logEl=document.getElementById('tunLog');
    if(logEl && res && res.log_tail) logEl.textContent=res.log_tail;
  });
}
function startTunnelPolling(){
  stopTunnelPolling();
  _tunPollTimer=setInterval(function(){
    apiGet('/api/tunnel/status').then(function(res){
      if(!res || !res.running){ stopTunnelPolling(); }
      renderTunnelPage();
    }).catch(function(){});
  }, 8000);
}
function stopTunnelPolling(){
  if(_tunPollTimer){ clearInterval(_tunPollTimer); _tunPollTimer=null; }
}