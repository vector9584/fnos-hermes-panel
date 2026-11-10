from pathlib import Path
import os,json,time
root=Path('/vol1/@apphome/hermes-agent/data');os.environ['HOME']=str(root);os.environ['PLAYWRIGHT_BROWSERS_PATH']=str(root/'.cache/ms-playwright')
from playwright.sync_api import sync_playwright
candidate=Path(__file__).resolve().parents[3]/'app'
state={'folders':[],'sessions':{},'favorites':[],'identity':{'user_name':'Vector','user_avatar':'👤','assistant_name':'Hermes','assistant_avatar':'🤖'},'voice':{'engine':'windows','fallback':True}}
msgs=[{'role':'user' if i%2==0 else 'assistant','content':('消息 '+str(i)+' 测试检索关键词\n')*3,'ts':1700000000000+i*1000} for i in range(50)]
sessions=[{'id':'test-a','title':'验收会话A','updated_at':1700000000000,'message_count':50},{'id':'test-b','title':'验收会话B','updated_at':1700000000000,'message_count':1}]
expert={'id':'test-expert','slug':'test-expert','name':'测试专家','emoji':'🔧','desc':'验证专长选择','prompt':'你是测试专家','skills':[]}
rooms=[];writes=[]
def route(r):
 from urllib.parse import urlparse,parse_qs
 u=urlparse(r.request.url);p=u.path.removeprefix('/app/hermes-agent');method=r.request.method
 if p=='/':return r.fulfill(content_type='text/html',body=(candidate/'ui/index.html').read_text())
 if p.endswith('panel-workspace-ui.js'):return r.fulfill(content_type='text/javascript',body=(candidate/'ui/js/panel-workspace-ui.js').read_text())
 if p.endswith('panel-workspace.css'):return r.fulfill(content_type='text/css',body=(candidate/'ui/css/panel-workspace.css').read_text())
 if '/api/' not in p:return r.continue_()
 b=r.request.post_data_json if r.request.post_data else {}
 if method!='GET':writes.append(p)
 out={}
 if p=='/api/health':out={'ok':True,'token':'test'}
 elif p=='/api/workspace-ui':out=state
 elif p=='/api/workspace-ui/folders':
  if method=='POST':f={'id':'folder-'+str(len(state['folders'])),'name':b['name'],'parent_id':b.get('parent_id','')};state['folders'].append(f);out={'ok':True,'folder':f}
 elif p=='/api/workspace-ui/session':state['sessions'].setdefault(b['id'],{}).update({k:v for k,v in b.items() if k!='id'});out={'ok':True}
 elif p=='/api/workspace-ui/preferences':
  for k,v in b.items():
   if isinstance(v,dict):state[k].update(v)
   else:state[k]=v
  out={'ok':True,'state':state}
 elif p=='/api/workspace-ui/search':out={'results':[{'kind':'panel','session_id':'test-a','title':'验收会话A','snippet':'测试检索关键词','message_index':10,'ts':1700000000000}],'total':1,'has_more':False}
 elif p=='/api/workspace-ui/voice':out={'ok':True,'voices':[{'id':'voice-a','name':'爱弥斯'}],'current':{'id':'voice-a','emo_auto':True},'preferences':state['voice']}
 elif p=='/api/sessions/rename':
  for s in sessions:
   if s['id']==b['id']:s['title']=b['title']
  out={'ok':True,'title':b['title']}
 elif p=='/api/sessions':
  if method=='POST':s={'id':'test-'+str(len(sessions)),'title':'New Chat','message_count':0};sessions.append(s);out=s
  else:out={'sessions':sessions}
 elif p.startswith('/api/sessions/') and p.count('/')==3:out={**next((s for s in sessions if s['id']==p.rsplit('/',1)[-1]),sessions[0]),'messages':msgs}
 elif p=='/api/profiles':out={'ok':True,'profiles':[{'id':'default','name':'默认环境','is_active':True}]}
 elif p=='/api/experts':out={'ok':True,'experts':[expert],'overrides':{}}
 elif p=='/api/rooms':
  if method=='POST':room={**b,'id':'room-test','messages':[]};rooms.append(room);out={'ok':True,'room':room}
  else:out={'ok':True,'rooms':rooms}
 elif p.startswith('/api/rooms/'):out={'ok':True,'room':rooms[0] if rooms else {}}
 elif p=='/api/gateway/health':out={'ok':True}
 elif p=='/api/chat/config':out={'providers':[],'extensions':{}}
 return r.fulfill(content_type='application/json',body=json.dumps(out,ensure_ascii=False))
with sync_playwright() as p:
 browser=p.chromium.launch(args=['--no-sandbox'])
 for w,h in [(1440,900),(375,812),(414,896)]:
  page=browser.new_page(viewport={'width':w,'height':h});errors=[];page.on('pageerror',lambda e:errors.append(str(e)));page.route('**/*',route)
  page.goto('http://127.0.0.1:8650/',wait_until='domcontentloaded');page.wait_for_timeout(1300)
  page.evaluate("_sessions="+json.dumps(sessions)+";currentSession='test-a';renderRail();loadSessionMessages(currentSession);openRailDrawer()")
  page.wait_for_timeout(300)
  assert page.locator('.pw-role').count()==1,errors
  page.evaluate('pwNewMenu()');page.locator('#pwNewFolder').click();page.locator('#pwFolderName').fill('我的项目');page.locator('#pwSaveFolder').click();page.wait_for_timeout(150)
  assert page.locator('.pw-folder').count()>0
  page.evaluate("renameSession('test-a')");page.locator('#pwSessionTitle').fill('项目讨论');page.locator('#pwSessionFolder').select_option('folder-0');page.locator('#pwSaveSession').click();page.wait_for_timeout(150)
  assert state['sessions']['test-a']['folder_id']=='folder-0'
  page.evaluate('pwOpenRole()');page.wait_for_selector('#pwRoleQuery');page.locator('#pwRoleQuery').fill('测试专家');page.locator('[data-expert="0"]').click();page.wait_for_timeout(250)
  assert state['sessions']['test-a']['expert']['id']=='test-expert'
  assert '测试专家' in page.locator('.pw-role').inner_text()
  # Old default messages do not become expert messages retroactively.
  assert state['identity']['assistant_name'] in page.locator('#chatBody .msg.assistant .chat-sender').first.inner_text()
  page.evaluate('pwIdentity()');page.locator('#pwUserName').fill('Vector <test>');page.locator('#pwAssistantName').fill('小助手');page.locator('#pwSaveIdentity').click();page.wait_for_timeout(150)
  assert 'Vector <test>' in page.locator('#chatBody .msg.user .chat-sender').first.inner_text()
  page.evaluate("pwSearch('测试检索')");page.wait_for_selector('[data-hit="0"]');page.locator('[data-hit="0"]').click();page.wait_for_timeout(300)
  assert page.locator('#chatBody .pw-hit').get_attribute('data-message-index')=='10'
  pos=page.locator('#chatBody .pw-hit').bounding_box();box=page.locator('#chatBody').bounding_box();assert box['y']<=pos['y']<box['y']+box['height'],(pos,box)
  assert not page.evaluate('autoScrollActive()')
  page.evaluate('openVoiceSettings()');page.wait_for_selector('#pwVoiceId option[value="voice-a"]',state='attached')
  assert page.locator('#pwVoiceEngine').input_value()=='windows'
  assert page.locator('#pwVoiceChat').count()==1 and page.locator('#pwVoiceBarge').count()==1
  page.screenshot(path=str(root/'tmp'/f'workspace-voice-{w}.png'))
  page.locator('.pw-modal .modal-close').click()
  page.evaluate("switchPage('experts');expSwitchTab(document.querySelectorAll('#expTabs button')[1],'builtin')");page.wait_for_selector('#expBuiltinGrid [data-pw-chat="test-expert"]');page.locator('#expBuiltinGrid [data-pw-fav="test-expert"]').click();page.wait_for_timeout(100)
  page.screenshot(path=str(root/'tmp'/f'workspace-experts-{w}.png'))
  page.locator('#expBuiltinGrid [data-pw-room="test-expert"]').click();page.wait_for_selector('#pwRoomCreate');page.locator('#pwRoomCreate').click();page.wait_for_timeout(300)
  assert rooms[-1]['members'][0]['system']=='你是测试专家'
  assert '测试专家' in page.locator('#roomMembers').inner_text()
  assert page.locator('#roomTitle').inner_text()=='专家讨论'
  assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'),w
  # Console errors in exercised new paths are blockers.
  assert not errors,errors
  print('PASS viewport',w,'folders/rename/role/identity/search-jump/voice/experts/group creation')
  page.close()
 assert '/api/config' not in writes and '/api/profiles/active' not in writes,writes
 browser.close()
