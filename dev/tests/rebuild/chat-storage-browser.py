"""Streaming tool history survives DOM replacement and cancellation."""
import os,json,signal,subprocess,tempfile,time
from pathlib import Path
from playwright.sync_api import sync_playwright
from preview_process import preview_launcher, read_startup_line
ROOT=Path(__file__).resolve().parent
state=Path(tempfile.mkdtemp(prefix='hermes-chat-storage-',dir='/tmp'));state.chmod(0o777);(state/'native-home/cron').mkdir(parents=True);(state/'native-home/cron/jobs.json').write_text('{"jobs":[]}');(state/'native-home/config.yaml').write_text('auxiliary: {}\n')
env={**os.environ,'HOME':str(state),'PREVIEW_STATE_ROOT':str(state),'PREVIEW_PORT':'0','TEST_PYTHON':'/vol1/@apphome/hermes-agent/data/venv/bin/python3','PYTHONDONTWRITEBYTECODE':'1'}
os.environ['PLAYWRIGHT_BROWSERS_PATH']='/vol1/@apphome/hermes-agent/data/.cache/ms-playwright'
node='/vol1/@apphome/hermes-agent/data/node/bin/node';cmd=preview_launcher()+['env']+[f'{key}={env[key]}' for key in ('HOME','PREVIEW_STATE_ROOT','PREVIEW_PORT','TEST_PYTHON','PYTHONDONTWRITEBYTECODE')]+[node,str(ROOT/'preview-server.mjs')]
server=subprocess.Popen(cmd,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
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
   context=browser.new_context(viewport={'width':width,'height':height},accept_downloads=True);headers={'X-Monitor-Token':'fixture-token'}
   context.route('**/*',lambda r:r.continue_(url=r.request.url.replace('/app/hermes-agent/','/')) if r.request.url.startswith(url) else r.abort())
   page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   page.goto(url,wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'")
   attachment_check=page.evaluate("""()=>{
     const safeName='方案 & 预算.txt';
     const immediate=msgHTML({role:'user',content:buildMessageContent('请检查文件',[{url:'/uploads/files/1730000000000_012345abcdef_'+safeName,type:'text/plain',name:safeName}])});
     const persisted=msgHTML({role:'user',content:'请检查文件\\n\\n### 文件: 1730000000000_012345abcdef_方案 & 预算.txt [12B]\\n已保存到本机路径: /tmp/uploads/1730000000000_012345abcdef_方案 & 预算.txt\\n你读取此文件并分析'});
     const hostile=msgHTML({role:'user',content:buildMessageContent('',[{url:'/uploads/files/x',type:'text/plain',name:'<img src=x onerror=alert(1)>.txt'}])});
     return {immediate,persisted,hostile};
   }""")
   assert '方案 &amp; 预算.txt' in attachment_check['immediate'],'sent file name missing from immediate durable turn'
   assert '方案 &amp; 预算.txt' in attachment_check['persisted'],'historical uploaded file name missing after reload'
   assert '1730000000000_' not in attachment_check['persisted'],'storage prefix leaked into historical attachment label'
   assert '&lt;img src=x onerror=alert(1)&gt;.txt' in attachment_check['hostile'] and '<img src=x' not in attachment_check['hostile'],'attachment name was not escaped'
   page.evaluate("currentSession='test-a';_openTabs=['test-a','test-b'];persistTabs();renderSessionTabs();restoreDraft('test-a');loadSessionMessages('test-a')")
   # The send button clears the input before entering sendRaw. A recovery-write
   # failure must restore it and must not send anything to the queue.
   page.evaluate("()=>{window.originalStorageSet=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==='panel-send-recovery')throw new DOMException('fixture quota','QuotaExceededError');return originalStorageSet.call(this,k,v)};}")
   text='发送前存储失败 '+str(width);before=context.request.get(url+'/__fixture/stats').json()['executions']
   page.locator('#chatInput').fill(text);page.evaluate('sendChat()');page.wait_for_timeout(500)
   assert page.locator('#chatInput').input_value()==text,'input lost when recovery storage failed'
   assert context.request.get(url+'/__fixture/stats').json()['executions']==before
   page.evaluate("()=>{Storage.prototype.setItem=originalStorageSet;}")
   # Reject only deletion of an accepted outbox item. HTTP acceptance still
   # owns execution state, and reconnect retries retain the same request ID.
   page.evaluate("()=>{Storage.prototype.setItem=function(k,v){if(k==='panel-message-outbox-v2'&&v==='{}')throw Error('fixture cleanup failure');return originalStorageSet.call(this,k,v)};}")
   text='接收后清理失败 '+str(width);page.locator('#chatInput').fill(text);page.evaluate('sendChat()')
   deadline=time.monotonic()+12;matches=[]
   while time.monotonic()<deadline:
    matches=[j for j in context.request.get(url+'/api/chat/queue?all=1',headers=headers).json()['jobs'] if (j.get('message') or {}).get('text')==text]
    if len(matches)==1 and matches[0]['status']=='done':break
    page.wait_for_timeout(100)
   assert len(matches)==1 and matches[0]['status']=='done',matches
   jid=matches[0]['id'];node=page.locator('.msg.assistant[data-request-id="'+jid+'"]');page.wait_for_timeout(500)
   assert '暂时无法确认接收' not in node.inner_text(),'accepted message misreported as unconfirmed'
   assert text in node.inner_text()
   page.evaluate("()=>{Storage.prototype.setItem=originalStorageSet;}")
   page.reload(wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'");page.evaluate("currentSession='test-a';restoreDraft('test-a');loadSessionMessages('test-a')")
   page.wait_for_function("Object.keys(JSON.parse(localStorage.getItem('panel-message-outbox-v2')||'{}')).length===0")
   assert context.request.get(url+'/__fixture/stats').json()['executions'].count(jid)==1
   # With both durable copies unavailable, warn before navigation; after the
   # server returns, the same draft syncs and the guard clears.
   page.evaluate("()=>{window.originalStorageSet=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('panel-draft-v2:'))throw Error('draft quota');return originalStorageSet.call(this,k,v)};}")
   context.route('**/api/workspace-ui/draft*',lambda route:route.abort())
   draft='双重存储失败需保留 '+str(width);page.locator('#chatInput').fill(draft)
   page.locator('#draftDurabilityStatus').filter(has_text='草稿尚未保存到设备或服务器').wait_for()
   guarded=page.evaluate("()=>{const e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented}")
   assert guarded,'navigation was not blocked while both draft stores failed'
   context.unroute('**/api/workspace-ui/draft*')
   page.evaluate("()=>{window.dispatchEvent(new Event('online'));}")
   deadline=time.monotonic()+10
   while time.monotonic()<deadline:
    recovered=context.request.get(url+'/api/workspace-ui/draft?session_id=test-a',headers=headers).json()
    if recovered.get('text')==draft:break
    page.wait_for_timeout(100)
   assert recovered.get('text')==draft,'draft was not synced after storage recovered'
   assert not page.evaluate("()=>{const e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented}"),'navigation guard remained after server save'
   assert '草稿已同步到服务器' in page.locator('#draftDurabilityStatus').inner_text()
   page.evaluate("()=>{Storage.prototype.setItem=originalStorageSet;}")
   # Draft upload must continue even when its synchronous local copy fails.
   page.evaluate("()=>{window.originalStorageSet=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('panel-draft-v2:'))throw Error('draft quota');return originalStorageSet.call(this,k,v)};}")
   draft='本机失败仍同步草稿 '+str(width);page.locator('#chatInput').fill(draft)
   deadline=time.monotonic()+10
   while time.monotonic()<deadline:
    saved=context.request.get(url+'/api/workspace-ui/draft?session_id=test-a',headers=headers).json()
    if saved['text']==draft:break
    page.wait_for_timeout(100)
   assert saved['text']==draft
   page.evaluate("()=>{Storage.prototype.setItem=originalStorageSet;}")
   # Server commits the request but the client receives 503. The same outbox ID
   # survives reload and is reconciled, never executed twice.
   lost={'enabled':True};posted=[]
   def lose_ack(route):
    if route.request.method=='POST' and lost['enabled']:
     posted.append(route.request.post_data_json['request_id']);route.fetch(url=route.request.url.replace('/app/hermes-agent/','/'));route.fulfill(status=503,json={'error':'fixture lost acknowledgement'})
    else:route.fallback()
   context.route('**/api/chat/queue',lose_ack)
   text='回执丢失后恢复 '+str(width);page.locator('#chatInput').fill(text);page.evaluate('sendChat()')
   page.wait_for_function("document.querySelector('#durableQueue').textContent.includes('等待连接确认') || document.querySelector('#chatBody').textContent.includes('暂时无法确认接收')")
   assert posted;request_id=posted[0];assert request_id in page.evaluate("JSON.parse(localStorage.getItem('panel-message-outbox-v2'))")
   lost['enabled']=False;page.reload(wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'")
   page.wait_for_function("Object.keys(JSON.parse(localStorage.getItem('panel-message-outbox-v2')||'{}')).length===0")
   deadline=time.monotonic()+10
   while time.monotonic()<deadline:
    job=context.request.get(url+'/api/chat/queue/'+request_id,headers=headers).json()
    if job['status']=='done':break
    page.wait_for_timeout(100)
   assert job['status']=='done';assert context.request.get(url+'/__fixture/stats').json()['executions'].count(request_id)==1
   assert not errors,errors
   print(json.dumps({'viewport':[width,height],'presend_quota_restores_input':True,'accepted_cleanup_failure_not_uncertain':True,'reload_no_duplicate_execution':True,'draft_quota_still_syncs':True,'lost_ack_reload_once':True,'errors':errors}),flush=True)
   context.close()
  browser.close()
finally:
 stop_server()
