"""Expert card -> existing room, authoritative conflicts, retained member snapshots. No model/network."""
import os,json,signal,subprocess,tempfile,time
from pathlib import Path
from playwright.sync_api import sync_playwright
from preview_process import preview_launcher, read_startup_line
ROOT=Path(__file__).resolve().parent
state=Path(tempfile.mkdtemp(prefix='hermes-expert-room-',dir='/tmp'))
state.chmod(0o777)
(state/'native-home/cron').mkdir(parents=True);(state/'native-home/cron/jobs.json').write_text('{"jobs":[]}');(state/'native-home/config.yaml').write_text('auxiliary: {}\n')
env={**os.environ,'HOME':str(state),'PREVIEW_STATE_ROOT':str(state),'PREVIEW_PORT':'0','TEST_PYTHON':'/vol1/@apphome/hermes-agent/data/venv/bin/python3','PYTHONDONTWRITEBYTECODE':'1'}
os.environ['PLAYWRIGHT_BROWSERS_PATH']='/vol1/@apphome/hermes-agent/data/.cache/ms-playwright'
node='/vol1/@apphome/hermes-agent/data/node/bin/node'
cmd=preview_launcher()+['env']+[f'{key}={env[key]}' for key in ('HOME','PREVIEW_STATE_ROOT','PREVIEW_PORT','TEST_PYTHON','PYTHONDONTWRITEBYTECODE')]+[node,str(ROOT/'preview-server.mjs')]
server=subprocess.Popen(cmd,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
shots=state/'evidence';shots.mkdir(exist_ok=True);results=[]
try:
 first=read_startup_line(server)
 if not first:
  detail=server.stderr.read().strip()
  raise RuntimeError('预览服务没有启动：'+(detail or '没有启动输出'))
 info=json.loads(first);port=int(info['port']);url='http://127.0.0.1:'+str(port);print(first,flush=True)
 with sync_playwright() as p:
  browser=p.chromium.launch(args=['--no-sandbox'])
  for width,height in [(1440,900),(390,844),(844,390)]:
   context=browser.new_context(viewport={'width':width,'height':height});headers={'X-Monitor-Token':'fixture-token'}
   context.route('**/*',lambda r:r.continue_(url=r.request.url.replace('/app/hermes-agent/','/')) if r.request.url.startswith(url) else r.abort())
   def get(path):
    r=context.request.get(url+path,headers=headers);assert r.ok,(path,r.text());return r.json()
   def post(path,data):
    r=context.request.post(url+path,headers=headers,data=data);assert r.ok,(path,r.text());return r.json()
   experts=get('/api/workspace-ui/experts?limit=60')['experts'];other=next(e for e in experts if e['id']!='coder')
   created=post('/api/panel-rooms',{'request_id':'join-base-'+str(width),'title':'已有讨论 '+str(width),'expert_ids':[other['id']]})['room'];rid=created['id'];base='/api/panel-rooms/'+rid
   original=get(base+'/export')['members'];before=len(get('/api/panel-rooms')['rooms'])
   current=get('/api/workspace-ui/experts/'+other['id'])['expert'];r=context.request.put(url+'/api/workspace-ui/experts/'+other['id'],headers=headers,data={'revision':current['revision'],'prompt':'模板后来改变 '+str(width)});assert r.ok
   page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   page.goto(url,wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'");page.evaluate("switchPage('experts')")
   gif=bytes.fromhex('47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b')
   expert=get('/api/workspace-ui/experts/coder')['expert']
   upload=context.request.post(url+'/api/workspace-ui/avatars',headers=headers,multipart={'file':{'name':'room.gif','mimeType':'image/gif','buffer':gif}});assert upload.ok,upload.text();gif_url=upload.json()['url']
   updated=context.request.put(url+'/api/workspace-ui/experts/coder',headers=headers,data={'revision':expert['revision'],'emoji':gif_url});assert updated.ok,updated.text()
   query=page.get_by_role('searchbox',name='搜索专家');query.fill('coder');page.wait_for_function("document.querySelectorAll('.expert-library-card').length===1")
   assert page.locator('.expert-library-card .pw-avatar img').get_attribute('src').endswith('.gif')
   page.locator('.expert-library-card').get_by_role('button',name='加入讨论').click();dialog=page.get_by_role('dialog',name='加入专家讨论')
   destination=dialog.get_by_role('combobox',name='目标讨论');destination.select_option(rid)
   page.wait_for_function("document.querySelector('.discussion-editor .modal-body').textContent.includes('/12 位专家')")
   assert not dialog.get_by_role('textbox',name='讨论名称',exact=True).is_visible()
   dialog.get_by_role('button',name='关闭',exact=True).click()
   page.reload(wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'");page.evaluate("switchPage('experts')")
   page.locator('.expert-library-card').get_by_role('button',name='加入讨论').click();dialog=page.get_by_role('dialog',name='加入专家讨论')
   page.wait_for_function("document.querySelector('.discussion-editor select').value=== "+json.dumps(rid))
   save=dialog.get_by_role('button',name='添加成员',exact=True);save.wait_for();page.wait_for_function("!document.querySelector('.discussion-editor .modal-foot button').disabled")
   # Concurrent update forces explicit reload, retaining the checked expert.
   post(base+'/notes',{'request_id':'concurrent-'+str(width),'text':'其他设备的笔记'})
   save.click();page.wait_for_function("document.querySelector('.discussion-editor [role=status]').textContent.includes('选择已保留')")
   assert '选择已保留' in dialog.inner_text();assert save.is_disabled();assert len(get(base+'/export')['members'])==1
   dialog.get_by_role('button',name='重新读取',exact=True).click();page.wait_for_function("!document.querySelector('.discussion-editor .modal-foot button').disabled")
   # Existing members are visible, selected and unmodifiable; then return to coder.
   search=dialog.get_by_role('searchbox',name='选择讨论专家');search.fill(other['id'])
   check=dialog.locator('input[type=checkbox][value="'+other['id']+'"]');check.wait_for();assert check.is_checked() and check.is_disabled()
   search.fill('coder');page.wait_for_function("document.querySelectorAll('.discussion-expert-options input').length===1 && document.querySelector('.discussion-expert-options input').value==='coder'");checkbox=dialog.locator('input[type=checkbox][value=coder]');assert checkbox.is_checked()
   assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
   box=save.bounding_box();assert box['y']>=0 and box['y']+box['height']<=height
   dialog.locator('.modal-body').evaluate('(e)=>{e.scrollTop=0;}');page.screenshot(path=str(shots/f'join-{width}.png'))
   save.click();dialog.wait_for(state='detached')
   exported=get(base+'/export');assert len(get('/api/panel-rooms')['rooms'])==before
   assert exported['members'][0]==original[0];assert len(exported['members'])==2
   coder=get('/api/workspace-ui/experts/coder')['expert'];added=exported['members'][1];assert added['persona_id']=='coder' and added['system']==coder['prompt'] and added['expert_revision']==coder['revision']
   page.wait_for_function('currentRoom==='+json.dumps(rid))
   # The real runner consumes both stored snapshots; later template changes do not leak in.
   page.get_by_role('textbox',name='讨论内容',exact=True).fill('验证新旧成员设定')
   page.get_by_role('button',name='发送讨论',exact=True).click()
   deadline=time.monotonic()+12
   while time.monotonic()<deadline:
    output=get(base+'/export');done=[m for m in output['messages'] if m.get('kind')=='assistant' and m.get('status')=='done']
    if len(done)==2:break
    page.wait_for_timeout(150)
   else:raise AssertionError('discussion did not finish both member replies')
   assert [m['system_snapshot'] for m in done]==[original[0]['system'],coder['prompt']]
   page.evaluate('switchPage("rooms")');page.wait_for_function("document.querySelectorAll('.discussion-message img').length>=1")
   assert page.locator('.discussion-message img').first.get_attribute('src').endswith('.gif')
   # A duplicate choice cannot create a second member. New-discussion remains available.
   page.evaluate("switchPage('experts')");page.locator('.expert-library-card').get_by_role('button',name='加入讨论').click()
   destination=dialog.get_by_role('combobox',name='目标讨论');destination.select_option(rid)
   page.wait_for_function("document.querySelector('.discussion-editor .modal-body').textContent.includes('/12 位专家')")
   search.fill('coder');page.wait_for_function("document.querySelectorAll('.discussion-expert-options input').length===1 && document.querySelector('.discussion-expert-options input').disabled");assert checkbox.is_disabled();assert save.is_disabled()
   destination.select_option('');name=dialog.get_by_role('textbox',name='讨论名称',exact=True);name.fill('专家发起 '+str(width))
   dialog.get_by_role('button',name='创建讨论',exact=True).click();dialog.wait_for(state='detached')
   assert len(get('/api/panel-rooms')['rooms'])==before+1
   # A remembered archived destination must never silently become 'create new'.
   page.evaluate("switchPage('experts')");page.locator('.expert-library-card').get_by_role('button',name='加入讨论').click()
   destination.select_option(rid);page.wait_for_function("document.querySelector('.discussion-editor .modal-body').textContent.includes('/12 位专家')")
   dialog.get_by_role('button',name='关闭',exact=True).click();post(base+'/archive',{})
   page.locator('.expert-library-card').get_by_role('button',name='加入讨论').click()
   page.wait_for_function("document.querySelector('.discussion-editor [role=status]').textContent.includes('请选择正在使用')")
   assert dialog.locator('.modal-foot button').is_disabled();assert destination.input_value()==rid
   assert len(get('/api/panel-rooms')['rooms'])==before
   destination.select_option('');dialog.get_by_role('textbox',name='讨论名称',exact=True).wait_for();dialog.get_by_role('button',name='关闭',exact=True).click()
   assert not errors,errors
   result={'viewport':[width,height],'existing_target_persists_refresh':True,'conflict_explicit_reload':True,'existing_member_snapshot_unchanged':True,'new_member_current_snapshot':True,'real_runner_uses_snapshots':True,'duplicate_disabled':True,'new_room_path':True,'archived_destination_no_silent_create':True,'errors':errors};results.append(result);print(json.dumps(result,ensure_ascii=False),flush=True);context.close()
  browser.close()
 (shots/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
finally:
 if server.poll() is None:
  try: os.killpg(server.pid,signal.SIGTERM);server.wait(timeout=8)
  except (ProcessLookupError,subprocess.TimeoutExpired):
   try: os.killpg(server.pid,signal.SIGKILL)
   except ProcessLookupError: pass
   server.wait(timeout=8)
