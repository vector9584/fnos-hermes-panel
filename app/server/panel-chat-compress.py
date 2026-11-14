#!/usr/bin/env python3
"""panel-chat-compress.py — 面板会话「真压缩」

面板的上下文真身是 ${VAR_DIR}/chat/sessions/<id>.json 里的 messages 数组
（monitor.js 的 buildChatHistory 就是拿它拼成 OpenAI messages 发出去的）。
所以真压缩 = 把早段消息换成语义摘要，保留最近 N 条，写回同一个会话文件。

与内核 context_compressor 的区别（在面板里必须这样）：
- 内核会旋转出新 session（child session），面板的 session_id 是 UI 主键，旋转等于换房间，
  用户会当场「丢会话」；这里原地压缩，id 不变。
- 内核摘要失败会暂停 60s（agent/context_compressor.py 的 pause），这正是「发消息等一分钟」的根因之一。
  这里摘要失败只换下一个候选模型，全失败就原样不动，绝不写半成品。

用法（供 monitor.js 调用，也可命令行手动跑）：
  python3 panel-chat-compress.py --session <id> --preview
  python3 panel-chat-compress.py --session <id> --keep-last 12 --focus "只看部署相关"
输出：stdout 一行 JSON；日志走 stderr。
"""

import argparse
import json
import os
import re
import shutil
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

# ── 与 monitor.js estimateTokens 完全同口径，保证压缩前后百分比可比 ──────────
_CJK_RANGES = (
    (0x4E00, 0x9FFF), (0x3400, 0x4DBF), (0x3040, 0x309F), (0x30A0, 0x30FF),
    (0xAC00, 0xD7AF), (0xFF00, 0xFFEF), (0x20000, 0x2EBEF),
)


def estimate_tokens(text) -> int:
    if text is None:
        return 0
    s = text if isinstance(text, str) else json.dumps(text, ensure_ascii=False)
    total = 0.0
    for ch in s:
        code = ord(ch)
        if any(lo <= code <= hi for lo, hi in _CJK_RANGES):
            total += 1
        else:
            total += 0.25
    return int(total + 0.999)


def msg_text(msg) -> str:
    """把 content 归一成纯文本（兼容多模态数组与旧版 {text,images,files}）"""
    if msg is None:
        return ""
    c = msg.get("content") if isinstance(msg, dict) else msg
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        out = []
        for part in c:
            if isinstance(part, dict):
                if part.get("type") == "text":
                    out.append(str(part.get("text") or ""))
                elif isinstance(part.get("text"), str):
                    out.append(part["text"])
            elif isinstance(part, str):
                out.append(part)
        return "\n".join(out)
    if isinstance(c, dict):
        return str(c.get("text") or "")
    return str(c or "")


def messages_tokens(msgs) -> int:
    return sum(estimate_tokens(msg_text(m)) for m in msgs)


# ── 配置 / 凭据 ────────────────────────────────────────────────────────
def load_env_files(paths):
    """把 .env 里的值补进 os.environ（不覆盖已有值），供 ${VAR} 展开"""
    for p in paths:
        try:
            with open(p, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    k, v = line.split("=", 1)
                    k = k.strip()
                    v = v.strip().strip('"').strip("'")
                    if k and k not in os.environ:
                        os.environ[k] = v
        except OSError:
            continue


_ENV_REF = re.compile(r"^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$")


def expand_secret(value):
    if not isinstance(value, str):
        return value
    m = _ENV_REF.match(value.strip())
    if m:
        return os.environ.get(m.group(1), "")
    # 支持 "prefix${VAR}suffix" 形式
    return re.sub(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}", lambda mm: os.environ.get(mm.group(1), ""), value)


def load_yaml(path):
    try:
        import yaml  # venv 里有
    except ImportError:
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return yaml.safe_load(f) or {}
    except OSError:
        return None


def build_candidates(cfg, override_provider=None, override_model=None):
    """按「显式指定 → aux.compression → 便宜的 fallback → 主模型」排候选。
    摘要这种活不该烧主模型的钱，先试免费/闪速的。"""
    cands = []
    providers = (cfg or {}).get("providers") or {}
    model_cfg = (cfg or {}).get("model") or {}

    def from_provider(pid, model):
        if not pid or not model:
            return None
        pid = str(pid).split(":")[-1]
        p = providers.get(pid)
        if not isinstance(p, dict):
            return None
        base = expand_secret(p.get("base_url") or "").rstrip("/")
        key = expand_secret(p.get("api_key") or "")
        if not base or not key:
            return None
        return {
            "provider": pid,
            "name": p.get("name") or pid,
            "base_url": base,
            "api_key": key,
            "model": model,
        }

    if override_provider or override_model:
        c = from_provider(override_provider or model_cfg.get("provider"),
                          override_model or model_cfg.get("default"))
        if c:
            cands.append(c)

    aux = ((cfg or {}).get("auxiliary") or {}).get("compression") or {}
    if aux.get("provider") and aux.get("provider") != "auto" and aux.get("model"):
        base = expand_secret(aux.get("base_url") or "")
        key = expand_secret(aux.get("api_key") or "")
        if base and key:
            cands.append({"provider": aux["provider"], "name": "aux.compression",
                          "base_url": base.rstrip("/"), "api_key": key, "model": aux["model"]})
        else:
            c = from_provider(aux["provider"], aux["model"])
            if c:
                cands.append(c)

    for fb in (cfg or {}).get("fallback_providers") or []:
        if not isinstance(fb, dict):
            continue
        name = str(fb.get("model") or "")
        # 只把「免费/闪速」的当摘要候选，付费大模型排后面
        if not any(k in name.lower() for k in ("free", "flash", "lite", "mini", "air")):
            continue
        c = from_provider(fb.get("provider"), name)
        if c:
            cands.append(c)

    c = from_provider(model_cfg.get("provider"), model_cfg.get("default"))
    if c:
        cands.append(c)

    # 去重（同 base_url + model 只留第一份）
    seen, out = set(), []
    for c in cands:
        k = (c["base_url"], c["model"])
        if k in seen:
            continue
        seen.add(k)
        out.append(c)
    return out


# ── 切分 ───────────────────────────────────────────────────────────────
def plan_split(messages, keep_last=0):
    """返回 (head, tail, note)。默认保留约 15% 但不少于 6 条；
    保证 tail 从一条 user 消息起头（避免半个回合被劈开），head 至少 2 条才有压缩意义。"""
    n = len(messages)
    if n < 4:
        return messages, [], "消息太少（<4 条），不需要压缩"

    if keep_last and keep_last > 0:
        keep = min(keep_last, n - 2)
    else:
        keep = max(6, int(round(n * 0.15)))
        keep = min(keep, max(6, n - 2))
    keep = max(2, min(keep, n - 2))

    cut = n - keep
    # 让 tail 从 user 消息起头：向前找最近的一条 user（最多回退 6 条）
    probe = cut
    limit = max(1, cut - 6)
    while probe > limit and (messages[probe].get("role") != "user"):
        probe -= 1
    if messages[probe].get("role") == "user" and probe >= 2:
        cut = probe

    head, tail = messages[:cut], messages[cut:]
    return head, tail, ""


# ── LLM 摘要 ───────────────────────────────────────────────────────────
SUMMARY_SYSTEM = (
    "你是资深工程助理，正在为一个长时间会话做「上下文交接」。"
    "把给你的历史对话压成一份可直接续做的中文交接说明。\n"
    "必须保留：已确认的结论与决策、文件/目录/接口路径、关键命令与参数、"
    "未完成事项与下一步、用户的偏好与硬约束、踩过的坑与结论。\n"
    "必须丢弃：寒暄、重复内容、逐条工具调用的过程流水、已被推翻的中间方案。\n"
    "格式：Markdown，按主题分 2~5 个小节，总长不超过 1800 字。不要写「以上」「综上」。"
)

CHUNK_SYSTEM = (
    "把下面这段历史对话压成要点式中文摘要，保留结论、路径、命令、未完成项，"
    "丢弃过程流水。Markdown 要点列表，不超过 900 字。"
)


_NOISE_RE = re.compile(r"^\s*(?:（执行已中断）|（重新生成）|好的[。！]?|收到[。！]?|嗯[。！]?|ok[。!]?)\s*$", re.I)


def render_items(msgs, per_msg_cap=2600):
    """渲染喂给摘要模型的历史，返回 [(who, text)]。
    per_msg_cap 收紧到 2600：面板历史里大量 3000+ 字的长回复和工具输出，
    全塞进去只会让摘要慢三倍、还不更准。寒暄/空壳消息直接跳过。"""
    items = []
    for m in msgs:
        role = m.get("role", "?")
        who = {"user": "用户", "assistant": "助手", "system": "系统"}.get(role, role)
        text = msg_text(m).strip()
        if not text or _NOISE_RE.match(text):
            continue
        if len(text) > per_msg_cap:
            head = text[: int(per_msg_cap * 0.68)]
            tail = text[-int(per_msg_cap * 0.32):]
            text = f"{head}\n……（中略 {len(text) - per_msg_cap} 字）……\n{tail}"
        items.append((who, text))
    return items


def render_block(items):
    return "\n\n".join(f"### {who}\n{text}" for who, text in items)


def _render_history(msgs, per_msg_cap=2600):
    return render_block(render_items(msgs, per_msg_cap))


def call_llm(cand, system, user_content, timeout=150):
    payload = {
        "model": cand["model"],
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user_content},
        ],
        "stream": False,
        "temperature": 0.3,
    }
    req = urllib.request.Request(
        cand["base_url"] + "/chat/completions",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + cand["api_key"],
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = json.loads(resp.read().decode("utf-8", "replace"))
    choices = body.get("choices") or []
    if not choices:
        raise RuntimeError("返回没有 choices")
    content = (choices[0].get("message") or {}).get("content")
    if isinstance(content, list):
        content = "".join(str(p.get("text") or "") for p in content if isinstance(p, dict))
    content = (content or "").strip()
    if not content:
        raise RuntimeError("模型返回空内容")
    return content, body.get("usage") or {}


def summarize(head, focus, candidates, chunk_budget=30000, log=None):
    """头段可能很长：先按 token 预算分块摘要，再合并。返回 (summary, used_cand, usage, errors)
    同一轮里失败过的候选不再重试（限流/超时的模型，重试只会把等待时间翻倍）。
    分段用并发跑：68k token 的头段串行要 2 分钟，用户等不起。"""
    errors = []
    dead = set()
    lock = threading.Lock()

    # 按「渲染后的字符量」切块（不是原始 token）：原始 68k token 收紧到每条 2600 字后
    # 实际发送量约 1/3，块数按真实体量算才不会切成十几个小块。
    items = render_items(head)
    if not items:
        return None, None, {}, "头段没有可摘要的内容", errors
    total_chars = sum(len(t) + 12 for _, t in items)
    per_block = max(20000, -(-total_chars // 4))  # 最多 4 块
    chunks, cur, cur_chars = [], [], 0
    for it in items:
        n = len(it[1]) + 12
        if cur and cur_chars + n > per_block:
            chunks.append(cur)
            cur, cur_chars = [], 0
        cur.append(it)
        cur_chars += n
    if cur:
        chunks.append(cur)

    def attempt(cand, system, content):
        try:
            out, usage = call_llm(cand, system, content)
            return out, usage, None
        except Exception as e:  # noqa: BLE001 - 逐个候选降级
            msg = f"{cand.get('name')}/{cand.get('model')}: {type(e).__name__}: {e}"
            with lock:
                errors.append(msg)
                dead.add((cand["base_url"], cand["model"]))
            if log:
                log(msg)
            return None, {}, msg

    def try_chain(system, content, prefer=None):
        order = ([prefer] if prefer else []) + [c for c in candidates if c is not prefer]
        for cand in order:
            if (cand["base_url"], cand["model"]) in dead:
                continue
            out, usage, _err = attempt(cand, system, content)
            if out:
                return out, cand, usage, None
        return None, None, {}, "所有候选模型都失败"

    if len(chunks) == 1:
        body = render_block(chunks[0])
        if focus:
            body = f"聚焦要求：{focus}\n\n" + body
        summary, cand, usage, err = try_chain(SUMMARY_SYSTEM, body)
        if err:
            return None, None, usage, err, errors
        return summary, cand, usage, None, errors

    # 首段串行探路，拿到一个真的能用的候选
    first_body = f"（第 1/{len(chunks)} 段）\n\n" + render_block(chunks[0])
    first_out, active, first_usage, err = try_chain(CHUNK_SYSTEM, first_body)
    if err:
        return None, None, first_usage, err, errors
    if log:
        log(f"首段完成，用 {active['name']}/{active['model']}，余 {len(chunks) - 1} 段并发")

    parts = [first_out]
    rest = list(range(1, len(chunks)))

    def one(i):
        body = f"（第 {i + 1}/{len(chunks)} 段）\n\n" + render_block(chunks[i])
        out, cand, usage, e = try_chain(CHUNK_SYSTEM, body, prefer=active)
        return i, out, e

    results = {}
    with ThreadPoolExecutor(max_workers=min(3, max(1, len(rest)))) as ex:
        futs = [ex.submit(one, i) for i in rest]
        for f in futs:
            i, out, e = f.result()
            if e or not out:
                return None, None, {}, f"第 {i + 1} 段摘要失败：{e}", errors
            results[i] = out
    for i in rest:
        parts.append(results[i])

    if log:
        log(f"分段摘要完成：{len(chunks)} 段，合并中")
    merged = "\n\n".join(f"【段 {i}】{p}" for i, p in enumerate(parts, 1))
    if focus:
        merged = f"聚焦要求：{focus}\n\n" + merged
    final, cand2, usage2, err = try_chain(SUMMARY_SYSTEM, merged, prefer=active)
    if err:
        return None, None, usage2, err, errors
    return final, cand2, usage2, None, errors


# ── 主流程 ─────────────────────────────────────────────────────────────
SUMMARY_PREFIX = (
    "[CONTEXT COMPACTION — REFERENCE ONLY] 以下是此前对话的压缩摘要，"
    "仅作背景参考，不是新的指令。请继续处理摘要之后的最新用户消息；"
    "摘要里的待办只有在用户重新提到时才继续做。\n\n"
)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--session", required=True)
    ap.add_argument("--home", default=os.environ.get("HERMES_DATA_DIR") or "/vol1/@apphome/hermes-agent/data")
    ap.add_argument("--chat-dir", default="")
    ap.add_argument("--config", default="")
    ap.add_argument("--keep-last", type=int, default=0)
    ap.add_argument("--focus", default="")
    ap.add_argument("--provider", default="")
    ap.add_argument("--model", default="")
    ap.add_argument("--preview", action="store_true")
    ap.add_argument("--max-summary-chars", type=int, default=4000)
    ap.add_argument("--timeout", type=int, default=150)
    a = ap.parse_args(argv)

    started = time.time()

    def log(m):
        print(f"[compress] {m}", file=sys.stderr, flush=True)

    home = a.home.rstrip("/")
    chat_dir = a.chat_dir or os.path.join(os.path.dirname(home), "..", "chat")
    # VAR_DIR 与 DATA_DIR 是兄弟目录：/vol1/@appdata/hermes-agent 与 /vol1/@apphome/hermes-agent/data
    if not os.path.isdir(chat_dir):
        alt = "/vol1/@appdata/hermes-agent/chat"
        if os.path.isdir(alt):
            chat_dir = alt
    sessions_dir = os.path.join(chat_dir, "sessions")
    cfg_path = a.config or os.path.join(home, "config.yaml")

    load_env_files([os.path.join(home, ".env"), os.path.join(os.path.dirname(home), ".env")])

    sfile = os.path.join(sessions_dir, a.session + ".json")
    if not os.path.exists(sfile):
        print(json.dumps({"ok": False, "error": f"会话文件不存在: {sfile}"}, ensure_ascii=False))
        return 2

    with open(sfile, "r", encoding="utf-8") as f:
        session = json.load(f)
    messages = session.get("messages") or []
    # 丢掉空壳消息（历史上被打断留下的空 assistant）
    messages = [m for m in messages if msg_text(m).strip()]
    before_tokens = messages_tokens(messages)

    head, tail, note = plan_split(messages, a.keep_last)
    if note:
        print(json.dumps({"ok": False, "error": note, "before_tokens": before_tokens,
                          "messages": len(messages)}, ensure_ascii=False))
        return 3

    head_tokens, tail_tokens = messages_tokens(head), messages_tokens(tail)
    est_summary_tokens = min(1800, max(400, head_tokens // 12))
    est_after = tail_tokens + est_summary_tokens

    base_report = {
        "ok": True,
        "preview": bool(a.preview),
        "before_tokens": before_tokens,
        "head_tokens": head_tokens,
        "tail_tokens": tail_tokens,
        "estimate_after_tokens": est_after,
        "estimate_saved": max(0, before_tokens - est_after),
        "messages_before": len(messages),
        "removed": len(head),
        "kept": len(tail),
        "keep_last": a.keep_last or "auto",
        "focus": a.focus,
    }

    if a.preview:
        base_report["duration_ms"] = int((time.time() - started) * 1000)
        print(json.dumps(base_report, ensure_ascii=False))
        return 0

    cfg = load_yaml(cfg_path)
    candidates = build_candidates(cfg, a.provider or None, a.model or None)
    if not candidates:
        print(json.dumps({**base_report, "ok": False,
                          "error": "没有可用的摘要模型候选（检查 config.yaml 的 providers 与 .env 密钥）"},
                         ensure_ascii=False))
        return 4
    log("候选模型：" + ", ".join(f"{c['name']}/{c['model']}" for c in candidates))

    summary, used, usage, err, errors = summarize(head, a.focus, candidates, log=log)
    if err or not summary:
        print(json.dumps({**base_report, "ok": False,
                          "error": f"摘要失败，原会话未改动：{err or '空摘要'}",
                          "attempts": errors}, ensure_ascii=False))
        return 5

    if len(summary) > a.max_summary_chars:
        summary = summary[: a.max_summary_chars].rstrip() + "……（摘要超长已截断）"

    now_ms = int(time.time() * 1000)
    # 与内核压缩同款的可见标记（agent/conversation_loop.py 里那句）。
    # 前端 chat/tabs.js 的 SYS_MARKER_PATTERNS 靠这一行渲染出「📦 上下文已压缩 ×N」
    # chip，并把它从正文里摘掉。没有它，压缩完就只剩一个弹框，刷新即失忆 —— 2026-11-13 报的。
    marker = (
        f"\n\n> 📦 **本会话已自动压缩**（更早对话已归档为摘要 · "
        f"{len(head)} → {len(tail)} 条，可继续对话）\n\n"
    )
    summary_msg = {
        "role": "user",
        "content": SUMMARY_PREFIX + summary + marker,
        "ts": now_ms,
        "sender": "system",
        "_compressed_summary": {
            "at": now_ms,
            "removed": len(head),
            "kept": len(tail),
            "focus": a.focus,
            "model": f"{used['name']}/{used['model']}" if used else "",
        },
    }
    new_messages = [summary_msg] + tail
    after_tokens = messages_tokens(new_messages)

    if after_tokens >= before_tokens:
        print(json.dumps({**base_report, "ok": False,
                          "error": f"压缩无收益（{before_tokens} → {after_tokens} token），已放弃写回"},
                         ensure_ascii=False))
        return 6

    backup = f"{sfile}.bak-compress-{now_ms}"
    shutil.copy2(sfile, backup)

    session["messages"] = new_messages
    session["updated_at"] = now_ms
    session["compression"] = {
        "at": now_ms,
        "removed": len(head),
        "kept": len(tail),
        "before_tokens": before_tokens,
        "after_tokens": after_tokens,
        "focus": a.focus,
        "model": f"{used['name']}/{used['model']}" if used else "",
        "backup": os.path.basename(backup),
    }
    tmp = sfile + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(session, f, ensure_ascii=False)
    os.replace(tmp, sfile)

    print(json.dumps({
        **base_report,
        "ok": True,
        "preview": False,
        "after_tokens": after_tokens,
        "saved": before_tokens - after_tokens,
        "messages_after": len(new_messages),
        "summary": summary,
        "summary_tokens": estimate_tokens(summary),
        "model_used": f"{used['name']}/{used['model']}" if used else "",
        "usage": usage,
        "backup": backup,
        "attempts": errors,
        "duration_ms": int((time.time() - started) * 1000),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
