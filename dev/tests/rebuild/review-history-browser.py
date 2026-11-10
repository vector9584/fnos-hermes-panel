"""Library reads/edits use an isolated real file store, never production knowledge or memories."""
import os,json,signal,subprocess,tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright
from preview_process import preview_command, preview_launcher, read_startup_line
ROOT=Path(__file__).resolve().parent
state=Path(tempfile.mkdtemp(prefix='hermes-library-preview-',dir='/tmp'));state.chmod(0o777);(state/'native-home/cron').mkdir(parents=True);(state/'native-home/cron/jobs.json').write_text('{"jobs":[]}');(state/'native-home/config.yaml').write_text('auxiliary: {}\n')
env={**os.environ,'HOME':str(state),'PREVIEW_STATE_ROOT':str(state),'PREVIEW_PORT':'0','TEST_PYTHON':'/vol1/@apphome/hermes-agent/data/venv/bin/python3','PYTHONDONTWRITEBYTECODE':'1'}
os.environ['PLAYWRIGHT_BROWSERS_PATH']='/vol1/@apphome/hermes-agent/data/.cache/ms-playwright'
var_root=state/'var';var_root.mkdir(parents=True);var_root.chmod(0o777)
panel_root=var_root/'panel-state';panel_root.mkdir(parents=True);panel_root.chmod(0o777)
records=panel_root/'library-reviews';records.mkdir(parents=True)
records.chmod(0o777)
def native_write(path,text):
 Path(path).write_text(text)
for i in range(123):
 record={'version':1,'id':'history-'+str(i).zfill(3),'status':'ready' if i==0 else 'applied','created_at':1000+i,'provider_name':'隔离模型','provider':'fixture','model':'fixture-model','target':{'source':'memory','path':'MEMORY.md','content':'原始记忆','revision':'fixture'},'sources':[],'proposal':'第'+str(i)+'份完整整理内容','apply_request':{'content':'私有应用全文'+str(i),'request_id':'apply-'+str(i)}}
 record_path=records/(record['id']+'.json');native_write(record_path,json.dumps(record))
node='/vol1/@apphome/hermes-agent/data/node/bin/node';cmd=preview_launcher()+['env']+[f'{key}={env[key]}' for key in ('HOME','PREVIEW_STATE_ROOT','PREVIEW_PORT','TEST_PYTHON','PYTHONDONTWRITEBYTECODE')]+[node,str(ROOT/'preview-server.mjs')]
server=subprocess.Popen(cmd,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
shots=Path(tempfile.mkdtemp(prefix='hermes-review-history-evidence-',dir='/tmp'));shots.chmod(0o777);results=[]
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
   context=browser.new_context(viewport={'width':width,'height':height})
   context.route('**/*',lambda r:r.continue_(url=r.request.url.replace('/app/hermes-agent/','/')) if r.request.url.startswith(url) else r.abort())
   page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   page.goto(url,wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'");page.evaluate("switchPage('memory')")
   page.locator('#page-memory').get_by_role('button',name='整理草稿',exact=True).click();dialog=page.get_by_role('dialog',name='记忆整理草稿')
   page.wait_for_function("document.querySelectorAll('.review-record').length===50")
   response=context.request.get(url+'/api/panel-library-reviews',headers={'X-Monitor-Token':'fixture-token'});assert response.ok;assert '私有应用全文' not in response.text();assert '完整整理内容' not in response.text()
   more=dialog.get_by_role('button',name='加载更早整理记录',exact=True);more.click();page.wait_for_function("document.querySelectorAll('.review-record').length===100")
   more.click();page.wait_for_function("document.querySelectorAll('.review-record').length===123");assert not more.is_visible()
   # A completed background refresh must not replace a focused history button or drop older pages.
   old=dialog.locator('[data-review-id=history-000]');inspect=old.get_by_role('button',name='审阅草稿');inspect.focus()
   with page.expect_response(lambda r:'/api/panel-library-reviews' in r.url and r.request.method=='GET' and '/history-' not in r.url):page.wait_for_timeout(1700)
   assert page.locator('.review-record').count()==123;assert inspect.evaluate('(e)=>e===document.activeElement')
   page.keyboard.press('Enter');review=page.get_by_role('dialog',name='审阅记忆草稿');proposal=review.get_by_role('textbox',name='整理草稿内容');assert proposal.input_value()=='第0份完整整理内容'
   page.keyboard.press('Escape');review.wait_for(state='detached');assert page.evaluate('(trigger)=>document.activeElement===trigger',inspect.element_handle())
   inspect.focus();page.keyboard.press('Enter');review=page.get_by_role('dialog',name='审阅记忆草稿');proposal=review.get_by_role('textbox',name='整理草稿内容');assert proposal.input_value()=='第0份完整整理内容'
   proposal.fill('');review.get_by_role('button',name='关闭',exact=True).click();inspect.click();assert proposal.input_value()==''
   proposal.fill('第0份完整整理内容');page.screenshot(path=str(shots/f'history-detail-{width}.png'))
   # Accepted apply of an old record updates its loaded row even though polling fetches only latest 50.
   page.route('**/api/panel-library-reviews/history-000/apply',lambda r:r.fulfill(status=200,json={'ok':True,'document':{}}))
   page.evaluate("()=>{const original=Storage.prototype.removeItem;Storage.prototype.removeItem=function(k){if(k.startsWith('panel-review-text:'))throw Error('fixture cleanup denied');return original.call(this,k);};}")
   review.get_by_role('button',name='应用到长期记忆',exact=True).click();review.get_by_text('长期记忆已保存',exact=False).wait_for()
   review.get_by_role('button',name='关闭',exact=True).click();old.get_by_role('button',name='查看记录',exact=True).wait_for();assert old.get_by_text('已应用',exact=True).is_visible()

   dialog.get_by_role('button',name='刷新记录',exact=True).click();page.wait_for_function("document.querySelectorAll('.review-record').length===50");assert more.is_visible()
   dialog.locator('.modal-body').evaluate('(e)=>{e.scrollTop=0;}');assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
   page.screenshot(path=str(shots/f'history-list-{width}.png'));dialog_trigger=page.locator('#page-memory').get_by_role('button',name='整理草稿',exact=True);page.keyboard.press('Escape');dialog.wait_for(state='detached');assert page.evaluate('(trigger)=>document.activeElement===trigger',dialog_trigger.element_handle())
   dialog_trigger.click();dialog=page.get_by_role('dialog',name='记忆整理草稿');page.wait_for_function("document.querySelectorAll('.review-record').length===50");assert page.locator('dialog:modal').count()==1
   assert not errors,errors;result={'viewport':[width,height],'all_123_accessible':True,'list_excludes_full_text':True,'poll_preserves_pages_and_focus':True,'detail_escape_restores_focus_and_cleans_dom':True,'list_escape_restores_focus_and_stops_polling':True,'old_detail_complete':True,'empty_edit_preserved':True,'refresh_resets_paging':True,'accepted_old_apply_updates_row_despite_cleanup_failure':True,'errors':errors};results.append(result);print(json.dumps(result,ensure_ascii=False),flush=True);context.close()
  browser.close()
 (shots/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
finally:
 stop_server()
