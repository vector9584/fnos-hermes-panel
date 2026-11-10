"""Quota/offline recovery uses real IndexedDB and isolated library files."""
import os,json,signal,subprocess,tempfile,time
from pathlib import Path
from playwright.sync_api import sync_playwright
from preview_process import preview_launcher, read_startup_line
ROOT=Path(__file__).resolve().parent
state=Path(tempfile.mkdtemp(prefix='hermes-library-storage-',dir='/tmp'));state.chmod(0o777);(state/'native-home/cron').mkdir(parents=True);(state/'native-home/cron').chmod(0o777);(state/'native-home/cron/jobs.json').write_text('{"jobs":[]}');(state/'native-home/config.yaml').write_text('auxiliary: {}\n')
env={**os.environ,'HOME':str(state),'PREVIEW_STATE_ROOT':str(state),'PREVIEW_PORT':'0','TEST_PYTHON':'/vol1/@apphome/hermes-agent/data/venv/bin/python3','PYTHONDONTWRITEBYTECODE':'1'}
os.environ['PLAYWRIGHT_BROWSERS_PATH']='/vol1/@apphome/hermes-agent/data/.cache/ms-playwright'
node='/vol1/@apphome/hermes-agent/data/node/bin/node';cmd=preview_launcher()+['env']+[f'{key}={env[key]}' for key in ('HOME','PREVIEW_STATE_ROOT','PREVIEW_PORT','TEST_PYTHON','PYTHONDONTWRITEBYTECODE')]+[node,str(ROOT/'preview-server.mjs')]
server=subprocess.Popen(cmd,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
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
 if not first: raise RuntimeError(server.stderr.read().strip() or '预览服务没有启动')
 port=int(json.loads(first)['port']);url='http://127.0.0.1:'+str(port);print(first,flush=True)
 with sync_playwright() as p:
  browser=p.chromium.launch(args=['--no-sandbox'])
  for width,height in [(1440,900),(390,844),(844,390)]:
   context=browser.new_context(viewport={'width':width,'height':height},accept_downloads=True);headers={'X-Monitor-Token':'fixture-token'}
   context.route('**/*',lambda r:r.continue_(url=r.request.url.replace('/app/hermes-agent/','/')) if r.request.url.startswith(url) else r.abort())
   context.add_init_script("""const original=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('panel-library-document:'))throw new DOMException('fixture quota','QuotaExceededError');return original.call(this,k,v);};""")
   mode={'offline':True}
   def draft_route(route):
    if mode['offline'] and route.request.method=='PUT':route.fulfill(status=503,json={'error':'隔离断网'})
    else:route.fallback()
   context.route('**/api/panel-library/draft*',draft_route)
   page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   page.goto(url,wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token' && typeof window.panelOpenLibrary==='function'");page.evaluate("panelOpenLibrary('memory','MEMORY.md')")
   memory=page.locator('#page-memory');memory.get_by_role('button',name='编辑',exact=True).click();editor=memory.get_by_role('textbox',name='资料内容')
   text='存储配额耗尽后的离线草稿 '+str(width);editor.fill(text)
   page.wait_for_function("document.querySelector('#page-memory .library-draft-status').textContent.includes('联网后会重试')")
   page.reload(wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token' && typeof window.panelOpenLibrary==='function'");page.evaluate("panelOpenLibrary('memory','MEMORY.md')")
   page.wait_for_function("text=>document.querySelector('#page-memory .library-editor').value===text",arg=text)
   mode['offline']=False;page.evaluate("window.dispatchEvent(new Event('online'))")
   page.wait_for_function("document.querySelector('#page-memory .library-draft-status').textContent==='草稿已同步'")
   remote=context.request.get(url+'/api/panel-library/draft?source=memory&path=MEMORY.md',headers=headers).json()['draft'];assert remote['text']==text
   with page.expect_download() as download:memory.get_by_role('button',name='下载草稿',exact=True).click()
   assert Path(download.value.path()).read_text()==text
   memory.get_by_role('button',name='保存修改',exact=True).click();page.wait_for_function("document.querySelector('#page-memory .maintenance-feedback').textContent.includes('文件已保存')")
   page.reload(wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token' && typeof window.panelOpenLibrary==='function'");page.evaluate("panelOpenLibrary('memory','MEMORY.md')");memory.get_by_role('button',name='编辑',exact=True).wait_for();assert memory.locator('.library-content').inner_text()==text
   # Even when both stores fail, upload uses live text (not a stale local copy).
   # A fresh context gets the failed IDB from its first access.
   broken=browser.new_context(viewport={'width':width,'height':height});broken.route('**/*',lambda r:r.continue_(url=r.request.url.replace('/app/hermes-agent/','/')) if r.request.url.startswith(url) else r.abort())
   broken.add_init_script("const original=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('panel-library-document:'))throw Error('quota');return original.call(this,k,v)};indexedDB.open=()=>{throw Error('unavailable')}")
   second=broken.new_page();second.on('pageerror',lambda e:errors.append(str(e)));second.goto(url,wait_until='domcontentloaded');second.wait_for_function("monitorToken==='fixture-token' && typeof window.panelOpenLibrary==='function'");second.evaluate("panelOpenLibrary('memory','MEMORY.md')")
   m=second.locator('#page-memory');m.get_by_role('button',name='编辑',exact=True).click();m.get_by_role('textbox',name='资料内容').fill('两种存储失败仍同步 '+str(width));second.wait_for_function("document.querySelector('#page-memory .library-draft-status').textContent==='草稿已同步'")
   assert context.request.get(url+'/api/panel-library/draft?source=memory&path=MEMORY.md',headers=headers).json()['draft']['text']=='两种存储失败仍同步 '+str(width)
   # Save leaves a deletion marker, so old cached content cannot resurrect.
   m.get_by_role('button',name='保存修改',exact=True).click();second.wait_for_function("document.querySelector('#page-memory .maintenance-feedback').textContent.includes('文件已保存')")
   assert not errors,errors
   print(json.dumps({'viewport':[width,height],'quota_offline_reload':True,'reconnect_sync':True,'draft_download_exact':True,'consumed_draft_not_restored':True,'both_stores_fail_live_sync':True,'errors':errors}),flush=True)
   broken.close();context.close()
  browser.close()
finally:
 stop_server()
