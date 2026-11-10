from pathlib import Path
import os,json
root=Path('/vol1/@apphome/hermes-agent/data');os.environ['HOME']=str(root);os.environ['PLAYWRIGHT_BROWSERS_PATH']=str(root/'.cache/ms-playwright')
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
 b=p.chromium.launch(args=['--no-sandbox']);page=b.new_page(viewport={'width':1440,'height':900});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto('http://127.0.0.1:8650/',wait_until='domcontentloaded');page.wait_for_timeout(1300)
 page.evaluate("pwSearch('Hermes')");page.wait_for_selector('[data-hit]')
 result=page.evaluate("apiGet('/api/workspace-ui/search?q=Hermes')")
 for kind in ['panel','channel']:
  idx=next((i for i,r in enumerate(result['results']) if r['kind']==kind and r['message_index']>=0),None)
  assert idx is not None,kind
  if kind=='channel':page.evaluate("pwSearch('Hermes')");page.wait_for_selector('[data-hit]')
  page.locator('[data-hit="'+str(idx)+'"]').click();page.wait_for_selector('#chatBody .pw-hit');page.wait_for_timeout(200)
  assert page.locator('#chatBody .pw-hit').count()==1
  box=page.locator('#chatBody').bounding_box();hit=page.locator('#chatBody .pw-hit').bounding_box();assert hit['y']<box['y']+box['height'] and hit['y']+hit['height']>box['y']
  if kind=='channel':assert page.locator('#chatComposer').is_hidden();assert page.evaluate('_channelViewActive')
  print('PASS LIVE SEARCH NAV',kind,'exact message highlighted')
 page.evaluate('switchTab(currentSession)');page.wait_for_timeout(300);assert page.locator('#chatComposer').is_visible();assert not page.evaluate('_channelViewActive')
 rooms=page.evaluate("apiGet('/api/rooms')")['rooms'];r=page.evaluate("apiGet('/api/rooms/'+"+json.dumps(rooms[0]['id'])+")")['room'];msg=next(m for m in r['messages'] if m.get('text') and len(m['text'])>10)
 q=msg['text'][:12];page.evaluate('(q)=>pwSearch(q)',q);page.wait_for_selector('[data-hit]')
 res=page.evaluate('(q)=>apiGet("/api/workspace-ui/search?q="+encodeURIComponent(q))',q);idx=next(i for i,m in enumerate(res['results']) if m['kind']=='room' and m['session_id']==r['id'])
 page.locator('[data-hit="'+str(idx)+'"]').click();page.wait_for_selector('#roomMsgs .pw-hit');assert page.evaluate('currentRoom')==r['id']
 print('PASS LIVE SEARCH NAV room exact message highlighted')
 assert not errors,errors;b.close()
