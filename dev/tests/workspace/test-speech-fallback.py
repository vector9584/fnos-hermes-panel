from pathlib import Path
import os,json
root=Path('/vol1/@apphome/hermes-agent/data');os.environ['HOME']=str(root);os.environ['PLAYWRIGHT_BROWSERS_PATH']=str(root/'.cache/ms-playwright')
from playwright.sync_api import sync_playwright
pdir=Path(__file__).resolve().parents[3]/'app'
with sync_playwright() as p:
 b=p.chromium.launch(args=['--no-sandbox']);page=b.new_page();called=[]
 def route(r):
  p=r.request.url.split('8650',1)[-1].split('?',1)[0].removeprefix('/app/hermes-agent')
  if p=='/':return r.fulfill(content_type='text/html',body=(pdir/'ui/index.html').read_text())
  if p.endswith('panel-workspace-ui.js'):return r.fulfill(content_type='text/javascript',body=(pdir/'ui/js/panel-workspace-ui.js').read_text())
  if p.endswith('panel-workspace.css'):return r.fulfill(content_type='text/css',body=(pdir/'ui/css/panel-workspace.css').read_text())
  if '/api/' not in p:return r.continue_()
  if p in ['/api/workspace-ui/speak','/api/workspace-ui/system-speak']:
   called.append(p);return r.fulfill(status=502,content_type='application/json',body='{"error":"test outage"}')
  if p=='/api/workspace-ui':return r.fulfill(content_type='application/json',body=json.dumps({'folders':[],'sessions':{},'favorites':[],'identity':{'user_name':'Vector','user_avatar':'👤','assistant_name':'Hermes','assistant_avatar':'🤖'},'voice':{'engine':'windows','fallback':True}}))
  return r.fulfill(content_type='application/json',body='{"ok":true}')
 page.route('**/*',route);page.goto('http://127.0.0.1:8650/',wait_until='domcontentloaded');page.wait_for_timeout(1000)
 page.evaluate("() => {window.__speech=[];window.__cancel=0;Object.defineProperty(window,'speechSynthesis',{value:{speak:u=>__speech.push(u.text),cancel:()=>__cancel++},configurable:true});localStorage.setItem('fnos-voice-barge','0');document.getElementById('chatBody').innerHTML=msgHTML({role:'assistant',content:'测试回退',ts:Date.now()});}")
 page.locator('#chatBody button[onclick="speakMsg(this)"]').click();page.wait_for_function('__speech.length===1')
 assert called==['/api/workspace-ui/speak','/api/workspace-ui/system-speak'],called
 assert page.evaluate('__speech[0]')=='测试回退'
 assert page.locator('#chatBody .speaking').count()==1
 page.locator('#chatBody .speaking').click();page.wait_for_timeout(100);assert page.locator('#chatBody .speaking').count()==0
 print('PASS: Windows failure → independent Edge failure → browser speech; repeat click cancels playback')
 b.close()
