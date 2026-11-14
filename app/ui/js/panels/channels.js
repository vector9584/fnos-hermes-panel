/* 通讯 / 渠道
 * 来源：index.html 内联 app.js 第 8347-8698 行（共 352 行）
 * 2026-11-13 按原分区纯搬运外移，逻辑零改动。全局作用域与执行顺序与原内联块一致。 */

/* ============================ 通讯 / 渠道 ============================ */
var _chFilter='all';
function renderChannels(){
  var grid=document.getElementById('channelGrid');
  if(window.panelRenderChannels) return window.panelRenderChannels();
  if(grid) grid.replaceChildren(Object.assign(document.createElement('p'),{className:'empty-state',textContent:'通讯面板尚未就绪，请刷新重试。'}));
}
/* 渠道启停开关：写 platforms.<id>.enabled 并重启网关（网关启动时跳过 enabled=false 的渠道） */
function chChannelToggle(id){
  var c=(_chState.channels||{})[id]||{};
  var next = (c.enabled===false);
  toast((next?'正在启用':'正在禁用')+' '+id+'（重启网关生效）…');
  fetch(apiUrl('/api/channels/'+id+'/toggle'), { method:'POST', headers:{'Content-Type':'application/json','X-Monitor-Token':monitorToken||''}, body: JSON.stringify({ enabled: next }) })
    .then(function(r){ return r.json().catch(function(){ return {}; }); })
    .then(function(j){
      if(j.ok){ toast('已保存 '+id+' 的'+(j.enabled?'启用':'停用')+'配置，重启应用后生效');window.panelRuntimeRefresh?.(); renderChannels(); }
      else toast('操作失败：'+(j.error||'服务器没有返回操作原因'),'error');
    })
    .catch(function(){ toast('网络错误','error'); });
}
function setChFilter(el, filter){
  _chFilter=filter;
  document.querySelectorAll('#page-comm .ch-filter').forEach(function(b){ b.classList.remove('active'); });
  el.classList.add('active');
  renderChannels();
}
var _currentChId=null;
function openChannelModal(id){
  _chQrSeq++; // 打开新弹窗：终止上一个渠道残留的 QR 轮询链
  _currentChId=id;
  var def=_chState.defs[id];
  var c=_chState.channels[id]||{};
  if(!def) return;
  var m=document.getElementById('channelModal'); if(!m) return;
  if (m.parentElement !== document.body) document.body.appendChild(m);
  m.style.display='flex';
  document.getElementById('chModalTitle').textContent='配置 '+def.name;
  var html='';
  (def.fields||[]).forEach(function(f){
    if(!f.env) return;
    var val=(c.credentials||[]).filter(function(x){ return x.env===f.env; })[0];
    var cur=val?val.value:'';
    html+='<div class="field"><label>'+esc(f.label)+(f.secret?'（保密）':'')+'</label><input type="'+(f.secret?'password':'text')+'" id="chf_'+esc(f.env)+'" value="'+DOM.escAttr(cur)+'" placeholder="'+DOM.escAttr(f.placeholder||'')+'"></div>';
  });
  (def.toggles||[]).forEach(function(t){
    var cur=(c.config && (c.config[t.path]===true||c.config[t.path]==='true'))?true:false;
    html+='<div class="toggle-row"><label class="toggle '+(cur?'on':'')+'" id="cht_'+esc(t.path)+'" onclick="chToggle(\''+esc(t.path)+'\')"><span class="toggle-switch"></span></label><span class="toggle-lbl">'+esc(t.label)+'</span></div>';
  });
  (def.behavior||[]).forEach(function(b){
    var bid='chb_'+b.path.replace(/\./g,'_');
    var cur=(c.config && c.config[b.path]!=null)?String(c.config[b.path]):'';
    html+='<div class="field"><label>'+esc(b.label)+'</label><input type="'+(b.type==='password'?'password':'text')+'" id="'+bid+'" value="'+DOM.escAttr(cur)+'" placeholder="'+DOM.escAttr(b.placeholder||'')+'"></div>';
  });
  if(def.note && (!def.fields||!def.fields.length) && (!def.toggles||!def.toggles.length)){
    html+='<div class="conn-hint">'+esc(def.note)+'</div>';
  }
  // Octop 风格通用行为开关（显示思考过程 / 工具调用提示）
  var behaviorToggles=[
    {key:'show_thinking', label:'显示思考过程'},
    {key:'show_tool_hints', label:'显示工具调用提示'}
  ];
  behaviorToggles.forEach(function(bt){
    var cur=(c.config && (c.config[bt.key]===true||c.config[bt.key]==='true'))?true:false;
    html+='<div class="toggle-row"><label class="toggle '+(cur?'on':'')+'" id="cht_'+esc(bt.key)+'" onclick="chToggle(\''+esc(bt.key)+'\')"><span class="toggle-switch"></span></label><span class="toggle-lbl">'+esc(bt.label)+'</span></div>';
  });
  // ── Octop 风格增强配置：绑定角色 / 模型 / 技能 ──
  html += '<div style="margin-top:16px;border-top:1px solid var(--border);padding-top:12px">';
  html += '<div style="font-size:12px;font-weight:600;margin-bottom:8px;color:var(--accent)">🎭 角色与能力配置</div>';
  // 绑定 Profile：按 id 去重（防同一角色重复出现），打开弹窗时异步刷新一次
  // 保证新建的 Agent（如预设模板创建的 coder/fnos_operator）能出现在下拉里
  var curProfile = (c.config && c.config.profile) || 'default';
  var profList = (_profiles.length ? _profiles : [{id:'default',name:'默认助手'}]);
  var seenProf = {}; profList = profList.filter(function(p){ if(seenProf[p.id]) return false; seenProf[p.id]=true; return true; });
  if(!profList.some(function(p){ return p.id==='default'; })) profList.unshift({id:'default',name:'默认助手',emoji:'🤖'});
  html += '<div class="field"><label>绑定角色 (Profile)</label><select id="ch_profile" style="width:100%;padding:8px;border-radius:6px;background:var(--card);color:var(--text);border:1px solid var(--border)">';
  profList.forEach(function(p){
    html += '<option value="'+DOM.escAttr(p.id)+'"'+(curProfile===p.id?' selected':'')+'>'+esc(p.emoji||'')+' '+esc(p.name||p.id)+'</option>';
  });
  html += '</select><div class="conn-hint" style="font-size:11px;margin-top:4px">该通道收到的消息将使用此角色的系统提示和配置</div></div>';
  // 异步刷新 profiles 并重建下拉（保留当前选中值，去重）
  apiGet('/api/profiles').then(function(res){
    if(res && res.ok && res.profiles){
      _profiles = res.profiles; _profilesLoaded = true;
      renderPersonas(); renderPresetAgents();
      var sel = document.getElementById('ch_profile');
      if(!sel) return;
      var keep = sel.value || curProfile;
      var pl = res.profiles.length ? res.profiles : [{id:'default',name:'默认助手'}];
      var sp = {}; pl = pl.filter(function(p){ if(sp[p.id]) return false; sp[p.id]=true; return true; });
      if(!pl.some(function(p){ return p.id==='default'; })) pl.unshift({id:'default',name:'默认助手',emoji:'🤖'});
      sel.innerHTML = pl.map(function(p){ return '<option value="'+DOM.escAttr(p.id)+'">'+esc(p.emoji||'')+' '+esc(p.name||p.id)+'</option>'; }).join('');
      sel.value = pl.some(function(p){ return p.id===keep; }) ? keep : 'default';
    }
  }).catch(function(){});
  // 模型选择
  var curModel = (c.config && c.config.model) || '';
  html += '<div class="field"><label>模型选择（留空=跟随角色配置）</label><select id="ch_model" style="width:100%;padding:8px;border-radius:6px;background:var(--bg1);color:var(--text);border:1px solid var(--border)">'+buildModelOptionsHtml(curModel, '跟随角色配置')+'</select></div>';
  // 技能多选
  var curSkills = (c.config && c.config.skills) || [];
  if(typeof curSkills === 'string') curSkills = curSkills ? curSkills.split(',') : [];
  if(!Array.isArray(curSkills)) curSkills = [];
  html += '<div class="field"><label>启用技能（多选，留空=全部）</label><div id="ch_skills_wrap" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px">';
  var knownSkills = ['web_search','code_execution','file_manager','terminal','browser','vision','memory','delegation'];
  knownSkills.forEach(function(sk){
    var checked = curSkills.indexOf(sk) >= 0;
    html += '<label style="display:inline-flex;align-items:center;gap:4px;font-size:12px;padding:4px 8px;border-radius:4px;background:var(--card);border:1px solid var(--border);cursor:pointer"><input type="checkbox" class="ch-skill-cb" value="'+sk+'"'+(checked?' checked':'')+' style="accent-color:var(--accent)">'+sk+'</label>';
  });
  html += '</div></div>';
  // 系统提示覆盖
  var curSysPrompt = (c.config && c.config.system_prompt) || '';
  html += '<div class="field"><label>系统提示覆盖（可选，优先级高于角色 SOUL.md）</label><textarea id="ch_system_prompt" rows="3" placeholder="留空则使用绑定角色的 SOUL.md" style="width:100%;padding:8px;border-radius:6px;background:var(--card);color:var(--text);border:1px solid var(--border);resize:vertical">'+esc(curSysPrompt)+'</textarea></div>';
  html += '</div>';
  // 二维码登录类渠道：不直接弹出二维码，改为「扫码 / 手动输入」选择视图
  if(def.qrLogin){
    var qrFn = id==='telegram' ? 'chStartTelegramQr()' : (id==='whatsapp' ? 'chStartWhatsAppQr()' : (id==='weixin' ? 'chStartWeixinQr()' : (id==='wecom' ? 'chStartWecomQr()' : (id==='qqbot' ? 'chStartQqbotQr()' : ''))));
    var choice = '<div class="qr-choice">'+
      '<div class="conn-hint" style="margin-bottom:12px">该渠道支持扫码登录或手动填写 Token，请选择一种方式：</div>'+
      '<div class="qr-choice-row">'+
        '<button class="qr-choice-btn" onclick="'+qrFn+'"><div class="qr-choice-ico">📷</div><div><div class="qr-choice-t">扫码登录 / 创建</div><div class="qr-choice-s">用 App 扫码，自动获取凭证</div></div></button>'+
        '<button class="qr-choice-btn" onclick="chShowManualFields()"><div class="qr-choice-ico">🔑</div><div><div class="qr-choice-t">手动输入 Token</div><div class="qr-choice-s">粘贴 Bot Token / 凭证</div></div></button>'+
      '</div>'+
      '<div id="chManualWrap" style="display:none">'+html+'</div>'+
      '</div>';
    document.getElementById('chModalBody').innerHTML=choice;
  } else {
    document.getElementById('chModalBody').innerHTML=html;
  }
  var foot=document.getElementById('chModalFoot');
  var hasConfig = !!(c && (c.configured || (c.credentials||[]).some(function(x){ return x.value; })));
  if(foot) foot.innerHTML='<button class="ov-actbtn danger" id="chClearBtn" onclick="clearChannel()" style="'+(hasConfig?'':'display:none')+'">清空配置</button><button class="ov-actbtn" onclick="testChannel()">测试</button><button class="ov-actbtn start" onclick="saveChannel()">保存</button>';
}
async function clearChannel(){
  var id=_currentChId; var def=_chState.defs[id]; if(!id||!def) return;
  if(!(await ui.confirm('确定清空「'+def.name+'」的全部配置？\n\n将删除已保存的凭证、账号信息和通道设置（含角色绑定、模型、技能、系统提示），需要重启应用后生效。\n清空后可重新扫码或手动配置。', {danger:true}))) return;
  apiPost('/api/channels/'+id+'/clear', {}).then(function(r){
    if(r && r.error){ toast('清空失败：'+r.error); return; }
    apiGet('/api/channels').then(function(res2){
      _chState.channels = (res2 && res2.channels) || _chState.channels;
      renderChannels(); closeChannelModal();
      toast('已清空 '+def.name+' 配置，网关正在重启生效。');
    });
  }).catch(function(e){ toast('清空失败：'+e.message); });
}
function chShowManualFields(){
  var wrap=document.getElementById('chManualWrap'); if(wrap) wrap.style.display='block';
  var row=document.querySelector('#chModalBody .qr-choice-row'); if(row) row.style.display='none';
  var hint=document.querySelector('#chModalBody .qr-choice > .conn-hint'); if(hint) hint.style.display='none';
}
function chToggle(path){ var el=document.getElementById('cht_'+path); if(el) el.classList.toggle('on'); }
function closeChannelModal(){ _chQrSeq++; var m=document.getElementById('channelModal'); if(m) m.style.display='none'; _currentChId=null; }
function testChannel(){
  var id=_currentChId; if(!id){ toast('请先打开一个渠道'); return; }
  var def=_chState.defs[id]; if(!def){ toast('无渠道定义'); return; }
  var credentials={};
  (def.fields||[]).forEach(function(f){ if(!f.env) return; var el=document.getElementById('chf_'+f.env); credentials[f.env]=el?el.value:''; });
  var toggles={};
  (def.toggles||[]).forEach(function(t){ var el=document.getElementById('cht_'+t.path); toggles[t.path]=!!(el&&el.classList.contains('on')); });
  var config={};
  (def.behavior||[]).forEach(function(b){ var bid='chb_'+b.path.replace(/\./g,'_'); var el=document.getElementById(bid); var v=el?el.value:''; if(v&&v.trim()!=='') config[b.path]=b.list?v.split(',').map(function(s){return s.trim();}).filter(Boolean):v.trim(); });
  ['show_thinking','show_tool_hints'].forEach(function(key){ var el=document.getElementById('cht_'+key); config[key]=!!(el&&el.classList.contains('on')); });
  var payload={ kind:id, config:config, credentials:credentials, toggles:toggles };
  toast('正在测试 '+def.name+' 连接…');
  apiPost('/api/channels/'+id+'/test', payload).then(function(r){
    if(r && r.error){
      if(/404/.test(r.error)){ toast('该渠道暂不支持在线测试，保存后重启网关即可生效'); }
      else { toast('连接失败：'+r.error); }
      return;
    }
    toast('连接正常：'+(r&&r.message? r.message : def.name+' 配置有效'));
  });
}
function saveChannel(){
  var id=_currentChId; var def=_chState.defs[id]; if(!def) return;
  var credentials={};
  (def.fields||[]).forEach(function(f){ if(!f.env) return; var el=document.getElementById('chf_'+f.env); credentials[f.env]=el?el.value:''; });
  var toggles={};
  (def.toggles||[]).forEach(function(t){ var el=document.getElementById('cht_'+t.path); toggles[t.path]=!!(el&&el.classList.contains('on')); });
  var config={};
  (def.behavior||[]).forEach(function(b){ var bid='chb_'+b.path.replace(/\./g,'_'); var el=document.getElementById(bid); var v=el?el.value:''; if(v&&v.trim()!=='') config[b.path]=b.list?v.split(',').map(function(s){return s.trim();}).filter(Boolean):v.trim(); });
  // Octop 风格通用行为开关
  ['show_thinking','show_tool_hints'].forEach(function(key){ var el=document.getElementById('cht_'+key); config[key]=!!(el&&el.classList.contains('on')); });
  // Octop 增强：角色/模型/技能/系统提示（始终发送，空值=清空覆盖）
  var chProfile=document.getElementById('ch_profile'); if(chProfile) config.profile=chProfile.value;
  var chModel=document.getElementById('ch_model'); config.model=chModel?chModel.value.trim():'';
  var skillCbs=document.querySelectorAll('.ch-skill-cb:checked'); config.skills=Array.from(skillCbs).map(function(cb){ return cb.value; });
  var chSysPrompt=document.getElementById('ch_system_prompt'); config.system_prompt=chSysPrompt?chSysPrompt.value.trim():'';
  apiPost('/api/channels/'+id, { credentials:credentials, toggles:toggles, config:config }).then(function(r){
    if(r && r.error){ toast('保存失败：'+r.error); return; }
    apiGet('/api/channels').then(function(res2){
      _chState.channels = (res2 && res2.channels) || _chState.channels;
      renderChannels(); closeChannelModal();
      toast('已保存 '+def.name+' 配置，网关正在重启生效。');
    });
  }).catch(function(e){ toast('保存失败：'+e.message); });
}
/* 渠道二维码（使用 window.QRCode） */
/* 用 Node `qrcode` 库（window.QRCode.toCanvas）把文本画到 canvas 元素上。
   注意：打包内置的是 node-qrcode，不是 davidshimjs/qrcodejs，没有 `new QRCode(el,{text})` 构造器，
   必须用 QRCode.toCanvas(canvasEl, text, opts, cb)。 */
function drawQR(canvasEl, text){
  return new Promise(function(resolve){
    try {
      if(window.QRCode && typeof window.QRCode.toCanvas === 'function'){
        window.QRCode.toCanvas(canvasEl, String(text||''), { errorCorrectionLevel:'M', margin:1, width:220, color:{ dark:'#000000', light:'#ffffff' } }, function(err){ resolve(!err); });
        return;
      }
    } catch(e){}
    resolve(false);
  });
}
/* 把二维码渲染进 modal 中的 canvas；若库不可用则退化为可复制的链接，避免空白 */
function chRenderQr(deep, canvasId){
  var cv=document.getElementById(canvasId);
  if(!cv) return;
  if(!deep){ var w0=cv.parentNode; if(w0) w0.innerHTML='<div class="conn-hint" style="color:var(--red)">无法生成二维码</div>'; return; }
  drawQR(cv, deep).then(function(ok){
    if(!ok){
      var wrap=cv.parentNode;
      if(wrap){ wrap.innerHTML='<div class="conn-hint" style="color:var(--red)">当前环境无法渲染二维码，请复制以下链接在手机浏览器打开完成授权：</div><div style="word-break:break-all;font-size:12px;background:#f3f4f6;padding:8px;border-radius:var(--radius-sm);margin-top:6px">'+esc(deep)+'</div>'; }
    }
  });
}
function chShowQrSuccess(name){
  var body=document.getElementById('chModalBody'); var foot=document.getElementById('chModalFoot');
  if(foot) foot.innerHTML='';
  if(body) body.innerHTML='<div style="text-align:center;padding:18px 8px"><div style="font-size:42px;line-height:1">✅</div><div style="font-weight:600;margin-top:8px">'+esc(name)+' 已成功关联</div><div class="conn-hint" style="margin-top:8px">凭证已写入本机，网关正在自动重启生效（约 10 秒后可用）。</div><button class="btn primary" style="margin-top:14px" onclick="closeChannelModal()">完成</button></div>';
}
function chStartTelegramQr(){
  var seq=++_chQrSeq;
  var body=document.getElementById('chModalBody'); body.innerHTML='<div class="conn-hint">正在生成 Telegram 配对二维码…</div>';
  apiGet('/api/channels/telegram/qr').then(function(res){
    if(seq!==_chQrSeq) return;
    if(!res || res.error) throw new Error(res&&res.error||'获取二维码失败');
    var deep=res.qr_payload||res.deep_link||'';
    if(!deep){ body.innerHTML='<div class="conn-hint" style="color:var(--red)">无法生成二维码</div>'; return; }
    body.innerHTML='<div class="conn-hint">用 Telegram 扫描下方二维码创建机器人。</div><div style="display:flex;justify-content:center;padding:12px"><canvas id="tgQR" width="220" height="220" style="width:220px;height:220px;background:#fff;border-radius:var(--radius-md)"></canvas></div><div id="tgQrStatus" style="text-align:center;font-size:13px;color:var(--text3)">等待扫码创建…</div><div id="tgAllowWrap" style="display:none;margin-top:12px"><input id="tgAllowed" type="text" placeholder="允许的 Telegram 用户 ID（逗号分隔）" style="width:100%"></div>';
    chRenderQr(deep, 'tgQR');
    chPollTelegramQr(res.pairing_id, seq);
  }).catch(function(e){ if(seq!==_chQrSeq) return; body.innerHTML='<div class="conn-hint" style="color:var(--red)">无法获取二维码：'+(e.message||e)+'</div>'; });
}
function chPollTelegramQr(pid, seq){
  if(seq===undefined) seq=_chQrSeq;
  api('/api/channels/telegram/qr/status?pairing_id='+encodeURIComponent(pid),'GET').then(function(res){
    if(seq!==_chQrSeq) return;
    var stEl=document.getElementById('tgQrStatus');
    if(!res || res.error){ if(stEl) stEl.textContent=(res&&res.error)||'轮询失败'; return; }
    var st=res.status;
    if(st==='waiting'){ if(stEl) stEl.textContent='等待在 Telegram 中点击「Create Bot」…'; setTimeout(function(){ if(seq===_chQrSeq) chPollTelegramQr(pid, seq); }, 2500); }
    else if(st==='ready'){ if(stEl) stEl.textContent='✅ 机器人已创建：'+(res.bot_username||'')+'，请填写允许的用户 ID 后点击「完成」。'; var w=document.getElementById('tgAllowWrap'); if(w) w.style.display='block'; var inp=document.getElementById('tgAllowed'); if(inp&&res.owner_user_id) inp.value=res.owner_user_id; var foot=document.getElementById('chModalFoot'); if(foot) foot.innerHTML='<div style="margin-right:auto;font-size:11px;color:var(--text3)">凭证仅保存在本机</div><button class="btn primary" onclick="chApplyTelegramQr(\''+esc(pid)+'\')">完成</button>'; }
    else if(st==='confirmed'){ chShowQrSuccess('Telegram'); }
  }).catch(function(e){ var stEl=document.getElementById('tgQrStatus'); if(stEl) stEl.textContent='轮询出错：'+(e.message||e); });
}
function chApplyTelegramQr(pid){
  var el=document.getElementById('tgAllowed'); var allowed=el?el.value:'';
  apiPost('/api/channels/telegram/qr/apply', { pairing_id:pid, allowed_user_ids:allowed }).then(function(res){
    if(res && res.error) throw new Error(res.error);
    apiGet('/api/channels').then(function(r2){ _chState.channels=(r2&&r2.channels)||_chState.channels; renderChannels(); chShowQrSuccess('Telegram'); });
  }).catch(function(e){ toast('保存失败：'+(e.message||e)); });
}
function chStartWhatsAppQr(){
  var seq=++_chQrSeq;
  var body=document.getElementById('chModalBody');
  body.innerHTML='<div class="conn-hint">WhatsApp 通过本地桥接扫码配对，消息在本地处理。</div><div id="waQrZone" style="text-align:center;margin-top:8px"><div class="conn-hint">正在启动桥接并生成二维码…</div></div>';
  api('/api/channels/whatsapp/qr?mode=self-chat','GET').then(function(res){
    if(seq!==_chQrSeq) return;
    if(!res || res.error) throw new Error(res.error||'启动失败');
    if(res.status==='connected'){ chApplyWhatsAppQr(res.pairing_id); return; }
    var waDeep=res.qr_payload||res.deep_link||'';
    if(!waDeep){ body.innerHTML='<div class="conn-hint" style="color:var(--red)">二维码生成失败</div>'; return; }
    body.innerHTML='<div class="conn-hint">用 WhatsApp 扫描上方二维码 → 设置 → 关联设备。</div><div style="display:flex;justify-content:center;padding:8px"><canvas id="waQR" width="240" height="240" style="width:240px;height:240px;background:#fff;border-radius:var(--radius-md)"></canvas></div><div id="waQrStatus" style="font-size:13px;color:var(--text3)">等待在 WhatsApp 中确认…</div>';
    chRenderQr(waDeep, 'waQR');
    chPollWhatsAppQr(res.pairing_id, seq);
  }).catch(function(e){ if(seq!==_chQrSeq) return; body.innerHTML='<div class="conn-hint" style="color:var(--red)">启动失败：'+(e.message||e)+'</div>'; });
}
function chPollWhatsAppQr(pid, seq){
  if(seq===undefined) seq=_chQrSeq;
  api('/api/channels/whatsapp/qr/status?pairing_id='+encodeURIComponent(pid),'GET').then(function(res){
    if(seq!==_chQrSeq) return;
    if(!res || res.error){ var z=document.getElementById('waQrZone'); if(z) z.innerHTML='<div class="conn-hint" style="color:var(--red)">'+(res&&res.error||'配对失败')+'</div>'; return; }
    var st=res.status; var stEl=document.getElementById('waQrStatus');
    if(st==='starting'||st==='waiting'){ if(stEl) stEl.textContent=(st==='starting')?'正在等待二维码…':'等待在 WhatsApp 中确认…'; var newQr=res.qr_payload||res.deep_link||''; if(newQr&&st==='waiting'){ var c=document.getElementById('waQR'); if(c) drawQR(c, newQr); } setTimeout(function(){ if(seq===_chQrSeq) chPollWhatsAppQr(pid, seq); }, 2000); }
    else if(st==='connected'){ if(stEl) stEl.textContent='✅ 已连接：'+(res.account_name||'')+'，正在保存…'; chApplyWhatsAppQr(pid); }
    else if(st==='expired'||st==='error'){ var z2=document.getElementById('waQrZone'); if(z2) z2.innerHTML='<div class="conn-hint" style="color:var(--red)">'+(res.error||'配对失败或二维码已过期。')+'</div><button class="btn" style="margin-top:10px" onclick="chStartWhatsAppQr()">重新获取二维码</button>'; }
  }).catch(function(e){ var stEl=document.getElementById('waQrStatus'); if(stEl) stEl.textContent='轮询出错：'+(e.message||e); });
}
function chApplyWhatsAppQr(pid){
  apiPost('/api/channels/whatsapp/qr/apply', { pairing_id:pid, allowed_users:'' }).then(function(res){
    if(res && res.error) throw new Error(res.error);
    apiGet('/api/channels').then(function(r2){ _chState.channels=(r2&&r2.channels)||_chState.channels; renderChannels(); chShowQrSuccess('WhatsApp'); });
  }).catch(function(e){ toast('保存失败：'+(e.message||e)); });
}
function chStartWeixinQr(){
  var seq=++_chQrSeq;
  var body=document.getElementById('chModalBody'); body.innerHTML='<div class="conn-hint">正在获取微信登录二维码…</div>';
  apiGet('/api/channels/weixin/qr').then(function(res){
    if(seq!==_chQrSeq) return;
    if(!res || res.error) throw new Error(res.error||'获取二维码失败');
    var deep=res.qrcode_url||res.qrcode_img||'';
    if(!deep && res.qrcode) deep='https://ilinkai.weixin.qq.com/ilink/bot/scan?qrcode='+encodeURIComponent(res.qrcode);
    if(!deep){ body.innerHTML='<div class="conn-hint" style="color:var(--red)">二维码生成失败</div>'; return; }
    body.innerHTML='<div class="conn-hint">请用微信扫描下方二维码完成登录（腾讯 iLink 官方接口）。</div><div style="display:flex;justify-content:center;padding:12px"><canvas id="wxQR" width="200" height="200" style="width:200px;height:200px;background:#fff;border-radius:var(--radius-md)"></canvas></div><div id="wxQrStatus" style="text-align:center;font-size:13px;color:var(--text3)">等待扫码…</div>';
    chRenderQr(deep, 'wxQR');
    chPollWeixinQr(res.qrcode, seq);
  }).catch(function(e){ if(seq!==_chQrSeq) return; body.innerHTML='<div class="conn-hint" style="color:var(--red)">无法获取二维码：'+(e.message||e)+'</div>'; });
}
function chPollWeixinQr(qrcode, seq){
  if(seq===undefined) seq=_chQrSeq;
  api('/api/channels/weixin/qr/status?qrcode='+encodeURIComponent(qrcode),'GET').then(function(res){
    if(seq!==_chQrSeq) return;
    if(!res || res.error) throw new Error(res.error||'poll failed');
    var st=res.status;
    var stEl=document.getElementById('wxQrStatus');
    if(st==='wait'){ setTimeout(function(){ if(seq===_chQrSeq) chPollWeixinQr(qrcode, seq); }, 3000); }
    else if(st==='scaned'){ if(stEl) stEl.textContent='已扫码，请在微信中确认登录…'; setTimeout(function(){ if(seq===_chQrSeq) chPollWeixinQr(qrcode, seq); }, 3000); }
    else if(st==='expired'){ var body=document.getElementById('chModalBody'); if(body) body.innerHTML='<div class="conn-hint">二维码已过期，请重新获取。</div><button class="btn" style="margin-top:10px" onclick="chStartWeixinQr()">重新获取二维码</button>'; }
    else if(st==='confirmed'){ if(stEl) stEl.textContent='登录成功，正在保存凭证…'; apiPost('/api/channels/weixin',{ credentials:{ WEIXIN_TOKEN:res.token||'', WEIXIN_ACCOUNT_ID:res.account_id||'', WEIXIN_BASE_URL:res.base_url||'' } }).then(function(r){ if(!r || r.ok===false){ if(stEl) stEl.textContent='保存失败：'+(r&&r.error?r.error:'服务器没有返回凭证保存原因'); return; } apiGet('/api/channels').then(function(r2){ _chState.channels=(r2&&r2.channels)||_chState.channels; renderChannels(); chShowQrSuccess('微信'); }); }); }
  }).catch(function(e){ var stEl=document.getElementById('wxQrStatus'); if(stEl) stEl.textContent='轮询出错：'+(e.message||e); });
}
/* 企业微信扫码登录：腾讯官方 AI 机器人扫码接口（与 Octop 一致），
   无需预先填写 Corp ID——扫码授权后由服务端获取 bot_id + secret 自动保存。 */
function chStartWecomQr(){
  var seq=++_chQrSeq;
  var body=document.getElementById('chModalBody'); body.innerHTML='<div class="conn-hint">正在生成企业微信授权二维码…</div>';
  apiGet('/api/channels/wecom/qr').then(function(res){
    if(seq!==_chQrSeq) return;
    if(!res || res.error) throw new Error(res.error||'获取二维码失败');
    var authUrl=res.qr_payload||res.qr_url||res.deep_link||'';
    if(!authUrl){ body.innerHTML='<div class="conn-hint" style="color:var(--red)">无法生成二维码</div>'; return; }
    body.innerHTML='<div class="conn-hint">用企业微信「扫一扫」扫描下方二维码，在手机端确认创建 AI 机器人。</div><div style="display:flex;justify-content:center;padding:12px"><canvas id="wcQR" width="220" height="220" style="width:220px;height:220px;background:#fff;border-radius:var(--radius-md)"></canvas></div><div id="wcQrStatus" style="text-align:center;font-size:13px;color:var(--text3)">等待扫码授权…</div>';
    chRenderQr(authUrl, 'wcQR');
    chPollWecomQr(res.scode, seq);
  }).catch(function(e){ if(seq!==_chQrSeq) return; body.innerHTML='<div class="conn-hint" style="color:var(--red)">无法获取二维码：'+(e.message||e)+'</div>'; });
}
function chPollWecomQr(scode, seq){
  if(seq===undefined) seq=_chQrSeq;
  api('/api/channels/wecom/qr/status?scode='+encodeURIComponent(scode),'GET').then(function(res){
    if(seq!==_chQrSeq) return;
    var stEl=document.getElementById('wcQrStatus');
    if(!res || res.error){ if(stEl) stEl.textContent='轮询失败：'+((res&&res.error)||'服务器没有返回扫码状态原因'); return; }
    var st=res.status;
    if(st==='waiting'){ if(stEl) stEl.textContent='等待扫码确认…'; setTimeout(function(){ if(seq===_chQrSeq) chPollWecomQr(scode, seq); }, 3000); }
    else if(st==='ready'){ if(stEl) stEl.textContent='✅ 授权成功：Bot '+(res.bot_id||'')+'，点击「完成」启用。'; var foot=document.getElementById('chModalFoot'); if(foot) foot.innerHTML='<div style="margin-right:auto;font-size:11px;color:var(--text3)">凭证仅保存在本机</div><button class="btn primary" onclick="chApplyWecomQr(\''+esc(scode)+'\')">完成</button>'; }
    else if(st==='expired'||st==='error'){ var z=document.getElementById('chModalBody'); if(z) z.innerHTML='<div class="conn-hint" style="color:var(--red)">'+(res.error||'扫码失败或二维码已过期。')+'</div><button class="btn" style="margin-top:10px" onclick="chStartWecomQr()">重新获取二维码</button>'; }
  }).catch(function(e){ if(seq!==_chQrSeq) return; var stEl=document.getElementById('wcQrStatus'); if(stEl) stEl.textContent='轮询出错：'+(e.message||e); });
}
function chApplyWecomQr(scode){
  apiPost('/api/channels/wecom/qr/apply', { scode: scode }).then(function(res){
    if(res && res.error) throw new Error(res.error);
    apiGet('/api/channels').then(function(r2){ _chState.channels=(r2&&r2.channels)||_chState.channels; renderChannels(); chShowQrSuccess('企业微信'); });
  }).catch(function(e){ toast('保存失败：'+(e.message||e)); });
}