"""Actual usage page and all scripts, fixture response only."""
import json,os,signal,subprocess,tempfile,sys
from pathlib import Path
from playwright.sync_api import sync_playwright
from preview_process import preview_launcher, read_startup_line
ROOT=Path(__file__).resolve().parents[3];state=Path(tempfile.mkdtemp(prefix='hermes-usage-preview-',dir='/tmp'));state.chmod(0o777);(state/'native-home/cron').mkdir(parents=True);(state/'native-home/cron').chmod(0o777);(state/'native-home/cron/jobs.json').write_text('{"jobs":[]}');(state/'native-home/config.yaml').write_text('auxiliary: {}\n')
env={**os.environ,'HOME':str(state),'PREVIEW_STATE_ROOT':str(state),'PREVIEW_PORT':'0','TEST_PYTHON':sys.executable,'PYTHONDONTWRITEBYTECODE':'1'};os.environ['PLAYWRIGHT_BROWSERS_PATH']='/vol1/@apphome/hermes-agent/data/.cache/ms-playwright'
node='/vol1/@apphome/hermes-agent/data/node/bin/node';cmd=preview_launcher()+['env']+[f'{key}={env[key]}' for key in ('HOME','PREVIEW_STATE_ROOT','PREVIEW_PORT','TEST_PYTHON','PYTHONDONTWRITEBYTECODE')]+[node,str(ROOT/'dev/tests/rebuild/preview-server.mjs')]
server=subprocess.Popen(cmd,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True);results=[]
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
   context=browser.new_context(viewport={'width':width,'height':height});page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)));mode=['ok']
   def route(r):
    path=r.request.url.replace('/app/hermes-agent/','/')
    if not path.startswith(url):return r.abort()
    if '/api/usage' in path:
     if mode[0]=='error':return r.fulfill(status=503,json={'ok':False,'error':'执行记录暂时无法读取，请重试'})
     return r.fulfill(json={'ok':True,'usage':{'source':'Hermes 执行记录','period':'全部已记录调用','panel_requests':{'note':'面板直接请求单独统计','records':3,'reported_records':2,'input_tokens':15,'output_tokens':2,'unreadable_records':1,'by_model':[{'task':'model_check','model':'reported-check','provider':'fixture','input_tokens':15,'output_tokens':2}]},'total_sessions':3,'total_messages':8,'totals':{'input_tokens':199,'output_tokens':44,'api_call_count':6,'estimated_cost_usd':0.35,'actual_cost_usd':None},'coverage':{'ledger_rows':3,'auxiliary_rows':1,'priced_rows':2,'billed_rows':0,'historical_tokens':50,'ledger_unattributed_tokens':13},'notes':['费用不是完整账单。'],'by_model':[{'model':'fixture-model','provider':'fixture','task':'main','historical':False,'total_tokens':180,'api_call_count':3},{'model':None,'task':'vision','historical':False,'total_tokens':13,'api_call_count':1},{'model':None,'task':'main','historical':True,'total_tokens':50,'api_call_count':2}],'activity':[{'date':'2026-11-05','sessions':3,'messages':8}]}})
    if '/api/studio/security' in path:return r.fulfill(json={'enabled':False})
    return r.continue_(url=path)
   context.route('**/*',route);page.goto(url,wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'");page.evaluate("switchPage('usage')");page.locator('#usageByModelList .usage-model-row').first.wait_for();text=page.locator('#page-usage').inner_text();assert 'undefined' not in text;assert '历史汇总未分配模型' in text;assert '执行记录未保存模型' in text;assert '$0.3500' in text;assert 'reported-check' in text;assert '份记录无法读取' in text;assert '2 / 3 条记录返回用量' in text;assert '未记录金额' in text;assert not page.locator('#usageModelGrid').count();assert page.locator('.usage-model-row').count()==3;assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
   mode[0]='error';page.evaluate('renderUsagePage()');page.locator('#usageEmpty').wait_for();assert '读取' in page.locator('#usageEmpty').inner_text();assert not page.locator('#usageByModelSection').is_visible();mode[0]='ok';page.evaluate('renderUsagePage()');page.locator('#usageByModelList .usage-model-row').first.wait_for();assert not errors,errors;results.append({'viewport':[width,height],'single_renderer':True,'price_and_model_gaps_separate':True,'error_recovery':True,'errors':errors});context.close()
  browser.close()
 print(json.dumps(results,ensure_ascii=False),flush=True)
finally:
 stop_server()
