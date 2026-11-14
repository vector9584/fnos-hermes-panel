/* 运行时状态、本地兜底状态、多 Agent 专家分组
 * 来源：index.html 内联 app.js 第 1-95 行（共 95 行）
 * 2026-11-13 按原分区纯搬运外移，逻辑零改动。全局作用域与执行顺序与原内联块一致。 */

/* ===== inlined app.js (V17, real backend API) ===== */
/* ============================================================================
 * fnos-hermes-agent · V17 Web UI
 * 真实后端 API 对接版（覆盖原 mock 逻辑）
 *
 * 所有函数位于全局作用域（无 IIFE），供 DOM 内联 onclick 调用。
 * API 前缀 BASE 由 <base href> / document.baseURI 推导；
 * 鉴权通过设备授权引导接口取得浏览器凭证，再使用 X-Monitor-Token 或同源 Cookie。
 * ========================================================================== */

window.currentAgent = 'default';
window.currentSession = '';
window.currentTheme = 'auto';
window.activeBtn = null;
window.activePanel = null;
window.popup = null;

/* 本地兜底状态（设置项等少量 UI 状态，真实保存走 /api/config） */
window._state = PV.Store.load();

/* ── 运行时状态 ── */
var BASE = '';
var monitorToken = '';
/* 设备令牌本地留存：iOS 原生壳 / WebView 里 HttpOnly cookie 经常带不上，
 * 只靠 cookie 会导致「拿到了 token 却每次请求都 401」。留存后用请求头补齐。 */
try { monitorToken = localStorage.getItem('panel-device-token') || ''; } catch(e) { monitorToken = ''; }
var _cfg = { providers: [], active_provider: '', extensions: { toolsets:{}, mcp_servers:[], skills_dirs:[], persona:'default', memory:{enabled:true,char_limit:2200}, team:[], team_name:'' } };
var _sessions = [];
var _services = { gateway:false, dashboard:false };
var _chState = { defs:{}, channels:{}, current:null, filter:'all' };
// QR 扫码流程会话令牌：每次打开/关闭渠道弹窗或启动新的扫码流程时递增，
// 各渠道 chPoll* 轮询链捕获启动时的 seq，回调发现 seq 变化立即终止——
// 修复「点过 TG/企微扫码后，进微信仍在调企微/TG 接口」的轮询串扰 bug。
var _chQrSeq = 0;
var _connState = { list:[] };
var _msgState = { streaming:false, abortCtrl:null, ws:null };
var _pendingRedirect = false;   // 流式回复中发送的消息 = redirect 中途纠偏标记
var _persona = 'default';
var _personaPrompt = '';
var _pendingAttachments = [];
var _toolNative = null;          // /proxy/dashboard 原生工具集
var _toolNativeFallback = false;
var _toolNativeLoadGeneration = 0;
var _toolActionBusy = Object.create(null);
var _skillLocal = [];            // /api/extensions/skills/local
var _skillNative = [];           // /proxy/dashboard/api/skills
var _selectedExpert = null;       // 当前选用的单专家（注入用，{id,name,prompt}）
var _settingsLoaded = false;
var _logStream = null;
var _logInited = false;

/* ============================ 多 Agent（专家）分组 ============================ */
/* _agents：每个 agent 对应左侧会话树的一个可折叠分组；默认分组 id='default'。
   专家被选中时，为其创建独立 agent（id='exp-<expertId>），会话归入该分组。 */
var _agents = [];
try { _agents = JSON.parse(localStorage.getItem('hermes_agents') || '[]'); } catch (e) { _agents = []; }
if (!_agents.some(function (a) { return a.id === 'default'; })) {
  _agents.unshift({ id: 'default', name: '默认主力助手', icon: '🤖', expertId: null });
}
function saveAgents() {
  try { localStorage.setItem('hermes_agents', JSON.stringify(_agents.map(function (a) { return { id: a.id, name: a.name, icon: a.icon, expertId: a.expertId }; }))); } catch (e) {}
  // 服务端持久化（Issue #7）：跨浏览器/清缓存不丢失角色分组
  if (_cfg && _cfg.extensions) { _cfg.extensions.agents = _agents.map(function (a) { return { id: a.id, name: a.name, icon: a.icon, expertId: a.expertId }; }); _saveConfigDebounced(); }
}
/* 防抖保存配置，避免每次会话/分组变动都打 POST */
var _saveTimer = null;
function _saveConfigDebounced() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(function () { saveConfig(); }, 500);
}
function getAgent(id) { return _agents.find(function (a) { return a.id === id; }); }
function ensureAgent(id, props) {
  var a = getAgent(id);
  if (!a) { a = { id: id, name: (props && props.name) || id, icon: (props && props.icon) || '🤖', expertId: (props && props.expertId) || null }; _agents.push(a); saveAgents(); }
  return a;
}
/* 工具栏专家选择器：会话专家与会话表达风格 */
var _expertPickerTab = 'single';
/* 当前激活的 profile id（模型 A：全局单激活，跟随后端 .active_profile）。
   大纲/记忆面板/聊天人格统一按它显示对应专家的 SOUL/MEMORY/prompt。
   exp-/team 等纯前端分组无独立 profile 目录 → 映射 default（主目录）。 */
function _activeProfileId(){
  var p = String(_persona || 'default');
  if(p.indexOf('exp-')===0 || p==='team') p = 'default';
  return p;
}
/* rail 分组高亮 id：active profile 对应的 rail 分组（'p-'+profileId），
   profile=default 或无对应分组时回退 default 分组 */
function _activeRailAgentId(){
  var pid = _activeProfileId();
  if(pid === 'default') return 'default';
  var gid = 'p-' + pid;
  return getAgent(gid) ? gid : 'default';
}