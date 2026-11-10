"""Archive and restore a real panel session in an isolated preview service."""
import json, os, pwd, shlex, signal, subprocess, tempfile, time
from pathlib import Path
from playwright.sync_api import sync_playwright
from preview_process import preview_launcher, read_startup_line, stop_process_group

ROOT = Path(__file__).resolve().parent
state = Path(tempfile.mkdtemp(prefix='hermes-session-archive-', dir='/tmp'))
state.chmod(0o777)
(state / 'native-home/cron').mkdir(parents=True)
(state / 'native-home/cron/jobs.json').write_text('{"jobs":[]}')
(state / 'native-home/config.yaml').write_text('auxiliary: {}\n')
env = {**os.environ, 'HOME': str(state), 'PREVIEW_STATE_ROOT': str(state),
       'PREVIEW_PORT': '0', 'TEST_PYTHON': os.environ.get(
           'HERMES_TEST_PYTHON', '/vol1/@apphome/hermes-agent/data/venv/bin/python3'),
       'PYTHONDONTWRITEBYTECODE': '1'}
os.environ['PLAYWRIGHT_BROWSERS_PATH'] = os.environ.get(
    'HERMES_PLAYWRIGHT_BROWSERS_PATH',
    os.environ.get('PLAYWRIGHT_BROWSERS_PATH', '/vol1/@apphome/hermes-agent/data/.cache/ms-playwright'))
node = os.environ.get('HERMES_PREVIEW_NODE', '/vol1/@apphome/hermes-agent/data/node/bin/node')
cmd = preview_launcher() + ['env']
cmd += [f'{key}={env[key]}' for key in
        ('HOME', 'PREVIEW_STATE_ROOT', 'PREVIEW_PORT', 'TEST_PYTHON', 'PYTHONDONTWRITEBYTECODE')]
cmd += [node, str(ROOT / 'preview-server.mjs')]
server = subprocess.Popen(cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          text=True, start_new_session=True)

def stop_server():
    stop_process_group(server, timeout=8)

try:
    first = read_startup_line(server)
    if not first:
        detail = server.stderr.read().strip()
        raise RuntimeError('预览服务没有启动：' + (detail or '没有启动输出'))
    info = json.loads(first)
    port = int(info['port'])
    url = f'http://127.0.0.1:{port}'
    print(first, flush=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(args=['--no-sandbox'])
        for width, height in [(1440, 900), (390, 844), (844, 390)]:
            context = browser.new_context(viewport={'width': width, 'height': height})
            context.route('**/*', lambda route: route.continue_(
                url=route.request.url.replace('/app/hermes-agent/', '/'))
                if route.request.url.startswith(url) else route.abort())
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(url, wait_until='domcontentloaded')
            page.wait_for_function("monitorToken==='fixture-token'", timeout=60000)
            page.wait_for_function("Array.isArray(_sessions) && _sessions.length>0", timeout=60000)
            sid = page.evaluate("_sessions[0].id")
            request_id = 'archive-browser-' + str(width)
            headers = {'X-Monitor-Token': 'fixture-token'}
            response = context.request.post(url + '/api/chat/queue', headers=headers, data={
                'session_id': sid, 'request_id': request_id, 'message': '归档验收正文'})
            assert response.ok, response.text()
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                job = context.request.get(url + '/api/chat/queue/' + request_id,
                                          headers=headers).json()
                if job['status'] in ('done', 'failed', 'cancelled'):
                    break
                page.wait_for_timeout(100)
            assert job['status'] == 'done', job
            page.evaluate('sid => loadSessionMessages(sid)', sid)
            page.wait_for_function("document.querySelector('#chatBody').innerText.includes('归档验收正文')",
                                   timeout=60000)
            page.once('dialog', lambda dialog: dialog.accept())
            page.evaluate('sid => delSession(sid)', sid)
            page.wait_for_function('sid => !_sessions.some(s => s.id===sid)', arg=sid, timeout=30000)
            archived = context.request.get(url + '/api/sessions/archived', headers=headers).json()['sessions']
            row = next(item for item in archived if item['id'] == sid)
            assert row['message_count'] >= 2, row
            page.evaluate('pwArchivedSessions()')
            overlay = page.locator('#pwOverlay')
            overlay.wait_for(state='visible')
            overlay.locator('[data-restore]').wait_for(state='visible')
            overlay.get_by_role('button', name='恢复', exact=True).click()
            overlay.wait_for(state='detached')
            page.wait_for_function('sid => _sessions.some(s => s.id===sid)', arg=sid, timeout=30000)
            restored = context.request.get(url + '/api/sessions/' + sid, headers=headers).json()
            assert restored['messages'][-2]['content'] == '归档验收正文'
            assert not errors, errors
            print(json.dumps({'viewport': [width, height], 'archive_list': True,
                              'restore_same_id': True, 'body_preserved': True,
                              'errors': errors}, ensure_ascii=False), flush=True)
            context.close()
        browser.close()
finally:
    stop_server()
