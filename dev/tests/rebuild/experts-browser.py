"""Expert catalog, real template writes and session snapshots in isolated preview."""
import os,json,signal,subprocess,tempfile,shlex,pwd,base64
from pathlib import Path
from playwright.sync_api import sync_playwright
from preview_process import preview_launcher, read_startup_line
ROOT=Path(__file__).resolve().parent
state=Path(tempfile.mkdtemp(prefix='hermes-experts-preview-',dir='/tmp'));state.chmod(0o777)
(state/'native-home/cron').mkdir(parents=True);(state/'native-home/cron/jobs.json').write_text('{"jobs":[]}');(state/'native-home/config.yaml').write_text('auxiliary: {}\n')
env={**os.environ,'HOME':str(state),'PREVIEW_STATE_ROOT':str(state),'PREVIEW_PORT':'0','TEST_PYTHON':os.environ.get('HERMES_TEST_PYTHON','/vol1/@apphome/hermes-agent/data/venv/bin/python3'),'PYTHONDONTWRITEBYTECODE':'1'}
os.environ['PLAYWRIGHT_BROWSERS_PATH']=os.environ.get('HERMES_PLAYWRIGHT_BROWSERS_PATH',os.environ.get('PLAYWRIGHT_BROWSERS_PATH','/vol1/@apphome/hermes-agent/data/.cache/ms-playwright'))
node=os.environ.get('HERMES_PREVIEW_NODE','/vol1/@apphome/hermes-agent/data/node/bin/node');cmd=preview_launcher()+['env']+[f'{key}={env[key]}' for key in ('HOME','PREVIEW_STATE_ROOT','PREVIEW_PORT','TEST_PYTHON','PYTHONDONTWRITEBYTECODE')]+[node,str(ROOT/'preview-server.mjs')]
server=subprocess.Popen(cmd,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
shots=Path(tempfile.mkdtemp(prefix='hermes-experts-evidence-',dir='/tmp'));shots.chmod(0o777);results=[]
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
 with sync_playwright() as p:
  browser=p.chromium.launch(args=['--no-sandbox'])
  for width,height in [(1440,900),(390,844),(844,390)]:
   context=browser.new_context(viewport={'width':width,'height':height});headers={'X-Monitor-Token':'fixture-token'}
   context.route('**/*',lambda r:r.continue_(url=r.request.url.replace('/app/hermes-agent/','/')) if r.request.url.startswith(url) else r.abort())
   page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   page.goto(url,wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'");page.evaluate("switchPage('experts')")
   original_identity=context.request.get(url+'/api/workspace-ui',headers={'X-Monitor-Token':'fixture-token'}).json()['identity']
   page.evaluate('pwIdentity()');identity_dialog=page.get_by_role('dialog',name='名称与头像');identity_dialog.wait_for()
   gif=base64.b64decode('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7')
   identity_dialog.locator('#pwUserAvatarFile').set_input_files({'name':'identity.gif','mimeType':'image/gif','buffer':gif})
   page.wait_for_function("document.querySelector('#pwUserAvatar').value.endsWith('.gif')")
   identity_dialog.locator('[name=pwAvatarShape][value=circle]').check()
   assert 'circle' in identity_dialog.locator('#pwUserAvatarPreview').get_attribute('class')
   identity_dialog.get_by_role('button',name='保存',exact=True).click();identity_dialog.wait_for(state='detached')
   saved_identity=context.request.get(url+'/api/workspace-ui',headers={'X-Monitor-Token':'fixture-token'}).json()['identity']
   assert saved_identity['avatar_shape']=='circle' and saved_identity['user_avatar'].endswith('.gif'),saved_identity
   rendered=page.evaluate("""()=>{const host=document.createElement('div');host.innerHTML=msgHTML({role:'user',content:'fixture',ts:1});document.body.append(host);const avatar=host.querySelector('.pw-avatar'),result={shape:avatar?.classList.contains('circle'),image:avatar?.querySelector('img')?.getAttribute('src'),radius:avatar?getComputedStyle(avatar).borderRadius:null};host.remove();return result;}""")
   assert rendered['shape'] and rendered['radius']=='50%' and rendered['image'].endswith('.gif'),rendered
   context.request.put(url+'/api/workspace-ui/preferences',headers={'X-Monitor-Token':'fixture-token'},data={'identity':original_identity})
   page.reload(wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'");page.evaluate("switchPage('experts')")
   page.wait_for_function("document.querySelector('#page-experts .maintenance-feedback')?.textContent.includes('已显示 36 位')",timeout=60000)
   contrast=page.locator('.expert-library-actions .primary').first.evaluate(r"""e=>{
    const rgb=v=>v.match(/[\d.]+/g).map(Number),over=(a,b)=>[0,1,2].map(i=>a[i]*(a[3]??1)+b[i]*(1-(a[3]??1))),lum=v=>v.map(n=>{n/=255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4}).reduce((a,n,i)=>a+n*[.2126,.7152,.0722][i],0);
    let ancestors=[],p=e;while(p){ancestors.unshift(p);p=p.parentElement;}let bg=[255,255,255];for(const n of ancestors)bg=over(rgb(getComputedStyle(n).backgroundColor),bg);const fg=over(rgb(getComputedStyle(e).color),bg),a=lum(fg),b=lum(bg);return {ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05),foreground:fg,background:bg};
   }""");assert contrast['ratio']>=4.5,contrast

   assert page.locator('#mbtiTestBtn').count()==0 and page.locator('#ext-experts').count()==0
   page.get_by_role('button',name='加载更多专家',exact=True).click();page.wait_for_function("document.querySelectorAll('.expert-library-card').length===72")
   query=page.get_by_role('searchbox',name='搜索专家');query.fill('coder');page.wait_for_function("document.querySelectorAll('.expert-library-card').length===1")
   favorite=page.locator('.expert-library-card .expert-favorite');initial=favorite.get_attribute('aria-pressed');favorite.focus();page.keyboard.press('Enter')
   page.wait_for_function("initial=>document.querySelector('.expert-favorite')?.getAttribute('aria-pressed')!==initial",arg=initial)
   favorited=context.request.get(url+'/api/workspace-ui',headers=headers).json()['favorites'];assert ('coder' in favorited)==(initial!='true')
   favorite.click();page.wait_for_function("initial=>document.querySelector('.expert-favorite')?.getAttribute('aria-pressed')===initial",arg=initial)
   if width<=768:
    box=favorite.bounding_box();assert box['width']>=44 and box['height']>=44
   assert page.locator('#page-experts .page-header').get_by_role('button',name='组建专家讨论').count()==1
   page.locator('.expert-library-card').get_by_role('button',name='查看设定').click();modal=page.locator('.expert-editor');modal.wait_for()
   original=modal.locator('[name=prompt]').input_value();modal.locator('[name=prompt]').fill('本地草稿 '+str(width));modal.get_by_role('button',name='关闭',exact=True).click()
   page.reload(wait_until='domcontentloaded');page.wait_for_function("monitorToken==='fixture-token'");page.evaluate("switchPage('experts')")
   page.locator('.expert-library-card').get_by_role('button',name='查看设定').click();assert modal.locator('[name=prompt]').input_value()=='本地草稿 '+str(width)
   # Conflict retains the draft. Explicit reset then edit safely.
   current=context.request.get(url+'/api/workspace-ui/experts/coder',headers=headers).json()['expert']
   context.request.put(url+'/api/workspace-ui/experts/coder',headers=headers,data={'revision':current['revision'],'prompt':'外部修改 '+str(width)})
   modal.get_by_role('button',name='保存设定',exact=True).click();page.wait_for_function("document.querySelector('.expert-editor-feedback').textContent.includes('已被修改')")
   assert modal.locator('[name=prompt]').input_value()=='本地草稿 '+str(width)
   page.once('dialog',lambda d:d.accept());modal.get_by_role('button',name='丢弃草稿并读取最新',exact=True).click()
   page.wait_for_function("document.querySelector('[name=prompt]')?.value.startsWith('外部修改')")
   modal.locator('[name=prompt]').fill('已验证职责 '+str(width));modal.locator('[name=quick_prompts]').fill('检查这个实现\n解释一段代码')
   modal.get_by_role('button',name='保存设定',exact=True).click();modal.wait_for(state='detached')
   saved=context.request.get(url+'/api/workspace-ui/experts/coder',headers=headers).json()['expert'];assert saved['prompt']=='已验证职责 '+str(width)
   # Bind a session snapshot, then undo the template; existing session stays frozen.
   context.request.put(url+'/api/workspace-ui/session',headers=headers,data={'id':'test-a','expert_id':'coder'})
   page.locator('.expert-library-card').get_by_role('button',name='查看设定').click();page.once('dialog',lambda d:d.accept());modal.get_by_role('button',name='撤销上次修改',exact=True).click()
   page.wait_for_function("document.querySelector('[name=prompt]')?.value.startsWith('外部修改')")
   workspace=context.request.get(url+'/api/workspace-ui',headers=headers).json();assert workspace['sessions']['test-a']['expert']['prompt']=='已验证职责 '+str(width)
   # Upload avatar to draft; form remains usable in portrait and landscape.
   modal.get_by_label('上传专家头像').set_input_files({'name':'expert.gif','mimeType':'image/gif','buffer':gif})
   page.wait_for_function("document.querySelector('.expert-editor-feedback').textContent.includes('头像已加入草稿')")
   expert_avatar=modal.locator('[name=emoji]').input_value();assert expert_avatar.endswith('.gif')
   assert modal.locator('.expert-avatar-field img').get_attribute('src').endswith('.gif')
   assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
   box=modal.get_by_role('button',name='保存设定',exact=True).bounding_box();assert box['y']>=0 and box['y']+box['height']<=height
   page.screenshot(path=str(shots/f'expert-editor-{width}.png'))
   modal.get_by_role('button',name='关闭',exact=True).click()
   query.fill('');page.wait_for_function("document.querySelectorAll('.expert-library-card').length===36")
   page.locator('.expert-library-filters').scroll_into_view_if_needed();page.screenshot(path=str(shots/f'experts-{width}.png'))
   # Mention picker shares the edited catalog, and preserves conversation-scoped role.
   page.evaluate("switchPage('chat');openTab('test-a')")
   page.locator('#chatInput').fill('@coder');page.wait_for_selector('.expert-mention-option');page.locator('.expert-mention-option').first.click()
   page.wait_for_function("!document.getElementById('chatInput').value.includes('@coder')")
   selected=context.request.get(url+'/api/workspace-ui',headers=headers).json()['sessions']['test-a']['expert'];assert selected['prompt']=='外部修改 '+str(width)
   assert not errors,errors
   results.append({'viewport':[width,height],'identity_gif_upload':True,'avatar_shape_saved_and_rendered':True,'favorite_keyboard_toggle':True,'pagination':True,'filters_restored':True,'draft_reload':True,'conflict_keeps_input':True,'undo_snapshot_unchanged':True,'avatar_upload':True,'mention_same_catalog':True,'layout':True,'errors':errors});print(json.dumps(results[-1],ensure_ascii=False),flush=True);context.close()
  browser.close()
 (shots/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
finally:
 stop_server()
