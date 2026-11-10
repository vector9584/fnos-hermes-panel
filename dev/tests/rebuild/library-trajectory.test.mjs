import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const library=readFileSync(new URL('../../../app/ui/js/panel-library-ui.js',import.meta.url),'utf8');
const fusion=readFileSync(new URL('../../../app/ui/js/fusion-v030.js',import.meta.url),'utf8');
const fixture=readFileSync(new URL('./preview-server.mjs',import.meta.url),'utf8');
const navigation=readFileSync(new URL('./navigation-browser.py',import.meta.url),'utf8');
const keyboard=readFileSync(new URL('./keyboard-controls-browser.py',import.meta.url),'utf8');
const visible=readFileSync(new URL('./visible-state-browser.py',import.meta.url),'utf8');
const html=readFileSync(new URL('../../../app/ui/index.html',import.meta.url),'utf8');

test('knowledge library exposes the merged skill trajectory and retains document actions',()=>{
 assert.match(library,/library-view-switch/);
 assert.match(library,/技能轨迹/);
 assert.match(library,/笔记关系/);
 assert.match(library,/renderNoteGraph/);
 assert.match(library,/\/graph\?source=knowledge/);
 assert.match(library,/kbOpenNote\(node\.path\)/);
 assert.match(library,/library-folder/);
 assert.match(library,/folderPart/);
 assert.match(html,/library-navigation-confirmed-state-375a/);
 assert.match(library,/window\.panelLibraryTrajectory=\(\)=>setKbView\('trajectory'\)/);
 assert.match(library,/window\.kbNewNote=\(\)=>document\.querySelector\('#page-kb \.page-header button:last-child'\)\.click\(\)/);
 assert.match(fusion,/if\(name==='learning'\) name='kb'/);
 assert.match(fusion,/if\(openTrajectory&&typeof window\.panelLibraryTrajectory==='function'\)window\.panelLibraryTrajectory\(\)/);
 assert.match(fixture,/api\/learning-trajectory/);
});

test('navigation and visible state fixtures verify merged sections and legacy routes',()=>{
 for(const value of ["('connectors','comm'","('tunnel','comm'","('learning','kb'","name='技能轨迹'","已配置测试连接器","尚无技能数据"])
  assert.ok(navigation.includes(value),`navigation fixture missing ${value}`);
 assert.ok(visible.includes("'kb/trajectory'"));
 assert.ok(visible.includes("'comm/connectors'"));
 assert.match(visible,/def scan_controls\(page, destination, viewport\)/);
 assert.match(visible,/root\.querySelectorAll\([\s\S]*?button, input:not\(\[type="hidden"\]\), select, textarea/);
 assert.match(visible,/aria-labelledby/);
 assert.match(visible,/aria-label/);
 assert.match(visible,/element\.labels\?\.length/);
 assert.match(visible,/unnamed_control_count/);
 assert.match(visible,/assert not unnamed_controls/);
});

test('keyboard acceptance exercises native switch and session actions without pointer-only extension cards',()=>{
 assert.match(keyboard,/page\.keyboard\.press\('Space'\)/);
 assert.match(keyboard,/page\.keyboard\.press\('Enter'\)/);
 assert.match(keyboard,/get_by_role\('button', name=name, exact=True\)/);
 assert.match(keyboard,/\(1440, 900\), \(390, 844\), \(844, 390\)/);
 assert.match(keyboard,/\.ext-card\[onclick\]/);
 assert.match(html,/role="switch" aria-checked=/);
 assert.match(html,/function serviceActionError\(result, which\)/);
 assert.match(keyboard,/service_nested_start_error_feedback/);
});

test('model service discovery starts with a writable credential field when none is saved',()=>{
 const models=readFileSync(new URL('../../../app/ui/js/panel-models-ui.js',import.meta.url),'utf8');
 assert.match(models,/provider\?\.api_key_configured\?'keep':'replace'/);
 assert.match(models,/key\.parentElement\.hidden=keyAction\.value!=='replace'/);
});

test('native library dialogs are removed on Escape and restore the opener focus',()=>{
 assert.match(library,/function trackDialog\(dialog,opener,restore\)/);
 assert.match(library,/dialog\.addEventListener\('close',function\(\)\{dialog\.remove\(\)/);
 assert.match(library,/focus\.opener\.focus\(\)/);
 assert.match(library,/trackDialog\(d,opener,false\);d\.close\(\)/);
 assert.match(html,/panel-library-ui\.js\?v=library-navigation-confirmed-state-375a/);
 assert.match(readFileSync(new URL('./library-browser.py',import.meta.url),'utf8'),/资料修改记录/);
});

test('memory review dialogs stop their poller and guard navigation while requests are busy',()=>{
 const reviews=readFileSync(new URL('../../../app/ui/js/panel-library-reviews-ui.js',import.meta.url),'utf8');
 const browser=readFileSync(new URL('./review-history-browser.py',import.meta.url),'utf8');
 assert.match(reviews,/function trackDialog\(dialog,opener,restore\)/);
 assert.match(reviews,/clearInterval\(pollTimer\);clearTimeout\(timer\);d\.close\(\);return true/);
 assert.match(reviews,/if\(busy\)\{status\.textContent='正在提交整理任务，完成后才能打开记录。';return;\}/);
 assert.match(reviews,/if\(!finish\(\)\)return;trackDialog\(r,trigger,false\);r\.close\(\)/);
 assert.match(browser,/detail_escape_restores_focus_and_cleans_dom/);
 assert.match(browser,/list_escape_restores_focus_and_stops_polling/);
});
