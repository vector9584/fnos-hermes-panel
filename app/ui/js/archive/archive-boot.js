/* 档案 · 启动挂载
 * 放在 archive-*.js 之后、panel-library-reviews-ui.js 之前同步执行：
 * 先把三个页面的骨架搭好，后面那个文件才能把「整理草稿」按钮挂进新页头。
 * 不做 DOMContentLoaded 等待——这些脚本本来就在 </body> 前，页面节点已经存在。 */
(function () {
  'use strict';
  if (!window.Archive || !window.Archive.boot) return;
  window.Archive.boot();
})();
