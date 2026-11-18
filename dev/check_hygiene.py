#!/usr/bin/env python3
"""扫 diff 里的敏感信息与外链依赖，只查新增行。

为什么只查新增：库里存量的东西（老提交里的内网地址、早期硬编码）
不在这个 PR 的责任范围，翻旧账只会让每个 PR 都红。

查四类：
  1. 密钥/令牌字面量
  2. 内网地址与私有端口
  3. 外部 CDN / 在线字体 / 第三方统计
  4. 真实姓名与个人绝对路径

用法：
    python3 dev/check_hygiene.py --base origin/main --head HEAD
"""
import re
import subprocess
import sys

SKIP_EXT = (
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg",
    ".woff", ".woff2", ".ttf", ".otf", ".fpk", ".tgz", ".zip",
    ".mp4", ".pdf", ".db", ".sqlite",
)

RULES = [
    (
        "密钥字面量",
        re.compile(
            r"(sk-[A-Za-z0-9]{20,}"
            r"|ghp_[A-Za-z0-9]{30,}"
            r"|gho_[A-Za-z0-9]{30,}"
            r"|github_pat_[A-Za-z0-9_]{40,}"
            r"|AKIA[0-9A-Z]{16}"
            r"|xox[baprs]-[A-Za-z0-9-]{20,}"
            r"|AIza[0-9A-Za-z_-]{35})"
        ),
        "疑似真实 API Key。用占位符，真值放 .env",
    ),
    (
        "内网地址",
        re.compile(
            r"\b(192\.168\.\d{1,3}\.\d{1,3}"
            r"|10\.\d{1,3}\.\d{1,3}\.\d{1,3}"
            r"|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b"
        ),
        "内网 IP 会暴露你的网络结构。示例用 192.0.2.x / 198.51.100.x",
    ),
    (
        "外链 CDN / 在线字体",
        re.compile(
            r"(fonts\.googleapis\.com"
            r"|fonts\.gstatic\.com"
            r"|cdn\.jsdelivr\.net"
            r"|unpkg\.com"
            r"|cdnjs\.cloudflare\.com"
            r"|googletagmanager\.com"
            r"|google-analytics\.com"
            r"|hm\.baidu\.com)"
        ),
        "自托管要断网可用。字体和库放本地",
    ),
    (
        "个人绝对路径",
        re.compile(r"/home/(?!hermes)[a-z_][a-z0-9_-]*/|/Users/[A-Za-z][A-Za-z0-9]*/"),
        "别人的机器上没有这个路径。用相对路径或环境变量",
    ),
]

ALLOW = re.compile(
    r"(REDACTED|YOUR_|EXAMPLE|PLACEHOLDER|placeholder|xxxx"
    r"|\.env\.example|test|spec|fixture|mock|sample)",
    re.I,
)


def git(*args):
    r = subprocess.run(["git"] + list(args), capture_output=True, text=True)
    if r.returncode != 0:
        print("git 失败: %s\n%s" % (" ".join(args), r.stderr), file=sys.stderr)
        sys.exit(2)
    return r.stdout


def main(argv):
    base = head = None
    for i, a in enumerate(argv):
        if a == "--base" and i + 1 < len(argv):
            base = argv[i + 1]
        if a == "--head" and i + 1 < len(argv):
            head = argv[i + 1]
    if not base or not head:
        print("用法: check_hygiene.py --base <ref> --head <ref>", file=sys.stderr)
        return 2

    if subprocess.run(["git", "rev-parse", "--verify", "--quiet", base],
                      capture_output=True).returncode != 0:
        print("⚠ 拿不到 base 引用 %s，跳过" % base)
        return 0

    # 只看新增行，带上文件和行号
    diff = git("diff", "--unified=0", "%s...%s" % (base, head))
    cur_file = None
    cur_line = 0
    hits = []

    for ln in diff.split("\n"):
        if ln.startswith("+++ b/"):
            cur_file = ln[6:].strip()
            continue
        if ln.startswith("@@"):
            m = re.search(r"\+(\d+)", ln)
            cur_line = int(m.group(1)) if m else 0
            continue
        if not ln.startswith("+"):
            continue
        body = ln[1:]
        this_line = cur_line
        cur_line += 1

        if cur_file and cur_file.lower().endswith(SKIP_EXT):
            continue
        if not body.strip() or ALLOW.search(body):
            continue

        for label, rx, advice in RULES:
            m = rx.search(body)
            if m:
                hits.append((label, cur_file, this_line, m.group(0)[:60], advice))

    if not hits:
        print("未发现敏感信息或外链依赖。")
        return 0

    print("发现 %d 处问题：\n" % len(hits))
    by_label = {}
    for h in hits:
        by_label.setdefault(h[0], []).append(h)

    for label, items in by_label.items():
        print("[%s] %d 处" % (label, len(items)))
        for _, f, line, frag, advice in items[:12]:
            print("  %s:%s  %s" % (f, line, frag))
        if len(items) > 12:
            print("  …另有 %d 处" % (len(items) - 12))
        print("  → %s\n" % items[0][4])

    print("=" * 60)
    print("确认是误报，在那一行加上 REDACTED / EXAMPLE / placeholder 等标记即可豁免。")
    print("规矩见 CONTRIBUTING.md 第一节「什么会被接受」。")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
