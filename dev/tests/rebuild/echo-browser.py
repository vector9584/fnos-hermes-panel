import os, json, signal, subprocess, tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright
from preview_process import preview_command, preview_launcher, read_startup_line

ROOT=Path(__file__).resolve().parent
state=Path(tempfile.mkdtemp(prefix='hermes-echo-preview-',dir='/tmp'));state.chmod(0o777)
(state/'native-home/cron').mkdir(parents=True)
(state/'native-home/cron/jobs.json').write_text('{"jobs":[]}')
(state/'echo').mkdir(); (state/'echo').chmod(0o777)
queue=state/'echo/tasks.json'
echo_data={'version':1,'seq':35,'tasks':[
 {'id':1,'title':'结构化交付','detail':'保留完整原要求','star':3,'status':'done','exec':{'mode':'deep','iters':4,'model':'saved-model'},'entries':[{'kind':'reply','text':'处理完成'},{'kind':'deliver','text':'重复的旧拼接文本'}],
  'report':{'numbers':[{'k':'文件数','v':'12'}],'files':['/tmp/fixture/report.md'],'detail':'实测口径'},'sediment':{'status':'done','file':'对话沉淀/fixture.md'},'todos':[{'c':'仍未确认的工作','s':'todo'}]},
 {'id':2,'title':'正在执行的验收任务','detail':'不要修改生产任务','star':3,'status':'doing','exec':{},'panel_run':{'id':'fixture-running','state':'running','owner':{'pid':os.getpid(),'boot':'gone','start':'gone'},'started_at':'2026-11-04T19:00:00+08:00','session_id':'cron_exact','model_requested':'saved-model'}},
 *[{'id':identifier,'title':'大列表任务 '+str(identifier),'detail':'分页验收数据','star':3,'status':'done','exec':{}} for identifier in range(3,36)]]}
queue.write_text(json.dumps(echo_data))
env={**os.environ,'HOME':str(state),'PREVIEW_STATE_ROOT':str(state),'PREVIEW_PORT':'0','TEST_PYTHON':'/vol1/@apphome/hermes-agent/data/venv/bin/python3','PYTHONDONTWRITEBYTECODE':'1'}
os.environ['PLAYWRIGHT_BROWSERS_PATH']='/vol1/@apphome/hermes-agent/data/.cache/ms-playwright'
node='/vol1/@apphome/hermes-agent/data/node/bin/node';cmd=preview_launcher()+['env']+[f'{key}={env[key]}' for key in ('HOME','PREVIEW_STATE_ROOT','PREVIEW_PORT','TEST_PYTHON','PYTHONDONTWRITEBYTECODE')]+[node,str(ROOT/'preview-server.mjs')]
server=subprocess.Popen(cmd,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
shots=Path(tempfile.mkdtemp(prefix='hermes-echo-evidence-',dir='/tmp'));shots.chmod(0o777);results=[]
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
 if not first: raise RuntimeError(server.stderr.read().strip() or '预览服务没有启动')
 port=int(json.loads(first)['port']);url='http://127.0.0.1:'+str(port);print(first,flush=True)
 with sync_playwright() as p:
  browser=p.chromium.launch(args=['--no-sandbox'])
  for width,height in [(1440,900),(390,844),(844,390)]:
   # Reset only the isolated running fixture for each viewport.
   data=json.loads(json.dumps(echo_data));t=data['tasks'][1];t['status']='doing';t['panel_run']['state']='running';queue.write_text(json.dumps(data))
   (state/'echo-drafts.json').unlink(missing_ok=True)
   context=browser.new_context(viewport={'width':width,'height':height});page=context.new_page();errors=[]
   page.on('pageerror',lambda e:errors.append(str(e)))
   context.route('**/*',lambda route:route.continue_(url=route.request.url.replace('/app/hermes-agent/','/')) if route.request.url.startswith(url) else route.abort())
   page.goto(url,wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'");page.evaluate("switchPage('echo')")
   page.wait_for_function("/^(共|匹配) .*，已显示 /.test(document.getElementById('echoFeedback').textContent.trim())")
   assert page.locator('.echo-card').count()==30;assert not page.locator('.echo-card').filter(has_text='结构化交付').count()
   assert not page.locator('#echoMore').is_hidden();page.locator('#echoMore').click();page.wait_for_function("document.querySelectorAll('.echo-card').length===35")
   assert page.locator('#echoMore').is_hidden()
   page.locator('.echo-new').click();dialog=page.get_by_role('dialog',name='递一句话')
   dialog.locator('[name=title]').fill('新任务 '+str(width));dialog.locator('[name=detail]').fill('刷新保存草稿与执行选项')
   dialog.locator('[name=star]').fill('0.5');dialog.locator('[name=deep]').check();dialog.locator('[name=iters]').fill('6');dialog.locator('[name=model]').fill('chosen-model')
   page.reload(wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'");page.evaluate("switchPage('echo')");page.locator('.echo-new').click()
   dialog=page.get_by_role('dialog',name='递一句话');assert dialog.locator('[name=deep]').is_checked();assert dialog.locator('[name=model]').input_value()=='chosen-model'
   dialog.screenshot(path=str(shots/f'editor-{width}.png'));dialog.get_by_role('button',name='保存',exact=True).click();dialog.wait_for(state='detached')
   saved=next(t for t in json.loads(queue.read_text())['tasks'] if t['title']=='新任务 '+str(width));assert saved['status']=='staged';assert saved['exec']=={'mode':'deep','iters':6,'model':'chosen-model'}
   page.locator('.echo-new').click();rapid=page.get_by_role('dialog',name='递一句话');rapid.locator('[name=title]').fill('快速保存 '+str(width));rapid.locator('[name=detail]').fill('输入后立即提交，不等待草稿防抖');rapid.locator('[name=star]').fill('0.5');rapid.get_by_role('button',name='保存',exact=True).click();rapid.wait_for(state='detached')
   rapid_tasks=[t for t in json.loads(queue.read_text())['tasks'] if t['title']=='快速保存 '+str(width)];assert len(rapid_tasks)==1 and rapid_tasks[0]['status']=='staged',rapid_tasks
   page.locator('.echo-new').click();racing=page.get_by_role('dialog',name='递一句话');racing.locator('[name=title]').fill('草稿写入竞态 '+str(width));racing.locator('[name=detail]').fill('等待草稿写入完成后再创建任务');racing.locator('[name=star]').fill('0.5')
   page.evaluate("""() => {
    const original=window.fetch.bind(window);
    window.fetch=async function(input,init){
      const url=typeof input==='string'?input:input.url,body=init?.body||'';
      if(url.includes('/api/echo')&&body.includes('draft_save'))await new Promise(resolve=>setTimeout(resolve,650));
      return original(input,init);
    };
   }""")
   page.wait_for_timeout(500);racing.get_by_role('button',name='保存',exact=True).click();racing.wait_for(state='detached')
   racing_tasks=[t for t in json.loads(queue.read_text())['tasks'] if t['title']=='草稿写入竞态 '+str(width)];assert len(racing_tasks)==1 and racing_tasks[0]['status']=='staged',racing_tasks
   race_draft=page.request.post(url+'/api/echo',headers={'X-Monitor-Token':'fixture-token'},data={'action':'draft_get','key':'create:new'}).json()['draft'];assert race_draft is None,race_draft
   page.locator('.echo-new').click();cleanup=page.get_by_role('dialog',name='递一句话');cleanup.locator('[name=title]').fill('清理冲突 '+str(width));cleanup.locator('[name=detail]').fill('提交成功后草稿清理出现版本冲突');cleanup.locator('[name=star]').fill('0.5')
   page.evaluate("""() => {
    const original=window.fetch.bind(window);let raceOnce=true;
    window.fetch=async function(input,init){
      const url=typeof input==='string'?input:input.url,body=init?.body||'';
      if(raceOnce&&url.includes('/api/echo')&&body.includes('draft_delete')){
        raceOnce=false;
        const headers={'Content-Type':'application/json','X-Monitor-Token':monitorToken};
        const current=await original('/api/echo',{method:'POST',headers,body:JSON.stringify({action:'draft_get',key:'create:new'})});
        const draft=(await current.json()).draft;
        const newDraft={action:'draft_save',key:'create:new',values:{title:'另一设备的新草稿'},initial:{},request_id:'other-device-request',client_id:'other-device'};
        if(draft)newDraft.draft_revision=draft.draft_revision;
        await original('/api/echo',{method:'POST',headers,body:JSON.stringify(newDraft)});
        return new Response(JSON.stringify({ok:false,error:'草稿版本已更新'}),{status:409,headers:{'Content-Type':'application/json'}});
      }
      return original(input,init);
    };
   }""")
   cleanup.get_by_role('button',name='保存',exact=True).click();cleanup.wait_for(state='detached')
   cleanup_tasks=[t for t in json.loads(queue.read_text())['tasks'] if t['title']=='清理冲突 '+str(width)];assert len(cleanup_tasks)==1,cleanup_tasks
   retained_draft=page.request.post(url+'/api/echo',headers={'X-Monitor-Token':'fixture-token'},data={'action':'draft_get','key':'create:new'}).json()['draft'];assert retained_draft['client_id']=='other-device' and retained_draft['values']['title']=='另一设备的新草稿',retained_draft
   page.locator('#echoSearch').fill('结构化交付');page.wait_for_function("title=>[...document.querySelectorAll('.echo-card h3')].some(e=>e.textContent===title)",arg='结构化交付');page.locator('.echo-card').filter(has_text='结构化交付').get_by_role('button',name='查看任务与回信').click();dialog=page.get_by_role('dialog',name='#1 结构化交付')
   assert '文件数：12' in dialog.inner_text();assert '重复的旧拼接文本' not in dialog.inner_text();assert '对话沉淀/fixture.md' in dialog.inner_text();assert '○ 仍未确认' in dialog.inner_text()
   dialog.screenshot(path=str(shots/f'result-{width}.png'));dialog.get_by_role('button',name='关闭',exact=True).click()
   target_title='新任务 '+str(width);page.locator('#echoSearch').fill(target_title);page.wait_for_function("title=>[...document.querySelectorAll('.echo-card h3')].some(e=>e.textContent===title)",arg=target_title);target_card=page.locator('.echo-card').filter(has_text=target_title);assert target_card.locator('h3').inner_text()==target_title;target_card.get_by_role('button',name='查看任务与回信').click();page.get_by_role('dialog').get_by_role('button',name='编辑',exact=True).click()
   editor=page.get_by_role('dialog',name='编辑任务');editor.locator('[name=detail]').fill('用户待合并草稿')
   data=json.loads(queue.read_text());next(t for t in data['tasks'] if t['id']==saved['id'])['detail']='另一端新增要求';queue.write_text(json.dumps(data))
   latest=page.request.get(url+'/api/echo').json();assert any(t['id']==saved['id'] and t['detail']=='另一端新增要求' for t in latest['tasks']),latest
   echo_responses=[];page.on('response',lambda response:echo_responses.append((response.url,response.status)) if response.url.endswith('/api/echo') and response.request.method=='POST' else None)
   editor.get_by_role('button',name='保存',exact=True).click();merge_button=editor.locator('.echo-merge')
   try: merge_button.wait_for(state='visible',timeout=5000)
   except Exception: raise AssertionError('ECHO stale edit did not render merge action; dialogs='+repr(page.locator('dialog[open]').evaluate_all("els=>els.map(e=>({label:e.getAttribute('aria-label'),text:e.innerText}))"))+' responses='+repr(echo_responses))
   merge_button.click()
   merge=page.get_by_role('dialog',name='合并任务修改');assert '另一端新增要求' in merge.inner_text();merge.get_by_role('textbox',name='合并后的要求').fill('用户待合并草稿\n另一端新增要求');merge.get_by_role('button',name='采用合并稿').click()
   editor.get_by_role('button',name='保存',exact=True).click();editor.wait_for(state='detached');assert '另一端新增要求' in next(t for t in json.loads(queue.read_text())['tasks'] if t['id']==saved['id'])['detail']
   target_title='正在执行的验收任务';page.locator('#echoSearch').fill(target_title);page.wait_for_function("title=>[...document.querySelectorAll('.echo-card h3')].some(e=>e.textContent===title)",arg=target_title);running_card=page.locator('.echo-card').filter(has_text=target_title);assert running_card.locator('h3').inner_text()==target_title;running_card.get_by_role('button',name='查看任务与回信').click();dialog=page.get_by_role('dialog',name='#2 正在执行的验收任务')
   page.once('dialog',lambda d:d.accept());dialog.get_by_role('button',name='取消执行',exact=True).click()
   page.wait_for_function("document.querySelector('.echo-dialog').textContent.includes('已请求取消，等待执行器停止')")
   assert json.loads(queue.read_text())['tasks'][1]['status']=='doing'
   dialog.get_by_role('button',name='关闭',exact=True).click();page.reload(wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'");page.evaluate("switchPage('echo')")
   page.wait_for_function("/^(共|匹配) .*，已显示 /.test(document.getElementById('echoFeedback').textContent.trim())");page.locator('.echo-card button').click();dialog=page.get_by_role('dialog',name='#2 正在执行的验收任务')
   assert '已请求取消' in dialog.inner_text();dialog.get_by_role('button',name='核对中断状态',exact=True).click()
   page.wait_for_function("document.querySelector('.echo-dialog .echo-status').textContent.includes('没收到')")
   dialog.locator('summary').filter(has_text='执行记录').click();assert 'cron_exact' in dialog.inner_text()
   dialog.screenshot(path=str(shots/f'interrupted-{width}.png'))
   assert page.evaluate('document.documentElement.scrollWidth<=innerWidth');assert not errors,errors
   results.append({'viewport':[width,height],'server_pagination_35_roots':True,'cross_page_search':True,'draft_and_options':True,'draft_write_race_before_create':True,'cleanup_conflict_does_not_hide_success':True,'structured_result':True,'cancel_survives_reload':True,'dead_owner_recovery':True,'errors':errors});context.close()
  browser.close()
 (shots/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2));print(json.dumps(results,ensure_ascii=False),flush=True)
finally:
 stop_server()
