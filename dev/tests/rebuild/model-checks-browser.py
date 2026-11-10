"""Persisted model validation controls with local simulated responses, no external calls."""
import os,json,signal,subprocess,tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright
from preview_process import preview_launcher, read_startup_line
ROOT=Path(__file__).resolve().parent
state=Path(tempfile.mkdtemp(prefix='hermes-model-check-preview-',dir='/tmp'));state.chmod(0o777)
(state/'native-home/cron').mkdir(parents=True);(state/'native-home/cron/jobs.json').write_text('{"jobs":[]}');(state/'native-home/config.yaml').write_text('auxiliary: {}\n')
env={**os.environ,'HOME':str(state),'PREVIEW_STATE_ROOT':str(state),'PREVIEW_PORT':'0','TEST_PYTHON':'/vol1/@apphome/hermes-agent/data/venv/bin/python3','PYTHONDONTWRITEBYTECODE':'1'}
os.environ['PLAYWRIGHT_BROWSERS_PATH']='/vol1/@apphome/hermes-agent/data/.cache/ms-playwright'
node='/vol1/@apphome/hermes-agent/data/node/bin/node';cmd=preview_launcher()+['env']+[f'{key}={env[key]}' for key in ('HOME','PREVIEW_STATE_ROOT','PREVIEW_PORT','TEST_PYTHON','PYTHONDONTWRITEBYTECODE')]+[node,str(ROOT/'preview-server.mjs')]
server=subprocess.Popen(cmd,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
shots=Path(tempfile.mkdtemp(prefix='hermes-model-checks-evidence-',dir='/tmp'));shots.chmod(0o777);results=[]
def stop_server():
 try: os.killpg(server.pid,signal.SIGTERM)
 except ProcessLookupError: pass
 try: server.wait(timeout=5)
 except subprocess.TimeoutExpired:
  try: os.killpg(server.pid,signal.SIGKILL)
  except ProcessLookupError: pass
  try: server.wait(timeout=5)
  except subprocess.TimeoutExpired: pass
 else:
  try: os.killpg(server.pid,signal.SIGKILL)
  except ProcessLookupError: pass
try:
 first=read_startup_line(server)
 if not first: raise RuntimeError('预览服务没有启动：'+(server.stderr.read().strip() or '没有启动输出'))
 port=int(json.loads(first)['port']);url='http://127.0.0.1:'+str(port);print(first,flush=True)
 with sync_playwright() as p:
  browser=p.chromium.launch(args=['--no-sandbox'])
  for width,height in [(1440,900),(390,844),(844,390)]:
   context=browser.new_context(viewport={'width':width,'height':height});headers={'X-Monitor-Token':'fixture-token'}
   context.route('**/*',lambda r:r.continue_(url=r.request.url.replace('/app/hermes-agent/','/')) if r.request.url.startswith(url) else r.abort())
   page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   page.goto(url,wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'");page.evaluate("switchPage('models');loadModelChecks()")
   page.wait_for_function("document.getElementById('modelChecksTarget').options.length===2")
   assert page.locator('#modelSmokeBox').count()==0
   target=page.locator('#modelChecksTarget');target.select_option(label='服务乙 / same-model')
   form=page.locator('#modelChecksForm');before=len(context.request.get(url+'/__fixture/stats').json().get('model_probes',[]))
   form.get_by_role('button',name='验证响应',exact=True).click()
   page.wait_for_function("document.querySelector('#modelChecksList').textContent.includes('正在验证')")
   assert form.get_by_role('button',name='验证响应',exact=True).is_disabled()
   page.reload(wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'");page.evaluate("switchPage('models');loadModelChecks()")
   page.wait_for_function("document.querySelector('.model-check-record')?.textContent.includes('已收到回复')")
   assert json.loads(page.locator('#modelChecksTarget').input_value())['provider']=='fixture-b'
   probes=context.request.get(url+'/__fixture/stats').json()['model_probes'];assert len(probes)==before+1 and probes[-1]['provider']=='fixture-b'
   record=page.locator('.model-check-record').first
   if not record.evaluate('(n)=>n.open'):record.locator('summary').click()
   assert 'HERMES_OK' in record.inner_text()
   # Failure must remain visible after reload and must not be counted as a pass.
   context.request.post(url+'/__fixture/model-failure',data={'fail':True})
   form.get_by_role('button',name='验证响应',exact=True).click()
   page.wait_for_function("document.querySelector('.model-check-record')?.textContent.includes('验证失败')")
   record=page.locator('.model-check-record').first
   if not record.evaluate('(n)=>n.open'):record.locator('summary').click()
   assert '401' in record.inner_text()
   context.request.post(url+'/__fixture/model-failure',data={'fail':False})
   # Cancellation remains available at phone and landscape sizes.
   form.get_by_role('button',name='验证响应',exact=True).click()
   page.get_by_role('button',name='取消验证',exact=True).click()
   page.wait_for_function("document.querySelector('.model-check-record')?.textContent.includes('已取消')")
   assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
   assert '验证失败' not in page.locator('.model-check-record').first.inner_text()
   page.locator('#modelChecksTarget').scroll_into_view_if_needed()
   page.screenshot(path=str(shots/f'model-checks-{width}.png'))
   assert not errors,errors
   results.append({'viewport':[width,height],'provider_identity':True,'reload_single_execution':True,'selection_restored':True,'failure_visible':True,'cancelled':True,'layout':True,'errors':errors})
   print(json.dumps(results[-1],ensure_ascii=False),flush=True);context.close()
  browser.close()
 (shots/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
finally:
 stop_server()
