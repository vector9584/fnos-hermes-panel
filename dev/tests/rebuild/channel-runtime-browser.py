"""Full page runtime transitions, all upstream/network actions mocked."""
import json,os,signal,subprocess,tempfile,sys
from pathlib import Path
from playwright.sync_api import sync_playwright
from preview_process import preview_launcher, read_startup_line
ROOT=Path(__file__).resolve().parents[3];state=Path(tempfile.mkdtemp(prefix='hermes-channel-runtime-',dir='/tmp'));state.chmod(0o777);(state/'native-home/cron').mkdir(parents=True);(state/'native-home/cron/jobs.json').write_text('{"jobs":[]}');(state/'native-home/config.yaml').write_text('auxiliary: {}\n')
runtime={**os.environ,'HOME':str(state),'PREVIEW_STATE_ROOT':str(state),'PREVIEW_PORT':'0','TEST_PYTHON':sys.executable,'PYTHONDONTWRITEBYTECODE':'1'}
os.environ['PLAYWRIGHT_BROWSERS_PATH']='/vol1/@apphome/hermes-agent/data/.cache/ms-playwright'
node='/vol1/@apphome/hermes-agent/data/node/bin/node';cmd=preview_launcher()+['env']+[f'{key}={runtime[key]}' for key in ('HOME','PREVIEW_STATE_ROOT','PREVIEW_PORT','TEST_PYTHON','PYTHONDONTWRITEBYTECODE')]+[node,str(ROOT/'dev/tests/rebuild/preview-server.mjs')]
server=subprocess.Popen(cmd,env=runtime,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
shots=Path(tempfile.mkdtemp(prefix='hermes-channel-runtime-evidence-',dir='/tmp'));shots.chmod(0o777);results=[]
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
def status(value):
 p=state/'channel-runtime.json';tmp=p.with_suffix('.tmp');tmp.write_text(json.dumps(value));tmp.replace(p)
try:
 first=read_startup_line(server)
 if not first: raise RuntimeError('预览服务没有启动：'+(server.stderr.read().strip() or '没有启动输出'))
 port=int(json.loads(first)['port']);url='http://127.0.0.1:'+str(port);print(first,flush=True)
 with sync_playwright() as p:
  browser=p.chromium.launch(args=['--no-sandbox'])
  for width,height in [(1440,900),(390,844),(844,390)]:
   status({'verified':True,'platforms':{'qqbot':{'state':'connected','label':'已连接','authorization':None}}});context=browser.new_context(viewport={'width':width,'height':height});page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)));context.route('**/*',lambda r:r.continue_(url=r.request.url.replace('/app/hermes-agent/','/')) if r.request.url.startswith(url) else r.abort());page.goto(url,wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'");page.evaluate("switchPage('comm');renderChannels()");card=page.locator('[data-channel-id=qqbot]');live=card.locator('.channel-live');live.get_by_text('运行状态：已连接',exact=True).wait_for();assert live.get_attribute('role')=='status';assert live.get_attribute('aria-live')=='polite';assert live.get_attribute('aria-atomic')=='true';page.evaluate("()=>{window.channelLiveMutations=0;window.channelLiveObserver=new MutationObserver(records=>window.channelLiveMutations+=records.length);window.channelLiveObserver.observe(document.querySelector('.channel-live'),{childList:true,characterData:true,subtree:true});}");page.wait_for_timeout(5500);assert page.evaluate('window.channelLiveMutations')==0,'unchanged polling must not re-announce identical status';card.get_by_role('button',name='编辑配置',exact=True).click();dialog=page.get_by_role('dialog',name='配置 QQ 机器人');dialog.get_by_role('textbox',name='语音识别模型',exact=True).fill('draft-preserved')
   value={'verified':True,'platforms':{'qqbot':{'state':'retrying','label':'正在重连','authorization':None}}};status(value);live.get_by_text('运行状态：正在重连',exact=True).wait_for(timeout=12000);assert page.evaluate('window.channelLiveMutations')==1,'changed status should be announced once';page.wait_for_timeout(5500);assert page.evaluate('window.channelLiveMutations')==1,'unchanged follow-up polling must not repeat the announcement';assert dialog.get_by_role('textbox',name='语音识别模型',exact=True).input_value()=='draft-preserved'
   for value,text in [({'verified':False,'reason':'gateway_stopped','platforms':{}},'运行状态：网关未运行'),({'verified':False,'reason':'process_changed','platforms':{}},'运行状态：暂时无法核实，请稍后刷新'),({'verified':True,'platforms':{'qqbot':{'state':'connected','label':'已连接','authorization':{'platform_allow_all':True,'global_allow_all':True}}}},'运行状态：已连接')]:
    status(value);card.get_by_text(text,exact=True).wait_for(timeout=12000);assert dialog.get_by_role('textbox',name='语音识别模型',exact=True).input_value()=='draft-preserved'
   dialog.get_by_role('button',name='关闭',exact=True).click();card.get_by_text('启动配置：允许此渠道的所有用户；仍受渠道接收策略限制。',exact=True).wait_for();page.screenshot(path=str(shots/f'runtime-{width}.png'));assert page.evaluate('document.documentElement.scrollWidth<=innerWidth');assert not errors,errors;results.append({'viewport':[width,height],'live_transitions':True,'draft_preserved':True,'no_overflow':True,'errors':errors});context.close()
  browser.close()
 (shots/'results.json').write_text(json.dumps(results,ensure_ascii=False));print(json.dumps(results,ensure_ascii=False),flush=True)
finally:
 stop_server()
