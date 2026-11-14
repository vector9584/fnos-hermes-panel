/* dom.js — 唯一 DOM 与转义层（2026-11-13）
 *
 * 为什么要有这层：改造前全站有 6 套转义实现（utils.esc / utils.escapeHtml /
 * fusion.esc30 / panel-clarify.esc / panel-slash.esc / panel-tree.esc），
 * 语义还不一致——有的转引号有的不转。同一个字符串走不同路径能渲染出不同结果，
 * 这类不一致是最难查的 XSS 和显示错误来源。
 *
 * 这里的三个函数语义固定、互不重叠，其它地方一律委托过来，不许再自建：
 *   DOM.esc(s)        & < >            —— 正文用（279 处老调用点，语义必须保持）
 *   DOM.escAttr(s)    & < > " '        —— 属性值和双引号属性用（原 escapeHtml）
 *   DOM.escDouble(s)  & < > "          —— 只转双引号（原 fusion.esc30）
 *
 * 注意：esc() 刻意不转引号。msgHTML 里有一批
 *   esc(text).replace(/'/g, "\\'")
 * 要先生成 JS 字面量再塞进内联 onclick；如果 esc 顺手把 ' 转成 &#39;，
 * 那个 replace 就再也匹配不到，点击事件里的引号会直接漏出去导致语法错误。
 * 想加转义请显式调 escAttr，不要动 esc。
 *
 * 另外提供 h() 建元素——新代码用它，别再拼 innerHTML 字符串：
 *   h('button', {class:'btn primary', onclick:fn}, '保存')
 */
(function () {
  'use strict';

  var ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function rep(s, chars) {
    return String(s == null ? '' : s).replace(chars, function (c) { return ENT[c]; });
  }

  /* 正文转义：只处理结构性字符，不动引号（见文件头说明） */
  function esc(s) {
    return rep(s, /[&<>]/g);
  }

  /* 属性转义：五个字符全转，可安全放进 "..." 或 '...' */
  function escAttr(s) {
    return rep(s, /[&<>"']/g);
  }

  /* 只转双引号：兼容 fusion.esc30 的历史语义 */
  function escDouble(s) {
    return rep(s, /[&<>"]/g);
  }

  /* 建元素：h(tag, attrs, ...children)
   * attrs 支持 class/className、style 字符串、dataset 对象、on* 事件函数、
   * 其余走 setAttribute。children 支持字符串（转成文本节点，不解析 HTML）
   * 和节点/节点数组。字符串也可以传 html:'...' 显式声明要插入 HTML。 */
  function h(tag, attrs) {
    var n = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class' || k === 'className') { n.className = v; return; }
      if (k === 'style') { n.style.cssText = v; return; }
      if (k === 'dataset') { Object.keys(v).forEach(function (d) { n.dataset[d] = v[d]; }); return; }
      if (k === 'html') { n.innerHTML = v; return; }
      if (k.slice(0, 2) === 'on' && typeof v === 'function') {
        n.addEventListener(k.slice(2).toLowerCase(), v);
        return;
      }
      if (k === 'text') { n.textContent = v; return; }
      if (v === true) { n.setAttribute(k, ''); return; }
      n.setAttribute(k, v);
    });
    for (var i = 2; i < arguments.length; i++) {
      append(n, arguments[i]);
    }
    return n;
  }

  function append(host, child) {
    if (child == null || child === false) return;
    if (Array.isArray(child)) { child.forEach(function (c) { append(host, c); }); return; }
    if (child.nodeType === 1 || child.nodeType === 3) { host.appendChild(child); return; }
    host.appendChild(document.createTextNode(String(child)));
  }

  window.DOM = { esc: esc, escAttr: escAttr, escDouble: escDouble, h: h, append: append };
})();
