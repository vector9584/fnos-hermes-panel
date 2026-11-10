"""Library reads/edits use an isolated real file store, never production knowledge or memories."""
import os,json,signal,subprocess,tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright
from preview_process import preview_launcher, read_startup_line
ROOT=Path(__file__).resolve().parent
state=Path(tempfile.mkdtemp(prefix='hermes-library-recovery-',dir='/tmp'));state.chmod(0o777);(state/'native-home/cron').mkdir(parents=True);(state/'native-home/cron').chmod(0o777);(state/'native-home/cron/jobs.json').write_text('{"jobs":[]}');(state/'native-home/config.yaml').write_text('auxiliary: {}\n')
env={**os.environ,'HOME':str(state),'PREVIEW_STATE_ROOT':str(state),'PREVIEW_PORT':'0','TEST_PYTHON':'/vol1/@apphome/hermes-agent/data/venv/bin/python3','PYTHONDONTWRITEBYTECODE':'1'}
os.environ['PLAYWRIGHT_BROWSERS_PATH']='/vol1/@apphome/hermes-agent/data/.cache/ms-playwright'
node='/vol1/@apphome/hermes-agent/data/node/bin/node';cmd=preview_launcher()+['env']+[f'{key}={env[key]}' for key in ('HOME','PREVIEW_STATE_ROOT','PREVIEW_PORT','TEST_PYTHON','PYTHONDONTWRITEBYTECODE')]+[node,str(ROOT/'preview-server.mjs')]
server=subprocess.Popen(cmd,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
shots=Path(tempfile.mkdtemp(prefix='hermes-library-recovery-evidence-',dir='/tmp'));shots.chmod(0o777);results=[]
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
   page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   page.goto(url,wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'");page.evaluate("panelOpenLibrary('memory','MEMORY.md')")
   memory=page.locator('#page-memory');memory.get_by_role('button',name='编辑',exact=True).click()
   text=memory.get_by_role('textbox',name='资料内容');saved='文件已落盘 '+str(width);text.fill(saved)
   mode={'history_fail':False,'inject':True};writes=[]
   def intercept(route):
    req=route.request
    if req.method=='PUT':
     writes.append(req.post_data_json);response=route.fetch(url=req.url.replace('/app/hermes-agent/','/'))
     if mode['inject']:
      current=context.request.get(url+'/api/panel-library/draft?source=memory&path=MEMORY.md',headers=headers).json()['draft']
      remote=context.request.put(url+'/api/panel-library/draft?source=memory&path=MEMORY.md',headers=headers,data={'revision':current['revision'],'text':'另一设备的新草稿 '+str(width),'options':{'base':response.json()['document']}})
      assert remote.ok
     mode['history_fail']=True;route.fulfill(response=response)
    elif mode['history_fail']:route.fulfill(status=503,json={'error':'隔离模拟历史读取失败'})
    else:route.fallback()
   page.route('**/api/panel-library/document*',intercept)
   memory.get_by_role('button',name='保存修改',exact=True).click()
   page.wait_for_function("document.querySelector('#page-memory .maintenance-feedback').textContent.includes('修改记录暂时无法读取')")
   feedback=memory.locator('.maintenance-feedback').inner_text();assert '文件已保存' in feedback and '其他草稿仍保留' in feedback,feedback
   assert memory.locator('.library-content').inner_text()==saved
   assert len(writes)==1
   actual=context.request.get(url+'/api/panel-library/document?source=memory&path=MEMORY.md',headers=headers).json();assert actual['document']['content']==saved
   remote=context.request.get(url+'/api/panel-library/draft?source=memory&path=MEMORY.md',headers=headers).json()['draft'];assert remote['text']=='另一设备的新草稿 '+str(width)
   mode['history_fail']=False;memory.get_by_role('button',name='重新读取资料',exact=True).click()
   page.wait_for_function("document.querySelector('#page-memory .library-editor').value.startsWith('另一设备的新草稿')")
   assert len(writes)==1
   # Unmerged conflict disables save. Explicit merge preserves both before applying.
   draft_state=context.request.get(url+'/api/panel-library/draft?source=memory&path=MEMORY.md',headers=headers).json()['draft']
   conflict_response=context.request.put(url+'/api/panel-library/draft?source=memory&path=MEMORY.md',headers=headers,data={'revision':draft_state['revision']-1,'text':'不能静默删除的冲突 '+str(width),'options':remote['options']})
   assert conflict_response.status==409 and conflict_response.json().get('conflict') is True,{'status':conflict_response.status,'body':conflict_response.text()}
   page.reload(wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'");page.wait_for_function("document.querySelector('#page-memory h2')?.textContent==='MEMORY.md'",timeout=15000)
   try:
    memory.get_by_role('button',name='合并草稿',exact=True).wait_for(timeout=8000)
   except Exception:
    print('FEEDBACK=',page.evaluate("document.querySelector('#page-memory .maintenance-feedback')?.textContent"),file=__import__('sys').stderr)
    print('BUTTONS=',page.evaluate("[...document.querySelectorAll('#page-memory button')].map(b=>b.textContent)"),file=__import__('sys').stderr)
    print('DRAFT=',context.request.get(url+'/api/panel-library/draft?source=memory&path=MEMORY.md',headers=headers).json(),file=__import__('sys').stderr)
    raise
   assert memory.get_by_role('button',name='保存修改',exact=True).is_disabled()
   memory.get_by_role('button',name='合并草稿',exact=True).click()
   assert '另一设备的新草稿' in text.input_value() and '不能静默删除的冲突' in text.input_value()
   mode['inject']=False;memory.get_by_role('button',name='保存修改',exact=True).click()
   page.wait_for_function("document.querySelector('#page-memory .maintenance-feedback').textContent.includes('文件已保存')")
   final=context.request.get(url+'/api/panel-library/draft?source=memory&path=MEMORY.md',headers=headers).json()['draft'];assert final['text']=='' and final['conflicts']==[],final
   assert len(writes)==2 and not errors,(writes,errors)
   results.append({'viewport':[width,height],'committed_save_survives_history_failure':True,'concurrent_draft_preserved':True,'retry_read_does_not_resave':True,'unmerged_conflict_blocks_save':True,'explicit_merge_consumes_only_reviewed_copies':True,'errors':errors});print(json.dumps(results[-1],ensure_ascii=False),flush=True)
   context.close()
  browser.close()
finally:
 stop_server()
