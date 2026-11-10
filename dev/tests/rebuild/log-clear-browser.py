"""Verify destructive log clear confirmation and truthful partial-failure feedback."""
import json,os,signal,subprocess,tempfile,pwd,shlex,sys
import time
from pathlib import Path
from playwright.sync_api import sync_playwright
from preview_process import preview_launcher, read_startup_line

ROOT=Path(__file__).resolve().parents[3]
def wait_fixture(url, predicate, timeout=5):
 deadline=time.monotonic()+timeout
 latest=None
 while time.monotonic()<deadline:
  latest=page.request.get(url+'/__fixture/stats').json()
  if predicate(latest):return latest
  time.sleep(.05)
 raise AssertionError('fixture state did not converge: '+repr(latest))
state=Path(tempfile.mkdtemp(prefix='hermes-log-clear-',dir='/tmp'));state.chmod(0o777)
(state/'native-home/cron').mkdir(parents=True);(state/'native-home/cron/jobs.json').write_text('{"jobs":[]}')
env={**os.environ,'HOME':str(state),'PREVIEW_STATE_ROOT':str(state),'PREVIEW_PORT':'0','TEST_PYTHON':os.environ.get('HERMES_TEST_PYTHON','/vol1/@apphome/hermes-agent/data/venv/bin/python3'),'PYTHONDONTWRITEBYTECODE':'1'}
node=os.environ.get('HERMES_PREVIEW_NODE','/vol1/@apphome/hermes-agent/data/node/bin/node')
cmd=preview_launcher()+['env']+[f'{key}={env[key]}' for key in ('HOME','PREVIEW_STATE_ROOT','PREVIEW_PORT','TEST_PYTHON','PYTHONDONTWRITEBYTECODE')]+[node,str(ROOT/'dev/tests/rebuild/preview-server.mjs')]
server=subprocess.Popen(cmd,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
try:
 first=read_startup_line(server)
 url='http://127.0.0.1:'+str(json.loads(first)['port']);results=[]
 with sync_playwright() as playwright:
  browser=playwright.chromium.launch(args=['--no-sandbox'])
  for width,height in [(1440,900),(390,844),(844,390)]:
   context=browser.new_context(viewport={'width':width,'height':height});page=context.new_page();errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
   context.request.post(url+'/__fixture/log-reset',data={})
   context.route('**/*',lambda route:route.continue_(url=route.request.url.replace('/app/hermes-agent/','/')) if route.request.url.startswith(url) else route.abort())
   page.goto(url,wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'")
   baseline_stats=page.request.get(url+'/__fixture/stats').json();baseline=len(baseline_stats.get('logClears') or []);restore_baseline=len(baseline_stats.get('logRestores') or [])
   page.evaluate("_logInited=true;switchPage('overview');_logState.source='monitor'")
   with page.expect_response(lambda response: '/api/logs/read?file=hermes.log' in response.url):
    page.evaluate('fetchLogLines()')
   page.locator('#logPre').filter(has_text='fixture').wait_for()
   dialogs=[];page.once('dialog',lambda dialog:(dialogs.append(dialog.message),dialog.dismiss()))
   page.get_by_role('button',name='清除',exact=True).click()
   assert dialogs and '成功后可在日志栏撤销' in dialogs[0]
   assert (page.request.get(url+'/__fixture/stats').json().get('logClears') or [])[baseline:]==[]
   page.locator('#logPre').filter(has_text='fixture').wait_for(timeout=5000)
   page.once('dialog',lambda dialog:dialog.accept())
   page.get_by_role('button',name='清除',exact=True).click()
   page.locator('#logUndoBtn').wait_for(state='visible')
   cleared=wait_fixture(url,lambda value:len(value.get('logClears') or [])==baseline+1)['logClears'];assert cleared[baseline:]==['hermes.log'],cleared
   page.locator('#logUndoBtn').click();restored=wait_fixture(url,lambda value:len(value.get('logRestores') or [])==restore_baseline+1);assert restored['logRestores'][restore_baseline:]==['hermes.log'];page.wait_for_function("document.getElementById('logUndoBtn').hidden",timeout=5000)
   assert page.request.get(url+'/__fixture/stats').json()['logRestores']==['hermes.log']
   page.evaluate("_logState.source='all'")
   page.request.post(url+'/__fixture/log-failure',data={'file':'hermes.log'})
   page.once('dialog',lambda dialog:dialog.accept())
   page.get_by_role('button',name='清除',exact=True).click()
   page.locator('#__toast').get_by_text('清空失败 1/8 个文件',exact=False).wait_for()
   page.locator('#logPre').filter(has_text='fixture').wait_for()
   partial=wait_fixture(url,lambda value:len(value.get('logClears') or [])>=baseline+9)['logClears']
   assert len(partial)==baseline+9 and partial[-8:].count('hermes.log')==1,partial
   page.locator('#logUndoBtn').click();page.locator('#logPre').get_by_text('INFO fixture',exact=False).wait_for();page.locator('#logUndoBtn').wait_for(state='hidden')
   assert not errors,errors
   page.request.post(url+'/__fixture/log-failure',data={'file':'hermes.log','mode':'partial'})
   page.evaluate("_logState.source='monitor'")
   with page.expect_response(lambda response: '/api/logs/read?file=hermes.log' in response.url):
    page.evaluate('fetchLogLines()')
   page.once('dialog',lambda dialog:dialog.accept())
   page.get_by_role('button',name='清除',exact=True).click()
   page.locator('#__toast').get_by_text('内容可能已改变，撤销项已保留',exact=False).wait_for()
   page.locator('#logUndoBtn').get_by_text('撤销清空 (1)',exact=True).wait_for()
   page.locator('#logPre').get_by_text('partial',exact=False).wait_for()
   page.locator('#logUndoBtn').click()
   page.locator('#__toast').get_by_text('恢复失败',exact=False).wait_for()
   page.locator('#logUndoBtn').get_by_text('撤销清空 (1)',exact=True).wait_for()
   assert not errors,errors
   results.append({'viewport':[width,height],'cancel_preserves_logs':True,'success_undo_restores_original_content':True,'partial_failure_identifies_failed_file_and_refetches':True,'partial_success_undo_restores':True,'truncate_then_error_keeps_snapshot_visible':True,'uncertain_restore_refuses_to_overwrite_current_log':True,'errors':errors})
   context.close()
  browser.close()
 print(json.dumps(results,ensure_ascii=False),flush=True)
finally:
 try:os.killpg(server.pid,signal.SIGTERM)
 except ProcessLookupError:pass
 try:server.wait(timeout=5)
 except subprocess.TimeoutExpired:
  try:os.killpg(server.pid,signal.SIGKILL)
  except ProcessLookupError:pass
  server.wait(timeout=5)
