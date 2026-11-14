/* Markdown 渲染 + 顶部按钮入口
 * 来源：index.html 内联 app.js 第 226-578 行（共 353 行）
 * 2026-11-13 按原分区纯搬运外移，逻辑零改动。全局作用域与执行顺序与原内联块一致。 */

/* ============================ Markdown 渲染 ============================ */
if(window.marked && window.marked.use){
  try {
    window.marked.use({
      renderer:{
        link: function(href, title, text){
          if(typeof href === 'object' && href !== null){ var tok=href; href=tok.href; title=tok.title; text=tok.text; }
          var safeHref = (href||'').replace(/"/g,'&quot;');
          var titleAttr = title ? ' title="'+String(title).replace(/"/g,'&quot;')+'"' : '';
          return '<a href="'+safeHref+'" target="_blank" rel="noopener noreferrer"'+titleAttr+'>'+text+'</a>';
        }
      }
    });
  } catch(e){}
}
if(window.DOMPurify){
  try {
    window.DOMPurify.addHook('afterSanitizeAttributes', function(node){
      if(node.tagName === 'A'){ node.setAttribute('target','_blank'); node.setAttribute('rel','noopener noreferrer'); }
    });
  } catch(e){}
}
function balanceMarkdown(text){
  var out = text;
  var fence = out.match(/```/g);
  if(fence && fence.length % 2 === 1) out += '\n```';
  var without = out.replace(/```[\s\S]*?```/g, '');
  var tick = (without.match(/`/g)||[]).length;
  if(tick % 2 === 1) out += '`';
  if((out.match(/\*\*/g)||[]).length % 2 === 1) out += '**';
  return out;
}
function preprocessMarkdown(text){
  if(!text) return text;
  // 网关/模型有时会返回「一行式 Markdown」：大段文字没有换行，列表也 inline。
  // 这里做保守预处理：在中文句末标点后插入段落换行，并把 "label：- item" 切为列表。
  // 1) 中文句末标点后接空格+中文，视为新段落开头
  text = text.replace(/([。！？；])\s+(?=[\u4e00-\u9fa5])/g, '$1\n');
  // 2) 冒号/全角冒号后立即跟 -，视为列表开始
  text = text.replace(/([:：])\s*-\s+/g, '$1\n- ');
  // 3) 对已开始的列表行，继续把后续 inline " - item" 拆成独立列表项
  text = text.split('\n').map(function(line){
    if(line.indexOf(' - ') === -1) return line;
    if(!/^\s*-\s/.test(line)) return line;
    var parts = line.split(' - ');
    if(parts.length < 3) return line;
    return parts.slice(0,2).join(' - ') + '\n- ' + parts.slice(2).join('\n- ');
  }).join('\n');
  // 4) 单波浪号转义（2026-11-11 修）：marked v13 的删除线规则接受**单个** `~`，
  //    于是温度区间「−1.6~12.5」「−0.8~11.6」成对命中，中间整段正文被包进 <del>，
  //    表现就是长回复里随机出现删除线（通辽天气那条 16 个 ~ 凑成 8 对）。
  //    做法：先保护代码块/行内代码/成对的 ~~真删除~~，再把剩余孤立 ~ 转义成 \~，
  //    渲染结果仍是字面 ~，而 ~~删除~~ 照旧可用。
  text = (function(src){
    var stash = [], idx = 0;
    function put(s){ var k = '\u0000TB' + (idx++) + '\u0000'; stash.push(s); return k; }
    src = src.replace(/```[\s\S]*?```/g, put);      // 围栏代码块
    src = src.replace(/`[^`\n]+`/g, put);           // 行内代码
    src = src.replace(/~~[^\n]+?~~/g, put);         // 成对删除线，原样保留
    src = src.replace(/~/g, '\\~');                 // 剩余孤立 ~
    for(var i = stash.length - 1; i >= 0; i--){
      src = src.split('\u0000TB' + i + '\u0000').join(stash[i]);
    }
    return src;
  })(text);
  return text;
}
function linkifyBareUrls(text){
  var placeholders = [], phIdx = 0;
  function protect(re){ return function(m){ var ph='\x00PH'+(phIdx++)+'\x00'; placeholders.push({ph:ph,val:m}); return ph; }; }
  var out = text.replace(/```[\s\S]*?```/g, protect());
  out = out.replace(/`[^`\n]+`/g, protect());
  var urlRe = /(?<!\]\()(?<!href=["'])(https?:\/\/[^\s<>"'`\x00-\x1f]+?)(?=[)）\]}。、，；！？\s]|$)/g;
  out = out.replace(urlRe, function(raw){
    var url=raw, trail='';
    var m=raw.match(/^(.+?)([)）\]}。、，；！？]+)$/);
    if(m){ url=m[1]; trail=m[2]; }
    url=url.replace(/[.,;:!\])}>]+$/,'');
    return '['+url+']('+url+')'+trail;
  });
  for(var i=placeholders.length-1;i>=0;i--){ out = out.split(placeholders[i].ph).join(placeholders[i].val); }
  return out;
}
var AUDIO_EXT_RE = /\.(mp3|wav|m4a|ogg|oga|opus|aac|webm|flac|amr)(\?|#|$)/i;
/* ── 语音卡片：波形 + 播放键 + 时间（2026-11-12）─────────────────────────
   原生 <audio controls> 在手机上会顶出气泡，也没法告诉人「哪一段在说话」。
   这里自己画：解码出峰值 → 40 根竖条，高的地方就是有声音的地方；
   点/拖波形可以跳转，播过的条变色。解不了码（Safari 不认 webm 之类）就退回原生控件。 */
var VP_BARS = 40;
var _VP_PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
var _VP_PAUSE = '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';
function _fmtD(d){
  d = Math.max(0, d||0);
  if(d < 0.05) return '0s';
  if(d < 10) return d.toFixed(1)+'s';
  if(d < 60) return Math.round(d)+'s';
  var s = Math.round(d); return Math.floor(s/60)+':'+('0'+(s%60)).slice(-2);
}
function _fmtT(s){ return _fmtD(s); }
function voicePlayerHTML(src, label){
  src = _audioSrc(src||''); if(!src) return '';
  /* 2026-11-12：不再显示文件名/语音标题那一行。
     实测那条卡片上一行「🎙 tts_20261112_…mp3」既占高又没信息量，
     波形和时间已经把该说的说完了。label 参数保留只为不改所有调用点。 */
  return '<div class="voice-player">'+
    '<div class="vp" data-src="'+DOM.escAttr(src)+'">'+
      '<button class="vp-play" type="button" aria-label="播放语音">'+_VP_PLAY+'</button>'+
      '<div class="vp-body">'+
        '<div class="vp-wave" role="slider" tabindex="0" aria-label="语音进度"></div>'+
        '<div class="vp-meta"><span class="vp-cur">0:00</span><span class="vp-dur">--:--</span></div>'+
      '</div>'+
      '<audio class="vp-audio" preload="metadata" src="'+DOM.escAttr(src)+'"></audio>'+
    '</div></div>';
}
var _vpCtx = null, _vpPk = {};
function _vpPeaksFor(src){
  if(_vpPk[src]) return Promise.resolve(_vpPk[src]);
  return fetch(src, {credentials:'same-origin'}).then(function(r){
    if(!r.ok) throw new Error('http '+r.status);
    var ct = r.headers.get('content-type') || 'audio/webm';
    return r.arrayBuffer().then(function(b){ return {buf:b, ct:ct}; });
  }).then(function(_p){
    var buf = _p.buf;
    try{ _vpPk[src+'\u0000url'] = URL.createObjectURL(new Blob([buf], {type:_p.ct})); }catch(e){}
    return buf;
  }).then(function(buf){
    _vpCtx = _vpCtx || new (window.AudioContext||window.webkitAudioContext)();
    return new Promise(function(res, rej){ try{ _vpCtx.decodeAudioData(buf, res, rej); }catch(e){ rej(e); } });
  }).then(function(ab){
    var ch = ab.getChannelData(0), n = VP_BARS, step = Math.floor(ch.length/n) || 1, out = [];
    for(var i=0;i<n;i++){
      var s = i*step, e = Math.min(ch.length, s+step), peak = 0;
      var hop = Math.max(1, Math.floor((e-s)/200));
      for(var j=s;j<e;j+=hop){ var v = Math.abs(ch[j]); if(v>peak) peak = v; }
      out.push(peak);
    }
    var mx = Math.max.apply(null, out) || 1;
    out = out.map(function(v){ return Math.max(0.14, Math.min(1, v/mx)); });
    _vpPk[src] = {peaks:out, dur:ab.duration};
    return _vpPk[src];
  });
}
function _vpMount(vp){
  if(vp.__m || vp.__fb) return; vp.__m = 1;
  var audio = vp.querySelector('.vp-audio'), wave = vp.querySelector('.vp-wave'),
      btn = vp.querySelector('.vp-play'), cur = vp.querySelector('.vp-cur'), dur = vp.querySelector('.vp-dur');
  var barsHTML = '';
  for(var i=0;i<VP_BARS;i++) barsHTML += '<i></i>';
  wave.innerHTML = barsHTML;
  var bars = wave.children;

  var _srcKey = vp.dataset.src||'';
  _vpPeaksFor(_srcKey).then(function(info){
    if(vp.__fb) return;
    for(var i=0;i<bars.length;i++) bars[i].style.height = (3 + Math.round(info.peaks[i]*15)) + 'px';
    vp.__dur = info.dur;
    if(isFinite(info.dur) && info.dur > 0) dur.textContent = _fmtT(info.dur);
    /* 服务端 /uploads 回的是整段流、没有 Range，直接拿它当 src 拖不动。
       文件中已经整份下载过了，换成本地 blob URL，跳转就不用再问服务器要字节。 */
    var blobUrl = _vpPk[_srcKey+'\u0000url'];
    if(blobUrl && audio.getAttribute('src') !== blobUrl){
      var at = audio.currentTime || 0, wasPlaying = !audio.paused;
      audio.setAttribute('src', blobUrl);
      audio.addEventListener('loadedmetadata', function once(){
        audio.removeEventListener('loadedmetadata', once);
        try{ if(at > 0) audio.currentTime = Math.min(at, (audio.duration||at) - 0.05); }catch(e){}
        if(wasPlaying){ var p = audio.play(); if(p && p.catch) p.catch(function(){}); }
        paint();
      });
    }
  }).catch(function(){
    /* 解码失败（Safari 解 webm 之类）：画一排等高的条，至少还是一条能按的进度轨道 */
    var bars2 = wave.children;
    for(var k=0;k<bars2.length;k++) bars2[k].style.height = '8px';
  });

  var durOf = function(){
    if(isFinite(audio.duration) && audio.duration > 0) return audio.duration;
    return vp.__dur || 0;
  };
  /* ratioOverride 有值时按「手指位置」画，不读 audio.currentTime。
     以前 seek() 里直接读 currentTime，浏览器要等 seeks 落地才更新，
     于是手指在动、点亮位置不动（用户 2026-11-12：拖了能跳到那儿播，
     但滚动条不往前走）。 */
  var paint = function(ratioOverride){
    var d = durOf();
    var r = (ratioOverride != null) ? ratioOverride : (d ? Math.min(1, audio.currentTime/d) : 0);
    r = Math.min(1, Math.max(0, r));
    var n = Math.round(r*bars.length);
    for(var i=0;i<bars.length;i++){
      if(i < n) bars[i].classList.add('on'); else bars[i].classList.remove('on');
    }
    cur.textContent = _fmtT((ratioOverride != null) ? r*(d||0) : audio.currentTime);
    if(d) dur.textContent = _fmtT(d);
    wave.setAttribute('aria-valuenow', Math.round(r*100));
  };
  /* timeupdate 只有 4Hz，跟着它画会一顿一顿；播放期间用 rAF 逐帧重画 */
  var rafId = 0;
  var tick = function(){
    rafId = 0;
    if(audio.paused || dragRatio != null || vp.__fb) return;
    paint();
    rafId = requestAnimationFrame(tick);
  };
  var startTick = function(){ if(!rafId && !dragRatio) rafId = requestAnimationFrame(tick); };
  var dragRatio = null, dragging = false;
  btn.addEventListener('click', function(ev){
    ev.stopPropagation(); ev.preventDefault();
    if(audio.paused){ var p = audio.play(); if(p && p.catch) p.catch(function(){}); }
    else audio.pause();
  });
  audio.addEventListener('play', function(){
    btn.innerHTML = _VP_PAUSE; paint(); startTick();
    /* 一条一条放，别叠成合唱 */
    _vpAll().forEach(function(other){
      if(other === vp) return;
      var a = other.querySelector('audio');
      if(a && !a.paused){ try{ a.pause(); }catch(e){} }
    });
  });
  audio.addEventListener('pause', function(){ btn.innerHTML = _VP_PLAY; if(rafId){ cancelAnimationFrame(rafId); rafId = 0; } paint(); });
  audio.addEventListener('ended', function(){ btn.innerHTML = _VP_PLAY; try{ audio.currentTime = 0; }catch(e){} paint(); });
  audio.addEventListener('timeupdate', function(){ if(audio.paused) paint(); });
  audio.addEventListener('seeking', function(){ if(dragRatio == null) paint(); });
  audio.addEventListener('seeked', function(){ if(dragRatio == null) paint(); });
  audio.addEventListener('loadedmetadata', function(){
    if(isFinite(audio.duration) && audio.duration > 0){ vp.__dur = audio.duration; dur.textContent = _fmtT(audio.duration); }
    paint();
  });
  var seek = function(x){
    var rr = wave.getBoundingClientRect(); if(!rr.width) return;
    var d = durOf();
    var ratio = Math.min(1, Math.max(0, (x - rr.left)/rr.width));
    dragRatio = ratio; paint(ratio);
    if(d){ try{ audio.currentTime = ratio*d; }catch(e){} }
  };
  wave.addEventListener('pointerdown', function(ev){
    dragging = true; dragRatio = 0; try{ wave.setPointerCapture(ev.pointerId); }catch(e){}
    seek(ev.clientX); ev.preventDefault(); ev.stopPropagation();
  });
  wave.addEventListener('pointermove', function(ev){ if(dragging){ seek(ev.clientX); ev.preventDefault(); } });
  var endDrag = function(){
    if(!dragging) return;
    dragging = false; dragRatio = null; paint();
    if(!audio.paused) startTick();
  };
  wave.addEventListener('pointerup', endDrag);
  wave.addEventListener('pointercancel', endDrag);
  wave.addEventListener('lostpointercapture', endDrag);
  wave.addEventListener('keydown', function(ev){
    var d = durOf(); if(!d) return;
    var step = ev.key === 'ArrowRight' ? 0.05 : (ev.key === 'ArrowLeft' ? -0.05 : 0);
    if(step){ ev.preventDefault(); try{ audio.currentTime = Math.min(d, Math.max(0, audio.currentTime + step*d)); }catch(e){} paint(); }
  });
  wave.addEventListener('click', function(ev){ ev.stopPropagation(); ev.preventDefault(); });
}
function _vpAll(){ return [].slice.call(document.querySelectorAll('.vp')); }
function initVoicePlayers(root){
  var list = (root || document).querySelectorAll('.vp');
  for(var i=0;i<list.length;i++) _vpMount(list[i]);
}
var _vpInitTimer = null;
function _vpScheduleInit(){
  if(_vpInitTimer) return;
  _vpInitTimer = setTimeout(function(){ _vpInitTimer = null; initVoicePlayers(document); }, 60);
}
document.addEventListener('DOMContentLoaded', _vpScheduleInit);
try{
  new MutationObserver(_vpScheduleInit).observe(document.documentElement, {childList:true, subtree:true});
}catch(e){}
/* 助手侧的语音没法走「附件」那条路：TTS 出来的东西历史上是以链接 / MEDIA: 行给出来的，
   在卡片里就是一行看不懂的地址。这里把音频链接就地换成播放器，标签当标题保留。 */
function inlineAudioPlayers(html){
  if(!html) return html;
  html = html.replace(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, function(m, href, label){
    var u = href.replace(/&amp;/g,'&');
    if(!AUDIO_EXT_RE.test(u)) return m;
    var src = _audioSrc(u); if(!src) return m;
    var txt = label.replace(/<[^>]+>/g,'').trim();
    return voicePlayerHTML(src, txt);
  });
  html = html.replace(/MEDIA:\s*([^\s<"']+\.(?:mp3|wav|m4a|ogg|oga|opus|aac|webm|flac|amr))/gi, function(m,u){
    var src = _audioSrc(u); if(!src) return m;
    return voicePlayerHTML(src, '');
  });
  return html;
}
function renderMarkdown(text, streaming){
  if(!window.marked) return escapeHtml(text||'');
  var src = streaming ? balanceMarkdown(text||'') : (text||'');
  src = src.replace(/\r/g,'');
  src = preprocessMarkdown(src);
  src = preprocessSources(src);
  src = linkifyBareUrls(src);
  var html;
  try {
    // marked v13+ 默认返回 Promise，强制同步解析
    if(window.marked.parseSync){
      html = window.marked.parseSync(src, { breaks:true, gfm:true });
    } else {
      html = window.marked.parse(src, { breaks:true, gfm:true, async:false });
    }
  }
  catch(e){ html = escapeHtml(src); }
  html = window.DOMPurify ? window.DOMPurify.sanitize(html, { ADD_ATTR:['target'] }) : html;
  html = inlineAudioPlayers(html);
  html = html.replace(/<a[^>]*href="mailto:[^"]*"[^>]*>(.*?)<\/a>/gi, '$1');
  if(BASE){
    html = html.replace(/(<img[^>]+src=")(\/(?:tmp|uploads|workspace|data)\/[^"]+)(")/gi, function(m,p,path,q){ return p+BASE+path+q; });
  }
  html = html.replace(/<table>/g,'<div class="table-wrap"><table>').replace(/<\/table>/g,'</table></div>');
  html = renderCitations(html, src);
  return html;
}
/* ── Grounded Citations 渲染（对齐官方 grounded-citations skill）──
 * Sources 块 → 来源卡片（可点击）；正文 [n] / [1,2] 纯数字引用 → 引用角标 */
function preprocessSources(src){
  if(!src || src.indexOf('Sources')<0) return src;
  try{
    // 匹配 "## Sources" / "Sources:" 后的行块（每行一条 URL 或 "[n] URL 标题"）
    src = src.replace(/(^|\n)[ \t]*#{0,3}[ \t]*Sources[ \t]*:?[ \t]*\n((?:[ \t]*[^\n]*\n?)+)/i, function(m, pre, block){
      var lines = block.split('\n').map(function(l){ return l.replace(/^[ \t]*[-*]?[ \t]*/, '').trim(); })
        .filter(function(l){ return l && l.indexOf('http')===0; });
      if(!lines.length) return m;
      var cards = lines.map(function(u){
        var url = (u.match(/https?:\/\/[^\s<>"']+/)||[''])[0];
        var title = u.replace(url,'').replace(/^[ \t]*[\[\]\d.,\s-]+/,'').trim() || url;
        return '<div class="cite-item"><span class="cite-num">↗</span><a href="'+DOM.escAttr(url)+'" target="_blank" rel="noopener" title="'+DOM.escAttr(url)+'">'+esc(title)+'</a></div>';
      }).join('');
      return pre + '\n<div class="citations-block"><div class="citations-title">📚 来源</div>' + cards + '</div>\n';
    });
  }catch(e){}
  return src;
}
function renderCitations(html, src){
  if(!html) return html;
  try{
    // [n] / [1,2] 纯数字引用 → 角标（排除 markdown 链接 [n](url) 形式）
    html = html.replace(/\[(\d+(?:\s*[,，]\s*\d+)*)\](?!\()/g, '<sup class="cite-ref">[$1]</sup>');
  }catch(e){}
  return html;
}
/* 旧版 mdToHtml 保留为简单兜底（非流式渲染时使用） */
function mdToHtml(s){
  return renderMarkdown(s, false);
}

/* ============================ 顶部按钮 ============================ */
function openNewWindow(){ window.open(window.location.href, '_blank'); }
function openGitHub(){ window.open('https://github.com/vector9584/fnos-hermes-panel','_blank'); }
/* 全局搜索入口：侧栏那条搜索框删掉后，改由聊天区右上角放大镜调起同一个搜索面板 */
function openGlobalSearch(){ if(window.pwSearch) window.pwSearch(''); }