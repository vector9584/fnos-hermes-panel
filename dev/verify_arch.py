#!/usr/bin/env python3
"""架构锚点与覆盖链的定点验证。

这不是测试套件。这个仓库没有 canonical 的 test/lint/build，所以这份脚本只能称
「ad-hoc 定点断言」：它验的是「文档给出来的锚点是不是真的能定位」「覆盖链的结论
是不是真的」「门禁是不是真的会拦」，而不是全量回归。

复跑：
    cd /vol1/@apphome/hermes-agent/data/workspace/fnos-hermes-agent-src
    python3 dev/verify_arch.py

第一条断言是「工作区干净」——不干净说明验的不是已提交的 HEAD，后面全部作废。
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UI = os.path.join(ROOT, "app", "ui")
DOC = os.path.join(UI, "ARCHITECTURE.md")
INDEX = os.path.join(UI, "index.html")

PASS = []
FAIL = []


def ck(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(("  ok   " if cond else "  FAIL ") + name + (("  " + detail) if detail else ""))


def git(*a):
    return subprocess.run(["git"] + list(a), cwd=ROOT, capture_output=True, text=True)


def main():
    head = git("rev-parse", "--short", "HEAD").stdout.strip()
    print("=" * 70)
    print("架构锚点与覆盖链验证   HEAD=%s" % head)
    print("=" * 70)

    # A 先证证据有效性
    st = git("status", "--porcelain").stdout.strip()
    ck("A0 工作区干净（否则验的不是 HEAD）", st == "", st[:120] or "clean")

    doc = open(DOC, encoding="utf-8").read()
    html = open(INDEX, encoding="utf-8").read()

    # B 行号列是否真的去掉了
    table = re.search(r"<!-- AUTO:业务表 -->(.*?)<!-- /AUTO:业务表 -->", doc, re.S)
    ck("B1 业务表自动区存在", bool(table))
    tb = table.group(1) if table else ""
    ck("B2 业务表不再有「index.html 行」列", "index.html 行" not in tb)
    ck("B3 业务表有「容器锚点」「主挂载点」「改了不生效」三列",
       all(k in tb for k in ("容器锚点", "主挂载点", "改了不生效")))

    rows = [l for l in tb.split("\n") if l.startswith("| ") and "`#/" in l]
    ck("B4 业务表 22 行页面", len(rows) == 22, "实测 %d" % len(rows))

    # C/D 锚点必须真实存在于 index.html
    bad_page, bad_mount, mounts = [], [], 0
    for l in rows:
        cells = [c.strip() for c in l.strip().strip("|").split("|")]
        anchor = cells[3].strip("`")
        mount = cells[4].strip("`")
        if anchor.startswith("#page-") and ('id="%s"' % anchor[1:]) not in html:
            bad_page.append(anchor)
        if mount.startswith("#"):
            mounts += 1
            if ('id="%s"' % mount[1:]) not in html:
                bad_mount.append(mount)
    ck("C1 22 个容器锚点在 index.html 里全部存在", not bad_page, str(bad_page))
    ck("D1 主挂载点 id 在 index.html 里全部存在", not bad_mount,
       str(bad_mount) + "（共验 %d 个）" % mounts)
    ck("D2 至少 18 个页面有真实主挂载点（不是「—」）", mounts >= 18, "%d 个" % mounts)

    # E 覆盖链结论
    sys.path.insert(0, os.path.join(ROOT, "dev"))
    import arch_symbols

    order, orows = arch_symbols.build()
    by = {r["symbol"]: r for r in orows}
    ck("E1 覆盖链 60 组", len(orows) == 60, "实测 %d" % len(orows))
    ck("E2 switchPage 生效=fusion-v030.js、死=core/router.js",
       by.get("switchPage", {}).get("winner") == "fusion-v030.js"
       and "core/router.js" in by.get("switchPage", {}).get("dead", []))
    ck("E3 toast 生效=core/ui-kit.js、死=core/utils.js",
       by.get("toast", {}).get("winner") == "core/ui-kit.js"
       and "core/utils.js" in by.get("toast", {}).get("dead", []))
    ck("E4 msgHTML 单份定义（不再被整篇重写）", "msgHTML" not in by)
    dead_total = sum(len(r["dead"]) for r in orows)
    ck("E5 死份 70 处", dead_total == 70, "实测 %d" % dead_total)

    # F 文档里的错误指引已改
    ck("F1 §0.3 覆盖链章节存在", "### 0.3 覆盖链" in doc)
    ck("F2 文档不再说「路由与页面切换 → core/router.js」",
       "| 路由与页面切换 | `js/core/router.js` |" not in doc)
    ck("F3 路由指向 fusion-v030.js", "**`js/fusion-v030.js`**（`switchPage` 生效处）" in doc)
    ck("F4 同名符号数字已改 30→60", "同名符号 30 组" not in doc and "同名符号 60 组" in doc)
    ck("F5 覆盖链自动区 60 行", len(re.findall(r"^\| `\w+` \| `", doc, re.M)) >= 60)

    # G 门禁
    r = subprocess.run([sys.executable, "dev/arch_lint.py"], cwd=ROOT,
                       capture_output=True, text=True)
    ck("G1 arch_lint exit 0", r.returncode == 0, "exit=%d" % r.returncode)
    ck("G2 存量 104、新增 0", "存量 104，新增 0" in r.stdout.replace("（", "，")
       or "违规 104 条（存量 104，新增 0）" in r.stdout, r.stdout.strip().split("\n")[0])

    # H 生成器幂等
    r2 = subprocess.run([sys.executable, "dev/arch_doc_gen.py", "--write"],
                        cwd=ROOT, capture_output=True, text=True)
    ck("H1 生成器幂等（无变化）", "表格无变化" in r2.stdout, r2.stdout.strip()[:80])
    ck("H2 生成后工作区仍干净", git("status", "--porcelain").stdout.strip() == "")

    # I C10 反向验证（隔离副本，不碰真仓库）
    tmp = tempfile.mkdtemp(prefix="verify_c10_")
    try:
        dst = os.path.join(tmp, "repo")
        shutil.copytree(ROOT, dst, ignore=shutil.ignore_patterns(".git", "__pycache__"))
        tgt = os.path.join(dst, "app/ui/js/panel-slash.js")
        src = open(tgt, encoding="utf-8").read()
        with open(tgt, "w", encoding="utf-8") as fh:
            fh.write(src + "\nwindow.toast = function(m){ console.log(m); };\n")
        r3 = subprocess.run([sys.executable, "dev/arch_lint.py"], cwd=dst,
                            capture_output=True, text=True)
        ck("I1 注入第三份 toast 后 C10 exit 1", r3.returncode == 1, "exit=%d" % r3.returncode)
        ck("I2 报错点名 panel-slash.js", "panel-slash.js" in r3.stdout and "[C10]" in r3.stdout)
        ck("I3 报错说清 3 个文件、2 处死份", "被 3 个文件定义" in r3.stdout)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    # 用覆盖链本身判断，别用字符串前缀（"window.toast =" 是 "window.toast ===" 的前缀）
    toast_row = by.get("toast", {})
    ck("J1 真仓库未被反向验证污染（panel-slash.js 不在 toast 定义链里）",
       "panel-slash.js" not in toast_row.get("order", []),
       "order=%s" % toast_row.get("order"))

    print("-" * 70)
    print("通过 %d / %d" % (len(PASS), len(PASS) + len(FAIL)))
    if FAIL:
        print("失败：")
        for f in FAIL:
            print("  -", f)
    print("HEAD=%s  %s" % (head, "ALL PASS" if not FAIL else "HAS FAILURE"))
    return 0 if not FAIL else 1


if __name__ == "__main__":
    sys.exit(main())
