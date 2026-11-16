#!/usr/bin/env python3
"""ui_probe.py — 无头浏览器量面板：截图 + DOM 断言 + 横向溢出检测

用法:
  ui_probe.py                                  # 默认三档视口截首页
  ui_probe.py --viewports 375x812             # 指定视口
  ui_probe.py --eval "document.title"         # 求值并打印
  ui_probe.py --eval "..." --eval-el "#chatBody"   # 在元素上求值
  ui_probe.py --click "text=设置"             # 先点再测
  ui_probe.py --fill "#chatInput|hello"       # 填表单
  ui_probe.py --shot-dir /tmp/shots

退出码: 0=无溢出且断言通过, 3=检测到横向溢出, 4=页面/浏览器错误
"""
import argparse, json, os, sys, glob

HOME = "/vol1/@apphome/hermes-agent/data"
os.environ.setdefault("HOME", HOME)
if not os.environ.get("PLAYWRIGHT_BROWSERS_PATH"):
    for c in glob.glob(f"{HOME}/.cache/ms-playwright") + glob.glob("/root/.cache/ms-playwright"):
        os.environ["PLAYWRIGHT_BROWSERS_PATH"] = c
        break

from playwright.sync_api import sync_playwright

OVERFLOW_JS = """() => {
  const out = {docScroll: document.documentElement.scrollWidth, vw: innerWidth, hits: []};
  const seen = new Set();
  document.querySelectorAll('body *').forEach(el => {
    const cs = getComputedStyle(el);
    if (cs.overflowX === 'auto' || cs.overflowX === 'scroll' || cs.overflowX === 'hidden') return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    if (r.right > innerWidth + 1 && r.left > -1) {
      const key = el.tagName + '.' + (el.className || '').toString().slice(0, 30);
      if (seen.has(key)) return; seen.add(key);
      out.hits.push({el: key, left: Math.round(r.left), right: Math.round(r.right),
                     text: (el.textContent || '').trim().slice(0, 40)});
    }
  });
  out.hits = out.hits.slice(0, 12);
  return out;
}"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8650/")
    ap.add_argument("--viewports", default="375x812,414x896,1440x900")
    ap.add_argument("--eval", dest="expr")
    ap.add_argument("--eval-el", dest="eval_el")
    ap.add_argument("--click", action="append", default=[])
    ap.add_argument("--fill", action="append", default=[], help="选择器|值")
    ap.add_argument("--shot-dir", default="/vol1/@apphome/hermes-agent/data/tmp/probe")
    ap.add_argument("--wait", type=int, default=900, help="goto 之后等多少毫秒")
    ap.add_argument("--wait-after", type=int, default=0,
                    help="执行完 --eval/--click/--fill 之后再等多少毫秒（等异步渲染落定）")
    ap.add_argument("--full", action="store_true", help="整页截图")
    ap.add_argument("--no-overflow", action="store_true")
    ap.add_argument("--token-file", help="把文件里的面板 token 注入 window.monitorToken（走文件，不上命令行）")
    a = ap.parse_args()
    os.makedirs(a.shot_dir, exist_ok=True)
    token = ""
    if a.token_file:
        try:
            with open(a.token_file, encoding="utf-8") as fh:
                token = fh.read().strip()
        except OSError as error:
            print(json.dumps({"error": f"token-file: {error}"}, ensure_ascii=False))
            return 4
    rc = 0
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--no-sandbox"])
        for vp in a.viewports.split(","):
            w, h = (int(x) for x in vp.lower().split("x"))
            pg = b.new_page(viewport={"width": w, "height": h}, device_scale_factor=2)
            try:
                pg.goto(a.url, wait_until="domcontentloaded", timeout=25000)
                # 面板的 /api/* 全要 X-Monitor-Token；无头浏览器是新会话、没有登录 cookie，
                # 不注入就只能看到「正在读取…」永远转圈。凭据从文件读，不进 argv。
                if token:
                    pg.evaluate("(t) => { window.monitorToken = t; }", token)
                pg.wait_for_timeout(a.wait)
                for sel in a.click:
                    pg.click(sel, timeout=8000)
                    pg.wait_for_timeout(400)
                for spec in a.fill:
                    sel, _, val = spec.partition("|")
                    pg.fill(sel, val, timeout=8000)
                rec = {"viewport": vp}
                if not a.no_overflow:
                    ov = pg.evaluate(OVERFLOW_JS)
                    rec["overflow"] = ov
                    if ov["docScroll"] > ov["vw"] + 1 or ov["hits"]:
                        rc = 3
                if a.expr:
                    if a.eval_el:
                        h = pg.query_selector(a.eval_el)
                        if h is None:
                            rec["eval"] = f"NO_SUCH_ELEMENT: {a.eval_el}"
                        else:
                            rec["eval"] = pg.evaluate(
                                "([e, ex]) => { try { return eval(ex) } catch (x) { return 'ERR: ' + x.message } }",
                                [h, a.expr])
                    else:
                        rec["eval"] = pg.evaluate(a.expr)
                shot = os.path.join(a.shot_dir, f"probe_{w}.png")
                if a.wait_after:
                    pg.wait_for_timeout(a.wait_after)
                pg.screenshot(path=shot, full_page=a.full)
                rec["shot"] = shot
                print(json.dumps(rec, ensure_ascii=False))
            except Exception as e:
                print(json.dumps({"viewport": vp, "error": f"{type(e).__name__}: {e}"}, ensure_ascii=False))
                rc = 4
            finally:
                pg.close()
        b.close()
    return rc


if __name__ == "__main__":
    sys.exit(main())
