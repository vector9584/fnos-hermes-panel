import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('./error-state-browser.py',import.meta.url),'utf8');
const handoff=readFileSync(new URL('../../rebuild/NAS-browser-handoff.md',import.meta.url),'utf8');

test('503 scan requires failure wording in visible feedback, not an empty live region',()=>{
  assert.match(source,/FEEDBACK = \([\s\S]*?'离线'/);
  assert.match(source,/semantic_error = any\(term\.lower\(\) in semantic_feedback\.lower\(\) for term in FEEDBACK\)/);
  assert.match(source,/'visible_feedback': visible_error or semantic_error/);
  assert.doesNotMatch(source,/semantic_nodes\s*=.*\.count\(\)/);
  assert.doesNotMatch(source,/semantic_nodes > 0/);
  assert.doesNotMatch(source,/alert_count/);
  assert.match(source,/element\.getClientRects\(\)\.length/);
  assert.match(source,/style\.display !== 'none' && style\.visibility !== 'hidden' && Number\(style\.opacity\) > 0\.01/);
  assert.match(source,/request_failures = \[item for item in blocked if item\['page'\] == destination and item\['scenario'\] == scenario\['id'\]\]/);
  assert.match(source,/change\.type === 'childList' && inToast\) record\(node\)/);
  assert.match(source,/brandConnectionText/);
  assert.match(source,/inject_failure = \[False\]/);
  assert.match(source,/if inject_failure\[0\] and pathname\.startswith/);
  assert.match(source,/page\.wait_for_timeout\(750\)/);
  assert.match(source,/if destination == 'chat':[\s\S]{0,100}currentSession && loadSessionMessages\(currentSession\)/);
  assert.match(source,/visible_error = local_error or \(scenario\['id'\] == 'offline' and global_error\)/);
  assert.match(source,/'local_feedback_text': feedback_state\['localText'\]/);
  assert.match(source,/timeout=4000/);
  assert.match(source,/global && \/失败\|离线\|未连接\|拒绝\|权限\|不可用\|403\|503\/i\.test\(global\.textContent\)/);
  assert.doesNotMatch(source,/page\.wait_for_timeout\(500\)/);
});

test('503 scan rejects pages without a failed API and writes evidence before failing',()=>{
  assert.match(source,/if not request_failures:/);
  assert.match(source,/destination == 'cron':[\s\S]*?renderCronJobs\(\)/);
  assert.match(source,/results\.json/);
  assert.match(source,/if failures:\s+raise SystemExit\(1\)/);
});

test('error-state scan covers forbidden and offline failures for every page and viewport',()=>{
  assert.match(source,/\{'id': 'unavailable', 'status': 503/);
  assert.match(source,/\{'id': 'forbidden', 'status': 403/);
  assert.match(source,/\{'id': 'offline', 'status': None/);
  assert.match(source,/request\.abort\('internetdisconnected'\)/);
  assert.match(source,/for scenario in SCENARIOS:/);
  assert.match(source,/for destination in PAGES:/);
  assert.match(source,/for width, height in VIEWPORTS:/);
  assert.match(source,/item\['scenario'\] == scenario\['id'\]/);
  assert.match(source,/for width, height in VIEWPORTS:\s+for scenario in SCENARIOS:/);
  assert.match(source,/context = browser\.new_context\(viewport=/);
});

test('NAS handoff describes the included 135 page failure checks without claiming endpoint completeness',()=>{
  assert.match(handoff,/15个主页面、3种视口下分别注入 API 503、403 和网络断开，共135个页面\/视口\/故障组合/);
  assert.match(handoff,/要求看到对应失败文案且没有页面异常/);
  assert.match(handoff,/不等于逐端点的认证、超时、部分成功和并发矩阵/);
  assert.doesNotMatch(handoff,/当前仓库没有全站错误态矩阵脚本/);
});

test('global connection state has visible and assistive text for offline and service states',()=>{
  const html=readFileSync(new URL('../../../app/ui/index.html',import.meta.url),'utf8');
  assert.match(html,/<span class="brand-connection connecting" id="brandConnectionText" role="status" aria-live="polite" aria-atomic="true">连接中<\/span>/);
  assert.match(html,/setBrandConnection\(gw\?'online':'offline',gw\?'已连接':\(db\?'网关未连接':'已停止'\)\)/);
  assert.match(html,/setBrandConnection\('offline','离线'\)/);
  assert.match(html,/if\(text\.textContent!==label\)text\.textContent=label/);
  assert.match(html,/class="chat-load-error"><span role="alert">加载消息失败，请确认后端已连接后重试。<\/span><button type="button" onclick="loadSessionMessages\(currentSession\)"/);
});
