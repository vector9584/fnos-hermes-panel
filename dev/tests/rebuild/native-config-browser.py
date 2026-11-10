"""Render actual shipped ConfigPage against extracted endpoints and /tmp YAML.

No Monitor, Gateway, or Dashboard import/start. Installed static assets are
read only; candidate API/ConfigPage assets overlay them via the real importmap.
"""
import ast,asyncio,importlib.util,json,mimetypes,os,threading
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from urllib.parse import urlsplit,parse_qs
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[3]
spec=importlib.util.spec_from_file_location('native_fixture',Path(__file__).with_name('native-config-integration.test.py'));fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)
case=fixture.NativeIntegration();case.setUp()
assets=Path('/vol1/@appcenter/hermes-agent/hermes-src/hermes_cli/web_dist/assets')
candidate=ROOT/'app/python/hermes_cli/web_dist/assets'
shots=Path('/tmp/hermes-native-config-evidence');shots.mkdir(exist_ok=True)
web=fixture.FIXTURE/'web';web.mkdir()
(web/'index.html').write_text('''<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/assets/index-BM3K351U.css"></head><body class="dark"><div id="root"></div><script type="module">
import {m as react,f as client} from '/assets/react-vendor-ByjAt55v.js';
import {t as Header} from '/assets/page-header-context-BZmZRDpE.js';
import {t as I18n} from '/assets/i18n-C71aeCnG.js';
import Page from '/assets/ConfigPage-DNVi6bFP.js';
const React=react();const context={start:null,end:null,setStart:()=>{},setEnd:()=>{}};
localStorage.setItem('hermes-locale','zh');
client().createRoot(document.getElementById('root')).render(React.createElement(I18n,null,React.createElement(Header.Provider,{value:context},React.createElement(Page))));
</script></body></html>''')
# Compile the real nested HTML response function, without importing web_server.
tree=ast.parse((ROOT/'app/python/hermes_cli/web_server.py').read_text())
node=next(n for n in ast.walk(tree) if isinstance(n,ast.FunctionDef) and n.name=='_serve_index')
from starlette.responses import HTMLResponse,JSONResponse
scope={'_index_path':web/'index.html','_DASHBOARD_EMBEDDED_CHAT_ENABLED':False,'app':type('App',(),{'state':type('State',(),{'auth_required':False})()})(),'_SESSION_TOKEN':'fixture-token','_render_active_theme_bootstrap_css':lambda:'','HTMLResponse':HTMLResponse,'JSONResponse':JSONResponse}
exec(compile(ast.fix_missing_locations(ast.Module(body=[node],type_ignores=[])),'candidate-web-index','exec'),scope)
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def respond(self,status,body,kind='application/json'):
  data=body if isinstance(body,bytes) else json.dumps(body,ensure_ascii=False).encode();self.send_response(status);self.send_header('Content-Type',kind);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
 def do_GET(self):
  url=urlsplit(self.path);path=url.path;prefix='/proxy/dashboard' if path.startswith('/proxy/dashboard') else '';path=path[len(prefix):]
  if path.startswith('/assets/'):
   name=Path(path).name;file=candidate/name if (candidate/name).exists() else assets/name
   if file.is_file():return self.respond(200,file.read_bytes(),mimetypes.guess_type(str(file))[0] or 'application/octet-stream')
   return self.respond(404,{'error':'asset missing'})
  profile=parse_qs(url.query).get('profile',[None])[0]
  try:
   if path=='/api/config':return self.respond(200,case.call('get_config',profile))
   if path=='/api/config/raw':return self.respond(200,case.call('get_config_raw',profile))
   if path=='/api/config/defaults':return self.respond(200,fixture.config.DEFAULT_CONFIG)
   if path=='/api/config/schema':return self.respond(200,{'fields':{'memory.enabled':{'type':'boolean','category':'memory','description':'是否启用记忆'}},'category_order':['memory']})
   if path=='/api/status':return self.respond(200,{'config_path':str(case.path)})
   if path.startswith('/api/'):return self.respond(200,{})
   html=scope['_serve_index'](prefix).body.decode()
   # Minimal harness uses absolute import specifiers; match proxy rewriting of
   # imports that built Vite chunks normally express relatively.
   if prefix:html=html.replace("from '/assets/","from '"+prefix+"/assets/")
   return self.respond(200,html.encode(),'text/html')
  except Exception as error:self.respond(getattr(error,'status_code',500),{'detail':str(error)})
 def do_PUT(self):
  path=urlsplit(self.path).path.removeprefix('/proxy/dashboard');body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
  try:
   name,model=('update_config_raw',case.RawConfigUpdate) if path=='/api/config/raw' else ('update_config',case.ConfigUpdate)
   self.respond(200,case.call(name,model(**body)))
  except Exception as error:self.respond(getattr(error,'status_code',500),{'detail':getattr(error,'detail',str(error))})
server=ThreadingHTTPServer(('127.0.0.1',0),Handler);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
os.environ['PLAYWRIGHT_BROWSERS_PATH']='/vol1/@apphome/hermes-agent/data/.cache/ms-playwright'
results=[]
try:
 with sync_playwright() as p:
  browser=p.chromium.launch(args=['--no-sandbox']);origin='http://127.0.0.1:'+str(server.server_port)
  for width,height,prefix in [(1440,900,''),(390,844,'/proxy/dashboard'),(844,390,'/proxy/dashboard')]:
   case.setUp();context=browser.new_context(viewport={'width':width,'height':height});context.route('**/*',lambda r:r.continue_() if r.request.url.startswith(origin+'/') else r.abort());page=context.new_page();errors=[];requests=[];page.on('pageerror',lambda e:errors.append(str(e)));page.on('request',lambda r:requests.append(r.url));page.goto(origin+prefix+'/config',wait_until='networkidle');page.wait_for_selector('button');print('VIEW',width,page.locator('body').inner_text()[:700],flush=True)
   page.get_by_role('switch').click();page.get_by_role('button',name='保存',exact=True).click();page.get_by_text('配置已保存',exact=True).wait_for();assert not fixture.config.read_raw_config()['memory']['enabled']
   page.get_by_role('switch').click();page.get_by_role('button',name='保存',exact=True).click();page.wait_for_timeout(150);assert fixture.config.read_raw_config()['memory']['enabled']
   case.path.write_text(case.path.read_text()+'external_form: true\n');page.get_by_role('switch').click();page.get_by_role('button',name='保存',exact=True).click();dialog=page.get_by_role('dialog',name='配置已在别处修改');dialog.wait_for();assert fixture.config.read_raw_config()['memory']['enabled'];assert page.get_by_role('switch').get_attribute('aria-checked')=='false';dialog.get_by_role('button',name='返回继续编辑',exact=True).click()
   page.get_by_role('button',name='YAML',exact=True).click();editor=page.locator('textarea');editor.wait_for();initial=editor.input_value();assert '# integration header' in initial
   text='# edited in browser\nmodel: {default: browser, provider: one}\nmemory: {enabled: false}\n';editor.fill(text)
   page.get_by_role('button',name='保存',exact=True).click();page.wait_for_function("document.body.innerText.includes('YAML 配置已保存')");assert case.path.read_text()==text
   editor.fill(text+'workers: {browser: 1}\n');page.get_by_role('button',name='保存',exact=True).click();page.wait_for_timeout(150);assert 'browser: 1' in case.path.read_text()
   case.path.write_text(case.path.read_text()+'external: true\n');draft=text+'workers: {draft: 2}\n';editor.fill(draft);page.get_by_role('button',name='保存',exact=True).click();dialog=page.get_by_role('dialog',name='配置已在别处修改');dialog.wait_for();assert page.locator('textarea').first.input_value()==draft;assert 'external: true' in case.path.read_text();assert 'draft: 2' not in case.path.read_text();assert 'external: true' in dialog.get_by_role('textbox',name='最新已保存配置').input_value()
   page.screenshot(path=str(shots/f'native-config-{width}.png'));assert dialog.evaluate('(e)=>e.scrollWidth<=e.clientWidth+1');dialog.get_by_role('button',name='返回继续编辑',exact=True).click();assert editor.input_value()==draft
   # User merges the new field, then explicitly adopts the observed version.
   draft+='external: true\n';editor.fill(draft);page.get_by_role('button',name='保存',exact=True).click();dialog.wait_for();dialog.get_by_role('button',name='已核对，采用最新版本',exact=True).click();page.get_by_role('button',name='保存',exact=True).click();page.wait_for_timeout(150);assert case.path.read_text()==draft
   assert not errors,errors;assert any('api-CUjvYA_E.js?panel=config18' in u for u in requests);assert any('ConfigPage-DNVi6bFP.js?panel=config18' in u for u in requests);results.append({'viewport':[width,height],'prefix':prefix,'form_repeated_save':True,'yaml_repeated_save':True,'conflict_draft_kept':True,'compare_resolve':True,'versioned_assets':True,'errors':errors});context.close()
  browser.close()
 (shots/'results.json').write_text(json.dumps(results,indent=2,ensure_ascii=False));print(json.dumps(results,ensure_ascii=False))
finally:server.shutdown();server.server_close();fixture.temporary.cleanup()
