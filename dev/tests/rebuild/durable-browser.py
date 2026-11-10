"""Real browser + isolated queue/storage APIs; never reads or writes production sessions."""
import os,json,time,tempfile
from pathlib import Path
os.environ['HOME']='/tmp/hermes-rebuild-browser'
os.environ['PLAYWRIGHT_BROWSERS_PATH']='/vol1/@apphome/hermes-agent/data/.cache/ms-playwright'
from playwright.sync_api import sync_playwright

port=os.environ.get('PREVIEW_PORT')
if not port or not port.isdigit() or not 1<=int(port)<=65535:
 raise RuntimeError('PREVIEW_PORT must be supplied by run-browser-isolated.py')
url='http://127.0.0.1:'+port
shots=Path(tempfile.mkdtemp(prefix='hermes-rebuild-evidence-',dir='/tmp'));shots.chmod(0o777)
with sync_playwright() as p:
 b=p.chromium.launch(args=['--no-sandbox'])
 for w,h in [(1440,900),(390,844),(844,390)]:
  context=b.new_context(viewport={'width':w,'height':h});page=context.new_page();errors=[]
  page.on('pageerror',lambda e:errors.append(str(e)))
  context.route('**/*',lambda r:r.continue_(url=r.request.url.replace('/app/hermes-agent/','/')) if r.request.url.startswith(url) else r.abort())
  page.goto(url,wait_until='domcontentloaded');page.wait_for_timeout(700)
  page.evaluate("currentSession='test-a';_openTabs=['test-a','test-b'];persistTabs();renderSessionTabs();restoreDraft('test-a');loadSessionMessages('test-a');")
  page.wait_for_timeout(200)
  draft='跨页面草稿 '+str(w)
  page.locator('#chatInput').fill(draft);page.wait_for_timeout(800)
  page.reload(wait_until='domcontentloaded');page.wait_for_timeout(900)
  page.evaluate("currentSession='test-a';restoreDraft('test-a')");page.wait_for_timeout(200)
  assert page.locator('#chatInput').input_value()==draft,{'actual':page.locator('#chatInput').input_value(),'storage':page.evaluate("JSON.parse(localStorage.getItem('panel-draft-v2:test-a'))"),'server':context.request.get(url+'/api/workspace-ui/draft?session_id=test-a',headers={'X-Monitor-Token':'fixture-token'}).json(),'errors':errors}
  page.evaluate("switchTab('test-b')");page.locator('#chatInput').fill('另一个会话的草稿');page.wait_for_timeout(750)
  page.evaluate("switchTab('test-a')");page.wait_for_timeout(200);assert page.locator('#chatInput').input_value()==draft
  page.evaluate("openConnectorModal('tencent-news')")
  page.wait_for_selector('#connModalFoot button')
  before=context.request.get(url+'/__fixture/stats').json()
  page.locator('#connModalFoot').get_by_role('button',name='测试连接',exact=True).click()
  page.wait_for_function("document.getElementById('connectorActionStatus').textContent.includes('未保存凭证')")
  after=context.request.get(url+'/__fixture/stats').json()
  assert after.get('probes',0)==before.get('probes',0)+1
  assert after['mutations']==before['mutations']
  page.evaluate('closeConnectorModal()')
  # Picker uses live configured catalog and round intent persists with the draft.
  page.evaluate("openMini(document.getElementById('btnConnector'),'connector')")
  page.wait_for_selector('.connector-picker')
  page.locator('.connector-picker').get_by_role('button',name='已配置测试连接器',exact=True).click()
  assert '已配置测试连接器' in page.locator('#connectorChip').inner_text()
  page.wait_for_timeout(800)
  page.reload(wait_until='domcontentloaded');page.wait_for_timeout(900)
  page.evaluate("currentSession='test-a';restoreDraft('test-a');loadSessionMessages('test-a')")
  page.wait_for_function("document.getElementById('connectorChip').textContent.includes('已配置测试连接器')")
  page.evaluate("openMini(document.getElementById('btnConnector'),'connector')")
  page.wait_for_function("document.querySelector('.connector-picker').textContent.includes('已配置测试连接器')")
  assert page.locator('.connector-picker').get_by_role('button',name='未配置测试连接器',exact=True).count()==0
  page.locator('.connector-picker .navigation-close').click()
  # Waiting work is acknowledged by real disk-backed API, independent of page lifetime.
  context.request.post(url+'/__fixture/gate',data={'open':False})
  page.locator('#chatInput').fill('排队验收 '+str(w));page.evaluate('sendChat()');page.wait_for_timeout(600)
  page.wait_for_function("document.getElementById('durableQueue').innerText.includes('等待执行')")
  queued=context.request.get(url+'/api/chat/queue',headers={'X-Monitor-Token':'fixture-token'}).json()['jobs'];ids=[j['id'] for j in queued if j['session_id']=='test-a']
  assert ids
  job=context.request.get(url+'/api/chat/queue/'+ids[0],headers={'X-Monitor-Token':'fixture-token'}).json()
  assert '已配置测试连接器' in str(job)
  page.evaluate('clearConnectorChip()')
  page.close();page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)));page.goto(url,wait_until='domcontentloaded');page.wait_for_timeout(900)
  page.evaluate("currentSession='test-a';restoreDraft('test-a');loadSessionMessages('test-a')")
  page.wait_for_function("document.getElementById('durableQueue').innerText.includes('等待执行')")
  context.request.post(url+'/__fixture/gate',data={'open':True})
  for _ in range(30):
   status=context.request.get(url+'/api/chat/queue/'+ids[0],headers={'X-Monitor-Token':'fixture-token'}).json()['status']
   if status=='done':break
   page.wait_for_timeout(200)
  assert status=='done',status
  page.reload(wait_until='domcontentloaded');page.wait_for_timeout(900);page.evaluate("currentSession='test-a';restoreDraft('test-a');loadSessionMessages('test-a')");page.wait_for_timeout(250)
  assert '排队验收 '+str(w) in page.locator('#chatBody').inner_text()
  assert '工具' in page.locator('#chatBody').inner_text()
  stats=context.request.get(url+'/__fixture/stats').json();assert stats['executions'].count(ids[0])==1
  # A second accepted turn continues even after its session tab is closed.
  page.locator('#chatInput').fill('长任务 '+str(w));page.evaluate('sendChat()');page.wait_for_timeout(500)
  page.locator('#chatInput').fill('后续消息 '+str(w));page.evaluate('sendChat()');page.wait_for_timeout(300)
  deadline=time.monotonic()+15;accepted=[]
  while time.monotonic()<deadline:
   accepted=[j for j in context.request.get(url+'/api/chat/queue?all=1',headers={'X-Monitor-Token':'fixture-token'}).json()['jobs'] if j['session_id']=='test-a' and any((j.get('message',{}).get('text','') if isinstance(j.get('message'),dict) else j.get('message','')).startswith(text) for text in ['长任务 '+str(w),'后续消息 '+str(w)])]
   if len(accepted)==2:break
   page.wait_for_timeout(100)
  assert len(accepted)==2,accepted
  page.evaluate("closeTab('test-a')")
  page.wait_for_timeout(500)
  assert '长任务 '+str(w) not in page.locator('#chatBody').inner_text(),'background stream contaminated current session'
  deadline=time.monotonic()+20
  while time.monotonic()<deadline:
   finished=[context.request.get(url+'/api/chat/queue/'+j['id'],headers={'X-Monitor-Token':'fixture-token'}).json() for j in accepted]
   if all(j['status']=='done' for j in finished):break
   page.wait_for_timeout(100)
  assert all(j['status']=='done' for j in finished),finished
  messages=context.request.get(url+'/api/sessions/test-a').json()['messages']
  assert any(m.get('role')=='assistant' and '后续消息 '+str(w) in m.get('content','') for m in messages),{'messages':messages,'queue':context.request.get(url+'/api/chat/queue?all=1',headers={'X-Monitor-Token':'fixture-token'}).json(),'outbox':page.evaluate("localStorage.getItem('panel-message-outbox-v2')")}
  assert not any(m.get('queue_status')=='interrupted' for m in messages)
  page.evaluate("openTab('test-a')");page.wait_for_timeout(200)
  repeated='相同文本的两次主动发送 '+str(w)
  for _ in range(2):
   page.locator('#chatInput').fill(repeated);page.evaluate('sendChat()');page.wait_for_timeout(150)
  deadline=time.monotonic()+15;duplicates=[]
  while time.monotonic()<deadline:
   duplicates=[j for j in context.request.get(url+'/api/chat/queue?all=1',headers={'X-Monitor-Token':'fixture-token'}).json()['jobs'] if j['session_id']=='test-a' and (j.get('message',{}).get('text','') if isinstance(j.get('message'),dict) else j.get('message','')).startswith(repeated)]
   if len(duplicates)==2 and all(j['status']=='done' for j in duplicates):break
   page.wait_for_timeout(100)
  assert len({j['id'] for j in duplicates})==2 and all(j['status']=='done' for j in duplicates),duplicates
  calls=context.request.get(url+'/__fixture/stats').json()['executions'];assert all(calls.count(j['id'])==1 for j in duplicates)
  assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
  page.screenshot(path=str(shots/f'durable-{w}.png'))
  assert not errors,errors
  print(json.dumps({'viewport':[w,h],'pass':True,'draft_reload':True,'queue_page_close':True,'exactly_once':True,'close_tab_continues':True,'identical_text_distinct_turns':True,'errors':errors},ensure_ascii=False),flush=True)
  context.close()
 b.close()
