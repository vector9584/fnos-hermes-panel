import json
import pwd
import shlex
import signal
import os
import sqlite3
import subprocess
import tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright
from preview_process import preview_launcher, read_startup_line

ROOT = Path(__file__).resolve().parent
STATE = Path(tempfile.mkdtemp(prefix='hermes-cron-history-preview-', dir='/tmp')); STATE.chmod(0o777)
HOME = STATE / 'native-home'
(HOME.mkdir(parents=True), HOME.chmod(0o777), (HOME / 'cron').mkdir(parents=True), (HOME / 'cron').chmod(0o777))
JOB = {'id': 'fixture-job', 'name': '备份检查', 'prompt': '', 'script': 'fixture.py',
       'no_agent': True, 'enabled': False, 'state': 'paused', 'paused_reason': '用户暂停',
       'schedule': {'kind': 'interval', 'minutes': 30, 'display': 'every 30m'},
       'repeat': {'times': 10, 'completed': 4}, 'deliver': 'discord:fixture-target',
       'last_status': 'ok', 'last_delivery_error': '渠道投递超时', 'last_run_at': '2026-11-01T00:00:00+08:00'}

def write_fixture(path, content):
    path = Path(path)
    temp = path.with_name(path.name + '.fixture-' + str(os.getpid()))
    temp.write_text(content)
    temp.chmod(0o644)
    os.replace(temp, path)

write_fixture(HOME/'cron/jobs.json', json.dumps({'jobs':[JOB]}))
OUTPUT = HOME / 'cron/output/fixture-job'
OUTPUT.mkdir(parents=True); OUTPUT.chmod(0o777)
for record_index in range(35):
    write_fixture(OUTPUT / ('2026-11-01_00-00-' + str(record_index).zfill(2) + '.md'),
                  '# 执行产物\n\n<script>window.historyInjected=true</script>\n归档后也能查看的完整结果。')
with sqlite3.connect(HOME / 'state.db') as connection:
    connection.executescript('''
        CREATE TABLE sessions (id TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, api_call_count INTEGER);
        INSERT INTO sessions VALUES ('legacy','last-model',1200,300,4);
        CREATE TABLE messages (session_id TEXT, timestamp REAL, active INTEGER);
        INSERT INTO messages VALUES ('legacy',1704124800,1);
    ''')
env = {**os.environ, 'PREVIEW_STATE_ROOT': str(STATE), 'PREVIEW_PORT': '0',
       'HOME': str(STATE), 'TEST_PYTHON': os.environ.get('HERMES_TEST_PYTHON', '/vol1/@apphome/hermes-agent/data/venv/bin/python3'),
       'HERMES_TEST_NATIVE_ROOT': '', 'PYTHONDONTWRITEBYTECODE': '1'}
os.environ['PLAYWRIGHT_BROWSERS_PATH'] = os.environ.get('HERMES_PLAYWRIGHT_BROWSERS_PATH', os.environ.get('PLAYWRIGHT_BROWSERS_PATH', '/vol1/@apphome/hermes-agent/data/.cache/ms-playwright'))
node=os.environ.get('HERMES_PREVIEW_NODE', '/vol1/@apphome/hermes-agent/data/node/bin/node')
cmd=preview_launcher()+['env']+[f'{k}={env[k]}' for k in ('PREVIEW_STATE_ROOT','PREVIEW_PORT','HOME','TEST_PYTHON','HERMES_TEST_NATIVE_ROOT','PYTHONDONTWRITEBYTECODE')]+[node,str(ROOT/'preview-server.mjs')]
server = subprocess.Popen(cmd,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
shots = Path(tempfile.mkdtemp(prefix='hermes-cron-history-evidence-',dir='/tmp')); shots.chmod(0o777)
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
 if not first: raise RuntimeError(server.stderr.read().strip() or '预览服务没有启动')
 port=int(json.loads(first)['port']);url='http://127.0.0.1:'+str(port);print(first,flush=True)
 with sync_playwright() as p:
  browser=p.chromium.launch(args=['--no-sandbox'])
  for width,height in [(1440,900),(390,844),(844,390)]:
   context=browser.new_context(viewport={'width':width,'height':height},accept_downloads=True);headers={'X-Monitor-Token':'fixture-token'}
   context.route('**/*',lambda r:r.continue_(url=r.request.url.replace('/app/hermes-agent/','/')) if r.request.url.startswith(url) else r.abort())
   page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   page.goto(url,wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'");page.evaluate("openCronHistory('fixture-job')")
   page.wait_for_function("document.querySelectorAll('.cron-history-record').length===30")
   summary=page.locator('.cron-history-summary').inner_text();assert '执行成功' in summary and '渠道投递失败：渠道投递超时' in summary
   page.locator('.cron-history-more').click();page.wait_for_function("document.querySelectorAll('.cron-history-record').length===35")
   last=page.locator('.cron-history-record').last;selected_id=last.get_attribute('data-record-id');last.click();page.locator('.cron-history-result').wait_for(state='visible')
   selected_name=page.locator('.cron-history-result h4').inner_text();content=page.locator('.cron-history-result pre').inner_text()
   page.locator('.cron-history .modal-close').click();page.reload(wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'");page.evaluate("openCronHistory('fixture-job')")
   page.locator('.cron-history-result').wait_for(state='visible');assert page.locator('.cron-history-result h4').inner_text()==selected_name
   assert page.locator('.cron-history-record').count()==30 # restored record is outside first page
   with page.expect_download() as download:page.locator('.cron-history-download').click()
   assert Path(download.value.path()).read_text()==content;assert page.evaluate('window.historyInjected') is None
   # Delayed old detail must not win against refresh and reread.
   held=[];target_url='**/api/cron-jobs/fixture-job/history/'+selected_id
   def delayed(route):
    if not held:held.append(route)
    else:route.fallback()
   page.route(target_url,delayed)
   page.locator('.cron-history-refresh').click();page.wait_for_function("document.querySelector('.cron-history-detail-status').textContent.includes('正在读取执行结果')")
   deadline=__import__('time').monotonic()+5
   while not held and __import__('time').monotonic()<deadline:page.wait_for_timeout(20)
   assert held
   write_fixture(OUTPUT/selected_name, '刷新后的执行结果 '+str(width))
   page.locator('.cron-history-refresh').click();page.wait_for_function("document.querySelector('.cron-history-result pre').textContent.startsWith('刷新后的执行结果') && !document.querySelector('.cron-history-result').hidden")
   held[0].fulfill(status=200,json={'ok':True,'name':selected_name,'content':'过期结果不得覆盖'})
   page.wait_for_timeout(80);assert page.locator('.cron-history-result pre').inner_text()=='刷新后的执行结果 '+str(width)
   page.unroute(target_url,delayed)
   # Removed outputs surface an error and hide stale content; restoring file can retry directly.
   (OUTPUT/selected_name).unlink();page.locator('.cron-history-refresh').click();page.locator('.cron-history-retry').wait_for(state='visible')
   assert '已不在磁盘' in page.locator('.cron-history-detail-status').inner_text();assert not page.locator('.cron-history-result').is_visible()
   (OUTPUT/selected_name).write_text(content);page.locator('.cron-history-retry').click();page.locator('.cron-history-result').wait_for(state='visible');assert page.locator('.cron-history-result pre').inner_text()==content
   assert page.evaluate('document.documentElement.scrollWidth<=innerWidth');page.screenshot(path=str(shots/f'history-restored-{width}.png'))
   page.keyboard.press('Escape');assert page.locator('.cron-history').count()==0
   assert not errors,errors;result={'viewport':[width,height],'execution_delivery_distinct':True,'restore_old_selection_after_reload':True,'raw_download':True,'late_detail_isolated_from_refresh':True,'missing_file_hides_old_content':True,'retry_recovers':True,'escape_closes':True,'errors':errors};results.append(result);print(json.dumps(result,ensure_ascii=False),flush=True);context.close()
  browser.close()
 (shots/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
 print(json.dumps({'results':results,'evidence_dir':str(shots),'state_dir':str(STATE)},ensure_ascii=False),flush=True)
finally:
 stop_server()
