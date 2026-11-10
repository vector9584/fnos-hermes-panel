import os,time,json
from playwright.sync_api import sync_playwright
os.environ['PLAYWRIGHT_BROWSERS_PATH']='/vol1/@apphome/hermes-agent/data/.cache/ms-playwright'
with sync_playwright() as p:
 b=p.chromium.launch(args=['--no-sandbox'])
 for method in ['fill','insert_text']:
  page=b.new_page();page.set_content('<textarea aria-label="text" style="width:800px;height:500px" spellcheck="false"></textarea>');editor=page.get_by_role('textbox');editor.focus();start=time.monotonic()
  try:
   if method=='fill':editor.fill('长资料正文\n'*4000,timeout=10000)
   else:page.keyboard.insert_text('长资料正文\n'*4000)
   print(json.dumps({'method':method,'seconds':time.monotonic()-start,'chars':len(editor.input_value())}),flush=True)
  except Exception as error:print(json.dumps({'method':method,'seconds':time.monotonic()-start,'error':type(error).__name__}),flush=True)
  page.close()
 b.close()
