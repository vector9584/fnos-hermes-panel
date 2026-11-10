#!/bin/bash
# 核对：生产运行文件是否等于 git 里的生产快照
#
# 用法：
#   dev/verify-prod.sh                    # UI/server/bin 对 prod/20261110，Python 对 prod/python-20261110
#   dev/verify-prod.sh <commit-ish>       # UI/server/bin 对任意提交
#   PY_REF=xxx dev/verify-prod.sh         # 改 Python 层对照 ref
#   SKIP_PY=1 dev/verify-prod.sh          # 只核 UI/server/bin（Python 层无 git 时用）
#
# 为什么需要它：这台的运行文件历史上只靠"本地冻结包 + 哈希记录"追溯，
# NAS 的 git checkout 长期停在 fc942d3（旧版 12,325 行 monitor.js），
# 谁从 checkout 起手改后端，一个覆盖就把 9,198 行新版吃掉。
# 2026-11-10 把 Mac 全量 bundle 灌进来后，生产代码可从 git 重建，此脚本做核验。
#
# 2026-11-10 扩版：原来只核 ui/server/bin，Python 内核层（hermes-src）有 20 项
# 未提交漂移游离在 git 之外 —— 那是下一个会咬人的点。现在补上 B 段。
set -u

SRC="$(cd "$(dirname "$0")/.." && pwd)"
APP="${APP_DIR:-/vol1/@appcenter/hermes-agent}"
REF="${1:-prod/20261110}"

PY_SRC="${PY_DIR:-$APP/hermes-src}"
PY_REF="${PY_REF:-prod/python-20261110}"
VENV_SP="${VENV_SP:-/vol1/@apphome/hermes-agent/data/venv/lib/python3.11/site-packages}"

cd "$SRC" || exit 1

if ! git rev-parse --verify "$REF" >/dev/null 2>&1; then
  echo "FAIL: 找不到 ref '$REF'"
  exit 1
fi

echo "核对 ref = $REF ($(git rev-parse --short "$REF"))"
echo "生产目录 = $APP"
echo ""

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

git worktree add --detach "$TMP/wt" "$REF" >/dev/null 2>&1 || {
  echo "FAIL: 无法创建 worktree"
  exit 1
}

fail=0
missing=0
checked=0

# ---------- A. UI / server / bin ----------
echo "--- A. UI / server / bin（逐字节比对 $REF） ---"
for d in ui server bin; do
  [ -d "$TMP/wt/app/$d" ] || continue
  [ -d "$APP/$d" ] || { echo "SKIP $d（生产无此目录）"; continue; }

  while IFS= read -r f; do
    rel="${f#"$TMP/wt/app/"}"
    prod="$APP/$rel"
    if [ ! -f "$prod" ]; then
      echo "MISSING  $rel"
      missing=$((missing+1))
    elif ! cmp -s "$f" "$prod"; then
      a=$(sha256sum "$f" | cut -c1-16)
      b=$(sha256sum "$prod" | cut -c1-16)
      echo "DIFF     $rel   git=$a  prod=$b"
      fail=$((fail+1))
    fi
    checked=$((checked+1))
  done < <(find "$TMP/wt/app/$d" -type f \
             ! -name '*.bak*' ! -path '*__pycache__*' ! -name '.DS_Store')
done
echo "已比对 $checked 个文件（ui/server/bin）"
echo ""

# ---------- B. Python 内核层 ----------
py_fail=0
if [ "${SKIP_PY:-0}" != "1" ]; then
  echo "--- B. Python 内核（$PY_SRC） ---"
  if [ ! -e "$PY_SRC/.git" ]; then
    echo "FAIL      $PY_SRC 不是 git 仓库（.git 不存在）"
    py_fail=$((py_fail+1))
  else
    # B1. 工作区必须干净：游离改动 = 已部署但不可从 git 重建
    dirty="$(git -C "$PY_SRC" status --porcelain 2>/dev/null)"
    if [ -n "$dirty" ]; then
      n=$(printf '%s\n' "$dirty" | grep -c .)
      echo "DIRTY     Python 层有 $n 项未提交改动（已部署、但 git 重建不了）："
      printf '%s\n' "$dirty" | sed 's/^/            /'
      py_fail=$((py_fail+1))
    else
      echo "OK        Python 工作区干净"
    fi

    # B2. 生产 tag 必须存在，且是 HEAD 的祖先（开发中可以往前跑，但基线不能丢）
    if git -C "$PY_SRC" rev-parse --verify "$PY_REF^{commit}" >/dev/null 2>&1; then
      py_tag="$(git -C "$PY_SRC" rev-parse --short "$PY_REF^{commit}")"
      py_head="$(git -C "$PY_SRC" rev-parse --short HEAD)"
      if git -C "$PY_SRC" merge-base --is-ancestor "$PY_REF^{commit}" HEAD 2>/dev/null; then
        echo "OK        $PY_REF ($py_tag) 是 HEAD ($py_head) 的祖先"
      else
        echo "FAIL      $PY_REF ($py_tag) 不是 HEAD ($py_head) 的祖先 —— 基线被甩开了"
        py_fail=$((py_fail+1))
      fi
    else
      echo "FAIL      找不到 Python 层 ref '$PY_REF'"
      py_fail=$((py_fail+1))
    fi

    # B3. editable finder 必须指向 PY_SRC，否则装了个不代表运行时的包
    finder="$(ls "$VENV_SP"/__editable___hermes_agent*finder.py 2>/dev/null | head -1)"
    if [ -n "$finder" ]; then
      if grep -q "$PY_SRC" "$finder" 2>/dev/null; then
        echo "OK        editable finder 指向 $PY_SRC"
      else
        echo "FAIL      editable finder 未指向 $PY_SRC（运行时与源码脱钩）"
        py_fail=$((py_fail+1))
      fi
    else
      echo "WARN      找不到 editable finder（非 editable 安装？）"
    fi
  fi
  echo ""
else
  echo "--- B. Python 内核：SKIP_PY=1，已跳过 ---"
  echo ""
fi

# ---------- C. 孤儿目录 ----------
echo "--- C. 残留目录 ---"
if [ -d "$APP/python" ]; then
  echo "NOTE      $APP/python 仍在位（旧布局残留）"
  echo "          2026-11-10 全仓扫描 0 处引用：面板 openPath（monitor.js:3982）、"
  echo "          editable finder、cmd/config 全部指向 hermes-src。确认后可清。"
else
  echo "OK        无 app/python 残留"
fi
echo ""

# ---------- 汇总 ----------
total_fail=$((fail + py_fail))
if [ "$total_fail" -eq 0 ] && [ "$missing" -eq 0 ]; then
  echo "OK  生产运行文件与 $REF 逐字节一致；Python 内核与 $PY_REF 对齐"
  exit 0
fi
echo "有差异：UI/server/bin $fail 个文件内容不同、$missing 个缺失；Python 层 $py_fail 项不达标"
echo ""
echo "已知无害差异（2026-11-10 记录）："
echo "  server/panel-models.js —— a42a51f 删了一行永不触发的死校验"
echo "  （localHttp 时 records 恒为长度 1，该 throw 不可达），未部署到生产，功能无差别"
exit 2
