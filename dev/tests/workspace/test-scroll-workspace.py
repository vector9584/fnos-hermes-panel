from pathlib import Path
import os,json
os.environ['HOME']='/vol1/@apphome/hermes-agent/data'
os.environ['PLAYWRIGHT_BROWSERS_PATH']=os.environ['HOME']+'/.cache/ms-playwright'
from playwright.sync_api import sync_playwright
candidate=(Path(__file__).resolve().parents[3]/'app/ui/index.html').read_text()
with sync_playwright() as p:
 browser=p.chromium.launch(args=['--no-sandbox'])
 for w,h in [(375,812),(414,896),(1440,900)]:
  page=browser.new_page(viewport={'width':w,'height':h},device_scale_factor=1)
  # Test candidate UI against static resources, block startup API writes and real user session loads.
  def route(r):
   from urllib.parse import urlparse
   url=urlparse(r.request.url);path=url.path.removeprefix('/app/hermes-agent')
   base=Path(__file__).resolve().parents[3]/'app/ui'
   if path=='/':return r.fulfill(content_type='text/html',body=candidate)
   if path.endswith('panel-workspace-ui.js'):return r.fulfill(content_type='text/javascript',body=(base/'js/panel-workspace-ui.js').read_text())
   if path.endswith('panel-workspace.css'):return r.fulfill(content_type='text/css',body=(base/'css/panel-workspace.css').read_text())
   if path=='/api/workspace-ui':return r.fulfill(content_type='application/json',body=json.dumps({'folders':[],'sessions':{},'favorites':[],'identity':{'user_name':'Vector','user_avatar':'👤','assistant_name':'Hermes','assistant_avatar':'🤖'},'voice':{'engine':'windows','fallback':True}}))
   if '/api/' in path:return r.fulfill(content_type='application/json',body='{}')
   return r.continue_()
  page.route('**/*',route)
  errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  page.goto('http://127.0.0.1:8650/',wait_until='domcontentloaded');page.wait_for_timeout(1000)
  page.evaluate('''() => {
    var b=document.getElementById('chatBody');
    b.innerHTML=Array.from({length:55},(_,i)=>'<div class="msg assistant" style="flex-shrink:0"><div class="msg-bubble"><div class="md-text">第 '+i+' 条历史消息<br>这里是供阅读的内容。<br>继续查看会话记录。</div></div></div>').join('')+msgHTML({role:'assistant',content:'正在回答',tools:[{tool:'terminal',status:'completed',toolCallId:'a',label:'验证命令',result:Array(35).fill('工具输出内容').join('\\n')}],ts:Date.now()});
    scrollChatToBottom();
  }''');page.wait_for_timeout(200)
  def state():return page.evaluate('''() => {var b=document.getElementById('chatBody');return {follow:autoScrollActive(),top:b.scrollTop,gap:b.scrollHeight-b.clientHeight-b.scrollTop,button:!document.getElementById('chatJumpBottom').hidden}}''')
  assert state()['gap']<=6 and state()['follow'],state()
  assert page.locator('#autoScrollBtn').count()==0
  r=page.locator('#chatBody').bounding_box();page.mouse.move(r['x']+r['width']/2,r['y']+r['height']/2)
  page.mouse.wheel(0,-450);page.wait_for_timeout(180)
  assert not state()['follow'] and not state()['button'],state()
  top=state()['top']
  page.evaluate("document.querySelector('#chatBody .msg:last-child .msg-bubble > p').append(document.createTextNode(' 新内容'.repeat(100)));followChatBottom()")
  page.wait_for_timeout(250);assert abs(state()['top']-top)<3,state()
  page.mouse.wheel(0,-2000);page.wait_for_timeout(200)
  for i in range(5):page.mouse.wheel(0,65);page.wait_for_timeout(95)
  assert state()['button'],state()
  page.screenshot(path=f'/vol1/@apphome/hermes-agent/data/tmp/scroll-floating-{w}.png')
  page.wait_for_timeout(850);assert not state()['button'] and not state()['follow'],state()
  for i in range(5):page.mouse.wheel(0,65);page.wait_for_timeout(95)
  page.locator('#chatJumpBottom').click();page.wait_for_timeout(150)
  assert state()['follow'] and state()['gap']<=6 and not state()['button'],state()
  # Expand tools while at bottom: retain the user's reading position.
  page.locator('#chatBody .tool-summary').last.click();page.wait_for_timeout(150)
  page.locator('#chatBody .tool-head').last.click();page.wait_for_timeout(150)
  assert not state()['follow'],state()
  tooltop=state()['top']
  page.evaluate("document.querySelector('#chatBody .msg:last-child .msg-bubble > p').append(document.createTextNode(' 更新'.repeat(10)))")
  page.wait_for_timeout(150);assert abs(state()['top']-tooltop)<3,state()
  # Scroll at the actual chat bottom with tool details still expanded.
  page.mouse.move(r['x']+15,r['y']+r['height']/2);page.mouse.wheel(0,30000);page.wait_for_timeout(200)
  assert state()['follow'] and state()['gap']<=6,state()
  page.evaluate("document.querySelector('#chatBody .msg:last-child .msg-bubble > p').append(document.createTextNode(' 继续生成'.repeat(80)))")
  page.wait_for_timeout(200);assert state()['gap']<=6,state()
  # Collapse while following also remains at bottom.
  page.evaluate("document.querySelector('#chatBody .tool-summary').click()")
  page.wait_for_timeout(200);assert state()['follow'] and state()['gap']<=6,state()
  # Nested scrollable tool output must not toggle main follow state.
  page.evaluate("""() => {var b=document.getElementById('chatBody');var el=document.createElement('div');el.id='nestedScrollTest';el.style.cssText='height:90px;overflow:auto;flex-shrink:0';el.innerHTML='<div style="height:500px">内部工具输出</div>';b.appendChild(el);scrollChatToBottom();el.scrollTop=180;}""")
  page.wait_for_timeout(150);nested=page.locator('#nestedScrollTest').bounding_box()
  page.mouse.move(nested['x']+20,nested['y']+35);page.mouse.wheel(0,-50);page.wait_for_timeout(180)
  assert state()['follow'],state()
  # A delayed image/layout expansion follows only when following was already enabled.
  page.evaluate("document.querySelector('#nestedScrollTest').style.height='200px'")
  page.wait_for_timeout(180);assert state()['gap']<=6,state()
  # Real mobile touch drag, not a synthetic scroll event.
  cdp=page.context.new_cdp_session(page)
  x=r['x']+25;y=r['y']+max(25,r['height']*0.25)
  cdp.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{'x':x,'y':y}]})
  for step in range(1,5):
   cdp.send('Input.dispatchTouchEvent',{'type':'touchMove','touchPoints':[{'x':x,'y':y+step*20}]});page.wait_for_timeout(35)
  cdp.send('Input.dispatchTouchEvent',{'type':'touchEnd','touchPoints':[]});page.wait_for_timeout(200)
  assert not state()['follow'],state()
  page.evaluate('scrollChatToBottom()');page.wait_for_timeout(150)
  assert state()['follow'] and state()['gap']<=6,state()
  # Keyboard browsing and manual return to the actual bottom.
  page.locator('#chatBody').focus();page.keyboard.press('PageUp');page.wait_for_timeout(200)
  assert not state()['follow'],state()
  page.keyboard.press('End');page.wait_for_timeout(250)
  assert state()['follow'] and state()['gap']<=6,state()
  # Slow history refresh must use the position at response time, not at request time.
  page.evaluate("""() => {
    window.__savedFetch=window.fetch;currentSession='scroll-test';
    window.fetch=function(){return new Promise(resolve=>{window.__resolveHistory=resolve;});};
    loadSessionMessages('scroll-test',false,true);
  }""")
  page.mouse.move(r['x']+15,r['y']+r['height']/2);page.mouse.wheel(0,-650);page.wait_for_timeout(200)
  reading=state()['top'];assert not state()['follow'],state()
  page.evaluate("""() => {window.fetch=window.__savedFetch;window.__resolveHistory({ok:true,json:()=>Promise.resolve({messages:Array.from({length:80},(_,i)=>({role:i%2?'assistant':'user',content:'历史 '+i+'\\n这一段用于检查读取位置。\\n继续阅读',ts:Date.now()}))})});}""")
  page.wait_for_timeout(300)
  assert not state()['follow'] and abs(state()['top']-reading)<3,(state(),reading)
  assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'horizontal overflow'
  assert not errors,errors
  print(json.dumps({'viewport':f'{w}x{h}','pass':True,'state':state(),'errors':errors},ensure_ascii=False),flush=True)
  page.close()
 browser.close()
