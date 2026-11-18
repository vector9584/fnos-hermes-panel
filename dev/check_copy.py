#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""介绍页文案一致性检查（index.html）

改完 index.html 必跑。页面里有两套"块"，标准不同，别混：

  条带（.marq）  = 页面下面每个章节的 data-title，滚动预览用（章数由 names 定）
  面板地图(arch) = 真实面板的 8 个板块，来自 app/ui/js/panel-navigation.js
                   的 groups，「设置」在里面、「画布」「下载」不在

历史教训（都被用户抓到过）：
  · 条带曾写成「画布 ✦ … ✦ 状态 ✦ 构建」：状态/构建是改名前的旧章节名
  · 条带曾被改成 8 个板块名：那是在用面板结构替代章节标题，层级不对
  · 「共 9 块」硬编码，arch 加到 10 项时数字不跟着变

退出码：0 全过 / 1 有问题
用法：python3 dev/check_copy.py [--quiet]
"""

import re
import sys
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGE = os.path.join(ROOT, "index.html")
NAV = os.path.join(ROOT, "app/ui/js/panel-navigation.js")
QUIET = "--quiet" in sys.argv

# 禁用词：出现过就会被用户抓到的那几个
BANNED = {
    "黑盒": "「黑盒」这个提法整体不要出现（用户明说过）",
    "不是个黑盒": "旧章节名，已改成「拆得开」",
    "十块": "旧数量，真实是 8",
    "九块": "旧数量，真实是 8",
    "共 9": "旧数量，真实是 8",
}

# 条带里不能再出现的旧章节名
STRIP_BANNED = {
    "状态": "旧章节名，现在是「维护」",
    "构建": "旧章节名，现在是「拆得开」",
}


def main():
    fails, oks = [], []

    page = open(PAGE, encoding="utf-8").read()

    # ── 真源一：页面 10 个章节的 data-title（条带标准） ──
    secs = re.findall(
        r'<section class="chapter[^"]*"[^>]*?data-ch="(\d+)"[^>]*?data-title="([^"]*)"',
        page)
    if not secs:
        secs = re.findall(
            r'<section class="chapter[^"]*"[^>]*?data-title="([^"]*)"[^>]*?data-ch="(\d+)"',
            page)
        secs = [(c, t) for t, c in secs]
    chapters = [t for _, t in sorted(secs, key=lambda x: int(x[0]))]

    # names 数组（第 0 项是「目录」）
    _nm = re.search(r"var names=\[([^\]]*)\]", page)
    names_arr = re.findall(r"'([^']*)'", _nm.group(1)) if _nm else []

    if not chapters:
        fails.append("没读到任何 section.chapter 的 data-title —— 结构可能变了")
    elif not names_arr:
        fails.append("没读到 var names 数组 —— 目录文案可能改了写法")
    elif names_arr[1:] != chapters:
        fails.append("names 与章节 data-title 不一致：names=" + " / ".join(names_arr[1:])
                     + " · chapters=" + " / ".join(chapters))
    else:
        oks.append(f"页面章节 {len(chapters)} 个，与 names 一致：" + " / ".join(chapters))

    # ── 真源二：panel-navigation.js 的 groups（地图标准） ──
    nav = open(NAV, encoding="utf-8").read()
    groups = re.findall(r"\{id:'([\w-]+)',title:'([^']+)'", nav)
    truth = [t for _, t in groups]
    if len(truth) != 8:
        fails.append(f"真源 groups 读到 {len(truth)} 个板块，预期 8 个 —— 正则可能失效")
    else:
        oks.append(f"面板板块 {len(truth)} 个：" + " / ".join(truth))

    # 1) 禁用词
    for word, why in BANNED.items():
        if word in page:
            lines = [i + 1 for i, ln in enumerate(page.split("\n")) if word in ln]
            fails.append(f"禁用词 {word!r} 出现（行 {lines[:6]}）—— {why}")
        else:
            oks.append(f"禁用词 {word!r} : 0")

    # 2) 条带 = 页面各章节标题
    m = re.search(r'<div class="marq"[^>]*><div class="in">(.*?)\n</div></div>', page, re.S)
    if not m:
        fails.append("找不到 .marq 条带（结构变了）")
    else:
        body = m.group(1)
        spans = re.findall(r"<span>(.*?)</span>", body, re.S)
        if not spans:
            fails.append("条带里没读到 span")
        else:
            raw = re.sub(r"<[^>]+>", " ", spans[0])
            words = [w for w in re.split(r"[\s\u00a0]+", raw) if w and w not in ("✦", "&nbsp;")]
            if words != chapters:
                fails.append("条带跟章节标题对不上\n"
                             f"      条带：{' ✦ '.join(words)}\n"
                             f"      章节：{' ✦ '.join(chapters)}")
            else:
                oks.append(f"条带 = 章节标题：{' ✦ '.join(words)}")
            for bad, why in STRIP_BANNED.items():
                if bad in words:
                    fails.append(f"条带里有旧章节名 {bad!r} —— {why}")
            if len(spans) < 4:
                fails.append(f"条带只有 {len(spans)} 份 span —— CSS 是 translateX(-50%) 无缝，"
                             f"10 项 2 份半宽 < 1920px，宽屏会露空，应≥4 份")
            else:
                oks.append(f"条带 span {len(spans)} 份")

    # 3) 动画时长：4 份 10 项时 44s 会快到 ~79px/s，正常观感是 25~40px/s
    mdur = re.search(r"\.marq \.in\{[^}]*animation:mq\s+(\d+(?:\.\d+)?)s", page)
    if not mdur:
        fails.append("找不到条带动画时长")
    else:
        d = float(mdur.group(1))
        if d < 90:
            fails.append(f"条带动画 {d}s 偏快 —— 4 份 10 项位移约 3267px，"
                         f"{d}s 得 {3267/d:.0f}px/s，正常是 25~40px/s，应 ≥90s")
        else:
            oks.append(f"条带动画 {d}s（桌面约 {3267/d:.0f}px/s）")

    # 4) 面板地图 arch = 8 板块
    m = re.search(r"var arch=\[(.*?)\n\s*\];", page, re.S)
    if not m:
        fails.append("找不到 arch 数组")
    else:
        names = re.findall(r"\[\s*'([^']+)'", m.group(1))
        if names != truth:
            fails.append(f"地图 arch 不对\n      实际：{' / '.join(names)}\n      应为：{' / '.join(truth)}")
        else:
            oks.append(f"地图 arch = 8 板块：{' / '.join(names)}")

    # 5) 「共 N 块」不能写死
    for num in re.findall(r"共\s*(\d+)\s*块", page):
        if int(num) != len(truth):
            fails.append(f"页面写着「共 {num} 块」，真实 {len(truth)} 块")
    if "arch.length" in page:
        oks.append("「共 N 块」由 arch.length 计算")
    else:
        fails.append("没找到 arch.length —— 「共 N 块」仍是硬编码")

    # 6) 侧栏目录 names 前 10 项应与章节标题一致
    m = re.search(r"var names=\[([^\]]+)\]", page)
    if not m:
        fails.append("找不到 rail 的 names 数组")
    else:
        items = re.findall(r"'([^']+)'", m.group(1))
        body_items = [x for x in items if x != "目录"]
        if chapters and body_items != chapters:
            fails.append(f"目录跟章节标题不一致\n      目录：{' / '.join(body_items)}\n"
                         f"      章节：{' / '.join(chapters)}")
        else:
            oks.append(f"目录 {len(items)} 项（含「目录」），与章节标题一致")

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
