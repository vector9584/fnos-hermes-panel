#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""端到端：真页面点开会话，量 #chatBody 里的真实 DOM（不是内存里拼一份）。
用法: probe_e2e.py "打招呼"
"""
import json, os, sys, glob
HOME = "/vol1/@apphome/hermes-agent/data"
os.environ.setdefault("HOME", HOME)
if not os.environ.get("PLAYWRIGHT_BROWSERS_PATH"):
    for c in glob.glob(f"{HOME}/.cache/ms-playwright") + glob.glob("/root/.cache/ms-playwright"):
        os.environ["PLAYWRIGHT_BROWSERS_PATH"] = c
        break
from playwright.sync_api import sync_playwright

TITLE = sys.argv[1] if len(sys.argv) > 1 else "打招呼"

MEASURE = """() => {
  const body = document.getElementById('chatBody');
  if (!body) return {err: 'no chatBody'};
  const out = {};
  const all = [...body.querySelectorAll('.msg')];
  out.msgs = all.length;
  const asst = all.filter(e => e.classList.contains('assistant'));
  const user = all.filter(e => e.classList.contains('user'));
  out.asst = asst.length; out.user = user.length;
  out.nestedBubble = body.querySelectorAll('.msg-bubble .msg-bubble').length;
  out.metaInsideAsst = asst.filter(e => e.querySelector('.msg-bubble > .msg-meta')).length;
  out.metaOutsideAsst = asst.filter(e => e.querySelector(':scope > .msg-meta')).length;
  out.actInsideAsst = asst.filter(e => e.querySelector('.msg-bubble > .msg-actions')).length;
  out.actOutsideAsst = asst.filter(e => e.querySelector(':scope > .msg-actions')).length;
  out.metaOutsideUser = user.filter(e => e.querySelector(':scope > .msg-meta')).length;
  const rid = {};
  asst.forEach(e => { const k = e.dataset.requestId || '(none)'; rid[k] = (rid[k]||0)+1; });
  out.dupRid = Object.entries(rid).filter(([k,v]) => v > 1);
  out.ridMissing = asst.filter(e => !e.dataset.requestId).length;
  out.dupTextInBubble = asst.filter(e => e.querySelectorAll('.msg-bubble > .md-text').length > 1).length;
  const norm = s => { try { return decodeURIComponent(s).replace(/^https?:\\/\\/[^/]+/i, ''); } catch(e){ return s; } };
  out.dupImgInBubble = [...body.querySelectorAll('.msg-bubble')].filter(b => {
    const s = [...b.querySelectorAll('img')].map(i => norm(i.getAttribute('src') || ''));
    return s.length !== new Set(s).size;
  }).length;
  out.geomBad = [...asst].filter(e => {
    const b = e.querySelector('.msg-bubble'), m = e.querySelector(':scope > .msg-meta');
    if (!b || !m) return true;
    return m.getBoundingClientRect().top < b.getBoundingClientRect().bottom - 2;
  }).length;
  return out;
}"""

with sync_playwright() as p:
    b = p.chromium.launch(args=["--no-sandbox"])
    pg = b.new_page(viewport={"width": 1440, "height": 1000})
    pg.goto("http://127.0.0.1:8650/", wait_until="load")
    pg.wait_for_function("typeof msgHTML === 'function'", timeout=30000)
    # 侧栏会话项按标题点开
    cand = pg.get_by_text(TITLE, exact=True)
    n = cand.count()
    clicked = False
    for i in range(n):
        try:
            cand.nth(i).click(timeout=3000)
            clicked = True
            break
        except Exception:
            continue
    pg.wait_for_timeout(2500)
    res = pg.evaluate(MEASURE)
    res['title'] = TITLE
    res['clicked'] = clicked
    res['candidates'] = n
    print(json.dumps(res, ensure_ascii=False, indent=2))
    b.close()
