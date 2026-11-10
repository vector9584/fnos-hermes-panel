"""Browser verification for chat follow mode and the unobtrusive jump-to-bottom control."""
import json, os, signal, subprocess, tempfile, time
from pathlib import Path
from playwright.sync_api import sync_playwright
from preview_process import preview_launcher, read_startup_line

ROOT = Path(__file__).resolve().parent
state = Path(tempfile.mkdtemp(prefix='hermes-chat-scroll-', dir='/tmp'))
state.chmod(0o777)
(state / 'native-home/cron').mkdir(parents=True)
(state / 'native-home/cron/jobs.json').write_text('{"jobs":[]}')
(state / 'native-home/config.yaml').write_text('auxiliary: {}\n')
env = {**os.environ, 'HOME': str(state), 'PREVIEW_STATE_ROOT': str(state), 'PREVIEW_PORT': '0',
       'TEST_PYTHON': '/vol1/@apphome/hermes-agent/data/venv/bin/python3', 'PYTHONDONTWRITEBYTECODE': '1'}
os.environ['PLAYWRIGHT_BROWSERS_PATH'] = '/vol1/@apphome/hermes-agent/data/.cache/ms-playwright'
node = '/vol1/@apphome/hermes-agent/data/node/bin/node'
cmd = preview_launcher() + ['env'] + [f'{k}={env[k]}' for k in
       ('HOME', 'PREVIEW_STATE_ROOT', 'PREVIEW_PORT', 'TEST_PYTHON', 'PYTHONDONTWRITEBYTECODE')] + [node, str(ROOT / 'preview-server.mjs')]
server = subprocess.Popen(cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)

def stop_server():
    if server.poll() is not None:
        return
    try:
        os.killpg(server.pid, signal.SIGTERM)
        server.wait(timeout=8)
    except (ProcessLookupError, subprocess.TimeoutExpired):
        try:
            os.killpg(server.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        server.wait(timeout=8)

try:
    first = read_startup_line(server)
    if not first:
        raise RuntimeError('预览服务没有启动：' + (server.stderr.read().strip() or '没有启动输出'))
    port = int(json.loads(first)['port'])
    url = f'http://127.0.0.1:{port}'
    print(first, flush=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(args=['--no-sandbox'])
        for width, height in [(1440, 900), (390, 844), (844, 390)]:
            context = browser.new_context(viewport={'width': width, 'height': height})
            headers = {'X-Monitor-Token': 'fixture-token'}
            context.route('**/*', lambda route: route.continue_(url=route.request.url.replace('/app/hermes-agent/', '/'))
                          if route.request.url.startswith(url) else route.abort())
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(url, wait_until='domcontentloaded')
            page.wait_for_function("monitorToken==='fixture-token'")
            page.evaluate("currentSession='test-a';_openTabs=['test-a'];persistTabs();renderSessionTabs();loadSessionMessages('test-a')")
            # Several long fixture turns create a realistic scrollable conversation.
            for index in range(8):
                text = f'滚动验收长消息 {width}-{index}'
                page.locator('#chatInput').fill(text)
                page.evaluate('sendChat()')
                deadline = time.monotonic() + 12
                while time.monotonic() < deadline:
                    jobs = context.request.get(url + '/api/chat/queue?all=1', headers=headers).json()['jobs']
                    match = [j for j in jobs if j['session_id'] == 'test-a' and
                             ((j.get('message') or {}).get('text', '') if isinstance(j.get('message'), dict) else j.get('message', '')) == text]
                    if match and match[0]['status'] == 'done':
                        break
                    page.wait_for_timeout(100)
                assert match and match[0]['status'] == 'done', match
            page.evaluate("loadSessionMessages('test-a')")
            page.wait_for_function("document.querySelectorAll('#chatBody .msg').length>=6")
            body = page.locator('#chatBody')
            assert page.evaluate("()=>{const e=chatBody;return e.scrollHeight>e.clientHeight*1.5}")
            page.evaluate("()=>{const e=chatBody;_chatScroll.inputAt=performance.now();_chatScroll.pointer=true;e.scrollTop=e.scrollHeight;e.dispatchEvent(new Event('scroll'));_chatScroll.pointer=false;}")
            assert page.evaluate("()=>_autoScroll===true")
            # Simulate an upward wheel gesture: generation must stop following.
            page.evaluate("()=>{const e=chatBody;e.scrollTop=Math.max(0,e.scrollTop-220);e.dispatchEvent(new WheelEvent('wheel',{deltaY:-220,bubbles:true}));}")
            assert page.evaluate("()=>_autoScroll===false")
            # Continued downward reading away from the bottom reveals the button.
            page.evaluate("async()=>{const e=chatBody;e.scrollTop=0;e.dispatchEvent(new Event('scroll'));_chatScroll.inputAt=performance.now();_chatScroll.pointer=true;for(let i=0;i<4;i++){await new Promise(r=>setTimeout(r,100));e.scrollTop=Math.min(e.scrollHeight-e.clientHeight,e.scrollTop+160);e.dispatchEvent(new Event('scroll'));} _chatScroll.pointer=false;}")
            button = page.locator('#chatJumpBottom')
            assert not button.is_hidden(), {'scroll': page.evaluate("()=>({top:chatBody.scrollTop,height:chatBody.scrollHeight,client:chatBody.clientHeight,downSince:_chatScroll.downSince,downPixels:_chatScroll.downPixels,inputAt:_chatScroll.inputAt,now:performance.now(),pointer:_chatScroll.pointer,long:chatBody.scrollHeight>chatBody.clientHeight*1.5,hidden:chatJumpBottom.hidden})")}
            button.click()
            page.wait_for_function("()=>_autoScroll===true && chatAtBottom(chatBody)")
            assert button.is_hidden()
            # Expanding a tool card is a reading action and must pause follow mode.
            tool = page.locator('#chatBody .tool-summary').first
            tool.click()
            assert page.evaluate("()=>_autoScroll===false")
            page.evaluate("()=>{const e=chatBody;_chatScroll.inputAt=performance.now();_chatScroll.pointer=true;e.scrollTop=e.scrollHeight;e.dispatchEvent(new Event('scroll'));_chatScroll.pointer=false;}")
            assert page.evaluate("()=>_autoScroll===true")
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
            assert not errors, errors
            print(json.dumps({'viewport': [width, height], 'bottom_resumes_follow': True,
                              'upward_scroll_pauses': True, 'downward_reading_shows_button': True,
                              'click_returns_to_bottom': True, 'tool_reading_pauses': True,
                              'errors': errors}, ensure_ascii=False), flush=True)
            context.close()
        browser.close()
finally:
    stop_server()
