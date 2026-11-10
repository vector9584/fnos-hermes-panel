"""Actual PHP API + old ECHO page, with only paths/auth replaced in /tmp."""
import json,os,signal,socket,subprocess,tempfile,urllib.request,time
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[3]
state=Path(tempfile.mkdtemp(prefix='hermes-echo-web-',dir='/tmp'));site=state/'site';(site/'task').mkdir(parents=True)
queue=state/'tasks.json';queue.write_text('{"version":1,"seq":0,"tasks":[]}')
source=ROOT/'app/echo-web'
for name in ['index.html','store.php']:(site/'task'/name).write_bytes((source/name).read_bytes())
api=(source/'api.php').read_text().replace("const DATA   = '/vol1/1000/飞牛文件/html/.acl/tasks/tasks.json';",'const DATA = '+json.dumps(str(queue))+';')
api=api.replace("$user = $_SERVER['REMOTE_USER'] ?? '';","$user = 'isolated-fixture';")
api=api.replace("const USAGEDB = '/vol1/@apphome/hermes-agent/data/state.db';",'const USAGEDB = '+json.dumps(str(state/'absent.db'))+';')
api=api.replace("const BALANCE = '/vol1/1000/飞牛文件/html/.acl/tasks/balance.json';",'const BALANCE = '+json.dumps(str(state/'absent.json'))+';')
(site/'task/api.php').write_text(api)
store=(site/'task/store.php').read_text().replace("'/vol1/@appdata/hermes-agent/panel-state/echo-web-backups'",json.dumps(str(state/'backups')));(site/'task/store.php').write_text(store)
sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1];sock.close()
server=subprocess.Popen(['php','-S',f'127.0.0.1:{port}','-t',str(site)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
base=f'http://127.0.0.1:{port}'
os.environ['PLAYWRIGHT_BROWSERS_PATH']='/vol1/@apphome/hermes-agent/data/.cache/ms-playwright'
shots=Path(tempfile.mkdtemp(prefix='hermes-echo-evidence-',dir='/tmp'));shots.chmod(0o777);results=[]
try:
 for _ in range(40):
  try:urllib.request.urlopen(base+'/task/api.php?a=list',timeout=1);break
  except OSError:time.sleep(.1)
 with sync_playwright() as p:
  browser=p.chromium.launch(args=['--no-sandbox'])
  for width,height in [(1440,900),(390,844),(844,390)]:
   context=browser.new_context(viewport={'width':width,'height':height});page=context.new_page();errors=[]
   page.on('pageerror',lambda e:errors.append(str(e)))
   context.route('**/*',lambda route:route.continue_() if route.request.url.startswith(base+'/task/') else route.fulfill(status=200,body=''))
   page.goto(base+'/task/',wait_until='domcontentloaded');page.locator('#new').click()
   page.locator('#f-title').fill('网页任务 '+str(width));page.locator('#f-detail').fill('原页面草稿刷新测试')
   page.reload(wait_until='domcontentloaded');page.locator('#new').click();assert page.locator('#f-title').input_value()=='网页任务 '+str(width)
   page.locator('#save').click();page.wait_for_function("document.querySelector('#sstat').textContent.startsWith('已保存')")
   task=next(t for t in json.loads(queue.read_text())['tasks'] if t['title']=='网页任务 '+str(width));identifier=task['id']
   assert page.locator('#save').is_visible();page.locator('#close').click();page.locator('.card[data-id="'+str(identifier)+'"]').click()
   assert page.locator('#save').is_visible();page.locator('#f-title').fill('网页修改 '+str(width));page.locator('#save').click()
   page.wait_for_function("document.querySelector('#sstat').textContent.startsWith('已保存')")
   assert next(t for t in json.loads(queue.read_text())['tasks'] if t['id']==identifier)['title']=='网页修改 '+str(width)
   # Competing native writer: stale form must remain editable and unsaved.
   page.locator('#f-detail').fill('用户草稿不得被吞')
   data=json.loads(queue.read_text());next(t for t in data['tasks'] if t['id']==identifier)['detail']='另一个端修改';queue.write_text(json.dumps(data))
   page.locator('#save').click();page.wait_for_function("document.querySelector('#sstat').textContent.includes('其他页面')")
   assert page.locator('#f-detail').input_value()=='用户草稿不得被吞'
   page.locator('#sheet').screenshot(path=str(shots/f'web-conflict-{width}.png'))
   page.locator('#draft-merge').click();merge=page.locator('dialog[open]');assert '另一个端修改' in merge.inner_text()
   merge.get_by_role('textbox',name='合并后的要求').fill('另一个端修改\n用户草稿合并');merge.get_by_role('button',name='采用合并稿').click()
   page.locator('#save').click();page.wait_for_function("document.querySelector('#sstat').textContent.startsWith('已保存')")
   assert next(t for t in json.loads(queue.read_text())['tasks'] if t['id']==identifier)['detail']=='另一个端修改\n用户草稿合并'
   assert page.evaluate('document.documentElement.scrollWidth<=innerWidth');assert not errors,errors
   # Verify API mutations refuse GET and unknown authentication headers were not used.
   response=context.request.get(base+'/task/api.php?a=archive&id='+str(identifier));assert not response.json()['ok']
   # Running/cancel recovery uses the same real PHP API, never a fake browser result.
   data=json.loads(queue.read_text());task=next(t for t in data['tasks'] if t['id']==identifier);task.update(status='doing',panel_run={'id':'web-fixture','state':'running','owner':{'pid':99999999,'boot':'gone','start':'gone'}});queue.write_text(json.dumps(data))
   page.locator('#close').click();page.reload(wait_until='domcontentloaded');page.locator('#seg [data-f=doing]').click();page.locator('.card[data-id="'+str(identifier)+'"]').click()
   assert not page.locator('#save').is_visible();page.once('dialog',lambda d:d.accept());page.locator('#run-cancel').click();page.wait_for_function("document.querySelector('#sstat').textContent.includes('已请求取消')")
   page.locator('#run-recover').click();page.locator('#run-retry').wait_for(state='visible');page.locator('#run-retry').click();page.wait_for_function("document.querySelector('#run-retry').hidden")
   assert next(t for t in json.loads(queue.read_text())['tasks'] if t['id']==identifier)['status']=='pending'
   results.append({'viewport':[width,height],'real_php_create_edit':True,'draft_reload':True,'stale_rejected':True,'errors':errors});context.close()
  browser.close()
 (shots/'web-results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2));print(json.dumps(results,ensure_ascii=False),flush=True)
finally:
 try: os.killpg(server.pid,signal.SIGTERM)
 except ProcessLookupError: pass
 try: server.wait(timeout=5)
 except subprocess.TimeoutExpired:
  try: os.killpg(server.pid,signal.SIGKILL)
  except ProcessLookupError: pass
  server.wait()
