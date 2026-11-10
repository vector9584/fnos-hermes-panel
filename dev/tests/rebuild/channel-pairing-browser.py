"""Real pairing state/config/UI; upstream authorization is a local fixture.
No messages sent and no real platform authentication performed."""
import json,os,signal,subprocess,tempfile,sys,pwd,shlex
from pathlib import Path
from playwright.sync_api import sync_playwright
from preview_process import preview_launcher, read_startup_line
ROOT=Path(__file__).resolve().parents[3];state=Path(tempfile.mkdtemp(prefix='hermes-pairing-preview-',dir='/tmp'));state.chmod(0o777);(state/'native-home/cron').mkdir(parents=True);(state/'native-home/cron/jobs.json').write_text('{"jobs":[]}');(state/'native-home/config.yaml').write_text('auxiliary: {}\n')
runtime={**os.environ,'HOME':str(state),'PREVIEW_STATE_ROOT':str(state),'PREVIEW_PORT':'0','TEST_PYTHON':os.environ.get('HERMES_TEST_PYTHON','/vol1/@apphome/hermes-agent/data/venv/bin/python3'),'PYTHONDONTWRITEBYTECODE':'1'}
os.environ['PLAYWRIGHT_BROWSERS_PATH']=os.environ.get('HERMES_PLAYWRIGHT_BROWSERS_PATH',os.environ.get('PLAYWRIGHT_BROWSERS_PATH','/vol1/@apphome/hermes-agent/data/.cache/ms-playwright'))
node=os.environ.get('HERMES_PREVIEW_NODE','/vol1/@apphome/hermes-agent/data/node/bin/node');cmd=preview_launcher()+['env']+[f'{key}={runtime[key]}' for key in ('HOME','PREVIEW_STATE_ROOT','PREVIEW_PORT','TEST_PYTHON','PYTHONDONTWRITEBYTECODE')]+[node,str(ROOT/'dev/tests/rebuild/preview-server.mjs')]
server=subprocess.Popen(cmd,env=runtime,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
shots=Path(tempfile.mkdtemp(prefix='hermes-channel-pairing-evidence-',dir='/tmp'));shots.chmod(0o777);results=[]
def native_write(path,text):
 path.parent.mkdir(parents=True,exist_ok=True);path.parent.chmod(0o777);temp=path.with_name(path.name+'.fixture-'+str(os.getpid()));temp.write_text(text);temp.chmod(0o644);os.replace(temp,path)
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
  for width,height,channel,label,secret_key in [(w,h,c,n,k) for w,h in [(1440,900),(390,844),(844,390)] for c,n,k in [('weixin','微信','WEIXIN_TOKEN'),('qqbot','QQ 机器人','QQ_CLIENT_SECRET'),('telegram','Telegram','TELEGRAM_BOT_TOKEN'),('wecom','企业微信','WECOM_SECRET')]]:
   cfg=state/'channel-home/config.yaml';env=state/'channel-home/.env';native_write(cfg,'platforms: {'+channel+': {enabled: false, extra: {dm_policy: allowlist, group_policy: disabled}}}\n');native_write(env,'OTHER=keep\n')
   context=browser.new_context(viewport={'width':width,'height':height});page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)));context.route('**/*',lambda r:r.continue_(url=r.request.url.replace('/app/hermes-agent/','/')) if r.request.url.startswith(url) else r.abort())
   def open_editor():
    page.goto(url,wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'");page.evaluate("switchPage('comm');window.renderChannels()");grid=page.locator('#channelGrid');page.wait_for_function("document.querySelector('#channelGrid')?.dataset.renderer==='panel-channels-ui' && document.querySelector('#channelGrid')?.dataset.loadState==='ready'")
    try:page.locator('.channel-card[data-channel-id="'+channel+'"] h2').wait_for(state='attached',timeout=30000)
    except Exception as error:raise AssertionError({'channel':channel,'viewport':[width,height],'api':page.request.get(url+'/api/panel-channels',headers={'X-Monitor-Token':'fixture-token'}).text(),'feedback':grid.locator('xpath=preceding-sibling::*[1]').all_text_contents(),'grid':grid.inner_text()}) from error
    card=page.locator('.channel-card[data-channel-id="'+channel+'"]');card.get_by_role('button',name='编辑配置',exact=True).click();editor=page.get_by_role('dialog',name='配置 '+label);assert editor.get_by_role('checkbox',name='处理消息时显示输入状态',exact=True).count()==0,(channel,width,'typing duplicated in channel editor');editor.get_by_role('button',name='扫码关联',exact=True).click()
   open_editor();dialog=page.get_by_role('dialog',name='关联 '+label);dialog.get_by_text('授权已完成。请核对账号、启用状态后保存。',exact=True).wait_for();assert not dialog.get_by_role('button',name='重新读取状态',exact=True).is_visible();assert not dialog.get_by_role('button',name='获取新二维码',exact=True).is_visible();assert dialog.get_by_role('textbox',name='允许的 Telegram 用户 ID').is_visible()==(channel=='telegram');assert 'fixture-qr-private-token' not in dialog.inner_text();assert secret_key not in env.read_text();dialog.get_by_role('button',name='关闭',exact=True).click();page.get_by_role('dialog',name='配置 '+label).get_by_role('button',name='关闭',exact=True).click();open_editor();dialog=page.get_by_role('dialog',name='关联 '+label);dialog.get_by_text('授权已完成。请核对账号、启用状态后保存。',exact=True).wait_for();native_write(cfg,cfg.read_text()+'external: keep\n');dialog.get_by_role('button',name='保存关联',exact=True).click();dialog.get_by_role('button',name='核对最新配置',exact=True).wait_for();assert secret_key not in env.read_text();dialog.get_by_role('button',name='核对最新配置',exact=True).click();dialog.get_by_role('button',name='已核对，按此版本关联',exact=True).click();page.screenshot(path=str(shots/f'pairing-{channel}-{width}.png'));assert dialog.evaluate('(e)=>e.scrollWidth<=e.clientWidth+1');dialog.get_by_role('button',name='保存关联',exact=True).click();dialog.wait_for(state='detached');env_text=env.read_text();cfg_text=cfg.read_text();assert 'fixture-qr-private-token' in env_text;assert 'OTHER=keep' in env_text;assert 'allowlist' in cfg_text;assert 'disabled' in cfg_text;assert 'enabled: false' in cfg_text;assert 'external: keep' in cfg_text;assert 'fixture-qr-private-token' not in page.evaluate('JSON.stringify(localStorage)');draft=page.evaluate("JSON.parse(localStorage.getItem('panel-channel-draft:'+"+json.dumps(channel)+"))");assert 'typing_indicator' not in draft['values'];assert not errors,errors;results.append({'channel':channel,'viewport':[width,height],'reopen_ready':True,'poll_no_config_write':True,'conflict_review':True,'credentials_server_only':True,'access_policy_preserved':True,'typing_single_source':True,'errors':errors});context.close()
  browser.close()
 (shots/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2));print(json.dumps({'results':results,'evidence_dir':str(shots),'state_dir':str(state)},ensure_ascii=False),flush=True)
finally:
 stop_server()
