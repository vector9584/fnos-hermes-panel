/* 消息操作：语音播放 / 引用 / Fork
 * 来源：index.html 内联 app.js 第 2385-3251 行（共 867 行）
 * 2026-11-13 按原分区纯搬运外移，逻辑零改动。全局作用域与执行顺序与原内联块一致。 */

/* ============================ 消息操作：语音播放 / 引用 / Fork ============================ */
var _currentQuote = null;
/* ═══════════════ 语音对话模块（v0.22 Studio：服务端 TTS/STT） ═══════════════
 * 能力：
 *  - speakMsg：服务端流式 TTS（WS /proxy/dashboard/api/audio/speak-stream，int16 PCM 播放，
 *    再次点击即 barge-in 打断）；流式 provider 不可用时降级整段 TTS（POST /api/audio/speak）；
 *    两者都失败回退浏览器 speechSynthesis。
 *  - 麦克风输入：getUserMedia → MediaRecorder(webm/opus) → base64 dataURL → POST
 *    /api/audio/transcribe → 文本自动填入并发送（可在语音设置关闭自动发送）。
 *  - 自动朗读：设置开启后助手回复完成自动播放（localStorage: fnos-voice-autoplay）。
 * 协议依据本地 hermes_cli/web_server.py：transcribe {data_url,mime_type}→{ok,transcript}；
 *  speak {text}→{ok,data_url}；speak-stream: client {"text"|"done"|"stop"} →
 *  server {"type":"start",sample_rate,channels} → 二进制 PCM 帧 → {"type":"end"} | {"type":"fallback"} */
var _voice = { recording:false, recorder:null, chunks:[], stream:null, recTimer:null,
               ws:null, ctx:null, src:null, playing:false, curBtn:null, pcmBuf:[], pcmRate:24000, pcmCh:1,
               chatLoop:false, recStart:0, chatSilentCount:0 };
function voiceAudioUrl(p){ return apiUrl('/proxy/dashboard/api/audio' + p); }
function voiceWSUrl(p){
  var proto = location.protocol==='https:' ? 'wss:' : 'ws:';
  return proto + '//' + location.host + apiUrl('/proxy/dashboard/api/audio' + p);
}
function voiceGetText(btn){
  var msgEl = btn.closest('.msg');
  if(!msgEl) return '';
  var text = msgEl.getAttribute('data-content') || (msgEl.querySelector('.md-text') ? msgEl.querySelector('.md-text').textContent : '');
  var tmp = document.createElement('textarea'); tmp.innerHTML = text; text = tmp.value;
  return text;
}
function voiceBtnHtml(mode){
  if(mode==='stop') return '<svg viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>停止';
  return '<svg viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>播放';
}
/* ── 流式语音朗读（边生成边逐句朗读，服务端 speak-stream 增量协议） ──
 * 服务端协议：client 发 {"text":增量} 帧（按句切分合成返回 PCM）、{"done":true} 结束、
 * {"stop":true} 打断；server 返回 {"type":"start"} → PCM 帧 → {"type":"end"}。
 * 自动朗读开启时，onDelta 把增量文本持续喂给 WS，实现"变生成边朗读"。 */
var _voiceStream = { active:false, btn:null, pendingStop:false };
function _voiceStreamOpen(){
  var v = _voice;
  if(_voiceStream.active) return;
  try{
    var ws = new WebSocket(voiceWSUrl('/speak-stream'));
    v.ws = ws; v.pcmBuf=[]; v.pcmRate=24000; v.pcmCh=1; v.playing=false;
    _voiceStream.active = true;
    var gotStart = false;
    ws.onmessage = function(ev){
      if(typeof ev.data === 'string'){
        try{
          var j = JSON.parse(ev.data);
          if(j.type==='start'){ gotStart=true; v.pcmRate=j.sample_rate||24000; v.pcmCh=j.channels||1; return; }
          if(j.type==='end'){ return; }
          if(j.type==='fallback'){ try{ ws.close(); }catch(e){} v.ws=null; _voiceStream.active=false; return; }
        }catch(e){}
        return;
      }
      if(gotStart && ev.data && ev.data.byteLength){
        var f = new Float32Array(ev.data.byteLength/2);
        var dv = new DataView(ev.data);
        for(var i=0;i<f.length;i++){ f[i]=dv.getInt16(i*2,true)/32768; }
        v.pcmBuf.push(f);
        voicePlayNext();
      }
    };
    ws.onerror = function(){ try{ ws.close(); }catch(e){} v.ws=null; _voiceStream.active=false; };
    ws.onclose = function(){ if(v.ws===ws) v.ws=null; _voiceStream.active=false; _voiceChatMaybeRestart(); };
    ws.onopen = function(){
      _bargeInStart();   // 开始朗读 → 启动打断监听
    };
  }catch(e){ _voiceStream.active=false; }
}
function _voiceStreamFeed(text){
  if(!_voiceStream.active || !text) return;
  try{ _voice.ws.send(JSON.stringify({ text: text })); }catch(e){ _voiceStream.active=false; }
}
function _voiceStreamDone(){
  if(!_voiceStream.active) return;
  var v = _voice;
  try{ v.ws.send(JSON.stringify({ done: true })); }catch(e){}
  // done 后不再接收新文本；服务端合成完缓冲句子后自然结束
}
function _voiceStreamStop(){
  var v = _voice;
  _voiceStream.active = false;
  if(v.ws){ try{ v.ws.send(JSON.stringify({ stop: true })); }catch(e){} try{ v.ws.close(); }catch(e){} v.ws=null; }
  voiceStopAll(true);
  _bargeInStop();
  if(v.chatLoop){ v.chatLoop=false; toast('语音对话已打断'); }
}
/* ── Barge-in：朗读中检测到用户说话 → 停止朗读 → 自动听用户 ── */
var _bargeCtx=null, _bargeAnalyser=null, _bargeStream=null, _bargeTimer=null, _bargeFired=false;
function _bargeInStart(){
  if(_bargeStream || _bargeFired) return;
  if(localStorage.getItem('fnos-voice-barge') === '0') return;  // 可在语音设置关闭
  try{
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function(stream){
      if(_bargeFired){ try{ stream.getTracks().forEach(function(t){ t.stop(); }); }catch(e){} return; }
      _bargeStream = stream;
      var ac = new (window.AudioContext||window.webkitAudioContext)();
      var src = ac.createMediaStreamSource(stream);
      var an = ac.createAnalyser(); an.fftSize=512;
      src.connect(an);
      _bargeCtx=ac; _bargeAnalyser=an;
      _bargeTick();
    }).catch(function(){});
  }catch(e){}
}
function _bargeTick(){
  if(!_bargeAnalyser || _bargeFired) return;
  if(!_voice.playing){ _bargeTimer=setTimeout(_bargeTick,120); return; }
  var data = new Uint8Array(_bargeAnalyser.frequencyBinCount);
  _bargeAnalyser.getByteTimeDomainData(data);
  var sum=0;
  for(var i=0;i<data.length;i++){ var x=(data[i]-128)/128; sum+=x*x; }
  var rms = Math.sqrt(sum/data.length);
  if(rms > 0.12){ _voiceBargeIn(); return; }
  _bargeTimer = setTimeout(_bargeTick, 120);
}
function _voiceBargeIn(){
  if(_bargeFired) return;
  _bargeFired = true;
  var v = _voice;
  _voiceStreamStop();          // 停止朗读（stop 帧告知服务端被 barge-in）
  _bargeInStop();
  toast('🎙️ 打断成功，请说…');
  setTimeout(function(){ _bargeFired=false; startVoiceRecord(); }, 350);  // 自动开始听用户
}
function _bargeInStop(){
  _bargeFired = false;
  if(_bargeTimer){ clearTimeout(_bargeTimer); _bargeTimer=null; }
  if(_bargeCtx){ try{ _bargeCtx.close(); }catch(e){} }
  _bargeCtx=null; _bargeAnalyser=null;
  if(_bargeStream){ try{ _bargeStream.getTracks().forEach(function(t){ t.stop(); }); }catch(e){} _bargeStream=null; }
}
function voiceStopAll(resetBtn){
  var v = _voice;
  if(v.ws){ try{ v.ws.send(JSON.stringify({stop:true})); }catch(e){} try{ v.ws.close(); }catch(e){} v.ws=null; }
  if(v.src){ try{ v.src.stop(); }catch(e){} v.src=null; }
  if(v.ctx && v.ctx.state==='running'){ try{ v.ctx.close(); }catch(e){} }
  v.ctx=null; v.pcmBuf=[]; v.playing=false;
  if(resetBtn!==false){
    if(v.curBtn){ try{ v.curBtn.classList.remove('speaking'); v.curBtn.innerHTML=voiceBtnHtml('play'); }catch(e){} }
    v.curBtn=null;
  }
}
function voicePlayNext(){
  var v = _voice;
  if(v.playing) return;
  var samples = v.pcmBuf.shift();
  if(!samples || !samples.length) return;
  try{
    if(!v.ctx){ v.ctx = new (window.AudioContext||window.webkitAudioContext)(); }
    if(v.ctx.state==='suspended'){ v.ctx.resume(); }
    var buf = v.ctx.createBuffer(1, samples.length, v.pcmRate||24000);
    var d = buf.getChannelData(0);
    for(var i=0;i<samples.length;i++){ d[i]=samples[i]; }
    var s = v.ctx.createBufferSource(); s.buffer=buf; s.connect(v.ctx.destination);
    s.onended = function(){ if(v.src===s) v.src=null; v.playing=false; voicePlayNext(); };
    v.src=s; v.playing=true; s.start();
  }catch(e){ console.warn('[voice] play failed', e); v.playing=false; }
}
function speakMsg(btn){
  var v = _voice;
  var text = voiceGetText(btn);
  if(!text){ toast('无可播放内容'); return; }
  if(v.curBtn === btn){ voiceStopAll(true); return; }   // 点击打断 = barge-in
  voiceStopAll(false);
  // 1) 服务端流式 TTS
  try{
    var ws = new WebSocket(voiceWSUrl('/speak-stream'));
    v.ws = ws; v.pcmBuf=[]; v.pcmRate=24000; v.pcmCh=1; v.playing=false;
    btn.classList.add('speaking'); btn.innerHTML=voiceBtnHtml('stop'); v.curBtn=btn;
    var gotStart = false, finished = false;
    function finishOk(){
      if(v.ws===ws){ try{ ws.close(); }catch(e){} v.ws=null; }
      if(finished) return; finished = true;
      if(v.curBtn===btn){ btn.classList.remove('speaking'); btn.innerHTML=voiceBtnHtml('play'); v.curBtn=null; }
      _voiceChatMaybeRestart();
    }
    ws.onopen = function(){
      ws.send(JSON.stringify({ text: text }));   // 整段下发，服务端按句切分逐句合成
      ws.send(JSON.stringify({ done: true }));
    };
    ws.onmessage = function(ev){
      if(typeof ev.data === 'string'){
        try{
          var j = JSON.parse(ev.data);
          if(j.type==='start'){ gotStart=true; v.pcmRate=j.sample_rate||24000; v.pcmCh=j.channels||1; return; }
          if(j.type==='end'){ finishOk(); return; }
          if(j.type==='fallback'){ try{ ws.close(); }catch(e){} v.ws=null; speakMsgFallback(btn, text); return; }
        }catch(e){}
        return;
      }
      if(gotStart && ev.data && ev.data.byteLength){
        var f = new Float32Array(ev.data.byteLength/2);
        var dv = new DataView(ev.data);
        for(var i=0;i<f.length;i++){ f[i]=dv.getInt16(i*2,true)/32768; }
        v.pcmBuf.push(f);
        voicePlayNext();
      }
    };
    ws.onerror = function(){ try{ ws.close(); }catch(e){} v.ws=null; if(!finished) speakMsgFallback(btn, text); };
    ws.onclose = function(){ if(v.ws===ws) v.ws=null; };
    return;
  }catch(e){ console.warn('[voice] stream unavailable', e); }
  // 2) 整段 TTS 降级
  speakMsgFallback(btn, text);
}
function speakMsgFallback(btn, text){
  var v = _voice;
  text = text.replace(/[#*`~\[\]()]/g,'').replace(/\n+/g,'。');
  fetch(voiceAudioUrl('/speak'), { method:'POST', headers:{'Content-Type':'application/json','X-Monitor-Token':monitorToken||''}, body: JSON.stringify({ text: text }) })
    .then(function(r){ if(!r.ok) throw new Error('speak '+r.status); return r.json(); })
    .then(function(j){
      if(!j.ok || !j.data_url) throw new Error(j.error||'TTS failed');
      var au = new Audio(j.data_url);
      var stopIt = function(){ try{ au.pause(); au.src=''; }catch(e){} voiceStopAll(true); btn.removeEventListener('click', stopIt); };
      au.onended = function(){ btn.removeEventListener('click', stopIt); if(v.curBtn===btn){ btn.classList.remove('speaking'); btn.innerHTML=voiceBtnHtml('play'); v.curBtn=null; } _voiceChatMaybeRestart(); };
      btn.classList.add('speaking'); btn.innerHTML=voiceBtnHtml('stop'); v.curBtn=btn;
      btn.addEventListener('click', stopIt);
      au.play().catch(function(){ btn.removeEventListener('click', stopIt); if(v.curBtn===btn){ btn.classList.remove('speaking'); btn.innerHTML=voiceBtnHtml('play'); v.curBtn=null; } toast('语音播放失败：浏览器拦截自动播放，请点击播放按钮'); });
    })
    .catch(function(){
      // 3) 浏览器 speechSynthesis 兜底
      if(!window.speechSynthesis){ toast('语音播放不可用'); return; }
      if(v.curBtn===btn){ v.curBtn=null; }
      window.speechSynthesis.cancel();
      var utter = new SpeechSynthesisUtterance(text);
      utter.lang='zh-CN'; utter.rate=1.0;
      utter.onend = function(){ btn.classList.remove('speaking'); btn.innerHTML=voiceBtnHtml('play'); };
      utter.onerror = utter.onend;
      btn.classList.add('speaking'); btn.innerHTML=voiceBtnHtml('stop');
      window.speechSynthesis.speak(utter);
    });
}
/* ── 麦克风语音输入 ──
   三个入口，别混：
   · 按住麦克风图标（mode=voice）→ 录完直接发一条语音（音频附件 + 转写正文）
   · 按住输入框（mode=text）    → 录完只把文字落到光标处，绝不自动发送
   · 老入口 legacy（语音对话循环 / 朗读打断 / 键盘）→ 转文字后按旧逻辑处理
   手势的按下/抬起在 micHoldStart/inputHoldStart 那一组里，这里只管录和送。 */
function toggleVoiceRecord(){
  var v = _voice;
  if(v.recording){ stopVoiceRecord(); }
  else { startVoiceRecord('legacy'); }
}
function micIconHtml(){
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="17" x2="12" y2="22"/></svg>';
}
function stopIconHtml(){
  return '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>';
}
function setMicButtonState(btn,recording,mode){
  if(!btn) return;
  var label = recording ? (mode==='voice' ? '松手发语音' : (mode==='text' ? '松手转文字' : '停止录音并识别'))
                        : '按住说话：松手发语音；输入框上长按＝转文字';
  btn.setAttribute('aria-label',label);
  btn.title=label;
}
/* 按住说话时的提示药丸（固定底部，不拦点击） */
function voiceHoldTip(on, label){
  var el = document.getElementById('voiceHoldTip');
  if(!el){
    el = document.createElement('div');
    el.id='voiceHoldTip'; el.className='voice-hold-tip';
    el.innerHTML='<i></i><span></span>';
    document.body.appendChild(el);
  }
  var sp = el.querySelector('span');
  if(sp && label) sp.innerHTML = label;
  if(on){
    /* 药丸浮在输入区上方。早先 CSS 写死 bottom:104px，小屏上输入框顶到 730/454，
       药丸正好压进去（2026-11-12 实测 390 宽重叠 1000px²、320 宽 930px²）。
       现在按输入区顶边反算 bottom：bottom = 视口高 - 输入区 top + 8。 */
    var comp = document.getElementById('chatComposer') || document.querySelector('.chat-composer');
    var bottom = 104;
    if(comp){
      var top = comp.getBoundingClientRect().top;
      bottom = Math.round(window.innerHeight - top + 8);
      bottom = Math.max(40, Math.min(bottom, window.innerHeight - 40));
    }
    el.style.bottom = bottom + 'px';
  }
  el.classList.toggle('on', !!on);
}
/* 语音对话循环：朗读结束后自动重新开始录音（免手连续对话） */
function _voiceChatMaybeRestart(){
  var v = _voice;
  if(!v.chatLoop || localStorage.getItem('fnos-voice-chat') !== '1') return;
  if(v.recording) return;
  setTimeout(function(){
    if(!v.chatLoop || localStorage.getItem('fnos-voice-chat') !== '1') return;
    if(v.recording) return;
    toast('🎙️ 语音对话中，请说话…（点麦克风结束）');
    startVoiceRecord('legacy');
  }, 600);
}
/* 语音对话中无效输入重试：连续 3 次录音过短/无语音则退出循环 */
function _voiceChatSilent(){
  var v = _voice;
  if(!v.chatLoop) return;
  v.chatSilentCount = (v.chatSilentCount||0) + 1;
  if(v.chatSilentCount >= 3){ v.chatLoop = false; v.chatSilentCount = 0; toast('语音对话已结束（连续未听清）'); return; }
  setTimeout(function(){ if(v.chatLoop && !v.recording){ toast('🎙️ 没听清，请再说一次…'); startVoiceRecord('legacy'); } }, 900);
}
function startVoiceRecord(mode){
  var btn = document.getElementById('btnMic');
  var v = _voice;
  mode = mode || 'legacy';
  if(v.recording) return;
  // 安全上下文检测：getUserMedia 仅 HTTPS/localhost 可用，HTTP 明文访问下浏览器直接禁用
  if(!window.isSecureContext){
    toast('浏览器禁止 HTTP 页面使用麦克风，请改用 https://'+location.hostname+':5667 访问（首次需点击「继续访问」信任自签名证书）','error');
    return;
  }
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){ toast('当前浏览器不支持录音'); return; }
  v.mode = mode;
  v.cancel = false;
  navigator.mediaDevices.getUserMedia({ audio: true }).then(function(stream){
    // 权限弹窗期间手可能已经松开了：这一下不算数，别录成"永远停不下来"
    var held = (mode==='voice') ? _micDown : (mode==='text' ? _inHold.armed : true);
    if(!held){
      try{ stream.getTracks().forEach(function(t){ t.stop(); }); }catch(e){}
      toast('麦克风已就绪，再按住一次就行');
      return;
    }
    v.stream = stream;
    var mime = '';
    try{
      if(window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) mime='audio/webm;codecs=opus';
      else if(window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('audio/webm')) mime='audio/webm';
      else if(window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('audio/mp4')) mime='audio/mp4';
    }catch(e){}
    try{ v.recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); }
    catch(e){ v.recorder = new MediaRecorder(stream); }
    v.chunks = [];
    v.recorder.ondataavailable = function(ev){ if(ev.data && ev.data.size) v.chunks.push(ev.data); };
    v.recorder.onstop = function(){
      try{ stream.getTracks().forEach(function(t){ t.stop(); }); }catch(e){}
      v.recording = false;
      var doneMode = v.mode;
      if(btn){ btn.classList.remove('recording'); btn.innerHTML = micIconHtml(); setMicButtonState(btn,false,doneMode); }
      var ta = document.getElementById('chatInput'); if(ta) ta.classList.remove('voice-holding');
      voiceHoldTip(false);
      var blob = new Blob(v.chunks, { type: (v.recorder.mimeType||'audio/webm').split(';')[0] || 'audio/webm' });
      v.chunks = [];
      if(v.cancel){ v.cancel=false; return; }
      if(!blob.size){ if(doneMode==='legacy'){ _voiceChatSilent(); } else { toast('没录到声音'); } return; }
      // text 模式只有先按住 550ms 才会开始录，进到这里说明他确实按住了，门槛就该比 voice 低
      var minMs = (doneMode==='text') ? 250 : 600;
      if(Date.now() - (v.recStart||0) < minMs){
        if(doneMode==='legacy'){ _voiceChatSilent(); } else { toast('按太短了，按住说完再松手'); }
        return;
      }
      v.chatSilentCount = 0;  // 有效录音：重置无效计数
      var realMime = blob.type.split(';')[0] || 'audio/webm';
      /* 静音闸门（2026-11-12）：时长和体积都过关、但内容全是静音的录音，
         以前会一路传到服务端，转写返回空串，用户看到的是「转写没成功」——
         他以为是转写坏了，其实是麦克风没收到人声。这里先量电平。 */
      audioVoiceGate(blob, function(g){
        if(!g.ok){
          if(doneMode==='legacy'){ _voiceChatSilent(); }
          else { toast('没录到人声（'+g.dur.toFixed(2)+'秒，峰值 '+Math.round(g.peak*100)+'%）——麦克风可能静音了或被别的设备占用'); }
          return;
        }
        var reader = new FileReader();
        reader.onload = function(){
          if(doneMode==='voice'){ sendVoiceMessage(blob, reader.result, realMime); }
          else { transcribeVoice(reader.result, realMime, doneMode); }
        };
        reader.readAsDataURL(blob);
      });
    };
    v.recorder.start();
    v.recording = true;
    v.recStart = Date.now();
    if(btn){
      btn.classList.add('recording');
      btn.innerHTML = stopIconHtml();
      setMicButtonState(btn,true,mode);
    }
    if(mode==='voice'){ voiceHoldTip(true,'<b>正在听</b>：松手发语音'); }
    else if(mode==='text'){
      voiceHoldTip(true,'<b>正在听</b>：松手转成文字');
      var ta=document.getElementById('chatInput'); if(ta) ta.classList.add('voice-holding');
    } else { toast('正在录音…再次点击麦克风停止'); }
    // 按住说话是手动的，超时只兜底（防止指针事件丢失把麦克风挂死）
    var recTimeout = (mode==='legacy') ? (v.chatLoop ? 15000 : 60000) : 60000;
    v.recTimer = setTimeout(function(){
      if(v.recording){
        var wasChat = v.chatLoop && v.mode==='legacy';
        stopVoiceRecord();
        if(wasChat && v.chatLoop){ v.chatLoop = false; toast('语音对话已结束（长时间未说话）'); }
      }
    }, recTimeout);
  }).catch(function(err){
    voiceHoldTip(false);
    var ta=document.getElementById('chatInput'); if(ta) ta.classList.remove('voice-holding');
    var n = err && err.name ? err.name : '';
    if(n==='NotAllowedError'){ toast('麦克风权限被拒绝：请在浏览器地址栏的站点设置里允许麦克风'); }
    else if(n==='NotFoundError'){ toast('没找到麦克风设备'); }
    else { toast('无法访问麦克风（权限被拒绝或设备不可用）'); }
  });
}
function stopVoiceRecord(){
  var v = _voice;
  if(v.recTimer){ clearTimeout(v.recTimer); v.recTimer=null; }
  if(v.recorder && v.recorder.state !== 'inactive'){ try{ v.recorder.stop(); }catch(e){} }
  else {
    if(v.stream){ try{ v.stream.getTracks().forEach(function(t){ t.stop(); }); }catch(e){} }
    v.recording = false;
    var btn = document.getElementById('btnMic'); if(btn){ btn.classList.remove('recording'); btn.innerHTML = micIconHtml(); setMicButtonState(btn,false,v.mode); }
    voiceHoldTip(false);
    var ta=document.getElementById('chatInput'); if(ta) ta.classList.remove('voice-holding');
  }
}
/* mode=text 时插到光标处，不发送 */
function insertAtCursor(ta, text){
  if(!ta) return;
  ta.focus();
  var s = ta.selectionStart, e = ta.selectionEnd, val = ta.value || '';
  if(typeof s !== 'number' || s < 0 || s > val.length){ s = e = val.length; }
  var before = val.slice(0,s), after = val.slice(e);
  var sep = '';
  if(after && /^[A-Za-z0-9]/.test(after) && !/[\s]$/.test(before)) sep = ' ';
  ta.value = before + text + sep + after;
  var pos = (before + text + sep).length;
  try{ ta.setSelectionRange(pos,pos); }catch(_){}
  if(typeof autoResize === 'function') autoResize(ta);
  if(typeof saveDraft === 'function') saveDraft(currentSession);
}
/* 录音电平闸门：只判「有没有人声」，不判内容。
   依据（2026-11-12 实测那 6 条空录音）：静音录音的波形是「前 500ms 全 0 +
   一个按下去时的爆音（峰值 0.30，十几个 10ms 帧内衰减到 0）+ 归零」；
   真人说一句话，10ms 粒度上有几十上百帧超过 0.02。所以门槛取 20 帧（200ms）。
   解码失败（个别浏览器不支持 webm 解码）时放行，不拿闸门挡住正常发送。 */
function audioVoiceGate(blob, cb){
  var AC = window.AudioContext || window.webkitAudioContext;
  if(!blob || !blob.size){ cb({ok:false, dur:0, peak:0, loud:0}); return; }
  if(!AC){ cb({ok:true, skipped:true, dur:0, peak:0, loud:0}); return; }
  var fr = new FileReader();
  fr.onerror = function(){ cb({ok:true, skipped:true, dur:0, peak:0, loud:0}); };
  fr.onload = function(){
    var ac;
    try{ ac = new AC(); }catch(e){ cb({ok:true, skipped:true, dur:0, peak:0, loud:0}); return; }
    var done = false;
    function finish(res){ if(done) return; done = true; try{ ac.close(); }catch(e){} cb(res); }
    var p;
    try{ p = ac.decodeAudioData(fr.result.slice(0)); }catch(e){ finish({ok:true, skipped:true, dur:0, peak:0, loud:0}); return; }
    p.then(function(ab){
      var ch = ab.getChannelData(0);
      var sr = ab.sampleRate || 48000;
      var step = Math.max(1, Math.round(sr * 0.01));
      var loud = 0, peak = 0;
      for(var i=0; i<ch.length; i+=step){
        var s = 0, n = 0, j, x;
        for(j=i; j<i+step && j<ch.length; j++){ x = ch[j]; s += x*x; n++; }
        if(!n) break;
        var rms = Math.sqrt(s/n);
        if(rms > peak) peak = rms;
        if(rms > 0.02) loud++;
      }
      finish({ ok: (loud >= 20), dur: ch.length/sr, peak: peak, loud: loud });
    }).catch(function(){ finish({ok:true, skipped:true, dur:0, peak:0, loud:0}); });
  };
  fr.readAsArrayBuffer(blob);
}
function transcribeVoice(dataUrl, mime, mode){
  var btn = document.getElementById('btnMic');
  toast('语音识别中…');
  fetch(voiceAudioUrl('/transcribe'), { method:'POST', headers:{'Content-Type':'application/json','X-Monitor-Token':monitorToken||''}, body: JSON.stringify({ data_url: dataUrl, mime_type: mime }) })
    .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){ if(!r.ok){ var e = new Error((j.error||j.detail)||('transcribe '+r.status)); e.j=j; throw e; } return j; }); })
    .then(function(j){
      if(btn){ btn.classList.remove('recording'); btn.innerHTML = micIconHtml(); setMicButtonState(btn,false,mode); }
      var t = (j.transcript || '').trim();
      if(!t){ if(_voice.chatLoop && mode==='legacy'){ _voiceChatSilent(); } else { toast('没有听清，请再说一次'); } return; }
      var ta = document.getElementById('chatInput');
      if(mode==='text'){
        insertAtCursor(ta, t);
        toast('已转成文字，可以改了');
        return;
      }
      if(ta){ ta.value = t; autoResize(ta); }
      if(_voice.chatLoop || localStorage.getItem('fnos-voice-autosend') !== '0'){ sendChat(); }
      else { toast('识别完成'); try{ ta.focus(); }catch(e){} }
    })
    .catch(function(err){
      if(btn){ btn.classList.remove('recording'); btn.innerHTML = micIconHtml(); setMicButtonState(btn,false,mode); }
      var msg = err && err.j && err.j.error ? err.j.error : (err && err.message ? err.message : '语音识别失败');
      toast('语音识别失败：'+msg);
    });
}
/* 语音条：音频原件上传成附件（气泡里可播放），转写文本当正文喂给模型 */
function sendVoiceMessage(blob, dataUrl, mime){
  var d = new Date();
  var pad = function(n){ return (n<10?'0':'')+n; };
  var ext = /mp4|m4a|aac/i.test(mime) ? 'm4a' : 'webm';
  var name = '语音 '+pad(d.getMonth()+1)+pad(d.getDate())+'-'+pad(d.getHours())+pad(d.getMinutes())+'.'+ext;
  var file;
  try{ file = new File([blob], name, { type: mime }); }
  catch(e){ file = blob; file.name = name; }
  toast('正在发送语音…');
  var pText = fetch(voiceAudioUrl('/transcribe'), { method:'POST', headers:{'Content-Type':'application/json','X-Monitor-Token':monitorToken||''}, body: JSON.stringify({ data_url: dataUrl, mime_type: mime }) })
    .then(function(r){ return r.json(); })
    .then(function(j){ return (j && j.transcript || '').trim(); })
    .catch(function(){ return ''; });
  var pUp = uploadAttachment(file, '/api/chat/upload-file');
  Promise.all([pText, pUp]).then(function(res){
    var t = res[0], ok = res[1];
    if(!ok){ toast('语音没传上去'); return; }
    // sendChat() 只认输入框，不吃参数：先把正文填进去，发完再把草稿放回去
    var ta = document.getElementById('chatInput');
    var draft = ta ? ta.value : '';
    if(ta){ ta.value = t || '（语音消息，转写没成功，请直接听附件）'; autoResize(ta); }
    sendChat();
    if(ta && draft){ ta.value = draft; autoResize(ta); }
  });
}
/* ── 手势：按住麦克风 = 发语音；按住输入框 = 转文字 ── */
var _micDown = false;
function micHoldStart(e){
  if(e && e.pointerType==='mouse' && e.button!==0) return;
  if(_micDown) return;                                               // 同一次触摸被 touch/pointer 各叫一次，别把自己停了
  if(_voice.recording){ _micDown=false; stopVoiceRecord(); return; }   // 老入口（legacy）用它收尾
  _micDown = true;
  try{ if(e && e.pointerType!=='mouse' && e.preventDefault) e.preventDefault(); }catch(_){}
  // 语音对话模式已被按住说话取代，避免两套手势打架
  if(localStorage.getItem('fnos-voice-chat') === '1'){
    localStorage.removeItem('fnos-voice-chat');
    _voice.chatLoop = false;
    toast('语音对话模式已换成按住说话，旧开关自动关闭');
  }
  startVoiceRecord('voice');
}
function micHoldEnd(e){
  if(!_micDown) return;
  _micDown = false;
  if(_voice.recording && _voice.mode==='voice') stopVoiceRecord();
}
var _inHold = { timer:null, armed:false, x:0, y:0 };
function _inputHasText(){
  var t = document.getElementById('chatInput');
  return !!(t && String(t.value||'').trim() !== '');
}
/* 「这一下该不该交给系统」的唯一判据：光标在框里 / 已有字 / 已有选区 → 交还原生，
   粘贴复制菜单、放大镜、拖光标一律按系统走，我们不 preventDefault、不起录音计时。
   （2026-11-13 第 41 条：以前只判 value 是否为空，光标明明在框里也被当成「空闲」抢走，
     用户按不出粘贴菜单。懒点可以，别把系统的活儿也抢了。） */
function _inputEditingNow(){
  var t = document.getElementById('chatInput');
  if(!t) return false;
  if(String(t.value||'').trim() !== '') return true;          // 有字
  if(document.activeElement === t) return true;               // 光标已经落进去
  try{ if(t.selectionStart != null && t.selectionStart !== t.selectionEnd) return true; }catch(_){}
  return false;
}
function inputHoldStart(e){
  var t = e.target;
  if(!t || t.id !== 'chatInput') return;
  if(e.pointerType==='mouse' && e.button!==0) return;
  if(_voice.recording) return;
  if(_inputEditingNow()) return;   // 有字/光标在框里：长按留给系统（选词/挪光标/粘贴菜单），不抢去录音
  _inHold.x = e.clientX||0; _inHold.y = e.clientY||0;
  if(_inHold.timer){ clearTimeout(_inHold.timer); }
  _inHold.timer = setTimeout(function(){
    _inHold.timer = null;
    _inHold.armed = true;
    _holdRecorded = true;      // 记下「这一下是录音」，松手后别再把键盘弹起来
    startVoiceRecord('text');
  }, 550);
}
function inputHoldMove(e){
  if(!_inHold.timer || _inHold.armed) return;
  if(Math.abs((e.clientX||0)-_inHold.x) > 10 || Math.abs((e.clientY||0)-_inHold.y) > 10){
    clearTimeout(_inHold.timer); _inHold.timer = null;
  }
}
function inputHoldEnd(){
  if(_inHold.timer){ clearTimeout(_inHold.timer); _inHold.timer = null; }
  if(_inHold.armed){
    _inHold.armed = false;
    if(_voice.recording && _voice.mode==='text') stopVoiceRecord();
  }
}
function inputHoldCancel(){
  if(_inHold.timer){ clearTimeout(_inHold.timer); _inHold.timer = null; }
  if(_inHold.armed){
    _inHold.armed = false;
    if(_voice.recording && _voice.mode==='text'){ _voice.cancel = true; stopVoiceRecord(); }
  }
}
/* ── 触摸端：掐掉 iOS 的原生文字手势（放大镜 / 选择 / 拷贝菜单）2026-11-12 ──
   用户反馈「手机上按钮和输入框长按都有放大和选择的效果」。放大镜和「选择/拷贝/粘贴」
   都是 iOS 文字选择系统的产物，CSS 只能压低概率（可编辑元素照样可选），必须在
   touchstart 阶段 preventDefault 掉整个原生手势。
   代价是这一下也不会自动聚焦，所以松手时若没到长按阈值，我们自己把焦点和光标放回去
   （caretRangeFromPoint 取点到位置，点哪落哪）。
   只对粗指针（手机/平板）接管；桌面鼠标的选字、拖选、右键一律照旧。 */
if(window.matchMedia && window.matchMedia('(pointer:coarse)').matches){
  document.documentElement.classList.add('touch-ui');
}
/* 框里有字/没字，决定上面那条 touch-callout 还回去还是收起来 */
function _syncInputHasText(){
  var t=document.getElementById('chatInput'); if(!t) return;
  var has = String(t.value||'').trim() !== '';
  if(t.classList.contains('has-text') !== has) t.classList.toggle('has-text', has);
}
document.addEventListener('input', function(e){
  if(e.target && e.target.id === 'chatInput') _syncInputHasText();
}, true);
setTimeout(function(){ _syncInputHasText(); var t=document.getElementById('chatInput'); if(t && !t.__hasTextWired){ t.__hasTextWired=1; t.addEventListener('input', _syncInputHasText); } }, 800);
var _touchPress = null;      // 输入框上一次触摸的落点
var _holdRecorded = false;   // 这次触摸真录了音（长按生效），松手不再补焦点
var _cmirror = null;
function _caretOffsetAt(x,y){
  /* textarea 里的字不在 DOM 里，caretRangeFromPoint 只会返回外面那个 DIV，
     所以用一个同字体同内边距的隐藏镜像逐字量光标位置，取离触点最近的那个字缝。
     这样「按住转文字」和「点一下打字」才都能点哪落哪。 */
  var t=document.getElementById('chatInput'); if(!t) return null;
  var r=t.getBoundingClientRect();
  if(x<r.left-2 || x>r.right+2 || y<r.top-2 || y>r.bottom+2) return null;
  var cs=getComputedStyle(t), val=t.value||'';
  if(!_cmirror){
    var m0=document.createElement('div');
    m0.id='__caretMirror';
    m0.setAttribute('aria-hidden','true');
    m0.style.cssText='position:fixed;left:-9999px;top:0;visibility:hidden;pointer-events:none;white-space:pre-wrap;word-break:break-word;overflow:hidden;';
    document.body.appendChild(m0);
    _cmirror=m0;
  }
  var m=_cmirror;
  ['font','fontFamily','fontSize','fontWeight','lineHeight','letterSpacing','padding','border','boxSizing','textIndent'].forEach(function(k){
    try{ m.style[k]=cs[k]; }catch(_){}
  });
  m.style.width=r.width+'px';
  m.textContent = val || ' ';
  var mb=m.getBoundingClientRect();
  var px = x - r.left - (parseFloat(cs.paddingLeft)||0) + t.scrollLeft;
  var py = y - r.top  - (parseFloat(cs.paddingTop)||0)  + t.scrollTop;
  var node=m.firstChild, best=val.length, bestD=1e9;
  try{
    var rg=document.createRange();
    for(var i=0;i<=val.length && i<600;i++){
      rg.setStart(node,i); rg.setEnd(node,i);
      var rc=rg.getBoundingClientRect();
      var dx=Math.abs(rc.left-mb.left-px), dy=Math.abs(rc.top-mb.top-py);
      var d=dy*8+dx;                      // 先按行对齐，再比同行内的横向距离
      if(d<bestD){ bestD=d; best=i; }
    }
  }catch(_){}
  return best;
}
document.addEventListener('touchstart', function(e){
  var el=e.target; if(!el || !el.closest) return;
  var isInput = el.id==='chatInput';
  var isMic = !!el.closest('.mic-btn');
  if(!isInput && !isMic) return;
  // 框里已经有字 → 这一下完全交给系统：选词、拖光标、放大镜都按原生走，不拦也不录音
  if(isInput && _inputEditingNow()){ _touchPress=null; _holdRecorded=false; return; }
  try{ e.preventDefault(); }catch(_){}          // ← 掐掉放大镜与选择菜单的关键一步
  var tp=(e.touches && e.touches[0]) || {clientX:0,clientY:0};
  if(isInput){
    _touchPress = {x:tp.clientX, y:tp.clientY};
    _holdRecorded = false;
    el.classList.add('pressing');
    // 有的 WebKit 在 touchstart 被取消后不再派发 pointerdown，这里自己起一次
    // （inputHoldStart 里的 550ms 计时会被随后的 pointerdown 重置，重复调用无害）
    inputHoldStart({target:el, pointerType:'touch', clientX:tp.clientX, clientY:tp.clientY, button:0});
  }else{
    micHoldStart({target:el, pointerType:'touch', clientX:tp.clientX, clientY:tp.clientY, button:0});
  }
}, {capture:true, passive:false});

document.addEventListener('touchend', function(e){
  var el=e.target;
  if(el && el.classList && el.classList.remove) el.classList.remove('pressing');
  if(el && el.closest && el.closest('.mic-btn')) micHoldEnd({});
  inputHoldEnd();                                // 幂等：没起计时就是空操作
  if(!_touchPress) return;
  var p=_touchPress; _touchPress=null;
  if(_holdRecorded) return;                      // 长按录过音了，别再弹键盘
  var t=document.getElementById('chatInput'); if(!t) return;
  var off=_caretOffsetAt(p.x,p.y);
  try{ t.focus({preventScroll:true}); }catch(_){ try{ t.focus(); }catch(__){} }
  try{ if(off==null) off=String(t.value||'').length; t.setSelectionRange(off,off); }catch(_){}
}, {capture:true, passive:true});

document.addEventListener('touchcancel', function(){
  _touchPress=null; _holdRecorded=false;
  var t=document.getElementById('chatInput'); if(t) t.classList.remove('pressing');
  micHoldEnd({}); inputHoldCancel();
}, {capture:true, passive:true});

document.addEventListener('pointerdown', inputHoldStart, true);
document.addEventListener('pointermove', inputHoldMove, true);
document.addEventListener('pointerup', inputHoldEnd, true);
document.addEventListener('pointercancel', inputHoldCancel, true);
document.addEventListener('contextmenu', function(e){
  if(_inHold.armed || _micDown){ try{ e.preventDefault(); }catch(_){} }
}, true);
window.addEventListener('blur', function(){ inputHoldCancel(); micHoldEnd({}); });

/* ── 语音设置 ── */
/* 聊天里点头像的两个入口。
   · 点自己的头像 → 只开「我的」那半，不混进助手字段
   · 点角色头像 → 给三条路：改名字头像 / 换角色 / 编辑角色设定
   原来是工具栏最右边那个齿轮（#btnVoiceCfg）承担头像设置，藏在输入框下面一排小图标里，
   谁也找不着；齿轮本身是「语音设置」，和头像也不是一回事。 */
window.openMyProfile = function(){
  if(window.pwIdentity){ try{ window.pwIdentity('me'); return; }catch(e){} }
  toast('头像设置还没加载完，稍等一下再点');
};

window.closeRoleMenu = function(){
  var el = document.getElementById('roleMenuOverlay');
  if(el) el.remove();
};

window.openRoleMenu = function(){
  var html = '<div class="modal-overlay" id="roleMenuOverlay" onclick="if(event.target===this)closeRoleMenu()">'
    + '<div class="modal" style="max-width:400px">'
    + '<div class="modal-head"><h3>当前角色</h3><button class="modal-close" aria-label="关闭" title="关闭" onclick="closeRoleMenu()">×</button></div>'
    + '<div class="modal-body" style="padding:6px 14px 12px"><div class="vs-list">'
    + '<button type="button" class="vs-item" style="width:100%;background:none;border:0;font-family:inherit;text-align:left" onclick="closeRoleMenu();try{pwIdentity(\'bot\')}catch(e){}">'
    + '<div class="vs-main"><span class="vs-t">角色名称与头像</span><span class="vs-h">改默认助手的名字和头像</span></div><span style="color:var(--text3)">›</span></button>'
    + '<button type="button" class="vs-item" style="width:100%;background:none;border:0;font-family:inherit;text-align:left" onclick="closeRoleMenu();try{pwOpenRole()}catch(e){}">'
    + '<div class="vs-main"><span class="vs-t">切换本会话角色</span><span class="vs-h">从专家库里挑一个，只影响后续回复</span></div><span style="color:var(--text3)">›</span></button>'
    + '<button type="button" class="vs-item" style="width:100%;background:none;border:0;font-family:inherit;text-align:left" onclick="closeRoleMenu();if(window.switchPage)switchPage(\'experts\')">'
    + '<div class="vs-main"><span class="vs-t">管理专家库</span><span class="vs-h">编辑角色职责、方法和头像</span></div><span style="color:var(--text3)">›</span></button>'
    + '</div></div></div></div>';
  closeRoleMenu();
  var div = document.createElement('div');
  div.innerHTML = html;
  window.ui.adoptOverlay(document.body.appendChild(div.firstChild));
};

function openVoiceSettings(){
  var on = localStorage.getItem('fnos-voice-autoplay') === '1';
  var autosend = localStorage.getItem('fnos-voice-autosend') !== '0';
  var voiceChat = localStorage.getItem('fnos-voice-chat') === '1';
  var html = '<div class="modal-overlay" id="voiceSetOverlay" onclick="if(event.target===this)closeVoiceSettings()">' +
    '<div class="modal" style="max-width:440px">' +
    '<div class="modal-head"><h3>🎙️ 语音设置</h3><button class="modal-close" aria-label="关闭" title="关闭" onclick="closeVoiceSettings()">×</button></div>' +
    '<div class="modal-body" style="padding:6px 16px 10px">' +
    '<div class="vs-list">' +
    '<label class="vs-item"><div class="vs-main"><span class="vs-t">自动朗读回复</span><span class="vs-h">回复完成后自动语音播放，点播放按钮可打断</span></div>' +
    '<input type="checkbox" id="vsAutoplay" '+(on?'checked':'')+'></label>' +
    '<label class="vs-item"><div class="vs-main"><span class="vs-t">语音对话模式</span><span class="vs-h">免手连续对话，关掉开关即结束</span></div>' +
    '<input type="checkbox" id="vsVoiceChat" '+(voiceChat?'checked':'')+'></label>' +
    '<label class="vs-item"><div class="vs-main"><span class="vs-t">说话打断朗读</span><span class="vs-h">AI 朗读时你开口即可打断（需麦克风权限）</span></div>' +
    '<input type="checkbox" id="vsBarge" '+(localStorage.getItem('fnos-voice-barge')!=='0'?'checked':'')+'></label>' +
    '<label class="vs-item"><div class="vs-main"><span class="vs-t">语音输入自动发送</span><span class="vs-h">只影响旧的语音对话模式；按住说话一律先落输入框或直接发语音</span></div>' +
    '<input type="checkbox" id="vsAutosend" '+(autosend?'checked':'')+'></label>' +
    '<label class="vs-item"><div class="vs-main"><span class="vs-t">安全网关</span><span class="vs-h" id="vsGuardDesc">拦截危险命令，加载中…</span></div>' +
    '<input type="checkbox" id="vsGuard"></label>' +
    '<div class="vs-item"><div class="vs-main"><span class="vs-t">朗读音色</span><span class="vs-h">保存后立即生效</span></div>' +
    '<select id="vsVoice" class="vs-select"><option value="">加载中…</option></select>' +
    '<button class="ov-actbtn vs-test" onclick="voiceTest()">试听</button></div>' +
    '</div></div>' +
    '<div class="modal-foot" style="padding:12px 16px;display:flex;justify-content:flex-end;gap:8px">' +
    '<button class="btn" onclick="closeVoiceSettings()">取消</button>' +
    '<button class="btn primary" onclick="saveVoiceSettings()">保存</button>' +
    '</div></div></div>';
  var div = document.createElement('div'); div.innerHTML = html; window.ui.adoptOverlay(document.body.appendChild(div.firstChild));
  fetch(apiUrl('/api/studio/security'), { headers: monitorToken?{'X-Monitor-Token':monitorToken}:{} })
    .then(function(r){ return r.json(); }).then(function(j){
      var cb = document.getElementById('vsGuard'); if(!cb) return;
      cb.checked = j.enabled !== false;
      var d = document.getElementById('vsGuardDesc'); if(d) d.textContent = '拦截危险命令 · 当前' + ((j.enabled===false)?'已关闭':'已开启') + '（' + ((j.blockRules||13)) + ' 条规则）';
    }).catch(function(){});
  // 拉取当前音色与可选列表
  fetch(apiUrl('/api/voice/config'), { headers: monitorToken?{'X-Monitor-Token':monitorToken}:{} })
    .then(function(r){ return r.json().catch(function(){ return {}; }); }).then(function(j){
      var sel = document.getElementById('vsVoice'); if(!sel) return;
      var cur = (j && j.voice) || '';
      var list = (j && j.voices && j.voices.length) ? j.voices : [{ id:'zh-CN-XiaoxiaoNeural', name:'晓晓（女·温暖）' }];
      var htmlOpts = '';
      var hasCur = false;
      list.forEach(function(v){ htmlOpts += '<option value="'+v.id+'"'+(v.id===cur?' selected':'')+'>'+esc(v.name)+'</option>'; if(v.id===cur) hasCur=true; });
      if(cur && !hasCur){ htmlOpts = '<option value="'+DOM.escAttr(cur)+'" selected>'+esc(cur)+'</option>' + htmlOpts; }
      sel.innerHTML = htmlOpts;
    }).catch(function(){});
}
function saveVoiceSettings(){
  localStorage.setItem('fnos-voice-autoplay', document.getElementById('vsAutoplay').checked?'1':'0');
  localStorage.setItem('fnos-voice-autosend', document.getElementById('vsAutosend').checked?'1':'0');
  localStorage.setItem('fnos-voice-chat', document.getElementById('vsVoiceChat').checked?'1':'0');
  localStorage.setItem('fnos-voice-barge', document.getElementById('vsBarge').checked?'1':'0');
  if(document.getElementById('vsVoiceChat').checked === false){ _voice.chatLoop = false; }
  var g = document.getElementById('vsGuard');
  if(g){ fetch(apiUrl('/api/studio/security'), { method:'PUT', headers:{'Content-Type':'application/json','X-Monitor-Token':monitorToken||''}, body: JSON.stringify({ enabled: g.checked }) }).catch(function(){}); }
  var vs = document.getElementById('vsVoice');
  if(vs && vs.value){ fetch(apiUrl('/api/voice/config'), { method:'POST', headers:{'Content-Type':'application/json','X-Monitor-Token':monitorToken||''}, body: JSON.stringify({ voice: vs.value }) }).catch(function(){}); }
  closeVoiceSettings();
  toast('语音设置已保存');
}
function closeVoiceSettings(){ var el = document.getElementById('voiceSetOverlay'); if(el) el.remove(); }
function voiceTest(){
  var vs = document.getElementById('vsVoice');
  var applyVoice = vs && vs.value ? fetch(apiUrl('/api/voice/config'), { method:'POST', headers:{'Content-Type':'application/json','X-Monitor-Token':monitorToken||''}, body: JSON.stringify({ voice: vs.value }) }).catch(function(){ return {}; })
    : Promise.resolve({ ok:true });
  applyVoice.then(function(){
    return fetch(voiceAudioUrl('/speak'), { method:'POST', headers:{'Content-Type':'application/json','X-Monitor-Token':monitorToken||''}, body: JSON.stringify({ text: '你好，我是你的 AI 小助手。这是一段语音测试。' }) });
  }).then(function(r){ if(!r.ok) throw new Error('speak '+r.status); return r.json(); })
    .then(function(j){ if(!j.ok || !j.data_url) throw new Error(j.error||'TTS failed'); new Audio(j.data_url).play().catch(function(){}); })
    .catch(function(err){ toast('试听失败：'+(err&&err.message?err.message:'')); });
}
/* ── 欢迎页（Octop 风 QUICK START 六宫格） ── */
var WELCOME_QUICK = [
  { id:'sum',   name:'总结文档',   ico:'📄', hint:'帮我总结这份文档：' },
  { id:'email', name:'写邮件',     ico:'✉️', hint:'帮我写一封得体的邮件：' },
  { id:'code',  name:'解释代码',   ico:'💻', hint:'帮我解释这段代码：' },
  { id:'plan',  name:'制定计划',   ico:'📋', hint:'帮我制定一个计划：' },
  { id:'trans', name:'翻译润色',   ico:'🌐', hint:'帮我翻译并润色这段文字：' },
  { id:'brain', name:'头脑风暴',   ico:'💡', hint:'来一次头脑风暴，主题是：' }
];
function welcomeHTML(){
  var cards = WELCOME_QUICK.map(function(c){
    return '<button type="button" class="wq-card" onclick="quickSend(\''+_jsStr(c.hint)+'\')"><span class="wq-ico" aria-hidden="true">'+c.ico+'</span><span class="wq-name">'+esc(c.name)+'</span><span class="wq-hint">'+esc(c.hint)+'</span></button>';
  }).join('');
  return '<div class="welcome-wrap"><div class="welcome-hero"><div class="welcome-kicker">开始一段对话</div><h1 class="welcome-title">今天想完成什么？</h1><p class="welcome-sub">直接描述目标，或从下面选一个起点。</p></div><div class="wq-grid">'+cards+'</div><p class="welcome-footnote">选择后可继续补充内容，再发送。</p></div>';
}
/* 起步模板先填入草稿，与专家示例提问保持相同行为。 */
function quickSend(text){
  var ta = document.getElementById('chatInput');
  if(ta){ ta.value = ta.value.trim()?ta.value+'\n\n'+String(text||''):String(text||''); autoResize(ta); saveDraft(currentSession); ta.focus(); }
}

function quoteMsg(btn){
  var msgEl = btn.closest('.msg');
  var text = msgEl ? (msgEl.getAttribute('data-content') || msgEl.querySelector('.md-text').textContent) : '';
  if(!text){ toast('无可引用内容','error'); return; }
  var tmp = document.createElement('textarea'); tmp.innerHTML = text; text = tmp.value;
  _currentQuote = text.length > 500 ? text.slice(0, 500) + '…' : text;
  var preview = document.getElementById('quotePreview');
  var previewText = document.getElementById('quotePreviewText');
  if(preview && previewText){
    previewText.textContent = '引用: ' + (_currentQuote.length > 80 ? _currentQuote.slice(0, 80) + '…' : _currentQuote);
    preview.classList.add('show');
  }
  var input = document.getElementById('chatInput');
  if(input) input.focus();
  /* 引用不再弹提示（2026-11-13 用户第 41 条）：引用条已经在输入框上方显示了，
     再弹一条 toast 等于同一件事说两遍，还得人干等它消失。 */
}
function clearQuote(){
  _currentQuote = null;
  var preview = document.getElementById('quotePreview');
  if(preview) preview.classList.remove('show');
}

function forkMsg(btn){
  var msgEl = btn.closest('.msg');
  var text = msgEl ? (msgEl.getAttribute('data-content') || msgEl.querySelector('.md-text').textContent) : '';
  if(!text){ toast('无可 Fork 内容','error'); return; }
  var tmp = document.createElement('textarea'); tmp.innerHTML = text; text = tmp.value;
  var forkContent = text.length > 800 ? text.slice(0, 800) + '…' : text;
  // 创建新会话并注入 fork 上下文
  fetch(apiUrl('/api/sessions'), { method:'POST', headers:monitorToken?{'X-Monitor-Token':monitorToken}:{} })
    .then(function(r){ return r.json(); })
    .then(function(s){
      _sessions.unshift(s);
      currentSession = s.id;
      _applyPendingModel(s.id);
      _openTabs.push(s.id); persistTabs();
      renderSessionTabs(); renderRail(); updateHeader();
      var body = document.getElementById('chatBody');
      if(body){
        body.innerHTML = '<div class="system-tip">🍴 Fork 新话题（基于上一条回复）</div>' +
          '<div class="msg assistant"><div class="msg-bubble"><div class="quote-block"><div class="quote-label">FORK 来源</div>' + escapeHtml(forkContent) + '</div></div><div class="msg-meta">Fork 上下文 · ' + fmtDateTime(Date.now()) + '</div></div>';
      }
      // 设置标题
      var titleEl = document.getElementById('chatTitle');
      if(titleEl) titleEl.textContent = 'branch: ' + (forkContent.slice(0, 20) || '新话题');
      toast('🍴 已 Fork 为新话题，请继续提问');
      var input = document.getElementById('chatInput');
      if(input) input.focus();
    }).catch(function(){ toast('Fork 失败','error'); });
}