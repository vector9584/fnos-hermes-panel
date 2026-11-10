import json,os,signal,subprocess,tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright
from preview_process import preview_command, preview_launcher, read_startup_line
ROOT=Path(__file__).resolve().parent
state=Path(tempfile.mkdtemp(prefix='hermes-files-preview-',dir='/tmp'));state.chmod(0o777);(state/'native-home/cron').mkdir(parents=True);(state/'native-home/cron/jobs.json').write_text('{"jobs":[]}')
env={**os.environ,'HOME':str(state),'PREVIEW_STATE_ROOT':str(state),'PREVIEW_PORT':'0','TEST_PYTHON':'/vol1/@apphome/hermes-agent/data/venv/bin/python3','PYTHONDONTWRITEBYTECODE':'1'}
os.environ['PLAYWRIGHT_BROWSERS_PATH']='/vol1/@apphome/hermes-agent/data/.cache/ms-playwright'
node='/vol1/@apphome/hermes-agent/data/node/bin/node';cmd=preview_launcher()+['env']+[f'{key}={env[key]}' for key in ('HOME','PREVIEW_STATE_ROOT','PREVIEW_PORT','TEST_PYTHON','PYTHONDONTWRITEBYTECODE')]+[node,str(ROOT/'preview-server.mjs')]
server=subprocess.Popen(cmd,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
shots=Path(tempfile.mkdtemp(prefix='hermes-files-evidence-',dir='/tmp'));shots.chmod(0o777);results=[]
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
  # sudo may exit before its child has reaped; repeat against the original PGID.
  try: os.killpg(server.pid,signal.SIGKILL)
  except ProcessLookupError: pass
def native_write(path,text):
 path=Path(path);path.parent.mkdir(parents=True,exist_ok=True);temp=path.with_suffix('.external');temp.write_text(text);temp.replace(path)
try:
 first=read_startup_line(server)
 if not first: raise RuntimeError('预览服务没有启动：'+(server.stderr.read().strip() or '没有启动输出'))
 port=int(json.loads(first)['port']);url='http://127.0.0.1:'+str(port);print(first,flush=True)
 with sync_playwright() as p:
  browser=p.chromium.launch(args=['--no-sandbox'])
  for width,height in [(1440,900),(390,844),(844,390)]:
   context=browser.new_context(viewport={'width':width,'height':height});page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   context.route('**/*',lambda route:route.continue_(url=route.request.url.replace('/app/hermes-agent/','/')) if route.request.url.startswith(url) else route.abort())
   def open_files():
    page.evaluate("switchPage('chat');if(!document.getElementById('workspacePanel').classList.contains('open'))toggleWorkspace();wsSwitchTab(document.querySelectorAll('.ws-tab')[1],'files')")
    page.locator('.pf-status').first.filter(has_text='项').wait_for()
   page.goto(url,wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'");open_files();assert page.locator('.pf-list .pf-item').count()==80
   page.locator('#ws-files').get_by_role('button',name='下一页',exact=True).click();page.wait_for_function("document.querySelectorAll('.pf-list .pf-item').length<80")
   page.locator('#ws-files').get_by_role('button',name='上一页',exact=True).click();page.wait_for_function("document.querySelectorAll('.pf-list .pf-item').length===80")
   search=page.get_by_role('searchbox',name='筛选当前目录');search.fill('笔记.md');page.wait_for_function("document.querySelectorAll('.pf-list .pf-item').length===1");page.locator('.pf-list').get_by_role('button',name='笔记.md',exact=True).click();editor=page.get_by_role('textbox',name='文件内容');editor.wait_for();editor.fill('跨刷新文件草稿 '+str(width));page.locator('.pf-editor-pane .pf-status').filter(has_text='草稿已同步').wait_for()
   page.reload(wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'");open_files();page.locator('.pf-list').get_by_role('button',name='笔记.md',exact=True).click();editor.wait_for();assert editor.input_value()=='跨刷新文件草稿 '+str(width)
   # Simulate a simultaneous native writer in the isolated fixture only.
   native_write(state/'file-home/workspace/笔记.md','内核同时更新 '+str(width));page.get_by_role('button',name='保存修改',exact=True).click();page.locator('.pf-editor-pane .pf-status').filter(has_text='原文件已变化').wait_for();assert editor.input_value()=='跨刷新文件草稿 '+str(width)
   page.get_by_role('button',name='读取最新版本并合并').click();dialog=page.get_by_role('dialog',name='合并文件与草稿');dialog.wait_for();assert dialog.get_by_role('textbox',name='磁盘最新文件').input_value()=='内核同时更新 '+str(width)
   dialog.get_by_role('textbox',name='合并结果').fill('合并后 '+str(width));dialog.get_by_role('button',name='使用合并结果').click();page.get_by_role('button',name='保存修改',exact=True).click();page.wait_for_function("document.querySelector('.pf-editor-pane .pf-status').textContent.includes('已保存，旧版本')");assert (state/'file-home/workspace/笔记.md').read_text()=='合并后 '+str(width)
   page.get_by_role('button',name='修改记录',exact=True).click();history=page.get_by_role('dialog',name='修改记录');history.locator('.pf-history').first.wait_for();history.get_by_role('button',name='撤销这次修改').first.click();history.get_by_text('已恢复旧版本',exact=True).wait_for();assert (state/'file-home/workspace/笔记.md').read_text()=='内核同时更新 '+str(width);assert editor.input_value()=='内核同时更新 '+str(width);history.get_by_role('button',name='关闭',exact=True).click()
   page.once('dialog',lambda d:d.accept());page.locator('.pf-list').get_by_role('button',name='归档',exact=True).click();page.wait_for_function("document.querySelector('.pf-status').textContent.includes('已归档')",timeout=10000);assert not (state/'file-home/workspace/笔记.md').exists();page.locator('.pf-toolbar').get_by_role('button',name='归档',exact=True).click();archives=page.get_by_role('dialog',name='已归档文件');archives.get_by_role('button',name='恢复文件').click();archives.get_by_role('button',name='恢复文件').wait_for(state='detached');archives.get_by_role('button',name='关闭',exact=True).click();assert (state/'file-home/workspace/笔记.md').exists()
   page.locator('.pf-list').get_by_role('button',name='笔记.md',exact=True).click();editor.wait_for();page.screenshot(path=str(shots/f'files-{width}.png'))
   search.fill('preview.html');page.wait_for_function("document.querySelector('.pf-list').textContent.includes('preview.html')");page.locator('.pf-list').get_by_role('button',name='preview.html',exact=True).click();page.frame_locator('.pf-preview iframe').get_by_role('heading',name='安全预览').wait_for(timeout=8000);assert page.evaluate('window.filePreviewInjection') is None
   assert not errors,errors;assert page.evaluate('document.documentElement.scrollWidth<=innerWidth');results.append({'viewport':[width,height],'pagination':True,'draft_reload':True,'conflict_merge':True,'undo':True,'archive_restore':True,'sandbox_preview':True,'errors':errors});context.close()
  browser.close()
 (shots/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2));print(json.dumps(results,ensure_ascii=False),flush=True)
except Exception:
 try:
  print(json.dumps({'viewport':[width,height],'status':page.locator('.pf-status').all_text_contents(),'errors':errors},ensure_ascii=False),flush=True);page.screenshot(path=str(shots/'failure.png'))
 except Exception:pass
 raise
finally:
 stop_server()
