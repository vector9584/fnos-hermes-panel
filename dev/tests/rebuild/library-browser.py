"""Library reads/edits use an isolated real file store, never production knowledge or memories."""
import os,json,signal,subprocess,tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright
from preview_process import preview_launcher, read_startup_line
ROOT=Path(__file__).resolve().parent
state=Path(tempfile.mkdtemp(prefix='hermes-library-preview-',dir='/tmp'));state.chmod(0o777);(state/'native-home/cron').mkdir(parents=True);(state/'native-home/cron').chmod(0o777);(state/'native-home/cron/jobs.json').write_text('{"jobs":[]}');(state/'native-home/config.yaml').write_text('auxiliary: {}\n')
env={**os.environ,'HOME':str(state),'PREVIEW_STATE_ROOT':str(state),'PREVIEW_PORT':'0','TEST_PYTHON':'/vol1/@apphome/hermes-agent/data/venv/bin/python3','PYTHONDONTWRITEBYTECODE':'1'}
os.environ['PLAYWRIGHT_BROWSERS_PATH']='/vol1/@apphome/hermes-agent/data/.cache/ms-playwright'
node='/vol1/@apphome/hermes-agent/data/node/bin/node';cmd=preview_launcher()+['env']+[f'{key}={env[key]}' for key in ('HOME','PREVIEW_STATE_ROOT','PREVIEW_PORT','TEST_PYTHON','PYTHONDONTWRITEBYTECODE')]+[node,str(ROOT/'preview-server.mjs')]
server=subprocess.Popen(cmd,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
shots=Path(tempfile.mkdtemp(prefix='hermes-library-evidence-',dir='/tmp'));shots.chmod(0o777);results=[]
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
   page=context.new_page();errors=[];legacy_requests=[];page.on('pageerror',lambda e:errors.append(str(e)))
   retired_paths=('/api/kb/graph','/api/kb/trace','/api/kb/import-memory','/api/memory/distill','/api/memory/daily','/api/evolution','/api/memory/curator/run')
   page.on('request',lambda request:legacy_requests.append(request.url) if any(path in request.url for path in retired_paths) else None)
   # Run the legacy periodic mount without a wall-clock wait; retain every callback for explicit replay.
   page.add_init_script('''window.__libraryPeriodic=[];const originalInterval=window.setInterval;window.setInterval=function(fn,ms,...args){if(ms===5000)window.__libraryPeriodic.push(()=>fn(...args));return originalInterval(fn,ms,...args);};''')
   page.goto(url,wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'");page.evaluate("switchPage('kb')")
   kb=page.locator('#page-kb');kb.get_by_role('button',name='文件夹：项目甲',exact=True).click();page.wait_for_function("document.querySelectorAll('#page-kb .library-item').length===2");assert '项目甲/索引.md' in kb.inner_text();kb.get_by_role('button',name='全部资料',exact=True).click();page.wait_for_function("document.querySelectorAll('#page-kb .library-item').length===40")
   view_switch=kb.locator('.library-view-switch');view_switch.get_by_role('button',name='笔记关系',exact=True).click();graph=kb.locator('.library-graph-view');graph.get_by_role('button',name='打开笔记：项目甲/索引.md',exact=True).wait_for(timeout=60000);graph.get_by_role('button',name='打开笔记：项目甲/索引.md',exact=True).click();page.wait_for_function("document.querySelector('#page-kb .library-document h2')?.textContent==='索引.md'",timeout=60000);assert '链接到' in page.locator('#page-kb .library-content').inner_text();assert view_switch.get_by_role('button',name='笔记关系',exact=True).is_visible();assert view_switch.get_by_role('button',name='资料库',exact=True).get_attribute('aria-pressed')=='true';
   if width<=768:kb.get_by_role('button',name='资料列表',exact=True).click()
   else:kb.get_by_role('button',name='资料库',exact=True).click()
   page.wait_for_function("document.querySelectorAll('#page-kb .library-item').length===40")
   kb.get_by_role('button',name='更多资料',exact=True).click();page.wait_for_function("document.querySelectorAll('#page-kb .library-item').length===80")
   kb.get_by_role('searchbox',name='搜索资料').fill('全文检索标记 42');page.wait_for_function("document.querySelectorAll('#page-kb .library-item').length===1");assert kb.get_by_role('button',name='文件夹：项目甲',exact=True).is_visible()
   kb.locator('.library-item').click();kb.get_by_role('button',name='编辑',exact=True).click();text=kb.get_by_role('textbox',name='资料内容');original=text.input_value();text.fill(original+'\n浏览器草稿 '+str(width));page.reload(wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'")
   page.evaluate("switchPage('kb')");page.wait_for_function("document.querySelector('#page-kb .library-editor')?.value.includes('浏览器草稿')")
   kb.get_by_role('button',name='保存修改',exact=True).click();page.wait_for_function("!document.querySelector('#page-kb .library-content').hidden")
   assert '浏览器草稿 '+str(width) in kb.locator('.library-content').inner_text()
   history_trigger=kb.get_by_role('button',name='修改记录',exact=True);history_trigger.click();history=page.get_by_role('dialog',name='资料修改记录');page.keyboard.press('Escape');history.wait_for(state='detached');assert page.evaluate('(trigger)=>document.activeElement===trigger',history_trigger.element_handle())
   history_trigger.click();history=page.get_by_role('dialog',name='资料修改记录');history.get_by_role('button',name='撤销这次修改',exact=True).click();history.wait_for(state='detached')
   page.wait_for_function("document.querySelector('#page-kb .library-editor')?.value==="+json.dumps(original))
   with page.expect_download() as download:kb.get_by_role('button',name='下载原文',exact=True).click()
   assert Path(download.value.path()).read_text()==original
   # An unsaved new file restores after reload without creating a source file on read.
   create_trigger=kb.get_by_role('button',name='新建笔记',exact=True);create_trigger.click();new=page.get_by_role('dialog',name='新建知识笔记');page.keyboard.press('Escape');new.wait_for(state='detached');assert page.evaluate('(trigger)=>document.activeElement===trigger',create_trigger.element_handle())
   create_trigger.click();new=page.get_by_role('dialog',name='新建知识笔记');new.get_by_role('textbox',name='笔记路径').fill('草稿目录/新资料'+str(width)+'.md');new.get_by_role('button',name='创建并编辑').click()
   page.get_by_role('textbox',name='资料内容').wait_for();assert page.evaluate('document.activeElement===document.querySelector("#page-kb .library-editor")');assert page.locator('dialog:modal').count()==0
   kb.get_by_role('textbox',name='资料内容').fill('新笔记未保存内容');page.reload(wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'");page.evaluate("switchPage('kb')")
   page.wait_for_function("document.querySelector('#page-kb .library-editor')?.value==='新笔记未保存内容'");kb.get_by_role('button',name='保存修改',exact=True).click();page.wait_for_function("!document.querySelector('#page-kb .library-content').hidden")
   page.evaluate("switchPage('memory')");memory=page.locator('#page-memory');memory.locator('.library-item').first.click();memory.get_by_role('button',name='编辑',exact=True).click();text=memory.get_by_role('textbox',name='资料内容');text.fill(text.input_value()+'用户草稿\n')
   context.request.post(url+'/__fixture/library-change',data={});memory.get_by_role('button',name='保存修改',exact=True).click();memory.get_by_role('button',name='查看最新原文并合并',exact=True).click()
   merge=page.get_by_role('dialog',name='合并资料修改');assert '内核新增记忆' in merge.locator('pre').inner_text();merge.get_by_role('textbox',name='合并后的资料').fill('用户草稿\n内核新增记忆\n');merge.get_by_role('button',name='采用合并稿',exact=True).click();memory.get_by_role('button',name='保存修改',exact=True).click()
   page.wait_for_function("document.querySelector('#page-memory .library-content').textContent.includes('内核新增记忆') && !document.querySelector('#page-memory .library-content').hidden")
   if width<=768:memory.get_by_role('button',name='资料列表',exact=True).click()
   memory.get_by_role('combobox',name='记忆来源').select_option('daily');assert memory.locator('.library-document h2').inner_text()=='选择资料查看全文';page.wait_for_function("document.querySelector('#page-memory .library-list').textContent.includes('2026-11-04.md')");memory.locator('.library-item').first.click();page.wait_for_function("document.querySelector('#page-memory .library-content').textContent.includes('日记末尾')")
   assert len(memory.locator('.library-content').inner_text())>2000
   assert not memory.get_by_role('button',name='编辑',exact=True).is_visible()
   for alias in ['memDistill','memLoadDaily','memLoadEvolution']:
    page.evaluate("switchPage('kb')")
    page.evaluate('(alias)=>window[alias]()',alias)
    assert memory.is_visible()
   page.evaluate('window.__libraryPeriodic.forEach(fn=>fn())')
   assert page.locator('#kbFusionTabs,#memFusionBox,#kbLayoutFix,#kbGraphBox,#kbTraceBox').count()==0
   assert page.evaluate("typeof window.memCuratorRun==='undefined' && typeof window.kbTabSwitch==='undefined'")
   assert legacy_requests==[],legacy_requests
   assert page.locator('#kbImportMemBtn').count()==0
   assert page.get_by_text('一键蒸馏记忆',exact=False).count()==0
   # Generate a review with an isolated model, refresh/reopen, inspect provenance and apply with backup.
   memory.get_by_role('button',name='整理草稿',exact=True).click();reviews=page.get_by_role('dialog',name='记忆整理草稿')
   reviews.get_by_role('combobox',name='整理模型').select_option(label='服务乙 / same-model')
   reviews.get_by_role('searchbox',name='搜索整理资料').fill('全文检索标记 42');page.wait_for_function("document.querySelector('.review-source-options').textContent.includes('笔记042.md') && document.querySelectorAll('.review-source-options label').length===1");reviews.locator('input[type=checkbox]').first.check()
   before_review=len(context.request.get(url+'/api/panel-library-reviews',headers=headers).json()['reviews'])
   reviews.get_by_role('button',name='生成整理草稿',exact=True).click();reviews.get_by_text('正在生成',exact=True).first.wait_for()
   reviews.get_by_role('button',name='关闭',exact=True).click();memory.get_by_role('button',name='整理草稿',exact=True).click()
   reviews.get_by_role('button',name='审阅草稿',exact=True).first.click();review=page.get_by_role('dialog',name='审阅记忆草稿')
   assert review.get_by_role('textbox',name='整理草稿内容').input_value().startswith('# 整理记忆')
   assert len(context.request.get(url+'/api/panel-library-reviews',headers=headers).json()['reviews'])==before_review+1
   review.get_by_role('textbox',name='整理草稿内容').fill('审阅后的记忆 '+str(width))
   page.screenshot(path=str(shots/f'review-{width}.png'))
   review.get_by_role('button',name='应用到长期记忆',exact=True).click();review.get_by_text('长期记忆已保存',exact=False).wait_for()
   current=context.request.get(url+'/api/panel-library/document?source=memory&path=MEMORY.md',headers=headers).json();assert current['document']['content']=='审阅后的记忆 '+str(width)
   review.get_by_role('button',name='打开长期记忆',exact=True).click();page.wait_for_function("document.querySelector('#page-memory .library-content').textContent.includes('审阅后的记忆')")
   assert memory.locator('select[aria-label="记忆来源"]').input_value()=='memory'
   page.wait_for_function("document.querySelector('#page-memory .library-list').textContent.includes('MEMORY.md')")
   memory.get_by_role('button',name='修改记录',exact=True).click();history=page.get_by_role('dialog',name='资料修改记录');history.get_by_role('button',name='撤销这次修改',exact=True).click();history.wait_for(state='detached')
   page.wait_for_function("document.querySelector('#page-memory .library-content').textContent.includes('内核新增记忆')")
   assert not errors,errors;assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
   page.screenshot(path=str(shots/f'library-{width}.png'))
   results.append({'viewport':[width,height],'folder_browsing':True,'note_graph_links_and_open':True,'paging':True,'full_text_search':True,'draft_refresh':True,'save_backup_undo':True,'new_note_draft_reload':True,'export_original':True,'external_change_conflict_merge':True,'full_daily_over_2000':True,'read_only_report':True,'legacy_unsafe_buttons_removed':True,'legacy_boot_and_periodic_mount_removed':True,'legacy_aliases_open_unified_memory':True,'legacy_requests':legacy_requests,'source_and_document_consistent':True,'review_background_reopen':True,'review_apply_undo':True,'errors':errors});print(json.dumps(results[-1],ensure_ascii=False),flush=True);context.close()
  browser.close()
 (shots/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
finally:
 stop_server()
