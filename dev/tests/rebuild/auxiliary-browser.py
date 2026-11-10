"""Browser + real auxiliary subprocess; all configuration writes stay under /tmp."""
import os,json,signal,subprocess,tempfile,runpy
from pathlib import Path
from playwright.sync_api import sync_playwright
from preview_process import preview_launcher, read_startup_line
ROOT=Path(__file__).resolve().parent
fixture=runpy.run_path(str(ROOT/'auxiliary.test.py'))
state=Path(tempfile.mkdtemp(prefix='hermes-auxiliary-preview-',dir='/tmp'))
(state/'native-home/cron').mkdir(parents=True);(state/'native-home/cron/jobs.json').write_text('{"jobs":[]}')
config=state/'native-home/config.yaml';config.write_text(fixture['SOURCE'])
state.chmod(0o777)
for path in (state/'native-home',state/'native-home/cron'):
 path.chmod(0o777)
config.chmod(0o666)
env={**os.environ,'HOME':str(state),'PREVIEW_STATE_ROOT':str(state),'PREVIEW_PORT':'0','PYTHONDONTWRITEBYTECODE':'1','TEST_PYTHON':'/vol1/@apphome/hermes-agent/data/venv/bin/python3'}
os.environ['PLAYWRIGHT_BROWSERS_PATH']='/vol1/@apphome/hermes-agent/data/.cache/ms-playwright'
runenv=['env']+[f'{key}={env[key]}' for key in ('HOME','PREVIEW_STATE_ROOT','PREVIEW_PORT','PYTHONDONTWRITEBYTECODE','TEST_PYTHON')]
server=subprocess.Popen(preview_launcher()+runenv+['/vol1/@apphome/hermes-agent/data/node/bin/node',str(ROOT/'preview-server.mjs')],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
shots=Path(tempfile.mkdtemp(prefix='hermes-auxiliary-evidence-',dir='/tmp'));shots.chmod(0o777);results=[]
try:
 line=read_startup_line(server)
 if not line: raise RuntimeError('auxiliary preview failed: '+server.stderr.read())
 try: port=int(json.loads(line)['port'])
 except (ValueError,KeyError,TypeError,json.JSONDecodeError) as exc: raise RuntimeError(f'invalid startup line: {line!r}') from exc
 base=f'http://127.0.0.1:{port}'
 print(json.dumps({'port':port}),flush=True)
 with sync_playwright() as p:
  browser=p.chromium.launch(args=['--no-sandbox'])
  for width,height in [(1440,900),(390,844),(844,390)]:
   config.write_text(fixture['SOURCE'])
   context=browser.new_context(viewport={'width':width,'height':height});url=base;headers={'X-Monitor-Token':'fixture-token'}
   context.route('**/*',lambda r:r.continue_(url=r.request.url.replace('/app/hermes-agent/','/')) if r.request.url.startswith(url) else r.abort())
   page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   page.goto(url,wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'")
   page.evaluate("switchPage('models');loadAuxTasks()")
   page.wait_for_selector('.auxiliary-card[data-task=vision]')
   assert page.locator('.auxiliary-card[data-task=vision]').count()==1
   vision=page.locator('.auxiliary-card[data-task=vision]')
   vision.get_by_role('button',name='编辑配置').click();modal=page.locator('.auxiliary-dialog')
   # An unchanged form must preserve bytes, absent defaults and hidden nested fields.
   before=config.read_bytes();modal.get_by_role('button',name='保存配置',exact=True).click();modal.wait_for(state='detached')
   assert config.read_bytes()==before
   vision.get_by_role('button',name='编辑配置').click()
   modal.locator('[name=main-model]').fill('draft-vision')
   modal.get_by_role('button',name='关闭',exact=True).click()
   page.reload(wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'");page.evaluate("switchPage('models');loadAuxTasks()")
   page.locator('.auxiliary-card[data-task=vision]').get_by_role('button',name='编辑配置').click()
   assert modal.locator('[name=main-model]').input_value()=='draft-vision'
   # Another device changes same task; stale input stays visible and cannot overwrite it.
   task=next(t for t in context.request.get(url+'/api/panel-models/auxiliary',headers=headers).json()['tasks'] if t['key']=='vision')
   external=context.request.patch(url+'/api/panel-models/auxiliary',headers=headers,data={'key':'vision','revision':task['revision'],'changes':{'model':'external-model'}})
   assert external.ok, (external.status, external.text())
   modal.get_by_role('button',name='保存配置',exact=True).click()
   page.wait_for_function("document.querySelector('.auxiliary-feedback').textContent.includes('其他页面修改')")
   assert modal.locator('[name=main-model]').input_value()=='draft-vision'
   page.once('dialog',lambda d:d.accept());modal.get_by_role('button',name='丢弃草稿并读取最新',exact=True).click()
   page.wait_for_function("document.querySelector('[name=main-model]').value==='external-model'")
   # Remove + undo fallback. Then only changing model preserves private fallback details.
   modal.get_by_role('button',name='移除此回退',exact=True).click();assert modal.locator('.auxiliary-fallback').count()==0
   modal.get_by_role('button',name='撤销',exact=True).click();assert modal.locator('.auxiliary-fallback').count()==1
   modal.locator('[name=main-model]').fill('verified-model')
   modal.get_by_role('button',name='保存配置',exact=True).click();modal.wait_for(state='detached')
   data=fixture['module'].document(config)[2];assert data['auxiliary']['vision']['fallback_chain'][0]['api_key']=='${BACKUP_KEY}'
   assert data['auxiliary']['vision']['extra_body']['nested']==['one','two']
   # Select canonical saved service and model suggestion; old endpoint credential cleared.
   page.locator('.auxiliary-card[data-task=vision]').get_by_role('button',name='编辑配置').click()
   modal.locator('[name=main-provider]').select_option('custom:openai-api');assert modal.locator('[name=main-model]').input_value()=='vision-new'
   assert modal.locator('datalist').first.locator('option').count()==2
   assert modal.locator('[name=main-base_url]').input_value()==''
   # Cannot close or edit while async persistence is in flight.
   modal.get_by_role('button',name='保存配置',exact=True).click()
   if modal.count():
    assert modal.get_by_role('button',name='关闭',exact=True).is_disabled()
    page.keyboard.press('Escape')
   modal.wait_for(state='detached')
   data=fixture['module'].document(config)[2];task=data['auxiliary']['vision']
   assert task['provider']=='custom:openai-api' and 'api_key' not in task and 'base_url' not in task
   assert data['providers']['openai-api']['api_key']=='${SERVICE_SECRET}'
   assert data['auxiliary']['compression']['model']=='compress-old'
   page.locator('.auxiliary-card[data-task=vision]').get_by_role('button',name='编辑配置').click()
   modal.locator('[name=main-provider]').select_option('custom');modal.locator('[name=main-base_url]').fill('https://endpoint.invalid/v1')
   modal.locator('[name=main-key_env]').fill('ENDPOINT_KEY')
   assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
   assert modal.evaluate('(d)=>d.scrollWidth<=d.clientWidth')
   # All footer actions remain within the viewport, including short landscape.
   box=modal.get_by_role('button',name='保存配置',exact=True).bounding_box();assert 0<=box['y'] and box['y']+box['height']<=height
   page.screenshot(path=str(shots/f'auxiliary-{width}.png'))
   modal.get_by_role('button',name='关闭',exact=True).click()
   page.locator('.auxiliary-card[data-task=vision]').screenshot(path=str(shots/f'auxiliary-card-{width}.png'))
   assert not errors,errors
   results.append({'viewport':[width,height],'unique_vision':True,'unchanged_byte_identical':True,'draft_reload':True,'conflict_preserves_input':True,'fallback_undo_and_private_fields':True,'canonical_service_selection':True,'save_lock':True,'layout':True,'errors':errors})
   print(json.dumps(results[-1],ensure_ascii=False),flush=True);context.close()
  browser.close()
 (shots/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
finally:
 try: os.killpg(server.pid,signal.SIGTERM)
 except ProcessLookupError: pass
 try: server.wait(timeout=5)
 except subprocess.TimeoutExpired:
  try: os.killpg(server.pid,signal.SIGKILL)
  except ProcessLookupError: pass
  server.wait()
