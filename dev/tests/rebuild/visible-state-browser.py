"""Scan normal rendered page states for user-visible placeholder or ambiguous text."""
import json, os, shlex, signal, subprocess, tempfile, pwd
from pathlib import Path
from playwright.sync_api import sync_playwright
from preview_process import preview_launcher, read_startup_line

ROOT = Path(__file__).resolve().parent
state = Path(tempfile.mkdtemp(prefix='hermes-visible-state-preview-', dir='/tmp'))
state.chmod(0o777)
(state / 'native-home/cron').mkdir(parents=True)
(state / 'native-home/cron/jobs.json').write_text('{"jobs":[]}')
env = {**os.environ, 'HOME': str(state), 'PREVIEW_STATE_ROOT': str(state),
       'PREVIEW_PORT': '0', 'PYTHONDONTWRITEBYTECODE': '1'}
os.environ['PLAYWRIGHT_BROWSERS_PATH'] = os.environ.get('HERMES_PLAYWRIGHT_BROWSERS_PATH', os.environ.get('PLAYWRIGHT_BROWSERS_PATH', '/vol1/@apphome/hermes-agent/data/.cache/ms-playwright'))
node = os.environ.get('HERMES_PREVIEW_NODE', '/vol1/@apphome/hermes-agent/data/node/bin/node')
cmd = preview_launcher() + ['env'] + [
    f'{key}={env[key]}' for key in ('HOME', 'PREVIEW_STATE_ROOT', 'PREVIEW_PORT', 'PYTHONDONTWRITEBYTECODE')
] + [node, str(ROOT / 'preview-server.mjs')]
server = subprocess.Popen(cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          text=True, start_new_session=True)
pages = ['chat', 'experts', 'rooms', 'plans', 'echo', 'cron', 'kb', 'memory',
         'extensions', 'comm', 'models', 'overview', 'usage', 'updates', 'settings']
viewports = [(1440, 900), (390, 844), (844, 390)]
bad = ('undefined', 'TODO', '开发中', '敬请期待', '未实现', '[object Object]',
       'unknown', '未知模型', '未知专家类型', '未知错误')
results = []
unnamed_controls = []


def scan_controls(page, destination, viewport):
    unnamed = page.locator('#app').evaluate("""root => {
      const controls = [...root.querySelectorAll(
        'button, input:not([type="hidden"]), select, textarea, [role="button"], [role="checkbox"], [role="switch"]'
      )];
      const visible = element => {
        const style = getComputedStyle(element);
        return !!element.getClientRects().length && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const text = value => String(value || '').replace(/\\s+/g, ' ').trim();
      const name = element => {
        const labelledby = element.getAttribute('aria-labelledby');
        if (labelledby) {
          const value = text(labelledby.split(/\\s+/).map(id => document.getElementById(id)?.innerText || '').join(' '));
          if (value) return value;
        }
        const aria = text(element.getAttribute('aria-label'));
        if (aria) return aria;
        if (element.labels?.length) {
          const value = text([...element.labels].map(label => label.innerText).join(' '));
          if (value) return value;
        }
        if (element instanceof HTMLButtonElement || element.getAttribute('role') === 'button') {
          const value = text(element.innerText || element.textContent);
          if (value) return value;
          const svgTitle = text(element.querySelector('svg title')?.textContent);
          if (svgTitle) return svgTitle;
          const imageAlt = text(element.querySelector('img[alt]')?.alt);
          if (imageAlt) return imageAlt;
        }
        if (element instanceof HTMLInputElement && ['button', 'submit', 'reset', 'image'].includes(element.type)) {
          const value = text(element.value || element.alt);
          if (value) return value;
        }
        return text(element.getAttribute('title'));
      };
      return controls.filter(visible).filter(element => !name(element)).map(element => ({
        tag: element.tagName.toLowerCase(), type: element.getAttribute('type') || '',
        id: element.id || '', role: element.getAttribute('role') || '',
        html: element.outerHTML.slice(0, 240)
      }));
    }""")
    for item in unnamed:
        unnamed_controls.append({'page': destination, 'viewport': list(viewport), **item})


try:
    first = read_startup_line(server)
    port = int(json.loads(first)['port'])
    url = f'http://127.0.0.1:{port}'
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(args=['--no-sandbox'])
        for width, height in viewports:
            context = browser.new_context(viewport={'width': width, 'height': height})
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            context.route('**/*', lambda route: route.continue_(url=route.request.url.replace('/app/hermes-agent/', '/'))
                          if route.request.url.startswith(url) else route.abort())
            page.goto(url, wait_until='domcontentloaded')
            page.wait_for_function("monitorToken==='fixture-token'")
            for destination in pages:
                page.evaluate('(name) => switchPage(name)', destination)
                page.wait_for_function("name => { const root=document.getElementById('page-'+name); return !!root && root.classList.contains('active') && root.innerText.trim().length>0; }", arg=destination)
                text = page.locator('#page-' + destination).inner_text()
                hits = [term for term in bad if term.lower() in text.lower()]
                assert not hits, {'page': destination, 'viewport': [width, height], 'hits': hits}
                scan_controls(page, destination, (width, height))
                results.append({'page': destination, 'viewport': [width, height], 'hits': hits})
                if destination == 'kb':
                    page.get_by_role('button', name='技能轨迹', exact=True).click()
                    trajectory_text = page.locator('#page-kb').inner_text()
                    trajectory_hits = [term for term in bad if term.lower() in trajectory_text.lower()]
                    assert not trajectory_hits, {'page': 'kb/trajectory', 'viewport': [width, height], 'hits': trajectory_hits}
                    scan_controls(page, 'kb', (width, height))
                    results.append({'page': 'kb/trajectory', 'viewport': [width, height], 'hits': []})
                    page.get_by_role('button', name='资料库', exact=True).click()
                if destination == 'comm':
                    connector_text = page.locator('#page-connectors').inner_text()
                    connector_hits = [term for term in bad if term.lower() in connector_text.lower()]
                    assert not connector_hits, {'page': 'comm/connectors', 'viewport': [width, height], 'hits': connector_hits}
                    scan_controls(page, 'connectors', (width, height))
                    results.append({'page': 'comm/connectors', 'viewport': [width, height], 'hits': []})
            assert not errors, errors
            context.close()
        browser.close()
    assert not unnamed_controls, {'unnamed_control_count': len(unnamed_controls), 'unnamed_controls': unnamed_controls}
    print(json.dumps({'pages': len(results), 'viewports': len(viewports), 'banned_hits': 0,
                      'unnamed_control_count': len(unnamed_controls),
                      'unnamed_controls': unnamed_controls}, ensure_ascii=False))
finally:
    try:
        os.killpg(server.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        server.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(server.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        server.wait(timeout=5)
