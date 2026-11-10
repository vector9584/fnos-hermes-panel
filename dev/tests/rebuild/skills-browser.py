"""Verify local skills show truthful load state and native-only controls stay hidden."""
import json,os,signal,subprocess,tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright
from preview_process import preview_launcher, read_startup_line

ROOT=Path(__file__).resolve().parent
state=Path(tempfile.mkdtemp(prefix='hermes-skills-ui-',dir='/tmp'));state.chmod(0o777)
(state/'native-home/cron').mkdir(parents=True);(state/'native-home/cron/jobs.json').write_text('{"jobs":[]}');(state/'native-home/config.yaml').write_text('auxiliary: {}\n')
env={**os.environ,'HOME':str(state),'PREVIEW_STATE_ROOT':str(state),'PREVIEW_PORT':'0','TEST_PYTHON':'/vol1/@apphome/hermes-agent/data/venv/bin/python3','PYTHONDONTWRITEBYTECODE':'1'}
os.environ['PLAYWRIGHT_BROWSERS_PATH']='/vol1/@apphome/hermes-agent/data/.cache/ms-playwright'
node='/vol1/@apphome/hermes-agent/data/node/bin/node'
cmd=preview_launcher()+['env']+[f'{key}={env[key]}' for key in ('HOME','PREVIEW_STATE_ROOT','PREVIEW_PORT','TEST_PYTHON','PYTHONDONTWRITEBYTECODE')]+[node,str(ROOT/'preview-server.mjs')]
server=subprocess.Popen(cmd,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
try:
 first=read_startup_line(server)
 if not first:
  raise RuntimeError('预览服务没有启动：'+(server.stderr.read().strip() or '没有启动输出'))
 url='http://127.0.0.1:'+str(json.loads(first)['port']);print(first,flush=True)
 with sync_playwright() as p:
  browser=p.chromium.launch(args=['--no-sandbox']);context=browser.new_context(viewport={'width':1440,'height':900});errors=[];writes=[]
  def route_request(route):
   if route.request.url.endswith('/api/extensions/skills/local'):
    return route.fulfill(status=200,content_type='application/json',body=json.dumps({'ok':True,'skills':[{'name':'fixture-local','origin':'dir','enabled':False,'description':'目录技能'}]}))
   if route.request.url.endswith('/proxy/dashboard/api/skills/config'):
    writes.append(json.loads(route.request.post_data or '{}'))
    return route.fulfill(status=200,content_type='application/json',body='{"ok":true}')
   if route.request.url.startswith(url):
    return route.continue_(url=route.request.url.replace('/app/hermes-agent/','/'))
   return route.abort()
  context.route('**/*',route_request)
  page=context.new_page();page.on('pageerror',lambda error:errors.append(str(error)));page.goto(url,wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'")
  page.evaluate("switchPage('extensions'); extSwitchTab(document.querySelector('#extTabs .ch-filter:nth-child(2)'),'skills'); extSkillSubtab(document.querySelector('#ext-skills .skill-subtabs .ch-filter'),'local')")
  page.wait_for_function("document.querySelector('#page-extensions').classList.contains('active') && document.querySelector('#ext-skills').classList.contains('active')")
  card=page.locator('#skillGrid .ext-card');card.wait_for()
  assert card.inner_text().find('目录加载')>=0
  assert card.locator('button').count()==0
  assert card.get_by_role('button',name='启用').count()==0 and card.get_by_role('button',name='关闭').count()==0
  assert page.locator('#skillConfigModal').is_hidden()
  assert not writes
  assert not errors,errors
  print(json.dumps({'local_skill_false_toggles':True,'truthful_source_state':True,'native_config_modal_not_invoked':True,'errors':errors},ensure_ascii=False),flush=True)
  browser.close()
finally:
 try: os.killpg(server.pid,signal.SIGTERM)
 except ProcessLookupError: pass
 try: server.wait(timeout=8)
 except subprocess.TimeoutExpired:
  try: os.killpg(server.pid,signal.SIGKILL)
  except ProcessLookupError: pass
  server.wait(timeout=8)
