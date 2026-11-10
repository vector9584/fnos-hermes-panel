"""Navigation/layout integration against temporary preview state only."""
import json
import signal
import os
import shlex
import subprocess
import tempfile
import pwd
from pathlib import Path
from playwright.sync_api import sync_playwright
from preview_process import preview_launcher, read_startup_line

ROOT = Path(__file__).resolve().parent
STATE = Path(tempfile.mkdtemp(prefix='hermes-navigation-preview-', dir='/tmp')); STATE.chmod(0o777)
(STATE / 'native-home/cron').mkdir(parents=True)
(STATE / 'native-home/cron/jobs.json').write_text('{"jobs":[]}')
env = {**os.environ, 'PREVIEW_STATE_ROOT': str(STATE), 'PREVIEW_PORT': '0',
       'HOME': str(STATE), 'PYTHONDONTWRITEBYTECODE': '1'}
os.environ['PLAYWRIGHT_BROWSERS_PATH']=os.environ.get('HERMES_PLAYWRIGHT_BROWSERS_PATH',os.environ.get('PLAYWRIGHT_BROWSERS_PATH','/vol1/@apphome/hermes-agent/data/.cache/ms-playwright'))
node=os.environ.get('HERMES_PREVIEW_NODE','/vol1/@apphome/hermes-agent/data/node/bin/node');cmd=preview_launcher()+['env']+[f'{k}={env[k]}' for k in ('PREVIEW_STATE_ROOT','PREVIEW_PORT','HOME','PYTHONDONTWRITEBYTECODE')]+[node,str(ROOT/'preview-server.mjs')]
server = subprocess.Popen(cmd,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
shots = Path(tempfile.mkdtemp(prefix='hermes-navigation-evidence-',dir='/tmp')); shots.chmod(0o777)
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
    port=int(json.loads(first)['port']);url='http://127.0.0.1:'+str(port);print(first,flush=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(args=['--no-sandbox'])
        for width, height in [(1440,900),(390,844),(844,390)]:
            context = browser.new_context(viewport={'width':width,'height':height})
            context.route('**/*', lambda route: route.continue_(url=route.request.url.replace('/app/hermes-agent/','/')) if route.request.url.startswith(url) else route.abort())
            page = context.new_page(); errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto(url, wait_until='domcontentloaded')
            page.wait_for_function("document.body.classList.contains('workbench-navigation') && monitorToken==='fixture-token'")
            if width <= 768:
                page.evaluate("""() => {
                  _openTabs=['test-a'];
                  syncSessionTabsVisibility();
                }""")
                assert not page.locator('#sessionTabs').is_visible(), 'A single open session should not consume a mobile tab row'
                toggle=page.get_by_role('button',name='显示多会话标签')
                assert toggle.get_attribute('aria-controls')=='sessionTabs'
                toggle.click()
                assert page.locator('#sessionTabs').is_visible()
                assert page.get_by_role('button',name='隐藏多会话标签').get_attribute('aria-expanded')=='true'
                page.get_by_role('button',name='隐藏多会话标签').click()
                assert not page.locator('#sessionTabs').is_visible()
                page.evaluate("""() => {
                  _tabsManuallyHidden=false;
                  _openTabs=['test-a','test-b'];
                  syncSessionTabsVisibility();
                }""")
                assert page.locator('#sessionTabs').is_visible(), 'Multiple open sessions should show direct switching tabs'
            if width <= 768:
                page.locator('#page-chat .rail-toggle').click()
                page.locator('.chat-rail.open .session-item').first.wait_for()
                rail_result = page.evaluate('''() => {
                  const row=document.querySelector('.chat-rail.open .session-item');
                  const title=row.querySelector('.title');
                  title.textContent='一条很长的会话名称用于检查手机抽屉操作按钮是否被挤出可视区域 '.repeat(4);
                  const rail=document.querySelector('.chat-rail').getBoundingClientRect();
                  const bounds=[...row.querySelectorAll('.session-open,.ren,.del')].map(el=>{
                    const rect=el.getBoundingClientRect();return {name:el.className,left:rect.left,right:rect.right};
                  });
                  return {rail:{left:rail.left,right:rail.right},bounds};
                }''')
                assert all(item['left']>=rail_result['rail']['left']-1 and item['right']<=rail_result['rail']['right']+1 for item in rail_result['bounds']), rail_result
                page.locator('.chat-rail-overlay').click(position={'x':350,'y':700})
            for dest in ['chat','experts','rooms','plans','echo','cron','kb','memory','extensions','comm','models','overview','usage','updates','settings']:
                page.evaluate('(dest)=>switchPage(dest)', dest)
                page.wait_for_timeout(300)
                assert page.locator('#page-'+dest).is_visible(), dest
                if dest == 'kb':
                    page.get_by_role('button',name='资料库',exact=True).wait_for()
                    page.get_by_role('button',name='技能轨迹',exact=True).click()
                    page.locator('#learnGraph').get_by_text('尚无技能数据',exact=True).wait_for()
                    assert page.locator('#page-kb .library-trajectory-view').is_visible()
                    page.get_by_role('button',name='资料库',exact=True).click()
                    assert page.locator('#page-kb .library-body').is_visible()
                if dest == 'comm':
                    page.locator('#page-connectors').get_by_text('已配置测试连接器',exact=True).wait_for()
                    assert page.locator('#page-connectors').evaluate('(e)=>!!e.closest(\'#page-comm\')')
                if dest == 'chat':
                    page.evaluate("""() => {
                      const body=document.getElementById('chatBody');
                      body.replaceChildren(...Array.from({length:48},(_,index)=>{
                        const message=document.createElement('div');message.className='msg assistant';
                        message.textContent='长会话滚动布局验收 '+index+' '+('对话内容 '.repeat(18));return message;
                      }));
                    }""")
                    page.wait_for_function("document.getElementById('chatBody').scrollHeight>document.getElementById('chatBody').clientHeight")
                metrics = page.evaluate('''() => {
                  const el=document.querySelector('.page.active'), r=el.getBoundingClientRect();
                  const nav=document.querySelector('.mobile-navigation'), n=nav.getBoundingClientRect();
                  const limit=getComputedStyle(nav).display==='none'?innerHeight:n.top;
                  const controls=[...el.querySelectorAll('#chatInput,#discussionInput')].map(x=>{const b=x.getBoundingClientRect();return {id:x.id,top:b.top,bottom:b.bottom,left:b.left,right:b.right};});
                  const tabs=document.getElementById('sessionTabs'),chat=document.getElementById('chatBody'),composer=document.getElementById('chatComposer');
                  const visible=tabs.classList.contains('visible'),tr=tabs.getBoundingClientRect(),cr=chat.getBoundingClientRect(),pr=composer.getBoundingClientRect();
                  return {width:innerWidth,limit,bottom:r.bottom,overflow:document.documentElement.scrollWidth>innerWidth,controls,
                    chatTabsOverlap:visible&&cr.top+1<tr.bottom,chatComposerOverlap:cr.bottom>pr.top+1,
                    chatScrollable:chat.scrollHeight>chat.clientHeight,
                    chatGeometry:{tabsBottom:visible?tr.bottom:null,chatTop:cr.top,chatBottom:cr.bottom,composerTop:pr.top}};
                }''')
                if dest == 'updates':
                    page.wait_for_function("document.querySelector('#maintenanceFeedback')?.textContent.includes('快照') || document.querySelector('#maintenanceFeedback')?.textContent.includes('无法读取')")
                    assert page.locator('.maintenance-commit').count()==30,{'feedback':page.locator('#maintenanceFeedback').inner_text(),'repositories':page.locator('#maintenanceRepositories').inner_text(),'history':page.locator('#maintenanceHistory').inner_text()}
                    assert page.locator('.maintenance-repository').count()==2
                    assert page.locator('.maintenance-repository').nth(1).is_disabled()
                    page.locator('.maintenance-commit summary').first.click()
                    assert '完整说明' in page.locator('.maintenance-commit pre').first.inner_text()
                    assert page.evaluate('window.commitInjected') is None
                    page.locator('#maintenanceMore').click()
                    page.wait_for_function("document.querySelectorAll('.maintenance-commit').length===33")
                    assert not page.locator('#maintenanceMore').is_visible()
                    page.locator('#maintenanceRefresh').click()
                    page.wait_for_function("document.querySelectorAll('.maintenance-commit').length===30")
                if dest == 'settings':
                    page.wait_for_function("!document.getElementById('settingsToolsMode').disabled")
                    for mode in ['hidden','expanded','collapsed']:
                        page.locator('#settingsToolsMode').select_option(mode)
                        page.wait_for_function("mode=>panelToolsMode()===mode && !document.getElementById('settingsToolsMode').disabled", arg=mode)
                        rendered=page.evaluate("toolCallsHTML([{tool:'read_file',toolCallId:'fixture',status:'completed',result:'ok'}])")
                        assert (rendered=='') == (mode=='hidden')
                        if mode!='hidden': assert ('data-collapsed="'+str(mode=='collapsed').lower()+'"') in rendered
                    page.reload(wait_until='domcontentloaded')
                    page.wait_for_function("!document.getElementById('settingsToolsMode').disabled")
                    assert page.locator('#settingsToolsMode').input_value()=='collapsed'
                    assert page.locator('#page-settings [data-key]').count()==0
                assert not page.get_by_text('is not defined', exact=False).count(), 'Caught reference error surfaced in UI'
                page.screenshot(path=str(shots/f'{dest}-{width}.png'))
                results.append({'page':dest,'viewport':[width,height],**metrics})
            for alias,target,content in [
                ('connectors','comm','已配置测试连接器'),
                ('tunnel','comm','已配置测试连接器'),
                ('learning','kb','尚无技能数据'),
            ]:
                page.evaluate('(dest)=>switchPage(dest)',alias)
                page.locator('#page-'+target).wait_for(state='visible')
                if alias=='learning':
                    page.locator('#page-kb .library-trajectory-view').wait_for(state='visible')
                    page.wait_for_function("document.querySelector('#learnGraph .empty-state')?.textContent==="+json.dumps(content),timeout=15000)
                else:
                    page.locator('#page-connectors').get_by_text(content,exact=True).wait_for()
                results.append({'route_alias':alias,'target':target,'viewport':[width,height],'content_ready':True})
            # Focused input + reduced visual viewport reproduces keyboard resize events.
            page.evaluate("switchPage('chat');currentSession='test-a';restoreDraft('test-a');loadSessionMessages('test-a')")
            if width <= 768:
                page.locator('#chatInput').focus()
                page.evaluate("Object.defineProperty(visualViewport,'height',{configurable:true,value:420});visualViewport.dispatchEvent(new Event('resize'))")
                assert page.locator('body').evaluate("e=>e.classList.contains('mobile-keyboard-open')")
                assert not page.locator('.mobile-navigation').is_visible()
                box=page.locator('#chatInput').bounding_box()
                assert box['y']+box['height']<=420, box
                page.screenshot(path=str(shots/f'keyboard-{width}.png'))
                page.evaluate("delete visualViewport.height;visualViewport.dispatchEvent(new Event('resize'))")
                assert page.locator('.mobile-navigation').is_visible()
            print(json.dumps({'viewport':[width,height],'errors':errors},ensure_ascii=False),flush=True)
            assert not errors, errors
            context.close()
        browser.close()
    (shots/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
    failures=[r for r in results if r.get('overflow') or r.get('bottom',0)>r.get('limit',0)+1 or r.get('chatTabsOverlap') or r.get('chatComposerOverlap') or any(c['bottom']>r['limit']+1 or c['right']>r['width']+1 for c in r.get('controls',[]))]
    print(json.dumps({'pages':sum('page' in r for r in results),'route_aliases':sum('route_alias' in r for r in results),'failures':failures},ensure_ascii=False),flush=True)
    assert not failures
finally:
    stop_server()
