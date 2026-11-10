import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';

const uiRoot=resolve('app/ui');
const html=readFileSync(resolve(uiRoot,'index.html'),'utf8');
test('runtime-loaded fusion script has a cache version matching the current fallback revision',()=>{
 assert.match(html,/js\/fusion-v030\.js\?v=a11y-keyboard-20261109a/);
 assert.match(html,/css\/panel-workspace\.css\?v=avatar-gif-shape-372b/);
 assert.match(html,/js\/panel-workspace-ui\.js\?v=avatar-gif-shape-372b/);
 assert.match(html,/js\/panel-channels-ui\.js\?v=channels-owner-20261110a/);
});
const sources=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match=>match[1]);
for(const match of html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)){
 const url=match[1].split('?')[0];
 if(url.startsWith('js/'))sources.push(readFileSync(resolve(uiRoot,url),'utf8'));
}
// fusion-v030.js is loaded by the runtime bootstrap rather than a literal
// script tag, so include it in the source contract explicitly.
sources.push(readFileSync(resolve(uiRoot,'js/fusion-v030.js'),'utf8'));
const runtime=sources.join('\n');

function declaredGlobals(source){
 const names=new Set();
 for(const expression of [
  /\bfunction\s+([\w$]+)\s*\(/g,
  /(?:window|globalThis)\.([\w$]+)\s*=/g,
  /(?:const|let|var)\s+([\w$]+)\s*=/g,
 ])for(const match of source.matchAll(expression))names.add(match[1]);
 return names;
}

test('local stylesheet, script and image references resolve inside the UI tree',()=>{
 const references=[
  ...[...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map(match=>match[1]),
  ...[...html.matchAll(/<link[^>]+href=["']([^"']+)["']/gi)].map(match=>match[1]),
  ...[...html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)].map(match=>match[1]),
 ];
 const local=references.filter(url=>!/^([a-z]+:)?\/\//i.test(url)&&!url.startsWith('data:'));
 const missing=local.map(url=>url.split('?')[0]).filter(url=>!existsSync(resolve(uiRoot,url)));
 assert.ok(local.length>=20,`expected the panel to reference its local asset set, found ${local.length}`);
 assert.deepEqual([...new Set(missing)],[]);
});

test('direct inline event handlers call a function provided by the loaded UI scripts',()=>{
 const known=declaredGlobals(runtime),unresolved=[];
 const handler=/\bon(?:click|change|input|submit|keydown|keyup|focus|blur)\s*=\s*(["'])([\s\S]*?)\1/gi;
 let directCalls=0;
 for(const match of html.matchAll(handler)){
  const body=match[2].trim();
  const call=/^(?:return\s+)?([\w$]+)\s*\(/.exec(body);
  if(!call||['if','for','while','switch','function','this','event','window'].includes(call[1]))continue;
  directCalls++;
  if(!known.has(call[1]))unresolved.push({name:call[1],body:body.slice(0,100)});
 }
 assert.ok(directCalls>=250,`expected a representative inline-handler audit, found ${directCalls}`);
 assert.deepEqual(unresolved,[]);
});

test('static buttons with IDs have an inline or script-bound action',()=>{
 const buttons=[...html.matchAll(/<button\b([^>]*)>/gi)].map(match=>match[1]);
 const missing=[];
 for(const attributes of buttons){
  const id=attributes.match(/\bid=["']([^"']+)["']/i)?.[1];
  if(!id||/\bonclick\s*=/i.test(attributes))continue;
  const quoted=id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const direct=new RegExp(`getElementById\\(["']${quoted}["']\\)\\.(?:onclick|addEventListener\\(["']click["'])`).test(runtime);
  const aliases=[...runtime.matchAll(new RegExp(`\\b([\\w$]+)\\s*=\\s*document\\.getElementById\\(["']${quoted}["']\\)`, 'g'))].map(match=>match[1]);
  const aliased=aliases.some(name=>new RegExp(`\\b${name}\\.(?:onclick|addEventListener\\(["']click["'])`).test(runtime));
  if(!direct&&!aliased)missing.push(id);
 }
 assert.ok(buttons.length>=100,`expected a broad static button scan, found ${buttons.length}`);
 assert.deepEqual(missing,[]);
});

test('static buttons without IDs are bound to their owning form or delegated script action',()=>{
 const buttons=[...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)];
 const unresolved=[];
 for(const match of buttons){
  const attributes=match[1];
  if(/\bid\s*=|\bonclick\s*=/i.test(attributes))continue;
  const line=html.slice(0,match.index).split('\n').length;
  if(/\btype=["']submit["']/i.test(attributes)){
   const form=html.slice(Math.max(0,match.index-600),match.index);
   if(/<form\b[^>]*\bid=["']modelChecksForm["'][^>]*>/.test(form)&&/form\.onsubmit\s*=/.test(runtime))continue;
  }
  if(/\bmodal-close\b/.test(attributes)&&/querySelector\(['"]\.modal-close['"]\)\.onclick\s*=/.test(runtime))continue;
  if(/\bbp-skip\b/.test(attributes)&&/querySelector\(['"]\.bp-skip['"]\)\.addEventListener\(['"]click['"]/.test(runtime))continue;
  unresolved.push({line,attributes:attributes.trim(),text:match[2].replace(/<[^>]*>/g,'').trim()});
 }
 assert.ok(buttons.length>=250,`expected a complete static button scan, found ${buttons.length}`);
 assert.deepEqual(unresolved,[]);
});

test('icon-only chat and discussion controls expose accessible names and disclosure state',()=>{
 const iconButtons=['btnWebNet','btnMic','btnModel','btnConnector','btnSkill','btnExpert','btnQuick','btnAttach','btnVoiceCfg','roomAtBtn','roomAttachBtn','roomMemBtn'];
 for(const id of iconButtons){
  const match=[...html.matchAll(/<button\b([^>]*)>/gi)].find(item=>new RegExp(`\\bid=["']${id}["']`).test(item[1]));
  assert.ok(match,`missing #${id}`);
  assert.match(match[1],/\baria-label=["'][^"']+|\btitle=["'][^"']+/i,`#${id} needs an accessible name`);
 }
 assert.match(html,/<button class="log-filter-toggle" id="ovLogFilterToggle"[^>]*aria-expanded="false" aria-controls="ovLogBar"/);
 assert.match(html,/btn\.setAttribute\('aria-expanded', String\(open\)\)/);
 assert.match(html,/var label=recording\?'停止录音并识别':'语音输入（录音转文字）';[\s\S]*?btn\.setAttribute\('aria-label',label\)/);
 assert.match(html,/b\.setAttribute\('aria-label', label\)/);
 const unlabeledClose=[...html.matchAll(/<button\b([^>]*class=["'][^"']*\bmodal-close\b[^"']*["'][^>]*)>([\s\S]*?)<\/button>/gi)].filter(match=>!(/\baria-label=|\baria-labelledby=|\btitle=/i.test(match[1]))&&!match[2].replace(/<[^>]*>/g,'').trim());
 assert.deepEqual(unlabeledClose.map(match=>match[1]),[],'every icon-only modal close control needs an accessible name');
});

test('conversation rail search has an accessible name independent of its placeholder',()=>{
 const match=[...html.matchAll(/<input\b([^>]*)>/gi)].find(item=>/\bid=["']railSearchInput["']/.test(item[1]));
 assert.ok(match,'missing #railSearchInput');
 assert.match(match[1],/\baria-label=["']搜索所有会话内容["']/);
});

test('chat message flex item may shrink and scroll between the tab strip and composer',()=>{
 assert.match(html,/\.page\{[^}]*min-height:0/s);
 assert.match(html,/\.chat-main\{[^}]*min-height:0/s);
 assert.match(html,/\.chat-body\{[^}]*min-height:0[^}]*overflow-y:auto/s);
 const browser=readFileSync(new URL('./navigation-browser.py',import.meta.url),'utf8');
 assert.match(browser,/chatTabsOverlap/);
 assert.match(browser,/chatComposerOverlap/);
 assert.match(browser,/chatScrollable/);
});

test('runtime dialogs and conversation rail preserve keyboard semantics and focus',()=>{
 const fusion=readFileSync(resolve(uiRoot,'js/fusion-v030.js'),'utf8');
 const workspace=readFileSync(resolve(uiRoot,'js/panel-workspace-ui.js'),'utf8');
 assert.match(workspace,/class="modal pw-modal" role="dialog" aria-modal="true" aria-label=/);
 assert.match(workspace,/if\(e\.key==='Escape'\)[\s\S]*?close\(\)/);
 assert.match(workspace,/if\(opener&&opener\.isConnected\)opener\.focus\(\)/);
 assert.match(workspace,/e\.shiftKey&&\(document\.activeElement===first\|\|outside\)/);
 assert.match(workspace,/outside=!d\.contains\(document\.activeElement\)/);
 assert.match(fusion,/<div class="modal" role="dialog" aria-modal="true" aria-label=/);
 assert.match(fusion,/if\(event\.key==='Escape'\)[\s\S]*?dismiss\(\)/);
 assert.match(fusion,/if\(event\.shiftKey&&document\.activeElement===items\[0\]\)/);
 assert.match(fusion,/if\(opener&&opener\.isConnected\)opener\.focus\(\)/);
 assert.match(workspace,/class="session-open" type="button"[^>]*aria-current=/);
 assert.match(workspace,/aria-label="编辑会话名称与归类：/);
 assert.match(workspace,/aria-label="归档会话：/);
 assert.match(workspace,/class="pw-folder-title" data-folder-id=/);
 assert.match(workspace,/button\.setAttribute\('aria-expanded',String\(open\)\)/);
 const css=readFileSync(resolve(uiRoot,'css/panel-workspace.css'),'utf8');
 assert.match(css,/\.session-open[^\{]*\{[^}]*min-height:44px/s);
 assert.match(css,/button:focus-visible[^\{]*\{[^}]*outline:2px solid var\(--accent\)/s);
 assert.match(css,/\.pw-modal :where\(button,input,select,textarea,a\[href\],\[tabindex/);
});

test('chat picker actions are native keyboard controls with selection and focus semantics',()=>{
 assert.match(html,/<button type="button" class="qp-close" aria-label="取消引用"/);
 assert.match(html,/<button type="button" class="mini-popup-close" aria-label="关闭选择面板"/);
 assert.match(html,/tabs\.setAttribute\('role','tablist'\)/);
 assert.match(html,/role="tab"[^>]*aria-selected=/);
 assert.match(html,/e\.key!=='ArrowLeft'&&e\.key!=='ArrowRight'/);
 assert.match(html,/class="pop-item[^>]*aria-pressed=/);
 assert.match(html,/class="cmd-cell" aria-label=/);
 assert.match(html,/class="skill-chip" aria-label="移除技能：/);
 assert.match(html,/if\(restoreFocus!==false&&restore&&restore\.isConnected\) restore\.focus\(\)/);
 const browser=readFileSync(new URL('./keyboard-controls-browser.py',import.meta.url),'utf8');
 for(const value of ["page.keyboard.press('ArrowRight')","page.keyboard.press('Escape')","移除技能：测试技能","chat_popup_keyboard"])
  assert.ok(browser.includes(value),`keyboard fixture missing ${value}`);
});

test('quick commands expose only implemented panel actions and never advertise YOLO forwarding',()=>{
 assert.doesNotMatch(html,/YOLO 模式|未在此列出的命令将直接转发|PV\.quickGroups = \[\s*\{title:'会话控制'/);
 const fallback=html.slice(html.indexOf('function handleSlashCommand(cmd){'),html.indexOf('\nfunction appendSystemMessage',html.indexOf('function handleSlashCommand(cmd){')));
 assert.match(fallback,/window\.handlePanelSlashCommand/);
 assert.match(fallback,/此快捷命令暂不可用，请刷新面板后重试/);
 assert.match(fallback,/sendRaw\(cmd\); return/);
 assert.doesNotMatch(fallback,/其余为 Hermes 真实斜杠命令/);
 const workspace=readFileSync(new URL('../../../app/ui/js/panel-workspace-ui.js',import.meta.url),'utf8');
 assert.match(workspace,/window\.handlePanelSlashCommand=window\.handleSlashCommand/);
 assert.match(workspace,/面板不支持 \/['"]\+name\+['"]。可用操作/);
});

test('typing behavior has one visible editor while preserving the dedicated effective-value panel',()=>{
 const channels=readFileSync(resolve(uiRoot,'js/panel-channels-ui.js'),'utf8');
 const typing=readFileSync(resolve(uiRoot,'js/panel-typing-ui.js'),'utf8');
 assert.match(channels,/channel\.fields\.filter\(function\(f\)\{return f\.key!==['"]typing_indicator['"];\}\)\.forEach/);
 assert.match(typing,/request\(\)/);
 assert.match(typing,/platform\.enabled\?['"]on['"]:['"]off['"]/);
 assert.match(typing,/request\(\{platform:platform\.id,enabled:/);
});

test('expert catalog fallback uses an actionable error instead of an unknown-type placeholder',()=>{
 assert.match(html,/专家资料暂时无法显示，请刷新目录重试/);
 assert.doesNotMatch(html,/未知专家类型/);
});

test('user-visible failure fallbacks explain the action instead of saying unknown',()=>{
 assert.doesNotMatch(html,/未知(?:错误|模型|类型)/);
 assert.doesNotMatch(html,/\|\s*['"]未知['"]/);
 assert.match(html,/服务器没有返回(?:保存|删除|上传|操作|扫码状态)原因/);
});

test('connector shortcuts expose only configured connectors and persist the current choice',()=>{
 const connectors=readFileSync(resolve(uiRoot,'js/panel-connectors-ui.js'),'utf8');
 assert.match(runtime,/\(_connState\.list\|\|\[\]\)\.filter\(function\(c\)\{return c\.configured;\}\)/);
 assert.match(connectors,/filter\(function\(c\)\{return c\.configured;\}\)/);
 assert.match(connectors,/_selectedConnector=c\.kind;renderConnectorChip\(\);saveDraft\(currentSession\)/);
 assert.match(connectors,/尚未配置连接器，请先在管理页保存凭证/);
});

test('overview service health changes are exposed as a polite live status',()=>{
 assert.match(html,/<div class="ov-status off" id="ovStatusBadge"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/);
 assert.match(html,/<div id="overviewStatusFeedback" class="maintenance-feedback" role="status" aria-live="polite" aria-atomic="true"><\/div>/);
 assert.match(html,/if\(!res \|\| !res\.ok\)\{ el\.innerHTML='<div class="empty-state" role="alert" aria-live="assertive">加载失败<\/div>'; return; \}/);
 assert.match(html,/feedback\.textContent=\(gw\|\|db\)\?'服务运行中：'/);
 assert.match(html,/feedback\.textContent='服务离线，暂时无法读取运行状态'/);
});

test('service and memory switches expose native keyboard and checked state semantics',()=>{
 for(const [id,label] of [['gwToggle','Gateway 服务'],['dbToggle','Dashboard 服务'],['logRefreshToggle','开启实时日志刷新'],['memToggle','启用长期记忆']]){
  const button=[...html.matchAll(/<button\b([^>]*)>/gi)].find(match=>new RegExp(`\\bid=["']${id}["']`).test(match[1]));
  assert.ok(button,`#${id} must be a native button`);
  assert.match(button[1],/role=["']switch["']/);
  assert.match(button[1],/aria-checked=["']false["']/);
  assert.match(button[1],new RegExp(`aria-label=["']${label}`));
 }
 assert.match(html,/function setToggle\(id, on\)[\s\S]*?setAttribute\('aria-checked',String\(!!on\)\)/);
 assert.match(html,/t\.classList\.toggle\('on'\);t\.setAttribute\('aria-checked',String\(t\.classList\.contains\('on'\)\)\)/);
});

test('multi-session tabs and extension actions are operable without pointer-only card handlers',()=>{
 assert.match(html,/class="tab-select" data-session-id=/);
 assert.match(html,/event\.stopImmediatePropagation\(\);\s*window\.switchTab\(button\.getAttribute\('data-session-id'\)\)/);
 assert.match(html,/class="tab-select" data-session-id=.*aria-current=.*onclick="switchTab/);
 assert.match(html,/class="tab-action tab-ren"[^>]*aria-label="重命名会话：/);
 assert.match(html,/class="tab-action tab-close"[^>]*aria-label="关闭会话标签：/);
 assert.match(html,/function extCardHTML\([\s\S]*?return '<div class="ext-card">'/);
 assert.doesNotMatch(html,/return '<div class="ext-card" onclick="'\+onclick/);
});

test('chat history is a live log and failed message loads are announced as actionable errors',()=>{
 assert.match(html,/<div class="chat-body" id="chatBody"[^>]*role="log"[^>]*aria-live="polite"[^>]*aria-relevant="additions text"/);
 assert.match(html,/class="chat-load-error"><span role="alert">加载消息失败，请确认后端已连接后重试。<\/span><button type="button" onclick="loadSessionMessages\(currentSession\)"/);
});

test('local skill read failures are visible and runtime polling failures remain observable',()=>{
 assert.match(html,/<div id="skillFeedback" class="maintenance-feedback" role="status" aria-live="polite"><\/div>/);
 assert.match(html,/本地技能读取失败：/);
 const runtimeUi=readFileSync(resolve(uiRoot,'js/panel-runtime-ui.js'),'utf8');
 assert.match(runtimeUi,/运行状态读取失败：/);
});

test('channel runtime polling updates are announced to assistive technology',()=>{
 const channels=readFileSync(resolve(uiRoot,'js/panel-channels-ui.js'),'utf8');
 assert.match(channels,/live\.setAttribute\('role','status'\)/);
 assert.match(channels,/live\.setAttribute\('aria-live','polite'\)/);
 assert.match(channels,/live\.setAttribute\('aria-atomic','true'\)/);
 assert.match(channels,/运行状态读取失败，正在等待重试/);
 assert.match(channels,/live\.dataset\.announcedText!==text/);
 assert.match(channels,/e\.dataset\.announcedText!==text/);
});

test('channel list has one renderer and exposes its initialized state',()=>{
 const channels=readFileSync(resolve(uiRoot,'js/panel-channels-ui.js'),'utf8');
 const fusion=readFileSync(resolve(uiRoot,'js/fusion-v030.js'),'utf8');
 assert.match(html,/function renderChannels\(\)\{\s*var grid=document\.getElementById\('channelGrid'\);\s*if\(window\.panelRenderChannels\) return window\.panelRenderChannels\(\);/);
 assert.doesNotMatch(fusion,/window\.renderChannels\s*=\s*function/);
 assert.match(channels,/grid\.dataset\.renderer='panel-channels-ui'/);
 assert.match(channels,/grid\.dataset\.loadState='ready'/);
 assert.match(channels,/grid\.dataset\.loadState='error'/);
});

test('mobile session tabs are optional for one session and labeled by their action',()=>{
 assert.match(html,/id="multiTabsBtn"[^>]*aria-label="显示多会话标签"[^>]*aria-expanded="false"[^>]*aria-controls="sessionTabs"/);
 assert.match(html,/_openTabs\.length > 1/);
 assert.match(html,/function updateSessionTabsToggle\(\)/);
});

test('model discovery selection compares canonical string model IDs and explicitly renders checked state',()=>{
 const models=readFileSync(resolve(uiRoot,'js/panel-models-ui.js'),'utf8');
 assert.match(models,/check\.checked=item\.selected===true/);
 assert.match(models,/known=new Set\(modelData\.filter\(item=>item\.enabled!==false\)\.map\(item=>String\(item\.id\)\)\)/);
 assert.match(models,/selected:!known\.has\(String\(m\.id\)\)/);
 assert.match(models,/discovered\.filter\(m=>m\.selected===true\)/);
 assert.match(models,/未启用项已勾选/);
});

test('new model providers can add discovered models before they have a route identity',()=>{
 const models=readFileSync(resolve(uiRoot,'js/panel-models-ui.js'),'utf8');
 assert.match(models,/var route=provider\?routeFor\(provider\.id,m\.id\):''/);
 assert.match(models,/服务默认模型ID（供未指定模型时使用）/);
 assert.match(models,/服务默认模型；模型发现不会替你决定默认项/);
});

test('primary and fallback route choices never preselect the first model',()=>{
 const models=readFileSync(resolve(uiRoot,'js/panel-models-ui.js'),'utf8');
 assert.match(models,/configuredPrimary=data\.primary\.provider&&data\.primary\.model\?/);
 assert.match(models,/if\(!hasValue\)input\.selectedIndex=0/);
 assert.match(models,/选择要加入的回退模型/);
 assert.match(models,/add\.value=''/);
 assert.match(models,/请先选择要加入的回退模型/);
 assert.match(models,/if\(!primary\.value\)throw Error\('请选择主模型'\)/);
});

test('model drafts report browser durability and guard closing when storage fails',()=>{
 const models=readFileSync(resolve(uiRoot,'js/panel-models-ui.js'),'utf8');
 assert.match(models,/未保存的表单已保存到此浏览器/);
 assert.match(models,/浏览器无法保存草稿；当前修改仅在此窗口保留/);
 assert.match(models,/浏览器无法保存路线草稿；当前修改仅在此窗口保留/);
 assert.match(models,/草稿未能保存到浏览器，关闭会丢失非凭证修改/);
 assert.match(models,/路线草稿未能保存到浏览器。关闭将丢弃当前窗口中的路线修改/);
 assert.match(models,/旧草稿无法从浏览器存储清除，弹窗保持打开/);
 assert.match(models,/旧路线草稿无法从浏览器存储清除，弹窗保持打开/);
 assert.match(models,/if\(box\.beforeClose&&!box\.beforeClose\(\)\)return/);
 assert.match(models,/function credentialEditsPending\(\)/);
 assert.match(models,/API 密钥或请求头有未保存输入，凭证不会储存在浏览器/);
});
