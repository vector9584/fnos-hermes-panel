"""Real room store/runner in preview, simulated member responses and isolated legacy history."""
import os,json,signal,subprocess,tempfile,time
from pathlib import Path
from playwright.sync_api import sync_playwright
from preview_process import preview_launcher, read_startup_line
ROOT=Path(__file__).resolve().parent
state=Path(tempfile.mkdtemp(prefix='hermes-rooms-preview-',dir='/tmp'));state.chmod(0o777)
(state/'native-home/cron').mkdir(parents=True);(state/'native-home/cron/jobs.json').write_text('{"jobs":[]}');(state/'native-home/config.yaml').write_text('auxiliary: {}\n')
env={**os.environ,'HOME':str(state),'PREVIEW_STATE_ROOT':str(state),'PREVIEW_PORT':'0','TEST_PYTHON':'/vol1/@apphome/hermes-agent/data/venv/bin/python3','PYTHONDONTWRITEBYTECODE':'1'}
os.environ['PLAYWRIGHT_BROWSERS_PATH']='/vol1/@apphome/hermes-agent/data/.cache/ms-playwright'
node='/vol1/@apphome/hermes-agent/data/node/bin/node';cmd=preview_launcher()+['env']+[f'{key}={env[key]}' for key in ('HOME','PREVIEW_STATE_ROOT','PREVIEW_PORT','TEST_PYTHON','PYTHONDONTWRITEBYTECODE')]+[node,str(ROOT/'preview-server.mjs')]
server=subprocess.Popen(cmd,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
shots=Path(tempfile.mkdtemp(prefix='hermes-rooms-evidence-',dir='/tmp'));shots.chmod(0o777);results=[]
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
   page.goto(url,wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'");page.evaluate("switchPage('rooms')")
   page.wait_for_selector('.discussion-message');page.evaluate("selectRoom('legacy-room')");page.wait_for_function("document.querySelector('.discussion-head h2').textContent==='原讨论记录'");assert page.locator('.discussion-message').count()==60
   page.get_by_role('button',name='查看更早消息',exact=True).click();page.wait_for_function("document.querySelectorAll('.discussion-message').length===120")
   assert '历史讨论 500' in page.locator('.discussion-message').first.inner_text()
   # Create dialog persists across closing, including member selection.
   page.get_by_role('button',name='新建讨论',exact=True).click();dialog=page.get_by_role('dialog',name='新建讨论')
   dialog.get_by_role('textbox',name='讨论名称',exact=True).fill('验收讨论 '+str(width));dialog.get_by_role('searchbox',name='选择讨论专家').fill('coder')
   dialog.locator('input[type=checkbox]').first.check();dialog.get_by_role('button',name='关闭',exact=True).click()
   page.get_by_role('button',name='新建讨论',exact=True).click();assert dialog.get_by_role('textbox',name='讨论名称',exact=True).input_value()=='验收讨论 '+str(width)
   dialog.get_by_role('combobox',name='讨论默认模型').select_option(label='服务乙 / same-model');dialog.get_by_role('button',name='创建讨论',exact=True).click();dialog.wait_for(state='detached')
   page.wait_for_function("document.querySelector('.discussion-head h2').textContent.startsWith('验收讨论')")
   room_id=page.evaluate('currentRoom');input=page.get_by_role('textbox',name='讨论内容',exact=True)
   input.fill('跨刷新草稿');page.reload(wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'");page.evaluate("switchPage('rooms')")
   page.wait_for_function("document.querySelector('#discussionInput').value==='跨刷新草稿'")
   assert page.locator('.discussion-choices input:checked').count()==1
   deadline=time.monotonic()+8
   while time.monotonic()<deadline:
    if context.request.get(url+'/api/panel-rooms/'+room_id+'/draft',headers=headers).json()['draft']['text']=='跨刷新草稿':break
    page.wait_for_timeout(100)
   else:raise AssertionError('server draft was not saved after reload')
   second=browser.new_context(viewport={'width':width,'height':height});second.route('**/*',lambda r:r.continue_(url=r.request.url.replace('/app/hermes-agent/','/')) if r.request.url.startswith(url) else r.abort())
   other=second.new_page();other.goto(url,wait_until='domcontentloaded');other.wait_for_function("monitorToken==='fixture-token'");other.evaluate("switchPage('rooms')")
   other.wait_for_function("document.querySelector('#discussionInput').value==='跨刷新草稿'")
   if width==1440:
    other.get_by_role('textbox',name='讨论内容',exact=True).fill('另一设备的草稿')
    deadline=time.monotonic()+8
    while time.monotonic()<deadline:
     if context.request.get(url+'/api/panel-rooms/'+room_id+'/draft',headers=headers).json()['draft']['text']=='另一设备的草稿':break
     other.wait_for_timeout(100)
    else:raise AssertionError('second device draft not persisted')
    input.fill('此设备的草稿');page.get_by_role('button',name='查看并合并草稿',exact=True).click()
    merge=page.get_by_role('dialog',name='合并讨论草稿');assert '另一设备的草稿' in merge.get_by_role('textbox',name='合并后的内容').input_value()
    assert '此设备的草稿' in merge.get_by_role('textbox',name='合并后的内容').input_value()
    merge.get_by_role('button',name='保存合并草稿',exact=True).click();merge.wait_for(state='detached')
   second.close()
   before=len(context.request.get(url+'/__fixture/stats').json().get('room_calls',[]))
   page.get_by_role('button',name='发送讨论',exact=True).click();page.wait_for_function("document.querySelector('.discussion-runs').textContent.includes('正在讨论')")
   page.reload(wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'");page.evaluate("switchPage('rooms')")
   page.wait_for_function("document.querySelector('.discussion-messages').textContent.includes('讨论已完成')")
   calls=context.request.get(url+'/__fixture/stats').json()['room_calls'];assert len(calls)==before+1;assert calls[-1]['provider']=='fixture-b' and calls[-1]['model']=='same-model'
   page.locator('.discussion-message details summary').last.click();assert '隔离验证证据' in page.locator('.discussion-message').last.inner_text()
   # Failed member pauses next queued turn. Explicit resume preserves failure record.
   context.request.post(url+'/__fixture/room-failure',data={'fail':True})
   input.fill('失败场景');page.get_by_role('button',name='发送讨论',exact=True).click()
   page.wait_for_function("document.querySelector('.discussion-runs').textContent.includes('执行失败')")
   input.fill('失败后排队');page.get_by_role('button',name='发送讨论',exact=True).click();page.wait_for_function("document.querySelector('.discussion-runs').textContent.includes('已排队')")
   context.request.post(url+'/__fixture/room-failure',data={'fail':False})
   page.once('dialog',lambda d:d.accept());page.get_by_role('button',name='从中断处继续',exact=True).click()
   page.wait_for_function("document.querySelectorAll('.discussion-run').length===0")
   messages=context.request.get(url+'/api/panel-rooms/'+room_id,headers=headers).json()['messages'];assert any(m.get('text')=='已保留部分回复' for m in messages)
   assert len([m for m in messages if m.get('kind')=='assistant' and m.get('status')=='done'])==3
   # Full export and archive/restore do not discard history.
   if height<=500:page.get_by_role('button',name='讨论操作',exact=True).click()
   with page.expect_download() as download:page.get_by_role('button',name='导出',exact=True).click()
   artifact=download.value;exported=json.loads(Path(artifact.path()).read_text());assert len(exported['messages'])==len(messages)
   page.get_by_role('button',name='归档',exact=True).click();page.get_by_role('combobox',name='讨论状态').select_option('archived')
   page.wait_for_function("document.querySelector('.discussion-head h2').textContent==='验收讨论 '+"+str(width))
   page.get_by_role('button',name='恢复讨论',exact=True).click();page.get_by_role('combobox',name='讨论状态').select_option('active')
   # Saved notes have a reversible state, and participate in the next request.
   page.evaluate("selectRoom("+json.dumps(room_id)+")")
   page.wait_for_function("document.querySelector('.discussion-head h2').textContent==='验收讨论 '+"+str(width))
   page.get_by_role('button',name='讨论笔记 0',exact=True).click();note=page.get_by_role('dialog',name='讨论笔记')
   note.get_by_role('textbox',name='新增讨论笔记').fill('以后引用这条设计决定')
   note.get_by_role('button',name='保存笔记',exact=True).click();note.get_by_role('button',name='归档笔记').wait_for()
   note.get_by_role('button',name='归档笔记').click();note.get_by_role('button',name='恢复笔记').click()
   note.get_by_role('button',name='关闭',exact=True).click()
   if height<=500:page.get_by_role('button',name='讨论操作',exact=True).click()
   input.fill('验证讨论笔记');page.get_by_role('button',name='发送讨论',exact=True).click()
   page.wait_for_function("document.querySelector('.discussion-messages').textContent.includes('验证讨论笔记') && document.querySelectorAll('.discussion-run').length===0")
   assert '以后引用这条设计决定' in context.request.get(url+'/__fixture/stats').json()['room_calls'][-1]['message']
   # Search jump races page load; it must remain at the requested old message.
   page.evaluate("panelJumpRoom({kind:'room',session_id:'legacy-room',message_index:45})")
   page.wait_for_selector('.discussion-message.pw-hit');assert '历史讨论 45' in page.locator('.discussion-message.pw-hit').inner_text()
   page.wait_for_timeout(1400);assert '历史讨论 45' in page.locator('.discussion-messages').inner_text()
   page.get_by_role('button',name='返回最新讨论',exact=True).click();page.wait_for_function("document.querySelector('.discussion-messages').textContent.includes('历史讨论 619')")
   assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
   assert page.locator('.discussion-history').bounding_box()['height']>=100
   if height<=500:
    page.get_by_role('button',name='参与设置',exact=True).click();page.get_by_role('combobox',name='讨论轮次').select_option('2')
    assert page.get_by_role('button',name='添加附件',exact=True).is_visible()
    page.get_by_role('button',name='参与设置',exact=True).click()
   box=input.bounding_box();assert box['y']>=0 and box['y']+box['height']<=height- (64 if width<=768 else 0)
   page.screenshot(path=str(shots/f'rooms-{width}.png'))
   assert not errors,errors
   results.append({'viewport':[width,height],'legacy_620_preserved':True,'history_paging':True,'create_draft':True,'draft_reload':True,'cross_device_draft':True,'single_execution_after_reload':True,'tools_preserved':True,'failure_resume_and_queue':True,'export_archive_restore':True,'notes_reversible_and_in_context':True,'search_jump_preserved':True,'same_model_provider_identity':True,'layout':True,'errors':errors});print(json.dumps(results[-1],ensure_ascii=False),flush=True);context.close()
  browser.close()
 (shots/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
finally:
 stop_server()
