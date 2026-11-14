# 前端架构规矩（唯一真源）

> 这份文档不是介绍，是**判据**。改代码前先对号入座；不合规的地方 `python3 dev/arch_lint.py` 会报出来。
> 最后一次校准：2026-11-13，数字全部由 `arch_lint.py` 在真机 UI 目录跑出。

---

## 零、三层地图（先看这里）

> 这一节回答「要改东西，该动哪个文件」。底下的一到九节是规矩、债和历史，
> 改完代码再回来对。

### 0.1 三个问句 → 三个答案

| 你要做的事 | 去读哪一节 | 直接去哪改 |
|---|---|---|
| 改某个板块的功能（对话/协作/任务/资料/能力/模型/维护） | §1 业务架构 | 表里的「属主文件」 |
| 统一卡片/按钮/风格，加新页面 | §2 样式架构 | `css/components.css` ＋ token |
| 改对话气泡、工具调用、流式状态、会话切换 | §0.5 功能架构 ＋ §9 收敛史 | `js/chat/*.js` |
| 改完确认没破坏规矩 | §4 门禁 | `python3 dev/arch_lint.py` |

**一句话版本**：业务看 §1 的表，样式只动 components.css，对话只动 js/chat/。

---

### 0.2 业务架构：八个板块 → 22 个页面 → 属主文件

> 数字以 `js/panel-navigation.js` 的 `groups` 数组为准（2026-11-13 复核：
> 8 组 22 页，与下表 22 行一致）。此前这里写 21，是没有把「资料」板块的
> `assistant` 助手页算进去。

> DOM 里有 25 个 `#page-*` 容器，可导航页面 22 个，其余 3 个是**非导航容器**（见下表）。
> 2026-11-13 之前 `plans` 由 `panel-plans-ui.js` 运行时 `createElement` 造出来，现已改成静态容器。
> **现在没有任何页面是 JS 注入的。**

**为什么本表只用锚点、不用行号（2026-11-13 改）**

行号是快照。`index.html` 上边插十行，整张表全部指向错的地方，而且**失效时不报错**——
表格照样渲染，只是你按它去改会改错文件。所以定位一律用：

| 锚点 | 稳定性 | 怎么用 |
|---|---|---|
| 容器锚点 `#page-<id>` | 与导航 hash 一一对应，永不漂 | 改页面先 `grep -n 'id="page-cron"' index.html` 现查 |
| 主挂载点 `#cronJobList` | 被 JS 引用最多的那个内部 id | 改渲染就改引用它的文件 |
| 属主文件 | 扫 `getElementById`/`querySelector('#x')` 反查 | 见「属主文件」列 |
| 改了不生效 | 该文件里被后面文件覆盖掉的符号 | **改这里不会生效**，见 §0.3 覆盖链 |

**容器三条规矩（2026-11-13 立，2026-11-13 修）**

1. **一个页面只能有一个「内容主体」，但可以有多层补丁**。原始那条写的是「一个容器只能有一个属主」，
   与事实相反：`chat` 页实际有 19 个属主文件。真规矩是——主体只有一个，其余必须是**登记在案的
   补丁层**，且补丁层自身不得再被覆盖（见 §0.3）。属主清单以业务表的「属主文件」列为准。
2. **可导航页面必须静态在 `index.html`**，JS 只负责填 `.page-body` 与 `.page-header` 的内容，
   不许 `createElement` 造页面容器。理由：静态容器才有稳定的 `#page-<id>` 锚点，才符合
   「改页面先看 index.html」。门禁 C8 拦反方向（导航声明了但 index 里没有容器）。
3. **非导航容器必须登记**（下表），写清它被搬到哪、由谁搬。没登记的容器等于黑洞。

**非导航容器登记表**（锚点定位，不记行号）

| 容器 | 真实状态 | 搬运方 |
|---|---|---|
| `#page-connectors` | **活的**，整块搬进 `#page-comm` 的 `.page-body` 当嵌入块 | `fusion-v030.js` 的 `commFusionMount()` |
| `#page-learning` | **活的**，`.page-body` 子节点被搬进 kb 页的轨迹视图 | `panel-library-ui.js` 的 `mount()` |
| `#page-tunnel` | **功能存活，入口被关**：3 个后端路由仍在（`/api/tunnel/status`、`/api/tunnel/start`、`/api/tunnel/stop`），`fusion-v030.js` 只做 `display:none` ＋ 导航跳转 comm | 未定（待决策：恢复入口或整体下线） |

导航分组定义在 `js/panel-navigation.js` 顶部 `groups` 数组（这是唯一的板块真源，
页签顺序、图标、默认落地页都由它决定）。**加一个页面 = 在那数组里加一条 ＋
建 `#page-<id>` 容器 ＋ 一个属主 js。**

<!-- AUTO:业务表 -->
| 板块 | 页面 | hash | 容器锚点 | 主挂载点 | 属主文件 | 改了不生效（被覆盖的符号） | 主要接口 |
|---|---|---|---|---|---|---|---|
| 对话 | 会话 | `#/chat` | `#page-chat` | `#chatBody` | `chat/compose.js` `chat/message-ops.js` `chat/new-dialog.js` `chat/roundtable.js` `chat/tabs.js` `core/init.js` `core/mini-popup.js` `core/router.js` `fusion-v030.js` `panel-clarify.js` `panel-connectors-ui.js` `panel-durable.js` `panel-files-ui.js` `panel-slash.js` `panel-workspace-ui.js` `panels/extensions.js` `panels/models.js` `panels/terminal.js` `panels/workspace.js` | `chat/compose.js`(chatStop/injectExpertSystem)<br>`chat/message-ops.js`(_voiceStreamOpen/openVoiceSettings)<br>`chat/new-dialog.js`(toggleRail)<br>`chat/roundtable.js`(openRoundtable)<br>`chat/tabs.js`(filterRail/loadSessionMessages)<br>`core/init.js`(connectRoomStream/loadRoomsList)<br>`core/mini-popup.js`(_setSessionModel/handleSlashCommand)<br>`core/router.js`(switchPage)<br>`fusion-v030.js`(chatSenderName/openChannelModal)<br>`panel-workspace-ui.js`(openBuiltinExpertEditor/pwRoom)<br>`panels/extensions.js`(BUILTIN_EXPERTS_ARR/_allBuiltinExperts)<br>`panels/models.js`(__hermesConfigured) | `/api/channel-sessions` `/api/channels` `/api/channels/weixin` `/api/chat/queue` |
| 协作 | 专家库 | `#/experts` | `#page-experts` | `#expBuiltinGrid` | `panel-experts-ui.js` `panel-workspace-ui.js` `panels/extensions.js` | `panel-experts-ui.js`(extSwitchTab)<br>`panel-workspace-ui.js`(openBuiltinExpertEditor/pwRoom)<br>`panels/extensions.js`(BUILTIN_EXPERTS_ARR/_allBuiltinExperts) | `/api/experts` `/api/extensions/skills/config-mcp` `/api/extensions/skills/install-package` `/api/extensions/skills/local` |
| 协作 | 专家讨论 | `#/rooms` | `#page-rooms` | `#roomMsgs` | `core/init.js` `fusion-v030.js` `panel-rooms-ui.js` `panel-workspace-ui.js` | `core/init.js`(connectRoomStream/loadRoomsList)<br>`fusion-v030.js`(chatSenderName/openChannelModal)<br>`panel-workspace-ui.js`(openBuiltinExpertEditor/pwRoom) | `/api/channels` `/api/channels/weixin` `/api/chat/upload-file` `/api/chat/upload-image` |
| 协作 | 任务方案 | `#/plans` | `#page-plans` | `#planNewTask` | `panel-plans-ui.js` | — | `/api/panel-plans` |
| 任务 | 定时任务 | `#/cron` | `#page-cron` | `#cronJobList` | `panels/cron.js` | — | `/api/cron-jobs` |
| 资料 | 助手 | `#/assistant` | `#page-assistant` | `#asstGrid` | `panels/assistant.js` | — | `/api/memory` |
| 资料 | 资料 | `#/kb` | `#page-kb` | `—` | `panel-library-ui.js` `panels/assistant.js` | — | `/api/memory` `/api/panel-library` `/api/panel-library/download` |
| 资料 | 足迹 | `#/memory` | `#page-memory` | `#memMemory` | `panel-library-reviews-ui.js` `panel-library-ui.js` `panels/memory.js` | `panels/memory.js`(renderMemoryPage) | `/api/memory` `/api/panel-library` `/api/panel-library-reviews` `/api/panel-library/download` |
| 能力 | 技能与工具 | `#/extensions` | `#page-extensions` | `#extTabs` | `core/init.js` `panel-experts-ui.js` `panel-mcp-ui.js` `panel-plans-ui.js` `panel-workspace-ui.js` `panels/extensions.js` | `core/init.js`(connectRoomStream/loadRoomsList)<br>`panel-experts-ui.js`(extSwitchTab)<br>`panel-workspace-ui.js`(openBuiltinExpertEditor/pwRoom)<br>`panels/extensions.js`(BUILTIN_EXPERTS_ARR/_allBuiltinExperts) | `/api/experts` `/api/extensions/skills/config-mcp` `/api/extensions/skills/install-package` `/api/extensions/skills/local` |
| 能力 | 渠道与连接器 | `#/comm` | `#page-comm` | `#chModalBody` | `fusion-v030.js` `panel-channels-ui.js` `panel-typing-ui.js` `panels/channels.js` | `fusion-v030.js`(chatSenderName/openChannelModal)<br>`panels/channels.js`(chPollWeixinQr/chShowQrSuccess) | `/api/channels` `/api/channels/telegram/qr` `/api/channels/telegram/qr/apply` `/api/channels/wecom/qr` |
| 模型 | 通用模型 | `#/models-general` | `#page-models-general` | `#modelRoutesSlot` | `panel-models-ui.js` | — | `/api/panel-models` |
| 模型 | 模型 API | `#/models-api` | `#page-models-api` | `#openAiApiRefresh` | `panel-models-voice.js` | — | `/api/panel-models/voice` |
| 模型 | 辅助模型 | `#/models-aux` | `#page-models-aux` | `#auxTaskList` | `panel-auxiliary-ui.js` | — | `/api/panel-models/auxiliary` |
| 模型 | 组合模型 | `#/models-moa` | `#page-models-moa` | `#moaSlot` | `panel-models-ui.js` | — | `/api/panel-models` |
| 模型 | JEV | `#/models-jev` | `#page-models-jev` | `#jevSlot` | `panel-models-voice.js` | — | `/api/panel-models/voice` |
| 模型 | STT 提供方 | `#/models-stt` | `#page-models-stt` | `#voiceStackStatus` | `panel-models-voice.js` | — | `/api/panel-models/voice` |
| 模型 | TTS 提供方 | `#/models-tts` | `#page-models-tts` | `#voiceTtsSlot` | `panel-models-voice.js` | — | `/api/panel-models/voice` |
| 模型 | 响应验证 | `#/models-checks` | `#page-models-checks` | `#modelChecksForm` | `panel-model-checks-ui.js` | — | `/api/panel-models` |
| 维护 | 运行状态 | `#/overview` | `#page-overview` | `#dbPort` | `panels/overview.js` | — | `/api/dashboard/start` `/api/dashboard/stop` `/api/logs` `/api/logs/clear` |
| 维护 | 用量统计 | `#/usage` | `#page-usage` | `#usageByModelList` | `panels/usage.js` | — | `/api/usage` |
| 维护 | 本地版本 | `#/updates` | `#page-updates` | `#configRecovery` | `panel-config-recovery-ui.js` `panel-maintenance-ui.js` `panel-runtime-ui.js` | `panel-maintenance-ui.js`(renderMaintenancePage) | `/api/config-recovery` `/api/maintenance/repositories` `/api/panel-runtime` |
| 设置 | 偏好设置 | `#/settings` | `#page-settings` | `#settingsFeedback` | `panel-auth-ui.js` `panel-settings.js` | — | `/api/panel-auth` `/api/workspace-ui` |
<!-- /AUTO:业务表 -->

### 0.3 覆盖链：改了不生效的那些文件（2026-11-13 新增）

这个前端没有打包器、没有模块系统：66 个 `<script>` 手写顺序加载，所有顶层 `function`
和 `window.X` 都挂在同一个全局对象上。于是**同一个名字被两个文件定义时，后加载的静默覆盖
前一个**，前面的变成永不执行的死代码。不报错、不警告、控制台干净。

后果是这样一条死路：你改 `chat/tabs.js` 里的 `loadSessionMessages`，逻辑写得很对，
刷新页面——行为没变。因为运行时跑的是 `panel-workspace-ui.js` 那份。你会怀疑缓存、
怀疑部署、怀疑浏览器，就是不会怀疑「这个函数根本不是这个文件说了算」。

**四条最伤的（已实测确认）**

| 符号 | 你以为改这里 | 实际生效的是 | 后果 |
|---|---|---|---|
| `switchPage` | `core/router.js` | `fusion-v030.js` | 改核心路由文件完全无效，真逻辑在 `fusion-v030.js` 的包装钩子里 |
| `toast` | `core/utils.js` | `core/ui-kit.js` | 早期工具层改了没用 |
| `loadSessionMessages` | `chat/tabs.js` | `panel-workspace-ui.js` | 改会话加载逻辑无效 |
| `renderExpertsPage` 等 5 个 | `panels/extensions.js` | `panel-experts-ui.js` | 整个专家页在 `panels/` 里是死的 |

**规模（脚本实测，非估算）**：60 组符号跨文件重复定义，共 70 处死份。按文件分布：
`core/init.js` 11、`panels/extensions.js` 11、`panel-workspace-ui.js` 7、`chat/compose.js` 7、
`panels/channels.js` 6、`core/mini-popup.js` 6、`chat/message-ops.js` 5、`chat/tabs.js` 5。
`panels/` 系列占 19 处——它是「原样搬运」层，被后来的补丁层大面积顶掉。

**改东西前先查一句**（这是这节的唯一用途）

```bash
python3 dev/arch_symbols.py            # 全量：符号 → 谁生效 → 谁死
python3 dev/arch_symbols.py --dead     # 只看死份，找「改了不会生效」的文件
python3 dev/arch_symbols.py --json     # 机器读
```

业务表里「改了不生效（被覆盖的符号）」那一列，就是同一份数据按页面归的。

**门禁**：`dev/arch_lint.py` 的 C10 拦新增覆盖——同一个全局符号再多一个文件定义，
直接 `exit 1` 点名。存量 60 组进基线，只减不增。想新增一份覆盖必须先把基线改了
（`--update`），这相当于逼你说一句「我知道我在覆盖谁」。

完整清单（自动生成，勿手改）：

<!-- AUTO:覆盖链 -->
| 符号 | 定义文件（按加载顺序） | 生效（最后加载） | 死份（永不执行） |
|---|---|---|---|
| `roomCreateDialog` | `core/init.js` → `fusion-v030.js` → `panel-workspace-ui.js` → `panel-rooms-ui.js` | `panel-rooms-ui.js` | `core/init.js` `fusion-v030.js` `panel-workspace-ui.js` |
| `extSwitchTab` | `panels/extensions.js` → `panel-experts-ui.js` → `panel-plans-ui.js` | `panel-plans-ui.js` | `panels/extensions.js` `panel-experts-ui.js` |
| `openBuiltinExpertEditor` | `panels/extensions.js` → `panel-workspace-ui.js` → `panel-experts-ui.js` | `panel-experts-ui.js` | `panels/extensions.js` `panel-workspace-ui.js` |
| `openChannelModal` | `panels/channels.js` → `fusion-v030.js` → `panel-channels-ui.js` | `panel-channels-ui.js` | `panels/channels.js` `fusion-v030.js` |
| `refreshExperts` | `panels/extensions.js` → `panel-workspace-ui.js` → `panel-experts-ui.js` | `panel-experts-ui.js` | `panels/extensions.js` `panel-workspace-ui.js` |
| `renderBuiltinExperts` | `panels/extensions.js` → `panel-workspace-ui.js` → `panel-experts-ui.js` | `panel-experts-ui.js` | `panels/extensions.js` `panel-workspace-ui.js` |
| `renderExpertsPage` | `panels/extensions.js` → `panel-workspace-ui.js` → `panel-experts-ui.js` | `panel-experts-ui.js` | `panels/extensions.js` `panel-workspace-ui.js` |
| `renderMineExperts` | `panels/extensions.js` → `panel-workspace-ui.js` → `panel-experts-ui.js` | `panel-experts-ui.js` | `panels/extensions.js` `panel-workspace-ui.js` |
| `roomSend` | `core/init.js` → `fusion-v030.js` → `panel-rooms-ui.js` | `panel-rooms-ui.js` | `core/init.js` `fusion-v030.js` |
| `BUILTIN_EXPERTS_ARR` | `panels/extensions.js` → `panel-workspace-ui.js` | `panel-workspace-ui.js` | `panels/extensions.js` |
| `__hermesConfigured` | `panels/models.js` → `panel-models-ui.js` | `panel-models-ui.js` | `panels/models.js` |
| `_allBuiltinExperts` | `panels/extensions.js` → `panel-workspace-ui.js` | `panel-workspace-ui.js` | `panels/extensions.js` |
| `_expertCardHtml` | `panels/extensions.js` → `panel-workspace-ui.js` | `panel-workspace-ui.js` | `panels/extensions.js` |
| `_setSessionModel` | `core/mini-popup.js` → `panel-durable.js` | `panel-durable.js` | `core/mini-popup.js` |
| `_voiceStreamOpen` | `chat/message-ops.js` → `panel-workspace-ui.js` | `panel-workspace-ui.js` | `chat/message-ops.js` |
| `chPollWeixinQr` | `panels/channels.js` → `fusion-v030.js` | `fusion-v030.js` | `panels/channels.js` |
| `chShowQrSuccess` | `panels/channels.js` → `fusion-v030.js` | `fusion-v030.js` | `panels/channels.js` |
| `chatSenderName` | `fusion-v030.js` → `panel-workspace-ui.js` | `panel-workspace-ui.js` | `fusion-v030.js` |
| `chatStop` | `chat/compose.js` → `panel-durable.js` | `panel-durable.js` | `chat/compose.js` |
| `clearSelectedExpert` | `panels/extensions.js` → `panel-workspace-ui.js` | `panel-workspace-ui.js` | `panels/extensions.js` |
| `closeChannelModal` | `panels/channels.js` → `panel-channels-ui.js` | `panel-channels-ui.js` | `panels/channels.js` |
| `connectRoomStream` | `core/init.js` → `fusion-v030.js` | `fusion-v030.js` | `core/init.js` |
| `filterRail` | `chat/tabs.js` → `panel-workspace-ui.js` | `panel-workspace-ui.js` | `chat/tabs.js` |
| `handleSlashCommand` | `core/mini-popup.js` → `panel-workspace-ui.js` | `panel-workspace-ui.js` | `core/mini-popup.js` |
| `injectExpertSystem` | `chat/compose.js` → `panel-plans-ui.js` | `panel-plans-ui.js` | `chat/compose.js` |
| `loadRoomsList` | `core/init.js` → `panel-rooms-ui.js` | `panel-rooms-ui.js` | `core/init.js` |
| `loadSessionMessages` | `chat/tabs.js` → `panel-workspace-ui.js` | `panel-workspace-ui.js` | `chat/tabs.js` |
| `openMini` | `core/mini-popup.js` → `panel-connectors-ui.js` | `panel-connectors-ui.js` | `core/mini-popup.js` |
| `openRoundtable` | `chat/roundtable.js` → `panel-rooms-ui.js` | `panel-rooms-ui.js` | `chat/roundtable.js` |
| `openVoiceSettings` | `chat/message-ops.js` → `panel-workspace-ui.js` | `panel-workspace-ui.js` | `chat/message-ops.js` |
| `pickItemExpert` | `core/mini-popup.js` → `panel-workspace-ui.js` | `panel-workspace-ui.js` | `core/mini-popup.js` |
| `pickQuick` | `core/mini-popup.js` → `panel-workspace-ui.js` | `panel-workspace-ui.js` | `core/mini-popup.js` |
| `pickWorkflowFromMini` | `core/mini-popup.js` → `panel-plans-ui.js` | `panel-plans-ui.js` | `core/mini-popup.js` |
| `pwRoom` | `panel-workspace-ui.js` → `panel-rooms-ui.js` | `panel-rooms-ui.js` | `panel-workspace-ui.js` |
| `renameSession` | `chat/tabs.js` → `panel-workspace-ui.js` | `panel-workspace-ui.js` | `chat/tabs.js` |
| `renderAttachChips` | `chat/compose.js` → `panel-durable.js` | `panel-durable.js` | `chat/compose.js` |
| `renderChannels` | `panels/channels.js` → `panel-channels-ui.js` | `panel-channels-ui.js` | `panels/channels.js` |
| `renderMaintenancePage` | `panel-maintenance-ui.js` → `panel-config-recovery-ui.js` | `panel-config-recovery-ui.js` | `panel-maintenance-ui.js` |
| `renderMemoryPage` | `panels/memory.js` → `panel-library-ui.js` | `panel-library-ui.js` | `panels/memory.js` |
| `renderRoomMessages` | `core/init.js` → `fusion-v030.js` | `fusion-v030.js` | `core/init.js` |
| `renderRoomsPage` | `core/init.js` → `panel-rooms-ui.js` | `panel-rooms-ui.js` | `core/init.js` |
| `restoreDraft` | `chat/tabs.js` → `panel-durable.js` | `panel-durable.js` | `chat/tabs.js` |
| `roomAtDialog` | `core/init.js` → `fusion-v030.js` | `fusion-v030.js` | `core/init.js` |
| `roomCreateConfirm` | `core/init.js` → `fusion-v030.js` | `fusion-v030.js` | `core/init.js` |
| `roomMsgAppend` | `core/init.js` → `fusion-v030.js` | `fusion-v030.js` | `core/init.js` |
| `roomStreamEl` | `core/init.js` → `fusion-v030.js` | `fusion-v030.js` | `core/init.js` |
| `saveDraft` | `chat/tabs.js` → `panel-durable.js` | `panel-durable.js` | `chat/tabs.js` |
| `selectRoom` | `core/init.js` → `panel-rooms-ui.js` | `panel-rooms-ui.js` | `core/init.js` |
| `sendRaw` | `chat/compose.js` → `panel-durable.js` | `panel-durable.js` | `chat/compose.js` |
| `setChFilter` | `panels/channels.js` → `panel-channels-ui.js` | `panel-channels-ui.js` | `panels/channels.js` |
| `speakMsg` | `chat/message-ops.js` → `panel-workspace-ui.js` | `panel-workspace-ui.js` | `chat/message-ops.js` |
| `streamChat` | `chat/compose.js` → `panel-durable.js` | `panel-durable.js` | `chat/compose.js` |
| `streamChatSSE` | `chat/compose.js` → `panel-durable.js` | `panel-durable.js` | `chat/compose.js` |
| `streamChatXhr` | `chat/compose.js` → `panel-durable.js` | `panel-durable.js` | `chat/compose.js` |
| `switchPage` | `core/router.js` → `fusion-v030.js` | `fusion-v030.js` | `core/router.js` |
| `toast` | `core/utils.js` → `core/ui-kit.js` | `core/ui-kit.js` | `core/utils.js` |
| `toggleRail` | `chat/new-dialog.js` → `fusion-v030.js` | `fusion-v030.js` | `chat/new-dialog.js` |
| `useExpert` | `panels/extensions.js` → `panel-workspace-ui.js` | `panel-workspace-ui.js` | `panels/extensions.js` |
| `voiceStopAll` | `chat/message-ops.js` → `panel-workspace-ui.js` | `panel-workspace-ui.js` | `chat/message-ops.js` |
| `welcomeHTML` | `chat/message-ops.js` → `panel-workspace-ui.js` | `panel-workspace-ui.js` | `chat/message-ops.js` |
<!-- /AUTO:覆盖链 -->

### 四条约定（改页面前必须知道）

1. **`panels/<名字>.js` 是页面属主**，一个页面一个，负责该页面的渲染与交互。
2. **`panel-<名字>-ui.js` 是补丁层**，历史上为了不改属主而外挂的增强，
   加载顺序在属主之后。新功能优先写进属主，不要再开补丁层。
3. **`fusion-v030.js` 是跨域补丁**，同时摸 rooms / comm / connectors / tunnel，
   它是最乱的依赖点。碰这四个页面之前先读它。
4. **`panels/` 那批是「搬运」不是「新写」**（2026-11-13 拆 index.html 时按区间原样外移）。
   12 个文件、3728 行，每个文件头注都写着原内联块的行号区间，例如
   `panels/extensions.js` 头注是「来源：index.html 内联 app.js 第 6216-7547 行」。
   由此产生一个极易踩的错觉：**`panels/models.js` 只有 66 行、只管配置横幅**，
   模型页真正的 444 行主体在 `panel-models-ui.js`；**`panels/extensions.js` 1335 行才是技能/工具页主体**，
   `panel-experts-ui.js` 只有 69 行、只负责头像与筛选。
   名字前缀相同 ≠ 职责相同，改之前先看行数和头注，不要按文件名猜。

> 判据：`panels/*.js` 平均 311 行（有头注声明的都是纯搬运，逻辑零改动）；
> `panel-*-ui.js` 平均 96 行，是运行时覆盖。**同一个页面往往两者都有，改前先确认改哪一层。**

### 别名表：5 个，不是 3 个（2026-11-13 更正）

定义在 `js/panel-navigation.js` 的 `aliases`：

```js
{connectors:'comm', tunnel:'comm', learning:'kb', flows:'plans', models:'models-general'}
```

**废弃容器（容器还在 DOM 里，但深链被重定向，改了看不见）：**

| 老入口 | 落到 | 说明 |
|---|---|---|
| `#/connectors` | `#/comm` | 连接器并入渠道页 |
| `#/tunnel` | `#/comm` | 隧道并入渠道页 |
| `#/learning` | `#/kb` | 学习并入知识库 |

**老路径（页面是活的，只是换了个名字）：**

| 老入口 | 落到 | 说明 |
|---|---|---|
| `#/flows` | `#/plans` | 任务方案改过名 |
| `#/models` | `#/models-general` | **要特别小心**：斜杠命令、工作台按钮、深链全走 `#/models`，最后渲染的是 `models-general`。按 `#/models` 找页面找不到东西 |

> 前三个别往里加东西。后两个是活页面，只是入口名不同 —— 尤其是 `models`，
> 「模型面板没有 XX 功能」这类问题，先确认你看的是 `models-general` 而不是某个不存在的 `models` 页。

---

### 0.4 样式架构：token → 组件 → 页面

三层，单向依赖。**页面 css 不许重新发明按钮和卡片。**

```
base.css          →  token 层（颜色/字号/间距/圆角）＋ 布局骨架
components.css    →  组件层（唯一真源：btn / card / panel / badge / empty / field）
panel-*.css       →  页面层（只管该页面独有的布局，不许重定义组件外观）
```

### 圆角只有四级

| token | 值 | 用在哪 |
|---|---|---|
| `--radius-sm` | 6px | chip、badge、极小控件 |
| `--radius-md` | 8px | 控件：按钮、输入框 |
| `--radius-xl` | 12px | 卡片、面板（默认） |
| `--radius-2xl` | 16px | 大容器、特殊卡（mdeck） |

> `--radius-lg` 已统一为 12px（原来是 14px，比 `--radius-xl` 还大，语义是反的）。
> 新代码用 `--radius-xl`，别再挑 `--radius-lg`。

#### 但「只有四级」目前只对 token 层成立（2026-11-13 自审更正）

上一轮收敛的是**卡片类**（约 10 个 `.xxx-card`），不是全站。实测 `css/` 下仍有
**21 种硬编码圆角、269 处**：

```
8px×61  10px×55  6px×26  4px×21  12px×18  999px×12  16px×11
5px×11  9px×10   20px×9  7px×8   14px×7   18px×6    3px×5
2px×4   22px×2   19px×1  17px×1  11px×1   1px×1
```

其中 `4px / 5px / 7px / 9px / 10px / 14px / 18px` 这 7 档不在四级里，属于历史残留。
**门禁拦不住它们**：C5/C6 只看类名（`class="…"` 和 CSS 选择器），
不检查任何数值属性——所以 CSS 数值漂移目前是零防护。

> 结论：写新代码守四级；看到旧代码里的怪值，顺手换成最近的一级（改 css 不算改行为，
> 但要真机看一眼）。要根治得给门禁加一条「CSS 数值白名单」规则（C8），列在 §6 待办。

### 变异体必须真的存在 —— `:not()` 链踩过一次（2026-11-13）

`.ov-actbtn`（第二套按钮，概览/定时任务/渠道/对话框都在用）原本这样写：

```css
.ov-actbtn.start{background:var(--success)}      /* 绿 */
.ov-actbtn.stop {background:var(--red)}          /* 红 */
.ov-actbtn.restart{background:var(--warning)}    /* 黄 */
.ov-actbtn:not(.start):not(.stop):not(.restart){background:var(--bg3)}  /* 灰兜底 */
```

**`:not()` 里的类会计入特异性** —— 那条兜底是 `(0,4,0)`，而任何 `.ov-actbtn.primary`
只有 `(0,2,0)`。于是：

- `.ov-actbtn.primary`（新建会话「创建」、新建讨论「新建」）→ 灰底，跟旁边的「取消」一模一样
- `.ov-actbtn.danger`（渠道页「清空配置」）→ 灰底，危险操作毫无警示

而这俩变体在 CSS 里**根本没定义**，所以连「压不压得过」都谈不上，直接退化成中性灰。

修法：灰底写进 `.ov-actbtn` 基础规则 `(0,1,0)`，变体排后面按顺序覆盖；删掉 `:not()` 链。
实测修复后 `primary` = `rgb(113,219,192)`（薄荷绿 accent）、`danger` = `rgb(248,113,113)`。

> **判据**：`class="base variant"` 里每个 variant 都必须在 CSS 里存在 `.base.variant` 规则。
> 全站 410 个唯一 class 组合扫过一遍，缺变体的只有这两个，已修。
> 加新变体一律 `.base.xxx`，**不要再写 `:not()` 兜底**。

### 组件模板（照抄，别自创）

```html
<!-- 卡片：带标题和底部操作 -->
<div class="card">
  <div class="card-head"><h3 class="card-title">标题</h3><button class="btn sm">操作</button></div>
  <div class="card-body">…</div>
  <div class="card-foot"><button class="btn">取消</button><button class="btn primary">保存</button></div>
</div>

<!-- 卡片：只要一块面板，不要头尾 -->
<div class="card card--pad">…</div>

<!-- 卡片：可点进详情 -->
<div class="card card--click">…</div>

<!-- 按钮：基础 .btn；变体 primary/danger/secondary/ghost；尺寸 sm/xs；通栏 block -->
<button class="btn primary">保存</button>

<!-- 徽标 -->
<span class="badge" data-tone="ok">已连接</span>

<!-- 空态 -->
<div class="empty"><span class="empty-title">还没有会话</span><span class="empty-hint">点右上角新建</span></div>

<!-- 表单字段 -->
<label class="field">
  <span class="field-label">名称</span>
  <input class="field-input" id="x">
  <span class="field-hint">留空则用默认值</span>
</label>
```

### 禁止事项（arch_lint 会拦）

- 新造按钮类名：`*-btn`、`xxxBtn`、`actbtn`、`q-btn` 一律不许新增。
- 新造卡片类名：`xxx-card`（存量在基线里，只减不增）。要差异化用 `.card` ＋ 修饰符。
- 在页面 css 里重写 `padding`/`border-radius`/`background` 来改按钮外观 —— 那是组件的活。

### 已知历史包袱

| 现象 | 现状 | 处理 |
|---|---|---|
| `.ov-actbtn` 49 处 | 第二套按钮（34px/600 字重/bg3 底），与 `.btn`（44px/400/bg2）并存 | 已登记基线，新增禁止；迁移时改成 `.btn` |
| `.msg-act-btn` 12 处 | 消息行内小动作，11px 尺寸 | 等价于 `.btn xs`，保留 |
| 12 处 `.btn` 上下文覆盖 | 各页面重新声明 padding/font-size | 逐步收进 `.btn.sm/.xs` |

---

### 0.5 功能架构：对话链路在哪

对话是唯一跨 5 个文件的域，按职责切开：

| 能力 | 文件 | 关键函数 | 接口 |
|---|---|---|---|
| 发送/停止 | `chat/compose.js` | `sendChat` `sendRaw` `onSendOrStop` `setSendState` | `/api/chat/stream` `/api/chat/stop` |
| 生成状态条 | `chat/compose.js` | `genBarShow` `genBarReset` `genBarReconcile` `genBarDone` | — |
| 气泡渲染 | `chat/tabs.js` | `msgHTML`（单入口）`msgHTMLBase` `splitContent` `fileChipsHTML` | — |
| **工具卡** | `chat/tabs.js` | `toolCardHTML` `toolCallsHTML` `genToolState` `isToolDone` `boxState` `paint/paintAll` | — |
| 气泡状态徽标 | `chat/tabs.js` | `setBubbleStatus` `clearBubbleStatus` `_sbElapsed` `_sbTickNow` | — |
| 会话列表/切换 | `chat/tabs.js` | `renderRail` `switchSession` `loadSessionMessages` `delSession` `renameSession` | `/api/sessions` |
| 频道会话 | `chat/tabs.js` | `fetchChannelSessions` `openChannelSession` `exitChannelView` | `/api/channel-sessions` |
| 语音/朗读 | `chat/message-ops.js` | `toggleVoiceRecord` `speakMsg` `voicePlayNext` `_bargeInStart` | `/api/voice/config` |
| 圆桌讨论 | `chat/roundtable.js` | `openRoundtable` `rtAgentSpeak` `rtCheckConsensus` | `/api/sessions` |
| 新建会话弹窗 | `chat/new-dialog.js` | `openNewSessionModal` `createNewSession` `wsPickerOpen` | `/api/files/mkdir` |
| 发送队列/断线续发 | `panel-durable.js` | `submit` `renderQueue` `resumeOutbox` `restoreUnsent` | `/api/chat/queue` |
| 弹窗行为统一 | `core/ui-kit.js` | `modal` `adoptOverlay` `toast` `confirm` | — |
| 斜杠命令 | `panel-slash.js` | 命令表 ＋ 浮层 ＋ chip | `/api/status` |
| 选项卡片 | `panel-clarify.js` | 渲染 `choices`、回传 | `/api/clarify/respond` |
| 跨文件装饰钩子 | `panel-workspace-ui.js` | `pwDecorateMsg`（气泡后置增强：头像、`data-request-id`） | — |

### 渲染链路（改气泡必须先看懂这条）

```
sendChat()  →  POST /api/chat/stream
            →  genBarShow()      顶部状态条（进行时）
            →  msgHTML()         气泡 HTML（chat/tabs.js，唯一入口）
            →  pwDecorateMsg()   后置钩子（头像 / data-request-id）
            →  toolCallsHTML()   工具卡嵌在气泡内
            →  setBubbleStatus() 气泡底部「已X」chip
            →  genBarDone()      状态条收尾
```

**规矩**：`msgHTML` 只许有一个定义（`chat/tabs.js`）。要加内容走
`pwDecorateMsg` 钩子，不许再整篇覆盖 `window.msgHTML`。

---

---

### 0.6 剩下的文件归哪儿（2026-11-13 自审补的）

上面三张表只覆盖了主干，**实际加载的 66 个项目 JS 里有 16 个没进表**（`index.html` 里
69 个 `<script>`，减 3 个 vendor 再减 2 个死文件）。它们是「改到那页却不知道还有这个文件」的来源，所以单列：

| 文件 | 行数 | 职责 | 你什么时候要动它 |
|---|---|---|---|
| `core/markdown.js` | 356 | Markdown 渲染 ＋ 顶部工具栏入口 | 改代码块样式、复制按钮、渲染规则 |
| `core/theme.js` | 27 | 亮/暗主题切换与持久化 | 改主题开关、加第三套主题 |
| `panel-chat-tail.js` | 189 | 气泡单一闭合轮廓（v7，轮廓是整体不是小三角贴纸） | 改气泡尾巴/圆角接缝 |
| `panel-chat-avatar.js` | 90 | 消息头像装饰器（**只装饰，不产生头像**；头像真源在 `panel-workspace-ui.js` 的 `avatarHTML`） | 头像是圆/方、上传 GIF 被顶掉 |
| `panel-tooltip.js` | 113 | 全局气泡提示层（`[data-tip]` 走这一层，不是 CSS 伪元素） | 提示被裁、长提示换行 |
| `panel-tree.js` | 74 | 树目录统一模板 `PwTree.node()` ＋ document 级委托 | 文件夹组、通道会话组 |
| `panel-compress-ui.js` | 152 | `/compress` 真压缩入口（`window.runCompress`） | 压缩行为、预览、详情 |
| `panel-library-drafts.js` | 47 | 资料页草稿：浏览器存储只是恢复副本，**真源是输入框实时内容** | 草稿丢失、刷新回填 |
| `panel-library-reviews-ui.js` | — | 资料页批注/审阅层 | 资料页右侧批注 |
| `panel-model-editor.js` | 308 | 模型服务编辑器：卡片点开与「添加服务」**同一套表单** | 加/删服务、改字段 |
| `panel-cron-editor.js` | 246 | 定时任务编辑器（新建/编辑表单） | 任务表单字段、cron 表达式校验 |
| `panel-cron-history-ui.js` | 87 | 任务执行历史列表 | 历史记录展示 |
| `panel-cron-hooks-ui.js` | 109 | 任务钩子（前后置脚本） | 钩子配置 |
| `panel-echo-ui.js` | 20 | 回声站入口页（任务队列已独立成站，面板只留入口） | 回声站换地址 |
| `panel-channel-pairing-ui.js` | 25 | 通道配对（扫码/绑定）薄层，主体在 `panel-channels-ui.js` | 配对流程 |
| `panels/learning.js` | 569 | 学习轨迹 ← **已废弃**，内容运行时被搬进知识库的轨迹视图 | 基本不用动；见 §6 结构债 |

**2 个死文件（仓库里有、`index.html` 从不加载，改它等于白改）**：

| 文件 | 行数 | 说明 |
|---|---|---|
| `js/ao_workflow_presets.js` | 3660 | 全仓最大文件，工作流预设，早已不走这条路（预设走接口） |
| `js/personas_library.js` | 4（单行 2MB） | 268 个人格硬编码，已由 `panel-experts-ui.js` 走接口取代 |

> 判据：**改前端之前先确认它在 `index.html` 里被 `<script>` 引了**。
> 没引的就是死文件，`grep` 能搜到但刷新永远不生效——2026-11-13 之前我自己在这里绕过一次。



这个前端没有打包器、没有模块系统：69 个 `<script>`（含 3 个 vendor）靠手写顺序加载，所有符号都是全局的。
于是有两类 bug 反复出现，而且都表现为「你改了一处，看着好了，过两天又弹回来」：

1. **同名符号**：同一个函数在两个文件里各写一份，后加载的静默覆盖前面的。
2. **补丁层**：某文件用 `window.X =` 在运行时替换别处的实现，源码里搜「重复定义」搜不到，但只有一个活着。

当前实测规模：

| 项 | 数量 | 说明 |
|---|---|---|
| JS 文件 | 68（+2 死文件不加载） | 39 个在 `js/` 根目录，`core/` 12、`chat/` 5、`panels/` 12 |
| 全局符号 | 709 | 全靠 script 顺序保证可用 |
| 同名符号 | 29 组 | 见 R1 |
| 分层倒置 | 44 处 | 见 R2 |
| 补丁层覆盖 | 239 处 | 见 R7，最狠的 `panel-workspace-ui.js` 50 处 |

> 2026-11-13 二次复核：以上为 `python3 data/scripts/arch_lint.py` 实跑输出，
> 与首轮（66 / 30 / 237 / 57）的差异是拆分层后未同步的旧数。**数字以 lint 输出为准，不要手抄。**
| 硬编码色 | 132 处 | 见 R6 |

**结论：这不是「代码脏」，是缺少边界。** 边界靠规矩 + 检查器，不靠自觉。

---

## 二、分层与依赖方向

```
L0  core/          基础设施，不依赖任何人
    state / api / data / router / ui-kit / markdown / boot-mask / mini-popup

L1  services       业务数据访问（读写 state.db、调后端接口）
    panel-*-ui.js 里的 fetch 层、durable 层

L2  components     可复用 UI 构件，只依赖 L0
    ui-kit.js（modal/confirm/toast/field/table）、chat 渲染原语

L3  features       具体页面与业务，可依赖 L0~L2
    chat/*、panel-*.js、panels/*

L4  entry          启动与装配，可依赖全部
    init.js、idx 启动蒙版
```

**依赖只能向下。** `core/` 里出现 `panel-xxx` 的调用就是分层倒置（R2 会报）。
`init.js` 14 处、`router.js` 9 处属于装配层调用 feature，属例外，但应该在 R2 白名单里显式登记，而不是默认放过。

---

## 三、组件契约（按钮 / 面板 / 卡片 / 表单）

CSS 层：`css/components.css` 是**唯一新增点**，`:root` 变量在 `css/base.css`。

### 按钮 —— 只有一个类名 `.btn`

```html
<button class="btn">普通</button>
<button class="btn primary">主操作</button>
<button class="btn danger">危险</button>
<button class="btn ghost">次级</button>
<button class="btn sm">小号</button>
<button class="btn block">撑满</button>
```

- 基础样式：`css/base.css` 里那一条 `.btn{font:inherit;padding:7px 16px;...}`
  **`font:inherit` 不许删** —— `button` 默认不继承字体，删掉会因为 Arial 回退把按钮高度从 34.2 顶到 34.8，整行对不齐。
`components.css` 末尾还有一条 `button,[role=button]{font:inherit}` 兜底：实测 1349 个可见按钮里 798 个字体是 Arial，
`.nav-btn` 这类自有类没写 font，靠一条全局重置统一，比逐个类补 font 靠谱。
- **禁止** `class="action"`（已全量迁移，旧的 0 处，R4 会拦）。
- **禁止**在容器里重写按钮的 padding/radius/background —— 那是重复定义，不是定制。
  要差异化就加变体类，别在 `.some-panel .btn{}` 里重写基础属性。
- 原生 `<span onclick>` 当按钮用：必须补 `role="button"` + `.btn` 类，否则键盘不可用。

### 面板 / 卡片 —— 容器用 `.panel`，内容块用 `.card`

```html
<section class="panel">
  <div class="panel-head"><span class="panel-title">标题</span><div class="panel-tools">…</div></div>
  <div class="panel-body">
    <div class="card"><div class="card-body">…</div></div>
  </div>
</section>
```

- `.panel` = 整块页面区域（带边框、圆角、背景）。
- `.card` = 面板内的一张卡片（同样带边框圆角，嵌套不出双边框）。
- **禁止**新造 `xxx-card` 类名。现存这些是历史债，逐个迁：`mem-card` `ov-card` `auxiliary-card` `ext-card` `connector-card` `expert-card` `wf-step-card` `panel-card`。
  新代码用 `.card`；老代码迁移时把原类的**差异部分**降级成修饰类（如 `.card.compact`）。

### 弹窗与确认

- 弹窗：`UI.modal({title, body, foot})`（`js/core/ui-kit.js`）。
- 确认：`await UI.confirm(text)`。
- **禁止**原生 `confirm/alert/prompt`（R5 还剩 7 处：confirm 3、prompt 3、alert 1）。

### 表单

- 字段统一 `UI.field(...)`；不要在页面里手拼 label+input。
- 颜色一律用变量：`var(--bg1) var(--bg2) var(--border) var(--text) var(--muted) var(--accent) var(--danger) var(--success) var(--warning)`。
  注意：`--ok` / `--warn` **不存在**，写成它们等于没写（这坑踩过）。

---

## 四、检查器（两个脚本，各管一层，规则号不重叠）

机器上有两份 lint，**不是重复实现，是两层体检**。跑哪个看你要查什么。

### 4.1 `dev/arch_lint.py` — 收敛门禁（版本库内，带基线）

```bash
python3 dev/arch_lint.py            # 只拦新增，存量放行；有新增 exit 1
python3 dev/arch_lint.py --all      # 连存量一起列
python3 dev/arch_lint.py --update   # 修完一条，收紧基线
python3 dev/arch_doc_gen.py --write # 结构改了，刷新本文件 §0.2 的业务表
```

| 规则 | 拦什么 | 现状 |
|---|---|---|
| C1 | 覆盖链 `var oldX = X` + `window.X =` | 4 条（业务增强，基线） |
| C2 | 自建 HTML 转义（除 `core/dom.js`） | 0 |
| C3 | 自建 toast（除 `core/ui-kit.js`） | 0 |
| C4 | 手拼 `modal-overlay` 却没调 `adoptOverlay` | 0 |
| C5 | 新造 `.xxx-card` 类名 | 23 个存量进基线，新增即拦 |
| C6 | 新造 `.xxx-btn` 类名 | 17 个存量进基线，新增即拦 |
| C7 | 新页面未登记进本文件业务表 | 0 |
| C8 | 导航声明了页面但 `index.html` 无静态容器（反向检查） | 0 |
| C9 | 属性上下文（`title`/`value`/`data-*`）用 `esc(` 而非 `escAttr(` | 0 |
| C10 | 全局符号被多个文件定义（后加载静默覆盖） | 60 组进基线，新增即拦 |

基线 `dev/arch_lint_baseline.json`：**只减不增**。当前 104 条 = C1 4 + C5 23 + C6 17 + C10 60。

C1 和 C10 的区别：C1 拦的是**包装链**写法（`var oldX = X; window.X = function(){...oldX...}`），
C10 拦的是**两个文件各自独立定义一个同名全局**。后者更隐蔽——没有任何包装痕迹，
只是加载顺序决定了谁活。两条都要有。

### 4.2 `data/scripts/arch_lint.py` — 符号层体检（扫生产目录）

```bash
python3 data/scripts/arch_lint.py
python3 data/scripts/arch_lint.py --fail-on R1   # 当门禁
```

| 规则 | 含义 |
|---|---|
| R1 | 同名全局符号（后加载覆盖前加载） |
| R2 | 分层倒置（core 裸调 feature） |
| R3 | 加载顺序（顶层调用早于定义） |
| R4 | 组件契约（旧 `.action` 残留） |
| R5 | 原生 `confirm/alert/prompt` |
| R6 | JS 里硬编码颜色 |

> 为什么没合成一个：R1/R5 被两个技能以 `--fail-on R1,R4,R5` 调用，改编号会静默失效。
> 所以两套各自保留编号，用 C / R 前缀区分。**新增规则一律加到 C 系列**，
> R 系列只做存量收缩。

**新增代码不得让任何一项变多。** 这是唯一可执行的「规矩」，写进文档不算。

---

## 五、改东西该看哪个文件

| 你要改 | 去这里 |
|---|---|
| 按钮/卡片/面板长什么样 | `css/components.css`（新增）→ `css/base.css`（变量与 `.btn` 基础） |
| 确认框、Toast、弹窗 | `js/core/ui-kit.js` |
| 会话侧栏、消息气泡、渲染 | `js/chat/tabs.js`（`msgHTML` **唯一**定义）、`js/chat/message-ops.js`、`js/chat/compose.js` |
| 气泡装饰（运行时钩子） | `js/panel-workspace-ui.js` 的 `pwDecorateMsg` —— 它装饰 `msgHTML` 的产物，**不再重写 `msgHTML`**（2026-11-13 已实测：`msgHTML` 单份定义） |
| 路由与页面切换 | **`js/fusion-v030.js`**（`switchPage` 生效处），**不是** `js/core/router.js` —— 后者同名函数被打包钩子覆盖，永不执行（C10 实测） |
| 数据读写、配置项 | `js/core/state.js`、`js/core/data.js`、`js/core/api.js` |
| 单个功能面板 | `js/panel-<功能>-ui.js` |
| 启动顺序与蒙版 | `js/core/init.js`、`js/core/boot-mask.js`、`index.html` 尾部 |

**改完必做三件**：

```bash
bash dev/hermes-dev.sh deploy ui     # 只同步一层目录的老 bug 已修，现在递归
python3 data/scripts/bump_versions.py app/ui   # 漏一个 ?v= 就是缓存假象
python3 dev/arch_lint.py    # 数字不许变差
```

---

## 六、已知债（按危险度排序，带数字）

1. ~~**补丁层 237 处（R7）**~~ —— **2026-11-13 二轮已收**：`msgHTML` 合并成 tabs.js 单入口 + `pwDecorateMsg` 钩子；
   `switchTab/openTab/newTab/sendRaw/exitChannelView/pollSessionSync/roomAtDialog` 七处跨文件覆盖全部收口，
   渠道预览态改由 `window.chatChannel {active, leave(), afterSwitch()}` 一个接口表达。
   剩余 4 条覆盖（`welcomeHTML/_expertCardHtml/loadSessionMessages/voiceStopAll`）是业务增强，
   已登记在 `dev/arch_lint_baseline.json`，只减不增。
2. **同名符号 60 组（C10 实测，2026-11-13 更正：此前写 30 组）** —— 共 70 处死份。
   最伤的四个：`switchPage`（`core/router.js` 死，`fusion-v030.js` 活）、`toast`（`core/utils.js` 死，
   `core/ui-kit.js` 活）、`loadSessionMessages`（`chat/tabs.js` 死，`panel-workspace-ui.js` 活）、
   `renderExpertsPage` 等 5 个（`panels/extensions.js` 死，`panel-experts-ui.js` 活）。
   全量清单见 §0.3，查法 `python3 dev/arch_symbols.py --dead`。**这是「改了不生效」的头号原因**，
   不是第 1 条的尾巴。
3. **分层倒置 44 处（R2）** —— `core/` 直接调 feature。先把 `init.js` 的 14 处登记为装配层白名单，其余收口。
4. **硬编码色 132 处（R6）** —— `js/core/data.js` 46 处最集中，多在图表配色里，可换成变量。
5. **卡片类名 8 种** —— 视觉上近似但 padding/bg 不同，迁移要逐屏比对，不能一把梭。
6. ~~**原生弹窗 7 处（R5）**~~ —— **已收**：4 套自建 modal 合到 `core/ui-kit.js` 一套，
   `workspace/fusion/files` 三处退化成薄适配器；另外 17 处手工拼 `modal-overlay` 的老弹窗
   不改业务 DOM，统一由 `ui.adoptOverlay()` 接管行为（Esc / 遮罩关闭 / Tab 陷阱 / 滚动锁 / 层级 / 焦点还原）。

---

## 七、这次改了什么（2026-11-13）

- `.action` → `.btn` 全量收敛：**240 处**（含第二轮补的 6 处三元/`},` 写法）（CSS 选择器 66 + 属性写法 135 + 字面量写法 99 − 重叠）。
  真机实测（12 个页面 + 10 个弹窗）：**1349 个可见按钮、默认样式 0 个、JS 报错 0**。
  改前 `.btn` 一批根本没样式，且 798 个按钮字体是 Arial。
- 删掉 `.pw-modal` 里 4 条本地重写的按钮样式，改为共用基础样式。
- 补 `font:inherit`，修掉按钮字体退化成 Arial、高度 34.8→34.2 的错位。
- 新建 `css/components.css`：`.btn` 变体（danger/ghost/sm/block/icon/disabled）+ `.card`/`.panel`/`.badge` 契约。
- 修 `dev/hermes-dev.sh deploy ui` 只同步 `ui/js/*.js`、漏掉 `core/ chat/ panels/` 子目录的 bug —— 这类「改了没生效」已经栽过三次。
- 生产与源码仓此前不一致 25 个文件（生产更新），已回灌并提交 `66a6f78` 作为基线。

---

## 八、检查器自己的坑（2026-11-13 补的）

写完检查器要验证检查器，否则它会安静地漏掉东西：

1. **只扫 `<script src>` 列出的文件** → `index.html` 从来没被扫过。报「文件 66 个」时，它的 11 处 `.action`、
   内联样式、原生弹窗全在视野外。修好后是 67 个文件、`.btn` 从 101 变 112。
2. **`strip_code` 会把 HTML 的 `class="..."` 当字符串剥掉** → R4 统计必须读原文（`raw`）而不是剥离后的 `code`，
   但 R1/R2/R6/R7 必须只读 js，否则把标记当代码。
3. **正则改类名会误伤返回值** → `api.close(r || 'action')` 里的 `'action'` 是 modal 的返回标识，不是类名。
   一刀切改成了 `'btn'`，好在 `UI.confirm` 全仓 0 个调用点才没炸。已改回，判据收窄成「只有 `close(` 的参数是值」。
   反过来也不能矫枉过正：曾把「方法调用的参数」一律当数据，结果 14 处真类名被放过。
4. **别改第三方压缩库** → `purify.min.js` 里的 `"action"` 是 HTML 属性白名单，改了净化会漏属性。

验证脚本：`/tmp/hermes-verify-arch-tools.py`（20 项断言，含上述全部反例）。

---

## 九、第二轮收敛：从「谁后加载谁赢」到「一个入口 + 一个钩子」

第一轮把 `.action` 收敛成 `.btn`，那是样式层。第二轮动的是**控制流**——同一件事被三代代码各写一遍。

### 改前（都是真实的，不是推测）

| 东西 | 改前 | 症状 |
|---|---|---|
| 转义 | 6 处 `esc/esc30/escapeHtml` 各自实现 | 少转一个单引号就是 XSS，改一处不影响另一处 |
| 弹窗 | 4 套 `modal()` + 17 处手拼 `modal-overlay` | 有的按 Esc 能关，有的不能；有的锁滚动，有的不锁 |
| 气泡渲染 | `tabs.js` 定义 → `workspace` 用 `window.msgHTML=` 整篇替换 | 改气泡要翻三个文件才知道哪份在跑 |
| 会话切换 | 4 个 `window.switchTab/openTab/newTab/sendRaw` 覆盖 | 排查先数加载顺序 |
| 房间消息 | `init` → `fusion` 覆盖 → `workspace` 再包 | 头像补丁和渲染纠缠在一起 |
| toast | `utils` 单例 + `ui-kit` 栈式两套 | 同一句提示走不同门路长得不同 |
| 路由 | `pageFromPath` 的 map 漏登记 `rooms` 和 8 个 `models-*` | 页面存在、`switchPage` 也支持，但 hash 直达被弹回 chat |

### 改后

```
转义      core/dom.js 一份，5 处一行转发
弹窗      core/ui-kit.js 一份实现 + 3 个薄适配器 + adoptOverlay 行为接管
气泡      tabs.js msgHTMLBase 渲染 → msgHTML 唯一入口 → pwDecorateMsg 可选钩子
会话      tabs.js 基础实现 + chatChannel 接口（无此对象时行为与原来一致）
toast     core/utils.js 一份，ui.toast 转发过去，type 只改边框色
路由      每个 #page-xxx 都在 map 里登记
```

### 门禁：`dev/arch_lint.py`

```
python3 dev/arch_lint.py            # 检查，有新增违规退出 1
python3 dev/arch_lint.py --all      # 连存量一起列
python3 dev/arch_lint.py --update   # 收紧基线（只在真的修掉存量后用）
```

| 规则 | 拦什么 |
|---|---|
| R1 | `var oldXxx = xxx;` 后接 `window.xxx = function` —— 包装链特征 |
| R2 | 除 `core/dom.js` 外自建 `esc/esc30/escapeHtml` |
| R3 | 除 `core/utils.js` 外自建 `toast` |
| R4 | 手工拼 `modal-overlay` 却既不 `adoptOverlay` 也不用 `ui.modal`，自己也没处理 Esc |

自测过门禁本身：造 2 条违规 → exit 1 并点名文件和行号；删掉 → exit 0。

### 真机验证（不是 jsdom）

`dev/hermes-dev.sh probe` 走 8650 的真实页面：

- **全站逐页**全部 `hits: []`（无横向溢出），逐页可达（当轮 DOM 里 23 个容器，
  现为 22 个可导航页 ＋ 3 个废弃别名）
- 弹窗行为 9 项全 true：挂载 / `.modal-overlay` 类 / legacy `.modal` 类 / bodyHTML /
  footerHTML / `role=dialog` / 滚动锁 / Esc 关闭 / 关闭后解锁
- 真实业务弹窗（定时任务 → 创建任务）：`adopted: true`、`z-index: 6001`、`locked: true`
- 截图核对：遮罩生效、表单无重叠、按钮样式正常

### 这轮踩到的坑

1. **`jsdom` 里 `document.body.style.overflow` 保持 hidden 不一定是 bug**——两个弹窗同时开着时，
   关掉一个不解锁是正确行为。我第一次就是这么误判的，后来把测试顺序改对了才看清。
2. **不要因为「它已经有 Esc」就完全跳过接管**——cron 三个弹窗自己有 Esc，但没锁滚动、
   没还原焦点。`adoptOverlay(el, {esc:false, trap:false})` 只补缺的部分，才不会双触发。
3. **`document.querySelector('.modal-overlay')` 会抓到隐藏的模板节点**——cron 页同时存在 6 个，
   必须用 `getClientRects().length > 0` 过滤出可见的那个再断言。
4. **`deploy ui` 会自动重算 `?v=` 版本号**（md5 前 8 位），不用手动 bump；但要先部署再测，
   否则测的是旧文件——我有一轮就是这样「验证通过」的。
