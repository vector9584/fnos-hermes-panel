"""Scan every primary page for visible feedback when its API is unavailable."""
import json
import os
import signal
import subprocess
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright
from preview_process import preview_launcher, read_startup_line


ROOT = Path(__file__).resolve().parent
STATE = Path(tempfile.mkdtemp(prefix='hermes-error-state-preview-', dir='/tmp'))
STATE.chmod(0o777)
(STATE / 'native-home/cron').mkdir(parents=True)
(STATE / 'native-home/cron/jobs.json').write_text('{"jobs":[]}')
(STATE / 'native-home/config.yaml').write_text('auxiliary: {}\n')
ENV = {
    **os.environ,
    'HOME': str(STATE),
    'PREVIEW_STATE_ROOT': str(STATE),
    'PREVIEW_PORT': '0',
    'PYTHONDONTWRITEBYTECODE': '1',
    'TEST_PYTHON': os.environ.get('HERMES_TEST_PYTHON', '/vol1/@apphome/hermes-agent/data/venv/bin/python3'),
}
NODE = os.environ.get('HERMES_PREVIEW_NODE', '/vol1/@apphome/hermes-agent/data/node/bin/node')
os.environ['PLAYWRIGHT_BROWSERS_PATH'] = os.environ.get(
    'HERMES_PLAYWRIGHT_BROWSERS_PATH',
    os.environ.get('PLAYWRIGHT_BROWSERS_PATH', '/vol1/@apphome/hermes-agent/data/.cache/ms-playwright'),
)
COMMAND = preview_launcher() + ['env'] + [
    f'{key}={ENV[key]}' for key in ('HOME', 'PREVIEW_STATE_ROOT', 'PREVIEW_PORT', 'PYTHONDONTWRITEBYTECODE', 'TEST_PYTHON')
] + [NODE, str(ROOT / 'preview-server.mjs')]
PAGES = ['chat', 'experts', 'rooms', 'plans', 'echo', 'cron', 'kb', 'memory',
         'extensions', 'comm', 'models', 'overview', 'usage', 'updates', 'settings']
VIEWPORTS = [(1440, 900), (390, 844), (844, 390)]
SCENARIOS = (
    {'id': 'unavailable', 'status': 503, 'body': {'ok': False, 'error': '隔离模拟服务暂不可用（HTTP 503）'}},
    {'id': 'forbidden', 'status': 403, 'body': {'ok': False, 'error': '隔离模拟服务拒绝访问（HTTP 403）'}},
    {'id': 'offline', 'status': None, 'body': None},
)
FEEDBACK = ('失败', '无法', '不可用', '重试', '重新加载', '读取失败', '加载失败', '请求失败', '连接失败', '保存失败',
            '离线', '无权', '权限', 'HTTP 503', '503', 'HTTP 403', '403', 'failed to fetch', 'networkerror',
            'internetdisconnected', 'internet_disconnected')
SHOTS = Path(tempfile.mkdtemp(prefix='hermes-error-state-evidence-', dir='/tmp'))
SHOTS.chmod(0o777)
server = subprocess.Popen(COMMAND, env=ENV, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          text=True, start_new_session=True)
results = []
failures = []


def stop_server():
    try:
        os.killpg(server.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        server.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(server.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        server.wait(timeout=5)


try:
    first = read_startup_line(server)
    if not first:
        raise RuntimeError('隔离预览服务未输出启动信息')
    port = int(json.loads(first)['port'])
    url = f'http://127.0.0.1:{port}'
    print(json.dumps({'preview': json.loads(first), 'evidence_dir': str(SHOTS)}, ensure_ascii=False), flush=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(args=['--no-sandbox'])
        for width, height in VIEWPORTS:
          for scenario in SCENARIOS:
            context = browser.new_context(viewport={'width': width, 'height': height})
            errors = []
            page = context.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))
            blocked = []
            current_page = ['boot']
            inject_failure = [False]

            def route(request):
                target = request.request.url
                if not target.startswith(url):
                    return request.abort()
                target = target.replace('/app/hermes-agent/', '/')
                pathname = target.split('?', 1)[0]
                if inject_failure[0] and pathname.startswith(url + '/api/') and pathname not in {
                    url + '/api/panel-auth/bootstrap', url + '/api/health',
                }:
                    blocked.append({'page': current_page[0], 'scenario': scenario['id'],
                                    'path': pathname.removeprefix(url), 'method': request.request.method})
                    if scenario['status'] is None:
                        return request.abort('internetdisconnected')
                    return request.fulfill(status=scenario['status'], json=scenario['body'])
                return request.continue_(url=target)

            context.route('**/*', route)
            page.goto(url, wait_until='domcontentloaded')
            page.wait_for_function("typeof monitorToken==='string' && monitorToken.length>0")
            page.wait_for_timeout(750)
            for destination in PAGES:
                current_page[0] = destination
                errors.clear()
                inject_failure[0] = False
                page.evaluate('(name) => switchPage(name)', destination)
                page.wait_for_timeout(250)
                blocked[:] = [item for item in blocked if item['page'] != destination]
                page.evaluate("""(name) => {
                    const root = document.getElementById('page-' + name);
                    window.__panelFailureFeedback = [];
                    window.__globalFailureFeedback = [];
                    if (!root) return;
                    const record = node => {
                      const element = node && (node.nodeType === Node.TEXT_NODE ? node.parentElement : node);
                      if (!element || !element.getClientRects().length) return;
                      const style = getComputedStyle(element);
                      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) <= 0.01) return;
                      const text = element.innerText || '';
                      if (text.trim()) window.__panelFailureFeedback.push(text.trim());
                    };
                    const observer = new MutationObserver(records => records.forEach(change => {
                      const node = change.target.nodeType === Node.TEXT_NODE ? change.target.parentElement : change.target;
                      const inToast = node && (node.id === '__toast' || node.closest?.('#__toast'));
                      const inGlobalStatus = node && node.id === 'brandConnectionText';
                      if (node && (node === root || root.contains(node) || inToast || inGlobalStatus)) {
                        if (change.type === 'characterData') {
                          if (inGlobalStatus) window.__globalFailureFeedback.push(node.textContent || '');
                          else record(change.target);
                        }
                        if (change.type === 'childList' && inToast) record(node);
                        change.addedNodes && change.addedNodes.forEach(added => {
                          if (added.id === '__toast' || added.closest?.('#__toast') || root.contains(added)) record(added);
                        });
                      }
                    }));
                    observer.observe(root, {subtree:true, childList:true, characterData:true});
                    observer.observe(document.body, {subtree:true, childList:true, characterData:true});
                    window.__panelFailureObserver = observer;
                }""", destination)
                inject_failure[0] = True
                page.evaluate('(name) => switchPage(name)', destination)
                if destination == 'chat':
                    page.evaluate('() => currentSession && loadSessionMessages(currentSession)')
                elif destination == 'cron':
                    page.evaluate('renderCronJobs()')
                try:
                    page.wait_for_function("""() => {
                      const global = document.getElementById('brandConnectionText');
                      const feedback = [...(window.__panelFailureFeedback || []), ...(window.__globalFailureFeedback || [])].join(' ');
                      return /失败|无法|不可用|重试|拒绝|权限|离线|403|503|networkerror|internetdisconnected/i.test(feedback) ||
                        (global && /失败|离线|未连接|拒绝|权限|不可用|403|503/i.test(global.textContent));
                    }""", timeout=4000)
                except Exception:
                    pass
                page.wait_for_timeout(100)
                panel = page.locator('#page-' + destination)
                feedback_state = page.evaluate("""() => {
                  window.__panelFailureObserver?.disconnect();
                  const toast = document.getElementById('__toast');
                  const toastText = toast && getComputedStyle(toast).opacity !== '0' ? toast.textContent : '';
                  const globalStatus = document.getElementById('brandConnectionText');
                  const globalText = globalStatus && getComputedStyle(globalStatus).display !== 'none' ? globalStatus.textContent : '';
                  const localText = [...(window.__panelFailureFeedback || []), toastText || ''].join(' ');
                  return {localText, globalText: [...(window.__globalFailureFeedback || []), globalText || ''].join(' ')};
                }""")
                local_error = any(term.lower() in feedback_state['localText'].lower() for term in FEEDBACK)
                global_error = any(term.lower() in feedback_state['globalText'].lower() for term in FEEDBACK)
                visible_error = local_error or (scenario['id'] == 'offline' and global_error)
                semantic_feedback = panel.locator('[role=alert], [role=status], .error-text, .maintenance-feedback, .panel-error, .error-banner').evaluate_all("""nodes => nodes
                  .filter(node => {
                    const style = getComputedStyle(node);
                    return node.getClientRects().length && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0.01;
                  })
                  .map(node => node.innerText || node.textContent || '')
                  .filter(text => text.trim())
                  .join(' ')""") if panel.count() else ''
                semantic_error = any(term.lower() in semantic_feedback.lower() for term in FEEDBACK)
                request_failures = [item for item in blocked if item['page'] == destination and item['scenario'] == scenario['id']]
                row = {
                    'page': destination,
                    'scenario': scenario['id'],
                    'viewport': [width, height],
                    'failed_api_count': len(request_failures),
                    'failed_apis': request_failures,
                    'visible_feedback': visible_error or semantic_error,
                    'changed_feedback_text': (feedback_state['localText']+' '+feedback_state['globalText'])[:1200],
                    'local_feedback_text': feedback_state['localText'][:1200],
                    'global_feedback_text': feedback_state['globalText'][:1200],
                    'semantic_feedback_text': semantic_feedback[:1200],
                    'page_errors': list(errors),
                }
                if not request_failures:
                    row['coverage_error'] = '页面切换后没有观察到被模拟失败的 API 请求'
                    failures.append(row)
                if request_failures and not row['visible_feedback']:
                    failures.append(row)
                if errors:
                    failures.append(row)
                results.append(row)
                page.screenshot(path=str(SHOTS / f'{destination}-{scenario["id"]}-{width}x{height}.png'))
            context.close()
        browser.close()
    summary = {'pages': len(PAGES), 'viewports': len(VIEWPORTS), 'scenarios': len(SCENARIOS),
               'checks': len(results),
               'feedback_failures': failures, 'page_errors': sum(len(row['page_errors']) for row in results),
               'evidence_dir': str(SHOTS), 'state_dir': str(STATE)}
    (SHOTS / 'results.json').write_text(json.dumps({'summary': summary, 'results': results}, ensure_ascii=False, indent=2))
    print(json.dumps(summary, ensure_ascii=False), flush=True)
    if failures:
        raise SystemExit(1)
finally:
    stop_server()
