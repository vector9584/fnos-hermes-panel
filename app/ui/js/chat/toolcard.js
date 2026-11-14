/* 工具卡 / 工具集合：全站唯一实现（2026-11-13 第 39 条整体重写）
   ────────────────────────────────────────────────────────────────
   之前的问题（用户实测）：
     · 三角小得看不清，头部还挤着别的字；
     · 「展开要点两下才能关闭」——外层 div 上挂 onclick、文档级又挂一个 capture 监听、
       durable 侧再存一份 open Set，三处各写一份状态，一次点击被两次翻转抵掉；
     · 历史（tabs.js）和流式（compose.js）两套 markup、两套折叠逻辑，改一边另一边就歪。

   本次做法：改用浏览器原生的 <details>/<summary>。
     · 一次点击 = 浏览器自己 toggle，不存在双写、不存在「点两下才关」；
     · 键盘可聚焦/回车展开，无需额外 JS；
     · 我们不写 open 属性，只在「重绘」时按用户意愿恢复一次（paint）；
     · 用户手动开合由 capture 阶段的 toggle 事件记录到 st 里，重绘后照样保持。

   入口：
     ToolCard.cardHTML(tp, hist, turn)      → 单张卡（turn=这一轮怎么结束的，用于染色）
     ToolCard.groupHTML(tools, hist, boxId, turn) → 「已调用 N 个工具」+ 卡列表
     ToolCard.upsert(cardEl, tp)      → 流式增量更新一张卡（原地改，不重建）
     ToolCard.paint(root)             → 把意愿/默认值写回 open
     ToolCard.bind()                  → 文档级 toggle 记录（自动装一次）
*/
window.ToolCard = (function(){
  var CHEV = '<svg class="tc-chev" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  var st = { box:{}, card:{} };   // 用户意愿：data-box / data-tk → true=展开
  var bound = false;

  /* 默认全关（2026-11-13 第 43 条）：用户原话「怎么打开是默认全部展开的？默认全部关闭」。
     设置里的 expanded 不再决定「一开始就展开」，只决定「执行中的那张卡自动跟开」，
     否则那一项就成了一个点了没反应的死开关。 */
  function autoOpen(){ return !!(window.panelToolsMode && panelToolsMode()==='expanded'); }

  function e(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function keyCard(el){ return el.getAttribute('data-tk') || el.getAttribute('data-tid') || ''; }

  function bind(){
    if(bound) return; bound = true;
    /* toggle 不冒泡，只能在捕获阶段听；这一处是全站唯一的「记住用户开合」的写入点 */
    document.addEventListener('toggle', function(ev){
      var el = ev.target;
      if(!el || el.tagName!=='DETAILS') return;
      if(el.classList.contains('tool-call')){ var k=keyCard(el); if(k) st.card[k]=el.open; }
      else if(el.classList.contains('tool-calls')){ var b=el.getAttribute('data-box'); if(b) st.box[b]=el.open; }
    }, true);
  }

  function statusOf(tp, hist, turn, isLast){
    var stt = tp.status || ((tp.result || hist) ? 'done' : 'running');
    /* 第 49 条（2026-11-13）：这一轮是被停止/中断收场的 —— 最后那张卡就是「正跑到一半被打断」
       的那张，标橙。服务端若明确写了状态（tp.status）就以服务端为准，不猜。
       为什么只认最后一张：前面几张是真跑完了，染橙等于把它们也说成没跑完。 */
    /* 服务端对每张卡都写 status='done'（它只知道「这一步返回了」），所以不能靠 tp.status 区分
       「跑完的」和「被打断的」。判据换成位置：这一轮既然是被停/中断收场，最后那张就是断点。 */
    if(isLast && stt!=='running' && /停止|中断|取消/.test(String(turn||''))) stt='interrupted';
    var interrupted = stt==='interrupted'||stt==='cancelled'||stt==='canceled';
    var failed = stt==='error'||stt==='failed';
    var running = !(stt==='done'||stt==='completed'||stt==='finish'||stt==='finished') && !interrupted && !failed;
    return { running:running, interrupted:interrupted, failed:failed, status:stt };
  }

  function headHTML(tp, S){
    var emoji = tp.emoji || (window.TOOL_EMOJI && TOOL_EMOJI[tp.tool]) || '🔧';
    var name  = tp.toolZh || (window.TOOL_NAME_ZH && TOOL_NAME_ZH[tp.tool]) || tp.tool || '工具';
    var ms = tp._ms;
    /* 完成态不再印「已完成 · 0.4s」那串绿字（第 43 条）：标题整行变绿就够了，
       耗时留成右侧一枚灰字，信息不丢、也不再多一列彩色标签。 */
    /* 2026-11-13 第 47 条（用户原话）：「不要再写那三个字了，把标题的颜色改一下就行」。
       中断/失败不再印文字，标题颜色即状态：绿=完成、橙=被停/中断、红=失败。
       只有运行中留一枚「执行中…」，那是过程不是结论，没有颜色可代。 */
    var txt = S.running ? '执行中…' : '';
    var tail = txt ? ('<span class="tool-status '+(S.running?'running':'done')+'">'+txt+'</span>')
                   : ((ms>0) ? ('<span class="tool-time">'+(ms<1000?Math.round(ms)+'ms':(ms/1000).toFixed(1)+'s')+'</span>') : '');
    return '<span class="tool-icon">'+emoji+'</span>'+
           '<span class="tool-name">'+e(name)+'</span>'+
           tail+
           CHEV;
  }

  /* 状态落到 details 上，CSS 才知道该给标题上什么颜色（done=绿，其余保持原色） */
  function stateName(S){
    return S.running ? 'running' : (S.interrupted ? 'interrupted' : (S.failed ? 'failed' : 'done'));
  }

  function bodyHTML(tp){
    var label = tp.label || tp.command || tp.summary || '';
    var raw = String(label||'');
    var h = '';
    /* 命令前面那行「完整命令」小字 2026-11-13 删掉：展开就已经是命令本身，
       再加个标签等于给同一块内容贴两次名。结果区仍留「结果」区分两块。 */
    if(raw.trim()) h += '<div class="tool-cmd">'+e(raw)+'</div>';
    if(tp.result)  h += '<div class="tool-out"><span class="tool-cmd-label">结果</span>'+e(tp.result)+'</div>';
    if(!raw.trim() && !tp.result && tp.args){
      var a = (typeof tp.args==='string') ? tp.args : JSON.stringify(tp.args, null, 2);
      if(a && a!=='{}') h += '<div class="tool-cmd"><span class="tool-cmd-label">参数</span>'+e(a)+'</div>';
    }
    return h;
  }

  function cardHTML(tp, hist, turn, isLast){
    if(!tp) return '';
    /* 技能调用渲染成 chip，不占整卡（Issue #9） */
    if(tp.skill || (tp.tool && /skill/i.test(tp.tool))){
      return '<span class="skill-invoke-chip">🧩 '+e(tp.toolZh||tp.name||tp.tool||'技能')+'</span>';
    }
    var S = statusOf(tp, hist, turn, isLast);
    var tk = tp._tk || tp.toolCallId || (String(tp.tool||'tool')+':'+String(tp.label||tp.command||tp.summary||'').slice(0,40));
    var open = (st.card[tk]===true) ? true : (st.card[tk]===false ? false : !!(S.running && autoOpen()));
    var tid = tp.toolCallId ? ' data-tid="'+e(tp.toolCallId)+'"' : '';
    return '<details class="tool-call'+(S.running?' running':'')+'" data-state="'+stateName(S)+'" data-tk="'+e(tk)+'"'+tid+(open?' open':'')+'>'+
             '<summary class="tool-head">'+headHTML(tp,S)+'</summary>'+
             '<div class="tool-body">'+bodyHTML(tp)+'</div>'+
           '</details>';
  }

  function merge(tools){
    var out=[], idx={};
    for(var i=0;i<tools.length;i++){
      var t=tools[i]||{};
      var k=t.toolCallId||(String(t.tool||'tool')+'#'+i);
      if(Object.prototype.hasOwnProperty.call(idx,k)){
        var x=out[idx[k]];
        if(statusOf(t,false).running===false && statusOf(x,false).running===true) x.status=t.status;
        if(!x.emoji&&t.emoji) x.emoji=t.emoji;
        if(!x.toolZh&&t.toolZh) x.toolZh=t.toolZh;
        if(!(x.label||x.command||x.summary)){ var l=t.label||t.command||t.summary; if(l) x.label=l; }
        if(!x.result&&t.result) x.result=t.result;
      } else {
        idx[k]=out.length; var c={}; for(var kk in t) c[kk]=t[kk]; out.push(c);
      }
    }
    for(var mi=0;mi<out.length;mi++){ if(!out[mi]._tk) out[mi]._tk = out[mi].toolCallId || ('k'+mi); }
    return out;
  }

  function groupHTML(tools, hist, boxId, turn){
    if(!tools || !tools.length) return '';
    if(window.panelToolsMode && panelToolsMode()==='hidden') return '';
    var list = merge(tools);
    var box = boxId || ('b'+Math.random().toString(36).slice(2,9));
    /* 首屏一律收起：只有用户自己点开过（st.box===true）才展开 */
    var open = (st.box[box]===true);
    return '<details class="tool-calls" data-box="'+e(box)+'"'+(open?' open':'')+'>'+
             '<summary class="tool-summary"><span class="tc-ico">🛠</span>'+
             '<span class="tc-text">已调用 '+list.length+' 个工具</span>'+CHEV+'</summary>'+
             '<div class="tool-list">'+list.map(function(t,i){ return cardHTML(t,hist,turn,i===list.length-1); }).join('')+'</div>'+
           '</details>';
  }

  /* 流式增量：卡片元素已存在，原地改内容，不重建 <details>（重建会丢用户的 open 状态） */
  function upsert(cardEl, tp){
    if(!cardEl) return;
    var S = statusOf(tp, false);
    cardEl.classList.toggle('running', S.running);
    cardEl.setAttribute('data-state', stateName(S));
    var head = cardEl.querySelector('.tool-head');
    if(head) head.innerHTML = headHTML(tp, S);
    var body = cardEl.querySelector('.tool-body');
    if(body) body.innerHTML = bodyHTML(tp);
    if(st.card[keyCard(cardEl)]===undefined){        // 用户没点过才跟状态走
      if(S.running && autoOpen()) cardEl.open = true;
    }
  }

  function paint(root){
    if(!root || !root.querySelectorAll) return;
    var boxes = [];
    if(root.tagName==='DETAILS' && root.classList.contains('tool-calls')) boxes.push(root);
    Array.prototype.forEach.call(root.querySelectorAll('details.tool-calls'), function(b){ boxes.push(b); });
    boxes.forEach(function(box){
      var bk = box.getAttribute('data-box');
      if(bk && st.box[bk]!==undefined) box.open = st.box[bk];
      Array.prototype.forEach.call(box.querySelectorAll('details.tool-call'), function(c){
        var ck = keyCard(c);
        if(ck && st.card[ck]!==undefined) c.open = st.card[ck];
      });
    });
  }

  /* 流式骨架用：summary 的 markup 也收进来，compose.js 不再手抄一份 SVG
     （2026-11-13 第 40 条：那份手抄的 width/height 写的是 18，靠 CSS 才拉到 20，两处已经在分叉） */
  function summaryHTML(text){
    return '<summary class="tool-summary"><span class="tc-ico">🛠</span>'+
           '<span class="tc-text">'+e(text||'工具调用')+'</span>'+CHEV+'</summary>';
  }

  bind();
  return { summaryHTML:summaryHTML, cardHTML:cardHTML, groupHTML:groupHTML, upsert:upsert, paint:paint, bind:bind, state:st,
           openOf:function(k){ return st.card[k]; } };
})();
