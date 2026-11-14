/* 档案 · 技能轨迹（留痕录唯一入口：技能关系图 + 右侧统计栏同屏）
 * 数据：GET /api/learning-trajectory —— 技能目录 + 真实 usage_count + 同分类关系 + 笔记引用。
 * 不自己数文件估算用量：usage_count 是内核记录的真实调用次数，0 就是没用过。
 *
 * 布局照墨档案例的 .graph-page：标题条 + 分类 chips + 工具条在上，画布在左、统计栏在右。
 * 案例的统计数字不是装饰，是右侧 .stat-side 常驻栏——这一版把它做成真实数据联动的。
 * 2026-11-14：从「提示词页的图 + 留痕录页的排行」两处合并到留痕录「技能轨迹」一处，
 * 提示词页不再挂视图页签，只留文档。
 */
window.Archive.register('trajectory', (function () {
  'use strict';

  var A = window.Archive;
  var state = { data: null, at: 0, pending: null };

  function load(st, force) {
    if (state.data && !force && Date.now() - state.at < 60000) return Promise.resolve(state.data);
    if (state.pending) return state.pending;
    state.pending = A.call('/api/learning-trajectory').then(function (data) {
      state.data = data; state.at = Date.now(); state.pending = null;
      return data;
    }).catch(function (err) {
      state.pending = null;
      state.data = { skills: [], relations: [], notes: [], note_edges: [], error: err.message };
      return state.data;
    });
    return state.pending;
  }

  function categoryOf(skill) {
    var cat = String(skill.category || 'other').trim();
    return cat || 'other';
  }
  function shortName(skill) {
    return String(skill.name || skill.id || '').replace(/^@[^/]+\//, '').replace(/\.md$/i, '');
  }

  /* ── 技能轨迹图（案例 graph-page 版式） ── */
  function renderGraph(st, host, api) {
    /* 图谱现在住在留痕录，可它里面的节点是技能（skills 源）和知识笔记（knowledge 源），
       这两类都不在留痕录的资料树里（那棵树只有日记/草稿/报告）。
       直接在原地 openDoc 会打开一份「树里根本找不到」的文档，左侧没有任何高亮。
       所以按来源路由：哪个页面持有这个来源，就去那个页面打开（2026-11-14）。 */
    var go = (function (st2) {
      var theApi = api;
      return function (source, path) {
        var cfg = A.PAGES[st2.page] || {};
        var ownedHere = (cfg.sources || []).indexOf(source) >= 0;
        if (!ownedHere) {
          var page = (source === 'knowledge' || source === 'notes') ? 'kb' : 'assistant';
          var target = A.PAGES[page];
          if (target && (target.sources || []).indexOf(source) >= 0) {
            if (typeof switchPage === 'function') switchPage(page);
            A.mount(page);
            return A.openDoc(A.stateOf(page), source, path);
          }
        }
        return theApi.open(source, path);
      };
    })(st);

    return load(st).then(function (data) {
      var G = A.modules.graph;
      var skills = (data.skills || []).slice();
      var relations = data.relations || [];
      var notes = (data.notes || []).slice();
      var noteEdges = data.note_edges || [];

      var calls = skills.reduce(function (sum, s) { return sum + (s.usage_count || 0); }, 0);
      var used = skills.filter(function (s) { return (s.usage_count || 0) > 0; });
      var cats = {};
      var catCalls = {};
      skills.forEach(function (s) {
        var c = categoryOf(s);
        cats[c] = (cats[c] || 0) + 1;
        catCalls[c] = (catCalls[c] || 0) + (s.usage_count || 0);
      });
      /* 分类顺序固定下来（技能数降序）：chips 色点、图节点、图例、统计栏条全按这一个索引取色。
         不固定的话，同一分类在图里是青色、在统计栏是紫色，看着像两套数据。
         色本身走 A.catColor（案例 DARK_COLORS/LIGHT_COLORS）：创作恒青/靛、分析恒蓝，
         且深浅两套自动翻。 */
      var catOrder = Object.keys(cats).sort(function (a, b) {
        return cats[b] - cats[a] || a.localeCompare(b);
      });
      function colorOfCat(name) {
        return A.catColor(name);
      }

      /* ── 骨架 ── */
      var page = A.el('div', null, 'arc-gpage');

      var top = A.el('div', null, 'arc-gtop');
      var line = A.el('div', null, 'arc-gline');
      var title = A.el('div', null, 'arc-gtitle');
      title.append(
        A.el('span', '技能轨迹'),
        A.el('span', skills.length + ' 技能 · ' + relations.length + ' 关联', 'arc-gbadge')
      );
      line.append(title);
      var desc = A.el('p',
        '节点大小按内核记录的真实调用次数缩放，连线是同分类关联；点节点看详情，右侧统计跟着联动。',
        'arc-gdesc');
      top.append(line, desc);

      /* 分类 chips：点一下就只亮这一类，不重排布局 */
      var chips = A.el('div', null, 'arc-chips');
      var filterCat = '全部';
      var chipAll = A.el('button', null, 'arc-chip on');
      chipAll.type = 'button';
      chipAll.append(A.el('span', '全部'));
      chips.append(chipAll);
      var chipByCat = {};
      catOrder.forEach(function (name) {
        var b = A.el('button', null, 'arc-chip');
        b.type = 'button';
        var dot = A.el('i', null, 'arc-chip-dot');
        dot.style.background = colorOfCat(name);
        b.append(dot, A.el('span', name + ' ' + cats[name]));
        chips.append(b);
        chipByCat[name] = b;
      });

      /* 工具条 */
      var tools = A.el('div', null, 'arc-gtools');
      var seg = A.el('div', null, 'arc-seg');
      var segBh = A.el('button', '力导向', 'on');
      var segLay = A.el('button', '分层');
      segBh.type = 'button'; segLay.type = 'button';
      segBh.dataset.mode = 'bh'; segLay.dataset.mode = 'layered';
      seg.append(segBh, segLay);

      var resetBtn = A.el('button', null, 'arc-btn is-quiet');
      resetBtn.type = 'button';
      resetBtn.append(A.svgIcon('refresh', 14), A.el('span', '重排', 'arc-label'));
      resetBtn.title = '按当前数据重新布局';

      var usedBtn = A.el('button', '只看用过的', 'arc-chip');
      usedBtn.type = 'button';

      /* 笔记节点默认不上图：385 个技能本来就密，再加 94 个笔记节点就是毛球。
         笔记引用在右侧统计栏有列表，需要看连线时再打开这个开关。 */
      var noteBtn = A.el('button', '笔记', 'arc-chip');
      noteBtn.type = 'button';
      noteBtn.title = '把提到技能的笔记也画进图里';

      var sideBtn = A.el('button', null, 'arc-btn is-quiet');
      sideBtn.type = 'button';
      sideBtn.append(A.svgIcon('tree', 14), A.el('span', '统计', 'arc-label'));
      sideBtn.title = '显示/隐藏统计栏';

      tools.append(seg, resetBtn, usedBtn, noteBtn, sideBtn);
      top.append(chips, tools);

      var main = A.el('div', null, 'arc-gmain');
      var canvasBox = A.el('div', null, 'arc-gmain-canvas');
      var side = A.el('aside', null, 'arc-stat-side');
      main.append(canvasBox, side);
      page.append(top, main);
      host.append(page);

      /* ── 状态 ── */
      var handle = null;
      var onlyUsed = false;
      var withNotes = false;
      var term = '';
      var picked = null;

      if (!skills.length) {
        canvasBox.append(A.el('p', '还没读到技能目录。' + (data.error ? '（' + data.error + '）' : ''), 'arc-empty'));
        return;
      }

      /* ── 数据 → 图 ── */
      function build() {
        var visible = skills.filter(function (s) {
          if (onlyUsed && !(s.usage_count > 0)) return false;
          if (term && shortName(s).toLowerCase().indexOf(term) < 0 && String(s.id).toLowerCase().indexOf(term) < 0) return false;
          return true;
        });
        var allow = {};
        visible.forEach(function (s) { allow[s.id] = true; });

        var nodes = visible.map(function (s) {
          return {
            id: 'skill:' + s.id, label: shortName(s), group: categoryOf(s),
            size: 1 + Math.min(1.8, Math.log2((s.usage_count || 0) + 2) / 3),
            tip: categoryOf(s) + ' · 调用 ' + (s.usage_count || 0) + ' 次' + (s.description ? ' · ' + String(s.description).slice(0, 40) : '')
          };
        });
        var edges = relations.filter(function (edge) {
          return allow[edge.from] && allow[edge.to];
        }).map(function (edge) { return { from: 'skill:' + edge.from, to: 'skill:' + edge.to }; });

        /* 笔记节点只在没筛选、且手动打开时才挂上去 */
        if (withNotes && !onlyUsed && !term) {
          var noteAllow = {};
          notes.forEach(function (note) {
            noteAllow[note.path] = true;
            nodes.push({
              id: 'note:' + note.path,
              label: String(note.title || note.path).replace(/\.md$/, ''),
              group: '笔记引用', size: 0.7,
              tip: note.path + ' · 被 ' + (note.links || 0) + ' 个技能提到'
            });
          });
          noteEdges.forEach(function (edge) {
            if (allow[edge.from] && noteAllow[edge.to]) {
              edges.push({ from: 'skill:' + edge.from, to: 'note:' + edge.to });
            }
          });
        }
        return { nodes: nodes, edges: edges };
      }

      function mount() {
        var built = build();
        if (handle) { try { handle(); } catch (_) {} handle = null; }
        canvasBox.replaceChildren();
        if (!built.nodes.length) { canvasBox.append(A.el('p', '没有匹配的技能。', 'arc-empty')); renderSide(); return; }
        var colors = {};
        built.nodes.forEach(function (n) { colors[n.group] = colorOfCat(n.group); });
        handle = G.mountForce(canvasBox, {
          nodes: built.nodes,
          edges: built.edges,
          noBar: true,
          state: st.skillView || (st.skillView = { scale: 1, tx: 0, ty: 0, mode: 'bh', pos: null }),
          groupColor: function (g) { return colors[g] || colorOfCat(g); },
          filterGroup: filterCat,
          onSelect: function (node) {
            picked = node || null;
            renderSide();
          }
        });
        st.skillDispose = handle;
        if (handle && handle.setMode && st.skillView && st.skillView.mode === 'layered') {
          handle.setMode('layered');
          syncMode('layered');
        } else {
          syncMode('bh');
        }
        renderSide();
      }

      /* 分类只是淡化非本组节点 → 不重排，直接 setFilter；只有节点集合变了才重挂 */
      function setCat(name) {
        filterCat = name || '全部';
        chipAll.classList.toggle('on', filterCat === '全部');
        Object.keys(chipByCat).forEach(function (k) {
          chipByCat[k].classList.toggle('on', k === filterCat);
        });
        if (handle && handle.setFilter) handle.setFilter(filterCat);
        renderSide();
      }
      function syncMode(mode) {
        segBh.classList.toggle('on', mode !== 'layered');
        segLay.classList.toggle('on', mode === 'layered');
      }

      chipAll.onclick = function () { setCat('全部'); };
      catOrder.forEach(function (name) {
        chipByCat[name].onclick = function () { setCat(filterCat === name ? '全部' : name); };
      });
      segBh.onclick = function () { if (handle) handle.setMode('bh'); syncMode('bh'); };
      segLay.onclick = function () { if (handle) handle.setMode('layered'); syncMode('layered'); };
      resetBtn.onclick = function () { if (handle) handle.reset(); };
      usedBtn.onclick = function () {
        onlyUsed = !onlyUsed;
        usedBtn.classList.toggle('on', onlyUsed);
        mount();
      };
      noteBtn.onclick = function () {
        withNotes = !withNotes;
        noteBtn.classList.toggle('on', withNotes);
        mount();
      };
      /* 桌面：统计栏常驻，按钮收起/展开，画布跟着变宽；
         手机：统计栏是底部抽屉，按钮开合。两条路都让画布重算尺寸（ResizeObserver 兜底）。 */
      function isMobile() { return window.matchMedia('(max-width: 900px)').matches; }
      /* 桌面用 .is-off 收起（不用 hidden：桌面收起来后把窗口缩到手机宽度，
         hidden 会把底部抽屉一起锁死，按钮点了没反应）。手机用 .open 开合。 */
      sideBtn.onclick = function () {
        if (isMobile()) {
          var open = side.classList.toggle('open');
          sideBtn.classList.toggle('on', open);
        } else {
          var off = side.classList.toggle('is-off');
          sideBtn.classList.toggle('on', !off);
        }
      };
      if (!isMobile()) sideBtn.classList.add('on');
      /* 视口跨过 900px 时把两套状态清干净：回到桌面就恢复常驻栏，回到手机就收起抽屉 */
      var mq = window.matchMedia('(max-width: 900px)');
      function onMq() {
        side.classList.remove('open');
        side.classList.remove('is-off');
        sideBtn.classList.remove('on');
        if (!mq.matches) sideBtn.classList.add('on');
      }
      if (mq.addEventListener) mq.addEventListener('change', onMq);
      else if (mq.addListener) mq.addListener(onMq);

      /* ── 右侧统计栏（真实数据） ── */
      function renderSide() {
        side.replaceChildren();

        var usedPct = skills.length ? Math.round(used.length / skills.length * 100) : 0;
        side.append(A.el('div', '使用总览', 'arc-h'));
        var callRow = A.el('div', null, 'arc-bignum');
        callRow.append(A.el('b', String(calls)), A.el('span', '累计调用'));
        side.append(callRow);
        [
          ['已登记技能', String(skills.length)],
          ['有调用记录', used.length + ' · ' + usedPct + '%'],
          ['未用过', String(skills.length - used.length)],
          ['关联边', String(relations.length)]
        ].forEach(function (pair) {
          var row = A.el('div', null, 'arc-detail-line');
          row.append(A.el('span', pair[0]), A.el('b', pair[1]));
          side.append(row);
        });

        side.append(A.el('div', '分类分布', 'arc-h'));
        var bars = A.el('div', null, 'arc-bars');
        catOrder.forEach(function (name) {
          var row = A.el('div', null, 'arc-bar-row');
          var topRow = A.el('div', null, 'arc-bar-top');
          topRow.append(
            A.el('span', name + ' · ' + cats[name]),
            A.el('span', catCalls[name] ? catCalls[name] + ' 次' : '—')
          );
          var bg = A.el('div', null, 'arc-bar-bg');
          var fill = A.el('div', null, 'arc-bar-fill');
          fill.style.width = Math.max(2, Math.round(cats[name] / skills.length * 100)) + '%';
          fill.style.background = colorOfCat(name);
          bg.append(fill);
          row.append(topRow, bg);
          if (filterCat === name) row.classList.add('on');
          row.title = '只看「' + name + '」';
          row.onclick = function () { setCat(filterCat === name ? '全部' : name); };
          bars.append(row);
        });
        side.append(bars);

        side.append(A.el('div', '调用最多', 'arc-h'));
        skills.slice().sort(function (a, b) { return (b.usage_count || 0) - (a.usage_count || 0); })
          .slice(0, 6).forEach(function (skill) {
            var item = A.el('div', null, 'arc-top-item');
            var nm = A.el('b', shortName(skill));
            nm.title = skill.id + ' · ' + categoryOf(skill);
            item.append(nm, A.el('span', String(skill.usage_count || 0)));
            item.onclick = function () { go('skills', skill.id + '/SKILL.md'); };
            side.append(item);
          });
        if (!used.length) side.append(A.el('p', '所有技能调用次数都是 0——统计来自内核记录，不是没读到。', 'arc-dim'));

        side.append(A.el('div', '节点详情', 'arc-h'));
        if (!picked) {
          side.append(A.el('p', '点图上任意节点，这里显示它的真实调用和关联。', 'arc-dim'));
        } else {
          var isSkill = picked.id.indexOf('skill:') === 0;
          var rawId = picked.id.slice(picked.id.indexOf(':') + 1);
          side.append(A.el('div', picked.label, 'arc-detail-name'));
          var badge = A.el('span', isSkill ? categoryOf2(rawId) : '笔记引用', 'arc-pill');
          badge.style.background = colorOfCat(isSkill ? categoryOf2(rawId) : '笔记引用');
          /* 深色分类色是亮青/亮紫系，配深字看得清；浅色是靛蓝/暗橙系，得配白字 */
          badge.style.color = A.isLight() ? '#ffffff' : '#0b1220';
          badge.style.borderColor = 'transparent';
          side.append(badge);
          if (isSkill) {
            var s = byId(rawId);
            var d1 = A.el('div', null, 'arc-detail-line');
            d1.append(A.el('span', '调用次数'), A.el('b', String((s && s.usage_count) || 0)));
            side.append(d1);
            if (s && s.description) side.append(A.el('p', String(s.description), 'arc-detail-desc'));
            var rel = relations.filter(function (e) { return e.from === rawId || e.to === rawId; });
            if (rel.length) {
              side.append(A.el('div', '关联技能', 'arc-h'));
              rel.slice(0, 8).forEach(function (e) {
                var other = e.from === rawId ? e.to : e.from;
                var o = byId(other);
                var it = A.el('div', null, 'arc-top-item');
                it.append(A.el('b', o ? shortName(o) : other), A.el('span', String((o && o.usage_count) || 0)));
                it.onclick = function () { if (o) go('skills', o.id + '/SKILL.md'); };
                side.append(it);
              });
            }
          } else {
            var dn = null;
            notes.forEach(function (n) { if (n.path === rawId) dn = n; });
            var d2 = A.el('div', null, 'arc-detail-line');
            d2.append(A.el('span', '被技能提到'), A.el('b', String((dn && dn.links) || 0) + ' 处'));
            side.append(d2, A.el('p', rawId, 'arc-detail-desc'));
          }
          var openBtn = A.el('button', null, 'arc-btn is-primary');
          openBtn.type = 'button';
          openBtn.append(A.svgIcon('file', 14), A.el('span', '打开'));
          openBtn.style.marginTop = '10px';
          openBtn.onclick = function () {
            if (isSkill) go('skills', rawId + '/SKILL.md');
            else go('knowledge', rawId);
          };
          side.append(openBtn);
        }

        if (notes.length) {
          side.append(A.el('div', '被技能提到的笔记', 'arc-h'));
          notes.slice(0, 5).forEach(function (note) {
            var it = A.el('div', null, 'arc-top-item');
            var b = A.el('b', String(note.title || note.path).replace(/\.md$/, ''));
            b.title = note.path;
            it.append(b, A.el('span', (note.links || 0) + ' 处'));
            it.onclick = function () { go('knowledge', note.path); };
            side.append(it);
          });
        }
      }

      var byIdMap = null;
      function byId(id) {
        if (!byIdMap) {
          byIdMap = {};
          skills.forEach(function (s) { byIdMap[s.id] = s; });
        }
        return byIdMap[id];
      }
      function categoryOf2(id) {
        var s = byId(id);
        return s ? categoryOf(s) : 'other';
      }

      mount();
    });
  }

  /* 留痕录的「技能轨迹」就是上面这套「画布 + 统计栏」，不再另开一套排行页：
     同一份 usage_count 画两遍，样式改一处漏一处（2026-11-14 用户要求合并到技能轨迹）。 */
  return {
    render: renderGraph,
    unmount: function (st) {
      if (st && st.skillDispose) {
        try { st.skillDispose(); } catch (_) {}
        st.skillDispose = null;
      }
    }
  };
})());
