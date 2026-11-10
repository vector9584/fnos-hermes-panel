"""Browser acceptance for title-aware /new, safe /plan and session personality picker."""
import json, os, signal, subprocess, tempfile, time
from pathlib import Path
from playwright.sync_api import sync_playwright
from preview_process import preview_launcher, read_startup_line


def get_json_with_retry(request, url, headers, retries=1):
 last_error=None
 for attempt in range(retries+1):
  try:
   response=request.get(url,headers=headers,timeout=5000)
   if not response.ok: raise RuntimeError('HTTP '+str(response.status))
   return response.json()
  except Exception as error:
   last_error=error
   if attempt>=retries or server.poll() is not None: break
   time.sleep(.15)
 raise AssertionError('preview API request failed after retry: '+str(last_error))

ROOT = Path(__file__).resolve().parent
state = Path(tempfile.mkdtemp(prefix='hermes-chat-slash-', dir='/tmp')); state.chmod(0o777)
(state/'native-home/cron').mkdir(parents=True); (state/'native-home/cron/jobs.json').write_text('{"jobs":[]}'); (state/'native-home/config.yaml').write_text('auxiliary: {}\n')
env = {**os.environ, 'HOME': str(state), 'PREVIEW_STATE_ROOT': str(state), 'PREVIEW_PORT': '0', 'TEST_PYTHON':'/vol1/@apphome/hermes-agent/data/venv/bin/python3', 'PYTHONDONTWRITEBYTECODE':'1'}
os.environ['PLAYWRIGHT_BROWSERS_PATH']='/vol1/@apphome/hermes-agent/data/.cache/ms-playwright'
node='/vol1/@apphome/hermes-agent/data/node/bin/node';cmd=preview_launcher()+['env']+[f'{k}={env[k]}' for k in ('HOME','PREVIEW_STATE_ROOT','PREVIEW_PORT','TEST_PYTHON','PYTHONDONTWRITEBYTECODE')]+[node,str(ROOT/'preview-server.mjs')]
server=subprocess.Popen(cmd,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
try:
 first=read_startup_line(server)
 if not first: raise RuntimeError('预览服务没有启动：'+(server.stderr.read().strip() or '没有启动输出'))
 url='http://127.0.0.1:'+str(json.loads(first)['port']);print(first,flush=True)
 with sync_playwright() as p:
  browser=p.chromium.launch(args=['--no-sandbox'])
  for width,height in [(1440,900),(390,844),(844,390)]:
   context=browser.new_context(viewport={'width':width,'height':height});headers={'X-Monitor-Token':'fixture-token'}
   context.route('**/*',lambda r:r.continue_(url=r.request.url.replace('/app/hermes-agent/','/')) if r.request.url.startswith(url) else r.abort())
   page=context.new_page();errors=[];responses=[];requests=[];page.on('pageerror',lambda e:errors.append(str(e)+'\n'+str(getattr(e,'stack',''))));page.on('response',lambda r: responses.append((r.url,r.status)) if '/api/workspace-ui/session' in r.url else None);page.on('request',lambda r: requests.append((r.url,r.post_data)) if '/api/workspace-ui/session' in r.url else None);page.goto(url,wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'")
   page.evaluate("openMini(document.getElementById('btnQuick'),'quick')")
   quick=page.locator('#miniPopup')
   assert quick.get_by_text('新建会话',exact=True).count()==1
   assert quick.get_by_text('编写计划',exact=True).count()==1
   assert quick.get_by_text('YOLO 模式',exact=True).count()==0
   assert '未在此列出的命令将直接转发' not in quick.inner_text()
   page.evaluate("handleSlashCommand('/yolo')")
   assert page.locator('#chatInput').input_value()=='/yolo', 'unknown slash commands must stay in the draft'
   assert not any('/api/chat/queue' in item[0] for item in requests), 'unknown slash commands must not dispatch a model request'
   page.evaluate("closeMini()")
   page.evaluate("currentSession='test-a';_openTabs=['test-a'];persistTabs();renderSessionTabs();loadSessionMessages('test-a')")
   page.evaluate("openMini(document.getElementById('btnQuick'),'quick')")
   page.get_by_text('新建会话',exact=True).click()
   dialog=page.locator('#pwOverlay');assert dialog.locator('#pwCreateTitle').input_value()==''
   dialog.locator('#pwCreateTitle').fill('快捷入口方案验收');dialog.get_by_role('button',name='创建会话').click();page.wait_for_timeout(500)
   sessions=get_json_with_retry(context.request,url+'/api/sessions',headers)['sessions'];created=next(s for s in sessions if s.get('title')=='快捷入口方案验收');assert created['message_count']==0
   page.evaluate("openNewSessionModal()")
   new_dialog=page.locator('#newSessionOverlay');new_dialog.locator('#nsPersonality').wait_for(state='visible')
   page.wait_for_function("document.querySelectorAll('#nsPersonality option').length>=2")
   new_dialog.locator('#nsPersonality').select_option('technical')
   with page.expect_response(lambda r: '/api/workspace-ui/session' in r.url and 'technical' in (r.request.post_data or ''), timeout=10000):
    new_dialog.get_by_role('button',name='创建').click()
   page.wait_for_function("document.getElementById('newSessionOverlay')===null")
   session_meta=get_json_with_retry(context.request,url+'/api/workspace-ui',headers)['sessions'];created_with_style=[(sid,m) for sid,m in session_meta.items() if m.get('personality')=='technical'];assert created_with_style,{'sessions':session_meta,'new_session':page.evaluate('currentSession'),'requests':requests,'responses':responses}
   page.evaluate('closeNewSessionModal()');page.wait_for_function("document.getElementById('newSessionOverlay')===null")
   page.evaluate("openTab('test-a');loadSessionMessages('test-a')")
   page.evaluate("openMini(document.getElementById('btnQuick'),'quick')")
   page.get_by_text('编写计划',exact=True).click()
   plan_dialog=page.locator('#pwOverlay');plan_dialog.locator('#pwActionInput').fill('设计一个可回滚的备份方案')
   plan_dialog.get_by_role('button',name='确定').click()
   deadline=time.monotonic()+10;matches=[]
   while time.monotonic()<deadline:
    jobs=get_json_with_retry(context.request,url+'/api/chat/queue?all=1',headers)['jobs'];matches=[j for j in jobs if j['session_id']=='test-a' and '可回滚的备份方案' in str(j.get('message'))]
    if matches: break
    page.wait_for_timeout(100)
   assert matches and all('/plan' not in str(j.get('message')) for j in matches),matches
   assert '请先为下面的请求编写可审阅的执行计划' in str(matches[0].get('message'))
   # The old toolbar role tab must update only this session's overlay, not activate a global Profile.
   before=page.evaluate("_profiles.find(p=>p.is_active)?.id||'default'")
   calls=[]
   page.evaluate("()=>{window.__profileActivations=0;const original=window.selectPersona;window.selectPersona=function(){window.__profileActivations++;return original.apply(this,arguments)}}")
   page.evaluate("openMini(document.getElementById('btnExpert'),'expert');switchExpertPickerTab('persona')")
   assert page.get_by_role('button',name='设置本会话表达风格').count()==1
   page.get_by_role('button',name='设置本会话表达风格').click()
   personality=page.locator('#pwOverlay')
   session_id=page.evaluate('currentSession')
   expected_personality=get_json_with_retry(context.request,url+'/api/workspace-ui',headers)['sessions'].get(session_id,{}).get('personality') or 'default'
   assert personality.locator('#pwPersonality').input_value()==expected_personality
   personality.locator('#pwPersonality').select_option('teacher')
   page.evaluate("""() => {
    window.__failPersonalitySave=true;
    const original=window.fetch.bind(window);
    window.fetch=function(input,init){
      const url=typeof input==='string'?input:input.url,body=init?.body||'';
      if(window.__failPersonalitySave&&url.includes('/api/workspace-ui/session')&&body.includes('teacher')){
        window.__failPersonalitySave=false;
        return Promise.resolve(new Response(JSON.stringify({error:'夹具模拟保存失败'}),{status:503,headers:{'Content-Type':'application/json'}}));
      }
      return original(input,init);
    };
   }""")
   personality.get_by_role('button',name='保存').click()
   page.get_by_text('夹具模拟保存失败',exact=False).wait_for()
   assert personality.is_visible(), '失败保存不应关闭表达风格弹窗'
   assert personality.get_by_role('button',name='保存').is_enabled()
   personality.get_by_role('button',name='保存').click()
   page.wait_for_function("document.getElementById('pwOverlay')===null")
   meta=None;last_error=None
   for attempt in range(4):
    try:
     response=context.request.get(url+'/api/workspace-ui',headers=headers,timeout=5000)
     if response.ok:meta=response.json()['sessions'][session_id];break
     last_error='HTTP '+str(response.status)
    except Exception as error:last_error=str(error)
    if server.poll() is not None:raise AssertionError('preview process exited during slash acceptance: '+repr(server.poll())+'; '+str(last_error))
    page.wait_for_timeout(150)
   if meta is None:raise AssertionError('workspace session read failed after retries: '+str(last_error))
   assert meta['personality']=='teacher',meta
   assert page.evaluate('window.__profileActivations')==0
   assert page.evaluate("_profiles.find(p=>p.is_active)?.id||'default'")==before
   assert not errors,errors
   assert not errors,errors
   print(json.dumps({'viewport':[width,height],'new_title_persisted':True,'new_session_personality_persisted':True,'plan_is_explicit_request':True,'raw_slash_not_sent':True,'session_personality_persisted':True,'global_profile_unchanged':True,'errors':errors},ensure_ascii=False),flush=True);context.close()
  browser.close()
finally:
 if server.poll() is None:
  try: os.killpg(server.pid,signal.SIGTERM);server.wait(timeout=8)
  except (ProcessLookupError,subprocess.TimeoutExpired):
   try: os.killpg(server.pid,signal.SIGKILL)
   except ProcessLookupError: pass
   server.wait(timeout=8)
