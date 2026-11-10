"""Real configuration UI, isolated persisted credentials and simulated provider probe."""
import os,json,signal,subprocess,tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright
from preview_process import preview_launcher, read_startup_line
ROOT=Path(__file__).resolve().parent
state=Path(tempfile.mkdtemp(prefix='hermes-connector-preview-',dir='/tmp'));state.chmod(0o777)
(state/'native-home/cron').mkdir(parents=True);(state/'native-home/cron/jobs.json').write_text('{"jobs":[]}')
env={**os.environ,'HOME':str(state),'PREVIEW_STATE_ROOT':str(state),'PREVIEW_PORT':'0','PYTHONDONTWRITEBYTECODE':'1'}
os.environ['PLAYWRIGHT_BROWSERS_PATH']='/vol1/@apphome/hermes-agent/data/.cache/ms-playwright'
node='/vol1/@apphome/hermes-agent/data/node/bin/node';cmd=preview_launcher()+['env']+[f'{key}={env[key]}' for key in ('HOME','PREVIEW_STATE_ROOT','PREVIEW_PORT')]+[node,str(ROOT/'preview-server.mjs')]
server=subprocess.Popen(cmd,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
shots=Path(tempfile.mkdtemp(prefix='hermes-connector-evidence-',dir='/tmp'));shots.chmod(0o777);results=[]
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
 if not first: raise RuntimeError('预览服务没有启动：'+(server.stderr.read().strip() or '没有启动输出'))
 port=int(json.loads(first)['port']);url='http://127.0.0.1:'+str(port);print(first,flush=True)
 with sync_playwright() as p:
  browser=p.chromium.launch(args=['--no-sandbox'])
  for width,height in [(1440,900),(390,844),(844,390)]:
   context=browser.new_context(viewport={'width':width,'height':height});headers={'X-Monitor-Token':'fixture-token'}
   context.route('**/*',lambda r:r.continue_(url=r.request.url.replace('/app/hermes-agent/','/')) if r.request.url.startswith(url) else r.abort())
   page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   page.goto(url,wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token' && typeof openConnectorModal==='function'")
   page.evaluate("switchPage('comm');openConnectorModal('tencent-news')")
   page.wait_for_selector('#connectorModal [name=api_key]')
   assert page.locator('#connectorModal [name=api_key]').input_value()==''
   before=context.request.get(url+'/api/connectors/tencent-news',headers=headers).json()
   page.locator('#connModalFoot').get_by_role('button',name='测试连接',exact=True).click()
   page.wait_for_function("document.getElementById('connectorActionStatus').textContent.includes('未保存凭证')")
   assert context.request.get(url+'/api/connectors/tencent-news',headers=headers).json()['revision']==before['revision']
   # Another device edits while this dialog remains open. Keep draft on conflict.
   other=context.request.post(url+'/api/connectors/tencent-news',headers=headers,data={'revision':before['revision'],'api_key':'external-fixture'}).json()
   page.locator('#connectorModal [name=api_key]').fill('my-fixture-'+str(width))
   page.locator('#connModalFoot').get_by_role('button',name='保存配置',exact=True).click()
   page.wait_for_function("document.getElementById('connectorActionStatus').textContent.includes('其他页面修改')")
   assert page.locator('#connectorModal [name=api_key]').input_value()=='my-fixture-'+str(width)
   page.locator('#connectorModal').get_by_role('button',name='保留输入并读取最新版本',exact=True).click()
   page.wait_for_function("document.getElementById('connectorActionStatus').textContent.includes('本次输入保留')")
   context.request.post(url+'/__fixture/connector-failure',data={'fail':True})
   page.locator('#connModalFoot').get_by_role('button',name='保存配置',exact=True).click()
   page.wait_for_function("document.getElementById('connectorActionStatus').textContent.includes('未应用')")
   assert page.locator('#connectorModal [name=api_key]').input_value()==''
   assert context.request.get(url+'/api/connectors/tencent-news',headers=headers).json()['activation']=='apply_failed'
   context.request.post(url+'/__fixture/connector-failure',data={'fail':False})
   page.locator('#connModalFoot').get_by_role('button',name='重试应用',exact=True).click()
   page.wait_for_function("document.getElementById('connectorActionStatus').textContent.includes('已请求')")
   # Disable is reversible; no hard deletion of previous credentials.
   page.once('dialog',lambda d:d.accept());page.locator('#connModalFoot').get_by_role('button',name='停用连接器',exact=True).click()
   page.wait_for_function("!document.querySelector('.connector-tools')")
   page.once('dialog',lambda d:d.accept());page.locator('#connModalFoot').get_by_role('button',name='撤销上次修改',exact=True).click()
   page.wait_for_selector('.connector-tools')
   page.locator('.connector-tools summary').click()
   page.locator('.connector-tools [name=query]').fill('隔离查询')
   page.locator('.connector-tools').get_by_role('button',name='调用工具',exact=True).click()
   page.wait_for_function("document.querySelector('.connector-tools pre').textContent==='隔离查询结果'")
   calls=context.request.get(url+'/__fixture/stats').json()['connector_calls'];assert calls[-1]=={'tool':'search_news','args':{'query':'隔离查询'}}
   assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
   page.locator('#connectorModal').screenshot(path=str(shots/f'connector-{width}.png'))
   page.evaluate('closeConnectorModal()')
   page.reload(wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'");page.evaluate("openConnectorModal('tencent-news')")
   page.wait_for_selector('#connectorModal [name=api_key]');assert '已设置' in page.locator('#connectorModal [name=api_key]').get_attribute('placeholder')
   assert not errors,errors
   results.append({'viewport':[width,height],'probe_no_save':True,'conflict_keeps_values':True,'apply_failure_retry':True,'disable_undo':True,'schema_call':True,'reload':True,'errors':errors})
   print(json.dumps(results[-1],ensure_ascii=False),flush=True);context.close()
  browser.close()
 (shots/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
finally:
 stop_server()
