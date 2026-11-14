#!/bin/bash
# make-release.sh — 从 git 已提交内容导出一份干净源码包
#
# 为什么用 git archive 而不是 tar czf .：
#   tar 会把未跟踪的文件一起打进去——.env、备份、__pycache__、本地临时脚本。
#   git archive 只认已提交的内容，天然排除这些，不需要维护排除清单。
#
# 用法：
#   bash dev/make-release.sh                 # 打 HEAD
#   bash dev/make-release.sh <ref>           # 打指定提交/分支
#   bash dev/make-release.sh HEAD dist       # 指定输出目录
set -euo pipefail

REF=${1:-HEAD}
OUT=${2:-dist}
SHORT=$(git rev-parse --short "$REF")
NAME="fnos-hermes-panel-$SHORT"

mkdir -p "$OUT"
ZIP="$OUT/$NAME.zip"

git archive --format=zip --prefix="$NAME/" -o "$ZIP" "$REF"

# 构建产物不进源码包：outputs/ 是历史打包/回滚快照（本地 72 MB），
# dist/ 是本脚本自己的输出。它们已被 git 跟踪，所以只能打完再剔。
for junk in outputs dist preview; do
  zip -q -d "$ZIP" "$NAME/$junk/*" >/dev/null 2>&1 || true
done

SIZE=$(stat -c %s "$ZIP" 2>/dev/null || stat -f %z "$ZIP")
FILES=$(unzip -l "$ZIP" | tail -1 | awk '{print $2}')

echo "产物: $ZIP"
echo "大小: $((SIZE / 1024)) KB"
echo "文件: $FILES 个"

# 硬检查：包里绝不能出现敏感文件
if unzip -l "$ZIP" | grep -qE '(^|/)\.env$|\.env\.local$|\.git/|node_modules/|__pycache__/|\.sqlite3?$'; then
  echo "✗ 包里出现不该有的文件，中止" >&2
  unzip -l "$ZIP" | grep -E '\.env$|node_modules/|__pycache__/' >&2
  rm -f "$ZIP"
  exit 1
fi
echo "✓ 敏感文件检查通过（无 .env / .git / node_modules / __pycache__）"
