/* 档案 · 力导向物理引擎（Worker 源码，由 archive-graph.js fetch 后以 Blob 启动）
 *
 * 力学模型对齐《墨档文档阅读器_全端性能版_修改节点引力模型.html》，解决两个叠加的老问题：
 *
 *   1. 斥力随规模爆炸 + 向心力恒定 → 节点一多净力只能往外炸或塌成一团
 *      · BH 远场质心的力是 k·m/d²，m 是聚进质心的节点数，节点越多净斥力越大；
 *      · 弹簧力若按 √deg 归一化，全互链时 690 个邻居的拉力叠成巨型向心合力；
 *      · 修法：斥力按 36/n 归一化（repulseEff），弹簧按邻居数取平均（deg 而非 √deg）。
 *
 *   2. 硬钳位把节点钉死在边上
 *      · 旧代码 x∈[34,W-34]、y∈[30,H-80] 撞墙即停、不回弹，而在矩形里让两两距离最大化
 *        的位置几何上正是四个角 —— 膨胀的终点必然贴边聚角；
 *      · 修法：软边界弹性回推（pad=26 / bottom=H-56，系数 0.12-0.1），坐标钳位只做
 *        数值兜底 [2, W-2]，正常收敛不触发。
 *
 * 另外分类节点改为骨架锚点：固定成按画布宽高分别取 0.34W / 0.32H 的椭圆铺满视口，
 * 不再参与自由碰撞（否则会被斥力推到边界，子节点靠弹簧跟过去形成「一个大簇 + 孤岛」）。
 *
 * 消息协议：
 *   init {n,W,H,mode,theta,linkLen,catCount,parent,edges,radius,pos,visible}
 *   drag {i,x,y} / unfix {i} / filter {visible} / mode {mode} / resize {W,H} / reset / kick / dispose
 *   回帧 {type:'frame',pos:Float32Array(n*2),alpha,physics,frame,converged,mode}
 */
(function (self) {
  'use strict';
  var n = 0, W = 900, H = 560, mode = 'bh', theta = 0.9, alpha = 1, linkLen = 100, repulse = 2600;
  var x, y, vx, vy, ax, ay, sx, sy, deg, rad, fixed, vis, edges, parent, catCount = 0;
  var anchorX, anchorY, anchorK = 0, repulseEff = 2600;
  var frame = 0, timer = null, disposed = false, posOut = null;
  var qCap = 0, qChild, qMass, qCx, qCy, qMinX, qMinY, qSize, qBody, qCount = 0, stack;
  var GOLD = 2.399963229728653, DAMP = 0.85;

  function alloc(nc) {
    qCap = nc;
    qChild = new Int32Array(nc * 4); qChild.fill(-1);
    qMass = new Float32Array(nc); qCx = new Float32Array(nc); qCy = new Float32Array(nc);
    qMinX = new Float32Array(nc); qMinY = new Float32Array(nc); qSize = new Float32Array(nc);
    qBody = new Int32Array(nc); stack = new Int32Array(nc * 2);
  }
  function grow() {
    var nc = qCap * 2;
    var c = new Int32Array(nc * 4); c.fill(-1); c.set(qChild); qChild = c;
    var a1 = new Float32Array(nc); a1.set(qMass); qMass = a1;
    var a2 = new Float32Array(nc); a2.set(qCx); qCx = a2;
    var a3 = new Float32Array(nc); a3.set(qCy); qCy = a3;
    var a4 = new Float32Array(nc); a4.set(qMinX); qMinX = a4;
    var a5 = new Float32Array(nc); a5.set(qMinY); qMinY = a5;
    var a6 = new Float32Array(nc); a6.set(qSize); qSize = a6;
    var b = new Int32Array(nc); b.set(qBody); qBody = b;
    var s = new Int32Array(nc * 2); s.set(stack); stack = s;
    qCap = nc;
  }
  function newNode(mx, my, sz) {
    if (qCount >= qCap) grow();
    var i = qCount++;
    qMinX[i] = mx; qMinY[i] = my; qSize[i] = sz;
    qMass[i] = 0; qCx[i] = 0; qCy[i] = 0; qBody[i] = -1;
    var b = i * 4; qChild[b] = -1; qChild[b + 1] = -1; qChild[b + 2] = -1; qChild[b + 3] = -1;
    return i;
  }
  function quad(node, px, py) {
    var half = qSize[node] * 0.5;
    return (px >= qMinX[node] + half ? 1 : 0) + (py >= qMinY[node] + half ? 2 : 0);
  }
  function split(node) {
    var half = qSize[node] * 0.5, mx = qMinX[node], my = qMinY[node];
    for (var q = 0; q < 4; q++) {
      var c = newNode(mx + ((q & 1) ? half : 0), my + ((q & 2) ? half : 0), half);
      qChild[node * 4 + q] = c;
    }
  }
  function insertAt(node, b, depth) {
    for (;;) {
      if (qBody[node] === -2) {
        node = qChild[node * 4 + quad(node, x[b], y[b])]; depth++; continue;
      }
      if (qBody[node] === -1) { qBody[node] = b; return; }
      if (depth >= 22) return;
      var old = qBody[node];
      if (Math.abs(x[old] - x[b]) < 0.0001 && Math.abs(y[old] - y[b]) < 0.0001) {
        x[b] += 0.013 + (b % 7) * 0.011; y[b] += 0.011 + (b % 5) * 0.013;
      }
      split(node); qBody[node] = -2;
      insertAt(node, old, depth + 1);
      node = qChild[node * 4 + quad(node, x[b], y[b])]; depth++;
    }
  }
  function computeMass(node) {
    var b = qBody[node];
    if (b >= 0) { qMass[node] = 1; qCx[node] = x[b]; qCy[node] = y[b]; return; }
    if (b === -1) { qMass[node] = 0; return; }
    var m = 0, cx = 0, cy = 0;
    for (var q = 0; q < 4; q++) {
      var c = qChild[node * 4 + q]; if (c < 0) continue;
      computeMass(c); var cm = qMass[c];
      if (cm > 0) { m += cm; cx += qCx[c] * cm; cy += qCy[c] * cm; }
    }
    qMass[node] = m;
    if (m > 0) { qCx[node] = cx / m; qCy[node] = cy / m; }
    else { qCx[node] = qMinX[node] + qSize[node] * 0.5; qCy[node] = qMinY[node] + qSize[node] * 0.5; }
  }
  function buildTree() {
    if (qCap < n * 8 + 64) alloc(n * 8 + 64);
    qCount = 0;
    var mnx = 1e9, mny = 1e9, mxx = -1e9, mxy = -1e9;
    for (var i = 0; i < n; i++) {
      if (vis[i] === 0) continue;
      if (x[i] < mnx) mnx = x[i]; if (x[i] > mxx) mxx = x[i];
      if (y[i] < mny) mny = y[i]; if (y[i] > mxy) mxy = y[i];
    }
    if (mnx > mxx) { mnx = 0; mny = 0; mxx = W; mxy = H; }
    var sz = Math.max(mxx - mnx, mxy - mny) + 1;
    newNode(mnx, mny, sz);
    for (var j = 0; j < n; j++) if (vis[j] !== 0) insertAt(0, j, 0);
    computeMass(0);
  }

  /* 分类锚点：按画布宽高分别取椭圆半径，铺满视口而不是缩在中心小圆上。
     同时把斥力按规模归一化——这是「节点多了才炸」的根子。 */
  function layoutAnchors() {
    var cx = W * 0.5, cy = H * 0.5, Rx = W * 0.34, Ry = H * 0.32, cc = catCount;
    if (cc > 0) {
      for (var c = 0; c < cc; c++) {
        var a = 2 * Math.PI * c / cc - Math.PI / 2;
        anchorX[c] = cx + Math.cos(a) * Rx; anchorY[c] = cy + Math.sin(a) * Ry;
      }
      for (var i = cc; i < n; i++) {
        var p = parent[i]; if (p < 0 || p >= cc) p = 0;
        anchorX[i] = anchorX[p]; anchorY[i] = anchorY[p];
      }
    } else {
      for (var j = 0; j < n; j++) { anchorX[j] = cx; anchorY[j] = cy; }
    }
    anchorK = cc > 0 ? 0.035 : 0;
    repulseEff = repulse * 36 / Math.max(36, n);
  }

  function initialPos() {
    layoutAnchors();
    var cc = catCount, cx = W * 0.5, cy = H * 0.5;
    for (var c = 0; c < cc; c++) { x[c] = anchorX[c]; y[c] = anchorY[c]; }
    /* 簇半径由相邻分类间距决定，避免簇互相重叠或溢出画布 */
    var cap = Math.max(1, cc);
    var sep = Math.min(W * 0.34, H * 0.32) * 2 * Math.sin(Math.PI / cap);
    var clusterR = Math.max(20, Math.min(sep * 0.50, Math.min(W, H) * 0.24));
    var noCatR = Math.min(W, H) * 0.42;
    var cnt = new Int32Array(cap), idx = new Int32Array(cap);
    for (var q = cc; q < n; q++) { var pp = parent[q]; if (pp < 0 || pp >= cc) pp = 0; cnt[pp]++; }
    for (var i = cc; i < n; i++) {
      var p = parent[i]; if (p < 0 || p >= cc) p = 0;
      var k = idx[p]++, ang = k * GOLD + p * 0.7;
      /* 面积均匀填充：半径 ∝ sqrt(k/簇容量)，节点不会堆在簇心 */
      var rr = cc > 0 ? clusterR * Math.sqrt((k + 0.5) / Math.max(1, cnt[p]))
                      : Math.min((34 + 20 * Math.sqrt(k + 1)), noCatR);
      var ox = cc > 0 ? anchorX[p] : cx, oy = cc > 0 ? anchorY[p] : cy;
      x[i] = ox + Math.cos(ang) * rr; y[i] = oy + Math.sin(ang) * rr;
      /* 初始布点只需防出界，用宽松的双倍 pad（真正的边界交给软回推） */
      x[i] = Math.max(24, Math.min(W - 24, x[i]));
      y[i] = Math.max(24, Math.min(H - 44, y[i]));
    }
  }
  function doLayered() {
    initialPos();
    for (var c = 0; c < catCount; c++) { vx[c] = 0; vy[c] = 0; fixed[c] = 1; }
    for (var i = catCount; i < n; i++) { vx[i] = 0; vy[i] = 0; }
  }
  function step() {
    if (disposed) return;
    timer = null;
    var t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    var i, q, e, a, b, dx, dy, d, d2, f;
    if (mode === 'layered') {
      doLayered(); alpha = 0;
    } else {
      buildTree();
      ax.fill(0); ay.fill(0); sx.fill(0); sy.fill(0); deg.fill(0);
      /* Barnes-Hut 远场近似：每个节点与质心/叶节点交互，O(n log n)。
         力的强度用 repulseEff（已按 36/n 归一化），不再随节点数线性膨胀。 */
      for (i = 0; i < n; i++) {
        if (vis[i] === 0) continue;
        var xi = x[i], yi = y[i], fx = 0, fy = 0, sp = 0;
        stack[sp++] = 0;
        while (sp > 0) {
          var node = stack[--sp], m = qMass[node];
          if (m <= 0) continue;
          var body = qBody[node];
          if (body === i) continue;
          dx = qCx[node] - xi; dy = qCy[node] - yi;
          d2 = dx * dx + dy * dy + 0.01;
          var s = qSize[node];
          if (body >= 0 || s * s < theta * theta * d2) {
            d = Math.sqrt(d2); f = repulseEff * m / d2;
            fx -= dx / d * f; fy -= dy / d * f;
          } else {
            var base = node * 4;
            for (q = 0; q < 4; q++) {
              var c = qChild[base + q];
              if (c >= 0 && qMass[c] > 0 && sp < stack.length) stack[sp++] = c;
            }
          }
        }
        ax[i] = fx; ay[i] = fy;
      }
      /* 弹簧力：边表已预解析为 Int32Array 索引对 */
      var ec = edges.length >> 1;
      for (e = 0; e < ec; e++) {
        a = edges[e * 2]; b = edges[e * 2 + 1];
        if (vis[a] === 0 || vis[b] === 0) continue;
        dx = x[b] - x[a]; dy = y[b] - y[a];
        d = Math.sqrt(dx * dx + dy * dy) || 1;
        f = (d - linkLen) * 0.012;
        sx[a] += dx / d * f; sy[a] += dy / d * f; deg[a]++;
        sx[b] -= dx / d * f; sy[b] -= dy / d * f; deg[b]++;
      }
      var cx = W * 0.5, cy = H * 0.5, pad = 26, bottom = H - 56;
      for (i = 0; i < n; i++) {
        if (vis[i] === 0 || fixed[i] === 1) continue;
        /* 取邻居弹簧力的平均值，而不是 sqrt(deg)：全互链时 deg 可达 690，
           用 sqrt 归一化会让合力 ∝ deg，把所有节点拽向同一个质心 */
        var ds = Math.max(1, deg[i]);
        /* 有分类时把节点按回自己的簇锚点；无分类时用弱向心力 */
        var tx = ax[i] + (anchorK ? (anchorX[i] - x[i]) * anchorK : (cx - x[i]) * 0.0016) + sx[i] / ds;
        var ty = ay[i] + (anchorK ? (anchorY[i] - y[i]) * anchorK : (cy - y[i]) * 0.0016) + sy[i] / ds;
        /* 软边界：越界受弹性回推，而不是硬钳死后钉在边上 */
        if (x[i] < pad) tx += (pad - x[i]) * 0.12; else if (x[i] > W - pad) tx -= (x[i] - (W - pad)) * 0.12;
        if (y[i] < pad) ty += (pad - y[i]) * 0.1; else if (y[i] > bottom) ty -= (y[i] - bottom) * 0.12;
        vx[i] = (vx[i] + tx) * DAMP; vy[i] = (vy[i] + ty) * DAMP;
        x[i] += vx[i] * alpha; y[i] += vy[i] * alpha;
        /* 仅作数值兜底，正常收敛不会触发 */
        x[i] = Math.max(2, Math.min(W - 2, x[i]));
        y[i] = Math.max(2, Math.min(H - 2, y[i]));
      }
      alpha *= 0.94; if (alpha <= 0.018) alpha = 0;
    }
    var t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    var conv = (alpha === 0 || mode === 'layered');
    emit(t1 - t0, conv);
    if (!conv) timer = setTimeout(step, 16);
  }
  function emit(dt, conv) {
    if (!posOut || posOut.length !== n * 2) posOut = new Float32Array(n * 2);
    for (var i = 0; i < n; i++) { posOut[i * 2] = x[i]; posOut[i * 2 + 1] = y[i]; }
    frame++;
    self.postMessage({ type: 'frame', pos: posOut, alpha: alpha, physics: dt, frame: frame, converged: conv, mode: mode, theta: theta });
  }
  function schedule() {
    if (timer === null && !disposed) timer = setTimeout(step, 16);
  }
  function kick() {
    if (mode === 'layered') { step(); return; }
    alpha = Math.max(alpha, 0.55); schedule();
  }
  function handle(m) {
    switch (m.type) {
      case 'ping': self.postMessage({ type: 'pong' }); break;
      case 'init': {
        var i;
        n = m.n; W = m.W; H = m.H;
        /* 参数缺省即兜底：mode 缺失会让 step 走到不存在的分支、坐标直接变 NaN */
        mode = m.mode || 'bh'; theta = m.theta || 0.9; linkLen = m.linkLen || 100;
        catCount = m.catCount; parent = m.parent; edges = m.edges; rad = m.radius;
        x = new Float32Array(n); y = new Float32Array(n);
        vx = new Float32Array(n); vy = new Float32Array(n);
        ax = new Float32Array(n); ay = new Float32Array(n);
        sx = new Float32Array(n); sy = new Float32Array(n); deg = new Int32Array(n);
        anchorX = new Float32Array(n); anchorY = new Float32Array(n);
        fixed = new Uint8Array(n); vis = new Uint8Array(n); vis.fill(1);
        /* 分类节点是骨架锚点，不参与自由碰撞，否则会被斥力推到画布四角 */
        for (var fi = 0; fi < catCount; fi++) fixed[fi] = 1;
        if (m.visible && m.visible.length === n) vis.set(m.visible);
        if (m.pos && m.pos.length === n * 2) {
          for (i = 0; i < n; i++) { x[i] = m.pos[i * 2]; y[i] = m.pos[i * 2 + 1]; }
          layoutAnchors(); alpha = 0;
        } else { initialPos(); alpha = 1; }
        frame = 0; disposed = false;
        if (mode === 'layered') { step(); }
        else if (alpha === 0) { emit(0, true); }
        else schedule();
        break;
      }
      case 'drag': x[m.i] = m.x; y[m.i] = m.y; vx[m.i] = 0; vy[m.i] = 0; fixed[m.i] = 1; kick(); break;
      /* 分类锚点钉死，拖完也不解除固定 */
      case 'unfix': if (m.i >= catCount) { fixed[m.i] = 0; kick(); } break;
      case 'filter': if (m.visible && m.visible.length === n) vis.set(m.visible); emit(0, true); break;
      case 'mode': mode = m.mode; alpha = 1; if (timer !== null) { clearTimeout(timer); timer = null; } step(); break;
      case 'resize': {
        var oldAX, oldAY, dxA, dyA, c2, j2;
        if (anchorX) { oldAX = anchorX.slice(); oldAY = anchorY.slice(); }
        W = m.W; H = m.H; layoutAnchors();
        if (oldAX && catCount > 0) {
          /* 锚点随画布伸缩，子节点整体跟着平移，避免竖屏转横屏时塌到一边 */
          for (c2 = 0; c2 < catCount; c2++) {
            dxA = anchorX[c2] - oldAX[c2]; dyA = anchorY[c2] - oldAY[c2];
            x[c2] = anchorX[c2]; y[c2] = anchorY[c2];
            for (j2 = catCount; j2 < n; j2++) if (parent[j2] === c2) { x[j2] += dxA; y[j2] += dyA; }
          }
        }
        kick(); break;
      }
      case 'reset': {
        if (timer !== null) { clearTimeout(timer); timer = null; }
        fixed.fill(0); for (var r = 0; r < catCount; r++) fixed[r] = 1;
        vx.fill(0); vy.fill(0); initialPos(); alpha = 1; step(); break;
      }
      case 'kick': kick(); break;
      case 'dispose': disposed = true; if (timer !== null) { clearTimeout(timer); timer = null; } break;
    }
  }
  self.onmessage = function (ev) { handle(ev.data); };
})(self);
