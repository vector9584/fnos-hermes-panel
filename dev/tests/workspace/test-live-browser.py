from pathlib import Path
import os,json
root=Path('/vol1/@apphome/hermes-agent/data');os.environ['HOME']=str(root);os.environ['PLAYWRIGHT_BROWSERS_PATH']=str(root/'.cache/ms-playwright')
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
 b=p.chromium.launch(args=['--no-sandbox'])
 for w,h in [(375,812),(414,896),(1440,900)]:
  page=b.new_page(viewport={'width':w,'height':h});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  page.goto('http://127.0.0.1:8650/',wait_until='domcontentloaded');page.wait_for_timeout(1500)
  page.evaluate("switchPage('experts');expSwitchTab(document.querySelectorAll('#expTabs button')[1],'builtin')")
  page.wait_for_selector('#expBuiltinGrid [data-pw-chat]');count=page.locator('#expBuiltinGrid [data-pw-chat]').count()
  assert count>=280,count
  assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
  page.screenshot(path=str(root/'tmp'/f'workspace-live-experts-{w}.png'))
  page.evaluate('openVoiceSettings()');page.wait_for_selector('#pwVoiceId option',state='attached');page.wait_for_function("document.querySelector('#pwVoiceId').options.length>=20")
  assert page.locator('#pwVoiceEngine').input_value()=='windows'
  page.screenshot(path=str(root/'tmp'/f'workspace-live-voice-{w}.png'));page.locator('.pw-modal .modal-close').click()
  page.evaluate("pwSearch('Hermes')");page.wait_for_selector('[data-hit]');results=page.locator('[data-hit]').count();assert results>0
  page.screenshot(path=str(root/'tmp'/f'workspace-live-search-{w}.png'))
  assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
  assert not errors,errors
  print('PASS LIVE BROWSER',w,'experts',count,'search',results,'voice catalog=20, no script errors')
  page.close()
 b.close()
