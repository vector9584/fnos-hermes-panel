"""Runtime banner busy/unverified feedback with real persisted restart ledger."""
import json,os,signal,subprocess,tempfile,sys,time
from pathlib import Path
from playwright.sync_api import sync_playwright
from preview_process import preview_command, preview_launcher, read_startup_line
ROOT=Path(__file__).resolve().parents[3];state=Path(tempfile.mkdtemp(prefix='hermes-runtime-health-',dir='/tmp'));(state/'native-home/cron').mkdir(parents=True);(state/'native-home/cron/jobs.json').write_text('{"jobs":[]}');(state/'native-home/config.yaml').write_text('auxiliary: {}\n')
state.chmod(0o777);env={**os.environ,'HOME':str(state),'PREVIEW_STATE_ROOT':str(state),'PREVIEW_PORT':'0','TEST_PYTHON':sys.executable,'PYTHONDONTWRITEBYTECODE':'1'};os.environ['PLAYWRIGHT_BROWSERS_PATH']='/vol1/@apphome/hermes-agent/data/.cache/ms-playwright'
node='/vol1/@apphome/hermes-agent/data/node/bin/node';cmd=preview_launcher()+['env']+[f'{key}={env[key]}' for key in ('HOME','PREVIEW_STATE_ROOT','PREVIEW_PORT','TEST_PYTHON','PYTHONDONTWRITEBYTECODE')]+[node,str(ROOT/'dev/tests/rebuild/preview-server.mjs')]
server=subprocess.Popen(cmd,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True);shots=Path(tempfile.mkdtemp(prefix='hermes-runtime-health-evidence-',dir='/tmp'));shots.chmod(0o777);results=[]
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
def write(path,value):
 path.parent.mkdir(parents=True,exist_ok=True)
 temp=path.with_suffix('.tmp');temp.write_text(json.dumps(value));temp.replace(path)
def read(path):
 return json.loads(path.read_text())
try:
 first=read_startup_line(server)
 if not first: raise RuntimeError('预览服务没有启动：'+(server.stderr.read().strip() or '没有启动输出'))
 port=int(json.loads(first)['port']);url='http://127.0.0.1:'+str(port);print(first,flush=True)
 with sync_playwright() as p:
  browser=p.chromium.launch(args=['--no-sandbox'])
  for width,height in [(1440,900),(390,844),(844,390)]:
   write(state/'var/panel-state/runtime-apply.json',{'version':1,'changes':[{'id':'fixture','reason':'渠道配置','at':int(time.time()*1000)}],'restart':None});write(state/'service-health.json',{'gateway':{'work_known':True,'busy':True}})
   context=browser.new_context(viewport={'width':width,'height':height});page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)));context.route('**/*',lambda r:r.continue_(url=r.request.url.replace('/app/hermes-agent/','/')) if r.request.url.startswith(url) else r.abort());page.goto(url,wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'");bar=page.locator('.panel-runtime-bar');bar.get_by_text('1 项配置已保存，重启应用后生效；当前仍有任务在执行',exact=True).wait_for();messages=[];page.once('dialog',lambda d:(messages.append(d.message),d.dismiss()));bar.get_by_role('button',name='重启应用并生效').click();page.wait_for_timeout(200);assert messages and '当前仍有任务' in messages[0];assert read(state/'var/panel-state/runtime-apply.json')['restart'] is None
   result=page.evaluate("async()=>{const r=await fetch(apiUrl('/api/panel-runtime/restart'),{method:'POST',headers:{'Content-Type':'application/json','X-Monitor-Token':monitorToken},body:'{}'});return {status:r.status,body:await r.json()};}");assert result['status']==409
   write(state/'service-health.json',{'gateway':{'work_known':False,'busy':None}});page.evaluate('panelRuntimeRefresh()');bar.get_by_text('1 项配置已保存，重启应用后生效；暂时无法核实外部任务状态',exact=True).wait_for();page.wait_for_function("document.getElementById('chatComposer').getBoundingClientRect().bottom<=document.querySelector('.panel-runtime-bar').getBoundingClientRect().top");page.screenshot(path=str(shots/f'unverified-{width}.png'));assert page.evaluate('document.documentElement.scrollWidth<=innerWidth');page.reload(wait_until='domcontentloaded');bar.get_by_text('1 项配置已保存，重启应用后生效；暂时无法核实外部任务状态',exact=True).wait_for();# A persisted failed cleanup must offer a read-only recovery action, never another restart.
   record={'version':1,'changes':[{'id':'fixture','reason':'渠道配置','at':int(time.time()*1000)}],'restart':{'id':'failed-restart','status':'failed','requested_at':int(time.time()*1000),'error':'重启失败','drain_cleanup':{'status':'pending','error':'暂停接收状态尚未释放，正在重试；释放完成前不能再次重启'}}}
   # Supply a stable failure snapshot to exercise the UI independently of the preview's no-drain runtime.
   posts=[]
   def blocked(route):
    if route.request.method=='GET':route.fulfill(status=200,json={'ok':True,**record,'restart_pending':False,'restart_blocked':True,'healthy':True,'busy':False,'config_recovery':{'ok':True,'pending':None}})
    else:posts.append(route.request.url);route.abort()
   page.route('**/api/panel-runtime/*',blocked);page.evaluate('panelRuntimeRefresh()');bar.get_by_role('button',name='重新检查恢复状态').wait_for();bar.get_by_role('button',name='重新检查恢复状态').click();assert posts==[]
   page.reload(wait_until='domcontentloaded');bar.get_by_role('button',name='重新检查恢复状态').wait_for();assert posts==[]
   record['restart']['status']='ready';record['changes']=[]
   record['restart_block_reason']='正式重启脚本仍在执行，正在核实结果；暂不能再次重启'
   page.unroute('**/api/panel-runtime/*',blocked)
   def live_worker(route):
    if route.request.method=='GET':route.fulfill(status=200,json={'ok':True,**record,'restart_pending':False,'restart_blocked':True,'healthy':True,'busy':False,'config_recovery':{'ok':True,'pending':None}})
    else:posts.append(route.request.url);route.abort()
   page.route('**/api/panel-runtime/*',live_worker);page.evaluate('panelRuntimeRefresh()');bar.get_by_text(record['restart_block_reason'],exact=True).wait_for();bar.get_by_role('button',name='重新检查恢复状态').click();assert posts==[]
   assert not errors,errors;results.append({'viewport':[width,height],'busy_confirmation':True,'cancel_no_restart':True,'noninterrupt_rejected':True,'unverified_persists':True,'blocked_cleanup_read_only_refresh':True,'live_restart_script_blocks_duplicate_request':True,'errors':errors});context.close()
  browser.close()
 (shots/'results.json').write_text(json.dumps(results,ensure_ascii=False));print(json.dumps(results,ensure_ascii=False),flush=True)
finally:
 stop_server()
