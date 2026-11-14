/* 终端管理（PTY 二进制帧 + ANSI 流式渲染）
 * 来源：index.html 内联 app.js 第 2197-2384 行（共 188 行）
 * 2026-11-13 按原分区纯搬运外移，逻辑零改动。全局作用域与执行顺序与原内联块一致。 */
/* ============================ 终端管理（PTY：二进制帧 + ANSI 流式渲染） ============================ */
var _termWs = null;
var _termDecoder = new TextDecoder('utf-8');
var _termRuns = [];           // [{t:文本, b:粗体, f:前景, bg:背景}] 已渲染片段
var _termStyle = { b:0, f:'', bg:'' }; // 当前 SGR 状态（跨 chunk 保持）
var _termEsc = '';            // 未完成的转义序列
var _termCols = 0, _termRows = 0;
var _termHist = []; var _termHistIdx = -1;
var _ANSI_COLORS={0:'#000',1:'#cd0000',2:'#00cd00',3:'#cdcd00',4:'#0000ee',5:'#cd00cd',6:'#00cdcd',7:'#e5e5e5',8:'#7f7f7f',9:'#ff0000',10:'#00ff00',11:'#ffff00',12:'#5c5cff',13:'#ff00ff',14:'#00ffff',15:'#ffffff'};
function ansi256Color(n){
  n=parseInt(n,10)||0;
  if(n<16) return _ANSI_COLORS[n]||'#fff';
  if(n<232){
    n-=16;
    var r=Math.floor(n/36),g=Math.floor((n%36)/6),b=n%6;
    function cv(v){ v=Math.round(v*255/5); var h=v.toString(16); return h.length<2?'0'+h:h; }
    return '#'+cv(r)+cv(g)+cv(b);
  }
  var v=8+(n-232)*10; var h=v.toString(16); if(h.length<2)h='0'+h;
  return '#'+h+h+h;
}
function applySGR(st, params){
  if(!params || !params.length) params=['0'];
  var i=0;
  while(i<params.length){
    var p=params[i];
    if(!p){ i++; continue; }
    var num=parseInt(p,10);
    if(isNaN(num)){ i++; continue; }
    if(num===0){ st.b=0; st.f=''; st.bg=''; }
    else if(num===1){ st.b=1; }
    else if(num===2){ st.b=0; }
    else if(num===22){ st.b=0; }
    else if(num>=30&&num<=37){ st.f=_ANSI_COLORS[num-30]; }
    else if(num===39){ st.f=''; }
    else if(num>=90&&num<=97){ st.f=_ANSI_COLORS[num-90]; }
    else if(num>=40&&num<=47){ st.bg=_ANSI_COLORS[num-40]; }
    else if(num===49){ st.bg=''; }
    else if(num>=100&&num<=107){ st.bg=_ANSI_COLORS[num-100]; }
    else if(num===38||num===48){
      var mode=params[i+1], key=num===38?'f':'bg';
      if(mode==='5'){ st[key]=ansi256Color(params[i+2]); i+=3; }
      else if(mode==='2'){ st[key]='rgb('+params[i+2]+','+params[i+3]+','+params[i+4]+')'; i+=5; }
      else { i++; }
    }
    i++;
  }
}
function termAppend(raw){
  var el=document.getElementById('termOutput');
  if(!el) return;
  var s=_termEsc+String(raw||''); _termEsc='';
  var buf=''; var i=0, L=s.length;
  function commit(){
    if(!buf) return;
    _termRuns.push({ t:buf, b:_termStyle.b, f:_termStyle.f, bg:_termStyle.bg });
    if(_termRuns.length>20000) _termRuns.splice(0,_termRuns.length-20000); // 防内存膨胀
    buf='';
  }
  while(i<L){
    var c=s.charAt(i);
    if(c==='\x1b'){
      if(i+1>=L){ _termEsc=s.slice(i); break; }
      var nxt=s.charAt(i+1);
      if(nxt==='['){
        var mm=s.slice(i+2).match(/^([0-9;?]*)([@-~])/);
        if(mm){
          if(mm[2]==='m'){ commit(); applySGR(_termStyle, mm[1]?mm[1].split(';'):[]); }
          else if(mm[2]==='J'){ commit(); _termRuns.length=0; el.innerHTML=''; } // 清屏
          else if(mm[2]==='K'){ commit(); } // 清行：忽略（轻量终端）
          i+=2+mm[0].length;
          continue;
        }
        _termEsc=s.slice(i); break; // 不完整 CSI，等下个 chunk
      }
      if(nxt===']'){
        var oe=s.indexOf('\x07', i+2);
        if(oe<0){ _termEsc=s.slice(i); break; } // OSC 未结束
        i=oe+1; continue;
      }
      if(nxt==='('||nxt===')'||nxt==='>'||nxt==='='){
        if(i+2>=L){ _termEsc=s.slice(i); break; }
        i+=3; continue;
      }
      if(s.length-i<2){ _termEsc=s.slice(i); break; }
      i+=2; continue;
    }
    if(c==='\r'||c==='\n'){
      if(c==='\r' && s.charAt(i+1)==='\n') i++;
      buf+='\n'; i++; continue;
    }
    var j=i;
    while(j<L){ var ch=s.charAt(j); if(ch==='\x1b'||ch==='\r'||ch==='\n') break; j++; }
    buf+=s.slice(i,j); i=j;
  }
  commit();
  // 增量渲染：只补新片段
  var html='';
  var last=_termRuns.length;
  if(_termAppendMark===undefined || _termAppendMark>last){ _termAppendMark=0; el.innerHTML=''; }
  for(var k=_termAppendMark;k<last;k++){
    var r=_termRuns[k];
    var css='';
    if(r.b) css+='font-weight:bold;';
    if(r.f) css+='color:'+r.f+';';
    if(r.bg) css+='background-color:'+r.bg+';';
    html+=(css?'<span style="'+css+'">':'')+esc(r.t)+(css?'</span>':'');
  }
  _termAppendMark=last;
  if(html) el.insertAdjacentHTML('beforeend', html);
  // 未上滚时跟随底部
  if(el.scrollTop+el.clientHeight>=el.scrollHeight-60) el.scrollTop=el.scrollHeight;
}
var _termAppendMark=0;
function termConnect(){
  if(_termWs && _termWs.readyState<=1) return;
  var proto = location.protocol==='https:'?'wss:':'ws:';
  var url = proto+'//'+location.host+(window._basePath||'')+'/api/terminal/ws?token='+(monitorToken||'')+'&cwd='+encodeURIComponent(_fmCwd||'');
  document.getElementById('termStatus').textContent='连接中…';
  _termWs = new WebSocket(url);
  _termWs.binaryType='arraybuffer';
  _termWs.onopen=function(){
    document.getElementById('termStatus').textContent='✅ 已连接';
    termResize(true);
  };
  _termWs.onmessage=function(e){
    if(typeof e.data==='string'){
      try{
        var data=JSON.parse(e.data);
        if(data.type==='output'){ termAppend(data.data); }
        else if(data.type==='exit'){ document.getElementById('termStatus').textContent='已退出 (code:'+data.code+')'; _termWs=null; }
      }catch(err){ termAppend(e.data); }
      return;
    }
    // PTY 原始二进制帧：流式 UTF-8 解码（跨 chunk 多字节字符不丢）
    termAppend(_termDecoder.decode(new Uint8Array(e.data), {stream:true}));
  };
  _termWs.onclose=function(){ document.getElementById('termStatus').textContent='已断开'; _termWs=null; };
  _termWs.onerror=function(){ document.getElementById('termStatus').textContent='连接失败'; };
}
function termDisconnect(){
  if(_termWs){ _termWs.close(); _termWs=null; }
  document.getElementById('termStatus').textContent='未连接';
}
function termResize(force){
  var el=document.getElementById('termOutput');
  if(!el) return;
  var cols=Math.max(20, Math.floor(el.clientWidth/7.5));
  var rows=Math.max(5, Math.floor(el.clientHeight/16));
  if(!force && cols===_termCols && rows===_termRows) return;
  _termCols=cols; _termRows=rows;
  if(_termWs && _termWs.readyState===1) _termWs.send(JSON.stringify({type:'resize', cols:cols, rows:rows}));
}
window.addEventListener('resize', function(){ termResize(false); });
function termClear(){
  _termRuns.length=0; _termAppendMark=0; _termStyle={b:0,f:'',bg:''};
  var el=document.getElementById('termOutput'); if(el) el.innerHTML='';
}
function termKeydown(e){
  var input=document.getElementById('termInput');
  if(e.key==='Enter' && !e.isComposing && e.keyCode!==229){ termSend(); e.preventDefault(); return; }
  if(e.key==='ArrowUp'){
    e.preventDefault();
    if(!_termHist.length) return;
    if(_termHistIdx<0) _termHistIdx=_termHist.length-1;
    else if(_termHistIdx>0) _termHistIdx--;
    input.value=_termHist[_termHistIdx];
    return;
  }
  if(e.key==='ArrowDown'){
    e.preventDefault();
    if(_termHistIdx>=0){
      _termHistIdx++;
      if(_termHistIdx>=_termHist.length){ _termHistIdx=-1; input.value=''; }
      else input.value=_termHist[_termHistIdx];
    }
    return;
  }
}
function termSend(){
  var input=document.getElementById('termInput');
  var cmd=input.value;
  input.value='';
  if(!_termWs||_termWs.readyState!==1){ toast('终端未连接','error'); return; }
  _termWs.send(JSON.stringify({type:'input',data:cmd+'\n'}));
  // PTY 下 bash 自行回显，无需本地回显（否则会重复显示）
  if(cmd.trim()){ _termHist.push(cmd); if(_termHist.length>100) _termHist.shift(); _termHistIdx=-1; }
}