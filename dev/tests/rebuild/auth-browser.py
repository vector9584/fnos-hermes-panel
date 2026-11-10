import json,os,signal,subprocess,tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright
from preview_process import preview_launcher, read_startup_line
ROOT=Path(__file__).resolve().parent
state=Path(tempfile.mkdtemp(prefix='hermes-auth-preview-',dir='/tmp'));state.chmod(0o777);(state/'native-home/cron').mkdir(parents=True);(state/'native-home/cron/jobs.json').write_text('{"jobs":[]}')
env={**os.environ,'HOME':str(state),'PREVIEW_STATE_ROOT':str(state),'PREVIEW_PORT':'0','PREVIEW_AUTH':'1','TEST_PYTHON':'/vol1/@apphome/hermes-agent/data/venv/bin/python3','PYTHONDONTWRITEBYTECODE':'1'}
os.environ['PLAYWRIGHT_BROWSERS_PATH']='/vol1/@apphome/hermes-agent/data/.cache/ms-playwright'
node='/vol1/@apphome/hermes-agent/data/node/bin/node';cmd=preview_launcher()+['env']+[f'{key}={env[key]}' for key in ('HOME','PREVIEW_STATE_ROOT','PREVIEW_PORT','PREVIEW_AUTH','TEST_PYTHON','PYTHONDONTWRITEBYTECODE')]+[node,str(ROOT/'preview-server.mjs')]
server=subprocess.Popen(cmd,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
shots=Path(tempfile.mkdtemp(prefix='hermes-auth-evidence-',dir='/tmp'));shots.chmod(0o777);results=[]
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
   trusted=browser.new_context(viewport={'width':width,'height':height});page=trusted.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   trusted.route('**/*',lambda route:route.continue_(url=route.request.url.replace('/app/hermes-agent/','/'),headers={**route.request.headers,'x-fixture-unix':'1'}) if route.request.url.startswith(url) else route.abort())
   page.goto(url,wait_until='domcontentloaded');page.wait_for_function("monitorToken.length===43");page.evaluate("switchPage('settings')")
   page.locator('.panel-devices').get_by_text('已同步',exact=False).wait_for();page.locator('.panel-devices').get_by_role('button',name='生成一次性授权码').click();code=page.locator('.panel-devices input');code.wait_for();pairing=code.input_value()
   page.screenshot(path=str(shots/f'devices-{width}.png'))
   direct=browser.new_context(viewport={'width':width,'height':height});login=direct.new_page();login.on('pageerror',lambda e:errors.append(str(e)))
   direct.route('**/*',lambda route:route.continue_(url=route.request.url.replace('/app/hermes-agent/','/')) if route.request.url.startswith(url) else route.abort())
   login.goto(url,wait_until='domcontentloaded');assert login.get_by_role('heading',name='授权此设备').is_visible()
   assert direct.request.get(url+'/api/sessions').status==401;assert 'token' not in direct.request.get(url+'/api/health').json()
   login.get_by_role('textbox',name='设备名称').fill('手机验收 '+str(width));login.get_by_role('textbox',name='一次性授权码').fill(pairing)
   login.screenshot(path=str(shots/f'pair-{width}.png'));login.get_by_role('button',name='连接面板').click();login.wait_for_function("typeof monitorToken==='string'&&monitorToken.length===43")
   login.reload(wait_until='domcontentloaded');login.wait_for_function("monitorToken.length===43");assert direct.request.get(url+'/api/sessions').status==200
   page.locator('.panel-devices').get_by_role('button',name='刷新设备',exact=True).click();row=page.locator('.panel-device-row').filter(has_text='手机验收 '+str(width));row.wait_for();page.once('dialog',lambda d:d.accept());row.get_by_role('button',name='撤销授权').click();row.wait_for(state='detached')
   assert direct.request.get(url+'/api/sessions').status==401
   assert not errors,errors;assert page.evaluate('document.documentElement.scrollWidth<=innerWidth');assert login.evaluate('document.documentElement.scrollWidth<=innerWidth')
   results.append({'viewport':[width,height],'trusted_bootstrap':True,'standalone_pair':True,'reload':True,'revocation':True,'errors':errors});trusted.close();direct.close()
  browser.close()
 (shots/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2));print(json.dumps(results,ensure_ascii=False),flush=True)
finally:
 stop_server()
