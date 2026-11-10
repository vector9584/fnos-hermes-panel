"""Actual recovery APIs/UI with crashed /tmp transactions, no service startup."""
import json,os,signal,subprocess,tempfile,sys,multiprocessing
from pathlib import Path
from playwright.sync_api import sync_playwright
from preview_process import preview_command, preview_launcher, read_startup_line
ROOT=Path(__file__).resolve().parents[3];sys.path.insert(0,str(ROOT/'app/server'))
from panel_config_txn import config_lock
from panel_config_bundle import commit_bundle
state=Path(tempfile.mkdtemp(prefix='hermes-recovery-preview-',dir='/tmp'));state.chmod(0o777);home=state/'native-home';home.mkdir(parents=True);home.chmod(0o777);(home/'cron').mkdir(parents=True);(home/'cron').chmod(0o777);(home/'cron/jobs.json').write_text('{"jobs":[]}');config=home/'config.yaml';envfile=home/'.env';var_root=state/'var';var_root.mkdir(parents=True);var_root.chmod(0o777);store=var_root/'panel-state';store.mkdir(parents=True);store.chmod(0o777)
def crash():
 config.write_bytes(b'auxiliary: {}\n');envfile.write_bytes(b'KEY=private-before\n')
 os.chmod(config,0o666);os.chmod(envfile,0o666)
 def child():
  with config_lock(store):commit_bundle(store,[(config,b'auxiliary: {}\n',b'auxiliary: {}\nrecovery_fixture: true\n'),(envfile,b'KEY=private-before\n',b'KEY=private-after\n')],'fixture',after_publish=lambda i:os._exit(71))
 proc=multiprocessing.Process(target=child);proc.start();proc.join(10);assert proc.exitcode==71
 for root,dirs,files in os.walk(state/'var'):
  try: os.chmod(root,0o777)
  except PermissionError: pass
  for name in files:
   try: os.chmod(Path(root)/name,0o666)
   except PermissionError: pass
runtime={**os.environ,'HOME':str(state),'PREVIEW_STATE_ROOT':str(state),'PREVIEW_PORT':'0','TEST_PYTHON':sys.executable,'PYTHONDONTWRITEBYTECODE':'1'}
os.environ['PLAYWRIGHT_BROWSERS_PATH']='/vol1/@apphome/hermes-agent/data/.cache/ms-playwright'
node='/vol1/@apphome/hermes-agent/data/node/bin/node';cmd=preview_launcher()+['env']+[f'{key}={runtime[key]}' for key in ('HOME','PREVIEW_STATE_ROOT','PREVIEW_PORT','TEST_PYTHON','PYTHONDONTWRITEBYTECODE')]+[node,str(ROOT/'dev/tests/rebuild/preview-server.mjs')]
server=subprocess.Popen(cmd,env=runtime,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
shots=Path(tempfile.mkdtemp(prefix='hermes-config-recovery-evidence-',dir='/tmp'));shots.chmod(0o777);results=[]
def native_write(path,data):
 Path(path).write_bytes(data.encode())
def native_read(path):
 return Path(path).read_bytes()
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
   crash();native_write(envfile,'KEY=initial-external-secret\n');context=browser.new_context(viewport={'width':width,'height':height});page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)));context.route('**/*',lambda r:r.continue_(url=r.request.url.replace('/app/hermes-agent/','/')) if r.request.url.startswith(url) else r.abort())
   page.goto(url,wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'");page.evaluate('panelRuntimeRefresh()');page.get_by_role('button',name='处理配置恢复',exact=True).click();section=page.get_by_role('region',name='配置保存恢复');section.get_by_role('button',name='保留当前文件',exact=True).wait_for();assert '保存后又被修改' in section.inner_text();assert 'secret' not in section.inner_text();page.reload(wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'");page.evaluate("switchPage('updates');renderConfigRecovery()");section.get_by_role('button',name='保留当前文件',exact=True).wait_for();page.once('dialog',lambda d:d.accept());section.get_by_role('button',name='保留当前文件',exact=True).click();section.get_by_text('没有未完成的配置保存。',exact=True).wait_for();assert native_read(envfile)==b'KEY=initial-external-secret\n'
   crash();native_write(envfile,'KEY=first-external-secret\n');page.evaluate('renderConfigRecovery()');section.get_by_role('button',name='保留当前文件',exact=True).wait_for();native_write(envfile,'KEY=external-secret\n');page.once('dialog',lambda d:d.accept());section.get_by_role('button',name='保留当前文件',exact=True).click();section.get_by_text('配置或恢复记录已变化，请重新核对后处理',exact=True).wait_for();assert native_read(envfile)==b'KEY=external-secret\n';section.get_by_role('button',name='重新读取',exact=True).click();section.get_by_text('保存后又被修改',exact=True).wait_for();assert section.get_by_role('button',name='完成上次保存',exact=True).count()==0;section.locator('summary').first.click();page.screenshot(path=str(shots/f'recovery-{width}.png'));assert page.evaluate('document.documentElement.scrollWidth<=innerWidth');assert section.evaluate('(e)=>e.scrollWidth<=e.clientWidth+1');page.once('dialog',lambda d:d.accept());section.get_by_role('button',name='保留当前文件',exact=True).click();section.get_by_text('没有未完成的配置保存。',exact=True).wait_for();assert native_read(envfile)==b'KEY=external-secret\n';assert native_read(config).decode().find('recovery_fixture')>=0;assert not (store/'config-bundle-pending.json').exists();assert not errors,errors;results.append({'viewport':[width,height],'reload':True,'stale_conflict':True,'external_preserved':True,'secret_hidden':True,'overflow':False,'errors':errors});context.close()
  browser.close()
 (shots/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2));print(json.dumps(results,ensure_ascii=False),flush=True)
finally:
 stop_server()
