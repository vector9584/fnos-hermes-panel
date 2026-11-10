#!/bin/bash
# 验证 HEAD 中的 app/ 与 cmd/ 是否与生产运行目录逐字节一致
# 路径映射（fnOS fpk 布局）：
#   git app/*  -> /vol1/@appcenter/hermes-agent/*   （应用安装/运行目录）
#   git cmd/*  -> /var/apps/hermes-agent/cmd/*      （fnOS 生命周期脚本目录）
set -u
REPO="/vol1/@apphome/hermes-agent/data/workspace/fnos-hermes-agent-src"
PROD="/vol1/@appcenter/hermes-agent"
CMDDIR="/var/apps/hermes-agent/cmd"
cd "$REPO" || exit 1

SAME=0; DIFF=0; MISS=0; KNOWN=0
DIFFLIST=""
: > /tmp/align_missing.txt
: > /tmp/align_known.txt

check_one() {
  local gitpath="$1" prodpath="$2"
  # 已知漂移例外：fnOS 生命周期入口。git 内为 panel_lifecycle.py 转发版（890 B），
  # 生产仍在跑 2026-08-24 fpk 安装时的 bash PID 管理版（4,365 B），尚未切换。
  if [ "$gitpath" = "cmd/main" ]; then
    KNOWN=$((KNOWN+1))
    echo "KNOWN    cmd/main（git=转发版，生产=8-24 安装版，未切换）" >> /tmp/align_known.txt
    return
  fi
  if [ ! -f "$prodpath" ]; then
    MISS=$((MISS+1)); echo "MISSING  $prodpath" >> /tmp/align_missing.txt; return
  fi
  local a b
  a=$(git cat-file -p "HEAD:$gitpath" 2>/dev/null | sha256sum | cut -d' ' -f1)
  b=$(sha256sum "$prodpath" 2>/dev/null | cut -d' ' -f1)
  if [ "$a" = "$b" ]; then
    SAME=$((SAME+1))
  else
    DIFF=$((DIFF+1)); DIFFLIST="${DIFFLIST}DIFF $gitpath\n"
  fi
}

while IFS= read -r f; do
  check_one "$f" "$PROD/${f#app/}"
done < <(git ls-files 'app/*')

while IFS= read -r f; do
  check_one "$f" "$CMDDIR/${f#cmd/}"
done < <(git ls-files 'cmd/*')

echo "================ 对账结果 ================"
echo "一致    : $SAME"
echo "不同    : $DIFF"
echo "生产缺失 : $MISS"
echo "已知漂移 : $KNOWN"
echo
if [ "$DIFF" -gt 0 ]; then
  echo "--- 差异明细 ---"
  printf "$DIFFLIST"
fi
if [ "$MISS" -gt 0 ]; then
  echo "--- 生产缺失明细（前 20）---"
  head -20 /tmp/align_missing.txt
fi
if [ "$KNOWN" -gt 0 ]; then
  echo "--- 已知漂移 ---"
  cat /tmp/align_known.txt
fi
echo "=========================================="
[ "$DIFF" -eq 0 ] && [ "$MISS" -eq 0 ] && echo "VERDICT: PASS — git checkout 可重建生产（cmd/main 除外，见已知漂移）" || echo "VERDICT: CHECK"
