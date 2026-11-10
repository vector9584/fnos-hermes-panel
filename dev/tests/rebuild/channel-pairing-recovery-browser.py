"""Actual pairing UI, mocked platform/API responses; no external requests."""
import json,os,tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[3]
os.environ['PLAYWRIGHT_BROWSERS_PATH']='/vol1/@apphome/hermes-agent/data/.cache/ms-playwright'
results=[]
with sync_playwright() as p:
 browser=p.chromium.launch(args=['--no-sandbox'])
 for width,height in [(1440,900),(390,844),(844,390)]:
  for scenario in ['expired','saved_warning','storage_unavailable']:
   context=browser.new_context(viewport={'width':width,'height':height});page=context.new_page();errors=[];calls=[]
   page.on('pageerror',lambda e:errors.append(str(e)))
   def respond(route):
    if route.request.method!='POST':route.fulfill(status=200,content_type='text/html',body='<html><body><button id="origin">关联</button></body></html>');return
    body=route.request.post_data_json;calls.append(body['action']);action=body['action'];status=200
    record={'id':'fixture-pairing','channel':'weixin','status':'ready','account':'fixture','expires_at':9999999999999}
    if scenario=='expired' and action in ['poll','cancel']:
     status=410;data={'ok':False,'error':'二维码已过期，请重新获取'}
    elif action=='apply':
     record['status']='applied'
     if scenario=='saved_warning':
      status=503;record['save_warning']='凭证已保存，但待应用状态未确认；请核对通讯配置及应用运行状态，不要重复关联。';data={'ok':False,'saved':True,'pairing':record}
     else:data={'ok':True,'pairing':record}
    else:data={'ok':True,'pairing':record}
    route.fulfill(status=status,content_type='application/json',body=json.dumps(data))
   context.route('**/*',respond);page.goto('http://fixture.invalid/');page.evaluate("window.apiUrl=p=>p;window.monitorToken='fixture';window.panelRuntimeRefresh=()=>{};window.drawQR=async()=>true;window.savedCount=0")
   if scenario=='expired':page.evaluate("localStorage.setItem('panel-channel-pairing:weixin','old-id')")
   if scenario=='storage_unavailable':page.evaluate("() => {Storage.prototype.removeItem=function(){throw new Error('storage denied')}}")
   page.add_script_tag(path=str(ROOT/'app/ui/js/panel-channel-pairing-ui.js'))
   page.evaluate("document.querySelector('#origin').focus();panelChannelPairing({channel:{id:'weixin',name:'微信',enabled:false},revision:'one',onSaved:()=>savedCount++})")
   dialog=page.get_by_role('dialog',name='关联 微信')
   if scenario=='expired':
    dialog.get_by_text('二维码已过期，请重新获取',exact=True).wait_for();dialog.get_by_role('button',name='获取新二维码',exact=True).click()
   dialog.get_by_text('授权已完成。请核对账号、启用状态后保存。',exact=True).wait_for()
   dialog.get_by_role('button',name='保存关联',exact=True).click()
   if scenario=='saved_warning':
    dialog.get_by_text('凭证已保存，但待应用状态未确认；请核对通讯配置及应用运行状态，不要重复关联。',exact=True).wait_for();assert not dialog.get_by_role('button',name='保存关联',exact=True).is_visible();assert not dialog.get_by_role('button',name='取消此次关联',exact=True).is_visible();assert page.evaluate('savedCount')==0;dialog.get_by_role('button',name='关闭',exact=True).click()
   else:
    dialog.wait_for(state='detached');assert page.evaluate('savedCount')==1
   assert calls.count('apply')==1
   if scenario=='expired':assert calls==['poll','cancel','start','apply'],calls
   assert not errors,errors
   results.append({'viewport':[width,height],'scenario':scenario,'calls':calls,'errors':errors});context.close()
 browser.close()
print(json.dumps(results,ensure_ascii=False),flush=True)
