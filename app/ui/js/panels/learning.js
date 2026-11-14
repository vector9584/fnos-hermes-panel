/* 学习轨迹
 * 来源：index.html 内联 app.js 第 7781-8346 行（共 566 行）
 * 2026-11-13 按原分区纯搬运外移，逻辑零改动。全局作用域与执行顺序与原内联块一致。 */

/* ============================ 学习轨迹 ============================ */
var LEARN_COLORS = { skills:'#f59e0b', 'software-development':'#3b82f6', media:'#8b5cf6', creative:'#ec4899', devops:'#10b981', productivity:'#06b6d4', memory:'#6366f1', other:'#6b7280' };
var LEARN_EXTRA_COLORS = ['#ef4444','#14b8a6','#f97316','#a3e635','#d946ef','#0ea5e9','#84cc16','#f43f5e'];
function _ensureCatColor(cat){
  if(!LEARN_COLORS[cat]){
    var h=0; for(var i=0;i<cat.length;i++) h=(h*31+cat.charCodeAt(i))>>>0;
    LEARN_COLORS[cat]=LEARN_EXTRA_COLORS[h%LEARN_EXTRA_COLORS.length];
  }
  return LEARN_COLORS[cat];
}
var LEARN_CAT_LABELS = { skills:'技能', 'software-development':'软件开发', media:'媒体', creative:'创意', devops:'DevOps', productivity:'效率', memory:'记忆', other:'其他' };
var _learnCatFilter = null;
var _learnRaf = 0;
var _learnState = null; // { nodes, nodeMap, edges, els }
function _learnColor(cat){ return LEARN_COLORS[cat] || LEARN_COLORS.other; }
function _shadeHex(hex, amt){
  var n = parseInt(hex.slice(1),16), r=n>>16, g=(n>>8)&255, b=n&255;
  function f(v){ v = amt>0 ? v+(255-v)*amt : v*(1+amt); return Math.round(Math.max(0,Math.min(255,v))); }
  return 'rgb('+f(r)+','+f(g)+','+f(b)+')';
}
function renderLearning(){
  var statsEl = document.getElementById('learnStats');
  var graphEl = document.getElementById('learnGraph');
  if(!graphEl) return;
  _learnCatFilter = null;
  if(_learnRaf){ cancelAnimationFrame(_learnRaf); _learnRaf=0; }
  graphEl.innerHTML = '<div class="empty-state">加载中…</div>';
  apiGet('/api/learning-trajectory').then(function(res){
    if(!res || !res.ok){ graphEl.innerHTML='<div class="empty-state">加载失败</div>'; return; }
    var skills = res.skills || [];
    var relations = res.relations || [];
    skills.forEach(function(s){ _ensureCatColor(s.category||'other'); });
    var totalUsage = skills.reduce(function(a,s){ return a+(s.usage_count||0); },0);
    // 统计栏（分类徽章可点击筛选）
    if(statsEl){
      var cats = {};
      skills.forEach(function(s){ var c=s.category||'other'; if(!cats[c]) cats[c]={count:0,usage:0}; cats[c].count++; cats[c].usage+=(s.usage_count||0); });
      var catHtml = '<span class="learn-cat-badge on" data-cat="" onclick="setLearnFilter(\'\')"><span class="learn-cat-dot" style="background:var(--text3)"></span>全部 '+skills.length+'</span>';
      catHtml += Object.keys(cats).sort(function(a,b){ return cats[b].usage-cats[a].usage; }).map(function(c){
        var pct = totalUsage ? Math.round(cats[c].usage/totalUsage*100) : 0;
        return '<span class="learn-cat-badge" data-cat="'+DOM.escAttr(c)+'" onclick="setLearnFilter(\''+esc(c).replace(/'/g,"\\'")+'\')"><span class="learn-cat-dot" style="background:'+_learnColor(c)+'"></span>'+esc(LEARN_CAT_LABELS[c]||c)+' '+cats[c].count+' / '+pct+'%</span>';
      }).join('');
      statsEl.innerHTML = '<div class="learn-summary"><strong>'+skills.length+'</strong> 技能 · <strong>'+relations.length+'</strong> 关系 · <strong>'+totalUsage+'</strong> 次使用</div><div class="learn-cats">'+catHtml+'</div>';
    }
    if(!skills.length){ graphEl.innerHTML='<div class="empty-state">尚无技能数据</div>'; return; }
    renderSkillGraph(graphEl, skills, relations, res.notes, res.note_edges);
  }).catch(function(e){ graphEl.innerHTML='<div class="empty-state">网络错误</div>'; });
}
function setLearnFilter(cat){
  _learnCatFilter = (cat && cat!==_learnCatFilter) ? cat : null;
  document.querySelectorAll('.learn-cat-badge').forEach(function(b){
    b.classList.toggle('on', (b.getAttribute('data-cat')||'')===(_learnCatFilter||''));
  });
  applyLearnFilter();
}
function applyLearnFilter(){
  var st=_learnState; if(!st) return;
  var f=_learnCatFilter;
  // 筛分类时笔记节点跟随：只要它连到该分类的任一技能，就保持可见（2026-11-11 第 10 项）
  var litNotes = {};
  if(f) st.edges.forEach(function(e){
    if(e.kind!=='note') return;
    var skillNode = e.a.kind==='note' ? e.b : e.a;
    var noteNode  = e.a.kind==='note' ? e.a : e.b;
    if(skillNode.category===f) litNotes[noteNode.id]=true;
  });
  st.nodes.forEach(function(n){
    var dim = f && n.category!==f && !(n.kind==='note' && litNotes[n.id]);
    n.el.style.opacity = dim ? '0.14' : '1';
    n.el.style.pointerEvents = dim ? 'none' : '';
  });
  st.edges.forEach(function(e){
    var dim = f && (e.a.category!==f && e.b.category!==f);
    var base = e.kind==='note' ? '0.35' : '0.5';
    e.el.setAttribute('opacity', dim ? '0.05' : base);
  });
}
function renderSkillGraph(container, skills, relations, notes, noteEdges){
  var W=900, H=560, NS='http://www.w3.org/2000/svg';
  var maxUsage = Math.max.apply(null, skills.map(function(s){ return s.usage_count||1; }));
  // 初始位置：按分类分簇 + 抖动，收敛更快
  var catIndex = {};
  skills.forEach(function(s){ var c=s.category||'other'; catIndex[c]=(catIndex[c]||[]); catIndex[c].push(s); });
  var catKeys = Object.keys(catIndex);
  var nodes = [];
  catKeys.forEach(function(c, ci){
    var ang = (2*Math.PI*ci)/Math.max(1,catKeys.length) - Math.PI/2;
    var bcx = W/2 + Math.cos(ang)*Math.min(W,H)*0.28, bcy = H/2 + Math.sin(ang)*Math.min(W,H)*0.28;
    catIndex[c].forEach(function(s, i){
      var radius = 3 + Math.sqrt((s.usage_count||1)/maxUsage)*3;
      nodes.push({ id:s.id, name:s.name||s.id, category:s.category||'other', usage:s.usage_count||0, skill:s,
        x: bcx + (Math.random()-0.5)*50, y: bcy + (Math.random()-0.5)*50, vx:0, vy:0, fx:null, fy:null, r:radius });
    });
  });
  // 笔记节点（2026-11-11 第 10 项）：技能名出现在笔记正文里 → 技能节点连一条虚线到笔记节点。
  // 后端已按被引用次数截到 120 篇，这里再按环形铺开，初始位置靠近圆心外圈减少初始爆炸。
  (notes||[]).forEach(function(note, i){
    var ang = (2*Math.PI*i)/Math.max(1, (notes||[]).length);
    nodes.push({ id:'note:'+note.path, name:note.title||note.path, category:'note', kind:'note', note:note,
      usage:0, r:5, vx:0, vy:0, fx:null, fy:null,
      x: W/2 + Math.cos(ang)*Math.min(W,H)*0.40 + (Math.random()-0.5)*40,
      y: H/2 + Math.sin(ang)*Math.min(W,H)*0.40 + (Math.random()-0.5)*40 });
  });
  var nodeMap = {}; nodes.forEach(function(n){ nodeMap[n.id]=n; });
  var edges = [];
  relations.forEach(function(rel){
    var a=nodeMap[rel.from], b=nodeMap[rel.to];
    if(a && b && a!==b) edges.push({ a:a, b:b, kind:'skill' });
  });
  (noteEdges||[]).forEach(function(ne){
    var a=nodeMap[ne.from], b=nodeMap['note:'+ne.to];
    if(a && b) edges.push({ a:a, b:b, kind:'note' });
  });

  var svg = document.createElementNS(NS,'svg');
  svg.setAttribute('viewBox','0 0 '+W+' '+H);
  svg.setAttribute('preserveAspectRatio','xMidYMid meet');
  svg.style.width='100%'; svg.style.height='100%'; svg.style.display='block';
  // 触屏支持：禁止浏览器默认触摸行为（滚动/双击缩放），交给 JS 手势处理
  svg.style.touchAction='none';
  // 缩放/平移状态（2026-08-24：滚轮缩放 + 空白拖拽平移）
  var vb = { x:0, y:0, w:W, h:H };
  function applyViewBox(){
    svg.setAttribute('viewBox', vb.x.toFixed(1)+' '+vb.y.toFixed(1)+' '+vb.w.toFixed(1)+' '+vb.h.toFixed(1));
  }
  // 滚轮缩放（以鼠标位置为中心，min 0.35x / max 4x）
  svg.addEventListener('wheel', function(evt){
    evt.preventDefault();
    var p = svgPoint(evt);
    var factor = evt.deltaY>0 ? 1.12 : 0.89;
    var nw = Math.max(W*0.35, Math.min(W*4, vb.w*factor));
    var nh = nw*vb.h/vb.w;
    var kx = (p.x-vb.x)/vb.w, ky = (p.y-vb.y)/vb.h;
    vb.x = p.x - kx*nw; vb.y = p.y - ky*nh; vb.w = nw; vb.h = nh;
    applyViewBox();
  }, { passive:false });
  // 空白区域拖拽平移画布 + 双指捏合缩放（2026-08-24：支持触屏）
  var panning = false, panSX = 0, panSY = 0, panVX = 0, panVY = 0;
  var pointers = {}; // 活动触点表（pointerId -> {x,y}）
  var pinchDist = 0; // 双指间距
  svg.addEventListener('pointerdown', function(evt){
    evt.preventDefault();
    pointers[evt.pointerId] = { x:evt.clientX, y:evt.clientY };
    var ids = Object.keys(pointers);
    if(ids.length === 1){
      panning = true; panSX = evt.clientX; panSY = evt.clientY; panVX = vb.x; panVY = vb.y;
      container.classList.add('panning');
    } else if(ids.length === 2){
      // 第二指落下：结束平移，进入捏合模式
      panning = false;
      var a = pointers[ids[0]], b = pointers[ids[1]];
      pinchDist = Math.sqrt((a.x-b.x)*(a.x-b.x)+(a.y-b.y)*(a.y-b.y)) || 1;
    }
    try{ svg.setPointerCapture(evt.pointerId); }catch(e){}
  });
  function svgPointAt(cx, cy){
    var pt = svg.createSVGPoint(); pt.x = cx; pt.y = cy;
    var m = svg.getScreenCTM(); if(!m) return {x:0,y:0};
    var p = pt.matrixTransform(m.inverse()); return {x:p.x, y:p.y};
  }
  svg.addEventListener('pointermove', function(evt){
    if(!(evt.pointerId in pointers)) return;
    pointers[evt.pointerId] = { x:evt.clientX, y:evt.clientY };
    var ids = Object.keys(pointers);
    if(ids.length >= 2){
      // 双指捏合缩放：以两指中点为中心
      var a = pointers[ids[0]], b = pointers[ids[1]];
      var d = Math.sqrt((a.x-b.x)*(a.x-b.x)+(a.y-b.y)*(a.y-b.y)) || 1;
      if(pinchDist > 0){
        var factor = d / pinchDist;
        var mx = (a.x+b.x)/2, my = (a.y+b.y)/2;
        var p = svgPointAt(mx, my);
        var nw = Math.max(W*0.35, Math.min(W*4, vb.w*factor));
        var nh = nw*vb.h/vb.w;
        var kx = (p.x-vb.x)/vb.w, ky = (p.y-vb.y)/vb.h;
        vb.x = p.x - kx*nw; vb.y = p.y - ky*nh; vb.w = nw; vb.h = nh;
        applyViewBox();
      }
      pinchDist = d;
      return;
    }
    if(!panning) return;
    var k = vb.w / (svg.clientWidth || W);
    vb.x = panVX - (evt.clientX-panSX)*k;
    vb.y = panVY - (evt.clientY-panSY)*k;
    applyViewBox();
  });
  function endPan(evt){
    delete pointers[evt.pointerId];
    var ids = Object.keys(pointers);
    if(ids.length < 2){ pinchDist = 0; }
    if(ids.length === 0){ panning = false; container.classList.remove('panning'); }
    else if(ids.length === 1){
      // 捏合结束剩一指：恢复平移基准，避免跳变
      var p = pointers[ids[0]]; panning = true; panSX = p.x; panSY = p.y; panVX = vb.x; panVY = vb.y;
    }
  }
  svg.addEventListener('pointerup', endPan);
  svg.addEventListener('pointercancel', endPan);
  svg.addEventListener('pointerleave', function(evt){
    if(evt.pointerId && evt.pointerId in pointers) delete pointers[evt.pointerId];
    if(Object.keys(pointers).length === 0){ panning = false; container.classList.remove('panning'); }
  });
  // ── Touch 兜底：微信内置浏览器（X5 内核）等不支持 PointerEvent 的 WebView ──
  // 与上面 pointer 逻辑互斥：只有不支持 PointerEvent 时才注册 touch 事件（否则双触发）
  if(!window.PointerEvent){
    svg.addEventListener('touchstart', function(evt){
      evt.preventDefault();
      var i, t, changed = evt.changedTouches;
      for(i=0;i<changed.length;i++){ t=changed[i]; pointers[t.identifier] = {x:t.clientX, y:t.clientY}; }
      var ids = Object.keys(pointers);
      if(ids.length === 1){
        panning = true; panSX = pointers[ids[0]].x; panSY = pointers[ids[0]].y; panVX = vb.x; panVY = vb.y;
        container.classList.add('panning');
      } else if(ids.length === 2){
        panning = false;
        var a = pointers[ids[0]], b = pointers[ids[1]];
        pinchDist = Math.sqrt((a.x-b.x)*(a.x-b.x)+(a.y-b.y)*(a.y-b.y)) || 1;
      }
    }, {passive:false});
    svg.addEventListener('touchmove', function(evt){
      evt.preventDefault();
      var i, t, changed = evt.changedTouches;
      for(i=0;i<changed.length;i++){
        t=changed[i];
        if(t.identifier in pointers) pointers[t.identifier] = {x:t.clientX, y:t.clientY};
      }
      var ids = Object.keys(pointers);
      if(ids.length >= 2){
        var a = pointers[ids[0]], b = pointers[ids[1]];
        var d = Math.sqrt((a.x-b.x)*(a.x-b.x)+(a.y-b.y)*(a.y-b.y)) || 1;
        if(pinchDist > 0){
          var factor = d / pinchDist;
          var mx = (a.x+b.x)/2, my = (a.y+b.y)/2;
          var pp = svgPointAt(mx, my);
          var nw2 = Math.max(W*0.35, Math.min(W*4, vb.w*factor));
          var nh2 = nw2*vb.h/vb.w;
          var kx = (pp.x-vb.x)/vb.w, ky = (pp.y-vb.y)/vb.h;
          vb.x = pp.x - kx*nw2; vb.y = pp.y - ky*nh2; vb.w = nw2; vb.h = nh2;
          applyViewBox();
        }
        pinchDist = d;
        return;
      }
      if(!panning) return;
      var t0 = pointers[ids[0]];
      var k = vb.w / (svg.clientWidth || W);
      vb.x = panVX - (t0.x-panSX)*k;
      vb.y = panVY - (t0.y-panSY)*k;
      applyViewBox();
    }, {passive:false});
    function touchEndPan(evt){
      evt.preventDefault();
      var i, changed = evt.changedTouches;
      for(i=0;i<changed.length;i++){ delete pointers[changed[i].identifier]; }
      var ids = Object.keys(pointers);
      if(ids.length < 2){ pinchDist = 0; }
      if(ids.length === 0){ panning = false; container.classList.remove('panning'); }
      else if(ids.length === 1){
        var p = pointers[ids[0]]; panning = true; panSX = p.x; panSY = p.y; panVX = vb.x; panVY = vb.y;
      }
    }
    svg.addEventListener('touchend', touchEndPan, {passive:false});
    svg.addEventListener('touchcancel', touchEndPan, {passive:false});
  }
  // 渐变 defs（3D 球体感）
  var defs = document.createElementNS(NS,'defs');
  Object.keys(LEARN_COLORS).forEach(function(c){
    var col = LEARN_COLORS[c];
    var g = document.createElementNS(NS,'radialGradient');
    g.setAttribute('id','lg-'+c); g.setAttribute('cx','35%'); g.setAttribute('cy','28%'); g.setAttribute('r','80%');
    var s1=document.createElementNS(NS,'stop'); s1.setAttribute('offset','0%'); s1.setAttribute('stop-color',_shadeHex(col,0.55));
    var s2=document.createElementNS(NS,'stop'); s2.setAttribute('offset','45%'); s2.setAttribute('stop-color',col);
    var s3=document.createElementNS(NS,'stop'); s3.setAttribute('offset','100%'); s3.setAttribute('stop-color',_shadeHex(col,-0.35));
    g.appendChild(s1); g.appendChild(s2); g.appendChild(s3); defs.appendChild(g);
  });
  svg.appendChild(defs);
  var edgeLayer = document.createElementNS(NS,'g'); svg.appendChild(edgeLayer);
  var nodeLayer = document.createElementNS(NS,'g'); svg.appendChild(nodeLayer);
  edges.forEach(function(e){
    var ln=document.createElementNS(NS,'line');
    if(e.kind==='note'){
      ln.setAttribute('stroke','var(--accent)'); ln.setAttribute('stroke-width','1.2');
      ln.setAttribute('opacity','0.6'); ln.setAttribute('stroke-dasharray','3 3');
    } else {
      ln.setAttribute('stroke','var(--border2)'); ln.setAttribute('stroke-width','1'); ln.setAttribute('opacity','0.5');
    }
    edgeLayer.appendChild(ln); e.el=ln;
  });
  nodes.forEach(function(n){
    var g=document.createElementNS(NS,'g');
    g.setAttribute('class', n.kind==='note' ? 'learn-node learn-note' : 'learn-node');
    g.setAttribute('data-id',n.id);
    var shadow=document.createElementNS(NS,'ellipse');
    shadow.setAttribute('rx',n.r*0.8); shadow.setAttribute('ry',n.r*0.3); shadow.setAttribute('fill','rgba(0,0,0,.12)');
    shadow.setAttribute('cx','0'); shadow.setAttribute('cy',String(n.r+3));
    g.appendChild(shadow);
    if(n.kind==='note'){
      var rc=document.createElementNS(NS,'rect');
      rc.setAttribute('x',String(-n.r)); rc.setAttribute('y',String(-n.r));
      rc.setAttribute('width',String(n.r*2)); rc.setAttribute('height',String(n.r*2));
      rc.setAttribute('rx','1'); rc.setAttribute('fill','var(--accent)'); rc.setAttribute('opacity','0.8');
      g.appendChild(rc);
    } else {
      var c=document.createElementNS(NS,'circle');
      c.setAttribute('r',n.r); c.setAttribute('fill','url(#lg-'+n.category+')');
      c.setAttribute('stroke',_shadeHex(_learnColor(n.category),-0.25)); c.setAttribute('stroke-width','0.5');
      g.appendChild(c);
    }
    if(n.r>=4){
      var t=document.createElementNS(NS,'text');
      t.setAttribute('text-anchor','middle'); t.setAttribute('y',String(n.r+10));
      t.setAttribute('font-size','11'); t.setAttribute('fill','var(--text2)');
      t.textContent = n.name.length>12 ? n.name.slice(0,12)+'…' : n.name;
      g.appendChild(t);
    }
    nodeLayer.appendChild(g); n.el=g;
  });
  container.innerHTML='';
  container.appendChild(svg);
  // hover tooltip（2026-08-24 新增）
  var tip = document.createElement('div');
  tip.className = 'learn-tooltip';
  tip.style.display = 'none';
  container.appendChild(tip);
  function showTip(n){
    if(n.kind==='note'){
      tip.innerHTML = '<div class="tt-name">📄 '+esc(n.name)+'</div><div class="tt-meta">笔记 · 被 '+(n.note.links||0)+' 个技能提到 · 点击打开</div>';
    } else {
      var catLabel = (typeof LEARN_CAT_LABELS!=='undefined' && LEARN_CAT_LABELS[n.category]) ? LEARN_CAT_LABELS[n.category] : n.category;
      tip.innerHTML = '<div class="tt-name">'+esc(n.name)+'</div><div class="tt-meta">'+esc(catLabel)+' · 使用 '+(n.usage||0)+' 次</div>';
    }
    tip.style.display = 'block';
  }
  function moveTip(evt){
    var r = container.getBoundingClientRect();
    var x = evt.clientX - r.left + 14, y = evt.clientY - r.top + 14;
    if(x + 220 > r.width) x = evt.clientX - r.left - 230;
    if(y + 70 > r.height) y = evt.clientY - r.top - 70;
    tip.style.left = x+'px'; tip.style.top = y+'px';
  }
  function hideTip(){ tip.style.display='none'; }
  // 图例
  var legend=document.createElement('div'); legend.className='learn-legend';
  legend.innerHTML = catKeys.slice(0,6).map(function(c){ return '<span><span class="lg-dot" style="background:'+_learnColor(c)+'"></span>'+esc(LEARN_CAT_LABELS[c]||c)+'</span>'; }).join('')
    + ((notes&&notes.length) ? '<span><span class="lg-dot" style="background:var(--accent);border-radius:1px"></span>笔记 '+notes.length+'</span>' : '');
  container.appendChild(legend);

  _learnState = { nodes:nodes, nodeMap:nodeMap, edges:edges };
  applyLearnFilter();

  // 力导向模拟
  var alpha = 1;
  function simTick(){
    var i, j, a, b, dx, dy, d2, d, f;
    // 库仑排斥
    for(i=0;i<nodes.length;i++){
      for(j=i+1;j<nodes.length;j++){
        a=nodes[i]; b=nodes[j];
        dx=b.x-a.x; dy=b.y-a.y; d2=dx*dx+dy*dy;
        if(d2<1){ dx=(Math.random()-0.5); dy=(Math.random()-0.5); d2=1; }
        d=Math.sqrt(d2);
        f = 600/d2 * alpha;
        var fx=dx/d*f, fy=dy/d*f;
        a.vx-=fx; a.vy-=fy; b.vx+=fx; b.vy+=fy;
      }
    }
    // 连线弹簧
    edges.forEach(function(e){
      dx=e.b.x-e.a.x; dy=e.b.y-e.a.y; d=Math.sqrt(dx*dx+dy*dy)||1;
      var rest = 30 + e.a.r + e.b.r;
      f = (d-rest)*0.015*alpha;
      e.a.vx += dx/d*f; e.a.vy += dy/d*f;
      e.b.vx -= dx/d*f; e.b.vy -= dy/d*f;
    });
    // 向心 + 积分
    nodes.forEach(function(n){
      n.vx += (W/2-n.x)*0.0016*alpha;
      n.vy += (H/2-n.y)*0.0016*alpha;
      if(n.fx!=null){ n.x=n.fx; n.y=n.fy; n.vx=0; n.vy=0; return; }
      n.vx*=0.82; n.vy*=0.82;
      n.x+=n.vx; n.y+=n.vy;
      var m=n.r+4;
      if(n.x<m){n.x=m;n.vx=0;} if(n.x>W-m){n.x=W-m;n.vx=0;}
      if(n.y<m){n.y=m;n.vy=0;} if(n.y>H-m){n.y=H-m;n.vy=0;}
    });
  }
  function draw(){
    nodes.forEach(function(n){ n.el.setAttribute('transform','translate('+n.x.toFixed(1)+','+n.y.toFixed(1)+')'); });
    edges.forEach(function(e){
      e.el.setAttribute('x1',e.a.x); e.el.setAttribute('y1',e.a.y);
      e.el.setAttribute('x2',e.b.x); e.el.setAttribute('y2',e.b.y);
    });
  }
  function loop(){
    if(alpha>0.02){ simTick(); alpha*=0.985; draw(); _learnRaf=requestAnimationFrame(loop); }
    else { _learnRaf=0; draw(); }
  }
  function reheat(v){ if(alpha<v) alpha=v; if(!_learnRaf) _learnRaf=requestAnimationFrame(loop); }
  draw();
  _learnRaf=requestAnimationFrame(loop);

  // 拖拽 + 点击（pointer events，坐标换算到 viewBox）
  function svgPoint(evt){
    var pt=svg.createSVGPoint(); pt.x=evt.clientX; pt.y=evt.clientY;
    var m=svg.getScreenCTM(); if(!m) return {x:0,y:0};
    var p=pt.matrixTransform(m.inverse()); return {x:p.x, y:p.y};
  }
  nodes.forEach(function(n){
    var dragging=false, moved=0, sx=0, sy=0;
    n.el.addEventListener('pointerdown', function(evt){
      evt.preventDefault();
      evt.stopPropagation();
      // 同步注册进画布触点表，保证「一指节点 + 一指空白」也能双指捏合
      pointers[evt.pointerId] = { x:evt.clientX, y:evt.clientY };
      var ids = Object.keys(pointers);
      if(ids.length === 2){
        panning = false;
        var pa = pointers[ids[0]], pb = pointers[ids[1]];
        pinchDist = Math.sqrt((pa.x-pb.x)*(pa.x-pb.x)+(pa.y-pb.y)*(pa.y-pb.y)) || 1;
      }
      dragging=true; moved=0; var p=svgPoint(evt); sx=p.x; sy=p.y;
      n.fx=n.x; n.fy=n.y;
      try{ n.el.setPointerCapture(evt.pointerId); }catch(e){}
    });
    n.el.addEventListener('pointermove', function(evt){
      if(!dragging) return;
      evt.stopPropagation();
      var p=svgPoint(evt);
      moved += Math.abs(p.x-sx)+Math.abs(p.y-sy); sx=p.x; sy=p.y;
      n.fx=p.x; n.fy=p.y; reheat(0.25);
    });
    n.el.addEventListener('pointerup', function(evt){
      delete pointers[evt.pointerId];
      var ids = Object.keys(pointers);
      if(ids.length < 2){ pinchDist = 0; }
      if(ids.length === 0){ panning = false; container.classList.remove('panning'); }
      else if(ids.length === 1){
        var p = pointers[ids[0]]; panning = true; panSX = p.x; panSY = p.y; panVX = vb.x; panVY = vb.y;
      }
      if(!dragging) return;
      dragging=false;
      if(moved<5){
        n.fx=null; n.fy=null;
        if(n.kind==='note'){ if(window.panelOpenLibrary) window.panelOpenLibrary('knowledge', n.note.path); }
        else showSkillDetail(n.skill);
      }
      // 拖拽后钉住位置，保持用户布局
    });
    n.el.addEventListener('pointercancel', function(evt){
      delete pointers[evt.pointerId];
      var ids = Object.keys(pointers);
      if(ids.length < 2){ pinchDist = 0; }
      if(ids.length === 0){ panning = false; container.classList.remove('panning'); }
      else if(ids.length === 1){
        var p = pointers[ids[0]]; panning = true; panSX = p.x; panSY = p.y; panVX = vb.x; panVY = vb.y;
      }
      dragging=false;
    });
    n.el.addEventListener('pointerenter', function(){ showTip(n); });
    n.el.addEventListener('pointermove', function(evt){ moveTip(evt); });
    n.el.addEventListener('pointerleave', hideTip);
    // ── 节点 Touch 兜底（仅无 PointerEvent 的 WebView）──
    if(!window.PointerEvent){
      n.el.addEventListener('touchstart', function(evt){
        evt.preventDefault(); evt.stopPropagation();
        var t = evt.changedTouches[0];
        pointers[t.identifier] = {x:t.clientX, y:t.clientY};
        var ids = Object.keys(pointers);
        if(ids.length === 2){
          panning = false;
          var pa = pointers[ids[0]], pb = pointers[ids[1]];
          pinchDist = Math.sqrt((pa.x-pb.x)*(pa.x-pb.x)+(pa.y-pb.y)*(pa.y-pb.y)) || 1;
        }
        var p = svgPoint({clientX:t.clientX, clientY:t.clientY});
        n._tdrag = {sx:p.x, sy:p.y, moved:0};
        n.fx = n.x; n.fy = n.y;
      }, {passive:false});
      n.el.addEventListener('touchmove', function(evt){
        evt.preventDefault(); evt.stopPropagation();
        var t = evt.changedTouches[0];
        if(!n._tdrag) return;
        if(t.identifier in pointers) pointers[t.identifier] = {x:t.clientX, y:t.clientY};
        var p = svgPoint({clientX:t.clientX, clientY:t.clientY});
        n._tdrag.moved += Math.abs(p.x-n._tdrag.sx)+Math.abs(p.y-n._tdrag.sy);
        n._tdrag.sx = p.x; n._tdrag.sy = p.y;
        n.fx = p.x; n.fy = p.y; reheat(0.25);
      }, {passive:false});
      n.el.addEventListener('touchend', function(evt){
        evt.preventDefault(); evt.stopPropagation();
        var t = evt.changedTouches[0];
        delete pointers[t.identifier];
        var ids = Object.keys(pointers);
        if(ids.length < 2){ pinchDist = 0; }
        if(ids.length === 0){ panning = false; container.classList.remove('panning'); }
        else if(ids.length === 1){
          var p = pointers[ids[0]]; panning = true; panSX = p.x; panSY = p.y; panVX = vb.x; panVY = vb.y;
        }
        if(!n._tdrag) return;
        var d = n._tdrag; n._tdrag = null;
        if(d.moved < 5){ n.fx=null; n.fy=null; showSkillDetail(n.skill); }
      }, {passive:false});
      n.el.addEventListener('touchcancel', function(evt){
        evt.preventDefault(); evt.stopPropagation();
        var t = evt.changedTouches[0];
        delete pointers[t.identifier];
        var ids = Object.keys(pointers);
        if(ids.length < 2){ pinchDist = 0; }
        if(ids.length === 0){ panning = false; container.classList.remove('panning'); }
        else if(ids.length === 1){
          var p = pointers[ids[0]]; panning = true; panSX = p.x; panSY = p.y; panVX = vb.x; panVY = vb.y;
        }
        n._tdrag = null;
      }, {passive:false});
    }
  });
}
function showSkillDetail(skill){
  var el=document.getElementById('learnDetail'); if(!el) return;
  var cat=skill.category||'other';
  el.style.display='';
  el.innerHTML = '<div class="mem-card"><div class="mem-card-head"><span class="mem-icon">📌</span><span class="mem-title">'+esc(skill.name||skill.id)+'</span><button class="modal-close" aria-label="关闭技能详情" title="关闭技能详情" onclick="document.getElementById(\'learnDetail\').style.display=\'none\'">\u00d7</button></div>' +
    '<div style="padding:12px;font-size:13px">' +
    '<div><strong>ID:</strong> '+esc(skill.id)+'</div>' +
    '<div><strong>分类:</strong> <span class="learn-cat-badge" style="cursor:default;padding:1px 8px"><span class="learn-cat-dot" style="background:'+_learnColor(cat)+'"></span>'+esc(LEARN_CAT_LABELS[cat]||cat)+'</span></div>' +
    '<div><strong>使用次数:</strong> '+(skill.usage_count||0)+'</div>' +
    '<div><strong>来源:</strong> '+esc(skill.source||'-')+'</div>' +
    '<div><strong>创建时间:</strong> '+(skill.created_at?new Date(skill.created_at).toLocaleString():'-')+'</div>' +
    (skill.description?'<div style="margin-top:6px;color:var(--text2)">'+esc(skill.description)+'</div>':'') +
    '</div></div>';
  // 关联笔记：拿技能名去知识库搜，点一下直接跳到那篇笔记
  var noteBox=document.createElement('div');
  noteBox.className='learn-skill-notes';
  var noteHead=document.createElement('div');noteHead.className='learn-notes-head';noteHead.textContent='关联笔记';
  var noteBody=document.createElement('div');noteBody.className='learn-notes-body';noteBody.textContent='正在查找…';
  noteBox.append(noteHead,noteBody);
  var card=el.querySelector('.mem-card');if(card)card.append(noteBox);
  (function(){
    var key=String(skill.name||skill.id||'').replace(/^@[^/]+\//,'').replace(/\.md$/i,'');
    if(!key){noteBody.textContent='这个技能没有名字，没法对笔记。';return;}
    fetch(apiUrl('/api/panel-library?source=knowledge&q='+encodeURIComponent(key)),{headers:{'X-Monitor-Token':monitorToken||''}})
      .then(function(r){return r.json();})
      .then(function(data){
        var items=(data.items||[]).slice(0,6);
        noteBody.replaceChildren();
        if(!items.length){noteBody.textContent='知识库里没有提到「'+key+'」的笔记。';return;}
        items.forEach(function(item){
          var b=document.createElement('button');b.type='button';b.className='btn';b.textContent=item.title||item.path;b.title=item.path;
          b.onclick=function(){if(window.panelOpenLibrary)window.panelOpenLibrary('knowledge',item.path);};
          noteBody.append(b);
        });
      })
      .catch(function(e){noteBody.textContent='查找失败：'+e.message;});
  })();
}

/* 保存扩展/设置相关配置 */
function saveConfig(){
  return apiPost('/api/config',{extensions:_cfg.extensions,extensions_revision:_cfg.extensions_revision}).then(function(r){
    if(!r||!r.ok)throw Error(r?.error||'保存未收到确认');
    _cfg.extensions_revision=r.extensions_revision;
    if(r.restart_required){toast('配置已保存，重启应用后生效');window.panelRuntimeRefresh?.();}
    return r;
  }).catch(function(e){toast('保存配置失败：'+e.message);return {ok:false,error:e.message};});
}