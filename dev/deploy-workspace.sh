#!/usr/bin/env bash
# Publish the complete candidate runtime tree while preserving the app owner.
# The script is intended to run from the source checkout on the NAS. It never
# deletes files outside the candidate manifest; production restart is delegated
# to the one reviewed dev/hermes-dev.sh restart command.
set -euo pipefail

SRC_REPO=${SRC_REPO:-/vol1/@apphome/hermes-agent/data/workspace/fnos-hermes-agent-src}
APP_DIR=${APP_DIR:-/vol1/@appcenter/hermes-agent}
DATA_DIR=${DATA_DIR:-/vol1/@apphome/hermes-agent/data}
NODE_BIN=${NODE_BIN:-$DATA_DIR/node/bin/node}
PY_BIN=${PY_BIN:-$DATA_DIR/venv/bin/python3}
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP=${BACKUP:-$DATA_DIR/backups/workspace-$STAMP}

usage() {
  printf '%s\n' "用法: $0 [--restart|--no-restart]" >&2
  printf '%s\n' '完整铺设 app/server、app/ui 和 app/python → hermes-src。' >&2
  printf '%s\n' '默认只在 server/python 有实际变更时重启；ui 改动刷新浏览器即可，重启会掐断全部活跃会话。' >&2
  printf '%s\n' '  --restart     无论改了哪层都重启' >&2
  printf '%s\n' '  --no-restart  一律不重启' >&2
}

[[ $# -le 1 ]] || { usage; exit 2; }
NO_RESTART=0
FORCE_RESTART=0
case ${1:-} in
  --no-restart) NO_RESTART=1 ;;
  --restart)    FORCE_RESTART=1 ;;
  '')           ;;
  *)            usage; exit 2 ;;
esac

as_agent() {
  if [[ $(id -un) == hermes-agent ]]; then
    env HOME="$DATA_DIR" "$@"
  else
    sudo -n -u hermes-agent env HOME="$DATA_DIR" "$@"
  fi
}

die() { printf '❌ %s\n' "$*" >&2; exit 1; }

[[ -d $SRC_REPO ]] || die "源码目录不存在: $SRC_REPO"
[[ -x $NODE_BIN ]] || die "Node 不可执行: $NODE_BIN"
[[ -x $PY_BIN ]] || die "Python 不可执行: $PY_BIN"
[[ -x $SRC_REPO/dev/hermes-dev.sh ]] || die "缺少唯一重启入口: $SRC_REPO/dev/hermes-dev.sh"

SOURCE_FILES=()
while IFS= read -r source_entry; do
  [[ -n $source_entry ]] && SOURCE_FILES+=("$source_entry")
done < <(
  git -C "$SRC_REPO" ls-files app/server app/ui app/python |
    grep -vE '(^|/)\.bak(-|\.)|\.bak-|(^|/)__pycache__/|\.pyc$' |
    sort
)
(( ${#SOURCE_FILES[@]} > 0 )) || die '候选运行清单为空'

destination_rel() {
  local rel=${1#app/}
  case "$rel" in
    python/*) printf 'hermes-src/%s\n' "${rel#python/}" ;;
    server/*|ui/*) printf '%s\n' "$rel" ;;
    *) die "未支持的候选路径: $rel" ;;
  esac
}

sha256() { sha256sum "$1" | awk '{print $1}'; }

hardlink_count() {
  if stat -c '%h' "$1" >/dev/null 2>&1; then
    stat -c '%h' "$1"
  else
    stat -f '%l' "$1"
  fi
}

check_source() {
  local source=$1
  [[ -f $source && ! -L $source ]] || die "候选源不是普通文件: $source"
  case "$source" in
    *.js) as_agent "$NODE_BIN" --check "$source" >/dev/null ;;
    *.py) PYTHONDONTWRITEBYTECODE=1 as_agent "$PY_BIN" -B -c \
      'import ast,sys; ast.parse(open(sys.argv[1],encoding="utf-8").read(),filename=sys.argv[1])' "$source" ;;
  esac
}

atomic_copy() {
  local source=$1 target=$2
  as_agent sh -c '
    set -eu
    src=$1; dst=$2
    dir=$(dirname "$dst")
    mkdir -p "$dir"
    tmp=$(mktemp "$dir/.hermes-publish.XXXXXX")
    trap '\''rm -f "$tmp"'\'' EXIT
    cat "$src" > "$tmp"
    if [ -e "$dst" ]; then chmod --reference="$dst" "$tmp" 2>/dev/null || true; fi
    mv -f "$tmp" "$dst"
    trap - EXIT
  ' sh "$source" "$target"
}

[[ ! -e $BACKUP ]] || die "备份目录已存在，为避免覆盖旧回滚点而停止: $BACKUP"
as_agent mkdir -p "$BACKUP"
as_agent sh -c 'printf "%s\n" "$1" > "$2"' sh \
  'source	destination	action	sha256	backup_sha256' "$BACKUP/MANIFEST.tsv"
manifest_line() {
  as_agent sh -c 'printf "%s\n" "$1" >> "$2"' sh "$1" "$BACKUP/MANIFEST.tsv"
}
changed=0
created=0
kept=0
backend_changed=0   # server/ 或 python/ 的实际变更数，决定是否需要重启

for source_entry in "${SOURCE_FILES[@]}"; do
  source="$SRC_REPO/$source_entry"
  rel=${source_entry#app/}
  dest_rel=$(destination_rel "$source_entry")
  target="$APP_DIR/$dest_rel"
  check_source "$source"
  candidate_hash=$(sha256 "$source")

  if [[ -f $target && ! -L $target ]] && cmp -s "$source" "$target"; then
    manifest_line "$rel\t$dest_rel\tkeep\t$candidate_hash\t$candidate_hash"
    kept=$((kept + 1))
    continue
  fi

  backup_hash=''
  if [[ -e $target || -L $target ]]; then
    [[ ! -L $target ]] || die "运行目标是符号链接，拒绝覆盖: $target"
    [[ $(hardlink_count "$target") == 1 ]] || die "运行目标是硬链接，拒绝原子替换: $target"
    backup_file="$BACKUP/$dest_rel"
    as_agent mkdir -p "$(dirname "$backup_file")"
    as_agent sh -c 'cat "$1" > "$2"' sh "$target" "$backup_file"
    backup_hash=$(sha256 "$backup_file")
  fi

  atomic_copy "$source" "$target"
  [[ -f $target && ! -L $target ]] || die "写入后目标不存在: $target"
  actual_hash=$(sha256 "$target")
  [[ $actual_hash == "$candidate_hash" ]] || die "目标校验失败: $dest_rel"
  action=create
  if [[ -n $backup_hash ]]; then action=replace; changed=$((changed + 1)); else created=$((created + 1)); fi
  case $rel in
    ui/*) ;;
    *) backend_changed=$((backend_changed + 1)) ;;
  esac
  manifest_line "$rel\t$dest_rel\t$action\t$candidate_hash\t$backup_hash"
done

# 发布后清理：候选清单只会覆盖/新增，从不删除目标端旧文件。
# 结果就是历次手工备份（*.bak-* / *.bak.* / *.bak2-*）永久堆在生产目录里，
# 而且被静态服务直接取到（2026-11-13 实测 /app/hermes-agent/js/panel-durable.js.bak-* 回 200/48276B）。
# 这里只按备份命名模式清理，不碰 git 未跟踪的 images/ scripts/ 等资产。
pruned=0
while IFS= read -r stale; do
  [[ -n $stale ]] || continue
  as_agent rm -f "$stale"
  pruned=$((pruned + 1))
done < <(find "$APP_DIR/ui" -type f \( -name '*.bak-*' -o -name '*.bak.*' -o -name '*.bak2-*' \) -print 2>/dev/null || true)
(( pruned == 0 )) || printf '🧹 已清理生产目录残留备份: %d 个\n' "$pruned"

printf 'Workspace backup: %s\n' "$BACKUP"
printf 'Candidate files: %d (kept=%d replaced=%d created=%d)\n' \
  "${#SOURCE_FILES[@]}" "$kept" "$changed" "$created"
printf 'Manifest: %s\n' "$BACKUP/MANIFEST.tsv"

printf 'Backend files changed (server/python): %d\n' "$backend_changed"

if (( NO_RESTART )); then
  printf '%s\n' '⚠️  已按 --no-restart 跳过重启；含 server/Python 变更时必须随后执行: dev/hermes-dev.sh restart'
elif (( FORCE_RESTART )); then
  printf '%s\n' '↻ 按 --restart 强制重启...'
  cd "$SRC_REPO"
  dev/hermes-dev.sh restart
elif (( backend_changed == 0 )); then
  printf '%s\n' '✅ 仅 ui 变更，已跳过重启 —— 刷新浏览器即生效。重启会掐断全部活跃会话，不是刷新手段。'
else
  printf '%s\n' '↻ server/python 有变更，执行重启...'
  cd "$SRC_REPO"
  dev/hermes-dev.sh restart
fi
