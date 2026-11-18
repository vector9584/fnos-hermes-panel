#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""介绍页文案一致性检查（index.html）

改完 index.html 必跑。三类问题一次查完，不用靠人眼：

  1. 禁用词 —— 曾经出现过、明确不要再出现的词
  2. 板块名一致性 —— 条带 / 面板地图(arch) / 侧栏目录(names) 用的名字必须是
     app/ui/js/panel-navigation.js 里 groups 的 title，不能自己编
  3. 数量一致性 —— 「共 N 块」必须等于 arch.length，不能写死

退出码：0 全过 / 1 有问题

用法：
    python3 dev/check_copy.py
    python3 dev/check_copy.py --quiet     # 只打印失败项
"""

import re
import sys
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGE = os.path.join(ROOT, "index.html")
NAV = os.path.join(ROOT, "app/ui/js/panel-navigation.js")

QUIET = "--quiet" in sys.argv

# ── 禁用词：出现过就会被用户抓到的那几个 ────────────────────────────
BANNED = {
    "黑盒": "「黑盒」这个提法整体不要出现（用户明说过）",
    "不是个黑盒": "旧章节名，已改成「拆得开」",
    "十块": "旧数量，真实是 8",
    "九块": "旧数量，真实是 8",
    "共 9": "旧数量，真实是 8",
}

# ── 条带里绝对不能出现的词（板块名以外的） ──────────────────────────
STRIP_BANNED = {
    "画布": "画布是对话板块里的入口，不是板块",
    "状态": "「状态」不是板块名，「维护」才是",
    "构建": "「构建」不是板块名",
    "下载": "「下载」不是面板板块",
}


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def truth_groups(nav_src):
    """从 panel-navigation.js 读真源板块：[('chat','对话'), ...]"""
    return re.findall(r"\{id:'([\w-]+)',title:'([^']+)'", nav_src)


def main():
    fails = []
    oks = []

    if not os.path.exists(PAGE):
        print(f"✗ 找不到 {PAGE}")
        return 1
    if not os.path.exists(NAV):
        print(f"✗ 找不到 {NAV}")
        return 1

    page = read(PAGE)
    groups = truth_groups(read(NAV))
    if len(groups) != 8:
        fails.append(f"真源 groups 读到 {len(groups)} 个板块，预期 8 个 —— 正则可能失效，先修脚本")
    truth = [t for _, t in groups]
    oks.append(f"真源：{len(groups)} 板块 —— {' / '.join(truth)}")

    # 1) 禁用词
    for word, why in BANNED.items():
        n = page.count(word)
        if n:
            lines = [i + 1 for i, line in enumerate(page.split("\n")) if word in line]
            fails.append(f"禁用词 {word!r} 出现 {n} 次（行 {lines[:6]}）—— {why}")
        else:
            oks.append(f"禁用词 {word!r} : 0")

    # 2) 条带
    m = re.search(r'<div class="marq".*?</div></div>', page, re.S)
    if not m:
        fails.append("找不到 .marq 条带（选择器或结构变了）")
    else:
        spans = re.findall(r"<span>(.*?)</span>", m.group(0))
        if not spans:
            fails.append("条带里没读到 span")
        else:
            raw = re.sub(r"<[^>]+>", " ", spans[0])
            words = [w for w in re.split(r"[\s\u00a0]+", raw)
                     if w and w not in ("✦", "&nbsp;")]
            if words != truth:
                fails.append(f"条带顺序/名称不对\n      实际：{' '.join(words)}\n      应为：{' '.join(truth)}")
            else:
                oks.append(f"条带：{' ✦ '.join(words)}")
            for bad, why in STRIP_BANNED.items():
                if bad in words:
                    fails.append(f"条带里有 {bad!r} —— {why}")
            # 份数：CSS 用 translateX(-50%) 做无缝，2 份在宽屏会露空
            if len(spans) < 4:
                fails.append(f"条带只有 {len(spans)} 份 span，CSS 是 -50% 位移；"
                             f"8 项 2 份半宽 1283px < 1440px 视口，滚动会露空，应≥4 份")
            else:
                oks.append(f"条带 span {len(spans)} 份")

    # 3) 面板地图 arch 数组
    m = re.search(r"var arch=\[(.*?)\n\s*\];", page, re.S)
    if not m:
        fails.append("找不到 arch 数组")
    else:
        names = re.findall(r"\[\s*'([^']+)'", m.group(1))
        if names != truth:
            fails.append(f"arch 数组不对\n      实际：{' / '.join(names)}\n      应为：{' / '.join(truth)}")
        else:
            oks.append(f"地图 arch：{' / '.join(names)}")

    # 4) 「共 N 块」不能写死
    for pat in [r"共\s*(\d+)\s*块"]:
        for num in re.findall(pat, page):
            if int(num) != len(truth):
                fails.append(f"页面写着「共 {num} 块」，真实 {len(truth)} 块")
    if "arch.length" in page:
        oks.append("「共 N 块」由 arch.length 计算")
    else:
        fails.append("没找到 arch.length —— 「共 N 块」仍是硬编码，会再次漂")

    # 5) 侧栏目录 names：前 8 项里除「目录」「画布」外应全是板块名
    m = re.search(r"var names=\[([^\]]+)\]", page)
    if not m:
        fails.append("找不到 rail 的 names 数组")
    else:
        items = re.findall(r"'([^']+)'", m.group(1))
        bad = []
        for it in items:
            if it in ("目录", "画布", "拆得开", "下载"):
                continue          # 叙事章节，不是板块
            if it not in truth:
                bad.append(it)
        if bad:
            fails.append(f"目录里有非板块名且非叙事章节的项：{bad}")
        else:
            oks.append(f"目录：{len(items)} 项，板块名都来自真源")

    # ── 输出 ──
    if not QUIET:
        print("── 通过 ──")
        for o in oks:
            print("  ✓", o)
    if fails:
        print("\n── 失败 ──")
        for f in fails:
            print("  ✗", f)
        print(f"\n共 {len(fails)} 项不通过")
        return 1
    print(f"\n全部通过（{len(oks)} 项）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
