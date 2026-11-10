import json
import os
import pwd
import shlex
import sqlite3
import subprocess
import signal
import tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright
from preview_process import preview_launcher, read_startup_line

ROOT = Path(__file__).resolve().parent
STATE = Path(tempfile.mkdtemp(prefix='hermes-maintenance-preview-', dir='/tmp')); STATE.chmod(0o777)
HOME = STATE / 'native-home'
HOME.mkdir(parents=True); HOME.chmod(0o777); (HOME / 'cron').mkdir(parents=True); (HOME / 'cron').chmod(0o777)
JOB = {'id': 'fixture-job', 'name': '备份检查', 'prompt': '', 'script': 'fixture.py',
       'no_agent': True, 'enabled': False, 'state': 'paused', 'paused_reason': '用户暂停',
       'schedule': {'kind': 'interval', 'minutes': 30, 'display': 'every 30m'},
       'repeat': {'times': 10, 'completed': 4}, 'deliver': 'discord:fixture-target',
       'last_status': 'success', 'last_run_at': '2026-11-01T00:00:00+08:00'}
def native_write(path, text):
    path=Path(path);temp=path.with_name(path.name+'.fixture-'+str(os.getpid()));temp.write_text(text);temp.chmod(0o644);os.replace(temp,path)

native_write(HOME/'cron/jobs.json',json.dumps({'jobs':[JOB]}))
OUTPUT = HOME / 'cron/output/fixture-job'
OUTPUT.mkdir(parents=True); OUTPUT.chmod(0o777)
for record_index in range(35):
    native_write(OUTPUT / ('2026-11-01_00-00-' + str(record_index).zfill(2) + '.md'),'# 执行产物\n\n<script>window.historyInjected=true</script>\n归档后也能查看的完整结果。')
with sqlite3.connect(HOME / 'state.db') as connection:
    connection.executescript('''
        CREATE TABLE sessions (id TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, api_call_count INTEGER);
        INSERT INTO sessions VALUES ('legacy','last-model',1200,300,4);
        CREATE TABLE messages (session_id TEXT, timestamp REAL, active INTEGER);
        INSERT INTO messages VALUES ('legacy',1704124800,1);
    ''')
os.chmod(HOME / 'state.db',0o666)
env = {**os.environ, 'PREVIEW_STATE_ROOT': str(STATE), 'PREVIEW_PORT': '0',
       'HOME': str(STATE), 'TEST_PYTHON': os.environ.get('HERMES_TEST_PYTHON', '/vol1/@apphome/hermes-agent/data/venv/bin/python3'),
       'HERMES_TEST_NATIVE_ROOT': '', 'PYTHONDONTWRITEBYTECODE': '1'}
os.environ['PLAYWRIGHT_BROWSERS_PATH'] = os.environ.get('HERMES_PLAYWRIGHT_BROWSERS_PATH', os.environ.get('PLAYWRIGHT_BROWSERS_PATH', '/vol1/@apphome/hermes-agent/data/.cache/ms-playwright'))
node=os.environ.get('HERMES_PREVIEW_NODE','/vol1/@apphome/hermes-agent/data/node/bin/node');cmd=preview_launcher()+['env']+[f'{k}={env[k]}' for k in ('PREVIEW_STATE_ROOT','PREVIEW_PORT','HOME','TEST_PYTHON','HERMES_TEST_NATIVE_ROOT','PYTHONDONTWRITEBYTECODE')]+[node,str(ROOT/'preview-server.mjs')]
server = subprocess.Popen(cmd,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
shots = Path(tempfile.mkdtemp(prefix='hermes-maintenance-evidence-',dir='/tmp')); shots.chmod(0o777)
def stop_server():
    try: os.killpg(server.pid,signal.SIGTERM)
    except ProcessLookupError: pass
    try: server.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try: os.killpg(server.pid,signal.SIGKILL)
        except (ProcessLookupError,PermissionError): pass
        try: server.wait(timeout=5)
        except subprocess.TimeoutExpired: pass
results = []
try:
    first=read_startup_line(server)
    port=int(json.loads(first)['port']);url='http://127.0.0.1:'+str(port);print(first,flush=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(args=['--no-sandbox'])
        for width, height in [(1440, 900), (390, 844), (844, 390)]:
            context = browser.new_context(viewport={'width': width, 'height': height})
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            context.route('**/*', lambda route: route.continue_(url=route.request.url.replace('/app/hermes-agent/', '/'))
                          if route.request.url.startswith(url) else route.abort())
            page.goto(url, wait_until='domcontentloaded')
            page.wait_for_function("document.body.classList.contains('workbench-navigation') && typeof openCronEditor==='function' && monitorToken==='fixture-token'")
            assert page.evaluate("document.body.classList.contains('theme-dark')")
            echo_writes = []
            page.on('response', lambda response: echo_writes.append({
                'status': response.status,
                'request': response.request.post_data,
            }) if response.url.endswith('/api/echo') and response.request.method == 'POST' else None)
            job = context.request.get(url + '/api/cron-jobs').json()['jobs'][0]
            page.evaluate('job => openCronEditor(job)', job)
            assert page.locator('[name=script]').input_value() == 'fixture.py'
            assert page.locator('[name=no_agent]').is_checked()
            assert page.locator('[name=deliver]').input_value() == 'discord:fixture-target'
            assert page.locator('[name=schedule]').input_value() == 'every 30m'
            page.locator('[name=name]').fill('改名验证 ' + str(width))
            page.locator('.cron-native-editor').screenshot(path=str(shots / ('cron-' + str(width) + '.png')))
            page.locator('.cron-native-editor button[type=submit]').click()
            page.wait_for_function("!document.querySelector('.cron-native-editor') || (!document.querySelector('.cron-native-editor button[type=submit]').disabled && document.querySelector('.cron-editor-feedback').textContent)")
            assert page.locator('.cron-native-editor').count() == 0, page.locator('.cron-editor-feedback').inner_text()
            saved = context.request.get(url + '/api/cron-jobs').json()['jobs'][0]
            assert saved['id'] == 'fixture-job' and saved['state'] == 'paused'
            assert saved['name'] == '改名验证 ' + str(width)
            assert saved['repeat']['completed'] == 4
            page.evaluate('job => openCronEditor(job)', job)
            page.locator('[name=name]').fill('过期页面修改')
            page.locator('.cron-native-editor button[type=submit]').click()
            page.wait_for_function("document.querySelector('.cron-editor-feedback').textContent.includes('其他页面修改')")
            assert page.locator('[name=name]').input_value() == '过期页面修改'
            assert context.request.get(url + '/api/cron-jobs').json()['jobs'][0]['name'] == saved['name']
            page.once('dialog', lambda dialog: dialog.accept())
            page.locator('.cron-editor-discard').click()
            page.wait_for_function("document.querySelector('[name=name]').value !== '过期页面修改'")
            assert page.locator('[name=name]').input_value() == saved['name']
            page.locator('.cron-editor-cancel').click()
            page.evaluate("openCronModal()")
            page.locator('[name=name]').fill('创建测试 ' + str(width))
            page.locator('[name=prompt]').fill('写一句问候')
            page.reload(wait_until='domcontentloaded')
            page.wait_for_function("typeof openCronEditor==='function' && monitorToken==='fixture-token'")
            page.evaluate("openCronModal()")
            assert page.locator('[name=name]').input_value() == '创建测试 ' + str(width)
            assert page.locator('[name=prompt]').input_value() == '写一句问候'
            page.locator('.cron-native-editor button[type=submit]').click()
            page.wait_for_function("!document.querySelector('.cron-native-editor') || (!document.querySelector('.cron-native-editor button[type=submit]').disabled && document.querySelector('.cron-editor-feedback').textContent)")
            assert page.locator('.cron-native-editor').count() == 0, page.locator('.cron-editor-feedback').inner_text()
            created = context.request.get(url + '/api/cron-jobs').json()['jobs']
            assert sum(job['name'] == '创建测试 ' + str(width) for job in created) == 1
            hook_headers = {'X-Monitor-Token': 'fixture-token'}
            hook_before = context.request.get(url + '/api/cron-jobs/fixture-job/webhooks', headers=hook_headers).json()
            context.request.put(url + '/api/cron-jobs/fixture-job/webhooks', headers=hook_headers, data={'revision': hook_before['revision'], 'hooks': []})
            page.evaluate("openCronHooks('fixture-job')")
            page.locator('.cron-hook-add').click()
            page.locator('.cron-hook-card [name=label]').fill('测试投递 ' + str(width))
            page.locator('.cron-hook-card [name=url]').fill('https://example.com/never-sent')
            page.locator('.cron-hook-card [name=message]').fill('结果：{output}')
            page.locator('.cron-hook-card button').click()
            page.locator('.cron-editor-feedback button').click()
            assert page.locator('.cron-hook-card [name=url]').input_value() == 'https://example.com/never-sent'
            page.locator('.cron-native-editor [type=submit]').click()
            page.wait_for_selector('.cron-native-editor', state='detached')
            hook_response = context.request.get(url + '/api/cron-jobs/fixture-job/webhooks', headers={'X-Monitor-Token': 'fixture-token'}).json()
            assert hook_response['hooks'][0]['label'] == '测试投递 ' + str(width)
            page.evaluate("openCronHooks('fixture-job')")
            page.wait_for_function("document.querySelector('.cron-hook-card input') !== null")
            assert page.locator('.cron-hook-card [name=message]').input_value() == '结果：{output}'
            page.locator('.cron-native-editor').screenshot(path=str(shots / ('webhooks-' + str(width) + '.png')))
            page.locator('.cron-native-editor .modal-close').click()
            page.once('dialog', lambda dialog: dialog.accept())
            page.evaluate("cronAction('fixture-job','archive')")
            page.wait_for_function("!window._cronActionBusy")
            archived = context.request.get(url + '/api/cron-jobs').json()['jobs'][0]
            assert archived['panel_archived'] and not archived['enabled']
            page.once('dialog', lambda dialog: dialog.accept())
            page.evaluate("cronAction('fixture-job','restore')")
            page.wait_for_function("!window._cronActionBusy")
            restored = context.request.get(url + '/api/cron-jobs').json()['jobs'][0]
            assert not restored['panel_archived'] and restored['state'] == 'paused'
            page.evaluate("openCronHistory('fixture-job')")
            page.wait_for_selector('.cron-history-record')
            assert page.locator('.cron-history-record').count() == 30
            page.locator('.cron-history-more').click()
            page.wait_for_function("document.querySelectorAll('.cron-history-record').length===35")
            assert not page.locator('.cron-history-more').is_visible()
            page.locator('.cron-history-record').first.click()
            page.wait_for_selector('.cron-history-result', state='visible')
            assert '归档后也能查看的完整结果' in page.locator('.cron-history-result pre').inner_text()
            assert page.evaluate('window.historyInjected') is None
            with page.expect_download() as downloaded:
                page.locator('.cron-history-download').click()
            assert downloaded.value.suggested_filename.endswith('.md')
            assert '完整结果' in Path(downloaded.value.path()).read_text()
            page.locator('.cron-history').screenshot(path=str(shots / ('history-' + str(width) + '.png')))
            page.locator('.cron-history .modal-close').click()
            if width <= 768:
                page.locator('.mobile-navigation [data-group=tasks]').click()
            else:
                page.locator('.workbench-sidebar [data-group=tasks]').click()
            page.locator('.section-navigation').get_by_role('button', name='回声站 ECHO', exact=True).click()
            page.wait_for_function("/^(共|匹配) .*，已显示 /.test(document.getElementById('echoFeedback').textContent.trim())")
            page.locator('.echo-new').click()
            page.locator('.echo-dialog [name=title]').fill('回声测试 ' + str(width))
            page.locator('.echo-dialog [name=detail]').fill('验收完整要求，刷新后保留')
            page.locator('.echo-dialog [name=star]').fill('0.5')
            page.reload(wait_until='domcontentloaded')
            page.wait_for_function("typeof renderEchoPage==='function' && monitorToken==='fixture-token'")
            page.evaluate("switchPage('echo')")
            page.locator('.echo-new').click()
            assert page.locator('.echo-dialog [name=title]').input_value() == '回声测试 ' + str(width)
            page.locator('.echo-dialog .primary').click()
            try:
                page.wait_for_selector('.echo-dialog', state='detached', timeout=5000)
            except Exception as error:
                dialog = page.locator('.echo-dialog')
                queue = context.request.get(url + '/api/echo').json()
                raise AssertionError({
                    'viewport': [width, height],
                    'dialog': dialog.evaluate('(element) => ({label:element.getAttribute("aria-label"), text:element.innerText, submitDisabled:element.querySelector(".primary")?.disabled})') if dialog.count() else None,
                    'echo_writes': echo_writes,
                    'matching_tasks': [task for task in queue.get('tasks', []) if task.get('title') == '回声测试 ' + str(width)],
                    'draft_local': page.evaluate("Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.startsWith('echo-draft:')))")
                }) from error
            target_title = '回声测试 ' + str(width)
            page.locator('#echoSearch').fill(target_title)
            page.wait_for_function("title=>[...document.querySelectorAll('.echo-card h3')].some(e=>e.textContent===title)", arg=target_title)
            target_heading = page.get_by_role('heading', name=target_title, exact=True)
            assert target_heading.count() == 1
            target_card = target_heading.locator('xpath=ancestor::article[contains(concat(" ",normalize-space(@class)," ")," echo-card ")]')
            assert target_card.count() == 1
            assert target_card.locator('h3').inner_text() == target_title
            assert '暂存' in target_card.inner_text()
            target_card.get_by_role('button', name='查看任务与回信').click()
            page.once('dialog', lambda dialog: dialog.accept())
            page.locator('.echo-dialog').get_by_role('button', name='归档', exact=True).click()
            try:
                page.wait_for_function("document.querySelector('.echo-dialog .echo-status')?.textContent.includes('已沉寂')", timeout=10000)
            except Exception as error:
                raise AssertionError('ECHO archive did not update detail status; dialog='+repr(page.locator('.echo-dialog').inner_text())+'; status='+repr(page.locator('.echo-dialog .echo-status').all_text_contents())) from error
            page.once('dialog', lambda dialog: dialog.accept())
            page.locator('.echo-dialog').get_by_role('button', name='恢复归档', exact=True).click()
            page.wait_for_function("document.querySelector('.echo-dialog .echo-status')?.textContent.includes('暂存')")
            page.locator('.echo-dialog .modal-close').click()
            page.reload(wait_until='domcontentloaded')
            page.wait_for_function("document.getElementById('page-echo').classList.contains('active') && /^(共|匹配) .*，已显示 /.test(document.getElementById('echoFeedback').textContent.trim())")
            assert page.locator('#echoSearch').input_value() == '回声测试 ' + str(width)
            page.screenshot(path=str(shots / ('echo-' + str(width) + '.png')))
            if width <= 768:
                page.locator('.mobile-more').click()
                page.locator('.navigation-dialog').get_by_role('button', name='用量统计', exact=True).click()
                assert not page.locator('.navigation-dialog').is_visible()
            else:
                page.locator('.workbench-sidebar [data-group=maintenance]').click()
                page.locator('.section-navigation').get_by_role('button', name='用量统计', exact=True).click()
            page.wait_for_function("document.getElementById('usageByModelList').textContent.includes('1,500')")
            usage_text = page.locator('#usageByModelList').inner_text()
            assert usage_text.strip() and '模型' in usage_text
            assert 'Dashboard' not in page.locator('#usageSummaryCards').inner_text()
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
            page.screenshot(path=str(shots / ('usage-' + str(width) + '.png')))
            page.go_back(wait_until='domcontentloaded')
            page.wait_for_function("document.getElementById('page-'+(location.hash.replace(/^#\\/?/,'')||'chat')).classList.contains('active')")
            page.go_forward(wait_until='domcontentloaded')
            page.wait_for_function("document.getElementById('page-usage').classList.contains('active')")
            if width <= 768:
                assert page.locator('.mobile-more').get_attribute('aria-label') == '更多页面，当前为维护'
                page.locator('.mobile-more').click()
                destinations = page.locator('.navigation-dialog section button').all_text_contents()
                expected = {'会话', '专家库', '专家讨论', '回声站 ECHO', '定时任务', '知识库', '记忆与记录', '技能与工具', '渠道与连接器', '模型服务', '运行状态', '用量统计', '本地版本', '偏好设置'}
                assert expected.issubset(set(destinations)), (expected, destinations)
                page.keyboard.press('Escape')
                assert not page.locator('.navigation-dialog').is_visible()
                assert page.locator('.mobile-more').evaluate('(node)=>node===document.activeElement')
            else:
                assert page.locator('.workbench-sidebar .nav-btn').count() == 8
            assert not errors, errors
            results.append({'viewport': [width, height], 'native_edit': True, 'conflict_keeps_form': True,
                            'create_draft_reload': True, 'native_create': True,
                            'webhook_saved_reopened': True, 'webhook_remove_undo': True,
                            'archive_restore': True,
                            'history_paging_read_download': True,
                            'echo_draft_create_archive_restore': True,
                            'navigation_click_and_reload': True,
                            'usage_read': True, 'overflow': False, 'errors': errors})
            context.close()
        browser.close()
    (shots / 'results.json').write_text(json.dumps(results, ensure_ascii=False, indent=2))
    print(json.dumps({'results':results,'evidence_dir':str(shots),'state_dir':str(STATE)}, ensure_ascii=False), flush=True)
finally:
    stop_server()
