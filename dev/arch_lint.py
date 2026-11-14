#!/usr/bin/env python3
"""架构门禁：挡住回退到「覆盖包装 / 多处实现」的老路。

背景
----
这份面板经历了三代代码叠加：tabs.js 定义 → fusion-v030.js 覆盖 →
panel-*-ui.js 再包一层。同一个 msgHTML 有 3 份、modal 有 17 处手工实现、
esc 有 6 份。2026-11-13 收敛成单实现后，如果不设门禁，下一个人（或下一个我）
还会顺手再包一层，三个月后又回到原地。

规则
----
C1 覆盖链     `var oldXxx = xxx;` 后接 `window.xxx = function` —— 这是包装链的特征
C2 自建转义   除 core/dom.js 外，任何 esc/esc30/escapeHtml 必须是一行转发到 DOM.*
C3 自建 toast 除 core/utils.js 外，toast 必须转发到 window.toast / ui.toast
C4 裸弹窗     手工拼 modal-overlay 后必须调 ui.adoptOverlay（否则没有 Esc/滚动锁）
C5 卡片类名   只许 .card ＋ card--* 修饰符；新造 .xxx-card 一律拦（存量进基线）
C6 按钮类名   只许 .btn ＋ primary/danger/secondary/ghost/sm/xs/block；新造 .xxx-btn 一律拦
C7 业务域     每个 page-<id> 必须登记进 app/ui/ARCHITECTURE.md 的业务表
C8 容器静态   导航 groups 里声明的每个页面，必须在 index.html 有静态 id="page-<id>" 容器
              （禁止 JS 运行时 createElement 造页面容器：那样业务表给不出行号）
C9 属性转义   属性值必须用 DOM.escAttr / escapeHtml（后者就是它的转发），不许用只转 & < > 的 esc
              （esc 不转义引号，值里的 " 会逃出属性，实测造成重复 id 打废页面切换）

用法
----
    python3 dev/arch_lint.py            # 检查；有新增违规退出 1
    python3 dev/arch_lint.py --update   # 把当前违规记为基线（只用于收敛过程中的存量）
    python3 dev/arch_lint.py --all      # 连存量一起列出

基线文件 dev/arch_lint_baseline.json 记的是「已知存量」，删一条少一条，
不允许借 --update 把新违规塞进去蒙混过关——review 时看 diff 就知道。
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UI = os.path.join(ROOT, "app", "ui")
JS = os.path.join(UI, "js")
BASELINE = os.path.join(ROOT, "dev", "arch_lint_baseline.json")

# 允许保留唯一实现的文件（相对 app/ui 的 posix 路径）
OWNER_ESC = "js/core/dom.js"
OWNER_TOAST = "js/core/utils.js"
OWNER_MODAL = "js/core/ui-kit.js"
# 组件库自身的兜底实现（转发优先，没加载统一实现时才用）
OWNER_ANY = {"js/core/dom.js", "js/core/utils.js", "js/core/ui-kit.js"}


def js_files():
    for base, _dirs, names in os.walk(JS):
        for n in sorted(names):
            if n.endswith(".js"):
                p = os.path.join(base, n)
                yield os.path.relpath(p, UI).replace(os.sep, "/"), p


# ── 结构规则 C5/C6/C7 ─────────────────────────────────────────────────
# 这三条按「类名 / 页面」报，不按行报：挪代码不该产生新违规，
# 但新起一个 .xxx-card / .xxx-btn、或新加一个页面没登记，必须报警。
CLASS_RE = re.compile(r'class=["\']([^"\']+)["\']')
# 卡片类名必须带连字符边界：否则 discard / postcard 这类英文词会被误判成卡片
CARD_RE = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*-card")
BTN_RE = re.compile(r"[a-z][a-z0-9]*(?:-[a-z0-9]+)*-?btn")
# 合规类名：.card 是唯一卡片；settings-card 是设置页区块容器，
# 已在 components.css 里有正式定义（不是各页面自造），单独放行。
ALLOWED_BTN = {"btn"}
ALLOWED_CARD = {"card", "settings-card"}


def markup_sources():
    yield os.path.join(UI, "index.html")
    for _rel, p in js_files():
        yield p


def css_files():
    d = os.path.join(UI, "css")
    for n in sorted(os.listdir(d)):
        if n.endswith(".css"):
            yield os.path.join(d, n)


def check_class_names():
    """C5 卡片类名 / C6 按钮类名：只允许 .card / .btn 体系，存量进基线。"""
    cards, btns = set(), set()

    def collect(src):
        for m in CLASS_RE.finditer(src):
            for c in m.group(1).split():
                if CARD_RE.fullmatch(c) and c not in ALLOWED_CARD:
                    cards.add(c)
                if BTN_RE.fullmatch(c) and c not in ALLOWED_BTN:
                    btns.add(c)

    for p in markup_sources():
        collect(open(p, encoding="utf-8", errors="replace").read())

    for p in css_files():
        src = re.sub(r"/\*.*?\*/", "", open(p, encoding="utf-8").read(), flags=re.S)
        for sel in re.findall(r"([^{}]+)\{", src):
            for c in re.findall(r"\.([A-Za-z][\w-]*)", sel):
                if CARD_RE.fullmatch(c) and c not in ALLOWED_CARD:
                    cards.add(c)
                if BTN_RE.fullmatch(c) and c not in ALLOWED_BTN:
                    btns.add(c)

    out = []
    for c in sorted(cards):
        out.append(("-", 0, "C5", "新造卡片类名 .%s（改用 .card ＋ card--pad/--flat/--deck/--click）" % c))
    for c in sorted(btns):
        out.append(("-", 0, "C6", "新造按钮类名 .%s（改用 .btn ＋ primary/danger/sm/xs）" % c))
    return out


def check_domains():
    """C7 业务域覆盖：每个 page-<id> 必须在 ARCHITECTURE.md 的业务表里登记。"""
    doc_path = os.path.join(UI, "ARCHITECTURE.md")
    if not os.path.exists(doc_path):
        return [("-", 0, "C7", "缺少 app/ui/ARCHITECTURE.md（业务架构真源）")]
    doc = open(doc_path, encoding="utf-8").read()

    pages = set()
    for p in [os.path.join(UI, "index.html")] + [p for _r, p in js_files()]:
        src = open(p, encoding="utf-8", errors="replace").read()
        pages.update(re.findall(r"""id\s*=\s*["']page-([a-z0-9_-]+)["']""", src))

    out = []
    for pg in sorted(pages):
        if ("#/" + pg) in doc or ("#page-" + pg) in doc:
            continue
        out.append(("-", 0, "C7", "页面 %s 未登记进 ARCHITECTURE.md 业务表" % pg))
    return out


def check_nav_static():
    """C8 容器静态：导航声明的每个页面都必须在 index.html 有静态容器。

    反方向检查——C7 是「HTML 里有容器 → 必须登记」，C8 是「导航里有页面 → 必须有容器」。
    2026-11-13 之前 plans 就活在这个缝里：panel-plans-ui.js 运行时 createElement 造页面，
    HTML 里 0 处，业务表只能写「JS 注入」，改页面时按文件名找必然找不到行号。
    """
    nav = os.path.join(UI, "js", "panel-navigation.js")
    idx = os.path.join(UI, "index.html")
    for p in (nav, idx):
        if not os.path.exists(p):
            return [("-", 0, "C8", "缺少 %s，无法校验页面容器" % os.path.relpath(p, UI))]

    navsrc = open(nav, encoding="utf-8", errors="replace").read()
    m = re.search(r"var\s+groups\s*=\s*\[(.*?)\n\s*\];", navsrc, re.S)
    if not m:
        return [("-", 0, "C8", "无法在 panel-navigation.js 里定位 groups 数组")]
    declared = re.findall(r"""\['([a-z0-9_-]+)'\s*,\s*'[^']*'\]""", m.group(1))

    html = open(idx, encoding="utf-8", errors="replace").read()
    static = set(re.findall(r"""id\s*=\s*["']page-([a-z0-9_-]+)["']""", html))

    out = []
    for pg in sorted(set(declared)):
        if pg in static:
            continue
        out.append(("-", 0, "C8",
                    "导航声明了 %s，但 index.html 没有静态 #page-%s（页面容器必须静态，JS 只填内容）" % (pg, pg)))
    return out


def body_of(lines, start):
    """粗略取一个函数体：从 start 行起按花括号配平（单行函数当行结束）。"""
    depth = 0
    out = []
    for i in range(start, len(lines)):
        depth += lines[i].count("{") - lines[i].count("}")
        out.append(lines[i])
        if depth <= 0:
            break
    return out


def check_file(rel, path):
    findings = []
    src = open(path, encoding="utf-8", errors="replace").read()
    lines = src.split("\n")

    # C1 覆盖链：var oldX = X; ... window.X = function
    for i, l in enumerate(lines, 1):
        m = re.search(r"var\s+(old[A-Z]\w*)\s*=\s*(\w+)\s*;", l)
        if m:
            findings.append((rel, i, "C1", "覆盖链 %s = %s" % (m.group(1), m.group(2))))

    # C2 自建转义
    if rel != OWNER_ESC:
        for i, l in enumerate(lines, 1):
            m = re.search(r"function\s+(esc|esc30|escapeHtml|escAttr)\s*\(", l)
            if not m:
                continue
            body = body_of(lines, i - 1)
            joined = " ".join(x.strip() for x in body)
            # 合规：整段只有 return DOM.xxx(...)
            if re.search(r"return\s+DOM\.\w+\s*\(", joined) and len(body) <= 4:
                continue
            findings.append((rel, i, "C2", "自建转义 %s（应转发 DOM.*）" % m.group(1)))

    # C3 自建 toast
    if rel not in OWNER_ANY:
        for i, l in enumerate(lines, 1):
            m = re.search(r"function\s+(toast|toast30)\s*\(", l)
            if not m:
                continue
            body = body_of(lines, i - 1)
            joined = " ".join(x.strip() for x in body)
            if re.search(r"return\s+(window\.)?(ui\.)?toast\s*\(", joined) and len(body) <= 5:
                continue
            if re.search(r"window\.toast\s*\(", joined) and len(body) <= 14:
                continue
            findings.append((rel, i, "C3", "自建 toast %s（应转发统一实现）" % m.group(1)))

    # C4 裸弹窗：出现 modal-overlay 挂载但整文件没有 adoptOverlay 调用
    if rel != OWNER_MODAL and re.search(r"modal-overlay|modal-backdrop", src):
        # ui.modal 自带行为接管，用它的文件不算裸弹窗
        # 这些弹窗自己已经绑了 Esc/Tab（体检过），行为等价，不算裸弹窗
        already = "adoptOverlay" in src or re.search(r"ui\.modal\s*\(", src) or "Escape" in src
        if not already:
            line = next(
                (i for i, l in enumerate(lines, 1) if re.search(r"modal-overlay|modal-backdrop", l)), 1
            )
            findings.append((rel, line, "C4", "手工弹窗未接管（缺 ui.adoptOverlay）"))

    # C9 属性转义：esc() 只转 & < >，放进 "..." 属性时值里的引号会逃出属性。
    # 实证：tool-prev 的 title 塞工具输出，输出里 id="page-plans" 让 span 真的拿到了该 id，
    # getElementById 返回聊天气泡而非页面容器，switchPage('plans') 直接把页面打废。
    for i, l in enumerate(lines, 1):
        m = re.search(r"""([\w-]+)\s*=\s*"'\s*\+\s*esc\(""", l)
        if m:
            findings.append((rel, i, "C9",
                             "属性 %s 用了 esc(（应 DOM.escAttr / escapeHtml，否则值里的引号可逃出属性）" % m.group(1)))

    return findings


def _def_line(rel, name):
    """给出某文件里该全局符号的首次定义行，只用于定位，不作判定依据。"""
    import re as _re

    path = os.path.join(JS, rel)
    if not os.path.exists(path):
        return 0
    pats = [
        _re.compile(r"window\s*\.\s*" + _re.escape(name) + r"\s*=(?!=)"),
        _re.compile(r"(?m)^function\s+" + _re.escape(name) + r"\b"),
    ]
    for no, line in enumerate(open(path, encoding="utf-8", errors="replace"), 1):
        for p in pats:
            if p.search(line):
                return no
    return 0


def check_symbol_overrides():
    """C10：同一个全局符号被多个文件定义 → 后加载的静默覆盖前面的。

    这是本仓库最伤人的一类问题：改了 A 文件里的函数，运行时跑的却是 B 文件那份，
    代码看着改了、行为没变、没有任何报错。没有打包器和模块系统时，唯一的防线是
    把它们列出来，新增必须解释。
    """
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    try:
        import arch_symbols
    except Exception as e:  # pragma: no cover
        print("C10 跳过（arch_symbols 不可用：%s）" % e)
        return []
    out = []
    _order, rows = arch_symbols.build()
    for r in rows:
        msg = "全局符号 %s 被 %d 个文件定义，生效=%s，死份=%s" % (
            r["symbol"],
            len(r["order"]),
            r["winner"],
            ",".join(r["dead"]),
        )
        out.append((r["winner"], _def_line(r["winner"], r["symbol"]), "C10", msg))
    return out


def scan():
    out = []
    for rel, path in js_files():
        out.extend(check_file(rel, path))
    out.extend(check_class_names())
    out.extend(check_domains())
    out.extend(check_nav_static())
    out.extend(check_symbol_overrides())
    return out


def key(f):
    rel, line, rule, msg = f
    return "%s|%s|%s" % (rel, rule, msg)


def main(argv):
    update = "--update" in argv
    show_all = "--all" in argv
    findings = scan()

    if update:
        base = sorted({key(f) for f in findings})
        with open(BASELINE, "w", encoding="utf-8") as fh:
            json.dump({"note": "存量违规基线，只减不增", "items": base}, fh, ensure_ascii=False, indent=2)
        print("已写入基线 %d 条 -> %s" % (len(base), BASELINE))
        return 0

    base = set()
    if os.path.exists(BASELINE):
        try:
            base = set(json.load(open(BASELINE, encoding="utf-8")).get("items", []))
        except Exception as e:
            print("基线读取失败: %s" % e)
            return 2

    fresh = [f for f in findings if key(f) not in base]
    gone = sorted(base - {key(f) for f in findings})

    if show_all:
        for rel, line, rule, msg in sorted(findings):
            print("  [%s] %s:%d  %s" % (rule, rel, line, msg))
        print()

    print("扫描 %d 个 JS，违规 %d 条（存量 %d，新增 %d）" % (
        len(list(js_files())), len(findings), len(findings) - len(fresh), len(fresh)))
    if fresh:
        print("\n新增违规（必须处理，或说明理由后 --update）：")
        for rel, line, rule, msg in sorted(fresh):
            print("  [%s] %s:%d  %s" % (rule, rel, line, msg))
        return 1
    if gone:
        print("\n基线里已有 %d 条被修掉了，建议 --update 收紧基线：" % len(gone))
        for g in gone[:10]:
            print("  -", g)
    print("通过")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
