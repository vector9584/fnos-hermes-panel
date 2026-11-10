import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

const root=fs.mkdtempSync(join(tmpdir(),'hermes-identity-test-'));
process.env.DATA_DIR=join(root,'legacy');process.env.VAR_DIR=join(root,'var');
fs.mkdirSync(process.env.DATA_DIR,{recursive:true});fs.mkdirSync(join(process.env.VAR_DIR,'chat/sessions'),{recursive:true});
const old={version:1,folders:[{id:'existing',name:'旧分类',parent_id:''}],sessions:{a:{expert:{id:'old-expert',name:'旧专家',emoji:'🔬',prompt:'原设定',skills:['file_manager']}}},identity:{user_name:'Vector',user_avatar:'👤',assistant_name:'Hermes',assistant_avatar:'🤖'},voice:{engine:'windows',fallback:true},favorites:['coder']};
const legacy=join(process.env.DATA_DIR,'panel-workspace.json');fs.writeFileSync(legacy,JSON.stringify(old));
fs.writeFileSync(join(process.env.DATA_DIR,'SOUL.md'),'persistent identity');fs.writeFileSync(join(process.env.DATA_DIR,'config.yaml'),'unchanged configuration');
for(const id of ['a','b'])fs.writeFileSync(join(process.env.VAR_DIR,'chat/sessions',id+'.json'),'{}');
const bytes=()=>Object.fromEntries(fs.readdirSync(process.env.DATA_DIR).map(n=>[n,createHash('sha256').update(fs.readFileSync(join(process.env.DATA_DIR,n))).digest('hex')]));
const before=bytes();
const {handleWorkspace,readWorkspace,sessionSystem,sessionSnapshot}=await import('../../../app/server/panel-workspace.js');
const {expertCatalog,getExpert}=await import('../../../app/server/panel-experts.js');
async function call(path='',method='GET',body){const response=await handleWorkspace(new Request('http://fixture/api/workspace-ui'+path,{method,body:body?JSON.stringify(body):undefined,headers:{'Content-Type':'application/json'}}),()=>true);return {status:response.status,...await response.json()};}
async function unauthorized(path,method='GET',body){return handleWorkspace(new Request('http://fixture/api/workspace-ui'+path,{method,body:body?JSON.stringify(body):undefined,headers:{'Content-Type':'application/json'}}),()=>false);}
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));

test('workspace metadata reads require authentication while avatar bytes remain public',async()=>{
 for(const path of ['', '/experts', '/personalities', '/folders', '/search?q=Vector', '/channel-context?id=private&message=1']){
  const response=await unauthorized(path);assert.equal(response.status,401,path);
 }
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=','base64');
 const form=new FormData();form.append('file',new Blob([png],{type:'image/png'}),'avatar.png');
 const upload=await handleWorkspace(new Request('http://fixture/api/workspace-ui/avatars',{method:'POST',body:form}),()=>true);const saved=await upload.json();
 const avatar=await handleWorkspace(new Request('http://fixture'+saved.url),()=>false);assert.equal(avatar.status,200);
});

test('legacy assets remain byte-identical while panel metadata changes in VAR',async()=>{
 assert.equal(readWorkspace().sessions.a.expert.name,'旧专家');
 await call('/preferences','PUT',{identity:{assistant_name:'助手二'}});await call('/folders','POST',{name:'新分类'});
 assert.equal(readWorkspace().folders.length,2);assert.equal(readWorkspace().identity.assistant_name,'助手二');assert.deepEqual(bytes(),before);
 const patch=JSON.parse(fs.readFileSync(join(process.env.VAR_DIR,'panel-state/workspace.json')));
 assert.equal(patch.sessions,undefined,'untouched expert state remains only in original store');
});
test('315 templates preserved; summary response omits full prompts and fake skill metadata',async()=>{
 const summary=expertCatalog({limit:400});assert.equal(summary.total,315);assert.equal(summary.experts.length,315);assert.equal(new Set(summary.experts.map(e=>e.id)).size,315);
 assert(summary.experts.every(e=>!('prompt'in e)&&!('skills'in e)));
 assert(Buffer.byteLength(JSON.stringify(summary))<300000);
 assert.equal(getExpert('coder').name,'程序员');assert.throws(()=>getExpert('../bad'),/无效/);
});
test('expert snapshot freezes template revision and expression is session scoped',async()=>{
 await call('/session','PUT',{id:'a',expert_id:'coder',personality:'concise'});
 const snap=sessionSnapshot('a');assert.match(snap.system,/会话专家职责/);assert.match(snap.system,/表达偏好：简洁/);assert.doesNotMatch(snap.system,/file_manager|code_execution/);
 const e=getExpert('coder');await call('/experts/coder','PUT',{...e,prompt:'新模板内容',name:'新版程序员'});
 assert.equal(sessionSnapshot('a').system,snap.system);assert.equal(sessionSnapshot('a').identity.sender,'程序员');
 await call('/session','PUT',{id:'b',expert_id:'coder',personality:'teacher'});assert.match(sessionSystem('b'),/新模板内容/);assert.match(sessionSystem('b'),/教学/);assert.doesNotMatch(sessionSystem('a'),/教学/);
 assert.equal((await call('/experts/coder','PUT',{...e,prompt:'stale'})).status,409);
 await call('/preferences','PUT',{identity:{assistant_name:'第三个默认名',user_name:'新用户'}});assert.equal(snap.user_identity.sender,'Vector');
 assert.deepEqual(bytes(),before);
});
test('chat role picker opens session personality without activating a global profile',()=>{
 const html=fs.readFileSync(new URL('../../../app/ui/index.html',import.meta.url),'utf8');
 const start=html.indexOf('function openSessionPersonalityFromMini()');
 assert.notEqual(start,-1);
 const end=html.indexOf('\n/* 连接器激活卡片',start);
 const picker=html.slice(start,end);
 assert.match(picker,/pwPersonality\(\)/);
 assert.doesNotMatch(picker,/selectPersona|\/api\/profiles|team_enabled|workflow\.enabled/);
 assert.match(html,/switchExpertPickerTab\(\\'persona\\'\)\">表达风格/);
});
test('personality save errors remain visible in the dialog instead of closing as if saved',()=>{
 const source=fs.readFileSync(new URL('../../../app/ui/js/panel-workspace-ui.js',import.meta.url),'utf8');
 const start=source.indexOf('window.pwPersonality=async function(value)');
 const end=source.indexOf('\nfunction inputAction',start);
 const personality=source.slice(start,end);
 assert.match(personality,/pwPersonalityFeedback/);
 assert.match(personality,/role="status" aria-live="polite"/);
 assert.match(personality,/catch\(error\)\{status\.textContent=error\.message/);
 assert.match(personality,/if\(d\.isConnected\)save\.disabled=false/);
 assert.match(personality,/return true/);
 assert.doesNotMatch(personality,/catch\(e\)\{fail\(e\);\}\};/);
});
test('legacy team flags cannot alter ordinary chat; saved team remains a task plan',()=>{
 const html=fs.readFileSync(new URL('../../../app/ui/index.html',import.meta.url),'utf8');
 const durable=fs.readFileSync(new URL('../../../app/ui/js/panel-durable.js',import.meta.url),'utf8');
 const plans=fs.readFileSync(new URL('../../../app/server/panel-plans.js',import.meta.url),'utf8');
 const open=html.indexOf('function openMini('),picker=html.slice(html.indexOf("if(key==='expert'){",open),html.indexOf("} else {\n    tabs.style.display='none'",open));
 assert.match(picker,/表达风格/);assert.doesNotMatch(picker,/专家团/);
 assert.doesNotMatch(durable,/team_enabled|workflow\?\.enabled|injectExpertSystem/);
 assert.match(plans,/id:'saved-team'/);assert.match(plans,/clone\(ext\.team\|\|\[\]\)/);
 const send=html.slice(html.indexOf('function injectExpertSystem('),html.indexOf('\nfunction sendRaw(',html.indexOf('function injectExpertSystem(')));
 assert.match(send,/function injectExpertSystem\(sys\)\{ return sys\|\|''; \}/);
 assert.doesNotMatch(send,/team_enabled|extensions\.workflow|专家角色/);
 const pickerStart=html.indexOf('function pickItemExpert('),pickerEnd=html.indexOf('\nfunction agencyIdByName',pickerStart),legacyPicker=html.slice(pickerStart,pickerEnd);
 assert.doesNotMatch(legacyPicker,/team_enabled|extensions\.workflow/);
 const profileStart=html.indexOf('function chatWithPersona('),profileEnd=html.indexOf('\nfunction ',profileStart+10),profile=html.slice(profileStart,profileEnd);
 assert.doesNotMatch(profile,/team_enabled|extensions\.workflow/);
 const initStart=html.indexOf("loadConfig().then(function(){",html.indexOf("document.addEventListener('DOMContentLoaded'"));
 const initEnd=html.indexOf('loadSessions();',initStart),init=html.slice(initStart,initEnd);
 assert.doesNotMatch(init,/team_enabled|ensureAgent\('team'/);
});
test('profile and preset role cards open session snapshots without global activation',()=>{
 const html=fs.readFileSync(new URL('../../../app/ui/index.html',import.meta.url),'utf8');
 const ui=fs.readFileSync(new URL('../../../app/ui/js/panel-workspace-ui.js',import.meta.url),'utf8');
 const preset=html.slice(html.indexOf('function applyPresetAgent'),html.indexOf('/* ── 专家页',html.indexOf('function applyPresetAgent')));
 const card=html.slice(html.indexOf('function _expertCardHtml'),html.indexOf('function renderMineExperts',html.indexOf('function _expertCardHtml')));
 assert.match(ui,/window\.pwStartRoleChat=/);
 assert.match(ui,/expert:\{id:profile\.id/);
 assert.doesNotMatch(preset,/apiPost\('\/api\/profiles/);
 assert.doesNotMatch(preset,/selectPersona\(/);
 assert.doesNotMatch(card,/chatWithPersona\(/);
 assert.match(card,/pwProfileChatById/);
 assert.match(html,/data-persona-action="select"[\s\S]*>打开会话/);
 assert.match(html,/Profile 是独立运行环境/);
 assert.match(html,/会话专家请到“专家”页选择/);
 assert.match(html,/添加环境 Profile/);
});

test('history message identity falls back to saved workspace name and avatar',()=>{
 const ui=fs.readFileSync(new URL('../../../app/ui/js/panel-workspace-ui.js',import.meta.url),'utf8');
 const start=ui.indexOf('window.msgHTML=function');
 const end=ui.indexOf('\nwindow.pwDecorateLive',start);
 assert.notEqual(start,-1);assert.notEqual(end,-1);
 const renderer=ui.slice(start,end);
 assert.match(renderer,/state\.identity\|\|\{\}/);
 assert.match(renderer,/identity\.user_name/);
 assert.match(renderer,/identity\.assistant_name/);
 assert.match(renderer,/identity\.user_avatar/);
 assert.match(renderer,/identity\.assistant_avatar/);
 assert.match(renderer,/identity\.user_name[^;]*\|\|\s*\(m\.role==='user'\?'你':'Hermes'\)/);
 assert.match(renderer,/identity\.user_avatar[^;]*\|\|\s*\(m\.role==='user'\?'👤':'🤖'\)/);
 const html=fs.readFileSync(new URL('../../../app/ui/index.html',import.meta.url),'utf8');
 assert.equal((html.match(/typeof chatUserName==='function'\?chatUserName\(\):'你'/g)||[]).length,2);
 assert.doesNotMatch(html.slice(html.indexOf('function rtSend'),html.indexOf('\nfunction ',html.indexOf('function rtSend')+10)),/msg-meta">你 ·/);
 const sendStart=html.indexOf('function sendRaw('),sendEnd=html.indexOf('\n/*',sendStart+10);
 assert.doesNotMatch(html.slice(sendStart,sendEnd),/msg-meta">你 ·/);
});

test('roundtable members come from the session expert catalog, never global profile activation',()=>{
 const html=fs.readFileSync(new URL('../../../app/ui/index.html',import.meta.url),'utf8');
 const start=html.indexOf('function openRoundtable()');
 const end=html.indexOf('\nfunction closeRoundtable()',start);
 assert.notEqual(start,-1);assert.notEqual(end,-1);
 const dialog=html.slice(start,end);
 assert.match(dialog,/api\/workspace-ui\/experts\?limit=400&details=1/);
 assert.match(dialog,/不会切换全局 Profile/);
 assert.doesNotMatch(dialog,/fetchProfiles\(/);
 assert.doesNotMatch(dialog,/_profiles\.map/);
 const startRun=html.indexOf('function startRoundtable()');
 const endRun=html.indexOf('\nfunction rtSend(',startRun);
 const runner=html.slice(startRun,endRun);
 assert.match(runner,/_rtCatalog\.find/);
 assert.doesNotMatch(runner,/selectPersona\(|\/api\/profiles\/.*activate/);
});
test('new-session dialog uses session personality instead of an unused global Profile field',()=>{
 const html=fs.readFileSync(new URL('../../../app/ui/index.html',import.meta.url),'utf8');
 const start=html.indexOf('function openNewSessionModal()');
 const end=html.indexOf('\nfunction updateHeader()',start);
 assert.notEqual(start,-1);assert.notEqual(end,-1);
 const dialog=html.slice(start,end);
 assert.match(dialog,/id=\"nsPersonality\"/);
 assert.match(dialog,/workspace-ui\/personalities/);
 assert.match(dialog,/workspace-ui\/session[\s\S]*personality/);
 assert.doesNotMatch(dialog,/api\/profiles/);
 assert.doesNotMatch(dialog,/JSON\.stringify\(\{agent:/);
});
test('image avatars are content-addressed, reloaded and restricted to actual image bytes',async()=>{
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=','base64');
 const form=new FormData();form.append('file',new Blob([png],{type:'image/png'}),'avatar.png');
 let response=await handleWorkspace(new Request('http://fixture/api/workspace-ui/avatars',{method:'POST',body:form}),()=>true);const saved=await response.json();assert.equal(response.status,200);assert.match(saved.url,/\/[a-f0-9]{64}\.png$/);
 await call('/preferences','PUT',{identity:{user_avatar:saved.url}});assert.equal(readWorkspace().identity.user_avatar,saved.url);
 response=await handleWorkspace(new Request('http://fixture'+saved.url),()=>true);assert.equal(response.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await response.arrayBuffer()),png);
 const invalid=new FormData();invalid.append('file',new Blob(['<svg onload="alert(1)"></svg>'],{type:'image/png'}),'fake.png');response=await handleWorkspace(new Request('http://fixture/api/workspace-ui/avatars',{method:'POST',body:invalid}),()=>true);assert.equal(response.status,415);
 assert.equal((await call('/preferences','PUT',{identity:{user_avatar:'https://external.invalid/a.png'}})).status,400);
 assert.deepEqual(bytes(),before);
});
test('GIF avatar bytes and animation MIME are preserved and shape preference is validated',async()=>{
 const gif=Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64'),form=new FormData();form.append('file',new Blob([gif],{type:'image/gif'}),'avatar.gif');
 let response=await handleWorkspace(new Request('http://fixture/api/workspace-ui/avatars',{method:'POST',body:form}),()=>true),saved=await response.json();assert.equal(response.status,200);assert.match(saved.url,/\/[a-f0-9]{64}\.gif$/);
 await call('/preferences','PUT',{identity:{user_avatar:saved.url,avatar_shape:'circle'}});assert.equal(readWorkspace().identity.avatar_shape,'circle');
 response=await handleWorkspace(new Request('http://fixture'+saved.url),()=>false);assert.equal(response.headers.get('content-type'),'image/gif');assert.deepEqual(Buffer.from(await response.arrayBuffer()),gif);
 assert.equal((await call('/preferences','PUT',{identity:{avatar_shape:'triangle'}})).status,400);
 const ui=fs.readFileSync(new URL('../../../app/ui/js/panel-workspace-ui.js',import.meta.url),'utf8');assert.match(ui,/image\/png,image\/jpeg,image\/gif,image\/webp/);assert.match(ui,/file\.type==='image\/gif'/);assert.match(ui,/pwAvatarShape/);assert.match(ui,/avatar_shape/);
 assert.match(ui,/function avatarShapeClass\(\)/);assert.match(ui,/class="pw-avatar'\+avatarShapeClass\(\)/);assert.match(ui,/av\.classList\.toggle\('circle',state\.identity\?\.avatar_shape==='circle'\)/);
 const html=fs.readFileSync(new URL('../../../app/ui/index.html',import.meta.url),'utf8');assert.match(html,/\.rooms-msgs \.rm \.av\.circle\{border-radius:50%\}/);assert.match(html,/\.rooms-msgs \.rm \.av img\{width:100%;height:100%;object-fit:cover;border-radius:inherit\}/);
 const css=fs.readFileSync(new URL('../../../app/ui/css/panel-workspace.css',import.meta.url),'utf8');assert.match(css,/\.pw-welcome \.pw-avatar\.circle\{border-radius:50%\}/);
});
test('display preferences persist in VAR and reject invalid values without changing DATA',async()=>{
 for(const mode of ['hidden','expanded','collapsed']){
  const response=await call('/preferences','PUT',{display:{tools_mode:mode}});assert.equal(response.status,200);assert.equal(readWorkspace().display.tools_mode,mode);
 }
 assert.equal((await call('/preferences','PUT',{display:{tools_mode:'invalid'}})).status,400);
 assert.equal(readWorkspace().display.tools_mode,'collapsed');assert.deepEqual(bytes(),before);
});
test('expert catalog pages filters and undo preserve previous templates and old snapshots',async()=>{
 const first=expertCatalog({limit:36});assert.equal(first.experts.length,36);assert.equal(first.catalog_total,315);assert.ok(first.scenes.includes('开发'));
 const filtered=expertCatalog({query:'程序员',scene:'开发',ids:['coder'],limit:36});assert.equal(filtered.total,1);
 const before=getExpert('coder'),snapshot=sessionSnapshot('a'),assets=bytes();
 assert.equal((await call('/experts/coder','PUT',{name:'missing revision',prompt:'bad'})).status,409);
 const saved=await call('/experts/coder','PUT',{revision:before.revision,name:'可撤销专家',prompt:'可撤销设定'});assert.equal(saved.status,200);
 assert.equal(saved.expert.can_undo,true);assert.equal(expertCatalog({query:'可撤销专家'}).experts[0].revision,saved.expert.revision);
 const undone=await call('/experts/coder/undo','POST',{revision:saved.expert.revision});assert.equal(undone.status,200);assert.equal(undone.expert.name,before.name);assert.equal(undone.expert.prompt,before.prompt);
 assert.equal(sessionSnapshot('a').system,snapshot.system);
 assert.deepEqual(bytes(),assets);
});
test('task plan identity and stable instructions are session scoped and clearing leaves queued snapshot unchanged',async()=>{
 const {bindSessionPlan}=await import('../../../app/server/panel-workspace.js');
 bindSessionPlan('b',{id:'plan-test',kind:'team',name:'审核分工',members:[{id:'coder',name:'程序员',prompt:'检查实现证据'}],revision:'1'});
 const frozen=sessionSnapshot('b');assert.equal(frozen.identity.sender,'审核分工');assert.match(frozen.system,/会话专家分工/);assert.doesNotMatch(frozen.system,/会话专家职责/);assert.equal(frozen.plan.members[0].prompt,'检查实现证据');
 await call('/session','PUT',{id:'b',clear_plan:true});assert.equal(sessionSnapshot('b').plan,null);assert.match(frozen.system,/检查实现证据/);assert.equal(sessionSnapshot('a').plan,null);assert.deepEqual(bytes(),before);
});
