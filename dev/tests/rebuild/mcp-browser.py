import json,os,signal,subprocess,tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright
from preview_process import preview_launcher, read_startup_line
ROOT=Path(__file__).resolve().parent
state=Path(tempfile.mkdtemp(prefix='hermes-mcp-preview-',dir='/tmp'));state.chmod(0o777);(state/'native-home/cron').mkdir(parents=True);(state/'native-home/cron/jobs.json').write_text('{"jobs":[]}')
env={**os.environ,'HOME':str(state),'PREVIEW_STATE_ROOT':str(state),'PREVIEW_PORT':'0','TEST_PYTHON':'/vol1/@apphome/hermes-agent/data/venv/bin/python3','PYTHONDONTWRITEBYTECODE':'1'}
os.environ['PLAYWRIGHT_BROWSERS_PATH']='/vol1/@apphome/hermes-agent/data/.cache/ms-playwright'
node='/vol1/@apphome/hermes-agent/data/node/bin/node';cmd=preview_launcher()+['env']+[f'{k}={env[k]}' for k in ('HOME','PREVIEW_STATE_ROOT','PREVIEW_PORT','TEST_PYTHON','PYTHONDONTWRITEBYTECODE')]+[node,str(ROOT/'preview-server.mjs')]
server=subprocess.Popen(cmd,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
shots=state/'evidence';shots.mkdir(exist_ok=True);results=[]
try:
 first=read_startup_line(server)
 if not first: raise RuntimeError('预览服务没有启动：'+(server.stderr.read().strip() or '没有启动输出'))
 url='http://127.0.0.1:'+str(json.loads(first)['port']);print(first,flush=True)
 with sync_playwright() as p:
  browser=p.chromium.launch(args=['--no-sandbox'])
  for width,height in [(1440,900),(390,844),(844,390)]:
   context=browser.new_context(viewport={'width':width,'height':height});page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)));context.route('**/*',lambda route:route.continue_(url=route.request.url.replace('/app/hermes-agent/','/')) if route.request.url.startswith(url) else route.abort())
   def open_mcp():
    page.evaluate("switchPage('extensions');extSwitchTab([...document.querySelectorAll('#extTabs .ch-filter')].find(e=>e.textContent.trim()==='MCP'),'mcp')")
    page.locator('#ext-mcp .maintenance-feedback').filter(has_text='已读取').wait_for()
   page.goto(url,wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'");open_mcp();assert 'fixture-secret' not in page.locator('#ext-mcp').inner_text();card=page.locator('#ext-mcp .mcp-card').filter(has=page.get_by_role('heading',name='manual',exact=True));card.get_by_role('button',name='编辑',exact=True).click();dialog=page.get_by_role('dialog',name='编辑工具服务');dialog.get_by_role('spinbutton',name='调用超时',exact=False).fill(str(40+width));assert dialog.locator('input[type=password]').input_value()=='';dialog.get_by_role('button',name='关闭',exact=True).click()
   page.reload(wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'");open_mcp();card=page.locator('#ext-mcp .mcp-card').filter(has=page.get_by_role('heading',name='manual',exact=True));card.get_by_role('button',name='编辑',exact=True).click();dialog=page.get_by_role('dialog',name='编辑工具服务');assert dialog.get_by_role('spinbutton',name='调用超时',exact=False).input_value()==str(40+width)
   # Concurrent configuration update in isolated fixture.
   cfg=state/'mcp-config.yaml';cfg.write_text(__import__('re').sub(r'url: https://fixture.invalid/[^\n]+','url: https://fixture.invalid/changed-'+str(width),cfg.read_text()))
   dialog.get_by_role('button',name='保存配置',exact=True).click();dialog.get_by_text('服务已被其他页面修改，请保留表单并重新读取',exact=True).wait_for();dialog.get_by_role('button',name='重新核对版本').click();dialog.get_by_role('button',name='保留当前输入，按此版本保存').click();dialog.get_by_role('button',name='保存配置',exact=True).click();dialog.wait_for(state='detached');page.locator('.panel-runtime-bar').wait_for();assert 'fixture-secret' in cfg.read_text();assert 'preserve: true' in cfg.read_text()
   card.get_by_role('button',name='停用',exact=True).click();card.get_by_role('button',name='启用',exact=True).wait_for();card.get_by_role('button',name='撤销上次修改',exact=True).click();card.get_by_role('button',name='停用',exact=True).wait_for()
   page.screenshot(path=str(shots/f'mcp-{width}.png'));page.evaluate("switchPage('comm')");page.locator('.panel-typing p[role=status]').filter(has_text='已读取').wait_for();typing=page.get_by_role('combobox',name='Telegram输入状态');old=typing.input_value();typing.select_option('off' if old=='on' else 'on');page.locator('.panel-typing p[role=status]').filter(has_text='已保存').wait_for();page.reload(wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'");page.evaluate("switchPage('comm')");page.locator('.panel-typing p[role=status]').filter(has_text='已读取').wait_for();assert page.get_by_role('combobox',name='Telegram输入状态').input_value()!=old;page.screenshot(path=str(shots/f'typing-{width}.png'));assert not errors,errors;assert page.evaluate('document.documentElement.scrollWidth<=innerWidth');results.append({'viewport':[width,height],'redaction':True,'draft_reload':True,'conflict':True,'preserve_nested':True,'disable_restore':True,'pending_restart':True,'errors':errors});context.close()
  browser.close()
 (shots/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2));print(json.dumps(results,ensure_ascii=False),flush=True)
finally:
 if server.poll() is None:
  try: os.killpg(server.pid,signal.SIGTERM);server.wait(timeout=8)
  except (ProcessLookupError,subprocess.TimeoutExpired):
   try: os.killpg(server.pid,signal.SIGKILL)
   except ProcessLookupError: pass
   server.wait(timeout=8)
