#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""对真会话数据跑 msgHTML + dedupeGhostMsgs，量气泡结构与 footer 位置。
用法: python3 probe_bubble.py [session_id]
"""
import json, os, sys, glob
HOME = "/vol1/@apphome/hermes-agent/data"
os.environ.setdefault("HOME", HOME)
if not os.environ.get("PLAYWRIGHT_BROWSERS_PATH"):
    for c in glob.glob(f"{HOME}/.cache/ms-playwright") + glob.glob("/root/.cache/ms-playwright"):
        os.environ["PLAYWRIGHT_BROWSERS_PATH"] = c
        break
from playwright.sync_api import sync_playwright

SID = sys.argv[1] if len(sys.argv) > 1 else "d66db2a5-ffc8-4c7a-89b7-ad15f51e5e8a"

JS = """async (sid) => {
  const r = await fetch(apiUrl('/api/sessions/' + encodeURIComponent(sid)), {cache:'no-store',
    headers: monitorToken ? {'X-Monitor-Token': monitorToken} : {}});
  const s = await r.json();
  const raw = s.messages || [];
  const msgs = (typeof dedupeGhostMsgs === 'function') ? dedupeGhostMsgs(raw) : raw;
  const box = document.createElement('div');
  box.id = 'probeBox';
  box.className = 'chat-body';   // 必须带 .chat-body，否则 grid 布局规则不生效、几何测量全假
  box.innerHTML = msgs.map(m => msgHTML(m)).join('');
  document.body.appendChild(box);

  const out = {raw: raw.length, afterDedupe: msgs.length};
  const all = [...box.querySelectorAll('.msg')];
  out.msgs = all.length;

  // 1. 嵌套气泡
  out.nestedBubble = box.querySelectorAll('.msg-bubble .msg-bubble').length;
  // 2. footer 位置：meta / actions 在 bubble 内还是外
  const asst = all.filter(e => e.classList.contains('assistant'));
  const user = all.filter(e => e.classList.contains('user'));
  const stat = (arr) => ({
    n: arr.length,
    metaInside: arr.filter(e => e.querySelector('.msg-bubble > .msg-meta')).length,
    metaOutside: arr.filter(e => e.querySelector(':scope > .msg-meta')).length,
    actInside: arr.filter(e => e.querySelector('.msg-bubble > .msg-actions')).length,
    actOutside: arr.filter(e => e.querySelector(':scope > .msg-actions')).length,
  });
  out.asst = stat(asst);
  out.user = stat(user);
  // 3. 同一 data-request-id 出现多个助手气泡
  const ridCount = {};
  asst.forEach(e => { const k = e.dataset.requestId || '(none)'; ridCount[k] = (ridCount[k]||0)+1; });
  out.dupRid = Object.entries(ridCount).filter(([k,v]) => v > 1);
  out.ridMissing = asst.filter(e => !e.dataset.requestId).length;
  // 4. 正文重复：同一气泡内 md-text 出现多次
  out.dupTextInBubble = asst.filter(e => e.querySelectorAll('.msg-bubble > .md-text').length > 1).length;
  // 5. 结构顺序：assistant 的 chat-sender 必须在 bubble 之前
  out.orderBad = asst.filter(e => {
    const kids = [...e.children].map(c => c.className.split(' ')[0]);
    const si = kids.indexOf('chat-sender'), bi = kids.indexOf('msg-bubble');
    if (si < 0 || bi < 0) return true;
    const mi = kids.lastIndexOf('msg-meta');
    return !(si < bi && mi > bi);   // meta 必须在 bubble 之后
  }).length;

  // 6. 几何：meta / actions 真的在气泡下方（grid row 生效）
  const geom = (arr) => arr.slice(0, 40).filter(e => {
    const b = e.querySelector('.msg-bubble'), mt = e.querySelector(':scope > .msg-meta'), ac = e.querySelector(':scope > .msg-actions');
    if (!b || !mt) return true;
    const bb = b.getBoundingClientRect(), mb = mt.getBoundingClientRect();
    if (mb.top < bb.bottom - 2) return true;                       // meta 压进气泡
    if (ac) { const ab = ac.getBoundingClientRect(); if (ab.top < bb.bottom - 2) return true; }
    return false;
  }).length;
  out.geomBadAsst = geom(asst);
  out.geomBadUser = geom(user);

  // 7. 气泡内同一张图出现多次
  const norm = s => { try { return decodeURIComponent(s).replace(/^https?:\\/\\/[^/]+/i, ''); } catch(e){ return s; } };
  out.dupImgInBubble = box.querySelectorAll('.msg-bubble').length && [...box.querySelectorAll('.msg-bubble')].filter(b => {
    const srcs = [...b.querySelectorAll('img')].map(i => norm(i.getAttribute('src') || ''));
    return srcs.length !== new Set(srcs).size;
  }).length;
  out.imgTotal = box.querySelectorAll('.msg-bubble img').length;
  out.imgUnique = new Set([...box.querySelectorAll('.msg-bubble img')].map(i => norm(i.getAttribute('src') || ''))).size;
  out.dedupeFn = typeof dedupeMarkdownImages === 'function';
  // 8. 去重函数本身：编码/未编码混写视为同一张
  if (out.dedupeFn) {
    const t = 'a![x](/data/tmp/特殊02_1.gif)b![y](/data/tmp/%E7%89%B9%E6%AE%8A02_1.gif)c![z](/data/tmp/other.gif)';
    out.dedupeUnit = (dedupeMarkdownImages(t).match(/!\\[/g) || []).length;   // 期望 2
  }

  box.remove();
  return out;
}"""

with sync_playwright() as p:
    b = p.chromium.launch(args=["--no-sandbox"])
    pg = b.new_page(viewport={"width": 1440, "height": 900})
    pg.goto("http://127.0.0.1:8650/", wait_until="load")
    pg.wait_for_function("typeof msgHTML === 'function' && typeof apiUrl === 'function'", timeout=30000)
    res = pg.evaluate(JS, SID)
    b.close()

print(json.dumps(res, ensure_ascii=False, indent=2))
