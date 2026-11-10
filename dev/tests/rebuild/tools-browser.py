"""Verify tool configuration visibility and success/failure feedback in a real page."""
import json,os,signal,subprocess,tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright
from preview_process import preview_launcher, read_startup_line

ROOT=Path(__file__).resolve().parent
state=Path(tempfile.mkdtemp(prefix='hermes-tools-ui-',dir='/tmp'));state.chmod(0o777)
(state/'native-home/cron').mkdir(parents=True);(state/'native-home/cron/jobs.json').write_text('{"jobs":[]}');(state/'native-home/config.yaml').write_text('auxiliary: {}\n')
env={**os.environ,'HOME':str(state),'PREVIEW_STATE_ROOT':str(state),'PREVIEW_PORT':'0','TEST_PYTHON':'/vol1/@apphome/hermes-agent/data/venv/bin/python3','PYTHONDONTWRITEBYTECODE':'1'}
os.environ['PLAYWRIGHT_BROWSERS_PATH']='/vol1/@apphome/hermes-agent/data/.cache/ms-playwright'
node='/vol1/@apphome/hermes-agent/data/node/bin/node';cmd=preview_launcher()+['env']+[f'{k}={env[k]}' for k in ('HOME','PREVIEW_STATE_ROOT','PREVIEW_PORT','TEST_PYTHON','PYTHONDONTWRITEBYTECODE')]+[node,str(ROOT/'preview-server.mjs')]
server=subprocess.Popen(cmd,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
try:
 first=read_startup_line(server)
 if not first:raise RuntimeError('预览服务没有启动：'+(server.stderr.read().strip() or '没有启动输出'))
 url='http://127.0.0.1:'+str(json.loads(first)['port']);print(first,flush=True)
 with sync_playwright() as p:
  browser=p.chromium.launch(args=['--no-sandbox']);context=browser.new_context(viewport={'width':1440,'height':900});errors=[];writes=[];config_writes=[];runtime_writes=[];runtime_enabled={'value':True};fail={'value':False,'offline':False,'config':False,'runtime':False,'runtime_read':False}
  def route_request(route):
   request=route.request
   if request.url.endswith('/proxy/dashboard/api/tools/toolsets'):
    if fail['offline'] or fail['runtime_read']:return route.fulfill(status=503,content_type='application/json',body='{"error":"隔离仪表盘不可用"}')
    return route.fulfill(status=200,content_type='application/json',body=json.dumps([
     {'name':'configured-tool','label':'可配置工具','enabled':True,'config_fields':[{'key':'token','label':'令牌','type':'password'}]},
     {'name':'plain-tool','label':'普通工具','enabled':runtime_enabled['value'],'config_fields':[]},
    ]))
   if request.url.endswith('/proxy/dashboard/api/tools/toolsets/configured-tool/config'):
    writes.append(json.loads(request.post_data or '{}'))
    return route.fulfill(status=500 if fail['value'] else 200,content_type='application/json',body='{"error":"fixture failure"}' if fail['value'] else '{"ok":true}')
   if request.url.endswith('/proxy/dashboard/api/tools/toolsets/plain-tool') and request.method=='PUT':
    body=json.loads(request.post_data or '{}');runtime_writes.append(body)
    if fail['runtime']: fail['runtime_read']=True
    if not (fail['offline'] or fail['runtime']):runtime_enabled['value']=bool(body.get('enabled'))
    return route.fulfill(status=503,content_type='application/json',body='{"error":"隔离仪表盘不可用"}') if fail['offline'] or fail['runtime'] else route.fulfill(status=200,content_type='application/json',body='{"ok":true}')
   if request.url.endswith('/api/config') and request.method=='POST':
    config_writes.append(json.loads(request.post_data or '{}'))
    return route.fulfill(status=503 if fail['config'] else 200,content_type='application/json',body='{"error":"隔离配置服务不可用"}' if fail['config'] else '{"ok":true,"restart_required":true}')
   if request.url.startswith(url):return route.continue_(url=request.url.replace('/app/hermes-agent/','/'))
   return route.abort()
  context.route('**/*',route_request);page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)));page.goto(url,wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'")
  page.evaluate("switchPage('extensions'); extSwitchTab(document.querySelector('#extTabs .ch-filter:nth-child(1)'),'tools')")
  page.wait_for_function("document.querySelector('#page-extensions').classList.contains('active') && document.querySelector('#ext-tools').classList.contains('active')")
  cards=page.locator('#toolsetList .ext-card');cards.first.wait_for();plain=cards.nth(1);assert plain.locator('button').count()==1
  configured=cards.nth(0);assert configured.get_by_role('button',name='配置').is_visible()
  page.evaluate("renderToolConfigModal('configured-tool')");modal=page.locator('#toolConfigModal');modal.wait_for(state='visible');assert modal.locator('#toolCfgEnable').count()==0
  modal.locator('input[data-key=token]').fill('fixture-token');fail['value']=True;modal.get_by_role('button',name='保存配置',exact=True).click();page.wait_for_timeout(250)
  assert modal.is_visible() and modal.locator('input[data-key=token]').input_value()=='fixture-token'
  if page.locator('#toast').count(): assert '工具配置未保存' in page.locator('#toast').inner_text()
  fail['value']=False;modal.get_by_role('button',name='保存配置',exact=True).click();page.wait_for_function("document.querySelector('#toolConfigModal').style.display==='none'")
  assert writes==[{'config':{'token':'fixture-token'}},{'config':{'token':'fixture-token'}}]
  fail['offline']=True;fail['config']=True
  page.evaluate("_cfg.extensions.toolsets['plain-tool']=false;renderToolsets()")
  page.wait_for_function("document.querySelector('#toolsetFeedback').textContent.includes('仪表盘工具状态暂不可用')")
  fallback_names=page.locator('#toolsetList .ext-card .name').all_text_contents()
  assert 'plain-tool' in fallback_names, {'feedback':page.locator('#toolsetFeedback').inner_text(),'names':fallback_names,'cards':page.locator('#toolsetList').inner_text()}
  fallback=page.locator('#toolsetList .ext-card').filter(has_text='plain-tool');fallback.wait_for()
  assert '配置未启用（待应用）' in fallback.inner_text()
  assert '以下显示的是已保存配置' in page.locator('#toolsetFeedback').inner_text()
  fallback.get_by_role('button',name='启用',exact=True).click()
  feedback=page.locator('#toolsetFeedback');feedback.wait_for(state='visible');page.wait_for_function("document.querySelector('#toolsetFeedback').textContent.includes('保存失败，已恢复原配置：')")
  assert config_writes and config_writes[-1].get('extensions',{}).get('toolsets',{}).get('plain-tool') is True,config_writes
  assert '配置未启用（待应用）' in fallback.inner_text()
  fail['config']=False
  fallback.get_by_role('button',name='启用',exact=True).click()
  page.wait_for_function("document.querySelector('#toolsetFeedback').textContent.includes('配置已保存')")
  assert config_writes[-1]['extensions']['toolsets']['plain-tool'] is True,config_writes[-1]
  fail['offline']=False
  page.evaluate("_cfg.extensions.toolsets['plain-tool']=false;renderToolsets()")
  page.wait_for_function("document.querySelector('#toolsetList .ext-card')?.dataset.toggleMode==='runtime'")
  runtime=page.locator('#toolsetList .ext-card').filter(has_text='普通工具')
  assert '重启后将关闭' in runtime.inner_text()
  runtime.get_by_role('button',name='同步重启配置',exact=True).click()
  page.wait_for_function("document.querySelector('#toolsetFeedback').textContent.includes('运行状态与重启配置已同步')")
  assert config_writes[-1]['extensions']['toolsets']['plain-tool'] is True
  fail['runtime']=True
  fail['runtime_read']=False
  page.evaluate("_cfg.extensions.toolsets['plain-tool']=true;renderToolsets()")
  page.wait_for_function("document.querySelector('#toolsetList .ext-card')?.dataset.toggleMode==='runtime'")
  runtime=page.locator('#toolsetList .ext-card').filter(has_text='普通工具')
  previous_saved=config_writes[-1]['extensions']['toolsets']['plain-tool']
  runtime.get_by_role('button',name='关闭',exact=True).click()
  page.wait_for_function("document.querySelector('#toolsetFeedback').textContent.includes('仪表盘状态更新失败')")
  assert page.locator('#toolsetList .ext-card[data-toolset-id="plain-tool"]').get_attribute('data-toggle-mode')=='saved'
  assert runtime_writes[-1]=={'enabled':False}
  assert config_writes[-1]['extensions']['toolsets']['plain-tool'] is previous_saved,config_writes[-1]
  fail['runtime']=False;fail['runtime_read']=False;fail['config']=False
  runtime=page.locator('#toolsetList .ext-card[data-toolset-id="plain-tool"]')
  runtime.get_by_role('button',name='关闭',exact=True).click()
  page.wait_for_function("document.querySelector('#toolsetFeedback').textContent.includes('工具配置已保存')")
  page.evaluate('renderToolsets()')
  page.wait_for_function("document.querySelector('#toolsetList .ext-card')?.dataset.toggleMode==='runtime'")
  page.locator('#toolsetList .ext-card[data-toolset-id="plain-tool"]').get_by_role('button',name='同步重启配置',exact=True).click()
  page.wait_for_function("document.querySelector('#toolsetFeedback').textContent.includes('运行状态与重启配置已同步')")
  fail['config']=True
  page.locator('#toolsetList .ext-card[data-toolset-id="plain-tool"]').get_by_role('button',name='关闭',exact=True).click()
  page.wait_for_function("document.querySelector('#toolsetFeedback').textContent.includes('运行状态已更新，但重启配置保存失败')")
  assert '运行状态已更新，但重启配置保存失败' in page.locator('#toolsetFeedback').inner_text()
  fail['config']=False
  page.locator('#toolsetList .ext-card[data-toolset-id="plain-tool"]').get_by_role('button',name='同步重启配置',exact=True).click()
  page.wait_for_function("document.querySelector('#toolsetFeedback').textContent.includes('运行状态与重启配置已同步')")
  page.evaluate("_toolNativeFallback=true;_toolNative=null;toggleToolset('plain-tool','runtime')")
  page.wait_for_function("document.querySelector('#toolsetFeedback').textContent.includes('仪表盘工具状态已变化')")
  assert runtime_writes[-1]=={'enabled':False},runtime_writes
  page.evaluate("_toolNativeFallback=false;_toolNative={'plain-tool':{name:'plain-tool',enabled:false}};_cfg.extensions.toolsets['plain-tool']=false;renderToolsets()")
  page.wait_for_function("document.querySelector('#toolsetList .ext-card[data-toolset-id=plain-tool]')?.dataset.runtimeEnabled==='false'")
  stale=page.locator('#toolsetList .ext-card[data-toolset-id="plain-tool"]')
  runtime_enabled['value']=True
  page.evaluate("_toolNative['plain-tool'].enabled=true")
  before_stale=len(runtime_writes)
  stale.get_by_role('button',name='启用',exact=True).click()
  page.wait_for_function("document.querySelector('#toolsetFeedback').textContent.includes('仪表盘中的工具状态已更新')")
  assert len(runtime_writes)==before_stale,runtime_writes
  before_sync=len(config_writes)
  page.evaluate("()=>syncToolsetConfig('plain-tool',false)")
  page.wait_for_function("document.querySelector('#toolsetFeedback').textContent.includes('仪表盘中的工具状态已更新')")
  sync_feedback=page.locator('#toolsetFeedback').inner_text()
  assert '仪表盘中的工具状态已更新' in sync_feedback,sync_feedback
  assert len(config_writes)==before_sync,config_writes
  assert not errors,errors;print(json.dumps({'only_configurable_tool_has_button':True,'no_duplicate_enable_toggle':True,'failed_save_keeps_draft':True,'success_closes_after_confirmation':True,'offline_fallback_labeled_as_saved_config':True,'failed_fallback_save_restores_prior_state':True,'runtime_saved_config_mismatch_is_explicit_and_syncable':True,'runtime_failure_falls_back_to_saved_config':True,'partial_runtime_success_requires_config_sync':True,'stale_runtime_action_fails_closed':True,'errors':errors},ensure_ascii=False),flush=True);browser.close()
finally:
 try:os.killpg(server.pid,signal.SIGTERM)
 except ProcessLookupError:pass
 try:server.wait(timeout=8)
 except subprocess.TimeoutExpired:
  try:os.killpg(server.pid,signal.SIGKILL)
  except ProcessLookupError:pass
  server.wait(timeout=8)
