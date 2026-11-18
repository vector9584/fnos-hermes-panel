#!/usr/bin/env python3
"""检查 PR 里的 commit message 能不能让评审看懂。

设计取向：只拦「真说不清」的，不拦「格式不统一」的。

这个仓库 1631 条历史提交里，44% 没有 type 前缀、80% 没有正文，
但含糊到看不出意图的只有 3 条 —— 说明问题不在格式，在少数说不清的提交。
硬推 Conventional Commits 只会让外部贡献者卡在无意义的格式上，
所以这里只查四件事：

  1. 标题不能是空的，或纯 fix/update/修改 这类
  2. 标题不超过 100 字符（72 是建议值，超了只提醒不拦）
  3. 改动大（>300 行 或 >5 文件）就必须有正文
  4. 正文不能只重复标题

用法：
    python3 dev/check_commit_msg.py --base origin/main --head HEAD
"""
import re
import subprocess
import sys

MAX_SUBJECT_SOFT = 72
MAX_SUBJECT_HARD = 100
BIG_LINES = 300
BIG_FILES = 5

# 纯这几句等于没写
VAGUE = re.compile(
    r"^(fix|fixes|fixed|update|updated|change|changes|changeset|"
    r"wip|temp|tmp|test|tests|修改|更新|修复|改动|调整|优化|提交|保存)"
    r"[\s.。!！?？…—\-]*$",
    re.I,
)


def git(*args):
    r = subprocess.run(["git"] + list(args), capture_output=True, text=True)
    if r.returncode != 0:
        print("git 失败: %s\n%s" % (" ".join(args), r.stderr), file=sys.stderr)
        sys.exit(2)
    return r.stdout


def commits(base, head):
    """返回 [(sha, subject, body, added+deleted 行数, 文件数)]"""
    sep = "\x1f"
    rec = "\x1e"
    raw = git("log", "--format=%H{sep}%s{sep}%b{rec}".format(sep=sep, rec=rec),
              "%s..%s" % (base, head))
    out = []
    for blk in raw.split(rec):
        blk = blk.strip("\n")
        if not blk.strip():
            continue
        p = blk.split(sep)
        while len(p) < 3:
            p.append("")
        sha, subject, body = p[0].strip(), p[1], p[2]

        # 这个 commit 自己改了多少
        num = git("show", "--numstat", "--format=", sha)
        lines = files = 0
        for ln in num.split("\n"):
            if not ln.strip():
                continue
            cols = ln.split("\t")
            if len(cols) < 3:
                continue
            files += 1
            for v in cols[:2]:
                if v.isdigit():
                    lines += int(v)
        out.append((sha[:8], subject, body, lines, files))
    return out


def check(c):
    sha, subject, body, lines, files = c
    s = subject.strip()
    b = body.strip()
    problems = []
    warns = []

    if not s:
        problems.append("标题是空的")
        return problems, warns

    if VAGUE.match(s):
        problems.append(
            "标题「%s」等于没写，看不出改了什么" % s
        )

    if len(s) > MAX_SUBJECT_HARD:
        problems.append("标题 %d 字符，超过 %d" % (len(s), MAX_SUBJECT_HARD))
    elif len(s) > MAX_SUBJECT_SOFT:
        warns.append("标题 %d 字符，建议压到 %d 以内（把细节挪进正文）"
                     % (len(s), MAX_SUBJECT_SOFT))

    big = lines > BIG_LINES or files > BIG_FILES
    if big and not b:
        problems.append(
            "改动了 %d 行 / %d 个文件，但没有正文说明为什么改、怎么验"
            % (lines, files)
        )

    if b:
        # 正文只把标题抄一遍
        first = b.split("\n")[0].strip()
        if first and first == s:
            problems.append("正文只是把标题抄了一遍，没有补充信息")
        elif len(b) < 12:
            warns.append("正文只有 %d 字，基本等于没写" % len(b))

    return problems, warns


def main(argv):
    base = head = None
    for i, a in enumerate(argv):
        if a == "--base" and i + 1 < len(argv):
            base = argv[i + 1]
        if a == "--head" and i + 1 < len(argv):
            head = argv[i + 1]
    if not base or not head:
        print("用法: check_commit_msg.py --base <ref> --head <ref>", file=sys.stderr)
        return 2

    # base 不存在时（浅克隆）退化成只查最后一个 commit
    if subprocess.run(["git", "rev-parse", "--verify", "--quiet", base],
                      capture_output=True).returncode != 0:
        print("⚠ 拿不到 base 引用 %s，退化为只检查 HEAD 一个提交" % base)
        base = head + "~1"

    cs = commits(base, head)
    if not cs:
        print("没有新增提交，跳过")
        return 0

    fails = 0
    print("检查 %d 个提交\n" % len(cs))
    for c in cs:
        problems, warns = check(c)
        sha, subject = c[0], c[1]
        if problems:
            fails += 1
            print("✗ %s  %s" % (sha, subject[:80]))
            for p in problems:
                print("     %s" % p)
            for w in warns:
                print("     ⚠ %s" % w)
        elif warns:
            print("⚠ %s  %s" % (sha, subject[:80]))
            for w in warns:
                print("     %s" % w)
        else:
            print("✓ %s  %s" % (sha, subject[:80]))

    print()
    if fails:
        print("=" * 60)
        print("%d 个提交需要补充说明。" % fails)
        print("改法：git commit --amend（最后一个）或 git rebase -i <base>（多个）")
        print("规矩见 CONTRIBUTING.md 第二节「Commit 怎么写」。")
        return 1
    print("全部通过。")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
