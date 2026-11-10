"""Model settings interaction against temporary YAML; network requests blocked."""
import json,os,shlex,signal,subprocess,tempfile,pwd,re,yaml,time
from pathlib import Path
from playwright.sync_api import sync_playwright
from preview_process import preview_launcher, read_startup_line
ROOT=Path(__file__).resolve().parent
state=Path(tempfile.mkdtemp(prefix='hermes-models-preview-',dir='/tmp'));state.chmod(0o777);(state/'native-home/cron').mkdir(parents=True);(state/'native-home/cron/jobs.json').write_text('{"jobs":[]}');(state/'native-home/config.yaml').write_text('auxiliary: {}\n')
env={**os.environ,'HOME':str(state),'PREVIEW_STATE_ROOT':str(state),'PREVIEW_PORT':'0','TEST_PYTHON':os.environ.get('HERMES_TEST_PYTHON','/vol1/@apphome/hermes-agent/data/venv/bin/python3'),'PYTHONDONTWRITEBYTECODE':'1'}
os.environ['PLAYWRIGHT_BROWSERS_PATH']=os.environ.get('HERMES_PLAYWRIGHT_BROWSERS_PATH',os.environ.get('PLAYWRIGHT_BROWSERS_PATH','/vol1/@apphome/hermes-agent/data/.cache/ms-playwright'))
node=os.environ.get('HERMES_PREVIEW_NODE','/vol1/@apphome/hermes-agent/data/node/bin/node')
cmd=preview_launcher()+['env']+[f'{key}={env[key]}' for key in ('HOME','PREVIEW_STATE_ROOT','PREVIEW_PORT','TEST_PYTHON','PYTHONDONTWRITEBYTECODE')]+[node,str(ROOT/'preview-server.mjs')]
server=subprocess.Popen(cmd,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
shots=Path(tempfile.mkdtemp(prefix='hermes-models-evidence-',dir='/tmp'));shots.chmod(0o777);results=[]
def native_write(path,text):
 path=Path(path);temp=path.with_name(path.name+'.fixture-'+str(os.getpid()))
 temp.write_text(text);os.chmod(temp,0o644);os.replace(temp,path)
def stop_server():
 try: os.killpg(server.pid,signal.SIGTERM)
 except ProcessLookupError: pass
 try: server.wait(timeout=5)
 except subprocess.TimeoutExpired:
  try: os.killpg(server.pid,signal.SIGKILL)
  except ProcessLookupError: pass
  try: server.wait(timeout=5)
  except subprocess.TimeoutExpired: pass
 else:
  try: os.killpg(server.pid,signal.SIGKILL)
  except ProcessLookupError: pass
try:
 first=read_startup_line(server)
 port=int(json.loads(first)['port']);url='http://127.0.0.1:'+str(port);print(first,flush=True)
 cfg=state/'models-config.yaml';initial_config=cfg.read_bytes()
 (state/'auth.json').write_text(json.dumps({'credential_pool':{'custom:隔离测试模型':[{'source':'manual:private-source','label':'private-label','access_token':'independent-private-key'}]}}))
 with sync_playwright() as p:
  browser=p.chromium.launch(args=['--no-sandbox'])
  for width,height in [(1440,900),(390,844),(844,390)]:
   native_write(state/'models-config.yaml',initial_config.decode())
   context=browser.new_context(viewport={'width':width,'height':height});page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)));context.route('**/*',lambda r:r.continue_(url=r.request.url.replace('/app/hermes-agent/','/')) if r.request.url.startswith(url) else r.abort())
   def open_models():
    page.evaluate("switchPage('models')");page.locator('#page-models .maintenance-feedback').filter(has_text='已读取 2 个模型服务').wait_for()
   page.goto(url,wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'");open_models();assert 'private-key' not in page.locator('#page-models').inner_text();card=page.locator('#providerGrid .provider-card').filter(has_text='隔离测试模型');assert 'fixture-model · 全局主模型' in card.inner_text();card.get_by_role('button',name='查看凭证来源',exact=True).click();sources=page.get_by_role('dialog',name='凭证来源 · 隔离测试模型');assert '手动凭证' in sources.inner_text();assert 'private' not in sources.inner_text();page.screenshot(path=str(shots/f'credential-sources-{width}.png'));assert sources.evaluate('(e)=>e.scrollWidth<=e.clientWidth+1');sources.get_by_role('button',name='关闭',exact=True).click()
   if width==1440:
    card.get_by_role('button',name='编辑服务').click();dialog=page.get_by_role('dialog',name='编辑模型服务');page.evaluate("()=>{localStorage.setItem('panel-model-draft:fixture','stale');window.__origStorageSet=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('panel-model-draft:'))throw new DOMException('quota','QuotaExceededError');return window.__origStorageSet.call(this,k,v)}}");dialog.get_by_role('textbox',name='备注',exact=True).fill('memory-only-model-draft');assert '浏览器无法保存草稿；当前修改仅在此窗口保留' in dialog.inner_text();page.once('dialog',lambda d:d.dismiss());dialog.get_by_role('button',name='关闭',exact=True).click();assert dialog.is_visible();page.once('dialog',lambda d:d.accept());dialog.get_by_role('button',name='关闭',exact=True).click();dialog.wait_for(state='detached');assert page.evaluate("localStorage.getItem('panel-model-draft:fixture')") is None;page.evaluate('()=>{Storage.prototype.setItem=window.__origStorageSet}');card.get_by_role('button',name='编辑服务').click();dialog=page.get_by_role('dialog',name='编辑模型服务');dialog.get_by_role('combobox',name='API密钥操作').select_option('replace');dialog.get_by_role('textbox',name='新的API密钥',exact=True).fill('unsaved-secret');page.once('dialog',lambda d:d.dismiss());dialog.get_by_role('button',name='关闭',exact=True).click();assert dialog.is_visible();page.once('dialog',lambda d:d.accept());dialog.get_by_role('button',name='关闭',exact=True).click();dialog.wait_for(state='detached');page.evaluate('()=>{Storage.prototype.setItem=window.__origStorageSet}');page.get_by_role('button',name='调整路线',exact=True).click();route=page.get_by_role('dialog',name='设置主模型与失败回退');page.evaluate("()=>{localStorage.setItem('panel-model-routes-draft','stale');window.__origStorageSet=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==='panel-model-routes-draft')throw new DOMException('quota','QuotaExceededError');return window.__origStorageSet.call(this,k,v)}}");route.get_by_role('combobox',name='主模型（失败时尝试下面的回退模型）').select_option(label='隔离测试模型 / second-model');assert '浏览器无法保存路线草稿；当前修改仅在此窗口保留' in route.inner_text();page.once('dialog',lambda d:d.dismiss());page.keyboard.press('Escape');assert route.is_visible();page.once('dialog',lambda d:d.accept());page.keyboard.press('Escape');route.wait_for(state='detached');assert page.evaluate("localStorage.getItem('panel-model-routes-draft')") is None;page.evaluate('()=>{Storage.prototype.setItem=window.__origStorageSet}')
   card=page.locator('#providerGrid .provider-card').filter(has_text='隔离测试模型');card.get_by_role('button',name='编辑服务').click();dialog=page.get_by_role('dialog',name='编辑模型服务');assert dialog.locator('.model-route-badge').inner_text()=='全局主模型';assert '独立池凭证' in dialog.inner_text();dialog.get_by_role('textbox',name='备注',exact=True).fill('draft-'+str(width));dialog.get_by_role('button',name='关闭',exact=True).click()
   page.reload(wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'");open_models();card.get_by_role('button',name='编辑服务').click();dialog=page.get_by_role('dialog',name='编辑模型服务');assert dialog.get_by_role('textbox',name='备注',exact=True).input_value()=='draft-'+str(width);assert dialog.locator('input[type=password]').first.input_value()=='';assert dialog.get_by_text('historical-model',exact=True).count()==1
   dialog.get_by_role('textbox',name='服务地址',exact=True).fill('http://192.168.1.20:11434/v1');assert 'API 密钥会以明文' in dialog.locator('.model-discovery .maintenance-feedback').inner_text();dialog.get_by_role('textbox',name='服务地址',exact=True).fill('https://fixture.invalid/v1');assert not dialog.locator('.model-discovery .maintenance-feedback').inner_text()
   dialog.get_by_role('textbox',name='服务地址',exact=True).fill('http://192.168.1.20:11434/v1');assert 'API 密钥会以明文' in dialog.locator('.model-discovery .maintenance-feedback').inner_text();dialog.get_by_role('button',name='获取模型',exact=True).click();dialog.get_by_text('获取到 2 个模型；未启用项已勾选，核对后加入清单',exact=True).wait_for();dialog.get_by_role('textbox',name='服务地址',exact=True).fill('https://fixture.invalid/v1');assert not dialog.locator('.model-discovery .maintenance-feedback').inner_text()
   dialog.get_by_role('button',name='获取模型',exact=True).click();dialog.get_by_text('获取到 2 个模型；未启用项已勾选，核对后加入清单',exact=True).wait_for()
   rows=dialog.locator('.model-discovery-item')
   dialog.locator('.model-discovery-item code').get_by_text('discovered-model',exact=True).wait_for(state='visible')
   dialog.locator('.model-discovery-item code').get_by_text('fixture-model',exact=True).wait_for(state='visible')
   observed=rows.evaluate_all("els=>els.map(el=>({id:el.querySelector('code')?.textContent?.trim(),checked:!!el.querySelector('input[type=checkbox]')?.checked}))")
   found=[row for row in observed if row['id']=='discovered-model'];existing=[row for row in observed if row['id']=='fixture-model']
   if len(found)!=1 or len(existing)!=1:raise AssertionError('模型发现结果数量异常；期望 discovered-model 与 fixture-model 各1条，实际清单：'+repr(observed))
   existing_row=dialog.locator('.model-edit-row').filter(has_text='discovered-model')
   known_enabled=existing_row.get_by_role('button',name='在列表中隐藏',exact=True).count()==1
   assert found[0]['checked']==(not known_enabled),{'discovered':observed,'existing_row':existing_row.inner_text()}
   assert not existing[0]['checked'],observed
   if not found[0]['checked']:
    rows.filter(has_text='discovered-model').get_by_role('checkbox').check()
   before_add=yaml.safe_load((state/'models-config.yaml').read_text())['providers']['fixture']['models']['discovered-model'];assert before_add['enabled'] is False and before_add['context_window']==23456,before_add
   dialog.get_by_role('button',name='加入已勾选模型',exact=True).click();assert dialog.locator('.maintenance-feedback').filter(has_text='已加入').count()==1;assert dialog.get_by_role('textbox',name='此服务默认模型ID（供未指定模型时使用）').input_value()=='fixture-model';row=dialog.locator('.model-edit-row').filter(has_text='discovered-model');assert row.get_by_role('button',name='在列表中隐藏',exact=True).count()==1;assert 'fixture-private-key' not in page.evaluate('JSON.stringify(Object.fromEntries(Object.entries(localStorage)))')
   cfg=state/'models-config.yaml';native_write(cfg,cfg.read_text().replace('name: 第二服务','name: 第二服务'+str(width)));dialog.get_by_role('button',name='保存配置',exact=True).click();dialog.get_by_text('模型配置已被其他页面修改，当前表单已保留，请重新核对',exact=True).wait_for();dialog.get_by_role('button',name='核对最新配置').click();dialog.get_by_role('button',name='保留输入，使用此版本').click();dialog.get_by_role('button',name='保存配置',exact=True).click();dialog.wait_for(state='detached');saved=yaml.safe_load(cfg.read_text());archived=saved['providers']['fixture']['models']['discovered-model'];assert archived['enabled'] is True and archived['context_window']==23456,archived;assert 'fixture-private-key' in cfg.read_text();assert 'keep: true' in cfg.read_text();assert '# fixture preserved' in cfg.read_text();bar=page.locator('.panel-runtime-bar');bar.wait_for();page.wait_for_function("getComputedStyle(document.querySelector('.panel-runtime-bar')).height!=='0px'");page_box=page.locator('#pageContainer').bounding_box();bar_box=bar.bounding_box();assert page_box['y']+page_box['height']<=bar_box['y']+1,{'page':page_box,'runtime_bar':bar_box,'viewport':[width,height]}
   page.get_by_role('button',name='调整路线',exact=True).click();route=page.get_by_role('dialog',name='设置主模型与失败回退');primary=route.get_by_role('combobox',name='主模型（失败时尝试下面的回退模型）');fallback=route.get_by_role('combobox',name='添加回退模型');assert '隔离测试模型 / fixture-model' not in fallback.locator('option').all_text_contents();assert fallback.input_value()=='';route.get_by_role('button',name='加入回退路线').click();assert '请先选择要加入的回退模型' in route.inner_text();assert route.locator('.model-route-editor li').count()==1;primary.select_option(label='隔离测试模型 / second-model');assert '隔离测试模型 / second-model' not in fallback.locator('option').all_text_contents();assert '隔离测试模型 / fixture-model' in fallback.locator('option').all_text_contents();assert fallback.input_value()=='';fallback.select_option(label='隔离测试模型 / fixture-model');route.get_by_role('button',name='加入回退路线').click();assert route.locator('.model-route-editor li').filter(has_text='隔离测试模型 / fixture-model').count()==1;route.get_by_role('button',name='关闭',exact=True).click();page.reload(wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'");open_models();page.get_by_role('button',name='调整路线',exact=True).click();route=page.get_by_role('dialog',name='设置主模型与失败回退');assert route.locator('.model-route-editor li').count()==2;route.get_by_role('button',name='保存主模型与回退顺序',exact=True).click();route.get_by_text('主模型与失败回退已一起保存，待重启应用生效',exact=True).wait_for();assert 'fallback-private-key' in cfg.read_text();assert 'default: second-model' in cfg.read_text();assert re.search(r'(?m)^\s*- provider: fixture\s*\n\s+model: fixture-model\s*$',cfg.read_text());route.get_by_role('button',name='关闭',exact=True).click()
   page.screenshot(path=str(shots/f'models-{width}.png'));card=page.locator('#providerGrid .provider-card').filter(has_text='隔离测试模型');default_model=card.locator('.provider-model');assert default_model.inner_text()=='服务默认模型：fixture-model（仅供该服务未指定模型时使用）';assert default_model.evaluate("e=>{const s=getComputedStyle(e);return s.whiteSpace!=='nowrap'&&s.textOverflow!=='ellipsis'&&e.scrollHeight<=e.clientHeight+1&&e.scrollWidth<=e.clientWidth+1}");card.get_by_role('button',name='编辑服务').click();dialog=page.get_by_role('dialog',name='编辑模型服务');route_rows=dialog.locator('.model-edit-row').evaluate_all("els=>els.map(el=>({model:el.querySelector('code')?.textContent?.trim(),badges:[...el.querySelectorAll('.model-route-badge')].map(b=>b.textContent.trim())}))");assert len([row for row in route_rows if row['model']=='second-model' and row['badges']==['全局主模型']])==1,route_rows;assert len([row for row in route_rows if row['model']=='fixture-model' and row['badges']==['失败回退第 2 项']])==1,route_rows;page.screenshot(path=str(shots/f'model-editor-{width}.png'));assert page.evaluate('document.documentElement.scrollWidth<=innerWidth');assert dialog.evaluate('(e)=>e.scrollWidth<=e.clientWidth+1');dialog.get_by_role('button',name='关闭',exact=True).click();page.get_by_role('button',name='撤销上次修改',exact=True).click();page.wait_for_function("document.querySelectorAll('.model-fallback-list li').length===1");# Existing legacy alias credentials must be visibly configured and clearable through the real editor.
   cfg=state/'models-config.yaml';native_write(cfg,cfg.read_text()+'\ncustom_providers:\n  - name: 旧格式别名服务\n    baseUrl: https://legacy.invalid/v1\n    api: https://ignored.invalid/v1\n    defaultModel: alias-model\n    apiMode: anthropic_messages\n    models: [{name: alias-model, context_length: 45678}]\n    apiKey: legacy-private-secret\n')
   page.reload(wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'");page.evaluate("switchPage('models')")
   legacy=page.locator('#providerGrid .provider-card').filter(has_text='旧格式别名服务');legacy.get_by_text('配置密钥 · 配置密钥',exact=True).wait_for();assert 'legacy-private-secret' not in legacy.inner_text()
   legacy.get_by_role('button',name='编辑服务').click();dialog=page.get_by_role('dialog',name='编辑模型服务')
   assert dialog.get_by_role('textbox',name='服务地址',exact=True).input_value()=='https://legacy.invalid/v1';assert dialog.get_by_role('combobox',name='接口协议',exact=True).input_value()=='anthropic_messages';dialog.get_by_role('combobox',name='接口协议',exact=True).select_option('');dialog.get_by_role('combobox',name='API密钥操作').select_option('clear');dialog.get_by_role('button',name='保存配置',exact=True).click();dialog.wait_for(state='detached');legacy.get_by_text('未设置配置密钥',exact=True).wait_for();assert 'legacy-private-secret' not in cfg.read_text();assert 'apiMode' not in cfg.read_text();assert '45678' in cfg.read_text();legacy.get_by_text('协议自动识别 · 1 个可选模型',exact=True).wait_for()
   # Remove only this isolated fixture entry before the next viewport.
   native_write(cfg,cfg.read_text().split('custom_providers:')[0])
   if width==844:
    page.reload(wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'");open_models()
    page.get_by_role('button',name=re.compile('添加模型服务')).click();create=page.get_by_role('dialog',name='添加模型服务')
    create.get_by_role('textbox',name='服务名称',exact=True).fill('新建服务多模型验证')
    create.get_by_role('textbox',name='服务地址',exact=True).fill('https://fixture.invalid/v1')
    create.get_by_role('combobox',name='API密钥操作').select_option('replace')
    create.get_by_role('textbox',name='新的API密钥',exact=True).fill('fixture-private-key')
    create.get_by_role('button',name='获取模型',exact=True).click();create.get_by_text('获取到 2 个模型；未启用项已勾选，核对后加入清单',exact=True).wait_for()
    create.get_by_role('button',name='加入已勾选模型',exact=True).click()
    create.locator('.model-edit-row').filter(has_text='fixture-model').get_by_role('button',name='设为服务默认').click()
    assert create.get_by_role('textbox',name='此服务默认模型ID（供未指定模型时使用）').input_value()=='fixture-model'
    create.get_by_role('button',name='保存配置',exact=True).click();create.wait_for(state='detached')
    created_cfg=cfg.read_text();assert 'name: 新建服务多模型验证' in created_cfg and 'default_model: fixture-model' in created_cfg
    page.evaluate("localStorage.removeItem('panel-model-routes-draft')")
    page.get_by_role('button',name='调整路线',exact=True).click();route=page.get_by_role('dialog',name='设置主模型与失败回退')
    primary=route.get_by_role('combobox',name='主模型（失败时尝试下面的回退模型）');fallback=route.get_by_role('combobox',name='添加回退模型')
    assert fallback.input_value()==''
    assert primary.input_value()=='["fixture","fixture-model"]'
    primary.select_option(label='新建服务多模型验证 / discovered-model')
    assert '新建服务多模型验证 / discovered-model' not in fallback.locator('option').all_text_contents()
    assert '新建服务多模型验证 / fixture-model' in fallback.locator('option').all_text_contents()
    fallback.select_option(label='新建服务多模型验证 / fixture-model');route.get_by_role('button',name='加入回退路线').click()
    route.get_by_role('button',name='保存主模型与回退顺序',exact=True).click()
    route_status=''
    for _ in range(100):
     route_status=route.locator('.maintenance-feedback').inner_text()
     if route_status!='路线草稿已保存到此浏览器':break
     time.sleep(.1)
    if '配置已被其他页面修改' in route_status:
     route.get_by_role('button',name='核对最新配置',exact=True).click()
     route.get_by_role('button',name='保留输入，使用此版本',exact=True).click()
     route.get_by_role('button',name='保存主模型与回退顺序',exact=True).click()
     for _ in range(100):
      route_status=route.locator('.maintenance-feedback').inner_text()
      if route_status!='路线草稿已保存到此浏览器':break
      time.sleep(.1)
    if route_status!='主模型与失败回退已一起保存，待重启应用生效':
     raise AssertionError('模型路线保存未成功：'+route_status+'；配置：'+(cfg.read_text() if cfg.exists() else '<missing>'))
    routed=cfg.read_text();assert 'default: discovered-model' in routed
    assert re.search(r'(?m)^\s*- provider: custom_[a-f0-9]{20}\s*\n\s+model: fixture-model\s*$',routed)
    route.get_by_role('button',name='关闭',exact=True).click();native_write(cfg,initial_config.decode())
   if width==390:
    before_empty=cfg.read_bytes();page.evaluate("()=>{Storage.prototype.setItem=window.__origStorageSet;localStorage.removeItem('panel-model-routes-draft')}");empty_config=yaml.safe_load(cfg.read_text());empty_config.pop('model',None);native_write(cfg,yaml.safe_dump(empty_config,allow_unicode=True,sort_keys=False));page.reload(wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'");open_models();page.get_by_role('button',name='调整路线',exact=True).click();route=page.get_by_role('dialog',name='设置主模型与失败回退');primary=route.get_by_role('combobox',name='主模型（失败时尝试下面的回退模型）');fallback=route.get_by_role('combobox',name='添加回退模型');assert primary.input_value()=='';assert fallback.input_value()=='';route.get_by_role('button',name='加入回退路线').click();assert '请先选择要加入的回退模型' in route.inner_text();assert route.locator('.model-route-editor li').count()==1;route.get_by_role('button',name='保存主模型与回退顺序',exact=True).click();assert '请选择主模型' in route.inner_text();assert 'model' not in yaml.safe_load(cfg.read_text());route.get_by_role('button',name='关闭',exact=True).click();native_write(cfg,before_empty.decode())
   assert not errors,errors;results.append({'viewport':[width,height],'credentials_hidden':True,'legacy_alias_config_key_clear':True,'legacy_endpoint_model_protocol_edit':True,'draft_reload':True,'conflict':True,'atomic_primary_and_fallback_same_provider':True,'empty_route_requires_explicit_model_selection':True if width==390 else None,'route_preservation':True,'undo':True,'overflow':False,'errors':errors});context.close()
  browser.close()
 (shots/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2));print(json.dumps({'results':results,'evidence_dir':str(shots),'state_dir':str(state)},ensure_ascii=False),flush=True)
finally:
 stop_server()
