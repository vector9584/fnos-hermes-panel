"""Exercise actual speakMsg with simulated synthesis/audio, never external TTS."""
import json,os,signal,subprocess,tempfile,sys
from pathlib import Path
from playwright.sync_api import sync_playwright
from preview_process import preview_launcher, read_startup_line
ROOT=Path(__file__).resolve().parents[3];state=Path(tempfile.mkdtemp(prefix='hermes-fallback-preview-',dir='/tmp'));(state/'native-home/cron').mkdir(parents=True);(state/'native-home/cron/jobs.json').write_text('{"jobs":[]}');(state/'native-home/config.yaml').write_text('auxiliary: {}\n')
state.chmod(0o777);env={**os.environ,'HOME':str(state),'PREVIEW_STATE_ROOT':str(state),'PREVIEW_PORT':'0','TEST_PYTHON':'/vol1/@apphome/hermes-agent/data/venv/bin/python3','PYTHONDONTWRITEBYTECODE':'1'};os.environ['PLAYWRIGHT_BROWSERS_PATH']='/vol1/@apphome/hermes-agent/data/.cache/ms-playwright'
node='/vol1/@apphome/hermes-agent/data/node/bin/node';cmd=preview_launcher()+['env']+[f'{k}={env[k]}' for k in ('HOME','PREVIEW_STATE_ROOT','PREVIEW_PORT','TEST_PYTHON','PYTHONDONTWRITEBYTECODE')]+[node,str(ROOT/'dev/tests/rebuild/preview-server.mjs')]
server=subprocess.Popen(cmd,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True);results=[]
try:
 first=read_startup_line(server)
 if not first:raise RuntimeError('预览服务没有启动：'+(server.stderr.read().strip() or '没有启动输出'))
 info=json.loads(first);url='http://127.0.0.1:'+str(info['port']);print(first,flush=True)
 with sync_playwright() as p:
  browser=p.chromium.launch(args=['--no-sandbox'])
  for width,height in [(1440,900),(390,844),(844,390)]:
   for engine,fallback,windows_ok,system_ok,expected in [('windows',True,True,True,'Windows'),('windows',True,False,True,'系统'),('windows',True,False,False,'浏览器'),('windows',False,False,True,'停止'),('system',True,False,False,'浏览器')]:
    context=browser.new_context(viewport={'width':width,'height':height});page=context.new_page();calls=[];errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    def route(r):
     path=r.request.url.replace('/app/hermes-agent/','/')
     if not path.startswith(url):return r.abort()
     if path.endswith('/api/workspace-ui'):
      response=r.fetch(url=path);body=response.json();body['voice']={'engine':engine,'fallback':fallback,'system_voice':'zh-CN-XiaoxiaoNeural'};return r.fulfill(json=body)
     if path.endswith('/api/workspace-ui/speak') or path.endswith('/api/workspace-ui/system-speak'):
      which='system' if path.endswith('/system-speak') else 'windows';calls.append(which);success=system_ok if which=='system' else windows_ok
      if not success:return r.fulfill(status=503,json={'error':'模拟合成失败'})
      return r.fulfill(body=b'fixture audio'*20,headers={'Content-Type':'audio/mpeg','X-Speech-Engine':'edge' if which=='system' else 'windows'})
     return r.continue_(url=path)
    context.route('**/*',route);page.goto(url,wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'")
    page.evaluate("""() => {window.voiceGetText=()=> '测试朗读';window._bargeInStart=()=>{};window._bargeInStop=()=>{};window.Audio=class{async play(){} pause(){}};window.browserSpeeches=[];Object.defineProperty(window,'speechSynthesis',{configurable:true,value:{cancel(){},speak(v){browserSpeeches.push(v.text)}}});window.SpeechSynthesisUtterance=class{constructor(text){this.text=text}};const b=document.createElement('button');b.id='fixtureSpeech';document.body.append(b);} """)
    page.evaluate("speakMsg(document.querySelector('#fixtureSpeech'))")
    if expected=='停止':
     assert calls==['windows'],calls;assert page.evaluate('browserSpeeches.length')==0;assert page.locator('#fixtureSpeech').get_attribute('data-speech-status')=='播放回复'
    else:
     assert page.locator('#fixtureSpeech').get_attribute('data-speech-status')==expected+'朗读中，点击停止';assert page.evaluate('browserSpeeches.length')==(1 if expected=='浏览器' else 0)
    if engine=='windows' and fallback and not windows_ok:assert calls==['windows','system'],calls
    page.evaluate('voiceStopAll(true)');assert page.locator('#fixtureSpeech').get_attribute('data-speech-status')=='播放回复';assert not errors,errors;results.append({'viewport':[width,height],'engine':engine,'fallback':fallback,'actual':expected,'requests':calls,'errors':errors});context.close()
  browser.close()
 print(json.dumps(results,ensure_ascii=False),flush=True)
finally:
 if server.poll() is None:
  try:os.killpg(server.pid,signal.SIGTERM);server.wait(timeout=8)
  except (ProcessLookupError,subprocess.TimeoutExpired):
   try:os.killpg(server.pid,signal.SIGKILL)
   except ProcessLookupError:pass
   server.wait(timeout=8)
