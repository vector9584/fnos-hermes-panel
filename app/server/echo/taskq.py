#!/usr/bin/env python3
"""任务队列 taskq — 随手收想法，空闲时段处理。

状态机（2026-11-03 扩）：
    staged  暂存：先不入队，tick 不碰
    pending 待办：tick 会扫
    doing   在做
    review  需决策：活干完了但有件事要人拍板，tick 不碰，等人点头
    done    已回信
    failed  没做成
    dropped 沉寂

设计要点：
  * 队列文件站点侧 .acl/tasks/tasks.json，原子写 + flock 串行化（页面 PHP 与 cron 共用）
  * 峰谷判定走 DeepSeek 官方口径：北京时间周一至周五 9:00-12:00、14:00-18:00
    为高峰（法定节假日除外），其余时段（含午休、夜间、周末、节假日）为空闲
  * `tick` 专供 cron 用：非空闲/无任务/冷却中 → 最后一行输出 {"wakeAgent": false}
    让 scheduler 直接跳过 agent（零 token、零投递）
"""
from __future__ import annotations

import argparse
import copy
import fcntl
import json
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.request
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

if __package__:
    from .store import panel, transaction, read
else:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from echo.store import panel, transaction, read

DATA = Path(os.environ.get("ECHO_DATA_ROOT", "/vol1/@apphome/hermes-agent/data"))
# 队列文件放在站点 .acl 下：页面（PHP/www-data）与 cron（hermes-agent）共用同一份，
# 目录 1777、文件 666，两边都能原子替换
BASE = Path(os.environ.get("ECHO_QUEUE_ROOT", "/vol1/1000/飞牛文件/html/.acl/tasks"))
BACKUPS = Path(os.environ.get("ECHO_BACKUP_ROOT", "/vol1/@appdata/hermes-agent/panel-state/echo-backups"))
QUEUE = BASE / "tasks.json"
HOLIDAYS = DATA / "taskqueue" / "holidays.json"
LOCKF = BASE / "tasks.json.lock"
BARK = DATA / "scripts" / "bark_push.py"
# 余额缓存放在站点 .acl 下：www-data 读得到，页面 api.php 只读它，不碰 API key
BALANCE = BASE / "balance.json"
TZ = ZoneInfo("Asia/Shanghai")

# 每轮在任务前面顶一段：让 agent 第一眼看到的就是「先拆解」。
# 这是软提醒（语言指令），但和 done 的硬闸配套 —— 一头劝，一头拦。
TODO_LEAD = (
    "【动手前先拆解】调 todo 工具把这件事拆成 2-4 条具体待办（动词开头、每条能验收），"
    "干完一条就把那条 status 改成 completed，整份清单再写一次。"
    "别把「交付/汇报」当成一条待办 —— 那是 done 自己的事。没调 todo 也照常收，卡片上会挂「未拆解」。"
)

# 交付也要「填表」：字段一个个填，前端按字段摆版面，不靠正则去散文里捞数字。
RESULT_LEAD = """【交付怎么填】做完照这张表填，一个字段一个格子 —— 不要写成一整段散文：

  python3 /vol1/@appcenter/hermes-agent/server/echo/taskq.py done <ID> --json '{
    "result":  "一句话结论（≤40 字，人只看这行就知道成没成）",
    "numbers": [{"k": "脚本数", "v": "119"}, {"k": "总体积", "v": "1.15 MB"}],
    "files":   ["/绝对路径/产物"],
    "detail":  "口径、坑、为什么是这个数（可选，≤200 字）",
    "pending": {"q": "要他拍板的问题", "a": "你的建议"}
  }'

规矩：
- 能量化的全部进 numbers，别埋进句子里：「共 119 个」要拆成 k=脚本数 v=119。
- 散文只允许出现在 detail，且别超 200 字。
- pending 填了 = 让他拍板（卡片转「待定」）；不填 = 直接交付。
- 拿不到的数字留空或写「未测」，绝对别编。"""

WAKE_YES = '{"wakeAgent": true}'
WAKE_NO = '{"wakeAgent": false}'

def boolish(v):
    return 1 if str(v).lower() in ("1", "true", "yes", "on", "y") else 0


STATUSES = ("staged", "pending", "doing", "review", "done", "failed", "dropped")
MARKS = {
    "staged": "・",
    "pending": "○",
    "doing": "◐",
    "review": "◇",
    "done": "●",
    "failed": "✗",
    "dropped": "—",
}


# ---------------------------------------------------------------- 存储层

def _empty() -> dict:
    return {"version": 1, "seq": 0, "last_run": None, "tasks": []}


def load() -> dict:
    with panel.locked(QUEUE, False):
        return read(QUEUE)[1]


def _guard_execution(before, after):
    prior = {t['id']: t for t in before['tasks']}
    for task in after['tasks']:
        old = prior.get(task['id'])
        if not old or old == task:
            continue
        if old['status'] != 'doing' and task['status'] == 'doing':
            raise ValueError('执行状态只能由原生定时调度器认领')
        if old['status'] == 'doing' and not old.get('panel_run'):
            raise ValueError('旧任务尚无执行归属，请先核对原执行是否结束')
        run = old.get('panel_run') or {}
        if run.get('state') == 'running':
            if os.environ.get('ECHO_RUN_ID') != run['id'] or os.environ.get('ECHO_TASK_ID') != str(task['id']):
                raise ValueError('任务由其他执行接手，不能写入；请使用当前执行的命令上下文')
            if old.get('panel_cancel_requested'):
                raise ValueError('该任务已请求取消，不能再提交新结果')
        elif os.environ.get('ECHO_RUN_ID'):
            raise ValueError('本次执行已结束，不能写入其他或过期任务')
    if set(prior) - {t['id'] for t in after['tasks']}:
        raise ValueError('不支持硬删除任务；请归档并保留历史')


@contextmanager
def tx():
    with transaction(QUEUE, BACKUPS) as data:
        before = copy.deepcopy(data)
        yield data
        _guard_execution(before, data)


# ---------------------------------------------------------------- 峰谷判定

def holidays() -> set[str]:
    try:
        return set(json.loads(HOLIDAYS.read_text(encoding="utf-8")).get("dates", []))
    except Exception:
        return set()


def peak_status(now: datetime | None = None) -> tuple[bool, str]:
    """-> (是否高峰, 人话原因)"""
    now = now or datetime.now(TZ)
    day = now.date().isoformat()
    if day in holidays():
        return False, "法定节假日全天空闲"
    if now.weekday() >= 5:
        return False, "周末全天空闲"
    m = now.hour * 60 + now.minute
    if 9 * 60 <= m < 12 * 60:
        return True, "上午高峰 9:00-12:00"
    if 14 * 60 <= m < 18 * 60:
        return True, "下午高峰 14:00-18:00"
    return False, "空闲时段"


def next_idle_start(now: datetime | None = None) -> datetime:
    """下一个空闲时段起点（用于回显“几点处理”）。"""
    now = now or datetime.now(TZ)
    is_peak, _ = peak_status(now)
    if not is_peak:
        return now
    cand = now.replace(hour=12, minute=0, second=0, microsecond=0)
    if now.hour * 60 + now.minute >= 14 * 60:
        cand = now.replace(hour=18, minute=0, second=0, microsecond=0)
    return cand


# ---------------------------------------------------------------- 通知

def bark(title: str, body: str) -> bool:
    """任务跟踪推送。失败只警告，绝不打断队列 —— 但要把成败说回来。"""
    try:
        r = subprocess.run(
            [sys.executable, str(BARK), "--title", title, "--body", body],
            capture_output=True, timeout=25, check=False, text=True,
        )
        if r.returncode != 0:
            print(f"[warn] bark 退出码 {r.returncode}：{((r.stderr or r.stdout) or '')[:200]}",
                  file=sys.stderr)
            return False
        return True
    except Exception as e:
        print(f"[warn] bark 推送失败：{e}", file=sys.stderr)
        return False


def notify(t: dict, kind: str, extra: str = "") -> None:
    if not t.get("track"):
        return
    msg = {
        "claim": "接住了",
        "done": "回信了",
        "review": "等你拍板",
        "fail": "没做成",
        "pick": "被扫到",
    }.get(kind, kind)
    title = f"回声站 #%s {msg}" % t["id"]
    body = t.get("title", "")
    # 正文直接用「往来记录」里刚写进去那条的原话，别另编一套说法：
    # 手机上看到什么，点进去就该看到同一句。
    last = ""
    for e in reversed(t.get("events") or []):
        if e.get("text"):
            last = str(e["text"])
            break
    if last and last != body:
        body += "\n" + last
    if extra and extra not in last:
        body += "\n" + extra
    ok = bark(title, body[:400])
    # 推送这条本身也进往来记录：手机上响没响，页面上得能对上号
    try:
        with tx() as q:
            t2 = find(q, t["id"])
            if t2:
                ev(t2, "bark", text=("手机推送：" + msg) if ok else ("手机推送没发出去：" + msg),
                   note=msg)
    except Exception as e:
        print(f"[warn] 记推送结果失败：{e}", file=sys.stderr)


# ---------------------------------------------------------------- 展示层

def advice_of(decide: str) -> str:
    """待定写成「问题：… / 建议：…」，这里只取建议那一半当新任务的要求。"""
    got: list[str] = []
    for raw in str(decide or "").splitlines():
        s = raw.strip().lstrip("·•-* ").strip()
        if not s:
            continue
        m = re.match(r"^(建议|方案|对策)\s*[:：]\s*(.+)$", s)
        if m:
            got.append(m.group(2).strip())
    return "\n".join(got)


def norm_decide(s: str) -> str:
    """待定的约定：问题一条、建议一条，分开写。缺一半就补兜底，
    页面那块永远是两块，不会只剩半个。"""
    s = (s or "").strip()
    if not s:
        return s
    head = s.split("\n")[0]
    if not head.startswith("问题"):
        s = "问题：" + s
    if "建议" not in s:
        s += "\n建议：按你的判断办"
    return s


def make_child(q: dict, parent: dict, want: str, origin: str) -> int:
    """开一条子任务：呼号、标题跟着根卡走，父卡自己的条目一条不加。
    子任务还能再开子任务，拆解数在页面上逐层并到根卡。"""
    now = now_s()
    q["seq"] = int(q.get("seq") or 0) + 1
    cid = q["seq"]
    child = {
        "id": cid, "call": parent.get("call") or parent["id"], "parent": parent["id"],
        "title": parent.get("title") or "", "type": parent.get("type") or "其他",
        "star": parent.get("star", 3), "priority": parent.get("star", 3),
        "detail": fork_brief(parent, want),
        "status": "pending", "created": now, "updated": now, "attempts": 0,
        "todos": [{"c": want[:200], "s": "todo"}],
        "entries": [], "events": [], "rounds": 0,
        "claimed_at": None, "delivered_at": None, "archived_at": None,
        "exec": parent.get("exec") or {"mode": "normal", "iters": 3, "model": ""},
    }
    ev(child, "created", text=want, note=origin)
    q["tasks"].append(child)
    return cid


def fork_brief(p: dict, want: str) -> str:
    """子任务要能独立被接手：cron 唤醒时只看这一条，父卡的目标和进度得跟着走。

    机器拿到的就是四段：目标 / 任务 / 已完成 / 未完成。少一段它就得回头翻父卡。
    """
    def blk(xs) -> str:
        xs = [str(x).strip() for x in xs if x and str(x).strip()]
        return "\n".join("· " + x[:160] for x in xs) if xs else "· 无"

    done = [x.get("c") for x in p.get("todos", []) if x.get("s") == "done"]
    left = [x.get("c") for x in p.get("todos", []) if x.get("s") != "done"]
    said = [e.get("text") for e in p.get("entries", []) if e.get("kind") == "deliver"]
    return "\n".join([
        "目标：" + (p.get("title") or ""),
        "任务：" + want,
        "已完成：", blk(done + [s[:120] for s in said]),
        "未完成：", blk(left + [want]),
    ])


def bullets(text: str) -> list[str]:
    """把任务要求拆成小点 —— 口径是 @，不是回车（2026-11-03 用户定）。

    一个 @ 分隔一条任务，回车只是行内换行，不另起一条。这样写的人可以
    把一段话说成一整段、照样用 @ 切成几件事；以前按行拆，回车乱用就会
    把一句话拆成两个半句分别去办。
    没有 @ 时整段算一条，不硬切：宁可办一件大的，也不要把一句话劈开。
    """
    raw = str(text or "").strip()
    if not raw:
        return []
    out: list[str] = []
    # 不当分隔符的三种：邮箱 a@b.com（前后都是邮箱字符）、
    # 绝对路径 /vol1/@apphome（@ 前是斜杠）、Windows 路径 \x@y。
    # 「看 A@第二件事」前面虽是字母 A，但后面是中文，还是要拆。
    for part in re.split(r"(?<![/\\])(?:(?<![A-Za-z0-9._%+-])[@＠]|[@＠](?![A-Za-z0-9]))", raw):
        s = re.sub(r"\s*\n\s*", " ", part).strip(" \t·•-*")
        if s:
            out.append(s[:200])
    return out[:20]


MIN_STAR = 1.0   # 一星以下（主要是半星）＝暂存：不进队列、cron 永远扫不到


def star_of(t: dict) -> float:
    """星级统一读法：0 / 0.5 / 1.0 … 5.0，十档。"""
    try:
        v = float(t.get("star") or t.get("priority") or 0)
    except (TypeError, ValueError):
        v = 0.0
    return max(0.0, min(5.0, round(v * 2) / 2))


def star_txt(v: float) -> str:
    if not v:
        return ""
    full = int(v)
    return "★" * full + ("½" if v - full >= 0.5 else "")


def fmt_task(t: dict, long: bool = False) -> str:
    mark = MARKS.get(t.get("status", ""), "?")
    star = star_of(t)
    line = f"{mark} #{t['id']} {t['title']}"
    tags = list(t.get("tags") or [])
    if t.get("type") and t["type"] not in tags:
        tags = [t["type"]] + tags
    if tags:
        line += "  [" + "/".join(tags) + "]"
    if star:
        line += "  " + star_txt(star)
    flags = []
    if t.get("track"):
        flags.append("跟踪")
    ex = t.get("exec") or {}
    if ex.get("mode") == "deep":
        flags.append(f"深入×{ex.get('iters') or 3}")
    if ex.get("model"):
        flags.append(f"模型{ex['model']}")
    if t.get("status") == "staged":
        flags.append("暂存")
    if flags:
        line += "  (" + " · ".join(flags) + ")"

    if long:
        line += f"\n   状态 {t['status']} · 建立 {str(t.get('created', ''))[:16]} · 试过 {t.get('attempts', 0)} 次"
        bl = bullets(t.get("detail") or "")
        if bl:
            line += "\n   要求："
            for i, b in enumerate(bl, 1):
                line += f"\n     {i}. {b}"
        todos = t.get("todos") or []
        if todos:
            line += "\n   拆解："
            for i, td in enumerate(todos, 1):
                s = {"done": "✔", "doing": "◐"}.get(td.get("s", ""), "·")
                line += f"\n     {s} {i}. {td.get('c', '')}"
        if t.get("deliver"):
            line += f"\n   交付 {t['deliver']}"
        if t.get("result"):
            line += f"\n   回信 {t['result']}"
        if t.get("decide"):
            line += f"\n   待你拍板 {t['decide']}"
        if t.get("error"):
            line += f"\n   错误 {t['error']}"
    return line


def pending_of(q: dict) -> list[dict]:
    """待办：只要一星及以上。半星/零星是暂存，机制上就进不来，不靠提示词。"""
    ps = [t for t in q["tasks"]
          if t.get("status") == "pending" and star_of(t) >= MIN_STAR]
    ps.sort(key=lambda t: (-star_of(t), t["id"]))
    return ps


def find(q: dict, tid: int) -> dict | None:
    for t in q["tasks"]:
        if t["id"] == tid:
            return t
    return None


def now_s() -> str:
    return datetime.now(TZ).isoformat(timespec="seconds")


# ---------------------------------------------------------------- 命令

def ev(t, kind, text="", **extra) -> None:
    """记一条状态流转。页面「往来记录」就是把这些 events 摊平按时间排。

    text 是这条节点当时真正的内容（放得下全文），note 只留一行摘要。
    往来记录要能看出：什么时候发出、什么时候在途、什么时候回信、什么时候又发出。
    """
    e = {"t": now_s(), "k": kind}
    if text:
        e["text"] = str(text)[:800]
    e.update({k: v for k, v in extra.items() if v})
    t.setdefault("events", []).append(e)


def cmd_add(a) -> int:
    title = (a.text or "").strip()
    if not title:
        print("内容不能为空", file=sys.stderr)
        return 2
    with tx() as q:
        q["seq"] += 1
        tid = q["seq"]
        star = max(0.0, min(5.0, round(float(getattr(a, "star", 0) or 0) * 2) / 2))
        typ = (getattr(a, "type", "") or "").strip()
        detail = getattr(a, "detail", None)
        if detail is None:
            detail = a.note or ""
        tags = [t.strip() for t in (a.tag or []) if t.strip()]
        if typ and typ not in tags:
            tags = [typ] + tags
        # 一星以下＝暂存，这条规则写死在这里，不走提示词
        status = "staged" if (getattr(a, "stage", False) or star < MIN_STAR) else "pending"
        t = {
            "id": tid,
            "title": title,
            "type": typ,
            "star": star,
            "detail": detail,
            "note": detail,
            "status": status,
            "priority": star,
            "tags": tags,
            "source": a.source or "chat",
            "track": bool(getattr(a, "track", False)),
            "exec": {
                "mode": getattr(a, "deep", False) and "deep" or "normal",
                "iters": int(getattr(a, "iters", 0) or 0) or 3,
                "model": getattr(a, "model", "") or "",
            },
            "todos": [],
            "deliver": "",
            "decide": "",
            "created": now_s(),
            "updated": now_s(),
            "attempts": 0,
            "result": "",
            "error": "",
            "events": [],
        }
        ev(t, "created", text=(t.get("title") or "") + ("\n" + (t.get("detail") or "") if t.get("detail") else ""), by=t["source"])
        q["tasks"].append(t)
        n = len(pending_of(q))
    print(f"+ 已入队 #{tid}：{title[:60]}（待办 {n} 条，{status}）")
    return 0


def cmd_list(a) -> int:
    q = load()
    if a.all:
        rows = q["tasks"]
    elif a.status:
        rows = [t for t in q["tasks"] if t["status"] == a.status]
    else:
        rows = pending_of(q)
    if not rows:
        print("队列空。")
        return 0
    for t in sorted(rows, key=lambda t: (-t.get("priority", 0), t["id"])):
        print(fmt_task(t, long=a.long))
    pend = len(pending_of(q))
    print(f"\n待办 {pend} 条 / 共 {len(q['tasks'])} 条记录")
    return 0


def cmd_show(a) -> int:
    q = load()
    t = find(q, a.id)
    if not t:
        print(f"没有 #{a.id}", file=sys.stderr)
        return 1
    print(fmt_task(t, long=True))
    return 0


def cmd_notify_claim(a):
    task = find(load(), a.id)
    if not task or (task.get('panel_run') or {}).get('id') != os.environ.get('ECHO_RUN_ID'):
        raise ValueError('执行标识不匹配，未发送通知')
    notify(task, 'claim')
    return 0


def cmd_claim(a) -> int:
    with tx() as q:
        t = find(q, a.id)
        if not t:
            print(f"没有 #{a.id}", file=sys.stderr)
            return 1
        if (t.get('panel_run') or {}).get('state') == 'running':
            if os.environ.get('ECHO_RUN_ID') != t['panel_run']['id']:
                raise ValueError('任务已由另一个执行接手')
            print(f"#{a.id} 本次已认领，无需重复 claim")
            return 0
        if t['status'] not in ('pending',):
            raise ValueError('只有待回信任务可以认领')
        raise ValueError('请让原生定时调度器认领任务，避免无归属执行')
def exact_rounds(task):
    ids = list(dict.fromkeys((task.get('panel_run') or {}).get('session_ids') or [session_of(task)]))
    ids = [sid for sid in ids if sid]
    if not ids:
        return None
    try:
        with sqlite3.connect(f"file:{DATA / 'state.db'}?mode=ro", uri=True, timeout=3) as db:
            rows = db.execute('select api_call_count from sessions where id in (' + ','.join('?' for _ in ids) + ')', ids).fetchall()
        return sum(row[0] or 0 for row in rows) if rows else None
    except sqlite3.Error:
        return None


def tool_todos(t: dict):
    """把后台真正调用 todo 工具建的清单读回来。

    后台跑在一个 cron agent 会话里，它调 todo 工具写的列表会作为 tool 消息
    落在 state.db —— 这里捞该会话最后一份，页面的「拆解 x/y」就是它自己的
    状态，不是我拿要求原文猜的。捞不到返回 None，调用方别覆盖已有数据。
    """
    db = str(DATA / "state.db")
    if not os.path.exists(db):
        return None
    sid = session_of(t)
    if not sid:
        return None
    sql = "select content from messages where role='tool' and content like '{\"todos\"%' "
    try:
        c = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=5)
        try:
            row = c.execute(sql + "and session_id=? order by id desc limit 1", (sid,)).fetchone()
        finally:
            c.close()
    except Exception:
        return None
    if not row:
        return None
    try:
        data = json.loads(row[0]).get("todos") or []
    except Exception:
        return None
    out = []
    for it in data:
        s = str(it.get("status") or "")
        out.append({
            "c": str(it.get("content") or it.get("c") or "")[:200],
            "s": "done" if s == "completed" else "todo",
        })
    return out or None


def cmd_done(a) -> int:
    with tx() as q:
        t = find(q, a.id)
        if not t:
            print(f"没有 #{a.id}", file=sys.stderr)
            return 1
        run = t.get('panel_run') or {}
        submission = panel.digest({key: getattr(a, key, None) for key in ('result', 'deliver', 'decide', 'json', 'review', 'rounds')})
        if run.get('submission'):
            if run['submission'] != submission:
                raise ValueError('本次交付已保存；请通过追加子任务继续工作')
            print(f"#{a.id} 本次交付已保存，无需重复提交")
            return 0
        # 有没有真调过 todo 工具：照实记下来，收还是照收。
        # 不拒收 —— 拒收会让 Discord 那边说「干完了」、卡片这边却空着，两边对不上；
        # 交付本身就是结果，缺的只是拆解，所以卡片上标一个「未拆解」就行。
        tool_list = tool_todos(t)
        no_todo = bool(t.get("claimed_at") and not tool_list)
        if no_todo:
            print(f"#{a.id} 这次没有 todo 工具的记录 —— 照常收，卡片标「未拆解」。", file=sys.stderr)

        deliver = getattr(a, "deliver", "") or ""
        report = None
        decide = norm_decide(getattr(a, "decide", "") or "")
        # 优先读「填表」字段：pending 里 q/a 是两个格子，页面直接摆两块，
        # 不用再从一整句话里猜哪句是问题、哪句是建议
        pq = pa = ""
        raw_json = (getattr(a, "json", "") or "").strip()
        if raw_json:
            try:
                payload = json.loads(raw_json)
            except Exception:
                print("--json 不是合法 JSON，什么都没改", file=sys.stderr)
                return 1
            if str(payload.get("result") or "").strip():
                a.result = str(payload["result"]).strip()
            if str(payload.get("deliver") or "").strip():
                deliver = str(payload["deliver"]).strip()
            pj = payload.get("pending") or payload.get("decide") or {}
            if isinstance(pj, dict):
                pq = str(pj.get("q") or pj.get("question") or "").strip()
                pa = str(pj.get("a") or pj.get("advice") or pj.get("suggest") or "").strip()
            elif isinstance(pj, str):
                pq = pj.strip()
            if pq or pa:
                decide = (("问题：" + pq) if pq else "") + (("\n建议：" + pa) if pa else "")
            # 结构化交付：numbers/files/detail 各自进自己那格，前端照着摆，
            # 不靠 split 去猜哪段是数字、哪段是文件路径
            rep = {}
            for _k in ("result", "detail"):
                _v = str(payload.get(_k) or "").strip()
                if _v:
                    rep[_k] = _v
            _n = payload.get("numbers")
            if isinstance(_n, list):
                rep["numbers"] = [
                    {"k": str(x.get("k") or "").strip(), "v": str(x.get("v") or "").strip()}
                    for x in _n
                    if isinstance(x, dict) and (x.get("k") or x.get("v"))
                ]
            _f = payload.get("files")
            if isinstance(_f, list):
                rep["files"] = [str(x).strip() for x in _f if str(x).strip()]
            if rep.get("numbers") or rep.get("files"):
                report = rep
            # 没给 deliver 文本时按字段拼一份，老渲染（纯文本）照样能看
            if not deliver and (rep.get("detail") or rep.get("numbers") or rep.get("files")):
                _parts = []
                if rep.get("detail"):
                    _parts.append(rep["detail"])
                if rep.get("numbers"):
                    _parts.append(" · ".join(f"{x['k']} {x['v']}" for x in rep["numbers"] if x["k"] or x["v"]))
                if rep.get("files"):
                    _parts.append("\n".join(rep["files"]))
                deliver = "\n".join(_parts)
        if deliver:
            t["deliver"] = deliver
        if run:
            run['submission'] = submission
        if report:
            t["report"] = report
        if decide:
            t["decide"] = decide
        if decide or getattr(a, "review", False):
            t["status"] = "review"
            kind = "review"
        else:
            t["status"] = "done"
            kind = "done"
        if getattr(a, "result", ""):
            t["result"] = a.result
        t["updated"] = now_s()
        # 交付时间 = 处理完的一刻；开始处理的时间在 claim 时已经落下
        t["delivered_at"] = t["updated"]
        t["archived_at"] = None
        # 处理轮：显式给了就认；没给直接读网关记录（这个会话真实的模型调用次数）
        n = int(getattr(a, "rounds", 0) or 0)
        src = "flag" if n else ""
        if not n:
            n = exact_rounds(t) or 0
            src = "gateway" if n else ""
        t["rounds"] = n or None
        t["rounds_src"] = src or None
        # 这次花了多少钱：读后台会话的真实 token 按官方价折。会话还在跑时数会偏小，
        # 沉淀那一步（会话早已结束）会再算一次覆盖掉。
        _u = usage_of(session_of(t))
        if _u:
            t["usage"] = _u
        # 标准 entries：页面按 kind 上色（deliver 蓝 / reply 绿 / pending 橙 / silent 灰）
        t["entries"] = t.get("entries") or []
        # 条目顺序照时间走：回信（开始处理）→ 交付（处理完）→ 待定（要人拍板）
        if getattr(a, "result", ""):
            t["entries"].append({"kind": "reply", "text": a.result, "at": t.get("claimed_at") or t["updated"]})
        if deliver:
            t["entries"].append({"kind": "deliver", "text": deliver, "at": t["updated"]})
        if decide:
            ent = {"kind": "pending", "text": decide, "at": t["updated"]}
            if pq:
                ent["q"] = pq
            if pa:
                ent["a"] = pa
            t["entries"].append(ent)
        _txt = "\n".join(x for x in (a.result or "", deliver, decide) if x)
        ev(t, kind, text=_txt, note=(a.result or decide or deliver or "")[:80])
        # 标记跟交付一起落：有工具记录就把上次的标记清掉，别挂着老账
        if no_todo:
            t["no_todo"] = True
            ev(t, "untodo", text="这次没拆解，直接交付", note="缺 todo 工具记录")
        else:
            t.pop("no_todo", None)
        # 拆解以后台真调的 todo 工具为准：那份清单带每条的完成状态，
        # 直接搬过来；没有工具记录（老卡 / agent 没建）才退回下面的兜底。
        if tool_list:
            t["todos"] = tool_list
            t["todos_src"] = "tool"
            # 交付时还剩几条没勾 —— 只记账，绝不替它勾。
            # 勾了就等于把「哪步做完、哪步没做完」抹平，那张卡的 2/3 就成了摆设。
            if kind == "done":
                left = [i + 1 for i, td in enumerate(t["todos"]) if td.get("s") != "done"]
                if left:
                    ev(t, "todo", text=f"交付时还有 {len(left)} 条没勾（第 {'、'.join(map(str, left))} 条）")
        # 子任务的结果不往父卡里塞条目：父卡只有自己那一条回信，
        # 子任务那一组由前端嵌在「待定」下面显示（fork 是从待定长出来的）
        left = len(pending_of(q))
    notify(t, kind, (a.result or decide or "")[:200])
    if kind == "review":
        print(f"◇ #{a.id} 已回信，但有一件要你拍板 · 剩 {left} 条待办")
        print(f"   待你拍板：{decide or a.result}")
    else:
        print(f"● #{a.id} 完成，剩 {left} 条待办")
        if deliver:
            print(f"   交付：{deliver}")
    if t.get("rounds"):
        print(f"   处理轮 {t['rounds']}（{'网关记录' if t.get('rounds_src') == 'gateway' else '手填'}）")
    return 0


def cmd_review(a) -> int:
    with tx() as q:
        t = find(q, a.id)
        if not t:
            print(f"没有 #{a.id}", file=sys.stderr)
            return 1
        t["status"] = "review"
        t["decide"] = a.decide or t.get("decide") or ""
        if a.result:
            t["result"] = a.result
        t["updated"] = now_s()
        t["delivered_at"] = t["updated"]
        # 处理轮同样走网关记录，不让 AI 手填
        n = int(getattr(a, "rounds", 0) or 0) or (exact_rounds(t) or 0)
        if n:
            t["rounds"] = n
            t["rounds_src"] = "flag" if getattr(a, "rounds", 0) else "gateway"
        t["entries"] = t.get("entries") or []
        if a.result:
            t["entries"].append({"kind": "reply", "text": a.result, "at": t["updated"]})
        if t["decide"]:
            t["entries"].append({"kind": "pending", "text": t["decide"], "at": t["updated"]})
        ev(t, "review", text=a.decide or "", note=(a.decide or "")[:80])
    notify(t, "review", a.decide or "")
    print(f"◇ #{a.id} 转入「需决策」，等你点头")
    if a.decide:
        print(f"   待定：{a.decide}")
    return 0


def cmd_archive(a) -> int:
    """沉寂 = 归档：任务全部做完收起来，往来记录里只留一条索引。"""
    with tx() as q:
        t = find(q, a.id)
        if not t:
            print(f"没有 #{a.id}", file=sys.stderr)
            return 1
        note = (getattr(a, "note", "") or "").strip() or "收工归档"
        t["entries"] = t.get("entries") or []
        t["entries"].append({"kind": "silent", "text": note, "at": now_s()})
        t["drop_reason"] = note
        t["status"] = "dropped"
        t["archived_at"] = now_s()
        t["updated"] = t["archived_at"]
        # 沉寂 = 归档 + 沉淀：后台那次会话要写成笔记，交给 sediment worker
        t["sediment"] = {"at": t["archived_at"], "status": "pending"}
        ev(t, "archive", text=note, note=note[:80])
        # 子任务沉寂也不往父卡塞条目 —— 它自己在父卡的子任务组里显示状态
        left = len(pending_of(q))
    print(f"◦ #{a.id} 已沉寂 · 剩 {left} 条待办")
    return 0


def cmd_append(a) -> int:
    """在已有的卡上追加新要求：标题、呼号不动，只加内容，重新排回待回信。"""
    with tx() as q:
        t = find(q, a.id)
        if not t:
            print(f"没有 #{a.id}", file=sys.stderr)
            return 1
        add = (getattr(a, "detail", "") or "").strip()
        if not add:
            print("追加内容不能空", file=sys.stderr)
            return 1
        t["detail"] = (t.get("detail") or "").rstrip() + "\n· 追加：" + add
        t["status"] = "pending"
        t["decide"] = ""
        t["delivered_at"] = None
        t["archived_at"] = None
        t["updated"] = now_s()
        ev(t, "append", text=add, note=add[:80])
        left = len(pending_of(q))
    print(f"+ #{a.id} 已追加，回到待回信 · 共 {left} 条待办")
    return 0


def cmd_answer(a) -> int:
    """按建议执行 = fork 出一条新任务：呼号、标题跟着父卡走，要求换成建议（或你填的那句）。

    父卡把待定留进历史、收进已回信；子卡进待回信，带 parent 指回来。
    """
    with tx() as q:
        t = find(q, a.id)
        if not t:
            print(f"没有 #{a.id}", file=sys.stderr)
            return 1
        note = (a.note or "").strip()
        decide = (t.get("decide") or "").strip()
        advice = advice_of(decide)
        want = note or advice or decide
        now = now_s()
        entries = t.setdefault("entries", [])
        # 父卡只留自己那一条回信：待定和回信都不再追加 ——
        # 子任务嵌在待定下面显示，父卡上多写一句就变成两条回信
        t["decide"] = ""
        t["status"] = "done"
        t["delivered_at"] = t.get("delivered_at") or now
        t["updated"] = now
        cid = make_child(q, t, want, f"按 #{t['id']} 的待定 fork")
        ev(t, "answer", text=want, note=f"按建议开出子任务 #{cid}")
        left = len(pending_of(q))
    print(f"↺ #{a.id} 收工，开新任务 #{cid}「{want[:40]}」进待回信 · 共 {left} 条待办")
    return 0


def cmd_spawn(a) -> int:
    """追加 = 我认为你没完成：从这张卡再长一条子任务出来，可以一层层往下嵌套。

    跟「按建议执行」是同一条链路（make_child），区别只是内容来自你手写那句，
    而且不要求这张卡有待定 —— 收工了也能说「这活还没完」。
    """
    with tx() as q:
        t = find(q, a.id)
        if not t:
            print(f"没有 #{a.id}", file=sys.stderr)
            return 1
        want = (getattr(a, "want", "") or getattr(a, "note", "") or "").strip()
        if not want:
            print("要写清楚哪件事没完成", file=sys.stderr)
            return 1
        cid = make_child(q, t, want, f"从 #{a.id} 追加")
        t["updated"] = now_s()
        ev(t, "append", text=want, note=f"追加子任务 #{cid}")
        left = len(pending_of(q))
    print(f"+ #{a.id} 追加开出子任务 #{cid}「{want[:40]}」· 共 {left} 条待办")
    return 0


def cmd_todo(a) -> int:
    with tx() as q:
        t = find(q, a.id)
        if not t:
            print(f"没有 #{a.id}", file=sys.stderr)
            return 1
        todos = t.setdefault("todos", [])
        note = ""
        if a.add:
            todos.append({"c": a.add[:200], "s": "todo"})
            note = f"拆出第 {len(todos)} 条：{a.add[:60]}"
        for dn in (a.done or []):
            i2 = dn - 1
            if 0 <= i2 < len(todos):
                todos[i2]["s"] = "done"
                note = f"办完第 {dn} 条：{todos[i2]['c'][:60]}"
        if a.set:
            idx = a.set - 1
            if 0 <= idx < len(todos):
                todos[idx]["s"] = a.status or "done"
        if a.replace:
            t["todos"] = [{"c": x.strip()[:200], "s": "todo"} for x in a.replace if x.strip()]
        if a.clear:
            t["todos"] = []
        if not note:
            note = f"第 {a.set} 项→{a.status}" if a.set else ("清空了拆解" if a.clear else "重排了拆解")
        ev(t, "todo", text=note[:80], note=note[:80])
        snap = list(t.get("todos") or [])
    if not snap:
        print(f"#{a.id} 没有拆解")
    else:
        print(f"#{a.id} 拆解 {len(snap)} 条：")
        for i, td in enumerate(snap, 1):
            s = {"done": "✔", "doing": "◐"}.get(td.get("s", ""), "·")
            print(f"  {s} {i}. {td['c']}")
    return 0


def cmd_stage(a) -> int:
    with tx() as q:
        t = find(q, a.id)
        if not t:
            print(f"没有 #{a.id}", file=sys.stderr)
            return 1
        cur = t.get("status")
        if getattr(a, "off", False):
            on = False
        elif getattr(a, "on", False):
            on = True
        else:
            on = cur != "staged"          # 不带参数＝切换
        t["status"] = "staged" if on else "pending"
        t["updated"] = now_s()
        ev(t, "stage" if on else "unstage")
    print(f"{'・' if on else '○'} #{a.id} 已{'转入暂存' if on else '从暂存放回待办'}")
    return 0


def cmd_fail(a) -> int:
    with tx() as q:
        t = find(q, a.id)
        if not t:
            print(f"没有 #{a.id}", file=sys.stderr)
            return 1
        t["error"] = a.error or ""
        t["updated"] = now_s()
        ev(t, "fail", text=a.error or "", note=(a.error or "")[:60], n=t.get("attempts", 0))
        t["status"] = "failed"
        state = f"✗ #{a.id} 执行失败，已保留现场；请核对后手动重试"
        left = len(pending_of(q))
    notify(t, "fail", a.error or "")
    print(state + f" · 剩 {left} 条待办")
    return 0


def cmd_drop(a) -> int:
    with tx() as q:
        t = find(q, a.id)
        if not t:
            print(f"没有 #{a.id}", file=sys.stderr)
            return 1
        t["status"] = "dropped"
        reason = getattr(a, "reason", "") or ""
        if reason:
            t["drop_reason"] = reason
        t["updated"] = now_s()
        ev(t, "drop", text=reason, note=reason[:60])
        left = len(pending_of(q))
    print(f"— #{a.id} 已丢弃，剩 {left} 条待办")
    return 0


def cmd_delete(a) -> int:
    """硬删除：整份 JSON 连同 fork 出来的整族一起清，不留孤儿。"""
    with tx() as q:
        kill = [a.id]
        grown = True
        while grown:
            grown = False
            for t in q["tasks"]:
                pid = int(t.get("parent") or 0)
                tid = int(t["id"])
                if pid in kill and tid not in kill:
                    kill.append(tid)
                    grown = True
        gone = [t for t in q["tasks"] if int(t["id"]) in kill]
        if not gone:
            print(f"没有 #{a.id}", file=sys.stderr)
            return 1
        if not getattr(a, "yes", False):
            titles = "、".join(f"#{t['id']}" for t in gone[:6])
            print(f"要删 {len(gone)} 条({titles})，整个 JSON 不留。加 --yes 确认", file=sys.stderr)
            return 2
        q["tasks"] = [t for t in q["tasks"] if int(t["id"]) not in kill]
    print(f"已删除 {' '.join(f'#{i}' for i in kill)}（共 {len(kill)} 条，含往来记录）")
    return 0


def cmd_edit(a) -> int:
    with tx() as q:
        t = find(q, a.id)
        if not t:
            print(f"没有 #{a.id}", file=sys.stderr)
            return 1
        before = dict(t)          # 改动前的快照，日志要逐字段比对
        if a.title:
            t["title"] = a.title.strip()
        if a.priority is not None:
            t["priority"] = a.priority
        if a.note is not None:
            t["note"] = a.note
        if getattr(a, "detail", None) is not None:
            t["detail"] = a.detail
            t["note"] = a.detail
        if getattr(a, "star", None) is not None:
            v = max(0.0, min(5.0, round(float(a.star) * 2) / 2))
            t["star"] = v
            t["priority"] = v
            # 改星级会改变它该不该被扫：半星退回暂存，一星以上回队列
            if t.get("status") in ("staged", "pending"):
                t["status"] = "pending" if v >= MIN_STAR else "staged"
        if getattr(a, "type", None) is not None:
            t["type"] = a.type
        if getattr(a, "track", None) is not None:
            t["track"] = bool(a.track)
        if getattr(a, "status", None):
            t["status"] = a.status
        ex = t.setdefault("exec", {"mode": "normal", "iters": 3, "model": ""})
        if getattr(a, "deep", None) is not None:
            ex["mode"] = "deep" if a.deep else "normal"
        if getattr(a, "iters", None):
            ex["iters"] = a.iters
        if getattr(a, "model", None) is not None:
            ex["model"] = a.model
        t["updated"] = now_s()
        # 日志要写清楚改了什么，光说「改过」等于没说
        chg = []
        if getattr(a, "title", None) and a.title != before.get("title"):
            chg.append("标题改成「%s」" % a.title[:24])
        if getattr(a, "detail", None) is not None and a.detail != before.get("detail"):
            chg.append("要求改成「%s」" % re.sub(r"\s+", " ", a.detail)[:36])
        if getattr(a, "star", None) is not None and float(a.star) != float(before.get("star") or 0):
            chg.append("星级调到 %g 星" % float(a.star))
        if getattr(a, "type", None) and a.type != before.get("type"):
            chg.append("类型改成 %s" % a.type)
        if getattr(a, "track", None) is not None and bool(a.track) != bool(before.get("track")):
            chg.append("跟踪" + ("打开" if a.track else "关掉"))
        if getattr(a, "status", None) and a.status != before.get("status"):
            chg.append("状态改成 %s" % a.status)
        say = ("改了 " + "、".join(chg)) if chg else "保存了，内容没变"
        ev(t, "edit", text=say, note=say[:80])
        out = fmt_task(t)
    print("已更新 " + out)
    return 0


def _at(a) -> datetime:
    v = getattr(a, "at", None)
    return datetime.strptime(v, "%Y-%m-%d %H:%M").replace(tzinfo=TZ) if v else datetime.now(TZ)


def cmd_status(a) -> int:
    now = _at(a)
    is_peak, why = peak_status(now)
    q = load()
    pend = len(pending_of(q))
    print(f"现在 {now:%Y-%m-%d %H:%M %A} · {why} · {'高峰，不处理' if is_peak else '空闲，可处理'}")
    print(f"待办 {pend} 条")
    if pend:
        nxt = next_idle_start(now)
        print(f"下次开工：{nxt:%m-%d %H:%M}")
    return 0


def _dotenv(key: str) -> str:
    """从 data/.env 取一个变量（该文件 600 hermes-agent，只有本进程读得到）。"""
    try:
        for line in (DATA / ".env").read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith(key + "="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    except Exception:
        pass
    return os.environ.get(key, "")


def refresh_balance(max_age: int = 300) -> None:
    """刷新 DeepSeek 账户余额到 balance.json，页面读这份缓存。

    挂在 tick 里（每 2 分钟一次），5 分钟内不重复请求；失败只打一行日志，
    保留上一次的数 —— 余额查不到不该影响任务调度。
    """
    try:
        if BALANCE.exists() and time.time() - BALANCE.stat().st_mtime < max_age:
            return
        key = _dotenv("CUSTOM_UMU5G7PYGOZES_API_KEY")
        if not key:
            print("[balance] 没找到 DeepSeek key，跳过")
            return
        req = urllib.request.Request(
            "https://api.deepseek.com/user/balance",
            headers={"Authorization": f"Bearer {key}"},
        )
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read().decode("utf-8"))
        info = (data.get("balance_infos") or [{}])[0]
        payload = {
            "ok": True,
            "available": bool(data.get("is_available")),
            "currency": info.get("currency", "CNY"),
            "total": float(info.get("total_balance") or 0),
            "topped_up": float(info.get("topped_up_balance") or 0),
            "granted": float(info.get("granted_balance") or 0),
            "at": datetime.now(TZ).isoformat(timespec="seconds"),
        }
        tmp = BALANCE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        os.chmod(tmp, 0o644)
        os.replace(tmp, BALANCE)
    except Exception as e:
        print(f"[balance] 刷新失败 {type(e).__name__}: {e}")


def cmd_tick(a) -> int:
    # Dispatch is a scheduler-owned transaction, never a standalone timeout guess.
    print("[tick] 回声站由原生定时调度器认领；独立 CLI 不派发任务")
    print(WAKE_NO)
    return 0


# DeepSeek 官方价（元 / 百万 token），2026-11 官网 deepseek-flash 档：
# 输入缓存命中 空闲 0.02 / 高峰 0.04；未命中 1 / 2；输出 4 / 8。
# 高峰 = 北京周一至周五 9:00-12:00、14:00-18:00（法定节假日表没接，节假日会按高峰算，差一半价）。
# 任务队列那个 cron job 的 id —— 只有它开的会话算这张卡的成本
TICK_JOB = "77734c71b29b"

PRICE_FLASH = {
    "peak": {"hit": 0.04, "miss": 2.0, "out": 8.0},
    "idle": {"hit": 0.02, "miss": 1.0, "out": 4.0},
}


def is_peak(dt: datetime) -> bool:
    if dt.weekday() >= 5:
        return False
    h = dt.hour + dt.minute / 60
    return (9 <= h < 12) or (14 <= h < 18)


def usage_of(sess_id: str, at=None) -> dict:
    """读后台那次会话的真实 token，按官方价折成人民币。

    Hermes 走的是 custom provider，session 里 estimated_cost_usd 全是 0（没有价目表），
    所以这里自己算。拿不到会话就返回 {} —— 前端显示「未测」，绝不估一个数糊上去。
    """
    if not sess_id:
        return {}
    db = str(DATA / "state.db")
    if not os.path.exists(db):
        return {}
    try:
        c = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=5)
        try:
            row = c.execute(
                "select input_tokens, output_tokens, cache_read_tokens, api_call_count, started_at "
                " , model, estimated_cost_usd from sessions where id = ? limit 1", (sess_id,)).fetchone()
        finally:
            c.close()
    except Exception:
        return {}
    if not row:
        return {}
    miss, out, hit, calls, st, model, recorded_cost = row
    miss, out, hit = int(miss or 0), int(out or 0), int(hit or 0)
    if not (miss or out or hit):
        return {}
    when = at or (datetime.fromtimestamp(st, TZ) if st else now_s())
    if isinstance(when, str):
        try:
            when = datetime.fromisoformat(when)
        except Exception:
            when = datetime.now(TZ)
    return {"sess": sess_id, "hit": hit, "miss": miss, "out": out,
            "calls": int(calls or 0), "model": model, "recorded_cost_usd": recorded_cost,
            "at": when.isoformat(timespec="seconds")}


def session_of(t: dict) -> str:
    # Legacy guesses are preserved as historical data, never reused for a new run.
    return str((t.get('panel_run') or {}).get('session_id') or '')


def cmd_sediment(a) -> int:
    """归档之后的沉淀队列。

    页面点「归档」只把卡标成完成、在卡上压一个 sediment=pending。
    真正读后台那次会话、写笔记，交给这个命令驱动 agent 去做 —— PHP 侧
    没有 agent，不能一边点按钮一边写笔记。
    """
    if a.finish:
        with tx() as q:
            t = find(q, a.finish)
            if not t:
                print(f"没有 #{a.finish}", file=sys.stderr)
                return 1
            sd = dict(t.get("sediment") or {})
            sd.update({"status": "done", "done_at": now_s(), "file": a.file or ""})
            sd.setdefault("at", now_s())
            t["sediment"] = sd
            # 沉淀这步跑的时候会话早结束了，token 是最全的 —— 在这里重算一次成本
            _u = usage_of(session_of(t))
            if _u:
                t["usage"] = _u
            t["updated"] = now_s()
            ev(t, "sediment", text=("沉到 " + a.file) if a.file else "沉淀完成",
               note=(a.file or "")[:80])
        print(f"✓ #{a.finish} 沉淀完成{(chr(32) + a.file) if a.file else ''}")
        return 0

    with tx() as q:
        rows = []
        for t in q.get("tasks", []):
            if (t.get("sediment") or {}).get("status") != "pending":
                continue
            rows.append((t, session_of(t)))
    if not rows:
        print(WAKE_NO)
        return 0

    print(f"有 {len(rows)} 张卡归档后还没沉淀，先做这件事，再管别的：\n")
    for t, sid in rows:
        sd = t.get("sediment") or {}
        print(f"#{t['id']} {t.get('title', '')}")
        print(f"   后台会话：{sid or '（没找到，按标题和交付内容自己认）'}")
        print(f"   交付内容：{(t.get('deliver') or t.get('result') or '')[:160]}")
        print(f"   归档时间：{sd.get('at', '')}\n")
    print("一张卡一篇，不要合并。每篇写：要它干什么、后台怎么干的（读了哪些文件/跑了什么命令）、"
          "结论与数字、产出文件路径。")
    print("落到 /vol1/@apphome/hermes-agent/data/knowledge/对话沉淀/YYYY-MM-DD-任务N-标题.md")
    print("写完一张就跑：python3 /vol1/@appcenter/hermes-agent/server/echo/taskq.py sediment <ID> --file <笔记路径>")
    print("")
    print(WAKE_YES)
    return 0


SCHEMA_DOC = {
    "_说明": "一个任务 = 一份 JSON。agent 照字段填，前端照字段摆，谁也不去散文里猜。",
    "title": "str 必填 · 一句话，卡片标题",
    "detail": "str 必填 · 用户的具体要求，原话优先，≤4000 字",
    "type": "str · 分类，可空",
    "star": "float 0.5~5 · 0.5 = 暂存不扫描；≥1 才进在途中",
    "tags": "list[str] · 标签",
    "status": "pending|doing|review|done|dropped|staged · 由流程改，不手填",
    "todos": "[{c: 待办内容, s: pending|completed}] · 由 todo 工具搬过来",
    "result": "str · 一句话结论（交付时填，≤40 字）",
    "report": {
        "numbers": "[{k: 指标名, v: 值}] · 能量化的都进这，别埋进句子",
        "files": "list[str] · 产物绝对路径",
        "detail": "str · 口径/坑/为什么，≤200 字",
    },
    "entries": "[{kind: deliver|reply|pending|silent|sediment, text, at, q?, a?}] · 往来记录",
    "pending": "{q: 问题, a: 建议} · 两个格子分开填，别写成一句话",
    "created|picked_at|claimed_at|delivered_at|archived_at": "ISO 时间，流程自动落",
    "rounds": "int · 网关真实模型调用次数，自动取，不估",
    "sediment": "{at, status: pending|done, done_at, file} · 沉淀结果",
}


def cmd_schema(a) -> int:
    """把存储结构原样打印出来 —— 让 agent 看着格子填，而不是写作文。"""
    print(json.dumps(SCHEMA_DOC, ensure_ascii=False, indent=2))
    return 0


def cmd_stats(a) -> int:
    q = load()
    c: dict[str, int] = {}
    for t in q["tasks"]:
        c[t["status"]] = c.get(t["status"], 0) + 1
    parts = " · ".join(f"{k} {v}" for k, v in sorted(c.items())) or "空"
    is_peak, why = peak_status()
    print(f"{parts} | {why} | last_run {q.get('last_run') or '无'}")
    return 0


# ---------------------------------------------------------------- 入口

def main() -> int:
    p = argparse.ArgumentParser(prog="taskq", description="任务队列")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("add", help="入队")
    s.add_argument("text")
    s.add_argument("--note", default="")
    s.add_argument("--detail", default=None)
    s.add_argument("--type", default="")
    s.add_argument("--star", type=float, default=0,
                   help="0~5，半星一档；一星以下＝暂存不进队列")
    s.add_argument("--priority", type=int, default=0)
    s.add_argument("--tag", action="append")
    s.add_argument("--source", default="chat")
    s.add_argument("--stage", action="store_true", help="只暂存，不排队")
    s.add_argument("--track", action="store_true", help="状态变化推 Bark")
    s.add_argument("--deep", action="store_true", help="深入执行（多轮自检）")
    s.add_argument("--iters", type=int, default=0, help="深入模式迭代轮数")
    s.add_argument("--model", default="", help="指定执行模型")
    s.set_defaults(func=cmd_add)

    s = sub.add_parser("list", help="列表")
    s.add_argument("--all", action="store_true")
    s.add_argument("--status", default=None, choices=STATUSES)
    s.add_argument("--long", action="store_true")
    s.set_defaults(func=cmd_list)

    s = sub.add_parser("show", help="看一条")
    s.add_argument("id", type=int)
    s.set_defaults(func=cmd_show)

    s = sub.add_parser("notify-claim", help=argparse.SUPPRESS)
    s.add_argument("id", type=int)
    s.set_defaults(func=cmd_notify_claim)

    s = sub.add_parser("claim", help="认领（标记 doing + 拆小点）")
    s.add_argument("id", type=int)
    s.set_defaults(func=cmd_claim)

    s = sub.add_parser("done", help="完成 / 带回信")
    s.add_argument("id", type=int)
    s.add_argument("--result", default="")
    s.add_argument("--deliver", default="", help="交付了什么")
    s.add_argument("--decide", default="", help="需要人拍板的事，填了就转 review（老写法，内部会拆问题/建议）")
    s.add_argument("--json", default="", help='结构化填表：{"result":"…","deliver":"…","pending":{"q":"问题","a":"建议"}}')
    s.add_argument("--no-todo", dest="no_todo", action="store_true", help="确实不需要拆解时显式跳过 todo 工具校验")
    s.add_argument("--review", action="store_true", help="强制转 review")
    s.add_argument("--rounds", type=int, default=0, help="处理轮；不填直接读网关记录（state.db 该会话的模型调用次数），不估")
    s.set_defaults(func=cmd_done)

    s = sub.add_parser("review", help="转入需决策")
    s.add_argument("id", type=int)
    s.add_argument("--decide", default="")
    s.add_argument("--result", default="")
    s.add_argument("--rounds", type=int, default=0, help="处理轮；不填直接读网关记录")
    s.set_defaults(func=cmd_review)

    s = sub.add_parser("archive", help="沉寂 / 归档（全部做完收起来）")
    s.add_argument("id", type=int)
    s.add_argument("--note", default="", help="归档说明，留空用默认")
    s.set_defaults(func=cmd_archive)

    s = sub.add_parser("append", help="在原有卡上追加新要求，回到待回信")
    s.add_argument("id", type=int)
    s.add_argument("--detail", required=True, help="新加的要求")
    s.set_defaults(func=cmd_append)

    s = sub.add_parser("answer", help="对需决策点头，重新入队")
    s.add_argument("id", type=int)
    s.add_argument("--note", default="", help="批示内容，会追加进任务要求")
    s.set_defaults(func=cmd_answer)

    s = sub.add_parser("spawn", help="追加一条子任务（我认为没完成）")
    s.add_argument("id", type=int)
    s.add_argument("--want", required=True, help="没完成的是什么")
    s.set_defaults(func=cmd_spawn)

    s = sub.add_parser("todo", help="记拆解清单")
    s.add_argument("id", type=int)
    s.add_argument("--add", default="", help="加一条")
    s.add_argument("--set", type=int, default=0, help="改第几条（从 1 数）")
    s.add_argument("--done", type=int, action="append", default=[], help="把第几条标完成，可多次")
    s.add_argument("--status", default="done", choices=("todo", "doing", "done"))
    s.add_argument("--replace", action="append", help="整批替换，可多次")
    s.add_argument("--clear", action="store_true")
    s.set_defaults(func=cmd_todo)

    s = sub.add_parser("stage", help="暂存 / 放回")
    s.add_argument("id", type=int)
    s.add_argument("--on", action="store_true", help="转入暂存")
    s.add_argument("--off", action="store_true", help="从暂存放回待办")
    s.set_defaults(func=cmd_stage)

    s = sub.add_parser("fail", help="失败")
    s.add_argument("id", type=int)
    s.add_argument("--error", default="")
    s.add_argument("--max-attempts", type=int, default=3)
    s.set_defaults(func=cmd_fail)

    s = sub.add_parser("drop", help="丢弃")
    s.add_argument("id", type=int)
    s.add_argument("--reason", default="", help="放弃原因，会显示在往来记录里")
    s.set_defaults(func=cmd_drop)

    s = sub.add_parser("delete", help="硬删除（连子任务整族清掉，需 --yes）")
    s.add_argument("id", type=int)
    s.add_argument("--yes", action="store_true")
    s.set_defaults(func=cmd_delete)

    s = sub.add_parser("edit", help="改标题/优先级/备注")
    s.add_argument("id", type=int)
    s.add_argument("--title", default=None)
    s.add_argument("--priority", type=int, default=None)
    s.add_argument("--note", default=None)
    s.add_argument("--star", type=float, default=None)
    s.add_argument("--type", default=None)
    s.add_argument("--detail", default=None)

    s.add_argument("--track", type=boolish, default=None, help="1/true 开，0/false 关")
    s.add_argument("--status", default=None, choices=STATUSES)
    s.add_argument("--deep", type=boolish, default=None, help="1/true 开，0/false 关")
    s.add_argument("--iters", type=int, default=None)
    s.add_argument("--model", default=None)
    s.set_defaults(func=cmd_edit)

    s = sub.add_parser("status", help="当前峰谷 + 待办数")
    s.add_argument("--at", default=None, help="模拟时间 YYYY-MM-DD HH:MM")
    s.set_defaults(func=cmd_status)

    s = sub.add_parser("tick", help="cron 判定（带 wake gate）")
    s.add_argument("--cooldown", type=int, default=40)
    s.add_argument("--ignore-cooldown", action="store_true")
    s.add_argument("--at", default=None, help="模拟时间 YYYY-MM-DD HH:MM")
    s.add_argument("--force", action="store_true", help="跳过峰谷/冷却判定（仅自测用）")
    s.set_defaults(func=cmd_tick)

    s = sub.add_parser("sediment", help="归档后的沉淀队列（cron 扫出，agent 写笔记）")
    s.add_argument("finish", nargs="?", type=int, default=0, help="标记这张卡沉淀完成")
    s.add_argument("--file", default="", help="笔记落盘路径")
    s.set_defaults(func=cmd_sediment)

    s = sub.add_parser("schema", help="打印任务的 JSON 字段表（填空模板）")
    s.set_defaults(func=cmd_schema)

    s = sub.add_parser("stats", help="一行统计")
    s.set_defaults(func=cmd_stats)

    a = p.parse_args()
    return a.func(a)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
