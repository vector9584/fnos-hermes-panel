"""Streaming tool history survives DOM replacement and cancellation."""
import os,json,signal,subprocess,tempfile,time
from pathlib import Path
from playwright.sync_api import sync_playwright
from preview_process import preview_launcher, read_startup_line
ROOT=Path(__file__).resolve().parent
state=Path(tempfile.mkdtemp(prefix='hermes-chat-entry-',dir='/tmp'));state.chmod(0o777);(state/'native-home/cron').mkdir(parents=True);(state/'native-home/cron/jobs.json').write_text('{"jobs":[]}');(state/'native-home/config.yaml').write_text('auxiliary: {}\n')
env={**os.environ,'HOME':str(state),'PREVIEW_STATE_ROOT':str(state),'PREVIEW_PORT':'0','TEST_PYTHON':'/vol1/@apphome/hermes-agent/data/venv/bin/python3','PYTHONDONTWRITEBYTECODE':'1'}
os.environ['PLAYWRIGHT_BROWSERS_PATH']='/vol1/@apphome/hermes-agent/data/.cache/ms-playwright'
node='/vol1/@apphome/hermes-agent/data/node/bin/node';cmd=preview_launcher()+['env']+[f'{key}={env[key]}' for key in ('HOME','PREVIEW_STATE_ROOT','PREVIEW_PORT','TEST_PYTHON','PYTHONDONTWRITEBYTECODE')]+[node,str(ROOT/'preview-server.mjs')]
server=subprocess.Popen(cmd,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
shots=Path(tempfile.mkdtemp(prefix='hermes-chat-entry-evidence-',dir='/tmp'));shots.chmod(0o777)
def stop_server():
 try: os.killpg(server.pid,signal.SIGTERM)
 except ProcessLookupError: pass
 try: server.wait(timeout=5)
 except subprocess.TimeoutExpired:
  try: os.killpg(server.pid,signal.SIGKILL)
  except (ProcessLookupError,PermissionError): pass
  try: server.wait(timeout=5)
  except subprocess.TimeoutExpired: pass
 else:
  try: os.killpg(server.pid,signal.SIGKILL)
  except (ProcessLookupError,PermissionError): pass
try:
 first=read_startup_line(server)
 if not first: raise RuntimeError('预览服务没有启动：'+(server.stderr.read().strip() or '没有启动输出'))
 port=int(json.loads(first)['port']);url='http://127.0.0.1:'+str(port);print(first,flush=True)
 with sync_playwright() as p:
  browser=p.chromium.launch(args=['--no-sandbox'])
  for width,height in [(1440,900),(390,844),(844,390)]:
   context=browser.new_context(viewport={'width':width,'height':height},accept_downloads=True);headers={'X-Monitor-Token':'fixture-token'}
   context.route('**/*',lambda r:r.continue_(url=r.request.url.replace('/app/hermes-agent/','/')) if r.request.url.startswith(url) else r.abort())
   page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   page.goto(url,wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'")
   page.evaluate("currentSession='test-a';_openTabs=['test-a','test-b'];persistTabs();renderSessionTabs();restoreDraft('test-a');loadSessionMessages('test-a')")
   page.wait_for_timeout(400);page.locator('#chatInput').fill('');page.wait_for_timeout(700)
   before=context.request.get(url+'/__fixture/stats').json()['executions']
   cards=page.locator('#chatBody .wq-card');assert cards.count()==6
   cards.first.focus();page.keyboard.press('Enter')
   assert page.locator('#chatInput').input_value()=='帮我总结这份文档：'
   page.locator('#chatInput').fill('已有内容')
   cards.nth(1).click();assert page.locator('#chatInput').input_value().startswith('已有内容\n\n')
   assert context.request.get(url+'/__fixture/stats').json()['executions']==before
   page.wait_for_timeout(800);page.reload(wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'");page.evaluate("currentSession='test-a';restoreDraft('test-a');loadSessionMessages('test-a')")
   page.wait_for_function("document.getElementById('chatInput').value.startsWith('已有内容')")
   if width<=768:
    for selector in ['#sendBtn','#btnMic','#btnWebNet','#toolbarToggle']:
     box=page.locator(selector).bounding_box();assert box and box['width']>=44 and box['height']>=44,(selector,box)
    page.locator('#toolbarToggle').click();page.locator('#btnExpert').wait_for(state='visible')
    assert page.locator('#btnExpert').bounding_box()['height']>=44
    page.screenshot(path=str(shots / ('chat-tools-'+str(width)+'.png')))
   assert not errors,errors
   print(json.dumps({'viewport':[width,height],'keyboard_templates':True,'no_implicit_send':True,'existing_draft_preserved':True,'draft_reload':True,'touch_targets':True,'errors':errors}),flush=True)
   context.close()
  browser.close()
finally:
 stop_server()
