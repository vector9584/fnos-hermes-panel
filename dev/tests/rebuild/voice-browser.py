"""Mock only TTS upstream, serve actual panel in /tmp. Never synthesize externally."""
import json,os,signal,subprocess,tempfile,sys
from pathlib import Path
from playwright.sync_api import sync_playwright
from preview_process import preview_launcher, read_startup_line
ROOT=Path(__file__).resolve().parents[3];state=Path(tempfile.mkdtemp(prefix='hermes-voice-preview-',dir='/tmp'));state.chmod(0o777);(state/'native-home/cron').mkdir(parents=True);(state/'native-home/cron/jobs.json').write_text('{"jobs":[]}');(state/'native-home/config.yaml').write_text('auxiliary: {}\n')
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
   context=browser.new_context(viewport={'width':width,'height':height});page=context.new_page();calls=[];pending=[];errors=[];saved=[];page.on('pageerror',lambda e:errors.append(str(e)))
   def route(r):
    path=r.request.url.replace('/app/hermes-agent/','/')
    if not path.startswith(url):return r.abort()
    if '/api/workspace-ui/voice' in path and r.request.method=='PUT':
     saved.append(r.request.post_data_json)
     if len(saved)==1:return r.fulfill(status=409,json={'error':'朗读偏好已在别处修改，输入已保留，请核对最新设置'})
     return r.fulfill(json={'ok':True})
    if '/api/workspace-ui/voice' in path:return r.fulfill(json={'ok':True,'voices':[{'id':'fixture','name':'测试声音'}],'current':{'id':'fixture','emo_auto':True},'preferences':{'engine':'windows','fallback':True,'system_voice':'zh-CN-XiaoxiaoNeural'},'preference_revision':'fixture-pref','bridge_revision':'fixture-bridge','last_save':{'status':'none'}})
    if '/api/studio/security' in path:return r.fulfill(json={'enabled':False})
    if '/api/voice/config' in path:return r.fulfill(json={'voices':[{'id':'zh-CN-XiaoxiaoNeural','name':'晓晓'}]})
    if '/api/workspace-ui/speech-cancel' in path:calls.append(('cancel',r.request.post_data_json));return r.fulfill(json={'ok':True})
    if '/api/workspace-ui/speak' in path:calls.append(('speak',r.request.post_data_json));pending.append(r);return
    if '/api/workspace-ui/preferences' in path and r.request.method=='PUT' and 'voice' in r.request.post_data_json:calls.append(('save',r.request.post_data_json))
    return r.continue_(url=path)
   context.route('**/*',route);page.goto(url,wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'");page.evaluate('openVoiceSettings()');page.locator('#pwVoiceId').select_option('fixture');page.locator('#pwVoiceFallback').uncheck();page.locator('#pwOverlay .modal-close').click();page.reload(wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'");page.evaluate('openVoiceSettings()');page.locator('#pwVoiceId').select_option('fixture');assert not page.locator('#pwVoiceFallback').is_checked();assert not page.locator('#pwGuard').count();page.locator('#pwSaveVoice').click();page.get_by_text('朗读偏好已在别处修改，输入已保留，请核对最新设置 (HTTP 409)',exact=True).wait_for();assert not page.locator('#pwVoiceFallback').is_checked();page.once('dialog',lambda dialog:dialog.accept());page.locator('#pwVoiceReview').click();page.get_by_text('已核对最新版本，请检查输入后保存。',exact=True).wait_for();page.locator('#pwSaveVoice').click();page.locator('#pwOverlay').wait_for(state='detached');assert len(saved)==2;assert saved[1]['preferences']['fallback'] is False;assert 'windows' not in saved[1];assert page.evaluate("localStorage.getItem('panel-voice-draft')") is None;page.evaluate('openVoiceSettings()');page.locator('#pwVoiceId').select_option('fixture');page.locator('#pwVoiceTest').click();page.wait_for_function("document.querySelector('#pwVoiceTest').textContent==='合成中…'");page.locator('#pwOverlay .modal-close').click();page.wait_for_timeout(300)
   assert [kind for kind,_ in calls]==['speak','cancel'],calls;assert calls[0][1]['request_id']==calls[1][1]['request_id'];assert not page.locator('#pwOverlay').count();assert not errors,errors
   for held in pending:
    try:held.abort()
    except Exception:pass
   results.append({'viewport':[width,height],'draft_reload':True,'conflict_keeps_input':True,'review_then_save':True,'preview_does_not_save':True,'close_cancels_same_request':True,'errors':errors});context.close()
  browser.close()
 print(json.dumps(results,ensure_ascii=False),flush=True)
finally:
 if server.poll() is None:
  try:os.killpg(server.pid,signal.SIGTERM);server.wait(timeout=8)
  except (ProcessLookupError,subprocess.TimeoutExpired):
   try:os.killpg(server.pid,signal.SIGKILL)
   except ProcessLookupError:pass
   server.wait(timeout=8)
