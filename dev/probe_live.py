#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""live-path 模拟：空内容助手气泡 → 设 hidden → 填正文 → 截图。
验的是流式那条链（panel-durable renderTurn 依赖的结构），不是历史渲染。
"""
import json, os, glob
HOME = "/vol1/@apphome/hermes-agent/data"
os.environ.setdefault("HOME", HOME)
if not os.environ.get("PLAYWRIGHT_BROWSERS_PATH"):
    for c in glob.glob(f"{HOME}/.cache/ms-playwright") + glob.glob("/root/.cache/ms-playwright"):
        os.environ["PLAYWRIGHT_BROWSERS_PATH"] = c
        break
from playwright.sync_api import sync_playwright

JS = """() => {
  const out = {steps: []};
  const box = document.createElement('div');
  box.id = 'liveBox'; box.className = 'chat-body';
  document.body.appendChild(box);
  // 1) 流式起步：msgHTML 渲染空正文助手气泡
  box.insertAdjacentHTML('beforeend', msgHTML({role:'assistant', content:'', ts: Date.now(), request_id:'LIVE-T1'}));
  const node = box.querySelector('.msg.assistant[data-request-id="LIVE-T1"]');
  out.steps.push(['node', !!node]);
  out.steps.push(['bubble', !!node.querySelector('.msg-bubble')]);
  out.steps.push(['actions_sibling', !!node.querySelector(':scope > .msg-actions')]);
  out.steps.push(['meta_sibling', !!node.querySelector(':scope > .msg-meta')]);
  // 2) renderTurn 里那行：给操作栏设 hidden（以前这里在 null 上设 → 抛错）
  try { const a = node.querySelector('.msg-actions'); a.hidden = true; out.steps.push(['set_hidden', 'ok']); }
  catch(e){ out.steps.push(['set_hidden', 'THROW ' + e.message]); }
  // 3) 重建气泡骨架（以前会删掉 footer）
  const bubble = node.querySelector('.msg-bubble');
  bubble.innerHTML = '<div class="msg-statusbar" hidden></div><div class="durable-reply md-text"></div><div class="durable-tools"></div><div class="chat-info"></div><div class="msg-flags" hidden></div>';
  out.steps.push(['footer_survived', !!node.querySelector(':scope > .msg-actions') && !!node.querySelector(':scope > .msg-meta')]);
  // 4) 填正文 + 去重
  const t = '好的。\\n\\n![压力](/data/tmp/%E7%89%B9%E6%AE%8A02_1794548862.gif)\\n\\n中间一段。\\n\\n![还是压力](/data/tmp/特殊02_1794548862.gif)';
  bubble.querySelector('.durable-reply').innerHTML = renderMarkdown(dedupeMarkdownImages(t), false);
  out.steps.push(['imgs_in_bubble', bubble.querySelectorAll('img').length]);   // 期望 1
  // 5) 几何
  const b = bubble.getBoundingClientRect(), m = node.querySelector(':scope > .msg-meta').getBoundingClientRect();
  out.metaBelowBubble = m.top >= b.bottom - 2;
  // 6) 再渲染一条用户气泡做对照
  box.insertAdjacentHTML('beforeend', msgHTML({role:'user', content:'测试', ts: Date.now(), request_id:'LIVE-T1'}));
  out.userMetaOutside = !!box.querySelector('.msg.user[data-request-id="LIVE-T1"] > .msg-meta');
  return out;
}"""

with sync_playwright() as p:
    b = p.chromium.launch(args=["--no-sandbox"])
    pg = b.new_page(viewport={"width": 1440, "height": 1000})
    pg.goto("http://127.0.0.1:8650/", wait_until="load")
    pg.wait_for_function("typeof msgHTML === 'function' && typeof renderMarkdown === 'function'", timeout=30000)
    res = pg.evaluate(JS)
    print(json.dumps(res, ensure_ascii=False, indent=2))
    el = pg.query_selector("#liveBox")
    if el:
        el.screenshot(path="/vol1/@apphome/hermes-agent/data/tmp/live_bubble.png")
        print("shot: /vol1/@apphome/hermes-agent/data/tmp/live_bubble.png")
    b.close()
