"""Actual clipboard paste, typing, full save and reload in isolated files."""
import os,json,signal,subprocess,tempfile,time
from pathlib import Path
from playwright.sync_api import sync_playwright
from preview_process import preview_launcher, read_startup_line
ROOT=Path(__file__).resolve().parent
state=Path(tempfile.mkdtemp(prefix='hermes-library-paste-',dir='/tmp'));state.chmod(0o777);(state/'native-home/cron').mkdir(parents=True);(state/'native-home/cron').chmod(0o777);(state/'native-home/cron/jobs.json').write_text('{"jobs":[]}');(state/'native-home/config.yaml').write_text('auxiliary: {}\n')
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
   context=browser.new_context(viewport={'width':width,'height':height},accept_downloads=True,permissions=['clipboard-read','clipboard-write']);headers={'X-Monitor-Token':'fixture-token'}
   context.route('**/*',lambda r:r.continue_(url=r.request.url.replace('/app/hermes-agent/','/')) if r.request.url.startswith(url) else r.abort())
   page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   page.goto(url,wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'");page.evaluate("panelOpenLibrary('memory','MEMORY.md')")
   memory=page.locator('#page-memory');page.wait_for_function("document.querySelector('#page-memory .library-document h2').textContent==='MEMORY.md'");
   if memory.get_by_role('button',name='编辑',exact=True).is_visible():memory.get_by_role('button',name='编辑',exact=True).click()
   editor=memory.get_by_role('textbox',name='资料内容')
   for lines in [4000,40000]:
    text='长资料正文\n'*lines
    print(json.dumps({'viewport':[width,height],'begin_paste_lines':lines}),flush=True)
    editor.focus();editor.press('ControlOrMeta+A');page.evaluate('(text)=>navigator.clipboard.writeText(text)',text);began=time.monotonic();editor.press('ControlOrMeta+V',timeout=20000);elapsed=time.monotonic()-began
    assert editor.input_value()==text;assert elapsed<3,elapsed
    print(json.dumps({'viewport':[width,height],'paste_lines':lines,'seconds':round(elapsed,3)}),flush=True)
    editor.press('ControlOrMeta+End');editor.press('End');typed=time.monotonic();page.keyboard.type(' CONTINUED-1234567890');typing_elapsed=time.monotonic()-typed;assert typing_elapsed<3,typing_elapsed
    page.wait_for_function("document.querySelector('#page-memory .library-draft-status').textContent==='草稿已同步'",timeout=20000)
    actual=context.request.get(url+'/api/panel-library/draft?source=memory&path=MEMORY.md',headers=headers).json()['draft'];assert actual['text']==text+' CONTINUED-1234567890'
    memory.get_by_role('button',name='保存修改',exact=True).click();page.wait_for_function("document.querySelector('#page-memory .maintenance-feedback').textContent.includes('文件已保存')")
    stored=context.request.get(url+'/api/panel-library/document?source=memory&path=MEMORY.md',headers=headers).json()['document'];assert stored['content']==text+' CONTINUED-1234567890'
    page.reload(wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'");page.evaluate("panelOpenLibrary('memory','MEMORY.md')")
    memory.get_by_role('button',name='编辑',exact=True).click();assert editor.input_value()==stored['content']
    print(json.dumps({'viewport':[width,height],'lines':lines,'typing_seconds':round(typing_elapsed,3),'full_save_reload':True,'errors':errors}),flush=True)
   assert not errors,errors;context.close()
  browser.close()
finally:
 stop_server()
