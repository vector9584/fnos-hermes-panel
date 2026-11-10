"""Verify that a failed conversation history load can be announced and retried."""
import json
import os
import signal
import subprocess
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright
from preview_process import preview_launcher, read_startup_line


ROOT = Path(__file__).resolve().parent
STATE = Path(tempfile.mkdtemp(prefix='hermes-chat-load-error-', dir='/tmp'))
STATE.chmod(0o777)
env = {**os.environ, 'HOME': str(STATE), 'PREVIEW_STATE_ROOT': str(STATE), 'PREVIEW_PORT': '0',
       'PYTHONDONTWRITEBYTECODE': '1', 'TEST_PYTHON': os.environ.get('HERMES_TEST_PYTHON',
       '/vol1/@apphome/hermes-agent/data/venv/bin/python3')}
node = os.environ.get('HERMES_PREVIEW_NODE', '/vol1/@apphome/hermes-agent/data/node/bin/node')
os.environ['PLAYWRIGHT_BROWSERS_PATH'] = os.environ.get(
    'HERMES_PLAYWRIGHT_BROWSERS_PATH',
    os.environ.get('PLAYWRIGHT_BROWSERS_PATH', '/vol1/@apphome/hermes-agent/data/.cache/ms-playwright'))
server = subprocess.Popen(preview_launcher() + ['env'] + [f'{key}={env[key]}' for key in
        ('HOME', 'PREVIEW_STATE_ROOT', 'PREVIEW_PORT', 'PYTHONDONTWRITEBYTECODE', 'TEST_PYTHON')] +
        [node, str(ROOT / 'preview-server.mjs')], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, start_new_session=True)

try:
    startup = read_startup_line(server)
    if not startup:
        raise RuntimeError('隔离预览服务未输出启动信息')
    url = f"http://127.0.0.1:{json.loads(startup)['port']}"
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(args=['--no-sandbox'])
        for width, height in ((1440, 900), (390, 844), (844, 390)):
            context = browser.new_context(viewport={'width': width, 'height': height})
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            failed = [True]

            def fixture_route(route):
                if route.request.url.endswith('/api/sessions'):
                    return route.fulfill(status=200, json={'sessions': [
                        {'id': 'test-a', 'title': '加载失败重试测试', 'created_at': 1, 'message_count': 1}
                    ]})
                if route.request.url.endswith('/api/config'):
                    return route.fulfill(status=200, json={
                        'ok': True, 'revision': 'chat-load-fixture',
                        'providers': [{'id': 'fixture', 'name': '隔离测试模型', 'enabled': True,
                                       'models': [{'id': 'fixture-model', 'name': '隔离测试模型', 'enabled': True}]}],
                        'primary': {'provider': 'fixture', 'model': 'fixture-model'}, 'fallbacks': [],
                        'active_provider': '隔离测试模型', 'fallback_providers': [], 'hermes_configured': True,
                        'extensions': {},
                    })
                return route.continue_(url=route.request.url.replace('/app/hermes-agent/', '/'))

            page.route('**/*', lambda route: fixture_route(route) if route.request.url.startswith(url) else route.abort())

            def history(route):
                if failed[0]:
                    return route.fulfill(status=503, json={'error': 'fixture unavailable'})
                return route.fulfill(status=200, json={'id': 'test-a', 'messages': [
                    {'role': 'user', 'content': '恢复后的会话正文'}]})

            page.route('**/api/sessions/test-a', history)
            page.goto(url, wait_until='domcontentloaded')
            page.wait_for_function("typeof monitorToken==='string' && monitorToken.length>0")
            alert = page.get_by_role('alert')
            alert.get_by_text('加载消息失败，请确认后端已连接后重试。', exact=True).wait_for()
            retry = page.get_by_role('button', name='重新加载消息', exact=True)
            assert retry.is_visible()
            failed[0] = False
            retry.click()
            page.get_by_text('恢复后的会话正文', exact=True).wait_for()
            assert page.locator('#chatBody [role=alert]').count() == 0
            assert not errors, errors
            print(json.dumps({'viewport': [width, height], 'error_announced': True,
                              'retry_recovered': True, 'page_errors': errors}, ensure_ascii=False), flush=True)
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
