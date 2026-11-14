/*! panel-tree.js — 树目录展开/折叠统一模板（2026-11-11）
 *
 * 唯一入口：PwTree.node({...}) 生成节点，点击由 document 级委托处理，不用写 inline onclick。
 * 配套样式 css/panel-tree.css。文件夹组、通道会话组已接入；后面新增树目录直接复用。
 *
 *   PwTree.node({
 *     key:'folder:'+id,     // 必填，状态记忆的键名（localStorage pw_tree:<key>）
 *     label:'名称',          // 必填
 *     icon:'📁',             // 可选
 *     meta:'12 个',          // 可选，行尾灰色小字
 *     acts:'<button…>',     // 可选，行尾操作按钮（点它们不会触发展开）
 *     body:'<…>',           // 可选，子级 HTML
 *     def:true              // 可选，无记忆时的默认开合，默认 true
 *   })
 */
(function () {
  var PREFIX = 'pw_tree:';

  function store(k, v) {
    try { if (v === undefined) return localStorage.getItem(PREFIX + k); localStorage.setItem(PREFIX + k, v); } catch (e) {}
    return null;
  }
  function isOpen(k, def) { var v = store(k); return v === null ? def !== false : v === '1'; }
  function save(k, o) { store(k, o ? '1' : '0'); }

  function esc(s) { return DOM.escAttr(s); }  /* 唯一实现在 core/dom.js */
  function chev() {
    return '<svg class="pw-tree-chev" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><polyline points="9 5 16 12 9 19"/></svg>';
  }
  function nodeId(key) { return 'pw-tree-' + String(key).replace(/[^A-Za-z0-9_-]/g, '_'); }

  function node(o) {
    o = o || {};
    var key = String(o.key || '');
    var open = o.open === undefined ? isOpen(key, o.def) : !!o.open;
    var id = nodeId(key);
    return '<div class="pw-tree-node' + (open ? ' is-open' : '') + '" data-tree-key="' + DOM.escAttr(key) + '"' + (o.depth === undefined ? '' : ' data-depth="' + Number(o.depth) + '"') + '>' +
      '<div class="pw-tree-head">' +
        '<button type="button" class="pw-tree-toggle" aria-expanded="' + (open ? 'true' : 'false') + '" aria-controls="' + id + '">' +
          chev() +
          (o.icon ? '<span class="pw-tree-ico">' + o.icon + '</span>' : '') +
          '<span class="pw-tree-label">' + esc(o.label) + '</span>' +
          (o.meta ? '<span class="pw-tree-meta">' + esc(o.meta) + '</span>' : '') +
        '</button>' +
        (o.acts ? '<span class="pw-tree-acts">' + o.acts + '</span>' : '') +
      '</div>' +
      '<div class="pw-tree-body" id="' + id + '"><div class="pw-tree-inner"><div class="pw-tree-kids">' + (o.body || '') + '</div></div></div>' +
    '</div>';
  }

  function toggle(btn) {
    if (!btn || !btn.getAttribute) return;
    var head = btn.closest && btn.closest('.pw-tree-head');
    var nodeEl = head && head.parentNode;
    if (!nodeEl) return;
    var open = btn.getAttribute('aria-expanded') !== 'true';
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');   // 只切属性，绝不动 textContent
    nodeEl.classList.toggle('is-open', open);
    var key = nodeEl.getAttribute('data-tree-key');
    if (key) save(key, open);
    return open;
  }

  /* 单一委托：整行除了行尾操作区都能开合 */
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('.pw-tree-acts')) return;
    var btn = t.closest('.pw-tree-toggle');
    if (btn) toggle(btn);
  }, false);

  window.PwTree = { node: node, toggle: toggle, isOpen: isOpen, save: save, chev: chev, esc: esc, nodeId: nodeId };
})();
