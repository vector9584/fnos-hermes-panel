"""Verify keyboard access for service switches and multi-session controls."""
import json
import os
import signal
import subprocess
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright
from preview_process import preview_launcher, read_startup_line


ROOT = Path(__file__).resolve().parent
STATE = Path(tempfile.mkdtemp(prefix='hermes-keyboard-controls-', dir='/tmp'))
STATE.chmod(0o777)
(STATE / 'native-home/cron').mkdir(parents=True)
(STATE / 'native-home/cron/jobs.json').write_text('{"jobs":[]}')
(STATE / 'native-home/config.yaml').write_text('auxiliary: {}\n')
env = {**os.environ, 'HOME': str(STATE), 'PREVIEW_STATE_ROOT': str(STATE), 'PREVIEW_PORT': '0',
       'PYTHONDONTWRITEBYTECODE': '1', 'TEST_PYTHON': os.environ.get(
           'HERMES_TEST_PYTHON', '/vol1/@apphome/hermes-agent/data/venv/bin/python3')}
node = os.environ.get('HERMES_PREVIEW_NODE', '/vol1/@apphome/hermes-agent/data/node/bin/node')
os.environ['PLAYWRIGHT_BROWSERS_PATH'] = os.environ.get(
    'HERMES_PLAYWRIGHT_BROWSERS_PATH',
    os.environ.get('PLAYWRIGHT_BROWSERS_PATH', '/vol1/@apphome/hermes-agent/data/.cache/ms-playwright'))
command = preview_launcher() + ['env'] + [f'{key}={env[key]}' for key in
          ('HOME', 'PREVIEW_STATE_ROOT', 'PREVIEW_PORT', 'PYTHONDONTWRITEBYTECODE', 'TEST_PYTHON')] + [
              node, str(ROOT / 'preview-server.mjs')]
server = subprocess.Popen(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          text=True, start_new_session=True)


try:
    startup = read_startup_line(server)
    url = f"http://127.0.0.1:{json.loads(startup)['port']}"
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(args=['--no-sandbox'])
        context = browser.new_context(viewport={'width': 1440, 'height': 900})
        def route_request(route):
            if route.request.url.split('?', 1)[0].endswith('/api/sessions'):
                return route.fulfill(status=200, content_type='application/json', body=json.dumps({'sessions':[{'id':'keyboard-a','title':'键盘切换测试','created_at':1,'message_count':0},{'id':'keyboard-b','title':'备用会话','created_at':2,'message_count':0}]}))
            if route.request.url.startswith(url):
                return route.continue_(url=route.request.url.replace('/app/hermes-agent/', '/'))
            return route.abort()
        context.route('**/*', route_request)
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(url, wait_until='domcontentloaded')
        page.wait_for_function("document.body.classList.contains('workbench-navigation') && monitorToken==='fixture-token' && _sessions.some(session=>session.id==='keyboard-a')")

        viewport_results = []
        for width, height in ((1440, 900), (390, 844), (844, 390)):
            page.set_viewport_size({'width': width, 'height': height})
            page.evaluate("""() => {
              _multiTabsForced = false;
              _tabsManuallyHidden = false;
              _expertPickerTab = 'single';
              window.__keyboardServiceActions = [];
              toggleService = name => window.__keyboardServiceActions.push(name);
              switchPage('overview');
            }""")
            page.evaluate("""() => {
              window.__serviceFeedback=[];
              toast=message=>window.__serviceFeedback.push(message);
              apiPost=()=>Promise.resolve({gateway:{ok:true},dashboard:{ok:false,error:'端口被占用'}});
              _connecting=false;
              startServices();
            }""")
            page.wait_for_function("window.__serviceFeedback.some(message=>message.includes('启动失败：端口被占用'))")
            assert page.evaluate("_connecting") is False
            page.evaluate("""() => {
              window.__serviceFeedback=[];
              apiPost=()=>Promise.resolve({ok:false,error:'服务停止失败'});
              _connecting=false;
              stopServices('dashboard');
            }""")
            page.wait_for_function("window.__serviceFeedback.some(message=>message.includes('停止失败：服务停止失败'))")
            assert page.evaluate("_connecting") is False
            page.evaluate("""() => {
              window.__serviceFeedback=[];
              apiPost=()=>Promise.resolve({gateway:{ok:true},dashboard:{ok:true}});
              apiGet=()=>Promise.resolve({gateway:{running:true},dashboard:{running:true}});
              startServices();
            }""")
            page.wait_for_function("window.__serviceFeedback.some(message=>message==='服务已启动')")
            assert page.evaluate("_connecting") is False
            assert page.locator('#ovStatusText').inner_text() == '运行中'
            gateway = page.locator('#gwToggle')
            assert gateway.get_attribute('role') == 'switch'
            assert gateway.get_attribute('aria-label') == 'Gateway 服务'
            gateway.focus()
            page.keyboard.press('Space')
            assert page.evaluate("window.__keyboardServiceActions.includes('gateway')")
            page.evaluate("""() => {
              switchPage('chat');
              if (!_sessions.some(session => session.id === 'keyboard-a') ||
                  !_sessions.some(session => session.id === 'keyboard-b')) {
                throw new Error('session fixture response was not applied');
              }
              _openTabs = ['keyboard-a','keyboard-b'];
              currentSession = 'keyboard-a';
              _multiTabsForced = true;
              _tabsManuallyHidden = false;
              renderSessionTabs();
            }""")
            page.locator('#multiTabsBtn').wait_for()
            page.wait_for_function("document.querySelector('#multiTabsBtn')?.getAttribute('aria-expanded') === 'true'")
            target = page.get_by_role('button', name='切换到会话：备用会话', exact=True)
            target.focus()
            assert page.evaluate("document.activeElement?.getAttribute('aria-label')") == '切换到会话：备用会话'
            page.keyboard.press('Enter')
            assert page.evaluate("currentSession") == 'keyboard-b'
            for name in ('重命名会话：备用会话', '关闭会话标签：备用会话'):
                box = page.get_by_role('button', name=name, exact=True).bounding_box()
                assert box and box['width'] >= 24 and box['height'] >= 24
            page.evaluate("""() => {
              buildMiniData = () => ({quick:{title:'快捷指令',groups:[{title:'会话',commands:[{cmd:'/new 今天',title:'新会话',ico:'+'}]}]},
                expert:{title:'选择角色',items:[{id:'expert-a',t:'测试专家',d:'说明',ico:'E'}]},
                model:{title:'选择模型',groups:[{name:'本地',items:[{provider:'local',model:'m1',t:'模型一',d:'测试模型',ico:'M',active:false}]}]},
                skill:{title:'选择技能',items:[{t:'测试技能',d:'说明',ico:'S'}]}});
              window.__keyboardPicked = '';
              pickQuick = command => { window.__keyboardPicked = command; closeMini(); };
            }""")
            if width <= 768:
                page.locator('#toolbarToggle').click()
                assert page.locator('#toolbar').is_visible()
            quick = page.locator('#btnQuick')
            quick.focus()
            page.keyboard.press('Enter')
            command = page.get_by_role('button', name='新会话: /new 今天', exact=True)
            assert command.count() == 1
            command.focus()
            page.keyboard.press('Enter')
            assert page.evaluate("window.__keyboardPicked") == '/new 今天'
            assert page.evaluate("document.activeElement.id") == 'btnQuick'

            page.evaluate("openMini(document.getElementById('btnExpert'),'expert')")
            assert page.get_by_role('tab', name='专家', exact=True).get_attribute('aria-selected') == 'true'
            page.keyboard.press('ArrowRight')
            assert page.get_by_role('tab', name='表达风格', exact=True).get_attribute('aria-selected') == 'true'
            page.keyboard.press('Escape')
            assert page.evaluate("document.activeElement.id") == 'btnExpert'

            page.evaluate("openMini(document.getElementById('btnModel'),'model')")
            model = page.get_by_role('button', name='模型一 测试模型', exact=False)
            assert model.count() == 1
            assert model.get_attribute('aria-pressed') == 'false'
            model.focus()
            page.keyboard.press('Enter')
            assert page.evaluate("_getSessionModel().model") == 'm1'

            page.evaluate("_activeSkills=['测试技能'];renderSkillChips()")
            remove_skill = page.get_by_role('button', name='移除技能：测试技能', exact=True)
            remove_skill.focus()
            page.keyboard.press('Enter')
            assert page.evaluate("_activeSkills.length") == 0
            page.evaluate("switchPage('extensions')")
            assert page.locator('#page-extensions .ext-card[onclick]').count() == 0
            viewport_results.append(f'{width}x{height}')
        assert not errors, errors
        print(json.dumps({'keyboard_service_switch': True, 'service_nested_start_error_feedback': True,
                          'service_stop_error_feedback': True, 'keyboard_session_switch': True,
                          'service_start_waits_for_confirmed_state': True,
                          'session_actions_focusable': True, 'session_action_min_size': 24,
                          'chat_popup_keyboard': True, 'chat_popup_focus_restore': True,
                          'chat_popup_tabs_arrow_navigation': True, 'skill_chip_keyboard_remove': True,
                          'extension_pointer_only_cards': 0,
                          'viewports': viewport_results,
                          'page_errors': errors}, ensure_ascii=False), flush=True)
        context.close()
        browser.close()
finally:
    try:
        os.killpg(server.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        server.wait(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(server.pid, signal.SIGKILL)
        server.wait(timeout=5)
