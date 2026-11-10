"""Full panel UI, delayed/failing fixture APIs. No real workbench writes."""
import json,os,signal,subprocess,tempfile,sys
from pathlib import Path
from playwright.sync_api import sync_playwright
from preview_process import preview_launcher, read_startup_line
ROOT=Path(__file__).resolve().parents[3];state=Path(tempfile.mkdtemp(prefix='hermes-voice-save-',dir='/tmp'));state.chmod(0o777);(state/'native-home/cron').mkdir(parents=True);(state/'native-home/cron/jobs.json').write_text('{"jobs":[]}');(state/'native-home/config.yaml').write_text('auxiliary: {}\n')
env={**os.environ,'HOME':str(state),'PREVIEW_STATE_ROOT':str(state),'PREVIEW_PORT':'0','TEST_PYTHON':'/vol1/@apphome/hermes-agent/data/venv/bin/python3','PYTHONDONTWRITEBYTECODE':'1'};os.environ['PLAYWRIGHT_BROWSERS_PATH']='/vol1/@apphome/hermes-agent/data/.cache/ms-playwright'
node='/vol1/@apphome/hermes-agent/data/node/bin/node';cmd=preview_launcher()+['env']+[f'{k}={env[k]}' for k in ('HOME','PREVIEW_STATE_ROOT','PREVIEW_PORT','TEST_PYTHON','PYTHONDONTWRITEBYTECODE')]+[node,str(ROOT/'dev/tests/rebuild/preview-server.mjs')]
server=subprocess.Popen(cmd,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True);results=[]
try:
 first=read_startup_line(server)
 if not first:raise RuntimeError('预览服务没有启动：'+(server.stderr.read().strip() or '没有启动输出'))
 info=json.loads(first);url='http://127.0.0.1:'+str(info['port']);print(first,flush=True)
 with sync_playwright() as p:
  browser=p.chromium.launch(args=['--no-sandbox'])
  for width,height in [(1440,900),(390,844),(844,390)]:
   context=browser.new_context(viewport={'width':width,'height':height});page=context.new_page();held=[];saved=[];calls=[];errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   def route(r):
    path=r.request.url.replace('/app/hermes-agent/','/')
    if not path.startswith(url):return r.abort()
    if '/api/workspace-ui/voice' in path and r.request.method=='PUT':saved.append(r.request.post_data_json);held.append(r);return
    if '/api/workspace-ui/voice' in path:return r.fulfill(json={'ok':True,'voices':[{'id':'fixture','name':'测试声音'},{'id':'other','name':'另一声音'}],'current':{'id':'fixture','emo_auto':True},'preferences':{'engine':'windows','fallback':True,'system_voice':'zh-CN-XiaoxiaoNeural'},'preference_revision':'pref1','bridge_revision':'bridge1','bridge_warning':'当前音色已选中，但参考音频尚未成功推送到Windows，请在语音工作台重试推送后再试听','last_save':{'status':'none'}})
    if '/api/studio/security' in path:return r.fulfill(json={'enabled':False})
    if '/api/voice/config' in path:return r.fulfill(json={'voices':[]})
    if path.endswith('/api/workspace-ui/speak') or path.endswith('/api/workspace-ui/system-speak'):
     calls.append({'path':path,'body':r.request.post_data_json})
     if path.endswith('/api/workspace-ui/speak'):return r.fulfill(status=503,json={'error':'模拟 Windows 合成失败'})
     return r.fulfill(body=b'fixture audio'*20,headers={'Content-Type':'audio/mpeg','X-Speech-Engine':'edge'})
    return r.continue_(url=path)
   context.route('**/*',route);page.goto(url,wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'");page.evaluate("HTMLMediaElement.prototype.play=function(){return Promise.resolve()}");page.evaluate('openVoiceSettings()');page.locator('#pwVoiceId').select_option('fixture');assert '尚未成功推送' in page.locator('#pwVoiceHint').inner_text();page.locator('#pwVoiceFallback').uncheck();page.locator('#pwVoiceRate').select_option('1.3')
   page.evaluate("() => {window.originalVoiceSet=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==='pw_voice_rate')throw Error('fixture storage denied');return originalVoiceSet.call(this,k,v)}}")
   page.locator('#pwSaveVoice').click();page.wait_for_timeout(150);assert len(held)==1
   page.keyboard.press('Escape');page.locator('#pwOverlay').dispatch_event('click');assert page.locator('#pwOverlay').count()==1;assert page.locator('#pwSaveVoice').is_disabled();assert len(saved)==1
   held.pop().fulfill(json={'ok':True,'preference_revision':'pref2','bridge_revision':'bridge1'})
   page.get_by_text('服务端声音设置已保存；本浏览器的播放速度或语音开关未全部保存，请恢复浏览器存储后重试保存。',exact=True).wait_for();assert page.locator('#pwVoiceRate').input_value()=='1.3'
   draft=page.evaluate("JSON.parse(localStorage.getItem('panel-voice-draft'))");assert draft['base']['preference_revision']=='pref2';assert draft['values']['pwVoiceFallback'] is False
   page.evaluate("() => {Storage.prototype.setItem=originalVoiceSet}");page.locator('#pwSaveVoice').click();page.locator('#pwOverlay').wait_for(state='detached');assert len(saved)==1;assert page.evaluate("localStorage.getItem('pw_voice_rate')")=='1.3';assert page.evaluate("localStorage.getItem('panel-voice-draft')") is None
   page.evaluate('openVoiceSettings()');page.locator('#pwVoiceEngine').select_option('system');page.locator('#pwSystemVoice').select_option('zh-CN-YunxiNeural');page.locator('#pwVoiceTest').click();page.get_by_text('试听播放中：系统音色 zh-CN-YunxiNeural',exact=True).wait_for();assert calls[-1]['path'].endswith('/system-speak') and calls[-1]['body']['voice']=='zh-CN-YunxiNeural';assert len(saved)==1
   page.locator('#pwVoiceEngine').select_option('windows');page.locator('#pwVoiceId').select_option('other');page.locator('#pwVoiceTest').click();page.locator('#pwVoiceSaveStatus').get_by_text('当前 Windows 音色尚未保存',exact=False).wait_for();assert len(calls)==1 and len(saved)==1
   page.locator('#pwVoiceId').select_option('fixture');page.locator('#pwVoiceFallback').check();page.locator('#pwVoiceTest').click();page.get_by_text('试听播放中：系统音色 zh-CN-YunxiNeural',exact=True).wait_for();assert [call['path'].rsplit('/',1)[-1] for call in calls[-2:]]==['speak','system-speak'];assert calls[-1]['body']['voice']=='zh-CN-YunxiNeural';assert len(saved)==1
   assert not errors,errors;results.append({'viewport':[width,height],'push_warning':True,'close_guard':True,'partial_save_explicit':True,'retry_does_not_resend':True,'preview_uses_selected_engine_and_voice':True,'unsaved_shared_windows_voice_blocked':True,'selected_system_fallback_verified':True,'errors':errors});context.close()
  browser.close()
 print(json.dumps(results,ensure_ascii=False),flush=True)
finally:
 if server.poll() is None:
  try:os.killpg(server.pid,signal.SIGTERM);server.wait(timeout=8)
  except (ProcessLookupError,subprocess.TimeoutExpired):
   try:os.killpg(server.pid,signal.SIGKILL)
   except ProcessLookupError:pass
   server.wait(timeout=8)
