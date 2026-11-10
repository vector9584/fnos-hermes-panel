"""Library reads/edits use an isolated real file store, never production knowledge or memories."""
import os,json,signal,subprocess,tempfile,time
from pathlib import Path
from playwright.sync_api import sync_playwright
from preview_process import preview_launcher, read_startup_line
ROOT=Path(__file__).resolve().parent
state=Path(tempfile.mkdtemp(prefix='hermes-library-read-',dir='/tmp'));state.chmod(0o777);(state/'native-home/cron').mkdir(parents=True);(state/'native-home/cron').chmod(0o777);(state/'native-home/cron/jobs.json').write_text('{"jobs":[]}');(state/'native-home/config.yaml').write_text('auxiliary: {}\n')
env={**os.environ,'HOME':str(state),'PREVIEW_STATE_ROOT':str(state),'PREVIEW_PORT':'0','TEST_PYTHON':'/vol1/@apphome/hermes-agent/data/venv/bin/python3','PYTHONDONTWRITEBYTECODE':'1'}
os.environ['PLAYWRIGHT_BROWSERS_PATH']='/vol1/@apphome/hermes-agent/data/.cache/ms-playwright'
node='/vol1/@apphome/hermes-agent/data/node/bin/node';cmd=preview_launcher()+['env']+[f'{key}={env[key]}' for key in ('HOME','PREVIEW_STATE_ROOT','PREVIEW_PORT','TEST_PYTHON','PYTHONDONTWRITEBYTECODE')]+[node,str(ROOT/'preview-server.mjs')]
server=subprocess.Popen(cmd,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
shots=Path(tempfile.mkdtemp(prefix='hermes-library-read-evidence-',dir='/tmp'));shots.chmod(0o777);results=[]
def stop_server():
 try: os.killpg(server.pid,signal.SIGTERM)
 except ProcessLookupError: pass
 try: server.wait(timeout=5)
 except subprocess.TimeoutExpired:
  try: os.killpg(server.pid,signal.SIGKILL)
  except (ProcessLookupError,PermissionError): pass
  try: server.wait(timeout=5)
  except subprocess.TimeoutExpired: pass
try:
 first=read_startup_line(server)
 if not first: raise RuntimeError(server.stderr.read().strip() or '预览服务没有启动')
 port=int(json.loads(first)['port']);url='http://127.0.0.1:'+str(port);print(first,flush=True)
 with sync_playwright() as p:
  browser=p.chromium.launch(args=['--no-sandbox'])
  for width,height in [(1440,900),(390,844),(844,390)]:
   context=browser.new_context(viewport={'width':width,'height':height});headers={'X-Monitor-Token':'fixture-token'}
   context.route('**/*',lambda r:r.continue_(url=r.request.url.replace('/app/hermes-agent/','/')) if r.request.url.startswith(url) else r.abort())
   missing=context.request.get(url+'/api/panel-library/document?source=memory&path=USER.md&new=1',headers=headers).json()['document']
   if not missing['exists']:assert context.request.put(url+'/api/panel-library/document',headers=headers,data={**missing,'request_id':'user-'+str(width),'content':'用户资料'}).ok
   page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   page.goto(url,wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'");page.evaluate("panelOpenLibrary('memory','MEMORY.md')")
   memory=page.locator('#page-memory');memory.get_by_role('button',name='编辑',exact=True).click();editor=memory.get_by_role('textbox',name='资料内容');editor.fill('旧资料未保存 '+str(width))
   mode={'fail':True}
   def fail_draft(route):
    if mode['fail'] and route.request.method=='GET' and 'path=USER.md' in route.request.url:route.fulfill(status=503,json={'error':'隔离模拟草稿读取失败'})
    else:route.fallback()
   page.route('**/api/panel-library/draft*',fail_draft)
   page.evaluate("panelOpenLibrary('memory','USER.md')")
   memory.get_by_role('button',name='重试打开资料',exact=True).wait_for()
   assert memory.locator('.library-document h2').inner_text()=='MEMORY.md'
   assert editor.input_value()=='旧资料未保存 '+str(width)
   assert not editor.is_disabled()
   memory.get_by_role('button',name='保存修改',exact=True).click();page.wait_for_function("document.querySelector('#page-memory .maintenance-feedback').textContent.includes('文件已保存')")
   assert context.request.get(url+'/api/panel-library/document?source=memory&path=MEMORY.md',headers=headers).json()['document']['content']=='旧资料未保存 '+str(width)
   mode['fail']=False;page.evaluate("panelOpenLibrary('memory','USER.md')");page.wait_for_function("document.querySelector('#page-memory .library-document h2').textContent==='USER.md'")
   # Seed a long source using the real isolated API, then edit/sync and restore it in a separate browser context.
   current=context.request.get(url+'/api/panel-library/document?source=memory&path=MEMORY.md',headers=headers).json()['document']
   long='长资料正文\n'*40000
   response=context.request.put(url+'/api/panel-library/document',headers=headers,data={**current,'request_id':'long-'+str(width),'content':long});assert response.ok
   page.evaluate("panelOpenLibrary('memory','MEMORY.md')");memory.get_by_role('button',name='编辑',exact=True).click();editor.click();editor.press('ControlOrMeta+End');editor.press('End');page.keyboard.insert_text('未保存的末尾')
   def wait_draft(predicate):
    deadline=time.monotonic()+15
    while time.monotonic()<deadline:
     draft=context.request.get(url+'/api/panel-library/draft?source=memory&path=MEMORY.md',headers=headers).json()['draft']
     if predicate(draft):return draft
     page.wait_for_timeout(100)
    raise AssertionError('server draft did not reach expected state')
   wait_draft(lambda d:d['text'].endswith('未保存的末尾'))

   page.reload(wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'");page.evaluate("switchPage('memory')");page.wait_for_function("document.querySelector('#page-memory .library-editor').value.endsWith('未保存的末尾')")
   assert editor.input_value()==long+'未保存的末尾'
   # An intentional empty draft is distinct from no draft, including on another device.
   editor.fill('');wait_draft(lambda d:d['text']=='' and bool(d['options'].get('base')))
   other=browser.new_context(viewport={'width':width,'height':height});other.route('**/*',lambda r:r.continue_(url=r.request.url.replace('/app/hermes-agent/','/')) if r.request.url.startswith(url) else r.abort())
   second=other.new_page();second.goto(url,wait_until='domcontentloaded');second.wait_for_function("monitorToken==='fixture-token'");second.evaluate("panelOpenLibrary('memory','MEMORY.md')")

   second.wait_for_function("!document.querySelector('#page-memory .library-editor').hidden && document.querySelector('#page-memory .library-editor').value===''")
   assert not second.locator('#page-memory').get_by_role('button',name='保存修改',exact=True).is_disabled()
   second.locator('#page-memory').get_by_role('button',name='保存修改',exact=True).click();second.wait_for_function("document.querySelector('#page-memory .maintenance-feedback').textContent.includes('文件已保存')")
   assert not errors,errors
   print(json.dumps({'viewport':[width,height],'failed_draft_read_keeps_previous_document':True,'save_targets_visible_document':True,'long_draft_refresh':True,'empty_draft_restores_on_another_device':True,'errors':errors}),flush=True)
   other.close();context.close()
  browser.close()
finally:
 stop_server()
