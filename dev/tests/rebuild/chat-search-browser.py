"""Global conversation search returns a result that opens and highlights its source message."""
import json, os, signal, subprocess, tempfile, time
from pathlib import Path
from playwright.sync_api import sync_playwright
from preview_process import preview_launcher, read_startup_line

ROOT = Path(__file__).resolve().parent
state = Path(tempfile.mkdtemp(prefix='hermes-chat-search-', dir='/tmp')); state.chmod(0o777)
(state/'native-home/cron').mkdir(parents=True); (state/'native-home/cron/jobs.json').write_text('{"jobs":[]}'); (state/'native-home/config.yaml').write_text('auxiliary: {}\n')
env = {**os.environ, 'HOME': str(state), 'PREVIEW_STATE_ROOT': str(state), 'PREVIEW_PORT': '0', 'TEST_PYTHON':'/vol1/@apphome/hermes-agent/data/venv/bin/python3', 'PYTHONDONTWRITEBYTECODE':'1'}
os.environ['PLAYWRIGHT_BROWSERS_PATH']='/vol1/@apphome/hermes-agent/data/.cache/ms-playwright'
node='/vol1/@apphome/hermes-agent/data/node/bin/node';cmd=preview_launcher()+['env']+[f'{k}={env[k]}' for k in ('HOME','PREVIEW_STATE_ROOT','PREVIEW_PORT','TEST_PYTHON','PYTHONDONTWRITEBYTECODE')]+[node,str(ROOT/'preview-server.mjs')]
server=subprocess.Popen(cmd,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
try:
 first=read_startup_line(server)
 if not first: raise RuntimeError('预览服务没有启动：'+(server.stderr.read().strip() or '没有启动输出'))
 url='http://127.0.0.1:'+str(json.loads(first)['port']);print(first,flush=True)
 with sync_playwright() as p:
  browser=p.chromium.launch(args=['--no-sandbox'])
  for width,height in [(1440,900),(390,844),(844,390)]:
   context=browser.new_context(viewport={'width':width,'height':height});headers={'X-Monitor-Token':'fixture-token'}
   context.route('**/*',lambda r:r.continue_(url=r.request.url.replace('/app/hermes-agent/','/')) if r.request.url.startswith(url) else r.abort())
   page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)));page.goto(url,wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'")
   page.evaluate("currentSession='test-a';_openTabs=['test-a'];persistTabs();renderSessionTabs();loadSessionMessages('test-a')")
   phrase='全局搜索锚点验收-'+str(width);page.locator('#chatInput').fill(phrase);page.evaluate('sendChat()')
   deadline=time.monotonic()+12
   while time.monotonic()<deadline:
    jobs=context.request.get(url+'/api/chat/queue?all=1',headers=headers).json()['jobs'];job=next((j for j in jobs if j['session_id']=='test-a' and phrase in str(j.get('message'))),None)
    if job and job['status']=='done':break
    page.wait_for_timeout(100)
   assert job and job['status']=='done',job
   page.evaluate("loadSessionMessages('test-a')")
   page.wait_for_function("document.querySelector('#chatBody').innerText.includes("+json.dumps(phrase)+")")
   page.evaluate("pwSearch("+json.dumps(phrase)+")")
   overlay=page.locator('#pwOverlay');overlay.wait_for();page.wait_for_timeout(1000);status=page.locator('#pwSearchStatus').inner_text();assert '找到 2 条结果' in status,{'status':status,'overlay':overlay.inner_text()}
   result=overlay.locator('[data-hit]').filter(has_text=phrase).last;assert result.count()==1 and '维护讨论' in result.inner_text()
   result.click();page.wait_for_function("currentSession==='test-a' && document.querySelector('#chatBody .pw-hit')")
   hit=page.locator('#chatBody .pw-hit');assert phrase in hit.inner_text();assert hit.get_attribute('data-message-index') is not None
   assert not errors,errors
   print(json.dumps({'viewport':[width,height],'full_text_search':True,'result_has_source_title':True,'jumped_to_message_anchor':True,'highlighted_exact_source':True,'errors':errors},ensure_ascii=False),flush=True);context.close()
  browser.close()
finally:
 if server.poll() is None:
  try: os.killpg(server.pid,signal.SIGTERM);server.wait(timeout=8)
  except (ProcessLookupError,subprocess.TimeoutExpired):
   try: os.killpg(server.pid,signal.SIGKILL)
   except ProcessLookupError: pass
   server.wait(timeout=8)
