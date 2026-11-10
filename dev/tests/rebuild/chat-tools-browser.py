"""Streaming tool history survives DOM replacement and cancellation."""
import os,json,signal,subprocess,tempfile,time
from pathlib import Path
from playwright.sync_api import sync_playwright
from preview_process import preview_launcher, read_startup_line
ROOT=Path(__file__).resolve().parent
state=Path(tempfile.mkdtemp(prefix='hermes-chat-tools-',dir='/tmp'));state.chmod(0o777);(state/'native-home/cron').mkdir(parents=True);(state/'native-home/cron/jobs.json').write_text('{"jobs":[]}');(state/'native-home/config.yaml').write_text('auxiliary: {}\n')
env={**os.environ,'HOME':str(state),'PREVIEW_STATE_ROOT':str(state),'PREVIEW_PORT':'0','TEST_PYTHON':'/vol1/@apphome/hermes-agent/data/venv/bin/python3','PYTHONDONTWRITEBYTECODE':'1'}
os.environ['PLAYWRIGHT_BROWSERS_PATH']='/vol1/@apphome/hermes-agent/data/.cache/ms-playwright'
node='/vol1/@apphome/hermes-agent/data/node/bin/node';cmd=preview_launcher()+['env']+[f'{key}={env[key]}' for key in ('HOME','PREVIEW_STATE_ROOT','PREVIEW_PORT','TEST_PYTHON','PYTHONDONTWRITEBYTECODE')]+[node,str(ROOT/'preview-server.mjs')]
server=subprocess.Popen(cmd,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
try:
 first=read_startup_line(server)
 if not first: raise RuntimeError('预览服务没有启动：'+(server.stderr.read().strip() or '没有启动输出'))
 port=int(json.loads(first)['port']);url='http://127.0.0.1:'+str(port);print(first,flush=True)
 with sync_playwright() as p:
  browser=p.chromium.launch(args=['--no-sandbox'])
  for width,height in [(1440,900),(390,844),(844,390)]:
   context=browser.new_context(viewport={'width':width,'height':height},accept_downloads=True);context.add_init_script("localStorage.setItem('panel-tools-mode','collapsed')");headers={'X-Monitor-Token':'fixture-token'}
   context.route('**/*',lambda r:r.continue_(url=r.request.url.replace('/app/hermes-agent/','/')) if r.request.url.startswith(url) else r.abort())
   page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   page.goto(url,wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'")
   page.evaluate("currentSession='test-a';_openTabs=['test-a','test-b'];persistTabs();renderSessionTabs();restoreDraft('test-a');loadSessionMessages('test-a')")
   text='中断工具验收 '+str(width);page.locator('#chatInput').fill(text);page.evaluate('sendChat()')
   page.wait_for_function("document.querySelector('#chatBody .durable-tools .tool-call')")
   page.wait_for_function("document.querySelectorAll('#chatBody .durable-tools .tool-call').length>=2")
   jobs=context.request.get(url+'/api/chat/queue',headers=headers).json()['jobs'];job=next(j for j in jobs if j['session_id']=='test-a' and j['status']=='running');jid=job['id']
   # Replace the rendered stream with authoritative history while this turn runs.
   page.evaluate("loadSessionMessages('test-a',false,true)")
   page.wait_for_timeout(400)
   node=page.locator('.msg.assistant[data-request-id="'+jid+'"]');assert node.locator('.tool-call').count()==2,'tool disappeared after history replaced a streaming node'
   page.evaluate("switchTab('test-b')");page.wait_for_timeout(150);assert text not in page.locator('#chatBody').inner_text()
   page.evaluate("switchTab('test-a')");page.wait_for_timeout(400);assert node.locator('.tool-call').count()==2,'tool disappeared after switching back'
   context.request.post(url+'/api/chat/queue/'+jid+'/cancel',headers=headers,data={})
   deadline=time.monotonic()+10
   while time.monotonic()<deadline:
    final=context.request.get(url+'/api/chat/queue/'+jid,headers=headers).json()
    if final['status']=='cancelled':break
    page.wait_for_timeout(100)
   assert final['status']=='cancelled';assert final['result']['tools'][0]['result']=='fixture verified'
   saved=context.request.get(url+'/api/sessions/test-a',headers=headers).json()['messages'];saved_turn=next(m for m in saved if m.get('role')=='assistant' and m.get('request_id')==jid)
   assert saved_turn['tools'][0]['status']=='completed' and saved_turn['tools'][1]['status']=='interrupted'
   page.reload(wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'");page.evaluate("currentSession='test-a';restoreDraft('test-a');loadSessionMessages('test-a')")
   page.wait_for_function("document.querySelectorAll('.msg.assistant[data-request-id="+json.dumps(jid)+"] .tool-call').length===2");assert node.locator('.tool-call').count()==2
   node.locator('.tool-summary').click()
   cards=node.locator('.tool-call');assert cards.count()==2
   assert cards.nth(0).locator('.tool-status').inner_text()=='已完成'
   assert cards.nth(1).locator('.tool-status').inner_text()=='已中断'
   # A late failed request from the previous session cannot erase the new one.
   held=[]
   def hold_old(route):held.append(route)
   page.route('**/api/sessions/test-a',hold_old)
   page.evaluate("void loadSessionMessages('test-a',false,true)")
   deadline=time.monotonic()+5
   while not held and time.monotonic()<deadline:page.wait_for_timeout(50)
   assert held
   page.evaluate("switchTab('test-b')");page.wait_for_timeout(250);other=page.locator('#chatBody').inner_html()
   for route in held:route.fulfill(status=503,json={'error':'isolated old-session failure'})
   page.wait_for_timeout(200);assert page.locator('#chatBody').inner_html()==other,'late old-session failure replaced current conversation'
   page.unroute('**/api/sessions/test-a',hold_old)
   assert not errors,errors
   print(json.dumps({'viewport':[width,height],'history_reload_retains_tools':True,'tab_switch_retains_tools':True,'completed_tool_retained':True,'running_tool_marked_interrupted':True,'cancel_reload_retains_tools':True,'late_session_failure_isolated':True,'errors':errors}),flush=True)
   context.close()
  browser.close()
finally:
 if server.poll() is None:
  try: os.killpg(server.pid,signal.SIGTERM);server.wait(timeout=8)
  except (ProcessLookupError,subprocess.TimeoutExpired):
   try: os.killpg(server.pid,signal.SIGKILL)
   except ProcessLookupError: pass
   server.wait(timeout=8)
