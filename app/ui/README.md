# 面板前端结构索引

改一个东西该看哪个文件，看这一页就够了。不用再翻 index.html。

> 2026-11-13 重组：index.html 从 658KB 降到 71KB。原来 470KB 主逻辑是一个内联 `<script>` 块（557 个函数），
> 现在按原分区搬到 `js/core/`、`js/chat/`、`js/panels/`，**源码逐字节等价**，不是重写。
> 验证：全局符号 638 个函数 + 314 个对象零差异；禁动画后 1440×1000 与 390×844 截图差异 **0 像素**。

## 目录

```
ui/
├── index.html          71KB，只剩静态 HTML 骨架 + 资源清单（不再有业务逻辑）
├── css/
│   ├── base.css        ★ 主样式表 1076 条规则（原 index.html 第 17 行的 134KB 内联 <style>）
│   ├── ui-kit.css      组件层样式（配合 js/core/ui-kit.js）
│   └── panel-*.css     各面板自己的样式，按名字对号入座
└── js/
    ├── core/           基础设施。别的层都依赖它，它不依赖任何业务代码
    ├── chat/           对话相关（标签页、输入、消息、圆桌、新建弹窗）
    ├── panels/         各个面板页
    └── panel-*.js      历史遗留的散布模块（38 个，见文末）
```

## 我要改 X，看哪个文件

| 想改的东西 | 文件 |
|---|---|
| 全局配色、字体、暗亮主题变量 | `css/base.css`（变量在最上面） |
| 弹窗外观 | `css/ui-kit.css` + `js/core/ui-kit.js` |
| toast 提示 | `js/core/ui-kit.js` 的 `toast`（`js/core/utils.js` 里的老实现已被它覆盖） |
| 消息气泡长什么样 | `js/chat/tabs.js`（`msgHTML`） |
| 流式输出打字效果 | `js/chat/tabs.js`（节流渲染） |
| 输入框、发送、斜杠命令 | `js/chat/compose.js` |
| 左侧会话树（Rail） | `js/chat/tabs.js` 开头 |
| 浏览器式多会话标签 | `js/chat/tabs.js` |
| 消息上的语音播放/引用/Fork | `js/chat/message-ops.js` |
| 新建会话弹窗 | `js/chat/new-dialog.js` |
| 多 Agent 圆桌 | `js/chat/roundtable.js` |
| 终端（PTY、ANSI） | `js/panels/terminal.js` |
| 概览页 | `js/panels/overview.js` |
| 模型 / Provider 切换 | `js/panels/models.js` |
| 扩展（技能/MCP/插件） | `js/panels/extensions.js` |
| 定时任务 | `js/panels/cron.js` |
| 记忆页 | `js/panels/memory.js` |
| Token 与用量统计 | `js/panels/usage.js` |
| 学习轨迹 | `js/panels/learning.js` |
| 通讯 / 渠道 | `js/panels/channels.js` |
| 隧道（外网访问） | `js/panels/tunnel.js` |
| 工作区 / 文件管理器 | `js/panels/workspace.js` |
| Markdown 渲染规则 | `js/core/markdown.js` |
| 前端路由 / 页面切换 | `js/core/router.js` |
| 主题切换逻辑 | `js/core/theme.js` |
| API 请求封装、401 兜底 | `js/core/api.js` |
| 全局初始化、飞牛桌面保活 | `js/core/init.js` |
| 启动就绪蒙版 | `js/core/boot-mask.js` |
| Mini Popup | `js/core/mini-popup.js` |
| 基础工具（`$` `$$` `esc` `uid`） | `js/core/utils.js` |

## 加载顺序（不能乱）

```
1. scripts/*.min.js        第三方（marked / purify / qrcode）
2. js/panel-tree.js        会话树基础（很早，别动）
3. js/core/data.js         静态数据、渠道图标
4. js/core/state.js        运行时状态
5. js/core/utils.js        $ / $$ / esc / uid / 老 toast
6. js/core/ui-kit.js       ★ 组件层，必须在这之后、业务之前
7. js/core/api.js          API 封装
8. js/core/markdown.js     Markdown
9. js/chat/*.js            对话层
10. js/panels/*.js         面板层
11. js/core/mini-popup.js
12. js/core/router.js
13. js/core/theme.js
14. js/core/init.js        初始化（要能看到上面全部）
15. js/core/boot-mask.js   启动蒙版（IIFE，最后收尾）
16. js/panel-*.js          历史散布模块
```

**为什么 `ui-kit.js` 必须在第 6 位**：它只依赖 DOM 和 CSS，不依赖业务。
放最后的话，初始化阶段（`init.js`）看不到 `window.ui`，组件层等于白建——这就是 2026-11-13 之前的状态。

**为什么不能再往前挪到 `utils.js` 之前**：`ui-kit.js` 会覆盖 `window.toast`。
`utils.js` 里是老版本，`ui-kit` 在后覆盖成新版本。反过来顺序，老版本会赢，视觉退回硬编码样式。

## 公共组件层怎么用

`js/core/ui-kit.js` 挂在 `window.ui` 上，只用面板已有的 CSS 类，不另造视觉。

```js
// 弹窗：返回句柄，onClose 可选
ui.modal({
  title: '标题',
  body: '内容',            // 字符串走 textContent；要富文本传 html: '<b>…</b>'
  actions: [
    { label: '取消', onClick: (h) => h.close() },
    { label: '确定', primary: true, onClick: (h) => { …; h.close(); } }
  ],
  onClose: () => {}
});

// 确认框：Promise<boolean>，不要再用原生 confirm
if (await ui.confirm('确定删除？', { danger: true })) { … }

// 提示：不要再用原生 alert
ui.toast('已保存');
ui.toast('失败了', { type: 'error' });

// 表单字段
ui.field({ label: '名称', value: '', placeholder: '…' });

// 表格
ui.table({ columns: [{ key:'a', title:'列A' }], rows: [...] });
```

**新写面板一律用 `ui.*`，不要手拼 `<div class="modal-…">` 字符串，不要用原生 `confirm()` / `alert()`。**

现状（2026-11-13 仍需收敛）：原生 `confirm()` 23 处、`alert()` 5 处，分布在 14 个 `panel-*-ui.js`。
`ui.*` 已被调用 29 次，但这 23+5 处还没换——换的时候注意 `confirm()` 是同步阻塞，`await ui.confirm()` 是异步，
所在函数必须加 `async`。

## 三个必踩的坑

**1. `<base href="/app/hermes-agent/">`（index.html 第 4 行）**
所有相对路径都基于它。用 `file://` 打开页面时 `css/x.css` 会解析成 `file:///app/hermes-agent/css/x.css` → 404，
页面只剩内联样式，看起来"零差异"其实是两个空壳。**本地验证必须走 http，或把 base 改成 `./`。**

**2. `?v=` 缓存后缀**
改完 CSS 或 JS 必须同步改 `?v=`（用文件 md5 前 8 位），否则浏览器用缓存旧版，改动等于没做。
`css/base.css?v=fee870ae`、`js/core/ui-kit.js?v=…`，一个都不能漏。

**3. 不要用 `open(p,"w").write(长表达式)` 覆盖文件**
Python 先截断文件再求值，右侧一抛异常文件就永久变空。先算进变量，再写。

## 新增一个面板的标准动作

1. 逻辑写进 `js/panels/<名字>.js`，用全局函数（本层不用模块化，靠加载顺序）
2. 结构用 `ui.*` 造，不要手拼模态框
3. 样式写进 `css/panel-<名字>.css`，颜色走 `var(--token)`，不写死 hex
4. 在 `index.html` 的 `js/panels/` 段末尾加 `<script src="js/panels/<名字>.js?v=<md5前8位>"></script>`
5. 同步源码仓 `data/workspace/fnos-hermes-agent-src/ui/`，两边必须逐字节一致

## 历史遗留：`js/panel-*.js`（38 个）

这批是 2026-11 之前陆续加的独立模块，没有被并入三层结构。功能都在用，但职责重叠：
`panel-models-ui.js`(42KB) 与 `js/panels/models.js`(5KB)、`panel-workspace-ui.js`(66KB) 与 `js/panels/workspace.js`(6KB)
是同一个面板的两半——前者的 UI 细节，后者的基础。

**动这些面板时两个文件都要看。** 后续可以合并，但那是行为改动，得单独做并逐项验。

## 验证工具

- `data/scripts/css_dedupe.py --audit '.选择器'` → 这个选择器在几处定义、哪处生效
- `data/scripts/css_equiv_check.py` → 新旧目录全量计算样式 + 像素对比（自带假绿防护）
- 全局符号对比：打开新旧两版，比对 `Object.keys(window)` 里的函数/对象集合，零差异才算等价