#!/usr/bin/env bash
# hermes-dev.sh — 外部工具改 Hermes 的唯一入口（改 → 验 → 生效 → 回执）
# 用法: dev/hermes-dev.sh <status|check|deploy|sync-back|restart|probe|rollback|logs> [参数]
set -uo pipefail

HERMES_HOME=/vol1/@apphome/hermes-agent/data
APP_DIR=/vol1/@appcenter/hermes-agent
SRC_REPO=$HERMES_HOME/workspace/fnos-hermes-agent-src
PY_BIN=$HERMES_HOME/venv/bin/python3
FNOS_CLI=$HERMES_HOME/.local/bin/fnos-cli
SOCK=$APP_DIR/hermes-agent.sock
LOGDIR=/vol1/@appdata/hermes-agent
# node 不在 vector 的 PATH 里，显式探
NODE_BIN=$(command -v node 2>/dev/null || echo "$HERMES_HOME/node/bin/node")
# 注: node 二进制是 -rwxr-x---，vector 下 -x 测不出，统一用 as_agent 执行

# 以 hermes-agent 身份执行（外部 SSH 用户是 vector 时必须绕一层）
as_agent() {
  if [ "$(id -un)" = "hermes-agent" ]; then
    env HOME=$HERMES_HOME "$@"
  else
    sudo -n -u hermes-agent env HOME=$HERMES_HOME "$@"
  fi
}

restart_app() {
  echo "--- 重启 hermes-agent（会掐断正在跑的会话）---"
  as_agent $FNOS_CLI --profile nas app restart hermes-agent --yes 2>&1 | tail -5
  echo "--- 等 socket ---"
  for i in $(seq 1 30); do
    [ -S "$SOCK" ] && curl -s --unix-socket "$SOCK" -o /dev/null -w "socket up (%{http_code})\n" http://localhost/api/health && return 0
    sleep 1
  done
  echo "!! socket 30s 未就绪，去看 $LOGDIR/info.log"; return 1
}

proc_start() {  # 进程启动时间（epoch）
  local pid
  pid=$(pgrep -f "server/monitor.js" | head -1)
  [ -n "$pid" ] && date -d "$(ps -o lstart= -p $pid)" +%s 2>/dev/null || echo 0
}

cmd_status() {
  echo "== 进程 =="
  pgrep -af "monitor.js|hermes gateway|dashboard" | sed 's/ --.*//' | cut -c1-120
  echo "== 端口 =="
  ss -lntp 2>/dev/null | grep -E ":(8650|8742|9219)\b" || echo "无 8650/8742/9219"
  echo "== 进程启动 vs 文件 mtime =="
  local ps0
  ps0=$(proc_start)
  echo "monitor 启动: $(date -d @${ps0:-0} '+%F %T' 2>/dev/null)"
  for f in ui/index.html server/monitor.js hermes-src/agent/conversation_loop.py; do
    [ -e "$APP_DIR/$f" ] && echo "  $(date -r "$APP_DIR/$f" '+%F %T')  $f"
  done
  echo "== 运行文件 vs git 源 =="
  for p in ui/index.html server/monitor.js; do
    if [ -f "$SRC_REPO/app/$p" ]; then
      a=$(md5sum "$APP_DIR/$p" | cut -d' ' -f1); b=$(md5sum "$SRC_REPO/app/$p" | cut -d' ' -f1)
      [ "$a" = "$b" ] && echo "  ✅ 一致  $p" || echo "  ⚠️  不一致 $p (run=$a src=$b)"
    fi
  done
  echo "== git =="
  git -C "$SRC_REPO" log --oneline -1 2>/dev/null
  git -C "$SRC_REPO" status --porcelain 2>/dev/null | head -5
}

cmd_check() {
  local ok=0
  for f in "$@"; do
    case "$f" in
      *.py)
        $PY_BIN -m py_compile "$f" 2>&1 && echo "✅ py_compile $f" || { echo "❌ py_compile $f"; ok=1; }
        ;;
      *.js|*.html)
        local tmp=/tmp/_chk_$$.js
        if [ "${f##*.}" = html ]; then
          $PY_BIN - "$f" "$tmp" <<'EOF' || ok=1
import re,sys
s=open(sys.argv[1],encoding='utf-8').read()
blk=re.findall(r'<script[^>]*>(.*?)</script>', s, re.S)
open(sys.argv[2],'w').write(max(blk,key=len) if blk else '')
EOF
        else cp "$f" "$tmp"; fi
        as_agent "${NODE_BIN:-node}" --check "$tmp" 2>&1 && echo "✅ node --check $f" || { echo "❌ node --check $f"; ok=1; }
        rm -f "$tmp"
        ;;
    esac
  done
  return $ok
}

cmd_deploy() {
  local what=${1:-}; local do_restart=1
  [ "${2:-}" = "--no-restart" ] && do_restart=0
  local stamp; stamp=$(date +%Y%m%d_%H%M%S)
  case "$what" in
    ui|server)
      local f="index.html"; [ "$what" = server ] && f="monitor.js"
      local rel="$what/$f"
      [ -f "$SRC_REPO/app/$rel" ] || { echo "❌ git 源缺 $rel"; return 1; }
      cmd_check "$SRC_REPO/app/$rel" || { echo "❌ 语法不过，不部署"; return 1; }
      mkdir -p "$HERMES_HOME/backups"
      cp "$APP_DIR/$rel" "$HERMES_HOME/backups/$(basename $f).$stamp.bak"
      # 用 cat > 原地写，保住 hermes-agent 属主（cp 覆盖会把属主改成当前用户）
      cat "$SRC_REPO/app/$rel" > "$APP_DIR/$rel"
      echo "已部署 $rel  (备份: backups/$(basename $f).$stamp.bak)"
      md5sum "$APP_DIR/$rel" "$SRC_REPO/app/$rel"
      if [ "$what" = ui ]; then
        echo "✅ UI 是静态文件，浏览器刷新即生效，不用重启"
      elif [ "$do_restart" = 1 ]; then
        restart_app && echo "✅ monitor.js 已生效"
      else
        echo "⚠️  需要重启才生效：dev/hermes-dev.sh restart"
      fi
      ;;
    py)
      local files; files=$(cd "$SRC_REPO" && git status --porcelain 2>/dev/null | awk '{print $2}' | grep '\.py$')
      echo "Python 没有 git 源，直接改 $APP_DIR/hermes-src；这里只做检查 + 重启"
      cmd_check ${files:-} || true
      [ "$do_restart" = 1 ] && restart_app
      ;;
    *) echo "用法: deploy <ui|server|py> [--no-restart]"; return 1;;
  esac
}

cmd_sync_back() {  # 运行文件 → git 源（调试期用）
  local stamp; stamp=$(date +%Y%m%d_%H%M%S)
  for p in ui/index.html server/monitor.js; do
    [ -f "$APP_DIR/$p" ] || continue
    if ! diff -q <(tr -d '\r' < "$APP_DIR/$p") <(tr -d '\r' < "$SRC_REPO/app/$p") >/dev/null; then
      cp "$SRC_REPO/app/$p" "$HERMES_HOME/backups/$(basename $p).$stamp.bak"
      cp "$APP_DIR/$p" "$SRC_REPO/app/$p"
      echo "↩ 已回流 $p"
    fi
  done
  git -C "$SRC_REPO" status --porcelain | head -10
}

cmd_rollback() {
  local f=${1:-}
  [ -z "$f" ] && { echo "用法: rollback <路径或文件名>"; ls -t "$HERMES_HOME/backups" 2>/dev/null | head -8; return 1; }
  local bak; bak=$(ls -t "$HERMES_HOME/backups/"*"$(basename $f)"* 2>/dev/null | head -1)
  [ -z "$bak" ] && { echo "❌ 找不到备份"; return 1; }
  local target="$f"; [[ "$f" != /* ]] && target="$APP_DIR/$f"
  cat "$bak" > "$target"
  echo "已回滚 $target ← $bak"; md5sum "$target" "$bak"
}

cmd_repair() {  # 升级/重装后重建 Python 层 git 指针与排除表（幂等）
  local PY_SRC=/vol1/@appcenter/hermes-agent/hermes-src
  local GD=$HERMES_HOME/workspace/hermes-src.git
  local EX=$HERMES_HOME/workspace/hermes-src.exclude
  [ -f "$EX" ] || cat > "$EX" <<'XEOF'
__pycache__/
*.pyc
*.pyo
*.egg-info/
.pytest_cache/
.mypy_cache/
.ruff_cache/
node_modules/
ui-tui/dist/
*.log
.venv/
XEOF
  if [ ! -f "$PY_SRC/.git" ]; then
    echo "gitdir: $GD" > "$PY_SRC/.git"; echo "↩ 已重建 $PY_SRC/.git 指针"
  fi
  ( cd "$PY_SRC" && git config core.excludesFile "$EX" && git config user.name hermes-agent \
    && git config user.email hermes-agent@nas.local && git config core.autocrlf false )
  ( cd "$PY_SRC" && echo "Python 层仓库: $(git log --oneline -1 | cat)" && git status --porcelain | head -10 \
    && echo "未提交改动: $(git status --porcelain | wc -l) 个文件" )
}

cmd_snapshot() {  # 打一份可异地存放的完整快照（关键文件 + 两个仓库的 bundle）
  local ts out tmp
  ts=$(date +%Y%m%d-%H%M%S)
  out=$HERMES_HOME/backup/snapshots; mkdir -p "$out"
  tmp=$(mktemp -d) || return 1
  mkdir -p "$tmp/files"
  cp "$APP_DIR/ui/index.html" "$tmp/files/" 2>/dev/null
  cp "$APP_DIR/server/monitor.js" "$tmp/files/" 2>/dev/null
  cp /var/apps/hermes-agent/cmd/main "$tmp/files/" 2>/dev/null
  cp "$HERMES_HOME/config.yaml" "$tmp/files/" 2>/dev/null
  ( cd "$HERMES_HOME/workspace/hermes-src.git" && git bundle create "$tmp/hermes-src.bundle" --all >/dev/null 2>&1 )
  ( cd "$SRC_REPO" && git bundle create "$tmp/fpk-src.bundle" --all >/dev/null 2>&1 )
  tar czf "$out/hermes-$ts.tar.gz" -C "$tmp" . && rm -rf "$tmp"
  echo "快照: $out/hermes-$ts.tar.gz"
  ls -lh "$out/hermes-$ts.tar.gz" | awk '{print "大小:", $5}'
  tar tzf "$out/hermes-$ts.tar.gz" | head -8
}

cmd_probe() { $PY_BIN "$(dirname "$0")/ui_probe.py" "$@"; }

# 隔离静态预览：serve 源码里的 app/ui，只读，不碰运行目录、不碰后端、不碰生产数据
# 零特权需求 —— 内部已按需切到 hermes-agent（脚本顶部统一处理），vector 直接调用即可
cmd_preview() {
  local port="${1:-8917}"
  local dir="$SRC_REPO/app/ui"
  [ -f "$dir/index.html" ] || { echo "找不到 $dir/index.html"; exit 1; }
  echo "[preview] http://127.0.0.1:$port/"
  echo "[preview] 目录: $dir （只读静态，无后端）"
  echo "[preview] 能看到：配色/字体/间距/侧栏/按钮/输入框/空状态"
  echo "[preview] 看不到：消息气泡、工具区块、表格（没数据不渲染）"
  echo "[preview] 带真数据验收请用: dev/hermes-dev.sh probe"
  echo "[preview] Ctrl+C 退出"
  cd "$dir" && exec "$PY_BIN" -m http.server "$port" --bind 127.0.0.1
}

cmd_logs() {
  local n=${1:-40}
  for f in hermes.log gateway.log info.log; do
    echo "===== $f (末 $n 行) ====="
    tail -n "$n" "$LOGDIR/$f" 2>/dev/null
  done
}

case "${1:-status}" in
  status) cmd_status;;
  check) shift; cmd_check "$@";;
  deploy) shift; cmd_deploy "$@";;
  sync-back) cmd_sync_back;;
  restart) restart_app;;
  repair) cmd_repair;;
  snapshot) cmd_snapshot;;
  probe) shift; cmd_probe "$@";;
  preview) shift; cmd_preview "$@";;
  rollback) shift; cmd_rollback "$@";;
  logs) shift; cmd_logs "$@";;
  *) sed -n '2,5p' "$0";;
esac
