# Hermes Agent — 外部改造入口

你正在改一台 **fnOS NAS 上运行的 Hermes Agent fpk 应用**：它既是 AI 助手，也是控制面板的后端。
你是通过 SSH 接入的外部编程工具，登录身份 `vector`，对下面所有目录有读写权限（改文件不需要 sudo）。

```bash
APP_DIR=/vol1/@appcenter/hermes-agent            # 运行时
SRC_REPO=/vol1/@apphome/hermes-agent/data/workspace/fnos-hermes-agent-src  # UI/JS git 源
PY_SRC=/vol1/@appcenter/hermes-agent/hermes-src  # Python 内核（独立 git 仓库，基线 715201b）
HERMES_HOME=/vol1/@apphome/hermes-agent/data     # 配置/记忆/技能/知识库
LOGDIR=/vol1/@appdata/hermes-agent               # 日志
```

## 动手前必须做的两件事

1. **读完 `dev/外部改造手册.md`**（完整命令、调试、备份、雷区、故障处置）。
2. **通读内部档案**（比手册权威，冲突以档案为准）：
   - `$HERMES_HOME/skills/fnos-knowledge/fnos-hermes-fpk/SKILL.md` — 本机总纲（三进程/生命周期/自更新/已知坑）
   - `$HERMES_HOME/skills/fnos-knowledge/fnos-hermes-fpk/references/fpk-architecture.md`
   - `$HERMES_HOME/knowledge/项目/Hermes升级保护清单-2026-08-24.md` — 升级会覆盖什么、什么必须回流
   - `$HERMES_HOME/knowledge/项目/升级时间线-提交级对账-2026-08-24.md` — 每个补丁为什么打
   - `$HERMES_HOME/skills/fnos-knowledge/hermes-webui-dev/SKILL.md` — 改面板 UI 的流程与坑
   - `$HERMES_HOME/skills/software-development/hermes-runtime-patching/SKILL.md` — 打补丁→实测→固化

## 四层代码与生效方式

| 层 | 文件 | 生效 |
|---|---|---|
| 控制面板 UI | `$APP_DIR/ui/index.html`（1MB 单文件）、`ui/js/fusion-v030.js` | 刷新浏览器，**不用重启** |
| 面板后端 | `$APP_DIR/server/monitor.js`（Node，单文件） | 必须重启 |
| Python 内核 | `$PY_SRC/`（1070 个 py，editable install） | 改文件 + 重启 |
| 配置 | `$HERMES_HOME/config.yaml` | 面板接口或重启 |

## 命令速查

```bash
cd /vol1/@apphome/hermes-agent/data/workspace/fnos-hermes-agent-src

dev/hermes-dev.sh status      # 进程/端口/文件 mtime/运行vs源 md5/git
dev/hermes-dev.sh check <file>                    # node --check 或 py_compile
dev/hermes-dev.sh deploy ui                       # 源→运行，不重启
dev/hermes-dev.sh deploy server                   # 源→运行 + 重启 + 等 socket
dev/hermes-dev.sh probe --viewports 375x812,1440x900   # 无头截图 + 横向溢出检测
dev/hermes-dev.sh probe --eval "表达式" --click "text=设置"
dev/hermes-dev.sh preview 8917               # 隔离静态预览：只读 app/ui，无后端，不碰生产
dev/hermes-dev.sh restart
dev/hermes-dev.sh rollback ui/index.html
dev/hermes-dev.sh snapshot    # 完整快照（关键文件 + 两个 git bundle，~56M）
dev/hermes-dev.sh logs 60
dev/hermes-dev.sh repair      # 升级后重建 Python 层 git 指针
```

标准流程：**改 `$SRC_REPO` → `check` → `deploy` → `probe` → `git commit`**。Python 层直接改 `$PY_SRC`，`git diff` 随时可见，`git checkout` 秒回。

## 六条铁律

1. **重启只有 `dev/hermes-dev.sh restart`**（内部是 `sudo -n -u hermes-agent env HOME=… fnos-cli … app restart --yes`）。禁止 `pkill`、禁止 root 直跑 `cmd/main`、禁止拿 `monitor-api restart` 冒充生效。
2. **写运行文件用 `cat src > dst`，不要 `cp`** —— `cp` 改属主，之后 fnOS 写 PID 失败会无限重启。
3. **升级整目录覆盖 `$APP_DIR`** → UI/JS 改完必须回流 `$SRC_REPO` 并 push。
4. **改 `fusion-v030.js` 必须 bump `index.html` 里的 `?v=` 版本号**，否则是缓存假象。
5. **别起第二个 gateway**（`--force` 会写坏共享 state）。
6. **`diff` 运行文件 vs 源前先 `tr -d '\r'`** —— 运行文件是 CRLF，裸 diff 上万行假差异。

## 交差要求

改完必须：`git commit`（两个仓库各自）→ 在 `$HERMES_HOME/knowledge/项目/YYYY-MM-DD-<主题>.md` 写一条记录（动了什么/为什么/怎么验证的/怎么回滚）。
内部 agent 靠这条记录知道自己被谁改了什么。**不写等于埋雷。**

完整版见 `dev/外部改造手册.md`。
