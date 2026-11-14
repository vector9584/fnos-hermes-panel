#!/usr/bin/env python3
"""生成 app/ui/ARCHITECTURE.md 里的业务架构表。

为什么要有这个脚本：手写的行号一天就过期，过期两次之后就没人信这份文档了。
这里所有数据都从代码里现算——页面容器在哪一行、哪个文件认领、调哪些接口。

用法
----
    python3 dev/arch_doc_gen.py           # 打到 stdout 看
    python3 dev/arch_doc_gen.py --write   # 写回 ARCHITECTURE.md 的自动生成区

定位锚点为什么不用行号
----------------------
行号是快照：index.html 上边插十行，整张表全部失效，而且失效时不报错 ——
表格照样渲染，只是指向别的内容。所以这里只输出稳定锚点：

  容器 id       #page-xxx      导航 hash 直接对应，永不随编辑漂移
  主挂载点 id   被 JS 引用最多的那个内部 id，改这个页面就动它
  属主文件      引用该挂载点的 JS
  生效文件      属主里真正生效的那个（后加载覆盖，见 dev/arch_symbols.py）

页面归属的判定有两条路：
  1. 自动：扫 JS 里 getElementById('x') / querySelector('#x')，把 index.html 里
     该页面容器内的 id 反查成文件。
  2. 手工：整页自建的页面（现拼 'page-'+id、运行时注入容器）自动路径抓不到，
     登记在 MANUAL_OWNERS 里并写明原因。
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UI = os.path.join(ROOT, "app", "ui")
JS = os.path.join(UI, "js")
NAV = os.path.join(JS, "panel-navigation.js")
DOC = os.path.join(UI, "ARCHITECTURE.md")
BEGIN = "<!-- AUTO:业务表 -->"
END = "<!-- /AUTO:业务表 -->"
BEGIN2 = "<!-- AUTO:覆盖链 -->"
END2 = "<!-- /AUTO:覆盖链 -->"


def render_overrides():
    """覆盖链自动区：谁写了几份、谁生效、谁是死份。"""
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import arch_symbols

    _order, rows = arch_symbols.build()
    head = (
        "| 符号 | 定义文件（按加载顺序） | 生效（最后加载） | 死份（永不执行） |\n"
        "|---|---|---|---|\n"
    )
    body = "\n".join(
        "| `%s` | %s | `%s` | %s |"
        % (
            r["symbol"],
            " → ".join("`%s`" % f for f in r["order"]),
            r["winner"],
            " ".join("`%s`" % f for f in r["dead"]),
        )
        for r in rows
    )
    return head + body, len(rows)

# 自动路径抓不到的属主（整页自建 / 运行时注入），附原因
MANUAL_OWNERS = {
    "kb": ["panel-library-ui.js"],       # mount() 里用 'page-'+pageId 拼 id，正则抓不到
    "memory": ["panel-library-ui.js"],   # 同上（views.memory）
    "plans": ["panel-plans-ui.js"],      # 容器运行时插入 index.html 不存在
}


def js_files():
    out = {}
    for base, _d, names in os.walk(JS):
        for n in sorted(names):
            if not n.endswith(".js") or ".bak" in n or n == "personas_library.js":
                continue
            p = os.path.join(base, n)
            if os.path.getsize(p) > 500_000:
                continue
            out[os.path.relpath(p, JS).replace(os.sep, "/")] = open(
                p, encoding="utf-8", errors="replace"
            ).read()
    return out


def load_order():
    """index.html 里 <script src> 的真实先后顺序（决定谁覆盖谁）。"""
    html = open(os.path.join(UI, "index.html"), encoding="utf-8").read()
    out = []
    for m in re.finditer(r'<script[^>]+src="(?:\./)?js/([^"?]+)', html):
        rel = m.group(1)
        if rel not in out:
            out.append(rel)
    return out


def nav_groups():
    src = open(NAV, encoding="utf-8").read()
    out = []
    for m in re.finditer(
        r"\{id:'([a-z]+)',title:'([^']+)',icon:'[^']*',pages:\[(.*?)\]\}", src, re.S
    ):
        pages = re.findall(r"\[\s*'([a-z0-9_-]+)'\s*,\s*'([^']+)'\s*\]", m.group(3))
        out.append((m.group(2), pages))
    return out


def page_ranges():
    """返回 {page_id: (start_line, end_line)}，1 基。

    不能靠「下一个 page 容器」切：页面之间还夹着弹窗、脚本，最后一个页面会
    一路吃到文件尾（实测 752–909，把 8 个无关 js 认领成了设置页的属主）。
    这里按 <section> 标签深度找本容器自己的闭合。
    """
    lines = open(os.path.join(UI, "index.html"), encoding="utf-8").read().split("\n")
    starts = []
    for i, l in enumerate(lines):
        # 不能写死 <section>：page-chat 是 <main class="page chat-main">，闭合是 </main>
        m = re.search(r'<(section|main|div)[^>]*\bid="page-([a-z0-9_-]+)"', l)
        if m:
            starts.append((m.group(2), i, m.group(1)))
    out = {}
    for pid, start, tag in starts:
        depth = 0
        end = len(lines)
        open_re = re.compile(r"<%s\b" % tag)
        close_re = re.compile(r"</%s\b" % tag)
        for i in range(start, len(lines)):
            depth += len(open_re.findall(lines[i]))
            depth -= len(close_re.findall(lines[i]))
            if depth <= 0:
                end = i + 1
                break
        out[pid] = (start + 1, end)
    return out, lines


def page_inner_ids(lines, start, end):
    seg = "\n".join(lines[start - 1:end])
    return set(re.findall(r'id="([a-zA-Z0-9_-]+)"', seg))


def build_rows():
    files = js_files()
    ranges, lines = page_ranges()

    id2files = {}
    for rel, src in files.items():
        ids = set(re.findall(r"getElementById\(\s*['\"]([a-zA-Z0-9_-]+)['\"]", src))
        ids |= set(re.findall(r"querySelector(?:All)?\(\s*['\"]#([a-zA-Z0-9_-]+)", src))
        for i in ids:
            id2files.setdefault(i, set()).add(rel)

    # 加载顺序 + 全局覆盖链：用来判断属主里谁真正生效
    order = load_order()
    idx = {f: i for i, f in enumerate(order)}
    try:
        import arch_symbols  # 同目录

        _o, sym_rows = arch_symbols.build()
        winner_of = {r["symbol"]: r["winner"] for r in sym_rows}
        dead_of = {}
        for r in sym_rows:
            for d in r["dead"]:
                dead_of.setdefault(d, set()).add(r["symbol"])
    except Exception:
        winner_of, dead_of = {}, {}

    endpoints = {}
    for rel, src in files.items():
        endpoints[rel] = {
            e.rstrip("/") for e in re.findall(r"['\"](/api/[a-z0-9_\-/]+)['\"]", src)
        }

    rows = []
    for title, pages in nav_groups():
        for pid, label in pages:
            owners = set(MANUAL_OWNERS.get(pid, []))
            mount = "—"
            if pid in ranges:
                start, end = ranges[pid]
                inner = page_inner_ids(lines, start, end)
                for i in inner:
                    owners |= id2files.get(i, set())
                # 主挂载点 = 容器内被最多 JS 引用的 id（不含容器自身）
                cand = [(len(id2files.get(i, ())), i) for i in inner if i != "page-" + pid]
                cand = [c for c in cand if c[0] > 0]
                if cand:
                    cand.sort(key=lambda x: (-x[0], x[1]))
                    mount = "#" + cand[0][1]
                loc = "#page-" + pid
            else:
                loc = "#page-" + pid
            eps = set()
            for o in owners:
                eps |= endpoints.get(o, set())
            eps = sorted(eps)[:4]

            # 「改了不生效」= 属主文件里存在被后面文件覆盖掉的符号
            stale = []
            for o in sorted(owners):
                ds = sorted(dead_of.get(o, set()))
                if ds:
                    stale.append("`%s`(%s)" % (o, "/".join(ds[:2])))
            stale_cell = "<br>".join(stale) if stale else "—"

            rows.append(
                (
                    title,
                    label,
                    "#/" + pid,
                    loc,
                    mount,
                    " ".join("`%s`" % o for o in sorted(owners)) or "—",
                    stale_cell,
                    " ".join("`%s`" % e for e in eps) or "—",
                )
            )
    return rows


def render(rows):
    head = (
        "| 板块 | 页面 | hash | 容器锚点 | 主挂载点 | 属主文件 | 改了不生效（被覆盖的符号） | 主要接口 |\n"
        "|---|---|---|---|---|---|---|---|\n"
    )
    body = "\n".join("| %s | %s | `%s` | `%s` | `%s` | %s | %s | %s |" % r for r in rows)
    return head + body


def main(argv):
    rows = build_rows()
    table = render(rows)

    if "--write" not in argv:
        print(table)
        print("\n共 %d 个页面" % len(rows))
        return 0

    doc = open(DOC, encoding="utf-8").read()
    if BEGIN not in doc or END not in doc:
        print("ARCHITECTURE.md 里找不到生成区标记 %s ... %s" % (BEGIN, END))
        return 2
    new = re.sub(
        re.escape(BEGIN) + r".*?" + re.escape(END),
        lambda m: BEGIN + "\n" + table + "\n" + END,
        doc,
        flags=re.S,
    )

    # 覆盖链自动区（同一份数据，两处呈现：业务表给「改了不生效」，这里给全量谁赢谁死）
    ov_table, ov_count = render_overrides()
    if BEGIN2 in new and END2 in new:
        new = re.sub(
            re.escape(BEGIN2) + r".*?" + re.escape(END2),
            lambda m: BEGIN2 + "\n" + ov_table + "\n" + END2,
            new,
            flags=re.S,
        )
    else:
        print("提示：文档里没有 %s ... %s 标记，覆盖链区未刷新" % (BEGIN2, END2))

    if new == doc:
        print("表格无变化（业务表 %d 页、覆盖链 %d 组）" % (len(rows), ov_count))
        return 0
    with open(DOC, "w", encoding="utf-8") as fh:
        fh.write(new)
    print(
        "已刷新：业务表 %d 页、覆盖链 %d 组，%d 字节"
        % (len(rows), ov_count, os.path.getsize(DOC))
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
