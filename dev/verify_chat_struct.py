#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""verify_chat_struct.py — 气泡结构定点验收（可复跑，留在仓库）

验的是「渲染出来的 DOM」，不是源码字面量：
  A 历史渲染（真会话数据 → msgHTML → 真实 DOM）
  B 流式起步（空正文助手气泡 → 改 hidden → 重建骨架 → 填正文）
  C 版本一致性（生产与源码 md5 一致、?v= 与 md5 前 8 位对齐）

为什么用浏览器而不是读源码：上一轮 footer 被写进 .msg-bubble 里，源码看着「有 meta」，
静态检查全绿，但 grid-row 全落空、页面上就是「顺序不对、被包在气泡里」。
结构对不对只有在 DOM 里量才算数。

用法: python3 dev/verify_chat_struct.py [session_id]
退出码: 0 全过 / 1 有失败
"""
import hashlib, json, os, sys, glob

HOME = "/vol1/@apphome/hermes-agent/data"
SRC = f"{HOME}/workspace/fnos-hermes-agent-src/app/ui"
PROD = "/vol1/@appcenter/hermes-agent/ui"
os.environ.setdefault("HOME", HOME)
if not os.environ.get("PLAYWRIGHT_BROWSERS_PATH"):
    for c in glob.glob(f"{HOME}/.cache/ms-playwright") + glob.glob("/root/.cache/ms-playwright"):
        os.environ["PLAYWRIGHT_BROWSERS_PATH"] = c
        break
from playwright.sync_api import sync_playwright

SID = sys.argv[1] if len(sys.argv) > 1 else "d66db2a5-ffc8-4c7a-89b7-ad15f51e5e8a"
R = []


def chk(group, name, got, want, ok=None):
    if ok is None:
        ok = (got == want)
    R.append((group, name, got, want, ok))


HIST = """async (sid) => {
  const r = await fetch(apiUrl('/api/sessions/' + encodeURIComponent(sid)), {cache:'no-store',
    headers: monitorToken ? {'X-Monitor-Token': monitorToken} : {}});
  const s = await r.json();
  const msgs = dedupeGhostMsgs(s.messages || []);
  const box = document.createElement('div');
  box.className = 'chat-body'; box.id = 'vbBox';
  box.innerHTML = msgs.map(m => msgHTML(m)).join('');
  document.body.appendChild(box);
  const all = [...box.querySelectorAll('.msg')];
  const asst = all.filter(e => e.classList.contains('assistant'));
  const user = all.filter(e => e.classList.contains('user'));
  const norm = s => { try { return decodeURIComponent(s).replace(/^https?:\\/\\/[^/]+/i, ''); } catch(e){ return s; } };
  const out = {
    msgs: all.length, asst: asst.length, user: user.length,
    nestedBubble: box.querySelectorAll('.msg-bubble .msg-bubble').length,
    metaInsideAsst: asst.filter(e => e.querySelector('.msg-bubble > .msg-meta')).length,
    metaOutsideAsst: asst.filter(e => e.querySelector(':scope > .msg-meta')).length,
    actInsideAsst: asst.filter(e => e.querySelector('.msg-bubble > .msg-actions')).length,
    actOutsideAsst: asst.filter(e => e.querySelector(':scope > .msg-actions')).length,
    metaOutsideUser: user.filter(e => e.querySelector(':scope > .msg-meta')).length,
    ridMissing: asst.filter(e => !e.dataset.requestId).length,
    dupImgInBubble: [...box.querySelectorAll('.msg-bubble')].filter(b => {
      const srcs = [...b.querySelectorAll('img')].map(i => norm(i.getAttribute('src') || ''));
      return srcs.length !== new Set(srcs).size;
    }).length,
    // 顺序：sender < bubble < meta
    orderBad: asst.filter(e => {
      const k = [...e.children].map(c => c.className.split(' ')[0]);
      const si = k.indexOf('chat-sender'), bi = k.indexOf('msg-bubble'), mi = k.lastIndexOf('msg-meta');
      return !(si >= 0 && bi > si && mi > bi);
    }).length,
    // 几何：meta 必须在气泡下沿之下；有操作栏时也必须在气泡之下
    geomBad: asst.filter(e => {
      const b = e.querySelector('.msg-bubble'), m = e.querySelector(':scope > .msg-meta');
      const a = e.querySelector(':scope > .msg-actions');
      if (!b || !m) return true;
      const bb = b.getBoundingClientRect();
      if (m.getBoundingClientRect().top < bb.bottom - 2) return true;
      if (a && a.getBoundingClientRect().top < bb.bottom - 2) return true;
      return false;
    }).length,
  };
  const rid = {};
  asst.forEach(e => { const k = e.dataset.requestId; if (k) rid[k] = (rid[k] || 0) + 1; });   // 只统计真有 id 的，别把「老消息没 id」算成同一组
  out.dupRid = Object.entries(rid).filter(([k, v]) => v > 1).length;
  // 老会话（request-id 落库之前）本来就没有这个属性，不算缺陷；只要最新那条有，增量通道就是通的
  out.lastHasRid = !!(asst.length && asst[asst.length - 1].dataset.requestId);
  // 去重函数单测：编码/未编码同一张算一张，不同图保留
  const t = 'a![x](/data/tmp/特殊02_1.gif)b![y](/data/tmp/%E7%89%B9%E6%AE%8A02_1.gif)c![z](/data/tmp/other.gif)';
  out.dedupeKeep = (dedupeMarkdownImages(t).match(/!\\[/g) || []).length;
  box.remove();
  return out;
}"""

LIVE = """() => {
  const box = document.createElement('div');
  box.className = 'chat-body'; box.id = 'vbLive';
  document.body.appendChild(box);
  box.insertAdjacentHTML('beforeend', msgHTML({role:'assistant', content:'', ts: Date.now(), request_id:'VB-T1'}));
  const node = box.querySelector('.msg.assistant[data-request-id="VB-T1"]');
  const out = {
    actionsSibling: !!node.querySelector(':scope > .msg-actions'),
    metaSibling: !!node.querySelector(':scope > .msg-meta'),
  };
  // renderTurn 里那行：以前在 null 上设 hidden → 抛错 → 整轮发送中断
  try { node.querySelector('.msg-actions').hidden = true; out.setHidden = 'ok'; }
  catch (e) { out.setHidden = 'THROW'; }
  const bubble = node.querySelector('.msg-bubble');
  bubble.innerHTML = '<div class="msg-statusbar" hidden></div><div class="durable-reply md-text"></div>' +
    '<div class="durable-tools"></div><div class="chat-info"></div><div class="msg-flags" hidden></div>';
  out.footerSurvived = !!node.querySelector(':scope > .msg-actions') && !!node.querySelector(':scope > .msg-meta');
  const t = '![a](/data/tmp/%E7%89%B9%E6%AE%8A02_1.gif) 中间 ![b](/data/tmp/特殊02_1.gif)';
  bubble.querySelector('.durable-reply').innerHTML = renderMarkdown(dedupeMarkdownImages(t), false);
  out.imgsInBubble = bubble.querySelectorAll('img').length;
  const bb = bubble.getBoundingClientRect(), mm = node.querySelector(':scope > .msg-meta').getBoundingClientRect();
  out.metaBelowBubble = mm.top >= bb.bottom - 2;
  box.remove();
  return out;
}"""


def md5(p):
    with open(p, "rb") as f:
        return hashlib.md5(f.read()).hexdigest()


with sync_playwright() as p:
    b = p.chromium.launch(args=["--no-sandbox"])
    pg = b.new_page(viewport={"width": 1440, "height": 1000})
    pg.goto("http://127.0.0.1:8650/", wait_until="load")
    pg.wait_for_function("typeof msgHTML === 'function' && typeof dedupeMarkdownImages === 'function'", timeout=30000)
    h = pg.evaluate(HIST, SID)
    l = pg.evaluate(LIVE)
    b.close()

# ── A 历史渲染
chk("A", "渲染出的消息数 > 0", h["msgs"], ">0", h["msgs"] > 0)
chk("A", "嵌套气泡层数", h["nestedBubble"], 0)
chk("A", "助手 meta 在气泡内（应 0）", h["metaInsideAsst"], 0)
chk("A", "助手 meta 在气泡外", h["metaOutsideAsst"], h["asst"])
chk("A", "助手操作栏在气泡内（应 0）", h["actInsideAsst"], 0)
chk("A", "助手操作栏在气泡外", h["actOutsideAsst"], h["asst"])
chk("A", "用户 meta 在气泡外", h["metaOutsideUser"], h["user"])
chk("A", "老消息无 request-id（历史遗留，仅记录）", h["ridMissing"], "info", True)
chk("A", "最新助手气泡带 request-id（老会话可无）", h["lastHasRid"], "info", True)
chk("A", "同 request-id 多个助手气泡", h["dupRid"], 0)
chk("A", "气泡内重复图片", h["dupImgInBubble"], 0)
chk("A", "子节点顺序 sender<bubble<meta", h["orderBad"], 0)
chk("A", "meta/操作栏几何位置", h["geomBad"], 0)
chk("A", "去重保留数（编码混写算一张）", h["dedupeKeep"], 2)

# ── B 流式起步
chk("B", "空正文气泡带操作栏", l["actionsSibling"], True)
chk("B", "空正文气泡带 meta", l["metaSibling"], True)
chk("B", "给操作栏设 hidden 不抛错", l["setHidden"], "ok")
chk("B", "重建骨架后 footer 仍在", l["footerSurvived"], True)
chk("B", "流式去重后气泡内图片数", l["imgsInBubble"], 1)
chk("B", "meta 在气泡下沿之下", l["metaBelowBubble"], True)

# ── C 版本一致性
for f in ("js/chat/tabs.js", "js/panel-durable.js"):
    s, d = md5(f"{SRC}/{f}"), md5(f"{PROD}/{f}")
    chk("C", f"md5 源码=生产 {f.split('/')[-1]}", s == d, True)
s, d = md5(f"{SRC}/index.html"), md5(f"{PROD}/index.html")
chk("C", "md5 源码=生产 index.html", s == d, True)
html = open(f"{PROD}/index.html", encoding="utf-8").read()
tabs_md5 = md5(f"{PROD}/js/chat/tabs.js")[:8]
chk("C", "index 里 tabs.js 版本号=md5前8位", f"?v={tabs_md5}" in html, True)

fail = [r for r in R if not r[4]]
for g, n, got, want, ok in R:
    print(f"[{'PASS' if ok else 'FAIL'}] {g} {n}: got={got!r} want={want!r}")
print(f"\n结果: {len(R) - len(fail)} 通过 / {len(fail)} 失败   session={SID}")
sys.exit(1 if fail else 0)
