#!/usr/bin/env python3
"""全局符号覆盖表：同一个名字被几个文件写，运行时谁生效。

为什么需要这个
--------------
面板没有打包器、没有模块系统，66 个 <script> 手写顺序加载，所有顶层
function / window.X 都挂在同一个全局对象上。于是同一个名字被两个文件定义时，
**后加载的那份静默覆盖前一份**，前一份变成永不执行的死代码。

这造成的真实后果：改 chat/tabs.js 里的 loadSessionMessages，运行时跑的是
panel-workspace-ui.js 那份 —— 代码看着改了，行为没变，而且没有任何报错。
这类问题跟「在哪一行」无关，跟「谁最后加载」有关。

定位锚点
--------
本脚本和下游文档一律用「文件路径 + 符号名」定位，不用行号。行号是快照，
上方插入十行就全部失效，且失效时不报错。

判定口径
--------
生效 = 加载顺序最后的那份（浏览器后赋值覆盖先赋值）
死份 = 被覆盖、运行时永远不会执行到的那份
不算覆盖：
  - 纯读取引用（`typeof window.X === 'function'`、`var o = window.X`）
  - `window.X = window.X || 默认值`（保留已有实现，属于补位不是覆盖）
  - 函数体内的局部声明（缩进在 function/IIFE 内部）

用法
----
    python3 dev/arch_symbols.py            # 人读表格
    python3 dev/arch_symbols.py --json     # 机器读
    python3 dev/arch_symbols.py --dead     # 只看死份（被覆盖的那份）
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UI = os.path.join(ROOT, "app", "ui")
JS = os.path.join(UI, "js")
INDEX = os.path.join(UI, "index.html")

# window.X = ...  但不能是 == / ===（比较）、!=、<=、>=
ASSIGN = re.compile(r"window\s*\.\s*([A-Za-z_$][\w$]*)\s*=(?!=)")
# 顶层 function X(  —— 必须行首无缩进（缩进的是局部函数）
TOP_FN = re.compile(r"^function\s+([A-Za-z_$][\w$]*)", re.M)
# window.X = window.X || ... 这种是补位，不算覆盖
SELF_KEEP = re.compile(
    r"window\s*\.\s*([A-Za-z_$][\w$]*)\s*=\s*window\s*\.\s*\1\s*\|\|"
)


def load_order():
    """index.html 里 <script src> 的真实先后顺序。"""
    html = open(INDEX, encoding="utf-8").read()
    out = []
    for m in re.finditer(r'<script[^>]+src="(?:\./)?js/([^"?]+)', html):
        rel = m.group(1)
        if rel not in out:
            out.append(rel)
    return out


def read(rel):
    p = os.path.join(JS, rel)
    if not os.path.exists(p):
        return None
    return open(p, encoding="utf-8", errors="replace").read()


def strip_noise(src):
    """去掉注释，避免注释里的 window.X = 被当成定义。"""
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    src = re.sub(r"(?m)^\s*//.*$", "", src)
    return src


def collect():
    """返回 {symbol: [(file, kind)]}，按加载顺序。"""
    order = load_order()
    defs = {}
    for rel in order:
        src = read(rel)
        if src is None:
            continue
        src = strip_noise(src)
        keep = {m.group(1) for m in SELF_KEEP.finditer(src)}
        seen = []
        for m in ASSIGN.finditer(src):
            name = m.group(1)
            if name in keep:
                continue
            # 赋值右侧若是自身名字的读取（window.a = b 不算覆盖自身）无所谓，仍是写
            seen.append((name, "window"))
        for m in TOP_FN.finditer(src):
            seen.append((m.group(1), "function"))
        for name, kind in seen:
            defs.setdefault(name, []).append((rel, kind))
    return order, defs


def build():
    order, defs = collect()
    idx = {f: i for i, f in enumerate(order)}
    rows = []
    for name, hits in defs.items():
        files = []
        for f, kind in hits:
            if f not in [x[0] for x in files]:
                files.append((f, kind))
        if len(files) < 2:
            continue
        files.sort(key=lambda x: idx.get(x[0], 999))
        winner = files[-1][0]
        dead = [f for f, _ in files[:-1]]
        rows.append(
            {
                "symbol": name,
                "winner": winner,
                "winner_kind": files[-1][1],
                "dead": dead,
                "order": [f for f, _ in files],
            }
        )
    rows.sort(key=lambda r: (-len(r["order"]), r["symbol"]))
    return order, rows


def main(argv):
    order, rows = build()
    if "--json" in argv:
        print(json.dumps({"scripts": len(order), "count": len(rows), "rows": rows},
                         ensure_ascii=False, indent=1))
        return 0
    if "--md" in argv:
        print("| 符号 | 定义文件（按加载顺序） | 生效 | 死份（永不执行） |")
        print("|---|---|---|---|")
        for r in rows:
            print("| `%s` | %s | `%s` | %s |" % (
                r["symbol"],
                " → ".join("`%s`" % f for f in r["order"]),
                r["winner"],
                " ".join("`%s`" % f for f in r["dead"]),
            ))
        return 0

    only_dead = "--dead" in argv
    print("加载顺序 %d 个 script；跨文件重复定义 %d 组\n" % (len(order), len(rows)))
    if not only_dead:
        print("%-30s %-34s %s" % ("符号", "生效（最后加载）", "被覆盖（死份）"))
        print("-" * 110)
    for r in rows:
        if only_dead:
            print("%-30s 生效=%s  死=%s" % (r["symbol"], r["winner"], ", ".join(r["dead"])))
        else:
            print("%-30s %-34s %s" % (r["symbol"], r["winner"], ", ".join(r["dead"])))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
