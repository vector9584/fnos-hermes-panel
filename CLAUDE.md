# 外部改造入口

你正在改一台 **fnOS NAS 上跑着的 Hermes Agent fpk 应用**：它既是 AI 助手，也是控制面板的后端。
下面假设你已经通过 SSH 接进去，运行的审计身份对这几个目录有读写权限（改文件不需要 sudo）。

```bash
APP_DIR=<应用运行目录>        # 升级会整目录覆盖，改这里的东西等于白改
SRC_REPO=<本仓库检出位置>      # 面板前端 + 后端 + 脚本，就是你现在看的这个
PY_SRC=<Python 内核检出位置>   # 上游 Hermes 的 Python 层，独立 git 仓库
HERMES_HOME=<数据目录>         # config.yaml / .env / sessions / skills / knowledge
LOGDIR=<日志目录>              # hermes.log / gateway.log / info.log
```

具体路径看 `dev/hermes-dev.sh` 开头的默认值——它把提权和路径都封装了，你不需要知道绝对路径。

## 动手前必须做的两件事

1. **读完 `dev/外部改造手册.md`**：完整命令、调试、备份、雷区、故障处置。
2. **读 `app/ui/ARCHITECTURE.md`**：板块 → 页面 → 属主文件的表、覆盖链（哪些符号改了不生效）、组件契约。
   改 UI 之前不看这份，大概率改到死代码上。

## 四层代码与生效方式

| 层 | 位置 | 生效方式 |
|---|---|---|
| 面板前端 | `app/ui/`：`index.html`（静态容器）+ `js/`（80 个模块）+ `css/` | 刷新浏览器，**不用重启**；但要重新部署并同步 `?v=` |
| 面板后端 | `app/server/monitor.js` + 56 个 `panel-*.js` 接口模块 | 必须重启 |
| Python 内核 | `PY_SRC`（editable install） | 改文件 + 重启 |
| 配置 | `HERMES_HOME/config.yaml` | 走面板接口，或重启 |

**面板前端已经不是单文件了。** 如果哪份文档还在说"`ui/index.html` 是个 1 MB 单文件"，
那是拆分（2026-11-04 ~ 11-17）之前的说法。现在 `index.html` 只有 65 KB，逻辑全在 `app/ui/js/`。

## 命令速查

```bash
cd $SRC_REPO

dev/hermes-dev.sh status                          # 进程 / 端口 / 运行文件 vs 源码 md5 / git
dev/hermes-dev.sh check app/ui/js/chat/tabs.js    # node --check 或 py_compile
dev/hermes-dev.sh deploy ui                       # 源→运行，不重启（自动重算 ?v=）
dev/hermes-dev.sh deploy server                   # 源→运行 + 重启 + 等 socket
dev/hermes-dev.sh probe --viewports 375x812,1440x900   # 无头截图 + 横向溢出检测
dev/hermes-dev.sh probe --eval "表达式" --click "text=设置"
dev/hermes-dev.sh preview 8917                    # 隔离静态预览：只读 app/ui，无后端，不碰生产
dev/hermes-dev.sh restart
dev/hermes-dev.sh rollback ui/index.html
dev/hermes-dev.sh snapshot                        # 完整快照（关键文件 + git bundle）
dev/hermes-dev.sh logs 60
dev/hermes-dev.sh repair                          # 升级后重建 Python 层 git 指针
```

标准流程：**改 `$SRC_REPO` → `check` → `deploy` → `probe` → `git commit`**。
Python 层直接改 `PY_SRC`，`git diff` 随时可见，`git checkout` 秒回。

## 六条铁律

1. **重启只有 `dev/hermes-dev.sh restart`**。禁止 `pkill`、禁止 root 直跑启动脚本、
   禁止拿"只重启面板进程"冒充 monitor 已生效——改了 `monitor.js` 必须应用级重启。
2. **写运行文件用 `cat src > dst`，不要 `cp`**——`cp` 改属主，之后 fnOS 写 PID 失败会无限重启。
3. **升级会整目录覆盖 `APP_DIR`** → UI / JS 改完必须回流 `$SRC_REPO` 并 push。
4. **改任何 JS/CSS 都要同步 `?v=`**（文件 md5 前 8 位），否则是缓存假象。`deploy ui` 会自动算。
5. **别起第二个 gateway**（`--force` 会写坏共享 state）。
6. **比对运行文件与源码前先 `tr -d '\r'`**——运行文件是 CRLF，裸 `diff` 会上万行假差异。

## 交差要求

改完必须做两件事：

1. `git commit`（前端仓库和 Python 内核仓库各自提交）
2. 写一条改动记录（动了什么 / 为什么 / 怎么验证的 / 怎么回滚）

第二条不是形式主义。半年后回来的人（包括你自己）只有这份记录能告诉他"当时为什么不选另一条路"。

完整版见 `dev/外部改造手册.md`，结构问题见 `app/ui/ARCHITECTURE.md`，踩过的坑见 `JOURNEY.md`。
