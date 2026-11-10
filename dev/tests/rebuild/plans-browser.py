"""Task plans use the actual isolated store and durable chat queue; model output is simulated."""
import os,json,signal,subprocess,tempfile,shlex,pwd
from pathlib import Path
from playwright.sync_api import sync_playwright
from preview_process import preview_launcher, read_startup_line
ROOT=Path(__file__).resolve().parent
state=Path(tempfile.mkdtemp(prefix='hermes-plans-preview-',dir='/tmp'));state.chmod(0o777);(state/'native-home/cron').mkdir(parents=True);(state/'native-home/cron').chmod(0o777);(state/'native-home/cron/jobs.json').write_text('{"jobs":[]}');(state/'native-home/config.yaml').write_text('auxiliary: {}\n')
env={**os.environ,'HOME':str(state),'PREVIEW_STATE_ROOT':str(state),'PREVIEW_PORT':'0','TEST_PYTHON':os.environ.get('HERMES_TEST_PYTHON','/vol1/@apphome/hermes-agent/data/venv/bin/python3'),'PYTHONDONTWRITEBYTECODE':'1'}
os.environ['PLAYWRIGHT_BROWSERS_PATH']=os.environ.get('HERMES_PLAYWRIGHT_BROWSERS_PATH',os.environ.get('PLAYWRIGHT_BROWSERS_PATH','/vol1/@apphome/hermes-agent/data/.cache/ms-playwright'))
node=os.environ.get('HERMES_PREVIEW_NODE','/vol1/@apphome/hermes-agent/data/node/bin/node');cmd=preview_launcher()+['env']+[f'{key}={env[key]}' for key in ('HOME','PREVIEW_STATE_ROOT','PREVIEW_PORT','TEST_PYTHON','PYTHONDONTWRITEBYTECODE')]+[node,str(ROOT/'preview-server.mjs')]
server=subprocess.Popen(cmd,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
shots=Path(tempfile.mkdtemp(prefix='hermes-plans-evidence-',dir='/tmp'));shots.chmod(0o777);results=[]
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
 port=int(json.loads(first)['port']);url='http://127.0.0.1:'+str(port);print(first,flush=True)
 with sync_playwright() as p:
  browser=p.chromium.launch(args=['--no-sandbox'])
  for width,height in [(1440,900),(390,844),(844,390)]:
   context=browser.new_context(viewport={'width':width,'height':height});headers={'X-Monitor-Token':'fixture-token'}
   context.route('**/*',lambda r:r.continue_(url=r.request.url.replace('/app/hermes-agent/','/')) if r.request.url.startswith(url) else r.abort())
   page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   page.goto(url,wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'");page.evaluate("switchPage('flows')")
   page.wait_for_function("location.hash==='#/plans' && document.querySelector('#page-plans')?.classList.contains('active')")
   page.evaluate("switchPage('chat')");page.wait_for_function("document.querySelector('#page-chat')?.classList.contains('active')");page.locator('#toolbarToggle').click() if width<=768 else None;page.locator('#btnExpert').click();picker=page.locator('#pwOverlay .pw-modal');picker.get_by_role('heading',name='选择本会话角色',exact=True).wait_for();picker.get_by_placeholder('搜索专家名称、专长…').wait_for();assert picker.get_by_text('程序员',exact=False).count()>=1;picker.locator('.modal-close').click()
   page.evaluate("switchPage('flows')");page.wait_for_function("location.hash==='#/plans' && document.querySelector('#page-plans')?.classList.contains('active')")
   page.wait_for_function("document.querySelectorAll('#page-plans .expert-library-card').length===24")
   plan_search=page.get_by_role('searchbox',name='搜索任务方案');plan_search.fill('不会命中的筛选');plan_search.fill('');page.get_by_role('button',name='更多方案',exact=True).click();page.wait_for_function("document.querySelectorAll('#page-plans .expert-library-card').length===48",timeout=15000);page.reload(wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'");page.evaluate("switchPage('flows')");page.wait_for_function("document.querySelectorAll('#page-plans .expert-library-card').length===24")
   page.get_by_role('button',name='更多方案',exact=True).click();page.wait_for_function("document.querySelectorAll('#page-plans .expert-library-card').length===48")
   assert page.locator('#extTabs').get_by_text('团队',exact=True).count()==0
   assert page.locator('#extTabs').get_by_text('工作流',exact=True).count()==0
   # Original team remains present. Member edit drafts survive closing without overwriting saved membership.
   page.get_by_role('combobox',name='方案类型').select_option('team');page.wait_for_function("document.querySelectorAll('#page-plans .expert-library-card').length===1")
   page.get_by_role('button',name='查看与编辑',exact=True).click();team=page.get_by_role('dialog',name='任务方案编辑')
   team.locator('.plan-member').wait_for();assert team.locator('.plan-member').count()==1
   team.get_by_role('textbox',name='方案名称',exact=True).fill('分工草稿 '+str(width));team.get_by_role('button',name='关闭',exact=True).click()
   page.get_by_role('button',name='查看与编辑',exact=True).click();assert team.get_by_role('textbox',name='方案名称',exact=True).input_value()=='分工草稿 '+str(width)
   page.once('dialog',lambda d:d.accept());team.get_by_role('button',name='丢弃草稿并读取最新',exact=True).click();page.wait_for_function("document.querySelector('dialog[open] input[aria-label=方案名称]')?.value==='现有专家分工'")
   team.get_by_role('button',name='关闭',exact=True).click();page.get_by_role('combobox',name='方案类型').select_option('');page.wait_for_function("document.querySelectorAll('#page-plans .expert-library-card').length===24")
   # Custom plan editing persists input, rejects dependency cycles, and supports undo.
   page.get_by_role('button',name='新建任务模板',exact=True).click();editor=page.get_by_role('dialog',name='任务方案编辑')
   editor.get_by_role('textbox',name='方案名称',exact=True).fill('验收模板 '+str(width));editor.get_by_role('textbox',name='用途说明',exact=True).fill('检查步骤、输入和快照')
   editor.get_by_role('textbox',name='任务内容 1',exact=True).fill('分析 {{project}} 的 {{request}}')
   editor.get_by_role('button',name='添加输入项',exact=True).click();editor.get_by_role('textbox',name='输入名称 1',exact=True).fill('project');editor.get_by_role('textbox',name='输入说明 1',exact=True).fill('项目名称')
   page.screenshot(path=str(shots/f'plan-editor-{width}.png'))
   editor.get_by_role('button',name='关闭',exact=True).click();page.get_by_role('button',name='新建任务模板',exact=True).click()
   assert editor.get_by_role('textbox',name='方案名称',exact=True).input_value()=='验收模板 '+str(width)
   editor.get_by_role('textbox',name='依赖步骤 1',exact=True).fill('step1');editor.get_by_role('button',name='保存方案',exact=True).click()
   editor.get_by_text('步骤依赖形成循环',exact=False).wait_for();editor.get_by_role('textbox',name='依赖步骤 1',exact=True).fill('')
   editor.get_by_role('button',name='保存方案',exact=True).click();editor.wait_for(state='detached')
   search=page.get_by_role('searchbox',name='搜索任务方案');search.fill('验收模板 '+str(width));page.wait_for_function("document.querySelectorAll('#page-plans .expert-library-card').length===1")
   page.get_by_role('button',name='查看与编辑',exact=True).click();editor.get_by_role('textbox',name='用途说明',exact=True).fill('保存后撤销');editor.get_by_role('button',name='保存方案',exact=True).click();editor.wait_for(state='detached')
   page.get_by_role('button',name='查看与编辑',exact=True).click();page.once('dialog',lambda d:d.accept());editor.get_by_role('button',name='撤销上次修改',exact=True).click()
   page.wait_for_function("document.querySelector('dialog[open] textarea')?.value==='检查步骤、输入和快照'");editor.get_by_role('button',name='关闭',exact=True).click()
   page.get_by_role('button',name='开始任务',exact=True).click();launch=page.get_by_role('dialog',name='开始任务')
   session_before=page.evaluate('currentSession');launch.get_by_role('textbox',name='任务目标',exact=True).fill('长任务需求分析');launch.get_by_role('button',name='开始并打开会话',exact=True).click()
   launch.get_by_text('请填写：项目名称',exact=False).wait_for();launch.get_by_role('textbox',name='项目名称（必填）',exact=True).fill('fixture-project')
   before=len(context.request.get(url+'/__fixture/stats').json()['executions']);launch.get_by_role('button',name='开始并打开会话',exact=True).click();launch.wait_for(state='detached')
   page.wait_for_function("({before})=>currentSession && currentSession.startsWith('plan_') && currentSession!==before",arg={'before':session_before});sid=page.evaluate('currentSession');page.reload(wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'")
   page.evaluate("switchPage('chat');openTab("+json.dumps(sid)+")")
   page.wait_for_function("document.querySelector('#chatBody').textContent.includes('第39步已检查')",timeout=15000)
   assert len(context.request.get(url+'/__fixture/stats').json()['executions'])==before+1
   execution_stats=context.request.get(url+'/__fixture/stats').json();snapshots=execution_stats.get('execution_snapshots',[]);plan_snapshot=next((item['snapshot'].get('plan') for item in snapshots if item.get('session_id')==sid),None)
   assert plan_snapshot and plan_snapshot.get('name')=='验收模板 '+str(width),{'sid':sid,'execution_snapshots':snapshots}
   page.get_by_role('button',name='查看快照',exact=True).click();assert '验收模板' in page.locator('#sessionPlanContents').inner_text();page.locator('#pwOverlay .modal-close').click()
   page.get_by_role('button',name='结束方案',exact=True).click();page.wait_for_function("document.querySelector('#sessionPlanBar').hidden")
   page.evaluate("switchPage('plans')");page.wait_for_function("document.querySelector('#page-plans')?.classList.contains('active')",timeout=60000);plan_search=page.get_by_role('searchbox',name='搜索任务方案');plan_search.fill('');page.wait_for_timeout(300);page.get_by_role('combobox',name='方案类型').select_option('');feedback=page.locator('#page-plans .maintenance-feedback');page.wait_for_function("document.querySelector('#page-plans')?.classList.contains('active') && (document.querySelector('#page-plans .maintenance-feedback')?.textContent||'').includes('已显示 24 个') && document.querySelectorAll('#page-plans .expert-library-card').length===24",timeout=60000);feedback_text=feedback.inner_text();match=__import__('re').search(r'共 (\d+) 个方案 · 已显示 (\d+) 个',feedback_text);assert match and int(match.group(2))==24,feedback_text;catalog_total=int(match.group(1));assert catalog_total>48,catalog_total
   while int(match.group(2))<catalog_total:
    shown=int(match.group(2));expected=min(catalog_total,shown+24);page.get_by_role('button',name='更多方案',exact=True).click();page.wait_for_function("expected=>{const n=document.querySelectorAll('#page-plans .expert-library-card').length;return n===expected}",arg=expected,timeout=60000);feedback_text=feedback.inner_text();match=__import__('re').search(r'共 (\d+) 个方案 · 已显示 (\d+) 个',feedback_text);assert match and int(match.group(1))==catalog_total and int(match.group(2))==expected and page.locator('#page-plans .expert-library-card').count()==expected,feedback_text
   assert int(match.group(2))==catalog_total and not page.get_by_role('button',name='更多方案',exact=True).is_visible(),feedback_text
   assert page.evaluate('document.documentElement.scrollWidth<=innerWidth');assert not errors,errors
   page.screenshot(path=str(shots/f'plans-{width}.png'))
   results.append({'viewport':[width,height],'catalog_paging':True,'duplicate_tabs_removed':True,'team_draft_preserved':True,'new_template_draft':True,'input_validation':True,'cycle_validation':True,'undo':True,'durable_execution_single':True,'session_snapshot':True,'clear_plan':True,'errors':errors});print(json.dumps(results[-1],ensure_ascii=False),flush=True);context.close()
  browser.close()
 (shots/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
finally:
 stop_server()
